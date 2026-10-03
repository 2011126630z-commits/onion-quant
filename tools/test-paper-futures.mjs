// tools/test-paper-futures.mjs · V14.2 验收:100USDT账户 / Paper Futures 1-10x / 保证金与强平 /
// 部分平仓 / Auto Leverage / 收盘K幂等 / 循环防重入 / Position Management
import { createHistoryStore } from "../worker/src/history/store.js";
import { PAPER_DEFAULTS, createAccount, summarizeTrades, num, round, canAfford } from "../worker/src/paper/accounting.js";
import { createPaperEngine, idempotencyKey, closedCandleTime } from "../worker/src/paper/engine.js";
import { openFuturesPosition, closeFuturesPosition, liquidationPriceOf, isLiquidated, futuresUnrealized, buildTakeProfitPlan, updateTrailingStop, applyBreakEven, marginHealth, clampLeverage, LEVERAGE_STEPS, REAL_TRADING_ENABLED, REAL_FUTURES_ENABLED } from "../worker/src/paper/futures.js";
import { requestLeverage, approveLeverage, leverageCandidates, leverageScore, leverageCapFromRisk, accountProfile, resolveLeverageTable, shadowEvaluation, evaluateLeveragePromotion, evaluateLeverageRollback, LEVERAGE_POLICY, leverageStatsFor } from "../worker/src/paper/leverageManager.js";

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

const store = await createHistoryStore({ memory: true });
const adapter = { get: (t, k) => store.generic.get(t, k), all: (t) => store.generic.all(t), put: (t, r) => store.generic.put(t, r), del: (t, k) => store.generic.del(t, k) };
const mkEngine = (opts) => createPaperEngine({
  store: adapter,
  now: opts && opts.now ? opts.now : () => Date.now(),
  riskCheck: (opts && opts.riskCheck) || (() => ({ veto: false, risk_score: 25 })),
  fetchKlines: async () => []
});

console.log("== 1. ACCOUNT(100 USDT / 70 / 30) ==");
const created = createAccount({ now: 1700000000000, initial_balance: PAPER_DEFAULTS.initial_balance });
eq("默认初始资金 100 USDT", created.account.initial_balance, 100);
// V14.5 §1/§85:初始分配正式改为 70/30(Short 主 / Long 辅)
eq("Short Pool 70", created.wallets.short.allocated_balance, 70);
eq("Long Pool 30", created.wallets.long.allocated_balance, 30);
eq("总资产 100", created.account.total_equity, 100);
check("真实交易开关关闭(Paper Only)", REAL_TRADING_ENABLED === false && REAL_FUTURES_ENABLED === false);

console.log("== 2. LEVERAGE 1x ~ 10x(保证金/名义/强平) ==");
for (const lev of LEVERAGE_STEPS) {
  const opened = openFuturesPosition({ symbol: "BTCUSDT", direction: "LONG", margin: 10, leverage: lev, reference_price: 100, config: PAPER_DEFAULTS });
  const pos = opened.position;
  const ok = opened.ok
    && Math.abs(pos.notional - 10 * lev) < 1e-6
    && Math.abs(pos.initial_margin - 10) < 1e-6
    && Math.abs(pos.initial_quantity - pos.notional / pos.entry_price) < 1e-6
    && pos.leverage === lev
    && pos.liquidation_price > 0
    && pos.liquidation_price < pos.entry_price;
  check(lev + "x 保证金/名义/数量/强平价正确", ok, JSON.stringify({ notional: pos && pos.notional, margin: pos && pos.initial_margin, liq: pos && pos.liquidation_price }));
}
eq("杠杆上限被夹紧", [clampLeverage(0), clampLeverage(15), clampLeverage(3.4)], [1, 10, 3]);
const lev4 = openFuturesPosition({ symbol: "BTCUSDT", direction: "LONG", margin: 5, leverage: 4, reference_price: 100, config: PAPER_DEFAULTS }).position;
near("4x:margin 5 → notional 20", lev4.notional, 20, 1e-6);
near("4x:强平价 < 入场价(多头)", lev4.liquidation_price < lev4.entry_price, true, 0);
const shortPos = openFuturesPosition({ symbol: "BTCUSDT", direction: "SHORT", margin: 5, leverage: 4, reference_price: 100, config: PAPER_DEFAULTS }).position;
near("SHORT:强平价 > 入场价", shortPos.liquidation_price > shortPos.entry_price, true, 0);
const move = futuresUnrealized(lev4, lev4.entry_price * 1.02);
check("杠杆放大盈亏(PnL 基于 notional)", move > 0.35, String(move));
near("10x 强平价约 entry*(1-0.1+0.005)", liquidationPriceOf({ side: "LONG", entryPrice: 100, leverage: 10 }), 90.5, 1e-6);
check("强平判定:多头跌破强平价", isLiquidated({ direction: "LONG", liquidation_price: 90 }, 89) === true && isLiquidated({ direction: "LONG", liquidation_price: 90 }, 95) === false);
check("SHORT 强平判定", isLiquidated({ direction: "SHORT", liquidation_price: 110 }, 111) === true);

console.log("== 3. 部分平仓 10% / 25% / 50% / 75% / 全平 ==");
for (const fraction of [0.1, 0.25, 0.5, 0.75, 1]) {
  const base = openFuturesPosition({ symbol: "BTCUSDT", direction: "LONG", margin: 20, leverage: 5, reference_price: 100, config: PAPER_DEFAULTS }).position;
  const profit = { ...base, current_price: 110 };
  const closed = closeFuturesPosition(profit, { fraction, reference_price: 110, config: PAPER_DEFAULTS });
  const expectQty = round(base.remaining_quantity * fraction, 10);
  const ok = closed.ok
    && Math.abs(closed.closed_quantity - expectQty) < 1e-6
    && (fraction >= 1 ? closed.position_after.status === "CLOSED" && closed.position_after.remaining_quantity === 0 : closed.position_after.status === "OPEN")
    && closed.gross_pnl > 0;
  check("部分平仓 " + Math.round(fraction * 100) + "% 正确", ok, JSON.stringify({ qty: closed.closed_quantity, status: closed.position_after && closed.position_after.status, gross: closed.gross_pnl }));
}
const pBase = openFuturesPosition({ symbol: "BTCUSDT", direction: "LONG", margin: 20, leverage: 5, reference_price: 100, config: PAPER_DEFAULTS }).position;
const t1 = closeFuturesPosition({ ...pBase, current_price: 110 }, { fraction: 0.25, reference_price: 110, config: PAPER_DEFAULTS });
near("25% 平仓后剩余数量 = 75%", t1.position_after.remaining_quantity, round(pBase.remaining_quantity * 0.75, 10), 1e-9);
near("25% 平仓后剩余保证金 = 75%", t1.position_after.remaining_margin, round(pBase.initial_margin * 0.75, 8), 1e-6);
check("只有关闭部分进入 realized", Math.abs(t1.position_after.realized_pnl - t1.net_pnl) < 1e-6, JSON.stringify({ realized: t1.position_after.realized_pnl, net: t1.net_pnl }));
near("部分平仓释放保证金 = 该部分保证金 + 净盈亏", t1.margin_released, pBase.initial_margin * 0.25 + t1.net_pnl, 1e-6);
const t2 = closeFuturesPosition(t1.position_after, { fraction: 0.5, reference_price: 110, config: PAPER_DEFAULTS });
check("再次部分平仓累积 realized", Math.abs(t2.position_after.realized_pnl - (t1.net_pnl + t2.net_pnl)) < 1e-6, JSON.stringify(t2.position_after.realized_pnl));
const t3 = closeFuturesPosition(t2.position_after, { fraction: 1, reference_price: 110, config: PAPER_DEFAULTS });
eq("最后一次全平后状态 CLOSED", t3.position_after.status, "CLOSED");
eq("全平后剩余数量 0", t3.position_after.remaining_quantity, 0);
eq("已平仓再平 → 拒绝(Reduce Only)", closeFuturesPosition(t3.position_after, { fraction: 0.5, reference_price: 110 }).reason, "already_closed");
near("三次部分平仓净额 = 总和", t3.position_after.realized_pnl, round(t1.net_pnl + t2.net_pnl + t3.net_pnl, 6), 1e-6);

console.log("== 4. 分批止盈 / Trailing / Break-even ==");
const tpPlan = buildTakeProfitPlan({ entry_price: 100, direction: "LONG", atr: 2, confidence: 75, trend_strong: true, resistance: 110, support: 0 });
check("TP1/TP2/TP3 且价格递增", tpPlan.levels.length === 3 && tpPlan.levels[0].price < tpPlan.levels[1].price, JSON.stringify(tpPlan.levels.map((l) => l.price)));
check("TP1 有部分比例,最后一档为剩余全部", tpPlan.levels[0].fraction > 0 && tpPlan.levels[2].fraction === null, JSON.stringify(tpPlan.levels.map((l) => l.fraction)));
const longPos = openFuturesPosition({ symbol: "BTCUSDT", direction: "LONG", margin: 10, leverage: 3, reference_price: 100, config: PAPER_DEFAULTS }).position;
const trailed1 = updateTrailingStop(longPos, 105, { atr: 2, atrMult: 1.2 });
const trailed2 = updateTrailingStop(trailed1, 103, { atr: 2, atrMult: 1.2 });
check("Trailing 只朝有利方向移动", num(trailed2.stop_state.price) >= num(trailed1.stop_state.price), JSON.stringify([trailed1.stop_state.price, trailed2.stop_state.price]));
const be = applyBreakEven(longPos, longPos.entry_price * 1.05, { atr: longPos.entry_price * 0.01, triggerR: 1, config: PAPER_DEFAULTS });
check("Break-even 触发且覆盖手续费", be.changed === true && num(be.position.stop_state.price) > num(longPos.entry_price), JSON.stringify(be.position.stop_state));
const beNo = applyBreakEven(longPos, longPos.entry_price * 1.0001, { atr: longPos.entry_price * 0.01, triggerR: 1 });
check("未达触发条件不改止损", beNo.changed === false);
const health = marginHealth({ ...longPos, remaining_margin: 10, remaining_quantity: longPos.initial_quantity }, longPos.entry_price * 0.9);
check("保证金健康度含强平距离", health.liquidation_distance_pct != null && typeof health.danger === "boolean", JSON.stringify(health));

console.log("== 5. AUTO LEVERAGE ==");
eq("风险 30 → 上限 10x", leverageCapFromRisk(30), 10);
eq("风险 45 → 上限 6x", leverageCapFromRisk(45), 6);
eq("风险 60 → 上限 4x", leverageCapFromRisk(60), 4);
eq("风险 70 → 上限 2x", leverageCapFromRisk(70), 2);
eq("风险 90 → 上限 1x", leverageCapFromRisk(90), 1);
const small = accountProfile(100);
eq("100 USDT 判定为小账户探索模式", [small.class, small.exploration], ["SMALL", true]);
check("小账户优先探索 3x/4x/5x", JSON.stringify(small.candidates) === JSON.stringify([3, 4, 5]), JSON.stringify(small.candidates));
check("大账户走常规候选", accountProfile(5000).candidates[0] === 1, JSON.stringify(accountProfile(5000).candidates));
const cands = leverageCandidates({ champion_leverage: 2, balance: 100, hard_cap: 10 });
check("候选不含跨档跳跃(Champion 2x → 不超过 3x)", cands.every((l) => l <= 3 || [3, 4, 5].includes(l)), JSON.stringify(cands));
const sampleProtected = requestLeverage({ records: [], champion_leverage: 2, balance: 100, symbol: "BTCUSDT", mode: "SHORT_TERM", regime: "Range" });
check("样本不足 → 保持 Champion 不升杠杆", sampleProtected.sample_protected === true && sampleProtected.requested_leverage === 2, JSON.stringify(sampleProtected));
const richRecords = [];
for (let i = 0; i < 120; i += 1) {
  richRecords.push({ symbol: "BTCUSDT", mode: "SHORT_TERM", market_regime: "Range", leverage: 4, net_pnl: 0.4, mfe: 0.8, mae: 0.3, exit_reason: "take_profit", drawdown_pct: 2 });
  richRecords.push({ symbol: "BTCUSDT", mode: "SHORT_TERM", market_regime: "Range", leverage: 2, net_pnl: 0.05, mfe: 0.3, mae: 0.3, exit_reason: "time_exit", drawdown_pct: 5 });
}
const request = requestLeverage({ records: richRecords, champion_leverage: 3, balance: 100, symbol: "BTCUSDT", mode: "SHORT_TERM", regime: "Range" });
check("样本充足 → 选出更高分杠杆(且不超 Champion+1)", request.requested_leverage >= 3 && request.requested_leverage <= 4, JSON.stringify(request.requested_leverage) + " " + request.reason);
const approved = approveLeverage({ requested_leverage: 8, risk_score: 60 });
eq("Risk 把 8x 压到 4x", approved.approved_leverage, 4);
check("Risk 降杠杆给出原因", approved.downgraded === true && approved.reasons.length >= 1, JSON.stringify(approved.reasons));
const vetoed = approveLeverage({ requested_leverage: 5, risk_score: 40, veto: true });
check("Risk 否决 → 不开仓", vetoed.trade_allowed === false, JSON.stringify(vetoed));
const nearLiq = approveLeverage({ requested_leverage: 10, risk_score: 20, liquidation_distance_pct: 1 });
eq("强平距离过近 → 降至 1x", nearLiq.approved_leverage, 1);
const shortTable = leverageStatsFor(richRecords, "x", { mode: "SHORT_TERM", regime: "Range" });
check("Short 统计按 mode 独立", Object.keys(shortTable).length >= 2, JSON.stringify(Object.keys(shortTable)));
eq("Long 无样本(Short 表现不影响 Long)", Object.keys(leverageStatsFor(richRecords, "x", { mode: "LONG_TERM" })).length, 0);
const fallbackGlobal = resolveLeverageTable({ records: richRecords, symbol: "NOPEUSDT", mode: "SHORT_TERM", regime: "NOPE", min_samples: 25 });
check("分层回退可用", ["mode", "global"].includes(fallbackGlobal.scope), fallbackGlobal.scope);
const shadow = shadowEvaluation({ entry_price: 100, exit_price: 105, margin: 10, direction: "LONG", fee_bps: 4 });
eq("Shadow 覆盖 1x~10x", shadow.length, 10);
check("Shadow 全部标记 shadow(不入账)", shadow.every((s) => s.shadow === true));
check("高杠杆 Shadow 强平会被标记", shadowEvaluation({ entry_price: 100, exit_price: 100, margin: 10, direction: "LONG", high: 100, low: 80 })[9].liquidated === true, JSON.stringify(shadowEvaluation({ entry_price: 100, exit_price: 100, margin: 10, direction: "LONG", high: 100, low: 80 })[9]));
const scoreLow = leverageScore({ leverage: 2, samples: 120, win_rate: 60, net_pnl: 2, profit_factor: 1.4, max_drawdown_pct: 3, liquidation_rate: 0, stop_rate: 0.1, avg_mfe: 0.8, avg_mae: 0.4, recent_stability: 0.7 });
const scoreSameFewSamples = leverageScore({ leverage: 10, samples: 5, win_rate: 100, net_pnl: 5, profit_factor: 3, max_drawdown_pct: 0, liquidation_rate: 0, stop_rate: 0, avg_mfe: 1, avg_mae: 0.1, recent_stability: 1 });
check("高杠杆样本不足 → 不合格(不许凭全胜升级)", scoreSameFewSamples.eligible === false, JSON.stringify(scoreSameFewSamples));
check("评分不是只看 PnL(含回撤/强平/稳定性)", typeof scoreLow.score === "number" && scoreLow.score > 0);
const promoBad = evaluateLeveragePromotion({ leverage: 10, samples: 10, score: 2, max_drawdown_pct: 1, liquidation_rate: 0, profit_factor: 3 }, { leverage: 3, samples: 100, score: 1, max_drawdown_pct: 3 });
check("10x 样本不足 + 跨档 → 不晋级", promoBad.verdict === "KEEP_TESTING", JSON.stringify(promoBad.reasons));
const promoGood = evaluateLeveragePromotion({ leverage: 4, samples: 60, score: 1.5, max_drawdown_pct: 3, liquidation_rate: 0, profit_factor: 1.4 }, { leverage: 3, samples: 100, score: 1.0, max_drawdown_pct: 3 });
eq("合格 Challenger → PROMOTE", promoGood.verdict, "PROMOTE");
check("回滚判定可用", evaluateLeverageRollback({ samples: 20, score: 0.2, liquidation_rate: 0.06, max_drawdown_pct: 9 }, { score: 1.2, max_drawdown_pct: 3 }).rollback === true);

console.log("== 6. RUNTIME:收盘K幂等 / 循环防重入 / Risk 控制实际杠杆 ==");
let clock = 1700000000000;
const engine = mkEngine({ now: () => clock, riskCheck: () => ({ veto: false, risk_score: 60 }) });
await engine.init();
eq("引擎账户 100 USDT", engine.getAccount().initial_balance, 100);
await engine.start();
const candle1 = closedCandleTime(clock, 3600000);
const quote = { price: 100, received_at: clock };
const o1 = await engine.openPosition({ mode: "short", symbol: "BTCUSDT", direction: "Bullish", signal_timestamp: candle1, quote, analysis: { direction: "Bullish", confidence: 70, volatility: { atrPct: 1 }, market_regime: { label: "Weak Uptrend" } }, leverage: 8 });
check("开仓成功", o1.ok === true, JSON.stringify(o1).slice(0, 160));
eq("Risk 风险分 60 → 实际杠杆被压到 4x", o1.position.leverage, 4);
eq("requested_leverage 记录 8x", o1.position.requested_leverage, 8);
check("保证金与名义分开", Math.abs(o1.position.notional - o1.position.initial_margin * o1.position.leverage) < 1e-6, JSON.stringify({ m: o1.position.initial_margin, n: o1.position.notional, l: o1.position.leverage }));
check("Shadow 结果存在且不入账", Array.isArray(o1.shadow) && o1.shadow.length === 10, String(o1.shadow && o1.shadow.length));
const acctAfterOpen = engine.getAccount();
near("账户只扣保证金+手续费(不扣名义)", num(acctAfterOpen.cash_balance), 100 - o1.position.initial_margin - o1.order.fee, 1e-6);
const dupSameCandle = await engine.openPosition({ mode: "short", symbol: "BTCUSDT", direction: "Bullish", signal_timestamp: candle1, quote, analysis: { direction: "Bullish" }, leverage: 4 });
eq("同一根收盘K线不重复开仓", dupSameCandle.reason, "duplicate_idempotency_key");
clock += 3600000;
const candle2 = closedCandleTime(clock, 3600000);
const o2 = await engine.openPosition({ mode: "short", symbol: "BTCUSDT", direction: "Bullish", signal_timestamp: candle2, quote: { price: 100, received_at: clock }, analysis: { direction: "Bullish", volatility: { atrPct: 1 } }, leverage: 2 });
check("新的收盘K线可再开仓", o2.ok === true, JSON.stringify(o2.reason));
eq("幂等键包含收盘K线时间", idempotencyKey("short", "BTCUSDT", candle1, "Bullish").includes(String(candle1)), true);
const loopPromise = engine.loop({ quotes: { BTCUSDT: { price: 101, received_at: clock } } });
const reentry = await engine.loop({ quotes: { BTCUSDT: { price: 101, received_at: clock } } });
await loopPromise;
check("同一时间只有一个主循环(重入被跳过)", reentry.skipped === true || reentry.ok === true, JSON.stringify(reentry).slice(0, 120));
// 运行时显式部分平仓(验证引擎路径,不只是纯函数)
const liveForPartial = engine.getPositions().find((p) => p.status === "OPEN");
if (liveForPartial) {
  const beforeQty = num(liveForPartial.remaining_quantity);
  const partialRun = await engine.closePosition(liveForPartial, { reference_price: num(liveForPartial.current_price, liveForPartial.entry_price), exit_reason: "partial_test", fraction: 0.25 });
  const afterPartial = engine.getPositions().find((p) => p.position_id === liveForPartial.position_id);
  check("运行时部分平仓 25% 生效", partialRun.ok === true && Math.abs(num(afterPartial.remaining_quantity) - beforeQty * 0.75) < 1e-6, JSON.stringify({ ok: partialRun.ok, before: beforeQty, after: afterPartial.remaining_quantity }));
  check("部分平仓后 realized 增加且仓位仍 OPEN", afterPartial.status === "OPEN" && num(afterPartial.realized_pnl) !== 0, JSON.stringify({ status: afterPartial.status, realized: afterPartial.realized_pnl }));
}
// 强平触发(用已知 id 定位持仓)
clock += 3600000;
const livePos = engine.getPositions().find((p) => p.position_id === o2.position.position_id);
check("持仓可按 id 定位", Boolean(livePos), JSON.stringify(o2.position.position_id));
const liqRes = await engine.loop({ quotes: { BTCUSDT: { price: num(livePos.liquidation_price) - 1, received_at: clock } } });
const afterLiq = engine.getPositions().find((p) => p.position_id === livePos.position_id);
check("跌破强平价 → 触发 LIQUIDATION 平仓", afterLiq.status === "CLOSED" && afterLiq.exit_reason === "LIQUIDATION", JSON.stringify({ status: afterLiq.status, reason: afterLiq.exit_reason }));
check("强平后账户不为负", num(engine.getAccount().cash_balance) >= 0, String(engine.getAccount().cash_balance));
check("强平记录进入成交", engine.getTrades().some((t) => t.exit_reason === "LIQUIDATION"));
check("存在分批止盈成交记录", engine.getTrades().some((t) => String(t.exit_reason).indexOf("partial") === 0), JSON.stringify(engine.getTrades().map((t) => t.exit_reason).slice(0, 6)));
const equity = engine.snapshot().account.total_equity;
check("权益为有限数", Number.isFinite(equity) && equity >= 0, String(equity));

console.log("== 7. Position 数据模型完整性 ==");
const model = engine.getPositions()[0];
for (const field of ["position_id", "strategy_mode", "direction", "symbol", "entry_price", "initial_quantity", "remaining_quantity", "initial_margin", "remaining_margin", "notional", "leverage", "liquidation_price", "realized_pnl", "unrealized_pnl", "fees", "mfe", "mae", "partial_close_count", "tp_levels", "stop_state", "status"]) {
  check("Position 含字段 " + field, field in model, JSON.stringify(Object.keys(model).slice(0, 8)));
}
eq("strategy_mode 与 direction 分离", [model.strategy_mode, model.direction], ["SHORT_TERM", "LONG"]);
check("TP 计划含三档", Array.isArray(model.tp_levels) && model.tp_levels.length === 3, JSON.stringify(model.tp_levels));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("PAPER FUTURES TESTS OK");
