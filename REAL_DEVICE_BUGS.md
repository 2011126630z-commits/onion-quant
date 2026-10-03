# REAL_DEVICE_BUGS · V16.1 真机 UI 审计(含 V19 手机 UI 第二轮)

设备：**vivo V2502A（PD2502）· Android 16 / API 36 · arm64-v8a · 1260×2800 @560dpi（override 490 ≈ 3.06 DPR）· 手势导航 · 自动旋转关闭**
ADB 序列号：`10AG1T2NH8004N9`（`adb devices` = device，已授权）
当前真机 APK：`dist/apk/binance-quant-monitor-v161-ui2.apk`（4.49 MB，sha256 `fadfcbfde32cc47431f61acddcd06624fb699050fa2e84ebbcce2ac8450bbbc4`）
截图目录：`docs/real-device/v16-ui/`（语义副本在 `docs/screenshots/`）

> 命名约定：`NN-页面-before/after.png` 用于修复对照;`v19-*.png` 为本轮(V19 手机 UI 第二轮)证据。

---

## RD-001 · Coin Detail 图表工具行重叠 + 按钮文字折行
- **页面**：币种详情（ETH/USDT 1h）
- **复现**：真机打开任意币种详情 → 看 K 线下方工具行
- **严重程度**：**P1**（可读性破坏：三块信息互相压叠，四个按钮的中文被折成两行）
- **Before**：`docs/real-device/v16-ui/07-btc-detail-before.png`
- **Root Cause**：`.chart-tools` 是 `display:flex; justify-content:space-between` 且 **不换行**，但里面塞了 7 个子元素（手势提示文案 + 成交量 + 收盘倒计时 + 4 个按钮）。真机 CSS 视口只有 ~411 px 宽，flex 项被压缩 → 长文案折成 3 行、按钮文字换行、互相重叠。（电脑浏览器 1263 px 宽时不复现，所以之前没发现。）
- **Changed Files**：`worker/src/ui/page.js`（`.chart-tools` 改 `flex-wrap: wrap` + `gap: 6px 8px`；`.chip { white-space: nowrap; flex: 0 0 auto; padding: 4px 10px }`；`#dtChartHint { display: none }`；`#dtCloseCount { white-space: nowrap }`）
- **状态**：**FIXED**

## RD-002 · 图表工具行下方出现一块空的浅色圆角块
- **页面**：币种详情
- **严重程度**：**P2**（视觉噪点）
- **Before**：`07-btc-detail-before.png`（工具行与"综合状态"之间）/ `docs/real-device/runtime-verification/rd002-browser-before.png`（411px 复现,量到 `#dtReview` 是 30px 空卡）
- **Root Cause(V16.1-RV 定位，非"猜"）**：CSS 里**没有通用 `.hidden` 规则** —— 各组件只写了 `.chart-empty.hidden` / `.offline-bar.hidden` 这类复合选择器;而 `#dtReview`(`class="card hidden"`)、`#dtDetails`、`#dtExternalBody`、`#dtExitFsBtn` 依赖裸 `class="hidden"` 契约 → 空的复盘卡一直以 30px 空圆角块外露,详情/外部情报折叠失效、非全屏也显示"退出全屏"。
- **Changed Files**：`worker/src/ui/page.js`(补唯一规则 `.hidden { display: none !important; }`;**没有对承担布局职责的元素下 display:none**;`#dtReview` 仍由 `renderReviewBlock` 自行增删 hidden)
- **验证**：浏览器 411px:空块消失(工具行与"综合状态"间距 62px → 1px)、三个折叠块与"退出全屏"按钮显隐全部正确(`rd002-browser-after.png`);静态守卫进 check-artifacts
- **状态**：**FIXED(浏览器实测;真机 After 截图待手机交还后补)**

## RD-003 · 市场页 AI 悬浮按钮遮挡右侧价格/涨跌幅
- **页面**：市场（也适用于首页/模拟页等 FAB 常驻页）
- **严重程度**：**P2**
- **Before**：`02-market-before.png` / `02-market-after.png`（AI 圆钮压在 LINK 行的价格区）
- **Root Cause**：FAB 固定在 `right:16px; bottom:108px+safe`，浮在滚动的列表之上；列表滚到底时最后一行没有“避让区”，且滚动过程中 FAB 始终盖在右列价格上。
- **Changed Files**：`worker/src/ui/page.js`
  - 滚动时 FAB 淡出：`scroll` 监听（passive）加 `.fab-dim`（opacity 0 + 下移 10px + 不接收点击），停止滚动 600ms 后自动恢复；
  - 四个 FAB 常驻页滚到底预留 FAB 区域：`#page-home, #page-market, #page-paper, #page-detail { padding-bottom: calc(168px + env(safe-area-inset-bottom)) }`。
- **验证**：浏览器 411×914 CSS 视口实测——滚动中 `fab-dim=true`（连续采样），停下 1.5s 后恢复；滚到底时列表最后一行 bottom=746 < FAB top=754（**净空 8px**）。**真机**：`v19-14-market-top.png`（静止时 FAB 可见=入口常在）、`v19-15-fab-during-scroll.png`（**滚动中 FAB 完全淡出，右侧价格无遮挡**）、`v19-16-market-bottom.png`（滚到底：末行 ETH/USDT 完整在 FAB 与胶囊上方）；模拟页 `v19-03-paper-bottom.png` 同样滚到底末块完整。
- **状态**：**FIXED（真机截图确认）**

## RD-004 · 市场页列表最后一行被悬浮导航胶囊半遮挡
- **页面**：市场
- **严重程度**：**P2**
- **Root Cause**：页面底部预留不足（与 RD-003 同一类问题：悬浮元素与滚动内容争空间）。
- **Changed Files**：同 RD-003（168px 预留同时覆盖胶囊 96px 与 FAB 区域）。
- **验证**：模拟页真机滚到底（`v19-03`）最后一行完整;市场页此前 `02b-market-bottom-after.png` 已验证滚到底 PASS。
- **状态**：**FIXED**

## RD-005 · 「我的」页每行右侧的 `›` 被渲染成带边框的灰色方块
- **页面**：我的
- **严重程度**：**P2**（观感偏重、像按钮）
- **Before**：`06-settings-before.png`
- **Root Cause**：箭头用 `<span class="pill gray">›</span>` 渲染，`.pill` 自带 `background: var(--panel-2)` + 最小宽度，视觉上像按钮。
- **Changed Files**：`worker/src/ui/page.js`（V19 重排中箭头改纯文字 `.sg-chev`（无底色、无边框）;`sg-rows` 内的灰徽标 `.pill.gray` 也退成纯文字）。
- **验证**：`v19-05-me-top.png` / `v19-06-me-bottom.png`：所有行右侧只剩淡色箭头。
- **状态**：**FIXED**

## RD-020 · 模拟页整页手机化重排（主资产卡 / 双池子卡 / 2 列统计 / 技术信息折叠）
- **页面**：模拟
- **严重程度**：**P1（用户点名）**
- **Before**：`03-paper-before.png` / `04-paper-before.png`（一行塞多个数字、统计 9 格小字表格、技术长说明占满首屏）
- **Root Cause**：桌面式信息堆叠，未按手机阅读顺序分层。
- **Changed Files**：`worker/src/ui/page.js`（结构+CSS+渲染函数）、`worker/src/ui/viewModels.js`（`paperViewModel` 增加每池 `open_positions/today_net(_text)` 与账户 `total_equity(_text)`）
  - 主资产卡：总资产最大 → 今日/累计 → 次级小字 可交易 / 已占用 / 保护池（来源 `poolLayers()` 官方分层访问器）;
  - 短线池 / 长线池两张独立子卡：可用额度 / 持仓数 / 今日盈亏 / 状态;
  - 操作区 2+1：第一行 暂停新开仓 + 导出记录，第二行 紧急全平（仅描边危险色，双击式 confirm 保留）;
  - 当前持仓改精简卡：币种/方向/当前盈亏/保证金/杠杆/持仓时间，**点击进 Position Detail**（详情页仍有平仓入口与全部技术字段）;
  - 统计区改 **2 列指标卡 ×4 行**：净收益·手续费 / 胜率·Profit Factor / 最大回撤·平均持仓 / 交易次数·Fee Drag（Fee Drag 与 overtrading/tradeAnalysis 同口径：手续费÷正毛利润）;
  - 底部「详细统计 · 技术信息」`<details>` **默认折叠**（净值窗口/强平/清洗口径说明/归因/原始事件数）;
  - 空状态紧凑行：「当前没有模拟持仓 · Paper 引擎仍在监控机会」。
- **验证**：真机 `v19-02-paper-top.png` / `v19-03-paper-bottom.png` / `v19-04-paper-adv.png`
- **状态**：**FIXED（真机截图确认）**

## RD-021 · 「我的」页六组重排 + 通知 6 开关移入子页 + 主题改 Bottom Sheet
- **页面**：我的
- **严重程度**：**P1（用户点名）**
- **Before**：`06-settings-before.png`（卡片过多过高、通知 6 个开关挤在主页、主题是原生下拉框）
- **Changed Files**：`worker/src/ui/page.js`
  - 六组：**账户·App / 外观 / 市场与自选 / 学习与验证 / 通知 / 系统**;每组一个圆角容器 + 行间细线（`.sg-rows`），不再逐行套 Card;行高 ≥52px;
  - **主题模式**：点整行 → Bottom Sheet（跟随系统/浅色/深色 + 当前值 ✓），选完即落盘 `quantSettings.themeMode` 并即时换肤;原生 `<select id="themeMode">` 已删除（构建守卫会检查它不再存在）;
  - **通知设置子页**（`page-ntfset`）：6 类开关（开仓/平仓/风险/系统/重大消息/模型更新）从主页移入;主页只留 提醒开关（总开关）+ 通知设置入口（显示"已开 N/6"）+ 通知中心（未读红徽标）;
  - 灰徽标在设置组内退成纯文字，箭头统一 `›` 纯文字。
- **验证**：真机 `v19-05-me-top.png`（账户·App/外观/市场与自选 + 主题行"深色 ›"）、`v19-06-me-bottom.png`（学习与验证/通知【已开 4/6、徽标 9】/系统）、`v19-07-theme-sheet.png`（Sheet + 深色✓）、`v19-08-theme-light.png`（浅色真实换肤）、`v19-08b-theme-dark-restored.png`（已还原深色）、`v19-09-notify-mixed.png`(混合 4/6)、`v19-10-notify-all-on.png`（全开 6/6）、`v19-11-notify-all-off.png`（全关 0/6）、`v19-13-notify-default-restored.png`（恢复默认后入口"已开 4/6"复核）
- **状态**：**FIXED（真机截图确认）**

## RD-022 · 后台运行时模式下，两池可用额度 / 首页资产显示 0.00、分层资金无数据
- **页面**：模拟 / 首页（仅真机：引擎跑在后台运行时 WebView，页面拿的是只读 Viewer）
- **严重程度**：**P1（数据真实性：显示成 0 会被误读为"没钱了"）**
- **Before**：`04-paper-before.png`（旧版模拟页同样显示 0.00 —— 长期存在，非本轮引入）
- **Root Cause**：只读 Viewer 的缓存表清单里**没有 `paper_wallets`**，`snapshot().wallets` 恒为 `{}`;且 Viewer 没暴露 `poolLayers()`（主页/模拟页分层数字无从计算）。
- **Changed Files**：`worker/src/ui/page.js`（`refreshNativeViewerCache` 增读 `paper_wallets` 并按 mode 建表;`snapshot()` 返回真实 wallets;Viewer 新增 `poolLayers()`——只用持久化账本（cash/reserved/unrealized/profit_pool）套引擎同款公式，**不创建第二个引擎、不改任何交易逻辑**）
- **验证**：真机 `v19-02-paper-top.png`：总资产 100.00 · 可交易 100.00 · 已占用 0.00 · 保护池 0.00；短线池可用 70.00 / 长线池可用 30.00（与 70/30 分配一致）
- **状态**：**FIXED（真机截图确认）**

## RD-023 · 无交易时"Profit Factor"显示 1.00（空集合默认值被当成成绩）
- **页面**：模拟（统计区）
- **严重程度**：**P2（数据真实性）**
- **Before**：`04-paper-before.png` 旧版"盈亏比 1.00"
- **Root Cause**：`summarizePositions` 在"无亏损也无盈利"时 `profit_factor` 返回 1，UI 直接展示。
- **Changed Files**：`worker/src/ui/page.js`（`posStats.positions === 0` 或 `profit_factor == null` → 显示 `--`）
- **验证**：真机 `v19-03-paper-bottom.png`（Profit Factor `--`）
- **状态**：**FIXED（真机截图确认）**

## RD-024 · 【P0】后台运行时从未推进:行情接线把同步函数当 Promise
- **范围**：真机后台 Runtime（服务内 `runtime-host.js`）
- **严重程度**：**P0**（运行时"看起来在跑"——进程活、通知在、状态在回报;实际每一轮 tick 都在行情处抛 TypeError:`fetchTickersWithFailover(...).then is not a function`;`loops` 恒 0、`consecutive_failures: 78`,从未开过一仓）
- **Before 证据**：真机 logcat `last_error:"MARKET_PROVIDER_BLOCKED"` + detail 上述 TypeError;preflight 记录在 `runtime-verification-log.txt`
- **Root Cause**：`bridge.httpGet` 是同步 JNI 调用,`fetchTickersWithFailover()` 是同步函数（返回对象）;`runtime-host.js` 两处写成 `fetchTickersWithFailover().then(...)`。
- **Changed Files**：`tools/runtime-host.js`（改 `async () => fetchTickersWithFailover().tickers`）
- **验证**：真机 logcat `market:{"ok":true,"state":"HEALTHY","provider":"primary"}`、`last_error:null`;**新增两道守卫**:check-artifacts 静态守卫 + `tools/test-runtime-boot.mjs`（Node 沙箱**原样运行** runtime-host.js 跑通完整 tick,12 断言）
- **状态**：**FIXED（真机确认）**

## RD-025 · 【P0】PAUSED 死锁:暂停后命令邮箱停摆,RESUME 永远送不进来
- **范围**：Paper Runtime
- **严重程度**：**P0**（真机实测:一条 PAUSE 命令执行后运行时**永久停住**——tick 早退 → 不消费命令邮箱 → UI 的 RESUME 没有机会被执行）
- **Changed Files**：`worker/src/paper/runtime.js`（PAUSED 时仍持续轮询并执行命令、只禁止交易,返回 `paused_commands_only`）
- **验证**：`test-runtime-verify §6b`（暂停 → 投递 RESUME → 下一次 tick 消费命令并救活,断言回到 RUNNING）
- **状态**：**FIXED（单测覆盖）**

## RD-026 · 【P1】陈旧 UI 命令"迟到执行"（积压数小时的 PAUSE 在恢复后被补执行）
- **范围**：Runtime 命令邮箱
- **严重程度**：**P1**（违反"恢复后不许盲目补执行旧命令";真机实测:19:02 新运行时刚跑起来就被几小时前积压的 PAUSE 停住）
- **Changed Files**：`worker/src/paper/runtime.js`（`expireStaleCommands` 纯函数 + `COMMAND_TTL_MS=10min`）、`tools/runtime-host.js`（过期命令标记 FAILED(expired),只有新鲜命令进入执行）
- **验证**：`test-runtime-verify §6b`（过期进 FAILED、未过期照常）
- **状态**：**FIXED（单测覆盖）**

## RD-027 · 通知点击"全部只打开首页"
- **范围**：通知深链（规格 §50）
- **严重程度**：**P2**
- **Changed Files**：`PaperForegroundService`（每条通知独立 requestCode + `ntf_kind/ntf_title` extras）、`MainActivity`（`onNewIntent` + `pendingNotification()` 取走即清空）、`page.js`（`applyNotificationRoute` 按 kind 路由）、`viewModels.notificationRoute`（纯函数路由:交易类→币种详情;系统/风险→诊断;学习→我的;兜底→模拟）
- **验证**：`test-runtime-verify §10`（5 类路由断言）;静态守卫进 check-artifacts
- **状态**：**FIXED（单测+守卫;真机点击复测待手机交还）**

---

## 真机已确认正常（不是"看着像"）
| 项 | 证据 |
|---|---|
| APK 安装（v161-ui2） | `adb install -r` → Success（手机解锁状态下） |
| 模拟页新布局 + 真数据 | `v19-02`/`v19-03`/`v19-04`：主资产卡、双池 70/30、2 列统计、技术信息默认折叠/可展开 |
| 我的页六组 | `v19-05`/`v19-06`：六组、行间细线、纯文字箭头与徽标、下拉整行化 |
| 主题 Bottom Sheet | `v19-07`/`v19-08`/`v19-08b`：点整行开 Sheet → 浅色真实换肤 → 深色还原 |
| 通知设置子页 6 行 | `v19-09`（混合 4/6）/`v19-10`（全开 6/6）：开关 44×26 完全在轨道内，无半截白圆 |
| 底部导航 | 各截图胶囊正常、选中态正确 |
| 状态栏/系统手势条 | 内容与胶囊均未被压 |

---

## 待复核 / 未完成（不许写成已完成）
1. **拍摄中途用户取走过手机一次**（18:14 切到微信）→ 当时按"前台不在我们 App 就停手"的纪律中止触控;18:18 用户把 App 交还前台后继续,「全关态 / 恢复默认 / 市场 FAB」证据全部补齐（`v19-11`、`v19-13`、`v19-14/15/16`）。
2. **通知 6 行**“逐行”颗粒度：`v19-09/10/11` 三张整卡截图每行清晰可读；按最严标准，逐行单拍（每行一张特写）未做。
3. RD-002（详情页工具行下空浅色块）依然 **OPEN**（本轮未动详情页）。
4. 未测（沿用上轮清单）：K 线手势、键盘弹起遮挡、真机 100 轮导航压力与内存、真机后台 tick 增长、`dumpsys gfxinfo` 帧率。
