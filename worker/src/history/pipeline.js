// history/pipeline.js · 历史系统编排层(可测试:注入 store 与取数函数,页面只负责渲染)
// 职责:
//   1) 实时分析结果 → Signal 落库(带去重与修订)
//   2) 到期周期 → 拉真实K线 → Outcome 回写(已完成的不重复计算,单币失败不影响整体)
//   3) 历史记录 → 验证视图(按周期/环境筛选的统计与校准)
import { signalRecordFromAnalysis, shouldRecordSignal, resolveRecordId, dueHorizons, backtestSignalId } from "./record.js";
import { resolveSignalOutcomes, intervalMsOf } from "./outcome.js";
import { buildStatsBundle, sampleQuality, summarize } from "./stats.js";
import { HORIZONS } from "./schema.js";
import { makeBacktestPlan, replaySymbol, attachOutcomes, pickSeriesByHorizon } from "./backtest.js";

// API 返回的K线数组 → 引擎使用的行结构
export function normalizeKlines(raw, interval) {
  const ivMs = { "1m": 60000, "3m": 180000, "5m": 300000, "15m": 900000, "30m": 1800000, "1h": 3600000, "4h": 14400000, "1d": 86400000 }[interval] || 3600000;
  const rows = [];
  for (const k of raw || []) {
    if (!Array.isArray(k) || k.length < 6) continue;
    const openTime = Number(k[0]);
    const close = Number(k[4]);
    if (!isFinite(openTime) || !isFinite(close) || close <= 0) continue;
    const closeTime = k.length > 6 && Number(k[6]) > 0 ? Number(k[6]) : openTime + ivMs - 1;
    rows.push({ openTime, open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close, volume: Number(k[5]), closeTime });
  }
  rows.sort((a, b) => a.openTime - b.openTime);
  return rows;
}

// ---- 1) 记录实时分析结果 ----
export async function recordAnalysis(store, analysis, options) {
  const opts = options || {};
  if (!store || !analysis || !analysis.symbol) return { recorded: false, reason: "invalid_input" };
  if (analysis.limited_data) return { recorded: false, reason: "limited_data" };
  const rec = signalRecordFromAnalysis(analysis, { source: opts.source || "live" });
  const sameSeries = await store.signals.bySymbol(rec.symbol, 400);
  const prev = (sameSeries || [])
    .filter((s) => s.interval === rec.interval)
    .sort((a, b) => Number(b.timestamp) - Number(a.timestamp))[0] || null;
  const decision = shouldRecordSignal(prev, rec);
  if (!decision.record) return { recorded: false, reason: decision.reason, id: prev ? prev.id : null };
  const ids = new Set((sameSeries || []).map((s) => s.id));
  rec.id = resolveRecordId(rec.id, ids);
  await store.signals.put(rec);
  return { recorded: true, reason: decision.reason, id: rec.id, signal: rec };
}

// ---- 2) 到期结果解析 ----
// needIntervalOf: 5m/15m 用 1m 精确数据;1h/4h/24h 用 1h
export function needIntervalOf(horizon) {
  if (horizon === "5m" || horizon === "15m") return "1m";
  return "1h";
}

// 合并新旧结果:保留已解析周期,只补新解析出来的
export function mergeOutcome(existing, fresh) {
  if (!existing) return fresh;
  if (!fresh) return existing;
  const merged = { ...existing, updated_at: fresh.updated_at };
  const list = new Set(String(existing.horizons_resolved || "").split(",").filter(Boolean));
  for (const h of HORIZONS) {
    if (fresh[`outcome_${h}`] == null) continue;
    merged[`price_${h}`] = fresh[`price_${h}`];
    merged[`return_${h}`] = fresh[`return_${h}`];
    merged[`outcome_${h}`] = fresh[`outcome_${h}`];
    merged[`mfe_${h}`] = fresh[`mfe_${h}`];
    merged[`mae_${h}`] = fresh[`mae_${h}`];
    merged[`high_${h}`] = fresh[`high_${h}`];
    merged[`low_${h}`] = fresh[`low_${h}`];
    merged[`threshold_${h}`] = fresh[`threshold_${h}`];
    merged[`verdict_${h}`] = fresh[`verdict_${h}`];
    merged[`resolved_at_${h}`] = fresh[`resolved_at_${h}`];
    list.add(h);
  }
  merged.horizons_resolved = [...list].join(",");
  merged.resolved_count = list.size;
  return merged;
}

// 批量解析到期结果
// fetchKlines: async (symbol, interval, limit) => rows(引擎结构)
export async function resolveDueOutcomes(store, fetchKlines, options) {
  const opts = options || {};
  const now = Number(opts.now) || Date.now();
  const maxSignals = Number(opts.maxSignals) || 60;
  const maxFetches = Number(opts.maxFetches) || 12; // 单次运行最多请求上游次数,避免弱网下长时间占用
  const limit = Number(opts.limit) || 1200;
  const report = { scanned: 0, due: 0, resolved: 0, horizons: 0, fetched: 0, failed: 0, errors: [] };
  if (!store) return report;

  let signals = [];
  try {
    signals = await store.signals.all(3000);
  } catch (error) {
    report.errors.push("read_signals:" + error.message);
    return report;
  }
  let outcomeList = [];
  try {
    outcomeList = await store.outcomes.all(3000);
  } catch (error) {
    outcomeList = [];
  }
  const outcomeMap = new Map();
  for (const o of outcomeList) outcomeMap.set(o.signal_id, o);

  const cache = new Map(); // symbol|interval -> rows / FAILED 标记(失败也缓存,同一次运行不重复打上游)
  const FAILED = { failed: true };
  const fetchCached = async (symbol, interval) => {
    const key = symbol + "|" + interval;
    if (cache.has(key)) {
      const hit = cache.get(key);
      if (hit === FAILED) throw new Error("upstream failed (cached)");
      return hit;
    }
    if (report.fetched >= maxFetches) throw new Error("fetch budget exhausted");
    try {
      const rows = await fetchKlines(symbol, interval, limit);
      report.fetched += 1;
      if (!rows || !rows.length) throw new Error("empty data");
      cache.set(key, rows);
      return rows;
    } catch (error) {
      report.fetched += 1;
      cache.set(key, FAILED);
      throw error;
    }
  };

  const sorted = signals.slice().sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
  let processed = 0;
  for (const signal of sorted) {
    if (processed >= maxSignals) break;
    report.scanned += 1;
    const existing = outcomeMap.get(signal.id) || null;
    let due = [];
    try {
      due = dueHorizons(signal, existing, now);
    } catch (error) {
      due = [];
    }
    if (!due.length) continue;
    processed += 1;
    report.due += 1;

    const seriesByHorizon = {};
    for (const horizon of due) {
      const interval = needIntervalOf(horizon);
      try {
        const rows = await fetchCached(signal.symbol, interval);
        if (rows && rows.length) seriesByHorizon[horizon] = rows;
      } catch (error) {
        // 单个数据源失败:保持 Pending,后续重试
        report.errors.push(`${signal.symbol} ${interval}: ${error.message}`);
      }
    }
    if (!Object.keys(seriesByHorizon).length) {
      report.failed += 1;
      continue;
    }
    let fresh = null;
    try {
      fresh = resolveSignalOutcomes({ signal, seriesByHorizon, nowMs: now, k: opts.k });
    } catch (error) {
      report.errors.push(`${signal.id}: ${error.message}`);
      report.failed += 1;
      continue;
    }
    if (!fresh || !fresh.resolved_count) continue;
    const merged = mergeOutcome(existing, fresh);
    try {
      await store.outcomes.put(merged);
      outcomeMap.set(signal.id, merged);
      report.resolved += 1;
      report.horizons += fresh.resolved_count;
    } catch (error) {
      report.errors.push(`${signal.id} write: ${error.message}`);
      report.failed += 1;
    }
  }
  return report;
}

// ---- 3) 验证视图 ----
export const REGIME_FILTERS = ["全部", "Strong Uptrend", "Weak Uptrend", "Bullish Range", "Range", "Bearish Range", "Weak Downtrend", "Strong Downtrend"];

// 数据来源隔离:live(实时记录) / backtest(历史回测) / all(仅用于对比)
export const SOURCE_FILTERS = [
  { key: "live", label: "实时记录" },
  { key: "backtest", label: "历史回测" },
  { key: "all", label: "全部" }
];
export const SOURCE_ZH = { live: "实时记录", backtest: "历史回测", all: "全部" };
export const DEFAULT_SOURCE = "live";

export function filterBySource(records, source) {
  const list = records || [];
  const s = source || DEFAULT_SOURCE;
  if (s === "all") return list;
  return list.filter((r) => ((r.signal && r.signal.source) || "live") === s);
}

export function filterRecords(records, horizon, regime) {
  const list = (records || []).filter((r) => r && r.signal);
  if (!regime || regime === "全部") return list;
  return list.filter((r) => r.signal.market_regime_label === regime);
}

// 列表条目(只取渲染需要的字段,避免把整个对象塞进 DOM)
export function listRow(record, horizon) {
  const s = record.signal;
  const o = record.outcome;
  const resolved = o && o[`outcome_${horizon}`] != null;
  return {
    id: s.id,
    symbol: s.symbol,
    interval: s.interval,
    timestamp: Number(s.timestamp),
    price: Number(s.price),
    direction: s.direction,
    signal_strength: Number(s.signal_strength),
    confidence: Number(s.confidence),
    risk_level: s.risk_level,
    risk_score: Number(s.risk_score),
    market_regime: s.market_regime_label,
    source: s.source,
    backtest_run_id: s.backtest_run_id || null,
    limited: Boolean(s.limited_data),
    pending_all: !o || !o.resolved_count,
    outcome: resolved ? o[`outcome_${horizon}`] : null,
    verdict: resolved ? (o[`verdict_${horizon}`] || null) : null,
    return_pct: resolved ? o[`return_${horizon}`] : null,
    mfe: resolved ? o[`mfe_${horizon}`] : null,
    mae: resolved ? o[`mae_${horizon}`] : null,
    horizons_resolved: o ? String(o.horizons_resolved || "").split(",").filter(Boolean) : []
  };
}

export function buildValidationView(records, options) {
  const opts = options || {};
  const horizon = opts.horizon || "1h";
  const regime = opts.regime || "全部";
  const source = opts.source || DEFAULT_SOURCE;
  // 先按环境筛选,再按来源隔离 —— 统计只使用当前来源的数据(默认仅实时记录)
  const regimeFiltered = filterRecords(records, horizon, regime);
  const filtered = filterBySource(regimeFiltered, source);
  const bundle = buildStatsBundle(filtered, horizon);
  const engineVersion = (() => {
    const counts = new Map();
    for (const r of filtered) {
      const v = r.signal.engine_version || "unknown";
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    let best = null;
    for (const [k, n] of counts) if (!best || n > best[1]) best = [k, n];
    return best ? best[0] : null;
  })();
  const resolvedCount = filtered.filter((r) => r.outcome && r.outcome[`outcome_${horizon}`] != null).length;
  return {
    horizon,
    regime,
    source,
    source_label: SOURCE_ZH[source] || source,
    engine_version: engineVersion,
    total: filtered.length,
    resolved: resolvedCount,
    pending: filtered.length - resolvedCount,
    quality: sampleQuality(resolvedCount),
    overall: bundle.overall,
    calibration: bundle.calibration,
    by_confidence: bundle.by_confidence,
    by_regime: bundle.by_regime,
    // 来源分组按"环境筛选后"的全量计算,便于对比 live 与 backtest
    by_source: buildStatsBundle(regimeFiltered, horizon).by_source,
    by_symbol: bundle.by_symbol,
    all_horizons: bundle.all_horizons,
    rows: filtered
      .slice()
      .sort((a, b) => Number(b.signal.timestamp) - Number(a.signal.timestamp))
      .map((r) => listRow(r, horizon))
  };
}

// 详情视图:把 JSON 字段解析好,避免页面重复解析
export function detailView(record) {
  if (!record || !record.signal) return null;
  const s = record.signal;
  const o = record.outcome;
  const parse = (v, fallback) => {
    if (v == null || v === "") return fallback;
    try {
      const out = JSON.parse(v);
      return out == null ? fallback : out;
    } catch (error) {
      return fallback;
    }
  };
  const horizons = HORIZONS.map((h) => {
    const resolved = o && o[`outcome_${h}`] != null;
    return {
      horizon: h,
      resolved,
      price: resolved ? o[`price_${h}`] : null,
      ret_pct: resolved ? o[`return_${h}`] : null,
      outcome: resolved ? o[`outcome_${h}`] : null,
      verdict: resolved ? o[`verdict_${h}`] || null : null,
      mfe: resolved ? o[`mfe_${h}`] : null,
      mae: resolved ? o[`mae_${h}`] : null,
      threshold: resolved ? o[`threshold_${h}`] : null
    };
  });
  return {
    id: s.id,
    symbol: s.symbol,
    interval: s.interval,
    timestamp: Number(s.timestamp),
    data_close_time: Number(s.data_close_time || s.timestamp),
    price: Number(s.price),
    change24h: s.change24h,
    direction: s.direction,
    signal_strength: s.signal_strength,
    confidence: s.confidence,
    risk_score: s.risk_score,
    risk_level: s.risk_level,
    market_regime: s.market_regime_label,
    regime_trend: s.market_regime_trend_market,
    regime_adx: s.market_regime_adx,
    regime_atr_pct: s.market_regime_atr_pct,
    structure_label: s.structure_label,
    last_swing_high: s.structure_last_swing_high,
    last_swing_low: s.structure_last_swing_low,
    support_zones: parse(s.support_zones, []),
    resistance_zones: parse(s.resistance_zones, []),
    timeframes: parse(s.timeframes, {}),
    volume_pattern: s.volume_pattern,
    volume_ratio20: s.volume_ratio20,
    volatility_level: s.volatility_level,
    btc_state: s.btc_state,
    btc_corr: s.btc_corr,
    breadth_up_pct: s.breadth_up_pct,
    reasons: parse(s.reasons, []),
    risks: parse(s.risks, []),
    invalidation: parse(s.invalidation, []),
    features: parse(s.features, {}),
    engine_version: s.engine_version,
    feature_version: s.feature_version,
    source: s.source,
    backtest_run_id: s.backtest_run_id || null,
    limited_data: s.limited_data,
    horizons,
    resolved_count: o ? o.resolved_count : 0
  };
}

// 需要跳过的信号(数据不足的样本不进入统计,避免污染校准)
export function isUsable(record) {
  return Boolean(record && record.signal && !record.signal.limited_data);
}

export function usableRecords(records) {
  return (records || []).filter(isUsable);
}

// ---- 4) 回测会话(复用已测试的 backtest 引擎;分块异步,长时间运行不锁界面) ----
export const BACKTEST_BARS = [300, 600, 1000];
export const BACKTEST_INTERVALS = ["15m", "30m", "1h", "4h", "1d"];
export const MIN_BACKTEST_BARS = 200;

// 回测取数计划(去重;含 BTC 参照周期与近期 1m 粒度)
export function backtestFetchPlan(input) {
  const interval = input.interval || "1h";
  const bars = Number(input.bars) || 600;
  const symbol = input.symbol;
  const span = bars * intervalMsOf(interval);
  const list = [];
  const push = (key, tf, limit) => {
    const id = key + "|" + tf;
    if (list.some((x) => x.id === id)) return;
    list.push({ id, key, tf, limit: Math.max(60, Math.min(1500, limit)) });
  };
  push("sym", interval, bars);
  if (interval !== "1h") push("sym", "1h", Math.ceil(span / 3600000) + 60);
  push("sym", "4h", Math.ceil(span / 14400000) + 60);
  push("sym", "1d", Math.ceil(span / 86400000) + 30);
  push("sym", "1m", 1000);
  if (symbol !== "BTCUSDT") {
    push("btc", interval, bars);
    if (interval !== "1h") push("btc", "1h", Math.ceil(span / 3600000) + 60);
    push("btc", "4h", Math.ceil(span / 14400000) + 60);
    push("btc", "1d", Math.ceil(span / 86400000) + 30);
  }
  return { symbol, interval, bars, span, fetches: list };
}

export async function saveBacktestRun(store, run) {
  await store.generic.put("backtest_runs", run);
  return run;
}

export async function recentBacktestRuns(store, limit) {
  const runs = await store.generic.all("backtest_runs", 200);
  return (runs || []).sort((a, b) => Number(b.started_at) - Number(a.started_at)).slice(0, limit || 8);
}

export function backtestRunId(symbol, interval, bars, nowMs) {
  return `bt_${symbol}_${interval}_${bars}_${nowMs}`;
}

// 执行一次回测:取数 → 时间重放 → 生成信号 → 解析结果 → 保存 → 统计
export async function runBacktestSession(input) {
  const store = input.store;
  const symbol = String(input.symbol || "BTCUSDT").toUpperCase();
  const interval = input.interval || "1h";
  const bars = Number(input.bars) || 600;
  const now = Number(input.nowMs) || Date.now();
  const onStage = input.onStage || (() => {});
  const onProgress = input.onProgress || (() => {});
  const fetchKlines = input.fetchKlines;
  const plan = backtestFetchPlan({ symbol, interval, bars });
  const runId = backtestRunId(symbol, interval, bars, now);
  const startedAt = now;

  // 阶段1:取数
  const klines = {};
  const btcKlines = {};
  const requested = {};
  const failures = [];
  let fetched = 0;
  for (const f of plan.fetches) {
    requested[f.id] = f.limit;
    onStage({ stage: "fetch", label: "获取历史K线", done: fetched, total: plan.fetches.length, detail: f.key === "btc" ? "BTCUSDT " + f.tf : f.tf });
    try {
      const rows = await fetchKlines(f.key === "btc" ? "BTCUSDT" : symbol, f.tf, f.limit);
      const target = f.key === "btc" ? btcKlines : klines;
      target[f.tf] = Array.isArray(rows) ? rows : [];
    } catch (error) {
      failures.push(f.id + ": " + (error && error.message ? error.message : "fetch failed"));
      const target = f.key === "btc" ? btcKlines : klines;
      if (!target[f.tf]) target[f.tf] = [];
    }
    fetched += 1;
  }

  const mainRows = klines[interval] || [];
  const requestedMain = requested["sym|" + interval] || bars;
  const shortfalls = Object.keys(klines)
    .filter((tf) => requested["sym|" + tf] && (klines[tf] || []).length < requested["sym|" + tf] * 0.9)
    .map((tf) => tf + " " + (klines[tf] || []).length + "/" + requested["sym|" + tf]);
  const insufficient = mainRows.length < MIN_BACKTEST_BARS;
  const note = insufficient
    ? "历史数据不足(仅取得 " + mainRows.length + " 根 " + interval + " K线),已停止本次回测"
    : shortfalls.length
      ? "历史数据不足,已使用可获得范围(" + mainRows.length + "/" + requestedMain + " 根 " + interval + " K线;" + shortfalls.join(", ") + ")"
      : "";

  if (insufficient) {
    await saveBacktestRun(store, {
      id: runId, name: symbol + " " + interval + " x" + bars, symbol, interval, bars,
      started_at: startedAt, finished_at: Date.now(), status: "insufficient",
      total_signals: 0, resolved_signals: 0, timeframes: Object.keys(klines),
      engine_version: input.engineVersion || null, note
    });
    return { ok: false, reason: "insufficient_data", runId, message: note, fetched, failures, bars: mainRows.length };
  }

  // 阶段2:历史时间重放(只喂入 T 及以前已收盘的K线)
  onStage({ stage: "replay", label: "重放历史时间", done: 0, total: mainRows.length });
  const replay = await replaySymbol({
    symbol,
    interval,
    tfRows: klines,
    btcRows: btcKlines,
    nowMs: now,
    step: Number(input.step) || 1,
    minHistory: 60,
    maxSignals: Number(input.maxSignals) || 4000,
    onProgress: async (p) => {
      await onProgress({ stage: "replay", scanned: p.scanned, total: p.total, signals: p.signals });
    }
  });

  // 阶段3:生成 Signals
  onStage({ stage: "signals", label: "生成 Signals", done: replay.signals.length, total: replay.signals.length });
  const signals = replay.signals.map((s) => ({ ...s, backtest_run_id: runId }));

  // 阶段4:解析 Outcomes(只用信号之后已收盘的K线)
  onStage({ stage: "outcomes", label: "解析 Outcomes", done: 0, total: signals.length });
  const series = pickSeriesByHorizon({
    "1m": klines["1m"],
    "15m": klines["15m"],
    "1h": klines["1h"] || klines[interval === "1h" ? "1h" : interval],
    "4h": klines["4h"]
  });
  const joined = attachOutcomes(signals, series, now);
  const outcomes = joined.filter((j) => j.outcome).map((j) => j.outcome);
  onStage({ stage: "outcomes", label: "解析 Outcomes", done: outcomes.length, total: signals.length });

  // 阶段5:保存(回测 id 为 bt_ 前缀,不会覆盖实时 Signal)
  await store.signals.putMany(signals);
  await store.outcomes.putMany(outcomes);
  await saveBacktestRun(store, {
    id: runId, name: symbol + " " + interval + " x" + bars, symbol, interval, bars,
    started_at: startedAt, finished_at: Date.now(), status: "completed",
    total_signals: signals.length, resolved_signals: outcomes.length,
    timeframes: Object.keys(klines).filter((tf) => (klines[tf] || []).length),
    engine_version: signals.length ? signals[0].engine_version : null, note
  });

  // 阶段6:统计
  onStage({ stage: "stats", label: "计算统计" });
  const outcomeMap = new Map(outcomes.map((o) => [o.signal_id, o]));
  const records = signals.map((s) => ({ signal: s, outcome: outcomeMap.get(s.id) || null }));
  const view = buildValidationView(records, { horizon: input.horizon || "1h", regime: "全部", source: "backtest" });
  for (const h of HORIZONS) {
    const s = summarize(records, h);
    await store.generic.put("backtest_results", {
      id: runId + "|" + h, run_id: runId, symbol, horizon: h,
      samples: s.samples, resolved: s.resolved,
      accuracy: s.accuracy, bull_accuracy: s.bull_accuracy, bear_accuracy: s.bear_accuracy,
      neutral_rate: s.neutral_rate, avg_return: s.avg_return, median_return: s.median_return,
      avg_mfe: s.avg_mfe, avg_mae: s.avg_mae, created_at: Date.now()
    });
  }
  onStage({ stage: "done", label: "完成", done: signals.length, total: signals.length });
  return {
    ok: true,
    runId,
    view,
    note,
    signals: signals.length,
    resolved: outcomes.length,
    scanned: replay.scanned,
    skipped: replay.skipped,
    fetched,
    failures,
    timeframes: Object.keys(klines).filter((tf) => (klines[tf] || []).length)
  };
}

export { summarize };
