// paper/capitalEfficiency.js · V16.2v §11/§12 · 资金效率(母仓级,纯函数,无 I/O)
// 为什么必须以【母仓】为结算单位:
//   一次 Partial 只赚 0.004U 不能说明这笔交易没意义 —— 必须看整个 Mother Position 的
//   累计净收益与占用保证金;"事件级金额"只用于归因,不用于评判机会价值。
// 规则(阈值可解释、可调,不做"必须赚 0.1U"的绝对硬编码):
//   return_on_margin_pct = 母仓净收益 / 占用保证金 × 100
//   fee_drag_ratio       = 全部费用 / 毛收益(>1 说明费用超过毛收益,实际在给手续费打工)
//   LOW_CAPITAL_EFFICIENCY:持仓 ≥1h 且净为正但 return_on_margin_pct < 0.1%(如 20U 持仓 2h 只赚 0.005U)
export const CAPITAL_EFFICIENCY_VERSION = "capital-efficiency-v1.0";
export const CAPITAL_EFFICIENCY_RULES = {
  low_return_on_margin_pct: 0.1,
  dust_profit_usdt: 0.02,
  min_hold_ms_for_efficiency: 3600000
};

function ceNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}
function ceRound(v, d) {
  const p = Math.pow(10, d == null ? 6 : d);
  return Math.round(ceNum(v) * p) / p;
}

// 取某个母仓的全部事件(partial + final),兼容两种关联字段
export function positionEventTrades(trades, positionId) {
  const id = String(positionId || "");
  if (!id) return [];
  return (trades || []).filter((t) => t && (String(t.position_id || "") === id || String(t.parent_position_id || "") === id));
}

// 母仓资金效率:position 提供建仓信息,events 提供全部平仓/减仓事件
export function capitalEfficiencyOf(position, events, opts) {
  const p = position || {};
  const o = opts || {};
  const rules = { ...CAPITAL_EFFICIENCY_RULES, ...(o.rules || {}) };
  const list = Array.isArray(events) ? events.filter(Boolean) : [];
  if (!list.length) {
    return {
      version: CAPITAL_EFFICIENCY_VERSION,
      position_id: p.position_id || null, symbol: p.symbol || null, mode: p.mode || null,
      closed: false, note_zh: "尚未平仓:暂无母仓级资金效率(部分减仓不计入最终结算)"
    };
  }
  const allocated_margin = ceRound(ceNum(p.initial_margin, ceNum(p.entry_notional, 0)), 6);
  let gross = 0, fees = 0, net = 0, slip = 0, slipKnown = false;
  let entryTime = ceNum(p.entry_time, null);
  let exitTime = 0;
  for (const t of list) {
    gross += ceNum(t.gross_pnl, 0);
    fees += ceNum(t.fees, 0);
    net += ceNum(t.net_pnl, 0);
    const sp = t.execution && t.execution.slippage_pct != null ? Number(t.execution.slippage_pct) : null;
    if (sp != null && Number.isFinite(sp)) {
      slipKnown = true;
      slip += Math.abs(ceNum(t.entry_notional_closed, ceNum(t.entry_notional, 0))) * Math.abs(sp) / 100;
    }
    const et = ceNum(t.entry_time, null);
    if (et != null && (entryTime == null || et < entryTime)) entryTime = et;
    exitTime = Math.max(exitTime, ceNum(t.exit_time, 0));
  }
  const funding = ceNum(p.funding_simulated, 0);
  const holdMs = entryTime != null && exitTime > entryTime ? (exitTime - entryTime) : 0;
  const holdHours = holdMs / 3600000;
  const maxMargin = Math.max(allocated_margin, ceNum(p.max_margin_used, 0));
  const returnOnMarginPct = allocated_margin > 0 ? ceRound(net / allocated_margin * 100, 4) : null;
  const feeDragRatio = gross > 1e-9 ? ceRound(fees / gross, 4) : (fees > 0 ? null : 0);
  const efficiencyPerMarginHour = allocated_margin > 0 && holdHours > 0 ? ceRound(net / (allocated_margin * holdHours) * 100, 4) : null;
  const holdEnough = holdMs >= ceNum(rules.min_hold_ms_for_efficiency, 3600000);
  const lowEfficiency = net > 0 && holdEnough && returnOnMarginPct != null && returnOnMarginPct < ceNum(rules.low_return_on_margin_pct, 0.1);
  const dustProfit = net > 0 && net < ceNum(rules.dust_profit_usdt, 0.02);
  const notes = [];
  if (lowEfficiency) notes.push("低资金效率:持仓 " + ceRound(holdHours, 2) + "h,净 " + ceRound(net, 4) + "U / 保证金 " + allocated_margin + "U(" + returnOnMarginPct + "%)");
  if (dustProfit) notes.push("尘埃级盈利(母仓净 < " + rules.dust_profit_usdt + "U):费用占比过高或机会本身没有价值");
  if (feeDragRatio != null && feeDragRatio >= 1) notes.push("费用超过毛收益:这一单实际上在给手续费打工");
  return {
    version: CAPITAL_EFFICIENCY_VERSION,
    position_id: p.position_id || null,
    symbol: p.symbol || null,
    mode: p.mode || null,
    closed: true,
    allocated_margin,
    max_margin_used: maxMargin,
    holding_ms: holdMs,
    holding_hours: ceRound(holdHours, 3),
    gross_pnl: ceRound(gross, 6),
    fee: ceRound(fees, 6),
    funding: ceRound(funding, 6),
    slippage_usdt: slipKnown ? ceRound(slip, 6) : null,
    net_pnl: ceRound(net, 6),
    return_on_margin_pct: returnOnMarginPct,
    capital_efficiency_per_margin_hour: efficiencyPerMarginHour,
    fee_drag_ratio: feeDragRatio,
    low_capital_efficiency: lowEfficiency,
    dust_profit: dustProfit,
    events: list.length,
    note_zh: notes.length ? notes.join(" · ") : "资金效率正常"
  };
}

// 中文视图(纸面统计用):聚合一批母仓效率
export function capitalEfficiencyView(list) {
  const rows = (list || []).filter((r) => r && r.closed === true);
  if (!rows.length) return { count: 0, low_count: 0, dust_count: 0, headline_zh: "暂无已结算母仓" };
  const lowCount = rows.filter((r) => r.low_capital_efficiency).length;
  const dustCount = rows.filter((r) => r.dust_profit).length;
  const totalNet = rows.reduce((a, r) => a + ceNum(r.net_pnl, 0), 0);
  const totalMargin = rows.reduce((a, r) => a + ceNum(r.allocated_margin, 0), 0);
  const avgReturn = totalMargin > 0 ? ceRound(totalNet / totalMargin * 100, 3) : null;
  return {
    version: CAPITAL_EFFICIENCY_VERSION,
    count: rows.length,
    low_count: lowCount,
    dust_count: dustCount,
    total_net_usdt: ceRound(totalNet, 4),
    avg_return_on_margin_pct: avgReturn,
    headline_zh: "母仓 " + rows.length + " 笔 · 均收益率 " + (avgReturn == null ? "--" : avgReturn + "%")
      + " · 低效 " + lowCount + " 笔 · 尘埃盈利 " + dustCount + " 笔"
  };
}
