// paper/positionManager.js · Position Manager(持仓生命周期唯一状态机)
// 目的:把 OPEN/ADD/PARTIAL_CLOSE/FULL_CLOSE/STOP/TP/TRAIL/BREAK_EVEN/LIQUIDATION/MANUAL_CLOSE
//      的动作语义、合法性校验与审计集中到一处,页面与引擎不再各自拼平仓逻辑。
// 说明:本模块只做"状态与动作"判定,不重复实现会计数学(仍走 accounting/futures)。
import { num, numOrNull, round, sideOf, openQuantityOf, openMarginOf } from "./accounting.js";

export const POSITION_STATES = ["OPEN", "CLOSING", "CLOSED", "INVALID"];
export const POSITION_ACTIONS = [
  "OPEN", "ADD", "HOLD", "PARTIAL_CLOSE", "FULL_CLOSE",
  "STOP", "TAKE_PROFIT", "TRAIL", "BREAK_EVEN", "LIQUIDATION", "MANUAL_CLOSE"
];
export const ACTION_SOURCE = ["AUTO", "MANUAL", "RISK", "RECOVERY", "MIGRATION"];

// 退出原因 → 动作(唯一映射,UI/Journal/学习样本共用)
export function classifyCloseAction(exitReason) {
  const r = String(exitReason || "").toUpperCase();
  if (r.includes("LIQUIDATION")) return "LIQUIDATION";
  if (r.startsWith("MANUAL")) return "MANUAL_CLOSE";
  if (r === "STOP_LOSS") return "STOP";
  if (r === "TAKE_PROFIT") return "TAKE_PROFIT";
  if (r.startsWith("PARTIAL_TAKE_PROFIT")) return "TAKE_PROFIT";
  if (r.includes("PROFIT_LOCK")) return "TRAIL";
  if (r.includes("BREAK_EVEN")) return "BREAK_EVEN";
  return "FULL_CLOSE";
}

export function isTerminal(position) {
  const s = String((position && position.status) || "").toUpperCase();
  return s === "CLOSED" || s === "INVALID";
}

// 动作前置校验:终态不可再动;部分平仓必须有剩余量;加仓不允许在暂停期发生
export function canAct(position, action, ctx) {
  const a = String(action || "").toUpperCase();
  const c = ctx || {};
  if (!POSITION_ACTIONS.includes(a)) return { ok: false, reason: "unknown_action" };
  if (!position) return { ok: false, reason: "position_missing" };
  if (isTerminal(position)) return { ok: false, reason: "position_terminal" };
  if (a === "ADD" && c.allow_add_position === false) return { ok: false, reason: "add_not_allowed" };
  if ((a === "PARTIAL_CLOSE" || a === "FULL_CLOSE" || a === "MANUAL_CLOSE" || a === "STOP" || a === "TAKE_PROFIT" || a === "LIQUIDATION")
    && !(num(position.remaining_quantity, num(position.quantity)) > 0)) {
    return { ok: false, reason: "no_remaining_quantity" };
  }
  return { ok: true };
}

// 状态迁移(纯函数):返回新持仓 + 审计条目;不通过则 ok=false,持仓不变
export function transition(position, action, payload) {
  const p = position || {};
  const a = String(action || "").toUpperCase();
  const d = payload || {};
  const nowMs = num(d.now, Date.now());
  const permit = canAct(p, a, d);
  if (!permit.ok) return { ok: false, reason: permit.reason, position: p };
  const audit = {
    position_id: p.position_id,
    symbol: p.symbol,
    action: a,
    action_source: ACTION_SOURCE.includes(d.action_source) ? d.action_source : "AUTO",
    exit_reason: d.exit_reason || null,
    fraction: d.fraction == null ? null : num(d.fraction, 0),
    at: nowMs,
    note: d.note || null
  };
  if (a === "HOLD" || a === "TRAIL" || a === "BREAK_EVEN") {
    return { ok: true, position: { ...p, last_action: a, last_action_at: nowMs }, audit };
  }
  if (a === "ADD") {
    // 只做语义标记:真实量价由 accounting/futures 计算后写回
    return { ok: true, position: { ...p, add_count: num(p.add_count, 0) + 1, last_action: a, last_action_at: nowMs }, audit };
  }
  if (a === "PARTIAL_CLOSE") {
    return { ok: true, position: { ...p, last_action: a, last_action_at: nowMs }, audit };
  }
  if (a === "FULL_CLOSE" || a === "MANUAL_CLOSE" || a === "STOP" || a === "TAKE_PROFIT" || a === "LIQUIDATION") {
    return { ok: true, position: { ...p, last_action: a, last_action_at: nowMs }, audit };
  }
  return { ok: true, position: { ...p, last_action: a, last_action_at: nowMs }, audit };
}

// 手动调整模拟止损/止盈:只允许收紧(不放大风险),并记录审计
export function adjustStop(position, newStop, ctx) {
  const p = position || {};
  const s = numOrNull(newStop);
  if (s == null || !(s > 0)) return { ok: false, reason: "invalid_stop" };
  const entry = num(p.entry_price, 0);
  const long = sideOf(p) === "LONG";
  // 新止损不能跑到"已经不可能成交"的一侧(多单止损必须低于现价、空单必须高于现价)
  const cur = num(p.current_price, entry);
  if (long && s >= cur) return { ok: false, reason: "stop_above_market", detail: { stop: s, price: cur } };
  if (!long && s <= cur) return { ok: false, reason: "stop_below_market", detail: { stop: s, price: cur } };
  const widened = long ? (numOrNull(p.stop_price) != null && s < num(p.stop_price)) : (numOrNull(p.stop_price) != null && s > num(p.stop_price));
  if (widened && !(ctx && ctx.allow_widen)) return { ok: false, reason: "stop_widen_forbidden", detail: { old: p.stop_price, next: s } };
  return {
    ok: true,
    position: { ...p, stop_price: round(s, 8), stop_state: { type: ctx && ctx.manual ? "manual" : "adjusted", price: round(s, 8), updated_at: num(ctx && ctx.now, Date.now()) } },
    audit: { position_id: p.position_id, symbol: p.symbol, mode: p.mode, action: "TRAIL", action_source: "MANUAL", at: num(ctx && ctx.now, Date.now()), note: "止损调整 " + num(p.stop_price, 0) + " → " + round(s, 8) }
  };
}

export function adjustTakeProfit(position, newTp, ctx) {
  const p = position || {};
  const t = numOrNull(newTp);
  if (t == null || !(t > 0)) return { ok: false, reason: "invalid_take_profit" };
  const long = sideOf(p) === "LONG";
  const cur = num(p.current_price, num(p.entry_price, 0));
  if (long && t <= cur) return { ok: false, reason: "tp_below_market", detail: { tp: t, price: cur } };
  if (!long && t >= cur) return { ok: false, reason: "tp_above_market", detail: { tp: t, price: cur } };
  return {
    ok: true,
    position: { ...p, take_profit_price: round(t, 8), tp_adjusted_at: num(ctx && ctx.now, Date.now()) },
    audit: { position_id: p.position_id, symbol: p.symbol, mode: p.mode, action: "TAKE_PROFIT", action_source: "MANUAL", at: num(ctx && ctx.now, Date.now()), note: "止盈调整 → " + round(t, 8) }
  };
}

// 持仓概览(UI/系统状态共用):不含任何算价逻辑
export function positionManagerView(positions) {
  const list = positions || [];
  const open = list.filter((p) => p.status === "OPEN");
  const closed = list.filter((p) => p.status === "CLOSED");
  const invalid = list.filter((p) => p.status === "INVALID" || p.price_status === "INVALID");
  const bySide = { LONG: 0, SHORT: 0 };
  let margin = 0;
  let quantity = 0;
  for (const p of open) {
    bySide[sideOf(p)] += 1;
    margin += openMarginOf(p);
    quantity += openQuantityOf(p);
  }
  const actions = {};
  for (const p of list) if (p.last_action) actions[p.last_action] = num(actions[p.last_action], 0) + 1;
  return {
    open_count: open.length,
    closed_count: closed.length,
    invalid_count: invalid.length,
    by_side: bySide,
    margin_used: round(margin, 8),
    quantity_open: round(quantity, 10),
    actions,
    clean: invalid.length === 0
  };
}

// 创建带审计缓冲的管理器(引擎侧使用)
export function createPositionManager(options) {
  const opts = options || {};
  const limit = num(opts.limit, 500);
  const auditLog = [];
  function push(entry) {
    if (!entry) return null;
    auditLog.push(entry);
    if (auditLog.length > limit) auditLog.shift();
    return entry;
  }
  return {
    transition: (position, action, payload) => {
      const res = transition(position, action, payload);
      if (res.ok && res.audit) push(res.audit);
      return res;
    },
    adjustStop: (position, stop, ctx) => {
      const res = adjustStop(position, stop, ctx);
      if (res.ok) push(res.audit);
      return res;
    },
    adjustTakeProfit: (position, tp, ctx) => {
      const res = adjustTakeProfit(position, tp, ctx);
      if (res.ok) push(res.audit);
      return res;
    },
    audit: (options2) => {
      const o = options2 || {};
      const list = o.symbol ? auditLog.filter((e) => e.symbol === o.symbol) : auditLog;
      return list.slice(-num(o.limit, 50));
    },
    view: (positions) => positionManagerView(positions),
    size: () => auditLog.length
  };
}
