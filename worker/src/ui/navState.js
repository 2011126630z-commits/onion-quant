// ui/navState.js · V16.2 · 手机导航状态与返回栈(纯逻辑,无 DOM,可在 Node 直接测)
// 课堂式连续性要求:
//   ① 每个页面保存自己的视图状态快照(滚动位置 + 页面自定义字段: symbol/interval/filter/展开项…)
//   ② 真实返回栈:子页逐级返回(详情 → 来路页;内核/诊断/通知设置 → 我的),而不是弹回首页
//   ③ Android 返回优先级:Bottom Sheet → K线全屏 → 标记气泡 → 上一子页 → 才退出 App
//   ④ 滚动恢复必须"页面 ready 之后再设"(两帧),否则设了又失效
// 本模块只做状态与顺序,不触碰 window/document —— 页面接线由 page.js 完成。
export const NAV_STATE_VERSION = "nav-state-v1.0";

// 主 Tab(底部导航的四个根视图);其余一律视为"子页",进入返回栈
export const NAV_TABS = ["home", "market", "paper", "settings"];
export function isSubPage(page) {
  return Boolean(page) && !NAV_TABS.includes(String(page));
}

// 返回优先级(纯函数,§3):
//   sheet(任何 Bottom Sheet)> fullscreen(K线全屏)> mark(标记气泡)> subpage(上一子页)> exit(退出 App)
export const BACK_ACTIONS = ["close_sheet", "exit_fullscreen", "close_mark", "back_subpage", "exit_app"];
export function backPriority(input) {
  const i = input || {};
  if (i.sheetOpen) return "close_sheet";
  if (i.fullscreen) return "exit_fullscreen";
  if (i.markPop) return "close_mark";
  if (i.subpageActive) return "back_subpage";
  return "exit_app";
}

// 滚动恢复:两帧后应用(等布局完成)。schedule 注入(默认 requestAnimationFrame),便于测试。
export function restoreScrollAfterReady(options) {
  const o = options || {};
  const schedule = typeof o.schedule === "function" ? o.schedule : ((fn) => setTimeout(fn, 16));
  const apply = typeof o.apply === "function" ? o.apply : (() => {});
  const value = Number.isFinite(o.value) ? Math.max(0, Math.floor(o.value)) : 0;
  let cancelled = false;
  schedule(() => {
    schedule(() => {
      if (!cancelled) apply(value);
    });
  });
  return { cancel: () => { cancelled = true; } };
}

export function createNavState(options) {
  const o = options || {};
  const limit = Number.isFinite(o.limit) ? Math.max(1, Math.floor(o.limit)) : 20;
  const pages = {};      // page → 视图状态快照
  let stack = [];        // 返回栈(只放子页;栈顶 = 当前子页)
  let savedCount = 0;
  let backCount = 0;

  function save(page, patch) {
    const key = String(page || "");
    if (!key || !patch || typeof patch !== "object") return null;
    pages[key] = { ...(pages[key] || {}), ...patch, saved_at: o.now ? o.now() : null };
    savedCount += 1;
    return pages[key];
  }
  function get(page) {
    const key = String(page || "");
    return pages[key] ? { ...pages[key] } : null;
  }
  // 进入子页:栈保存"来路轨迹"(栈内包含根页,栈顶=当前页)。
  // - from 在轨迹中 → 先截断其后的元素(像浏览器历史一样,从中间位置出发会砍掉前向记录)
  // - 目标是当前栈顶(重复点击)或与来源相同 → 不入栈;超长裁剪最旧的
  function push(current, target) {
    const from = String(current || "");
    const to = String(target || "");
    if (!to || to === from) return stack.slice();
    if (stack.length && stack[stack.length - 1] === to) return stack.slice();   // 已经在目标页(重复点击/并发入口)
    const at = stack.lastIndexOf(from);
    if (at >= 0) stack = stack.slice(0, at + 1);
    else if (stack.length === 0) stack = [from];
    else stack.push(from);                       // 异常路径(不在轨迹里的来源):补一条,保证 pop 语义成立
    if (stack[stack.length - 1] !== to) stack.push(to);
    if (stack.length > limit) stack = stack.slice(-limit);
    return stack.slice();
  }
  // 返回:弹掉当前页;回到"根 Tab"时整条轨迹结束(清空);栈空返回 null
  // (由页面决定兜底:detail→market,其它子页→settings)
  function pop(current) {
    const cur = String(current || "");
    if (stack.length && stack[stack.length - 1] === cur) stack.pop();
    else {
      const idx = stack.lastIndexOf(cur);
      if (idx >= 0) stack = stack.slice(0, idx);
      else return null;
    }
    backCount += 1;
    if (!stack.length) return null;
    const prev = stack[stack.length - 1];
    if (NAV_TABS.includes(prev)) stack = [];     // 回到根:应用内轨迹结束
    return prev;
  }
  // 切换主 Tab(或任意"根跳转")时清空子页栈:新上下文
  function reset() { stack = []; }
  function depth() { return stack.length; }
  function stackOf() { return stack.slice(); }
  function stats() { return { version: NAV_STATE_VERSION, pages: Object.keys(pages).length, depth: stack.length, saved: savedCount, backs: backCount }; }
  function describe() {
    return { version: NAV_STATE_VERSION, stack: stack.slice(), pages: Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, { ...v }])) };
  }

  return { version: NAV_STATE_VERSION, save, get, push, pop, reset, depth, stackOf, stats, describe, limit };
}
