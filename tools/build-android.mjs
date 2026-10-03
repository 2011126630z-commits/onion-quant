// tools/build-android.mjs · 生成 Android(WebView/Capacitor) 需要的静态资源
// 产出 dist/app/ 下的静态站点(index.html / app.html / qengine.js / native-bridge.js),
// 作为 Capacitor 的 webDir;native-bridge.js 在原生环境把 /api/* 映射到官方公开端点(原生 HTTP,避开 CORS),
// 做到"APK 不依赖电脑上的 127.0.0.1:xxxx"(安全:固定主机白名单,无动态 host,无密钥)。
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "..");
const built = fs.readFileSync(path.join(ROOT, "worker/index.js"), "utf8");

const bundleMatch = built.match(/const QENGINE_SRC = ("(?:[^"\\]|\\.)*");/);
if (!bundleMatch) throw new Error("QENGINE_SRC not found; run tools/build.mjs first");
const qengineSrc = JSON.parse(bundleMatch[1]);
const pageMatch = built.match(/const page = String\.raw`([\s\S]*?)<\/html>`;/);
if (!pageMatch) throw new Error("page template not found; run tools/build.mjs first");
let html = pageMatch[1] + "</html>";

const hash = createHash("sha1").update(qengineSrc).digest("hex").slice(0, 10);
html = html.replace(/<script src="\/qengine\.js\?h=[^"]*"><\/script>/, '<script src="qengine.js"></script>');
if (!html.includes('<script src="qengine.js"></script>')) throw new Error("qengine script tag rewrite failed");
html = html.replace('<script src="qengine.js"></script>', '<script src="qengine.js"></script>\n    <script src="native-bridge.js"></script>');

const bridge = `// native-bridge.js · Android(WebView/Capacitor)运行桥
(function () {
  'use strict';
  var IS_NATIVE = !!(window.Capacitor && (window.Capacitor.isNativePlatform ? window.Capacitor.isNativePlatform() : true));
  if (!IS_NATIVE) return;
  var HOSTS = {
    futures: ['https://fapi.binance.com', 'https://fapi1.binance.com'],
    spot: ['https://api.binance.com']
  };
  var PATHS = {
    klines: '/fapi/v1/klines',
    ticker: '/fapi/v1/ticker/24hr',
    tickers: '/fapi/v1/ticker/24hr',
    funding: '/fapi/v1/premiumIndex',
    open_interest: '/futures/data/openInterestHist',
    long_short: '/futures/data/globalLongShortAccountRatio',
    taker: '/futures/data/takerlongshortRatio'
  };
  function nativeGet(url) {
    var cap = window.Capacitor;
    if (cap && cap.Plugins && cap.Plugins.CapacitorHttp && cap.Plugins.CapacitorHttp.get) {
      return cap.Plugins.CapacitorHttp.get({ url: url, headers: { accept: 'application/json' } }).then(function (r) {
        var body = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
        return new Response(body, { status: r.status || 200, headers: { 'content-type': 'application/json' } });
      });
    }
    return fetch(url, { headers: { accept: 'application/json' } });
  }
  window.__quantNativeFetch = function (apiUrl) {
    try {
      var u = new URL(apiUrl, 'https://app.local');
      var market = u.searchParams.get('market') === 'spot' ? 'spot' : 'futures';
      var p = u.pathname;
      var type = p.indexOf('/klines') >= 0 ? 'klines' : p.indexOf('/tickers') >= 0 ? 'tickers' : p.indexOf('/funding') >= 0 ? 'funding'
        : p.indexOf('/open_interest') >= 0 ? 'open_interest' : p.indexOf('/long_short') >= 0 ? 'long_short' : p.indexOf('/taker') >= 0 ? 'taker' : 'ticker';
      var base = HOSTS[market] && HOSTS[market][0];
      if (!base) return Promise.reject(new Error('market_not_supported'));
      var target = base + PATHS[type];
      var qs = [];
      var symbol = (u.searchParams.get('symbol') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (symbol) qs.push('symbol=' + (symbol.indexOf('USDT') === symbol.length - 4 ? symbol : symbol + 'USDT'));
      if (type === 'klines') {
        qs.push('interval=' + (u.searchParams.get('interval') || '1h'));
        qs.push('limit=' + Math.min(1500, Math.max(20, Number(u.searchParams.get('limit') || 120))));
      }
      if (type === 'open_interest') { qs.push('period=5m'); qs.push('limit=2'); }
      if (type === 'long_short') { qs.push('period=5m'); qs.push('limit=1'); }
      if (type === 'taker') { qs.push('period=5m'); qs.push('limit=1'); }
      return nativeGet(target + (qs.length ? '?' + qs.join('&') : ''));
    } catch (error) {
      return Promise.reject(error);
    }
  };
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var m = /\\/api\\/([a-z_\\/]+)/.exec(url);
    if (m) {
      var api = m[1];
      if (api === 'klines' || api === 'tickers' || api === 'funding' || api === 'open_interest' || api === 'long_short' || api === 'taker' || api === 'ticker') {
        return window.__quantNativeFetch(url);
      }
      return Promise.resolve(new Response(JSON.stringify({ error: 'native_no_server', reason: 'apk_has_no_backend', detail: api }), { status: 503, headers: { 'content-type': 'application/json' } }));
    }
    return origFetch ? origFetch(input, init) : Promise.reject(new Error('fetch_unavailable'));
  };
  window.__quantNative = { isNative: true, version: '15.0.0-paper', hosts: Object.keys(HOSTS) };
})();
`;

const distDir = path.join(ROOT, "dist", "app");
fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(path.join(distDir, "qengine.js"), qengineSrc, "utf8");
fs.writeFileSync(path.join(distDir, "native-bridge.js"), bridge, "utf8");
fs.writeFileSync(path.join(distDir, "app.html"), html, "utf8");
fs.writeFileSync(path.join(distDir, "index.html"), html, "utf8");

// V15 P0:无界面 Runtime 页面 —— 由原生前台服务"自己的" WebView 加载(不依赖 Activity/UI WebView)。
// 与 UI 同源(https://localhost),因此共享同一份 IndexedDB —— 天生就是"同一账户、同一持仓"。
const hostScript = fs.readFileSync(path.join(ROOT, "tools", "runtime-host.js"), "utf8");
const runtimeHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Paper Runtime</title>
</head>
<body>
<!-- 无界面:只跑 Paper Runtime,不渲染任何 UI -->
<script src="qengine.js"></script>
<script src="runtime-host.js"></script>
</body>
</html>`;
fs.writeFileSync(path.join(distDir, "runtime-host.js"), hostScript, "utf8");
fs.writeFileSync(path.join(distDir, "runtime.html"), runtimeHtml, "utf8");

console.log("android web assets -> dist/app/{index.html,app.html,qengine.js,native-bridge.js,runtime.html,runtime-host.js}");
console.log("qengine " + (qengineSrc.length / 1024).toFixed(1) + " KB, page " + (html.length / 1024).toFixed(1) + " KB, hash " + hash);
