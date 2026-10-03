// paper/modelScheduler.js · V16 §13 模型调度器(纯函数,无 I/O)
// 目的:多个模型不等于多份证据。三个模型读同一批特征、给出几乎一样的预测,
//       只是"同一个想法算了三遍",不能当成三重确认。
// 本模块做两件事:1) 按市场状态(regime)给不同模型分配基础权重;
//                 2) 识别"伪共识"——把高度重叠/高度相关的模型并成一组,先组内平均再加权,
//                    并把"独立证据数"如实上报(independent_count)。
export const META_SCHEDULER_VERSION = "meta-scheduler-v1.0";

export const MODEL_KINDS = ["RULE", "LOGREG", "LIGHTGBM", "XGBOOST", "RF", "KRONOS", "TREND", "FLOW", "DERIVATIVE"];

export const MODEL_ZH = {
  RULE: "规则引擎",
  LOGREG: "逻辑回归",
  LIGHTGBM: "LightGBM 梯度提升",
  XGBOOST: "XGBoost 梯度提升",
  RF: "随机森林",
  KRONOS: "Kronos 时序模型",
  TREND: "趋势跟踪",
  FLOW: "资金流模型",
  DERIVATIVE: "衍生品情绪模型"
};

export const META_REGIMES = ["TREND_UP", "TREND_DOWN", "RANGE", "HIGH_VOL", "UNKNOWN"];

export const META_REGIME_ZH = {
  TREND_UP: "上涨趋势",
  TREND_DOWN: "下跌趋势",
  RANGE: "区间震荡",
  HIGH_VOL: "高波动",
  UNKNOWN: "未知环境"
};

// 不同 regime 下的基础权重:趋势行情抬趋势类模型,震荡抬均值回归(LOGREG),
// 高波动抬随机森林/时序(更抗噪),衍生品异常场景由 signals 再额外抬高 DERIVATIVE。
export const REGIME_MODEL_WEIGHTS = {
  TREND_UP: { RULE: 0.6, LOGREG: 0.5, LIGHTGBM: 1.3, XGBOOST: 1.1, RF: 1.0, KRONOS: 0.9, TREND: 1.5, FLOW: 0.8, DERIVATIVE: 0.7 },
  TREND_DOWN: { RULE: 0.6, LOGREG: 0.5, LIGHTGBM: 1.3, XGBOOST: 1.1, RF: 1.0, KRONOS: 0.9, TREND: 1.5, FLOW: 0.8, DERIVATIVE: 0.7 },
  RANGE: { RULE: 0.7, LOGREG: 1.3, LIGHTGBM: 0.9, XGBOOST: 0.8, RF: 1.0, KRONOS: 1.0, TREND: 0.6, FLOW: 0.8, DERIVATIVE: 0.8 },
  HIGH_VOL: { RULE: 0.6, LOGREG: 1.0, LIGHTGBM: 0.9, XGBOOST: 0.9, RF: 1.1, KRONOS: 1.2, TREND: 0.8, FLOW: 1.1, DERIVATIVE: 1.2 },
  UNKNOWN: { RULE: 1.0, LOGREG: 1.0, LIGHTGBM: 1.0, XGBOOST: 1.0, RF: 1.0, KRONOS: 1.0, TREND: 1.0, FLOW: 1.0, DERIVATIVE: 1.0 }
};

export const META_OVERLAP_THRESHOLD = 0.8;   // 特征 Jaccard ≥ 0.8 → 同一想法
export const META_PRED_CORR_THRESHOLD = 0.9; // 预测相关 ≥ 0.9 → 同一想法

// ---- 私有数学工具(本模块自带,不 import 其它模块) ----
function metaNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function metaClamp01(v) {
  const n = metaNum(v);
  if (n == null) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
function metaMean(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  let s = 0;
  for (const v of arr) {
    const n = metaNum(v);
    if (n == null) return 0;
    s += n;
  }
  return s / arr.length;
}
// 总体标准差(不是样本标准差):这里只是描述"模型之间分歧有多大"
function metaStdev(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return 0;
  const m = metaMean(arr);
  let s = 0;
  for (const v of arr) {
    const n = metaNum(v);
    if (n == null) return 0;
    s += (n - m) * (n - m);
  }
  return Math.sqrt(s / arr.length);
}
function metaPearson(xs, ys) {
  const n = Math.min(Array.isArray(xs) ? xs.length : 0, Array.isArray(ys) ? ys.length : 0);
  if (n < 2) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i += 1) {
    if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) return null;
    sx += xs[i]; sy += ys[i];
  }
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (!(sxx > 0) || !(syy > 0)) return null;
  const r = sxy / Math.sqrt(sxx * syy);
  if (!Number.isFinite(r)) return null;
  return Math.max(-1, Math.min(1, r));
}
function metaModelFeatures(m) {
  if (Array.isArray(m)) return m.filter((x) => typeof x === "string");
  if (m && typeof m === "object" && Array.isArray(m.features)) return m.features.filter((x) => typeof x === "string");
  return [];
}
function metaAvail(models) {
  return (Array.isArray(models) ? models : []).filter((m) => m && typeof m === "object" && m.kind && m.available !== false);
}

// 特征重叠度:Jaccard。任一侧无特征 → 0(没有证据说明它们共享逻辑)
export function featureOverlap(modelA, modelB) {
  const fa = metaModelFeatures(modelA);
  const fb = metaModelFeatures(modelB);
  if (!fa.length || !fb.length) return 0;
  const sa = new Set(fa);
  const sb = new Set(fb);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union > 0 ? inter / union : 0;
}

// 两组预测序列的相关性;长度不等 / 不足 / 零方差 → null
export function predictionCorrelation(historyA, historyB) {
  const a = Array.isArray(historyA) ? historyA.map((v) => metaNum(v)) : [];
  const b = Array.isArray(historyB) ? historyB.map((v) => metaNum(v)) : [];
  if (a.length !== b.length) return null;
  if (a.some((v) => v == null) || b.some((v) => v == null)) return null;
  return metaPearson(a, b);
}

// 伪共识检测:特征重叠 ≥ 阈值 或 预测相关 ≥ 阈值 的模型并成一组
export function detectFakeConsensus(models, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const overlapThr = metaNum(o.overlap_threshold) != null ? Number(o.overlap_threshold) : META_OVERLAP_THRESHOLD;
  const corrThr = metaNum(o.corr_threshold) != null ? Number(o.corr_threshold) : META_PRED_CORR_THRESHOLD;
  const list = metaAvail(models);
  const n = list.length;
  const parent = list.map((_, i) => i);
  const find = (i) => { let x = i; while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const unite = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };

  let overlapLinked = false;
  let corrLinked = false;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const ov = featureOverlap(list[i], list[j]);
      if (ov >= overlapThr) { unite(i, j); overlapLinked = true; continue; }
      const c = predictionCorrelation(list[i].history, list[j].history);
      if (c != null && Math.abs(c) >= corrThr) { unite(i, j); corrLinked = true; }
    }
  }
  const buckets = new Map();
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    if (!buckets.has(root)) buckets.set(root, []);
    buckets.get(root).push(list[i].kind);
  }
  const groups = Array.from(buckets.values());
  const fake = groups.some((g) => g.length >= 2);
  let reason_zh = "各模型相互独立,没有发现伪共识";
  if (fake) {
    if (overlapLinked && corrLinked) reason_zh = "存在特征高度重叠且预测高度相关的模型组:同一个想法被算了多遍,已按组去重";
    else if (overlapLinked) reason_zh = "存在特征高度重叠的模型组:同一个想法被算了多遍,已按组去重";
    else reason_zh = "存在预测高度相关的模型组:同一个想法被算了多遍,已按组去重";
  }
  return { fake, groups, independent_count: groups.length, available_count: n, reason_zh };
}

// 按 regime + 异常信号 给模型排权重
export function metaSchedule(input) {
  const ctx = input && typeof input === "object" ? input : {};
  const regime = META_REGIMES.indexOf(ctx.regime) >= 0 ? ctx.regime : "UNKNOWN";
  const base = REGIME_MODEL_WEIGHTS[regime];
  const models = Array.isArray(ctx.models) ? ctx.models : [];
  const signals = ctx.signals && typeof ctx.signals === "object" ? ctx.signals : {};
  const notes = [];
  const weights = {};

  for (const kind of MODEL_KINDS) {
    const m = models.find((x) => x && x.kind === kind);
    if (!m) { weights[kind] = 0; continue; }
    if (m.available === false) { weights[kind] = 0; notes.push(MODEL_ZH[kind] + "不可用,权重置零(不参与合成)"); continue; }
    weights[kind] = metaNum(base[kind]) != null ? Number(base[kind]) : 1;
  }

  // 衍生品异常:资金费/持仓量异常时,衍生品情绪模型的话语权应更高
  if ((signals.funding_anomaly === true || signals.oi_anomaly === true) && weights.DERIVATIVE > 0) {
    weights.DERIVATIVE *= 1.35;
    notes.push("资金费/持仓量异常,抬高衍生品情绪模型权重");
  }
  if (signals.flow_anomaly === true && weights.FLOW > 0) {
    weights.FLOW *= 1.25;
    notes.push("资金流异常,抬高资金流模型权重");
  }
  if (regime === "TREND_UP" || regime === "TREND_DOWN") {
    notes.push(META_REGIME_ZH[regime] + ":抬高趋势跟踪与梯度提升模型");
  } else if (regime === "RANGE") {
    notes.push("区间震荡:抬高均值回归类模型(逻辑回归)");
  }

  const total = MODEL_KINDS.reduce((a, k) => a + weights[k], 0);
  const normalized = {};
  for (const kind of MODEL_KINDS) normalized[kind] = total > 0 ? weights[kind] / total : 0;
  if (total <= 0) notes.push("没有任何可用模型,无法给出调度权重");

  const consensus = detectFakeConsensus(models);
  if (consensus.fake) notes.push(consensus.reason_zh);

  return {
    weights,
    normalized,
    notes,
    regime,
    independent_count: consensus.independent_count,
    fake_consensus: consensus.fake
  };
}

// 合成预测:不是简单投票——先把伪共识组内平均(避免同一想法被多算),再按权重加权
export function combineModels(models, weights) {
  const w = weights && typeof weights === "object" ? weights : {};
  const list = metaAvail(models);
  if (list.length === 0) {
    return { bull: 0, neutral: 1, bear: 0, contributors: [], independent_count: 0, dispersion: 0, weights_used: {} };
  }
  const consensus = detectFakeConsensus(list);
  const groupOfKind = new Map();
  for (const g of consensus.groups) for (const k of g) groupOfKind.set(k, g);

  const modelBulls = list.map((m) => metaClamp01(m.bull));
  const groups = new Map();
  list.forEach((m, i) => {
    const key = groupOfKind.get(m.kind);
    if (!groups.has(key)) groups.set(key, { kinds: [], bull: [], bear: [], w: [] });
    const g = groups.get(key);
    g.kinds.push(m.kind);
    g.bull.push(metaClamp01(m.bull));
    g.bear.push(metaClamp01(m.bear));
    g.w.push(metaNum(w[m.kind]) != null ? Number(w[m.kind]) : 0);
  });
  const gl = Array.from(groups.values());
  const groupW = gl.map((g) => metaMean(g.w));
  const groupBull = gl.map((g) => metaMean(g.bull));
  const groupBear = gl.map((g) => metaMean(g.bear));
  const totalW = groupW.reduce((a, b) => a + b, 0);

  let bull = 0, bear = 0;
  const weights_used = {};
  if (totalW > 0) {
    gl.forEach((g, i) => {
      const share = groupW[i] / totalW;         // 组权重用组员均值:三胞胎不会拿到三倍话语权
      bull += share * groupBull[i];
      bear += share * groupBear[i];
      g.kinds.forEach((k) => { weights_used[k] = share / g.kinds.length; });
    });
  } else {
    // 没有任何权重信息时退化为"每组等权",仍然先组内平均
    gl.forEach((g) => {
      bull += groupBull[gl.indexOf(g)] / gl.length;
      bear += groupBear[gl.indexOf(g)] / gl.length;
      g.kinds.forEach((k) => { weights_used[k] = 1 / gl.length / g.kinds.length; });
    });
  }
  bull = metaClamp01(bull);
  bear = metaClamp01(bear);
  if (bull + bear > 1) {
    const s = bull + bear;
    bull /= s;
    bear /= s;
  }
  const neutral = metaClamp01(1 - bull - bear);
  const dispersion = list.length >= 2 ? metaStdev(modelBulls) : 0;

  return {
    bull,
    neutral,
    bear,
    contributors: list.map((m) => m.kind),
    independent_count: gl.length,
    dispersion,
    weights_used
  };
}

// 调度结果中文视图
export function metaView(result) {
  const r = result && typeof result === "object" ? result : {};
  const weights = r.weights && typeof r.weights === "object" ? r.weights : {};
  const normalized = r.normalized && typeof r.normalized === "object" ? r.normalized : {};
  const rows = MODEL_KINDS.filter((k) => metaNum(weights[k]) != null).map((k) => ({
    kind: k,
    zh: MODEL_ZH[k] || k,
    weight: metaNum(weights[k]) != null ? Number(weights[k]) : 0,
    normalized_pct: Math.round((metaNum(normalized[k]) != null ? Number(normalized[k]) : 0) * 1000) / 10,
    available: (metaNum(weights[k]) != null ? Number(weights[k]) : 0) > 0
  }));
  const regime = r.regime && META_REGIME_ZH[r.regime] ? r.regime : "UNKNOWN";
  const availableCount = rows.filter((x) => x.available).length;
  const fake = r.fake_consensus === true;
  const independent = metaNum(r.independent_count) != null ? Number(r.independent_count) : 0;
  const summary_zh = "按" + META_REGIME_ZH[regime] + "调度 " + availableCount + " 个可用模型;"
    + "独立证据 " + independent + " 组" + (fake ? "(已合并伪共识)" : "(无伪共识)");
  return {
    regime,
    regime_zh: META_REGIME_ZH[regime],
    rows,
    independent_count: independent,
    fake_consensus: fake,
    fake_consensus_zh: fake ? "存在伪共识(同一想法算多遍)" : "模型相互独立",
    summary_zh,
    notes_zh: Array.isArray(r.notes) ? r.notes : []
  };
}
