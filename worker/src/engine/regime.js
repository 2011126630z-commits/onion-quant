// engine/regime.js · MarketRegimeEngine(趋势/区间/波动状态)
// 由 tools/migrate-split.mjs 从 V9 单文件拆分而来;逻辑未改动

import { emaLast, adxLast, slopePct, bbLast, atrLast, trueRanges } from "./indicators.js";
import { median, r2 } from "./utils.js";

function marketRegime(rows, structure) {
  if (rows.length < 40) return { label: "Range", trendMarket: false, volState: "Normal", adx: null, atrPct: null, bbWidthPct: null, slope10: null };
  const closes = rows.map((r) => r.close);
  const price = closes[closes.length - 1];
  const e20 = emaLast(closes, 20), e50 = emaLast(closes, 50), e200 = emaLast(closes, 200);
  const ax = adxLast(rows, 14);
  const slope = slopePct(closes, 10);
  const bb = bbLast(closes, 20, 2);
  const atr = atrLast(rows, 14);
  const atrPct = atr && price ? atr / price * 100 : 0;
  const trs = trueRanges(rows).slice(-100);
  const medTr = median(trs) || atr || 1;
  const volRatio = atr / medTr;
  let bias = 0;
  if (e20 != null && e50 != null) bias += e20 > e50 ? 1 : -1;
  if (e50 != null && e200 != null) bias += e50 > e200 ? 1 : -1;
  bias += structure.label === "上涨结构" ? 1 : structure.label === "下降结构" ? -1 : 0;
  if (Math.abs(slope) > 0.4) bias += slope > 0 ? 1 : -1;
  const adx = ax ? ax.adx : null;
  let label = "Range";
  if (adx != null && adx >= 25 && bias >= 3) label = "Strong Uptrend";
  else if (adx != null && adx >= 18 && bias >= 2) label = "Weak Uptrend";
  else if (adx != null && adx >= 25 && bias <= -3) label = "Strong Downtrend";
  else if (adx != null && adx >= 18 && bias <= -2) label = "Weak Downtrend";
  else if (bias >= 1) label = "Bullish Range";
  else if (bias <= -1) label = "Bearish Range";
  const volState = volRatio >= 1.5 ? "Expansion" : volRatio <= 0.72 ? "Compression" : "Normal";
  return { label, trendMarket: adx != null && adx >= 18, volState, adx: ax ? Math.round(adx * 10) / 10 : null, atrPct: r2(atrPct), bbWidthPct: bb ? r2(bb.widthPct) : null, slope10: r2(slope) };
}
function regimeLite(rows) {
  if (rows.length < 40) return { label: "Range" };
  const closes = rows.map((r) => r.close);
  const e20 = emaLast(closes, 20), e50 = emaLast(closes, 50);
  const ax = adxLast(rows, 14);
  const slope = slopePct(closes, 10);
  let bias = 0;
  if (e20 != null && e50 != null) bias += e20 > e50 ? 1 : -1;
  if (Math.abs(slope) > 0.4) bias += slope > 0 ? 1 : -1;
  const adx = ax ? ax.adx : null;
  let label = "Range";
  if (adx != null && adx >= 25 && bias >= 2) label = "Strong Uptrend";
  else if (adx != null && adx >= 18 && bias >= 1) label = "Weak Uptrend";
  else if (adx != null && adx >= 25 && bias <= -2) label = "Strong Downtrend";
  else if (adx != null && adx >= 18 && bias <= -1) label = "Weak Downtrend";
  else if (bias >= 1) label = "Bullish Range";
  else if (bias <= -1) label = "Bearish Range";
  return { label };
}

// ---- VolumeAnalyzer / VolatilityAnalyzer / 异常检测 ----

export { marketRegime, regimeLite };
