// tools/test-profit-lock.mjs · V14.4 Profit Lock + Drawdown + Allocation 测试
// A 风险单位与回吐  B 阶段判定  C 动态部分平仓  D 动态 Trailing  E 含费保护/止损单调
// F 决策动作(JLD)  G Shadow 研究不入账  H 退出策略学习/晋级闸门
// I 回撤状态机  J 渐进恢复  K 里程碑与风险预算  L 动态分配  M 引擎集成
import fs from "node:fs";
import path from "node:path";
import {
  PROFIT_LOCK_VERSION, PROFIT_STAGE_THRESHOLDS, PARTIAL_FRACTIONS, GIVEBACK_WARN_PCT, GIVEBACK_CRITICAL_PCT,
  riskUnitOf, rMultipleOf, givebackOf, profitStage, dynamicPartialFraction, dynamicTrailingDistance,
  protectedProfitStop, profitLockDecision, shadowExitResearch, exitLearningSample, exitPolicyKey,
  summarizeExitPolicies, evaluateExitPolicyPromotion, profitLockView
} from "../worker/src/paper/profitLock.js";
import {
  DRAWDOWN_STATES, DRAWDOWN_THRESHOLDS, DRAWDOWN_ACTIONS, RECOVERY_REQUIREMENTS, EQUITY_MILESTONES,
  riskBudgetFor, equityMilestoneOf, drawdownOf, drawdownMetrics, classifyDrawdown, createDrawdownController,
  recoveryLadder, drawdownView
} from "../worker/src/paper/drawdown.js";
import {
  ALLOCATION_BOUNDS, ALLOCATION_PROFILES, riskAdjustedScore, dynamicAllocation, allocationPlan, allocationRiskFactor, allocationView,
  rebalanceWallets, planMigration, stepToward, applyAllocation
} from "../worker/src/paper/allocation.js";
import { createPaperEngine } from "../worker/src/paper/engine.js";
import { createHistoryStore } from "../worker/src/history/store.js";
import { PAPER_DEFAULTS, summarizeTrades } from "../worker/src/paper/accounting.js";

const ROOT = path.resolve(import.meta.dirname, "..");
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
  check(name, Math.abs(actual - expected) <= (tol == null ? 1e-9 : tol), `got ${actual} want ~${expected}`);
}
// V14.5 辅助:断言"真正落账"的数值比较
const QE_gt = (a, b) => Number(a) > Number(b);
const QE_lt = (a, b) => Number(a) < Number(b);

const T0 = 1700000000000;
// 一个多头仓位:entry 100,止损 98(R = 2),数量 1,名义 100
function longPos(overrides) {
  return {
    position_id: "pos_1", symbol: "BTCUSDT", mode: "short", side: "LONG", status: "OPEN",
    entry_price: 100, quantity: 1, remaining_quantity: 1, notional: 100, leverage: 2,
    entry_notional: 50, entry_time: T0, current_price: 100, mfe: 0, mae: 0,
    initial_risk: 2, initial_stop_price: 98,
    stop_price: 98, stop_state: { type: "fixed", price: 98 },
    fees: 0, partial_close_count: 0, funding_simulated: 0, tp_hit_count: 0, tp_levels: [],
    ...(overrides || {})
  };
}

console.log("== A. 风险单位 / R 倍数 / 回吐(§29/§30) ==");
{
  const r = riskUnitOf(longPos());
  near("R 取自冻结的 initial_risk", r.r, 2, 1e-9);
  eq("来源标注为冻结值", r.basis, "initial_risk_frozen");
  eq("无 initial_risk 时回退到 initial_stop_price", riskUnitOf({ entry_price: 100, initial_stop_price: 99 }).basis, "initial_stop_distance");
  // 关键回归:止损上移后 R 不能跟着变小(否则 R 倍数虚高、阶段误判)
  {
    const moved = { ...longPos(), stop_price: 104, stop_state: { type: "trailing", price: 104 } };
    near("止损上移到 104 后 R 仍为 2", riskUnitOf(moved).r, 2, 1e-9);
    const m = rMultipleOf({ ...moved, current_price: 110, mfe: 10 }, 110);
    near("R 倍数不被压缩(10/2 = 5R,而不是 10/0.01)", m.mfe_r, 5, 1e-9);
    eq("阶段判定因此保持合理", profitStage({ mfe_r: m.mfe_r, giveback_pct: 0 }), 4);
  }
  eq("无止损时用 ATR", riskUnitOf({ entry_price: 100 }, { atr: 3 }).basis, "atr");
  eq("无止损无 ATR 时按 1% 兜底", riskUnitOf({ entry_price: 100 }).basis, "entry_pct_default");
  const m = rMultipleOf(longPos({ current_price: 104, mfe: 6 }), 104);
  near("当前 R = 2", m.current_r, 2, 1e-9);
  near("MFE R = 3", m.mfe_r, 3, 1e-9);
  const gb = givebackOf(longPos({ mfe: 10, current_price: 106 }), 106);
  near("峰值 = MFE", gb.peak_pnl, 10, 1e-9);
  near("当前 = 6", gb.current_pnl, 6, 1e-9);
  near("回吐绝对值 = 4", gb.profit_giveback_abs, 4, 1e-9);
  near("回吐比例 = 40%", gb.profit_giveback_pct, 40, 1e-9);
  eq("40% 视为 critical", gb.severity, "critical");
  eq("25%~40% 视为 warning", givebackOf(longPos({ mfe: 10, current_price: 107 }), 107).severity, "warning");
  eq("无回吐时 ok", givebackOf(longPos({ mfe: 5, current_price: 105 }), 105).severity, "ok");
  eq("亏损时回吐为 0(不出现负回吐)", givebackOf(longPos({ mfe: 0, current_price: 97 }), 97).profit_giveback_abs, 0);
  // 空头方向
  const short = { ...longPos(), side: "SHORT", stop_price: 102 };
  near("空头 R 同样由止损距离决定", riskUnitOf(short).r, 2, 1e-9);
  near("空头下跌为盈利", rMultipleOf(short, 96).current_r, 2, 1e-9);
}

console.log("== B. 阶段判定(§33-§38) ==");
{
  eq("无利润 → STAGE 0", profitStage({ mfe_r: 0.2 }), 0);
  eq("初步盈利 → STAGE 1", profitStage({ mfe_r: PROFIT_STAGE_THRESHOLDS.stage1 + 0.1 }), 1);
  eq("利润扩大 → STAGE 2", profitStage({ mfe_r: PROFIT_STAGE_THRESHOLDS.stage2 + 0.1 }), 2);
  eq("利润较大 → STAGE 3", profitStage({ mfe_r: PROFIT_STAGE_THRESHOLDS.stage3 + 0.1 }), 3);
  eq("利润很大 → STAGE 4", profitStage({ mfe_r: PROFIT_STAGE_THRESHOLDS.stage4 + 0.1 }), 4);
  eq("回吐 critical 直接进 STAGE 4", profitStage({ mfe_r: 2, giveback_pct: GIVEBACK_CRITICAL_PCT + 1 }), 4);
  eq("STAGE 2 且回吐过半 + 反转风险 → 升到 STAGE 3", profitStage({ mfe_r: 1.2, giveback_pct: 30, reversal_risk: 0.6 }), 3);
  eq("阶段单调:利润越高阶段越高", [profitStage({ mfe_r: 0.3 }), profitStage({ mfe_r: 1 }), profitStage({ mfe_r: 2.5 }), profitStage({ mfe_r: 4 })].join("<"), "0<2<3<4");
}

console.log("== C. 动态部分平仓:不是固定 25%(§32) ==");
{
  eq("STAGE 0 不减仓(避免手续费吃掉利润 §34)", dynamicPartialFraction({ stage: 0, mfe_r: 0.2 }).fraction, 0);
  eq("STAGE 1 不减仓(只提保护 §35)", dynamicPartialFraction({ stage: 1, mfe_r: 0.7 }).fraction, 0);
  const s2 = dynamicPartialFraction({ stage: 2, reversal_risk: 0.2, trend_strength: 0.6, remaining_opportunity: 0.5 });
  check("STAGE 2 开始锁定(10%~33%)", s2.fraction >= 0.10 && s2.fraction <= 0.33, JSON.stringify(s2));
  const s3 = dynamicPartialFraction({ stage: 3, reversal_risk: 0.3, trend_strength: 0.6 });
  check("STAGE 3 锁定更多", s3.fraction > s2.fraction, JSON.stringify([s3.fraction, s2.fraction]));
  const s4 = dynamicPartialFraction({ stage: 4, reversal_risk: 0.8, trend_strength: 0.2 });
  check("STAGE 4 高反转 → 大幅减仓", s4.fraction >= 0.66, JSON.stringify(s4));
  check("所有比例取自候选集", [s2, s3, s4].every((x) => PARTIAL_FRACTIONS.includes(x.fraction)), JSON.stringify([s2.fraction, s3.fraction, s4.fraction]));
  // 证据驱动:趋势强/预测偏多 → 少减;反转风险高 → 多减
  const trendKeep = dynamicPartialFraction({ stage: 3, reversal_risk: 0.1, trend_strength: 0.9, remaining_opportunity: 0.9, prediction_bullish: 0.7 });
  const reversalCut = dynamicPartialFraction({ stage: 3, reversal_risk: 0.9, trend_strength: 0.2, remaining_opportunity: 0.1, prediction_bullish: 0.35 });
  check("趋势强 + 预测偏多 → 减仓更少", trendKeep.fraction <= reversalCut.fraction, JSON.stringify([trendKeep.fraction, reversalCut.fraction]));
  check("理由可解释", trendKeep.reasons.length > 0 && reversalCut.reasons.length > 0, JSON.stringify([trendKeep.reasons, reversalCut.reasons]));
  check("候选集覆盖 spec 列出的档位", [0.10, 0.20, 0.25, 0.33, 0.50, 0.66, 0.75, 1.0].every((f) => PARTIAL_FRACTIONS.includes(f)), JSON.stringify(PARTIAL_FRACTIONS));
}

console.log("== D. 动态 Trailing(§39) ==");
{
  const base = dynamicTrailingDistance({ atr: 2, price: 100, profit_r: 1, trend_strength: 0.5 });
  const strongTrend = dynamicTrailingDistance({ atr: 2, price: 100, profit_r: 1, trend_strength: 0.9 });
  const weakTrend = dynamicTrailingDistance({ atr: 2, price: 100, profit_r: 1, trend_strength: 0.2 });
  check("趋势强 → 给更大空间", strongTrend.distance > base.distance, JSON.stringify([strongTrend.distance, base.distance]));
  check("趋势弱 → 收得更快", weakTrend.distance < base.distance, JSON.stringify([weakTrend.distance, base.distance]));
  const highVol = dynamicTrailingDistance({ atr: 2, price: 100, profit_r: 1, trend_strength: 0.5, volatility_level: "High" });
  check("高波动 → 距离更宽(避免被扫)", highVol.distance > base.distance, JSON.stringify([highVol.distance, base.distance]));
  const bigProfit = dynamicTrailingDistance({ atr: 2, price: 100, profit_r: 4, trend_strength: 0.5 });
  check("盈利很大 → 收得更紧(保护优先)", bigProfit.distance < base.distance, JSON.stringify([bigProfit.distance, base.distance]));
  check("距离不会为 0(有下限)", dynamicTrailingDistance({ atr: 2, price: 100, profit_r: 5, trend_strength: 0.1 }).distance > 0);
  check("无参考价时安全返回", dynamicTrailingDistance({}).distance === 0);
  eq("注释说明依据", /趋势\/波动\/盈利/.test(base.reason), true);
}

console.log("== E. 含费保护位与止损单调(§40/§41) ==");
{
  const p = protectedProfitStop({ entry_price: 100, price: 110, side: "LONG", atr: 2 });
  const costRate = (PAPER_DEFAULTS.fee_bps * 2 + PAPER_DEFAULTS.slippage_bps * 2 + PAPER_DEFAULTS.half_spread_bps) / 10000;
  near("含费 breakeven = entry × (1 + 成本率)", p.break_even_price, 100 * (1 + costRate), 1e-6);
  check("保护位覆盖成本", p.covers_cost === true, JSON.stringify(p));
  check("保护位低于当前价(留出缓冲)", p.stop_price < 110, String(p.stop_price));
  check("与当前价保持最低距离", 110 - p.stop_price >= p.floor_distance - 1e-9, JSON.stringify([110 - p.stop_price, p.floor_distance]));
  const tight = protectedProfitStop({ entry_price: 100, price: 100.05, side: "LONG", atr: 2, protect_pct: 0.5 });
  check("利润很小时不会把止损收到价上(避免被扫)", 100.05 - tight.stop_price >= tight.floor_distance - 1e-9, JSON.stringify(tight));
  const shortP = protectedProfitStop({ entry_price: 100, price: 90, side: "SHORT", atr: 2 });
  check("空头方向保护位在上方", shortP.stop_price > 90 && shortP.covers_cost === true, JSON.stringify(shortP));
}

console.log("== F. 决策动作(§31/§42/§43) ==");
{
  const hold = profitLockDecision({ position: longPos({ current_price: 100.5, mfe: 0.5 }), price: 100.5, atr: 2, trend_strength: 0.5 });
  eq("STAGE 0 → HOLD", hold.action, "HOLD");
  const protect = profitLockDecision({ position: longPos({ current_price: 103, mfe: 3 }), price: 103, atr: 2, trend_strength: 0.6 });
  check("有利润后至少推进止损或部分锁定", ["MOVE_STOP", "TRAIL", "PARTIAL_CLOSE"].includes(protect.action), JSON.stringify(protect).slice(0, 160));
  check("决策带阶段与回吐信息", protect.stage != null && protect.giveback != null, JSON.stringify(Object.keys(protect)));
  // STAGE 4 + 高反转 + 趋势弱 → 全平
  const full = profitLockDecision({ position: longPos({ current_price: 108, mfe: 12 }), price: 108, atr: 2, trend_strength: 0.2, reversal_risk: 0.8 });
  eq("STAGE 4 高反转 + 弱趋势 → FULL_CLOSE", full.action, "FULL_CLOSE");
  check("全平理由可追溯", full.reasons.some((r) => /STAGE 4/.test(r)), JSON.stringify(full.reasons));
  // 预测变弱 → 增加部分退出概率(§42),但不能单独全平(§43)
  const predWeak = profitLockDecision({ position: longPos({ current_price: 105, mfe: 6 }), price: 105, atr: 2, trend_strength: 0.6, prediction_bullish: 0.3 });
  check("预测转弱会倾向于锁定(不减到 0)", predWeak.action !== "HOLD" && predWeak.fraction < 1, JSON.stringify({ a: predWeak.action, f: predWeak.fraction }));
  check("预测单独不足以全平(§43)", predWeak.action !== "FULL_CLOSE", predWeak.action);
  // 止损单调:已有更高止损时不会被下调
  const posHighStop = longPos({ current_price: 106, mfe: 8, stop_price: 105, stop_state: { type: "trailing", price: 105 } });
  const keep = profitLockDecision({ position: posHighStop, price: 106, atr: 2, trend_strength: 0.5 });
  check("止损不下调(单调)", keep.stop_price == null || keep.stop_price >= 105, JSON.stringify(keep.stop_price));
  // 方向正确性:多头保护位在下方,空头在上方
  const longDecision = profitLockDecision({ position: longPos({ current_price: 104, mfe: 4 }), price: 104, atr: 2, trend_strength: 0.6 });
  check("多头保护位在当前价下方", longDecision.stop_price == null || longDecision.stop_price < 104, String(longDecision.stop_price));
  const shortDecision = profitLockDecision({ position: { ...longPos({ current_price: 96, mfe: 4 }), side: "SHORT", stop_price: 102 }, price: 96, atr: 2, trend_strength: 0.6 });
  check("空头保护位在当前价上方", shortDecision.stop_price == null || shortDecision.stop_price > 96, String(shortDecision.stop_price));
  // UI 视图
  const view = profitLockView({ stage: 3, giveback: protect.giveback, partial_fraction: 0.25, trailing_distance: 1.8 });
  check("UI 显示阶段/最高浮盈/当前/回吐/下一步(§74)", ["stage_label", "max_unrealized_text", "current_text", "giveback_text", "next_action"].every((k) => view[k]), JSON.stringify(view));
}

console.log("== G. Shadow Exit Research 不入账(§45) ==");
{
  const shadow = shadowExitResearch({ entry_price: 100, price: 104, side: "LONG", quantity: 1, notional: 100, mfe_price: 110, trailing_distance: 2, now: T0 });
  eq("明确声明不入账", shadow.counted_into_account, false);
  check("场景含 hold/25/50/75/full/trailing/best_case", ["hold", "partial_25", "partial_50", "partial_75", "full_exit", "trailing", "best_case_at_mfe"].every((id) => shadow.scenarios.some((s) => s.id === id)), JSON.stringify(shadow.scenarios.map((s) => s.id)));
  check("每个场景标注 accounts=false", shadow.scenarios.every((s) => s.accounts === false));
  const hold = shadow.scenarios.find((s) => s.id === "hold");
  near("hold 净收益 = 毛利 - 成本", hold.net_pnl, 4 - 100 * (PAPER_DEFAULTS.fee_bps * 2 + PAPER_DEFAULTS.slippage_bps * 2) / 10000, 1e-6);
  const best = shadow.scenarios.find((s) => s.id === "best_case_at_mfe");
  check("MFE 场景收益最高(用于研究见好就收的空间)", best.net_pnl > hold.net_pnl, JSON.stringify([best.net_pnl, hold.net_pnl]));
  check("文案说明永不重复计入账户", /永不重复计入账户 PnL/.test(shadow.note), shadow.note);
  eq("shadow 结果里也带不计入标记", shadow.scenarios.find((s) => s.id === "full_exit").accounts, false);
  // 学习样本
  const sample = exitLearningSample({ symbol: "BTCUSDT", mode: "short", regime: "Range", volatility: "Normal", leverage: 2, stage: 1, giveback: givebackOf(longPos({ mfe: 3, current_price: 100 }), 100), realised_pnl: 0.2, profit_locked: 0.2, partial_close_sequence: [0.25], trailing_distance: 1.5, now: T0 });
  check("学习样本字段齐全(§77)", ["max_unrealized_pnl", "profit_locked", "profit_giveback", "partial_close_sequence", "trailing_distance", "exit_policy"].every((k) => sample[k] != null), JSON.stringify(sample).slice(0, 160));
  eq("策略键包含 币种/模式/环境/波动/杠杆/阶段", exitPolicyKey({ symbol: "BTCUSDT", mode: "short", regime: "Range", volatility: "Normal", leverage: 2, stage: 1 }), "BTCUSDT|short|Range|Normal|lev2|stage1");
}

console.log("== H. 退出策略汇总与晋级闸门(§46/§47) ==");
{
  const samples = [];
  for (let i = 0; i < 12; i += 1) {
    samples.push({ symbol: "BTCUSDT", mode: "short", regime: "Range", volatility: "Normal", leverage: 2, stage: 2, net_pnl: 0.3, realised_pnl: 0.2 + i * 0.01, max_unrealized_pnl: 0.4, profit_giveback: 0.1, profit_giveback_pct: 25, shadow: false });
  }
  const groups = summarizeExitPolicies(samples);
  eq("按维度分组汇总", groups.length, 1);
  eq("样本数正确", groups[0].samples, 12);
  check("输出风险调整后的口径", groups[0].risk_adjusted != null && groups[0].giveback_pct != null, JSON.stringify(groups[0]));
  eq("样本不足的组不输出", summarizeExitPolicies(samples.slice(0, 3)).length, 0);
  check("Shadow 样本不进入正式汇总", summarizeExitPolicies(samples.map((s) => ({ ...s, shadow: true }))).length === 0);
  const good = { version: "exit-v2", shadow_samples: 100, walkforward_folds: 4, walkforward_pass_rate: 0.8, recent_holdout_samples: 60, giveback_pct: 18, max_drawdown_pct: 5, net_pnl: 12 };
  const champ = { version: "exit-v1", giveback_pct: 25, max_drawdown_pct: 6, net_pnl: 10 };
  const promote = evaluateExitPolicyPromotion({ challenger: good, champion: champ });
  eq("更优退出策略可晋级", promote.promote, true);
  eq("闸门顺序含 shadow→WF→holdout→giveback→DD", promote.reasons.filter((r) => r.startsWith("通过")).length >= 5, true);
  check("闸门理由完整可追溯", promote.reasons.length >= 5, JSON.stringify(promote.reasons));
  eq("回吐恶化被拒", evaluateExitPolicyPromotion({ challenger: { ...good, giveback_pct: 40 }, champion: champ }).promote, false);
  eq("回撤增加被拒", evaluateExitPolicyPromotion({ challenger: { ...good, max_drawdown_pct: 20 }, champion: champ }).promote, false);
  eq("净收益未改善被拒", evaluateExitPolicyPromotion({ challenger: { ...good, net_pnl: 5 }, champion: champ }).promote, false);
  eq("Shadow 样本不足被拒", evaluateExitPolicyPromotion({ challenger: { ...good, shadow_samples: 10 }, champion: champ }).promote, false);
  eq("WF 通过率不足被拒", evaluateExitPolicyPromotion({ challenger: { ...good, walkforward_pass_rate: 0.3 }, champion: champ }).promote, false);
  eq("Holdout 不足被拒", evaluateExitPolicyPromotion({ challenger: { ...good, recent_holdout_samples: 5 }, champion: champ }).promote, false);
  eq("退出策略版本常量存在", PROFIT_LOCK_VERSION.startsWith("profit-lock-"), true);
}

console.log("== I. 回撤状态机(§48-§50/§83) ==");
{
  eq("五个状态", DRAWDOWN_STATES.join(","), "NORMAL,CAUTION,DEFENSIVE,HARD_STOP,RECOVERY");
  near("回撤 = (peak-equity)/peak", drawdownOf(130, 117).pct, 10, 1e-9);
  eq("峰值缺失时回撤 0", drawdownOf(0, 50).pct, 0);
  let clock = T0;
  const acct = (equity) => ({ initial_balance: 100, total_equity: equity, peak_equity: 130, cash_balance: equity, reserved_balance: 0, realized_pnl: 0, unrealized_pnl: 0, max_drawdown_pct: 0 });
  // §83:状态随净值下降逐级升级,不是随机跳变
  const seq = [130, 128, 124, 118, 110].map((e) => classifyDrawdown(drawdownMetrics({ account: acct(e), wallets: {}, trades: [], now: clock })).state);
  check("净值下降时状态逐级升级", seq[0] === "NORMAL" && seq.indexOf("CAUTION") >= 0 && seq.indexOf("DEFENSIVE") >= 0, JSON.stringify(seq));
  eq("130 峰值无回撤 → NORMAL", seq[0], "NORMAL");
  eq("回撤到 110(约 -15%)→ HARD_STOP", seq[4], "HARD_STOP");
  const controller = createDrawdownController({ now: () => clock });
  const r1 = controller.evaluate({ account: acct(130), wallets: {}, trades: [], now: clock });
  eq("峰值净值 → NORMAL", r1.state, "NORMAL");
  eq("NORMAL 允许开仓", r1.actions.allow_new_positions, true);
  clock += 1000;
  const r2 = controller.evaluate({ account: acct(126), wallets: {}, trades: [], now: clock });
  check("小回撤 → CAUTION(降仓位/降杠杆)", r2.state === "CAUTION" && r2.actions.risk_scale < 1 && r2.actions.leverage_cap <= 5, JSON.stringify({ s: r2.state, a: r2.actions }));
  clock += 1000;
  const r3 = controller.evaluate({ account: acct(118), wallets: {}, trades: [], now: clock });
  check("回撤扩大 → DEFENSIVE", r3.state === "DEFENSIVE" && r3.actions.risk_scale < 0.5, JSON.stringify({ s: r3.state, a: r3.actions }));
  check("DEFENSIVE 更严置信门槛", r3.actions.min_confidence > r2.actions.min_confidence, JSON.stringify([r3.actions.min_confidence, r2.actions.min_confidence]));
  clock += 1000;
  const r4 = controller.evaluate({ account: acct(112), wallets: {}, trades: [], now: clock });
  check("触及硬阈值 → HARD_STOP", r4.state === "HARD_STOP", JSON.stringify({ s: r4.state, dd: r4.metrics.account.pct }));
  eq("HARD_STOP 禁止新开仓", r4.actions.allow_new_positions, false);
  eq("HARD_STOP 单笔风险归零", r4.actions.max_risk_per_trade_pct, 0);
  check("HARD_STOP 理由可追溯", r4.reasons.some((r) => /硬阈值|≥/.test(r)), JSON.stringify(r4.reasons));
  // 恢复条件不满足时不放行
  clock += 1000;
  const stillStop = controller.evaluate({ account: acct(118), wallets: {}, trades: [], new_trades_since_hard_stop: 0, now: clock });
  eq("冷却未到仍 HARD_STOP", stillStop.state, "HARD_STOP");
  check("列出未满足的恢复条件", stillStop.recovery_conditions != null && stillStop.reasons.some((r) => /恢复条件未满足/.test(r)), JSON.stringify(stillStop.reasons));
  // 日级与分池级回撤也要能触发
  const dailyOnly = classifyDrawdown(drawdownMetrics({ account: acct(130), wallets: {}, trades: [{ net_pnl: -5, exit_time: clock }], now: clock }));
  check("当日亏损触发(§48 日级)", dailyOnly.state !== "NORMAL", JSON.stringify(dailyOnly));
  const poolOnly = drawdownMetrics({ account: acct(130), wallets: { short: { allocated_balance: 40, peak_allocated: 50 }, long: { allocated_balance: 50, peak_allocated: 50 } }, trades: [], now: clock });
  near("单池回撤可算", poolOnly.short.pct, 20, 1e-9);
  check("分池回撤纳入判定", classifyDrawdown(poolOnly).state === "HARD_STOP", classifyDrawdown(poolOnly).state);
  check("模型/杠杆回撤在样本足够时可算", drawdownMetrics({ account: acct(130), wallets: {}, trades: [], leverage_records: Array.from({ length: 12 }, (_, i) => ({ net_pnl: i < 6 ? 0.5 : -0.8 })), now: clock }).model.pct != null);
  eq("样本不足时模型回撤明确 null", drawdownMetrics({ account: acct(130), wallets: {}, trades: [], leverage_records: [], now: clock }).model.pct, null);
}

console.log("== J. 渐进恢复(§55/§84) ==");
{
  let clock = T0;
  const controller = createDrawdownController({ now: () => clock });
  const acct = (equity) => ({ initial_balance: 100, total_equity: equity, peak_equity: 130, cash_balance: equity, reserved_balance: 0, realized_pnl: 0, unrealized_pnl: 0, max_drawdown_pct: 0 });
  controller.evaluate({ account: acct(110), wallets: {}, trades: [], now: clock });
  eq("先进入 HARD_STOP", controller.state(), "HARD_STOP");
  // 只回撤收窄但冷却未到 → 不放行
  clock += 1000;
  controller.evaluate({ account: acct(128), wallets: {}, trades: [], new_trades_since_hard_stop: 0, now: clock });
  eq("冷却未到不放行", controller.state(), "HARD_STOP");
  // 冷却到了但样本不足 → 不放行
  clock += RECOVERY_REQUIREMENTS.cooldown_ms + 1000;
  controller.evaluate({ account: acct(128), wallets: {}, trades: [], new_trades_since_hard_stop: 1, now: clock });
  eq("新样本不足不放行", controller.state(), "HARD_STOP");
  // 全部满足 → RECOVERY,且只允许 1x 小仓
  controller.evaluate({ account: acct(128), wallets: {}, trades: [], new_trades_since_hard_stop: RECOVERY_REQUIREMENTS.min_new_trades, now: clock });
  eq("满足条件进入 RECOVERY", controller.state(), "RECOVERY");
  const ladder0 = recoveryLadder("RECOVERY", { stable_samples: 0 });
  eq("恢复期第 1 档杠杆 = 1x", ladder0.leverage, 1);
  eq("恢复期允许开仓但受限", ladder0.allowed, true);
  const ladder2 = recoveryLadder("RECOVERY", { stable_samples: 12 });
  check("样本积累后逐级向上", ladder2.leverage > ladder0.leverage, JSON.stringify([ladder2.leverage, ladder0.leverage]));
  check("恢复期不会一步到最高杠杆", ladder2.leverage <= 5, String(ladder2.leverage));
  eq("HARD_STOP 阶梯禁止开仓", recoveryLadder("HARD_STOP").allowed, false);
  eq("NORMAL 阶梯按状态杠杆", recoveryLadder("CAUTION").leverage, DRAWDOWN_ACTIONS.CAUTION.leverage_cap);
  // 再次恶化立刻升级
  clock += 1000;
  controller.evaluate({ account: acct(105), wallets: {}, trades: [], new_trades_since_hard_stop: 5, now: clock });
  eq("恢复期再次恶化 → 立刻回到 HARD_STOP", controller.state(), "HARD_STOP");
  // 人工复位仅用于测试
  eq("复位可用且带原因", controller.reset("test").from, "HARD_STOP");
  eq("复位后为 NORMAL", controller.state(), "NORMAL");
    check("历史被记录(可审计)", controller.history().length >= 5, String(controller.history().length));
}

console.log("== K. 里程碑与风险预算(§56-§58) ==");
{
  eq("里程碑阶梯", EQUITY_MILESTONES.slice(0, 4).join(","), "100,125,150,200");
  eq("100 → 100 档", equityMilestoneOf(100), 100);
  eq("126 → 125 档", equityMilestoneOf(126), 125);
  eq("999 → 500 档(最高档)", equityMilestoneOf(999), 500);
  const b100 = riskBudgetFor(100);
  const b200 = riskBudgetFor(200);
  const b500 = riskBudgetFor(500);
  check("账户越大单笔风险越低", b100.risk_per_trade_pct > b200.risk_per_trade_pct && b200.risk_per_trade_pct > b500.risk_per_trade_pct, JSON.stringify([b100.risk_per_trade_pct, b200.risk_per_trade_pct, b500.risk_per_trade_pct]));
  check("账户越大杠杆倾向越低", b100.max_leverage_tendency >= b500.max_leverage_tendency, JSON.stringify([b100.max_leverage_tendency, b500.max_leverage_tendency]));
  check("账户越大回撤容忍越低", b100.drawdown_tolerance_pct > b500.drawdown_tolerance_pct, JSON.stringify([b100.drawdown_tolerance_pct, b500.drawdown_tolerance_pct]));
  check("文案说明保护已积累净值", /保护已积累净值/.test(b100.note), b100.note);
  // 状态动作真的受里程碑预算约束
  let clock = T0;
  const controller = createDrawdownController({ now: () => clock });
  const rec = controller.evaluate({ account: { initial_balance: 100, total_equity: 210, peak_equity: 210, cash_balance: 210, reserved_balance: 0, realized_pnl: 0, unrealized_pnl: 0, max_drawdown_pct: 0 }, wallets: {}, trades: [], now: clock });
  eq("识别到里程碑", rec.milestone, 200);
  check("NORMAL 状态下单笔风险受里程碑上限约束", rec.actions.max_risk_per_trade_pct <= riskBudgetFor(210).risk_per_trade_pct + 1e-9, JSON.stringify([rec.actions.max_risk_per_trade_pct, riskBudgetFor(210).risk_per_trade_pct]));
}

console.log("== L. 动态分配(§59-§61) ==");
{
  eq("区间 60-80 / 20-40", [ALLOCATION_BOUNDS.short_min_pct, ALLOCATION_BOUNDS.short_max_pct, ALLOCATION_BOUNDS.long_min_pct, ALLOCATION_BOUNDS.long_max_pct], [60, 80, 20, 40]);
  check("提供 Short 主画像(70/30)与均衡画像", ALLOCATION_PROFILES.short_main.short_pct === 70 && ALLOCATION_PROFILES.balanced.short_pct === 50);
  const weak = riskAdjustedScore({ trades: 5 });
  eq("样本不足不给分数", weak.score, null);
  const good = riskAdjustedScore({ trades: 60, win_rate: 62, avg_net_pnl: 0.5, max_drawdown_pct: 4, max_consecutive_losses: 1, avg_mfe: 1.2, avg_mae: 1.0 });
  const bad = riskAdjustedScore({ trades: 60, win_rate: 40, avg_net_pnl: -0.3, max_drawdown_pct: 12, max_consecutive_losses: 4, avg_mfe: 0.6, avg_mae: 1.4 });
  check("好池评分高于差池", good.score > bad.score, JSON.stringify([good.score, bad.score]));
  // Short 表现更好 → 提高 Short 权重(但不越过 80)
  const alloc = dynamicAllocation({ current_short_pct: 70, shortStats: { ...summarizeTrades(Array.from({ length: 60 }, (_, i) => ({ net_pnl: i % 3 === 0 ? -0.2 : 0.5, exit_time: T0 + i, mode: "short", mfe: 1.2, mae: 1 }))), max_drawdown_pct: 3, max_consecutive_losses: 1 }, longStats: { ...summarizeTrades(Array.from({ length: 60 }, (_, i) => ({ net_pnl: i % 2 === 0 ? -0.4 : 0.2, exit_time: T0 + i, mode: "long", mfe: 0.7, mae: 1.3 }))), max_drawdown_pct: 9, max_consecutive_losses: 3 } });
  check("结果落在 60-80 区间", alloc.short_pct >= 60 && alloc.short_pct <= 80, JSON.stringify(alloc));
  check("单次调整受步长上限约束(≤10pp)", Math.abs(alloc.short_pct - 70) <= 10 + 1e-9, JSON.stringify([alloc.short_pct, alloc.step_pct]));
  check("调整理由可追溯", alloc.reasons.length > 0, JSON.stringify(alloc.reasons));
  // §61:即使 Short 是主策略,回撤更大时也要降权重
  const rebalance = dynamicAllocation({ current_short_pct: 70, shortStats: { trades: 60, win_rate: 55, avg_net_pnl: 0.2, max_drawdown_pct: 15, max_consecutive_losses: 2, avg_mfe: 1, avg_mae: 1 }, longStats: { trades: 60, win_rate: 55, avg_net_pnl: 0.2, max_drawdown_pct: 3, max_consecutive_losses: 2, avg_mfe: 1, avg_mae: 1 } });
  check("Short 回撤更大 → 权重不高于当前(§61 允许调整)", rebalance.short_pct <= 70, JSON.stringify({ s: rebalance.short_pct, r: rebalance.reasons }));
  check("回撤理由被说明", rebalance.reasons.some((r) => /Long 回撤更大|Short 回撤/.test(r)), JSON.stringify(rebalance.reasons));
  // 防守期不做扩张性调整
  const defensive = dynamicAllocation({ current_short_pct: 70, drawdown: { state: "DEFENSIVE" }, shortStats: { trades: 60, win_rate: 70, avg_net_pnl: 0.8, max_drawdown_pct: 2, max_consecutive_losses: 0, avg_mfe: 1.5, avg_mae: 1 }, longStats: { trades: 60, win_rate: 35, avg_net_pnl: -0.5, max_drawdown_pct: 12, max_consecutive_losses: 5, avg_mfe: 0.5, avg_mae: 1.5 } });
  check("DEFENSIVE 时不扩张", defensive.short_pct <= 70, JSON.stringify(defensive));
  // 数据不足保持现状
  const insufficient = dynamicAllocation({ current_short_pct: 70, shortStats: { trades: 3 }, longStats: { trades: 2 } });
  eq("样本不足保持当前分配", [insufficient.short_pct, insufficient.long_pct, insufficient.changed], [70, 30, false]);
  // V14.5 §71:分配计划必须"可执行"(不再是 executable:false 的建议),且给出可移动金额
  const plan = allocationPlan({ account: { total_equity: 100, initial_balance: 100 }, wallets: { short: { allocated_balance: 50, available_balance: 50, reserved_balance: 0 }, long: { allocated_balance: 50, available_balance: 50, reserved_balance: 0 } }, current_short_pct: 50, shortStats: { trades: 60, win_rate: 65, avg_net_pnl: 0.6, max_drawdown_pct: 2, max_consecutive_losses: 0, avg_mfe: 1.4, avg_mae: 1 }, longStats: { trades: 60, win_rate: 45, avg_net_pnl: -0.2, max_drawdown_pct: 8, max_consecutive_losses: 3, avg_mfe: 0.8, avg_mae: 1.2 } });
  check("计划含目标百分比", plan.target.short_pct > 0 && plan.target.long_pct > 0, JSON.stringify(plan.target));
  check("计划给出可移动金额与可执行标记", plan.movable_amount > 0 && plan.executable === true, JSON.stringify({ m: plan.movable_amount, e: plan.executable }));
  eq("明确声明保留已占用保证金", plan.reserved_preserved, true);
  check("文案说明只调整可用余额(§72)", /只调整 available_balance/.test(plan.note), plan.note);
  // 真正落账:只动 available,reserved 不变
  const applied = rebalanceWallets({ plan, wallets: { short: { allocated_balance: 50, available_balance: 50, reserved_balance: 0 }, long: { allocated_balance: 50, available_balance: 50, reserved_balance: 0 } }, positions: [], now: 1700000000000 });
  check("调仓真正执行成功", applied.ok === true && applied.moved > 0, JSON.stringify(applied).slice(0, 140));
  check("Short 可用增加、Long 可用减少", QE_gt(applied.wallets.short.available_balance, 50) && QE_lt(applied.wallets.long.available_balance, 50), JSON.stringify([applied.wallets.short.available_balance, applied.wallets.long.available_balance]));
  const factor = allocationRiskFactor({ short_pct: 70 });
  near("Short 占比 70 → 风险因子 1.4", factor.short_factor, 1.4, 1e-9);
  near("Long 风险因子 0.6", factor.long_factor, 0.6, 1e-9);
  const view = allocationView({ decision: alloc, stats: { short: { trades: 60, win_rate: 62, net_pnl: 5, max_drawdown_pct: 3 }, long: { trades: 60, win_rate: 45, net_pnl: -2, max_drawdown_pct: 9 } } });
  check("UI 行含双池占比与表现", view.rows.length === 2 && /短线/.test(view.summary), JSON.stringify(view.summary));
  const drawView = drawdownView({ state: "CAUTION", metrics: { account: { pct: 4.2 }, daily: { pct: 1.1 }, short: { pct: 5 }, long: { pct: 2 }, peak_equity: 130 }, actions: DRAWDOWN_ACTIONS.CAUTION, reasons: ["回撤扩大"] });
  check("回撤 UI 文案中文可读", drawView.state_label === "注意" && /4.20%/.test(drawView.account_dd_text), JSON.stringify(drawView));
}

console.log("== M. 引擎集成(Profit Lock / Drawdown 真实生效) ==");
{
  const store = await createHistoryStore({ memory: true });
  let clock = T0;
  const adapter = { get: (t, k) => store.generic.get(t, k), all: (t) => store.generic.all(t), put: (t, r) => store.generic.put(t, r) };
  const eng = createPaperEngine({
    store: adapter,
    now: () => clock,
    riskCheck: () => ({ veto: false }),
    fetchKlines: async () => [],
    profitLock: { trendStrength: 0.3, reversalRisk: 0.7, remainingOpportunity: 0.1, persistShadow: false },
    drawdown: createDrawdownController({ now: () => clock })
  });
  await eng.init();
  await eng.start();
  const open = await eng.openPosition({ mode: "short", symbol: "BTCUSDT", direction: "Bullish", signal_timestamp: clock, quote: { price: 100, received_at: clock }, analysis: { direction: "Bullish", volatility: { atrPct: 2 }, market_regime: { label: "Weak Uptrend" }, structure: { last_swing_low: 90 } } });
  check("开仓成功", open.ok === true, JSON.stringify(open).slice(0, 120));
  const pos0 = eng.getPositions().find((p) => p.status === "OPEN");
  const stopBefore = pos0.stop_price;
  // 价格大涨 → MFE 上升 → 应推进止损(单调)
  clock += 3600000;
  const loopUp = await eng.loop({ quotes: { BTCUSDT: { price: 112, high: 112, low: 100, received_at: clock } }, candidates: [], atr: 2, volatilityLevel: "Normal" });
  check("Loop 成功", loopUp.ok === true, JSON.stringify(loopUp.summary).slice(0, 160));
  const pos1 = eng.getPositions().find((p) => p.symbol === "BTCUSDT");
  check("止损被推进(含费保护位)", Number(pos1.stop_price) > Number(stopBefore), JSON.stringify([stopBefore, pos1.stop_price]));
  check("止损状态被记录", pos1.stop_state && pos1.stop_state.price === pos1.stop_price, JSON.stringify(pos1.stop_state));
  check("Profit Lock 有动作摘要", Array.isArray(loopUp.summary.profit_lock) && loopUp.summary.profit_lock.length > 0, JSON.stringify(loopUp.summary.profit_lock));
  check("Profit Lock 日志可读", eng.getProfitLockLog().length > 0, JSON.stringify(eng.getProfitLockLog()));
  // 继续上涨 → 阶段提升 → 部分锁定的可能性(至少不倒退)
  clock += 3600000;
  const loopUp2 = await eng.loop({ quotes: { BTCUSDT: { price: 124, high: 124, low: 110, received_at: clock } }, candidates: [], atr: 2, volatilityLevel: "High" });
  const pos2 = eng.getPositions().find((p) => p.symbol === "BTCUSDT");
  check("止损继续单调上移", pos2.status !== "OPEN" || Number(pos2.stop_price) >= Number(pos1.stop_price), JSON.stringify([pos1.stop_price, pos2.stop_price]));
  check("已有部分平仓记录或被保护", pos2.partial_close_count >= 0 && loopUp2.ok === true, JSON.stringify({ pc: pos2.partial_close_count }));
  // 回撤:HARD_STOP 时不再新开仓
  const dd = createDrawdownController({ now: () => clock });
  const store2 = await createHistoryStore({ memory: true });
  const eng2 = createPaperEngine({
    store: { get: (t, k) => store2.generic.get(t, k), all: (t) => store2.generic.all(t), put: (t, r) => store2.generic.put(t, r) },
    now: () => clock,
    riskCheck: () => ({ veto: false }),
    fetchKlines: async () => [],
    drawdown: dd
  });
  await eng2.init();
  await eng2.start();
  // 人为制造大回撤(把 peak_equity 抬高)
  eng2.engine.account = { ...eng2.engine.account, peak_equity: 200, total_equity: 100 };
  const blocked = await eng2.loop({ quotes: {}, candidates: [{ mode: "short", symbol: "ETHUSDT", direction: "Bullish", signal_timestamp: clock, quote: { price: 100, received_at: clock }, analysis: { direction: "Bullish", volatility: { atrPct: 1 }, market_regime: { label: "Uptrend" } } }] });
  check("HARD_STOP 阻止新开仓", blocked.summary.opened.length === 0 && blocked.summary.skipped.some((s) => s.reason === "drawdown_hard_stop"), JSON.stringify(blocked.summary));
  eq("摘要暴露回撤状态", blocked.summary.drawdown_state, "HARD_STOP");
  check("回撤记录可读", eng2.getDrawdown() && eng2.getDrawdown().state === "HARD_STOP", JSON.stringify(eng2.getDrawdown() && eng2.getDrawdown().state));
  // §62:外部情报只能收紧
  const store3 = await createHistoryStore({ memory: true });
  const eng3 = createPaperEngine({
    store: { get: (t, k) => store3.generic.get(t, k), all: (t) => store3.generic.all(t), put: (t, r) => store3.generic.put(t, r) },
    now: () => clock,
    riskCheck: () => ({ veto: false, risk_score: 20, risk_flags: [], reasons: [] }),
    fetchKlines: async () => []
  });
  await eng3.init();
  await eng3.start();
  eng3.observeExternalContext(buildExternalStress());
  const gated = await eng3.openPosition({ mode: "short", symbol: "BTCUSDT", direction: "Bullish", signal_timestamp: clock, quote: { price: 100, received_at: clock }, analysis: { direction: "Bullish", volatility: { atrPct: 1 }, market_regime: { label: "Uptrend" } } });
  check("外部上下文抬高风险分(不强否决)", gated.ok === true || gated.reason === "risk_veto", JSON.stringify(gated).slice(0, 120));
  const gate = eng3.currentExternalGate({ symbol: "BTCUSDT" });
  eq("gate 不放行开仓(硬约束)", gate.can_grant_open, false);
  check("gate 收紧量非负", gate.risk_score_delta >= 0, JSON.stringify(gate));
  // 未注入依赖时行为与 V14.3 完全一致
  const store4 = await createHistoryStore({ memory: true });
  const plain = createPaperEngine({ store: { get: (t, k) => store4.generic.get(t, k), all: (t) => store4.generic.all(t), put: (t, r) => store4.generic.put(t, r) }, now: () => clock, riskCheck: () => ({ veto: false }), fetchKlines: async () => [] });
  await plain.init();
  await plain.start();
  const plainOpen = await plain.openPosition({ mode: "short", symbol: "BTCUSDT", direction: "Bullish", signal_timestamp: clock, quote: { price: 100, received_at: clock }, analysis: { direction: "Bullish", volatility: { atrPct: 2 }, market_regime: { label: "Weak Uptrend" } } });
  check("未注入时仍可正常开仓(V14.3 行为不变)", plainOpen.ok === true, JSON.stringify(plainOpen).slice(0, 120));
  const plainLoop = await plain.loop({ quotes: { BTCUSDT: { price: 112, high: 112, low: 100, received_at: clock } }, candidates: [], atr: 2 });
  eq("未注入 profitLock 时无 profit_lock 摘要", plainLoop.summary.profit_lock, undefined);
  eq("未注入 drawdown 时不产生回撤状态", plainLoop.summary.drawdown_state, undefined);
  eq("未注入时止损保持原样(不被 profit lock 改动)", Number(plain.getPositions().find((p) => p.symbol === "BTCUSDT").stop_price), Number(plainOpen.position.stop_price));
}

function buildExternalStress() {
  return {
    market_stress_context: { available: true, level: "High", stress_score: 65, notes: ["爆仓单边集中"] },
    funding_context: { available: true, extreme: true, crowding_risk: 85, rate: 0.0015, direction: "longs_pay" },
    news_context: { available: true, conflicted: true, sentiment: "neutral", confidence: 40 },
    oi_context: { available: true, interpretation: "weak_up_short_covering" },
    overall: { available: true, status: "partial", freshness: 1, unavailable: [] }
  };
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("PROFIT LOCK TESTS OK");
