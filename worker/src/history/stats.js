// history/stats.js · 历史表现统计(纯函数,输入记录数组,输出统计对象)
// 记录结构: { signal, outcome }  (outcome 可为 null —— 等待验证)
import { HORIZONS, HORIZON_MS } from "./schema.js";
import { directionSign } from "./outcome.js";

export const CONF_BUCKETS = ["50-59", "60-69", "70-79", "80-89", "90-100"];
export const REGIME_ORDER = ["Strong Uptrend", "Weak Uptrend", "Bullish Range", "Range", "Bearish Range", "Weak Downtrend", "Strong Downtrend"];

export function medianOf(values) {
  const arr = (values || []).filter((v) => isFinite(v)).sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return Math.round((arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2) * 1000) / 1000;
}

export function meanOf(values) {
  const arr = (values || []).filter((v) => isFinite(v));
  if (!arr.length) return null;
  return Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 1000) / 1000;
}

export function confidenceBucket(confidence) {
  const c = Number(confidence);
  if (!isFinite(c)) return "未知";
  if (c < 50) return "<50";
  if (c < 60) return "50-59";
  if (c < 70) return "60-69";
  if (c < 80) return "70-79";
  if (c < 90) return "80-89";
  return "90-100";
}

// 单组统计(某一验证周期)
export function summarize(records, horizon) {
  const resolved = [];
  for (const rec of records || []) {
    const o = rec.outcome;
    if (!o) continue;
    if (o[`outcome_${horizon}`] == null) continue;
    resolved.push(rec);
  }

  let correct = 0;
  let wrong = 0;
  let neutral = 0;
  let bullCorrect = 0;
  let bullTotal = 0;
  let bearCorrect = 0;
  let bearTotal = 0;
  const dirReturns = [];
  const rawReturns = [];
  const mfes = [];
  const maes = [];

  for (const rec of resolved) {
    const s = rec.signal;
    const o = rec.outcome;
    const outcome = o[`outcome_${horizon}`];
    const ret = Number(o[`return_${horizon}`]);
    const sign = directionSign(s.direction);

    if (outcome === "Neutral") neutral += 1;
    else if (sign > 0) {
      bullTotal += 1;
      if (outcome === "Bullish") { correct += 1; bullCorrect += 1; } else wrong += 1;
    } else if (sign < 0) {
      bearTotal += 1;
      if (outcome === "Bearish") { correct += 1; bearCorrect += 1; } else wrong += 1;
    }

    if (isFinite(ret)) {
      rawReturns.push(ret);
      dirReturns.push(sign === 0 ? 0 : sign * ret);
    }
    const mfe = Number(o[`mfe_${horizon}`]);
    const mae = Number(o[`mae_${horizon}`]);
    if (isFinite(mfe)) mfes.push(mfe);
    if (isFinite(mae)) maes.push(mae);
  }

  const decisive = correct + wrong;
  return {
    horizon,
    samples: (records || []).length,
    resolved: resolved.length,
    correct,
    wrong,
    neutral,
    accuracy: decisive ? Math.round((correct / decisive) * 1000) / 10 : null,
    neutral_rate: resolved.length ? Math.round((neutral / resolved.length) * 1000) / 10 : null,
    bull_accuracy: bullTotal ? Math.round((bullCorrect / bullTotal) * 1000) / 10 : null,
    bull_samples: bullTotal,
    bear_accuracy: bearTotal ? Math.round((bearCorrect / bearTotal) * 1000) / 10 : null,
    bear_samples: bearTotal,
    avg_return: meanOf(dirReturns),
    median_return: medianOf(dirReturns),
    avg_raw_return: meanOf(rawReturns),
    avg_mfe: meanOf(mfes),
    avg_mae: meanOf(maes)
  };
}

export function overallStats(records, horizon) {
  return summarize(records, horizon);
}

export function statsByRegime(records, horizon) {
  const groups = new Map();
  for (const rec of records || []) {
    const key = (rec.signal && rec.signal.market_regime_label) || "未知";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }
  const out = [];
  for (const regime of REGIME_ORDER) {
    if (!groups.has(regime)) continue;
    out.push({ key: regime, ...summarize(groups.get(regime), horizon) });
  }
  for (const [key, list] of groups) {
    if (REGIME_ORDER.includes(key)) continue;
    out.push({ key, ...summarize(list, horizon) });
  }
  return out;
}

export function statsByConfidence(records, horizon) {
  const groups = new Map();
  for (const rec of records || []) {
    const key = confidenceBucket(rec.signal && rec.signal.confidence);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }
  const order = ["<50", ...CONF_BUCKETS];
  const out = [];
  for (const key of order) {
    if (!groups.has(key)) continue;
    const list = groups.get(key);
    const confs = list.map((r) => Number(r.signal.confidence)).filter((v) => isFinite(v));
    out.push({
      key,
      predicted_confidence: meanOf(confs),
      ...summarize(list, horizon)
    });
  }
  return out;
}

export function statsByDirection(records, horizon) {
  const groups = new Map();
  for (const rec of records || []) {
    const key = (rec.signal && rec.signal.direction) || "未知";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }
  const order = ["Strong Bullish", "Bullish", "Neutral", "Bearish", "Strong Bearish"];
  const out = [];
  for (const key of order) {
    if (!groups.has(key)) continue;
    out.push({ key, ...summarize(groups.get(key), horizon) });
  }
  return out;
}

// 置信度校准表:预测置信度 vs 实测准确率(如实呈现,不做任何修饰)
export function calibrationTable(records, horizon) {
  const rows = statsByConfidence(records, horizon);
  return rows.map((row) => ({
    bucket: row.key,
    predicted_confidence: row.predicted_confidence,
    observed_accuracy: row.accuracy,
    gap: row.predicted_confidence != null && row.accuracy != null ? Math.round((row.accuracy - row.predicted_confidence) * 10) / 10 : null,
    samples: row.samples,
    resolved: row.resolved,
    neutral_rate: row.neutral_rate
  }));
}

// 按交易对分组
export function statsBySymbol(records, horizon) {
  const groups = new Map();
  for (const rec of records || []) {
    const key = (rec.signal && rec.signal.symbol) || "未知";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }
  const out = [];
  for (const [key, list] of groups) out.push({ key, ...summarize(list, horizon) });
  out.sort((a, b) => b.samples - a.samples);
  return out;
}

// 按数据来源分组(live=实时记录 / backtest=历史回测)
export function statsBySource(records, horizon) {
  const groups = new Map();
  for (const rec of records || []) {
    const key = (rec.signal && rec.signal.source) || "live";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }
  const out = [];
  for (const [key, list] of groups) out.push({ key, ...summarize(list, horizon) });
  return out;
}

export function buildStatsBundle(records, horizon) {
  const pending = (records || []).filter((r) => !r.outcome || r.outcome[`outcome_${horizon}`] == null).length;
  return {
    horizon,
    generated_at: Date.now(),
    total_signals: (records || []).length,
    resolved: (records || []).length - pending,
    pending,
    overall: overallStats(records, horizon),
    by_regime: statsByRegime(records, horizon),
    by_confidence: statsByConfidence(records, horizon),
    by_direction: statsByDirection(records, horizon),
    by_symbol: statsBySymbol(records, horizon),
    by_source: statsBySource(records, horizon),
    calibration: calibrationTable(records, horizon),
    all_horizons: HORIZONS.map((h) => overallStats(records, h))
  };
}

// 每个周期还需要多少样本才算"可参考"(用于 UI 提示,不参与计算)
export function sampleQuality(resolved) {
  if (resolved >= 200) return "high";
  if (resolved >= 60) return "medium";
  if (resolved >= 20) return "low";
  return "insufficient";
}

export function horizonLabel(horizon) {
  return HORIZON_MS[horizon] ? horizon : horizon;
}
