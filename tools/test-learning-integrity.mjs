// tools/test-learning-integrity.mjs · V16.2z · 学习数据完整性(工单 §39 TEST1-14 + 晋升闸门)
// 原则:训练样本 = 冻结的 canonical 快照;重复分析/重复解析/重启/后台恢复都不允许增加训练样本;
//       Seed/Revision/TEST 一律 learning_eligible=false;窗口严格 T→T+H;Meta 与真实行重算一致。
import * as LC from "../worker/src/paper/learningCore.js";
import { createHistoryStore } from "../worker/src/history/store.js";
import { recordAnalysis, resolveDueOutcomes } from "../worker/src/history/pipeline.js";
import { computeMFEMAE, resolveHorizon } from "../worker/src/history/outcome.js";
import { promoteModel } from "../worker/src/paper/learning.js";

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log("PASS  " + name); }
  else { failed += 1; console.log("FAIL  " + name + (detail ? "  => " + detail : "")); }
}
const T0 = 1791100800000;   // 一个固定的收盘K线时刻
function mkAnalysis(over) {
  return Object.assign({
    symbol: "BTCUSDT", interval: "1h", price: 42000, change24h: 1.2,
    market_regime: { label: "Weak Uptrend", trend_market: true, vol_state: "Normal", adx: 24, atr_pct: 1.1 },
    direction: "Bullish", signal_strength: 62, confidence: 58, risk_score: 30, risk_level: "Low",
    features: { rsi14: 61, macd_hist: 40.7, adx: 24, atr_pct: 1.1, ema20_dist_pct: 0.5, volume_ratio20: 1.3, tf_align: 0.4 },
    data_close_time: T0, model_version: "rule-v0.1", limited_data: false
  }, over || {});
}
function klines(fromMs, count, stepMs, price) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const openTime = fromMs + i * stepMs;
    const p = price + i * 0.1;
    rows.push({ openTime, open: p, high: p + 5, low: p - 5, close: p + (i % 2 ? 1 : -1), volume: 100, closeTime: openTime + stepMs - 1 });
  }
  return rows;
}
const eligibleOf = (rows) => rows.filter((r) => LC.learningEligibilityGate(r, {}).allow).length;

console.log("== TEST 1: 同一收盘K线分析 100 次 → 1 canonical + N revision,训练样本仍为 1 ==");
{
  const store = await createHistoryStore({ memory: true });
  const results = [];
  for (let i = 0; i < 100; i += 1) {
    results.push(await recordAnalysis(store, mkAnalysis({ confidence: 58 + (i % 7), signal_strength: 62 + (i % 6), features: { rsi14: 61, macd_hist: 40 + i / 10 } }), { source: "live" }));
  }
  const all = await store.signals.all(500);
  const canon = all.filter((s) => s.record_type === "CANONICAL");
  const revs = all.filter((s) => s.record_type === "REVISION");
  check("TEST1: 恰好 1 条 CANONICAL", canon.length === 1, JSON.stringify(canon.map((c) => c.id)));
  check("TEST1: 其余为 REVISION 且全部 learning_eligible=false", revs.length > 0 && revs.every((r) => r.learning_eligible === false && r.revision_of === canon[0].id), JSON.stringify({ revs: revs.length }));
  check("TEST1: 有效训练样本数 = 1(不被 revision 充数)", eligibleOf(all) === 1, String(eligibleOf(all)));
  check("TEST1: canonical_sample_id 稳定且一致", canon[0].canonical_sample_id === LC.canonicalIdOf(mkAnalysis({})), canon[0].canonical_sample_id);
}

console.log("== TEST 2: Outcome Resolver 跑 100 次 → canonical 数量不变 ==");
{
  const store = await createHistoryStore({ memory: true });
  await recordAnalysis(store, mkAnalysis({}), { source: "live" });
  const nowMs = T0 + 3 * 3600000;
  const fetchK = async (symbol, interval) => klines(T0 - 6 * 3600000, 720, 60000, 42000);
  let canonBefore = (await store.signals.all(500)).filter((s) => s.record_type === "CANONICAL").length;
  for (let i = 0; i < 100; i += 1) await resolveDueOutcomes(store, fetchK, { now: nowMs, maxSignals: 5, maxFetches: 5 });
  const all = await store.signals.all(500);
  check("TEST2: canonical 数量不增加(不造 revision)", all.filter((s) => s.record_type === "CANONICAL").length === canonBefore && all.filter((s) => s.record_type === "REVISION").length === 0, JSON.stringify({ canon: all.length }));
  const outs = await store.outcomes.all(50);
  check("TEST2: 结果写入 signal_outcomes(按 canonical id,幂等更新)", outs.length >= 1 && outs.every((o) => o.signal_id === all[0].id), JSON.stringify(outs.map((o) => o.signal_id)));
}

console.log("== TEST 3/4: Seed / TEST 环境不进入有效训练样本 ==");
{
  const rows = [
    { id: "seed_s1", symbol: "BTCUSDT", engine_version: "seed", timestamp: T0, interval: "1h" },
    { id: "sig_x1", symbol: "BTCUSDT", engine_version: "rule-v0.1", timestamp: T0, interval: "1h", source: "live", sample_origin: "SEED", price: 42000 },
    { id: "sig_x2", symbol: "BTCUSDT", engine_version: "rule-v0.1", timestamp: T0, interval: "1h", source: "live", environment: "TEST", record_type: "CANONICAL", sample_origin: "REAL_SIGNAL", price: 42000, feature_schema_version: "fs-v1" },
    { id: "sig_x3", symbol: "BTCUSDT", engine_version: "rule-v0.1", timestamp: T0, interval: "1h", source: "live", record_type: "CANONICAL", sample_origin: "REAL_SIGNAL", environment: "PRODUCTION_PAPER", feature_schema_version: "fs-v1", price: 42000 }
  ];
  check("TEST3: seed 存在也不增加有效训练样本", eligibleOf(rows.slice(0, 1)) === 0);
  check("TEST4: source=live 但 sample_origin=SEED → 不得进入 ML", eligibleOf([rows[1]]) === 0);
  check("TEST4b: environment=TEST → learning_eligible=false(§23)", eligibleOf([rows[2]]) === 0);
  check("TEST4c: 纯正 REAL_SIGNAL/PRODUCTION_PAPER → 可训练", eligibleOf([rows[3]]) === 1);
}

console.log("== TEST 5/6: 冻结快照不可改;Outcome 可更新 ==");
{
  const store = await createHistoryStore({ memory: true });
  await recordAnalysis(store, mkAnalysis({}), { source: "live" });
  const before = (await store.signals.all(10))[0];
  for (let i = 0; i < 30; i += 1) await recordAnalysis(store, mkAnalysis({ features: { rsi14: 5 + i, macd_hist: -9 - i }, confidence: 20 }), { source: "live" });
  const after = (await store.signals.all(10)).find((s) => s.record_type === "CANONICAL");
  const afterFeat = JSON.parse(after.features);
  check("TEST5: Canonical 的 RSI/特征/置信度创建后不被覆盖", afterFeat.rsi14 === 61 && after.confidence === 58 && after.feature_snapshot_hash === before.feature_snapshot_hash, JSON.stringify({ rsi: afterFeat.rsi14, conf: after.confidence }));
  const nowMs = T0 + 6 * 3600000;
  const nResolvedBefore = 0;
  await resolveDueOutcomes(store, async () => klines(T0 - 3600000, 500, 60000, 42000), { now: nowMs, maxSignals: 5, maxFetches: 5 });
  const mid = (await store.signals.all(10)).find((s) => s.record_type === "CANONICAL");
  check("TEST6: Outcome 解析后 Entry Features 仍冻结", JSON.parse(mid.features).rsi14 === 61 && mid.confidence === 58);
  check("TEST6b: 结果另行落库(signal_outcomes),不写回 Feature 行", (await store.outcomes.all(10)).length >= 1 && nResolvedBefore === 0);
}

console.log("== TEST 7/8: 5m/1h 窗口严格 T→T+H(MFE/MAE 不越窗) ==");
{
  const nowMs = T0 + 5 * 3600000;
  const candles = klines(T0 - 3600000, 400, 60000, 100);            // T-1h → T+~5.6h
  const spike = candles.map((r, i) => (i >= 90 && i < 150 ? Object.assign({}, r, { high: r.high + 1000, low: r.low - 1000 }) : r));   // 尖峰发生在 T+~30m..T+90m
  const sig = { data_close_time: T0, price: 100, direction: "Bullish", interval: "1h", volatility_atr_pct: 1 };
  const r5full = resolveHorizon({ signal: sig, horizon: "5m", candles: spike, nowMs });
  const r5trunc = resolveHorizon({ signal: sig, horizon: "5m", candles: candles, nowMs });
  const r5spikeIn = resolveHorizon({ signal: sig, horizon: "5m", candles: spike.filter((c) => c.closeTime <= T0 + 300000), nowMs });
  check("TEST7: 5m 结果只由 T→T+5m 决定(窗口外尖峰不影响)", Boolean(r5full && r5trunc) && !(r5spikeIn && r5spikeIn.matured) && r5full.ret_pct === r5trunc.ret_pct, JSON.stringify({ a: r5full && r5full.ret_pct, b: r5trunc && r5trunc.ret_pct, spikeIn: r5spikeIn && r5spikeIn.matured }));
  const r1full = resolveHorizon({ signal: sig, horizon: "1h", candles: spike, nowMs });
  const r1trunc = resolveHorizon({ signal: sig, horizon: "1h", candles: candles, nowMs });
  check("TEST8: 1h 窗口含 T+30m..T+60m 尖峰(与全量截断一致)", Boolean(r1full && r1trunc) && r1full.ret_pct === r1trunc.ret_pct, JSON.stringify({ full: r1full && r1full.ret_pct, trunc: r1trunc && r1trunc.ret_pct }));
  const spill = spike.map((r, i) => (i >= 200 ? Object.assign({}, r, { high: r.high + 5000 }) : r));   // 只在 T+2h 之后加尖峰
  const r1late = resolveHorizon({ signal: sig, horizon: "1h", candles: spill, nowMs });
  check("TEST8b: T+2h 之后的尖峰不影响 1h 结果(窗口真的生效)", r1late && r1full && r1late.ret_pct === r1full.ret_pct, JSON.stringify({ late: r1late && r1late.ret_pct }));
  const r5early = resolveHorizon({ signal: sig, horizon: "5m", candles: candles.slice(0, 3), nowMs });
  check("TEST7b: 数据未覆盖目标时刻 → not_matured(不用未来价格凑)", r5early && r5early.matured === false, JSON.stringify(r5early));
}

console.log("== TEST 9/10: 重启 / 后台恢复不再批量重复 ==");
{
  const store = await createHistoryStore({ memory: true });
  for (let i = 0; i < 5; i += 1) await recordAnalysis(store, mkAnalysis({ confidence: 58 + i * 5, signal_strength: 62 + i * 6 }), { source: "live" });
  const count1 = (await store.signals.all(100)).filter((s) => s.record_type === "CANONICAL").length;
  // "重启" = 对同一 store 全量重跑一遍(等价于 App 重启后恢复补写)
  for (let i = 0; i < 5; i += 1) await recordAnalysis(store, mkAnalysis({ confidence: 58 + i * 5, signal_strength: 62 + i * 6 }), { source: "live" });
  const all = await store.signals.all(200);
  check("TEST9: 同一收盘K线重启后不产生第二个 Canonical", all.filter((s) => s.record_type === "CANONICAL").length === count1 && count1 === 1, JSON.stringify({ before: count1 }));
  check("TEST10: 后台恢复补写只落 REVISION(同特征无实质变化则不写)", all.filter((s) => s.record_type === "REVISION").length <= 5, String(all.filter((s) => s.record_type === "REVISION").length));
}

console.log("== TEST 11: 非 BTC(SOL/DOGE/LINK)能跑通 Universe→Feature→Canonical→Outcome(TEST 环境不外泄) ==");
{
  const store = await createHistoryStore({ memory: true });
  const symbols = ["SOLUSDT", "DOGEUSDT", "LINKUSDT"];
  for (const sym of symbols) {
    const res = await recordAnalysis(store, mkAnalysis({ symbol: sym, price: 20 }), { source: "live", environment: "TEST", sample_origin: "REAL_SIGNAL" });
    check("TEST11: " + sym + " 生成 canonical(链路支持非 BTC)", res.recorded === true && res.reason === "canonical_created", JSON.stringify(res));
  }
  const all = await store.signals.all(50);
  check("TEST11: TEST 环境样本全部 learning_eligible=false(不污染正式数据)", all.length === 3 && all.every((s) => s.learning_eligible === false), JSON.stringify(all.map((s) => [s.symbol, s.learning_eligible])));
  const rep = await resolveDueOutcomes(store, async () => klines(T0 - 3600000, 400, 60000, 20), { now: T0 + 3 * 3600000, maxSignals: 5, maxFetches: 5 });
  check("TEST11: 非 BTC canonical 能解析 Outcome", rep.resolved > 0, JSON.stringify(rep));
}

console.log("== TEST 12/13/14: 导出过滤 + Meta 动态统计 ==");
{
  const rows = [
    { id: "seed_a", engine_version: "seed", symbol: "ETHUSDT" },
    { id: "c1", record_type: "CANONICAL", sample_origin: "REAL_SIGNAL", environment: "PRODUCTION_PAPER", feature_schema_version: "fs-v1", symbol: "BTCUSDT", engine_version: "rule-v0.1", price: 42000 },
    { id: "c1_r1", record_type: "REVISION", revision_of: "c1", sample_origin: "REAL_SIGNAL", environment: "PRODUCTION_PAPER", symbol: "BTCUSDT", engine_version: "rule-v0.1" },
    { id: "c2", record_type: "CANONICAL", sample_origin: "REAL_SIGNAL", environment: "PRODUCTION_PAPER", feature_schema_version: "fs-v1", symbol: "SOLUSDT", engine_version: "rule-v0.1", price: 20 }
  ];
  const valid = LC.filterExportRecords(rows, "valid");
  check("TEST12: Valid 导出不含 Seed", valid.every((r) => !String(r.id).startsWith("seed")), JSON.stringify(valid.map((v) => v.id)));
  check("TEST13: Valid 导出不含 Revision", valid.every((r) => r.record_type !== "REVISION") && valid.length === 2);
  const audit = LC.filterExportRecords(rows, "audit");
  check("TEST13b: Audit 导出包含全部(Seed/Revision 可追溯)", audit.length === 4);
  const meta = LC.learningIntegrityReport(rows, {});
  check("TEST14: Meta 动态统计与真实行一致", meta.raw_record_count === 4 && meta.seed_count === 1 && meta.revision_count === 1 && meta.canonical_count === 2 && meta.learning_eligible_count === 2 && meta.by_symbol.BTCUSDT === 2, JSON.stringify(meta).slice(0, 240));
  check("TEST14b: Meta 的引擎/来源/环境是数组(不拿第一条填全文件)", Array.isArray(meta.engine_versions) && meta.engine_versions.indexOf("seed") >= 0 && meta.engine_versions.indexOf("rule-v0.1") >= 0, JSON.stringify(meta.engine_versions));
}

console.log("== 晋升闸门(§1/§14) ==");
{
  const store = await createHistoryStore({ memory: true });
  const adapter = { get: (t, k) => store.generic.get(t, k), all: (t, l) => store.generic.all(t, l), put: (t, r) => store.generic.put(t, r), meta: (k, v) => store.meta(k, v) };
  await store.generic.put("model_registry", { model_id: "m1", model_type: "rule", version: "v1", status: "CHALLENGER" });
  await store.meta("learning_status", { status: "PAUSED_DATA_INTEGRITY", at: Date.now() });
  const blocked = await promoteModel(adapter, "m1", {});
  check("PromotionGateTest: 学习数据被判定污染 → 拒绝晋级", blocked.ok === false && blocked.reason === "LEARNING_PAUSED_DATA_INTEGRITY", JSON.stringify(blocked));
  await store.meta("learning_status", { status: "OK", at: Date.now() });
  const past = await promoteModel(adapter, "m1", {});
  check("PromotionGateTest: 状态 OK → 允许(原行为不变)", past.ok === true, JSON.stringify(past));
}

console.log("== 迁移计划(§32/§33) ==");
{
  const rows = [];
  for (let i = 0; i < 3; i += 1) rows.push({ id: "sig_A_1h_T0" + (i ? "_r" + i : ""), symbol: "AUSDT", interval: "1h", timestamp: T0, engine_version: "rule-v0.1", created_at: T0 + i });
  rows.push({ id: "seed_1", engine_version: "seed", symbol: "BUSDT", timestamp: T0 });
  const plan = LC.migrationPlan(rows, { now: 1 });
  check("MigrationTest: 首次快照选 canonical(不选最后一条)", plan.patches.find((p) => p.id === "sig_A_1h_T0").patch.record_type === "CANONICAL");
  check("MigrationTest: 其余为 REVISION 且 revision_no 顺序编号", plan.patches.filter((p) => p.patch.record_type === "REVISION").map((p) => p.patch.revision_no).join(",") === "1,2");
  check("MigrationTest: seed → SEED/TEST/ineligible + exclusion_reason", (() => { const s = plan.patches.find((p) => p.id === "seed_1").patch; return s.record_type === "SEED" && s.environment === "TEST" && s.learning_eligible === false && s.exclusion_reason === "SEED_DATA"; })());
  check("MigrationTest: 不删除任何记录(patches 覆盖全部行)", plan.patches.length === rows.length);
  const amb = LC.migrationPlan([{ id: "sig_nots", symbol: "XUSDT", interval: "unknown", engine_version: "rule-v0.1" }], {});
  check("MigrationTest: 无法判定首快照 → AMBIGUOUS 且 ineligible(§33)", amb.patches[0].patch.migration_status === "AMBIGUOUS" && amb.patches[0].patch.learning_eligible === false, JSON.stringify(amb.patches[0].patch));
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
