// paper/chatSession.js · AI Chat 会话管理(界面不常驻,记录可保留)
// 设计原则(与需求一一对应):
//   1) Chat 是"按 symbol 的会话",不是常驻页面:界面开关由页面控制,本模块只管数据与上下文
//   2) 记录可保留但禁止无限增长:每个 symbol 保留最近 N 条,更旧的压缩成 compact_summary
//   3) DeepSeek 每次只收到【当前问题 + 最近摘要 + 当前上下文快照】,永不收到完整历史
//   4) 区分 USER_CHAT_REQUEST 与 BACKGROUND_DECISION_REVIEW:前者可被关闭中断,后者不可
import { num, round } from "./accounting.js";

export const REQUEST_KINDS = {
  USER_CHAT_REQUEST: "USER_CHAT_REQUEST",
  BACKGROUND_DECISION_REVIEW: "BACKGROUND_DECISION_REVIEW"
};
// 只有用户主动发起的聊天请求可以在关闭界面时中断;后台决策复核属于策略链路,不能因聊天关闭而取消
export const ABORTABLE_KINDS = [REQUEST_KINDS.USER_CHAT_REQUEST];

export const CHAT_DEFAULTS = {
  per_symbol_limit: 40,      // 每个 symbol 最多保留的消息数(需求建议 20~50)
  summary_keep: 12,          // 摘要里保留的最近事件数
  summary_max_chars: 600,    // 摘要文本上限(避免摘要本身变成新的大上下文)
  max_symbols: 12            // 最多保留多少个 symbol 的会话(避免本地无限增长)
};

export function sessionKeyOf(symbol, conversationId) {
  if (conversationId) return String(conversationId);
  const s = String(symbol || "GENERAL").toUpperCase();
  return s || "GENERAL";
}

// 把一条消息压成一行事件(确定性,不调用任何模型)
function eventLine(message) {
  const role = message.role === "me" ? "用户" : "AI";
  const text = String(message.text || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const short = text.length > 80 ? text.slice(0, 80) + "…" : text;
  return role + ":" + short;
}

// 生成 compact_summary:只保留最近若干条事件的要点,长度有硬上限
export function compactSummary(messages, options) {
  const o = options || {};
  const keep = num(o.summary_keep, CHAT_DEFAULTS.summary_keep);
  const maxChars = num(o.summary_max_chars, CHAT_DEFAULTS.summary_max_chars);
  const list = (messages || []).filter((m) => m && m.text);
  if (!list.length) return "";
  const lines = list.slice(-keep).map(eventLine).filter(Boolean);
  let text = lines.join(" | ");
  if (text.length > maxChars) text = "…" + text.slice(text.length - Math.max(0, maxChars - 1));
  return text;
}

// 每次提问真正发给服务端/本地回答的上下文(严格收敛)
export function buildSlimContext(input) {
  const i = input || {};
  const session = i.session || {};
  const snap = i.snapshot || {};
  const question = String(i.question == null ? "" : i.question).slice(0, 500);
  const context = {
    symbol: snap.symbol || session.symbol || null,
    interval: snap.interval || null,
    mode: snap.mode || null,
    price: snap.price == null ? null : num(snap.price, null),
    direction: snap.direction || null,
    confidence: snap.confidence == null ? null : num(snap.confidence, null),
    regime: snap.regime || null,
    risk_level: snap.risk_level || null,
    risk_score: snap.risk_score == null ? null : num(snap.risk_score, null),
    position: snap.position || null,
    prediction: snap.prediction || null,
    funding: snap.funding || null,
    open_interest: snap.open_interest || null,
    profit_lock: snap.profit_lock || null,
    leverage: snap.leverage == null ? null : num(snap.leverage, null),
    pnl: snap.pnl == null ? null : num(snap.pnl, null),
    journal: Array.isArray(snap.journal) ? snap.journal.slice(0, 4) : null,
    // 只给摘要,不给原始历史(需求硬性要求)
    chat_summary: session.summary || "",
    conversation_id: session.key || null
  };
  return { question, context };
}

// 出站上下文整形(白名单):发给服务端的内容结构上不可能包含历史消息。
// 允许字段 = 当前快照 + 最近摘要 + 会话标识;任何 chat/history/messages 字段一律剔除。
export const OUTBOUND_FIELDS = [
  "symbol", "interval", "mode", "price", "direction", "confidence", "regime",
  "risk_level", "risk_score", "position", "prediction", "funding", "open_interest",
  "profit_lock", "leverage", "pnl", "journal", "drawdown", "external", "future", "strategyStats", "portfolio"
];
const FORBIDDEN_FIELDS = ["messages", "history", "chat_history", "conversation", "turns", "raw"];

export function limitOutboundContext(rich, meta) {
  const r = rich || {};
  const m = meta || {};
  const out = {};
  for (const k of OUTBOUND_FIELDS) {
    if (r[k] === undefined) continue;
    out[k] = r[k];
  }
  for (const k of FORBIDDEN_FIELDS) delete out[k];
  out.chat_summary = String(m.summary == null ? "" : m.summary).slice(0, CHAT_DEFAULTS.summary_max_chars);
  out.conversation_id = m.conversation_id || null;
  // 压缩:去掉空值,避免无意义的字段占据上下文预算
  for (const k of Object.keys(out)) {
    if (out[k] === null || out[k] === undefined || out[k] === "") delete out[k];
  }
  return out;
}

// 会话存储(纯内存 + 可序列化;持久化由页面负责)
export function createChatSessionStore(options) {
  const o = { ...CHAT_DEFAULTS, ...(options || {}) };
  const now = () => num(o.now ? o.now() : Date.now());
  const sessions = new Map();   // key -> { key, symbol, messages: [], summary, updated_at, turns }
  const stats = { appended: 0, trimmed: 0, summaries: 0, restored: 0 };

  function ensure(key, symbol) {
    if (!sessions.has(key)) {
      sessions.set(key, { key, symbol: symbol || key, messages: [], summary: "", updated_at: now(), turns: 0 });
      // 控制 symbol 数量:超出后淘汰最久未更新的会话(内存与本地存储都不无限增长)
      if (sessions.size > o.max_symbols) {
        const oldest = [...sessions.values()].sort((a, b) => num(a.updated_at) - num(b.updated_at))[0];
        if (oldest) sessions.delete(oldest.key);
      }
    }
    const s = sessions.get(key);
    if (symbol) s.symbol = symbol;
    return s;
  }

  function append(key, symbol, message) {
    const s = ensure(key, symbol);
    const item = {
      id: message && message.id ? message.id : "msg_" + now().toString(36) + "_" + (s.messages.length + 1).toString(36),
      role: message && message.role === "me" ? "me" : "ai",
      text: String((message && message.text) || "").slice(0, 2000),
      at: num(message && message.at, now()),
      source: (message && message.source) || null,
      pending: Boolean(message && message.pending)
    };
    s.messages.push(item);
    s.updated_at = item.at;
    stats.appended += 1;
    // 超过上限:把最旧的挤出并刷新摘要(而不是简单丢弃上下文)
    while (s.messages.length > o.per_symbol_limit) {
      s.messages.shift();
      stats.trimmed += 1;
    }
    const trimmed = [...s.messages];
    s.summary = compactSummary(trimmed, o);
    stats.summaries += 1;
    return item;
  }

  return {
    config: o,
    ensure,
    append,
    // 恢复会话(页面从本地存储读回时调用):只接受 {role, text, at}
    restore(key, symbol, messages, summary) {
      const s = ensure(key, symbol);
      s.messages = (Array.isArray(messages) ? messages : [])
        .filter((m) => m && m.text)
        .slice(-o.per_symbol_limit)
        .map((m, idx) => ({ id: m.id || "msg_r" + idx, role: m.role === "me" ? "me" : "ai", text: String(m.text).slice(0, 2000), at: num(m.at, now()), source: m.source || null, pending: false }));
      s.summary = summary ? String(summary).slice(0, o.summary_max_chars) : compactSummary(s.messages, o);
      s.turns = s.messages.filter((m) => m.role === "me").length;
      stats.restored += 1;
      return s;
    },
    get: (key) => sessions.get(key) || null,
    messages: (key) => (sessions.get(key) ? sessions.get(key).messages.slice() : []),
    summary: (key) => (sessions.get(key) ? sessions.get(key).summary : ""),
    clear(key) {
      const s = sessions.get(key);
      if (!s) return { ok: false, reason: "session_missing" };
      s.messages = [];
      s.summary = "";
      s.updated_at = now();
      return { ok: true };
    },
    drop(key) { return sessions.delete(key); },
    keys: () => [...sessions.keys()],
    size: () => sessions.size,
    stats: () => ({ ...stats, sessions: sessions.size, messages: [...sessions.values()].reduce((a, s) => a + s.messages.length, 0) }),
    // 持久化:只导出必要字段(不存 pending 气泡)
    toJSON: () => [...sessions.values()].map((s) => ({
      key: s.key,
      symbol: s.symbol,
      summary: s.summary,
      updated_at: s.updated_at,
      messages: s.messages.filter((m) => !m.pending).map((m) => ({ role: m.role, text: m.text, at: m.at, source: m.source }))
    })),
    // 恢复全部(启动/重开界面时调用)
    loadFrom(list) {
      let n = 0;
      for (const s of Array.isArray(list) ? list : []) {
        if (!s || !s.key) continue;
        this.restore(s.key, s.symbol, s.messages, s.summary);
        n += 1;
      }
      return n;
    }
  };
}

// 关闭界面时的清理清单(供页面执行,顺序固定,避免漏项)
export function teardownPlan(input) {
  const i = input || {};
  return {
    // UI 层
    unmount_ui: true,
    remove_loading_bubbles: true,
    stop_animations: true,
    // 网络层:只中断用户聊天请求,后台决策复核必须保留
    abort_keys: ABORTABLE_KINDS.map(() => "chat"),
    preserve_request_kinds: [REQUEST_KINDS.BACKGROUND_DECISION_REVIEW],
    keep_background: ["paper-engine", "market-data", "risk", "position-manager", "learning", "tasks"],
    persist_history: Boolean(i.persist !== false),
    // 明确"不常驻"的保证
    notes: ["关闭后不轮询 DeepSeek、不保留计时器、不占用 Token"]
  };
}

// 供 UI/测试断言:Chat 是否处于"完全收起"状态
export function uiIdleState(input) {
  const i = input || {};
  return {
    open: Boolean(i.open),
    loading: Boolean(i.loading),
    pending_requests: num(i.pending_requests, 0),
    idle: !i.open && !i.loading && num(i.pending_requests, 0) === 0
  };
}
