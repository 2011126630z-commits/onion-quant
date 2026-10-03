// paper/leverageManager.js · AUTO LEVERAGE(纯函数 + 注入存储)
// 原则(严格遵守):
//   - 资金少 ≠ 用最高杠杆;account_size 只是输入之一
//   - AUTO 提出 requested_leverage → Risk Engine 给 approved_leverage → 实际开仓用 approved
//   - 高杠杆需要更严格样本门槛;禁止 1x→10x 跳跃(Step Policy)
//   - Short / Long 独立学习;样本不足按 symbol+mode+regime → mode+regime → mode → global 回退
//   - 评分不能只看 PnL(要含回撤/强平率/止损率/胜率/稳定性/样本量)
//   - Shadow 结果只用于学习,绝不重复计入账户 PnL
import { num, round } from "./accounting.js";
import { LEVERAGE_STEPS, clampLeverage, liquidationPriceOf, MAINTENANCE_MARGIN_RATE } from "./futures.js";

export const LEVERAGE_POLICY = {
  version: "auto-leverage-v0.1",
  // 高杠杆样本门槛更严格
  min_samples: { 1: 20, 2: 20, 3: 25, 4: 30, 5: 35, 6: 50, 7: 60, 8: 70, 9: 80, 10: 90 },
  small_account_threshold: 500,        // 小账户阈值(USDT)
  small_account_candidates: [3, 4, 5], // 小账户优先探索的中杠杆
  normal_candidates: [1, 2, 3, 4],
  max_step_up: 1,                      // 单次最多提升 1 档
  max_leverage_hard_cap: 10,
  risk_cap_by_score: [[35, 10], [50, 6], [65, 4], [80, 2], [101, 1]], // 风险分 → 允许的最高杠杆
  max_liquidation_risk_pct: 3,         // 强平距离低于该值禁止加杠杆
  min_profit_factor: 1.05
};

// 风险分 → 杠杆上限(Risk 的硬约束)
export function leverageCapFromRisk(riskScore, policy) {
  const p = { ...LEVERAGE_POLICY, ...(policy || {}) };
  const score = num(riskScore, 50);
  for (const [limit, cap] of p.risk_cap_by_score) {
    if (score < limit) return cap;
  }
  return 1;
}

// 账户规模档位
export function accountProfile(balance, policy) {
  const p = { ...LEVERAGE_POLICY, ...(policy || {}) };
  const size = num(balance, 0);
  const small = size < p.small_account_threshold;
  return {
    balance: size,
    class: small ? "SMALL" : "NORMAL",
    exploration: small,
    candidates: small ? p.small_account_candidates.slice() : p.normal_candidates.slice(),
    note: small ? "小账户探索模式:优先测试中杠杆候选(3x~5x)" : "常规模式:先测试低杠杆候选"
  };
}

// 候选生成:Champion 附近 ±1 档(禁止跳跃) + 探索候选(受硬上限约束)
export function leverageCandidates(input) {
  const p = { ...LEVERAGE_POLICY, ...(input.policy || {}) };
  const champion = clampLeverage(num(input.champion_leverage, 2));
  const profile = accountProfile(input.balance, p);
  const hardCap = Math.min(p.max_leverage_hard_cap, clampLeverage(num(input.hard_cap, p.max_leverage_hard_cap)));
  const set = new Set();
  set.add(champion);
  set.add(clampLeverage(champion + p.max_step_up));
  set.add(clampLeverage(champion - p.max_step_up));
  for (const c of profile.candidates) set.add(c);
  return [...set].filter((l) => l >= 1 && l <= hardCap).sort((a, b) => a - b);
}

// 多因子评分(不只 PnL)
export function leverageScore(stats, policy) {
  const p = { ...LEVERAGE_POLICY, ...(policy || {}) };
  const s = stats || {};
  const samples = num(s.samples, 0);
  const minSamples = p.min_samples[clampLeverage(s.leverage)] || 20;
  const winRate = num(s.win_rate, 0) / 100;
  const netPnl = num(s.net_pnl, 0);
  const profitFactor = num(s.profit_factor, s.gross_profit && s.gross_loss ? s.gross_profit / Math.abs(s.gross_loss) : 1);
  const drawdown = num(s.max_drawdown_pct, 0);
  const liqRate = num(s.liquidation_rate, 0);
  const stopRate = num(s.stop_rate, 0);
  const stability = num(s.recent_stability, 1); // 0~1
  const mfe = num(s.avg_mfe, 0);
  const mae = num(s.avg_mae, 0);
  const sampleFactor = samples >= minSamples ? 1 : samples / Math.max(1, minSamples);
  const robust = Math.max(0, 1 - drawdown / 25) * Math.max(0, 1 - liqRate * 8) * Math.max(0, 1 - stopRate * 1.5);
  const edge = (winRate - 0.5) * 2;
  const pnlFactor = Math.tanh(netPnl / 5);
  const quality = Math.tanh((mfe - mae) / Math.max(0.0001, mfe + mae));
  const score = (edge * 1.2 + pnlFactor * 1.0 + quality * 0.6 + (profitFactor - 1) * 1.5) * robust * stability * sampleFactor;
  return {
    leverage: clampLeverage(s.leverage),
    score: round(score, 4),
    eligible: samples >= minSamples && profitFactor >= p.min_profit_factor,
    sample_factor: round(sampleFactor, 4),
    robust_factor: round(robust, 4),
    min_samples: minSamples,
    samples
  };
}

// 分层统计查询(注入 records)
export function leverageStatsFor(records, key, filters) {
  const f = filters || {};
  const list = (records || []).filter((r) => {
    if (f.symbol && r.symbol !== f.symbol) return false;
    if (f.mode && r.mode !== f.mode) return false;
    if (f.regime && r.market_regime !== f.regime) return false;
    return true;
  });
  const byLev = {};
  for (const leverage of LEVERAGE_STEPS) {
    const rows = list.filter((r) => num(r.leverage, 0) === leverage && r.shadow !== true);
    if (!rows.length) continue;
    const wins = rows.filter((r) => num(r.net_pnl) > 0);
    const losses = rows.filter((r) => num(r.net_pnl) < 0);
    const grossProfit = wins.reduce((a, b) => a + num(b.net_pnl), 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + num(b.net_pnl), 0));
    byLev[leverage] = {
      leverage,
      samples: rows.length,
      win_rate: rows.length ? round(wins.length / rows.length * 100, 2) : 0,
      net_pnl: round(rows.reduce((a, b) => a + num(b.net_pnl), 0), 6),
      gross_profit: round(grossProfit, 6),
      gross_loss: round(grossLoss, 6),
      profit_factor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : (grossProfit > 0 ? 99 : 1),
      avg_mfe: round(rows.reduce((a, b) => a + num(b.mfe), 0) / rows.length, 6),
      avg_mae: round(rows.reduce((a, b) => a + num(b.mae), 0) / rows.length, 6),
      max_drawdown_pct: round(Math.max(...rows.map((r) => num(r.drawdown_pct, 0))), 4),
      liquidation_rate: round(rows.filter((r) => r.exit_reason === "LIQUIDATION").length / rows.length, 4),
      stop_rate: round(rows.filter((r) => r.exit_reason === "stop_loss").length / rows.length, 4),
      recent_stability: round(rows.slice(-10).filter((r) => num(r.net_pnl) > 0).length / Math.max(1, Math.min(10, rows.length)), 3)
    };
  }
  return byLev;
}

// 分层回退:symbol+mode+regime → mode+regime → mode → global
export function resolveLeverageTable(input) {
  const records = input.records || [];
  const minSamples = num(input.min_samples, 25);
  const attempts = [
    { key: "symbol+mode+regime", filters: { symbol: input.symbol, mode: input.mode, regime: input.regime } },
    { key: "mode+regime", filters: { mode: input.mode, regime: input.regime } },
    { key: "mode", filters: { mode: input.mode } },
    { key: "global", filters: {} }
  ];
  for (const attempt of attempts) {
    const table = leverageStatsFor(records, attempt.key, attempt.filters);
    const total = Object.values(table).reduce((a, b) => a + num(b.samples), 0);
    if (total >= minSamples) return { scope: attempt.key, table, total_samples: total, fallback_used: attempt.key !== "global" && attempt.key !== "symbol+mode+regime" };
  }
  return { scope: "none", table: {}, total_samples: 0, fallback_used: true };
}

// 选择 requested_leverage(不含 Risk 审批)
export function requestLeverage(input) {
  const p = { ...LEVERAGE_POLICY, ...(input.policy || {}) };
  const resolved = input.table ? { scope: input.scope || "provided", table: input.table } : resolveLeverageTable(input);
  const champion = clampLeverage(num(input.champion_leverage, 2));
  const profile = accountProfile(input.balance, p);
  const candidates = leverageCandidates({ champion_leverage: champion, balance: input.balance, hard_cap: input.hard_cap, policy: p });
  const scored = candidates.map((leverage) => {
    const stats = resolved.table[leverage] || { leverage, samples: 0 };
    const score = leverageScore(stats, p);
    const explorationBoost = profile.exploration && p.small_account_candidates.includes(leverage) ? 0.15 : 0;
    return { ...score, explore_boost: explorationBoost, total: round(score.score + explorationBoost, 4) };
  });
  const eligible = scored.filter((s) => s.eligible);
  if (!eligible.length) {
    // 样本不足:不升杠杆,保持 Champion 或退回 1x 观察
    return { requested_leverage: champion, reason: "样本不足,保持 Champion " + champion + "x(高杠杆需更多样本)", scope: resolved.scope, candidates: scored, sample_protected: true };
  }
  eligible.sort((a, b) => b.total - a.total);
  const best = eligible[0];
  if (best.leverage > champion + p.max_step_up) {
    return { requested_leverage: champion + p.max_step_up, reason: "Step Policy:单次最多升 1 档(Champion " + champion + "x)", scope: resolved.scope, candidates: scored, stepped: true };
  }
  return {
    requested_leverage: best.leverage,
    reason: "多因子评分最优(score " + best.score + (best.explore_boost ? " + 探索加成" : "") + ",scope " + resolved.scope + ")",
    scope: resolved.scope,
    candidates: scored,
    sample_protected: false
  };
}

// Risk 审批:只能是 requested 的下调或否决
export function approveLeverage(input) {
  const p = { ...LEVERAGE_POLICY, ...(input.policy || {}) };
  const requested = clampLeverage(input.requested_leverage);
  const riskCap = leverageCapFromRisk(input.risk_score, p);
  const reasons = [];
  let approved = Math.min(requested, riskCap);
  if (riskCap < requested) reasons.push("Risk 上限 " + riskCap + "x(风险分 " + num(input.risk_score) + ")");
  const liqDistance = input.liquidation_distance_pct == null ? null : num(input.liquidation_distance_pct);
  if (liqDistance != null && liqDistance < p.max_liquidation_risk_pct) {
    approved = Math.min(approved, 1);
    reasons.push("强平距离过近(<" + p.max_liquidation_risk_pct + "%),降至 1x");
  }
  if (input.veto || input.risk_veto) {
    return { approved_leverage: 1, trade_allowed: false, reasons: reasons.concat(["Risk 否决:不开仓"]), requested_leverage: requested, risk_cap: riskCap };
  }
  if (approved < 1) approved = 1;
  return {
    approved_leverage: approved,
    trade_allowed: approved >= 1,
    downgraded: approved < requested,
    requested_leverage: requested,
    risk_cap: riskCap,
    reasons: reasons.length ? reasons : ["Risk 通过"]
  };
}

// Shadow 模拟:同一笔信号在 1..10x 下的假想结果(仅用于学习,不入账)
export function shadowEvaluation(input) {
  const entry = num(input.entry_price, 0);
  const exit = num(input.exit_price, 0);
  const margin = num(input.margin, 0);
  const direction = input.direction === "LONG" ? "LONG" : "SHORT";
  const feeRate = num(input.fee_bps, 4) / 10000;
  const high = num(input.high, Math.max(entry, exit));
  const low = num(input.low, Math.min(entry, exit));
  if (!(entry > 0) || !(margin > 0)) return [];
  return LEVERAGE_STEPS.map((leverage) => {
    const notional = margin * leverage;
    const quantity = notional / entry;
    const gross = direction === "LONG" ? (exit - entry) * quantity : (entry - exit) * quantity;
    const fees = notional * feeRate * 2;
    const net = gross - fees;
    const favorable = direction === "LONG" ? (high - entry) * quantity : (entry - low) * quantity;
    const adverse = direction === "LONG" ? (entry - low) * quantity : (high - entry) * quantity;
    // 强平价只允许有一个实现:统一走 futures.liquidationPriceOf(避免两套公式漂移)
    const liqPrice = liquidationPriceOf({ side: direction, entryPrice: entry, leverage, maintenanceRate: MAINTENANCE_MARGIN_RATE });
    const liquidated = liqPrice == null ? false : (direction === "LONG" ? low <= liqPrice : high >= liqPrice);
    return {
      leverage,
      shadow: true,
      notional: round(notional, 8),
      gross_pnl: round(gross, 8),
      fees: round(fees, 8),
      net_pnl: round(liquidated ? -margin : net, 8),
      mfe: round(favorable, 8),
      mae: round(adverse, 8),
      liquidation_price: round(liqPrice, 8),
      liquidated
    };
  });
}

// 杠杆 Champion / Challenger:晋级需多条件且高杠杆样本更严格
export function evaluateLeveragePromotion(challenger, champion, policy) {
  const p = { ...LEVERAGE_POLICY, ...(policy || {}) };
  const c = challenger || {};
  const ch = champion || {};
  const reasons = [];
  const level = clampLeverage(c.leverage);
  const minSamples = p.min_samples[level] || 20;
  if (num(c.samples, 0) < minSamples) reasons.push("样本不足(" + num(c.samples, 0) + " < " + minSamples + ")");
  if (num(c.score, 0) <= num(ch.score, 0)) reasons.push("评分未超过 Champion(" + num(c.score, 0) + " ≤ " + num(ch.score, 0) + ")");
  if (num(c.max_drawdown_pct, 0) > num(ch.max_drawdown_pct, 0) + 5) reasons.push("回撤明显增加");
  if (num(c.liquidation_rate, 0) > 0.02) reasons.push("强平率过高(" + c.liquidation_rate + ")");
  if (num(c.profit_factor, 1) < p.min_profit_factor) reasons.push("Profit Factor 偏低");
  if (level > clampLeverage(ch.leverage || 1) + p.max_step_up) reasons.push("跨档过大(Step Policy)");
  return {
    promote: reasons.length === 0,
    verdict: reasons.length === 0 ? "PROMOTE" : "KEEP_TESTING",
    reasons: reasons.length ? reasons : ["各因子均通过,允许晋级"],
    from: ch.leverage || null,
    to: level,
    policy_version: p.version
  };
}

// 回滚:上线后表现明显变差
export function evaluateLeverageRollback(live, previous, policy) {
  const p = { ...LEVERAGE_POLICY, ...(policy || {}) };
  const l = live || {};
  if (num(l.samples, 0) < 15) return { rollback: false, reason: "样本不足,继续观察" };
  if (num(l.score, 0) < num(previous && previous.score, 0) - 0.4) return { rollback: true, reason: "评分显著下降" };
  if (num(l.liquidation_rate, 0) > 0.05) return { rollback: true, reason: "强平率过高" };
  if (num(l.max_drawdown_pct, 0) > num(previous && previous.max_drawdown_pct, 0) * 1.8) return { rollback: true, reason: "回撤显著放大" };
  return { rollback: false, reason: "表现稳定" };
}

// 学习样本 → 杠杆统计记录(mode 内部为 SHORT_TERM/LONG_TERM)
export function sampleToLeverageRecord(sample) {
  return {
    symbol: sample.symbol,
    mode: sample.mode,
    market_regime: sample.market_regime,
    leverage: num(sample.leverage, 1),
    net_pnl: num(sample.net_pnl, 0),
    mfe: num(sample.mfe, 0),
    mae: num(sample.mae, 0),
    exit_reason: sample.exit_reason || null,
    drawdown_pct: num(sample.drawdown_pct, 0),
    shadow: Boolean(sample.shadow)
  };
}
