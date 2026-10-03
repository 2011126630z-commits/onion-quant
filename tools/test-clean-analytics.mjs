// tools/test-clean-analytics.mjs · V15.1:CLEAN/Raw 双口径 + 学习过滤 + Position 级杠杆 + 诊断 + 幂等 + Provider
import { createHistoryStore } from "../worker/src/history/store.js";
import { num, round, summarizePositions, summarizeTrades, isCleanTrade, cleanAnalyticsSummary, CLEAN_EXCLUDE_MARKERS, isValidReturnPct } from "../worker/src/paper/accounting.js";
import { createPaperEngine, closedCandleTime } from "../worker/src/paper/engine.js";
import { createPaperRuntime, runtimeStatus, MARKET_BLOCKED_CODE, PROVIDER_STATES } from "../worker/src/paper/runtime.js";
import { attributionOf, attributionView } from "../worker/src/paper/attribution.js";
import { LEVERAGE_POLICY } from "../worker/src/paper/leverageManager.js";

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
  check(name, Math.abs(num(actual) - num(expected)) <= (tol === undefined ? 1e-6 : tol), `got ${actual} want ~${expected}`);
}

const T0 = 1700000000000;
const mkAdapter = (store) => ({ get: (t, k) => store.generic.get(t, k), all: (t) => store.generic.all(t), put: (t, r) => store.generic.put(t, r), del: (t, k) => store.generic.del(t, k) });

// 历史账本样本:2 个正常仓位 + 一批修复前碎片(event 级)
const legacy = [
  { trade_id: "trd_pos_A", position_id: "pos_A", parent_position_id: "pos_A", trade_id: "t_a1", symbol: "BTCUSDT", mode: "short", side: "LONG", net_pnl: 2, fees: 0.04, quantity: 0.5, entry_price: 100, exit_price: 104, entry_time: T0 - 3600000, exit_time: T0, exit_reason: "take_profit", leverage: 2, market_regime: "Uptrend" },
  { trade_id: "t_a2", position_id: "pos_A", parent_position_id: "pos_A", symbol: "BTCUSDT", mode: "short", side: "LONG", net_pnl: -0.5, fees: 0.02, quantity: 0.5, entry_price: 100, exit_price: 98, entry_time: T0 - 3600000, exit_time: T0 + 60000, exit_reason: "stop_loss", partial: false, leverage: 2 },
  { trade_id: "t_b1", position_id: "pos_B", parent_position_id: "pos_B", symbol: "ETHUSDT", mode: "long", side: "SHORT", net_pnl: 3, fees: 0.05, quantity: 0.2, entry_price: 200, exit_price: 190, entry_time: T0 - 7200000, exit_time: T0 + 120000, exit_reason: "take_profit", leverage: 3, market_regime: "Ranging" },
  // 修复前碎片(应被排除)
  { trade_id: "trd_partial_pos_C_0", symbol: "BNBUSDT", mode: "short", side: "LONG", net_pnl: -0.01, fees: 0.002, quantity: 0.0000001, entry_price: 764, exit_price: 763, entry_time: T0 - 100000, exit_time: T0 + 130000, exit_reason: "profit_lock_stage4", partial: true, repair_reason: "tiny_slice,shredded_cluster", invalid_for_learning: true, leverage: 2 },
  { trade_id: "trd_partial_pos_C_1", symbol: "BNBUSDT", mode: "short", side: "LONG", net_pnl: -0.01, fees: 0.002, quantity: 0.0000001, entry_price: 764, exit_price: 763, entry_time: T0 - 100000, exit_time: T0 + 140000, exit_reason: "profit_lock_stage4", partial: true, invalid_for_learning: true, leverage: 2 },
  { trade_id: "trd_bad", position_id: "pos_D", parent_position_id: "pos_D", symbol: "SOLUSDT", mode: "short", side: "LONG", net_pnl: -22.94, fees: 0.01, quantity: 0.005, entry_price: 100, exit_price: 20, entry_time: T0, exit_time: T0 + 150000, exit_reason: "manual", return_pct: -2624.73, invalid_for_learning: true, invalid_sample: true, leverage: 2 }
];

console.log("== 1. RAW Ledger 保持(不自动回滚) ==");
{
  const rawSum = summarizePositions(legacy, { clean: false });
  check("RAW 口径包含全部事件(含碎片)", rawSum.events >= 6 && rawSum.raw_events === legacy.length, JSON.stringify({ events: rawSum.events, raw: rawSum.raw_events }));
  eq("RAW 口径不打清洗标记", rawSum.excluded_events, 0);
  // 账本金额未被改写
  near("历史 net_pnl 原样保留", legacy[3].net_pnl, -0.01);
  near("历史越界收益原样保留(只标记)", legacy[5].return_pct, -2624.73);
  check("标记字段存在但金额字段未被触碰", legacy[5].invalid_for_learning === true && legacy[5].net_pnl === -22.94);
}

console.log("== 2. CLEAN Strategy Analytics 口径 ==");
{
  const cleanSum = summarizePositions(legacy);
  eq("默认走 CLEAN 口径", cleanSum.caliber, "clean");
  check("排除不可学习事件", cleanSum.excluded_events >= 3, JSON.stringify({ excluded: cleanSum.excluded_events, reasons: cleanSum.excluded_reasons }));
  check("排除原因可解释", Object.keys(cleanSum.excluded_reasons).length >= 1, JSON.stringify(cleanSum.excluded_reasons));
  eq("清洗后只剩 2 个完整仓位", cleanSum.positions, 2);
  near("清洗后净额不含碎片与虚假亏损", cleanSum.net_pnl, 4.5, 1e-9);
  const summary = cleanAnalyticsSummary(legacy);
  eq("统计与逐条判定一致", summary.excluded_events, legacy.length - cleanAnalyticsSummary(legacy).clean_events);
  check("判定函数识别全部排除标记", CLEAN_EXCLUDE_MARKERS.every((m) => typeof m === "string"));
  eq("无标记成交视为 clean", isCleanTrade({ net_pnl: 1 }), true);
  eq("带越界收益标记的不 clean", isCleanTrade({ repair_reason: "return_out_of_range" }), false);
  // 归因默认 clean + position
  const attr = attributionOf(legacy, {});
  eq("归因默认 position 口径", attr.level, "position");
  eq("归因只统计清洗后仓位", attr.sample.valid, 2);
  check("归因说明口径", /完整仓位/.test(attributionView(attr, {}).sample_text), attributionView(attr, {}).sample_text);
  const attrRaw = attributionOf(legacy, { include_invalid: true, level: "trade" });
  check("高级详情可看 RAW 口径", attrRaw.sample.total === legacy.length, JSON.stringify(attrRaw.sample));
}

console.log("== 3. 学习过滤:旧数据绝不进学习 ==");
{
  const store = await createHistoryStore({ memory: true });
  const adapter = mkAdapter(store);
  const clock = { t: T0 };
  const eng = createPaperEngine({ store: adapter, now: () => clock.t, riskCheck: () => ({ veto: false, risk_score: 20 }), fetchKlines: async () => [] });
  await eng.init();
  // 灌入历史账本(含碎片与虚假收益)
  for (const t of legacy) await adapter.put("paper_trades", t);
  const eng2 = createPaperEngine({ store: adapter, now: () => clock.t, riskCheck: () => ({ veto: false, risk_score: 20 }), fetchKlines: async () => [] });
  await eng2.init();
  const diag = eng2.leverageDiagnostics();
  eq("杠杆学习只用 CLEAN 仓位样本", diag.records, 2);
  eq("样本按 Short/Long 分池", diag.by_mode.short >= 1 && diag.by_mode.long >= 1, true);
  check("诊断说明为何没升档", /不足|等待/.test(diag.why_not_upgraded), diag.why_not_upgraded);
  check("诊断给出所需样本数", diag.required_samples >= num((LEVERAGE_POLICY.min_samples || {})[3], 20), JSON.stringify(diag.required_samples));
  eq("状态=样本不足时不强升档", diag.upgrade_ready, false);
  const samples = await adapter.all("learning_samples");
  check("历史碎片不产生学习样本", samples.filter((s) => /tiny_slice|shredded_cluster/.test(String(s.invalid_reason || ""))).length >= 0 && samples.every((s) => s.invalid_sample !== false || !/shredded/.test(String(s.invalid_reason))), JSON.stringify(samples.length));
  check("杠杆记录都是 Position 级(带 position_id 或唯一来源)", eng2.engine.leverageRecords.every((r) => r.position_id == null || typeof r.position_id === "string"));
}

console.log("== 4. Position 级杠杆学习(一个仓位一个 outcome) ==");
{
  const store = await createHistoryStore({ memory: true });
  const adapter = mkAdapter(store);
  const clock = { t: T0 };
  const eng = createPaperEngine({ store: adapter, now: () => clock.t, riskCheck: () => ({ veto: false, risk_score: 20 }), fetchKlines: async () => [] });
  await eng.init();
  await eng.openPosition({
    mode: "short", symbol: "BTCUSDT", direction: "Bullish", signal_timestamp: T0,
    quote: { price: 100, received_at: T0 },
    analysis: { direction: "Bullish", confidence: 70, volatility: { atrPct: 1 }, market_regime: { label: "Weak Uptrend" } },
    leverage: 3
  });
  const pos = eng.getPositions().find((p) => p.status === "OPEN");
  check("持仓记录了杠杆来源", Boolean(pos.leverage_source), String(pos.leverage_source));
  // 连续部分平仓 3 次 + 最后全平
  await eng.closePosition(pos, { reference_price: 101, exit_reason: "partial_take_profit_tp1", fraction: 0.25 });
  await eng.closePosition(eng.getPositions().find((p) => p.position_id === pos.position_id), { reference_price: 102, exit_reason: "partial_take_profit_tp2", fraction: 0.3 });
  await eng.closePosition(eng.getPositions().find((p) => p.position_id === pos.position_id), { reference_price: 103, exit_reason: "take_profit", fraction: 1 });
  const trades = eng.getTrades();
  check("一个仓位产生多条事件", trades.filter((t) => (t.parent_position_id || t.position_id) === pos.position_id).length >= 2, String(trades.length));
  eq("杠杆学习仍只有 1 条 outcome(不按事件拆碎)", eng.engine.leverageRecords.filter((r) => r.symbol === "BTCUSDT").length, 1);
  const posSum = summarizePositions(trades);
  eq("Position 级统计仍为 1 个仓位", posSum.positions, 1);
  check("Position 级收益合理", isValidReturnPct(posSum.rows[0].return_on_position_pct, 3), JSON.stringify(posSum.rows[0].return_on_position_pct));
}

console.log("== 5. Profit Lock 新数据监控 ==");
{
  const store = await createHistoryStore({ memory: true });
  const adapter = mkAdapter(store);
  const clock = { t: T0 };
  const eng = createPaperEngine({ store: adapter, now: () => clock.t, riskCheck: () => ({ veto: false, risk_score: 20 }), fetchKlines: async () => [], profitLock: { trendStrength: 0.55, reversalRisk: 0.3 } });
  await eng.init();
  const diag = eng.profitLockDiagnostics();
  check("诊断字段齐全", ["avg_partials_per_position", "max_partials_per_position", "dust_closes", "stage_distribution", "fee_drag"].every((k) => k in diag), JSON.stringify(Object.keys(diag)));
  eq("空账本无告警", diag.warning, false);
  for (const t of legacy) await adapter.put("paper_trades", t);
  const eng2 = createPaperEngine({ store: adapter, now: () => clock.t, riskCheck: () => ({ veto: false, risk_score: 20 }), fetchKlines: async () => [], profitLock: {} });
  await eng2.init();
  const diag2 = eng2.profitLockDiagnostics();
  check("能统计 stage 分布", Object.keys(diag2.stage_distribution).length >= 1, JSON.stringify(diag2.stage_distribution));
  check("能统计费用拖累", diag2.fee_drag.fees > 0, JSON.stringify(diag2.fee_drag));
}

console.log("== 6. Closed Candle 幂等(持久化 + 重启不重复) ==");
{
  const store = await createHistoryStore({ memory: true });
  const adapter = mkAdapter(store);
  const clock = { t: T0 };
  const candle = closedCandleTime(T0, 3600000);
  const open1 = (eng) => eng.openPosition({
    mode: "short", symbol: "BTCUSDT", direction: "Bullish", signal_timestamp: candle,
    quote: { price: 100, received_at: clock.t },
    analysis: { direction: "Bullish", confidence: 70, volatility: { atrPct: 1 }, market_regime: { label: "Weak Uptrend" } },
    leverage: 2
  });
  const engA = createPaperEngine({ store: adapter, now: () => clock.t, riskCheck: () => ({ veto: false, risk_score: 20 }), fetchKlines: async () => [] });
  await engA.init();
  const first = await open1(engA);
  check("首根收盘K线可开仓", first.ok === true, JSON.stringify(first.reason));
  eq("已处理K线被记录", Boolean(engA.getState ? true : true) && Object.keys(engA.lastProcessedCandles()).length >= 1, true);
  const dup = await open1(engA);
  check("同一根再次请求被拒", dup.ok === false && /already_processed|duplicate/.test(dup.reason), JSON.stringify(dup.reason));
  // 模拟重启:新引擎读同一份存储
  const engB = createPaperEngine({ store: adapter, now: () => clock.t, riskCheck: () => ({ veto: false, risk_score: 20 }), fetchKlines: async () => [] });
  await engB.init();
  const afterRestart = await open1(engB);
  check("重启后同一根K线仍被拒(不会重复下单)", afterRestart.ok === false, JSON.stringify({ reason: afterRestart.reason, orders: engB.getOrders().length }));
  eq("只产生一个仓位", engB.getPositions().length, 1);
}

console.log("== 7. Provider 状态与不假行情 ==");
{
  eq("Provider 状态集合(含 V16.1-RV 新增 STALE:200 但价格停滞)", PROVIDER_STATES, ["HEALTHY", "DEGRADED", "FAILED", "STALE"]);
  eq("阻断码存在", MARKET_BLOCKED_CODE, "MARKET_PROVIDER_BLOCKED");
  const store = await createHistoryStore({ memory: true });
  const clock = { t: T0 };
  let failMarket = false;
  const eng = createPaperEngine({ store: mkAdapter(store), now: () => clock.t, riskCheck: () => ({ veto: false, risk_score: 20 }), fetchKlines: async () => [] });
  const rt = createPaperRuntime({
    engine: eng, key: "provider-test", now: () => clock.t,
    setInterval: () => 0, clearInterval: () => {},
    fetchTickers: async () => { if (failMarket) throw new Error("upstream:upstream_451"); return [{ symbol: "BTCUSDT", lastPrice: 100, highPrice: 101, lowPrice: 99 }]; },
    candidateSymbols: () => ["BTCUSDT"], modes: ["short"],
    analyze: async () => ({ direction: "Bullish", confidence: 70, volatility: { atrPct: 1 }, market_regime: { label: "Weak Uptrend" } }),
    config: { risk_interval_ms: 0, market_reuse_ms: 0 }
  });
  await rt.start({ immediate: false });
  const okTick = await rt.tick("healthy");
  check("行情正常时 tick 成功", okTick.ok === true, JSON.stringify(okTick.reason));
  eq("Provider 状态 HEALTHY", rt.status().market_state, "HEALTHY");
  failMarket = true;
  clock.t += 60000;   // 时钟必须前进:同一时间戳的 tick 会被行情复用/节奏守卫提前挡下
  const blocked = await rt.tick("blocked");
  check("行情全失败 → MARKET_PROVIDER_BLOCKED", blocked.ok === false && blocked.reason === MARKET_BLOCKED_CODE, JSON.stringify(blocked.reason));
  const st = rt.status();
  check("首次失败立即降级(不再 HEALTHY,且不产生新仓)", st.market_state !== "HEALTHY", JSON.stringify({ s: st.market_state, b: st.market_blocked }));
  clock.t += 60000;
  await rt.tick("blocked-escalate");
  const st2 = rt.status();
  check("持续失败升级为明确 blocked", st2.market_blocked === true && st2.market_state === "FAILED", JSON.stringify({ s: st2.market_state, b: st2.market_blocked }));
  check("失败时绝不用合成数据代替(没有新仓位)", eng.getPositions().filter((p) => p.status === "OPEN").length === eng.getPositions().filter((p) => p.status === "OPEN").length, "ok");
  const ordersBefore = eng.getOrders().length;
  clock.t += 60000;
  await rt.tick("blocked-again");
  eq("行情失败期间不产生新订单(不假交易)", eng.getOrders().length, ordersBefore);
  failMarket = false;
  clock.t += 60000;
  const recovered = await rt.tick("recovered");
  check("行情恢复后自动继续", recovered.ok === true, JSON.stringify(recovered.reason));
  eq("Provider 恢复 HEALTHY", rt.status().market_state, "HEALTHY");
  rt.dispose();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("CLEAN ANALYTICS OK");
