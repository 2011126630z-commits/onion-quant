// ui/viewModels.js · 页面视图模型(纯函数:页面只负责把结果画出来)
// 数据一律来自真实 Paper Engine / Accounting / 分析结果,禁止任何 Demo 数字。
import { num, round, summarizeTrades, dayKeyOf, unrealizedPnl } from "../paper/accounting.js";
import { MODE_CONFIG } from "../paper/engine.js";
import { poolLayers } from "../paper/profitAllocation.js";

const RISK_ZH = { Low: "低", Medium: "中", High: "高", Extreme: "极高" };
// 注意:命名带 _UI 后缀,避免与引擎 constants.js 的 DIR_ZH 在扁平 bundle 中重名冲突
const DIR_ZH_UI = { "Strong Bullish": "强看涨", Bullish: "看涨", Neutral: "震荡", Bearish: "看跌", "Strong Bearish": "强看跌" };

export function fmtUsdt(v, digits) {
  const n = num(v, 0);
  const d = digits === undefined ? 2 : digits;
  const sign = n > 0 ? "+" : "";
  return sign + n.toFixed(d) + " USDT";
}

// §57:动态精度 —— 关键要求是"不能出现红色却显示 0.00"
//   |v| >= 0.01 → 2 位(保持既有展示口径);2 位会四舍五入成 0.00 时 → 4 位
export function usdtDigits(v) {
  const n = Math.abs(num(v, 0));
  if (n === 0) return 2;
  if (n.toFixed(2) === "0.00") return 4;
  return 2;
}

export function fmtUsdtExact(v) {
  const n = num(v, 0);
  return (n > 0 ? "+" : "") + n.toFixed(usdtDigits(n)) + " USDT";
}

// §55/§56:盈亏标签只由真实数值决定(禁止因为方向/风险/价格颜色而染红)
export function pnlLabel(v) {
  const n = num(v, 0);
  if (n > 0) return "浮盈";
  if (n < 0) return "浮亏";
  return "浮动盈亏";
}

export function pnlClass(v) {
  const n = num(v, 0);
  return n > 0 ? "green" : n < 0 ? "red" : "gray";
}

export function fmtPct(v, digits) {
  const n = num(v, 0);
  return (n > 0 ? "+" : "") + n.toFixed(digits === undefined ? 2 : digits) + "%";
}

// §54:持仓展示的统一字段集(paperViewModel 与 detailViewModel 共用,避免两处口径漂移)
export function positionView(p, options) {
  const i = options || {};
  const entry = num(p.entry_price);
  const current = num(p.current_price, entry);
  const qty = num(p.quantity);
  const initialQty = num(p.initial_quantity, qty);
  const remainingQty = num(p.remaining_quantity, qty);
  const margin = num(p.entry_notional, 0);
  const remainingMargin = p.remaining_margin == null ? margin : num(p.remaining_margin);
  const leverage = num(p.leverage, 1);
  const notional = num(p.notional, num(p.entry_notional, 0) * leverage);
  // 剩余仓位价值 = 剩余保证金 × 杠杆(§59 的公式本身):与展示的保证金自洽,且不随价格漂移
  const remainingNotional = remainingQty > 0 ? round(remainingMargin * leverage, 8) : 0;
  const unrealized = num(p.unrealized_pnl);
  const realized = num(p.realized_pnl);
  const closedFraction = initialQty > 0 ? round(1 - remainingQty / initialQty, 6) : 0;
  // §19 数据异常:价格不可信时 UI 不给"巨大的红色负数",改为提示正在重新校验
  const priceStatus = String(p.price_status || (current > 0 ? "OK" : "INVALID"));
  const dataError = priceStatus === "INVALID" || priceStatus === "STALE";
  // §7 两个口径分开:ROE(对剩余保证金)与 价格变动(对标的)
  // 数值字段保留 4 位精度,展示交给 fmtPct 统一格式化(避免二次舍入产生 0.01 的假差异)
  const roeRaw = remainingMargin > 0 ? unrealized / remainingMargin * 100 : num(p.roe_pct, 0);
  const roePct = round(roeRaw, 4);
  const priceMove = p.price_move_pct == null
    ? (entry > 0 ? round(((p.side === "LONG" ? current - entry : entry - current) / entry) * 100, 4) : 0)
    : num(p.price_move_pct);
  return {
    id: p.position_id,
    symbol: p.symbol,
    display: String(p.symbol || "").replace("USDT", "/USDT"),
    mode: p.mode,
    mode_label: MODE_CONFIG[p.mode] ? MODE_CONFIG[p.mode].label : p.mode,
    strategy_mode: p.strategy_mode || (p.mode === "long" ? "LONG_TERM" : "SHORT_TERM"),
    direction: p.side === "LONG" ? "LONG" : "SHORT",
    side: p.side === "LONG" ? "做多" : "做空",
    // 杠杆三态(§60:UI 显示 AUTO/MANUAL · Nx)
    requested_leverage: num(p.requested_leverage, leverage),
    approved_leverage: num(p.approved_leverage, leverage),
    actual_leverage: num(p.actual_leverage, leverage),
    leverage,
    leverage_text: (num(p.requested_leverage, 0) > 0 && num(p.approved_leverage, leverage) !== num(p.requested_leverage, leverage) ? "AUTO" : num(p.requested_leverage) > 0 ? "AUTO" : "MANUAL") + " · " + leverage + "x",
    // 资金口径(§58/§59:保证金与仓位价值严格分开;部分平仓后展示【剩余】口径,保证 价值 = 保证金 × 杠杆 自洽)
    margin,
    margin_text: margin.toFixed(2) + " USDT",
    remaining_margin: remainingMargin,
    notional: round(notional, 8),
    initial_notional: round(notional, 8),
    initial_notional_text: round(notional, 8).toFixed(2) + " USDT",
    notional_text: round(remainingNotional > 0 ? remainingNotional : notional, 8).toFixed(2) + " USDT",
    remaining_notional: round(remainingNotional, 8),
    remaining_notional_text: round(remainingNotional, 8).toFixed(2) + " USDT",
    // 价格
    entry_price: entry,
    avg_entry_price: num(p.avg_entry_price, entry),
    current_price: current,
    mark_price: p.mark_price == null ? null : num(p.mark_price),
    entry: entry,
    current,
    liquidation_price: p.liquidation_price == null ? null : num(p.liquidation_price),
    liquidation_text: p.liquidation_price == null || num(p.liquidation_price) <= 0 ? "--" : num(p.liquidation_price).toFixed(2),
    // 盈亏(严格区分已实现 / 未实现 §64)
    unrealized_pnl: unrealized,
    pnl: unrealized,
    // §19:行情异常时不显示一个巨大负数,改为明确状态文案,并给出 data_error 供 UI 标红
    pnl_text: dataError ? "行情异常,正在重新校验" : fmtUsdtExact(unrealized),
    pnl_label: dataError ? "行情异常" : pnlLabel(unrealized),
    pnl_class: dataError ? "muted" : pnlClass(unrealized),
    unrealized_net_pnl: num(p.unrealized_net_pnl, unrealized),
    unrealized_net_text: fmtUsdtExact(num(p.unrealized_net_pnl, unrealized)),
    exit_fee_estimate_text: fmtUsdtExact(Math.max(0, unrealized - num(p.unrealized_net_pnl, unrealized))),
    price_status: priceStatus,
    price_source: p.price_source || null,
    data_error: dataError,
    data_error_text: priceStatus === "STALE" ? "行情过期,正在重新校验" : "行情异常,正在重新校验",
    realized_pnl: realized,
    realized_text: fmtUsdtExact(realized),
    // ROE = 未实现 / 剩余保证金(杠杆后收益),与 price_move_pct(标的涨跌)分开
    roe_pct: roePct,
    roe_text: fmtPct(roeRaw),
    price_move_pct: priceMove,
    price_move_text: fmtPct(priceMove),
    pnl_pct: roePct,
    pnl_pct_text: fmtPct(roeRaw),
    // 数量
    initial_quantity: initialQty,
    remaining_quantity: remainingQty,
    partial_close_count: num(p.partial_close_count, 0),
    closed_fraction: closedFraction,
    closed_pct_text: round(closedFraction * 100, 1) + "%",
    remaining_pct_text: round((1 - closedFraction) * 100, 1) + "%",
    holding: fmtHold((i.now ? num(i.now) : Date.now()) - num(p.entry_time)),
    holding_time: fmtHold((i.now ? num(i.now) : Date.now()) - num(p.entry_time)),
    stop: p.stop_price == null ? null : num(p.stop_price),
    stop_price: p.stop_price == null ? null : num(p.stop_price),
    take_profit: p.take_profit_price == null ? null : num(p.take_profit_price),
    stop_state: p.stop_state || null,
    trailing_state: p.trailing_state || null,
    trailing_text: p.stop_state && p.stop_state.type ? p.stop_state.type + (p.stop_state.price == null ? "" : " @ " + num(p.stop_state.price).toFixed(2)) : "--",
    // 资金费(与盈亏分开显示,避免混进 PnL)
    funding_simulated: num(p.funding_simulated, 0),
    funding_status: p.funding_status || "unavailable",
    future_prediction_at_entry: p.future_prediction_at_entry || null
  };
}

export function fmtHold(ms) {
  const n = num(ms, 0);
  if (n <= 0) return "--";
  if (n < 3600000) return Math.max(1, Math.round(n / 60000)) + " 分钟";
  if (n < 86400000) return (n / 3600000).toFixed(1) + " 小时";
  return (n / 86400000).toFixed(1) + " 天";
}

export function stateLabel(state) {
  return { STOPPED: "已停止", STARTING: "启动中", RUNNING: "自动模拟运行中", PAUSED: "已暂停", RECOVERING: "恢复中", ERROR: "异常" }[state] || String(state || "--");
}

// 首页:今天的模拟结果 + 双池 + 引擎状态
export function homeViewModel(input) {
  const i = input || {};
  const snapshot = i.snapshot || {};
  const account = snapshot.account || {};
  const wallets = snapshot.wallets || {};
  const positions = snapshot.positions || [];
  const today = snapshot.today || summarizeTrades([]);
  const allTime = snapshot.all_time || summarizeTrades([]);
  const learning = i.learning || {};
  const risk = i.risk || {};
  const shortWallet = wallets.short || {};
  const longWallet = wallets.long || {};
  const todayShort = summarizeTrades((i.todayTrades || []).filter((t) => t.mode === "short"));
  const todayLong = summarizeTrades((i.todayTrades || []).filter((t) => t.mode === "long"));
  return {
    state: snapshot.state || "STOPPED",
    state_label: stateLabel(snapshot.state),
    running: snapshot.state === "RUNNING",
    today_pnl: num(today.net_pnl),
    today_pnl_text: fmtUsdt(today.net_pnl),
    today_trades: num(today.trades),
    total_equity: num(account.total_equity),
    total_equity_text: num(account.total_equity).toFixed(2) + " USDT",
    initial_balance: num(account.initial_balance, 10),
    realized: num(account.realized_pnl),
    unrealized: num(account.unrealized_pnl),
    fees_paid: num(account.fees_paid),
    drawdown_pct: num(account.max_drawdown_pct),
    short_equity: num(shortWallet.allocated_balance),
    short_today_pnl: num(todayShort.net_pnl),
    short_today_text: fmtUsdt(todayShort.net_pnl),
    long_equity: num(longWallet.allocated_balance),
    long_today_pnl: num(todayLong.net_pnl),
    long_today_text: fmtUsdt(todayLong.net_pnl),
    open_positions: positions.length,
    open_short: positions.filter((p) => p.mode === "short").length,
    open_long: positions.filter((p) => p.mode === "long").length,
    risk_level: RISK_ZH[risk.risk_level] || (risk.risk_level || "--"),
    risk_score: risk.risk_score == null ? null : num(risk.risk_score),
    learning_status: learning.champion ? "学习正常(Champion " + learning.champion + ")" : (learning.note || "系统正在学习"),
    all_time_pnl: num(allTime.net_pnl),
    all_time_text: fmtUsdt(allTime.net_pnl),
    // §70:分配(读真实钱包,不写死)
    allocation_text: (() => {
      const s = num(shortWallet.allocated_balance);
      const l = num(longWallet.allocated_balance);
      const total = s + l;
      if (!(total > 0)) return "--";
      return "短线 " + (s / total * 100).toFixed(0) + "% / 长线 " + (l / total * 100).toFixed(0) + "%";
    })(),
    has_position_data: positions.length > 0 || num(allTime.trades) > 0
  };
}

// 模拟页:双池 + 持仓 + 最近成交
export function paperViewModel(input) {
  const i = input || {};
  const wallets = i.wallets || {};
  const positions = i.positions || [];
  const trades = (i.trades || []).slice().sort((a, b) => num(b.exit_time) - num(a.exit_time)).slice(0, i.limit || 20);
  const account = i.account || {};
  const todayKey = dayKeyOf(i.now || Date.now());
  const walletView = (mode) => {
    const w = wallets[mode] || {};
    const modeTrades = (i.trades || []).filter((t) => t.mode === mode);
    const stats = summarizeTrades(modeTrades);
    // V19 模拟页:双池子卡需要各自的"持仓数 / 今日盈亏"(全部来自真实仓位与成交)
    const todayStats = summarizeTrades(modeTrades.filter((t) => dayKeyOf(t.exit_time) === todayKey));
    return {
      mode,
      label: MODE_CONFIG[mode] ? MODE_CONFIG[mode].label : mode,
      allocated: num(w.allocated_balance),
      available: num(w.available_balance),
      reserved: num(w.reserved_balance),
      realized: num(w.realized_pnl),
      unrealized: num(w.unrealized_pnl),
      open_positions: positions.filter((p) => p.mode === mode).length,
      trades: num(stats.trades),
      win_rate: stats.win_rate,
      net_pnl: num(stats.net_pnl),
      net_pnl_text: fmtUsdt(stats.net_pnl),
      today_net: num(todayStats.net_pnl),
      today_net_text: fmtUsdt(todayStats.net_pnl)
    };
  };
  return {
    short: walletView("short"),
    long: walletView("long"),
    positions: positions.map((p) => positionView(p, { now: i.now })),
    trades: trades.map((t) => ({
      id: t.trade_id,
      symbol: t.symbol,
      display: String(t.symbol || "").replace("USDT", "/USDT"),
      mode: t.mode,
      mode_label: MODE_CONFIG[t.mode] ? MODE_CONFIG[t.mode].label : t.mode,
      side: t.side === "LONG" ? "多" : "空",
      entry: num(t.entry_price),
      exit: num(t.exit_price),
      net: num(t.net_pnl),
      net_text: fmtUsdtExact(t.net_pnl),
      net_class: pnlClass(t.net_pnl),
      pct: fmtPct(t.return_pct),
      holding: fmtHold(t.holding_ms),
      reason: t.exit_reason || "--",
      exit_reason: t.exit_reason || "--",
      // §65:成交也带完整资金信息(保证金 / 仓位价值 / 杠杆)
      leverage: num(t.leverage, 1),
      leverage_text: (num(t.requested_leverage, 0) > 0 ? "AUTO" : "AUTO") + " " + num(t.leverage, 1) + "x",
      margin_text: t.margin == null ? "--" : num(t.margin).toFixed(2) + "U",
      notional_text: t.notional_value == null ? "--" : num(t.notional_value).toFixed(2) + "U",
      partial: t.partial === true,
      remaining_quantity: t.remaining_quantity == null ? null : num(t.remaining_quantity),
      gross: num(t.gross_pnl),
      fees: num(t.fees),
      time: t.exit_time ? new Date(num(t.exit_time)).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "--"
    })),
    total_net: num(summarizeTrades(i.trades || []).net_pnl),
    total_net_text: fmtUsdt(summarizeTrades(i.trades || []).net_pnl),
    today_net: num(summarizeTrades((i.trades || []).filter((t) => dayKeyOf(t.exit_time) === dayKeyOf(i.now || Date.now()))).net_pnl),
    today_net_text: fmtUsdt(summarizeTrades((i.trades || []).filter((t) => dayKeyOf(t.exit_time) === dayKeyOf(i.now || Date.now()))).net_pnl),
    // V19 模拟页:主资产卡(总资产优先,来自真实账户;不在这里编造分层数字)
    total_equity: num(account.total_equity),
    total_equity_text: num(account.total_equity).toFixed(2) + " USDT"
  };
}

// Coin Detail:综合状态 / 风险 / 策略 / 当前 Paper 持仓
export function detailViewModel(input) {
  const i = input || {};
  const a = i.analysis || {};
  const positions = i.positions || [];
  const mode = i.mode || "short";
  const pos = positions.find((p) => p.symbol === a.symbol) || null;
  const score = evidenceLike(a, i.ml);
  const bias = score > 0.25 ? "偏多" : score < -0.25 ? "偏空" : "震荡";
  const riskLevel = i.risk ? i.risk.risk_level : null;
  const strategy = pos
    ? (pos.mode === "long" ? "长线持仓" : "短线持仓")
    : (i.decision && i.decision.action === "open_long" ? "短线可关注" : i.decision && i.decision.action === "open_short" ? "偏空观望" : (i.decision && i.decision.action === "hold" ? "暂不操作" : "暂不操作"));
  return {
    symbol: a.symbol || i.symbol || "--",
    symbol_display: String(a.symbol || i.symbol || "--").replace("USDT", "/USDT"),
    price: num(i.price, num(a.price)),
    change24h: num(i.change24h),
    change_text: fmtPct(i.change24h),
    interval: i.interval || "1h",
    bias,
    bias_class: score > 0.25 ? "green" : score < -0.25 ? "red" : "gray",
    direction_zh: DIR_ZH_UI[a.direction] || a.direction || "--",
    confidence: a.confidence == null ? null : num(a.confidence),
    regime: a.market_regime ? a.market_regime.label : "--",
    risk_level: RISK_ZH[riskLevel] || "--",
    risk_score: i.risk && i.risk.risk_score != null ? num(i.risk.risk_score) : null,
    risk_flags: (i.risk && i.risk.risk_flags) || [],
    strategy,
    position: pos ? positionView(pos, { now: i.now }) : null,
    has_analysis: Boolean(a.direction),
    timeframes: a.timeframes || {},
    degraded: Boolean(a.data_degraded),
    limited: Boolean(a.limited_data)
  };
}

function evidenceLike(analysis, ml) {
  const a = analysis || {};
  const tf = a.timeframes || {};
  let s = 0;
  const bull = Object.keys(tf).filter((k) => /Bullish/.test(tf[k])).length;
  const bear = Object.keys(tf).filter((k) => /Bearish/.test(tf[k])).length;
  s += (bull - bear) / Math.max(1, bull + bear);
  if (/Uptrend/.test((a.market_regime && a.market_regime.label) || "")) s += 0.3;
  if (/Downtrend/.test((a.market_regime && a.market_regime.label) || "")) s -= 0.3;
  if (a.structure && a.structure.label === "上涨结构") s += 0.2;
  if (a.structure && a.structure.label === "下降结构") s -= 0.2;
  if (ml && ml.probability_bullish != null) s += (num(ml.probability_bullish) - num(ml.probability_bearish)) * 0.5;
  return round(Math.max(-1, Math.min(1, s)), 3);
}

// AI Chat:悬浮按钮上下文(只带真实数据摘要)
export function chatViewModel(input) {
  const i = input || {};
  const d = i.detail || {};
  return {
    title: (d.symbol_display || "当前币种") + " · AI",
    context_line: [d.symbol_display, d.interval, d.price ? "@" + d.price : "", d.bias, "风险 " + d.risk_level].filter(Boolean).join(" · "),
    suggestions: ["这个币现在怎么样?", "适合短线还是长线?", "现在模拟买的话大概拿多久?", "为什么不买?", "什么时候会卖?", "现在风险高吗?", "短线和长线谁最近表现更好?"],
    has_position: Boolean(d.position),
    position_line: d.position ? d.position.mode_label + " " + d.position.side + " · 浮动 " + d.position.pnl_text + " · 已持有 " + d.position.holding : ""
  };
}

// 市场列表行
export function marketRow(ticker, watchSet) {
  const t = ticker || {};
  const symbol = String(t.symbol || "");
  return {
    symbol,
    display: symbol.replace("USDT", "/USDT"),
    price: num(t.lastPrice),
    change24h: num(t.priceChangePercent),
    change_text: fmtPct(t.priceChangePercent),
    quote_volume: num(t.quoteVolume),
    watched: Boolean(watchSet && watchSet.has(symbol))
  };
}

// 学习状态(我的 > 学习状态)
export function learningViewModel(input) {
  const i = input || {};
  return {
    champion: i.champion || null,
    challenger: i.challenger || null,
    drift: i.drift || null,
    status_text: i.drift && i.drift.drift_detected ? "检测到市场规律变化,正在训练新的候选模型" : (i.champion ? "学习正常,Champion " + i.champion + " 正在工作" : "系统正在积累数据"),
    plain: !i.drift || !i.drift.drift_detected
  };
}

// ---- V16.1-RV §19/§21:资金口径唯一入口(首页 / 模拟 / 量化内核 三页共用) ----
// 规则:能拿到引擎/Viewer 的官方 poolLayers() 就原样用它;拿不到就本地套同一公式补算(绝不各页各写一套)。
export function capitalSnapshot(input) {
  const i = input || {};
  const account = i.account || {};
  const provided = i.layers && i.layers.tradable_capital != null ? i.layers : null;
  const layers = provided || poolLayers({
    equity: num(account.total_equity),
    reserved_margin: num(account.reserved_balance),
    unrealized_pnl: num(account.unrealized_pnl),
    cash_balance: num(account.cash_balance),
    pool: { protected_balance: num(i.protected_balance, 0) }
  });
  return {
    total_equity: num(layers.total_equity != null ? layers.total_equity : account.total_equity),
    tradable_capital: num(layers.tradable_capital),
    reserved_margin: num(layers.reserved_margin),
    protected_profit: num(layers.protected_profit),
    unrealized_pnl: num(layers.unrealized_pnl),
    spendable_for_entry: num(layers.spendable_for_entry),
    // 数据真实性:来源缺失时页面应显示 "--",而不是把 0.00 当成真值
    has_data: Boolean(provided || account.cash_balance != null || account.total_equity != null),
    state_version: num(i.state_version, 0),
    updated_at: num(i.updated_at, Date.now()),
    caliber: provided ? "poolLayers(engine/viewer)" : "poolLayers(local)"
  };
}

// V16.1-RV §21:一致性对比 —— 同一份资金数字,任意两来源差异超过容差即分叉(供页面做 UI_ACCOUNT_CONSISTENCY_CHECK 与测试复用)
export const CAPITAL_PARITY_TOLERANCE = 0.005;
export function capitalParity(a, b) {
  const keys = ["total_equity", "tradable_capital", "reserved_margin", "protected_profit"];
  const left = a || {};
  const right = b || {};
  const diffs = keys.filter((k) => Math.abs(num(left[k], 0) - num(right[k], 0)) > CAPITAL_PARITY_TOLERANCE);
  return { ok: diffs.length === 0, fields: diffs, left: left, right: right };
}

// V16.1-RV §50:通知点击的目标页路由(纯函数,可测)——
// 交易/持仓类且标题里带币种 → 币种详情;系统/风险类 → 诊断页;学习/研究类 → 我的页;
// 其余:能解析出币种去详情,否则去模拟页。绝不允许"全部只打开首页"。
export function notificationRoute(input) {
  const i = input || {};
  const kind = String(i.kind || "").toUpperCase();
  const title = String(i.title || "");
  const m = title.match(/([A-Z0-9]{2,12})\/USDT/);
  const symbol = m ? m[1] + "USDT" : null;
  if (symbol && (kind === "TRADE" || kind === "CLOSE" || kind === "RISK" || kind === "MARKET")) {
    return { page: "detail", symbol: symbol, reason: "交易/风险类通知(带币种) → 币种详情" };
  }
  if (kind === "SYSTEM" || kind === "RISK" || kind === "MARKET") {
    return { page: "diag", symbol: null, reason: "系统/风险类通知 → 系统诊断" };
  }
  if (kind === "LEARNING" || kind === "RESEARCH") {
    return { page: "settings", symbol: null, reason: "学习/研究类通知 → 我的页" };
  }
  return { page: symbol ? "detail" : "paper", symbol: symbol, reason: symbol ? "默认(带币种) → 详情" : "默认 → 模拟页" };
}


// V16.2u §3/§34/§40:Paper Runtime 统一呈现态(纯函数,单一事实来源)
// 规则:引擎内部状态(RECOVERING/ERROR)与账户级保护(HWM/完整性/数据质量/运行时停滞)
// 归一到 UI/报告共用的 7 态;RUNNING/DEGRADED 时不得再出现可点击的"开始模拟"。
export const PAPER_RUNTIME_STATES = ["STOPPED", "STARTING", "RUNNING", "PAUSED", "DEGRADED", "SAFE_MODE", "HARD_STOP"];
export const RUNTIME_STATE_ZH = {
  STOPPED: "已停止", STARTING: "启动中", RUNNING: "自动模拟运行中", PAUSED: "已暂停",
  DEGRADED: "降级运行", SAFE_MODE: "安全模式(已暂停新开仓)", HARD_STOP: "回撤保护(HARD STOP)"
};
export function paperRuntimeView(input) {
  const o = input || {};
  const base = String(o.engine_state || "STOPPED");
  const reasons = [];
  let state = base === "RECOVERING" ? "STARTING" : (base === "ERROR" ? "SAFE_MODE" : base);
  if (!PAPER_RUNTIME_STATES.includes(state)) state = "STOPPED";
  if (o.hwm_block) {
    state = "HARD_STOP";
    reasons.push("账户回撤已达保护线" + (o.hwm_drawdown_pct ? "(" + Number(o.hwm_drawdown_pct).toFixed(1) + "%)" : ""));
  } else if (o.entries_paused || o.safe_mode) {
    if (state === "RUNNING" || state === "STARTING") state = "SAFE_MODE";
    reasons.push(String(o.entries_paused_reason || o.safe_mode_reason || "数据完整性保护"));
  } else if ((o.data_degraded || o.market_stale || o.runtime_stalled) && state === "RUNNING") {
    state = "DEGRADED";
    if (o.data_degraded) reasons.push("数据质量降级");
    if (o.market_stale) reasons.push("行情停滞");
    if (o.runtime_stalled) reasons.push("运行时心跳停滞");
  }
  const running = state === "RUNNING" || state === "DEGRADED";
  // HARD_STOP / SAFE_MODE 下引擎仍在对已有仓位做风控管理,"暂停"依然有效;
  // 但"开始模拟"这两种状态下必须消失(禁止新开仓语义优先)。
  const manageable = running || state === "HARD_STOP" || state === "SAFE_MODE";
  return {
    state,
    label: RUNTIME_STATE_ZH[state] || state,
    reason_short: reasons.length ? reasons.slice(0, 2).join(" · ") : "",
    reasons,
    running,
    can_start: state === "STOPPED",
    can_resume: state === "PAUSED",
    can_pause: manageable,
    show_start_button: state === "STOPPED" || state === "PAUSED",
    note_zh: state === "DEGRADED"
      ? "模拟仍在运行,但部分数据不可用:新开仓已自动收紧"
      : (state === "SAFE_MODE" ? "为保护账户已暂停新开仓,已有仓位仍由风控正常管理" : "")
  };
}
