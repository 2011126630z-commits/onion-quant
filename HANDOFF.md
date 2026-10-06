# HANDOFF · onion-quant(更新: 2026-10-05)

> 跨轮上下文接力文件(规范 §2)。聊天历史不承担长期记忆。

## 已完成(近七轮)

- **V16.2y(本轮)**:P0 账户审计 + 完整系统导出 + 学习数据完整性 —— ①真实账户归因:**权威净亏 -0.5273U**(100.0000→99.4727,
  恒等式差 0;UI 旧的"-2.32"里 ~1.8U 是上轮压测 seed 污染,已剔除并单列 view_pollution_from_seed);12 真实母仓(2 盈 10 亏):
  毛 -0.4613/费 0.0622/净 -0.5236,全部 stop_loss 出场,**Profit→Loss 10/10 次(错过 0.6578U)**——亏损结构=退出策略让回浮盈;
  费拖 13.49%;重复开仓/跨池同信号 = 0;口径差 0.0037U 如实披露(容差内,未触发安全模式)。
  ②新模块 `accountAudit.js`(对账+容差+ACCOUNTING_MISMATCH、母仓全字段行、纯规则亏损标签、P2L、蚂蚁仓分桶、重复扫描、
  canonical_sample_id 折叠 411→20、派生 Ledger+现金闭合校验、脱敏)+ `exportBundle.js`(零依赖 ZIP/CRC32/分块序列化/manifest 完整性/进度)。
  ③UI:模拟页"损益分析"卡、复盘补全生命周期字段、学习页与诊断页导出按钮分家、**启动即对账→不一致自动 PAUSE_NEW_ENTRIES+fault_id(绝不重置账户)**。
  ④实测导出:23 文件/13.9MB/完整性 PASS/脱敏 3 字段/导出期连点 7/7 即时、最长任务 88-93ms。
  基线 **46 套件 / 4276 断言 / 0 失败**;Release `v16.2y`;真机 **NOT VERIFIED**(无设备)。
  待办见 V16.2Y 报告"NOT CHANGED":写入侧 Frozen Snapshot、引擎原生逐事件 Ledger、**loop 分析→dataset 主链路(SOL 有成交 0 真实信号)**。
- **V16.2x**:P0 启动响应性 / 主线程解阻塞 —— 真机"启动后长时间无法点击"。
  ①根因:`engine.integrityRepair` 对 2000 学习样本逐条 `trades.find()` = **O(样本×成交) ≈ 680 万次比较的单一大任务**
  (桌面 254-309ms,真机按 CPU 系数放大即"几秒不能点");次因:启动即全量读库(joined 4000,198-239ms)、
  retention 全表读取仅用于计数(431-522ms)、**setTimeout 让步在隐藏 WebView 被节流到 ~1s/次**(Android 前台服务永远隐藏)。
  ②修复:Map 索引(O(n+m) 语义不变)、**MessageChannel 让步**(页面+引擎双侧,scheduler.yield→MessageChannel→setTimeout)、
  Phase A/B/C 分层(UI_READY 先于任何行情/模型)、DB 懒加载(count 徽标+打开历史页才读全量)、
  模型/学习·研究/存量清理空闲延后、扫描器市场后链式+批间让步+隐藏页不渲 DOM、成交列表 50 条窗口+显示更多、
  `instances()` 审计、诊断页启动性能表(Time to UI/各阶段/最长任务)。
  ③实测(桌面 Chrome 411,16k 行重库,40 币真扫描):**最长主线程任务 276-309ms → 0(≥50ms 零条)**、
  integrityRepair 300-340→33-35ms、引擎段 596-715→205-227ms、Time to UI 13-49ms、首点切页 2-12ms、实例全 ≤1。
  基线 **45 套件 / 4214 断言 / 0 失败**(device-boot 56 断言含启动响应性段+冷启×10 即时连点;check-artifacts 290 守卫);Release `v16.2x`;**真机 NOT VERIFIED**(无设备)。
- **V16.2w**:P0 真机假死根因修复 —— 真机录屏三症状(首页全 `--` / 点击底部导航无反应 / 永不 hydrate)。
  ①根因:主脚本**模块级**未守卫存储读取(page.js 1832 `quantSettings`、1840 `watchSymbols`、引擎工厂 `deviceId`)
  在"残留非法 JSON(SyntaxError)"或"存储被拒(SecurityError)"时抛死整段脚本 → 导航监听/渲染/定时器全部未注册;
  V16.2t 的"静态可见"修复使首页看着是打开的 → 呈"打开即死"。设备同形沙箱 7 变体矩阵:C/D/F 修复前精确复现,修复后全存活。
  ②修复:存储读取全守卫+自愈(`storage_healed` 留痕)、BOOT_SEQUENCE 阶段插桩 + `BOOT_FAILED{stage,error,stack}`、
  head 护盾②(**主脚本死亡时兜底导航 + 启动异常横幅**,绝不静默)、绑定分块隔离(bind:nav/bind:main)、
  首页三态(加载中…/等待后台数据…/读取失败)+ `hmRisk` 未分析、诊断页 **Boot Status 卡片**。
  基线 **45 套件 / 4176 断言 / 0 失败**;Release `v16.2w`;真机 **NOT VERIFIED**(设备未连)。
- **V16.2v**:动态币种池 + 资金效率 —— ①后台运行时写死 5 币 → 真扫描(40 扫/31 候选/深度 ≤10,
  真实山寨入列;页面市场扫描面板 + 诊断宇宙健康 + host 状态上报 universe);②蚂蚁仓根因修复:
  风险预算不再当保证金(risk_budget÷(止损%×杠杆)),默认参数 100U 下 24.5/12(was 10.5/4.5);
  ③`max_cost_ratio_of_edge` 死规则激活(FEE_DRAG_TOO_HIGH)+ 新增 `LOW_RULE_CONFIDENCE`;
  ④母仓资金效率模块(return_on_margin/fee_drag/LOW_CAPITAL_EFFICIENCY)+ 平仓挂指标;
  ⑤参数一致性校准:单币名义两级(35 提示/100 拦截)、阵营同向=真实保证金 ≤50%、收盘K线【决策时】落记(§27)。
  基线 **44 套件 / 4141 断言 / 0 失败**;Release `v16.2v`。
- **V16.2t**:P0 NAV-ONLY(可见性不再依赖动画)+ 路由表/看门狗/自恢复/故障注入。Release `v16.2t`。
- **V16.2u**:70 条规范首轮 P0:全链路溯源 ID、组合暴露真接线、Runtime 7 态 + Start 幂等。Release `v16.2u`。
- **V16.2s 三轮**:点击延迟/折叠/分段自选/零溢出/pinch 双根因/手势状态机。Release `v16.2s`。

## 当前状态

- 基线:**46 套件 / 4276 断言 / 0 失败**(`node tools/run-tests.mjs`);check-artifacts **296** 守卫。
- 新增测试:`test-account-audit.mjs`(56 断言:对账/恒等式破坏检测/seed 剔除/母仓全字段/标签/P2L/分桶/重复/canonical 折叠/Ledger 闭合/ZIP 结构+CRC/分块序列化/脱敏/页面接线)。另 `test-device-boot.mjs`(56,含启动响应性段)。
- 真机:不在(adb 无设备)→ 真机项 **NOT VERIFIED**;浏览器 411 实测:真实导出 zip 13.9MB/23 文件/完整性 PASS/导出期连点 7/7 即时。
- 设备端复验命令(手机插上后):\`adb devices\` → 装 \`apk/app-latest.apk\` → 模拟页"损益分析"应显示权威净亏(而非含 seed 的 -2.32)→ 诊断页"导出完整系统数据(zip)"应在不冻结 UI 的情况下产出 manifest 完整性 PASS 的 zip。
- 账户审计口径备忘:权威亏损看 **account 恒等式**(当前 -0.5273U);凡"全部成交汇总"视图必须排除 learning_eligible=false 的样本(seed 曾致 UI 显示 -2.32)。

## 未完成 / 下一步(按 70 条规范优先级)

- **P1(建议下一轮)**:①真实盘口源(加 Binance bookTicker/深度代理端点 → 替换 spread/depth 估算);
  ②后台长期运行真机实测(锁屏 10/30/60min + 40 币首轮扫描耗时/内存);
  ③WS+REST 行情一致性(去重/乱序/回补);④动态宇宙与学习样本联动(样本按 universe 分层统计)。
- **P2**:LightGBM/RF 基准、Kronos Challenger(PC 侧 Shadow)、Ensemble/Meta Model 实数据校准、Research Run Card。
- **P3**:UI 收尾(量化内核分组/诊断中心/K线 Position Review)。
- **运维**:快速乱点下 `ACCOUNT_VIEW_MISMATCH` 对账日志降噪;RD-002 未关;Mimosa 复扫(工具覆盖仍 partial,
  **不宣称安全**——SECURITY-NOTES.md)。

## 关键文件

- `worker/src/paper/universeScan.js`(新:扫描纯模块)、`symbolUniverse.js`(硬门槛/分层)、
  `capitalEfficiency.js`(新:母仓资金效率)、`engine.js`(sizing 分离/决策时落记/暴露预检)、
  `capitalAllocator.js`(gross 阵营口径)、`portfolioRisk.js`(两级单币暴露)。
- `tools/runtime-host.js`(真扫描 + universe 状态上报)、`worker/src/ui/page.js`(市场扫描面板/宇宙健康/候选源)。
- 验收:`tools/test-universe-efficiency.mjs`、`tools/test-p0-runtime-guards.mjs`、`tools/check-artifacts.mjs`。

## 已知风险

- spread/depth 为估算(已标注);真实盘口源接入前,门槛偏保守(可能漏掉部分本可交易的中流动性币)。
- 同向阵营上限 50%(真实保证金)—— 若实盘体感过紧,调 `CAPITAL_LIMITS.cluster_same_direction_pct`(有测试护栏)。
- 真机行为(NOT VERIFIED):锁屏/Doze/断网/重启/软键盘/深链;`dumpUiState` + 看门狗已就位可取数。
- PAPER_ONLY 边界不变:禁止真实下单/真实 API Key;Exchange Adapter 仅允许行情读取层与禁用占位。

