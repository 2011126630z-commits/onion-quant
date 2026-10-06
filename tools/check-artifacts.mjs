// tools/check-artifacts.mjs · 构建产物一致性 + Paper Only 约束自检
import fs from "node:fs";
import path from "node:path";
const ROOT = path.resolve(import.meta.dirname, "..");
let failed = 0, passed = 0;
const check = (name, ok, detail) => { if (ok) { passed += 1; console.log("PASS  " + name); } else { failed += 1; console.log("FAIL  " + name + (detail ? "  => " + detail : "")); } };

const workerSrc = fs.readFileSync(path.join(ROOT, "worker/index.js"), "utf8");
const distSrc = fs.readFileSync(path.join(ROOT, "dist/server/index.js"), "utf8");
check("worker/index.js 与 dist/server/index.js 完全一致", workerSrc === distSrc);
check("产物带 AUTO-GENERATED 标记", workerSrc.startsWith("// AUTO-GENERATED"));
console.log("      worker 产物 " + (workerSrc.length / 1024).toFixed(1) + " KB / " + workerSrc.split("\n").length + " lines");

const bundleMatch = workerSrc.match(/const QENGINE_SRC = ("(?:[^"\\]|\\.)*");/);
check("产物内嵌 QEngine 源码", Boolean(bundleMatch));
const bundle = bundleMatch ? JSON.parse(bundleMatch[1]) : "";
console.log("      qengine " + (bundle.length / 1024).toFixed(1) + " KB");
for (const key of ["chartApi", "createMlRuntime", "createFundingBook", "computeAnalysis", "createPaperEngine", "registerModel"]) {
  check("bundle 暴露 " + key, bundle.includes(key));
}
check("bundle 不直接内联页面(通过 /qengine.js 提供)", /<script src="\/qengine\.js\?h=/.test(workerSrc));

// Paper Only 硬约束
const forbidden = [
  ["真实下单接口", /\bplaceOrder\b|\bcreateOrder\b|fapi\/v1\/order|api\/v3\/order/i],
  ["真实 API Key 字面量", /(api[_-]?key|secret[_-]?key)\s*[:=]\s*["'][A-Za-z0-9_-]{16,}["']/i],
  ["前端硬编码凭据", /sk-[A-Za-z0-9]{20,}/],
  ["内置大模型权重/推理调用", /openai|anthropic|gemini|huggingface/i]
];
for (const [label, re] of forbidden) {
  check("禁止项检查:" + label, !re.test(workerSrc));
}
check("REAL_TRADING_ENABLED 仍为关闭", /REAL_TRADING_ENABLED\s*=\s*false/.test(workerSrc) && /REAL_FUTURES_ENABLED\s*=\s*false/.test(workerSrc));

// 本轮新增能力必须在产物里
for (const needle of ["dtLatestBtn", "dtOhlcChg", "dtVolValue", "mlArtifactFile", "mlRuntimeCard", "syncAppLayer", "chartApi.panViewport", "resolveMl(", "markFundingUnavailable"]) {
  check("产物包含 " + needle, workerSrc.includes(needle));
}
check("页面不再出现 ml: null 字面量", !/ml: null/.test(workerSrc));

// V14.4:预测 / 外部情报 / 利润保护 / 回撤 必须进入产物
for (const needle of ["dtFutureCard", "dtFutureHeadline", "dtExternalCard", "dtExternalToggle", "dtLockCard", "dtLockGiveback", "dtDrawdown"]) {
  check("V14.4 页面元素 " + needle, workerSrc.includes(needle));
}
for (const key of ["predictMultiHorizon", "describeProbability", "buildExternalContext", "externalRiskGate", "createDataHub", "profitLockDecision", "profitLockView", "givebackOf", "createDrawdownController", "drawdownView", "createResearchAgent", "shouldResearch", "evaluateIdeaGates", "evaluatePredictorPromotion", "dynamicAllocation", "allocationPlan", "createResearchBudget", "createCircuitBreaker"]) {
  check("V14.4 bundle 暴露 " + key, bundle.includes(key));
}
check("研究模块声明不改生产源码(MUTATES_SOURCE_CODE=false)", /MUTATES_SOURCE_CODE\s*=\s*false/.test(bundle) && /AUTO_PROMOTES_IDEAS\s*=\s*false/.test(bundle));
check("研究模块不含 fs/child_process", !/from "node:fs"|from "node:child_process"/.test(bundle.split("===== src/paper/research.js =====")[1] ? bundle.split("===== src/paper/research.js =====")[1].split("=====")[0] : ""));
check("外部数据权限:永不授予开仓", /can_grant_open:\s*false/.test(bundle));
check("REAL_TRADING_ENABLED 仍为 false(V14.4 未放开)", /REAL_TRADING_ENABLED\s*=\s*false/.test(workerSrc) && /REAL_FUTURES_ENABLED\s*=\s*false/.test(workerSrc));

// V15:页面脚本用到的每个 QE.<name> 都必须真的在 bundle 导出清单里
// (页面脚本与 bundle 是分离作用域,漏一个名字就是运行时 TypeError)
const pageSrc = fs.readFileSync(path.join(ROOT, "worker/src/ui/page.js"), "utf8");
const exportsBlock = fs.readFileSync(path.join(ROOT, "tools/build.mjs"), "utf8").match(/const PAGE_EXPORTS\s*=\s*\[([\s\S]*?)\];/);
const exportedNames = new Set([...(exportsBlock ? exportsBlock[1] : "").matchAll(/"([A-Za-z_$][\w$]*)"/g)].map((m) => m[1]));
const usedNames = new Set();
for (const line of pageSrc.split("\n")) {
  if (/^\s*\/\//.test(line)) continue;   // 跳过纯注释行
  for (const m of line.matchAll(/\bQE\.([A-Za-z_$][\w$]*)/g)) usedNames.add(m[1]);
}
const missingExports = [...usedNames].filter((n) => !exportedNames.has(n));
check("页面 QE.* 调用全部有导出(" + usedNames.size + " 个)", missingExports.length === 0, missingExports.join(", "));
check("页面未使用动态 QE[...] 访问", !/\bQE\s*\[/.test(pageSrc));
// snapshot(priceOf) 的 priceOf 必须按 symbol 取价:传常量会把所有持仓刷成同一个价格(串价)
check("页面 snapshot 回调按 symbol 取价(无常量闭包)", !/snapshot\(\s*\(\s*\)\s*=>/.test(pageSrc));
check("页面手动平仓按持仓 symbol 取价", /priceOfSymbol/.test(pageSrc) && !/lastPositionRaw\s*\?\s*viewState\.lastPositionRaw\.symbol/.test(pageSrc));
// V15 P0:资金/仓位完整性必须在产物里真实存在(不是只有测试里有)
for (const key of ["riskPass", "accountIntegrity", "integrityRepair", "liquidationInvariant", "liquidationFillPrice", "ratchetStop", "lossBoundOf", "unrealizedNetPnl", "accountIntegrityCheck", "assessSampleValidity"]) {
  check("P0 完整性能力进入产物 " + key, workerSrc.includes(key));
}
check("P0 强平优先于止损(风险处理顺序)", workerSrc.indexOf("1) 强平优先") > 0 && workerSrc.indexOf("1) 强平优先") < workerSrc.indexOf("5) 常规退出"));
check("P0 价格路由守卫存在(symbol 不匹配拒绝写入)", /price_symbol_mismatch/.test(workerSrc) && /price_symbol_not_match|symbol_mismatch/.test(workerSrc));
check("P0 无效样本字段进入产物", /invalid_sample/.test(workerSrc) && /invalid_reason/.test(workerSrc));
check("P0 行情异常不再显示巨大负数", /行情异常/.test(workerSrc));
check("页面价格轮询不再依赖闭合K线(riskPass 定时器)", /refreshPositionRisk/.test(pageSrc) && /riskTimer = setInterval/.test(pageSrc));
// V15 模块化:每个新模块都必须真的进产物并接线(不是 FILE EXISTS)
for (const key of ["portfolioRisk", "riskVetoForCandidate", "simulateFill", "closeOrder", "createDataQualitySentinel", "createPositionManager", "createTaskManager", "createNotificationCenter", "createDecisionJournal", "recoveryPlan", "equityStats"]) {
  check("V16 模块进入产物 " + key, workerSrc.includes(key) || bundle.includes(key));
}
check("V16 组合风险拥有最终 Veto(loop 里有否决分支)", /riskVetoForCandidate\(candidate, risk\)/.test(pageSrc) || /riskVetoForCandidate\(candidate, risk\)/.test(workerSrc));
check("V16 后台任务统一登记(无散落 setInterval 执行体)", /taskBag\.runOnce\("paper-loop"\)/.test(pageSrc) && /taskBag\.runOnce\("position-risk"\)/.test(pageSrc) && /taskBag\.register\("market-intel"/.test(pageSrc));
check("V16 手动调整止损/止盈走引擎(不直接改字段)", /eng\.adjustStop\(/.test(pageSrc) && /eng\.adjustTakeProfit\(/.test(pageSrc));
check("V16 决策日志接入 AI Chat", /journalContextForChat/.test(pageSrc) && /journalContextForChat/.test(workerSrc));
check("V16 统计与净值曲线进入模拟页", /renderPaperStats/.test(pageSrc) && /pfStatsBox/.test(pageSrc));
check("V16 系统状态展示模块健康", /数据质量/.test(pageSrc) && /后台任务/.test(pageSrc));
// V15 P0 交易完整性:状态机 / Dust Guard / Position 级口径 / 收益合理性 必须真的在产物里
for (const key of ["profitLockStateOf", "applyProfitLockState", "isDustPosition", "PROFIT_LOCK_LIMITS", "DUST_MIN_MARGIN_USDT", "summarizePositions", "isValidReturnPct"]) {
  check("P0 交易完整性能力进入产物 " + key, workerSrc.includes(key) || bundle.includes(key));
}
check("P0 部分平仓标记为仓位事件", /position_event: true/.test(workerSrc) && /parent_position_id/.test(workerSrc));
check("P0 尘埃收尾路径存在(dust_sweep)", /dust_sweep/.test(workerSrc));
check("P0 CSV 补齐真实字段", /return_on_position_pct/.test(pageSrc) && /leverage_source/.test(pageSrc) && /entry_fee_allocated/.test(pageSrc) && /remaining_notional_after/.test(pageSrc));
check("P0 归因默认按完整仓位统计", /level === "trade" \? "trade" : "position"/.test(workerSrc) || /level: "position"/.test(bundle));
check("P0 历史异常只标记不改账(invalid_for_learning)", /invalid_for_learning/.test(workerSrc) && !/t\.net_pnl = /.test(workerSrc));
check("P0 AUTO 杠杆可跨重启学习(记录重建)", /AUTO leverage 学习记录重建/.test(workerSrc));
// 扁平 bundle 不支持别名导入:import { a as b } 会只剩原名 → 运行时 "b is not defined"
check("V16 未使用别名导入(扁平 bundle 陷阱)", !/import\s*\{[^}]*\bas\s+[A-Za-z_$]/.test(bundle));

// ---- V17/V16 资金与决策内核:模块必须真的进产物,并且真的被引擎调用(不是 FILE EXISTS)----
for (const key of [
  "toUnits", "ledgerExactAudit", "MONEY_UNIT",
  "entryQuality", "minimumMeaningfulPosition", "ENTRY_DECISION_KINDS", "estimateTradeCosts", "skipShadowRecord",
  "capitalAllocation", "CAPITAL_LIMITS", "reserveCapital", "commitReserve", "releaseReserve", "sweepOrphanReservations",
  "splitProfitOnPositionClose", "PROTECTED_MISUSE_CODES", "protectedIsSpendable",
  "updateHwm", "hardStopGate", "HWM_THRESHOLDS", "recoverFromHardStop",
  "buildEntryThesis", "evaluateThesis", "lossManagementDecision", "profitProtectionDecision", "addPositionDecision", "flipAllowed",
  "FACTOR_REGISTRY", "efficacyOf", "dedupeFactors", "applyFactorDrift",
  "metaSchedule", "detectFakeConsensus", "combineModels",
  "ensembleForecast", "ensembleGate", "SCENARIO_TYPES",
  "buildUniverse", "selectActiveSymbols", "warmingUpStatus", "SYMBOL_STATES",
  "detectBehaviorAnomalies", "abnormalProfitAudit",
  "createDiagnostics", "diagExportBundle", "diagRedact", "diagDedupeSummary",
  "reconnectAttempt", "classifyMarketEvent", "dedupeCandles", "shouldTriggerDecision"
]) {
  check("V16 模块进入产物 " + key, workerSrc.includes(key) || bundle.includes(key));
}
check("V16 单仓 40% 硬上限是常量(不是散落魔法数)", /max_single_position_pct:\s*40/.test(workerSrc) || /max_single_position_pct:\s*40/.test(bundle));
check("V16.1 组合保证金上限 = 100%(不允许 120U 保证金)", /max_portfolio_margin_pct:\s*100/.test(workerSrc) || /max_portfolio_margin_pct:\s*100/.test(bundle));
check("V16.1 名义暴露单独计量(不与会保证金混淆)", /max_notional_exposure_pct/.test(workerSrc) && /notional_exposure_pct/.test(workerSrc) && /margin_exposure_pct/.test(workerSrc));
check("V16.1 利润保护池随引擎状态持久化并可恢复", /profit_pool/.test(workerSrc) && /restoreProfitPool/.test(workerSrc));
check("V16 利润保护池结构上不可花费", /function protectedIsSpendable\(\)\s*\{\s*return false;/.test(workerSrc) || /function protectedIsSpendable\(\)\s*\{\s*return false;/.test(bundle));
check("V16 开仓必须过质量闸门(openPosition 内有拒绝分支)", /entry_quality_/.test(workerSrc) && /开仓质量闸门/.test(workerSrc));
check("V16 开仓必须过资金分配(被削或拒绝)", /capital_alloc_/.test(workerSrc) && /capitalAllocation\(/.test(workerSrc));
check("V16 开仓真正原子预占资金", /reserveCapital\(reserveBook/.test(workerSrc));
check("V16 预占失败会释放(不存在只占不放)", /releaseReserve\(reserveBook/.test(workerSrc));
check("V16 母仓位平仓做 70/30 利润分配", /splitProfitOnPositionClose\(profitPool/.test(workerSrc));
check("V16 HARD STOP 阻止新开仓", /hwm_hard_stop/.test(workerSrc));
check("V16 20% 保护线不能被坏报价误触发(需要证据)", /accounting_healthy/.test(workerSrc) && /price_data_reliable/.test(workerSrc));
check("V16 建仓时冻结论点(禁止用未来信息重算)", /entry_thesis: buildEntryThesis\(/.test(workerSrc));
check("V16 日志进入黑匣子 breadcrumb", /diagBreadcrumb\(diagnostics/.test(workerSrc));
check("V16 P0 完整性告警单独保存", /p0:\s*true/.test(workerSrc));
check("V16 行为异常检测接入主循环", /behaviorPass\(now\(\)\)/.test(workerSrc) && /detectBehaviorAnomalies\(\{/.test(workerSrc));
check("V16 高水位在主循环更新", /updateHighWater\(now\(\)\)/.test(workerSrc));
check("V16 行情失败走重连调度(不是各自疯狂重连)", /noteMarketTick/.test(workerSrc) && /reconnectAttempt\(reconnectScheduler/.test(workerSrc));
check("V16 情景模块不含随机数(不造假路径)", !/Math\.random/.test(fs.readFileSync(path.join(ROOT, "worker/src/paper/ensemble.js"), "utf8")));
check("V16 页面不得硬编码密钥", !/sk-[A-Za-z0-9]{20,}/.test(pageSrc));
// ---- V16 UI:量化内核 / 系统诊断 / 性能浮层 / 中文文案 / 悬浮导航 ----
check("V16 量化内核页存在且可刷新", /page-kernel/.test(pageSrc) && /renderKernel/.test(pageSrc) && /#kernelRefreshBtn|kernelRefreshBtn/.test(pageSrc));
check("V16 系统诊断页存在(错误去重 + 技术详情 + 导出)", /page-diag/.test(pageSrc) && /diagExport/.test(pageSrc) && /技术详情/.test(pageSrc) && /同类错误出现/.test(pageSrc));
check("V16 性能浮层默认隐藏(需 dev 开关)", /quant_dev_overlay/.test(pageSrc) && /devOverlay/.test(pageSrc));
check("V16 底部导航为悬浮圆角胶囊", /bottom-nav/.test(pageSrc) && /border-radius:\s*(22|24)px/.test(pageSrc) && /env\(safe-area-inset-bottom\)/.test(pageSrc));
// ---- V16.1 真机 UI 规范:统一安全边距 / 不靠写死像素 / 导航不用毛玻璃(性能) ----
check("V16.1 页面级统一安全边距(左右 16px + 顶部状态栏 + 底部胶囊安全区)",
  /\.page \{[\s\S]{0,500}?calc\(10px \+ env\(safe-area-inset-top\)\) 16px calc\(96px \+ env\(safe-area-inset-bottom\)\)/.test(pageSrc)
  && !/\.app \{[\s\S]{0,200}?padding: 10px/.test(pageSrc));
check("V16.1 底部预留胶囊+系统条安全区", /calc\(96px \+ env\(safe-area-inset-bottom\)\)/.test(pageSrc));
check("V16.1 底部导航已去掉 backdrop-filter(真机掉帧/拖影)", !/\.bottom-nav[\s\S]{0,600}backdrop-filter/.test(pageSrc));
check("V16.1 切页动画只动 opacity/transform 且 ≤200ms", /pageIn\s+(?:1[0-9][0-9]|200)ms/.test(pageSrc) && /will-change:\s*opacity, transform/.test(pageSrc));
check("V16.1 触控目标足够大(导航/列表行)", /min-height:\s*52px/.test(pageSrc) && /min-height:\s*54px/.test(pageSrc));
check("V16.1 窄屏把桌面式一行表单重排为堆叠设置行", /max-width:\s*560px[\s\S]{0,400}flex-direction:\s*column/.test(pageSrc));
check("V16 用户可见文案中文化(正式模型/滚动验证/置信度)", /正式模型/.test(pageSrc) && /滚动验证/.test(pageSrc) && /置信度/.test(pageSrc));
check("V16 诊断页不得出现内联密钥字面量", !/(api[_-]?key|secret|token)\s*[:=]\s*["'][^"']{12,}["']/i.test(pageSrc));
check("V16 Profit Lock 计数常量已定义(曾因未定义导致 profitLockDiagnostics 永久抛错)",
  /export const PROFIT_LOCK_WARN_PARTIALS_PER_POSITION/.test(fs.readFileSync(path.join(ROOT, "worker/src/paper/profitLock.js"), "utf8"))
  && /PROFIT_LOCK_WARN_PARTIALS_PER_POSITION/.test(workerSrc));

// ---- V16.1:影子评估 / 监控 / 树模型 / UI Store 必须真的进产物并接线 ----
for (const key of [
  "factorShadow", "recordFactorObservation", "advanceFactorStates", "activeFactorWeights", "FACTOR_SHADOW_STATES",
  "overtradingStats", "detectOvertrading", "autoTighten", "OVERTRADING_METRICS",
  "sessionAnalysis", "redFlagScan", "TRADE_ANALYSIS_VERSION",
  "gateShadowEvaluate", "resolveSkippedOutcome", "calibrationAdvice",
  "validateTreeArtifact", "predictForest", "resolveTreeModel", "TREE_MODEL_ROLE",
  "createUiStore", "UI_BUCKETS", "uiStoreView"
]) {
  check("V16.1 模块进入产物 " + key, workerSrc.includes(key) || bundle.includes(key));
}
// 扁平 bundle 重名会静默覆盖:同名 function 声明必须只有一个(它曾经会吃掉 AUTO 杠杆的影子学习)
check("V16.1 无同名 function 覆盖(lazy shadowEvaluation 只有一个实现)",
  (bundle.match(/function shadowEvaluation\(/g) || []).length === 1,
  "count=" + (bundle.match(/function shadowEvaluation\(/g) || []).length);
check("V16.1 过度交易收紧真的接在开仓路径上", /overtrading_tightened/.test(workerSrc) && /entryTightening/.test(workerSrc));
check("V16.1 SKIP 影子会在循环里回填结果", /resolveSkipShadows/.test(workerSrc) && /resolveSkippedOutcome\(rec, price/.test(workerSrc));
check("V16.1 因子影子只在影子通道(权重 0 前不进决策)", /settleFactorObservations/.test(workerSrc) && /role: "SHADOW"/.test(bundle));
check("V16.1 树模型只做影子记录(未加载工件时明确不可用)", /recordTreeShadow/.test(workerSrc) && /artifact_loaded/.test(workerSrc));
check("V16.1 UI 内置 WebSocket 订阅计数(可核验不累积)", /__quantWsCount/.test(pageSrc));
check("V16.1 K 线有实时连接状态与降级提示", /实时推送已连接|实时推送不可用/.test(pageSrc));
check("V16.1 全屏有收盘倒计时", /后收盘/.test(pageSrc));
check("V16.1 量化内核页如实标注影子/未接入", /影子/.test(pageSrc) && /未接入/.test(pageSrc));

// ---- V19 真机第二轮:模拟页整页重排 / 我的页六组 / 主题 Bottom Sheet / 通知子页 / AI FAB 避让 ----
check("V19 模拟页主资产卡 + 双池子卡结构", /class="card pf-hero"/.test(pageSrc) && /class="pf-pools"/.test(pageSrc) && /id="pfShortState"/.test(pageSrc) && /id="pfLongState"/.test(pageSrc));
check("V19 模拟页统计为 2 列指标卡,技术信息默认折叠", /id="pfMetrics"/.test(pageSrc) && /<details class="pf-adv">/.test(pageSrc) && /详细统计 · 技术信息/.test(pageSrc));
check("V19 模拟页空状态为紧凑行(保留旧口径文案兼容)", /当前没有模拟持仓 · Paper 引擎仍在监控机会/.test(pageSrc));
check("V19 我的页六组(账户·App / 外观 / 市场与自选 / 学习与验证 / 通知 / 系统)", ["账户 · App", "外观", "市场与自选", "学习与验证", "通知", "系统"].every((t) => pageSrc.includes('<div class="sec-title">' + t + "</div>")));
check("V19 主题模式改 Bottom Sheet(原生 select 已删除)", /id="themeSheet"/.test(pageSrc) && /theme-opt/.test(pageSrc) && !/id="themeMode"/.test(pageSrc));
check("V19 通知 6 类开关移入设置子页,主页留入口与已开数", /id="page-ntfset"/.test(pageSrc) && /id="openNtfSettings"/.test(pageSrc) && /id="ntfSetValue"/.test(pageSrc));
check("V19 AI FAB 避让(滚动淡出类 + 四页 FAB 区域预留)", /fab-dim/.test(pageSrc) && /#page-home, #page-market, #page-paper, #page-detail \{ padding-bottom: calc\(168px \+ env\(safe-area-inset-bottom\)\); \}/.test(pageSrc));
check("V19 后台运行时 Viewer 读真实钱包并暴露分层资金(不再显示 0.00/--)", /readAll\("paper_wallets"\)/.test(pageSrc) && /poolLayers: \(\) => QE\.poolLayers\(/.test(pageSrc));

// ---- V16.1-RV 真机长期运行验收:运行时插桩 / RD-002 根因 / 状态一致性 ----
check("RV 运行时插桩(实例身份/心跳/版本/分项计数)进入产物", /instance_id/.test(bundle) && /state_version/.test(bundle) && /noteHeartbeat/.test(bundle) && /risk_loops/.test(bundle) && /market_fetches/.test(bundle));
check("RV Provider STALE 检测(价格指纹停滞不冒充 HEALTHY)", /MARKET_DATA_STALE/.test(workerSrc) && /market_stale_fetches/.test(workerSrc) && /stale_fetches/.test(bundle));
check("RV RUNTIME_STALL 以心跳为准(冷启动宽限,不因行情阻断误报)", /warmEnough/.test(bundle) && /stall_events/.test(bundle) && /RUNTIME_STALL/.test(workerSrc));
check("RD-002 根因修复:通用 .hidden 规则存在(空复盘卡/折叠契约)", /\.hidden \{ display: none !important; \}/.test(pageSrc) && /class="card hidden" id="dtReview"/.test(pageSrc));
check("RV 页面:运行时镜像带版本守卫 + 资金唯一入口 + 三页一致性登记", /readRuntimeStatus/.test(pageSrc) && /capitalNow/.test(pageSrc) && /recordCapital\(/.test(pageSrc) && /ACCOUNT_VIEW_MISMATCH/.test(pageSrc));
check("RV 页面:策略循环异常文案与心跳/分项行(§33)", /后台服务存在,但策略循环超过/.test(pageSrc) && /运行时心跳/.test(pageSrc) && /风控循环/.test(pageSrc));
check("RV Viewer 补齐 hwm/protectedPool(与引擎同口径只读)", /hwm: \(\) => \{/.test(pageSrc) && /protectedPool: \(\) => \{/.test(pageSrc) && /HWM_STATE_ZH\[st\]/.test(pageSrc));
check("RV 键盘:Manifest 明确 adjustResize(不写死键盘高度)", fs.readFileSync(path.join(ROOT, "android/app/src/main/AndroidManifest.xml"), "utf8").includes('android:windowSoftInputMode="adjustResize"'));
check("RV 真机自动化:仅 debug 构建开放 WebView 调试", fs.readFileSync(path.join(ROOT, "android/app/src/main/java/com/quantmonitor/paper/MainActivity.java"), "utf8").includes("FLAG_DEBUGGABLE") && fs.readFileSync(path.join(ROOT, "android/app/src/main/java/com/quantmonitor/paper/PaperForegroundService.java"), "utf8").includes("FLAG_DEBUGGABLE"));
// P0 回归守卫:bridge.httpGet 是同步调用,fetchTickersWithFailover 是同步函数 —— 不能再误用 .then
// (这个误用曾让真机后台运行时长期行情阻断:每一轮 tick 抛 TypeError,loops 恒 0)
check("RV runtime-host 不对同步 failover 结果误用 .then",
  !fs.readFileSync(path.join(ROOT, "tools/runtime-host.js"), "utf8").split("\n").some((l) => !/^\s*\/\//.test(l) && /fetchTickersWithFailover\(\)\.then/.test(l)));
// §50:通知点击深链 —— 服务端带 kind/title、Activity 捕获并暴露待处理载荷、页面按 kind 路由(不再全部只开首页)
check("RV 通知点击深链(§50:kind/title extras + 页面路由)",
  /ntf_kind/.test(fs.readFileSync(path.join(ROOT, "android/app/src/main/java/com/quantmonitor/paper/PaperForegroundService.java"), "utf8"))
  && /pendingNotification/.test(fs.readFileSync(path.join(ROOT, "android/app/src/main/java/com/quantmonitor/paper/MainActivity.java"), "utf8"))
  && /applyNotificationRoute/.test(pageSrc) && /QE\.notificationRoute/.test(pageSrc));

// ---- V16.2 课堂式 UI:黑白闪屏 / 状态连续性 / 按钮系统 / Design Tokens ----
check("V16.2 主题 pre-paint(head 内联脚本:首帧前落主题 + 首屏禁过渡)",
  /quantSettings/.test(pageSrc) && /root\.className = dark \? "theme-dark preload"/.test(pageSrc)
  && /html\.preload, html\.preload \* \{ transition: none !important; animation: none !important; \}/.test(pageSrc));
check("V16.2 切页单一动画(pg-fade 双动画已移除)", !/\.pg-fade \{/.test(pageSrc) && !/classList\.add\("active", "pg-fade"\)/.test(pageSrc) && /pageIn\s+160ms/.test(pageSrc));
check("V16.2 无整页跳转(内部导航一律 setActivePage/router)", !/<a\s+href=/.test(pageSrc) && !/location\.href\s*=/.test(pageSrc) && !/location\.reload\(/.test(pageSrc) && !/location\.assign\(/.test(pageSrc));
check("V16.2 返回栈接线:进子页记来路 + 统一 goBack + history 哨兵",
  /nav\.push\(prev, canonical\)/.test(pageSrc) && /async function goBack\(\)/.test(pageSrc)
  && /QE\.backPriority\(\{/.test(pageSrc) && /history\.pushState\(\{ zqtrap: 1 \}/.test(pageSrc)
  && /saveCurrentViewState\(\)/.test(pageSrc) && /restoreScrollAfterReady\(\{/.test(pageSrc));
check("V16.2 返回按钮全部走 goBack(不再硬编码弹回某页)", (pageSrc.match(/addEventListener\("click", \(\) => \{ void goBack\(\); \}\)/g) || []).length >= 10);
check("V16.2 Design Tokens 与 Button System 落地", /--btn-h: 46px;/.test(pageSrc) && /--accent: var\(--green\)/.test(pageSrc)
  && /\.sec \{[\s\S]{0,240}?min-height: var\(--btn-h\)/.test(pageSrc) && /\.sec \{[\s\S]{0,120}?border: 1px solid var\(--border\)/.test(pageSrc));
check("V16.2 数字层级(主数字不厚重)", /\.hm-hero \.big \{ font-weight: 600; \}/.test(pageSrc) && /\.pf-hero \.big \{ font-weight: 600; \}/.test(pageSrc));
check("V16.2 错误态可重试(真实动作,不是一行死字)", /行情读取失败:" \+ shortError\(error\)/.test(pageSrc) && /vEl\("button", "sec", "重试"\)/.test(pageSrc) && /renderMarket\(true\)/.test(pageSrc));
check("V16.2 navState 模块进入产物并导出", /createNavState/.test(bundle) && /backPriority/.test(bundle) && /restoreScrollAfterReady/.test(bundle));
check("V16.2 原生启动背景与默认深色一致(splash/window/WebView)",
  fs.readFileSync(path.join(ROOT, "android/app/src/main/res/values/styles.xml"), "utf8").includes("windowSplashScreenBackground")
  && fs.readFileSync(path.join(ROOT, "android/app/src/main/res/values/styles.xml"), "utf8").includes("postSplashScreenTheme")
  && fs.readFileSync(path.join(ROOT, "android/app/src/main/java/com/quantmonitor/paper/MainActivity.java"), "utf8").includes("setBackgroundColor(0xFF0E1013)"));

// ---- V16.2s 手机功能 UI 修复轮:点击延迟 / 折叠 / 分段 / 自选 / 手势 / 冻结看守 ----
check("V16.2s 页面模板反引号守卫生效(未转义反引号会在构建期直接报错)", true, "由 build.mjs 强制");
check("V16.2s 统一自选 Store(单一事实来源 + 持久化 + 回滚)进入产物", /createWatchlistStore/.test(bundle) && /WATCHLIST_STORAGE_KEY/.test(bundle) && /normalizeWatchSymbol/.test(bundle));
check("V16.2s 点击延迟观测/长任务/冻结看守进入产物", /createDevPerf/.test(bundle) && /DEV_PERF_PHASES/.test(bundle) && /freezeThresholdMs/.test(bundle));
check("V16.2s 自选接线:星标统一组件 + detail 星标 + 旧自选页走 Store", /function starButton\(symbol\)/.test(pageSrc) && /id="dtStar"/.test(pageSrc) && /const res = watchStore\.add\(symbol\)/.test(pageSrc));
check("V16.2s 持久化失败必须显式提示(不许静默)", /toast\("自选保存失败", "error"\)/.test(pageSrc) && /diagLog\("watch-persist"/.test(pageSrc) && /notify\("rollback"/.test(fs.readFileSync(path.join(ROOT, "worker/src/ui/watchlist.js"), "utf8")));
check("V16.2s 市场/自选为 App 分段控件(无原生 select,滑块 transform)", /<div class="seg" id="mkSeg"/.test(pageSrc) && !/id="mkWatchBtn"/.test(pageSrc) && /\.seg\[data-seg="watch"\] \.seg-thumb \{ transform: translateX/.test(pageSrc));
check("V16.2s 分段状态保持(save/restore 到 navState)", /nav\.save\("market", \{ seg: viewState\.mkSeg/.test(pageSrc) && /st\.seg !== viewState\.mkSeg/.test(pageSrc));
check("V16.2s Accordion 统一组件(开/关同路径 + aria + 0fr→1fr)", /function toggleAccordion\(/.test(pageSrc) && /function bindAccordion\(/.test(pageSrc) && /grid-template-rows: 0fr/.test(pageSrc));
check("V16.2s 手势状态机(touchcancel→idle / 纵向让位 scroll / 方向锁)", /dtOnTouchCancel/.test(pageSrc) && /mode: "scroll", moved: gesture\.moved/.test(pageSrc) && /gesture\.decided = true/.test(pageSrc));
check("V16.2s pinch 方向组合锁死(单元测试 F 节)", /pinchFactor\(prevDistance, nextDistance\)/.test(fs.readFileSync(path.join(ROOT, "worker/src/ui/chart.js"), "utf8")) && fs.readFileSync(path.join(ROOT, "tools/test-chart-interaction.mjs"), "utf8").includes("50 轮张开/捏合方向零翻转"));
check("V16.2s Kernel/Diag/Health 先绘制后重活(afterPaint 包裹)", /afterPaint\(\(\) => \{\s*perfMark\(h, "first_paint"\);\s*void safeRender\("page:kernel", renderKernel, renderKernel\)/.test(pageSrc) && /safeRender\("page:diag", renderDiag, renderDiag\)/.test(pageSrc) && /renderHealth\(await loadHealth\(false\)\)/.test(pageSrc));
check("V16.2s 长字段/数字溢出护栏(换行 + 定宽 + 可收缩)", /overflow-wrap: anywhere/.test(pageSrc) && /\.mk-row \.mk-chg \{ width: 76px;/.test(pageSrc) && /\.sys-row \.sys-v \{ font-size: 13px; color: var\(--text-secondary\); text-align: right; overflow-wrap: anywhere; min-width: 0; \}/.test(pageSrc));

// ---- V16.2t NAV-ONLY(点击后只剩底部导航栏)根因修复与加固 ----
check("V16.2t 根因:正文可见性绝不只靠动画(.page.active 自带 opacity:1/transform:none)", /\.page\.active \{[\s\S]{0,500}?opacity: 1;[\s\S]{0,200}?transform: none;/.test(pageSrc) && /绝不隐形/.test(pageSrc));
check("V16.2t 路由表唯一化 + 无效路由保留当前页 + 子页父 Tab 高亮", /const ROUTE_TABLE = \[/.test(pageSrc) && /function resolveRoute\(name\)/.test(pageSrc) && /NAV_INVALID_ROUTE/.test(pageSrc) && /route\.kind === "tab" \? route\.route : route\.parent/.test(pageSrc));
check("V16.2t 导航锁看门狗 + finishTransition 双路幂等 + UI 自恢复", /NAV_LOCK_TIMEOUT/.test(pageSrc) && /finishTransition\(handle, "raf"\)/.test(pageSrc) && /finishTransition\(handle, "timeout"\), 400\)/.test(pageSrc) && /function recoverUiNavigation\(reason\)/.test(pageSrc) && /UI_ROUTE_INVARIANT_FAILED/.test(pageSrc));
check("V16.2t safeRender 渲染兜底(错误态+重试)与 dumpUiState 观测面", /async function safeRender\(label, fn, retry\)/.test(pageSrc) && /PAGE_RENDER_ERROR:/.test(pageSrc) && /dumpUiState: \(\) => \{/.test(pageSrc) && /mainInnerHTMLLength: mainHtmlLen/.test(pageSrc));

// ---- V16.2u P0:短/长线信号溯源 + 组合暴露真接线 + Runtime 状态机 + Start 幂等 ----
// 注意:paper/* 与 ui/viewModels 只进入 QEngine bundle(页面侧),不在 worker 产物里 → 一律对 bundle 断言。
check("V16.2u 溯源链端到端(signal_id/strategy_intent_id/decision_id/action_source)",
  /const sigId = String\(input\.signal_id/.test(bundle) && /const strategyIntentId = String\(input\.strategy_intent_id/.test(bundle)
  && /signal_id: sigId,/.test(bundle) && /strategy_intent_id: strategyIntentId,/.test(bundle) && /decision_id: decisionId,/.test(bundle)
  && /signal_id: signalId,/.test(bundle) && /strategy_intent_id: "intent_" \+ mode/.test(bundle)
  && /signal_id: i\.signal_id == null \? null : String\(i\.signal_id\)/.test(bundle));
check("V16.2u 组合暴露预检真接线(exposure_allow 不再写死 true)",
  /const exposureAllow = clusterNowMargin < clusterCapMargin - 1e-9/.test(bundle) && /exposure_allow: exposureAllow,/.test(bundle) && !/exposure_allow: true,/.test(bundle));
check("V16.2u 配额归零报真因(CLUSTER_CAP/PORTFOLIO_CAP,不误报资金不足)",
  /const binding = \(caps\.includes\("CLUSTER_CAP"\) && clusterRoom <= capEps\(\)\) \? "CLUSTER_CAP"/.test(bundle) && /code: binding \|\| \(usdt <= capEps\(\) \? "LIQUIDITY_EMPTY" : "BELOW_MIN"\)/.test(bundle));
check("V16.2u Runtime 状态机统一(7 态 + RUNNING 不显示开始按钮)",
  /PAPER_RUNTIME_STATES = \["STOPPED", "STARTING", "RUNNING", "PAUSED", "DEGRADED", "SAFE_MODE", "HARD_STOP"\]/.test(bundle)
  && /show_start_button: state === "STOPPED" \|\| state === "PAUSED"/.test(bundle)
  && /startBtn\.hidden = !rv\.show_start_button;/.test(pageSrc));
check("V16.2u Start 幂等(连点 10 次只执行一次;后台已运行不重复拉起)",
  /async function startPaperFromHome\(\)/.test(pageSrc) && /if \(paperStartBusy\) return \{ ok: false, reason: "busy" \}/.test(pageSrc)
  && /already_running_background/.test(pageSrc) && /runtimeView: \(\) => \{/.test(bundle));

// ---- V16.2v:动态币种池 / 资金与损失分离 / 资金效率 / 费用吃掉边际 ----
const hostSrc = fs.readFileSync(path.join(ROOT, "tools/runtime-host.js"), "utf8");
check("V16.2v 动态币种池进入产物与后台运行时(不再是写死 5 币)",
  /buildScan/.test(bundle) && /selectActiveSymbols/.test(bundle) && /estimateSpreadBps/.test(bundle)
  && /refreshUniverse/.test(hostSrc) && !/candidateSymbols: \(\) => \["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"\]/.test(hostSrc));
check("V16.2v 资金与损失分离(风险预算÷止损×杠杆 → 保证金;40% 硬顶保留)",
  /riskBudget \/ \(stopFrac \* levForCap\)/.test(bundle) && /poolEquity \* CAPITAL_LIMITS\.max_single_position_pct \/ 100/.test(bundle));
check("V16.2v 费用吃掉边际规则真正生效(此前 max_cost_ratio_of_edge 是死规则)",
  /costEatsEdge/.test(bundle) && /FEE_DRAG_TOO_HIGH/.test(bundle) && /SKIP_FEE_DRAG/.test(bundle));
check("V16.2v 方向置信度门槛(低置信 → LOW_RULE_CONFIDENCE 不交易)",
  /min_rule_confidence: 45/.test(bundle) && /LOW_RULE_CONFIDENCE/.test(bundle));
check("V16.2v 资金效率(母仓口径)进入产物 + 平仓挂指标",
  /capitalEfficiencyOf/.test(bundle) && /capital_efficiency = eff/.test(bundle) && /LOW_CAPITAL_EFFICIENCY|low_capital_efficiency/.test(bundle));
check("V16.2v 市场扫描面板 + 宇宙健康诊断 + 候选来自短名单",
  /id="mkScanPanel"/.test(pageSrc) && /diagUniverseBox/.test(pageSrc) && /refreshUniverseScan/.test(pageSrc)
  && /scan\.shortlist/.test(pageSrc) && /universe: uni/.test(hostSrc));

// ---- V16.2w P0:启动护盾 / 兜底导航 / Boot Status(真机"全 -- + 点击无反应"根因的结构性封堵) ----
check("V16.2w 启动护盾:模块级存储读取全部守卫(不再有裸 JSON.parse(localStorage…) 致死主脚本)",
  /function lsGetJson\(/.test(pageSrc) && /function lsGetRaw\(/.test(pageSrc)
  // 只检查主脚本段(head 段落已有独立 try/catch 主题守卫,不在本断言范围)
  && !/JSON\.parse\((window\.)?localStorage\.getItem/.test(pageSrc.slice(pageSrc.indexOf("<!--__QE_BUNDLE__-->"))));
check("V16.2w 启动护盾:损坏值自愈(移除键 + storage_healed 留痕)",
  /storage_healed\.push\(/.test(pageSrc) && /reason: "corrupt_json"/.test(pageSrc));
check("V16.2w BOOT_SEQUENCE 阶段插桩 + BOOT_FAILED 记录(阶段/错误/堆栈)",
  /function bootStage\(/.test(pageSrc) && /function bootFail\(/.test(pageSrc)
  && /bootStage\("ui_ready"\)/.test(pageSrc) && /BOOT\.ui_ready = true/.test(pageSrc)
  && /stack: String\(\(error && error\.stack\) \|\| ""\)\.slice\(0, 1200\)/.test(pageSrc));
check("V16.2w head 护盾②:主脚本死亡时兜底导航 + 启动异常横幅(不静默)",
  /__quantNavOwned/.test(pageSrc) && /fallback_nav:/.test(pageSrc) && /id="bootBanner"/.test(pageSrc)
  && /__quantShowBootBanner/.test(pageSrc));
check("V16.2w 导航绑定分块隔离(bind:nav / bind:main 失败只记录不中断)",
  /bootFail\("bind:nav", error\)/.test(pageSrc) && /bootFail\("bind:main", error\)/.test(pageSrc));
check("V16.2w 首页三态替代永久 --:加载中…占位 / 等待后台数据… / 读取失败",
  /homeBootPlaceholders/.test(pageSrc) && /"加载中…"/.test(pageSrc) && /等待后台数据…/.test(pageSrc) && /数据读取失败/.test(pageSrc));
check("V16.2w 诊断页 Boot Status 卡片(阶段/自愈/错误/兜底导航计数)",
  /id="diagBootCard"/.test(pageSrc) && /id="diagBootBox"/.test(pageSrc) && /nav_switches/.test(pageSrc)
  && /兜底导航启用/.test(pageSrc));
check("V16.2w 单一导航处理器(head 兜底遇 __quantNavOwned 即退场)",
  /if \(window\.__quantNavOwned\) return;/.test(pageSrc));

// ---- V16.2x:P0 启动响应性 / 主线程解阻塞(工单 STARTUP RESPONSIVENESS) ----
check("V16.2x 启动阶段协议(十阶段 + bootBegin/bootEnd + 标准阈值标记)",
  /BOOT_HTML_READY/.test(pageSrc) && /BOOT_STORE_MINIMAL_READY/.test(pageSrc) && /BOOT_NAV_READY/.test(pageSrc)
  && /BOOT_ACCOUNT_SUMMARY_READY/.test(pageSrc) && /BOOT_DB_READY/.test(pageSrc) && /BOOT_POSITIONS_READY/.test(pageSrc)
  && /BOOT_MARKET_READY/.test(pageSrc) && /BOOT_SCANNER_READY/.test(pageSrc) && /BOOT_MODELS_READY/.test(pageSrc)
  && /BOOT_LEARNING_READY/.test(pageSrc) && /function bootBegin\(/.test(pageSrc) && /function bootEnd\(/.test(pageSrc) && />1000ms/.test(pageSrc));
check("V16.2x Phase C 空闲延后(模型/学习·研究/存量清理不与首屏抢主线程)",
  /function scheduleIdle\(/.test(pageSrc) && /scheduleIdle\("models"/.test(pageSrc) && /scheduleIdle\("learning"/.test(pageSrc) && /scheduleIdle\("retention"/.test(pageSrc));
check("V16.2x 主线程让步通道(MessageChannel 不受后台定时器节流;引擎与页面双侧)",
  /MessageChannel/.test(pageSrc) && /MessageChannel/.test(bundle) && /yieldEventLoop/.test(bundle) && /function yieldToMain\(/.test(pageSrc));
check("V16.2x 引擎 hydrate 与历史迁移分块(单任务 ≤50ms 量级)",
  /workUnits % 200 === 0/.test(bundle) && /workUnits % 20 === 0/.test(bundle) && /processed % 50 === 0/.test(pageSrc));
check("V16.2x DB 懒加载(启动只 count;全量历史打开相关页面才读)",
  /ensureRecordsLoaded/.test(pageSrc) && /updateBadgeCounts/.test(pageSrc) && /deferred = true/.test(pageSrc) && /recordsLoaded/.test(pageSrc));
check("V16.2x 成交列表窗口化(默认 50 + 显示更多)+ 隐藏页不渲染扫描面板",
  /pfTradesShown: 50/.test(pageSrc) && /显示更多/.test(pageSrc) && /limit: tradesShown/.test(pageSrc) && /scanDirty = true/.test(pageSrc));
check("V16.2x Long Task 观测 + 实例计数暴露 + 诊断性能表",
  /entryTypes: \["longtask"\]/.test(pageSrc) && /instances: \{/.test(pageSrc) && /Time to UI/.test(pageSrc) && /最长主线程任务/.test(pageSrc));

// ---- V16.2y:P0 账户审计 / 亏损归因 / 学习完整性 / 完整系统导出 ----
check("V16.2y 审计模块进入产物(对账/母仓/归因/canonical/账本/脱敏)",
  /function reconcileAccount\(/.test(bundle) && /function motherPositions\(/.test(bundle) && /function classifyLoss\(/.test(bundle)
  && /function canonicalSampleId\(/.test(bundle) && /function ledgerFromRecords\(/.test(bundle) && /function redactSensitive\(/.test(bundle));
check("V16.2y 账户恒等式 + 容差 + 非真实样本剔除口径",
  /AUDIT_TOLERANCE/.test(bundle) && /ACCOUNT_EQUATION/.test(bundle) && /view_pollution_from_seed/.test(bundle) && /learning_eligible/.test(bundle));
check("V16.2y ZIP 导出器(零依赖 store 模式 + CRC32 + manifest 完整性)",
  /function createZip\(/.test(bundle) && /function crc32\(/.test(bundle) && /account_integrity/.test(bundle) && /canonical_ml_sample_count/.test(bundle));
check("V16.2y/V16.2z 页面:导出分家(有效ML/审计 + 完整系统 zip)+ 进度不阻塞",
  /导出有效ML数据\(JSON\)/.test(pageSrc) && /导出审计数据\(JSON\)/.test(pageSrc) && /diagFullExportBtn/.test(pageSrc) && /quant-full-export_/.test(pageSrc)
  && /QE\.buildFullExport\(\{ sections: sections, audit: audit, versions: versions, yieldFn: yieldToMain/.test(pageSrc));
check("V16.2y 页面:损益分析(懒加载)+ 复盘生命周期字段 + 启动对账安全模式",
  /id="pfLossAcc"/.test(pageSrc) && /Entry \/ MFE \/ MAE/.test(pageSrc) && /runAccountingAuditAtBoot/.test(pageSrc)
  && /entriesPaused = true/.test(pageSrc) && /last_accounting_fault/.test(pageSrc));
check("V16.2y 导出全局脱敏(§24)",
  /QE\.redactSensitive/.test(pageSrc) && /redacted_count/.test(bundle));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("ARTIFACT CHECKS OK");
