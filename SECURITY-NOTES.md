# SECURITY NOTES

Last reviewed: 2026-10-03 · Scan: `scan-2026-10-03T12-49-15.337Z-bd705dd4ac8b`(Mimosa deep, seal `sha256:39d1a7d4…2cdb3a`)

## Status: INCONCLUSIVE(不宣称安全)

工具自报的两句原话,照录:

- Run status: **inconclusive** —— 部分分析阶段未能完整覆盖;调用图部分不完整(动态派发/超出分析规模)。
- 每条发现均为 **advisory(static-finding)**,`verdictEffect: none`,并明确标注 proof gap:
  "静态 advisory 需要人工确认真实数据流和可利用性"。

## 9 条 medium 静态提示(同一类启发式)

全部为 **"不可信数据流入 sort 类 sink"** 的跨文件 taint 启发式,位置集中在 `worker/index.js`
(打包产物)里的上游归一化/分析函数:`convertBybitPayload`、`convertBybitOpenInterest`、
`normalizeOkxAnnouncements`、`srZones`、`computeAnalysis`、`analyzeSymbol`、`handleNewsFeed`。

事实边界(供人工复核时参考,**不等于已判定为误报**):

- 本应用**没有任何数据库层**(无 MongoDB / 无 SQL):被标记的 sink 是纯计算里的 `Array.sort()`
  (价格区间排序、按时间排序等),不是查询构造器。
- 这些函数是**只读解析**:输入是交易所公开行情/公告 JSON,输出是内部数组;不执行输入、不做字符串拼接查询。
- 扫描器把模块级/环境来源数据建模为 taint 源,可能放大了传递链。

## 依赖公告

依赖扫描:`92` 个包,`1` 个包命中离线公告库(`12` 条公告,未展开)。`node_modules/` **不入仓库**;
如需处理,应升级对应 npm 依赖后重跑 `node tools/run-tests.mjs`(41 套件 0 失败基线)。

## 待办(人工)

1. 对上述 7 个函数逐个人工确认 taint 链是否真实可达(当前证据不足);
2. 复核命中公告的依赖版本并评估升级;
3. 复跑完整审计(工具前次因部分阶段解析失败而未取得完整结论)。
