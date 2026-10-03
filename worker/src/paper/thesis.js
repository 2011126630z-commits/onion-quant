// paper/thesis.js · V16 §6/§7 · 论点跟踪 + 盈利保护/亏损管理分离(纯函数,无 I/O)
// 要解决的问题:"盈利时不跑、亏损时乱跑" —— PnL < 0 本身不是退出信号,盈利也不是无限持有。
//   Profit Protection:根据 PnL / MFE / 回吐 / 趋势强度 / 反转概率 / 波动 / 持有时间 / 费用
//                      → HOLD / PARTIAL_CLOSE / TRAIL / BREAK_EVEN / EXIT
//   Loss Management:  根据原始 Thesis / 趋势结构 / MAE / 波动 / Regime / 时间 / 反转概率 / 风险预算
//                      → HOLD / REDUCE / EXIT
//   Thesis 状态:VALID / WEAKENING / INVALID —— 正常浮亏 + Thesis 仍有效 ⇒ 允许 HOLD。
//   与快慢无关的硬通道:STOP LOSS / HARD RISK / LIQUIDATION / DATA SAFETY 永远可以立即退出。
export const THESIS_VERSION = "thesis-v1.0";
export const THESIS_STATES = ["VALID", "WEAKENING", "INVALID"];
export const THESIS_STATE_ZH = { VALID: "论点有效", WEAKENING: "论点减弱", INVALID: "论点失效" };

export const THESIS_INVALIDATION_KINDS = [
  "STOP_BREACH", "STRUCTURE_FLIP", "REGIME_FLIP", "VOLATILITY_EXPANSION",
  "FUNDING_FLIP", "EXTERNAL_SHOCK", "TIME_EXPIRED"
];
export const THESIS_INVALIDATION_ZH = {
  STOP_BREACH: "跌破止损", STRUCTURE_FLIP: "结构反转", REGIME_FLIP: "市场环境反转",
  VOLATILITY_EXPANSION: "波动突然放大", FUNDING_FLIP: "资金费率反向", EXTERNAL_SHOCK: "外部冲击",
  TIME_EXPIRED: "论点时间窗过期"
};

export const PROTECTION_ACTIONS = ["HOLD", "PARTIAL_CLOSE", "TRAIL", "BREAK_EVEN", "EXIT"];
export const PROTECTION_ZH = { HOLD: "继续持有", PARTIAL_CLOSE: "部分止盈", TRAIL: "移动止盈", BREAK_EVEN: "保本", EXIT: "离场" };
export const LOSS_ACTIONS = ["HOLD", "REDUCE", "EXIT"];
export const LOSS_ZH = { HOLD: "继续持有", REDUCE: "减仓", EXIT: "离场" };

// 与"快慢节奏"无关的强制退出通道(任何节奏策略都不能阻止)
export const IMMEDIATE_EXIT_OVERRIDES = ["STOP_LOSS", "HARD_RISK", "LIQUIDATION", "DATA_SAFETY"];
export const IMMEDIATE_EXIT_ZH = {
  STOP_LOSS: "触发止损", HARD_RISK: "硬风险", LIQUIDATION: "强平", DATA_SAFETY: "数据安全"
};

export const THESIS_RULES = {
  giveback_warn_pct: 25,      // 回吐 MFE 的 25% → 提醒
  giveback_critical_pct: 45,  // 回吐 45% → 收紧或部分离场
  reversal_exit_probability: 0.68,
  profit_trail_trigger_pct: 1.2,
  loss_hard_exit_r: 1.6,      // 亏损超过 1.6R 且 Thesis 失效 → 离场
  loss_reduce_r: 0.8,
  min_hold_noise_ms: { short: 5 * 60000, long: 30 * 60000 },
  flip_cooldown_ms: { short: 10 * 60000, long: 60 * 60000 }
};

function tnum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}
function tclamp(v, lo, hi) { return Math.min(hi, Math.max(lo, tnum(v, lo))); }

// 建仓时冻结论点(§10 Entry Snapshot:以后禁止用未来信息重算 Entry 状态)
export function buildEntryThesis(input) {
  const o = input || {};
  const dir = String(o.direction || "LONG").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
  return {
    version: THESIS_VERSION,
    direction: dir,
    reasons: (o.reasons || []).slice(),
    reason_zh: o.reason_zh || (dir === "SHORT" ? "做空论点" : "做多论点"),
    entry_price: tnum(o.entry_price, 0),
    entry_regime: o.regime || null,
    entry_structure: o.structure || null,
    entry_funding: o.funding_rate == null ? null : tnum(o.funding_rate),
    confidence: tclamp(o.confidence, 0, 1),
    invalidation: {
      stop_price: o.stop_price == null ? null : tnum(o.stop_price),
      structure_level: o.structure_level == null ? null : tnum(o.structure_level),
      regime_allowed: o.regime || null,
      max_volatility_pct: o.max_volatility_pct == null ? null : tnum(o.max_volatility_pct),
      funding_sign: o.funding_rate == null ? null : (tnum(o.funding_rate) >= 0 ? "POSITIVE" : "NEGATIVE")
    },
    risk_unit: o.risk_unit == null ? null : tnum(o.risk_unit),
    at: tnum(o.at, 0),
    expires_at: o.expires_at == null ? null : tnum(o.expires_at),
    state: "VALID",
    evaluations: 0,
    last_evaluation: null
  };
}

// 论点评估:只看"建仓时写下的失效条件有没有被打破",不看浮盈浮亏
export function evaluateThesis(thesis, ctx) {
  const t = thesis || {};
  const c = ctx || {};
  const violations = [];
  const reasons = [];
  const dir = t.direction === "SHORT" ? "SHORT" : "LONG";
  const price = tnum(c.price, null);
  const inv = t.invalidation || {};

  if (price != null && inv.stop_price != null && inv.stop_price > 0) {
    const breached = dir === "LONG" ? price <= inv.stop_price : price >= inv.stop_price;
    if (breached) violations.push("STOP_BREACH");
  }
  if (c.structure_flipped === true) violations.push("STRUCTURE_FLIP");
  if (c.regime && inv.regime_allowed && c.regime !== inv.regime_allowed) violations.push("REGIME_FLIP");
  if (c.atr_pct != null && inv.max_volatility_pct != null && tnum(c.atr_pct) > tnum(inv.max_volatility_pct)) {
    violations.push("VOLATILITY_EXPANSION");
  }
  if (c.funding_sign && inv.funding_sign && c.funding_sign !== inv.funding_sign) violations.push("FUNDING_FLIP");
  if (c.external_shock === true) violations.push("EXTERNAL_SHOCK");
  if (t.expires_at != null && tnum(c.at, 0) > tnum(t.expires_at)) violations.push("TIME_EXPIRED");

  let state = "VALID";
  if (violations.length >= 2 || violations.includes("STOP_BREACH")) state = "INVALID";
  else if (violations.length === 1) state = "WEAKENING";
  // 论点证据减弱(不是硬失效):趋势强度下滑 / 反转概率上升
  else if (tnum(c.trend_strength, 1) < 0.35 || tnum(c.reversal_probability, 0) > 0.6) state = "WEAKENING";

  for (const v of violations) reasons.push(THESIS_INVALIDATION_ZH[v] || v);
  if (state === "WEAKENING" && !reasons.length) reasons.push("趋势支撑减弱");
  return {
    state: state,
    state_zh: THESIS_STATE_ZH[state],
    changed: state !== (t.state || "VALID"),
    violations: violations,
    reasons_zh: reasons,
    checked_at: tnum(c.at, 0)
  };
}

// 盈利保护:目标是把已经赚到的钱保护下来,而不是把仓位切碎
export function profitProtectionDecision(position, ctx) {
  const p = position || {};
  const c = ctx || {};
  const rules = { ...THESIS_RULES, ...(c.rules || {}) };
  const pnl = tnum(c.unrealized_pnl, tnum(p.unrealized_pnl, 0));
  const margin = Math.max(0, tnum(c.margin, tnum(p.remaining_margin, tnum(p.entry_notional, 0))));
  const pnlPct = margin > 0 ? pnl / margin * 100 : 0;
  const mfe = tnum(c.mfe, tnum(p.mfe, 0));
  const giveback = mfe > 0 ? (mfe - Math.max(pnl, 0)) / mfe * 100 : 0;
  const reversal = tclamp(c.reversal_probability, 0, 1);
  const trend = tclamp(c.trend_strength, 0, 1);
  const fees = Math.max(0, tnum(p.fees, 0));
  const roundTripCost = fees + tnum(c.estimated_exit_fee, 0);
  const actions = [];
  const reasons = [];

  if (pnl <= 0) {
    return {
      action: "HOLD", action_zh: PROTECTION_ZH.HOLD, pnl_pct: pnlPct,
      giveback_pct: giveback, reasons_zh: ["当前没有可保护的利润(未实现盈亏 ≤ 0),交给亏损管理"],
      factors: { mfe: mfe, reversal_probability: reversal, trend_strength: trend, round_trip_cost: roundTripCost }
    };
  }
  // 赚的还没覆盖成本 → 不动(避免为了"有动作"而付两次手续费)
  if (pnl < roundTripCost) {
    return {
      action: "HOLD", action_zh: PROTECTION_ZH.HOLD, pnl_pct: pnlPct, giveback_pct: giveback,
      reasons_zh: ["利润尚未覆盖往返成本,继续持有"],
      factors: { mfe: mfe, round_trip_cost: roundTripCost, reversal_probability: reversal, trend_strength: trend }
    };
  }
  if (reversal >= rules.reversal_exit_probability && giveback >= rules.giveback_warn_pct) {
    actions.push("EXIT"); reasons.push("反转概率高且已回吐 " + Math.round(giveback) + "% 浮盈");
  } else if (giveback >= rules.giveback_critical_pct) {
    actions.push("PARTIAL_CLOSE"); reasons.push("回吐达到 " + Math.round(giveback) + "%,先锁定一部分");
  } else if (giveback >= rules.giveback_warn_pct && trend < 0.5) {
    actions.push("TRAIL"); reasons.push("趋势转弱,收紧移动止盈");
  }
  if (!actions.length && pnlPct >= rules.profit_trail_trigger_pct && trend >= 0.6) {
    actions.push("BREAK_EVEN"); reasons.push("已有浮盈,把止损抬到保本");
  }
  const action = actions[0] || "HOLD";
  if (action === "HOLD") reasons.push("浮盈稳定,不为了动作而动作");
  return {
    action: action,
    action_zh: PROTECTION_ZH[action],
    pnl_pct: pnlPct,
    giveback_pct: giveback,
    reasons_zh: reasons,
    factors: { mfe: mfe, reversal_probability: reversal, trend_strength: trend, round_trip_cost: roundTripCost }
  };
}

// 亏损管理:PnL < 0 → 卖出 是错的。先看论点是否还成立
export function lossManagementDecision(position, ctx) {
  const p = position || {};
  const c = ctx || {};
  const rules = { ...THESIS_RULES, ...(c.rules || {}) };
  const thesis = c.thesis || p.entry_thesis || null;
  const evaluation = c.thesis_evaluation || (thesis ? evaluateThesis(thesis, c) : { state: "VALID", reasons_zh: [] });
  const pnl = tnum(c.unrealized_pnl, tnum(p.unrealized_pnl, 0));
  const riskUnit = Math.max(0, tnum(c.risk_unit, tnum(thesis && thesis.risk_unit, 0)));
  const rMultiple = riskUnit > 0 ? -pnl / riskUnit : 0;
  const holdMs = Math.max(0, tnum(c.holding_ms, 0));
  const maxtime = tnum(c.max_hold_ms, 0);

  // 硬通道:任何节奏都要让路
  const override = String(c.override || "").toUpperCase();
  if (IMMEDIATE_EXIT_OVERRIDES.includes(override)) {
    return {
      action: "EXIT", action_zh: LOSS_ZH.EXIT, override: override,
      reasons_zh: ["强制退出通道:" + (IMMEDIATE_EXIT_ZH[override] || override)],
      r_multiple: rMultiple, thesis_state: evaluation.state
    };
  }
  if (evaluation.state === "INVALID") {
    return {
      action: "EXIT", action_zh: LOSS_ZH.EXIT,
      reasons_zh: ["论点已失效:" + (evaluation.reasons_zh || []).join("、")],
      r_multiple: rMultiple, thesis_state: evaluation.state
    };
  }
  if (rMultiple >= rules.loss_hard_exit_r) {
    return {
      action: "EXIT", action_zh: LOSS_ZH.EXIT,
      reasons_zh: ["亏损达到 " + rMultiple.toFixed(2) + "R,超出风险预算"],
      r_multiple: rMultiple, thesis_state: evaluation.state
    };
  }
  if (rMultiple >= rules.loss_reduce_r && evaluation.state === "WEAKENING") {
    return {
      action: "REDUCE", action_zh: LOSS_ZH.REDUCE,
      reasons_zh: ["亏损 " + rMultiple.toFixed(2) + "R 且论点减弱,先减仓"],
      r_multiple: rMultiple, thesis_state: evaluation.state
    };
  }
  if (maxtime > 0 && holdMs > maxtime) {
    return {
      action: "EXIT", action_zh: LOSS_ZH.EXIT,
      reasons_zh: ["持有时间超过该周期上限,论点未兑现"],
      r_multiple: rMultiple, thesis_state: evaluation.state
    };
  }
  return {
    action: "HOLD", action_zh: LOSS_ZH.HOLD,
    reasons_zh: [
      "正常浮亏且论点仍" + (THESIS_STATE_ZH[evaluation.state] || "有效") + ",不因 PnL < 0 机械离场"
    ],
    r_multiple: rMultiple, thesis_state: evaluation.state
  };
}

// 多空节奏:Short 允许更快响应;Long 不能因为几分钟噪声 OPEN/CLOSE/OPEN/CLOSE
export function rhythmPolicy(mode) {
  const m = String(mode || "short").toLowerCase() === "long" ? "long" : "short";
  return {
    mode: m,
    min_hold_ms: tnum(THESIS_RULES.min_hold_noise_ms[m], 0),
    flip_cooldown_ms: tnum(THESIS_RULES.flip_cooldown_ms[m], 0),
    allow_fast_response: m === "short",
    reason_zh: m === "short" ? "短线允许更快响应,但仍需最小持有间隔" : "长线不允许被分钟级噪声打断"
  };
}

// §5 禁止亏损摊平:加仓必须同时满足"原论点仍有效 + 新证据明显增强 + 风险预算允许"
export const ADD_POSITION_MIN_EVIDENCE = 0.65;

export function addPositionDecision(position, ctx) {
  const p = position || {};
  const c = ctx || {};
  const thesis = c.thesis || p.entry_thesis || null;
  const ev = c.thesis_evaluation || (thesis ? evaluateThesis(thesis, c) : { state: "VALID", reasons_zh: [] });
  const pnl = tnum(c.unrealized_pnl, 0);
  const evidence = tclamp(c.new_evidence_strength, 0, 1);
  const budgetOk = c.risk_budget_ok !== false;
  const reasons = [];
  let allow = true;
  if (pnl < 0) { allow = false; reasons.push("当前为浮亏仓位 → 禁止加仓摊平成本"); }
  if (ev.state !== "VALID") { allow = false; reasons.push("原始论点不再" + (THESIS_STATE_ZH[ev.state] || ev.state)); }
  if (evidence < ADD_POSITION_MIN_EVIDENCE) { allow = false; reasons.push("新证据强度不足(" + Math.round(evidence * 100) + "% < " + Math.round(ADD_POSITION_MIN_EVIDENCE * 100) + "%)"); }
  if (!budgetOk) { allow = false; reasons.push("风险预算不允许"); }
  if (allow) reasons.push("原论点仍有效 + 新证据明显增强 + 风险预算允许 → 允许加仓");
  return {
    allow: allow,
    action: allow ? "ADD" : "NO_ADD",
    action_zh: allow ? "允许加仓" : "禁止加仓",
    reasons_zh: reasons,
    thesis_state: ev.state,
    evidence_strength: evidence
  };
}

// 反转入场闸门:在冷却期内禁止同 symbol 反向再开(防 OPEN/CLOSE/OPEN/CLOSE 循环)
export function flipAllowed(lastClose, now, mode, opts) {
  const policy = rhythmPolicy(mode);
  const cooldown = tnum(opts && opts.cooldown_ms, policy.flip_cooldown_ms);
  if (!lastClose || lastClose.at == null) return { allowed: true, reason_zh: "无最近平仓记录" };
  const elapsed = tnum(now, 0) - tnum(lastClose.at, 0);
  if (elapsed >= cooldown) return { allowed: true, reason_zh: "已过冷却期" };
  return {
    allowed: false,
    remaining_ms: cooldown - elapsed,
    reason_zh: "反手冷却中(还需 " + Math.ceil((cooldown - elapsed) / 60000) + " 分钟)"
  };
}

// 命中硬通道时,最小持有间隔必须让路
export function mustExitImmediately(reason) {
  return IMMEDIATE_EXIT_OVERRIDES.includes(String(reason || "").toUpperCase());
}

// 仓位上的论点快照(随仓位持久化;§10 Entry Snapshot 的一部分)
export function thesisSnapshot(thesis, evaluation) {
  if (!thesis) return null;
  return {
    version: THESIS_VERSION,
    direction: thesis.direction,
    reason_zh: thesis.reason_zh,
    entry_price: thesis.entry_price,
    entry_regime: thesis.entry_regime,
    confidence: thesis.confidence,
    state: (evaluation && evaluation.state) || thesis.state || "VALID",
    at: thesis.at
  };
}

export function thesisView(thesis, evaluation) {
  if (!thesis) return null;
  const ev = evaluation || { state: thesis.state || "VALID", reasons_zh: [] };
  return {
    direction_zh: thesis.direction === "SHORT" ? "做空" : "做多",
    reason_zh: thesis.reason_zh,
    state: ev.state,
    state_zh: THESIS_STATE_ZH[ev.state] || ev.state,
    reasons_zh: ev.reasons_zh || [],
    confidence_pct: Math.round(tnum(thesis.confidence) * 100)
  };
}
