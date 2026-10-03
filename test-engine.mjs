import { computeAnalysis, ENGINE_VERSION } from "./worker/index.js";

// 确定性伪随机数(LCG),保证测试可复现
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// 生成合成K线: {drift} 每根漂移, {osc} 震荡幅度, {volPct} 噪声, {spikeLast} 最后一根放量
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

function fakeTickers(sym, chg) {
  const out = [];
  for (let i = 0; i < 100; i += 1) {
    out.push({ symbol: "COIN" + i + "USDT", lastPrice: "1", priceChangePercent: String(i % 10 - 4), highPrice: "1.1", lowPrice: "0.9", quoteVolume: String(1e9 - i * 1e6) });
  }
  out.push({ symbol: sym, lastPrice: "100", priceChangePercent: String(chg), highPrice: "110", lowPrice: "95", quoteVolume: "5e9" });
  return out;
}

function buildInput(rows, opts) {
  const o = opts || {};
  return {
    symbol: "BTCUSDT",
    interval: "1h",
    ticker: { lastPrice: String(rows[rows.length - 1].close), priceChangePercent: String(o.chg != null ? o.chg : 2), highPrice: "110", lowPrice: "95", quoteVolume: "5e9" },
    tfRows: { "1m": rows, "5m": rows, "15m": rows, "1h": rows, "4h": rows, "1d": rows },
    btcRows: {},
    tickers: fakeTickers("BTCUSDT", o.chg != null ? o.chg : 2),
    nowMs: o.nowMs
  };
}

function noBadNumbers(obj, path) {
  if (obj == null) return null;
  if (typeof obj === "number") return Number.isNaN(obj) ? path : null;
  if (typeof obj === "object") {
    for (const k of Object.keys(obj)) {
      const bad = noBadNumbers(obj[k], path + "." + k);
      if (bad) return bad;
    }
  }
  return null;
}

let failed = 0;
function check(name, ok, detail) {
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (ok || !detail ? "" : "  => " + detail));
  if (!ok) failed += 1;
}

const DIRS = ["Strong Bullish", "Bullish", "Neutral", "Bearish", "Strong Bearish"];
const REGIMES = ["Strong Uptrend", "Weak Uptrend", "Bullish Range", "Range", "Bearish Range", "Weak Downtrend", "Strong Downtrend"];

// ---- 场景1: 上升趋势 ----
const up = computeAnalysis(buildInput(genKlines(200, { drift: 0.002, seed: 7 })));
check("up: no NaN/undefined", noBadNumbers(up, "up") === null, noBadNumbers(up, "up"));
check("up: direction bullish", up.direction === "Bullish" || up.direction === "Strong Bullish", up.direction);
check("up: regime uptrend", up.market_regime.label.indexOf("Uptrend") >= 0, up.market_regime.label);
check("up: strength >= 60", up.signal_strength >= 60, up.signal_strength);
check("up: structure up", up.structure.label === "上涨结构", up.structure.label);
check("up: reasons non-empty", up.reasons.length >= 2, JSON.stringify(up.reasons));

// ---- 场景2: 下降趋势 ----
const down = computeAnalysis(buildInput(genKlines(200, { drift: -0.002, seed: 11 })));
check("down: no NaN/undefined", noBadNumbers(down, "down") === null, noBadNumbers(down, "down"));
check("down: direction bearish", down.direction === "Bearish" || down.direction === "Strong Bearish", down.direction);
check("down: regime downtrend", down.market_regime.label.indexOf("Downtrend") >= 0, down.market_regime.label);
check("down: structure down", down.structure.label === "下降结构", down.structure.label);

// ---- 场景3: 震荡(末段50根走平,避免"正弦恰好收在上升段"被误当趋势) ----
function genRange(n, opts) {
  const o = opts || {};
  const rand = lcg(o.seed || 23);
  const rows = [];
  let price = 100;
  const ivMs = 3600000;
  const t0 = 1700000000000;
  for (let i = 0; i < n; i += 1) {
    let target;
    if (i < n - 50) target = 100 + Math.sin(i / 6) * 1.2;
    else target = 100;
    const noise = (rand() - 0.5) * 2 * 0.0015 * price;
    const open = price;
    const close = Math.max(1, target + noise);
    const high = Math.max(open, close) * (1 + rand() * 0.002);
    const low = Math.min(open, close) * (1 - rand() * 0.002);
    rows.push({ openTime: t0 + i * ivMs, open, high, low, close, volume: 1000 * (0.8 + rand() * 0.4), closeTime: t0 + (i + 1) * ivMs - 1 });
    price = close;
  }
  return rows;
}
const range = computeAnalysis(buildInput(genRange(200)));
check("range: no NaN/undefined", noBadNumbers(range, "range") === null, noBadNumbers(range, "range"));
check("range: neutral or range regime", range.direction === "Neutral" || range.market_regime.label.indexOf("Range") >= 0, range.direction + "/" + range.market_regime.label);
check("range: strength near 50", Math.abs(range.signal_strength - 50) <= 25, range.signal_strength);

// ---- 场景4: Look-Ahead Bias 保护(核心) ----
// 行情里最后一根是"正在形成中"的K线:它的收盘价被人为拉高3倍。
// 引擎必须忽略它:结果与"这根K线根本不存在"时完全一致。
const ivMs = 3600000;
const base = genKlines(150, { drift: 0.0005, seed: 31 });
const lastClosed = base[base.length - 1];
const formingOpenTime = lastClosed.closeTime + 1;
const forming = {
  openTime: formingOpenTime,
  open: lastClosed.close,
  high: lastClosed.close * 3.5,
  low: lastClosed.close * 0.99,
  close: lastClosed.close * 3.2,
  volume: 99999,
  closeTime: formingOpenTime + ivMs - 1
};
const withForming = base.concat([forming]);
const nowDuringForming = formingOpenTime + 60000; // 形成中
const nowAfterClose = forming.closeTime + 5000;   // 已收盘
const a = computeAnalysis(buildInput(withForming, { nowMs: nowDuringForming }));
const b = computeAnalysis(buildInput(base, { nowMs: nowAfterClose }));
// 裁决字段必须完全一致:指标/结构/环境/方向/强度/周期判断只允许来自已收盘K线
// (price/zones/features 允许使用"实时最新价",这不是未来数据)
const verdictA = JSON.stringify([a.direction, a.signal_strength, a.timeframes, a.market_regime, a.structure, a.volume, a.volatility, a.anomaly, a.limited_data, a.market_regime.adx, a.market_regime.atr_pct]);
const verdictB = JSON.stringify([b.direction, b.signal_strength, b.timeframes, b.market_regime, b.structure, b.volume, b.volatility, b.anomaly, b.limited_data, b.market_regime.adx, b.market_regime.atr_pct]);
check("lookahead: verdict identical", verdictA === verdictB, verdictA + " vs " + verdictB);
check("lookahead: atr not leaked", a.market_regime.atr_pct === b.market_regime.atr_pct, a.market_regime.atr_pct + " vs " + b.market_regime.atr_pct);
check("lookahead: forming noted", a.forming_candle.count === 1 && a.forming_candle.note.length > 0, JSON.stringify(a.forming_candle));

// ---- 场景5: 数据不足 ----
const thin = computeAnalysis(buildInput(genKlines(25, { seed: 5 })));
check("thin: limited_data", thin.limited_data === true, thin.limited_data);
check("thin: confidence capped", thin.confidence <= 40, thin.confidence);
check("thin: neutral", thin.direction === "Neutral", thin.direction);

// ---- 场景6: 放量 + 异常 ----
const spike = computeAnalysis(buildInput(genKlines(200, { seed: 9, spikeLast: true })));
check("spike: volume.spike", spike.volume.spike === true, JSON.stringify(spike.volume));
check("spike: anomaly detected", spike.anomaly.detected && spike.anomaly.kinds.indexOf("异常放量") >= 0, JSON.stringify(spike.anomaly.kinds));

// ---- 场景7: 字段规格 ----
const spec = up;
check("spec: direction enum", DIRS.indexOf(spec.direction) >= 0, spec.direction);
check("spec: regime enum", REGIMES.indexOf(spec.market_regime.label) >= 0, spec.market_regime.label);
check("spec: timeframes 6 keys", Object.keys(spec.timeframes).length === 6, JSON.stringify(Object.keys(spec.timeframes)));
check("spec: strength 0-100 int", Number.isInteger(spec.signal_strength) && spec.signal_strength >= 0 && spec.signal_strength <= 100, spec.signal_strength);
check("spec: confidence 5-92", spec.confidence >= 5 && spec.confidence <= 92, spec.confidence);
check("spec: risk 0-100", spec.risk_score >= 0 && spec.risk_score <= 100, spec.risk_score);
check("spec: risk level enum", ["Low", "Medium", "High", "Extreme"].indexOf(spec.risk_level) >= 0, spec.risk_level);
check("spec: model version", spec.model_version === ENGINE_VERSION, spec.model_version);
check("spec: invalidation present", spec.invalidation.length >= 1, JSON.stringify(spec.invalidation));
check("spec: json serializable", (() => { try { JSON.stringify(spec); return true; } catch (e) { return false; } })(), "json fail");

console.log(failed ? "TESTS FAILED: " + failed : "ALL ENGINE TESTS PASSED");
process.exit(failed ? 1 : 0);
