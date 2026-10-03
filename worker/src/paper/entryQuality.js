// paper/entryQuality.js · V16 §1/§2 · Entry Quality Gate(纯函数,无 I/O)
// 目的:解决"一个指标出信号就下单"的过度交易 —— 任何新仓必须先过统一质量闸门。
// 输出不是布尔,而是一份可审计的结论:entry_score / direction_probability / uncertainty /
// expected_move / estimated_cost / net_expected_edge / allow_entry / decision。
//
// 并且:NO_TRADE 是一种【正式决策】,不是"没做决定"。
// 决策枚举:LONG / SHORT / HOLD / NO_TRADE / UNKNOWN / DATA_UNRELIABLE / MODEL_CONFLICT
export const ENTRY_DECISION_KINDS = ["LONG", "SHORT", "HOLD", "NO_TRADE", "UNKNOWN", "DATA_UNRELIABLE", "MODEL_CONFLICT"];
export const ENTRY_QUALITY_VERSION = "entry-quality-v1.0";

// 拒绝原因(全部可解释,UI 直接中文化展示)
export const NO_TRADE_CODES = [
  "DATA_UNRELIABLE",
  "MODEL_CONFLICT",
  "PROB_GAP_TOO_SMALL",
  "LOW_LEADER_PROBABILITY",
  "HIGH_UNCERTAINTY",
  "COST_DOMINATES",
  "SKIP_LOW_NET_EDGE",
  "EDGE_UNKNOWN",
  "LOW_ENTRY_SCORE",
  "BELOW_MIN_MEANINGFUL",
  "REGIME_UNFAVORABLE",
  "RISK_VETO",
  "INSUFFICIENT_SAMPLES",
  "EXPOSURE_CAP",
  "NO_MODEL_INPUT"
];

export const NO_TRADE_ZH = {
  DATA_UNRELIABLE: "行情数据不可靠",
  MODEL_CONFLICT: "模型结论冲突",
  PROB_GAP_TOO_SMALL: "概率优势不明显",
  LOW_LEADER_PROBABILITY: "领先方向概率不足",
  HIGH_UNCERTAINTY: "不确定性过高",
  COST_DOMINATES: "手续费吃掉边际",
  SKIP_LOW_NET_EDGE: "扣费后净边际过低",
  EDGE_UNKNOWN: "缺少波动率,净边际无法估算",
  LOW_ENTRY_SCORE: "开仓质量分不足",
  BELOW_MIN_MEANINGFUL: "仓位小到没有意义",
  REGIME_UNFAVORABLE: "当前市场环境不利",
  RISK_VETO: "风控否决",
  INSUFFICIENT_SAMPLES: "样本不足",
  EXPOSURE_CAP: "组合暴露已到上限",
  NO_MODEL_INPUT: "没有可用模型输入"
};

export const ENTRY_DECISION_ZH = {
  LONG: "做多", SHORT: "做空", HOLD: "持有等待", NO_TRADE: "不交易",
  UNKNOWN: "无法判断", DATA_UNRELIABLE: "数据不可靠", MODEL_CONFLICT: "模型冲突"
};

// 闸门阈值(每一条都可被测试单独打靶)
export const ENTRY_QUALITY_RULES = {
  min_prob_gap: 0.10,          // 领先类别必须比第二高至少高 10 个百分点(38/34/28 → 只有 4pp → SKIP)
  min_leader_probability: 0.40,
  min_net_edge_pct: 0.10,      // 扣费后净边际(占名义)下限 %
  min_edge_cost_ratio: 2.0,    // 毛边际至少要有总成本的 2 倍(否则费用支配)
  max_uncertainty: 0.72,
  min_data_quality: 60,        // 0~100
  min_entry_score: 55,         // 0~100
  min_samples: 30,
  unknown_edge_uncertainty: 0.25,
  blame_uncertainty_penalty: 0.35,
  weights: { rule: 0.30, features: 0.25, predictor: 0.20, regime: 0.10, alignment: 0.15 }
};

// 最小有意义仓位:预期收益连 0.05U 都不到、手续费占比又高 → 宁可 NO_TRADE,也不开蚂蚁仓
export const MIN_MEANINGFUL_RULES = {
  min_net_profit_usdt: 0.05,
  min_net_profit_pct_of_equity: 0.05,
  min_notional_usdt: 5,
  min_notional_pct_of_equity: 2,
  max_cost_ratio_of_edge: 0.5
};

const DENOM_EPS = 1e-12;

function eqFnum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}
function clamp01(v) { return Math.min(1, Math.max(0, eqFnum(v))); }
function clampRange(v, lo, hi) { return Math.min(hi, Math.max(lo, eqFnum(v, lo))); }
function logistic(x) { return 1 / (1 + Math.exp(-clampRange(x, -40, 40))); }

// 规则分(-100..100) → 多/空概率倾斜(0..1,0.5 为中性)
export function ruleDirectionProbability(ruleScore) {
  const s = clampRange(ruleScore, -100, 100) / 25; // ±4 → 饱和
  const bull = logistic(s);
  return { bull: bull, bear: 1 - bull };
}

// 方向概率分布(三类):把可用来源按权重融合,缺失的来源整体降权(不做"缺就是 0.5"的假中立)
export function probabilityDistribution(input) {
  const src = input || {};
  const parts = [];
  if (src.rule != null) {
    const p = ruleDirectionProbability(typeof src.rule === "object" ? src.rule.score : src.rule);
    parts.push({ name: "rule", bull: p.bull, bear: p.bear, weight: eqFnum(src.weights && src.weights.rule, ENTRY_QUALITY_RULES.weights.rule) });
  }
  if (src.ml && eqFnum(src.ml.bull, null) != null) {
    const bull = clamp01(src.ml.bull), bear = clamp01(src.ml.bear);
    parts.push({ name: "ml", bull, bear, weight: eqFnum(src.weights && src.weights.ml, ENTRY_QUALITY_RULES.weights.features) });
  }
  if (src.predictor && eqFnum(src.predictor.bull_probability, null) != null) {
    const bull = clamp01(src.predictor.bull_probability), bear = clamp01(src.predictor.bear_probability);
    parts.push({ name: "predictor", bull, bear, weight: eqFnum(src.weights && src.weights.predictor, ENTRY_QUALITY_RULES.weights.predictor) });
  }
  const totalWeight = parts.reduce((a, p) => a + p.weight, 0);
  if (!parts.length || totalWeight <= DENOM_EPS) {
    return { ok: false, reason: "no_model_input", bull: null, neutral: null, bear: null, sources: [], agreement: null };
  }
  let bull = 0, bear = 0;
  for (const p of parts) { bull += p.bull * p.weight; bear += p.bear * p.weight; }
  bull /= totalWeight; bear /= totalWeight;
  const neutral = Math.max(0, 1 - bull - bear);
  const sum = bull + bear + neutral;
  // 方向冲突:两个来源各自 >0.55 指向相反方向 → 伪共识的反面(真冲突)
  const dirs = parts.map((p) => (p.bull - p.bear >= 0.1 ? "LONG" : (p.bear - p.bull >= 0.1 ? "SHORT" : "FLAT")));
  const directional = dirs.filter((d) => d !== "FLAT");
  const conflict = directional.length >= 2 && new Set(directional).size >= 2;
  const named = { rule: undefined, ml: undefined, predictor: undefined };
  for (const p of parts) named[p.name] = { bull: p.bull, bear: p.bear };
  return {
    ok: true,
    bull: bull / sum,
    bear: bear / sum,
    neutral: neutral / sum,
    sources: parts.map((p) => p.name),
    agreement: conflict ? "CONFLICT" : (directional.length >= 2 && new Set(directional).size === 1 ? "ALIGNED" : "PARTIAL"),
    entries: named
  };
}

// 开仓前成本估算:入场费 + 预期出场费 + 点差 + 滑点(+ 已知资金费)
export function estimateTradeCosts(input) {
  const o = input || {};
  const cfg = o.config || {};
  const notional = Math.max(0, eqFnum(o.notional));
  const feeBps = eqFnum(cfg.fee_bps, 4);
  const slipBps = eqFnum(cfg.slippage_bps, 3);
  const halfSpreadBps = eqFnum(cfg.half_spread_bps, 1);
  const volatilityMult = 1 + clampRange(eqFnum(o.atr_pct) / 1, 0, 3); // 高波动 → 滑点放大(最多 4×)
  const liveSpread = eqFnum(o.spread_bps, null);
  const spreadBps = liveSpread == null ? halfSpreadBps : Math.max(halfSpreadBps, liveSpread / 2);
  const entryFee = notional * feeBps / 10000;
  const exitFee = notional * feeBps / 10000;
  const spreadCost = notional * spreadBps / 10000 * 2; // 进+出
  const slippageCost = notional * slipBps / 10000 * 2 * volatilityMult;
  // 资金费:取不到就必须标 unknown(绝不把 null 当 0 → 那会让"费用前置"变成假结论)
  const rawFunding = o.funding_rate;
  const fundingRate = rawFunding == null || rawFunding === "" ? null : (Number.isFinite(Number(rawFunding)) ? Number(rawFunding) : null);
  const fundingPeriods = Math.max(0, eqFnum(o.funding_periods, o.hold_hours ? eqFnum(o.hold_hours) / 8 : 0));
  const fundingCost = fundingRate == null ? 0 : notional * fundingRate * fundingPeriods;
  const total = entryFee + exitFee + spreadCost + slippageCost + fundingCost;
  return {
    notional: notional,
    entry_fee: entryFee,
    exit_fee: exitFee,
    spread_cost: spreadCost,
    slippage_cost: slippageCost,
    funding_cost: fundingCost,
    funding_known: fundingRate != null,
    total_cost: total,
    cost_pct: notional > DENOM_EPS ? total / notional * 100 : null,
    volatility_mult: volatilityMult
  };
}

// 预期毛边际(占名义 %)= |领先概率 - 对立概率| × 预期振幅
// 必须取绝对值:做空机会的 (bull - bear) 是负的,但那不是"负边际",而是方向相反的正边际。
export function expectedGrossEdgePct(distribution, expectedMovePct) {
  if (!distribution || !distribution.ok) return null;
  const bull = eqFnum(distribution.bull), bear = eqFnum(distribution.bear);
  const move = Math.abs(eqFnum(expectedMovePct));
  const edge = Math.abs(bull - bear) * move;
  return edge;
}

// 主闸门:任何新仓都必须先过这里
export function entryQuality(input) {
  const o = input || {};
  const rules = { ...ENTRY_QUALITY_RULES, ...(o.rules || {}) };
  const blockers = [];
  const reasons = [];

  // 1) 数据可靠度
  const dq = o.data_quality || {};
  const dqOk = dq.ok !== false && (dq.score == null || eqFnum(dq.score) >= rules.min_data_quality);
  if (!dqOk) blockers.push("DATA_UNRELIABLE");

  // 2) 概率分布
  const dist = probabilityDistribution({
    rule: o.rule,
    ml: o.ml,
    predictor: o.predictor,
    weights: o.weights
  });
  if (!dist.ok) blockers.push("NO_MODEL_INPUT");
  if (dist.agreement === "CONFLICT") blockers.push("MODEL_CONFLICT");

  // 3) 领先方向与概率差
  let leader = null, leaderP = null, gap = null, second = null;
  if (dist.ok) {
    const arr = [["LONG", dist.bull], ["HOLD", dist.neutral], ["SHORT", dist.bear]].sort((a, b) => b[1] - a[1]);
    leader = arr[0][0]; leaderP = arr[0][1]; second = arr[1][1]; gap = leaderP - second;
    if (gap < rules.min_prob_gap) blockers.push("PROB_GAP_TOO_SMALL");
    if (leaderP < rules.min_leader_probability) blockers.push("LOW_LEADER_PROBABILITY");
    if (leader === "HOLD") blockers.push("PROB_GAP_TOO_SMALL");
  }

  // 4) 不确定性
  const rawUncertainty = clamp01(
    o.uncertainty != null ? o.uncertainty
      : (o.predictor && o.predictor.uncertainty != null ? o.predictor.uncertainty : (dist.ok ? dist.neutral : 1))
  );

  // 5) 预期振幅与成本
  const atrPct = eqFnum(o.atr_pct, null);
  const predictorMove = o.predictor && o.predictor.expected_move_pct != null
    ? Math.abs(eqFnum(o.predictor.expected_move_pct))
    : null;
  // 预期振幅 = 预测器给的 future path,或 ATR 代理。两者都没有 → 记为"无法估算",而不是当成 0。
  // (把"没有波动率数据"当成"零边际"会把所有缺字段的调用一律判死,那是假结论不是真拒绝。)
  const expectedMovePct = predictorMove != null
    ? predictorMove
    : (atrPct == null || atrPct <= 0 ? null : Math.abs(atrPct));
  const edgeEstimated = expectedMovePct != null;
  const uncertainty = edgeEstimated ? rawUncertainty : Math.max(rawUncertainty, rules.unknown_edge_uncertainty);
  if (uncertainty > rules.max_uncertainty) blockers.push("HIGH_UNCERTAINTY");

  const plannedNotional = eqFnum(o.notional, 0);
  const costs = estimateTradeCosts({
    notional: plannedNotional,
    config: o.config,
    atr_pct: atrPct,
    spread_bps: o.spread_bps,
    funding_rate: o.funding && o.funding.available !== false ? o.funding && o.funding.rate : null,
    hold_hours: o.hold_hours
  });
  const grossEdgePct = edgeEstimated ? expectedGrossEdgePct(dist, expectedMovePct) : null;
  const netEdgePct = grossEdgePct == null || costs.cost_pct == null ? null : grossEdgePct - costs.cost_pct;
  if (edgeEstimated) {
    if (grossEdgePct != null && costs.cost_pct != null && grossEdgePct > 0 && grossEdgePct < costs.cost_pct * rules.min_edge_cost_ratio) {
      blockers.push("COST_DOMINATES");
    }
    if (netEdgePct != null && netEdgePct < rules.min_net_edge_pct) blockers.push("SKIP_LOW_NET_EDGE");
  } else {
    // 净边际无法估算时:不凭空放行,也不凭空判死 —— 用更保守的不确定性把关,并如实标注原因
    reasons.push("缺少波动率/预测振幅,净边际无法估算,按更保守的质量分把关");
  }

  // 6) Regime / 风险 / 样本
  const regimeOk = !o.regime || o.regime_favorable !== false;
  if (!regimeOk) blockers.push("REGIME_UNFAVORABLE");
  if (o.risk_allow === false) blockers.push("RISK_VETO");
  if (o.sample_count != null && eqFnum(o.sample_count) < rules.min_samples) blockers.push("INSUFFICIENT_SAMPLES");
  if (o.exposure_allow === false) blockers.push("EXPOSURE_CAP");

  // 7) 综合分
  const w = rules.weights;
  const ruleQuality = dist.ok ? clamp01((dist.bull + dist.bear) * 0.5 + 0.5) : 0;
  const alignment = dist.agreement === "ALIGNED" ? 1 : (dist.agreement === "PARTIAL" ? 0.6 : 0);
  const predictorQuality = o.predictor && o.predictor.uncertainty != null ? clamp01(1 - eqFnum(o.predictor.uncertainty)) : (dist.ok ? clamp01(1 - uncertainty) : 0);
  const regimeScore = regimeOk ? (eqFnum(o.regime_strength, 0.5)) : 0;
  const entryScore = Math.round(100 * clamp01(
    w.rule * ruleQuality +
    w.features * predictorQuality +
    w.predictor * predictorQuality * 0.5 + // 预测只算半份(不单独放行)
    w.regime * regimeScore +
    w.alignment * alignment
  )) - Math.round(uncertainty * 100 * rules.blame_uncertainty_penalty);
  const scoreFinal = Math.max(0, Math.min(100, entryScore));
  if (scoreFinal < rules.min_entry_score) blockers.push("LOW_ENTRY_SCORE");

  const unique = [...new Set(blockers)];
  const allow = unique.length === 0;
  let decision;
  if (unique.includes("DATA_UNRELIABLE")) decision = "DATA_UNRELIABLE";
  else if (unique.includes("MODEL_CONFLICT") || unique.includes("NO_MODEL_INPUT")) decision = "MODEL_CONFLICT";
  else if (unique.includes("PROB_GAP_TOO_SMALL") && (!dist.ok || leader === "HOLD")) decision = "UNKNOWN";
  else if (!allow) decision = "NO_TRADE";
  else decision = leader === "SHORT" ? "SHORT" : "LONG";

  if (allow) reasons.push(leader === "SHORT" ? "概率与成本同时支持做空" : "概率与成本同时支持做多");
  for (const b of unique) reasons.push(NO_TRADE_ZH[b] || b);

  return {
    version: ENTRY_QUALITY_VERSION,
    decision: decision,
    decision_zh: ENTRY_DECISION_ZH[decision] || decision,
    allow_entry: allow,
    direction: allow ? (leader === "SHORT" ? "SHORT" : "LONG") : null,
    entry_score: scoreFinal,
    direction_probability: leaderP,
    probability_gap: gap,
    distribution: dist.ok ? { bull: dist.bull, neutral: dist.neutral, bear: dist.bear } : null,
    agreement: dist.agreement,
    sources: dist.sources,
    uncertainty: uncertainty,
    edge_estimated: edgeEstimated,
    expected_move_pct: expectedMovePct,
    gross_edge_pct: grossEdgePct,
    estimated_cost: costs,
    net_expected_edge_pct: netEdgePct,
    net_expected_edge_usdt: netEdgePct == null ? null : plannedNotional * netEdgePct / 100,
    blockers: unique,
    block_reasons_zh: unique.map((b) => NO_TRADE_ZH[b] || b),
    reasons: reasons,
    created_at: eqFnum(o.now, 0)
  };
}

// 最小有意义仓位:Risk 批准的小仓如果连"预期收益"都不到门槛 → 不开(禁止 0.x U 蚂蚁仓)
export function minimumMeaningfulPosition(input) {
  const o = input || {};
  const rules = { ...MIN_MEANINGFUL_RULES, ...(o.rules || {}) };
  const equity = Math.max(0, eqFnum(o.equity));
  // 注意 Number(null) === 0:必须显式判 null,否则"没有边际数据"会被当成"零边际"
  const rawEdge = o.net_expected_edge_pct;
  const netEdgePct = rawEdge == null || rawEdge === "" ? null : (Number.isFinite(Number(rawEdge)) ? Number(rawEdge) : null);
  const requiredNet = Math.max(rules.min_net_profit_usdt, equity * rules.min_net_profit_pct_of_equity / 100);
  const byEdge = netEdgePct != null && netEdgePct > DENOM_EPS ? requiredNet / (netEdgePct / 100) : null;
  // 绝对下限与"净值比例下限"取较小者,再夹到一个不可再小的底(0.5U):
  // 小账户(10U)不会被 5U 的绝对门槛误杀,大账户(1000U)也不会出现 0.x 蚂蚁仓。
  const byFloor = Math.max(0.5, Math.min(rules.min_notional_usdt, equity * rules.min_notional_pct_of_equity / 100));
  const candidates = [byEdge, byFloor].filter((v) => v != null);
  if (!candidates.length) {
    return { feasible: false, reason: "no_positive_edge", min_notional: null, required_net_profit_usdt: requiredNet };
  }
  const minNotional = Math.max(...candidates);
  const requestedNotional = o.requested_notional == null ? null : eqFnum(o.requested_notional, null);
  const below = requestedNotional != null && requestedNotional + 1e-9 < minNotional;
  // 这里只回答"这个仓位值不值得开(是否小到没有意义)";
  // 边际是否为负是 Entry Quality Gate 的职责(避免同一件事被两处判死)
  return {
    feasible: !below,
    reason: below ? "BELOW_MIN_MEANINGFUL" : "ok",
    min_notional: minNotional,
    requested_notional: requestedNotional,
    required_net_profit_usdt: requiredNet,
    expected_net_profit_usdt: netEdgePct == null || requestedNotional == null ? null : requestedNotional * netEdgePct / 100
  };
}

// 被 SKIP 的机会也要留影子结果(§28:让系统知道"没做这一单"后来对不对)
export function skipShadowRecord(quality, meta) {
  const q = quality || {};
  const m = meta || {};
  return {
    kind: "SKIP_SHADOW",
    symbol: m.symbol || null,
    mode: m.mode || null,
    at: eqFnum(m.at, eqFnum(q.created_at, 0)),
    candle_time: m.candle_time == null ? null : eqFnum(m.candle_time),
    would_be_direction: q.direction || (q.distribution ? (q.distribution.bull >= q.distribution.bear ? "LONG" : "SHORT") : null),
    entry_score: q.entry_score == null ? null : eqFnum(q.entry_score),
    blockers: Array.isArray(q.blockers) ? q.blockers.slice() : [],
    entry_price: m.entry_price == null ? null : eqFnum(m.entry_price),
    resolved: false,
    outcome: null,
    counterfactual_pnl_pct: null
  };
}

// 影子结果回填(纯函数):比对"如果开了会怎样"
export function resolveSkipShadow(record, price) {
  const r = record || {};
  const entry = eqFnum(r.entry_price, null);
  const cur = eqFnum(price, null);
  if (entry == null || entry <= 0 || cur == null || cur <= 0) return { ...r, resolved: false };
  const raw = (cur - entry) / entry * 100;
  const sign = r.would_be_direction === "SHORT" ? -1 : 1;
  const pct = raw * sign;
  return { ...r, resolved: true, outcome: pct > 0.05 ? "WOULD_WIN" : (pct < -0.05 ? "WOULD_LOSE" : "FLAT"), counterfactual_pnl_pct: pct };
}

// UI 视图(中文优先)
export function entryQualityView(q) {
  if (!q) return null;
  return {
    decision_zh: q.decision_zh || ENTRY_DECISION_ZH[q.decision] || q.decision,
    score: q.entry_score,
    probability_pct: q.direction_probability == null ? null : Math.round(q.direction_probability * 1000) / 10,
    gap_pct: q.probability_gap == null ? null : Math.round(q.probability_gap * 1000) / 10,
    uncertainty_pct: q.uncertainty == null ? null : Math.round(q.uncertainty * 1000) / 10,
    cost_pct: q.estimated_cost && q.estimated_cost.cost_pct != null ? Math.round(q.estimated_cost.cost_pct * 1000) / 1000 : null,
    net_edge_pct: q.net_expected_edge_pct == null ? null : Math.round(q.net_expected_edge_pct * 1000) / 1000,
    reasons_zh: q.block_reasons_zh && q.block_reasons_zh.length ? q.block_reasons_zh : (q.reasons || [])
  };
}
