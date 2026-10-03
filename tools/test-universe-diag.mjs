// tools/test-universe-diag.mjs · V16 §15/§21/§22/§24 币种池 + 行为异常 + 诊断黑匣子 + 断线恢复
// 核心主张:
//   币种池  —— 山塞币硬门槛不过只能"看",新币没预热不准开仓,但持仓币永远不能被踢出;
//   行为    —— 频率/持仓/费用/杠杆/模型方向的退化都要被抓;异常盈利先查账,不庆祝;
//   诊断    —— 同一错误只占一条(count 累加),导出前必须脱敏,P0 错误永不淘汰;
//   重连    —— 指数退避 + 风暴守卫,4xx/地域封锁不重试,补回来的历史 K 线不触发决策。
import {
  UNIVERSE_VERSION, UNIVERSE_TIERS, UNIVERSE_TIER_ZH, SYMBOL_STATES, SYMBOL_STATE_ZH,
  UNIVERSE_GATES, CORE_SYMBOLS, evaluateSymbol, universeScore, warmingUpStatus,
  buildUniverse, selectActiveSymbols, universeView
} from "../worker/src/paper/symbolUniverse.js";
import {
  BEHAVIOR_VERSION, BEHAVIOR_CODES, BEHAVIOR_ZH, BEHAVIOR_THRESHOLDS,
  detectBehaviorAnomalies, abnormalProfitAudit, behaviorView
} from "../worker/src/paper/behaviorAnomaly.js";
import {
  DIAG_VERSION, DIAG_LEVELS, DIAG_SECRET_PATTERNS, createDiagnostics, classifyErrorZh,
  diagErrorId, diagDedupeKey, captureError, diagBreadcrumb, diagSnapshot, diagRedact,
  diagExportBundle, diagDedupeSummary, diagnosticsView
} from "../worker/src/paper/diagnostics.js";
import {
  RECONNECT_VERSION, RECONNECT_DEFAULTS, createReconnectScheduler, reconnectClassifyError,
  reconnectNextDelay, reconnectAttempt, reconnectSuccess, reconnectView, classifyMarketEvent,
  dedupeCandles, shouldTriggerDecision, reconnectPlan
} from "../worker/src/paper/reconnect.js";

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
  check(name, Math.abs(actual - expected) <= (tol == null ? 1e-9 : tol), `got ${actual} want ~${expected}`);
}

const T0 = 1700000000000; // 2023-11-14T22:13:20Z
const D0 = 1700000000000;

// ======================= A. 动态币种池 §15 =======================
console.log("== A. 动态币种池 ==");
{
  eq("A0  版本号", UNIVERSE_VERSION, "symbol-universe-v1.0");
  eq("A1  分层枚举", UNIVERSE_TIERS, ["CORE", "CANDIDATE", "WATCH"]);
  eq("A2  状态枚举", SYMBOL_STATES, ["ACTIVE", "OBSERVE_ONLY", "WARMING_UP", "SUSPENDED"]);
  check("A3  门槛表 7 项", Object.keys(UNIVERSE_GATES).length === 7, JSON.stringify(Object.keys(UNIVERSE_GATES)));
  eq("A4  核心币清单", CORE_SYMBOLS, ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"]);
  eq("A5  分层中文", UNIVERSE_TIER_ZH.CORE, "核心");
  eq("A6  状态中文", SYMBOL_STATE_ZH.SUSPENDED, "暂停(数据异常)");

  const M_BTC = { symbol: "BTCUSDT", quote_volume_usdt: 3e9, spread_bps: 1, depth_usdt: 5e6, change_pct_24h: 2, candles_seen: 5000, listing_age_days: 2000, price: 60000 };
  const M_ETH = { symbol: "ETHUSDT", quote_volume_usdt: 1.5e9, spread_bps: 1.5, depth_usdt: 4e6, change_pct_24h: 3, candles_seen: 5000, listing_age_days: 1500, price: 3000 };
  const M_GOOD = { symbol: "LINKUSDT", quote_volume_usdt: 3e8, spread_bps: 2, depth_usdt: 1.5e6, change_pct_24h: 4, candles_seen: 3000, listing_age_days: 1200, price: 15 };
  const M_LOWVOL = { symbol: "DOGEUSDT", quote_volume_usdt: 800000, spread_bps: 3, depth_usdt: 300000, change_pct_24h: 2, candles_seen: 1000, listing_age_days: 1000, price: 0.1 };
  const M_NEW = { symbol: "NEWUSDT", quote_volume_usdt: 2e8, spread_bps: 2, depth_usdt: 2e6, change_pct_24h: 4, candles_seen: 12, listing_age_days: 5, price: 1.2 };
  const M_CONFLICT = { symbol: "XYZUSDT", quote_volume_usdt: 2e8, spread_bps: 2, depth_usdt: 2e6, change_pct_24h: 3, candles_seen: 900, listing_age_days: 500, price: 1, provider_conflict: true };
  const M_JUMP = { symbol: "ABCUSDT", quote_volume_usdt: 2e8, spread_bps: 2, depth_usdt: 2e6, change_pct_24h: 40, candles_seen: 900, listing_age_days: 500, price: 1 };

  const btc = evaluateSymbol(M_BTC);
  eq("A7  核心币 tier=CORE", btc.tier, "CORE");
  eq("A8  核心币状态 ACTIVE", btc.state, "ACTIVE");
  eq("A9  核心币 is_core 标记", btc.is_core, true);
  check("A10 核心币 score 偏高", btc.score >= 70, String(btc.score));
  check("A11 核心币原因含“核心币”", btc.reasons_zh.some((r) => r.includes("核心币")), JSON.stringify(btc.reasons_zh));

  // 核心币即使某些流动性指标略差,也依然是 CORE / 不降级
  const btcPoor = evaluateSymbol({ symbol: "BTCUSDT", quote_volume_usdt: 1e6, spread_bps: 20, depth_usdt: 5000, change_pct_24h: 3, candles_seen: 5000 });
  eq("A12 核心币流动性差仍 tier=CORE", btcPoor.tier, "CORE");
  eq("A13 核心币流动性差不降级", btcPoor.state, "ACTIVE");

  // 山塞币硬门槛不过 → OBSERVE_ONLY
  const alt = evaluateSymbol(M_LOWVOL);
  eq("A14 低成交额山寨币 → OBSERVE_ONLY", alt.state, "OBSERVE_ONLY");
  eq("A15 低成交额山寨币 tier=WATCH", alt.tier, "WATCH");
  check("A16 成交额门槛被标未过", alt.gates.find((g) => g.key === "min_quote_volume_usdt").pass === false);
  check("A17 原因中文可读", alt.reasons_zh.some((r) => r.includes("成交额")), JSON.stringify(alt.reasons_zh));

  // 新币预热不足 → WARMING_UP(上市天数不足也归到预热)
  const fresh = evaluateSymbol(M_NEW);
  eq("A18 新币 candles 不足 → WARMING_UP", fresh.state, "WARMING_UP");
  eq("A19 新币 tier=WATCH", fresh.tier, "WATCH");
  check("A20 新币原因含“预热”", fresh.reasons_zh.some((r) => r.includes("预热")), JSON.stringify(fresh.reasons_zh));
  const wu = warmingUpStatus("NEWUSDT", 12);
  eq("A21 预热 state", wu.state, "WARMING_UP");
  eq("A22 预热 need=200", wu.need, 200);
  eq("A23 预热 ready=false", wu.ready, false);
  eq("A24 预热 progress=6%", wu.progress_pct, 6);
  eq("A25 预热中文", wu.zh, "预热中 12/200 根");
  check("A26 满 200 根 → ready", warmingUpStatus("NEWUSDT", 200).ready === true);
  eq("A27 预热完成 state=ACTIVE", warmingUpStatus("NEWUSDT", 300).state, "ACTIVE");
  eq("A28 预热完成 progress=100", warmingUpStatus("NEWUSDT", 300).progress_pct, 100);

  // 数据异常 → SUSPENDED
  const conflict = evaluateSymbol(M_CONFLICT);
  eq("A29 provider_conflict → SUSPENDED", conflict.state, "SUSPENDED");
  check("A30 冲突原因中文", conflict.reasons_zh.some((r) => r.includes("冲突")), JSON.stringify(conflict.reasons_zh));
  const jump = evaluateSymbol(M_JUMP);
  eq("A31 价格异常跳变 → SUSPENDED", jump.state, "SUSPENDED");
  check("A32 跳变门槛未过", jump.gates.find((g) => g.key === "max_abnormal_jump_pct").pass === false);

  // 分数
  check("A33 分数在 0..100", [M_BTC, M_LOWVOL, M_NEW].every((m) => universeScore(m) >= 0 && universeScore(m) <= 100));
  check("A34 流动性好的币分数更高", universeScore(M_GOOD) < universeScore(M_BTC), universeScore(M_GOOD) + " vs " + universeScore(M_BTC));

  // 池子组装
  const uni = buildUniverse({ tickers: [M_BTC, M_ETH, M_GOOD, M_LOWVOL, M_NEW, M_CONFLICT], holding: ["DOGEUSDT"] });
  eq("A35 core 只含核心币", uni.core.map((e) => e.symbol).sort(), ["BTCUSDT", "ETHUSDT"]);
  eq("A36 active_count=3", uni.active_count, 3);
  check("A37 新币在 warming_up", uni.warming_up.some((e) => e.symbol === "NEWUSDT"), JSON.stringify(uni.warming_up.map((e) => e.symbol)));
  check("A38 冲突币在 suspended", uni.suspended.some((e) => e.symbol === "XYZUSDT"));
  check("A39 低成交额币在 observe_only", uni.observe_only.some((e) => e.symbol === "DOGEUSDT"));
  // 持仓币永远不能被踢出
  check("A40 持仓币仍在候选层", uni.candidate.some((e) => e.symbol === "DOGEUSDT"), JSON.stringify(uni.candidate.map((e) => e.symbol)));
  check("A41 持仓币标注 held=true", uni.candidate.find((e) => e.symbol === "DOGEUSDT").held === true);
  check("A42 持仓币不在 watch", !uni.watch.some((e) => e.symbol === "DOGEUSDT"));
  check("A43 持仓币仍在 all", uni.all.some((e) => e.symbol === "DOGEUSDT"));
  check("A44 持仓币原因说明不被踢出", uni.candidate.find((e) => e.symbol === "DOGEUSDT").reasons_zh.some((r) => r.includes("不允许被踢出")));

  // 选股:先轻量扫,再筛少数跑完整模型
  const picked = selectActiveSymbols(uni, 10);
  eq("A45 只选到 3 个可交易", picked.length, 3);
  check("A46 新币不被选", !picked.some((e) => e.symbol === "NEWUSDT"));
  check("A47 仅观察币不被选", !picked.some((e) => e.symbol === "DOGEUSDT"));
  check("A48 暂停币不被选", !picked.some((e) => e.symbol === "XYZUSDT"));
  eq("A49 CORE 优先在首位", picked[0].tier, "CORE");
  eq("A50 只取 n 个", selectActiveSymbols(uni, 2).length, 2);
  eq("A51 n=0 时返回空", selectActiveSymbols(uni, 0).length, 0);
  check("A52 空池安全", Array.isArray(selectActiveSymbols(null, 5)) && selectActiveSymbols(null, 5).length === 0);

  // 无行情的持仓币也要补位
  const uni2 = buildUniverse({ tickers: [M_BTC], holding: ["SOLUSDT"] });
  check("A53 无行情持仓币补占位且不丢", uni2.candidate.some((e) => e.symbol === "SOLUSDT" && e.held === true && e.metrics_missing === true));

  const uv = universeView(uni);
  eq("A54 视图 total 计数", uv.counts.total, 6);
  check("A55 视图标题含“可交易”", uv.headline_zh.includes("可交易"), uv.headline_zh);
  check("A56 视图列出核心币", uv.core_zh.some((l) => l.includes("BTCUSDT")), JSON.stringify(uv.core_zh));
}

// ======================= B. 行为异常检测 §22 =======================
console.log("== B. 行为异常检测 ==");
{
  eq("B1  版本号", BEHAVIOR_VERSION, "behavior-anomaly-v1.0");
  eq("B2  异常码 12 个", Object.keys(BEHAVIOR_CODES).length, 12);
  check("B3  每个码都有中文", Object.values(BEHAVIOR_CODES).every((c) => typeof BEHAVIOR_ZH[c] === "string" && BEHAVIOR_ZH[c].length > 0));
  eq("B4  阈值可读", [BEHAVIOR_THRESHOLDS.trade_freq_multiple, BEHAVIOR_THRESHOLDS.drought_ms, BEHAVIOR_THRESHOLDS.suspicious_gain_pct], [3, 21600000, 25]);

  const now = T0;
  const base = { trades_per_hour: 2, avg_fee: 0.1, avg_holding_ms: 3600000 };

  // 交易频率 5 倍
  const spikeTrades = [];
  for (let i = 0; i < 10; i += 1) {
    spikeTrades.push({ at: now - i * 60000, fees: 0.1, holding_ms: 3600000, net_pnl: 0.5, symbol: "BTCUSDT", direction: "LONG", leverage: 3 });
  }
  const an1 = detectBehaviorAnomalies({ now: now, recent_trades: spikeTrades, baseline: base, equity_before: 1000, equity_now: 1005 });
  check("B5  交易频率 5 倍 → TRADE_FREQ_SPIKE", an1.some((a) => a.code === "TRADE_FREQ_SPIKE"), JSON.stringify(an1.map((a) => a.code)));
  eq("B6  频率异常等级 WARN", an1.find((a) => a.code === "TRADE_FREQ_SPIKE").severity, "WARN");
  check("B7  频率异常中文含“频率”", an1.find((a) => a.code === "TRADE_FREQ_SPIKE").zh.includes("频率"));
  check("B8  频率异常证据含倍数", an1.find((a) => a.code === "TRADE_FREQ_SPIKE").evidence.multiple === 5);

  // 长时间不交易
  const an2 = detectBehaviorAnomalies({ now: now, recent_trades: [{ at: now - 7 * 3600000, fees: 0.1, holding_ms: 1000, net_pnl: 0 }], baseline: { trades_per_hour: 0, avg_fee: 0, avg_holding_ms: 0 } });
  check("B9  7 小时无成交 → TRADE_DROUGHT", an2.some((a) => a.code === "TRADE_DROUGHT"), JSON.stringify(an2.map((a) => a.code)));

  // 持仓时间骤降
  const an3 = detectBehaviorAnomalies({ now: now, recent_trades: [{ at: now, holding_ms: 60000, fees: 0.1, net_pnl: 0 }], baseline: base });
  check("B10 持仓时间骤降 → HOLDING_COLLAPSE", an3.some((a) => a.code === "HOLDING_COLLAPSE"), JSON.stringify(an3.map((a) => a.code)));

  // 手续费骤升
  const an4 = detectBehaviorAnomalies({ now: now, recent_trades: [{ at: now, holding_ms: 3600000, fees: 0.9, net_pnl: 0 }], baseline: base });
  check("B11 手续费骤升 → FEE_SPIKE", an4.some((a) => a.code === "FEE_SPIKE"), JSON.stringify(an4.map((a) => a.code)));

  // 杠杆恒为同值 + 模型同方向
  const an5 = detectBehaviorAnomalies({ now: now, leverage_values: [3, 3, 3, 3], models: [{ kind: "rule", bull: 0.6, bear: 0.4 }, { kind: "ml", bull: 0.7, bear: 0.3 }] });
  check("B12 杠杆恒为同值 → LEVERAGE_FLAT", an5.some((a) => a.code === "LEVERAGE_FLAT"), JSON.stringify(an5.map((a) => a.code)));
  check("B13 模型全部同方向 → MODELS_SAME_DIRECTION", an5.some((a) => a.code === "MODELS_SAME_DIRECTION"), JSON.stringify(an5.map((a) => a.code)));
  eq("B14 同方向证据方向 BULL", an5.find((a) => a.code === "MODELS_SAME_DIRECTION").evidence.direction, "BULL");

  // 模型全部中性
  const an6 = detectBehaviorAnomalies({ now: now, models: [{ kind: "rule", direction: "Neutral" }, { kind: "ml", bull: 0.51, bear: 0.49, direction: "Neutral" }, { kind: "predictor", direction: "Neutral" }] });
  check("B15 模型全部中性 → MODELS_ALL_NEUTRAL", an6.some((a) => a.code === "MODELS_ALL_NEUTRAL"), JSON.stringify(an6.map((a) => a.code)));
  check("B16 全中性不报同方向", !an6.some((a) => a.code === "MODELS_SAME_DIRECTION"));

  // Runtime tick 停止
  const an7 = detectBehaviorAnomalies({ now: now, last_tick_at: now - 6 * 60000 });
  check("B17 tick 停止 → RUNTIME_TICK_STOP", an7.some((a) => a.code === "RUNTIME_TICK_STOP"), JSON.stringify(an7.map((a) => a.code)));
  eq("B18 tick 停止 CRITICAL", an7.find((a) => a.code === "RUNTIME_TICK_STOP").severity, "CRITICAL");

  // 净值单 tick 跳变
  const an8 = detectBehaviorAnomalies({ now: now, telemetry_history: [{ at: now - 1000, equity: 100 }, { at: now, equity: 120 }] });
  check("B19 净值单 tick 跳 20% → EQUITY_TICK_JUMP", an8.some((a) => a.code === "EQUITY_TICK_JUMP"), JSON.stringify(an8.map((a) => a.code)));

  // PnL 巨亏
  const an9 = detectBehaviorAnomalies({ now: now, equity_before: 1000, equity_now: 800, recent_trades: [{ at: now, net_pnl: -100, fees: 0.1, holding_ms: 1000 }] });
  check("B20 单轮巨亏 10% → PNL_SHOCK_LOSS", an9.some((a) => a.code === "PNL_SHOCK_LOSS"), JSON.stringify(an9.map((a) => a.code)));
  eq("B21 巨亏 CRITICAL", an9.find((a) => a.code === "PNL_SHOCK_LOSS").severity, "CRITICAL");

  // 暴涨但账实不符 → 记账可疑
  const an10 = detectBehaviorAnomalies({ now: now, equity_before: 100, equity_now: 180, account_delta_sum: 80.0001, trade_delta_sum: 79.9 });
  check("B22 暴涨且账实不符 → ACCOUNTING_SUSPECT_GAIN", an10.some((a) => a.code === "ACCOUNTING_SUSPECT_GAIN"), JSON.stringify(an10.map((a) => a.code)));

  // 正常快照应无异常
  const clean = detectBehaviorAnomalies({ now: now, recent_trades: [{ at: now, fees: 0.1, holding_ms: 3600000, net_pnl: 0.2 }], baseline: base, equity_before: 1000, equity_now: 1000.2 });
  eq("B23 正常快照无异常", clean.length, 0);

  const bv = behaviorView([{ code: "PNL_SHOCK_LOSS", zh: "盈亏突然巨亏", severity: "WARN", detail_zh: "x" }, { code: "RUNTIME_TICK_STOP", zh: "后台运行 tick 停止", severity: "CRITICAL", detail_zh: "y" }]);
  eq("B24 视图 CRITICAL 排前", bv[0].severity, "CRITICAL");
  eq("B25 视图严重度中文", bv[0].severity_zh, "严重");
  eq("B26 空列表安全", behaviorView(null).length, 0);

  // abnormalProfitAudit:先查账
  const dupTrades = [
    { trade_id: "T1", position_id: "P1", direction: "LONG", entry_price: 100, price: 118, market_price: 118, qty: 1, notional: 100, realized_pnl: 18 },
    { trade_id: "T1", position_id: "P1", direction: "LONG", entry_price: 100, price: 118, market_price: 118, qty: 1, notional: 100, realized_pnl: 18 }
  ];
  const audit1 = abnormalProfitAudit({ equity_before: 100, equity_after: 180, window_ms: 20 * 60000, trades: dupTrades });
  eq("B27 100→180 重复记账 → suspicious", audit1.suspicious, true);
  check("B28 含 ACCOUNTING_SUSPECT_GAIN", audit1.codes.includes("ACCOUNTING_SUSPECT_GAIN"), JSON.stringify(audit1.codes));
  check("B29 Duplicate Accounting 未过", audit1.checks.find((c) => c.code === "DUPLICATE_ACCOUNTING").pass === false);
  check("B30 Double PnL 未过", audit1.checks.find((c) => c.code === "DOUBLE_PNL").pass === false);
  near("B31 gain_pct=80%", audit1.gain_pct, 80, 1e-6);
  check("B32 原因中文提到账目", audit1.reason_zh.includes("账目"), audit1.reason_zh);

  const audit2 = abnormalProfitAudit({ equity_before: 100, equity_after: 103, window_ms: 20 * 60000, trades: [{ trade_id: "T9", position_id: "P9", direction: "LONG", entry_price: 100, price: 103, market_price: 103, qty: 1, notional: 100, realized_pnl: 3 }] });
  eq("B33 正常盈利(100→103)不报可疑", audit2.suspicious, false);
  near("B34 gain_pct=3", audit2.gain_pct, 3, 1e-6);
  eq("B35 正常盈利 codes 为空", audit2.codes.length, 0);

  const audit3 = abnormalProfitAudit({ equity_before: 100, equity_after: 100.5, trades: [{ trade_id: "T5", position_id: "P5", direction: "LONG", entry_price: 100, price: 120, market_price: 100, qty: 1, notional: 100, realized_pnl: 0.5 }] });
  check("B36 成交价偏离 20% → Wrong Price 未过", audit3.checks.find((c) => c.code === "WRONG_PRICE").pass === false);
  check("B37 Wrong Price → suspicious 且含可疑码", audit3.suspicious === true && audit3.codes.includes("ACCOUNTING_SUSPECT_GAIN"));

  const audit4 = abnormalProfitAudit({ equity_before: 100, equity_after: 99, trades: [{ trade_id: "T7", position_id: "P7", direction: "LONG", entry_price: 100, price: 110, market_price: 110, qty: 1, notional: 100, realized_pnl: -8 }] });
  check("B38 方向与盈亏矛盾 → WRONG_SIDE 未过", audit4.checks.find((c) => c.code === "WRONG_SIDE").pass === false);

  const audit5 = abnormalProfitAudit({ equity_before: 100, equity_after: 100, trades: [{ trade_id: "T3", position_id: "P3", direction: "LONG", entry_price: 1, price: 1, market_price: 1, qty: 1000, notional: 1, realized_pnl: 0 }] });
  check("B39 量级错误 → UNIT_ERROR 未过", audit5.checks.find((c) => c.code === "UNIT_ERROR").pass === false);

  const audit6 = abnormalProfitAudit({ equity_before: 100, equity_after: 100 });
  eq("B40 无成交无盈利 → 不可疑", audit6.suspicious, false);
  eq("B41 无成交 gain_pct=0", audit6.gain_pct, 0);
}

// ======================= C. 系统诊断 / 黑匣子 §21 =======================
console.log("== C. 系统诊断 ==");
{
  eq("C1  版本号", DIAG_VERSION, "diagnostics-v1.0");
  eq("C2  levels 含 FATAL", DIAG_LEVELS.FATAL, "FATAL");
  check("C3  密钥模式命中 api_key", DIAG_SECRET_PATTERNS.some((re) => re.test("api_key")));
  check("C4  密钥模式命中 authorization", DIAG_SECRET_PATTERNS.some((re) => re.test("Authorization")));

  let clock = T0;
  const diag = createDiagnostics({ now: () => clock });
  eq("C5  初始无错误", diag.errors.length, 0);
  eq("C6  errors 上限默认 200", diag.limits.errors, 200);
  eq("C7  假时钟生效", diag.now(), T0);

  for (let i = 0; i < 100; i += 1) {
    clock = T0 + i;
    captureError(diag, new Error("Runtime tick failed"), { at: clock, symbol: "BTCUSDT" });
  }
  eq("C8  同一错误 100 次只 1 条记录", diag.errors.length, 1);
  eq("C9  同一错误 count=100", diag.errors[0].count, 100);
  eq("C10 重复登记后 count=101", captureError(diag, new Error("Runtime tick failed"), { at: clock }).count, 101);
  eq("C11 累计登记次数 101", diag.counters.errors_total, 101);
  eq("C12 去重摘要文案", diagDedupeSummary(diag)[0].summary_zh, "同类错误出现 101 次");

  captureError(diag, new TypeError("Failed to fetch"), { at: T0 + 100, symbol: "ETHUSDT" });
  eq("C13 第二类错误新增一条", diag.errors.length, 2);
  const bundle0 = diagExportBundle(diag, {});
  check("C14 导出按 first_at 排序", bundle0.errors[0].first_at <= bundle0.errors[1].first_at, JSON.stringify(bundle0.errors.map((e) => e.first_at)));

  clock = T0 + 100000;
  const rec3 = captureError(diag, new Error("IndexedDB open failed"), { at: clock });
  check("C15 ERR 编号格式", /^ERR-\d{8}-\d{4}$/.test(rec3.id), rec3.id);
  eq("C16 假时钟下 UTC 日期正确", rec3.id.slice(4, 12), "20231114");
  eq("C17 当日序号递增到 0003", rec3.id, "ERR-20231114-0003");

  const cNet = classifyErrorZh(new Error("Failed to fetch: network error"));
  const cStore = classifyErrorZh(new Error("IndexedDB open failed: quota exceeded"));
  const cModel = classifyErrorZh(new Error("model artifact load failed"));
  const cRt = classifyErrorZh(new Error("runtime stopped unexpectedly"));
  eq("C18 网络类中文", cNet.zh, "行情服务连接失败");
  eq("C19 存储类中文", cStore.zh, "数据库不可用");
  eq("C20 模型类中文", cModel.zh, "模型加载失败");
  eq("C21 运行时类中文", cRt.zh, "后台运行停止");
  check("C22 三类中文互不相同", new Set([cNet.zh, cStore.zh, cModel.zh]).size === 3);
  eq("C23 未知错误回落", classifyErrorZh(new Error("weird thing")).zh, "系统异常");
  check("C24 technical 保留栈详情", cNet.technical.includes("Failed to fetch"), cNet.technical.slice(0, 60));

  // P0 不淘汰
  const d2 = createDiagnostics({ now: () => T0, limits: { errors: 3, breadcrumbs: 5, snapshots: 2 } });
  captureError(d2, new Error("P0 ledger mismatch"), { at: T0, p0: true });
  captureError(d2, new Error("P0 crash"), { at: T0 + 1, p0: true });
  for (let i = 0; i < 10; i += 1) captureError(d2, new Error("noise " + i + " 123456"), { at: T0 + 2 + i });
  eq("C25 P0 单独保存在 p0_errors", d2.p0_errors.length, 2);
  check("C26 P0 在 errors 中未被淘汰", d2.errors.some((e) => e.p0 === true && e.zh === "系统异常"));
  check("C27 非 P0 被淘汰到上限内", d2.errors.filter((e) => !e.p0).length <= 1, String(d2.errors.filter((e) => !e.p0).length));
  check("C28 errors 总数受限", d2.errors.length <= 3, String(d2.errors.length));

  // 脱敏
  const red = diagRedact({ api_key: "x", nested: { authorization: "Bearer y", ok: 1 } });
  check("C29 api_key 被掩码", red.api_key !== "x", JSON.stringify(red));
  check("C30 authorization 被掩码", red.nested.authorization !== "Bearer y");
  eq("C31 非敏感字段保留", red.nested.ok, 1);
  check("C32 序列化不含密钥原文", !JSON.stringify(red).includes("Bearer y") && !JSON.stringify(red).includes("\"x\""));
  eq("C33 sk- 串被掩码", diagRedact("key=sk-abcdef123456"), "key=***");
  eq("C34 长十六进制串被掩码", diagRedact("v=" + "a".repeat(40)), "v=***");

  // 导出脱敏
  const d3 = createDiagnostics({ now: () => T0 });
  captureError(d3, new Error(("auth failed with token " + ["sk", "supersecret123456"].join("-"))), { at: T0, api_key: ["sk", "live", "abcdef123456"].join("-"), authorization: ("Bearer " + "topsecretvalue") });
  const bundle3 = diagExportBundle(d3, { api_key: ["sk", "meta", "abcdef123456"].join("-"), note: "ok" });
  check("C35 导出 text 不含 meta 密钥", !bundle3.text.includes("sk-meta-abcdef123456"));
  check("C36 导出 text 不含错误原文密钥", !bundle3.text.includes("sk-supersecret123456"));
  check("C37 导出 text 不含 Bearer 原文", !bundle3.text.includes("topsecretvalue"));
  eq("C38 导出 meta 已脱敏", bundle3.meta.api_key, "***");
  check("C39 导出 text 含中文标题", bundle3.text.includes("系统诊断报告"));
  check("C40 导出 text 含技术详情段", bundle3.text.includes("技术详情"));
  eq("C41 导出 errors 去重后 1 条", bundle3.errors.length, 1);

  // 面包屑环形缓冲
  const d4 = createDiagnostics({ now: () => T0, limits: { errors: 200, breadcrumbs: 5, snapshots: 2 } });
  for (let i = 0; i < 12; i += 1) diagBreadcrumb(d4, { at: T0 + i, kind: "tick", detail: "n" + i });
  eq("C42 面包屑只保留最近 5 条", d4.breadcrumbs.length, 5);
  eq("C43 保留的是最新的", d4.breadcrumbs[4].detail, "n11");
  eq("C44 最旧的被丢弃", d4.breadcrumbs[0].detail, "n7");

  // 快照环形缓冲 + 字段
  for (let i = 0; i < 5; i += 1) diagSnapshot(d4, { at: T0 + i, page: "home", mode: "short", equity: 100 + i });
  eq("C45 快照只保留最近 2 份", d4.snapshots.length, 2);
  eq("C46 最近快照是最新", d4.snapshots[1].equity, 104);
  diagSnapshot(d4, { at: T0 + 9, app_version: "16.0", runtime_version: "r", model_version: "m", schema_version: "s", page: "paper", symbol: "BTCUSDT", mode: "short", paper_engine: "on", last_market_tick: T0, last_risk_tick: T0, last_strategy_tick: T0, database: "ok", memory: "12MB", network: "ok" });
  eq("C47 快照保留页面与币种", [d4.snapshots[1].page, d4.snapshots[1].symbol], ["paper", "BTCUSDT"]);
  eq("C48 快照保留版本字段", d4.snapshots[1].app_version, "16.0");

  const dv = diagnosticsView(d4);
  eq("C49 视图面包屑计数", dv.counts.breadcrumbs, 5);
  eq("C50 视图快照计数", dv.counts.snapshots, 2);
  check("C51 视图标题含“错误”", dv.headline_zh.includes("错误"), dv.headline_zh);

  const e1 = new Error("tick 123456 failed");
  e1.stack = "Error: tick 123456 failed\n    at job (/app/run.js:12:3)";
  const e2 = new Error("tick 999999 failed");
  e2.stack = "Error: tick 999999 failed\n    at job (/app/rerun.js:99:7)";
  eq("C52 大数字/路径归一化后指纹一致", diagDedupeKey(e1), diagDedupeKey(e2));
  check("C53 不同错误指纹不同", diagDedupeKey(new Error("aaa")) !== diagDedupeKey(new Error("bbb")));
  check("C54 ERR 编号可用假时钟生成", /^ERR-\d{8}-\d{4}$/.test(diagErrorId(createDiagnostics({ now: () => T0 }), T0)));
}

// ======================= D. 断线恢复调度 §24 =======================
console.log("== D. 断线恢复调度 ==");
{
  eq("D1  版本号", RECONNECT_VERSION, "reconnect-v1.0");
  eq("D2  默认 kinds 5 个", RECONNECT_DEFAULTS.kinds.length, 5);
  eq("D3  默认风暴阈值 = 6", RECONNECT_DEFAULTS.max_attempts_per_window, 6);
  eq("D4  默认上限 60s", RECONNECT_DEFAULTS.max_ms, 60000);

  // 指数退避 + 抖动
  const s2 = createReconnectScheduler({ now: () => D0 });
  const delays = [];
  for (let i = 0; i < 6; i += 1) {
    const r = reconnectAttempt(s2, "market");
    if (r.allowed) delays.push(r.delay_ms);
  }
  eq("D5  窗口内允许 6 次", delays.length, 6);
  check("D6  退避递增", delays.every((d, i) => i === 0 || d > delays[i - 1]), JSON.stringify(delays));
  check("D7  退避不超过 max_ms", delays.every((d) => d <= 60000), JSON.stringify(delays));
  check("D8  首次退避约 1s(含 ±20% 抖动)", Math.abs(delays[0] - 1000) <= 200, String(delays[0]));
  const r7 = reconnectAttempt(s2, "market");
  eq("D9  第 7 次被 storm_guard 拒绝", r7.allowed, false);
  eq("D10 拒绝原因 storm_guard", r7.reason, "storm_guard");
  check("D11 给出下次可试时间", Number.isFinite(r7.next_at) && r7.next_at === D0 + 60000, String(r7.next_at));

  // 错误分类
  eq("D12 4xx 不重试", reconnectClassifyError({ status: 400 }).retryable, false);
  eq("D13 4xx 类型", reconnectClassifyError({ status: 404 }).kind, "HTTP_4XX");
  eq("D14 5xx 可重试", reconnectClassifyError({ status: 502 }).retryable, true);
  eq("D15 403 被判地域封锁", reconnectClassifyError({ status: 403 }).kind, "BLOCKED");
  eq("D16 403 不重试", reconnectClassifyError({ status: 403 }).retryable, false);
  eq("D17 429 可重试", reconnectClassifyError({ status: 429 }).retryable, true);
  eq("D18 DNS 可重试", reconnectClassifyError(new Error("getaddrinfo ENOTFOUND api.binance.com")).kind, "DNS");
  eq("D19 网络错误分类", reconnectClassifyError(new Error("Failed to fetch")).kind, "NETWORK");
  eq("D20 超时分类", reconnectClassifyError(new Error("request ETIMEDOUT")).kind, "TIMEOUT");
  eq("D21 未知错误不重试", reconnectClassifyError(new Error("???")).retryable, false);

  // 抖动确定性
  const sA = createReconnectScheduler({ now: () => D0 });
  const sB = createReconnectScheduler({ now: () => D0 });
  eq("D22 同 key 同 attempt 抖动一致", reconnectNextDelay(sA, "ai"), reconnectNextDelay(sB, "ai"));
  eq("D23 重复调用结果一致", reconnectNextDelay(sA, "ai"), reconnectNextDelay(sA, "ai"));
  check("D24 不同数据源抖动不同", reconnectNextDelay(sA, "ai") !== reconnectNextDelay(sA, "news"), reconnectNextDelay(sA, "ai") + " vs " + reconnectNextDelay(sA, "news"));
  const sC = createReconnectScheduler({ now: () => D0, opts: { random: () => 0.5 } });
  eq("D25 注入 random=0.5 → 无抖动", reconnectNextDelay(sC, "market"), 1000);

  // 恢复
  const s3 = createReconnectScheduler({ now: () => D0 });
  reconnectAttempt(s3, "funding");
  reconnectAttempt(s3, "funding");
  const ok3 = reconnectSuccess(s3, "funding");
  eq("D26 成功后清空尝试", s3.attempts.funding, undefined);
  eq("D27 成功后清空风暴窗口", s3.windows.funding, undefined);
  eq("D28 成功记入 history", s3.history.length, 1);
  eq("D29 history 记录尝试次数", ok3.attempts, 2);

  // 视图
  const s4 = createReconnectScheduler({ now: () => D0 });
  reconnectAttempt(s4, "market");
  const v4 = reconnectView(s4);
  eq("D30 视图 active 1 个", v4.active.length, 1);
  eq("D31 视图 active key", v4.active[0].key, "market");
  check("D32 next_in_ms 非负", v4.active[0].next_in_ms >= 0, String(v4.active[0].next_in_ms));
  eq("D33 视图未风暴", v4.storm_limited, false);
  eq("D34 视图 history_count=0", v4.history_count, 0);

  // 事件分类
  eq("D35 实时新 K 线 → NEW_EVENT", classifyMarketEvent({ type: "kline", ts: D0, candle_time: D0, source: "ws", last_seen_candle_time: D0 - 60000 }), "NEW_EVENT");
  eq("D36 REST 补历史 → BACKFILL_DUPLICATE", classifyMarketEvent({ type: "kline", ts: D0, candle_time: D0 - 120000, source: "rest", last_seen_candle_time: D0 - 60000 }), "BACKFILL_DUPLICATE");
  eq("D37 明示 backfill → BACKFILL_DUPLICATE", classifyMarketEvent({ type: "backfill", source: "rest_backfill" }), "BACKFILL_DUPLICATE");
  eq("D38 时间戳不前进也算补录", classifyMarketEvent({ candle_time: D0, last_seen_candle_time: D0 }), "BACKFILL_DUPLICATE");
  eq("D39 BACKFILL_DUPLICATE 不触发决策", shouldTriggerDecision("BACKFILL_DUPLICATE"), false);
  eq("D40 NEW_EVENT 触发决策", shouldTriggerDecision("NEW_EVENT"), true);

  // K 线去重
  const prevMap = { [D0]: { open_time: D0, close: 1 }, [D0 + 60000]: { open_time: D0 + 60000, close: 2 } };
  const res = dedupeCandles(prevMap, [
    { open_time: D0 - 60000, close: 0 },
    { open_time: D0, close: 1 },
    { open_time: D0 + 120000, close: 3 }
  ]);
  eq("D41 补回的历史 K 线归入 backfill", res.backfill.length, 1);
  eq("D42 backfill 时间戳正确", res.backfill[0].open_time, D0 - 60000);
  eq("D43 已存在的归入 duplicates", res.duplicates.length, 1);
  eq("D44 真正新的才进 added", res.added.length, 1);
  eq("D45 added 时间戳正确", res.added[0].open_time, D0 + 120000);
  eq("D46 有新 K 线时 changed=true", res.changed, true);
  eq("D47 map 已含新 K 线", res.map[D0 + 120000].close, 3);
  const res2 = dedupeCandles({ [D0]: { open_time: D0 } }, [{ open_time: D0 - 300000 }]);
  eq("D48 只有补历史时 changed=false", res2.changed, false);
  eq("D49 补历史计数", [res2.added.length, res2.duplicates.length, res2.backfill.length], [0, 0, 1]);

  // 计划
  const s5 = createReconnectScheduler({ now: () => D0 });
  reconnectAttempt(s5, "market");
  const plan = reconnectPlan(s5, ["market"]);
  eq("D50 计划允许重试", plan[0].allowed, true);
  eq("D51 计划为第 2 次尝试", plan[0].attempt, 2);
  check("D52 计划给出延迟", plan[0].delay_ms > 0, String(plan[0].delay_ms));
  const s6 = createReconnectScheduler({ now: () => D0 });
  for (let i = 0; i < 6; i += 1) reconnectAttempt(s6, "market");
  const plan2 = reconnectPlan(s6, ["market"]);
  eq("D53 风暴中计划被拦", plan2[0].allowed, false);
  eq("D54 风暴中动作=wait", plan2[0].action, "wait");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("UNIVERSE/DIAG TESTS OK");
