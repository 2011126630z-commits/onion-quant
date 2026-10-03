// history/outcome.js · Signal Outcome 追踪(纯函数)
// 关键约束:
//   1) 防 Look-Ahead Bias —— 只使用信号时点之后【完全收盘】的K线;不含跨过目标时刻的K线
//   2) 噪声区(Noise Zone) —— 阈值按 ATR 与时间尺度动态计算,不同币种不同周期阈值不同
//   3) MFE/MAE —— 以信号方向为准的有利/不利最大偏移
import { HORIZONS, HORIZON_MS } from "./schema.js";

// 噪声区系数:阈值 = k × ATR% × sqrt(horizon/interval);阈值下限/上限(百分比)
export const NOISE_K = 0.5;
export const NOISE_FLOOR_PCT = 0.05;
export const NOISE_CAP_PCT = 5;

// 信号方向符号:看涨 +1 / 看跌 -1 / 中性 0
export function directionSign(direction) {
  if (direction === "Bullish" || direction === "Strong Bullish") return 1;
  if (direction === "Bearish" || direction === "Strong Bearish") return -1;
  return 0;
}

// 动态噪声阈值(%):涨幅小于阈值视为 Neutral
export function noiseThresholdPct(input) {
  const k = input.k == null ? NOISE_K : input.k;
  const atrPct = Number(input.atrPct);
  const intervalMs = Number(input.intervalMs) || 3600000;
  const horizonMs = Number(input.horizonMs) || intervalMs;
  if (!isFinite(atrPct) || atrPct <= 0) return NOISE_FLOOR_PCT;
  const sigma = atrPct * Math.sqrt(horizonMs / intervalMs);
  const thr = k * sigma;
  return Math.min(NOISE_CAP_PCT, Math.max(NOISE_FLOOR_PCT, Math.round(thr * 1000) / 1000));
}

// 结果分类:未来价格相对信号价的涨跌是否超过噪声阈值
export function classifyOutcome(input) {
  const ret = Number(input.retPct);
  const thr = Number(input.thresholdPct);
  if (!isFinite(ret) || !isFinite(thr)) return "Neutral";
  if (ret > thr) return "Bullish";
  if (ret < -thr) return "Bearish";
  return "Neutral";
}

// 裁决:信号方向与结果是否一致(correct/wrong/neutral)
export function verdictOf(direction, outcome) {
  const sign = directionSign(direction);
  if (sign === 0) return outcome === "Neutral" ? "neutral" : "neutral";
  if (outcome === "Neutral") return "neutral";
  if (sign > 0) return outcome === "Bullish" ? "correct" : "wrong";
  return outcome === "Bearish" ? "correct" : "wrong";
}

// MFE/MAE:以信号方向为准(看涨:上涨为有利;看跌:下跌为有利)
export function computeMFEMAE(input) {
  const sp = Number(input.signalPrice);
  const dir = directionSign(input.direction);
  const { highs, lows } = input;
  if (!sp || !highs || !highs.length || !lows || !lows.length) {
    return { mfe_pct: null, mae_pct: null, high_pct: null, low_pct: null };
  }
  let hi = -Infinity;
  let lo = Infinity;
  for (const h of highs) if (isFinite(h) && h > hi) hi = h;
  for (const l of lows) if (isFinite(l) && l < lo) lo = l;
  const highPct = (hi / sp - 1) * 100;
  const lowPct = (lo / sp - 1) * 100;
  if (dir >= 0) {
    return { mfe_pct: round(highPct), mae_pct: round(-lowPct), high_pct: round(highPct), low_pct: round(lowPct) };
  }
  return { mfe_pct: round(-lowPct), mae_pct: round(highPct), high_pct: round(highPct), low_pct: round(lowPct) };
}

function round(v) {
  return v == null || !isFinite(v) ? null : Math.round(v * 1000) / 1000;
}

// 单周期结果解析(防 Look-Ahead:只用已收盘且不跨越目标时刻的K线)
// candles: [{openTime, open, high, low, close, volume, closeTime}] 需按时间升序
export function resolveHorizon(input) {
  const signal = input.signal;
  const horizon = input.horizon;
  const candles = input.candles || [];
  const nowMs = Number(input.nowMs) || Date.now();
  const k = input.k;
  const horizonMs = HORIZON_MS[horizon];
  if (!horizonMs || !candles.length) return null;

  const anchorMs = Number(signal.data_close_time) || Number(signal.timestamp);
  const signalPrice = Number(signal.price);
  if (!anchorMs || !signalPrice) return null;
  const targetMs = anchorMs + horizonMs;

  // 已收盘K线(排除形成中K线)
  const closed = [];
  for (const c of candles) {
    if (!c || !isFinite(c.closeTime) || !isFinite(c.close)) continue;
    if (c.closeTime > nowMs - 300) continue;
    if (c.closeTime <= anchorMs) continue;
    closed.push(c);
  }
  if (!closed.length) return { horizon, matured: false, reason: "no_closed_candles" };

  const candleMs = medianSpacing(closed);
  const last = closed[closed.length - 1];
  // 数据尚未覆盖到目标时刻 → 未成熟
  if (last.closeTime < targetMs) {
    return { horizon, matured: false, reason: "not_matured", progress_pct: Math.round(((last.closeTime - anchorMs) / horizonMs) * 100) };
  }

  // 目标时刻落在哪根K线内
  let containing = null;
  for (const c of closed) {
    if (c.openTime <= targetMs && c.closeTime >= targetMs) { containing = c; break; }
  }
  // 不跨越目标时刻的完整K线窗口(严格防前视)
  const window = closed.filter((c) => c.closeTime <= targetMs);
  const useCoarse = window.length === 0;
  const path = useCoarse ? (containing ? [containing] : []) : window;
  if (!path.length) return { horizon, matured: false, reason: "no_path" };

  const price = useCoarse && containing ? Number(containing.close) : Number(path[path.length - 1].close);
  const retPct = (price / signalPrice - 1) * 100;
  const thresholdPct = noiseThresholdPct({
    atrPct: signal.volatility_atr_pct != null ? signal.volatility_atr_pct : (signal.market_regime_atr_pct || 0),
    intervalMs: intervalMsOf(signal.interval),
    horizonMs,
    k
  });
  const mm = computeMFEMAE({
    signalPrice,
    direction: signal.direction,
    highs: path.map((c) => Number(c.high)),
    lows: path.map((c) => Number(c.low))
  });
  const outcome = classifyOutcome({ retPct, thresholdPct });
  return {
    horizon,
    matured: true,
    price: round(price),
    ret_pct: round(retPct),
    threshold_pct: thresholdPct,
    outcome,
    verdict: verdictOf(signal.direction, outcome),
    mfe_pct: mm.mfe_pct,
    mae_pct: mm.mae_pct,
    high_pct: mm.high_pct,
    low_pct: mm.low_pct,
    coarse: useCoarse,
    window_count: path.length,
    candle_ms: candleMs
  };
}

export function intervalMsOf(interval) {
  const map = { "1m": 60000, "5m": 300000, "15m": 900000, "30m": 1800000, "1h": 3600000, "4h": 14400000, "1d": 86400000 };
  return map[interval] || 3600000;
}

function medianSpacing(candles) {
  const gaps = [];
  for (let i = 1; i < candles.length && gaps.length < 50; i += 1) {
    const g = candles[i].openTime - candles[i - 1].openTime;
    if (g > 0) gaps.push(g);
  }
  if (!gaps.length) return candles[0].closeTime - candles[0].openTime + 1 || 60000;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

// 批量解析一条信号的全部周期结果
// seriesByHorizon: { "5m": candles[...], "1h": candles[...] } 每个周期用最合适的K线粒度
export function resolveSignalOutcomes(input) {
  const signal = input.signal;
  const seriesByHorizon = input.seriesByHorizon || {};
  const nowMs = Number(input.nowMs) || Date.now();
  const k = input.k;

  const out = {
    signal_id: signal.id,
    symbol: signal.symbol,
    direction: signal.direction,
    signal_timestamp: signal.timestamp,
    signal_price: signal.price,
    horizons_resolved: [],
    resolved_count: 0,
    updated_at: nowMs
  };

  for (const horizon of HORIZONS) {
    const candles = seriesByHorizon[horizon];
    if (!candles || !candles.length) continue;
    const r = resolveHorizon({ signal, horizon, candles, nowMs, k });
    if (!r || !r.matured) continue;
    out[`price_${horizon}`] = r.price;
    out[`return_${horizon}`] = r.ret_pct;
    out[`outcome_${horizon}`] = r.outcome;
    out[`mfe_${horizon}`] = r.mfe_pct;
    out[`mae_${horizon}`] = r.mae_pct;
    out[`high_${horizon}`] = r.high_pct;
    out[`low_${horizon}`] = r.low_pct;
    out[`threshold_${horizon}`] = r.threshold_pct;
    out[`verdict_${horizon}`] = r.verdict;
    out[`resolved_at_${horizon}`] = nowMs;
    out.horizons_resolved.push(horizon);
    out.resolved_count += 1;
  }
  out.horizons_resolved = out.horizons_resolved.join(",");
  return out;
}

// 未解析的周期(用于决定要不要再拉数据)
export function pendingHorizons(signal, outcome, nowMs) {
  const anchorMs = Number(signal.data_close_time) || Number(signal.timestamp);
  const now = nowMs || Date.now();
  const pending = [];
  for (const horizon of HORIZONS) {
    if (outcome && outcome[`outcome_${horizon}`]) continue;
    if (now >= anchorMs + HORIZON_MS[horizon]) pending.push(horizon);
  }
  return pending;
}
