// engine/indicators.js · IndicatorEngine(EMA/RSI/MACD/BB/ATR/ADX/...)
// 由 tools/migrate-split.mjs 从 V9 单文件拆分而来;逻辑未改动

import { stdevSrv } from "./utils.js";

function emaSeriesSrv(values, n) {
  if (values.length < n) return null;
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += values[i];
  let prev = sum / n;
  out[n - 1] = prev;
  const k = 2 / (n + 1);
  for (let i = n; i < values.length; i += 1) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}
function emaLast(values, n) {
  const series = emaSeriesSrv(values, n);
  return series ? series[series.length - 1] : null;
}
function smaLast(values, n) {
  if (values.length < n) return null;
  let sum = 0;
  for (let i = values.length - n; i < values.length; i += 1) sum += values[i];
  return sum / n;
}
function rsiLast(values, n) {
  if (values.length <= n) return 50;
  let gain = 0, loss = 0;
  for (let i = values.length - n; i < values.length; i += 1) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}
function macdLast(closes) {
  const fast = emaSeriesSrv(closes, 12);
  const slow = emaSeriesSrv(closes, 26);
  if (!fast || !slow) return null;
  const line = [];
  for (let i = 0; i < closes.length; i += 1) if (fast[i] != null && slow[i] != null) line.push(fast[i] - slow[i]);
  if (!line.length) return null;
  const sig = emaSeriesSrv(line, 9);
  const macd = line[line.length - 1];
  const signal = sig ? sig[sig.length - 1] : macd;
  return { macd, signal, hist: macd - signal };
}
function bbLast(closes, n, k) {
  const mid = smaLast(closes, n || 20);
  if (mid == null) return null;
  const win = closes.slice(-(n || 20));
  const sd = stdevSrv(win);
  const kk = k || 2;
  return { mid, upper: mid + kk * sd, lower: mid - kk * sd, widthPct: mid ? 2 * kk * sd / mid * 100 : 0 };
}
function trueRanges(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (i === 0) { out.push(rows[i].high - rows[i].low); continue; }
    const pc = rows[i - 1].close;
    out.push(Math.max(rows[i].high - rows[i].low, Math.abs(rows[i].high - pc), Math.abs(rows[i].low - pc)));
  }
  return out;
}
function atrLast(rows, n) {
  const tr = trueRanges(rows);
  if (tr.length < (n || 14) + 1) return tr.length ? Math.max(...tr) : null;
  let atr = 0;
  for (let i = 1; i <= (n || 14); i += 1) atr += tr[i];
  atr /= (n || 14);
  for (let i = (n || 14) + 1; i < tr.length; i += 1) atr = (atr * ((n || 14) - 1) + tr[i]) / (n || 14);
  return atr;
}
function adxLast(rows, n) {
  const N = n || 14;
  if (rows.length < N * 2 + 2) return null;
  const trs = trueRanges(rows);
  let trS = 0, pS = 0, mS = 0, pdi = 0, mdi = 0;
  for (let i = 1; i <= N; i += 1) {
    const up = rows[i].high - rows[i - 1].high;
    const dn = rows[i - 1].low - rows[i].low;
    pS += up > dn && up > 0 ? up : 0;
    mS += dn > up && dn > 0 ? dn : 0;
    trS += trs[i];
  }
  const dxs = [];
  for (let i = N + 1; i < rows.length; i += 1) {
    const up = rows[i].high - rows[i - 1].high;
    const dn = rows[i - 1].low - rows[i].low;
    pS = pS - pS / N + (up > dn && up > 0 ? up : 0);
    mS = mS - mS / N + (dn > up && dn > 0 ? dn : 0);
    trS = trS - trS / N + trs[i];
    pdi = trS ? pS / trS * 100 : 0;
    mdi = trS ? mS / trS * 100 : 0;
    dxs.push(pdi + mdi ? Math.abs(pdi - mdi) / (pdi + mdi) * 100 : 0);
  }
  if (!dxs.length) return null;
  const seed = Math.min(N, dxs.length);
  let adx = dxs.slice(0, seed).reduce((a, b) => a + b, 0) / seed;
  for (let i = seed; i < dxs.length; i += 1) adx = (adx * (N - 1) + dxs[i]) / N;
  return { adx, pdi, mdi };
}
function slopePct(closes, n) {
  if (closes.length < n) return 0;
  const ys = closes.slice(-n);
  const mean = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (i - (n - 1) / 2) * (ys[i] - mean);
    den += Math.pow(i - (n - 1) / 2, 2);
  }
  const slope = den ? num / den : 0;
  return mean ? slope / mean * 100 : 0;
}
function rocLast(values, n) {
  if (values.length <= n) return 0;
  const prev = values[values.length - 1 - n];
  return prev ? (values[values.length - 1] / prev - 1) * 100 : 0;
}
function hvLast(closes, n) {
  if (closes.length <= n) return null;
  const rets = [];
  for (let i = closes.length - n; i < closes.length; i += 1) rets.push(closes[i] / closes[i - 1] - 1);
  return stdevSrv(rets) * 100;
}
function vwapLast(rows, n) {
  const win = rows.slice(-(n || 50));
  let pv = 0, v = 0;
  for (const r of win) {
    const tp = (r.high + r.low + r.close) / 3;
    pv += tp * r.volume;
    v += r.volume;
  }
  return v ? pv / v : null;
}
function mfiLast(rows, n) {
  const N = n || 14;
  if (rows.length < N + 1) return null;
  let pos = 0, neg = 0;
  for (let i = rows.length - N; i < rows.length; i += 1) {
    const tp = (rows[i].high + rows[i].low + rows[i].close) / 3;
    const pp = (rows[i - 1].high + rows[i - 1].low + rows[i - 1].close) / 3;
    const flow = tp * rows[i].volume;
    if (tp > pp) pos += flow; else if (tp < pp) neg += flow;
  }
  if (neg === 0) return 100;
  return 100 - 100 / (1 + pos / neg);
}
function cciLast(rows, n) {
  const N = n || 20;
  if (rows.length < N) return null;
  const tps = rows.slice(-N).map((r) => (r.high + r.low + r.close) / 3);
  const mean = tps.reduce((a, b) => a + b, 0) / N;
  const md = tps.reduce((a, b) => a + Math.abs(b - mean), 0) / N;
  return md ? (tps[tps.length - 1] - mean) / (0.015 * md) : 0;
}
function stochRsiLast(closes) {
  const n = 14;
  if (closes.length < n * 2 + 2) return null;
  const rsis = [];
  for (let i = closes.length - 2 * n; i < closes.length; i += 1) rsis.push(rsiLast(closes.slice(0, i + 1), n));
  const win = rsis.slice(-n);
  const min = Math.min(...win), max = Math.max(...win);
  return max === min ? 50 : (win[win.length - 1] - min) / (max - min) * 100;
}
function obvDir(rows) {
  if (rows.length < 12) return 0;
  let obv = 0;
  const series = [];
  for (let i = 1; i < rows.length; i += 1) {
    obv += rows[i].close > rows[i - 1].close ? rows[i].volume : rows[i].close < rows[i - 1].close ? -rows[i].volume : 0;
    series.push(obv);
  }
  const recent = series.slice(-5);
  const older = series.slice(-12, -5);
  const ra = recent.reduce((a, b) => a + b, 0) / recent.length;
  const ro = older.length ? older.reduce((a, b) => a + b, 0) / older.length : ra;
  return ra > ro * 1.02 ? 1 : ra < ro * 0.98 ? -1 : 0;
}

// ---- MarketStructureEngine ----

export { emaSeriesSrv, emaLast, smaLast, rsiLast, macdLast, bbLast, trueRanges, atrLast, adxLast, slopePct, rocLast, hvLast, vwapLast, mfiLast, cciLast, stochRsiLast, obvDir };
