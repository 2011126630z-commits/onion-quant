// paper/funding.js · V14.3 Funding 费率处理
// 原则(数据真实性优先于 UI):
//   - 费率只能来自上游真实响应(Binance premiumIndex / OKX funding-rate / Bybit tickers)
//   - 取不到就是 unavailable:金额记 0,并单独累计"无法计价的资金费次数",绝不随机生成、绝不用 0 冒充已计费
//   - 只在真实费率可用时结算,且按实际跨过的资金费时间点计数
import { num, round, isSafeAmount } from "./accounting.js";

export const FU_SOURCE = "binance-fapi";
export const FU_DEFAULT_INTERVAL_HOURS = 8;
export const FU_MAX_AGE_MS = 15 * 60000;      // 观测超过 15 分钟视为 stale
// 单期费率绝对值的合理上限(3%/期已远超现实,超出视为异常数据直接丢弃)
export const FU_RATE_SANITY = 0.03;

export const FUNDING_STATUS = { LIVE: "live", STALE: "stale", UNAVAILABLE: "unavailable" };

// 规范化上游响应 → { symbol, rate, interval_hours, next_funding_time, mark_price, provider }
// 任何字段缺失/非有限/超限 → null(调用方按 unavailable 处理)
export function normalizeFunding(raw, options) {
  const opts = options || {};
  const r = raw || {};
  const symbol = String(r.symbol || "").toUpperCase();
  if (!symbol) return null;
  // Binance 用 lastFundingRate;OKX/Bybit 转换层已统一为该字段
  const rateRaw = r.lastFundingRate != null ? r.lastFundingRate : r.fundingRate;
  const rate = Number(rateRaw);
  if (!Number.isFinite(rate)) return null;
  if (Math.abs(rate) > FU_RATE_SANITY) return null;
  const nextRaw = r.nextFundingTime != null ? r.nextFundingTime : r.nextFundingTimestamp;
  const next = Number(nextRaw);
  const intervalRaw = Number(r.fundingIntervalHours);
  const interval = Number.isFinite(intervalRaw) && intervalRaw > 0 && intervalRaw <= 24 ? intervalRaw : num(opts.interval_hours, FU_DEFAULT_INTERVAL_HOURS);
  const mark = Number(r.markPrice);
  return {
    symbol,
    rate,
    rate_pct: round(rate * 100, 6),
    interval_hours: interval,
    next_funding_time: Number.isFinite(next) && next > 0 ? next : null,
    mark_price: Number.isFinite(mark) && mark > 0 ? mark : null,
    provider: String(r.provider || opts.provider || FU_SOURCE)
  };
}

// 一批 ticker 里带 fundingRate 的场景(Bybit tickers / 全市场 tickers)
export function normalizeFundingList(list) {
  const out = {};
  for (const row of (list || [])) {
    const n = normalizeFunding(row);
    if (n) out[n.symbol] = n;
  }
  return out;
}

// 资金费支付方向:正费率 → 多头付给空头;负费率 → 空头付给多头
// 返回"以 USDT 计的资金费现金流":正数 = 账户收到,负数 = 账户支出
export function fundingCashflow(position, rate, notional) {
  const n = num(notional, 0);
  const r = num(rate, 0);
  if (!(n > 0) || !isSafeAmount(n)) return 0;
  const side = String(position && position.side || "").toUpperCase();
  if (side !== "LONG" && side !== "SHORT") return 0;
  const longPays = r > 0;
  const isLong = side === "LONG";
  const pays = isLong ? longPays : !longPays;
  return round((pays ? -1 : 1) * Math.abs(r) * n, 8);
}

// ---- 费率观测簿(内存;由引擎/页面在每次拿到上游数据时喂入) ----
export function createFundingBook(options) {
  const opts = options || {};
  const clock = () => num(opts.now ? opts.now() : Date.now());
  const entries = new Map();   // symbol -> { status, normalized, observed_at, reason }
  const counters = { observed: 0, rejected: 0, unavailable_marked: 0 };

  function observe(symbol, payload, meta) {
    const m = meta || {};
    // payload 既可以是原始上游响应,也可以是已规范化的对象
    const normalized = payload && payload.rate != null && payload.rate_pct != null
      ? payload
      : normalizeFunding(payload, { provider: m.provider });
    if (!normalized) {
      counters.rejected += 1;
      entries.set(String(symbol).toUpperCase(), { status: FUNDING_STATUS.UNAVAILABLE, normalized: null, observed_at: clock(), reason: m.reason || "invalid_payload" });
      counters.unavailable_marked += 1;
      return { ok: false, reason: "invalid_payload", status: FUNDING_STATUS.UNAVAILABLE };
    }
    counters.observed += 1;
    entries.set(normalized.symbol, { status: FUNDING_STATUS.LIVE, normalized, observed_at: clock(), reason: "ok" });
    return { ok: true, status: FUNDING_STATUS.LIVE, normalized };
  }

  // 上游失败:显式标记 unavailable(带上真实原因),不保留"看起来可用"的假象
  function markUnavailable(symbol, reason) {
    const key = String(symbol).toUpperCase();
    entries.set(key, { status: FUNDING_STATUS.UNAVAILABLE, normalized: null, observed_at: clock(), reason: String(reason || "upstream_unavailable") });
    counters.unavailable_marked += 1;
    return { status: FUNDING_STATUS.UNAVAILABLE, reason: reason || "upstream_unavailable" };
  }

  function statusOf(symbol) {
    const key = String(symbol).toUpperCase();
    const entry = entries.get(key);
    if (!entry) return { symbol: key, status: FUNDING_STATUS.UNAVAILABLE, rate: null, rate_pct: null, age_ms: null, reason: "never_observed", next_funding_time: null, provider: null };
    const age = clock() - num(entry.observed_at, 0);
    if (entry.status !== FUNDING_STATUS.LIVE) {
      return { symbol: key, status: FUNDING_STATUS.UNAVAILABLE, rate: null, rate_pct: null, age_ms: age, reason: entry.reason, next_funding_time: null, provider: null };
    }
    const stale = age > num(opts.max_age_ms, FU_MAX_AGE_MS);
    return {
      symbol: key,
      status: stale ? FUNDING_STATUS.STALE : FUNDING_STATUS.LIVE,
      rate: stale ? null : entry.normalized.rate,
      rate_pct: stale ? null : entry.normalized.rate_pct,
      age_ms: age,
      reason: stale ? "observation_stale" : "ok",
      next_funding_time: entry.normalized.next_funding_time,
      interval_hours: entry.normalized.interval_hours,
      provider: entry.normalized.provider
    };
  }

  function snapshot() {
    const out = [];
    for (const [symbol] of entries) out.push({ symbol, ...statusOf(symbol) });
    return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  return { observe, markUnavailable, statusOf, snapshot, counters: () => ({ ...counters, symbols: entries.size }) };
}

// ---- 资金费结算(挂机跨过资金费时间点时调用) ----
// 只结算"真实费率可见"的部分;不可见的区间单独计数,绝不用 0 或随机值糊过去
export function accrueFunding(position, book, options) {
  const opts = options || {};
  const now = num(opts.now, Date.now());
  const symbol = String(position && position.symbol || "").toUpperCase();
  const notional = num(opts.notional != null ? opts.notional : position && position.notional, 0);
  const lastSettled = num(position && position.last_funding_time, num(position && position.entry_time, now));
  const intervalMs = num(opts.interval_ms, FU_DEFAULT_INTERVAL_HOURS * 3600000);
  const status = book ? book.statusOf(symbol) : { status: FUNDING_STATUS.UNAVAILABLE, rate: null, reason: "no_book" };

  // 跨过的资金费时间点(按小时对齐的固定节奏)
  const step = intervalMs > 0 ? intervalMs : FU_DEFAULT_INTERVAL_HOURS * 3600000;
  const firstBoundary = Math.floor(lastSettled / step) * step + step;
  const boundaries = [];
  for (let t = firstBoundary; t <= now && boundaries.length < 96; t += step) boundaries.push(t);

  const base = {
    symbol,
    intervals_crossed: boundaries.length,
    rate: status.rate,
    rate_pct: status.rate_pct,
    provider: status.provider || null,
    next_funding_time: status.next_funding_time || null,
    // 无论能否计价,只要跨过了时间点就把资金费时钟推进(避免同一期被反复计数)
    settled_until: boundaries.length ? boundaries[boundaries.length - 1] : null
  };

  if (!boundaries.length) {
    return { ...base, applicable: false, amount: 0, status: FUNDING_STATUS.LIVE, reason: "no_interval_crossed", missed_intervals: 0 };
  }
  if (status.status !== FUNDING_STATUS.LIVE || status.rate == null) {
    // 取不到费率:金额记 0,但把"无法计价的次数"如实上报(供 UI 显示 unavailable)
    return { ...base, applicable: false, amount: 0, status: FUNDING_STATUS.UNAVAILABLE, reason: status.reason || "rate_unavailable", missed_intervals: boundaries.length };
  }
  const perInterval = fundingCashflow(position, status.rate, notional);
  const amount = round(perInterval * boundaries.length, 8);
  return {
    ...base,
    applicable: true,
    amount,
    status: FUNDING_STATUS.LIVE,
    reason: "ok",
    missed_intervals: 0
  };
}

// 把结算结果落到仓位字段(引擎调用;失败/不可用时不改金额,只标状态)
export function applyFundingToPosition(position, result) {
  const pos = position || {};
  const r = result || {};
  const prevAmount = num(pos.funding_simulated, 0);
  const prevMissed = num(pos.funding_missed_intervals, 0);
  const status = r.status || FUNDING_STATUS.UNAVAILABLE;
  return {
    ...pos,
    funding_simulated: r.applicable ? round(prevAmount + num(r.amount, 0), 8) : prevAmount,
    funding_status: status,
    funding_source: r.provider || null,
    funding_rate: r.rate == null ? null : r.rate,
    funding_rate_pct: r.rate_pct == null ? null : r.rate_pct,
    funding_intervals: num(pos.funding_intervals, 0) + (r.applicable ? r.intervals_crossed : 0),
    funding_missed_intervals: prevMissed + num(r.missed_intervals, 0),
    last_funding_time: r.settled_until != null ? r.settled_until : (r.intervals_crossed ? num(pos.last_funding_time, null) : pos.last_funding_time),
    funding_updated_at: r.applicable || r.missed_intervals ? Date.now() : pos.funding_updated_at
  };
}

// UI 文案:不显示"0.00"来暗示已计费
export function fundingLabel(position) {
  const pos = position || {};
  const status = pos.funding_status || FUNDING_STATUS.UNAVAILABLE;
  if (status === FUNDING_STATUS.LIVE) return "资金费 " + num(pos.funding_simulated, 0).toFixed(4) + " USDT · " + num(pos.funding_intervals, 0) + " 期";
  if (status === FUNDING_STATUS.STALE) return "资金费 费率过期";
  const missed = num(pos.funding_missed_intervals, 0);
  return "资金费 unavailable" + (missed ? "(缺 " + missed + " 期费率)" : "");
}
