// engine/signal.js · SignalEngine + RiskEngine(computeAnalysis)
// 由 tools/migrate-split.mjs 从 V9 单文件拆分而来;逻辑未改动

import { ENGINE_VERSION, TF_LIST, TF_WEIGHTS, DIR_ZH } from "./constants.js";
import { r2, fmtPrice, median } from "./utils.js";
import { emaLast, rsiLast, macdLast, vwapLast, mfiLast, cciLast, stochRsiLast, rocLast, obvDir } from "./indicators.js";
import { analyzeStructure, srZones } from "./structure.js";
import { marketRegime } from "./regime.js";
import { volumeAnalysis, volatilityAnalysis, anomalyDetect } from "./volume.js";
import { tfEvaluate } from "./timeframes.js";
import { btcContext } from "./btc.js";
import { breadthFromTickers } from "./breadth.js";
import { splitClosed, lastClosedCloseTime } from "./candles.js";

function computeAnalysis(input) {
  const now = input.nowMs || Date.now();
  const symbol = input.symbol;
  const interval = input.interval;
  const ticker = input.ticker || {};
  const isBtc = symbol === "BTCUSDT";
  const scoringTfs = [...new Set([...TF_LIST, interval])];
  const weightOf = (tf) => (TF_WEIGHTS[tf] || 1.1) * (tf === interval ? 1.25 : 1);

  const tfResults = {};
  for (const tf of scoringTfs) {
    tfResults[tf] = tfEvaluate(splitClosed(input.tfRows[tf] || [], now).closed);
  }

  const main = splitClosed(input.tfRows[interval] || [], now);
  const rows = main.closed;
  const limitedData = rows.length < 60;
  const lastClose = rows.length ? rows[rows.length - 1].close : 0;
  const price = ticker.lastPrice != null && Number(ticker.lastPrice) > 0 ? Number(ticker.lastPrice) : lastClose;
  const change24h = Number(ticker.priceChangePercent || 0);
  const high24h = Number(ticker.highPrice || 0);
  const low24h = Number(ticker.lowPrice || 0);
  const quoteVolume24h = Number(ticker.quoteVolume || 0);

  const structure = analyzeStructure(rows);
  const zones = srZones(rows, price);
  const vol = volumeAnalysis(rows);
  const vola = volatilityAnalysis(rows);
  const anomaly = anomalyDetect(rows, vol);
  const regime = marketRegime(rows, structure);
  const symCloses = rows.map((r) => r.close);
  const btc = btcContext(symbol, isBtc, interval, input.btcRows || {}, symCloses, input.tickers || [], now);
  const breadth = breadthFromTickers(input.tickers);

  // 方向聚合:加权多周期得分,不做简单投票
  let num = 0, den = 0, agreeUp = 0, agreeDown = 0, counted = 0;
  for (const tf of scoringTfs) {
    const v = tfResults[tf];
    if (!v.enough) continue;
    const w = weightOf(tf);
    num += v.score * w;
    den += w;
    counted += 1;
    if (v.score >= 0.35) agreeUp += 1;
    if (v.score <= -0.35) agreeDown += 1;
  }
  const wscore = den ? num / den : 0;
  const conflict = agreeUp >= 2 && agreeDown >= 2;
  let direction = "Neutral";
  if (!limitedData) {
    if (wscore >= 0.85) direction = "Strong Bullish";
    else if (wscore >= 0.35) direction = "Bullish";
    else if (wscore <= -0.85) direction = "Strong Bearish";
    else if (wscore <= -0.35) direction = "Bearish";
  }
  const bullish = direction === "Bullish" || direction === "Strong Bullish";
  const bearish = direction === "Bearish" || direction === "Strong Bearish";
  let signalStrength = Math.round(50 + wscore * 28);
  signalStrength = Math.max(0, Math.min(100, signalStrength));

  const nearestRes = zones.resistances.length ? zones.resistances[0] : null;
  const nearSup = zones.supports.length ? zones.supports[0] : null;
  const atrPct = vola.atrPct || 0;
  const volumeConfirms = (bullish && (vol.pattern === "放量上涨" || vol.spike)) || (bearish && (vol.pattern === "放量下跌" || vol.spike));

  // Confidence 与 Signal Strength 分开:置信度衡量"这个判断有多可靠"
  let confidence = 48 + Math.abs(wscore) * 22;
  if (counted >= 5 && (agreeUp + agreeDown) / counted >= 0.8) confidence += 6;
  if (conflict) confidence -= 14;
  if (anomaly.detected) confidence -= 12;
  if (vola.level === "High") confidence -= 5;
  if (vola.level === "Extreme") confidence -= 10;
  if (vola.level === "Very Low") confidence -= 4;
  if ((bullish || bearish) && !volumeConfirms) confidence -= 8;
  if (bullish && regime.label.indexOf("Uptrend") >= 0) confidence += 5;
  if (bearish && regime.label.indexOf("Downtrend") >= 0) confidence += 5;
  if (bullish && nearestRes && Math.abs(nearestRes.distPct) < atrPct) confidence -= 7;
  if (bearish && nearSup && Math.abs(nearSup.distPct) < atrPct) confidence -= 7;
  if (btc.state === "BTC Rapid Selloff" && bullish) confidence -= 10;
  if (btc.state === "BTC High Volatility") confidence -= 5;
  if (limitedData) confidence = Math.min(confidence, 40);
  confidence = Math.round(Math.max(5, Math.min(92, confidence)));

  // RiskEngine
  let riskScore = 26 + Math.min(30, atrPct * 2.2);
  if (vola.ratio >= 1.4) riskScore += 6;
  if (vola.ratio >= 2) riskScore += 6;
  if (anomaly.detected) riskScore += 12;
  if (conflict) riskScore += 8;
  if (btc.state === "BTC Rapid Selloff") riskScore += 10;
  if (btc.state === "BTC High Volatility") riskScore += 6;
  if (limitedData) riskScore += 10;
  riskScore = Math.round(Math.max(0, Math.min(100, riskScore)));
  const riskLevel = riskScore < 30 ? "Low" : riskScore < 55 ? "Medium" : riskScore < 75 ? "High" : "Extreme";

  // Explainability: Why / Risks / Invalidation
  const reasons = [];
  const risks = [];
  const invalidation = [];
  if (limitedData) {
    reasons.push("该交易对历史K线不足(Limited Historical Data),仅给出低置信度参考");
  } else {
    const swNote = structure.hh + structure.hl > 0
      ? "(高点抬升" + structure.hh + "次、低点抬升" + structure.hl + "次)"
      : structure.lh + structure.ll > 0 ? "(高点降低" + structure.lh + "次、低点降低" + structure.ll + "次)" : "";
    reasons.push(interval + "周期市场结构:" + structure.label + swNote);
    if (regime.adx != null) {
      reasons.push(regime.trendMarket
        ? "ADX " + regime.adx + "," + (regime.label.indexOf("Up") >= 0 ? "上升趋势" : "下降趋势") + "环境(" + regime.volState + ")"
        : "ADX " + regime.adx + ",趋势强度不足,当前按区间环境处理");
    }
    if (vol.ratio20 != null && vol.ratio20 >= 1.5) reasons.push("成交量是20周期均量的 " + vol.ratio20 + " 倍," + vol.pattern);
    else reasons.push("量能" + (vol.pattern === "量能平稳" ? "平稳,方向未见有效放大配合" : vol.pattern));
    if (!isBtc && btc.btc1hLabel) reasons.push("BTC 1h " + DIR_ZH[btc.btc1hLabel] + "、4h " + DIR_ZH[btc.btc4hLabel] + (btc.corr != null ? ",与BTC相关性 " + btc.corr : ""));
    if (breadth && (breadth.up_pct >= 65 || breadth.up_pct <= 35)) reasons.push("市场广度:成交额前 " + breadth.sample + " 币种中 " + breadth.up_pct + "% 24h上涨");
    if (bullish && nearSup) reasons.push("价格下方有支撑区域 " + fmtPrice(nearSup.lo) + " - " + fmtPrice(nearSup.hi) + "(触及 " + nearSup.touches + " 次)");
    if (bearish && nearestRes) reasons.push("价格上方有阻力区域 " + fmtPrice(nearestRes.lo) + " - " + fmtPrice(nearestRes.hi) + "(触及 " + nearestRes.touches + " 次)");
  }
  if (conflict) risks.push("多周期方向存在冲突,趋势可信度下降");
  for (const kind of anomaly.kinds) risks.push("检测到" + kind + ",极端行情容易被误判为趋势");
  if (bullish && nearestRes && Math.abs(nearestRes.distPct) < atrPct) risks.push("价格贴近上方阻力区域 " + fmtPrice(nearestRes.lo) + " - " + fmtPrice(nearestRes.hi) + ",突破需要量能确认");
  if (bearish && nearSup && Math.abs(nearSup.distPct) < atrPct) risks.push("价格贴近下方支撑区域 " + fmtPrice(nearSup.lo) + " - " + fmtPrice(nearSup.hi) + ",跌破可能引发加速");
  if (btc.state === "BTC Rapid Selloff") risks.push("BTC正在快速下跌,山寨币联动风险升高");
  else if (btc.state === "BTC High Volatility") risks.push("BTC波动率升高,存在联动回调风险");
  if (vola.level === "Very Low") risks.push("波动率压缩,容易出现假突破");
  if ((bullish || bearish) && !volumeConfirms) risks.push("量能未确认方向,不宜追单");
  if (structure.lastLow && (bullish || direction === "Neutral")) invalidation.push("跌破最近结构低点 " + fmtPrice(structure.lastLow.price));
  if (structure.lastHigh && (bearish || direction === "Neutral")) invalidation.push("升破最近结构高点 " + fmtPrice(structure.lastHigh.price));
  if (regime.trendMarket) invalidation.push("ADX回落到20以下且EMA20/50重新纠缠,趋势环境失效");
  if (volumeConfirms) invalidation.push("成交量持续萎缩至20周期均量的0.7倍以下");

  const timeframes = {};
  for (const tf of scoringTfs) timeframes[tf] = tfResults[tf].label;

  // 供后续ML/历史验证使用的特征快照(不进UI)
  const e20 = emaLast(symCloses, 20);
  const e50 = emaLast(symCloses, 50);
  const e200 = emaLast(symCloses, 200);
  const features = {
    rsi14: Math.round(rsiLast(symCloses, 14)),
    macd_hist: r2(macdLast(symCloses) ? macdLast(symCloses).hist : null),
    adx: regime.adx,
    atr_pct: vola.atrPct,
    ema20_dist_pct: e20 && price ? r2((price - e20) / e20 * 100) : null,
    ema50_dist_pct: e50 && price ? r2((price - e50) / e50 * 100) : null,
    ema200_dist_pct: e200 && price ? r2((price - e200) / e200 * 100) : null,
    ema_slope10: regime.slope10,
    vwap_dist_pct: (() => { const vw = vwapLast(rows, 50); return vw && price ? r2((price - vw) / vw * 100) : null; })(),
    bb_width_pct: vola.bbWidthPct,
    obv_dir: obvDir(rows),
    mfi14: (() => { const v = mfiLast(rows, 14); return v == null ? null : Math.round(v); })(),
    cci20: r2(cciLast(rows, 20)),
    stoch_rsi: (() => { const v = stochRsiLast(symCloses); return v == null ? null : Math.round(v); })(),
    roc9: r2(rocLast(symCloses, 9)),
    hv20: vola.hvPct,
    volume_ratio20: vol.ratio20,
    dist_support_pct: nearSup && nearSup.mean ? r2((price - nearSup.mean) / price * 100) : null,
    dist_resistance_pct: nearestRes && nearestRes.mean ? r2((nearestRes.mean - price) / price * 100) : null,
    tf_align: counted ? r2((agreeUp - agreeDown) / counted) : null,
    vol_ratio: vola.ratio,
    btc_corr: btc.corr,
    vol_state_code: regime.volState === "Expansion" ? 1 : regime.volState === "Compression" ? -1 : 0
  };

  return {
    symbol,
    interval,
    model_version: ENGINE_VERSION,
    generated_at: new Date(now).toISOString(),
    data_source: "binance-futures",
    price,
    change24h: r2(change24h),
    high24h,
    low24h,
    quote_volume_24h: quoteVolume24h,
    market_regime: { label: regime.label, trend_market: regime.trendMarket, vol_state: regime.volState, adx: regime.adx, atr_pct: regime.atrPct, bb_width_pct: regime.bbWidthPct },
    direction,
    signal_strength: signalStrength,
    confidence,
    risk_score: riskScore,
    risk_level: riskLevel,
    timeframes,
    tf_conflict: conflict,
    structure: { label: structure.label, hh: structure.hh, hl: structure.hl, lh: structure.lh, ll: structure.ll, last_swing_high: structure.lastHigh ? r2(structure.lastHigh.price) : null, last_swing_low: structure.lastLow ? r2(structure.lastLow.price) : null },
    support_zones: zones.supports.map((z) => ({ lo: r2(z.lo), hi: r2(z.hi), touches: z.touches })),
    resistance_zones: zones.resistances.map((z) => ({ lo: r2(z.lo), hi: r2(z.hi), touches: z.touches })),
    volume: vol,
    volatility: vola,
    anomaly,
    btc_context: { state: btc.state, corr: btc.corr, rel_strength: btc.relStrength },
    breadth,
    features,
    reasons: reasons.slice(0, 5),
    risks: risks.slice(0, 4),
    invalidation: invalidation.slice(0, 3),
    limited_data: limitedData,
    forming_candle: { count: main.forming.length, note: main.forming.length ? "当前K线尚未收盘,未参与本次判断" : "" },
    // V10:本次判断使用的最后一根已收盘K线的收盘时间 —— Signal Outcome 追踪的时间锚点(防 Look-Ahead)
    data_close_time: rows.length ? rows[rows.length - 1].closeTime : null,
    data_candles: rows.length
  };
}

// ---- 编排:取数 + 分析(服务端全部计算,手机端只做展示) ----

export { computeAnalysis };
