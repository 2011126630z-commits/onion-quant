// paper/externalData.js · External Market Intelligence(V14.4)
// §6-§11, §20-§23, §62-§67:行情之外的市场上下文。
//
// 三条铁律(全部可测试):
//   1) 外部数据只是 Context:可以"降低"风险敞口,但**永远不能单独决定开仓**(§17)
//   2) 过期信息自动降权(§21):3 天前的新闻不允许影响 15m 决策
//   3) 取不到就是 unavailable(§62):本地引擎继续工作,绝不猜、绝不伪造
import { num, numOrNull, round } from "./accounting.js";
import { DATA_TTLS, freshnessOf } from "./dataHub.js";

export const EXTERNAL_TYPES = ["funding", "open_interest", "long_short_ratio", "taker_flow", "liquidations", "news", "macro"];

// §8:资金费 → 拥挤风险(不是"费率正=继续看涨")
export const FUNDING_EXTREME_ABS = 0.0005;     // 单期 0.05% 视为偏高
export const FUNDING_EXTREME_HIGH = 0.001;     // 单期 0.1% 视为极端
export const OI_CHANGE_MIN_PCT = 0.5;          // OI 变化小于此视为无明显变化

export function fundingContext(input, options) {
  const i = input || {};
  const opts = options || {};
  const rate = numOrNull(i.rate);
  const prev = numOrNull(i.prev_rate);
  if (rate == null) {
    return { available: false, reason: i.reason || "funding_unavailable", status: "unavailable", extreme: false, crowding_risk: null, direction: null, rate: null, rate_change: null };
  }
  const abs = Math.abs(rate);
  const extreme = abs >= (opts.extremeHigh == null ? FUNDING_EXTREME_HIGH : opts.extremeHigh);
  const elevated = abs >= (opts.extremeAbs == null ? FUNDING_EXTREME_ABS : opts.extremeAbs);
  // 正费率 = 多头付钱给空头(多头拥挤);负费率 = 空头付钱(空头拥挤)
  const direction = rate > 0 ? "longs_pay" : rate < 0 ? "shorts_pay" : "flat";
  // 拥挤风险:费率越极端越拥挤;拥挤本身不是方向信号,而是"反向风险"
  const crowding = extreme ? 80 + Math.min(20, (abs - FUNDING_EXTREME_HIGH) / FUNDING_EXTREME_HIGH * 20)
    : elevated ? 50 + (abs - FUNDING_EXTREME_ABS) / (FUNDING_EXTREME_HIGH - FUNDING_EXTREME_ABS) * 30
      : abs / FUNDING_EXTREME_ABS * 25;
  return {
    available: true,
    status: "live",
    rate,
    rate_pct: round(rate * 100, 6),
    rate_change: prev == null ? null : round(rate - prev, 8),
    rate_change_pct: prev == null || prev === 0 ? null : round((rate - prev) / Math.abs(prev) * 100, 4),
    direction,
    extreme,
    elevated,
    crowding_risk: round(Math.max(0, Math.min(100, crowding)), 2),
    baseline_pct: round(0.01, 4),
    note: extreme || elevated
      ? "费率偏高(" + direction + ")→ 按 Crowding Risk 处理,不解读为继续同向"
      : "费率处于常态区间"
  };
}

// §9:OI 必须与价格组合看,不能只看单个 OI 值
export function oiContext(input) {
  const i = input || {};
  const oi = numOrNull(i.open_interest);
  const prev = numOrNull(i.prev_open_interest);
  const priceChangePct = num(i.price_change_pct, 0);
  if (oi == null) return { available: false, reason: i.reason || "oi_unavailable", status: "unavailable", interpretation: null };
  const changePct = prev != null && prev > 0 ? round((oi - prev) / prev * 100, 4) : null;
  const small = changePct != null && Math.abs(changePct) < OI_CHANGE_MIN_PCT;
  let interpretation = "flat";
  if (changePct == null || small) interpretation = "neutral";
  else if (priceChangePct > 0 && changePct > 0) interpretation = "trend_confirm_up";
  else if (priceChangePct > 0 && changePct < 0) interpretation = "weak_up_short_covering";
  else if (priceChangePct < 0 && changePct > 0) interpretation = "trend_confirm_down";
  else interpretation = "long_liquidation";
  const label = {
    trend_confirm_up: "价涨 + OI 增:新钱进场,上涨有承接",
    weak_up_short_covering: "价涨 + OI 减:更像空头回补,持续性弱",
    trend_confirm_down: "价跌 + OI 增:空头进场,下跌有承接",
    long_liquidation: "价跌 + OI 减:多头被动出清,可能接近衰竭",
    neutral: "OI 变化不明显",
    flat: "OI 无对照"
  }[interpretation];
  return {
    available: true,
    status: "live",
    open_interest: oi,
    prev_open_interest: prev,
    oi_change: prev == null ? null : round(oi - prev, 8),
    oi_change_pct: changePct,
    price_change_pct: priceChangePct,
    interpretation,
    label,
    note: "OI 必须与价格组合解读"
  };
}

// §10:多空比只作情绪/持仓上下文,禁止"多头多→一定跌"
export function positioningContext(input) {
  const i = input || {};
  const ratio = numOrNull(i.long_short_ratio);
  if (ratio == null) return { available: false, reason: i.reason || "positioning_unavailable", status: "unavailable", long_short_ratio: null };
  const crowded = ratio >= 2 || ratio <= 0.5;
  return {
    available: true,
    status: "live",
    long_short_ratio: ratio,
    long_account_pct: numOrNull(i.long_account_pct),
    short_account_pct: numOrNull(i.short_account_pct),
    crowded,
    sentiment: ratio > 1.5 ? "crowded_long" : ratio < 0.7 ? "crowded_short" : "balanced",
    note: "仅作情绪上下文,不单独决定方向(必须结合 Price/OI/Funding/Volume/Trend)"
  };
}

// §11:主动买卖/taker 流(成本可控才用)
export function takerContext(input) {
  const i = input || {};
  const buy = numOrNull(i.taker_buy_volume);
  const sell = numOrNull(i.taker_sell_volume);
  if (buy == null && sell == null) return { available: false, reason: i.reason || "taker_unavailable", status: "unavailable", imbalance: null };
  const total = num(buy, 0) + num(sell, 0);
  const imbalance = total > 0 ? round((num(buy, 0) - num(sell, 0)) / total, 4) : null;
  return {
    available: true,
    status: "live",
    taker_buy_volume: buy,
    taker_sell_volume: sell,
    imbalance,
    label: imbalance == null ? "无数据" : imbalance > 0.1 ? "主动买占优" : imbalance < -0.1 ? "主动卖占优" : "买卖均衡"
  };
}

export function liquidationContext(input) {
  const i = input || {};
  const longs = numOrNull(i.long_liquidations);
  const shorts = numOrNull(i.short_liquidations);
  if (longs == null && shorts == null) return { available: false, reason: i.reason || "liquidations_unavailable", status: "unavailable", cluster: null };
  const total = num(longs, 0) + num(shorts, 0);
  const dominant = total > 0 ? (num(longs, 0) >= num(shorts, 0) ? "long_liquidations" : "short_liquidations") : "none";
  return {
    available: true,
    status: "live",
    long_liquidations: longs,
    short_liquidations: shorts,
    dominant,
    cluster: total > 0 && Math.max(num(longs, 0), num(shorts, 0)) / total >= 0.75 ? dominant : null,
    note: total > 0 ? "多空爆仓单边集中时视为挤压" : "无爆仓数据"
  };
}

// ---- §18/§19/§21/§22:研究/新闻结果的结构化、时效与冲突 ----
export const SOURCE_QUALITY = { official: 95, exchange: 90, regulator: 92, reputable_media: 70, data_provider: 80, community: 30, unknown: 40 };
export const NEWS_HALF_LIFE_MS = 6 * 3600000;    // 新闻半衰期 6 小时
export const NEWS_MAX_AGE_MS = 3 * 86400000;     // 超过 3 天直接不参与决策

export function newsFreshness(item, now) {
  const i = item || {};
  const published = numOrNull(i.published_at);
  if (published == null) return 0;   // §19:没有发布时间 → 不能当作新消息
  const age = Math.max(0, num(now, Date.now()) - published);
  if (age > NEWS_MAX_AGE_MS) return 0;
  return round(Math.pow(0.5, age / NEWS_HALF_LIFE_MS), 4);
}

export function buildNewsContext(items, options) {
  const opts = options || {};
  const now = num(opts.now, Date.now());
  // 上游失败时调用方可能回传 { reason } 形状 → 明确按"无新闻"处理,绝不崩
  const list = (Array.isArray(items) ? items : []).filter((x) => x && numOrNull(x.published_at) != null);
  if (!list.length) {
    return { available: false, status: "unavailable", reason: opts.reason || (items && items.reason) || "no_news", sentiment: null, confidence: 0, freshness: 0, items: [], conflicted: false };
  }
  const scored = list.map((x) => {
    const fresh = newsFreshness(x, now);
    const sq = num(x.source_quality, SOURCE_QUALITY[x.source_kind || "unknown"] || SOURCE_QUALITY.unknown);
    const importance = num(x.importance, 50);
    // §21:过期就降权;新鲜度 0 的直接剔除
    const weight = round(fresh * (sq / 100) * (importance / 100), 6);
    return { ...x, freshness: fresh, source_quality: sq, weight };
  }).filter((x) => x.weight > 0);
  if (!scored.length) {
    return { available: false, status: "stale", reason: "all_items_stale_or_unusable", sentiment: null, confidence: 0, freshness: 0, items: [], conflicted: false };
  }
  let bull = 0;
  let bear = 0;
  for (const x of scored) {
    if (x.sentiment === "bullish") bull += x.weight;
    else if (x.sentiment === "bearish") bear += x.weight;
  }
  const total = scored.reduce((a, b) => a + b.weight, 0) || 1;
  // §22:来源冲突 → CONFLICTED,不让模型自己拍脑袋选一个
  const conflicted = bull > 0 && bear > 0 && Math.abs(bull - bear) / (bull + bear) < 0.35;
  const net = (bull - bear) / total;
  const sentiment = conflicted ? "neutral" : net > 0.15 ? "bullish" : net < -0.15 ? "bearish" : "neutral";
  const bestFreshness = Math.max(...scored.map((x) => x.freshness));
  const avgQuality = scored.reduce((a, b) => a + b.source_quality, 0) / scored.length;
  const confidence = conflicted ? round(clampNum(Math.abs(net) * 40 + avgQuality * 0.3, 0, 60), 2)
    : round(clampNum(Math.abs(net) * 100 * 0.6 + avgQuality * 0.4, 0, 100), 2);
  return {
    available: true,
    status: conflicted ? "conflicted" : "live",
    sentiment,
    conflicted,
    confidence,
    freshness: round(bestFreshness * 100, 2),
    net_score: round(net, 4),
    items: scored.slice(0, 10),
    item_count: scored.length,
    source_quality_avg: round(avgQuality, 2),
    note: conflicted ? "不同来源结论冲突,已按 CONFLICTED 降低置信度" : "已按来源质量与新鲜度加权"
  };
}

function clampNum(v, lo, hi) {
  const n = num(v, lo);
  return n < lo ? lo : n > hi ? hi : n;
}

export function macroContext(input) {
  const i = input || {};
  if (!i || i.available === false || (!i.summary && !i.risk_level)) {
    return { available: false, status: "unavailable", reason: i.reason || "macro_unavailable", risk_level: null, summary: null };
  }
  return {
    available: true,
    status: "live",
    risk_level: i.risk_level || "Normal",
    summary: String(i.summary || "").slice(0, 300),
    source: i.source || null,
    published_at: numOrNull(i.published_at)
  };
}

// §20:拆成多个 context,不用一个总分数决定交易
export function buildExternalContext(input) {
  const i = input || {};
  const now = num(i.now, Date.now());
  const funding = fundingContext(i.funding);
  const oi = oiContext(i.oi);
  const positioning = positioningContext(i.positioning);
  const taker = takerContext(i.taker);
  const liquidations = liquidationContext(i.liquidations);
  const news = buildNewsContext(i.news, { now, reason: i.news_reason });
  const macro = macroContext(i.macro || {});
  const parts = [funding, oi, positioning, taker, liquidations, news, macro];
  const availableList = parts.filter((p) => p.available);
  const unavailable = [];
  for (const [idx, p] of parts.entries()) {
    if (!p.available) unavailable.push({ type: EXTERNAL_TYPES[idx] || "unknown", reason: p.reason || "unavailable" });
  }
  // market_stress_context:爆仓挤压 + 资金费极端 + 波动异常 → 压力上升
  let stress = 0;
  const stressNotes = [];
  if (liquidations.available && liquidations.cluster) { stress += 35; stressNotes.push("爆仓单边集中(" + liquidations.dominant + ")"); }
  if (funding.available && funding.extreme) { stress += 25; stressNotes.push("资金费极端"); }
  if (news.available && news.conflicted) { stress += 15; stressNotes.push("消息面冲突"); }
  const marketStress = {
    available: stress > 0 || availableList.length > 0,
    level: stress >= 50 ? "High" : stress >= 25 ? "Medium" : "Low",
    stress_score: clampNum(stress, 0, 100),
    notes: stressNotes
  };
  const freshness = availableList.length
    ? round(availableList.reduce((a, p) => a + (typeof p.freshness === "number" ? clampNum(p.freshness, 0, 100) / 100 : typeof p.confidence === "number" ? clampNum(p.confidence, 0, 100) / 100 : 0.5), 0) / availableList.length, 4)
    : 0;
  return {
    generated_at: now,
    funding_context: funding,
    oi_context: oi,
    positioning_context: positioning,
    taker_context: taker,
    liquidations_context: liquidations,
    news_context: news,
    macro_context: macro,
    market_stress_context: marketStress,
    overall: {
      available_count: availableList.length,
      total_count: parts.length,
      unavailable,
      freshness,
      // §62:全部缺失时明确 unavailable,而不是"看起来正常"
      available: availableList.length > 0,
      status: availableList.length === parts.length ? "full" : availableList.length > 0 ? "partial" : "unavailable"
    },
    // §6/§17:明确声明外部数据的权限边界
    permissions: { can_block: true, can_reduce_risk: true, can_grant_open: false, note: "外部数据只能降低风险,不能增加开仓权限" }
  };
}

// §62:整层不可用(上游全挂)时的显式对象
export function externalUnavailable(reason, now) {
  return buildExternalContext({ now: now || Date.now(), news_reason: reason, funding: { reason }, oi: { reason }, positioning: { reason }, taker: { reason }, liquidations: { reason }, macro: { reason } });
}

// ---- 权限边界:外部情报永远不能"放行开仓",只能收紧(§17 可测试形式) ----
export function externalRiskGate(input) {
  const i = input || {};
  const ext = i.external || {};
  const reasons = [];
  let riskScoreDelta = 0;
  let confidencePenalty = 0;
  const stress = ext.market_stress_context || {};
  if (num(stress.stress_score, 0) >= 50) { riskScoreDelta += 12; confidencePenalty += 10; reasons.push("外部市场压力偏高"); }
  const news = ext.news_context || {};
  if (news.available && news.conflicted) { confidencePenalty += 8; reasons.push("消息面冲突"); }
  if (news.available && news.sentiment === "bearish" && num(news.confidence, 0) >= 60) { riskScoreDelta += 6; reasons.push("消息面偏空"); }
  const funding = ext.funding_context || {};
  if (funding.available && funding.extreme) { riskScoreDelta += 5; confidencePenalty += 5; reasons.push("资金费极端(拥挤风险)"); }
  const oi = ext.oi_context || {};
  if (oi.interpretation === "weak_up_short_covering") { confidencePenalty += 6; reasons.push("上涨缺乏新钱(空头回补)"); }
  return {
    // 恒为 false:任何外部上下文都不得放行开仓
    can_grant_open: false,
    risk_score_delta: clampNum(riskScoreDelta, 0, 40),
    confidence_penalty: clampNum(confidencePenalty, 0, 40),
    reasons,
    strictness: clampNum(riskScoreDelta + confidencePenalty, 0, 100)
  };
}

// DataHub → 外部情报:一次取数、统一 TTL、失败标 unavailable(§12/§13/§62)
export async function loadExternalContext(input) {
  const i = input || {};
  const hub = i.hub;
  const symbol = i.symbol || "BTCUSDT";
  const now = num(i.now, Date.now());
  if (!hub) return externalUnavailable("no_hub", now);
  const gather = async (dataType, fn) => {
    if (!fn) return { reason: "no_provider" };
    const res = await hub.fetchOnce({ provider: i.provider || "binance", symbol, data_type: dataType, interval: i.interval || "-" }, fn, { symbol, data_type: dataType, source: i.source || "binance-fapi" });
    return res.ok ? res.value : { reason: res.reason };
  };
  const [fundingRaw, oiRaw, posRaw, takerRaw, newsRaw] = await Promise.all([
    gather("funding", i.fetchFunding),
    gather("open_interest", i.fetchOpenInterest),
    gather("long_short_ratio", i.fetchLongShort),
    gather("taker_flow", i.fetchTaker),
    gather("news", i.fetchNews)
  ]);
  return buildExternalContext({
    now,
    funding: fundingRaw,
    oi: oiRaw,
    positioning: posRaw,
    taker: takerRaw,
    news: newsRaw,
    macro: i.macro,
    news_reason: i.news_reason
  });
}

export { DATA_TTLS, freshnessOf };
