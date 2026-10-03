// paper/factorShadow.js · V16.1 §1 · 因子影子化(纯函数,无 I/O)
// 目的:让"还没被验证有效"的因子默认不参与决策。
//   - 新因子一律从 SHADOW 起步(权重 0),只有持续证明有效才逐级升到 WEAKENING / ACTIVE;
//   - 连续 3 次效果下滑 → WEAKENING(降权)→ 再连续 3 次 → SHADOW(权重 0)→ 再连续 6 次 → RETIRED;
//   - 效果恢复则逐级回升(每 2 次连续恢复升一级);
//   - 高相关因子对(>0.9)的后一个标记 REDUNDANT:只标记,不删除(保留分布供复盘);
//   - 铁律:SHADOW / RETIRED 的权重必须是 0 —— 影子因子绝不能偷偷影响决策。
// 说明:本模块只做统计与状态机,不下单、不写库、不取数。
export const FACTOR_SHADOW_VERSION = "factor-shadow-v1.0";

// 因子生命周期(顺序即"等级":越靠后越弱)
export const FACTOR_SHADOW_STATES = ["ACTIVE", "WEAKENING", "SHADOW", "RETIRED"];
export const FACTOR_SHADOW_ZH = {
  ACTIVE: "生效(全额权重)",
  WEAKENING: "衰减中(降权)",
  SHADOW: "影子(权重 0,不影响决策)",
  RETIRED: "已退役(权重 0)"
};
// 等级数值:越大越"活"。用于逐级升降。
export const FACTOR_SHADOW_STATE_RANK = { RETIRED: 0, SHADOW: 1, WEAKENING: 2, ACTIVE: 3 };
// 状态 → 权重乘数。SHADOW / RETIRED 必须为 0(影子因子不得影响决策)。
export const FACTOR_SHADOW_STATE_WEIGHT = { ACTIVE: 1, WEAKENING: 0.5, SHADOW: 0, RETIRED: 0 };

export const FACTOR_SHADOW_DECAY_STREAK = 3;    // 连续下滑 3 次 → WEAKENING
export const FACTOR_SHADOW_SHADOW_STREAK = 3;   // 再连续 3 次(累计 6)→ SHADOW
export const FACTOR_SHADOW_RETIRE_STREAK = 6;   // 再连续 6 次(累计 12)→ RETIRED
export const FACTOR_SHADOW_RECOVER_STREAK = 2;  // 连续恢复 2 次 → 升一级
export const FACTOR_SHADOW_REDUNDANT_CORR = 0.9; // 相关度 ≥ 该值视为重复因子
export const FACTOR_SHADOW_MIN_SAMPLES = 30;     // 判定用的最小样本(含增量价值对比)
export const FACTOR_SHADOW_DECAY_MARGIN = 0.05;  // 近期命中率低于基线多少算"下滑"
export const FACTOR_SHADOW_BASELINE_FLOOR = 0.5; // 基线不得低于"抛硬币"(无效因子必须能被判为下滑)
export const FACTOR_SHADOW_USEFUL_DELTA = 0.03;  // 增量价值:命中率提升超过该值才算 USEFUL
export const FACTOR_SHADOW_REDUNDANT_DELTA = -0.03; // 去掉该因子反而更好 → REDUNDANT
export const FACTOR_SHADOW_WEIGHT_EPS = 1e-9;
const FS_EPS = 1e-12;

// ---- 私有数值工具(全部带 fs 前缀,避免扁平作用域重名)----
function fsNumOrNull(v) {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function fsNum(v, fallback) {
  const n = fsNumOrNull(v);
  return n == null ? (fallback === undefined ? 0 : fallback) : n;
}
function fsInt(v, fallback) {
  const n = fsNumOrNull(v);
  if (n == null) return fallback;
  const i = Math.floor(n);
  return i > 0 ? i : fallback;
}
function fsClamp(v, lo, hi) {
  const n = fsNum(v, lo);
  return n < lo ? lo : (n > hi ? hi : n);
}
function fsRound(v, digits) {
  const n = fsNumOrNull(v);
  if (n == null) return null;
  const d = fsInt(digits, 6);
  const p = Math.pow(10, d);
  const r = Math.round(n * p) / p;
  return Number.isFinite(r) ? r : null;
}
function fsZh(state) {
  return FACTOR_SHADOW_ZH[state] || String(state || "");
}
function fsRank(state) {
  const r = FACTOR_SHADOW_STATE_RANK[state];
  return Number.isFinite(r) ? r : 1;
}
function fsStateOfRank(rank) {
  for (const s of FACTOR_SHADOW_STATES) if (fsRank(s) === rank) return s;
  return "SHADOW";
}
// 方向符号:LONG/BULL/BUY/UP → +1,SHORT/BEAR/SELL/DOWN → -1,其它 → null
function fsDirectionSign(v) {
  if (v == null) return null;
  const s = String(v).toUpperCase();
  if (s === "LONG" || s === "BULL" || s === "BUY" || s === "UP" || s === "BULLISH") return 1;
  if (s === "SHORT" || s === "BEAR" || s === "SELL" || s === "DOWN" || s === "BEARISH") return -1;
  if (s === "FLAT" || s === "HOLD" || s === "NEUTRAL") return 0;
  return null;
}
function fsBlankSums() {
  return { n: 0, x: 0, y: 0, xy: 0, x2: 0, y2: 0, signed: 0, hits: 0, conf: 0, conf_n: 0 };
}
function fsAccumulate(sums, x, y, signed, hit, confidence) {
  sums.n += 1;
  sums.x += x;
  sums.y += y;
  sums.xy += x * y;
  sums.x2 += x * x;
  sums.y2 += y * y;
  sums.signed += signed;
  sums.hits += hit ? 1 : 0;
  if (confidence != null) { sums.conf += confidence; sums.conf_n += 1; }
}
function fsPearson(sums) {
  const n = sums.n;
  if (n < 3) return null;
  const numerator = n * sums.xy - sums.x * sums.y;
  const denom = Math.sqrt((n * sums.x2 - sums.x * sums.x) * (n * sums.y2 - sums.y * sums.y));
  if (!(denom > FS_EPS) || !Number.isFinite(denom)) return null;
  const r = numerator / denom;
  if (!Number.isFinite(r)) return null;
  return Math.max(-1, Math.min(1, r));
}
function fsHitRate(sums) {
  return sums && sums.n > 0 ? sums.hits / sums.n : null;
}
function fsAvgSigned(sums) {
  return sums && sums.n > 0 ? fsRound(sums.signed / sums.n, 6) : null;
}
// 因子权重 = 有效性质量 × 状态乘数;SHADOW / RETIRED 恒为 0
function fsComputeWeight(entry) {
  const mult = fsNum(FACTOR_SHADOW_STATE_WEIGHT[entry.state], 0);
  if (!(mult > 0)) return 0;
  let quality = 0;
  if (entry.ic != null) quality = fsClamp(Math.abs(entry.ic) * 2, 0, 1);
  else if (entry.hit_rate != null) quality = fsClamp((entry.hit_rate - 0.5) * 4, 0, 1);
  const w = quality * mult;
  return w > FACTOR_SHADOW_WEIGHT_EPS && Number.isFinite(w) ? fsRound(w, 6) : 0;
}
function fsBlankFactor(key, meta) {
  const m = meta || {};
  return {
    key: key,
    zh: m.zh || key,
    group: m.group || null,
    state: "SHADOW",                 // 新因子一律影子化
    weight: 0,
    enabled: false,
    samples: 0,                      // 已解析样本(有因子值 + 有结果)
    observed: 0,
    unresolved: 0,
    invalid: 0,
    hits: 0,
    ic: null,
    hit_rate: null,
    avg_signed_pct: null,
    long_perf: null,
    short_perf: null,
    per_regime: {},
    sum: fsBlankSums(),
    long_sum: fsBlankSums(),
    short_sum: fsBlankSums(),
    recent: fsBlankSums(),
    weaker_streak: 0,
    stronger_streak: 0,
    effect: null,
    baseline_effect: null,
    decayed: false,
    redundant: false,
    redundant_of: null,
    redundant_corr: null,
    retired: false,
    transition_count: 0,
    last_at: null,
    last_state_change_at: null
  };
}
function fsEnsureEntry(state, key, meta) {
  if (!key) return null;
  if (!state.factors[key]) {
    state.factors[key] = fsBlankFactor(key, meta);
    if (state.order.indexOf(key) < 0) state.order.push(key);
  } else if (meta && meta.zh && !state.factors[key].zh) {
    state.factors[key].zh = meta.zh;
  }
  return state.factors[key];
}

// 创建因子影子状态:registry 可为 FACTOR_REGISTRY 数组 / 字符串数组 / {key:meta} 映射
export function createFactorShadowState(registry, opts) {
  const o = opts || {};
  const list = [];
  if (Array.isArray(registry)) {
    for (const item of registry) {
      if (item == null) continue;
      if (typeof item === "string") list.push({ key: item });
      else if (item.key != null) list.push(item);
    }
  } else if (registry && typeof registry === "object") {
    for (const k of Object.keys(registry)) {
      const v = registry[k];
      list.push(v && typeof v === "object" ? { key: k, zh: v.zh, group: v.group } : { key: k });
    }
  }
  const state = {
    version: FACTOR_SHADOW_VERSION,
    created_at: fsNumOrNull(o.now),
    updated_at: fsNumOrNull(o.now),
    order: [],
    factors: {},
    transitions: 0,
    evaluated: 0,
    shadowed_count: 0,
    redundant_count: 0,
    last_advanced_at: null
  };
  for (const meta of list) fsEnsureEntry(state, String(meta.key), meta);
  fsRefreshCounts(state);
  return state;
}

function fsRefreshCounts(state) {
  let shadowed = 0;
  let redundant = 0;
  for (const k of state.order) {
    const e = state.factors[k];
    if (!e) continue;
    if (!(e.weight > 0)) shadowed += 1;
    if (e.redundant === true) redundant += 1;
  }
  state.shadowed_count = shadowed;
  state.redundant_count = redundant;
  return state;
}

// 记录一次因子观测:就地更新该因子条目并返回它(不做整棵 state 的深拷贝)
// obs = { factor, value, normalized_value, signal_direction, confidence, future_outcome_pct, regime, mode, at }
export function recordFactorObservation(state, obs) {
  if (!state || !state.factors) return null;
  const o = obs || {};
  const key = o.factor == null || o.factor === "" ? null : String(o.factor);
  const entry = fsEnsureEntry(state, key, { zh: o.zh });
  if (!entry) return null;
  const at = fsNumOrNull(o.at);
  if (at != null) { entry.last_at = at; state.updated_at = at; }
  entry.observed += 1;

  const x = fsNumOrNull(o.normalized_value) != null ? fsNumOrNull(o.normalized_value) : fsNumOrNull(o.value);
  // 缺因子值:不算样本(绝不把 null 当 0 塞进统计)
  if (x == null) { entry.invalid += 1; return entry; }
  const y = fsNumOrNull(o.future_outcome_pct);
  // 结果未回填:计入 unresolved,不污染命中率/IC
  if (y == null) { entry.unresolved += 1; return entry; }

  let sign = fsDirectionSign(o.signal_direction != null ? o.signal_direction : o.direction);
  if (sign == null) sign = x > 0 ? 1 : (x < 0 ? -1 : 0);
  if (sign === 0) { entry.unresolved += 1; return entry; }
  const confidence = fsNumOrNull(o.confidence);
  const signed = sign * y;
  const hit = signed > 0;

  fsAccumulate(entry.sum, x, y, signed, hit, confidence);
  fsAccumulate(entry.recent, x, y, signed, hit, confidence);
  const mode = o.mode == null ? null : String(o.mode).toLowerCase();
  if (mode === "long" || mode === "bull") fsAccumulate(entry.long_sum, x, y, signed, hit, confidence);
  else if (mode === "short" || mode === "bear") fsAccumulate(entry.short_sum, x, y, signed, hit, confidence);

  entry.samples = entry.sum.n;
  entry.hits = entry.sum.hits;
  entry.hit_rate = fsHitRate(entry.sum);
  entry.ic = fsPearson(entry.sum);
  entry.avg_signed_pct = fsAvgSigned(entry.sum);
  entry.long_perf = entry.long_sum.n > 0 ? fsAvgSigned(entry.long_sum) : null;
  entry.short_perf = entry.short_sum.n > 0 ? fsAvgSigned(entry.short_sum) : null;

  const regime = o.regime == null || o.regime === "" ? "UNKNOWN" : String(o.regime);
  const bucket = entry.per_regime[regime] || (entry.per_regime[regime] = { regime: regime, sums: fsBlankSums() });
  fsAccumulate(bucket.sums, x, y, signed, hit, confidence);
  bucket.samples = bucket.sums.n;
  bucket.hit_rate = fsHitRate(bucket.sums);
  bucket.avg_signed_pct = fsAvgSigned(bucket.sums);
  bucket.avg_confidence = bucket.sums.conf_n > 0 ? fsRound(bucket.sums.conf / bucket.sums.conf_n, 6) : null;
  bucket.last_at = at;

  entry.weight = fsComputeWeight(entry);
  entry.enabled = entry.weight > 0;
  fsRefreshCounts(state);
  return entry;
}

function fsIncrementalRow(raw, key) {
  if (!raw || typeof raw !== "object") return null;
  const y = fsNumOrNull(raw.future_outcome_pct) != null
    ? fsNumOrNull(raw.future_outcome_pct)
    : (fsNumOrNull(raw.outcome_pct) != null ? fsNumOrNull(raw.outcome_pct) : fsNumOrNull(raw.pnl_pct));
  if (y == null) return null;
  let has = false;
  let ownValue = null;
  if (raw.factors && typeof raw.factors === "object") {
    ownValue = fsNumOrNull(raw.factors[key]);
    has = ownValue != null;
  } else if (raw.factor_values && typeof raw.factor_values === "object") {
    ownValue = fsNumOrNull(raw.factor_values[key]);
    has = ownValue != null;
  } else if (raw.factor != null && String(raw.factor) === key) {
    ownValue = fsNumOrNull(raw.normalized_value) != null ? fsNumOrNull(raw.normalized_value) : fsNumOrNull(raw.value);
    has = ownValue != null;
  }
  let sign = fsDirectionSign(raw.signal_direction != null ? raw.signal_direction : raw.direction);
  if (sign == null && ownValue != null) sign = ownValue > 0 ? 1 : (ownValue < 0 ? -1 : 0);
  if (sign == null || sign === 0) return null;
  const signed = sign * y;
  return { has: has, signed: signed, hit: signed > 0, confidence: fsNumOrNull(raw.confidence) };
}

function fsSideStats(rows) {
  if (!rows.length) return { samples: 0, hit_rate: null, hits: 0, avg_signed_pct: null };
  let hits = 0;
  let signed = 0;
  for (const r of rows) { signed += r.signed; if (r.hit) hits += 1; }
  return {
    samples: rows.length,
    hits: hits,
    hit_rate: fsRound(hits / rows.length, 6),
    avg_signed_pct: fsRound(signed / rows.length, 6)
  };
}

// 增量价值:有该因子 vs 去掉该因子(命中率 + 平均方向收益的简单代理)
export function factorIncrementalValue(samples, factorKey, opts) {
  const o = opts || {};
  const key = factorKey == null ? "" : String(factorKey);
  const minSamples = fsInt(o.minSamples, FACTOR_SHADOW_MIN_SAMPLES);
  const usefulDelta = fsNum(o.usefulDelta, FACTOR_SHADOW_USEFUL_DELTA);
  const redundantDelta = fsNum(o.redundantDelta, FACTOR_SHADOW_REDUNDANT_DELTA);
  const rows = [];
  for (const raw of (Array.isArray(samples) ? samples : [])) {
    const r = fsIncrementalRow(raw, key);
    if (r) rows.push(r);
  }
  if (rows.length < minSamples) {
    return {
      factor: key, verdict: "INSUFFICIENT", samples: rows.length, min_samples: minSamples,
      with: null, without: null, delta: null, delta_avg_pct: null,
      reason_zh: "有效样本 " + rows.length + " < " + minSamples + ",不足以判断增量价值"
    };
  }
  const withRows = rows.filter((r) => r.has);
  const withoutRows = rows.filter((r) => !r.has);
  if (!withRows.length || !withoutRows.length) {
    return {
      factor: key, verdict: "INSUFFICIENT", samples: rows.length, min_samples: minSamples,
      with: fsSideStats(withRows), without: fsSideStats(withoutRows), delta: null, delta_avg_pct: null,
      reason_zh: "无法对比:缺少" + (withRows.length ? "去掉该因子" : "含有该因子") + "的对照样本"
    };
  }
  const withStats = fsSideStats(withRows);
  const withoutStats = fsSideStats(withoutRows);
  const delta = fsRound(withStats.hit_rate - withoutStats.hit_rate, 6);
  const deltaAvg = fsRound(withStats.avg_signed_pct - withoutStats.avg_signed_pct, 6);
  let verdict = "NEUTRAL";
  if (delta != null && delta > usefulDelta) verdict = "USEFUL";
  else if (delta != null && delta < redundantDelta) verdict = "REDUNDANT";
  return {
    factor: key, verdict: verdict, samples: rows.length, min_samples: minSamples,
    with: withStats, without: withoutStats, delta: delta, delta_avg_pct: deltaAvg,
    reason_zh: verdict === "USEFUL" ? "有该因子时命中率更高"
      : (verdict === "REDUNDANT" ? "去掉该因子反而更好,应转影子" : "有无该因子差别不明显")
  };
}

// 高相关因子对:后一个标记 REDUNDANT(记录 redundant_of),只标记不删除
// 兼容两种调用:markRedundantFactors(state, corrFn, opts) 与 markRedundantFactors(corrFn, threshold, state)
export function markRedundantFactors(arg1, arg2, arg3) {
  let state = null;
  let corrFn = null;
  let threshold = FACTOR_SHADOW_REDUNDANT_CORR;
  if (arg1 && typeof arg1 !== "function" && arg1.factors) {
    state = arg1;
    corrFn = typeof arg2 === "function" ? arg2 : null;
    if (typeof arg3 === "number") threshold = arg3;
    else if (arg3 && typeof arg3 === "object") threshold = fsNum(arg3.threshold, FACTOR_SHADOW_REDUNDANT_CORR);
  } else {
    corrFn = typeof arg1 === "function" ? arg1 : null;
    if (typeof arg2 === "number") threshold = arg2;
    else if (arg2 && typeof arg2 === "object") threshold = fsNum(arg2.threshold, FACTOR_SHADOW_REDUNDANT_CORR);
    if (arg3 && typeof arg3 === "object" && arg3.factors) state = arg3;
    else if (arg2 && typeof arg2 === "object" && arg2.factors) state = arg2;
  }
  const result = { threshold: threshold, pairs_checked: 0, marked: [], cleared: [], skipped: [] };
  if (!state || !state.factors) { result.reason = "no_state"; return result; }
  if (typeof corrFn !== "function") { result.reason = "no_correlation_fn"; return result; }
  const keys = state.order.slice();
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const a = state.factors[keys[i]];
      const b = state.factors[keys[j]];
      if (!a || !b) continue;
      const raw = corrFn(a.key, b.key);
      const corr = fsNumOrNull(raw);
      if (corr == null) { result.skipped.push({ a: a.key, b: b.key, corr: null }); continue; }
      result.pairs_checked += 1;
      if (Math.abs(corr) >= threshold) {
        b.redundant = true;
        b.redundant_of = a.key;
        b.redundant_corr = fsRound(corr, 6);
        b.weight = fsComputeWeight(b);   // 冗余因子不改生命周期权重,仅标记(保留分布)
        result.marked.push({ key: b.key, redundant_of: a.key, corr: fsRound(corr, 6) });
      } else if (b.redundant === true && b.redundant_of === a.key) {
        b.redundant = false;
        b.redundant_of = null;
        b.redundant_corr = null;
        result.cleared.push({ key: b.key, was_redundant_of: a.key, corr: fsRound(corr, 6) });
      }
    }
  }
  fsRefreshCounts(state);
  return result;
}

// 推进因子状态机(在"评估窗口"末调用):
//   - 用 recent(上次推进以来的样本)对比基线,判断效果下滑 / 恢复;
//   - 下滑累计:3 → WEAKENING,6 → SHADOW(权重 0),12 → RETIRED;
//   - 恢复累计:每 2 次连续恢复升一级;
//   - 窗口样本不足则该因子本轮不判定(不随机抖动)。
export function advanceFactorStates(state, opts) {
  const o = opts || {};
  const out = { evaluated: 0, changed: [], skipped: [], shadowed_count: 0, active_count: 0 };
  if (!state || !state.factors) return out;
  const decayStreak = fsInt(o.decayStreak, FACTOR_SHADOW_DECAY_STREAK);
  const shadowStreak = decayStreak + fsInt(o.shadowStreak, FACTOR_SHADOW_SHADOW_STREAK);
  const retireStreak = shadowStreak + fsInt(o.retireStreak, FACTOR_SHADOW_RETIRE_STREAK);
  const recoverStreak = fsInt(o.recoverStreak, FACTOR_SHADOW_RECOVER_STREAK);
  const margin = fsNum(o.decayMargin, FACTOR_SHADOW_DECAY_MARGIN);
  const minSamples = fsInt(o.minSamples, FACTOR_SHADOW_MIN_SAMPLES);
  const baselineFloor = fsNum(o.baselineFloor, FACTOR_SHADOW_BASELINE_FLOOR);
  const at = fsNumOrNull(o.now);

  for (const key of state.order.slice()) {
    const e = state.factors[key];
    if (!e) continue;
    const win = e.recent;
    if (!(win.n > 0)) { out.skipped.push({ key: key, reason: "no_recent_samples" }); continue; }
    if (win.n < minSamples) { out.skipped.push({ key: key, reason: "insufficient_recent_samples", samples: win.n }); continue; }
    const effect = win.hits / win.n;
    // 基线 = 之前各评估窗口累计的长期命中率(不低于"抛硬币",否则无效因子永远判不出下滑)
    const longRate = e.long_sum.n > 0 ? e.long_sum.hits / e.long_sum.n : null;
    const baseline = longRate == null ? baselineFloor : Math.max(longRate, baselineFloor);
    e.effect = fsRound(effect, 6);
    e.baseline_effect = fsRound(baseline, 6);
    const declining = effect < baseline - margin;
    // 长期基线已经饱和到 100% 时,"达到历史最好水平"也算恢复(否则完美因子永远升不回去)
    const atCeiling = baseline >= 1 - 1e-9;
    const recovering = effect > baseline + margin || (atCeiling && effect >= baseline - 1e-9);
    e.decayed = declining;

    const prevState = e.state;
    let changedReason = null;
    if (declining) {
      e.weaker_streak = Math.min(e.weaker_streak + 1, retireStreak);
      e.stronger_streak = 0;
      let next = e.state;
      if (e.weaker_streak >= retireStreak) next = "RETIRED";
      else if (e.weaker_streak >= shadowStreak) next = "SHADOW";
      else if (e.weaker_streak >= decayStreak) next = "WEAKENING";
      // 衰减只能往下走:绝不允许"因为下滑反而升级"
      if (fsRank(next) > fsRank(prevState)) next = prevState;
      if (fsRank(next) < fsRank(prevState)) changedReason = "decay";
      e.state = next;
    } else if (recovering) {
      e.stronger_streak += 1;
      e.weaker_streak = 0;
      if (e.stronger_streak >= recoverStreak) {
        e.stronger_streak = 0;
        const next = fsStateOfRank(Math.min(fsRank(prevState) + 1, FACTOR_SHADOW_STATE_RANK.ACTIVE));
        if (fsRank(next) > fsRank(prevState)) changedReason = "recover";
        e.state = next;
      }
    } else {
      // 中性:连续计数中断(严格"连续")
      e.weaker_streak = 0;
      e.stronger_streak = 0;
    }

    e.retired = e.state === "RETIRED";
    // 权重要么 0 要么 >0:SHADOW / RETIRED 必为 0
    e.weight = fsComputeWeight(e);
    e.enabled = e.weight > 0;
    if (changedReason) {
      e.transition_count += 1;
      state.transitions += 1;
      if (at != null) e.last_state_change_at = at;
      out.changed.push({
        key: key, from: prevState, to: e.state, reason: changedReason,
        reason_zh: changedReason === "decay" ? "效果连续下滑,降级" : "效果恢复,升级",
        weaker_streak: e.weaker_streak, stronger_streak: e.stronger_streak, effect: e.effect, baseline: e.baseline_effect
      });
    }
    out.evaluated += 1;

    // 折叠窗口:本轮样本进入长期统计,窗口清零(下一轮重新累积)
    const ls = e.long_sum;
    ls.n += win.n; ls.x += win.x; ls.y += win.y; ls.xy += win.xy; ls.x2 += win.x2; ls.y2 += win.y2;
    ls.signed += win.signed; ls.hits += win.hits; ls.conf += win.conf; ls.conf_n += win.conf_n;
    e.recent = fsBlankSums();
  }
  state.evaluated += out.evaluated;
  state.last_advanced_at = at;
  state.updated_at = at == null ? state.updated_at : at;
  fsRefreshCounts(state);
  out.shadowed_count = state.shadowed_count;
  out.active_count = state.order.filter((k) => state.factors[k] && state.factors[k].weight > 0).length;
  return out;
}

// 该因子此刻是否允许参与决策(权重必须 > 0;SHADOW / RETIRED 一律 false)
export function factorShadowEligible(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.state === "SHADOW" || entry.state === "RETIRED") return false;
  return fsNum(entry.weight, 0) > 0;
}

// 参与决策的因子权重表(影子因子被彻底排除在结果之外)
export function activeFactorWeights(state) {
  const out = {};
  if (!state || !state.factors) return out;
  let total = 0;
  for (const key of state.order) {
    const e = state.factors[key];
    if (!e || !factorShadowEligible(e)) continue;
    out[key] = e.weight;
    total += e.weight;
  }
  out.__total__ = fsRound(total, 6) || 0;
  return out;
}

// 中文视图:每个因子的状态、样本、IC、命中率、多空表现、是否衰减、是否冗余
export function factorShadowView(state) {
  if (!state) return null;
  const rows = [];
  for (const key of state.order) {
    const e = state.factors[key];
    if (!e) continue;
    const regimes = Object.keys(e.per_regime).map((r) => {
      const b = e.per_regime[r];
      return {
        regime: r, samples: b.samples,
        hit_rate_pct: b.hit_rate == null ? null : fsRound(b.hit_rate * 100, 2),
        avg_signed_pct: b.avg_signed_pct,
        avg_confidence: b.avg_confidence
      };
    });
    rows.push({
      key: e.key,
      zh: e.zh || e.key,
      state: e.state,
      state_zh: fsZh(e.state),
      weight: e.weight,
      enabled: factorShadowEligible(e),
      samples: e.samples,
      observed: e.observed,
      unresolved: e.unresolved,
      ic: e.ic,
      hit_rate_pct: e.hit_rate == null ? null : fsRound(e.hit_rate * 100, 2),
      avg_signed_pct: e.avg_signed_pct,
      long_perf: e.long_perf,
      short_perf: e.short_perf,
      decayed: e.decayed === true,
      weaker_streak: e.weaker_streak,
      redundant: e.redundant === true,
      redundant_of: e.redundant_of,
      per_regime: regimes
    });
  }
  const shadowWeight = rows.filter((r) => !r.enabled);
  return {
    version: state.version || FACTOR_SHADOW_VERSION,
    factor_count: rows.length,
    active_count: rows.filter((r) => r.enabled).length,
    shadow_count: shadowWeight.length,
    redundant_count: rows.filter((r) => r.redundant).length,
    transitions: state.transitions,
    // 审计用:所有影子因子权重必须为 0,否则就是"影子因子仍在影响决策"的事故
    shadow_weight_total: rows.filter((r) => r.state === "SHADOW" || r.state === "RETIRED")
      .reduce((a, r) => a + fsNum(r.weight, 0), 0),
    factors: rows,
    note_zh: "SHADOW / RETIRED 因子权重恒为 0;只有 ACTIVE / WEAKENING 才参与决策"
  };
}
