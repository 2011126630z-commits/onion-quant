// paper/accountAudit.js · V16.2y · P0 账户审计 / 亏损归因 / 学习数据完整性(纯函数,不碰 DOM/网络/存储)
// 原则(工单 P0 PAPER ACCOUNT AUDIT):
//   · 只读真实记录做算术与规则判定 —— 标签来自字段,绝不"现场编理由";
//   · 对账必须满足守恒;对不上 → mismatch=true(上层暂停新开仓,保留全部历史,不静默改金额);
//   · seed/synthetic/test/replay 一律 learning_eligible=false,永不进入学习;
//   · Revision 折叠到 canonical_sample_id,训练样本同一 canonical 只算 1 个;
//   · 派生账本(Ledger)按时间序重放真实成交,并做现金闭合校验(闭合不上就如实报差额)。
export const AUDIT_VERSION = "account-audit-v1.0";
export const FEATURE_SCHEMA_VERSION = "fs-v1";

// 容差(USDT)。账户恒等式要求最严;成交汇总 vs 账户记账允许微小舍入;派生账本闭合居中。
export const AUDIT_TOLERANCE = {
  account_equation: 0.01,     // initial + realized + unrealized === equity
  trades_vs_account: 0.05,    // Σ成交净额 vs 账户 realized_pnl
  ledger_closure: 0.05        // ΣLedger 变动 vs 现金余额变化
};

const anum = (v, d = 0) => { if (v == null || v === "") return d; const x = Number(v); return Number.isFinite(x) ? x : d; };
const ar6 = (v) => Math.round(anum(v) * 1e6) / 1e6;
const AUDIT_EPS = 1e-9;

// ---------- 样本来源分类(工单 §11/§14) ----------
// 返回 { sample_origin, market_data_source, environment, learning_eligible, reason }
export function classifyOrigin(rec) {
  const r = rec || {};
  const id = String(r.trade_id || r.position_id || r.order_id || r.id || r.sample_id || r.signal_id || "");
  const engineVersion = String(r.engine_version || r.strategy_version || "");
  let origin = "REAL_SIGNAL";
  let reason = "engine_record";
  if (/^seed[_-]/.test(id)) { origin = "SEED"; reason = "id_prefix:seed"; }
  else if (/^syn[_-]/.test(id)) { origin = "SYNTHETIC"; reason = "id_prefix:syn"; }
  else if (/^test[_-]/.test(id)) { origin = "TEST"; reason = "id_prefix:test"; }
  else if (/^replay[_-]/.test(id)) { origin = "REPLAY"; reason = "id_prefix:replay"; }
  else if (engineVersion === "seed" || engineVersion === "synthetic") { origin = "SEED"; reason = "engine_version:" + engineVersion; }
  // 记录里显式带来源字段时以其为准(工单 §14 的新字段;旧记录没有则退回推断)
  if (r.sample_origin) { origin = String(r.sample_origin).toUpperCase(); reason = "field:sample_origin"; }
  const env = String(r.environment || "PRODUCTION_PAPER");
  const mds = String(r.market_data_source || "BINANCE_PUBLIC");
  const eligible = origin === "REAL_SIGNAL" && env === "PRODUCTION_PAPER";
  return { sample_origin: origin, market_data_source: mds, environment: env, learning_eligible: eligible, reason: reason };
}

// ---------- 账户对账(工单 §2/§18) ----------
export function reconcileAccount(input) {
  const i = input || {};
  const account = i.account || {};
  const positions = i.positions || [];
  const trades = i.trades || [];
  const orders = i.orders || [];
  const engineState = i.engineState || {};

  const realTrades = trades.filter((t) => classifyOrigin(t).learning_eligible);
  const seedTrades = trades.filter((t) => !classifyOrigin(t).learning_eligible);
  const sumBy = (arr, f) => arr.reduce((s, x) => s + anum(f(x)), 0);

  const initial = anum(account.initial_balance, anum(i.initialFallback, 100));
  const equity = anum(account.total_equity, 0);
  const cash = anum(account.cash_balance, 0);
  const reserved = anum(account.reserved_balance, 0);
  const realizedAccount = anum(account.realized_pnl, 0);
  const unrealizedAccount = anum(account.unrealized_pnl, 0);

  const openPositions = positions.filter((p) => p && (p.status === "OPEN" || p.status === "CLOSING"));
  const unrealizedPositions = sumBy(openPositions, (p) => p.unrealized_pnl);

  const grossTrades = sumBy(realTrades, (t) => (t.gross_pnl != null ? t.gross_pnl : anum(t.net_pnl) + anum(t.fees)));
  const feesTrades = sumBy(realTrades, (t) => t.fees);
  const fundingTrades = sumBy(realTrades, (t) => t.funding);
  const netTrades = sumBy(realTrades, (t) => t.net_pnl);
  const netSeed = sumBy(seedTrades, (t) => t.net_pnl);
  // 滑点金额:成交记录不单独记金额时,用订单 slippage_pct × 名义估算(标注 estimated)
  const slippageEstimated = sumBy(orders.filter((o) => o && classifyOrigin(o).learning_eligible && o.status === "FILLED"),
    (o) => Math.abs(anum(o.slippage_pct, 0)) / 100 * anum(o.quantity, 0) * anum(o.fill_price, 0));

  const protectedBalance = anum(engineState.profit_pool && engineState.profit_pool.protected_balance, 0);
  const peak = anum(account.peak_equity, anum(account.total_equity, 0));
  const drawdownPct = peak > 0 ? Math.max(0, (peak - equity) / peak * 100) : 0;

  // ① 账户恒等式(权威):initial + 账户记账的 realized + unrealized === equity
  const eqDiff = ar6(initial + realizedAccount + unrealizedAccount - equity);
  // ② 成交汇总 vs 账户记账:差额属于"记账口径差"(例如舍入/资金费/历史重置残留)
  const tradesGap = ar6(netTrades - realizedAccount);
  // ③ 视图污染量:非真实样本对"全部成交汇总"的贡献(UI 曾据此显示错误累计)
  const viewPollution = ar6(netSeed);

  const checks = [
    { id: "ACCOUNT_EQUATION", ok: Math.abs(eqDiff) <= AUDIT_TOLERANCE.account_equation, detail: "initial+realized+unrealized−equity", diff: eqDiff },
    { id: "TRADES_VS_ACCOUNT", ok: Math.abs(tradesGap) <= AUDIT_TOLERANCE.trades_vs_account, detail: "Σ成交净额−账户realized", diff: tradesGap },
    { id: "RESERVED_NONNEGATIVE", ok: reserved >= -AUDIT_EPS, detail: "reserved_balance≥0", diff: ar6(reserved) },
    { id: "CASH_PLUS_RESERVED", ok: Math.abs((cash + reserved) - equity - unrealizedAccount) <= AUDIT_TOLERANCE.account_equation, detail: "cash+reserved−(equity−unrealized)", diff: ar6(cash + reserved - equity + unrealizedAccount) }
  ];
  const mismatch = !checks[0].ok;   // 恒等式不成立才算 P0(其余为告警/口径差)

  return {
    version: AUDIT_VERSION,
    ok: mismatch === false,
    mismatch: mismatch,
    inputs: { positions: positions.length, open_positions: openPositions.length, trades: trades.length, real_trades: realTrades.length, seed_trades: seedTrades.length, orders: orders.length },
    equity_reconciliation: {
      initial_equity: ar6(initial),
      realized_gross_pnl: ar6(grossTrades),
      fees: ar6(feesTrades),
      funding: ar6(fundingTrades),
      slippage_estimated: ar6(slippageEstimated),
      realized_net_pnl: ar6(netTrades),
      unrealized_pnl: ar6(unrealizedAccount),
      protected_profit: ar6(protectedBalance),
      tradable_cash: ar6(cash),
      used_margin: ar6(sumBy(openPositions, (p) => p.remaining_margin)),
      reserved_margin: ar6(reserved),
      current_equity: ar6(equity),
      net_change: ar6(equity - initial),
      peak_equity: ar6(peak),
      drawdown_pct: Math.round(drawdownPct * 100) / 100,
      account_realized_pnl: ar6(realizedAccount),
      positions_unrealized_pnl: ar6(unrealizedPositions)
    },
    account_summary: {
      short_pool: ar6(i.wallets ? anum((i.wallets.find && i.wallets.find((w) => w.mode === "short") || {}).available_balance, 0) : 0),
      long_pool: ar6(i.wallets ? anum((i.wallets.find && i.wallets.find((w) => w.mode === "long") || {}).available_balance, 0) : 0),
      open_position_count: openPositions.length,
      at: Date.now()
    },
    diffs: { account_equation: eqDiff, trades_vs_account: tradesGap, view_pollution_from_seed: viewPollution },
    checks: checks
  };
}

// ---------- 母仓(Mother Position)行(工单 §3) ----------
export function motherPositions(input) {
  const i = input || {};
  const positions = i.positions || [];
  const trades = i.trades || [];
  const orders = i.orders || [];
  const byId = new Map();
  for (const p of positions) if (p && p.position_id) byId.set(String(p.position_id), p);

  const groups = new Map();
  for (const t of trades) {
    const pid = String((t && (t.position_id || t.parent_position_id)) || ("orphan_" + ((t && t.trade_id) || "?")));
    if (!groups.has(pid)) groups.set(pid, []);
    groups.get(pid).push(t);
  }
  const rows = [];
  for (const [pid, evs] of groups.entries()) {
    const pos = byId.get(pid) || {};
    const origin = classifyOrigin(Object.assign({ position_id: pid }, pos, { engine_version: pos.engine_version }));
    // 组内若全部是 seed 成交,同样归为非学习样本
    const allSeed = evs.every((t) => !classifyOrigin(t).learning_eligible);
    const sorted = evs.slice().sort((a, b) => anum(a.exit_time, 0) - anum(b.exit_time, 0));
    const gross = evs.reduce((s, t) => s + anum(t.gross_pnl != null ? t.gross_pnl : anum(t.net_pnl) + anum(t.fees)), 0);
    const fee = evs.reduce((s, t) => s + anum(t.fees), 0);
    const net = evs.reduce((s, t) => s + anum(t.net_pnl), 0);
    const qty = evs.reduce((s, t) => s + Math.abs(anum(t.quantity, 0)), 0);
    const avgExit = qty > 0 ? evs.reduce((s, t) => s + anum(t.exit_price, 0) * Math.abs(anum(t.quantity, 0)), 0) / qty : null;
    const mfe = Math.max(...evs.map((t) => anum(t.mfe, 0)), 0);
    const mae = Math.min(...evs.map((t) => anum(t.mae, 0)), 0);
    const partials = evs.filter((t) => t.partial === true).length;
    const openedAt = anum(pos.entry_time, anum(sorted[0] && sorted[0].entry_time, null)) || null;
    const closedAt = anum(pos.exit_time, anum(sorted[sorted.length - 1] && sorted[sorted.length - 1].exit_time, null)) || null;
    const initMargin = anum(pos.initial_margin, anum(pos.margin, anum(sorted[0] && sorted[0].margin, 0)));
    rows.push({
      position_id: pid,
      symbol: String(pos.symbol || (sorted[0] && sorted[0].symbol) || ""),
      strategy_mode: String(pos.strategy_mode || pos.mode || (sorted[0] && sorted[0].mode) || ""),
      direction: String(pos.direction || pos.side || (sorted[0] && sorted[0].side) || ""),
      status: String(pos.status || (closedAt ? "CLOSED" : "OPEN")),
      opened_at: openedAt,
      closed_at: closedAt,
      holding_time_ms: (openedAt && closedAt) ? Math.max(0, closedAt - openedAt) : anum(pos.holding_ms, null),
      entry_price: anum(pos.entry_price, anum(sorted[0] && sorted[0].entry_price, null)),
      avg_exit_price: avgExit == null ? null : ar6(avgExit),
      initial_margin: ar6(initMargin),
      max_margin_used: ar6(Math.max(initMargin, ...evs.map((t) => anum(t.margin, 0)))),
      notional: ar6(anum(pos.notional, anum(pos.entry_notional, anum(sorted[0] && sorted[0].notional, 0)))),
      leverage: anum(pos.actual_leverage, anum(pos.leverage, anum(sorted[0] && sorted[0].leverage, 0))),
      gross_pnl: ar6(gross),
      fee: ar6(fee),
      funding: ar6(evs.reduce((s, t) => s + anum(t.funding), 0)),
      slippage_estimated: ar6(evs.reduce((s, t) => s + anum(t.slippage_estimated, 0), 0)),
      net_pnl: ar6(net),
      return_on_margin: initMargin > 0 ? Math.round(net / initMargin * 10000) / 100 : null,
      mfe: ar6(mfe),
      mae: ar6(mae),
      max_profit_seen: ar6(mfe),
      profit_giveback: ar6(Math.max(0, mfe - Math.max(0, net))),
      entry_signal_id: pos.signal_id || null,
      strategy_intent_id: pos.strategy_intent_id || null,
      decision_id: pos.decision_id || null,
      entry_reason: pos.entry_basis || (pos.entry_decision && (pos.entry_decision.zh || pos.entry_decision.reason)) || null,
      exit_reason: String(pos.exit_reason || (sorted[sorted.length - 1] && (sorted[sorted.length - 1].exit_reason || sorted[sorted.length - 1].reason)) || ""),
      thesis: pos.entry_thesis || null,
      thesis_state: pos.thesis_state || null,
      partial_close_count: Math.max(partials, anum(pos.partial_close_count, 0)),
      add_count: anum(pos.add_count, 0),
      action_source: pos.action_source || null,
      engine_version: pos.engine_version || null,
      model_version: pos.model_version || null,
      entry_quality_score: anum(pos.entry_quality_score, null),
      entry_net_edge_pct: anum(pos.entry_net_edge_pct, null),
      closed_candle_time: anum(pos.closed_candle_time, null),
      sample_origin: origin.sample_origin,
      learning_eligible: origin.learning_eligible && !allSeed,
      events: evs.length
    });
  }
  return rows;
}

// ---------- 亏损归因标签(工单 §4;纯规则,来源字段) ----------
export function classifyLoss(row, ctx) {
  const c = ctx || {};
  const labels = [];
  const net = anum(row.net_pnl);
  const gross = anum(row.gross_pnl);
  const mfe = anum(row.mfe);
  const mae = anum(row.mae);
  const fee = anum(row.fee);
  const exit = String(row.exit_reason || "").toLowerCase();
  if (net >= 0) return labels;   // 只对亏损母仓贴标签
  if (mfe <= 0.005) labels.push("WRONG_DIRECTION");
  if (/stop_loss|stop/.test(exit)) labels.push(mfe >= 0.02 ? "LATE_EXIT" : "STOP_LOSS");
  if (mfe >= 0.02) labels.push("PROFIT_GIVEBACK");
  if (/take_profit|profit_lock|tp/.test(exit) && net < 0) labels.push("EARLY_EXIT");
  if (/thesis|invalid/.test(String(row.thesis_state || "")) || /thesis/.test(exit)) labels.push("THESIS_INVALID");
  if (/liquidat|risk|hard_stop/.test(exit)) labels.push("RISK_EXIT");
  if (anum(row.entry_net_edge_pct, null) != null && anum(row.entry_net_edge_pct) < 0.10) labels.push("LOW_NET_EDGE");
  const absG = Math.abs(gross);
  if (net < 0 && absG > 1e-9 && fee / absG >= 0.5) labels.push("FEE_DRAG");
  if (net < 0 && anum(row.slippage_estimated, 0) >= fee * 0.3 && fee > 0) labels.push("SLIPPAGE_DRAG");
  if (anum(row.partial_close_count, 0) >= 2 && net < 0) labels.push("PARTIAL_CLOSE_OVERUSE");
  if ((c.symbolEntriesWithin2h || 0) >= 3) labels.push("OVERTRADING");
  if (c.reentryGapMs != null && c.reentryGapMs >= 0 && c.reentryGapMs < 30 * 60000) labels.push("REENTRY_TOO_SOON");
  if (c.sameSignalAcrossModes || c.duplicateSignal) labels.push("SHORT_LONG_DUPLICATE_SIGNAL");
  if (c.overlappingSameSymbol) labels.push("CORRELATED_EXPOSURE");
  if (!labels.length) labels.push(mfe > 0.005 ? "BAD_ENTRY" : "OTHER");
  return labels;
}

// ---------- 汇总(§5/§6/§7/§9/§10) ----------
export function lossAttribution(rows) {
  const losers = rows.filter((r) => anum(r.net_pnl) < 0);
  const winners = rows.filter((r) => anum(r.net_pnl) >= 0 && anum(r.net_pnl) > 0);
  const sumBy = (arr, f) => arr.reduce((s, x) => s + anum(f(x)), 0);
  const bySort = rows.slice().sort((a, b) => anum(a.opened_at) - anum(b.opened_at));
  // V16.2y:上下文计算先按 symbol 分组 —— 原实现对每行 filter 全表(=O(n²),3000 行时单任务 ~100ms),分组后每币内计算
  const bySymbolMap = new Map();
  for (const r of bySort) {
    if (!bySymbolMap.has(r.symbol)) bySymbolMap.set(r.symbol, []);
    bySymbolMap.get(r.symbol).push(r);
  }
  const ctxOf = (row) => {
    const t0 = anum(row.opened_at, 0);
    const peers = bySymbolMap.get(row.symbol) || [];
    const within2h = peers.filter((x) => Math.abs(anum(x.opened_at, 0) - t0) <= 2 * 3600000 && x.position_id !== row.position_id).length;
    const priorLoss = peers.filter((x) => anum(x.net_pnl) < 0 && anum(x.closed_at, 0) > 0 && anum(x.closed_at, 0) <= t0).sort((a, b) => anum(b.closed_at) - anum(a.closed_at))[0];
    const reentryGapMs = priorLoss ? t0 - anum(priorLoss.closed_at, 0) : null;
    const overlapping = peers.some((x) => x.position_id !== row.position_id && x.strategy_mode === row.strategy_mode && anum(x.opened_at, 0) < anum(row.closed_at, anum(row.opened_at, 0) + 1) && anum(x.closed_at, anum(x.opened_at, 0) + 1) > anum(row.opened_at, 0));
    const sameSignalAcrossModes = Boolean(row.entry_signal_id) && peers.some((x) => x.position_id !== row.position_id && x.entry_signal_id === row.entry_signal_id && x.strategy_mode !== row.strategy_mode);
    return { symbolEntriesWithin2h: within2h, reentryGapMs, overlappingSameSymbol: overlapping, sameSignalAcrossModes };
  };
  const labeled = rows.map((r) => Object.assign({}, r, { labels: classifyLoss(r, ctxOf(r)) }));
  const reasonAgg = new Map();
  for (const r of labeled.filter((x) => anum(x.net_pnl) < 0)) {
    for (const lb of r.labels) {
      const rec = reasonAgg.get(lb) || { label: lb, count: 0, net: 0, mfe: 0, mae: 0 };
      rec.count += 1; rec.net += anum(r.net_pnl); rec.mfe += anum(r.mfe); rec.mae += anum(r.mae);
      reasonAgg.set(lb, rec);
    }
  }
  const exitAgg = new Map();
  for (const r of labeled) {
    const k = r.exit_reason || "(none)";
    const rec = exitAgg.get(k) || { exit_reason: k, count: 0, net: 0, mfe: 0, mae: 0 };
    rec.count += 1; rec.net += anum(r.net_pnl); rec.mfe += anum(r.mfe); rec.mae += anum(r.mae);
    exitAgg.set(k, rec);
  }
  const buckets = [
    { key: "<1U", lo: 0, hi: 1 }, { key: "1~5U", lo: 1, hi: 5 }, { key: "5~10U", lo: 5, hi: 10 },
    { key: "10~20U", lo: 10, hi: 20 }, { key: "20~40U", lo: 20, hi: 40 }, { key: ">=40U", lo: 40, hi: Infinity }
  ].map((b) => {
    const inB = rows.filter((r) => anum(r.initial_margin) >= b.lo && anum(r.initial_margin) < b.hi);
    const wins = inB.filter((r) => anum(r.net_pnl) > 0).length;
    const grossB = sumBy(inB, (r) => r.gross_pnl);
    const feeB = sumBy(inB, (r) => r.fee);
    return {
      bucket: b.key, count: inB.length,
      win_rate: inB.length ? Math.round(wins / inB.length * 10000) / 100 : null,
      gross: ar6(grossB), net: ar6(sumBy(inB, (r) => r.net_pnl)), fee: ar6(feeB),
      fee_drag: Math.abs(grossB) > 1e-9 ? Math.round(feeB / Math.abs(grossB) * 10000) / 100 : null,
      avg_holding_ms: inB.length ? Math.round(sumBy(inB, (r) => anum(r.holding_time_ms)) / inB.length) : null,
      avg_return_on_margin_pct: inB.length ? Math.round(sumBy(inB, (r) => anum(r.return_on_margin)) / inB.length * 100) / 100 : null
    };
  });
  const p2l = losers.filter((r) => anum(r.mfe) > 0.005);
  const grossAll = sumBy(rows, (r) => r.gross_pnl);
  const feeAll = sumBy(rows, (r) => r.fee);
  const byMode = (mode) => {
    const inM = rows.filter((r) => r.strategy_mode === mode);
    const wins = inM.filter((r) => anum(r.net_pnl) > 0);
    const losses = inM.filter((r) => anum(r.net_pnl) < 0);
    const gp = sumBy(wins, (r) => r.net_pnl);
    const gl = Math.abs(sumBy(losses, (r) => r.net_pnl));
    return {
      count: inM.length, win_rate: inM.length ? Math.round(wins.length / inM.length * 10000) / 100 : null,
      net: ar6(sumBy(inM, (r) => r.net_pnl)), gross: ar6(sumBy(inM, (r) => r.gross_pnl)), fee: ar6(sumBy(inM, (r) => r.fee)),
      profit_factor: gl > 1e-9 ? Math.round(gp / gl * 100) / 100 : (gp > 0 ? null : 0),
      avg_mfe: inM.length ? ar6(sumBy(inM, (r) => r.mfe) / inM.length) : null,
      avg_mae: inM.length ? ar6(sumBy(inM, (r) => r.mae) / inM.length) : null,
      avg_holding_ms: inM.length ? Math.round(sumBy(inM, (r) => anum(r.holding_time_ms)) / inM.length) : null
    };
  };
  const symbols = [...new Set(rows.map((r) => r.symbol))];
  const bySymbol = symbols.map((s) => {
    const inS = rows.filter((r) => r.symbol === s);
    return { symbol: s, count: inS.length, net: ar6(sumBy(inS, (r) => r.net_pnl)), gross: ar6(sumBy(inS, (r) => r.gross_pnl)), fee: ar6(sumBy(inS, (r) => r.fee)) };
  }).sort((a, b) => a.net - b.net);
  return {
    position_rows: labeled,
    totals: {
      positions: rows.length, winners: winners.length, losers: losers.length,
      gross: ar6(grossAll), fee: ar6(feeAll), funding: ar6(sumBy(rows, (r) => r.funding)),
      slippage_estimated: ar6(sumBy(rows, (r) => r.slippage_estimated)),
      net: ar6(sumBy(rows, (r) => r.net_pnl)),
      fee_drag_ratio: Math.abs(grossAll) > 1e-9 ? Math.round(feeAll / Math.abs(grossAll) * 10000) / 100 : null,
      max_win: rows.length ? ar6(Math.max(...rows.map((r) => anum(r.net_pnl)))) : 0,
      max_loss: rows.length ? ar6(Math.min(...rows.map((r) => anum(r.net_pnl)))) : 0
    },
    top_losers: labeled.filter((r) => anum(r.net_pnl) < 0).sort((a, b) => anum(a.net_pnl) - anum(b.net_pnl)).slice(0, 5),
    profit_to_loss: {
      count: p2l.length,
      total_missed_profit: ar6(sumBy(p2l, (r) => r.mfe)),
      average_max_profit: p2l.length ? ar6(sumBy(p2l, (r) => r.mfe) / p2l.length) : null,
      average_final_loss: p2l.length ? ar6(sumBy(p2l, (r) => r.net_pnl) / p2l.length) : null,
      total_final_loss: ar6(sumBy(p2l, (r) => r.net_pnl)),
      items: p2l.map((r) => ({ position_id: r.position_id, symbol: r.symbol, mode: r.strategy_mode, mfe: r.mfe, final_net: r.net_pnl }))
    },
    by_loss_reason: [...reasonAgg.values()].map((x) => ({ label: x.label, count: x.count, net: ar6(x.net), avg_mfe: ar6(x.mfe / Math.max(1, x.count)), avg_mae: ar6(x.mae / Math.max(1, x.count)) })).sort((a, b) => a.net - b.net),
    by_exit_reason: [...exitAgg.values()].map((x) => ({ exit_reason: x.exit_reason, count: x.count, net: ar6(x.net), avg_mfe: ar6(x.mfe / Math.max(1, x.count)), avg_mae: ar6(x.mae / Math.max(1, x.count)) })).sort((a, b) => a.net - b.net),
    size_buckets: buckets,
    by_mode: { short: byMode("short"), long: byMode("long") },
    by_symbol: bySymbol
  };
}

// ---------- 重复检查(§8) ----------
export function duplicateScan(input) {
  const i = input || {};
  const rows = i.rows || [];
  const bySignal = new Map();
  for (const r of rows) {
    if (!r.entry_signal_id) continue;
    if (!bySignal.has(r.entry_signal_id)) bySignal.set(r.entry_signal_id, []);
    bySignal.get(r.entry_signal_id).push(r);
  }
  const dupSignal = [...bySignal.entries()].filter(([, arr]) => arr.length > 1);
  const acrossModes = dupSignal.filter(([, arr]) => new Set(arr.map((x) => x.strategy_mode)).size > 1);
  // 同一 (symbol, closed_candle_time, direction) 多仓 = 同根收盘K线的重复进场
  const byCanonicalEntry = new Map();
  for (const r of rows) {
    if (r.closed_candle_time == null) continue;
    const k = [r.symbol, r.closed_candle_time, r.direction].join("|");
    if (!byCanonicalEntry.has(k)) byCanonicalEntry.set(k, []);
    byCanonicalEntry.get(k).push(r);
  }
  const dupEntry = [...byCanonicalEntry.entries()].filter(([, arr]) => arr.length > 1);
  // 同一母仓出现 >1 次"最终平仓"(非 partial)= 重复平仓
  const dupExit = rows.filter((r) => anum(r.events, 0) - anum(r.partial_close_count, 0) > 1);
  return {
    duplicate_signal_count: dupSignal.length,
    duplicate_entry_count: dupEntry.length,
    duplicate_exit_count: dupExit.length,
    short_long_same_signal: acrossModes.map(([sig, arr]) => ({ signal_id: sig, positions: arr.map((x) => ({ id: x.position_id, mode: x.strategy_mode, symbol: x.symbol })) })),
    duplicate_signals: dupSignal.map(([sig, arr]) => ({ signal_id: sig, positions: arr.map((x) => x.position_id) })),
    p0: dupSignal.length > 0 || dupExit.length > 0
  };
}

// ---------- 学习数据完整性(§11/§12/§13/§14/§15) ----------
export function canonicalSampleId(input) {
  const s = input || {};
  return [
    String(s.symbol || "").toUpperCase(),
    String(s.interval || ""),
    String(s.closed_candle_open_time == null ? "" : s.closed_candle_open_time),
    String(s.strategy_version || "rule-v0.1"),
    String(s.feature_schema_version || FEATURE_SCHEMA_VERSION)
  ].join("|");
}
const A_IVMS = { "1m": 60000, "5m": 300000, "15m": 900000, "30m": 1800000, "1h": 3600000, "4h": 14400000, "1d": 86400000 };

export function learningIntegrity(input) {
  const i = input || {};
  const signals = i.signals || [];
  const samples = i.learningSamples || [];
  const perSymbol = new Map();
  const canonical = new Map();
  const revisionSuffix = /_r\d+$/;
  let revisionCount = 0;
  let seedRevisionCount = 0;
  let seedCount = 0;
  for (const sg of signals) {
    const origin = classifyOrigin(sg);
    const sym = String(sg.symbol || "?");
    const rec = perSymbol.get(sym) || { symbol: sym, real_signal_count: 0, seed_count: 0, learning_eligible_count: 0, total: 0 };
    rec.total += 1;
    if (origin.learning_eligible) { rec.real_signal_count += 1; rec.learning_eligible_count += 1; } else { rec.seed_count += 1; seedCount += 1; }
    perSymbol.set(sym, rec);
    const ivMs = A_IVMS[String(sg.interval || "1h")] || 3600000;
    const candleOpen = Math.floor(anum(sg.timestamp, 0) / ivMs) * ivMs;
    const cid = canonicalSampleId({ symbol: sym, interval: sg.interval || "1h", closed_candle_open_time: candleOpen, strategy_version: sg.strategy_version, feature_schema_version: sg.feature_schema_version });
    const cr = canonical.get(cid) || { canonical_sample_id: cid, symbol: sym, interval: sg.interval || "1h", revisions: 0, eligible: false, resolved: false, id_suffix_revision: false };
    cr.revisions += 1;
    if (revisionSuffix.test(String(sg.id || "")) || revisionSuffix.test(String(sg.signal_id || ""))) cr.id_suffix_revision = true;
    cr.eligible = cr.eligible || origin.learning_eligible;
    if (sg.status === "RESOLVED" || sg.resolved === true) cr.resolved = true;
    canonical.set(cid, cr);
  }
  // §12:revision 只对"可学习 canonical"计敏感(训练样本口径);seed 的重复单独报告,不污染学习统计
  for (const cr of canonical.values()) {
    if (cr.revisions > 1) {
      if (cr.eligible) revisionCount += cr.revisions - 1;
      else seedRevisionCount += cr.revisions - 1;
    }
  }
  // 学习样本侧:非法样本计数 + 与被标记无效成交关联的样本
  const invalidSamples = samples.filter((s) => s && (s.invalid_sample === true));
  const seedSamples = samples.filter((s) => !classifyOrigin(s).learning_eligible);
  const eligibleCanonical = [...canonical.values()].filter((c) => c.eligible);
  return {
    by_symbol: [...perSymbol.values()].sort((a, b) => b.total - a.total),
    totals: {
      signals: signals.length,
      seed_signals: seedCount,
      real_signals: signals.length - seedCount,
      learning_samples: samples.length,
      invalid_learning_samples: invalidSamples.length,
      non_eligible_samples: seedSamples.length,
      canonical_count: canonical.size,
      canonical_ml_sample_count: eligibleCanonical.length,
      revision_count: revisionCount,
      seed_revision_count: seedRevisionCount
    },
    frozen_snapshot_note: "Feature Snapshot 冻结:本模块只统计;写入端须在首次正式生成时冻结 entry feature(见 page 写入路径)",
    revision_policy: "canonical_sample_id = symbol|interval|closed_candle_open_time|strategy_version|feature_schema_version;同一 canonical 训练只算 1 个样本,revision 仅供审计",
    replicates: [...canonical.values()].filter((c) => c.revisions > 1).slice(0, 50)
  };
}

// ---------- 派生 Ledger(§20/§21) ----------
export function ledgerFromRecords(input) {
  const i = input || {};
  const account = i.account || {};
  const trades = (i.trades || []).slice().sort((a, b) => anum(a.exit_time, 0) - anum(b.exit_time, 0));
  const initial = anum(account.initial_balance, 100);
  const events = [];
  let running = initial;
  let seq = 0;
  const push = (ev) => { seq += 1; ev.event_id = "ldg_" + String(seq).padStart(5, "0"); ev.before = ar6(running); events.push(ev); };
  push({ type: "ACCOUNT_INIT", position_id: null, at: anum(account.created_at, anum(events[0] && events[0].at, Date.now())), delta: ar6(initial), after: ar6(running), reason: "initial_balance" });
  let closedCount = 0;
  for (const t of trades) {
    const origin = classifyOrigin(t);
    if (!origin.learning_eligible) continue;   // 非真实样本不进入账本(它们不改变账户)
    const isPartial = t.partial === true;
    closedCount += 1;
    const delta = anum(t.net_pnl);
    running += delta;
    push({
      type: isPartial ? "PARTIAL_CLOSE" : "FINAL_CLOSE",
      position_id: t.position_id || null,
      at: anum(t.exit_time, Date.now()),
      delta: ar6(delta),
      after: ar6(running),
      reason: String(t.reason || t.exit_reason || "close"),
      detail: { gross_pnl: ar6(anum(t.gross_pnl, anum(t.net_pnl) + anum(t.fees))), fee: ar6(anum(t.fees)), funding: ar6(anum(t.funding)), margin_returned: ar6(anum(t.margin)), symbol: t.symbol, mode: t.mode, trade_id: t.trade_id, source: "derived_from:trade" }
    });
    if (anum(t.fees) > 0) {
      push({ type: "FEE", position_id: t.position_id || null, at: anum(t.exit_time, Date.now()), delta: 0, after: ar6(running), reason: "fee_included_in_net", detail: { fee: ar6(anum(t.fees)), source: "derived_from:trade", note: "手续费已含在 FINAL/PARTIAL_CLOSE 的净额中,此处单列供审计,不重复计入现金" } });
    }
  }
  // 预留轨道(信息性;现金口径 delta=0) —— 只读引擎状态里的真实字段
  const reservations = (i.engineState && i.engineState.reservations) || [];
  for (const rv of reservations) {
    push({ type: "RESERVE_MARGIN", position_id: rv.intent_id || null, at: anum(rv.at, Date.now()), delta: 0, after: ar6(running), reason: String(rv.reason || "reserve"), detail: { amount: ar6(anum(rv.amount)), status: rv.status || null, note: "预留轨道(不动现金)", source: "engine_state.reservations" } });
  }
  const cash = anum(account.cash_balance, 0);
  const closureDiff = ar6(running - cash);
  return {
    version: AUDIT_VERSION,
    event_count: events.length,
    events: events,
    closure: {
      initial: ar6(initial), settled_trades: closedCount, expected_cash: ar6(running), actual_cash: ar6(cash),
      diff: closureDiff, ok: Math.abs(closureDiff) <= AUDIT_TOLERANCE.ledger_closure
    },
    event_types_supported: ["ACCOUNT_INIT", "RESERVE_MARGIN", "RELEASE_MARGIN", "OPEN", "ADD", "PARTIAL_CLOSE", "FINAL_CLOSE", "FEE", "FUNDING", "SLIPPAGE", "PROFIT_SPLIT", "PROTECTED_PROFIT_TRANSFER", "MANUAL_ADJUSTMENT", "RESET"]
  };
}

// ---------- 敏感信息脱敏(§24) ----------
export function redactSensitive(value) {
  let redacted = 0;
  const redactedKeys = [];
  const KEY_RE = /(token|secret|api[_-]?key|authorization|password|passwd|bearer|credential)/i;
  const VAL_RE = /^(sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_|Bearer\s+|AKIA[A-Z0-9]{12,})/;
  const walk = (v, pathStr) => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, pathStr + "[" + i + "]"));
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (KEY_RE.test(k)) { out[k] = "***REDACTED***"; redacted += 1; if (redactedKeys.length < 20) redactedKeys.push(pathStr + "." + k); continue; }
        out[k] = walk(val, pathStr + "." + k);
      }
      return out;
    }
    if (typeof v === "string" && VAL_RE.test(v)) { redacted += 1; if (redactedKeys.length < 20) redactedKeys.push(pathStr); return "***REDACTED***"; }
    return v;
  };
  const result = walk(value, "");
  return { value: result, redacted_count: redacted, redacted_keys: redactedKeys };
}

// ---------- 一键总报告(UI 与导出共用) ----------
export function buildLossReport(input) {
  const i = input || {};
  const recon = reconcileAccount(i);
  const allRows = motherPositions(i);
  // 工单 §11:归因只看学习合格的真实母仓;seed/synthetic/test/replay 单独汇总,不参与亏损归因与 Top 榜
  const rows = allRows.filter((r) => r.learning_eligible);
  const excluded = allRows.filter((r) => !r.learning_eligible);
  const attribution = lossAttribution(rows);
  const duplicates = duplicateScan({ rows: rows });
  const learning = learningIntegrity({ signals: i.signals || [], learningSamples: i.learningSamples || [] });
  const ledger = ledgerFromRecords(i);
  return {
    version: AUDIT_VERSION,
    generated_at: Date.now(),
    reconciliation: recon,
    attribution: attribution,
    excluded_samples: {
      mother_positions: excluded.length,
      net_pnl: ar6(excluded.reduce((s, r) => s + anum(r.net_pnl), 0)),
      note: "非真实样本(seed/synthetic/test/replay):learning_eligible=false,不参与归因与学习"
    },
    duplicates: duplicates,
    learning: learning,
    ledger_closure: ledger.closure,
    ledger_events: ledger.events.slice(-200),
    faults: recon.mismatch ? [{ fault_id: "acc_" + Date.now().toString(36), kind: "ACCOUNTING_MISMATCH", at: Date.now(), detail: recon.diffs }] : []
  };
}
