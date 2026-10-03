// tools/test-v161-shadow.mjs · V16.1 影子模块测试(因子影子 / 过度交易 / 新交易分析 / 入口闸门影子 / UI State Store)
// 核心主张:
//   A 因子影子化:新因子默认影子(权重 0);连续 3+3(+6) 次下滑逐级 WEAKENING→SHADOW→RETIRED 且权重恒为 0;恢复可回升;
//     高相关因子对只标 REDUNDANT 不删除;缺数据不产生 NaN。
//   B 过度交易:频率/反手/费用/早退任何一项异常都判定 spike,并【真的】自动收紧(门槛↑ 冷却↑ 上限↓)且有硬上限;
//     正常频率一律不变(0/1);空样本不产生 NaN。
//   C 新交易分析:Partial Close 不是独立母仓位(3 partial + 1 full = 1 母仓位);蚂蚁仓/Long 太短/费用吞噬等红旗可打靶。
//   D 入口闸门影子:反事实必须扣往返成本(否则"没亏手续费"会被误判成"躲过坏交易");样本不足 INSUFFICIENT;
//     save_rate 高不放松;只有"样本足够且几乎没救过我们"的 blocker 才建议放宽。
//   E UI Store:旧版本写入被拒绝;版本更大才通知;订阅隔离;unsubscribe 生效;patch 只合并顶层字段。
import {
  FACTOR_SHADOW_VERSION, FACTOR_SHADOW_STATES, FACTOR_SHADOW_ZH, FACTOR_SHADOW_STATE_WEIGHT,
  FACTOR_SHADOW_DECAY_STREAK, FACTOR_SHADOW_REDUNDANT_CORR, FACTOR_SHADOW_MIN_SAMPLES,
  createFactorShadowState, recordFactorObservation, factorIncrementalValue, markRedundantFactors,
  advanceFactorStates, factorShadowEligible, activeFactorWeights, factorShadowView
} from "../worker/src/paper/factorShadow.js";
import {
  OVERTRADING_VERSION, OVERTRADING_METRICS, OVERTRADING_METRIC_KEYS, OVERTRADING_SPIKE_MULTIPLE,
  OVERTRADING_FEE_DRAG_PCT, OVERTRADING_EARLY_EXIT_RATE, OVERTRADING_MAX_THRESHOLD_DELTA,
  OVERTRADING_MAX_COOLDOWN_MULTIPLIER, OVERTRADING_MIN_ENTRIES_PER_HOUR,
  overtradingStats, detectOvertrading, autoTighten, overtradingView
} from "../worker/src/paper/overtrading.js";
import {
  TRADE_ANALYSIS_VERSION, TRADE_ANALYSIS_MIN_MARGIN_USDT, TRADE_ANALYSIS_MIN_LONG_HOLD_MS,
  sessionAnalysis, dailyAnalysis, redFlagScan, tradeAnalysisView
} from "../worker/src/paper/tradeAnalysis.js";
import {
  ENTRY_GATE_SHADOW_VERSION, ENTRY_GATE_MIN_SAMPLES, ENTRY_GATE_ROUND_TRIP_COST_PCT,
  ENTRY_GATE_VERDICT_ZH, ENTRY_GATE_ADVICE_ZH,
  resolveSkippedOutcome, gateShadowEvaluate, calibrationAdvice, entryGateShadowView
} from "../worker/src/paper/entryGateShadow.js";
import {
  UI_STORE_VERSION, UI_BUCKETS, UI_BUCKET_ZH, UI_STORE_REJECT,
  createUiStore, shouldRender, uiStoreView
} from "../worker/src/ui/uiStore.js";

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
  check(name, typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual - expected) <= (tol == null ? 1e-9 : tol),
    `got ${actual} want ~${expected}`);
}
function noNaN(name, values) {
  const bad = Object.keys(values || {}).filter((k) => typeof values[k] === "number" && Number.isNaN(values[k]));
  check(name, bad.length === 0, bad.join(","));
}

const HOUR = 3600000;
const DAY = 86400000;
const T0 = 1700000000000;

console.log("== A. 因子影子 ==");
{
  // --- A1 创建:新因子一律影子 ---
  const registry = [
    { key: "momentum", zh: "动量强度", group: "price_trend" },
    { key: "funding", zh: "资金费率", group: "derivative" },
    { key: "volume_change", zh: "成交量变化", group: "volume_price" }
  ];
  const st = createFactorShadowState(registry, { now: T0 });
  eq("A1 版本号", st.version, FACTOR_SHADOW_VERSION);
  eq("A2 状态枚举", FACTOR_SHADOW_STATES, ["ACTIVE", "WEAKENING", "SHADOW", "RETIRED"]);
  eq("A3 中文映射含影子说明", FACTOR_SHADOW_ZH.SHADOW.includes("影子"), true);
  eq("A4 因子条目数", st.order.length, 3);
  eq("A5 新因子默认 SHADOW", st.factors.momentum.state, "SHADOW");
  eq("A6 新因子权重 0", st.factors.momentum.weight, 0);
  eq("A7 新因子不参与决策", factorShadowEligible(st.factors.momentum), false);
  eq("A8 初始影子计数", st.shadowed_count, 3);
  eq("A9 状态权重表:SHADOW=0", FACTOR_SHADOW_STATE_WEIGHT.SHADOW, 0);
  eq("A10 状态权重表:RETIRED=0", FACTOR_SHADOW_STATE_WEIGHT.RETIRED, 0);
  check("A11 状态权重表:ACTIVE>0", FACTOR_SHADOW_STATE_WEIGHT.ACTIVE > 0);
  eq("A12 无法计算权重时不产生可用因子", factorShadowEligible(null), false);

  // --- A2 观测聚合 ---
  const mom = st.factors.momentum;
  for (let i = 0; i < 30; i += 1) {
    const x = i % 2 ? 1 : -1;
    recordFactorObservation(st, {
      factor: "momentum", normalized_value: x, signal_direction: x > 0 ? "LONG" : "SHORT",
      confidence: 0.8, future_outcome_pct: x * (0.3 + 0.1 * (i % 3)), regime: "TREND", mode: "long", at: T0 + i
    });
  }
  eq("A13 样本累加", mom.samples, 30);
  near("A14 命中率 100%", mom.hit_rate, 1, 1e-9);
  check("A15 IC 为正且较高", mom.ic != null && mom.ic > 0.5, String(mom.ic));
  check("A16 多头平均方向收益为正", mom.long_perf > 0, String(mom.long_perf));
  eq("A17 空头无样本 → null", mom.short_perf, null);
  eq("A18 分市场状态样本", mom.per_regime.TREND.samples, 30);
  eq("A19 未回填计数", mom.unresolved, 0);
  eq("A20 最后观测时间", mom.last_at, T0 + 29);

  // --- A3 样本不足 / 缺数据 ---
  const vol = st.factors.volume_change;
  recordFactorObservation(st, { factor: "volume_change", normalized_value: 1.2, signal_direction: "LONG", future_outcome_pct: null, at: T0 });
  recordFactorObservation(st, { factor: "volume_change", normalized_value: -1.1, signal_direction: "LONG", future_outcome_pct: null, at: T0 + 1 });
  recordFactorObservation(st, { factor: "volume_change", normalized_value: null, signal_direction: "LONG", future_outcome_pct: 1, at: T0 + 2 });
  eq("A21 结果缺失 → 不计入样本", vol.samples, 0);
  eq("A22 结果缺失计入 unresolved", vol.unresolved, 2);
  eq("A23 因子值缺失计入 invalid", vol.invalid, 1);
  eq("A24 缺数据命中率为 null(不是 0)", vol.hit_rate, null);
  eq("A25 缺数据 IC 为 null", vol.ic, null);
  eq("A26 缺数据权重仍为 0", vol.weight, 0);
  noNaN("A27 缺数据不产生 NaN", { weight: vol.weight, samples: vol.samples, hit_rate: vol.hit_rate, ic: vol.ic });

  // funding 只有 2 个有效样本 → 低于判定门槛,不得改变状态
  for (let i = 0; i < 2; i += 1) {
    recordFactorObservation(st, { factor: "funding", normalized_value: i ? 0.5 : -0.5, signal_direction: "LONG", future_outcome_pct: 0.2, at: T0 + 50 + i });
  }
  eq("A28a 资金费因子样本数", st.factors.funding.samples, 2);

  const advSkip = advanceFactorStates(st, { now: T0 + 100, minSamples: FACTOR_SHADOW_MIN_SAMPLES + 1 });
  const skippedMom = advSkip.skipped.find((s) => s.key === "momentum");
  check("A28 窗口样本不足 → 本轮不判定", Boolean(skippedMom) && skippedMom.reason === "insufficient_recent_samples", JSON.stringify(advSkip.skipped));
  eq("A29 未判定不改状态", mom.state, "SHADOW");
  const skippedFund = advSkip.skipped.find((s) => s.key === "funding");
  eq("A30 样本太少因子被跳过", skippedFund.reason, "insufficient_recent_samples");
  eq("A30a 跳过时报告样本数", skippedFund.samples, 2);
  const skippedVol = advSkip.skipped.find((s) => s.key === "volume_change");
  eq("A30b 完全无有效样本的因子被跳过", skippedVol.reason, "no_recent_samples");
  eq("A30c 本轮无因子被判定", advSkip.evaluated, 0);

  // --- A4 升级:恢复 → WEAKENING → ACTIVE ---
  const bump1 = advanceFactorStates(st, { now: T0 + 200, minSamples: 30, recoverStreak: 1 });
  eq("A31 第一次恢复升级", mom.state, "WEAKENING");
  check("A32 WEAKENING 权重 > 0", mom.weight > 0, String(mom.weight));
  eq("A33 WEAKENING 可参与决策", factorShadowEligible(mom), true);
  eq("A34 升级被记录", bump1.changed.length, 1);
  eq("A35 升级原因", bump1.changed[0].reason, "recover");
  for (let i = 0; i < 30; i += 1) {
    const x = i % 2 ? 1 : -1;
    recordFactorObservation(st, {
      factor: "momentum", normalized_value: x, signal_direction: x > 0 ? "LONG" : "SHORT",
      confidence: 0.8, future_outcome_pct: x * (0.3 + 0.1 * (i % 3)), regime: "TREND", mode: "long", at: T0 + 300 + i
    });
  }
  advanceFactorStates(st, { now: T0 + 400, minSamples: 30, recoverStreak: 1 });
  eq("A36 再恢复 → ACTIVE", mom.state, "ACTIVE");
  check("A37 ACTIVE 权重 > 0", mom.weight > 0, String(mom.weight));

  // --- A5 衰减 3 + 3 + 6 ---
  let t = T0 + 1000;
  function feedBad(n) {
    for (let i = 0; i < n; i += 1) {
      recordFactorObservation(st, {
        factor: "momentum", normalized_value: 1, signal_direction: "LONG",
        confidence: 0.5, future_outcome_pct: -1, regime: "CHOP", mode: "long", at: t
      });
      t += 1;
    }
  }
  feedBad(3);
  advanceFactorStates(st, { now: t, minSamples: 3, recoverStreak: 1 });
  eq("A38 下滑 1 次不改状态", mom.state, "ACTIVE");
  eq("A39 下滑计数", mom.weaker_streak, 1);
  feedBad(3);
  advanceFactorStates(st, { now: t, minSamples: 3, recoverStreak: 1 });
  eq("A40 下滑 2 次仍不改", mom.state, "ACTIVE");
  eq("A41 下滑计数 2", mom.weaker_streak, 2);
  feedBad(3);
  advanceFactorStates(st, { now: t, minSamples: 3, recoverStreak: 1 });
  eq("A42 连续 3 次下滑 → WEAKENING", mom.state, "WEAKENING");
  eq("A43 阈值常量 = 3", FACTOR_SHADOW_DECAY_STREAK, 3);
  check("A44 WEAKENING 仍有权重", mom.weight > 0, String(mom.weight));
  eq("A45 衰减标记", mom.decayed, true);
  feedBad(3);
  advanceFactorStates(st, { now: t, minSamples: 3, recoverStreak: 1 });
  feedBad(3);
  advanceFactorStates(st, { now: t, minSamples: 3, recoverStreak: 1 });
  feedBad(3);
  const adv6 = advanceFactorStates(st, { now: t, minSamples: 3, recoverStreak: 1 });
  eq("A46 累计 6 次下滑 → SHADOW", mom.state, "SHADOW");
  eq("A47 SHADOW 权重必须为 0", mom.weight, 0);
  eq("A48 SHADOW 不参与决策", factorShadowEligible(mom), false);
  eq("A49 SHADOW 事件被记录", adv6.changed.length, 1);
  eq("A50 影子因子未进入决策权重表", activeFactorWeights(st).momentum, undefined);
  let adv12 = null;
  for (let i = 0; i < 6; i += 1) {
    feedBad(18);
    adv12 = advanceFactorStates(st, { now: t, minSamples: 3, recoverStreak: 1 });
  }
  eq("A51 累计 12 次下滑 → RETIRED", mom.state, "RETIRED");
  eq("A52 退役标记", mom.retired, true);
  eq("A53 RETIRED 权重 0", mom.weight, 0);
  eq("A54 退役事件记录", adv12.changed[0].to, "RETIRED");

  // --- A6 恢复回升(退役后) ---
  for (let i = 0; i < 30; i += 1) {
    const x = i % 2 ? 1 : -1;
    recordFactorObservation(st, {
      factor: "momentum", normalized_value: x, signal_direction: x > 0 ? "LONG" : "SHORT",
      confidence: 0.9, future_outcome_pct: x * (0.4 + 0.1 * (i % 3)), regime: "TREND", mode: "long", at: t + i
    });
  }
  t += 100;
  advanceFactorStates(st, { now: t, minSamples: 30, recoverStreak: 1 });
  eq("A55 恢复一级 RETIRED→SHADOW", mom.state, "SHADOW");
  eq("A56 恢复后退役标记清除", mom.retired, false);
  eq("A57 恢复后仍为影子(权重 0)", mom.weight, 0);
  for (let i = 0; i < 30; i += 1) {
    const x = i % 2 ? 1 : -1;
    recordFactorObservation(st, {
      factor: "momentum", normalized_value: x, signal_direction: x > 0 ? "LONG" : "SHORT",
      confidence: 0.9, future_outcome_pct: x * (0.4 + 0.1 * (i % 3)), regime: "TREND", mode: "long", at: t + i
    });
  }
  t += 100;
  advanceFactorStates(st, { now: t, minSamples: 30, recoverStreak: 1 });
  eq("A58 再恢复 → WEAKENING", mom.state, "WEAKENING");
  check("A59 恢复后权重重新 > 0", mom.weight > 0, String(mom.weight));

  // --- A7 增量价值 ---
  const useful = [];
  for (let i = 0; i < 40; i += 1) {
    if (i % 2 === 0) useful.push({ factors: { momentum: 1 }, signal_direction: "LONG", future_outcome_pct: 1 });
    else useful.push({ factors: {}, signal_direction: "LONG", future_outcome_pct: -1 });
  }
  const inc = factorIncrementalValue(useful, "momentum", { minSamples: 30 });
  eq("A60 有该因子显著更好 → USEFUL", inc.verdict, "USEFUL");
  near("A61 with 命中率", inc.with.hit_rate, 1, 1e-9);
  eq("A62 without 命中率", inc.without.hit_rate, 0);
  near("A63 delta", inc.delta, 1, 1e-9);
  eq("A64 样本数", inc.samples, 40);
  const incFew = factorIncrementalValue(useful.slice(0, 5), "momentum", { minSamples: 30 });
  eq("A65 样本不足 → INSUFFICIENT", incFew.verdict, "INSUFFICIENT");
  eq("A66 INSUFFICIENT 带样本数", incFew.samples, 5);
  eq("A67 INSUFFICIENT 无结论值", incFew.delta, null);
  const redundantRows = [];
  for (let i = 0; i < 40; i += 1) {
    if (i % 2 === 0) redundantRows.push({ factors: { momentum: 1 }, signal_direction: "LONG", future_outcome_pct: -1 });
    else redundantRows.push({ factors: {}, signal_direction: "SHORT", future_outcome_pct: -1 });
  }
  const incRed = factorIncrementalValue(redundantRows, "momentum", { minSamples: 30 });
  eq("A68 有该因子更差 → REDUNDANT", incRed.verdict, "REDUNDANT");
  const incEmpty = factorIncrementalValue([], "momentum", {});
  eq("A69 空样本 → INSUFFICIENT", incEmpty.verdict, "INSUFFICIENT");

  // --- A8 冗余标记 ---
  const st2 = createFactorShadowState([{ key: "a" }, { key: "b" }, { key: "c" }], { now: T0 });
  const corrFn = (x, y) => ((x === "a" && y === "b") ? 0.95 : 0.05);
  const mark = markRedundantFactors(st2, corrFn, { threshold: FACTOR_SHADOW_REDUNDANT_CORR });
  eq("A70 高相关阈值常量", FACTOR_SHADOW_REDUNDANT_CORR, 0.9);
  eq("A71 后者被标 REDUNDANT", st2.factors.b.redundant, true);
  eq("A72 记录 redundant_of", st2.factors.b.redundant_of, "a");
  eq("A73 冗余因子不被删除", Object.keys(st2.factors).length, 3);
  eq("A74 未被标记的因子保持干净", st2.factors.c.redundant, false);
  eq("A75 标记清单", mark.marked.length, 1);
  eq("A76 冗余计数", st2.redundant_count, 1);
  const st3 = createFactorShadowState([{ key: "a" }, { key: "b" }], { now: T0 });
  markRedundantFactors((x, y) => 0.93, FACTOR_SHADOW_REDUNDANT_CORR, st3);
  eq("A77 兼容(corrFn, threshold, state) 调用", st3.factors.b.redundant, true);
  const cleared = markRedundantFactors(st2, () => 0.1, 0.9);
  eq("A78 相关度回落后清除标记", st2.factors.b.redundant, false);
  eq("A79 清除被记录", cleared.cleared.length, 1);
  const noFn = markRedundantFactors(st2, null, 0.9);
  eq("A80 缺少相关度函数 → 明确拒绝", noFn.reason, "no_correlation_fn");

  // --- A9 视图 ---
  const view = factorShadowView(st);
  eq("A81 视图包含全部因子", view.factors.length, 3);
  eq("A82 影子因子权重合计必须为 0", view.shadow_weight_total, 0);
  eq("A83 视图版本", view.version, FACTOR_SHADOW_VERSION);
  check("A84 视图含权重铁律说明", String(view.note_zh).includes("权重"), String(view.note_zh));
  const momRow = view.factors.find((f) => f.key === "momentum");
  eq("A85 视图状态中文", momRow.state_zh, FACTOR_SHADOW_ZH.WEAKENING);
  check("A86 视图含分市场状态", momRow.per_regime.length >= 1);
  eq("A87 空状态视图", factorShadowView(null), null);
}

console.log("== B. 过度交易 ==");
{
  function mkTrade(o) {
    return {
      trade_id: o.id, position_id: o.pid, parent_position_id: o.parent != null ? o.parent : o.pid,
      symbol: o.symbol || "BTCUSDT", side: o.side || "LONG", mode: o.mode || "short",
      entry_time: o.entry, exit_time: o.exit,
      holding_ms: o.holding != null ? o.holding : (o.exit - o.entry),
      fees: o.fees || 0, gross_pnl: o.gross || 0, net_pnl: o.net == null ? 0 : o.net,
      exit_reason: o.reason || "take_profit", partial: o.partial === true
    };
  }
  eq("B1 版本号", OVERTRADING_VERSION, "overtrading-v1.0");
  eq("B2 指标键固定为 8 个", Object.keys(OVERTRADING_METRICS).length, 8);
  eq("B3 指标键顺序固定", OVERTRADING_METRIC_KEYS,
    ["trades_per_hour", "positions_per_day", "avg_holding_ms", "median_holding_ms", "reentry_count", "direction_flip_count", "fee_drag_pct", "early_exit_rate"]);
  eq("B4 频率倍数阈值", OVERTRADING_SPIKE_MULTIPLE, 2.5);
  eq("B5 费用拖累阈值", OVERTRADING_FEE_DRAG_PCT, 35);
  eq("B6 早退率阈值", OVERTRADING_EARLY_EXIT_RATE, 0.6);

  // --- B1 正常频率:不变 ---
  const now = T0;
  const normal = [
    mkTrade({ id: "n1", pid: "P1", symbol: "BTCUSDT", entry: now - 4 * HOUR, exit: now - 3 * HOUR, holding: 2 * HOUR, fees: 0.25, gross: 10, net: 9.75 }),
    mkTrade({ id: "n2", pid: "P2", symbol: "ETHUSDT", entry: now - 3 * HOUR, exit: now - 2 * HOUR, holding: 2 * HOUR, fees: 0.25, gross: 10, net: 9.75 }),
    mkTrade({ id: "n3", pid: "P3", symbol: "SOLUSDT", entry: now - 2 * HOUR, exit: now - 1 * HOUR, holding: 2 * HOUR, fees: 0.25, gross: 10, net: 9.75 }),
    mkTrade({ id: "n4", pid: "P4", symbol: "XRPUSDT", entry: now - 1 * HOUR, exit: now - 0.5 * HOUR, holding: 2 * HOUR, fees: 0.25, gross: 10, net: 9.75 })
  ];
  const sNormal = overtradingStats(normal, { now: now, window_ms: 4 * HOUR });
  near("B7 频率 1 笔/小时", sNormal.trades_per_hour, 1, 1e-9);
  eq("B8 母仓位数", sNormal.mother_positions, 4);
  near("B9 平均持仓 2 小时", sNormal.avg_holding_ms, 2 * HOUR, 1e-6);
  near("B10 中位持仓 2 小时", sNormal.median_holding_ms, 2 * HOUR, 1e-6);
  eq("B11 无重复入场", sNormal.reentry_count, 0);
  eq("B12 无反手", sNormal.direction_flip_count, 0);
  near("B13 费用拖累 = 1/40 = 2.5%", sNormal.fee_drag_pct, 2.5, 1e-6);
  eq("B14 无早退", sNormal.early_exit_rate, 0);
  const dNormal = detectOvertrading(sNormal, { trades_per_hour: 1 });
  eq("B15 正常频率不判 spike", dNormal.spike, false);
  near("B16 ratio = 1", dNormal.ratio, 1, 1e-9);
  eq("B17 正常无理由", dNormal.reasons_zh.length, 0);
  const tNormal = autoTighten({ entry_threshold_delta: 0, cooldown_multiplier: 1, max_entries_per_hour: 12 }, sNormal, { baseline: { trades_per_hour: 1 } });
  eq("B18 未过度交易 → 门槛增量 0", tNormal.entry_threshold_delta, 0);
  eq("B19 未过度交易 → 冷却倍率 1", tNormal.cooldown_multiplier, 1);
  eq("B20 未过度交易 → 每小时上限不变", tNormal.max_entries_per_hour, 12);
  eq("B21 未过度交易 → applied=false", tNormal.applied, false);
  check("B22 未过度交易 → 中文说明", String(tNormal.reason_zh).includes("保持"));

  // --- B2 频率 5 倍 + 多项异常 ---
  const spike = [
    mkTrade({ id: "s1", pid: "S1", symbol: "BTCUSDT", side: "LONG", entry: now - 3600000, exit: now - 3540000, fees: 0.5, gross: 1, net: 0.5 }),
    mkTrade({ id: "s2", pid: "S2", symbol: "BTCUSDT", side: "SHORT", entry: now - 3000000, exit: now - 2940000, fees: 0.5, gross: -1, net: -1.5 }),
    mkTrade({ id: "s3", pid: "S3", symbol: "BTCUSDT", side: "LONG", entry: now - 2400000, exit: now - 2340000, fees: 0.5, gross: -1, net: -1.5 }),
    mkTrade({ id: "s4", pid: "S4", symbol: "BTCUSDT", side: "SHORT", entry: now - 1800000, exit: now - 1740000, fees: 0.5, gross: -1, net: -1.5 }),
    mkTrade({ id: "s5", pid: "S5", symbol: "ETHUSDT", side: "LONG", entry: now - 1200000, exit: now - 1140000, fees: 0.5, gross: 2, net: 1.5 }),
    mkTrade({ id: "s6", pid: "S6", symbol: "ETHUSDT", side: "SHORT", entry: now - 600000, exit: now - 540000, fees: 0.5, gross: -1, net: -1.5 })
  ];
  const sSpike = overtradingStats(spike, { now: now, window_ms: HOUR });
  near("B23 频率 6 笔/小时", sSpike.trades_per_hour, 6, 1e-9);
  eq("B24 反手 4 次", sSpike.direction_flip_count, 4);
  eq("B25 同标的重复入场 4 次", sSpike.reentry_count, 4);
  eq("B26 全部早退", sSpike.early_exit_rate, 1);
  near("B27 费用拖累 = 3/3 = 100%", sSpike.fee_drag_pct, 100, 1e-6);
  const dSpike = detectOvertrading(sSpike, { trades_per_hour: 1 });
  eq("B28 5 倍频率 → spike", dSpike.spike, true);
  near("B29 频率倍数 = 6", dSpike.ratio, 6, 1e-9);
  check("B30 含频率理由", dSpike.codes.indexOf("FREQUENCY_SPIKE") >= 0, JSON.stringify(dSpike.codes));
  check("B31 含反手理由", dSpike.codes.indexOf("DIRECTION_FLIP") >= 0, JSON.stringify(dSpike.codes));
  check("B32 含费用理由", dSpike.codes.indexOf("FEE_DRAG") >= 0, JSON.stringify(dSpike.codes));
  check("B33 含早退理由", dSpike.codes.indexOf("EARLY_EXIT") >= 0, JSON.stringify(dSpike.codes));
  check("B34 含重复入场理由", dSpike.codes.indexOf("REENTRY_LOOP") >= 0, JSON.stringify(dSpike.codes));
  check("B35 中文理由非空", dSpike.reasons_zh.length >= 5, String(dSpike.reasons_zh.length));
  const tSpike = autoTighten({ entry_threshold_delta: 0, cooldown_multiplier: 1, max_entries_per_hour: 12 }, sSpike, { baseline: { trades_per_hour: 1 } });
  eq("B36 自动收紧 applied", tSpike.applied, true);
  check("B37 门槛被提高", tSpike.entry_threshold_delta > 0, String(tSpike.entry_threshold_delta));
  check("B38 冷却被延长", tSpike.cooldown_multiplier > 1, String(tSpike.cooldown_multiplier));
  check("B39 每小时上限被降低", tSpike.max_entries_per_hour < 12, String(tSpike.max_entries_per_hour));
  check("B40 门槛增量不超硬上限", tSpike.entry_threshold_delta <= OVERTRADING_MAX_THRESHOLD_DELTA, String(tSpike.entry_threshold_delta));
  check("B41 冷却不超硬上限", tSpike.cooldown_multiplier <= OVERTRADING_MAX_COOLDOWN_MULTIPLIER, String(tSpike.cooldown_multiplier));
  check("B42 上限不低于硬下限", tSpike.max_entries_per_hour >= OVERTRADING_MIN_ENTRIES_PER_HOUR, String(tSpike.max_entries_per_hour));
  const tSpike2 = autoTighten(tSpike, sSpike, { baseline: { trades_per_hour: 1 } });
  eq("B43 重复收紧不叠加爆炸(门槛)", tSpike2.entry_threshold_delta, tSpike.entry_threshold_delta);
  eq("B44 重复收紧不叠加爆炸(上限)", tSpike2.max_entries_per_hour, tSpike.max_entries_per_hour);
  const tIdle = autoTighten(tSpike, sNormal, { baseline: { trades_per_hour: 1 } });
  eq("B45 恢复正常后不再收紧", tIdle.applied, false);

  // --- B3 空样本 ---
  const sEmpty = overtradingStats([], { now: now, window_ms: HOUR });
  noNaN("B46 空样本 8 个指标无 NaN", sEmpty);
  const emptyBad = OVERTRADING_METRIC_KEYS.filter((k) => typeof sEmpty[k] === "number" && Number.isNaN(sEmpty[k]));
  eq("B47 空样本无 NaN 明细", emptyBad, []);
  eq("B48 空样本频率 0", sEmpty.trades_per_hour, 0);
  eq("B49 空样本平均持仓 null", sEmpty.avg_holding_ms, null);
  eq("B50 空样本费用拖累 null", sEmpty.fee_drag_pct, null);
  eq("B51 空样本早退率 null", sEmpty.early_exit_rate, null);
  const sNull = overtradingStats([null, undefined, { fees: "x" }], {});
  noNaN("B52 脏数据不产生 NaN", { tph: sNull.trades_per_hour, hold: sNull.avg_holding_ms, drag: sNull.fee_drag_pct });
  const dEmpty = detectOvertrading(sEmpty, {});
  eq("B53 空样本不判 spike", dEmpty.spike, false);
  eq("B54 无基线时 ratio 为 null(不是 0)", dEmpty.ratio, null);
  const tEmpty = autoTighten(undefined, sEmpty, {});
  eq("B55 缺省 current 时阈值 0", tEmpty.entry_threshold_delta, 0);
  eq("B56 缺省 current 时冷却 1", tEmpty.cooldown_multiplier, 1);
  const bView = overtradingView(sSpike, tSpike);
  eq("B57 视图指标 8 行", bView.metrics.length, 8);
  eq("B58 视图 spike 标记", bView.spike, true);
  check("B59 视图含收紧说明", String(bView.tighten_zh).includes("收紧"), String(bView.tighten_zh));
  check("B60 视图含硬上限说明", String(bView.hard_limits_zh).includes("上限"));
}

console.log("== C. 交易分析(母仓位口径) ==");
{
  function mkEvent(o) {
    return {
      trade_id: o.id, position_id: o.pid, parent_position_id: o.parent, symbol: o.symbol || "BTCUSDT",
      side: o.side || "LONG", mode: o.mode || "short",
      entry_time: o.entry, exit_time: o.exit, holding_ms: o.holding != null ? o.holding : (o.exit - o.entry),
      fees: o.fees || 0, gross_pnl: o.gross, net_pnl: o.net,
      mfe: o.mfe, mae: o.mae, entry_margin: o.margin, leverage: o.leverage,
      leverage_source: o.levSource, entry_quality_score: o.eq, return_on_position_pct: o.rop,
      expected_net_edge_pct: o.expected,
      exit_reason: o.reason, partial: o.partial === true, position_event: o.partial === true
    };
  }
  eq("C1 版本号", TRADE_ANALYSIS_VERSION, "trade-analysis-v1.0");
  // 3 个部分平仓 + 1 个全平 = 1 个母仓位
  const dup = [
    mkEvent({ id: "trd_partial_P1_0", pid: "P1", parent: "P1", side: "LONG", partial: true, reason: "partial_take_profit_tp1", entry: T0, exit: T0 + 600000, fees: 0.4, gross: 2.4, net: 2, mfe: 3, mae: 0.5, margin: 20, eq: 70, levSource: "AUTO", rop: 10 }),
    mkEvent({ id: "trd_partial_P1_1", pid: "P1", parent: "P1", side: "LONG", partial: true, reason: "partial_take_profit_tp2", entry: T0, exit: T0 + 1200000, fees: 0.4, gross: 2.4, net: 2, mfe: 5, mae: 0.8, margin: 15, eq: 70, levSource: "AUTO", rop: 13 }),
    mkEvent({ id: "trd_partial_P1_2", pid: "P1", parent: "P1", side: "LONG", partial: true, reason: "partial_take_profit_tp3", entry: T0, exit: T0 + 1800000, fees: 0.4, gross: 2.4, net: 2, mfe: 6, mae: 1, margin: 10, eq: 70, levSource: "AUTO", rop: 20 }),
    mkEvent({ id: "trd_P1", pid: "P1", side: "LONG", reason: "take_profit", entry: T0, exit: T0 + 3600000, fees: 0.6, gross: 3.6, net: 3, mfe: 8, mae: 1.5, margin: 25, eq: 70, levSource: "MANUAL", rop: 12 })
  ];
  const a = sessionAnalysis(dup, { tradable_capital: 100 });
  eq("C2 3 partial + 1 full 只算 1 个母仓位", a.mother_positions, 1);
  eq("C3 成交事件数保留", a.events, 4);
  eq("C4 部分平仓次数", a.partial_events, 3);
  near("C5 平均部分平仓次数", a.partial_close_avg, 3, 1e-9);
  near("C6 母仓位净利合计", a.net_pnl, 9, 1e-9);
  near("C7 手续费合计", a.fees, 1.8, 1e-9);
  near("C8 入场保证金(取最大剩余口径)", a.avg_entry_margin, 25, 1e-9);
  near("C9 资金占比 = 25%", a.avg_allocation_pct, 25, 1e-9);
  near("C10 胜率", a.win_rate, 1, 1e-9);
  eq("C11 无亏损时盈亏比 null(不是 Infinity)", a.profit_factor, null);
  near("C12 费用拖累 = 1.8/10.8", a.fee_drag_pct, 16.6667, 1e-3);
  near("C13 MFE 取母仓位最大", a.mfe_avg, 8, 1e-9);
  near("C14 MAE 取母仓位最大", a.mae_avg, 1.5, 1e-9);
  near("C15 持仓时长 1 小时", a.avg_holding_ms, 3600000, 1e-6);
  eq("C16 退出原因分布按母仓位", a.exit_reason_dist, { take_profit: 1 });
  near("C17 入口质量分均值", a.avg_entry_quality, 70, 1e-9);
  eq("C18 杠杆来源分布", a.leverage_source_dist, { MANUAL: 1 });
  eq("C19 口径标注", a.caliber, "mother_position");
  eq("C20 无反向", a.direction_flip_count, 0);
  check("C21 小样本被标注", a.sample_sufficient === false);
  check("C22 红旗含小样本", a.flags.indexOf("SMALL_SAMPLE") >= 0, JSON.stringify(a.flags));
  check("C23 未误判蚂蚁仓", a.flags.indexOf("ANTS_POSITION") < 0, JSON.stringify(a.flags));
  check("C24 未误判费用吞噬", a.flags.indexOf("FEE_EATS_PROFIT") < 0, JSON.stringify(a.flags));
  check("C25 未误判盈利未保护", a.flags.indexOf("PROFIT_NOT_PROTECTED") < 0, JSON.stringify(a.flags));
  check("C26 未误判 Long 太短", a.flags.indexOf("LONG_TOO_SHORT") < 0, JSON.stringify(a.flags));

  // 蚂蚁仓
  const ants = [
    mkEvent({ id: "trd_ants_0", pid: "A1", side: "LONG", reason: "take_profit", entry: T0, exit: T0 + 3600000, fees: 0.1, gross: 0.3, net: 0.2, mfe: 0.4, mae: 0.1, margin: 3, eq: 60, levSource: "AUTO" })
  ];
  const aAnts = sessionAnalysis(ants, { tradable_capital: 100 });
  near("C27 蚂蚁仓保证金中位数", aAnts.median_entry_margin, 3, 1e-9);
  check("C28 蚂蚁仓红旗触发", aAnts.flags.indexOf("ANTS_POSITION") >= 0, JSON.stringify(aAnts.flags));
  const antsFlag = aAnts.flag_details.find((f) => f.code === "ANTS_POSITION");
  eq("C29 蚂蚁仓严重度 high", antsFlag.severity, "high");
  eq("C30 蚂蚁仓 evidence 带阈值", antsFlag.evidence.threshold_usdt, TRADE_ANALYSIS_MIN_MARGIN_USDT);
  const antsBig = sessionAnalysis([
    mkEvent({ id: "trd_big_0", pid: "B1", side: "LONG", reason: "take_profit", entry: T0, exit: T0 + 3600000, fees: 0.1, gross: 3, net: 2.9, mfe: 4, mae: 0.1, margin: 20, eq: 60 })
  ], { tradable_capital: 100 });
  check("C31 保证金 20U 不触发蚂蚁仓", antsBig.flags.indexOf("ANTS_POSITION") < 0, JSON.stringify(antsBig.flags));
  check("C32 阈值常量 5U", TRADE_ANALYSIS_MIN_MARGIN_USDT === 5);

  // Long 太短
  const shortLong = [
    mkEvent({ id: "trd_sl_0", pid: "L1", side: "LONG", reason: "stop_loss", entry: T0, exit: T0 + 600000, holding: 600000, fees: 0.1, gross: 1, net: 0.9, mfe: 1.2, mae: 0.1, margin: 20, eq: 60 })
  ];
  const aShortLong = sessionAnalysis(shortLong, { tradable_capital: 100 });
  near("C33 Long 平均持有 10 分钟", aShortLong.long_hold_avg_ms, 600000, 1e-6);
  check("C34 Long 太短红旗触发", aShortLong.flags.indexOf("LONG_TOO_SHORT") >= 0, JSON.stringify(aShortLong.flags));
  eq("C35 阈值常量 30 分钟", TRADE_ANALYSIS_MIN_LONG_HOLD_MS, 1800000);
  const longOk = sessionAnalysis([
    mkEvent({ id: "trd_lo_0", pid: "L2", side: "LONG", reason: "take_profit", entry: T0, exit: T0 + 3600000, fees: 0.1, gross: 2, net: 1.9, mfe: 2.5, mae: 0.1, margin: 20, eq: 60 })
  ], { tradable_capital: 100 });
  check("C36 持有 1 小时不触发 Long 太短", longOk.flags.indexOf("LONG_TOO_SHORT") < 0, JSON.stringify(longOk.flags));

  // 费用吞噬 + 盈利未保护
  const feeHeavy = [
    mkEvent({ id: "trd_fee_0", pid: "F1", side: "LONG", reason: "take_profit", entry: T0, exit: T0 + 3600000, fees: 5, gross: 10, net: 5, mfe: 12, mae: 1, margin: 20, eq: 60 })
  ];
  const aFee = sessionAnalysis(feeHeavy, { tradable_capital: 100 });
  near("C37 费用拖累 = 50%", aFee.fee_drag_pct, 50, 1e-6);
  check("C38 费用吞噬红旗触发", aFee.flags.indexOf("FEE_EATS_PROFIT") >= 0, JSON.stringify(aFee.flags));
  near("C39 MFE 捕获率", aFee.mfe_capture_ratio, 5 / 12, 1e-6);
  check("C40 盈利未保护红旗触发", aFee.flags.indexOf("PROFIT_NOT_PROTECTED") >= 0, JSON.stringify(aFee.flags));

  // 亏损乱跑 + 频繁反手
  const churn = [];
  for (let i = 0; i < 6; i += 1) {
    churn.push(mkEvent({
      id: "trd_churn_" + i, pid: "CH" + i, symbol: "BTCUSDT", side: i % 2 ? "SHORT" : "LONG",
      reason: "stop_loss", entry: T0 + i * 120000, exit: T0 + i * 120000 + 60000, holding: 60000,
      fees: 0.2, gross: -1, net: -1.2, mfe: 0.1, mae: 1.1, margin: 20, eq: 50
    }));
  }
  const aChurn = sessionAnalysis(churn, { tradable_capital: 100 });
  eq("C42 6 个母仓位", aChurn.mother_positions, 6);
  eq("C43 反手 5 次", aChurn.direction_flip_count, 5);
  check("C44 频繁反手红旗", aChurn.flags.indexOf("FREQUENT_FLIP") >= 0, JSON.stringify(aChurn.flags));
  check("C45 亏损乱跑红旗", aChurn.flags.indexOf("LOSSES_RUNNING") >= 0, JSON.stringify(aChurn.flags));
  near("C46 亏损占比", aChurn.loss_share, 1, 1e-9);
  near("C47 盈亏比 = 0(有亏损无盈利)", aChurn.profit_factor, 0, 1e-9);

  // 预期 vs 实际
  const expTrades = [
    mkEvent({ id: "trd_exp_0", pid: "E1", side: "LONG", reason: "take_profit", entry: T0, exit: T0 + 3600000, fees: 0.1, gross: 1, net: 0.9, mfe: 2, mae: 0.1, margin: 20, eq: 60, rop: -4, expected: 3 })
  ];
  const aExp = sessionAnalysis(expTrades, { tradable_capital: 100 });
  eq("C48 预期/实际样本数", aExp.expected_vs_actual_edge.samples, 1);
  near("C49 预期边际均值", aExp.expected_vs_actual_edge.expected_avg, 3, 1e-9);
  near("C50 实际收益均值", aExp.expected_vs_actual_edge.actual_avg, -4, 1e-9);
  near("C51 预期-实际差", aExp.expected_vs_actual_edge.delta, 7, 1e-9);

  // 空样本
  const aEmpty = sessionAnalysis([], {});
  eq("C52 空样本母仓位数 0", aEmpty.mother_positions, 0);
  eq("C53 空样本胜率 null", aEmpty.win_rate, null);
  eq("C54 空样本盈亏比 null", aEmpty.profit_factor, null);
  noNaN("C55 空样本无 NaN", { net: aEmpty.net_pnl, fees: aEmpty.fees, pf: aEmpty.profit_factor, wr: aEmpty.win_rate });
  check("C56 空样本有 NO_SAMPLES 红旗", aEmpty.flags.indexOf("NO_SAMPLES") >= 0, JSON.stringify(aEmpty.flags));
  const aNull = sessionAnalysis([null, "x", { net_pnl: "not-a-number" }], {});
  noNaN("C57 脏样本不产生 NaN", { net: aNull.net_pnl, fees: aNull.fees });

  // redFlagScan 直接调用
  const direct = redFlagScan({ mother_positions: 5, median_entry_margin: 2, avg_entry_margin: 2, tradable_capital: 100, fee_drag_pct: 90, mfe_total: 10, net_pnl: 0.5, mfe_capture_ratio: 0.05, avg_holding_ms: 60000, loss_share: 0.8, direction_flip_count: 6, long_hold_avg_ms: 60000, long_positions: 3, sample_sufficient: false }, {});
  const codes = direct.map((f) => f.code);
  check("C58 直接扫描:蚂蚁仓", codes.indexOf("ANTS_POSITION") >= 0, JSON.stringify(codes));
  check("C59 直接扫描:费用吞噬", codes.indexOf("FEE_EATS_PROFIT") >= 0, JSON.stringify(codes));
  check("C60 直接扫描:盈利未保护", codes.indexOf("PROFIT_NOT_PROTECTED") >= 0, JSON.stringify(codes));
  check("C61 直接扫描:亏损乱跑", codes.indexOf("LOSSES_RUNNING") >= 0, JSON.stringify(codes));
  check("C62 直接扫描:频繁反手", codes.indexOf("FREQUENT_FLIP") >= 0, JSON.stringify(codes));
  check("C63 直接扫描:Long 太短", codes.indexOf("LONG_TOO_SHORT") >= 0, JSON.stringify(codes));
  check("C64 每条红旗都有中文结论", direct.every((f) => typeof f.zh === "string" && f.zh.length > 0 && f.evidence != null));
  eq("C65 空分析直接扫描不产生结论", redFlagScan(null, {}).length, 0);
  eq("C66 严重度枚举合法", direct.every((f) => ["high", "medium", "low"].indexOf(f.severity) >= 0), true);

  // dailyAnalysis
  const dayMs = Date.parse("2024-01-01T00:00:00.000Z");
  const dayTrades = [
    mkEvent({ id: "trd_d1_0", pid: "D1", side: "LONG", reason: "take_profit", entry: dayMs + HOUR, exit: dayMs + 2 * HOUR, fees: 0.2, gross: 2, net: 1.8, mfe: 2.5, mae: 0.2, margin: 20, eq: 60 }),
    mkEvent({ id: "trd_d2_0", pid: "D2", side: "SHORT", reason: "take_profit", entry: dayMs + DAY + HOUR, exit: dayMs + DAY + 2 * HOUR, fees: 0.2, gross: 2, net: 1.8, mfe: 2.5, mae: 0.2, margin: 20, eq: 60 })
  ];
  const d1 = dailyAnalysis(dayTrades, dayMs + 12 * HOUR);
  eq("C67 单日只取当天母仓位", d1.mother_positions, 1);
  eq("C68 单日 key", d1.day_key, "2024-01-01");
  eq("C69 日边界为 UTC 整日", d1.day_boundary.start % DAY, 0);
  eq("C70 单日边界跨 1 天", d1.day_boundary.end - d1.day_boundary.start, DAY);
  const d1b = dailyAnalysis(dayTrades, "2024-01-01");
  eq("C71 字符串日期等价", d1b.mother_positions, 1);
  const d2 = dailyAnalysis(dayTrades, "2024-01-02");
  eq("C72 次日只取次日", d2.mother_positions, 1);
  eq("C73 次日方向", Object.keys(d2.leverage_source_dist)[0] != null, true);
  const dNone = dailyAnalysis(dayTrades, null);
  eq("C74 无法确定边界 → 空分析", dNone.mother_positions, 0);
  check("C75 无法确定边界有说明", String(dNone.note_zh).includes("日边界"), String(dNone.note_zh));
  const cView = tradeAnalysisView(a, a.flag_details);
  eq("C76 视图口径中文", cView.caliber_zh.includes("母仓位"), true);
  near("C77 视图胜率百分比", cView.win_rate_pct, 100, 1e-6);
  check("C78 视图含红旗中文", Array.isArray(cView.flags_zh));
  eq("C79 空分析视图 null", tradeAnalysisView(null), null);
}

console.log("== D. 入口闸门影子 ==");
{
  eq("D1 版本号", ENTRY_GATE_SHADOW_VERSION, "entry-gate-shadow-v1.0");
  eq("D2 最小样本常量", ENTRY_GATE_MIN_SAMPLES, 30);
  eq("D3 往返成本常量", ENTRY_GATE_ROUND_TRIP_COST_PCT, 0.1);
  const baseSkip = { entry_price: 100, would_be_direction: "LONG", blockers: ["LOW_ENTRY_SCORE"], at: T0 };

  const up = resolveSkippedOutcome(baseSkip, 102, { at: T0 + HOUR });
  eq("D4 做多后被 SKIP 的机会上涨 → SKIP_COST_US", up.verdict, "SKIP_COST_US");
  near("D5 反事实收益扣掉往返成本", up.counterfactual_pct, 1.9, 1e-9);
  near("D6 毛收益", up.gross_pct, 2, 1e-9);
  near("D7 成本等于默认往返成本", up.cost_pct, ENTRY_GATE_ROUND_TRIP_COST_PCT, 1e-9);
  eq("D8 已回填", up.resolved, true);
  eq("D9 中文结论", up.verdict_zh, ENTRY_GATE_VERDICT_ZH.SKIP_COST_US);

  const down = resolveSkippedOutcome(baseSkip, 98, {});
  eq("D10 做多后下跌 → SKIP_SAVED_US", down.verdict, "SKIP_SAVED_US");
  near("D11 避免的亏损含成本", down.counterfactual_pct, -2.1, 1e-9);

  const flat = resolveSkippedOutcome(baseSkip, 100.1, {});
  eq("D12 扣成本后打平 → NEUTRAL(不算 saved)", flat.verdict, "NEUTRAL");
  near("D13 打平收益≈0", flat.counterfactual_pct, 0, 1e-6);
  const flatNoCost = resolveSkippedOutcome(baseSkip, 100.1, { round_trip_cost_pct: 0 });
  eq("D14 不扣成本会误判成错过好交易", flatNoCost.verdict, "SKIP_COST_US");
  near("D15 不扣成本时收益 = 0.1", flatNoCost.counterfactual_pct, 0.1, 1e-6);

  const shortDown = resolveSkippedOutcome({ entry_price: 100, would_be_direction: "SHORT" }, 102, {});
  eq("D16 做空后上涨 → SKIP_SAVED_US", shortDown.verdict, "SKIP_SAVED_US");
  near("D17 做空反事实符号正确", shortDown.counterfactual_pct, -2.1, 1e-9);
  const shortUp = resolveSkippedOutcome({ entry_price: 100, would_be_direction: "SHORT" }, 95, {});
  eq("D18 做空后下跌 → SKIP_COST_US", shortUp.verdict, "SKIP_COST_US");
  near("D19 做空赚钱额度", shortUp.counterfactual_pct, 4.9, 1e-9);

  const noPrice = resolveSkippedOutcome(baseSkip, null, {});
  eq("D20 缺价格 → 未回填", noPrice.resolved, false);
  eq("D21 缺价格原因", noPrice.reason, "no_price");
  eq("D22 缺价格无结论", noPrice.verdict, null);
  const noEntry = resolveSkippedOutcome({ would_be_direction: "LONG" }, 100, {});
  eq("D23 缺建仓价 → 未回填", noEntry.reason, "no_price");
  const noDir = resolveSkippedOutcome({ entry_price: 100 }, 102, {});
  eq("D24 缺方向 → 未回填", noDir.reason, "no_direction");
  const zeroEntry = resolveSkippedOutcome({ entry_price: 0, would_be_direction: "LONG" }, 102, {});
  eq("D25 建仓价 0 → 未回填", zeroEntry.resolved, false);
  const nanPrice = resolveSkippedOutcome(baseSkip, NaN, {});
  eq("D26 NaN 价格 → 未回填", nanPrice.resolved, false);
  const infPrice = resolveSkippedOutcome(baseSkip, Infinity, {});
  eq("D27 Infinity 价格 → 未回填", infPrice.resolved, false);

  // 汇总:saved 占多数
  const savedSkips = [];
  const costSkips = [];
  for (let i = 0; i < 35; i += 1) savedSkips.push({ entry_price: 100, would_be_direction: "LONG", blockers: ["LOW_ENTRY_SCORE"], price: 95, at: T0 + i });
  for (let i = 0; i < 5; i += 1) costSkips.push({ entry_price: 100, would_be_direction: "LONG", blockers: ["COST_DOMINATES"], price: 105, at: T0 + i });
  const ev = gateShadowEvaluate(savedSkips.concat(costSkips), {});
  eq("D28 汇总总数", ev.total, 40);
  eq("D29 已回填数", ev.resolved, 40);
  eq("D30 避免坏交易数", ev.saved, 35);
  eq("D31 错过好交易数", ev.cost, 5);
  eq("D32 中性数", ev.neutral, 0);
  near("D33 save_rate = 0.875", ev.save_rate, 0.875, 1e-9);
  near("D34 平均避免亏损(正数)", ev.avg_saved_pct, 5.1, 1e-9);
  near("D35 平均错过收益(正数)", ev.avg_cost_pct, 4.9, 1e-9);
  eq("D36 分组数", Object.keys(ev.by_blocker).length, 2);
  eq("D37 分组统计", ev.by_blocker.LOW_ENTRY_SCORE.saved, 35);
  near("D38 分组 save_rate", ev.by_blocker.LOW_ENTRY_SCORE.save_rate, 1, 1e-9);
  eq("D39 分组 cost", ev.by_blocker.COST_DOMINATES.cost, 5);
  const adviceSaved = calibrationAdvice(ev, {});
  eq("D40 save_rate 高不会建议放宽", adviceSaved.advice === "LOOSEN" ? "LOOSEN" : "OK", "OK");
  eq("D41 save_rate 0.875 → 略收紧", adviceSaved.advice, "TIGHTEN");
  check("D42 收紧增量为正", adviceSaved.deltas.entry_threshold_delta > 0, JSON.stringify(adviceSaved.deltas));
  check("D43 建议含中文", String(adviceSaved.reason_zh).length > 0);
  check("D44 明确禁止仅因放行率低而放宽", String(adviceSaved.forbidden_zh).includes("严禁"), String(adviceSaved.forbidden_zh));

  // 中性带
  const neutralOnly = [
    { entry_price: 100, would_be_direction: "LONG", blockers: ["PROB_GAP_TOO_SMALL"], price: 100.1, at: T0 }
  ];
  const evN = gateShadowEvaluate(neutralOnly, {});
  eq("D45 打平计入中性", evN.neutral, 1);
  eq("D46 打平不算 saved", evN.saved, 0);

  // 未回填
  const evU = gateShadowEvaluate([{ entry_price: 100, would_be_direction: "LONG" }, { resolved: true, counterfactual_pct: -2, blockers: ["X"], verdict: "SKIP_SAVED_US" }], {});
  eq("D47 未回填被单独计数", evU.unresolved, 1);
  eq("D48 已带结论的记录直接采信", evU.saved, 1);
  eq("D49 未回填原因被记录", Object.keys(evU.unresolved_reasons).length, 1);
  near("D50 已回填率", evU.resolved, 1, 1e-9);

  // 样本不足
  const evFew = gateShadowEvaluate(savedSkips.slice(0, 5), {});
  eq("D51 样本不足样本数", evFew.resolved, 5);
  const adviceFew = calibrationAdvice(evFew, {});
  eq("D52 样本不足 → INSUFFICIENT", adviceFew.advice, "INSUFFICIENT");
  eq("D53 样本不足无增量", adviceFew.deltas, { entry_threshold_delta: 0, min_net_edge_delta: 0 });
  check("D54 样本不足说明含数字", String(adviceFew.reason_zh).includes("30"), String(adviceFew.reason_zh));
  eq("D55 空汇总不下结论", calibrationAdvice(gateShadowEvaluate([], {}), {}).advice, "INSUFFICIENT");

  // 某 blocker 明显过严 → 建议放宽(必须有证据)
  const looseSkips = [];
  for (let i = 0; i < 35; i += 1) looseSkips.push({ entry_price: 100, would_be_direction: "LONG", blockers: ["REGIME_UNFAVORABLE"], price: 105, at: T0 + i });
  const evLoose = gateShadowEvaluate(looseSkips, {});
  eq("D56 该 blocker 全在错过好交易", evLoose.by_blocker.REGIME_UNFAVORABLE.saved, 0);
  eq("D57 该 blocker 全部 cost", evLoose.by_blocker.REGIME_UNFAVORABLE.cost, 35);
  const adviceLoose = calibrationAdvice(evLoose, {});
  eq("D58 有证据 → 放宽该 blocker", adviceLoose.advice, "LOOSEN");
  eq("D59 放宽列出具体 blocker", adviceLoose.blockers.length, 1);
  eq("D60 放宽名单内容", adviceLoose.blockers[0].blocker, "REGIME_UNFAVORABLE");
  check("D61 放宽增量为负", adviceLoose.deltas.entry_threshold_delta < 0, JSON.stringify(adviceLoose.deltas));
  check("D62 放宽理由提到 blocker", String(adviceLoose.reason_zh).includes("REGIME_UNFAVORABLE"), String(adviceLoose.reason_zh));

  // save_rate 低但无证据 → 维持
  const lowRate = [];
  for (let i = 0; i < 40; i += 1) {
    lowRate.push({ entry_price: 100, would_be_direction: "LONG", blockers: ["LOW_ENTRY_SCORE"], price: i < 20 ? 95 : 105, at: T0 + i });
  }
  const evLow = gateShadowEvaluate(lowRate, {});
  near("D63 save_rate = 0.5", evLow.save_rate, 0.5, 1e-9);
  const adviceLow = calibrationAdvice(evLow, {});
  eq("D64 低 save_rate 但无证据 → 维持", adviceLow.advice, "KEEP");
  eq("D65 维持增量为 0", adviceLow.deltas.entry_threshold_delta, 0);
  check("D66 维持理由说明要有证据", String(adviceLow.reason_zh).includes("维持"), String(adviceLow.reason_zh));

  // blocker 样本不足不参与放宽
  const fewBlocker = [
    { entry_price: 100, would_be_direction: "LONG", blockers: ["MODEL_CONFLICT"], price: 105 },
    { entry_price: 100, would_be_direction: "LONG", blockers: ["LOW_ENTRY_SCORE"], price: 95 }
  ];
  const evMixed = gateShadowEvaluate(fewBlocker.concat(savedSkips), {});
  check("D67 blocker 样本不足不参与放宽判定", calibrationAdvice(evMixed, {}).blockers.length === 0, JSON.stringify(calibrationAdvice(evMixed, {}).blockers));

  const dView = entryGateShadowView(ev, adviceSaved);
  eq("D68 视图总数", dView.total, 40);
  near("D69 视图 save_rate 百分比", dView.save_rate_pct, 87.5, 1e-6);
  eq("D70 视图建议中文", dView.advice_zh, ENTRY_GATE_ADVICE_ZH.TIGHTEN);
  eq("D71 视图分组行数", dView.by_blocker.length, 2);
  check("D72 视图含禁止说明", String(dView.forbidden_zh).includes("严禁"));
  eq("D73 空视图仍可渲染", entryGateShadowView(null, null).advice, "INSUFFICIENT");
}

console.log("== E. UI State Store ==");
{
  eq("E1 版本号", UI_STORE_VERSION, "ui-store-v1.0");
  eq("E2 分桶数量", UI_BUCKETS.length, 11);
  eq("E3 分桶顺序", UI_BUCKETS[0], "accountState");
  eq("E4 分桶含 marketState", UI_BUCKETS.indexOf("marketState") >= 0, true);
  eq("E5 分桶中文映射完整", Object.keys(UI_BUCKET_ZH).length, 11);

  let clock = 1000;
  const store = createUiStore({ now: () => clock });
  eq("E6 初始版本 0", store.get("marketState").state_version, 0);
  eq("E7 初始数据 null", store.get("marketState").data, null);
  eq("E8 初始更新时间来自注入时钟", store.snapshot().marketState.updated_at, 1000);

  const set1 = store.set("marketState", { price: 100 }, { state_version: 1 });
  eq("E9 写入被接受", set1.applied, true);
  eq("E10 版本号采用传入值", set1.state_version, 1);
  eq("E11 数据已写入", store.get("marketState").data.price, 100);
  clock = 2000;
  const stale = store.set("marketState", { price: 999 }, { state_version: 1 });
  eq("E12 相同版本写入被拒绝", stale.applied, false);
  eq("E13 拒绝原因 stale_version", stale.reason, UI_STORE_REJECT.STALE_VERSION);
  eq("E14 旧版本不能覆盖新数据", store.get("marketState").data.price, 100);
  const older = store.set("marketState", { price: 1 }, { state_version: 0 });
  eq("E15 更低版本也被拒绝", older.reason, "stale_version");
  const newer = store.set("marketState", { price: 120 }, { state_version: 5 });
  eq("E16 更大版本被接受", newer.applied, true);
  eq("E17 版本跳到 5", store.get("marketState").state_version, 5);
  eq("E18 新数据生效", store.get("marketState").data.price, 120);
  clock = 3000;
  const auto = store.set("marketState", { price: 121 });
  eq("E19 未传版本时自增到 6", auto.state_version, 6);
  eq("E20 更新时间刷新", store.get("marketState").updated_at, 3000);

  const unknown = store.set("nopeState", { x: 1 });
  eq("E21 未知分桶被拒绝", unknown.reason, UI_STORE_REJECT.UNKNOWN_BUCKET);
  check("E22 未知分桶有中文原因", String(unknown.reason_zh).includes("未知"));

  // --- 订阅隔离 ---
  let marketHits = 0;
  let positionHits = 0;
  let accountHits = 0;
  const offMarket = store.subscribe("marketState", () => { marketHits += 1; });
  const offPosition = store.subscribe("positionState", () => { positionHits += 1; });
  store.subscribe("accountState", () => { accountHits += 1; });
  store.set("marketState", { price: 122 });
  eq("E23 行情订阅者被通知", marketHits, 1);
  eq("E24 更新行情不会通知持仓订阅者", positionHits, 0);
  eq("E25 更新行情不会通知账户订阅者", accountHits, 0);
  store.set("positionState", { qty: 1 });
  eq("E26 持仓订阅者被通知", positionHits, 1);
  eq("E27 行情订阅者未被额外打扰", marketHits, 1);
  store.set("accountState", { equity: 10 });
  eq("E28 账户订阅者被通知", accountHits, 1);

  // --- unsubscribe ---
  const removed = offMarket();
  eq("E29 unsubscribe 返回 true", removed, true);
  store.set("marketState", { price: 123 });
  eq("E30 unsubscribe 后不再收到通知", marketHits, 1);
  eq("E31 unsubscribe 幂等", offMarket(), false);
  offPosition();

  // --- subscribeMany ---
  let manyHits = 0;
  const offMany = store.subscribeMany(["marketState", "chartState"], () => { manyHits += 1; });
  store.set("marketState", { price: 124 });
  store.set("chartState", { tf: "15m" });
  eq("E32 多桶订阅都收到", manyHits, 2);
  store.set("riskState", { level: "low" });
  eq("E33 未订阅的桶不通知", manyHits, 2);
  eq("E34 批量取消返回 true", offMany(), true);
  store.set("chartState", { tf: "1h" });
  eq("E35 批量取消后不再通知", manyHits, 2);

  // --- 通配订阅 ---
  let anyHits = 0;
  const offAny = store.subscribe("*", () => { anyHits += 1; });
  store.set("notificationState", { n: 1 });
  eq("E36 通配订阅收到任意桶", anyHits, 1);
  offAny();

  // --- 订阅者抛错不影响其它订阅者 ---
  let safeHits = 0;
  const offThrow = store.subscribe("riskState", () => { throw new Error("boom"); });
  store.subscribe("riskState", () => { safeHits += 1; });
  store.set("riskState", { level: "high" });
  eq("E37 单个订阅者抛错不影响其它订阅者", safeHits, 1);
  offThrow();

  // --- patch ---
  const p1 = store.patch("positionState", { qty: 2 });
  eq("E38 patch 被接受", p1.applied, true);
  eq("E39 patch 合并保留原字段", store.get("positionState").data.qty, 2);
  store.set("positionState", { side: "LONG", nested: { x: 1 } });
  const p2 = store.patch("positionState", { nested: { y: 2 } });
  eq("E40 patch 只合并顶层字段", store.get("positionState").data.nested.y, 2);
  eq("E41 被替换的嵌套旧字段不残留", store.get("positionState").data.nested.x, undefined);
  eq("E42 patch 不改动其它顶层字段", store.get("positionState").data.side, "LONG");
  const patchStale = store.patch("positionState", { side: "SHORT" }, { state_version: 1 });
  eq("E43 patch 同样受版本保护", patchStale.reason, "stale_version");
  eq("E44 过期 patch 不生效", store.get("positionState").data.side, "LONG");
  const patchBad = store.patch("positionState", "not-object");
  eq("E45 非法 patch 被拒绝", patchBad.reason, UI_STORE_REJECT.INVALID_PATCH);
  const patchVersion = store.patch("positionState", { side: "SHORT" }, { state_version: 99 });
  eq("E46 patch 接受更大版本", patchVersion.state_version, 99);
  eq("E47 patch 新数据生效", store.get("positionState").data.side, "SHORT");

  // --- markStale / stats ---
  const staleMark = store.markStale("learningState");
  eq("E48 markStale 生效", staleMark.stale, true);
  eq("E49 markStale 不改版本", store.get("learningState").state_version, 0);
  eq("E50 markStale 被记录", store.get("learningState").stale, true);
  store.set("learningState", { acc: 0.5 });
  eq("E51 写入后 stale 清除", store.get("learningState").stale, false);
  const st = store.stats();
  eq("E52 统计含全部桶", Object.keys(st.buckets).length, 11);
  eq("E53 行情通知计数", st.buckets.marketState.notifications > 0, true);
  eq("E54 统计当前版本", st.buckets.positionState.state_version, 99);
  eq("E55 统计拒绝计数", st.buckets.marketState.rejections, 2);
  eq("E56 统计订阅数", st.buckets.learningState.subscribers, 0);
  check("E57 统计有总通知数", st.total_notifications > 0);
  check("E58 统计有总拒绝数", st.total_rejections >= 3);

  // --- shouldRender ---
  eq("E59 版本相同不渲染", shouldRender(3, 3), false);
  eq("E60 版本回退不渲染", shouldRender(3, 2), false);
  eq("E61 版本更大才渲染", shouldRender(3, 4), true);
  eq("E62 从 0 到 1 渲染", shouldRender(0, 1), true);
  eq("E63 无先前版本时 0 不渲染", shouldRender(null, 0), false);
  eq("E64 无先前版本时 1 渲染", shouldRender(null, 1), true);
  eq("E65 非数字下一版本不渲染", shouldRender(1, null), false);
  eq("E66 非数字上一版本按未知处理", shouldRender("x", 2), true);
  eq("E67 Infinity 不渲染", shouldRender(1, Infinity), false);

  // --- 视图 ---
  const view = uiStoreView(store);
  eq("E68 视图桶数", view.buckets.length, 11);
  eq("E69 视图版本", view.version, UI_STORE_VERSION);
  check("E70 视图含中文标题", String(view.headline_zh).includes("状态桶"));
  const posRow = view.buckets.find((b) => b.bucket === "positionState");
  eq("E71 视图行中文名", posRow.zh, UI_BUCKET_ZH.positionState);
  eq("E72 视图行版本", posRow.state_version, 99);
  check("E73 视图含说明", String(view.note_zh).includes("拒绝"));
  eq("E74 空视图 null", uiStoreView(null), null);

  // --- 初始数据与其它构造方式 ---
  const store2 = createUiStore({ now: 7, initial: { riskState: { level: "low" } } });
  eq("E75 初始数据注入", store2.get("riskState").data.level, "low");
  eq("E76 数值 now 也可用", store2.get("riskState").updated_at, 7);
  const store3 = createUiStore();
  eq("E77 无时钟时 updated_at 为 0", store3.get("chartState").updated_at, 0);
  eq("E78 has 判定合法桶", store3.has("chartState"), true);
  eq("E79 has 判定非法桶", store3.has("nope"), false);
  eq("E80 buckets 列表可枚举", store3.buckets.length, 11);
}

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
