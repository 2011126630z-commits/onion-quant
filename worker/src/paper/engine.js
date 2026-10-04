// paper/engine.js · Paper Trading 引擎(P0:单主循环 / 退出优先 / 风控否决 / 幂等 / 崩溃与离线恢复)
// 设计:引擎与 UI 完全解耦;依赖(store / 行情 / 时钟 / 决策)全部注入,便于测试与将来搬到 Android。
// 不接真实下单:本文件只写模拟账本。
import { PAPER_DEFAULTS, createAccount, portfolio, applyOpen, applyClose, updatePositionPath, evaluateExit, summarizeTrades, summarizePositions, positionSize, num, numOrNull, round, isSafeAmount, canAfford, dayKeyOf, fillPrice, feeOf, sideOf, openQuantityOf, openMarginOf, lossBoundOf, unrealizedPnl, unrealizedNetPnl, estimatedExitFee, accountIntegrityCheck, isValidReturnPct, POSITION_SAMPLE_MIN_NOTIONAL, positionIdOf } from "./accounting.js";
import { clampLeverage, openFuturesPosition, closeFuturesPosition, isLiquidated, liquidationPriceOf, liquidationInvariant, liquidationFillPrice, ratchetStop, buildTakeProfitPlan, updateTrailingStop, applyBreakEven, futuresUnrealized, marginHealth } from "./futures.js";
import { requestLeverage, approveLeverage, shadowEvaluation, LEVERAGE_POLICY } from "./leverageManager.js";
import { createFundingBook, accrueFunding, applyFundingToPosition, FUNDING_STATUS, FU_DEFAULT_INTERVAL_HOURS } from "./funding.js";
import { profitLockDecision, profitLockStateOf, applyProfitLockState, isDustPosition, shadowExitResearch, exitLearningSample, PROFIT_LOCK_WARN_PARTIALS_PER_POSITION } from "./profitLock.js";
import { externalRiskGate } from "./externalData.js";
import { predictionRecord, resolvePrediction, predictorGate, predictionSnapshot, PREDICTOR_HORIZONS } from "./predictor.js";
import { allocationPlan, rebalanceWallets } from "./allocation.js";
import { drawdownMetrics } from "./drawdown.js";
import { reviewCacheKey } from "./support.js";
// V15 MODULE EXPANSION:统一风险 / 成交口径 / 数据质量 / 持仓生命周期 / 通知 / 决策日志 / 恢复计划
import { portfolioRisk, riskVetoForCandidate, RISK_LEVELS } from "./portfolioRisk.js";
import { closeOrder, openOrder, fillReport } from "./execution.js";
import { createDataQualitySentinel } from "./dataQuality.js";
import { createPositionManager, classifyCloseAction, positionManagerView } from "./positionManager.js";
import { createNotificationCenter, notificationDigest } from "./notifications.js";
import { createDecisionJournal, journalContextForChat } from "./decisionJournal.js";
import { recoveryPlan, recoveryView } from "./recovery.js";
import { attributionOf, attributionView, exitBucketOf, isValidTrade } from "./attribution.js";
// V16 资金与决策内核:精确金额 / 开仓质量闸门 / 组合资金分配 / 利润分配 / 高水位保护 / 论点跟踪
import { ledgerExactAudit, toUnits, fromUnits, MONEY_DRIFT_TOLERANCE_UNITS } from "./money.js";
import { entryQuality, minimumMeaningfulPosition, skipShadowRecord, resolveSkipShadow, ENTRY_DECISION_ZH, NO_TRADE_ZH, ENTRY_QUALITY_RULES } from "./entryQuality.js";
import { capitalAllocation, createReserveBook, reserveCapital, commitReserve, releaseReserve, sweepOrphanReservations, reservedTotal, reserveSummary, effectiveExposure, exposureReport, CAPITAL_LIMITS, clusterOfSymbol } from "./capitalAllocator.js";
import { createProfitPool, splitProfitOnPositionClose, protectedBalance, poolLayers, poolSummary, protectedIsolationCheck } from "./profitAllocation.js";
import { createHwmState, updateHwm, hardStopGate, drawdownFromPeak, scaleForDrawdown, HWM_STATE_ZH, recoverFromHardStop, hwmRecord, mergeHwm } from "./hwm.js";
import { buildEntryThesis, evaluateThesis, profitProtectionDecision, lossManagementDecision, flipAllowed, mustExitImmediately, thesisSnapshot, rhythmPolicy } from "./thesis.js";
import { createDiagnostics, diagBreadcrumb, captureError, diagSnapshot, diagExportBundle, diagDedupeSummary, classifyErrorZh } from "./diagnostics.js";
import { detectBehaviorAnomalies, abnormalProfitAudit } from "./behaviorAnomaly.js";
import { createReconnectScheduler, reconnectAttempt, reconnectSuccess, reconnectClassifyError, classifyMarketEvent, shouldTriggerDecision } from "./reconnect.js";
import { evaluateSymbol, UNIVERSE_GATES } from "./symbolUniverse.js";
import { ensembleForecast, ensembleGate } from "./ensemble.js";
import { metaSchedule, combineModels } from "./modelScheduler.js";
import { rankFactors, createFactorStates, FACTOR_REGISTRY } from "./factors.js";
// V16.1:因子影子 / 过度交易监控 / 交易分析 / 入口闸门影子评估 / 树模型影子
import { createFactorShadowState, recordFactorObservation, advanceFactorStates, factorShadowView, activeFactorWeights } from "./factorShadow.js";
import { overtradingStats, detectOvertrading, autoTighten, overtradingView } from "./overtrading.js";
import { sessionAnalysis, dailyAnalysis, redFlagScan, tradeAnalysisView } from "./tradeAnalysis.js";
import { resolveSkippedOutcome, gateShadowEvaluate, calibrationAdvice, entryGateShadowView } from "./entryGateShadow.js";
import { resolveTreeModel, treeRowFromAnalysis, TREE_MODEL_ROLE } from "./treeModel.js";

export const ENGINE_STATES = ["STOPPED", "STARTING", "RUNNING", "PAUSED", "RECOVERING", "ERROR"];
export const MODE_CONFIG = {
  short: { mode: "short", interval: "1h", primary: "15m", env: "4h", minHoldMs: 0, maxHoldMs: 6 * 3600000, stopAtrMult: 1.0, tpAtrMult: 1.6, label: "短线" },
  long: { mode: "long", interval: "4h", primary: "1d", env: "1d", minHoldMs: 0, maxHoldMs: 14 * 86400000, stopAtrMult: 2.2, tpAtrMult: 3.5, label: "长线" }
};
const STALE_QUOTE_MS = 5 * 60000;

// 幂等键:同一 mode+symbol+信号时间+方向 只允许一次下单
export function idempotencyKey(mode, symbol, closedCandleTime, direction, strategyVersion) {
  // 严格使用【已收盘K线时间】,禁止用 Date.now() 作为信号标识
  return [mode, symbol, closedCandleTime, direction, strategyVersion || "rule-v0.1"].join("|");
}

// 收盘K线时间(向下取整到周期边界后减 1ms = 上一根K线收盘时刻)
export function closedCandleTime(nowMs, intervalMs) {
  const iv = num(intervalMs, 3600000);
  return Math.floor(num(nowMs, Date.now()) / iv) * iv - 1;
}

// 简化互斥:引擎内所有写操作串行(单主循环不变式)
export function createMutex() {
  let tail = Promise.resolve();
  return function run(fn) {
    const next = tail.then(() => fn());
    tail = next.catch(() => {});
    return next;
  };
}

export function createEngineState(now) {
  return {
    id: "paper-engine",
    state: "STOPPED",
    started_at: null,
    paused_at: null,
    last_loop_at: null,
    last_candle_time: null,
    loops: 0,
    errors: 0,
    last_error: null,
    token_used_today: 0,
    token_day: dayKeyOf(now || Date.now()),
    // V15.1 §19:已处理收盘K线(按 symbol|mode|interval 分别保存) —— 重启不会重复处理上一根
    last_processed_candles: {},
    schema_version: "v15.1",
    note: ""
  };
}

// 创建引擎(依赖注入)
export function createPaperEngine(deps) {
  const d = deps || {};
  const cfg = { ...PAPER_DEFAULTS, ...(d.config || {}) };
  const now = () => num(d.now ? d.now() : Date.now());
  const mutex = createMutex();
  // 资金费观测簿:费率只能来自上游真实响应;取不到 → unavailable(不随机、不用 0 冒充)
  const fundingBook = d.fundingBook || createFundingBook({ now });
  const engine = {
    state: createEngineState(now()),
    account: null,
    wallets: {},
    positions: [],
    orders: [],
    trades: [],
    lastSignals: {},
    equityCurve: [],
    logs: [],
    loopRunning: false,
    leverageChampion: { short: 2, long: 2 },
    leverageRecords: [],
    fundingBook,
    // V14.4:回撤状态 / 外部上下文 / 预测结果(全部由注入依赖驱动,未注入时保持 null,行为与 V14.3 完全一致)
    lastDrawdown: null,
    externalContext: null,
    predictions: [],
    profitLockLog: [],
    // V15:暂停新开仓(与"停止引擎"区分:现有仓位继续被 Risk/Stop/Exit 管理)
    entriesPaused: false,
    entriesPausedReason: null,
    notifications: [],
    // V15 P0 完整性:价格路由/数据异常审计(串 symbol、脏价、不可能亏损都记在这里)
    integrity: {
      price_symbol_mismatch: 0,
      invalid_price: 0,
      impossible_pnl: 0,
      last_alert: null,
      repairs: []
    },
    // V15 模块化:统一风险结论 / 数据质量 / 持仓生命周期 / 决策日志 / 恢复计划
    lastRisk: null,
    recoveryReport: null,
    // V15.1:已处理收盘K线(symbol|mode|interval → 时间戳)与杠杆状态
    lastProcessedCandles: {},
    leverageChallenger: null,
    leverageLastEvaluation: null,
    // V16:资金分配 / 利润保护池 / 高水位 / 开仓质量 / 论点 / 行为异常 / 黑匣子
    hwm: null,
    lastHwm: null,
    reserveBook: null,
    profitPool: null,
    entryQualityLog: [],
    thesisDecisions: [],
    behaviorAnomalies: [],
    qualitySkips: 0,
    lastQuality: null,
    reconnect: null,
    // V16.1:过度交易自动收紧 / 因子影子 / 树模型影子 / 入口闸门影子
    entryTightening: { threshold_delta: 0, cooldown_multiplier: 1, max_entries_per_hour: null, active: false, reason_zh: null },
    pendingFactorObs: [],
    lastOvertrading: null,
    lastTreeShadow: null,
    treeShadowLog: []
  };
  const dataQualitySentinel = d.dataQuality || createDataQualitySentinel({ now });
  const notificationCenter = d.notificationCenter || createNotificationCenter({ now });
  const decisionJournal = d.journal || createDecisionJournal({ now });
  const positionManager = d.positionManager || createPositionManager({ limit: 800 });
  engine.dataQuality = dataQualitySentinel;
  engine.notificationCenter = notificationCenter;
  engine.journal = decisionJournal;
  engine.positionManager = positionManager;
  // ---- V16 §3/§4/§8/§21/§22/§24:资金预占簿 / 利润保护池 / 高水位 / 黑匣子 / 重连调度 ----
  const reserveBook = d.reserveBook || createReserveBook({ available: 0 });
  const profitPool = d.profitPool || createProfitPool({ now: now() });
  const diagnostics = d.diagnostics || createDiagnostics({ now });
  const reconnectScheduler = d.reconnect || createReconnectScheduler({ now, opts: { random: d.random } });
  engine.reserveBook = reserveBook;
  engine.profitPool = profitPool;
  engine.diag = diagnostics;
  engine.reconnect = reconnectScheduler;
  engine.hwm = d.hwm || createHwmState(num(d.initialHwmEquity, 0), now());
  engine.treeArtifact = d.treeArtifact || null;
  engine.factorShadow = createFactorShadowState(FACTOR_REGISTRY);

  // 当前统一风险结论(Risk Controller 拥有最终 Veto;未接线时按 NORMAL 放行)
  function currentRisk(extra) {
    const money = engine.account || {};
    const today = summarizeTrades(engine.trades.filter((t) => dayKeyOf(t.exit_time) === dayKeyOf(now())));
    const initial = num(money.initial_balance, 100);
    // 注意:这里必须用【当前回撤】(峰值 → 现在),不能用历史 max_drawdown_pct ——
    // 后者是"史上最深回撤",一旦跌过就永远大于 0,会导致永久 HARD_STOP、再也不开仓。
    const peak = num(money.peak_equity, num(money.total_equity, 0));
    const equityNow = num(money.total_equity, peak);
    const currentDrawdownPct = peak > 0 ? Math.max(0, (peak - equityNow) / peak * 100) : 0;
    const risk = portfolioRisk({
      account: money,
      wallets: engine.wallets,
      positions: engine.positions,
      config: cfg,
      daily_pnl_pct: initial > 0 ? round(today.net_pnl / initial * 100, 6) : 0,
      drawdown_pct: round(currentDrawdownPct, 4),
      max_drawdown_pct: num(money.max_drawdown_pct, 0),
      drawdown: engine.lastDrawdown,
      integrity: engine.integrity,
      data_quality: dataQualitySentinel.gate(),
      external_gate: currentExternalGate({}),
      entries_paused: engine.entriesPaused,
      ...(extra || {})
    });
    engine.lastRisk = risk;
    return risk;
  }

  // 决策日志:为什么"没开"也要留痕(以后能回答"刚才为什么没买")
  function journalBlocked(candidate, why, risk) {
    const c = candidate || {};
    const a = c.analysis || {};
    decisionJournal.record({
      kind: "ENTRY_BLOCKED",
      symbol: c.symbol,
      mode: c.mode,
      why,
      rule: { direction: a.direction || null, confidence: a.confidence == null ? null : a.confidence, strength: a.signal_strength || null },
      prediction: c.prediction ? { direction: c.prediction.direction, probability: c.prediction.probability, horizon: c.prediction.horizon } : null,
      risk: risk ? { risk_level: risk.risk_level, veto_reasons: risk.veto_reasons, max_leverage: risk.max_leverage } : null,
      external: engine.externalContext,
      final: { action: "SKIP" }
    });
  }

  // 决策日志与持仓审计:开仓成功时记录"为什么开、为什么这个杠杆"
  function journalEntry(position, input, extra) {
    const a = (input && input.analysis) || {};
    const dec = (input && input.decision) || {};
    const pred = (input && input.prediction) || null;
    decisionJournal.record({
      kind: "ENTRY",
      symbol: position.symbol,
      mode: position.mode,
      action_source: (input && input.action_source) || "AUTO",
      // V16.2u §3/§18:决策日志同样带溯源链("为什么开这单"可回答:哪个信号→哪个意图→哪次决策)
      signal_id: (input && input.signal_id) || position.signal_id || null,
      strategy_intent_id: (input && input.strategy_intent_id) || position.strategy_intent_id || null,
      decision_id: (input && input.decision_id) || position.decision_id || null,
      why: ((input && input.reason) || "信号触发") + " · " + sideOf(position) + " " + num(position.leverage, 1) + "x",
      rule: { direction: a.direction || position.direction, confidence: a.confidence == null ? null : a.confidence, strength: a.signal_strength || null },
      ml: dec.ml ? { version: dec.ml.version || null, probability: dec.ml.probability == null ? null : dec.ml.probability, used: true } : null,
      prediction: pred ? { direction: pred.direction, probability: pred.probability, horizon: pred.horizon } : null,
      risk: engine.lastRisk ? { risk_level: engine.lastRisk.risk_level, veto_reasons: engine.lastRisk.veto_reasons, max_leverage: engine.lastRisk.max_leverage } : null,
      external: engine.externalContext,
      deepseek: extra && extra.deepseek ? extra.deepseek : null,
      final: { action: "OPEN", leverage: num(position.leverage, 1), size: openMarginOf(position) }
    });
    positionManager.transition(position, "OPEN", { action_source: (input && input.action_source) || "AUTO", now: num(input && input.now, now()) });
  }

  // 决策日志:为什么平(exit_reason + 当时的浮动/保护状态)
  function journalExit(position, trade, input) {
    const reason = String((trade && trade.exit_reason) || (input && input.exit_reason) || "manual");
    const net = num(trade && trade.net_pnl, 0);
    const action = classifyCloseAction(reason);
    const partial = Boolean(trade && trade.partial);
    decisionJournal.record({
      kind: "EXIT",
      symbol: position.symbol,
      mode: position.mode,
      action_source: (input && input.action_source) || (input && input.manual ? "MANUAL" : "AUTO"),
      why: reason + (partial ? "(部分平仓)" : "(全部平仓)") + " · 净" + (net >= 0 ? "+" : "") + round(net, 4) + "U"
        + (reason.toUpperCase().includes("LIQUIDATION") ? " · 亏损受保证金约束" : ""),
      rule: { direction: position.direction || null },
      risk: engine.lastRisk ? { risk_level: engine.lastRisk.risk_level } : null,
      external: engine.externalContext,
      final: { action, exit_reason: reason, size: num(trade && trade.quantity, 0) }
    });
    positionManager.transition(position, action, { action_source: (input && input.action_source) || (input && input.manual ? "MANUAL" : "AUTO"), exit_reason: reason, fraction: input && input.fraction, now: num(input && input.now, now()) });
  }

  // 数据完整性告警:一旦出现串价/不可能亏损,立即暂停新开仓并留痕(不允许继续用脏数据做决策)
  function raiseIntegrity(reason, detail) {
    const key = String(reason || "unknown");
    engine.integrity[key] = num(engine.integrity[key], 0) + 1;
    engine.integrity.last_alert = { reason: key, at: now(), detail: detail || null };
    if (!engine.entriesPaused) {
      engine.entriesPaused = true;
      engine.entriesPausedReason = "DATA_INTEGRITY_ALERT:" + key;
      notify("SYSTEM", "数据完整性告警 · 已暂停新开仓", key + (detail ? " · " + String(detail).slice(0, 80) : ""), { key: "integrity|" + key + "|" + now(), always: true, severity: "high" });
    }
    log("integrity", key + " " + JSON.stringify(detail || {}));
    // V16 §21:P0(资金/账本/崩溃类)错误单独保护保存,不参与淘汰
    try {
      engine.diagP0 = captureError(diagnostics, { message: key, name: "IntegrityAlert", stack: "" }, { p0: true, detail: detail || null, symbol: detail && detail.symbol ? detail.symbol : null });
    } catch (error) { /* 诊断绝不阻断主流程 */ }
  }

  function clearIntegrityPause() {
    if (engine.entriesPaused && String(engine.entriesPausedReason || "").startsWith("DATA_INTEGRITY_ALERT")) {
      engine.entriesPaused = false;
      engine.entriesPausedReason = null;
    }
  }

  function log(kind, detail) {
    engine.logs.push({ at: now(), kind, detail });
    if (engine.logs.length > 500) engine.logs.shift();
    // V16 §21:日志同时进黑匣子 breadcrumb(崩溃前最近 100 个关键事件)
    try { diagBreadcrumb(diagnostics, { kind, detail: String(detail == null ? "" : detail).slice(0, 200) }); } catch (error) { /* 诊断绝不阻断主流程 */ }
  }

  // ---- §18 启动完整性迁移(幂等):扫 OPEN 持仓 / 成交 / 学习样本 ----
  // 不可能的数字不允许静默保留:能自洽修的就修(并写 repair_reason),修不了的就按
  // 强平价/止损价立即平掉,并把对应样本标成 invalid_sample。
  async function integrityRepair() {
    const repairs = [];
    const openBefore = engine.positions.filter((p) => p.status === "OPEN").length;

    for (const pos of engine.positions.filter((p) => p.status === "OPEN")) {
      const reasons = [];
      const priceOk = isSafeAmount(pos.current_price);
      const price = priceOk ? num(pos.current_price) : num(pos.entry_price);
      const bound = lossBoundOf(pos);
      const pnl = priceOk ? unrealizedPnl(pos, price) : num(pos.unrealized_pnl);
      const inv = liquidationInvariant({ side: sideOf(pos), entryPrice: pos.entry_price, liquidationPrice: pos.liquidation_price });
      if (!priceOk) reasons.push("invalid_current_price");
      if (!inv.ok) reasons.push("invalid_liquidation:" + inv.detail);
      if (bound > 0 && pnl < -(bound + 1e-6)) reasons.push("loss_beyond_margin");
      const stop = numOrNull(pos.stop_price);
      const stopCrossed = stop != null && ((sideOf(pos) === "LONG" && price <= stop) || (sideOf(pos) === "SHORT" && price >= stop));
      const mfeMaeBroken = bound > 0 && (Math.abs(num(pos.mfe)) > bound * 12 || Math.abs(num(pos.mae)) > bound * 12);
      if (!reasons.length && !stopCrossed && !mfeMaeBroken) continue;
      // §18:持仓上"存着的"浮盈必须与(现价, 剩余数量)一致,否则同样是脏数据
      const storedPnl = numOrNull(pos.unrealized_pnl);
      const recomputedPnl = priceOk ? unrealizedPnl(pos, price) : null;
      if (priceOk && (storedPnl == null || Math.abs(storedPnl - recomputedPnl) > Math.max(1e-6, Math.abs(recomputedPnl) * 1e-6))) {
        reasons.push("unrealized_inconsistent");
      }

      // 1) 结构可修:强平价重算 + 现价回退到开仓价 + mfe/mae 复位
      const fixedLiq = liquidationPriceOf({ side: sideOf(pos), entryPrice: pos.entry_price, leverage: num(pos.leverage, 1), margin: num(pos.remaining_margin, num(pos.initial_margin)) });
      const canRebuild = isSafeAmount(pos.entry_price) && liquidationInvariant({ side: sideOf(pos), entryPrice: pos.entry_price, liquidationPrice: fixedLiq }).ok;
      const repairReason = reasons.join(",") || (stopCrossed ? "stop_crossed_before_migration" : "mfe_mae_broken");
      // 价格本身导致"穿透保证金的亏损"时,说明这个价不可信(串价/脏价):
      // 不能拿它当真实价格,更不能据此实现巨额亏损 —— 退回持平并标 INVALID,等真实价格到来。
      const priceTrustworthy = priceOk && !reasons.includes("loss_beyond_margin");
      if (canRebuild) {
        pos.liquidation_price = fixedLiq;
        pos.mfe = 0;
        pos.mae = 0;
        const priceNow = priceTrustworthy ? num(pos.current_price) : num(pos.entry_price);
        pos.current_price = priceNow;
        pos.unrealized_pnl = unrealizedPnl(pos, priceNow);
        pos.unrealized_net_pnl = unrealizedNetPnl(pos, priceNow);
        pos.roe_pct = openMarginOf(pos) > 0 ? round(pos.unrealized_pnl / openMarginOf(pos) * 100, 6) : 0;
        pos.price_status = priceTrustworthy ? (pos.price_status || "OK") : "INVALID";
        pos.repair_reason = repairReason;
        repairs.push({ kind: "position_repaired", position_id: pos.position_id, symbol: pos.symbol, reason: repairReason, price_trusted: priceTrustworthy });
      } else {
        // 2) 结构不可修:按止损价立即平掉,避免继续污染账本
        const res = await closePosition(pos, {
          reference_price: statelessPriceOf(pos),
          exit_reason: stopCrossed ? "stop_loss" : "LIQUIDATION",
          now: now(),
          fraction: 1,
          integrity_forced: true,
          repair_reason: repairReason
        });
        repairs.push({ kind: "position_closed", position_id: pos.position_id, symbol: pos.symbol, reason: repairReason, ok: Boolean(res && res.ok) });
      }
    }

    // 成交:已实现盈亏超过"保证金 + 费用"或数量/价格非法 → 标记为无效样本来源
    const boundOfTrade = (t) => Math.abs(num(t.entry_price) * num(t.quantity)) / Math.max(num(t.leverage, 1), 1) + Math.abs(num(t.fees));
    for (const t of engine.trades) {
      const reasons = [];
      if (!Number.isFinite(Number(t.net_pnl))) reasons.push("pnl_not_finite");
      if (!(num(t.entry_price) > 0) || !(num(t.exit_price) > 0)) reasons.push("invalid_price");
      const b = boundOfTrade(t);
      if (b > 0 && num(t.net_pnl) < -(b + 1e-6)) reasons.push("loss_beyond_margin");
      if (num(t.quantity) <= 0) reasons.push("invalid_quantity");
      if (!reasons.length) continue;
      t.invalid_sample = true;
      t.repair_reason = reasons.join(",");
      // V15 P0 §16:历史异常数据只标记 invalid_for_learning,绝不改写历史金额
      t.invalid_for_learning = true;
      repairs.push({ kind: "trade_invalidated", trade_id: t.trade_id, symbol: t.symbol, reason: t.repair_reason });
    }

    // V15 P0 §15/§16:碎片事件与越界收益标记为"不可用于学习"(不改金额)
    for (const t of engine.trades) {
      if (t.invalid_for_learning) continue;
      const flags = [];
      const pct = numOrNull(t.return_pct);
      if (pct != null && !isValidReturnPct(pct, t.leverage)) flags.push("return_out_of_range");
      if (t.partial === true && num(t.notional_closed, 0) > 0 && num(t.notional_closed, 0) < POSITION_SAMPLE_MIN_NOTIONAL) flags.push("dust_event");
      if (t.partial === true && num(t.quantity, 0) > 0 && num(t.entry_price, 0) > 0) {
        // 碎片成交:关闭数量名义过小(修复前 66%→66%→66% 的产物)
        const sliceNotional = num(t.entry_price, 0) * num(t.quantity, 0);
        if (sliceNotional < POSITION_SAMPLE_MIN_NOTIONAL * 10) flags.push("tiny_slice");
      }
      if (num(t.quantity, 0) <= 0) flags.push("zero_quantity");
      if (!flags.length) continue;
      t.invalid_for_learning = true;
      t.repair_reason = (t.repair_reason ? t.repair_reason + "," : "") + flags.join(",");
      repairs.push({ kind: "trade_flagged_for_learning", trade_id: t.trade_id, symbol: t.symbol, reason: flags.join(",") });
    }

    // V15 P0 §15:同一仓位在短时间内被反复部分平仓(修复前的切碎簇)→ 整簇标记不可用于学习
    const byPosition = new Map();
    for (const t of engine.trades) {
      if (t.partial !== true) continue;
      const key = positionIdOf(t);
      if (!byPosition.has(key)) byPosition.set(key, []);
      byPosition.get(key).push(t);
    }
    for (const [positionId, events] of byPosition.entries()) {
      if (events.length < 3) continue;
      const times = events.map((t) => num(t.exit_time, 0)).sort((a, b) => a - b);
      const span = times[times.length - 1] - times[0];
      if (span > 10 * 60000) continue;   // 只在"十分钟内被切 ≥3 次"时判定为切碎簇
      for (const t of events) {
        if (t.invalid_for_learning) continue;
        t.invalid_for_learning = true;
        t.repair_reason = (t.repair_reason ? t.repair_reason + "," : "") + "shredded_cluster";
        repairs.push({ kind: "trade_flagged_for_learning", trade_id: t.trade_id, symbol: t.symbol, reason: "shredded_cluster", position_id: positionId });
      }
    }

    // 学习样本:与无效成交关联或自身数字不可能 → invalid_sample
    if (d.store && d.store.all) {
      const samples = await d.store.all("learning_samples");
      for (const s of samples || []) {
        const reasons = [];
        const linked = engine.trades.find((t) => t.trade_id === String(s.sample_id || "").replace(/^ls_/, ""));
        if (linked && linked.invalid_sample) reasons.push("linked_trade_invalid:" + (linked.repair_reason || ""));
        if (!Number.isFinite(Number(s.net_pnl))) reasons.push("pnl_not_finite");
        if (num(s.quantity) < 0) reasons.push("negative_quantity");
        if (!reasons.length) continue;
        await d.store.put("learning_samples", { ...s, invalid_sample: true, invalid_reason: reasons.join(","), repair_reason: "integrity_migration" });
        repairs.push({ kind: "sample_invalidated", sample_id: s.sample_id, reason: reasons.join(",") });
      }
    }

    engine.integrity.repairs = repairs;
    engine.integrity.last_repair_at = now();
    snapshot();   // 修复后先把账户口径同步到规范值,再做不变量判定
    if (repairs.length) {
      await persist({ state: true, position: engine.positions, account: true, wallet: true, trade: engine.trades.filter((t) => t.repair_reason) });
      notify("SYSTEM", "自检修复:发现并处置不可能数据", repairs.length + " 项 · " + repairs.slice(0, 3).map((r) => r.kind + "(" + String(r.reason).slice(0, 24) + ")").join(" / "), { key: "integrity|repair|" + dayKeyOf(now()), always: true, severity: "high" });
      log("integrity", "启动自检修复 " + repairs.length + " 项(OPEN 持仓 " + openBefore + " → " + engine.positions.filter((p) => p.status === "OPEN").length + ")");
    }
    const check = accountIntegrityCheck(engine.account, engine.wallets, engine.positions);
    if (!check.ok) raiseIntegrity("accounting_mismatch", { violations: check.violations });
    return { repairs, integrity: check };
  }

  // 迁移期用于取价的兜底:优先最新可信现价,其次开仓价(绝不返回 0)
  function statelessPriceOf(pos) {
    const cands = [pos.current_price, pos.entry_price, pos.liquidation_price];
    for (const c of cands) if (isSafeAmount(c)) return num(c);
    return num(pos.entry_price, 0);
  }

  // ---- 初始化 / 迁移(幂等) ----
  async function init() {
    const savedAccount = await d.store.get("paper_account", "paper-main");
    const savedWallets = await d.store.all("paper_wallets");
    const savedPositions = await d.store.all("paper_positions");
    const savedOrders = await d.store.all("paper_orders");
    const savedTrades = await d.store.all("paper_trades");
    const savedState = await d.store.get("paper_engine_state", "paper-engine");
    if (savedAccount) {
      engine.account = savedAccount;
      for (const w of savedWallets) engine.wallets[w.mode] = w;
      engine.positions = savedPositions;
      engine.orders = savedOrders;
      engine.trades = savedTrades;
      if (savedState) engine.state = { ...createEngineState(now()), ...savedState, state: "STOPPED" };
      // V16.1 §8/§9:利润保护池 + 高水位必须原样恢复(丢失 = 把已锁利润又当成可交易资金)
      restoreProfitPool(savedState && savedState.profit_pool);
      if (savedState && savedState.hwm) {
        engine.hwm = mergeHwm(engine.hwm, { equity: num(savedState.hwm.peak_equity, 0), peak_equity: num(savedState.hwm.peak_equity, 0), at: num(savedState.hwm.peak_at, now()) });
        engine.hwm = {
          ...engine.hwm,
          state: savedState.hwm.state === "HARD_STOP" ? "HARD_STOP" : engine.hwm.state,
          hard_stop_at: savedState.hwm.hard_stop_at == null ? null : num(savedState.hwm.hard_stop_at),
          hard_stop_equity: savedState.hwm.hard_stop_equity == null ? null : num(savedState.hwm.hard_stop_equity),
          breach_samples: Array.isArray(savedState.hwm.breach_samples) ? savedState.hwm.breach_samples : []
        };
        log("init", "高水位恢复:峰值 " + engine.hwm.peak_equity + " · 状态 " + engine.hwm.state);
      }
      if (engine.profitPool && num(engine.profitPool.protected_balance, 0) > 0) {
        log("init", "利润保护池恢复:已锁定 " + engine.profitPool.protected_balance + " USDT(不可用于新开仓)");
      }
      // V15.1 §19:已处理收盘K线按 symbol|mode|interval 持久化,重启后不会重复处理上一根
      const savedCandles = savedState && savedState.last_processed_candles ? savedState.last_processed_candles : {};
      engine.lastProcessedCandles = { ...savedCandles };
      // V15 P0 §18 / V15.1 §8/§9:AUTO leverage 每次刷新都从零开始 → 实测"永远回退 2x"。
      // 重建规则(重要):
      //   - **Position 级**:一个仓位只产生一条杠杆样本(部分平仓/Trailing/Profit Lock 都不额外计入)
      //   - Short / Long 分开(mode 用 LONG_TERM / SHORT_TERM,由 leverageManager 分池学习)
      //   - 只吃 CLEAN 事件(排除 invalid_for_learning / invalid_sample / 碎片 / 越界收益)
      engine.leverageRecords = summarizePositions(engine.trades, { clean: true }).rows
        .slice(-500)
        .map((r) => ({
          symbol: r.symbol,
          mode: r.mode === "long" ? "LONG_TERM" : "SHORT_TERM",
          market_regime: r.market_regime || null,
          leverage: num(r.leverage, 1),
          net_pnl: num(r.net_pnl, 0),
          mfe: 0,
          mae: 0,
          exit_reason: r.exit_reason || null,
          drawdown_pct: num(engine.account.max_drawdown_pct, 0),
          position_id: r.position_id,
          shadow: false
        }));
      log("init", "AUTO leverage 学习记录重建:" + engine.leverageRecords.length + " 条(Position 级 · CLEAN · Short/Long 分池)");
      const savedNotifications = await d.store.all("paper_notifications");
      if (savedNotifications && savedNotifications.length) {
        engine.notifications = savedNotifications
          .slice()
          .sort((a, b) => num(a.at, 0) - num(b.at, 0))
          .slice(-300)
          .map((n) => ({
            notification_id: n.notification_id || "ntf_" + num(n.at, 0) + "_r",
            key: n.key || n.notification_id || "restored",
            kind: n.kind || "SYSTEM",
            title: n.title || "",
            body: n.body || "",
            symbol: n.symbol || null,
            mode: n.mode || null,
            severity: n.severity || "info",
            at: num(n.at, 0),
            read: Boolean(n.read)
          }));
      }
      log("init", "已从本地库恢复账户与持仓(未重置为初始 10USDT)");
      // §18:恢复后必须做一次完整性迁移,历史脏数据不允许静默保留
      const repair = await integrityRepair();
      // V15 Crash Recovery:崩溃/被杀后先给出一致性自检计划(动作与迁移由同一套路径执行,避免两套写账本)
      const plan = recoveryPlan({
        account: engine.account,
        wallets: engine.wallets,
        positions: engine.positions,
        orders: engine.orders,
        trades: engine.trades,
        sync_queue: [],
        engine_state: engine.state,
        last_tick_at: engine.state.last_loop_at,
        now: now()
      });
      engine.recoveryReport = { ...plan, view: recoveryView(plan) };
      if (!plan.ok) {
        notify("SYSTEM", "启动自检 · 已恢复一致状态", plan.report_text, { key: "recovery|" + dayKeyOf(now()), always: true, severity: plan.allow_new_entry_after ? "normal" : "high" });
      }
      return { created: false, account: engine.account, integrity: repair.integrity, repairs: repair.repairs, recovery: engine.recoveryReport };
    }
    // 安全门:账户记录缺失,但库里还有持仓/成交 → 说明是"读不到"而不是"首次运行"。
    // 这种情况下绝不能建新账户(那等于把用户账本悄悄换成 100U 新账),必须显式报错。
    const orphanPositions = (await d.store.all("paper_positions")).length;
    const orphanTrades = (await d.store.all("paper_trades")).length;
    const degraded = Boolean(d.store.degraded);
    if ((orphanPositions > 0 || orphanTrades > 0 || degraded) && !d.allowFreshAccount) {
      engine.state = { ...engine.state, state: "ERROR", last_error: degraded ? "store_degraded:" + (d.store.degraded_reason || "unknown") : "account_missing_but_history_exists", last_error_at: now() };
      raiseIntegrity("store_unavailable", { degraded, positions_on_disk: orphanPositions, trades_on_disk: orphanTrades, reason: d.store.degraded_reason || "account_missing" });
      notify("SYSTEM", "本地账本读取失败,已阻止新建账户", degraded
        ? "浏览器本地数据库不可用(" + (d.store.degraded_reason || "unknown") + ")。请关闭其它标签页后重试;为避免覆盖真实记录,本次不会新建账户。"
        : "发现历史持仓/成交但账户记录缺失,已停止初始化以免覆盖数据。", { key: "store|blocked", always: true, severity: "high" });
      log("init", "账户缺失但存在历史数据 → 拒绝新建账户(positions=" + orphanPositions + " trades=" + orphanTrades + " degraded=" + degraded + ")");
      return { created: false, blocked: true, reason: engine.state.last_error, account: null, integrity: { ok: false, violations: ["store_unavailable"] } };
    }
    const created = createAccount({ config: cfg, now: now(), initial_balance: d.initialBalance });
    engine.account = created.account;
    engine.wallets = created.wallets;
    await d.store.put("paper_account", engine.account);
    for (const mode of Object.keys(engine.wallets)) await d.store.put("paper_wallets", engine.wallets[mode]);
    await d.store.put("paper_engine_state", engine.state);
    log("init", "首次创建模拟账户(初始 " + engine.account.initial_balance + " USDT)");
    return { created: true, account: engine.account };
  }

  async function persist(parts) {
    const p = parts || {};
    if (p.account) await d.store.put("paper_account", engine.account);
    if (p.wallet) for (const mode of Object.keys(engine.wallets)) await d.store.put("paper_wallets", engine.wallets[mode]);
    if (p.position) for (const pos of p.position) await d.store.put("paper_positions", pos);
    if (p.order) for (const ord of p.order) await d.store.put("paper_orders", ord);
    if (p.trade) for (const tr of p.trade) await d.store.put("paper_trades", tr);
    if (p.state) {
      // V16.1 §8:利润保护池与高水位必须随引擎状态一起持久化 ——
      // 否则 App 重启后"已经锁起来的利润"会被当成可交易资金(等于把保护池又花了一遍)
      engine.state.profit_pool = poolSnapshot();
      engine.state.hwm = { ...hwmRecord(engine.hwm), breach_samples: (engine.hwm && engine.hwm.breach_samples) || [] };
      await d.store.put("paper_engine_state", engine.state);
    }
    if (p.queue) for (const item of p.queue) await d.store.put("sync_queue", item);
  }

  // 保护池的持久化快照(只存必要字段:金额 + 已结算的母仓位 id + 最近流水)
  function poolSnapshot() {
    const p = engine.profitPool;
    if (!p) return null;
    return {
      protected_balance: num(p.protected_balance, 0),
      tradable_credit_total: num(p.tradable_credit_total, 0),
      protected_total: num(p.protected_total, 0),
      settled_ids: Object.keys(p.settled_positions || {}),
      records: (p.records || []).slice(-50)
    };
  }

  // 重启恢复:金额与已结算集合都要回来(已结算集合丢了会重复做 70/30)
  // 注意:必须**就地改写** engine.profitPool 指向的那个对象 ——
  // 引擎内部的访问器(poolLayers/protectedPool)闭包引用的是这个对象,
  // 换成新对象会让"恢复成功"变成假的(池子仍是 0)。
  function restoreProfitPool(snap) {
    if (!snap) return;
    const target = engine.profitPool || createProfitPool({ now: now() });
    const settled = {};
    for (const id of snap.settled_ids || []) {
      const rec = (snap.records || []).find((r) => r.position_id === id);
      settled[id] = rec || { position_id: id, applied: true, reason: "restored" };
    }
    target.protected_balance = num(snap.protected_balance, 0);
    target.tradable_credit_total = num(snap.tradable_credit_total, 0);
    target.protected_total = num(snap.protected_total, 0);
    target.records = Array.isArray(snap.records) ? snap.records : [];
    target.settled_positions = settled;
    if (!target.blocked_attempts) target.blocked_attempts = [];
    engine.profitPool = target;
  }

  function syncItem(entity, entityId, payload) {
    return {
      item_id: entity + ":" + entityId,
      entity,
      entity_id: String(entityId),
      payload: JSON.stringify(payload || {}),
      sync_status: "PENDING",
      attempts: 0,
      last_error: null,
      revision: 1,
      device_id: d.deviceId || "local-device",
      created_at: now(),
      updated_at: now()
    };
  }

  // ---- 状态机 ----
  async function start() {
    if (engine.state.state === "RUNNING" || engine.state.state === "STARTING" || engine.state.state === "RECOVERING") {
      log("start", "已在运行,忽略重复启动(不创建第二个 Loop)");
      return { ok: false, reason: "already_running", state: engine.state.state };
    }
    engine.state.state = "STARTING";
    engine.state.started_at = now();
    await persist({ state: true });
    engine.state.state = "RECOVERING";
    const recovery = await recover();
    engine.state.state = "RUNNING";
    await persist({ state: true });
    log("start", "引擎启动完成");
    notify("SYSTEM", "Paper 引擎已启动", "100 USDT 模拟账户 · 短线 " + num(engine.wallets.short.allocated_balance, 0) + " / 长线 " + num(engine.wallets.long.allocated_balance, 0), { key: "engine_start|" + num(engine.state.started_at, 0), severity: "info" });
    return { ok: true, state: engine.state.state, recovery };
  }

  async function pause(reason) {
    if (engine.state.state !== "RUNNING") return { ok: false, state: engine.state.state };
    engine.state.state = "PAUSED";
    engine.state.paused_at = now();
    engine.state.note = reason || "";
    await persist({ state: true });
    log("pause", reason || "手动暂停");
    notify("SYSTEM", "Paper 引擎已暂停", reason || "手动暂停", { key: "engine_pause|" + num(engine.state.paused_at, 0), severity: "info" });
    return { ok: true, state: engine.state.state };
  }

  async function resume() {
    if (engine.state.state !== "PAUSED") return { ok: false, state: engine.state.state };
    engine.state.state = "RECOVERING";
    const recovery = await recover();
    engine.state.state = "RUNNING";
    await persist({ state: true });
    return { ok: true, state: engine.state.state, recovery };
  }

  // ---- 崩溃 / 离线恢复 ----
  async function recover() {
    const result = { positions_checked: 0, exits_filled: 0, missing_candles: 0, recovered_after_offline: false };
    const open = engine.positions.filter((p) => p.status === "OPEN" || p.status === "CLOSING");
    result.positions_checked = open.length;
    if (d.fetchKlines && engine.state.last_candle_time && open.length) {
      // 补齐断网期间缺失的K线,并检查期间是否触发退出
      for (const pos of open) {
        const modeCfg = MODE_CONFIG[pos.mode] || MODE_CONFIG.short;
        let rows = [];
        try {
          rows = await d.fetchKlines(pos.symbol, modeCfg.interval, 200, engine.state.last_candle_time);
        } catch (error) {
          log("recover", "补齐K线失败:" + (error && error.message));
          continue;
        }
        const gap = (rows || []).filter((r) => num(r.closeTime) > num(engine.state.last_candle_time));
        if (!gap.length) continue;
        result.missing_candles += gap.length;
        for (const candle of gap) {
          const pathPos = updatePositionPath(pos, num(candle.close), num(candle.high, candle.close), num(candle.low, candle.close));
          const reason = evaluateExit(pathPos, {
            now: num(candle.closeTime),
            price: num(candle.close),
            staleQuote: false,
            structureInvalidated: false,
            signalReversed: false,
            riskExit: false
          });
          if (reason) {
            await closePosition(pathPos, { reference_price: num(candle.close), now: num(candle.closeTime), exit_reason: reason, recovered_after_offline: true });
            result.exits_filled += 1;
            result.recovered_after_offline = true;
            break;
          }
          Object.assign(pos, pathPos);
        }
      }
      if (result.missing_candles > 0) {
        engine.state.note = "断网恢复:补齐 " + result.missing_candles + " 根K线,期间补记 " + result.exits_filled + " 笔退出";
        log("recover", engine.state.note);
      }
    }
    if (result.exits_filled > 0) await persist({ position: engine.positions, account: true, wallet: true, trade: engine.trades, state: true });
    engine.state.errors = engine.state.errors || 0;
    return result;
  }

  // ---- 开仓 ----
  async function openPosition(input) {
    return mutex(async () => {
      const mode = input.mode === "long" ? "long" : "short";
      const key = idempotencyKey(mode, input.symbol, input.signal_timestamp, input.direction);
      // V16.2u §3:全链路可追溯 ID(确定性派生,绝不随机,缺省即补全):
      //   Market Event(收盘K线) → Signal(signal_id) → Strategy Intent(strategy_intent_id,含策略模式)
      //   → Decision(decision_id) → Order(idempotency_key/order_id) → Position(position_id)
      // 同一收盘K线+同向+同一策略模式 → 恒为同一 signal_id(幂等键同源);不同模式=不同 Intent(可解释)。
      const sigId = String(input.signal_id
        || ("sig_" + input.symbol + "_" + (MODE_CONFIG[mode] || MODE_CONFIG.short).interval + "_" + num(input.signal_timestamp, 0)
          + "_" + ((input.direction === "Bullish" || input.direction === "Strong Bullish") ? "L" : "S")));
      const strategyIntentId = String(input.strategy_intent_id || ("intent_" + mode + "_" + sigId));
      const decisionId = String(input.decision_id || ("dec_" + strategyIntentId));
      input.signal_id = sigId;
      input.strategy_intent_id = strategyIntentId;
      input.decision_id = decisionId;
      const existed = engine.orders.find((o) => o.idempotency_key === key);
      if (existed) {
        log("order", "幂等命中,拒绝重复下单:" + key);
        return { ok: false, reason: "duplicate_idempotency_key", order: existed };
      }
      // V15.1 §19:同一 symbol|mode|interval 的已处理收盘K线不得重复处理(重启后尤其重要)
      const candleKey = [input.symbol, mode, (MODE_CONFIG[mode] || MODE_CONFIG.short).interval].join("|");
      const lastCandle = numOrNull(engine.lastProcessedCandles && engine.lastProcessedCandles[candleKey]);
      const candleNow = numOrNull(input.signal_timestamp);
      if (lastCandle != null && candleNow != null && candleNow <= lastCandle) {
        log("order", "收盘K线已处理过,跳过:" + candleKey + " @" + candleNow);
        return { ok: false, reason: "closed_candle_already_processed", detail: { key: candleKey, last: lastCandle, now: candleNow } };
      }
      const quote = input.quote || {};
      const price = num(quote.price, 0);
      if (!isSafeAmount(price)) return { ok: false, reason: "invalid_price" };
      // 陈旧行情禁止开仓
      if (quote.received_at && now() - num(quote.received_at) > STALE_QUOTE_MS) {
        return { ok: false, reason: "stale_quote" };
      }
      const riskVeto = (d.riskCheck && d.riskCheck({ mode, symbol: input.symbol, account: engine.account, positions: engine.positions, quote, analysis: input.analysis, trades: engine.trades, wallets: engine.wallets })) || { veto: false };
      // V14.4:外部情报只能"收紧"(抬高风险分),永不放行 —— gate.can_grant_open 恒为 false
      const extGate = currentExternalGate({ symbol: input.symbol, mode });
      if (extGate && extGate.risk_score_delta > 0) {
        riskVeto.risk_score = Math.max(0, Math.min(100, num(riskVeto.risk_score, 30) + num(extGate.risk_score_delta, 0)));
        riskVeto.risk_flags = (riskVeto.risk_flags || []).concat("external_context");
        riskVeto.reasons = (riskVeto.reasons || []).concat(extGate.reasons || []);
        riskVeto.risk_level = riskVeto.risk_score < 30 ? "Low" : riskVeto.risk_score < 55 ? "Medium" : riskVeto.risk_score < 75 ? "High" : "Extreme";
      }
      if (riskVeto.veto) {
        log("risk", "风控否决:" + (riskVeto.reasons || []).join(","));
        const rejected = {
          order_id: "ord_rej_" + mode + "_" + input.symbol + "_" + num(input.signal_timestamp),
          account_id: engine.account.account_id, mode, symbol: input.symbol, side: input.direction === "Bullish" || input.direction === "Strong Bullish" ? "BUY" : "SELL",
          status: "REJECTED", quantity: 0, reference_price: price, fill_price: null, slippage_pct: 0, fee: 0, notional: 0,
          created_at: now(), filled_at: null, reason: input.reason || "signal", signal_id: input.signal_id || null, decision_id: input.decision_id || null,
          engine_version: input.engine_version || null, model_version: input.model_version || null, idempotency_key: key,
          reject_reason: (riskVeto.reasons || []).join(",")
        };
        engine.orders.push(rejected);
        await persist({ order: [rejected], queue: [syncItem("paper_order", rejected.order_id, rejected)] });
        return { ok: false, reason: "risk_veto", veto: riskVeto, order: rejected };
      }
      const wallet = engine.wallets[mode];
      const size = positionSize({ wallet, poolEquity: num(wallet.allocated_balance), config: cfg, riskPct: input.riskPct });
      if (!isSafeAmount(size.notional) || num(size.notional) < 0.5) return { ok: false, reason: "size_too_small", size, min_notional: 0.5 };
      const side = input.direction === "Bullish" || input.direction === "Strong Bullish" ? "BUY" : "SELL";
      const direction = side === "BUY" ? "LONG" : "SHORT";
      const estFill = fillPrice(price, side, cfg);
      // ---- AUTO LEVERAGE:requested → Risk approved ----
      const atr = num(input.analysis && input.analysis.volatility && input.analysis.volatility.atrPct, 0) / 100 * price;
      const leverageRequest = input.leverage != null
        ? { requested_leverage: clampLeverage(input.leverage), reason: "手动指定", scope: "manual" }
        : requestLeverage({
          records: input.leverageRecords || engine.leverageRecords || [],
          balance: num(engine.account.cash_balance) + num(engine.account.reserved_balance),
          champion_leverage: engine.leverageChampion[mode] || 2,
          symbol: input.symbol,
          mode: mode === "long" ? "LONG_TERM" : "SHORT_TERM",
          regime: input.analysis && input.analysis.market_regime ? input.analysis.market_regime.label : null,
          hard_cap: input.leverage_cap || LEVERAGE_POLICY.max_leverage_hard_cap
        });
      const margin = round(size.notional, 8);
      const provisionalLiq = liquidationPriceOf({ side: direction, entryPrice: estFill, leverage: leverageRequest.requested_leverage, margin });
      // §8 方向不变量:多头强平价必须在开仓价下方、空头在上方。不满足 → 拒绝创建(LIQUIDATION_CALC_ERROR)
      const liqInvariant = liquidationInvariant({ side: direction, entryPrice: estFill, liquidationPrice: provisionalLiq });
      if (!liqInvariant.ok) {
        raiseIntegrity("LIQUIDATION_CALC_ERROR", { symbol: input.symbol, side: direction, entry: estFill, leverage: leverageRequest.requested_leverage, liq: provisionalLiq, detail: liqInvariant.detail });
        return { ok: false, reason: "LIQUIDATION_CALC_ERROR", detail: liqInvariant };
      }
      const liquidationDistance = provisionalLiq ? Math.abs(estFill - provisionalLiq) / estFill * 100 : null;
      const approval = approveLeverage({
        requested_leverage: leverageRequest.requested_leverage,
        risk_score: riskVeto.risk_score,
        veto: Boolean(riskVeto.veto),
        liquidation_distance_pct: liquidationDistance
      });
      if (!approval.trade_allowed) {
        return { ok: false, reason: "leverage_rejected", approval, leverage_request: leverageRequest };
      }
      const leverage = approval.approved_leverage;
      const notional = round(margin * leverage, 8);
      const quantity = round(notional / estFill, 10);
      const fee = feeOf(notional, cfg);
      const afford = canAfford(wallet, margin, fee);
      if (!afford.ok) {
        log("order", "资金不足,拒绝开仓:" + JSON.stringify(afford));
        return { ok: false, reason: afford.reason, detail: afford };
      }

      // ---- V16 §8:账户级最高保护(HARD STOP)期间禁止一切新开仓 ----
      const hwmGate = hardStopGate(engine.hwm);
      if (hwmGate.block_new_entry) {
        log("risk", "账户最高保护生效中,拒绝开仓:" + input.symbol);
        journalBlocked({ symbol: input.symbol, mode, analysis: input.analysis, direction: input.direction }, "账户级 20% 回撤保护(HARD STOP)");
        return { ok: false, reason: "hwm_hard_stop", hwm: engine.hwm };
      }

      // ---- V16 §4:利润保护池隔离(保护池的钱永远不能用于开新仓 / 加仓 / 杠杆) ----
      const protectedLock = protectedBalance(profitPool);
      const availableForEntry = Math.max(0, num(wallet.available_balance) - protectedLock);
      if (availableForEntry + 1e-9 < margin + fee) {
        const iso = protectedIsolationCheck(profitPool, { purpose: "new_entry", amount: margin + fee, available_tradable: availableForEntry, now: now() });
        log("risk", "利润保护池隔离,拒绝开仓:" + input.symbol + " " + iso.reason_zh);
        return { ok: false, reason: "protected_profit_locked", detail: iso, protected: protectedLock };
      }

      // ---- V16 §1:Entry Quality Gate(费用前置净边际 + 概率优势 + 不确定性)----
      const equityNow = Math.max(0, num(engine.account.cash_balance) + num(engine.account.reserved_balance) + num(engine.account.unrealized_pnl));
      const dqState = (dataQualitySentinel && dataQualitySentinel.state) ? dataQualitySentinel.state() : { ok: true };
      // V16.2u §6/§62:组合暴露预检真的接线 —— 旧实现把 exposure_allow 写死 true,
      // "同向阵营 / 组合保证金"余量归零时组合守卫实际只在缩仓阶段兜底。
      // 现在:余量归零 → Entry Gate 直接 NO_TRADE(EXPOSURE_CAP,正式决策+影子),不允许 40%×N 绕过。
      const preExpo = effectiveExposure(engine.positions, {});
      const preClusterKey = clusterOfSymbol(input.symbol) + "|" + direction;
      const clusterNowMargin = num(preExpo.by_cluster[preClusterKey], 0);
      const clusterCapMargin = equityNow * CAPITAL_LIMITS.cluster_same_direction_pct / 100;
      const portfolioRoomMargin = equityNow * CAPITAL_LIMITS.max_portfolio_margin_pct / 100 - num(preExpo.adjusted_exposure, 0);
      const minAllocMargin = equityNow * CAPITAL_LIMITS.min_alloc_pct / 100;
      const exposureAllow = clusterNowMargin < clusterCapMargin - 1e-9 && portfolioRoomMargin > minAllocMargin - 1e-9;
      const regimeLabel = input.analysis && input.analysis.market_regime ? input.analysis.market_regime.label : null;
      const quality = entryQuality({
        rule: { score: (direction === "LONG" ? 1 : -1) * num(input.analysis && input.analysis.confidence, 50) },
        ml: input.ml || (input.analysis && input.analysis.ml) || null,
        predictor: input.prediction || null,
        data_quality: { ok: Boolean(dqState.ok) },
        atr_pct: num(input.analysis && input.analysis.volatility && input.analysis.volatility.atrPct, 0),
        notional: notional,
        config: cfg,
        funding: input.funding || null,
        hold_hours: num(MODE_CONFIG[mode] && MODE_CONFIG[mode].maxHoldMs, 0) / 3600000,
        regime: regimeLabel,
        risk_allow: !riskVeto.veto,
        exposure_allow: exposureAllow,
        sample_count: input.sample_count == null ? null : num(input.sample_count),
        now: now()
      });
      engine.lastQuality = quality;
      // V16.1 §16:过度交易期间自动提高开仓门槛(发现了就真的收紧,而不是照开)
      const tightenDelta = num(engine.entryTightening && engine.entryTightening.threshold_delta, 0);
      if (quality.allow_entry && tightenDelta > 0 && num(quality.entry_score, 0) < num(ENTRY_QUALITY_RULES.min_entry_score, 55) + tightenDelta) {
        journalBlocked({ symbol: input.symbol, mode, analysis: input.analysis, direction: input.direction }, "过度交易收紧中:质量分需 ≥ " + (num(ENTRY_QUALITY_RULES.min_entry_score, 55) + tightenDelta));
        log("quality", input.symbol + " 因过度交易收紧被拒(质量分 " + quality.entry_score + " < " + (num(ENTRY_QUALITY_RULES.min_entry_score, 55) + tightenDelta) + ")");
        return { ok: false, reason: "overtrading_tightened", quality, tightening: { ...engine.entryTightening } };
      }
      engine.entryQualityLog = (engine.entryQualityLog || []).concat([{
        symbol: input.symbol, mode, at: now(), decision: quality.decision, entry_score: quality.entry_score,
        net_expected_edge_pct: quality.net_expected_edge_pct, cost_pct: quality.estimated_cost.cost_pct,
        uncertainty: quality.uncertainty, blockers: quality.blockers, allow_entry: quality.allow_entry
      }]).slice(-500);
      // NO_TRADE / DATA_UNRELIABLE / MODEL_CONFLICT 都是【正式决策】:留影子结果,便于日后验证"没做这一单"对不对
      if (!quality.allow_entry) {
        engine.qualitySkips = num(engine.qualitySkips, 0) + 1;
        const skipShadow = skipShadowRecord(quality, { symbol: input.symbol, mode, at: now(), entry_price: price, candle_time: candleNow });
        engine.state.skipped_shadows = (engine.state.skipped_shadows || []).concat([skipShadow]).slice(-200);
        journalBlocked({ symbol: input.symbol, mode, analysis: input.analysis, direction: input.direction }, "开仓质量闸门:" + (quality.block_reasons_zh || []).join("、"));
        log("quality", input.symbol + " 不交易(" + quality.decision_zh + "):" + (quality.block_reasons_zh || []).join("、"));
        return { ok: false, reason: "entry_quality_" + (quality.blockers[0] || "skip"), quality, skip_shadow: skipShadow };
      }

      // ---- V16 §3:组合资金分配(Risk 只能向下削减,永远不能突破 40%)----
      const atrPctNow = num(input.analysis && input.analysis.volatility && input.analysis.volatility.atrPct, 0);
      const alloc = capitalAllocation({
        equity: equityNow > 0 ? equityNow : num(engine.account.initial_balance, 100),
        requested_pct: equityNow > 0 ? margin / equityNow * 100 : 100,
        quality_score: quality.entry_score,
        positions: engine.positions,
        // 可用现金由 canAfford 负责;这里显式传一个大数,避免"静默缩仓"掩盖资金不足
        available_cash: 1e12,
        drawdown_scale: scaleForDrawdown(num(engine.hwm && engine.hwm.drawdown_pct, 0)),
        volatility_scale: atrPctNow > 2.5 ? 0.6 : (atrPctNow > 1.8 ? 0.85 : 1),
        leverage,
        symbol: input.symbol,
        direction
      });
      if (!alloc.allowed) {
        engine.state.skipped_shadows = (engine.state.skipped_shadows || []).concat([{
          kind: "SKIP_SHADOW", symbol: input.symbol, mode, at: now(), would_be_direction: direction,
          entry_price: price, blockers: [alloc.code], resolved: false, outcome: null
        }]).slice(-200);
        journalBlocked({ symbol: input.symbol, mode, analysis: input.analysis, direction: input.direction }, "资金分配拒绝:" + alloc.reason);
        log("alloc", input.symbol + " 分配拒绝:" + alloc.reason);
        return { ok: false, reason: "capital_alloc_" + alloc.code, alloc };
      }
      let finalMargin = margin;
      if (num(alloc.approved_usdt, margin) + 1e-9 < margin) finalMargin = round(num(alloc.approved_usdt), 8);
      const finalNotional = round(finalMargin * leverage, 8);
      const finalQuantity = round(finalNotional / estFill, 10);
      const finalFee = feeOf(finalNotional, cfg);

      // ---- V16 §2:最小有意义仓位(拒绝 0.x U 蚂蚁仓)----
      const meaningful = minimumMeaningfulPosition({
        equity: equityNow,
        net_expected_edge_pct: quality.net_expected_edge_pct,
        cost_pct: quality.estimated_cost.cost_pct,
        requested_notional: finalNotional
      });
      if (!meaningful.feasible) {
        journalBlocked({ symbol: input.symbol, mode, analysis: input.analysis, direction: input.direction }, "仓位无意义:" + meaningful.reason);
        log("quality", input.symbol + " 仓位无意义(" + meaningful.reason + ") 名义=" + finalNotional);
        return { ok: false, reason: "below_min_meaningful", meaningful, alloc };
      }
      if (!isSafeAmount(finalNotional) || finalNotional < 0.5) return { ok: false, reason: "size_too_small", detail: { notional: finalNotional } };

      // ---- V16 §3:原子预占资金(同一分钱不允许被两笔仓位同时使用)----
      reserveBook.available = Math.max(0, availableForEntry - reservedTotal(reserveBook));
      const intentId = "oi_" + key;
      const rsv = reserveCapital(reserveBook, {
        intent_id: intentId, symbol: input.symbol, mode, direction,
        amount: round(finalMargin + finalFee, 8), now: now()
      });
      if (!rsv.ok) {
        log("alloc", "资金预占失败:" + rsv.reason);
        return { ok: false, reason: "capital_reserve_failed", detail: rsv, alloc };
      }
      const modeCfg = MODE_CONFIG[mode];
      const long = side === "BUY";
      const tpPlan = buildTakeProfitPlan({
        entry_price: estFill, direction, atr: atr > 0 ? atr : estFill * num(modeCfg.tpAtrMult) / 100,
        confidence: num(input.analysis && input.analysis.confidence, 50),
        trend_strong: Boolean(input.analysis && input.analysis.market_regime && /Uptrend|Downtrend/.test(input.analysis.market_regime.label)),
        resistance: input.analysis && input.analysis.resistance_zones && input.analysis.resistance_zones[0] ? num(input.analysis.resistance_zones[0].lo) : 0,
        support: input.analysis && input.analysis.support_zones && input.analysis.support_zones[0] ? num(input.analysis.support_zones[0].hi) : 0
      });
      const applied = applyOpen({ account: engine.account, wallets: engine.wallets, config: cfg }, {
        account_id: engine.account.account_id,
        mode, symbol: input.symbol, side, quantity: finalQuantity,
        margin: finalMargin,
        fee_base: finalNotional,
        reference_price: price,
        stop_price: atr > 0 ? (long ? price - atr * modeCfg.stopAtrMult : price + atr * modeCfg.stopAtrMult) : null,
        // take_profit_price = 【最终目标】(TP3 结构目标),而不是 TP1。
        // 若指向 TP1,evaluateExit 会在第一档止盈价就把剩余仓位全部平掉 ——
        // 那样就没有"部分锁定后让剩余仓位继续跟趋势"(§44)的可能。TP1/TP2 由 tp_levels 分档执行。
        take_profit_price: tpPlan.levels.length ? tpPlan.levels[tpPlan.levels.length - 1].price : null,
        max_hold_ms: modeCfg.maxHoldMs,
        invalidation: input.analysis ? { last_swing_low: input.analysis.structure && input.analysis.structure.last_swing_low, last_swing_high: input.analysis.structure && input.analysis.structure.last_swing_high } : null,
        now: now(),
        reason: input.reason || "signal",
        signal_id: input.signal_id || null,
        decision_id: input.decision_id || null,
        engine_version: input.engine_version || null,
        model_version: input.model_version || null,
        idempotency_key: key
      });
      if (!applied.ok) {
        releaseReserve(reserveBook, intentId, "apply_open_failed", now());
        return applied;
      }
      // 成交价形成后再校验一次强平价方向(applied 是纯函数结果,尚未写入引擎状态,拒绝即等于回滚)
      const finalLiq = liquidationPriceOf({ side: direction, entryPrice: applied.position.entry_price, leverage, margin: finalMargin });
      const finalInvariant = liquidationInvariant({ side: direction, entryPrice: applied.position.entry_price, liquidationPrice: finalLiq });
      if (!finalInvariant.ok) {
        releaseReserve(reserveBook, intentId, "liquidation_invariant_failed", now());
        raiseIntegrity("LIQUIDATION_CALC_ERROR", { symbol: input.symbol, side: direction, entry: applied.position.entry_price, leverage, liq: finalLiq, detail: finalInvariant.detail });
        return { ok: false, reason: "LIQUIDATION_CALC_ERROR", detail: finalInvariant };
      }
      engine.account = applied.state.account;
      engine.wallets = applied.state.wallets;
      applied.order.idempotency_key = key;
      Object.assign(applied.position, {
        strategy_mode: mode === "long" ? "LONG_TERM" : "SHORT_TERM",
        // V16.2u §3:溯源链(来源可解释:这一单是哪个信号/哪个策略意图/哪次决策/谁批准的资金)
        signal_id: sigId,
        strategy_intent_id: strategyIntentId,
        decision_id: decisionId,
        action_source: input.action_source || "AUTO",
        alloc_caps: (alloc && alloc.caps_applied) ? alloc.caps_applied.slice() : [],
        direction,
        initial_quantity: applied.position.quantity,
        remaining_quantity: applied.position.quantity,
        leverage,
        requested_leverage: leverageRequest.requested_leverage,
        approved_leverage: leverage,
        actual_leverage: leverage,
        notional: finalNotional,
        initial_margin: finalMargin,
        remaining_margin: finalMargin,
        maintenance_margin: round(finalNotional * 0.005, 8),
        liquidation_price: finalLiq,
        margin_ratio: round(finalMargin / Math.max(finalNotional, 1e-9) * 100, 4),
        leverage_policy_version: LEVERAGE_POLICY.version,
        // V15 P0 §17/§18:记录杠杆来源,便于 CSV 审计与"是否永远回退 2x"的诊断
        leverage_source: leverageRequest.scope === "manual"
          ? "MANUAL"
          : (leverageRequest.sample_protected ? "AUTO:fallback_sample_short" : "AUTO:" + (leverageRequest.scope || "global")),
        leverage_reason: leverageRequest.reason || null,
        tp_levels: tpPlan.levels,
        tp_hit_count: 0,
        stop_state: applied.position.stop_price == null ? null : { type: "fixed", price: applied.position.stop_price },
        // V14.4:冻结初始风险(R 的锚点)。止损上移后 R 不变,保证 Profit Lock 阶段判定不会被压缩失真
        initial_risk: applied.position.stop_price == null ? null : round(Math.abs(applied.position.entry_price - num(applied.position.stop_price)), 8),
        initial_stop_price: applied.position.stop_price == null ? null : round(num(applied.position.stop_price), 8),
        trailing_state: null,
        funding_simulated: 0,
        funding_status: "unavailable",
        funding_source: null,
        funding_rate: null,
        funding_rate_pct: null,
        funding_intervals: 0,
        funding_missed_intervals: 0,
        last_funding_time: now(),
        // V14.5 §8/§29:闭仓K线时间(审计用)+ Entry 时刻的预测快照(学习/校准用)
        closed_candle_time: input.closed_candle_time == null ? null : num(input.closed_candle_time),
        future_prediction_at_entry: input.prediction ? predictionSnapshot(input.prediction, { now: now(), horizon: (MODE_CONFIG[mode] || MODE_CONFIG.short).interval, reason: "entry" }) : null,
        partial_close_count: 0,
        // V16 §6/§10:建仓时冻结论点(以后禁止用未来信息重算 Entry 状态)
        entry_thesis: buildEntryThesis({
          direction,
          reasons: [],
          reason_zh: "开仓质量分 " + quality.entry_score + " · 扣费净边际 " + (quality.net_expected_edge_pct == null ? "--" : round(quality.net_expected_edge_pct, 3) + "%"),
          entry_price: applied.position.entry_price,
          regime: regimeLabel,
          confidence: num(quality.direction_probability, 0.5),
          stop_price: applied.position.stop_price,
          risk_unit: applied.position.stop_price == null ? null : round(Math.abs(applied.position.entry_price - num(applied.position.stop_price)), 8),
          max_volatility_pct: round(num(input.analysis && input.analysis.volatility && input.analysis.volatility.atrPct, 0) * 2.5, 6),
          funding_rate: input.funding && input.funding.available !== false && input.funding.rate != null ? num(input.funding.rate, 0) : null,
          at: now(),
          expires_at: now() + num(modeCfg.maxHoldMs, 0)
        }),
        thesis_state: "VALID",
        entry_quality_score: quality.entry_score,
        entry_decision: quality.decision,
        entry_net_edge_pct: quality.net_expected_edge_pct,
        allocated_pct_of_equity: equityNow > 0 ? round(finalMargin / equityNow * 100, 4) : null,
        // V16.1 §6/§7:保证金口径与名义口径分开记录,禁止用一个数字混淆
        entry_basis: "margin",
        tradable_capital_before: round(Math.max(0, availableForEntry), 8),
        requested_allocation_pct: round(alloc.detail && alloc.detail.quality_pct ? alloc.detail.quality_pct : margin / Math.max(equityNow, 1e-9) * 100, 4),
        approved_allocation_pct: round(alloc.approved_pct, 4),
        approved_margin: finalMargin,
        approved_notional: finalNotional,
        margin_exposure_pct: round(finalMargin / Math.max(equityNow, 1e-9) * 100, 4),
        notional_exposure_pct: round(finalNotional / Math.max(equityNow, 1e-9) * 100, 4),
        estimated_round_trip_cost: round(num(quality.estimated_cost && quality.estimated_cost.total_cost, 0), 8),
        expected_net_edge_pct: quality.net_expected_edge_pct,
        risk_reduction_reason: alloc.caps_applied.filter((c) => c !== "QUALITY_LADDER").join(",") || null,
        allocation_caps: alloc.caps_applied.slice()
      });
      engine.orders.push(applied.order);
      engine.positions.push(applied.position);
      // V15.1 §19:记录已处理收盘K线(symbol|mode|interval),随引擎状态一起落库
      if (candleNow != null) {
        engine.lastProcessedCandles = { ...(engine.lastProcessedCandles || {}), [candleKey]: candleNow };
        engine.state.last_processed_candles = engine.lastProcessedCandles;
      }
      snapshot();   // §15:先同步账户口径(reserved/equity),再落库 —— 否则库里留的是旧值
      commitReserve(reserveBook, intentId, { now: now(), actual_amount: round(finalMargin + finalFee, 8) });
      await persist({ account: true, wallet: true, position: [applied.position], order: [applied.order], state: true, queue: [syncItem("paper_order", applied.order.order_id, applied.order), syncItem("paper_position", applied.position.position_id, applied.position)] });
      log("order", "开仓 " + mode + " " + input.symbol + " " + direction + " " + leverage + "x margin=" + finalMargin + " notional=" + finalNotional + " liq=" + applied.position.liquidation_price + " 质量分=" + quality.entry_score + " 分配=" + round(alloc.approved_pct, 2) + "%" + (alloc.caps_applied.length > 1 ? "[" + alloc.caps_applied.join(",") + "]" : ""));
      notify("TRADE", "新模拟开仓 " + input.symbol.replace("USDT", "/USDT"),
        (mode === "long" ? "长线" : "短线") + " · " + (direction === "LONG" ? "做多" : "做空") + " · AUTO " + leverage + "x · 保证金 " + finalMargin.toFixed(2) + "U",
        { key: "open|" + applied.position.position_id, always: true, symbol: input.symbol, mode });
      // Shadow:同一信号在所有杠杆下的假想结果(只用于学习,不入账)
      const shadow = shadowEvaluation({ entry_price: applied.position.entry_price, exit_price: applied.position.entry_price, margin: finalMargin, direction, fee_bps: num(cfg.fee_bps, 4) });
      journalEntry(applied.position, input);   // 决策日志 + 持仓审计(为什么开 / 为什么这个杠杆)
      return { ok: true, order: applied.order, position: applied.position, leverage_request: leverageRequest, approval, shadow, quality, alloc, meaningful };
    });
  }

  // ---- 平仓(支持部分平仓:input.fraction) ----
  async function closePosition(position, input) {
    return mutex(async () => {
      const live = engine.positions.find((p) => p.position_id === position.position_id) || position;
      if (live.status !== "OPEN" && live.status !== "CLOSING") return { ok: false, reason: "not_open" };
      // 平仓前先结清已跨过的资金费时间点(不可用则只标记,不动金额)
      await settleFunding(live);
      const fraction = input.fraction == null ? 1 : Math.max(0.0001, Math.min(1, num(input.fraction)));
      const isPartial = fraction < 0.999999;
      // 成交口径统一走 Execution Simulator:做有效性校验、强平钳制与 reduce-only 语义;
      // 其 fill_price 与旧路径同源(同一 fillPrice 公式),因此历史数值不变。
      const fillPlan = closeOrder(live, {
        fraction,
        reference_price: input.reference_price,
        exit_reason: input.exit_reason,
        manual: Boolean(input.manual),
        config: cfg
      });
      if (!fillPlan.ok) return { ok: false, reason: "execution_rejected:" + fillPlan.reason };
      // 注意:accounting/futures 内部会再套一次 fillPrice(唯一一次滑点),
      // 所以这里传"校验并钳制后的参考价",而不是已经算好的成交价(否则滑点会被计两次)。
      const referencePrice = fillPlan.reference_price;
      const executionReport = fillReport(fillPlan, { exit_reason: input.exit_reason || null, manual: Boolean(input.manual) });
      const nowMs = num(input.now, now());
      let applied;
      if (isPartial) {
        // 部分平仓:只结算被关闭部分(用 futures 数学,避免重复计 PnL)
        const part = closeFuturesPosition({ ...live, config: cfg }, { fraction, reference_price: referencePrice, config: cfg });
        if (!part.ok) return part;
        applied = { ok: true, position: part.position_after, partial: part, trade: null };
        const marginReleased = part.margin_released;                 // 真实回收现金(= 释放保证金 + 净盈亏)
        const marginPortion = round(marginReleased - num(part.net_pnl, 0), 8);   // 释放的保证金部分
        // §64/会计真实性:部分平仓也要承担它那一份入场手续费 ——
        // 否则 realized_pnl 会系统性高估(30 天级回放会累积成可见偏差),而现金其实早已扣过这笔费用。
        const entryFeeAllocated = num(part.entry_fee_allocated, 0);
        const netWithEntryFee = round(num(part.net_pnl, 0) - entryFeeAllocated, 8);
        // 已分摊掉的那部分入场费要从"剩余待摊费用"里扣掉,否则最终全平会按原始 fees 再收一次(重复计费)
        part.position_after = { ...part.position_after, fees: round(Math.max(0, num(live.fees, 0) - entryFeeAllocated), 8) };
        engine.account = {
          ...engine.account,
          cash_balance: round(num(engine.account.cash_balance) + marginReleased, 8),
          realized_pnl: round(num(engine.account.realized_pnl) + netWithEntryFee, 8),
          fees_paid: round(num(engine.account.fees_paid) + num(part.fees, 0) + entryFeeAllocated, 8),
          updated_at: nowMs
        };
        const wallet = engine.wallets[live.mode];
        engine.wallets = {
          ...engine.wallets,
          [live.mode]: {
            ...wallet,
        available_balance: round(num(wallet.available_balance) + marginReleased, 8),
        // 释放的保证金用 marginPortion(不用 net):写反会让 reserved 单边膨胀,虚增池子规模与后续仓位
        reserved_balance: round(Math.max(0, num(wallet.reserved_balance) - marginPortion), 8),
            realized_pnl: round(num(wallet.realized_pnl) + netWithEntryFee, 8),
            updated_at: nowMs
          }
        };
        const idxPartial = engine.positions.findIndex((p) => p.position_id === live.position_id);
        if (idxPartial >= 0) engine.positions[idxPartial] = part.position_after;
        const partialTrade = {
          trade_id: "trd_partial_" + live.position_id + "_" + num(live.partial_close_count, 0),
          execution: executionReport,
          // V15 P0:部分平仓是 Position Event(不是独立母交易)—— 统计/归因/学习都据此聚合
          position_id: live.position_id,
          parent_position_id: live.position_id,
          position_event: true,
          position_margin: num(live.remaining_margin, num(live.entry_notional, 0)),
          leverage_source: live.leverage_source || (num(live.requested_leverage, 0) > 0 ? "AUTO" : "MANUAL"),
          account_id: engine.account.account_id,
          mode: live.mode,
          symbol: live.symbol,
          side: live.direction,
          quantity: part.closed_quantity,
          entry_price: live.entry_price,
          exit_price: part.exit_price,
          entry_time: live.entry_time,
          exit_time: nowMs,
          gross_pnl: part.gross_pnl,
          fees: round(num(part.fees, 0) + entryFeeAllocated, 8),
          entry_fee_allocated: entryFeeAllocated,
          net_pnl: netWithEntryFee,
          // V15 P0:碎片名义做分母会算出 -2624% 这类虚假收益 → 越界的 return_pct 一律置空(不造假),
          // 同时给出【相对仓位保证金】的 return_on_position_pct 作为主要收益口径。
          return_pct: (() => {
            const sliceNotional = num(part.notional_closed, num(live.entry_price) * num(part.closed_quantity, 0));
            if (!(sliceNotional > POSITION_SAMPLE_MIN_NOTIONAL)) return null;
            const pct = round(part.net_pnl / sliceNotional * 100, 6);
            return isValidReturnPct(pct, live.leverage) ? pct : null;
          })(),
          return_on_position_pct: (() => {
            const margin = num(live.remaining_margin, num(live.entry_notional, 0));
            return margin > 0 ? round(netWithEntryFee / margin * 100, 6) : null;
          })(),
          remaining_margin_after: part.position_after.remaining_margin,
          remaining_notional_after: round(num(part.position_after.remaining_quantity, 0) * num(live.entry_price, 0), 8),
          entry_notional_closed: round(marginPortion, 8),
          mfe: num(live.mfe),
          mae: num(live.mae),
          holding_ms: Math.max(0, nowMs - num(live.entry_time)),
          exit_reason: input.exit_reason || "partial_close",
          // V15 §24:区分用户手动干预与自动策略(学习样本据此分流)
          action_source: input.action_source || (input.manual ? "MANUAL" : "AUTO"),
          manual: Boolean(input.manual),
          // V14.5 §29:动作时刻的预测快照(含部分平仓)
          future_prediction_at_action: input.prediction ? predictionSnapshot(input.prediction, { now: nowMs, horizon: input.horizon || (MODE_CONFIG[live.mode] || MODE_CONFIG.short).interval, reason: input.exit_reason || "partial_close" }) : null,
          closed_candle_time: input.closed_candle_time == null ? (live.closed_candle_time == null ? null : num(live.closed_candle_time)) : num(input.closed_candle_time),
          leverage: num(live.leverage, 1),
          partial: true,
          remaining_quantity: part.position_after.remaining_quantity,
          engine_version: live.engine_version,
          model_version: live.model_version,
          created_at: nowMs
        };
        engine.trades.push(partialTrade);
        snapshot();   // §15:先同步账户口径,再落库
        await persist({ account: true, wallet: true, position: [part.position_after], trade: [partialTrade], state: true, queue: [syncItem("paper_trade", partialTrade.trade_id, partialTrade), syncItem("paper_position", part.position_after.position_id, part.position_after)] });
        log("exit", "部分平仓 " + live.symbol + " " + Math.round(fraction * 100) + "% net=" + part.net_pnl + " 剩余 " + part.position_after.remaining_quantity);
        journalExit(live, partialTrade, input);   // 决策日志 + 持仓审计(为什么部分平仓)
        return { ok: true, position: part.position_after, trade: partialTrade, partial: part, is_partial: true };
      }
      const closed = applyClose({ account: engine.account, wallets: engine.wallets, config: cfg }, live, {
        now: nowMs,
        reference_price: referencePrice,
        exit_reason: input.exit_reason || "manual",
        recovered_after_offline: Boolean(input.recovered_after_offline)
      });
      if (!closed.ok) return closed;
      // §17/§18:完整性强制平仓与迁移修复必须在账本与样本上留痕
      closed.trade.action_source = input.action_source || (input.manual ? "MANUAL" : "AUTO");
      closed.trade.manual = Boolean(input.manual);
      if (input.integrity_forced) closed.trade.integrity_forced = true;
      if (input.repair_reason) closed.trade.repair_reason = String(input.repair_reason);
      // V14.5 §29:全平仓也保存动作时刻的预测快照
      if (input.prediction) {
        closed.trade.future_prediction_at_action = predictionSnapshot(input.prediction, { now: nowMs, horizon: input.horizon || (MODE_CONFIG[live.mode] || MODE_CONFIG.short).interval, reason: input.exit_reason || "manual" });
      }
      closed.trade.closed_candle_time = input.closed_candle_time == null ? (live.closed_candle_time == null ? null : num(live.closed_candle_time)) : num(input.closed_candle_time);
      closed.trade.execution = executionReport;
      engine.account = closed.state.account;
      engine.wallets = closed.state.wallets;
      const idx = engine.positions.findIndex((p) => p.position_id === live.position_id);
      if (idx >= 0) engine.positions[idx] = closed.position;
      engine.trades.push(closed.trade);
      const sample = makeLearningSample(closed.trade, live, input);
      closed.trade.learning_sample_id = sample.sample_id;
      await d.store.put("learning_samples", sample);
      // 杠杆学习记录(仅供 Auto Leverage;Shadow 不入账,单独标记)
    // 无效样本(串价/亏损越界/会计不一致/碎片/越界收益)一律不进杠杆学习
    const leverageEligible = sample.invalid_sample !== true;
      if (leverageEligible) {
      engine.leverageRecords.push({
        symbol: live.symbol,
        mode: modeKeyOf(live),
        market_regime: sample.market_regime,
        leverage: num(live.leverage, 1),
        net_pnl: closed.trade.net_pnl,
        mfe: closed.trade.mfe,
        mae: closed.trade.mae,
        exit_reason: closed.trade.exit_reason,
        drawdown_pct: num(engine.account.max_drawdown_pct, 0),
        shadow: false
      });
      }
      if (engine.leverageRecords.length > 2000) engine.leverageRecords.shift();
      // ---- V16 §4:母仓位结算 → 70/30 利润分配(同一个母仓位只结算一次,Partial Close 不重复做)----
      const relatedNet = round(engine.trades
        .filter((t) => t.position_id === live.position_id || t.trade_id === closed.trade.trade_id)
        .reduce((a, t) => a + num(t.net_pnl, 0), 0), 8);
      const split = splitProfitOnPositionClose(profitPool, {
        position_id: live.position_id,
        symbol: live.symbol,
        mode: live.mode,
        at: nowMs,
        net_realized_pnl: relatedNet,
        available_tradable: Math.max(0, num(engine.account.cash_balance) - protectedBalance(profitPool))
      });
      if (split.applied) {
        closed.trade.profit_split = { to_tradable: split.record.to_tradable, to_protected: split.record.to_protected, protected_after: split.record.protected_after };
        log("profit", "利润分配 70/30:" + live.symbol + " 母仓位净利 " + relatedNet + " → 可交易 +" + split.record.to_tradable + " / 保护池 +" + split.record.to_protected);
      }
      // ---- V16 §6:退出时刻的论点状态(复盘/学习用,不改金额)----
      closed.trade.thesis_state_at_exit = live.thesis_state || null;
      if (mustExitImmediately(closed.trade.exit_reason)) closed.trade.exit_override = String(closed.trade.exit_reason).toUpperCase();
      // V16.1 §10:平仓后用真实结果回填因子影子样本(只影响影子状态,不影响金额)
      const settledObs = settleFactorObservations(live.position_id, num(closed.trade.return_on_position_pct, num(closed.trade.return_pct, 0)));
      if (settledObs > 0) log("learning", "因子影子样本回填 " + settledObs + " 条(" + live.symbol + ")");
      snapshot();   // §15:先同步账户口径,再落库(库里不能留旧的 reserved/equity)
      journalExit(live, closed.trade, input);   // 决策日志 + 持仓审计(为什么平)
      await persist({ account: true, wallet: true, position: [closed.position], trade: [closed.trade], state: true, queue: [syncItem("paper_trade", closed.trade.trade_id, closed.trade), syncItem("paper_position", closed.position.position_id, closed.position), syncItem("learning_sample", sample.sample_id, sample)] });
      log("exit", "平仓 " + live.symbol + " " + (input.exit_reason || "manual") + " net=" + closed.trade.net_pnl + " (~" + closed.trade.return_pct + "%)");
      const netPnl = num(closed.trade.net_pnl, 0);
      const reasonCode = String(closed.trade.exit_reason || "manual");
      const isRiskExit = /LIQUIDATION|risk_exit|stop_loss/i.test(reasonCode);
      notify(isRiskExit ? "RISK" : "TRADE",
        (reasonCode === "LIQUIDATION" ? "模拟强平 " : "已模拟平仓 ") + live.symbol.replace("USDT", "/USDT"),
        "净" + (netPnl >= 0 ? "收益 +" : "亏损 ") + Math.abs(netPnl).toFixed(2) + " USDT · " + reasonCode + " · " + (closed.trade.holding_ms / 60000).toFixed(0) + "分钟",
        { key: "close|" + closed.trade.trade_id, always: true, symbol: live.symbol, mode: live.mode, severity: isRiskExit ? "high" : "trade" });
      return { ok: true, position: closed.position, trade: closed.trade, sample };
    });
  }

  function modeKeyOf(position) {
    return position.strategy_mode || (position.mode === "long" ? "LONG_TERM" : "SHORT_TERM");
  }

  // ---- 资金费(V14.3):只有真实费率可见时才动账本;取不到就标 unavailable ----
  // 不变式:amount 恒来自 accrueFunding(上游费率 × 名义 × 跨过期数),绝不使用随机数
  async function settleFunding(pos) {
    if (!pos || pos.status !== "OPEN") return null;
    const before = {
      amount: num(pos.funding_simulated, 0),
      status: pos.funding_status || FUNDING_STATUS.UNAVAILABLE,
      intervals: num(pos.funding_intervals, 0),
      missed: num(pos.funding_missed_intervals, 0),
      until: num(pos.last_funding_time, null)
    };
    const result = accrueFunding(pos, fundingBook, {
      now: now(),
      notional: num(pos.notional, num(pos.entry_notional, 0)),
      interval_ms: num(pos.funding_interval_ms, FU_DEFAULT_INTERVAL_HOURS * 3600000)
    });
    const updated = applyFundingToPosition(pos, result);
    const amount = num(result.amount, 0);
    if (result.applicable && amount !== 0) {
      const mode = pos.mode;
      const wallet = engine.wallets[mode] || {};
      engine.account = {
        ...engine.account,
        cash_balance: round(num(engine.account.cash_balance) + amount, 8),
        realized_pnl: round(num(engine.account.realized_pnl) + amount, 8),
        funding_paid: round(num(engine.account.funding_paid, 0) - amount, 8),
        updated_at: now()
      };
      engine.wallets = {
        ...engine.wallets,
        [mode]: {
          ...wallet,
          available_balance: round(num(wallet.available_balance) + amount, 8),
          realized_pnl: round(num(wallet.realized_pnl) + amount, 8),
          updated_at: now()
        }
      };
    }
    Object.assign(pos, updated);
    const changed = before.amount !== num(pos.funding_simulated, 0)
      || before.status !== pos.funding_status
      || before.intervals !== num(pos.funding_intervals, 0)
      || before.missed !== num(pos.funding_missed_intervals, 0)
      || before.until !== num(pos.last_funding_time, null);
    if (changed) {
      log("funding", pos.symbol + " 资金费 " + pos.funding_status + (amount ? " " + amount : "") + " 累计 " + num(pos.funding_simulated, 0));
      await persist({ position: [pos], account: true, wallet: true });
    }
    return result;
  }

  // 引擎侧喂入真实费率(页面/路由拿到上游数据后调用)
  function observeFunding(symbol, payload, meta) {
    return fundingBook.observe(symbol, payload, meta);
  }

  function markFundingUnavailable(symbol, reason) {
    return fundingBook.markUnavailable(symbol, reason);
  }

  // ---- V14.4:外部情报只读注入(只能收紧风险,不能放行开仓) ----
  function observeExternalContext(ctx) {
    engine.externalContext = ctx || null;
    return engine.externalContext;
  }

  function currentExternalGate(input) {
    if (!engine.externalContext) return null;
    return externalRiskGate({ external: engine.externalContext, ...(input || {}) });
  }

  // ---- V14.4:回撤控制(需要注入 controller;未注入时返回 null,不改变任何行为) ----
  // ---- V16 §8:高水位保护(每轮更新一次;Peak 只增不减,重启/升级/迁移都不重置)----
  function updateHighWater(at) {
    const atMs = num(at, now());
    const equity = num(engine.account && engine.account.total_equity, 0);
    const integrity = accountIntegrityCheck(engine.account, engine.wallets, engine.positions);
    const exact = ledgerExactAudit({ account: engine.account, positions: engine.positions });
    if (!engine.hwm) engine.hwm = createHwmState(equity, atMs);
    const res = updateHwm(engine.hwm, {
      equity: equity,
      at: atMs,
      evidence: {
        price_data_reliable: true,
        // 20% 保护线不允许被"一个坏报价 / 半截账本"误触发:必须账本自洽且精确对账通过
        accounting_healthy: Boolean(integrity.ok) && Boolean(exact.ok),
        equity_snapshot_valid: Number.isFinite(equity),
        provider_conflict: false,
        snapshot_age_ms: 0
      }
    });
    engine.hwm = res.state;
    engine.lastHwm = {
      state: res.state.state,
      state_zh: HWM_STATE_ZH[res.state.state] || res.state.state,
      drawdown_pct: res.drawdown_pct,
      peak_equity: res.peak_equity,
      changed: Boolean(res.changed),
      reason_zh: res.reason_zh,
      scale: res.scale,
      confirmed: Boolean(res.confirmed),
      waiting: res.waiting == null ? 0 : res.waiting
    };
    if (res.changed && res.state.state === "HARD_STOP") {
      pauseEntries("HWM_HARD_STOP:" + res.drawdown_pct + "%");
      notify("RISK", "账户最高保护 HARD STOP", res.reason_zh || "账户级回撤达到 20%,已禁止新开仓", { key: "hwm|HARD_STOP", always: true, severity: "high" });
      log("risk", "HWM HARD_STOP:" + res.reason_zh);
    } else if (res.changed && (res.state.state === "CAUTION" || res.state.state === "DEFENSIVE")) {
      log("risk", "HWM " + res.state.state + ":回撤 " + res.drawdown_pct + "%");
    }
    return engine.lastHwm;
  }

  // ---- V16 §6/§7:论点评估(只写论点状态与建议,不改金额;盈利保护与亏损管理分开给结论)----
  function thesisPass(input) {
    const ctxIn = input || {};
    const decisions = [];
    for (const pos of engine.positions.filter((p) => p.status === "OPEN")) {
      if (!pos.entry_thesis) continue;
      const quote = (ctxIn.quotes || {})[pos.symbol] || null;
      const price = quote ? num(quote.price, null) : (pos.current_price == null ? null : num(pos.current_price));
      const ev = evaluateThesis(pos.entry_thesis, {
        price: price,
        regime: ctxIn.regime || null,
        atr_pct: ctxIn.atr_pct,
        trend_strength: ctxIn.trend_strength,
        reversal_probability: ctxIn.reversal_probability,
        at: now()
      });
      pos.thesis_state = ev.state;
      const protection = profitProtectionDecision(pos, {
        unrealized_pnl: num(pos.unrealized_pnl, 0),
        margin: num(pos.remaining_margin, num(pos.entry_notional, 0)),
        mfe: num(pos.mfe, 0),
        reversal_probability: num(ctxIn.reversal_probability, 0),
        trend_strength: num(ctxIn.trend_strength, 0.5),
        estimated_exit_fee: 0
      });
      const loss = lossManagementDecision(pos, {
        unrealized_pnl: num(pos.unrealized_pnl, 0),
        thesis: pos.entry_thesis,
        thesis_evaluation: ev,
        risk_unit: num(pos.initial_risk, 0),
        holding_ms: Math.max(0, now() - num(pos.entry_time, now())),
        max_hold_ms: num(pos.max_hold_ms, 0)
      });
      decisions.push({
        symbol: pos.symbol, mode: pos.mode,
        direction: String(pos.direction || pos.side || "LONG").toUpperCase() === "SHORT" ? "SHORT" : "LONG",
        thesis_state: ev.state, thesis_state_zh: ev.state_zh, violations_zh: (ev.reasons_zh || []).slice(0, 3),
        protection: protection.action, protection_zh: protection.action_zh,
        loss: loss.action, loss_zh: loss.action_zh,
        r_multiple: loss.r_multiple, at: now()
      });
      if (ev.changed) log("thesis", pos.symbol + " 论点 " + ev.state + ":" + (ev.reasons_zh || []).join("、"));
    }
    engine.thesisDecisions = decisions.slice(-50);
    return engine.thesisDecisions;
  }

  // ---- V16 §22:行为异常检测(系统突然不像自己)+ 异常盈利先查账 ----
  function behaviorPass(at) {
    const atMs = num(at, now());
    try {
      const trades = engine.trades.slice(-80);
      const recent = trades.filter((t) => atMs - num(t.exit_time, 0) <= 6 * 3600000);
      const curve = (engine.equityCurve || []).slice(-40);
      const anomalies = detectBehaviorAnomalies({
        now: atMs,
        recent_trades: trades.map((t) => ({
          at: num(t.exit_time, 0), fees: num(t.fees, 0), holding_ms: num(t.holding_ms, 0),
          net_pnl: num(t.net_pnl, 0), symbol: t.symbol, direction: t.side || t.direction, leverage: num(t.leverage, 1),
          trade_id: t.trade_id, position_id: t.position_id || null, entry_price: num(t.entry_price, 0), exit_price: num(t.exit_price, 0)
        })),
        baseline: engine.behaviorBaseline || null,
        models: engine.lastModelDirections || [],
        leverage_values: engine.leverageRecords.slice(-40).map((r) => num(r.leverage, 1)),
        equity_before: num(engine.lastEquityForAnomaly, num(engine.account.total_equity, 0)),
        equity_now: num(engine.account.total_equity, 0),
        // 从未收到过行情 tick 时按"刚刚 tick 过"处理:否则冷启动会被误判成 RUNTIME_TICK_STOP
        last_tick_at: num(engine.lastMarketTickAt, atMs),
        last_equity_at: num(engine.lastEquityAt, atMs),
        telemetry_history: curve.map((pt) => ({ at: num(pt.at, 0), equity: num(pt.equity, 0) })),
        window_ms: 6 * 3600000,
        recent_trade_count: recent.length
      }) || [];
      // 异常盈利不是被庆祝:先查重复计账 / 方向写反 / 错价 / 单位错误 / 双重 PnL
      if (curve.length >= 2) {
        const first = curve[0];
        const last = curve[curve.length - 1];
        const windowMs = Math.max(0, num(last.at, atMs) - num(first.at, atMs));
        const audit = abnormalProfitAudit({
          equity_before: num(first.equity, 0),
          equity_after: num(last.equity, 0),
          window_ms: windowMs,
          trades: trades,
          rates: {}
        });
        engine.profitAudit = audit;
        if (audit && audit.suspicious) {
          anomalies.push({
            code: "ACCOUNTING_SUSPECT_GAIN",
            zh: "疑似账目异常盈利",
            severity: "CRITICAL",
            detail_zh: "异常盈利先查账:" + (audit.checks || []).filter((c) => !c.pass).map((c) => c.code).join(","),
            evidence: audit
          });
        }
      }
      engine.behaviorAnomalies = anomalies;
      for (const a of anomalies.filter((x) => x.severity === "CRITICAL")) {
        notify("RISK", "行为异常·" + (a.zh || a.code), a.detail_zh || a.code, { key: "anomaly|" + a.code, severity: "high" });
        log("anomaly", (a.zh || a.code) + ":" + (a.detail_zh || ""));
      }
      const blockCodes = ["ACCOUNTING_SUSPECT_GAIN", "EQUITY_TICK_JUMP", "PNL_SHOCK_LOSS", "RUNTIME_TICK_STOP"];
      const blocking = anomalies.filter((a) => a.severity === "CRITICAL" && blockCodes.includes(a.code));
      if (blocking.length) pauseEntries("BEHAVIOR_ANOMALY:" + blocking.map((b) => b.code).join(","));
      engine.lastEquityForAnomaly = num(engine.account.total_equity, 0);
      engine.lastEquityAt = atMs;
    } catch (error) {
      // 诊断类逻辑永远不能影响交易主流程
      engine.behaviorAnomalies = [{ code: "ANOMALY_CHECK_ERROR", zh: "行为检测自身异常", severity: "WARN", detail_zh: String(error && error.message || error) }];
    }
    return engine.behaviorAnomalies;
  }

  // ---- V16 §24:行情心跳 / 重连调度(重连风暴守卫 + 补数据不得当新事件)----
  function noteMarketTick(info) {
    const o = info || {};
    const kind = o.kind || "market";
    if (o.ok === false) {
      const cls = reconnectClassifyError(o.error);
      const attempt = reconnectAttempt(reconnectScheduler, kind);
      log("net", "行情失败(" + cls.kind + " " + cls.zh + "):" + (attempt.allowed ? "重试第 " + attempt.attempt + " 次" : "重连风暴守卫生效"));
      return { ok: false, classify: cls, attempt };
    }
    reconnectSuccess(reconnectScheduler, kind);
    engine.lastMarketTickAt = now();
    return { ok: true, at: engine.lastMarketTickAt };
  }

  function marketEventClass(ev) {
    const cls = classifyMarketEvent(ev || {});
    return { event_class: cls, trigger_decision: shouldTriggerDecision(cls), backfill: cls === "BACKFILL_DUPLICATE" };
  }

  // ---- V16.1 §16:过度交易监控 → 发现就自动收紧(不能发现了还照开)----
  function overtradingPass(at) {
    const atMs = num(at, now());
    const stats = overtradingStats(engine.trades, { now: atMs, window_ms: 24 * 3600000 });
    const detected = detectOvertrading(stats, engine.behaviorBaseline);
    if (detected && detected.spike) {
      const tight = autoTighten(engine.entryTightening, stats, {});
      engine.entryTightening = { ...engine.entryTightening, ...tight, active: true };
      log("risk", "过度交易收紧:" + (tight && tight.reason_zh ? tight.reason_zh : ""));
      notify("RISK", "过度交易 · 已自动收紧", (tight && tight.reason_zh) || "交易频率/费用异常,已提高门槛并延长冷却", { key: "overtrade|tighten", severity: "medium" });
    } else if (engine.entryTightening.active) {
      const next = Math.max(0, num(engine.entryTightening.threshold_delta, 0) - 1);
      engine.entryTightening = { ...engine.entryTightening, threshold_delta: next, active: next > 0, reason_zh: next > 0 ? engine.entryTightening.reason_zh : null };
    }
    engine.lastOvertrading = {
      stats,
      detected,
      tightening: { ...engine.entryTightening },
      view: overtradingView(stats, engine.entryTightening)
    };
    return engine.lastOvertrading;
  }

  // ---- V16.1 §22:被 SKIP 的机会要有影子结果(SKIP 到底有没有躲过坏交易)----
  function resolveSkipShadows(quotes) {
    const q = quotes || {};
    const rows = engine.state.skipped_shadows || [];
    let changed = false;
    for (const rec of rows) {
      if (rec.resolved) continue;
      const quote = q[rec.symbol] || null;
      const price = quote ? num(quote.price, null) : null;
      if (price == null) continue;
      const out = resolveSkippedOutcome(rec, price, {});
      Object.assign(rec, out, { price_at_resolve: price, resolved_at: now() });
      changed = true;
    }
    if (changed) engine.state.skipped_shadows = rows.slice(-200);
    return rows;
  }

  // ---- V16.1 §10:因子影子(入口记录 → 平仓回填真实结果 → 状态机;权重为 0 之前绝不影响决策)----
  function recordFactorObservations(list, meta) {
    const arr = Array.isArray(list) ? list : [];
    const m = meta || {};
    for (const obs of arr) {
      engine.pendingFactorObs.push({ ...obs, position_id: m.position_id || null, symbol: m.symbol || null, mode: m.mode || null, at: num(m.at, now()) });
    }
    if (engine.pendingFactorObs.length > 500) engine.pendingFactorObs = engine.pendingFactorObs.slice(-500);
    return engine.pendingFactorObs.length;
  }

  function settleFactorObservations(positionId, outcomePct) {
    const keep = [];
    let settled = 0;
    for (const obs of engine.pendingFactorObs) {
      if (obs.position_id !== positionId) { keep.push(obs); continue; }
      // 注意:recordFactorObservation 是**就地改写 state 并返回单条 entry**,
      // 不能拿它的返回值覆盖 engine.factorShadow(那会把整个影子状态换成一个因子条目)
      recordFactorObservation(engine.factorShadow, { ...obs, future_outcome_pct: num(outcomePct, 0) });
      settled += 1;
    }
    engine.pendingFactorObs = keep;
    return settled;
  }

  // 树模型只在影子通道里记录(永不参与 Active Decision)
  function recordTreeShadow(candidate) {
    if (!engine.treeArtifact) return null;
    try {
      const row = treeRowFromAnalysis(candidate.analysis || {}, {});
      const res = resolveTreeModel({ artifact: engine.treeArtifact, features: row });
      const rec = {
        symbol: candidate.symbol,
        mode: candidate.mode,
        at: now(),
        role: TREE_MODEL_ROLE,
        source: res && res.source,
        available: Boolean(res && res.available),
        probability_bull: res ? res.probability_bull : null,
        probability_bear: res ? res.probability_bear : null,
        uncertainty: res ? res.uncertainty : null
      };
      engine.lastTreeShadow = rec;
      engine.treeShadowLog = (engine.treeShadowLog || []).concat([rec]).slice(-100);
      return rec;
    } catch (error) {
      engine.lastTreeShadow = { role: TREE_MODEL_ROLE, available: false, error: String((error && error.message) || error).slice(0, 80) };
      return engine.lastTreeShadow;
    }
  }

  async function updateDrawdown(input) {
    if (!d.drawdown) return null;
    const i = input || {};
    const hardStopAt = d.drawdown.hardStopAt ? d.drawdown.hardStopAt() : null;
    const newTrades = hardStopAt ? engine.trades.filter((t) => num(t.exit_time) > num(hardStopAt)).length : 0;
    const record = d.drawdown.evaluate({
      account: engine.account,
      wallets: engine.wallets,
      trades: engine.trades,
      leverage_records: engine.leverageRecords,
      day_start_equity: engine.dayStartEquity,
      new_trades_since_hard_stop: newTrades,
      pool_peaks: engine.poolPeaks || null,
      now: num(i.now, now())
    });
    engine.lastDrawdown = record;
    if (record.changed) {
      log("drawdown", "回撤状态 → " + record.state + "(" + (record.reasons || []).slice(-1)[0] + ")");
      const toStop = record.state === "HARD_STOP";
      notify(toStop ? "RISK" : "RISK", (toStop ? "已进入硬止损(HARD_STOP)" : "回撤状态变化 → " + record.state),
        (record.reasons || []).slice(-1)[0] || "", { key: "drawdown|" + record.state, cooldownMs: 30 * 60000, severity: toStop ? "high" : "warn" });
    }
    return record;
  }

  // ---- V14.4:Profit Lock(需要注入 profitLock 配置;未注入时完全跳过) ----
  // 只做三件事:①按阶段部分/全部锁定 ②把止损推进到含费保护位(单调) ③记录 Shadow 研究样本
  async function applyProfitLock(pos, quote, ctx) {
    if (!d.profitLock || !pos || pos.status !== "OPEN") return { acted: false };
    const cfg = d.profitLock === true ? {} : d.profitLock;
    const price = num(quote.price, num(pos.current_price, pos.entry_price));
    const atr = num(ctx.atr, 0);
    const decision = profitLockDecision({
      position: pos,
      price,
      atr,
      state: profitLockStateOf(pos),           // V15 P0:把"哪些 Stage 已执行"交给决策层
      now_ms: num(ctx.now, now()),
      risk_exit: Boolean(ctx.riskExit),        // §12:风控退出不受最短持有/间隔限制
      dust: cfg.dust,
      trend_strength: cfg.trendStrength,
      reversal_risk: (cfg.reversalRisk != null ? cfg.reversalRisk : (ctx.prediction ? num(ctx.prediction.reversal_risk, 0) : 0)),
      prediction_bullish: ctx.prediction ? num(ctx.prediction.bullish_probability, null) : null,
      remaining_opportunity: cfg.remainingOpportunity,
      volatility_level: ctx.volatilityLevel,
      fee_bps: cfg.fee_bps,
      slippage_bps: cfg.slippage_bps,
      half_spread_bps: cfg.half_spread_bps
    });
    const out = { acted: false, decision };
    // ① 部分/全部锁定
    if (decision.action === "PARTIAL_CLOSE" || decision.action === "FULL_CLOSE") {
      const fraction = decision.action === "FULL_CLOSE" ? 1 : decision.fraction;
      const res = await closePosition(pos, {
        reference_price: price,
        exit_reason: decision.dust_sweep ? "dust_sweep" : "profit_lock_stage" + decision.stage,
        now: num(ctx.now, now()),
        fraction,
        analysis: ctx.analysis,
        decision: ctx.decision
      });
      out.acted = Boolean(res && res.ok);
      out.closed_fraction = fraction;
      out.reason = decision.action;
      // V15 P0:执行成功必须写回"该 Stage 已执行"的状态机,否则每次 tick 都会再砍一刀
      if (out.acted) {
        const liveAfter = engine.positions.find((p) => p.position_id === pos.position_id) || pos;
        Object.assign(liveAfter, applyProfitLockState(liveAfter, {
          stage: decision.stage,
          action: decision.action,
          fraction,
          at: num(ctx.now, now())
        }));
        await persist({ position: [liveAfter], state: true });
      }
      engine.profitLockLog.push({ at: now(), symbol: pos.symbol, action: decision.action, fraction, stage: decision.stage, giveback_pct: decision.giveback.profit_giveback_pct, dust: Boolean(decision.dust_sweep) });
      if (engine.profitLockLog.length > 200) engine.profitLockLog.shift();
      log("profit_lock", pos.symbol + " " + decision.action + " " + Math.round(fraction * 100) + "% (stage " + decision.stage + ", 回吐 " + decision.giveback.profit_giveback_pct + "%)" + (decision.dust_sweep ? " [尘埃收尾]" : ""));
      if (out.acted && fraction >= 0.999999) return out;
    }
    // ② 止损推进(单调:只允许朝有利方向;写入 stop_price 让 evaluateExit 真正生效)
    if (decision.stop_price != null) {
      const live = engine.positions.find((p) => p.position_id === pos.position_id) || pos;
      if (live.status === "OPEN") {
        const isLong = live.side === "LONG";
        const cur = live.stop_price == null ? null : num(live.stop_price);
        const better = cur == null || (isLong ? num(decision.stop_price) > cur : num(decision.stop_price) < cur);
        if (better) {
          live.stop_price = round(num(decision.stop_price), 8);
          live.stop_state = { type: decision.stage >= 2 ? "profit_lock" : "trailing", price: live.stop_price, stage: decision.stage, updated_at: num(ctx.now, now()) };
          out.acted = true;
          out.stop_price = live.stop_price;
          await persist({ position: engine.positions, state: true });
        }
      }
    }
    // ③ Shadow Exit Research(永不入账)
    if (d.shadowExit !== false) {
      const qty = num(pos.remaining_quantity, num(pos.quantity, 0));
      const shadow = shadowExitResearch({
        entry_price: pos.entry_price,
        price,
        side: pos.side,
        quantity: qty,
        notional: num(pos.notional, num(pos.entry_price, 0) * qty),
        mfe_price: pos.side === "LONG" ? num(pos.entry_price) + num(pos.mfe, 0) / Math.max(qty, 1e-9) : num(pos.entry_price) - num(pos.mfe, 0) / Math.max(qty, 1e-9),
        trailing_distance: decision.trail ? decision.trail.distance : 0,
        fee_bps: cfg.fee_bps,
        slippage_bps: cfg.slippage_bps,
        now: num(ctx.now, now())
      });
      out.shadow = shadow;
      if (d.store && cfg.persistShadow) {
        const sample = exitLearningSample({
          symbol: pos.symbol, mode: pos.mode, regime: pos.market_regime, volatility: ctx.volatilityLevel,
          leverage: pos.leverage, stage: decision.stage, giveback: decision.giveback,
          realised_pnl: shadow.unrealized_now, profit_locked: 0, trailing_distance: shadow.scenarios[0] ? 0 : 0,
          exit_policy: "shadow", shadow: true, now: num(ctx.now, now())
        });
        await d.store.put("exit_shadow_samples", sample);
      }
    }
    return out;
  }

  // ---- V14.4:预测结果追踪(存预测 → 到期补实际结果;不参与下单) ----
  async function savePrediction(prediction, meta) {
    if (!d.store || !prediction || !prediction.ok) return null;
    const rec = predictionRecord(prediction, meta);
    engine.predictions.push(rec);
    if (engine.predictions.length > 500) engine.predictions.shift();
    await d.store.put("predictions", rec);
    return rec;
  }

  async function resolveDuePredictions(input) {
    const i = input || {};
    const priceOf = i.priceOf || (() => null);
    const atrPct = num(i.atrPct, 1);
    const resolved = [];
    for (const rec of engine.predictions) {
      if (rec.resolved) continue;
      const spec = PREDICTOR_HORIZONS[rec.horizon];
      if (!spec) continue;
      const dueAt = num(rec.prediction_timestamp, 0) + num(spec.intervalMs, 0);
      if (num(i.now, now()) < dueAt) continue;
      const startPrice = num(rec.price_at_prediction, null);
      const endPrice = priceOf(rec.symbol);
      if (startPrice == null || !(num(endPrice) > 0)) continue;
      // 只拿"已存在"的价格路径(禁止未来数据):用区间内真实最高/最低(若上游提供)
      const path = i.pathOf ? i.pathOf(rec.symbol, rec.prediction_timestamp, dueAt) : null;
      const res = resolvePrediction(rec, {
        price_start: startPrice,
        price_end: num(endPrice),
        high: path && path.high != null ? path.high : num(endPrice),
        low: path && path.low != null ? path.low : num(endPrice),
        atr_pct: atrPct,
        interval_ms: num(spec.intervalMs, 3600000),
        horizon_ms: num(spec.intervalMs, 3600000),
        now: num(i.now, now())
      });
      if (!res.ok) continue;
      const idx = engine.predictions.indexOf(rec);
      if (idx >= 0) engine.predictions[idx] = res.record;
      if (d.store) await d.store.put("predictions", res.record);
      resolved.push(res.record);
    }
    return resolved;
  }

  function resolvedPredictions() {
    return engine.predictions.filter((p) => p.resolved);
  }

  function getProfitLockLog() {
    return engine.profitLockLog.slice();
  }

  function getDrawdown() {
    return engine.lastDrawdown;
  }

  // ---- V15:统一通知(去重 + 冷却),UI 通知中心与 Android 原生通知共用同一份事实 ----
  const NOTIF_COOLDOWN_MS = 10 * 60000;
  function notify(kind, title, body, meta) {
    const m = meta || {};
    const key = m.key || (kind + "|" + title);
    const nowMs = num(m.now, now());
    // 通知中心:负责渠道开关/优先级/Android 渠道映射/统计(去重与冷却仍由这里保持原语义,避免双重判定)
    const decision = notificationCenter.push(kind, title, body, {
      key,
      severity: m.severity || (kind === "RISK" ? "high" : "normal"),
      symbol: m.symbol || null,
      mode: m.mode || null,
      always: Boolean(m.always),
      dedup_window_ms: 0,
      cooldown_ms: num(m.cooldownMs, NOTIF_COOLDOWN_MS)
    });
    if (!decision.added) {
      log("notify", "通道抑制 " + kind + " " + title + " (" + decision.reason + ")");
      return null;
    }
    const recent = engine.notifications.find((n) => n.key === key);
    if (recent) {
      // §38:同一事件只通知一次;相似风险通知走冷却
      if (m.always) { /* 明确的强事件允许重复(如每次平仓) */ }
      else if (nowMs - num(recent.at, 0) < num(m.cooldownMs, NOTIF_COOLDOWN_MS)) return null;
    }
    const item = {
      notification_id: "ntf_" + nowMs + "_" + engine.notifications.length,
      key, kind, title: String(title).slice(0, 80), body: String(body || "").slice(0, 200),
      symbol: m.symbol || null, mode: m.mode || null,
      severity: m.severity || "info",
      at: nowMs, read: false
    };
    engine.notifications.push(item);
    if (engine.notifications.length > 300) engine.notifications.shift();
    // 通知历史持久化:刷新/重开 App 不再归零(fire-and-forget,失败不影响通知本身)
    try {
      const put = d.store.put("paper_notifications", {
        notification_id: item.notification_id,
        key: item.key,
        kind: item.kind,
        title: item.title,
        body: item.body,
        symbol: item.symbol,
        mode: item.mode,
        severity: item.severity,
        at: item.at,
        read: Boolean(item.read)
      });
      if (put && typeof put.catch === "function") put.catch(() => {});
    } catch (error) { /* 存储不可用则仅内存保留 */ }
    log("notify", kind + " " + item.title);
    if (typeof d.onNotify === "function") {
      try { d.onNotify(item); } catch (error) { /* 通知失败不影响引擎 */ }
    }
    return item;
  }

  function getNotifications(options) {
    const o = options || {};
    const list = engine.notifications.slice().reverse();
    return { items: o.unreadOnly ? list.filter((n) => !n.read) : list.slice(0, o.limit || 50), unread: engine.notifications.filter((n) => !n.read).length, total: engine.notifications.length };
  }

  function markNotificationsRead(ids) {
    const set = ids && ids.length ? new Set(ids) : null;
    let n = 0;
    for (const item of engine.notifications) {
      if (set && !set.has(item.notification_id)) continue;
      if (!item.read) {
        item.read = true;
        n += 1;
        try {
          const put = d.store.put("paper_notifications", { ...item });
          if (put && typeof put.catch === "function") put.catch(() => {});
        } catch (error) { /* 存储不可用则仅内存 */ }
      }
    }
    return { marked: n, unread: engine.notifications.filter((x) => !x.read).length };
  }

  // ---- V15 Manual Control Center:调整模拟止损/止盈 ----
  // 必须走 PositionManager(校验方向、禁止放宽、留审计),禁止 UI 直接改持仓字段。
  async function adjustStop(input) {
    const i = input || {};
    const live = engine.positions.find((p) => p.position_id === (i.position_id || i.positionId));
    if (!live) return { ok: false, reason: "position_not_found" };
    if (live.status !== "OPEN") return { ok: false, reason: "not_open" };
    const res = positionManager.adjustStop(live, i.stop_price, { now: now(), manual: true, allow_widen: Boolean(i.allow_widen) });
    if (!res.ok) return res;
    Object.assign(live, res.position);
    await persist({ position: [live], account: true, wallet: true, state: true });
    decisionJournal.record({
      kind: "STOP_RAISE",
      symbol: live.symbol,
      mode: live.mode,
      action_source: "MANUAL",
      why: "手动调整模拟止损 → " + round(num(live.stop_price, 0), 8),
      final: { action: "TRAIL", exit_reason: "manual_stop_adjust" }
    });
    notify("SYSTEM", "已调整模拟止损", live.symbol.replace("USDT", "/USDT") + " → " + num(live.stop_price, 0).toFixed(2), { key: "adjstop|" + live.position_id + "|" + now(), always: true, symbol: live.symbol, mode: live.mode });
    return { ok: true, position: live, audit: res.audit };
  }

  async function adjustTakeProfit(input) {
    const i = input || {};
    const live = engine.positions.find((p) => p.position_id === (i.position_id || i.positionId));
    if (!live) return { ok: false, reason: "position_not_found" };
    if (live.status !== "OPEN") return { ok: false, reason: "not_open" };
    const res = positionManager.adjustTakeProfit(live, i.take_profit_price, { now: now() });
    if (!res.ok) return res;
    Object.assign(live, res.position);
    await persist({ position: [live], account: true, wallet: true, state: true });
    decisionJournal.record({
      kind: "PARTIAL_CLOSE",
      symbol: live.symbol,
      mode: live.mode,
      action_source: "MANUAL",
      why: "手动调整模拟止盈 → " + round(num(live.take_profit_price, 0), 8),
      final: { action: "TAKE_PROFIT", exit_reason: "manual_tp_adjust" }
    });
    notify("SYSTEM", "已调整模拟止盈", live.symbol.replace("USDT", "/USDT") + " → " + num(live.take_profit_price, 0).toFixed(2), { key: "adjtp|" + live.position_id + "|" + now(), always: true, symbol: live.symbol, mode: live.mode });
    return { ok: true, position: live, audit: res.audit };
  }

  // ---- V15:手动平仓(§18-§24) —— 必须走统一 Accounting,禁止 UI 直接删持仓 ----
  async function manualClose(input) {
    const i = input || {};
    const positionId = i.position_id || i.positionId;
    const live = engine.positions.find((p) => p.position_id === positionId);
    if (!live) return { ok: false, reason: "position_not_found" };
    if (live.status !== "OPEN") return { ok: false, reason: "not_open" };
    const fraction = i.fraction == null ? 1 : Math.max(0.0001, Math.min(1, num(i.fraction, 1)));
    const price = num(i.price, num(live.current_price, live.entry_price));
    const full = fraction >= 0.999999;
    const reason = full ? "MANUAL_FULL_CLOSE" : "MANUAL_PARTIAL_CLOSE";
    const res = await closePosition(live, {
      reference_price: price,
      exit_reason: reason,
      now: num(i.now, now()),
      fraction,
      manual: true,
      action_source: "MANUAL",
      prediction: i.prediction || null
    });
    if (!res.ok) return res;
    notify("TRADE", (full ? "手动全部平仓 " : "手动部分平仓 " + Math.round(fraction * 100) + "% ") + live.symbol,
      "净" + (num(res.trade && res.trade.net_pnl, 0) >= 0 ? "收益 +" : "亏损 ") + num(res.trade && res.trade.net_pnl, 0).toFixed(2) + " USDT(用户手动)",
      { key: "manual_close|" + live.position_id + "|" + reason + "|" + Math.round(fraction * 1000), always: true, symbol: live.symbol, mode: live.mode, severity: "trade" });
    return { ...res, manual: true, action_source: "MANUAL", exit_reason: reason };
  }

  // §26:紧急关闭所有 Paper 仓位(调用方负责二次确认;这里只做"全平 + 记录")
  async function emergencyCloseAll(input) {
    const i = input || {};
    const open = engine.positions.filter((p) => p.status === "OPEN");
    const results = [];
    for (const pos of open) {
      const price = num((i.priceOf && i.priceOf(pos.symbol)) || i.price, num(pos.current_price, pos.entry_price));
      const res = await closePosition(pos, { reference_price: price, exit_reason: "EMERGENCY_CLOSE", now: num(i.now, now()), fraction: 1, manual: true, action_source: "MANUAL" });
      results.push({ position_id: pos.position_id, symbol: pos.symbol, ok: Boolean(res.ok), net_pnl: res.trade ? res.trade.net_pnl : null, reason: res.reason || null });
    }
    if (results.length) {
      const net = round(results.reduce((a, b) => a + num(b.net_pnl, 0), 0), 8);
      notify("RISK", "紧急平仓:已关闭 " + results.length + " 个模拟仓位", "合计净" + (net >= 0 ? "收益 +" : "亏损 ") + net.toFixed(2) + " USDT", { key: "emergency_close|" + num(i.now, now()), severity: "high", always: true });
    }
    return { ok: true, closed: results.length, results };
  }

  // §27:暂停/恢复【新开仓】(引擎继续管理现有仓位)
  function pauseEntries(reason) {
    engine.entriesPaused = true;
    engine.entriesPausedReason = reason || "用户暂停新开仓";
    log("pause_entries", engine.entriesPausedReason);
    notify("SYSTEM", "已暂停新开仓", engine.entriesPausedReason + "(现有仓位继续管理)", { key: "entries_paused", severity: "info" });
    return { ok: true, entries_paused: true };
  }

  function resumeEntries() {
    engine.entriesPaused = false;
    engine.entriesPausedReason = null;
    log("resume_entries", "恢复新开仓");
    notify("SYSTEM", "已恢复新开仓", "自动系统可以重新开仓", { key: "entries_resumed", severity: "info" });
    return { ok: true, entries_paused: false };
  }

  // §80:重置 Paper 账户(开发工具;调用方必须二次确认) —— 100 USDT / 70-30
  async function resetPaperAccount(input) {
    const i = input || {};
    if (i.confirm !== true) return { ok: false, reason: "confirm_required" };
    const created = createAccount({ config: cfg, now: num(i.now, now()), initial_balance: num(i.initial_balance, cfg.initial_balance) });
    engine.account = created.account;
    engine.wallets = created.wallets;
    engine.positions = [];
    engine.orders = [];
    engine.trades = [];
    engine.leverageRecords = [];
    engine.predictions = [];
    engine.profitLockLog = [];
    engine.allocationRecords = [];
    engine.poolPeaks = { short: 0, long: 0 };
    engine.state = { ...createEngineState(now()), state: "STOPPED" };
    await persist({ account: true, wallet: true, state: true });
    notify("SYSTEM", "模拟账户已重置", "已恢复 " + num(created.account.initial_balance, 100) + " USDT(短线 " + num(created.wallets.short.allocated_balance) + " / 长线 " + num(created.wallets.long.allocated_balance) + ")", { key: "account_reset|" + num(i.now, now()), severity: "high", always: true });
    return { ok: true, account: engine.account, wallets: engine.wallets };
  }

  // ---- V14.5:Allocation 真正落账(§71/§72:只动 available,已占用保证金不动) ----
  function currentAllocationPct() {
    const s = num(engine.wallets.short && engine.wallets.short.allocated_balance, 0);
    const l = num(engine.wallets.long && engine.wallets.long.allocated_balance, 0);
    const total = s + l;
    return total > 0 ? round(s / total * 100, 2) : num(cfg.short_pct, 70);
  }

  async function applyAllocationDecision(plan, meta) {
    const m = meta || {};
    const res = rebalanceWallets({
      plan,
      wallets: engine.wallets,
      positions: engine.positions,
      account: engine.account,
      total_equity: num(engine.account.total_equity, num(engine.account.initial_balance, 0)),
      current_short_pct: currentAllocationPct(),
      target_short_pct: plan ? plan.target_short_pct : undefined,
      maxStepPct: m.maxStepPct,
      now: num(m.now, now())
    });
    if (!res.ok) return res;
    engine.wallets = res.wallets;
    engine.allocationRecords = engine.allocationRecords || [];
    engine.allocationRecords.push(res.record);
    if (engine.allocationRecords.length > 200) engine.allocationRecords.shift();
    await persist({ wallet: true });
    log("allocation", "调仓 " + res.moved + " USDT:" + res.from_wallet + " → " + res.to_wallet + "(Short " + res.short_pct + "%)");
    await d.store.put("allocation_records", { record_id: "alloc_" + res.record.at, ...res.record });
    return res;
  }

  // 自动再平衡:数据不足/未到间隔/回撤恶化时不动(§3:不为分配而交易;§81:Short 持续恶化才降权)
  async function maybeRebalanceAllocation(input) {
    const i = input || {};
    if (d.allocation === false) return { ok: false, reason: "allocation_disabled" };
    if (i.force !== true) {
      const minInterval = num(d.allocationIntervalMs, 6 * 3600000);
      const last = engine.allocationRecords && engine.allocationRecords.length ? engine.allocationRecords[engine.allocationRecords.length - 1].at : 0;
      if (last && now() - last < minInterval) return { ok: false, reason: "interval_not_reached" };
    }
    const shortTrades = engine.trades.filter((t) => t.mode === "short");
    const longTrades = engine.trades.filter((t) => t.mode === "long");
    // 用真实分池回撤(§81:Short 持续恶化时允许 70/30 → 60/40)
    const ddMetrics = drawdownMetrics({
      account: engine.account,
      wallets: engine.wallets,
      trades: engine.trades,
      pool_peaks: engine.poolPeaks || null,
      now: now()
    });
    const plan = allocationPlan({
      wallets: engine.wallets,
      positions: engine.positions,
      account: engine.account,
      current_short_pct: currentAllocationPct(),
      shortStats: { ...summarizeTrades(shortTrades), max_drawdown_pct: num(ddMetrics.short && ddMetrics.short.pct, 0) },
      longStats: { ...summarizeTrades(longTrades), max_drawdown_pct: num(ddMetrics.long && ddMetrics.long.pct, 0) },
      drawdown: engine.lastDrawdown
    });
    if (!plan.executable) return { ok: false, reason: "no_change", plan };
    return applyAllocationDecision(plan, { now: now() });
  }

  function getAllocation() {
    return {
      short_pct: currentAllocationPct(),
      wallets: engine.wallets,
      records: (engine.allocationRecords || []).slice(-10)
    };
  }

  // ---- V14.5:DeepSeek 关键 Decision Review(§40-§47) ----
  // 只发送结构化摘要(§43),Schema 校验(§44),失败一律回退本地(§46),每日 Token 预算(§47)
  // 绝不改变 Risk 的最终权限(§45:fuse 里 risk.veto 仍然优先)
  const reviewState = { calls: 0, used: 0, fallbacks: 0, last_reason: null, cache: new Map() };

  function reviewNeeded(input) {
    const i = input || {};
    const a = i.analysis || {};
    const c = i.candidate || {};
    const reasons = [];
    if (i.kind === "entry") {
      if (num(a.confidence, 0) >= num(d.deepseekMinConfidence, 70)) reasons.push("较高置信 " + num(a.confidence, 0));
      if (num(c.leverage, 0) >= num(d.deepseekMinLeverage, 4)) reasons.push("中高杠杆 " + num(c.leverage, 0) + "x");
      if (c.rule_ml_conflict === true) reasons.push("Rule/ML 冲突");
      if (c.evidence_conflict === true) reasons.push("Bull/Bear 冲突");
      if (c.predictor_conflict === true) reasons.push("预测与规则对立");
      const notionalPct = num(c.notional_pct, 0);
      if (notionalPct >= num(d.deepseekMinNotionalPct, 25)) reasons.push("较大仓位 " + notionalPct + "%");
    } else if (i.kind === "exit") {
      if (num(i.giveback_pct, 0) >= num(d.deepseekExitGivebackPct, 25)) reasons.push("回吐明显 " + num(i.giveback_pct, 0) + "%");
      if (num(i.reversal_risk, 0) >= 0.7) reasons.push("预测反转风险高");
      if (num(i.close_fraction, 0) >= 0.5) reasons.push("大比例减仓 " + Math.round(num(i.close_fraction, 0) * 100) + "%");
      if (i.regime_changed === true) reasons.push("Regime 变化");
    }
    return { needed: reasons.length > 0, reasons };
  }

  async function reviewDecision(input) {
    const i = input || {};
    if (!d.reviewProvider) return { used: false, reason: "no_provider", reasons: [] };
    const need = reviewNeeded(i);
    if (!need.needed) return { used: false, reason: "not_needed", reasons: [] };
    const key = reviewCacheKey({ symbol: i.symbol, mode: i.mode, closed_candle_time: i.closed_candle_time, engine_version: i.engine_version, model_version: "v14.5", decision_type: i.kind });
    const hit = reviewState.cache.get(key);
    if (hit) return { ...hit, cached: true };
    reviewState.calls += 1;
    let out;
    try {
      out = await d.reviewProvider({ ...i, reasons: need.reasons, key });
    } catch (error) {
      out = { ok: false, reason: error && /timeout/i.test(String(error.message)) ? "timeout" : "provider_error" };
    }
    const result = out && out.ok && out.review
      ? { used: true, direction: out.review.direction, confidence: num(out.review.confidence, 0), risk: num(out.review.risk, 0), agree: out.review.agree_with_local !== false, action: out.review.action, reason: out.review.reason || "", reasons: need.reasons, review: out.review }
      : { used: false, reason: (out && out.reason) || "invalid_schema", reasons: need.reasons, fallback: true };
    if (result.used) reviewState.used += 1;
    else reviewState.fallbacks += 1;
    reviewState.last_reason = result.reason;
    reviewState.cache.set(key, result);
    if (reviewState.cache.size > 200) {
      const firstKey = reviewState.cache.keys().next().value;
      reviewState.cache.delete(firstKey);
    }
    // §45:DeepSeek 建议跳过 → 不交易;建议开仓但 Risk 否决 → 仍不交易(由 openPosition 保证)
    if (result.used && result.action === "skip" && num(result.risk, 0) >= num(d.deepseekSkipRisk, 70)) {
      return { ...result, hard_skip: true };
    }
    return result;
  }

  function reviewStats() {
    return { calls: reviewState.calls, used: reviewState.used, fallbacks: reviewState.fallbacks, last_reason: reviewState.last_reason, cache_size: reviewState.cache.size };
  }

  // §17 样本有效性:任何"不可能数字"都不许进入 ML 训练 / Champion 评估 / Auto Leverage / Exit Policy 学习
  function assessSampleValidity(trade, position) {
    const reasons = [];
    const entry = num(trade && trade.entry_price);
    const qty = num(trade && trade.quantity);
    const notional = Math.abs(entry * qty);
    const bound = lossBoundOf(position || {}) || Math.abs(num(position && position.remaining_margin, 0));
    const net = num(trade && trade.net_pnl);
    const fees = Math.abs(num(trade && trade.fees));
    if (!Number.isFinite(Number(trade && trade.net_pnl)) || !Number.isFinite(Number(trade && trade.gross_pnl))) reasons.push("pnl_not_finite");
    if (!(entry > 0) || !(num(trade && trade.exit_price) > 0)) reasons.push("invalid_price");
    if (bound > 0 && net < -(bound + 1e-6)) reasons.push("loss_beyond_margin");
    if (notional > 0 && (Math.abs(net) + fees) > notional * 1.2) reasons.push("pnl_beyond_notional");
    if (position && position.price_status === "INVALID") reasons.push("price_status_invalid");
    if (position && position.price_status === "STALE") reasons.push("price_status_stale");
    return { valid: reasons.length === 0, reasons, bound, notional };
  }

  function makeLearningSample(trade, position, input) {
    const analysis = (input && input.analysis) || {};
    const decision = (input && input.decision) || {};
    const label = num(trade.net_pnl) > 0 ? "win" : num(trade.net_pnl) < 0 ? "loss" : "flat";
    const validity = assessSampleValidity(trade, position);
    // V15 P0 §16:被迁移标记为 invalid_for_learning 的历史成交,其样本同样不可用于学习
    if (trade && trade.invalid_for_learning) validity.valid = false, validity.reasons.push("trade_flagged_invalid");
    if (trade && trade.invalid_sample) validity.valid = false, validity.reasons.push("trade_invalid_sample");
    // §9:越界收益的样本不算有效样本(不修改历史金额,只是不进学习)
    if (trade && !isValidReturnPct(trade.return_pct, trade.leverage)) { validity.valid = false; validity.reasons.push("return_out_of_range"); }
    return {
      sample_id: "ls_" + trade.trade_id,
      account_id: trade.account_id,
      mode: trade.mode,
      symbol: trade.symbol,
      interval: (MODE_CONFIG[trade.mode] || MODE_CONFIG.short).interval,
      entry_time: trade.entry_time,
      exit_time: trade.exit_time,
      features: JSON.stringify(analysis.features || {}),
      rule_result: JSON.stringify({ direction: analysis.direction, strength: analysis.signal_strength, confidence: analysis.confidence }),
      ml_result: JSON.stringify(decision.ml || null),
      bull_score: decision.bull_score == null ? null : decision.bull_score,
      bear_score: decision.bear_score == null ? null : decision.bear_score,
      risk_score: decision.risk_score == null ? null : decision.risk_score,
      risk_flags: JSON.stringify(decision.risk_flags || []),
      deepseek_review: JSON.stringify(decision.deepseek || null),
      final_decision: JSON.stringify(decision.final || null),
      market_regime: analysis.market_regime ? analysis.market_regime.label : null,
      btc_context: JSON.stringify(analysis.btc_context || null),
      entry_price: trade.entry_price,
      exit_price: trade.exit_price,
      fees: trade.fees,
      gross_pnl: trade.gross_pnl,
      net_pnl: trade.net_pnl,
      mfe: trade.mfe,
      mae: trade.mae,
      holding_ms: trade.holding_ms,
      outcome_label: label,
      // §17:无效样本必须显式标记并说明原因,消费端一律过滤
      invalid_sample: !validity.valid,
      invalid_reason: validity.valid ? null : validity.reasons.join(","),
      action_source: trade.action_source || (input && input.action_source) || "AUTO",
      exit_reason: trade.exit_reason || null,
      price_status: (position && position.price_status) || null,
      integrity_forced: Boolean(input && input.integrity_forced),
      repair_reason: (input && input.repair_reason) || null,
      engine_version: trade.engine_version,
      model_version: trade.model_version,
      created_at: trade.exit_time
    };
  }

  // ---- 单轮 Loop(退出优先 → 风控 → 机会 → 决策 → 下单) ----
  async function loop(input) {
    if (engine.state.state !== "RUNNING") return { ok: false, state: engine.state.state };
    if (engine.loopRunning) return { ok: false, reason: "loop_reentry_blocked", skipped: true }; // 上一轮未结束 → 跳过
    engine.loopRunning = true;
    try {
      return await loopInner(input);
    } finally {
      engine.loopRunning = false;
    }
  }

  // ---- §3/§5 报价写入守卫:有限正数 + symbol 必须匹配 + 新鲜度标记 ----
  function applyQuoteToPosition(pos, quote) {
    const q = quote || {};
    if (q.symbol && String(q.symbol).toUpperCase() !== String(pos.symbol || "").toUpperCase()) {
      raiseIntegrity("price_symbol_mismatch", { position: pos.symbol, quote_symbol: q.symbol });
      Object.assign(pos, { price_status: "INVALID", price_source: "symbol_mismatch" });
      return { ok: false, reason: "price_symbol_mismatch" };
    }
    // 数据质量哨兵:过期 / 0 价 / NaN / provider 冲突 / 异常跳变 都在这里拦下
    const dq = dataQualitySentinel.checkQuote(
      { price: q.price, symbol: q.symbol || pos.symbol, received_at: q.received_at },
      { expectSymbol: pos.symbol, lastPrice: num(pos.current_price, null), lastPriceAt: num(pos.price_updated_at, null) }
    );
    if (!dq.ok) {
      engine.integrity.invalid_price = num(engine.integrity.invalid_price, 0) + 1;
      Object.assign(pos, { price_status: "INVALID", price_source: q.source || null });
      return { ok: false, reason: "data_quality:" + ((dq.issues[0] && dq.issues[0].code) || "unknown") };
    }
    if (!isSafeAmount(q.price)) {
      engine.integrity.invalid_price = num(engine.integrity.invalid_price, 0) + 1;
      Object.assign(pos, { price_status: "INVALID", price_source: q.source || null });
      return { ok: false, reason: "invalid_price" };
    }
    const stale = Boolean(q.received_at && now() - num(q.received_at) > STALE_QUOTE_MS);
    Object.assign(pos, updatePositionPath(pos, q.price, q.high == null ? q.price : q.high, q.low == null ? q.price : q.low, {
      source: q.source || "last",
      stale,
      now: now()
    }));
    return { ok: true, stale, price: num(q.price) };
  }

  // ---- 单笔持仓风险处理(顺序固定:强平 → 不可能亏损 → 移动止损/保本 → 分批止盈 → Profit Lock → 常规退出) ----
  // §9/§12:该流程每次"价格更新"都执行,不依赖新闭合K线;这样止盈/止损/强平不会被拖到下一根 1h K线。
  async function managePositionRisk(pos, ctx) {
    const quote = ctx.quote || {};
    const summary = { exits: [], profit_lock: [], closed: false, skipped: null };
    const applied = applyQuoteToPosition(pos, quote);
    if (!applied.ok) {
      summary.skipped = applied.reason;
      return summary;
    }
    await settleFunding(pos);

    // 1) 强平优先:按强平价成交(跳空/脏价也不能让亏损穿透保证金)
    if (numOrNull(pos.liquidation_price) != null && num(pos.liquidation_price) > 0 && isLiquidated(pos, quote.price)) {
      const res = await closePosition(pos, { reference_price: liquidationFillPrice(pos, quote.price), exit_reason: "LIQUIDATION", now: now(), fraction: 1 });
      if (res.ok) {
        summary.closed = true;
        summary.exits.push({ symbol: pos.symbol, reason: "LIQUIDATION", net_pnl: res.trade.net_pnl });
      }
      return summary;
    }
    // 1b) 不可能亏损(已超过剩余保证金+费用)= 本该早已强平:立即强平并告警
    const bound = lossBoundOf(pos);
    if (num(pos.unrealized_pnl) < -(bound + 1e-6)) {
      const res = await closePosition(pos, { reference_price: liquidationFillPrice(pos, quote.price), exit_reason: "LIQUIDATION", now: now(), fraction: 1, integrity_forced: true });
      if (res.ok) {
        summary.closed = true;
        summary.exits.push({ symbol: pos.symbol, reason: "LIQUIDATION", net_pnl: res.trade.net_pnl, integrity_forced: true });
      }
      raiseIntegrity("impossible_pnl", { position: pos.position_id, symbol: pos.symbol, unrealized: pos.unrealized_pnl, bound });
      return summary;
    }

    // 2) 移动止损 / Break-even:计算结果必须写回 stop_price,否则只是 UI 文案
    // 快速价格轮次没有 ATR 时,用开仓时冻结的 initial_risk 反推(不引入新数据源)
    const atrMult = num((MODE_CONFIG[pos.mode] || MODE_CONFIG.short).stopAtrMult, 1);
    const atrNow = num(ctx.atr, 0) > 0 ? num(ctx.atr, 0) : (num(pos.initial_risk, 0) > 0 ? round(num(pos.initial_risk) / atrMult, 8) : 0);
    if (atrNow > 0) {
      const beResult = applyBreakEven(pos, quote.price, { atr: atrNow, triggerR: 1.0, config: cfg, now: now() });
      if (beResult.changed) Object.assign(pos, beResult.position);
      Object.assign(pos, updateTrailingStop(pos, quote.price, { atr: atrNow, atrMult: 1.2, now: now() }));
      const candidate = pos.stop_state && pos.stop_state.price != null ? pos.stop_state.price : null;
      if (candidate != null) {
        const before = numOrNull(pos.stop_price);
        Object.assign(pos, ratchetStop(pos, candidate));
        if (numOrNull(pos.stop_price) !== before) {
          summary.stop_raised = pos.stop_price;
          // 移动止损/保本真正写回 stop_price —— 记入决策日志与持仓审计(为什么提高止损)
          decisionJournal.record({
            kind: "STOP_RAISE",
            symbol: pos.symbol,
            mode: pos.mode,
            why: "保护已有浮盈:" + (pos.stop_state && pos.stop_state.type === "breakeven" ? "保本止损" : "移动止损") + "上移",
            final: { action: "TRAIL", exit_reason: "trail_stop_raised" },
            risk: engine.lastRisk ? { risk_level: engine.lastRisk.risk_level, max_leverage: engine.lastRisk.max_leverage } : null
          });
          positionManager.transition(pos, "TRAIL", { action_source: "AUTO", now: now(), note: "stop " + before + " → " + pos.stop_price });
        }
      }
    }

    // 3) 分批止盈(TP1/TP2 部分锁定,剩余继续跟趋势)
    const long = sideOf(pos) === "LONG";
    const tpLevels = pos.tp_levels || [];
    if (Array.isArray(tpLevels) && tpLevels.length) {
      const hitIndex = num(pos.tp_hit_count, 0);
      const level = tpLevels[hitIndex];
      if (level && ((long && quote.price >= num(level.price)) || (!long && quote.price <= num(level.price)))) {
        const fraction = level.fraction == null ? 1 : level.fraction;
        const partial = await closePosition(pos, { reference_price: quote.price, exit_reason: "partial_take_profit_tp" + level.level, now: now(), fraction, analysis: ctx.analysis, decision: ctx.decision });
        if (partial.ok) {
          summary.exits.push({ symbol: pos.symbol, reason: "partial_tp" + level.level, net_pnl: partial.trade ? partial.trade.net_pnl : 0, partial: !partial.position || partial.position.status === "OPEN" });
          const live = engine.positions.find((p) => p.position_id === pos.position_id) || pos;
          Object.assign(live, { tp_hit_count: hitIndex + 1 });
          if (live.status !== "OPEN") { summary.closed = true; return summary; }
        }
      }
    }

    // 4) Profit Lock(见好就收 / 动态部分平仓)
    if (d.profitLock) {
      const lockCtx = {
        atr: num(ctx.atr, 0),
        volatilityLevel: ctx.volatilityLevel,
        analysis: ctx.analysis,
        decision: ctx.decision,
        now: now(),
        prediction: ctx.prediction || null
      };
      const lockRes = await applyProfitLock(pos, quote, lockCtx);
      if (lockRes && lockRes.acted) {
        summary.profit_lock.push({ symbol: pos.symbol, action: lockRes.decision.action, fraction: lockRes.closed_fraction || 0, stop_price: lockRes.stop_price || null, stage: lockRes.decision.stage });
        const afterLock = engine.positions.find((p) => p.position_id === pos.position_id) || pos;
        if (afterLock.status !== "OPEN") { summary.closed = true; return summary; }
      }
    }

      // 4b) Dust Guard(§5/§6):剩余已是尘埃 → 一次性合理收尾,不再继续切碎
      if (isDustPosition(pos) && pos.status === "OPEN") {
        const res = await closePosition(pos, { reference_price: quote.price, exit_reason: "dust_sweep", now: now(), fraction: 1 });
        if (res.ok) {
          summary.closed = true;
          summary.exits.push({ symbol: pos.symbol, reason: "dust_sweep", net_pnl: res.trade.net_pnl, dust: true });
          decisionJournal.record({
            kind: "EXIT",
            symbol: pos.symbol,
            mode: pos.mode,
            why: "尘埃仓位收尾:剩余低于门槛,一次性平掉避免碎片成交",
            final: { action: "FULL_CLOSE", exit_reason: "dust_sweep" }
          });
        }
        return summary;
      }

    // 5) 常规退出(止损/止盈/时间/结构失效/信号反转/过期报价)
    const lastSwing = pos.invalidation || {};
    const structureInvalidated = Boolean(
      (long && lastSwing.last_swing_low && quote.price < num(lastSwing.last_swing_low)) ||
      (!long && lastSwing.last_swing_high && quote.price > num(lastSwing.last_swing_high))
    );
    const signal = engine.lastSignals[pos.symbol];
    const signalReversed = Boolean(signal && ((long && /Bearish/i.test(signal)) || (!long && /Bullish/i.test(signal))));
    const reason = evaluateExit(pos, { now: now(), price: quote.price, staleQuote: applied.stale, structureInvalidated, signalReversed, riskExit: Boolean(ctx.riskExit) });
    if (reason) {
      const res = await closePosition(pos, { reference_price: quote.price, exit_reason: reason, now: now(), analysis: ctx.analysis, decision: ctx.decision });
      if (res.ok) {
        summary.closed = true;
        summary.exits.push({ symbol: pos.symbol, reason, net_pnl: res.trade.net_pnl });
      }
    }
    return summary;
  }

  // ---- 价格刷新即评估(§12):任何拿到新报价的路径都必须跑一遍风险处理 ----
  // 注意:这里不能占用 mutex —— closePosition 内部自己会用 mutex,
  // 在外层再持锁会自锁(死等),因此改用与主循环相同的单飞标记互斥。
  async function riskPass(input) {
    // V16 §8:高水位也要在"持仓风险轮次"里更新 —— 否则只有 loop() 一个驱动时,
    // 那些只跑 riskPass 的运行路径(页面 20 秒轮询 / 原生运行时)永远看不到峰值与回撤
    if (!engine.hwm || num(engine.hwm.peak_equity, 0) <= 0) updateHighWater(now());
    const ctx = input || {};
    if (engine.loopRunning) return { ok: false, reason: "loop_reentry_blocked", skipped: true };
    engine.loopRunning = true;
    try {
      const out = { ok: true, evaluated: 0, exits: [], profit_lock: [], skipped: [] };
      for (const pos of engine.positions.filter((p) => p.status === "OPEN")) {
        const quote = (ctx.quotes || {})[pos.symbol];
        if (!quote) { out.skipped.push({ symbol: pos.symbol, reason: "no_quote" }); continue; }
        out.evaluated += 1;
        const res = await managePositionRisk(pos, {
          quote,
          atr: ctx.atr,
          volatilityLevel: ctx.volatilityLevel,
          analysis: ctx.analysis,
          decision: ctx.decision,
          prediction: ctx.predictions ? ctx.predictions[pos.symbol] : null,
          riskExit: ctx.riskExit
        });
        if (res.skipped) out.skipped.push({ symbol: pos.symbol, reason: res.skipped });
        for (const e of res.exits) out.exits.push(e);
        for (const pl of res.profit_lock) out.profit_lock.push(pl);
      }
      await persist({ state: true, position: engine.positions, account: true, wallet: true });
      out.integrity = { ...engine.integrity };
      out.portfolio = snapshot();
      return out;
    } finally {
      engine.loopRunning = false;
    }
  }

  // ---- 账户不变量自检(暴露给 UI/Runtime,异常即暂停新开仓) ----
  function accountIntegrity() {
    return accountIntegrityCheck(engine.account, engine.wallets, engine.positions);
  }

  async function loopInner(input) {
    const ctx = input || {};
    engine.state.loops = num(engine.state.loops, 0) + 1;
    engine.state.last_loop_at = now();
    const summary = { exits: [], opened: [], skipped: [], risk_veto: 0 };
    // V14.4:每轮先更新回撤状态(未注入 controller 时返回 null,行为与 V14.3 一致)
    const dd = await updateDrawdown({ now: now() });
    if (dd) summary.drawdown_state = dd.state;
    // V16 §8/§6/§22:高水位保护 → 论点评估 → 行为异常检测(全部每轮一次)
    summary.hwm = updateHighWater(now());
    summary.thesis = thesisPass({ quotes: ctx.quotes, atr_pct: ctx.atrPct, trend_strength: ctx.trendStrength, reversal_probability: ctx.reversalProbability });
    summary.anomalies = behaviorPass(now()).map((a) => a.code);
    // V16.1 §16/§22/§10:过度交易收紧 + SKIP 影子结果回填 + 因子影子
    summary.overtrading = overtradingPass(now()).tightening;
    resolveSkipShadows(ctx.quotes);
    const predictionBySymbol = ctx.predictions || null;

    // 1) 更新行情 + 2) 退出优先(强平 → 亏损越界 → 移动止损/保本 → 分批止盈 → Profit Lock → 常规退出)
    for (const pos of engine.positions.filter((p) => p.status === "OPEN")) {
      const quote = (ctx.quotes || {})[pos.symbol];
      if (!quote) continue;
      const res = await managePositionRisk(pos, {
        quote,
        atr: num(ctx.atr, 0),
        volatilityLevel: ctx.volatilityLevel,
        analysis: ctx.analysis,
        decision: ctx.decision,
        prediction: predictionBySymbol ? predictionBySymbol[pos.symbol] : null,
        riskExit: ctx.riskExit
      });
      for (const e of res.exits) summary.exits.push(e);
      if (res.profit_lock && res.profit_lock.length) summary.profit_lock = (summary.profit_lock || []).concat(res.profit_lock);
      if (res.skipped) summary.skipped.push({ symbol: pos.symbol, reason: res.skipped });
    }

    // 3) 风控(整体) → 4/5) 机会与决策
    const ddBlock = dd && dd.actions && dd.actions.allow_new_positions === false;
    for (const candidate of ctx.candidates || []) {
      if (summary.exits.length && candidate.mode === "short" && ctx.pauseAfterExit) {
        summary.skipped.push({ symbol: candidate.symbol, reason: "after_exit_cooldown" });
        continue;
      }
      // §27:用户暂停新开仓(现有仓位仍继续被管理)
      if (engine.entriesPaused) {
        summary.skipped.push({ symbol: candidate.symbol, reason: "entries_paused" });
        journalBlocked(candidate, "用户暂停新开仓");
        continue;
      }
      // §54:HARD_STOP 只允许持仓管理与退出,不新开仓(保留更具体的原因,便于回溯)
      if (ddBlock) {
        summary.skipped.push({ symbol: candidate.symbol, reason: "drawdown_hard_stop" });
        journalBlocked(candidate, "回撤保护期(HARD STOP)不新开仓");
        continue;
      }
      // V16 §8:账户级 20% 高水位保护(HARD STOP)—— 不允许因为"模型说会涨回来"继续新增风险
      const hsGate = hardStopGate(engine.hwm);
      if (hsGate.block_new_entry) {
        summary.skipped.push({ symbol: candidate.symbol, reason: "hwm_hard_stop" });
        journalBlocked(candidate, "账户级 20% 回撤保护(HARD STOP)中");
        continue;
      }
      // V15 Portfolio Risk Controller:统一风险结论拥有最终 Veto(等级/暴露/杠杆上限都在这里)
      const risk = currentRisk({ candidate });
      const veto = riskVetoForCandidate(candidate, risk);
      if (!veto.allow) {
        summary.skipped.push({ symbol: candidate.symbol, reason: "portfolio_risk", detail: veto.reasons.slice(0, 3) });
        summary.risk_veto += 1;
        journalBlocked(candidate, "组合风控否决:" + veto.reasons.slice(0, 3).join(","), risk);
        continue;
      }
      // §54:HARD_STOP 只允许持仓管理与退出,不新开仓
      if (ddBlock) {
        summary.skipped.push({ symbol: candidate.symbol, reason: "drawdown_hard_stop" });
        continue;
      }
      // §24/§25:预测参与 Entry 判定 —— 与规则明显对立时不交易(只是证据之一,不单独放行)
      const gate = predictorGate({ prediction: candidate.prediction, direction: (candidate.analysis && candidate.analysis.direction) || candidate.direction });
      if (!gate.allow) {
        summary.skipped.push({ symbol: candidate.symbol, reason: gate.reason, note: gate.note });
        summary.predictor_conflicts = num(summary.predictor_conflicts, 0) + 1;
        log("predictor", candidate.symbol + " 跳过开仓:" + gate.reason);
        continue;
      }
      // §15 动态币种池:候选带流动性/上市时长指标时,按三层池门槛把关
      // (没有指标就放行 —— 不能因为"我们没拿到成交额"就凭空判死一个币)
      if (candidate.metrics) {
        const symState = evaluateSymbol({ ...candidate.metrics, symbol: candidate.symbol });
        if (symState.state === "WARMING_UP" || symState.state === "SUSPENDED" || symState.state === "OBSERVE_ONLY") {
          summary.skipped.push({ symbol: candidate.symbol, reason: "symbol_" + String(symState.state).toLowerCase(), gates: symState.reasons_zh });
          journalBlocked(candidate, "币种池门槛(" + symState.state + "):" + (symState.reasons_zh || []).join("、"));
          continue;
        }
      }
      // §12 集合预测:多路径情景 + 路径分散度 → 高不确定性直接 NO_TRADE
      let ensembleResult = null;
      if (candidate.prediction && candidate.prediction.bull_probability != null) {        const p = candidate.prediction;
        const src = p.probabilities || {};
        ensembleResult = ensembleForecast({
          regime: candidate.analysis && candidate.analysis.market_regime ? candidate.analysis.market_regime.label : null,
          distribution: {
            bull: num(p.bull_probability, num(src.bull, 0.33)),
            neutral: num(p.neutral_probability, num(src.neutral, 0.34)),
            bear: num(p.bear_probability, num(src.bear, 0.33))
          },
          atr_pct: num(candidate.analysis && candidate.analysis.volatility && candidate.analysis.volatility.atrPct, 1),
          trend_strength: num(p.confidence, 0.5),
          uncertainty: num(p.uncertainty, 0.5),
          funding_rate: candidate.funding && candidate.funding.available !== false ? num(candidate.funding.rate, 0) : null
        });
        const eGate = ensembleGate(ensembleResult, {});
        summary.ensemble = (summary.ensemble || []).concat([{
          symbol: candidate.symbol,
          action_bias: ensembleResult.action_bias,
          dispersion: ensembleResult.path_dispersion,
          gate: eGate.code
        }]);
        if (!eGate.allow) {
          summary.skipped.push({ symbol: candidate.symbol, reason: "ensemble_" + eGate.code, note: eGate.reason_zh });
          journalBlocked(candidate, "集合预测否决:" + eGate.reason_zh);
          continue;
        }
      }
      // V16.1 §11:树模型只在影子通道记录(永不参与 Active Decision)
      const treeShadow = recordTreeShadow(candidate);
      if (treeShadow) summary.tree_shadow = (summary.tree_shadow || []).concat([treeShadow]);
      // §41:关键点才做 DeepSeek Review(高置信/高杠杆/明显冲突),失败一律回退本地
      const review = await reviewDecision({
        kind: "entry",
        symbol: candidate.symbol,
        mode: candidate.mode,
        candidate,
        analysis: candidate.analysis,
        risk: candidate.risk || null,
        prediction: candidate.prediction || null,
        external: engine.externalContext,
        now: num(ctx.now, now())
      });
      if (review && review.hard_skip) {
        summary.skipped.push({ symbol: candidate.symbol, reason: "deepseek_skip", note: review.reason });
        continue;
      }
      // §52/§53:回撤期按状态缩放单笔风险预算(只会更小,不会更大);预测不确定/反转高时进一步减半
      const gatePenalty = num(gate.penalty, 0);
      const ddCap = dd && dd.actions ? num(dd.actions.max_risk_per_trade_pct, 15) : 15;
      const scaledRisk = round(Math.max(0.5, Math.min(num(candidate.riskPct, 15), ddCap) * (1 - gatePenalty)), 4);
      const scaled = { ...candidate, riskPct: scaledRisk };
      const res = await openPosition(scaled);
      if (res.ok) summary.opened.push({ symbol: candidate.symbol, mode: candidate.mode, risk_pct: scaledRisk, deepseek: review && review.used ? "used" : "local", deepseek_direction: review && review.used ? review.direction || null : null });
      else {
        if (res.reason === "risk_veto") summary.risk_veto += 1;
        summary.skipped.push({ symbol: candidate.symbol, reason: res.reason });
      }
    }
    await persist({ state: true, position: engine.positions, account: true, wallet: true });
    return { ok: true, state: engine.state.state, summary, portfolio: snapshot() };
  }

  function snapshot(priceOf, opts) {
    // §67:PnL 必须来自当前有效价格 —— 提供 priceOf 时把每笔持仓的现价/浮动盈亏同步刷新,
    // 否则 UI 可能出现"颜色变了但数字还是旧快照"。
    // §3/§5:写入前必须过 symbol 匹配 + 有限正数校验(脏价只标 price_status,不动数字)
    const o = opts || {};
    if (priceOf) {
      for (const p of engine.positions) {
        if (p.status !== "OPEN" && p.status !== "CLOSING") continue;
        applyQuoteToPosition(p, { price: priceOf(p.symbol), source: o.source || "snapshot" });
      }
    }
    const pf = portfolio(engine.account, engine.wallets, engine.positions, priceOf);
    engine.account = pf.account;
    engine.wallets = pf.wallets;
    // §48/§81:分池峰值(用于分池回撤与 Short 恶化时的分配调整)
    const peaks = engine.poolPeaks || { short: 0, long: 0 };
    engine.poolPeaks = {
      short: Math.max(num(peaks.short, 0), num(engine.wallets.short && engine.wallets.short.allocated_balance, 0)),
      long: Math.max(num(peaks.long, 0), num(engine.wallets.long && engine.wallets.long.allocated_balance, 0))
    };
    const open = engine.positions.filter((p) => p.status === "OPEN");
    const today = dayKeyOf(now());
    const todayTrades = engine.trades.filter((t) => dayKeyOf(t.exit_time) === today);
    return {
      state: engine.state.state,
      account: engine.account,
      wallets: engine.wallets,
      positions: open,
      today: summarizeTrades(todayTrades),
      all_time: summarizeTrades(engine.trades),
      open_count: open.length,
      drawdown_pct: engine.account.max_drawdown_pct
    };
  }

  return {
    engine, cfg, log,
    init, start, pause, resume, recover, loop, openPosition, closePosition, snapshot,
    settleFunding, observeFunding, markFundingUnavailable, fundingBook,
    // V14.4
    updateDrawdown, applyProfitLock, observeExternalContext, currentExternalGate,
    savePrediction, resolveDuePredictions, resolvedPredictions,
    getProfitLockLog, getDrawdown,
    // V14.5:Runtime 接线
    maybeRebalanceAllocation, applyAllocationDecision, getAllocation, currentAllocationPct,
    reviewDecision, reviewNeeded, reviewStats,
    // V15
    notify, getNotifications, markNotificationsRead, manualClose, emergencyCloseAll, pauseEntries, resumeEntries, resetPaperAccount,
    // V15 P0 完整性:价格刷新即评估风险 + 账户不变量 + 启动迁移
    riskPass, accountIntegrity, integrityRepair, raiseIntegrity, clearIntegrityPause,
    getIntegrity: () => ({ ...engine.integrity, entries_paused: engine.entriesPaused, entries_paused_reason: engine.entriesPausedReason }),
    // V15 模块化 Runtime 接口(模块只通过引擎暴露的方法读写,UI 不碰内部字段)
    adjustStop, adjustTakeProfit,
    currentRisk: (extra) => currentRisk(extra),
    dataQuality: () => dataQualitySentinel.state(),
    dataQualitySummary: () => dataQualitySentinel.summaryText(),
    notifications: () => notificationCenter.list({ limit: 50 }),
    notificationDigest: () => notificationDigest(notificationCenter),
    setNotifyChannel: (kind, enabled) => notificationCenter.setChannelEnabled(kind, enabled),
    notifyChannels: () => notificationCenter.channels(),
    nativePushQueue: (since) => notificationCenter.nativePushQueue({ since: since || 0 }),
    journal: (opts) => decisionJournal.list(opts || {}),
    journalWhy: (symbol) => decisionJournal.whyText(symbol),
    journalSummary: () => decisionJournal.summary(),
    journalContextForChat: (question, opts) => journalContextForChat(decisionJournal, question, opts || {}),
    // V16.2u §18:决策日志条目(带 signal/intent/decision 溯源字段),供"为什么开/平这单"查询与测试
    journalEntries: (o) => (decisionJournal && typeof decisionJournal.list === "function") ? decisionJournal.list(o || {}) : [],
    positionAudit: (opts) => positionManager.audit(opts || {}),
    positionOverview: () => positionManagerView(engine.positions),
    recoveryReport: () => engine.recoveryReport,
    // V15 Performance Attribution:到底是什么在赚钱/亏钱(策略/币种/Regime/杠杆/模型/退出策略/周期)
    attribution: (options) => attributionOf(engine.trades, options),
    attributionView: (options) => attributionView(attributionOf(engine.trades, options), options),
    // V15 P0 §13:AUTO 杠杆诊断(回答"是不是一直回退 2x")
    leverageDiagnostics: () => {
      const clean = summarizePositions(engine.trades, { clean: true });
      const byMode = { short: 0, long: 0 };
      for (const r of clean.rows) if (byMode[r.mode] != null) byMode[r.mode] += 1;
      const records = engine.leverageRecords.length;
      // 升档所需样本 = 目标档位的门槛(LEVERAGE_POLICY.min_samples),冷启动以 Champion+1 档为参照
      const target = Math.min(10, num(engine.leverageChampion.short, 2) + 1);
      const need = num((LEVERAGE_POLICY.min_samples || {})[target], 20);
      const resolved = (() => {
        try { return requestLeverage({ records: engine.leverageRecords, balance: num(engine.account.cash_balance) + num(engine.account.reserved_balance), champion_leverage: engine.leverageChampion.short || 2, symbol: null, mode: "SHORT_TERM", regime: null }); } catch (error) { return null; }
      })();
      const reason = resolved && resolved.reason ? resolved.reason : "无";
      return {
        champion: { ...engine.leverageChampion },
        challenger: engine.leverageChallenger || null,
        records,
        valid_positions: clean.positions,
        by_mode: byMode,
        required_samples: need,
        upgrade_ready: records >= need,
        status: records >= need ? "可评估" : "样本不足",
        why_not_upgraded: records >= need ? "样本已够,等待下一次评估周期" : "有效完整仓位不足(" + records + "/" + need + "),保持 Champion",
        last_evaluation: engine.leverageLastEvaluation || null,
        sample_source: "Position 级 · CLEAN · Short/Long 分池",
        note: records === 0 ? "无有效样本 → AUTO 只能保持 Champion(通常 2x)" : "已有有效样本,AUTO 可跨重启学习"
      };
    },
    // V15.1 §10:Profit Lock 新数据监控(重复 Partial / 尘埃 / Stage 分布 / 费用拖累)
    profitLockDiagnostics: () => {
      const pos = summarizePositions(engine.trades, { clean: false });
      const partialByPosition = pos.rows.map((r) => num(r.partial_events, 0));
      const totalPartials = partialByPosition.reduce((a, n) => a + n, 0);
      const maxPartials = partialByPosition.length ? Math.max(...partialByPosition) : 0;
      const avgPartials = partialByPosition.length ? round(totalPartials / partialByPosition.length, 3) : 0;
      const stageDist = {};
      for (const t of engine.trades) {
        const m = String(t.exit_reason || "").match(/profit_lock_stage(\d)/);
        if (m) stageDist["stage" + m[1]] = num(stageDist["stage" + m[1]], 0) + 1;
      }
      const dustCloses = engine.trades.filter((t) => t.exit_reason === "dust_sweep").length;
      const fees = round(engine.trades.reduce((a, t) => a + num(t.fees, 0), 0), 8);
      const gross = round(engine.trades.reduce((a, t) => a + Math.abs(num(t.gross_pnl, 0)), 0), 8);
      const warning = maxPartials > PROFIT_LOCK_WARN_PARTIALS_PER_POSITION;
      if (warning) raiseIntegrity("trade_integrity_warning", { max_partials: maxPartials, limit: PROFIT_LOCK_WARN_PARTIALS_PER_POSITION });
      return {
        positions: pos.positions,
        avg_partials_per_position: avgPartials,
        max_partials_per_position: maxPartials,
        partial_limit: PROFIT_LOCK_WARN_PARTIALS_PER_POSITION,
        dust_closes: dustCloses,
        stage_distribution: stageDist,
        fee_drag: { fees, gross_abs: gross, fee_over_gross_pct: gross > 0 ? round(fees / gross * 100, 4) : null },
        warning,
        warning_code: warning ? "TRADE_INTEGRITY_WARNING" : null
      };
    },
    // V15.1 §19:已处理收盘K线(按 symbol|mode|interval 持久化,重启后不会重复处理)
    lastProcessedCandles: () => ({ ...(engine.lastProcessedCandles || {}) }),
    positionStats: () => summarizePositions(engine.trades),
    // ---- V16:资金与决策内核(UI 只通过这里读,不碰内部字段)----
    entryQuality: (input) => entryQuality(input || {}),
    lastQuality: () => engine.lastQuality,
    entryQualityLog: () => engine.entryQualityLog.slice(-100),
    qualitySkips: () => num(engine.qualitySkips, 0),
    skippedShadows: () => (engine.state.skipped_shadows || []).slice(-100),
    capitalAllocation: (input) => capitalAllocation(input || {}),
    exposure: () => effectiveExposure(engine.positions, {}),
    exposureReport: () => exposureReport({
      equity: num(engine.account.total_equity, 0),
      tradable_capital: poolLayers({
        equity: num(engine.account.total_equity, 0),
        reserved_margin: num(engine.account.reserved_balance, 0),
        unrealized_pnl: num(engine.account.unrealized_pnl, 0),
        cash_balance: num(engine.account.cash_balance, 0),
        pool: profitPool
      }).spendable_for_entry,
      positions: engine.positions
    }),
    reserveSummary: () => reserveSummary(reserveBook),
    getReserveBook: () => reserveBook,
    sweepOrphans: (opts) => sweepOrphanReservations(reserveBook, opts || {}),
    protectedPool: () => poolSummary(profitPool),
    poolLayers: () => poolLayers({
      equity: num(engine.account.total_equity, 0),
      reserved_margin: num(engine.account.reserved_balance, 0),
      unrealized_pnl: num(engine.account.unrealized_pnl, 0),
      cash_balance: num(engine.account.cash_balance, 0),
      pool: profitPool
    }),
    protectedIsolationCheck: (req) => protectedIsolationCheck(profitPool, req || {}),
    hwm: () => {
      const equityNow = num(engine.account && engine.account.total_equity, 0);
      // 惰性初始化:引擎还没跑过任何一轮时,水位至少要与当前净值一致(否则 UI 上峰值永远显示 0)
      if (!engine.hwm) engine.hwm = createHwmState(equityNow, now());
      else if (num(engine.hwm.peak_equity, 0) <= 0 && equityNow > 0) engine.hwm = { ...engine.hwm, peak_equity: equityNow, peak_at: now() };
      const live = engine.hwm;
      return {
        state: live.state,
        state_zh: HWM_STATE_ZH[live.state] || live.state,
        drawdown_pct: live.drawdown_pct,
        peak_equity: live.peak_equity,
        ...(engine.lastHwm || {}),
        record: hwmRecord(live)
      };
    },
    updateHighWater,
    // V16.2u §3/§34/§40:运行时"呈现态"唯一输入(UI 不再拼多源):
    // 统一状态机 STOPPED / STARTING / RUNNING / PAUSED / DEGRADED / SAFE_MODE / HARD_STOP
    runtimeView: () => {
      const hs = hardStopGate(engine.hwm);
      const dq = (dataQualitySentinel && dataQualitySentinel.state) ? dataQualitySentinel.state() : { ok: true };
      return {
        state: engine.state.state,
        entries_paused: Boolean(engine.entriesPaused),
        entries_paused_reason: engine.entriesPausedReason || null,
        hwm_block: Boolean(hs.block_new_entry),
        hwm_state: engine.hwm ? engine.hwm.state : null,
        hwm_drawdown_pct: num(engine.hwm && engine.hwm.drawdown_pct, 0),
        data_quality_ok: Boolean(dq.ok),
        open_positions: engine.positions.filter((p) => p.status === "OPEN" || p.status === "CLOSING").length
      };
    },
    recoverHwm: (checks, at) => {
      const r = recoverFromHardStop(engine.hwm, checks, at == null ? now() : at);
      if (r.ok) { engine.hwm = r.state; clearIntegrityPause(); resumeEntries(); }
      return r;
    },
    thesisDecisions: () => engine.thesisDecisions.slice(-50),
    thesisOf: (symbol) => {
      const p = engine.positions.find((x) => x.symbol === symbol && (x.status === "OPEN" || x.status === "CLOSING"));
      return p ? { thesis: p.entry_thesis || null, state: p.thesis_state || null } : null;
    },
    rhythmPolicy: (mode) => rhythmPolicy(mode),
    flipAllowed: (lastClose, mode) => flipAllowed(lastClose, now(), mode),
    behaviorAnomalies: () => engine.behaviorAnomalies.slice(),
    profitAudit: () => engine.profitAudit || null,
    behaviorPass,
    noteMarketTick,
    marketEventClass,
    diag: () => diagDedupeSummary(diagnostics),
    diagExport: (meta) => diagExportBundle(diagnostics, meta || {}),
    diagSnapshot: (values) => diagSnapshot(diagnostics, values || {}),
    diagBreadcrumb: (event) => diagBreadcrumb(diagnostics, event || {}),
    diagCapture: (error, ctx) => captureError(diagnostics, error, ctx || {}),
    classifyErrorZh,
    ledgerExactAudit: () => ledgerExactAudit({ account: engine.account, positions: engine.positions }),
    moneyToleranceUnits: MONEY_DRIFT_TOLERANCE_UNITS,
    // §9 因子中心:从真实成交样本实时算因子有效性/衰减(影子观察,不改金额)
    factorCenter: () => {
      const samples = engine.trades.map((t) => ({
        features: t.features || {},
        forward_return_pct: num(t.return_pct, 0),
        direction: t.side || t.direction || null,
        regime: t.market_regime || null
      }));
      const ranking = rankFactors(samples, {});
      engine.factorStates = engine.factorStates || createFactorStates(FACTOR_REGISTRY);
      return { registry_size: FACTOR_REGISTRY.length, sample_count: samples.length, ranking, states: engine.factorStates };
    },
    universeGates: () => ({ ...UNIVERSE_GATES }),
    evaluateSymbol: (metrics) => evaluateSymbol(metrics || {}),
    ensembleForecast: (ctx) => ensembleForecast(ctx || {}),
    ensembleGate: (forecast, opts) => ensembleGate(forecast || null, opts || {}),
    metaSchedule: (input) => metaSchedule(input || {}),
    combineModels: (models, weights) => combineModels(models || [], weights || {}),
    // ---- V16.1:过度交易收紧 / 因子影子 / 交易分析 / 入口闸门影子 / 树模型影子 ----
    overtrading: () => engine.lastOvertrading,
    overtradingPass,
    entryTightening: () => ({ ...engine.entryTightening }),
    recordFactorObservations,
    factorShadow: () => {
      // advanceFactorStates 会**就地**推进状态并返回一份"本次变化摘要",
      // 不能拿摘要覆盖影子状态本身(否则下一次调用就没有 factors/order 了)
      const advanced = advanceFactorStates(engine.factorShadow || createFactorShadowState(FACTOR_REGISTRY), {});
      return {
        role: "SHADOW",
        weights: activeFactorWeights(engine.factorShadow),
        view: factorShadowView(engine.factorShadow),
        advanced,
        pending: engine.pendingFactorObs.length
      };
    },
    tradeAnalysis: (options) => {
      const a = sessionAnalysis(engine.trades, options || {});
      const flags = redFlagScan(a, {});
      return { analysis: a, flags, view: tradeAnalysisView(a, flags) };
    },
    dailyTradeAnalysis: (dayMs) => dailyAnalysis(engine.trades, dayMs, {}),
    entryGateShadow: () => {
      const rows = engine.state.skipped_shadows || [];
      const ev = gateShadowEvaluate(rows, {});
      const advice = calibrationAdvice(ev, {});
      return { evaluation: ev, advice, view: entryGateShadowView(ev, advice) };
    },
    loadTreeArtifact: (artifact) => { engine.treeArtifact = artifact || null; return Boolean(engine.treeArtifact); },
    treeShadow: () => ({ role: TREE_MODEL_ROLE, artifact_loaded: Boolean(engine.treeArtifact), last: engine.lastTreeShadow, log: (engine.treeShadowLog || []).slice(-20) }),
    exitBucketOf,
    isValidTrade,
    getState: () => engine.state.state,
    getAccount: () => engine.account,
    getPositions: () => engine.positions,
    getOrders: () => engine.orders,
    getTrades: () => engine.trades,
    getFundingSnapshot: () => fundingBook.snapshot()
  };
}
