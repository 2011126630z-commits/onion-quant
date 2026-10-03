// paper/treeModel.js · V16.1 树模型 Shadow/Challenger 推理(纯函数 · 浏览器/Node 通用 · 无 I/O)
//
// ⚠️ 角色约束(硬性):
//   本文件实现的是 **SHADOW 模型**(TREE_MODEL_ROLE = "SHADOW")。
//   它只做**旁路对照 / Challenger**评估,**不得直接进入 Active Decision**,
//   不得覆盖或替代当前 Champion(mlRuntime 的 logreg)与 Rule Engine 的结论。
//   与浏览器端"只能做 logreg 系数推理"的既有约束一致:树模型不进浏览器主推理链路,
//   这里只提供可移植工件(JSON)的纯函数推理,供离线对拍与 Shadow 评估使用。
//
// 工件格式(rf-json,由 tools/ml/rf_core.py 导出,非 pickle):
//   {
//     format: "rf-json", format_version: 1, model_name, model_version, role, horizon, n_classes: 3,
//     label_order: ["Bearish","Neutral","Bullish"],
//     feature_names: [...],        // 顺序 = 训练矩阵列顺序(与 ml_core.Encoder.columns 一致)
//     feature_defaults: [...],     // 与 feature_names 等长;缺失特征按此填充(不静默变 0)
//     encoder: { numeric_cols, categorical_cols, categorical_levels, numeric_medians, columns },
//     trees: [ { root, n_nodes, nodes: [ {feature_index, threshold, left, right, leaf_probability, samples} ] } ],
//     training_meta: {...}
//   }
// 判据与 sklearn 完全一致:float32(feature) <= threshold(float64) → left,否则 right。
import { num } from "./accounting.js";
import { runtimeRowFromAnalysis } from "./mlRuntime.js";

export const TREE_MODEL_VERSION = "tree-model-v16.1";
export const SUPPORTED_TREE_FORMATS = ["rf-json"];
// SHADOW:仅旁路对照,禁止进入 Active Decision
export const TREE_MODEL_ROLE = "SHADOW";
export const TREE_LABELS = ["Bearish", "Neutral", "Bullish"];

const LEAF_PROB_EPS = 1e-6;

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function isInt(v) {
  return typeof v === "number" && Number.isInteger(v);
}

// ---- 校验:字段 / 维度 / 特征名顺序 / 版本 ----
export function validateTreeArtifact(obj) {
  const errors = [];
  const warn = [];
  const checks = {};
  if (!obj || typeof obj !== "object") return { ok: false, errors: ["artifact_missing"], warnings: [], checks };

  if (!SUPPORTED_TREE_FORMATS.includes(obj.format)) errors.push("unsupported_format:" + String(obj.format));
  if (String(obj.model_version || "").length === 0) errors.push("model_version_missing");
  if (obj.format_version == null || !isInt(Number(obj.format_version))) errors.push("format_version_missing");
  if (obj.role !== TREE_MODEL_ROLE) warn.push("role_not_shadow:" + String(obj.role));

  const names = obj.feature_names;
  if (!Array.isArray(names) || !names.length || !names.every((n) => typeof n === "string" && n.length)) {
    errors.push("feature_names_invalid");
  }
  const nFeatures = Array.isArray(names) ? names.length : 0;
  checks.feature_count = nFeatures;
  if (new Set(Array.isArray(names) ? names : []).size !== nFeatures) errors.push("feature_names_duplicated");

  const labels = Array.isArray(obj.label_order) ? obj.label_order : [];
  if (!["Bearish", "Neutral", "Bullish"].every((l) => labels.includes(l))) errors.push("label_order_invalid");
  const nClasses = Number(obj.n_classes || labels.length || 0);
  if (!isInt(nClasses) || nClasses < 2 || nClasses !== labels.length) errors.push("n_classes_mismatch");
  checks.classes = nClasses;

  if (obj.feature_defaults !== undefined) {
    if (!Array.isArray(obj.feature_defaults) || obj.feature_defaults.length !== nFeatures) {
      errors.push("feature_defaults_length_mismatch");
    } else if (!obj.feature_defaults.every((v) => isFiniteNumber(v))) {
      errors.push("feature_defaults_not_finite");
    }
  } else if (!obj.encoder || !Array.isArray(obj.encoder.columns)) {
    // 既没有 defaults 也没有 encoder → 缺失特征无法按语义填充
    errors.push("feature_defaults_and_encoder_missing");
  }
  if (obj.encoder && Array.isArray(obj.encoder.columns) && obj.encoder.columns.length !== nFeatures) {
    errors.push("encoder_feature_count_mismatch:" + obj.encoder.columns.length + "!=" + nFeatures);
  }

  const trees = obj.trees;
  if (!Array.isArray(trees) || !trees.length) {
    errors.push("trees_missing");
    return { ok: errors.length === 0, errors, warnings: warn, checks };
  }
  checks.tree_count = trees.length;
  let nodeTotal = 0;
  let treeErrors = 0;
  for (let ti = 0; ti < trees.length; ti += 1) {
    const tree = trees[ti];
    const nodes = tree && tree.nodes;
    if (!Array.isArray(nodes) || !nodes.length) { errors.push("tree_nodes_missing:" + ti); treeErrors += 1; continue; }
    const root = tree.root == null ? 0 : Number(tree.root);
    if (!isInt(root) || root < 0 || root >= nodes.length) { errors.push("tree_root_invalid:" + ti); treeErrors += 1; continue; }
    for (let ni = 0; ni < nodes.length; ni += 1) {
      const node = nodes[ni];
      if (!node || typeof node !== "object") { errors.push("node_invalid:" + ti + ":" + ni); treeErrors += 1; continue; }
      const leaf = node.leaf_probability;
      if (leaf != null) {
        if (!Array.isArray(leaf) || leaf.length !== nClasses || !leaf.every((v) => isFiniteNumber(v))) {
          errors.push("leaf_probability_invalid:" + ti + ":" + ni); treeErrors += 1;
        } else {
          const s = leaf.reduce((a, b) => a + b, 0);
          if (Math.abs(s - 1) > 1e-4) { errors.push("leaf_probability_not_normalized:" + ti + ":" + ni); treeErrors += 1; }
        }
      } else {
        if (!isInt(node.feature_index) || node.feature_index < 0 || node.feature_index >= nFeatures) {
          errors.push("feature_index_out_of_range:" + ti + ":" + ni); treeErrors += 1;
        }
        if (!isFiniteNumber(node.threshold)) { errors.push("threshold_not_finite:" + ti + ":" + ni); treeErrors += 1; }
        for (const side of ["left", "right"]) {
          const child = node[side];
          if (!isInt(child) || child < 0 || child >= nodes.length) { errors.push(side + "_invalid:" + ti + ":" + ni); treeErrors += 1; }
        }
      }
      nodeTotal += 1;
      if (treeErrors > 12) break; // 错误足够多,不必逐个列完
    }
    if (treeErrors > 12) break;
  }
  checks.node_count = nodeTotal;
  checks.errors_truncated = treeErrors > 12;
  if (nFeatures === 0) checks.feature_count = 0;
  return { ok: errors.length === 0, errors, warnings: warn, checks };
}

// ---- 缺失特征默认值:优先工件的 feature_defaults,其次 encoder 中位数,最后 0(仅在无工件默认值时) ----
function defaultOf(artifact, index, name) {
  const defs = artifact.feature_defaults;
  if (Array.isArray(defs) && defs.length > index && isFiniteNumber(defs[index])) return defs[index];
  const enc = artifact.encoder || {};
  const medians = enc.numeric_medians || {};
  const numeric = enc.numeric_cols || [];
  for (let i = 0; i < numeric.length; i += 1) {
    if (i === index) return num(medians[numeric[i]], 0);
  }
  // One-Hot 列:该类别不出现 → 0 是语义正确值
  return 0;
}

// 按工件顺序把一行(或已编码数组)解析成特征向量。缺失 → 用工件默认值,并记录到 imputed(不静默变 0)
function resolveFeatureVector(artifact, features) {
  const names = artifact.feature_names || [];
  const enc = artifact.encoder || {};
  const imputed = [];
  const vector = new Array(names.length).fill(null);

  if (Array.isArray(features)) {
    for (let i = 0; i < names.length; i += 1) {
      const v = features[i];
      if (isFiniteNumber(v)) {
        vector[i] = v;
      } else {
        vector[i] = defaultOf(artifact, i, names[i]);
        imputed.push(names[i]);
      }
    }
    return { vector, imputed };
  }

  const row = features || {};
  const numericCols = enc.numeric_cols || [];
  let idx = 0;
  for (const col of numericCols) {
    const raw = row[col];
    const v = raw == null || raw === "" ? NaN : Number(raw);
    if (Number.isFinite(v)) vector[idx] = v;
    else { vector[idx] = defaultOf(artifact, idx, names[idx]); imputed.push(names[idx]); }
    idx += 1;
  }
  const categoricalCols = enc.categorical_cols || [];
  const levels = enc.categorical_levels || {};
  for (const col of categoricalCols) {
    const present = row[col] != null;
    const value = present ? String(row[col]) : null;
    for (const lvl of (levels[col] || [])) {
      if (idx >= names.length) break;
      if (!present) { vector[idx] = defaultOf(artifact, idx, names[idx]); imputed.push(names[idx]); }
      else vector[idx] = value === lvl ? 1 : 0;
      idx += 1;
    }
  }
  // 剩余槽位(feature_names 比 encoder 多的异常情况)统一走默认值
  for (let i = 0; i < names.length; i += 1) {
    if (vector[i] == null) { vector[i] = defaultOf(artifact, i, names[i]); imputed.push(names[i]); }
  }
  return { vector, imputed };
}

function walkTree(tree, vector) {
  const nodes = tree.nodes;
  let i = tree.root == null ? 0 : Number(tree.root);
  for (let guard = 0; guard <= nodes.length; guard += 1) {
    const node = nodes[i];
    if (!node) return null;
    const leaf = node.leaf_probability;
    if (leaf != null) return leaf;
    const x = vector[node.feature_index];
    // 与 sklearn 一致:float32(feature) <= threshold(float64) → left
    const cast = Math.fround(isFiniteNumber(x) ? x : 0);
    const goLeft = cast <= node.threshold;
    const next = goLeft ? node.left : node.right;
    if (!isInt(next) || next < 0 || next >= nodes.length) return null;
    i = next;
  }
  return null;
}

function argmaxLabel(probabilities, labels) {
  let best = 0;
  for (let i = 1; i < probabilities.length; i += 1) if (probabilities[i] > probabilities[best]) best = i;
  return { index: best, label: labels[best] || null, probability: probabilities[best] };
}

// ---- 森林推理:每棵树走到底取叶概率,再对全森林平均 ----
export function predictForest(artifact, features) {
  const check = validateTreeArtifact(artifact);
  if (!check.ok) return { ok: false, reason: "invalid_artifact", errors: check.errors };
  const labels = artifact.label_order.slice();
  const { vector, imputed } = resolveFeatureVector(artifact, features);
  const trees = artifact.trees;
  const acc = new Array(artifact.n_classes).fill(0);
  const leafVotes = [];
  let used = 0;
  for (let ti = 0; ti < trees.length; ti += 1) {
    const leaf = walkTree(trees[ti], vector);
    if (!leaf) { leafVotes.push({ tree_index: ti, label: null, probability: null, reached_leaf: false }); continue; }
    for (let c = 0; c < acc.length; c += 1) acc[c] += num(leaf[c], 0);
    used += 1;
    const vote = argmaxLabel(leaf, labels);
    leafVotes.push({ tree_index: ti, label: vote.label, probability: Number(vote.probability.toFixed(6)), reached_leaf: true });
  }
  if (!used) return { ok: false, reason: "no_tree_reached_leaf", errors: ["all_trees_failed"] };
  const probabilities = acc.map((v) => v / used);
  // 数值兜底:浮点累加后强制归一,保证概率和严格为 1
  const sum = probabilities.reduce((a, b) => a + b, 0);
  const normalized = sum > 0 ? probabilities.map((v) => v / sum) : probabilities.map(() => 1 / probabilities.length);
  const byLabel = {};
  labels.forEach((label, i) => { byLabel[label] = normalized[i]; });
  const top = argmaxLabel(normalized, labels);
  return {
    ok: true,
    probabilities: normalized,
    label: top.label,
    confidence: Number(top.probability.toFixed(6)),
    probability_bear: byLabel.Bearish == null ? null : byLabel.Bearish,
    probability_bull: byLabel.Bullish == null ? null : byLabel.Bullish,
    probability_neutral: byLabel.Neutral == null ? null : byLabel.Neutral,
    neutral: byLabel.Neutral == null ? null : byLabel.Neutral,
    leaf_votes: leafVotes,
    tree_count: trees.length,
    trees_used: used,
    feature_count: vector.length,
    imputed,
    missing_features: imputed.slice(),
    model_version: artifact.model_version || null,
    horizon: artifact.horizon || null,
    role: TREE_MODEL_ROLE
  };
}

// ---- 与 mlRuntime.runtimeRowFromAnalysis 同口径的特征行(复用同一函数,避免两套映射漂移) ----
export function treeRowFromAnalysis(analysis, extra) {
  const row = runtimeRowFromAnalysis(analysis || {}, extra || {});
  return row;
}

// ---- 统一出口:没有可用工件时明确"不可用",禁止假装有模型 ----
export function resolveTreeModel(input) {
  const i = input || {};
  const base = {
    role: TREE_MODEL_ROLE,
    model_version: null,
    horizon: null,
    probability_bear: null,
    probability_neutral: null,
    probability_bull: null,
    probabilities: null,
    label: null,
    confidence: null,
    uncertainty: null,
    available: false
  };
  const check = validateTreeArtifact(i.artifact);
  if (!check.ok) {
    return { ...base, source: "FALLBACK", reason: i.artifact ? "invalid_artifact" : "no_tree_artifact", errors: check.errors };
  }
  let row = i.row || null;
  if (!row && i.analysis) row = treeRowFromAnalysis(i.analysis, i.extra || { horizons: i.horizons || [] });
  if (!row && !Array.isArray(i.features)) {
    return { ...base, source: "FALLBACK", reason: "no_feature_row", model_version: i.artifact.model_version || null };
  }
  const out = predictForest(i.artifact, Array.isArray(i.features) ? i.features : row);
  if (!out.ok) {
    return { ...base, source: "FALLBACK", reason: out.reason || "inference_failed",
      model_version: i.artifact.model_version || null, errors: out.errors || [] };
  }
  const maxP = Math.max(...out.probabilities);
  const entropy = -out.probabilities.reduce((a, p) => a + (p > 0 ? p * Math.log(p) : 0), 0);
  const normEntropy = out.probabilities.length > 1 ? entropy / Math.log(out.probabilities.length) : 0;
  return {
    source: "TREE_SHADOW",
    available: true,
    role: TREE_MODEL_ROLE,
    model_version: out.model_version,
    horizon: out.horizon,
    probability_bear: out.probability_bear,
    probability_neutral: out.probability_neutral,
    probability_bull: out.probability_bull,
    probabilities: out.probabilities,
    label: out.label,
    confidence: out.confidence,
    uncertainty: Number((1 - maxP).toFixed(6)),   // 0 = 完全确定
    entropy: Number(entropy.toFixed(6)),
    normalized_entropy: Number(normEntropy.toFixed(6)),
    tree_count: out.tree_count,
    trees_used: out.trees_used,
    imputed: out.imputed,
    reason: "ok"
  };
}

// 供 Shadow 评估复用:把推理结果转成与 mlRuntime.toFusionMl 同形状(仍不进 Active Decision)
export function toShadowMl(resolved) {
  const r = resolved || {};
  if (r.probability_bull == null || r.probability_bear == null) return null;
  return {
    probability_bullish: r.probability_bull,
    probability_bearish: r.probability_bear,
    probability_neutral: r.probability_neutral,
    label: r.label,
    confidence: r.confidence,
    source: r.source,
    role: TREE_MODEL_ROLE,
    shadow: true,
    model_version: r.model_version || null
  };
}
