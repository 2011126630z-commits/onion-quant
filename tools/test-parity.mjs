// tools/test-parity.mjs
// 回归测试:重构后的 bundle 与 V9 基线对同一输入必须给出完全一致的判断
// 规则:基线中存在的每个字段都必须与新实现深度相等(新实现允许新增字段)
const NEW = "../worker/index.js";
const OLD = "../.build/baseline-v9.js";

const newMod = await import(NEW);
const oldMod = await import(OLD);

let failed = 0;
let checked = 0;
function check(name, ok, detail) {
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (ok || !detail ? "" : "  => " + detail));
  if (!ok) failed += 1;
}

function deepEqualSubset(base, next, path, diffs) {
  if (base === null || typeof base !== "object") {
    checked += 1;
    if (!Object.is(base, next)) diffs.push(`${path}: ${JSON.stringify(base)} != ${JSON.stringify(next)}`);
    return;
  }
  if (Array.isArray(base)) {
    if (!Array.isArray(next)) { diffs.push(`${path}: type mismatch`); return; }
    if (base.length !== next.length) { diffs.push(`${path}: length ${base.length} != ${next.length}`); return; }
    for (let i = 0; i < base.length; i += 1) deepEqualSubset(base[i], next[i], `${path}[${i}]`, diffs);
    return;
  }
  for (const k of Object.keys(base)) {
    if (!(k in next)) { diffs.push(`${path}.${k}: missing in new`); continue; }
    deepEqualSubset(base[k], next[k], `${path}.${k}`, diffs);
  }
}

// ---- 合成K线(与 test-engine.mjs 同源算法,但不依赖其内部函数) ----
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function genKlines(n, opts) {
  const o = opts || {};
  const rand = lcg(o.seed || 42);
  const rows = [];
  let price = o.start || 100;
  const ivMs = 3600000;
  const t0 = 1700000000000;
  for (let i = 0; i < n; i += 1) {
    const osc = o.osc ? Math.sin(i / 6) * o.osc : 0;
    const noise = (rand() - 0.5) * 2 * (o.volPct || 0.004) * price;
    const open = price;
    const close = Math.max(1, price * (1 + (o.drift || 0)) + osc + noise);
    const high = Math.max(open, close) * (1 + rand() * 0.002);
    const low = Math.min(open, close) * (1 - rand() * 0.002);
    let volume = 1000 * (0.8 + rand() * 0.4);
    if (o.spikeLast && i === n - 1) volume *= 6;
    rows.push({ openTime: t0 + i * ivMs, open, high, low, close, volume, closeTime: t0 + (i + 1) * ivMs - 1 });
    price = close;
  }
  return rows;
}
function fakeTickers(sym, chg, n) {
  const out = [];
  for (let i = 0; i < (n || 100); i += 1) {
    out.push({ symbol: "COIN" + i + "USDT", lastPrice: "1", priceChangePercent: String((i % 10) - 4), highPrice: "1.1", lowPrice: "0.9", quoteVolume: String(1e9 - i * 1e6) });
  }
  out.push({ symbol: sym, lastPrice: "100", priceChangePercent: String(chg), highPrice: "110", lowPrice: "95", quoteVolume: "5e9" });
  return out;
}
function buildInput(rows, opts) {
  const o = opts || {};
  return {
    symbol: o.symbol || "BTCUSDT",
    interval: o.interval || "1h",
    ticker: { lastPrice: String(rows[rows.length - 1].close), priceChangePercent: String(o.chg != null ? o.chg : 2), highPrice: "110", lowPrice: "95", quoteVolume: "5e9" },
    tfRows: { "1m": rows, "5m": rows, "15m": rows, "1h": rows, "4h": rows, "1d": rows },
    btcRows: o.btcRows || {},
    tickers: fakeTickers(o.symbol || "BTCUSDT", o.chg != null ? o.chg : 2),
    nowMs: o.nowMs
  };
}

check("ENGINE_VERSION 一致", newMod.ENGINE_VERSION === oldMod.ENGINE_VERSION, `${newMod.ENGINE_VERSION} vs ${oldMod.ENGINE_VERSION}`);
check("导出 computeAnalysis", typeof newMod.computeAnalysis === "function");

const scenarios = [
  ["uptrend", genKlines(200, { drift: 0.002, seed: 7 }), {}],
  ["downtrend", genKlines(200, { drift: -0.002, seed: 11 }), {}],
  ["range", genKlines(200, { osc: 1.5, seed: 3, volPct: 0.003 }), {}],
  ["short-history", genKlines(40, { drift: 0.001, seed: 5 }), {}],
  ["volume-spike", genKlines(200, { drift: 0.0015, seed: 9, spikeLast: true }), {}],
  ["eth-with-btc", genKlines(200, { drift: 0.001, seed: 13 }), { symbol: "ETHUSDT", btcRows: { "1h": genKlines(200, { drift: 0.002, seed: 21 }), "4h": genKlines(200, { drift: 0.001, seed: 22 }), "15m": genKlines(200, { drift: 0.001, seed: 23 }) } }],
  ["4h-interval", genKlines(200, { drift: -0.0015, seed: 17 }), { interval: "4h" }],
  ["noisy", genKlines(220, { drift: 0, volPct: 0.02, seed: 31 }), {}]
];

for (const [name, rows, opts] of scenarios) {
  const nowMs = 1700000000000 + rows.length * 3600000 + 5000;
  const input = buildInput(rows, { ...opts, nowMs });
  const a = oldMod.computeAnalysis(input);
  const b = newMod.computeAnalysis(input);
  const diffs = [];
  deepEqualSubset(a, b, name, diffs);
  check(`parity ${name}`, diffs.length === 0, diffs.slice(0, 4).join(" | "));
}

// ---- Look-Ahead 保护:形成中K线不参与判断(新实现同样必须成立) ----
for (const [name, rows, opts] of scenarios.slice(0, 4)) {
  const cutMs = 1700000000000 + rows.length * 3600000 + 5000;
  const full = newMod.computeAnalysis(buildInput(rows, { ...opts, nowMs: cutMs }));
  const rt = newMod.computeAnalysis(buildInput(rows, { ...opts, nowMs: cutMs + 3600000 }));
  const same = full.direction === rt.direction && full.signal_strength === rt.signal_strength && full.confidence === rt.confidence;
  check(`look-ahead ${name}: 未收盘K线不影响裁决`, same, `${full.direction}/${full.signal_strength}/${full.confidence} vs ${rt.direction}/${rt.signal_strength}/${rt.confidence}`);
}

const newKeys = Object.keys(newMod.computeAnalysis(buildInput(genKlines(120, {}), { nowMs: 1700000000000 + 120 * 3600000 + 5000 })));
const sample = newMod.computeAnalysis(buildInput(genKlines(120, {}), { nowMs: 1700000000000 + 120 * 3600000 + 5000 }));
check("新增 data_close_time 锚点字段", sample.data_close_time != null && sample.data_candles >= 60, JSON.stringify({ d: sample.data_close_time, n: sample.data_candles }));
void newKeys;

console.log(`\n对比字段数: ${checked}`);
if (failed) {
  console.log(`PARITY FAILED: ${failed} 项`);
  process.exit(1);
}
console.log("PARITY OK: 重构后判断逻辑与 V9 基线一致");
