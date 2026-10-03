// paper/recovery.js · Crash / Recovery Manager(异常退出后的一致性恢复计划)
// 目的:App/页面被杀死或异常退出后,先看清"账本与持仓是否自洽",再决定恢复动作:
//      OPEN 仓位是否仍有保证金、是否有未完成订单、reserved 是否与持仓对账、
//      last candle / last tick 是否过期、同步队列是否有半途状态。
// 原则:只产出"计划 + 报告",实际写入仍走引擎既有路径(避免两套写账本逻辑)。
import { num, numOrNull, round, sideOf, openMarginOf, lossBoundOf, accountIntegrityCheck } from "./accounting.js";
import { liquidationInvariant } from "./futures.js";

export const RECOVERY_ACTIONS = [
  "RECONCILE_RESERVED",     // reserved 与持仓锁定本金不一致 → 以持仓为准重算
  "MARK_PRICE_INVALID",     // 现价不可信 → 标 INVALID 等真实行情
  "FORCE_LIQUIDATION",      // 亏损穿透保证金 → 立即按强平价结算
  "CLOSE_STOP_CROSSED",     // 止损早已穿越 → 立即平仓
  "DROP_STALE_ORDER",       // 未完成订单超过 TTL → 标记取消
  "REPLAY_PENDING_SYNC",    // 同步队列有 PENDING → 交给同步任务重试
  "RESET_ENGINE_STATE"      // 引擎状态残留 RUNNING 但进程已重启 → 归位
];

export const RECOVERY_DEFAULTS = {
  order_ttl_ms: 10 * 60000,
  tick_stale_ms: 30 * 60000,
  candle_stale_ms: 6 * 3600000
};

// 纯函数:输入快照,输出恢复计划(不做任何写入)
export function recoveryPlan(input) {
  const i = input || {};
  const cfg = { ...RECOVERY_DEFAULTS, ...(i.config || {}) };
  const nowMs = num(i.now, Date.now());
  const actions = [];
  const notes = [];
  const positions = (i.positions || []).filter((p) => p.status === "OPEN" || p.status === "CLOSING");

  for (const p of positions) {
    const margin = openMarginOf(p);
    if (!(margin > 0)) {
      actions.push({ action: "RECONCILE_RESERVED", position_id: p.position_id, symbol: p.symbol, reason: "margin_missing" });
    }
    const priceOk = Number.isFinite(Number(p.current_price)) && num(p.current_price) > 0;
    if (!priceOk) actions.push({ action: "MARK_PRICE_INVALID", position_id: p.position_id, symbol: p.symbol, reason: "invalid_current_price" });
    const bound = lossBoundOf(p, priceOk ? num(p.current_price) : null);
    const pnl = num(p.unrealized_pnl);
    const beyond = bound > 0 && (pnl < -(bound + 1e-6) || !Number.isFinite(Number(p.unrealized_pnl)));
    if (beyond) actions.push({ action: "FORCE_LIQUIDATION", position_id: p.position_id, symbol: p.symbol, reason: "loss_beyond_margin", detail: { pnl, bound } });
    const stop = numOrNull(p.stop_price);
    if (priceOk && stop != null) {
      const crossed = sideOf(p) === "LONG" ? num(p.current_price) <= stop : num(p.current_price) >= stop;
      if (crossed) actions.push({ action: "CLOSE_STOP_CROSSED", position_id: p.position_id, symbol: p.symbol, reason: "stop_already_crossed", detail: { price: num(p.current_price), stop } });
    }
    const inv = liquidationInvariant({ side: sideOf(p), entryPrice: p.entry_price, liquidationPrice: p.liquidation_price });
    if (!inv.ok) actions.push({ action: "MARK_PRICE_INVALID", position_id: p.position_id, symbol: p.symbol, reason: "liquidation_invariant_broken:" + inv.detail });
  }

  // 未完成订单
  const staleOrders = (i.orders || []).filter((o) => String(o.status || "").toUpperCase() === "NEW" || String(o.status || "").toUpperCase() === "PENDING");
  for (const o of staleOrders) {
    const age = nowMs - num(o.created_at || o.filled_at, nowMs);
    if (age > cfg.order_ttl_ms) actions.push({ action: "DROP_STALE_ORDER", order_id: o.order_id, symbol: o.symbol, reason: "order_ttl_exceeded", detail: { age_ms: age } });
  }

  // 同步队列半途状态
  const pending = (i.sync_queue || []).filter((q) => String(q.sync_status || "").toUpperCase() === "PENDING");
  if (pending.length) actions.push({ action: "REPLAY_PENDING_SYNC", reason: "pending_sync_items", detail: { count: pending.length } });

  // 引擎状态与时间线
  const state = String((i.engine_state && i.engine_state.state) || "").toUpperCase();
  if (state === "RUNNING" || state === "STARTING" || state === "RECOVERING") {
    actions.push({ action: "RESET_ENGINE_STATE", reason: "engine_state_left_running_after_restart", detail: { was: state } });
  }
  const lastTick = numOrNull(i.last_tick_at);
  if (lastTick != null && nowMs - lastTick > cfg.tick_stale_ms) notes.push({ note: "last_tick_stale", age_ms: nowMs - lastTick });
  const lastCandle = numOrNull(i.last_candle_time);
  if (lastCandle != null && nowMs - lastCandle > cfg.candle_stale_ms) notes.push({ note: "last_candle_stale", age_ms: nowMs - lastCandle });

  // 账户不变量:恢复后必须自洽
  const integrity = accountIntegrityCheck(i.account, i.wallets, i.positions);
  if (!integrity.ok) actions.push({ action: "RECONCILE_RESERVED", reason: "account_integrity", detail: { violations: integrity.violations } });

  const blocking = actions.filter((a) => a.action === "FORCE_LIQUIDATION" || a.action === "CLOSE_STOP_CROSSED");
  return {
    ok: actions.length === 0,
    action_count: actions.length,
    actions,
    notes,
    integrity,
    // 有"必须立即处置"的动作时:先处理持仓,再允许新开仓
    allow_new_entry_after: blocking.length === 0,
    report_text: actions.length
      ? "启动自检:" + actions.length + " 项待处置(" + [...new Set(actions.map((a) => a.action))].join(",") + ")"
      : "启动自检:账本与持仓自洽"
  };
}

// 给 UI 的简短状态(普通用户只看结论)
export function recoveryView(plan) {
  const p = plan || { ok: true, actions: [], notes: [] };
  return {
    ok: p.ok,
    label: p.ok ? "状态正常" : p.report_text,
    count: num(p.action_count, 0),
    critical: p.actions.filter((a) => a.action === "FORCE_LIQUIDATION" || a.action === "CLOSE_STOP_CROSSED").length
  };
}
