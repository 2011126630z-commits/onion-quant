// paper/accounting.js · Paper 资金会计(纯函数:确定性、可测试、无 I/O)
// 约定:
//   - 所有金额单位为 USDT,数量为币数量,价格为 USDT
//   - 模拟成交含点差/滑点/手续费:fill = ref ± (半价差 + 滑点),fee = notional * fee_bps
//   - 多空都占用本金(cash 在开仓时扣掉 notional,平仓时按 notional ± pnl 归还)
//   - Equity = cash + Σ(entry_notional + unrealizedPnl)
//   - 一律区分 gross/net、realized/unrealized,禁止把浮盈当已实现
export const PAPER_DEFAULTS = {
  initial_balance: 100,
  // V14.5(§1/§85):初始分配正式改为 70/30 —— Short 主策略 / Long 辅助策略,并真正落账
  short_pct: 70,
  long_pct: 30,
  fee_bps: 4,          // 单边手续费 0.04%
  slippage_bps: 3,     // 滑点 0.03%
  half_spread_bps: 1,  // 半价差 0.01%
  short_min_pct: 30,
  short_max_pct: 70,
  long_min_pct: 30,
  long_max_pct: 70,
  max_rebalance_step_pct: 10,
  risk_per_trade_pct: 20, // 单笔最多用池子可用资金的 20%
  max_positions_per_mode: 3,
  max_symbol_exposure_pct: 35
};

const EPS = 1e-9;

export function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}

// 严格版:null / undefined / 非数字 一律返回 null(不落成 0)
// 注意 Number(null) === 0,所以 num(null, null) 会得到 0 —— 需要"缺失就是缺失"时必须用这个
export function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function round(v, digits) {
  const d = digits === undefined ? 8 : digits;
  const f = Math.pow(10, d);
  return Math.round(num(v) * f) / f;
}

// 是否安全金额(拒绝 NaN / Infinity / 负数 / 0)
export function isSafeAmount(v, allowZero) {
  const n = Number(v);
  if (!Number.isFinite(n)) return false;
  if (n < 0) return false;
  if (!allowZero && n <= 0) return false;
  return true;
}

// 模拟成交价
export function fillPrice(referencePrice, side, config) {
  const cfg = config || PAPER_DEFAULTS;
  const ref = num(referencePrice, 0);
  if (ref <= 0) return 0;
  const adverse = (num(cfg.half_spread_bps) + num(cfg.slippage_bps)) / 10000;
  return round(side === "BUY" ? ref * (1 + adverse) : ref * (1 - adverse), 8);
}

export function slippagePct(referencePrice, price) {
  const ref = num(referencePrice, 0);
  if (ref <= 0) return 0;
  return round(Math.abs(num(price) - ref) / ref * 100, 6);
}

export function feeOf(notional, config) {
  const cfg = config || PAPER_DEFAULTS;
  return round(num(notional) * num(cfg.fee_bps) / 10000, 8);
}

// 新建账户 + 双池
export function createAccount(options) {
  const opts = options || {};
  const cfg = { ...PAPER_DEFAULTS, ...(opts.config || {}) };
  const now = num(opts.now, 0);
  const initial = num(opts.initial_balance, cfg.initial_balance);
  const shortPct = num(opts.short_pct, cfg.short_pct);
  const longPct = round(100 - shortPct, 4);
  const account = {
    account_id: opts.account_id || "paper-main",
    initial_balance: initial,
    cash_balance: initial,
    reserved_balance: 0,
    realized_pnl: 0,
    unrealized_pnl: 0,
    total_equity: initial,
    fees_paid: 0,
    peak_equity: initial,
    max_drawdown_pct: 0,
    created_at: now,
    updated_at: now,
    schema_version: "v14.0"
  };
  const wallets = {
    short: makeWallet("paper-main", "short", initial * shortPct / 100, now),
    long: makeWallet("paper-main", "long", initial * longPct / 100, now)
  };
  return { account, wallets, config: cfg };
}

export function makeWallet(accountId, mode, allocated, now) {
  return {
    wallet_id: (accountId || "paper-main") + ":" + mode,
    account_id: accountId || "paper-main",
    mode,
    allocated_balance: round(allocated, 8),
    available_balance: round(allocated, 8),
    reserved_balance: 0,
    realized_pnl: 0,
    unrealized_pnl: 0,
    updated_at: now
  };
}

// 资金再平衡:单次最多 10 个百分点,且各池保持 30%~70%
export function rebalancePlan(shortPct, targetShortPct, config) {
  const cfg = config || PAPER_DEFAULTS;
  const current = num(shortPct, 50);
  const wanted = num(targetShortPct, current);
  const step = Math.min(cfg.max_rebalance_step_pct, Math.abs(wanted - current));
  let next = current + Math.sign(wanted - current) * step;
  next = Math.max(cfg.short_min_pct, Math.min(cfg.short_max_pct, next));
  return { short_pct: round(next, 2), long_pct: round(100 - next, 2), changed: Math.abs(next - current) > EPS };
}

// 按长期表现(C-2:不得只看昨天谁赚得多)计算目标分配;数据不足保持 50/50
export function targetAllocation(statsShort, statsLong, config) {
  const cfg = config || PAPER_DEFAULTS;
  const minTrades = 20;
  const s = statsShort || {};
  const l = statsLong || {};
  if (num(s.trades) < minTrades || num(l.trades) < minTrades) {
    return { short_pct: 50, long_pct: 50, reason: "数据不足,保持 50/50", basis: { short_trades: num(s.trades), long_trades: num(l.trades) } };
  }
  const score = (st) => {
    const winRate = num(st.trades) > 0 ? num(st.wins) / num(st.trades) : 0;
    const avg = num(st.avg_net_pnl);
    const dd = num(st.max_drawdown_pct);
    const consec = num(st.max_consecutive_losses);
    const stability = 1 / (1 + Math.abs(num(st.avg_mfe) - Math.abs(num(st.avg_mae))));
    return winRate * 40 + Math.max(-20, Math.min(20, avg)) * 5 - dd * 0.5 - consec * 1.5 + stability * 5;
  };
  const a = score(s);
  const b = score(l);
  const diff = a - b;
  const shortPct = Math.max(cfg.short_min_pct, Math.min(cfg.short_max_pct, 50 + Math.max(-20, Math.min(20, diff))));
  return {
    short_pct: round(shortPct, 2), long_pct: round(100 - shortPct, 2),
    reason: "按样本量/净收益/回撤/稳定性/连亏综合评分",
    basis: { short_score: round(a, 3), long_score: round(b, 3) }
  };
}

// 开仓可用量校验(C-5:余额不足禁止开仓;并发只能一个成功由引擎串行保证)
export function canAfford(wallet, notional, fee) {
  const need = num(notional) + num(fee);
  if (!isSafeAmount(notional) || !isSafeAmount(fee, true)) return { ok: false, reason: "invalid_amount" };
  if (num(wallet && wallet.available_balance) + EPS < need) return { ok: false, reason: "insufficient_balance", need: round(need, 8), available: round(num(wallet && wallet.available_balance), 8) };
  return { ok: true, need: round(need, 8) };
}

// 单笔仓位规模(风险预算 / 单币暴露上限)
export function positionSize(input) {
  const cfg = input.config || PAPER_DEFAULTS;
  const wallet = input.wallet || {};
  const equity = num(input.poolEquity, num(wallet.allocated_balance));
  const budget = Math.min(equity * num(input.riskPct, cfg.risk_per_trade_pct) / 100, num(wallet.available_balance) * 0.98);
  const exposureCap = equity * num(cfg.max_symbol_exposure_pct) / 100;
  const notional = Math.max(0, Math.min(budget, exposureCap));
  return { notional: round(notional, 8), budget: round(budget, 8), exposure_cap: round(exposureCap, 8) };
}

// 方向判定:兼容 side / direction 两种字段(缺失一律按 LONG 的相反数处理会出错,这里显式判定)
export function sideOf(position) {
  const s = String((position && (position.side || position.direction)) || "").toUpperCase();
  return s === "SHORT" ? "SHORT" : "LONG";
}

// 未平数量:部分平仓后 PnL 必须按【剩余数量】计算。
// 曾经用原始 quantity → 部分平仓后浮盈被放大 1/剩余比例(0~509% 这种不可能数字的来源之一)
export function openQuantityOf(position) {
  const remaining = numOrNull(position && position.remaining_quantity);
  if (remaining != null) return Math.max(0, remaining);
  return Math.max(0, num(position && position.quantity));
}

// 未实现盈亏(多空统一)= 剩余数量 × 价格变动(毛额,不含平仓费)
export function unrealizedPnl(position, currentPrice) {
  const qty = openQuantityOf(position);
  const entry = num(position.entry_price);
  const cur = num(currentPrice, entry);
  if (qty <= 0 || entry <= 0) return 0;
  return round(sideOf(position) === "LONG" ? (cur - entry) * qty : (entry - cur) * qty, 8);
}

// 预估平仓费(按剩余名义):毛浮盈 - 该费用 = 此刻真平掉能拿到的净额
export function estimatedExitFee(position, currentPrice, config) {
  const cfg = config || PAPER_DEFAULTS;
  const qty = openQuantityOf(position);
  const cur = num(currentPrice, num(position.current_price, position.entry_price));
  if (qty <= 0 || cur <= 0) return 0;
  return round(qty * cur * num(cfg.fee_bps) / 10000, 8);
}

export function unrealizedNetPnl(position, currentPrice, config) {
  return round(unrealizedPnl(position, currentPrice) - estimatedExitFee(position, currentPrice, config), 8);
}

// 单笔最大可能亏损(逐仓口径)= 剩余保证金 + 入场费 + 预估平仓费(含滑点)。
// 超过这个数就是"不可能亏损"(串价/脏价/会计错误),不允许静默保留。
export function lossBoundOf(position, currentPrice) {
  const margin = Math.max(0, num(position && position.remaining_margin, num(position && position.entry_notional)));
  const fees = Math.max(0, num(position && position.fees));
  const basis = currentPrice == null
    ? num(position && position.current_price, num(position && position.liquidation_price, num(position && position.entry_price)))
    : currentPrice;
  const exitFee = estimatedExitFee(position, basis);
  // 往返滑点(平仓侧)也计入上限:强平价上成交一样要付
  const slippage = Math.abs(openQuantityOf(position) * num(basis)) * (num(PAPER_DEFAULTS.slippage_bps) + num(PAPER_DEFAULTS.half_spread_bps)) / 10000;
  return round(margin + fees + exitFee + slippage, 8);
}

export function returnPct(position, currentPrice) {
  const margin = openMarginOf(position);
  const pnl = unrealizedPnl(position, currentPrice);
  return margin > 0 ? round(pnl / margin * 100, 6) : 0;
}

// 剩余保证金(ROE 的分母):逐仓模型下保证金才是"投进去的钱"
export function openMarginOf(position) {
  const remaining = numOrNull(position && position.remaining_margin);
  if (remaining != null) return Math.max(0, remaining);
  const margin = numOrNull(position && position.entry_notional);
  if (margin != null) return Math.max(0, margin);
  return Math.max(0, num(position && position.initial_margin, num(position && position.entry_notional, 0)));
}

// 价格变动百分比(与 ROE 区分开:这是标的本身涨跌,不含杠杆)
export function priceMovePct(position, currentPrice) {
  const entry = num(position && position.entry_price);
  const cur = num(currentPrice, entry);
  if (entry <= 0) return 0;
  const raw = sideOf(position) === "LONG" ? (cur - entry) / entry : (entry - cur) / entry;
  return round(raw * 100, 6);
}

// 账户不变量(纯函数):资金关系必须自洽,否则上层必须报 DATA_INTEGRITY_ALERT
export function accountIntegrityCheck(account, wallets, positions) {
  const violations = [];
  const a = account || {};
  const finite = (v) => Number.isFinite(Number(v));
  if (!finite(a.cash_balance)) violations.push("cash_balance_not_finite");
  if (!finite(a.reserved_balance)) violations.push("reserved_not_finite");
  if (!finite(a.total_equity)) violations.push("equity_not_finite");
  if (!finite(a.unrealized_pnl)) violations.push("unrealized_not_finite");
  if (num(a.reserved_balance) < -EPS) violations.push("reserved_negative");
  for (const mode of Object.keys(wallets || {})) {
    const w = wallets[mode] || {};
    if (num(w.available_balance) < -EPS) violations.push("available_negative:" + mode);
    if (num(w.reserved_balance) < -EPS) violations.push("wallet_reserved_negative:" + mode);
    if (!finite(w.allocated_balance)) violations.push("allocated_not_finite:" + mode);
  }
  let reservedSum = 0;
  for (const p of positions || []) {
    if (p.status !== "OPEN" && p.status !== "CLOSING") continue;
    reservedSum += num(p.entry_notional);
    if (num(p.remaining_quantity) < -EPS) violations.push("remaining_quantity_negative:" + p.position_id);
    if (num(p.remaining_margin) < -EPS) violations.push("remaining_margin_negative:" + p.position_id);
    if (num(p.entry_notional) < -EPS) violations.push("notional_negative:" + p.position_id);
    if (!finite(p.unrealized_pnl)) violations.push("pnl_not_finite:" + p.position_id);
    if (num(p.unrealized_pnl) < -(lossBoundOf(p) + 1e-6)) violations.push("loss_beyond_margin:" + p.position_id);
  }
  if (Math.abs(reservedSum - num(a.reserved_balance)) > Math.max(1e-6, Math.abs(reservedSum) * 1e-9)) {
    violations.push("reserved_reconcile_mismatch");
  }
  return { ok: violations.length === 0, violations };
}

// 组合会计:资产只有一个来源
export function portfolio(account, wallets, positions, priceOf) {
  const open = (positions || []).filter((p) => p.status === "OPEN" || p.status === "CLOSING");
  let reserved = 0;
  let unrealized = 0;
  const modeUnrealized = { short: 0, long: 0 };
  for (const p of open) {
    // §5:只有可信价格才参与 equity。priceOf 返回空/0/NaN 时用上次已校验的现价,
    // 再不行才退回持仓上已存的浮盈 —— 绝不用"回退到开仓价"把浮亏静默抹成 0。
    const raw = priceOf ? priceOf(p.symbol) : null;
    const price = isSafeAmount(raw) ? num(raw) : num(p.current_price, 0);
    const u = isSafeAmount(price) ? unrealizedPnl(p, price) : num(p.unrealized_pnl);
    reserved += num(p.entry_notional);
    unrealized += u;
    if (p.mode === "short" || p.mode === "long") modeUnrealized[p.mode] += u;
  }
  const cash = num(account.cash_balance);
  const totalEquity = round(cash + reserved + unrealized, 8);
  const walletsOut = {};
  for (const mode of Object.keys(wallets || {})) {
    const w = wallets[mode];
    // 池子规模 = 可用 + 锁定保证金 + 未实现盈亏。
    // 注意:已实现盈亏已经体现在 available(平仓时随本金一起归还),不能再加一次 —— 否则池子被虚增,
    // 后续 positionSize 会越算越大(30 天级回放会放大成数量级偏差)。
    walletsOut[mode] = {
      ...w,
      unrealized_pnl: round(modeUnrealized[mode] || 0, 8),
      allocated_balance: round(num(w.available_balance) + num(w.reserved_balance) + (modeUnrealized[mode] || 0), 8)
    };
  }
  const peak = Math.max(num(account.peak_equity, totalEquity), totalEquity);
  const dd = peak > 0 ? (peak - totalEquity) / peak * 100 : 0;
  return {
    account: {
      ...account,
      reserved_balance: round(reserved, 8),
      unrealized_pnl: round(unrealized, 8),
      total_equity: totalEquity,
      peak_equity: round(peak, 8),
      max_drawdown_pct: round(Math.max(num(account.max_drawdown_pct), dd), 4)
    },
    wallets: walletsOut
  };
}

// 开仓后的账户/钱包(纯变换)
export function applyOpen(state, order) {
  const cfg = state.config || PAPER_DEFAULTS;
  const side = order.side === "BUY" ? "LONG" : "SHORT";
  const price = fillPrice(order.reference_price, order.side, cfg);
  const notional = round(price * num(order.quantity), 8);
  // 杠杆仓位借记保证金;无杠杆时 margin == notional(与 V14 行为一致)
  const debit = order.margin == null ? notional : round(num(order.margin), 8);
  const fee = feeOf(order.fee_base == null ? notional : num(order.fee_base), cfg);
  const wallet = state.wallets[order.mode];
  const afford = canAfford(wallet, debit, fee);
  if (!afford.ok) return { ok: false, reason: afford.reason, detail: afford };
  const now = num(order.now, Date.now());
  const position = {
    position_id: order.position_id || "pos_" + order.mode + "_" + order.symbol + "_" + now,
    account_id: state.account.account_id,
    mode: order.mode,
    symbol: order.symbol,
    side,
    status: "OPEN",
    quantity: round(order.quantity, 10),
    entry_price: price,
    entry_notional: debit,
    current_price: price,
    entry_time: now,
    exit_price: null,
    exit_time: null,
    realized_pnl: 0,
    unrealized_pnl: 0,
    fees: fee,
    net_pnl: null,
    mfe: 0,
    mae: 0,
    stop_price: order.stop_price == null ? null : round(order.stop_price, 8),
    take_profit_price: order.take_profit_price == null ? null : round(order.take_profit_price, 8),
    max_hold_ms: order.max_hold_ms == null ? null : num(order.max_hold_ms),
    invalidation: order.invalidation || null,
    exit_reason: null,
    engine_version: order.engine_version || null,
    model_version: order.model_version || null,
    decision_id: order.decision_id || null,
    signal_id: order.signal_id || null,
    recovered_after_offline: false
  };
  const next = {
    ...state,
    account: {
      ...state.account,
      cash_balance: round(num(state.account.cash_balance) - debit - fee, 8),
      fees_paid: round(num(state.account.fees_paid) + fee, 8),
      updated_at: now
    },
    wallets: {
      ...state.wallets,
      [order.mode]: {
        ...wallet,
        available_balance: round(num(wallet.available_balance) - debit - fee, 8),
        reserved_balance: round(num(wallet.reserved_balance) + debit, 8),
        updated_at: now
      }
    }
  };
  const order_out = {
    ...order,
    order_id: order.order_id || "ord_" + order.mode + "_" + order.symbol + "_" + now,
    status: "FILLED",
    fill_price: price,
    slippage_pct: slippagePct(order.reference_price, price),
    fee,
    notional,
    filled_at: now
  };
  return { ok: true, state: next, position, order: order_out };
}

// 平仓(纯变换):返回 pnl 三段式与统计
export function applyClose(state, position, input) {
  const cfg = state.config || PAPER_DEFAULTS;
  const now = num(input.now, Date.now());
  let refPrice = num(input.reference_price, position.current_price || position.entry_price);
  // §16 逐仓亏损上限:强平只能按【强平价】成交。
  // 若调用方传来更差的价(跳空/脏价/串价),按强平价结算 —— 亏损被保证金约束,
  // 不允许出现 "4.5U 保证金亏出 -22.94U" 这种穿透保证金的已实现亏损。
  const liq = numOrNull(position.liquidation_price);
  if (String(input.exit_reason || "").toUpperCase() === "LIQUIDATION" && liq != null && liq > 0) {
    refPrice = sideOf(position) === "LONG" ? Math.max(refPrice, liq) : Math.min(refPrice, liq);
    if (!(refPrice > 0)) refPrice = liq;
  }
  const exitPrice = fillPrice(refPrice, sideOf(position) === "LONG" ? "SELL" : "BUY", cfg);
  // V14.5:数量取【剩余数量】—— 部分平仓后若仍用原始数量,最终全平会重复计算已关闭部分(现金虚增)
  const qty = num(position.remaining_quantity, num(position.quantity));
  const notional = num(position.entry_notional);
  const exitNotional = round(exitPrice * qty, 8);
  const exitFee = feeOf(exitNotional, cfg);
  const gross = round(sideOf(position) === "LONG" ? (exitPrice - num(position.entry_price)) * qty : (num(position.entry_price) - exitPrice) * qty, 8);
  const fees = round(num(position.fees) + exitFee, 8);
  const net = round(gross - fees, 8);
  // 归还本金 + 毛收益 - 平仓费(入场费在开仓时已从现金扣除,不能再扣一次)
  const repay = round(notional + gross - exitFee, 8);
  const wallet = state.wallets[position.mode];
  const next = {
    ...state,
    account: {
      ...state.account,
      cash_balance: round(num(state.account.cash_balance) + repay, 8),
      realized_pnl: round(num(state.account.realized_pnl) + net, 8),
      fees_paid: round(num(state.account.fees_paid) + exitFee, 8),
      updated_at: now
    },
    wallets: {
      ...state.wallets,
      [position.mode]: {
        ...wallet,
        available_balance: round(num(wallet.available_balance) + repay, 8),
        reserved_balance: round(Math.max(0, num(wallet.reserved_balance) - notional), 8),
        realized_pnl: round(num(wallet.realized_pnl) + net, 8),
        updated_at: now
      }
    }
  };
  const closed = {
    ...position,
    status: "CLOSED",
    exit_price: exitPrice,
    exit_time: now,
    current_price: exitPrice,
    unrealized_pnl: 0,
    realized_pnl: net,
    net_pnl: net,
    fees,
    // V15:全平后必须清零剩余数量/保证金 —— 否则手动全平后仍显示有剩余仓位
    remaining_quantity: 0,
    remaining_margin: 0,
    entry_notional: 0,
    exit_reason: input.exit_reason || "manual",
    recovered_after_offline: Boolean(input.recovered_after_offline)
  };
  const trade = {
    trade_id: input.trade_id || "trd_" + position.position_id,
    account_id: state.account.account_id,
    mode: position.mode,
    symbol: position.symbol,
    side: position.side,
    quantity: qty,
    entry_price: position.entry_price,
    exit_price: exitPrice,
    entry_time: position.entry_time,
    exit_time: now,
    gross_pnl: gross,
    fees,
    net_pnl: net,
    return_pct: notional > 0 ? round(net / notional * 100, 6) : 0,
    mfe: num(position.mfe),
    mae: num(position.mae),
    holding_ms: Math.max(0, now - num(position.entry_time)),
    exit_reason: closed.exit_reason,
    engine_version: position.engine_version,
    model_version: position.model_version,
    decision_id: position.decision_id,
    recovered_after_offline: Boolean((input && input.recovered_after_offline) || position.recovered_after_offline),
    learning_sample_id: null,
    created_at: now
  };
  return { ok: true, state: next, position: closed, trade };
}

// 持仓路径更新(MFE/MAE 用真实最高/最低价,而不是只看收盘)
// §5 价格保护:price 必须是有限正数才允许写 current_price / unrealized_pnl;
// 不通过时只标 price_status,不动数字(否则一个脏价会污染 equity 与后续学习样本)。
export function updatePositionPath(position, price, high, low, meta) {
  const qty = num(position.quantity);
  const entry = num(position.entry_price);
  const info = meta || {};
  const priceOk = isSafeAmount(price) && Number.isFinite(Number(price));
  if (!priceOk) {
    return { ...position, price_status: "INVALID", price_source: info.source || position.price_source || null };
  }
  const clean = round(num(price), 8);
  const status = info.stale ? "STALE" : "OK";
  if (qty <= 0 || entry <= 0) {
    return { ...position, current_price: clean, price_status: status, price_source: info.source || position.price_source || null, price_updated_at: num(info.now, Date.now()) };
  }
  const favorablePrice = sideOf(position) === "LONG" ? num(high, price) : num(low, price);
  const adversePrice = sideOf(position) === "LONG" ? num(low, price) : num(high, price);
  const mfe = Math.max(num(position.mfe), sideOf(position) === "LONG" ? (favorablePrice - entry) * qty : (entry - favorablePrice) * qty);
  const mae = Math.max(num(position.mae), sideOf(position) === "LONG" ? (entry - adversePrice) * qty : (adversePrice - entry) * qty);
  const margin = openMarginOf(position);
  const gross = unrealizedPnl(position, clean);
  return {
    ...position,
    current_price: clean,
    unrealized_pnl: gross,
    unrealized_net_pnl: unrealizedNetPnl(position, clean),
    roe_pct: margin > 0 ? round(gross / margin * 100, 6) : 0,
    price_move_pct: priceMovePct(position, clean),
    mfe: round(mfe, 8),
    mae: round(mae, 8),
    price_status: status,
    price_source: info.source || position.price_source || "current",
    price_updated_at: num(info.now, Date.now())
  };
}

// 退出判定(止损/止盈/时间/结构失效/信号反转/风险),返回 exit_reason 或 null
export function evaluateExit(position, ctx) {
  const now = num(ctx.now, Date.now());
  const price = num(ctx.price, position.current_price || position.entry_price);
  if (!isSafeAmount(price)) return "invalid_price";
  const long = sideOf(position) === "LONG";
  if (position.stop_price != null && ((long && price <= num(position.stop_price)) || (!long && price >= num(position.stop_price)))) return "stop_loss";
  if (position.take_profit_price != null && ((long && price >= num(position.take_profit_price)) || (!long && price <= num(position.take_profit_price)))) return "take_profit";
  if (position.max_hold_ms != null && now - num(position.entry_time) >= num(position.max_hold_ms)) return "time_exit";
  if (ctx.signalReversed) return "signal_reversal";
  if (ctx.structureInvalidated) return "structure_invalidation";
  if (ctx.riskExit) return "risk_exit";
  if (ctx.staleQuote) return "stale_quote";
  return null;
}

// 每日统计(供首页展示与再平衡评分)
export function summarizeTrades(trades) {
  const list = (trades || []).filter((t) => t && Number.isFinite(num(t.net_pnl)));
  const wins = list.filter((t) => num(t.net_pnl) > 0);
  const losses = list.filter((t) => num(t.net_pnl) < 0);
  const sum = (arr, key) => round(arr.reduce((a, b) => a + num(b[key]), 0), 8);
  let consecutive = 0;
  let maxConsecutive = 0;
  for (const t of list.slice().sort((a, b) => num(a.exit_time) - num(b.exit_time))) {
    if (num(t.net_pnl) < 0) { consecutive += 1; maxConsecutive = Math.max(maxConsecutive, consecutive); } else consecutive = 0;
  }
  return {
    trades: list.length,
    wins: wins.length,
    losses: losses.length,
    win_rate: list.length ? round(wins.length / list.length * 100, 2) : null,
    gross_pnl: sum(list, "gross_pnl"),
    fees: sum(list, "fees"),
    net_pnl: sum(list, "net_pnl"),
    avg_net_pnl: list.length ? round(sum(list, "net_pnl") / list.length, 8) : null,
    avg_mfe: list.length ? round(sum(list, "mfe") / list.length, 8) : null,
    avg_mae: list.length ? round(sum(list, "mae") / list.length, 8) : null,
    avg_holding_ms: list.length ? Math.round(list.reduce((a, b) => a + num(b.holding_ms), 0) / list.length) : null,
    max_consecutive_losses: maxConsecutive,
    last_result: list.length ? (num(list[list.length - 1].net_pnl) >= 0 ? "win" : "loss") : null
  };
}

export function dayKeyOf(ms) {
  return new Date(num(ms)).toISOString().slice(0, 10);
}

// ---- V15 P0:收益合理性 ----
// 部分平仓是"仓位事件",其名义可能极小;用碎片名义做分母会算出 -2624% 这种虚假收益。
// 合理区间:杠杆后最大亏损 ≈ -100%×杠杆,再加上往返费用/滑点余量。
export const POSITION_SAMPLE_MIN_NOTIONAL = 0.001;
export function isValidReturnPct(v, leverage) {
  const n = numOrNull(v);
  if (n == null) return false;
  const lev = Math.max(1, num(leverage, 1));
  const bound = lev * 100 + 25;    // 逐仓理论上限 + 费用余量
  return Math.abs(n) <= bound;
}

// ---- V15.1:RAW Ledger 与 CLEAN Strategy Analytics 必须严格分开 ----
// RAW ACCOUNT LEDGER:所有真实历史事件(含修复前的碎片/异常),用于账户余额、现金流、审计。**永不修改**。
// CLEAN STRATEGY ANALYTICS:排除不可学习的异常事件,用于胜率/盈亏比/归因/模型/杠杆/退出策略/漂移。
export const CLEAN_EXCLUDE_MARKERS = ["invalid_for_learning", "invalid_sample", "legacy", "shredded", "tiny_slice", "return_out_of_range", "dust_event"];

export function isCleanTrade(trade) {
  const t = trade || {};
  if (t.invalid_for_learning === true) return false;
  if (t.invalid_sample === true) return false;
  const reason = String(t.repair_reason || "");
  if (reason && CLEAN_EXCLUDE_MARKERS.some((m) => reason.includes(m))) return false;
  return true;
}

export function cleanTrades(trades) {
  return (trades || []).filter((t) => isCleanTrade(t));
}

// 排除统计(UI 要如实告诉用户"排除了多少条",避免误以为账户算错)
export function cleanAnalyticsSummary(trades) {
  const all = trades || [];
  const clean = cleanTrades(all);
  const reasons = {};
  for (const t of all) {
    if (isCleanTrade(t)) continue;
    const rs = String(t.repair_reason || (t.invalid_sample ? "invalid_sample" : "invalid"));
    for (const r of rs.split(",")) if (r) reasons[r] = num(reasons[r], 0) + 1;
  }
  return {
    raw_events: all.length,
    clean_events: clean.length,
    excluded_events: all.length - clean.length,
    excluded_reasons: reasons
  };
}
// Partial Close 是 Position Event,不是独立母交易:统计必须按仓位聚合,否则笔数/胜率被碎片污染。
// V15.1:默认走 CLEAN 口径(排除历史异常事件);{ clean: false } 时返回 RAW 口径(仅高级详情用)。
export function positionIdOf(trade) {
  const t = trade || {};
  if (t.parent_position_id) return t.parent_position_id;
  if (t.position_id) return t.position_id;
  const id = String(t.trade_id || "");
  // 历史(修复前)的部分平仓 id 形如 trd_partial_<position_id>_<seq> → 去掉序号才能归到同一仓位
  const m = id.match(/^trd_partial_(.+)_(\d+)$/);
  if (m) return m[1];
  return id.replace(/^trd_/, "");
}

export function summarizePositions(trades, options) {
  const o = options || {};
  const clean = o.clean !== false;                 // 默认 CLEAN
  const source = clean ? cleanTrades(trades) : (trades || []);
  const list = source.filter((t) => t && Number.isFinite(num(t.net_pnl)));
  const summaryCounts = cleanAnalyticsSummary(trades);
  const byPosition = new Map();
  for (const t of list) {
    const key = positionIdOf(t) || "unknown";
    if (!byPosition.has(key)) byPosition.set(key, []);
    byPosition.get(key).push(t);
  }
  const rows = [...byPosition.entries()].map(([position_id, events]) => {
    const sorted = events.slice().sort((a, b) => num(a.exit_time, 0) - num(b.exit_time, 0));
    const last = sorted[sorted.length - 1] || {};
    const first = sorted[0] || {};
    const net = round(sorted.reduce((a, t) => a + num(t.net_pnl), 0), 8);
    const fees = round(sorted.reduce((a, t) => a + num(t.fees, 0), 0), 8);
    const margin = num(first.entry_notional != null ? first.margin : first.margin, num(last.margin, 0));
    const positionMargin = num(last.position_margin, num(first.position_margin, num(last.margin, margin)));
    return {
      position_id,
      symbol: first.symbol || last.symbol || null,
      mode: first.mode || last.mode || null,
      side: first.side || last.side || null,
      leverage: num(last.leverage, num(first.leverage, 1)),
      events: sorted.length,
      partial_events: sorted.filter((t) => t.partial === true).length,
      entry_time: num(first.entry_time, 0),
      exit_time: num(last.exit_time, 0),
      holding_ms: Math.max(0, num(last.exit_time, 0) - num(first.entry_time, 0)),
      net_pnl: net,
      gross_pnl: round(sorted.reduce((a, t) => a + num(t.gross_pnl, 0), 0), 8),
      fees,
      // 收益口径:相对【仓位保证金】(position-level),而不是碎片名义
      return_on_position_pct: positionMargin > 0 ? round(net / positionMargin * 100, 4) : null,
      exit_reason: last.exit_reason || null,
      exit_reasons: [...new Set(sorted.map((t) => t.exit_reason).filter(Boolean))],
      model_version: last.model_version || first.model_version || null,
      market_regime: last.market_regime || first.market_regime || null,
      closed: true
    };
  }).sort((a, b) => a.exit_time - b.exit_time);
  const wins = rows.filter((r) => num(r.net_pnl) > 0);
  const losses = rows.filter((r) => num(r.net_pnl) < 0);
  const grossWin = wins.reduce((a, r) => a + num(r.net_pnl), 0);
  const grossLoss = Math.abs(losses.reduce((a, r) => a + num(r.net_pnl), 0));
  return {
    caliber: clean ? "clean" : "raw",
    trades: rows.length,          // 口径 = 完整仓位数量
    positions: rows.length,
    events: list.length,          // 原始成交事件数(含部分平仓)
    raw_events: summaryCounts.raw_events,
    excluded_events: clean ? summaryCounts.excluded_events : 0,
    excluded_reasons: clean ? summaryCounts.excluded_reasons : {},
    wins: wins.length,
    losses: losses.length,
    win_rate: rows.length ? round(wins.length / rows.length * 100, 2) : null,
    net_pnl: round(rows.reduce((a, r) => a + num(r.net_pnl), 0), 8),
    fees: round(rows.reduce((a, r) => a + num(r.fees), 0), 8),
    avg_net_pnl: rows.length ? round(rows.reduce((a, r) => a + num(r.net_pnl), 0) / rows.length, 8) : null,
    avg_holding_ms: rows.length ? Math.round(rows.reduce((a, r) => a + num(r.holding_ms), 0) / rows.length) : null,
    profit_factor: grossLoss > 0 ? round(grossWin / grossLoss, 4) : (grossWin > 0 ? null : 1),
    rows
  };
}
