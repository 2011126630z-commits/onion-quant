// paper/allocation.js · Dynamic Allocation(V14.4)
// §59-§61:Short 主策略 / Long 辅助策略,允许在 60-80% / 20-40% 之间按风险调整后表现动态调整。
//
// 与既有约束的关系:
//   - 既有账户与测试基线是 50/50,且明确"不重置";本模块只输出"调仓计划",不直接动账本
//   - 单次调整步长受 accounting.rebalancePlan 的 max_rebalance_step_pct 约束(默认 10pp)
//   - 数据不足时保持现状,不为了"看起来动态"而乱调(§61 允许调,但不等于必须调)
import { PAPER_DEFAULTS, num, round, summarizeTrades } from "./accounting.js";

export const ALLOCATION_VERSION = "allocation-v14.5";
// §60/§2:动态区间(Short 60~80% / Long 20~40%,禁止 100/0)
export const ALLOCATION_BOUNDS = { short_min_pct: 60, short_max_pct: 80, long_min_pct: 20, long_max_pct: 40, balanced_pct: 50 };
// §1/§59:目标画像(Short 主 / Long 辅);新账户默认按 70/30 落账
export const ALLOCATION_PROFILES = {
  short_main: { short_pct: 70, long_pct: 30, label: "Short 主策略(70/30)" },
  balanced: { short_pct: 50, long_pct: 50, label: "均衡(50/50)" },
  short_max: { short_pct: 80, long_pct: 20, label: "Short 上限(80/20)" },
  defensive_long: { short_pct: 60, long_pct: 40, label: "Short 承压(60/40)" }
};
// 单次调整步长(§1:安全迁移,不做一次性大幅搬家)
export const ALLOCATION_STEP_PCT = 10;
export const ALLOCATION_MIN_TRADES = 20;
export const ALLOCATION_MIN_INTERVAL_MS = 6 * 3600000;

// 步进到目标(内部实现,不依赖 accounting.rebalancePlan 的 30~70 旧边界)
export function stepToward(currentPct, targetPct, options) {
  const opts = options || {};
  const bounds = { ...ALLOCATION_BOUNDS, ...(opts.bounds || {}) };
  const current = clampPct(currentPct, bounds.balanced_pct);
  const wanted = clampPct(targetPct, current);
  const maxStep = num(opts.maxStepPct, ALLOCATION_STEP_PCT);
  const step = Math.min(maxStep, Math.abs(wanted - current));
  const next = clampNum(current + Math.sign(wanted - current) * step, bounds.short_min_pct, bounds.short_max_pct);
  return { short_pct: round(next, 2), long_pct: round(100 - next, 2), changed: Math.abs(next - current) > 1e-9, step_pct: round(step, 4) };
}

function clampNum(v, lo, hi) {
  const n = num(v, lo);
  return n < lo ? lo : n > hi ? hi : n;
}

function clampPct(v, fallback) {
  return clampNum(num(v, fallback), 0, 100);
}

// 风险调整后的池子评分:样本量 / 胜率 / 平均净利 / 回撤 / 连亏 / 稳定性
export function riskAdjustedScore(stats, options) {
  const opts = { ...{ minTrades: 20, riskAversion: 1 }, ...(options || {}) };
  const s = stats || {};
  const trades = num(s.trades, 0);
  if (trades < opts.minTrades) {
    return { score: null, reliable: false, trades, reason: "样本不足(" + trades + " < " + opts.minTrades + ")" };
  }
  const winRate = num(s.win_rate, 0) / 100;
  const avg = num(s.avg_net_pnl, 0);
  const dd = num(s.max_drawdown_pct, 0);
  const consec = num(s.max_consecutive_losses, 0);
  const mfe = Math.abs(num(s.avg_mfe, 0));
  const mae = Math.abs(num(s.avg_mae, 0));
  const stability = 1 / (1 + Math.abs(mfe - mae));
  // 用样本量做置信收缩:小样本不敢给高分
  const shrink = Math.min(1, trades / 60);
  const raw = (winRate - 0.5) * 80 + avg * 6 - dd * 1.2 * opts.riskAversion - consec * 2 + stability * 6;
  return {
    score: round(raw * shrink, 4),
    reliable: true,
    trades,
    components: { win_rate: round(winRate, 4), avg_net_pnl: avg, max_drawdown_pct: dd, max_consecutive_losses: consec, stability: round(stability, 4), shrink: round(shrink, 4) }
  };
}

// §60/§61:动态分配(带原因),结果落在 60-80 / 20-40 区间
export function dynamicAllocation(input) {
  const i = input || {};
  const bounds = { ...ALLOCATION_BOUNDS, ...(i.bounds || {}) };
  const current = num(i.current_short_pct, bounds.balanced_pct);
  const s = riskAdjustedScore(i.shortStats, i);
  const l = riskAdjustedScore(i.longStats, i);
  const reasons = [];
  const drawdownState = String((i.drawdown && i.drawdown.state) || "NORMAL");

  if (!s.reliable || !l.reliable) {
    reasons.push("样本不足,保持当前分配(" + round(current, 2) + "/" + round(100 - current, 2) + ")");
    return {
      short_pct: round(current, 2),
      long_pct: round(100 - current, 2),
      changed: false,
      basis: "insufficient_samples",
      detail: { short: s, long: l },
      reasons,
      bounds
    };
  }
  // 相对优势 → 目标短池占比(50 ± diff,夹在 60-80/20-40 内)
  const diff = num(s.score, 0) - num(l.score, 0);
  let target = 70 + Math.max(-10, Math.min(10, diff * 0.6));
  // §61:某池明显回撤 → 降该池权重(即使它是"主策略")
  const shortDd = num(i.shortStats && i.shortStats.max_drawdown_pct, 0);
  const longDd = num(i.longStats && i.longStats.max_drawdown_pct, 0);
  if (shortDd > longDd + 5 && shortDd > 8) { target -= 5; reasons.push("Short 回撤明显大于 Long → 下调 Short 权重"); }
  else if (longDd > shortDd + 5 && longDd > 8) { target += 5; reasons.push("Long 回撤明显更大 → 上调 Short 权重"); }
  // 回撤状态:防守期不扩大进攻性策略的权重
  if (drawdownState === "DEFENSIVE" || drawdownState === "HARD_STOP") {
    target = Math.min(target, current);
    reasons.push("回撤状态 " + drawdownState + " → 不做扩张性调整");
  }
  if (drawdownState === "CAUTION") { target = Math.min(target, current + 3); reasons.push("回撤状态 CAUTION → 限制单次调整"); }
  target = Math.max(bounds.short_min_pct, Math.min(bounds.short_max_pct, target));
  // §1:按步长安全靠近(不用 accounting.rebalancePlan 的 30~70 旧边界,配置区间是 60~80)
  const plan = stepToward(current, target, { maxStepPct: i.maxStepPct, bounds });
  reasons.push("按风险调整后评分:Short " + s.score + " / Long " + l.score);
  return {
    short_pct: plan.short_pct,
    long_pct: plan.long_pct,
    target_short_pct: round(target, 2),
    changed: plan.changed,
    step_pct: plan.step_pct,
    basis: "risk_adjusted_performance",
    detail: { short: s, long: l },
    reasons,
    bounds
  };
}

// ---- §1/§71/§72:Allocation Manager(真正落账,且只动 available,绝不碰已占用保证金) ----
export function planMigration(input) {
  const i = input || {};
  const wallets = i.wallets || {};
  const positions = (i.positions || []).filter((p) => p.status === "OPEN" || p.status === "CLOSING");
  const bounds = { ...ALLOCATION_BOUNDS, ...(i.bounds || {}) };
  const account = i.account || {};
  const totalEquity = num(i.total_equity, num(account.total_equity, num(account.initial_balance, 0)));
  const currentShort = num(i.current_short_pct, 70);
  const target = Math.max(bounds.short_min_pct, Math.min(bounds.short_max_pct, num(i.target_short_pct, ALLOCATION_PROFILES.short_main.short_pct)));
  const step = stepToward(currentShort, target, { maxStepPct: num(i.maxStepPct, ALLOCATION_STEP_PCT), bounds });

  const shortWallet = wallets.short || {};
  const longWallet = wallets.long || {};
  const shortAvail = num(shortWallet.available_balance, 0);
  const longAvail = num(longWallet.available_balance, 0);
  const shortReserved = num(shortWallet.reserved_balance, 0);
  const longReserved = num(longWallet.reserved_balance, 0);

  // 目标金额基于总权益(含未实现),但实际能动用的只有 available
  const targetShortBalance = round(totalEquity * step.short_pct / 100, 8);
  const currentShortBalance = num(shortWallet.allocated_balance, shortAvail + shortReserved);
  let delta = round(targetShortBalance - currentShortBalance, 8);

  const reasons = [];
  if (!step.changed) reasons.push("已在目标附近(步长 " + step.step_pct + "),无需调整");
  // §72:不能抽走被 margin 占用的资金 —— 只能动 available
  if (delta > 0) {
    const movable = Math.max(0, longAvail);
    if (delta > movable) { reasons.push("Long 可用资金不足(需要 " + round(delta, 4) + ",可用 " + round(movable, 4) + ")→ 按可用上限执行"); delta = movable; }
  } else if (delta < 0) {
    const movable = Math.max(0, shortAvail);
    const need = Math.abs(delta);
    if (need > movable) { reasons.push("Short 可用资金不足(需要 " + round(need, 4) + ",可用 " + round(movable, 4) + ")→ 按可用上限执行"); delta = -movable; }
  }
  // 仓位上仍有保证金时,允许调整(因为只动 available),但明确记录
  if (shortReserved > 0 || longReserved > 0) reasons.push("存在占用保证金(短 " + round(shortReserved, 4) + " / 长 " + round(longReserved, 4) + "),仅调整可用部分");

  return {
    version: ALLOCATION_VERSION,
    current_short_pct: round(currentShort, 2),
    target_short_pct: round(target, 2),
    short_pct: step.short_pct,
    long_pct: step.long_pct,
    step_pct: step.step_pct,
    delta_short: delta,
    from_wallet: delta >= 0 ? "long" : "short",
    to_wallet: delta >= 0 ? "short" : "long",
    movable_amount: round(Math.abs(delta), 8),
    feasible: Math.abs(delta) > 1e-9,
    reserved_preserved: true,
    reasons,
    total_equity: round(totalEquity, 8)
  };
}

// 真正修改钱包分配(纯函数变换):只动 available_balance,reserved 原样保留
export function applyAllocation(wallets, plan, options) {
  const w = wallets || {};
  const p = plan || {};
  const opts = options || {};
  const amount = round(num(p.movable_amount, 0), 8);
  if (!(amount > 0) || !p.feasible) {
    return { ok: false, reason: !p.feasible ? "no_change" : "zero_amount", wallets: w, moved: 0 };
  }
  const fromKey = p.from_wallet;
  const toKey = p.to_wallet;
  const from = w[fromKey] || {};
  const to = w[toKey] || {};
  const fromAvail = num(from.available_balance, 0);
  if (fromAvail + 1e-9 < amount) {
    return { ok: false, reason: "insufficient_available", wallets: w, moved: 0, detail: { need: amount, available: fromAvail } };
  }
  const now = num(opts.now, Date.now());
  const next = {
    ...w,
    [fromKey]: {
      ...from,
      available_balance: round(fromAvail - amount, 8),
      allocated_balance: round(num(from.allocated_balance, fromAvail + num(from.reserved_balance, 0)) - amount, 8),
      updated_at: now
    },
    [toKey]: {
      ...to,
      available_balance: round(num(to.available_balance, 0) + amount, 8),
      allocated_balance: round(num(to.allocated_balance, num(to.available_balance, 0) + num(to.reserved_balance, 0)) + amount, 8),
      updated_at: now
    }
  };
  return {
    ok: true,
    wallets: next,
    moved: amount,
    from_wallet: fromKey,
    to_wallet: toKey,
    short_pct: num(p.short_pct, 50),
    reserved_preserved: true,
    record: {
      type: "allocation_rebalance",
      at: now,
      moved: amount,
      from: fromKey,
      to: toKey,
      short_pct: num(p.short_pct, 50),
      long_pct: num(p.long_pct, 50),
      reasons: p.reasons || []
    }
  };
}

// 把目标分配落到钱包上(§71:可真正执行 —— 给出可行性与可移动金额,不是 executable:false 的建议)
export function allocationPlan(input) {
  const i = input || {};
  const wallets = i.wallets || {};
  const account = i.account || {};
  const totalEquity = num(account.total_equity, num(account.initial_balance, 0));
  const decision = dynamicAllocation({
    current_short_pct: i.current_short_pct,
    shortStats: i.shortStats,
    longStats: i.longStats,
    drawdown: i.drawdown,
    bounds: i.bounds,
    maxStepPct: i.maxStepPct
  });
  const migration = planMigration({
    wallets,
    positions: i.positions,
    account,
    total_equity: totalEquity,
    current_short_pct: num(i.current_short_pct, 70),
    target_short_pct: num(decision.target_short_pct, decision.short_pct),
    maxStepPct: i.maxStepPct,
    bounds: i.bounds
  });
  return {
    ...decision,
    total_equity: round(totalEquity, 8),
    target: { short_pct: round(num(decision.target_short_pct, decision.short_pct), 2), long_pct: round(100 - num(decision.target_short_pct, decision.short_pct), 2) },
    migration,
    executable: migration.feasible,
    movable_amount: migration.movable_amount,
    reserved_preserved: migration.reserved_preserved,
    note: "计划含可执行金额;执行时只调整 available_balance,已占用保证金不动(§72)"
  };
}

// Allocation 调整入口(供引擎调用):计划 → 真正落账 → 返回新钱包与记录
// 既接受完整 allocationPlan(),也接受直接传入的 migration 计划
export function rebalanceWallets(input) {
  const i = input || {};
  const plan = i.plan || allocationPlan(i);
  const migration = plan.migration || plan;
  if (plan.executable === false || migration.feasible === false || !(num(migration.movable_amount, 0) > 0)) {
    return { ok: false, reason: "no_change", plan, wallets: i.wallets || {}, moved: 0 };
  }
  const applied = applyAllocation(i.wallets || {}, migration, { now: i.now });
  return { ...applied, plan };
}

// 分配对 Risk Budget 的影响(§60:动态分配要真的影响仓位,否则只是展示)
export function allocationRiskFactor(decision) {
  const d = decision || {};
  const shortPct = num(d.short_pct, 50);
  return {
    short_factor: round(shortPct / 50, 4),
    long_factor: round((100 - shortPct) / 50, 4),
    note: "池子分配越大,该池单笔风险预算按比例放大,但受 drawdown.actions.max_risk_per_trade_pct 上限约束"
  };
}

// 汇总给 UI(§60 的可读输出)
export function allocationView(input) {
  const i = input || {};
  const decision = i.decision || dynamicAllocation(i);
  const stats = i.stats || {};
  const line = (mode) => {
    const s = stats[mode] || {};
    return {
      mode,
      label: mode === "short" ? "短线" : "长线",
      allocated_pct: mode === "short" ? decision.short_pct : decision.long_pct,
      trades: num(s.trades, 0),
      win_rate_text: s.win_rate == null ? "--" : round(num(s.win_rate, 0), 1).toFixed(1) + "%",
      net_text: round(num(s.net_pnl, 0), 2).toFixed(2) + " USDT",
      drawdown_text: round(num(s.max_drawdown_pct, 0), 2).toFixed(2) + "%"
    };
  };
  return {
    short_pct: decision.short_pct,
    long_pct: decision.long_pct,
    changed: decision.changed,
    summary: "短线 " + decision.short_pct + "% / 长线 " + decision.long_pct + "%",
    rows: [line("short"), line("long")],
    reasons: decision.reasons || [],
    note: decision.note || ""
  };
}

export { summarizeTrades };
