// tools/test-runtime-boot.mjs · 在最小 WebView 仿真里【原样运行】tools/runtime-host.js(服务端真实接线代码)
// 目的(教训驱动):真机 P0 —— runtime-host 把同步的 fetchTickersWithFailover() 当 Promise 用(.then),
// 导致后台运行时每一轮 tick 都在行情处抛 "…then is not a function",loops 恒 0、从没推进过。
// 这类"接线错误"桌面单测此前抓不到,因为它们不由 worker/src 的模块直接暴露;
// 这里用 dist 里的真实 qengine bundle + 真实 runtime-host.js 跑一轮完整 tick,把它钉死在 CI 里。
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(import.meta.dirname, "..");
let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log("PASS  " + name); }
  else { failed += 1; console.log("FAIL  " + name + (detail ? "  => " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const qengineSrc = fs.readFileSync(path.join(ROOT, "dist", "app", "qengine.js"), "utf8");
const hostSrc = fs.readFileSync(path.join(ROOT, "tools", "runtime-host.js"), "utf8");

// ---- 罐装行情(与真机 bridge.httpGet 的返回形状一致:字符串) ----
const T0 = 1700000000000;
function klinesRows(count) {
  const rows = [];
  let p = 84000;
  for (let i = 0; i < count; i += 1) {
    const c = p * (1 + Math.sin(i / 7) * 0.002);
    rows.push([T0 + i * 3600000, String(p), String(Math.max(p, c) * 1.001), String(Math.min(p, c) * 0.999), String(c), String(10 + i)]);
    p = c;
  }
  return rows;
}
const KLINES = JSON.stringify(klinesRows(200));
const TICKERS = JSON.stringify([
  { symbol: "BTCUSDT", lastPrice: "84000", highPrice: "84500", lowPrice: "83500" },
  { symbol: "ETHUSDT", lastPrice: "2712", highPrice: "2740", lowPrice: "2690" },
  { symbol: "BNBUSDT", lastPrice: "768", highPrice: "775", lowPrice: "760" },
  { symbol: "SOLUSDT", lastPrice: "119", highPrice: "122", lowPrice: "117" },
  { symbol: "XRPUSDT", lastPrice: "1.48", highPrice: "1.5", lowPrice: "1.45" }
]);

const statuses = [];
const logs = [];
const httpCalls = [];

const sandbox = {
  console: { log: (...a) => logs.push(a.join(" ")), warn: () => {}, error: (...a) => logs.push("ERR " + a.join(" ")) },
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Promise, Number, String, Boolean, Array, Object, Map, Set, Error, TypeError, isFinite, parseFloat, parseInt,
  performance: { now: () => Date.now() },
  TextEncoder, TextDecoder, URL, URLSearchParams, structuredClone,
  crypto: globalThis.crypto,
  addEventListener: () => {},        // runtime-host 注册 error/unhandledrejection 用
  removeEventListener: () => {}
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(qengineSrc, sandbox, { filename: "qengine.js" });
check("qengine bundle 在沙箱里装载出 window.QEngine", Boolean(sandbox.window.QEngine && sandbox.window.QEngine.createPaperRuntime));
check("沙箱 QEngine 导出 createPaperEngine/createHistoryStore", Boolean(sandbox.window.QEngine.createPaperEngine && sandbox.window.QEngine.createHistoryStore));

// ---- 罐装 QuantRuntime 桥(与真机服务 RuntimeBridge 同形状:同步 httpGet) ----
sandbox.window.QuantRuntime = {
  log: (m) => logs.push(String(m)),
  httpGet: (url) => {
    httpCalls.push(String(url));
    if (String(url).includes("/api/tickers")) return TICKERS;
    if (String(url).includes("/api/klines")) return KLINES;
    if (String(url).includes("okx.com")) return JSON.stringify({ data: [] });
    return JSON.stringify({ error: "unmapped" });
  },
  notify: () => {},
  status: (json) => { try { statuses.push(JSON.parse(json)); } catch (error) { /* */ } }
};

// ---- 原样运行服务端 runtime-host.js ----
try {
  vm.runInContext(hostSrc, sandbox, { filename: "runtime-host.js" });
  check("runtime-host.js 在沙箱里执行不抛异常", true);
} catch (error) {
  check("runtime-host.js 在沙箱里执行不抛异常", false, String(error && error.message));
}

await sleep(2500);   // 等 boot() 的异步链:createHistoryStore → createPaperEngine.init → runtime.start(含首轮 tick)

const rt = sandbox.window.QEngine.getRuntime("paper-runtime");
check("runtime-host 真的创建了运行时单例(paper-runtime)", Boolean(rt), "getRuntime 为空");
check("运行时进入 RUNNING", Boolean(rt && rt.isRunning()), rt ? rt.status().state : "no-runtime");
check("运行时回报了状态(原生通知通道)", statuses.length > 0, "statuses=" + statuses.length);
const last = statuses[statuses.length - 1] || null;
if (last) {
  check("首轮 tick 后 loops ≥ 1(后台真的在推进)", Number(last.loops) >= 1, JSON.stringify({ loops: last.loops, error: last.last_error }));
  check("行情健康(不是 MARKET_PROVIDER_BLOCKED)", last.market_state === "HEALTHY" && !last.market_blocked, JSON.stringify({ state: last.market_state, err: last.last_error }));
  check("last_error 不含 '.then is not a function'(P0 回归)", !String(last.last_error || "").includes("is not a function"), String(last.last_error));
  check("心跳新鲜(实例身份已在)", Boolean(last.instance_id) && Number(last.heartbeat_age_ms) < 60000, JSON.stringify({ id: last.instance_id, age: last.heartbeat_age_ms }));
}
check("桥被真实调用过服务端的 /api/tickers 与 /api/klines", httpCalls.some((u) => u.includes("/api/tickers")) && httpCalls.some((u) => u.includes("/api/klines")), "calls=" + httpCalls.length);
check("host 日志里没有 '.then is not a function'", !logs.some((l) => l.includes("is not a function")), logs.filter((l) => l.includes("is not a function")).slice(0, 2).join(" | "));

// 收尾:停掉运行时与定时器,避免挂住进程
try { if (rt) rt.dispose(); } catch (error) { /* */ }
await sleep(200);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("RUNTIME BOOT OK");
process.exit(0);
