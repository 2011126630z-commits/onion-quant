// tools/build.mjs
// 把 worker/src 模块打包成可部署的单文件:
//   1) worker/index.js        —— Sites/Cloudflare Worker 入口(单文件 bundle)
//   2) dist/server/index.js   —— 与 worker/index.js 完全一致(部署产物副本)
//   3) 页面内嵌 QEngine bundle —— 引擎+历史模块注入页面 <script>,供浏览器端回测/验证使用
//
// 用法: node tools/build.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";

// 构建期守卫:页面 bundle 必须能被解析且暴露必需 API(防止扁平作用域下的重名/语法回归)
function assertQEngineBundle(bundle) {
  try {
    new vm.Script(bundle, { filename: "qengine-bundle.js" });
  } catch (error) {
    throw new Error("页面 bundle 解析失败(检查模块间重名常量/语法): " + error.message);
  }
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  try {
    vm.runInContext(bundle, sandbox);
  } catch (error) {
    throw new Error("页面 bundle 运行失败: " + error.message);
  }
  const Q = sandbox.window.QEngine || {};
  const required = ["createRequestManager", "homeViewModel", "paperViewModel", "detailViewModel", "chatViewModel", "createPaperEngine", "createHistoryStore", "evaluateRisk", "evidenceBundle", "fuse", "buildChatContext", "answerLocally", "planRetention", "getChampion", "computeAnalysis", "chartApi", "createMlRuntime", "resolveMl", "validateArtifact", "predictLogreg", "runtimeRowFromAnalysis", "fallbackPrediction", "toFusionMl", "createFundingBook", "accrueFunding", "applyFundingToPosition", "fundingCashflow", "normalizeFunding", "loadChampionIntoRuntime", "saveArtifact", "registerModel",
    "createDataHub", "buildExternalContext", "externalRiskGate", "predictMultiHorizon", "predictionRecord", "resolvePrediction",
    "applyCalibration", "buildCalibrationTable", "evaluatePredictorPromotion", "profitLockDecision", "shadowExitResearch",
    "evaluateExitPolicyPromotion", "createDrawdownController", "recoveryLadder", "dynamicAllocation", "allocationPlan",
    "createResearchAgent", "shouldResearch", "evaluateIdeaGates", "researchContext"];
  const missing = required.filter((k) => typeof Q[k] === "undefined");
  if (missing.length) throw new Error("页面 bundle 缺少导出: " + missing.join(","));
  return Object.keys(Q).length;
}

const ROOT = path.resolve(import.meta.dirname, "..");
const W = (p) => path.join(ROOT, "worker", p);
const read = (p) => fs.readFileSync(W(p), "utf8");

// 打包顺序(仅影响同作用域声明顺序;所有模块顶层只做声明,无跨模块求值)
const WORKER_MODULES = [
  "src/newsParse.js",
  "src/proxy.js",
  "src/engine/constants.js",
  "src/engine/utils.js",
  "src/engine/indicators.js",
  "src/engine/structure.js",
  "src/engine/regime.js",
  "src/engine/volume.js",
  "src/engine/timeframes.js",
  "src/engine/btc.js",
  "src/engine/breadth.js",
  "src/engine/candles.js",
  "src/engine/signal.js",
  "src/engine/marketData.js",
  "src/ui/page.js",
  "src/routes.js",
  "src/worker.js"
];

// 注入浏览器页面的模块(引擎+历史逻辑;不含 proxy/取数与路由)
const PAGE_MODULES = [
  "src/newsParse.js",
  "src/engine/constants.js",
  "src/engine/utils.js",
  "src/engine/indicators.js",
  "src/engine/structure.js",
  "src/engine/regime.js",
  "src/engine/volume.js",
  "src/engine/timeframes.js",
  "src/engine/btc.js",
  "src/engine/breadth.js",
  "src/engine/candles.js",
  "src/engine/signal.js",
  "src/history/schema.js",
  "src/history/outcome.js",
  "src/history/stats.js",
  "src/history/record.js",
  "src/history/backtest.js",
  "src/history/store.js",
  "src/history/pipeline.js",
  "src/history/walkforward.js",
  "src/history/dataset.js",
  "src/paper/accounting.js",
  "src/paper/money.js",
  "src/paper/entryQuality.js",
  "src/paper/capitalAllocator.js",
  "src/paper/profitAllocation.js",
  "src/paper/hwm.js",
  "src/paper/thesis.js",
  "src/paper/factors.js",
  "src/paper/modelScheduler.js",
  "src/paper/ensemble.js",
  "src/paper/symbolUniverse.js",
  "src/paper/universeScan.js",
  "src/paper/behaviorAnomaly.js",
  "src/paper/diagnostics.js",
  "src/paper/reconnect.js",
  "src/paper/factorShadow.js",
  "src/paper/overtrading.js",
  "src/paper/tradeAnalysis.js",
  "src/paper/entryGateShadow.js",
  "src/paper/treeModel.js",
  "src/paper/risk.js",
  "src/paper/evidence.js",
  "src/paper/fusion.js",
  "src/paper/mlRuntime.js",
  "src/paper/funding.js",
  "src/paper/dataHub.js",
  "src/paper/externalData.js",
  "src/paper/research.js",
  "src/paper/predictor.js",
  "src/paper/profitLock.js",
  "src/paper/drawdown.js",
  "src/paper/allocation.js",
  "src/paper/engine.js",
  "src/paper/portfolioRisk.js",
  "src/paper/execution.js",
  "src/paper/dataQuality.js",
  "src/paper/positionManager.js",
  "src/paper/notifications.js",
  "src/paper/decisionJournal.js",
  "src/paper/recovery.js",
  "src/paper/equityAnalytics.js",
  "src/paper/taskManager.js",
  "src/paper/chatSession.js",
  "src/paper/attribution.js",
  "src/paper/capitalEfficiency.js",
  "src/paper/runtime.js",
  "src/paper/learning.js",
  "src/paper/support.js",
  "src/paper/retention.js",
  "src/paper/futures.js",
  "src/paper/leverageManager.js",
  "src/ui/uiStore.js",
  "src/ui/requestManager.js",
  "src/ui/chart.js",
  "src/ui/watchlist.js",
  "src/ui/devPerf.js",
  "src/ui/viewModels.js",
  "src/ui/navState.js",
  "src/ui/exportBundle.js",
  "src/paper/accountAudit.js"
];

// 浏览器暴露的引擎 API(页面脚本通过 window.QEngine 调用,避免顶层命名冲突)
const PAGE_EXPORTS = [
  "ENGINE_VERSION", "TF_LIST", "TF_WEIGHTS", "INTERVAL_MS",
  "computeAnalysis", "splitClosed", "lastClosedCloseTime", "tfEvaluate",
  "volumeAnalysis", "volatilityAnalysis", "anomalyDetect", "marketRegime", "regimeLite",
  "analyzeStructure", "srZones", "atrLast", "emaLast", "rsiLast", "adxLast", "bbLast",
  "r2", "median", "stdevSrv",
  "SCHEMA_VERSION", "FEATURE_VERSION", "HORIZONS", "HORIZON_MS", "HORIZON_ZH",
  "noiseThresholdPct", "classifyOutcome", "verdictOf", "computeMFEMAE",
  "resolveHorizon", "resolveSignalOutcomes", "pendingHorizons", "directionSign", "intervalMsOf",
  "signalRecordFromAnalysis", "shouldRecordSignal", "latestOf", "prunePlan", "dueHorizons", "resolveRecordId",
  "sliceUpTo", "makeBacktestPlan", "replaySymbol", "attachOutcomes", "pickSeriesByHorizon",
  "overallStats", "statsByRegime", "statsByConfidence", "statsByDirection", "statsBySymbol",
  "statsBySource", "calibrationTable", "buildStatsBundle", "sampleQuality", "summarize",
  "confidenceBucket", "medianOf", "meanOf",
  "SIGNAL_TABLE", "SIGNAL_OUTCOME_TABLE", "BACKTEST_RUN_TABLE", "BACKTEST_RESULT_TABLE",
  "MODEL_VERSION_TABLE", "SYSTEM_SETTINGS_TABLE", "ALL_TABLES", "SCHEMA_DDL", "createHistoryStore",
  "normalizeKlines", "recordAnalysis", "needIntervalOf", "mergeOutcome", "resolveDueOutcomes",
  "filterRecords", "listRow", "buildValidationView", "detailView", "isUsable", "usableRecords",
  "REGIME_FILTERS",
  "SOURCE_FILTERS", "SOURCE_ZH", "DEFAULT_SOURCE", "filterBySource",
  "BACKTEST_BARS", "BACKTEST_INTERVALS", "MIN_BACKTEST_BARS", "backtestFetchPlan",
  "saveBacktestRun", "recentBacktestRuns", "runBacktestSession", "backtestRunId",
  "makeWalkForwardFolds", "validateFolds", "selectParams", "pickByTime", "evaluateFold",
  "summarizeFolds", "runWalkForwardSession", "DEFAULT_TRAIN_MS", "DEFAULT_TEST_MS", "CONF_GRID",
  "buildDataset", "datasetToCsv", "datasetToJson", "datasetFileName", "collectFeatureColumns",
  "BASE_COLUMNS", "labelColumns", "HORIZON_KEYS", "WALKFORWARD_RUN_TABLE", "WALKFORWARD_FOLD_TABLE",
  "PAPER_DEFAULTS", "createAccount", "fillPrice", "feeOf", "slippagePct", "positionSize", "portfolio",
  "applyOpen", "applyClose", "updatePositionPath", "evaluateExit", "summarizeTrades", "rebalancePlan",
  "targetAllocation", "unrealizedPnl", "canAfford", "dayKeyOf",
  "createPaperEngine", "ENGINE_STATES", "MODE_CONFIG", "idempotencyKey",
  "evaluateRisk", "RISK_LIMITS", "bullEvidence", "bearEvidence", "evidenceBundle",
  "fuse", "ruleScore", "mlScore", "isValidDeepseekReview", "reviewPosition", "FUSION_WEIGHTS",
  "detectDrift", "shouldTrain", "evaluatePromotion", "evaluateRollback", "registerModel", "promoteModel",
  "rollbackModel", "getChampion", "listModels", "PROMOTION_RULES",
  "checkIntegrity", "makeQueueItem", "enqueue", "queueStats", "markSynced", "SYNC_STATUSES",
  "buildReviewPayload", "shouldReview", "reviewCacheKey", "callDeepSeek", "tokenBudgetState", "DEEPSEEK_DEFAULTS",
  "buildChatContext", "answerLocally", "chatContextSummary",
  "createRequestManager", "homeViewModel", "paperViewModel", "detailViewModel", "chatViewModel", "marketRow", "learningViewModel", "stateLabel", "fmtUsdt", "fmtPct", "fmtHold",
  "PAPER_RUNTIME_STATES", "RUNTIME_STATE_ZH", "paperRuntimeView",
  "capitalSnapshot", "capitalParity", "CAPITAL_PARITY_TOLERANCE", "notificationRoute",
  "expireStaleCommands", "COMMAND_TTL_MS",
  "createNavState", "backPriority", "restoreScrollAfterReady", "isSubPage", "NAV_TABS", "NAV_STATE_VERSION",
  "positionView", "pnlLabel", "pnlClass", "fmtUsdtExact", "usdtDigits",
  "createTaskManager", "equityStats", "equityHeadline", "equitySeries", "recoveryView", "positionManagerView",
  "createChatSessionStore", "sessionKeyOf", "limitOutboundContext", "compactSummary", "teardownPlan", "uiIdleState", "REQUEST_KINDS",
  "attributionOf", "attributionView", "exitBucketOf", "summarizePositions", "isValidReturnPct", "positionsAsTrades",
  "CAPITAL_EFFICIENCY_VERSION", "CAPITAL_EFFICIENCY_RULES", "capitalEfficiencyOf", "positionEventTrades", "capitalEfficiencyView",
  // V16.2y:P0 账户审计 / 亏损归因 / 学习完整性 / 完整导出
  "AUDIT_VERSION", "AUDIT_TOLERANCE", "FEATURE_SCHEMA_VERSION", "classifyOrigin", "reconcileAccount", "motherPositions",
  "classifyLoss", "lossAttribution", "duplicateScan", "canonicalSampleId", "learningIntegrity", "ledgerFromRecords",
  "redactSensitive", "buildLossReport",
  "EXPORT_VERSION", "crc32", "createZip", "buildFullExport",
  "createPaperRuntime", "buildQuotes", "runtimeStatus", "runtimeInstanceCount", "getRuntime", "RUNTIME_STATES", "createHistoryStore",
  "planRetention", "applyRetention", "trimSyncQueue", "coreHistoryIntact", "retentionSummary", "RETENTION_POLICY",
  "openFuturesPosition", "closeFuturesPosition", "liquidationPriceOf", "isLiquidated", "futuresUnrealized",
  "buildTakeProfitPlan", "updateTrailingStop", "applyBreakEven", "marginHealth", "clampLeverage", "LEVERAGE_STEPS",
  "requestLeverage", "approveLeverage", "leverageCandidates", "leverageScore", "leverageCapFromRisk", "accountProfile",
  "resolveLeverageTable", "shadowEvaluation", "evaluateLeveragePromotion", "evaluateLeverageRollback", "LEVERAGE_POLICY",
  "closedCandleTime", "REAL_TRADING_ENABLED", "REAL_FUTURES_ENABLED",
  "ML_RUNTIME_VERSION", "ML_FALLBACK_SOURCE", "LR_LABELS", "SUPPORTED_ML_FORMATS", "ML_ARTIFACT_TABLE",
  "softmax", "encodeFeatures", "linearScores", "validateArtifact", "predictLogreg", "runtimeRowFromAnalysis",
  "fallbackPrediction", "resolveMl", "toFusionMl", "createMlRuntime", "saveArtifact", "loadArtifact", "loadChampionIntoRuntime",
  "FUNDING_STATUS", "FU_SOURCE", "FU_DEFAULT_INTERVAL_HOURS", "FU_MAX_AGE_MS", "FU_RATE_SANITY",
  "normalizeFunding", "normalizeFundingList", "fundingCashflow", "createFundingBook", "accrueFunding",
  "applyFundingToPosition", "fundingLabel",
  "describeProbability", "buildExternalContext", "externalRiskGate", "predictMultiHorizon", "profitLockView", "givebackOf",
  "predictorGate", "predictionSnapshot", "riskAdjustedScore", "dynamicAllocation", "allocationPlan", "rebalanceWallets",
  "stepToward", "allocationView", "scoreHeadline", "parseRssItems", "normalizeOkxAnnouncements", "safeUrl",
  "shouldResearch", "createResearchAgent", "createResearchBudget", "createCircuitBreaker", "researchContext", "createDedupeIndex",
  "profitLockDecision", "createDrawdownController", "drawdownView", "DATA_TTLS", "createDataHub", "toFusionMl", "num", "numOrNull", "round", "normalizeFunding",
  "DATA_TTLS", "DATAHUB_DEFAULTS", "freshnessOf", "createDataHub",
  "EXTERNAL_TYPES", "fundingContext", "oiContext", "positioningContext", "takerContext", "liquidationContext",
  "buildNewsContext", "buildExternalContext", "externalUnavailable", "externalRiskGate", "loadExternalContext",
  "newsFreshness", "SOURCE_QUALITY", "NEWS_HALF_LIFE_MS", "NEWS_MAX_AGE_MS",
  "RESEARCH_VERSION", "RESEARCH_SOURCES", "RESEARCH_TRIGGERS", "RESEARCH_BUDGET_DEFAULTS", "IDEA_STATUSES",
  "MUTATES_SOURCE_CODE", "AUTO_PROMOTES_IDEAS", "sourceOf", "isSourceAllowed", "hashText", "dedupeKeys",
  "createDedupeIndex", "shouldResearch", "createResearchBudget", "createCircuitBreaker", "withTimeout",
  "researchResult", "createResearchAgent", "ideaRecord", "evaluateIdeaGates", "saveIdea", "listIdeas", "researchContext",
  "PREDICTOR_VERSION", "PREDICTOR_HORIZONS", "SHORT_HORIZONS", "LONG_HORIZONS", "HORIZON_WEIGHTS",
  "PREDICTOR_PROMOTION_RULES", "CALIBRATION_DEFAULTS", "EXTERNAL_TILT_CAP",
  "ruleTilt", "tfTilt", "structureTilt", "momentumTilt", "volumeTilt", "regimeTilt", "btcTilt", "externalTilt",
  "volatilityForecast", "structureForecast", "predictHorizon", "predictMultiHorizon",
  "buildCalibrationTable", "calibrationFactor", "applyCalibration", "isOverconfident",
  "predictionRecord", "resolvePrediction", "calibrationSamples", "evaluatePredictorPromotion", "summarizePredictions",
  "PROFIT_LOCK_VERSION", "PROFIT_STAGE_THRESHOLDS", "PARTIAL_FRACTIONS", "PROFIT_ACTIONS", "GIVEBACK_WARN_PCT", "GIVEBACK_CRITICAL_PCT",
  "PROFIT_LOCK_WARN_PARTIALS_PER_POSITION", "DUST_MIN_MARGIN_USDT", "DUST_MIN_FRACTION_OF_INITIAL", "PROFIT_LOCK_LIMITS",
  "riskUnitOf", "rMultipleOf", "givebackOf", "profitStage", "dynamicPartialFraction", "dynamicTrailingDistance",
  "protectedProfitStop", "profitLockDecision", "shadowExitResearch", "exitLearningSample", "exitPolicyKey",
  "summarizeExitPolicies", "EXIT_PROMOTION_RULES", "evaluateExitPolicyPromotion", "profitLockView",
  "DRAWDOWN_VERSION", "DRAWDOWN_STATES", "DRAWDOWN_THRESHOLDS", "DRAWDOWN_ACTIONS", "RECOVERY_REQUIREMENTS",
  "EQUITY_MILESTONES", "RISK_BUDGET_BY_MILESTONE",
  "equityMilestoneOf", "riskBudgetFor", "drawdownOf", "drawdownMetrics", "classifyDrawdown",
  "createDrawdownController", "recoveryLadder", "drawdownView",
  "ALLOCATION_VERSION", "ALLOCATION_BOUNDS", "ALLOCATION_PROFILES",
  "riskAdjustedScore", "dynamicAllocation", "allocationPlan", "allocationRiskFactor", "allocationView",
  "chartApi",
  // ---- V16 资金与决策内核 ----
  "MONEY_SCALE", "MONEY_UNIT", "MONEY_DRIFT_TOLERANCE_UNITS", "toUnits", "fromUnits", "addUnits", "subUnits",
  "sumUnits", "mulScalarUnits", "mulDivUnits", "divUnits", "ratioUnits", "cmpUnits", "eqUnits", "driftOf",
  "ledgerExactAudit", "fmtUnits", "moneyFinite",
  "ENTRY_DECISION_KINDS", "ENTRY_DECISION_ZH", "NO_TRADE_ZH", "NO_TRADE_CODES", "ENTRY_QUALITY_VERSION", "ENTRY_QUALITY_RULES",
  "MIN_MEANINGFUL_RULES", "ruleDirectionProbability", "probabilityDistribution", "estimateTradeCosts",
  "expectedGrossEdgePct", "entryQuality", "minimumMeaningfulPosition", "skipShadowRecord", "resolveSkipShadow", "entryQualityView",
  "CAPITAL_LIMITS", "CAPITAL_ALLOCATOR_VERSION", "ALLOC_LADDER", "DEFAULT_CLUSTERS", "ALLOC_BLOCK_CODES",
  "clusterOfSymbol", "allocationPctForQuality", "effectiveExposure", "capitalAllocation", "createReserveBook",
  "reserveCapital", "releaseReserve", "commitReserve", "sweepOrphanReservations", "reservedTotal", "reserveConsistency",
  "reserveSummary", "capitalView",
  "PROFIT_POOL_VERSION", "PROFIT_SPLIT", "PROFIT_POOL_RULES", "PROTECTED_MISUSE_CODES", "createProfitPool",
  "protectedBalance", "protectedIsSpendable", "protectedIsolationCheck", "splitProfitOnPositionClose",
  "poolLayers", "poolSummary", "poolSeries", "poolView",
  "HWM_VERSION", "HWM_STATES", "HWM_THRESHOLDS", "HWM_CONFIRMATION", "HWM_SCALES", "HWM_STATE_ZH", "HWM_ACTIONS",
  "HWM_RECOVERY_REQUIREMENTS", "createHwmState", "mergeHwm", "drawdownFromPeak", "classifyHwm", "scaleForDrawdown",
  "evidenceReliable", "updateHwm", "hardStopGate", "recoveryChecklist", "recoverFromHardStop", "hwmRecord", "hwmView",
  "THESIS_VERSION", "THESIS_STATES", "THESIS_STATE_ZH", "PROTECTION_ACTIONS", "PROTECTION_ZH", "LOSS_ACTIONS",
  "LOSS_ZH", "IMMEDIATE_EXIT_OVERRIDES", "THESIS_RULES", "buildEntryThesis", "evaluateThesis",
  "profitProtectionDecision", "lossManagementDecision", "rhythmPolicy", "flipAllowed", "mustExitImmediately",
  "thesisSnapshot", "thesisView", "ADD_POSITION_MIN_EVIDENCE", "addPositionDecision",
  "FACTOR_FACTORY_VERSION", "FACTOR_GROUPS", "FACTOR_REGISTRY", "factorRegistryView", "efficacyOf", "rankFactors",
  "factorCorrelation", "dedupeFactors", "applyFactorDrift", "createFactorStates", "factorCenterView",
  "META_SCHEDULER_VERSION", "MODEL_KINDS", "MODEL_ZH", "REGIME_MODEL_WEIGHTS", "metaSchedule", "featureOverlap",
  "predictionCorrelation", "detectFakeConsensus", "combineModels", "metaView",
  "ENSEMBLE_VERSION", "SCENARIO_TYPES", "SCENARIO_ZH", "buildScenarios", "ensembleForecast", "ensembleGate", "ensembleView",
  "UNIVERSE_VERSION", "UNIVERSE_TIERS", "SYMBOL_STATES", "UNIVERSE_GATES", "CORE_SYMBOLS", "evaluateSymbol",
  "universeScore", "warmingUpStatus", "buildUniverse", "selectActiveSymbols", "universeView",
  "UNIVERSE_SCAN_VERSION", "SCAN_LIMITS", "estimateSpreadBps", "estimateDepthUsdt", "scanMetrics", "buildScan", "primaryReasonZh",
  "BEHAVIOR_VERSION", "BEHAVIOR_CODES", "BEHAVIOR_ZH", "BEHAVIOR_THRESHOLDS", "detectBehaviorAnomalies",
  "abnormalProfitAudit", "behaviorView",
  "DIAG_VERSION", "DIAG_LEVELS", "createDiagnostics", "classifyErrorZh", "diagErrorId", "diagDedupeKey",
  "captureError", "diagBreadcrumb", "diagSnapshot", "diagRedact", "diagExportBundle", "diagDedupeSummary", "diagnosticsView",
  "RECONNECT_VERSION", "RECONNECT_DEFAULTS", "createReconnectScheduler", "reconnectClassifyError", "reconnectNextDelay",
  "reconnectAttempt", "reconnectSuccess", "reconnectView", "classifyMarketEvent", "dedupeCandles",
  "shouldTriggerDecision", "reconnectPlan",
  // ---- V16.1 影子评估 / 过度交易 / 交易分析 / 入口闸门影子 / 树模型影子 / UI Store ----
  "FACTOR_SHADOW_VERSION", "FACTOR_SHADOW_STATES", "FACTOR_SHADOW_ZH", "createFactorShadowState",
  "recordFactorObservation", "factorIncrementalValue", "markRedundantFactors", "advanceFactorStates",
  "factorShadowEligible", "activeFactorWeights", "factorShadowView",
  "OVERTRADING_VERSION", "OVERTRADING_METRICS", "overtradingStats", "detectOvertrading", "autoTighten", "overtradingView",
  "TRADE_ANALYSIS_VERSION", "sessionAnalysis", "dailyAnalysis", "redFlagScan", "tradeAnalysisView",
  "ENTRY_GATE_SHADOW_VERSION", "resolveSkippedOutcome", "gateShadowEvaluate", "calibrationAdvice", "entryGateShadowView",
  "TREE_MODEL_VERSION", "SUPPORTED_TREE_FORMATS", "TREE_MODEL_ROLE", "TREE_LABELS", "validateTreeArtifact",
  "predictForest", "treeRowFromAnalysis", "resolveTreeModel", "toShadowMl",
  "UI_STORE_VERSION", "UI_BUCKETS", "UI_BUCKET_ZH", "createUiStore", "shouldRender", "uiStoreView",
  // ---- V16.2s 统一自选 / 点击延迟观测 ----
  "WATCHLIST_VERSION", "WATCHLIST_STORAGE_KEY", "normalizeWatchSymbol", "watchlistDisplay", "createWatchlistStore",
  "DEV_PERF_VERSION", "DEV_PERF_PHASES", "createDevPerf"
];

function stripForBundle(code, keepExports) {
  const lines = code.split("\n");
  const outLines = [];
  for (const line of lines) {
    if (/^\s*import\s+[^;]*from\s+["'][^"']+["'];?\s*$/.test(line)) continue;
    if (!keepExports && /^\s*export\s*\{[^}]*\};?\s*$/.test(line)) continue;
    if (!keepExports) {
      outLines.push(line.replace(/^(\s*)export\s+(const|let|var|function|async function|class)\b/, "$1$2"));
    } else {
      outLines.push(line);
    }
  }
  return outLines.join("\n");
}

// ---- 1) 页面 bundle:引擎 + 历史逻辑包成 IIFE,挂到 window.QEngine ----
// 注意:不以内联脚本注入页面(页面本体是 String.raw 模板,内含反引号的代码会破坏模板),
// 而是由 worker 通过 /qengine.js 路由以独立 JS 文件提供,页面用 <script src> 加载。
function buildPageBundle() {
  const parts = PAGE_MODULES.map((rel) => {
    const code = read(rel);
    return "// ===== " + rel + " =====\n" + stripForBundle(code, false);
  });
  const expose = "  window.QEngine = {\n" + PAGE_EXPORTS.map((n) => `    ${n},`).join("\n") + "\n  };";
  return [
    "/* QEngine bundle: 由 tools/build.mjs 从 worker/src 生成(引擎 + 历史逻辑) */",
    "(function () {",
    "'use strict';",
    parts.join("\n"),
    expose,
    "})();"
  ].join("\n");
}

function buildWorkerBundle() {
  const parts = WORKER_MODULES.map((rel) => {
    if (!fs.existsSync(W(rel))) return null;
    const keepExports = rel === "src/worker.js";
    return "// ===== " + rel + " =====\n" + stripForBundle(read(rel), keepExports);
  }).filter(Boolean);
  return prettyConcat(parts);
}

// 把模块拼接为可读的多行文本
function prettyConcat(parts) {
  return parts.join("\n\n") + "\n";
}

// ---- 2) 页面注入 ----
function injectPage(pageSrc, bundle, hash) {
  const marker = "<!--__QE_BUNDLE__-->";
  if (!pageSrc.includes(marker)) return { page: pageSrc, injected: false };
  const tag = '<script src="/qengine.js?h=' + hash + '"></script>';
  return { page: pageSrc.replace(marker, tag), injected: true };
}

// ---- 3) 写出 ----
const baselinePath = path.join(ROOT, ".build", "baseline-v9.js");
fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
if (!fs.existsSync(baselinePath) && fs.existsSync(W("index.js"))) {
  const cur = read("index.js");
  if (!cur.startsWith("// AUTO-GENERATED")) {
    fs.copyFileSync(W("index.js"), baselinePath);
    console.log("baseline saved -> .build/baseline-v9.js");
  }
}

const pageSrc = read("src/ui/page.js");
// 构建期守卫(2026-10-04 实测踩到过):页面本体是 String.raw 模板,
// 模板体内出现【未转义的反引号】(哪怕在注释里)会提前终止模板 —— 分片校验仍会通过,
// 但生成的文件整体是坏的(Node 会把它当 CJS,命名导出消失)。这里直接数反引号:
// 正确的 page.js 只有两处未转义反引号(模板开头/结尾);其余必须写成 \` 或不用。
{
  let stray = [];
  const lines = pageSrc.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const ln = lines[i];
    for (let c = 0; c < ln.length; c += 1) {
      if (ln[c] === "`" && (c === 0 || ln[c - 1] !== "\\")) stray.push(i + 1);
    }
  }
  // 合法:第 3 行 `export const page = String.raw\` 与末行 "</html>\`;" 各一处
  if (stray.length !== 2) {
    throw new Error("页面模板反引号守卫失败:未转义反引号出现在行 " + stray.join(",") + "(应为 2 处:模板开头/结尾)");
  }
}
const pageBundle = buildPageBundle();
const engineVersion = (read("src/engine/constants.js").match(/ENGINE_VERSION\s*=\s*"([^"]+)"/) || [, "unknown"])[1];
const qeHash = createHash("sha1").update(pageBundle).digest("hex").slice(0, 10);
if (pageBundle.includes("</script")) throw new Error("page bundle must not contain </script");
if (pageBundle.includes("<!--")) throw new Error("page bundle must not contain HTML comment markers");
const exposedKeys = assertQEngineBundle(pageBundle);
console.log("QEngine bundle verified (" + exposedKeys + " exports)");

const pageModuleCode = pageSrc.replace(/^export const page = /m, "const page = ");
// 构建期守卫:页面内联脚本必须能解析(模板字符串内的 JS 逃过 node --check)
for (const m of pageModuleCode.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
  try {
    new vm.Script(m[1], { filename: "page-inline-script.js" });
  } catch (error) {
    throw new Error("页面内联脚本语法错误: " + error.message);
  }
}
console.log("page inline script verified");
const injected = injectPage(pageModuleCode, pageBundle, qeHash);
if (!injected.injected) throw new Error("page marker <!--__QE_BUNDLE__--> not found in src/ui/page.js");

const pageDef = injected.page.trim();
// QENGINE_SRC:浏览器引擎源码,由 /qengine.js 路由返回(用 JSON.stringify 保证任意字符都安全)
const qengineChunk =
  "// ===== generated: browser engine source served at /qengine.js =====\n" +
  "const QENGINE_SRC = " + JSON.stringify(pageBundle) + ";\n" +
  "const QENGINE_HASH = " + JSON.stringify(qeHash) + ";\n" +
  "const QENGINE_VERSION = " + JSON.stringify(engineVersion) + ";\n";

let workerBundle = buildWorkerBundle();
const pageStart = workerBundle.indexOf("const page = String.raw`");
const pageEnd = workerBundle.indexOf("</html>`;", pageStart);
if (pageStart < 0 || pageEnd < 0) throw new Error("page definition not found in bundle");
workerBundle =
  "// AUTO-GENERATED by tools/build.mjs — 请勿直接编辑此文件\n" +
  "// 源码在 worker/src/ ; 修改后运行: node tools/build.mjs\n\n" +
  workerBundle.slice(0, pageStart) +
  qengineChunk +
  pageDef +
  workerBundle.slice(pageEnd + "</html>`;".length);
console.log("page linked to /qengine.js?h=" + qeHash + " (bundle " + (pageBundle.length / 1024).toFixed(1) + " KB)");

fs.writeFileSync(W("index.js"), workerBundle, "utf8");
console.log("wrote worker/index.js (" + (workerBundle.length / 1024).toFixed(1) + " KB, " + workerBundle.split("\n").length + " lines)");

const distDir = path.join(ROOT, "dist", "server");
fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(path.join(distDir, "index.js"), workerBundle, "utf8");
console.log("wrote dist/server/index.js");
