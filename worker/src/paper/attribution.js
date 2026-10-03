// paper/attribution.js · Strategy Performance Attribution(PnL 归因)
// 目的:账户最后 +多少钱 是不够的 —— 必须知道"到底是什么在赚钱/亏钱"。
// 维度:策略(Short/Long) · 币种 · 市场 Regime · 杠杆档 · 模型版本 · 退出策略 · 周期。
// 原则:只对【有效样本】统计(排除 invalid_sample / 异常数据),口径与 accounting 一致。
import { num, round, summarizeTrades, summarizePositions } from "./accounting.js";

export const ATTRIBUTION_DIMENSIONS = [
  { key: "strategy", label: "策略", of: (t) => (t.mode === "long" ? "长线" : "短线") },
  { key: "symbol", label: "币种", of: (t) => String(t.symbol || "未知").replace("USDT", "") },
  { key: "regime", label: "市场状态", of: (t) => (t.market_regime ? String(t.market_regime) : "未标注") },
  { key: "leverage", label: "杠杆档", of: (t) => num(t.leverage, 1) + "x" },
  { key: "model", label: "模型版本", of: (t) => (t.model_version ? String(t.model_version) : "规则") },
  { key: "exit_policy", label: "退出策略", of: (t) => exitBucketOf(t.exit_reason) },
  { key: "interval", label: "周期", of: (t) => (t.mode === "long" ? "4h" : "1h") }
];

// 退出原因归桶(避免每个 reason 一个分组,统计不出来)
export function exitBucketOf(exitReason) {
  const r = String(exitReason || "manual").toUpperCase();
  if (r.includes("LIQUIDATION")) return "强平";
  if (r.includes("STOP_LOSS")) return "止损";
  if (r.includes("TAKE_PROFIT")) return "止盈";
  if (r.includes("PROFIT_LOCK")) return "利润保护";
  if (r.includes("MANUAL")) return "手动";
  if (r.includes("TIME")) return "时间退出";
  if (r.includes("REVERSAL") || r.includes("INVALIDATION")) return "结构/反转";
  return "其他";
}

export function isValidTrade(trade, options) {
  const o = options || {};
  const t = trade || {};
  if (t.invalid_sample === true && o.include_invalid !== true) return false;
  if (!Number.isFinite(Number(t.net_pnl))) return false;
  if (!(num(t.entry_price, 0) > 0) || !(num(t.exit_price, 0) > 0)) return false;
  return true;
}

// 单组统计(与 summarizeTrades 同口径,额外给出盈亏比与占比)
export function groupStats(trades, totalNet) {
  const list = trades || [];
  const s = summarizeTrades(list);
  const grossWin = list.filter((t) => num(t.net_pnl) > 0).reduce((a, t) => a + num(t.net_pnl), 0);
  const grossLoss = Math.abs(list.filter((t) => num(t.net_pnl) < 0).reduce((a, t) => a + num(t.net_pnl), 0));
  const liquidations = list.filter((t) => String(t.exit_reason || "").toUpperCase().includes("LIQUIDATION")).length;
  return {
    trades: s.trades,
    wins: s.wins,
    losses: s.losses,
    win_rate: s.win_rate,
    net_pnl: round(s.net_pnl, 8),
    gross_pnl: round(s.gross_pnl, 8),
    fees: round(s.fees, 8),
    avg_net_pnl: s.avg_net_pnl,
    avg_holding_ms: s.avg_holding_ms,
    max_consecutive_losses: s.max_consecutive_losses,
    liquidations,
    profit_factor: grossLoss > 0 ? round(grossWin / grossLoss, 4) : (grossWin > 0 ? null : 1),
    // 对账户净收益的贡献占比(分母为有效样本净额之和)
    share_pct: num(totalNet, 0) !== 0 ? round(s.net_pnl / num(totalNet, 1) * 100, 4) : null
  };
}

// 把"仓位级"聚合结果转成维度函数可用的行(维度口径不变,只是统计粒度变成完整仓位)
// options 透传给 summarizePositions:调用方已经自己筛过样本时(include_invalid)必须能关掉二次清洗,
// 否则"我要求保留的样本"会在聚合阶段被 cleanTrades 再剔一次 —— 等于选项失效。
export function positionsAsTrades(trades, options) {
  const agg = summarizePositions(trades, options);
  return agg.rows.map((r) => ({
    trade_id: r.position_id,
    position_id: r.position_id,
    parent_position_id: r.position_id,
    symbol: r.symbol,
    mode: r.mode,
    side: r.side,
    leverage: r.leverage,
    net_pnl: r.net_pnl,
    gross_pnl: r.gross_pnl,
    fees: r.fees,
    exit_reason: r.exit_reason,
    market_regime: r.market_regime,
    model_version: r.model_version,
    entry_time: r.entry_time,
    exit_time: r.exit_time,
    holding_ms: r.holding_ms,
    events: r.events,
    partial_events: r.partial_events,
    level: "position",
    // 仓位级行不需要价格(不是成交,是聚合),给合法占位避免被 isValidTrade 误杀
    entry_price: 1,
    exit_price: 1,
    quantity: 1
  }));
}

// 主入口:trades → 每个维度的归因表
// §19:默认按【完整 Position】统计(Partial Close 是仓位事件,不是独立母交易)
export function attributionOf(trades, options) {
  const o = options || {};
  const level = o.level === "trade" ? "trade" : "position";
  const raw = trades || [];
  // 先剔除异常样本,再做仓位聚合 —— 否则异常成交会被并进仓位净额(等于没过滤)
  const filtered = raw.filter((t) => isValidTrade(t, o));
  const source = level === "position" ? positionsAsTrades(filtered, { clean: o.include_invalid !== true }) : filtered;
  const valid = source;
  const totalNet = round(valid.reduce((a, t) => a + num(t.net_pnl), 0), 8);
  const dimensions = {};
  for (const dim of ATTRIBUTION_DIMENSIONS) {
    const buckets = new Map();
    for (const t of valid) {
      const k = String(dim.of(t));
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(t);
    }
    const rows = [...buckets.entries()]
      .map(([key, list]) => ({ key, label: key, ...groupStats(list, totalNet) }))
      .sort((a, b) => num(b.net_pnl) - num(a.net_pnl));
    dimensions[dim.key] = { key: dim.key, label: dim.label, rows, best: rows[0] || null, worst: rows.length > 1 ? rows[rows.length - 1] : null };
  }
  const excluded = raw.length - valid.length;
  return {
    level,
    sample: {
      total: raw.length,
      valid: valid.length,
      excluded,
      events: level === "position" ? raw.length : null,
      level_label: level === "position" ? "按完整仓位统计" : "按单笔成交统计",
      excluded_reason: "invalid_sample / 非有限盈亏 / 非法价格"
    },
    net_pnl: totalNet,
    fees: round(valid.reduce((a, t) => a + num(t.fees), 0), 8),
    dimensions,
    // 一句话结论:谁在赚、谁在亏(UI 首屏用)
    headline: headlineOf(dimensions, totalNet)
  };
}

export function headlineOf(dimensions, totalNet) {
  const pick = (dimKey) => {
    const d = dimensions[dimKey];
    if (!d || !d.rows.length) return null;
    const best = d.rows[0];
    const worst = d.rows[d.rows.length - 1];
    return { dim: d.label, best, worst };
  };
  const strategy = pick("strategy");
  const symbol = pick("symbol");
  const exit = pick("exit_policy");
  const parts = [];
  if (strategy && strategy.best) parts.push(strategy.best.key + "贡献 " + (num(strategy.best.net_pnl) >= 0 ? "+" : "") + num(strategy.best.net_pnl).toFixed(2) + "U");
  if (symbol && symbol.best && num(symbol.best.net_pnl) > 0) parts.push("最好 " + symbol.best.key + " +" + num(symbol.best.net_pnl).toFixed(2) + "U");
  if (symbol && symbol.worst && num(symbol.worst.net_pnl) < 0 && symbol.worst.key !== (symbol.best && symbol.best.key)) parts.push("最差 " + symbol.worst.key + " " + num(symbol.worst.net_pnl).toFixed(2) + "U");
  if (exit && exit.worst && num(exit.worst.net_pnl) < 0) parts.push("主要亏损来自 " + exit.worst.key);
  return {
    text: parts.length ? parts.join(" · ") : (validCountText(totalNet)),
    tone: num(totalNet, 0) >= 0 ? "up" : "down"
  };
}

function validCountText(totalNet) {
  return num(totalNet, 0) === 0 ? "样本不足,尚无可归因的盈亏" : "净额 " + num(totalNet).toFixed(2) + "U";
}

// UI 视图:每个维度给"前 N 名",避免一次渲染一大堆
export function attributionView(attribution, options) {
  const o = options || {};
  const limit = num(o.limit, 5);
  const a = attribution || {};
  const dims = a.dimensions || {};
  return {
    headline: a.headline ? a.headline.text : "",
    tone: a.headline ? a.headline.tone : "up",
    net_pnl: num(a.net_pnl, 0),
    sample_text: "有效样本 " + num(a.sample && a.sample.valid, 0) + " 笔(" + (a.sample && a.sample.level_label ? a.sample.level_label : "按完整仓位统计") + ")"
      + (num(a.sample && a.sample.excluded, 0) > 0 ? ",排除 " + num(a.sample.excluded, 0) + " 笔异常" : ""),
    sections: ATTRIBUTION_DIMENSIONS
      .filter((d) => dims[d.key] && dims[d.key].rows.length)
      .map((d) => ({
        key: d.key,
        label: d.label,
        rows: dims[d.key].rows.slice(0, limit).map((r) => ({
          key: r.key,
          net_text: (num(r.net_pnl) >= 0 ? "+" : "") + num(r.net_pnl).toFixed(2) + "U",
          trades: r.trades,
          win_rate_text: r.win_rate == null ? "--" : num(r.win_rate).toFixed(0) + "%",
          tone: num(r.net_pnl) >= 0 ? "up" : "down"
        }))
      }))
  };
}
