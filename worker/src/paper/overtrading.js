// paper/overtrading.js · V16.1 §2 · 过度交易监控与自动收紧(纯函数,无 I/O)
// 解决"系统自己停不下来"的问题:频率飙升、反复反手、费用拖累、过早离场、同标的反复入场,
// 都必须在行为上被量化出来,并且【一旦确认过度交易就自动收紧入口闸门/冷却时间/每小时开仓上限】。
// 铁律:
//   - 收紧只能让门槛更高、冷却更长、上限更低,绝不反向放松;
//   - 收紧有硬上限(阈值 +20 / 冷却 ×4 / 每小时 ≥1 单),避免无限收紧把系统锁死;
//   - 未过度交易时原样返回(不制造"看起来在做事"的假动作);
//   - 空样本一律 0/null,绝不产生 NaN。
export const OVERTRADING_VERSION = "overtrading-v1.0";

// 8 个固定指标键(键名固定,值为中文标签)
export const OVERTRADING_METRICS = {
  trades_per_hour: "每小时交易笔数",
  positions_per_day: "每日新开母仓位数",
  avg_holding_ms: "平均持仓时长(毫秒)",
  median_holding_ms: "持仓时长中位数(毫秒)",
  reentry_count: "同标的重复入场次数",
  direction_flip_count: "方向反手次数",
  fee_drag_pct: "手续费占毛利润比例(%)",
  early_exit_rate: "过早离场比例(0~1)"
};
export const OVERTRADING_METRIC_KEYS = Object.keys(OVERTRADING_METRICS);

export const OVERTRADING_SPIKE_MULTIPLE = 2.5;   // 频率超过基线该倍数 → 飙升
export const OVERTRADING_FEE_DRAG_PCT = 35;      // 手续费吃掉毛利 35% 以上 → 异常
export const OVERTRADING_EARLY_EXIT_RATE = 0.6;  // 60% 以上仓位早退 → 异常
export const OVERTRADING_EARLY_EXIT_MS = 300000; // 5 分钟内离场算"过早"
export const OVERTRADING_REENTRY_LIMIT = 3;      // 同一标的重复入场次数上限
export const OVERTRADING_FLIP_LIMIT = 3;         // 方向反手次数上限
export const OVERTRADING_HOUR_MS = 3600000;
export const OVERTRADING_DAY_MS = 86400000;

// 自动收紧的硬上限(必须有,否则会无限收紧)
export const OVERTRADING_MAX_THRESHOLD_DELTA = 20;
export const OVERTRADING_MAX_COOLDOWN_MULTIPLIER = 4;
export const OVERTRADING_MIN_ENTRIES_PER_HOUR = 1;
export const OVERTRADING_TIGHTEN_STEP = 2;       // 每级严重度对应的门槛增量
export const OVERTRADING_COOLDOWN_STEP = 0.5;    // 每级严重度对应的冷却增加
export const OVERTRADING_DEFAULT_MAX_ENTRIES_PER_HOUR = 12;
export const OVERTRADING_CODE_ZH = {
  FREQUENCY_SPIKE: "交易频率远超基线",
  POSITION_SPIKE: "每日新开仓数远超基线",
  DIRECTION_FLIP: "频繁反手(方向反复横跳)",
  FEE_DRAG: "手续费吞掉大部分毛利",
  EARLY_EXIT: "过早离场比例过高",
  REENTRY_LOOP: "同一标的反复入场"
};

// ---- 私有数值工具(ot 前缀,避免扁平作用域重名)----
function otNumOrNull(v) {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function otNum(v, fallback) {
  const n = otNumOrNull(v);
  return n == null ? (fallback === undefined ? 0 : fallback) : n;
}
function otClamp(v, lo, hi) {
  const n = otNum(v, lo);
  return n < lo ? lo : (n > hi ? hi : n);
}
function otRound(v, digits) {
  const n = otNumOrNull(v);
  if (n == null) return null;
  const p = Math.pow(10, otNum(digits, 2));
  const r = Math.round(n * p) / p;
  return Number.isFinite(r) ? r : null;
}
function otMedian(list) {
  const arr = (list || []).filter((v) => otNumOrNull(v) != null).slice().sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}
function otTimeOf(t) {
  return otNumOrNull(t.exit_time) != null ? otNumOrNull(t.exit_time)
    : (otNumOrNull(t.created_at) != null ? otNumOrNull(t.created_at) : otNumOrNull(t.entry_time));
}
function otMotherKey(t) {
  if (t.parent_position_id) return String(t.parent_position_id);
  if (t.position_id) return String(t.position_id);
  const id = String(t.trade_id || "");
  const m = id.match(/^trd_partial_(.+)_(\d+)$/);
  if (m) return m[1];
  return id.replace(/^trd_/, "") || "unknown";
}
function otSideOf(t) {
  const s = String(t.side || t.direction || "").toUpperCase();
  if (s === "SHORT" || s === "SELL" || s === "BEAR") return "SHORT";
  if (s === "LONG" || s === "BUY" || s === "BULL") return "LONG";
  return null;
}

// 8 个过度交易指标(空样本 → 0/null,绝不 NaN)
export function overtradingStats(trades, opts) {
  const o = opts || {};
  const all = (Array.isArray(trades) ? trades : []).filter((t) => t && typeof t === "object");
  const timed = all.filter((t) => otTimeOf(t) != null).slice().sort((a, b) => otTimeOf(a) - otTimeOf(b));
  const now = otNumOrNull(o.now);
  const windowMs = otNumOrNull(o.window_ms);
  let list = timed;
  let effectiveWindow = null;
  if (now != null && windowMs != null && windowMs > 0) {
    effectiveWindow = windowMs;
    list = timed.filter((t) => otTimeOf(t) >= now - windowMs && otTimeOf(t) <= now);
  } else {
    // 未给定窗口:用数据自身的时间跨度;跨度为 0 时按 1 小时计(保守,不虚增频率)
    const first = timed.length ? otTimeOf(timed[0]) : null;
    const last = timed.length ? otTimeOf(timed[timed.length - 1]) : null;
    const span = first != null && last != null ? last - first : 0;
    effectiveWindow = span > 0 ? span : OVERTRADING_HOUR_MS;
  }
  const windowHours = effectiveWindow > 0 ? effectiveWindow / OVERTRADING_HOUR_MS : null;
  const windowDays = effectiveWindow > 0 ? effectiveWindow / OVERTRADING_DAY_MS : null;

  const mothers = new Map();
  for (const t of list) {
    const key = otMotherKey(t);
    if (!mothers.has(key)) mothers.set(key, []);
    mothers.get(key).push(t);
  }
  const motherRows = [...mothers.entries()].map(([key, events]) => {
    const sorted = events.slice().sort((a, b) => otTimeOf(a) - otTimeOf(b));
    const first = sorted[0] || {};
    const last = sorted[sorted.length - 1] || {};
    const entryAt = otNumOrNull(first.entry_time);
    const exitAt = otTimeOf(last);
    let holding = exitAt != null && entryAt != null ? Math.max(0, exitAt - entryAt) : null;
    if (holding == null) {
      const hs = sorted.map((t) => otNumOrNull(t.holding_ms)).filter((v) => v != null);
      holding = hs.length ? Math.max(...hs) : null;
    }
    return {
      key: key,
      symbol: String(first.symbol || last.symbol || "UNKNOWN"),
      direction: otSideOf(first) || otSideOf(last),
      entry_time: entryAt,
      exit_time: exitAt,
      holding_ms: holding,
      events: sorted.length
    };
  }).sort((a, b) => otNum(a.entry_time, 0) - otNum(b.entry_time, 0));

  const holdingSamples = [];
  for (const t of list) {
    const h = otNumOrNull(t.holding_ms);
    if (h != null) holdingSamples.push(Math.max(0, h));
  }
  if (!holdingSamples.length) {
    for (const m of motherRows) if (m.holding_ms != null) holdingSamples.push(m.holding_ms);
  }

  const bySymbol = new Map();
  for (const m of motherRows) {
    if (!bySymbol.has(m.symbol)) bySymbol.set(m.symbol, []);
    bySymbol.get(m.symbol).push(m);
  }
  let reentryCount = 0;
  let flipCount = 0;
  for (const [, rows] of bySymbol) {
    if (rows.length > 1) reentryCount += rows.length - 1;
    for (let i = 1; i < rows.length; i += 1) {
      const prev = rows[i - 1].direction;
      const cur = rows[i].direction;
      if (prev && cur && prev !== cur) flipCount += 1;
    }
  }

  let fees = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let netPnl = 0;
  for (const t of list) {
    fees += otNum(t.fees, 0);
    netPnl += otNum(t.net_pnl, 0);
    const g = otNum(t.gross_pnl, otNum(t.net_pnl, 0));
    if (g > 0) grossProfit += g;
    else if (g < 0) grossLoss += Math.abs(g);
  }

  const earlyMs = otNum(o.early_exit_ms, OVERTRADING_EARLY_EXIT_MS);
  const earlyMothers = motherRows.filter((m) => m.holding_ms != null && m.holding_ms < earlyMs).length;
  const holdingMothers = motherRows.filter((m) => m.holding_ms != null).length;

  const rawTradesPerHour = windowHours != null && windowHours > 0 ? list.length / windowHours : null;
  const stats = {
    trades_per_hour: list.length === 0 ? 0 : otRound(rawTradesPerHour, 4),
    positions_per_day: motherRows.length === 0 ? 0
      : otRound(windowDays > 0 ? motherRows.length / windowDays : null, 4),
    avg_holding_ms: holdingSamples.length ? otRound(holdingSamples.reduce((a, v) => a + v, 0) / holdingSamples.length, 2) : null,
    median_holding_ms: holdingSamples.length ? otRound(otMedian(holdingSamples), 2) : null,
    reentry_count: reentryCount,
    direction_flip_count: flipCount,
    fee_drag_pct: grossProfit > 0 ? otRound(fees / grossProfit * 100, 4) : null,
    early_exit_rate: holdingMothers > 0 ? otRound(earlyMothers / holdingMothers, 4) : null,
    // 附加取证字段(不改变 8 个固定指标)
    window_ms: effectiveWindow,
    window_hours: otRound(windowHours, 4),
    samples: list.length,
    mother_positions: motherRows.length,
    fees: otRound(fees, 8),
    net_pnl: otRound(netPnl, 8),
    gross_profit: otRound(grossProfit, 8),
    gross_loss: otRound(grossLoss, 8),
    early_exit_ms: earlyMs,
    early_exits: earlyMothers,
    avg_notional: otNumOrNull(o.avg_notional)
  };
  return stats;
}

// 过度交易判定:频率 → 基线倍数,再叠加反手/费用/早退/重复入场
export function detectOvertrading(stats, baseline, opts) {
  const o = opts || {};
  const s = stats || {};
  const b = baseline && typeof baseline === "object" ? baseline : (typeof baseline === "number" ? { trades_per_hour: baseline } : {});
  const multiple = otNum(o.spike_multiple, OVERTRADING_SPIKE_MULTIPLE);
  const feeDragLimit = otNum(o.fee_drag_pct, OVERTRADING_FEE_DRAG_PCT);
  const earlyLimit = otNum(o.early_exit_rate, OVERTRADING_EARLY_EXIT_RATE);
  const reentryLimit = otNum(o.reentry_limit, OVERTRADING_REENTRY_LIMIT);
  const flipLimit = otNum(o.flip_limit, OVERTRADING_FLIP_LIMIT);

  const baseTph = otNumOrNull(b.trades_per_hour);
  const tph = otNumOrNull(s.trades_per_hour);
  const ratio = baseTph != null && baseTph > 0 && tph != null ? otRound(tph / baseTph, 4) : null;
  const basePpd = otNumOrNull(b.positions_per_day);
  const ppd = otNumOrNull(s.positions_per_day);
  const posRatio = basePpd != null && basePpd > 0 && ppd != null ? otRound(ppd / basePpd, 4) : null;
  const baseFlips = otNumOrNull(b.direction_flip_count);

  const codes = [];
  const reasons = [];
  if (ratio != null && ratio > multiple) {
    codes.push("FREQUENCY_SPIKE");
    reasons.push("交易频率 " + tph + " 笔/小时,是基线 " + baseTph + " 的 " + ratio + " 倍(> " + multiple + " 倍)");
  }
  if (posRatio != null && posRatio > multiple) {
    codes.push("POSITION_SPIKE");
    reasons.push("每日新开仓 " + ppd + " 个,是基线 " + basePpd + " 的 " + posRatio + " 倍");
  }
  const flipNow = otNum(s.direction_flip_count, 0);
  const flipBar = Math.max(flipLimit, baseFlips != null ? baseFlips * 2 : 0);
  if (flipNow > flipBar) {
    codes.push("DIRECTION_FLIP");
    reasons.push("方向反手 " + flipNow + " 次,超过上限 " + flipBar + " 次");
  }
  if (s.fee_drag_pct != null && otNum(s.fee_drag_pct, 0) > feeDragLimit) {
    codes.push("FEE_DRAG");
    reasons.push("手续费占毛利润 " + otRound(otNum(s.fee_drag_pct, 0), 2) + "%,超过 " + feeDragLimit + "%");
  }
  if (s.early_exit_rate != null && otNum(s.early_exit_rate, 0) > earlyLimit) {
    codes.push("EARLY_EXIT");
    reasons.push("过早离场比例 " + otRound(otNum(s.early_exit_rate, 0) * 100, 2) + "%,超过 " + (earlyLimit * 100) + "%");
  }
  if (otNum(s.reentry_count, 0) > reentryLimit) {
    codes.push("REENTRY_LOOP");
    reasons.push("同标的重复入场 " + otNum(s.reentry_count, 0) + " 次,超过上限 " + reentryLimit + " 次");
  }
  const severityRatio = ratio == null ? 0 : Math.max(0, ratio - multiple);
  return {
    spike: codes.length > 0,
    codes: codes,
    reasons_zh: reasons,
    ratio: ratio,
    positions_ratio: posRatio,
    severity: codes.length + (severityRatio > 0 ? Math.min(2, Math.floor(severityRatio)) : 0),
    reason_zh: reasons.length ? reasons.join(";") : "未检测到过度交易"
  };
}

// 自动收紧:发现过度交易就提高门槛、延长冷却、降低每小时上限(全部单向,且有硬上限)
export function autoTighten(current, stats, opts) {
  const o = opts || {};
  const cur = current || {};
  const curDelta = otClamp(cur.entry_threshold_delta, 0, OVERTRADING_MAX_THRESHOLD_DELTA);
  const curMult = otClamp(cur.cooldown_multiplier, 1, OVERTRADING_MAX_COOLDOWN_MULTIPLIER);
  const curMax = Math.max(OVERTRADING_MIN_ENTRIES_PER_HOUR,
    Math.floor(otNum(cur.max_entries_per_hour, OVERTRADING_DEFAULT_MAX_ENTRIES_PER_HOUR)));

  const detected = o.spike != null
    ? { spike: Boolean(o.spike), codes: o.codes || [], reasons_zh: o.reasons_zh || [], ratio: otNumOrNull(o.ratio), severity: otNum(o.severity, o.codes ? o.codes.length : 1), reason_zh: (o.reasons_zh || []).join(";") }
    : detectOvertrading(stats, o.baseline, o);

  if (!detected.spike) {
    return {
      entry_threshold_delta: curDelta,
      cooldown_multiplier: curMult,
      max_entries_per_hour: curMax,
      reason_zh: "未检测到过度交易,闸门保持不变",
      applied: false,
      spike: false,
      codes: [],
      severity: 0,
      ratio: detected.ratio == null ? null : detected.ratio
    };
  }

  const severity = Math.max(1, Math.floor(otNum(detected.severity, 1)));
  const step = otNum(o.tighten_step, OVERTRADING_TIGHTEN_STEP);
  const cdStep = otNum(o.cooldown_step, OVERTRADING_COOLDOWN_STEP);
  // 目标值只由【统计严重度】决定(不叠加历史值),因此重复调用不会无限收紧
  const targetDelta = otClamp(severity * step, 0, OVERTRADING_MAX_THRESHOLD_DELTA);
  const targetMult = otClamp(1 + severity * cdStep, 1, OVERTRADING_MAX_COOLDOWN_MULTIPLIER);
  const targetMax = Math.max(OVERTRADING_MIN_ENTRIES_PER_HOUR,
    Math.floor(OVERTRADING_DEFAULT_MAX_ENTRIES_PER_HOUR / (1 + severity * cdStep)));

  const nextDelta = otClamp(Math.max(curDelta, targetDelta), 0, OVERTRADING_MAX_THRESHOLD_DELTA);
  const nextMult = otClamp(Math.max(curMult, targetMult), 1, OVERTRADING_MAX_COOLDOWN_MULTIPLIER);
  const nextMax = Math.max(OVERTRADING_MIN_ENTRIES_PER_HOUR, Math.min(curMax, targetMax));

  const parts = [];
  parts.push("入口门槛 +" + nextDelta);
  parts.push("冷却 ×" + nextMult);
  parts.push("每小时最多 " + nextMax + " 单");
  return {
    entry_threshold_delta: nextDelta,
    cooldown_multiplier: nextMult,
    max_entries_per_hour: nextMax,
    reason_zh: "检测到过度交易(" + (detected.codes || []).map((c) => OVERTRADING_CODE_ZH[c] || c).join("、") + "):" + parts.join(","),
    applied: true,
    spike: true,
    codes: detected.codes || [],
    severity: severity,
    ratio: detected.ratio == null ? null : detected.ratio
  };
}

// 中文视图
export function overtradingView(stats, tighten) {
  const s = stats || {};
  const t = tighten || {};
  const metrics = OVERTRADING_METRIC_KEYS.map((k) => {
    const raw = s[k];
    let v = raw;
    if (k === "early_exit_rate" && raw != null) v = otRound(raw * 100, 2);
    else if (raw != null) v = otRound(raw, 4);
    return {
      key: k,
      zh: OVERTRADING_METRICS[k],
      value: v == null ? null : v,
      text: v == null ? "--" : (k === "early_exit_rate" ? v + "%" : (k === "fee_drag_pct" ? v + "%" : String(v)))
    };
  });
  return {
    version: OVERTRADING_VERSION,
    metrics: metrics,
    spike: t.spike === true,
    reasons_zh: t.applied === true ? [t.reason_zh] : [],
    tighten_zh: t.applied === true
      ? "已自动收紧:门槛 +" + t.entry_threshold_delta + " / 冷却 ×" + t.cooldown_multiplier + " / 每小时上限 " + t.max_entries_per_hour + " 单"
      : "闸门保持不变(门槛 +" + otNum(t.entry_threshold_delta, 0) + " / 冷却 ×" + otNum(t.cooldown_multiplier, 1) + ")",
    hard_limits_zh: "门槛增量上限 +" + OVERTRADING_MAX_THRESHOLD_DELTA + " / 冷却上限 ×" + OVERTRADING_MAX_COOLDOWN_MULTIPLIER + " / 每小时下限 " + OVERTRADING_MIN_ENTRIES_PER_HOUR + " 单"
  };
}
