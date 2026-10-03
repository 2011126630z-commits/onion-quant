package com.quantmonitor.paper;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * PaperForegroundService · V15 P0(真正的后台 Runtime)
 *
 * 需求对应:
 *  1) 服务自己持有一个**无界面 WebView**(不挂在任何 Activity 上)来承载 Paper Runtime,
 *     因此 Activity/UI WebView 被销毁后运行时继续跑。
 *  2) 运行时驱动:行情 → Short/Long → 退出 → 风控 → Profit Lock → 通知 → 学习样本
 *     (全部在 runtime-host.js 内,与 UI 使用同一份引擎代码,不会出现两套逻辑)。
 *  3) UI 只是 Viewer/Controller:通过 QuantNative 桥读状态、发命令。
 *  4) 与 UI 同源(https://localhost)→ 共享同一份 IndexedDB(账户/持仓/引擎状态),重开 UI 不会新建账户。
 *  5) 单实例:静态引用 + 运行时内部登记表双保险,严禁第二个 Engine。
 *  6) 常驻通知显示 Short/Long 与持仓数,**只在文案变化时更新**(不刷屏)。
 *
 *  PAPER ONLY:REAL_TRADING_ENABLED = false;本服务不含任何真实下单能力。
 */
public class PaperForegroundService extends Service {
    public static final String CHANNEL_RUNNING = "paper_running";
    public static final String CHANNEL_TRADE = "paper_trade";
    public static final String CHANNEL_RISK = "paper_risk";
    public static final String CHANNEL_SYSTEM = "paper_system";
    public static final String CHANNEL_MARKET = "paper_market";
    public static final String CHANNEL_LEARNING = "paper_learning";
    public static final String CHANNEL_RESEARCH = "paper_research";
    public static final int NOTIFICATION_ID = 1001;
    private static final String PREFS = "paper_prefs";
    private static final String TAG = "PaperRuntime";
    private static final String RUNTIME_URL = "https://localhost/runtime.html";

    // 单实例守卫:整个进程只允许一个运行时 WebView
    private static volatile WebView runtimeView = null;
    private static volatile boolean runtimeRunning = false;
    private static volatile long runtimeStartedAt = 0;
    private static volatile String lastStatusJson = "";
    private static volatile String lastNotifText = "";
    private static volatile long lastNotifAt = 0;

    public static boolean isRuntimeRunning() {
        return runtimeRunning;
    }

    public static long runtimeStartedAt() {
        return runtimeStartedAt;
    }

    public static String lastStatus() {
        return lastStatusJson;
    }

    public static void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_RUNNING, "模拟运行中", NotificationManager.IMPORTANCE_LOW));
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_TRADE, "交易提醒", NotificationManager.IMPORTANCE_DEFAULT));
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_RISK, "风险提醒", NotificationManager.IMPORTANCE_HIGH));
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_SYSTEM, "系统提醒", NotificationManager.IMPORTANCE_DEFAULT));
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_MARKET, "重大市场事件", NotificationManager.IMPORTANCE_DEFAULT));
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_LEARNING, "模型更新", NotificationManager.IMPORTANCE_DEFAULT));
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_RESEARCH, "研究提醒", NotificationManager.IMPORTANCE_DEFAULT));
    }

    // 供页面(runtime-host.js 与 UI)调用的事件通知
    public static void notifyEvent(Context ctx, String kind, String title, String body) {
        ensureChannels(ctx);
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        String channel = "risk".equalsIgnoreCase(kind) ? CHANNEL_RISK
            : "trade".equalsIgnoreCase(kind) ? CHANNEL_TRADE
            : "research".equalsIgnoreCase(kind) || "market".equalsIgnoreCase(kind) ? CHANNEL_MARKET
            : "learning".equalsIgnoreCase(kind) ? CHANNEL_LEARNING
            : CHANNEL_SYSTEM;
        // V16.1-RV §50:每条通知用独立 requestCode + 携带 kind/title → 点击可深链到对应页面(不再"全部只开首页")
        int id = (int) (System.currentTimeMillis() % 100000) + 2000;
        PendingIntent pi = openAppIntent(ctx, id, kind, title);
        Notification.Builder b = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            ? new Notification.Builder(ctx, channel) : new Notification.Builder(ctx);
        b.setContentTitle(title == null ? "量化监控" : title)
            .setContentText(body == null ? "" : body)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setAutoCancel(true)
            .setContentIntent(pi);
        nm.notify(id, b.build());
    }

    private static PendingIntent openAppIntent(Context ctx) {
        return openAppIntent(ctx, 0, null, null);
    }

    private static PendingIntent openAppIntent(Context ctx, int requestCode, String kind, String title) {
        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (kind != null) open.putExtra("ntf_kind", kind);
        if (title != null) open.putExtra("ntf_title", title);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(ctx, requestCode, open, flags);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        ensureChannels(this);
        // 仅 debug 构建:开放 WebView 调试,让自动化验收能读取服务里 Runtime 的真实运行态。
        // release 构建 FLAG_DEBUGGABLE=0,此开关不生效。
        try {
            if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
                WebView.setWebContentsDebuggingEnabled(true);
            }
        } catch (Exception ignored) { }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ensureChannels(this);
        startForeground(NOTIFICATION_ID, buildRunningNotification("启动中 · 正在恢复账户与持仓"));
        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        sp.edit().putBoolean("service_running", true).apply();
        startRuntime();
        return START_STICKY;   // 被系统回收后按需重建;重建时会从 IndexedDB 恢复同一账户
    }

    private Notification buildRunningNotification(String text) {
        Notification.Builder b = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            ? new Notification.Builder(this, CHANNEL_RUNNING) : new Notification.Builder(this);
        b.setContentTitle("量化监控 · Paper 模拟运行中")
            .setContentText(text == null || text.isEmpty() ? "Short 0 / Long 0 · 持仓 0" : text)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setContentIntent(openAppIntent(this));
        return b.build();
    }

    // ---- 运行时 WebView(无界面,服务独占) ----
    private void startRuntime() {
        if (runtimeView != null) {
            Log.i(TAG, "runtime already alive (single instance), skip create");
            return;
        }
        new Handler(Looper.getMainLooper()).post(new Runnable() {
            @Override
            public void run() {
                try {
                    if (runtimeView != null) return;
                    WebView view = new WebView(getApplicationContext());
                    WebSettings s = view.getSettings();
                    s.setJavaScriptEnabled(true);
                    s.setDomStorageEnabled(true);      // IndexedDB 必需
                    s.setDatabaseEnabled(true);
                    s.setAllowFileAccess(false);
                    s.setAllowContentAccess(false);
                    s.setCacheMode(WebSettings.LOAD_DEFAULT);
                    view.setWebViewClient(new WebViewClient() {
                        @Override
                        public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                            String url = request.getUrl() == null ? "" : request.getUrl().toString();
                            if (url.startsWith("https://localhost/")) {
                                return assetResponse(url.substring("https://localhost/".length()));
                            }
                            return null;
                        }
                    });
                    view.addJavascriptInterface(new RuntimeBridge(), "QuantRuntime");
                    runtimeView = view;
                    runtimeRunning = true;
                    runtimeStartedAt = System.currentTimeMillis();
                    view.loadUrl(RUNTIME_URL);
                    Log.i(TAG, "runtime webview created and loading " + RUNTIME_URL);
                } catch (Exception e) {
                    runtimeRunning = false;
                    runtimeView = null;
                    Log.e(TAG, "runtime webview failed: " + e.getMessage());
                }
            }
        });
    }

    private WebResourceResponse assetResponse(String path) {
        try {
            String clean = path.split("\\?")[0];
            if (clean.isEmpty()) clean = "runtime.html";
            InputStream in = getAssets().open("public/" + clean);
            Map<String, String> headers = new HashMap<String, String>();
            headers.put("Access-Control-Allow-Origin", "https://localhost");
            return new WebResourceResponse(mimeOf(clean), "utf-8", 200, "OK", headers, in);
        } catch (Exception e) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<String, String>(),
                new ByteArrayInputStream("not found".getBytes(StandardCharsets.UTF_8)));
        }
    }

    private static String mimeOf(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js")) return "application/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".json")) return "application/json";
        if (path.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }

    /** JS 侧桥:状态回报 / 日志 / 原生 HTTP(服务自己出网,避免 WebView 的 CORS 与来源限制) */
    public class RuntimeBridge {
        @JavascriptInterface
        public void status(String json) {
            lastStatusJson = json == null ? "" : json;
            try {
                JSONObject o = new JSONObject(lastStatusJson);
                String text = "Short " + o.optInt("short_positions", 0) + " / Long " + o.optInt("long_positions", 0)
                    + " · 持仓 " + o.optInt("open_positions", 0)
                    + (o.optBoolean("stalled", false) ? " · 数据停滞" : "")
                    + (o.optString("last_error", "").isEmpty() ? "" : " · 异常");
                Log.i(TAG, "status " + lastStatusJson);
                updateNotificationIfChanged(text);
            } catch (Exception e) {
                Log.w(TAG, "status parse failed: " + e.getMessage());
            }
        }

        @JavascriptInterface
        public void log(String message) {
            Log.i(TAG, message == null ? "" : message);
        }

        @JavascriptInterface
        public boolean isRuntimeAlive() {
            return runtimeRunning;
        }

        @JavascriptInterface
        public String lastStatus() {
            return lastStatusJson;
        }

        @JavascriptInterface
        public void notify(String kind, String title, String body) {
            notifyEvent(getApplicationContext(), kind, title, body);
        }

        @JavascriptInterface
        public void stopRuntime() {
            handlerStop();
        }

        /** 同步 HTTP GET(在 JS 线程调用,不在主线程);仅允许固定白名单主机 */
        @JavascriptInterface
        public String httpGet(String url) {
            try {
                String target = url == null ? "" : url;
                if (target.startsWith("/api/")) target = mapApiToUpstream(target);
                if (target.isEmpty()) return "{\"error\":\"unmapped_api\"}";
                URL u = new URL(target);
                String host = u.getHost();
                if (!host.endsWith(".binance.com") && !host.endsWith(".okx.com") && !host.endsWith(".bybit.com")) {
                    return "{\"error\":\"host_not_allowed\"}";
                }
                HttpURLConnection conn = (HttpURLConnection) u.openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(12000);
                conn.setRequestProperty("accept", "application/json");
                conn.setRequestProperty("user-agent", "QuantMonitor/15 paper");
                int code = conn.getResponseCode();
                InputStream in = (code >= 200 && code < 300) ? conn.getInputStream() : conn.getErrorStream();
                StringBuilder sb = new StringBuilder();
                if (in != null) {
                    BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
                    String line;
                    while ((line = r.readLine()) != null) sb.append(line);
                    r.close();
                }
                conn.disconnect();
                if (code < 200 || code >= 300) return "{\"error\":\"upstream_" + code + "\"}";
                return sb.toString();
            } catch (Exception e) {
                return "{\"error\":\"http_failed\",\"detail\":\"" + String.valueOf(e.getMessage()).replace("\"", "") + "\"}";
            }
        }
    }

    /** /api/* → 官方公开端点(与 native-bridge.js 相同映射;无密钥、无动态主机) */
    private static String mapApiToUpstream(String apiPath) {
        String qs = "";
        String path = apiPath;
        int q = apiPath.indexOf('?');
        if (q >= 0) { qs = apiPath.substring(q + 1); path = apiPath.substring(0, q); }
        String type = path.substring(path.lastIndexOf('/') + 1);
        String symbol = param(qs, "symbol");
        String interval = param(qs, "interval");
        String limit = param(qs, "limit");
        String period = param(qs, "period");
        boolean spot = "spot".equals(param(qs, "market"));
        String base = spot ? "https://api.binance.com" : "https://fapi.binance.com";
        if ("tickers".equals(type)) return base + (spot ? "/api/v3/ticker/24hr" : "/fapi/v1/ticker/24hr");
        if (symbol == null || symbol.isEmpty()) return "";
        if ("klines".equals(type)) {
            String p = spot ? "/api/v3/klines" : "/fapi/v1/klines";
            return base + p + "?symbol=" + symbol + "&interval=" + (interval == null ? "1h" : interval) + "&limit=" + (limit == null ? "200" : limit);
        }
        if ("ticker".equals(type)) return base + (spot ? "/api/v3/ticker/24hr" : "/fapi/v1/ticker/24hr") + "?symbol=" + symbol;
        if ("funding".equals(type)) return base + "/fapi/v1/premiumIndex?symbol=" + symbol;
        if ("open_interest".equals(type)) return base + "/futures/data/openInterestHist?symbol=" + symbol + "&period=" + (period == null ? "5m" : period) + "&limit=2";
        if ("long_short".equals(type)) return base + "/futures/data/globalLongShortAccountRatio?symbol=" + symbol + "&period=" + (period == null ? "5m" : period) + "&limit=1";
        if ("taker".equals(type)) return base + "/futures/data/takerlongshortRatio?symbol=" + symbol + "&period=" + (period == null ? "5m" : period) + "&limit=1";
        return "";
    }

    private static String param(String qs, String key) {
        for (String part : qs.split("&")) {
            int eq = part.indexOf('=');
            if (eq > 0 && part.substring(0, eq).equals(key)) return part.substring(eq + 1);
        }
        return null;
    }

    /** 通知只在文案变化且间隔足够时更新(需求 §9:不要持续刷通知) */
    private void updateNotificationIfChanged(String text) {
        long nowMs = System.currentTimeMillis();
        if (nowMs - lastNotifAt < 10000) return;
        if (text.equals(lastNotifText)) return;
        lastNotifText = text;
        lastNotifAt = nowMs;
        try {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.notify(NOTIFICATION_ID, buildRunningNotification(text));
            Log.i(TAG, "notification updated: " + text);
        } catch (Exception ignored) { /* 通知失败不影响运行时 */ }
    }

    private void handlerStop() {
        if (runtimeView != null) {
            try { runtimeView.loadUrl("about:blank"); runtimeView.destroy(); } catch (Exception ignored) { }
            runtimeView = null;
        }
        runtimeRunning = false;
        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        sp.edit().putBoolean("service_running", false).apply();
        stopForeground(true);
        stopSelf();
        Log.i(TAG, "runtime stopped by request");
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onDestroy() {
        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        sp.edit().putBoolean("service_running", false).apply();
        runtimeRunning = false;
        if (runtimeView != null) {
            try { runtimeView.destroy(); } catch (Exception ignored) { }
            runtimeView = null;
        }
        Log.i(TAG, "service destroyed (runtime webview released)");
        super.onDestroy();
    }
}
