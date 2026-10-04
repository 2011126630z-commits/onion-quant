# HANDOFF · onion-quant(更新: 2026-10-04 夜)

> 跨轮上下文接力文件(规范 §2)。聊天历史不承担长期记忆。

## 已完成(近三轮)

- **V16.2t(P0 NAV-ONLY)**:点击后只剩底部导航栏 → 真根因 = `.page.active` 可见性完全依赖 160ms 入场动画;
  修复为 `.page.active { opacity:1; transform:none }`(动画仅装饰)+ 路由表/导航看门狗/`safeRender`/自恢复/`dumpUiState`/故障注入;
  500 轮 + 200 乱点 + 8 类故障注入零复现。Release `v16.2t` 已发(commit d45f38b)。
- **V16.2s 三轮**:点击延迟(先绘制后重活/Shell 先行/返回不等网络)、折叠 Accordion、市场↔自选分段控件、
  统一自选 Store、四档宽度零溢出、pinch 方向/锚点双根因、手势状态机与冻结看守。Release `v16.2s`。
- **V16.2u(本轮 P0,按 70 条规范)**:
  1) **短/长线重复信号**:查清 = A(两个独立策略:short=1h / long=4h 各自分析,幂等键含 mode,非同一信号重复执行);
     落地**全链路溯源** `signal_id`/`strategy_intent_id`/`decision_id`/`position_id`/`action_source`
     (引擎确定性派生 → 仓位/订单/决策日志全带;runtime 候选自带);
  2) **组合暴露真接线**:`exposure_allow` 不再写死 true —— 同向阵营/组合保证金余量归零时 Entry Gate 直接
     `EXPOSURE_CAP`(正式 NO_TRADE+影子);跨池同币同向计入同一阵营(相关度加权);
     配额归零不再误报 `LIQUIDITY_EMPTY`,报真因 CLUSTER_CAP/PORTFOLIO_CAP;
  3) **Runtime 状态机统一**:`PAPER_RUNTIME_STATES` 7 态(STOPPED/STARTING/RUNNING/PAUSED/DEGRADED/SAFE_MODE/HARD_STOP),
     首页标签与按钮**同源**;RUNNING/DEGRADED/SAFE_MODE/HARD_STOP 时开始按钮**隐藏**;PAUSED 显示"继续模拟";
  4) **Start 幂等**:`startPaperFromHome/pausePaperFromHome` + `paperStartBusy` 防抖;后台服务 RUNNING 时前台不重复拉起;
     沙箱实测 10 连点 → 引擎实例 1、Loop 只登记 1 个。

## 当前状态

- 基线:**43 套件 / 4096 断言 / 0 失败**(`node tools/run-tests.mjs`);check-artifacts **269** 守卫。
- 新增套件:`tools/test-p0-runtime-guards.mjs`(34 断言)。
- 真机:不在(adb 无设备)→ 本轮真机项 **NOT VERIFIED**(浏览器/沙箱已验证)。

## 未完成 / 下一步(按 70 条规范优先级)

- **P0 余项复核**:Ledger/Reservation/Partial 幂等/HWM/DQ/Learning 污染 —— 已有测试覆盖
  (test-v16-capital 309 / test-profit-lock 170 / test-attribution 48 / test-clean-analytics 50 / test-runtime-verify 62),
  本轮未发现新缺口;真机现场复核仍待手机。
- **P1**:后台真实持续运行(锁屏 10/30/60min 实测)、Market Data 一致性(WS+REST 去重/乱序/回补)、
  Portfolio Risk 动态相关性、Dynamic Universe 漏斗(20~50→5~10)。
- **P2**:Factor Factory 扩展、LightGBM/RF 基准、Kronos Challenger(PC 先跑 Walk Forward/Shadow)、Ensemble/Meta Model、Research Factory(Research Run Card)。
- **P3**:UI 收尾(量化内核分组视图/诊断中心/K线 Position Review/性能细化)。
- **运维**:真机"只剩导航栏"原始场景复现(用 `__quantUI.dumpUiState()` 取证;看门狗 200ms 自愈);
  快速乱点下 `ACCOUNT_VIEW_MISMATCH` 对账日志降噪;RD-002(详情页空块)台账未关。

## 关键文件

- `worker/src/paper/engine.js`(开仓闸门/溯源/暴露预检/runtimeView)、`runtime.js`(候选+signal_id)、
  `capitalAllocator.js`(配额/预占/暴露)、`decisionJournal.js`(溯源留档)、`entryQuality.js`(EXPOSURE_CAP)。
- `worker/src/ui/page.js`(首页呈现态/幂等 Start/NAV-ONLY 加固)、`viewModels.js`(paperRuntimeView)。
- 验收:`tools/test-p0-runtime-guards.mjs`、`tools/test-nav-stress.mjs`、`tools/check-artifacts.mjs`。

## 已知风险

- 真机行为(NOT VERIFIED):锁屏/Doze/断网/重启/软键盘/深链;冻结看守与 dumpUiState 已就位。
- 相关性守卫较保守(相关度加权 2×,同阵营同向 ≈1.6 仓即触顶)——若实盘体感过紧,调
  `CAPITAL_LIMITS.corr_penalty_weight` 或分项上限即可(有测试护栏)。
- 无真实资金通道(合规设计:PAPER_ONLY;Exchange Adapter 只允许行情读取层与禁用占位)。
