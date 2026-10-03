// tools/test-tree-shadow.mjs · V16.1 Random Forest Shadow/Challenger 验收测试
// 覆盖:
//  A 工件结构/版本/角色      B 维度校验失败一律拒绝     C JSON 往返与跨语言一致
//  D 推理概率和为 1 / 无 NaN  E 缺失特征按工件默认值(不静默变 0)
//  F 时间切分正确性(禁随机)  G 同一数据两次训练完全一致  H 评估指标齐全且无 NaN
// 骨架照抄 tools/test-funding.mjs(check/eq/near),结尾打印 "N passed, M failed" 并 process.exit
import fs from "node:fs";
import path from "node:path";
import { replaySymbol, attachOutcomes, pickSeriesByHorizon } from "../worker/src/history/backtest.js";
import { buildDataset, datasetToJson } from "../worker/src/history/dataset.js";
import { runPython } from "./ml/train.mjs";
import {
  TREE_MODEL_VERSION, SUPPORTED_TREE_FORMATS, TREE_MODEL_ROLE,
  validateTreeArtifact, predictForest, treeRowFromAnalysis, resolveTreeModel
} from "../worker/src/paper/treeModel.js";
import { runtimeRowFromAnalysis } from "../worker/src/paper/mlRuntime.js";

const ROOT = path.resolve(import.meta.dirname, "..");
let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log("PASS  " + name); }
  else { failed += 1; console.log("FAIL  " + name + (detail ? "  => " + detail : "")); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}
function near(name, actual, expected, tol) {
  check(name, Math.abs(actual - expected) <= (tol == null ? 1e-9 : tol), `got ${actual} want ~${expected}`);
}
function hasNaN(obj) {
  return /NaN|Infinity/.test(JSON.stringify(obj));
}

// 项目内安全路径(与 tools/ml/train.mjs 的 safeUnderRoot 同规则;路径越界直接拒绝)
function safeUnderRoot(relative) {
  const abs = path.resolve(ROOT, relative);
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (abs !== ROOT && !abs.startsWith(rootWithSep)) throw new Error("路径越界: " + abs);
  return abs;
}
const FIXTURE_PATH = safeUnderRoot(path.join("build", "ml", "_tree_shadow_fixture.json"));
const ARTIFACT_PATH = safeUnderRoot(path.join("build", "ml", "_tree_shadow_artifact.json"));

// ---- 确定性合成数据(与 tools/ml/make_fixture.mjs 同一 LCG,仅用于工具链验证) ----
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function gen1h(n, seed) {
  const rand = lcg(seed);
  const rows = [];
  let price = 100;
  const t0 = 1600000000000;
  for (let i = 0; i < n; i += 1) {
    const phase = Math.floor(i / 90) % 4;
    const drift = phase === 0 ? 0.0025 : phase === 1 ? -0.002 : phase === 2 ? 0.0005 : -0.0008;
    const open = price;
    const close = Math.max(1, price * (1 + drift) + Math.sin(i / 9) * 0.4 + (rand() - 0.5) * 1.0);
    rows.push({ openTime: t0 + i * 3600000, open, high: Math.max(open, close) * (1 + rand() * 0.003),
      low: Math.min(open, close) * (1 - rand() * 0.003), close, volume: 1000 * (0.7 + rand() * 0.6),
      closeTime: t0 + (i + 1) * 3600000 - 1 });
    price = close;
  }
  return rows;
}
function agg(hours, factor) {
  const out = [];
  for (let i = 0; i + factor <= hours.length; i += factor) {
    const c = hours.slice(i, i + factor);
    out.push({ openTime: c[0].openTime, open: c[0].open, high: Math.max(...c.map((x) => x.high)),
      low: Math.min(...c.map((x) => x.low)), close: c[c.length - 1].close,
      volume: c.reduce((a, x) => a + x.volume, 0), closeTime: c[c.length - 1].closeTime });
  }
  return out;
}
function interp15(hours, rand) {
  const out = [];
  for (let i = 0; i < hours.length; i += 1) {
    const cur = hours[i];
    for (let k = 0; k < 4; k += 1) {
      const openTime = cur.openTime + k * 900000;
      const open = cur.open + ((cur.close - cur.open) * k) / 4;
      const close = open + ((cur.close - cur.open) / 4) * (0.7 + rand() * 0.6);
      out.push({ openTime, open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999,
        close, volume: cur.volume / 4, closeTime: openTime + 900000 - 1 });
    }
  }
  return out;
}

// ============================================================================
console.log("== 0. 常量与角色约束(SHADOW,不得进入 Active Decision) ==");
check("TREE_MODEL_VERSION 已定义", typeof TREE_MODEL_VERSION === "string" && TREE_MODEL_VERSION.length > 0, TREE_MODEL_VERSION);
eq("支持格式仅 rf-json", SUPPORTED_TREE_FORMATS, ["rf-json"]);
eq("角色常量 = SHADOW", TREE_MODEL_ROLE, "SHADOW");

// ============================================================================
console.log("== 1. 由 Node 生成确定性 fixture 并写入项目内安全路径 ==");
const rand = lcg(1234);
const h1 = gen1h(900, 31);
const h4 = agg(h1, 4);
const d1 = agg(h1, 24);
const m15 = interp15(h1, rand);
const nowMs = h1[h1.length - 1].closeTime + 1000;
const replay = await replaySymbol({ symbol: "BTCUSDT", interval: "1h", tfRows: { "1h": h1, "4h": h4, "1d": d1 }, btcRows: {}, nowMs, step: 1, minHistory: 60 });
const joined = attachOutcomes(replay.signals, pickSeriesByHorizon({ "15m": m15, "1h": h1, "4h": h4 }), nowMs);
const ds = buildDataset(joined, { source: "backtest" });
check("fixture 路径在项目内(安全路径)", FIXTURE_PATH.startsWith(ROOT + path.sep), FIXTURE_PATH);
fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
fs.writeFileSync(FIXTURE_PATH, datasetToJson(ds), "utf8");
check("fixture 已落盘", fs.existsSync(FIXTURE_PATH), FIXTURE_PATH);
const reloaded = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
check("fixture 可解析且含 rows/columns", Array.isArray(reloaded.rows) && Array.isArray(reloaded.columns) && reloaded.rows.length > 200,
  `rows=${reloaded.rows.length} cols=${reloaded.columns.length}`);
check("fixture 含已解析的 1h 标签", reloaded.rows.some((r) => r.h1h_resolved === 1 && r.h1h_outcome), "h1h");

// ---- 训练两次(同一数据 → 必须完全一致) ----
const options = { horizons: ["1h"], train_frac: 0.6, val_frac: 0.2, fee_rate: 0.0005, min_samples: 60,
  train_days: 10, val_days: 3, test_days: 3, select_params: true, max_folds: 6 };
const payload = { action: "train_rf", rows: reloaded.rows, columns: reloaded.columns, meta: reloaded.meta, options };
const t0 = Date.now();
const resA = await runPython(payload);
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`   (train #1 ${elapsed}s, backend=${resA.report.model.backend})`);

console.log("== 2. 工件版本 / 格式 / 角色 ==");
const block = resA.report.horizons["1h"];
const artifact = resA.artifacts["rf|1h"];
check("训练返回 report 与 artifacts", Boolean(resA.report) && Boolean(artifact), JSON.stringify(Object.keys(resA.artifacts || {})));
eq("工件格式 rf-json", artifact.format, "rf-json");
check("工件版本号非空", typeof artifact.model_version === "string" && artifact.model_version.length > 0, artifact.model_version);
eq("工件声明 SHADOW 角色", artifact.role, "SHADOW");
eq("训练报告声明 SHADOW 角色", resA.report.model.role, "SHADOW");
check("report 明确说明不得进入 Active Decision", /Active Decision/i.test(resA.report.model.note || ""), resA.report.model.note);
eq("类别顺序", artifact.label_order, ["Bearish", "Neutral", "Bullish"]);
eq("特征列数 = encoder 列数", artifact.feature_names.length, artifact.encoder.columns.length);
eq("默认值个数 = 特征列数", artifact.feature_defaults.length, artifact.feature_names.length);
check("树数量 > 0", artifact.trees.length > 0, String(artifact.trees.length));

console.log("== 3. 维度/格式校验:坏工件必须被拒 ==");
const okShot = validateTreeArtifact(artifact);
check("合法工件通过校验", okShot.ok === true, JSON.stringify(okShot.errors));
check("校验返回 errors 数组", Array.isArray(okShot.errors) && okShot.errors.length === 0, JSON.stringify(okShot.errors));
const clone = () => JSON.parse(JSON.stringify(artifact));
const badFormat = clone(); badFormat.format = "xgboost-json-b64";
check("不支持格式被拒", validateTreeArtifact(badFormat).ok === false, JSON.stringify(validateTreeArtifact(badFormat).errors));
const badNoVer = clone(); badNoVer.model_version = "";
check("缺版本号被拒", validateTreeArtifact(badNoVer).ok === false);
const badDim = clone(); badDim.feature_names = badDim.feature_names.slice(0, badDim.feature_names.length - 3);
check("特征维度不一致被拒", validateTreeArtifact(badDim).ok === false, JSON.stringify(validateTreeArtifact(badDim).errors));
const badDefaults = clone(); badDefaults.feature_defaults = badDefaults.feature_defaults.slice(0, 2);
check("默认值长度不一致被拒", validateTreeArtifact(badDefaults).ok === false);
const badFeat = clone(); badFeat.trees[0].nodes[0].feature_index = artifact.feature_names.length + 5;
check("feature_index 越界被拒", validateTreeArtifact(badFeat).ok === false);
const badLeaf = clone();
(function corruptLeaf() {
  for (const t of badLeaf.trees) { for (const n of t.nodes) { if (n.leaf_probability) { n.leaf_probability = [0.9, 0.9, 0.9]; return; } } }
}());
check("叶概率未归一被拒", validateTreeArtifact(badLeaf).ok === false);
const badLeft = clone(); badLeft.trees[0].nodes[0].left = 999999;
check("子节点索引越界被拒", validateTreeArtifact(badLeft).ok === false);
check("坏工件推理返回 ok:false", predictForest(badFormat, {}) .ok === false);
check("空对象推理返回 ok:false", predictForest({}, {}).ok === false);

console.log("== 4. 推理:概率和为 1 / 无 NaN ==");
// 取测试窗口的数据行作为推理输入
const split = block.split;
check("切分三段样本数均 > 0", split.train_samples > 0 && split.val_samples > 0 && split.test_samples > 0, JSON.stringify(split));
function labeledRows() {
  return reloaded.rows
    .filter((r) => r.h1h_resolved === 1 && r.h1h_outcome && typeof r.h1h_return === "number" && Number.isFinite(r.h1h_return))
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
}
const allRows = labeledRows();
const testRows = allRows.filter((r) => Number(r.timestamp) >= split.test_start_time && Number(r.timestamp) <= split.test_end_time);
check("测试窗口内行数与报告一致", testRows.length === split.test_samples, `js=${testRows.length} py=${split.test_samples}`);

let sumOk = true, nanFree = true, diffMax = 0, imputedSeen = 0;
const pyPreds = resA.predictions["rf|1h"];
for (let i = 0; i < testRows.length; i += 1) {
  const out = predictForest(artifact, testRows[i]);
  if (!out.ok) { sumOk = false; break; }
  const s = out.probability_bear + out.probability_neutral + out.probability_bull;
  if (Math.abs(s - 1) > 1e-9) sumOk = false;
  if ([out.probability_bear, out.probability_neutral, out.probability_bull].some((v) => !Number.isFinite(v))) nanFree = false;
  if (out.imputed.length) imputedSeen += 1;
  // 与 Python 侧预测逐行对拍
  const py = pyPreds[i];
  if (py) {
    diffMax = Math.max(diffMax, Math.abs(out.probability_bear - py.probability_bearish),
      Math.abs(out.probability_neutral - py.probability_neutral), Math.abs(out.probability_bull - py.probability_bullish));
  }
}
check("每个测试样本概率和 = 1(误差 <1e-9)", sumOk);
check("推理概率全部有限(无 NaN/Infinity)", nanFree);
check("JS 推理与 Python 训练侧概率一致(max diff < 1e-6)", diffMax < 1e-6, "maxdiff=" + diffMax);
check("leaf_votes 每棵树一条且标签合法", (() => {
  const out = predictForest(artifact, testRows[0]);
  return Array.isArray(out.leaf_votes) && out.leaf_votes.length === artifact.trees.length
    && out.leaf_votes.every((v) => v.label === null || ["Bearish", "Neutral", "Bullish"].includes(v.label));
})(), JSON.stringify(predictForest(artifact, testRows[0]).leaf_votes.slice(0, 2)));
eq("tree_count 与工件一致", predictForest(artifact, testRows[0]).tree_count, artifact.trees.length);

console.log("== 5. 缺失特征按工件默认值处理(不静默变 0) ==");
// 5a. 真实工件:空行也能推理且无 NaN,并明确列出被填充的特征
const emptyOut = predictForest(artifact, {});
check("空特征行仍可推理(用默认值)", emptyOut.ok === true, JSON.stringify(emptyOut.errors));
check("空特征行概率和 = 1", Math.abs(emptyOut.probability_bear + emptyOut.probability_neutral + emptyOut.probability_bull - 1) < 1e-9);
check("空特征行无 NaN", !hasNaN(emptyOut.probabilities));
check("缺失特征被显式记录(imputed 非空)", emptyOut.imputed.length > 0, JSON.stringify(emptyOut.imputed.slice(0, 3)));
const defaultsVector = artifact.feature_defaults.slice();
const vecOut = predictForest(artifact, defaultsVector);
near("空行 == 显式传入工件默认值向量", emptyOut.probability_bull, vecOut.probability_bull, 1e-12);
check("工件默认值中存在非零(证明默认值不是恒 0)", artifact.feature_defaults.some((v) => Math.abs(v) > 1e-9),
  "maxDefault=" + Math.max(...artifact.feature_defaults.map(Math.abs)));
// 5b. 单桩合成工件:默认值 5.0、阈值 1.0 → 空行必须走 right 叶,而不是被当成 0 走 left
const stump = {
  format: "rf-json", format_version: 1, model_name: "random_forest", model_version: "rf-test-stump", role: "SHADOW",
  horizon: "1h", n_classes: 3, label_order: ["Bearish", "Neutral", "Bullish"],
  feature_names: ["f_probe"], feature_defaults: [5.0],
  encoder: { numeric_cols: ["f_probe"], categorical_cols: [], categorical_levels: {}, numeric_medians: { f_probe: 5.0 }, columns: ["f_probe"] },
  trees: [{ root: 0, n_nodes: 3, nodes: [
    { feature_index: 0, threshold: 1.0, left: 1, right: 2, leaf_probability: null, samples: 10 },
    { feature_index: -1, threshold: null, left: null, right: null, leaf_probability: [1, 0, 0], samples: 5 },
    { feature_index: -1, threshold: null, left: null, right: null, leaf_probability: [0, 0, 1], samples: 5 }
  ] }],
  training_meta: { note: "test stump" }
};
check("合成桩工件通过校验", validateTreeArtifact(stump).ok === true, JSON.stringify(validateTreeArtifact(stump).errors));
near("空行使用默认值 5.0 → 进入 right 叶(概率_bull=1)", predictForest(stump, {}).probability_bull, 1, 1e-12);
near("显式 0 → 进入 left 叶(概率_bull=0)", predictForest(stump, { f_probe: 0 }).probability_bull, 0, 1e-12);
near("显式 null 也走默认值 5.0", predictForest(stump, { f_probe: null }).probability_bull, 1, 1e-12);
check("默认值 5.0 与非零输入一致(未静默变 0)", predictForest(stump, {}).probability_bear === 0);

console.log("== 6/7. 时间切分正确(禁随机)+ Walk Forward 折 ==");
check("train_end < val_start", split.train_end_time < split.val_start_time, `${split.train_end_time} < ${split.val_start_time}`);
check("val_end < test_start", split.val_end_time < split.test_start_time, `${split.val_end_time} < ${split.test_start_time}`);
check("三段严格递增", split.train_end_time < split.val_start_time && split.val_start_time < split.val_end_time && split.val_end_time < split.test_start_time);
eq("禁用随机切分", [resA.report.config.random_split, resA.report.config.shuffle], [false, false]);
eq("切分方式为时间有序", resA.report.config.split, "time_ordered_train_val_test");
check("无泄漏:Test 最早时间 > Train 最晚时间", Math.min(...testRows.map((r) => Number(r.timestamp))) > split.train_end_time,
  `${Math.min(...testRows.map((r) => Number(r.timestamp)))} > ${split.train_end_time}`);
const usedFolds = block.folds.filter((f) => !f.skipped);
check("产出 Walk Forward 折", usedFolds.length >= 2, String(block.folds.length));
check("每折 train_end < val_start", usedFolds.every((f) => f.train_end < f.val_start), JSON.stringify(usedFolds.map((f) => [f.train_end, f.val_start])));
check("每折 val_end < test_start", usedFolds.every((f) => f.val_end < f.test_start));
check("折顺序递增", block.folds.every((f, i) => i === 0 || f.fold_id === block.folds[i - 1].fold_id + 1));
check("Walk Forward 汇总存在且有序", Boolean(block.walk_forward_summary) && block.walk_forward_summary.all_ordered === true,
  JSON.stringify(block.walk_forward_summary));
check("选参只使用 Validation(报告已声明)", /Validation/.test(block.param_selection.note || ""), block.param_selection.note);

console.log("== 8. 同一数据两次训练结果完全一致(可复现) ==");
const resB = await runPython(payload);
const artB = resB.artifacts["rf|1h"];
eq("两次训练树结构逐字节一致", JSON.stringify(artB.trees), JSON.stringify(artifact.trees));
eq("两次训练特征顺序一致", artB.feature_names, artifact.feature_names);
eq("两次训练默认值一致", artB.feature_defaults, artifact.feature_defaults);
eq("两次训练选参一致", JSON.stringify(artB.training_meta.params), JSON.stringify(artifact.training_meta.params));
near("两次训练 Test accuracy 一致", resB.report.horizons["1h"].test.accuracy, block.test.accuracy, 0);
near("两次训练 Test net_pnl 一致", resB.report.horizons["1h"].test.trading.net_pnl, block.test.trading.net_pnl, 0);
near("两次训练 Test macro_f1 一致", resB.report.horizons["1h"].test.macro_f1, block.test.macro_f1, 0);

console.log("== 9. 工件 JSON 落盘往返 + 与后端(sklearn)逐样本对拍 ==");
fs.writeFileSync(ARTIFACT_PATH, JSON.stringify(artifact), "utf8");
const fromDisk = JSON.parse(fs.readFileSync(ARTIFACT_PATH, "utf8"));
eq("落盘工件与内存工件完全一致", JSON.stringify(fromDisk.trees), JSON.stringify(artifact.trees));
check("落盘工件仍通过校验", validateTreeArtifact(fromDisk).ok === true);
const diskOut = predictForest(fromDisk, testRows[0]);
const memOut = predictForest(artifact, testRows[0]);
near("落盘前后推理一致", diskOut.probability_bull, memOut.probability_bull, 1e-15);
check("工件 JSON 往返与后端(sklearn)一致", block.artifact.json_walk_matches_backend === true,
  `diff=${block.artifact.json_walk_vs_backend_max_prob_diff}`);
near("JSON 往返最大概率偏差为 0", block.artifact.json_roundtrip_max_prob_diff, 0, 1e-12);
check("工件不含 pickle/joblib 字样", !/pickle|joblib/i.test(JSON.stringify(artifact)));

console.log("== 10. 评估指标齐全且无 NaN ==");
const test = block.test;
const metricKeys = ["accuracy", "macro_precision", "macro_recall", "macro_f1", "balanced_accuracy", "per_class", "confusion_matrix"];
check("分类指标齐全(Accuracy/Precision/Recall/F1)", metricKeys.every((k) => test[k] != null), JSON.stringify(metricKeys.filter((k) => test[k] == null)));
check("每类 precision/recall/f1 完整", ["bearish", "neutral", "bullish"].every((c) =>
  test.per_class[c] && ["precision", "recall", "f1", "support"].every((f) => f in test.per_class[c])), JSON.stringify(test.per_class));
check("校准含 Brier", typeof test.calibration.brier === "number" && Number.isFinite(test.calibration.brier), String(test.calibration.brier));
check("校准含 ECE/MCE", Number.isFinite(test.calibration.ece) && Number.isFinite(test.calibration.mce), `${test.calibration.ece}/${test.calibration.mce}`);
check("校准含分桶实测命中率 vs 预测概率", Array.isArray(test.calibration.reliability) && test.calibration.reliability.length > 0 &&
  test.calibration.reliability.every((b) => Number.isFinite(b.avg_predicted_probability) && Number.isFinite(b.observed_hit_rate)),
  JSON.stringify(test.calibration.reliability));
check("每类校准曲线存在", ["bearish", "neutral", "bullish"].every((c) => Array.isArray(test.calibration.per_class_reliability[c])),
  JSON.stringify(Object.keys(test.calibration.per_class_reliability || {})));
const tr = test.trading;
check("交易指标齐全(扣费净 PnL/MaxDD/ProfitFactor/FeeDrag/CapitalEfficiency)",
  ["net_pnl", "max_drawdown", "profit_factor", "fee_drag", "capital_efficiency", "total_fees", "gross_pnl", "trades"].every((k) => k in tr),
  JSON.stringify(Object.keys(tr)));
check("净 PnL 已扣费(净 <= 毛利)", tr.net_pnl <= tr.gross_pnl + 1e-12, `net=${tr.net_pnl} gross=${tr.gross_pnl}`);
check("总费用 = 往返 2 倍单边费率", Math.abs(tr.total_fees - tr.trades * 2 * 0.0005) < 1e-9, `fees=${tr.total_fees} trades=${tr.trades}`);
check("Max Drawdown >= 0", tr.max_drawdown >= 0, String(tr.max_drawdown));
check("Profit Factor 有限或明确为 null(无亏损时)", tr.profit_factor === null || Number.isFinite(tr.profit_factor), String(tr.profit_factor));
check("Capital Efficiency 有限", Number.isFinite(tr.capital_efficiency), String(tr.capital_efficiency));
check("Validation 指标同样齐全", block.validation && Number.isFinite(block.validation.accuracy) && Number.isFinite(block.validation.calibration.brier));
check("报告全文无 NaN/Infinity", !hasNaN(resA.report), "found NaN/Infinity in report");
eq("输出自检 finite_check 为空", block.finite_check, []);
check("预测明细概率和为 1 且带 SHADOW 角色", pyPreds.length > 0 && pyPreds.every((p) =>
  Math.abs(p.probability_bearish + p.probability_neutral + p.probability_bullish - 1) < 1e-5 && p.role === "SHADOW"),
  String(pyPreds.length));

console.log("== 11. treeRowFromAnalysis 与 mlRuntime 同口径 ==");
// 用真实快照特征构造一份 analysis,比较两个函数的输出
const sampleRec = joined.find((r) => {
  const t = Number(r.signal.timestamp);
  return t >= split.test_start_time && t <= split.test_end_time;
});
check("找到测试窗内的真实信号快照", Boolean(sampleRec), String(sampleRec && sampleRec.signal.timestamp));
const analysis = {
  symbol: sampleRec.signal.symbol,
  interval: sampleRec.signal.interval,
  timestamp: Number(sampleRec.signal.timestamp),
  price: sampleRec.signal.price,
  features: JSON.parse(sampleRec.signal.features || "{}"),
  change24h: sampleRec.signal.change24h,
  direction: sampleRec.signal.direction,
  signal_strength: sampleRec.signal.signal_strength,
  confidence: sampleRec.signal.confidence,
  risk_score: sampleRec.signal.risk_score,
  risk_level: sampleRec.signal.risk_level,
  model_version: sampleRec.signal.engine_version,
  data_close_time: Number(sampleRec.signal.timestamp),
  limited_data: false
};
eq("treeRowFromAnalysis == runtimeRowFromAnalysis(逐字段一致)",
  treeRowFromAnalysis(analysis, { horizons: ["1h"] }), runtimeRowFromAnalysis(analysis, { horizons: ["1h"] }));
const rowFromEngine = treeRowFromAnalysis(analysis, { horizons: ["1h"] });
check("特征行含训练所用特征列", artifact.encoder.numeric_cols.every((c) => c in rowFromEngine),
  JSON.stringify(artifact.encoder.numeric_cols.slice(0, 3)));
const engineOut = predictForest(artifact, rowFromEngine);
check("真实引擎行可推理且概率和为 1", engineOut.ok === true &&
  Math.abs(engineOut.probability_bear + engineOut.probability_neutral + engineOut.probability_bull - 1) < 1e-9);

console.log("== 12. resolveTreeModel:没有工件时明确不可用(禁止假装有模型) ==");
const noArt = resolveTreeModel({ row: rowFromEngine });
eq("无工件 → source=FALLBACK", noArt.source, "FALLBACK");
eq("无工件 → available=false", noArt.available, false);
eq("无工件 → 概率为 null(不编造)", [noArt.probability_bear, noArt.probability_neutral, noArt.probability_bull], [null, null, null]);
eq("无工件 → 原因明确", noArt.reason, "no_tree_artifact");
const badArtResolve = resolveTreeModel({ artifact: badFormat, row: rowFromEngine });
eq("损坏工件 → FALLBACK", badArtResolve.source, "FALLBACK");
eq("损坏工件 → available=false", badArtResolve.available, false);
const noRow = resolveTreeModel({ artifact });
eq("有工件但无特征行 → FALLBACK", noRow.source, "FALLBACK");
eq("有工件但无特征行 → 原因 no_feature_row", noRow.reason, "no_feature_row");
const resolved = resolveTreeModel({ artifact, row: testRows[0] });
eq("正常路径 → source=TREE_SHADOW", resolved.source, "TREE_SHADOW");
eq("正常路径 → available=true", resolved.available, true);
eq("正常路径 → 角色 SHADOW", resolved.role, "SHADOW");
check("正常路径 → 概率和为 1", Math.abs(resolved.probability_bear + resolved.probability_neutral + resolved.probability_bull - 1) < 1e-9);
near("uncertainty = 1 - max(probability)", resolved.uncertainty, 1 - Math.max(resolved.probability_bear, resolved.probability_neutral, resolved.probability_bull), 1e-6);
check("uncertainty ∈ [0,1]", resolved.uncertainty >= 0 && resolved.uncertainty <= 1, String(resolved.uncertainty));
const resolvedFromAnalysis = resolveTreeModel({ artifact, analysis, horizons: ["1h"] });
eq("由 analysis 走通同口径特征行", resolvedFromAnalysis.source, "TREE_SHADOW");

// ============================================================================
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("TREE SHADOW TESTS OK");
process.exit(0);
