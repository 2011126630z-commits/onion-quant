// paper/universeScan.js · V16.2v · 动态币种池扫描(纯函数: tickers + 轻量K线 → 池子与候选短名单)
// 数据诚实原则(§66/§70):
//   · 成交额/涨跌幅/价格 = tickers 真实字段;
//   · spread / depth 在没有真实盘口数据源时【只做保守估算】并显式标注 spread_source="estimated"
//     —— 绝不冒充"真实盘口";估算方向偏保守(宁可低估流动性 = 更严格),不制造虚假宽松。
//   · candles_seen 由真实 K 线根数提供(缺数据 → 0 → WARMING_UP,不放行)。
export const UNIVERSE_SCAN_VERSION = "universe-scan-v1.0";
import { buildUniverse, selectActiveSymbols } from "./symbolUniverse.js";
export const SCAN_LIMITS = {
  scan_max_symbols: 40,      // Level 1:轻量扫描上限(按成交额取前 N)
  shortlist_n: 10,           // Level 2:进入深度分析的上限
  min_price_usdt: 1e-7
};

function usNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}
function usRound(v, d) {
  const p = Math.pow(10, d == null ? 4 : d);
  return Math.round(usNum(v) * p) / p;
}

// 价差估算(bps):成交额越大越小,波动越大越大;缺数据 → null(不奖不罚,交给 evaluateSymbol 的 0.5 分)
export function estimateSpreadBps(input) {
  const o = input || {};
  const qv = usNum(o.quote_volume_usdt, 0);
  if (!(qv > 0)) return null;
  const base = 30 / Math.sqrt(Math.max(qv, 1e4) / 1e6);           // 1e6 额 → 30bps;1e9 额 → ~0.95bps
  const vola = 1 + Math.min(1.5, Math.abs(usNum(o.change_pct_24h, 0)) / 10);
  return usRound(Math.min(60, Math.max(0.3, base * vola)), 2);
}

// 深度估算(USDT):用"近 1/1440 日的成交额 × 15"作为盘口深度的保守代理(整天成交遍布各时段,瞬时深度远小于日额)
export function estimateDepthUsdt(input) {
  const o = input || {};
  const qv = usNum(o.quote_volume_usdt, 0);
  if (!(qv > 0)) return null;
  return Math.round(qv / 1440 * 15);
}

export function isScannableSymbol(symbol) {
  const s = String(symbol || "").toUpperCase();
  return s.endsWith("USDT") && s.indexOf("_") < 0 && s.length >= 6 && s.length <= 24;
}

// ticker → 池子评估指标(带数据来源标注)
export function scanMetrics(ticker, opts) {
  const t = ticker || {};
  const o = opts || {};
  const symbol = String(t.symbol || "").toUpperCase();
  const quoteVolume = usNum(t.quoteVolume, 0);
  const changePct = usNum(t.priceChangePercent, 0);
  const price = usNum(t.lastPrice, 0);
  const candlesSeen = o.candles_seen == null ? 0 : usNum(o.candles_seen, 0);
  const spread = o.spread_bps !== undefined ? o.spread_bps : estimateSpreadBps({ quote_volume_usdt: quoteVolume, change_pct_24h: changePct });
  const depth = o.depth_usdt !== undefined ? o.depth_usdt : estimateDepthUsdt({ quote_volume_usdt: quoteVolume });
  return {
    symbol: symbol,
    price: price > 0 ? price : null,
    quote_volume_usdt: quoteVolume,
    change_pct_24h: changePct,
    spread_bps: spread,
    depth_usdt: depth,
    candles_seen: candlesSeen,
    listing_age_days: o.listing_age_days == null ? null : usNum(o.listing_age_days),
    provider_conflict: o.provider_conflict === true,
    metrics_source: "tickers" + (o.klines_source ? "+" + o.klines_source : ""),
    spread_source: spread == null ? "unavailable" : (o.spread_source || "estimated"),
    depth_source: depth == null ? "unavailable" : (o.depth_source || "estimated"),
    last_price_at: usNum(o.last_price_at, null)
  };
}

// 主入口:一轮动态扫描 → { scan(前 N 指标), universe(池子), shortlist(深度分析名单), counts }
export function buildScan(input) {
  const src = input || {};
  const o = src.opts || {};
  const now = usNum(src.now, 0);
  const limit = Math.max(1, Math.floor(usNum(o.scan_max_symbols, SCAN_LIMITS.scan_max_symbols)));
  const n = Math.max(0, Math.floor(usNum(o.shortlist_n, SCAN_LIMITS.shortlist_n)));
  const klines = src.klinesBySymbol || {};
  const held = (src.holding || []).map((s) => String(s || "").toUpperCase()).filter(Boolean);

  // Level 1:USDT 永续、价格有效、按 24h 成交额降序取前 N
  const rows = (Array.isArray(src.tickers) ? src.tickers : [])
    .filter((t) => t && isScannableSymbol(t.symbol))
    .filter((t) => usNum(t.lastPrice, 0) >= (o.min_price_usdt == null ? SCAN_LIMITS.min_price_usdt : o.min_price_usdt))
    .sort((a, b) => usNum(b.quoteVolume, 0) - usNum(a.quoteVolume, 0));
  // 持仓币即使不在成交额前 N,也必须在池内(绝不允许"持仓被优化掉")
  const top = rows.slice(0, limit);
  const topSet = new Set(top.map((t) => String(t.symbol).toUpperCase()));
  for (const sym of held) {
    if (topSet.has(sym)) continue;
    const row = rows.find((t) => String(t.symbol).toUpperCase() === sym);
    if (row) { top.push(row); topSet.add(sym); }
  }

  const scan = top.map((t) => {
    const symbol = String(t.symbol).toUpperCase();
    const k = klines[symbol];
    const candlesSeen = Array.isArray(k) ? k.length : (k && Number.isFinite(Number(k.candles_seen)) ? Number(k.candles_seen) : 0);
    return scanMetrics(t, {
      candles_seen: candlesSeen,
      klines_source: Array.isArray(k) && k.length ? "klines" : null
    });
  });

  const universe = buildUniverse({ tickers: scan, holding: held });
  const shortlistRows = selectActiveSymbols(universe, n);
  return {
    version: UNIVERSE_SCAN_VERSION,
    at: now,
    source: "tickers" + (Object.keys(klines).length ? "+klines(200/4h)" : ""),
    scanned: scan.length,
    scan: scan,
    universe: universe,
    shortlist: shortlistRows.map((e) => ({ symbol: e.symbol, tier: e.tier, state: e.state, score: e.score, reasons_zh: (e.reasons_zh || []).slice(0, 2) })),
    counts: universeCountsOf(universe, scan.length, shortlistRows.length)
  };
}

function universeCountsOf(universe, scanned, shortlistN) {
  const u = universe || {};
  return {
    scanned: scanned,
    core: (u.core || []).length,
    candidate: (u.candidate || []).length,
    watch: (u.watch || []).length,
    warming_up: (u.warming_up || []).length,
    observe_only: (u.observe_only || []).length,
    suspended: (u.suspended || []).length,
    active: usNum(u.active_count, 0),
    deep_analysis: shortlistN,
    total: (u.all || []).length
  };
}

// 给 UI 的"为什么没进"一行文案(优先"状态类原因",其次门槛原因)
export function primaryReasonZh(entry) {
  const e = entry || {};
  const rs = Array.isArray(e.reasons_zh) ? e.reasons_zh.filter(Boolean) : [];
  const stateZh = { WARMING_UP: "预热中", OBSERVE_ONLY: "未通过", SUSPENDED: "暂停", ACTIVE: "通过" }[e.state] || e.state;
  let detail = rs.find((r) => /未过|异常|冲突|预热中|涨跌幅/.test(String(r))) || rs[0] || "";
  detail = String(detail).replace(/^(核心币|山寨币硬门槛未过:|预热中:|持仓中:)?\s*/, "");
  return { state_zh: stateZh, detail_zh: detail, score: usNum(e.score, 0) };
}
