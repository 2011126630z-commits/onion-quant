// paper/tradeAnalysis.js · V16.1 §3 · 新交易数据分析(母仓位口径,纯函数,无 I/O)
// 关键口径:一切统计以【完整母仓位】为单位。
//   Partial Close 是仓位事件(position_event),绝不是独立样本 —— 3 个部分平仓 + 1 个全平
//   必须只算 1 个母仓位,否则笔数虚高、胜率/盈亏比被碎片污染。
// 输出覆盖:入场保证金、资金占比、胜率、净利、手续费拖累、盈亏比、MFE/MAE、持仓时长、
//   部分平仓次数、退出原因分布、入口质量分、预期 vs 实际边际、杠杆来源、红旗。
// 红旗是"结论"不是"猜测":每条都带 evidence(用了哪些数字得出),数据缺失就明显标注 unknown。
export const TRADE_ANALYSIS_VERSION = "trade-analysis-v1.0";

// 红旗阈值
export const TRADE_ANALYSIS_MIN_MARGIN_USDT = 5;    // 母仓位入场保证金下限(蚂蚁仓)
export const TRADE_ANALYSIS_MIN_MARGIN_PCT = 2;     // 或占可交易资金 2%
export const TRADE_ANALYSIS_MIN_LONG_HOLD_MS = 1800000; // Long 平均持有 < 30 分钟 → 红旗
export const TRADE_ANALYSIS_FEE_DRAG_PCT = 35;      // 手续费吃掉毛利 35% → 红旗
export const TRADE_ANALYSIS_MFE_CAPTURE_MIN = 0.5;  // 实际净利/MFE 低于 0.5 → 盈利没被保护
export const TRADE_ANALYSIS_QUICK_LOSS_MS = 300000; // 5 分钟内离场且亏损集中 → 亏损乱跑
export const TRADE_ANALYSIS_FLIP_LIMIT = 3;         // 反手次数上限
export const TRADE_ANALYSIS_MIN_SAMPLES = 30;       // 低于此样本数,结论标注样本不足
export const TRADE_ANALYSIS_DAY_MS = 86400000;
export const TRADE_ANALYSIS_FLAG_SEVERITY_ZH = { high: "高", medium: "中", low: "低" };

// ---- 私有数值工具(ta 前缀,避免扁平作用域重名)----
function taNumOrNull(v) {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function taNum(v, fallback) {
  const n = taNumOrNull(v);
  return n == null ? (fallback === undefined ? 0 : fallback) : n;
}
function taRound(v, digits) {
  const n = taNumOrNull(v);
  if (n == null) return null;
  const p = Math.pow(10, taNum(digits, 4));
  const r = Math.round(n * p) / p;
  return Number.isFinite(r) ? r : null;
}
function taMean(list) {
  const arr = (list || []).filter((v) => taNumOrNull(v) != null);
  if (!arr.length) return null;
  return arr.reduce((a, v) => a + v, 0) / arr.length;
}
function taMedian(list) {
  const arr = (list || []).filter((v) => taNumOrNull(v) != null).slice().sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}
function taTimeOf(t) {
  return taNumOrNull(t.exit_time) != null ? taNumOrNull(t.exit_time)
    : (taNumOrNull(t.created_at) != null ? taNumOrNull(t.created_at) : taNumOrNull(t.entry_time));
}
function taSortTime(t) {
  return taNumOrNull(t.entry_time) != null ? taNumOrNull(t.entry_time) : taNum(taTimeOf(t), 0);
}
// 母仓位键:parent_position_id / position_id / trade_id(去掉 partial 序号)
function taMotherKey(t) {
  if (t.parent_position_id) return String(t.parent_position_id);
  if (t.position_id) return String(t.position_id);
  const id = String(t.trade_id || "");
  const m = id.match(/^trd_partial_(.+)_(\d+)$/);
  if (m) return m[1];
  return id.replace(/^trd_/, "") || "unknown";
}
function taSideOf(t) {
  const s = String(t.side || t.direction || "").toUpperCase();
  if (s === "SHORT" || s === "SELL" || s === "BEAR") return "SHORT";
  if (s === "LONG" || s === "BUY" || s === "BULL") return "LONG";
  return null;
}
function taIsPartialEvent(t) {
  if (t.partial === true || t.position_event === true) return true;
  return /(^|_)partial/i.test(String(t.exit_reason || ""));
}
// 母仓位入场保证金:优先显式字段,最后退回"名义 ÷ 杠杆"。
// 部分平仓会让剩余保证金变小,所以取事件中的最大值 ≈ 入场时保证金。
function taMarginOf(t) {
  const direct = [t.entry_margin, t.initial_margin, t.position_margin, t.margin, t.entry_notional_closed];
  for (const v of direct) {
    const n = taNumOrNull(v);
    if (n != null && n > 0) return n;
  }
  const notional = taNumOrNull(t.entry_notional != null ? t.entry_notional : t.notional);
  const lev = taNumOrNull(t.leverage);
  if (notional != null && notional > 0 && lev != null && lev > 0) return notional / lev;
  return null;
}
function taEntryQualityOf(t) {
  const cands = [t.entry_quality_score, t.entry_score, t.quality_score, t.entry_quality];
  for (const v of cands) {
    const n = taNumOrNull(v);
    if (n != null) return n;
  }
  return null;
}
function taExpectedEdgeOf(t) {
  const cands = [t.expected_net_edge_pct, t.net_expected_edge_pct, t.expected_edge_pct];
  for (const v of cands) {
    const n = taNumOrNull(v);
    if (n != null) return n;
  }
  return null;
}
function taLeverageSourceOf(t) {
  const v = t.leverage_source;
  return v == null || v === "" ? null : String(v);
}

// 母仓位聚合(不把 Partial Close 当独立样本)
function taBuildMother(key, eventsRaw) {
  const events = eventsRaw.slice().sort((a, b) => taNum(taTimeOf(a), 0) - taNum(taTimeOf(b), 0));
  const first = events[0] || {};
  const last = events[events.length - 1] || {};
  let net = 0;
  let fees = 0;
  let gross = 0;
  let wins = 0;
  let losses = 0;
  let partials = 0;
  let mfe = null;
  let mae = null;
  let margin = null;
  let eqSum = 0;
  let eqN = 0;
  let expected = null;
  let levSource = null;
  for (const t of events) {
    net += taNum(t.net_pnl, 0);
    fees += taNum(t.fees, 0);
    gross += taNum(t.gross_pnl, taNum(t.net_pnl, 0));
    const p = taNumOrNull(t.net_pnl);
    if (p != null) { if (p > 0) wins += 1; else if (p < 0) losses += 1; }
    if (taIsPartialEvent(t)) partials += 1;
    const m = taNumOrNull(t.mfe);
    if (m != null) mfe = mfe == null ? m : Math.max(mfe, m);
    const a = taNumOrNull(t.mae);
    if (a != null) mae = mae == null ? a : Math.max(mae, a);
    const mg = taMarginOf(t);
    if (mg != null) margin = margin == null ? mg : Math.max(margin, mg);
    const q = taEntryQualityOf(t);
    if (q != null) { eqSum += q; eqN += 1; }
    const e = taExpectedEdgeOf(t);
    if (e != null) expected = e;
    const ls = taLeverageSourceOf(t);
    if (ls != null) levSource = ls;
  }
  // 持仓时长:优先"首个事件入场 → 末个事件出场",退回记录里的最大 holding_ms
  const entryAt = taNumOrNull(first.entry_time);
  const exitAt = taTimeOf(last);
  let holding = entryAt != null && exitAt != null ? Math.max(0, exitAt - entryAt) : null;
  if (holding == null) {
    const hs = events.map((t) => taNumOrNull(t.holding_ms)).filter((v) => v != null);
    holding = hs.length ? Math.max(...hs) : null;
  }
  const returnOnPosition = taNumOrNull(last.return_on_position_pct) != null
    ? taNumOrNull(last.return_on_position_pct)
    : (margin != null && margin > 0 ? net / margin * 100 : null);
  return {
    key: key,
    symbol: String(first.symbol || last.symbol || "UNKNOWN"),
    mode: first.mode || last.mode || null,
    direction: taSideOf(first) || taSideOf(last),
    events: events.length,
    partial_events: partials,
    net_pnl: taRound(net, 8),
    gross_pnl: taRound(gross, 8),
    fees: taRound(fees, 8),
    wins: wins,
    losses: losses,
    entry_margin: margin,
    entry_at: entryAt,
    exit_at: exitAt,
    holding_ms: holding,
    mfe: mfe,
    mae: mae,
    avg_entry_quality: eqN > 0 ? taRound(eqSum / eqN, 4) : null,
    expected_edge_pct: expected,
    return_on_position_pct: taRound(returnOnPosition, 6),
    leverage_source: levSource,
    exit_reason: last.exit_reason || null,
    exit_reasons: [...new Set(events.map((t) => t.exit_reason).filter(Boolean))]
  };
}

function taSessionFromMothers(mothers, opts) {
  const o = opts || {};
  const tradable = taNumOrNull(o.tradable_capital != null ? o.tradable_capital : o.equity);
  const count = mothers.length;
  let netTotal = 0;
  let feesTotal = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  let losses = 0;
  let mfeTotal = 0;
  let mfeSamples = 0;
  let maeSamples = 0;
  let maeSum = 0;
  let partialTotal = 0;
  const margins = [];
  const allocs = [];
  const holdings = [];
  const longHoldings = [];
  const shortHoldings = [];
  const qualities = [];
  const expectPairs = [];
  const exitDist = {};
  const exitEventDist = {};
  const levDist = {};
  const actuals = [];
  let longPositions = 0;
  let shortPositions = 0;
  for (const m of mothers) {
    netTotal += taNum(m.net_pnl, 0);
    feesTotal += taNum(m.fees, 0);
    if (m.net_pnl > 0) wins += 1;
    else if (m.net_pnl < 0) losses += 1;
    if (taNum(m.gross_pnl, 0) > 0) grossProfit += taNum(m.gross_pnl, 0);
    else if (taNum(m.gross_pnl, 0) < 0) grossLoss += Math.abs(taNum(m.gross_pnl, 0));
    if (m.mfe != null) { mfeTotal += m.mfe; mfeSamples += 1; }
    if (m.mae != null) { maeSum += m.mae; maeSamples += 1; }
    partialTotal += taNum(m.partial_events, 0);
    if (m.entry_margin != null) {
      margins.push(m.entry_margin);
      if (tradable != null && tradable > 0) allocs.push(m.entry_margin / tradable * 100);
    }
    if (m.holding_ms != null) {
      holdings.push(m.holding_ms);
      if (m.direction === "LONG") { longHoldings.push(m.holding_ms); longPositions += 1; }
      else if (m.direction === "SHORT") { shortHoldings.push(m.holding_ms); shortPositions += 1; }
    } else if (m.direction === "LONG") longPositions += 1;
    else if (m.direction === "SHORT") shortPositions += 1;
    if (m.avg_entry_quality != null) qualities.push(m.avg_entry_quality);
    if (m.expected_edge_pct != null && m.return_on_position_pct != null) {
      expectPairs.push({ expected: m.expected_edge_pct, actual: m.return_on_position_pct });
    }
    if (m.return_on_position_pct != null) actuals.push(m.return_on_position_pct);
    const reason = m.exit_reason == null ? "UNKNOWN" : String(m.exit_reason);
    exitDist[reason] = taNum(exitDist[reason], 0) + 1;
    for (const r of m.exit_reasons) exitEventDist[r] = taNum(exitEventDist[r], 0) + 1;
    const lel = m.leverage_source == null ? "UNKNOWN" : String(m.leverage_source);
    levDist[lel] = taNum(levDist[lel], 0) + 1;
  }
  // 反手计数:同一标的上相邻母仓位方向相反
  let flip = 0;
  const bySymbol = new Map();
  for (const m of mothers.slice().sort((a, b) => taNum(a.entry_at, 0) - taNum(b.entry_at, 0))) {
    if (!bySymbol.has(m.symbol)) bySymbol.set(m.symbol, []);
    bySymbol.get(m.symbol).push(m);
  }
  for (const [, rows] of bySymbol) {
    for (let i = 1; i < rows.length; i += 1) {
      const a = rows[i - 1].direction;
      const b = rows[i].direction;
      if (a && b && a !== b) flip += 1;
    }
  }
  const analysis = {
    version: TRADE_ANALYSIS_VERSION,
    caliber: "mother_position",
    mother_positions: count,
    events: mothers.reduce((a, m) => a + taNum(m.events, 0), 0),
    partial_events: partialTotal,
    avg_entry_margin: taRound(taMean(margins), 4),
    median_entry_margin: taRound(taMedian(margins), 4),
    margin_samples: margins.length,
    avg_allocation_pct: taRound(taMean(allocs), 4),
    tradable_capital: tradable,
    win_rate: count > 0 ? taRound(wins / count, 6) : null,
    wins: wins,
    losses: losses,
    loss_share: count > 0 ? taRound(losses / count, 6) : null,
    net_pnl: taRound(netTotal, 8),
    fees: taRound(feesTotal, 8),
    fee_drag_pct: grossProfit > 0 ? taRound(feesTotal / grossProfit * 100, 4) : null,
    profit_factor: grossLoss > 0 ? taRound(grossProfit / grossLoss, 4) : null,
    gross_profit: taRound(grossProfit, 8),
    gross_loss: taRound(grossLoss, 8),
    mfe_avg: taRound(taMean(mothers.map((m) => m.mfe)), 8),
    mae_avg: taRound(taMean(mothers.map((m) => m.mae)), 8),
    mfe_total: taRound(mfeTotal, 8),
    mfe_samples: mfeSamples,
    mae_samples: maeSamples,
    mfe_capture_ratio: mfeTotal > 0 ? taRound(netTotal / mfeTotal, 6) : null,
    avg_holding_ms: taRound(taMean(holdings), 2),
    median_holding_ms: taRound(taMedian(holdings), 2),
    long_hold_avg_ms: taRound(taMean(longHoldings), 2),
    short_hold_avg_ms: taRound(taMean(shortHoldings), 2),
    long_positions: longPositions,
    short_positions: shortPositions,
    partial_close_avg: count > 0 ? taRound(partialTotal / count, 4) : null,
    exit_reason_dist: exitDist,
    exit_reason_event_dist: exitEventDist,
    avg_entry_quality: taRound(taMean(qualities), 4),
    entry_quality_samples: qualities.length,
    expected_vs_actual_edge: expectPairs.length
      ? {
        expected_avg: taRound(taMean(expectPairs.map((p) => p.expected)), 6),
        actual_avg: taRound(taMean(expectPairs.map((p) => p.actual)), 6),
        delta: taRound(taMean(expectPairs.map((p) => p.expected - p.actual)), 6),
        samples: expectPairs.length,
        note_zh: "负 delta = 实际收益低于开仓时的预期边际"
      }
      : { expected_avg: null, actual_avg: taRound(taMean(actuals), 6), delta: null, samples: 0, note_zh: "缺少预期边际记录" },
    leverage_source_dist: levDist,
    direction_flip_count: flip,
    sample_sufficient: count >= TRADE_ANALYSIS_MIN_SAMPLES,
    day_key: o.day_key == null ? null : String(o.day_key),
    flags: []
  };
  const flags = redFlagScan(analysis, o);
  analysis.flags = flags.map((f) => f.code);
  analysis.flag_details = flags;
  return analysis;
}

// 会话级(全量)分析:以完整母仓位为单位
export function sessionAnalysis(trades, opts) {
  const o = opts || {};
  const list = (Array.isArray(trades) ? trades : []).filter((t) => t && typeof t === "object");
  const groups = new Map();
  for (const t of list) {
    const key = taMotherKey(t);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const mothers = [...groups.entries()].map(([key, events]) => taBuildMother(key, events));
  return taSessionFromMothers(mothers, o);
}

// 单日分析:按 opts.dayMs / dayKey 与 86400000 取 UTC 整日边界(不依赖 Date.now())
export function dailyAnalysis(trades, dayKey, opts) {
  const o = opts || {};
  let start = null;
  let key = null;
  const source = dayKey != null ? dayKey : o.day_key;
  if (typeof source === "number" && Number.isFinite(source)) {
    start = Math.floor(source / TRADE_ANALYSIS_DAY_MS) * TRADE_ANALYSIS_DAY_MS;
  } else if (typeof source === "string" && /^\d{4}-\d{2}-\d{2}$/.test(source)) {
    const parsed = Date.parse(source + "T00:00:00.000Z");
    start = Number.isFinite(parsed) ? parsed : null;
    key = source;
  } else if (source && typeof source === "object") {
    const ms = taNumOrNull(source.dayMs != null ? source.dayMs : (source.day_ms != null ? source.day_ms : source.ms));
    if (ms != null) start = Math.floor(ms / TRADE_ANALYSIS_DAY_MS) * TRADE_ANALYSIS_DAY_MS;
    else if (typeof source.day_key === "string") {
      const parsed = Date.parse(source.day_key + "T00:00:00.000Z");
      start = Number.isFinite(parsed) ? parsed : null;
      key = source.day_key;
    }
  }
  if (start == null) {
    const empty = taSessionFromMothers([], o);
    empty.day_key = null;
    empty.day_boundary = null;
    empty.note_zh = "无法确定日边界(需要 dayMs 或 YYYY-MM-DD)";
    return empty;
  }
  const end = start + TRADE_ANALYSIS_DAY_MS;
  const dayIso = key || new Date(start).toISOString().slice(0, 10);
  const list = (Array.isArray(trades) ? trades : []).filter((t) => {
    if (!t || typeof t !== "object") return false;
    const at = taTimeOf(t);
    return at != null && at >= start && at < end;
  });
  const analysis = sessionAnalysis(list, { ...o, day_key: dayIso });
  analysis.day_boundary = { start: start, end: end, day_key: dayIso, tz: "UTC" };
  return analysis;
}

// 红旗扫描:逐条给中文结论 + severity + evidence(ant 仓 / 费用吞噬 / 盈利未保护 / 亏损乱跑 / 频繁反手 / Long 太短)
export function redFlagScan(analysis, opts) {
  const a = analysis || {};
  const o = opts || {};
  const out = [];
  const tradable = taNumOrNull(o.tradable_capital != null ? o.tradable_capital : a.tradable_capital);
  const minMarginUsdt = taNum(o.min_margin_usdt, TRADE_ANALYSIS_MIN_MARGIN_USDT);
  const minMarginPct = taNum(o.min_margin_pct, TRADE_ANALYSIS_MIN_MARGIN_PCT);
  const feeLimit = taNum(o.fee_drag_pct, TRADE_ANALYSIS_FEE_DRAG_PCT);
  const captureMin = taNum(o.mfe_capture_min, TRADE_ANALYSIS_MFE_CAPTURE_MIN);
  const quickLossMs = taNum(o.quick_loss_ms, TRADE_ANALYSIS_QUICK_LOSS_MS);
  const minLongHold = taNum(o.min_long_hold_ms, TRADE_ANALYSIS_MIN_LONG_HOLD_MS);
  const flipLimit = taNum(o.flip_limit, TRADE_ANALYSIS_FLIP_LIMIT);

  const marginRef = a.median_entry_margin != null ? a.median_entry_margin : taNumOrNull(a.avg_entry_margin);
  if (marginRef != null) {
    const pctThreshold = tradable != null && tradable > 0 ? tradable * minMarginPct / 100 : null;
    const byUsdt = marginRef < minMarginUsdt;
    const byPct = pctThreshold != null && marginRef < pctThreshold;
    if (byUsdt || byPct) {
      out.push({
        code: "ANTS_POSITION",
        zh: "仍是蚂蚁仓:母仓位入场保证金太小,手续费会吃掉全部意义",
        severity: "high",
        evidence: {
          median_entry_margin: a.median_entry_margin, avg_entry_margin: a.avg_entry_margin,
          threshold_usdt: minMarginUsdt, threshold_pct: minMarginPct, pct_threshold_usdt: taRound(pctThreshold, 4),
          tradable_capital: tradable, breach: byUsdt ? "usdt" : "pct", margin_samples: a.margin_samples
        }
      });
    }
  }
  if (a.fee_drag_pct != null && taNum(a.fee_drag_pct, 0) >= feeLimit) {
    out.push({
      code: "FEE_EATS_PROFIT",
      zh: "手续费吞掉利润:手续费已占毛利润 " + taRound(a.fee_drag_pct, 2) + "%",
      severity: taNum(a.fee_drag_pct, 0) >= feeLimit * 1.7 ? "high" : "medium",
      evidence: { fee_drag_pct: a.fee_drag_pct, fees: a.fees, gross_profit: a.gross_profit, threshold_pct: feeLimit }
    });
  }
  if (a.mfe_total != null && a.mfe_total > 0 && a.net_pnl != null && a.mfe_capture_ratio != null) {
    if (a.mfe_capture_ratio < captureMin) {
      out.push({
        code: "PROFIT_NOT_PROTECTED",
        zh: "盈利没有被保护:到过浮盈 " + taRound(a.mfe_total, 4) + "U,最终只落袋 " + taRound(a.net_pnl, 4) + "U",
        severity: a.mfe_capture_ratio <= 0 ? "high" : "medium",
        evidence: { mfe_total: a.mfe_total, net_pnl: a.net_pnl, mfe_capture_ratio: a.mfe_capture_ratio, threshold: captureMin }
      });
    }
  }
  if (a.avg_holding_ms != null && a.avg_holding_ms < quickLossMs
    && a.loss_share != null && a.loss_share >= 0.5 && a.mother_positions > 0) {
    out.push({
      code: "LOSSES_RUNNING",
      zh: "亏损乱跑:平均持有仅 " + taRound(a.avg_holding_ms / 60000, 2) + " 分钟,且亏损仓位占比 " + taRound(a.loss_share * 100, 1) + "%",
      severity: "medium",
      evidence: { avg_holding_ms: a.avg_holding_ms, threshold_ms: quickLossMs, loss_share: a.loss_share, losses: a.losses, mother_positions: a.mother_positions }
    });
  }
  if (taNum(a.direction_flip_count, 0) >= flipLimit) {
    out.push({
      code: "FREQUENT_FLIP",
      zh: "频繁反向:方向反手 " + taNum(a.direction_flip_count, 0) + " 次,策略在自相矛盾",
      severity: taNum(a.direction_flip_count, 0) >= flipLimit * 2 ? "high" : "medium",
      evidence: { direction_flip_count: a.direction_flip_count, threshold: flipLimit, mother_positions: a.mother_positions }
    });
  }
  if (a.long_hold_avg_ms != null && taNum(a.long_positions, 0) > 0 && a.long_hold_avg_ms < minLongHold) {
    out.push({
      code: "LONG_TOO_SHORT",
      zh: "Long 持仓太短:做多平均只持有 " + taRound(a.long_hold_avg_ms / 60000, 2) + " 分钟(< " + taRound(minLongHold / 60000, 0) + " 分钟)",
      severity: "medium",
      evidence: { long_hold_avg_ms: a.long_hold_avg_ms, min_long_hold_ms: minLongHold, long_positions: a.long_positions }
    });
  }
  if (a.mother_positions === 0) {
    out.push({
      code: "NO_SAMPLES", zh: "没有可分析的母仓位样本", severity: "low",
      evidence: { mother_positions: 0, events: taNum(a.events, 0) }
    });
  } else if (a.sample_sufficient === false) {
    out.push({
      code: "SMALL_SAMPLE",
      zh: "母仓位样本仅 " + a.mother_positions + " 个,结论仅供参考",
      severity: "low",
      evidence: { mother_positions: a.mother_positions, min_samples: TRADE_ANALYSIS_MIN_SAMPLES }
    });
  }
  return out;
}

// 中文视图
export function tradeAnalysisView(analysis, flags) {
  if (!analysis) return null;
  const a = analysis;
  const list = Array.isArray(flags) ? flags : (Array.isArray(a.flag_details) ? a.flag_details : []);
  const pct = (v, digits) => (v == null ? null : taRound(v * 100, digits == null ? 2 : digits));
  return {
    version: a.version || TRADE_ANALYSIS_VERSION,
    caliber_zh: a.caliber === "mother_position" ? "母仓位口径(Partial Close 不计为独立样本)" : String(a.caliber || ""),
    day_key: a.day_key,
    headline_zh: "母仓位 " + taNum(a.mother_positions, 0) + " 个(成交事件 " + taNum(a.events, 0) + " 条,含部分平仓 " + taNum(a.partial_events, 0) + " 次)",
    mother_positions: a.mother_positions,
    win_rate_pct: pct(a.win_rate, 2),
    net_pnl: a.net_pnl,
    fees: a.fees,
    fee_drag_pct: a.fee_drag_pct,
    profit_factor: a.profit_factor,
    avg_entry_margin: a.avg_entry_margin,
    median_entry_margin: a.median_entry_margin,
    avg_allocation_pct: a.avg_allocation_pct,
    mfe_avg: a.mfe_avg,
    mae_avg: a.mae_avg,
    avg_holding_min: a.avg_holding_ms == null ? null : taRound(a.avg_holding_ms / 60000, 2),
    long_hold_avg_min: a.long_hold_avg_ms == null ? null : taRound(a.long_hold_avg_ms / 60000, 2),
    partial_close_avg: a.partial_close_avg,
    avg_entry_quality: a.avg_entry_quality,
    exit_reason_dist: a.exit_reason_dist,
    leverage_source_dist: a.leverage_source_dist,
    expected_vs_actual_edge: a.expected_vs_actual_edge,
    flags: list.map((f) => ({
      code: f.code, zh: f.zh,
      severity: f.severity, severity_zh: TRADE_ANALYSIS_FLAG_SEVERITY_ZH[f.severity] || f.severity,
      evidence: f.evidence
    })),
    flags_zh: list.map((f) => f.zh)
  };
}
