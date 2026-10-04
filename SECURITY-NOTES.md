# SECURITY NOTES

Last reviewed: 2026-10-04 · 最新扫描: `scan-2026-10-04T02-59-55.829Z-ac1293e9e4c4`
(Mimosa deep, seal `sha256:b34196d5…d63bd23`;对最终代码复跑)
· 上次扫描: `scan-2026-10-03T12-49-15.337Z-bd705dd4ac8b`(seal `sha256:39d1a7d4…2cdb3a`)

## Status: INCONCLUSIVE(不宣称安全)

工具自报的两句原话,照录:

- Run status: **inconclusive** —— 部分分析阶段未能完整覆盖;调用图部分不完整(动态派发/超出分析规模)。
- 每条发现均为 **advisory(static-finding)**,`verdictEffect: none`,并明确标注 proof gap:
  "静态 advisory 需要人工确认真实数据流和可利用性"。

**复跑结果(2026-10-04,最终代码)**:findings 仍为同一组 9 条 medium 启发式
(findingId/anchor 与上次完全相同,仅行号随新构建产物位移);依赖解析
`0 个受影响包`(工具自身解析完成);覆盖状态仍为 partial(工具侧限制,非代码问题)。

## 9 条 medium 静态提示 —— 人工复核结论(2026-10-04)

全部为同一类跨文件 taint 启发式:**"不可信数据(扫描器建模为「环境变量」)流入 sort 类 sink"**。
逐函数复核源码后,认定 **9/9 为启发式假阳性**,证据如下:

**① 污点源不成立。** 全代码库对 `process.env` 的读取只有一处:
`worker/src/routes.js:263` 读取 `DEEPSEEK_API_KEY`,且只用作一次外发请求的
`authorization` 头(`routes.js:306`)。该值从不进入任何被标记函数(convertBybit* /
normalizeOkxAnnouncements / srZones / computeAnalysis / analyzeSymbol / handleNewsFeed)
的参数。工具自报的调用图不完整(callgraph partial + 动态派发),跨文件链是拼接产物。

**② "mongo-sort-injection" 是对 `Array.sort()` 的启发式标签,不是数据库注入。**
本应用没有任何数据库层(无 MongoDB / 无 SQL / 无查询构造器)。被标记的 sink 实际是:

| 被标记函数 | 真实 sink(源码) | 输入与比较器 |
|---|---|---|
| convertBybitOpenInterest | `proxy.js:743` `list.slice().sort((a,b)=>Number(b.timestamp)-Number(a.timestamp))` | 输入=Bybit 公开行情 JSON(`retCode===0` 门控,上游请求固定 `limit=2`);固定数值比较器 |
| normalizeOkxAnnouncements | `newsParse.js:126` `out.sort((a,b)=>b.published_at-a.published_at)` | 条目是本函数自建对象(title/url 经 stripHtml/safeUrl,published_at 经 parseTimeMs 数值化);`limit` 夹紧 ≤40 |
| srZones | `structure.js:61/84/85` 三个 `sort((a,b)=>a-b / b.mean-a.mean)` | 输入=引擎自算的 swing 价格数组(数值),固定比较器 |
| convertBybitPayload | 经 1 跳调用 convertBybitOpenInterest(同上) | 同上 |
| computeAnalysis | 经 1 跳调用 srZones(同上) | 输入=路由层自取的K线(tfRows),非用户可控比较器 |
| analyzeSymbol | 经 2 跳调用 srZones(同上) | symbol/interval 先经 cleanSymbol/cleanInterval 白名单 |
| handleNewsFeed | 经 1 跳调用 normalizeOkxAnnouncements(同上) | 上游为 OKX 公开公告接口;`limit` 从 URL 夹紧 1..40 |

**③ 无注入原语。** 全源码 70+ 处 `.sort()` 调用点逐一核对:比较器全部为固定
lambda(数值差或 `localeCompare`),无一处由输入提供或拼装;输入只作为**被排序的
数值**存在,不能改变比较语义。无 eval / Function / 字符串查询构造 / 子进程。

**结论**:9 条 medium 不构成可复现漏洞路径;保留"人工复核=假阳性"这一结论,但按
工具原话仍**不宣称安全**(工具覆盖度本身是 partial)。

## 依赖公告 —— 评估与处置(2026-10-04)

依赖扫描:`92` 个包,`1` 个包命中离线公告库:`tar@6.2.1`(12 条公告,1 critical /
8 high / 3 moderate;均要求"解包恶意归档"才能触发)。`tar` 是
`@capacitor/cli@6.2.2`(**devDependency**,构建期工具链)的传递依赖,
**不进入 APK、不进入 Worker/运行时**;node_modules 不入仓库。

已实际尝试的缓解:**npm `overrides` 将 tar 抬到 `7.5.22`**。
结果:公告清零(离线库 + npm registry bulk 双向核对 = 0),
但 `npx cap sync android` 立即失败:
`tar_1.default.extract` undefined —— tar 7 的 CJS 互操作变了
(`require("tar").__esModule === true`、无 default 导出),而 @capacitor/cli@6.2.2
编译产物用 `__importDefault(require("tar")).extract`。Capacitor CLI 6.x 无更高补丁版
(dist-tag latest-6 = 6.2.2),跳到 7.x/8.x 需整体升级 Capacitor 原生壳(工程量大、本轮
不做)。**⇒ 已回退 tar@6.2.1,`cap sync` 验证通过。**

**接受风险的理由(有据)**:本次 `cap sync` 流程中唯一的解包调用是
`removePluginsNativeFiles` → `extractTemplate(config.cli.assets.android.cordovaPluginsTemplateArchiveAbs,…)`
—— 解的是 **CLI 自带、随 npm 包安装的本地模板归档**(可信资产),不是任何用户/网络
输入;本项目的构建流程不存在"解包外部归档"的路径。⇒ 12 条公告在**本项目的实际用法**
下不可触发;留下"构建期、非运行时、无可达恶意输入"的记录。
**跟进条件**:等 @capacitor/cli 升级到 tar≥7 兼容写法(随 Capacitor 大版本升级)后,
再一并升级并复扫。

## 待办(人工)

1. ~~对 7 个函数逐个人工确认 taint 链~~ ✅ 2026-10-04 完成(见上,9/9 假阳性,已取证);
2. ~~复核命中公告的依赖版本并评估升级~~ ✅ 2026-10-04 完成(升级尝试+回退+接受风险论证,见上);
3. 复跑完整审计(Mimosa deep),用最终代码取得最新封印结论后再更新本文。
