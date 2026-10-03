# V15 · Performance Attribution + 通知持久化 + 存储退化保护

本轮在"继续"下补完两个已记录的缺口，并在过程中**发现并修复一个 P0 数据安全缺陷**。

## 1. P0:存储退化导致"账户看起来被重置"（本轮最重要）

**现象**:刷新页面后 总模拟资产 100.00 · 今日操作 0 次 · 持仓 0 · 通知空白 —— 看起来账户被清空了。

**根因链**（我上一轮新增 `paper_notifications` 表引发的连锁）:
1. 新增表 → 存储层"自愈迁移"把 IndexedDB 从 v3 升到 **v4**（这一步本身是对的）。
2. 但 `DB_VERSION` 仍是 **3** → 之后 `indexedDB.open(DB_NAME, 3)` 对 v4 的库抛 **VersionError**。
3. 自愈重开路径**没有 `onblocked` 处理** → 页面自己的旧连接/其它标签页会阻塞升级 → open 永不回调。
4. `createHistoryStore` 捕获异常后**静默退化成空内存库** → 引擎读到"没有账户" → 走"首次运行"分支，建了一个**全新 100U 账户**（只存在于内存，未覆盖磁盘）。

**磁盘数据其实一直完好**:`paper_account` cash 92.727 / realized -0.1255 / reserved 7.135、60 笔成交流水、2 笔持仓、3 条通知 —— 账目对账一致（100 + Σnet(-0.13) - reserved(7.14) = 92.74 ≈ 92.727）。

**修复（三道）**:
- `DB_VERSION` 升到 **4**，并把版本历史写进注释（新增表必须同步升版本号）。
- `openDB()`:处理 `onblocked`（明确抛 `indexeddb_blocked_by_other_connection`）、处理 **VersionError**（以"最新版本"重开一次而不是直接失败）。
- `createHistoryStore` 暴露 `mode / degraded / degraded_reason`；**不再静默退化**（内存回退只在真的没有 indexedDB 或显式指定时发生，且必须记录原因）。
- `engine.init()` 新增**安全门**:账户缺失但库里有持仓/成交，或存储处于 degraded → **拒绝新建账户**，进入 `ERROR` 状态、发 `store_unavailable` 完整性告警与系统通知（"已阻止新建账户，避免覆盖真实记录"）。

**修复后实测**:刷新后 `总模拟资产 99.86 USDT · 累计 -0.13 · 今日操作 60 次 · 持仓 2`，**通知历史也恢复了**（交易/系统 3 条），控制台无异常。

## 2. Performance Attribution（P1，此前列为"最该补的"）

- 新模块 `worker/src/paper/attribution.js`:按 **策略 / 币种 / 市场状态 / 杠杆档 / 模型版本 / 退出策略 / 周期** 七个维度归因。
- 每组给:`trades/wins/losses/win_rate/net_pnl/fees/avg_net_pnl/avg_holding/profit_factor/liquidations/share_pct`；退出原因归桶（强平/止损/止盈/利润保护/手动/时间退出/结构反转）。
- **异常样本一律剔除**（`invalid_sample`、非有限盈亏、非法价格），可选 `include_invalid` 仅用于调试。
- UI 接入 模拟>统计:一行结论（谁在赚/谁在亏/主要亏损来自哪种退出）+ 各维度 4 名。实测输出:`长线贡献 -0.04U · 最差 ETH -0.04U · 主要亏损来自 利润保护 · 有效样本 58 笔`。

## 3. 通知历史持久化（此前记录的缺口 ③）

- 新增 `paper_notifications` 表（schema + ALL_TABLES 注册 + 索引 `at`/`kind`）。
- 引擎 `notify()` 落库（fire-and-forget，失败不影响通知本身）、`markNotificationsRead()` 同步已读状态、`init()` 恢复最近 300 条。
- 实测:刷新后通知列表**不再归零**，已读状态也保留。

## 4. 测试与产物

- 新增 `tools/test-attribution.mjs`:**48 项**（归因七维度口径 / 异常样本剔除 / UI 视图 / 通知落库与恢复 / **存储退化保护 5 例**）
- 全量:`node tools/run-tests.mjs` → **30/30 套 · 2313 断言 · 0 failed**
- APK:`android/app/build/outputs/apk/debug/app-debug.apk`(**4.17 MB**,sha256 `3fbea89cf077a797…`),副本 `dist/apk/`
- 包:`binance-quant-monitor-v15-attrib.tar` / `-source.tar`

## 5. 教训（已写入记忆）

**新增 IndexedDB 表 = 必须同时升 DB_VERSION，并且存储层的自愈/退化路径必须有 blocked/VersionError 处理与"退化原因"上报**。静默退化成空库比直接报错危险得多 —— 它会让上层把"读不到"误判成"首次运行"，进而写一个全新的空账本。
