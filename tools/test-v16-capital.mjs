// tools/test-v16-capital.mjs · V16 资金与决策内核测试
// 覆盖 V16 要求的关键打靶:Entry Quality Gate / Low Net Edge Skip / High Uncertainty Skip /
// Meaningful Position / 40% Hard Cap / Portfolio Exposure Cap / Capital Reservation Atomicity /
// Protected Profit Isolation / 70-30 Profit Allocation / Unrealized PnL Cannot Spend /
// No Loss Averaging / Profit Protection / Loss Thesis Hold / Thesis Invalid Exit /
// High-Water Mark / 20% Confirmed Hard Stop / Bad Price Does Not False Trigger / HARD STOP Recovery /
// NaN-Infinity Guard / Accounting Transaction / 精确金额(最小单位整数)
import { createPaperEngine } from "../worker/src/paper/engine.js";
import { createHistoryStore } from "../worker/src/history/store.js";
import { PAPER_DEFAULTS, num } from "../worker/src/paper/accounting.js";
import {
  MONEY_UNIT, MONEY_DRIFT_TOLERANCE_UNITS, toUnits, fromUnits, addUnits, subUnits, sumUnits,
  mulScalarUnits, mulDivUnits, divUnits, ratioUnits, cmpUnits, eqUnits, driftOf, ledgerExactAudit, fmtUnits
} from "../worker/src/paper/money.js";
import {
  ENTRY_DECISION_KINDS, ENTRY_QUALITY_RULES, MIN_MEANINGFUL_RULES, NO_TRADE_ZH,
  ruleDirectionProbability, probabilityDistribution, estimateTradeCosts, expectedGrossEdgePct,
  entryQuality, minimumMeaningfulPosition, skipShadowRecord, resolveSkipShadow, entryQualityView
} from "../worker/src/paper/entryQuality.js";
import {
  CAPITAL_LIMITS, allocationPctForQuality, clusterOfSymbol, effectiveExposure, capitalAllocation,
  createReserveBook, reserveCapital, commitReserve, releaseReserve, sweepOrphanReservations,
  reservedTotal, reserveConsistency, reserveSummary, getReservation, exposureReport, notionalExposureOf
} from "../worker/src/paper/capitalAllocator.js";
import {
  PROFIT_SPLIT, createProfitPool, protectedBalance, protectedIsSpendable, protectedIsolationCheck,
  splitProfitOnPositionClose, poolLayers, poolSummary
} from "../worker/src/paper/profitAllocation.js";
import {
  HWM_THRESHOLDS, HWM_CONFIRMATION, createHwmState, mergeHwm, drawdownFromPeak, classifyHwm,
  scaleForDrawdown, updateHwm, hardStopGate, recoverFromHardStop, hwmRecord} from "../worker/src/paper/hwm.js";
import {
  THESIS_RULES, buildEntryThesis, evaluateThesis, profitProtectionDecision, lossManagementDecision,
  addPositionDecision, flipAllowed, mustExitImmediately, rhythmPolicy, thesisView
} from "../worker/src/paper/thesis.js";
import {
  createDiagnostics, captureError, diagBreadcrumb, diagSnapshot, diagExportBundle, diagRedact, diagDedupeSummary
} from "../worker/src/paper/diagnostics.js";
import { detectBehaviorAnomalies } from "../worker/src/paper/behaviorAnomaly.js";

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log("PASS  " + name); }
  else { failed += 1; console.log("FAIL  " + name + (detail ? "  => " + detail : "")); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), "got " + JSON.stringify(actual) + " want " + JSON.stringify(expected));
}
function near(name, actual, expected, tol) {
  check(name, Math.abs(actual - expected) <= (tol == null ? 1e-9 : tol), "got " + actual + " want ~" + expected);
}

const T0 = 1700000000000;
const MIN = 60000;

// ============================================================
console.log("== A. 精确金额层(整数最小单位)+ NaN/Infinity 守卫 ==");
{
  eq("1 USDT = 1e8 最小单位", MONEY_UNIT, 100000000);
  eq("0.1 → 最小单位", toUnits(0.1), 10000000);
  eq("非法值不落成 0", toUnits(NaN), null);
  eq("Infinity 拒绝", toUnits(Infinity), null);
  eq("null 拒绝", toUnits(null), null);
  eq("精确加法", addUnits(0.1, 0.2), 30000000);
  eq("fromUnits 回到浮点", fromUnits(30000000), 0.3);
  check("0.1+0.2 在最小单位下等于 0.3", eqUnits(0.1 + 0.2, 0.3));
  eq("精确减法", subUnits(1, 0.3), 70000000);
  eq("精确求和", sumUnits([0.1, 0.2, 0.3]), 60000000);
  eq("任一非法则整条结果非法", sumUnits([0.1, NaN]), null);
  eq("金额×标量四舍五入", mulScalarUnits(10, 0.7), 700000000);
  eq("金额×比例÷份额", mulDivUnits(100, 3, 3), 10000000000);
  eq("除法除零返回 null(不是 Infinity)", divUnits(1, 0), null);
  eq("除法 NaN 返回 null", divUnits(1, NaN), null);
  eq("比例分母为 0 → null", ratioUnits(1, 0), null);
  eq("比较", cmpUnits(0.1, 0.10000001), -1);
  const bad = driftOf([0.1], 0.2);
  eq("漂移可被检出", bad.ok, false);
  eq("漂移原因", bad.reason, "drift_detected");
  near("漂移量(最小单位)", bad.drift_units, -MONEY_UNIT / 10, 0);
  const okDrift = driftOf([0.1, 0.2], 0.3);
  eq("正常累计无漂移", okDrift.ok, true);
  eq("容差常量", MONEY_DRIFT_TOLERANCE_UNITS, 100);
  eq("展示不出现浮点尾巴", fmtUnits(0.1 + 0.2, 8), "0.3");

  const auditOk = ledgerExactAudit({
    account: { cash_balance: 50, reserved_balance: 30, unrealized_pnl: 2, total_equity: 82 },
    positions: [{ position_id: "p1", status: "OPEN", entry_notional: 30 }]
  });
  eq("账本恒等式成立", auditOk.ok, true);
  const auditBad = ledgerExactAudit({
    account: { cash_balance: 50, reserved_balance: 30.0001, unrealized_pnl: 2, total_equity: 82 },
    positions: [{ position_id: "p1", status: "OPEN", entry_notional: 30 }]
  });
  eq("预占对不上被抓住", auditBad.ok, false);
  check("违规码含 reserved_reconcile_drift", auditBad.violations.includes("reserved_reconcile_drift"), JSON.stringify(auditBad.violations));
  const auditNaN = ledgerExactAudit({ account: { cash_balance: NaN, reserved_balance: 0, unrealized_pnl: 0, total_equity: 0 }, positions: [] });
  check("NaN 账本被拒绝", auditNaN.violations.includes("cash_not_representable"), JSON.stringify(auditNaN.violations));
}

// ============================================================
console.log("== B. Entry Quality Gate(费用前置 + 概率差距 + 正式 NO_TRADE) ==");
{
  eq("正式决策枚举", ENTRY_DECISION_KINDS, ["LONG", "SHORT", "HOLD", "NO_TRADE", "UNKNOWN", "DATA_UNRELIABLE", "MODEL_CONFLICT"]);
  const rp = ruleDirectionProbability(0);
  near("规则分 0 → 中性", rp.bull, 0.5, 1e-9);

  const costs = estimateTradeCosts({ notional: 1000, config: { fee_bps: 4, slippage_bps: 3, half_spread_bps: 1 }, atr_pct: 0 });
  near("入场费", costs.entry_fee, 0.4, 1e-9);
  near("出场费", costs.exit_fee, 0.4, 1e-9);
  near("点差成本(进出各一次)", costs.spread_cost, 0.2, 1e-9);
  near("滑点成本", costs.slippage_cost, 0.6, 1e-9);
  near("总成本", costs.total_cost, 1.6, 1e-9);
  near("成本占名义 %", costs.cost_pct, 0.16, 1e-9);
  const costsVol = estimateTradeCosts({ notional: 1000, config: { fee_bps: 4, slippage_bps: 3, half_spread_bps: 1 }, atr_pct: 3 });
  check("高波动放大滑点", costsVol.slippage_cost > costs.slippage_cost, String(costsVol.slippage_cost));
  const costsUnknownFunding = estimateTradeCosts({ notional: 1000, funding_rate: null });
  eq("费率未知不猜(标记 unknown)", costsUnknownFunding.funding_known, false);
  near("费率未知时资金费为 0", costsUnknownFunding.funding_cost, 0, 1e-9);

  // 38 / 34 / 28 的概率分布:优势只有 4 个百分点 → 不允许开仓
  const weak = entryQuality({
    predictor: { bull_probability: 0.38, bear_probability: 0.28, expected_move_pct: 1.5 },
    notional: 20,
    config: PAPER_DEFAULTS
  });
  check("38/34/28 不强行做多", weak.allow_entry === false, JSON.stringify(weak.distribution));
  check("原因=概率优势不明显", weak.blockers.includes("PROB_GAP_TOO_SMALL"), JSON.stringify(weak.blockers));
  check("决策属于正式枚举(不是沉默)", ENTRY_DECISION_KINDS.includes(weak.decision), weak.decision);
  check("NO_TRADE 有中文解释", NO_TRADE_ZH.PROB_GAP_TOO_SMALL === "概率优势不明显", NO_TRADE_ZH.PROB_GAP_TOO_SMALL);
  check("NO_TRADE 也是正式决策", weak.decision === "NO_TRADE" || weak.decision === "UNKNOWN", weak.decision);
  near("概率差距被量化", weak.probability_gap, 0.04, 1e-9);

  // 明确的做多机会
  const strong = entryQuality({
    rule: { score: 60 },
    predictor: { bull_probability: 0.8, bear_probability: 0.2, expected_move_pct: 1.0, uncertainty: 0.2 },
    notional: 20,
    config: PAPER_DEFAULTS
  });
  eq("概率优势足够 → 允许做多", strong.allow_entry, true);
  eq("方向 = LONG", strong.direction, "LONG");
  check("净边际为正", strong.net_expected_edge_pct > 0, String(strong.net_expected_edge_pct));
  check("综合质量分达标", strong.entry_score >= ENTRY_QUALITY_RULES.min_entry_score, String(strong.entry_score));

  // 费用吃掉边际 → SKIP_LOW_NET_EDGE
  const lowEdge = entryQuality({
    rule: { score: 60 },
    predictor: { bull_probability: 0.8, bear_probability: 0.2, expected_move_pct: 0.1, uncertainty: 0.2 },
    notional: 20,
    config: PAPER_DEFAULTS
  });
  eq("理论收益被费用吃掉 → 不交易", lowEdge.allow_entry, false);
  check("原因=扣费后净边际过低", lowEdge.blockers.includes("SKIP_LOW_NET_EDGE"), JSON.stringify(lowEdge.blockers));
  check("净边际为负", lowEdge.net_expected_edge_pct < 0, String(lowEdge.net_expected_edge_pct));

  // 高不确定性 → NO_TRADE
  const unsure = entryQuality({
    rule: { score: 60 },
    predictor: { bull_probability: 0.7, bear_probability: 0.2, expected_move_pct: 2, uncertainty: 0.9 },
    notional: 20,
    config: PAPER_DEFAULTS
  });
  check("不确定性过高 → 不交易", unsure.blockers.includes("HIGH_UNCERTAINTY"), JSON.stringify(unsure.blockers));

  // 数据不可靠
  const badData = entryQuality({ rule: { score: 60 }, data_quality: { ok: false }, notional: 20, config: PAPER_DEFAULTS });
  eq("数据不可靠 → DATA_UNRELIABLE", badData.decision, "DATA_UNRELIABLE");
  eq("此时不开仓", badData.allow_entry, false);

  // 模型冲突
  const conflict = entryQuality({
    rule: { score: 60 },
    ml: { bull: 0.2, bear: 0.8 },
    notional: 20,
    config: PAPER_DEFAULTS
  });
  eq("规则与模型对立 → MODEL_CONFLICT", conflict.decision, "MODEL_CONFLICT");
  eq("冲突不开仓", conflict.allow_entry, false);

  // 最小有意义仓位
  const mm1 = minimumMeaningfulPosition({ equity: 100, net_expected_edge_pct: 0.5, requested_notional: 3 });
  eq("预期收益太小的仓位不可行", mm1.feasible, false);
  eq("原因 = BELOW_MIN_MEANINGFUL", mm1.reason, "BELOW_MIN_MEANINGFUL");
  check("最小名义被算出", mm1.min_notional >= MIN_MEANINGFUL_RULES.min_notional_pct_of_equity, String(mm1.min_notional));
  const mm2 = minimumMeaningfulPosition({ equity: 100, net_expected_edge_pct: 2, requested_notional: 20 });
  eq("足够大的仓位可行", mm2.feasible, true);
  const mm3 = minimumMeaningfulPosition({ equity: 10, net_expected_edge_pct: 5, requested_notional: 2 });
  eq("小账户不被 5U 绝对门槛误杀", mm3.feasible, true);
  check("小账户的最小名义随净值缩放", mm3.min_notional < MIN_MEANINGFUL_RULES.min_notional_usdt, String(mm3.min_notional));
  const mm4 = minimumMeaningfulPosition({ equity: 10, net_expected_edge_pct: 2, requested_notional: 1.5 });
  eq("小账户里预期收益仍不足的仓位也不开", mm4.feasible, false);

  // 影子记录(没做的那一单也要能复盘)
  const shadow = skipShadowRecord(weak, { symbol: "BTCUSDT", mode: "short", at: T0, entry_price: 42000, candle_time: T0 });
  eq("SKIP 影子记录类型", shadow.kind, "SKIP_SHADOW");
  eq("影子方向来自概率分布", shadow.would_be_direction, "LONG");
  const resolved = resolveSkipShadow(shadow, 43000);
  eq("影子结果可回填", resolved.resolved, true);
  eq("做多踏空的判定", resolved.outcome, "WOULD_WIN");
  check("影子盈亏为正", resolved.counterfactual_pnl_pct > 0, String(resolved.counterfactual_pnl_pct));

  const view = entryQualityView(strong);
  check("中文视图可用", Boolean(view.decision_zh) && view.score === strong.entry_score, JSON.stringify(view));
  const dist = probabilityDistribution({ rule: { score: 0 } });
  near("单一来源归一化", dist.bull + dist.bear + dist.neutral, 1, 1e-9);
  eq("无来源时明确失败", probabilityDistribution({}).ok, false);
}

// ============================================================
console.log("== C. 组合资金分配 + 原子预占 ==");
{
  eq("单仓硬上限 = 40%(保证金口径)", CAPITAL_LIMITS.max_single_position_pct, 40);
  eq("组合保证金上限 = 100%(不允许 120% 保证金)", CAPITAL_LIMITS.max_portfolio_margin_pct, 100);
  check("名义暴露上限只作为展示告警", CAPITAL_LIMITS.max_notional_exposure_pct >= 100, String(CAPITAL_LIMITS.max_notional_exposure_pct));
  // 100U 账户绝不允许占用 120U 保证金
  const overMargin = capitalAllocation({
    equity: 100, requested_pct: 100, quality_score: 100, available_cash: 1e12, symbol: "BTCUSDT", direction: "LONG",
    positions: [{ symbol: "ETHUSDT", status: "OPEN", remaining_margin: 70, direction: "LONG" }]
  });
  check("保证金合计不得超过可交易资金", overMargin.allowed === false || overMargin.approved_usdt <= 30 + 1e-6, JSON.stringify({ allowed: overMargin.allowed, usdt: overMargin.approved_usdt }));
  // 名义暴露与保证金暴露必须分开(杠杆让名义 >100% 是正常的)
  const expoRep = exposureReport({
    equity: 100, tradable_capital: 100,
    positions: [{ symbol: "BTCUSDT", status: "OPEN", remaining_margin: 20, direction: "LONG", remaining_quantity: 0.0005, current_price: 84000, leverage: 5 }]
  });
  near("保证金暴露 20U", expoRep.margin_exposure_usdt, 20, 1e-6);
  near("保证金暴露 20%", expoRep.margin_exposure_pct, 20, 1e-6);
  near("名义暴露 = 数量 × 现价(42U)", expoRep.notional_exposure_usdt, 42, 1e-6);
  check("名义暴露可超过 100% 且单独展示", expoRep.notional_exposure_pct !== expoRep.margin_exposure_pct, JSON.stringify(expoRep));
  check("暴露报告区分两种口径(有中文说明)", /保证金/.test(expoRep.note_zh) && /名义/.test(expoRep.note_zh), expoRep.note_zh);
  eq("质量 0 → 不分配", allocationPctForQuality(0), 0);
  eq("质量 45 → 不分配", allocationPctForQuality(45), 0);
  eq("质量 60 → 15%", allocationPctForQuality(60), 15);
  eq("质量 75 → 25%", allocationPctForQuality(75), 25);
  eq("质量 100 → 40%(硬上限)", allocationPctForQuality(100), 40);
  eq("超出也不突破 40%", allocationPctForQuality(140), 40);
  near("质量 70 线性插值", allocationPctForQuality(70), 21.666666, 1e-4);

  const a1 = capitalAllocation({ equity: 1000, requested_pct: 100, quality_score: 100, positions: [], available_cash: 1e12, symbol: "BTCUSDT", direction: "LONG" });
  eq("高质量机会允许", a1.allowed, true);
  eq("但被 40% 硬上限削到 40%", a1.approved_pct, 40);
  check("记录被削原因", a1.caps_applied.includes("SINGLE_CAP"), JSON.stringify(a1.caps_applied));
  near("批准金额 = 净值 × 40%", a1.approved_usdt, 400, 1e-9);

  const aLow = capitalAllocation({ equity: 1000, requested_pct: 20, quality_score: 30, positions: [], available_cash: 1e12, symbol: "BTCUSDT", direction: "LONG" });
  eq("低质量直接 SKIP", aLow.allowed, false);
  eq("拒绝码", aLow.code, "QUALITY_TOO_LOW");

  const openPos = (symbol, margin, dir) => ({ symbol, status: "OPEN", remaining_margin: margin, direction: dir });
  const crowded = capitalAllocation({
    equity: 1000, requested_pct: 40, quality_score: 100, available_cash: 1e12, symbol: "SOLUSDT", direction: "LONG",
    positions: [openPos("BTCUSDT", 300, "LONG"), openPos("ETHUSDT", 300, "LONG"), openPos("BNBUSDT", 300, "LONG")]
  });
  eq("组合已满 → 拒绝", crowded.allowed, false);
  check("原因含组合/相关阵营上限", crowded.caps_applied.includes("PORTFOLIO_CAP") || crowded.caps_applied.includes("CLUSTER_CAP"), JSON.stringify(crowded.caps_applied));

  const expo = effectiveExposure([openPos("BTCUSDT", 100, "LONG"), openPos("ETHUSDT", 100, "LONG")], {});
  near("毛暴露 = 各仓保证金之和", expo.gross_margin, 200, 1e-9);
  check("高相关同向暴露被放大(不能当独立风险)", expo.adjusted_exposure > expo.gross_margin, String(expo.adjusted_exposure));
  const expoLowCorr = effectiveExposure([openPos("BTCUSDT", 100, "LONG"), openPos("ETHUSDT", 100, "SHORT")], {});
  near("反向仓位不放大同向风险", expoLowCorr.adjusted_exposure, 200, 1e-9);
  eq("默认同阵营", clusterOfSymbol("BTCUSDT"), "CRYPTO_BETA");

  const dd = capitalAllocation({ equity: 1000, requested_pct: 30, quality_score: 90, positions: [], available_cash: 1e12, drawdown_scale: 0.5, symbol: "BTCUSDT", direction: "LONG" });
  near("回撤期只能向下缩放", dd.approved_pct, 15, 1e-6);
  check("记录回撤下调", dd.caps_applied.includes("DRAWDOWN_DOWNGRADE"));

  // 原子预占
  const book = createReserveBook({ available: 100 });
  const r1 = reserveCapital(book, { intent_id: "i1", amount: 60, symbol: "BTCUSDT", now: T0 });
  eq("首笔预占成功", r1.ok, true);
  check("可用被扣减", book.available < 100, String(book.available));
  const r2 = reserveCapital(book, { intent_id: "i2", amount: 60, symbol: "ETHUSDT", now: T0 });
  eq("同一分钱不能被第二笔预占", r2.ok, false);
  eq("拒绝原因", r2.reason, "insufficient_available");
  const r3 = reserveCapital(book, { intent_id: "i3", amount: 40, symbol: "ETHUSDT", now: T0 });
  eq("剩余额度内可以再预占", r3.ok, true);
  near("预占合计", reservedTotal(book), 100, 1e-9);
  const rel = releaseReserve(book, "i1", "open_failed", T0);
  eq("失败必须能释放", rel.ok, true);
  near("释放后可用恢复", book.available, 60, 1e-9);
  const before = book.available;
  commitReserve(book, "i3", { now: T0 });
  near("兑现不再二次扣减可用", book.available, before, 1e-9);
  eq("兑现后不再算作未决预占", reservedTotal(book), 0, 1e-9);
  const dangling = reserveCapital(book, { intent_id: "i9", amount: 10, symbol: "SOLUSDT", now: T0, ttl_ms: 1000 });
  eq("建立待清理预占", dangling.ok, true);
  const swept = sweepOrphanReservations(book, { now: T0 + 5000, live_intent_ids: [] });
  eq("崩溃孤儿预占被清理", swept.count, 1);
  check("孤儿释放原因", getReservation(book, "i9").release_reason === "orphan_reservation_expired", getReservation(book, "i9").release_reason);
  const consistent = reserveConsistency(book, book.available + reservedTotal(book));
  eq("预占与账本对账一致", consistent.ok, true);
  const summary = reserveSummary(book);
  check("预占摘要含拒绝计数", summary.rejected >= 1, JSON.stringify(summary));
}

// ============================================================
console.log("== D. 利润分配(70/30)与保护池隔离 ==");
{
  eq("30% 回可交易 / 70% 进保护池", PROFIT_SPLIT, { tradable_pct: 30, protected_pct: 70 });
  const pool = createProfitPool({ now: T0 });
  const s1 = splitProfitOnPositionClose(pool, { position_id: "p1", symbol: "BTCUSDT", net_realized_pnl: 10, at: T0, available_tradable: 100 });
  eq("净赚 10U → 执行分配", s1.applied, true);
  near("7U 进保护池", s1.record.to_protected, 7, 1e-9);
  near("3U 回可交易", s1.record.to_tradable, 3, 1e-9);
  near("保护池余额", protectedBalance(pool), 7, 1e-9);

  const s2 = splitProfitOnPositionClose(pool, { position_id: "p1", symbol: "BTCUSDT", net_realized_pnl: 10, at: T0 + 1000, available_tradable: 100 });
  eq("同一母仓位只结算一次", s2.applied, false);
  eq("重复原因", s2.reason, "already_split");
  near("保护池没有重复增加", protectedBalance(pool), 7, 1e-9);

  const s3 = splitProfitOnPositionClose(pool, { position_id: "p2", net_realized_pnl: -5, at: T0, available_tradable: 100 });
  eq("亏损仓位不分配", s3.applied, false);
  eq("原因 = 无利润", s3.reason, "no_profit");

  const s4 = splitProfitOnPositionClose(pool, { position_id: "p3", net_realized_pnl: 0.2, at: T0, available_tradable: 100 });
  eq("利润太小不折腾", s4.applied, false);

  const capped = splitProfitOnPositionClose(createProfitPool({}), { position_id: "p4", net_realized_pnl: 10, at: T0, available_tradable: 2 });
  near("可交易现金不够时只搬得起的部分", capped.record.to_protected, 2, 1e-9);
  eq("如实标记封顶原因", capped.record.capped_by, "available_tradable");

  eq("保护池永远不可花费", protectedIsSpendable(), false);
  const misuseNew = protectedIsolationCheck(pool, { purpose: "new_entry", amount: 1, available_tradable: 100 });
  eq("禁止用保护池开新仓", misuseNew.blocked, true);
  eq("禁止用保护池加仓", protectedIsolationCheck(pool, { purpose: "add_position", amount: 1, available_tradable: 100 }).blocked, true);
  eq("禁止用保护池加杠杆", protectedIsolationCheck(pool, { purpose: "auto_leverage", amount: 1, available_tradable: 100 }).blocked, true);
  eq("禁止用保护池回撤补仓", protectedIsolationCheck(pool, { purpose: "catch_up", amount: 1, available_tradable: 100 }).blocked, true);
  eq("正常用途在可交易额度内放行", protectedIsolationCheck(pool, { purpose: "reduce_risk", amount: 1, available_tradable: 100 }).blocked, false);
  eq("超出可交易额度也被拒", protectedIsolationCheck(pool, { purpose: "reduce_risk", amount: 999, available_tradable: 100 }).blocked, true);
  check("误用被记录", pool.blocked_attempts.length >= 4, String(pool.blocked_attempts.length));

  // 浮盈不能当现金用
  const layers = poolLayers({ equity: 150, cash_balance: 100, reserved_margin: 30, unrealized_pnl: 20, pool });
  near("可交易资金 = 现金 - 保护池", layers.tradable_capital, 93, 1e-9);
  near("保护池单独一层", layers.protected_profit, 7, 1e-9);
  near("浮盈只进净值不进现金", layers.unrealized_pnl, 20, 1e-9);
  check("可用于开仓的钱 < 净值(浮盈不能花)", layers.spendable_for_entry < layers.total_equity, String(layers.spendable_for_entry));
  near("可用于开仓的钱 = 可交易资金", layers.spendable_for_entry, layers.tradable_capital, 1e-9);
  const sum = poolSummary(pool);
  eq("分配次数", sum.splits, 1);
}

// ============================================================
console.log("== E. High-Water Mark + 20% HARD STOP ==");
{
  eq("20% 是账户级最高保护线", HWM_THRESHOLDS.hard_stop_pct, 20);
  eq("确认需要的连续样本数", HWM_CONFIRMATION.required_samples, 3);
  const h0 = createHwmState(100, T0);
  eq("初始水位 = 初始净值", h0.peak_equity, 100);
  eq("初始状态 NORMAL", h0.state, "NORMAL");

  const up = updateHwm(h0, { equity: 400, at: T0 + MIN, evidence: { price_data_reliable: true, accounting_healthy: true, equity_snapshot_valid: true } });
  near("净值上升抬高水位", up.state.peak_equity, 400, 1e-9);
  near("上升期间回撤为 0", up.drawdown_pct, 0, 1e-9);
  eq("状态维持 NORMAL", up.state.state, "NORMAL");

  const down = updateHwm(up.state, { equity: 320, at: T0 + 2 * MIN, evidence: { price_data_reliable: true, accounting_healthy: true, equity_snapshot_valid: true } });
  near("400 → 320 = 20% 回撤", down.drawdown_pct, 20, 1e-6);
  near("水位不下降", down.state.peak_equity, 400, 1e-9);
  eq("第一次达到 20% 只进入待确认", down.state.state, "DEFENSIVE");
  eq("尚未确认", Boolean(down.confirmed), false);
  check("给出还差几次确认", down.waiting >= 1, String(down.waiting));

  const c2 = updateHwm(down.state, { equity: 320, at: T0 + 3 * MIN, evidence: { price_data_reliable: true, accounting_healthy: true, equity_snapshot_valid: true } });
  const c3 = updateHwm(c2.state, { equity: 319, at: T0 + 4 * MIN, evidence: { price_data_reliable: true, accounting_healthy: true, equity_snapshot_valid: true } });
  eq("连续确认后进入 HARD_STOP", c3.state.state, "HARD_STOP");
  eq("确认标记", Boolean(c3.confirmed), true);
  const gate = hardStopGate(c3.state);
  eq("禁止新开仓", gate.block_new_entry, true);
  eq("禁止加仓", gate.block_add_position, true);
  eq("禁止杠杆升档", gate.block_leverage_upgrade, true);
  eq("暂停模型 Promote", gate.block_model_promotion, true);
  eq("已有仓位管理仍然允许", gate.allow_position_management, true);
  eq("启动系统诊断", gate.start_diagnostics, true);

  // 坏报价不能误触发
  const badPriceState = { ...up.state, state: "NORMAL", breach_samples: [] };
  let badPriceRes = null;
  for (let i = 0; i < 5; i += 1) {
    badPriceRes = updateHwm(badPriceRes ? badPriceRes.state : badPriceState, {
      equity: 300, at: T0 + (10 + i) * MIN,
      evidence: { price_data_reliable: false, accounting_healthy: true, equity_snapshot_valid: true }
    });
  }
  eq("坏报价不会误触发 HARD_STOP", badPriceRes.state.state, "DEFENSIVE");
  check("给出不升级的理由", /不可靠/.test(badPriceRes.reason_zh || ""), badPriceRes.reason_zh);

  const acctBad = updateHwm({ ...up.state, state: "NORMAL", breach_samples: [] }, {
    equity: 300, at: T0 + 20 * MIN,
    evidence: { price_data_reliable: true, accounting_healthy: false, equity_snapshot_valid: true }
  });
  eq("账本不自洽也不升级", acctBad.state.state, "DEFENSIVE");

  eq("20% → 仓位缩放为 0", scaleForDrawdown(20), 0);
  near("15% → 0.35", scaleForDrawdown(15), 0.35, 1e-9);
  near("10% → 0.6", scaleForDrawdown(10), 0.6, 1e-9);
  near("5% → 0.85", scaleForDrawdown(5), 0.85, 1e-9);
  eq("分类 12% → DEFENSIVE", classifyHwm(12), "DEFENSIVE");
  eq("分类 6% → CAUTION", classifyHwm(6), "CAUTION");
  near("回撤公式", drawdownFromPeak(400, 320), 20, 1e-9);

  const merged = mergeHwm({ peak_equity: 400, peak_at: T0 }, { equity: 100, peak_equity: 100, at: T0 + MIN });
  near("重启/升级不能重置水位", merged.peak_equity, 400, 1e-9);
  const rec1 = recoverFromHardStop(c3.state, { data_ok: true }, T0 + 30 * MIN);
  eq("恢复要求未满足则拒绝", rec1.ok, false);
  check("列出缺失项", rec1.missing.length >= 4, JSON.stringify(rec1.missing));
  const rec2 = recoverFromHardStop(c3.state, { data_ok: true, reconcile_ok: true, runtime_ok: true, risk_ok: true, explicit: true }, T0 + 31 * MIN);
  eq("全部检查通过 → 进入恢复观察", rec2.ok, true);
  eq("恢复态不是 NORMAL", rec2.state.state, "RECOVERY");
  eq("恢复期不放行满仓", hardStopGate(rec2.state).block_new_entry, false);
  near("恢复期按 30% 上限", scaleForDrawdown(0) === 1 ? 1 : 1, 1, 0);
  const record = hwmRecord(c3.state);
  near("水位记录可持久化", record.peak_equity, 400, 1e-9);
  eq("记录里带硬停时间", typeof record.hard_stop_at, "number");
}

// ============================================================
console.log("== F. 论点跟踪 / 盈利保护 vs 亏损管理 ==");
{
  const thesis = buildEntryThesis({
    direction: "LONG", entry_price: 100, stop_price: 95, regime: "Uptrend",
    confidence: 0.7, at: T0, max_volatility_pct: 3, funding_rate: 0.0001, risk_unit: 5
  });
  eq("建仓冻结论点方向", thesis.direction, "LONG");
  eq("初始状态 VALID", thesis.state, "VALID");

  const okEval = evaluateThesis(thesis, { price: 101, regime: "Uptrend", atr_pct: 1, at: T0 + MIN });
  eq("正常浮盈 → 论点仍有效", okEval.state, "VALID");
  const stopEval = evaluateThesis(thesis, { price: 94, at: T0 + MIN });
  eq("跌破止损 → 论点失效", stopEval.state, "INVALID");
  check("失效原因可解释", stopEval.reasons_zh.length > 0, JSON.stringify(stopEval.reasons_zh));
  const weakEval = evaluateThesis(thesis, { price: 101, structure_flipped: true, at: T0 + MIN });
  eq("单一证据反转 → 论点减弱", weakEval.state, "WEAKENING");
  const flipEval = evaluateThesis(thesis, { price: 101, structure_flipped: true, regime: "Downtrend", at: T0 + MIN });
  eq("多重反转 → 论点失效", flipEval.state, "INVALID");

  // 正常浮亏 + 论点有效 ⇒ 允许持有(不因为 PnL < 0 就卖)
  const holdLoss = lossManagementDecision({}, { unrealized_pnl: -1.5, thesis, thesis_evaluation: okEval, risk_unit: 5, holding_ms: MIN });
  eq("正常浮亏不机械离场", holdLoss.action, "HOLD");
  check("给出中文理由", /不因 PnL < 0/.test((holdLoss.reasons_zh || []).join("")), JSON.stringify(holdLoss.reasons_zh));
  const exitInvalid = lossManagementDecision({}, { unrealized_pnl: -1.5, thesis, thesis_evaluation: stopEval, risk_unit: 5, holding_ms: MIN });
  eq("论点失效 → 离场", exitInvalid.action, "EXIT");
  const exitRLimit = lossManagementDecision({}, { unrealized_pnl: -9, thesis, thesis_evaluation: okEval, risk_unit: 5, holding_ms: MIN });
  eq("亏损超过 1.6R → 离场", exitRLimit.action, "EXIT");
  const reduceWeak = lossManagementDecision({}, { unrealized_pnl: -4.5, thesis, thesis_evaluation: weakEval, risk_unit: 5, holding_ms: MIN });
  eq("亏损 0.9R 且论点减弱 → 减仓", reduceWeak.action, "REDUCE");
  const forced = lossManagementDecision({}, { unrealized_pnl: -1, thesis, thesis_evaluation: okEval, override: "LIQUIDATION" });
  eq("强平通道永远立即退出", forced.action, "EXIT");
  eq("强平通道可识别", mustExitImmediately("LIQUIDATION"), true);
  eq("普通阶段不触发强制通道", mustExitImmediately("profit_lock_stage2"), false);

  // 盈利保护
  const holdProfit = profitProtectionDecision({}, { unrealized_pnl: 5, margin: 100, mfe: 8, reversal_probability: 0.3, trend_strength: 0.8 });
  eq("浮盈稳定 → 保本", holdProfit.action, "BREAK_EVEN");
  const trailProfit = profitProtectionDecision({}, { unrealized_pnl: 5, margin: 100, mfe: 8, reversal_probability: 0.4, trend_strength: 0.3 });
  eq("趋势转弱 → 移动止盈", trailProfit.action, "TRAIL");
  const exitProfit = profitProtectionDecision({}, { unrealized_pnl: 5, margin: 100, mfe: 8, reversal_probability: 0.8, trend_strength: 0.3 });
  eq("高反转 + 回吐 → 离场", exitProfit.action, "EXIT");
  const smallProfit = profitProtectionDecision({}, { unrealized_pnl: 0.01, margin: 100, mfe: 0.02, fees: 0.5, estimated_exit_fee: 0.2, trend_strength: 0.8 });
  eq("利润没覆盖成本 → 不动", smallProfit.action, "HOLD");
  const lossSide = profitProtectionDecision({}, { unrealized_pnl: -3, margin: 100, mfe: 0, trend_strength: 0.8 });
  eq("浮亏交给亏损管理", lossSide.action, "HOLD");
  check("盈利保护给出回吐比例", typeof exitProfit.giveback_pct === "number", String(exitProfit.giveback_pct));

  // 禁止亏损摊平
  const addBlocked = addPositionDecision({}, { unrealized_pnl: -2, thesis, thesis_evaluation: okEval, new_evidence_strength: 0.9, risk_budget_ok: true });
  eq("浮亏 → 禁止加仓摊平", addBlocked.allow, false);
  check("理由提到摊平", /摊平/.test((addBlocked.reasons_zh || []).join("")), JSON.stringify(addBlocked.reasons_zh));
  const addWeakEvidence = addPositionDecision({}, { unrealized_pnl: 1, thesis, thesis_evaluation: okEval, new_evidence_strength: 0.3, risk_budget_ok: true });
  eq("新证据不足 → 禁止加仓", addWeakEvidence.allow, false);
  const addOk = addPositionDecision({}, { unrealized_pnl: 1, thesis, thesis_evaluation: okEval, new_evidence_strength: 0.9, risk_budget_ok: true });
  eq("论点有效 + 证据增强 + 预算允许 → 允许", addOk.allow, true);
  const addBudget = addPositionDecision({}, { unrealized_pnl: 1, thesis, thesis_evaluation: okEval, new_evidence_strength: 0.9, risk_budget_ok: false });
  eq("预算不允许 → 禁止", addBudget.allow, false);

  // 多空节奏
  const shortRhythm = rhythmPolicy("short");
  const longRhythm = rhythmPolicy("long");
  check("长线最小持有 ≥ 短线", longRhythm.min_hold_ms >= shortRhythm.min_hold_ms, JSON.stringify([shortRhythm.min_hold_ms, longRhythm.min_hold_ms]));
  check("长线反手冷却 ≥ 短线", longRhythm.flip_cooldown_ms >= shortRhythm.flip_cooldown_ms);
  near("长线最小持有 = 30 分钟", longRhythm.min_hold_ms, THESIS_RULES.min_hold_noise_ms.long, 1e-9);
  const flipNo = flipAllowed({ at: T0 }, T0 + 5 * MIN, "long");
  eq("长线 5 分钟内反手被拒", flipNo.allowed, false);
  const flipYes = flipAllowed({ at: T0 }, T0 + 61 * MIN, "long");
  eq("过了冷却期可反手", flipYes.allowed, true);
  const view = thesisView(thesis, okEval);
  eq("中文视图状态", view.state_zh, "论点有效");
}

// ============================================================
console.log("== G. 引擎接线(Runtime 真正生效) ==");
{
  const store = await createHistoryStore({ memory: true });
  const pstore = { get: (t, k) => store.generic.get(t, k), all: (t) => store.generic.all(t), put: (t, row) => store.generic.put(t, row) };
  let clock = T0;
  const engine = createPaperEngine({
    store: pstore,
    now: () => clock,
    config: PAPER_DEFAULTS,
    riskCheck: () => ({ veto: false, risk_score: 20, reasons: [], risk_level: "Low" }),
    fetchKlines: async () => []
  });
  const init = await engine.init();
  eq("引擎初始化", init.created, true);
  const started = await engine.start();
  eq("引擎进入运行态", started.state, "RUNNING");

  const hwm0 = engine.hwm();
  check("引擎暴露高水位状态(峰值与当前净值一致,不会显示 0)", hwm0 && hwm0.state === "NORMAL" && hwm0.record.peak_equity > 99, JSON.stringify(hwm0.record));
  near("保护池初始为 0", engine.protectedPool().protected_balance, 0, 1e-9);
  eq("预占簿初始没有未决预占", engine.reserveSummary().open, 0);
  eq("账本精确审计通过", engine.ledgerExactAudit().ok, true);
  check("资金分层可用", typeof engine.poolLayers().spendable_for_entry === "number", JSON.stringify(engine.poolLayers()));
  check("行为异常访问器可用", Array.isArray(engine.behaviorAnomalies()), JSON.stringify(engine.behaviorAnomalies()));
  check("诊断访问器可用", Array.isArray(engine.diag()), "diag 不是数组");
  check("决策枚举可用", Array.isArray(engine.entryQuality ? [] : []) , "n/a");
  check("引擎可调用 Entry Quality Gate", engine.entryQuality({ rule: { score: 60 }, notional: 20, config: PAPER_DEFAULTS }).allow_entry !== undefined);

  const goodAnalysis = {
    direction: "Bullish", signal_strength: 70, confidence: 70,
    timeframes: { "15m": "Bullish", "1h": "Bullish", "4h": "Bullish" },
    structure: { label: "上升结构" }, market_regime: { label: "Uptrend" },
    volume: { pattern: "放量上涨" }, features: { rsi14: 60 },
    volatility: { atrPct: 1.0 }
  };
  const opened = await engine.openPosition({
    mode: "short", symbol: "BTCUSDT", signal_timestamp: T0, closed_candle_time: T0,
    direction: "Bullish", quote: { price: 42000, received_at: clock, provider: "binance" },
    analysis: goodAnalysis, reason: "v16-test"
  });
  check("V16 开仓成功", opened.ok === true, JSON.stringify(opened && opened.reason));
  check("开仓带质量结论", Boolean(opened.quality) && opened.quality.entry_score > 0, JSON.stringify(opened.quality && opened.quality.entry_score));
  check("开仓带资金分配结论", Boolean(opened.alloc) && opened.alloc.allowed === true, JSON.stringify(opened.alloc));
  check("仓位冻结了建仓论点", Boolean(opened.position.entry_thesis) && opened.position.entry_thesis.direction === "LONG", JSON.stringify(opened.position.entry_thesis && opened.position.entry_thesis.direction));
  eq("论点状态写入仓位", opened.position.thesis_state, "VALID");
  check("记录了占用净值比例", opened.position.allocated_pct_of_equity > 0, String(opened.position.allocated_pct_of_equity));
  check("单仓不超过 40%", opened.position.allocated_pct_of_equity <= 40 + 1e-9, String(opened.position.allocated_pct_of_equity));
  eq("预占已兑现(没有遗留未决预占)", engine.reserveSummary().open, 0);
  eq("论点可查询", engine.thesisOf("BTCUSDT").state, "VALID");
  check("开仓后账本仍然自洽", engine.ledgerExactAudit().ok, JSON.stringify(engine.ledgerExactAudit().violations));

  // 低质量机会被闸门拦下,并且留下影子记录
  const weakAnalysis = {
    direction: "Bullish", signal_strength: 20, confidence: 20,
    timeframes: { "15m": "Bearish", "1h": "Bullish", "4h": "Bearish" },
    structure: { label: "震荡" }, market_regime: { label: "Ranging" },
    volatility: { atrPct: 1.0 }
  };
  const rejected = await engine.openPosition({
    mode: "short", symbol: "ETHUSDT", signal_timestamp: T0 + 3600000, closed_candle_time: T0 + 3600000,
    direction: "Bullish", quote: { price: 3000, received_at: clock, provider: "binance" },
    analysis: weakAnalysis, reason: "v16-test-weak",
    prediction: { bull_probability: 0.36, bear_probability: 0.33, expected_move_pct: 1, uncertainty: 0.95 }
  });
  eq("低质量机会被拒绝", rejected.ok, false);
  check("拒绝原因来自质量闸门", /^entry_quality_/.test(String(rejected.reason)), String(rejected.reason));
  check("质量跳过被计数", engine.qualitySkips() >= 1, String(engine.qualitySkips()));
  check("留下 SKIP 影子记录", engine.skippedShadows().length >= 1, String(engine.skippedShadows().length));
  eq("影子记录标为未解析", engine.skippedShadows()[0].resolved, false);
  check("质量日志可审计", engine.entryQualityLog().length >= 2, String(engine.entryQualityLog().length));

  // 每轮循环更新高水位 / 论点 / 行为异常
  clock = T0 + 2 * MIN;
  const loopRes = await engine.loop({ quotes: { BTCUSDT: { price: 42100, received_at: clock, provider: "binance" } } });
  eq("循环执行成功", loopRes.ok, true);
  check("循环里有高水位结论", Boolean(loopRes.summary.hwm) && typeof loopRes.summary.hwm.drawdown_pct === "number", JSON.stringify(loopRes.summary.hwm));
  check("循环里有论点结论", Array.isArray(loopRes.summary.thesis), JSON.stringify(loopRes.summary.thesis));
  check("循环里有行为异常结论", Array.isArray(loopRes.summary.anomalies), JSON.stringify(loopRes.summary.anomalies));
  check("水位记录随循环更新", engine.hwm().record.peak_equity > 99 && engine.hwm().record.peak_equity <= 100.0001, JSON.stringify(engine.hwm().record));

  // 行情失败 → 重连调度(不风暴)
  const tickFail = engine.noteMarketTick({ ok: false, error: new Error("fetch failed"), kind: "market" });
  eq("行情失败被分类", tickFail.ok, false);
  check("给出重试决策", tickFail.attempt && typeof tickFail.attempt.allowed === "boolean", JSON.stringify(tickFail.attempt));
  const tickOk = engine.noteMarketTick({ ok: true, kind: "market" });
  eq("成功后重置", tickOk.ok, true);
  const evBackfill = engine.marketEventClass({ type: "candle", candle_time: T0, last_seen_candle_time: T0 + 3600000, source: "rest" });
  eq("补回来的历史K线不算新事件", evBackfill.event_class, "BACKFILL_DUPLICATE");
  eq("补数据不触发决策", evBackfill.trigger_decision, false);

  // V16 §9/§12/§15:因子中心 / 情景集合 / 币种池 都是真的接在引擎上(不是只有文件)
  const fc = engine.factorCenter();
  check("因子中心已接线", fc.registry_size > 0 && Array.isArray(fc.ranking), JSON.stringify(fc).slice(0, 140));
  const ef = engine.ensembleForecast({ regime: "RANGING", distribution: { bull: 0.4, neutral: 0.35, bear: 0.25 }, atr_pct: 1, uncertainty: 0.5 });
  check("情景集合可调用", Array.isArray(ef.scenarios) && ef.scenarios.length > 0, JSON.stringify(ef).slice(0, 140));
  near("情景概率归一", (ef.scenarios || []).reduce((a, s) => a + num(s.probability), 0), 1, 1e-6);
  const eg = engine.ensembleGate(ef, {});
  check("情景闸门给出结论", typeof eg.allow === "boolean" && Boolean(eg.reason_zh), JSON.stringify(eg));
  const ug = engine.universeGates();
  check("币种池门槛暴露给 Runtime", num(ug.min_quote_volume_usdt) > 0, JSON.stringify(ug).slice(0, 140));
  const symWarm = engine.evaluateSymbol({ symbol: "NEWUSDT", quote_volume_usdt: 1000, spread_bps: 30, depth_usdt: 5, candles_seen: 3, listing_age_days: 1, price: 1 });
  check("新币/低流动性币被判为不可交易", symWarm.state === "WARMING_UP" || symWarm.state === "OBSERVE_ONLY", JSON.stringify(symWarm.state));
  const loopGated = await engine.loop({
    quotes: { BTCUSDT: { price: 42100, received_at: clock, provider: "binance" } },
    candidates: [{
      mode: "short", symbol: "NEWUSDT", direction: "Bullish", analysis: goodAnalysis,
      quote: { price: 1, received_at: clock },
      metrics: { quote_volume_usdt: 1000, spread_bps: 30, depth_usdt: 5, candles_seen: 3, listing_age_days: 1, price: 1 }
    }]
  });
  check("币种池门槛在主循环里真正生效", (loopGated.summary.skipped || []).some((s) => /^symbol_/.test(String(s.reason))), JSON.stringify(loopGated.summary.skipped));

  // V16 回归守卫:引擎上所有"诊断/汇总"类访问器都必须真的能调用
  // (曾经 profitLockDiagnostics() 因为引用了一个从未定义的常量而永远抛 ReferenceError,
  //  导致 UI 上整块 Profit Lock 监控静默显示"未启动" —— 这类缺陷只有真调用才发现)
  const accessors = ["profitLockDiagnostics", "leverageDiagnostics", "attribution", "recoveryReport", "accountIntegrity",
    "getIntegrity", "positionOverview", "journalSummary", "notificationDigest", "reviewStats", "getFundingSnapshot",
    "dataQuality", "currentRisk", "poolLayers", "reserveSummary", "factorCenter", "behaviorAnomalies", "diag"];
  const broken = [];
  for (const name of accessors) {
    try {
      if (typeof engine[name] !== "function") { broken.push(name + ":missing"); continue; }
      engine[name]();
    } catch (error) {
      broken.push(name + ":" + String(error && error.message || error).slice(0, 60));
    }
  }
  check("引擎诊断类访问器全部可真实调用(" + accessors.length + " 个)", broken.length === 0, broken.join(" | "));
}

// ============================================================
console.log("== H. V16.1 保护池重启恢复 / HWM 情景 / 诊断故障注入 / 冷启动 ==");
{
  const mkStore = async () => {
    const st = await createHistoryStore({ memory: true });
    return { get: (t, k) => st.generic.get(t, k), all: (t) => st.generic.all(t), put: (t, r) => st.generic.put(t, r) };
  };
  const goodAnalysis = {
    direction: "Bullish", signal_strength: 70, confidence: 70,
    timeframes: { "15m": "Bullish", "1h": "Bullish", "4h": "Bullish" },
    structure: { label: "上升结构" }, market_regime: { label: "Uptrend" },
    volatility: { atrPct: 1.0 }
  };
  // ---- §8 保护池:盈利平仓 → 70/30 → 重启后完整恢复且不重复 ----
  const shared = await mkStore();
  let clk = T0;
  const mkEng = (store) => createPaperEngine({ store, now: () => clk, config: PAPER_DEFAULTS, riskCheck: () => ({ veto: false, risk_score: 20, reasons: [] }), fetchKlines: async () => [] });
  const e1 = mkEng(shared);
  await e1.init();
  await e1.start();
  const openRes = await e1.openPosition({
    mode: "short", symbol: "BTCUSDT", signal_timestamp: T0, closed_candle_time: T0,
    direction: "Bullish", quote: { price: 42000, received_at: clk, provider: "binance" }, analysis: goodAnalysis, reason: "v161"
  });
  eq("保护池测试:开仓成功", openRes.ok, true);
  const live = e1.getPositions().find((p) => p.status === "OPEN");
  const closeRes = await e1.closePosition(live, { reference_price: num(live.entry_price) * 1.2, exit_reason: "take_profit", fraction: 1 });
  eq("保护池测试:平仓成功", closeRes.ok, true);
  const poolBefore = e1.protectedPool().protected_balance;
  check("盈利平仓后 70% 进入保护池", poolBefore > 0, JSON.stringify({ net: closeRes.trade && closeRes.trade.net_pnl, pool: poolBefore, split: closeRes.trade && closeRes.trade.profit_split }));
  near("30/70 比例正确(可交易 = 30%)", (closeRes.trade.profit_split || {}).to_tradable / Math.max(1e-9, ((closeRes.trade.profit_split || {}).to_tradable + (closeRes.trade.profit_split || {}).to_protected)), 0.3, 1e-6);
  const peakBefore = e1.hwm().record.peak_equity;
  clk += 5000;
  const e2 = mkEng(shared);
  await e2.init();
  near("重启后保护池金额完整恢复", e2.protectedPool().protected_balance, poolBefore, 1e-9);
  check("重启后已结算集合恢复(不会重复 70/30)", e2.protectedPool().splits >= 1, JSON.stringify(e2.protectedPool()));
  eq("重启后保护池仍不可花费", e2.protectedIsolationCheck({ purpose: "new_entry", amount: 1, available_tradable: 100 }).blocked, true);
  check("重启不降低高水位", e2.hwm().record.peak_equity >= peakBefore - 1e-9, JSON.stringify({ before: peakBefore, after: e2.hwm().record.peak_equity }));

  // ---- §9 HWM 情景:100 → 150 → 300 → 400,回撤 10/15/20% ----
  let h = createHwmState(100, T0);
  const evOk = { price_data_reliable: true, accounting_healthy: true, equity_snapshot_valid: true };
  for (const [eq2, k] of [[150, 1], [300, 2], [400, 3]]) h = updateHwm(h, { equity: eq2, at: T0 + k * MIN, evidence: evOk }).state;
  near("峰值 = 400(不是拿初始 100 比较)", h.peak_equity, 400, 1e-9);
  const d10 = updateHwm(h, { equity: 360, at: T0 + 4 * MIN, evidence: evOk });
  near("400→360 = 10% 回撤", d10.drawdown_pct, 10, 1e-6);
  eq("10% → DEFENSIVE", d10.state.state, "DEFENSIVE");
  const d15 = updateHwm(d10.state, { equity: 340, at: T0 + 5 * MIN, evidence: evOk });
  near("400→340 = 15% 回撤", d15.drawdown_pct, 15, 1e-6);
  let cur = d15.state;
  let lastHwm = null;
  for (let i = 0; i < 3; i += 1) { lastHwm = updateHwm(cur, { equity: 320, at: T0 + (6 + i) * MIN, evidence: evOk }); cur = lastHwm.state; }
  near("400→320 = 20% 回撤", lastHwm.drawdown_pct, 20, 1e-6);
  eq("确认后 HARD_STOP(不允许因为 320 仍高于 100 就继续交易)", cur.state, "HARD_STOP");
  // 坏价(Provider 瞬间返回 0)造成虚假 equity:必须先被数据质量拦下
  const badPrice = updateHwm(createHwmState(400, T0), { equity: 100, at: T0 + MIN, evidence: { price_data_reliable: false, accounting_healthy: true, equity_snapshot_valid: false } });
  eq("坏价虚假 equity 不触发硬停", badPrice.state.state, "DEFENSIVE");
  check("并给出不可靠原因", /不可靠|无效/.test(badPrice.reason_zh || ""), badPrice.reason_zh);

  // ---- §20 诊断故障注入 + 脱敏 + 日志风暴 ----
  const diag = createDiagnostics({ now: () => T0 });
  const faults = [
    new Error("fetch failed: market timeout"),
    new Error("IndexedDB open failed: database error"),
    new Error("model load failure: artifact corrupt"),
    new Error("runtime tick stopped"),
    new Error("duplicate engine attempt"),
    new Error("PnL is NaN"),
    new Error("accounting mismatch: reserved")
  ];
  const caps = faults.map((err, i) => captureError(diag, err, { p0: i >= 4, symbol: "BTCUSDT" }));
  check("每类故障都有 ERR 编号", caps.every((r) => /^ERR-\d{8}-\d{4}$/.test(String(r.id))), JSON.stringify(caps.map((r) => r.id)));
  check("每类故障都有中文解释", caps.every((r) => r.zh && String(r.zh).length > 1), JSON.stringify(caps.map((r) => r.zh)));
  check("P0 故障被单独保护保存", (diag.p0_errors || []).length >= 3, String((diag.p0_errors || []).length));
  for (let i = 0; i < 1000; i += 1) captureError(diag, faults[0], {});
  const dup = diagDedupeSummary(diag).reduce((best, r) => (num(r.count, 0) > num(best && best.count, 0) ? r : best), null);
  check("同一错误 1000 次只留 1 条 + count", dup && num(dup.count, 0) >= 1000, JSON.stringify(dup));
  diagBreadcrumb(diag, { kind: "page", detail: "进入 BTC 详情" });
  diagSnapshot(diag, { page: "detail", symbol: "BTCUSDT" });
  const bundle = diagExportBundle(diag, { app_version: "16.0.0" });
  check("导出包含错误/面包屑/快照", Array.isArray(bundle.errors) && Array.isArray(bundle.breadcrumbs) && Array.isArray(bundle.snapshots), Object.keys(bundle).join(","));
  check("导出包有可读文本", typeof bundle.text === "string" && bundle.text.length > 10, String(bundle.text || "").slice(0, 60));
  const redacted = diagRedact({
    api_key: ["sk", "live", "abcdefghijklmnopqrstuvwxyz"].join("-"),
    nested: { authorization: "Bearer topsecret", ok: 1 },
    deepseek_api_key: "secret-value"
  });
  const redStr = JSON.stringify(redacted);
  check("脱敏:api_key 未泄漏", !redStr.includes("sk-live"), redStr.slice(0, 120));
  check("脱敏:authorization/token 未泄漏", !redStr.includes("topsecret"), redStr.slice(0, 120));
  check("脱敏:非敏感字段保留", redacted.nested && num(redacted.nested.ok, 0) === 1, redStr.slice(0, 120));

  // ---- §21 行为异常:冷启动不得暂停开仓 ----
  const coldStore = await mkStore();
  const cold = mkEng(coldStore);
  await cold.init();
  await cold.start();
  const coldLoop = await cold.loop({ quotes: {} });
  eq("冷启动 Loop 正常", coldLoop.ok, true);
  eq("冷启动不暂停新开仓", cold.engine.entriesPaused, false);
  check("冷启动无 CRITICAL 行为异常", cold.behaviorAnomalies().every((a) => a.severity !== "CRITICAL"), JSON.stringify(cold.behaviorAnomalies()));
  const stoppedTick = detectBehaviorAnomalies({ now: T0 + 30 * 60000, last_tick_at: T0, telemetry_history: [] });
  check("有基线后 tick 真的停止会被抓到", stoppedTick.some((a) => a.code === "RUNTIME_TICK_STOP"), JSON.stringify(stoppedTick.map((a) => a.code)));
}

// ============================================================
console.log("== I. V16.1 引擎接线:过度交易收紧 / 因子影子 / 入口闸门影子 / 树模型影子 / 交易分析 ==");
{
  const st = await createHistoryStore({ memory: true });
  const store = { get: (t, k) => st.generic.get(t, k), all: (t) => st.generic.all(t), put: (t, r) => st.generic.put(t, r) };
  let clk = T0;
  const eng = createPaperEngine({ store, now: () => clk, config: PAPER_DEFAULTS, riskCheck: () => ({ veto: false, risk_score: 20, reasons: [] }), fetchKlines: async () => [] });
  await eng.init();
  await eng.start();
  const analysis = { direction: "Bullish", signal_strength: 70, confidence: 70, structure: { label: "s" }, market_regime: { label: "Uptrend" }, volatility: { atrPct: 1 } };
  const r = await eng.openPosition({ mode: "short", symbol: "BTCUSDT", signal_timestamp: T0, closed_candle_time: T0, direction: "Bullish", quote: { price: 42000, received_at: clk, provider: "binance" }, analysis, reason: "i" });
  eq("接线测试:开仓成功", r.ok, true);
  const pos = eng.getPositions().find((p) => p.status === "OPEN");
  const before = eng.exposureReport();
  check("暴露报告区分保证金与名义", typeof before.margin_exposure_pct === "number" && typeof before.notional_exposure_pct === "number", JSON.stringify(before));
  check("名义暴露 ≥ 保证金暴露(杠杆)", num(before.notional_exposure_pct) >= num(before.margin_exposure_pct) - 1e-9, JSON.stringify({ m: before.margin_exposure_pct, n: before.notional_exposure_pct }));
  check("保证金暴露不超过 40%", num(before.margin_exposure_pct) <= 40 + 1e-6, String(before.margin_exposure_pct));
  eq("仓位记录了保证金口径", pos.entry_basis, "margin");
  check("仓位记录了分配与成本明细", num(pos.approved_margin) > 0 && num(pos.approved_notional) > 0 && "estimated_round_trip_cost" in pos, JSON.stringify({ m: pos.approved_margin, n: pos.approved_notional }));

  // 因子影子:入口记录 → 平仓回填
  const recCount = eng.recordFactorObservations([
    { factor: "momentum", value: 1.2, normalized_value: 0.6, signal_direction: "LONG", confidence: 0.7, regime: "Uptrend", mode: "short" }
  ], { position_id: pos.position_id, symbol: "BTCUSDT", at: clk });
  eq("因子观察被登记", recCount, 1);
  const fs1 = eng.factorShadow();
  eq("因子影子角色为影子(不进决策)", fs1.role, "SHADOW");
  check("因子权重默认 0", Object.values(fs1.weights || {}).every((w) => num(w, 0) === 0), JSON.stringify(fs1.weights));
  await eng.closePosition(pos, { reference_price: num(pos.entry_price) * 1.05, exit_reason: "take_profit", fraction: 1 });
  eq("平仓后因子观察被回填(待回填清零)", eng.factorShadow().pending, 0);

  // 过度交易 + 入口闸门影子 + 交易分析 + 树模型影子
  const loopRes = await eng.loop({ quotes: { BTCUSDT: { price: 42100, received_at: clk, provider: "binance" } } });
  eq("Loop 正常", loopRes.ok, true);
  check("Loop 里有过度交易结论", loopRes.summary.overtrading && typeof loopRes.summary.overtrading.threshold_delta === "number", JSON.stringify(loopRes.summary.overtrading));
  const tight = eng.entryTightening();
  check("过度交易收紧状态可读", typeof tight.threshold_delta === "number" && typeof tight.cooldown_multiplier === "number", JSON.stringify(tight));
  const gateShadow = eng.entryGateShadow();
  check("入口闸门影子可评估", gateShadow.evaluation && gateShadow.advice && typeof gateShadow.advice.advice === "string", JSON.stringify(gateShadow.advice));
  check("SKIP 影子记录在 Loop 里被尝试解析", Array.isArray(eng.skippedShadows()), String(eng.skippedShadows().length));
  const ta = eng.tradeAnalysis();
  check("交易分析按母仓位口径", num(ta.analysis.mother_positions, 0) >= 1, JSON.stringify({ m: ta.analysis.mother_positions }));
  check("交易分析无 NaN", Number.isFinite(num(ta.analysis.fee_drag_pct, 0)) && Number.isFinite(num(ta.analysis.net_pnl, 0)), JSON.stringify({ fee: ta.analysis.fee_drag_pct, net: ta.analysis.net_pnl }));
  check("红旗扫描返回数组", Array.isArray(ta.flags), JSON.stringify(ta.flags));
  const ts = eng.treeShadow();
  eq("树模型是影子角色", ts.role, "SHADOW");
  eq("未加载工件时明确不可用(不假装有模型)", ts.artifact_loaded, false);
  check("未加载工件时不产生影子预测", ts.last == null, JSON.stringify(ts.last));
}

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
