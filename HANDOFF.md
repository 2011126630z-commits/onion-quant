# HANDOFF · onion-quant(更新: 2026-10-05)

> 跨轮上下文接力文件(规范 §2)。聊天历史不承担长期记忆。

## 已完成(近六轮)

- **V16.2x(本轮)**:P0 启动响应性 / 主线程解阻塞 —— 真机"启动后长时间无法点击"。
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

- 基线:**45 套件 / 4214 断言 / 0 失败**(`node tools/run-tests.mjs`);check-artifacts **290** 守卫。
- 新增测试:`test-device-boot.mjs`(56 断言:设备桥桩启动/切换/存储自愈/被拒降级/等待态/兜底导航/未捕获错误/幂等/单实例
  + V16.2x 启动响应性段:阶段协议与时序/DB 懒加载/空闲延后/挂起行情导航/全屏遮挡/长任务观察器/冷启×10 即时连点)。
- 真机:不在(adb 无设备)→ 真机项 **NOT VERIFIED**;浏览器 411 实测:真点击四 Tab/100 次切换/损坏存储自愈/十连点启动幂等/冷启即时连点(首点 2-12ms) 全过。
- 设备端复验命令(手机插上后):\`adb devices\` → 装 \`apk/app-latest.apk\` → 首页应无 \`--\` → 点四 Tab 应切换 → 诊断页"启动序列"应显示 Time to UI(<50ms 量级)与各阶段耗时、"最长主线程任务"应为 0 或极小。

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

