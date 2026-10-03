// paper/money.js · V16 §26 精确金额层(纯函数,无 I/O)
// 问题:账户 cash / margin / fee / pnl 长期用 JS 浮点累加,几千笔之后会出现"分"级漂移,
//       而且 NaN / Infinity / DivisionByZero 一旦写进账本就再也对不上。
// 方案:所有关键金额都可以用【整数最小单位】表示(1 USDT = 10^8 单位),加减完全精确;
//       乘除法按整数四舍五入,误差被限制在单个最小单位以内。
// 注意:本模块不替换现有浮点账本(那是全量重构,风险过高),而是提供:
//       1) 精确运算原语          2) 浮点账本的精确漂移审计(把"漂移了多少"量化出来)
export const MONEY_SCALE = 8;
export const MONEY_UNIT = 100000000; // 1 USDT = 1e8 单位
export const MONEY_MAX_UNITS = Number.MAX_SAFE_INTEGER; // 超出即溢出,拒绝而不是静默变形
export const MONEY_ZERO = 0;
// 账本金额允许的最大漂移(1e-6 USDT):超过就说明浮点已经累积到可见分位
export const MONEY_DRIFT_TOLERANCE_UNITS = 100;

export function moneyFinite(v) {
  const n = Number(v);
  return Number.isFinite(n);
}

// 任意输入 → 最小单位整数;非有限值一律返回 null(绝不落成 0)
export function toUnits(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const u = Math.round(n * MONEY_UNIT);
  if (!Number.isSafeInteger(u)) return null;
  return u;
}

// 最小单位整数 → 浮点 USDT(只用于展示/回写,不再参与累加)
export function fromUnits(u) {
  const n = Number(u);
  if (!Number.isSafeInteger(n)) return null;
  return n / MONEY_UNIT;
}

export function isUnits(v) {
  return Number.isSafeInteger(Number(v));
}

// 精确加/减:任一操作数非法 → null(调用方必须显式处理,而不是当成 0)
export function addUnits(a, b) {
  const x = toUnits(a);
  const y = toUnits(b);
  if (x == null || y == null) return null;
  const s = x + y;
  return Number.isSafeInteger(s) ? s : null;
}

export function subUnits(a, b) {
  const x = toUnits(a);
  const y = toUnits(b);
  if (x == null || y == null) return null;
  const s = x - y;
  return Number.isSafeInteger(s) ? s : null;
}

export function sumUnits(list) {
  let acc = 0;
  for (const v of list || []) {
    const u = toUnits(v);
    if (u == null) return null;
    acc += u;
    if (!Number.isSafeInteger(acc)) return null;
  }
  return acc;
}

// 金额 × 标量(比率/杠杆/比例):整数四舍五入,误差 ≤ 半个最小单位
export function mulScalarUnits(amount, scalar) {
  const u = toUnits(amount);
  const s = Number(scalar);
  if (u == null || !Number.isFinite(s)) return null;
  const r = Math.round(u * s);
  return Number.isSafeInteger(r) ? r : null;
}

// 金额 × 标量 ÷ 标量(标量是普通数字,例如 "名义 × 比例 ÷ 份额")。
// 注意 b/divisor 是普通数值而不是最小单位金额 —— 两个最小单位金额相乘会立刻溢出安全整数。
export function mulDivUnits(a, b, divisor) {
  const x = toUnits(a);
  const bb = Number(b);
  const d = Number(divisor);
  if (x == null || !Number.isFinite(bb) || !Number.isFinite(d) || d === 0) return null;
  const r = Math.round(x * bb / d);
  return Number.isSafeInteger(r) ? r : null;
}

// 精确除法(除数 0 / NaN / Infinity 一律 null —— 这就是 DivideByZero 守卫)
export function divUnits(a, divisor) {
  const x = toUnits(a);
  const d = Number(divisor);
  if (x == null || !Number.isFinite(d) || d === 0) return null;
  const r = Math.round(x / d);
  return Number.isSafeInteger(r) ? r : null;
}

// 比例(units/units → 浮点比率),分母 0 时返回 null
export function ratioUnits(numerator, denominator) {
  const a = toUnits(numerator);
  const b = toUnits(denominator);
  if (a == null || b == null || b === 0) return null;
  return a / b;
}

export function cmpUnits(a, b) {
  const x = toUnits(a);
  const y = toUnits(b);
  if (x == null || y == null) return null;
  return x === y ? 0 : (x > y ? 1 : -1);
}

// 精确相等(最小单位口径);tolerance 以最小单位计
export function eqUnits(a, b, tolerance) {
  const x = toUnits(a);
  const y = toUnits(b);
  if (x == null || y == null) return false;
  return Math.abs(x - y) <= num0(tolerance);
}

function num0(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// 两个浮点序列的"精确累计 vs 浮点累计"漂移审计
// 返回 drift_units / drift_usdt / drift_pct —— 这才是"钱被浮点吃了多少"的量化答案
export function driftOf(values, expected) {
  const exact = sumUnits(values);
  const exp = toUnits(expected);
  if (exact == null || exp == null) {
    return { ok: false, reason: "non_finite_input", exact_units: exact, expected_units: exp, drift_units: null, drift_usdt: null };
  }
  const floatSum = (values || []).reduce((a, v) => a + num0(v), 0);
  const floatUnits = toUnits(floatSum);
  const drift = floatUnits == null ? null : floatUnits - exp;
  return {
    ok: drift != null && Math.abs(drift) <= MONEY_DRIFT_TOLERANCE_UNITS,
    reason: drift == null ? "float_sum_overflow" : (Math.abs(drift) <= MONEY_DRIFT_TOLERANCE_UNITS ? "within_tolerance" : "drift_detected"),
    exact_units: exact,
    expected_units: exp,
    float_units: floatUnits,
    drift_units: drift,
    drift_usdt: drift == null ? null : drift / MONEY_UNIT,
    drift_pct: exp === 0 ? null : (drift == null ? null : drift / exp * 100),
    tolerance_units: MONEY_DRIFT_TOLERANCE_UNITS
  };
}

// 账本精确审计:用整数最小单位重算账户恒等式,把浮点漂移量化出来
//   恒等式(V14.5 已验证):equity = cash + reserved + unrealized
//   Σ(未平仓位 entry_notional) 必须正好等于 account.reserved_balance
// 只做"读+比对",不改写任何历史金额(与 §34 "禁止自动悄悄修改历史资金" 一致)
export function ledgerExactAudit(state) {
  const s = state || {};
  const account = s.account || {};
  const positions = s.positions || [];
  const open = positions.filter((p) => p && (p.status === "OPEN" || p.status === "CLOSING"));
  const violations = [];
  const cash = toUnits(account.cash_balance);
  const reserved = toUnits(account.reserved_balance);
  const unrealized = toUnits(account.unrealized_pnl);
  const equity = toUnits(account.total_equity);
  if (cash == null) violations.push("cash_not_representable");
  if (reserved == null) violations.push("reserved_not_representable");
  if (unrealized == null) violations.push("unrealized_not_representable");
  if (equity == null) violations.push("equity_not_representable");

  let equityDrift = null;
  if (cash != null && reserved != null && unrealized != null && equity != null) {
    equityDrift = (cash + reserved + unrealized) - equity;
    if (Math.abs(equityDrift) > MONEY_DRIFT_TOLERANCE_UNITS) violations.push("equity_identity_drift");
  }

  let reservedSum = 0;
  let reservedSumOk = true;
  for (const p of open) {
    const u = toUnits(p.entry_notional);
    if (u == null) { reservedSumOk = false; violations.push("notional_not_representable:" + (p.position_id || "?")); continue; }
    reservedSum += u;
  }
  let reservedDrift = null;
  if (reservedSumOk && reserved != null) {
    reservedDrift = reservedSum - reserved;
    if (Math.abs(reservedDrift) > MONEY_DRIFT_TOLERANCE_UNITS) violations.push("reserved_reconcile_drift");
  }

  return {
    ok: violations.length === 0,
    violations,
    open_count: open.length,
    equity_drift_units: equityDrift,
    equity_drift_usdt: equityDrift == null ? null : equityDrift / MONEY_UNIT,
    reserved_drift_units: reservedDrift,
    reserved_drift_usdt: reservedDrift == null ? null : reservedDrift / MONEY_UNIT,
    tolerance_units: MONEY_DRIFT_TOLERANCE_UNITS
  };
}

// 展示用:精确格式化(避免 0.30000000000000004 这类浮点尾巴出现在 UI)
export function fmtUnits(v, digits) {
  const u = toUnits(v);
  if (u == null) return "--";
  const d = digits == null ? 8 : digits;
  const scaled = u / Math.pow(10, MONEY_SCALE - d);
  const rounded = Math.round(scaled) / Math.pow(10, d);
  return rounded.toFixed(d).replace(/\.?0+$/, "") || "0";
}
