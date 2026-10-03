// paper/evidence.js · Bull/Bear/Risk Evidence(本地计算,0 Token,不调用 LLM)
// 输入:规则引擎分析结果 + 可选 ML 概率;输出:bull_score / bear_score / 证据列表 / 风险
import { num, round } from "./accounting.js";

const DIR_BULL = { "Strong Bullish": 1, "Bullish": 0.6, "Neutral": 0, "Bearish": -0.6, "Strong Bearish": -1 };

export function bullEvidence(analysis, ml) {
  const a = analysis || {};
  const items = [];
  let score = 0;
  const tf = a.timeframes || {};
  const bullTfs = Object.keys(tf).filter((k) => /Bullish/.test(tf[k])).length;
  const bearTfs = Object.keys(tf).filter((k) => /Bearish/.test(tf[k])).length;
  if (bullTfs > bearTfs) { score += Math.min(1, (bullTfs - bearTfs) / 3) * 0.9; items.push("多周期偏多(" + bullTfs + "/" + (bullTfs + bearTfs) + ")"); }
  if (a.structure && a.structure.label === "上涨结构") { score += 0.5; items.push("结构:高点与低点抬升"); }
  if (a.market_regime && /Uptrend/.test(a.market_regime.label)) { score += 0.5; items.push("环境:" + a.market_regime.label); }
  if (a.volume && /放量上涨/.test(a.volume.pattern)) { score += 0.35; items.push("量价:放量上涨"); }
  const rsi = num(a.features && a.features.rsi14, 50);
  if (rsi >= 55 && rsi <= 75) { score += 0.2; items.push("RSI " + rsi + " 偏强但未极端"); }
  if (a.btc_context && /Strong|BTC Self/.test(a.btc_context.state)) { score += 0.2; items.push("BTC 联动偏强:" + a.btc_context.state); }
  if (a.support_zones && a.support_zones.length) { score += 0.15; items.push("下方支撑 " + a.support_zones.length + " 个区域"); }
  if (ml && num(ml.probability_bullish) > 0.45) { score += num(ml.probability_bullish) * 0.6; items.push("ML 看涨概率 " + round(num(ml.probability_bullish) * 100, 1) + "%"); }
  if (DIR_BULL[a.direction] > 0) score += DIR_BULL[a.direction] * 0.4;
  return { bull_score: round(Math.max(0, Math.min(2, score)), 3), bull_evidence: items };
}

export function bearEvidence(analysis, ml) {
  const a = analysis || {};
  const items = [];
  let score = 0;
  const tf = a.timeframes || {};
  const bullTfs = Object.keys(tf).filter((k) => /Bullish/.test(tf[k])).length;
  const bearTfs = Object.keys(tf).filter((k) => /Bearish/.test(tf[k])).length;
  if (bearTfs > bullTfs) { score += Math.min(1, (bearTfs - bullTfs) / 3) * 0.9; items.push("多周期偏空(" + bearTfs + "/" + (bullTfs + bearTfs) + ")"); }
  if (a.structure && a.structure.label === "下降结构") { score += 0.5; items.push("结构:高点与低点降低"); }
  if (a.market_regime && /Downtrend/.test(a.market_regime.label)) { score += 0.5; items.push("环境:" + a.market_regime.label); }
  if (a.volume && /放量下跌/.test(a.volume.pattern)) { score += 0.35; items.push("量价:放量下跌"); }
  const rsi = num(a.features && a.features.rsi14, 50);
  if (rsi <= 45 && rsi >= 25) { score += 0.2; items.push("RSI " + rsi + " 偏弱"); }
  if (a.btc_context && a.btc_context.state === "BTC Rapid Selloff") { score += 0.6; items.push("BTC 快速下跌"); }
  if (a.resistance_zones && a.resistance_zones.length) { score += 0.15; items.push("上方阻力 " + a.resistance_zones.length + " 个区域"); }
  if (ml && num(ml.probability_bearish) > 0.45) { score += num(ml.probability_bearish) * 0.6; items.push("ML 看跌概率 " + round(num(ml.probability_bearish) * 100, 1) + "%"); }
  if (DIR_BULL[a.direction] < 0) score += Math.abs(DIR_BULL[a.direction]) * 0.4;
  return { bear_score: round(Math.max(0, Math.min(2, score)), 3), bear_evidence: items };
}

export function evidenceBundle(analysis, ml) {
  const bull = bullEvidence(analysis, ml);
  const bear = bearEvidence(analysis, ml);
  const total = bull.bull_score + bear.bear_score;
  return {
    ...bull,
    ...bear,
    net_bias: round(bull.bull_score - bear.bear_score, 3),
    conflict: total > 0 && bull.bull_score > 0.6 && bear.bear_score > 0.6,
    strength_ratio: total > 0 ? round(Math.max(bull.bull_score, bear.bear_score) / total, 3) : 0
  };
}
