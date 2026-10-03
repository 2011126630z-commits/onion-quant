# V15 P0 HOTFIX · FUTURES ACCOUNTING / PRICE ROUTING 验收报告

**范围**:只做资金与仓位数字的可信度修复,未新增任何交易功能。Paper Only 不变(`REAL_TRADING_ENABLED=false` / `REAL_FUTURES_ENABLED=false`)。

## ROOT CAUSE(逐条对应截图异常)

| 截图现象 | 根因(带锚点) |
| --- | --- |
| BNB 现价 27.12 / BTC 现价 2712、浮亏 -22.94 / -509.82% | **跨 symbol 串价**:平仓面板用 `eng.snapshot(() => 常量价)` 调引擎,而引擎是**按 symbol 回调**取价(`engine.js` snapshot→`priceOf(p.symbol)`),常量闭包把 ETH 的价格写进了**所有**持仓。已在 UI 侧改为 `priceOfSymbol(sym)` 取值,并在引擎侧新增写入守卫。 |
| 2x 仓位亏超 Margin 仍未 Liquidate | 强平**只在浏览器 5 分钟主循环里**评估(`page.js` 300000ms),引擎恢复后状态是 `STOPPED`(`engine.js` init 强制 STOPPED)→ 没有 tick = 没有强平;UI 8 秒重绘只 `snapshot()` 不带价,显示的是旧快照。 |
| Batch B 亏损远超保证金(已实现) | 强平按 **当前价**结算(若价格跳空/脏,亏损无上限),没有"按强平价成交"的约束。 |
| LONG 爆仓价高于 Entry | 有方向不变量缺失:公式本身方向正确(空头强平价在开仓价上方、多头在下方),但**全项目没有任何断言**保证这一点,也没有第二个实现的一致性(leverageManager 里另有一套硬编码 `0.005` 的公式)。 |
| Stop 已穿越仍 OPEN | ①退出评估依赖主循环(未运行时永不触发);②**移动止损/Break-even 只写 `stop_state`,从不写 `stop_price`**,而 `evaluateExit` 只认 `stop_price` → UI 显示 `fixed @ x` 但永不执行。 |
| 学习样本被污染 | `makeLearningSample` 没有任何有效性字段,手动/强平/离线恢复样本一律入库,`learning_samples` 也没有 `invalid_sample`。 |
| 浮盈被放大 | `unrealizedPnl` 用**原始 quantity** 而非 `remaining_quantity`(部分平仓后系统性放大 1/剩余比例),语义正确的 `futuresUnrealized` 是死代码。 |

## 修复内容

**价格路由 / 数据完整性**
- `engine.applyQuoteToPosition()`:写入前校验 ①返回 symbol 必须等于持仓 symbol(否则丢弃 + 记 `PRICE_SYMBOL_MISMATCH`)②有限正数 ③新鲜度标记。不通过只标 `price_status`,**不动数字**;并立刻 `PAUSE_NEW_ENTRIES` + `DATA_INTEGRITY_ALERT` 通知。
- `accounting.updatePositionPath()`:同样守卫;记录 `price_source`(mark/last)与 `price_updated_at`。
- `portfolio()`:priceOf 返回空/0/NaN 时用上次已校验价,再不行用已存浮盈——**不再回退到开仓价把浮亏静默抹成 0**。
- DataHub `keyOf()`:删除"调用方可自带 key 绕过"的口子,键恒为 `provider|symbol|data_type|interval`。
- 页面 `buildQuotesFromTickers()` 成为**唯一**的 symbol→quote 构建点;无 symbol 的行情一律丢弃。

**PnL / 口径**
- `unrealizedPnl` 改用 `remaining_quantity`(缺失才回退 quantity),方向兼容 `side`/`direction`。
- 新增 `estimatedExitFee` / `unrealizedNetPnl`(毛额 - 预估平仓费,与平仓手续费率一致)、`openMarginOf`。
- UI 分开两个口径:**ROE = 未实现/剩余保证金**(主显示)与 **price_move_pct = 标的涨跌**;不再用被部分平仓改过的 `entry_notional` 当分母。

**强平 / 止损 / 移动止损**
- `liquidationInvariant()`:LONG 必须 `liq < entry`、SHORT 必须 `liq > entry`,否则 `LIQUIDATION_CALC_ERROR` **拒绝创建仓位**(开仓前后各校验一次;`applied` 是纯函数结果,拒绝即回滚)。
- `liquidationFillPrice()` + `applyClose` 强平分支:强平**只能按强平价成交**,跳空/脏价一律按强平价结算 → 单笔亏损被 `lossBoundOf`(保证金 + 入场费 + 平仓费 + 滑点)约束。
- 强平**优先级最高**(先于 Profit Lock / 止盈 / 止损),并新增"亏损穿透保证金 → 立即强平 + 告警"兜底。
- `ratchetStop()`:移动止损/Break-even 的结果**真正写回 `stop_price`**(只允许朝有利方向移动)。
- 新增 `engine.riskPass({quotes})`:**价格刷新即评估**(强平 → 亏损越界 → 移动止损/保本 → 分批止盈 → Profit Lock → 常规退出),不再依赖闭合K线;页面新增 **20 秒** `refreshPositionRisk()`(只查持仓相关 symbol 的单币接口,无持仓零请求)。
- leverageManager 的强平价改为调用 `liquidationPriceOf`(消灭第二套公式)。

**账户 / 样本 / 迁移**
- `accountIntegrityCheck()`:available/reserved/margin/remaining_quantity/notional 非负、equity/PnL 有限、`account.reserved` 与 `Σ entry_notional` 对账一致;开仓/平仓后立即 `snapshot()`(先同步再落库)保证不留中间态。
- `makeLearningSample`:新增 `invalid_sample` / `invalid_reason` / `action_source` / `exit_reason` / `price_status` / `integrity_forced` / `repair_reason`;无效样本**不进 Auto Leverage 学习**、不计入漂移检测。
- `integrityRepair()`(init 启动迁移,幂等):扫 OPEN 持仓/成交/样本;修强平价、复位 mfe/mae、按(现价,剩余量)重算浮盈;价格不可信(会算出穿透保证金的亏损)时**退回持平并标 INVALID**;结构不可修或止损早已穿越的按规则平掉;成交/样本不可能盈亏 → `invalid_sample` + `repair_reason`。

## 实测验证(真实浏览器 · 我先前污染过的真实账户)

启动迁移在重载后自动执行,结果:

```
account.integrity: { ok: true, violations: [] }
engine: price_symbol_mismatch=0 invalid_price=0 impossible_pnl=0 entries_paused=false
BNBUSDT SHORT entry 764.1942  current 763.8    liq 1142.47 (> entry ✅)  price_source=mark  status=OK  roe +0.10%
BTCUSDT LONG  entry 83983.58  current 83788.8  liq 42411.7 (< entry ✅)  price_source=mark  status=OK  roe -0.46%
ETHUSDT LONG  entry 2712.204  current 2705.64  liq 1369.66 (< entry ✅)  price_source=mark  status=OK  roe -0.48%
```
- 被污染的 `current_price=2712 / unrealized=-22.94 / mfe=mae=999` 已被清除,而 ETH 合法的「已平 55% · 剩余 45%」状态**被保留**(只修不可能数据)。
- 三个持仓各自持有自己的 mark 价(763.8 / 83788.8 / 2705.64),无串价;ROE 回到个位数百分比量级。
- 迁移幂等:第二次重载 `repairs=[]`(已修复的不重复处理)。
- 账户 99.97 USDT / 3 持仓 / 2 次操作,`accountIntegrity().ok=true`。

## TESTS

`node tools/run-tests.mjs` → **27/27 套 · 2084 断言 · 0 failed**(新增 `tools/test-futures-integrity.mjs` 82 项;`check-artifacts.mjs` 增至 73 项,新增 P0 产物守卫)。

| 要求 | 状态 |
| --- | --- |
| PRICE SYMBOL ROUTING | PASS(乱序 BNB→ETH→BTC 响应各自落位;symbol 不匹配拒绝写入并暂停开仓) |
| CACHE ISOLATION | PASS(同 provider/type/interval 下 BTC/BNB 互不串,未缓存的 ETH 必须 miss) |
| PNL LONG / PNL SHORT | PASS(entry 100 / margin 10 / 2x / qty 0.2:105→+1、95→-1;方向反之同) |
| LIQUIDATION LONG / SHORT | PASS(1x~10x 双方向不变量 + 强平价处亏损 ≤ 保证金) |
| STOP LONG / SHORT | PASS(穿价后**一个价格轮次内** CLOSED) |
| TRAILING | PASS(候选止损真正写回 `stop_price`,回撤到抬高后的止损即 CLOSED) |
| PARTIAL CLOSE | PASS(数量/保证金/锁定本金同步减半,浮盈按剩余量重算,账户不变量通过) |
| ADD POSITION | PASS(§28:项目**不存在加仓路径** —— 同 symbol 第二笔是独立仓位、各自 margin×leverage=notional,无隐式合并;未新增该功能) |
| ACCOUNT RECONCILIATION | PASS(reserved 与 Σ 锁定本金对账、equity = cash + Σ锁定 + Σ浮盈、available/reserved 非负) |
| INVALID SAMPLE FILTER | PASS(强制平仓样本 `integrity_forced` + `repair_reason`;`price_status=INVALID` 的样本判无效) |
| DIRTY DATA REPAIR | PASS(复刻截图脏数据 → 修复/平掉并留 `repair_reason`;不可能盈亏成交标无效;修复后账户不变量通过) |

## 交付物

- 本报告:`V15-P0-INTEGRITY-HOTFIX.md`
- APK:`android/app/build/outputs/apk/debug/app-debug.apk`(4,327,606 bytes / 4.13 MB,sha256 `a3e13845e150cf7b…`,versionName `15.0.0-paper`),副本 `dist/apk/binance-quant-monitor-v15-paper.apk`
- 包:`binance-quant-monitor-v15-p0.tar`(部署)+ `binance-quant-monitor-v15-p0-source.tar`(源码,含新测试)

## 已知残留(不隐瞒)

1. **加仓功能不存在**:§28 的"加仓后重算 avg_entry/quantity/margin/liquidation"无对应代码路径,本轮按"不新增功能"处理,只验证了不产生隐式合并。
2. **APK 未在物理真机安装验证**(无设备),只做到打包字节级校验(包内 `app.html` 含 `riskPass`/`refreshPositionRisk`,裸 `num(` 计数 0)。
3. **三条 17:05 的 `profit_lock_stage4` 自动部分减仓**是修复前被污染的 MFE 触发的合法代码路径,亏损 -0.004 ~ -0.02 USDT(受保证金约束),部分平仓不产生学习样本,故未污染学习;已如实记录,未追溯改写历史账本。
4. 页面 20 秒风险轮次依赖页面存活(Paper 引擎在浏览器内);进程被杀时仍不会评估——这是 STANDALONE 的限制,未在本轮改变。
