// tools/test-device-boot.mjs · V16.2w P0(工单 A–H) · 设备复刻启动回归
// 目的:在沙箱里按【真机执行顺序】复现并长期锁定:
//   ①真 native-bridge.js(替换 window.fetch + CapacitorHttp)②QuantNative 桥桩(MainActivity 语义)
//   ③设备历史 localStorage 变体(干净/损坏/被拒)④主脚本死亡时的兜底导航
// 断言目标(对应用户 P0 清单):
//   A 点击到达/B 路由切换/C 无 overlay 拦截(绑定计数)/D 单一状态源/E-F 账户与市场数据独立
//   G UI 订阅运行时/H 启动无死锁 + BOOT_SEQUENCE 可见 + 十连点幂等 + 单引擎实例
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

// ---------- 1) 取构建产物(与部署一致) ----------
const builtSrc = fs.readFileSync(path.join(ROOT, "worker/index.js"), "utf8");
const qengineSrc = JSON.parse(builtSrc.match(/const QENGINE_SRC = ("(?:[^"\\]|\\.)*");/)[1]);
const pageHtml = builtSrc.match(/const page = String\.raw`([\s\S]*?)<\/html>`;/)[1] + "</html>";
const inlineScripts = [...pageHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const bridgeSrc = fs.readFileSync(path.join(ROOT, "dist/app/native-bridge.js"), "utf8");
check("BootHarnessTest: 构建产物含 2 段内联脚本(head 护盾 + 主脚本)", inlineScripts.length === 2, String(inlineScripts.length));
check("BootHarnessTest: 页面含启动异常横幅元素(#bootBanner)", /id="bootBanner"/.test(pageHtml));
check("BootHarnessTest: 页面含诊断 Boot Status 卡片(#diagBootBox)", /id="diagBootBox"/.test(pageHtml));

// ---------- 2) 极简 DOM(与 test-nav-stress 同源;dispatch 逐监听 try/catch = 真实 DOM 语义) ----------
function makeDom(html) {
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const metaById = new Map();
  for (const m of html.matchAll(/<(\w+)([^>]*?)\bid="([^"]+)"([^>]*)>/g)) {
    const attrs = m[2] + m[4];
    const cls = attrs.match(/class="([^"]*)"/);
    const dataset = {};
    for (const d of attrs.matchAll(/data-([a-z0-9-]+)="([^"]*)"/g)) dataset[d[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = d[2];
    metaById.set(m[3], { classes: cls ? cls[1].split(/\s+/).filter(Boolean) : [], tag: m[1], dataset });
  }
  const counters = { listeners: 0 };
  const listenerErrors = [];
  let phantomParent = null;
  function makeClassList(owner) {
    const set = new Set(owner.__classes);
    return {
      add: (...cs) => { for (const c of cs) set.add(c); sync(); },
      remove: (...cs) => { for (const c of cs) set.delete(c); sync(); },
      toggle: (c, force) => { const on = force === undefined ? !set.has(c) : Boolean(force); if (on) set.add(c); else set.delete(c); sync(); return on; },
      contains: (c) => set.has(c),
      toString: () => [...set].join(" ")
    };
    function sync() { owner.__classes = [...set]; }
  }
  function makeEl(tag, id, classes, persistent) {
    const el = {
      tagName: String(tag || "div").toUpperCase(), id: id || "", __persistent: Boolean(persistent),
      children: [], parentNode: null, style: {}, dataset: {}, __classes: [...(classes || [])],
      textContent: "", value: "", options: [], scrollTop: 0, scrollHeight: 100, clientWidth: 390,
      disabled: false, hidden: false, type: "", href: "", download: "", files: [], width: 0, height: 0,
      __listeners: Object.create(null),
      appendChild(child) { this.children.push(child); if (child) child.parentNode = this; return child; },
      removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); return child; },
      replaceChildren(...nodes) { this.children = []; for (const n of nodes) this.appendChild(n); },
      insertBefore(node) { this.children.unshift(node); return node; },
      querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
      setAttribute(k, v) { this[k] = v; }, getAttribute(k) { return this[k]; },
      addEventListener(type, fn) { counters.listeners += 1; (this.__listeners[type] = this.__listeners[type] || []).push(fn); },
      removeEventListener(type, fn) { const a = this.__listeners[type] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
      dispatch(type, event) {
        const box = this.__listeners[type] || [];
        let ok = 0;
        for (const fn of [...box]) {
          try { fn(event || { type, target: this, preventDefault() {}, stopPropagation() {} }); ok += 1; }
          catch (error) { listenerErrors.push(type + "@" + (this.id || this.tagName) + ": " + String((error && error.message) || error)); }
        }
        return ok;
      },
      click() { return this.dispatch("click", { type: "click", target: this, preventDefault() {}, stopPropagation() {} }); },
      focus() {}, blur() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 268, right: 390, bottom: 268 }),
      getContext: () => ctx2d, classList: null, contains: () => false,
      get parentElement() { if (this.parentNode) return this.parentNode; if (!phantomParent) phantomParent = makeEl("div"); return phantomParent; },
      get firstChild() { return this.children[0] || null; },
      get childElementCount() { return this.children.length; }
    };
    el.classList = makeClassList(el);
    return el;
  }
  const ctx2d = new Proxy({}, {
    get(target, prop) {
      if (prop === "canvas") return null;
      if (prop === "measureText") return () => ({ width: 20 });
      if (["setTransform", "clearRect", "fillRect", "beginPath", "moveTo", "lineTo", "stroke", "fill", "fillText", "save", "restore", "setLineDash", "closePath", "arc"].includes(prop)) return () => {};
      return target[prop];
    },
    set(target, prop, value) { target[prop] = value; return true; }
  });
  const byId = new Map(); const all = []; const navButtons = []; const pageSections = [];
  const LEGACY_PAGE_IDS = ["page-monitor", "page-scan", "page-watch", "page-settings", "page-validation", "page-backtest", "page-walkforward", "page-dataset", "page-ml", "page-health"];
  const appEl = makeEl("main", "", ["app"], true);
  appEl.contains = (el) => Boolean(el && LEGACY_PAGE_IDS.includes(el.id));
  Object.defineProperty(appEl.style, "display", { get() { return this.__display || ""; }, set(v) { this.__display = v; }, configurable: true });
  for (const id of ids) {
    const meta = metaById.get(id) || { classes: [], tag: "div", dataset: {} };
    const el = makeEl(meta.tag, id, meta.classes, true);
    el.dataset = { ...meta.dataset };
    byId.set(id, el); all.push(el);
    if (el.__classes.includes("nav-btn")) navButtons.push(el);
    if (el.__classes.includes("page")) pageSections.push(el);
  }
  for (const m of html.matchAll(/<(\w+)([^>]*?)class="([^"]*\bnav-btn\b[^"]*)"([^>]*)>/g)) {
    const attrs = m[2] + m[4];
    const dataset = {};
    for (const d of attrs.matchAll(/data-([a-z0-9-]+)="([^"]*)"/g)) dataset[d[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = d[2];
    const el = makeEl(m[1], "", m[3].split(/\s+/).filter(Boolean), true);
    el.dataset = dataset; navButtons.push(el); all.push(el);
  }
  const doc = {
    documentElement: makeEl("html", "", ["theme-dark"]), body: makeEl("body"), hidden: false, activeElement: null,
    __docListeners: Object.create(null),
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => makeEl(tag),
    createTextNode: (t) => ({ textContent: t }),
    querySelector: (sel) => (sel === 'meta[name="theme-color"]' ? makeEl("meta") : sel === ".app" ? appEl : null),
    querySelectorAll: (sel) => (sel === ".page" ? pageSections : sel === ".nav-btn" ? navButtons : []),
    addEventListener(type, fn) { counters.listeners += 1; (this.__docListeners[type] = this.__docListeners[type] || []).push(fn); },
    removeEventListener() {},
    dispatch(type, event) { for (const fn of [...(this.__docListeners[type] || [])]) { try { fn(event || { type }); } catch (error) { listenerErrors.push("doc:" + type + ": " + String((error && error.message) || error)); } } }
  };
  return { doc, byId, all, navButtons, pageSections, counters, listenerErrors, appEl };
}

function makeTimers() {
  let seq = 0;
  const intervals = new Map(); const liveTimeouts = new Set();
  const realSetTimeout = setTimeout; const realClearTimeout = clearTimeout;
  const sandboxSetTimeout = (fn, ms) => { const id = realSetTimeout(() => { liveTimeouts.delete(id); fn(); }, ms); liveTimeouts.add(id); return id; };
  const sandboxClear = (id) => { if (liveTimeouts.delete(id)) { realClearTimeout(id); return; } intervals.delete(id); };
  const sandboxSetInterval = (fn, ms) => { const id = ++seq; intervals.set(id, { fn, ms }); return id; };
  return { intervals, liveTimeouts, set: sandboxSetTimeout, setInterval: sandboxSetInterval, clear: sandboxClear, live: (k) => (k === "interval" ? intervals.size : liveTimeouts.size) };
}

function marketDataFor(url) {
  const u = String(url);
  if (/klines/.test(u)) {
    const out = []; let p = 42000;
    for (let i = 0; i < 220; i += 1) { const o = p; const c = o * (1 + Math.sin(i / 9) * 0.003); out.push([1700000000000 + i * 3600000, String(o), String(Math.max(o, c) * 1.001), String(Math.min(o, c) * 0.999), String(c), String(100 + i)]); p = c; }
    return out;
  }
  if (/ticker/.test(u)) {
    return ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "TRXUSDT"]
      .map((symbol, i) => ({ symbol, lastPrice: String(100 + i), priceChangePercent: String(i % 5 - 2), highPrice: String(105 + i), lowPrice: String(95 + i), quoteVolume: String(9e9 - i * 1e8), fundingRate: "0.0001" }));
  }
  if (/funding/.test(u)) return { symbol: "BTCUSDT", lastFundingRate: "0.0001", nextFundingTime: Date.now() + 8 * 3600000, provider: "binance" };
  return { ok: true };
}
function jsonResponse(body, status) {
  return { ok: (status || 200) < 400, status: status || 200, headers: { get: () => "stub" }, json: async () => body, text: async () => JSON.stringify(body) };
}

// ---------- 3) 变体运行器(设备复刻) ----------
async function runVariant(name, cfg) {
  const { device, lsSeed, runtimeJson, lsThrow, skipMain, corruptKey, errorEventProbe, hangFetch, perfObserver } = cfg;
  const dom = makeDom(pageHtml);
  const timers = makeTimers();
  const rafQueue = [];
  const ls = new Map(lsSeed || []);
  const fetchCalls = [];
  const syncErrors = [];
  const asyncErrors = [];
  let engineInstances = 0;
  const onUnhandled = (err) => { asyncErrors.push(String((err && err.stack) || err).slice(0, 300)); };
  process.on("unhandledRejection", onUnhandled);

  const lsObj = {
    getItem: (k) => { if (lsThrow && lsThrow.includes(k)) { const e = new Error("Failed to read the 'localStorage' property from 'Window': Access is denied for this document."); e.name = "SecurityError"; throw e; } return ls.has(k) ? ls.get(k) : null; },
    setItem: (k, v) => { if (lsThrow && lsThrow.includes(k)) { const e = new Error("SecurityError: storage disabled"); e.name = "SecurityError"; throw e; } ls.set(k, String(v)); },
    removeItem: (k) => ls.delete(k)
  };
  const windowObj = {
    devicePixelRatio: 3, __quantDiag: [], localStorage: lsObj,
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    addEventListener(type, fn) { (this.__listeners = this.__listeners || {}); (this.__listeners[type] = this.__listeners[type] || []).push(fn); },
    removeEventListener() {},
    requestAnimationFrame: (fn) => { rafQueue.push(fn); return -(rafQueue.length); },
    cancelAnimationFrame: () => {},
    setTimeout: timers.set, setInterval: timers.setInterval, clearTimeout: timers.clear, clearInterval: timers.clear,
    fetch: async (url, options) => {
      fetchCalls.push(String(url));
      // V16.2x 工单 §4:可注入"永远挂起"的行情请求,验证导航绝不等待行情
      if (hangFetch && /\/api\/(klines|tickers|funding)/.test(String(url))) return new Promise(() => { /* 永不返回 */ });
      const signal = options && options.signal;
      if (signal && signal.aborted) { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
      const u = String(url);
      if (/\/api\/klines/.test(u)) return jsonResponse(marketDataFor("klines"));
      if (/\/api\/tickers/.test(u)) return jsonResponse(marketDataFor("ticker"));
      if (/\/api\/funding/.test(u)) return jsonResponse(marketDataFor("funding"));
      if (/\/api\/health/.test(u)) return jsonResponse({ generated_at: new Date().toISOString(), providers: [], net_mode: "direct", proxy_method: "direct" });
      if (/\/api\/ai\/review/.test(u)) return jsonResponse({ ok: false, reason: "no_server_key" });
      return jsonResponse({ error: "not found" }, 404);
    }
  };
  if (device) {
    windowObj.QuantNative = {
      isNativeShell: () => true,
      isRuntimeRunning: () => runtimeJson !== null,
      runtimeStatus: () => (runtimeJson == null ? "" : JSON.stringify(runtimeJson)),
      runtimeStartedAt: () => 0,
      pendingNotification: () => "",
      notify() {}, setAutoStart() {}, ensureRuntime: () => runtimeJson !== null
    };
    windowObj.Capacitor = {
      isNativePlatform: () => true,
      Plugins: { CapacitorHttp: { get: async ({ url }) => ({ status: 200, data: marketDataFor(url) }) } }
    };
  }
  const sandbox = {
    window: windowObj, document: dom.doc, localStorage: lsObj,
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout: timers.set, setInterval: timers.setInterval, clearTimeout: timers.clear, clearInterval: timers.clear,
    requestAnimationFrame: windowObj.requestAnimationFrame,
    getComputedStyle: () => ({ getPropertyValue: () => "#123456" }),
    AbortController, AbortSignal, Promise, JSON, Math, Date, Number, String, Object, Array, Error, Set, Map, isFinite, parseInt, parseFloat,
    Intl, encodeURIComponent, decodeURIComponent,
    // V16.2x:URL 必须是真构造函数(与浏览器一致)—— native-bridge 的 new URL(...) 依赖它;仅加 blob 静态桩
    URL, Blob: class { constructor() {} }, FileReader: class { readAsText() {} },
    Element: class {}, Event: class {}, CustomEvent: class {},
    indexedDB: undefined, navigator: { userAgent: device ? "Mozilla/5.0 (Linux; Android 16; V2502A) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36" : "node-test" },
    performance: { now: () => Date.now(), timeOrigin: Date.now() }
  };
  if (perfObserver) {
    // 假 Long Task 观察器:验证页面确实注册 observe({entryTypes:["longtask"]}) 且条目入账(工单 §2)。
    // 注意:页面可能存在多个观察者(护盾 + devPerf),这里收集【全部】回调逐一驱动,避免只覆盖最后一个。
    class FakePO { constructor(cb) { windowObj.__ltCbs = (windowObj.__ltCbs || []).concat([cb]); } observe(opts) { windowObj.__ltObserving = true; windowObj.__ltOpts = opts; } }
    sandbox.PerformanceObserver = FakePO;
  }
  sandbox.globalThis = sandbox; sandbox.self = sandbox;
  sandbox.fetch = windowObj.fetch;
  sandbox.Response = class {
    constructor(body, init) { this.body = body; this.status = (init && init.status) || 200; this.ok = this.status < 400; this.headers = { get: () => "stub" }; }
    static json(body, init) { return jsonResponse(body, init && init.status); }
    async json() { return JSON.parse(String(this.body)); }
    async text() { return String(this.body); }
  };
  sandbox.Request = class { constructor(url) { this.url = String(url); } };
  sandbox.Headers = class { get() { return null; } };
  vm.createContext(sandbox);
  vm.runInContext(qengineSrc, sandbox, { filename: "qengine.js" });
  const realCreatePaperEngine = sandbox.window.QEngine.createPaperEngine;
  sandbox.window.QEngine.createPaperEngine = function (...args) { engineInstances += 1; return realCreatePaperEngine.apply(this, args); };
  if (device) {
    vm.runInContext(bridgeSrc, sandbox, { filename: "native-bridge.js" });   // 真机顺序:桥先于页面脚本,替换 window.fetch
    sandbox.fetch = windowObj.fetch;
  }
  try {
    inlineScripts.forEach((src, idx) => {
      if (skipMain && idx > 0) return;   // FallbackNavTest:模拟主脚本整段死亡
      vm.runInContext(src, sandbox, { filename: "page-inline-" + (idx + 1) + ".js" });
    });
  } catch (error) {
    syncErrors.push(String((error && error.stack) || error).slice(0, 500));
    try { for (const fn of (windowObj.__listeners && windowObj.__listeners.error) || []) fn({ message: String((error && error.message) || error), error }); } catch (error2) { /* ignore */ }
  }
  const flush = async (times) => {
    for (let i = 0; i < (times || 40); i += 1) {
      // 交替 setImmediate/setTimeout:真实事件循环里 timers 与 check 相都会推进,
      // 纯 setImmediate 循环在某些时序下会让挂起的 setTimeout(0)(引擎/页面的让步)得不到执行机会。
      await new Promise((r) => (i % 2 ? setImmediate(r) : setTimeout(r, 0)));
      if (rafQueue.length) { const batch = rafQueue.splice(0, rafQueue.length); for (const fn of batch) { try { fn(Date.now()); } catch (error) { /* ignore */ } } }
    }
  };
  await flush(60);
  if (errorEventProbe) {
    try { for (const fn of (windowObj.__listeners && windowObj.__listeners.error) || []) fn({ message: "probe_uncaught_error", error: new RangeError("probe_uncaught_error") }); } catch (error) { /* ignore */ }
  }
  const clickNav = async (pageName) => {
    const btn = dom.navButtons.find((b) => b.dataset.page === pageName);
    if (!btn) return { bound: 0, ok: false };
    const bound = (btn.__listeners.click || []).length;
    const okCount = btn.click();
    dom.doc.dispatch("click", { type: "click", target: btn, preventDefault() {}, stopPropagation() {} });   // 真实 DOM:冒泡到 document
    await flush(20);
    return { bound, ok: okCount > 0 };
  };
  const ui = () => { try { return sandbox.window.__quantUI && sandbox.window.__quantUI.state ? sandbox.window.__quantUI.state() : null; } catch (error) { return null; } };
  return { dom, sandbox, ls, timers, fetchCalls, syncErrors, asyncErrors, engineInstancesRef: () => engineInstances, flush, clickNav, ui, windowObj };
}

// ---------- 4) 设备历史 localStorage(带上亿条真实键) ----------
const DEVICE_LS = [
  ["deviceId", "devabc123"],
  ["autoStart", "true"],
  ["quantSettings", JSON.stringify({ defaultSymbol: "BTCUSDT", interval: "1h", scanLimit: "50", refreshInterval: "30", themeMode: "dark", notify: true })],
  ["watchSymbols", JSON.stringify(["BTCUSDT", "ETHUSDT"])],
  ["symbolUniverse", JSON.stringify({ at: Date.now() - 3600000, list: [{ symbol: "BTCUSDT", change: 1 }] })]
];
const hmText = (dom, id) => String((dom.byId.get(id) || {}).textContent || "");
const bootOf = (sandbox) => sandbox.window.__quantBoot || {};

console.log("== A. 设备桥桩启动(QuantNative + Capacitor + 原生 fetch) ==");
{
  const r = await runVariant("device-fresh", { device: true, lsSeed: DEVICE_LS, runtimeJson: null });
  check("DeviceBridgeBootTest: 设备桥桩下主脚本完整执行(无未捕获异常)", r.syncErrors.length === 0, r.syncErrors[0] && r.syncErrors[0].slice(0, 300));
  check("DeviceBridgeBootTest: 四个底部导航全部绑定点击(点击可到达)", r.dom.navButtons.length === 4 && r.dom.navButtons.every((b) => (b.__listeners.click || []).length === 1), JSON.stringify(r.dom.navButtons.map((b) => (b.dataset.page || "?") + ":" + (b.__listeners.click || []).length)));
  let allSwitch = true; const switchLog = [];
  for (const p of ["market", "paper", "settings", "home"]) {
    const res = await r.clickNav(p);
    const act = r.dom.pageSections.filter((s) => s.__classes.includes("active")).map((s) => s.id);
    const st = r.ui();
    switchLog.push(p + "=>" + (st ? st.currentPage : "null") + "[" + act.join(",") + "]");
    if (!res.ok || !st || st.currentPage !== p || act.length !== 1 || act[0] !== "page-" + p) allSwitch = false;
  }
  check("DeviceBridgeBootTest: 首页/市场/模拟/我的 依次切换成功且 active 唯一", allSwitch, switchLog.join(" | "));
  const boot = bootOf(r.sandbox);
  check("BootSequenceTest: BOOT 序列推进到 UI_READY(设备桥桩)", boot.ui_ready === true && String(boot.stage).startsWith("nav:"), JSON.stringify({ stage: boot.stage, ui_ready: boot.ui_ready }));
  check("BootSequenceTest: 健康启动零错误、无横幅、无兜底导航", (boot.errors || []).length === 0 && !(boot.fallback_nav_used > 0) && r.dom.byId.get("bootBanner").__classes.includes("hidden"), JSON.stringify({ errs: (boot.errors || []).length, fb: boot.fallback_nav_used }));
  const homeFields = ["hmEquity", "hmState", "hmPositions", "hmTrades", "hmAllocation", "hmRisk"].map((id) => hmText(r.dom, id));
  check("HomeDataTest: 启动后首页为真实值(无 --、无 加载中… 残留)", homeFields.every((t) => t && t.trim() !== "--" && !t.includes("加载中")), JSON.stringify(homeFields));
  const sw0 = (boot.nav_switches || 0);
  for (let k = 0; k < 10; k += 1) await r.clickNav("paper");
  const sw1 = (bootOf(r.sandbox).nav_switches || 0);
  check("NavIdempotencyTest: 当前 Tab 连点 10 次 = 1 次真实切换(nav_switches 只 +1)", sw1 - sw0 === 1, JSON.stringify({ before: sw0, after: sw1 }));
  check("SingleInitTest: 全流程只有一个 Paper 引擎实例", r.engineInstancesRef() === 1 && (r.ui() || {}).engineInstances === 1, JSON.stringify({ created: r.engineInstancesRef(), page: (r.ui() || {}).engineInstances }));
  check("OverlayAuditTest: 无遮罩处于打开态(不拦截点击)", (() => { try { return (r.ui().activePages || []).length === 1; } catch (error) { return false; } })());
}

console.log("== B. 存储残留非法 JSON → 自愈不致命 ==");
{
  const corruptQuant = DEVICE_LS.map((e) => (e[0] === "quantSettings" ? ["quantSettings", '{"defaultSymbol":"BTCUSDT"'] : e));
  const r1 = await runVariant("corrupt-quant", { device: true, lsSeed: corruptQuant, runtimeJson: null });
  const b1 = bootOf(r1.sandbox);
  check("StorageCorruptHealTest: quantSettings 非法 JSON → 主脚本存活(不再整段死亡)", r1.syncErrors.length === 0, r1.syncErrors[0] && r1.syncErrors[0].slice(0, 200));
  check("StorageCorruptHealTest: 自愈记录 quantSettings(诊断可见)", (b1.storage_healed || []).some((x) => x.key === "quantSettings" && x.reason === "corrupt_json"), JSON.stringify(b1.storage_healed));
  check("StorageCorruptHealTest: 自愈后导航与首页数据正常", (await r1.clickNav("market"), (r1.ui() || {}).currentPage === "market") && hmText(r1.dom, "hmEquity") === "100.00 USDT", JSON.stringify({ page: (r1.ui() || {}).currentPage, eq: hmText(r1.dom, "hmEquity") }));

  const corruptWatch = DEVICE_LS.map((e) => (e[0] === "watchSymbols" ? ["watchSymbols", "oops"] : e));
  const r2 = await runVariant("corrupt-watch", { device: true, lsSeed: corruptWatch, runtimeJson: null });
  const b2 = bootOf(r2.sandbox);
  check("StorageCorruptHealTest: watchSymbols 非法 → 回退默认自选且自愈记录", r2.syncErrors.length === 0 && (b2.storage_healed || []).some((x) => x.key === "watchSymbols"), JSON.stringify(b2.storage_healed));
  check("StorageCorruptHealTest: 自愈只记录不点亮横幅(功能无损)", r2.dom.byId.get("bootBanner").__classes.includes("hidden"), "横幅被误点亮");
}

console.log("== C. 存储被拒(SecurityError)→ 降级可用 ==");
{
  const r = await runVariant("storage-denied", { device: true, lsSeed: DEVICE_LS, runtimeJson: null, lsThrow: ["quantSettings", "watchSymbols", "autoStart", "deviceId"] });
  const b = bootOf(r.sandbox);
  check("StorageDeniedTest: 存储被拒 → 主脚本存活且错误被记录(storage_read)", r.syncErrors.length === 0 && (b.errors || []).some((e) => /^storage_read/.test(String(e.stage))), JSON.stringify((b.errors || []).map((e) => e.stage)));
  check("StorageDeniedTest: 存储被拒时导航仍可切换", (await r.clickNav("paper"), (r.ui() || {}).currentPage === "paper"), JSON.stringify((r.ui() || {}).currentPage));
  check("StorageDeniedTest: 存储被拒时首页仍出真实数据(本地账户不依赖存储/行情)", hmText(r.dom, "hmEquity") === "100.00 USDT", hmText(r.dom, "hmEquity"));
}

console.log("== D. 后台运行时在跑但镜像未落库 → 显式等待态 ==");
{
  const r = await runVariant("service-running", { device: true, lsSeed: DEVICE_LS, runtimeJson: { state: "RUNNING", market_state: "HEALTHY", loops: 3, market_stale: false, stalled: false, last_summary: { note: "ok" } } });
  check("NativeWaitingStateTest: 镜像为空 → 显示 等待后台数据…(不是 0.00/--)", hmText(r.dom, "hmEquity") === "等待后台数据…" && hmText(r.dom, "hmAllocation") === "等待后台数据…", JSON.stringify([hmText(r.dom, "hmEquity"), hmText(r.dom, "hmAllocation")]));
  check("NativeWaitingStateTest: 运行态标签与按钮来自同一来源(运行中→隐藏开始)", hmText(r.dom, "hmState").includes("运行") && r.dom.byId.get("hmStartBtn").hidden === true, JSON.stringify({ state: hmText(r.dom, "hmState"), startHidden: r.dom.byId.get("hmStartBtn").hidden }));
}

console.log("== E. 主脚本死亡 → 兜底导航 + 横幅(绝不静默死页) ==");
{
  const r = await runVariant("main-dead", { device: true, lsSeed: DEVICE_LS, runtimeJson: null, skipMain: true });
  const res = await r.clickNav("market");
  const act = r.dom.pageSections.filter((s) => s.__classes.includes("active")).map((s) => s.id);
  check("FallbackNavTest: 主脚本死亡时点击导航仍切换页面(head 护盾)", act.length === 1 && act[0] === "page-market", JSON.stringify(act));
  check("FallbackNavTest: 主脚本死亡时点亮启动异常横幅(不静默)", !r.dom.byId.get("bootBanner").__classes.includes("hidden") && (bootOf(r.sandbox).fallback_nav_used || 0) > 0, JSON.stringify({ fb: bootOf(r.sandbox).fallback_nav_used }));
}

console.log("== F. 未捕获错误 → window.error 记录(WebView onerror 语义) ==");
{
  const r = await runVariant("error-probe", { device: true, lsSeed: DEVICE_LS, runtimeJson: null, errorEventProbe: true });
  const b = bootOf(r.sandbox);
  check("UncaughtErrorTest: 未捕获错误写入 BOOT(errors + fatal + 堆栈)", (b.errors || []).some((e) => String(e.error).includes("probe_uncaught_error") && String(e.stack || "").length > 0) && b.fatal === true, JSON.stringify((b.errors || []).slice(-2)));
  check("UncaughtErrorTest: 未捕获错误点亮横幅(不静默)", !r.dom.byId.get("bootBanner").__classes.includes("hidden"));
}

console.log("== G. 启动响应性 / 主线程解阻塞(工单 STARTUP RESPONSIVENESS) ==");
if (process.env.QE_DEBUG_BOOT === "1") {
  for (let rep = 1; rep <= 2; rep += 1) {
    const rr = await runVariant("debug" + rep, { device: true, lsSeed: DEVICE_LS, runtimeJson: null });
    const B = bootOf(rr.sandbox);
    console.log("DEBUG#" + rep + " marks " + JSON.stringify(Object.keys(B.marks || {})));
    console.log("DEBUG#" + rep + " openStages " + JSON.stringify(Object.keys(B._open || {})));
    if (Object.keys(B._open || {}).length) {
      console.log("DEBUG#" + rep + " timersBefore " + JSON.stringify({ live: rr.timers.liveTimeouts.size, intervals: rr.timers.intervals.size, fired: rr.timers.stats.fired, cleared: rr.timers.stats.cleared }));
      await rr.flush(400);
      await new Promise((r) => setTimeout(r, 300));
      await rr.flush(100);
      const B2 = bootOf(rr.sandbox);
      console.log("DEBUG#" + rep + " afterExtraFlush openStages " + JSON.stringify(Object.keys(B2._open || {})) + " lastMarks=" + JSON.stringify(Object.keys(B2.marks || {}).slice(-4)));
      console.log("DEBUG#" + rep + " timersAfter " + JSON.stringify({ live: rr.timers.liveTimeouts.size, fired: rr.timers.stats.fired, cleared: rr.timers.stats.cleared }));
    }
    console.log("DEBUG#" + rep + " ctx " + vm.runInContext("typeof MessageChannel + '/' + typeof setTimeout + '/' + typeof URL + '/store=' + String(vstate.store && vstate.store.mode)", rr.sandbox));
    console.log("DEBUG#" + rep + " engine " + vm.runInContext("window.__engProbe = (async () => { try { const eng = await getPaperEngine(); return 'state:' + eng.getState(); } catch (e) { return 'ERR:' + String((e && e.message) || e); } })(); ''", rr.sandbox));
    await rr.flush(80);
    const engProbe = await Promise.race([rr.sandbox.window.__engProbe, new Promise((r) => setTimeout(() => r("PENDING"), 900))]);
    console.log("DEBUG#" + rep + " engProbe " + JSON.stringify(engProbe));
    console.log("DEBUG#" + rep + " errors " + JSON.stringify((B.errors || []).map((e) => e.stage + ":" + String(e.error).slice(0, 90))));
    if (rep === 1) {
      const rp = await runVariant("debug-perf", { device: true, lsSeed: DEVICE_LS, runtimeJson: null, perfObserver: true });
      console.log("DEBUG#" + rep + " ltCbType " + (typeof rp.windowObj.__ltCb) + " observing=" + String(rp.windowObj.__ltObserving));
      console.log("DEBUG#" + rep + " pushTest " + vm.runInContext("window.__quantBoot.longTasks.push({ test: 1 }); String(window.__quantBoot.longTasks.length)", rp.sandbox));
      console.log("DEBUG#" + rep + " hostRead " + JSON.stringify((bootOf(rp.sandbox).longTasks || []).slice(-1)));
      let cbErr = null;
      try { rp.windowObj.__ltCb([{ getEntries: () => [{ startTime: Date.now(), duration: 137 }] }]); } catch (e) { cbErr = String((e && e.message) || e); }
      console.log("DEBUG#" + rep + " ctxRead " + vm.runInContext("JSON.stringify(window.__quantBoot.longTasks.slice(-2))", rp.sandbox) + " cbErr=" + JSON.stringify(cbErr));
    }
  }
  process.exit(0);
}
{
  const pageSrc = inlineScripts[1];
  const bundleSrc = qengineSrc;
  // 阶段自检:十个 BOOT 阶段是否都在协议与产线里
  for (const stage of ["BOOT_HTML_READY", "BOOT_STORE_MINIMAL_READY", "BOOT_NAV_READY", "BOOT_ACCOUNT_SUMMARY_READY", "BOOT_DB_READY", "BOOT_POSITIONS_READY", "BOOT_MARKET_READY", "BOOT_SCANNER_READY", "BOOT_MODELS_READY", "BOOT_LEARNING_READY"]) {
    check("BootStageProtocolTest: 存在阶段 " + stage, pageSrc.includes(stage));
  }
  check("StartupPerfTest: 分块让步使用 MessageChannel(不受后台定时器节流)", /MessageChannel/.test(pageSrc) && /MessageChannel/.test(bundleSrc) && /yieldEventLoop/.test(bundleSrc));
  check("StartupPerfTest: Long Task 观察器已接线(entryTypes:[longtask] + 阶段标注)", /PerformanceObserver/.test(pageSrc) && /entryTypes: \["longtask"\]/.test(pageSrc));
  check("StartupPerfTest: 引擎 hydrate 分阶段让步(每 200 条/20 仓位让出主线程)", /workUnits % 200 === 0/.test(bundleSrc) && /workUnits % 20 === 0/.test(bundleSrc));
  check("StartupPerfTest: retention 先 count 再读表(小库零全量读取) + 每 50 删除让步", /adapter\.count\("paper_orders"\)/.test(pageSrc) && /processed % 50 === 0/.test(pageSrc));
  check("StartupPerfTest: 扫描批次间显式让步", /await yieldToMain\(\);/.test(pageSrc));
  check("StartupPerfTest: 成交列表默认 50 + 显示更多分页(不再全量灌视图层)", /pfTradesShown: 50/.test(pageSrc) && /显示更多/.test(pageSrc) && /limit: tradesShown/.test(pageSrc));
  check("StartupPerfTest: 隐藏页不做扫描面板 DOM 渲染(只在 store 更新)", /if \(!o\.force && !marketActive\) \{ viewState\.scanDirty = true; return; \}/.test(pageSrc));
  check("NoFullscreenBlockerTest: 全屏遮罩默认不可点(display:none 或 .hidden)", /\.sheet-mask \{[^}]*display: none/.test(pageHtml) && /\.v-overlay \{[^}]*display: none/.test(pageHtml) && /#bootBanner\.hidden \{ display: none; \}/.test(pageHtml) && /\.fab \{[^}]*display: none/.test(pageHtml) && /\.toast-box \{[^}]*pointer-events: none/.test(pageHtml));

  const r = await runVariant("startup-perf", { device: true, lsSeed: DEVICE_LS, runtimeJson: null, perfObserver: true });
  const b = bootOf(r.sandbox);
  const t = b.timings || {};
  check("StartupPerfTest: 观察器已注册 observe({entryTypes:[longtask]})", r.windowObj.__ltObserving === true && Array.isArray((r.windowObj.__ltOpts || {}).entryTypes) && r.windowObj.__ltOpts.entryTypes[0] === "longtask");
  const ltCbs = Array.isArray(r.windowObj.__ltCbs) ? r.windowObj.__ltCbs : [];
  let cbDriven = 0;
  // PerformanceObserver 回调收到的是 PerformanceObserverEntryList(带 getEntries 的对象),不是数组
  for (const cb of ltCbs) { try { cb({ getEntries: () => [{ startTime: Date.now(), duration: 137 }] }); cbDriven += 1; } catch (error) { /* 记录在断言里 */ } }
  const rec = (bootOf(r.sandbox).longTasks || []).find((x) => x.durationMs === 137);
  check("StartupPerfTest: 长任务条目入账(BOOT.longTasks 带阶段标注)", cbDriven > 0 && Boolean(rec) && typeof rec.stage === "string", JSON.stringify({ cbs: ltCbs.length, driven: cbDriven, got: (bootOf(r.sandbox).longTasks || []).slice(-2) }));
  check("BootOrderTest: 阶段时序 NAV < POSITIONS < ACCOUNT < MARKET < SCANNER", (() => {
    const log = b.stageLog || [];
    const endAt = (name) => { const e = log.find((x) => x.kind === "end" && x.name === name); return e ? e.at : null; };
    const nav = endAt("BOOT_NAV_READY"); const pos = endAt("BOOT_POSITIONS_READY"); const acc = endAt("BOOT_ACCOUNT_SUMMARY_READY"); const mkt = endAt("BOOT_MARKET_READY"); const scan = endAt("BOOT_SCANNER_READY");
    return nav != null && pos != null && acc != null && mkt != null && scan != null && nav <= pos && pos <= acc && acc < mkt && mkt < scan;
  })(), JSON.stringify((b.stageLog || []).filter((x) => x.kind === "end").map((x) => x.name + "@" + (x.at - b.started_at))));
  check("NavFirstTest: 导航绑定(可点)≤ 1000ms 且先于一切数据阶段", (t.BOOT_NAV_READY || {}).durationMs <= 1000, JSON.stringify(t.BOOT_NAV_READY));
  check("LazyDbTest: 全量历史在启动时未加载(懒加载标记 + 打开验证页才读)", (t.BOOT_DB_READY || {}).deferred === true, JSON.stringify(t.BOOT_DB_READY));
  check("IdleDeferTest: 启动刚完成时模型/学习/清理尚未执行(推迟到空闲)", (() => {
    const log = b.stageLog || [];
    const started = (name) => log.some((x) => x.kind === "begin" && x.name === name);
    return !started("BOOT_MODELS_READY") && !started("BOOT_LEARNING_READY") && !started("BOOT_RETENTION");
  })(), JSON.stringify((b.stageLog || []).map((x) => x.kind + ":" + x.name)));
  const ui = r.ui();
  check("RuntimeInstancesTest: 全实例计数 ≤1(引擎 + 8 个定时器 + 任务包)", Boolean(ui && typeof ui.instances === "object") && Object.values(ui.instances).every((v) => (typeof v === "boolean") || v <= 1), JSON.stringify(ui && ui.instances));
  // 等空闲兜底(1.5s)落位:模型/学习/清理最终必须执行
  await new Promise((resolve) => setTimeout(resolve, 1750));
  await r.flush(40);
  const b2 = bootOf(r.sandbox);
  check("IdleDeferTest: 空闲后模型/学习/清理均已落地执行(不丢任务)", ["BOOT_MODELS_READY", "BOOT_LEARNING_READY", "BOOT_RETENTION"].every((name) => (b2.timings || {})[name] || (b2.stageLog || []).some((x) => x.kind === "end" && x.name === name)), JSON.stringify((b2.stageLog || []).filter((x) => x.kind === "end" && /MODELS|LEARNING|RETENTION/.test(x.name)).map((x) => x.name)));
}
{
  // 行情永远挂起:四个 Tab 仍必须立即可切换(工单 §4)
  const r = await runVariant("hang-market", { device: false, lsSeed: DEVICE_LS, hangFetch: true });
  const switchLog = [];
  let ok = true;
  for (const p of ["market", "paper", "settings", "home"]) {
    await r.clickNav(p);
    const st = r.ui();
    const act = r.dom.pageSections.filter((s) => s.__classes.includes("active")).map((s) => s.id);
    switchLog.push(p + "=>" + (st ? st.currentPage : "null"));
    if (!st || st.currentPage !== p || act.join() !== "page-" + p) ok = false;
  }
  check("NavNeverWaitsMarketTest: 行情请求永不返回时四 Tab 仍立即切换", ok, switchLog.join(" | "));
  check("NavNeverWaitsMarketTest: 首页数据不依赖行情接口(本地账户照常)", hmText(r.dom, "hmEquity") === "100.00 USDT", hmText(r.dom, "hmEquity"));
}
{
  // 冷启动 ×10:每次立即连点四个 Tab(不等任何后台初始化)
  let alive = 0; let switched = 0; const problems = [];
  for (let k = 0; k < 10; k += 1) {
    const rr = await runVariant("cold-" + k, { device: true, lsSeed: DEVICE_LS, runtimeJson: null });
    const b = bootOf(rr.sandbox);
    const failed = (b.errors || []).some((e) => !/^storage_/.test(String(e.stage)));
    if (rr.syncErrors.length === 0 && !failed) alive += 1; else problems.push("boot" + k + ":" + (rr.syncErrors[0] || JSON.stringify((b.errors || []).slice(-1))));
    let ok = true;
    for (const p of ["market", "paper", "settings", "home"]) {
      await rr.clickNav(p);
      const st = rr.ui();
      if (!st || st.currentPage !== p) { ok = false; problems.push("switch" + k + "@" + p + ":" + (st ? st.currentPage : "no-ui")); }
    }
    if (ok) switched += 1;
  }
  check("ColdStart10Test: 10 次冷启动均存活且无 BOOT_FAILED", alive === 10, problems.join(" ; "));
  check("ColdStart10Test: 每次冷启动后立即连点四 Tab 全部切换成功", switched === 10, problems.join(" ; "));
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
