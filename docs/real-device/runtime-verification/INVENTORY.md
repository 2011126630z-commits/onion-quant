# V16.1-RV · 内部盘点(读真实源码后,不是看文件存在)

日期:2026-10-03 · 设备:vivo V2502A(PD2502)/ Android 16 API36 / 1260×2800@560dpi(override 490)
代码基线:`worker/src/paper/runtime.js`、`worker/src/ui/page.js`、`tools/runtime-host.js`、
`android/app/src/main/java/com/quantmonitor/paper/{MainActivity,PaperForegroundService,BootReceiver,DebugFinishReceiver}.java`
盘点口径:**IMPLEMENTED = 代码路径真实成立且本轮有证据;PARTIAL = 只接了一部分;NOT WIRED = 代码存在但没有接线;NOT TESTED = 实现可疑但本轮没测到。**

| 组件 | 状态 | 依据(真实源码事实) |
|---|---|---|
| Android Runtime(服务内无界面 WebView + runtime.js) | **IMPLEMENTED(本轮修了一个致命接线)** | 服务自建 WebView 加载 `runtime.html`;`createPaperRuntime` 单例登记表;定时器 5min(tick)+20s(risk);**但 `fetchTickersWithFailover().then(...)` 把同步函数当 Promise 用 → 每轮 tick 抛 TypeError → 真机 loops 恒 0、从没推进(已修,见报告 BUGS FIXED #1)** |
| Foreground Service | IMPLEMENTED | `START_STICKY`;8 个通知渠道;常驻通知只在文案变化+≥10s 时更新;静态 `runtimeView` 单实例守卫;`onDestroy` 释放 WebView;**无 wake lock / 无电池优化白名单(不绕过系统,按规格记 OS_RESTRICTED)** |
| Activity(MainActivity) | IMPLEMENTED | 只做 Viewer/Controller;`onDestroy` 不碰运行时;`configChanges` 含 orientation → 旋转不重建 Activity;`launchMode=singleTask`;`DebugFinishReceiver`(仅 debug)可精确模拟"Activity 销毁而服务存活" |
| UI WebView(Capacitor) | IMPLEMENTED | 与 runtime 同源 `https://localhost` → 同一份 IndexedDB;`QuantNative` 桥:notify/setAutoStart/isRuntimeRunning/runtimeStatus/runtimeStartedAt/ensureRuntime |
| Runtime Host(runtime-host.js) | IMPLEMENTED(P0 修复后) | boot 单例复用("already alive (single instance)")+60s 自我守护+命令邮箱消费(PAUSE/RESUME/MANUAL_CLOSE/EMERGENCY_CLOSE/ADJUST_STOP/ADJUST_TP/TICK)+klines OKX 回退;行情 failover(Binance→OKX→Bybit);**本轮补 60s 守护的 RUNTIME_STALL 检测/通知**;新增 Node 沙箱测试 `test-runtime-boot.mjs` 原样运行本文件 |
| State Bridge(命令邮箱) | IMPLEMENTED | UI 只写 `runtime_commands` 表(PENDING),运行时 poll→execute→complete(DONE/FAILED + result);UI 不直接改账本 |
| Paper Engine | IMPLEMENTED | 幂等双守卫:`duplicate_idempotency_key`(mode|symbol|candle|direction)+ `closed_candle_already_processed`(symbol|mode|interval,candle ≤ last 一律拒绝,换方向也拒);`init()` 账户缺失但有持仓史 → 拒绝新建账户进 ERROR(对账门) |
| Market Engine | IMPLEMENTED | failover + HEALTHY/DEGRADED/FAILED;**本轮新增 STALE**:价格指纹连续 N 次完全不变(HTTP 200 也)标 STALE,暂停新开仓;STALE/阻断时不拿坏价乱退(风控照跑) |
| Risk Loop | IMPLEMENTED | 20s `riskTick`(强平→止损→移动止损→止盈→Profit Lock);行情不可用则跳过而不是乱模拟;**本轮新增 risk_loops/last_risk_at 计数** |
| Strategy Loop | IMPLEMENTED | 5min `tick`:行情→风控→候选(closed candle 幂等键)→loop→结算;**同一收盘K线最多一次策略决策**(桌面 10 轮连跑只开 1 次仓,已有测试) |
| Learning Loop | PARTIAL | 学习样本/漂移/Champion 逻辑在引擎里真实存在,但**真机此前从未产生过平仓样本(因为 tick 从未推进)**;修复后才有样本流 |
| WebSocket(详情页实时K线) | IMPLEMENTED | 页面级单订阅 + `__quantWsCount` 计数守卫;`k.x=false` 只更新当前 K;断线 RECONNECTING;REST backfill 不触发策略 |
| Chart | IMPLEMENTED | 单实例 `dtChart`;全屏=CSS 类切换;历史模式不自动跳回最新;缩放/平移/十字线/长按均有单测 |
| Bottom Sheet | IMPLEMENTED | 静态 DOM + class 开合(chat/close/ntf/theme);chat 支持下拉关闭;关闭后不残留打开态 |
| Diagnostics | IMPLEMENTED | 黑匣子:错误去重+面包屑+快照+导出(diagExportBundle/diagRedact 脱敏);**本轮新增页面侧 ACCOUNT_VIEW_MISMATCH 与运行时 RUNTIME_STALL 证据** |
| Viewer(只读镜像) | IMPLEMENTED(本轮补齐) | 读 `paper_account/paper_wallets/paper_positions/paper_trades/paper_notifications/paper_engine_state`;暴露 poolLayers/hwm/protectedPool(与引擎同口径纯读);**新增读取代数守卫(旧读取不许回写)** + `readRuntimeStatus()` 版本守卫(旧 state_version 丢弃) |
| State Store(uiStore) | IMPLEMENTED(本轮接线) | 11 bucket + state_version 拒旧;首页/模拟/内核三页渲染后登记同一资金口径(capitalSnapshot)+ `capitalParity` 自动对比 → 分叉即 `ACCOUNT_VIEW_MISMATCH` 进诊断 |
| Persistence / Retention | IMPLEMENTED | IndexedDB 版本守卫;自愈/降级必须暴露 mode/degraded;禁止静默退化成空内存库(否则会被当首启建新账户);retention 定时清理 |
| Boot Restore | IMPLEMENTED · **NOT TESTED(需重启手机)** | BootReceiver 监听 BOOT_COMPLETED/MY_PACKAGE_REPLACED,auto_start=true 时拉起服务;真机重启受"关机后 adb 需要人工解锁"限制,本轮不擅自重启 |
| 通知点击深链 | **NOT WIRED** | 通知点击只打开 MainActivity(未按 kind 路由到详情/诊断);规格 §50 未满足,如实记录 |
| 秒级 K 线(1s/5s/15s/30s) | **NOT IMPLEMENTED** | 无真实秒级数据源,不伪造(沿用既有决策) |
| OEM 后台限制 | **NOT WIRED(也不允许绕过)** | 未申请电池优化白名单;vivo 省电/Doze 冻结定时器时按规格记 **OS_RESTRICTED**,只有在冻结后仍能恢复且不补跑时才谈 Runtime 本身是否 OK |

## 本轮"文件存在但功能不成立"的实例(为什么要这样盘点)
- `runtime-host.js` 看起来一切正常(单例/守护/命令邮箱/回退都写了),但行情接线 `fetchTickersWithFailover().then(...)` 类型错误 → 真机**每一轮 tick 都在行情处抛错**,`loops` 恒 0、`consecutive_failures` 一路累加。这是"后台真的在运行吗"这个问题的直接答案:**修复前答案是否定的**。修复后新增两道守卫:静态守卫(check-artifacts)+ 动态守卫(Node 沙箱原样跑 runtime-host)。
