// paper/decisionJournal.js · Decision Journal(决策日志)
// 目的:每一次系统动作都留下"为什么":为什么开仓/为什么不开/为什么这个杠杆/为什么部分平仓/
//      为什么提高止损/为什么退出。保存 Rule / ML / Prediction / Risk / External / DeepSeek / Final。
// 用途:AI Chat 可以直接回答"刚才为什么卖 BTC",复盘时不用猜。
import { num, round, sideOf } from "./accounting.js";

export const DECISION_KINDS = ["ENTRY", "ENTRY_BLOCKED", "LEVERAGE", "PARTIAL_CLOSE", "STOP_RAISE", "EXIT", "RISK", "INTEGRITY"];

export const JOURNAL_DEFAULTS = { limit: 500 };

// 单调递增序号:与时间戳组合成确定性 id(可复现,便于测试与去重)
let entrySeq = 0;

// 组装一条决策记录(纯函数):evidence 只保留"可复查的字段",不塞原始大对象
export function decisionEntry(input) {
  const i = input || {};
  const at = num(i.at, Date.now());
  const kind = DECISION_KINDS.includes(String(i.kind || "").toUpperCase()) ? String(i.kind).toUpperCase() : "ENTRY";
  const rule = i.rule || {};
  const ml = i.ml || null;
  const prediction = i.prediction || null;
  const risk = i.risk || null;
  const external = i.external || null;
  const review = i.deepseek || null;
  const final = i.final || {};
  const evidence = [];
  if (rule.direction) evidence.push("规则方向 " + rule.direction + (rule.confidence == null ? "" : "(置信 " + num(rule.confidence, 0) + ")"));
  if (ml && ml.version) evidence.push("模型 " + ml.version + " 概率 " + (ml.probability == null ? "--" : num(ml.probability, 0)));
  if (prediction && prediction.direction) evidence.push("预测 " + prediction.direction + "(" + (prediction.probability == null ? "--" : num(prediction.probability, 0)) + ")");
  if (risk && risk.risk_level) evidence.push("风险等级 " + risk.risk_level + (risk.veto_reasons && risk.veto_reasons.length ? " · " + risk.veto_reasons.join(",") : ""));
  if (external && external.overall) evidence.push("外部情报 " + (external.overall.label || external.overall.risk_level || "--"));
  if (review && review.used) evidence.push("DeepSeek " + (review.direction || "已复核"));
  return {
    id: "dj_" + at.toString(36) + "_" + (++entrySeq).toString(36),
    at,
    kind,
    symbol: i.symbol || null,
    mode: i.mode || null,
    action: i.action || kind,
    action_source: i.action_source || "AUTO",
    // V16.2u §3/§18:溯源链随决策记录一起留档(哪个信号→哪个策略意图→哪次决策→哪个仓位)
    signal_id: i.signal_id == null ? null : String(i.signal_id),
    strategy_intent_id: i.strategy_intent_id == null ? null : String(i.strategy_intent_id),
    decision_id: i.decision_id == null ? null : String(i.decision_id),
    position_id: i.position_id == null ? null : String(i.position_id),
    why: String(i.why == null ? "" : i.why).slice(0, 300),
    rule: { direction: rule.direction || null, confidence: num(rule.confidence, null), strength: rule.strength || null },
    ml: ml ? { version: ml.version || null, probability: num(ml.probability, null), used: Boolean(ml.used) } : null,
    prediction: prediction ? { direction: prediction.direction || null, probability: num(prediction.probability, null), horizon: prediction.horizon || null } : null,
    risk: risk ? { risk_level: risk.risk_level || null, veto_reasons: risk.veto_reasons || [], max_leverage: num(risk.max_leverage, null) } : null,
    external: external ? { label: (external.overall && external.overall.label) || null, freshness: num(external.overall && external.overall.freshness, null) } : null,
    deepseek: review ? { used: Boolean(review.used), direction: review.direction || null, note: (review.reason || "").slice(0, 120) } : null,
    final: { action: final.action || i.action || kind, leverage: num(final.leverage, null), size: num(final.size, null), exit_reason: final.exit_reason || null },
    evidence
  };
}

export function createDecisionJournal(options) {
  const opts = { ...JOURNAL_DEFAULTS, ...(options || {}) };
  const list = [];
  function record(input) {
    const entry = decisionEntry({ at: opts.now ? opts.now() : Date.now(), ...(input || {}) });
    list.push(entry);
    if (list.length > opts.limit) list.shift();
    return entry;
  }
  return {
    record,
    list: (o) => {
      const opt = o || {};
      let out = list.slice();
      if (opt.kind) out = out.filter((e) => e.kind === String(opt.kind).toUpperCase());
      if (opt.symbol) out = out.filter((e) => e.symbol === String(opt.symbol).toUpperCase());
      if (opt.mode) out = out.filter((e) => e.mode === opt.mode);
      return out.slice(-num(opt.limit, 30)).reverse();
    },
    // AI Chat / UI 用:把"为什么"讲成人话
    whyText: (symbol, o) => {
      const entries = list.filter((e) => !symbol || e.symbol === String(symbol).toUpperCase()).slice(-num(o && o.limit, 6)).reverse();
      if (!entries.length) return symbol ? symbol + " 还没有可解释的决策记录" : "还没有决策记录";
      return entries.map((e) => {
        const head = (e.symbol || "账户") + " · " + (e.kind === "EXIT" ? "平仓" : e.kind) + (e.final && e.final.exit_reason ? "(" + e.final.exit_reason + ")" : "");
        const detail = e.evidence.length ? " — " + e.evidence.join(" · ") : "";
        const why = e.why ? "。原因:" + e.why : "";
        return head + why + detail;
      }).join(" | ");
    },
    lastFor: (symbol, mode) => list.filter((e) => (!symbol || e.symbol === symbol) && (!mode || e.mode === mode)).slice(-1)[0] || null,
    summary: () => {
      const byKind = {};
      for (const e of list) byKind[e.kind] = num(byKind[e.kind], 0) + 1;
      return { total: list.length, by_kind: byKind, last_at: list.length ? round(list[list.length - 1].at, 0) : null };
    },
    size: () => list.length
  };
}

// 给聊天上下文用:压缩成一段可直接进 prompt 的文本(控制长度)
export function journalContextForChat(journal, question, options) {
  const o = options || {};
  const q = String(question || "").toUpperCase();
  const symbols = (o.symbols || []).filter((s) => q.includes(String(s).replace("USDT", "")));
  const target = symbols.length ? symbols[0] : (o.defaultSymbol || null);
  const entries = target ? journal.list({ symbol: target, limit: num(o.limit, 4) }) : journal.list({ limit: num(o.limit, 3) });
  if (!entries.length) return null;
  return entries.map((e) => ({
    kind: e.kind,
    symbol: e.symbol,
    why: e.why,
    evidence: e.evidence,
    at: round(e.at, 0),
    exit_reason: e.final && e.final.exit_reason
  }));
}
