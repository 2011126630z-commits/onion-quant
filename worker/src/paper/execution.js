// paper/execution.js · Paper Execution Simulator(唯一成交口径)
// 目的:全项目所有模拟成交(开/平/部分/强平/手动)都只从这里算成交价与费用,
//      禁止各模块自己写 fill = ref ± bps —— 那是"同一天同一笔单两种价格"的根源。
// 约束:REAL_TRADING_ENABLED = false(futures.js 已声明,这里复用避免扁平 bundle 重名)。
// 本模块只做模拟撮合,不含任何真实下单能力。
import { PAPER_DEFAULTS, num, round, fillPrice, feeOf, isSafeAmount } from "./accounting.js";

export const ORDER_TYPES = ["MARKET", "LIMIT", "STOP_MARKET", "LIQUIDATION", "MANUAL"];
export const EXECUTION_SOURCES = ["mark", "last", "limit", "liquidation", "manual", "recovery"];

export const EXECUTION_DEFAULTS = {
  half_spread_bps: PAPER_DEFAULTS.half_spread_bps,
  slippage_bps: PAPER_DEFAULTS.slippage_bps,
  fee_bps: PAPER_DEFAULTS.fee_bps,
  // LIMIT 单需要价格穿过才成交,且成交价不低于限价(不占用滑点)
  limit_requires_cross: true
};

function sideToOrderSide(position, side) {
  const dir = String((position && (position.direction || position.side)) || "").toUpperCase();
  const closingLong = dir === "LONG";
  if (side === "BUY" || side === "SELL") return side;
  return closingLong ? "SELL" : "BUY";
}

// 一笔模拟成交(纯函数):返回 fill_price / notional / fee / 成本分解 / 被拒原因
// order = { side: BUY|SELL, quantity | (notional & price), order_type, reduce_only, limit_price, fraction, mark_price, reference_price }
export function simulateFill(order, ctx) {
  const cfg = { ...EXECUTION_DEFAULTS, ...((ctx && ctx.config) || {}) };
  const o = order || {};
  const type = ORDER_TYPES.includes(String(o.order_type || "MARKET").toUpperCase()) ? String(o.order_type).toUpperCase() : "MARKET";
  const reference = num(o.reference_price != null ? o.reference_price : o.mark_price, 0);
  if (!isSafeAmount(reference)) return { ok: false, reason: "invalid_reference_price" };
  // LIMIT:买入必须 限价 >= 参考价、卖出必须 限价 <= 参考价,否则不成交(挂单等待)
  if (type === "LIMIT") {
    const limit = num(o.limit_price, 0);
    if (!isSafeAmount(limit)) return { ok: false, reason: "invalid_limit_price" };
    const crossed = String(o.side).toUpperCase() === "BUY" ? limit >= reference : limit <= reference;
    if (!crossed && cfg.limit_requires_cross) return { ok: false, reason: "limit_not_crossed", limit_price: limit, reference_price: reference };
  }
  // 逐仓强平:按强平价成交(不允许比强平价更差的价格穿透保证金)
  let effective = reference;
  if (type === "LIQUIDATION") {
    const liq = num(o.liquidation_price, 0);
    if (isSafeAmount(liq)) {
      const dir = String(o.position_side || "").toUpperCase();
      effective = dir === "LONG" ? Math.max(reference, liq) : Math.min(reference, liq);
    }
  }
  const fill = type === "LIMIT" && !o.apply_slippage ? round(num(o.limit_price, effective), 8) : fillPrice(effective, String(o.side || "BUY").toUpperCase(), cfg);
  if (!isSafeAmount(fill)) return { ok: false, reason: "invalid_fill_price" };
  const qty = num(o.quantity, 0);
  if (!(qty > 0)) return { ok: false, reason: "invalid_quantity" };
  const notional = round(fill * qty, 8);
  const fee = feeOf(notional, cfg);
  const spreadCost = round(qty * Math.abs(fill - reference), 8);
  return {
    ok: true,
    order_type: type,
    reduce_only: Boolean(o.reduce_only),
    fill_price: fill,
    // 报告里给的是"校验并钳制后"的参考价(强平不会被更差的价穿透),调用方据此入账
    reference_price: round(effective, 8),
    mark_price: o.mark_price == null ? null : round(num(o.mark_price), 8),
    quantity: qty,
    notional,
    fee,
    spread_slippage_cost: spreadCost,
    slippage_pct: reference > 0 ? round(Math.abs(fill - reference) / reference * 100, 6) : 0,
    source: EXECUTION_SOURCES.includes(o.source) ? o.source : (type === "LIQUIDATION" ? "liquidation" : "last")
  };
}

// 开仓单:市价 + 滑点/价差 + 手续费(与 accounting.applyOpen 的成交价数学完全一致)
export function openOrder(input) {
  const i = input || {};
  const qty = num(i.quantity, 0) > 0 ? num(i.quantity, 0) : (num(i.notional, 0) > 0 ? num(i.notional, 0) / Math.max(num(i.reference_price, 1), 1e-9) : 0);
  return simulateFill({
    side: String(i.direction || "LONG").toUpperCase() === "LONG" ? "BUY" : "SELL",
    quantity: qty,
    order_type: i.order_type || "MARKET",
    limit_price: i.limit_price,
    reference_price: i.reference_price,
    mark_price: i.mark_price,
    source: i.source || "last"
  }, i);
}

// 平仓单(含部分平仓 / reduce-only / 强平 / 手动)
export function closeOrder(position, input) {
  const i = input || {};
  const fraction = i.fraction == null ? 1 : Math.max(0.0001, Math.min(1, num(i.fraction, 1)));
  const remaining = num(position && position.remaining_quantity, 0);
  const quantity = i.quantity != null ? num(i.quantity, 0) : round(remaining * fraction, 10);
  const exitReason = String(i.exit_reason || "manual").toUpperCase();
  const type = exitReason === "LIQUIDATION" ? "LIQUIDATION" : (i.manual ? "MANUAL" : "MARKET");
  return simulateFill({
    side: sideToOrderSide(position, i.side),
    quantity,
    order_type: type,
    reduce_only: true,
    reference_price: i.reference_price != null ? i.reference_price : position && position.current_price,
    mark_price: i.mark_price,
    liquidation_price: position && position.liquidation_price,
    position_side: (position && (position.direction || position.side)) || null,
    source: type === "LIQUIDATION" ? "liquidation" : (i.manual ? "manual" : "last"),
    fraction
  }, i);
}

// 保证金/名义/杠杆推导(单一公式,避免各处自己乘除)
export function marginPlan(input) {
  const i = input || {};
  const notional = num(i.notional, 0);
  const leverage = Math.max(1, num(i.leverage, 1));
  const margin = i.margin != null ? num(i.margin, 0) : round(notional / leverage, 8);
  const derivedNotional = i.notional != null ? notional : round(margin * leverage, 8);
  const qty = num(i.entry_price, 0) > 0 ? round(derivedNotional / num(i.entry_price), 10) : 0;
  return { margin: round(margin, 8), notional: round(derivedNotional, 8), quantity: qty, leverage };
}

// 成交报告(给 Journal / 通知 / UI 共用同一份口径)
export function fillReport(fill, extra) {
  if (!fill || !fill.ok) return { ok: false, reason: fill ? fill.reason : "no_fill" };
  return {
    ok: true,
    price: fill.fill_price,
    quantity: fill.quantity,
    notional: fill.notional,
    fee: fill.fee,
    cost: round(fill.fee + fill.spread_slippage_cost, 8),
    slippage_pct: fill.slippage_pct,
    source: fill.source,
    order_type: fill.order_type,
    reduce_only: fill.reduce_only,
    ...(extra || {})
  };
}
