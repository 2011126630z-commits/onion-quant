// tools/test-modules-v16.mjs · V15 模块化验收:每个新模块都要 实现 + 接线 + 可测
// 覆盖:Portfolio Risk Controller / Position Manager / Execution Simulator / Data Quality Sentinel /
//      Background Task Manager / Notification Manager / Decision Journal / Crash Recovery / Equity Analytics
import { createHistoryStore } from "../worker/src/history/store.js";
import { PAPER_DEFAULTS, num, round } from "../worker/src/paper/accounting.js";
import { createPaperEngine } from "../worker/src/paper/engine.js";
import { portfolioRisk, riskVetoForCandidate, RISK_LEVELS, RISK_THRESHOLDS } from "../worker/src/paper/portfolioRisk.js";
import { simulateFill, closeOrder, openOrder, marginPlan, fillReport, ORDER_TYPES } from "../worker/src/paper/execution.js";
import { createDataQualitySentinel, inspectQuote, inspectCandles, inspectExternal, DQ_SEVERITY } from "../worker/src/paper/dataQuality.js";
import { createPositionManager, positionManagerView, classifyCloseAction, transition, adjustStop, adjustTakeProfit, canAct, POSITION_ACTIONS } from "../worker/src/paper/positionManager.js";
import { createTaskManager, TASK_STATES } from "../worker/src/paper/taskManager.js";
import { createNotificationCenter, notificationDigest, NOTIFY_CHANNELS, ANDROID_CHANNEL_MAP } from "../worker/src/paper/notifications.js";
import { createDecisionJournal, decisionEntry, journalContextForChat } from "../worker/src/paper/decisionJournal.js";
import { recoveryPlan, recoveryView, RECOVERY_ACTIONS } from "../worker/src/paper/recovery.js";
import { equityStats, equitySeries, equityHeadline, recoveryTimeMs } from "../worker/src/paper/equityAnalytics.js";

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log("PASS  " + name); }
  else { failed += 1; console.log("FAIL  " + name + (detail ? "  => " + detail : "")); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}
function near(name, actual, expected, tol) {
  check(name, Math.abs(num(actual) - num(expected)) <= (tol === undefined ? 1e-6 : tol), `got ${actual} want ~${expected}`);
}

const T0 = 1700000000000;
const mkAdapter = (store) => ({ get: (t, k) => store.generic.get(t, k), all: (t) => store.generic.all(t), put: (t, r) => store.generic.put(t, r), del: (t, k) => store.generic.del(t, k) });

console.log("== A. PORTFOLIO RISK CONTROLLER ==");
{
  const normal = portfolioRisk({ account: { total_equity: 100, initial_balance: 100 }, wallets: {}, positions: [] });
  eq("正常状态 NORMAL 且放行", [normal.risk_level, normal.allow_new_entry, RISK_LEVELS.includes(normal.risk_level)], ["NORMAL", true, true]);
  check("输出字段齐全(Risk 只认这一份)", ["risk_level", "risk_budget_pct", "max_position_size", "max_leverage", "allow_new_entry", "allow_add_position"].every((k) => normal[k] !== undefined));
  const caution = portfolioRisk({ account: { total_equity: 100 }, daily_pnl_pct: -4 });
  eq("当日亏 4% → CAUTION", caution.risk_level, "CAUTION");
  const defensive = portfolioRisk({ account: { total_equity: 100 }, daily_pnl_pct: -7 });
  eq("当日亏 7% → DEFENSIVE", defensive.risk_level, "DEFENSIVE");
  const hard = portfolioRisk({ account: { total_equity: 100 }, daily_pnl_pct: -12 });
  eq("当日亏 12% → HARD_STOP 且禁新开仓", [hard.risk_level, hard.allow_new_entry], ["HARD_STOP", false]);
  check("等级越差风险预算越低(不会直接回到高杠杆)", RISK_THRESHOLDS.risk_budget_pct.NORMAL > RISK_THRESHOLDS.risk_budget_pct.CAUTION && RISK_THRESHOLDS.max_leverage.NORMAL >= RISK_THRESHOLDS.max_leverage.HARD_STOP);
  const dataBad = portfolioRisk({ account: { total_equity: 100 }, integrity: { price_symbol_mismatch: 1 } });
  eq("数据完整性异常 → 禁新开仓(已有仓位不受影响)", dataBad.allow_new_entry, false);
  const dqBad = portfolioRisk({ account: { total_equity: 100 }, data_quality: { ok: false, block_entries: true } });
  eq("数据质量阻断 → 禁新开仓", dqBad.allow_new_entry, false);
  const ddHard = portfolioRisk({ account: { total_equity: 100 }, drawdown: { state: "HARD_STOP", actions: { allow_new_positions: false } } });
  eq("回撤控制器 HARD_STOP 只能收紧", [ddHard.risk_level, ddHard.allow_new_entry], ["HARD_STOP", false]);
  // 历史最深回撤 ≠ 当前回撤:已回到峰值时必须是 NORMAL(否则一次深回撤会永久禁开仓)
  const recoveredFromHistory = portfolioRisk({ account: { total_equity: 130, peak_equity: 130, max_drawdown_pct: 45, initial_balance: 100 }, drawdown_pct: 0 });
  eq("已创新高时 NORMAL(不因历史最深回撤卡死)", [recoveredFromHistory.risk_level, recoveredFromHistory.allow_new_entry], ["NORMAL", true]);
  const inDrawdown = portfolioRisk({ account: { total_equity: 70, peak_equity: 100, initial_balance: 100 }, drawdown_pct: 30 });
  eq("当前回撤 30% → HARD_STOP", inDrawdown.risk_level, "HARD_STOP");
  const exposure = portfolioRisk({ account: { total_equity: 100 }, positions: [{ status: "OPEN", symbol: "BTCUSDT", side: "LONG", remaining_margin: 40, leverage: 1, unrealized_pnl: 0 }] });
  // §67 更新说明:旧断言把"35% 提示阈值"当成"拦截阈值"(exposure_violations)。
  // V16.2v 拆成两级:35% → exposure_warnings(记录集中度,供诊断/UI);100% → exposure_violations(单币爆仓敞口硬闸)。
  // 旧实现把提示当拦截,与"单仓保证金 40% × 2 倍杠杆 = 80% 名义"的政策自相矛盾(意义化仓位一开就被否决)。
  check("单币暴露超提示线被记录(35% 提示级)", exposure.exposure_warnings.some((v) => v.symbol === "BTCUSDT") && exposure.exposure_violations.length === 0, JSON.stringify({ w: exposure.exposure_warnings, v: exposure.exposure_violations }));
  const exposureCap = portfolioRisk({ account: { total_equity: 100 }, positions: [{ status: "OPEN", symbol: "BTCUSDT", side: "LONG", remaining_margin: 60, leverage: 1, unrealized_pnl: 0 }, { status: "OPEN", symbol: "BTCUSDT", side: "LONG", remaining_margin: 45, leverage: 1, unrealized_pnl: 0 }] });
  check("单币暴露超 100% 硬闸被拦截并记录", exposureCap.exposure_violations.some((v) => v.symbol === "BTCUSDT"), JSON.stringify(exposureCap.exposure_violations));
  const veto = riskVetoForCandidate({ symbol: "ETHUSDT", leverage: 8, notional: 50 }, normal);
  check("候选否决:杠杆超上限+超风险预算", !veto.allow && veto.reasons.length >= 2, JSON.stringify(veto));
  const pass = riskVetoForCandidate({ symbol: "ETHUSDT", leverage: 2, notional: 5 }, normal);
  eq("正常候选放行", [pass.allow, pass.reasons.length], [true, 0]);
}

console.log("== B. POSITION MANAGER ==");
{
  const pos = { position_id: "p1", symbol: "BTCUSDT", mode: "short", side: "LONG", direction: "LONG", status: "OPEN", entry_price: 100, current_price: 105, quantity: 1, remaining_quantity: 1, remaining_margin: 10, entry_notional: 10, stop_price: 95 };
  eq("动作集合完整", POSITION_ACTIONS.length, 11);
  eq("退出原因→动作映射", [classifyCloseAction("LIQUIDATION"), classifyCloseAction("stop_loss"), classifyCloseAction("MANUAL_FULL_CLOSE"), classifyCloseAction("partial_take_profit_tp1"), classifyCloseAction("profit_lock_stage2")], ["LIQUIDATION", "STOP", "MANUAL_CLOSE", "TAKE_PROFIT", "TRAIL"]);
  check("OPEN 可继续动作", canAct(pos, "PARTIAL_CLOSE").ok === true);
  check("终态不可再动", canAct({ ...pos, status: "CLOSED" }, "PARTIAL_CLOSE").ok === false);
  check("无剩余数量不能平", canAct({ ...pos, remaining_quantity: 0 }, "FULL_CLOSE").reason === "no_remaining_quantity");
  check("暂停加仓时禁止 ADD", canAct(pos, "ADD", { allow_add_position: false }).reason === "add_not_allowed");
  const tr = transition(pos, "PARTIAL_CLOSE", { action_source: "MANUAL", exit_reason: "MANUAL_PARTIAL_CLOSE", fraction: 0.25, now: T0 });
  eq("迁移成功并留审计", [tr.ok, tr.audit.action, tr.audit.action_source, tr.audit.fraction], [true, "PARTIAL_CLOSE", "MANUAL", 0.25]);
  const stopAdj = adjustStop(pos, 98, { now: T0, manual: true });
  check("止损可收紧", stopAdj.ok && num(stopAdj.position.stop_price) === 98, JSON.stringify(stopAdj.reason || stopAdj.position.stop_price));
  check("禁止把止损放宽", adjustStop(pos, 92, { now: T0 }).reason === "stop_widen_forbidden");
  check("止损不能跑到市价上方(多单)", adjustStop(pos, 110, { now: T0 }).reason === "stop_above_market");
  check("止盈不能低于市价(多单)", adjustTakeProfit(pos, 90, { now: T0 }).reason === "tp_below_market");
  const pm = createPositionManager({ limit: 10 });
  pm.transition(pos, "OPEN", { now: T0 });
  pm.adjustStop(pos, 99, { now: T0 });
  eq("管理器累计审计", [pm.size(), pm.audit({ symbol: "BTCUSDT" }).length], [2, 2]);
  const view = positionManagerView([pos, { ...pos, position_id: "p2", status: "CLOSED" }, { ...pos, position_id: "p3", price_status: "INVALID" }]);
  eq("概览统计", [view.open_count, view.closed_count, view.invalid_count, view.clean], [2, 1, 1, false]);
}

console.log("== C. EXECUTION SIMULATOR ==");
{
  const m = simulateFill({ side: "BUY", quantity: 0.1, reference_price: 100, order_type: "MARKET" });
  check("市价单成交含价差+滑点", m.ok && num(m.fill_price) > 100 && num(m.fee) > 0, JSON.stringify({ p: m.fill_price, f: m.fee }));
  near("滑点=半价差+滑点(4bps)", m.slippage_pct, (PAPER_DEFAULTS.half_spread_bps + PAPER_DEFAULTS.slippage_bps) / 100, 1e-6);
  const lim = simulateFill({ side: "BUY", quantity: 0.1, reference_price: 100, order_type: "LIMIT", limit_price: 99 });
  eq("限价未穿越不成交", [lim.ok, lim.reason], [false, "limit_not_crossed"]);
  const lim2 = simulateFill({ side: "BUY", quantity: 0.1, reference_price: 100, order_type: "LIMIT", limit_price: 100.5 });
  check("限价穿越按限价成交", lim2.ok && num(lim2.fill_price) === 100.5, JSON.stringify(lim2));
  const liq = simulateFill({ side: "SELL", quantity: 0.2, reference_price: 20, order_type: "LIQUIDATION", liquidation_price: 50, position_side: "LONG" });
  near("强平按强平价结算(不允许更差)", liq.reference_price, 50);
  const bad = simulateFill({ side: "BUY", quantity: 0.1, reference_price: 0 });
  eq("0 价被拒绝", [bad.ok, bad.reason], [false, "invalid_reference_price"]);
  const close = closeOrder({ side: "LONG", direction: "LONG", remaining_quantity: 1, current_price: 100, liquidation_price: 50 }, { fraction: 0.25, exit_reason: "manual" });
  eq("平仓单 reduce-only 且数量按比例", [close.ok, close.reduce_only, close.quantity], [true, true, 0.25]);
  eq("开仓单方向由 LONG/SHORT 决定", [openOrder({ direction: "SHORT", notional: 20, reference_price: 100 }).ok], [true]);
  const plan = marginPlan({ notional: 20, leverage: 2, entry_price: 100 });
  eq("保证金/数量推导", [plan.margin, plan.quantity, plan.leverage], [10, 0.2, 2]);
  check("成交报告统一口径", fillReport(m, { exit_reason: "x" }).cost > 0 && fillReport({ ok: false, reason: "r" }).ok === false);
  check("订单类型集合固定", ORDER_TYPES.includes("MARKET") && ORDER_TYPES.includes("LIQUIDATION"));
}

console.log("== D. DATA QUALITY SENTINEL ==");
{
  const okQuote = inspectQuote({ price: 100, symbol: "BTCUSDT", received_at: T0 }, { now: T0, expectSymbol: "BTCUSDT", lastPrice: 100 });
  eq("正常报价通过", [okQuote.ok, okQuote.severity], [true, DQ_SEVERITY.OK]);
  eq("0 价阻断", inspectQuote({ price: 0, symbol: "BTCUSDT" }, { now: T0 }).ok, false);
  eq("NaN 阻断", inspectQuote({ price: NaN }, { now: T0 }).ok, false);
  eq("过期阻断", inspectQuote({ price: 100, received_at: T0 }, { now: T0 + 10 * 60000 }).issues[0].code, "stale_quote");
  eq("provider 串号阻断", inspectQuote({ price: 100, symbol: "ETHUSDT" }, { now: T0, expectSymbol: "BTCUSDT" }).issues[0].code, "provider_symbol_conflict");
  const jump = inspectQuote({ price: 130, symbol: "BTCUSDT", received_at: T0 }, { now: T0, expectSymbol: "BTCUSDT", lastPrice: 100, lastPriceAt: T0 });
  eq("异常跳变(新鲜上次价)阻断", jump.ok, false);
  const jumpStale = inspectQuote({ price: 130, symbol: "BTCUSDT", received_at: T0 }, { now: T0, expectSymbol: "BTCUSDT", lastPrice: 100, lastPriceAt: T0 - 3600000 });
  eq("上次价过期时跳变只提示不阻断", [jumpStale.ok, jumpStale.severity], [true, DQ_SEVERITY.WARN]);
  const candles = inspectCandles([[T0, 100, 110, 90, 105], [T0, 100, 110, 90, 105]], { intervalMs: 3600000 });
  check("重复K线被识别", candles.issues.some((i) => i.code === "duplicate_candle"), JSON.stringify(candles.issues.map((i) => i.code)));
  const disorder = inspectCandles([[T0, 1, 2, 0.5, 1], [T0 - 3600000, 1, 2, 0.5, 1]], { intervalMs: 3600000 });
  check("乱序K线被识别", disorder.issues.some((i) => i.code === "timestamp_disorder"));
  eq("空K线阻断", inspectCandles([], {}).issues[0].code, "missing_candle");
  check("非数字价格被识别", inspectCandles([[T0, 0, 0, 0, 0]], {}).issues.some((i) => i.code === "candle_zero_or_nan_price"));
  const ext = inspectExternal([{ key: "k", at: T0, source: "unavailable", error: "http_500" }], { now: T0 });
  check("外部情报不可用只提示(不阻断交易)", ext.ok === true && ext.issues[0].code === "external_unavailable");
  const sentinel = createDataQualitySentinel({ now: () => T0 });
  sentinel.checkQuote({ price: 100, symbol: "BTCUSDT", received_at: T0 }, { expectSymbol: "BTCUSDT" });
  eq("哨兵状态正常", [sentinel.state().ok, sentinel.state().block_entries], [true, false]);
  sentinel.checkQuote({ price: 0, symbol: "BTCUSDT" }, { expectSymbol: "BTCUSDT" });
  eq("哨兵阻断新开仓", [sentinel.state().block_entries, sentinel.summaryText().includes("暂停新开仓")], [true, true]);
  check("哨兵保留问题清单", sentinel.state().recent_issues.length >= 1);
}

console.log("== E. BACKGROUND TASK MANAGER ==");
{
  const timers = [];
  const tm = createTaskManager({
    now: () => T0,
    setInterval: (fn, ms) => { const id = { fn, ms }; timers.push(id); return id; },
    clearInterval: (id) => { const i = timers.indexOf(id); if (i >= 0) timers.splice(i, 1); }
  });
  tm.register("paper-loop", { intervalMs: 300000, critical: true, run: async () => "loop" });
  tm.register("position-risk", { intervalMs: 20000, critical: true, run: async () => "risk" });
  tm.register("flaky", { intervalMs: 1000, maxRetries: 2, run: async () => { throw new Error("boom"); } });
  eq("注册后状态可见", tm.status("paper-loop").state, "IDLE");
  const r1 = await tm.runOnce("paper-loop");
  eq("运行成功记录", [r1.ok, tm.status("paper-loop").state, tm.status("paper-loop").runs], [true, "OK", 1]);
  const r2 = await tm.runOnce("flaky");
  eq("错误被捕获且不抛出到调用方", [r2.ok, r2.reason, tm.status("flaky").errors, tm.status("flaky").state], [false, "task_error", 1, "ERROR"]);
  await tm.runOnce("flaky");
  const r3 = await tm.runOnce("flaky");
  eq("超过重试上限后停止(不无限重试)", [r3.reason, tm.status("flaky").retry_count], ["retry_exhausted", 2]);
  tm.startAll();
  eq("启动所有任务(定时器数量)", timers.length, 3);
  eq("健康摘要能定位异常任务", tm.health().ok, false);
  tm.stopAll();
  eq("全部停止", timers.length, 0);
  const st = tm.status();
  check("状态包含 last_run/next_run/error/retry", st.every((t) => "last_run_at" in t && "next_run_at" in t && "last_error" in t && "retry_count" in t));
  eq("统计口径", [tm.stats().total, tm.stats().runs >= 1, tm.stats().errors], [3, true, 2]);
  check("任务状态集合固定", TASK_STATES.includes("ERROR") && TASK_STATES.includes("STOPPED"));
}

console.log("== F. NOTIFICATION MANAGER ==");
{
  const ntf = createNotificationCenter({ now: () => T0, dedup_window_ms: 60000 });
  const a = ntf.push("TRADE", "开仓 BTC", "多 2x", { key: "open|1" });
  const b = ntf.push("TRADE", "开仓 BTC", "多 2x", { key: "open|1" });
  eq("同 key 去重", [a.added, b.added, b.reason], [true, false, "deduped"]);
  const c = ntf.push("RISK", "强平", "净-4.5", { key: "open|1", severity: "high" });
  eq("不同渠道不受同 key 影响", c.added, true);
  const always = ntf.push("TRADE", "平仓", "净+1", { key: "open|1", always: true });
  eq("关键事件可绕过去重", always.added, true);
  eq("六类渠道齐全", NOTIFY_CHANNELS.length, 6);
  check("Android 渠道映射存在", NOTIFY_CHANNELS.every((k) => Boolean(ANDROID_CHANNEL_MAP[k])));
  const withCooldown = createNotificationCenter({ now: () => T0, default_cooldown_ms: 30000 });
  withCooldown.push("RISK", "风险", "x", { key: "r1" });
  const cooled = withCooldown.push("RISK", "风险", "x", { key: "r1" });
  eq("冷却期内的重复被抑制", [cooled.added, cooled.reason], [false, "cooldown"]);
  ntf.setChannelEnabled("MARKET", false);
  eq("渠道可关闭", ntf.push("MARKET", "行情", "x").added, false);
  ntf.setChannelEnabled("MARKET", true);
  const unread = ntf.unreadCount();
  ntf.markAllRead();
  eq("已读状态可维护", [unread > 0, ntf.unreadCount()], [true, 0]);
  const d = notificationDigest(ntf);
  check("摘要含分类与未读", d.total >= 3 && "TRADE" in d.by_kind, JSON.stringify(d));
  const native = ntf.nativePushQueue({ since: 0 });
  check("原生推送队列只取高优先级", native.every((n) => n.channel === ANDROID_CHANNEL_MAP.RISK), JSON.stringify(native));
}

console.log("== G. DECISION JOURNAL ==");
{
  const journal = createDecisionJournal({ now: () => T0 });
  const e1 = journal.record({ kind: "ENTRY", symbol: "BTCUSDT", mode: "short", why: "规则看多 + 预测一致", rule: { direction: "Bullish", confidence: 72 }, ml: { version: "champ-v3", probability: 0.61, used: true }, prediction: { direction: "Bullish", probability: 0.58, horizon: "1h" }, risk: { risk_level: "NORMAL" }, deepseek: { used: true, direction: "Bullish" }, final: { action: "OPEN", leverage: 2, size: 10 } });
  check("记录含可复查证据", e1.evidence.length >= 3 && e1.id.startsWith("dj_"), JSON.stringify(e1.evidence));
  journal.record({ kind: "EXIT", symbol: "BTCUSDT", mode: "short", why: "stop_loss(全部平仓) · 净-1.2U", final: { action: "STOP", exit_reason: "stop_loss" } });
  journal.record({ kind: "ENTRY_BLOCKED", symbol: "ETHUSDT", why: "组合风控否决:drawdown_caution", final: { action: "SKIP" } });
  eq("按 symbol 过滤", journal.list({ symbol: "BTCUSDT" }).length, 2);
  eq("按类型过滤", journal.list({ kind: "ENTRY_BLOCKED" }).length, 1);
  const text = journal.whyText("BTCUSDT");
  check("能回答’为什么卖 BTC’", text.includes("平仓") && text.includes("stop_loss"), text.slice(0, 80));
  const summary = journal.summary();
  eq("汇总计数", [summary.total, summary.by_kind.ENTRY, summary.by_kind.EXIT], [3, 1, 1]);
  const ctx = journalContextForChat(journal, "刚才为什么卖 BTC?", { symbols: ["BTCUSDT"] });
  check("聊天上下文按问题定位 symbol", Array.isArray(ctx) && ctx.length >= 1 && ctx[0].kind === "EXIT", JSON.stringify(ctx));
  eq("无效类型回退为 ENTRY", decisionEntry({ kind: "NOPE", symbol: "X" }).kind, "ENTRY");
}

console.log("== H. CRASH RECOVERY ==");
{
  const clean = recoveryPlan({ account: { cash_balance: 100, reserved_balance: 0, total_equity: 100, unrealized_pnl: 0 }, wallets: { short: { available_balance: 70, reserved_balance: 0, allocated_balance: 70 } }, positions: [], orders: [], engine_state: { state: "STOPPED" }, now: T0 });
  eq("干净状态无动作", [clean.ok, clean.action_count, clean.report_text.includes("自洽")], [true, 0, true]);
  const dirty = recoveryPlan({
    account: { cash_balance: 90, reserved_balance: 0, total_equity: 90, unrealized_pnl: -30 },
    wallets: { short: { available_balance: 60, reserved_balance: 0, allocated_balance: 60 } },
    positions: [{ position_id: "p1", symbol: "BNBUSDT", side: "SHORT", status: "OPEN", entry_price: 764, current_price: 2712, remaining_quantity: 0.01, remaining_margin: 4.5, entry_notional: 4.5, unrealized_pnl: -22.94, liquidation_price: 1142 }],
    orders: [{ order_id: "o1", symbol: "BTCUSDT", status: "NEW", created_at: T0 - 3600000 }],
    sync_queue: [{ item_id: "s1", sync_status: "PENDING" }],
    engine_state: { state: "RUNNING" },
    now: T0
  });
  check("脏状态产出动作清单", dirty.action_count >= 4, JSON.stringify(dirty.actions.map((a) => a.action)));
  check("识别不可能亏损并要求强平", dirty.actions.some((a) => a.action === "FORCE_LIQUIDATION"), JSON.stringify(dirty.actions));
  check("识别残留订单", dirty.actions.some((a) => a.action === "DROP_STALE_ORDER"));
  check("识别半途同步", dirty.actions.some((a) => a.action === "REPLAY_PENDING_SYNC"));
  check("识别引擎状态残留", dirty.actions.some((a) => a.action === "RESET_ENGINE_STATE"));
  eq("有必须先处置的动作 → 暂缓新开仓", dirty.allow_new_entry_after, false);
  check("动作集合声明完整", ["RECONCILE_RESERVED", "FORCE_LIQUIDATION", "RESET_ENGINE_STATE"].every((a) => RECOVERY_ACTIONS.includes(a)));
  const view = recoveryView(dirty);
  eq("UI 视图给出结论与严重项", [view.ok, view.critical >= 1, typeof view.label], [false, true, "string"]);
}

console.log("== I. EQUITY ANALYTICS ==");
{
  const day = 86400000;
  const curve = [{ at: T0 - 30 * day, equity: 100 }, { at: T0 - 20 * day, equity: 120 }, { at: T0 - 10 * day, equity: 90 }, { at: T0 - day, equity: 130 }, { at: T0, equity: 110 }];
  const s24 = equitySeries(curve, { now: T0, windowMs: day * 1.2, fallback: 100 });
  check("24h 窗口净值曲线", s24.point_count >= 1 && s24.spark.length >= 2, JSON.stringify(s24.spark));
  const stats = equityStats({
    equity_curve: curve,
    trades: [
      { net_pnl: 10, fees: 0.4, exit_reason: "take_profit", exit_time: T0 - 3600000 },
      { net_pnl: -5, fees: 0.2, exit_reason: "stop_loss", exit_time: T0 - 7200000 },
      { net_pnl: -4.5, fees: 0.3, exit_reason: "LIQUIDATION", exit_time: T0 - 10800000 }
    ],
    now: T0,
    equity: 110,
    initial_equity: 100
  });
  check("净值指标齐全", ["net_return_pct", "max_drawdown_pct", "profit_factor", "fees", "liquidations", "recovery_ms"].every((k) => k in stats));
  eq("强平次数统计", stats.liquidations, 1);
  eq("盈亏比 = 总盈利 / 总亏损", stats.profit_factor, round(10 / 9.5, 4));
  check("三窗口都在", stats.windows.h24 && stats.windows.d7 && stats.windows.d30);
  const rec = recoveryTimeMs(curve, { now: T0 });
  check("回撤修复时间可用(有回撤且未回到峰值 → 进行中)", typeof rec.ongoing === "boolean");
  const head = equityHeadline(stats);
  check("首页文案可直接用", head.headline.includes("%") && head.sub.includes("回撤"), JSON.stringify(head));
}

console.log("== J. ENGINE 接线(模块必须真的被用上) ==");
{
  const store = await createHistoryStore({ memory: true });
  const clock = { t: T0 };
  const eng = createPaperEngine({
    store: mkAdapter(store),
    now: () => clock.t,
    riskCheck: () => ({ veto: false, risk_score: 20 }),
    fetchKlines: async () => []
  });
  await eng.init();
  const opened = await eng.openPosition({
    mode: "short", symbol: "BTCUSDT", direction: "Bullish", signal_timestamp: T0,
    quote: { price: 100, received_at: T0 },
    analysis: { direction: "Bullish", confidence: 70, volatility: { atrPct: 1 }, market_regime: { label: "Weak Uptrend" } },
    leverage: 2
  });
  check("开仓成功", opened.ok, JSON.stringify(opened.reason));
  const risk = eng.currentRisk();
  check("引擎暴露统一风险结论", RISK_LEVELS.includes(risk.risk_level) && typeof risk.allow_new_entry === "boolean");
  const journalEntries = eng.journal({ symbol: "BTCUSDT" });
  eq("开仓写入决策日志(为什么开)", [journalEntries.length >= 1, journalEntries[0].kind], [true, "ENTRY"]);
  check("决策日志带杠杆与依据", journalEntries[0].final.leverage === 2 && journalEntries[0].evidence.length >= 1, JSON.stringify(journalEntries[0]));
  check("持仓审计记录 OPEN", eng.positionAudit({ symbol: "BTCUSDT" }).some((a) => a.action === "OPEN"));
  const adj = await eng.adjustStop({ position_id: opened.position.position_id, stop_price: num(opened.position.stop_price) + 0.5 });
  check("手动调止损走 PositionManager 并落审计", adj.ok && eng.positionAudit({ limit: 5 }).some((a) => a.action === "TRAIL"), JSON.stringify(adj.reason || adj.audit));
  check("调整失败有明确原因(放宽被拒)", (await eng.adjustStop({ position_id: opened.position.position_id, stop_price: 90 })).reason === "stop_widen_forbidden");
  const adjTp = await eng.adjustTakeProfit({ position_id: opened.position.position_id, take_profit_price: 130 });
  check("手动调止盈生效", adjTp.ok && num(adjTp.position.take_profit_price) === 130, JSON.stringify(adjTp.reason));
  const dq = eng.dataQuality();
  check("引擎暴露数据质量状态", typeof dq.ok === "boolean" && Array.isArray(dq.recent_issues));
  check("数据质量摘要文案可用", /行情数据/.test(eng.dataQualitySummary()), eng.dataQualitySummary());
  const notif = eng.notifications();
  check("通知中心接管通道策略", Array.isArray(notif) && eng.notifyChannels().length === 6, JSON.stringify(eng.notifyChannels().length));
  check("通知摘要可用", eng.notificationDigest().total >= 1);
  check("决策日志可被聊天读取", typeof eng.journalContextForChat("刚才为什么开 BTCUSDT?", { symbols: ["BTCUSDT"] }) === "object");
  const beforeStatus = eng.getPositions()[0].price_status;
  await eng.riskPass({ quotes: { BTCUSDT: { symbol: "ETHUSDT", price: 999, received_at: T0 } } });
  check("串价被数据质量/符号守卫拦下", eng.getPositions()[0].price_status === "INVALID" && eng.getIntegrity().price_symbol_mismatch >= 1, JSON.stringify({ before: beforeStatus, after: eng.getPositions()[0].price_status }));
  check("串价即暂停新开仓", eng.getIntegrity().entries_paused === true);
  const closed = await eng.closePosition(eng.getPositions()[0], { reference_price: 100, exit_reason: "manual", fraction: 1, manual: true });
  check("平仓成功且带成交报告", closed.ok && closed.trade.execution && closed.trade.execution.source === "manual", JSON.stringify(closed.trade && closed.trade.execution));
  const exitJournal = eng.journal({ symbol: "BTCUSDT", kind: "EXIT" });
  eq("平仓写入决策日志(为什么平)", [exitJournal.length >= 1, exitJournal[0].final.exit_reason], [true, "manual"]);
  check("成交报告含费用与滑点", closed.trade.execution.fee > 0 && Number.isFinite(closed.trade.execution.slippage_pct));
  check("账户不变量仍通过", eng.accountIntegrity().ok, JSON.stringify(eng.accountIntegrity()));
  check("持仓概览可用", eng.positionOverview().open_count === 0 && eng.positionOverview().closed_count >= 1, JSON.stringify(eng.positionOverview()));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("MODULE EXPANSION OK");
