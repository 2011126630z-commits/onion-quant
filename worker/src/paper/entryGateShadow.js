// paper/entryGateShadow.js · V16.1 §4 · 入口闸门影子评估与校准(纯函数,无 I/O)
// 回答一个真问题:"被闸门 SKIP 掉的机会,后来是不是真的避免了坏交易?"
//   - 每条 SKIP 记录(entryQuality.skipShadowRecord 产生)在事后用价格回填反事实收益;
//   - 反事实收益必须【扣掉往返手续费+滑点】:否则"没赚也没亏手续费"会被误判成"躲过一笔坏交易";
//   - 汇总 save_rate / by_blocker,再给出校准建议;
//   - 铁律:样本不足一律 INSUFFICIENT;严禁因为"放行率看起来低"就把闸门调松。
export const ENTRY_GATE_SHADOW_VERSION = "entry-gate-shadow-v1.0";

export const ENTRY_GATE_MIN_SAMPLES = 30;            // 有效样本下限(不足不下结论)
export const ENTRY_GATE_BLOCKER_MIN_SAMPLES = 10;    // 单个 blocker 的最小样本
export const ENTRY_GATE_ROUND_TRIP_COST_PCT = 0.10;  // 往返成本(%):双边手续费 + 滑点
export const ENTRY_GATE_NEUTRAL_BAND_PCT = 0.05;     // 中性带:净反事实收益在该区间内 = 没有结论
export const ENTRY_GATE_SAVE_RATE_KEEP = 0.55;       // save_rate ≥ 该值 → 维持
export const ENTRY_GATE_SAVE_RATE_TIGHTEN = 0.75;    // save_rate ≥ 该值 → 可略收紧
export const ENTRY_GATE_BLOCKER_SAVED_MAX = 0.2;     // 某 blocker saved 占比 ≤ 该值且 cost 高 → 该条可能过严
export const ENTRY_GATE_VERDICTS = ["SKIP_SAVED_US", "SKIP_COST_US", "NEUTRAL"];
export const ENTRY_GATE_VERDICT_ZH = {
  SKIP_SAVED_US: "幸好没开:避开了一笔坏交易",
  SKIP_COST_US: "可惜没开:错过了一笔好交易",
  NEUTRAL: "无结论:扣掉往返成本后基本打平"
};
export const ENTRY_GATE_ADVICE_ZH = {
  KEEP: "维持现有闸门",
  TIGHTEN: "可以略收紧",
  LOOSEN: "建议放宽过严的 blocker",
  INSUFFICIENT: "有效样本不足,暂不下结论"
};
// 建议的闸门增量:正值 = 更严格,负值 = 放宽
export const ENTRY_GATE_ADVICE_DELTAS = {
  KEEP: { entry_threshold_delta: 0, min_net_edge_delta: 0 },
  TIGHTEN: { entry_threshold_delta: 2, min_net_edge_delta: 0.05 },
  LOOSEN: { entry_threshold_delta: -2, min_net_edge_delta: -0.05 },
  INSUFFICIENT: { entry_threshold_delta: 0, min_net_edge_delta: 0 }
};

// ---- 私有数值工具(eg 前缀,避免扁平作用域重名)----
function egNumOrNull(v) {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function egNum(v, fallback) {
  const n = egNumOrNull(v);
  return n == null ? (fallback === undefined ? 0 : fallback) : n;
}
function egRound(v, digits) {
  const n = egNumOrNull(v);
  if (n == null) return null;
  const p = Math.pow(10, egNum(digits, 4));
  const r = Math.round(n * p) / p;
  return Number.isFinite(r) ? r : null;
}
function egDirectionSign(v) {
  if (v == null) return null;
  const s = String(v).toUpperCase();
  if (s === "LONG" || s === "BULL" || s === "BUY") return 1;
  if (s === "SHORT" || s === "BEAR" || s === "SELL") return -1;
  return null;
}
function egCostOf(opts) {
  const o = opts || {};
  const c = egNumOrNull(o.round_trip_cost_pct != null ? o.round_trip_cost_pct : o.cost_pct);
  return c == null || c < 0 ? ENTRY_GATE_ROUND_TRIP_COST_PCT : c;
}

// 回填一条 SKIP 的反事实结果(必须扣往返成本,否则"没亏手续费"会被当成"躲过坏交易")
export function resolveSkippedOutcome(skipRecord, price, opts) {
  const r = skipRecord || {};
  const o = opts || {};
  const entry = egNumOrNull(r.entry_price);
  const cur = egNumOrNull(price);
  const direction = r.would_be_direction != null ? r.would_be_direction : (r.direction != null ? r.direction : null);
  const sign = egDirectionSign(direction);
  if (entry == null || entry <= 0 || cur == null || cur <= 0) {
    return {
      resolved: false, reason: "no_price", reason_zh: "缺少建仓价或后续价格,无法回填",
      counterfactual_pct: null, gross_pct: null, cost_pct: null, verdict: null, verdict_zh: null,
      entry_price: entry, price: cur, direction: direction == null ? null : String(direction).toUpperCase(), at: egNumOrNull(o.at)
    };
  }
  if (sign == null) {
    return {
      resolved: false, reason: "no_direction", reason_zh: "缺少方向,无法计算反事实收益",
      counterfactual_pct: null, gross_pct: null, cost_pct: null, verdict: null, verdict_zh: null,
      entry_price: entry, price: cur, direction: null, at: egNumOrNull(o.at)
    };
  }
  const costPct = egCostOf(o);
  const band = egNum(o.neutral_band_pct, ENTRY_GATE_NEUTRAL_BAND_PCT);
  const grossPct = (cur - entry) / entry * 100 * sign;
  const netPct = grossPct - costPct;
  let verdict = "NEUTRAL";
  if (netPct < -band) verdict = "SKIP_SAVED_US";
  else if (netPct > band) verdict = "SKIP_COST_US";
  return {
    resolved: true,
    reason: "ok",
    reason_zh: ENTRY_GATE_VERDICT_ZH[verdict],
    counterfactual_pct: egRound(netPct, 6),
    gross_pct: egRound(grossPct, 6),
    cost_pct: egRound(costPct, 6),
    verdict: verdict,
    verdict_zh: ENTRY_GATE_VERDICT_ZH[verdict],
    entry_price: entry,
    price: cur,
    direction: sign > 0 ? "LONG" : "SHORT",
    blockers: Array.isArray(r.blockers) ? r.blockers.slice() : [],
    at: egNumOrNull(o.at != null ? o.at : r.at)
  };
}

// 汇总:SKIP 是否真的避免了坏交易(按 blocker 分组,便于定位"哪一条闸门在误杀")
// 注意:这个名字不能叫 shadowEvaluation —— 扁平 bundle 里 leverageManager 已经有一个同名导出,
// 两个 function 声明在同一个作用域里后者会静默覆盖前者(会把 AUTO 杠杆的影子学习直接吃掉)。
export function gateShadowEvaluate(skips, opts) {
  const o = opts || {};
  const list = Array.isArray(skips) ? skips : [];
  const priceOf = typeof o.priceOf === "function" ? o.priceOf : null;
  const price = egNumOrNull(o.price);
  const out = {
    version: ENTRY_GATE_SHADOW_VERSION,
    total: list.length,
    resolved: 0,
    unresolved: 0,
    saved: 0,
    cost: 0,
    neutral: 0,
    save_rate: null,
    cost_rate: null,
    avg_saved_pct: null,
    avg_cost_pct: null,
    round_trip_cost_pct: egCostOf(o),
    by_blocker: {},
    unresolved_reasons: {}
  };
  const savedPcts = [];
  const costPcts = [];
  const rows = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") { out.unresolved += 1; continue; }
    let res = null;
    const already = egNumOrNull(raw.counterfactual_pct);
    if (raw.resolved === true && already != null) {
      res = {
        resolved: true,
        counterfactual_pct: already,
        gross_pct: egNumOrNull(raw.gross_pct),
        verdict: raw.verdict != null && ENTRY_GATE_VERDICTS.indexOf(String(raw.verdict)) >= 0 ? String(raw.verdict)
          : (already < -egNum(o.neutral_band_pct, ENTRY_GATE_NEUTRAL_BAND_PCT) ? "SKIP_SAVED_US"
            : (already > egNum(o.neutral_band_pct, ENTRY_GATE_NEUTRAL_BAND_PCT) ? "SKIP_COST_US" : "NEUTRAL")),
        blockers: Array.isArray(raw.blockers) ? raw.blockers.slice() : []
      };
    } else {
      let px = null;
      if (priceOf) px = egNumOrNull(priceOf(raw));
      if (px == null) px = egNumOrNull(raw.price != null ? raw.price : raw.resolved_price);
      if (px == null) px = price;
      res = resolveSkippedOutcome(raw, px, o);
    }
    if (!res || res.resolved !== true) {
      out.unresolved += 1;
      const reason = res && res.reason ? res.reason : "unknown";
      out.unresolved_reasons[reason] = egNum(out.unresolved_reasons[reason], 0) + 1;
      continue;
    }
    out.resolved += 1;
    const blockers = res.blockers && res.blockers.length ? res.blockers : ["UNSPECIFIED"];
    if (res.verdict === "SKIP_SAVED_US") { out.saved += 1; if (res.counterfactual_pct != null) savedPcts.push(-res.counterfactual_pct); }
    else if (res.verdict === "SKIP_COST_US") { out.cost += 1; if (res.counterfactual_pct != null) costPcts.push(res.counterfactual_pct); }
    else out.neutral += 1;
    for (const b of blockers) {
      const key = String(b);
      const bucket = out.by_blocker[key] || (out.by_blocker[key] = { blocker: key, count: 0, resolved: 0, saved: 0, cost: 0, neutral: 0, save_rate: null });
      bucket.count += 1;
      bucket.resolved += 1;
      if (res.verdict === "SKIP_SAVED_US") bucket.saved += 1;
      else if (res.verdict === "SKIP_COST_US") bucket.cost += 1;
      else bucket.neutral += 1;
    }
    rows.push({ verdict: res.verdict, counterfactual_pct: res.counterfactual_pct, blockers: blockers });
  }
  for (const key of Object.keys(out.by_blocker)) {
    const b = out.by_blocker[key];
    b.save_rate = b.resolved > 0 ? egRound(b.saved / b.resolved, 6) : null;
    b.cost_rate = b.resolved > 0 ? egRound(b.cost / b.resolved, 6) : null;
  }
  out.save_rate = out.resolved > 0 ? egRound(out.saved / out.resolved, 6) : null;
  out.cost_rate = out.resolved > 0 ? egRound(out.cost / out.resolved, 6) : null;
  out.avg_saved_pct = savedPcts.length ? egRound(savedPcts.reduce((a, v) => a + v, 0) / savedPcts.length, 6) : null;
  out.avg_cost_pct = costPcts.length ? egRound(costPcts.reduce((a, v) => a + v, 0) / costPcts.length, 6) : null;
  out.rows = rows;
  out.summary_zh = out.resolved === 0
    ? "暂无可回填的 SKIP 记录"
    : ("已回填 " + out.resolved + " 条:" + out.saved + " 条避免坏交易 / " + out.cost + " 条错过好交易 / " + out.neutral + " 条中性");
  return out;
}

// 校准建议:只能基于有效样本;禁止因为"放行率低"就调松
export function calibrationAdvice(evaluation, opts) {
  const o = opts || {};
  const e = evaluation || {};
  const minSamples = egNum(o.min_samples, ENTRY_GATE_MIN_SAMPLES);
  const blockerMin = egNum(o.blocker_min_samples, ENTRY_GATE_BLOCKER_MIN_SAMPLES);
  const savedMax = egNum(o.blocker_saved_max, ENTRY_GATE_BLOCKER_SAVED_MAX);
  const keepRate = egNum(o.save_rate_keep, ENTRY_GATE_SAVE_RATE_KEEP);
  const tightenRate = egNum(o.save_rate_tighten, ENTRY_GATE_SAVE_RATE_TIGHTEN);
  const resolved = egNum(e.resolved, 0);
  const base = {
    version: ENTRY_GATE_SHADOW_VERSION,
    resolved: resolved,
    min_samples: minSamples,
    save_rate: e.save_rate == null ? null : e.save_rate,
    deltas: { ...ENTRY_GATE_ADVICE_DELTAS.INSUFFICIENT },
    blockers: [],
    forbidden_zh: "严禁仅因放行率(允许开仓比例)偏低就放宽闸门:必须先有反事实证据"
  };
  if (resolved < minSamples) {
    return {
      ...base,
      advice: "INSUFFICIENT",
      advice_zh: ENTRY_GATE_ADVICE_ZH.INSUFFICIENT,
      reason_zh: "有效回填样本 " + resolved + " < " + minSamples + ",无法判断闸门是否过严或过松"
    };
  }
  // 定位"疑似过严"的 blocker:样本足够、几乎没救过我们、却明显在错过好交易
  const overStrict = [];
  const byBlocker = e.by_blocker || {};
  for (const key of Object.keys(byBlocker)) {
    const b = byBlocker[key] || {};
    const r = egNum(b.resolved, 0);
    if (r < blockerMin) continue;
    const saveRate = b.save_rate == null ? 0 : egNum(b.save_rate, 0);
    const costRate = b.cost_rate == null ? 0 : egNum(b.cost_rate, 0);
    if (saveRate <= savedMax && costRate > saveRate) {
      overStrict.push({ blocker: key, resolved: r, saved: egNum(b.saved, 0), cost: egNum(b.cost, 0), save_rate: saveRate, cost_rate: costRate });
    }
  }
  if (overStrict.length) {
    return {
      ...base,
      advice: "LOOSEN",
      advice_zh: ENTRY_GATE_ADVICE_ZH.LOOSEN,
      deltas: { ...ENTRY_GATE_ADVICE_DELTAS.LOOSEN },
      blockers: overStrict,
      reason_zh: "以下 blocker 样本足够却几乎没救过我们,反而在错过好交易:" + overStrict.map((b) => b.blocker).join("、")
    };
  }
  const saveRate = e.save_rate == null ? 0 : egNum(e.save_rate, 0);
  if (saveRate >= tightenRate) {
    return {
      ...base,
      advice: "TIGHTEN",
      advice_zh: ENTRY_GATE_ADVICE_ZH.TIGHTEN,
      deltas: { ...ENTRY_GATE_ADVICE_DELTAS.TIGHTEN },
      blockers: [],
      reason_zh: "save_rate " + saveRate + " ≥ " + tightenRate + ":闸门确实在避免坏交易,可略收紧"
    };
  }
  if (saveRate >= keepRate) {
    return {
      ...base,
      advice: "KEEP",
      advice_zh: ENTRY_GATE_ADVICE_ZH.KEEP,
      deltas: { ...ENTRY_GATE_ADVICE_DELTAS.KEEP },
      blockers: [],
      reason_zh: "save_rate " + saveRate + " 处于正常区间,维持现有闸门"
    };
  }
  // save_rate 偏低也不许直接放宽:那可能是"这段时间本来就没有好机会"
  return {
    ...base,
    advice: "KEEP",
    advice_zh: ENTRY_GATE_ADVICE_ZH.KEEP,
    deltas: { ...ENTRY_GATE_ADVICE_DELTAS.KEEP },
    blockers: [],
    reason_zh: "save_rate " + saveRate + " 偏低,但没有证据表明某个 blocker 过严 → 维持;如需调整必须先补足反事实样本"
  };
}

// 中文视图
export function entryGateShadowView(evaluation, advice) {
  const e = evaluation || {};
  const a = advice || {};
  const blockers = Object.keys(e.by_blocker || {}).map((k) => {
    const b = e.by_blocker[k];
    return {
      blocker: b.blocker,
      count: b.count,
      saved: b.saved,
      cost: b.cost,
      neutral: b.neutral,
      save_rate_pct: b.save_rate == null ? null : egRound(b.save_rate * 100, 2),
      cost_rate_pct: b.cost_rate == null ? null : egRound(b.cost_rate * 100, 2)
    };
  }).sort((x, y) => y.count - x.count);
  return {
    version: ENTRY_GATE_SHADOW_VERSION,
    total: egNum(e.total, 0),
    resolved: egNum(e.resolved, 0),
    unresolved: egNum(e.unresolved, 0),
    saved: egNum(e.saved, 0),
    cost: egNum(e.cost, 0),
    neutral: egNum(e.neutral, 0),
    save_rate_pct: e.save_rate == null ? null : egRound(e.save_rate * 100, 2),
    cost_rate_pct: e.cost_rate == null ? null : egRound(e.cost_rate * 100, 2),
    avg_saved_pct: e.avg_saved_pct,
    avg_cost_pct: e.avg_cost_pct,
    round_trip_cost_pct: e.round_trip_cost_pct,
    headline_zh: e.summary_zh || "暂无 SKIP 影子数据",
    by_blocker: blockers,
    advice: a.advice || "INSUFFICIENT",
    advice_zh: a.advice_zh || ENTRY_GATE_ADVICE_ZH.INSUFFICIENT,
    advice_reason_zh: a.reason_zh || "",
    deltas: a.deltas || { ...ENTRY_GATE_ADVICE_DELTAS.INSUFFICIENT },
    forbidden_zh: a.forbidden_zh || "严禁仅因放行率偏低就放宽闸门"
  };
}
