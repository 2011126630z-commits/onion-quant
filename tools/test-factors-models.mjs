// tools/test-factors-models.mjs · V16 因子工厂 / 模型调度 / 集合预测 测试
// 核心主张:因子必须有可量化的预测力与衰减管理;多模型不能把"同一个想法"当多份证据;
//           情景预测必须确定性可复现、概率归一、方差大时拒绝开仓。
// 骨架完全照抄 tools/test-funding.mjs,但直接从源码 import(不经 worker/index.js)。
import {
  FACTOR_FACTORY_VERSION, FACTOR_GROUPS, FACTOR_REGISTRY, FACTOR_MIN_SAMPLES,
  FACTOR_DEDUPE_CORR, FACTOR_DECAY_STREAK, FACTOR_DECAY_FACTOR, FACTOR_DECAY_RATIO,
  factorRegistryView, efficacyOf, rankFactors, factorCorrelation, dedupeFactors,
  applyFactorDrift, createFactorStates, factorCenterView
} from "../worker/src/paper/factors.js";
import {
  META_SCHEDULER_VERSION, MODEL_KINDS, MODEL_ZH, META_REGIMES, META_REGIME_ZH,
  REGIME_MODEL_WEIGHTS, META_OVERLAP_THRESHOLD, META_PRED_CORR_THRESHOLD,
  featureOverlap, predictionCorrelation, detectFakeConsensus, metaSchedule, combineModels, metaView
} from "../worker/src/paper/modelScheduler.js";
import {
  ENSEMBLE_VERSION, SCENARIO_TYPES, SCENARIO_ZH, ENSEMBLE_MAX_DISPERSION, ENSEMBLE_ACTION_ZH,
  buildScenarios, ensembleForecast, ensembleGate, ensembleView
} from "../worker/src/paper/ensemble.js";

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
const CN = /[\u4e00-\u9fa5]/;
const isCn = (s) => typeof s === "string" && CN.test(s);

const REQUIRED_KEYS = [
  "returns", "momentum", "distance_to_ma", "trend_slope", "breakout_strength", "atr",
  "realized_volatility", "volatility_change", "wick_ratio", "volume_change", "volume_trend",
  "volume_breakout", "taker_imbalance", "funding", "funding_change", "open_interest", "oi_change",
  "long_short_ratio", "btc_context", "market_breadth", "regime", "correlation", "spread",
  "estimated_slippage", "fee_drag", "mfe", "mae", "holding_time", "profit_giveback",
  "freshness", "missing_rate", "provider_conflict"
];

// 100 条样本:momentum 与 forward_return 完全正相关;volume_change 完全负相关;atr 仅有 5 条
const S = [];
for (let i = 0; i < 100; i += 1) {
  const x = i - 50;
  const s = { features: { momentum: x, volume_change: -x }, forward_return_pct: x * 0.1, direction: x >= 0 ? "LONG" : "SHORT" };
  if (i < 5) s.features.atr = x;
  S.push(s);
}
// 40 条样本:momentum_dup 与 momentum 完全重复;wick_ratio 近似独立
const D = [];
for (let i = 0; i < 40; i += 1) {
  const x = i - 20;
  D.push({ features: { momentum: x, momentum_dup: x, wick_ratio: Math.sin(i * 2.399) }, forward_return_pct: x * 0.1, direction: "LONG" });
}

console.log("== A. 因子注册表与视图(必须覆盖全部关键因子) ==");
{
  eq("版本号", FACTOR_FACTORY_VERSION, "factor-factory-v1.0");
  eq("分组数量", Object.keys(FACTOR_GROUPS).length, 8);
  eq("注册表条数", FACTOR_REGISTRY.length, 32);
  const keys = FACTOR_REGISTRY.map((f) => f.key);
  check("覆盖全部必需 key", REQUIRED_KEYS.every((k) => keys.includes(k)), REQUIRED_KEYS.filter((k) => !keys.includes(k)).join(","));
  check("无重复 key", new Set(keys).size === keys.length);
  check("每项都有中文名", FACTOR_REGISTRY.every((f) => isCn(f.zh)));
  check("每项都有 why(为什么可能有预测力)", FACTOR_REGISTRY.every((f) => isCn(f.why)));
  check("每项分组都合法", FACTOR_REGISTRY.every((f) => FACTOR_GROUPS[f.group] != null));
  eq("全量视图条数", factorRegistryView().length, 32);
  const atrView = factorRegistryView(["atr"]);
  eq("按 key 过滤", atrView.length, 1);
  eq("key 回填", atrView[0].key, "atr");
  eq("中文名回填", atrView[0].zh, "真实波幅 ATR");
  eq("分组中文回填", atrView[0].group_zh, "波动");
  check("视图 why 非空", isCn(atrView[0].why));
  eq("未知 key 被忽略", factorRegistryView(["no_such_factor"]).length, 0);
  eq("子集视图条数", factorRegistryView(["atr", "funding"]).length, 2);
}

console.log("== B. 单因子有效性(IC / 命中率 / 稳定性 / 衰减) ==");
{
  const mom = efficacyOf(S, "momentum");
  near("正相关因子 IC = +1", mom.ic, 1);
  check("IC 方向正确(>0)", mom.ic > 0);
  eq("样本数如实统计", mom.sample_count, 100);
  near("命中率 = 1", mom.hit_rate, 1);
  near("稳定性 = 1(三段同号)", mom.stability, 1);
  near("衰减比 = 1(近段未失效)", mom.decay, 1);
  eq("未被判衰减", mom.decayed, false);
  eq("默认 active", mom.active, true);
  near("权重 = |IC|×稳定性", mom.weight, 1);
  near("做多方向平均收益", mom.long_perf, 2.45);
  near("做空方向平均收益", mom.short_perf, -2.55);

  const vol = efficacyOf(S, "volume_change");
  near("负相关因子 IC = -1", vol.ic, -1);
  check("负相关因子 IC<0", vol.ic < 0);
  near("负相关因子命中率 = 0", vol.hit_rate, 0);

  const atr = efficacyOf(S, "atr");
  eq("样本不足的因子只统计到实际样本", atr.sample_count, 5);
  near("小样本也能算出 IC", atr.ic, 1);
  near("小样本稳定性(两段同号)", atr.stability, 1);

  eq("单样本 IC 无法计算 → null", efficacyOf(S.slice(0, 1), "momentum").ic, null);
  eq("3 样本稳定性无法分段 → null", efficacyOf(S.slice(0, 3), "momentum").stability, null);
  check("3 样本 IC 仍可算", Math.abs(efficacyOf(S.slice(0, 3), "momentum").ic - 1) < 1e-9);

  // 常数因子:零方差 → IC 无定义,必须 null 而不是假装 0 相关
  const constSamples = [];
  for (let i = 0; i < 6; i += 1) constSamples.push({ features: { regime: 1 }, forward_return_pct: i - 3, direction: "LONG" });
  eq("常数因子 IC = null", efficacyOf(constSamples, "regime").ic, null);
  eq("常数因子稳定性 = null", efficacyOf(constSamples, "regime").stability, null);
  eq("非法 forward_return 不计入样本", efficacyOf([{ features: { momentum: 1 }, forward_return_pct: NaN }], "momentum").sample_count, 0);
}

console.log("== C. 因子排名与样本降权 ==");
{
  const ranking = rankFactors(S);
  eq("排名条数 = 实际出现的因子数", ranking.length, 3);
  eq("最高分因子", ranking[0].factor, "momentum");
  eq("样本不足的因子排在最后", ranking[2].factor, "atr");
  near("样本因子线性 = 5/30", ranking[2].sample_factor, 5 / 30);
  eq("样本数如实", ranking[2].sample_count, 5);
  check("样本不足 → 分数被压低", ranking[2].score < ranking[0].score, ranking[2].score + " vs " + ranking[0].score);
  check("降序排列", ranking[0].score >= ranking[1].score && ranking[1].score >= ranking[2].score);
  near("满样本因子不打折", ranking[0].sample_factor, 1);
  near("分数 = |IC|×稳定性×样本因子", ranking[2].score, 1 * 1 * (5 / 30));
  const loose = rankFactors(S, { minSamples: 5 });
  near("自定义 minSamples 时样本因子回满", loose.find((r) => r.factor === "atr").sample_factor, 1);
  eq("默认最小样本阈值", FACTOR_MIN_SAMPLES, 30);
}

console.log("== D. 因子相关性与去重 ==");
{
  near("完全重复因子相关性 = 1", factorCorrelation(D, "momentum", "momentum_dup"), 1);
  check("独立因子相关性低", Math.abs(factorCorrelation(D, "momentum", "wick_ratio")) < 0.5, factorCorrelation(D, "momentum", "wick_ratio"));
  eq("样本不足相关性 → null", factorCorrelation(D.slice(0, 1), "momentum", "wick_ratio"), null);

  const dd = dedupeFactors(D);
  check("保留主因子", dd.keep.includes("momentum"));
  check("保留独立因子", dd.keep.includes("wick_ratio"));
  eq("重复因子被丢弃 1 个", dd.dropped.length, 1);
  eq("丢弃的是重复因子", dd.dropped[0].key, "momentum_dup");
  eq("指明重复于谁", dd.dropped[0].duplicate_of, "momentum");
  near("记录相关性", dd.dropped[0].corr, 1);
  eq("去重阈值", FACTOR_DEDUPE_CORR, 0.95);
  eq("阈值随返回带出", dd.threshold, FACTOR_DEDUPE_CORR);
  eq("两个独立因子都不丢", dedupeFactors(D, { keys: ["momentum", "wick_ratio"] }).dropped.length, 0);
}

console.log("== E. 因子漂移状态机(衰减但绝不瞬间删除,且可恢复) ==");
{
  const st0 = createFactorStates(FACTOR_REGISTRY);
  eq("初始状态条数", Object.keys(st0).length, 32);
  eq("初始权重", st0.atr.weight, 1);
  eq("初始 active", st0.atr.active, true);
  eq("初始未衰减", st0.atr.decayed, false);
  eq("初始无影子时间", st0.atr.shadow_since, null);

  const decaying = [{ key: "atr", decay: 0.2 }, { key: "momentum", decay: 1.0 }];
  const s1 = applyFactorDrift(st0, decaying, { now: 1000 });
  eq("第 1 次衰减:仍 active", s1.atr.active, true);
  eq("第 1 次衰减:权重未动", s1.atr.weight, 1);
  eq("第 1 次衰减:计数 +1", s1.atr.decay_streak, 1);
  const s2 = applyFactorDrift(s1, decaying, { now: 1000 });
  eq("第 2 次衰减:仍未停用", s2.atr.active, true);
  eq("第 2 次衰减:计数 +1", s2.atr.decay_streak, 2);
  const s3 = applyFactorDrift(s2, decaying, { now: 1000 });
  eq("第 3 次衰减:触发停用", s3.atr.active, false);
  eq("第 3 次衰减:标记衰减", s3.atr.decayed, true);
  near("第 3 次衰减:权重 ×0.5", s3.atr.weight, 0.5);
  eq("第 3 次衰减:记录影子起点", s3.atr.shadow_since, 1000);
  eq("第 3 次衰减:计数到阈值", s3.atr.decay_streak, 3);
  check("衰减后条目仍在(不删除)", Object.prototype.hasOwnProperty.call(s3, "atr"));
  check("条目仍是完整对象", s3.atr && typeof s3.atr === "object" && "weight" in s3.atr);
  eq("衰减阈值常量", FACTOR_DECAY_STREAK, 3);
  eq("衰减乘数常量", FACTOR_DECAY_FACTOR, 0.5);
  eq("衰减判定比常量", FACTOR_DECAY_RATIO, 0.5);

  // 纯函数:输入不被就地修改,返回的是新对象
  eq("原始状态未被改动-权重", st0.atr.weight, 1);
  eq("原始状态未被改动-active", st0.atr.active, true);
  eq("原始状态未被改动-计数", st0.atr.decay_streak, 0);
  check("返回新对象", s3 !== st0);

  const healthy = [{ key: "atr", decay: 1.0 }, { key: "momentum", decay: 1.0 }];
  const s4 = applyFactorDrift(s3, healthy, { now: 2000 });
  eq("恢复后回到 active", s4.atr.active, true);
  eq("恢复后清空影子时间", s4.atr.shadow_since, null);
  eq("恢复后清掉衰减标记", s4.atr.decayed, false);
  eq("恢复后计数清零", s4.atr.decay_streak, 0);
  near("恢复不自动回补权重(避免抖动)", s4.atr.weight, 0.5);
  eq("未衰减的因子一直 active", s3.momentum.active, true);
  eq("未衰减的因子权重不变", s3.momentum.weight, 1);
}

console.log("== F. 因子中心中文视图 ==");
{
  const st = createFactorStates(FACTOR_REGISTRY);
  const decaying = [{ key: "atr", decay: 0.2 }];
  let cur = st;
  for (let i = 0; i < 3; i += 1) cur = applyFactorDrift(cur, decaying, { now: 555 });
  const view = factorCenterView(cur, [efficacyOf(S, "momentum"), efficacyOf(S, "atr")]);
  eq("active 计数", view.active_count, 31);
  eq("影子计数", view.shadow_count, 1);
  eq("视图行数", view.rows.length, 32);
  check("每行中文名非空", view.rows.every((r) => isCn(r.zh)));
  const atrRow = view.rows.find((r) => r.key === "atr");
  const momRow = view.rows.find((r) => r.key === "momentum");
  eq("影子因子标为近期衰减", atrRow.decayed_zh, "近期衰减");
  eq("影子因子 active=false", atrRow.active, false);
  near("影子因子权重透出", atrRow.weight, 0.5);
  eq("正常因子标为表现正常", momRow.decayed_zh, "表现正常");
  near("IC 透传到视图", momRow.ic, 1);
  near("稳定性透传到视图", momRow.stability, 1);
  near("做多收益透传到视图", momRow.long_perf, 2.45);
  near("做空收益透传到视图", momRow.short_perf, -2.55);
  check("中文标签字段非空", isCn(atrRow.decayed_zh) && isCn(momRow.zh));
}

console.log("== G. 模型调度器(regime 加权 + 不可用置零) ==");
{
  eq("版本号", META_SCHEDULER_VERSION, "meta-scheduler-v1.0");
  eq("模型种类数", MODEL_KINDS.length, 9);
  check("每种模型都有中文名", MODEL_KINDS.every((k) => isCn(MODEL_ZH[k])));
  eq("regime 种类数", META_REGIMES.length, 5);
  check("每个 regime 都有中文名", META_REGIMES.every((r) => isCn(META_REGIME_ZH[r])));
  check("每个 regime 都有权重表", META_REGIMES.every((r) => REGIME_MODEL_WEIGHTS[r] != null));
  check("TREND_UP 下 TREND 权重高于 RANGE", REGIME_MODEL_WEIGHTS.TREND_UP.TREND > REGIME_MODEL_WEIGHTS.RANGE.TREND);
  check("RANGE 下 LOGREG 权重高于 TREND_UP", REGIME_MODEL_WEIGHTS.RANGE.LOGREG > REGIME_MODEL_WEIGHTS.TREND_UP.LOGREG);

  const models = [
    { kind: "TREND", available: true, features: ["ma", "slope"], bull: 0.7, bear: 0.2, confidence: 0.8 },
    { kind: "LOGREG", available: true, features: ["rsi", "ret"], bull: 0.5, bear: 0.4, confidence: 0.6 },
    { kind: "LIGHTGBM", available: false, features: ["ma"], bull: 0.9, bear: 0.1, confidence: 0.5 }
  ];
  const a = metaSchedule({ regime: "TREND_UP", signals: { funding_anomaly: true }, models });
  eq("不可用模型权重为 0", a.weights.LIGHTGBM, 0);
  eq("缺席模型权重为 0", a.weights.RULE, 0);
  check("可用趋势模型获得权重", a.weights.TREND > 0);
  const normSum = MODEL_KINDS.reduce((s, k) => s + a.normalized[k], 0);
  near("归一化权重和为 1", normSum, 1);
  check("TREND 归一权重高于 LOGREG", a.normalized.TREND > a.normalized.LOGREG);
  check("notes 非空且是中文", a.notes.length > 0 && a.notes.every((n) => isCn(n)));
  check("notes 提到不可用置零", a.notes.some((n) => n.includes("不可用")));
  eq("独立证据数(两模型特征不重叠)", a.independent_count, 2);

  const der = metaSchedule({
    regime: "UNKNOWN",
    signals: { funding_anomaly: true, oi_anomaly: false, flow_anomaly: true },
    models: [
      { kind: "DERIVATIVE", available: true, features: ["funding"], bull: 0.4, bear: 0.4 },
      { kind: "FLOW", available: true, features: ["taker"], bull: 0.4, bear: 0.4 }
    ]
  });
  check("资金费/持仓异常抬高衍生品权重", der.weights.DERIVATIVE > REGIME_MODEL_WEIGHTS.UNKNOWN.DERIVATIVE, String(der.weights.DERIVATIVE));
  check("资金流异常抬高资金流权重", der.weights.FLOW > REGIME_MODEL_WEIGHTS.UNKNOWN.FLOW, String(der.weights.FLOW));
  check("异常信号写入 notes", der.notes.some((n) => n.includes("衍生品") || n.includes("资金流")));

  eq("未知 regime 回退 UNKNOWN", metaSchedule({ regime: "WHATEVER", models: [] }).regime, "UNKNOWN");
  const empty = metaSchedule({ regime: "RANGE", models: [] });
  eq("无模型时归一权重全 0", MODEL_KINDS.reduce((s, k) => s + empty.normalized[k], 0), 0);
  eq("无模型时独立证据 0", empty.independent_count, 0);
}

console.log("== H. 伪共识检测(同一想法算多遍必须被识别) ==");
{
  eq("特征重叠阈值", META_OVERLAP_THRESHOLD, 0.8);
  eq("预测相关阈值", META_PRED_CORR_THRESHOLD, 0.9);
  near("同样特征重叠 = 1", featureOverlap({ features: ["a", "b"] }, { features: ["b", "a"] }), 1);
  eq("无交集重叠 = 0", featureOverlap({ features: ["a"] }, { features: ["b"] }), 0);
  near("部分重叠 = 0.5", featureOverlap({ features: ["ma", "slope"] }, { features: ["ma"] }), 0.5);
  eq("无特征重叠 = 0", featureOverlap({ features: [] }, { features: [] }), 0);
  near("相同预测序列相关 = 1", predictionCorrelation([1, 2, 3, 4], [1, 2, 3, 4]), 1);
  eq("长度不等 → null", predictionCorrelation([1, 2, 3], [1, 2]), null);
  eq("样本不足 → null", predictionCorrelation([1], [1]), null);

  const trio = ["RULE", "LOGREG", "LIGHTGBM"].map((k) => ({ kind: k, available: true, features: ["a", "b"], bull: 0.9, bear: 0.1 }));
  const fc = detectFakeConsensus(trio);
  eq("三个同特征模型判为伪共识", fc.fake, true);
  eq("三个同特征模型独立证据 = 1", fc.independent_count, 1);
  eq("并成一组", fc.groups.length, 1);
  eq("组内有 3 个模型", fc.groups[0].length, 3);
  check("给出中文原因", isCn(fc.reason_zh));

  const independent = [
    { kind: "RULE", available: true, features: ["a"], bull: 0.5, bear: 0.5 },
    { kind: "LOGREG", available: true, features: ["b", "c"], bull: 0.5, bear: 0.5 }
  ];
  const fc2 = detectFakeConsensus(independent);
  eq("两个独立模型不是伪共识", fc2.fake, false);
  eq("两个独立模型独立证据 = 2", fc2.independent_count, 2);

  const byCorr = [
    { kind: "RULE", available: true, features: ["a"], history: [1, 2, 3, 4, 5] },
    { kind: "LOGREG", available: true, features: ["b"], history: [1, 2, 3, 4, 5] }
  ];
  eq("特征不同但预测高相关 → 也判伪共识", detectFakeConsensus(byCorr).independent_count, 1);

  const withUnavail = detectFakeConsensus([
    { kind: "RULE", available: true, features: ["a"] },
    { kind: "GHOST", available: false, features: ["a"] }
  ]);
  eq("不可用模型不参与共识", withUnavail.available_count, 1);
  eq("不可用模型不进组", withUnavail.independent_count, 1);
}

console.log("== I. 模型合成(先组内平均再加权,不是简单投票) ==");
{
  const four = [
    { kind: "RULE", available: true, features: ["a", "b"], bull: 0.9, bear: 0.1 },
    { kind: "LOGREG", available: true, features: ["a", "b"], bull: 0.9, bear: 0.1 },
    { kind: "LIGHTGBM", available: true, features: ["a", "b"], bull: 0.9, bear: 0.1 },
    { kind: "RF", available: true, features: ["x", "y"], bull: 0.3, bear: 0.1 }
  ];
  const cm = combineModels(four, { RULE: 1, LOGREG: 1, LIGHTGBM: 1, RF: 1 });
  near("三胞胎 + 独立模型:牛概率 = 0.6", cm.bull, 0.6, 1e-9);
  near("熊概率取组均值", cm.bear, 0.1, 1e-9);
  near("中性 = 1 - bull - bear", cm.neutral, 0.3, 1e-9);
  near("概率和为 1", cm.bull + cm.neutral + cm.bear, 1);
  eq("独立证据数 = 2", cm.independent_count, 2);
  check("三胞胎未被算三倍(若按票数会到 0.75)", cm.bull < 0.7, String(cm.bull));
  eq("贡献者列出全部可用模型", cm.contributors.length, 4);
  near("weights_used 和为 1", Object.values(cm.weights_used).reduce((s, v) => s + v, 0), 1);
  near("三胞胎各分得组权重三分之一", cm.weights_used.RULE, cm.weights_used.RF / 3);
  near("分歧度 = 各模型 bull 的标准差", cm.dispersion, Math.sqrt(0.0675), 1e-9);
  const empty = combineModels([], {});
  eq("无模型时中性为 1", empty.neutral, 1);
  eq("无模型时独立证据 0", empty.independent_count, 0);

  const view = metaView(metaSchedule({ regime: "TREND_UP", signals: {}, models: four }));
  check("视图 regime 中文非空", isCn(view.regime_zh));
  check("视图行中文名非空", view.rows.every((r) => isCn(r.zh)));
  check("视图 summary 中文非空", isCn(view.summary_zh));
  check("视图伪共识中文非空", isCn(view.fake_consensus_zh));
  check("视图标注伪共识", view.fake_consensus === true);
}

console.log("== J. 集合预测:情景构造与确定性 ==");
{
  eq("版本号", ENSEMBLE_VERSION, "ensemble-v1.0");
  eq("情景种类数", SCENARIO_TYPES.length, 5);
  check("每种情景都有中文名", SCENARIO_TYPES.every((k) => isCn(SCENARIO_ZH[k])));
  check("每种动作都有中文名", Object.keys(ENSEMBLE_ACTION_ZH).every((k) => isCn(ENSEMBLE_ACTION_ZH[k])));
  eq("分散度上限常量", ENSEMBLE_MAX_DISPERSION, 0.35);

  const bullCtx = {
    regime: "TREND_UP",
    distribution: { bull: 0.97, neutral: 0.02, bear: 0.01 },
    atr_pct: 1.5, trend_strength: 0.95, funding_rate: 0.0001, uncertainty: 0.05
  };
  const scenarios = buildScenarios(bullCtx);
  eq("情景条数 = 5", scenarios.length, 5);
  eq("情景 key 顺序", scenarios.map((s) => s.key), SCENARIO_TYPES);
  const psum = scenarios.reduce((s, x) => s + x.probability, 0);
  near("概率和归一化到 1", psum, 1, 1e-9);
  check("概率非负", scenarios.every((s) => s.probability >= 0));
  check("每种情景中文名非空", scenarios.every((s) => isCn(s.zh)));
  check("每条路径起点为 0", scenarios.every((s) => s.path_shape[0] === 0));
  check("路径为有限数值序列", scenarios.every((s) => s.path_shape.length === 5 && s.path_shape.every((v) => Number.isFinite(v))));
  check("期望移动为有限数", scenarios.every((s) => Number.isFinite(s.expected_move_pct)));
  check("波动为有限数", scenarios.every((s) => Number.isFinite(s.volatility_pct)));

  const again = buildScenarios(bullCtx);
  eq("同一 ctx 两次调用完全一致", JSON.stringify(scenarios), JSON.stringify(again));
  const nullScenarios = buildScenarios(null);
  eq("空 ctx 也能给出 5 条情景", nullScenarios.length, 5);
  near("空 ctx 概率和仍为 1", nullScenarios.reduce((s, x) => s + x.probability, 0), 1, 1e-9);

  const hiCtx = {
    regime: "HIGH_VOL", distribution: { bull: 1 / 3, neutral: 1 / 3, bear: 1 / 3 },
    atr_pct: 3, trend_strength: 0, funding_rate: 0, uncertainty: 1
  };
  eq("高风险 ctx 也确定性可复现", JSON.stringify(ensembleForecast(hiCtx)), JSON.stringify(ensembleForecast(hiCtx)));
}

console.log("== K. 集合预测:期望/尾部/闸门 ==");
{
  const bullCtx = {
    regime: "TREND_UP",
    distribution: { bull: 0.97, neutral: 0.02, bear: 0.01 },
    atr_pct: 1.5, trend_strength: 0.95, funding_rate: 0.0001, uncertainty: 0.05
  };
  const hiCtx = {
    regime: "HIGH_VOL", distribution: { bull: 1 / 3, neutral: 1 / 3, bear: 1 / 3 },
    atr_pct: 3, trend_strength: 0, funding_rate: 0, uncertainty: 1
  };
  const bearCtx = {
    regime: "TREND_DOWN",
    distribution: { bull: 0.02, neutral: 0.03, bear: 0.95 },
    atr_pct: 2, trend_strength: -0.9, funding_rate: 0.0002, uncertainty: 0.3
  };

  const bull = ensembleForecast(bullCtx);
  near("多头情景期望移动 = +1.36%", bull.expected_move_pct, 1.36);
  check("多头情景分散度低于上限", bull.path_dispersion < ENSEMBLE_MAX_DISPERSION, String(bull.path_dispersion));
  eq("多头情景倾向做多", bull.action_bias, "LONG");
  check("上行尾部好于下行尾部", bull.upside_tail_pct > bull.downside_tail_pct);
  check("概率差在 [0,1]", bull.probability_gap >= 0 && bull.probability_gap <= 1);
  check("不确定性透传", bull.uncertainty >= 0 && bull.uncertainty <= 1);
  check("给出中文结论", isCn(bull.reason_zh));

  const gateBull = ensembleGate(bull);
  eq("多头情景闸门放行", gateBull.allow, true);
  check("多头情景仓位系数在 (0,1)", gateBull.scale > 0 && gateBull.scale < 1, String(gateBull.scale));
  eq("多头情景闸门码 OK", gateBull.code, "OK");

  const hi = ensembleForecast(hiCtx);
  check("高不确定性情景分散度超上限", hi.path_dispersion > ENSEMBLE_MAX_DISPERSION, String(hi.path_dispersion));
  eq("高不确定性情景倾向不交易", hi.action_bias, "NO_TRADE");
  const gateHi = ensembleGate(hi);
  eq("高分散度闸门拒绝", gateHi.allow, false);
  eq("拒绝码为高分散度", gateHi.code, "HIGH_DISPERSION");
  eq("拒绝时仓位系数为 0", gateHi.scale, 0);
  check("拒绝理由中文", isCn(gateHi.reason_zh));

  const bear = ensembleForecast(bearCtx);
  check("极端 bear 分布不倾向做多", bear.action_bias !== "LONG", bear.action_bias);
  eq("极端 bear 分布倾向做空", bear.action_bias, "SHORT");
  check("下行尾部为负", bear.downside_tail_pct < 0, String(bear.downside_tail_pct));
  const gateBear = ensembleGate(bear);
  eq("低分散度的空头情景被放行", gateBear.allow, true);
  check("分散度越低仓位系数越大", gateBear.scale > gateBull.scale, gateBear.scale + " vs " + gateBull.scale);

  eq("无预测结果时拒绝", ensembleGate(null).allow, false);
  eq("无预测结果拒绝码", ensembleGate(null).code, "NO_FORECAST");
  eq("自定义更严阈值可强制拒绝", ensembleGate(bull, { max_dispersion: 0.1 }).allow, false);
  eq("自定义上限带出拒绝码", ensembleGate(bull, { max_dispersion: 0.1 }).code, "HIGH_DISPERSION");
}

console.log("== L. 集合预测中文视图 ==");
{
  const bullCtx = {
    regime: "TREND_UP",
    distribution: { bull: 0.97, neutral: 0.02, bear: 0.01 },
    atr_pct: 1.5, trend_strength: 0.95, funding_rate: 0.0001, uncertainty: 0.05
  };
  const view = ensembleView(ensembleForecast(bullCtx));
  eq("标题中文", view.title_zh, "集合预测");
  check("标题非空中文", isCn(view.title_zh));
  check("行中文名非空", view.rows.every((r) => isCn(r.zh)));
  eq("视图行数 = 5", view.rows.length, 5);
  check("动作倾向中文非空", isCn(view.action_bias_zh));
  eq("动作倾向为做多", view.action_bias_zh, "做多");
  check("抬头中文非空", isCn(view.headline_zh));
  check("结论中文非空", isCn(view.reason_zh));
  check("分散度中文非空", isCn(view.dispersion_zh));
  check("概率百分比透出", view.rows.every((r) => Number.isFinite(r.probability_pct)));
  eq("空视图也返回安全对象", ensembleView(null).title_zh, "集合预测");
  check("空视图结论仍为中文", isCn(ensembleView(null).reason_zh));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("FACTORS/MODELS/ENSEMBLE TESTS OK");
