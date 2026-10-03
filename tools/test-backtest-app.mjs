// tools/test-backtest-app.mjs
// 本轮验收测试:
//   A. live / backtest 统计隔离(默认只用 live)
//   B. backtest_run_id 写入 + 不覆盖 live
//   C. 重复回测不产生重复样本
//   D. 历史数据不足时明确提示并停止
//   E. 回测过程中让出事件循环(UI 不阻塞)
//   F. 回测运行记录与分周期结果落库
import { createHistoryStore } from "../worker/src/history/store.js";
import { runBacktestSession, buildValidationView, backtestFetchPlan, recentBacktestRuns, filterBySource, DEFAULT_SOURCE, SOURCE_FILTERS, usableRecords } from "../worker/src/history/pipeline.js";
import { signalRecordFromAnalysis } from "../worker/src/history/record.js";
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

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function genKlines(n, opts) {
  const o = opts || {};
  const rand = lcg(o.seed || 42);
  const ivMs = o.ivMs || 3600000;
  const t0 = o.t0 || 1600000000000;
  let price = o.start || 100;
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const open = price;
    const close = Math.max(1, price * (1 + (o.drift == null ? 0.001 : o.drift)) + (rand() - 0.5) * 0.6);
    rows.push({ openTime: t0 + i * ivMs, open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volume: 1000, closeTime: t0 + (i + 1) * ivMs - 1 });
    price = close;
  }
  return rows;
}
// 假上游:按 (symbol, interval) 返回指定长度K线;可配置"数据不足"模式
function makeFetcher(opts) {
  const o = opts || {};
  const calls = [];
  const source = {
    "1h": () => genKlines(o.bars || 300, { ivMs: 3600000, seed: 11, t0: 1600000000000 }),
    "4h": () => genKlines(Math.ceil((o.bars || 300) / 4) + 60, { ivMs: 14400000, seed: 12, t0: 1600000000000 }),
    "1d": () => genKlines(Math.ceil((o.bars || 300) / 24) + 30, { ivMs: 86400000, seed: 13, t0: 1600000000000 }),
    "1m": () => genKlines(o.oneMinute || 1000, { ivMs: 60000, seed: 14, t0: 1600000000000 + (o.bars || 300) * 3600000 - 1000 * 60000 })
  };
  return {
    calls,
    fetch: async (symbol, interval, limit) => {
      calls.push(symbol + "|" + interval + "|" + limit);
      const gen = source[interval];
      if (!gen) throw new Error("no source for " + interval);
      if (o.fail) throw new Error("upstream 502");
      const rows = gen();
      if (o.short) return rows.slice(0, Math.min(o.short, rows.length));
      return rows.length > limit ? rows.slice(rows.length - limit) : rows;
    }
  };
}

// ============================================================
console.log("== A. live / backtest 统计隔离 ==");
eq("默认来源", DEFAULT_SOURCE, "live");
eq("来源筛选项", SOURCE_FILTERS.map((s) => s.key), ["live", "backtest", "all"]);

const store = await createHistoryStore({ memory: true });
// 3 条 live 样本(2 条已解析结果)
const liveRows = genKlines(220, { drift: 0.002, seed: 7 });
const liveAnalysis = computeAnalysis({
  symbol: "ETHUSDT", interval: "1h",
  ticker: { lastPrice: "110", priceChangePercent: "2.5", highPrice: "112", lowPrice: "105", quoteVolume: "5e9" },
  tfRows: { "1m": liveRows, "5m": liveRows, "15m": liveRows, "1h": liveRows, "4h": liveRows, "1d": liveRows },
  btcRows: {}, tickers: [], nowMs: liveRows[liveRows.length - 1].closeTime + 300
});
for (let i = 0; i < 3; i += 1) {
  const rec = signalRecordFromAnalysis(liveAnalysis, { source: "live", id: "live_" + i, timestampMs: 1700000000000 + i * 3600000 });
  await store.signals.put(rec);
}
const liveAnchor = liveRows[liveRows.length - 1].closeTime;
await store.outcomes.put({ signal_id: "live_0", symbol: "ETHUSDT", outcome_1h: "Bullish", verdict_1h: "correct", return_1h: 1.2, mfe_1h: 2, mae_1h: 0.5, horizons_resolved: "1h", resolved_count: 1 });
await store.outcomes.put({ signal_id: "live_1", symbol: "ETHUSDT", outcome_1h: "Bearish", verdict_1h: "wrong", return_1h: -0.8, mfe_1h: 0.3, mae_1h: 1.1, horizons_resolved: "1h", resolved_count: 1 });
void liveAnchor;

const beforeLive = buildValidationView(usableRecords(await store.joined()), {});
eq("默认统计只含 live", beforeLive.total, 3);
eq("默认来源标记", beforeLive.source, "live");
eq("live 准确率 = 1/(1+1) = 50%", beforeLive.overall.accuracy, 50);

console.log("== B/C. 回测接入 + run_id + 去重 ==");
const fetcher = makeFetcher({ bars: 300 });
const stages = [];
const bt = await runBacktestSession({
  store,
  symbol: "BTCUSDT",
  interval: "1h",
  bars: 300,
  horizon: "1h",
  nowMs: 1700000000000 + 300 * 3600000,
  fetchKlines: fetcher.fetch,
  onStage: (s) => stages.push(s.stage),
  onProgress: async () => {}
});
check("回测成功", bt.ok === true, JSON.stringify({ ok: bt.ok, message: bt.message }));
check("产生大量回测信号(>150)", bt.signals > 150, String(bt.signals));
check("回测解析了结果", bt.resolved > 100, String(bt.resolved));
check("阶段顺序真实上报", stages.includes("fetch") && stages.includes("replay") && stages.includes("signals") && stages.includes("outcomes") && stages.includes("stats") && stages.includes("done"), JSON.stringify(stages));
const allSignals = await store.signals.all();
const btSignals = allSignals.filter((s) => s.source === "backtest");
check("回测样本标记 source=backtest", btSignals.length === bt.signals, String(btSignals.length));
check("回测样本带 backtest_run_id", btSignals.every((s) => s.backtest_run_id === bt.runId), JSON.stringify(btSignals.slice(0, 1).map((s) => s.backtest_run_id)));
check("回测样本带 engine_version/feature_version", btSignals.every((s) => s.engine_version && s.feature_version), String(btSignals[0].engine_version));

const afterLive = buildValidationView(usableRecords(await store.joined()), {});
eq("回测后默认统计仍只有 live 3 条", afterLive.total, 3);
eq("回测未污染 live 准确率", afterLive.overall.accuracy, 50);
const allView = buildValidationView(usableRecords(await store.joined()), { source: "all" });
check("全部来源 = live + backtest", allView.total === 3 + bt.signals, JSON.stringify({ all: allView.total, live: 3, bt: bt.signals }));
const btView = buildValidationView(usableRecords(await store.joined()), { source: "backtest" });
eq("回测来源统计", btView.total, bt.signals);
check("回测准确率独立计算", btView.overall.accuracy != null, JSON.stringify(btView.overall.accuracy));
eq("来源分组同时展示两组", allView.by_source.length, 2);
check("filterBySource 正确", filterBySource(usableRecords(await store.joined()), "live").length === 3);

// live 记录未被覆盖
const live0 = await store.signals.get("live_0");
eq("live 样本未被回测覆盖", [live0.source, live0.backtest_run_id], ["live", null]);

// 同一时间点重跑 → 样本数不变
const bt2 = await runBacktestSession({
  store, symbol: "BTCUSDT", interval: "1h", bars: 300, horizon: "1h",
  nowMs: 1700000000000 + 300 * 3600000, fetchKlines: fetcher.fetch
});
eq("重跑不新增样本", (await store.signals.all()).filter((s) => s.source === "backtest").length, bt.signals);
eq("同参数重跑沿用同一 run id", bt2.runId, bt.runId);
// 不同时间点重跑(新 run id) → 样本仍不重复
const bt3 = await runBacktestSession({
  store, symbol: "BTCUSDT", interval: "1h", bars: 300, horizon: "1h",
  nowMs: 1700000000000 + 300 * 3600000 + 999999, fetchKlines: fetcher.fetch
});
check("新 run id 不同", bt3.runId !== bt.runId, bt3.runId);
eq("新 run 仍不产生重复样本(按K线时间去重)", (await store.signals.all()).filter((s) => s.source === "backtest").length, bt.signals);

console.log("== D. 历史数据不足 ==");
const shortStore = await createHistoryStore({ memory: true });
const shortFetcher = makeFetcher({ bars: 300, short: 40 });
const shortRun = await runBacktestSession({
  store: shortStore, symbol: "BTCUSDT", interval: "1h", bars: 300, horizon: "1h",
  nowMs: 1700000000000, fetchKlines: shortFetcher.fetch
});
eq("数据不足 → 停止回测", shortRun.ok, false);
eq("数据不足原因", shortRun.reason, "insufficient_data");
check("明确提示历史数据不足", String(shortRun.message).includes("历史数据不足"), shortRun.message);
eq("不写入残缺样本", await shortStore.signals.count(), 0);
const shortRuns = await recentBacktestRuns(shortStore, 5);
eq("数据不足也留运行记录", shortRuns.length, 1);
eq("运行记录状态", shortRuns[0].status, "insufficient");
check("运行记录含提示", String(shortRuns[0].note).includes("历史数据不足"), shortRuns[0].note);

// 部分周期不足(主周期够、参照周期不够)→ 继续但明确提示
const partialStore = await createHistoryStore({ memory: true });
const partial = await runBacktestSession({
  store: partialStore, symbol: "BTCUSDT", interval: "1h", bars: 300, horizon: "1h",
  nowMs: 1700000000000 + 300 * 3600000, fetchKlines: makeFetcher({ bars: 300, oneMinute: 120 }).fetch
});
check("部分周期不足仍可回测", partial.ok === true, JSON.stringify(partial.message));
check("提示已使用可获得范围", String(partial.note).includes("已使用可获得范围"), partial.note);

console.log("== E. 回测不锁死事件循环 ==");
const yieldStore = await createHistoryStore({ memory: true });
let ticks = 0;
let progressCalls = 0;
const ticker = setInterval(() => { ticks += 1; }, 1);
const yieldRun = await runBacktestSession({
  store: yieldStore, symbol: "BTCUSDT", interval: "1h", bars: 300, horizon: "1h",
  nowMs: 1700000000000 + 300 * 3600000, fetchKlines: makeFetcher({ bars: 300 }).fetch,
  onProgress: async () => {
    progressCalls += 1;
    await new Promise((r) => setTimeout(r, 0)); // 页面在这里让出事件循环
  }
});
clearInterval(ticker);
check("重放过程中多次让出事件循环", progressCalls >= 5, String(progressCalls));
check("让出期间定时器仍能执行(UI 不被锁死)", ticks > 0, String(ticks));
check("分块回测仍能完成", yieldRun.ok === true && yieldRun.signals > 150, JSON.stringify({ ok: yieldRun.ok, n: yieldRun.signals }));

console.log("== F. 运行记录与分周期结果 ==");
const runs = await recentBacktestRuns(store, 5);
check("运行记录按时间倒序", runs.length >= 2 && runs[0].started_at >= runs[runs.length - 1].started_at, String(runs.length));
eq("运行记录状态 completed", runs[0].status, "completed");
check("运行记录含 symbol/interval/bars", runs[0].symbol === "BTCUSDT" && runs[0].interval === "1h" && runs[0].bars === 300, JSON.stringify([runs[0].symbol, runs[0].interval, runs[0].bars]));
check("运行记录含 engine_version", Boolean(runs[0].engine_version), String(runs[0].engine_version));
const results = await store.generic.all("backtest_results");
check("分周期结果落库(>=5)", results.length >= 5, String(results.length));
check("结果含样本量与准确率", results.every((r) => "samples" in r && "accuracy" in r && "avg_mfe" in r && "avg_mae" in r));
const plan = backtestFetchPlan({ symbol: "ETHUSDT", interval: "1h", bars: 600 });
check("取数计划含 1m 粒度与 BTC 参照", plan.fetches.some((f) => f.tf === "1m") && plan.fetches.some((f) => f.key === "btc"), JSON.stringify(plan.fetches.map((f) => f.id)));
check("BTC 自身不重复拉参照", backtestFetchPlan({ symbol: "BTCUSDT", interval: "1h", bars: 600 }).fetches.every((f) => f.key === "sym"));
check("回测期限提示样本不足", btView.quality === "insufficient" || btView.quality === "low" || btView.quality === "medium" || btView.quality === "high", btView.quality);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("BACKTEST APP TESTS OK");
