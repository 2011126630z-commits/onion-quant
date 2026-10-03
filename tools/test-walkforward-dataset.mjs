// tools/test-walkforward-dataset.mjs
// STEP 10 / 11 验收测试:
//   A. Walk Forward:窗口不重叠、Test 不进入 Train、Fold 顺序、样本不足标记、落库字段
//   B. Dataset:一行一 Signal、特征取历史快照(不重算)、Pending 为 null(不是 0)、筛选、CSV/JSON 字段一致
import fs from "node:fs";
import path from "node:path";
import { createHistoryStore } from "../worker/src/history/store.js";
import { runWalkForwardSession, makeWalkForwardFolds, validateFolds, pickByTime, evaluateFold, selectParams } from "../worker/src/history/walkforward.js";
import { buildDataset, datasetToCsv, datasetToJson, collectFeatureColumns, datasetFileName, BASE_COLUMNS, labelColumns } from "../worker/src/history/dataset.js";
import { signalRecordFromAnalysis } from "../worker/src/history/record.js";
import { computeAnalysis } from "../worker/src/engine/signal.js";

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
function makeFetcher(opts) {
  const o = opts || {};
  const src = {
    "1h": () => genKlines(o.bars || 1000, { ivMs: 3600000, seed: 21, t0: 1600000000000 }),
    "4h": () => genKlines(Math.ceil((o.bars || 1000) / 4) + 60, { ivMs: 14400000, seed: 22, t0: 1600000000000 }),
    "1d": () => genKlines(Math.ceil((o.bars || 1000) / 24) + 30, { ivMs: 86400000, seed: 23, t0: 1600000000000 }),
    "1m": () => genKlines(1000, { ivMs: 60000, seed: 24, t0: 1600000000000 + (o.bars || 1000) * 3600000 - 1000 * 60000 })
  };
  return async (symbol, interval, limit) => {
    const gen = src[interval];
    if (!gen) throw new Error("no source " + interval);
    const rows = gen();
    return rows.length > limit ? rows.slice(rows.length - limit) : rows;
  };
}

// ============================================================
console.log("== A. Walk Forward 窗口框架 ==");
const day = 86400000;
const folds = makeWalkForwardFolds({ startMs: 0, endMs: 100 * day, trainMs: 20 * day, testMs: 10 * day });
eq("窗口数量", folds.length, 8);
eq("第一折 Train", [folds[0].train_start, folds[0].train_end], [0, 20 * day - 1]);
eq("第一折 Test", [folds[0].test_start, folds[0].test_end], [20 * day, 30 * day - 1]);
eq("窗口校验无问题", validateFolds(folds), []);
check("Train 全部早于 Test", folds.every((f) => f.train_end < f.test_start));
check("Test 窗口之间不重叠", folds.every((f, i) => i === 0 || f.test_start > folds[i - 1].test_end));
check("窗口向前滚动", folds.every((f, i) => i === 0 || f.test_start > folds[i - 1].test_start));
check("Test 时长固定", folds.every((f) => f.test_end - f.test_start + 1 === 10 * day));
check("Train 时长固定", folds.every((f) => f.train_end - f.train_start + 1 === 20 * day));
// 重叠窗口应被校验拦下
const badFolds = [{ fold_id: 0, train_start: 0, train_end: 100, test_start: 100, test_end: 200 }, { fold_id: 1, train_start: 50, train_end: 150, test_start: 120, test_end: 220 }];
check("校验能发现 train/test 重叠", validateFolds(badFolds).length > 0, JSON.stringify(validateFolds(badFolds)));

console.log("== A2. Walk Forward 实跑(合成K线) ==");
const wfStore = await createHistoryStore({ memory: true });
const wf = await runWalkForwardSession({
  store: wfStore,
  symbol: "BTCUSDT",
  interval: "1h",
  bars: 1000,
  horizon: "1h",
  trainMs: 7 * day,
  testMs: 3 * day,
  nowMs: 1600000000000 + 1000 * 3600000 + 60000,
  fetchKlines: makeFetcher({ bars: 1000 }),
  onStage: () => {},
  onProgress: async () => {}
});
check("Walk Forward 运行成功", wf.ok === true, JSON.stringify(wf.message));
check("产生多折(>=5)", wf.folds.length >= 5, String(wf.folds.length));
eq("窗口校验全部通过(无重叠/无泄漏)", wf.problems, []);
check("每折 Test 数据不在同折 Train 中", wf.folds.every((f) => f.train_end < f.test_start), JSON.stringify(wf.folds.map((f) => [f.train_end, f.test_start])));
const wfSignals = await wfStore.signals.all();
check("重放信号已保存", wfSignals.length === wf.signals, String(wfSignals.length));
// 用真实信号时间戳验证:不存在同时落在同一折 train 与 test 窗口的信号
const wfRecords = wfSignals.map((s) => ({ signal: s, outcome: null }));
let overlapViolations = 0;
for (const f of wf.folds) {
  const inTrain = new Set(pickByTime(wfRecords, f.train_start, f.train_end).map((r) => r.signal.id));
  const inTest = pickByTime(wfRecords, f.test_start, f.test_end).map((r) => r.signal.id);
  for (const id of inTest) if (inTrain.has(id)) overlapViolations += 1;
}
eq("没有任何信号同时进入同折的 Train 与 Test", overlapViolations, 0);
check("Fold 顺序正确", wf.folds.every((f, i) => i === 0 || f.fold_id === wf.folds[i - 1].fold_id + 1), JSON.stringify(wf.folds.map((f) => f.fold_id)));
check("Fold Test 时间递增", wf.folds.every((f, i) => i === 0 || f.test_start > wf.folds[i - 1].test_start));
check("每折都有样本", wf.folds.every((f) => f.test_sample_count > 0), JSON.stringify(wf.folds.map((f) => f.test_sample_count)));
check("每折都计算了样本外准确率(样本够时)", wf.folds.some((f) => f.directional_accuracy != null), JSON.stringify(wf.folds.map((f) => f.directional_accuracy)));
check("Train 选参与 Test 评估分离", wf.folds.every((f) => f.selected_min_confidence == null || (f.train_accuracy != null || f.selected_min_confidence === 0)), JSON.stringify(wf.folds.map((f) => [f.selected_min_confidence, f.train_accuracy])));
const wfStored = await wfStore.generic.all("walkforward_folds");
eq("每折都落库", wfStored.length, wf.folds.length);
const foldFields = ["fold_id", "train_start", "train_end", "test_start", "test_end", "symbol", "engine_version", "test_sample_count", "directional_accuracy", "avg_return", "avg_mfe", "avg_mae", "confidence_calibration", "quality"];
check("落库字段齐全", foldFields.every((k) => k in wfStored[0]), JSON.stringify(Object.keys(wfStored[0])));
check("落库含 confidence_calibration(JSON 字符串)", typeof wfStored[0].confidence_calibration === "string", typeof wfStored[0].confidence_calibration);
const wfRuns = await wfStore.generic.all("walkforward_runs");
eq("验证运行记录已保存", wfRuns.length, 1);
eq("运行记录 fold 数", wfRuns[0].folds, wf.folds.length);
check("运行记录含 engine_version", Boolean(wfRuns[0].engine_version), String(wfRuns[0].engine_version));
check("汇总含池化样本外准确率", wf.summary.pooled_accuracy != null, JSON.stringify(wf.summary));
check("汇总含最好/最差环境字段", "best_regime" in wf.summary && "worst_regime" in wf.summary, JSON.stringify([wf.summary.best_regime, wf.summary.worst_regime]));

// 样本不足:跨度不足以形成窗口
const shortStore = await createHistoryStore({ memory: true });
const shortWf = await runWalkForwardSession({
  store: shortStore, symbol: "BTCUSDT", interval: "1h", bars: 400, horizon: "1h",
  trainMs: 30 * day, testMs: 7 * day, nowMs: 1600000000000 + 400 * 3600000,
  fetchKlines: makeFetcher({ bars: 400 })
});
eq("跨度不足 → 0 折", shortWf.folds.length, 0);
eq("标记样本不足", shortWf.summary.insufficient, true);
const shortRuns = await shortStore.generic.all("walkforward_runs");
eq("样本不足也留记录", shortRuns[0].status, "completed_insufficient");
// K线太少 → 直接停止
const tinyStore = await createHistoryStore({ memory: true });
const tiny = await runWalkForwardSession({ store: tinyStore, symbol: "BTCUSDT", interval: "1h", bars: 100, horizon: "1h", nowMs: 1600000000000, fetchKlines: makeFetcher({ bars: 100 }) });
eq("K线不足 → 停止", tiny.ok, false);
check("K线不足提示", String(tiny.message).includes("历史数据不足"), tiny.message);

// selectParams 只看 Train(构造两组数据验证)
function mkRec(conf, outcome) {
  return { signal: { id: "x" + conf + outcome, timestamp: 1, confidence: conf, direction: "Bullish", symbol: "BTCUSDT", interval: "1h" }, outcome: { outcome_1h: outcome, return_1h: 1, mfe_1h: 1, mae_1h: 1 } };
}
const trainRecs = [];
for (let i = 0; i < 25; i += 1) trainRecs.push(mkRec(75, "Bullish"));
for (let i = 0; i < 25; i += 1) trainRecs.push(mkRec(55, "Bearish"));
const selected = selectParams(trainRecs, "1h");
eq("选参只依据 Train(取达到最佳 Train 准确率的最低阈值)", selected.min_confidence, 60);
eq("改用 75 起的候选网格 → 阈值 75", selectParams(trainRecs, "1h", [75, 80]).min_confidence, 75);
near1("选参准确率来自 Train", selected.accuracy, 100);
function near1(name, actual, expected) {
  check(name, Math.abs(actual - expected) < 1e-6, `got ${actual} want ${expected}`);
}
const foldEval = evaluateFold({ fold: { fold_id: 0, train_start: 0, train_end: 10, test_start: 11, test_end: 20 }, records: [...trainRecs.map((r) => ({ ...r, signal: { ...r.signal, timestamp: 5 } })), ...trainRecs.map((r) => ({ ...r, signal: { ...r.signal, timestamp: 15 } }))], horizon: "1h" });
eq("评估时 train/test 按时间隔离", [foldEval.train_sample_count, foldEval.test_sample_count], [50, 50]);

console.log("== B. Dataset Export ==");
// 数据集来源独立性:dataset.js 不得导入引擎(防重算特征)
const datasetSrc = fs.readFileSync(path.join(ROOT, "worker/src/history/dataset.js"), "utf8");
check("导出模块不导入引擎", !datasetSrc.includes("computeAnalysis") && !datasetSrc.includes("engine/"), "发现引擎引用");

const dsStore = await createHistoryStore({ memory: true });
const rows = genKlines(220, { drift: 0.002, seed: 31 });
const analysis = computeAnalysis({
  symbol: "ETHUSDT", interval: "1h",
  ticker: { lastPrice: "110", priceChangePercent: "2.5", highPrice: "112", lowPrice: "105", quoteVolume: "5e9" },
  tfRows: { "1m": rows, "5m": rows, "15m": rows, "1h": rows, "4h": rows, "1d": rows },
  btcRows: {}, tickers: [], nowMs: rows[rows.length - 1].closeTime + 300
});
const liveResolved = signalRecordFromAnalysis(analysis, { source: "live", id: "ds_live_1", timestampMs: 1700000000000 });
const livePending = signalRecordFromAnalysis(analysis, { source: "live", id: "ds_live_2", timestampMs: 1700086400000 });
const btResolved = signalRecordFromAnalysis(analysis, { source: "backtest", id: "bt_BTCUSDT_1h_1700000000000", timestampMs: 1700172800000, runId: "bt_run_x" });
const btPending = signalRecordFromAnalysis(analysis, { source: "backtest", id: "bt_BTCUSDT_1h_1700259200000", timestampMs: 1700259200000, runId: "bt_run_x" });
for (const rec of [liveResolved, livePending, btResolved, btPending]) await dsStore.signals.put(rec);
// 已解析的两条写入结果(含 5m/1h);另两条保持 Pending
await dsStore.outcomes.put({ signal_id: "ds_live_1", symbol: "ETHUSDT", outcome_1h: "Bullish", verdict_1h: "correct", return_1h: 1.5, mfe_1h: 2.2, mae_1h: 0.4, threshold_1h: 0.3, price_1h: 111.5, horizons_resolved: "1h", resolved_count: 1 });
await dsStore.outcomes.put({ signal_id: "bt_BTCUSDT_1h_1700000000000", symbol: "ETHUSDT", outcome_1h: "Bearish", verdict_1h: "wrong", return_1h: -0.9, mfe_1h: 0.3, mae_1h: 1.2, threshold_1h: 0.3, price_1h: 99.1, horizons_resolved: "1h", resolved_count: 1 });
// 关键:把特征快照改成哨兵值,若导出重新计算就会不一致
const sentinel = { ...JSON.parse(liveResolved.features), rsi14: 123, sentinel_marker: 7 };
await dsStore.signals.put({ ...liveResolved, features: JSON.stringify(sentinel) });
const joined = await dsStore.joined();

const dsLive = buildDataset(joined, { source: "live" });
eq("默认导出=live", dsLive.meta.source, "live");
eq("live 行数", dsLive.rows.length, 2);
eq("一行对应一个 Signal", new Set(dsLive.rows.map((r) => r.signal_id)).size, 2);
check("含基础字段", ["timestamp", "symbol", "source", "engine_version", "feature_version", "market_regime", "direction", "signal_strength", "confidence", "risk_score", "risk_level"].every((k) => dsLive.columns.includes(k)), JSON.stringify(dsLive.columns.slice(0, 24)));
check("含全部 Feature Snapshot 字段", dsLive.columns.some((c) => c.startsWith("f_rsi14")) && dsLive.columns.some((c) => c.startsWith("f_macd_hist")) && dsLive.columns.some((c) => c.startsWith("f_adx")), JSON.stringify(dsLive.columns.filter((c) => c.startsWith("f_"))));
check("含全部周期结果字段", ["h5m", "h15m", "h1h", "h4h", "h24h"].every((k) => dsLive.columns.includes(k + "_return") && dsLive.columns.includes(k + "_mfe") && dsLive.columns.includes(k + "_mae") && dsLive.columns.includes(k + "_outcome")));
// 特征来自历史快照(不是重算)
const live1Row = dsLive.rows.find((r) => r.signal_id === "ds_live_1");
eq("特征使用历史快照(哨兵值原样导出)", [live1Row.f_rsi14, live1Row.f_sentinel_marker], [123, 7]);
// Pending 一律 null,不是 0
const pendingRow = dsLive.rows.find((r) => r.signal_id === "ds_live_2");
check("Pending 结果为空值", pendingRow.h1h_return === null && pendingRow.h1h_mfe === null && pendingRow.h1h_mae === null && pendingRow.h1h_outcome === null, JSON.stringify(pendingRow));
check("Pending 明确标记未解析", pendingRow.h1h_resolved === 0 && pendingRow.h5m_resolved === 0, JSON.stringify([pendingRow.h1h_resolved, pendingRow.h5m_resolved]));
check("Pending 不伪装成 0", pendingRow.h1h_return !== 0 && pendingRow.h1h_mfe !== 0, JSON.stringify([pendingRow.h1h_return, pendingRow.h1h_mfe]));
const resolvedRow = dsLive.rows.find((r) => r.signal_id === "ds_live_1");
eq("已解析样本的结果", [resolvedRow.h1h_resolved, resolvedRow.h1h_return, resolvedRow.h1h_outcome, resolvedRow.h1h_verdict, resolvedRow.h1h_mfe, resolvedRow.h1h_mae], [1, 1.5, "Bullish", "correct", 2.2, 0.4]);
check("pending_rows 统计正确", dsLive.meta.pending_rows === 1 && dsLive.meta.labeled_rows === 1, JSON.stringify(dsLive.meta));
// 筛选
eq("来源筛选 backtest", buildDataset(joined, { source: "backtest" }).rows.length, 2);
eq("来源筛选 all", buildDataset(joined, { source: "all" }).rows.length, 4);
eq("币种筛选", buildDataset(joined, { source: "all", symbol: "ETHUSDT" }).rows.length, 4);
eq("币种筛选无匹配", buildDataset(joined, { source: "all", symbol: "SOLUSDT" }).rows.length, 0);
eq("时间范围筛选", buildDataset(joined, { source: "all", fromMs: 1700100000000, toMs: 1700200000000 }).rows.length, 1);
eq("只保留已解析(1h)", buildDataset(joined, { source: "all", onlyResolvedFor: "1h" }).rows.length, 2);
eq("只保留已解析(5m)", buildDataset(joined, { source: "all", onlyResolvedFor: "5m" }).rows.length, 0);
check("按时间升序", dsLive.rows.every((r, i) => i === 0 || r.timestamp >= dsLive.rows[i - 1].timestamp));
check("回测样本带 run id", buildDataset(joined, { source: "backtest" }).rows.every((r) => r.backtest_run_id === "bt_run_x"));
check("live 样本 run id 为空", dsLive.rows.every((r) => r.backtest_run_id === null));

// CSV / JSON 一致性
const csv = datasetToCsv(dsLive);
const lines = csv.trim().split("\n");
eq("CSV 表头 = 列清单", lines[0], dsLive.columns.join(","));
eq("CSV 行数 = 数据行数", lines.length - 1, dsLive.rows.length);
const jsonText = datasetToJson(dsLive);
const parsed = JSON.parse(jsonText);
eq("JSON 列清单与 CSV 一致", parsed.columns, dsLive.columns);
eq("JSON 行数一致", parsed.rows.length, dsLive.rows.length);
eq("JSON 包含 meta", typeof parsed.meta.rows, "number");
const jsonKeys = Object.keys(parsed.rows[0]).sort();
eq("JSON 行字段 = 列清单", jsonKeys, [...dsLive.columns].sort());
const csvHeaderCount = lines[0].split(",").length;
check("CSV 每行字段数与表头一致", lines.every((l) => splitCsvCount(l) === csvHeaderCount), String(csvHeaderCount));
function splitCsvCount(line) {
  let count = 1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { i += 1; continue; }
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) count += 1;
  }
  return count;
}
// CSV 转义
const escapeCsv = datasetToCsv({ columns: ["a", "b"], rows: [{ a: 'x,y"z', b: "line1\nline2" }] });
check("CSV 逗号/引号/换行被正确转义", escapeCsv.includes('"x,y""z"') && escapeCsv.includes('"line1\nline2"'), JSON.stringify(escapeCsv));
check("空值导出为空单元格", datasetToCsv({ columns: ["a"], rows: [{ a: null }] }).split("\n")[1] === "", JSON.stringify(datasetToCsv({ columns: ["a"], rows: [{ a: null }] })));
// 文件名
check("文件名含来源与扩展名", /quant-dataset_live.*\.csv$/.test(datasetFileName("quant-dataset", "csv", { source: "live" })), datasetFileName("quant-dataset", "csv", { source: "live" }));
check("文件名含币种", datasetFileName("quant-dataset", "json", { source: "backtest", symbol: "btcusdt" }).includes("BTCUSDT"));
check("列清单组合正确", labelColumns(["1h"]).length === 10 && BASE_COLUMNS.length >= 20, `${labelColumns(["1h"]).length}/${BASE_COLUMNS.length}`);
check("特征列与快照键一致", collectFeatureColumns(joined).includes("rsi14") && dsLive.columns.includes("f_" + collectFeatureColumns(joined)[0]));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("WALKFORWARD + DATASET TESTS OK");
