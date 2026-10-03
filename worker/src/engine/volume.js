// engine/volume.js · VolumeAnalyzer / VolatilityAnalyzer / 异常检测
// 由 tools/migrate-split.mjs 从 V9 单文件拆分而来;逻辑未改动

import { smaLast, atrLast, trueRanges, bbLast, hvLast } from "./indicators.js";
import { median, r2, stdevSrv } from "./utils.js";

function volumeAnalysis(rows) {
  const n = rows.length;
  if (n < 25) return { ratio20: null, ratio50: null, spike: false, pattern: "量能数据不足", divergence: false, volExpand: false };
  const vols = rows.map((r) => r.volume);
  const vNow = vols[n - 1] || 0;
  const avg20 = smaLast(vols, 20);
  const avg50 = smaLast(vols, 50);
  const ratio20 = avg20 ? vNow / avg20 : 1;
  const ratio50 = avg50 ? vNow / avg50 : 1;
  const spike = ratio20 >= 2.5;
  const priceChg10 = n > 11 ? (rows[n - 1].close / rows[n - 11].close - 1) * 100 : 0;
  const recentAvg = smaLast(vols.slice(0, n - 3), 20);
  const volExpand = recentAvg ? vNow / recentAvg > 1.3 : false;
  let pattern = "量能平稳";
  if (priceChg10 > 0.25) pattern = volExpand ? "放量上涨" : "缩量上涨";
  else if (priceChg10 < -0.25) pattern = volExpand ? "放量下跌" : "缩量下跌";
  let divergence = false;
  if (n > 25) {
    const hi20 = Math.max(...rows.slice(-20, -1).map((r) => r.high));
    if (rows[n - 1].high >= hi20 && avg20 && vNow < avg20 * 0.85) divergence = true;
  }
  return { ratio20: r2(ratio20), ratio50: r2(ratio50), spike, pattern, divergence, volExpand };
}
function volatilityAnalysis(rows) {
  if (rows.length < 30) return { level: "Normal", atrPct: null, ratio: null, bbWidthPct: null, hvPct: null };
  const closes = rows.map((r) => r.close);
  const atr = atrLast(rows, 14);
  const price = closes[closes.length - 1];
  const atrPct = atr && price ? atr / price * 100 : 0;
  const trs = trueRanges(rows).slice(-100);
  const base = rows.slice(rows.length - trs.length);
  const pct = trs.map((v, i) => base[i].close ? v / base[i].close * 100 : 0);
  const medPct = median(pct) || atrPct || 1;
  const ratio = medPct ? atrPct / medPct : 1;
  const bb = bbLast(closes, 20, 2);
  const hv = hvLast(closes, 20);
  const level = ratio >= 2 ? "Extreme" : ratio >= 1.4 ? "High" : ratio <= 0.6 ? "Very Low" : ratio <= 0.85 ? "Low" : "Normal";
  return { level, atrPct: r2(atrPct), ratio: r2(ratio), bbWidthPct: bb ? r2(bb.widthPct) : null, hvPct: r2(hv) };
}
function anomalyDetect(rows, vol) {
  const kinds = [];
  if (vol.ratio20 != null && vol.ratio20 >= 3) kinds.push("异常放量");
  const closes = rows.map((r) => r.close);
  if (closes.length >= 15) {
    const rets = [];
    for (let i = closes.length - 30 > 1 ? closes.length - 30 : 1; i < closes.length; i += 1) rets.push(closes[i] / closes[i - 1] - 1);
    if (rets.length >= 10) {
      const sd = stdevSrv(rets) || 1e-9;
      const last = rets[rets.length - 1];
      if (Math.abs(last) > Math.max(3.5 * sd, 0.02)) kinds.push(last > 0 ? "瞬间跳涨" : "瞬间跳跌");
    }
  }
  if (vol.ratio != null && vol.ratio >= 1.9) kinds.push("波动率骤升");
  return { detected: kinds.length > 0, kinds };
}

// ---- 多周期评估(Timeframe Analyst) ----
// 幅度校准:指标贡献随分离幅度饱和(tanh),避免噪声级分离拿到趋势级权重

export { volumeAnalysis, volatilityAnalysis, anomalyDetect };
