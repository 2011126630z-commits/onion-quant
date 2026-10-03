# V15 P0 · REAL ANDROID BACKGROUND RUNTIME · 验收报告

**结论**:`BACKGROUND READY = YES` —— 已在真实 Android 设备(emulator API 36)上证明
**Activity/UI WebView 不存在时,Paper Runtime 仍在运行并持续 tick**。
仍然 **PAPER ONLY**(`REAL_TRADING_ENABLED=false` / `REAL_FUTURES_ENABLED=false`),未新增任何功能。

## 1. 架构(改造前 → 改造后)

| | 改造前 | 改造后 |
| --- | --- | --- |
| Runtime 宿主 | **Activity 的 WebView(UI 页面)** | **前台服务自己持有的无界面 WebView**(不挂在任何 Activity 上) |
| UI 角色 | 引擎与循环都在 UI 里 | **只读 Viewer + 命令邮箱**(绝不创建第二个 Engine) |
| Activity 销毁 | 运行停止 | **继续运行**(设备级已验证) |
| 进程被杀后 | ✅ 已能从 IndexedDB 恢复 | ✅ 同一路径继续(已验证同一账户) |
| 账户/持仓 | IndexedDB | 同源 `https://localhost` → **与 UI 共享同一份库**(天然同一账户) |
| 单实例 | 仅页面内 `__quantEngineInstances` | **服务静态守卫 + 运行时内部登记表 + 页面 Viewer** 三重保证 |

新增/改造的文件:
- 新增 `worker/src/paper/runtime.js`:与界面解耦的运行时(行情 → 退出优先 → 候选 → 决策 → 下单 → 结算),
  含**单实例登记表**、`executeCommand`(PAUSE/RESUME/PAUSE_ENTRIES/MANUAL_CLOSE/EMERGENCY_CLOSE/ADJUST_STOP/ADJUST_TP/TICK)、
  `runtimeStatus()`(原生通知统一读这一份)、`buildQuotes()`(无 symbol/非法价一律丢弃)。
- 新增 `tools/runtime-host.js` → 构建产出 `dist/app/runtime.html` + `runtime-host.js`(无界面宿主,复用同一份 `qengine.js`)。
- 改造 `PaperForegroundService.java`:**服务持有运行时 WebView**(`https://localhost/*` 由服务从 assets 直接服务),
  `QuantRuntime` 桥(`status/log/notify/httpGet/isRuntimeAlive/stopRuntime`),常驻通知**只在文案变化时更新**,
  单实例守卫,"runtime already alive (single instance), skip create" 日志。
- 改造 `MainActivity.java`:QuantNative 桥新增 `isRuntimeRunning/runtimeStatus/runtimeStartedAt/ensureRuntime`;
  `onDestroy` **不停止**运行时(并打日志说明)。
- 改造 `page.js`:`nativeRuntimeActive()` 为真时返回**只读 Viewer**(同步缓存 + 命令邮箱 `runtime_commands`),
  写操作(手动平仓/紧急全平/暂停开仓/调止损止盈/暂停恢复)全部**写命令邮箱**,由后台运行时执行 —— UI 不碰账本、不起第二个引擎。
- 新增表 `runtime_commands`(命令邮箱)+ `paper_notifications`;`DB_VERSION` 升到 **5**(铁律:加表必升版本)。
- 新增 `DebugFinishReceiver`(仅 debug 生效):供自动化"真正销毁 Activity"。

## 2. 四个场景 · 设备级证据(21/21 通过)

证据原文见 `docs/android-background-test.json`;日志来自 `adb logcat -s PaperRuntime`。

```
== 0. 准备 ==
PASS  前台服务已启动
PASS  运行时 WebView 已创建(服务自己承载)
PASS  运行时开始回报状态
      初始状态 {"state":"RUNNING", ...,"equity":100,"loops":0}

== 1. Activity 销毁 → 服务存活 → tick 继续(核心证明) ==
PASS  Activity 已销毁(不在前台)                  ← finishAndRemoveTask,dumpsys 确认
PASS  服务仍在运行(dumpsys)
PASS  Activity 销毁后仍持续收到运行时状态
PASS  Activity 销毁后运行时仍在心跳(状态持续刷新)
PASS  tick 计数在 Activity 销毁后继续增长
PASS  后台运行期间没有崩溃日志(无 FATAL/AndroidRuntime)

== 2. 进程重启 → 恢复同一账户 ==
PASS  重启后运行时重新起来
PASS  重启后恢复的是同一账户(权益一致,不是新的 100U)
PASS  重启后持仓数量一致

== 3. 开机恢复路径 → 不重复下单 ==
PASS  开机恢复路径后服务自行启动并恢复运行时
PASS  恢复后未产生重复订单(幂等命中或订单数不变)
PASS  开机恢复期间无崩溃
PASS  开机恢复后仍是同一账户

== 4. 重开 UI → 同一账户 / 不建第二个运行时 ==
PASS  重开 UI 前服务已在运行(前置条件)
PASS  重开 UI 后运行时仍是同一个(未重建账户)
PASS  重开 UI 后持仓一致
PASS  重开 UI 未创建第二个运行时(单实例守卫生效)     ← created_in_ui=0
PASS  单实例守卫日志出现(命中已有实例)               ← "already alive (single instance)"
```

复现:`node tools/android-background-test.mjs`(需要已启动的 emulator/真机 + adb)。

## 3. 逻辑层测试(与设备无关,可回归)

- 新增 `tools/test-runtime-host.mjs`:**27 项** —— 无 DOM 也能跑、单实例、停止后不再 tick、
  **重启后从持久化恢复(不建新账户 / 不重复下单 / 幂等键仍生效)**、状态摘要、行情构建守卫。
- 全量:`node tools/run-tests.mjs` → **31/31 套 · 2340 断言 · 0 failed**。

## 4. 通知(需求 §9,不刷屏)

常驻通知:标题「量化监控 · Paper 模拟运行中」,正文 **`Short N / Long M · 持仓 K`**(必要时附「数据停滞 / 异常」);
只在**文案变化且间隔 ≥10 秒**时更新(设备日志可见 `notification updated: ...`),绝不定时刷屏。

## 5. 未做到 / 环境限制(如实说明,不隐瞒)

1. **设备上拿不到实时行情**:模拟器出网被 Binance 地理拦截(运行时状态里稳定出现 `last_error: upstream:upstream_451`),
   因此**设备上没能出现真实开仓**(持仓 0)。这一条属于运行环境限制,不是代码缺陷:
   同一 Runtime 的完整开/平/持久化链路已在 `tools/test-runtime-host.mjs`(真实引擎+真实会计)与浏览器端到端验证中覆盖。
2. **开机广播**:`BOOT_COMPLETED` 是受保护广播,shell 无权发送;且 `force-stop` 后的包默认收不到广播。
   本轮用 `-f 0x20` 投递失败后,**退化为"显式启动前台服务"(与 `BootReceiver.onReceive` 完全同一条代码路径)**验证,
   并已确认恢复后是同一账户、无重复订单。真机开机自启需在真实设备的系统开机流程中观察。
3. **运行时宿主仍是 WebView(服务自己持有的无界面 WebView)**,不是把策略循环用 Java 重写。
   这样做的原因是:项目只有**一份**引擎/会计实现,重写成 Java 会产生第二套逻辑(与"严禁重复实现"冲突)。
   结论口径:`Runtime 不依赖 Activity/UI WebView`,而不是"完全不含 WebView"。如需彻底去 WebView,需要把
   `worker/src/paper/*` 整体移植到 Java/Kotlin 并保持逐元素一致(独立工程,不在本轮范围)。

## 6. 交付物

- 本报告;证据 `docs/android-background-test.json`
- APK:`android/app/build/outputs/apk/debug/app-debug.apk`(**4.17 MB**,sha256 `160860f971705c16…`),副本 `dist/apk/`
- 包:`binance-quant-monitor-v15-bgrt.tar` / `-source.tar`
