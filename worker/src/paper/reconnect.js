// paper/reconnect.js · V16 §24 断线恢复调度(纯函数,无 I/O)
// 手机网络会断、代理会抖、上游会 502。真正危险的不是"断",而是三种错误应对:
//   1) 疯狂立即重连(把上游打挂,也把自己耗空)      → 指数退避 + 抖动 + 风暴守卫;
//   2) 对 4xx / 地域封锁无限重试(永远不会成功)       → 不可重试错误直接停;
//   3) 把 REST 补回来的历史 K 线当成"新实时事件"     → 补历史绝不能触发交易决策。
// 抖动必须确定性(注入 opts.random 或 key+attempt 哈希),否则测试无法复现、回放无法对齐。
export const RECONNECT_VERSION = "reconnect-v1.0";

export const RECONNECT_DEFAULTS = {
  base_ms: 1000,
  max_ms: 60000,
  jitter: 0.2,
  max_attempts: 8,
  storm_window_ms: 60000,
  max_attempts_per_window: 6,
  kinds: ["market", "funding", "news", "ai", "runtime"]
};

function reconnectNum(v, fallback) {
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  return fallback === undefined ? 0 : fallback;
}

function reconnectClamp(v, lo, hi) {
  const n = reconnectNum(v, lo);
  return Math.min(hi, Math.max(lo, n));
}

// 稳定哈希 → [0,1):抖动来源之一(无需 crypto,便于在任意运行时复现)
function reconnectHash01(seed) {
  let h = 0x811c9dc5;
  const s = String(seed);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0) / 4294967296;
}

function reconnectEnsure(scheduler) {
  if (scheduler && typeof scheduler === "object" && scheduler.attempts && scheduler.windows && Array.isArray(scheduler.history)) {
    if (!scheduler.opts) scheduler.opts = { ...RECONNECT_DEFAULTS };
    if (typeof scheduler.now !== "function") scheduler.now = () => Date.now();
    return scheduler;
  }
  return createReconnectScheduler({});
}

function reconnectNow(scheduler) {
  return typeof scheduler.now === "function" ? scheduler.now() : Date.now();
}

// 指数退避 + 抖动:base × 2^(attempt-1),上限 max_ms;抖动由 key+attempt 决定(确定性)
function reconnectDelayFor(scheduler, key, attempt) {
  const opts = scheduler.opts || RECONNECT_DEFAULTS;
  const base = reconnectNum(opts.base_ms, RECONNECT_DEFAULTS.base_ms);
  const maxMs = reconnectNum(opts.max_ms, RECONNECT_DEFAULTS.max_ms);
  const jitter = reconnectClamp(opts.jitter, 0, 1);
  const n = Math.max(1, Math.floor(reconnectNum(attempt, 1)));
  const capped = Math.min(maxMs, base * Math.pow(2, n - 1));
  const r = typeof opts.random === "function"
    ? reconnectClamp(opts.random(key, n), 0, 1)
    : reconnectHash01(String(key) + "|" + n);
  const delay = capped * (1 + jitter * (2 * r - 1));
  return Math.max(1, Math.min(maxMs, Math.round(delay)));
}

// 创建调度器:attempts/windows 按 key 分离(不同数据源互不影响)
export function createReconnectScheduler(input) {
  const o = input || {};
  const opts = { ...RECONNECT_DEFAULTS, ...(o.opts || {}) };
  return {
    version: RECONNECT_VERSION,
    attempts: {},
    windows: {},
    history: [],
    opts: opts,
    now: typeof o.now === "function" ? o.now : () => Date.now()
  };
}

// 错误分类:4xx 不可重试;403/451(地域封锁)与 UNKNOWN 也不许疯狂重试
export function reconnectClassifyError(err) {
  const e = err || {};
  const status = reconnectNum(e.status != null ? e.status : e.statusCode, null);
  const text = (typeof err === "string" ? err : [e.code, e.name, e.message].filter(Boolean).join(" ")) + "";
  if (status != null) {
    if (status === 403 || status === 451 || status === 418) {
      return { kind: "BLOCKED", retryable: false, zh: "被拒绝/地域限制(" + status + "),反复重试没有意义" };
    }
    if (status === 408) return { kind: "TIMEOUT", retryable: true, zh: "请求超时(408),退避后重试" };
    if (status === 429) return { kind: "HTTP_4XX", retryable: true, zh: "请求过于频繁(429),必须退避" };
    if (status >= 500) return { kind: "HTTP_5XX", retryable: true, zh: "上游服务异常(" + status + ")" };
    if (status >= 400) return { kind: "HTTP_4XX", retryable: false, zh: "请求错误(" + status + "),重试不会成功" };
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|\bdns\b/i.test(text)) return { kind: "DNS", retryable: true, zh: "域名解析失败(DNS)" };
  if (/ECONNRESET|ECONNREFUSED|ECONNABORTED|ENETUNREACH|EPIPE|socket|network|failed to fetch/i.test(text)) {
    return { kind: "NETWORK", retryable: true, zh: "网络连接失败" };
  }
  if (/ETIMEDOUT|timeout|timed out|AbortError|aborted/i.test(text)) return { kind: "TIMEOUT", retryable: true, zh: "请求超时" };
  if (/blocked|forbidden|\bgeo\b|region|restricted/i.test(text)) return { kind: "BLOCKED", retryable: false, zh: "被屏蔽/地域限制,不要反复重试" };
  return { kind: "UNKNOWN", retryable: false, zh: "未知错误,不盲目重试" };
}

// 下一个退避延迟(只读,不改状态):便于 UI 预告与测试比对
export function reconnectNextDelay(scheduler, key) {
  const s = reconnectEnsure(scheduler);
  const k = String(key == null ? "default" : key);
  const st = s.attempts[k] || {};
  const attempt = reconnectNum(st.attempt, 0) + 1;
  return reconnectDelayFor(s, k, attempt);
}

// 登记一次重连尝试(风暴守卫优先):窗口内超过上限 → 拒绝,并给出何时可以再试
export function reconnectAttempt(scheduler, key) {
  const s = reconnectEnsure(scheduler);
  const opts = s.opts;
  const k = String(key == null ? "default" : key);
  const at = reconnectNow(s);
  const windowMs = reconnectNum(opts.storm_window_ms, RECONNECT_DEFAULTS.storm_window_ms);
  const maxInWindow = reconnectNum(opts.max_attempts_per_window, RECONNECT_DEFAULTS.max_attempts_per_window);
  const times = (s.windows[k] || []).filter((t) => at - t <= windowMs);
  s.windows[k] = times;

  if (times.length >= maxInWindow) {
    const oldest = times.length ? times[0] : at;
    return {
      allowed: false,
      reason: "storm_guard",
      key: k,
      attempt: reconnectNum(s.attempts[k] && s.attempts[k].attempt, 0),
      next_at: oldest + windowMs,
      wait_ms: Math.max(0, oldest + windowMs - at)
    };
  }

  const prevAttempt = reconnectNum(s.attempts[k] && s.attempts[k].attempt, 0);
  if (prevAttempt >= reconnectNum(opts.max_attempts, RECONNECT_DEFAULTS.max_attempts)) {
    return { allowed: false, reason: "max_attempts", key: k, attempt: prevAttempt, next_at: null, wait_ms: null };
  }

  const attempt = prevAttempt + 1;
  const delay = reconnectDelayFor(s, k, attempt);
  times.push(at);
  s.windows[k] = times;
  s.attempts[k] = { attempt: attempt, last_at: at, next_at: at + delay };
  return { allowed: true, reason: "retry", key: k, attempt: attempt, delay_ms: delay, next_at: at + delay };
}

// 连接恢复:清零该 key 的退避与风暴窗口,并记入 history
export function reconnectSuccess(scheduler, key) {
  const s = reconnectEnsure(scheduler);
  const k = String(key == null ? "default" : key);
  const prev = s.attempts[k];
  const entry = { key: k, at: reconnectNow(s), attempts: reconnectNum(prev && prev.attempt, 0), ok: true };
  s.history.push(entry);
  delete s.attempts[k];
  delete s.windows[k];
  return entry;
}

// 视图:哪些 key 正在重连、还剩多久、是否被风暴守卫限制
export function reconnectView(scheduler) {
  const s = reconnectEnsure(scheduler);
  const now = reconnectNow(s);
  const opts = s.opts;
  const windowMs = reconnectNum(opts.storm_window_ms, RECONNECT_DEFAULTS.storm_window_ms);
  const maxInWindow = reconnectNum(opts.max_attempts_per_window, RECONNECT_DEFAULTS.max_attempts_per_window);
  const active = Object.keys(s.attempts).map((k) => {
    const st = s.attempts[k] || {};
    const nextAt = reconnectNum(st.next_at, null);
    return {
      key: k,
      attempt: reconnectNum(st.attempt, 0),
      next_at: nextAt,
      next_in_ms: nextAt == null ? null : Math.max(0, nextAt - now)
    };
  });
  let stormKey = null;
  for (const k of Object.keys(s.windows)) {
    const n = (s.windows[k] || []).filter((t) => now - t <= windowMs).length;
    if (n >= maxInWindow) { stormKey = k; break; }
  }
  return {
    version: RECONNECT_VERSION,
    active: active,
    history_count: s.history.length,
    storm_limited: stormKey != null,
    storm_key: stormKey,
    now: now
  };
}

// 事件分类:REST 补回来的历史 K 线是 BACKFILL_DUPLICATE,绝不能当新实时事件
export function classifyMarketEvent(input) {
  const e = input || {};
  const source = String(e.source || "").toLowerCase();
  const type = String(e.type || "").toLowerCase();
  const backfillish = /backfill|replay|bootstrap|snapshot|catchup|history/.test(source + " " + type);
  const candleTime = reconnectNum(e.candle_time, null);
  const lastSeen = reconnectNum(e.last_seen_candle_time, null);
  // 时间戳不前进(甚至倒退)= 历史补录,而不是"新的 K 线"
  if (candleTime != null && lastSeen != null && candleTime <= lastSeen) return "BACKFILL_DUPLICATE";
  if (backfillish) return "BACKFILL_DUPLICATE";
  return "NEW_EVENT";
}

// 只有真正的新事件才允许触发决策;backfill 永远 false
export function shouldTriggerDecision(eventClass) {
  return String(eventClass) === "NEW_EVENT";
}

// K 线去重:按 open time;早于"已知最新"的算 backfill(补历史),已存在的算 duplicate
export function dedupeCandles(prevMap, incoming, opts) {
  const prev = prevMap && typeof prevMap === "object" ? prevMap : {};
  const list = Array.isArray(incoming)
    ? incoming
    : (incoming && typeof incoming === "object" ? Object.values(incoming) : []);
  const map = {};
  let latest = null;
  const prevKeys = prev instanceof Map ? Array.from(prev.keys()) : Object.keys(prev);
  for (const key of prevKeys) {
    const candle = prev instanceof Map ? prev.get(key) : prev[key];
    const t = reconnectNum(key, null);
    if (t == null) { map[key] = candle; continue; }
    map[t] = candle;
    if (latest == null || t > latest) latest = t;
  }

  const added = [];
  const duplicates = [];
  const backfill = [];
  for (const candle of list) {
    if (candle == null) continue;
    const t = reconnectNum(
      candle.open_time != null ? candle.open_time : (candle.candle_time != null ? candle.candle_time : candle.time),
      null
    );
    if (t == null) continue;
    if (Object.prototype.hasOwnProperty.call(map, t)) {
      duplicates.push(candle);
    } else if (latest != null && t <= latest) {
      backfill.push(candle);
    } else {
      added.push(candle);
      map[t] = candle;
      if (latest == null || t > latest) latest = t;
    }
  }

  return {
    added: added,
    duplicates: duplicates,
    backfill: backfill,
    map: map,
    changed: added.length > 0,
    latest_open_time: latest,
    opts: opts || {}
  };
}

// 下一动作预告(只读,不消耗尝试次数):给 UI/日志解释"接下来会发生什么"
export function reconnectPlan(scheduler, keys) {
  const s = reconnectEnsure(scheduler);
  const opts = s.opts;
  const now = reconnectNow(s);
  const windowMs = reconnectNum(opts.storm_window_ms, RECONNECT_DEFAULTS.storm_window_ms);
  const maxInWindow = reconnectNum(opts.max_attempts_per_window, RECONNECT_DEFAULTS.max_attempts_per_window);
  const list = Array.isArray(keys) ? keys : Object.keys(s.attempts);
  return list.map((key) => {
    const k = String(key);
    const st = s.attempts[k] || {};
    const prevAttempt = reconnectNum(st.attempt, 0);
    const times = (s.windows[k] || []).filter((t) => now - t <= windowMs);
    const storm = times.length >= maxInWindow;
    const maxed = prevAttempt >= reconnectNum(opts.max_attempts, RECONNECT_DEFAULTS.max_attempts);
    if (storm || maxed) {
      return {
        key: k,
        attempt: prevAttempt,
        allowed: false,
        reason: storm ? "storm_guard" : "max_attempts",
        delay_ms: null,
        next_at: storm ? times[0] + windowMs : null,
        action: storm ? "wait" : "give_up",
        action_zh: storm ? "风暴守卫:等待窗口冷却" : "已达最大重试次数,停止自动重连"
      };
    }
    const attempt = prevAttempt + 1;
    const delay = reconnectDelayFor(s, k, attempt);
    return {
      key: k,
      attempt: attempt,
      allowed: true,
      reason: "retry",
      delay_ms: delay,
      next_at: now + delay,
      action: "retry",
      action_zh: "第 " + attempt + " 次重试,等待 " + delay + "ms"
    };
  });
}
