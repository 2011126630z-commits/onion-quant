# V15 · AI CHAT 非驻留改造 验收报告

**目标**:AI 从"常驻页面"改成"需要时出现的轻量 Bottom Sheet",关闭后彻底不消耗资源,但与 24/7 Paper Engine 完全解耦。

## 1. 需求逐条对应

| 需求 | 实现 | 实测 |
| --- | --- | --- |
| **不是常驻页面**(禁止第五个导航/固定聊天窗口) | 无 `page-ai`、无第五个 nav 项;聊天只有 `chatSheet`(Bottom Sheet)+ 右下角 FAB | 页面结构断言通过 |
| **轻量入口按钮**(右下角 AI,不巨大/不发光/无紫蓝渐变) | `<button id="chatFab" class="fab show">AI</button>`,四个主视图(首页/市场/模拟/详情)可用 | FAB 文案 `AI`,样式断言无 glow/渐变 |
| **打开方式**:Bottom Sheet 65%~75% | `.sheet { height: 72% }` | 实测 `height=72%` |
| **向下拖动关闭 / 点击关闭 / 系统返回手势** | touchstart→touchmove(跟手位移)→touchend(阈值 80px 才关);关闭按钮;`popstate` 关闭 Sheet 而不是退出页面 | 手势与返回键逻辑均有断言;关闭按钮实测生效 |
| **关闭后**:卸 UI / 清 Listener / 停动画 / 中断 UI 请求 / 不轮询 / 不耗 Token | `closeChat()`:移除在途气泡、加 `.sheet.closing`(transition:none)、`RM.leave("chat")`;`chatSingleAnswer` 不再访问引擎,上下文一次性注入 | 关闭后 loading 气泡 0、`closing` 类生效、无残留请求 |
| **后台不中断**(Paper Engine / 行情 / Risk / Position / Learning) | 关闭只动 `chat` 请求键;后台任务走 `taskBag`(独立) | 关闭后任务状态不变(全部 IDLE/OK),引擎存活 |
| **记录可保留**(按 symbol 或 conversation_id) | 新模块 `paper/chatSession.js`:按 symbol 建会话,`localStorage` 持久化,重开恢复 | 开→关→开:消息恢复,不重建 Coin Detail |
| **记录上限 + compact_summary** | 每 symbol 默认 40 条,超出挤掉最旧并刷新摘要;摘要硬上限 600 字符 | 60 条压到 20、摘要 ≤上限(修掉一处 off-by-one) |
| **DeepSeek 只收**:question + 最近摘要 + 当前上下文(symbol/position/leverage/pnl/risk/预测/funding/OI/regime/profit lock/journal) | 新增 `limitOutboundContext()` 白名单整形:结构上不可能带历史(`messages`/`history` 等一律剔除),只注入 `chat_summary` + `conversation_id` | 白名单断言 + 违禁字段被剔除断言 |
| **退出 Coin Detail 自动关闭** | `setActivePage` 里:切到非 detail 页且 Chat 打开 → `closeChat({fromNav:true})` | 实测切到市场后 `sheetOpen=false` |
| **切币不串上下文** | 提问时若 `chatActiveSymbol !== 当前 symbol` → 关闭旧会话并提示重新提问 | 逻辑断言 + 会话按 symbol 隔离测试 |
| **生成中关闭可 Abort,但后台决策复核不可取消** | `REQUEST_KINDS` 区分 `USER_CHAT_REQUEST` / `BACKGROUND_DECISION_REVIEW`;`ABORTABLE_KINDS` 只含前者;聊天走 `chat` 键,后台复核走 `paper` 键 | 模块断言 + 页面 `/RM\.begin\("paper"\)/` 与 `/RM\.leave\("chat"\)/` 对照断言 |
| **重开快速恢复** | 打开时只读会话存储渲染,不重新分析/不重新拉行情 | 重复开关问候气泡恒为 1(修掉叠加问题) |
| **UI 要求**:顶部 AI分析 + 当前 Symbol + 关闭 | 头部 = `AI 分析` / `BTC/USDT`(+有仓位时一句持仓摘要)/ 关闭;去掉了产生"风险 undefined"的旧 context_line | 实测头部 `BTC/USDT` |

## 2. 关键实现

- **新模块** `worker/src/paper/chatSession.js`:会话存储(按 symbol、上限、摘要、序列化)、`buildSlimContext`、`limitOutboundContext`(出站白名单)、`REQUEST_KINDS`/`ABORTABLE_KINDS`、`teardownPlan`(关闭清理清单)、`uiIdleState`。
- **解耦**:`chatSingleAnswer` 不再触碰引擎(此前会 `getPaperEngine()` + 读页面状态),上下文由 `sendChat` 一次性构造。于是"关掉界面"= 真的什么都不再发生。
- **生成期间被关闭**:回答回来后若已关闭或气泡已被移除,直接 return,不写 DOM、不再继续后续动作。
- **返回手势**:打开时 `history.pushState`,关闭时 `history.back()`(或来自 popstate 时不重复回退)。

## 3. 测试

- 新增 `tools/test-chat-session.mjs`:**46 项**(会话隔离/上限与摘要/出站白名单/请求类型语义/页面接线/UI 约束)
- 全量:`node tools/run-tests.mjs` → **29/29 套 · 2265 断言 · 0 failed**
- 真实浏览器复核:开(72%)→关(closing、气泡清零、任务不受影响)→重开(记录恢复、问候不叠加)→切页(自动收起)→控制台 0 异常

## 4. 交付物

- APK:`android/app/build/outputs/apk/debug/app-debug.apk`(**4.16 MB**,sha256 `808c32ced6af9a45…`),包内确认 chat FAB/会话模块/白名单整形/自动收起均存在,裸 `num(` 计数 0,`dist/app` 与 assets 逐字节一致
- 包:`binance-quant-monitor-v15-chat.tar` / `-source.tar`

## 5. 未做 / 说明

1. 聊天记录目前只存本地(`localStorage`),不含服务端会话;换设备不同步。
2. 拖动关闭是"跟手位移 + 松手判定",没有做橡皮筋回弹动画(与整体克制风格一致,也符合"停动画"的要求)。
3. DeepSeek 仍是"用户主动提问才调用";未做任何后台定时问答(需求明确禁止)。
