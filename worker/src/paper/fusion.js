// paper/fusion.js · Decision Fusion(V14:Rule / ML / Risk / DeepSeek 可选用 Review)
// 权重:Rule 35% · ML 35% · Risk 20% · DeepSeek 10%(DeepSeek 上限 20%)
// Risk 有否决权;高度冲突时 SKIP(宁可不交易)。DeepSeek 缺失/失败一律回退本地权重。
import { num, round } from "./accounting.js";

export const FUSION_WEIGHTS = { rule: 0.35, ml: 0.35, risk: 0.20, deepseek: 0.10 };
export const DEEPSEEK_MAX_WEIGHT = 0.20;

export function ruleScore(analysis) {
  const a = analysis || {};
  if (a.limited_data) return 0;
  const dir = String(a.direction || "Neutral");
  const strength = num(a.signal_strength, 50);
  const magnitude = (strength - 50) / 50; // -1..1
  if (/Strong Bullish/.test(dir)) return Math.max(0.6, magnitude);
  if (/Bullish/.test(dir)) return Math.max(0.25, magnitude);
  if (/Strong Bearish/.test(dir)) return Math.min(-0.6, magnitude);
  if (/Bearish/.test(dir)) return Math.min(-0.25, magnitude);
  return 0;
}

export function mlScore(ml) {
  if (!ml) return null;
  const bull = num(ml.probability_bullish, null);
  const bear = num(ml.probability_bearish, null);
  if (bull == null || bear == null) return null;
  return round(bull - bear, 4); // -1..1
}

export function riskPenalty(risk) {
  const r = risk || {};
  const level = num(r.risk_score, 30);
  return round(-(level / 100) * 2, 4); // 风险越高,对方向性下注的惩罚越大
}

export function deepseekScore(review) {
  if (!review || review.invalid) return null;
  const dir = String(review.direction || "neutral");
  const conf = num(review.confidence, 0) / 100;
  if (dir === "bullish") return round(conf, 4);
  if (dir === "bearish") return round(-conf, 4);
  return 0;
}

export function isValidDeepseekReview(obj) {
  if (!obj || typeof obj !== "object") return false;
  const dir = String(obj.direction || "");
  if (!["bullish", "neutral", "bearish"].includes(dir)) return false;
  if (!Number.isFinite(Number(obj.confidence)) || Number(obj.confidence) < 0 || Number(obj.confidence) > 100) return false;
  if (!Number.isFinite(Number(obj.risk)) || Number(obj.risk) < 0 || Number(obj.risk) > 100) return false;
  // V14.5 §44:动作集合加入 partial_close(关键减仓也要能被复核)
  if (!["open", "hold", "partial_close", "exit", "skip"].includes(String(obj.action || ""))) return false;
  return true;
}

// 融合:返回 final decision(含 action/threshold 与冲突标记)
export function fuse(input) {
  const ctx = input || {};
  const weights = { ...FUSION_WEIGHTS, ...(ctx.weights || {}) };
  const r = ruleScore(ctx.analysis);
  const m = mlScore(ctx.ml);
  const risk = ctx.risk || {};
  const ds = deepseekScore(ctx.deepseek);
  const rp = riskPenalty(risk);

  const parts = [{ key: "rule", value: r, weight: weights.rule }];
  if (m != null) parts.push({ key: "ml", value: m, weight: weights.ml });
  if (ds != null) parts.push({ key: "deepseek", value: ds, weight: Math.min(DEEPSEEK_MAX_WEIGHT, weights.deepseek) });
  parts.push({ key: "risk", value: rp, weight: weights.risk * 0.5 });

  const totalWeight = parts.reduce((a, b) => a + b.weight, 0) || 1;
  const score = round(parts.reduce((a, b) => a + b.value * b.weight, 0) / totalWeight, 4);

  const conflict = m != null && Math.sign(r) !== 0 && Math.sign(m) !== 0 && Math.sign(r) !== Math.sign(m) && Math.abs(r - m) > 0.5;
  const evidenceConflict = Boolean(ctx.evidence && ctx.evidence.conflict);
  const deepseekSaysSkip = ctx.deepseek && ctx.deepseek.action === "skip";
  const deepseekDisagrees = ctx.deepseek && ctx.deepseek.agree_with_local === false;

  const openThreshold = num(ctx.openThreshold, 0.28);
  const highConflict = conflict && (evidenceConflict || deepseekDisagrees);
  let action = "skip";
  let reason = "";
  if (risk.veto) {
    action = "skip";
    reason = "风控否决:" + (risk.reasons || []).join("、");
  } else if (highConflict) {
    action = "skip";
    reason = "Rule 与 ML 高度冲突" + (evidenceConflict ? ",且多空证据同时偏强" : "") + ",宁可不交易";
  } else if (deepseekSaysSkip) {
    action = "skip";
    reason = "DeepSeek Review 建议跳过";
  } else if (score >= openThreshold) {
    action = "open_long";
    reason = "融合分数 " + score + " ≥ 阈值 " + openThreshold;
  } else if (score <= -openThreshold) {
    action = "open_short";
    reason = "融合分数 " + score + " ≤ -" + openThreshold;
  } else {
    action = "hold";
    reason = "融合分数 " + score + " 在阈值内,保持观望";
  }

  return {
    score,
    action,
    direction: action === "open_long" ? "Bullish" : action === "open_short" ? "Bearish" : "Neutral",
    conflict,
    high_conflict: highConflict,
    deepseek_used: ds != null,
    deepseek_weight: ds != null ? Math.min(DEEPSEEK_MAX_WEIGHT, weights.deepseek) : 0,
    components: { rule: r, ml: m, risk_penalty: rp, deepseek: ds, evidence_net: ctx.evidence ? ctx.evidence.net_bias : null },
    weights: weights,
    reason,
    threshold: openThreshold
  };
}

// 持仓的融合复查(用于提前退出判断)
export function reviewPosition(position, ctx) {
  const f = fuse(ctx);
  const flipped = (position.side === "LONG" && f.action === "open_short") || (position.side === "SHORT" && f.action === "open_long");
  return { ...f, exit_suggested: flipped || (ctx.risk && ctx.risk.veto === true), flip: flipped };
}
