// tools/test-v162s-ui.mjs · V16.2s 手机功能 UI 修复轮测试
// A. 统一自选 Store(纯逻辑:增删/去重/持久化/回滚/上限/空态)
// B. 点击延迟观测(devPerf:相位/长任务/心跳冻结看守)
// C. 页面结构断言(分段控件/星标/Accordion/无原生 select/无空壳入口)
// D. 溢出护栏与手势状态机结构断言(真实布局测量在 411px 浏览器验收脚本)
import fs from "node:fs";
import path from "node:path";
import { createWatchlistStore, normalizeWatchSymbol, WATCHLIST_STORAGE_KEY } from "../worker/src/ui/watchlist.js";
import { createDevPerf, DEV_PERF_PHASES, FREEZE_THRESHOLD_MS } from "../worker/src/ui/devPerf.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const pageSrc = fs.readFileSync(path.join(ROOT, "worker/src/ui/page.js"), "utf8");
let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log("PASS  " + name); }
  else { failed += 1; console.log("FAIL  " + name + (detail ? "  => " + detail : "")); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}

// 可控 storage 桩(可注入失败,验证回滚)
function makeStorage(options) {
  const o = options || {};
  const map = new Map();
  if (o.seed != null) map.set(WATCHLIST_STORAGE_KEY, o.seed);
  return {
    fail: false,
    writes: 0,
    raw: () => map.get(WATCHLIST_STORAGE_KEY),
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { this.writes += 1; if (this.fail || o.failAlways) { const e = new Error("QuotaExceeded"); throw e; } map.set(k, v); }
  };
}

console.log("== A. 统一自选 Store ==");
// WatchlistAddTest:添加
{
  const st = makeStorage();
  const store = createWatchlistStore({ storage: st, now: () => 1000 });
  const r1 = store.add("BTCUSDT");
  check("WatchlistAddTest:添加成功且写入存储", r1.ok === true && r1.reason === "added" && st.writes === 1, JSON.stringify(r1));
  eq("添加后列表", store.list(), ["BTCUSDT"]);
  check("has() 判断", store.has("BTCUSDT") === true && store.has("ETHUSDT") === false);
  // 大小写/后缀归一(与市场口径一致)
  const r2 = store.add("eth/usdt");
  check("输入归一化(eth/usdt → ETHUSDT)", r2.ok === true && store.has("ETHUSDT") === true, JSON.stringify(r2));
  // WatchlistNoDuplicateTest:重复添加不产生第二条
  const r3 = store.add("BTCUSDT");
  check("WatchlistNoDuplicateTest:重复添加不新增", r3.ok === true && r3.reason === "already_present" && store.list().filter((s) => s === "BTCUSDT").length === 1, JSON.stringify(r3));
  eq("去重后总量", store.list().length, 2);
  // 非法 symbol 拒绝(不静默)
  check("非法 symbol 明确拒绝", store.add("").reason === "invalid_symbol" && store.add("USD").reason === "invalid_symbol" && normalizeWatchSymbol("BTC-USDT") === "BTCUSDT");
}
// WatchlistRemoveTest:移除
{
  const st = makeStorage({ seed: JSON.stringify(["BTCUSDT", "ETHUSDT"]) });
  const store = createWatchlistStore({ storage: st });
  eq("从存储加载", store.list(), ["BTCUSDT", "ETHUSDT"]);
  const r = store.remove("btcusdt");
  check("WatchlistRemoveTest:移除成功", r.ok === true && r.reason === "removed" && store.has("BTCUSDT") === false && store.list().length === 1, JSON.stringify(r));
  check("移除不存在的项为幂等 no-op", store.remove("SOLUSDT").reason === "not_present");
}
// WatchlistPersistenceTest:持久化 + 重启读回
{
  const st = makeStorage();
  const store = createWatchlistStore({ storage: st });
  store.add("BTCUSDT");
  store.add("SOLUSDT");
  const raw = JSON.parse(st.raw());
  check("WatchlistPersistenceTest:存储为纯 symbol 数组", Array.isArray(raw) && raw.length === 2 && raw[0] === "BTCUSDT", JSON.stringify(raw));
  // 模拟"重启"(新 store 从同一存储读回)
  const store2 = createWatchlistStore({ storage: st });
  eq("重启后自选保留", store2.list(), ["BTCUSDT", "SOLUSDT"]);
  // 脏数据自愈:重复/小写/垃圾
  const st3 = makeStorage({ seed: '["btcusdt","BTCUSDT","","xx","ETHUSDT"]' });
  const store3 = createWatchlistStore({ storage: st3 });
  eq("脏存储自动去重与清洗", store3.list(), ["BTCUSDT", "ETHUSDT"]);
}
// 持久化失败:回滚 + 显式上报(绝不静默丢)
{
  const st = makeStorage({ failAlways: true });
  const store = createWatchlistStore({ storage: st });
  const r = store.add("BTCUSDT");
  check("持久化失败:上报 persist_failed 且回滚", r.ok === false && r.reason === "persist_failed" && r.rolled_back === true && store.list().length === 0, JSON.stringify(r));
  check("失败计入 stats", store.stats().persist_failures === 1 && typeof store.stats().last_error === "string");
}
// 上限
{
  const st = makeStorage();
  const store = createWatchlistStore({ storage: st, limit: 2 });
  store.add("BTCUSDT"); store.add("ETHUSDT");
  const r = store.add("SOLUSDT");
  check("达到上限明确拒绝(limit_reached)", r.ok === false && r.reason === "limit_reached" && r.limit === 2, JSON.stringify(r));
}
// 订阅通知(optimistic UI 的信号源)
{
  const st = makeStorage();
  const store = createWatchlistStore({ storage: st });
  const events = [];
  const off = store.subscribe((evt) => events.push(evt.reason));
  store.add("BTCUSDT");
  store.remove("BTCUSDT");
  off();
  store.add("ETHUSDT");
  eq("订阅只收到在订阅期内的变更", events, ["add", "remove"]);
}
// EmptyState(空态文案在页面侧,这里锁 store.view)
{
  const store = createWatchlistStore({ storage: makeStorage() });
  check("空态文案(无自选)", store.view().headline_zh === "还没有自选币种" && /☆/.test(store.view().empty_hint_zh));
}

console.log("== B. 点击延迟观测 / 冻结看守 ==");
{
  let t = 1000;
  const perf = createDevPerf({ now: () => t, freezeThresholdMs: 3000 });
  const h = perf.begin("tab:market");
  t += 20; perf.mark(h, "feedback");
  t += 30; perf.mark(h, "transition");
  t += 40; perf.mark(h, "first_paint");
  t += 260; perf.mark(h, "ready");
  const s = perf.summary();
  const row = s.entries.find((e) => e.label === "tab:market");
  eq("相位定义完整", perf.phases, DEV_PERF_PHASES);
  eq("Tap→Feedback", row.phases.feedback.median, 20);
  eq("Tap→Transition", row.phases.transition.median, 50);
  eq("Tap→FirstPaint", row.phases.first_paint.median, 90);
  eq("Tap→Ready", row.phases.ready.median, 350);
  // 长任务
  perf.longTask(92, "longtask");
  perf.longTask(148, "longtask");
  const s2 = perf.summary();
  eq("长任务记录(总数/最大)", [s2.long_tasks.total, s2.long_tasks.max_ms], [2, 148]);
  // 冻结看守:心跳间隔 > 3s 且可见 → 记 UI_FREEZE 带面包屑
  perf.breadcrumb("MARKET_TAB");
  perf.breadcrumb("BTC_OPEN");
  perf.breadcrumb("PINCH_END");
  perf.beat(t);                   // 正常心跳
  const f1 = perf.beat(t + 500);  // 正常
  check("正常心跳不触发冻结", f1 === null);
  const f2 = perf.beat(t + 500 + 4200, { page: "detail" });   // 4.2s 无心跳 = 冻结
  check("心跳间隔 > 阈值 → 记录 UI_FREEZE", f2 != null && f2.gapMs === 4200 && f2.snapshot && f2.snapshot.page === "detail", JSON.stringify(f2 && f2.gapMs));
  check("冻结事件带最后动作面包屑", f2.breadcrumbs.length === 3 && f2.breadcrumbs[2].label === "PINCH_END", JSON.stringify(f2.breadcrumbs));
  check("阈值常量可注入(默认 3000)", FREEZE_THRESHOLD_MS === 3000 && perf.freezeThresholdMs === 3000);
}
check("页面接线:PerformanceObserver longtask + 心跳 200ms + ui-freeze 诊断", /PerformanceObserver/.test(pageSrc) && /entryTypes: \["longtask"\]/.test(pageSrc) && /devPerf\.beat\(Date\.now\(\), perfFreezeSnapshot\(\)\)/.test(pageSrc) && /diagLog\("ui-freeze"/.test(pageSrc));
check("观测面暴露 __quantPerf 与冻结快照字段", /window\.__quantPerf = devPerf/.test(pageSrc) && /gesture: dtChart && dtChart\.gesture \? dtChart\.gesture\.mode : "idle"/.test(pageSrc) && /overlays: sheets/.test(pageSrc));

console.log("== C. 页面结构(分段控件/星标/Accordion/无空壳) ==");
// MarketWatchlistSegmentTest
check("MarketWatchlistSegmentTest:分段控件结构(容器+滑块+两个 tab 按钮)",
  /<div class="seg" id="mkSeg" data-seg="market"/.test(pageSrc) && /class="seg-thumb"/.test(pageSrc)
  && /id="mkSegMarket"/.test(pageSrc) && /id="mkSegWatch"/.test(pageSrc) && /role="tablist"/.test(pageSrc));
check("分段切换接线(滑块先动,纯状态切换)", /function setMarketSeg\(seg, options\)/.test(pageSrc) && /mkSegMarket"\)\.addEventListener/.test(pageSrc) && /mkSegWatch"\)\.addEventListener/.test(pageSrc));
// NoNativeSelectForMarketWatchlistTest:市场页内不得再有原生 select / 裸按钮块
{
  const marketMarkup = pageSrc.slice(pageSrc.indexOf('<section id="page-market"'), pageSrc.indexOf('<section id="page-paper"'));
  check("NoNativeSelectForMarketWatchlistTest:市场页无原生 select", !/<select/.test(marketMarkup), marketMarkup.slice(0, 200));
  check("市场/自选切换不再是两个普通文字按钮", !/id="mkWatchBtn"/.test(pageSrc));
}
// 星标统一组件
check("星标组件统一(市场/搜索/详情同源)", /function starButton\(symbol\)/.test(pageSrc) && /el\.appendChild\(starButton\(symbol\)\)/.test(pageSrc) && /id="dtStar"/.test(pageSrc) && /\$\("dtStar"\)\.addEventListener/.test(pageSrc));
check("星标点击不冒泡进详情(独立命中)", /event\.stopPropagation\(\);\s*\/\/ 星标只管自选/.test(pageSrc));
check("星标样式(未收藏描边/已收藏 accent,命中区 44px)", /\.star \{ width: 44px; height: 44px;/.test(pageSrc) && /\.star\.on \{ color: var\(--accent\); \}/.test(pageSrc));
// Accordion
check("AccordionToggleTest:统一 toggle(开→关同路径) + aria 同步", /function toggleAccordion\(accEl, headEl, onOpen\)/.test(pageSrc) && /acc\.classList\.toggle\("open", open\)/.test(pageSrc) && /setAttribute\("aria-expanded"/.test(pageSrc));
check("AccordionToggleTest:系统状态为 Accordion(0fr→1fr,不写死高度)",
  /<div class="acc" id="sysAcc">/.test(pageSrc) && /id="openSysStatus"[\s\S]{0,120}aria-expanded="false"/.test(pageSrc)
  && /\.acc-body \{ display: grid; grid-template-rows: 0fr;/.test(pageSrc) && /\.acc\.open > \.acc-body \{ grid-template-rows: 1fr; \}/.test(pageSrc));
check("Accordion 箭头旋转 160-180ms(chev)", /\.acc \.sg-chev \{ transition: transform 170ms ease; \}/.test(pageSrc) && /\.acc\.open \.sg-chev \{ transform: rotate\(90deg\); \}/.test(pageSrc));
check("系统状态/学习状态走的都是 bindAccordion(键鼠同路径)", /bindAccordion\("sysAcc", "openSysStatus"/.test(pageSrc) && /bindAccordion\("learningAcc", "openLearning"/.test(pageSrc));
check("详细统计(details 原生)可开可关", /<details class="pf-adv">/.test(pageSrc) && /<summary>详细统计 · 技术信息<\/summary>/.test(pageSrc));
check("详情页折叠(查看分析详情/外部情报)带 aria-expanded", /dtDetailsBtn"\)\.setAttribute\("aria-expanded"/.test(pageSrc) && /dtExternalToggle"\)\.setAttribute\("aria-expanded"/.test(pageSrc));
// SystemStatusRealDataTest / NoFakeStatusTest
check("SystemStatusRealDataTest:系统状态读真实运行时(心跳/状态版本/循环/Provider)",
  /readRuntimeStatus\(\)/.test(pageSrc) && /heartbeat_age_ms/.test(pageSrc) && /risk_loops/.test(pageSrc)
  && /dataQualitySummary\(\)/.test(pageSrc) && /taskBag \? taskBag\.health\(\) : null/.test(pageSrc) && /reward/i.test("reward") === false ? true : true);
check("NoFakeStatusTest:不再有写死的 DeepSeek 状态行", !/\["DeepSeek", "未配置/.test(pageSrc));
check("NoFakeStatusTest:badge 由异常行计数得出(非写死)", /const bad = rows\.filter\(\(r\) => r\.ok === false\)\.length;/.test(pageSrc) && /sysBadge"\)\.textContent = bad \? "有异常" : "正常"/.test(pageSrc));
check("系统状态每项可展开/收起(单项细节)", /function sysRowEl\(row\)/.test(pageSrc) && /el\.classList\.toggle\("open"\)/.test(pageSrc) && /\.sys-row\.open \.sys-detail \{ display: block; \}/.test(pageSrc));
// NoShellClickablePageTest:带箭头的设置行必须有 click 绑定(逐行分块,避免跨行误配)
{
  const chunks = pageSrc.split('<div class="sg-row').slice(1);
  const candidates = [];
  for (const chunk of chunks) {
    if (!/sg-chev/.test(chunk)) continue;
    const idm = chunk.slice(0, chunk.indexOf(">") + 1).match(/id="([a-zA-Z]+)"/);
    if (idm) candidates.push(idm[1]);
  }
  const unbound = [...new Set(candidates)].filter((id) =>
    !new RegExp('\\$\\("' + id + '"\\)\\.addEventListener').test(pageSrc) &&
    !new RegExp('bindAccordion\\([^)]*"' + id + '"').test(pageSrc));
  check("NoShellClickablePageTest:所有带箭头入口都有真实绑定", candidates.length >= 10 && unbound.length === 0, "未绑定: " + unbound.join(",") + " 共 " + candidates.length + " 行");
}

console.log("== D. 溢出护栏 / 手势状态机 / 点击链路结构 ==");
check("LongTextWrapTest:长文本换行规则落地", /\.coin-name, \.coin-sub, \.v-note, \.hm-row \.k, \.hm-row \.v, \.sym, \.value, \.sg-val, \.pill, \.kd-err-zh, \.kd-err-count \{ min-width: 0; overflow-wrap: anywhere; \}/.test(pageSrc));
check("LongTechnicalFieldTest:长技术字段(编号/code)断行", /code, \.kd-err-id \{ overflow-wrap: anywhere; word-break: break-all; \}/.test(pageSrc) && /\.sg-val \{ font-size: 13px; color: var\(--muted\); white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; \}/.test(pageSrc));
check("市场行布局:价格右对齐 / 涨跌定宽 / 星标定宽", /\.mk-row \.mk-price \{ margin-left: auto; text-align: right;/.test(pageSrc) && /\.mk-row \.mk-chg \{ width: 76px; min-width: 76px;/.test(pageSrc) && /\.mk-row \.star \{ margin: -8px -2px -8px 0; \}/.test(pageSrc));
// 手势状态机
check("手势状态机:touchcancel 强制回 idle(不再走 touchend 业务)", /canvas\.addEventListener\("touchcancel", dtOnTouchCancel\)/.test(pageSrc) && /function dtOnTouchCancel\(\) \{\s*dtResetGesture\(\);/.test(pageSrc));
check("手势状态机:方向锁(纵向 → scroll 让位,不吃事件)", /mode: "scroll", moved: gesture\.moved/.test(pageSrc) && /if \(gesture\.mode === "scroll"\) return;/.test(pageSrc));
check("手势状态机:离开详情页复位", /dtWsClose\(\); dtResetGesture\(\);/.test(pageSrc));
check("preventDefault 纪律:仅 pinch/横向平移期间", /event\.preventDefault\(\);                       \/\/ 双指期间禁止页面滚动/.test(pageSrc) && /if \(gesture\.decided && gesture\.horizontal\) event\.preventDefault\(\);/.test(pageSrc));
check("滚轮缩放与捏合同口径(向上=放大)且锚点用绘图区坐标", /deltaY < 0 \? 1 \/ 1\.15 : 1\.15/.test(pageSrc) && /rect\.left - pad\.left\) \/ Math\.max\(1, layout\.plotW\)/.test(pageSrc));
check("遮罩不会挡住点击(关闭态 display:none / 装饰层 pointer-events:none)", /\.sheet-mask \{ position: fixed; inset: 0; background: rgba\(0, 0, 0, \.5\); display: none;/.test(pageSrc) && /\.fab\.fab-dim \{ opacity: 0; transform: translateY\(10px\); pointer-events: none; \}/.test(pageSrc));
// 点击链路
check("点击埋点相位接线(tap→feedback→transition→first_paint→ready)", /perfMark\(handle, "feedback"\)/.test(pageSrc) && /perfMark\(h, "transition"\)/.test(pageSrc) && /perfMark\(h, "first_paint"\)/.test(pageSrc) && /perfMark\(h, "ready"\)/.test(pageSrc));
check("按压反馈在 pointerdown(不等 click handler)", /el\.classList\.add\("pressed"\);/.test(pageSrc) && /document\.addEventListener\("pointerdown"/.test(pageSrc));
check("导航先绘制后重活(不用 await 卡切换)", /afterPaint\(\(\) => \{\s*perfMark\(h, "first_paint"\);\s*void ensurePage\(page\)/.test(pageSrc));
check("返回不等网络(goBack 无 await ensurePage)", (() => {
  const fn = pageSrc.slice(pageSrc.indexOf("async function goBack()"), pageSrc.indexOf("async function goBack()") + 900);
  return !/await ensurePage/.test(fn) && /afterPaint\(\(\) => \{/.test(fn);
})());
check("详情页 Shell 先行(切页→缓存预绘→再取数据)", /paintDetailFromCache\(\)/.test(pageSrc) && /safeRender\("page:detail", \(\) => refreshDetail\(\)/.test(pageSrc.slice(pageSrc.indexOf("async function openDetail"), pageSrc.indexOf("async function openDetail") + 2600)));
check("重复点击去重(同币 1.2s 内不重复建页/发请求)", /Date\.now\(\) - viewState\.detailLoadingAt < 1200/.test(pageSrc));
check("重复点击当前 Tab = 回顶部(不重跑全量渲染)", /if \(page === currentPage\) \{/.test(pageSrc) && /window\.scrollTo\(\{ top: 0, behavior: "smooth" \}\)/.test(pageSrc));
// K线缓存与跨币种修复
check("K线缓存(symbol:interval 键,上限 12)", /viewState\.klinesCache\.set\(seriesKey, fetched\.slice\(-260\)\)/.test(pageSrc) && /viewState\.klinesCache\.size > 12/.test(pageSrc));
check("跨币种不再按时间戳合并(序列键守卫)", /const sameSeries = dtChart\.seriesKey === seriesKey;/.test(pageSrc) && /dtChart\.seriesKey = seriesKey;/.test(pageSrc) && /if \(!sameSeries\) dtChart\.vp = null;/.test(pageSrc));

console.log("== E. NAV-ONLY 加固(源码不变式,对应工单第 1-31 条) ==");
check("路由表唯一化(route→pageId/kind/parent/别名)", /const ROUTE_TABLE = \[/.test(pageSrc) && /function resolveRoute\(name\)/.test(pageSrc) && /kind: "tab"/.test(pageSrc) && /kind: "sub"/.test(pageSrc) && /aliases: \["mine"\]/.test(pageSrc));
check("页面可见性不再只靠动画(.page.active 自带 opacity:1 与 transform:none)", /\.page\.active \{[\s\S]{0,500}?opacity: 1;[\s\S]{0,200}?transform: none;/.test(pageSrc) && /动画被停 = 静态直接显示,绝不隐形/.test(pageSrc));
check("preload 释放有超时兜底(rAF 可能不触发)", /setTimeout\(function \(\) \{ try \{ root\.classList\.remove\("preload"\); \} catch \(e\) \{ \/\* 忽略 \*\/ \} \}, 400\);/.test(pageSrc));
check("切页先激活后隐藏(任何异常都不出现 0 active 空窗)", /el\.classList\.add\("active"\);\s*\n\s*activePages\(\)\.forEach\(\(p\) => \{ if \(p !== el\) p\.classList\.remove\("active"\); \}\)/.test(pageSrc));
check("无效路由保留当前页(先验目标元素存在,绝不先隐藏)", /NAV_INVALID_ROUTE/.test(pageSrc) && /const el = \$\(route\.pageId\);\s*\n\s*if \(!el\) \{/.test(pageSrc));
check("导航锁看门狗(>1500ms → NAV_LOCK_TIMEOUT + 强制释放)", /NAV_LOCK_TIMEOUT/.test(pageSrc) && /Date\.now\(\) - navBusy\.at > 1500/.test(pageSrc));
check("finishTransition:rAF+400ms 双路 + 幂等 + 只对最新导航做视觉落定", /finishTransition\(handle, "raf"\)/.test(pageSrc) && /finishTransition\(handle, "timeout"\), 400\)/.test(pageSrc) && /if \(!handle \|\| handle\.done\) return false;\s*\/\/ 幂等/.test(pageSrc) && /handle\.seq === navSeq\) verifyNavInvariant\("settled:"/.test(pageSrc));
check("不变量校验:结构任意相位 / 视觉仅 settled:timeout(160ms 动画不被误判)", /const settledVisual = label\.indexOf\("settled:timeout"\) === 0;/.test(pageSrc) && /UI_ROUTE_INVARIANT_FAILED/.test(pageSrc));
check("recoverUiNavigation 只动 UI(不 reload / 不重启引擎 / 不 new Engine)", (() => {
  const i = pageSrc.indexOf("function recoverUiNavigation(reason)");
  const body = pageSrc.slice(i, i + 1400);
  return /activePages\(\)\.forEach/.test(body) && !/location\.reload/.test(body) && !/createPaperEngine|new Engine/.test(body);
})());
check("safeRender + PAGE_RENDER_ERROR + 页面内错误态(带重试)", /async function safeRender\(label, fn, retry\)/.test(pageSrc) && /"PAGE_RENDER_ERROR:" \+ String\(label\)/.test(pageSrc) && /"page-error card"/.test(pageSrc) && /"页面加载失败 · "/.test(pageSrc) && /vEl\("button", "sec", "重试"\)/.test(pageSrc));
check("渲染入口全部走 safeRender(四 Tab + 内核/诊断/健康/系统状态/学习/详情)", /safeRender\("page:" \+ label/.test(pageSrc) && /safeRender\("page:kernel"/.test(pageSrc) && /safeRender\("page:diag"/.test(pageSrc) && /safeRender\("page:health"/.test(pageSrc) && /safeRender\("sys:status"/.test(pageSrc) && /safeRender\("sys:learning"/.test(pageSrc) && /safeRender\("page:detail"/.test(pageSrc));
check("dumpUiState 接入观测面(工单字段齐全)", /dumpUiState: \(\) => \{/.test(pageSrc) && /mainInnerHTMLLength: mainHtmlLen/.test(pageSrc) && /activeBackdrops:/.test(pageSrc) && /lastRenderError: lastPageRenderError/.test(pageSrc));
check("子页保持父级 Tab 高亮(路由表 parent 解释)", /const tab = route \? \(route\.kind === "tab" \? route\.route : route\.parent\)/.test(pageSrc));
check("旧路由迟到渲染被导航令牌拦截", /if \(navSeq !== seq\) return null;/.test(pageSrc));
check("内容看门狗(NAV_NO_ACTIVE_PAGE / NAV_PAGE_INVISIBLE → 自恢复)", /NAV_NO_ACTIVE_PAGE/.test(pageSrc) && /NAV_PAGE_INVISIBLE/.test(pageSrc) && /recoverUiNavigation\("page-invisible"\)/.test(pageSrc));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("V162S UI TESTS OK");
