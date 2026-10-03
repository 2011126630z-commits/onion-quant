// paper/profitAllocation.js · V16 §4 · 利润分配(Protected Profit / 70-30)(纯函数,无 I/O)
// 规则:
//   - 资金分层:Tradable Capital / Reserved Margin / Protected Profit / Unrealized PnL
//   - 一个完整母 Position 最终关闭且累计净利 > 0 → 30% 回到可交易资金,70% 进入利润保护池
//   - Partial Close 不重复做 70/30(只在母仓位口径结算一次)
//   - 利润保护池【永久】不可用于:新开仓 / 加仓 / AUTO 杠杆 / 回撤补仓
//   - 浮盈只能影响 Equity 与 Risk,禁止当成可用现金再次开仓
export const PROFIT_POOL_VERSION = "profit-pool-v1.0";
export const PROFIT_SPLIT = { tradable_pct: 30, protected_pct: 70 };
export const PROFIT_POOL_RULES = {
  min_split_usdt: 0.5,       // 太小不折腾(避免 0.01U 也走一遍流水)
  granularity: "position",   // 只能按完整母仓位
  allow_negative: false
};
export const PROTECTED_MISUSE_CODES = {
  NEW_ENTRY: "利润保护池禁止用于新开仓",
  ADD_POSITION: "利润保护池禁止加仓",
  AUTO_LEVERAGE: "利润保护池禁止作为 AUTO 杠杆保证金",
  CATCH_UP: "利润保护池禁止用于回撤补仓",
  WITHDRAW_TO_TRADABLE: "利润保护池不可人工挪回可交易资金"
};
const BLOCKED_PURPOSES = ["new_entry", "add_position", "auto_leverage", "catch_up", "withdraw_to_tradable"];

function poolFnum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}
function poolRound8(v) { return Math.round(poolFnum(v) * 1e8) / 1e8; }
function poolEps() { return 1e-9; }

export function createProfitPool(options) {
  const o = options || {};
  return {
    version: PROFIT_POOL_VERSION,
    protected_balance: Math.max(0, poolFnum(o.protected_balance, 0)),
    tradable_credit_total: 0,
    protected_total: 0,
    records: [],
    settled_positions: {},
    blocked_attempts: [],
    created_at: poolFnum(o.now, 0)
  };
}

export function protectedBalance(pool) {
  return Math.max(0, poolFnum(pool && pool.protected_balance));
}

// 利润保护池永远不可花费(唯一权威判断,任何模块都必须走这里)
export function protectedIsSpendable() {
  return false;
}

// 隔离校验:谁想动保护池的钱,先过这里
export function protectedIsolationCheck(pool, request) {
  const r = request || {};
  const purpose = String(r.purpose || "").toLowerCase();
  const usable = Math.max(0, poolFnum(r.available_tradable));
  const amount = Math.max(0, poolFnum(r.amount));
  if (BLOCKED_PURPOSES.includes(purpose)) {
    const record = {
      at: poolFnum(r.now, 0), purpose: purpose, amount: amount,
      code: purpose.toUpperCase(), reason_zh: PROTECTED_MISUSE_CODES[purpose.toUpperCase()] || "利润保护池不可动用"
    };
    if (pool) pool.blocked_attempts.push(record);
    return { blocked: true, code: purpose.toUpperCase(), reason_zh: record.reason_zh, amount_allowed: 0, protected_balance: protectedBalance(pool) };
  }
  if (amount > usable + poolEps()) {
    return { blocked: true, code: "INSUFFICIENT_TRADABLE", reason_zh: "可交易资金不足", amount_allowed: usable, protected_balance: protectedBalance(pool) };
  }
  return { blocked: false, code: "OK", reason_zh: "允许", amount_allowed: amount, protected_balance: protectedBalance(pool) };
}

// 母仓位结算(幂等):同一 position_id 只结算一次;利润保护池的提取额不得超过当前可交易现金
export function splitProfitOnPositionClose(pool, input) {
  const o = input || {};
  const p = pool || createProfitPool({});
  const positionId = o.position_id || null;
  const net = poolFnum(o.net_realized_pnl, 0);
  const at = poolFnum(o.at, 0);
  const availableTradable = poolFnum(o.available_tradable, null);
  const rules = { ...PROFIT_POOL_RULES, ...(o.rules || {}) };
  if (!positionId) return { applied: false, reason: "no_position_id", pool: p };
  if (p.settled_positions[positionId]) {
    return { applied: false, reason: "already_split", pool: p, record: p.settled_positions[positionId] };
  }
  if (!(net > 0)) {
    p.settled_positions[positionId] = { position_id: positionId, applied: false, reason: "no_profit", net_realized_pnl: net, at: at };
    return { applied: false, reason: "no_profit", pool: p, record: p.settled_positions[positionId] };
  }
  if (net < rules.min_split_usdt) {
    p.settled_positions[positionId] = { position_id: positionId, applied: false, reason: "below_min_split", net_realized_pnl: net, at: at };
    return { applied: false, reason: "below_min_split", pool: p, record: p.settled_positions[positionId] };
  }
  let toProtected = poolRound8(net * PROFIT_SPLIT.protected_pct / 100);
  let toTradable = poolRound8(net - toProtected);
  let cappedBy = null;
  if (availableTradable != null && toProtected > availableTradable) {
    // 可交易现金不够搬(部分利润已被后续交易用掉)→ 只搬得起多少搬多少,差额如实记录
    toProtected = poolRound8(Math.max(0, availableTradable));
    toTradable = poolRound8(net - toProtected);
    cappedBy = "available_tradable";
  }
  p.protected_balance = poolRound8(protectedBalance(p) + toProtected);
  p.tradable_credit_total = poolRound8(p.tradable_credit_total + toTradable);
  p.protected_total = poolRound8(p.protected_total + toProtected);
  const record = {
    position_id: positionId,
    symbol: o.symbol || null,
    mode: o.mode || null,
    at: at,
    net_realized_pnl: poolRound8(net),
    to_tradable: toTradable,
    to_protected: toProtected,
    protected_after: p.protected_balance,
    capped_by: cappedBy,
    applied: true,
    reason: "position_closed_with_profit"
  };
  p.records.push(record);
  p.settled_positions[positionId] = record;
  return { applied: true, reason: "position_closed_with_profit", pool: p, record: record };
}

// 四层资金视图:只有前两层能开新仓;浮盈只进入风险与净值
export function poolLayers(input) {
  const o = input || {};
  const equity = Math.max(0, poolFnum(o.equity));
  const reserved = Math.max(0, poolFnum(o.reserved_margin));
  const unrealized = poolFnum(o.unrealized_pnl);
  const protectedBal = protectedBalance(o.pool);
  const cash = Math.max(0, poolFnum(o.cash_balance, equity - reserved - unrealized));
  const tradable = poolRound8(Math.max(0, cash - protectedBal));
  return {
    tradable_capital: tradable,
    reserved_margin: poolRound8(reserved),
    protected_profit: poolRound8(protectedBal),
    unrealized_pnl: poolRound8(unrealized),
    total_equity: poolRound8(equity),
    // 能用于新开仓的只有可交易资金(reserved 已被占用,protected 永久锁定)
    spendable_for_entry: tradable
  };
}

export function poolSummary(pool) {
  const p = pool || {};
  return {
    protected_balance: poolRound8(protectedBalance(p)),
    tradable_credit_total: poolRound8(p.tradable_credit_total),
    protected_total: poolRound8(p.protected_total),
    splits: (p.records || []).length,
    blocked_attempts: (p.blocked_attempts || []).length,
    last_split: (p.records || [])[p.records.length - 1] || null
  };
}

// 净值曲线上的保护池曲线(供 UI 画"总资金 / 保护池"两条线)
export function poolSeries(pool, points) {
  const p = pool || {};
  const base = Math.max(0, poolFnum(p.protected_total, 0));
  return (points || []).map((pt) => ({ at: poolFnum(pt.at), protected: poolFnum(pt.protected, base) }));
}

export function poolView(pool) {
  const s = poolSummary(pool);
  return {
    protected: s.protected_balance,
    tradable_credit: s.tradable_credit_total,
    splits: s.splits,
    protected_zh: "利润保护池",
    note: "保护池不可用于新开仓 / 加仓 / AUTO 杠杆 / 回撤补仓"
  };
}
