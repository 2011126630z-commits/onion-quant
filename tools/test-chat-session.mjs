// tools/test-chat-session.mjs · V15 AI CHAT 非驻留验收
// 覆盖:按 symbol 会话 / 记录上限与摘要 / 出站白名单(不带历史) / 关闭即中断用户请求但保留后台决策复核 /
//      切币禁止串上下文 / 离开详情自动收起 / 界面断言(轻量入口 + 收起后无残留)
import fs from "node:fs";
import path from "node:path";
import { num } from "../worker/src/paper/accounting.js";
import {
  createChatSessionStore, sessionKeyOf, compactSummary, buildSlimContext,
  limitOutboundContext, teardownPlan, uiIdleState, REQUEST_KINDS, ABORTABLE_KINDS, CHAT_DEFAULTS
} from "../worker/src/paper/chatSession.js";

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log("PASS  " + name); }
  else { failed += 1; console.log("FAIL  " + name + (detail ? "  => " + detail : "")); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}

const ROOT = path.resolve(import.meta.dirname, "..");
const pageSrc = fs.readFileSync(path.join(ROOT, "worker/src/ui/page.js"), "utf8");
const T0 = 1700000000000;

console.log("== 1. 对话按 symbol 保留(不是常驻界面,记录不丢) ==");
{
  const store = createChatSessionStore({ now: () => T0 });
  eq("会话键按 symbol", [sessionKeyOf("BTCUSDT"), sessionKeyOf("ethusdt"), sessionKeyOf(null)], ["BTCUSDT", "ETHUSDT", "GENERAL"]);
  store.append("BTCUSDT", "BTCUSDT", { role: "me", text: "现在适合买吗?" });
  store.append("BTCUSDT", "BTCUSDT", { role: "ai", text: "偏多但风险中等" });
  store.append("ETHUSDT", "ETHUSDT", { role: "me", text: "ETH 呢?" });
  eq("两个 symbol 互不干扰", [store.messages("BTCUSDT").length, store.messages("ETHUSDT").length], [2, 1]);
  check("另一个 symbol 不会串到本会话", store.messages("BTCUSDT").every((m) => !m.text.includes("ETH")));
  check("恢复后仍可读回", store.messages("BTCUSDT")[0].text === "现在适合买吗?");
  const restored = createChatSessionStore({ now: () => T0 });
  restored.loadFrom(store.toJSON());
  eq("序列化/恢复往返一致", [restored.messages("BTCUSDT").length, restored.messages("BTCUSDT")[1].text], [2, "偏多但风险中等"]);
  check("持久化不带 pending 气泡", JSON.stringify(store.toJSON()).includes("pending") === false);
}

console.log("== 2. 记录上限 + compact_summary(禁止无限增长) ==");
{
  const store = createChatSessionStore({ now: () => T0, per_symbol_limit: 20, summary_keep: 6, summary_max_chars: 200 });
  for (let i = 0; i < 60; i += 1) {
    store.append("BTCUSDT", "BTCUSDT", { role: i % 2 ? "ai" : "me", text: "第" + i + "条消息内容" + "x".repeat(20) });
  }
  const msgs = store.messages("BTCUSDT");
  eq("消息数被限制在上限内", [msgs.length, msgs.length <= 20], [20, true]);
  check("最旧的被挤出(留下的是最近的)", msgs[msgs.length - 1].text.includes("第59条"));
  const summary = store.summary("BTCUSDT");
  check("摘要存在且有长度上限", Boolean(summary) && summary.length <= 200, "len=" + summary.length);
  check("摘要只保留最近事件", summary.includes("第59条") && !summary.includes("第0条消息"));
  const stats = store.stats();
  check("统计可见裁剪次数", stats.trimmed >= 40 && stats.summaries >= 60, JSON.stringify(stats));
  eq("摘要为空时返回空串", compactSummary([], {}), "");
}

console.log("== 3. 出站上下文:只发问题 + 摘要 + 当前快照 ==");
{
  const store = createChatSessionStore({ now: () => T0 });
  for (let i = 0; i < 10; i += 1) store.append("BTCUSDT", "BTCUSDT", { role: "me", text: "历史问题" + i });
  const slim = buildSlimContext({
    question: "现在适合买吗?",
    session: { key: "BTCUSDT", symbol: "BTCUSDT", summary: store.summary("BTCUSDT") },
    snapshot: {
      symbol: "BTCUSDT", interval: "1h", mode: "short", price: 84000, direction: "Bullish", confidence: 70,
      regime: "Weak Uptrend", risk_level: "NORMAL", risk_score: 22,
      position: { side: "LONG", leverage: 2, unrealized_pnl: 1.2 },
      prediction: { direction: "Bullish", probability: 0.58 }, funding: { rate: 0.0001 },
      open_interest: { change_pct: 3 }, profit_lock: { stage: 1 }, leverage: 2, pnl: 1.2,
      journal: [{ kind: "ENTRY", why: "规则看多" }]
    }
  });
  check("只带当前问题", slim.question === "现在适合买吗?");
  check("带摘要而不是历史消息", typeof slim.context.chat_summary === "string" && !("messages" in slim.context) && !("history" in slim.context));
  check("上下文覆盖需求列出的字段", ["symbol", "position", "leverage", "pnl", "risk_level", "prediction", "funding", "regime", "profit_lock", "journal"].every((k) => k in slim.context), JSON.stringify(Object.keys(slim.context)));

  const outbound = limitOutboundContext(
    { symbol: "BTCUSDT", position: { side: "LONG" }, messages: [{ role: "me", text: "全历史" }], history: ["x"], chat_history: ["y"], internal_cache: "不应该出现", drawdown: { state: "NORMAL" } },
    { summary: "用户:历史问题9 | AI:…", conversation_id: "BTCUSDT" }
  );
  check("白名单剔除违禁字段", !("messages" in outbound) && !("history" in outbound) && !("chat_history" in outbound) && !("internal_cache" in outbound));
  check("白名单保留必要字段", outbound.symbol === "BTCUSDT" && outbound.position && outbound.drawdown);
  eq("摘要注入出站上下文", outbound.chat_summary, "用户:历史问题9 | AI:…");
  const huge = limitOutboundContext({ symbol: "BTCUSDT" }, { summary: "x".repeat(5000) });
  check("摘要长度有硬上限", huge.chat_summary.length <= CHAT_DEFAULTS.summary_max_chars, String(huge.chat_summary.length));
  check("空值字段被压缩掉", !("prediction" in limitOutboundContext({ symbol: "BTCUSDT", prediction: null }, {})));
}

console.log("== 4. 请求类型区分(关闭只中断用户聊天) ==");
{
  eq("请求类型定义", [REQUEST_KINDS.USER_CHAT_REQUEST, REQUEST_KINDS.BACKGROUND_DECISION_REVIEW], ["USER_CHAT_REQUEST", "BACKGROUND_DECISION_REVIEW"]);
  eq("只有用户聊天可中断", ABORTABLE_KINDS, ["USER_CHAT_REQUEST"]);
  const plan = teardownPlan({ persist: true });
  check("清理清单:卸载 UI / 移除在途气泡 / 停动画", plan.unmount_ui && plan.remove_loading_bubbles && plan.stop_animations);
  check("清理清单:保留后台决策复核", plan.preserve_request_kinds.includes("BACKGROUND_DECISION_REVIEW"));
  check("清理清单:后台引擎/行情/风控/持仓/学习继续运行", ["paper-engine", "market-data", "risk", "position-manager", "learning"].every((k) => plan.keep_background.includes(k)));
  check("清理清单:关闭后不再轮询/不占 Token", plan.notes.join("").includes("不轮询"));
  eq("收起状态判定:idle 要求无在途请求", [uiIdleState({ open: false }).idle, uiIdleState({ open: true }).idle, uiIdleState({ open: false, loading: true }).idle, uiIdleState({ open: false, pending_requests: 1 }).idle], [true, false, false, false]);
}

console.log("== 5. 页面接线(非驻留 / 自动收起 / 切币保护 / 关闭即中断) ==");
{
  check("页面用会话存储(不是常驻页面)", /createChatSessionStore/.test(pageSrc) && /chatKeyOf\(/.test(pageSrc));
  check("打开时恢复最近会话(不重建 Coin Detail)", /renderChatMessages\(symbol\)/.test(pageSrc) && /chatSessions\.messages\(key\)/.test(pageSrc));
  check("关闭:中断 chat 请求 + 移除在途气泡 + 落库", /function closeChat\(options\)/.test(pageSrc) && /RM\.leave\("chat"\)/.test(pageSrc) && /removeChild\(chatLoadingBubble\)/.test(pageSrc) && /saveChatSessions\(\)/.test(pageSrc));
  check("关闭:只影响 chat 键(后台复核用 paper 键)", /RM\.begin\("paper"\)/.test(pageSrc) && !/RM\.leaveAll\(\)/.test(pageSrc));
  check("离开 Coin Detail 自动收起", /name !== "detail" && name !== currentPage[\s\S]{0,120}closeChat\(\{ fromNav: true \}\)/.test(pageSrc));
  check("切币保护(禁止用旧币上下文回答)", /chatActiveSymbol !== symbolNow/.test(pageSrc) && /已按当前币种切换会话/.test(pageSrc));
  check("返回手势关闭(而不是退出页面)", /addEventListener\("popstate"/.test(pageSrc) && /closeChat\(\{ fromPop: true \}\)/.test(pageSrc));
  check("下拉关闭手势(松手才关)", /touchend/.test(pageSrc) && /moved > 80/.test(pageSrc));
  check("生成期间被关闭则不再写 DOM", /if \(!chatIsOpen\(\) \|\| !loading\.parentNode\) return;/.test(pageSrc));
  check("回答失败/中断时不写入无意义消息", /aborted: true/.test(pageSrc));
  check("出站上下文经白名单整形", /limitOutboundContext\(/.test(pageSrc) && /outboundChatContext\(/.test(pageSrc));
  check("聊天不再访问引擎(关闭后真的什么都不做)", !/chatSingleAnswer[\s\S]{0,900}getPaperEngine/.test(pageSrc));
}

console.log("== 6. UI 约束(轻量入口,不喧宾夺主) ==");
{
  check("AI 入口是右下角 FAB 且四个主视图可用", /id="chatFab"/.test(pageSrc) && /name === "detail" \|\| name === "home" \|\| name === "market" \|\| name === "paper"/.test(pageSrc));
  check("FAB 文案就是 AI(不是机器人头像/大块占位)", /<button id="chatFab" class="fab show" type="button" aria-label="AI">AI<\/button>/.test(pageSrc));
  check("不存在常驻 AI 页面(没有第五个导航/没有 page-ai)", !/id="page-ai"/.test(pageSrc) && !/nav-btn[^>]*>\s*<span[^>]*>AI/.test(pageSrc));
  const fabCss = pageSrc.slice(pageSrc.indexOf(".fab"), pageSrc.indexOf(".fab") + 260);
  check("FAB 样式克制(无发光/无紫蓝渐变)", !/glow|box-shadow:\s*0 0 2[0-9]px|linear-gradient\([^)]*#(6|7|8)[0-9a-f]{5}/i.test(fabCss), fabCss.replace(/\s+/g, " ").slice(0, 120));
  check("Bottom Sheet 高度在 65%~75%", /\.sheet \{[\s\S]{0,200}height:\s*72%/.test(pageSrc));
  check("Sheet 头部只有标题+上下文+关闭", /id="chatTitle"[\s\S]{0,220}id="chatContext"[\s\S]{0,160}id="chatClose"/.test(pageSrc));
  check("收起时停止过渡动画", /\.sheet\.closing \{ transition: none/.test(pageSrc));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("CHAT SESSION OK");
