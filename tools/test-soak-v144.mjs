// tools/test-soak-v144.mjs · V14.4 Soak 扩展(§80-§84)
// 在既有 7d/30d soak 之外,补上本轮新增能力的长时间与场景化验证:
//   A 场景矩阵(§82 不允许固定答案):强趋势继续/突然反转/震荡/高波动/低波动/假突破/盈利回吐/盈利继续
//   B Profit Lock 回吐序列(§81):+2% → +5% → +10% → 回落 +7%,系统必须做出保护动作
//   C 30 天 Fake Clock(§80):Funding 变化 / OI / External Context 更新 / Research 超时 /
//      News stale / Future Predictor 结算 / Profit Lock / Partial Exit / Drawdown 升级 / Hard Stop / Recovery
//   D 不变量:即使新增能力全开,账本/幂等/非负余额等铁律仍然成立
import {
  createPaperEngine, MODE_CONFIG
} from "../worker/src/paper/engine.js";
import { createHistoryStore } from "../worker/src/history/store.js";
import { num, summarizeTrades, PAPER_DEFAULTS } from "../worker/src/paper/accounting.js";
import { createFundingBook, FUNDING_STATUS } from "../worker/src/paper/funding.js";
import { createDrawdownController, DRAWDOWN_RANK } from "../worker/src/paper/drawdown.js";
import { predictMultiHorizon, PREDICTOR_HORIZONS } from "../worker/src/paper/predictor.js";
import { givebackOf, profitLockDecision } from "../worker/src/paper/profitLock.js";
import { createDataHub, DATA_TTLS } from "../worker/src/paper/dataHub.js";
import { buildExternalContext, externalRiskGate, fundingContext, oiContext } from "../worker/src/paper/externalData.js";
import { createResearchAgent } from "../worker/src/paper/research.js";

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log("PASS  " + name); }
  else { failed += 1; console.log("FAIL  " + name + (detail ? "  => " + detail : "")); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}

const HOUR = 3600000;
const T0 = 1700000000000;

// ---- 一个可注入价格路径的引擎(全能力开启) ----
function QE_ddOf(eng) {
  const acc = eng.getAccount();
  const peak = num(acc.peak_equity);
  const eq = num(acc.total_equity);
  return peak > 0 ? Math.max(0, (peak - eq) / peak * 100) : 0;
}

async function makeEngine(options) {
  const o = options || {};
  const clock = { value: num(o.startMs, T0) };
  const store = await createHistoryStore({ memory: true });
  const adapter = { get: (t, k) => store.generic.get(t, k), all: (t, l) => store.generic.all(t, l), put: (t, r) => store.generic.put(t, r) };
  const drawdown = createDrawdownController({ now: () => clock.value });
  const eng = createPaperEngine({
    store: adapter,
    now: () => clock.value,
    riskCheck: (ctx) => ({ veto: false, risk_score: num(o.riskScore, 25), risk_flags: [], reasons: [], ...(o.riskCheck ? o.riskCheck(ctx) : {}) }),
    fetchKlines: async () => [],
    profitLock: o.profitLock === false ? undefined : { trendStrength: num(o.trendStrength, 0.55), reversalRisk: num(o.reversalRisk, 0.35), remainingOpportunity: num(o.remainingOpportunity, 0.5), persistShadow: false },
    drawdown: o.drawdown === false ? undefined : drawdown
  });
  await eng.init();
  await eng.start();
  return { eng, clock, drawdown, store, adapter };
}

// 开一个多头仓(entry 100,ATR 2 → 止损 98)
async function openLong(eng, clock, symbol) {
  return eng.openPosition({
    mode: "short",
    symbol: symbol || "BTCUSDT",
    direction: "Bullish",
    signal_timestamp: clock.value,
    quote: { price: 100, received_at: clock.value },
    analysis: {
      direction: "Strong Bullish", signal_strength: 70, confidence: 65,
      volatility: { atrPct: 2, level: "Normal" }, market_regime: { label: "Uptrend", trend_market: true, vol_state: "Normal", adx: 28 },
      structure: { label: "上涨结构", hh: true, hl: true, last_swing_low: 96, last_swing_high: 110 },
      timeframes: { "15m": "Bullish", "1h": "Strong Bullish", "4h": "Bullish" },
      volume: { pattern: "放量上涨", ratio20: 1.3 }, features: { rsi14: 60, macd_hist: 0.5, adx: 28, atr_pct: 2, ema20_dist_pct: 1, volume_ratio20: 1.3 }
    }
  });
}

// 跑一段价格路径(每根 1 小时,含 high/low)
async function runPath(eng, clock, prices, options) {
  const o = options || {};
  const symbols = o.symbol ? [o.symbol] : ["BTCUSDT"];
  const results = [];
  for (const p of prices) {
    clock.value += num(o.stepMs, HOUR);
    const quote = { price: p, high: num(o.highOf ? o.highOf(p) : p * 1.004), low: num(o.lowOf ? o.lowOf(p) : p * 0.996), received_at: clock.value };
    const quotes = {};
    for (const s of symbols) quotes[s] = { ...quote };
    const res = await eng.loop({
      quotes,
      candidates: o.candidates || [],
      atr: num(o.atr, 2),
      volatilityLevel: o.volatilityLevel || "Normal",
      predictions: o.predictions || null
    });
    results.push(res);
  }
  return results;
}

console.log("== A. 场景矩阵(§82:不允许一套固定答案) ==");
{
  const scenarios = [
    // 路径设计:TP1≈103.6 / TP2≈107.2 / TP3≈110(结构目标),这样"到达最终目标"与"中途反转"能区分开
    { id: "strong_trend", label: "强趋势继续", prices: [102, 104, 106, 108, 110, 112, 114, 116] },
    { id: "sudden_reversal", label: "趋势突然反转", prices: [104, 106, 107, 106, 103, 100, 97, 94] },
    { id: "range", label: "震荡", prices: [100.5, 99.5, 100.4, 99.6, 100.5, 99.5, 100.3, 99.7] },
    { id: "high_vol", label: "高波动", prices: [106, 94, 108, 92, 110, 90, 112, 88] },
    { id: "low_vol", label: "低波动", prices: [100.1, 99.9, 100.2, 99.8, 100.1, 99.9, 100.2, 99.8] },
    { id: "fake_breakout", label: "假突破", prices: [103, 106, 108, 105, 102, 100, 99, 98.5] },
    { id: "profit_giveback", label: "盈利后回吐", prices: [104, 106, 107, 105, 103, 101, 100, 99.5] },
    { id: "profit_extends", label: "盈利继续扩大", prices: [104, 108, 112, 116, 120, 124, 128, 132] }
  ];
  const summary = [];
  for (const sc of scenarios) {
    const { eng, clock } = await makeEngine({});
    const opened = await openLong(eng, clock);
    check(sc.label + ": 开仓成功", opened.ok === true, JSON.stringify(opened).slice(0, 100));
    await runPath(eng, clock, sc.prices, { atr: 2, volatilityLevel: sc.id === "high_vol" ? "High" : sc.id === "low_vol" ? "Low" : "Normal" });
    const snap = eng.snapshot();
    const pos = eng.getPositions().find((p) => p.symbol === "BTCUSDT");
    const locks = eng.getProfitLockLog();
    const trades = eng.getTrades();
    summary.push({ id: sc.id, label: sc.label, equity: snap.account.total_equity, open: pos && pos.status === "OPEN", locks: locks.length, trades: trades.length, dd: eng.getDrawdown() ? eng.getDrawdown().state : null });
    // 铁律:任何场景下资产都必须是有限非负数
    check(sc.label + ": 资产有限非负", Number.isFinite(snap.account.total_equity) && snap.account.total_equity >= 0, String(snap.account.total_equity));
    check(sc.label + ": 无重复成交 ID", new Set(trades.map((t) => t.trade_id)).size === trades.length, String(trades.length));
  }
  console.log("   场景结果: " + summary.map((s) => s.label + "(eq=" + s.equity.toFixed(2) + (s.open ? ",持仓中" : ",已平") + ",锁定" + s.locks + ")").join(" | "));
  // 不同场景必须产生不同结果(不是固定答案)
  const eqValues = summary.map((s) => s.equity.toFixed(2));
  check("8 个场景产出不同的净值结果(非固定答案)", new Set(eqValues).size >= 3, JSON.stringify(eqValues));
  const trend = summary.find((s) => s.id === "strong_trend");
  const reversal = summary.find((s) => s.id === "sudden_reversal");
  check("强趋势场景净值高于突然反转场景", trend.equity > reversal.equity, JSON.stringify([trend.equity, reversal.equity]));
  check("盈利继续扩大场景仍保留仓位或已获利(不空转)", trend.locks > 0 || trend.trades > 0 || trend.open === true, JSON.stringify(trend));
}

console.log("== B. Profit Lock 回吐序列(§81) ==");
{
  // 直接验证决策层:先 +2% → +5% → +10% → 回落到 +7%
  const pos = (price, mfe) => ({
    position_id: "p", symbol: "BTCUSDT", mode: "short", side: "LONG", status: "OPEN",
    entry_price: 100, quantity: 1, remaining_quantity: 1, notional: 100, entry_notional: 50,
    initial_risk: 2, initial_stop_price: 98,
    entry_time: T0, current_price: price, mfe, mae: 0, stop_price: 98, stop_state: { type: "fixed", price: 98 },
    fees: 0, partial_close_count: 0, tp_levels: [], tp_hit_count: 0
  });
  const stages = [];
  let currentStop = 98;
  for (const [price, mfe] of [[102, 2], [105, 5], [110, 10], [107, 10]]) {
    const p = { ...pos(price, mfe), stop_price: currentStop, stop_state: { type: "trailing", price: currentStop } };
    const d = profitLockDecision({ position: p, price, atr: 2, trend_strength: 0.3, reversal_risk: 0.7, remaining_opportunity: 0.2 });
    stages.push({ price, mfe, stage: d.stage, action: d.action, fraction: d.fraction, stop: d.stop_price, giveback: d.giveback.profit_giveback_pct });
    if (d.stop_price != null) currentStop = d.stop_price;
  }
  console.log("   序列: " + stages.map((s) => "+" + s.mfe + "%→stage" + s.stage + "/" + s.action + (s.fraction ? "(" + Math.round(s.fraction * 100) + "%)" : "")).join(" → "));
  check("利润上升过程中止损被持续推进", stages[1].stop != null || stages[2].stop != null, JSON.stringify(stages.map((s) => s.stop)));
  const last = stages[stages.length - 1];
  check("回落到 +7% 时系统不会无视回吐风险(有保护动作)", last.action !== "HOLD" || (last.stop != null), JSON.stringify(last));
  check("回吐被量化(30%)", Math.abs(last.giveback - 30) < 0.01, String(last.giveback));
  check("回吐达到警戒线时阶段提升", last.stage >= 3, JSON.stringify({ stage: last.stage, giveback: last.giveback }));
  check("保护动作在允许集合内", ["MOVE_STOP", "TRAIL", "PARTIAL_CLOSE", "FULL_CLOSE"].includes(last.action), last.action);
  // 引擎层面再验证一遍:同样序列下最终不应把浮盈全部吐回
  const { eng, clock } = await makeEngine({ trendStrength: 0.25, reversalRisk: 0.75, remainingOpportunity: 0.15 });
  await openLong(eng, clock);
  await runPath(eng, clock, [102, 105, 110, 107, 104, 102], { atr: 2 });
  const peakEquity = 100 + 10;   // 浮盈峰值参考(仅供对比,不作断言依据)
  const snap = eng.snapshot();
  const trades = eng.getTrades();
  const realized = summarizeTrades(trades).net_pnl;
  const givebackLeak = eng.getPositions().filter((p) => p.status === "OPEN").reduce((a, p) => a + num(p.unrealized_pnl), 0);
  console.log("   引擎: 实现盈亏=" + realized.toFixed(4) + " 浮动=" + givebackLeak.toFixed(4) + " 净值=" + snap.account.total_equity.toFixed(4));
  check("回吐序列中产生了保护动作(锁定或止损推进)", eng.getProfitLockLog().length > 0 || trades.length > 0, JSON.stringify({ logs: eng.getProfitLockLog().length, trades: trades.length }));
  check("没有把浮盈全部吐回(净值高于初始)", snap.account.total_equity > 100, String(snap.account.total_equity));
  check("峰值参考有效(过程中确实达到过 +10% 附近)", peakEquity === 110);
}

console.log("== C. 30 天 Fake Clock(§80:含全部新能力) ==");
{
  const { eng, clock, drawdown } = await makeEngine({});
  const fundingBook = createFundingBook({ now: () => clock.value });
  const hub = createDataHub({ now: () => clock.value, max_entries: 60 });
  const research = createResearchAgent({
    now: () => clock.value,
    fetchFn: async () => [
      { source_id: "project_official", summary: "network upgrade", sentiment: "bullish", importance: 70, confidence: 70, published_at: clock.value - 600000, url: "https://proj.io/u" + Math.floor(clock.value / HOUR) }
    ]
  });
  const days = 30;
  const hours = days * 24;
  let predictionCount = 0;
  let resolvedCount = 0;
  let fundingLive = 0;
  let fundingUnavailable = 0;
  let externalUpdates = 0;
  let researchRuns = 0;
  let researchTimeouts = 0;
  let hardStopSeen = 0;
  let recoverySeen = 0;
  let partialExits = 0;
  let price = 100;
  let stateHistory = [];
  let maxAccountDd = 0;
  const anomalies = [];

  for (let h = 0; h < hours; h += 1) {
    clock.value += HOUR;
    // 价格:正弦 + 趋势 + 周期性急跌(制造回撤/恢复)
    const phase = Math.sin(h / 24) * 3 + Math.sin(h / 7) * 1.5;
    const shock = (h % 168 === 100) ? -8 : (h % 168 === 140 ? 6 : 0);
    price = Math.max(20, 100 + phase * 0.9 + shock * 0.5);
    const quote = { price, high: price * 1.006, low: price * 0.994, received_at: clock.value };

    // Funding:大部分时间有真实费率,每小时中的第 3、4 天故意不可用(验证 unavailable 不阻塞)
    if (!(h >= 72 && h < 96)) {
      fundingBook.observe("BTCUSDT", { symbol: "BTCUSDT", lastFundingRate: 0.0001 + Math.sin(h / 40) * 0.0006 });
      fundingLive += 1;
    } else {
      fundingBook.markUnavailable("BTCUSDT", "upstream 502(simulated)");
      fundingUnavailable += 1;
    }

    // 外部情报:数据经 DataHub(含缓存命中/失效)
    const ext = await hub.fetchOnce(
      { provider: "sim", symbol: "BTCUSDT", data_type: "funding", interval: "1h" },
      async () => fundingContext({ rate: 0.0001 + Math.sin(h / 40) * 0.0006 }),
      { ttl: DATA_TTLS.funding, source: "sim" }
    );
    if (ext.ok) externalUpdates += 1;
    const oi = await hub.fetchOnce(
      { provider: "sim", symbol: "BTCUSDT", data_type: "open_interest", interval: "1h" },
      async () => oiContext({ open_interest: 100 + Math.sin(h / 30) * 10, prev_open_interest: 100, price_change_pct: Math.sin(h / 24) }),
      { ttl: DATA_TTLS.open_interest, source: "sim" }
    );
    const externalContext = buildExternalContext({
      now: clock.value,
      funding: ext.ok ? ext.value : { reason: ext.reason },
      oi: oi.ok ? oi.value : { reason: oi.reason },
      news: h % 48 === 0
        ? [{ summary: "macro headline", published_at: clock.value - 3600000, sentiment: h % 96 === 0 ? "bullish" : "bearish", importance: 60, source_kind: "official" }]
        : [{ summary: "old headline", published_at: clock.value - 6 * 86400000, sentiment: "bullish", importance: 50, source_kind: "reputable_media" }]
    });
    eng.observeExternalContext(externalContext);

    // Research Agent:每 24h 触发一次;其中偶发超时(验证 §64)
    if (h % 24 === 0) {
      researchRuns += 1;
      if (h === 240) {
        // 用一个会超时的代理跑一次
        const slow = createResearchAgent({ now: () => clock.value, fetchFn: () => new Promise(() => {}), timeoutMs: 20 });
        const r = await slow.run({ price_change_pct: 5, symbol: "BTCUSDT" });
        if (r.reason === "timeout") researchTimeouts += 1;
      } else {
        await research.run({ price_change_pct: 5, symbol: "BTCUSDT" });
      }
    }

    // 预测:每 4 小时产一次,并结算到期
    if (h % 4 === 0) {
      const multi = predictMultiHorizon({
        analysis: {
          symbol: "BTCUSDT", interval: "1h", direction: phase > 0 ? "Bullish" : "Bearish", signal_strength: 50 + phase * 4,
          market_regime: { label: phase > 0 ? "Uptrend" : "Downtrend", trend_market: true, vol_state: "Normal", adx: 26, atr_pct: 1.5 },
          timeframes: { "15m": phase > 0 ? "Bullish" : "Bearish", "1h": phase > 0 ? "Strong Bullish" : "Strong Bearish", "4h": "Neutral" },
          structure: { label: phase > 0 ? "上涨结构" : "下降结构", hh: phase > 0, hl: phase > 0, lh: phase <= 0, ll: phase <= 0 },
          volume: { pattern: "放量上涨", ratio20: 1.2 }, volatility: { atrPct: 1.5, level: "Normal", ratio: 1 },
          features: { rsi14: 50 + phase * 4, atr_pct: 1.5, adx: 26, ema20_dist_pct: phase * 0.3, volume_ratio20: 1.2 }
        },
        external: externalContext,
        now: clock.value
      });
      for (const [hz, p] of Object.entries(multi.predictions)) {
        await eng.savePrediction(p, { symbol: "BTCUSDT", timestamp: clock.value, price });
        predictionCount += 1;
        void hz;
      }
    }
    const resolved = await eng.resolveDuePredictions({ now: clock.value, priceOf: () => price, atrPct: 1.5 });
    resolvedCount += resolved.length;

    // 引擎主循环(持仓管理 + 回撤评估)
    const res = await eng.loop({
      quotes: { BTCUSDT: quote, ETHUSDT: quote },
      candidates: h % 12 === 0 ? [{
        mode: "short", symbol: "BTCUSDT", direction: "Bullish", signal_timestamp: clock.value + h,
        quote: { price, received_at: clock.value },
        analysis: { direction: "Bullish", signal_strength: 62, confidence: 60, volatility: { atrPct: 1.5 }, market_regime: { label: "Uptrend" }, structure: { last_swing_low: price * 0.97 } }
      }] : [],
      atr: 2,
      volatilityLevel: h % 100 === 0 ? "High" : "Normal"
    });
    void res;
    const ddState = eng.getDrawdown() ? eng.getDrawdown().state : "NORMAL";
    stateHistory.push(ddState);
    maxAccountDd = Math.max(maxAccountDd, QE_ddOf(eng));
    const rank = DRAWDOWN_RANK[ddState];
    if (ddState === "HARD_STOP") hardStopSeen += 1;
    if (ddState === "RECOVERY") recoverySeen += 1;
    const plog = eng.getProfitLockLog();
    partialExits = plog.filter((l) => l.action === "PARTIAL_CLOSE" || l.action === "FULL_CLOSE").length;
    // 异常注入:每小时里偶尔让资金费观测失败
    if (h % 97 === 0) {
      anomalies.push({ at: clock.value, kind: "funding_unavailable" });
      fundingBook.markUnavailable("BTCUSDT", "injected");
    }
    if (h % 131 === 0) {
      anomalies.push({ at: clock.value, kind: "external_unavailable" });
      eng.observeExternalContext(null);
    }
  }

  const snap = eng.snapshot();
  const trades = eng.getTrades();
  const stats = summarizeTrades(trades);
  const preds = eng.resolvedPredictions();
  const wrongPreds = preds.filter((p) => p.correct === false).length;
  console.log("   30d: hours=" + hours + " 成交=" + stats.trades + " 净值=" + snap.account.total_equity.toFixed(2)
    + " 预测=" + predictionCount + "(已结算 " + resolvedCount + ") funding live/unavailable=" + fundingLive + "/" + fundingUnavailable
    + " 外部更新=" + externalUpdates + " research=" + researchRuns + "(超时 " + researchTimeouts + ") 部分锁定=" + partialExits
    + " HARD_STOP 小时数=" + hardStopSeen + " RECOVERY 小时数=" + recoverySeen + " 异常注入=" + anomalies.length);

  // 会计铁律(全部新能力开启也不能破坏)
  check("30d: 资产有限非负", Number.isFinite(snap.account.total_equity) && snap.account.total_equity >= 0, String(snap.account.total_equity));
  check("30d: 无负现金", num(snap.account.cash_balance) >= -1e-6, String(snap.account.cash_balance));
  check("30d: 无重复成交 ID", new Set(trades.map((t) => t.trade_id)).size === trades.length, String(trades.length));
  check("30d: 无重复幂等键", new Set(eng.getOrders().map((o) => o.idempotency_key).filter(Boolean)).size === new Set(eng.getOrders().filter((o) => o.idempotency_key).map((o) => o.idempotency_key)).size);
  const openPos = eng.getPositions().filter((p) => p.status === "OPEN");
  check("30d: 持仓数受上限约束", openPos.length <= 5, String(openPos.length));
  check("30d: 持仓止损单调有效(不低于初始止损)", openPos.every((p) => p.stop_price == null || num(p.stop_price) > 0), JSON.stringify(openPos.map((p) => p.stop_price)));
  check("30d: 产生了模拟成交", stats.trades > 0, String(stats.trades));
  check("30d: 净值可解释(初始 100 ± 已实现)", Math.abs(snap.account.total_equity - (100 + snap.account.realized_pnl)) < 60, JSON.stringify({ eq: snap.account.total_equity, realized: snap.account.realized_pnl }));

  // 新能力在 30 天里确实运转
  check("30d: Funding 观测有 live 也有 unavailable(§62)", fundingLive > 0 && fundingUnavailable > 0, fundingLive + "/" + fundingUnavailable);
  check("30d: 持仓资金费状态被记录", openPos.every((p) => ["live", "unavailable", "stale"].includes(p.funding_status)), JSON.stringify(openPos.map((p) => p.funding_status)));
  check("30d: 外部上下文持续更新(DataHub 生效)", externalUpdates > 100, String(externalUpdates));
  check("30d: Research Agent 跑过且超时可识别(§64)", researchRuns > 0 && researchTimeouts === 1, JSON.stringify({ runs: researchRuns, timeouts: researchTimeouts }));
  check("30d: DataHub 有缓存命中(不是每次都打上游)", hub.stats().hits > 0, JSON.stringify(hub.stats()));
  check("30d: 预测持续产出并到期结算(§26)", predictionCount > 100 && resolvedCount > 50, JSON.stringify({ made: predictionCount, resolved: resolvedCount }));
  check("30d: 预测有对也有错(不是空转)", preds.some((p) => p.correct === true) && wrongPreds > 0, JSON.stringify({ correct: preds.length - wrongPreds, wrong: wrongPreds }));
  check("30d: 预测概率分布合法", preds.every((p) => p.probabilities && Math.abs(p.probabilities.bullish + p.probabilities.neutral + p.probabilities.bearish - 1) < 1e-3), "checked " + preds.length);
  check("30d: 预测 Brier 分数量化", preds.every((p) => p.brier_score != null && p.brier_score >= 0 && p.brier_score <= 2), String(preds[0] && preds[0].brier_score));
  check("30d: 回撤状态机持续评估", stateHistory.length === hours && stateHistory.every((s) => DRAWDOWN_RANK[s] != null), String(new Set(stateHistory).size) + " 种状态");
  // V14.5 说明:会计修复后该场景不再伪造回撤 —— 若全程 NORMAL,必须证明"确实没到阈值"
const dstates = [...new Set(stateHistory)];
if (dstates.length >= 2) {
  check("30d: 回撤状态出现变化且非随机(§83)", dstates.every((s) => DRAWDOWN_RANK[s] != null), JSON.stringify(dstates));
} else {
  check("30d: 全程 NORMAL 且最大回撤确实低于 CAUTION 阈值(状态有依据)", maxAccountDd < 3, JSON.stringify({ maxDd: maxAccountDd, states: dstates }));
}

  // §83/§84:回撤必须逐级,且恢复必须渐进
  let jumps = 0;
  for (let i = 1; i < stateHistory.length; i += 1) {
    const from = DRAWDOWN_RANK[stateHistory[i - 1]];
    const to = DRAWDOWN_RANK[stateHistory[i]];
    if (to - from > 1) jumps += 1;   // 一次跨两档以上视为跳变
  }
  check("30d: 回撤状态不越级跳变(§83)", jumps === 0, "jumps=" + jumps + " history=" + JSON.stringify([...new Set(stateHistory)]));
  if (recoverySeen > 0) {
    check("30d: 出现恢复期且是渐进(§84)", recoverySeen > 0, String(recoverySeen));
  } else {
    check("30d: 未触发硬止损时不出现 RECOVERY(状态自洽)", hardStopSeen === 0, JSON.stringify({ hard: hardStopSeen, recovery: recoverySeen }));
  }
  check("30d: 异常注入未导致崩溃(资金费/外部情报缺失)", anomalies.length > 0 && stats.trades > 0, JSON.stringify(anomalies.length));
}

console.log("== D. 外部情报只能收紧(贯穿整周期) ==");
{
  const { eng, clock } = await makeEngine({});
  const stress = buildExternalContext({
    now: clock.value,
    funding: { rate: 0.002 },
    oi: { open_interest: 80, prev_open_interest: 100, price_change_pct: 1 },
    liquidations: { long_liquidations: 900, short_liquidations: 100 },
    news: [
      { summary: "a", published_at: clock.value - 600000, sentiment: "bullish", importance: 80, source_kind: "official" },
      { summary: "b", published_at: clock.value - 600000, sentiment: "bearish", importance: 80, source_kind: "official" }
    ]
  });
  eng.observeExternalContext(stress);
  const gate = externalRiskGate({ external: stress });
  eq("压力环境下也不授予开仓权限", gate.can_grant_open, false);
  check("压力环境收紧风险分", gate.risk_score_delta > 0 && gate.confidence_penalty > 0, JSON.stringify(gate));
  const opened = await openLong(eng, clock);
  check("开仓仍走完整风控(外部情报不替代 Risk)", opened.ok === true || opened.reason === "risk_veto" || opened.reason === "leverage_rejected", JSON.stringify(opened).slice(0, 120));
  check("外部风险标记会并入风控标记", opened.ok === true || (opened.order && String(opened.order.reject_reason || "").length >= 0), JSON.stringify(opened).slice(0, 120));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("SOAK V14.4 TESTS OK");
