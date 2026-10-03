# V15 · MODULE EXPANSION 验收报告（模块化 Runtime）

**授权范围**:本轮允许自主新增模块。已按"少而真"执行——**每个模块都做到 IMPLEMENTED + WIRED + TESTED**,没有留空壳。
Paper Only 不变:`REAL_TRADING_ENABLED=false` / `REAL_FUTURES_ENABLED=false`。

## 1. 新增模块(9 个,全部已接线 + 已测试)

| 模块 | 文件 | 用途 | 接线点(WIRED) | 测试 |
| --- | --- | --- | --- | --- |
| **A. Portfolio Risk Controller** | `paper/portfolioRisk.js` | 账户/分池/单币暴露/杠杆暴露/回撤/保证金占用/当日亏损 → **一份**风险结论:`risk_level / risk_budget_pct / max_position_size / max_leverage / allow_new_entry / allow_add_position / veto_reasons` | 引擎 `currentRisk()`;`loop` 里 `riskVetoForCandidate` **最终 Veto**(否决即 `summary.risk_veto`);系统状态页显示等级 | 20 项 |
| **B. Position Manager** | `paper/positionManager.js` | 持仓生命周期唯一状态机(OPEN/ADD/HOLD/PARTIAL_CLOSE/FULL_CLOSE/STOP/TP/TRAIL/BREAK_EVEN/LIQUIDATION/MANUAL_CLOSE)+ 审计 + 手动改止损/止盈校验 | 引擎开仓/平仓/提止损全部经它迁移并留审计;`eng.adjustStop/adjustTakeProfit` 只走它 | 16 项 |
| **C. Execution Simulator** | `paper/execution.js` | 唯一成交口径:市价/限价/价差/滑点/手续费/部分成交/reduce-only/强平钳制 | `closePosition` 用它做成交校验与强平钳制;成交报告写进 trade(`trade.execution`) | 15 项 |
| **D. Data Quality Sentinel** | `paper/dataQuality.js` | 过期/缺失/乱序/重复/0价/NaN/Inf/provider 冲突/异常跳变/外部数据过期 → 质量差即**禁新 Entry**(已有仓位继续管理) | 引擎 `applyQuoteToPosition` 每次写价前必过;风险控制器读 `gate()`;系统状态页显示 | 17 项 |
| **E. Background Task Manager** | `paper/taskManager.js` | 后台任务统一登记:状态/last_run/next_run/error/retry_count/退避 | 页面 6 个定时任务全部改走 `taskBag.runOnce()`(paper-loop / position-risk / market-intel / research / retention / ui-render) | 14 项 |
| **F. Notification Manager** | `paper/notifications.js` | 六类渠道 + 去重(按渠道+key)+ 冷却 + 优先级 + 已读未读 + Android 渠道映射 | 引擎 `notify()` 先过渠道策略;`nativePushQueue` 供原生桥 | 12 项 |
| **G. Decision Journal** | `paper/decisionJournal.js` | 每次动作留"为什么":开仓/不开/杠杆/部分平仓/提止损/退出(Rule/ML/Prediction/Risk/External/DeepSeek/Final) | 引擎开仓/平仓/否决/提止损写入;AI Chat 接入(可回答"刚才为什么卖 BTC") | 11 项 |
| **H. Crash Recovery** | `paper/recovery.js` | 异常退出后一致性自检:不可能亏损→强平、止损早已穿越→平仓、残留订单、半途同步、引擎状态残留、reserved 对账 | `init()` 启动即跑并出报告 + 系统通知 | 8 项 |
| **I. Equity Analytics** | `paper/equityAnalytics.js` | 24h/7d/30d 净值、净收益、最大回撤、回撤修复时间、盈亏比、手续费、强平次数 | 模拟页「统计」区(实测渲染成功) | 11 项 |

## 2. 需求清单对应情况

- **P0(要求优先)**:Portfolio Risk Controller ✅ · Position Manager ✅ · Execution Simulator ✅ · Data Quality Sentinel ✅ · Background Task Manager ✅ · **Manual Control**(暂停/恢复/部分平仓/全平/调止损/调止盈/紧急全平,全部走引擎与 Position Manager)✅ · **Crash Recovery** ✅
- **P1(本轮完成)**:Profit Protection(既有 `profitLock.js`,已由 Position Manager 统管其动作与审计)· Future Prediction(既有 `predictor.js`,统一入口)· Market Intelligence Hub(既有 `dataHub.js + externalData.js`,缓存键强制含 symbol)· **Decision Journal** ✅ · **Notification Manager** ✅ · Performance Attribution(见下方"延后")
- **P2(延后,未做空壳)**:Shadow Lab(已有 `leverageManager` Shadow + `profitLock` Shadow 基础)· Strategy Sandbox · Replay/Debug · Stress Tester
- **已存在、本轮只做收口的**:Market Intelligence Hub(`dataHub.js`)· Prediction Manager(`predictor.js`)· Storage/Migration(`history/store.js` + `integrityRepair`)· App Health Monitor(我的>系统状态,已扩成模块健康面板)· Event Bus(**未做** —— 现有耦合未达到必须引入事件总线的程度,按"不做无意义大重构"原则跳过)

## 3. 新模块在真实运行中发现并修掉的 4 个缺陷

1. **`execCloseOrder is not defined`(P0)** —— 扁平 bundle **不支持别名导入**(`import { a as b }` 只剩原名),导致主循环的**平仓路径整体失效**。已改为原名导入,并加产物守卫"禁止别名导入"。
2. **组合风险永久 HARD_STOP(P0)** —— 我先把**历史最深回撤**`max_drawdown_pct`当成"当前回撤"喂给风控,一次深回撤后再也开不了仓。已改为用 `peak_equity → 当前 equity` 计算**当前回撤**,历史最深回撤只作参考。实测已恢复 `NORMAL`。
3. **通知去重可能吞掉风险告警** —— 去重按 key 跨渠道生效,同 key 的 RISK 会被 TRADE 吃掉。已改为**按渠道+key**。
4. **任务错误状态被"启动"清掉** —— `start()` 把 ERROR 重置为 IDLE,健康面板会看不到失败。已改为错误保留到下次成功。

（另有 2 处模块内部缺陷由新测试直接抓到:强平成交报告返回了未钳制的参考价;手动调整审计缺 symbol 字段,导致按 symbol 过滤丢失记录。）

## 4. 测试与产物

- `node tools/run-tests.mjs` → **28/28 套 · 2218 断言 · 0 failed**
  - 新增 `tools/test-modules-v16.mjs`(114 项:9 个模块各自行为 + **引擎级接线断言**:风险否决、决策日志写入、审计、手动调整、串价拦截、成交报告、账户不变量)
  - `check-artifacts.mjs` 增至 91 项(新增"模块进产物/接线存在/未用别名导入"守卫)
- APK:`android/app/build/outputs/apk/debug/app-debug.apk`(**4.16 MB**,sha256 `52e9c1fb0edde5ca…`,versionName `15.0.0-paper`)——包内已确认:模块名与页面接线标记全部存在、裸 `num(` 计数 0、`dist/app` 与 assets 逐字节一致。

## 5. 实测运行状态(真实浏览器)

```
position-risk:OK runs=2      (修复前:ERROR err=execCloseOrder is not defined)
组合风险 NORMAL · 数据质量 行情数据正常 · 后台任务 后台任务正常 · 启动自检 状态正常 · 决策日志 1 条
模拟页「统计」:净收益 -0.09% · 最大回撤 0.09% · 手续费 0.03U · 24h/7d/30d 净值 · 盈亏比 · 强平次数 0
平仓面板:调止损/调止盈 控件就位(含当前止损/止盈显示);放宽止损被拒 stop_widen_forbidden(符合设计)
控制台:无未捕获异常
```

## 6. 未做 / 已知限制(不隐瞒)

1. **Strategy Sandbox / Replay / Stress Tester / Shadow Lab 未实现** —— 按优先级只在 P2,不做空壳;现有 `backtest/walkforward/soak` 已覆盖部分回放能力。
2. **Performance Attribution 未实现** —— PnL 仍未按 策略/币种/Regime/杠杆/模型/退出策略 分组统计(Equity Analytics 只做到账户级)。这是下一轮最该补的 P1。
3. **Event Bus 未引入** —— 判断当前耦合尚未达到需要它的程度。
4. **加仓(ADD)仍无真实路径** —— Position Manager 已支持 ADD 语义与门禁(`allow_add_position`),但没有量价合并实现。
5. **APK 未在物理真机安装验证**;20 秒风险轮次仍依赖页面存活(进程被杀不会评估)。
