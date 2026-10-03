// paper/capitalAllocator.js · V16 §3/§5 · 组合资金分配 + 原子预占(纯函数,无 I/O)
// 解决两个真实问题:
//   1) 每笔仓位自己去问"我能花多少钱" → BTC 40% + ETH 40% + SOL 40% = 120% 暴露(假分散)
//   2) 多个候选同时看到同一笔可用现金 → 同一分钱被两笔仓位同时用掉
// 规则:Opportunity Quality → Capital Allocator → Portfolio Risk → Correlation → Volatility
//       → Drawdown State → Approved Size。Risk 只能【向下削减】,永远不能突破 40%。
export const CAPITAL_LIMITS = {
  // 语义(必须分清,禁止用一个数字混淆两者):
  //   - 40% 是【保证金占用】占可交易资金的上限(不是名义暴露)
  //   - 组合合计保证金不得超过可交易资金(=100%):100U 账户不允许出现 120U 保证金
  //   - 名义暴露会因 Paper 杠杆 >100%,那只是"风险敞口",单独展示与告警
  max_single_position_pct: 40,        // 单仓保证金 / 可交易资金
  max_portfolio_margin_pct: 100,      // 全部仓位保证金合计 / 可交易资金
  max_notional_exposure_pct: 300,     // 名义暴露 / 净值(仅展示与告警,不是资金占用上限)
  cluster_same_direction_pct: 80,     // 同一 beta 阵营 + 同方向 的合计占用上限
  high_corr_threshold: 0.75,          // 相关度 ≥ 该值视为同一份风险
  corr_penalty_weight: 1.0,
  min_alloc_pct: 1.0,
  risk_only_reduces: true
};
export const CAPITAL_ALLOCATOR_VERSION = "capital-allocator-v1.1";

// 机会质量 → 允许占用净值比例(中等 15~25%,较高 25~30%,非常高 30~40%,低质量直接 0 = SKIP)
export const ALLOC_LADDER = [
  [0, 0], [45, 0], [60, 15], [75, 25], [88, 30], [100, 40]
];

// 默认阵营(同阵营默认高相关:加密 beta)。真实相关度可用 correlationOf 覆盖。
export const DEFAULT_CLUSTERS = {
  BTCUSDT: "CRYPTO_BETA", ETHUSDT: "CRYPTO_BETA", BNBUSDT: "CRYPTO_BETA", SOLUSDT: "CRYPTO_BETA",
  XRPUSDT: "CRYPTO_BETA", DOGEUSDT: "CRYPTO_BETA", ADAUSDT: "CRYPTO_BETA", LINKUSDT: "CRYPTO_BETA"
};

export const ALLOC_BLOCK_CODES = {
  QUALITY_TOO_LOW: "机会质量不足",
  SINGLE_CAP: "单仓 40% 上限",
  PORTFOLIO_CAP: "组合暴露上限",
  CLUSTER_CAP: "同向相关阵营上限",
  LIQUIDITY_EMPTY: "可用资金不足",
  BELOW_MIN: "低于最小有意义仓位",
  RISK_DOWNGRADE: "风控下调",
  DRAWDOWN_DOWNGRADE: "回撤期下调"
};

function capFnum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}
function capClamp(v, lo, hi) { return Math.min(hi, Math.max(lo, capFnum(v, lo))); }
function capEps() { return 1e-9; }

export function clusterOfSymbol(symbol, clusters) {
  const table = clusters || DEFAULT_CLUSTERS;
  const s = String(symbol || "").toUpperCase();
  return table[s] || "OTHER";
}

// 名义暴露(含杠杆)= Σ 剩余数量 × 现价(拿不到现价时退回建仓名义)
export function notionalExposureOf(positions) {
  let sum = 0;
  for (const p of positions || []) {
    if (!p || (p.status !== "OPEN" && p.status !== "CLOSING")) continue;
    const px = capFnum(p.current_price, capFnum(p.entry_price, 0));
    const qty = capFnum(p.remaining_quantity, capFnum(p.quantity, 0));
    const notional = px > 0 && qty > 0 ? px * qty : capFnum(p.notional, 0);
    sum += notional;
  }
  return sum;
}

// 暴露报告:保证金口径与名义口径必须分开显示,禁止用一个数字混淆
export function exposureReport(input) {
  const o = input || {};
  const equity = Math.max(0, capFnum(o.equity, 0));
  const tradable = Math.max(0, capFnum(o.tradable_capital, equity));
  const expo = effectiveExposure(o.positions, { correlationOf: o.correlationOf, clusters: o.clusters });
  const notional = notionalExposureOf(o.positions);
  const marginPct = tradable > capEps() ? expo.gross_margin / tradable * 100 : null;
  const adjPct = tradable > capEps() ? expo.adjusted_exposure / tradable * 100 : null;
  const notionalPct = equity > capEps() ? notional / equity * 100 : null;
  return {
    margin_exposure_usdt: expo.gross_margin,
    margin_exposure_pct: marginPct,
    correlated_exposure_usdt: expo.adjusted_exposure,
    correlated_exposure_pct: adjPct,
    notional_exposure_usdt: notional,
    notional_exposure_pct: notionalPct,
    tradable_capital: tradable,
    equity: equity,
    over_margin_cap: marginPct != null && marginPct > limits1(),
    over_notional_warn: notionalPct != null && notionalPct > CAPITAL_LIMITS.max_notional_exposure_pct,
    note_zh: "保证金占用不得超过可交易资金;名义暴露因杠杆可超过 100%,仅作风险展示"
  };
}

function limits1() {
  return CAPITAL_LIMITS.max_portfolio_margin_pct;
}

// 机会质量 → 允许占用比例(分段线性,超出上限一律夹到 40)
export function allocationPctForQuality(score) {
  const s = capClamp(score, 0, 100);
  for (let i = 1; i < ALLOC_LADDER.length; i += 1) {
    const [x1, y1] = ALLOC_LADDER[i];
    if (s <= x1) {
      const [x0, y0] = ALLOC_LADDER[i - 1];
      const t = x1 === x0 ? 0 : (s - x0) / (x1 - x0);
      return Math.min(CAPITAL_LIMITS.max_single_position_pct, y0 + (y1 - y0) * t);
    }
  }
  return CAPITAL_LIMITS.max_single_position_pct;
}

// 相关性调整后的有效暴露:高相关仓位不能当完全独立风险
export function effectiveExposure(positions, opts) {
  const o = opts || {};
  const corrOf = o.correlationOf || (() => null);
  const rows = (positions || []).filter((p) => p && (p.status === "OPEN" || p.status === "CLOSING"));
  const byCluster = {};
  let gross = 0;
  let adjusted = 0;
  for (const p of rows) {
    const margin = Math.max(0, capFnum(p.remaining_margin, capFnum(p.entry_notional)));
    const dir = String(p.direction || p.side || "LONG").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
    const cluster = clusterOfSymbol(p.symbol, o.clusters);
    gross += margin;
    let penalty = 0;
    for (const other of rows) {
      if (other === p) continue;
      const otherDir = String(other.direction || other.side || "LONG").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
      if (otherDir !== dir) continue;
      const corrRaw = corrOf(p.symbol, other.symbol);
      const corr = corrRaw == null || corrRaw === ""
        ? null
        : (Number.isFinite(Number(corrRaw)) ? Number(corrRaw) : null);
      const c = corr == null
        ? (clusterOfSymbol(other.symbol, o.clusters) === cluster ? 1 : 0)
        : corr;
      if (c >= CAPITAL_LIMITS.high_corr_threshold) penalty = Math.max(penalty, c);
    }
    const eff = margin * (1 + penalty * CAPITAL_LIMITS.corr_penalty_weight);
    adjusted += eff;
    const key = cluster + "|" + dir;
    byCluster[key] = (byCluster[key] || 0) + eff;
  }
  return { gross_margin: gross, adjusted_exposure: adjusted, by_cluster: byCluster, open_count: rows.length };
}

// 统一资金分配:质量 → 上限 → 组合 → 相关性 → 回撤 → 可用现金
export function capitalAllocation(input) {
  const o = input || {};
  const equity = Math.max(0, capFnum(o.equity));
  const limits = { ...CAPITAL_LIMITS, ...(o.limits || {}) };
  const caps = [];
  const target = { symbol: String(o.symbol || "").toUpperCase(), direction: String(o.direction || "LONG").toUpperCase(), mode: o.mode || null };

  const qualityPct = allocationPctForQuality(capFnum(o.quality_score, 0));
  if (qualityPct <= 0) {
    return { allowed: false, approved_pct: 0, approved_usdt: 0, code: "QUALITY_TOO_LOW", reason: ALLOC_BLOCK_CODES.QUALITY_TOO_LOW, caps_applied: ["QUALITY_TOO_LOW"], detail: { quality_score: capFnum(o.quality_score, 0) } };
  }
  let pct = Math.min(qualityPct, capFnum(o.requested_pct, qualityPct));
  caps.push("QUALITY_LADDER");

  // 单仓硬上限(Risk 只能往下削)
  if (pct >= limits.max_single_position_pct) { pct = limits.max_single_position_pct; caps.push("SINGLE_CAP"); }

  // 组合合计上限(把"新仓"算进去):这里算的是【保证金】,所以上限是可交易资金 100%
  const expo = effectiveExposure(o.positions, { correlationOf: o.correlationOf, clusters: o.clusters });
  const newMargin = equity * pct / 100;
  const room = Math.max(0, equity * limits.max_portfolio_margin_pct / 100 - expo.adjusted_exposure);
  if (newMargin > room) {
    pct = equity > capEps() ? Math.max(0, room / equity * 100) : 0;
    caps.push("PORTFOLIO_CAP");
  }

  // 名义暴露只做告警(杠杆会让它超过 100%,那不是"多花了钱")
  const notionalNow = notionalExposureOf(o.positions);
  const notionalWarn = (notionalNow + newMargin * capFnum(o.leverage, 1)) > equity * limits.max_notional_exposure_pct / 100;

  // 同向相关阵营上限
  const key = clusterOfSymbol(target.symbol, o.clusters) + "|" + target.direction;
  const clusterNow = capFnum(expo.by_cluster[key], 0);
  const clusterRoom = Math.max(0, equity * limits.cluster_same_direction_pct / 100 - clusterNow);
  if (equity * pct / 100 > clusterRoom) {
    pct = equity > capEps() ? Math.max(0, clusterRoom / equity * 100) : 0;
    caps.push("CLUSTER_CAP");
  }

  // 回撤期缩放(只会更小)
  const ddScale = capClamp(o.drawdown_scale == null ? 1 : o.drawdown_scale, 0, 1);
  if (ddScale < 1) { pct *= ddScale; caps.push("DRAWDOWN_DOWNGRADE"); }
  // 波动缩放(只会更小)
  const volScale = capClamp(o.volatility_scale == null ? 1 : o.volatility_scale, 0, 1);
  if (volScale < 1) { pct *= volScale; caps.push("VOLATILITY_DOWNGRADE"); }

  // 可用现金(受保护利润池不在其中)
  const available = Math.max(0, capFnum(o.available_cash));
  const wantUsdt = equity * pct / 100;
  let usdt = wantUsdt;
  if (usdt > available) { usdt = available; caps.push("LIQUIDITY_EMPTY"); }
  if (equity > capEps()) pct = usdt / equity * 100;

  if (pct < limits.min_alloc_pct || usdt <= capEps()) {
    return {
      allowed: false, approved_pct: Math.max(0, pct), approved_usdt: Math.max(0, usdt),
      code: usdt <= capEps() ? "LIQUIDITY_EMPTY" : "BELOW_MIN",
      reason: usdt <= capEps() ? ALLOC_BLOCK_CODES.LIQUIDITY_EMPTY : ALLOC_BLOCK_CODES.BELOW_MIN,
      caps_applied: caps, detail: { quality_pct: qualityPct, available: available, equity: equity }
    };
  }
  return {
    allowed: true,
    approved_pct: pct,
    approved_usdt: usdt,
    code: "OK",
    reason: "分配通过",
    caps_applied: caps,
    detail: {
      quality_pct: qualityPct,
      adjusted_exposure: expo.adjusted_exposure,
      gross_margin: expo.gross_margin,
      cluster_exposure: clusterNow,
      drawdown_scale: ddScale,
      volatility_scale: volScale,
      available: available,
      equity: equity,
      basis: "margin",
      margin_exposure_pct: equity > capEps() ? expo.gross_margin / equity * 100 : null,
      notional_exposure_pct: equity > capEps() ? notionalNow / equity * 100 : null,
      notional_warn: notionalWarn
    }
  };
}

// ---- 原子资金预占 ----
// 同一分钱只允许被一笔仓位使用:reserve 是同步原子操作(JS 单线程内不会被打断),
// 开仓失败必须 release,崩溃后由 sweepOrphanReservations 清理孤儿预占。
export const RESERVE_STATES = ["RESERVED", "COMMITTED", "RELEASED"];
export const RESERVE_DEFAULTS = { ttl_ms: 120000, max_open: 16 };

export function createReserveBook(options) {
  const o = options || {};
  return {
    version: CAPITAL_ALLOCATOR_VERSION,
    available: Math.max(0, capFnum(o.available, 0)),
    reservations: [],
    committed_total: 0,
    released_total: 0,
    rejected: 0,
    seq: 0,
    limits: { ...RESERVE_DEFAULTS, ...(o.limits || {}) }
  };
}

export function openReservations(book) {
  return (book && book.reservations || []).filter((r) => r.state === "RESERVED");
}

export function reservedTotal(book) {
  return openReservations(book).reduce((a, r) => a + capFnum(r.amount), 0);
}

// 原子预占:不足则拒绝(绝不部分预占,避免"半个仓位")
export function reserveCapital(book, req) {
  const r = req || {};
  const amount = capFnum(r.amount, 0);
  if (!book) return { ok: false, reason: "no_book" };
  if (!(amount > 0) || !Number.isFinite(amount)) return { ok: false, reason: "invalid_amount", amount: amount };
  if (openReservations(book).length >= capFnum(book.limits.max_open, RESERVE_DEFAULTS.max_open)) {
    book.rejected += 1;
    return { ok: false, reason: "too_many_open_reservations" };
  }
  if (amount > book.available + capEps()) {
    book.rejected += 1;
    return { ok: false, reason: "insufficient_available", available: book.available, needed: amount };
  }
  book.seq += 1;
  const reservation = {
    intent_id: r.intent_id || ("rsv_" + book.seq),
    symbol: String(r.symbol || "").toUpperCase(),
    mode: r.mode || null,
    direction: r.direction || null,
    amount: amount,
    state: "RESERVED",
    created_at: capFnum(r.now, 0),
    expires_at: capFnum(r.now, 0) + capFnum(r.ttl_ms, book.limits.ttl_ms)
  };
  book.reservations.push(reservation);
  book.available = Math.max(0, book.available - amount);
  return { ok: true, reservation: reservation, available: book.available };
}

export function getReservation(book, intent_id) {
  return (book && book.reservations || []).find((r) => r.intent_id === intent_id) || null;
}

// 成交兑现:账本已经扣过钱,这里只标记兑现,不再动 available(避免双重扣减)
export function commitReserve(book, intent_id, meta) {
  const r = getReservation(book, intent_id);
  if (!r || r.state !== "RESERVED") return { ok: false, reason: "not_reserved" };
  r.state = "COMMITTED";
  r.committed_at = capFnum(meta && meta.now, 0);
  r.actual_amount = meta && meta.actual_amount != null ? capFnum(meta.actual_amount, r.amount) : r.amount;
  book.committed_total += capFnum(r.actual_amount, r.amount);
  return { ok: true, reservation: r };
}

// 释放(开仓失败 / 用户取消 / 数据不可靠):钱必须原样回到可用池
export function releaseReserve(book, intent_id, reason, at) {
  const r = getReservation(book, intent_id);
  if (!r || r.state !== "RESERVED") return { ok: false, reason: "not_reserved" };
  r.state = "RELEASED";
  r.release_reason = reason || "manual_release";
  r.released_at = capFnum(at, 0);
  book.available += capFnum(r.amount);
  book.released_total += capFnum(r.amount);
  return { ok: true, reservation: r, available: book.available };
}

// 孤儿预占清理(崩溃/重启后):超过 TTL 或不在存活意图表里的预占一律归还
export function sweepOrphanReservations(book, opts) {
  const o = opts || {};
  const now = capFnum(o.now, 0);
  const live = new Set(o.live_intent_ids || []);
  const swept = [];
  for (const r of openReservations(book)) {
    const expired = now > 0 && capFnum(r.expires_at) > 0 && now > capFnum(r.expires_at);
    const notLive = live.size > 0 && !live.has(r.intent_id);
    if (!expired && !notLive) continue;
    r.state = "RELEASED";
    r.release_reason = expired ? "orphan_reservation_expired" : "orphan_reservation_not_live";
    book.available += capFnum(r.amount);
    book.released_total += capFnum(r.amount);
    swept.push(r);
  }
  return { swept: swept, count: swept.length, available: book.available };
}

// 预占与账本的对账:预占池 + 已占用 = 账户可用现金(对不上就是重复使用同一分钱)
export function reserveConsistency(book, accountAvailable) {
  const held = reservedTotal(book);
  const expected = capFnum(accountAvailable) - held;
  const drift = Math.abs(capFnum(book && book.available) - expected);
  return {
    ok: drift <= Math.max(1e-6, Math.abs(expected) * 1e-9),
    held: held,
    book_available: capFnum(book && book.available),
    account_available: capFnum(accountAvailable),
    expected_available: expected,
    drift: drift,
    open: openReservations(book).length
  };
}

export function reserveSummary(book) {
  return {
    available: capFnum(book && book.available),
    held: reservedTotal(book),
    open: openReservations(book).length,
    committed_total: capFnum(book && book.committed_total),
    released_total: capFnum(book && book.released_total),
    rejected: capFnum(book && book.rejected)
  };
}

// UI 视图(中文优先)
export function capitalView(info) {
  if (!info) return null;
  return {
    allowed: Boolean(info.allowed),
    approved_pct: info.approved_pct == null ? null : Math.round(info.approved_pct * 100) / 100,
    approved_usdt: info.approved_usdt == null ? null : Math.round(info.approved_usdt * 100) / 100,
    reason_zh: info.reason || (info.allowed ? "分配通过" : "已拒绝"),
    caps_zh: (info.caps_applied || []).map((c) => ALLOC_BLOCK_CODES[c] || c)
  };
}
