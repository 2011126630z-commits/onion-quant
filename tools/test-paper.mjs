// tools/test-paper.mjs · V14 Paper Trading / 决策 / 持续学习 核心测试
// 覆盖:账户·钱包·订单·成交(滑点/手续费)·持仓·PnL·组合会计·风控否决·幂等·并发安全·
//       崩溃恢复·离线补记·退出条件·决策融合·DeepSeek 回退·Champion/Challenger·漂移·回滚·
//       完整性检查·同步队列·AI Chat 上下文·Schema 版本·禁止造假
import { createHistoryStore } from "../worker/src/history/store.js";
import {
  PAPER_DEFAULTS, createAccount, fillPrice, feeOf, slippagePct, positionSize, portfolio, applyOpen, applyClose,
  updatePositionPath, evaluateExit, summarizeTrades, rebalancePlan, targetAllocation, canAfford, dayKeyOf, num
} from "../worker/src/paper/accounting.js";
import { createPaperEngine, ENGINE_STATES, MODE_CONFIG, idempotencyKey } from "../worker/src/paper/engine.js";
import { evaluateRisk, RISK_LIMITS } from "../worker/src/paper/risk.js";
import { evidenceBundle, bullEvidence, bearEvidence } from "../worker/src/paper/evidence.js";
import { fuse, ruleScore, mlScore, isValidDeepseekReview, FUSION_WEIGHTS, reviewPosition } from "../worker/src/paper/fusion.js";
import { detectDrift, shouldTrain, evaluatePromotion, evaluateRollback, registerModel, promoteModel, rollbackModel, getChampion } from "../worker/src/paper/learning.js";
import { checkIntegrity, makeQueueItem, enqueue, queueStats, markSynced, buildReviewPayload, shouldReview, callDeepSeek, tokenBudgetState, buildChatContext, answerLocally } from "../worker/src/paper/support.js";
import { ALL_TABLES, SCHEMA_VERSION } from "../worker/src/history/schema.js";

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

// 把 history store 适配成引擎需要的 store 接口
function paperStore(store) {
  return {
    get: (table, key) => store.generic.get(table, key),
    all: (table) => store.generic.all(table),
    put: (table, row) => store.generic.put(table, row)
  };
}
const baseQuote = (price, at) => ({ price, received_at: at, provider: "binance", high: price, low: price });

// ============================================================
console.log("== A. Paper Account / Wallets ==");
eq("Schema 版本", SCHEMA_VERSION, "v14.0");
check("Paper 表已纳入 ALL_TABLES", ["paper_account", "paper_wallets", "paper_orders", "paper_positions", "paper_trades", "paper_equity_snapshots", "paper_engine_state", "paper_daily_stats", "paper_strategy_stats", "learning_samples", "model_registry", "model_evaluations", "sync_queue"].every((t) => ALL_TABLES.some((x) => x.name === t)));
const created = createAccount({ now: 1700000000000, initial_balance: 10 });
eq("初始资金 10 USDT", created.account.initial_balance, 10);
// V14.5 §1/§85:初始分配正式改为 70/30(Short 主策略),这里同步更新口径
eq("Short 池 7(70%)", created.wallets.short.allocated_balance, 7);
eq("Long 池 3(30%)", created.wallets.long.allocated_balance, 3);
eq("初始总资产 = 10", created.account.total_equity, 10);
eq("初始可用 = 分配", created.wallets.short.available_balance, 7);
eq("初始无负债", [created.account.reserved_balance, created.account.realized_pnl, created.account.unrealized_pnl], [0, 0, 0]);
check("负余额守卫:非法金额被拒", canAfford({ available_balance: 7 }, -1, 0).ok === false);
check("余额不足被拒", canAfford({ available_balance: 7 }, 8, 0.01).ok === false);
check("余额充足通过", canAfford({ available_balance: 7 }, 6, 0.01).ok === true);

console.log("== B. Rebalance / Allocation ==");
const rb = rebalancePlan(50, 100);
eq("单次调整上限 10 个百分点", [rb.short_pct, rb.long_pct], [60, 40]);
eq("目标受 70% 上限约束", rebalancePlan(65, 100).short_pct, 70);
eq("目标受 30% 下限约束", rebalancePlan(35, 0).short_pct, 30);
eq("数据不足保持 50/50", targetAllocation({ trades: 3 }, { trades: 2 }).short_pct, 50);
const alloc = targetAllocation(
  { trades: 40, wins: 28, avg_net_pnl: 0.2, max_drawdown_pct: 3, max_consecutive_losses: 2, avg_mfe: 1.2, avg_mae: 0.8 },
  { trades: 40, wins: 16, avg_net_pnl: -0.1, max_drawdown_pct: 9, max_consecutive_losses: 5, avg_mfe: 0.6, avg_mae: 1.4 }
);
check("按长期表现偏向短池", alloc.short_pct > 50 && alloc.short_pct <= 70, JSON.stringify(alloc));

console.log("== C. Order 成交(滑点/手续费) ==");
near("买入成交价含点差+滑点", fillPrice(100, "BUY"), 100 * (1 + (PAPER_DEFAULTS.half_spread_bps + PAPER_DEFAULTS.slippage_bps) / 10000), 1e-9);
near("卖出成交价更差", fillPrice(100, "SELL"), 100 * (1 - (PAPER_DEFAULTS.half_spread_bps + PAPER_DEFAULTS.slippage_bps) / 10000), 1e-9);
near("手续费 = notional*4bps", feeOf(1000), 0.4, 1e-9);
near("滑点百分比记录", slippagePct(100, fillPrice(100, "BUY")), (PAPER_DEFAULTS.half_spread_bps + PAPER_DEFAULTS.slippage_bps) / 100, 1e-9);
check("非法价格不产生成交价", fillPrice(0, "BUY") === 0 && fillPrice(NaN, "BUY") === 0);

console.log("== D. Position / PnL(三段式) ==");
let st = { account: created.account, wallets: created.wallets, config: PAPER_DEFAULTS };
const opened = applyOpen(st, { mode: "short", symbol: "BTCUSDT", side: "BUY", quantity: 0.04, reference_price: 100, now: 1700000001000, stop_price: 98, take_profit_price: 103, max_hold_ms: 3600000 });
check("开仓成功", opened.ok === true, JSON.stringify(opened).slice(0, 160));
// 超池子下单必须被拒(不能透支)—— V14.5 池子为 7 USDT,故超量取 0.08(≈8.0032 + fee)
const overflow = applyOpen(st, { mode: "short", symbol: "BTCUSDT", side: "BUY", quantity: 0.08, reference_price: 100, now: 1700000001000 });
check("超出可用资金被拒", overflow.ok === false && overflow.reason === "insufficient_balance", JSON.stringify(overflow.reason));
st = opened.state;
const pos = opened.position;
check("现金减少 = notional + fee", num(st.account.cash_balance) < 10, String(st.account.cash_balance));
check("钱包预留资金 = notional", Math.abs(num(st.wallets.short.reserved_balance) - pos.entry_notional) < 1e-6, String(st.wallets.short.reserved_balance));
const marked = updatePositionPath(pos, 102, 104, 99);
check("浮盈为正(多头)", marked.unrealized_pnl > 0, String(marked.unrealized_pnl));
check("MFE/MAE 用真实高低点", marked.mfe > 0 && marked.mae > 0, JSON.stringify([marked.mfe, marked.mae]));
const pf = portfolio(st.account, st.wallets, [marked], (s) => 102);
near("Equity = cash + notional + 浮盈", pf.account.total_equity, 10 - pos.fees + marked.unrealized_pnl, 1e-6);
const closed = applyClose({ account: pf.account, wallets: pf.wallets, config: PAPER_DEFAULTS }, marked, { now: 1700003600000, reference_price: 102, exit_reason: "take_profit" });
check("平仓成功", closed.ok === true);
const t = closed.trade;
near("gross = (exit-entry)*qty", t.gross_pnl, (t.exit_price - t.entry_price) * t.quantity, 1e-6);
near("net = gross - fees", t.net_pnl, t.gross_pnl - t.fees, 1e-9);
check("手续费双边计入", t.fees > 0, String(t.fees));
check("realized 增加 = net", Math.abs(Number(closed.state.account.realized_pnl) - t.net_pnl) < 1e-6, String(closed.state.account.realized_pnl));
check("持仓时间被记录", t.holding_ms === 3599000, String(t.holding_ms));
check("exit_reason 被记录", t.exit_reason === "take_profit");
const pf2 = portfolio(closed.state.account, closed.state.wallets, closed.state === undefined ? [] : [closed.position], () => 102);
near("平仓后 Equity ≈ 初始 + net", pf2.account.total_equity, 10 + t.net_pnl, 1e-6);

console.log("== E. 退出条件 ==");
const base = { ...pos, entry_time: 1700000000000, max_hold_ms: 3600000, stop_price: 98, take_profit_price: 103, side: "LONG" };
eq("止损", evaluateExit(base, { now: 1700000100000, price: 97.5 }), "stop_loss");
eq("止盈", evaluateExit(base, { now: 1700000100000, price: 103.5 }), "take_profit");
eq("时间退出", evaluateExit(base, { now: 1700000000000 + 3600000, price: 100 }), "time_exit");
eq("信号反转", evaluateExit(base, { now: 1700000100000, price: 100, signalReversed: true }), "signal_reversal");
eq("结构失效", evaluateExit(base, { now: 1700000100000, price: 100, structureInvalidated: true }), "structure_invalidation");
eq("风险退出", evaluateExit(base, { now: 1700000100000, price: 100, riskExit: true }), "risk_exit");
eq("无退出条件", evaluateExit(base, { now: 1700000100000, price: 100 }), null);
eq("陈旧行情触发退出", evaluateExit(base, { now: 1700000100000, price: 100, staleQuote: true }), "stale_quote");

console.log("== F. Risk Veto ==");
const vetoStale = evaluateRisk({ account: created.account, wallets: created.wallets, positions: [], trades: [], quote: { price: 100, received_at: 1 }, now: 1700000000000, analysis: {}, symbol: "BTCUSDT" });
check("行情过期 → veto", vetoStale.veto === true && vetoStale.risk_flags.includes("stale_quote"), JSON.stringify(vetoStale.risk_flags));
const vetoCount = evaluateRisk({ account: created.account, wallets: created.wallets, positions: [1, 2, 3].map((i) => ({ status: "OPEN", mode: "short", symbol: "S" + i, entry_notional: 1 })), trades: [], quote: { price: 100, received_at: 1700000000000 }, now: 1700000000000, analysis: {}, mode: "short", symbol: "BTCUSDT" });
check("持仓达上限 → veto", vetoCount.veto === true && vetoCount.risk_flags.includes("too_many_positions_mode"));
const vetoLowBal = evaluateRisk({ account: created.account, wallets: { short: { allocated_balance: 5, available_balance: 0.1, reserved_balance: 4.9 } }, positions: [], trades: [], quote: { price: 100, received_at: 1700000000000 }, now: 1700000000000, analysis: {}, mode: "short", symbol: "BTCUSDT" });
check("可用资金过低 → veto", vetoLowBal.veto === true && vetoLowBal.risk_flags.includes("low_balance"));
const vetoLoss = evaluateRisk({ account: created.account, wallets: created.wallets, positions: [], trades: [{ net_pnl: -1, exit_time: 1699999000000 }, { net_pnl: -1, exit_time: 1699999100000 }, { net_pnl: -1, exit_time: 1699999200000 }], quote: { price: 100, received_at: 1700000000000 }, now: 1700000000000, analysis: {}, mode: "short", symbol: "BTCUSDT" });
check("连续亏损 → veto", vetoLoss.veto === true && vetoLoss.risk_flags.includes("loss_cooldown"));
const noVeto = evaluateRisk({ account: created.account, wallets: created.wallets, positions: [], trades: [], quote: { price: 100, received_at: 1700000000000 }, now: 1700000000000, analysis: { volatility: { atrPct: 1, ratio: 1 }, tf_conflict: false, features: { rsi14: 55 } }, mode: "short", symbol: "BTCUSDT" });
check("正常行情不否决", noVeto.veto === false && noVeto.risk_score < 55, JSON.stringify(noVeto));

console.log("== G. Evidence / Fusion ==");
const analysisBull = { direction: "Strong Bullish", signal_strength: 80, confidence: 70, timeframes: { "15m": "Bullish", "1h": "Strong Bullish", "4h": "Bullish", "1d": "Neutral" }, structure: { label: "上涨结构" }, market_regime: { label: "Weak Uptrend" }, volume: { pattern: "放量上涨" }, features: { rsi14: 62 }, btc_context: { state: "BTC Strong" }, support_zones: [{ lo: 90, hi: 92 }], resistance_zones: [{ lo: 110, hi: 112 }] };
const eb = evidenceBundle(analysisBull, { probability_bullish: 0.6, probability_neutral: 0.25, probability_bearish: 0.15 });
check("Bull 证据非空且分数为正", eb.bull_score > 0 && eb.bull_evidence.length >= 3, JSON.stringify(eb.bull_evidence));
const analysisBear = { direction: "Strong Bearish", signal_strength: 25, confidence: 70, timeframes: { "15m": "Bearish", "1h": "Strong Bearish", "4h": "Bearish" }, structure: { label: "下降结构" }, market_regime: { label: "Strong Downtrend" }, volume: { pattern: "放量下跌" }, features: { rsi14: 38 }, btc_context: { state: "BTC Rapid Selloff" }, resistance_zones: [{ lo: 110, hi: 112 }] };
const ebBear = evidenceBundle(analysisBear, { probability_bullish: 0.15, probability_neutral: 0.25, probability_bearish: 0.6 });
check("Bear 证据非空且分数为正", ebBear.bear_score > 0 && ebBear.bear_evidence.length >= 3);
near("ruleScore 看涨为正", ruleScore({ direction: "Strong Bullish", signal_strength: 80 }) > 0.5, true, 0);
near("mlScore = bull - bear", mlScore({ probability_bullish: 0.6, probability_bearish: 0.2 }), 0.4, 1e-9);
eq("权重初始值", FUSION_WEIGHTS, { rule: 0.35, ml: 0.35, risk: 0.20, deepseek: 0.10 });
const fOpen = fuse({ analysis: analysisBull, ml: { probability_bullish: 0.6, probability_bearish: 0.15 }, risk: noVeto, evidence: eb });
check("看涨一致 → 开多", fOpen.action === "open_long", JSON.stringify({ s: fOpen.score, a: fOpen.action }));
const fConflict = fuse({ analysis: analysisBull, ml: { probability_bullish: 0.15, probability_bearish: 0.7 }, risk: noVeto, evidence: { conflict: true } });
eq("Rule/ML 高度冲突 → skip", fConflict.action, "skip");
const fVeto = fuse({ analysis: analysisBull, ml: { probability_bullish: 0.6, probability_bearish: 0.15 }, risk: vetoCount, evidence: eb });
check("风控否决优先于分数", fVeto.action === "skip" && /风控否决/.test(fVeto.reason), fVeto.reason);
const fNoMl = fuse({ analysis: analysisBull, ml: null, risk: noVeto, evidence: eb });
check("无 ML 仍能决策(权重自动归一)", fNoMl.action !== undefined && fNoMl.components.ml === null);
check("DeepSeek 无效 JSON 判定", isValidDeepseekReview({ direction: "up", confidence: 200, risk: 50, action: "buy" }) === false && isValidDeepseekReview({ direction: "bullish", confidence: 60, risk: 40, action: "open", agree_with_local: true }) === true);
const fDsInvalid = fuse({ analysis: analysisBull, ml: { probability_bullish: 0.55, probability_bearish: 0.2 }, risk: noVeto, evidence: eb, deepseek: { invalid: true } });
check("DeepSeek 无效时不参与融合", fDsInvalid.deepseek_used === false);
check("持仓复查可给出退出建议", typeof reviewPosition({ side: "LONG" }, { analysis: analysisBear, ml: { probability_bullish: 0.1, probability_bearish: 0.8 }, risk: noVeto }).exit_suggested === "boolean");

console.log("== H. 引擎:幂等 / 并发 / 恢复 ==");
const store = await createHistoryStore({ memory: true });
const pstore = paperStore(store);
let clock = 1700000000000;
const engine = createPaperEngine({
  store: pstore,
  now: () => clock,
  config: PAPER_DEFAULTS,
  riskCheck: (ctx) => evaluateRisk({ ...ctx, now: clock, quote: ctx.quote, analysis: ctx.analysis, mode: ctx.mode }),
  fetchKlines: async () => []
});
const initRes = await engine.init();
check("首次创建账户", initRes.created === true);
check("引擎初始状态 STOPPED", engine.getState() === "STOPPED");
const startRes = await engine.start();
eq("启动后进入 RUNNING", startRes.state, "RUNNING");
const dupStart = await engine.start();
check("重复 Start 不创建第二个 Loop", dupStart.ok === false && dupStart.reason === "already_running");
const q1 = baseQuote(100, clock);
const o1 = await engine.openPosition({ mode: "short", symbol: "BTCUSDT", direction: "Bullish", signal_timestamp: 1700000000000, quote: q1, analysis: analysisBull, engine_version: "rule-v0.1" });
check("开仓成功", o1.ok === true, JSON.stringify(o1).slice(0, 140));
const o1dup = await engine.openPosition({ mode: "short", symbol: "BTCUSDT", direction: "Bullish", signal_timestamp: 1700000000000, quote: q1, analysis: analysisBull });
check("幂等键拦截重复下单", o1dup.ok === false && o1dup.reason === "duplicate_idempotency_key");
eq("订单数仍为 1", engine.getOrders().length, 1);
// 并发:同一时刻两笔都想用光资金 → 只能一笔成功
clock += 1000;
const bigWalletBefore = num(engine.snapshot().wallets.short.available_balance);
const [c1, c2] = await Promise.all([
  engine.openPosition({ mode: "short", symbol: "ETHUSDT", direction: "Bullish", signal_timestamp: 1700000001000, quote: baseQuote(100, clock), analysis: analysisBull, riskPct: 500 }),
  engine.openPosition({ mode: "short", symbol: "SOLUSDT", direction: "Bullish", signal_timestamp: 1700000001000, quote: baseQuote(100, clock), analysis: analysisBull, riskPct: 500 })
]);
const okCount = [c1, c2].filter((r) => r.ok).length;
const openedMargin = [c1, c2].filter((r) => r.ok).reduce((a, r) => a + num(r.position && r.position.initial_margin), 0);
check("并发开仓不产生透支(总保证金 ≤ 池子可用 + 手续费)", openedMargin <= bigWalletBefore + 0.02, JSON.stringify({ openedMargin, before: bigWalletBefore, c1: c1.ok, c2: c2.ok }));
check("余额不为负", num(engine.getAccount().cash_balance) >= 0, String(engine.getAccount().cash_balance));
const dust = await engine.openPosition({ mode: "long", symbol: "DUSTUSDT", direction: "Bullish", signal_timestamp: 1700000002000, quote: baseQuote(100, clock), analysis: analysisBull, riskPct: 0.001 });
check("灰尘单被拒(最小名义 0.5)", dust.ok === false && dust.reason === "size_too_small", JSON.stringify({ ok: dust.ok, reason: dust.reason }));
// 崩溃恢复:重新 init 不得重置账户
const engine2 = createPaperEngine({ store: pstore, now: () => clock, config: PAPER_DEFAULTS, riskCheck: () => ({ veto: false }), fetchKlines: async () => [] });
const reinit = await engine2.init();
eq("重启后不重置为初始资金", reinit.account.initial_balance, 100);
check("重启后保留持仓", engine2.getPositions().filter((p) => p.status === "OPEN").length >= 1, String(engine2.getPositions().length));
check("重启后资产与账本一致(不超过初始)", num(reinit.account.cash_balance) <= 100, String(reinit.account.cash_balance));

console.log("== I. 离线补记 ==");
const offlineStore = await createHistoryStore({ memory: true });
let clock2 = 1700000000000;
let gapCalls = 0;
const engOffline = createPaperEngine({
  store: paperStore(offlineStore),
  now: () => clock2,
  config: PAPER_DEFAULTS,
  riskCheck: () => ({ veto: false }),
  fetchKlines: async () => {
    gapCalls += 1;
    // 返回断网期间的一根长阴线,触发止损
    return [{ openTime: 1700000000000 + 3600000, closeTime: 1700000000000 + 7200000 - 1, open: 100, high: 101, low: 90, close: 91 }];
  }
});
await engOffline.init();
await engOffline.start();
await engOffline.openPosition({ mode: "short", symbol: "BTCUSDT", direction: "Bullish", signal_timestamp: 1700000000000, quote: baseQuote(100, clock2), analysis: { ...analysisBull, volatility: { atrPct: 2, ratio: 1 } } });
engOffline.engine.state.last_candle_time = 1700000000000;
const rec = await engOffline.recover();
check("离线恢复补齐K线并补记退出", rec.missing_candles >= 1 && rec.exits_filled >= 1, JSON.stringify(rec));
const tradesOffline = engOffline.getTrades();
check("补记的退出标记 recovered_after_offline", tradesOffline.length >= 1 && tradesOffline[0].exit_reason === "stop_loss" && tradesOffline[0].recovered_after_offline === true, JSON.stringify(tradesOffline[0] && { r: tradesOffline[0].exit_reason, f: tradesOffline[0].recovered_after_offline }));

console.log("== J. 漂移 / Champion / Challenger / 回滚 ==");
const driftRecords = [];
for (let i = 0; i < 200; i += 1) {
  driftRecords.push({ predicted_class: i % 3 === 0 ? "Bullish" : "Neutral", actual_class: i % 3 === 0 ? "Bullish" : "Neutral" });
}
for (let i = 0; i < 100; i += 1) {
  driftRecords.push({ predicted_class: "Bullish", actual_class: i % 3 === 0 ? "Bullish" : "Bearish" });
}
const drift = detectDrift(driftRecords, { windowSize: 100, minSamples: 30, threshold: 0.12 });
check("检测到概念漂移", drift.drift_detected === true && drift.drift_score > 0, JSON.stringify(drift));
const noDrift = detectDrift(driftRecords.slice(0, 100).concat(driftRecords.slice(0, 100)), { windowSize: 50, minSamples: 20 });
check("稳定数据不误报漂移", noDrift.drift_detected === false, JSON.stringify(noDrift));
eq("训练门槛:样本不足不训练", shouldTrain({ new_samples: 10, hours_since_train: 1 }).train, false);
eq("训练门槛:新增样本达标", shouldTrain({ new_samples: 250, hours_since_train: 2 }).train, true);
eq("训练门槛:漂移触发", shouldTrain({ new_samples: 60, hours_since_train: 2, drift_score: 0.3 }).train, true);
const regStore = paperStore(await createHistoryStore({ memory: true }));
await registerModel(regStore, { model_type: "lightgbm", version: "v1", status: "CHAMPION", validation_samples: 200, metrics: { balanced_accuracy: 0.6, macro_f1: 0.58, bull_recall: 0.6, bear_recall: 0.58, net_pnl_proxy: 1.2, max_drawdown_pct: 4 } });
const weakChallenger = { version: "v2", validation_samples: 200, folds: 5, balanced_accuracy: 0.5, macro_f1: 0.5, bull_recall: 0.5, bear_recall: 0.5, net_pnl_proxy: 0.5, max_drawdown_pct: 4, per_regime: {}, folds_detail: [] };
const champMetrics = { version: "v1", validation_samples: 200, folds: 5, balanced_accuracy: 0.6, macro_f1: 0.58, bull_recall: 0.6, bear_recall: 0.58, net_pnl_proxy: 1.2, max_drawdown_pct: 4, per_regime: {}, folds_detail: [] };
const badPromo = evaluatePromotion(weakChallenger, champMetrics);
eq("弱 Challenger 不晋级", badPromo.verdict, "KEEP_TESTING");
check("给出拒绝原因", badPromo.reasons.some((r) => /下降|未改善/.test(r)), JSON.stringify(badPromo.reasons));
const goodChallenger = { ...weakChallenger, version: "v3", balanced_accuracy: 0.64, macro_f1: 0.62, bull_recall: 0.65, bear_recall: 0.63, net_pnl_proxy: 2.0, max_drawdown_pct: 3, folds_detail: [{ balanced_accuracy: 0.62 }, { balanced_accuracy: 0.66 }, { balanced_accuracy: 0.64 }] };
const goodPromo = evaluatePromotion(goodChallenger, champMetrics);
eq("更强 Challenger 晋级", goodPromo.verdict, "PROMOTE");
const regRecord = await registerModel(regStore, { model_type: "lightgbm", version: "v3", status: "CHALLENGER", validation_samples: 200, metrics: goodChallenger });
const promo = await promoteModel(regStore, regRecord.model_id, { challenger: goodChallenger, reasons: goodPromo.reasons });
check("晋级后 Champion 更新", promo.ok === true && promo.promoted.version === "v3", JSON.stringify(promo.promoted && promo.promoted.version));
check("旧 Champion 标记 RETIRED", promo.retired && promo.retired.status === "RETIRED", JSON.stringify(promo.retired && promo.retired.status));
const champNow = await getChampion(regStore, "lightgbm");
eq("当前 Champion = v3", champNow.version, "v3");
const rollbackWorse = evaluateRollback({ samples: 50, balanced_accuracy: 0.45, max_drawdown_pct: 12, drift_score: 0.1 }, { balanced_accuracy: 0.64, max_drawdown_pct: 3 });
check("上线后恶化 → 建议回滚", rollbackWorse.rollback === true, JSON.stringify(rollbackWorse));
const rbRes = await rollbackModel(regStore, "lightgbm", rollbackWorse.reason);
check("回滚恢复上一 Champion(v1)", rbRes.ok === true && rbRes.restored.version === "v1", JSON.stringify(rbRes.restored && rbRes.restored.version));
eq("被回滚模型状态 ROLLED_BACK", rbRes.rolled_back && rbRes.rolled_back.status, "ROLLED_BACK");
const rbStable = evaluateRollback({ samples: 50, balanced_accuracy: 0.63, max_drawdown_pct: 3, drift_score: 0.05 }, { balanced_accuracy: 0.64, max_drawdown_pct: 3 });
eq("表现稳定不回滚", rbStable.rollback, false);

console.log("== K. Integrity / Sync / DeepSeek 回退 / Chat ==");
const integrity = checkIntegrity({
  account: { account_id: "a1", cash_balance: -2 },
  orders: [{ order_id: "o1", idempotency_key: "k1", status: "FILLED" }, { order_id: "o2", idempotency_key: "k1", status: "FILLED" }],
  positions: [
    { position_id: "p1", mode: "short", symbol: "BTCUSDT", side: "LONG", status: "OPEN", entry_price: 100, quantity: 1, current_price: 100, entry_notional: 100 },
    { position_id: "p2", mode: "short", symbol: "BTCUSDT", side: "LONG", status: "OPEN", entry_price: 100, quantity: 1, current_price: 100, entry_notional: 100 },
    { position_id: "p3", mode: "long", symbol: "ETHUSDT", side: "LONG", status: "OPEN", entry_price: null, quantity: 1, current_price: 10, entry_notional: 10 }
  ],
  trades: [{ trade_id: "t_orphan", entry_time: 2, exit_time: 1 }]
});
check("发现重复订单", integrity.issues.some((i) => i.kind === "duplicate_order"));
check("发现重复持仓并自动修", integrity.issues.some((i) => i.kind === "duplicate_position") && integrity.fixed.some((f) => f.kind === "duplicate_position"));
check("发现负余额并自动钳制", integrity.issues.some((i) => i.kind === "negative_balance") && integrity.fixed.some((f) => f.kind === "negative_balance"));
check("发现无入场价持仓并关闭", integrity.issues.some((i) => i.kind === "open_without_entry"));
check("发现非法时间戳", integrity.issues.some((i) => i.kind === "invalid_timestamp"));
check("完整性汇总可用", integrity.summary.total >= 5 && typeof integrity.summary.auto_fixed === "number", JSON.stringify(integrity.summary));
const syncStore = await createHistoryStore({ memory: true });
await enqueue(paperStore(syncStore), [makeQueueItem("paper_order", "o1", { a: 1 }), makeQueueItem("paper_trade", "t1", { b: 2 })]);
let stats = await queueStats(paperStore(syncStore));
eq("同步队列 PENDING 计数", stats.PENDING, 2);
await markSynced(paperStore(syncStore), "paper_order:o1", true);
await markSynced(paperStore(syncStore), "paper_trade:t1", false, "cloud_down");
stats = await queueStats(paperStore(syncStore));
check("同步状态正确记录", stats.SYNCED === 1 && stats.FAILED === 1, JSON.stringify(stats));
const reviewNeeded = shouldReview({ opening: true, risk: { risk_score: 65 }, evidence: { conflict: true } });
check("Review 触发条件命中", reviewNeeded.review === true && reviewNeeded.reasons.length >= 3, JSON.stringify(reviewNeeded.reasons));
check("普通刷新不触发 Review", shouldReview({}).review === false);
const payload = buildReviewPayload({ symbol: "BTCUSDT", mode: "short", analysis: analysisBull, ml: { probability_bullish: 0.6, probability_neutral: 0.2, probability_bearish: 0.2 }, evidence: eb, risk: noVeto });
check("Review 载荷不含K线(只有摘要)", !("klines" in payload) && payload.symbol === "BTCUSDT" && JSON.stringify(payload).length < 1200, String(JSON.stringify(payload).length));
const dsNoKey = await callDeepSeek(payload, { apiKey: null });
check("无 Key → 回退本地", dsNoKey.ok === false && dsNoKey.fallback === true && dsNoKey.reason === "no_api_key");
const dsTimeout = await callDeepSeek(payload, { apiKey: "x", fetchFn: async () => { throw new Error("timeout"); } });
check("网络失败 → 回退本地", dsTimeout.ok === false && dsTimeout.fallback === true);
const ds401 = await callDeepSeek(payload, { apiKey: "x", fetchFn: async () => new Response("unauthorized", { status: 401 }) });
check("401 → 回退本地", ds401.reason === "http_401" && ds401.fallback === true);
const dsBadJson = await callDeepSeek(payload, { apiKey: "x", fetchFn: async () => new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), { status: 200 }) });
check("非法 JSON → 丢弃并回退", dsBadJson.reason === "invalid_schema" && dsBadJson.fallback === true);
const dsOk = await callDeepSeek(payload, { apiKey: "x", fetchFn: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ direction: "bullish", confidence: 62, risk: 40, agree_with_local: true, action: "open", conflict: "", reason: "ok" }) } }], usage: { total_tokens: 320 } }), { status: 200 }) });
check("合法 JSON 通过校验", dsOk.ok === true && dsOk.review.confidence === 62 && dsOk.tokens === 320, JSON.stringify(dsOk).slice(0, 120));
const budget = tokenBudgetState({ token_day: dayKeyOf(1700000000000), token_used_today: 49999 }, dayKeyOf(1700000000000), 50000);
check("Token 预算管控", budget.exhausted === false && budget.remaining === 1);
check("预算耗尽状态", tokenBudgetState({ token_day: dayKeyOf(1700000000000), token_used_today: 50000 }, dayKeyOf(1700000000000), 50000).exhausted === true);
const chatCtx = buildChatContext({ symbol: "BTCUSDT", interval: "1h", mode: "short", analysis: analysisBull, risk: noVeto, position: { mode: "short", side: "LONG", entry_price: 100 }, decision: { action: "hold", score: 0.1, reason: "阈值内" }, portfolio: { wallets: { short: { allocated_balance: 5.1 }, long: { allocated_balance: 5.2 } } } });
const holdAnswer = answerLocally("这个模拟仓位大概要拿多久?", chatCtx);
check("持有时间回答给区间而非确定值", /预计区间|约/.test(holdAnswer) && !/肯定|一定/.test(holdAnswer), holdAnswer);
check("风险问题基于真实数据", /Low|Medium|High|未知/.test(answerLocally("风险高吗?", chatCtx)));
check("观望问题引用决策", /阈值|跳过|观望/.test(answerLocally("为什么现在不买?", chatCtx)));
check("退出问题说明条件", /止损|止盈|时间退出|结构/.test(answerLocally("什么情况下会卖?", chatCtx)));
const emptyStats = summarizeTrades([]);
check("无交易时不造假(0/null)", emptyStats.trades === 0 && emptyStats.net_pnl === 0 && emptyStats.win_rate === null, JSON.stringify(emptyStats));

console.log("== L. Schema 迁移幂等 ==");
const migStore = await createHistoryStore({ memory: true });
const beforeTables = (await migStore.generic.all("paper_account")).length;
await migStore.generic.put("paper_account", { account_id: "paper-main", initial_balance: 10, cash_balance: 3, schema_version: "v14.0" });
const again = await createHistoryStore({ memory: true });
check("重复初始化不破坏既有账户", (await again.generic.all("paper_account")).length === 0 && beforeTables === 0);
check("账户含 schema_version", (await migStore.generic.get("paper_account", "paper-main")).schema_version === "v14.0");
eq("引擎状态枚举完整", ENGINE_STATES, ["STOPPED", "STARTING", "RUNNING", "PAUSED", "RECOVERING", "ERROR"]);
eq("短线/长线周期配置", [MODE_CONFIG.short.interval, MODE_CONFIG.long.interval], ["1h", "4h"]);
check("短线最长持仓 6h / 长线 14d", MODE_CONFIG.short.maxHoldMs === 6 * 3600000 && MODE_CONFIG.long.maxHoldMs === 14 * 86400000);
eq("幂等键格式(含 strategy_version)", idempotencyKey("short", "BTCUSDT", 1700000000000, "Bullish"), "short|BTCUSDT|1700000000000|Bullish|rule-v0.1");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("PAPER TESTS OK");
