package com.quantmonitor.paper;

import android.Manifest;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebView;

import org.json.JSONObject;

import com.getcapacitor.BridgeActivity;

/**
 * MainActivity · V15 P0
 * 职责(改造后):
 *  1) 启动 Paper 前台服务 —— **服务拥有 Runtime**,Activity 只是 Viewer/Controller
 *  2) 首次运行请求通知权限(需要时才请求)
 *  3) QuantNative 桥:
 *     - notify / setAutoStart(原有)
 *     - isRuntimeRunning() / runtimeStatus() / runtimeStartedAt():UI 读取后台运行态
 *     - runtimeCommand(cmd):把 UI 的控制(启动/暂停/平仓)交给后台运行时,
 *       避免 UI 再起一个自己的引擎(严禁第二个 Engine 实例)
 *  4) 记录 auto_start 偏好(开机恢复与否由用户决定,绝不自动下单)
 */
public class MainActivity extends BridgeActivity {
    private static final int REQ_NOTIFICATION = 4101;
    private static final String PREFS = "paper_prefs";
    private static final String TAG = "PaperRuntime";
    // V16.1-RV §50:通知点击带来的深链载荷("取走即清空",由页面主动拉取)
    private static volatile String pendingNotificationJson = "";

    private void captureNotificationIntent(Intent intent) {
        try {
            if (intent == null) return;
            String kind = intent.getStringExtra("ntf_kind");
            String title = intent.getStringExtra("ntf_title");
            if (kind == null && title == null) return;
            JSONObject o = new JSONObject();
            o.put("kind", kind == null ? "" : kind);
            o.put("title", title == null ? "" : title);
            pendingNotificationJson = o.toString();
        } catch (Exception ignored) { }
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        captureNotificationIntent(intent);   // singleTask:已在栈里时新 intent 走这里
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        PaperForegroundService.ensureChannels(this);
        requestNotificationPermissionIfNeeded();
        DebugFinishReceiver.attach(this);   // 仅 debug:供自动化验证"销毁 Activity 但服务存活"
        captureNotificationIntent(getIntent());
        // 仅 debug 构建开放 WebView 调试(chrome DevTools / adb forward;自动化验收读页面真实运行态用)。
        // release 构建的 FLAG_DEBUGGABLE=0,这里完全不生效 —— 不是"绕过系统限制",是标准调试开关。
        try {
            if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
                WebView.setWebContentsDebuggingEnabled(true);
            }
        } catch (Exception ignored) { }
        // 先起服务(Runtime 由服务承载),再让 UI 连接它
        startPaperService();
        // V16.2:WebView 自身底色与默认深色主题一致(#0e1013)——页面首帧未绘前不露系统白底
        try {
            if (getBridge() != null && getBridge().getWebView() != null) {
                getBridge().getWebView().setBackgroundColor(0xFF0E1013);
            }
        } catch (Exception ignored) { }
        try {
            if (getBridge() != null && getBridge().getWebView() != null) {
                getBridge().getWebView().addJavascriptInterface(new Object() {
                    @android.webkit.JavascriptInterface
                    public void notify(String kind, String title, String body) {
                        PaperForegroundService.notifyEvent(getApplicationContext(), kind, title, body);
                    }

                    @android.webkit.JavascriptInterface
                    public void setAutoStart(boolean enabled) {
                        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("auto_start", enabled).apply();
                    }

                    @android.webkit.JavascriptInterface
                    public boolean isNativeShell() {
                        return true;
                    }

                    // ---- V15 P0:后台运行时接口(UI 只读状态/发命令,不自己建引擎) ----
                    @android.webkit.JavascriptInterface
                    public boolean isRuntimeRunning() {
                        return PaperForegroundService.isRuntimeRunning();
                    }

                    @android.webkit.JavascriptInterface
                    public String runtimeStatus() {
                        return PaperForegroundService.lastStatus();
                    }

                    @android.webkit.JavascriptInterface
                    public long runtimeStartedAt() {
                        return PaperForegroundService.runtimeStartedAt();
                    }

                    /** 确保服务在跑(重开 UI 时若服务被杀,重新拉起而不是在 UI 里另起引擎) */
                    @android.webkit.JavascriptInterface
                    public boolean ensureRuntime() {
                        startPaperService();
                        return PaperForegroundService.isRuntimeRunning();
                    }

                    /** V16.1-RV §50:取走"通知点击带来的深链载荷"(取一次即清空;无则空串) */
                    @android.webkit.JavascriptInterface
                    public String pendingNotification() {
                        String v = pendingNotificationJson;
                        pendingNotificationJson = "";
                        return v == null ? "" : v;
                    }
                }, "QuantNative");
                Log.i(TAG, "QuantNative bridge attached (runtimeRunning=" + PaperForegroundService.isRuntimeRunning() + ")");
            }
        } catch (Exception e) {
            Log.w(TAG, "bridge attach failed: " + e.getMessage());
            // 桥接失败不影响页面本身
        }
    }

    @Override
    public void onDestroy() {
        // 说明:Activity 销毁**不停止**运行时 —— 这正是本轮改造的目的。
        Log.i(TAG, "activity destroyed (runtime keeps running=" + PaperForegroundService.isRuntimeRunning() + ")");
        super.onDestroy();
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (sp.getBoolean("notif_asked", false)) return;
        sp.edit().putBoolean("notif_asked", true).apply();
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFICATION);
    }

    private void startPaperService() {
        try {
            Intent svc = new Intent(this, PaperForegroundService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(svc);
            else startService(svc);
        } catch (Exception e) {
            Log.w(TAG, "start service failed: " + e.getMessage());
        }
    }
}
