// tools/test-attribution.mjs · V15 Performance Attribution + 通知历史持久化
// 归因:策略/币种/Regime/杠杆/模型/退出策略/周期 分组,口径一致,异常样本剔除
// 通知:写入落库、重开恢复、已读状态持久化、上限裁剪
import { createHistoryStore } from "../worker/src/history/store.js";
import { num, round } from "../worker/src/paper/accounting.js";
import { createPaperEngine } from "../worker/src/paper/engine.js";
import { attributionOf, attributionView, exitBucketOf, groupStats, isValidTrade, ATTRIBUTION_DIMENSIONS } from "../worker/src/paper/attribution.js";
import { ALL_TABLES, PAPER_NOTIFICATION_TABLE } from "../worker/src/history/schema.js";

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

const trade = (over) => ({
  trade_id: over.trade_id || "t" + Math.round(num(over.net_pnl, 0) * 100) + (over.symbol || ""),
  mode: "short", symbol: "BTCUSDT", side: "LONG", entry_price: 100, exit_price: 101, quantity: 1,
  gross_pnl: 1, fees: 0.1, net_pnl: 1, exit_reason: "take_profit", leverage: 2, model_version: "rule-v0.1",
  market_regime: "Weak Uptrend", exit_time: T0, entry_time: T0 - 60000, holding_ms: 60000, ...over
});

console.log("== 1. 维度覆盖与口径 ==");
{
  eq("七个归因维度", ATTRIBUTION_DIMENSIONS.map((d) => d.key), ["strategy", "symbol", "regime", "leverage", "model", "exit_policy", "interval"]);
  eq("退出原因归桶", [exitBucketOf("LIQUIDATION"), exitBucketOf("stop_loss"), exitBucketOf("partial_take_profit_tp1"), exitBucketOf("profit_lock_stage2"), exitBucketOf("manual"), exitBucketOf("time_exit"), exitBucketOf("signal_reversal")], ["强平", "止损", "止盈", "利润保护", "手动", "时间退出", "结构/反转"]);
  const trades = [
    trade({ trade_id: "a", mode: "short", symbol: "BTCUSDT", net_pnl: 10, fees: 0.4, leverage: 2, exit_reason: "take_profit", market_regime: "Uptrend" }),
    trade({ trade_id: "b", mode: "short", symbol: "BTCUSDT", net_pnl: -5, fees: 0.2, leverage: 4, exit_reason: "stop_loss", market_regime: "Uptrend" }),
    trade({ trade_id: "c", mode: "long", symbol: "ETHUSDT", net_pnl: -4.5, fees: 0.3, leverage: 4, exit_reason: "LIQUIDATION", market_regime: "Ranging" })
  ];
  const a = attributionOf(trades);
  eq("样本全有效", [a.sample.total, a.sample.valid, a.sample.excluded], [3, 3, 0]);
  near("净额合计", a.net_pnl, 0.5);
  const byStrategy = a.dimensions.strategy.rows;
  check("策略维度分两组", byStrategy.length === 2, JSON.stringify(byStrategy.map((r) => r.key)));
  near("短线净额 = 10 - 5", byStrategy.find((r) => r.key === "短线").net_pnl, 5);
  near("长线净额 = -4.5", byStrategy.find((r) => r.key === "长线").net_pnl, -4.5);
  const byLeverage = a.dimensions.leverage.rows;
  eq("杠杆档分组", byLeverage.map((r) => r.key).sort(), ["2x", "4x"]);
  near("4x 合计 -9.5", byLeverage.find((r) => r.key === "4x").net_pnl, -9.5);
  const byExit = a.dimensions.exit_policy.rows;
  check("退出策略分组含强平/止损/止盈", ["强平", "止损", "止盈"].every((k) => byExit.some((r) => r.key === k)), JSON.stringify(byExit.map((r) => r.key)));
  const worst = a.dimensions.symbol.rows[a.dimensions.symbol.rows.length - 1];
  eq("币种最差是 ETH", worst.key, "ETH");
  check("每行都带胜率/笔数/盈亏比", byStrategy.every((r) => "win_rate" in r && "trades" in r && "profit_factor" in r));
  near("盈亏比 = 总盈利/总亏损", byStrategy.find((r) => r.key === "短线").profit_factor, round(10 / 5, 4));
  check("贡献占比可用", byStrategy[0].share_pct != null);
}

console.log("== 2. 异常样本必须剔除(否则归因被脏数据带偏) ==");
{
  const trades = [
    trade({ trade_id: "ok", net_pnl: 2 }),
    trade({ trade_id: "inv", net_pnl: -500, invalid_sample: true }),
    trade({ trade_id: "nan", net_pnl: NaN }),
    trade({ trade_id: "badprice", net_pnl: 3, entry_price: 0 })
  ];
  const a = attributionOf(trades);
  eq("只统计有效样本", [a.sample.valid, a.sample.excluded], [1, 3]);
  near("异常样本不影响净额", a.net_pnl, 2);
  eq("无效样本判定", [isValidTrade({ invalid_sample: true }), isValidTrade({ net_pnl: 1, entry_price: 1, exit_price: 1 }), isValidTrade({ net_pnl: 1, entry_price: 0, exit_price: 1 })], [false, true, false]);
  check("被剔除原因有说明", /invalid_sample/.test(a.sample.excluded_reason));
  const withInvalid = attributionOf(trades, { include_invalid: true });
  eq("可选包含已标记无效样本(但 NaN/非法价永远排除)", withInvalid.sample.valid, 2);
  eq("NaN 与非法价不计入", withInvalid.sample.excluded, 2);
}

console.log("== 3. UI 视图与一句话结论 ==");
{
  const trades = [
    trade({ trade_id: "a", mode: "short", symbol: "BTCUSDT", net_pnl: 20, exit_reason: "take_profit" }),
    trade({ trade_id: "b", mode: "long", symbol: "SOLUSDT", net_pnl: -8, exit_reason: "stop_loss" })
  ];
  const view = attributionView(attributionOf(trades), { limit: 3 });
  check("结论文案可见", view.headline.includes("贡献") || view.headline.includes("最好"), view.headline);
  check("样本文案", /有效样本 2 笔/.test(view.sample_text), view.sample_text);
  check("分区带净额与胜率文本", view.sections.every((s) => s.rows.every((r) => r.net_text.includes("U") && r.win_rate_text.includes("%"))));
  check("符号带正负与前缀", view.sections.find((s) => s.key === "symbol").rows.some((r) => r.net_text.startsWith("+")));
  eq("tone 随净额", [attributionView(attributionOf([trade({ net_pnl: 1 })]), {}).tone, attributionView(attributionOf([trade({ net_pnl: -1, trade_id: "z" })]), {}).tone], ["up", "down"]);
  eq("空样本不崩", attributionView(attributionOf([]), {}).sample_text.includes("有效样本 0"), true);
  const g = groupStats([trade({ net_pnl: 3 }), trade({ net_pnl: -1, trade_id: "q" })], 2);
  near("分组净额", g.net_pnl, 2);
  near("分组占比", g.share_pct, 100);
}

console.log("== 4. 通知历史持久化(重开不再归零) ==");
{
  check("通知表已注册进 ALL_TABLES", ALL_TABLES.some((t) => t.name === "paper_notifications"));
  eq("通知表主键", PAPER_NOTIFICATION_TABLE.key, "notification_id");
  const store = await createHistoryStore({ memory: true });
  const adapter = mkAdapter(store);
  const clock = { t: T0 };
  const mkEngine = () => createPaperEngine({ store: adapter, now: () => clock.t, riskCheck: () => ({ veto: false, risk_score: 20 }), fetchKlines: async () => [] });
  const eng1 = mkEngine();
  await eng1.init();
  await eng1.openPosition({
    mode: "short", symbol: "BTCUSDT", direction: "Bullish", signal_timestamp: T0,
    quote: { price: 100, received_at: T0 },
    analysis: { direction: "Bullish", confidence: 70, volatility: { atrPct: 1 }, market_regime: { label: "Weak Uptrend" } },
    leverage: 2
  });
  const before = eng1.getNotifications({ limit: 50 });
  check("内存里有开仓通知", before.items.length >= 1, JSON.stringify(before.total));
  const stored = await adapter.all("paper_notifications");
  check("通知已落库", stored.length >= 1, JSON.stringify(stored.map((s) => s.kind)));
  check("落库字段完整", ["notification_id", "key", "kind", "title", "body", "at", "read"].every((k) => k in stored[0]), JSON.stringify(Object.keys(stored[0])));
  clock.t = T0 + 60000;
  const eng2 = mkEngine();
  await eng2.init();
  const after = eng2.getNotifications({ limit: 50 });
  check("重开后通知仍在(不再归零)", after.items.length >= 1 && after.total >= 1, JSON.stringify({ total: after.total }));
  eq("恢复的通知带 kind 与标题", [typeof after.items[0].kind, after.items[0].title.length > 0], ["string", true]);
  const firstId = after.items[0].notification_id;
  const marked = eng2.markNotificationsRead([firstId]);
  check("标记已读生效", marked.marked === 1 && marked.unread === 0, JSON.stringify(marked));
  const eng3 = mkEngine();
  await eng3.init();
  check("已读状态也持久化", eng3.getNotifications({ limit: 50 }).items.every((n) => n.read === true), JSON.stringify(eng3.getNotifications({ limit: 50 }).items.map((n) => n.read)));
  check("引擎暴露归因接口", typeof eng3.attribution().dimensions.symbol === "object" && typeof eng3.attributionView().headline === "string");
}

console.log("== 5. 存储退化保护(禁止静默把真实账本换成新 100U 账户) ==");
{
  const mkStubStore = (over) => {
    const data = { paper_account: null, paper_wallets: [], paper_positions: [], paper_orders: [], paper_trades: [], paper_engine_state: null, paper_notifications: [], ...(over || {}) };
    return {
      mode: "indexeddb",
      degraded: false,
      degraded_reason: null,
      get: async (t) => (t === "paper_account" ? data.paper_account : t === "paper_engine_state" ? data.paper_engine_state : null),
      all: async (t) => data[t] || [],
      put: async (t, r) => { if (t === "paper_account") data.paper_account = r; else data[t] = (data[t] || []).concat([r]); return r; },
      del: async () => true
    };
  };
  const mk = (store, extra) => createPaperEngine({ store, now: () => T0, riskCheck: () => ({ veto: false, risk_score: 20 }), fetchKlines: async () => [], ...(extra || {}) });

  // 5.1 首次运行(库里真的什么都没有)→ 允许新建账户
  const fresh = await mk(mkStubStore()).init();
  check("首次运行可以建账户", fresh.created === true && fresh.account && num(fresh.account.total_equity) === 100, JSON.stringify(fresh.created));

  // 5.2 账户缺失但库里有成交 → 必须拒绝新建(否则等于把用户账本换成 100U)
  const engOrphan = mk(mkStubStore({ paper_trades: [{ trade_id: "t1", net_pnl: -1, mode: "short", symbol: "BTCUSDT", entry_price: 100, exit_price: 99, quantity: 1, fees: 0.1, exit_time: T0 }] }));
  const orphanInit = await engOrphan.init();
  check("有历史成交但缺账户 → 阻止新建账户", orphanInit.blocked === true && !orphanInit.account, JSON.stringify(orphanInit));
  check("引擎进入 ERROR 状态并说明原因", engOrphan.getState() === "ERROR" && /history_exists/.test(engOrphan.engine.state.last_error || ""), JSON.stringify(engOrphan.engine.state.last_error));
  check("同时给出完整性告警", num(engOrphan.getIntegrity().store_unavailable) >= 1, JSON.stringify(engOrphan.getIntegrity()));
  check("通知里明确说明不会覆盖", engOrphan.getNotifications({ limit: 5 }).items.some((n) => /阻止新建账户/.test(n.title)), JSON.stringify(engOrphan.getNotifications({ limit: 5 }).items.map((n) => n.title)));

  // 5.3 存储退化(IndexedDB 被阻塞/版本不匹配)→ 同样不许静默换成新账户
  const degradedStore = mkStubStore({ paper_trades: [{ trade_id: "t2", net_pnl: 0 }] });
  degradedStore.degraded = true;
  degradedStore.degraded_reason = "indexeddb_blocked_by_other_connection";
  const engDegraded = mk(degradedStore);
  const degradedInit = await engDegraded.init();
  check("存储退化 → 阻止新建账户并记录原因", degradedInit.blocked === true && /store_degraded/.test(degradedInit.reason || ""), JSON.stringify(degradedInit.reason));

  // 5.4 迁移/工具场景可显式放行(不破坏既有测试与首次初始化脚本)
  const allowed = await mk(mkStubStore({ paper_trades: [{ trade_id: "t3", net_pnl: 0 }] }), { allowFreshAccount: true }).init();
  check("显式 allowFreshAccount 仍可建账户(测试/工具用)", allowed.created === true, JSON.stringify(allowed.created));

  // 5.5 通知表已进 schema,且存储层暴露退化原因
  const store = await createHistoryStore({ memory: true });
  eq("内存模式不算退化", [store.mode, store.degraded], ["memory", false]);
  const idbLike = await createHistoryStore({ memory: true });
  check("内存模式不产生 degraded_reason", idbLike.degraded_reason === null || idbLike.degraded_reason === undefined, String(idbLike.degraded_reason));
  check("通知历史持久化路径存在(put/get 可用)", typeof store.generic.put === "function" && typeof store.generic.all === "function");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("ATTRIBUTION OK");
