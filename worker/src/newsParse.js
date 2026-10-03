// newsParse.js · 真实新闻/公告源解析(纯函数,无依赖,服务端与测试共用)
// 用于 /api/announcements(OKX 官方公告)与 /api/news(CoinTelegraph RSS)。
//
// 安全约束:
//   1) 只做文本抽取,绝不执行任何内容(不 eval、不拼接命令、不解析外部实体)
//   2) 输入长度与条数双重上限(防超大响应拖垮运行时 / 正则回溯)
//   3) 只保留 http(s) 链接,过滤 javascript: / data: 等
//   4) 输出形状固定,交给 Research Agent 的白名单与新鲜度逻辑处理
export const NEWS_MAX_BYTES = 512 * 1024;
export const NEWS_MAX_ITEMS = 40;
export const NEWS_SUMMARY_MAX = 400;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#34": '"', "#38": "&" };

export function decodeEntities(input) {
  const s = String(input == null ? "" : input);
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
    if (ENTITIES[code] != null) return ENTITIES[code];
    if (code[0] === "#") {
      const hex = code[1] === "x" || code[1] === "X";
      const n = parseInt(hex ? code.slice(2) : code.slice(1), hex ? 16 : 10);
      // 只接受可打印字符,其他一律丢掉(避免控制字符进入 UI)
      if (Number.isFinite(n) && n >= 32 && n <= 0x10ffff) return String.fromCodePoint(n);
      return "";
    }
    return "";
  });
}

export function stripCdata(input) {
  return String(input == null ? "" : input).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

export function stripHtml(input) {
  const s = stripCdata(input).replace(/<[^>]{0,400}>/g, " ");
  return decodeEntities(s).replace(/\s+/g, " ").trim();
}

// 抽取第一个 <tag>…</tag> 的文本
export function tagText(block, tag) {
  const re = new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">", "i");
  const m = String(block || "").match(re);
  return m ? m[1] : null;
}

// 链接白名单:只允许 http/https,其他(含 javascript:/data:)一律丢弃
export function safeUrl(raw) {
  const s = stripCdata(String(raw == null ? "" : raw)).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch (error) {
    return null;
  }
}

export function parseTimeMs(raw) {
  if (raw == null) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? Math.round(n) : Math.round(n * 1000);   // 秒/毫秒自适应
  const t = Date.parse(stripCdata(String(raw)));
  return Number.isFinite(t) ? t : null;
}

// ---- RSS 2.0(CoinTelegraph / 任何标准 RSS) ----
export function parseRssItems(xml, options) {
  const opts = options || {};
  const sourceId = opts.source_id || "cointelegraph";
  const sourceKind = opts.source_kind || "reputable_media";
  const limit = Math.min(NEWS_MAX_ITEMS, Math.max(1, Number(opts.limit) || 20));
  const text = String(xml == null ? "" : xml).slice(0, opts.max_bytes || NEWS_MAX_BYTES);
  const items = text.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];
  const out = [];
  for (const block of items) {
    if (out.length >= limit) break;
    const title = stripHtml(tagText(block, "title"));
    const link = safeUrl(tagText(block, "link") || tagText(block, "guid"));
    const publishedAt = parseTimeMs(tagText(block, "pubDate") || tagText(block, "dc:date") || tagText(block, "published"));
    if (!title || !link || publishedAt == null) continue;   // §19:没有发布时间的条目一律不要
    const summary = stripHtml(tagText(block, "description") || tagText(block, "content:encoded")).slice(0, NEWS_SUMMARY_MAX);
    out.push({
      title,
      url: link,
      summary,
      published_at: publishedAt,
      fetched_at: Number(opts.now) || null,
      source_id: sourceId,
      source_kind: sourceKind,
      guid: stripHtml(tagText(block, "guid")) || null
    });
  }
  return out;
}

// ---- OKX 官方公告 ----
export function normalizeOkxAnnouncements(payload, options) {
  const opts = options || {};
  const limit = Math.min(NEWS_MAX_ITEMS, Math.max(1, Number(opts.limit) || 20));
  const groups = payload && payload.data ? payload.data : [];
  const out = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    const details = group && Array.isArray(group.details) ? group.details : [];
    for (const d of details) {
      if (out.length >= limit) break;
      if (!d) continue;
      const title = stripHtml(d.title);
      const url = safeUrl(d.url);
      const publishedAt = parseTimeMs(d.pTime || d.cTime || d.businessPTime);
      if (!title || !url || publishedAt == null) continue;
      out.push({
        title,
        url,
        summary: stripHtml(d.summary || "").slice(0, NEWS_SUMMARY_MAX),
        published_at: publishedAt,
        fetched_at: Number(opts.now) || null,
        source_id: "okx_official",
        source_kind: "exchange",
        ann_type: String(d.annType || group.annType || ""),
        guid: null
      });
    }
  }
  return out.sort((a, b) => b.published_at - a.published_at).slice(0, limit);
}

// ---- 粗粒度情绪判定(仅用于 Research 的 sentiment 字段;不做"大神说什么就买什么") ----
const BULL_WORDS = ["surge", "rally", "soar", "all-time high", "ath", "bullish", "inflow", "approve", "approval", "adopt", "partnership", "listing", "upgrade", "record high", "gain", "jump", "rebound"];
const BEAR_WORDS = ["plunge", "crash", "dump", "hack", "exploit", "bearish", "outflow", "ban", "lawsuit", "delist", "halt", "suspend", "bankrupt", "liquidation", "selloff", "drop", "fall", "warning", "risk"];
const HIGH_IMPORTANCE = ["hack", "exploit", "ban", "halt", "suspend", "delist", "bankrupt", "sec", "regulator", "etf", "approval", "listing"];

export function scoreHeadline(item) {
  const text = (String(item.title || "") + " " + String(item.summary || "")).toLowerCase();
  let bull = 0;
  let bear = 0;
  for (const w of BULL_WORDS) if (text.includes(w)) bull += 1;
  for (const w of BEAR_WORDS) if (text.includes(w)) bear += 1;
  const importance = HIGH_IMPORTANCE.some((w) => text.includes(w)) ? 78 : 45 + Math.min(20, (bull + bear) * 6);
  const sentiment = bull === bear ? "neutral" : bull > bear ? "bullish" : "bearish";
  const strength = Math.min(1, Math.abs(bull - bear) / 3);
  return {
    sentiment,
    importance: Math.min(95, importance),
    confidence: Math.round(45 + strength * 35),
    keyword_hits: { bull, bear },
    note: "关键词粗判,只作情绪上下文"
  };
}
