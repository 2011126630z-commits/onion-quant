// tools/test-v15.mjs · V15 手动平仓 / 通知 / 暂停开仓 / 重启恢复 / 精度(§18-§38, §80-§83, §102-§115)
import fs from "node:fs";
import path from "node:path";
import { createPaperEngine } from "../worker/src/paper/engine.js";
import { createHistoryStore } from "../worker/src/history/store.js";
import { num, summarizeTrades } from "../worker/src/paper/accounting.js";
import { positionView, fmtUsdtExact, pnlLabel, pnlClass } from "../worker/src/ui/viewModels.js";

const ROOT = path.resolve(import.meta.dirname, "..");
let failed = 0;
let passed = 0;
const check = (n, ok, d) => { if (ok) { passed += 1; console.log("PASS  " + n); } else { failed += 1; console.log("FAIL  " + n + (d ? "  => " + d : "")); } };
const eq = (n, a, b) => check(n, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const near = (n, a, b, t) => check(n, Math.abs(a - b) <= (t == null ? 1e-9 : t), `got ${a} want ~${b}`);
const T0 = 1700000000000;
const HOUR = 3600000;
const pageSrc = fs.readFileSync(path.join(ROOT, "worker/src/ui/page.js"), "utf8");

async function mk(opts) {
  const o = opts || {};
  const clock = { value: T0 };
  const store = o.store || await createHistoryStore({ memory: true });
  const adapter = { get: (t, k) => store.generic.get(t, k), all: (t, l) => store.generic.all(t, l), put: (t, r) => store.generic.put(t, r) };
  const eng = createPaperEngine({
    store: adapter, now: () => clock.value, fetchKlines: async () => [],
    riskCheck: () => ({ veto: false, risk_score: 25, risk_flags: [], reasons: [] }),
    profitLock: o.profitLock ? { trendStrength: 0.5, reversalRisk: 0.4, persistShadow: false } : undefined
  });
  await eng.init();
  await eng.start();
  return { eng, clock, store, adapter };
}
async function openOne(eng, clock, mode) {
  clock.value += HOUR;
  const price = 100;
  await eng.loop({
    quotes: { BTCUSDT: { price, high: price * 1.01, low: price * 0.99, received_at: clock.value } },
    candidates: [{
      mode: mode || "short", symbol: "BTCUSDT", direction: "Bullish",
      signal_timestamp: clock.value - 1, closed_candle_time: clock.value - 1,
      quote: { price, received_at: clock.value },
      analysis: { direction: "Strong Bullish", signal_strength: 70, confidence: 60, volatility: { atrPct: 2 }, market_regime: { label: "Uptrend", trend_market: true }, structure: { last_swing_low: 95 } },
      riskPct: 15
    }],
    atr: 2
  });
  return eng.getPositions().find((p) => p.status === "OPEN");
}

console.log("== A. 手动平仓(§18-§24/§102) ==");
{
  const { eng, clock } = await mk();
  const pos = await openOne(eng, clock);
  check("开仓成功", Boolean(pos), "no position");
  const margin0 = num(pos.entry_notional);
  const qty0 = num(pos.remaining_quantity);
  // 25%
  clock.value += HOUR;
  const c25 = await eng.manualClose({ position_id: pos.position_id, fraction: 0.25, price: 102 });
  check("手动 25% 平仓成功", c25.ok === true, JSON.stringify(c25).slice(0, 120));
  eq("退出原因 = MANUAL_PARTIAL_CLOSE", c25.exit_reason, "MANUAL_PARTIAL_CLOSE");
  eq("标记手动来源", c25.action_source, "MANUAL");
  const p1 = eng.getPositions().find((p) => p.position_id === pos.position_id);
  near("剩余数量 = 75%", num(p1.remaining_quantity), qty0 * 0.75, 1e-9);
  near("释放保证金 = 25%", margin0 - num(p1.entry_notional), margin0 * 0.25, 1e-6);
  check("已实现盈亏 > 0(盈利平仓)", num(p1.realized_pnl) > 0, String(p1.realized_pnl));
  eq("部分成交标记 action_source=MANUAL", eng.getTrades()[0].action_source, "MANUAL");
  // 50%
  clock.value += HOUR;
  const c50 = await eng.manualClose({ position_id: pos.position_id, fraction: 0.5, price: 103 });
  check("手动 50% 平仓成功", c50.ok === true, JSON.stringify(c50).slice(0, 120));
  const p2 = eng.getPositions().find((p) => p.position_id === pos.position_id);
  near("再平 50% 后剩余 37.5%", num(p2.remaining_quantity), qty0 * 0.375, 1e-9);
  // 全平
  clock.value += HOUR;
  const cFull = await eng.manualClose({ position_id: pos.position_id, fraction: 1, price: 99 });
  check("手动全部平仓成功", cFull.ok === true, JSON.stringify(cFull).slice(0, 120));
  eq("退出原因 = MANUAL_FULL_CLOSE", cFull.exit_reason, "MANUAL_FULL_CLOSE");
  const closed = eng.getPositions().find((p) => p.position_id === pos.position_id);
  eq("持仓已关闭", closed.status, "CLOSED");
  eq("剩余数量为 0", num(closed.remaining_quantity), 0);
  eq("钱包 reserved 归零", num(eng.engine.wallets.short.reserved_balance), 0);
  // 会计恒等式(手动操作也必须成立)
  const snap = eng.snapshot(() => 99);
  const openFees = snap.positions.reduce((a, p) => a + num(p.fees, 0), 0);
  const openUnreal = snap.positions.reduce((a, p) => a + num(p.unrealized_pnl, 0), 0);
  const identity = num(snap.account.initial_balance) + num(snap.account.realized_pnl) - openFees + openUnreal;
  check("手动平仓后会计恒等式精确", Math.abs(num(snap.account.total_equity) - identity) < 1e-6, JSON.stringify({ eq: snap.account.total_equity, identity }));
  const st = summarizeTrades(eng.getTrades());
  eq("3 笔成交被记录", st.trades, 3);
  // §21:必须扣手续费与滑点(净 < 毛)
  check("净盈亏已扣手续费", eng.getTrades().every((t) => num(t.fees) > 0 && num(t.net_pnl) < num(t.gross_pnl)), JSON.stringify(eng.getTrades().map((t) => [num(t.gross_pnl), num(t.net_pnl)])));
  // §20:超额平仓防护
  const over = await eng.manualClose({ position_id: pos.position_id, fraction: 0.5, price: 100 });
  eq("对已关闭持仓再平仓被拒", over.ok, false);
  eq("拒绝原因可追溯", over.reason, "not_open");
  const notFound = await eng.manualClose({ position_id: "nope", fraction: 0.1 });
  eq("不存在的持仓被拒", notFound.reason, "position_not_found");
  // §22:UI 不允许直接删持仓(结构断言)
  check("页面手动平仓走引擎 API(不直接删)", /eng\.manualClose\(/.test(pageSrc) && !/positions\.splice|delete .*position/.test(pageSrc));
  check("平仓比例含 10/25/50/75/100 与自定义", /\[0\.1, 0\.25, 0\.5, 0\.75, 1\]/.test(pageSrc) && /自定义%/.test(pageSrc));
  // §115:防重复点击
  check("确认按钮有 busy 防重入", /if \(closeBusy\) return;/.test(pageSrc) && /closeBusy = true/.test(pageSrc));
}

console.log("== B. 紧急全平 / 暂停开仓 / 重置(§26/§27/§80) ==");
{
  const { eng, clock } = await mk();
  await openOne(eng, clock);
  clock.value += HOUR;
  await openOne(eng, clock, "long");
  eq("两个仓位就绪", eng.getPositions().filter((p) => p.status === "OPEN").length, 2);
  const em = await eng.emergencyCloseAll({ priceOf: () => 101, now: clock.value });
  eq("紧急全平关闭 2 个仓位", em.closed, 2);
  eq("全部持仓已关闭", eng.getPositions().filter((p) => p.status === "OPEN").length, 0);
  check("紧急平仓退出原因正确", eng.getTrades().every((t) => t.exit_reason === "EMERGENCY_CLOSE"), JSON.stringify(eng.getTrades().map((t) => t.exit_reason)));
  // 暂停新开仓:现有仓位继续管理,但不允许新 Entry
  const { eng: eng2, clock: clock2 } = await mk();
  const p = await openOne(eng2, clock2);
  eng2.pauseEntries("测试");
  eq("暂停状态已标记", eng2.engine.entriesPaused, true);
  clock2.value += HOUR;
  const r = await eng2.loop({
    quotes: { BTCUSDT: { price: 100, high: 101, low: 99, received_at: clock2.value } },
    candidates: [{ mode: "short", symbol: "ETHUSDT", direction: "Bullish", signal_timestamp: clock2.value - 1, quote: { price: 100, received_at: clock2.value }, analysis: { direction: "Strong Bullish", signal_strength: 70, volatility: { atrPct: 2 }, market_regime: { label: "Uptrend" }, structure: { last_swing_low: 95 } }, riskPct: 15 }],
    atr: 2
  });
  eq("暂停期间不开新仓", r.summary.opened.length, 0);
  check("跳过原因 = entries_paused", r.summary.skipped.some((s) => s.reason === "entries_paused"), JSON.stringify(r.summary.skipped));
  eq("现有仓位仍在(未被牵连)", eng2.getPositions().filter((x) => x.status === "OPEN").length, 1);
  void p;
  eng2.resumeEntries();
  clock2.value += HOUR;
  const r2 = await eng2.loop({
    quotes: { ETHUSDT: { price: 100, high: 101, low: 99, received_at: clock2.value } },
    candidates: [{ mode: "short", symbol: "ETHUSDT", direction: "Bullish", signal_timestamp: clock2.value - 1, quote: { price: 100, received_at: clock2.value }, analysis: { direction: "Strong Bullish", signal_strength: 70, volatility: { atrPct: 2 }, market_regime: { label: "Uptrend" }, structure: { last_swing_low: 95 } }, riskPct: 15 }],
    atr: 2
  });
  eq("恢复后可开新仓", r2.summary.opened.length, 1);
  // 重置账户:必须二次确认
  const { eng: eng3, clock: clock3 } = await mk();
  await openOne(eng3, clock3);
  const noConfirm = await eng3.resetPaperAccount({});
  eq("未确认时拒绝重置", [noConfirm.ok, noConfirm.reason], [false, "confirm_required"]);
  eq("拒绝后持仓仍在", eng3.getPositions().filter((x) => x.status === "OPEN").length, 1);
  const reset = await eng3.resetPaperAccount({ confirm: true, now: clock3.value });
  eq("确认后重置成功", reset.ok, true);
  eq("重置后为 100 / 70 / 30", [num(reset.account.initial_balance), num(reset.wallets.short.allocated_balance), num(reset.wallets.long.allocated_balance)], [100, 70, 30]);
  eq("重置后无持仓无成交", [eng3.getPositions().length, eng3.getTrades().length], [0, 0]);
  check("重置需要二次确认(结构)", /再次确认:重置后无法撤销/.test(pageSrc));
}

console.log("== C. 通知中心(§28-§38) ==");
{
  const { eng, clock } = await mk();
  const pos = await openOne(eng, clock);
  const list1 = eng.getNotifications({ limit: 20 });
  check("开仓产生通知", list1.items.some((n) => n.kind === "TRADE" && /新模拟开仓/.test(n.title)), JSON.stringify(list1.items.map((n) => n.title)));
  check("通知含金额摘要(§29)", list1.items.some((n) => /保证金 .*U/.test(n.body)), JSON.stringify(list1.items.map((n) => n.body)));
  clock.value += HOUR;
  await eng.manualClose({ position_id: pos.position_id, fraction: 1, price: 102 });
  const list2 = eng.getNotifications({ limit: 20 });
  check("平仓产生通知且带净收益(§30)", list2.items.some((n) => /手动全部平仓/.test(n.title) && /净收益|净亏损/.test(n.body)), JSON.stringify(list2.items.slice(0, 2).map((n) => n.title + "|" + n.body)));
  check("未读数可统计", list2.unread > 0, String(list2.unread));
  const marked = eng.markNotificationsRead([]);
  eq("全部标记已读", marked.unread, 0);
  // §38:同一事件不重复 + 冷却
  const before = eng.getNotifications({ limit: 99 }).total;
  eng.notify("RISK", "回撤状态变化 → CAUTION", "账户回撤 3.2%", { key: "drawdown|CAUTION", cooldownMs: 600000 });
  eng.notify("RISK", "回撤状态变化 → CAUTION", "账户回撤 3.4%", { key: "drawdown|CAUTION", cooldownMs: 600000 });
  eq("冷却期内同 key 只通知一次", eng.getNotifications({ limit: 99 }).total - before, 1);
  // 不同 key 不互相影响
  eng.notify("SYSTEM", "网络恢复", "行情源可用", { key: "net|ok" });
  check("不同事件独立计数", eng.getNotifications({ limit: 99 }).total - before >= 2, String(eng.getNotifications({ limit: 99 }).total - before));
  // 强事件(always)允许重复
  const b2 = eng.getNotifications({ limit: 99 }).total;
  eng.notify("TRADE", "同一笔平仓", "x", { key: "always|k", always: true });
  eng.notify("TRADE", "同一笔平仓", "x", { key: "always|k", always: true });
  eq("always 事件允许重复(平仓类不强压)", eng.getNotifications({ limit: 99 }).total - b2, 2);
  // 上限有界
  for (let i = 0; i < 400; i += 1) eng.notify("SYSTEM", "n" + i, "", { key: "k" + i });
  check("通知列表有界(≤300)", eng.getNotifications({ limit: 999 }).total <= 300, String(eng.getNotifications({ limit: 999 }).total));
  // §33/§34:学习与消息按重要度
  eng.notify("LEARNING", "新 Champion 上线", "logreg-v2", { key: "champ|logreg-v2", severity: "info" });
  check("学习类重要事件可通知", eng.getNotifications({ limit: 999 }).items.some((n) => n.kind === "LEARNING"));
  // 结构:通知中心 UI + 设置开关 + 默认只开必要
  for (const id of ["ntfSheet", "ntfBody", "ntfBadge", "ntfReadBtn", "ntfSetTrade", "ntfSetClose", "ntfSetRisk", "ntfSetSystem", "ntfSetNews", "ntfSetModel"]) {
    check("通知 UI 元素 " + id, pageSrc.includes('id="' + id + '"'));
  }
  check("默认只开必要三类以上", /return kind === "TRADE" \|\| kind === "RISK" \|\| kind === "SYSTEM" \|\| kind === "RESEARCH"/.test(pageSrc));
  check("通知按类型过滤(设置可关)", /function ntfEnabled\(kind\)/.test(pageSrc));
}

console.log("== D. 重启恢复 / 崩溃恢复(§83) ==");
{
  const store = await createHistoryStore({ memory: true });
  const a = await mk({ store });
  const pos = await openOne(a.eng, a.clock);
  const equityBefore = num(a.eng.snapshot().account.total_equity);
  const tradesBefore = a.eng.getTrades().length;
  // 模拟 App 重开:同一个 store 重新建引擎
  const b = await mk({ store });
  eq("重启后账户资金保留", num(b.eng.getAccount().initial_balance), 100);
  eq("重启后持仓恢复", b.eng.getPositions().filter((p) => p.status === "OPEN").length, 1);
  eq("重启后持仓 ID 一致", b.eng.getPositions().find((p) => p.status === "OPEN").position_id, pos.position_id);
  eq("重启后钱包分配保留(70/30)", [num(b.eng.engine.wallets.short.allocated_balance) > 60, num(b.eng.engine.wallets.long.allocated_balance) > 20], [true, true]);
  eq("重启后成交记录保留", b.eng.getTrades().length, tradesBefore);
  check("重启后净值连续(不重置)", Math.abs(num(b.eng.snapshot().account.total_equity) - equityBefore) < 1, JSON.stringify([equityBefore, num(b.eng.snapshot().account.total_equity)]));
  eq("重启后引擎状态为 RUNNING(本用例显式 start 过)", b.eng.getState(), "RUNNING");
  // 仅 init 不 start 时必须是 STOPPED(不允许自动下单)
  const c = await (async () => {
    const store2 = await createHistoryStore({ memory: true });
    const eng4 = createPaperEngine({ store: { get: (x, k) => store2.generic.get(x, k), all: (x) => store2.generic.all(x), put: (x, r) => store2.generic.put(x, r) }, now: () => T0, fetchKlines: async () => [], riskCheck: () => ({ veto: false }) });
    await eng4.init();
    return eng4;
  })();
  eq("仅初始化(未启动)时为 STOPPED,不会自动交易", c.getState(), "STOPPED");
}

console.log("== E. Position ViewModel 与精度(§14-§17/§102) ==");
{
  eq("小额亏损 4 位", fmtUsdtExact(-0.0047), "-0.0047 USDT");
  eq("标签只由数值决定", [pnlLabel(-0.0047), pnlLabel(0.0047), pnlLabel(0)], ["浮亏", "浮盈", "浮动盈亏"]);
  eq("颜色只由数值决定", [pnlClass(-0.0047), pnlClass(0.0047), pnlClass(0)], ["red", "green", "gray"]);
  const v = positionView({
    position_id: "p", symbol: "BTCUSDT", mode: "short", side: "LONG", status: "OPEN", strategy_mode: "SHORT_TERM",
    entry_price: 65420, avg_entry_price: 65420, current_price: 64880, mark_price: 64890,
    quantity: 0.0004885, initial_quantity: 0.0004885, remaining_quantity: 0.0004885,
    entry_notional: 8, remaining_margin: 8, notional: 32, leverage: 4,
    requested_leverage: 4, approved_leverage: 4, actual_leverage: 4, liquidation_price: 49200,
    unrealized_pnl: -0.83, realized_pnl: 0, partial_close_count: 0, entry_time: T0,
    stop_price: 63000, take_profit_price: 67000, trailing_state: null
  }, { now: T0 + 37 * 60000 });
  eq("§14 关键字段齐全", [v.display, v.side, v.leverage_text, v.margin_text, v.notional_text, v.liquidation_text, v.pnl_text, v.pnl_label, v.holding_time].slice(0, 8), ["BTC/USDT", "做多", "AUTO · 4x", "8.00 USDT", "32.00 USDT", "49200.00", "-0.83 USDT", "浮亏"].slice(0, 8));
  check("持仓时间格式化", /分钟/.test(v.holding_time), v.holding_time);
  eq("剩余仓位 100%", v.remaining_pct_text, "100%");
  eq("PnL 百分比按保证金口径", v.pnl_pct_text, "-10.38%");
}

console.log("== F. 其他 UI 完整性(§76/§77/§81/§82) ==");
{
  for (const id of ["pfPauseEntriesBtn", "pfEmergencyBtn", "pfExportBtn", "openNotifications", "openSysStatus", "resetPaperBtn", "closeSheet", "closeConfirmBtn", "closeFractions", "offlineBar", "toastBox"]) {
    check("UI 元素 " + id, pageSrc.includes('id="' + id + '"'));
  }
  check("按钮忙碌反馈 helper", /async function withBusy\(btn, fn, okText\)/.test(pageSrc));
  check("离线状态条", /function initNetworkBar/.test(pageSrc) && /offline-bar/.test(pageSrc));
  check("空态文案(无持仓/无成交/无通知)", /当前没有模拟持仓/.test(pageSrc) && /还没有模拟成交/.test(pageSrc) && /还没有提醒/.test(pageSrc));
  check("导出 CSV/JSON", /function exportPaperRecords\(format\)/.test(pageSrc) && /paper-trades_/.test(pageSrc));
  check("系统状态简洁(正常/异常)", /function renderSysStatus/.test(pageSrc) && /vTable\(\["项目", "状态"\]/.test(pageSrc));
  check("紧急全平有二次确认", /再次确认:此操作不可撤销/.test(pageSrc));
  check("§111 技术细节收进高级工具", /技术细节\(上游耗时\/熔断\/漂移指标\)在「开发工具/.test(pageSrc));
  check("§78 交易动作不提供撤销", !/undo|撤销上次|恢复已平仓/i.test(pageSrc));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("V15 TESTS OK");
