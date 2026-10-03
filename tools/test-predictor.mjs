// tools/test-predictor.mjs · V14.4 Future Direction Predictor 测试
// A 概率分布形态(不是简单涨跌)  B 多周期分别建模  C 波动/结构类预测
// D 预测不是交易命令  E 防未来数据  F 校准  G 结果追踪  H Champion 门禁  I 页面/引擎接线
import fs from "node:fs";
import path from "node:path";
import {
  PREDICTOR_VERSION, PREDICTOR_HORIZONS, SHORT_HORIZONS, LONG_HORIZONS, HORIZON_WEIGHTS, EXTERNAL_TILT_CAP,
  ruleTilt, tfTilt, structureTilt, momentumTilt, volumeTilt, regimeTilt, btcTilt, externalTilt,
  volatilityForecast, structureForecast, predictHorizon, predictMultiHorizon,
  buildCalibrationTable, calibrationFactor, applyCalibration, isOverconfident,
  predictionRecord, resolvePrediction, calibrationSamples, evaluatePredictorPromotion, summarizePredictions
} from "../worker/src/paper/predictor.js";
import { buildExternalContext, fundingContext } from "../worker/src/paper/externalData.js";
import { createPaperEngine } from "../worker/src/paper/engine.js";
import { createHistoryStore } from "../worker/src/history/store.js";

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

const T0 = 1700000000000;
// 一份"真实形状"的分析快照(与 computeAnalysis 输出同构)
function bullAnalysis(overrides) {
  return {
    symbol: "BTCUSDT", interval: "1h",
    direction: "Strong Bullish", signal_strength: 78, confidence: 70, risk_score: 28, risk_level: "Low",
    market_regime: { label: "Uptrend", trend_market: true, vol_state: "Normal", adx: 30, atr_pct: 1.2, bb_width_pct: 2.4 },
    timeframes: { "15m": "Bullish", "1h": "Strong Bullish", "4h": "Bullish" },
    tf_conflict: false,
    structure: { label: "上涨结构", hh: true, hl: true, lh: false, ll: false },
    volume: { pattern: "放量上涨", ratio20: 1.4, spike: false },
    volatility: { level: "Normal", atrPct: 1.2, bbWidthPct: 2.4, ratio: 1.05 },
    anomaly: { detected: false, kinds: [] },
    btc_context: { state: "Bullish", corr: 0.85, rel_strength: 0.2 },
    breadth: { up_pct: 62 },
    features: { rsi14: 62, macd_hist: 0.6, adx: 30, atr_pct: 1.2, ema20_dist_pct: 0.8, roc9: 0.9, volume_ratio20: 1.4, bb_width_pct: 2.4 },
    limited_data: false,
    ...(overrides || {})
  };
}
function bearAnalysis() {
  return bullAnalysis({
    direction: "Strong Bearish", signal_strength: 24,
    market_regime: { label: "Downtrend", trend_market: true, vol_state: "Expansion", adx: 32, atr_pct: 2.2, bb_width_pct: 3.4 },
    timeframes: { "15m": "Bearish", "1h": "Strong Bearish", "4h": "Bearish" },
    structure: { label: "下降结构", hh: false, hl: false, lh: true, ll: true },
    volume: { pattern: "放量下跌", ratio20: 1.5, spike: true },
    btc_context: { state: "BTC Rapid Selloff", corr: 0.9, rel_strength: -0.3 },
    features: { rsi14: 34, macd_hist: -0.7, adx: 32, atr_pct: 2.2, ema20_dist_pct: -1.4, roc9: -1.2, volume_ratio20: 1.5, bb_width_pct: 3.4 }
  });
}

console.log("== A. 概率分布(不是简单涨跌) ==");
const bullPred = predictHorizon({ horizon: "1h", analysis: bullAnalysis(), now: T0 });
check("预测成功且带版本", bullPred.ok === true && bullPred.model_version === PREDICTOR_VERSION, JSON.stringify(bullPred).slice(0, 120));
const probSum = bullPred.bullish_probability + bullPred.neutral_probability + bullPred.bearish_probability;
near("三类概率和为 1(四位小数取整容差)", probSum, 1, 1e-3);
check("看涨证据下 P(bull) 最大", bullPred.bullish_probability > bullPred.bearish_probability && bullPred.bullish_probability > bullPred.neutral_probability, JSON.stringify([bullPred.bullish_probability, bullPred.neutral_probability, bullPred.bearish_probability]));
check("输出契约字段齐全(§1)", ["horizon", "bullish_probability", "neutral_probability", "bearish_probability", "expected_move_pct", "expected_range_pct", "confidence", "uncertainty"].every((k) => bullPred[k] != null), Object.keys(bullPred).join(","));
check("置信度 + 不确定性 = 1 附近", Math.abs(bullPred.confidence + bullPred.uncertainty - 1) < 0.35, String(bullPred.confidence + bullPred.uncertainty));
const bearPred = predictHorizon({ horizon: "1h", analysis: bearAnalysis(), now: T0 });
check("看跌证据下 P(bear) 最大", bearPred.bearish_probability > bearPred.bullish_probability, JSON.stringify([bearPred.bullish_probability, bearPred.bearish_probability]));
const neutralPred = predictHorizon({ horizon: "1h", analysis: bullAnalysis({ direction: "Neutral", signal_strength: 50, timeframes: { "15m": "Neutral", "1h": "Neutral" }, structure: { label: "区间", hh: false, hl: false, lh: false, ll: false }, volume: { pattern: "量能平稳", ratio20: 1 }, market_regime: { label: "Range", adx: 15 }, features: {} }), now: T0 });
check("中性证据下 P(neutral) 最大", neutralPred.neutral_probability > neutralPred.bullish_probability && neutralPred.neutral_probability > neutralPred.bearish_probability, JSON.stringify(neutralPred));
check("预期波动 > 0 且合理", bullPred.expected_range_pct > 0.02 && bullPred.expected_range_pct < 60, String(bullPred.expected_range_pct));
check("方向性预期幅度 ≤ 预期波动", bullPred.expected_move_pct <= bullPred.expected_range_pct + 1e-9, JSON.stringify([bullPred.expected_move_pct, bullPred.expected_range_pct]));
check("组件可解释(每一项都有 key/weight/note)", bullPred.components.length >= 5 && bullPred.components.every((c) => c.key && c.weight != null), JSON.stringify(bullPred.components.map((c) => c.key)));

console.log("== B. 多周期:分别建模、分别保存(§2) ==");
check("短周期组 = 15m/1h/4h", JSON.stringify(SHORT_HORIZONS) === JSON.stringify(["15m", "1h", "4h"]), JSON.stringify(SHORT_HORIZONS));
check("长周期组 = 4h/1d/3d", JSON.stringify(LONG_HORIZONS) === JSON.stringify(["4h", "1d", "3d"]), JSON.stringify(LONG_HORIZONS));
check("短/长权重不同(禁止一套结果套用所有未来)", JSON.stringify(HORIZON_WEIGHTS.short) !== JSON.stringify(HORIZON_WEIGHTS.long));
const multi = predictMultiHorizon({ analysis: bullAnalysis(), now: T0 });
eq("五个周期全部产出", Object.keys(multi.predictions).sort(), ["15m", "1d", "1h", "3d", "4h"].sort());
const keysShort = Object.keys(HORIZON_WEIGHTS.short);
check("短周期权重重动能/量能", HORIZON_WEIGHTS.short.momentum > HORIZON_WEIGHTS.long.momentum && HORIZON_WEIGHTS.short.volume > HORIZON_WEIGHTS.long.volume);
check("长周期权重重环境/宏观", HORIZON_WEIGHTS.long.regime > HORIZON_WEIGHTS.short.regime && HORIZON_WEIGHTS.long.external > HORIZON_WEIGHTS.short.external, JSON.stringify({ s: HORIZON_WEIGHTS.short, l: HORIZON_WEIGHTS.long }));
eq("4h 归属 short 组(与 spec 一致)", PREDICTOR_HORIZONS["4h"].group, "short");
eq("3d 归属 long 组", PREDICTOR_HORIZONS["3d"].group, "long");
check("不同周期的预期波动不同(sqrt 时间缩放)", multi.predictions["15m"].expected_range_pct < multi.predictions["1d"].expected_range_pct, JSON.stringify([multi.predictions["15m"].expected_range_pct, multi.predictions["1d"].expected_range_pct]));
check("未知周期被拒绝", predictHorizon({ horizon: "7m", analysis: bullAnalysis() }).ok === false);

console.log("== C. 不只预测方向(§5) ==");
check("四类结构预测齐全", ["trend_persistence", "reversal_risk", "breakout_probability", "mean_reversion_probability"].every((k) => bullPred[k] != null && bullPred[k] >= 0 && bullPred[k] <= 1), JSON.stringify([bullPred.trend_persistence, bullPred.reversal_risk, bullPred.breakout_probability, bullPred.mean_reversion_probability]));
const trendStrong = predictHorizon({ horizon: "1h", analysis: bullAnalysis({ market_regime: { label: "Strong Uptrend", trend_market: true, adx: 40 }, features: { rsi14: 58, adx: 40, volume_ratio20: 1.5 } }) });
const trendWeak = predictHorizon({ horizon: "1h", analysis: bullAnalysis({ market_regime: { label: "Range", adx: 12 }, features: { rsi14: 50, adx: 12, volume_ratio20: 0.8 } }) });
check("强趋势 → 趋势持续性更高", trendStrong.trend_persistence > trendWeak.trend_persistence, JSON.stringify([trendStrong.trend_persistence, trendWeak.trend_persistence]));
check("区间环境 → 均值回归概率更高", trendWeak.mean_reversion_probability > trendStrong.mean_reversion_probability, JSON.stringify([trendStrong.mean_reversion_probability, trendWeak.mean_reversion_probability]));
const rsiExtreme = predictHorizon({ horizon: "1h", analysis: bullAnalysis({ features: { rsi14: 88, ema20_dist_pct: 4.5, bb_width_pct: 1.0, volume_ratio20: 1.0 } }) });
check("RSI 极值 + 过度偏离 → 反转风险升高", rsiExtreme.reversal_risk > bullPred.reversal_risk, JSON.stringify([rsiExtreme.reversal_risk, bullPred.reversal_risk]));
const compressed = predictHorizon({ horizon: "1h", analysis: bullAnalysis({ features: { bb_width_pct: 0.6, volume_ratio20: 1.8, rsi14: 55 } }) });
check("波动压缩 + 量能抬升 → 突破概率升高", compressed.breakout_probability > bullPred.breakout_probability, JSON.stringify([compressed.breakout_probability, bullPred.breakout_probability]));
// 波动率预告:squar-root 缩放
{
  const r1 = volatilityForecast({ atrPct: 1, hours: 1 });
  const r4 = volatilityForecast({ atrPct: 1, hours: 4 });
  near("预期波动按 sqrt(时间) 缩放(4h = 2×1h)", r4.expected_range_pct, r1.expected_range_pct * 2, 1e-6);
  const comp = volatilityForecast({ atrPct: 1, hours: 1, volState: "Compression" });
  const exp = volatilityForecast({ atrPct: 1, hours: 1, volState: "Expansion" });
  check("压缩态预期波动更小、扩张态更大", comp.expected_range_pct < r1.expected_range_pct && exp.expected_range_pct > r1.expected_range_pct, JSON.stringify([comp.expected_range_pct, r1.expected_range_pct, exp.expected_range_pct]));
}

console.log("== D. 预测不是交易命令(§3) ==");
eq("预测结果不携带 action", bullPred.action, null);
check("带明确免责说明", /不构成交易指令/.test(bullPred.note), bullPred.note);
const pageHasNoDirectOpen = !/prediction.*open_long|open_long.*prediction/i.test(bullPred.note);
check("预测文案不含开仓指令字样", pageHasNoDirectOpen);
// 组件方向性:单个偏多组件不能决定整体(需要加权)
{
  const onlyBtc = predictHorizon({ horizon: "1h", analysis: bullAnalysis({ direction: "Neutral", signal_strength: 50, timeframes: { "15m": "Neutral" }, structure: { label: "区间" }, volume: { pattern: "量能平稳", ratio20: 1 }, market_regime: { label: "Range", adx: 12 }, features: {} }) });
  check("单一 BTC 偏多不足以给出高看涨概率", onlyBtc.bullish_probability < 0.6, String(onlyBtc.bullish_probability));
}

console.log("== E. 防未来数据 / 无随机 ==");
{
  const a = predictHorizon({ horizon: "1h", analysis: bullAnalysis() });
  const b = predictHorizon({ horizon: "1h", analysis: bullAnalysis() });
  eq("同一输入必得同一输出(无随机)", [a.bullish_probability, a.bearish_probability, a.confidence], [b.bullish_probability, b.bearish_probability, b.confidence]);
  const src = fs.readFileSync(path.join(ROOT, "worker/src/paper/predictor.js"), "utf8");
  check("predictor.js 不含随机数", !/Math\.random/.test(src));
  check("predictor.js 不自行取数/重算历史(只吃快照)", !/fetch\(|getKlines|XMLHttpRequest/.test(src));
  eq("动量组件只读快照特征", momentumTilt({ features: { rsi14: 60 } }) > 0, true);
  eq("无特征时动量中性", momentumTilt({}), 0);
  // 组件本身:各方向函数的上界
  check("所有组件被夹在 [-1,1]", [ruleTilt(bullAnalysis()), tfTilt(bullAnalysis()), structureTilt(bullAnalysis()), momentumTilt(bullAnalysis()), volumeTilt(bullAnalysis()), regimeTilt(bullAnalysis()), btcTilt(bullAnalysis())].every((v) => v >= -1 && v <= 1));
}

console.log("== F. 外部情报只是小幅倾斜(§6/§17/§21) ==");
{
  const noExt = externalTilt(null);
  eq("无外部情报时倾斜为 0", noExt.value, 0);
  const crowded = buildExternalContext({
    now: T0,
    funding: { rate: 0.002, prev_rate: 0.001 },       // 极端正费率:多头拥挤
    oi: { open_interest: 120, prev_open_interest: 100, price_change_pct: 1 },
    news: [{ summary: "etf inflow record", published_at: T0 - 3600000, sentiment: "bullish", importance: 80, confidence: 80, source_kind: "official", source_id: "project_official" }]
  });
  const tilt = externalTilt(crowded);
  check("外部倾斜被硬上限夹住(不能单独决定)", Math.abs(tilt.value) <= EXTERNAL_TILT_CAP + 1e-9, String(tilt.value));
  const extOnly = predictHorizon({ horizon: "15m", analysis: bullAnalysis({ direction: "Neutral", signal_strength: 50, timeframes: {}, structure: { label: "区间" }, volume: { pattern: "量能平稳", ratio20: 1 }, market_regime: { label: "Range", adx: 10 }, features: {} }), external: crowded });
  check("仅靠外部情报无法产生强方向(≤0.6)", Math.max(extOnly.bullish_probability, extOnly.bearish_probability) < 0.62, JSON.stringify([extOnly.bullish_probability, extOnly.bearish_probability]));
  // §21:过期新闻不参与
  const stale = buildExternalContext({ now: T0, news: [{ summary: "old news", published_at: T0 - 5 * 86400000, sentiment: "bullish", source_kind: "official", source_id: "project_official" }] });
  eq("3 天前的新闻不参与决策", stale.news_context.available, false);
  eq("过期新闻原因可追溯", stale.news_context.reason, "all_items_stale_or_unusable");
  // 资金费极端 → Crowding Risk,不是继续看涨
  const fc = fundingContext({ rate: 0.002, prev_rate: 0.0005 });
  check("极端正费率被标为拥挤风险", fc.extreme === true && fc.direction === "longs_pay" && fc.crowding_risk >= 80, JSON.stringify(fc));
  const crowdedTilt = externalTilt({ funding_context: fc, overall: { freshness: 1 } });
  check("多头拥挤时倾斜不为正(不解读为继续看涨)", crowdedTilt.value <= 0, JSON.stringify(crowdedTilt));
}

console.log("== G. 校准(§4) ==");
{
  // 构造:模型说 0.7 的桶里实际只有 0.4 命中 → 过度自信
  const overconf = [];
  for (let i = 0; i < 100; i += 1) overconf.push({ probability: 0.7 + (i % 5) * 0.01, expected_class: "Bullish", actual: i < 40 ? "Bullish" : "Bearish" });
  const table = buildCalibrationTable(overconf);
  const bucket = table.buckets["7"];
  check("桶内样本被统计", bucket && bucket.n >= 40, JSON.stringify(bucket));
  near("桶内实际命中率 ≈ 0.4", bucket.realized, 0.4, 0.02);
  const cal = calibrationFactor(table, 0.72);
  check("过度自信 → 置信度系数 < 1", cal.factor < 1, JSON.stringify(cal));
  const oc = isOverconfident(table);
  check("被判定为过度自信", oc.overconfident === true, JSON.stringify(oc));
  const adjusted = applyCalibration(predictHorizon({ horizon: "1h", analysis: bullAnalysis() }), table);
  check("校准后置信度下降", adjusted.confidence < bullPred.confidence, JSON.stringify([adjusted.confidence, bullPred.confidence]));
  check("校准后仍满足概率归一", Math.abs(adjusted.bullish_probability + adjusted.neutral_probability + adjusted.bearish_probability - 1) < 1e-6, JSON.stringify(adjusted));
  check("校准痕迹可追溯", adjusted.calibration && adjusted.calibration.applied === true && adjusted.model_version.endsWith("+cal"), JSON.stringify(adjusted.calibration));
  // 校准良好时不应压低
  const good = [];
  for (let i = 0; i < 100; i += 1) good.push({ probability: 0.7, expected_class: "Bullish", actual: i < 70 ? "Bullish" : "Bearish" });
  const goodTable = buildCalibrationTable(good);
  const goodCal = calibrationFactor(goodTable, 0.7);
  near("校准良好时系数 ≈ 1", goodCal.factor, 1, 0.05);
  eq("样本不足的桶不做修正", calibrationFactor(buildCalibrationTable([{ probability: 0.7, expected_class: "Bullish", actual: "Bullish" }]), 0.7).factor, 1);
}

console.log("== H. 结果追踪(§26/§78) ==");
{
  const pred = predictHorizon({ horizon: "1h", analysis: bullAnalysis() });
  const rec = predictionRecord(pred, { symbol: "BTCUSDT", timestamp: T0, price: 100 });
  check("预测记录含全部必需字段(§26)", ["prediction_timestamp", "horizon", "probabilities", "expected_range_pct", "model_version"].every((k) => rec[k] != null), JSON.stringify(rec).slice(0, 160));
  eq("未结算时明确 resolved=false 且实际值为 null", [rec.resolved, rec.actual_direction, rec.actual_return_pct], [false, null, null]);
  // 上涨 3%(超过噪声阈值)→ 实际 Bullish
  const up = resolvePrediction(rec, { price_start: 100, price_end: 103, high: 103.5, low: 99.8, atr_pct: 1, interval_ms: 3600000, horizon_ms: 3600000, now: T0 + 3600000 });
  eq("到期结算为 Bullish", up.record.actual_direction, "Bullish");
  near("实际收益 3%", up.record.actual_return_pct, 3, 1e-6);
  eq("预测为看涨且实际上涨 → correct", up.record.correct, true);
  check("记录 Brier 分数", up.record.brier_score != null && up.record.brier_score >= 0, String(up.record.brier_score));
  const flat = resolvePrediction(rec, { price_start: 100, price_end: 100.1, high: 100.2, low: 99.9, atr_pct: 1, interval_ms: 3600000, horizon_ms: 3600000, now: T0 + 3600000 });
  eq("微幅波动落在噪声区 → Neutral", flat.record.actual_direction, "Neutral");
  const down = resolvePrediction(rec, { price_start: 100, price_end: 97, high: 100.2, low: 96.5, atr_pct: 1, interval_ms: 3600000, horizon_ms: 3600000, now: T0 + 3600000 });
  eq("下跌 → Bearish 且判为 wrong", [down.record.actual_direction, down.record.correct], ["Bearish", false]);
  check("结算记录实际波动率", down.record.actual_volatility_pct > 0, String(down.record.actual_volatility_pct));
  eq("非法路径被拒", resolvePrediction(rec, { price_start: 0, price_end: 0 }).ok, false);
  eq("无记录时被拒", resolvePrediction({}, {}).reason, "no_record");
  // 校准样本提取
  const samples = calibrationSamples([up.record, down.record, flat.record, rec]);
  eq("只抽取已结算样本", samples.length, 3);
  check("样本概率落在预测类上", samples.every((s) => s.probability > 0 && s.probability <= 1), JSON.stringify(samples));
  // 汇总
  const sum = summarizePredictions([up.record, down.record, flat.record]);
  eq("汇总样本数", sum.samples, 3);
  check("方向准确率 ≈ 1/3", Math.abs(sum.direction_accuracy - 1 / 3) < 1e-3, String(sum.direction_accuracy));
  check("汇总含稳定性指标", sum.stability != null, JSON.stringify(sum));
  eq("样本不足时校准缺口如实为 null(不猜测)", sum.calibration_gap, null);
  // 样本充足(单桶 ≥30)时校准缺口应可算
  {
    const many = [];
    for (let i = 0; i < 80; i += 1) {
      const r = { ...up.record, brier_score: 0.4, correct: i % 2 === 0, actual_direction: i % 2 === 0 ? "Bullish" : "Bearish" };
      many.push(r);
    }
    const sum2 = summarizePredictions(many);
    eq("80 条同周期样本", sum2.samples, 80);
    check("样本充足后校准缺口可算", sum2.calibration_gap != null && sum2.calibration_gap >= 0, JSON.stringify(sum2));
    check("Brier 为均值", Math.abs(sum2.brier - 0.4) < 1e-6, String(sum2.brier));
  }
}

console.log("== I. Champion / Challenger 门禁(§27) ==");
{
  const strong = {
    version: "predictor-v2", validation_samples: 400, folds: 5, direction_accuracy: 0.55, brier: 0.58,
    calibration_gap: 0.04, stability: 0.82, recent_holdout: { samples: 60 }, per_regime: { Uptrend: { samples: 60, direction_accuracy: 0.54 } }
  };
  const champion = { version: "predictor-v1", direction_accuracy: 0.5, brier: 0.62, per_regime: { Uptrend: { samples: 60, direction_accuracy: 0.5 } } };
  const promote = evaluatePredictorPromotion({ challenger: strong, champion });
  eq("更优的挑战者被批准晋级", promote.promote, true);
  check("晋级理由可追溯", promote.reasons.length > 0 && promote.reasons.every((r) => r.startsWith("通过")), JSON.stringify(promote.reasons));
  const weak = { ...strong, validation_samples: 40, brier: 0.7 };
  const reject = evaluatePredictorPromotion({ challenger: weak, champion });
  eq("样本不足/更差的挑战者被拒绝", reject.promote, false);
  check("拒绝原因含样本与 Brier", reject.reasons.some((r) => /验证样本不足/.test(r)) && reject.reasons.some((r) => /Brier 未改善/.test(r)), JSON.stringify(reject.reasons));
  const noBrier = evaluatePredictorPromotion({ challenger: { ...strong, brier: null }, champion });
  eq("缺少 Brier 对照不晋级", noBrier.promote, false);
  const overfit = evaluatePredictorPromotion({ challenger: { ...strong, calibration_gap: 0.3 }, champion });
  eq("校准缺口过大不晋级", overfit.promote, false);
  const unstable = evaluatePredictorPromotion({ challenger: { ...strong, stability: 0.3 }, champion });
  eq("稳定性不足不晋级", unstable.promote, false);
  const regress = evaluatePredictorPromotion({ challenger: { ...strong, per_regime: { Uptrend: { samples: 60, direction_accuracy: 0.2 } } }, champion });
  eq("某 Regime 明显恶化不晋级", regress.promote, false);
  const noHoldout = evaluatePredictorPromotion({ challenger: { ...strong, recent_holdout: { samples: 5 } }, champion });
  eq("Recent Holdout 不足不晋级", noHoldout.promote, false);
}

console.log("== J. 引擎接线:预测只存不交易 ==");
{
  const store = await createHistoryStore({ memory: true });
  let clock = T0;
  const eng = createPaperEngine({
    store: { get: (t, k) => store.generic.get(t, k), all: (t) => store.generic.all(t), put: (t, r) => store.generic.put(t, r) },
    now: () => clock,
    riskCheck: () => ({ veto: false }),
    fetchKlines: async () => []
  });
  await eng.init();
  const pred = predictHorizon({ horizon: "1h", analysis: bullAnalysis(), now: clock });
  const saved = await eng.savePrediction(pred, { symbol: "BTCUSDT", timestamp: clock, price: 42000 });
  check("引擎可保存预测", saved && saved.prediction_id && saved.resolved === false, JSON.stringify(saved).slice(0, 120));
  eq("未到期不结算", (await eng.resolveDuePredictions({ now: clock + 60000, priceOf: () => 43000 })).length, 0);
  clock += 3600000 + 1000;
  const resolved = await eng.resolveDuePredictions({ now: clock, priceOf: () => 43260, atrPct: 1.2 });
  eq("到期后结算 1 条", resolved.length, 1);
  check("结算方向为 Bullish(42000→43260 = +3%)", resolved[0] && resolved[0].actual_direction === "Bullish", JSON.stringify(resolved[0] && resolved[0].actual_direction));
  eq("重复结算不再产出", (await eng.resolveDuePredictions({ now: clock, priceOf: () => 43260 })).length, 0);
  eq("已结算清单可读", eng.resolvedPredictions().length, 1);
  // 关键:预测不产生任何订单
  eq("存预测不产生订单", eng.getOrders().length, 0);
  eq("存预测不改变持仓", eng.getPositions().length, 0);
  // 引擎源码里预测不参与下单判定
  const engineSrc = fs.readFileSync(path.join(ROOT, "worker/src/paper/engine.js"), "utf8");
  check("引擎中预测只用于回撤/利润锁的上下文,不直接开仓", !/prediction\.bullish_probability\s*>\s*0\.5\s*\)\s*\{?\s*await\s+openPosition/.test(engineSrc));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("PREDICTOR TESTS OK");
