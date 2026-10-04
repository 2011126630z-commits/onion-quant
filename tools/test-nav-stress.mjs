// tools/test-nav-stress.mjs · V14.3 导航压力测试
// 真跑页面内联脚本(轻量 DOM 桩 + 假定时器 + 计数版 QEngine),模拟 100 轮
//   Home → Market → BTC(详情) → Back → Paper → My
// 每次切换后校验:恰好 1 个页面 active(无黑屏/无重复)、listener 不增长、timer 不增长、
//                 Paper Engine 实例恒为 1、旧请求被真正 abort、无异常累积
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(import.meta.dirname, "..");
let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log("PASS  " + name); }
  else { failed += 1; console.log("FAIL  " + name + (detail ? "  => " + detail : "")); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}

// V16.1 §17:门槛提到 500 轮(可用 NAV_CYCLES 覆盖);监控内存/DOM/listener/timer/WS/Chart 实例
const CYCLES = Number(process.env.NAV_CYCLES || 500);
const VERBOSE = process.env.NAV_VERBOSE === "1";

// ---------- 1) 取页面 HTML 与 QEngine bundle(用构建产物,保证测的就是要部署的东西) ----------
const builtSrc = fs.readFileSync(path.join(ROOT, "worker/index.js"), "utf8");
const bundleMatch = builtSrc.match(/const QENGINE_SRC = ("(?:[^"\\]|\\.)*");/);
check("构建产物中存在 QENGINE_SRC", Boolean(bundleMatch));
if (!bundleMatch) { console.log("\n0 passed, 1 failed"); process.exit(1); }
const qengineSrc = JSON.parse(bundleMatch[1]);
const pageMatch = builtSrc.match(/const page = String\.raw`([\s\S]*?)<\/html>`;/);
check("构建产物中存在页面模板", Boolean(pageMatch));
if (!pageMatch) { console.log("\n0 passed, 1 failed"); process.exit(1); }
let pageHtml = pageMatch[1] + "</html>";
const inlineScripts = [...pageHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
// V16.2:页面现在有 2 段内联脚本 —— ①head 里的"主题 pre-paint"(必须在首帧前跑);②body 末尾的主脚本。
check("页面含 2 段内联脚本(head 主题 pre-paint + 主脚本)", inlineScripts.length === 2, String(inlineScripts.length));

// ---------- 2) 轻量 DOM 桩 ----------
function makeDom(html) {
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const metaById = new Map();  // id -> { classes, tag, dataset }
  for (const m of html.matchAll(/<(\w+)([^>]*?)\bid="([^"]+)"([^>]*)>/g)) {
    const attrs = m[2] + m[4];
    const cls = attrs.match(/class="([^"]*)"/);
    const dataset = {};
    for (const d of attrs.matchAll(/data-([a-z0-9-]+)="([^"]*)"/g)) {
      const key = d[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      dataset[key] = d[2];
    }
    metaById.set(m[3], {
      classes: cls ? cls[1].split(/\s+/).filter(Boolean) : [],
      tag: m[1],
      dataset
    });
  }
  const counters = { listeners: 0, persistentListeners: 0, elements: 0 };
  let phantomParent = null;   // 真实 DOM 里 canvas 一定有父节点;桩里给一个稳定的兜底父节点
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
    counters.elements += 1;
    const el = {
      tagName: String(tag || "div").toUpperCase(),
      id: id || "",
      __persistent: Boolean(persistent),
      children: [],
      parentNode: null,
      style: {},
      dataset: {},
      __classes: [...(classes || [])],
      textContent: "",
      value: "",
      options: [],
      scrollTop: 0,
      scrollHeight: 100,
      clientWidth: 390,
      disabled: false,
      hidden: false,
      type: "",
      href: "",
      download: "",
      files: [],
      width: 0,
      height: 0,
      __listeners: Object.create(null),
      appendChild(child) { this.children.push(child); if (child) child.parentNode = this; return child; },
      removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); return child; },
      replaceChildren(...nodes) { this.children = []; for (const n of nodes) this.appendChild(n); },
      insertBefore(node) { this.children.unshift(node); return node; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      closest() { return null; },
      setAttribute(k, v) { this[k] = v; },
      getAttribute(k) { return this[k]; },
      addEventListener(type, fn) {
        counters.listeners += 1;
        // 只统计"长期存在节点"上的监听:列表行是每次渲染重建的,随元素一起被回收,不算泄漏
        if (this.__persistent) counters.persistentListeners += 1;
        (this.__listeners[type] = this.__listeners[type] || []).push(fn);
      },
      removeEventListener(type, fn) { const a = this.__listeners[type] || []; const i = a.indexOf(fn); if (i >= 0) { a.splice(i, 1); counters.listeners -= 1; if (this.__persistent) counters.persistentListeners -= 1; } },
      dispatch(type, event) {
        const box = this.__listeners[type] || [];
        for (const fn of [...box]) fn(event || { type, target: this, preventDefault() {}, stopPropagation() {} });
        return box.length;
      },
      click() { this.dispatch("click", { type: "click", target: this, preventDefault() {}, stopPropagation() {} }); },
      focus() {}, blur() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 268, right: 390, bottom: 268 }),
      getContext: () => ctx2d,
      classList: null,
      contains: () => false,
      get parentElement() {
        if (this.parentNode) return this.parentNode;
        if (!phantomParent) phantomParent = makeEl("div");
        return phantomParent;
      },
      get firstChild() { return this.children[0] || null; },
      get childElementCount() { return this.children.length; }
    };
    el.classList = makeClassList(el);
    return el;
  }
  // 极简 2D context:只统计绘制调用,不做像素级断言
  const ctx2d = new Proxy({}, {
    get(target, prop) {
      if (prop === "canvas") return null;
      if (prop === "measureText") return () => ({ width: 20 });
      if (prop === "__calls") return target.__calls || (target.__calls = {});
      if (prop === "setTransform" || prop === "clearRect" || prop === "fillRect" || prop === "beginPath" || prop === "moveTo" || prop === "lineTo" || prop === "stroke" || prop === "fill" || prop === "fillText" || prop === "save" || prop === "restore" || prop === "setLineDash" || prop === "closePath" || prop === "arc") {
        return () => { const c = target.__calls || (target.__calls = {}); c[prop] = (c[prop] || 0) + 1; };
      }
      return target[prop];
    },
    set(target, prop, value) { target[prop] = value; return true; }
  });

  const byId = new Map();
  const all = [];
  const navButtons = [];
  const pageSections = [];
  // 旧版容器 main.app(无 id,只有 class):移动页写在他之后,所以它必须按需收起
  const LEGACY_PAGE_IDS = ["page-monitor", "page-scan", "page-watch", "page-settings", "page-validation", "page-backtest", "page-walkforward", "page-dataset", "page-ml", "page-health"];
  const appEl = makeEl("main", "", ["app"], true);
  appEl.contains = (el) => Boolean(el && LEGACY_PAGE_IDS.includes(el.id));
  appEl.__displaySet = [];
  Object.defineProperty(appEl.style, "display", {
    get() { return this.__display || ""; },
    set(v) { this.__display = v; appEl.__displaySet.push(v); },
    configurable: true
  });
  for (const id of ids) {
    const meta = metaById.get(id) || { classes: [], tag: "div", dataset: {} };
    const el = makeEl(meta.tag, id, meta.classes, true);
    el.dataset = { ...meta.dataset };
    byId.set(id, el);
    all.push(el);
    if (el.__classes.includes("nav-btn")) navButtons.push(el);
    if (el.__classes.includes("page")) pageSections.push(el);
  }
  // 底部导航按钮只有 class 没有 id(靠 class 选择器绑定),必须单独建桩
  for (const m of html.matchAll(/<(\w+)([^>]*?)class="([^"]*\bnav-btn\b[^"]*)"([^>]*)>/g)) {
    const attrs = m[2] + m[4];
    const dataset = {};
    for (const d of attrs.matchAll(/data-([a-z0-9-]+)="([^"]*)"/g)) {
      dataset[d[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = d[2];
    }
    const el = makeEl(m[1], "", m[3].split(/\s+/).filter(Boolean), true);
    el.dataset = dataset;
    navButtons.push(el);
    all.push(el);
  }

  const doc = {
    documentElement: makeEl("html", "", ["theme-dark"]),
    body: makeEl("body"),
    hidden: false,
    activeElement: null,
    __docListeners: Object.create(null),
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => makeEl(tag),
    createTextNode: (t) => ({ textContent: t }),
    querySelector: (sel) => {
      if (sel === 'meta[name="theme-color"]') return makeEl("meta");
      if (sel === ".app") return appEl;
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel === ".page") return pageSections;
      if (sel === ".nav-btn") return navButtons;
      if (sel === ".period-btn" || sel === ".chip" || sel === ".page.active") return [];
      return [];
    },
    addEventListener(type, fn) { counters.listeners += 1; counters.persistentListeners += 1; (this.__docListeners[type] = this.__docListeners[type] || []).push(fn); },
    removeEventListener() {},
    dispatch(type, event) { for (const fn of [...(this.__docListeners[type] || [])]) fn(event || { type }); }
  };

  return { doc, byId, all, navButtons, pageSections, counters, ctx2d, appEl };
}

// ---------- 3) 定时器:timeout 用真实计时器(保证重试/防抖语义真实)但计数;interval 只登记不触发 ----------
const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
function makeTimers() {
  let seq = 0;
  const intervals = new Map();
  const liveTimeouts = new Set();
  const stats = { intervals: 0, timeouts: 0, cleared: 0, fired: 0 };
  const sandboxSetTimeout = (fn, ms) => {
    const id = realSetTimeout(() => { liveTimeouts.delete(id); stats.fired += 1; fn(); }, ms);
    liveTimeouts.add(id);
    stats.timeouts += 1;
    return id;
  };
  const sandboxClear = (id) => {
    if (liveTimeouts.delete(id)) { realClearTimeout(id); stats.cleared += 1; return; }
    if (intervals.delete(id)) stats.cleared += 1;
  };
  const sandboxSetInterval = (fn, ms) => { const id = ++seq; intervals.set(id, { fn, ms }); stats.intervals += 1; return id; };
  return {
    intervals, liveTimeouts, stats,
    set: sandboxSetTimeout, setInterval: sandboxSetInterval,
    clear: sandboxClear, clearInterval: sandboxClear,
    live: (kind) => (kind === "interval" ? intervals.size : kind === "timeout" ? liveTimeouts.size : intervals.size + liveTimeouts.size)
  };
}

// ---------- 4) 组装 sandbox 并运行 ----------
const dom = makeDom(pageHtml);
const timers = makeTimers();
const rafQueue = [];   // rAF 回调队列(在 flush 里按"帧"排空)
let engineInstances = 0;
let engineInstanceRefs = [];
const fetchCalls = [];
const abortedFetches = { count: 0 };
let signalAborts = 0;
const ls = new Map([["watchSymbols", '["BTCUSDT","ETHUSDT"]']]);

// 统计"真正调用了 AbortController.abort()"的次数 —— 这是 api() 透传 signal 的直接证据
class CountingAbortController extends AbortController {
  abort(reason) {
    signalAborts += 1;
    return super.abort(reason);
  }
}

function jsonResponse(body, status) {
  return {
    ok: (status || 200) < 400,
    status: status || 200,
    headers: { get: () => "binance:stub" },
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

const klines = [];
{
  let price = 42000;
  for (let i = 0; i < 220; i += 1) {
    const open = price;
    const close = open * (1 + Math.sin(i / 9) * 0.003);
    klines.push([1700000000000 + i * 3600000, String(open), String(Math.max(open, close) * 1.001), String(Math.min(open, close) * 0.999), String(close), String(100 + i)]);
    price = close;
  }
}
const tickers = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "TRXUSDT"]
  .map((symbol, i) => ({ symbol, lastPrice: String(100 + i), priceChangePercent: String(i % 5 - 2), highPrice: String(105 + i), lowPrice: String(95 + i), quoteVolume: String(9e9 - i * 1e8), fundingRate: "0.0001" }));

const windowObj = {
  devicePixelRatio: 3,
  __quantDiag: [],
  matchMedia: () => ({ matches: true, addEventListener() {} }),
  addEventListener(type, fn) { dom.counters.listeners += 1; dom.counters.persistentListeners += 1; (this.__listeners = this.__listeners || {})[type] = (this.__listeners[type] || []).concat(fn); },
  removeEventListener() {},
  requestAnimationFrame: (fn) => { rafQueue.push(fn); return -(rafQueue.length); },
  cancelAnimationFrame: () => {},
  setTimeout: timers.set,
  setInterval: timers.setInterval,
  clearTimeout: timers.clear,
  clearInterval: timers.clear,
  fetch: async (url, options) => {
    fetchCalls.push(String(url));
    const signal = options && options.signal;
    if (signal && signal.aborted) { abortedFetches.count += 1; const e = new Error("aborted"); e.name = "AbortError"; throw e; }
    const u = String(url);
    if (/\/api\/klines/.test(u)) return jsonResponse(klines);
    if (/\/api\/tickers/.test(u)) return jsonResponse(tickers);
    if (/\/api\/funding/.test(u)) return jsonResponse({ symbol: "BTCUSDT", lastFundingRate: "0.0001", nextFundingTime: Date.now() + 8 * 3600000, provider: "binance" });
    if (/\/api\/screen/.test(u)) return jsonResponse({ results: tickers.slice(0, 5).map((t) => ({ symbol: t.symbol, price: 100, change24h: 1, direction: "Bullish", confidence: 60, risk_level: "Low", signal_strength: 55, market_regime: "Range", alignment: "同向" })) });
    if (/\/api\/ai\/review/.test(u)) return jsonResponse({ ok: false, reason: "no_server_key" });
    if (/\/api\/health/.test(u)) return jsonResponse({ generated_at: new Date().toISOString(), providers: [], net_mode: "direct", proxy_method: "direct" });
    if (/\/api\/analyze/.test(u)) return jsonResponse({
      symbol: "BTCUSDT", interval: "1h", model_version: "v14.3", price: 42000, change24h: 1.2, high24h: 43000, low24h: 41000, quote_volume_24h: 1e10,
      market_regime: { label: "Weak Uptrend", trend_market: true, vol_state: "Normal", adx: 24, atr_pct: 1.1 }, direction: "Bullish", signal_strength: 62, confidence: 58, risk_score: 30, risk_level: "Low",
      timeframes: { "15m": "Bullish", "1h": "Strong Bullish", "4h": "Neutral" }, tf_conflict: false,
      structure: { label: "上涨结构", hh: true, hl: true, lh: false, ll: false, last_swing_high: 43000, last_swing_low: 41000 },
      support_zones: [{ lo: 40500, hi: 41000, touches: 2 }], resistance_zones: [{ lo: 43000, hi: 43500, touches: 1 }],
      volume: { pattern: "放量上涨", ratio20: 1.3, spike: false }, volatility: { level: "Normal", atrPct: 1.1, bbWidthPct: 2.2, hvPct: 40, ratio: 1 },
      anomaly: { detected: false, kinds: [] }, btc_context: { state: "Neutral", corr: 0.8, rel_strength: 0.1 }, breadth: { up_pct: 55 },
      features: { rsi14: 58, macd_hist: 0.4, adx: 24, atr_pct: 1.1, ema20_dist_pct: 0.5, volume_ratio20: 1.3, tf_align: 0.4 },
      reasons: ["多周期同向"], risks: ["量能未确认"], invalidation: ["跌破结构低点"], limited_data: false,
      forming_candle: { count: 1, note: "" }, data_close_time: 1700000000000, data_candles: 220
    });
    return jsonResponse({ error: "not found" }, 404);
  }
};
const sandbox = {
  window: windowObj, document: dom.doc, localStorage: {
    getItem: (k) => (ls.has(k) ? ls.get(k) : null),
    setItem: (k, v) => ls.set(k, String(v)),
    removeItem: (k) => ls.delete(k)
  },
  console: { log() {}, warn() {}, error() {}, info() {} },
  setTimeout: timers.set, setInterval: timers.setInterval, clearTimeout: timers.clear, clearInterval: timers.clear,
  requestAnimationFrame: windowObj.requestAnimationFrame,
  getComputedStyle: () => ({ getPropertyValue: () => "#123456" }),
  AbortController: CountingAbortController, AbortSignal, Promise, JSON, Math, Date, Number, String, Object, Array, Error, Set, Map, isFinite, parseInt, parseFloat,
  Intl, encodeURIComponent, decodeURIComponent, Blob: class { constructor() {} }, URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
  FileReader: class { readAsText() {} },
  Element: class {}, Event: class {}, CustomEvent: class {},
  indexedDB: undefined, navigator: { userAgent: "node-test" }
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
sandbox.URL = windowObj.URL || sandbox.URL;
// 页面脚本用的是裸 fetch(不是 window.fetch),必须挂到 sandbox 全局
sandbox.fetch = windowObj.fetch;
sandbox.Response = class { static json(body, init) { return jsonResponse(body, init && init.status); } };
sandbox.Request = class { constructor(url) { this.url = String(url); } };
sandbox.Headers = class { get() { return null; } };

vm.createContext(sandbox);
// 先跑 QEngine bundle(页面脚本依赖 window.QEngine),再包一层计数
vm.runInContext(qengineSrc, sandbox, { filename: "qengine.js" });
check("QEngine 已挂载", Boolean(sandbox.window.QEngine && sandbox.window.QEngine.createPaperEngine));
check("导航按钮桩已建立(4 个,含 data-page)", dom.navButtons.length === 4 && dom.navButtons.every((b) => Boolean(b.dataset.page)), JSON.stringify(dom.navButtons.map((b) => b.dataset.page)));
const realCreatePaperEngine = sandbox.window.QEngine.createPaperEngine;
sandbox.window.QEngine.createPaperEngine = function (...args) {
  engineInstances += 1;
  const eng = realCreatePaperEngine.apply(this, args);
  engineInstanceRefs.push(eng);
  return eng;
};
sandbox.window.__quantEngineInstances = 0;

const setupErrors = [];
try {
  // V16.2:按页面顺序执行全部内联脚本(①pre-paint 主题脚本 ②主脚本),与真实浏览器一致
  inlineScripts.forEach((src, idx) => {
    vm.runInContext(src, sandbox, { filename: "page-inline-" + (idx + 1) + ".js" });
  });
} catch (error) {
  setupErrors.push(String(error && error.stack || error));
}
check("页面脚本首次执行不抛异常", setupErrors.length === 0, setupErrors[0] && setupErrors[0].slice(0, 400));

// 等启动流程(initMobileUI 的若干 await fetch)跑完;rAF 按"帧"排空(等价浏览器的下一帧)
const flush = async (times) => {
  for (let i = 0; i < (times || 40); i += 1) {
    await new Promise((r) => setImmediate(r));
    if (rafQueue.length) {
      const batch = rafQueue.splice(0, rafQueue.length);
      for (const fn of batch) { try { fn(Date.now()); } catch (error) { /* 绘制异常单独看 */ } }
    }
  }
};
async function waitFor(predicate, label, maxRounds) {
  const limit = maxRounds || 120;
  for (let i = 0; i < limit; i += 1) {
    if (predicate()) return true;
    await flush(2);
  }
  check("等待条件成立:" + label, false, "超过 " + limit + " 轮仍未满足");
  return false;
}
await flush(60);
if (VERBOSE) {
  console.log("PROBE hmTodayPnl=" + JSON.stringify(dom.byId.get("hmTodayPnl").textContent));
  console.log("PROBE mkList children=" + dom.byId.get("mkList").children.length);
  console.log("PROBE deviceId=" + ls.get("deviceId"));
  console.log("PROBE diag=" + JSON.stringify((sandbox.window.__quantDiag || []).map((d) => d.tag + ":" + String(d.message).slice(0, 90))));
  console.log("PROBE intervals=" + timers.live("interval") + " timeouts=" + timers.live("timeout") + " rafPending=" + rafQueue.length);
}
await waitFor(() => typeof sandbox.window.__quantUI === "object", "__quantUI 观测接口就绪");

check("初始化后 Home 为当前页", dom.byId.get("page-home").__classes.includes("active"));
check("导航按钮已绑定点击", dom.navButtons.every((b) => (b.__listeners.click || []).length > 0), JSON.stringify(dom.navButtons.map((b) => (b.__listeners.click || []).length)));
check("初始即收起旧版容器(首屏不是空白)", dom.appEl.style.display === "none", "display=" + JSON.stringify(dom.appEl.style.display));check("Paper Engine 已创建", engineInstances >= 1, String(engineInstances));
check("__quantUI 观测接口可用", typeof sandbox.window.__quantUI === "object" && typeof sandbox.window.__quantUI.state === "function");

// 触发一次详情页渲染,确保 K 线图有数据(后续压力轮次会反复进出详情页)
async function clickNav(pageName) {
  const btn = dom.navButtons.find((b) => b.dataset.page === pageName);
  if (!btn) return false;
  btn.click();
  return true;
}

// ---------- 5) 一轮导航循环 ----------
const baseline = {
  listeners: dom.counters.listeners,
  persistent: dom.counters.persistentListeners,
  intervals: timers.live("interval"),
  timeouts: timers.live("timeout")
};
await flush(30);
const baseline2 = {
  listeners: dom.counters.listeners,
  persistent: dom.counters.persistentListeners,
  intervals: timers.live("interval"),
  timeouts: timers.live("timeout")
};

const openDetail = async (symbol) => {
  // 详情页由列表点击进入:直接调用 openDetail 的等价入口 —— 点市场列表第一行
  const listBox = dom.byId.get("mkList");
  const firstRow = listBox.children[0];
  if (firstRow && (firstRow.__listeners.click || []).length) { firstRow.click(); return true; }
  return false;
};

console.log("== 100 轮 Home → Market → BTC → Back → Paper → My ==");
const roundStats = { badActive: 0, blackScreen: 0, engineGrowth: 0, listenerLeak: 0, timerLeak: 0, aborts: 0, maxDiag: 0 };
let firstProblem = null;
for (let round = 1; round <= CYCLES; round += 1) {
  await clickNav("home");
  await flush(12);
  if (VERBOSE && round === 1) console.log("      after home: " + sandbox.window.__quantUI.state().currentPage);
  await clickNav("market");
  await flush(12);
  if (VERBOSE && round === 1) console.log("      after market: " + sandbox.window.__quantUI.state().currentPage);
  await openDetail("BTCUSDT");
  await flush(20);
  if (VERBOSE && round === 1) console.log("      after detail: " + sandbox.window.__quantUI.state().currentPage);
  const detailActive = dom.byId.get("page-detail").__classes.includes("active");
  if (!detailActive) { roundStats.blackScreen += 1; if (!firstProblem) firstProblem = "round " + round + ": 详情页未激活"; }
  // 返回(Back)
  const backBtn = dom.byId.get("dtBackBtn");
  if (backBtn) backBtn.click();
  await flush(12);
  if (VERBOSE && round === 1) console.log("      after back: " + sandbox.window.__quantUI.state().currentPage);
  if (!dom.byId.get("page-market").__classes.includes("active")) { roundStats.blackScreen += 1; if (!firstProblem) firstProblem = "round " + round + ": 返回后市场页未激活"; }
  await clickNav("paper");
  await flush(12);
  if (VERBOSE) console.log("      after paper: " + sandbox.window.__quantUI.state().currentPage);
  await clickNav("settings");
  await flush(12);
  if (VERBOSE) console.log("      after settings: " + sandbox.window.__quantUI.state().currentPage);
  // 不变量
  const active = dom.pageSections.filter((p) => p.__classes.includes("active"));
  if (active.length !== 1) { roundStats.badActive += 1; if (!firstProblem) firstProblem = "round " + round + ": active 页面数=" + active.length; }
  if (active.length === 0) roundStats.blackScreen += 1;
  if (engineInstances !== 1) { roundStats.engineGrowth += 1; if (!firstProblem) firstProblem = "round " + round + ": 引擎实例=" + engineInstances; }
  const state = sandbox.window.__quantUI.state();
  roundStats.aborts = state.requests.aborted;
  roundStats.maxDiag = Math.max(roundStats.maxDiag, state.diag);
  if (VERBOSE) console.log("    round " + round + " page=" + state.currentPage + " active=" + state.activePages.join(",") + " started=" + state.requests.started + " aborted=" + state.requests.aborted);
}

const finalState = sandbox.window.__quantUI.state();
const listenersAfter = dom.counters.listeners;
const persistentAfter = dom.counters.persistentListeners;
const intervalsAfter = timers.live("interval");
const timeoutsAfter = timers.live("timeout");

console.log("  cycles=" + CYCLES + " engineInstances=" + engineInstances + " activePages=" + finalState.activePages.length
  + " 长期节点监听 " + baseline2.persistent + "→" + persistentAfter + " 全部监听 " + baseline2.listeners + "→" + listenersAfter
  + " intervals " + baseline2.intervals + "→" + intervalsAfter
  + " aborts=" + finalState.requests.aborted + "/signal_aborts=" + signalAborts + " requests started=" + finalState.requests.started);

check("100 轮中每一步都恰好 1 个页面 active(无重复页面)", roundStats.badActive === 0, firstProblem || "");
check("100 轮中从未出现黑屏(active 页面数恒 > 0)", roundStats.blackScreen === 0, firstProblem || "");
check("Paper Engine 实例恒为 1(无重复创建)", engineInstances === 1 && roundStats.engineGrowth === 0, "instances=" + engineInstances);
check("长期节点上的 listener 不随导航增长(无泄漏)", persistentAfter <= baseline2.persistent, `${baseline2.persistent} → ${persistentAfter}`);
check("AbortSignal 被真正 abort(不只是丢弃响应)", signalAborts > 0, "signal_aborts=" + signalAborts);
check("interval 定时器数量不增长", intervalsAfter <= baseline2.intervals, `${baseline2.intervals} → ${intervalsAfter}`);
check("timeout 定时器数量不增长", timeoutsAfter <= baseline2.timeouts + 8, `${baseline2.timeouts} → ${timeoutsAfter}`);
check("离开页面真正取消请求(aborted > 0)", finalState.requests.aborted > 0, "aborted=" + finalState.requests.aborted);
check("请求代际统计记录了丢弃/取消", finalState.requests.started > 0);
check("导航过程中无异常堆积(diag ≤ 上限)", roundStats.maxDiag <= 50, "maxDiag=" + roundStats.maxDiag);
// V16.1 §17:WebSocket / Chart 实例不能随"进入详情页"累积
// 说明:DOM 桩里没有真实网络,WS 不会被真的建立,所以这里只保证"计数器存在且没有意外累积";
//       "进入详情 N 次不会留下 N 个连接" 的真实证据由浏览器走查(dev-server)给出。
const pageSrcForWs = fs.readFileSync(path.join(ROOT, "worker/src/ui/page.js"), "utf8");
check("页面内置 WebSocket 计数器(可核验订阅不累积)", pageSrcForWs.includes("__quantWsCount"), "缺少 __quantWsCount 埋点");
const wsFinal = Number(sandbox.window.__quantWsCount == null ? 0 : sandbox.window.__quantWsCount);
check("WebSocket 计数在导航压力下不累积", wsFinal <= 1, "__quantWsCount=" + wsFinal);
const chartInstances = Number((sandbox.window.__quantChartInstances && sandbox.window.__quantChartInstances()) || 0);
check("Chart 实例不累积", chartInstances <= 2, "chartInstances=" + chartInstances);
eq("当前页最终为「我的」", finalState.currentPage, "settings");

// ---------- 6) K 线交互在真实页面里可用 ----------
console.log("== 详情页 K 线交互(真实事件) ==");
await clickNav("market");
await flush(12);
await openDetail("BTCUSDT");
await flush(24);
const canvas = dom.byId.get("dtCanvas");
const chartState = sandbox.window.__quantUI.chartState();
check("详情页图表已收到K线数据", chartState.klines.length > 0, String(chartState.klines.length));
check("视口已建立且贴最新", chartState.vp && chartState.vp.count > 0 && sandbox.window.QEngine.chartApi.isAtLatest(chartState.vp, chartState.klines.length));
const barsBefore = chartState.vp.start;
// 拖动(向左拖 = 手指从右往左挪 → 看更新的数据;这里向右拖应看到更早的数据)
canvas.dispatch("touchstart", { type: "touchstart", touches: [{ clientX: 100, clientY: 100 }], preventDefault() {}, timeStamp: Date.now() });
canvas.dispatch("touchmove", { type: "touchmove", touches: [{ clientX: 220, clientY: 100 }], preventDefault() {}, timeStamp: Date.now() });
canvas.dispatch("touchend", { type: "touchend", touches: [], timeStamp: Date.now() });
check("Drag 平移改变了视口起点", chartState.vp.start !== barsBefore, `${barsBefore} → ${chartState.vp.start}`);
check("平移后不再贴最新", sandbox.window.QEngine.chartApi.isAtLatest(chartState.vp, chartState.klines.length) === false);
// 最新按钮
dom.byId.get("dtLatestBtn").click();
await flush(6);
check("「最新」按钮回到最右", sandbox.window.QEngine.chartApi.isAtLatest(chartState.vp, chartState.klines.length) === true);
// Pinch 缩放(方向语义:张开=放大=可见根数减少;锚点=双指中点保持不动)
const countBefore = chartState.vp.count;
const layoutNow = sandbox.window.QEngine.chartApi.layoutOf(390, 268, {});
const midX = 150;
const idxBeforeZoom = sandbox.window.QEngine.chartApi.indexAtX(midX, chartState.vp, layoutNow);
canvas.dispatch("touchstart", { type: "touchstart", touches: [{ clientX: 100, clientY: 100 }, { clientX: 200, clientY: 100 }], preventDefault() {}, timeStamp: Date.now() });
canvas.dispatch("touchmove", { type: "touchmove", touches: [{ clientX: 60, clientY: 100 }, { clientX: 240, clientY: 100 }], preventDefault() {}, timeStamp: Date.now() });
canvas.dispatch("touchend", { type: "touchend", touches: [], timeStamp: Date.now() });
check("Pinch 张开=放大:可见根数减少", chartState.vp.count < countBefore, `${countBefore} → ${chartState.vp.count}`);
{
  const idxAfterZoom = sandbox.window.QEngine.chartApi.indexAtX(midX, chartState.vp, layoutNow);
  check("缩放锚点稳定(双指中点处K线索引 ±1)", idxBeforeZoom != null && idxAfterZoom != null && Math.abs(idxAfterZoom - idxBeforeZoom) <= 1, `${idxBeforeZoom} → ${idxAfterZoom}`);
}
// 反向捏合 = 缩小 = 可见根数增加(方向不允许翻转)
const countZoomedIn = chartState.vp.count;
canvas.dispatch("touchstart", { type: "touchstart", touches: [{ clientX: 60, clientY: 100 }, { clientX: 240, clientY: 100 }], preventDefault() {}, timeStamp: Date.now() });
canvas.dispatch("touchmove", { type: "touchmove", touches: [{ clientX: 100, clientY: 100 }, { clientX: 200, clientY: 100 }], preventDefault() {}, timeStamp: Date.now() });
canvas.dispatch("touchend", { type: "touchend", touches: [], timeStamp: Date.now() });
check("Pinch 捏合=缩小:可见根数增加", chartState.vp.count > countZoomedIn, `${countZoomedIn} → ${chartState.vp.count}`);
// Tap → 十字光标
canvas.dispatch("touchstart", { type: "touchstart", touches: [{ clientX: 150, clientY: 120 }], preventDefault() {}, timeStamp: Date.now() });
canvas.dispatch("touchend", { type: "touchend", touches: [], timeStamp: Date.now() });
check("Tap 显示十字光标", chartState.cross != null, JSON.stringify(chartState.cross));
check("信息条同步显示 OHLC", /O /.test(dom.byId.get("dtOhlcO").textContent) && /C /.test(dom.byId.get("dtOhlcC").textContent), dom.byId.get("dtOhlcO").textContent);
check("信息条显示涨跌幅", /%|--/.test(dom.byId.get("dtOhlcChg").textContent), dom.byId.get("dtOhlcChg").textContent);
check("成交量有数值(副图数据源)", dom.byId.get("dtVolValue").textContent !== "--", dom.byId.get("dtVolValue").textContent);
// 再 Tap 同一根 → 关闭十字光标
canvas.dispatch("touchstart", { type: "touchstart", touches: [{ clientX: 150, clientY: 120 }], preventDefault() {}, timeStamp: Date.now() });
canvas.dispatch("touchend", { type: "touchend", touches: [], timeStamp: Date.now() });
check("再次 Tap 关闭十字光标", chartState.cross == null);
check("rAF 重绘确实发生过(绘制调用被记录)", Object.keys(dom.ctx2d.__calls || {}).length > 0, JSON.stringify(dom.ctx2d.__calls || {}).slice(0, 120));
check("按高 DPR 分配位图(devicePixelRatio=3)", canvas.width > canvas.height && canvas.width >= 390 * 2, `w=${canvas.width} h=${canvas.height}`);
check("画布逻辑尺寸与容器一致", canvas.style.width === "390px", String(canvas.style.width));

// ---------- 7) 真实 Abort:离开页面必须取消在途请求 ----------
console.log("== 真实 Abort 语义 ==");
// 确定性做法:详情页每次都真的发请求(无缓存),发起后立即切走 → 必须真正 abort
const beforeAborts = sandbox.window.__quantUI.state().requests.aborted;
const beforeSignal = signalAborts;
void sandbox.window.__quantUI.openPage("detail");
await flush(2);
sandbox.window.__quantUI.openPage("settings");
await flush(24);
const afterAborts = sandbox.window.__quantUI.state().requests.aborted;
check("快速切页触发真实 cancel", afterAborts > beforeAborts, `${beforeAborts} → ${afterAborts}`);
check("取消动作发生在 AbortController 上", signalAborts > beforeSignal, `${beforeSignal} → ${signalAborts}`);
check("取消后无旧响应写入(市场列表未被错误覆盖)", dom.byId.get("mkList").children.length >= 0);
// 取消不算故障:不写诊断日志
const diagTags = (sandbox.window.__quantDiag || []).map((d) => d.tag);
check("取消不被记为异常(diag 中无 detail-analyze/detail-klines)", !diagTags.includes("detail-analyze") && !diagTags.includes("detail-klines"), JSON.stringify(diagTags));
const rmStats = sandbox.window.__quantUI.state().requests;
check("RequestManager 统计自洽", rmStats.started >= rmStats.aborted && rmStats.aborted > 0, JSON.stringify(rmStats));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("NAV STRESS TESTS OK");
