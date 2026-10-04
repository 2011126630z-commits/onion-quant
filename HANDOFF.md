# HANDOFF · onion-quant(更新: 2026-10-05)

> 跨轮上下文接力文件(规范 §2)。聊天历史不承担长期记忆。

## 已完成(近四轮)

- **V16.2v(本轮)**:动态币种池 + 资金效率 —— ①后台运行时写死 5 币 → 真扫描(40 扫/31 候选/深度 ≤10,
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

- 基线:**44 套件 / 4141 断言 / 0 失败**(`node tools/run-tests.mjs`);check-artifacts **281** 守卫。
- 新增测试:`test-p0-runtime-guards.mjs`(34)、`test-universe-efficiency.mjs`(34,覆盖 §18 十二项)。
- 真机:不在(adb 无设备)→ 真机项 **NOT VERIFIED**(浏览器实测:扫描 40/候选 31/深度 10 面板正常)。

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

