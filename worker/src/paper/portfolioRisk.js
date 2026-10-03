// paper/portfolioRisk.js · Portfolio Risk Controller(统一风险口径 + 最终 Veto)
// 目的:账户风险/分池风险/单币暴露/杠杆暴露/回撤/保证金占用/当日亏损 只在这里汇成一份结论,
//      其他模块(引擎入口、UI、杠杆选择)只能读它,不允许各算一套 Risk。
// 输出固定字段:risk_level / risk_budget_pct / max_position_size / max_leverage /
//              allow_new_entry / allow_add_position / veto_reasons
import { PAPER_DEFAULTS, num, round, sideOf, openMarginOf } from "./accounting.js";

export const RISK_LEVELS = ["NORMAL", "CAUTION", "DEFENSIVE", "HARD_STOP"];
export const RISK_RANK = { NORMAL: 0, CAUTION: 1, DEFENSIVE: 2, HARD_STOP: 3 };

// 阈值集中在常量里,便于审阅与测试(不散落在业务代码中)
export const RISK_THRESHOLDS = {
  caution_daily_loss_pct: 3,
  defensive_daily_loss_pct: 6,
  hard_stop_daily_loss_pct: 10,
  caution_drawdown_pct: 10,
  defensive_drawdown_pct: 20,
  hard_stop_drawdown_pct: 30,
  caution_margin_usage_pct: 60,
  defensive_margin_usage_pct: 75,
  hard_stop_margin_usage_pct: 90,
  symbol_exposure_cap_pct: 35,
  max_leverage: { NORMAL: 5, CAUTION: 3, DEFENSIVE: 2, HARD_STOP: 1 },
  risk_budget_pct: { NORMAL: 15, CAUTION: 10, DEFENSIVE: 6, HARD_STOP: 0 },
  recovery_step_pct: 4
};

function worst(levelA, levelB) {
  return RISK_RANK[levelA] >= RISK_RANK[levelB] ? levelA : levelB;
}

// 核心:输入全部可选(未接线的模块不影响判定),输出永远是一份完整结论
export function portfolioRisk(input) {
  const i = input || {};
  const cfg = { ...PAPER_DEFAULTS, ...(i.config || {}) };
  const T = RISK_THRESHOLDS;
  const account = i.account || {};
  const wallets = i.wallets || {};
  const positions = (i.positions || []).filter((p) => p.status === "OPEN");
  const equity = num(account.total_equity, num(account.initial_balance, 0));
  const dailyLossPct = Math.abs(Math.min(0, num(i.daily_pnl_pct, 0)));
  // drawdown_pct 语义 = 【当前回撤】(峰值→现在)。历史最深回撤只能作为参考,不能当判定条件,
  // 否则一次深回撤会让风控永久停在 HARD_STOP。
  const drawdownPct = num(i.drawdown_pct, 0);

  let reserved = 0;
  let unrealized = 0;
  const symbolExposure = {};
  const leverageExposure = {};
  for (const p of positions) {
    const margin = openMarginOf(p);
    const notional = margin * Math.max(1, num(p.leverage, 1));
    reserved += margin;
    unrealized += num(p.unrealized_pnl, 0);
    const sym = String(p.symbol || "-");
    symbolExposure[sym] = round(num(symbolExposure[sym], 0) + notional, 8);
    const lv = String(Math.max(1, Math.round(num(p.leverage, 1))));
    leverageExposure[lv] = round(num(leverageExposure[lv], 0) + notional, 8);
  }
  // 保证金占用 = 已锁定保证金 / 权益(逐仓模型下这是最直观的"用量")
  const marginUsagePct = equity > 0 ? round(reserved / equity * 100, 4) : 0;

  let level = "NORMAL";
  const reasons = [];
  if (dailyLossPct >= T.hard_stop_daily_loss_pct) { level = worst(level, "HARD_STOP"); reasons.push("daily_loss_hard_stop"); }
  else if (dailyLossPct >= T.defensive_daily_loss_pct) { level = worst(level, "DEFENSIVE"); reasons.push("daily_loss_defensive"); }
  else if (dailyLossPct >= T.caution_daily_loss_pct) { level = worst(level, "CAUTION"); reasons.push("daily_loss_caution"); }
  if (drawdownPct >= T.hard_stop_drawdown_pct) { level = worst(level, "HARD_STOP"); reasons.push("drawdown_hard_stop"); }
  else if (drawdownPct >= T.defensive_drawdown_pct) { level = worst(level, "DEFENSIVE"); reasons.push("drawdown_defensive"); }
  else if (drawdownPct >= T.caution_drawdown_pct) { level = worst(level, "CAUTION"); reasons.push("drawdown_caution"); }
  if (marginUsagePct >= T.hard_stop_margin_usage_pct) { level = worst(level, "HARD_STOP"); reasons.push("margin_usage_hard_stop"); }
  else if (marginUsagePct >= T.defensive_margin_usage_pct) { level = worst(level, "DEFENSIVE"); reasons.push("margin_usage_defensive"); }
  else if (marginUsagePct >= T.caution_margin_usage_pct) { level = worst(level, "CAUTION"); reasons.push("margin_usage_caution"); }

  // 回撤控制器(若已接线)只能收紧,不能放宽
  const ddState = String((i.drawdown && i.drawdown.state) || "").toUpperCase();
  if (RISK_LEVELS.includes(ddState)) { level = worst(level, ddState); reasons.push("drawdown_controller:" + ddState); }
  if (i.drawdown && i.drawdown.actions && i.drawdown.actions.allow_new_positions === false) reasons.push("drawdown_blocks_new_positions");

  // 数据完整性 / 数据质量 / 外部风控:任一异常直接禁新开仓(但不影响已有持仓的风险管理)
  const integrity = i.integrity || {};
  const integrityBad = num(integrity.price_symbol_mismatch, 0) > 0 || num(integrity.impossible_pnl, 0) > 0 || num(integrity.invalid_price, 0) > 0;
  const dq = i.data_quality || {};
  const dqBad = dq.ok === false || dq.block_entries === true;
  const extBad = Boolean(i.external_gate && i.external_gate.allow === false);
  const paused = i.entries_paused === true;

  const allowNewEntry = !(integrityBad || dqBad || extBad || paused
    || level === "HARD_STOP"
    || (i.drawdown && i.drawdown.actions && i.drawdown.actions.allow_new_positions === false));
  const allowAddPosition = allowNewEntry && RISK_RANK[level] < RISK_RANK.DEFENSIVE;

  // 单币暴露检查:超限只影响该 symbol 的新开仓(通过 notes 暴露给调用方)
  const exposureViolations = [];
  for (const [sym, notional] of Object.entries(symbolExposure)) {
    const pct = equity > 0 ? round(notional / equity * 100, 4) : 0;
    if (pct > T.symbol_exposure_cap_pct) exposureViolations.push({ symbol: sym, exposure_pct: pct });
  }

  const maxLeverage = T.max_leverage[level];
  return {
    risk_level: level,
    risk_rank: RISK_RANK[level],
    risk_budget_pct: T.risk_budget_pct[level],
    max_position_size: round(equity * T.risk_budget_pct[level] / 100, 8),
    max_leverage: maxLeverage,
    allow_new_entry: allowNewEntry,
    allow_add_position: allowAddPosition,
    equity: round(equity, 8),
    reserved_margin: round(reserved, 8),
    unrealized_pnl: round(unrealized, 8),
    margin_usage_pct: marginUsagePct,
    daily_loss_pct: round(dailyLossPct, 4),
    drawdown_pct: round(drawdownPct, 4),
    symbol_exposure: symbolExposure,
    leverage_exposure: leverageExposure,
    exposure_violations: exposureViolations,
    veto_reasons: [
      ...reasons,
      ...(integrityBad ? ["data_integrity"] : []),
      ...(dqBad ? ["data_quality"] : []),
      ...(extBad ? ["external_gate"] : []),
      ...(paused ? ["entries_paused"] : [])
    ],
    notes: [
      "逐仓模型:单笔最大亏损 = 保证金 + 往返费用",
      "风险等级越差,风险预算与杠杆上限越低(不会自动跳回高杠杆)"
    ]
  };
}

// 单笔候选是否放行(供引擎在开仓前调用;symbol 级暴露在这里裁决)
export function riskVetoForCandidate(candidate, risk) {
  const r = risk || {};
  const c = candidate || {};
  const reasons = [];
  if (r.allow_new_entry === false) reasons.push(...(r.veto_reasons && r.veto_reasons.length ? r.veto_reasons : ["risk_blocked"]));
  const sym = String(c.symbol || "-");
  const violation = (r.exposure_violations || []).find((v) => v.symbol === sym);
  if (violation) reasons.push("symbol_exposure_cap:" + violation.exposure_pct + "%");
  const wantLev = num(c.leverage, 1);
  const maxLev = num(r.max_leverage, 1);
  if (wantLev > maxLev) reasons.push("leverage_above_risk_cap:" + wantLev + ">" + maxLev);
  const wantSize = num(c.notional, num(c.margin, 0));
  if (num(r.max_position_size, 0) > 0 && wantSize > num(r.max_position_size, 0)) reasons.push("size_above_risk_budget");
  return { allow: reasons.length === 0, reasons, capped_leverage: Math.max(1, Math.min(wantLev, maxLev)) };
}
