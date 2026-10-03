// paper/risk.js · Risk Engine(V14:拥有否决权)
// 全部本地计算,0 Token。返回 { risk_score, risk_flags, veto, reasons }
import { num, round, isSafeAmount } from "./accounting.js";

export const RISK_LIMITS = {
  max_positions_per_mode: 3,
  max_positions_total: 5,
  max_symbol_exposure_pct: 35,
  max_mode_exposure_pct: 80,
  consecutive_loss_cooldown: 3,
  cooldown_ms: 6 * 3600000,
  min_balance_ratio: 0.1,
  extreme_volatility_pct: 6,
  max_daily_loss_pct: 8
};

export function evaluateRisk(input) {
  const ctx = input || {};
  const limits = { ...RISK_LIMITS, ...(ctx.limits || {}) };
  const flags = [];
  const reasons = [];
  let score = 20;

  const account = ctx.account || {};
  const wallets = ctx.wallets || {};
  const positions = (ctx.positions || []).filter((p) => p.status === "OPEN");
  const trades = ctx.trades || [];
  const quote = ctx.quote || {};
  const analysis = ctx.analysis || {};
  const mode = ctx.mode || "short";

  // 行情新鲜度 / 合法性
  if (!isSafeAmount(quote.price)) { flags.push("invalid_price"); reasons.push("价格非法"); score += 50; }
  if (quote.received_at && ctx.now && num(ctx.now) - num(quote.received_at) > 5 * 60000) { flags.push("stale_quote"); reasons.push("行情过期"); score += 30; }
  if (quote.provider_error) { flags.push("provider_error"); reasons.push("行情源异常"); score += 25; }

  // 余额
  const wallet = wallets[mode] || {};
  const equity = num(wallet.allocated_balance);
  const available = num(wallet.available_balance);
  if (equity <= 0 || available / Math.max(equity, 1e-9) < limits.min_balance_ratio) { flags.push("low_balance"); reasons.push("可用资金过低"); score += 20; }

  // 持仓数量与暴露
  const modeCount = positions.filter((p) => p.mode === mode).length;
  if (modeCount >= limits.max_positions_per_mode) { flags.push("too_many_positions_mode"); reasons.push("该策略持仓已达上限"); score += 15; }
  if (positions.length >= limits.max_positions_total) { flags.push("too_many_positions_total"); reasons.push("总持仓已达上限"); score += 15; }
  const symbolExposure = positions.filter((p) => p.symbol === ctx.symbol).reduce((a, b) => a + num(b.entry_notional), 0);
  const symbolPct = equity > 0 ? symbolExposure / equity * 100 : 100;
  if (symbolPct >= limits.max_symbol_exposure_pct) { flags.push("symbol_exposure"); reasons.push("单币暴露过高"); score += 15; }
  const reserved = num(wallet.reserved_balance);
  if (equity > 0 && reserved / equity * 100 >= limits.max_mode_exposure_pct) { flags.push("mode_exposure"); reasons.push("该策略资金占用过高"); score += 10; }

  // 连续亏损冷却
  let consecutive = 0;
  for (const t of trades.slice().sort((a, b) => num(a.exit_time) - num(b.exit_time))) {
    if (num(t.net_pnl) < 0) consecutive += 1; else consecutive = 0;
  }
  const lastTrade = trades.length ? trades[trades.length - 1] : null;
  if (consecutive >= limits.consecutive_loss_cooldown) {
    flags.push("loss_cooldown");
    reasons.push("连续亏损冷却中");
    score += 20;
  }
  if (lastTrade && num(lastTrade.net_pnl) < 0 && ctx.now && num(ctx.now) - num(lastTrade.exit_time) < limits.cooldown_ms && consecutive >= 2) {
    flags.push("recent_loss");
    score += 8;
  }

  // 当日亏损
  const todayNet = trades.filter((t) => ctx.todayKey && String(t.exit_time) >= String(ctx.todayStart || "")).reduce((a, b) => a + num(b.net_pnl), 0);
  const dailyLossPct = num(account.initial_balance) > 0 ? -todayNet / num(account.initial_balance) * 100 : 0;
  if (dailyLossPct >= limits.max_daily_loss_pct) { flags.push("daily_loss_limit"); reasons.push("当日亏损达到上限"); score += 25; }

  // 波动率/异常/多周期冲突
  const atrPct = num(analysis.volatility && analysis.volatility.atrPct, 0);
  if (atrPct >= limits.extreme_volatility_pct) { flags.push("extreme_volatility"); reasons.push("波动率极端"); score += 15; }
  else if (num(analysis.volatility && analysis.volatility.ratio, 1) >= 1.6) { flags.push("volatility_expansion"); score += 8; }
  if (analysis.anomaly && analysis.anomaly.detected) { flags.push("anomaly"); reasons.push("异常行情"); score += 12; }
  if (analysis.tf_conflict) { flags.push("tf_conflict"); reasons.push("多周期冲突"); score += 10; }
  if (analysis.btc_context && analysis.btc_context.state === "BTC Rapid Selloff") { flags.push("btc_selloff"); reasons.push("BTC 快速下跌"); score += 12; }
  if (analysis.limited_data) { flags.push("limited_data"); reasons.push("数据不足"); score += 15; }
  if (ctx.provider_ok === false) { flags.push("provider_down"); reasons.push("行情源不可用"); score += 25; }

  const riskScore = Math.max(0, Math.min(100, Math.round(score)));
  const vetoFlags = new Set(["invalid_price", "stale_quote", "provider_error", "provider_down", "too_many_positions_mode", "too_many_positions_total", "symbol_exposure", "loss_cooldown", "low_balance", "daily_loss_limit", "limited_data"]);
  const veto = flags.some((f) => vetoFlags.has(f));
  return {
    risk_score: riskScore,
    risk_level: riskScore < 30 ? "Low" : riskScore < 55 ? "Medium" : riskScore < 75 ? "High" : "Extreme",
    risk_flags: flags,
    veto,
    reasons,
    limits
  };
}
