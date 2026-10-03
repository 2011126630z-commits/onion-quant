// paper/ensemble.js · V16 §12 集合预测(纯函数,无 I/O)
// 目的:单一方向概率不足以决策。把"未来会怎样"拆成若干可解释情景(缓慢上涨/区间/先跌后涨/
//       快速下跌/剧烈波动),每个情景给出概率、期望移动、波动与一条代表性路径。
// 关键:全部由确定性公式 + 由上下文派生的 seed 构造,不含任何随机数——
//       同一个 ctx 永远算出同一个结果(可复现、可回测、可打靶)。
export const ENSEMBLE_VERSION = "ensemble-v1.0";

export const SCENARIO_TYPES = ["SLOW_BULL", "RANGE", "DIP_THEN_RECOVER", "FAST_BEAR", "HIGH_VOL"];

export const SCENARIO_ZH = {
  SLOW_BULL: "缓慢上涨",
  RANGE: "区间震荡",
  DIP_THEN_RECOVER: "先跌后回升",
  FAST_BEAR: "快速下跌",
  HIGH_VOL: "剧烈波动"
};

// 路径分散度上限:超过就认定"高不确定性",直接拒绝开仓
export const ENSEMBLE_MAX_DISPERSION = 0.35;

export const ENSEMBLE_ACTION_ZH = { LONG: "做多", SHORT: "做空", NEUTRAL: "观望", NO_TRADE: "不交易" };

const ENSEMBLE_REGIME_ZH = {
  TREND_UP: "上涨趋势",
  TREND_DOWN: "下跌趋势",
  RANGE: "区间震荡",
  HIGH_VOL: "高波动",
  UNKNOWN: "未知环境"
};

// regime 对情景的微调(乘性):趋势行情给顺方向加权,高波动行情抬高波动情景
const ENSEMBLE_REGIME_BIAS = {
  TREND_UP: { SLOW_BULL: 1.30, DIP_THEN_RECOVER: 1.10, FAST_BEAR: 0.70, RANGE: 0.85, HIGH_VOL: 1.00 },
  TREND_DOWN: { FAST_BEAR: 1.35, DIP_THEN_RECOVER: 0.90, SLOW_BULL: 0.70, RANGE: 0.85, HIGH_VOL: 1.10 },
  RANGE: { RANGE: 1.35, DIP_THEN_RECOVER: 1.00, SLOW_BULL: 0.90, FAST_BEAR: 0.90, HIGH_VOL: 0.90 },
  HIGH_VOL: { HIGH_VOL: 1.50, RANGE: 0.80, SLOW_BULL: 0.85, FAST_BEAR: 1.10, DIP_THEN_RECOVER: 1.10 },
  UNKNOWN: { SLOW_BULL: 1.00, RANGE: 1.00, DIP_THEN_RECOVER: 1.00, FAST_BEAR: 1.00, HIGH_VOL: 1.00 }
};

// 代表性路径模板(相对振幅百分比,起点恒为 0):纯常数,不含随机
const ENSEMBLE_PATH_TEMPLATES = {
  SLOW_BULL: [0, 0.30, 0.62, 0.85, 1.00],
  RANGE: [0, 0.35, -0.25, 0.18, 0.02],
  DIP_THEN_RECOVER: [0, -0.62, -0.90, -0.34, 0.42],
  FAST_BEAR: [0, -0.36, -0.70, -0.90, -1.00],
  HIGH_VOL: [0, 0.72, -0.78, 0.58, -0.46]
};

// ---- 私有数学工具(本模块自带,不 import 其它模块) ----
function ensembleNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function ensembleClamp(v, lo, hi) {
  const n = ensembleNum(v);
  if (n == null) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}
function ensembleClamp01(v) {
  return ensembleClamp(v, 0, 1);
}
function ensembleRound2(v) {
  const n = ensembleNum(v);
  if (n == null) return 0;
  return Math.round(n * 100) / 100;
}
// 由上下文派生的确定性 seed ∈ [0,1):同一 ctx → 同一 seed,不依赖时间/随机源
function ensembleSeed(ctx) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const d = c.distribution && typeof c.distribution === "object" ? c.distribution : {};
  const a = ensembleNum(c.atr_pct) || 0;
  const t = ensembleNum(c.trend_strength) || 0;
  const u = ensembleNum(c.uncertainty) || 0;
  const f = ensembleNum(c.funding_rate) || 0;
  const b = ensembleNum(d.bull) || 0;
  const n = ensembleNum(d.neutral) || 0;
  const r = ensembleNum(d.bear) || 0;
  const reg = typeof c.regime === "string" ? c.regime.length : 0;
  const x = Math.sin(a * 12.9898 + t * 78.233 + u * 37.719 + f * 43758.5453 + b * 11.1 + n * 23.3 + r * 31.7 + reg * 7.7) * 43758.5453;
  return x - Math.floor(x);
}
// 三分类分布归一化;非法输入退回等权,避免静默变 0
function ensembleNormalizeDistribution(dist) {
  const d = dist && typeof dist === "object" ? dist : {};
  let b = ensembleClamp(ensembleNum(d.bull), 0, 1);
  let n = ensembleClamp(ensembleNum(d.neutral), 0, 1);
  let r = ensembleClamp(ensembleNum(d.bear), 0, 1);
  const s = b + n + r;
  if (!(s > 0)) { b = 1 / 3; n = 1 / 3; r = 1 / 3; return { bull: b, neutral: n, bear: r }; }
  return { bull: b / s, neutral: n / s, bear: r / s };
}

// 构造情景:概率由分布+趋势+不确定性推导,路径由模板×波动幅度×确定性扰动构造
export function buildScenarios(ctx) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const dist = ensembleNormalizeDistribution(c.distribution);
  const regime = typeof c.regime === "string" && ENSEMBLE_REGIME_ZH[c.regime] ? c.regime : "UNKNOWN";
  const atr = Math.max(ensembleNum(c.atr_pct) || 0, 0);
  const trend = ensembleClamp(ensembleNum(c.trend_strength) || 0, -1, 1);
  const uncertainty = ensembleClamp01(c.uncertainty);
  const funding = ensembleNum(c.funding_rate) || 0;
  const up = Math.max(0, trend);
  const down = Math.max(0, -trend);
  const atrNorm = ensembleClamp01(atr / 5);              // 5% 波动视为满格
  const fundScore = ensembleClamp(funding / 0.001, -1, 1); // ±0.1% 费率视为满格

  const raw = {};
  raw.SLOW_BULL = Math.max(0, dist.bull * (0.55 + 0.45 * up) * (1 - 0.25 * uncertainty) - 0.05 * fundScore);
  raw.FAST_BEAR = Math.max(0, dist.bear * (0.55 + 0.45 * down) * (1 - 0.25 * uncertainty) + 0.05 * fundScore);
  raw.RANGE = Math.max(0, dist.neutral * (1 - 0.35 * uncertainty));
  raw.DIP_THEN_RECOVER = Math.max(0, dist.bull * 0.55 * (1 + uncertainty) + dist.neutral * 0.15);
  raw.HIGH_VOL = Math.max(0, uncertainty * 0.60 + atrNorm * 0.50 + (1 - Math.abs(trend)) * 0.08);

  const bias = ENSEMBLE_REGIME_BIAS[regime];
  for (const k of SCENARIO_TYPES) raw[k] = Math.max(0, raw[k]) * (ensembleNum(bias[k]) != null ? Number(bias[k]) : 1);

  let total = SCENARIO_TYPES.reduce((a, k) => a + raw[k], 0);
  const probs = {};
  if (total > 0) {
    for (const k of SCENARIO_TYPES) probs[k] = raw[k] / total;
  } else {
    for (const k of SCENARIO_TYPES) probs[k] = 1 / SCENARIO_TYPES.length;
  }
  // 消除浮点残差:把差值补到最大概率情景上,保证概率和精确为 1
  const lead = SCENARIO_TYPES.reduce((a, k) => (probs[k] > probs[a] ? k : a), SCENARIO_TYPES[0]);
  const sum = SCENARIO_TYPES.reduce((a, k) => a + probs[k], 0);
  probs[lead] += 1 - sum;
  total = 1;

  const unit = Math.max(atr, 0.2);
  const seed = ensembleSeed(c);
  const jitter = 1 + 0.08 * (seed - 0.5);               // 确定性小扰动,让同族但不同的 ctx 路径不雷同
  const terminal = {
    SLOW_BULL: 1.00, RANGE: 0.02, DIP_THEN_RECOVER: 0.42, FAST_BEAR: -1.00, HIGH_VOL: -0.46
  };
  const mag = {
    SLOW_BULL: unit * (0.9 + 0.6 * up),
    RANGE: unit * 0.5,
    DIP_THEN_RECOVER: unit * (1.0 + 0.5 * uncertainty),
    FAST_BEAR: unit * (0.9 + 0.6 * down),
    HIGH_VOL: unit * (1.4 + 1.2 * uncertainty)
  };
  const volMult = {
    SLOW_BULL: 1.0, RANGE: 0.9, DIP_THEN_RECOVER: 1.4, FAST_BEAR: 1.3, HIGH_VOL: 1.8 + 0.8 * uncertainty
  };

  return SCENARIO_TYPES.map((k) => {
    const m = mag[k] * jitter;
    return {
      key: k,
      zh: SCENARIO_ZH[k],
      probability: probs[k],
      expected_move_pct: ensembleRound2(terminal[k] * m),
      volatility_pct: ensembleRound2(unit * volMult[k] * (1 + 0.5 * uncertainty)),
      path_shape: ENSEMBLE_PATH_TEMPLATES[k].map((v) => ensembleRound2(v * m))
    };
  });
}

// 尾部风险:按概率加权的"最差/最好 fraction 情景"的平均移动(边界情景按部分权重计入)
function ensembleTail(scenarios, fraction, worst) {
  const sorted = scenarios.slice().sort((a, b) => worst
    ? (a.expected_move_pct - b.expected_move_pct)
    : (b.expected_move_pct - a.expected_move_pct));
  let acc = 0, wsum = 0;
  for (const s of sorted) {
    if (wsum >= fraction) break;
    const p = ensembleClamp(s.probability, 0, 1);
    const take = Math.min(p, fraction - wsum);
    if (take > 0) { acc += take * s.expected_move_pct; wsum += take; }
  }
  return wsum > 0 ? acc / wsum : null;
}

// 集合预测:情景集合 + 分散度 + 尾部 + 操作倾向
export function ensembleForecast(ctx) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const scenarios = buildScenarios(c);
  const expected = scenarios.reduce((a, s) => a + s.probability * s.expected_move_pct, 0);

  let maxAbs = 0;
  for (const s of scenarios) maxAbs = Math.max(maxAbs, Math.abs(s.expected_move_pct));
  let varSum = 0;
  for (const s of scenarios) varSum += s.probability * (s.expected_move_pct - expected) * (s.expected_move_pct - expected);
  const std = Math.sqrt(varSum);
  // 方向平衡:涨/跌情景的概率质量有多势均力敌。都偏一侧(哪怕情景很多)→ 平衡度低 → 分散度低。
  // 这一点很关键:缓慢上涨与先跌后涨方向一致,不该被当成"意见不合"。
  let upMass = 0, downMass = 0;
  for (const s of scenarios) {
    if (s.expected_move_pct > 0) upMass += s.probability;
    else if (s.expected_move_pct < 0) downMass += s.probability;
  }
  const balance = 1 - Math.abs(upMass - downMass);
  const spreadRatio = maxAbs > 0 ? Math.min(1, std / maxAbs) : 0;
  // 分散度 = 方向平衡(0.6) + 路径相对离散(0.4):两项都在 [0,1],越高越不确定
  const dispersion = ensembleClamp01(0.6 * balance + 0.4 * spreadRatio);

  const downside_tail_pct = ensembleTail(scenarios, 0.2, true);
  const upside_tail_pct = ensembleTail(scenarios, 0.2, false);

  const sortedP = scenarios.map((s) => s.probability).sort((a, b) => b - a);
  const probability_gap = sortedP.length >= 2 ? sortedP[0] - sortedP[1] : 0;

  const atr = Math.max(ensembleNum(c.atr_pct) || 0, 0);
  const edge = Math.max(0.15 * Math.max(atr, 0.2), 0.05);
  let action_bias;
  if (dispersion > ENSEMBLE_MAX_DISPERSION) action_bias = "NO_TRADE";
  else if (expected > edge) action_bias = "LONG";
  else if (expected < -edge) action_bias = "SHORT";
  else action_bias = "NEUTRAL";

  const lead = scenarios.reduce((a, s) => (s.probability > a.probability ? s : a), scenarios[0]);
  const reason_zh = "情景以「" + lead.zh + "」为主(概率 " + (lead.probability * 100).toFixed(0) + "%),"
    + "期望移动 " + expected.toFixed(2) + "%,路径分散度 " + dispersion.toFixed(2) + ",倾向"
    + (ENSEMBLE_ACTION_ZH[action_bias] || action_bias);

  return {
    scenarios,
    path_dispersion: dispersion,
    downside_tail_pct,
    upside_tail_pct,
    expected_move_pct: ensembleRound2(expected),
    uncertainty: ensembleClamp01(ensembleNum(c.uncertainty) != null ? c.uncertainty : dispersion),
    probability_gap,
    action_bias,
    reason_zh
  };
}

// 集合预测闸门:路径越分散 → 越减仓;超过上限直接拒绝
export function ensembleGate(forecast, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const maxDisp = ensembleNum(o.max_dispersion) != null ? Number(o.max_dispersion) : ENSEMBLE_MAX_DISPERSION;
  if (!forecast || typeof forecast !== "object") {
    return { allow: false, scale: 0, code: "NO_FORECAST", reason_zh: "没有集合预测结果,拒绝开仓" };
  }
  const disp = ensembleNum(forecast.path_dispersion);
  if (disp == null) {
    return { allow: false, scale: 0, code: "NO_DISPERSION", reason_zh: "缺少路径分散度,无法评估不确定性,拒绝开仓" };
  }
  if (forecast.action_bias === "NO_TRADE" || disp > maxDisp) {
    return {
      allow: false,
      scale: 0,
      code: "HIGH_DISPERSION",
      reason_zh: "情景路径分散度 " + disp.toFixed(2) + " 超过上限 " + maxDisp + "(高不确定性),拒绝开仓"
    };
  }
  const ratio = maxDisp > 0 ? disp / maxDisp : 0;
  const scale = ensembleClamp(1 - 0.6 * ratio, 0.4, 1);
  if (forecast.action_bias === "NEUTRAL") {
    return { allow: true, scale, code: "NEUTRAL", reason_zh: "各情景势均力敌,只允许小仓试探(仓位系数 " + scale.toFixed(2) + ")" };
  }
  return {
    allow: true,
    scale,
    code: "OK",
    reason_zh: "按分散度 " + disp.toFixed(2) + " 调整仓位系数至 " + scale.toFixed(2)
  };
}

// 集合预测中文视图
export function ensembleView(forecast) {
  const f = forecast && typeof forecast === "object" ? forecast : {};
  const scenarios = Array.isArray(f.scenarios) ? f.scenarios : [];
  const rows = scenarios.map((s) => ({
    key: s.key,
    zh: SCENARIO_ZH[s.key] || s.key,
    probability_pct: Math.round((ensembleNum(s.probability) || 0) * 1000) / 10,
    expected_move_pct: ensembleNum(s.expected_move_pct) || 0,
    volatility_pct: ensembleNum(s.volatility_pct) || 0,
    path_shape: Array.isArray(s.path_shape) ? s.path_shape : []
  }));
  const bias = ENSEMBLE_ACTION_ZH[f.action_bias] ? f.action_bias : "NEUTRAL";
  const lead = rows.length ? rows.reduce((a, s) => (s.probability_pct > a.probability_pct ? s : a), rows[0]) : null;
  const headline_zh = lead
    ? "最可能情景:" + lead.zh + "(" + lead.probability_pct + "%),期望移动 " + (ensembleNum(f.expected_move_pct) || 0).toFixed(2) + "%,倾向" + ENSEMBLE_ACTION_ZH[bias]
    : "缺少情景数据";
  return {
    title_zh: "集合预测",
    rows,
    action_bias: bias,
    action_bias_zh: ENSEMBLE_ACTION_ZH[bias],
    path_dispersion: ensembleNum(f.path_dispersion),
    dispersion_zh: (ensembleNum(f.path_dispersion) || 0) > ENSEMBLE_MAX_DISPERSION ? "高不确定性(路径分散)" : "路径较集中",
    downside_tail_pct: ensembleNum(f.downside_tail_pct),
    upside_tail_pct: ensembleNum(f.upside_tail_pct),
    expected_move_pct: ensembleNum(f.expected_move_pct),
    probability_gap: ensembleNum(f.probability_gap),
    uncertainty: ensembleNum(f.uncertainty),
    headline_zh,
    reason_zh: typeof f.reason_zh === "string" ? f.reason_zh : "缺少结论说明"
  };
}
