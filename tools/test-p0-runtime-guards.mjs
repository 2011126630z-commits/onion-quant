// tools/test-p0-runtime-guards.mjs · V16.2u P0 守卫测试(工单 §3/§4/§6/§62/§63)
// A. 短/长线重复信号与溯源链(signal_id / strategy_intent_id / decision_id / action_source)
// B. 组合暴露守卫真接线(跨池同币同向 + 同向阵营上限,exposure_allow 不再写死)
// C. Runtime 统一呈现态(7 态;RUNNING/DEGRADED 不显示"开始模拟")
// D. Start 幂等(引擎级:10 次 start 只 1 个 Runtime;不重复 Loop)
import { createPaperEngine, MODE_CONFIG } from "../worker/src/paper/engine.js";
import { createHistoryStore } from "../worker/src/history/store.js";
import { capitalAllocation, CAPITAL_LIMITS, clusterOfSymbol } from "../worker/src/paper/capitalAllocator.js";
import { paperRuntimeView, PAPER_RUNTIME_STATES } from "../worker/src/ui/viewModels.js";

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log("PASS  " + name); }
  else { failed += 1; console.log("FAIL  " + name + (detail ? "  => " + detail : "")); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}

let clock = 1700000000000;
const T0 = 1700000000000;
function makeEngine() {
  return createPaperEngine({
    store: (() => {
      const mem = new Map();
      return {
        get: async (t, k) => mem.get(t + "|" + k) || null,
        all: async (t) => [...mem.entries()].filter(([kk]) => kk.startsWith(t + "|")).map(([, v]) => v),
        put: async (t, r) => { mem.set(t + "|" + (r.id || r.trade_id || r.position_id || Math.random()), r); return r; }
      };
    })(),
    now: () => clock,
    riskCheck: () => ({ veto: false }),
    fetchKlines: async () => []
  });
}
const analysisOf = (dir) => ({
  direction: dir,
  confidence: 70,
  volatility: { atrPct: 1.2 },
  market_regime: { label: "Weak Uptrend" },
  structure: { last_swing_low: 90, last_swing_high: 110 },
  support_zones: [{ hi: 95 }], resistance_zones: [{ lo: 108 }]
});
async function openEng(eng, { mode, symbol, direction, candle, price, riskPct }) {
  return eng.openPosition({
    mode, symbol, direction, signal_timestamp: candle, closed_candle_time: candle,
    quote: { price, received_at: clock },
    analysis: analysisOf(direction),
    riskPct: riskPct == null ? 15 : riskPct
  });
}

console.log("== A. 短/长线独立意图 + 全链路溯源 ==");
{
  clock = T0;
  const eng = makeEngine();
  await eng.init();
  await eng.start();
  // 同一时刻(同 wall clock 收盘)同向:短线(1h)与长线(4h)各自处理 —— 属于两个独立策略意图
  const shortOpen = await openEng(eng, { mode: "short", symbol: "ETHUSDT", direction: "Bearish", candle: T0, price: 100 });
  const longOpen = await openEng(eng, { mode: "long", symbol: "ETHUSDT", direction: "Bearish", candle: T0, price: 100 });
  check("ShortLongIndependentIntentTest:同币同向两个模式都可开(设计=两个独立策略)", shortOpen.ok === true && longOpen.ok === true, JSON.stringify([shortOpen.reason, longOpen.reason]));
  const pShort = shortOpen.position;
  const pLong = longOpen.position;
  check("ShortLongIndependentIntentTest:两个持仓策略意图不同(含模式)", pShort.strategy_intent_id !== pLong.strategy_intent_id && /intent_short_/.test(pShort.strategy_intent_id) && /intent_long_/.test(pLong.strategy_intent_id), JSON.stringify([pShort.strategy_intent_id, pLong.strategy_intent_id]));
  check("ShortLongIndependentIntentTest:策略模式字段正确", pShort.strategy_mode === "SHORT_TERM" && pLong.strategy_mode === "LONG_TERM", JSON.stringify([pShort.strategy_mode, pLong.strategy_mode]));
  // 溯源链完整性:signal/intent/decision/position/action_source
  const chainOk = (p) => Boolean(p.signal_id && p.strategy_intent_id && p.decision_id && p.position_id && p.action_source);
  check("TraceabilityChainTest:仓位带全链路 ID(signal/intent/decision/position/source)", chainOk(pShort) && chainOk(pLong), JSON.stringify({ s: pShort.signal_id, i: pShort.strategy_intent_id, d: pShort.decision_id, a: pShort.action_source }));
  check("TraceabilityChainTest:signal_id 确定性派生(symbol|周期|收盘K线|方向)", pShort.signal_id === "sig_ETHUSDT_1h_" + T0 + "_S" && pLong.signal_id === "sig_ETHUSDT_4h_" + T0 + "_S", JSON.stringify([pShort.signal_id, pLong.signal_id]));
  check("TraceabilityChainTest:decision_id 由 intent 派生", pShort.decision_id === "dec_" + pShort.strategy_intent_id, pShort.decision_id);
  // 决策日志同样可追溯(走引擎公开访问器)
  const jEntries = eng.journalEntries({ kind: "ENTRY" });
  const e0 = (jEntries || []).find((x) => x.mode === "short" && x.symbol === "ETHUSDT");
  check("TraceabilityChainTest:决策日志带 signal/intent/decision", Boolean(e0 && e0.signal_id === pShort.signal_id && e0.strategy_intent_id === pShort.strategy_intent_id && e0.decision_id === pShort.decision_id), JSON.stringify(e0 && { s: e0.signal_id, i: e0.strategy_intent_id, d: e0.decision_id }));
  // 幂等:同模式同信号重复 → 拒绝
  const dup = await openEng(eng, { mode: "short", symbol: "ETHUSDT", direction: "Bearish", candle: T0, price: 100 });
  check("SameModeSameSignalDuplicateBlockedTest:同模式同信号重复开仓被幂等拒绝", dup.ok === false && dup.reason === "duplicate_idempotency_key", JSON.stringify(dup.reason));
  check("SameModeSameSignalDuplicateBlockedTest:只存在两个持仓(短+长),没有第三个", eng.getPositions().filter((p) => p.status === "OPEN").length === 2, String(eng.getPositions().filter((p) => p.status === "OPEN").length));
}

console.log("== B. 组合暴露守卫(跨池同币同向 / 同向阵营上限) ==");
{
  // 确定性场景(探针实测口径):相关性加权后,同阵营同向两仓 ≈ 双倍计入,阵营满额→Entry Gate 直接拒。
  clock = T0 + 3600000;
  const eng = makeEngine();
  await eng.init();
  await eng.start();
  const o1 = await openEng(eng, { mode: "short", symbol: "BTCUSDT", direction: "Bullish", candle: clock, price: 100, riskPct: 100 });
  check("ClusterExposureGuardTest:大额开仓成功(正向对照)", o1.ok === true && o1.position.initial_margin > 20 && o1.position.initial_margin <= 28.01, JSON.stringify({ ok: o1.ok, m: o1.position && o1.position.initial_margin }));
  clock += 3600000;
  const o2 = await openEng(eng, { mode: "short", symbol: "SOLUSDT", direction: "Bullish", candle: clock, price: 100, riskPct: 100 });
  check("ClusterExposureGuardTest:第二仓成功但阵营已被相关性加权顶到上限", o2.ok === true, JSON.stringify(o2.reason));
  const expo = eng.exposure();
  const clusterNow = Number(expo.by_cluster["CRYPTO_BETA|LONG"] || 0);
  const acct = eng.getAccount();
  const clusterCap = Number(acct.total_equity) * CAPITAL_LIMITS.cluster_same_direction_pct / 100;
  check("ClusterExposureGuardTest:同向阵营暴露 ≥ 上限(相关度加权 2×,BTC+SOL 即触顶)", clusterNow >= clusterCap - 1e-6, "cluster=" + clusterNow.toFixed(4) + " cap=" + clusterCap.toFixed(4));
  // 第三仓(换池:长线池 ETH,模拟"短线池与长线池同时对同向下注"场景)→ 必须被 Entry Gate 拒绝
  clock += 3600000;
  const third = await openEng(eng, { mode: "long", symbol: "ETHUSDT", direction: "Bullish", candle: clock, price: 100, riskPct: 100 });
  check("ClusterExposureGuardTest:阵营满额后跨池第三仓被拒(EXPOSURE_CAP)", third.ok === false && String(third.reason).indexOf("EXPOSURE_CAP") >= 0, JSON.stringify({ r: third.reason, q: third.quality && third.quality.blockers }));
  check("ClusterExposureGuardTest:被拒是正式决策(有中文理由+影子记录)", Boolean(third.quality && (third.quality.block_reasons_zh || []).length > 0) && Number(eng.qualitySkips()) >= 1, JSON.stringify(third.quality && third.quality.block_reasons_zh));
  // 反向对照:全新引擎只开一仓,同向第二仓必须放行(守卫响应真实暴露,不是一刀切封死)
  const eng2 = makeEngine();
  await eng2.init();
  await eng2.start();
  const c1 = await openEng(eng2, { mode: "short", symbol: "BTCUSDT", direction: "Bullish", candle: T0 + 3600000, price: 100, riskPct: 100 });
  const c2 = await openEng(eng2, { mode: "short", symbol: "SOLUSDT", direction: "Bullish", candle: T0 + 7200000, price: 100, riskPct: 100 });
  check("ClusterExposureGuardTest:余量充足时同向开仓放行(对照组)", c1.ok === true && c2.ok === true, JSON.stringify([c1.reason, c2.reason]));
  // 跨池同币同向:同一 symbol 在短/长两池各开一仓 → 两笔都进入同一阵营暴露(不是各自孤立的 40%)
  const eng3 = makeEngine();
  await eng3.init();
  await eng3.start();
  const d1 = await openEng(eng3, { mode: "short", symbol: "BTCUSDT", direction: "Bullish", candle: T0 + 3600000, price: 100 });
  const d2 = await openEng(eng3, { mode: "long", symbol: "BTCUSDT", direction: "Bullish", candle: T0 + 3600000, price: 100 });
  check("CrossPoolSameSymbolTest:跨池同币同向两仓都可开(设计允许,但必须计入组合)", d1.ok === true && d2.ok === true, JSON.stringify([d1.reason, d2.reason]));
  const expo3 = eng3.exposure();
  const cluster3 = Number(expo3.by_cluster["CRYPTO_BETA|LONG"] || 0);
  const mSum = Number(d1.position.initial_margin) + Number(d2.position.initial_margin);
  check("CrossPoolSameSymbolTest:两笔保证金都计入同一阵营暴露(不再孤立)", cluster3 >= mSum - 1e-6, "cluster=" + cluster3.toFixed(4) + " sum=" + mSum.toFixed(4));
  // 纯函数口径对照:配额归零必须报"真因"(阵营/组合),不得误报 LIQUIDITY_EMPTY
  const pureCluster = capitalAllocation({ equity: 100, requested_pct: 40, quality_score: 90, positions: [{ symbol: "BTCUSDT", direction: "LONG", status: "OPEN", remaining_margin: 20 }, { symbol: "ETHUSDT", direction: "LONG", status: "OPEN", remaining_margin: 20 }], available_cash: 1e12, symbol: "SOLUSDT", direction: "LONG" });
  check("ClusterExposureGuardTest:capitalAllocation 阵营顶满 → CLUSTER_CAP(不误报资金不足)", pureCluster.allowed === false && pureCluster.code === "CLUSTER_CAP", JSON.stringify({ a: pureCluster.allowed, c: pureCluster.code, caps: pureCluster.caps_applied }));
  const purePortfolio = capitalAllocation({ equity: 100, requested_pct: 40, quality_score: 90, positions: [{ symbol: "BTCUSDT", direction: "LONG", status: "OPEN", remaining_margin: 40 }, { symbol: "ETHUSDT", direction: "LONG", status: "OPEN", remaining_margin: 40 }], available_cash: 1e12, symbol: "SOLUSDT", direction: "LONG" });
  check("ClusterExposureGuardTest:组合保证金顶满 → PORTFOLIO_CAP(相关度加权后先绑定)", purePortfolio.allowed === false && purePortfolio.code === "PORTFOLIO_CAP", JSON.stringify({ a: purePortfolio.allowed, c: purePortfolio.code }));
  check("CrossPoolSameSymbolTest:聚类口径集中在 CRYPTO_BETA(同阵营=同一份风险)", clusterOfSymbol("BTCUSDT") === "CRYPTO_BETA" && clusterOfSymbol("ETHUSDT") === "CRYPTO_BETA" && CAPITAL_LIMITS.cluster_same_direction_pct === 80);
}

console.log("== C. Runtime 统一呈现态(7 态) ==");
eq("RuntimeStateUnifiedTest:态清单固定 7 态", PAPER_RUNTIME_STATES, ["STOPPED", "STARTING", "RUNNING", "PAUSED", "DEGRADED", "SAFE_MODE", "HARD_STOP"]);
{
  const stopped = paperRuntimeView({ engine_state: "STOPPED" });
  check("RuntimeStateUnifiedTest:STOPPED → 可开始/显示开始按钮", stopped.can_start === true && stopped.show_start_button === true && stopped.label === "已停止");
  const starting = paperRuntimeView({ engine_state: "RECOVERING" });
  check("RuntimeStateUnifiedTest:RECOVERING 归一到启动中", starting.state === "STARTING" && starting.show_start_button === false);
  const running = paperRuntimeView({ engine_state: "RUNNING" });
  check("RuntimeStateUnifiedTest:RUNNING → 不显示开始按钮、可暂停(核心回归)", running.show_start_button === false && running.can_pause === true && running.running === true && running.label === "自动模拟运行中");
  const paused = paperRuntimeView({ engine_state: "PAUSED" });
  check("RuntimeStateUnifiedTest:PAUSED → 继续模拟", paused.can_resume === true && paused.show_start_button === true && paused.label === "已暂停");
  const hard = paperRuntimeView({ engine_state: "RUNNING", hwm_block: true, hwm_drawdown_pct: 21.4 });
  check("RuntimeStateUnifiedTest:RUNNING+HWM 触发 → HARD_STOP(禁新开仓,可暂停)", hard.state === "HARD_STOP" && hard.show_start_button === false && hard.can_pause === true && /21\.4/.test(hard.reason_short));
  const safe = paperRuntimeView({ engine_state: "RUNNING", entries_paused: true, entries_paused_reason: "数据完整性保护" });
  check("RuntimeStateUnifiedTest:RUNNING+暂停新开仓 → SAFE_MODE", safe.state === "SAFE_MODE" && safe.show_start_button === false && safe.note_zh.length > 0);
  const degraded = paperRuntimeView({ engine_state: "RUNNING", data_degraded: true, market_stale: true });
  check("RuntimeStateUnifiedTest:RUNNING+数据降级 → DEGRADED(仍在运行)", degraded.state === "DEGRADED" && degraded.running === true && degraded.show_start_button === false);
  const err = paperRuntimeView({ engine_state: "ERROR" });
  check("RuntimeStateUnifiedTest:ERROR → SAFE_MODE", err.state === "SAFE_MODE");
  const stoppedHwm = paperRuntimeView({ engine_state: "STOPPED", hwm_block: true });
  check("RuntimeStateUnifiedTest:STOPPED+HWM → HARD_STOP(保护优先于停止)", stoppedHwm.state === "HARD_STOP");
}

console.log("== D. Start 幂等(引擎级:10 次只 1 个 Runtime) ==");
{
  clock = T0 + 7200000;
  const eng = makeEngine();
  await eng.init();
  const results = [];
  for (let i = 0; i < 10; i += 1) results.push(await eng.start());
  const okCount = results.filter((r) => r.ok).length;
  check("StartIdempotent10ClicksTest:10 次 start 只有第 1 次真正启动", okCount === 1 && results.slice(1).every((r) => r.reason === "already_running" || r.ok === false), JSON.stringify(results.map((r) => r.reason || (r.ok ? "ok" : "?"))));
  check("StartIdempotent10ClicksTest:状态保持 RUNNING 单实例", eng.getState() === "RUNNING");
  const view = eng.runtimeView();
  check("RuntimeViewAccessorTest:引擎暴露统一呈现态输入", view && view.state === "RUNNING" && typeof view.hwm_block === "boolean" && typeof view.data_quality_ok === "boolean", JSON.stringify(view));
  // 幂等 10 次 start 后仅一个引擎实例(工厂级单例由页面保证;这里验证引擎状态不被叠加)
  check("StartIdempotent10ClicksTest:没有产生并发 Loop 痕迹(loops 正常可推进)", (await eng.loop({ quotes: { BTCUSDT: { price: 100, received_at: clock } }, candidates: [] })).ok === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("P0 RUNTIME GUARDS OK");
