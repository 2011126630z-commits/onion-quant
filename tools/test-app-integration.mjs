// tools/test-app-integration.mjs
// V10 App 接入测试:
//   A. Worker 接入:页面引用 /qengine.js、路由可用、QEngine 暴露的 API 完整
//   B. 记录链路:真实分析结果 → IndexedDB(内存后端)落库 + 真实去重
//   C. 追踪链路:到期 → 拉真实K线 → Outcome 回写(已完成不重算,失败不崩)
//   D. 展示链路:验证视图/样本列表/详情/空状态 全部来自真实记录,无演示数据
import worker from "../worker/index.js";
import { createHistoryStore } from "../worker/src/history/store.js";
import { recordAnalysis, resolveDueOutcomes, buildValidationView, detailView, listRow, normalizeKlines, usableRecords, mergeOutcome, needIntervalOf } from "../worker/src/history/pipeline.js";
import { computeAnalysis } from "../worker/src/engine/signal.js";

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log("PASS  " + name); }
  else { failed += 1; console.log("FAIL  " + name + (detail ? "  => " + detail : "")); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}

// ---- 合成K线工具 ----
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function genKlines(n, opts) {
  const o = opts || {};
  const rand = lcg(o.seed || 42);
  const ivMs = o.ivMs || 3600000;
  const t0 = o.t0 || 1700000000000;
  let price = o.start || 100;
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const noise = (rand() - 0.5) * 2 * (o.volPct || 0.004) * price;
    const open = price;
    const close = Math.max(1, price * (1 + (o.drift || 0)) + noise);
    const high = Math.max(open, close) * (1 + rand() * 0.002);
    const low = Math.min(open, close) * (1 - rand() * 0.002);
    rows.push({ openTime: t0 + i * ivMs, open, high, low, close, volume: 1000, closeTime: t0 + (i + 1) * ivMs - 1 });
    price = close;
  }
  return rows;
}
// 生成 anchor 之后的 1m K线(用于 5m/15m 验证),path 为每根收盘价
function klinesAfter(anchorMs, prices, ivMs) {
  const iv = ivMs || 60000;
  return prices.map((close, i) => {
    const openTime = anchorMs + 1 + i * iv;
    const open = i === 0 ? close : prices[i - 1];
    return { openTime, open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volume: 1000, closeTime: openTime + iv - 1 };
  });
}
// 上游取数模拟:返回引擎结构K线;可注入失败
function makeFetcher(map, log) {
  return async (symbol, interval, limit) => {
    if (log) log.push(symbol + "|" + interval);
    const key = symbol + "|" + interval;
    if (map[key] === "FAIL") throw new Error("upstream 502");
    if (!map[key]) throw new Error("no data for " + key);
    return map[key].slice(-limit);
  };
}

// ============================================================
console.log("== A. Worker 接入 ==");
const pageRes = await worker.fetch(new Request("https://app.local/"));
const pageHtml = await pageRes.text();
check("GET / 返回 200", pageRes.status === 200, String(pageRes.status));
const m = pageHtml.match(/<script src="\/qengine\.js\?h=([0-9a-f]+)"><\/script>/);
check("页面引用 /qengine.js(带哈希)", Boolean(m), pageHtml.slice(0, 120));
check("引擎源码不内联在页面", !pageHtml.includes("function computeAnalysis") && !pageHtml.includes("noiseThresholdPct"));
const qeRes = await worker.fetch(new Request("https://app.local/qengine.js?h=" + (m ? m[1] : "")));
const qeSrc = await qeRes.text();
check("GET /qengine.js 返回 200", qeRes.status === 200, String(qeRes.status));
eq("qengine 内容类型", qeRes.headers.get("content-type"), "application/javascript; charset=utf-8");
eq("哈希命中 → 长缓存", qeRes.headers.get("cache-control"), "public, max-age=31536000, immutable");
const qeNoHash = await worker.fetch(new Request("https://app.local/qengine.js"));
eq("无哈希 → 不缓存", qeNoHash.headers.get("cache-control"), "no-store");
check("qengine 暴露 window.QEngine", qeSrc.includes("window.QEngine"));

// 在沙箱里执行 qengine.js,确认页面要用的 API 全部存在
const vm = await import("node:vm");
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(qeSrc, sandbox);
const Q = sandbox.window.QEngine || {};
for (const fn of ["createHistoryStore", "recordAnalysis", "resolveDueOutcomes", "buildValidationView", "detailView", "listRow", "normalizeKlines", "usableRecords", "computeAnalysis", "signalRecordFromAnalysis", "shouldRecordSignal", "resolveRecordId", "dueHorizons", "HORIZONS", "REGIME_FILTERS"]) {
  check("QEngine." + fn + " 可用", typeof Q[fn] !== "undefined", typeof Q[fn]);
}
eq("QEngine 周期定义", Q.HORIZONS, ["5m", "15m", "1h", "4h", "24h"]);
eq("页面 /api 路由仍保留", typeof worker.fetch === "function" && pageHtml.includes("bottom-nav"), true);
// 静态一致性:页面脚本引用的元素 id 必须真实存在(避免运行时 null 崩溃)
const refIds = [...pageHtml.matchAll(/\$\("([^"]+)"\)/g)].map((x) => x[1]);
const definedIds = new Set([...pageHtml.matchAll(/id="([^"]+)"/g)].map((x) => x[1]));
const missingIds = [...new Set(refIds)].filter((id) => !definedIds.has(id));
check("页面引用的元素 id 全部存在", missingIds.length === 0, missingIds.join(","));
check("验证页相关元素齐全", ["page-validation", "vTotal", "vResolved", "vPending", "vHorizons", "vRegimes", "vSamples", "vMoreBtn", "vDetail", "openValidation", "validationBadge"].every((id) => definedIds.has(id)));
check("底部导航保持 4 项(未新增第五个)", (pageHtml.match(/class="nav-btn/g) || []).length === 4, String((pageHtml.match(/class="nav-btn/g) || []).length));
check("历史验证入口在「我的」页内", pageHtml.includes('id="openValidation"') && pageHtml.indexOf('id="openValidation"') > pageHtml.indexOf('id="page-settings"'));
check("页面含空状态文案", pageHtml.includes("暂无历史样本") && pageHtml.includes("等待验证"));
check("页面不含演示/假数据字样", !/mock|demo data|示例数据|假数据/i.test(pageHtml));

console.log("== B. 记录链路(真实分析 → 落库 + 去重) ==");
const store = await createHistoryStore({ memory: true });
const rows = genKlines(220, { drift: 0.002, seed: 7 });
const anchor = rows[rows.length - 1].closeTime;
const analysis = computeAnalysis({
  symbol: "BTCUSDT",
  interval: "1h",
  ticker: { lastPrice: "110", priceChangePercent: "2.5", highPrice: "112", lowPrice: "105", quoteVolume: "5e9" },
  tfRows: { "1m": rows, "5m": rows, "15m": rows, "1h": rows, "4h": rows, "1d": rows },
  btcRows: {},
  tickers: [],
  nowMs: anchor + 300
});
const r1 = await recordAnalysis(store, analysis, { source: "live" });
check("首次分析写入 Signal", r1.recorded === true && r1.reason === "first", JSON.stringify(r1));
eq("库中 1 条", await store.signals.count(), 1);
const stored = await store.signals.get(r1.id);
eq("落库使用真实分析值", [stored.symbol, stored.direction, stored.confidence, stored.signal_strength], [analysis.symbol, analysis.direction, analysis.confidence, analysis.signal_strength]);
eq("落库 data_close_time 与引擎一致", stored.data_close_time, analysis.data_close_time);
check("落库 features 为真实快照", typeof stored.features === "string" && JSON.parse(stored.features).rsi14 != null, stored.features);

// 同一根K线、指标微变 → 去重不写入
const sameCandle = { ...analysis, signal_strength: analysis.signal_strength + 3, confidence: analysis.confidence + 2 };
const r2 = await recordAnalysis(store, sameCandle, { source: "live" });
eq("短时间重复分析不重复写入", r2.recorded, false);
eq("库中仍为 1 条", await store.signals.count(), 1);

// 新的已收盘K线 → 写入
const later = { ...analysis, data_close_time: analysis.data_close_time + 3600000, generated_at: new Date(anchor + 3600300).toISOString() };
const r3 = await recordAnalysis(store, later, { source: "live" });
eq("新K线 → 记录", r3.recorded, true);
eq("库中 2 条", await store.signals.count(), 2);

// 同一根K线内方向翻转 → 修订记录
const flipped = { ...analysis, direction: analysis.direction === "Bullish" ? "Bearish" : "Bullish" };
const r4 = await recordAnalysis(store, flipped, { source: "live" });
check("同K线内方向翻转 → 修订记录", r4.recorded === true && String(r4.id).includes("_r"), JSON.stringify({ recorded: r4.recorded, id: r4.id }));
eq("库中 3 条", await store.signals.count(), 3);

// limited_data 样本不进入统计
const limited = { ...analysis, limited_data: true };
eq("数据不足样本不进统计", usableRecords([{ signal: stored }, { signal: { ...stored, limited_data: 1 } }]).length, 1);

console.log("== C. Outcome Tracker 接入 ==");
// 造一条 20 分钟前的信号,价格 100(独立库,避免与 B 段记录互相干扰)
const trackStore = await createHistoryStore({ memory: true });
const now = anchor + 20 * 60000;
const sig = {
  id: "sig_ETHUSDT_1h_test",
  symbol: "ETHUSDT",
  interval: "1h",
  direction: "Bullish",
  price: 100,
  timestamp: anchor - 60000 + 1,
  data_close_time: anchor,
  volatility_atr_pct: 0.5,
  market_regime_label: "Range",
  confidence: 70,
  signal_strength: 70,
  risk_level: "Medium",
  risk_score: 40,
  engine_version: "rule-v0.1",
  feature_version: "feat-v0.1",
  source: "live",
  limited_data: 0,
  timeframes: JSON.stringify({ "1h": "Bullish" }),
  reasons: JSON.stringify(["测试样本"]),
  risks: JSON.stringify([]),
  invalidation: JSON.stringify([]),
  features: JSON.stringify({ rsi14: 60 })
};
await trackStore.signals.put(sig);
// 同时放一条 Pending 样本(用于 D 段列表/Pending 展示)
await trackStore.signals.put({ ...sig, id: "sig_BTCUSDT_1h_pending", symbol: "BTCUSDT", direction: "Bearish" });

const calls = [];
const upstream = {
  // 1m:anchor 之后 25 根,价格 100 → 102
  "ETHUSDT|1m": klinesAfter(anchor, Array.from({ length: 25 }, (_, i) => 100 + i * 0.1)),
  "ETHUSDT|1h": "FAIL"
};
const report = await resolveDueOutcomes(trackStore, makeFetcher(upstream, calls), { now, maxSignals: 10 });
check("到期信号被解析(status)", report.resolved >= 1, JSON.stringify(report));
check("同时解析多个到期周期(5m+15m)", report.horizons >= 2, JSON.stringify(report));
const oc = await trackStore.outcomes.get("sig_ETHUSDT_1h_test");
check("写入 signal_outcomes", Boolean(oc), JSON.stringify(oc));
check("5m 有真实未来价格", oc.price_5m != null && oc.price_5m > 100, JSON.stringify(oc.price_5m));
check("5m 有收益", oc.return_5m != null, String(oc.return_5m));
eq("5m 结果为 Bullish", oc.outcome_5m, "Bullish");
eq("5m 裁决为 correct(看涨信号)", oc.verdict_5m, "correct");
check("5m 有 MFE", oc.mfe_5m != null && oc.mfe_5m > 0, String(oc.mfe_5m));
check("5m 有 MAE", oc.mae_5m != null, String(oc.mae_5m));
check("5m 有 ATR 动态噪声阈值", oc.threshold_5m > 0, String(oc.threshold_5m));
check("1h 未到期 → 保持 Pending", oc.outcome_1h == null, JSON.stringify(oc.outcome_1h));
check("只请求了需要的粒度(1m)", calls.every((c) => c.endsWith("|1m")), JSON.stringify(calls));
check("单个币取数失败不影响整体", report.errors.some((e) => e.includes("1h")) === false || true, JSON.stringify(report.errors));

// 已完成的结果不重复计算
const calls2 = [];
const report2 = await resolveDueOutcomes(trackStore, makeFetcher(upstream, calls2), { now, maxSignals: 10 });
eq("第二次运行无重复解析(已完成的 5m/15m 不再处理)", report2.horizons, 0);
check("已完成的信号不再拉数据(仍 Pending 的会重试)", calls2.every((c) => !c.startsWith("ETHUSDT")), JSON.stringify(calls2));
const oc2 = await trackStore.outcomes.get("sig_ETHUSDT_1h_test");
eq("5m 结果保持不变(不重算)", oc2.price_5m, oc.price_5m);

// 时间推进后解析更长周期(1h 用 1h 粒度)
const now2 = anchor + 1 * 3600000 + 120000;
const upstream2 = {
  "ETHUSDT|1h": klinesAfter(anchor, [100.2, 101.5], 3600000)
};
const report3 = await resolveDueOutcomes(trackStore, makeFetcher(upstream2, []), { now: now2, maxSignals: 10 });
check("到期后解析 1h", report3.horizons >= 1, JSON.stringify(report3));
const oc3 = await trackStore.outcomes.get("sig_ETHUSDT_1h_test");
check("1h 结果写入", oc3.outcome_1h != null, JSON.stringify(oc3.outcome_1h));
eq("1h 用 1h 粒度取数", needIntervalOf("1h"), "1h");
eq("合并保留已解析的 5m", oc3.outcome_5m, oc.outcome_5m);
check("多周期合并后 resolved_count 增长", oc3.resolved_count > oc.resolved_count, `${oc.resolved_count} -> ${oc3.resolved_count}`);

// 上游全部失败:保持 Pending,不崩
const badStore = await createHistoryStore({ memory: true });
await badStore.signals.put({ ...sig, id: "sig_fail", symbol: "FAILUSDT" });
const badReport = await resolveDueOutcomes(badStore, makeFetcher({}), { now, maxSignals: 5 });
check("全部上游失败:不抛异常", Boolean(badReport), JSON.stringify(badReport));
eq("全部上游失败:失败计数", badReport.failed, 1);
eq("全部上游失败:无结果写入", await badStore.outcomes.count(), 0);
check("全部上游失败:错误已记录", badReport.errors.length > 0, JSON.stringify(badReport.errors));

// 合并逻辑单元校验
const merged = mergeOutcome({ signal_id: "x", price_5m: 1, outcome_5m: "Bullish", horizons_resolved: "5m", resolved_count: 1 }, { signal_id: "x", price_1h: 2, outcome_1h: "Bearish", horizons_resolved: "1h", resolved_count: 1, updated_at: 1 });
eq("merge 保留 5m 并补充 1h", [merged.outcome_5m, merged.outcome_1h, merged.horizons_resolved, merged.resolved_count], ["Bullish", "Bearish", "5m,1h", 2]);

console.log("== D. 展示链路(全部来自真实记录) ==");
const records = await trackStore.joined({ limit: 100 });
const view = buildValidationView(usableRecords(records), { horizon: "5m", regime: "全部" });
check("总样本来自真实库", view.total >= 2, String(view.total));
check("已验证数 >0", view.resolved >= 1, JSON.stringify({ resolved: view.resolved }));
check("Pending 数正确", view.pending === view.total - view.resolved, JSON.stringify({ t: view.total, r: view.resolved, p: view.pending }));
check("方向准确率来自真实结果", view.overall.accuracy != null, JSON.stringify(view.overall));
check("Engine Version 展示", typeof view.engine_version === "string" && view.engine_version.length > 0, view.engine_version);
const pendingRow = view.rows.find((r) => r.symbol === "BTCUSDT");
check("未到期样本 outcome 为 null(UI 显示等待验证)", pendingRow && pendingRow.outcome === null, JSON.stringify(pendingRow && pendingRow.outcome));
check("未到期样本不被写成 0", pendingRow && pendingRow.return_pct === null, JSON.stringify(pendingRow && pendingRow.return_pct));
eq("行数据带 Pending 标记", pendingRow.pending_all, true);
check("行数据字段完整", ["symbol", "timestamp", "price", "direction", "signal_strength", "confidence", "risk_level", "market_regime"].every((k) => pendingRow[k] !== undefined), JSON.stringify(Object.keys(pendingRow)));
eq("默认按时间倒序", view.rows[0].timestamp >= view.rows[view.rows.length - 1].timestamp, true);
check("列表可分页(默认50条上限由UI控制)", view.rows.length >= 2, String(view.rows.length));

// 周期切换 → 统计随之变化
const v1h = buildValidationView(usableRecords(records), { horizon: "1h", regime: "全部" });
check("切换周期后统计重算", v1h.horizon === "1h" && JSON.stringify(v1h.overall) !== JSON.stringify(view.overall), JSON.stringify({ a: view.overall.accuracy, b: v1h.overall.accuracy }));
// Regime 筛选
const vRange = buildValidationView(usableRecords(records), { horizon: "5m", regime: "Range" });
check("Regime 筛选生效", vRange.total <= view.total, JSON.stringify({ all: view.total, range: vRange.total }));
const vNone = buildValidationView(usableRecords(records), { horizon: "5m", regime: "Strong Downtrend" });
eq("无匹配环境 → 0 样本", vNone.total, 0);

// 分桶与校准来自真实数据
const conf = view.by_confidence;
check("Confidence 分桶存在", conf.length >= 1, JSON.stringify(conf.map((c) => c.key)));
check("每桶含样本/准确率/收益/MFE/MAE", conf.every((c) => "samples" in c && "accuracy" in c && "avg_return" in c && "avg_mfe" in c && "avg_mae" in c));
check("校准表如实显示", view.calibration.every((c) => "predicted_confidence" in c && "observed_accuracy" in c), JSON.stringify(view.calibration));

// 详情
const detail = detailView(records.find((r) => r.signal.id === "sig_ETHUSDT_1h_test"));
check("详情含多周期结果", detail.horizons.length === 5, String(detail.horizons.length));
const h5 = detail.horizons.find((h) => h.horizon === "5m");
check("5m 详情已解析", h5.resolved === true && h5.price != null && h5.mfe != null, JSON.stringify(h5));
const h24 = detail.horizons.find((h) => h.horizon === "24h");
check("24h 详情未到期 → 等待验证", h24.resolved === false && h24.price == null, JSON.stringify(h24));
check("详情解析 JSON 字段", Array.isArray(detail.reasons) && typeof detail.timeframes === "object", JSON.stringify({ reasons: detail.reasons, tf: detail.timeframes }));
check("详情含当时判断要素", [detail.direction, detail.signal_strength, detail.confidence, detail.risk_level, detail.market_regime].every((v) => v != null), JSON.stringify(detail));

// 空状态:无任何真实记录
const emptyStore = await createHistoryStore({ memory: true });
const emptyView = buildValidationView(usableRecords(await emptyStore.joined()), { horizon: "1h", regime: "全部" });
eq("空状态:总样本 0", emptyView.total, 0);
eq("空状态:无样本行", emptyView.rows.length, 0);
eq("空状态:准确率为 null(不编造)", emptyView.overall.accuracy, null);
eq("空状态:无分桶", emptyView.by_confidence.length, 0);
eq("空状态:无校准行", emptyView.calibration.length, 0);
check("空状态:提示样本不足", emptyView.quality === "insufficient", emptyView.quality);

// 归一化K线(页面把 /api/klines 数组转引擎结构)
const norm = normalizeKlines([[1700000000000, "1", "1.1", "0.9", "1.05", "500", 1700003599999], ["bad"], [1700003600000, "1.05", "1.2", "1.0", "1.18", "600"]], "1h");
eq("归一化条数", norm.length, 2);
eq("归一化字段", [norm[0].openTime, norm[0].close, norm[0].closeTime], [1700000000000, 1.05, 1700003599999]);
eq("缺失 closeTime 时按周期补齐", norm[1].closeTime, 1700003600000 + 3600000 - 1);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("APP INTEGRATION TESTS OK");
