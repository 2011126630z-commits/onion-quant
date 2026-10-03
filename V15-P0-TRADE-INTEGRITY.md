# V15 P0 · PAPER TRADE INTEGRITY 修复报告

**范围**:只修 CSV 暴露出的交易完整性问题。未新增模块、未重构现有模块(全部复用 `profitLock.js` / `accounting.js` / `engine.js` / `attribution.js`)。
**仍然 PAPER ONLY**:`REAL_TRADING_ENABLED=false` / `REAL_FUTURES_ENABLED=false`。

## 真实数据(修复前 → 修复后)

修复前账本(浏览器 IndexedDB,113 条成交):

```
profit_lock_stage4: 110 条      ← 同一批仓位被反复切碎(66% → 66% → 66% …)
return_pct 越界:    -2624.732906%   ← 用户报告的那条虚假收益
```

修复后同一份账本(启动迁移处理,**金额一律未改**):

```
113 条事件 → 8 个完整仓位(仓位级口径)
标记 invalid_for_learning: 105 条   tiny_slice 57 · shredded_cluster 47 · return_out_of_range 1
未改账证明:被标记样本 net_pnl -0.00406242 / return_pct -0.028391 原样保留
归因显示:有效样本 8 笔(按完整仓位统计),排除 105 笔异常
```

## 逐项修复

| # | 问题 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | `profit_lock_stage4` 同一仓位重复触发 | `profitLockDecision` 对"该 Stage 是否执行过"**无状态** —— 只要仓位仍在 stage4,每 20 秒风险轮次就再砍一刀 | 新增状态机 `profitLockStateOf` / `applyProfitLockState`(`profit_lock_state.executed_stages`),引擎执行成功后写回并落库 |
| 2 | 同一 Stage 只能执行一次 | 同上 | 决策层闸门:`stageDone` → 不再产生 `PARTIAL_CLOSE`/`FULL_CLOSE`,只允许推进保护性止损 |
| 3 | 增加 Profit Lock State Machine | 无 | `PROFIT_LOCK_STATE_KEY` / `profitLockStateOf` / `applyProfitLockState`(记录已执行 Stage、上次动作时间、事件数、累计减仓) |
| 4 | 禁止 66%→66%→66% 无限切碎 | 无间隔/无上限约束 | 最小间隔 `min_interval_ms` + 单次上限 `stage_cap` + Stage 幂等,三重闸门 |
| 5 | Dust Position Guard | 无 | `isDustPosition()`:剩余保证金 < 0.3U 或 < 初始的 12% → 判定为尘埃 |
| 6 | 极小剩余合理收尾 | 无 | 两处收尾:决策层(减仓后会变尘埃 → 改为 `FULL_CLOSE`)与引擎 `managePositionRisk`(`dust_sweep` 全平 + 决策日志),不再产生碎片成交 |
| 7 | Partial Close 入场费/出场费分摊 | 分摊公式存在但缺少边界校验 | 保留按"原始数量比例"分摊;补齐 `entry_notional_closed` / `remaining_margin_after` / `remaining_notional_after`;测试断言"各次分摊之和 ≤ 原始入场费、最后一笔不重复收费" |
| 8 | 最后极小仓位手续费异常 | 碎片名义下费用占比失真 | 尘埃收尾避免极小切片;`tiny_slice`(切片名义 < 0.01U)标记不可用于学习 |
| 9 | 杜绝 -2624% 虚假 Return | `return_pct = net / (entry × closed_qty)` —— 用**碎片名义**做分母 | 新增 `isValidReturnPct(v, leverage)`(上限 = 杠杆×100% + 25% 余量);越界一律 `return_pct = null`(不造假),同时给出**仓位级** `return_on_position_pct = net / 仓位保证金` |
| 10 | Short / Long 不同退出节奏 | 两者共用一套阈值 | `PROFIT_LOCK_LIMITS`:`short` 最短持有 5min / 最小间隔 6min / 单次上限 100%;`long` 30min / 15min / 50% |
| 11 | Long 不应几分钟内切光 | 无最短持有 | Long 最短持有 30 分钟(期间只推进止损,不产生成交);Long 单次减仓上限 50% |
| 12 | Risk / Stop 不受最短持有限制 | 无旁路 | `risk_exit` 旁路最短持有与最小间隔;止损/强平走独立退出路径(不受影响) |
| 13 | Position 级统计为主口径 | 只看单笔成交,碎片污染笔数/胜率 | 新增 `summarizePositions()`(按仓位聚合:净额/费用/事件数/仓位级收益/持有时间/盈亏比);模拟页统计区改为显示"仓位胜率(主口径)/完整仓位/成交事件" |
| 14 | Partial Close 是 Position Event | 无标记 | 部分平仓成交新增 `position_id` / `parent_position_id` / `position_event: true` |
| 15 | Learning Dataset 不被重复 Partial 污染 | 部分平仓本就不产生样本,但碎片事件仍可能进杠杆学习 | 杠杆学习重建与样本生成都排除 `invalid_for_learning` / 越界收益样本 |
| 16 | 旧异常数据标记 `invalid_for_learning` | 无 | 启动迁移标记三类:`tiny_slice` / `shredded_cluster`(同仓位 10 分钟内被切 ≥3 次) / `return_out_of_range`;**绝不修改历史金额** |
| 17 | CSV 补齐字段 | 列不足 | 新增 `position_id / parent_position_id / position_event / remaining_quantity_after / remaining_margin_after / remaining_notional_after / entry_fee_allocated / exit_fee / position_margin / entry_notional_closed / notional_closed / leverage_source / return_on_position_pct / invalid_sample / invalid_for_learning / repair_reason` |
| 18 | AUTO leverage 是否一直回退 2x | `leverageRecords` 从不落库,刷新即清零 → `requestLeverage` 永远"样本不足,保持 Champion 2x" | `init()` 用**已平仓成交**重建学习记录(不建新表、不改账本);持仓记录 `leverage_source`(MANUAL / AUTO:`scope` / AUTO:fallback_sample_short);新增 `leverageDiagnostics()`,系统状态显示「AUTO 杠杆 样本 N · 仅回退 Champion / 可学习」 |
| 19 | Attribution 默认按完整 Position | 按单笔成交统计 | `attributionOf` 默认 `level="position"`(先剔除异常样本 → 再按仓位聚合),视图标注"按完整仓位统计" |
| 20 | 回归测试 | — | 新增 `tools/test-trade-integrity.mjs` **34 项**;`check-artifacts` 增加 13 条守卫(状态机/尘埃/仓位事件/CSV 字段/归因口径/只标记不改账/AUTO 重建) |

## 测试与构建

```
node tools/test-trade-integrity.mjs   → 34 passed, 0 failed   (复现 → 修复后全绿)
node tools/run-tests.mjs              → 32/32 套 · 2387 断言 · 0 failed
node tools/check-artifacts.mjs        → 104 passed, 0 failed
gradlew assembleDebug                 → BUILD SUCCESSFUL
```

## 最终报告(按要求格式)

- **PROFIT LOCK**:PASS(状态机:同一 Stage 只执行一次;最小间隔 + 单次上限;实测 12 次连续 tick 仅 1 次减仓)
- **DUST GUARD**:PASS(剩余 < 0.3U 或 < 初始 12% → 一次性收尾;减仓后会变尘埃时直接全平)
- **FEE ALLOCATION**:PASS(分摊和 ≤ 原始入场费;最后一笔不重复收费;极小切片费用合理)
- **RETURN SANITY**:PASS(越界 return 一律置空 + 新增仓位级 `return_on_position_pct`;真实账本里那条 -2624.73% 已标记)
- **SHORT/LONG EXIT**:PASS(Short 5/6 分钟节奏 · Long 30/15 分钟 + 单次上限 50%;Long 几分钟内只推止损)
- **POSITION STATS**:PASS(113 条事件 → 8 个完整仓位;模拟页与归因均以仓位为主口径)
- **LEARNING FILTER**:PASS(105 条历史碎片/越界样本标记 `invalid_for_learning`,金额未改;杠杆学习与漂移检测均排除)
- **AUTO LEVERAGE**:PASS(修复"刷新清零 → 永远 2x":跨重启重建学习记录 + `leverage_source` 记录 + 诊断可见)
- **CSV EXPORT**:PASS(补齐 16 个字段,含 margin/notional/剩余数量/费用分摊/杠杆来源/仓位事件/仓位级收益)
- **ACCOUNTING**:PASS(账户不变量与恒等式测试全绿;历史金额零改写)
- **FULL REGRESSION**:32/32 套 · 2387 断言 · 0 failed
- **APK BUILD**:BUILD SUCCESSFUL
- **APK PATH**:`D:\binance-signal-site\android\app\build\outputs\apk\debug\app-debug.apk`(4.18 MB · sha256 `22fe7b3eff2c9c7c…`;副本 `dist\apk\binance-quant-monitor-v15-paper.apk`)
- **UNRESOLVED**:
  1. 历史 110 条 stage4 事件是**修复前**产生的,本轮只标记不改账(按你要求"不修改历史账目");它们的 net 金额仍计入账户已实现盈亏 —— 若要把这批碎片从账本里剔除,需要你确认后单独做一次"账务回滚",本轮未做。
  2. `shredded_cluster` 判定阈值(10 分钟 ≥3 次)与尘埃门槛(0.3U / 12%)是保守取值,后续可按真实分布调优。
  3. AUTO 杠杆目前仍以 Champion 2x 起步;要看到实际升档需要积累足够新样本(旧样本已按仓位级过滤)。
  4. 设备端仍未验证实时行情开仓(模拟器出网被 Binance 地理拦截,`upstream_451`)——与本轮修复无关,属既有环境限制。
