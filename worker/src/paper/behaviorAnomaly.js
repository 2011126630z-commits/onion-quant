// paper/behaviorAnomaly.js · V16 §22 行为异常检测(纯函数,无 I/O)
// 系统"看起来在跑"不等于"真的在正常工作":可能成交频率突然翻几倍(程序死循环下单)、
// 可能几小时没动静(后台被杀)、可能模型全部同方向(输入退化/别名单一)、
// 可能净值单 tick 跳 20%(坏报价直接进账本),也可能"突然爆赚"——那更可疑,
// 因为真金白银不会无缘无故变多,先查账再庆祝。
// 本模块只输出"异常清单与证据",不修改任何账本,不自动平仓(§34:禁止悄悄改历史资金)。
export const BEHAVIOR_VERSION = "behavior-anomaly-v1.0";

// 异常码:每个码对应一条可单独打靶的检测规则
export const BEHAVIOR_CODES = {
  TRADE_FREQ_SPIKE: "TRADE_FREQ_SPIKE",
  TRADE_DROUGHT: "TRADE_DROUGHT",
  HOLDING_COLLAPSE: "HOLDING_COLLAPSE",
  FEE_SPIKE: "FEE_SPIKE",
  LEVERAGE_FLAT: "LEVERAGE_FLAT",
  MODELS_SAME_DIRECTION: "MODELS_SAME_DIRECTION",
  MODELS_ALL_NEUTRAL: "MODELS_ALL_NEUTRAL",
  PNL_SHOCK_LOSS: "PNL_SHOCK_LOSS",
  PNL_SHOCK_GAIN: "PNL_SHOCK_GAIN",
  EQUITY_TICK_JUMP: "EQUITY_TICK_JUMP",
  RUNTIME_TICK_STOP: "RUNTIME_TICK_STOP",
  ACCOUNTING_SUSPECT_GAIN: "ACCOUNTING_SUSPECT_GAIN"
};

export const BEHAVIOR_ZH = {
  TRADE_FREQ_SPIKE: "交易频率异常暴增",
  TRADE_DROUGHT: "长时间没有交易",
  HOLDING_COLLAPSE: "持仓时间骤降",
  FEE_SPIKE: "手续费异常飙升",
  LEVERAGE_FLAT: "杠杆长期恒为同一值",
  MODELS_SAME_DIRECTION: "所有模型方向完全一致",
  MODELS_ALL_NEUTRAL: "所有模型长期都是中性",
  PNL_SHOCK_LOSS: "盈亏突然巨亏",
  PNL_SHOCK_GAIN: "盈亏突然暴增(先查账,不庆祝)",
  EQUITY_TICK_JUMP: "净值单 tick 跳变",
  RUNTIME_TICK_STOP: "后台运行 tick 停止",
  ACCOUNTING_SUSPECT_GAIN: "异常盈利,疑似记账错误"
};

export const BEHAVIOR_THRESHOLDS = {
  trade_freq_multiple: 3,                       // 超过基线 3 倍 → 频率暴增
  drought_ms: 6 * 3600000,                      // 6 小时没有交易 → 干旱
  holding_collapse_ratio: 0.25,                 // 持仓时间跌到基线的 1/4 → 骤降
  fee_spike_multiple: 3,                        // 手续费超过基线 3 倍
  pnl_shock_pct: 8,                             // 单轮盈亏超过净值 8% → 冲击
  equity_jump_pct: 12,                          // 单 tick 净值跳变 12%
  tick_stop_ms: 5 * 60000,                       // tick 停 5 分钟 → 判定停止
  suspicious_gain_pct: 25,                      // 单窗口盈利 25% → 必须查账
  suspicious_gain_window_ms: 10 * 60000         // 查账窗口
};

const BEHAVIOR_HOUR_MS = 3600000;
const BEHAVIOR_ACCOUNTING_TOL = 1e-6;

function behaviorNum(v, fallback) {
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  return fallback === undefined ? 0 : fallback;
}

function behaviorRound(v, digits) {
  const d = digits == null ? 4 : digits;
  const p = Math.pow(10, d);
  return Math.round(behaviorNum(v) * p) / p;
}

function behaviorMean(list) {
  const arr = (list || []).filter((v) => Number.isFinite(Number(v)));
  if (!arr.length) return null;
  let sum = 0;
  for (const v of arr) sum += Number(v);
  return sum / arr.length;
}

function behaviorPush(out, code, severity, detailZh, evidence) {
  out.push({
    code: code,
    zh: BEHAVIOR_ZH[code] || code,
    severity: severity,
    detail_zh: detailZh,
    evidence: evidence || {}
  });
}

// 模型方向归一化:显式 direction 优先,否则用 bull/bear 概率差推断(阈值 5pp)
function behaviorDirection(model) {
  if (!model) return "NEUTRAL";
  const raw = String(model.direction || "").toLowerCase();
  if (/bull|long|多/.test(raw)) return "BULL";
  if (/bear|short|空/.test(raw)) return "BEAR";
  if (/neutral|flat|中|idle/.test(raw)) return "NEUTRAL";
  const bull = behaviorNum(model.bull, null);
  const bear = behaviorNum(model.bear, null);
  if (bull != null && bear != null) {
    if (bull - bear >= 0.05) return "BULL";
    if (bear - bull >= 0.05) return "BEAR";
  }
  return "NEUTRAL";
}

// 主检测:输入一份运行态快照,输出异常清单(空数组 = 本轮到目前没发现异常)
export function detectBehaviorAnomalies(state, thresholds) {
  const s = state || {};
  const th = { ...BEHAVIOR_THRESHOLDS, ...(thresholds || {}) };
  const out = [];
  const now = behaviorNum(s.now, 0);
  const trades = Array.isArray(s.recent_trades) ? s.recent_trades.filter(Boolean) : [];
  const baseline = s.baseline || {};
  const basePerHour = behaviorNum(baseline.trades_per_hour, 0);
  const baseAvgFee = behaviorNum(baseline.avg_fee, 0);
  const baseAvgHold = behaviorNum(baseline.avg_holding_ms, 0);

  // 1) 交易频率暴增:近 1 小时成交远超基线(基线为 0 时不做此判定,避免除零/误报)
  const recentHour = trades.filter((t) => now - behaviorNum(t.at, now) <= BEHAVIOR_HOUR_MS);
  if (basePerHour > 0 && recentHour.length >= basePerHour * th.trade_freq_multiple) {
    const multiple = recentHour.length / basePerHour;
    behaviorPush(out, "TRADE_FREQ_SPIKE",
      multiple >= th.trade_freq_multiple * 2 ? "CRITICAL" : "WARN",
      "近 1 小时成交 " + recentHour.length + " 笔,是基线 " + basePerHour + " 笔/小时的 "
        + behaviorRound(multiple, 2) + " 倍",
      { trades_last_hour: recentHour.length, baseline_per_hour: basePerHour, multiple: behaviorRound(multiple, 3) });
  }

  // 2) 长时间不交易:tick 还在但账本没动静(可能被静默禁用/后台被杀)
  let lastTradeAt = null;
  for (const t of trades) {
    const at = behaviorNum(t.at, null);
    if (at == null) continue;
    if (lastTradeAt == null || at > lastTradeAt) lastTradeAt = at;
  }
  if (lastTradeAt == null && s.last_trade_at != null) lastTradeAt = behaviorNum(s.last_trade_at, null);
  if (lastTradeAt != null && now - lastTradeAt > th.drought_ms) {
    behaviorPush(out, "TRADE_DROUGHT", "WARN",
      "距上一笔已 " + behaviorRound((now - lastTradeAt) / BEHAVIOR_HOUR_MS, 2) + " 小时没有成交",
      { last_trade_at: lastTradeAt, silence_ms: now - lastTradeAt });
  }

  // 3) 持仓时间骤降:策略从"持仓型"偷偷退化成"秒进秒出"(滑点/手续费会吃掉一切)
  const recentAvgHold = behaviorMean(trades.map((t) => t.holding_ms));
  if (baseAvgHold > 0 && recentAvgHold != null && recentAvgHold < baseAvgHold * th.holding_collapse_ratio) {
    behaviorPush(out, "HOLDING_COLLAPSE", "WARN",
      "平均持仓 " + Math.round(recentAvgHold) + "ms,不足基线 " + Math.round(baseAvgHold) + "ms 的 "
        + Math.round(th.holding_collapse_ratio * 100) + "%",
      { avg_holding_ms: Math.round(recentAvgHold), baseline_avg_holding_ms: Math.round(baseAvgHold) });
  }

  // 4) 手续费骤升:同样笔数,费用却翻几倍(重复计费 / 费率配置被改)
  const recentAvgFee = behaviorMean(trades.map((t) => t.fees));
  if (baseAvgFee > 0 && recentAvgFee != null && recentAvgFee > baseAvgFee * th.fee_spike_multiple) {
    const multiple = recentAvgFee / baseAvgFee;
    behaviorPush(out, "FEE_SPIKE", multiple >= th.fee_spike_multiple * 2 ? "CRITICAL" : "WARN",
      "平均每笔手续费 " + behaviorRound(recentAvgFee, 6) + ",是基线 " + behaviorRound(baseAvgFee, 6) + " 的 "
        + behaviorRound(multiple, 2) + " 倍",
      { avg_fee: behaviorRound(recentAvgFee, 8), baseline_avg_fee: behaviorRound(baseAvgFee, 8), multiple: behaviorRound(multiple, 3) });
  }

  // 5) 杠杆恒为同一值:AUTO 杠杆应该随风险变化;永远一样 = 机制没生效(或被人为钉死)
  const leverages = (Array.isArray(s.leverage_values) ? s.leverage_values : []).map((v) => behaviorNum(v, null)).filter((v) => v != null);
  if (leverages.length >= 2 && leverages.every((v) => v === leverages[0]) && leverages[0] > 0) {
    behaviorPush(out, "LEVERAGE_FLAT", "WARN",
      "AUTO 杠杆在 " + leverages.length + " 次决策中恒为 " + leverages[0] + " 倍,升/降档机制可能没有真正生效",
      { value: leverages[0], samples: leverages.length });
  }

  // 6) 模型全部同方向:多个模型独立得出结论却完全一致 → 更像"输入退化/别名单一",而不是真共识
  const models = Array.isArray(s.models) ? s.models.filter(Boolean) : [];
  if (models.length >= 2) {
    const dirs = models.map(behaviorDirection);
    const allSame = dirs.every((d) => d === dirs[0]);
    if (allSame && dirs[0] === "NEUTRAL") {
      behaviorPush(out, "MODELS_ALL_NEUTRAL", "WARN",
        models.length + " 个模型长期全部为中性:模型可能没有真正参与决策",
        { models: models.length, direction: "NEUTRAL" });
    } else if (allSame) {
      behaviorPush(out, "MODELS_SAME_DIRECTION", "WARN",
        models.length + " 个模型方向完全一致(" + dirs[0] + "),需警惕输入退化/伪共识",
        { models: models.length, direction: dirs[0], kinds: models.map((m) => m.kind || "?") });
    }
  }

  // 7/8) PnL 冲击:单轮净盈亏相对净值超阈值
  const equityBefore = behaviorNum(s.equity_before, null);
  let recentNet = 0;
  let netKnown = false;
  for (const t of trades) {
    const pnl = behaviorNum(t.net_pnl, null);
    if (pnl == null) continue;
    recentNet += pnl;
    netKnown = true;
  }
  if (equityBefore != null && equityBefore > 0 && netKnown) {
    const pnlPct = recentNet / equityBefore * 100;
    if (pnlPct <= -th.pnl_shock_pct) {
      behaviorPush(out, "PNL_SHOCK_LOSS", "CRITICAL",
        "本轮净盈亏 " + behaviorRound(recentNet, 4) + " USDT,占净值 " + behaviorRound(pnlPct, 2) + "%(巨亏)",
        { net_pnl: behaviorRound(recentNet, 8), pnl_pct: behaviorRound(pnlPct, 4) });
    } else if (pnlPct >= th.pnl_shock_pct) {
      behaviorPush(out, "PNL_SHOCK_GAIN", "WARN",
        "本轮净盈亏 +" + behaviorRound(recentNet, 4) + " USDT,占净值 " + behaviorRound(pnlPct, 2) + "%:先查账,不庆祝",
        { net_pnl: behaviorRound(recentNet, 8), pnl_pct: behaviorRound(pnlPct, 4) });
    }
  }

  // 9) 净值单 tick 跳变:只取 telemetry 最近两点(而不是拿"日初 vs 现在"这种长窗口当跳变)
  const tele = Array.isArray(s.telemetry_history) ? s.telemetry_history.filter(Boolean) : [];
  if (tele.length >= 2) {
    const prev = behaviorNum(tele[tele.length - 2].equity, null);
    const cur = behaviorNum(tele[tele.length - 1].equity, null);
    if (prev != null && prev > 0 && cur != null) {
      const jumpPct = (cur - prev) / prev * 100;
      if (Math.abs(jumpPct) >= th.equity_jump_pct) {
        behaviorPush(out, "EQUITY_TICK_JUMP", "CRITICAL",
          "净值单 tick 从 " + behaviorRound(prev, 4) + " 跳到 " + behaviorRound(cur, 4) + "("
            + behaviorRound(jumpPct, 2) + "%),疑似坏报价/重复结算",
          { equity_prev: behaviorRound(prev, 8), equity_now: behaviorRound(cur, 8), jump_pct: behaviorRound(jumpPct, 4) });
      }
    }
  }

  // 10) Runtime tick 停止:比"没成交"更底层 —— 连心跳都停了
  const lastTickAt = behaviorNum(s.last_tick_at, null);
  if (lastTickAt != null && now - lastTickAt > th.tick_stop_ms) {
    behaviorPush(out, "RUNTIME_TICK_STOP", "CRITICAL",
      "距上次 runtime tick 已 " + Math.round((now - lastTickAt) / 1000) + " 秒(阈值 "
        + Math.round(th.tick_stop_ms / 1000) + " 秒):后台运行可能已停止",
      { last_tick_at: lastTickAt, silence_ms: now - lastTickAt });
  }

  // 11) 收益暴涨但账实不符:净值涨了,而账户增量与成交增量对不上 → 先怀疑记账
  const equityNow = behaviorNum(s.equity_now, null);
  const accountDelta = behaviorNum(s.account_delta_sum, null);
  const tradeDelta = behaviorNum(s.trade_delta_sum, null);
  if (equityBefore != null && equityBefore > 0 && equityNow != null) {
    const gainPct = (equityNow - equityBefore) / equityBefore * 100;
    if (gainPct >= th.suspicious_gain_pct && accountDelta != null && tradeDelta != null
      && Math.abs(accountDelta - tradeDelta) > BEHAVIOR_ACCOUNTING_TOL) {
      behaviorPush(out, "ACCOUNTING_SUSPECT_GAIN", "CRITICAL",
        "窗口内盈利 +" + behaviorRound(gainPct, 2) + "%,但账户增量与成交增量不一致("
          + behaviorRound(accountDelta, 6) + " vs " + behaviorRound(tradeDelta, 6) + "):疑似重复记账/单位错误",
        { gain_pct: behaviorRound(gainPct, 4), account_delta_sum: behaviorRound(accountDelta, 8), trade_delta_sum: behaviorRound(tradeDelta, 8) });
    }
  }

  return out;
}

const AUDIT_CHECK_ZH = {
  DUPLICATE_ACCOUNTING: "重复记账(同一笔成交被计两次)",
  DOUBLE_PNL: "重复盈亏(同一仓位的已实现盈亏被累加两次)",
  WRONG_SIDE: "盈亏方向与仓位方向矛盾",
  WRONG_PRICE: "成交价与行情价偏离过大",
  UNIT_ERROR: "数量/金额出现量级错误(1000× 或 1e8×)"
};

// 异常盈利审计:不庆祝,先查账。
// 五道账目检查(Duplicate / Double / WrongSide / WrongPrice / UnitError)任一不过 →
// suspicious=true 且打上 ACCOUNTING_SUSPECT_GAIN。
export function abnormalProfitAudit(input) {
  const o = input || {};
  const rates = {
    max_price_deviation_pct: 5,
    unit_scales: [1000, 1e8],
    unit_ratio_tolerance: 0.02,
    ...(o.rates || {})
  };
  const before = behaviorNum(o.equity_before, null);
  const after = behaviorNum(o.equity_after, null);
  const gainPct = before != null && before > 0 && after != null ? behaviorRound((after - before) / before * 100, 6) : null;
  const trades = Array.isArray(o.trades) ? o.trades.filter(Boolean) : [];
  const checks = [];

  // a) Duplicate Accounting:同一 trade_id 出现两次
  const tradeIdCount = {};
  for (const t of trades) {
    const id = t.trade_id != null ? String(t.trade_id) : null;
    if (id) tradeIdCount[id] = (tradeIdCount[id] || 0) + 1;
  }
  const dupTradeIds = Object.keys(tradeIdCount).filter((id) => tradeIdCount[id] > 1);
  checks.push({
    code: "DUPLICATE_ACCOUNTING",
    zh: AUDIT_CHECK_ZH.DUPLICATE_ACCOUNTING,
    pass: dupTradeIds.length === 0,
    detail: dupTradeIds.length ? ("trade_id 重复:" + dupTradeIds.join(",")) : "无重复 trade_id"
  });

  // b) Double PnL:同一 position_id 的已实现盈亏被计入多次
  const posPnlCount = {};
  for (const t of trades) {
    const pid = t.position_id != null ? String(t.position_id) : null;
    if (!pid) continue;
    if (t.realized_pnl != null && t.counted !== false) posPnlCount[pid] = (posPnlCount[pid] || 0) + 1;
  }
  const dupPosIds = Object.keys(posPnlCount).filter((id) => posPnlCount[id] > 1);
  checks.push({
    code: "DOUBLE_PNL",
    zh: AUDIT_CHECK_ZH.DOUBLE_PNL,
    pass: dupPosIds.length === 0,
    detail: dupPosIds.length ? ("position_id 重复计入盈亏:" + dupPosIds.join(",")) : "无重复盈亏"
  });

  // c) Wrong Side:盈亏符号与"价格移动 × 方向"矛盾
  const wrongSide = [];
  for (const t of trades) {
    const pnl = behaviorNum(t.realized_pnl, null);
    if (pnl == null || Math.abs(pnl) < BEHAVIOR_ACCOUNTING_TOL) continue;
    const entry = behaviorNum(t.entry_price, null);
    const exit = behaviorNum(t.price != null ? t.price : t.exit_price, null);
    if (entry == null || exit == null || entry <= 0) continue;
    const dir = String(t.direction || t.side || "").toUpperCase();
    const isLong = /LONG|BUY|BULL/.test(dir);
    const isShort = /SHORT|SELL|BEAR/.test(dir);
    if (!isLong && !isShort) continue;
    const priceMove = exit - entry;
    if (Math.abs(priceMove) < BEHAVIOR_ACCOUNTING_TOL) continue;
    const expected = isLong ? priceMove : -priceMove;
    if (Math.sign(expected) !== Math.sign(pnl)) wrongSide.push(t.trade_id || t.position_id || "?");
  }
  checks.push({
    code: "WRONG_SIDE",
    zh: AUDIT_CHECK_ZH.WRONG_SIDE,
    pass: wrongSide.length === 0,
    detail: wrongSide.length ? ("方向矛盾:" + wrongSide.join(",")) : "盈亏方向与方向一致"
  });

  // d) Wrong Price:成交价偏离行情价超过 max_price_deviation_pct
  const marketFallback = o.rates && o.rates.market_price != null ? behaviorNum(o.rates.market_price, null) : null;
  const wrongPrice = [];
  for (const t of trades) {
    const price = behaviorNum(t.price, null);
    const market = behaviorNum(t.market_price != null ? t.market_price : marketFallback, null);
    if (price == null || market == null || market <= 0) continue;
    const devPct = Math.abs(price - market) / market * 100;
    if (devPct > rates.max_price_deviation_pct) {
      wrongPrice.push((t.trade_id || "?") + " 偏离 " + behaviorRound(devPct, 2) + "%");
    }
  }
  checks.push({
    code: "WRONG_PRICE",
    zh: AUDIT_CHECK_ZH.WRONG_PRICE,
    pass: wrongPrice.length === 0,
    detail: wrongPrice.length ? wrongPrice.join(";") : "成交价与行情价一致"
  });

  // e) Unit Error:数量×价格 与填写的名义金额差 1000× 或 1e8×;或出现 1e12 级别的绝对值
  const unitErrors = [];
  for (const t of trades) {
    const qty = behaviorNum(t.qty, null);
    const price = behaviorNum(t.price, null);
    const notional = behaviorNum(t.notional, null);
    if (qty != null && qty > 0 && price != null && price > 0 && notional != null && notional > 0) {
      const expected = price * qty;
      const ratio = notional / expected;
      for (const scale of rates.unit_scales) {
        const hi = Math.abs(ratio - scale);
        const lo = Math.abs(ratio - 1 / scale);
        if (hi <= rates.unit_ratio_tolerance * scale || lo <= rates.unit_ratio_tolerance) {
          unitErrors.push((t.trade_id || "?") + " 名义金额差 " + behaviorRound(ratio, 4) + " 倍");
          break;
        }
      }
    }
    const pnl = behaviorNum(t.realized_pnl, null);
    if (pnl != null && Math.abs(pnl) >= 1e12) unitErrors.push((t.trade_id || "?") + " 盈亏量级异常 " + pnl);
  }
  checks.push({
    code: "UNIT_ERROR",
    zh: AUDIT_CHECK_ZH.UNIT_ERROR,
    pass: unitErrors.length === 0,
    detail: unitErrors.length ? unitErrors.join(";") : "数量/金额量级正常"
  });

  const failed = checks.filter((c) => !c.pass);
  const codes = failed.map((c) => c.code);
  const bigGain = gainPct != null && gainPct >= BEHAVIOR_THRESHOLDS.suspicious_gain_pct;
  const suspicious = failed.length > 0 || bigGain;
  if (failed.length > 0) codes.unshift("ACCOUNTING_SUSPECT_GAIN");

  return {
    version: BEHAVIOR_VERSION,
    suspicious: suspicious,
    gain_pct: gainPct,
    window_ms: behaviorNum(o.window_ms, null),
    checks: checks,
    codes: codes,
    failed_checks: failed.map((c) => c.code),
    requires_audit: bigGain,
    reason_zh: failed.length
      ? ("账目未通过:" + failed.map((c) => c.zh).join("、") + " —— 盈利数据不可信,需人工核账")
      : (bigGain ? "窗口内盈利异常偏高,先查账再确认" : "账目自洽,盈利可信")
  };
}

// 中文视图:严重度优先排序(CRITICAL 在前),UI 一眼看到最该处理的
export function behaviorView(list) {
  const arr = Array.isArray(list) ? list.filter(Boolean) : [];
  const severityRank = { CRITICAL: 0, WARN: 1 };
  return arr.slice().sort((a, b) => {
    const ra = severityRank[a.severity] == null ? 2 : severityRank[a.severity];
    const rb = severityRank[b.severity] == null ? 2 : severityRank[b.severity];
    return ra - rb;
  }).map((item) => ({
    code: item.code,
    zh: item.zh || BEHAVIOR_ZH[item.code] || item.code,
    severity: item.severity,
    severity_zh: item.severity === "CRITICAL" ? "严重" : (item.severity === "WARN" ? "警告" : item.severity),
    detail_zh: item.detail_zh,
    evidence: item.evidence || {}
  }));
}
