// engine/btc.js · BTCContextAnalyzer(BTC联动/相关性/相对强度)
// 由 tools/migrate-split.mjs 从 V9 单文件拆分而来;逻辑未改动

import { tfEvaluate } from "./timeframes.js";
import { volatilityAnalysis } from "./volume.js";
import { splitClosed } from "./candles.js";
import { r2, pearson } from "./utils.js";

function correlationOf(aCloses, bCloses) {
  const ra = [], rb = [];
  const n = Math.min(aCloses.length, bCloses.length, 101);
  if (n < 31) return null;
  for (let i = aCloses.length - n + 1; i < aCloses.length; i += 1) ra.push(aCloses[i] / aCloses[i - 1] - 1);
  for (let i = bCloses.length - n + 1; i < bCloses.length; i += 1) rb.push(bCloses[i] / bCloses[i - 1] - 1);
  return r2(pearson(ra, rb));
}
function btcContext(symbol, isBtc, interval, btcRowsByTf, symCloses, tickers, now) {
  if (isBtc) return { state: "BTC Self", corr: null, relStrength: null, btc1hLabel: null, btc4hLabel: null };
  const cut = (rows) => splitClosed(rows || [], now).closed;
  const btc1h = tfEvaluate(cut(btcRowsByTf["1h"]));
  const btc4h = tfEvaluate(cut(btcRowsByTf["4h"]));
  const btc15 = tfEvaluate(cut(btcRowsByTf["15m"]));
  const avgScore = ((btc15.enough ? btc15.score : 0) + (btc1h.enough ? btc1h.score : 0) * 1.5 + (btc4h.enough ? btc4h.score : 0) * 1.5) / 4;
  const btcMain = cut(btcRowsByTf[interval]);
  let state = "BTC Stable";
  if (btcMain.length > 10) {
    const drop = btcMain[btcMain.length - 1].close / btcMain[btcMain.length - 4].close - 1;
    if (drop < -0.015) state = "BTC Rapid Selloff";
  }
  if (state === "BTC Stable" && avgScore >= 0.8) state = "BTC Strong";
  else if (state === "BTC Stable" && avgScore <= -0.8) state = "BTC Weak";
  const btcVol = volatilityAnalysis(btcMain.length >= 30 ? btcMain : cut(btcRowsByTf["1h"]));
  if (state === "BTC Stable" && btcVol.ratio != null && btcVol.ratio >= 1.8) state = "BTC High Volatility";
  const symT = (tickers || []).find((t) => t.symbol === symbol);
  const btcT = (tickers || []).find((t) => t.symbol === "BTCUSDT");
  const relStrength = symT && btcT ? r2(Number(symT.priceChangePercent || 0) - Number(btcT.priceChangePercent || 0)) : null;
  const corr = symCloses.length >= 31 && btcMain.length >= 31 ? correlationOf(symCloses, btcMain.map((r) => r.close)) : null;
  return { state, corr, relStrength, btc1hLabel: btc1h.enough ? btc1h.label : null, btc4hLabel: btc4h.enough ? btc4h.label : null };
}

// ---- 市场广度 ----

export { correlationOf, btcContext };
