// paper/futures.js · Paper Futures 数学(纯函数:杠杆/保证金/强平/部分平仓)
// 约定:
//   margin(保证金) 与 notional(名义) 严格分开:margin = notional / leverage
//   PnL 与手续费都基于 notional
//   部分平仓只结算被关闭的那部分,剩余继续 unrealized(禁止重复计 PnL)
//   REAL_TRADING_ENABLED = false:本模块只做模拟计算,不含任何真实下单
import { PAPER_DEFAULTS, num, numOrNull, round, fillPrice, feeOf, isSafeAmount } from "./accounting.js";

export const REAL_TRADING_ENABLED = false;
export const REAL_FUTURES_ENABLED = false;

export const LEVERAGE_MIN = 1;
export const LEVERAGE_MAX = 10;
export const LEVERAGE_STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
// 维持保证金率(简化:分层费率),用于强平价与 margin_ratio
export const MAINTENANCE_MARGIN_RATE = 0.005;
export const LIQUIDATION_FEE_RATE = 0.0025;

// 方向归一化:引擎持仓用 side(LONG/SHORT),策略层可能用 direction
export function dirOf(position) {
  const raw = String((position && (position.direction || position.side)) || "LONG").toUpperCase();
  return raw === "SHORT" ? "SHORT" : "LONG";
}

export function clampLeverage(value) {
  const n = Math.round(num(value, 1));
  return Math.max(LEVERAGE_MIN, Math.min(LEVERAGE_MAX, n));
}

export function isValidLeverage(value) {
  const n = num(value, 0);
  return LEVERAGE_STEPS.includes(n);
}

// 开仓:margin = notional / leverage,手续费基于 notional
export function openFuturesPosition(input) {
  const cfg = { ...PAPER_DEFAULTS, ...(input.config || {}) };
  const side = input.direction === "LONG" ? "LONG" : "SHORT";
  const leverage = clampLeverage(input.leverage);
  const referencePrice = num(input.reference_price, 0);
  if (!isSafeAmount(referencePrice)) return { ok: false, reason: "invalid_price" };
  const entryPrice = fillPrice(referencePrice, side === "LONG" ? "BUY" : "SELL", cfg);
  const margin = num(input.margin, 0);
  if (!isSafeAmount(margin)) return { ok: false, reason: "invalid_margin" };
  const notional = round(margin * leverage, 8);
  const quantity = round(notional / entryPrice, 10);
  if (!(quantity > 0)) return { ok: false, reason: "invalid_quantity" };
  const fee = feeOf(notional, cfg);
  const liquidationPrice = liquidationPriceOf({ side, entryPrice, leverage, margin, maintenanceRate: input.maintenanceRate });
  return {
    ok: true,
    position: {
      strategy_mode: input.strategy_mode === "LONG_TERM" ? "LONG_TERM" : "SHORT_TERM",
      direction: side,
      symbol: input.symbol,
      entry_price: entryPrice,
      avg_entry_price: entryPrice,
      initial_quantity: quantity,
      remaining_quantity: quantity,
      initial_margin: round(margin, 8),
      remaining_margin: round(margin, 8),
      notional: round(notional, 8),
      leverage,
      requested_leverage: num(input.requested_leverage, leverage),
      approved_leverage: num(input.approved_leverage, leverage),
      actual_leverage: leverage,
      maintenance_margin: round(notional * num(input.maintenanceRate, MAINTENANCE_MARGIN_RATE), 8),
      liquidation_price: liquidationPrice,
      margin_ratio: round(margin / Math.max(notional, 1e-9) * 100, 4),
      risk_cap: input.risk_cap == null ? null : num(input.risk_cap),
      leverage_policy_version: input.leverage_policy_version || "auto-leverage-v0.1",
      realized_pnl: 0,
      unrealized_pnl: 0,
      fees: fee,
      funding_simulated: 0,
      mfe: 0,
      mae: 0,
      partial_close_count: 0,
      tp_levels: input.tp_levels || null,
      stop_state: input.stop_state || null,
      trailing_state: input.trailing_state || null
    }
  };
}

// 强平价(简化线性合约):多头 entry*(1 - 1/L + mmr),空头 entry*(1 + 1/L - mmr)
export function liquidationPriceOf(input) {
  const entry = num(input.entryPrice, 0);
  const leverage = clampLeverage(input.leverage);
  const mmr = num(input.maintenanceRate, MAINTENANCE_MARGIN_RATE);
  if (entry <= 0) return null;
  const price = input.side === "LONG" ? entry * (1 - 1 / leverage + mmr) : entry * (1 + 1 / leverage - mmr);
  return round(Math.max(0, price), 8);
}

// §8 方向不变量:多头强平价必须在开仓价下方,空头必须在上方。
// 不满足说明方向符号/参数算错了 —— 这种仓位绝不允许创建(LIQUIDATION_CALC_ERROR)。
export function liquidationInvariant(input) {
  const entry = num(input.entryPrice, 0);
  const liq = num(input.liquidationPrice, 0);
  const side = input.side === "SHORT" ? "SHORT" : "LONG";
  if (!(entry > 0)) return { ok: false, reason: "LIQUIDATION_CALC_ERROR", detail: "entry_not_positive" };
  if (!(liq > 0)) return { ok: false, reason: "LIQUIDATION_CALC_ERROR", detail: "liq_not_positive" };
  if (side === "LONG" && !(liq < entry)) return { ok: false, reason: "LIQUIDATION_CALC_ERROR", detail: "long_liq_above_entry" };
  if (side === "SHORT" && !(liq > entry)) return { ok: false, reason: "LIQUIDATION_CALC_ERROR", detail: "short_liq_below_entry" };
  return { ok: true, side, entry, liquidation_price: liq };
}

// §16 强平成交价:只能按"不比强平价更好"的价格成交。
// 长仓:取 max(现价, 强平价) —— 跳空更低也按强平价结算;空头反之。
export function liquidationFillPrice(position, price) {
  const liq = num(position && position.liquidation_price, 0);
  const cur = num(price, 0);
  if (!(liq > 0)) return cur;
  if (!(cur > 0)) return liq;
  return dirOf(position) === "LONG" ? Math.max(cur, liq) : Math.min(cur, liq);
}

// 止损棘轮:止损只允许朝有利方向移动(LONG 抬高 / SHORT 降低),不允许回撤
export function ratchetStop(position, candidate) {
  const next = numOrNull(candidate);
  if (next == null || !(next > 0)) return position;
  const current = numOrNull(position.stop_price);
  const isLong = dirOf(position) === "LONG";
  const better = current == null ? true : (isLong ? next > current : next < current);
  if (!better) return position;
  return { ...position, stop_price: round(next, 8) };
}

export function liquidationDistancePct(position, currentPrice) {
  const liq = num(position.liquidation_price, 0);
  const cur = num(currentPrice, num(position.entry_price));
  if (!liq || !cur) return null;
  return round(Math.abs(cur - liq) / cur * 100, 4);
}

export function isLiquidated(position, price) {
  const liq = num(position.liquidation_price, 0);
  const p = num(price, 0);
  if (!liq || !p) return false;
  return dirOf(position) === "LONG" ? p <= liq : p >= liq;
}

// 未实现盈亏(基于 notional × 价格变动率)
export function futuresUnrealized(position, price) {
  const qty = num(position.remaining_quantity, 0);
  const entry = num(position.entry_price, 0);
  const cur = num(price, entry);
  if (qty <= 0 || entry <= 0) return 0;
  const raw = dirOf(position) === "LONG" ? (cur - entry) * qty : (entry - cur) * qty;
  return round(raw, 8);
}

// 部分/全部平仓:只结算被关闭部分
export function closeFuturesPosition(position, input) {
  const cfg = { ...PAPER_DEFAULTS, ...(input.config || {}) };
  const fraction = input.fraction == null ? 1 : Math.max(0, Math.min(1, num(input.fraction)));
  if (fraction <= 0) return { ok: false, reason: "invalid_fraction" };
  const remainingQty = num(position.remaining_quantity, 0);
  if (remainingQty <= 0) return { ok: false, reason: "already_closed" };
  const closeQty = round(remainingQty * fraction, 10);
  if (!(closeQty > 0)) return { ok: false, reason: "invalid_quantity" };
  const isFull = fraction >= 0.999999 || Math.abs(remainingQty - closeQty) < 1e-9;
  const referencePrice = num(input.reference_price, position.current_price || position.entry_price);
  const exitPrice = num(input.exit_price_override, fillPrice(referencePrice, dirOf(position) === "LONG" ? "SELL" : "BUY", cfg));
  const entry = num(position.entry_price, 0);
  const marginPortion = round(num(position.remaining_margin, 0) * (closeQty / remainingQty), 8);
  const notionalPortion = round(closeQty * entry, 8);
  const exitNotional = round(closeQty * exitPrice, 8);
  const exitFee = feeOf(exitNotional, cfg);
  const gross = round(dirOf(position) === "LONG" ? (exitPrice - entry) * closeQty : (entry - exitPrice) * closeQty, 8);
  // 入场费在开仓时已扣除,这里只扣本次平仓费(避免重复计费)
  const net = round(gross - exitFee, 8);
  return {
    ok: true,
    closed_quantity: closeQty,
    closed_fraction: round(closeQty / remainingQty, 6),
    is_full: isFull,
    exit_price: exitPrice,
    gross_pnl: gross,
    fees: exitFee,
    entry_fee_allocated: round(num(position.fees, 0) * (closeQty / Math.max(num(position.initial_quantity, remainingQty), 1e-9)), 8),
    net_pnl: net,
    margin_released: round(marginPortion + net, 8),
    notional_closed: notionalPortion,
    realized_for_partial: net,
    position_after: {
      ...position,
      remaining_quantity: isFull ? 0 : round(remainingQty - closeQty, 10),
      remaining_margin: isFull ? 0 : round(num(position.remaining_margin, 0) - marginPortion, 8),
      // entry_notional 表示"当前仍被锁定的本金":部分平仓后必须按释放的保证金减少,
      // 否则 portfolio 的 reserved 与 applyClose 的归还额都会多算(池子随每次部分平仓虚增)
      entry_notional: isFull ? 0 : round(Math.max(0, num(position.entry_notional, 0) - marginPortion), 8),
      fees: isFull ? 0 : num(position.fees, 0),
      realized_pnl: round(num(position.realized_pnl, 0) + net, 8),
      partial_close_count: num(position.partial_close_count, 0) + (isFull ? 0 : 1),
      unrealized_pnl: isFull ? 0 : num(position.unrealized_pnl, 0),
      status: isFull ? "CLOSED" : "OPEN"
    }
  };
}

// 分批止盈计划:根据 ATR / 阻力 / 趋势强度 / 置信度 生成 TP1..TPn 与各自比例
export function buildTakeProfitPlan(input) {
  const entry = num(input.entry_price, 0);
  const direction = input.direction === "LONG" ? "LONG" : "SHORT";
  const atr = num(input.atr, entry * 0.01);
  const confidence = num(input.confidence, 50);
  const trendStrong = Boolean(input.trend_strong);
  const resistance = num(input.resistance, 0);
  const support = num(input.support, 0);
  const levels = [];
  const sign = direction === "LONG" ? 1 : -1;
  const base = atr * (trendStrong ? 1.8 : 1.2);
  levels.push({ level: 1, price: round(entry + sign * base, 8), fraction: confidence >= 70 ? 0.25 : 0.34 });
  levels.push({ level: 2, price: round(entry + sign * base * 2, 8), fraction: 0.33 });
  const structureTarget = direction === "LONG" ? resistance : support;
  const finalPrice = structureTarget && ((direction === "LONG" && structureTarget > entry) || (direction === "SHORT" && structureTarget < entry && structureTarget > 0))
    ? structureTarget
    : entry + sign * base * 3;
  levels.push({ level: 3, price: round(finalPrice, 8), fraction: null }); // null = 剩余全部
  return { levels, note: "TP 比例由置信度/趋势强度/结构决定,非写死" };
}

// 移动止损:按 ATR 或百分比,只允许朝有利方向移动
export function updateTrailingStop(position, price, config) {
  const cfg = config || {};
  const atr = num(cfg.atr, 0);
  const pct = num(cfg.trailingPct, 0);
  const entry = num(position.entry_price, 0);
  const cur = num(price, entry);
  const isLong = dirOf(position) === "LONG";
  const distance = atr > 0 ? atr * num(cfg.atrMult, 1.2) : entry * (pct || 0.01);
  const candidate = isLong ? cur - distance : cur + distance;
  const currentStop = num(position.stop_state && position.stop_state.price, isLong ? -Infinity : Infinity);
  const better = isLong ? candidate > currentStop : candidate < currentStop;
  const next = better ? candidate : currentStop;
  return {
    ...position,
    stop_state: {
      type: "trailing",
      price: round(next, 8),
      activated: true,
      atr: atr || null,
      trailing_pct: pct || null,
      updated_at: num(cfg.now, Date.now())
    }
  };
}

// Break-even:达到触发条件后把停止价推到覆盖手续费的位置(不是简单等于 entry)
export function applyBreakEven(position, price, config) {
  const cfg = config || {};
  const entry = num(position.entry_price, 0);
  const cur = num(price, entry);
  const triggerR = num(cfg.triggerR, 1.0);          // 达到 1R 触发
  const atr = num(cfg.atr, entry * 0.01);
  const feeRate = (num((cfg.config || {}).fee_bps, PAPER_DEFAULTS.fee_bps) * 2) / 10000;
  const isLong = dirOf(position) === "LONG";
  const moved = isLong ? cur - entry : entry - cur;
  const already = Boolean(position.stop_state && position.stop_state.breakeven);
  if (already) return { changed: false, position };
  if (moved < atr * triggerR) return { changed: false, position };
  const feeBuffer = entry * feeRate;
  const bePrice = isLong ? entry + feeBuffer : entry - feeBuffer;
  return {
    changed: true,
    position: {
      ...position,
      stop_state: { type: "breakeven", price: round(bePrice, 8), breakeven: true, fee_buffer: round(feeBuffer, 8), updated_at: num(cfg.now, Date.now()) }
    }
  };
}

// 保证金健康度
export function marginHealth(position, price) {
  const notional = num(position.remaining_quantity, 0) * num(price, num(position.entry_price));
  const margin = num(position.remaining_margin, 0);
  const ratio = notional > 0 ? margin / notional * 100 : 0;
  const distance = liquidationDistancePct(position, price);
  return {
    margin_ratio: round(ratio, 4),
    margin_ratio_pct_of_maintenance: round(ratio / (MAINTENANCE_MARGIN_RATE * 100), 2),
    liquidation_price: num(position.liquidation_price, 0) || null,
    liquidation_distance_pct: distance,
    danger: distance != null && distance < 3
  };
}
