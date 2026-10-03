// history/record.js · 分析结果 → 历史 Signal 记录(纯函数)
// 负责:字段扁平化(与 SQLite 表一致) + 记录去重(防止每秒写入重复信号)
import { FEATURE_VERSION } from "./schema.js";
import { intervalMsOf } from "./outcome.js";

function json(v) {
  if (v == null) return null;
  try {
    return JSON.stringify(v);
  } catch (error) {
    return null;
  }
}

function b01(v) {
  return v ? 1 : 0;
}

// 由 computeAnalysis 的输出生成可入库的扁平记录
export function signalRecordFromAnalysis(analysis, opts) {
  const o = opts || {};
  const symbol = analysis.symbol;
  const interval = analysis.interval;
  const timestamp = Number(o.timestampMs) || Number(analysis.data_close_time) || Date.now();
  const id = o.id || `sig_${symbol}_${interval}_${timestamp}`;
  return {
    id,
    symbol,
    interval,
    timestamp,
    price: Number(analysis.price) || null,
    change24h: analysis.change24h == null ? null : Number(analysis.change24h),
    market_regime_label: analysis.market_regime ? analysis.market_regime.label : null,
    market_regime_trend_market: b01(analysis.market_regime && analysis.market_regime.trend_market),
    market_regime_vol_state: analysis.market_regime ? analysis.market_regime.vol_state : null,
    market_regime_adx: analysis.market_regime ? analysis.market_regime.adx : null,
    market_regime_atr_pct: analysis.market_regime ? analysis.market_regime.atr_pct : null,
    direction: analysis.direction,
    signal_strength: Number(analysis.signal_strength),
    confidence: Number(analysis.confidence),
    risk_score: Number(analysis.risk_score),
    risk_level: analysis.risk_level,
    timeframes: json(analysis.timeframes),
    structure_label: analysis.structure ? analysis.structure.label : null,
    structure_hh: analysis.structure ? analysis.structure.hh : null,
    structure_hl: analysis.structure ? analysis.structure.hl : null,
    structure_lh: analysis.structure ? analysis.structure.lh : null,
    structure_ll: analysis.structure ? analysis.structure.ll : null,
    structure_last_swing_high: analysis.structure ? analysis.structure.last_swing_high : null,
    structure_last_swing_low: analysis.structure ? analysis.structure.last_swing_low : null,
    support_zones: json(analysis.support_zones),
    resistance_zones: json(analysis.resistance_zones),
    volume_ratio20: analysis.volume ? analysis.volume.ratio20 : null,
    volume_spike: b01(analysis.volume && analysis.volume.spike),
    volume_pattern: analysis.volume ? analysis.volume.pattern : null,
    volatility_level: analysis.volatility ? analysis.volatility.level : null,
    volatility_atr_pct: analysis.volatility ? analysis.volatility.atrPct : null,
    volatility_ratio: analysis.volatility ? analysis.volatility.ratio : null,
    btc_state: analysis.btc_context ? analysis.btc_context.state : null,
    btc_corr: analysis.btc_context ? analysis.btc_context.corr : null,
    btc_rel_strength: analysis.btc_context ? analysis.btc_context.rel_strength : null,
    breadth_up_pct: analysis.breadth ? analysis.breadth.up_pct : null,
    breadth_sample: analysis.breadth ? analysis.breadth.sample : null,
    tf_conflict: b01(analysis.tf_conflict),
    anomaly_detected: b01(analysis.anomaly && analysis.anomaly.detected),
    anomaly_kinds: json(analysis.anomaly ? analysis.anomaly.kinds : []),
    features: json(analysis.features),
    reasons: json(analysis.reasons || []),
    risks: json(analysis.risks || []),
    invalidation: json(analysis.invalidation || []),
    engine_version: analysis.model_version || null,
    feature_version: FEATURE_VERSION,
    data_close_time: analysis.data_close_time == null ? null : Number(analysis.data_close_time),
    is_candle_closed: 1,
    limited_data: b01(analysis.limited_data),
    forming_candle_count: analysis.forming_candle ? analysis.forming_candle.count : 0,
    source: o.source || "live",
    backtest_run_id: o.runId || null,
    created_at: Date.now()
  };
}

// 去重:只有出现实质变化才写入新记录(方向/环境/强度/置信度/风险/异常/新的已收盘K线)
// 注意:同一条K线内出现实质变化(如方向翻转)允许作为修订记录再次写入,由调用方决定 id 修订号
export function shouldRecordSignal(prev, next) {
  if (!prev) return { record: true, reason: "first" };
  if (prev.market_regime_label !== next.market_regime_label) return { record: true, reason: "regime_change" };
  if (prev.direction !== next.direction) return { record: true, reason: "direction_change" };
  if (Math.abs((prev.signal_strength || 0) - (next.signal_strength || 0)) >= 6) return { record: true, reason: "strength_change" };
  if (Math.abs((prev.confidence || 0) - (next.confidence || 0)) >= 4) return { record: true, reason: "confidence_change" };
  if (prev.risk_level !== next.risk_level) return { record: true, reason: "risk_change" };
  if (Boolean(prev.anomaly_detected) !== Boolean(next.anomaly_detected)) return { record: true, reason: "anomaly_change" };
  if (next.data_close_time != null && prev.data_close_time != null && next.data_close_time !== prev.data_close_time) {
    return { record: true, reason: "new_closed_candle" };
  }
  return { record: false, reason: "no_material_change" };
}

// 决定写入用 id:同一根K线内已有记录且本次是实质变化 → 追加修订号(r2/r3...)
export function resolveRecordId(baseId, existingIds) {
  if (!existingIds || !existingIds.has(baseId)) return baseId;
  let n = 2;
  while (existingIds.has(`${baseId}_r${n}`)) n += 1;
  return `${baseId}_r${n}`;
}

// 从记录列表里找同一 symbol+interval 的最近一条(时间倒序输入或内部排序)
export function latestOf(signals, symbol, interval) {
  let best = null;
  for (const s of signals || []) {
    if (s.symbol !== symbol || s.interval !== interval) continue;
    if (!best || Number(s.timestamp) > Number(best.timestamp)) best = s;
  }
  return best;
}

// 存储上限保护:每个 symbol+interval 最多保留 keepPerSeries 条最新的
export function prunePlan(signals, keepPerSeries) {
  const keep = Number(keepPerSeries) || 2000;
  const groups = new Map();
  for (const s of signals || []) {
    const key = s.symbol + "|" + s.interval;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const dropped = [];
  for (const list of groups.values()) {
    if (list.length <= keep) continue;
    list.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
    for (const s of list.slice(keep)) dropped.push(s.id);
  }
  return dropped;
}

// 生成回测信号 id(可重复运行不产生重复记录)
export function backtestSignalId(symbol, interval, closeTimeMs) {
  return `bt_${symbol}_${interval}_${closeTimeMs}`;
}

// 判断信号是否已经"到点"该去解析(用于决定拉数据的时机)
// 只加 60 秒余量:是否真的可解析由 outcome.js 的已收盘K线校验兜底
export function dueHorizons(signal, outcome, nowMs) {
  const anchor = Number(signal.data_close_time) || Number(signal.timestamp);
  const now = Number(nowMs) || Date.now();
  const due = [];
  const map = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000, "24h": 86400000 };
  for (const h of Object.keys(map)) {
    if (outcome && outcome[`outcome_${h}`]) continue;
    if (now >= anchor + map[h] + 60000) due.push(h);
  }
  return due;
}
