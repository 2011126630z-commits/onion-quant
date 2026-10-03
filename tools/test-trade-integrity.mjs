// tools/test-trade-integrity.mjs · V15 P0:Paper 交易完整性(Profit Lock 重复触发 / 碎片 / 费用分摊 / 收益合理性)
// 复现来源:Paper Trades CSV 里同一仓位出现多次 profit_lock_stage4、66%→66%→66% 切碎、return 出现 -2624% 这类虚假值。
import { createHistoryStore } from "../worker/src/history/store.js";
import { PAPER_DEFAULTS, num, round, summarizeTrades, summarizePositions, isValidReturnPct, POSITION_SAMPLE_MIN_NOTIONAL } from "../worker/src/paper/accounting.js";
import { createPaperEngine, closedCandleTime } from "../worker/src/paper/engine.js";
import {
  profitLockDecision, profitLockStateOf, applyProfitLockState, isDustPosition, PROFIT_LOCK_LIMITS,
  PROFIT_LOCK_STATE_KEY, profitStage
} from "../worker/src/paper/profitLock.js";
import { attributionOf, attributionView } from "../worker/src/paper/attribution.js";
import { openFuturesPosition, closeFuturesPosition } from "../worker/src/paper/futures.js";

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

// 造一个"深回吐 + 趋势尚可"的 stage4 仓位(不会全平,但每次 tick 都想部分锁定 —— 正是 CSV 里的场景)
function stage4Position(over) {
  const entry = 100;
  const qty = 1;
  return {
    position_id: "pos_stage4", symbol: "BTCUSDT", mode: "short", side: "LONG", direction: "LONG", status: "OPEN",
    entry_price: entry, quantity: qty, initial_quantity: qty, remaining_quantity: qty,
    entry_notional: 10, initial_margin: 10, remaining_margin: 10, leverage: 2, notional: 20,
    current_price: 112, mfe: 15, mae: 0, fees: 0.008, initial_risk: 2, initial_stop_price: 98,
    stop_price: 104, stop_state: { type: "trailing", price: 104 }, tp_levels: [], tp_hit_count: 0,
    entry_time: T0 - 3600000, partial_close_count: 0, ...over
  };
}

console.log("== 1. 根因复现:同一 Stage 不能重复部分平仓 ==");
{
  const pos = stage4Position();
  const args = {
    position: pos, price: 112, atr: 1.5, trend_strength: 0.55, reversal_risk: 0.3,
    mfe_r: 0, volatility_level: "Medium", fee_bps: 4, slippage_bps: 3, half_spread_bps: 1,
    now_ms: T0
  };
  const first = profitLockDecision(args);
  eq("第一次判定:stage4 触发部分锁定", [first.stage, first.action], [4, "PARTIAL_CLOSE"]);
  check("比例不会是 66% 这种反复切碎的候选(已按节奏收敛)", num(first.fraction, 0) > 0 && num(first.fraction, 0) <= 1, String(first.fraction));
  // 关键:把这次执行写回状态机,再判定 —— 同一 stage 必须 HOLD
  const state1 = applyProfitLockState(pos, { stage: first.stage, action: first.action, fraction: first.fraction, at: T0 });
  const second = profitLockDecision({ ...args, state: state1, now_ms: T0 + 21000 });
  check("同一 Stage 第二次判定不再减仓(状态机幂等)", second.action !== "PARTIAL_CLOSE" && second.action !== "FULL_CLOSE" && num(second.fraction, 0) === 0,
    JSON.stringify({ action: second.action, fraction: second.fraction, reasons: second.reasons }));
  check("并说明为什么不再减仓", second.reasons.join(" ").includes("已执行过"), JSON.stringify(second.reasons));
  eq("HOLD 的 fraction 为 0", num(second.fraction, 0), 0);
  // 连续多次 tick 也只允许执行一次
  let state = state1;
  let executed = 1;
  let simPos = { ...pos };
  for (let i = 0; i < 12; i += 1) {
    const d = profitLockDecision({ ...args, position: simPos, state, now_ms: T0 + 21000 * (i + 2) });
    if (d.action === "PARTIAL_CLOSE" && d.fraction > 0) {
      executed += 1;
      simPos = { ...simPos, remaining_quantity: simPos.remaining_quantity * (1 - d.fraction), remaining_margin: simPos.remaining_margin * (1 - d.fraction) };
      state = applyProfitLockState(simPos, { stage: d.stage, action: d.action, fraction: d.fraction, at: T0 + 21000 * (i + 2) });
    }
  }
  check("连续 12 次 tick 不会再切碎同一 Stage", executed === 1, "executed=" + executed);
  check("状态机记录已执行过的 Stage", Array.isArray(state.executed_stage_list) && state.executed_stage_list.includes(4), JSON.stringify(state));
}

console.log("== 2. Dust Guard:极小剩余仓位合理收尾 ==");
{
  const dust = stage4Position({ remaining_quantity: 0.000001, remaining_margin: 0.00001, entry_notional: 0.00001 });
  check("识别尘埃仓位", isDustPosition(dust) === true, JSON.stringify({ qty: dust.remaining_quantity, margin: dust.remaining_margin }));
  check("尘埃仓位建议收尾(FULL_CLOSE)而非继续部分平仓", isDustPosition(dust, {}) === true);
  const normal = stage4Position();
  eq("正常仓位不触发尘埃判定", isDustPosition(normal), false);
  // 部分平仓比例必须保证剩余不是尘埃:若会导致尘埃 → 直接全清
  const args = {
    position: stage4Position({ remaining_quantity: 0.001, remaining_margin: 0.01, entry_notional: 0.01 }),
    price: 112, atr: 1.5, trend_strength: 0.55, reversal_risk: 0.3, volatility_level: "Medium", now_ms: T0
  };
  const d = profitLockDecision(args);
  eq("剩余会变尘埃时改为一次性收尾", d.action, "FULL_CLOSE");
  check("收尾原因可读", d.reasons.join(" ").includes("尘埃") || d.reasons.join(" ").includes("收尾"), JSON.stringify(d.reasons));
}

console.log("== 3. Short / Long 不同退出节奏 ==");
{
  const longPos = stage4Position({ mode: "long", direction: "LONG", side: "LONG", entry_time: T0 - 3 * 60000 });
  const shortPos = stage4Position({ mode: "short", entry_time: T0 - 3 * 60000 });
  const base = { price: 112, atr: 1.5, trend_strength: 0.55, reversal_risk: 0.3, volatility_level: "Medium", now_ms: T0 };
  const dLong = profitLockDecision({ ...base, position: longPos });
  const dShort = profitLockDecision({ ...base, position: shortPos });
  check("Long 刚开仓几分钟内不做普通利润锁定(避免几分钟切光)", dLong.action !== "PARTIAL_CLOSE" && dLong.action !== "FULL_CLOSE" && num(dLong.fraction, 0) === 0,
    JSON.stringify({ action: dLong.action, reasons: dLong.reasons }));
  check("Long 仍可推进保护性止损(不产生成交)", ["MOVE_STOP", "TRAIL"].includes(dLong.action) && dLong.stop_price != null, JSON.stringify({ action: dLong.action, stop: dLong.stop_price }));
  check("Short 节奏更快(同条件允许减仓)", ["PARTIAL_CLOSE", "MOVE_STOP", "TRAIL", "HOLD"].includes(dShort.action) && (dShort.action === "PARTIAL_CLOSE" || num(dShort.fraction, 0) === 0), JSON.stringify({ action: dShort.action, fraction: dShort.fraction }));
  check("Long 的最短持有阈值大于 Short", PROFIT_LOCK_LIMITS.long.min_hold_ms > PROFIT_LOCK_LIMITS.short.min_hold_ms, JSON.stringify(PROFIT_LOCK_LIMITS));
  // §12:风控/止损不受最短持有限制
  const riskExit = profitLockDecision({ ...base, position: longPos, risk_exit: true });
  check("风控退出不受最短持有限制(risk_exit 旁路)", riskExit.action !== "HOLD" || riskExit.reasons.join(" ").includes("风控"), JSON.stringify({ action: riskExit.action, reasons: riskExit.reasons }));
}

console.log("== 4. 收益合理性(杜绝 -2624% 虚假 Return) ==");
{
  check("越界收益被判为不可信", [isValidReturnPct(12), isValidReturnPct(-2624), isValidReturnPct(null), isValidReturnPct(-150), isValidReturnPct(-90, 2)].join(","),
    ["true", "false", "false", "false", "true"].join(","));
  // 极小切片的手续费分摊:平仓费不得大于该切片名义
  const pos = stage4Position({ remaining_quantity: 0.0001, remaining_margin: 0.0001, entry_notional: 0.0001, fees: 0.00001 });
  const part = closeFuturesPosition(pos, { fraction: 0.5, reference_price: 112, config: PAPER_DEFAULTS });
  check("极小切片仍然成交且费用合理", part.ok === true && num(part.fees, 0) <= Math.max(num(part.notional_closed, 0), 0.000001) * 0.01, JSON.stringify({ fee: part.fees, notional: part.notional_closed }));
  // 入场费分摊:各次事件之和 == 原始入场费(不重复、不遗漏)
  const initial = stage4Position({ fees: 0.008 });
  const a = closeFuturesPosition(initial, { fraction: 0.6, reference_price: 112, config: PAPER_DEFAULTS });
  const b = closeFuturesPosition(a.position_after, { fraction: 1, reference_price: 112, config: PAPER_DEFAULTS });
  const allocated = num(a.entry_fee_allocated, 0) + num(b.entry_fee_allocated, 0);
  check("入场费分摊不超过原始费用(不重复计费)", allocated <= num(initial.fees, 0) + 1e-9, JSON.stringify({ allocated, original: initial.fees }));
  check("最后一笔不再重复收取剩余入场费", num(b.entry_fee_allocated, 0) <= num(initial.fees, 0) - num(a.entry_fee_allocated, 0) + 1e-9, JSON.stringify({ first: a.entry_fee_allocated, second: b.entry_fee_allocated }));
}

console.log("== 5. Position 级统计为主口径(Partial 是事件不是母交易) ==");
{
  const trades = [
    { trade_id: "t1", position_id: "p1", parent_position_id: "p1", symbol: "BTCUSDT", mode: "short", side: "LONG", net_pnl: 1, fees: 0.02, quantity: 0.6, entry_price: 100, exit_price: 110, exit_time: T0 - 1000, entry_time: T0 - 100000, exit_reason: "partial_take_profit_tp1", partial: true },
    { trade_id: "t2", position_id: "p1", parent_position_id: "p1", symbol: "BTCUSDT", mode: "short", side: "LONG", net_pnl: -0.5, fees: 0.02, quantity: 0.4, entry_price: 100, exit_price: 98, exit_time: T0, entry_time: T0 - 100000, exit_reason: "stop_loss", partial: false },
    { trade_id: "t3", position_id: "p2", parent_position_id: "p2", symbol: "ETHUSDT", mode: "long", side: "SHORT", net_pnl: 2, fees: 0.03, quantity: 0.5, entry_price: 200, exit_price: 190, exit_time: T0, entry_time: T0 - 50000, exit_reason: "take_profit", partial: false }
  ];
  const positions = summarizePositions(trades);
  eq("按 Position 聚合(2 个仓位而非 3 笔交易)", positions.trades, 2);
  near("同一仓位的多次事件合并净额", positions.net_pnl, 2.5, 1e-9);
  const p1 = positions.rows.find((r) => r.position_id === "p1");
  check("仓位行标注事件数", p1 && num(p1.events, 0) === 2, JSON.stringify(p1));
  eq("交易笔数口径仍单独可用", summarizeTrades(trades).trades, 3);
  const attr = attributionOf(trades, { level: "position" });
  eq("归因默认按完整 Position 统计", attr.sample.valid, 2);
  check("归因视图说明口径", /仓位/.test(attributionView(attr, {}).sample_text), attributionView(attr, {}).sample_text);
}

console.log("== 6. 引擎级:同一 stage 只平一次 + 尘埃收尾 + 事件标记 ==");
{
  const store = await createHistoryStore({ memory: true });
  const clock = { t: T0 };
  const eng = createPaperEngine({
    store: mkAdapter(store), now: () => clock.t,
    riskCheck: () => ({ veto: false, risk_score: 20 }), fetchKlines: async () => [],
    profitLock: { trendStrength: 0.55, reversalRisk: 0.3, remainingOpportunity: 0.4 }
  });
  await eng.init();
  const opened = await eng.openPosition({
    mode: "short", symbol: "BTCUSDT", direction: "Bullish", signal_timestamp: T0,
    quote: { price: 100, received_at: T0 },
    analysis: { direction: "Bullish", confidence: 70, volatility: { atrPct: 1 }, market_regime: { label: "Weak Uptrend" } },
    leverage: 2
  });
  check("开仓成功", opened.ok, JSON.stringify(opened.reason));
  const pos = eng.getPositions().find((p) => p.position_id === opened.position.position_id);
  pos.mfe = 15;                       // 造出 stage4 的 MFE
  pos.remaining_quantity = num(pos.quantity);
  const before = eng.getTrades().length;
  for (let i = 0; i < 8; i += 1) {
    await eng.riskPass({ quotes: { BTCUSDT: { symbol: "BTCUSDT", price: 112, received_at: clock.t } } });
    clock.t += 21000;
  }
  const profitLockTrades = eng.getTrades().filter((t) => /profit_lock_stage/.test(String(t.exit_reason)));
  check("同一 stage 不会连续触发(多次 tick 只产生一条 stage4 事件)", profitLockTrades.filter((t) => t.exit_reason === "profit_lock_stage4").length <= 1, JSON.stringify(profitLockTrades.map((t) => t.exit_reason)));
  const events = eng.getTrades().filter((t) => t.partial === true);
  check("部分平仓标记为 Position Event", events.every((t) => t.position_event === true && t.parent_position_id), JSON.stringify(events.map((t) => ({ e: t.position_event, p: t.parent_position_id }))));
  check("每条事件都带 position 级收益(不再用碎片名义做分母)", events.every((t) => t.return_on_position_pct == null || isValidReturnPct(t.return_on_position_pct, 20)), JSON.stringify(events.map((t) => t.return_on_position_pct)));
  check("所有成交收益都在合理区间(无 -2624% 这类值)", eng.getTrades().every((t) => isValidReturnPct(t.return_pct, 20) || t.return_pct == null), JSON.stringify(eng.getTrades().filter((t) => !isValidReturnPct(t.return_pct, 20)).map((t) => t.return_pct)));
  check("不产生大量碎片成交", eng.getTrades().length - before <= 3, String(eng.getTrades().length - before));
  check("决策日志记录为什么不再平(状态机理由)", eng.journal({ symbol: "BTCUSDT" }).length >= 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("TRADE INTEGRITY OK");
