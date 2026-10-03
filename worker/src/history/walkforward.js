// history/walkforward.js · STEP 10 Walk Forward Validation
// 时间顺序切分:TRAIN(过去) → TEST(完全未来) → 向前滚动
// 硬约束:
//   1) 禁止随机切分(本模块只做时间滚动)
//   2) train 窗口只含 test_start 之前的数据;test 窗口数据绝不参与 train 统计/参数选择/校准
//   3) 每个 fold 的参数(train 上选出的 min_confidence)只由 train 样本决定,再用到 test 上评估
// 复用现有 Backtest Engine: replaySymbol / attachOutcomes / pickSeriesByHorizon / makeBacktestPlan
import { replaySymbol, attachOutcomes, pickSeriesByHorizon } from "./backtest.js";
import { summarize, calibrationTable, sampleQuality, statsByRegime } from "./stats.js";
import { intervalMsOf } from "./outcome.js";
import { HORIZONS } from "./schema.js";
import { backtestFetchPlan } from "./pipeline.js";

export const DEFAULT_TRAIN_MS = 30 * 86400000;
export const DEFAULT_TEST_MS = 7 * 86400000;
export const CONF_GRID = [0, 55, 60, 65, 70, 75, 80];
export const MIN_TRAIN_SAMPLES = 20;

// 生成滚动窗口(train 固定长度、test 紧随其后、test 之间不重叠)
export function makeWalkForwardFolds(input) {
  const startMs = Number(input.startMs);
  const endMs = Number(input.endMs);
  const trainMs = Number(input.trainMs) || DEFAULT_TRAIN_MS;
  const testMs = Number(input.testMs) || DEFAULT_TEST_MS;
  const stepMs = Number(input.stepMs) || testMs;
  const folds = [];
  if (!isFinite(startMs) || !isFinite(endMs) || endMs <= startMs) return folds;
  let foldId = 0;
  let testStart = startMs + trainMs;
  while (testStart + testMs - 1 <= endMs) {
    const trainStart = testStart - trainMs;
    const trainEnd = testStart - 1;
    folds.push({
      fold_id: foldId,
      train_start: trainStart,
      train_end: trainEnd,
      test_start: testStart,
      test_end: testStart + testMs - 1
    });
    foldId += 1;
    testStart += stepMs;
  }
  return folds;
}

// 校验窗口不重叠、不泄漏(test_start 必须晚于 train_end)
export function validateFolds(folds) {
  const problems = [];
  for (let i = 0; i < folds.length; i += 1) {
    const f = folds[i];
    if (f.train_end >= f.test_start) problems.push("fold" + f.fold_id + ": train 与 test 重叠");
    if (f.train_start >= f.train_end) problems.push("fold" + f.fold_id + ": train 窗口无效");
    if (f.test_start > f.test_end) problems.push("fold" + f.fold_id + ": test 窗口无效");
    if (i > 0) {
      const prev = folds[i - 1];
      if (f.test_start <= prev.test_end) problems.push("fold" + f.fold_id + ": test 窗口与上一折重叠");
      if (f.fold_id !== prev.fold_id + 1) problems.push("fold" + f.fold_id + ": 顺序错误");
      if (f.train_start < prev.train_start) problems.push("fold" + f.fold_id + ": 时间未向前滚动");
    }
  }
  return problems;
}

// 用 TRAIN 样本选参数(只允许看 train)
export function selectParams(trainRecords, horizon, grid) {
  const candidates = grid || CONF_GRID;
  let best = { min_confidence: null, accuracy: null, samples: 0 };
  for (const minConf of candidates) {
    const subset = trainRecords.filter((r) => Number(r.signal.confidence) >= minConf);
    const s = summarize(subset, horizon);
    if (s.resolved < MIN_TRAIN_SAMPLES) continue;
    if (s.accuracy == null) continue;
    if (best.accuracy == null || s.accuracy > best.accuracy) {
      best = { min_confidence: minConf, accuracy: s.accuracy, samples: s.resolved };
    }
  }
  return best;
}

// 取时间范围内的信号(TRAIN / TEST 均只按信号自身时间戳划分)
export function pickByTime(records, fromMs, toMs) {
  return (records || []).filter((r) => {
    const t = Number(r.signal.timestamp);
    return isFinite(t) && t >= fromMs && t <= toMs;
  });
}

export function runIdOf(symbol, interval, bars, nowMs, trainMs, testMs) {
  return `wf_${symbol}_${interval}_${bars}_${trainMs}_${testMs}_${nowMs}`;
}

// 单折评估
export function evaluateFold(input) {
  const fold = input.fold;
  const horizon = input.horizon || "1h";
  const records = input.records || [];
  const train = pickByTime(records, fold.train_start, fold.train_end);
  const test = pickByTime(records, fold.test_start, fold.test_end);
  const trainStats = summarize(train, horizon);
  const testStats = summarize(test, horizon);
  const selected = selectParams(train, horizon);
  const selectedSubset = selected.min_confidence == null ? [] : test.filter((r) => Number(r.signal.confidence) >= selected.min_confidence);
  const selectedStats = summarize(selectedSubset, horizon);
  return {
    fold_id: fold.fold_id,
    train_start: fold.train_start,
    train_end: fold.train_end,
    test_start: fold.test_start,
    test_end: fold.test_end,
    train_sample_count: train.length,
    test_sample_count: test.length,
    test_resolved: testStats.resolved,
    directional_accuracy: testStats.accuracy,
    neutral_rate: testStats.neutral_rate,
    avg_return: testStats.avg_return,
    median_return: testStats.median_return,
    avg_mfe: testStats.avg_mfe,
    avg_mae: testStats.avg_mae,
    train_accuracy: trainStats.accuracy,
    selected_min_confidence: selected.min_confidence,
    test_selected_accuracy: selectedStats.accuracy,
    test_selected_samples: selectedStats.resolved,
    confidence_calibration: JSON.stringify(calibrationTable(test, horizon).map((c) => ({
      bucket: c.bucket, predicted: c.predicted_confidence, observed: c.observed_accuracy, samples: c.resolved
    }))),
    quality: sampleQuality(testStats.resolved),
    _train_accuracy_raw: trainStats.accuracy
  };
}

// 汇总所有 fold(只池化 TEST 窗口样本 → 全部是样本外数据,不存在泄漏)
export function summarizeFolds(folds, testRecords, horizon) {
  if (!folds.length) {
    return { folds: 0, avg_accuracy: null, avg_return: null, avg_mfe: null, avg_mae: null, pooled_accuracy: null, pooled_samples: 0, best_regime: null, worst_regime: null, insufficient: true };
  }
  const nums = (key) => folds.map((f) => f[key]).filter((v) => v != null && isFinite(v));
  const mean = (arr) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 1000) / 1000 : null);
  const pooled = summarize(testRecords, horizon);
  const regimes = statsByRegime(testRecords, horizon).filter((r) => r.resolved >= 10 && r.accuracy != null);
  regimes.sort((a, b) => b.accuracy - a.accuracy);
  return {
    folds: folds.length,
    avg_accuracy: mean(nums("directional_accuracy")),
    avg_return: mean(nums("avg_return")),
    avg_mfe: mean(nums("avg_mfe")),
    avg_mae: mean(nums("avg_mae")),
    avg_selected_accuracy: mean(nums("test_selected_accuracy")),
    pooled_accuracy: pooled.accuracy,
    pooled_resolved: pooled.resolved,
    pooled_samples: pooled.samples,
    best_regime: regimes.length ? { key: regimes[0].key, accuracy: regimes[0].accuracy, resolved: regimes[0].resolved } : null,
    worst_regime: regimes.length ? { key: regimes[regimes.length - 1].key, accuracy: regimes[regimes.length - 1].accuracy, resolved: regimes[regimes.length - 1].resolved } : null,
    insufficient: pooled.resolved < 30
  };
}

// 执行一次 Walk Forward 验证(取数 → 全区间重放 → 按时间切 fold → 逐折评估 → 落库)
export async function runWalkForwardSession(input) {
  const store = input.store;
  const symbol = String(input.symbol || "BTCUSDT").toUpperCase();
  const interval = input.interval || "1h";
  const bars = Number(input.bars) || 1000;
  const horizon = input.horizon || "1h";
  const now = Number(input.nowMs) || Date.now();
  const trainMs = Number(input.trainMs) || DEFAULT_TRAIN_MS;
  const testMs = Number(input.testMs) || DEFAULT_TEST_MS;
  const onStage = input.onStage || (() => {});
  const onProgress = input.onProgress || (() => {});
  const fetchKlines = input.fetchKlines;
  const runId = runIdOf(symbol, interval, bars, now, trainMs, testMs);
  const startedAt = now;

  // 取数(复用回测取数计划)
  const plan = backtestFetchPlan({ symbol, interval, bars });
  const klines = {};
  const btcKlines = {};
  const failures = [];
  let fetched = 0;
  for (const f of plan.fetches) {
    onStage({ stage: "fetch", label: "获取历史K线", done: fetched, total: plan.fetches.length, detail: f.key === "btc" ? "BTCUSDT " + f.tf : f.tf });
    try {
      const rows = await fetchKlines(f.key === "btc" ? "BTCUSDT" : symbol, f.tf, f.limit);
      const target = f.key === "btc" ? btcKlines : klines;
      target[f.tf] = Array.isArray(rows) ? rows : [];
    } catch (error) {
      failures.push(f.id);
      const target = f.key === "btc" ? btcKlines : klines;
      if (!target[f.tf]) target[f.tf] = [];
    }
    fetched += 1;
  }
  const mainRows = klines[interval] || [];
  if (mainRows.length < 300) {
    await store.generic.put("walkforward_runs", {
      id: runId, symbol, interval, bars, train_ms: trainMs, test_ms: testMs, folds: 0,
      started_at: startedAt, finished_at: Date.now(), status: "insufficient", total_signals: 0,
      note: "历史数据不足(仅取得 " + mainRows.length + " 根 " + interval + " K线),至少需要 300 根", engine_version: null
    });
    return { ok: false, reason: "insufficient_data", runId, message: "历史数据不足(仅取得 " + mainRows.length + " 根 " + interval + " K线)" };
  }

  // 全区间时间重放(每个时点只看当时已收盘数据)
  onStage({ stage: "replay", label: "重放历史时间", done: 0, total: mainRows.length });
  const replay = await replaySymbol({
    symbol, interval, tfRows: klines, btcRows: btcKlines, nowMs: now, step: Number(input.step) || 1, minHistory: 60,
    onProgress: async (p) => { await onProgress({ stage: "replay", scanned: p.scanned, total: p.total, signals: p.signals }); }
  });
  const signals = replay.signals.map((s) => ({ ...s, backtest_run_id: runId }));

  // 解析结果(样本外标签同样只用信号之后已收盘K线)
  onStage({ stage: "outcomes", label: "解析 Outcomes", done: 0, total: signals.length });
  const series = pickSeriesByHorizon({
    "1m": klines["1m"], "15m": klines["15m"],
    "1h": klines["1h"] || klines[interval === "1h" ? "1h" : interval],
    "4h": klines["4h"]
  });
  const joined = attachOutcomes(signals, series, now);
  const outcomes = joined.filter((j) => j.outcome).map((j) => j.outcome);
  const outcomeMap = new Map(outcomes.map((o) => [o.signal_id, o]));
  const records = signals.map((s) => ({ signal: s, outcome: outcomeMap.get(s.id) || null }));
  onStage({ stage: "outcomes", label: "解析 Outcomes", done: outcomes.length, total: signals.length });

  // 按时间切 fold
  const times = signals.map((s) => Number(s.timestamp)).filter((t) => isFinite(t));
  const spanStart = times.length ? Math.min(...times) : now;
  const spanEnd = times.length ? Math.max(...times) : now;
  const folds = makeWalkForwardFolds({ startMs: spanStart + intervalMsOf(interval), endMs: spanEnd, trainMs, testMs });
  const problems = validateFolds(folds);
  onStage({ stage: "folds", label: "评估各折(样本外)", done: 0, total: folds.length });

  const foldRows = [];
  const testRecords = [];
  for (const fold of folds) {
    const row = evaluateFold({ fold, records, horizon });
    row.id = runId + "|" + fold.fold_id;
    row.run_id = runId;
    row.symbol = symbol;
    row.interval = interval;
    row.engine_version = signals.length ? signals[0].engine_version : null;
    row.created_at = Date.now();
    delete row._train_accuracy_raw;
    await store.generic.put("walkforward_folds", row);
    foldRows.push(row);
    for (const r of pickByTime(records, fold.test_start, fold.test_end)) testRecords.push(r);
    onStage({ stage: "folds", label: "评估各折(样本外)", done: foldRows.length, total: folds.length });
  }

  const summary = summarizeFolds(foldRows, testRecords, horizon);
  // 保存样本(回测来源,不覆盖 live)
  await store.signals.putMany(signals);
  await store.outcomes.putMany(outcomes);
  await store.generic.put("walkforward_runs", {
    id: runId, symbol, interval, bars, train_ms: trainMs, test_ms: testMs, folds: folds.length,
    started_at: startedAt, finished_at: Date.now(),
    status: summary.insufficient ? "completed_insufficient" : "completed",
    total_signals: signals.length,
    note: problems.length ? "窗口校验异常:" + problems.join("; ") : "",
    engine_version: signals.length ? signals[0].engine_version : null,
    best_regime: summary.best_regime ? summary.best_regime.key : null,
    worst_regime: summary.worst_regime ? summary.worst_regime.key : null
  });
  onStage({ stage: "done", label: "完成" });
  return {
    ok: true,
    runId,
    folds: foldRows,
    summary,
    horizon,
    signals: signals.length,
    resolved: outcomes.length,
    problems,
    failures,
    span: { start: spanStart, end: spanEnd }
  };
}

export { HORIZONS };
