// tools/test-external.mjs · V14.4 DataHub + External Market Intelligence + Research Agent 测试
// A DataHub(TTL/freshness/上限/并发合并)  B Funding 拥挤风险  C OI 四象限
// D 多空比只作上下文  E 新闻时效/冲突/来源质量  F 外部数据权限边界(只能降风险)
// G 失败即 unavailable(不阻塞主循环)  H Research Agent(去重/预算/熔断/来源白名单)
// I Candidate Registry 闸门  J 上游路由转换
import fs from "node:fs";
import path from "node:path";
import {
  DATA_TTLS, createDataHub, freshnessOf
} from "../worker/src/paper/dataHub.js";
import {
  fundingContext, oiContext, positioningContext, takerContext, liquidationContext,
  buildNewsContext, buildExternalContext, externalUnavailable, externalRiskGate, loadExternalContext,
  newsFreshness, NEWS_MAX_AGE_MS, SOURCE_QUALITY
} from "../worker/src/paper/externalData.js";
import {
  RESEARCH_SOURCES, RESEARCH_TRIGGERS, RESEARCH_BUDGET_DEFAULTS, IDEA_STATUSES, MUTATES_SOURCE_CODE,
  sourceOf, isSourceAllowed, hashText, dedupeKeys, createDedupeIndex, shouldResearch, createResearchBudget,
  createCircuitBreaker, withTimeout, researchResult, createResearchAgent, ideaRecord, evaluateIdeaGates,
  saveIdea, listIdeas, researchContext
} from "../worker/src/paper/research.js";
import { createHistoryStore } from "../worker/src/history/store.js";

const ROOT = path.resolve(import.meta.dirname, "..");
let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log("PASS  " + name); }
  else { failed += 1; console.log("FAIL  " + name + (detail ? "  => " + detail : "")); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}
function near(name, actual, expected, tol) {
  check(name, Math.abs(actual - expected) <= (tol == null ? 1e-9 : tol), `got ${actual} want ~${expected}`);
}

const T0 = 1700000000000;

console.log("== A. DataHub:统一缓存 / TTL / freshness / 上限 / 并发合并(§12/§13) ==");
{
  let clock = T0;
  const hub = createDataHub({ now: () => clock, max_entries: 5 });
  eq("cache key = provider|symbol|data_type|interval", hub.keyOf({ provider: "binance", symbol: "BTCUSDT", data_type: "funding", interval: "5m" }), "binance|BTCUSDT|funding|5m");
  hub.set({ provider: "binance", symbol: "BTCUSDT", data_type: "funding", interval: "5m" }, { rate: 0.0001 }, { ttl: DATA_TTLS.funding, source: "binance-fapi" });
  const hit = hub.get({ provider: "binance", symbol: "BTCUSDT", data_type: "funding", interval: "5m" });
  check("写入后立即可读", hit.ok === true && hit.value.rate === 0.0001, JSON.stringify(hit).slice(0, 120));
  eq("新鲜度为 1", hit.freshness, 1);
  eq("带来源与时间戳", [hit.source, hit.timestamp], ["binance-fapi", T0]);
  clock += DATA_TTLS.funding + 1000;
  eq("超过 TTL 视为过期(默认不返回)", hub.get({ provider: "binance", symbol: "BTCUSDT", data_type: "funding", interval: "5m" }).reason, "stale");
  check("显式允许时可拿旧值但要标 stale", hub.get({ provider: "binance", symbol: "BTCUSDT", data_type: "funding", interval: "5m" }, { allowStale: true }).stale === true);
  eq("不同数据类型 TTL 不同(避免全量刷新)", DATA_TTLS.price < DATA_TTLS.funding && DATA_TTLS.funding < DATA_TTLS.news, true);
  check("news TTL 是低频", DATA_TTLS.news >= 600000, String(DATA_TTLS.news));
  // 并发合并:同一 key 同时请求只打一次上游
  let calls = 0;
  const slow = async () => { calls += 1; await new Promise((r) => setTimeout(r, 30)); return { v: 42 }; };
  const [r1, r2, r3] = await Promise.all([
    hub.fetchOnce({ provider: "p", symbol: "S", data_type: "open_interest", interval: "5m" }, slow),
    hub.fetchOnce({ provider: "p", symbol: "S", data_type: "open_interest", interval: "5m" }, slow),
    hub.fetchOnce({ provider: "p", symbol: "S", data_type: "open_interest", interval: "5m" }, slow)
  ]);
  eq("并发请求只打一次上游(in-flight 合并)", calls, 1);
  check("三方都拿到同一结果", r1.value.v === 42 && r2.value.v === 42 && r3.value.v === 42);
  check("统计里有 dedup 计数", hub.stats().dedup >= 2, JSON.stringify(hub.stats()));
  // 失败 → 明确 unavailable,不写假值
  const failedKey = { provider: "p", symbol: "FAIL", data_type: "funding", interval: "5m" };
  const failRes = await hub.fetchOnce(failedKey, async () => { throw new Error("upstream 502"); });
  check("失败被标记不可用且带真实原因", failRes.ok === false && /upstream 502/.test(failRes.entry.error), JSON.stringify(failRes).slice(0, 140));
  eq("失败不产生可用值", hub.get(failedKey).ok, false);
  check("快照里区分 available 与 error", hub.snapshot().some((e) => e.available === false && e.error), JSON.stringify(hub.snapshot().slice(0, 2)));
  // 上限淘汰
  for (let i = 0; i < 20; i += 1) hub.set({ provider: "p", symbol: "S" + i, data_type: "price", interval: "1m" }, { i }, { ttl: 1000 });
  check("条目数受 max_entries 约束", hub.size() <= 5, String(hub.size()));
  check("淘汰被计数", hub.stats().evictions > 0, JSON.stringify(hub.stats()));
}

console.log("== B. Funding → 拥挤风险(§8) ==");
{
  const missing = fundingContext({ reason: "upstream timeout" });
  check("取不到费率 → unavailable 且不猜", missing.available === false && missing.rate === null && missing.extreme === false, JSON.stringify(missing));
  const normal = fundingContext({ rate: 0.00005, prev_rate: 0.00004 });
  check("常态费率不标极端", normal.available === true && normal.extreme === false && normal.elevated === false, JSON.stringify(normal));
  check("常态费率拥挤度低", normal.crowding_risk < 30, String(normal.crowding_risk));
  const high = fundingContext({ rate: 0.0012, prev_rate: 0.0004 });
  check("极高正费率 → 极端 + 多头付费方向", high.extreme === true && high.direction === "longs_pay", JSON.stringify(high));
  check("拥挤风险 ≥ 80", high.crowding_risk >= 80, String(high.crowding_risk));
  check("费率变化被记录", high.rate_change > 0 && high.rate_change_pct > 0, JSON.stringify([high.rate_change, high.rate_change_pct]));
  check("文案明确不解读为继续同向", /不解读为继续同向/.test(high.note), high.note);
  const neg = fundingContext({ rate: -0.0011 });
  check("极高负费率 → 空头拥挤", neg.extreme === true && neg.direction === "shorts_pay", JSON.stringify(neg));
  eq("null 费率不被当成 0", fundingContext({ rate: null }).available, false);
}

console.log("== C. OI 四象限(§9) ==");
{
  eq("取不到 OI → unavailable", oiContext({ reason: "x" }).available, false);
  const up = oiContext({ open_interest: 110, prev_open_interest: 100, price_change_pct: 1 });
  eq("价涨 + OI 增 → 趋势确认", up.interpretation, "trend_confirm_up");
  near("OI 变化百分比", up.oi_change_pct, 10, 1e-6);
  const weak = oiContext({ open_interest: 90, prev_open_interest: 100, price_change_pct: 1 });
  eq("价涨 + OI 减 → 空头回补(持续性弱)", weak.interpretation, "weak_up_short_covering");
  const down = oiContext({ open_interest: 110, prev_open_interest: 100, price_change_pct: -1 });
  eq("价跌 + OI 增 → 下跌趋势确认", down.interpretation, "trend_confirm_down");
  const liq = oiContext({ open_interest: 90, prev_open_interest: 100, price_change_pct: -1 });
  eq("价跌 + OI 减 → 多头出清", liq.interpretation, "long_liquidation");
  const flat = oiContext({ open_interest: 100.1, prev_open_interest: 100, price_change_pct: 1 });
  eq("OI 几乎没变 → neutral", flat.interpretation, "neutral");
  check("四种组合的解读文案各不相同", new Set([up.label, weak.label, down.label, liq.label]).size === 4);
  check("文案强调必须与价格组合", /必须与价格组合解读/.test(up.note), up.note);
}

console.log("== D. 多空比只作上下文(§10) ==");
{
  eq("取不到 → unavailable", positioningContext({}).available, false);
  const crowded = positioningContext({ long_short_ratio: 2.5, long_account_pct: 71, short_account_pct: 29 });
  check("极高多空比 → 标记拥挤", crowded.crowded === true && crowded.sentiment === "crowded_long", JSON.stringify(crowded));
  check("文案禁止直接当作方向", /不单独决定方向/.test(crowded.note), crowded.note);
  const balanced = positioningContext({ long_short_ratio: 1.05 });
  eq("均衡多空比 → balanced", balanced.sentiment, "balanced");
}

console.log("== E. Taker / 爆仓 ==");
{
  eq("取不到 taker → unavailable", takerContext({}).available, false);
  const t = takerContext({ taker_buy_volume: 70, taker_sell_volume: 30 });
  near("失衡度 = (买-卖)/总量", t.imbalance, 0.4, 1e-9);
  eq("文案标主动买占优", t.label, "主动买占优");
  const lq = liquidationContext({ long_liquidations: 900, short_liquidations: 100 });
  eq("多头爆仓占绝对多数 → 挤压", lq.cluster, "long_liquidations");
  eq("爆仓均衡时不标挤压", liquidationContext({ long_liquidations: 500, short_liquidations: 500 }).cluster, null);
}

console.log("== F. 新闻时效 / 冲突 / 来源质量(§18/§19/§21/§22) ==");
{
  eq("没有发布时间的条目新鲜度为 0", newsFreshness({ summary: "x" }, T0), 0);
  near("刚发布的新闻新鲜度 ≈ 1", newsFreshness({ published_at: T0 }, T0), 1, 1e-6);
  check("6 小时前 ≈ 半衰", Math.abs(newsFreshness({ published_at: T0 - 6 * 3600000 }, T0) - 0.5) < 0.01, String(newsFreshness({ published_at: T0 - 6 * 3600000 }, T0)));
  eq("超过 3 天为 0", newsFreshness({ published_at: T0 - NEWS_MAX_AGE_MS - 1 }, T0), 0);
  const empty = buildNewsContext([], { now: T0 });
  eq("没有新闻 → unavailable", empty.available, false);
  const stale = buildNewsContext([{ summary: "old", published_at: T0 - 4 * 86400000, sentiment: "bullish" }], { now: T0 });
  eq("全过期 → 明确 stale", stale.status, "stale");
  const bullish = buildNewsContext([{ summary: "ETF approved", published_at: T0 - 600000, sentiment: "bullish", importance: 90, confidence: 90, source_kind: "official" }], { now: T0 });
  check("偏多新闻被识别", bullish.available === true && bullish.sentiment === "bullish" && bullish.confidence > 0, JSON.stringify(bullish).slice(0, 140));
  check("新鲜度以百分比暴露", bullish.freshness > 90, String(bullish.freshness));
  // 冲突:同权重多空各半 → CONFLICTED,且置信度被压低
  const conflicted = buildNewsContext([
    { summary: "bull case", published_at: T0 - 600000, sentiment: "bullish", importance: 80, source_kind: "official" },
    { summary: "bear case", published_at: T0 - 600000, sentiment: "bearish", importance: 80, source_kind: "official" }
  ], { now: T0 });
  eq("同权重相反消息 → CONFLICTED", conflicted.status, "conflicted");
  eq("冲突时不站边(中性)", conflicted.sentiment, "neutral");
  check("冲突时置信度被压低(≤60)", conflicted.confidence <= 60, String(conflicted.confidence));
  // §17:社区内容权重远低于官方(同样内容)
  const official = buildNewsContext([{ summary: "s", published_at: T0 - 600000, sentiment: "bullish", importance: 80, source_kind: "official" }], { now: T0 });
  const community = buildNewsContext([{ summary: "s", published_at: T0 - 600000, sentiment: "bullish", importance: 80, source_kind: "community" }], { now: T0 });
  check("官方来源置信度高于社区", official.confidence > community.confidence, JSON.stringify([official.confidence, community.confidence]));
  check("来源质量表有明确分级", SOURCE_QUALITY.official > SOURCE_QUALITY.reputable_media && SOURCE_QUALITY.reputable_media > SOURCE_QUALITY.community);
}

console.log("== G. 外部 Context 的权限边界与失败降级(§6/§17/§62) ==");
{
  const full = buildExternalContext({
    now: T0,
    funding: { rate: 0.0001 },
    oi: { open_interest: 110, prev_open_interest: 100, price_change_pct: 0.5 },
    positioning: { long_short_ratio: 1.2 },
    taker: { taker_buy_volume: 60, taker_sell_volume: 40 }
  });
  eq("§20:拆分为 6 个分项上下文", ["funding_context", "oi_context", "positioning_context", "taker_context", "liquidations_context", "news_context", "macro_context"].every((k) => full[k] != null), true);
  check("部分缺失时状态为 partial", full.overall.status === "partial" && full.overall.unavailable.length > 0, JSON.stringify(full.overall));
  check("缺失项带原因", full.overall.unavailable.every((u) => u.type && u.reason), JSON.stringify(full.overall.unavailable));
  eq("永不授予开仓权限", full.permissions.can_grant_open, false);
  eq("可以降低风险", full.permissions.can_reduce_risk, true);
  const none = externalUnavailable("all upstream down", T0);
  eq("全部失败 → unavailable", none.overall.status, "unavailable");
  eq("全部失败时 available = false", none.overall.available, false);
  eq("全部失败时假阳性为 0", Math.max(none.funding_context.crowding_risk || 0, none.oi_context.open_interest || 0), 0);
  // gate:只能收紧
  const gate = externalRiskGate({ external: full });
  eq("gate 恒不放行", gate.can_grant_open, false);
  check("gate 只给出非负的收紧量", gate.risk_score_delta >= 0 && gate.confidence_penalty >= 0, JSON.stringify(gate));
  const stress = buildExternalContext({
    now: T0,
    funding: { rate: 0.0015 },
    liquidations: { long_liquidations: 950, short_liquidations: 50 },
    news: [
      { summary: "a", published_at: T0 - 600000, sentiment: "bullish", importance: 80, source_kind: "official" },
      { summary: "b", published_at: T0 - 600000, sentiment: "bearish", importance: 80, source_kind: "official" }
    ]
  });
  check("压力升高被识别", stress.market_stress_context.stress_score > 0 && /High|Medium/.test(stress.market_stress_context.level), JSON.stringify(stress.market_stress_context));
  const stressGate = externalRiskGate({ external: stress });
  check("压力情形下收紧量更大", stressGate.strictness > gate.strictness, JSON.stringify([stressGate.strictness, gate.strictness]));
  // §63:上游全挂也不阻塞 —— loadExternalContext 不抛错,返回 unavailable
  const hub = createDataHub({ now: () => T0 });
  const broken = await loadExternalContext({
    hub, symbol: "BTCUSDT", now: T0,
    fetchFunding: async () => { throw new Error("timeout"); },
    fetchOpenInterest: async () => { throw new Error("timeout"); }
  });
  eq("上游异常时不抛错且标 unavailable", broken.overall.status, "unavailable");
  // 成功路径
  const ok = await loadExternalContext({
    hub, symbol: "BTCUSDT", now: T0,
    fetchFunding: async () => ({ rate: 0.00008 }),
    fetchOpenInterest: async () => ({ open_interest: 110, prev_open_interest: 100, price_change_pct: 1 })
  });
  check("成功路径产出可用上下文", ok.overall.available === true && ok.funding_context.available && ok.oi_context.available, JSON.stringify(ok.overall).slice(0, 120));
  eq("第二次读取走缓存(数据经 DataHub 统一)", (await loadExternalContext({ hub, symbol: "BTCUSDT", now: T0, fetchFunding: async () => ({ rate: 9 }) })).funding_context.rate, 0.00008);
}

console.log("== H. Research Agent(§14-§19, §63-§67) ==");
{
  eq("§70:声明不改生产代码", MUTATES_SOURCE_CODE, false);
  const src = fs.readFileSync(path.join(ROOT, "worker/src/paper/research.js"), "utf8");
  check("research.js 不引入 fs/child_process(不能改源码)", !/from "node:fs"|from "node:child_process"|writeFileSync/.test(src));
  check("research.js 不含随机数", !/Math\.random/.test(src));
  check("来源白名单含官方与社区分级", RESEARCH_SOURCES.some((s) => s.kind === "official") && RESEARCH_SOURCES.some((s) => s.kind === "community" && s.sentiment_only === true));
  eq("未登记来源不被允许", isSourceAllowed("random_blog"), false);
  eq("官方来源被允许", isSourceAllowed("project_official"), true);
  eq("社区来源被允许但只作情绪", sourceOf("community_sentiment").sentiment_only, true);
  // 去重:同 URL / 同内容 / 同 event_id
  const idx = createDedupeIndex();
  const item = { title: "BTC ETF inflow", summary: "big inflow", url: "https://example.com/a?utm=1", published_at: T0 };
  const first = idx.check(item);
  eq("首次出现不算重复", first.duplicate, false);
  eq("同 URL(带跟踪参数)被判重复", idx.check({ ...item, url: "https://example.com/a?utm=2" }).duplicate, true);
  eq("同内容不同 URL 也判重复", idx.check({ ...item, url: "https://other.com/b" }).duplicate, true);
  check("event_id / content_hash / url_hash 三键齐全", first.keys.event_id && first.keys.content_hash && first.keys.url_hash, JSON.stringify(first.keys));
  check("hashText 稳定", hashText("abc") === hashText("abc") && hashText("abc") !== hashText("abd"));
  // 触发条件:平时不搜
  eq("无触发条件 → 不研究", shouldResearch({ price_change_pct: 0.2, volatility_ratio: 1 }).research, false);
  check("重大行情变化触发", shouldResearch({ price_change_pct: 5 }).trigger_ids.includes("big_move"), JSON.stringify(shouldResearch({ price_change_pct: 5 }).trigger_ids));
  check("波动骤升触发", shouldResearch({ volatility_ratio: 2.5 }).trigger_ids.includes("vol_spike"));
  check("Rule/ML 冲突触发", shouldResearch({ rule_ml_conflict: true }).trigger_ids.includes("rule_ml_conflict"));
  check("高杠杆新仓触发", shouldResearch({ opening: true, leverage: 8 }).trigger_ids.includes("high_leverage"));
  check("Regime 切换触发", shouldResearch({ regime_changed: true }).trigger_ids.includes("regime_change"));
  check("定时低频仅在间隔足够时触发", shouldResearch({ scheduled_due: true, ms_since_last_research: 60000 }).research === false && shouldResearch({ scheduled_due: true, ms_since_last_research: 8 * 3600000 }).research === true);
  eq("触发条件清单完整(§15)", RESEARCH_TRIGGERS.length, 8);
  // 预算
  let clock = T0;
  const budget = createResearchBudget({ now: () => clock, daily_searches: 3, daily_tokens: 100 });
  check("预算初始充足", budget.canSpend({ searches: 1 }).ok === true);
  budget.spend({ searches: 1 });
  budget.spend({ searches: 1 });
  check("剩余可算", budget.state().remaining.searches === 1, JSON.stringify(budget.state()));
  eq("超出预算被拒", budget.canSpend({ searches: 5 }).ok, false);
  eq("超出预算原因可追溯", budget.canSpend({ searches: 5 }).reason, "search_budget_exhausted");
  clock += 86400000;
  eq("跨天自动重置", budget.state().used.searches, 0);
  check("Token 预算独立受限", budget.canSpend({ tokens: 5000 }).ok === false);
  // 熔断
  const circuit = createCircuitBreaker({ now: () => clock, failures: 2, cooldownMs: 60000 });
  check("初始可用", circuit.canTry() === true);
  circuit.onFailure();
  check("一次失败仍可用", circuit.canTry() === true);
  circuit.onFailure();
  eq("达到阈值后熔断", circuit.state().open, true);
  clock += 61000;
  check("冷却后恢复", circuit.canTry() === true);
  circuit.onSuccess();
  eq("成功后计数清零", circuit.state().fails, 0);
  // 超时
  let timedOut = false;
  try { await withTimeout(new Promise(() => {}), 30, "research"); } catch (error) { timedOut = /research_timeout/.test(error.message); }
  check("超时被识别", timedOut === true);
  // 结构化输出(§18)
  const rec = researchResult({ summary: "SEC approves ETF", sentiment: "bullish", importance: 88, confidence: 80, source_id: "regulator", published_at: T0 - 600000, url: "https://sec.gov/x", symbol: "BTCUSDT" }, { now: T0 });
  check("输出字段符合 §18 契约", ["timestamp", "symbol", "event_type", "importance", "sentiment", "confidence", "source_quality", "freshness", "summary", "risk_flags"].every((k) => rec[k] != null), Object.keys(rec).join(","));
  check("同时保存发布与抓取时间(§19)", rec.published_at != null && rec.fetched_at != null);
  check("监管来源质量高", rec.source_quality >= 90, String(rec.source_quality));
  eq("白名单外来源会被 agent 过滤", isSourceAllowed("random_blog"), false);

  // Agent 端到端:无 provider → unavailable 不伪造
  const noProv = createResearchAgent({ now: () => clock });
  const noProvRes = await noProv.run({ price_change_pct: 5, symbol: "BTCUSDT" });
  eq("无 provider 时不伪造结果", [noProvRes.ok, noProvRes.reason], [false, "no_provider"]);
  eq("无 provider 时缓存为空", noProv.read().available, false);
  // 正常路径 + 去重 + 来源过滤 + 过期过滤
  let fetches = 0;
  const agent = createResearchAgent({
    now: () => clock,
    fetchFn: async () => {
      fetches += 1;
      return [
        { source_id: "project_official", summary: "official upgrade", sentiment: "bullish", importance: 80, confidence: 80, published_at: clock - 600000, url: "https://proj.io/1" },
        { source_id: "random_blog", summary: "clickbait", sentiment: "bullish", importance: 90, published_at: clock - 600000, url: "https://blog.io/2" },
        { source_id: "reputable_media", summary: "stale piece", sentiment: "bearish", importance: 70, published_at: clock - 5 * 86400000, url: "https://news.io/3" },
        { source_id: "binance_announcements", summary: "same url as official", sentiment: "bullish", importance: 80, confidence: 80, published_at: clock - 600000, url: "https://proj.io/1?utm=1" }
      ];
    }
  });
  const run1 = await agent.run({ price_change_pct: 5, symbol: "BTCUSDT" });
  check("跑一次拿到结果", run1.ok === true && run1.results.length === 1, JSON.stringify(run1).slice(0, 200));
  check("白名单外来源被拒且不进入结果", run1.rejected >= 1 && !run1.results.some((r) => r.source === "random_blog"), JSON.stringify(run1.results.map((r) => r.source)));
  check("同 URL(带跟踪参数)被去重", agent.stats().duplicates >= 1, JSON.stringify(agent.stats()));
  check("过期内容被剔除且不进入结果", run1.results.every((r) => r.freshness > 0) && !run1.results.some((r) => r.summary === "stale piece"), JSON.stringify(run1.results.map((r) => r.summary)));
  check("缓存可读且标记可用", agent.read().available === true && agent.read().updated_at === clock);
  const run2 = await agent.run({ price_change_pct: 5, symbol: "BTCUSDT" });
  eq("重复内容不会重复进入缓存", run2.results.length, 0);
  check("两次都调了上游但结果去重", fetches === 2, String(fetches));
  const noTrigger = await agent.run({ price_change_pct: 0.1 });
  eq("无触发条件时跳过(不搜索)", [noTrigger.ok, noTrigger.skipped], [false, true]);
  // 失败 → 熔断 → 恢复
  const failing = createResearchAgent({ now: () => clock, fetchFn: async () => { throw new Error("network down"); }, circuit: createCircuitBreaker({ now: () => clock, failures: 1, cooldownMs: 60000 }) });
  const f1 = await failing.run({ price_change_pct: 5 });
  eq("上游失败被标记", [f1.ok, f1.reason], [false, "fetch_failed"]);
  const f2 = await failing.run({ price_change_pct: 5 });
  eq("连续失败后熔断", f2.reason, "circuit_open");
  const slowAgent = createResearchAgent({ now: () => clock, fetchFn: () => new Promise(() => {}), timeoutMs: 30 });
  const t1 = await slowAgent.run({ price_change_pct: 5 });
  eq("超时被识别且返回", t1.reason, "timeout");
  // 预算耗尽
  const tightAgent = createResearchAgent({ now: () => clock, fetchFn: async () => [], budget: createResearchBudget({ now: () => clock, daily_searches: 0 }) });
  eq("预算耗尽时拒绝联网", (await tightAgent.run({ price_change_pct: 5 })).reason, "search_budget_exhausted");
  // §63:researchContext 读缓存,绝不阻塞
  const ctx = researchContext(agent.read(), { now: clock });
  check("研究上下文可用", ctx.available === true && ctx.news.available === true, JSON.stringify(ctx).slice(0, 140));
  const ctxEmpty = researchContext({ available: false, reason: "no_trigger" }, { now: clock });
  eq("缓存空时明确 unavailable", ctxEmpty.available, false);
}

console.log("== I. Candidate Registry 闸门(§69/§71) ==");
{
  const store = await createHistoryStore({ memory: true });
  const adapter = { get: (t, k) => store.generic.get(t, k), all: (t, l) => store.generic.all(t, l), put: (t, r) => store.generic.put(t, r), del: (t, k) => store.generic.del(t, k) };
  const idea = ideaRecord({ hypothesis: "ATR 分层仓位在震荡市更稳", proposed_rule: "size = equity * k / atr_pct", required_features: ["atr_pct"], source: "research", formalized: true }, { now: T0 });
  eq("初始状态 DISCOVERED", idea.status, "DISCOVERED");
  const weak = evaluateIdeaGates(idea);
  eq("无回测数据不通过", weak.eligible, false);
  check("闸门包含 backtest/walkforward/shadow", ["回测样本不足", "Walk Forward Fold 不足", "Paper Shadow 样本不足"].every((m) => weak.reasons.some((r) => r.includes(m))), JSON.stringify(weak.reasons));
  const strong = evaluateIdeaGates({ ...idea, backtest_result: { samples: 200, net_pnl: 5, max_drawdown_pct: 10 }, walkforward_result: { folds: 4, pass_rate: 0.75 }, paper_shadow_result: { samples: 80, net_pnl: 1.2 } });
  eq("全部闸门通过 → 可进入 CHALLENGER", [strong.eligible, strong.next_status], [true, "CHALLENGER"]);
  const badBt = evaluateIdeaGates({ ...idea, backtest_result: { samples: 200, net_pnl: -3, max_drawdown_pct: 10 }, walkforward_result: { folds: 4, pass_rate: 0.75 }, paper_shadow_result: { samples: 80, net_pnl: 1 } });
  eq("回测亏损 → 拒绝", badBt.eligible, false);
  eq("回测亏损标记 REJECTED 依据", badBt.rejected, true);
  const saved = await saveIdea(adapter, { hypothesis: "x", proposed_rule: "r", formalized: true }, { now: T0 });
  check("想法入库并带闸门结果", saved.idea_id && saved.gate_eligible === false, JSON.stringify(saved).slice(0, 140));
  const saved2 = await saveIdea(adapter, { hypothesis: "y", proposed_rule: "r", formalized: true, backtest_result: { samples: 300, net_pnl: 9, max_drawdown_pct: 5 }, walkforward_result: { folds: 5, pass_rate: 0.8 }, paper_shadow_result: { samples: 90, net_pnl: 2 } }, { now: T0 });
  eq("通过闸门的想法状态推进到 CHALLENGER", saved2.status, "CHALLENGER");
  const list = await listIdeas(adapter);
  eq("登记表可列出全部想法", list.length, 2);
  eq("可按状态筛选", (await listIdeas(adapter, "CHALLENGER")).length, 1);
  check("状态枚举包含全部 5 档", IDEA_STATUSES.join(",") === "DISCOVERED,TESTING,REJECTED,CHALLENGER,PROMOTED", IDEA_STATUSES.join(","));
  check("想法备注强调不能直接改生产", /不能直接改生产逻辑/.test(idea.note), idea.note);
}

console.log("== J. 上游路由(§7) ==");
{
  const proxy = await import("../worker/src/proxy.js");
  eq("OI 路由存在", proxy.routes.futures.open_interest, "/futures/data/openInterestHist");
  eq("多空比路由存在", proxy.routes.futures.long_short, "/futures/data/globalLongShortAccountRatio");
  eq("Taker 路由存在", proxy.routes.futures.taker, "/futures/data/takerlongshortRatio");
  eq("周期白名单兜底", [proxy.cleanExternalPeriod("1h"), proxy.cleanExternalPeriod("7d")], ["1h", "5m"]);
  const worker = (await import("../worker/index.js")).default;
  for (const [path, needle] of [["/api/open_interest", "仅期货"], ["/api/long_short", "仅期货"], ["/api/taker", "仅期货"]]) {
    const res = await worker.fetch(new Request("https://app.local" + path + "?market=spot&symbol=BTCUSDT"));
    const body = await res.json();
    check("现货请求 " + path + " 被明确拒绝(不伪造)", res.status === 400 && String(body.error).includes(needle), res.status + " " + JSON.stringify(body));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("EXTERNAL TESTS OK");
