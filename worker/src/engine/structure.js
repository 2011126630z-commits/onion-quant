// engine/structure.js · MarketStructureEngine(摆动点/结构/支撑阻力)
// 由 tools/migrate-split.mjs 从 V9 单文件拆分而来;逻辑未改动

function findSwings(rows, left, right) {
  const L = left || 2, R = right || 2;
  const out = [];
  for (let i = L; i < rows.length - R; i += 1) {
    let isHigh = true, isLow = true;
    for (let j = i - L; j <= i + R; j += 1) {
      if (j === i) continue;
      if (rows[j].high >= rows[i].high) isHigh = false;
      if (rows[j].low <= rows[i].low) isLow = false;
    }
    if (isHigh) out.push({ type: "high", idx: i, price: rows[i].high });
    else if (isLow) out.push({ type: "low", idx: i, price: rows[i].low });
  }
  return out;
}
function structureQuick(rows) {
  const recent = rows.slice(-80);
  const sw = findSwings(recent, 2, 2);
  const highs = sw.filter((s) => s.type === "high").slice(-3);
  const lows = sw.filter((s) => s.type === "low").slice(-3);
  let dir = 0;
  if (highs.length >= 2 && lows.length >= 2) {
    const price = recent[recent.length - 1].close;
    const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
    const hl = lows[lows.length - 1].price > lows[lows.length - 2].price;
    const mag = ((highs[highs.length - 1].price - highs[highs.length - 2].price) + (lows[lows.length - 1].price - lows[lows.length - 2].price)) / price * 100;
    if (hh && hl) dir = Math.min(1, Math.max(0, mag / 2));
    else if (!hh && !hl) dir = Math.max(-1, Math.min(0, mag / 2));
  }
  return { dir, lastHigh: highs.length ? highs[highs.length - 1].price : null, lastLow: lows.length ? lows[lows.length - 1].price : null };
}
function analyzeStructure(rows) {
  if (rows.length < 40) return { label: "数据不足", hh: 0, hl: 0, lh: 0, ll: 0, lastHigh: null, lastLow: null, brokeHigh: false, brokeLow: false };
  const sw = findSwings(rows, 2, 2);
  const highs = sw.filter((s) => s.type === "high").slice(-4);
  const lows = sw.filter((s) => s.type === "low").slice(-4);
  const sig = 0.003; // 摆动幅度小于0.3%的抬升/降低视为噪声,不计入结构
  let hh = 0, lh = 0, hl = 0, ll = 0;
  for (let i = 1; i < highs.length; i += 1) {
    if (highs[i].price > highs[i - 1].price * (1 + sig)) hh += 1;
    else if (highs[i].price < highs[i - 1].price * (1 - sig)) lh += 1;
  }
  for (let i = 1; i < lows.length; i += 1) {
    if (lows[i].price > lows[i - 1].price * (1 + sig)) hl += 1;
    else if (lows[i].price < lows[i - 1].price * (1 - sig)) ll += 1;
  }
  const price = rows[rows.length - 1].close;
  const lastHigh = highs.length ? highs[highs.length - 1] : null;
  const lastLow = lows.length ? lows[lows.length - 1] : null;
  let label = "震荡";
  if (hh > lh && hl > ll && hh + hl >= 2) label = "上涨结构";
  else if (lh > hh && ll > hl && lh + ll >= 2) label = "下降结构";
  return { label, hh, hl, lh, ll, lastHigh, lastLow, brokeHigh: Boolean(lastHigh && price > lastHigh.price), brokeLow: Boolean(lastLow && price < lastLow.price) };
}
function srZones(rows, price) {
  if (rows.length < 40 || !price) return { supports: [], resistances: [] };
  const sw = findSwings(rows, 2, 2);
  const pts = sw.map((s) => s.price).sort((a, b) => a - b);
  const clusters = [];
  for (const p of pts) {
    const c = clusters[clusters.length - 1];
    if (c && Math.abs(p - c.mean) / c.mean < 0.007) {
      c.vals.push(p);
      c.mean = c.vals.reduce((a, b) => a + b, 0) / c.vals.length;
    } else clusters.push({ vals: [p], mean: p });
  }
  const zones = [];
  for (const c of clusters) {
    if (c.vals.length < 2 && Math.abs(c.mean / price - 1) >= 0.025) continue;
    const pad = c.mean * 0.0015;
    const lo = Math.min(...c.vals) - pad, hi = Math.max(...c.vals) + pad;
    let touches = 0, inside = false;
    for (const r of rows) {
      const inZone = r.low <= hi && r.high >= lo;
      if (inZone && !inside) touches += 1;
      inside = inZone;
    }
    if (touches + c.vals.length < 2) continue;
    zones.push({ lo, hi, mean: c.mean, touches: touches + c.vals.length, distPct: (c.mean - price) / price * 100 });
  }
  const supports = zones.filter((z) => z.mean < price).sort((a, b) => b.mean - a.mean).slice(0, 2);
  const resistances = zones.filter((z) => z.mean >= price).sort((a, b) => a.mean - b.mean).slice(0, 2);
  return { supports, resistances };
}

// ---- MarketRegimeEngine ----

export { findSwings, structureQuick, analyzeStructure, srZones };
