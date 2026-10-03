// paper/mlRuntime.js · V14.3 ML Runtime(真实推理)
// 目标:不再让 ML 长期缺位(ml:null)。做法:
//   1) LogisticRegression 工件(logreg-json)在 JS 端直接推理:softmax((X-mean)/scale · coefᵀ + intercept)
//      —— 与 tools/ml/ml_core.py 的 ReloadedModel.predict_proba 完全同构(同一份系数、同一套编码)
//   2) 工件来源是 Champion(模型注册表 + 工件表),缺失/损坏时回退 Rule+Bull/Bear+Risk(回退也是真实计算,不是 null)
//   3) 原子热替换:加载 → 校验(含一次冒烟推理)→ 单次赋值替换;失败继续用旧模型,无需重启
import { num, round } from "./accounting.js";
import { signalRecordFromAnalysis } from "../history/record.js";
import { datasetRow } from "../history/dataset.js";

export const ML_RUNTIME_VERSION = "ml-runtime-v14.3";
export const ML_FALLBACK_SOURCE = "rule+bull/bear+risk";
// 与 ml_core.py 的 LABELS 顺序一致(0=Bearish,1=Neutral,2=Bullish)
export const LR_LABELS = ["Bearish", "Neutral", "Bullish"];
export const SUPPORTED_ML_FORMATS = ["logreg-json"];

// ---- 数值核心 ----
export function softmax(scores) {
  const z = (scores || []).map((v) => num(v, 0));
  if (!z.length) return [];
  const max = Math.max(...z);
  const exps = z.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  if (!(sum > 0) || !Number.isFinite(sum)) return z.map(() => 1 / z.length);
  return exps.map((v) => v / sum);
}

// 严格校验:必须是真数字且有限。null / undefined / 字符串一律拒绝 ——
// 因为 JSON 里的 null 会被 Number() 悄悄转成 0,这正是"损坏工件看起来可用"的来源
function finiteArray(arr, length) {
  if (!Array.isArray(arr) || arr.length !== length) return false;
  return arr.every((v) => typeof v === "number" && Number.isFinite(v));
}

// 按 encoder 把一行数据编码成模型输入(中位数填充 + One-Hot;与训练期 encoder 完全一致)
export function encodeFeatures(row, encoder) {
  const enc = encoder || {};
  const numericCols = enc.numeric_cols || [];
  const categoricalCols = enc.categorical_cols || [];
  const levels = enc.categorical_levels || {};
  const medians = enc.numeric_medians || {};
  const out = [];
  for (const col of numericCols) {
    const raw = row ? row[col] : null;
    const v = raw == null || raw === "" ? NaN : Number(raw);
    out.push(Number.isFinite(v) ? v : num(medians[col], 0));
  }
  for (const col of categoricalCols) {
    const value = row && row[col] != null ? String(row[col]) : null;
    for (const lvl of (levels[col] || [])) out.push(value === lvl ? 1 : 0);
  }
  return out;
}

// z_j = Σ_i ((x_i - mean_i) / scale_i) · coef_j,i + intercept_j
export function linearScores(x, coef, intercept, mean, scale) {
  const n = x.length;
  const rows = coef || [];
  return rows.map((coefRow, j) => {
    let z = num(intercept && intercept[j], 0);
    for (let i = 0; i < n; i += 1) {
      const s = num(scale && scale[i], 1);
      const scaled = (num(x[i], 0) - num(mean && mean[i], 0)) / (s === 0 ? 1 : s);
      z += scaled * num(coefRow[i], 0);
    }
    return z;
  });
}

// 按标签读取概率(fusion 只关心 bull/bear 的差值)
export function labelProbability(probabilities, label) {
  const idx = LR_LABELS.indexOf(label);
  if (idx < 0) return null;
  return num(probabilities && probabilities[idx], null);
}

// ---- 工件校验(能否真实推理 = 唯一标准) ----
export function validateArtifact(artifact) {
  const checks = {};
  const fail = (reason) => ({ ok: false, reason, checks });
  if (!artifact || typeof artifact !== "object") return fail("artifact_missing");
  checks.format = String(artifact.format || "");
  if (!SUPPORTED_ML_FORMATS.includes(artifact.format)) return fail("unsupported_format:" + (artifact.format || "none"));
  const enc = artifact.encoder;
  if (!enc || !Array.isArray(enc.columns) || !enc.columns.length) return fail("encoder_missing");
  if (!Array.isArray(enc.numeric_cols) || !Array.isArray(enc.categorical_cols)) return fail("encoder_columns_invalid");
  checks.feature_count = enc.columns.length;
  checks.numeric_count = enc.numeric_cols.length;
  checks.categorical_count = enc.categorical_cols.length;
  const k = Array.isArray(artifact.coef) ? artifact.coef.length : 0;
  if (!k) return fail("coef_missing");
  checks.classes = k;
  if (!Array.isArray(artifact.intercept) || artifact.intercept.length !== k) return fail("intercept_length_mismatch");
  for (let j = 0; j < k; j += 1) {
    if (!finiteArray(artifact.coef[j], checks.feature_count)) return fail("coef_shape_mismatch:" + j);
  }
  if (!finiteArray(artifact.intercept, k)) return fail("intercept_not_finite");
  if (!finiteArray(artifact.scaler_mean, checks.feature_count)) return fail("scaler_mean_mismatch");
  if (!finiteArray(artifact.scaler_scale, checks.feature_count)) return fail("scaler_scale_mismatch");
  if (artifact.scaler_scale.some((v) => Number(v) === 0)) checks.scaler_zero_scale = true; // 除以 0 已按 1 处理
  const classes = Array.isArray(artifact.classes) ? artifact.classes : [];
  checks.classes_declared = classes.length ? classes.join(",") : LR_LABELS.slice(0, k).join(",");
  // 冒烟推理:中位数/零向量也要给出有限概率分布,否则视为不可用
  const smoke = predictLogreg(artifact, {});
  if (!smoke.ok) return fail("smoke_failed:" + smoke.reason);
  checks.smoke_sum_deviation = round(Math.abs(smoke.probabilities.reduce((a, b) => a + b, 0) - 1), 8);
  if (checks.smoke_sum_deviation > 1e-6) return fail("smoke_not_normalized");
  return { ok: true, reason: "ok", checks };
}

// ---- 单次推理 ----
export function predictLogreg(artifact, row) {
  const a = artifact || {};
  if (a.format !== "logreg-json") return { ok: false, reason: "unsupported_format" };
  if (!a.encoder || !Array.isArray(a.coef) || !Array.isArray(a.intercept)) return { ok: false, reason: "artifact_incomplete" };
  const x = encodeFeatures(row, a.encoder);
  if (!x.length) return { ok: false, reason: "feature_vector_empty" };
  const coefRows = a.coef;
  if (!coefRows.length || !coefRows.every((r) => Array.isArray(r) && r.length === x.length)) return { ok: false, reason: "coef_shape_mismatch" };
  if (a.intercept.length !== coefRows.length) return { ok: false, reason: "intercept_length_mismatch" };
  const z = linearScores(x, coefRows, a.intercept, a.scaler_mean, a.scaler_scale);
  const p = softmax(z);
  if (!p.length || p.some((v) => !Number.isFinite(v))) return { ok: false, reason: "non_finite_probability" };
  const k = p.length;
  const labels = Array.isArray(a.classes) && a.classes.length === k
    ? a.classes.map((c) => LR_LABELS[num(c, 1)] || String(c))
    : LR_LABELS.slice(0, k);
  const byLabel = {};
  labels.forEach((label, i) => { byLabel[label] = p[i]; });
  let best = 0;
  for (let i = 1; i < k; i += 1) if (p[i] > p[best]) best = i;
  return {
    ok: true,
    probabilities: p,
    label: labels[best],
    confidence: round(p[best] * 100, 4),
    bearish: num(byLabel.Bearish, null),
    neutral: num(byLabel.Neutral, null),
    bullish: num(byLabel.Bullish, null)
  };
}

// 分析结果 → 训练期同构的一行(复用 signalRecordFromAnalysis + datasetRow,避免两套映射漂移)
export function runtimeRowFromAnalysis(analysis, options) {
  const opts = options || {};
  const rec = signalRecordFromAnalysis(analysis || {}, opts.recordOptions || {});
  return datasetRow({ signal: rec, outcome: null }, { horizons: opts.horizons || [] });
}

// ---- 回退预测:Rule + Bull/Bear + Risk(真实计算,不是 null) ----
export function fallbackPrediction(input) {
  const i = input || {};
  const rule = num(i.rule_score, 0);
  const bull = i.bull_score == null ? null : num(i.bull_score, null);
  const bear = i.bear_score == null ? null : num(i.bear_score, null);
  const risk = num(i.risk_score, 50);
  const evidenceNet = bull == null || bear == null ? null : (bull - bear);
  const parts = evidenceNet == null ? [rule] : [rule, evidenceNet];
  let net = parts.reduce((a, b) => a + b, 0) / parts.length;
  // 风险只压幅度、不翻方向:风险越高越向中性收敛
  const dampen = 1 - Math.max(0, Math.min(100, risk)) / 100 * 0.5;
  net = Math.max(-1, Math.min(1, net * dampen));
  const sharpness = 2.2;
  const p = softmax([-net * sharpness, 0, net * sharpness]);
  const best = p[2] >= p[0] && p[2] >= p[1] ? "Bullish" : p[0] >= p[1] ? "Bearish" : "Neutral";
  return {
    ok: true,
    source: ML_FALLBACK_SOURCE,
    fallback: true,
    probabilities: p,
    label: best,
    confidence: round(Math.max(...p) * 100, 4),
    bearish: p[0],
    neutral: p[1],
    bullish: p[2],
    inputs: { rule_score: round(rule, 4), bull_score: bull, bear_score: bear, risk_score: risk, net: round(net, 4) }
  };
}

// 统一出口:能推理就用模型,否则回退(永远返回可用的 ml 对象)
export function resolveMl(runtime, input) {
  const i = input || {};
  const fallbackInput = {
    rule_score: i.rule_score,
    bull_score: i.bull_score == null && i.evidence ? i.evidence.bull_score : i.bull_score,
    bear_score: i.bear_score == null && i.evidence ? i.evidence.bear_score : i.bear_score,
    risk_score: i.risk_score == null && i.risk ? i.risk.risk_score : i.risk_score
  };
  const row = i.row || (i.analysis ? runtimeRowFromAnalysis(i.analysis, { horizons: i.horizons || [] }) : null);
  if (runtime && row) {
    const out = runtime.predict(row);
    if (out.ok) {
      return {
        ok: true, source: out.source, fallback: false,
        model_version: out.model_version, horizon: out.horizon,
        probabilities: out.probabilities, label: out.label, confidence: out.confidence,
        bearish: out.bearish, neutral: out.neutral, bullish: out.bullish
      };
    }
    const fb = fallbackPrediction(fallbackInput);
    fb.reason = out.reason || "ml_unavailable";
    fb.model_version = null;
    return fb;
  }
  const fb = fallbackPrediction(fallbackInput);
  fb.reason = runtime ? "no_feature_row" : "no_runtime";
  fb.model_version = null;
  return fb;
}

// 转成 fusion.mlScore 认识的形状(probability_bullish / probability_bearish)
export function toFusionMl(resolved) {
  const r = resolved || {};
  if (r.bullish == null || r.bearish == null) return null;
  return {
    probability_bullish: r.bullish,
    probability_bearish: r.bearish,
    probability_neutral: r.neutral,
    label: r.label,
    confidence: r.confidence,
    source: r.source,
    fallback: Boolean(r.fallback),
    model_version: r.model_version || null
  };
}

// ---- 运行时:持有当前 Champion,支持原子热替换 ----
export function createMlRuntime(options) {
  const opts = options || {};
  let current = null;   // { artifact, version, model_type, horizon, loaded_at, checks }
  let lastError = null;
  const swaps = [];

  function status() {
    return {
      runtime_version: ML_RUNTIME_VERSION,
      loaded: Boolean(current),
      version: current ? current.version : null,
      model_type: current ? current.model_type : null,
      horizon: current ? current.horizon : null,
      loaded_at: current ? current.loaded_at : null,
      features: current ? current.artifact.encoder.columns.length : 0,
      fallback_source: ML_FALLBACK_SOURCE,
      last_error: lastError,
      swaps: swaps.length
    };
  }

  // 加载(热替换):校验通过才换;失败保留旧模型并记录原因,不抛异常、不需要重启
  function load(input) {
    const i = input || {};
    const v = validateArtifact(i.artifact);
    if (!v.ok) {
      lastError = { at: Date.now(), version: i.version || null, reason: v.reason, checks: v.checks };
      swaps.push({ at: lastError.at, ok: false, to: i.version || null, from: current ? current.version : null, reason: v.reason });
      return { ok: false, swapped: false, reason: v.reason, checks: v.checks, kept: current ? current.version : null };
    }
    const prev = current;
    current = {
      artifact: i.artifact,
      version: i.version || i.artifact.model_version || "ml-unknown",
      model_type: i.model_type || i.artifact.model_name || "logreg",
      horizon: i.horizon || i.artifact.horizon || null,
      loaded_at: Date.now(),
      checks: v.checks
    };
    lastError = null;
    swaps.push({ at: current.loaded_at, ok: true, to: current.version, from: prev ? prev.version : null, reason: "ok" });
    return { ok: true, swapped: true, from: prev ? prev.version : null, to: current.version, checks: v.checks };
  }

  function unload(reason) {
    const prev = current;
    current = null;
    if (reason) lastError = { at: Date.now(), version: prev ? prev.version : null, reason, checks: {} };
    return { ok: true, from: prev ? prev.version : null };
  }

  function predict(row) {
    if (!current) return { ok: false, reason: lastError ? lastError.reason : "no_champion" };
    const out = predictLogreg(current.artifact, row || {});
    if (!out.ok) {
      lastError = { at: Date.now(), version: current.version, reason: out.reason, checks: {} };
      return { ok: false, reason: out.reason, model_version: null };
    }
    return { ...out, source: "ml:" + current.version, model_version: current.version, horizon: current.horizon };
  }

  return {
    load, unload, predict, status,
    swapLog: () => swaps.slice(),
    currentVersion: () => (current ? current.version : null),
    hasModel: () => Boolean(current)
  };
}

// ---- 工件表读写(store 注入,便于测试与将来云端同步) ----
export const ML_ARTIFACT_TABLE = "model_artifacts";

export async function saveArtifact(store, artifact, meta) {
  const m = meta || {};
  const version = m.version || artifact.model_version || "ml-unknown";
  const key = m.model_type ? m.model_type + ":" + version : version;
  const rec = {
    artifact_id: key,
    model_type: m.model_type || artifact.model_name || "logreg",
    version,
    horizon: m.horizon || artifact.horizon || null,
    format: artifact.format || null,
    payload: JSON.stringify(artifact),
    created_at: num(m.now, Date.now())
  };
  await store.put(ML_ARTIFACT_TABLE, rec);
  return rec;
}

export async function loadArtifact(store, modelType, version) {
  const all = (await store.all(ML_ARTIFACT_TABLE, 200)) || [];
  const hit = all.find((r) => r.version === version && (!modelType || r.model_type === modelType))
    || all.filter((r) => !modelType || r.model_type === modelType).sort((a, b) => num(b.created_at) - num(a.created_at))[0];
  if (!hit) return { ok: false, reason: "artifact_not_found" };
  try {
    const artifact = typeof hit.payload === "string" ? JSON.parse(hit.payload) : hit.payload;
    return { ok: true, artifact, record: hit };
  } catch (error) {
    return { ok: false, reason: "artifact_corrupt", detail: String(error && error.message).slice(0, 120), record: hit };
  }
}

// 按 Champion 注册记录装载:注册表 -> 工件 -> 校验 -> 原子替换
export async function loadChampionIntoRuntime(runtime, store, options) {
  const opts = options || {};
  const champion = opts.champion || null;
  if (!champion) {
    return { ok: false, swapped: false, reason: "no_champion", kept: runtime ? runtime.currentVersion() : null };
  }
  const loaded = await loadArtifact(store, champion.model_type, champion.version);
  if (!loaded.ok) {
    if (runtime) runtime.load({ artifact: null, version: champion.version, model_type: champion.model_type });
    return { ok: false, swapped: false, reason: loaded.reason, version: champion.version, kept: runtime ? runtime.currentVersion() : null };
  }
  const res = runtime.load({
    artifact: loaded.artifact,
    version: champion.version,
    model_type: champion.model_type,
    horizon: loaded.artifact.horizon || champion.horizon || null
  });
  return { ...res, reason: res.ok ? "ok" : res.reason, version: champion.version };
}
