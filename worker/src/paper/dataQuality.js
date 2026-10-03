// paper/dataQuality.js · Data Quality Sentinel(数据质量哨兵)
// 目的:在"写进持仓/用于决策"之前统一体检行情数据:过期/缺失/乱序/重复/0价/NaN/Inf/
//      Provider 冲突/异常跳变/外部数据过期。质量不达标 → 禁止新 Entry,但已有持仓继续被风险管理。
// 原则:哨兵只报告与拦截,不修改任何数字(绝不用"猜一个价"来修复数据)。
import { num, numOrNull, round, isSafeAmount } from "./accounting.js";

export const DQ_SEVERITY = { OK: 0, WARN: 1, BLOCK: 2 };

export const DQ_DEFAULTS = {
  stale_ms: 5 * 60000,          // 报价超过 5 分钟视为过期
  candle_stale_ms: 3 * 3600000, // K线超过 3 个周期未更新视为缺口
  abnormal_jump_pct: 15,        // 单次跳动超过 15% 视为异常(需人工确认,不写价)
  external_stale_ms: 30 * 60000,
  max_issues: 50
};

function issue(code, severity, detail) {
  return { code, severity, detail: detail || null, at: Date.now() };
}

// 单条报价体检:返回 { ok, severity, issues }
export function inspectQuote(quote, ctx) {
  const cfg = { ...DQ_DEFAULTS, ...((ctx && ctx.config) || {}) };
  const nowMs = num(ctx && ctx.now, Date.now());
  const q = quote || {};
  const issues = [];
  const price = numOrNull(q.price);
  if (price == null) issues.push(issue("price_not_numeric", DQ_SEVERITY.BLOCK, { price: q.price }));
  else if (!Number.isFinite(Number(price)) || !isSafeAmount(price)) issues.push(issue("price_zero_or_negative", DQ_SEVERITY.BLOCK, { price }));
  const received = numOrNull(q.received_at);
  if (received != null && nowMs - received > cfg.stale_ms) issues.push(issue("stale_quote", DQ_SEVERITY.BLOCK, { age_ms: nowMs - received }));
  if (received != null && received > nowMs + 5000) issues.push(issue("future_timestamp", DQ_SEVERITY.WARN, { received_at: received }));
  if (q.symbol != null && String(q.symbol).length === 0) issues.push(issue("empty_symbol", DQ_SEVERITY.BLOCK));
  if (ctx && ctx.expectSymbol && q.symbol && String(q.symbol).toUpperCase() !== String(ctx.expectSymbol).toUpperCase()) {
    issues.push(issue("provider_symbol_conflict", DQ_SEVERITY.BLOCK, { expect: ctx.expectSymbol, got: q.symbol }));
  }
  // 异常跳变:与上次可信价比,单次跳动超过阈值 → 先拦下(可能串价/插针)。
  // 但上次价格本身已经过期(如引擎停了几小时)时只提示,不阻断 —— 否则会永久卡死。
  const last = numOrNull(ctx && ctx.lastPrice);
  if (cfg.abnormal_jump_pct > 0 && last != null && last > 0 && price != null && price > 0) {
    const jump = Math.abs(price - last) / last * 100;
    if (jump > cfg.abnormal_jump_pct) {
      const lastAt = numOrNull(ctx && ctx.lastPriceAt);
      const fresh = lastAt != null && nowMs - lastAt <= cfg.stale_ms;
      issues.push(issue("abnormal_jump", fresh ? DQ_SEVERITY.BLOCK : DQ_SEVERITY.WARN, { from: last, to: price, jump_pct: round(jump, 4), last_fresh: fresh }));
    }
  }
  const severity = issues.reduce((a, b) => Math.max(a, b.severity), DQ_SEVERITY.OK);
  return { ok: severity < DQ_SEVERITY.BLOCK, severity, issues };
}

// K线体检:顺序/重复/时间戳/0价/缺口(Binance 数组形状 [openTime, o, h, l, c, v, ...])
export function inspectCandles(candles, ctx) {
  const list = Array.isArray(candles) ? candles : [];
  const issues = [];
  const intervalMs = num(ctx && ctx.intervalMs, 3600000);
  if (!list.length) return { ok: false, severity: DQ_SEVERITY.BLOCK, issues: [issue("missing_candle", DQ_SEVERITY.BLOCK, { count: 0 })] };
  let prevOpen = null;
  const seen = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i];
    const openTime = num(Array.isArray(c) ? c[0] : c && c.openTime, 0);
    const o = num(Array.isArray(c) ? c[1] : c && c.open, 0);
    const h = num(Array.isArray(c) ? c[2] : c && c.high, 0);
    const l = num(Array.isArray(c) ? c[3] : c && c.low, 0);
    const cl = num(Array.isArray(c) ? c[4] : c && c.close, 0);
    if (!(openTime > 0)) issues.push(issue("candle_bad_timestamp", DQ_SEVERITY.BLOCK, { index: i, openTime }));
    if (seen.has(openTime)) issues.push(issue("duplicate_candle", DQ_SEVERITY.BLOCK, { index: i, openTime }));
    seen.add(openTime);
    if (prevOpen != null && openTime <= prevOpen) issues.push(issue("timestamp_disorder", DQ_SEVERITY.BLOCK, { index: i, openTime, prevOpen }));
    if (prevOpen != null && openTime - prevOpen > intervalMs * 1.5) issues.push(issue("candle_gap", DQ_SEVERITY.WARN, { index: i, gap_ms: openTime - prevOpen }));
    prevOpen = openTime;
    if (!isSafeAmount(o) || !isSafeAmount(h) || !isSafeAmount(l) || !isSafeAmount(cl)) issues.push(issue("candle_zero_or_nan_price", DQ_SEVERITY.BLOCK, { index: i }));
    if (h < l) issues.push(issue("candle_high_below_low", DQ_SEVERITY.BLOCK, { index: i }));
  }
  const severity = issues.reduce((a, b) => Math.max(a, b.severity), DQ_SEVERITY.OK);
  return { ok: severity < DQ_SEVERITY.BLOCK, severity, issues, count: list.length };
}

// 外部情报/缓存体检:过期的 unavailable 或过期数据都要能被看见
export function inspectExternal(entries, ctx) {
  const cfg = { ...DQ_DEFAULTS, ...((ctx && ctx.config) || {}) };
  const nowMs = num(ctx && ctx.now, Date.now());
  const issues = [];
  const list = Array.isArray(entries) ? entries : Object.values(entries || {});
  for (const e of list) {
    if (!e) continue;
    const age = nowMs - num(e.at, nowMs);
    if (e.source === "unavailable" || e.value == null) issues.push(issue("external_unavailable", DQ_SEVERITY.WARN, { key: e.key, error: e.error || null }));
    else if (age > cfg.external_stale_ms) issues.push(issue("external_stale", DQ_SEVERITY.WARN, { key: e.key, age_ms: age }));
  }
  const severity = issues.reduce((a, b) => Math.max(a, b.severity), DQ_SEVERITY.OK);
  // 外部数据问题不阻断交易(只降级提示),除非显式要求
  return { ok: true, severity, issues, blocking: false };
}

// 哨兵实例:汇集最近一次各类检查结果,给 Risk Controller 与 UI 读取
export function createDataQualitySentinel(options) {
  const opts = options || {};
  const cfg = { ...DQ_DEFAULTS, ...(opts.config || {}) };
  const now = () => num(opts.now ? opts.now() : Date.now());
  const state = {
    quote: null,
    candles: null,
    external: null,
    block_entries: false,
    issues: [],
    checks: 0,
    last_check_at: null
  };
  function remember(kind, result) {
    state[kind] = { ok: result.ok, severity: result.severity, issue_count: result.issues.length, at: now() };
    state.checks += 1;
    state.last_check_at = now();
    for (const it of result.issues) state.issues.push({ ...it, kind });
    if (state.issues.length > cfg.max_issues) state.issues = state.issues.slice(-cfg.max_issues);
    // 阻断规则:报价或K线级 BLOCK → 禁止新 Entry;外部数据只提示
    const blocking = (state.quote && state.quote.severity >= DQ_SEVERITY.BLOCK)
      || (state.candles && state.candles.severity >= DQ_SEVERITY.BLOCK);
    state.block_entries = Boolean(blocking);
    return result;
  }
  return {
    config: cfg,
    checkQuote: (quote, ctx) => remember("quote", inspectQuote(quote, { now: now(), config: cfg, ...(ctx || {}) })),
    checkCandles: (candles, ctx) => remember("candles", inspectCandles(candles, { intervalMs: ctx && ctx.intervalMs })),
    checkExternal: (entries, ctx) => remember("external", inspectExternal(entries, { now: now(), config: cfg, ...(ctx || {}) })),
    state: () => ({
      ok: !state.block_entries,
      block_entries: state.block_entries,
      quote: state.quote,
      candles: state.candles,
      external: state.external,
      checks: state.checks,
      last_check_at: state.last_check_at,
      recent_issues: state.issues.slice(-8)
    }),
    // 给 Risk Controller 用的最小输入
    gate: () => ({ ok: !state.block_entries, block_entries: state.block_entries }),
    reset: () => { state.issues = []; state.block_entries = false; state.quote = null; state.candles = null; state.external = null; },
    // UI 文案(普通用户不需要看日志,只看结论)
    summaryText: () => {
      if (state.block_entries) return "行情数据异常,已暂停新开仓(现有持仓继续管理)";
      const warn = state.issues.filter((i) => i.severity === DQ_SEVERITY.WARN).length;
      return warn ? "行情数据可用(有 " + warn + " 条提示)" : "行情数据正常";
    }
  };
}
