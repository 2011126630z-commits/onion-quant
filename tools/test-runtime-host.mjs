// tools/test-runtime-host.mjs · V15 P0:Paper Runtime 独立于界面运行(宿主无关)
// 验证:①无 DOM 也能跑 ②单实例 ③重启后从存储恢复(不建新账户) ④同一收盘K线不重复下单
//      ⑤停止后不再 tick ⑥状态摘要供原生通知使用
import { createHistoryStore } from "../worker/src/history/store.js";
import { num, round } from "../worker/src/paper/accounting.js";
import { createPaperEngine, closedCandleTime } from "../worker/src/paper/engine.js";
import { createPaperRuntime, buildQuotes, runtimeStatus, runtimeInstanceCount, getRuntime, RUNTIME_STATES } from "../worker/src/paper/runtime.js";

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

// 纯逻辑宿主:没有 window/document/任何 DOM —— 证明运行时不需要界面
function mkHost(store, clock, options) {
  const o = options || {};
  const tickers = o.tickers || [
    { symbol: "BTCUSDT", lastPrice: 84000, highPrice: 84500, lowPrice: 83500 },
    { symbol: "ETHUSDT", lastPrice: 2712, highPrice: 2740, lowPrice: 2690 }
  ];
  const engine = createPaperEngine({
    store: mkAdapter(store),
    now: () => clock.t,
    riskCheck: () => ({ veto: false, risk_score: 20 }),
    fetchKlines: async () => []
  });
  const statuses = [];
  const runtime = createPaperRuntime({
    engine,
    key: o.key || "paper-runtime",
    now: () => clock.t,
    setInterval: () => 0,
    clearInterval: () => {},
    started_by: o.started_by || "test",
    fetchTickers: async () => tickers,
    candidateSymbols: () => (o.symbols || ["BTCUSDT", "ETHUSDT"]),
    modes: o.modes || ["short", "long"],
    analyze: async ({ symbol, interval }) => o.analyze ? o.analyze({ symbol, interval }) : ({
      direction: "Bullish", confidence: 72, signal_strength: 60,
      volatility: { atrPct: 1 }, market_regime: { label: "Weak Uptrend" },
      structure: { last_swing_low: 80000, last_swing_high: 86000 }
    }),
    onStatus: (s) => statuses.push(s),
    config: { risk_interval_ms: 0 }
  });
  return { engine, runtime, statuses };
}

console.log("== 1. 无界面也能运行(宿主无关) ==");
{
  check("测试环境确实没有 DOM", typeof window === "undefined" && typeof document === "undefined");
  const store = await createHistoryStore({ memory: true });
  const clock = { t: T0 };
  const { engine, runtime, statuses } = mkHost(store, clock);
  const started = await runtime.start({ immediate: false });
  check("start() 成功", started.ok === true && runtime.isRunning(), JSON.stringify(started.reason || started.status && started.status.state));
  const tick1 = await runtime.tick("test");
  check("tick 成功并回报摘要", tick1.ok === true && tick1.summary.candidates > 0, JSON.stringify(tick1.summary || tick1.reason));
  const positions = engine.getPositions();
  check("真的开了仓(不需要 UI)", positions.length > 0, JSON.stringify(positions.length));
  check("状态回报包含 Short/Long/持仓数", statuses.length > 0 && /Short \d+ \/ Long \d+ · 持仓 \d+/.test(statuses[statuses.length - 1].mode_label), JSON.stringify(statuses[statuses.length - 1]));
  check("runtime 状态机集合", RUNTIME_STATES.includes(runtime.status().state));
  runtime.dispose();
}

console.log("== 2. 单实例(严禁第二个 Engine/运行时) ==");
{
  const store = await createHistoryStore({ memory: true });
  const clock = { t: T0 };
  const a = mkHost(store, clock, { key: "single" }).runtime;
  const b = mkHost(store, clock, { key: "single" }).runtime;
  check("同 key 第二次创建返回同一实例", a === b, JSON.stringify({ same: a === b }));
  check("实例数受控", runtimeInstanceCount() >= 1 && getRuntime("single") === a);
  const tickPass = await a.start({ immediate: false });
  const again = await a.start({ immediate: false });
  check("重复 start 幂等", tickPass.ok === true && again.already === true, JSON.stringify(again));
  a.dispose();
  check("dispose 后登记表移除", getRuntime("single") === null);
}

console.log("== 3. 停止后不再 tick ==");
{
  const store = await createHistoryStore({ memory: true });
  const clock = { t: T0 };
  const { runtime } = mkHost(store, clock, { key: "stop-test" });
  await runtime.start({ immediate: false });
  await runtime.tick("a");
  const loopsBefore = runtime.loops();
  runtime.stop("test_stop");
  const after = await runtime.tick("should_be_blocked");
  check("stop 后 tick 被拒绝", after.ok === false && after.reason === "not_running", JSON.stringify(after));
  eq("循环计数不再增长", runtime.loops(), loopsBefore);
  runtime.dispose();
}

console.log("== 4. 重启后从持久化恢复(不建新账户 / 不重复下单) ==");
{
  const store = await createHistoryStore({ memory: true });
  const clock = { t: T0 };
  const first = mkHost(store, clock, { key: "restart" });
  await first.runtime.start({ immediate: false });
  await first.runtime.tick("first");
  const accountBefore = first.engine.getAccount();
  const positionsBefore = first.engine.getPositions().filter((p) => p.status === "OPEN");
  check("第一轮开了仓", positionsBefore.length > 0, JSON.stringify(positionsBefore.length));
  // 模拟进程被杀:运行时与引擎全部丢弃,磁盘(store)保留
  first.runtime.dispose();
  const second = mkHost(store, clock, { key: "restart" });
  const init = await second.engine.init();
  const accountAfter = second.engine.getAccount();
  check("恢复时不是首次创建(没有新建账户)", init.created === false, JSON.stringify(init.created));
  near("账户权益一致(同一账户)", num(accountAfter.total_equity), num(accountBefore.total_equity), 1e-6);
  eq("持仓数量一致", second.engine.getPositions().filter((p) => p.status === "OPEN").length, positionsBefore.length);
  eq("成交数一致", second.engine.getTrades().length, first.engine.getTrades().length);
  // 重复 tick 同一根收盘K线 → 幂等键挡住,不得重复开仓
  const ordersBefore = second.engine.getOrders().length;
  const positionsTotalBefore = second.engine.getPositions().length;
  await second.runtime.start({ immediate: false });
  await second.runtime.tick("after_restart_same_candle");
  await second.runtime.tick("again_same_candle");
  check("同一收盘K线不产生新订单(幂等)", second.engine.getOrders().length === ordersBefore, JSON.stringify({ before: ordersBefore, after: second.engine.getOrders().length }));
  check("同一收盘K线不产生新仓位", second.engine.getPositions().length === positionsTotalBefore, JSON.stringify({ before: positionsTotalBefore, after: second.engine.getPositions().length }));
  const dupCheck = await second.engine.openPosition({
    mode: "short", symbol: positionsBefore[0].symbol, direction: "Bullish",
    signal_timestamp: positionsBefore[0].closed_candle_time,
    quote: { price: positionsBefore[0].entry_price, received_at: clock.t },
    analysis: { direction: "Bullish", confidence: 70, volatility: { atrPct: 1 } },
    leverage: 2
  });
  eq("幂等键仍然拦住重复开仓", dupCheck.reason, "duplicate_idempotency_key");
  second.runtime.dispose();
}

console.log("== 5. 状态摘要(原生通知直接用这一份) ==");
{
  const nowMs = T0 + 400000;
  const s = runtimeStatus({
    state: "RUNNING",
    account: { total_equity: 99.86, realized_pnl: -0.13 },
    positions: [
      { status: "OPEN", mode: "short" }, { status: "OPEN", mode: "short" },
      { status: "OPEN", mode: "long" }, { status: "CLOSED", mode: "long" }
    ],
    today_net: -0.02, loops: 7, last_tick_at: T0,
    instance_id: "rt_test_1", owner: "native-service", started_at: T0 - 3600000,
    state_version: 42, risk_loops: 9, market_fetches: 11, last_risk_at: nowMs - 20000,
    heartbeat_at: nowMs - 200000, stall_warn_ms: 1000, tick_interval_ms: 300000, now: nowMs,
    market: { ok: true, state: "HEALTHY", provider: "binance", last_ok_at: nowMs - 20000 }
  });
  eq("持仓统计按池子拆分", [s.open_positions, s.short_positions, s.long_positions], [3, 2, 1]);
  near("权益/已实现透传", [s.equity, s.realized], [99.86, -0.13]);
  check("通知文案可直接用", s.mode_label === "Short 2 / Long 1 · 持仓 3", s.mode_label);
  // V16.1-RV §34:停滞检测改成"心跳(循环活动)"口径 —— 200 秒无活动且已过冷启动宽限 ⇒ 告警
  check("停滞检测(心跳口径)可用于告警", s.stalled === true, JSON.stringify({ heartbeat_age_ms: s.heartbeat_age_ms, stalled: s.stalled }));
  check("实例身份/版本透传(§4/§20)", s.instance_id === "rt_test_1" && s.owner === "native-service" && s.state_version === 42, JSON.stringify({ id: s.instance_id, v: s.state_version }));
  check("分项计数透传(风险轮次/行情拉取,§33)", s.risk_loops === 9 && s.market_fetches === 11);
  check("各项延迟按 now 统一计算", s.heartbeat_age_ms === 200000 && s.strategy_age_ms === 400000 && s.risk_age_ms === 20000 && s.market_age_ms === 20000,
    JSON.stringify({ hb: s.heartbeat_age_ms, st: s.strategy_age_ms, rk: s.risk_age_ms, mk: s.market_age_ms }));
  // §34:冷启动宽限 —— 刚启动、还没有任何心跳,不能报 stalled
  const cold = runtimeStatus({ state: "RUNNING", started_at: nowMs - 30000, last_tick_at: null, heartbeat_at: null, stall_warn_ms: 1000, now: nowMs });
  check("冷启动宽限不误报 stalled", cold.stalled === false, JSON.stringify({ stalled: cold.stalled }));
  // §34/§19:行情被 Provider 阻断 ≠ RUNTIME_STALL —— 循环照跑(心跳新),由 market_state 表达
  const blocked = runtimeStatus({
    state: "RUNNING", started_at: nowMs - 3600000, heartbeat_at: nowMs - 1000,
    last_tick_at: nowMs - 800000, stall_warn_ms: 1000, tick_interval_ms: 300000,
    market: { ok: false, state: "FAILED", provider: "binance" }, now: nowMs
  });
  check("行情阻断不产生假 stall(心跳新)", blocked.stalled === false && blocked.market_blocked === true, JSON.stringify({ stalled: blocked.stalled, market: blocked.market_state }));
  check("策略循环超时单独标记(strategy_stalled,§33)", blocked.strategy_stalled === true, JSON.stringify({ strategy_age_ms: blocked.strategy_age_ms }));
  check("状态不含 undefined 字段", Object.values(s).every((v) => v !== undefined));
}

console.log("== 6. 行情构建守卫(无 symbol/非法价一律丢弃) ==");
{
  const quotes = buildQuotes([
    { symbol: "BTCUSDT", lastPrice: 84000 },
    { lastPrice: 100 },
    { symbol: "ETHUSDT", lastPrice: 0 },
    { symbol: "BNBUSDT", lastPrice: NaN },
    { symbol: "SOLUSDT", price: 150 }
  ]);
  eq("只保留合法报价", Object.keys(quotes).sort(), ["BTCUSDT", "SOLUSDT"]);
  eq("quote 带 symbol(串价防线)", [quotes.BTCUSDT.symbol, quotes.SOLUSDT.price], ["BTCUSDT", 150]);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("RUNTIME HOST OK");
