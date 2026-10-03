// tools/test-nav-state.mjs · V16.2 · 导航状态 / 返回栈 / 返回优先级 / 滚动恢复(纯逻辑强断言)
import { createNavState, backPriority, restoreScrollAfterReady, isSubPage, NAV_TABS, NAV_STATE_VERSION, BACK_ACTIONS } from "../worker/src/ui/navState.js";

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log("PASS  " + name); }
  else { failed += 1; console.log("FAIL  " + name + (detail ? "  => " + detail : "")); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}

console.log("== 1. 主 Tab 与子页判定 ==");
{
  eq("四个主 Tab 固定", NAV_TABS, ["home", "market", "paper", "settings"]);
  check("主 Tab 不算子页", NAV_TABS.every((p) => isSubPage(p) === false));
  check("详情/内核/诊断/通知设置/回测/扫描都是子页", ["detail", "kernel", "diag", "ntfset", "validation", "backtest", "walkforward", "dataset", "ml", "health", "monitor", "scan", "watch"].every((p) => isSubPage(p) === true));
  check("空值不算子页", isSubPage("") === false && isSubPage(null) === false);
}

console.log("== 2. 视图状态快照(每页独立,合并保存) ==");
{
  const nav = createNavState({ now: () => 1000 });
  nav.save("market", { scrollY: 1800 });
  nav.save("market", { filter: "watch" });          // 合并而不是覆盖
  const m = nav.get("market");
  check("market 快照合并(scrollY + filter 都在)", m.scrollY === 1800 && m.filter === "watch" && m.saved_at === 1000, JSON.stringify(m));
  nav.save("detail", { symbol: "SOLUSDT", interval: "4h", markOn: true });
  eq("detail 快照独立", nav.get("detail").symbol, "SOLUSDT");
  eq("未保存过的页面返回 null", nav.get("kernel"), null);
  check("非法保存被拒绝", nav.save("", { a: 1 }) === null && nav.save("market", null) === null);
}

console.log("== 3. 返回栈(逐级返回,不是弹回首页) ==");
{
  const nav = createNavState({});
  nav.push("market", "detail");
  eq("市场 → BTC详情:栈记录来路", nav.stackOf(), ["market", "detail"]);
  eq("详情返回 → 回市场(不是首页)", nav.pop("detail"), "market");
  eq("返回后栈清空", nav.depth(), 0);
  // 多级:我的 → 内核 → 诊断
  nav.push("settings", "kernel");
  nav.push("kernel", "diag");
  eq("我的 → 内核 → 诊断", nav.stackOf(), ["settings", "kernel", "diag"]);
  eq("诊断返回 → 内核", nav.pop("diag"), "kernel");
  eq("内核返回 → 我的", nav.pop("kernel"), "settings");
  eq("栈空再返回 → null(页面负责兜底)", nav.pop("settings"), null);
  // 相同页/重复 push 不膨胀
  nav.push("home", "detail");
  nav.push("detail", "detail");
  nav.push("paper", "detail");
  eq("相邻/自身重复 push 不重复入栈", nav.stackOf(), ["home", "detail"]);
  // 限长:链式推进(每次从上一页出发)
  const deep = createNavState({ limit: 3 });
  for (const p of ["a1", "a2", "a3", "a4", "a5"]) deep.push(deep.stackOf().slice(-1)[0] || "root0", p);
  eq("超长裁剪保留最近 3 层", deep.stackOf(), ["a3", "a4", "a5"]);
  // Tab 切换清空子页栈
  nav.reset();
  eq("切 Tab 清空子页栈", nav.stackOf(), []);
}

console.log("== 4. Android 返回优先级(§3:Sheet → 全屏 → 标记 → 子页 → 退出) ==");
{
  eq("动作集合顺序固定", BACK_ACTIONS, ["close_sheet", "exit_fullscreen", "close_mark", "back_subpage", "exit_app"]);
  eq("Sheet 打开优先关 Sheet(即使同时全屏)", backPriority({ sheetOpen: true, fullscreen: true, subpageActive: true }), "close_sheet");
  eq("无 Sheet:先退全屏", backPriority({ fullscreen: true, markPop: true, subpageActive: true }), "exit_fullscreen");
  eq("无全屏:先收标记气泡", backPriority({ markPop: true, subpageActive: true }), "close_mark");
  eq("都无:返回上一子页", backPriority({ subpageActive: true }), "back_subpage");
  eq("根 Tab:才退出 App", backPriority({}), "exit_app");
  check("优先级用真值而不是字符串", backPriority({ sheetOpen: 1, fullscreen: 0 }) === "close_sheet");
}

console.log("== 5. 滚动恢复:必须等页面 ready 后两帧再设 ==");
{
  const queue = [];
  const applied = [];
  const handle = restoreScrollAfterReady({
    schedule: (fn) => { queue.push(fn); return queue.length; },
    apply: (v) => applied.push(v),
    value: 1820.7
  });
  check("第一帧只排期不应用", applied.length === 0 && queue.length === 1);
  queue.shift()();   // 第一帧回调
  check("第二帧仍不应用(等布局)", applied.length === 0 && queue.length === 1);
  queue.shift()();   // 第二帧回调
  eq("两帧后应用(取整)", applied, [1820]);
  // 取消
  const q2 = [];
  const a2 = [];
  const h2 = restoreScrollAfterReady({ schedule: (fn) => { q2.push(fn); }, apply: (v) => a2.push(v), value: 500 });
  h2.cancel();
  while (q2.length) q2.shift()();
  eq("取消后不再应用(页面又切换走了)", a2, []);
  // 负值/NaN 归零
  const q3 = [];
  const a3 = [];
  restoreScrollAfterReady({ schedule: (fn) => { q3.push(fn); }, apply: (v) => a3.push(v), value: -5 });
  q3.shift()(); q3.shift()();
  eq("负滚动归零", a3, [0]);
  void handle;
}

console.log("== 6. 统计与描述(可观测) ==");
{
  const nav = createNavState({});
  nav.save("market", { scrollY: 100 });
  nav.push("market", "detail");
  nav.pop("detail");
  const s = nav.stats();
  eq("版本与计数", [s.version, s.pages, s.depth, s.saved, s.backs], [NAV_STATE_VERSION, 1, 0, 1, 1]);
  check("describe 给可读结构", nav.describe().stack.length === 0 && nav.describe().pages.market.scrollY === 100);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("NAV STATE TESTS OK");
