// paper/research.js · External Research Agent + Idea Registry(V14.4)
// §14-§19, §63-§71:自动联网收集"行情之外"的上下文。
//
// 边界(全部可测试):
//   1) Research Agent 不是交易 Agent:只搜索/去重/整理/结构化,不产生下单指令
//   2) 不伪造数据:没有 provider 或取不到 → unavailable,绝不编造新闻
//   3) 不阻塞 Paper Loop(§63):异步更新缓存,决策只读"最近一次有效结果"
//   4) 有预算、有超时、有熔断、有去重;同一事件不反复分析(§66/§67)
//   5) 绝不修改生产源码(§70):结果只能进入 Candidate Registry
import { num, numOrNull, round } from "./accounting.js";
import { SOURCE_QUALITY, newsFreshness, buildNewsContext } from "./externalData.js";

export const RESEARCH_VERSION = "research-v14.4";
// §70:研究结果永远不能直接改源码/上线
export const MUTATES_SOURCE_CODE = false;
export const AUTO_PROMOTES_IDEAS = false;

// §16:信息源优先级(官方 > 监管 > 交易所 > 数据商 > 可靠媒体 > 社区)
export const RESEARCH_SOURCES = [
  { id: "okx_official", kind: "exchange", quality: SOURCE_QUALITY.exchange, label: "OKX 官方公告", allow: true },
  { id: "binance_announcements", kind: "exchange", quality: SOURCE_QUALITY.exchange, label: "交易所公告", allow: true },
  { id: "project_official", kind: "official", quality: SOURCE_QUALITY.official, label: "项目官方公告", allow: true },
  { id: "regulator", kind: "regulator", quality: SOURCE_QUALITY.regulator, label: "监管公告", allow: true },
  { id: "macro_official", kind: "official", quality: SOURCE_QUALITY.official, label: "公开宏观数据源", allow: true },
  { id: "reputable_media", kind: "reputable_media", quality: SOURCE_QUALITY.reputable_media, label: "可靠金融媒体", allow: true },
  // V14.5:真实 Provider 的 source_id(proxy /api/announcements 与 /api/news 的输出)
  { id: "cointelegraph", kind: "reputable_media", quality: SOURCE_QUALITY.reputable_media, label: "CoinTelegraph RSS", allow: true },
  { id: "community_sentiment", kind: "community", quality: SOURCE_QUALITY.community, label: "社区情绪(仅情绪上下文)", allow: true, sentiment_only: true }
];

export function sourceOf(id) {
  return RESEARCH_SOURCES.find((s) => s.id === id) || { id: id || "unknown", kind: "unknown", quality: SOURCE_QUALITY.unknown, allow: false };
}

export function isSourceAllowed(id) {
  return sourceOf(id).allow === true;
}

export function hashText(text) {
  const s = String(text || "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

// §67:event_id / content hash / URL hash 三重去重键
export function dedupeKeys(item) {
  const i = item || {};
  const url = String(i.url || "").trim().toLowerCase().replace(/[?#].*$/, "");
  const content = String(i.title || "") + "|" + String(i.summary || "").slice(0, 400);
  return {
    event_id: i.event_id || (i.published_at ? "ev_" + num(i.published_at) + "_" + hashText(content) : "ev_" + hashText(content)),
    content_hash: "ch_" + hashText(content),
    url_hash: url ? "uh_" + hashText(url) : null
  };
}

export function createDedupeIndex() {
  const seen = new Map();     // key -> { first_seen, hits, event_id }
  function check(item) {
    const keys = dedupeKeys(item);
    const list = [keys.event_id, keys.content_hash].concat(keys.url_hash ? [keys.url_hash] : []);
    const hit = list.find((k) => seen.has(k));
    if (hit) {
      const rec = seen.get(hit);
      rec.hits += 1;
      // 命中也要登记新键,避免同内容换 URL 后重复
      for (const k of list) if (!seen.has(k)) seen.set(k, rec);
      return { duplicate: true, matched_key: hit, record: rec, keys };
    }
    const rec = { first_seen: Date.now(), hits: 0, event_id: keys.event_id };
    for (const k of list) seen.set(k, rec);
    return { duplicate: false, matched_key: null, record: rec, keys };
  }
  return { check, size: () => seen.size, seen: () => [...seen.entries()] };
}

// §15:只在特定条件下联网,禁止每 5 分钟全网搜索
export const RESEARCH_TRIGGERS = [
  { id: "big_move", label: "重大行情变化" },
  { id: "vol_spike", label: "波动率突然升高" },
  { id: "rule_ml_conflict", label: "Rule/ML 严重冲突" },
  { id: "opening_significant", label: "准备重要新仓" },
  { id: "high_leverage", label: "准备高杠杆 Paper 仓位" },
  { id: "position_risk", label: "重大仓位风险" },
  { id: "regime_change", label: "Market Regime 变化" },
  { id: "scheduled_low_freq", label: "定时低频更新" }
];

export function shouldResearch(ctx, options) {
  const c = ctx || {};
  const opts = { ...{ minMovePct: 3, volRatio: 1.8, leverageThreshold: 5, scheduledMinGapMs: 6 * 3600000 }, ...(options || {}) };
  const reasons = [];
  if (Math.abs(num(c.price_change_pct, 0)) >= opts.minMovePct) reasons.push({ id: "big_move", detail: "价格变动 " + round(num(c.price_change_pct, 0), 2) + "%" });
  if (num(c.volatility_ratio, 1) >= opts.volRatio) reasons.push({ id: "vol_spike", detail: "波动比 " + num(c.volatility_ratio, 1) });
  if (c.rule_ml_conflict === true) reasons.push({ id: "rule_ml_conflict", detail: "Rule 与 ML 方向明显冲突" });
  if (c.opening === true) reasons.push({ id: "opening_significant", detail: "准备新开仓" });
  if (num(c.leverage, 1) >= opts.leverageThreshold && c.opening === true) reasons.push({ id: "high_leverage", detail: "高杠杆 " + num(c.leverage, 1) + "x" });
  if (c.position_at_risk === true) reasons.push({ id: "position_risk", detail: "持仓风险升高" });
  if (c.regime_changed === true) reasons.push({ id: "regime_change", detail: "市场环境切换" });
  if (c.scheduled_due === true && num(c.ms_since_last_research, 0) >= opts.scheduledMinGapMs) reasons.push({ id: "scheduled_low_freq", detail: "定时低频" });
  return { research: reasons.length > 0, reasons, trigger_ids: reasons.map((r) => r.id) };
}

// §65:每日联网预算(搜索次数 / 总结次数 / Token)
export const RESEARCH_BUDGET_DEFAULTS = { daily_searches: 40, daily_summaries: 20, daily_tokens: 30000, per_cycle_searches: 5 };
export function createResearchBudget(options) {
  const opts = { ...RESEARCH_BUDGET_DEFAULTS, ...(options || {}) };
  let day = null;
  const used = { searches: 0, summaries: 0, tokens: 0 };
  const clock = () => num(opts.now ? opts.now() : Date.now());
  function roll(nowMs) {
    const key = new Date(nowMs).toISOString().slice(0, 10);
    if (key !== day) { day = key; used.searches = 0; used.summaries = 0; used.tokens = 0; }
  }
  function state() {
    roll(clock());
    return {
      day,
      used: { ...used },
      caps: { searches: opts.daily_searches, summaries: opts.daily_summaries, tokens: opts.daily_tokens },
      remaining: {
        searches: Math.max(0, opts.daily_searches - used.searches),
        summaries: Math.max(0, opts.daily_summaries - used.summaries),
        tokens: Math.max(0, opts.daily_tokens - used.tokens)
      }
    };
  }
  function canSpend(cost) {
    const c = cost || {};
    const s = state();
    if (num(c.searches, 1) > s.remaining.searches) return { ok: false, reason: "search_budget_exhausted", state: s };
    if (num(c.summaries, 0) > s.remaining.summaries) return { ok: false, reason: "summary_budget_exhausted", state: s };
    if (num(c.tokens, 0) > s.remaining.tokens) return { ok: false, reason: "token_budget_exhausted", state: s };
    return { ok: true, state: s };
  }
  function spend(cost) {
    roll(clock());
    const c = cost || {};
    used.searches += num(c.searches, 0);
    used.summaries += num(c.summaries, 0);
    used.tokens += num(c.tokens, 0);
    return state();
  }
  return { state, canSpend, spend };
}

// §64:超时 / 缓存 / 限流 / 熔断
export function createCircuitBreaker(options) {
  const opts = { ...{ failures: 3, cooldownMs: 10 * 60000 }, ...(options || {}) };
  let fails = 0;
  let blockedUntil = 0;
  let opened = 0;
  const clock = () => num(opts.now ? opts.now() : Date.now());
  return {
    canTry: () => clock() >= blockedUntil,
    onSuccess() { fails = 0; blockedUntil = 0; },
    onFailure() {
      fails += 1;
      if (fails >= opts.failures) { blockedUntil = clock() + opts.cooldownMs; opened += 1; }
      return { fails, blockedUntil };
    },
    state: () => ({ fails, blockedUntil: blockedUntil > clock() ? blockedUntil : null, open: blockedUntil > clock(), opened })
  };
}

export function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error((label || "task") + "_timeout")), num(ms, 8000));
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// §18:统一结构化输出(所有外部信息都必须能落成这个形状)
export function researchResult(item, meta) {
  const i = item || {};
  const m = meta || {};
  const src = sourceOf(i.source_id || m.source_id);
  const now = num(m.now, Date.now());
  const published = numOrNull(i.published_at);
  const freshness = published == null ? 0 : round(newsFreshness(i, now) * 100, 2);
  return {
    timestamp: now,
    symbol: i.symbol || m.symbol || null,
    event_type: i.event_type || "market_news",
    event_id: dedupeKeys(i).event_id,
    importance: Math.max(0, Math.min(100, num(i.importance, 50))),
    sentiment: ["bullish", "neutral", "bearish"].includes(String(i.sentiment)) ? String(i.sentiment) : "neutral",
    confidence: Math.max(0, Math.min(100, num(i.confidence, 50))),
    source_quality: Math.max(0, Math.min(100, num(i.source_quality, src.quality))),
    freshness,
    summary: String(i.summary || "").slice(0, 500),
    risk_flags: Array.isArray(i.risk_flags) ? i.risk_flags.slice(0, 10) : [],
    source: i.source || src.id,
    source_kind: src.kind,
    sentiment_only: Boolean(src.sentiment_only),
    published_at: published,
    fetched_at: num(i.fetched_at, now),
    url: i.url || null
  };
}

// §63:Agent 只负责"异步更新缓存";run 不阻塞、不抛错、失败即 unavailable
export function createResearchAgent(options) {
  const opts = options || {};
  const clock = () => num(opts.now ? opts.now() : Date.now());
  const dedupe = opts.dedupe || createDedupeIndex();
  const budget = opts.budget || createResearchBudget({ now: clock });
  const circuit = opts.circuit || createCircuitBreaker({ now: clock });
  const cache = { results: [], updated_at: null, last_reason: null, last_trigger: null };
  const stats = { runs: 0, skipped: 0, fetched: 0, duplicates: 0, failures: 0, timeouts: 0, blocked: 0, rejected_source: 0 };

  // 只读缓存:决策读"最近一次有效结果"(§63)
  function read() {
    return { results: cache.results.slice(0, 20), updated_at: cache.updated_at, available: cache.results.length > 0, reason: cache.last_reason };
  }

  async function run(ctx) {
    stats.runs += 1;
    const input = ctx || {};
    const decision = shouldResearch(input, opts.triggerOptions);
    if (!decision.research) {
      stats.skipped += 1;
      cache.last_reason = "no_trigger";
      return { ok: false, reason: "no_trigger", skipped: true, results: [] };
    }
    cache.last_trigger = decision.trigger_ids;
    if (!opts.fetchFn) {
      cache.last_reason = "no_provider";
      return { ok: false, reason: "no_provider", results: [], trigger_ids: decision.trigger_ids };
    }
    if (!circuit.canTry()) {
      stats.blocked += 1;
      cache.last_reason = "circuit_open";
      return { ok: false, reason: "circuit_open", results: [], trigger_ids: decision.trigger_ids };
    }
    const allowed = budget.canSpend({ searches: num(opts.searchesPerRun, 1), summaries: 0 });
    if (!allowed.ok) {
      cache.last_reason = allowed.reason;
      return { ok: false, reason: allowed.reason, results: [], trigger_ids: decision.trigger_ids };
    }
    let raw = [];
    try {
      budget.spend({ searches: num(opts.searchesPerRun, 1) });
      raw = await withTimeout(opts.fetchFn({ trigger_ids: decision.trigger_ids, symbol: input.symbol, now: clock() }), num(opts.timeoutMs, 8000), "research");
      circuit.onSuccess();
      stats.fetched += raw && raw.length ? raw.length : 0;
    } catch (error) {
      const isTimeout = /timeout/.test(String(error && error.message));
      if (isTimeout) stats.timeouts += 1;
      else stats.failures += 1;
      circuit.onFailure();
      cache.last_reason = isTimeout ? "timeout" : "fetch_failed";
      return { ok: false, reason: cache.last_reason, results: [], trigger_ids: decision.trigger_ids, detail: String(error && error.message).slice(0, 160) };
    }
    const fresh = [];
    let rejected = 0;
    for (const item of Array.isArray(raw) ? raw : []) {
      if (!item) continue;
      if (!isSourceAllowed(item.source_id || item.source)) { rejected += 1; continue; }
      const d = dedupe.check(item);
      if (d.duplicate) { stats.duplicates += 1; continue; }
      const result = researchResult(item, { now: clock(), symbol: input.symbol });
      // §19:没有发布时间的旧闻不当新消息;新鲜度为 0 直接不要
      if (!result.published_at || result.freshness <= 0) { rejected += 1; continue; }
      fresh.push(result);
    }
    stats.rejected_source += rejected;
    if (fresh.length) {
      cache.results = fresh.concat(cache.results).slice(0, 50);
      cache.updated_at = clock();
      cache.last_reason = "ok";
    } else {
      cache.last_reason = raw && raw.length ? "all_filtered" : "empty_result";
    }
    return {
      ok: fresh.length > 0,
      reason: cache.last_reason,
      results: fresh,
      trigger_ids: decision.trigger_ids,
      duplicates_in_batch: stats.duplicates,
      rejected
    };
  }

  return {
    run,
    read,
    dedupe,
    budget,
    circuit,
    stats: () => ({ ...stats, dedupe_keys: dedupe.size(), budget: budget.state(), circuit: circuit.state() }),
    reset: () => { cache.results = []; cache.updated_at = null; cache.last_reason = null; }
  };
}

// ---- §69/§71:Research Idea Sandbox + Candidate Registry(想法必须过闸门才能上线) ----
export const IDEA_STATUSES = ["DISCOVERED", "TESTING", "REJECTED", "CHALLENGER", "PROMOTED"];
export const IDEA_GATES = ["formalize", "backtest", "walkforward", "paper_shadow"];

export function ideaRecord(idea, meta) {
  const i = idea || {};
  const m = meta || {};
  return {
    idea_id: i.idea_id || "idea_" + hashText(String(i.hypothesis || "") + num(m.now, Date.now())),
    source: i.source || "research",
    source_url: i.source_url || null,
    hypothesis: String(i.hypothesis || "").slice(0, 500),
    required_features: Array.isArray(i.required_features) ? i.required_features.slice(0, 30) : [],
    proposed_rule: String(i.proposed_rule || "").slice(0, 800),
    status: IDEA_STATUSES.includes(i.status) ? i.status : "DISCOVERED",
    backtest_result: i.backtest_result || null,
    walkforward_result: i.walkforward_result || null,
    paper_shadow_result: i.paper_shadow_result || null,
    formalized: Boolean(i.formalized),
    created_at: num(m.now, Date.now()),
    updated_at: num(m.now, Date.now()),
    note: i.note || "研究想法只能进入候选登记表,不能直接改生产逻辑"
  };
}

// 闸门:backtest → walk forward → paper shadow 全部通过才可能 CHALLENGER
export function evaluateIdeaGates(idea, rules) {
  const i = idea || {};
  const R = { ...{ min_backtest_samples: 100, min_backtest_net_pnl: 0, max_backtest_dd_pct: 25, min_walkforward_folds: 3, min_walkforward_pass_rate: 0.6, min_shadow_samples: 50, min_shadow_net_pnl: 0 }, ...(rules || {}) };
  const reasons = [];
  const fail = (m) => reasons.push(m);
  const pass = (m) => reasons.push("通过:" + m);

  if (!i.formalized || !i.proposed_rule) fail("未形式化为可测规则");
  const bt = i.backtest_result || {};
  if (num(bt.samples, 0) < R.min_backtest_samples) fail("回测样本不足(" + num(bt.samples, 0) + ")");
  else pass("回测样本 " + num(bt.samples, 0));
  if (num(bt.net_pnl, 0) <= R.min_backtest_net_pnl) fail("回测净收益未为正(" + num(bt.net_pnl, 0) + ")");
  else pass("回测净收益 " + num(bt.net_pnl, 0));
  if (num(bt.max_drawdown_pct, 0) > R.max_backtest_dd_pct) fail("回测回撤过大(" + num(bt.max_drawdown_pct, 0) + "%)");
  const wf = i.walkforward_result || {};
  if (num(wf.folds, 0) < R.min_walkforward_folds) fail("Walk Forward Fold 不足(" + num(wf.folds, 0) + ")");
  else if (num(wf.pass_rate, 0) < R.min_walkforward_pass_rate) fail("Walk Forward 通过率不足(" + num(wf.pass_rate, 0) + ")");
  else pass("Walk Forward " + num(wf.folds, 0) + " fold / 通过率 " + num(wf.pass_rate, 0));
  const sh = i.paper_shadow_result || {};
  if (num(sh.samples, 0) < R.min_shadow_samples) fail("Paper Shadow 样本不足(" + num(sh.samples, 0) + ")");
  else if (num(sh.net_pnl, 0) <= R.min_shadow_net_pnl) fail("Paper Shadow 净收益未为正(" + num(sh.net_pnl, 0) + ")");
  else pass("Paper Shadow 净收益 " + num(sh.net_pnl, 0));

  const eligible = reasons.every((r) => r.startsWith("通过"));
  return {
    eligible,
    next_status: eligible ? "CHALLENGER" : reasons.some((r) => !r.startsWith("通过") && /未形式化/.test(r)) ? "DISCOVERED" : "TESTING",
    rejected: !eligible && num(bt.samples, 0) >= R.min_backtest_samples && num(bt.net_pnl, 0) < 0,
    reasons,
    rules: R
  };
}

export async function saveIdea(store, idea, meta) {
  const rec = ideaRecord(idea, meta);
  const gates = evaluateIdeaGates(rec);
  const stored = { ...rec, status: rec.status === "DISCOVERED" && gates.eligible ? gates.next_status : rec.status, gate_reasons: gates.reasons, gate_eligible: gates.eligible };
  await store.put("research_ideas", stored);
  return stored;
}

export async function listIdeas(store, status) {
  const all = (await store.all("research_ideas", 200)) || [];
  return all.filter((i) => !status || i.status === status).sort((a, b) => num(b.updated_at) - num(a.updated_at));
}

// §63 + §14:给决策层用的上下文摘要(只读、异步更新、失败不影响主循环)
export function researchContext(agentRead, options) {
  const opts = options || {};
  const r = agentRead || {};
  if (!r.available || !r.results || !r.results.length) {
    return { available: false, status: "unavailable", reason: r.reason || "no_research", news: buildNewsContext([], { now: num(opts.now, Date.now()), reason: r.reason || "no_research" }) };
  }
  const now = num(opts.now, Date.now());
  const news = buildNewsContext(r.results.map((x) => ({
    title: x.summary,
    summary: x.summary,
    published_at: x.published_at,
    sentiment: x.sentiment,
    importance: x.importance,
    confidence: x.confidence,
    source_quality: x.source_quality,
    source_kind: x.source_kind,
    event_id: x.event_id
  })), { now });
  return {
    available: true,
    status: news.status,
    updated_at: r.updated_at,
    item_count: r.results.length,
    official_count: r.results.filter((x) => x.source_kind === "official" || x.source_kind === "exchange" || x.source_kind === "regulator").length,
    community_count: r.results.filter((x) => x.source_kind === "community").length,
    news,
    note: "社区内容只作情绪上下文,不作为事实源"
  };
}
