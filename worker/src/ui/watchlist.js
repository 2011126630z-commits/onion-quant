// ui/watchlist.js · V16.2s · 统一自选 Store(纯逻辑,不碰 DOM,无直接 I/O)
// 单一事实来源:市场列表 / 币种详情 / 搜索结果 / 旧自选页 全部走这一套接口。
//   - 去重:同一 symbol 只允许一条;非法 symbol 拒绝(不静默吞掉,返回明确 reason);
//   - 持久化由外部注入的 storage 适配器完成;写入失败必须显式上报(persist_failed),
//     由 UI 决定"提示 + 回滚",绝不允许静默丢数据;
//   - subscribe 通知变更,UI 侧做 optimistic 更新(先改状态再持久化,失败回滚);
//   - 本模块不接触 window/document,可在 Node 直接测试。
export const WATCHLIST_VERSION = "watchlist-v1.0";
export const WATCHLIST_STORAGE_KEY = "watchSymbols";
export const WATCHLIST_LIMIT = 100;

// 与市场列表同口径:只收 USDT 交易对(BTCUSDT / 1000PEPEUSDT 等)
export function normalizeWatchSymbol(raw) {
  const s = String(raw == null ? "" : raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!s || s.length < 6 || s.length > 24) return null;
  if (!s.endsWith("USDT")) return null;
  return s;
}

export function watchlistDisplay(symbol) {
  const s = String(symbol || "");
  return s.endsWith("USDT") ? s.slice(0, -4) + "/USDT" : s;
}

export function createWatchlistStore(options) {
  const o = options || {};
  const storage = o.storage || null;      // { getItem(key), setItem(key, value) } 或 null(纯内存,测试用)
  const key = String(o.key || WATCHLIST_STORAGE_KEY);
  const limit = Number.isFinite(o.limit) ? Math.max(1, Math.floor(o.limit)) : WATCHLIST_LIMIT;
  const clock = typeof o.now === "function" ? o.now : () => Date.now();

  let items = [];
  let seq = 0;
  let persistFailures = 0;
  let lastError = null;
  let loadedFrom = "empty";
  const listeners = [];

  function notify(reason, extra) {
    seq += 1;
    const payload = { items: items.slice(), version: seq, reason: reason, at: clock(), ...(extra || {}) };
    for (const fn of listeners.slice()) {
      try { fn(payload); } catch (error) { /* 单个订阅者抛错不影响其它订阅者 */ }
    }
    return payload;
  }

  function load() {
    if (!storage) { loadedFrom = "memory"; return { ok: true, count: items.length, from: loadedFrom }; }
    try {
      const raw = storage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : [];
      const seen = new Set();
      const next = [];
      for (const x of Array.isArray(parsed) ? parsed : []) {
        const s = normalizeWatchSymbol(x);
        if (!s || seen.has(s)) continue;
        seen.add(s);
        next.push(s);
        if (next.length >= limit) break;
      }
      items = next;
      loadedFrom = raw ? "storage" : "empty";
      return { ok: true, count: items.length, from: loadedFrom };
    } catch (error) {
      lastError = String((error && error.message) || error);
      loadedFrom = "error";
      return { ok: false, count: items.length, from: loadedFrom, error: lastError };
    }
  }

  function persist() {
    if (!storage) return { ok: true, mode: "memory" };
    try {
      storage.setItem(key, JSON.stringify(items));
      return { ok: true, mode: "storage" };
    } catch (error) {
      persistFailures += 1;
      lastError = String((error && error.message) || error);
      return { ok: false, mode: "storage", error: lastError };
    }
  }

  function has(symbol) {
    const s = normalizeWatchSymbol(symbol);
    return Boolean(s) && items.includes(s);
  }
  function list() { return items.slice(); }

  function add(symbol) {
    const s = normalizeWatchSymbol(symbol);
    if (!s) return { ok: false, reason: "invalid_symbol", added: false, items: list() };
    if (items.includes(s)) return { ok: true, reason: "already_present", added: false, items: list() };
    if (items.length >= limit) return { ok: false, reason: "limit_reached", added: false, items: list(), limit: limit };
    const prev = items;
    items = items.concat([s]);
    notify("add", { symbol: s });                    // optimistic:UI 先动
    const p = persist();
    if (!p.ok) {
      items = prev;
      notify("rollback", { symbol: s, reason: "persist_failed" });
      return { ok: false, reason: "persist_failed", added: true, rolled_back: true, symbol: s, error: p.error || null, items: list() };
    }
    return { ok: true, reason: "added", added: true, symbol: s, items: list() };
  }

  function remove(symbol) {
    const s = normalizeWatchSymbol(symbol);
    if (!s || !items.includes(s)) return { ok: true, reason: "not_present", removed: false, items: list() };
    const prev = items;
    items = items.filter((x) => x !== s);
    notify("remove", { symbol: s });                 // optimistic:UI 先动
    const p = persist();
    if (!p.ok) {
      items = prev;
      notify("rollback", { symbol: s, reason: "persist_failed" });
      return { ok: false, reason: "persist_failed", removed: true, rolled_back: true, symbol: s, error: p.error || null, items: list() };
    }
    return { ok: true, reason: "removed", removed: true, symbol: s, items: list() };
  }

  function toggle(symbol) {
    return has(symbol) ? remove(symbol) : add(symbol);
  }

  // 持久化失败后的显式回滚(调用方拿到 persist_failed 后用上次快照恢复)
  function restore(snapshot) {
    const seen = new Set();
    const next = [];
    for (const x of Array.isArray(snapshot) ? snapshot : []) {
      const s = normalizeWatchSymbol(x);
      if (!s || seen.has(s)) continue;
      seen.add(s);
      next.push(s);
    }
    items = next;
    notify("restore", {});
    return { ok: true, items: list() };
  }

  function subscribe(fn) {
    if (typeof fn !== "function") return () => false;
    listeners.push(fn);
    return () => {
      const idx = listeners.indexOf(fn);
      if (idx >= 0) listeners.splice(idx, 1);
      return idx >= 0;
    };
  }

  function stats() {
    return {
      version: WATCHLIST_VERSION,
      count: items.length,
      seq: seq,
      loaded_from: loadedFrom,
      persist_failures: persistFailures,
      last_error: lastError,
      storage: storage ? "bound" : "memory"
    };
  }

  function view() {
    return {
      version: WATCHLIST_VERSION,
      items: list(),
      count: items.length,
      headline_zh: items.length ? ("自选 " + items.length + " 个币种") : "还没有自选币种",
      empty_hint_zh: "可以在市场中点击 ☆ 添加。",
      persist_failures: persistFailures,
      last_error: lastError
    };
  }

  load();

  return {
    version: WATCHLIST_VERSION,
    list: list,
    has: has,
    add: add,
    remove: remove,
    toggle: toggle,
    restore: restore,
    subscribe: subscribe,
    reload: load,
    stats: stats,
    view: view,
    limit: limit
  };
}
