# UI_RUNTIME_WIRING_AUDIT · V16.2s(2026-10-04)

逐入口核对"能不能点、点进去有没有真实数据/真实动作"。口径:
**WIRED**=接真实 Runtime/真实动作;**PARTIAL**=只接了部分真实数据(已标注);
**UI_ONLY**=只有界面没有真实动作;**NOT_IMPLEMENTED**=未实现(已禁用/紧凑显示)。

| 页面/模块 | 接线状态 | 证据(读取的真实数据/动作) |
|---|---|---|
| 系统状态 | **WIRED** | `readRuntimeStatus()`(实例号/心跳/策略与风控循环/行情健康) + `dataQualitySummary()` + `taskBag.health()` + `notificationDigest().unread`;每行可展开真实细节,数值全部条件化,零写死 |
| 量化内核 | **WIRED** | `renderKernel()` 读引擎只读访问器(6 组组件);未启动/Viewer 模式下显示「未启动/未知」而不是假状态 |
| 市场(市场段) | **WIRED** | `loadTickers()` 真实行情;行=Symbol/Price/24h/星标;点击进详情 |
| 市场(自选段) | **WIRED** | 统一 Watchlist Store(localStorage 持久化);空态文案;缓存不可用币显示「当前不可用」不丢收藏 |
| 币种详情 | **WIRED** | `analyze` + `klines` + 实时推送;Shell 先行(缓存价格/K线);星标 = Watchlist Store |
| 预测(未来卡) | **WIRED** | `predictMultiHorizon`(本地模型,无数据即显示不可用) |
| 因子/模型状态 | **WIRED** | 量化内核页读 `factorRegistryView`/模型工件(无工件显式回退) |
| 学习状态 | **WIRED** | `getChampion`/`listModels`/`model_evaluations`/漂移检测(Accordion 展开时惰性渲染) |
| 数据质量 | **WIRED** | `eng.dataQualitySummary()` / `dataQuality().ok` |
| 后台 Runtime | **WIRED** | `QuantNative.runtimeStatus()`(仅壳内有;浏览器显示"本地直连")— 真实状态而非写死 |
| 风险状态 | **WIRED** | `eng.currentRisk()`(等级/是否可开仓/风险标记) |
| 诊断(黑匣子) | **WIRED** | `eng.diagExport()` + 诊断事件列表;复制/导出为真实动作 |
| 行情健康检查 | **WIRED** | `loadHealth()` 探测 Binance/OKX/Bybit 上游(探测失败显示真实错误) |
| 扫描市场 / 旧监控 / 旧自选页 | **WIRED** | 既有真实路由(`screen`/`analyze`),自选写路径已改走统一 Store |
| 历史验证/回测/滚动验证/ML/数据导出 | **WIRED** | 各页读真实 IndexedDB 历史与运行体(此前 V16.2 路由审计 15/15 无 SHELL) |
| 通知设置(Bottom Sheet/子页) | **WIRED** | 开关写 `ntfSettings` 并持久化;主页显示已开 N/6 |
| AI(Chat/Review) | **WIRED** | 服务端无 Key 时明确回退本地回答(`answerLocally`),不伪造 AI 结果 |
| 展开/折叠类 | **WIRED** | 系统状态/学习状态=统一 Accordion;详细统计=`<details>`;查看分析详情/外部情报=带 aria 的双向切换 |

**空壳结论:0 个 UI_ONLY、0 个 NOT_IMPLEMENTED 暴露为可点入口。**
所有带箭头(可导航)的设置行共 17 个,均由 `NoShellClickablePageTest` 守卫断言
"全部存在真实 click 绑定"(见 tools/test-v162s-ui.mjs)。
硬编码状态行审计:删除唯一一条写死项(`["DeepSeek","未配置(本地回答)"]`),
其余状态全部由运行时数据条件化得出(`NoFakeStatusTest` 守卫)。
