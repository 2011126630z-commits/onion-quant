// paper/integrity.js + sync.js + deepseek.js 合并模块 · V14 收尾能力
// 1) checkIntegrity:数据完整性检查(能安全修的自动修,不能修的如实报告)
// 2) syncQueue:同步队列(本地完整,PENDING/SYNCED/FAILED)
// 3) deepseek:k仅作为可选 Reviewer(严格 Schema 校验;失败一律回退本地)
// 4) chat:k本地数据组装回答(不凭空说;无 Key 也能回答)
import { num, round, isSafeAmount } from "./accounting.js";
import { isValidDeepseekReview } from "./fusion.js";

// ---------------- Integrity ----------------
export function checkIntegrity(snapshot) {
  const s = snapshot || {};
  const issues = [];
  const fixed = [];
  const orders = (s.orders || []).slice();
  const positions = (s.positions || []).slice();
  const trades = (s.trades || []).slice();
  const account = s.account || {};

  // 重复 idempotency_key(保留最早一笔,后续标记为重复)
  const seen = new Map();
  for (const o of orders) {
    if (!o.idempotency_key) continue;
    if (seen.has(o.idempotency_key)) {
      issues.push({ kind: "duplicate_order", severity: "high", ref: o.order_id });
      if (o.status === "FILLED" || o.status === "OPEN") o.status = "REJECTED";
      o.reject_reason = "duplicate_idempotency_key";
      fixed.push({ kind: "duplicate_order", ref: o.order_id, action: "标记为 REJECTED" });
    } else seen.set(o.idempotency_key, o);
  }
  // 重复持仓(同 mode+symbol+side 且都 OPEN)
  const posKey = new Map();
  for (const p of positions) {
    if (p.status !== "OPEN") continue;
    const k = p.mode + "|" + p.symbol + "|" + p.side;
    if (posKey.has(k)) {
      issues.push({ kind: "duplicate_position", severity: "high", ref: p.position_id });
      p.status = "CLOSED";
      p.exit_reason = "integrity_duplicate";
      p.realized_pnl = 0;
      fixed.push({ kind: "duplicate_position", ref: p.position_id, action: "关闭重复持仓(仅保留一笔)" });
    } else posKey.set(k, p);
  }
  // 负余额
  if (num(account.cash_balance) < 0) {
    issues.push({ kind: "negative_balance", severity: "critical", ref: account.account_id });
    account.cash_balance = 0;
    fixed.push({ kind: "negative_balance", ref: account.account_id, action: "钳制为 0 并记录" });
  }
  // 非法价格 / NaN / Infinity
  for (const p of positions) {
    for (const f of ["entry_price", "current_price", "quantity", "entry_notional"]) {
      const v = p[f];
      if (v != null && !Number.isFinite(Number(v))) {
        issues.push({ kind: "nan_field", severity: "high", ref: p.position_id + "." + f });
      }
    }
    if (p.status === "OPEN" && !isSafeAmount(p.entry_price)) {
      issues.push({ kind: "open_without_entry", severity: "critical", ref: p.position_id });
      p.status = "CLOSED";
      p.exit_reason = "integrity_no_entry";
      fixed.push({ kind: "open_without_entry", ref: p.position_id, action: "关闭无有效入场价的持仓" });
    }
    if (p.status === "CLOSED" && (p.exit_price == null || !isSafeAmount(p.exit_price))) {
      issues.push({ kind: "closed_without_exit", severity: "medium", ref: p.position_id });
      fixed.push({ kind: "closed_without_exit", ref: p.position_id, action: "标记待人工确认(不自动改价)" });
    }
  }
  // 孤儿成交(找不到对应持仓)
  for (const t of trades) {
    const linked = positions.some((p) => p.position_id && t.trade_id && String(t.trade_id).includes(p.position_id));
    if (!linked) issues.push({ kind: "orphan_trade", severity: "low", ref: t.trade_id });
  }
  const invalidTs = trades.filter((t) => !Number.isFinite(Number(t.entry_time)) || !Number.isFinite(Number(t.exit_time)) || num(t.exit_time) < num(t.entry_time));
  for (const t of invalidTs) issues.push({ kind: "invalid_timestamp", severity: "medium", ref: t.trade_id });
  return {
    checked_at: Date.now(),
    issues,
    fixed,
    summary: {
      total: issues.length,
      by_severity: issues.reduce((a, i) => { a[i.severity] = (a[i.severity] || 0) + 1; return a; }, {}),
      auto_fixed: fixed.length,
      needs_attention: issues.length - fixed.length
    },
    snapshot_out: { account, orders, positions, trades }
  };
}

// ---------------- Sync Queue ----------------
export const SYNC_STATUSES = ["PENDING", "SYNCED", "FAILED"];

export function makeQueueItem(entity, entityId, payload, options) {
  const opts = options || {};
  return {
    item_id: entity + ":" + entityId,
    entity,
    entity_id: String(entityId),
    payload: JSON.stringify(payload || {}),
    sync_status: "PENDING",
    attempts: 0,
    last_error: null,
    revision: num(opts.revision, 1),
    device_id: opts.device_id || "local-device",
    created_at: num(opts.now, Date.now()),
    updated_at: num(opts.now, Date.now())
  };
}

export async function enqueue(store, items) {
  const list = Array.isArray(items) ? items : [items];
  for (const item of list) await store.put("sync_queue", item);
  return list.length;
}

export async function queueStats(store) {
  const all = await store.all("sync_queue");
  const stats = { total: all.length, PENDING: 0, SYNCED: 0, FAILED: 0, oldest_pending_at: null };
  for (const item of all) {
    stats[item.sync_status] = (stats[item.sync_status] || 0) + 1;
    if (item.sync_status === "PENDING") {
      stats.oldest_pending_at = stats.oldest_pending_at == null ? item.created_at : Math.min(num(stats.oldest_pending_at), num(item.created_at));
    }
  }
  return stats;
}

// 标记同步结果(云端不可用时保持 PENDING/FAILED,本地继续运行)
export async function markSynced(store, itemIds, ok, error) {
  const ids = Array.isArray(itemIds) ? itemIds : [itemIds];
  for (const id of ids) {
    const item = await store.get("sync_queue", id);
    if (!item) continue;
    await store.put("sync_queue", {
      ...item,
      sync_status: ok ? "SYNCED" : "FAILED",
      attempts: num(item.attempts) + 1,
      last_error: ok ? null : String(error || "sync_failed").slice(0, 200),
      updated_at: Date.now(),
      revision: num(item.revision) + 1
    });
  }
  return ids.length;
}

// ---------------- DeepSeek(可选 Reviewer) ----------------
export const DEEPSEEK_DEFAULTS = {
  endpoint: "https://api.deepseek.com/chat/completions",
  model: "deepseek-chat",
  max_input_tokens: 800,
  max_output_tokens: 200,
  daily_token_cap: 50000,
  timeout_ms: 15000,
  cache_ttl_ms: 30 * 60000
};

// 只发送结构化摘要,绝不发送几百根K线
export function buildReviewPayload(ctx) {
  const c = ctx || {};
  const a = c.analysis || {};
  return {
    symbol: c.symbol,
    price: num(a.price, null),
    mode: c.mode,
    market_regime: a.market_regime ? a.market_regime.label : null,
    rule_direction: a.direction,
    rule_strength: num(a.signal_strength, null),
    rule_confidence: num(a.confidence, null),
    ml_probs: c.ml ? { bull: c.ml.probability_bullish, neutral: c.ml.probability_neutral, bear: c.ml.probability_bearish } : null,
    bull_score: c.evidence ? c.evidence.bull_score : null,
    bear_score: c.evidence ? c.evidence.bear_score : null,
    risk_score: c.risk ? c.risk.risk_score : null,
    risk_flags: c.risk ? c.risk.risk_flags : [],
    volume_state: a.volume ? a.volume.pattern : null,
    btc_context: a.btc_context ? a.btc_context.state : null,
    support: a.support_zones && a.support_zones[0] ? [a.support_zones[0].lo, a.support_zones[0].hi] : null,
    resistance: a.resistance_zones && a.resistance_zones[0] ? [a.resistance_zones[0].lo, a.resistance_zones[0].hi] : null,
    current_position: c.position ? { mode: c.position.mode, side: c.position.side, entry: c.position.entry_price, unrealized: c.position.unrealized_pnl } : null,
    recent_strategy_performance: c.performance || null
  };
}

export function shouldReview(ctx) {
  const c = ctx || {};
  const reasons = [];
  if (c.opening) reasons.push("准备新开仓");
  if (c.exitingImportant) reasons.push("准备提前退出重要仓位");
  if (c.ruleMlConflict) reasons.push("Rule 与 ML 明显冲突");
  if (c.evidence && c.evidence.conflict) reasons.push("Bull/Bear 都很强");
  if (c.risk && num(c.risk.risk_score) >= 60) reasons.push("Risk 接近阈值");
  if (c.regimeChanged) reasons.push("Market Regime 突然改变");
  return { review: reasons.length > 0, reasons };
}

export function reviewCacheKey(ctx) {
  const c = ctx || {};
  return [c.symbol, c.mode, c.closed_candle_time, c.engine_version, c.model_version].join("|");
}

export function tokenBudgetState(state, dayKey, dailyCap) {
  const cap = num(dailyCap, DEEPSEEK_DEFAULTS.daily_token_cap);
  const sameDay = state && state.token_day === dayKey;
  const used = sameDay ? num(state.token_used_today, 0) : 0;
  return { day: dayKey, used, cap, remaining: Math.max(0, cap - used), exhausted: used >= cap };
}

// 调用 DeepSeek(Schema 校验;任何失败 → ok:false,由调用方回退本地融合)
export async function callDeepSeek(payload, options) {
  const opts = { ...DEEPSEEK_DEFAULTS, ...(options || {}) };
  if (!opts.apiKey) return { ok: false, reason: "no_api_key", fallback: true };
  const budget = tokenBudgetState(opts.state, opts.dayKey, opts.daily_cap);
  if (budget.exhausted) return { ok: false, reason: "daily_token_cap_reached", fallback: true, budget };
  const doFetch = opts.fetchFn || fetch;
  const body = {
    model: opts.model,
    messages: [
      { role: "system", content: "你是量化交易的风险审查员。只输出 JSON:{direction:bullish|neutral|bearish,confidence:0-100,risk:0-100,agree_with_local:boolean,action:open|hold|exit|skip,conflict:string,reason:string}" },
      { role: "user", content: JSON.stringify(payload) }
    ],
    max_tokens: opts.max_output_tokens,
    temperature: 0.2,
    response_format: { type: "json_object" }
  };
  try {
    const res = await doFetch(opts.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + opts.apiKey },
      body: JSON.stringify(body),
      signal: opts.signal || AbortSignal.timeout(opts.timeout_ms)
    });
    if (!res.ok) return { ok: false, reason: "http_" + res.status, fallback: true, budget };
    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : "";
    const usage = num(data && data.usage && data.usage.total_tokens, 0);
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (error) { parsed = null; }
    if (!isValidDeepseekReview(parsed)) {
      return { ok: false, reason: "invalid_schema", fallback: true, raw: String(text).slice(0, 200), tokens: usage, budget };
    }
    return { ok: true, review: parsed, tokens: usage, budget };
  } catch (error) {
    return { ok: false, reason: error && error.name === "AbortError" ? "timeout" : "network_error", fallback: true, detail: String(error && error.message).slice(0, 120), budget };
  }
}

// ---------------- AI Chat(本地组装,不凭空说) ----------------
export function buildChatContext(input) {
  const i = input || {};
  const a = i.analysis || {};
  const portfolioSnap = i.portfolio || {};
  return {
    symbol: i.symbol,
    interval: i.interval,
    mode: i.mode,
    price: num(a.price, null),
    direction: a.direction || null,
    confidence: num(a.confidence, null),
    regime: a.market_regime ? a.market_regime.label : null,
    risk_level: i.risk ? i.risk.risk_level : null,
    risk_score: i.risk ? num(i.risk.risk_score, null) : null,
    position: i.position || null,
    decision: i.decision || null,
    strategy: i.strategyStats || null,
    pools: portfolioSnap.wallets ? { short: num(portfolioSnap.wallets.short && portfolioSnap.wallets.short.allocated_balance, null), long: num(portfolioSnap.wallets.long && portfolioSnap.wallets.long.allocated_balance, null) } : null,
    today: portfolioSnap.today || null,
    // V14.4:预测 / 外部情报 / 回撤 / 利润保护(全部可选,缺失时回答会明确说"暂无")
    prediction: i.prediction || null,
    future: i.prediction ? i.prediction.predictions || null : null,
    external: i.external || null,
    drawdown: i.drawdown || null,
    profitLock: i.profitLock || null,
    research: i.research || null
  };
}

// 概率 → 白话语(§76:必须保留 Probability / Risk / Uncertainty,不给"肯定上涨")
export function describeProbability(prediction) {
  const p = prediction || {};
  if (p.bullish_probability == null) return { label: "方向不明确", text: "暂无可用预测", confidence_text: "--", uncertainty_pct: null };
  const bull = num(p.bullish_probability, 0);
  const bear = num(p.bearish_probability, 0);
  const neutral = num(p.neutral_probability, 0);
  const conf = num(p.confidence, 0);
  const label = bull >= bear && bull >= neutral ? (bull >= 0.55 ? "偏多" : "略偏多")
    : bear >= neutral ? (bear >= 0.55 ? "偏空" : "略偏空") : "方向不明确";
  const confidenceText = conf >= 0.65 ? "较高" : conf >= 0.5 ? "中" : "低";
  return {
    label,
    bullish_pct: Math.round(bull * 100),
    neutral_pct: Math.round(neutral * 100),
    bearish_pct: Math.round(bear * 100),
    expected_range_text: "±" + num(p.expected_range_pct, 0).toFixed(1) + "%",
    expected_move_text: "±" + num(p.expected_move_pct, 0).toFixed(1) + "%",
    uncertainty_pct: Math.round(num(p.uncertainty, 0) * 100),
    confidence_text: confidenceText,
    reversal_risk_pct: Math.round(num(p.reversal_risk, 0) * 100),
    persistence_pct: Math.round(num(p.trend_persistence, 0) * 100),
    text: label + " " + Math.round(Math.max(bull, bear, neutral) * 100) + "%"
  };
}

// 本地回答(无 DeepSeek 也能用):只基于上面的真实数据,给区间而不是确定结论
export function answerLocally(question, ctx) {
  const q = String(question || "");
  const c = ctx || {};
  const pos = c.position;
  // ---- V15 Decision Journal:为什么开 / 为什么平 / 为什么提止损 ----
  // 决策日志由引擎在每次动作时写入,这里只负责把它讲成人话(不猜、不编)。
  // 注意:没有日志时必须回落到原有问答逻辑(不能因为新分支把旧答案吃掉)。
  const journalNotes = Array.isArray(c.journal) && c.journal.length ? c.journal : null;
  const journalText = typeof c.journal_text === "string" && c.journal_text ? c.journal_text : null;
  if ((journalNotes || journalText) && /为什么.*(卖|平|买|开|不买|观望|加仓)|为何.*(卖|平|买|开)|刚才.*(卖|平|买|开)|怎么.*退出/.test(q)) {
    if (journalNotes) {
      return journalNotes.map((n) => {
        const label = n.kind === "EXIT" ? "平仓" : n.kind === "ENTRY" ? "开仓" : n.kind === "ENTRY_BLOCKED" ? "未开仓" : n.kind === "STOP_RAISE" ? "调整止损" : n.kind;
        const ev = Array.isArray(n.evidence) && n.evidence.length ? "(依据:" + n.evidence.join("、") + ")" : "";
        return (n.symbol ? n.symbol + " " : "") + label + ":" + (n.why || "已记录") + ev;
      }).join("。");
    }
    return journalText;
  }
  // ---- V14.4 新增问答(§75/§76) ----
  if (/未来|预测|接下来|往后|会怎么走/.test(q)) {
    const table = c.future || {};
    const pick = /4h|4小时/.test(q) ? "4h" : /1d|1天|日线/.test(q) ? "1d" : /15m|15分/.test(q) ? "15m" : /3d|3天/.test(q) ? "3d" : "1h";
    const p = table[pick];
    if (!p) return "目前还没有该周期的预测数据。预测需要真实行情快照,请稍后再问或换个周期。";
    const d = describeProbability(p);
    return "未来 " + pick + " 的概率分布:看涨 " + d.bullish_pct + "% / 中性 " + d.neutral_pct + "% / 看跌 " + d.bearish_pct
      + "%,预计波动 " + d.expected_range_text + ",可信度" + d.confidence_text + "(不确定性 " + d.uncertainty_pct + "%)。"
      + "这只是概率倾向,不是买卖指令;实际决策仍要经过 Rule/ML/Risk/回撤与仓位管理。";
  }
  if (/为什么.*看涨|凭什么.*涨|为什么觉得.*涨/.test(q)) {
    const p = (c.future && c.future["1h"]) || null;
    if (!p) return "暂无预测依据可解释。";
    const comps = (p.components || []).filter((x) => x.value > 0).sort((a, b) => b.weighted - a.weighted).slice(0, 3);
    return "当前偏多的主要来源:" + (comps.length ? comps.map((x) => x.key + "(" + x.note + ")").join("、") : "证据不足")
      + "。同时仍有 " + Math.round(num(p.bearish_probability, 0) * 100) + "% 的看跌概率,请把它当作可能性而不是结论。";
  }
  if (/funding|资金费/.test(q)) {
    const f = (c.external && c.external.funding_context) || {};
    if (!f.available) return "资金费数据当前不可用(unavailable),我不会用猜测值代替。";
    return "资金费 " + (f.rate_pct == null ? "--" : f.rate_pct) + "%/期,方向:"
      + (f.direction === "longs_pay" ? "多头付费(多头拥挤)" : f.direction === "shorts_pay" ? "空头付费(空头拥挤)" : "均衡")
      + "。拥挤度 " + f.crowding_risk + "/100。" + (f.extreme ? "已属极端区间,按拥挤风险处理,不解读为继续同向。" : "处于常态区间。");
  }
  if (/oi|持仓量|增仓|减仓/i.test(q)) {
    const oi = (c.external && c.external.oi_context) || {};
    if (!oi.available) return "持仓量(OI)数据当前不可用(unavailable),不做推测。";
    return "OI 变化 " + (oi.oi_change_pct == null ? "--" : oi.oi_change_pct + "%") + ":" + (oi.label || "")
      + "(单看 OI 没意义,必须和价格组合判断)。";
  }
  if (/见好就收|回吐|锁定利润|该不该平|要不要平/.test(q)) {
    const pl = c.profitLock || {};
    if (!pl.stage_label) return "当前没有盈利中的模拟持仓,暂时没有利润保护可谈。";
    return pl.stage_label + ":最高浮盈 " + pl.max_unrealized_text + ",当前 " + pl.current_text + ",已回吐 " + pl.giveback_text
      + "。下一步:" + pl.next_action + "。系统目标是逐步降低回吐风险,而不是卖在最高点。";
  }
  if (/为什么.*只平|为什么不全卖|为什么部分平/.test(q)) {
    const pl = c.profitLock || {};
    return "部分锁定兼顾两件事:把已经到手的利润变成已实现,同时保留一部分仓位继续跟趋势。"
      + (pl.stage_label ? "当前阶段 " + pl.stage_label + ",下一步 " + pl.next_action + "。" : "")
      + "减仓比例由 MFE、趋势强度、未来预测、反转概率、波动共同决定,不是固定比例。";
  }
  if (/为什么.*止损.*(上移|移动|推)/.test(q)) {
    const pl = c.profitLock || {};
    return "止损上移是把浮盈转成保护:盈利越大,允许回吐的空间越小,但会保留最低保护距离,避免被正常波动扫出。"
      + (pl.trailing_text ? "当前 Trailing 距离 " + pl.trailing_text + "。" : "");
  }
  if (/为什么.*(降|减).*杠杆|为什么不.*10x/i.test(q)) {
    const dd = c.drawdown || {};
    return "杠杆上限由回撤状态与账户规模共同决定:当前回撤状态 " + (dd.state_label || "--") + ";账户越大越保守(保护已积累净值)。"
      + "自动杠杆的目标是风险调整后增长,不是追求最高倍数。";
  }
  if (/为什么.*防守|防守模式/.test(q)) {
    const dd = c.drawdown || {};
    return "当前回撤状态:" + (dd.state_label || "--") + "(账户回撤 " + (dd.account_dd_text || "--") + ",当日 " + (dd.daily_dd_text || "--") + ")。"
      + (dd.allow_new_positions === false ? "该状态下已停止新开仓,只做持仓管理与退出。" : "该状态下按缩放后的风险预算运行。")
      + (dd.reasons && dd.reasons.length ? "触发原因:" + dd.reasons.slice(-2).join(";") : "");
  }
  if (/新闻|消息面|公告|资讯/.test(q)) {
    const n = (c.external && c.external.news_context) || {};
    if (!n.available) return "当前没有可用的消息面数据(unavailable),我不会凭印象编新闻。";
    return "消息面:" + (n.sentiment === "bullish" ? "偏多" : n.sentiment === "bearish" ? "偏空" : "中性")
      + (n.conflicted ? "(来源冲突,已降低置信度)" : "") + ",置信度 " + n.confidence + "/100,新鲜度 " + n.freshness + "/100。"
      + "消息只作为上下文,不能单独决定交易。";
  }
  if (/拿多久|多久|持仓时间|预计/.test(q) && pos) {
    const mode = pos.mode === "long" ? "长线" : "短线";
    const range = pos.mode === "long" ? "1～7 天" : "1～6 小时";
    return "当前是" + mode + "模拟仓位,预计区间约 " + range + "。若趋势失效、结构破坏或 Risk 升高,会提前退出(实际持有时间以引擎退出条件为准)。";
  }
  if (/风险|高吗|危险/.test(q)) {
    const dd = c.drawdown || {};
    return "当前风险等级:" + (c.risk_level || "未知") + "(评分 " + (c.risk_score == null ? "--" : c.risk_score) + ")。"
      + "风险主要来自波动率、多周期冲突与行情新鲜度;风控拥有否决权,超阈值时不会新开仓。"
      + (dd.state_label ? "当前回撤状态 " + dd.state_label + "。" : "");
  }
  if (/不买|不动|观望|没开仓|为空/.test(q)) {
    if (c.decision && c.decision.action === "skip") return "当前决策为跳过:" + (c.decision.reason || "存在冲突或风控否决") + "。宁可不交易。";
    if (c.decision && c.decision.action === "hold") return "当前融合分数在阈值内(" + (c.decision.score == null ? "--" : c.decision.score) + "),保持观望:" + (c.decision.reason || "");
    return "当前没有触发开仓条件(需融合分数超过阈值且风控不放行)。";
  }
  if (/什么时候卖|什么情况下会卖|会卖/.test(q)) {
    return "退出条件:止损/止盈(按 ATR 动态)、时间退出、结构失效、信号反转、风险退出,以及盈利后的分阶段利润保护。命中任一即模拟平仓,并记录 exit_reason。";
  }
  if (/短线还是长线|适合/.test(q)) {
    return "短线参考 15m/1h(4h 环境过滤),长线参考 4h/1d。当前环境:" + (c.regime || "未知") + ",方向:" + (c.direction || "中性") + "。是否适合以融合决策为准(可能为观望)。";
  }
  if (/short|long|谁表现好|表现/i.test(q)) {
    const s = c.strategy || {};
    return "短线累计:" + (s.short ? s.short.net_pnl : "--") + " USDT / 长线累计:" + (s.long ? s.long.net_pnl : "--") + " USDT(样本不足时不做结论)。";
  }
  if (/怎么看|现在怎么样|现在能买吗/.test(q)) {
    const d = c.future && c.future["1h"] ? describeProbability(c.future["1h"]) : null;
    return "综合:" + (c.direction || "中性") + " · 置信 " + (c.confidence == null ? "--" : c.confidence) + " · 环境 " + (c.regime || "未知") + " · 风险 " + (c.risk_level || "--")
      + "。" + (d ? "未来 1h:" + d.text + "(波动 " + d.expected_range_text + ",可信度" + d.confidence_text + ")。" : "")
      + "当前决策:" + (c.decision && c.decision.action ? c.decision.action : "观望") + "。";
  }
  return "我可以基于本地真实数据回答:未来概率分布、为什么这么看、Funding/OI/消息面、见好就收与回吐、为什么只平了一部分、为什么移止损、为什么降杠杆或进入防守。请问具体想问哪一项?";
}

export function chatContextSummary(ctx) {
  const c = ctx || {};
  return [
    "symbol=" + (c.symbol || "-"),
    "interval=" + (c.interval || "-"),
    "mode=" + (c.mode || "-"),
    "price=" + (c.price == null ? "-" : c.price),
    "direction=" + (c.direction || "-"),
    "confidence=" + (c.confidence == null ? "-" : c.confidence),
    "regime=" + (c.regime || "-"),
    "risk=" + (c.risk_level || "-") + "(" + (c.risk_score == null ? "-" : c.risk_score) + ")",
    "position=" + (c.position ? c.position.mode + "/" + c.position.side : "none"),
    "decision=" + (c.decision && c.decision.action ? c.decision.action : "hold")
  ].join(" · ");
}
