// tools/test-ml-runtime.mjs · V14.3 ML Runtime 真实推理测试
// A 数值核心(softmax/线性打分)  B 工件校验  C 真实推理(与 Python ReloadedModel 交叉验证)
// D 回退 Rule+Bull/Bear+Risk(禁止 ml:null)  E Champion 原子热替换  F 页面接线 + 融合生效
import fs from "node:fs";
import path from "node:path";
import {
  ML_RUNTIME_VERSION, ML_FALLBACK_SOURCE, LR_LABELS, ML_ARTIFACT_TABLE,
  softmax, encodeFeatures, linearScores, validateArtifact, predictLogreg, runtimeRowFromAnalysis,
  fallbackPrediction, resolveMl, toFusionMl, createMlRuntime, saveArtifact, loadArtifact, loadChampionIntoRuntime
} from "../worker/src/paper/mlRuntime.js";
import { fuse, mlScore } from "../worker/src/paper/fusion.js";
import { registerModel, getChampion, promoteModel } from "../worker/src/paper/learning.js";
import { evidenceBundle } from "../worker/src/paper/evidence.js";
import { createHistoryStore } from "../worker/src/history/store.js";
import { spawn } from "node:child_process";

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

// 跑一段独立 Python 脚本(把 JSON 从 stdin 喂进去),用于与训练侧预测器对齐
function runPythonScript(src, stdinText) {
  return new Promise((resolve, reject) => {
    const child = spawn("python", ["-c", src], { cwd: ROOT });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) { reject(new Error("python exit " + code + ": " + err.slice(-400))); return; }
      resolve(out);
    });
    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

// 内存 store(与页面 paperStoreAdapter 同形状)
function memStore() {
  const tables = new Map();
  const rows = (t) => { if (!tables.has(t)) tables.set(t, new Map()); return tables.get(t); };
  return {
    get: async (t, k) => rows(t).get(k) || null,
    all: async (t) => [...rows(t).values()],
    put: async (t, r) => { rows(t).set(r.artifact_id || r.model_id || r.key || r.id, r); return r; },
    del: async (t, k) => { rows(t).delete(k); }
  };
}

console.log("== A. 数值核心 ==");
{
  const p = softmax([1, 2, 3]);
  near("softmax 归一化", p.reduce((a, b) => a + b, 0), 1, 1e-12);
  check("softmax 保序", p[2] > p[1] && p[1] > p[0]);
  near("softmax 手工核对(0,0,0)", softmax([0, 0, 0])[1], 1 / 3, 1e-12);
  const big = softmax([1000, 1001, 1002]);
  check("softmax 数值稳定(不溢出不 NaN)", big.every((v) => Number.isFinite(v)) && Math.abs(big.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  const z = linearScores([2, 4], [[1, 0], [0, 1], [1, 1]], [0, 1, -1], [1, 2], [1, 2]);
  eq("线性打分 = ((x-mean)/scale)·coef + intercept", z, [1, 2, 1]);
  const zScaleZero = linearScores([5], [[1]], [0], [0], [0]);
  eq("scale 为 0 时按 1 处理(不产生 Infinity)", zScaleZero, [5]);
  const enc = encodeFeatures({ a: 3, cat: "up" }, { numeric_cols: ["a", "b"], categorical_cols: ["cat"], categorical_levels: { cat: ["down", "up"] }, numeric_medians: { a: 0, b: 7 } });
  eq("One-Hot + 中位数填充", enc, [3, 7, 0, 1]);
  const encMissing = encodeFeatures({}, { numeric_cols: ["a"], categorical_cols: ["cat"], categorical_levels: { cat: ["x"] }, numeric_medians: { a: 5 } });
  eq("缺失数值用训练期中位数填充", encMissing, [5, 0]);
}

// 构造一个"手算可知"的 logreg 工件
function toyArtifact() {
  return {
    model_name: "logreg", model_version: "logreg-test-1", horizon: "1h", format: "logreg-json",
    classes: [0, 1, 2],
    coef: [[-0.8, 0.2], [0.0, 0.0], [0.9, -0.1]],
    intercept: [0.1, 0, -0.1],
    scaler_mean: [0, 0], scaler_scale: [1, 1],
    encoder: { fit_rows: 10, numeric_cols: ["f_rsi14", "f_adx"], categorical_cols: [], categorical_levels: {}, numeric_medians: { f_rsi14: 50, f_adx: 20 }, columns: ["f_rsi14", "f_adx"] }
  };
}

console.log("== B. 工件校验 ==");
{
  const good = validateArtifact(toyArtifact());
  check("合法工件通过校验(含冒烟推理)", good.ok === true, JSON.stringify(good));
  eq("校验报告特征数", good.checks.feature_count, 2);
  check("缺 format 被拒", validateArtifact({ ...toyArtifact(), format: undefined }).reason.startsWith("unsupported_format"));
  check("非 logreg 格式被拒(树模型不做 JS 端伪推理)", validateArtifact({ ...toyArtifact(), format: "lightgbm-text" }).reason === "unsupported_format:lightgbm-text");
  check("空对象被拒", validateArtifact({}).ok === false);
  const badCoef = toyArtifact();
  badCoef.coef[1] = [0.1];   // 维度不符
  eq("系数维度不符被拒", validateArtifact(badCoef).reason, "coef_shape_mismatch:1");
  const badIntercept = toyArtifact();
  badIntercept.intercept = [0.1];
  eq("截距长度不符被拒", validateArtifact(badIntercept).reason, "intercept_length_mismatch");
  const nanCoef = toyArtifact();
  nanCoef.coef[0][0] = null;
  check("系数含非有限值被拒", validateArtifact(nanCoef).reason.startsWith("coef_shape_mismatch"));
  const badScale = toyArtifact();
  badScale.scaler_scale = [1];
  eq("scaler 长度不符被拒", validateArtifact(badScale).reason, "scaler_scale_mismatch");
  const noEnc = toyArtifact();
  delete noEnc.encoder;
  eq("缺编码器被拒", validateArtifact(noEnc).reason, "encoder_missing");
}

console.log("== C. 真实推理(与 Python ReloadedModel 交叉验证) ==");
{
  const a = toyArtifact();
  const row = { f_rsi14: 70, f_adx: 30 };
  const out = predictLogreg(a, row);
  check("推理成功", out.ok === true, JSON.stringify(out));
  // 手算:z = [(-0.8*70 + 0.2*30) + 0.1, 0, (0.9*70 - 0.1*30) - 0.1] = [-49.9, 0, 59.9]
  const exp = softmax([-49.9, 0, 59.9]);
  near("概率与手算一致[0]", out.probabilities[0], exp[0], 1e-9);
  near("概率与手算一致[2]", out.probabilities[2], exp[2], 1e-9);
  eq("分类标签取最大概率", out.label, "Bullish");
  near("bearish 概率对齐", out.bearish, exp[0], 1e-9);
  near("bullish 概率对齐", out.bullish, exp[2], 1e-9);
  const bearRow = predictLogreg(a, { f_rsi14: 20, f_adx: 10 });
  check("看涨系数下 RSI 越低看涨概率越小(单调性)", bearRow.bullish < predictLogreg(a, { f_rsi14: 70, f_adx: 30 }).bullish, `${bearRow.bullish} < ${out.bullish}`);
  // 反向系数工件:bear 行对 RSI 正相关 → 低 RSI 应判 Bearish
  const bearArtifact = toyArtifact();
  bearArtifact.coef = [[0.9, -0.1], [0, 0], [-0.8, 0.2]];
  bearArtifact.intercept = [-0.1, 0, 0.1];
  eq("反向系数工件:低 RSI 判为看跌", predictLogreg(bearArtifact, { f_rsi14: 20, f_adx: 10 }).label, "Bearish");
  eq("反向系数工件:高 RSI 仍判看跌(标签由系数决定,不是固定方向)", predictLogreg(bearArtifact, { f_rsi14: 70, f_adx: 30 }).label, "Bearish");
  eq("正向系数工件:任意 RSI 都判看涨(与反向工件互为对照)", [predictLogreg(a, { f_rsi14: 20, f_adx: 10 }).label, predictLogreg(a, { f_rsi14: 70, f_adx: 30 }).label], ["Bullish", "Bullish"]);
  near("特征缺失时用训练期中位数(不崩)", predictLogreg(a, {}).probabilities.reduce((x, y) => x + y, 0), 1, 1e-9);

  // 用 Python 侧同一套系数做对照:predict_proba 必须逐元素一致
  // (直接调用 ml_core.ReloadedModel —— 也就是离线训练回放时用的那个预测器)
  const pySrc = [
    "import json, sys",
    "sys.path.insert(0, r'" + path.join(ROOT, "tools", "ml") + "')",
    "import ml_core",
    "payload = json.loads(sys.stdin.buffer.read().decode('utf-8'))",
    "model = ml_core.ReloadedModel(payload['artifact'])",
    "X = [[70.0, 30.0], [20.0, 10.0], [50.0, 20.0]]",
    "print(json.dumps(model.predict_proba(X).tolist()))"
  ].join("\n");
  let pyProbs = null;
  let pyNote = "";
  try {
    pyProbs = JSON.parse((await runPythonScript(pySrc, JSON.stringify({ artifact: a }))).trim());
  } catch (error) {
    pyNote = String(error && error.message || error).slice(0, 160);
  }
  if (pyProbs) {
    const jsProbs = [[70, 30], [20, 10], [50, 20]].map((r) => predictLogreg(a, { f_rsi14: r[0], f_adx: r[1] }).probabilities);
    let maxDiff = 0;
    for (let i = 0; i < pyProbs.length; i += 1) {
      for (let j = 0; j < pyProbs[i].length; j += 1) maxDiff = Math.max(maxDiff, Math.abs(pyProbs[i][j] - jsProbs[i][j]));
    }
    check("JS 推理与 Python ml_core.ReloadedModel 逐元素一致(3 样本 × 3 类)", maxDiff < 1e-12, "max_diff=" + maxDiff);
  } else if (/ENOENT|not recognized|不是内部|No such file/i.test(pyNote)) {
    console.log("SKIP  Python 交叉验证(本机无 python):" + pyNote);
  } else {
    check("Python 交叉验证可运行", false, pyNote);
  }
}

console.log("== D. 回退:Rule + Bull/Bear + Risk(禁止长期 ml:null) ==");
{
  const fb = fallbackPrediction({ rule_score: 0.6, bull_score: 0.8, bear_score: 0.2, risk_score: 20 });
  check("回退也有完整三分类概率", fb.probabilities.length === 3 && Math.abs(fb.probabilities.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  eq("回退来源标注", fb.source, ML_FALLBACK_SOURCE);
  check("回退不是 null / 不是 NaN", fb.bullish != null && Number.isFinite(fb.bullish));
  const fbBear = fallbackPrediction({ rule_score: -0.6, bull_score: 0.1, bear_score: 0.9, risk_score: 20 });
  eq("看跌证据 → 看跌", fbBear.label, "Bearish");
  const fbRisk = fallbackPrediction({ rule_score: 0.9, bull_score: 0.9, bear_score: 0.0, risk_score: 95 });
  const fbLowRisk = fallbackPrediction({ rule_score: 0.9, bull_score: 0.9, bear_score: 0.0, risk_score: 5 });
  check("高 Risk 压降置信但不翻方向", fbRisk.bullish < fbLowRisk.bullish && fbRisk.label === "Bullish", `${fbRisk.bullish} vs ${fbLowRisk.bullish}`);
  const fbNoEvidence = fallbackPrediction({});
  check("全空输入也返回可用分布", fbNoEvidence.ok === true && Number.isFinite(fbNoEvidence.confidence));

  // resolveMl:无运行时 / 无 Champion / 有 Champion 三种路径
  const runtime = createMlRuntime();
  const noRuntime = resolveMl(null, { analysis: { features: {} }, rule_score: 0.5, risk_score: 30 });
  eq("无运行时 → 回退", noRuntime.source, ML_FALLBACK_SOURCE);
  const noChampion = resolveMl(runtime, { analysis: { features: {} }, rule_score: 0.5, risk_score: 30 });
  eq("运行时无 Champion → 回退", noChampion.source, ML_FALLBACK_SOURCE);
  eq("回退原因可追溯", noChampion.reason, "no_champion");
  runtime.load({ artifact: toyArtifact(), version: "logreg-test-1", model_type: "logreg", horizon: "1h" });
  const withModel = resolveMl(runtime, { analysis: { features: { rsi14: 70, adx: 30 } }, rule_score: 0.5, risk_score: 30 });
  check("有 Champion → 真实推理", withModel.source === "ml:logreg-test-1" && withModel.fallback === false, JSON.stringify(withModel).slice(0, 120));
  eq("推理结果可转成融合输入", typeof toFusionMl(withModel).probability_bullish, "number");
  // 结论:任何路径都不会产出 null
  const neverNull = [noRuntime, noChampion, withModel].every((r) => r.bullish != null && r.bearish != null);
  check("三条路径均不产出 ml:null", neverNull === true);
}

console.log("== E. Champion 原子热替换 ==");
{
  const store = memStore();
  const runtime = createMlRuntime();
  // 1) 先跑旧模型
  const v1 = toyArtifact();
  v1.model_version = "logreg-v1";
  await saveArtifact(store, v1, { model_type: "logreg", version: "logreg-v1" });
  await registerModel(store, { model_type: "logreg", version: "logreg-v1", status: "CHAMPION", horizons: ["1h"], validation_samples: 120 });
  const champ1 = await getChampion(store, "logreg");
  const load1 = await loadChampionIntoRuntime(runtime, store, { champion: champ1 });
  check("首次装载 Champion 成功", load1.ok === true && runtime.currentVersion() === "logreg-v1", JSON.stringify(load1));
  const before = runtime.predict(runtimeRowFromAnalysis({ symbol: "BTCUSDT", interval: "1h", features: { rsi14: 70, adx: 30 } }, {}));
  check("旧模型可推理", before.ok === true && before.source === "ml:logreg-v1");

  // 2) 坏工件 → 不替换,旧模型继续工作(无需重启)
  const bad = toyArtifact();
  bad.model_version = "logreg-bad";
  bad.coef = [[1, 2, 3], [1, 2, 3], [1, 2, 3]];   // 特征维度与 encoder(2)不符,但截距长度合法
  const badRes = runtime.load({ artifact: bad, version: "logreg-bad", model_type: "logreg" });
  check("坏工件被拒", badRes.ok === false && badRes.swapped === false, JSON.stringify(badRes));
  eq("拒绝后保留旧模型版本", runtime.currentVersion(), "logreg-v1");
  eq("拒绝后返回 kept 指向旧模型", badRes.kept, "logreg-v1");
  const after = runtime.predict(runtimeRowFromAnalysis({ symbol: "BTCUSDT", interval: "1h", features: { rsi14: 70, adx: 30 } }, {}));
  check("失败后推理仍由旧模型提供(服务不中断)", after.ok === true && after.source === "ml:logreg-v1");
  eq("失败原因可追溯", runtime.status().last_error.reason, "coef_shape_mismatch:0");

  // 3) 好工件 → 原子替换(v2 与 v1 的系数方向相反,能明确区分"换没换")
  const v2 = toyArtifact();
  v2.model_version = "logreg-v2";
  // 与 v1 方向相反:看跌行对 RSI 正相关、看涨行负相关 → 高 RSI 由 Bullish 翻成 Bearish
  v2.coef = [[0.9, -0.1], [0, 0], [-0.9, 0.1]];
  v2.intercept = [-0.1, 0, 0.1];
  const swap = runtime.load({ artifact: v2, version: "logreg-v2", model_type: "logreg", horizon: "1h" });
  check("新工件的原子替换成功", swap.ok === true && swap.swapped === true && swap.from === "logreg-v1" && swap.to === "logreg-v2", JSON.stringify(swap));
  eq("替换后版本更新", runtime.currentVersion(), "logreg-v2");
  const p2 = runtime.predict(runtimeRowFromAnalysis({ symbol: "BTCUSDT", interval: "1h", features: { rsi14: 70, adx: 30 } }, {}));
  check("替换后推理立即改用新系数(方向翻转)", p2.source === "ml:logreg-v2" && p2.label === "Bearish" && before.label === "Bullish", `${before.label} → ${p2.label}`);
  eq("替换历史完整记录", runtime.swapLog().map((s) => s.ok), [true, false, true]);
  const status = runtime.status();
  check("运行时状态自描述", status.loaded === true && status.version === "logreg-v2" && status.features === 2 && status.swaps === 3, JSON.stringify(status));
  eq("运行时版本常量", ML_RUNTIME_VERSION, "ml-runtime-v14.3");

  // 4) 通过注册表 Champion 热替换(模拟"页面启动时装载")
  const runtime2 = createMlRuntime();
  await registerModel(store, { model_type: "logreg", version: "logreg-v3", status: "CHALLENGER", horizons: ["1h"], validation_samples: 130 });
  const v3 = toyArtifact();
  v3.model_version = "logreg-v3";
  await saveArtifact(store, v3, { model_type: "logreg", version: "logreg-v3" });
  await promoteModel(store, "logreg-logreg-v3", { reasons: ["通过:测试"], challenger: { version: "logreg-v3" } });
  const champ3 = await getChampion(store, "logreg");
  eq("注册表 Champion 已更新", champ3.version, "logreg-v3");
  const load3 = await loadChampionIntoRuntime(runtime2, store, { champion: champ3 });
  check("按注册表装载新 Champion", load3.ok === true && runtime2.currentVersion() === "logreg-v3", JSON.stringify(load3));

  // 5) 工件损坏 / 缺失 → 明确失败,不崩
  const corruptStore = memStore();
  await corruptStore.put(ML_ARTIFACT_TABLE, { artifact_id: "logreg:broken", model_type: "logreg", version: "broken", payload: "{not json" });
  const corrupt = await loadArtifact(corruptStore, "logreg", "broken");
  eq("工件 JSON 损坏被识别", corrupt.reason, "artifact_corrupt");
  const missing = await loadArtifact(corruptStore, "xgboost", "none");
  eq("工件不存在被识别", missing.reason, "artifact_not_found");
  const runtime3 = createMlRuntime();
  const noChamp = await loadChampionIntoRuntime(runtime3, store, { champion: null });
  check("无 Champion 时明确返回 no_champion", noChamp.ok === false && noChamp.reason === "no_champion" && runtime3.hasModel() === false);
}

console.log("== F. 融合生效 + 页面接线 ==");
{
  // ml 非空时,融合权重里 ML 参与打分(35%)
  const analysis = { symbol: "BTCUSDT", direction: "Neutral", signal_strength: 50, confidence: 50 };
  const risk = { risk_score: 30, veto: false, reasons: [] };
  const evidence = evidenceBundle(analysis, null);
  const mlBull = toFusionMl(fallbackPrediction({ rule_score: 0, bull_score: 0.9, bear_score: 0.1, risk_score: 30 }));
  const withMl = fuse({ analysis, ml: mlBull, risk, evidence });
  const withoutMl = fuse({ analysis, ml: null, risk, evidence });
  check("ML 参与后融合分数被拉动", withMl.score > withoutMl.score, `${withMl.score} > ${withoutMl.score}`);
  eq("融合结果标记 ML 已使用", withMl.components.ml != null, true);
  check("mlScore 可读取概率差", mlScore(mlBull) > 0);
  eq("mlScore 对 null 返回 null(引擎仍可判缺失)", mlScore(null), null);

  const pageSrc = fs.readFileSync(path.join(ROOT, "worker/src/ui/page.js"), "utf8");
  eq("运行时实例由 createMlRuntime 创建", /const mlRuntime = QE\.createMlRuntime\(\)/.test(pageSrc), true);
  eq("决策处不再硬编码 ml:null(详情)", /QE\.fuse\(\{ analysis, ml: mlResolved \? QE\.toFusionMl\(mlResolved\) : null/.test(pageSrc), true);
  eq("决策处不再硬编码 ml:null(Paper Loop)", /QE\.fuse\(\{ analysis, ml: QE\.toFusionMl\(paperMl\(analysis, risk, evidence\)\)/.test(pageSrc), true);
  check("页面不再出现 ml: null 字面量", !/ml: null/.test(pageSrc));
  check("启动即装载 Champion", /void refreshChampion\(false\)/.test(pageSrc));
  check("工件导入入口存在", pageSrc.includes('id="mlArtifactFile"') && /saveArtifact/.test(pageSrc));
  check("晋升按钮走 校验 → 落库 → 原子替换", /mlArtifactPromote/.test(pageSrc) && /QE\.validateArtifact\(artifact\)/.test(pageSrc) && /mlRuntime\.load\(/.test(pageSrc));
  check("替换失败时明确提示保留旧模型", /替换失败\(.*继续使用旧模型/.test(pageSrc));
  check("注册表写入 registerModel", /QE\.registerModel\(/.test(pageSrc));
  check("推理来源/版本/替换次数在 UI 可见", ["mlRuntimeSource", "mlRuntimeVersion", "mlRuntimeSwaps"].every((id) => pageSrc.includes(`id="${id}"`)));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("ML RUNTIME TESTS OK");
