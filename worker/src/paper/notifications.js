// paper/notifications.js · Notification Manager(通知唯一出口)
// 目的:Trade / Risk / System / Market / Learning / Research 六类通知统一管理:
//      去重(key 窗口内只留一条)、冷却(cooldown)、优先级排序、已读未读、Android 通知渠道映射。
// 约束:各模块不允许自己拼通知,一律走 center.push();UI 与原生通知都从 center.list() 读取。
import { num, round } from "./accounting.js";

export const NOTIFY_CHANNELS = ["TRADE", "RISK", "SYSTEM", "MARKET", "LEARNING", "RESEARCH"];
export const NOTIFY_PRIORITY = { high: 3, normal: 2, low: 1 };
// 渠道 → Android 原生通知渠道 id(native-bridge 里已建同名渠道)
export const ANDROID_CHANNEL_MAP = {
  TRADE: "paper_trade",
  RISK: "paper_risk",
  SYSTEM: "paper_system",
  MARKET: "paper_market",
  LEARNING: "paper_learning",
  RESEARCH: "paper_research"
};

export const NOTIFY_DEFAULTS = {
  limit: 200,
  dedup_window_ms: 60000,     // 同 key 60 秒内只保留一条
  default_cooldown_ms: 0,     // 未显式声明冷却的 key 不做冷却
  always_bypass: true         // meta.always=true 的通知不受去重影响(开/平仓等关键事件)
};

export function createNotificationCenter(options) {
  const opts = { ...NOTIFY_DEFAULTS, ...(options || {}) };
  const now = () => num(opts.now ? opts.now() : Date.now());
  const items = [];
  const seen = new Map();          // key -> last at
  const channelEnabled = {};
  for (const c of NOTIFY_CHANNELS) channelEnabled[c] = true;
  const stats = { pushed: 0, deduped: 0, cooled: 0, suppressed: 0, read: 0 };

  function normalizeKind(kind) {
    const k = String(kind || "SYSTEM").toUpperCase();
    return NOTIFY_CHANNELS.includes(k) ? k : "SYSTEM";
  }

  function push(kind, title, body, meta) {
    const m = meta || {};
    const channel = normalizeKind(kind);
    if (channelEnabled[channel] === false) { stats.suppressed += 1; return { added: false, reason: "channel_disabled" }; }
    const key = m.key ? String(m.key) : null;
    const at = now();
    // 去重按"渠道 + key":同一 key 但不同渠道是不同的事件
    // (否则一条 RISK 告警可能被同 key 的 TRADE 通知吃掉 —— 风险提醒绝不能被静默吞掉)
    const dedupKey = key ? channel + "|" + key : null;
    if (dedupKey) {
      const last = seen.get(dedupKey);
      const windowMs = num(m.dedup_window_ms, opts.dedup_window_ms);
      const cooldownMs = num(m.cooldown_ms, opts.default_cooldown_ms);
      const bypass = Boolean(m.always) && opts.always_bypass;
      if (!bypass && last != null && at - last < Math.max(windowMs, cooldownMs)) {
        if (at - last < cooldownMs) stats.cooled += 1; else stats.deduped += 1;
        return { added: false, reason: at - last < cooldownMs ? "cooldown" : "deduped", key };
      }
      seen.set(dedupKey, at);
    }
    const item = {
      id: "ntf_" + at.toString(36) + "_" + (items.length + 1).toString(36),
      kind: channel,
      channel,
      android_channel: ANDROID_CHANNEL_MAP[channel],
      title: String(title == null ? "" : title).slice(0, 120),
      body: String(body == null ? "" : body).slice(0, 400),
      severity: m.severity || (channel === "RISK" ? "high" : "normal"),
      priority: NOTIFY_PRIORITY[m.severity] || NOTIFY_PRIORITY.normal,
      symbol: m.symbol || null,
      mode: m.mode || null,
      at,
      read: false,
      key
    };
    items.push(item);
    if (items.length > num(m.limit, opts.limit)) items.shift();
    stats.pushed += 1;
    return { added: true, notification: item };
  }

  function list(options2) {
    const o = options2 || {};
    let out = items.slice();
    if (o.kind) out = out.filter((n) => n.kind === String(o.kind).toUpperCase());
    if (o.unreadOnly) out = out.filter((n) => !n.read);
    if (o.symbol) out = out.filter((n) => n.symbol === o.symbol);
    // 未读优先 + 优先级高的优先 + 时间倒序
    out.sort((a, b) => (Number(a.read) - Number(b.read)) || (b.priority - a.priority) || (b.at - a.at));
    return out.slice(0, num(o.limit, 50));
  }

  return {
    push,
    list,
    unreadCount: () => items.filter((n) => !n.read).length,
    markRead: (ids) => {
      const set = new Set(Array.isArray(ids) ? ids.map(String) : [String(ids)]);
      let n = 0;
      for (const it of items) if (set.has(it.id) && !it.read) { it.read = true; n += 1; }
      stats.read += n;
      return n;
    },
    markAllRead: () => {
      let n = 0;
      for (const it of items) if (!it.read) { it.read = true; n += 1; }
      stats.read += n;
      return n;
    },
    setChannelEnabled: (kind, enabled) => {
      const k = normalizeKind(kind);
      channelEnabled[k] = Boolean(enabled);
      return { channel: k, enabled: channelEnabled[k] };
    },
    channels: () => NOTIFY_CHANNELS.map((c) => ({ channel: c, enabled: channelEnabled[c] !== false, android: ANDROID_CHANNEL_MAP[c] })),
    stats: () => ({ ...stats, total: items.length, unread: items.filter((n) => !n.read).length, keys: seen.size }),
    // 给原生桥:只返回"需要弹系统通知"的最高优先级未读(避免刷屏)
    nativePushQueue: (options2) => {
      const o = options2 || {};
      const since = num(o.since, 0);
      return list({ unreadOnly: false, limit: 20 })
        .filter((n) => n.at > since && n.severity === "high")
        .slice(0, 3)
        .map((n) => ({ channel: n.android_channel, title: n.title, body: n.body, id: n.id }));
    },
    reset: () => { items.length = 0; seen.clear(); }
  };
}

// 按日汇总(UI 顶栏小徽标的轻量口径)
export function notificationDigest(center) {
  const list = center.list({ limit: 200 });
  const byKind = {};
  for (const n of list) byKind[n.kind] = num(byKind[n.kind], 0) + 1;
  return {
    total: list.length,
    unread: center.unreadCount(),
    by_kind: byKind,
    high_unread: list.filter((n) => !n.read && n.severity === "high").length,
    last_at: list.length ? round(list[0].at, 0) : null
  };
}
