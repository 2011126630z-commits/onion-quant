// engine/timeframes.js · 多周期评估(tfEvaluate)
// 由 tools/migrate-split.mjs 从 V9 单文件拆分而来;逻辑未改动

import { emaLast, rsiLast, macdLast, rocLast } from "./indicators.js";
import { structureQuick } from "./structure.js";

function tfEvaluate(rows) {
  if (rows.length < 30) return { score: 0, label: "Neutral", enough: false };
  const closes = rows.map((r) => r.close);
  const price = closes[closes.length - 1];
  const e9 = emaLast(closes, 9), e21 = emaLast(closes, 21), e55 = emaLast(closes, 55);
  const rsi = rsiLast(closes, 14);
  const macd = macdLast(closes);
  const roc = rocLast(closes, 9);
  const st = structureQuick(rows);
  let score = 0;
  if (e9 != null && e21 != null && e21 !== 0 && e9 !== e21) {
    score += 0.7 * Math.tanh(((e9 - e21) / e21 * 100) / 0.3);
  }
  if (e21 != null && e55 != null && e55 !== 0 && e21 !== e55) {
    score += 0.5 * Math.tanh(((e21 - e55) / e55 * 100) / 0.6);
  }
  if (macd && price) {
    score += 0.4 * Math.tanh((macd.hist / price * 100) / 0.08);
  }
  score += 0.25 * Math.max(-1, Math.min(1, (rsi - 50) / 10));
  score += 0.15 * Math.tanh(roc / 0.5);
  score += st.dir * 0.5;
  score = Math.max(-2, Math.min(2, score));
  const label = score >= 1.1 ? "Strong Bullish" : score >= 0.35 ? "Bullish" : score <= -1.1 ? "Strong Bearish" : score <= -0.35 ? "Bearish" : "Neutral";
  return { score: Math.round(score * 100) / 100, label, enough: true };
}

// ---- BTCContextAnalyzer ----

export { tfEvaluate };
