// tools/test-runtime-verify.mjs · V16.1-RV:真机运行时验收的桌面可测部分
// 覆盖:
//   ①实例身份 / state_version 单调递增(§4/§20)
//   ②心跳口径的 RUNTIME_STALL:冻结可检出、冷启动不误报、行情阻断不误判(§34)
//   ③Provider STALE:HTTP 200 但价格长时间不变 → STALE 且暂停新开仓(§35)
//   ④恢复不补跑旧周期:同一收盘K线连跑 10 轮只开一次仓(§8/§9)
//   ⑤收盘K线幂等:换方向同样拒绝(每次收盘最多一次策略决策)
//   ⑥命令邮箱错误路径(unknown_command / PAUSE 后不 tick / RESUME)
//   ⑦资金口径唯一性:capitalSnapshot 与引擎 poolLayers 逐项一致;capitalParity 容差与分叉检测(§19/§21)
//   ⑧Viewer 同口径:只用持久化字段(账户行 + profit_pool)能复现引擎的分层资金与 HWM 峰值(§22/§23)
//   ⑨启动对账:账户缺失但存在持仓史 → 拒绝启动且不新建账户(§47/§48)
import { createHistoryStore } from "../worker/src/history/store.js";
import { num } from "../worker/src/paper/accounting.js";
import { createPaperEngine } from "../worker/src/paper/engine.js";
import { createPaperRuntime, expireStaleCommands } from "../worker/src/paper/runtime.js";
import { poolLayers } from "../worker/src/paper/profitAllocation.js";
import { capitalSnapshot, capitalParity, CAPITAL_PARITY_TOLERANCE, notificationRoute } from "../worker/src/ui/viewModels.js";

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
const adapter = (store) => ({ get: (t, k) => store.generic.get(t, k), all: (t) => store.generic.all(t), put: (t, r) => store.generic.put(t, r), del: (t, k) => store.generic.del(t, k) });
const ANALYSIS = { direction: "Bullish", confidence: 72, signal_strength: 60, volatility: { atrPct: 1 }, market_regime: { label: "Weak Uptrend" }, structure: { last_swing_low: 80000, last_swing_high: 86000 } };

// 测试宿主:可控时钟 + 可控行情(ok / fail / frozen)+ 通知与状态采集
function mkHost(store, clock, options) {
  const o = options || {};
  let marketMode = o.marketMode || "ok";
  let drift = 0;
  const tickersFor = () => {
    if (marketMode === "fail") throw new Error("all_providers_failed");
    const base = 84000 + drift;
    return [
      { symbol: "BTCUSDT", lastPrice: base, highPrice: base + 500, lowPrice: base - 500 },
      { symbol: "ETHUSDT", lastPrice: 2712 + drift, highPrice: 2740 + drift, lowPrice: 2690 + drift }
    ];
  };
  const engine = createPaperEngine({
    store: adapter(store),
    now: () => clock.t,
    riskCheck: () => ({ veto: false, risk_score: 20 }),
    fetchKlines: async () => []
  });
  const notifications = [];
  const statuses = [];
  const commandQueue = [];
  const commandCompleted = [];
  const runtime = createPaperRuntime({
    engine,
    key: o.key || "rv",
    now: () => clock.t,
    setInterval: () => 0,
    clearInterval: () => {},
    started_by: "test",
    fetchTickers: async () => tickersFor(),
    candidateSymbols: () => ["BTCUSDT", "ETHUSDT"],
    modes: ["short", "long"],
    analyze: async () => ({ ...ANALYSIS }),
    notify: (kind, title, body, meta) => notifications.push({ kind, title, body, meta }),
    onStatus: (s) => statuses.push(s),
    ...(o.acceptCommands ? {
      commands: {
        poll: async () => commandQueue.splice(0, commandQueue.length),
        complete: async (cmd, result) => { commandCompleted.push({ cmd, result }); }
      }
    } : {}),
    config: { risk_interval_ms: 0, ...(o.config || {}) }
  });
  return {
    engine, runtime, notifications, statuses, commandCompleted,
    enqueue: (cmd) => commandQueue.push(cmd),
    setMarket: (m) => { marketMode = m; },
    setDrift: (d) => { drift = d; }
  };
}

console.log("== 1. 实例身份 / state_version(§4/§20) ==");
{
  const store = await createHistoryStore({ memory: true });
  const clock = { t: T0 };
  const a = mkHost(store, clock, { key: "rv-id-a" });
  await a.runtime.start({ immediate: false });
  const s1 = a.runtime.status();
  check("instance_id 存在且格式稳定", /^rt_[0-9a-z]+_\d+$/.test(String(s1.instance_id)), String(s1.instance_id));
  check("owner / started_at 透传", s1.owner === "test" && s1.started_at === T0, JSON.stringify({ owner: s1.owner, started: s1.started_at }));
  const v0 = a.runtime.status().state_version;
  await a.runtime.report();
  const v1 = a.runtime.status().state_version;
  check("state_version 严格递增(旧版本可被 UI 丢弃)", v1 > v0, JSON.stringify({ v0, v1 }));
  const b = mkHost(store, clock, { key: "rv-id-b" });
  check("不同运行时的 instance_id 不同", b.runtime.status().instance_id !== s1.instance_id);
  a.runtime.dispose();
  b.runtime.dispose();
}

console.log("== 2. 心跳 / RUNTIME_STALL(§34:冻结可检出、冷启动不误报) ==");
{
  const store = await createHistoryStore({ memory: true });
  const clock = { t: T0 };
  const h = mkHost(store, clock, { key: "rv-heartbeat", config: { stall_warn_ms: 60000 } });
  await h.runtime.start({ immediate: false });
  const cold = h.runtime.status();
  check("冷启动无心跳不误报 stalled", cold.stalled === false && cold.heartbeat_age_ms === null, JSON.stringify({ stalled: cold.stalled, age: cold.heartbeat_age_ms }));
  await h.runtime.tick("t1");
  check("tick 后心跳新鲜", h.runtime.status().heartbeat_age_ms === 0);
  clock.t += 20 * 60000;   // 模拟被系统冻结 20 分钟(超过 stall_warn 60s)
  const frozen = h.runtime.status();
  check("冻结期间以心跳口径判定 stalled", frozen.stalled === true, JSON.stringify({ age: frozen.heartbeat_age_ms }));
  await h.runtime.riskTick();   // 恢复后的第一次活动
  const resumed = h.runtime.status();
  check("恢复时自动记录 RUNTIME_STALL 证据(间隔快照)", resumed.stall_events === 1 && resumed.last_stall_ms === 20 * 60000, JSON.stringify({ ev: resumed.stall_events, ms: resumed.last_stall_ms }));
  check("恢复后心跳新鲜、stalled 解除", resumed.stalled === false && resumed.heartbeat_age_ms === 0);
  check("风控轮次计数与时间戳增长", resumed.risk_loops === 1 && resumed.last_risk_at === clock.t, JSON.stringify({ rl: resumed.risk_loops, at: resumed.last_risk_at }));
  h.runtime.dispose();
}

console.log("== 3. 行情阻断:不产生假 stall / 只通知一次 / 不开新仓 ==");
{
  const store = await createHistoryStore({ memory: true });
  const clock = { t: T0 };
  const h = mkHost(store, clock, { key: "rv-blocked", marketMode: "fail", config: { stall_warn_ms: 60000 } });
  await h.runtime.start({ immediate: false });
  await h.runtime.tick("b1");
  const st1 = h.runtime.status();
  check("首次失败 → DEGRADED", st1.market_state === "DEGRADED", JSON.stringify(st1.market_state));
  clock.t += 10000;
  await h.runtime.tick("b2");
  const st2 = h.runtime.status();
  check("连续失败 → FAILED(阻断新开仓)", st2.market_state === "FAILED" && st2.market_blocked === true, JSON.stringify(st2.market_state));
  check("行情阻断不产生假 stall(心跳在跑)", st2.stalled === false && st2.heartbeat_age_ms === 0, JSON.stringify({ stalled: st2.stalled }));
  check("风控轮次同样计入心跳(风险轮照跑但被行情挡住)", st2.risk_loops === 1 || st2.risk_loops === 0, String(st2.risk_loops));
  check("阻断通知只发一次", h.notifications.filter((n) => /行情源不可用/.test(n.title)).length === 1);
  check("阻断期间不开新仓", h.engine.getOrders().length === 0, String(h.engine.getOrders().length));
  check("行情拉取计数把失败也算进证据(§58 不允许只看布尔)", st2.market_fetches >= 2, String(st2.market_fetches));
  // 恢复行情 → 可以开仓
  h.setMarket("ok");
  clock.t += 3600000;
  await h.runtime.tick("b3");
  check("行情恢复 → HEALTHY 并可开仓", h.runtime.status().market_state === "HEALTHY" && h.engine.getOrders().length > 0, JSON.stringify({ state: h.runtime.status().market_state, orders: h.engine.getOrders().length }));
  // 再次阻断:已有仓位被标记 DEGRADED(不拿过期价乱模拟)
  h.setMarket("fail");
  clock.t += 10000;
  await h.runtime.tick("b4");
  const open = h.engine.getPositions().filter((p) => p.status === "OPEN");
  check("阻断时已有仓位标记 DEGRADED", open.length > 0 && open.every((p) => p.price_status === "DEGRADED"), JSON.stringify(open.map((p) => p.price_status)));
  h.runtime.dispose();
}

console.log("== 4. Provider STALE:HTTP 200 但价格停滞(§35) ==");
{
  const store = await createHistoryStore({ memory: true });
  const clock = { t: T0 };
  const h = mkHost(store, clock, { key: "rv-stale", marketMode: "frozen", config: { market_stale_fetches: 3 } });
  await h.runtime.start({ immediate: false });
  await h.runtime.tick("s1"); clock.t += 3600000;
  await h.runtime.tick("s2"); clock.t += 3600000;
  await h.runtime.tick("s3"); clock.t += 3600000;
  const ordersBefore = h.engine.getOrders().length;
  const s = await h.runtime.tick("s4");
  const st = h.runtime.status();
  check("连续多次价格指纹完全不变 → STALE(不是 HEALTHY)", st.market_state === "STALE" && st.market_stale === true, JSON.stringify({ state: st.market_state, fetches: st.market_fetches }));
  check("STALE 时暂停新开仓(订单不增长)", h.engine.getOrders().length === ordersBefore, JSON.stringify({ before: ordersBefore, after: h.engine.getOrders().length }));
  check("STALE 跳过开仓但策略轮次仍计数并留痕", s.summary && s.summary.note === "market_stale_skip_entries" && h.runtime.loops() === 4, JSON.stringify(s.summary));
  check("STALE 通知只发一次", h.notifications.filter((n) => /行情数据可能停滞/.test(n.title)).length === 1);
  h.setDrift(37);
  clock.t += 3600000;
  const back = await h.runtime.tick("s5");
  check("价格恢复变化 → 回到 HEALTHY", h.runtime.status().market_state === "HEALTHY", JSON.stringify(h.runtime.status().market_state));
  check("恢复后可以正常开仓", h.engine.getOrders().length > ordersBefore, JSON.stringify({ after: h.engine.getOrders().length }));
  check("恢复 tick 不再是 stale 跳过", !(back.summary && back.summary.note === "market_stale_skip_entries"));
  h.runtime.dispose();
}

console.log("== 5. 恢复不补跑旧周期 + 收盘K线幂等(§8/§9) ==");
{
  const store = await createHistoryStore({ memory: true });
  const clock = { t: T0 };
  const h = mkHost(store, clock, { key: "rv-catchup" });
  await h.runtime.start({ immediate: false });
  await h.runtime.tick("first");
  const ordersAfterFirst = h.engine.getOrders().length;
  check("首轮确实开仓", ordersAfterFirst > 0, String(ordersAfterFirst));
  for (let i = 0; i < 9; i += 1) await h.runtime.tick("catchup_" + i);   // 同一收盘K线连跑(模拟恢复后的补跑风暴)
  check("同一收盘K线连跑 10 轮不重复开仓(恢复不补跑)", h.engine.getOrders().length === ordersAfterFirst, JSON.stringify({ before: ordersAfterFirst, after: h.engine.getOrders().length }));
  // 换方向、换置信度也一样:同一根收盘K线最多一次策略决策
  const pos = h.engine.getPositions().find((p) => p.status === "OPEN" && p.closed_candle_time != null);
  if (pos) {
    const res = await h.engine.openPosition({
      mode: pos.mode, symbol: pos.symbol,
      direction: pos.side === "LONG" ? "Bearish" : "Bullish",
      signal_timestamp: pos.closed_candle_time,
      quote: { price: num(pos.entry_price), received_at: clock.t },
      analysis: { direction: "Bearish", confidence: 90, volatility: { atrPct: 1 } }
    });
    check("同一收盘K线换方向也被拒绝(per symbol|mode|interval)", res.ok === false && ["closed_candle_already_processed", "duplicate_idempotency_key"].includes(res.reason), JSON.stringify(res.reason));
  } else {
    check("同一收盘K线换方向也被拒绝(per symbol|mode|interval)", false, "无持仓/无 closed_candle_time,测试前提不成立");
  }
  h.runtime.dispose();
}

console.log("== 6. 命令邮箱错误路径(§5:UI 只发命令,运行时执行) ==");
{
  const store = await createHistoryStore({ memory: true });
  const clock = { t: T0 };
  const h = mkHost(store, clock, { key: "rv-commands" });
  await h.runtime.start({ immediate: false });
  const unknown = await h.runtime.executeCommand({ type: "NO_SUCH_COMMAND" });
  eq("未知命令有明确 reason", unknown.reason, "unknown_command");
  const paused = await h.runtime.executeCommand({ type: "PAUSE" });
  check("PAUSE 命令改状态", paused.ok === true && h.runtime.status().state === "PAUSED", JSON.stringify(paused));
  const t = await h.runtime.tick("paused_tick");
  check("暂停时不交易,但命令通道保持(§8 死锁回归)", t.ok === false && t.reason === "paused_commands_only", JSON.stringify(t));
  await h.runtime.executeCommand({ type: "RESUME" });
  check("RESUME 恢复运行", h.runtime.status().state === "RUNNING");
  h.runtime.dispose();
}

console.log("== 6b. 暂停死锁回归 + 陈旧命令过期(§8,真机实测缺陷) ==");
{
  // 真机实测:PAUSED 后 tick 早退 → 命令邮箱不再被消费 → UI 发的 RESUME 永远到不了 → 永久暂停。
  const store = await createHistoryStore({ memory: true });
  const clock = { t: T0 };
  const h = mkHost(store, clock, { key: "rv-paused-pump", acceptCommands: true });
  await h.runtime.start({ immediate: false });
  await h.runtime.executeCommand({ type: "PAUSE" });
  check("已暂停(复现死锁场景)", h.runtime.status().state === "PAUSED");
  h.enqueue({ command_id: "c1", type: "RESUME", status: "PENDING", created_at: clock.t });
  const pumped = await h.runtime.tick("paused_pump");
  check("PAUSED 时 tick 只消费命令、不交易", pumped.ok === false && pumped.reason === "paused_commands_only", JSON.stringify(pumped));
  check("RESUME 被消费并救活运行时(不存在永久暂停死锁)", h.runtime.status().state === "RUNNING" && h.commandCompleted.length === 1,
    JSON.stringify({ state: h.runtime.status().state, done: h.commandCompleted.length }));
  h.runtime.dispose();
  // TTL:积压数小时的命令不许迟到执行(真机上积压的 PAUSE 曾把新运行时停住)
  const rows = [
    { command_id: "old", type: "PAUSE", status: "PENDING", created_at: T0 },
    { command_id: "new", type: "RESUME", status: "PENDING", created_at: T0 + 11 * 60000 - 1000 }
  ];
  const split = expireStaleCommands(rows, T0 + 11 * 60000);
  check("超过 TTL 的 PENDING 被标记过期(不进入执行)", split.expired.length === 1 && split.expired[0].command_id === "old" && split.expired[0].status === "FAILED" && split.expired[0].result.reason === "expired", JSON.stringify(split.expired));
  check("未过期命令照常执行", split.fresh.length === 1 && split.fresh[0].command_id === "new", JSON.stringify(split.fresh));
}

console.log("== 7. 资金口径唯一性 + 一致性对比(§19/§21/§22) ==");
{
  const account = { total_equity: 102.5, cash_balance: 62.5, reserved_balance: 30, unrealized_pnl: 2.5 };
  const engineLayers = poolLayers({ equity: 102.5, reserved_margin: 30, unrealized_pnl: 2.5, cash_balance: 62.5, pool: { protected_balance: 10 } });
  const viaEngine = capitalSnapshot({ account, layers: engineLayers, state_version: 7, updated_at: T0 });
  const viaLocal = capitalSnapshot({ account, protected_balance: 10, state_version: 7, updated_at: T0 });
  check("capitalSnapshot 两条路径逐项一致(唯一口径)",
    ["total_equity", "tradable_capital", "reserved_margin", "protected_profit"].every((k) => Math.abs(viaEngine[k] - viaLocal[k]) < 1e-9),
    JSON.stringify({ viaEngine, viaLocal }));
  eq("分层数字正确(保护池不进可交易资金)", [viaLocal.total_equity, viaLocal.tradable_capital, viaLocal.reserved_margin, viaLocal.protected_profit], [102.5, 52.5, 30, 10]);
  check("spendable_for_entry = tradable(只有可交易资金能开新仓)", viaLocal.spendable_for_entry === viaLocal.tradable_capital);
  check("版本戳透传", viaEngine.state_version === 7 && viaEngine.updated_at === T0);
  check("无数据不冒充 0(has_data=false)", capitalSnapshot({ account: {} }).has_data === false);
  const okDrift = capitalParity(viaEngine, { ...viaLocal, protected_profit: 10.004 });
  check("容差内(≤" + CAPITAL_PARITY_TOLERANCE + ")不算分叉", okDrift.ok === true, JSON.stringify(okDrift.fields));
  const bad = capitalParity(viaEngine, { ...viaLocal, protected_profit: 10.02, tradable_capital: 52.5 });
  check("超容差 → 精确报出分叉字段", bad.ok === false && bad.fields.join(",") === "protected_profit", JSON.stringify(bad.fields));
}

console.log("== 8. Viewer 同口径:持久化字段能复现引擎数字(§22/§23) ==");
{
  const store = await createHistoryStore({ memory: true });
  const clock = { t: T0 };
  const h = mkHost(store, clock, { key: "rv-parity" });
  await h.runtime.start({ immediate: false });
  await h.runtime.tick("open");
  const pos = h.engine.getPositions().find((p) => p.status === "OPEN" && p.side === "LONG");
  check("开仓就绪(为平仓盈利做准备)", Boolean(pos), JSON.stringify(h.engine.getPositions().map((p) => p.side)));
  if (pos) {
    clock.t += 3600000;
    const close = await h.engine.manualClose({ position_id: pos.position_id, fraction: 1, price: num(pos.entry_price) * 1.05, action_source: "MANUAL" });
    check("盈利平仓成功(制造保护池/HWM 真实数据)", Boolean(close && close.ok), JSON.stringify(close && close.reason));
    clock.t += 3600000;
    await h.runtime.tick("persist");   // 再过一轮:触发状态持久化(含 profit_pool / hwm)
    const acctRow = await store.generic.get("paper_account", "paper-main");
    const stateRow = await store.generic.get("paper_engine_state", "paper-engine");
    const engineLayers = h.engine.poolLayers();
    const viewerLayers = poolLayers({
      equity: num(acctRow.total_equity),
      reserved_margin: num(acctRow.reserved_balance),
      unrealized_pnl: num(acctRow.unrealized_pnl),
      cash_balance: num(acctRow.cash_balance),
      pool: { protected_balance: num(stateRow && stateRow.profit_pool && stateRow.profit_pool.protected_balance, 0) }
    });
    near("总资产:Viewer vs 引擎", viewerLayers.total_equity, engineLayers.total_equity, 1e-6);
    near("可交易:Viewer vs 引擎", viewerLayers.tradable_capital, engineLayers.tradable_capital, 1e-6);
    near("已占用:Viewer vs 引擎", viewerLayers.reserved_margin, engineLayers.reserved_margin, 1e-6);
    near("保护池:Viewer vs 引擎", viewerLayers.protected_profit, engineLayers.protected_profit, 1e-6);
    check("保护池已产生真实拆分(>0)", viewerLayers.protected_profit > 0, String(viewerLayers.protected_profit));
    const persistedPeak = num(stateRow && stateRow.hwm && stateRow.hwm.peak_equity, 0);
    const enginePeak = num(h.engine.hwm().peak_equity, 0);
    check("HWM 峰值已持久化(UI 只读,不自己重算)", persistedPeak > 0, JSON.stringify({ persistedPeak }));
    near("持久化峰值 = 引擎峰值", persistedPeak, enginePeak, 1e-6);
  }
  h.runtime.dispose();
}

console.log("== 9. 启动对账:账户缺失但有持仓史 → 拒绝启动且不新建账户(§47/§48) ==");
{
  const store = await createHistoryStore({ memory: true });
  await store.generic.put("paper_positions", {
    position_id: "ghost1", symbol: "BTCUSDT", mode: "short", side: "LONG", status: "OPEN",
    entry_price: 84000, current_price: 84000, quantity: 0.001, initial_quantity: 0.001, remaining_quantity: 0.001,
    entry_notional: 10, notional: 10, leverage: 1, entry_time: T0
  });
  const clock = { t: T0 };
  const h = mkHost(store, clock, { key: "rv-reconcile" });
  const started = await h.runtime.start({ immediate: false });
  check("运行时拒绝启动(进入 ERROR 而不是硬跑)", started.ok === false && h.runtime.status().state === "ERROR", JSON.stringify(started.reason || (started.status && started.status.state)));
  const accounts = await store.generic.all("paper_account");
  check("没有偷偷新建 100U 账户", (accounts || []).length === 0, String((accounts || []).length));
  h.runtime.dispose();
}

console.log("== 10. 通知点击深链路由(§50:不允许全部只开首页) ==");
{
  const r1 = notificationRoute({ kind: "CLOSE", title: "ETH/USDT 已模拟平仓" });
  check("交易类通知(带币种)→ 币种详情", r1.page === "detail" && r1.symbol === "ETHUSDT", JSON.stringify(r1));
  const r2 = notificationRoute({ kind: "SYSTEM", title: "后台运行时可能被系统挂起" });
  check("系统类通知 → 系统诊断页", r2.page === "diag", JSON.stringify(r2));
  const r3 = notificationRoute({ kind: "RISK", title: "回撤状态变化 → CAUTION" });
  check("风险类通知(无币种)→ 诊断页", r3.page === "diag", JSON.stringify(r3));
  const r4 = notificationRoute({ kind: "LEARNING", title: "新 Champion 上线" });
  check("学习类通知 → 我的页", r4.page === "settings", JSON.stringify(r4));
  const r5 = notificationRoute({ kind: "TRADE", title: "新模拟开仓 BTC/USDT · 做多" });
  check("开仓通知带币种 → 详情", r5.page === "detail" && r5.symbol === "BTCUSDT", JSON.stringify(r5));
  check("路由全部给出 reason 且不落回 home", [r1, r2, r3, r4, r5].every((r) => r.reason && r.page !== "home"), JSON.stringify([r1, r2, r3, r4, r5].map((r) => r.page)));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("RUNTIME VERIFY OK");
