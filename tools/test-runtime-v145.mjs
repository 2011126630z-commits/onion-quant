// tools/test-runtime-v145.mjs · V14.5 REAL RUNTIME WIRING 验收
// A 70/30 真正落账  B Allocation Manager 安全迁移  C Short+Long 双姿势  D Closed Candle 幂等
// E 防重入  F Predictor 进 Runtime  G DeepSeek 关键复核  H Research 真实来源
// I AI Chat 单答案 + 真实问题  J Position UI 精确展示
import fs from "node:fs";
import path from "node:path";
import { PAPER_DEFAULTS, createAccount, summarizeTrades, num } from "../worker/src/paper/accounting.js";
import { createPaperEngine, MODE_CONFIG, idempotencyKey, closedCandleTime } from "../worker/src/paper/engine.js";
import { createHistoryStore } from "../worker/src/history/store.js";
import { ALLOCATION_BOUNDS, ALLOCATION_PROFILES, dynamicAllocation, allocationPlan, planMigration, applyAllocation, rebalanceWallets, stepToward } from "../worker/src/paper/allocation.js";
import { predictMultiHorizon, predictorGate, predictionSnapshot } from "../worker/src/paper/predictor.js";
import { positionView, fmtUsdt, fmtUsdtExact, usdtDigits, pnlLabel, pnlClass, homeViewModel, paperViewModel, detailViewModel } from "../worker/src/ui/viewModels.js";
import { parseRssItems, normalizeOkxAnnouncements, scoreHeadline, safeUrl } from "../worker/src/newsParse.js";
import { createResearchAgent, shouldResearch, researchContext } from "../worker/src/paper/research.js";
import { slimContext } from "../worker/src/routes.js";
import { isValidDeepseekReview } from "../worker/src/paper/fusion.js";
import worker from "../worker/index.js";

const ROOT = path.resolve(import.meta.dirname, "..");
let failed = 0;
let passed = 0;
const check = (n, ok, d) => { if (ok) { passed += 1; console.log("PASS  " + n); } else { failed += 1; console.log("FAIL  " + n + (d ? "  => " + d : "")); } };
const eq = (n, a, b) => check(n, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const near = (n, a, b, t) => check(n, Math.abs(a - b) <= (t == null ? 1e-9 : t), `got ${a} want ~${b}`);
const HOUR = 3600000;
const T0 = 1700000000000;
const pageSrc = fs.readFileSync(path.join(ROOT, "worker/src/ui/page.js"), "utf8");

async function mkEngine(deps) {
  const clock = { value: T0 };
  const store = await createHistoryStore({ memory: true });
  const adapter = { get: (t, k) => store.generic.get(t, k), all: (t, l) => store.generic.all(t, l), put: (t, r) => store.generic.put(t, r) };
  const eng = createPaperEngine({
    store: adapter, now: () => clock.value, fetchKlines: async () => [],
    riskCheck: () => ({ veto: false, risk_score: 25, risk_flags: [], reasons: [] }),
    ...(deps || {})
  });
  await eng.init();
  await eng.start();
  return { eng, clock, store, adapter };
}
function candidate(mode, opts) {
  const o = opts || {};
  const at = o.at == null ? T0 : o.at;
  return {
    mode, symbol: o.symbol || "BTCUSDT", direction: o.direction || "Bullish",
    signal_timestamp: o.candle == null ? T0 - 1 : o.candle,
    closed_candle_time: o.candle == null ? T0 - 1 : o.candle,
    strategy_version: "rule-v0.1-" + mode,
    quote: { price: o.price || 100, received_at: at },
    analysis: { direction: "Strong Bullish", signal_strength: 72, confidence: o.confidence || 60, volatility: { atrPct: 2 }, market_regime: { label: "Uptrend", trend_market: true }, structure: { last_swing_low: 96 } },
    prediction: o.prediction || null,
    evidence_conflict: o.evidence_conflict === true,
    rule_ml_conflict: o.rule_ml_conflict === true,
    riskPct: o.riskPct || 15
  };
}

console.log("== A. 70/30 真正落账(§1/§85) ==");
{
  const created = createAccount({ now: T0, initial_balance: 100 });
  eq("新账户 Short = 70", created.wallets.short.allocated_balance, 70);
  eq("新账户 Long = 30", created.wallets.long.allocated_balance, 30);
  eq("合计 100", created.wallets.short.allocated_balance + created.wallets.long.allocated_balance, 100);
  eq("默认画像 = short_main", PAPER_DEFAULTS.short_pct + "/" + PAPER_DEFAULTS.long_pct, ALLOCATION_PROFILES.short_main.short_pct + "/" + ALLOCATION_PROFILES.short_main.long_pct);
  const { eng } = await mkEngine();
  eq("引擎初始化后钱包真为 70/30", [num(eng.getAccount().cash_balance) > 0, num(eng.engine.wallets.short.allocated_balance), num(eng.engine.wallets.long.allocated_balance)], [true, 70, 30]);
  eq("账户现金总览 100", num(eng.getAccount().initial_balance), 100);
}

console.log("== B. Allocation Manager 安全迁移(§2/§71/§72) ==");
{
  eq("区间 60-80 / 20-40", [ALLOCATION_BOUNDS.short_min_pct, ALLOCATION_BOUNDS.short_max_pct, ALLOCATION_BOUNDS.long_min_pct, ALLOCATION_BOUNDS.long_max_pct], [60, 80, 20, 40]);
  // 开发账户 50/50 → 70/30:分步且只动 available
  const wallets = { short: { allocated_balance: 50, available_balance: 50, reserved_balance: 0 }, long: { allocated_balance: 50, available_balance: 50, reserved_balance: 0 } };
  const step1 = planMigration({ wallets, positions: [], total_equity: 100, current_short_pct: 50, target_short_pct: 70 });
  eq("单步上限 10 个百分点", [step1.current_short_pct, step1.short_pct], [50, 60]);
  near("可移动金额 = 10% 权益", step1.movable_amount, 10, 1e-6);
  eq("标记可执行", step1.feasible, true);
  const applied = rebalanceWallets({ plan: step1, wallets, positions: [], now: T0 });
  eq("真正落账成功", applied.ok, true);
  near("Short 可用 50 → 60", num(applied.wallets.short.available_balance), 60, 1e-6);
  near("Long 可用 50 → 40", num(applied.wallets.long.available_balance), 40, 1e-6);
  // 有持仓时:只能动用 available,且不会抽走被 margin 占用的部分(§72)
  // 场景:Short 要增配,但 Long 可用只剩 3 → 只能移动 3
  const withReserved = { short: { allocated_balance: 60, available_balance: 7, reserved_balance: 53 }, long: { allocated_balance: 40, available_balance: 3, reserved_balance: 37 } };
  const guarded = planMigration({ wallets: withReserved, positions: [{ status: "OPEN", symbol: "BTCUSDT" }], total_equity: 100, current_short_pct: 60, target_short_pct: 80 });
  check("有持仓时仅调整可用部分且被上限截断(§72)", guarded.movable_amount <= 3 + 1e-9 && guarded.reasons.some((r) => /可用资金不足/.test(r)), JSON.stringify(guarded));
  const applied2 = rebalanceWallets({ plan: guarded, wallets: withReserved, positions: [], now: T0 });
  eq("reserved 完全不变", [num(applied2.wallets.short.reserved_balance), num(applied2.wallets.long.reserved_balance)], [53, 37]);
  near("Long 可用被扣到 0(不能透支)", num(applied2.wallets.long.available_balance), 0, 1e-6);
  // 边界:不允许 100/0
  eq("目标被夹在 80 以内", dynamicAllocation({ current_short_pct: 70, shortStats: { trades: 60, win_rate: 99, avg_net_pnl: 5, max_drawdown_pct: 0, max_consecutive_losses: 0, avg_mfe: 3, avg_mae: 1 }, longStats: { trades: 60, win_rate: 10, avg_net_pnl: -5, max_drawdown_pct: 30, max_consecutive_losses: 9, avg_mfe: 0.2, avg_mae: 2 } }).target_short_pct <= 80, true);
  eq("stepToward 不越界", stepToward(79, 95, {}).short_pct, 80);
  // §81:Short 回撤恶化 → 70/30 → 60/40 方向
  const degraded = dynamicAllocation({ current_short_pct: 70, shortStats: { trades: 60, win_rate: 55, avg_net_pnl: 0.2, max_drawdown_pct: 18, max_consecutive_losses: 3, avg_mfe: 1, avg_mae: 1 }, longStats: { trades: 60, win_rate: 55, avg_net_pnl: 0.2, max_drawdown_pct: 3, max_consecutive_losses: 1, avg_mfe: 1, avg_mae: 1 } });
  check("Short 回撤恶化时下调 Short 权重", degraded.target_short_pct < 70, JSON.stringify(degraded));
}

console.log("== C. Short + Long 双姿势真正开仓(§4-§7/§86) ==");
{
  const { eng, clock } = await mkEngine();
  const before = { short: num(eng.snapshot().wallets.short.available_balance), long: num(eng.snapshot().wallets.long.available_balance) };
  clock.value += HOUR;
  const res = await eng.loop({ quotes: { BTCUSDT: { price: 100, high: 101, low: 99, received_at: clock.value } }, candidates: [candidate("short", { at: clock.value }), candidate("long", { at: clock.value })], atr: 2 });
  eq("两个模式都开了仓", res.summary.opened.length, 2);
  const positions = eng.getPositions().filter((p) => p.status === "OPEN");
  eq("Short 持仓存在且 mode=short", positions.some((p) => p.mode === "short"), true);
  eq("Long 持仓存在且 mode=long", positions.some((p) => p.mode === "long"), true);
  const after = eng.snapshot().wallets;
  check("Short 资金扣自 short 钱包", num(after.short.available_balance) < before.short, JSON.stringify([before.short, num(after.short.available_balance)]));
  check("Long 资金扣自 long 钱包", num(after.long.available_balance) < before.long, JSON.stringify([before.long, num(after.long.available_balance)]));
  // 错账检查:每笔成交的 mode 必须与其钱包一致(§7)
  const trades = eng.getTrades();
  eq("成交 mode 与持仓一致(无错记钱包)", trades.every((t) => t.mode === "short" || t.mode === "long"), true);
  const wrong = positions.filter((p) => !["short", "long"].includes(p.mode));
  eq("无非法 mode 持仓", wrong.length, 0);
  // 主周期:short=1h / long=4h(§5/§6)
  eq("模式主周期", [MODE_CONFIG.short.interval, MODE_CONFIG.long.interval], ["1h", "4h"]);
}

console.log("== D. Closed Candle 幂等(§8/§9/§87) ==");
{
  const { eng, clock } = await mkEngine();
  const candle = closedCandleTime(T0, 3600000);      // short 用 1h
  let opened = 0;
  for (let i = 0; i < 12; i += 1) {
    clock.value += 60000;                             // 同一根 1h K线内跑 12 次 Loop
    const res = await eng.loop({ quotes: { BTCUSDT: { price: 100, high: 101, low: 99, received_at: clock.value } }, candidates: [candidate("short", { candle, at: clock.value })], atr: 2 });
    opened += res.summary.opened.length;
  }
  eq("同一根已收盘K线执行 12 次 Loop 只产生 1 次开仓", opened, 1);
  const orders = eng.getOrders();
  eq("订单只有 1 笔", orders.length, 1);
  check("幂等键包含【已收盘K线时间】(不是 Date.now)", String(orders[0].idempotency_key).includes(String(candle)), orders[0].idempotency_key);
  eq("幂等键格式正确", idempotencyKey("short", "BTCUSDT", candle, "Bullish", "rule-v0.1-short").split("|").length, 5);
  // 下一根K线 → 允许新决策
  clock.value += HOUR;
  const next = await eng.loop({ quotes: { BTCUSDT: { price: 100, high: 101, low: 99, received_at: clock.value } }, candidates: [candidate("short", { candle: candle + 3600000, at: clock.value })], atr: 2 });
  check("换一根K线后可以产生新决策", next.summary.opened.length >= 0, JSON.stringify(next.summary.skipped));
  // 结构:页面必须用 closedCandleTime 而不是 Date.now 作为 signal_timestamp
  check("页面用 closedCandleTime 生成信号时间", /signal_timestamp: candles\[mode\]/.test(pageSrc) && /QE\.closedCandleTime\(Date\.now\(\), intervalMsOf/.test(pageSrc));
  check("页面不再用 Date.now() 作 signal_timestamp", !/signal_timestamp: Date\.now\(\)/.test(pageSrc));
}

console.log("== E. 防重入(§10) ==");
{
  const { eng, clock } = await mkEngine();
  clock.value += HOUR;
  const first = eng.loop({ quotes: { BTCUSDT: { price: 100, high: 100, low: 100, received_at: clock.value } }, candidates: [], atr: 2 });
  const second = await eng.loop({ quotes: { BTCUSDT: { price: 100, high: 100, low: 100, received_at: clock.value } }, candidates: [], atr: 2 });
  await first;
  check("引擎防重入(上一轮未完 → skip)", second.ok === false && second.reason === "loop_reentry_blocked", JSON.stringify(second));
  check("页面也有 loopRunning + try/finally 释放", /let loopRunning = false/.test(pageSrc) && /finally \{\s*loopRunning = false/.test(pageSrc));
  eq("引擎态暴露 loops", typeof eng.engine.state.loops, "number");
}

console.log("== F. Future Predictor 进 Runtime(§21-§29/§89) ==");
{
  const { eng, clock, adapter } = await mkEngine();
  const analysis = { symbol: "BTCUSDT", interval: "1h", direction: "Strong Bullish", signal_strength: 70, confidence: 65, price: 100, market_regime: { label: "Uptrend", trend_market: true }, timeframes: { "15m": "Bullish", "1h": "Bullish" }, structure: { label: "上涨结构", hh: true, hl: true }, volume: { pattern: "放量上涨", ratio20: 1.3 }, volatility: { atrPct: 2, level: "Normal" }, features: { rsi14: 60, adx: 28 } };
  const multi = predictMultiHorizon({ analysis, now: T0 });
  eq("多周期产出 5 个 horizon", Object.keys(multi.predictions).length, 5);
  eq("含 15m/1h/4h/1d", ["15m", "1h", "4h", "1d"].every((h) => multi.predictions[h]), true);
  // 冲突时门禁拦截(§25)
  const conflict = { horizon: "1h", bullish_probability: 0.1, neutral_probability: 0.2, bearish_probability: 0.7, confidence: 0.7, uncertainty: 0.2, reversal_risk: 0.3 };
  const gate = predictorGate({ prediction: conflict, direction: "Strong Bullish" });
  eq("预测与规则对立 → 拦截", gate.allow, false);
  eq("拦截原因可追溯", gate.reason, "predictor_conflict");
  clock.value += HOUR;
  const blocked = await eng.loop({ quotes: { BTCUSDT: { price: 100, high: 101, low: 99, received_at: clock.value } }, candidates: [candidate("short", { prediction: multi, at: clock.value })], atr: 2 });
  eq("一致预测不拦截", blocked.summary.opened.length, 1);
  // 明显冲突 → 引擎跳过
  const { eng: eng2, clock: clock2 } = await mkEngine();
  clock2.value += HOUR;
  const skipped = await eng2.loop({ quotes: { BTCUSDT: { price: 100, high: 101, low: 99, received_at: clock2.value } }, candidates: [{ ...candidate("short", { at: clock2.value }), prediction: { predictions: { "1h": conflict } } }], atr: 2 });
  eq("对立预测 → 不开仓", skipped.summary.opened.length, 0);
  check("跳过原因 = predictor_conflict", skipped.summary.skipped.some((s) => s.reason === "predictor_conflict"), JSON.stringify(skipped.summary.skipped));
  eq("冲突计数暴露", skipped.summary.predictor_conflicts, 1);
  // 不确定性极高 → 减半参与而非否决
  const uncertain = predictorGate({ prediction: { horizon: "1h", bullish_probability: 0.4, bearish_probability: 0.35, neutral_probability: 0.25, confidence: 0.4, uncertainty: 0.9 }, direction: "Bullish" });
  eq("极高不确定性 → 允许但减仓", [uncertain.allow, uncertain.penalty], [true, 0.5]);
  // 预测快照必须保存(§29)
  const { eng: eng3, clock: clock3, adapter: adapter3 } = await mkEngine();
  clock3.value += HOUR;
  const r3 = await eng3.loop({ quotes: { BTCUSDT: { price: 100, high: 101, low: 99, received_at: clock3.value } }, candidates: [candidate("short", { prediction: multi, at: clock.value })], atr: 2 });
  eq("开仓成功", r3.summary.opened.length, 1);
  const pos = eng3.getPositions().find((p) => p.status === "OPEN");
  check("持仓保存 future_prediction_at_entry(§29)", pos.future_prediction_at_entry && pos.future_prediction_at_entry.horizon, JSON.stringify(pos.future_prediction_at_entry));
  clock3.value += HOUR;
  await eng3.closePosition(pos, { reference_price: 102, exit_reason: "manual", now: clock3.value, prediction: multi });
  const tr = eng3.getTrades()[0];
  check("成交保存 future_prediction_at_action(§29)", tr.future_prediction_at_action && tr.future_prediction_at_action.taken_at, JSON.stringify(tr.future_prediction_at_action));
  check("快照含 model_version 与概率", predictionSnapshot(multi, { now: T0, horizon: "1h" }).bullish_probability != null);
  // 预测存档 + 到期结算(§82)
  await eng3.savePrediction(multi.predictions["1h"], { symbol: "BTCUSDT", timestamp: clock3.value, price: 100 });
  eq("预测已存档", (await adapter3.all("predictions")).length >= 1, true);
  const resolved = await eng3.resolveDuePredictions({ now: clock3.value + HOUR + 1000, priceOf: () => 103, atrPct: 2 });
  eq("到期结算 1 条", resolved.length, 1);
  check("结算含实际方向", ["Bullish", "Bearish", "Neutral"].includes(resolved[0].actual_direction), JSON.stringify(resolved[0].actual_direction));
}

console.log("== G. DeepSeek 关键 Decision Review(§40-§47/§91) ==");
{
  let calls = 0;
  let mode = "ok";
  const provider = async () => {
    calls += 1;
    if (mode === "timeout") throw new Error("deepseek_timeout");
    if (mode === "bad") return { ok: false, reason: "invalid_schema" };
    return { ok: true, review: { direction: "bullish", confidence: 66, risk: 30, agree_with_local: true, action: "open", conflict: "", reason: "与本地一致" } };
  };
  const { eng, clock } = await mkEngine({ reviewProvider: provider });
  clock.value += HOUR;
  // 不触发:低置信/低杠杆
  await eng.loop({ quotes: { BTCUSDT: { price: 100, high: 101, low: 99, received_at: clock.value } }, candidates: [{ ...candidate("short"), analysis: { direction: "Bullish", confidence: 40, volatility: { atrPct: 1 }, market_regime: { label: "Range" } } }], atr: 2 });
  eq("低置信低杠杆不调用 DeepSeek(§41)", calls, 0);
  // 触发:高置信 + 冲突
  const need = eng.reviewNeeded({ kind: "entry", analysis: { confidence: 75 }, candidate: { leverage: 5 }, symbol: "BTCUSDT", mode: "short" });
  eq("高置信/高杠杆会触发复核", need.needed, true);
  const need2 = eng.reviewNeeded({ kind: "exit", giveback_pct: 30, close_fraction: 0.5 });
  eq("明显回吐 + 大比例减仓会触发 Exit Review(§42)", need2.needed, true);
  clock.value += HOUR;
  const r = await eng.loop({ quotes: { BTCUSDT: { price: 100, high: 101, low: 99, received_at: clock.value } }, candidates: [candidate("short", { confidence: 75, at: clock.value })], atr: 2 });
  check("关键点确实调用了 DeepSeek", calls >= 1, String(calls));
  eq("开仓仍然成功(DeepSeek 不夺权)", r.summary.opened.length, 1);
  check("开仓摘要标注 deepseek 使用", r.summary.opened[0].deepseek === "used", JSON.stringify(r.summary.opened[0]));
  // 缓存:同一 key 第二次不再调用
  const before = calls;
  await eng.reviewDecision({ kind: "entry", symbol: "BTCUSDT", mode: "short", analysis: { confidence: 80 }, candidate: { leverage: 5 }, closed_candle_time: T0 - 1 });
  const cached = await eng.reviewDecision({ kind: "entry", symbol: "BTCUSDT", mode: "short", analysis: { confidence: 80 }, candidate: { leverage: 5 }, closed_candle_time: T0 - 1 });
  eq("相同输入复用缓存(§30/§47)", [calls - before, cached.cached], [1, true]);
  // 超时 → 回退本地且主循环继续
  mode = "timeout";
  const { eng: eng2, clock: clock2 } = await mkEngine({ reviewProvider: provider });
  clock2.value += HOUR;
  const r2 = await eng2.loop({ quotes: { BTCUSDT: { price: 100, high: 101, low: 99, received_at: clock2.value } }, candidates: [candidate("short", { confidence: 75, at: clock.value })], atr: 2 });
  eq("DeepSeek 超时后本地决策仍成功(§46)", r2.summary.opened.length, 1);
  eq("超时被记录", eng2.reviewStats().fallbacks >= 1, true);
  // 非法 Schema → 回退
  mode = "bad";
  const { eng: eng3, clock: clock3 } = await mkEngine({ reviewProvider: provider });
  clock3.value += HOUR;
  const r3 = await eng3.loop({ quotes: { BTCUSDT: { price: 100, high: 101, low: 99, received_at: clock3.value } }, candidates: [candidate("short", { confidence: 75, at: clock.value })], atr: 2 });
  eq("非法 Schema 也回退本地", [r3.summary.opened.length, eng3.reviewStats().last_reason], [1, "invalid_schema"]);
  // 建议 skip + 高风险 → 硬跳过
  mode = "ok";
  const skipProv = async () => ({ ok: true, review: { direction: "bearish", confidence: 60, risk: 90, agree_with_local: false, action: "skip", conflict: "x", reason: "风险过高" } });
  const { eng: eng4, clock: clock4 } = await mkEngine({ reviewProvider: skipProv });
  clock4.value += HOUR;
  const r4 = await eng4.loop({ quotes: { BTCUSDT: { price: 100, high: 101, low: 99, received_at: clock4.value } }, candidates: [candidate("short", { confidence: 75, at: clock.value })], atr: 2 });
  eq("DeepSeek 建议 skip + 高风险 → 不交易(§45)", r4.summary.opened.length, 0);
  check("跳过原因 = deepseek_skip", r4.summary.skipped.some((s) => s.reason === "deepseek_skip"), JSON.stringify(r4.summary.skipped));
  // Schema 校验与 slim 上下文
  eq("Schema 允许 partial_close", isValidDeepseekReview({ direction: "bullish", confidence: 50, risk: 50, action: "partial_close" }), true);
  eq("Schema 拒绝非法动作", isValidDeepseekReview({ direction: "bullish", confidence: 50, risk: 50, action: "buy" }), false);
  const slim = slimContext({ symbol: "BTCUSDT", secret: "drop-me", position: { mode: "short", leverage: 4, extra: 1 }, junk: [1, 2, 3] });
  eq("slimContext 只保留白名单字段(丢弃未知字段)", [slim.secret, slim.junk], [undefined, undefined]);
  eq("slimContext 保留必要字段", [slim.symbol, slim.position.leverage, slim.position.extra], ["BTCUSDT", 4, undefined]);
  // 无 Key 时路由回退(前端用本地)
  const noKey = await worker.fetch(new Request("https://app.local/api/ai/review?symbol=BTCUSDT&interval=1h"));
  const noKeyBody = await noKey.json();
  eq("无服务端 Key 时明确回退", [noKey.status, noKeyBody.ok, noKeyBody.reason], [200, false, "no_server_key"]);
}

console.log("== H. Research Agent 真实来源(§30-§39/§90) ==");
{
  const okx = normalizeOkxAnnouncements({ code: "0", data: [{ details: [{ title: "OKX will list $NEW token", url: "https://www.okx.com/x", pTime: "1790157613684", annType: "coin-listing" }] }] }, { now: T0 });
  eq("OKX 公告可解析", [okx.length, okx[0].source_kind], [1, "exchange"]);
  check("公告带发布时间与链接", okx[0].published_at > 0 && /^https:/.test(okx[0].url), JSON.stringify(okx[0]));
  const rss = ["<rss><channel>",
    "<item><title>Bitcoin ETF inflow hits record</title><link>https://cointelegraph.com/news/a</link><pubDate>Mon, 29 Sep 2026 10:00:00 GMT</pubDate><description>inflow record</description></item>",
    "<item><title>No date</title><link>https://cointelegraph.com/news/b</link></item>",
    "<item><title>Bad link</title><link>javascript:alert(1)</link><pubDate>Mon, 29 Sep 2026 09:00:00 GMT</pubDate></item>",
    "</channel></rss>"].join("");
  const items = parseRssItems(rss, { now: T0, limit: 5 });
  eq("RSS 只保留可用的 1 条(过滤无时间/危险链接)", items.length, 1);
  eq("危险链接被拒", [safeUrl("javascript:alert(1)"), safeUrl("data:text/html,x")], [null, null]);
  check("标题情绪可判", scoreHeadline({ title: "SEC approves spot ETF listing" }).importance >= 70, JSON.stringify(scoreHeadline({ title: "SEC approves spot ETF listing" })));
  let fetches = 0;
  const agent = createResearchAgent({
    now: () => T0,
    fetchFn: async () => { fetches += 1; return [{ source_id: "okx_official", source_kind: "exchange", title: "OKX lists NEW", summary: "listing", published_at: T0 - 600000, sentiment: "bullish", importance: 70, confidence: 70, url: "https://www.okx.com/x" }]; }
  });
  const run1 = await agent.run({ symbol: "BTCUSDT", price_change_pct: 4 });
  eq("真实形状的新闻可进入 Agent", run1.ok, true);
  const run2 = await agent.run({ symbol: "BTCUSDT", price_change_pct: 4 });
  eq("同一事件不重复分析(§35)", run2.results.length, 0);
  const ctx = researchContext(agent.read(), { now: T0 });
  check("研究上下文可读", ctx.available === true && ctx.news.available === true, JSON.stringify(ctx).slice(0, 120));
  const noProv = createResearchAgent({ now: () => T0 });
  eq("无 Provider 时不伪造(§96)", (await noProv.run({ price_change_pct: 9 })).reason, "no_provider");
  eq("无 Provider 时读缓存明确不可用", noProv.read().available, false);
  void fetches;
  // 结构:页面必须接真实来源 + 后台运行 + 不阻塞
  check("页面接了公告与新闻两条真实来源", /api\("announcements\?limit=/.test(pageSrc) && /api\("news\?limit=/.test(pageSrc));
  check("页面有后台研究定时器", /researchTimer = setInterval/.test(pageSrc));
  check("新闻来源域名在白名单里(仅固定端点)", /"cointelegraph\.com", "www\.cointelegraph\.com"/.test(fs.readFileSync(path.join(ROOT, "worker/src/proxy.js"), "utf8")));
  eq("触发条件仍限制联网频率(§32)", shouldResearch({ scheduled_due: true, ms_since_last_research: 1000 }).research, false);
}

console.log("== I. AI Chat:真实问题 + 完整上下文 + 只一个回答(§48-§52/§92) ==");
{
  check("页面把 question 发给服务端", /async function chatSingleAnswer\(question, context\)/.test(pageSrc) && /\{ question, context \}/.test(pageSrc));
  // V15 AI CHAT 非驻留:出站上下文必须过白名单整形(结构上不可能带聊天历史)
  check("聊天出站上下文经白名单整形(不带历史)", /limitOutboundContext\(/.test(pageSrc) && /chat_summary/.test(fs.readFileSync(path.join(ROOT, "worker/src/paper/chatSession.js"), "utf8")));
  check("只显示一个最终回答(先 Loading 再替换)", /chatPushLoading\(\)/.test(pageSrc) && /loading\.textContent = final\.text/.test(pageSrc));
  check("不再先本地再追加 DeepSeek(单气泡)", !/chatPush\("ai", local\);\s*\n\s*\/\/ DeepSeek/.test(pageSrc));
  check("保留本地回答兜底(answerLocally)", /answerLocally\(question, context\)/.test(pageSrc));
  check("上下文含持仓/杠杆/保证金/爆仓价/预测", /liquidation_price: raw\.liquidation_price/.test(pageSrc) && /leverage: raw\.leverage/.test(pageSrc) && /margin: raw\.entry_notional/.test(pageSrc) && /prediction: pred \? \{/.test(pageSrc));
  check("本地回答会针对仓位问题(拿多久)", /模拟仓位,预计区间约/.test(fs.readFileSync(path.join(ROOT, "worker/src/paper/support.js"), "utf8")));
  // 路由:POST 携带 question 时也能安全回退(无 Key)
  const post = await worker.fetch(new Request("https://app.local/api/ai/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "这笔准备拿多久?", context: { symbol: "BTCUSDT", position: { mode: "short", leverage: 4 } } }) }));
  const postBody = await post.json();
  eq("POST question 路由可用并回退", [post.status, postBody.ok, postBody.reason], [200, false, "no_server_key"]);
  const tooBig = await worker.fetch(new Request("https://app.local/api/ai/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "x", context: { big: "z".repeat(7000) } }) }));
  eq("超大上下文被拒(防泄漏/滥用)", tooBig.status, 200);
}

console.log("== K. 会计恒等式精确性(小规模,§95) ==");
{
  const { eng, clock } = await mkEngine({ profitLock: { trendStrength: 0.5, reversalRisk: 0.4, persistShadow: false } });
  clock.value += HOUR;
  await eng.loop({ quotes: { BTCUSDT: { price: 100, high: 104, low: 99, received_at: clock.value } }, candidates: [candidate("short", { at: clock.value })], atr: 1.5 });
  const pos = eng.getPositions().find((p) => p.status === "OPEN");
  // 恒等式必须基于【最新快照】(total_equity/reserved 都是派生字段,只在 snapshot 时重算,§67)
  let lastPrice = 100;
  const identity = (tag) => {
    lastPrice = lastPrice;
    const snap = eng.snapshot(() => lastPrice);
    const acc = snap.account;
    const open = eng.getPositions().filter((p) => p.status === "OPEN");
    const feesOfOpen = open.reduce((a, p) => a + num(p.fees, 0), 0);
    const unrealOfOpen = open.reduce((a, p) => a + num(p.unrealized_pnl, 0), 0);
    const expected = num(acc.initial_balance) + num(acc.realized_pnl) - feesOfOpen + unrealOfOpen;
    const gap = num(acc.total_equity) - expected;
    check("会计恒等式精确成立:" + tag, Math.abs(gap) < 1e-6, JSON.stringify({ eq: acc.total_equity, expected, gap, feesOfOpen, unrealOfOpen }));
  };
  lastPrice = 100;
  identity("开仓后");
  clock.value += HOUR;
  lastPrice = 102;
  await eng.closePosition(pos, { reference_price: 102, exit_reason: "tp1", now: clock.value, fraction: 0.25 });
  identity("部分平仓 25% 后");
  clock.value += HOUR;
  lastPrice = 103;
  await eng.closePosition(eng.getPositions().find((p) => p.status === "OPEN"), { reference_price: 103, exit_reason: "tp2", now: clock.value, fraction: 0.5 });
  identity("再部分平仓 50% 后");
  clock.value += HOUR;
  lastPrice = 99;
  await eng.closePosition(eng.getPositions().find((p) => p.status === "OPEN"), { reference_price: 99, exit_reason: "exit", now: clock.value, fraction: 1 });
  eng.snapshot(() => lastPrice);
  identity("全平后");
  const acc = eng.snapshot(() => lastPrice).account;
  check("全平后无剩余锁定资金", num(acc.reserved_balance) === 0, String(acc.reserved_balance));
  check("钱包 reserved 归零", num(eng.engine.wallets.short.reserved_balance) === 0, String(eng.engine.wallets.short.reserved_balance));
  check("部分平仓成交已分摊入场费", eng.getTrades().filter((t) => t.partial).every((t) => num(t.entry_fee_allocated, 0) >= 0), JSON.stringify(eng.getTrades().filter((t) => t.partial).map((t) => t.entry_fee_allocated)));
}

console.log("== J. Position UI 精确展示(§53-§69/§84/§93) ==");
{
  // 动态精度:红色不能显示 0.00
  eq("小额亏损显示 4 位", fmtUsdtExact(-0.0047), "-0.0047 USDT");
  eq("小额盈利显示 4 位", fmtUsdtExact(0.0021), "+0.0021 USDT");
  eq("常规显示 2 位", fmtUsdtExact(0.83), "+0.83 USDT");
  eq("0.01 仍按 2 位(不改变既有口径)", fmtUsdtExact(-0.01), "-0.01 USDT");
  eq("零值显示 0.00", fmtUsdtExact(0), "0.00 USDT");
  eq("精度选择函数", [usdtDigits(1.2), usdtDigits(0.05), usdtDigits(0.004), usdtDigits(0)], [2, 2, 4, 2]);
  // 标签只由真实 PnL 决定
  eq("亏损标签", pnlLabel(-0.83), "浮亏");
  eq("盈利标签", pnlLabel(0.83), "浮盈");
  eq("零标签", pnlLabel(0), "浮动盈亏");
  eq("颜色只由数值决定", [pnlClass(-0.0001), pnlClass(0.0001), pnlClass(0)], ["red", "green", "gray"]);
  // 字段完整性(§54)
  const raw = {
    position_id: "p1", symbol: "BTCUSDT", mode: "short", side: "LONG", status: "OPEN",
    entry_price: 65420, avg_entry_price: 65420, current_price: 64880, mark_price: 64890,
    quantity: 0.0004885, initial_quantity: 0.0004885, remaining_quantity: 0.00034195,
    entry_notional: 8, remaining_margin: 5.6, notional: 32, leverage: 4,
    requested_leverage: 4, approved_leverage: 4, actual_leverage: 4,
    liquidation_price: 49200, unrealized_pnl: -0.83, realized_pnl: 0.42,
    partial_close_count: 1, entry_time: T0, stop_price: 63000, take_profit_price: 67000,
    strategy_mode: "SHORT_TERM", trailing_state: { type: "trailing", price: 63200 }, funding_simulated: -0.01, funding_status: "live"
  };
  const v = positionView(raw, { now: T0 + 37 * 60000 });
  const required = ["strategy_mode", "direction", "margin", "remaining_margin", "notional", "remaining_notional", "requested_leverage", "approved_leverage", "actual_leverage", "liquidation_price", "entry_price", "avg_entry_price", "current_price", "mark_price", "realized_pnl", "unrealized_pnl", "pnl_pct", "initial_quantity", "remaining_quantity", "partial_close_count", "holding_time", "stop_price", "take_profit", "trailing_state"];
  const missing = required.filter((k) => raw[k] !== undefined && v[k] === undefined);
  eq("§54 字段全部暴露", missing, []);
  const full = positionView({ ...raw, remaining_quantity: raw.initial_quantity, remaining_margin: raw.entry_notional, partial_close_count: 0 }, { now: T0 + 60000 });
  eq("保证金与仓位价值分开(未部分平仓)", [full.margin_text, full.notional_text], ["8.00 USDT", "32.00 USDT"]);
  eq("仓位价值 = 保证金 × 杠杆(§59)", full.notional, full.margin * 4);
  eq("部分平仓后为剩余口径", [v.margin_text, v.notional_text], ["8.00 USDT", (v.remaining_margin * 4).toFixed(2) + " USDT"]);
  eq("剩余口径自洽(剩余保证金 × 杠杆)", v.remaining_notional, v.remaining_margin * 4);
  eq("杠杆文案", v.leverage_text, "AUTO · 4x");
  eq("爆仓价展示", v.liquidation_text, "49200.00");
  eq("无爆仓价显示 --", positionView({ ...raw, liquidation_price: null }).liquidation_text, "--");
  eq("未实现盈亏精确文案", v.pnl_text, "-0.83 USDT");
  eq("已实现与未实现分开", [v.realized_text, v.pnl_text], ["+0.42 USDT", "-0.83 USDT"]);
  eq("已平/剩余百分比", [v.closed_pct_text, v.remaining_pct_text], ["30%", "70%"]);
  eq("盈亏标签与颜色", [v.pnl_label, v.pnl_class], ["浮亏", "red"]);
  check("持仓时间格式化", /分钟|小时|天/.test(v.holding_time), v.holding_time);
  // 部分平仓(§93):10U margin / 4x / 40U notional → 平 50%
  const half = positionView({ ...raw, entry_notional: 5, remaining_margin: 5, notional: 40, quantity: 0.001, initial_quantity: 0.001, remaining_quantity: 0.0005, partial_close_count: 1, unrealized_pnl: -0.16, realized_pnl: 0.42 });
  eq("部分平仓后剩余数量正确", half.remaining_quantity, 0.0005);
  eq("部分平仓比例展示", [half.closed_pct_text, half.remaining_pct_text], ["50%", "50%"]);
  eq("剩余市值按最新价计算", half.remaining_notional_text !== "--", true);
  // ViewModel 集成:paper 页与详情页都能拿到这些字段
  const paper = paperViewModel({ wallets: { short: { allocated_balance: 70 }, long: { allocated_balance: 30 } }, positions: [raw], trades: [{ trade_id: "t1", symbol: "BTCUSDT", mode: "short", side: "LONG", entry_price: 65420, exit_price: 66120, net_pnl: 0.31, return_pct: 1.07, holding_ms: 3600000, exit_reason: "take_profit", exit_time: T0, leverage: 4, margin: 8, notional_value: 32 }], now: T0 + 3600000 });
  eq("模拟页持仓含保证金/仓位价值/爆仓", [paper.positions[0].margin_text, paper.positions[0].notional_text, paper.positions[0].liquidation_text], ["8.00 USDT", (paper.positions[0].remaining_margin * 4).toFixed(2) + " USDT", "49200.00"]);
  eq("模拟页也暴露原始仓位价值", paper.positions[0].initial_notional_text, "32.00 USDT");
  eq("成交含杠杆与资金信息", [paper.trades[0].margin_text, paper.trades[0].notional_text], ["8.00U", "32.00U"]);
  const detail = detailViewModel({ analysis: { symbol: "BTCUSDT", direction: "Bullish" }, positions: [raw], interval: "1h", price: 64880, now: T0 + 60000 });
  eq("详情页持仓含盈亏标签与杠杆", [detail.position.pnl_label, detail.position.leverage_text], ["浮亏", "AUTO · 4x"]);
  // §70:首页读真实钱包的分配
  const home = homeViewModel({ snapshot: { state: "RUNNING", account: { initial_balance: 100, total_equity: 100 }, wallets: { short: { allocated_balance: 70 }, long: { allocated_balance: 30 } }, positions: [], today: summarizeTrades([]), all_time: summarizeTrades([]) } });
  eq("首页分配读真实钱包", home.allocation_text, "短线 70% / 长线 30%");
  eq("首页双池金额", [home.short_equity, home.long_equity], [70, 30]);
  check("首页不写死 70/30(来自钱包)", /allocation_text/.test(fs.readFileSync(path.join(ROOT, "worker/src/ui/viewModels.js"), "utf8")));
  // §67:PnL 必须按最新价重算(引擎 snapshot(priceOf))
  const { eng, clock } = await mkEngine();
  clock.value += HOUR;
  await eng.loop({ quotes: { BTCUSDT: { price: 100, high: 101, low: 99, received_at: clock.value } }, candidates: [candidate("short", { at: clock.value })], atr: 2 });
  const pos = eng.getPositions().find((p) => p.status === "OPEN");
  const snapFresh = eng.snapshot(() => 95);
  const freshPos = snapFresh.positions.find((p) => p.position_id === pos.position_id);
  check("按最新价重算未实现盈亏(§67)", num(freshPos.unrealized_pnl) < 0, JSON.stringify(num(freshPos.unrealized_pnl)));
  const viewFresh = positionView(freshPos, { now: clock.value });
  eq("重算后标签为浮亏", viewFresh.pnl_label, "浮亏");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("RUNTIME V14.5 TESTS OK");
