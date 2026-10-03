// paper/equityAnalytics.js · Equity Analytics(净值曲线与绩效指标)
// 目的:首页只放"小型净值曲线",详细统计放到 模拟>统计:24h/7d/30d 净值、
//      净收益、最大回撤、回撤修复时间、盈亏比、手续费、强平次数。
// 说明:全部基于传入的曲线点与成交记录计算(不自己取数,避免第二套数据源)。
import { num, numOrNull, round, summarizeTrades } from "./accounting.js";

export const EQUITY_WINDOWS = [
  { key: "h24", label: "24 小时", ms: 24 * 3600000 },
  { key: "d7", label: "7 天", ms: 7 * 86400000 },
  { key: "d30", label: "30 天", ms: 30 * 86400000 }
];

// 曲线点:{ at, equity }(旧的 {t, v} 也兼容)
export function normalizePoints(points) {
  return (points || [])
    .map((p) => ({
      at: num(p && (p.at != null ? p.at : p.t), 0),
      equity: num(p && (p.equity != null ? p.equity : p.v), 0)
    }))
    .filter((p) => p.at > 0 && Number.isFinite(p.equity))
    .sort((a, b) => a.at - b.at);
}

export function equitySeries(points, options) {
  const o = options || {};
  const nowMs = num(o.now, Date.now());
  const list = normalizePoints(points).filter((p) => p.at >= nowMs - num(o.windowMs, 30 * 86400000));
  const start = list.length ? list[0].equity : num(o.fallback, 0);
  const end = list.length ? list[list.length - 1].equity : start;
  let peak = start;
  let maxDd = 0;
  for (const p of list) {
    peak = Math.max(peak, p.equity);
    const dd = peak > 0 ? (peak - p.equity) / peak * 100 : 0;
    maxDd = Math.max(maxDd, dd);
  }
  return {
    window_ms: num(o.windowMs, 30 * 86400000),
    points: list,
    point_count: list.length,
    first_equity: round(start, 8),
    last_equity: round(end, 8),
    net_return_pct: start > 0 ? round((end - start) / start * 100, 4) : 0,
    max_drawdown_pct: round(maxDd, 4),
    // 迷你曲线用:0..1 归一化(UI 直接画,不做第二次计算)
    spark: list.length >= 2 ? list.map((p) => p.equity) : [start, end]
  };
}

// 回撤修复时间:从峰值回撤到底部,再回到该峰值所用的毫秒(未修复返回 null)
export function recoveryTimeMs(points, options) {
  const list = normalizePoints(points);
  const o = options || {};
  const nowMs = num(o.now, Date.now());
  let peak = null;
  let peakAt = null;
  let trough = null;
  let troughAt = null;
  let answer = null;
  for (const p of list) {
    if (peak == null || p.equity > peak) {
      if (peak != null && trough != null && p.equity >= peak && troughAt != null) {
        answer = p.at - troughAt;
      }
      peak = p.equity;
      peakAt = p.at;
      trough = null;
      troughAt = null;
    } else if (trough == null || p.equity < trough) {
      trough = p.equity;
      troughAt = p.at;
    }
  }
  const ongoing = trough != null && troughAt != null && (answer == null);
  return {
    recovery_ms: answer,
    recovered: answer != null,
    ongoing,
    from_peak_at: peakAt,
    to_trough_at: troughAt,
    age_ms: ongoing && troughAt != null ? nowMs - troughAt : null
  };
}

// 绩效汇总:收益/费用/盈亏比/强平次数 + 多窗口
export function equityStats(input) {
  const i = input || {};
  const nowMs = num(i.now, Date.now());
  const points = normalizePoints(i.equity_curve);
  const trades = i.trades || [];
  const stats = summarizeTrades(trades);
  const grossWin = trades.filter((t) => num(t.net_pnl) > 0).reduce((a, t) => a + num(t.net_pnl), 0);
  const grossLoss = Math.abs(trades.filter((t) => num(t.net_pnl) < 0).reduce((a, t) => a + num(t.net_pnl), 0));
  const liquidations = trades.filter((t) => String(t.exit_reason || "").toUpperCase().includes("LIQUIDATION")).length;
  const windows = {};
  for (const w of EQUITY_WINDOWS) {
    const series = equitySeries(points, { now: nowMs, windowMs: w.ms, fallback: num(i.initial_equity, num(i.equity, 0)) });
    const windowTrades = trades.filter((t) => num(t.exit_time, 0) >= nowMs - w.ms);
    const s = summarizeTrades(windowTrades);
    windows[w.key] = {
      label: w.label,
      net_return_pct: series.net_return_pct,
      max_drawdown_pct: series.max_drawdown_pct,
      trades: s.trades,
      win_rate: s.win_rate,
      fees: s.fees,
      spark: series.spark,
      liquidations: windowTrades.filter((t) => String(t.exit_reason || "").toUpperCase().includes("LIQUIDATION")).length
    };
  }
  const recovery = recoveryTimeMs(points, { now: nowMs });
  return {
    net_return_pct: num(i.initial_equity, 0) > 0 ? round((num(i.equity, 0) - num(i.initial_equity, 0)) / num(i.initial_equity, 1) * 100, 4) : round(windows.d30.net_return_pct, 4),
    max_drawdown_pct: windows.d30.max_drawdown_pct,
    recovery_ms: recovery.recovery_ms,
    recovery_ongoing: recovery.ongoing,
    profit_factor: grossLoss > 0 ? round(grossWin / grossLoss, 4) : (grossWin > 0 ? null : 1),
    gross_win: round(grossWin, 8),
    gross_loss: round(grossLoss, 8),
    fees: round(stats.fees, 8),
    trades: stats.trades,
    win_rate: stats.win_rate,
    liquidations,
    avg_holding_ms: stats.avg_holding_ms,
    windows,
    // 首页迷你曲线:默认给 7 天
    spark: windows.d7.spark
  };
}

// 首页用的小卡片文案(一句话,不堆数字)
export function equityHeadline(stats) {
  const s = stats || {};
  const sign = num(s.net_return_pct, 0) >= 0 ? "+" : "";
  const dd = num(s.max_drawdown_pct, 0);
  const rec = s.recovery_ongoing ? "回撤修复中" : (s.recovery_ms != null ? "已修复" : "");
  return {
    headline: "净收益 " + sign + num(s.net_return_pct, 0).toFixed(2) + "%",
    sub: "最大回撤 " + dd.toFixed(2) + "%" + (rec ? " · " + rec : "") + " · 手续费 " + num(s.fees, 0).toFixed(2) + "U",
    tone: num(s.net_return_pct, 0) >= 0 ? "up" : "down"
  };
}
