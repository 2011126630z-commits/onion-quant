# onion-quant · Binance AI 量化监控(Paper Only)

个人专用 **Paper Trading** 量化分析终端:真实行情 + 模拟交易(永不真实下单)。
本仓库 = 源码 + **最新 APK**(固定位置,直接下载)。

## ⬇️ 下载最新 APK(公开仓库,免登录)

**方式一(推荐,一步直达)**:点这里直接下载 ——
**https://github.com/2011126630z-commits/onion-quant/releases/latest**

**方式二(固定路径)**:点目录 **`apk/`** → **`app-latest.apk`** → Download。

> 传到手机安装即可(需允许"安装未知来源应用");安装为覆盖安装,账户/设置/学习数据都会保留。

```
Latest APK:  apk/app-latest.apk   (Releases 附件同名 app-latest.apk)
Version:     v16.2z(16.2.0-paper)
Size:        4.87 MB (5,111,709 bytes)
SHA256:      68d4def584770ad673f0371230bc662b3dec2580e70f60bcbd71428c570c5dbe
```

- **PAPER ONLY**:无真实 API Key、无真实下单;应用内所有"开仓/平仓"都发生在本地模拟账户。

## 这个 App 是什么

- 安卓 App(WebView 壳 + 本地量化内核):市场行情、K线(实时推送)、Paper 引擎(自动模拟)、风险/资金内核、学习与验证、通知与诊断。
- 单实例后台运行时(Runtime 由前台服务承载):退出界面/锁屏后模拟引擎继续运行;界面只是观察者与控制台。

## 源码结构(构建方式)

```
worker/src/           引擎与页面源码(engine/history/paper/ui)
tools/                构建、测试、真机验收脚本
android/              Capacitor Android 工程
dev-server.mjs        本地开发服务器(node dev-server.mjs → http://localhost:8790)
```

构建与测试:

```bash
node tools/build.mjs          # 生成 worker/index.js 与页面内联脚本(会做语法校验)
node tools/run-tests.mjs      # 全量测试(当前 47 套件 / 4312 断言 / 0 失败)
node tools/build-android.mjs && npx cap sync android
cd android && gradlew.bat assembleDebug   # APK 输出在 android/app/build/outputs/apk/debug/
```

APK 发布流程(本仓库约定):`构建 → 测试通过 → 复制到 apk/app-latest.apk → 更新本 README 的版本块 → commit & push`。

## 版本历史(简)

| 版本 | 要点 |
|---|---|
| v16.2z | 学习数据完整性 P0:① 复现基线并定位根因(raw 3411=seed 3000+rule 411→canonical 20+revision 391;revision 由 pipeline.recordAnalysis 同 id 追加 _rN 产生,与 Resolver 无关);② Schema 控制 canonical UPSERT:稳定 canonical_sample_id、首次快照冻结、重复分析只落 REVISION(learning_eligible=false)、快照哈希去重(重启/后台恢复重放行数不变);③ 真实档案一键迁移(applied 3411 → seed 3000/CANONICAL 20/REVISION 391,AMBIGUOUS 0,不删数据、不覆盖历史);④ Return Sanity(量纲/分母/高低界/有限性)+ 训练硬门 + 晋升闸门(PAUSED_DATA_INTEGRITY 冻结 Champion 晋级,推理照跑);⑤ 导出分家:有效ML数据(=20 行可训练)/审计数据(=3411 行全量);⑥ 诊断页学习数据完整性体检卡(11 项,0 P0);⑦ Outcome 严格 T→T+H 窗口与复习幂等(既有引擎逻辑,本轮用 TEST1-14 锁定) |
| v16.2y | P0 账户审计+完整系统导出+学习数据完整性:① 2.5U 亏损逐笔归因(权威口径 -0.5273U;UI 曾显示的 -2.32U 中约 -1.8U 来自压测 seed 污染,已在归因口径中剔除并单独报告);② 账户恒等式+派生 Ledger 闭合校验(差 0.0037U 在容差内,如实披露);③ 母仓级全字段行+纯规则亏损标签+Profit→Loss 统计+蚂蚁仓分桶+重复信号检查;④ seed/synthetic/test/replay 一律 learning_eligible=false,+canonical_sample_id 折叠 revision,411 真实信号→20 个有效训练样本;⑤ 完整系统导出 zip(23 文件/13.9MB/manifest 完整性 PASS/脱敏/分块序列化不卡 UI);⑥ 模拟页新增损益分析、复盘补全生命周期字段、学习页与诊断页导出按钮分家 |
| v16.2x | 启动响应性 P0:根因=引擎 integrityRepair 对 2000 学习样本逐条 trades.find 的 680 万次比较(300ms/轮)+ 启动即全量读库 4000 行 + retention 全表计数 + setTimeout 让步在后台 WebView 被节流。修复=Map 索引+MessageChannel 让步+Phase A/B/C 分层+DB 懒加载+空闲延后(模型/学习/清理)+成交 50 条窗口+实例审计+诊断启动性能表。桌面实测:最长主线程任务 276-309ms → 0、Time to UI 13-49ms、首点 2-12ms |
| v16.2w | P0 真机假死根因修复:模块级未守卫存储读取(残留非法 JSON / 存储被拒)会整段杀死主脚本 → 首页全 `--`、底部导航点击无反应、永不 hydrate。修复=存储读取全守卫+自愈、BOOT_SEQUENCE 阶段插桩与 BOOT_FAILED 记录、主脚本死亡时兜底导航与启动异常横幅、首页三态(加载中/等待后台数据/读取失败)、诊断页 Boot Status |
| v16.2v | 动态币种池(40 扫描/31 候选/深度 ≤10,真实山寨进入)、市场扫描面板与宇宙健康诊断、资金与损失分离(蚂蚁仓根因)、费用吃掉边际/低置信门槛、母仓资金效率 |
| v16.2u | P0 审计首轮:全链路溯源(signal_id/strategy_intent_id/decision_id)、组合暴露预检真接线(EXPOSURE_CAP)、Runtime 统一 7 态与 Start 幂等(连点 10 次只 1 实例/1 Loop) |
| v16.2t | P0"只剩底部导航栏"根因修复(正文可见性不再依赖动画)+路由表/导航看门狗/渲染兜底/自恢复/故障注入全量加固 |
| v16.2s | 点击延迟专修(先绘制后重活/Shell 先行/返回不等网络)、系统状态逐项可展开、市场↔自选分段控件与统一自选 Store、K线 pinch 方向与锚点修复、手势状态机与冻结看守、四档宽度零溢出 |
| v16.2 | 课堂式手机 UI:黑白闪屏修复、返回状态连续性(滚动逐像素恢复/返回栈)、按钮体系统一 |
| v16.1 | 真机运行时验收:修复后台运行时行情接线(曾从未推进)、保护池/HWM 持久化、资金语义修正 |
| v15.x | Android Paper App 收口、后台运行时、归因与存储修复 |

## 说明

- 数据真实性优先:无数据就显示空态,不伪造行情/收益;所有金额来自本地账本。
- 非商业、个人研究用途;不提供会员/支付/后台。
