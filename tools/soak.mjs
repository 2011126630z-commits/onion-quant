// tools/soak.mjs · Fake Clock Soak 驱动(V14.1:7 天 / 30 天,含异常注入)
// 复用现有 createPaperEngine,不重写 Paper 逻辑。真实等待 = 0(全部走假时钟)。
import { createHistoryStore } from "../worker/src/history/store.js";
import { createPaperEngine, MODE_CONFIG } from "../worker/src/paper/engine.js";
import { PAPER_DEFAULTS, portfolio, num, round, dayKeyOf } from "../worker/src/paper/accounting.js";
import { evaluateRisk } from "../worker/src/paper/risk.js";
import { evidenceBundle } from "../worker/src/paper/evidence.js";
import { fuse } from "../worker/src/paper/fusion.js";
import { callDeepSeek } from "../worker/src/paper/support.js";
import { planRetention, applyRetention, coreHistoryIntact, RETENTION_POLICY } from "../worker/src/paper/retention.js";

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// 确定性行情:带趋势段与震荡段的随机游走
export function makeMarket(seed, symbols) {
  const rand = lcg(seed);
  const price = {};
  for (const s of symbols) price[s] = 100 + rand() * 20;
  return {
    price,
    step(symbol, i) {
      const phase = Math.floor(i / 24) % 4;
      const drift = phase === 0 ? 0.0022 : phase === 1 ? -0.0020 : phase === 2 ? 0.0004 : -0.0006;
      const shock = (rand() - 0.5) * 0.012;
      price[symbol] = Math.max(1, price[symbol] * (1 + drift + shock));
      const p = price[symbol];
      return { price: p, high: p * (1 + rand() * 0.004), low: p * (1 - rand() * 0.004), received_at: 0 };
    }
  };
}

function analysisFor(symbol, quote, i) {
  const rand = lcg(i * 7919 + symbol.length);
  const bull = rand() > 0.5;
  return {
    symbol, interval: "1h", price: quote.price, direction: bull ? "Bullish" : "Bearish", signal_strength: 55 + Math.round(rand() * 30),
    confidence: 50 + Math.round(rand() * 30), limited_data: false,
    market_regime: { label: bull ? "Weak Uptrend" : "Weak Downtrend" },
    volatility: { atrPct: 0.8 + rand() * 2.5, ratio: 1 + rand() },
    volume: { pattern: bull ? "放量上涨" : "缩量下跌", ratio20: 1 + rand() },
    structure: { label: bull ? "上涨结构" : "下降结构", last_swing_low: quote.price * 0.98, last_swing_high: quote.price * 1.02 },
    timeframes: { "15m": bull ? "Bullish" : "Bearish", "1h": bull ? "Strong Bullish" : "Strong Bearish", "4h": bull ? "Bullish" : "Bearish", "1d": "Neutral" },
    features: { rsi14: bull ? 60 : 40 },
    btc_context: { state: "BTC Stable" },
    support_zones: [{ lo: quote.price * 0.97, hi: quote.price * 0.98 }],
    resistance_zones: [{ lo: quote.price * 1.02, hi: quote.price * 1.03 }],
    anomaly: { detected: false, kinds: [] },
    tf_conflict: false
  };
}

function mlFor(i, bull) {
  const rand = lcg(i * 104729);
  const pb = bull ? 0.45 + rand() * 0.3 : 0.1 + rand() * 0.25;
  const pn = 0.2;
  return { probability_bullish: round(pb, 3), probability_neutral: pn, probability_bearish: round(Math.max(0.05, 1 - pb - pn), 3), model_version: "lightgbm-v0.1" };
}

const paperStore = (store) => ({
  get: (t, k) => store.generic.get(t, k),
  all: (t) => store.generic.all(t),
  put: (t, r) => store.generic.put(t, r)
});

/**
 * 运行一次 Fake Clock Soak
 * @param {{days:number, seed?:number, anomalies?:boolean, symbols?:string[]}} options
 */
export async function runSoak(options) {
  const opts = options || {};
  const days = Number(opts.days) || 7;
  const symbols = opts.symbols || ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  const store = await createHistoryStore({ memory: true });
  const ps = paperStore(store);
  const market = makeMarket(opts.seed || 42, symbols);
  const hourMs = 3600000;
  let clock = Date.UTC(2026, 0, 5, 0, 0, 0);
  const startClock = clock;

  const engine = createPaperEngine({
    store: ps,
    now: () => clock,
    config: PAPER_DEFAULTS,
    riskCheck: (ctx) => evaluateRisk({ ...ctx, now: clock, todayKey: dayKeyOf(clock), todayStart: dayKeyOf(clock) }),
    fetchKlines: async (symbol, interval, limit, since) => {
      const out = [];
      for (let i = 0; i < 24; i += 1) {
        const at = clock + i * hourMs;
        const q = market.step(symbol, Math.floor(at / hourMs));
        out.push({ openTime: at, closeTime: at + hourMs - 1, open: q.price, high: q.high, low: q.low, close: q.price });
      }
      return out;
    }
  });
  await engine.init();
  await engine.start();

  const stats = {
    days, loops: 0, orders: 0, exits: 0, restarts: 0, duplicate_orders: 0, duplicate_positions: 0,
    negative_balance: 0, nan_or_inf: 0, anomalies: [], equity_identity_breaks: 0, wallet_identity_breaks: 0,
    restart_resets: 0, offline_skips: 0, skipped_hours: 0,
    deepseek_failures: 0, max_positions: 0, lastEquity: 0
  };
  const seenKeys = new Set();
  const totalHours = days * 24;
  const anomalyAt = new Set();
  const injected = {};
  if (opts.anomalies) {
    // 固定注入点:断网 / 重启 / 重复 Start / DeepSeek 失败 / 极端涨跌 / 跨日
    for (const h of [12, 40, 80, 120, 200, 300, 500, 700]) if (h < totalHours) anomalyAt.add(h);
  }

  for (let h = 0; h < totalHours; h += 1) {
    clock += hourMs;
    const anomaly = opts.anomalies && anomalyAt.has(h);
    if (anomaly) {
      const kind = ["offline", "restart", "duplicate_start", "deepseek_fail", "crash_shock"][stats.anomalies.length % 5];
      stats.anomalies.push({ hour: h, kind });
      if (kind === "offline") {
        // 断网:本轮不提供行情 → 不应产生新开仓
        stats.offline_skips += 1;
        for (const s of symbols) market.step(s, h);
        continue;
      }
      stats.skipped_hours += 1;
      if (kind === "restart") {
        // 模拟 App 重启:重建引擎实例,必须从库恢复
        stats.restarts += 1;
        const engine2 = createPaperEngine({ store: ps, now: () => clock, config: PAPER_DEFAULTS, riskCheck: () => ({ veto: false }), fetchKlines: async () => [] });
        const re = await engine2.init();
        if (num(re.account.initial_balance) !== 10) stats.restart_resets += 1;
        continue;
      }
      if (kind === "duplicate_start") {
        const dup = await engine.start();
        if (dup.ok) stats.duplicate_orders += 1; // 重复 Start 不应成功
        continue;
      }
      if (kind === "deepseek_fail") {
        const r = await callDeepSeek({ symbol: "BTCUSDT" }, { apiKey: "x", fetchFn: async () => new Response("rate limited", { status: 429 }) });
        if (!(r.ok === false && r.fallback === true)) stats.deepseek_failures += 1;
        continue;
      }
      if (kind === "crash_shock") {
        // 极端涨跌:杀跌 25%,检验止损与会计
        for (const s of symbols) market.price[s] = market.price[s] * 0.75;
      }
    }

    const quotes = {};
    for (const s of symbols) {
      const q = market.step(s, h);
      quotes[s] = { ...q, received_at: clock };
    }
    const candidates = [];
    for (const s of symbols) {
      const analysis = analysisFor(s, quotes[s], h);
      const ml = mlFor(h, /Bullish/.test(analysis.direction));
      const evidence = evidenceBundle(analysis, ml);
      const risk = evaluateRisk({ account: engine.getAccount(), wallets: engine.snapshot().wallets, positions: engine.getPositions(), trades: engine.getTrades(), quote: quotes[s], now: clock, analysis, mode: h % 2 ? "short" : "long", symbol: s });
      const decision = fuse({ analysis, ml, risk, evidence });
      const mode = decision.action === "open_long" && h % 2 === 0 ? "long" : "short";
      engine.engine.lastSignals[s] = analysis.direction;
      if (decision.action === "open_long" || decision.action === "open_short") {
        candidates.push({
          mode, symbol: s, direction: analysis.direction, signal_timestamp: clock, quote: quotes[s], analysis,
          riskPct: 15, decision_id: "dec_" + s + "_" + clock, engine_version: "rule-v0.1", model_version: "lightgbm-v0.1"
        });
      }
    }
    const loop = await engine.loop({ quotes, candidates, analysis: null });
    stats.loops += 1;
    stats.orders = engine.getOrders().length;
    stats.exits = engine.getTrades().length;
    const open = engine.getPositions().filter((p) => p.status === "OPEN");
    stats.max_positions = Math.max(stats.max_positions, open.length);
    const dupPos = new Set();
    for (const p of open) {
      const k = p.mode + "|" + p.symbol + "|" + p.side;
      if (dupPos.has(k)) stats.duplicate_positions += 1;
      dupPos.add(k);
    }
    const snap = engine.snapshot((s) => (quotes[s] ? quotes[s].price : 0));
    const acct = snap.account;
    if (num(acct.cash_balance) < 0) stats.negative_balance += 1;
    for (const v of [acct.cash_balance, acct.total_equity, acct.realized_pnl, acct.unrealized_pnl]) {
      if (!Number.isFinite(Number(v))) stats.nan_or_inf += 1;
    }
    // 会计一致性:Equity = cash + Σ(entry_notional + 浮盈)
    const pf = portfolio(acct, snap.wallets, open, (s) => (quotes[s] ? quotes[s].price : 0));
    if (Math.abs(num(pf.account.total_equity) - num(acct.total_equity)) > 1e-6) stats.equity_identity_breaks += 1;
    const walletSum = num(pf.wallets.short.allocated_balance) + num(pf.wallets.long.allocated_balance);
    if (!Number.isFinite(walletSum)) stats.wallet_identity_breaks += 1;
    stats.lastEquity = num(acct.total_equity);
    stats.loop_errors = engine.engine.state.errors;
  }

  // Retention:模拟长期运行后的数据量与清理
  // 幂等:全量校验(同一 key 只允许一行)
  const allKeys = engine.getOrders().map((o) => o.idempotency_key).filter(Boolean);
  stats.duplicate_orders = allKeys.length - new Set(allKeys).size;

  const counts = {
    paper_trades: engine.getTrades().length,
    paper_orders: engine.getOrders().length,
    learning_samples: (await ps.all("learning_samples")).length,
    model_registry: (await ps.all("model_registry")).length,
    paper_daily_stats: 0,
    paper_engine_logs: engine.engine.logs.length,
    debug_logs: 5000,
    sync_queue_synced: 3000,
    ai_review_cache: 900
  };
  const plan = planRetention(counts, { now: clock });
  const sampleTrades = engine.getTrades().slice();
  const applied = applyRetention("paper_trades", sampleTrades, RETENTION_POLICY, {});
  const coreCheck = coreHistoryIntact({ paper_trades: sampleTrades.length, learning_samples: counts.learning_samples }, { paper_trades: applied.keep.length, learning_samples: counts.learning_samples });

  return {
    days,
    store,
    engine,
    stats: {
      ...stats,
      trades_preserved: applied.keep.length,
      core_history_intact: coreCheck.intact,
      retention_actions: plan.delete_rows.length + plan.trim_rows.length,
      logs_bounded: engine.engine.logs.length <= 500,
      duration_days: (clock - startClock) / 86400000
    },
    retention_plan: plan,
    core_check: coreCheck
  };
}
