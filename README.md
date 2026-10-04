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
Version:     v16.2t(16.2.0-paper)
Size:        4.84 MB (5,075,615 bytes)
SHA256:      b703d7131e73432b175c6e3f3b64175dee4a3f2d689fad857f69db1bc1162623
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
node tools/run-tests.mjs      # 全量测试(当前 42 套件 / 4005 断言 / 0 失败)
node tools/build-android.mjs && npx cap sync android
cd android && gradlew.bat assembleDebug   # APK 输出在 android/app/build/outputs/apk/debug/
```

APK 发布流程(本仓库约定):`构建 → 测试通过 → 复制到 apk/app-latest.apk → 更新本 README 的版本块 → commit & push`。

## 版本历史(简)

| 版本 | 要点 |
|---|---|
| v16.2t | P0"只剩底部导航栏"根因修复(正文可见性不再依赖动画)+路由表/导航看门狗/渲染兜底/自恢复/故障注入全量加固 |
| v16.2s | 点击延迟专修(先绘制后重活/Shell 先行/返回不等网络)、系统状态逐项可展开、市场↔自选分段控件与统一自选 Store、K线 pinch 方向与锚点修复、手势状态机与冻结看守、四档宽度零溢出 |
| v16.2 | 课堂式手机 UI:黑白闪屏修复、返回状态连续性(滚动逐像素恢复/返回栈)、按钮体系统一 |
| v16.1 | 真机运行时验收:修复后台运行时行情接线(曾从未推进)、保护池/HWM 持久化、资金语义修正 |
| v15.x | Android Paper App 收口、后台运行时、归因与存储修复 |

## 说明

- 数据真实性优先:无数据就显示空态,不伪造行情/收益;所有金额来自本地账本。
- 非商业、个人研究用途;不提供会员/支付/后台。
