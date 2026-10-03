// paper/dataHub.js · 统一数据中枢(V14.4)
// §12/§13/§64:所有外部数据(含行情)必须走这里,禁止每个模块各自重复请求。
//   - Cache Key = provider | symbol | data_type | interval
//   - 每条记录带 TTL / timestamp / source / freshness,超上限按最旧淘汰
//   - 同 key 并发请求合并(in-flight dedup):一次取数,多方复用
//   - 取不到就是 unavailable(带真实原因),绝不用旧值冒充新值
import { num, round } from "./accounting.js";

// §13:不同数据不同 TTL,不要每秒全部刷新
export const DATA_TTLS = {
  price: 5000,
  klines: 20000,
  mark_price: 10000,
  index_price: 10000,
  funding: 60000,
  open_interest: 45000,
  long_short_ratio: 90000,
  taker_flow: 90000,
  liquidations: 120000,
  breadth: 30000,
  news: 900000,        // 低频:15 分钟
  macro: 3600000,      // 极低频:1 小时
  research: 1800000
};
export const DATAHUB_DEFAULTS = { max_entries: 300, default_ttl: 30000 };

function ageOf(entry, now) {
  return entry ? Math.max(0, num(now, Date.now()) - num(entry.at, 0)) : null;
}

// freshness:1 = 刚取到,0 = 已过期数倍
export function freshnessOf(entry, type, now) {
  if (!entry) return 0;
  const ttl = num(entry.ttl, DATA_TTLS[type] || DATAHUB_DEFAULTS.default_ttl);
  const age = ageOf(entry, now);
  if (ttl <= 0) return 0;
  return round(Math.max(0, 1 - age / ttl), 4);
}

export function createDataHub(options) {
  const opts = { ...DATAHUB_DEFAULTS, ...(options || {}) };
  const clock = () => num(opts.now ? opts.now() : Date.now());
  const store = new Map();       // key -> { value, at, ttl, source, provider, symbol, data_type, interval, error }
  const inflight = new Map();    // key -> Promise
  const stats = { hits: 0, misses: 0, sets: 0, stale_hits: 0, evictions: 0, dedup: 0, failures: 0 };

  function keyOf(input) {
    const i = typeof input === "string" ? { data_type: input } : (input || {});
    // §4 缓存键必须完整:provider|symbol|data_type|interval。
    // 不再允许调用方自带 key 绕过 symbol —— 那正是跨 symbol 串价的隐患之一。
    return [i.provider || "unknown", i.symbol || "-", i.data_type || "-", i.interval || "-"].join("|");
  }

  function set(input, value, meta) {
    const i = typeof input === "string" ? { key: input } : (input || {});
    const m = meta || i;
    const key = keyOf(i);
    const type = m.data_type || i.data_type || "-";
    store.set(key, {
      key,
      value,
      at: clock(),
      ttl: num(m.ttl, DATA_TTLS[type] || opts.default_ttl),
      source: m.source || i.source || "unknown",
      provider: m.provider || i.provider || null,
      symbol: m.symbol || i.symbol || null,
      data_type: type,
      interval: m.interval || i.interval || null,
      error: null
    });
    stats.sets += 1;
    evict();
    return store.get(key);
  }

  // 明确标记"取不到":保留失败事实,不写假值
  function markUnavailable(input, reason, meta) {
    const i = typeof input === "string" ? { key: input } : (input || {});
    const m = meta || {};
    const key = keyOf(i);
    const entry = {
      key,
      value: null,
      at: clock(),
      ttl: num(m.ttl, DATA_TTLS[i.data_type] || opts.default_ttl),
      source: "unavailable",
      provider: i.provider || null,
      symbol: i.symbol || null,
      data_type: i.data_type || "-",
      interval: i.interval || null,
      error: String(reason || "unavailable")
    };
    store.set(key, entry);
    stats.failures += 1;
    evict();
    return entry;
  }

  function get(input, options) {
    const o = options || {};
    const key = keyOf(input);
    const entry = store.get(key) || null;
    const now = clock();
    if (!entry || entry.value == null) {
      stats.misses += 1;
      return { ok: false, reason: entry && entry.error ? entry.error : "miss", entry, key };
    }
    const age = ageOf(entry, now);
    const fresh = age <= num(entry.ttl, opts.default_ttl);
    if (!fresh && !o.allowStale) {
      stats.misses += 1;
      return { ok: false, reason: "stale", entry, key, age_ms: age, ttl_ms: entry.ttl };
    }
    if (!fresh && o.allowStale) stats.stale_hits += 1;
    else stats.hits += 1;
    return {
      ok: true,
      stale: !fresh,
      value: entry.value,
      entry,
      key,
      age_ms: age,
      ttl_ms: entry.ttl,
      freshness: freshnessOf(entry, entry.data_type, now),
      source: entry.source,
      timestamp: entry.at
    };
  }

  // 取数(带合并与写回):fn 返回 { value } 或直接返回值;抛错 → markUnavailable
  async function fetchOnce(input, fn, meta) {
    const i = typeof input === "string" ? { key: input } : (input || {});
    const m = { ...i, ...(meta || {}) };
    const key = keyOf(i);
    const cached = get(i);
    if (cached.ok) return cached;
    if (inflight.has(key)) {
      stats.dedup += 1;
      return inflight.get(key);
    }
    const p = (async () => {
      try {
        const out = await fn();
        const value = out && typeof out === "object" && "value" in out && Object.keys(out).length === 1 ? out.value : out;
        set(i, value, m);
        return get(i);
      } catch (error) {
        markUnavailable(i, (error && error.message) || String(error), m);
        return { ok: false, reason: (error && error.message) || "fetch_failed", entry: store.get(key) || null, key };
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }

  function evict() {
    if (store.size <= num(opts.max_entries, 300)) return;
    const entries = [...store.values()].sort((a, b) => num(a.at) - num(b.at));
    const drop = store.size - num(opts.max_entries, 300);
    for (let i = 0; i < drop; i += 1) {
      store.delete(entries[i].key);
      stats.evictions += 1;
    }
  }

  function snapshot() {
    const now = clock();
    return [...store.values()].map((e) => ({
      key: e.key,
      provider: e.provider,
      symbol: e.symbol,
      data_type: e.data_type,
      interval: e.interval,
      source: e.source,
      timestamp: e.at,
      ttl_ms: e.ttl,
      age_ms: ageOf(e, now),
      freshness: freshnessOf(e, e.data_type, now),
      available: e.value != null,
      error: e.error
    })).sort((a, b) => String(a.key).localeCompare(String(b.key)));
  }

  function statsOf() {
    return { ...stats, entries: store.size, inflight: inflight.size, max_entries: opts.max_entries };
  }

  return { keyOf, set, get, markUnavailable, fetchOnce, snapshot, stats: statsOf, clear: () => store.clear(), size: () => store.size };
}
