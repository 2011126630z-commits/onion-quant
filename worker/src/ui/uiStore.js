// ui/uiStore.js · V16.1 §5 · 真正的 UI State Store(纯逻辑,不碰 DOM,无 I/O)
// 解决"旧快照把已经平掉的仓位又显示回来"这类 UI 回退事故:
//   - 每个 bucket 独立持有 {data, state_version, updated_at};
//   - set / patch 受版本保护:传入 state_version ≤ 当前版本 → 直接拒绝(stale_version);
//   - subscribe / subscribeMany 只通知订阅了该 bucket 的回调 —— 价格变化不会惊动仓位订阅者;
//   - shouldRender(prev, next) 只在版本严格更大时返回 true;
//   - 本模块只做状态与订阅,不接触 window/document,便于在 Worker 与 Node 里直接测试。
export const UI_STORE_VERSION = "ui-store-v1.0";

// 固定的 UI 状态分桶(顺序即展示顺序)
export const UI_BUCKETS = [
  "accountState",
  "capitalState",
  "positionState",
  "marketState",
  "chartState",
  "riskState",
  "predictionState",
  "learningState",
  "runtimeHealthState",
  "notificationState",
  "diagnosticState"
];
export const UI_BUCKET_ZH = {
  accountState: "账户状态",
  capitalState: "资金状态",
  positionState: "持仓状态",
  marketState: "行情状态",
  chartState: "图表状态",
  riskState: "风控状态",
  predictionState: "预测状态",
  learningState: "学习状态",
  runtimeHealthState: "运行时健康",
  notificationState: "通知状态",
  diagnosticState: "诊断状态"
};
export const UI_STORE_REJECT = {
  STALE_VERSION: "stale_version",
  UNKNOWN_BUCKET: "unknown_bucket",
  INVALID_PATCH: "invalid_patch"
};
export const UI_STORE_REJECT_ZH = {
  stale_version: "旧版本快照被拒绝(不允许用旧数据覆盖新状态)",
  unknown_bucket: "未知状态桶",
  invalid_patch: "合并数据不合法"
};
export const UI_STORE_WILDCARD = "*";

// ---- 私有数值工具(us 前缀,避免扁平作用域重名)----
function usNumOrNull(v) {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function usIsPlainObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}
// 浅拷贝:顶层字段隔离,避免外部对象被就地改掉后 UI 悄悄跟着变
function usCopyData(v) {
  if (Array.isArray(v)) return v.slice();
  if (usIsPlainObject(v)) return { ...v };
  return v;
}
function usVersionOf(meta) {
  const m = meta || {};
  const raw = m.state_version != null ? m.state_version : (m.version != null ? m.version : m.stateVersion);
  const n = usNumOrNull(raw);
  return n == null ? null : Math.floor(n);
}

// 版本严格更大才渲染(相等 = 同一份快照,重复渲染只会闪)
export function shouldRender(prevVersion, nextVersion) {
  const prev = usNumOrNull(prevVersion);
  const next = usNumOrNull(nextVersion);
  if (next == null) return false;
  if (prev == null) return next > 0;
  return next > prev;
}

export function createUiStore(opts) {
  const o = opts || {};
  const clock = typeof o.now === "function"
    ? o.now
    : ((fixed) => () => {
      const n = usNumOrNull(fixed);
      return n == null ? 0 : n;
    })(o.now);
  const bucketNames = (Array.isArray(o.buckets) && o.buckets.length ? o.buckets.slice() : UI_BUCKETS.slice())
    .map((b) => String(b));
  const records = {};
  const subscribers = {};
  const initial = usIsPlainObject(o.initial) ? o.initial : {};
  let totalNotifications = 0;
  let totalRejections = 0;

  for (const name of bucketNames) {
    records[name] = {
      data: initial[name] === undefined ? null : usCopyData(initial[name]),
      state_version: 0,
      updated_at: clock(),
      stale: false,
      notifications: 0,
      rejections: 0
    };
    subscribers[name] = [];
  }
  subscribers[UI_STORE_WILDCARD] = [];

  function known(bucket) {
    return typeof bucket === "string" && Object.prototype.hasOwnProperty.call(records, bucket);
  }
  function listenersFor(bucket) {
    return (subscribers[bucket] || []).concat(subscribers[UI_STORE_WILDCARD] || []);
  }
  function notify(bucket, record, meta) {
    const list = listenersFor(bucket);
    let delivered = 0;
    for (const entry of list.slice()) {
      if (!entry || entry.active !== true) continue;
      try {
        entry.fn(record, { bucket: bucket, meta: meta || null });
        delivered += 1;
      } catch (error) {
        // 单个订阅者抛错不能影响其它订阅者(UI 局部故障不许扩散)
        delivered += 1;
      }
    }
    record.notifications += delivered;
    totalNotifications += delivered;
    return delivered;
  }
  function reject(record, bucket, reason, extra) {
    record.rejections += 1;
    totalRejections += 1;
    return {
      applied: false, bucket: bucket, reason: reason,
      reason_zh: UI_STORE_REJECT_ZH[reason] || reason,
      state_version: record.state_version,
      ...(extra || {})
    };
  }

  function set(bucket, data, meta) {
    if (!known(bucket)) {
      totalRejections += 1;
      return { applied: false, bucket: bucket, reason: UI_STORE_REJECT.UNKNOWN_BUCKET, reason_zh: UI_STORE_REJECT_ZH.unknown_bucket };
    }
    const record = records[bucket];
    const requested = usVersionOf(meta);
    if (requested != null && requested <= record.state_version) {
      return reject(record, bucket, UI_STORE_REJECT.STALE_VERSION, { incoming_version: requested });
    }
    record.state_version = requested != null ? requested : record.state_version + 1;
    record.data = usCopyData(data);
    record.updated_at = clock();
    record.stale = false;
    const delivered = notify(bucket, record, meta);
    return { applied: true, bucket: bucket, state_version: record.state_version, updated_at: record.updated_at, notified: delivered };
  }

  function patch(bucket, partial, meta) {
    if (!known(bucket)) {
      totalRejections += 1;
      return { applied: false, bucket: bucket, reason: UI_STORE_REJECT.UNKNOWN_BUCKET, reason_zh: UI_STORE_REJECT_ZH.unknown_bucket };
    }
    const record = records[bucket];
    if (!usIsPlainObject(partial)) return reject(record, bucket, UI_STORE_REJECT.INVALID_PATCH);
    const requested = usVersionOf(meta);
    if (requested != null && requested <= record.state_version) {
      return reject(record, bucket, UI_STORE_REJECT.STALE_VERSION, { incoming_version: requested });
    }
    // 只合并顶层字段:嵌套对象整体替换,避免"深合并"把旧字段偷偷留在新状态里
    const base = usIsPlainObject(record.data) ? record.data : {};
    const merged = { ...base, ...partial };
    record.state_version = requested != null ? requested : record.state_version + 1;
    record.data = merged;
    record.updated_at = clock();
    record.stale = false;
    const delivered = notify(bucket, record, meta);
    return { applied: true, bucket: bucket, state_version: record.state_version, updated_at: record.updated_at, notified: delivered };
  }

  function markStale(bucket) {
    if (!known(bucket)) {
      totalRejections += 1;
      return { applied: false, bucket: bucket, reason: UI_STORE_REJECT.UNKNOWN_BUCKET, reason_zh: UI_STORE_REJECT_ZH.unknown_bucket };
    }
    const record = records[bucket];
    record.stale = true;
    const delivered = notify(bucket, record, { reason: "stale" });
    return { applied: true, bucket: bucket, state_version: record.state_version, stale: true, notified: delivered };
  }

  function subscribe(bucket, fn) {
    if (typeof fn !== "function") return () => false;
    const key = bucket === UI_STORE_WILDCARD ? UI_STORE_WILDCARD : String(bucket);
    if (!subscribers[key]) subscribers[key] = [];
    const entry = { fn: fn, active: true, bucket: key };
    subscribers[key].push(entry);
    return function unsubscribe() {
      if (entry.active !== true) return false;
      entry.active = false;
      const arr = subscribers[key] || [];
      const idx = arr.indexOf(entry);
      if (idx >= 0) arr.splice(idx, 1);
      return true;
    };
  }

  function subscribeMany(list, fn) {
    const names = Array.isArray(list) ? list : [];
    const offs = names.map((b) => subscribe(b, fn));
    return function unsubscribeAll() {
      let removed = 0;
      for (const off of offs) if (off() === true) removed += 1;
      return removed > 0;
    };
  }

  function get(bucket) {
    if (!known(bucket)) return null;
    const r = records[bucket];
    return { data: r.data, state_version: r.state_version, updated_at: r.updated_at, stale: r.stale === true };
  }

  function snapshot() {
    const out = {};
    for (const name of bucketNames) {
      const r = records[name];
      out[name] = { data: r.data, state_version: r.state_version, updated_at: r.updated_at, stale: r.stale === true };
    }
    return out;
  }

  function stats() {
    const out = { buckets: {}, total_notifications: totalNotifications, total_rejections: totalRejections, version: UI_STORE_VERSION };
    for (const name of bucketNames) {
      const r = records[name];
      out.buckets[name] = {
        notifications: r.notifications,
        rejections: r.rejections,
        state_version: r.state_version,
        updated_at: r.updated_at,
        stale: r.stale === true,
        subscribers: (subscribers[name] || []).filter((e) => e.active === true).length
      };
    }
    return out;
  }

  return {
    version: UI_STORE_VERSION,
    buckets: bucketNames.slice(),
    set: set,
    patch: patch,
    get: get,
    snapshot: snapshot,
    subscribe: subscribe,
    subscribeMany: subscribeMany,
    markStale: markStale,
    stats: stats,
    shouldRender: shouldRender,
    has: known
  };
}

// 中文视图:各 bucket 的版本、更新时间与订阅数
export function uiStoreView(store) {
  if (!store || typeof store.stats !== "function") return null;
  const s = store.stats();
  const rows = Object.keys(s.buckets).map((bucket) => {
    const b = s.buckets[bucket];
    return {
      bucket: bucket,
      zh: UI_BUCKET_ZH[bucket] || bucket,
      state_version: b.state_version,
      updated_at: b.updated_at,
      stale: b.stale === true,
      stale_zh: b.stale === true ? "疑似过期" : "正常",
      notifications: b.notifications,
      rejections: b.rejections,
      subscribers: b.subscribers
    };
  });
  return {
    version: s.version || UI_STORE_VERSION,
    buckets: rows,
    bucket_count: rows.length,
    total_notifications: s.total_notifications,
    total_rejections: s.total_rejections,
    headline_zh: "状态桶 " + rows.length + " 个 · 通知 " + s.total_notifications + " 次 · 拒绝旧版本 " + s.total_rejections + " 次",
    note_zh: "旧版本(state_version ≤ 当前)快照一律拒绝,不允许旧数据把新状态覆盖回去"
  };
}
