// tools/test-mobile-ui.mjs · V14.1 移动端 UI 测试
// A 视图模型(纯函数) B 请求代际/旧响应丢弃 C 页面结构断言 D 引擎单一实例 E 无 Demo 假数据
import fs from "node:fs";
import path from "node:path";
import worker from "../worker/index.js";
import { createRequestManager } from "../worker/src/ui/requestManager.js";
import { homeViewModel, paperViewModel, detailViewModel, chatViewModel, marketRow, learningViewModel, stateLabel, fmtUsdt, fmtPct, fmtHold } from "../worker/src/ui/viewModels.js";
import { createPaperEngine, MODE_CONFIG } from "../worker/src/paper/engine.js";
import { createHistoryStore } from "../worker/src/history/store.js";
import { summarizeTrades } from "../worker/src/paper/accounting.js";

const ROOT = path.resolve(import.meta.dirname, "..");
let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log("PASS  " + name); }
  else { failed += 1; console.log("FAIL  " + name + (detail ? "  => " + detail : "")); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}

console.log("== A. 视图模型(真实数据 → 渲染字段) ==");
const snapshot = {
  state: "RUNNING",
  account: { initial_balance: 10, cash_balance: 6, total_equity: 10.38, realized_pnl: 0.2, unrealized_pnl: 0.18, fees_paid: 0.02, max_drawdown_pct: 1.2 },
  wallets: { short: { allocated_balance: 5.12, available_balance: 4.1, reserved_balance: 1 }, long: { allocated_balance: 5.26, available_balance: 4.9, reserved_balance: 0.3 } },
  positions: [{ position_id: "p1", symbol: "BTCUSDT", mode: "short", side: "LONG", entry_price: 100, current_price: 101, entry_notional: 1, unrealized_pnl: 0.01, entry_time: 1700000000000, stop_price: 98, take_profit_price: 104 }, { position_id: "p2", symbol: "ETHUSDT", mode: "long", side: "SHORT", entry_price: 50, current_price: 49, entry_notional: 1, unrealized_pnl: 0.02, entry_time: 1699000000000 }],
  today: summarizeTrades([{ net_pnl: 0.2, mode: "short", exit_time: 1700000000000 }, { net_pnl: 0.18, mode: "long", exit_time: 1700000000000 }]),
  all_time: summarizeTrades([{ net_pnl: 0.38, mode: "short", exit_time: 1700000000000 }])
};
const home = homeViewModel({ snapshot, todayTrades: [{ net_pnl: 0.2, mode: "short", exit_time: 1700000000000 }, { net_pnl: 0.18, mode: "long", exit_time: 1700000000000 }], learning: { champion: "lightgbm-v3" }, risk: { risk_level: "Low", risk_score: 22 } });
eq("首页:今日模拟盈亏", home.today_pnl_text, "+0.38 USDT");
eq("首页:总模拟资产", home.total_equity_text, "10.38 USDT");
eq("首页:短线资产与今日", [home.short_equity, home.short_today_text], [5.12, "+0.20 USDT"]);
eq("首页:长线资产与今日", [home.long_equity, home.long_today_text], [5.26, "+0.18 USDT"]);
eq("首页:当前持仓数", home.open_positions, 2);
eq("首页:今日操作数", home.today_trades, 2);
eq("首页:风险等级", home.risk_level, "低");
eq("首页:引擎状态文案", home.state_label, "自动模拟运行中");
check("首页:学习状态白话", /学习正常/.test(home.learning_status), home.learning_status);
check("首页:运行中标记", home.running === true);
const emptyHome = homeViewModel({ snapshot: { state: "STOPPED", account: { initial_balance: 10, total_equity: 10 }, wallets: {}, positions: [], today: summarizeTrades([]), all_time: summarizeTrades([]) } });
eq("空账户:今日盈亏为 0(不造假)", emptyHome.today_pnl_text, "0.00 USDT");
eq("空账户:持仓 0", emptyHome.open_positions, 0);
check("空账户:不显示伪造收益", emptyHome.today_pnl === 0 && emptyHome.all_time_pnl === 0);

const paper = paperViewModel({ wallets: snapshot.wallets, positions: snapshot.positions, trades: [{ trade_id: "t1", symbol: "BTCUSDT", mode: "short", side: "LONG", entry_price: 100, exit_price: 102, net_pnl: 0.5, return_pct: 2, holding_ms: 7200000, exit_reason: "take_profit", exit_time: 1700000000000 }], now: 1700000000000 + 3600000 });
eq("模拟页:持仓行数量", paper.positions.length, 2);
eq("模拟页:持仓 PnL 文案", paper.positions[0].pnl_text, "+0.01 USDT");
check("模拟页:持仓时间格式化", /小时|分钟|天/.test(paper.positions[0].holding), paper.positions[0].holding);
eq("模拟页:成交列表", paper.trades.length, 1);
eq("模拟页:成交收益", paper.trades[0].net_text, "+0.50 USDT");
eq("模拟页:退出原因透出", paper.trades[0].reason, "take_profit");
check("模拟页:双池标签", paper.short.label === "短线" && paper.long.label === "长线", JSON.stringify([paper.short.label, paper.long.label]));

const detail = detailViewModel({
  analysis: { symbol: "BTCUSDT", price: 100, direction: "Bullish", confidence: 62, market_regime: { label: "Weak Uptrend" }, structure: { label: "上涨结构" }, timeframes: { "15m": "Bullish", "1h": "Strong Bullish", "4h": "Neutral" } },
  interval: "1h", positions: snapshot.positions, price: 100, change24h: 1.8,
  risk: { risk_level: "Low", risk_score: 25, risk_flags: [] }, decision: { action: "open_long" }
});
eq("详情:币种显示", detail.symbol_display, "BTC/USDT");
eq("详情:综合状态偏多", detail.bias, "偏多");
eq("详情:风险中文", detail.risk_level, "低");
check("详情:策略状态", /短线|长线|暂不操作/.test(detail.strategy), detail.strategy);
check("详情:带当前持仓", detail.position && detail.position.mode_label === "短线", JSON.stringify(detail.position && detail.position.mode_label));
eq("详情:持仓浮动 PnL 文案", detail.position.pnl_text, "+0.01 USDT");
check("详情:多周期保留", Object.keys(detail.timeframes).length === 3);
const detailNoPos = detailViewModel({ analysis: { symbol: "SOLUSDT", direction: "Neutral" }, positions: [], interval: "4h" });
check("详情:无持仓时不显示持仓块", detailNoPos.position === null);
eq("详情:震荡判定", detailNoPos.bias, "震荡");
const chart = chatViewModel({ detail: { symbol_display: "BTC/USDT", interval: "1h", price: 100, bias: "偏多", risk_level: "低", position: { mode_label: "短线", side: "做多", pnl_text: "+0.01 USDT", holding: "2 小时" } } });
check("Chat:标题含币种", /BTC\/USDT/.test(chart.title), chart.title);
check("Chat:上下文行", /BTC\/USDT · 1h/.test(chart.context_line), chart.context_line);
check("Chat:建议问题含拿多久/为什么买", chart.suggestions.some((s) => /拿多久/.test(s)) && chart.suggestions.some((s) => /为什么不买/.test(s)), JSON.stringify(chart.suggestions));
check("Chat:持仓行", /短线 做多/.test(chart.position_line), chart.position_line);
const row = marketRow({ symbol: "ETHUSDT", lastPrice: "2698.5", priceChangePercent: "-1.2", quoteVolume: "3000000000" }, new Set(["ETHUSDT"]));
eq("市场行:显示格式", row.display, "ETH/USDT");
eq("市场行:涨跌文案", row.change_text, "-1.20%");
eq("市场行:自选标记", row.watched, true);
eq("格式化工具", [fmtUsdt(1.2), fmtPct(-0.5), fmtHold(5400000), stateLabel("PAUSED")], ["+1.20 USDT", "-0.50%", "1.5 小时", "已暂停"]);

console.log("== B. 请求代际(防旧响应覆盖) ==");
const rm = createRequestManager();
const first = rm.begin("detail");
check("首次请求为当前代", first.isCurrent() === true);
const second = rm.begin("detail");
check("新请求使旧代失效", first.isCurrent() === false && second.isCurrent() === true);
let overwritten = false;
first.commit(() => { overwritten = true; });
check("旧代 commit 被丢弃(不覆盖 UI)", overwritten === false);
let applied = false;
second.commit(() => { applied = true; });
check("新代 commit 生效", applied === true);
const stats = rm.stats();
eq("统计:丢弃次数", stats.discarded, 1);
rm.leave("detail");
check("离开页面后旧代失效", second.isCurrent() === false);
rm.leaveAll(["paper"]);
check("离开全部:活动请求清空", rm.stats().active === 0);
// 快速切换 BTC → ETH:旧 BTC 响应必须被丢弃
const btcReq = rm.begin("detail");
const ethReq = rm.begin("detail");
let btcApplied = false;
btcReq.commit(() => { btcApplied = true; });
check("BTC→ETH 快速切换:旧 BTC 结果不覆盖", btcApplied === false && ethReq.isCurrent() === true);
check("AbortController 可用", typeof ethReq.signal !== "undefined" && (typeof AbortController === "undefined" || ethReq.signal instanceof AbortSignal), typeof ethReq.signal);

console.log("== C. 页面结构断言 ==");
const pageRes = await worker.fetch(new Request("https://app.local/"));
const html = await pageRes.text();
const navPages = [...html.matchAll(/class="nav-btn[^"]*" data-page="([^"]+)"/g)].map((m) => m[1]);
eq("底部导航 4 项且为 首页/市场/模拟/我的", navPages, ["home", "market", "paper", "settings"]);
check("导航文案正确", ["首页", "市场", "模拟", "我的"].every((t) => html.includes(`<span class="nav-text">${t}</span>`)), JSON.stringify(navPages));
check("不存在第五个 AI 导航", !/data-page="ai"/.test(html));
for (const id of ["page-home", "page-market", "page-paper", "page-detail", "chatSheet", "chatFab", "chatInput", "hmTodayPnl", "hmStartBtn", "hmPauseBtn", "pfPositions", "mkList", "dtCanvas", "dtPeriods", "openLearning"]) {
  check("存在元素 " + id, html.includes(`id="${id}"`));
}
const refIds = [...new Set([...html.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]))];
const definedIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const missing = refIds.filter((id) => !definedIds.has(id));
check("所有 $() 引用的元素都存在", missing.length === 0, missing.join(","));
check("旧功能未删除(历史验证/回测/WalkForward/数据导出/ML/健康检查入口仍在)", ["openValidation", "openBacktest", "openWalkforward", "openDataset", "openMl", "openHealth"].every((id) => html.includes(id)));
check("旧页面仍在 DOM(monitor/scan/watch)", ["page-monitor", "page-scan", "page-watch"].every((id) => html.includes(id)));
check("首页不展示技术指标术语(Bull/Bear/Drift/Champion)", !/id="hmLearning"[\s\S]{0,400}(Bull|Bear|Drift|Champion)/.test(html));
const v14Css = html.slice(html.indexOf("V14.1 移动端"), html.indexOf("</style>"));
check("无 AI Demo 风样式(新增样式块无霓虹/毛玻璃/渐变)", !/backdrop-filter|text-shadow:\s*0 0|linear-gradient/i.test(v14Css), v14Css.slice(0, 80));

console.log("== D. Paper 引擎单一实例 wiring ==");
const pageSrc = fs.readFileSync(path.join(ROOT, "worker/src/ui/page.js"), "utf8");
check("引擎通过单例获取", /let paperApi = null;/.test(pageSrc) && /if \(!paperApi\) \{/.test(pageSrc) && /paperApi = \(async \(\) =>/.test(pageSrc), "缺少单例守卫");
// §67 说明:V16.2w P0 起引导改为"每步独立兜底"(try/catch + bootFail 记录 BOOT_FAILED),不再有裸 `void initMobileUI();`,
// 旧断言(字面量 void initMobileUI(); 出现 1 次)随形态失效。新断言验证真实需求不变:全脚本只初始化一次,
// 且初始化带失败记录(不允许静默死亡)。
const initCallCount = (pageSrc.match(/(?<!function )initMobileUI\(\)/g) || []).length;
check("initMobileUI 只初始化一次(流程内调用一次)", initCallCount === 1, String(initCallCount));
check("initMobileUI 引导带失败记录(bootFail,不静默)", /uiInit\.catch\(\(error\) => bootFail\("initMobileUI"/.test(pageSrc), "缺少 bootFail 兜底");
// §67 说明:旧断言要求 start/pause 内联写在按钮监听器里(300 字符窗口内出现 eng.start())。
// V16.2u 起按钮改走【幂等入口】startPaperFromHome / pausePaperFromHome(连点只执行一次,后台运行时前台不重复拉起),
// 内联写法已不成立 —— 新断言验证真实需求:入口确实调用引擎 start/resume/pause,且带 paperStartBusy 幂等守卫。
check("首页按钮接 engine.start/pause/resume(经幂等入口)",
  /hmStartBtn"\)\.addEventListener\("click", \(\) => \{ void startPaperFromHome\(\); \}\)/.test(pageSrc)
  && /hmPauseBtn"\)\.addEventListener\("click", \(\) => \{ void pausePaperFromHome\(\); \}\)/.test(pageSrc)
  && /async function startPaperFromHome\(\)/.test(pageSrc)
  && /st === "PAUSED" \? await eng\.resume\(\) : await eng\.start\(\)/.test(pageSrc)
  && /async function pausePaperFromHome\(\)/.test(pageSrc)
  && /await eng\.pause\("用户暂停"\)/.test(pageSrc)
  && /if \(paperStartBusy\) return \{ ok: false, reason: "busy" \}/.test(pageSrc));
check("导航切换只取消 UI 请求(不停止引擎)", /RM\.leaveAll\(\["paper"\]\)/.test(pageSrc) && !/pause\(.*nav-btn/.test(pageSrc));
check("Paper Loop 与 UI 解耦(定时器独立)", /paperLoopTimer = setInterval/.test(pageSrc));
check("Retention 定时执行", /retentionTimer = setInterval/.test(pageSrc));
check("Chat 有本地回答兜底", /answerLocally\(question, context\)/.test(pageSrc) && /catch \(error\) \{\s*diagLog\("chat-ai"/.test(pageSrc));
check("DeepSeek 经服务端调用(前端无 Key)", /api\("ai\/review/.test(pageSrc) && !/sk-[A-Za-z0-9]/.test(pageSrc));
const aiRes = await worker.fetch(new Request("https://app.local/api/ai/review?symbol=BTCUSDT&interval=1h"));
const aiBody = await aiRes.json();
check("AI Review 路由存在且无 Key 时回退", aiRes.status === 200 && aiBody.ok === false && aiBody.reason === "no_server_key", JSON.stringify(aiBody));
check("源码不含可用凭据字面量", !/api[_-]?key\s*[:=]\s*["'][A-Za-z0-9_-]{16,}/i.test(pageSrc) && !/sk-[A-Za-z0-9]{20,}/.test(fs.readFileSync(path.join(ROOT, "worker/src/routes.js"), "utf8")));

console.log("== E. 引擎在 UI 场景下仍遵守资金规则 ==");
const store = await createHistoryStore({ memory: true });
let clock = 1700000000000;
const eng = createPaperEngine({
  store: { get: (t, k) => store.generic.get(t, k), all: (t) => store.generic.all(t), put: (t, r) => store.generic.put(t, r) },
  now: () => clock,
  riskCheck: () => ({ veto: false }),
  fetchKlines: async () => []
});
await eng.init();
await eng.start();
const open1 = await eng.openPosition({ mode: "short", symbol: "BTCUSDT", direction: "Bullish", signal_timestamp: clock, quote: { price: 100, received_at: clock }, analysis: { direction: "Bullish", volatility: { atrPct: 1 }, market_regime: { label: "Weak Uptrend" } } });
check("UI 场景下可开仓", open1.ok === true, JSON.stringify(open1).slice(0, 100));
const dupOpen = await eng.openPosition({ mode: "short", symbol: "BTCUSDT", direction: "Bullish", signal_timestamp: clock, quote: { price: 100, received_at: clock }, analysis: { direction: "Bullish" } });
check("重复点击不会重复开仓(幂等)", dupOpen.ok === false && dupOpen.reason === "duplicate_idempotency_key");
clock += 7200000;
const loop = await eng.loop({ quotes: { BTCUSDT: { price: 103, high: 104, low: 102, received_at: clock } }, candidates: [] });
check("Loop 在 UI 驱动下可运行", loop.ok === true && loop.state === "RUNNING", JSON.stringify(loop.summary));
const home2 = homeViewModel({ snapshot: eng.snapshot() });
check("首页视图能读到真实账户(V14.2 为 100 USDT)", home2.initial_balance === 100 && typeof home2.total_equity === "number", JSON.stringify({ i: home2.initial_balance, e: home2.total_equity }));
check("引擎状态与 UI 状态一致", ["RUNNING", "PAUSED"].includes(eng.getState()) && home2.state === eng.getState(), eng.getState());
eq("模式配置仍为短线 1h / 长线 4h", [MODE_CONFIG.short.interval, MODE_CONFIG.long.interval], ["1h", "4h"]);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("MOBILE UI TESTS OK");
