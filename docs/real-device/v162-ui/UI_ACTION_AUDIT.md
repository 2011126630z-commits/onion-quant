# UI_ACTION_AUDIT · V16.2(手机端可点击元素全量审计)

设备通道:浏览器 411×914(CSS 视口与真机一致) + 源码静态扫描;真机复测见报告"REAL DEVICE VERIFIED"。
证据:`docs/real-device/v162-ui/route-audit.json`(每个入口"点了之后实际去了哪"的实测记录)。

## 扫描范围与方法
- 源:`worker/src/ui/page.js`(全部 button / 可点行 / sheet 动作 / FAB / bottom-nav)
- 动态实测:逐个 `click()` 并读取 `window.__quantUI.state().currentPage` + sheet 打开态(见 route-audit.json)

## 实测结果(15/15 真实可用,BROKEN 0,SHELL 0)
| 入口 id | 文字 | 点击后实际去向 | 判定 |
|---|---|---|---|
| openMonitorLegacy | 行情监控(详细分析) | monitor(真实分析页) | WORKING |
| openWatchLegacy | 自选列表 | watch(真实自选管理) | WORKING |
| openLearning | 学习状态 | 本页展开(真实渲染模型/样本/漂移数据) | WORKING(行内) |
| openValidation | 历史验证 | validation | WORKING |
| openBacktest | 历史回测 | backtest | WORKING |
| openWalkforward | 滚动验证 | walkforward | WORKING |
| openMl | 机器学习验证 | ml | WORKING |
| openDataset | 数据导出 | dataset | WORKING |
| openKernel | 量化内核 | kernel | WORKING |
| openSysStatus | 系统状态 | 本页渲染真实状态表 | WORKING(行内) |
| openDiag | 系统诊断 | diag | WORKING |
| openHealth | 行情健康检查 | health | WORKING |
| openNotifications | 通知中心 | 打开 Sheet(真实历史) | WORKING |
| openNtfSettings | 通知设置 | ntfset(子页,6 开关真实读写) | WORKING |
| openThemeSheet | 主题模式 | 打开 Sheet(真实换肤) | WORKING |

底部导航 4 项 / 市场行→详情 / 自选行→详情 / 详情工具行(周期/最新/全屏/交易标记) / 详情动作行(刷新/分析详情/平仓入口) / AI FAB→Chat(本地回答兜底为真实功能,DeepSeek 未配置时明确回退) / 模拟页(暂停新开仓/导出/紧急全平→二次确认→真实引擎命令) —— 均为真实行为(前序 E2E 与既有 248 项守卫覆盖)。

## 本轮修复的相关问题
1. **`.sec` 次级按钮此前没有任何基础样式** → 全站次级按钮是 UA 默认按钮(2px outset 边框/系统灰底/1px 内边距),即"按钮不统一/网页后台感"的真根因 → 已补全 Button System(46px/12px 圆角/描边浅底)。
2. 详情页"退出全屏"按钮曾因缺 `.hidden` 规则在非全屏也显示(上轮已修,本轮回归确认)。
3. 市场错误态从"一行死字"改为 标题+原因+**重试按钮**(真实动作 `renderMarket(true)`)。

## 已知明确边界(不装作完成)
- DeepSeek AI 复核未配置 Key → Chat 走本地回答(页面已如实标注,不是 SHELL)。
- 秒级 K 线未实现(无真实数据源,不伪造)。
- `开发工具 · 性能浮层` 默认关闭(性能计数只在开启后采集——E2E 泄漏测试用的就是它)。
