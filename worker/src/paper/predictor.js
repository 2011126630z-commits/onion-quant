// paper/predictor.js · Future Direction Predictor(V14.4)
// 目标(§1-5, §24-27, §78):判断"未来更可能往哪走 + 可能有多大波动",输出概率分布而不是单单涨跌。
//
// 硬约束:
//   1) 只输出概率分布 + 预期幅度 + 不确定性,不输出买卖指令(预测不是交易命令,§3)
//   2) 不同 Horizon 用不同权重分别计算与保存,禁止一套结果套用所有未来时间(§2)
//   3) 所有输入必须是决策时刻之前已存在的数据(§25 防 Look-Ahead);本模块不取数、不重算历史特征
//   4) 无随机数:同一输入必得同一输出(可测试、可复现)
//   5) 标注 model_version / source,便于 Champion-Challenger 与结果追踪
import { num, numOrNull, round } from "./accounting.js";
import { classifyOutcome, noiseThresholdPct } from "../history/outcome.js";

export const PREDICTOR_VERSION = "predictor-v14.4";

// §2:SHORT 预测 15m/1h/4h;LONG 预测 4h/1d/3d(4h 同时服务两组,但只算一次、分开引用)
export const PREDICTOR_HORIZONS = {
  "15m": { hours: 0.25, group: "short", intervalMs: 900000 },
  "1h": { hours: 1, group: "short", intervalMs: 3600000 },
  "4h": { hours: 4, group: "short", intervalMs: 14400000 },
  "1d": { hours: 24, group: "long", intervalMs: 86400000 },
  "3d": { hours: 72, group: "long", intervalMs: 259200000 }
};
export const SHORT_HORIZONS = ["15m", "1h", "4h"];
export const LONG_HORIZONS = ["4h", "1d", "3d"];

// 每个 Horizon 的组件权重:短周期重"当下动能/量能",长周期重"环境/结构/BTC/宏观"
// 这就是"不同 Horizon 不同模型结果"的落地方式(而不是同一套权重复用)
export const HORIZON_WEIGHTS = {
  short: { rule: 0.22, tf: 0.16, structure: 0.16, momentum: 0.12, volume: 0.12, btc: 0.08, regime: 0.06, ml: 0.16, external: 0.06 },
  long: { rule: 0.12, tf: 0.06, structure: 0.12, momentum: 0.05, volume: 0.05, btc: 0.13, regime: 0.20, ml: 0.18, external: 0.14 }
};
// 概率分布的锐度:越大越"敢表态";中性基线与随 |net| 的削峰
export const PREDICTOR_SHARPNESS = 2.4;
export const PREDICTOR_NEUTRAL_BASE = 0.9;
export const PREDICTOR_NEUTRAL_TILT = 1.6;
export const EXTERNAL_TILT_CAP = 0.25;   // 外部信息只能小幅影响,且永远不能单独决定(§6/§17)

function clamp(v, lo, hi) {
  const n = num(v, 0);
  return n < lo ? lo : n > hi ? hi : n;
}

function softmax3(bull, neutral, bear) {
  const max = Math.max(bull, neutral, bear);
  const e = [Math.exp(bull - max), Math.exp(neutral - max), Math.exp(bear - max)];
  const sum = e[0] + e[1] + e[2];
  if (!(sum > 0) || !Number.isFinite(sum)) return [1 / 3, 1 / 3, 1 / 3];
  return e.map((v) => v / sum);
}

// 规则方向 → 连续分值(-1..1),与 fusion.ruleScore 同源语义
export function ruleTilt(analysis) {
  const a = analysis || {};
  if (a.limited_data) return 0;
  const dir = String(a.direction || "Neutral");
  const magnitude = (num(a.signal_strength, 50) - 50) / 50;
  if (/Strong Bullish/.test(dir)) return clamp(Math.max(0.6, magnitude), -1, 1);
  if (/Bullish/.test(dir)) return clamp(Math.max(0.25, magnitude), -1, 1);
  if (/Strong Bearish/.test(dir)) return clamp(Math.min(-0.6, magnitude), -1, 1);
  if (/Bearish/.test(dir)) return clamp(Math.min(-0.25, magnitude), -1, 1);
  return 0;
}

export function tfTilt(analysis) {
  const tf = (analysis && analysis.timeframes) || {};
  const keys = Object.keys(tf);
  if (!keys.length) return 0;
  let bull = 0;
  let bear = 0;
  for (const k of keys) {
    const v = String(tf[k]);
    if (/Strong Bullish/.test(v)) bull += 1;
    else if (/Bullish/.test(v)) bull += 0.6;
    else if (/Strong Bearish/.test(v)) bear += 1;
    else if (/Bearish/.test(v)) bear += 0.6;
  }
  const total = bull + bear;
  if (!total) return 0;
  const raw = (bull - bear) / total;
  // 多周期冲突时降低幅度(不表态)
  return clamp(analysis && analysis.tf_conflict ? raw * 0.4 : raw, -1, 1);
}

export function structureTilt(analysis) {
  const s = (analysis && analysis.structure) || {};
  let v = 0;
  if (s.hh) v += 0.25;
  if (s.hl) v += 0.25;
  if (s.lh) v -= 0.25;
  if (s.ll) v -= 0.25;
  if (s.label === "上涨结构") v += 0.2;
  if (s.label === "下降结构") v -= 0.2;
  return clamp(v, -1, 1);
}

// 动能:RSI/MACD/ROC/EMA 距离 的综合(只用快照特征,不含未来数据)
export function momentumTilt(analysis) {
  const f = (analysis && analysis.features) || {};
  const parts = [];
  const rsi = numOrNull(f.rsi14);
  if (rsi != null) parts.push(clamp((rsi - 50) / 25, -1, 1));
  const macd = numOrNull(f.macd_hist);
  if (macd != null) parts.push(clamp(macd >= 0 ? Math.min(1, macd) : Math.max(-1, macd), -1, 1));
  const roc = numOrNull(f.roc9);
  if (roc != null) parts.push(clamp(roc / 2, -1, 1));
  const ema20 = numOrNull(f.ema20_dist_pct);
  if (ema20 != null) parts.push(clamp(ema20 / 1.5, -1, 1));
  if (!parts.length) return 0;
  return clamp(parts.reduce((a, b) => a + b, 0) / parts.length, -1, 1);
}

export function volumeTilt(analysis) {
  const v = (analysis && analysis.volume) || {};
  const ratio = num(v.ratio20, 1);
  const pattern = String(v.pattern || "");
  if (/缩量上涨|缩量下跌/.test(pattern)) return 0;              // 量能未确认 → 不表态
  const direction = ruleTilt(analysis) >= 0 ? 1 : -1;
  if (ratio >= 1.2) return clamp(direction * 0.6, -1, 1);
  if (ratio <= 0.7) return clamp(-direction * 0.3, -1, 1);      // 极度缩量 → 反向谨慎
  return 0;
}

export function regimeTilt(analysis) {
  const r = (analysis && analysis.market_regime) || {};
  const label = String(r.label || "");
  const adx = num(r.adx, 0);
  const strong = adx >= 25;
  let v = 0;
  if (/Strong Uptrend/.test(label)) v = 0.8;
  else if (/Uptrend/.test(label)) v = 0.5;
  else if (/Strong Downtrend/.test(label)) v = -0.8;
  else if (/Downtrend/.test(label)) v = -0.5;
  else v = 0;   // 区间市:不表态
  if (strong) v *= 1.2;
  return clamp(v, -1, 1);
}

export function btcTilt(analysis) {
  const b = (analysis && analysis.btc_context) || {};
  const state = String(b.state || "");
  const corr = clamp(num(b.corr, 0), -1, 1);
  let v = 0;
  if (/Rapid Selloff|Selloff/.test(state)) v = -0.7;
  else if (/Weak|Bearish/.test(state)) v = -0.35;
  else if (/Strong|Bullish/.test(state)) v = 0.45;
  else v = 0;
  // BTC 相关性越低,对山寨的方向传导越弱
  return clamp(v * clamp(Math.abs(corr) || 0.5, 0.2, 1), -1, 1);
}

// ---- 外部情报 → 预测的小幅倾斜(§6/§17/§21:只是上下文,过期衰减,永远不能单独决定) ----
export function externalTilt(external) {
  const e = external || {};
  if (!e || e.unavailable === true) return { value: 0, notes: ["外部情报 unavailable"], freshness: 0 };
  const notes = [];
  const parts = [];
  const fc = e.funding_context || {};
  // 资金费极高 + 多头拥挤 → 反向风险(Crowding Risk),不是"继续看涨"
  if (fc.extreme) {
    const dir = fc.direction === "longs_pay" ? -1 : 1;
    const crowd = clamp(num(fc.crowding_risk, 0) / 100, 0, 1);
    parts.push(dir * crowd * 0.6);
    notes.push("资金费极端(" + (fc.direction || "?") + "),按拥挤风险计入");
  } else if (fc.rate != null) {
    parts.push(clamp(num(fc.rate, 0) / 0.0005, -0.2, 0.2));
  }
  const oi = e.oi_context || {};
  if (oi.interpretation === "trend_confirm_up") { parts.push(0.5); notes.push("价涨OI增,趋势确认"); }
  else if (oi.interpretation === "weak_up_short_covering") { parts.push(-0.3); notes.push("价涨OI减,疑似空头回补"); }
  else if (oi.interpretation === "trend_confirm_down") { parts.push(-0.5); notes.push("价跌OI增,下跌趋势确认"); }
  else if (oi.interpretation === "long_liquidation") { parts.push(0.2); notes.push("价跌OI减,多头被动出清"); }
  const news = e.news_context || {};
  if (news.available && num(news.confidence, 0) > 0 && news.sentiment) {
    const dir = news.sentiment === "bullish" ? 1 : news.sentiment === "bearish" ? -1 : 0;
    const fresh = clamp(num(news.freshness, 0) / 100, 0, 1);
    const conf = clamp(num(news.confidence, 0) / 100, 0, 1);
    const penalty = news.conflicted ? 0.5 : 1;
    parts.push(dir * fresh * conf * 0.5 * penalty);
    notes.push("新闻" + news.sentiment + "(新鲜度 " + Math.round(num(news.freshness, 0)) + (news.conflicted ? ",来源冲突" : "") + ")");
  }
  const pos = e.positioning_context || {};
  // 多空比只作情绪上下文:权重极小,且绝不单独触发方向(§10)
  if (pos.available && pos.long_short_ratio != null) {
    parts.push(clamp((num(pos.long_short_ratio, 1) - 1) * 0.15, -0.15, 0.15));
    notes.push("多空比仅作情绪上下文");
  }
  const raw = parts.length ? parts.reduce((a, b) => a + b, 0) / Math.sqrt(parts.length) : 0;
  return { value: clamp(raw, -EXTERNAL_TILT_CAP, EXTERNAL_TILT_CAP), notes, freshness: clamp(num(e.overall && e.overall.freshness, 0), 0, 1) };
}

// ---- 波动/结构类预测(§5:不只预测方向) ----
export function volatilityForecast(input) {
  const i = input || {};
  const atrPct = Math.max(0.01, num(i.atrPct, 1));
  const hours = Math.max(0.05, num(i.hours, 1));
  const volState = String(i.volState || "");
  const ratio = num(i.volRatio, 1);
  // sqrt(时间) 缩放:波动按平方根律扩散
  const scale = Math.sqrt(hours / Math.max(num(i.baseHours, 1), 0.05));
  const regimeMult = volState === "Expansion" ? 1.25 : volState === "Compression" ? 0.8 : 1;
  const activityMult = clamp(1 + (ratio - 1) * 0.3, 0.7, 1.6);
  const expectedRange = clamp(atrPct * scale * regimeMult * activityMult, 0.02, 60);
  return {
    expected_range_pct: round(expectedRange, 4),
    // 方向性预期幅度:由信心强度决定(弱信心时接近 0,而不是硬给一个方向)
    scale_multiplier: round(scale * regimeMult * activityMult, 4)
  };
}

export function structureForecast(input) {
  const i = input || {};
  const f = i.features || {};
  const r = i.regime || {};
  const adx = num(r.adx, 0);
  const bbWidth = num(f.bb_width_pct, num(i.bbWidthPct, 2));
  const volRatio = num(f.volume_ratio20, num(i.volRatio, 1));
  const rsi = num(f.rsi14, 50);
  const regime = String(r.label || "");
  const rangeRegime = /Range|Sideways|区间/.test(regime) || adx < 20;
  // 突破概率:波动压缩 + 量能抬升 + 趋势环境
  const compression = clamp(1 - bbWidth / 4, 0, 1);
  const breakout = clamp(compression * 0.5 + clamp(volRatio - 1, 0, 1) * 0.3 + (adx >= 25 ? 0.2 : 0), 0, 1);
  // 均值回归概率:区间环境 + RSI 极值
  const rsiExtreme = clamp(Math.abs(rsi - 50) / 35, 0, 1);
  const meanReversion = clamp((rangeRegime ? 0.5 : 0.15) + rsiExtreme * 0.4, 0, 1);
  // 趋势持续性:ADX + 结构一致 + 量能确认
  const persistence = clamp(adx / 45 * 0.6 + clamp(volRatio - 0.8, 0, 0.8) * 0.25 + (i.structureAligned ? 0.15 : 0), 0, 1);
  // 反转风险:从极值 + 回吐 + 拥挤
  const overextension = clamp(Math.abs(num(f.ema20_dist_pct, 0)) / 3, 0, 1);
  const reversal = clamp(overextension * 0.4 + rsiExtreme * 0.3 + num(i.givebackPct, 0) * 0.2 + num(i.crowdingRisk, 0) / 100 * 0.3, 0, 1);
  return {
    trend_persistence: round(persistence, 4),
    reversal_risk: round(reversal, 4),
    breakout_probability: round(breakout, 4),
    mean_reversion_probability: round(meanReversion, 4)
  };
}

// ---- 主预测:单个 Horizon ----
export function predictHorizon(input) {
  const i = input || {};
  const horizon = String(i.horizon || "1h");
  const spec = PREDICTOR_HORIZONS[horizon];
  if (!spec) return { ok: false, reason: "unknown_horizon", horizon };
  const analysis = i.analysis || {};
  const weights = { ...(HORIZON_WEIGHTS[spec.group] || HORIZON_WEIGHTS.short), ...(i.weights || {}) };
  const extTilt = externalTilt(i.external);
  const mlProb = i.ml && i.ml.probability_bullish != null
    ? clamp(num(i.ml.probability_bullish, 0.5) - num(i.ml.probability_bearish, 0.5), -1, 1)
    : null;

  const components = [];
  const add = (key, value, note) => {
    const w = num(weights[key], 0);
    if (!w) return;
    components.push({ key, value: round(clamp(value, -1, 1), 4), weight: w, weighted: round(clamp(value, -1, 1) * w, 4), note: note || "" });
  };
  add("rule", ruleTilt(analysis), "规则方向");
  add("tf", tfTilt(analysis), "多周期一致性");
  add("structure", structureTilt(analysis), "结构 HH/HL/LH/LL");
  add("momentum", momentumTilt(analysis), "RSI/MACD/ROC/EMA");
  add("volume", volumeTilt(analysis), "量能确认");
  add("regime", regimeTilt(analysis), "市场环境");
  add("btc", btcTilt(analysis), "BTC 联动");
  if (mlProb != null) add("ml", mlProb, "ML 概率差");
  add("external", extTilt.value, extTilt.notes.join("; "));

  const available = components.filter((c) => c.value !== 0);
  // 关键:分母用"全部已配置组件"的权重和(而不是仅有数据的那些)。
  // 这样缺证据时净倾斜被自然稀释 —— 没数据就不该有强观点(§76 必须标清不确定性)
  const configuredWeight = Object.keys(weights).reduce((a, k) => a + num(weights[k], 0), 0) || 1;
  const net = clamp(components.reduce((a, b) => a + b.weighted, 0) / configuredWeight, -1, 1);
  const coverage = round(clamp(available.reduce((a, b) => a + b.weight, 0) / configuredWeight, 0, 1), 4);

  const vol = volatilityForecast({
    atrPct: analysis.volatility && analysis.volatility.atrPct,
    hours: spec.hours,
    baseHours: 1,
    volState: analysis.market_regime && analysis.market_regime.vol_state,
    volRatio: analysis.volatility && analysis.volatility.ratio
  });
  const struct = structureForecast({
    features: analysis.features || {},
    regime: analysis.market_regime || {},
    volRatio: (analysis.features || {}).volume_ratio20,
    structureAligned: Math.abs(structureTilt(analysis)) >= 0.2,
    givebackPct: num(i.givebackPct, 0),
    crowdingRisk: num((i.external || {}).funding_context && (i.external || {}).funding_context.crowding_risk, 0)
  });

  // 三分类 logits:net 决定方向,neutral 基线随 |net| 下降 → 强信心时收敛到两侧
  // softmax3(bull, neutral, bear) 的返回顺序与之一致
  const [pBull, pNeutral, pBear] = softmax3(
    net * PREDICTOR_SHARPNESS,
    PREDICTOR_NEUTRAL_BASE - Math.abs(net) * PREDICTOR_NEUTRAL_TILT,
    -net * PREDICTOR_SHARPNESS
  );
  // 数据质量:缺输入 / 降级 → 不确定性上升(§76 必须标清不确定性)
  const missing = [];
  if (!analysis.direction) missing.push("rule");
  if (!Object.keys(analysis.timeframes || {}).length) missing.push("timeframes");
  if (!analysis.market_regime || !analysis.market_regime.label) missing.push("regime");
  if (mlProb == null) missing.push("ml");
  if (extTilt.value === 0) missing.push("external");
  if (analysis.limited_data) missing.push("limited_data");
  const dataQuality = clamp(1 - missing.length / 6, 0.2, 1);
  const rawConfidence = Math.max(pBull, pNeutral, pBear);
  const dispersion = available.length >= 2
    ? clamp(available.reduce((a, b) => a + Math.abs(b.value - net), 0) / available.length / 2, 0, 1)
    : 0.3;
  const uncertainty = clamp((1 - rawConfidence) * 0.7 + dispersion * 0.3 + (1 - dataQuality) * 0.3, 0, 1);
  const expectedMove = round(vol.expected_range_pct * Math.abs(net) * (spec.group === "long" ? 0.9 : 0.7), 4);

  return {
    ok: true,
    horizon,
    group: spec.group,
    hours: spec.hours,
    bullish_probability: round(pBull, 4),
    neutral_probability: round(pNeutral, 4),
    bearish_probability: round(pBear, 4),
    expected_move_pct: clamp(expectedMove, 0, 60),
    expected_range_pct: vol.expected_range_pct,
    trend_persistence: struct.trend_persistence,
    reversal_risk: struct.reversal_risk,
    breakout_probability: struct.breakout_probability,
    mean_reversion_probability: struct.mean_reversion_probability,
    confidence: round(rawConfidence, 4),
    uncertainty: round(uncertainty, 4),
    data_quality: round(dataQuality, 4),
    net_tilt: round(net, 4),
    evidence_coverage: coverage,
    components,
    missing_inputs: missing,
    external_freshness: round(extTilt.freshness, 4),
    model_version: PREDICTOR_VERSION,
    source: mlProb != null ? "evidence+ml" : "evidence",
    // §3:预测不是交易命令 —— 这里明确不产出 action
    action: null,
    note: "仅供决策融合参考,不构成交易指令"
  };
}

// ---- 多周期:每个 Horizon 单独算、单独存(§2) ----
export function predictMultiHorizon(input) {
  const i = input || {};
  const horizons = i.horizons && i.horizons.length ? i.horizons : SHORT_HORIZONS.concat(LONG_HORIZONS.filter((h) => !SHORT_HORIZONS.includes(h)));
  const predictions = {};
  for (const h of horizons) {
    const p = predictHorizon({ ...i, horizon: h });
    if (p.ok) predictions[h] = p;
  }
  return {
    ok: Object.keys(predictions).length > 0,
    generated_at: num(i.now, Date.now()),
    model_version: PREDICTOR_VERSION,
    short_group: SHORT_HORIZONS,
    long_group: LONG_HORIZONS,
    predictions
  };
}

// ---- Calibration(§4):长期检查"说 70% 的样本最终有多少真的上涨" ----
export const CALIBRATION_DEFAULTS = { buckets: 10, minSamples: 30, maxFactor: 1.6, minFactor: 0.5, maxGap: 0.12 };

export function buildCalibrationTable(samples, options) {
  const opts = { ...CALIBRATION_DEFAULTS, ...(options || {}) };
  const table = { buckets: {}, samples: 0, horizon: opts.horizon || null, generated_at: num(opts.now, Date.now()), min_samples: opts.minSamples };
  for (const s of samples || []) {
    const p = numOrNull(s && s.probability);
    if (p == null || !s.actual) continue;
    const idx = Math.min(opts.buckets - 1, Math.max(0, Math.floor(p * opts.buckets)));
    const key = idx + "";
    if (!table.buckets[key]) table.buckets[key] = { predicted_sum: 0, hits: 0, n: 0, range: [round(idx / opts.buckets, 4), round((idx + 1) / opts.buckets, 4)] };
    const b = table.buckets[key];
    b.predicted_sum = round(b.predicted_sum + p, 6);
    b.n += 1;
    if (String(s.actual) === String(s.expected_class || "Bullish")) b.hits += 1;
    table.samples += 1;
  }
  for (const key of Object.keys(table.buckets)) {
    const b = table.buckets[key];
    b.avg_predicted = b.n ? round(b.predicted_sum / b.n, 4) : null;
    b.realized = b.n ? round(b.hits / b.n, 4) : null;
    b.reliable = b.n >= opts.minSamples;
  }
  return table;
}

// 置信度修正系数:过度自信 → 压低;保守 → 允许小幅抬升(上限内)
export function calibrationFactor(table, probability, options) {
  const opts = { ...CALIBRATION_DEFAULTS, ...(options || {}) };
  if (!table || !table.buckets) return { factor: 1, basis: "no_table" };
  const idx = Math.min(opts.buckets - 1, Math.max(0, Math.floor(num(probability, 0) * opts.buckets)));
  const b = table.buckets[idx + ""];
  if (!b || !b.reliable || b.avg_predicted == null || !b.avg_predicted) return { factor: 1, basis: "insufficient_bucket_samples", bucket: idx, n: b ? b.n : 0 };
  const ratio = num(b.realized, 0) / num(b.avg_predicted, 1);
  return {
    factor: round(clamp(ratio, opts.minFactor, opts.maxFactor), 4),
    basis: "bucket_realized_over_predicted",
    bucket: idx,
    n: b.n,
    predicted: b.avg_predicted,
    realized: b.realized
  };
}

// 用校准表修正预测:概率向中性收敛 + 置信度按系数缩放
export function applyCalibration(prediction, table, options) {
  const p = prediction || {};
  if (!p.ok) return p;
  const opts = { ...CALIBRATION_DEFAULTS, ...(options || {}) };
  const target = Math.max(num(p.bullish_probability), num(p.neutral_probability), num(p.bearish_probability));
  const cal = calibrationFactor(table, target, opts);
  const factor = cal.factor;
  const shift = (1 - factor) * 0.5;   // factor < 1(过度自信)→ 更多向中性收敛
  const bull = clamp(num(p.bullish_probability) - num(p.bullish_probability) * shift, 0, 1);
  const bear = clamp(num(p.bearish_probability) - num(p.bearish_probability) * shift, 0, 1);
  const neutral = clamp(1 - bull - bear, 0, 1);
  const conf = clamp(num(p.confidence) * factor, 0, 1);
  return {
    ...p,
    bullish_probability: round(bull, 4),
    bearish_probability: round(bear, 4),
    neutral_probability: round(neutral, 4),
    confidence: round(conf, 4),
    uncertainty: round(clamp(1 - conf + (1 - num(p.data_quality, 1)) * 0.3, 0, 1), 4),
    calibration: { applied: true, factor, basis: cal.basis, bucket: cal.bucket, samples: cal.n || 0, overconfident: factor < 0.9 },
    model_version: p.model_version + "+cal"
  };
}

export function isOverconfident(table, options) {
  const opts = { ...CALIBRATION_DEFAULTS, ...(options || {}) };
  if (!table || !table.buckets) return { overconfident: false, reason: "no_table" };
  const gaps = [];
  for (const key of Object.keys(table.buckets)) {
    const b = table.buckets[key];
    if (!b.reliable || b.avg_predicted == null || b.realized == null) continue;
    gaps.push({ bucket: key, gap: round(b.avg_predicted - b.realized, 4), n: b.n });
  }
  if (!gaps.length) return { overconfident: false, reason: "insufficient_reliable_buckets" };
  const avgGap = gaps.reduce((a, b) => a + b.gap, 0) / gaps.length;
  return { overconfident: avgGap > opts.maxGap, avg_gap: round(avgGap, 4), buckets: gaps, threshold: opts.maxGap };
}

// ---- 结果追踪(§26 / §78):预测先存,到期再补实际结果 ----
export function predictionRecord(prediction, meta) {
  const p = prediction || {};
  const m = meta || {};
  return {
    prediction_id: m.prediction_id || ["pred", p.horizon || "?", num(m.symbol ? 1 : 1), m.timestamp || Date.now()].join("_") + "_" + Math.round(num(m.price, 0)),
    timestamp: num(m.timestamp, Date.now()),
    prediction_timestamp: num(m.timestamp, Date.now()),
    symbol: m.symbol || null,
    horizon: p.horizon || null,
    group: p.group || null,
    probabilities: {
      bullish: num(p.bullish_probability, 0),
      neutral: num(p.neutral_probability, 0),
      bearish: num(p.bearish_probability, 0)
    },
    expected_move_pct: num(p.expected_move_pct, 0),
    expected_range_pct: num(p.expected_range_pct, 0),
    confidence: num(p.confidence, 0),
    uncertainty: num(p.uncertainty, 0),
    reversal_risk: num(p.reversal_risk, 0),
    trend_persistence: num(p.trend_persistence, 0),
    price_at_prediction: numOrNull(m.price),
    feature_time: num(m.timestamp, Date.now()),
    external_context_snapshot: m.external_context_snapshot || null,
    model_version: p.model_version || PREDICTOR_VERSION,
    source: p.source || "evidence",
    resolved: false,
    actual_direction: null,
    actual_return_pct: null,
    actual_volatility_pct: null,
    created_at: num(m.timestamp, Date.now())
  };
}

// 到期结算:用真实价格路径算实际结果(禁止把未到期写成 0)
export function resolvePrediction(record, path) {
  const r = record || {};
  if (!r.prediction_id) return { ok: false, reason: "no_record" };
  const start = num(path && path.price_start, num(r.price_at_prediction, 0));
  const end = num(path && path.price_end, 0);
  if (!(start > 0) || !(end > 0)) return { ok: false, reason: "invalid_path" };
  const retPct = round((end - start) / start * 100, 6);
  const high = num(path && path.high, end);
  const low = num(path && path.low, end);
  const atrPct = num(path && path.atr_pct, 1);
  const thr = noiseThresholdPct({
    atrPct,
    intervalMs: num(path && path.interval_ms, 3600000),
    horizonMs: num(path && path.horizon_ms, num((PREDICTOR_HORIZONS[r.horizon] || {}).intervalMs, 3600000))
  });
  const actualDirection = classifyOutcome({ retPct, thresholdPct: thr });
  const realizedVol = start > 0 ? round((high - low) / start * 100, 6) : null;
  const probs = r.probabilities || {};
  const predictedClass = num(probs.bullish) >= num(probs.bearish) && num(probs.bullish) >= num(probs.neutral)
    ? "Bullish"
    : num(probs.bearish) >= num(probs.neutral) ? "Bearish" : "Neutral";
  const brier = round(
    Math.pow(num(probs.bullish) - (actualDirection === "Bullish" ? 1 : 0), 2)
    + Math.pow(num(probs.neutral) - (actualDirection === "Neutral" ? 1 : 0), 2)
    + Math.pow(num(probs.bearish) - (actualDirection === "Bearish" ? 1 : 0), 2),
    6
  );
  return {
    ok: true,
    record: {
      ...r,
      resolved: true,
      resolved_at: num(path && path.now, Date.now()),
      actual_direction: actualDirection,
      actual_return_pct: retPct,
      actual_volatility_pct: realizedVol,
      noise_threshold_pct: thr,
      predicted_class: predictedClass,
      correct: predictedClass === actualDirection,
      brier_score: brier,
      calibration_target: actualDirection
    }
  };
}

// 生成校准样本(只取已结算的)
export function calibrationSamples(records) {
  const out = [];
  for (const r of records || []) {
    if (!r || !r.resolved) continue;
    const probs = r.probabilities || {};
    const cls = num(probs.bullish) >= num(probs.bearish) && num(probs.bullish) >= num(probs.neutral) ? "Bullish" : num(probs.bearish) >= num(probs.neutral) ? "Bearish" : "Neutral";
    const p = cls === "Bullish" ? probs.bullish : cls === "Bearish" ? probs.bearish : probs.neutral;
    out.push({ horizon: r.horizon, probability: num(p, 0), expected_class: cls, actual: r.actual_direction });
  }
  return out;
}

// ---- §27:预测器也要 Champion/Challenger,不能训完就上线 ----
export const PREDICTOR_PROMOTION_RULES = {
  min_validation_samples: 200,
  min_folds: 3,
  min_brier_improve: 0.002,
  max_brier_drop: 0,
  min_direction_accuracy: 0.42,
  max_accuracy_drop: 0.02,
  max_calibration_gap: 0.12,
  max_regime_accuracy_drop: 0.05,
  min_stability: 0.6
};

export function evaluatePredictorPromotion(input) {
  const i = input || {};
  const R = { ...PREDICTOR_PROMOTION_RULES, ...(i.rules || {}) };
  const c = i.challenger || {};
  const ch = i.champion || {};
  const reasons = [];
  const fail = (m) => reasons.push(m);
  const pass = (m) => reasons.push("通过:" + m);

  const samples = num(c.validation_samples, 0);
  const folds = num(c.folds, 0);
  if (samples < R.min_validation_samples) fail("验证样本不足(" + samples + " < " + R.min_validation_samples + ")");
  if (folds < R.min_folds) fail("Walk Forward Fold 数不足(" + folds + " < " + R.min_folds + ")");
  const acc = num(c.direction_accuracy, 0);
  if (acc < R.min_direction_accuracy) fail("方向准确率过低(" + acc + " < " + R.min_direction_accuracy + ")");
  const brier = numOrNull(c.brier);
  const champBrier = numOrNull(ch.brier);
  if (brier != null && champBrier != null) {
    const improve = champBrier - brier;
    if (improve < R.min_brier_improve) fail("Brier 未改善(" + round(improve, 6) + " < " + R.min_brier_improve + ")");
    else pass("Brier 改善 " + round(improve, 6));
  } else {
    fail("缺少 Brier 对照(需要 champion 与 challenger 都有)");
  }
  const accDrop = num(ch.direction_accuracy, 0) - acc;
  if (accDrop > R.max_accuracy_drop) fail("方向准确率相比 Champion 下降 " + round(accDrop, 4));
  const calGap = Math.abs(num(c.calibration_gap, 1));
  if (calGap > R.max_calibration_gap) fail("Calibration Gap 过大(" + calGap + ")");
  else pass("Calibration Gap " + round(calGap, 4) + " 在阈值内");
  const stability = num(c.stability, 0);
  if (stability < R.min_stability) fail("稳定性不足(" + stability + " < " + R.min_stability + ")");
  else pass("稳定性 " + stability);
  const holdout = c.recent_holdout || {};
  if (holdout.samples != null && num(holdout.samples) < 30) fail("Recent Holdout 样本不足");
  const regimes = c.per_regime || {};
  const champRegimes = ch.per_regime || {};
  for (const key of Object.keys(regimes)) {
    const cr = regimes[key];
    if (!cr || num(cr.samples, 0) < 30) continue;
    const hr = champRegimes[key];
    if (hr && num(hr.samples, 0) >= 30) {
      const drop = num(hr.direction_accuracy, 0) - num(cr.direction_accuracy, 0);
      if (drop > R.max_regime_accuracy_drop) fail("Regime " + key + " 明显恶化(下降 " + round(drop, 4) + ")");
    }
  }
  const promote = reasons.every((r) => r.startsWith("通过"));
  return {
    promote,
    verdict: promote ? "PROMOTE" : "KEEP_TESTING",
    reasons,
    challenger_version: c.version || null,
    champion_version: ch.version || null,
    rules: R
  };
}

// §24/§25/§28:预测参与 Entry 判定,但只是一项证据 —— 绝不允许"预测偏多就开仓"
// 返回 allow=false 仅在"预测与规则方向明显对立"时,且必须给出可追溯理由
export const PREDICTOR_GATE = { oppose_probability: 0.5, extreme_uncertainty: 0.85, min_confidence: 0.35 };

export function predictorGate(input) {
  const i = input || {};
  // 兼容两种输入:单条预测,或 predictMultiHorizon() 的包装(按 horizon 取用)
  const horizon = i.horizon || "1h";
  const p = i.prediction && i.prediction.predictions
    ? (i.prediction.predictions[horizon] || i.prediction.predictions["1h"] || null)
    : (i.prediction || null);
  const direction = String(i.direction || "Neutral");
  const rules = { ...PREDICTOR_GATE, ...(i.rules || {}) };
  if (!p || p.bullish_probability == null) {
    return { allow: true, reason: "no_prediction", penalty: 0, note: "无预测时不拦(NOT a blocker)" };
  }
  const bullSign = /Bullish/.test(direction) ? 1 : /Bearish/.test(direction) ? -1 : 0;
  const bull = num(p.bullish_probability, 0);
  const bear = num(p.bearish_probability, 0);
  const confidence = num(p.confidence, 0);
  const uncertainty = num(p.uncertainty, 0);
  const reversal = num(p.reversal_risk, 0);
  const predictionSign = bull > bear ? 1 : bear > bull ? -1 : 0;
  const opposeProbability = bullSign > 0 ? bear : bullSign < 0 ? bull : 0;

  // 不确定极高 → 减小仓位(不否决):预测"看不清"时不该重仓
  if (uncertainty >= rules.extreme_uncertainty) {
    return { allow: true, reason: "prediction_uncertain", penalty: 0.5, note: "预测不确定性极高(" + round(uncertainty, 3) + "),按减半风险参与" };
  }
  // 方向明显对立 → 冲突(§25 不能忽略)
  if (bullSign !== 0 && predictionSign !== 0 && predictionSign !== bullSign && opposeProbability >= rules.oppose_probability && confidence >= rules.min_confidence) {
    return {
      allow: false,
      reason: "predictor_conflict",
      penalty: 1,
      detail: { rule_direction: direction, prediction: p.horizon || p.horizon === undefined ? (p.horizon || "?") : "?", bullish: round(bull, 3), bearish: round(bear, 3), confidence: round(confidence, 3) },
      note: "规则与未来预测明显对立,宁可不交易"
    };
  }
  // 反转风险高 → 减仓参与,不否决
  if (reversal >= 0.7) return { allow: true, reason: "high_reversal_risk", penalty: 0.35, note: "反转风险高(" + round(reversal, 3) + "),降低风险参与" };
  return { allow: true, reason: "ok", penalty: 0, note: "预测方向与规则一致或未明显对立" };
}

// §29:Entry/Exit 的预测快照(用于后续学习与校准)
export function predictionSnapshot(multi, meta) {
  const m = multi || {};
  const mt = meta || {};
  const table = m.predictions || m || {};
  const horizon = mt.horizon || "1h";
  const p = table[horizon] || table["1h"] || null;
  if (!p) return null;
  return {
    horizon,
    bullish_probability: num(p.bullish_probability, null),
    neutral_probability: num(p.neutral_probability, null),
    bearish_probability: num(p.bearish_probability, null),
    expected_move_pct: num(p.expected_move_pct, null),
    expected_range_pct: num(p.expected_range_pct, null),
    reversal_risk: num(p.reversal_risk, null),
    confidence: num(p.confidence, null),
    uncertainty: num(p.uncertainty, null),
    model_version: p.model_version || PREDICTOR_VERSION,
    taken_at: num(mt.now, Date.now()),
    reason: mt.reason || null
  };
}

// 方向准确率 / 校准缺口 / 稳定性(供 Champion 评估输入)
export function summarizePredictions(records) {
  const list = (records || []).filter((r) => r && r.resolved);
  if (!list.length) return { samples: 0, direction_accuracy: null, brier: null, calibration_gap: null, stability: null };
  const correct = list.filter((r) => r.correct).length;
  const brier = round(list.reduce((a, b) => a + num(b.brier_score, 0), 0) / list.length, 6);
  const byHorizon = {};
  for (const r of list) {
    const h = r.horizon || "?";
    if (!byHorizon[h]) byHorizon[h] = { n: 0, correct: 0 };
    byHorizon[h].n += 1;
    if (r.correct) byHorizon[h].correct += 1;
  }
  const accs = Object.values(byHorizon).map((v) => v.correct / v.n);
  const mean = accs.reduce((a, b) => a + b, 0) / accs.length;
  const variance = accs.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / accs.length;
  const samples = calibrationSamples(list);
  const table = buildCalibrationTable(samples);
  let gapSum = 0;
  let gapN = 0;
  for (const key of Object.keys(table.buckets)) {
    const b = table.buckets[key];
    if (!b.reliable || b.realized == null || b.avg_predicted == null) continue;
    gapSum += Math.abs(b.avg_predicted - b.realized);
    gapN += 1;
  }
  return {
    samples: list.length,
    direction_accuracy: round(correct / list.length, 4),
    brier,
    calibration_gap: gapN ? round(gapSum / gapN, 4) : null,
    stability: round(clamp(1 - Math.sqrt(variance) * 4, 0, 1), 4),
    per_horizon: byHorizon,
    per_regime: {}
  };
}
