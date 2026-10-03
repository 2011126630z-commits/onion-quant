// paper/profitLock.js · Profit Lock Engine(V14.4)
// §28-§47, §77, §81:核心哲学"见好就收" —— 不追求卖在最高点,而是有利润后逐步降低"回吐风险"。
//
// 设计:
//   - 阶段(STAGE 0..4)由 MFE 的 R 倍数决定,不同阶段允许不同的保护强度
//   - 部分平仓比例不是写死 25%:从候选集 {10,20,25,33,50,66,75,100} 依证据挑选
//   - Trailing 距离随 ATR/波动/趋势强度/持仓盈利动态调整,但有"别收太紧"的下限
//   - Break-even 必须覆盖 手续费+滑点,不是简单等于开仓价
//   - Shadow Exit Research 只做研究:结果永不入账(§45)
import { PAPER_DEFAULTS, num, round, numOrNull } from "./accounting.js";
import { dirOf } from "./futures.js";

export const PROFIT_LOCK_VERSION = "profit-lock-v14.4";

// 阶段阈值(以 R = 初始风险单位 计)
export const PROFIT_STAGE_THRESHOLDS = { stage1: 0.5, stage2: 1.0, stage3: 2.0, stage4: 3.5 };
// 候选减仓比例(§32):最终由证据挑选,不是固定值
export const PARTIAL_FRACTIONS = [0.10, 0.20, 0.25, 0.33, 0.50, 0.66, 0.75, 1.0];
// 回吐比例警戒线
export const GIVEBACK_WARN_PCT = 25;
export const GIVEBACK_CRITICAL_PCT = 40;
// 保护性止损的"别太紧"下限(避免正常波动被扫)
export const MIN_PROTECT_ATR_MULT = 0.6;
export const MIN_PROTECT_PRICE_PCT = 0.25;

export const PROFIT_ACTIONS = ["HOLD", "MOVE_STOP", "TRAIL", "PARTIAL_CLOSE", "FULL_CLOSE"];

// ---- V15 P0:Profit Lock 状态机(同一 Stage 只执行一次,禁止无限切碎) ----
// 根因:此前 profitLockDecision 对"该 Stage 是否执行过"毫无记忆 —— 只要仓位仍处于 stage4,
// 每次风险轮次(20 秒)都会再砍一刀 → CSV 出现 66% → 66% → 66% 的碎片成交与虚假收益。
export const PROFIT_LOCK_STATE_KEY = "profit_lock_state";
// 节奏上限:Long 跟趋势(慢、轻),Short 更积极(快、可减更多)
export const PROFIT_LOCK_LIMITS = {
  short: { min_hold_ms: 5 * 60000, min_interval_ms: 6 * 60000, stage_cap: 1.0 },
  long: { min_hold_ms: 30 * 60000, min_interval_ms: 15 * 60000, stage_cap: 0.5 },
  risk_bypass: true   // 风险退出(止损/强平/风控)不受最短持仓与间隔限制(§12)
};
// 尘埃仓位门槛:剩余保证金低于此值(或低于初始的 12%)即视为碎片 → 一次性合理收尾
export const DUST_MIN_MARGIN_USDT = 0.3;
export const DUST_MIN_FRACTION_OF_INITIAL = 0.12;
// 单个仓位允许的部分平仓次数上限:超过就说明把仓位切碎了(Stage 状态机失效的典型症状),
// 必须告警并计入 integrity。此前 engine 引用了这个常量却从没定义过 → profitLockDiagnostics() 直接抛
// ReferenceError,整块 Profit Lock 监控在 UI 上永远是"未启动"(V16 修复)。
export const PROFIT_LOCK_WARN_PARTIALS_PER_POSITION = 4;

export function profitLockStateOf(position) {
  const raw = (position && position[PROFIT_LOCK_STATE_KEY]) || null;
  const executed = {};
  if (raw && raw.executed_stages) {
    for (const [k, v] of Object.entries(raw.executed_stages)) executed[String(k)] = num(v, 0);
  }
  return {
    executed_stages: executed,
    executed_stage_list: Object.keys(executed).map((n) => num(n, 0)).sort((a, b) => a - b),
    last_action_at: numOrNull(raw && raw.last_action_at),
    last_action: (raw && raw.last_action) || null,
    last_stage: numOrNull(raw && raw.last_stage),
    events: num(raw && raw.events, 0),
    total_closed_fraction: num(raw && raw.total_closed_fraction, 0)
  };
}

// 执行动作后写回状态(纯函数):同一 stage 执行过就不再重复
export function applyProfitLockState(position, event) {
  const e = event || {};
  const state = profitLockStateOf(position);
  const at = num(e.at, Date.now());
  const stage = numOrNull(e.stage);
  const fraction = num(e.fraction, 0);
  const isAction = e.action === "PARTIAL_CLOSE" || e.action === "FULL_CLOSE";
  const nextExecuted = { ...state.executed_stages };
  if (isAction && stage != null) nextExecuted[String(stage)] = at;
  const next = {
    executed_stages: nextExecuted,
    executed_stage_list: Object.keys(nextExecuted).map((n) => num(n, 0)).sort((a, b) => a - b),
    last_action_at: isAction ? at : state.last_action_at,
    last_action: e.action || state.last_action,
    last_stage: stage == null ? state.last_stage : stage,
    events: state.events + (isAction ? 1 : 0),
    total_closed_fraction: round(state.total_closed_fraction + (isAction ? fraction : 0), 6)
  };
  return { [PROFIT_LOCK_STATE_KEY]: next, ...next };
}

// 尘埃判定:剩余太小 → 不值得继续持有或再切,应一次性收尾
export function isDustPosition(position, options) {
  const o = options || {};
  const p = position || {};
  const remainingQty = num(p.remaining_quantity, num(p.quantity, 0));
  if (!(remainingQty > 0)) return true;
  const remainingMargin = num(p.remaining_margin, num(p.entry_notional, 0));
  const initialMargin = num(p.initial_margin, num(p.entry_notional, remainingMargin));
  if (remainingMargin > 0 && remainingMargin < num(o.min_margin_usdt, DUST_MIN_MARGIN_USDT)) return true;
  if (initialMargin > 0 && remainingMargin / initialMargin < num(o.min_fraction_of_initial, DUST_MIN_FRACTION_OF_INITIAL)) return true;
  return false;
}

function clamp(v, lo, hi) {
  const n = num(v, lo);
  return n < lo ? lo : n > hi ? hi : n;
}

// 初始风险单位 R(优先用开仓时冻结的初始风险,其次 ATR)
// 重要:止损会随盈利上移,若用"当前止损距离"当 R,R 会越来越小、R 倍数虚高 → 阶段误判。
// 因此引擎在开仓时写入 initial_risk,这里只读不重算。
export function riskUnitOf(position, options) {
  const opts = options || {};
  const entry = num(position && position.entry_price, 0);
  const frozen = numOrNull(position && position.initial_risk);
  if (frozen != null && frozen > 0) return { r: round(frozen, 8), basis: "initial_risk_frozen" };
  const initialStop = numOrNull(position && position.initial_stop_price);
  if (entry > 0 && initialStop != null && initialStop > 0 && Math.abs(entry - initialStop) > 0) {
    return { r: round(Math.abs(entry - initialStop), 8), basis: "initial_stop_distance" };
  }
  const stop = position && position.stop_state && position.stop_state.price != null
    ? numOrNull(position.stop_state.price)
    : numOrNull(position && position.stop_price);
  if (entry > 0 && stop != null && stop > 0) {
    const dist = Math.abs(entry - stop);
    if (dist > 0) return { r: round(dist, 8), basis: "stop_distance" };
  }
  const atr = num(opts.atr, 0);
  if (atr > 0) return { r: round(atr, 8), basis: "atr" };
  return { r: round(entry * 0.01, 8), basis: "entry_pct_default" };
}

// 当前/MFE 的 R 倍数
export function rMultipleOf(position, price, options) {
  const unit = riskUnitOf(position, options);
  const qty = num(position && (position.remaining_quantity != null ? position.remaining_quantity : position.quantity), 0);
  const entry = num(position && position.entry_price, 0);
  const isLong = dirOf(position) === "LONG";
  const cur = num(price, entry);
  const pnl = isLong ? (cur - entry) * qty : (entry - cur) * qty;
  const mfePnl = num(position && position.mfe, 0);
  const notional = num(position && position.notional, entry * qty) || 1;
  return {
    unit,
    pnl: round(pnl, 8),
    mfe_pnl: round(mfePnl, 8),
    peak_pnl: round(Math.max(mfePnl, pnl), 8),
    current_r: unit.r > 0 ? round(pnl / unit.r, 4) : 0,
    mfe_r: unit.r > 0 ? round(mfePnl / unit.r, 4) : 0,
    pnl_pct_of_notional: round(pnl / notional * 100, 4),
    mfe_pct_of_notional: round(mfePnl / notional * 100, 4)
  };
}

// §30:回吐(已经拿到又还回去的部分)
// 关键:只有"曾经真的有过浮盈"才存在回吐 —— 从未盈利就按差额计算会凭空造出回吐
export function givebackOf(position, price, options) {
  const r = rMultipleOf(position, price, options);
  const abs = r.peak_pnl > 0 ? round(Math.max(0, r.peak_pnl - r.pnl), 8) : 0;
  const pct = r.peak_pnl > 0 ? round(abs / r.peak_pnl * 100, 4) : 0;
  return {
    peak_pnl: r.peak_pnl,
    current_pnl: r.pnl,
    profit_giveback_abs: abs,
    profit_giveback_pct: pct,
    gave_back_any: abs > 0,
    severity: pct >= GIVEBACK_CRITICAL_PCT ? "critical" : pct >= GIVEBACK_WARN_PCT ? "warning" : "ok",
    r_multiple: r
  };
}

// §33-§38:阶段判定
export function profitStage(input) {
  const i = input || {};
  const mfeR = num(i.mfe_r, 0);
  const givebackPct = num(i.giveback_pct, 0);
  const reversal = num(i.reversal_risk, 0);
  if (mfeR >= PROFIT_STAGE_THRESHOLDS.stage4 || givebackPct >= GIVEBACK_CRITICAL_PCT) return 4;
  if (mfeR >= PROFIT_STAGE_THRESHOLDS.stage3) return 3;
  if (givebackPct >= GIVEBACK_WARN_PCT && reversal >= 0.5) return 3;
  if (mfeR >= PROFIT_STAGE_THRESHOLDS.stage2) return 2;
  if (mfeR >= PROFIT_STAGE_THRESHOLDS.stage1) return 1;
  return 0;
}

// §32:动态减仓比例(候选集中按证据选,并返回理由)
export function dynamicPartialFraction(input) {
  const i = input || {};
  const stage = num(i.stage, 0);
  const reversal = clamp(num(i.reversal_risk, 0), 0, 1);
  const trend = clamp(num(i.trend_strength, 0.5), 0, 1);
  const mfeR = num(i.mfe_r, 0);
  const remainingOpportunity = clamp(num(i.remaining_opportunity, 0.5), 0, 1);
  const predictionBull = numOrNull(i.prediction_bullish);
  const volLevel = String(i.volatility_level || "");
  const reasons = [];

  if (stage <= 0) return { fraction: 0, target: 0, reasons: ["STAGE 0:未形成明显利润,不因一点浮盈频繁平仓(§34)"] };
  if (stage === 1) return { fraction: 0, target: 0, reasons: ["STAGE 1:初步盈利,保持仓位或轻微提高保护(§35)"] };

  // 基础比例随阶段递增
  let score = 0;
  if (stage === 2) { score = 0.3; reasons.push("STAGE 2:利润扩大,考虑部分锁定(§36)"); }
  else if (stage === 3) { score = 0.5; reasons.push("STAGE 3:利润明显,增加利润保护(§37)"); }
  else { score = 0.75; reasons.push("STAGE 4:高回吐风险,允许大幅减仓(§38)"); }

  score += reversal * 0.3;
  if (reversal >= 0.6) reasons.push("反转风险高(" + round(reversal, 3) + ")");
  score -= trend * 0.2;
  if (trend >= 0.7) reasons.push("趋势仍强,少减仓");
  score -= remainingOpportunity * 0.15;
  if (predictionBull != null) {
    if (predictionBull >= 0.55) { score -= 0.12; reasons.push("未来预测偏多,保留更多"); }
    else if (predictionBull <= 0.4) { score += 0.12; reasons.push("未来预测转弱,加快锁定"); }
  }
  if (/High|Extreme/.test(volLevel)) { score += 0.08; reasons.push("波动偏高,提前锁定"); }
  if (mfeR >= 5) { score += 0.05; reasons.push("MFE 已很大,保护优先"); }

  const clamped = clamp(score, 0, 1);
  // 最近候选(向上取,保证"该减就减"而不是四舍五入到更小)
  let chosen = PARTIAL_FRACTIONS[PARTIAL_FRACTIONS.length - 1];
  for (const f of PARTIAL_FRACTIONS) { if (f >= clamped - 1e-9) { chosen = f; break; } }
  if (chosen >= 1) reasons.push("证据指向全部锁定");
  return {
    fraction: chosen,
    target: round(clamped, 4),
    reasons,
    candidates: PARTIAL_FRACTIONS,
    basis: { stage, reversal_risk: round(reversal, 4), trend_strength: round(trend, 4), remaining_opportunity: round(remainingOpportunity, 4), volatility: volLevel || null }
  };
}

// §39:Trailing 距离随波动/趋势/盈利动态变化(不是永远 1%)
export function dynamicTrailingDistance(input) {
  const i = input || {};
  const atr = Math.max(0, num(i.atr, 0));
  const price = Math.max(0, num(i.price, 0));
  const profitR = num(i.profit_r, 0);
  const trend = clamp(num(i.trend_strength, 0.5), 0, 1);
  const volLevel = String(i.volatility_level || "");
  if (!(atr > 0) && !(price > 0)) return { distance: 0, atr_mult: 0, reason: "no_reference" };
  let mult = 1.4;
  if (trend >= 0.7) mult += 0.4;          // 趋势强 → 给更大空间
  else if (trend <= 0.35) mult -= 0.3;    // 趋势弱 → 收得更快
  if (/High/.test(volLevel)) mult += 0.4;
  else if (/Extreme/.test(volLevel)) mult += 0.6;
  else if (/Low|Compression/.test(volLevel)) mult -= 0.2;
  if (profitR >= 3) mult -= 0.3;          // 盈利很大 → 保护优先
  mult = clamp(mult, 0.6, 3.2);
  const distance = atr > 0 ? atr * mult : price * (mult * 0.005);
  return {
    distance: round(Math.max(distance, price * MIN_PROTECT_PRICE_PCT / 100), 8),
    atr_mult: round(mult, 3),
    reason: "趋势/波动/盈利共同决定(§39)"
  };
}

// §40/§41:保护性止损目标价(含手续费与滑点,且不允许收得比最低距离更紧)
export function protectedProfitStop(input) {
  const i = input || {};
  const entry = num(i.entry_price, 0);
  const price = num(i.price, entry);
  const isLong = i.side !== "SHORT";
  const atr = num(i.atr, 0);
  const feeBps = num(i.fee_bps, PAPER_DEFAULTS.fee_bps);
  const slipBps = num(i.slippage_bps, PAPER_DEFAULTS.slippage_bps);
  const spreadBps = num(i.half_spread_bps, PAPER_DEFAULTS.half_spread_bps);
  const costRate = (feeBps * 2 + slipBps * 2 + spreadBps) / 10000;
  const costBuffer = entry * costRate;
  const bePrice = isLong ? entry + costBuffer : entry - costBuffer;
  const floorDistance = Math.max(atr * MIN_PROTECT_ATR_MULT, price * MIN_PROTECT_PRICE_PCT / 100);
  const protectedPct = clamp(num(i.protect_pct, 0), 0, 0.8);   // 锁定比例(相对当前价到开仓价)
  const already = isLong ? price - entry : entry - price;
  const lockedPrice = isLong ? entry + already * protectedPct : entry - already * protectedPct;
  // 保护价必须至少覆盖成本,且与当前价保持最低距离(避免被打得太紧)
  const minDistance = floorDistance;
  let target = isLong ? Math.max(bePrice, lockedPrice) : Math.min(bePrice, lockedPrice);
  target = isLong ? Math.min(target, price - minDistance) : Math.max(target, price + minDistance);
  return {
    stop_price: round(Math.max(0, target), 8),
    cost_buffer: round(costBuffer, 8),
    cost_rate: round(costRate, 8),
    break_even_price: round(bePrice, 8),
    floor_distance: round(floorDistance, 8),
    covers_cost: isLong ? target >= bePrice : target <= bePrice,
    note: "Break-even 覆盖 手续费+滑点+价差;并保持最低保护距离(§40/§41)"
  };
}

// §29-§31:单次决策(引擎只执行它返回的动作)
export function profitLockDecision(input) {
  const i = input || {};
  const position = i.position || {};
  const price = num(i.price, num(position.current_price, position.entry_price));
  const gb = givebackOf(position, price, { atr: i.atr });
  const stage = profitStage({
    mfe_r: gb.r_multiple.mfe_r,
    giveback_pct: gb.profit_giveback_pct,
    reversal_risk: i.reversal_risk
  });
  const isLong = dirOf(position) === "LONG";
  const entry = num(position.entry_price, 0);
  const trendStrength = clamp(num(i.trend_strength, 0.5), 0, 1);
  const currentStop = position.stop_state && position.stop_state.price != null ? numOrNull(position.stop_state.price) : null;
  const trail = dynamicTrailingDistance({
    atr: i.atr,
    price,
    profit_r: gb.r_multiple.current_r,
    trend_strength: trendStrength,
    volatility_level: i.volatility_level
  });
  const protectedStop = protectedProfitStop({
    entry_price: entry,
    price,
    side: isLong ? "LONG" : "SHORT",
    atr: i.atr,
    protect_pct: stage >= 3 ? 0.5 : stage === 2 ? 0.3 : 0.15,
    fee_bps: i.fee_bps,
    slippage_bps: i.slippage_bps,
    half_spread_bps: i.half_spread_bps
  });
  const trailPrice = isLong ? price - trail.distance : price + trail.distance;
  // 止损只能朝有利方向移动:候选取"更有利"的那个
  const candidate = currentStop == null
    ? protectedStop.stop_price
    : (isLong ? Math.max(currentStop, Math.min(protectedStop.stop_price, trailPrice)) : Math.min(currentStop, Math.max(protectedStop.stop_price, trailPrice)));
  // 止损只能朝有利方向移动;首次设止损也算一次改善
  const stopImproved = currentStop == null ? true : (isLong ? candidate > currentStop : candidate < currentStop);

  const decision = {
    stage,
    giveback: gb,
    trail,
    protected_stop: protectedStop,
    action: "HOLD",
    fraction: 0,
    stop_price: null,
    reasons: [],
    is_long: isLong
  };

  // ---- V15 P0 状态机闸门(顺序:尘埃收尾 → 最短持有 → 同 Stage 幂等 → 最小间隔) ----
  const state = i.state ? i.state : profitLockStateOf(position);
  const limits = isLong ? PROFIT_LOCK_LIMITS.long : PROFIT_LOCK_LIMITS.short;
  const nowMs = num(i.now_ms, Date.now());
  const heldMs = Math.max(0, nowMs - num(position.entry_time, nowMs));
  const riskExit = Boolean(i.risk_exit);
  // ① 尘埃仓位:不再切,直接收尾(避免继续产生碎片成交与虚假收益)
  if (isDustPosition(position, i.dust)) {
    decision.action = "FULL_CLOSE";
    decision.fraction = 1;
    decision.dust_sweep = true;
    decision.reasons.push("剩余仓位已是尘埃(小于 " + DUST_MIN_MARGIN_USDT + "U 或初始的 " + Math.round(DUST_MIN_FRACTION_OF_INITIAL * 100) + "%),一次性收尾");
    return decision;
  }
  // ② 最短持有(§11/§12:普通利润锁定不允许几分钟切光;风控退出旁路)
  if (!riskExit && heldMs < num(limits.min_hold_ms)) {
    decision.reasons.push("未达最短持有(" + Math.round(heldMs / 60000) + " 分钟 < " + Math.round(limits.min_hold_ms / 60000) + " 分钟),暂不做利润锁定");
    // 仍允许推进保护性止损(不产生成交)
    if (stopImproved || currentStop == null) {
      decision.stop_price = round(candidate, 8);
      decision.action = currentStop == null || stage >= 2 ? "MOVE_STOP" : "TRAIL";
      decision.reasons.push("仅把止损推进到含费保护位(" + round(candidate, 8) + ")");
    }
    return decision;
  }

  // §34:STAGE 0 不动
  if (stage === 0) {
    decision.reasons.push("STAGE 0:利润未成形,继续持有");
    return decision;
  }
  // ③ 同一 Stage 只执行一次(状态机幂等)
  const stageDone = state.executed_stages && state.executed_stages[String(stage)] != null;
  if (stageDone && !riskExit) {
    decision.reasons.push("STAGE " + stage + " 已执行过(状态机保证同一阶段只减一次),不再重复减仓");
    if (stopImproved || currentStop == null) {
      decision.stop_price = round(candidate, 8);
      decision.action = "TRAIL";
      decision.reasons.push("继续推进保护性止损(" + round(candidate, 8) + ")");
    }
    return decision;
  }
  // ④ 最小间隔(两次实际减仓之间)
  const sinceLast = state.last_action_at == null ? null : nowMs - num(state.last_action_at);
  if (!riskExit && sinceLast != null && sinceLast < num(limits.min_interval_ms)) {
    decision.reasons.push("距上次减仓仅 " + Math.round(sinceLast / 60000) + " 分钟(最小间隔 " + Math.round(limits.min_interval_ms / 60000) + " 分钟),本次只推进止损");
    if (stopImproved || currentStop == null) {
      decision.stop_price = round(candidate, 8);
      decision.action = "TRAIL";
    }
    return decision;
  }

  // §34:STAGE 0 不动
  if (stage === 0) {
    decision.reasons.push("STAGE 0:利润未成形,继续持有");
    return decision;
  }
  // §38:STAGE 4 + 高反转风险 → 大幅减仓或全平
  if (stage === 4 && (num(i.reversal_risk, 0) >= 0.65 || gb.severity === "critical") && num(i.trend_strength, 0.5) <= 0.4) {
    decision.action = "FULL_CLOSE";
    decision.fraction = 1;
    decision.reasons.push("STAGE 4 且反转风险高/回吐严重,趋势转弱 → 全部锁定(§38)");
    return decision;
  }
  // 部分锁定
  const partial = dynamicPartialFraction({
    stage,
    reversal_risk: i.reversal_risk,
    trend_strength: i.trend_strength,
    mfe_r: gb.r_multiple.mfe_r,
    remaining_opportunity: i.remaining_opportunity,
    prediction_bullish: i.prediction_bullish,
    volatility_level: i.volatility_level
  });
  if (partial.fraction > 0) {
    // ⑤ Long 节奏上限:单次减仓不超过 stage_cap(避免 Long 被一次切掉大半)
    let fraction = Math.min(partial.fraction, num(limits.stage_cap, 1));
    fraction = clamp(fraction, 0, 1);
    // ⑥ 切完之后剩余若变成尘埃 → 直接一次性收尾(不留碎片仓位)
    const remainingQty = num(position.remaining_quantity, num(position.quantity, 0));
    const remainingMargin = num(position.remaining_margin, num(position.entry_notional, 0));
    const initialMargin = num(position.initial_margin, num(position.entry_notional, remainingMargin));
    const leftMargin = remainingMargin * (1 - fraction);
    const wouldBeDust = remainingQty > 0 && fraction < 1
      && ((leftMargin > 0 && leftMargin < DUST_MIN_MARGIN_USDT)
        || (initialMargin > 0 && leftMargin / initialMargin < DUST_MIN_FRACTION_OF_INITIAL));
    if (wouldBeDust) {
      decision.action = "FULL_CLOSE";
      decision.fraction = 1;
      decision.dust_sweep = true;
      decision.reasons = decision.reasons.concat(partial.reasons).concat(["减仓后剩余会成为尘埃,改为一次性收尾(不留碎片成交)"]);
      return decision;
    }
    decision.action = fraction >= 1 ? "FULL_CLOSE" : "PARTIAL_CLOSE";
    decision.fraction = round(fraction, 6);
    decision.reasons = decision.reasons.concat(partial.reasons);
    if (fraction !== partial.fraction) decision.reasons.push("按" + (isLong ? "长线" : "短线") + "节奏上限收敛到 " + Math.round(fraction * 100) + "%");
  }
  // 止损保护(可与部分平仓同时给出;引擎按顺序执行)
  if (stopImproved || currentStop == null) {
    decision.stop_price = round(candidate, 8);
    if (decision.action === "HOLD") {
      decision.action = currentStop == null || stage >= 2 ? "MOVE_STOP" : "TRAIL";
      decision.reasons.push("把止损推进到含费保护位(" + round(candidate, 8) + ")");
    } else {
      decision.reasons.push("同时把止损推进到 " + round(candidate, 8));
    }
  }
  if (decision.action === "HOLD") decision.reasons.push("保持观察(无更优动作)");
  return decision;
}

// §45:Shadow Exit Research —— 只做研究,禁止入账
export function shadowExitResearch(input) {
  const i = input || {};
  const entry = num(i.entry_price, 0);
  const price = num(i.price, entry);
  const side = i.side === "SHORT" ? "SHORT" : "LONG";
  const qty = num(i.quantity, 0);
  const notional = num(i.notional, entry * qty);
  const feeBps = num(i.fee_bps, PAPER_DEFAULTS.fee_bps);
  const slipBps = num(i.slippage_bps, PAPER_DEFAULTS.slippage_bps);
  const costRate = (feeBps * 2 + slipBps * 2) / 10000;
  const pnlAt = (p) => round((side === "LONG" ? (p - entry) : (entry - p)) * qty - notional * costRate, 8);
  const mfePrice = num(i.mfe_price, price);
  const scenarios = [];
  const add = (id, fraction, p) => scenarios.push({ id, fraction, price: round(p, 8), net_pnl: pnlAt(p), accounts: false });
  add("hold", 0, price);
  for (const f of [0.25, 0.5, 0.75]) add("partial_" + Math.round(f * 100), f, price);
  add("full_exit", 1, price);
  // Trailing:假设回撤到 ATR 距离处触发
  const trailDistance = num(i.trailing_distance, 0);
  if (trailDistance > 0) add("trailing", 1, side === "LONG" ? price - trailDistance : price + trailDistance);
  // 反事实:若在 MFE 极值处平仓(用于衡量"见好就收"的空间,不可作为策略)
  add("best_case_at_mfe", 1, mfePrice);
  return {
    generated_at: num(i.now, Date.now()),
    counted_into_account: false,
    note: "Shadow 结果只用于研究/学习,永不重复计入账户 PnL(§45)",
    scenarios,
    unrealized_now: pnlAt(price),
    mfe_unrealized: pnlAt(mfePrice)
  };
}

// §46:退出策略学习样本
export function exitLearningSample(input) {
  const i = input || {};
  const gb = i.giveback || {};
  return {
    sample_id: i.sample_id || "exit_" + num(i.now, Date.now()) + "_" + (i.symbol || "?"),
    symbol: i.symbol || null,
    mode: i.mode || null,
    regime: i.regime || null,
    volatility: i.volatility || null,
    leverage: num(i.leverage, 1),
    stage: num(i.stage, 0),
    max_unrealized_pnl: num(gb.peak_pnl, 0),
    realised_pnl: num(i.realised_pnl, 0),
    profit_locked: num(i.profit_locked, 0),
    profit_giveback: num(gb.profit_giveback_abs, 0),
    profit_giveback_pct: num(gb.profit_giveback_pct, 0),
    partial_close_sequence: Array.isArray(i.partial_close_sequence) ? i.partial_close_sequence.slice(0, 20) : [],
    trailing_distance: num(i.trailing_distance, 0),
    exit_policy: i.exit_policy || "profit-lock-v14.4",
    future_prediction_at_exit: i.future_prediction_at_exit || null,
    risk_at_exit: numOrNull(i.risk_at_exit),
    shadow: i.shadow === true,
    created_at: num(i.now, Date.now())
  };
}

export function exitPolicyKey(input) {
  const i = input || {};
  return [i.symbol || "*", i.mode || "*", i.regime || "*", i.volatility || "*", "lev" + num(i.leverage, 1), "stage" + num(i.stage, 0)].join("|");
}

// §46:按 币种/模式/环境/波动/杠杆/阶段 汇总哪种退出更稳
export function summarizeExitPolicies(samples, options) {
  const opts = { ...{ minSamples: 8, riskPenalty: 0.6 }, ...(options || {}) };
  const groups = new Map();
  for (const s of samples || []) {
    if (!s || s.shadow) continue;   // Shadow 不入账,但可单独研究
    const key = exitPolicyKey(s);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const out = [];
  for (const [key, list] of groups) {
    if (list.length < opts.minSamples) continue;
    const net = list.reduce((a, b) => a + num(b.realised_pnl, 0), 0);
    const peak = list.reduce((a, b) => a + num(b.max_unrealized_pnl, 0), 0);
    const giveback = list.reduce((a, b) => a + num(b.profit_giveback, 0), 0);
    const givebackPct = peak > 0 ? round(giveback / peak * 100, 4) : null;
    out.push({
      key,
      samples: list.length,
      net_pnl: round(net, 8),
      peak_unrealized: round(peak, 8),
      giveback_pct: givebackPct,
      avg_giveback_pct: round(list.reduce((a, b) => a + num(b.profit_giveback_pct, 0), 0) / list.length, 4),
      // 风险调整后的口径:回撤/回吐越小越稳
      risk_adjusted: round(net - Math.abs(giveback) * opts.riskPenalty, 6)
    });
  }
  return out.sort((a, b) => b.risk_adjusted - a.risk_adjusted);
}

// §47:Exit Policy Champion/Challenger 闸门
export const EXIT_PROMOTION_RULES = {
  min_shadow_samples: 60,
  min_walkforward_folds: 3,
  min_walkforward_pass_rate: 0.6,
  max_giveback_increase_pct: 5,
  max_drawdown_increase_pct: 3,
  min_net_pnl_improve: 0
};

export function evaluateExitPolicyPromotion(input) {
  const i = input || {};
  const R = { ...EXIT_PROMOTION_RULES, ...(i.rules || {}) };
  const c = i.challenger || {};
  const ch = i.champion || {};
  const reasons = [];
  const fail = (m) => reasons.push(m);
  const pass = (m) => reasons.push("通过:" + m);
  if (num(c.shadow_samples, 0) < R.min_shadow_samples) fail("Shadow 样本不足(" + num(c.shadow_samples, 0) + " < " + R.min_shadow_samples + ")");
  else pass("Shadow 样本 " + num(c.shadow_samples, 0));
  if (num(c.walkforward_folds, 0) < R.min_walkforward_folds) fail("Walk Forward Fold 不足");
  else if (num(c.walkforward_pass_rate, 0) < R.min_walkforward_pass_rate) fail("Walk Forward 通过率不足(" + num(c.walkforward_pass_rate, 0) + ")");
  else pass("Walk Forward 通过率 " + num(c.walkforward_pass_rate, 0));
  if (num(c.recent_holdout_samples, 0) < 30) fail("Recent Holdout 样本不足");
  else pass("Recent Holdout 样本 " + num(c.recent_holdout_samples, 0));
  const gbIncrease = num(c.giveback_pct, 0) - num(ch.giveback_pct, 0);
  if (gbIncrease > R.max_giveback_increase_pct) fail("回吐相比 Champion 增加 " + round(gbIncrease, 4) + "%");
  else pass("回吐未恶化(变化 " + round(gbIncrease, 4) + "%)");
  const ddIncrease = num(c.max_drawdown_pct, 0) - num(ch.max_drawdown_pct, 0);
  if (ddIncrease > R.max_drawdown_increase_pct) fail("回撤相比 Champion 增加 " + round(ddIncrease, 4) + "%");
  else pass("回撤未恶化");
  const pnlImprove = num(c.net_pnl, 0) - num(ch.net_pnl, 0);
  if (pnlImprove < R.min_net_pnl_improve) fail("净收益未改善(" + round(pnlImprove, 4) + ")");
  else pass("净收益改善 " + round(pnlImprove, 4));
  const promote = reasons.every((r) => r.startsWith("通过"));
  return { promote, verdict: promote ? "PROMOTE" : "KEEP_TESTING", reasons, challenger_version: c.version || null, champion_version: ch.version || null, rules: R };
}

// UI 文案(§74)
export function profitLockView(input) {
  const i = input || {};
  const gb = i.giveback || { peak_pnl: 0, current_pnl: 0, profit_giveback_abs: 0, profit_giveback_pct: 0 };
  const stage = num(i.stage, 0);
  const next = stage >= 4 ? "防守" : num(i.partial_fraction, 0) > 0 ? "部分锁定" : "继续持有";
  return {
    stage,
    stage_label: ["STAGE 0 未成形", "STAGE 1 初步盈利", "STAGE 2 利润扩大", "STAGE 3 利润较大", "STAGE 4 高回吐风险"][clamp(stage, 0, 4)],
    max_unrealized_text: round(num(gb.peak_pnl, 0), 2).toFixed(2) + " USDT",
    current_text: round(num(gb.current_pnl, 0), 2).toFixed(2) + " USDT",
    giveback_text: round(num(gb.profit_giveback_abs, 0), 2).toFixed(2) + " USDT(" + round(num(gb.profit_giveback_pct, 0), 1) + "%)",
    trailing_text: i.trailing_distance == null ? "--" : round(num(i.trailing_distance, 0), 4) + "",
    next_action: next
  };
}
