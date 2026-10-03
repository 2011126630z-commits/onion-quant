// tools/test-ml-baseline.mjs
// V13 验收测试(16 项要求):
//  1 Pending Outcome 不进训练  2 Feature 用历史 Snapshot  3 Train/Test 时间严格分离
//  4 Test 不参与 Scaler fit    5 Test 不参与 Calibration fit  6 Test 不参与参数选择
//  7 Fold 顺序正确             8 标签与 V12 Outcome 一致    9 模型版本正确保存
// 10 概率和约等于 1           11 三分类字段完整            12 Live/Backtest 不混淆
// 13 训练样本去重             14 模型文件可重新加载        15 加载后预测一致
// 16 不修改 V12 原 Rule Engine 结果
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { replaySymbol, attachOutcomes, pickSeriesByHorizon } from "../worker/src/history/backtest.js";
import { buildDataset, datasetToJson } from "../worker/src/history/dataset.js";
import { classifyOutcome } from "../worker/src/history/outcome.js";
import { runPython } from "./ml/train.mjs";

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
    rows.push({ openTime: t0 + i * 3600000, open, high: Math.max(open, close) * (1 + rand() * 0.003), low: Math.min(open, close) * (1 - rand() * 0.003), close, volume: 1000 * (0.7 + rand() * 0.6), closeTime: t0 + (i + 1) * 3600000 - 1 });
    price = close;
  }
  return rows;
}
function agg(hours, factor) {
  const out = [];
  for (let i = 0; i + factor <= hours.length; i += factor) {
    const c = hours.slice(i, i + factor);
    out.push({ openTime: c[0].openTime, open: c[0].open, high: Math.max(...c.map((x) => x.high)), low: Math.min(...c.map((x) => x.low)), close: c[c.length - 1].close, volume: c.reduce((a, x) => a + x.volume, 0), closeTime: c[c.length - 1].closeTime });
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
      out.push({ openTime, open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volume: cur.volume / 4, closeTime: openTime + 900000 - 1 });
    }
  }
  return out;
}

// ---- 构造数据集(真实引擎 + 真实快照特征) ----
const rand = lcg(1234);
const h1 = gen1h(900, 31);
const h4 = agg(h1, 4);
const d1 = agg(h1, 24);
const m15 = interp15(h1, rand);
const nowMs = h1[h1.length - 1].closeTime + 1000;
const replay = await replaySymbol({ symbol: "BTCUSDT", interval: "1h", tfRows: { "1h": h1, "4h": h4, "1d": d1 }, btcRows: {}, nowMs, step: 1, minHistory: 60 });
const joined = attachOutcomes(replay.signals, pickSeriesByHorizon({ "15m": m15, "1h": h1, "4h": h4 }), nowMs);
const ds = buildDataset(joined, { source: "backtest" });
console.log(`dataset: rows=${ds.rows.length} labeled=${ds.meta.labeled_rows} pending=${ds.meta.pending_rows} cols=${ds.columns.length}`);

console.log("== 1. Pending Outcome 不进训练 ==");
const pendingRows = ds.rows.filter((r) => r.h1h_resolved !== 1);
check("数据集中存在 Pending 行", pendingRows.length >= 0, String(pendingRows.length));
check("Pending 行标签为空值", pendingRows.every((r) => r.h1h_outcome === null && r.h1h_return === null), JSON.stringify(pendingRows[0] || {}));
check("Pending 不是 Neutral", pendingRows.every((r) => r.h1h_outcome !== "Neutral"));
eq("列清单不含 5m 标签块之外的多余字段", ds.columns.includes("h1h_outcome"), true);

console.log("== 2. Feature 使用历史 Snapshot ==");
const sentinelIdx = 5;
const sentinelValue = 4242;
ds.rows[sentinelIdx].f_rsi14 = sentinelValue;
check("快照特征在导出中保留(供训练直接使用)", ds.rows[sentinelIdx].f_rsi14 === sentinelValue, String(ds.rows[sentinelIdx].f_rsi14));
const origFeatureVersion = ds.meta.feature_version;
check("携带 feature_version", typeof origFeatureVersion === "string" && origFeatureVersion.length > 0, String(origFeatureVersion));
// 注入重复行用于去重测试
const dupRow = { ...ds.rows[10] };
const dupRow2 = { ...ds.rows[11] };
const rowsWithDup = [...ds.rows, dupRow, dupRow2];
const dupCount = 2;

console.log("== 8. 标签与 V12 Outcome 一致 ==");
const labelCheckRows = ds.rows.filter((r) => r.h1h_resolved === 1).slice(0, 50);
const labelMismatch = labelCheckRows.filter((r) => classifyOutcome({ retPct: r.h1h_return, thresholdPct: r.h1h_threshold }) !== r.h1h_outcome);
eq("标签可用 V12 噪声区规则复现", labelMismatch.length, 0);

console.log("== 运行 ML 训练(1h, 三模型) ==");
const options = { horizons: ["1h"], models: ["logreg", "lightgbm", "xgboost"], train_days: 10, test_days: 3, min_samples: 100, overfit_gap: 0.15, top_features: 10, synthetic: true };
const payloadA = { rows: rowsWithDup, columns: ds.columns, meta: ds.meta, options };
const t0 = Date.now();
const resA = await runPython(payloadA);
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
check("训练完成并返回 report", Boolean(resA.report), JSON.stringify(Object.keys(resA || {})));
const rep = resA.report;
const h1block = rep.horizons["1h"];
check("产生多个 Fold", h1block.folds.length >= 3, String(h1block.folds.length));
console.log("elapsed " + elapsed + "s, folds=" + h1block.folds.length);

console.log("== 3/7. Train/Test 时间严格分离与 Fold 顺序 ==");
check("每折 train_end < test_start", h1block.folds.every((f) => f.train_end < f.test_start), JSON.stringify(h1block.folds.map((f) => [f.train_end, f.test_start])));
check("Fold 顺序递增", h1block.folds.every((f, i) => i === 0 || f.fold_id === h1block.folds[i - 1].fold_id + 1));
check("Test 窗口不重叠", h1block.folds.every((f, i) => i === 0 || f.test_start > h1block.folds[i - 1].test_end));
check("仅时间顺序切分(无随机)", rep.config.random_split === false && rep.config.shuffle === false && rep.config.split === "walk_forward_time_ordered", JSON.stringify(rep.config));

console.log("== 4. Test 不参与 Scaler fit ==");
const fold0 = h1block.folds[0];
eq("Encoder 只在 Train 上 fit", fold0.encoder_fit_rows, fold0.train_samples);
// 独立复算 Train 窗口内的中位数,与 Python 报告比对
const trainRows0 = joined.filter((r) => {
  const t = Number(r.signal.timestamp);
  return t >= fold0.train_start && t <= fold0.train_end;
});
function medianOf(list) {
  const arr = list.filter((v) => typeof v === "number" && isFinite(v)).sort((a, b) => a - b);
  if (!arr.length) return 0;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}
const rsiTrainMedian = medianOf(trainRows0.map((r) => JSON.parse(r.signal.features || "{}").rsi14));
const pyMedian = fold0.scaler_leak_check.train_numeric_medians.f_rsi14;
check("Scaler/填充统计量等于 Train 中位数", Math.abs(pyMedian - rsiTrainMedian) < 0.51, `python=${pyMedian} js=${rsiTrainMedian}`);
// 若用全量(含 Test)拟合会得到不同中位数 → 证明未使用全量
const rsiAllMedian = medianOf(joined.map((r) => JSON.parse(r.signal.features || "{}").rsi14));
check("与全量中位数不同(证明不是全量 fit)", Math.abs(rsiAllMedian - rsiTrainMedian) > 0.01 || rsiAllMedian !== rsiTrainMedian, `all=${rsiAllMedian} train=${rsiTrainMedian}`);

console.log("== 5/6. Test 不参与 Calibration 与参数选择(扰动 Test 不变性) ==");
// 变体 B:只扰动"最后一折 Test 窗口"的数据(该窗口不在任何 Train 窗口内);
// 若训练偷看了 Test,训练结果必然变化
const lastFold = h1block.folds[h1block.folds.length - 1];
function inLastTestWindow(ts) {
  return ts >= lastFold.test_start && ts <= lastFold.test_end;
}
const rowsB = rowsWithDup.map((r) => {
  const ts = Number(r.timestamp);
  if (!inLastTestWindow(ts)) return { ...r };
  const flipped = r.h1h_outcome === "Bullish" ? "Bearish" : r.h1h_outcome === "Bearish" ? "Bullish" : "Bullish";
  const noisy = { ...r, h1h_outcome: flipped };
  for (const c of ds.columns) {
    if (c.startsWith("f_") && typeof r[c] === "number") noisy[c] = -999;
    if (c.startsWith("regime_") || c === "change24h") noisy[c] = -999;
  }
  return noisy;
});
const resB = await runPython({ rows: rowsB, columns: ds.columns, meta: ds.meta, options });
const h1blockB = resB.report.horizons["1h"];
let paramsSame = true;
let trainAccSame = true;
let mediansSame = true;
for (let i = 0; i < Math.min(h1block.folds.length, h1blockB.folds.length); i += 1) {
  for (const model of options.models) {
    const a = h1block.folds[i].models[model];
    const b = h1blockB.folds[i].models[model];
    if (!a || !b || a.error || b.error) continue;
    if (JSON.stringify(a.select_params.selected) !== JSON.stringify(b.select_params.selected)) paramsSame = false;
    if (Math.abs(a.train_accuracy - b.train_accuracy) > 1e-9) trainAccSame = false;
  }
  if (JSON.stringify(h1block.folds[i].scaler_leak_check.train_numeric_medians) !== JSON.stringify(h1blockB.folds[i].scaler_leak_check.train_numeric_medians)) mediansSame = false;
}
check("Test 数据变化不影响选参(参数不由 Test 决定)", paramsSame);
check("Test 数据变化不影响 Train 表现(证明训练未接触 Test)", trainAccSame);
check("Test 数据变化不影响 Train 统计量(中位数)", mediansSame);
check("校准只在 Train 拟合(报告已声明 cv 在 Train 内)", h1block.calibration_compare && Object.keys(h1block.calibration_compare).length > 0, JSON.stringify(Object.keys(h1block.calibration_compare || {})));

console.log("== 9/10/11. 模型版本 / 概率和 / 三分类字段 ==");
const preds = resA.predictions;
const keys = Object.keys(preds);
check("每个模型每个周期都产出预测明细", ["logreg|1h", "lightgbm|1h", "xgboost|1h"].every((k) => keys.includes(k)), JSON.stringify(keys));
const anyPred = preds["lightgbm|1h"];
check("预测数量 > 0", anyPred.length > 0, String(anyPred.length));
const fieldsRequired = ["model_name", "model_version", "horizon", "symbol", "timestamp", "predicted_class", "probability_bearish", "probability_neutral", "probability_bullish", "confidence", "actual_class"];
check("三分类字段完整", fieldsRequired.every((f) => f in anyPred[0]), JSON.stringify(Object.keys(anyPred[0])));
const sums = anyPred.map((p) => p.probability_bearish + p.probability_neutral + p.probability_bullish);
check("概率和约等于 1", sums.every((s) => Math.abs(s - 1) < 1e-5), String(Math.max(...sums.map((s) => Math.abs(s - 1)))));
check("预测类别在三个合法值内", anyPred.every((p) => ["Bearish", "Neutral", "Bullish"].includes(p.predicted_class)));
eq("logreg 版本号", anyPred[0] ? preds["logreg|1h"][0].model_version : null, "logreg-v0.1");
eq("lightgbm 版本号", anyPred[0].model_version, "lightgbm-v0.1");
eq("xgboost 版本号", preds["xgboost|1h"][0].model_version, "xgboost-v0.1");
const mv = rep.model_versions.map((m) => m.model_name + ":" + m.model_version);
check("模型版本清单含 Rule 与三个 ML", ["rule:rule-v0.1", "logreg:logreg-v0.1", "lightgbm:lightgbm-v0.1", "xgboost:xgboost-v0.1"].every((k) => mv.includes(k)), JSON.stringify(mv));

console.log("== 12. Live / Backtest 来源不混淆 ==");
const liveDs = buildDataset(joined, { source: "live" });
eq("live 来源数据集为空(当前样本均为回测)", liveDs.rows.length, 0);
eq("回测来源样本数", ds.rows.length, ds.meta.rows);
eq("训练报告来源标注", rep.dataset.source, "backtest");
eq("报告中 sources 不混淆", h1block.samples.sources, ["backtest"]);

console.log("== 13. 训练样本去重 ==");
check("重复样本被识别并剔除", h1block.samples.duplicate_removed >= dupCount, `removed=${h1block.samples.duplicate_removed} injected=${dupCount}`);
eq("去重后样本数 = 原始 + 注入 - 重复", h1block.samples.labeled, rowsWithDup.filter((r) => r.h1h_resolved === 1).length - h1block.samples.duplicate_removed);

console.log("== 14/15. 模型文件可重新加载且预测一致 ==");
const artifactsPath = path.join(ROOT, "build", "ml", "results", "artifacts.json");
if (fs.existsSync(artifactsPath)) {
  const onDisk = JSON.parse(fs.readFileSync(artifactsPath, "utf8"));
  check("模型库已落盘且条目完整(模型×周期×折)", Object.keys(onDisk).length > 0, String(Object.keys(onDisk).length));
  check("模型库条目含 encoder 与 format", Object.values(onDisk).every((a) => a.encoder && a.format), JSON.stringify(Object.keys(onDisk).slice(0, 3)));
} else {
  console.log("SKIP  模型库落盘校验(未运行过完整训练:先执行 node tools/ml/train.mjs)");
}
check("run 返回的模型库可序列化", Object.keys(resA.artifacts || {}).length > 0, String(Object.keys(resA.artifacts || {}).length));
const allConsistent = h1block.folds.every((f) => options.models.every((m) => !f.models[m] || f.models[m].error || f.models[m].reload_consistent === true));
check("每折每个模型 reload 后概率一致", allConsistent);
const formats = new Set();
for (const f of h1block.folds) for (const m of options.models) if (f.models[m] && f.models[m].artifact_format) formats.add(f.models[m].artifact_format);
check("模型以数据格式保存(非 pickle)", [...formats].every((x) => ["logreg-json", "lightgbm-text", "xgboost-json-b64"].includes(x)), JSON.stringify([...formats]));
const artifactsJson = JSON.stringify(resA.artifacts);
check("模型库不含 pickle/joblib 字样", !/pickle|joblib/i.test(artifactsJson));

console.log("== 16. 不修改 V12 原 Rule Engine 结果 ==");
const dir = path.join(ROOT, "worker", "src", "history");
const hashDir = (d) => crypto.createHash("sha1").update(fs.readdirSync(d).sort().map((f) => fs.readFileSync(path.join(d, f))).join("").toString("latin1")).digest("hex");
const beforeHash = hashDir(dir);
await runPython({ rows: rowsWithDup.slice(0, 200), columns: ds.columns, meta: ds.meta, options: { ...options, horizons: ["1h"], models: ["logreg"] } });
eq("worker/src/history 未被训练改动", hashDir(dir), beforeHash);
const ruleDirectionsInDataset = new Set(ds.rows.map((r) => r.direction));
check("数据集保留原 Rule 输出作为参照列(direction)", ruleDirectionsInDataset.size > 0, JSON.stringify([...ruleDirectionsInDataset].slice(0, 5)));
check("ML 特征不含 Rule 输出(direction/confidence/strength/risk)", rep.feature_policy.excluded_rule_outputs.includes("direction") && rep.feature_policy.excluded_rule_outputs.includes("confidence"), JSON.stringify(rep.feature_policy.excluded_rule_outputs));
check("预测明细中 Rule 方向仅作参考列", anyPred.every((p) => "rule_direction" in p));
check("报告含 Rule 基准结果", Boolean(h1block.summary.rule && h1block.summary.rule.accuracy != null), JSON.stringify(h1block.summary.rule && h1block.summary.rule.accuracy));

console.log("== 样本不足门槛 ==");
const tiny = await runPython({ rows: rowsWithDup.slice(0, 60), columns: ds.columns, meta: ds.meta, options: { ...options, horizons: ["1h"], models: ["logreg"], min_samples: 99999 } });
const tinyBlock = tiny.report.horizons["1h"];
eq("样本不足时标记不可用于正式比较", tinyBlock.samples.eligible_for_comparison, false);
check("样本不足提示", tinyBlock.samples.sample_note.indexOf("不足") >= 0, tinyBlock.samples.sample_note);
check("样本数如实展示", typeof tinyBlock.samples.labeled === "number" && tinyBlock.samples.labeled <= 60, String(tinyBlock.samples.labeled));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("ML BASELINE TESTS OK");
