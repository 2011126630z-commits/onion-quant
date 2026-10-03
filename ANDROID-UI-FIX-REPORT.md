# ANDROID UI FIX REPORT · V19「手机 UI 第二轮」真机报告

设备：**vivo V2502A · Android 16 / API 36 · 1260×2800 @560dpi（override 490 ≈ 3.06 DPR,CSS 视口 411×914）· 手势导航**
本轮 APK：`dist/apk/binance-quant-monitor-v161-ui2.apk`（4.49 MB,sha256 `fadfcbfde32cc47431f61acddcd06624fb699050fa2e84ebbcce2ac8450bbbc4`,已装真机）
真机截图：`docs/real-device/v16-ui/v19-*.png`（语义副本：`docs/screenshots/`）
缺陷台账：`REAL_DEVICE_BUGS.md`（RD-020/021/022/023 新增,RD-003/004/005 关闭）
**本轮只动 UI 层与只读展示层;Accounting / Entry Gate / Capital Allocator / Profit Allocation / HWM / Risk / Position / Learning 一行未改。**

---

## 一、本轮四件事 × 验收表

| # | 事项 | 真机结论 | 证据 |
|---|---|---|---|
| 1 | **模拟页整页重排**（主资产卡→今日/累计→次级小字分层；Short/Long 独立子卡=可用额度/持仓数/今日盈亏/状态；操作区 2+1；持仓精简卡点击进详情；统计改 2 列指标卡；技术长说明默认折叠；空状态紧凑行） | ✅ **PASS** | `v19-02-paper-top.png`（首屏）、`v19-03-paper-bottom.png`（统计 2 列 + 折叠行 + 滚到底末行完整）、`v19-04-paper-adv.png`（展开后净值窗口/清洗口径/归因） |
| 2 | **「我的」页六组重排**（账户·App / 外观 / 市场与自选 / 学习与验证 / 通知 / 系统；一组一容器 + 细线;去大灰 pill/层层 Card/重阴影） | ✅ **PASS** | `v19-05-me-top.png`（上半）、`v19-06-me-bottom.png`（下半;通知入口“已开 4/6”、未读徽标 9） |
| 3 | **主题 Bottom Sheet**（点整行 → 跟随系统/浅色/深色;不再用原生 select） | ✅ **PASS** | `v19-07-theme-sheet.png`（Sheet 打开,深色带 ✓）、`v19-08-theme-light.png`（浅色真实换肤）、`v19-08b-theme-dark-restored.png`（深色已还原） |
| 4 | **通知设置 6 行逐行复拍**（6 类开关移入子页;主页只留总开关+入口） | ✅ **PASS** | `v19-09-notify-mixed.png`（混合 4/6）、`v19-10-notify-all-on.png`（全开 6/6）、`v19-11-notify-all-off.png`（全关 0/6）、`v19-13-notify-default-restored.png`（恢复默认后主页入口显示"已开 4/6"）——6 行每行清晰可读、开关 44×26 全部在轨道内 |
| 5 | **AI FAB 避让**（滚动不挡列表右列价格;滚到底留出 FAB 区域） | ✅ **PASS** | 真机:`v19-14`（静止时 FAB 可见 = 入口常在）、`v19-15`（**滚动中 FAB 完全淡出**,右侧价格无遮挡）、`v19-16`（滚到底:末行 ETH/USDT 完整在 FAB 与胶囊上方）。浏览器 411px 实测:`fab-dim` 连续采样 true、停下 1.5s 恢复;滚到底末行 bottom=746 < FAB top=754（净空 8px） |

**顺带修复的两个真实数据问题（有真机证据）**：
| # | 问题 | 结论 | 证据 |
|---|---|---|---|
| 6 | 后台运行时模式下两池可用额度/首页资产显示 0.00、分层资金 `--`（只读 Viewer 没读 `paper_wallets`、没暴露 `poolLayers`） | ✅ FIXED | `v19-02`：可交易 100.00 · 已占用 0.00 · 保护池 0.00;短线池 70.00 / 长线池 30.00 |
| 7 | 无交易时 Profit Factor 显示 1.00（空集合默认值） | ✅ FIXED（改 `--`） | `v19-03` |
| 8 | RD-005 `›` 灰方块 / 大灰 pill | ✅ FIXED | `v19-05`/`v19-06`（箭头与徽标均为纯文字） |

---

## 二、实现要点（都落在 `worker/src/ui/page.js` 与 `worker/src/ui/viewModels.js`）

**模拟页**（DOM 重写 + 渲染函数重写）
- 主资产卡 `.pf-hero`：总资产 30px 最大;今日/累计一行;次级小字**只用引擎官方 `poolLayers()`**（可交易 = cash−保护池、已占用 = reserved、保护池 = profit_pool.protected_balance）。
- 双池子卡 `.pf-pools`（2 列）：数据来自 `paperViewModel` 扩展字段（`open_positions` / `today_net`，today 用 `dayKeyOf` 真实口径）。
- 操作区：`.hm-actions` 第一行两个按钮（`flex:1 1 calc(50% - 5px)`），`紧急全平` 加 `.wide` 独占第二行;危险色**只描边不铺底**;二次确认逻辑（双击 confirm）原样保留。
- 持仓卡：只放 币种/方向 + 盈亏金额 + (策略·杠杆·持仓时间) + (保证金·盈亏比例);点击 `openDetail(symbol, interval)` 进 Position Detail（详情页保留全部技术字段与「平仓」入口,能力未丢）。
- 统计：`#pfMetrics` 2 列 × 4 行指标卡（净收益/手续费/胜率/Profit Factor/最大回撤/平均持仓/交易次数/Fee Drag）;Fee Drag 与 `overtrading.js`/`tradeAnalysis.js` 同口径（fees ÷ 正毛利润）。
- 技术信息：`<details class="pf-adv">` 默认折叠,展开区里长行改上下两行（窄屏不被 CJK 断行挤坏）;原净值窗口/清洗口径说明/归因/原始事件数全部保留在内。
- `#pfStatsBox` 与 `renderPaperStats` 名称保留（构建守卫依赖）。

**我的页**（DOM 重写）
- 六组：账户·App（重置模拟账户 + 性能浮层）/ 外观（主题）/ 市场与自选（默认交易对/扫描数量/刷新间隔/行情监控/自选列表）/ 学习与验证（学习状态/历史验证/历史回测/滚动验证/机器学习验证/数据导出）/ 通知（提醒开关 + 通知设置入口 + 通知中心）/ 系统（量化内核/系统状态/系统诊断/行情健康检查）。
- 结构：`.sg-rows`（一组一张卡）→ `.sg-row`（≥52px,行间细线）;箭头 `.sg-chev`（纯文字、无底无框）;组内 `.pill.gray` 透明化。
- 主题：删除 `<select id="themeMode">`;`openThemeSheet/syncThemeUI` 同步当前值;选择后 `saveSettings + applyTheme` 即时换肤。
- 通知设置子页 `page-ntfset`：6 个 `switch` 原 id 保留（`ntfSetTrade…ntfSetModel`）,主页 `#ntfSetValue` 显示"已开 N/6",开关切换即落盘并刷新入口文案。

**FAB 避让**
- `.fab.fab-dim`（滚动中淡出）;四个 FAB 常驻页 `padding-bottom: calc(168px + env(safe-area-inset-bottom))`（胶囊 96px + FAB 区）。

**只读 Viewer 增强（RD-022,不改任何交易逻辑）**
- `refreshNativeViewerCache()` 增读 `paper_wallets` 并按 `mode` 建表;`snapshot().wallets` 返回真值;新增 `poolLayers()`（持久化账本 + 引擎同款公式）。

---

## 三、构建 / 测试基线（本轮最终态）

- `node tools/build.mjs` ✅（QEngine 623 exports;页面内联脚本语法校验通过）
- `node tools/run-tests.mjs` → **38/38 套件 OK · 3777 passed / 0 failed**（含 `test-nav-stress` 45、`check-artifacts` 219→**226**（新增 7 条 V19 UI 守卫）、`test-mobile-ui` 85、`test-v15` 95、`test-chat-session` 46）
- APK：`node tools/build-android.mjs` → `npx cap sync android` → `gradlew.bat assembleDebug` ✅ BUILD SUCCESSFUL;包内 `assets/public/app.html` 已核验包含 `pfMetrics / page-ntfset / themeSheet / sg-rows / fab-dim` 全部新结构
- Android 构建资源含本轮全部改动（对齐 memory 的“字节级核验”要求:对 app.html 做了字符串包含核验）

---

## 四、未完成 / 未验证（不许当已完成）

1. **拍摄中途用户取走过手机一次**（18:14 切到微信使用）→ 当时按纪律立即停止触控;18:18 用户把 App 交还前台后继续拍摄,**后续"全关态/恢复默认/市场 FAB"三组证据全部补齐**。备注:那一批落空的 tap 未造成开关状态污染（恢复默认后已复核"已开 4/6"）。
2. 通知 6 行按"每行单独一张特写"的最严颗粒度未做（现有三张整卡截图每行清晰可读：`v19-09/10/11`）。
3. RD-002（详情页工具行下空浅色块）仍 **OPEN**（本轮未动详情页）。
4. 未测（沿用上轮清单）:K 线手势、键盘弹起遮挡、真机 100 轮导航压力与内存、真机后台 tick 增长、`dumpsys gfxinfo` 帧率。

---

## 五、效率教训（可复用）

- **同一个"点整行"动作,坐标要按当前截图重测**:主题 Sheet 里选项行距与我目估的不同,一次误点把 Sheet 当遮罩关掉了（浅色→深色还原多花两轮）。规矩:凡是**弹出层里的目标**，先截图量位置再点。
- **`timeout /t` 在无控制台的 Bash 工具里不可用**（"不支持输入重定向"直接退出,等待全部失效）;设备侧等待一律用 `adb shell "input tap ...; sleep N"`。
- **只读 Viewer 与页面直连引擎是两套接口面**:浏览器里能用的 accessor（poolLayers）在真机后台运行时模式下可能是 null —— 新增 UI 读数时，两条路径都要覆盖并真机验证。

---

## 附录 A · 上一轮（Switch 越界 / 安全边距 / 导航）内容（保留）

<details>
<summary>展开上一轮报告（V16.1 真机 UI 修复轮）</summary>

# ANDROID UI FIX · Switch 越界 / 安全边距 / 导航 真机修复报告

设备：**vivo V2502A · Android 16 / API 36 · 1260×2800 @560dpi（CSS 视口 411×914）· 手势导航**
真机截图：`docs/real-device/v16-ui/`（`10-notify-settings-after.png`、`10b-notify-rows-after.png`）
已安装并真机验证的 APK：`dist/apk/binance-quant-monitor-v161-ui.apk`

---

## ROOT CAUSE

**Switch 越界（P0，真机录屏里那排「屏幕右侧半截白圆」）**

不是 padding 问题，也不是 transform 写错，而是**元素类型错了**：

```html
<div class="hm-row"><span class="k">开仓提醒</span><span class="v"><span class="switch on" id="ntfSetTrade"></span></span></div>
```

```css
.switch { position: relative; width: 50px; height: 28px; }      /* ← <span> 是 inline 元素 */
.switch::after { position: absolute; left: 3px; width: 20px; }   /* 滑块 */
.switch.on::after { left: 25px; }
```

- `.switch` 是 **`<span>`（inline）**，而 **inline 元素会忽略 `width` / `height`** → 轨道实际宽度不是 50px，而是一个「零宽内联盒」。
- 滑块 `::after` 是 `position: absolute; left: 25px`，包含块是那个零宽内联盒 → **ON 态滑块被推到该行行尾再向右 25px**，越过卡片内边距、越过页面安全边距、越过视口 → 屏幕上出现一排被裁掉一半的白色圆。
- 为什么同一个组件有的正常有的不正常：`#notifySwitch`（"提醒开关"）是 **`<button>`**，button 默认 `inline-block` → width 生效 → 显示正常；而通知设置里那 6 个是 **`<span>`** → 越界。
- 同时 `.hm-row` 的子项缺少 `min-width: 0`，长内容会把行顶宽，加剧横向溢出。

**页面贴边（上一轮的 P0）**：`.page` 区块是 `<body>` 的直接子节点、**不在 `.app` 里**（真机同宽实测 `.app{display:none;width:0}`）→ 边距加在 `.app` 上完全无效；「我的」看着不贴边是因为那一页自己写了内边距。

---

## SWITCH FIX（统一移动端组件）

```css
.switch {
  position: relative; display: inline-block; flex-shrink: 0;   /* ← 关键:inline-block 让尺寸生效 */
  width: 44px; height: 26px; box-sizing: border-box;
  border-radius: 999px; border: 1px solid var(--line); background: var(--panel-2);
  vertical-align: middle;
}
.switch::after { position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: left 180ms ease; }
.switch.on::after { left: 21px; }             /* 3 + 18 + 3 = 44:滑块恒在轨道内 */
```

## SAFE AREA FIX（唯一 Layout Token）

- 统一落在 `.page`：`padding: calc(10px + env(safe-area-inset-top)) 16px calc(96px + env(safe-area-inset-bottom))`;`.app` 左右内边距清零。
- 底部：导航 `bottom: calc(12px + env(safe-area-inset-bottom))`;内容预留 96px + safe-area。
- 全部走 `env(safe-area-inset-*)`，没有写死任何设备像素。

## BOTTOM NAV CHANGES

- 去掉 `backdrop-filter` → 近不透明纯色 `--nav-solid` + 轻边框 + 轻阴影 + `contain: layout paint`。
- `.nav-btn` 38 → 52px;切页 300ms → 200ms，仅 `opacity/transform`。

## 真机验证（上一轮）

| 项 | 真机结论 | 证据 |
|---|---|---|
| Switch 不再越界 / 右侧无半截白圆 | ✅ | `10-notify-settings-after.png`、`10b-notify-rows-after.png` |
| 页面不贴边 / 滚到底不被导航挡住 | ✅ | `02-market-after.png`、`02b-market-bottom-after.png` |
| 导航无残影（300 次快速切换） | ✅ | `.build/mm2.png` |
| Runtime 单实例（含横竖屏切换） | ✅ | logcat `runtime webview created` 仅 1 次 |
| 帧率 | 757 帧 / Janky 1.19% / 50th 7ms | `dumpsys gfxinfo` |
| 通知设置 6 行逐行复拍 | ⚠️ 上一轮未逐行复拍 | 本轮已补混合态/全开态两张大图（见上） |

</details>
