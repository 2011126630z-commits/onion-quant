// tools/test-history.mjs
// V10 历史验证系统单元测试:噪声区 / 防前视 / MFE-MAE / 去重 / 统计 / 校准 / 回测 / 存储
import { noiseThresholdPct, classifyOutcome, verdictOf, computeMFEMAE, resolveHorizon, resolveSignalOutcomes, pendingHorizons, NOISE_FLOOR_PCT } from "../worker/src/history/outcome.js";
import { signalRecordFromAnalysis, shouldRecordSignal, resolveRecordId, latestOf, prunePlan } from "../worker/src/history/record.js";
import { replaySymbol, attachOutcomes, pickSeriesByHorizon, sliceUpTo, makeBacktestPlan } from "../worker/src/history/backtest.js";
import { buildStatsBundle, overallStats, statsByConfidence, statsByRegime, calibrationTable, confidenceBucket, medianOf } from "../worker/src/history/stats.js";
import { createHistoryStore } from "../worker/src/history/store.js";
import { computeAnalysis } from "../worker/src/engine/signal.js";

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log("PASS  " + name); }
  else { failed += 1; console.log("FAIL  " + name + (detail ? "  => " + detail : "")); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}
function near(name, actual, expected, tol) {
  check(name, Math.abs(actual - expected) <= (tol || 1e-6), `got ${actual} want ~${expected}`);
}

// ---- 合成K线 ----
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function genKlines(n, opts) {
  const o = opts || {};
  const rand = lcg(o.seed || 42);
  const ivMs = o.ivMs || 3600000;
  const t0 = o.t0 || 1700000000000;
  let price = o.start || 100;
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const osc = o.osc ? Math.sin(i / 6) * o.osc : 0;
    const noise = (rand() - 0.5) * 2 * (o.volPct || 0.004) * price;
    const open = price;
    const close = Math.max(1, price * (1 + (o.drift || 0)) + osc + noise);
    const high = Math.max(open, close) * (1 + rand() * 0.002);
    const low = Math.min(open, close) * (1 - rand() * 0.002);
    rows.push({ openTime: t0 + i * ivMs, open, high, low, close, volume: 1000 * (0.8 + rand() * 0.4), closeTime: t0 + (i + 1) * ivMs - 1 });
    price = close;
  }
  return rows;
}
function mkCandle(t0, ivMs, open, high, low, close) {
  return { openTime: t0, open, high, low, close, volume: 1000, closeTime: t0 + ivMs - 1 };
}

// ============================================================
console.log("== 1. noise zone (dynamic threshold) ==");
near("BTC 1h threshold = ATR0.5 * 0.5", noiseThresholdPct({ atrPct: 0.5, intervalMs: 3600000, horizonMs: 3600000 }), 0.25, 1e-9);
near("high-vol coin threshold scales with ATR", noiseThresholdPct({ atrPct: 3.0, intervalMs: 3600000, horizonMs: 3600000 }), 1.5, 1e-9);
near("4h threshold = 2x 1h", noiseThresholdPct({ atrPct: 0.5, intervalMs: 3600000, horizonMs: 14400000 }), 0.5, 1e-9);
check("threshold grows with horizon", noiseThresholdPct({ atrPct: 0.5, intervalMs: 3600000, horizonMs: 86400000 }) > noiseThresholdPct({ atrPct: 0.5, intervalMs: 3600000, horizonMs: 3600000 }));
check("floor applied on tiny ATR", noiseThresholdPct({ atrPct: 0.0001, intervalMs: 3600000, horizonMs: 300000 }) === NOISE_FLOOR_PCT);
check("floor applied when ATR missing", noiseThresholdPct({ atrPct: null, intervalMs: 3600000, horizonMs: 300000 }) === NOISE_FLOOR_PCT);
check("cap at 5%", noiseThresholdPct({ atrPct: 100, intervalMs: 3600000, horizonMs: 86400000 }) === 5);

console.log("== 2. outcome classification & verdict ==");
eq("+0.5% over threshold 0.25 -> Bullish", classifyOutcome({ retPct: 0.5, thresholdPct: 0.25 }), "Bullish");
eq("+0.1% inside noise zone -> Neutral", classifyOutcome({ retPct: 0.1, thresholdPct: 0.25 }), "Neutral");
eq("-0.1% inside noise zone -> Neutral", classifyOutcome({ retPct: -0.1, thresholdPct: 0.25 }), "Neutral");
eq("-0.5% -> Bearish", classifyOutcome({ retPct: -0.5, thresholdPct: 0.25 }), "Bearish");
eq("bullish signal + up = correct", verdictOf("Bullish", "Bullish"), "correct");
eq("bullish signal + down = wrong", verdictOf("Bullish", "Bearish"), "wrong");
eq("bullish signal + neutral = neutral", verdictOf("Bullish", "Neutral"), "neutral");
eq("bearish signal + down = correct", verdictOf("Bearish", "Bearish"), "correct");
eq("strong bullish + up = correct", verdictOf("Strong Bullish", "Bullish"), "correct");
eq("strong bearish + up = wrong", verdictOf("Strong Bearish", "Bullish"), "wrong");

console.log("== 3. MFE / MAE (relative to signal direction) ==");
let mm = computeMFEMAE({ signalPrice: 100, direction: "Bullish", highs: [105, 103], lows: [98, 99] });
near("bullish MFE = +5%", mm.mfe_pct, 5);
near("bullish MAE = -2%", mm.mae_pct, 2);
mm = computeMFEMAE({ signalPrice: 100, direction: "Bearish", highs: [103], lows: [93] });
near("bearish MFE = +7% (down is favorable)", mm.mfe_pct, 7);
near("bearish MAE = -3% (up is adverse)", mm.mae_pct, 3);
mm = computeMFEMAE({ signalPrice: 0, direction: "Bullish", highs: [1], lows: [1] });
check("no valid signal price -> null", mm.mfe_pct === null);

console.log("== 4. outcome resolution (look-ahead safe) ==");
const iv = 3600000;
const t0 = 1700000000000;
const signalAt = (t) => ({ id: "s1", symbol: "BTCUSDT", interval: "1h", direction: "Bullish", price: 100, timestamp: t, data_close_time: t, volatility_atr_pct: 0.5, market_regime_atr_pct: 0.5 });

// signal closes at t0+1h-1 ; anchor+1h = t0+2h-1 which is exactly the close of the first follow-up candle
const sig1 = signalAt(t0 + iv - 1);
const candles = [
  mkCandle(t0 + iv, iv, 100, 101, 99, 100.2),
  mkCandle(t0 + 2 * iv, iv, 100.2, 106, 100, 105.8),
  mkCandle(t0 + 3 * iv, iv, 105.8, 130, 105, 129) // future spike must never be used
];
const r1 = resolveHorizon({ signal: sig1, horizon: "1h", candles, nowMs: t0 + 10 * iv });
check("1h matured", r1 && r1.matured === true);
near("1h price = close of candle containing target (100.2)", r1.price, 100.2);
near("1h return = +0.2%", r1.ret_pct, 0.2);
eq("0.2% inside noise zone (0.25%) -> Neutral", r1.outcome, "Neutral");
eq("verdict inside noise zone = neutral", r1.verdict, "neutral");
near("1h MFE only counts elapsed path (+1%)", r1.mfe_pct, 1);
check("1h MFE ignores future spike (+30%)", r1.mfe_pct < 30, String(r1.mfe_pct));

const dropCandles = [mkCandle(t0 + iv, iv, 100, 100.5, 96, 96.5)];
const rDrop = resolveHorizon({ signal: sig1, horizon: "1h", candles: dropCandles, nowMs: t0 + 3 * iv });
eq("bullish signal with -3.5% -> Bearish", rDrop.outcome, "Bearish");
eq("bullish signal with drop -> wrong", rDrop.verdict, "wrong");
near("MAE = 4% (low 96)", rDrop.mae_pct, 4);
near("MFE = 0.5%", rDrop.mfe_pct, 0.5);

const r2 = resolveHorizon({ signal: sig1, horizon: "4h", candles, nowMs: t0 + 10 * iv });
check("4h not covered -> not matured", r2 && r2.matured === false, JSON.stringify(r2));

const forming = [mkCandle(t0 + iv, iv, 100, 200, 95, 199)];
const r3 = resolveHorizon({ signal: sig1, horizon: "1h", candles: forming, nowMs: t0 + iv + 1000 });
check("forming candle excluded -> not matured", r3.matured === false, JSON.stringify(r3));

const r4 = resolveHorizon({ signal: sig1, horizon: "1h", candles: [...forming, mkCandle(t0 + 2 * iv, iv, 199, 201, 198, 200)], nowMs: t0 + 3 * iv });
check("resolvable once a closed candle exists", r4.matured === true, JSON.stringify({ matured: r4.matured }));
near("only closed candle used (199 not 200)", r4.price, 199);
check("out-of-window candle high (201) excluded from MFE", r4.mfe_pct === 100, String(r4.mfe_pct));

const sig2 = { ...signalAt(t0 + iv - 1), id: "s2", direction: "Bearish" };
const batch = resolveSignalOutcomes({ signal: sig2, seriesByHorizon: { "1h": candles }, nowMs: t0 + 10 * iv });
eq("batch: only 1h resolvable with 1h data", batch.horizons_resolved, "1h");
check("batch: bearish + tiny move in noise zone -> neutral", batch.verdict_1h === "neutral", JSON.stringify(batch.verdict_1h));
near("batch: threshold stored", batch.threshold_1h, 0.25);
const pend = pendingHorizons(sig1, batch, t0 + 10 * iv);
check("resolved 1h not pending", !pend.includes("1h"), JSON.stringify(pend));
eq("horizons without data remain pending", pend, ["5m", "15m", "4h"]);

console.log("== 5. signal record mapping & dedup ==");
const rows200 = genKlines(200, { drift: 0.002, seed: 7 });
const analysis = computeAnalysis({
  symbol: "BTCUSDT", interval: "1h",
  ticker: { lastPrice: "110", priceChangePercent: "2.5", highPrice: "112", lowPrice: "105", quoteVolume: "5e9" },
  tfRows: { "1m": rows200, "5m": rows200, "15m": rows200, "1h": rows200, "4h": rows200, "1d": rows200 },
  btcRows: {}, tickers: [], nowMs: rows200[rows200.length - 1].closeTime + 300
});
const rec = signalRecordFromAnalysis(analysis, { source: "live" });
check("record has id/symbol/timestamp", Boolean(rec.id && rec.symbol && rec.timestamp));
eq("record source = live", rec.source, "live");
eq("engine_version stored", rec.engine_version, analysis.model_version);
check("array fields serialized as JSON string", typeof rec.reasons === "string" && JSON.parse(rec.reasons).length >= 1);
check("boolean fields stored as 0/1", rec.tf_conflict === 0 || rec.tf_conflict === 1);
check("data_close_time anchor stored", rec.data_close_time === analysis.data_close_time);
const recBt = signalRecordFromAnalysis(analysis, { source: "backtest", timestampMs: 1700000000000 });
eq("backtest record timestamp override", recBt.timestamp, 1700000000000);

const base = { ...rec };
const sameCandle = { ...rec, signal_strength: rec.signal_strength + 3, confidence: rec.confidence + 2 };
eq("same candle + tiny metrics change -> skip", shouldRecordSignal(base, sameCandle).record, false);
const newCandle = { ...rec, id: rec.id + "_2", data_close_time: rec.data_close_time + 3600000 };
eq("new closed candle -> record", shouldRecordSignal(base, newCandle).reason, "new_closed_candle");
const dirChange = { ...rec, id: rec.id + "_3", direction: "Bearish" };
eq("direction change -> record", shouldRecordSignal(base, dirChange).reason, "direction_change");
const regimeChange = { ...rec, id: rec.id + "_4", market_regime_label: "Strong Downtrend" };
eq("regime change -> record", shouldRecordSignal(base, regimeChange).reason, "regime_change");
const bigStrength = { ...rec, id: rec.id + "_5", signal_strength: rec.signal_strength + 12 };
eq("strength change (>=6) -> record", shouldRecordSignal(base, bigStrength).reason, "strength_change");
const confBase = { ...rec, confidence: 60 };
eq("confidence +2 -> skip", shouldRecordSignal(confBase, { ...confBase, confidence: 62 }).record, false);
eq("confidence +6 -> record", shouldRecordSignal(confBase, { ...confBase, confidence: 66 }).reason, "confidence_change");
const riskChange = { ...rec, id: rec.id + "_7", risk_level: "Extreme" };
eq("risk level change -> record", shouldRecordSignal(base, riskChange).reason, "risk_change");
eq("first ever -> record", shouldRecordSignal(null, base).reason, "first");
eq("identical content -> skip", shouldRecordSignal(base, { ...base }).reason, "no_material_change");
const rev = { ...base, direction: base.direction === "Bullish" ? "Bearish" : "Bullish" };
eq("direction flip within same candle -> record (revision)", shouldRecordSignal(base, rev).reason, "direction_change");
const existing = new Set([base.id]);
eq("revision id appends r2", resolveRecordId(base.id, existing), base.id + "_r2");
existing.add(base.id + "_r2");
eq("next revision -> r3", resolveRecordId(base.id, existing), base.id + "_r3");
eq("no conflict -> base id", resolveRecordId("sig_x", existing), "sig_x");

const many = [];
for (let i = 0; i < 10; i += 1) many.push({ id: "x" + i, symbol: "BTCUSDT", interval: "1h", timestamp: i });
many.push({ id: "y0", symbol: "ETHUSDT", interval: "1h", timestamp: 0 });
const dropped = prunePlan(many, 5);
eq("retention keeps newest 5 per series", dropped.length, 5);
check("other series untouched", !dropped.includes("y0"));
check("latestOf picks newest", latestOf(many, "BTCUSDT", "1h").id === "x9");

console.log("== 6. stats & calibration (honest reporting) ==");
function mkRec(id, direction, confidence, regime, outcome, ret, mfe, mae) {
  return {
    signal: { id, symbol: "BTCUSDT", interval: "1h", direction, confidence, signal_strength: 60, market_regime_label: regime, source: "backtest", timestamp: id.length },
    outcome: { signal_id: id, outcome_1h: outcome, return_1h: ret, mfe_1h: mfe, mae_1h: mae }
  };
}
const recs = [];
for (let i = 0; i < 7; i += 1) recs.push(mkRec("a" + i, "Bullish", 75, "Range", "Bullish", 1.5, 3, 1));
for (let i = 0; i < 3; i += 1) recs.push(mkRec("b" + i, "Bullish", 72, "Range", "Bearish", -1.2, 1, 2.5));
for (let i = 0; i < 5; i += 1) recs.push(mkRec("c" + i, "Bearish", 65, "Strong Uptrend", "Bearish", -0.9, 2, 1.2));
for (let i = 0; i < 4; i += 1) recs.push(mkRec("d" + i, "Bearish", 62, "Strong Uptrend", "Neutral", 0.05, 0.6, 0.7));
recs.push({ signal: { id: "p1", symbol: "BTCUSDT", interval: "1h", direction: "Bullish", confidence: 80, signal_strength: 70, market_regime_label: "Range", source: "live", timestamp: 1 }, outcome: null });

const ov = overallStats(recs, "1h");
eq("total samples 20", ov.samples, 20);
eq("resolved 19", ov.resolved, 19);
eq("correct 12 / wrong 3 / neutral 4", [ov.correct, ov.wrong, ov.neutral], [12, 3, 4]);
near("accuracy = 12/(12+3) = 80%", ov.accuracy, 80, 1e-9);
near("neutral rate = 4/19", ov.neutral_rate, 21.1, 0.05);
near("bull accuracy = 7/10", ov.bull_accuracy, 70, 1e-9);
eq("bull decisive samples 10", ov.bull_samples, 10);
near("bear accuracy = 5/5 (neutrals excluded from directional)", ov.bear_accuracy, 100, 1e-9);
eq("bear decisive samples 5", ov.bear_samples, 5);
const expectAvg = Math.round(((7 * 1.5 - 3 * 1.2 + 5 * 0.9 - 4 * 0.05) / 19) * 1000) / 1000;
near("avg directional return", ov.avg_return, expectAvg, 1e-9);
near("median directional return = 0.9", ov.median_return, 0.9, 1e-9);

const buckets = statsByConfidence(recs, "1h");
const b70 = buckets.find((b) => b.key === "70-79");
check("bucket 70-79 exists", Boolean(b70));
eq("bucket 70-79 samples 10", b70.samples, 10);
near("bucket 70-79 observed accuracy 70%", b70.accuracy, 70, 1e-9);
eq("bucket 70-79 predicted confidence ~74", Math.round(b70.predicted_confidence), 74);
const cal = calibrationTable(recs, "1h");
const cal70 = cal.find((c) => c.bucket === "70-79");
check("calibration exposes negative gap honestly", cal70.gap != null && cal70.gap < 0, JSON.stringify(cal70));

const byRegime = statsByRegime(recs, "1h");
const rangeRow = byRegime.find((r) => r.key === "Range");
eq("regime split: Range samples 11", rangeRow.samples, 11);
near("Range accuracy = 7/10", rangeRow.accuracy, 70, 1e-9);

const bundle = buildStatsBundle(recs, "1h");
eq("bundle total", bundle.total_signals, 20);
eq("bundle pending 1", bundle.pending, 1);
check("bundle covers all horizons", bundle.all_horizons.length === 5);
eq("confidenceBucket boundaries", [confidenceBucket(50), confidenceBucket(59), confidenceBucket(60), confidenceBucket(95), confidenceBucket(40)], ["50-59", "50-59", "60-69", "90-100", "<50"]);
eq("medianOf even count", medianOf([1, 2, 3, 4]), 2.5);

console.log("== 7. backtest replay (truncation consistency = look-ahead safe) ==");
const rows1h = genKlines(320, { drift: 0.0015, seed: 101 });
const rows4h = genKlines(200, { drift: 0.0008, seed: 102 });
const rows1d = genKlines(90, { drift: 0.0005, seed: 103 });
const tfAll = { "1h": rows1h, "4h": rows4h, "1d": rows1d };
const nowAll = rows1h[rows1h.length - 1].closeTime + 1000;
const bt = await replaySymbol({ symbol: "BTCUSDT", interval: "1h", tfRows: tfAll, btcRows: {}, nowMs: nowAll, step: 1 });
check("backtest produces signals", bt.signals.length > 100, String(bt.signals.length));
check("all signals tagged backtest", bt.signals.every((s) => s.source === "backtest"));
check("signal ids reproducible", bt.signals.every((s) => s.id.startsWith("bt_BTCUSDT_1h_")));

const midSignal = bt.signals[Math.floor(bt.signals.length / 3)];
const cutTime = Math.floor(Number(midSignal.id.split("_").pop()));
const tfCut = { "1h": sliceUpTo(rows1h, cutTime), "4h": sliceUpTo(rows4h, cutTime), "1d": sliceUpTo(rows1d, cutTime) };
const btCut = await replaySymbol({ symbol: "BTCUSDT", interval: "1h", tfRows: tfCut, btcRows: {}, nowMs: cutTime + 300, step: 1 });
const sameSig = btCut.signals.find((s) => s.id === midSignal.id);
check("same timestamp signal reproduced with truncated data", Boolean(sameSig));
if (sameSig) {
  const fields = ["direction", "signal_strength", "confidence", "risk_score", "risk_level", "market_regime_label", "structure_label", "volume_pattern", "volatility_level"];
  const diffs = fields.filter((f) => midSignal[f] !== sameSig[f]);
  check("look-ahead safe: judgement fields identical", diffs.length === 0, diffs.join(","));
}

const series = pickSeriesByHorizon({ "1h": rows1h });
const joined = attachOutcomes(bt.signals, series, nowAll);
const resolvedCount = joined.filter((j) => j.outcome).length;
check("backtest signals resolvable", resolvedCount > 100, String(resolvedCount));
const firstResolved = joined.find((j) => j.outcome);
check("outcomes include 1h/4h/24h", ["1h", "4h", "24h"].every((h) => firstResolved.outcome[`outcome_${h}`] != null));
check("5m unresolved with 1h-only data", firstResolved.outcome.outcome_5m == null, JSON.stringify(firstResolved.outcome.outcome_5m));
const btStats = overallStats(joined, "1h");
check("backtest stats computable", btStats.accuracy != null, JSON.stringify({ samples: btStats.samples, resolved: btStats.resolved, acc: btStats.accuracy }));
const plan = makeBacktestPlan({ interval: "1h", bars: 1000 });
check("plan includes 4h/1d support data", plan.need.some((n) => n.tf === "4h") && plan.need.some((n) => n.tf === "1d"));
eq("plan span ~42 days", Math.round(plan.spanMs / 86400000), 42);

console.log("== 8. storage layer (memory backend) ==");
const store = await createHistoryStore({ memory: true });
eq("memory mode available", store.mode, "memory");
await store.signals.putMany(recs.map((r) => r.signal));
await store.outcomes.putMany(recs.filter((r) => r.outcome).map((r) => r.outcome));
eq("signals written", await store.signals.count(), 20);
eq("outcomes written", await store.outcomes.count(), 19);
const j = await store.joined();
eq("joined view rows", j.length, 20);
const jStats = overallStats(j, "1h");
eq("joined stats match", jStats.accuracy, 80);
await store.meta("last_backtest_at", 12345);
eq("meta roundtrip", await store.meta("last_backtest_at"), 12345);
await store.generic.put("backtest_runs", { id: "run1", status: "completed", started_at: 1, total_signals: 20 });
const runs = await store.generic.all("backtest_runs");
eq("backtest run stored", runs.length, 1);
await store.signals.del("a0");
eq("delete one", await store.signals.count(), 19);
await store.clearAll();
eq("clear all", await store.signals.count(), 0);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("HISTORY TESTS OK");
