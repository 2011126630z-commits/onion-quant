// ui/page.js · 单页前端模板(HTML/CSS/JS 内嵌)

export const page = String.raw`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="theme-color" content="#0e1013">
    <title>量化监控</title>
    <script>
      // V16.2 · 黑白闪屏根因修复(必须在首帧 paint 之前执行):
      // 旧实现把 applyTheme() 放在脚本末尾 —— 冷启动会先按默认浅色变量绘制,再经 500ms 过渡变深色(白闪);
      // 且首屏所有元素都带过渡,任何首帧状态变化都会"渐显"。这里:①同步读出主题并立刻落类;
      // ②把首帧底色写成内联背景(与 CSS 变量一致,深色 #0e1013 / 浅色 #ffffff);
      // ③加 html.preload 关闭首屏过渡,两帧后移除 —— 之后主题切换才是 200ms 的干净过渡。
      (function () {
        try {
          var settings = {};
          try { settings = JSON.parse(localStorage.getItem("quantSettings") || "{}"); } catch (e) { settings = {}; }
          var mode = settings.themeMode || "dark";
          var prefersDark = Boolean(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
          var dark = mode === "dark" || (mode === "system" && prefersDark);
          var root = document.documentElement;
          root.className = dark ? "theme-dark preload" : "preload";
          var bg = dark ? "#0e1013" : "#ffffff";
          root.style.backgroundColor = bg;
          var meta = document.querySelector('meta[name="theme-color"]');
          if (meta) meta.setAttribute("content", dark ? "#0e1013" : "#ffffff");
          document.addEventListener("DOMContentLoaded", function () {
            try { document.body.style.backgroundColor = bg; } catch (e) { /* 忽略 */ }
          });
          requestAnimationFrame(function () {
            requestAnimationFrame(function () { root.classList.remove("preload"); });
          });
        } catch (error) { /* 主题守卫失败不阻塞页面 */ }
      })();
    </script>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #ffffff;
        --panel: #f4f5f5;
        --panel-2: #ecefee;
        --line: #dde2e0;
        --text: #202423;
        --muted: #6f7875;
        --green: #006b4f;
        --red: #f6465d;
        --gray: #9ca3af;
        --nav-bg: rgba(255, 255, 255, .94);
        --nav-solid: #ffffff;
        --chart-bg: #f4f5f5;
        --button-text: #ffffff;
      }
      :root.theme-dark {
        color-scheme: dark;
        --bg: #0e1013;
        --panel: #15181d;
        --panel-2: #1d2127;
        --line: #262b33;
        --text: #e8eaed;
        --muted: #8b919a;
        --green: #00b374;
        --red: #f6465d;
        --gray: #8b919a;
        --nav-bg: rgba(14, 16, 19, .94);
        --nav-solid: #191d24;
        --chart-bg: #12151a;
        --button-text: #ffffff;
      }
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        min-height: 100%;
        background: var(--bg);
        color: var(--text);
        transition: background-color 200ms ease, color 200ms ease;
      }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: 15px;
      }
      /* V16.2:首屏(含冷启动首帧)不做任何过渡 —— 防止"白底渐变成深色"的启动闪屏;
         两帧后由 pre-paint 脚本移除 .preload,之后的主题切换保持 200ms 的干净过渡。 */
      html.preload, html.preload * { transition: none !important; animation: none !important; }
      body, .app, .card, .bottom-nav, select, input, button, .period-btn, .primary-btn, .add-btn, .switch {
        transition:
          background-color 200ms ease,
          border-color 200ms ease,
          color 200ms ease,
          box-shadow 200ms ease,
          transform 160ms cubic-bezier(.2, .8, .2, 1);
      }
      button, select, input { font: inherit; }
      button { cursor: pointer; }
      .app {
        width: min(760px, 100%);
        min-height: 100vh;
        margin: 0 auto;
        /* 真机修复:页面的安全边距必须落在 .page 上(见下)。
           这里不再加左右 padding —— 否则"包裹到的内容"会得到双份边距,而"没包裹到的页面"一份都没有。 */
        padding: 0;
      }
      .page {
        display: none;
        opacity: 0;
        transform: translateY(8px);
        /* 手机端统一安全边距(所有主页面一致):左右 16px,顶部避开状态栏/刘海,
           底部按"悬浮胶囊导航 + 系统手势条"预留 —— 全部走 env(safe-area-inset-*),不写死设备像素 */
        padding: calc(10px + env(safe-area-inset-top)) 16px calc(96px + env(safe-area-inset-bottom));
      }
      .page.active {
        display: block;
        /* V16.2:切页只动 opacity/transform,160ms 轻量进入(旧页立即 display:none,
           新页从 0.4 不透明度轻微上移滑入 —— 背景始终是主题底色,不会露出黑白空帧) */
        animation: pageIn 160ms cubic-bezier(.22, .61, .36, 1) both;
        will-change: opacity, transform;
        backface-visibility: hidden;
        -webkit-backface-visibility: hidden;
      }
      @keyframes pageIn {
        from { opacity: 0.4; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .top-row, .controls-row, .market-row, .watch-row, .setting-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      /* 手机触控目标:列表行/设置行给足高度,避免"点不中" */
      .market-row, .watch-row, .setting-row { min-height: 54px; }
      /* 手机版重排:窄屏下"标签 + 小下拉框"这种桌面式一行 → 上下堆叠的系统设置样式 */
      @media (max-width: 560px) {
        .setting-row, .controls-row {
          flex-direction: column; align-items: stretch; gap: 8px; min-height: 0;
        }
        /* 只让"控件"占满整行 —— 不能写成 .setting-row > * (那会把右侧箭头 pill 拉成一条空灰条) */
        .setting-row select, .setting-row input,
        .controls-row select, .controls-row input,
        .select-wide, .select-narrow { width: 100% !important; min-height: 46px; border-radius: 12px; }
        /* 可点行(带 › 的):整行可点,箭头贴右,成为标准手机设置行 */
        .setting-row .pill {
          width: 100%; display: flex; justify-content: flex-end; align-items: center;
          min-height: 42px; padding: 0 14px; border-radius: 12px; box-sizing: border-box;
        }
      }
      select, input { min-height: 44px; border-radius: 12px; }
      .top-row { margin-bottom: 9px; flex-wrap: wrap; }
      .top-row-selects { display: flex; gap: 6px; }
      h1, h2, p { margin: 0; }
      h1 { font-size: 22px; font-weight: 800; }
      h2 { font-size: 16px; font-weight: 800; }
      .muted { color: var(--muted); }
      /* V16.1 防横向溢出兜底:任何卡片/flex 子项都不允许顶破视口 */
      .card, .card *, .page, .page * { max-width: 100%; }
      .card :is(div,span,button,input,select) { min-width: 0; }
      html, body { overflow-x: hidden; }
      .card {
        border: 1px solid var(--line);
        border-radius: 14px;
        background: var(--panel);
        padding: 14px;
      }
      select, input {
        min-height: 40px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--panel-2);
        color: var(--text);
        padding: 0 10px;
        outline: none;
      }
      .select-wide { width: 150px; }
      .select-narrow { width: 86px; }
      .search-wrap {
        position: relative;
        margin-bottom: 9px;
      }
      .search-wrap > svg {
        position: absolute;
        left: 12px;
        top: 50%;
        transform: translateY(-50%);
        color: var(--muted);
        pointer-events: none;
      }
      #symbolSearch {
        width: 100%;
        min-height: 38px;
        border-radius: 999px;
        background: var(--panel-2);
        border: 1px solid transparent;
        padding: 0 14px 0 34px;
        font-size: 14px;
      }
      #symbolSearch:focus { border-color: var(--line); }
      .search-suggest {
        position: absolute;
        top: calc(100% + 4px);
        left: 0;
        right: 0;
        z-index: 20;
        display: none;
        border: 1px solid var(--line);
        border-radius: 10px;
        background: var(--panel);
        box-shadow: 0 10px 24px rgba(0, 0, 0, .14);
        overflow: hidden;
      }
      .search-suggest.open { display: block; }
      .suggest-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        min-height: 40px;
        padding: 0 13px;
        border: 0;
        background: transparent;
        color: var(--text);
        font-size: 14px;
      }
      .suggest-item:active, .suggest-item:hover { background: var(--panel-2); }
      .suggest-item + .suggest-item { border-top: 1px solid var(--line); }
      .suggest-item .muted { font-size: 12px; }
      .periods {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(56px, 1fr));
        gap: 7px;
        margin: 9px 0;
      }
      .period-btn, .primary-btn, .icon-btn, .add-btn {
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--panel-2);
        color: var(--text);
        min-height: 40px;
      }
      .period-btn.active { border-color: var(--green); background: color-mix(in srgb, var(--green) 12%, var(--panel-2)); color: var(--green); }
      .chart-card {
        position: relative;
        height: 330px;
        padding: 0;
        overflow: hidden;
      }
      canvas { display: block; width: 100%; height: 100%; }
      .chart-empty {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        padding: 24px;
        text-align: center;
        color: var(--muted);
        background: var(--chart-bg);
      }
      .chart-empty.hidden { display: none; }
      .price-card {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-top: 9px;
      }
      .price-main { grid-column: 1 / -1; }
      .label { display: block; color: var(--muted); font-size: 12px; margin-bottom: 5px; }
      .price { font-size: 30px; font-weight: 850; letter-spacing: 0; }
      .value { font-size: 18px; font-weight: 750; }
      .green { color: var(--green); }
      .red { color: var(--red); }
      .gray { color: var(--gray); }
      .analysis-card { margin-top: 9px; }
      .signal {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 8px;
      }
      .signal strong { font-size: 34px; }
      .signal span { color: var(--muted); font-size: 13px; }
      .analysis-text { color: var(--muted); line-height: 1.55; }
      .primary-btn {
        width: 100%;
        margin-top: 9px;
        height: 48px;
        border-color: var(--green);
        background: var(--green);
        color: var(--button-text);
        font-weight: 800;
      }
      .section-title { margin: 2px 0 12px; }
      .list {
        display: grid;
        gap: 7px;
      }
      .market-row, .watch-row, .setting-row {
        min-height: 56px;
      }
      .coin-name { font-weight: 800; }
      .coin-sub { color: var(--muted); font-size: 12px; margin-top: 4px; }
      .right { text-align: right; }
      .pill {
        display: inline-flex;
        min-width: 52px;
        justify-content: center;
        border-radius: 999px;
        padding: 5px 9px;
        font-size: 12px;
        font-weight: 800;
        background: var(--panel-2);
      }
      .pill.green { background: rgba(0, 192, 118, .12); }
      .pill.red { background: rgba(246, 70, 93, .12); }
      .pill.gray { background: rgba(156, 163, 175, .12); }
      .scan-controls, .watch-controls {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
        margin-bottom: 9px;
      }
      .setting-list {
        display: grid;
        gap: 7px;
      }
      .setting-row select, .setting-row input { width: 150px; }
      /* 移动端统一 Switch 组件(44×26,滑块 18px,永不越界)
         真机 BUG 根因:.switch 是 <span> → inline 元素会**忽略 width/height**,
         而滑块 ::after 用 left:25px 绝对定位 ⇒ ON 态滑块被推到行尾再往右 25px,
         越过卡片与视口,在屏幕最右侧形成一排半截白色圆。
         修复要点:inline-block 让尺寸生效 + position:relative 让 ::after 以自身为包含块 + flex-shrink:0 不被压缩。 */
      .switch {
        position: relative;
        display: inline-block;
        flex-shrink: 0;
        width: 44px;
        height: 26px;
        box-sizing: border-box;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: var(--panel-2);
        vertical-align: middle;
      }
      .switch.on { background: rgba(0, 192, 118, .35); }
      .switch::after {
        content: "";
        position: absolute;
        top: 3px;
        left: 3px;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: #fff;
        transition: left 180ms ease;
      }
      .switch.on::after { left: 21px; }   /* 3 + 18 + 3 = 44,滑块始终在轨道内 */
      .status {
        color: var(--muted);
        font-size: 13px;
        margin: 8px 0;
        min-height: 18px;
      }
      .progress {
        height: 6px;
        overflow: hidden;
        border-radius: 999px;
        background: var(--panel-2);
        margin: 8px 0 10px;
      }
      .progress span {
        display: block;
        width: 0%;
        height: 100%;
        border-radius: inherit;
        background: var(--green);
        transition: width 300ms ease;
      }
      /* 悬浮圆角胶囊导航:左右各留 12px,底部留 12px + 系统手势条安全区。
         真机修复:去掉 backdrop-filter —— Android WebView 上毛玻璃会掉帧并产生"切换拖影",
         改为几乎不透明的纯色 + 极淡阴影(观感接近,流畅度明显更好,且不会残留虚影)。 */
      .bottom-nav {
        position: fixed;
        left: 12px;
        right: 12px;
        bottom: calc(12px + env(safe-area-inset-bottom));
        z-index: 10;
        width: auto;
        max-width: 736px;
        margin: 0 auto;
        transform: none;
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        border: 1px solid var(--line);
        border-radius: 24px;
        background: var(--nav-solid);
        box-shadow: 0 8px 24px rgba(0, 0, 0, .18);
        padding: 5px 6px;
        contain: layout paint;
      }
      .chart-legend {
        position: absolute;
        top: 8px;
        left: 10px;
        z-index: 2;
        font-size: 11px;
        color: var(--muted);
        pointer-events: none;
      }
      .small-note { font-size: 11px; color: var(--muted); margin: 2px 0 0; }
      .status-card { margin-top: 9px; }
      .status-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .regime { font-weight: 800; font-size: 15px; }
      .meters { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 10px 0 4px; }
      .meter strong { font-size: 17px; }
      .meter .bar { height: 5px; border-radius: 999px; background: var(--panel-2); overflow: hidden; margin-top: 5px; }
      .meter .bar span { display: block; height: 100%; width: 0%; border-radius: inherit; background: var(--green); transition: width 300ms ease; }
      .meter.conf .bar span { background: #c8cdd4; }
      .meter.risk .bar span { background: var(--red); }
      .tf-row { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 2px; }
      .tf-chip { border-radius: 999px; padding: 4px 9px; font-size: 11px; background: var(--panel-2); color: var(--muted); }
      .tf-chip.green { color: var(--green); }
      .tf-chip.red { color: var(--red); }
      .detail-lists { display: grid; gap: 10px; margin-top: 8px; }
      .detail-lists ul { margin: 4px 0 0; padding-left: 18px; color: var(--muted); font-size: 13px; line-height: 1.6; }
      .note-line { color: #d29a3a; font-size: 12px; margin: 8px 0 0; }
      .scan-toolbar { display: flex; gap: 6px; overflow-x: auto; margin-top: 9px; padding-bottom: 2px; }
      .scan-toolbar .chip { border: 1px solid var(--line); background: var(--panel-2); border-radius: 999px; min-height: 30px; padding: 0 12px; font-size: 12px; color: var(--muted); white-space: nowrap; }
      .scan-toolbar .chip.active { border-color: var(--green); color: var(--green); }
      .scan-row { display: grid; grid-template-columns: 1.1fr auto auto 1fr; align-items: center; gap: 8px; min-height: 52px; padding: 8px 10px; }
      .scan-row .sr-main b { display: block; font-size: 14px; }
      .scan-row .regime-pill { font-size: 11px; padding: 3px 7px; }
      .sr-metrics { display: grid; gap: 2px; justify-items: end; font-size: 11px; color: var(--muted); text-align: right; }
      .watch-right { text-align: right; }
      .nav-btn {
        display: grid;
        gap: 3px;
        place-items: center;
        min-height: 52px;                 /* 真机触控目标:整块可点,不再只有 38px */
        border: 0;
        background: transparent;
        color: var(--gray);
        transition: color 180ms ease;
        -webkit-tap-highlight-color: transparent;
        border-radius: 16px;
      }
      .nav-btn.active { color: var(--green); }
      .nav-btn:active { opacity: .72; }   /* 轻量点击反馈:不换背景色、不动布局 */
      .nav-icon {
        display: block;
        line-height: 1;
        transition: transform 180ms ease;
      }
      .nav-icon svg { display: block; width: 24px; height: 24px; }
      /* 选中态只用颜色表达:无背景色块,图标轻微下沉 1px */
      .nav-btn.active .nav-icon { transform: translateY(1px); }
      .nav-text { font-size: 11px; font-weight: 500; letter-spacing: .2px; white-space: nowrap; }
      @media (max-width: 430px) {
        .page { padding-left: 16px; padding-right: 16px; }
        .chart-card { height: 300px; }
        .price { font-size: 28px; }
        .scan-row { grid-template-columns: 1fr auto auto; }
        .scan-row .regime-pill { display: none; }
      }
      /* ---- V10 历史验证 ---- */
      .v-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 8px; }
      .v-stat { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 8px; text-align: center; }
      .v-stat b { display: block; font-size: 18px; }
      .v-stat span { font-size: 11px; color: var(--muted); }
      .v-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
      .v-actions button { flex: 1; min-width: 88px; min-height: 36px; }
      .v-actions button.sec { border: 1px solid var(--line); background: var(--panel-2); color: var(--text); border-radius: 8px; }
      .v-actions button.sec:disabled, .v-actions button.primary-btn:disabled { opacity: .55; }
      .v-metrics { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
      .v-metric { border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
      .v-metric span { display: block; font-size: 11px; color: var(--muted); }
      .v-metric b { font-size: 15px; font-weight: 700; }
      .v-table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .v-table th { text-align: left; color: var(--muted); font-weight: 500; padding: 4px 2px; border-bottom: 1px solid var(--line); white-space: nowrap; }
      .v-table td { padding: 5px 2px; border-bottom: 1px solid var(--line); }
      .v-table tr:last-child td { border-bottom: none; }
      .v-table td.num, .v-table th.num { text-align: right; }
      .v-note { font-size: 11px; color: var(--muted); line-height: 1.5; }
      .v-bar { height: 5px; border-radius: 3px; background: var(--panel-2); overflow: hidden; margin-top: 4px; }
      .v-bar i { display: block; height: 100%; background: var(--green); }
      .v-sample { cursor: pointer; }
      .v-sample:active { background: var(--panel-2); }
      .v-overlay {
        position: fixed; inset: 0; z-index: 40; display: none;
        background: rgba(0, 0, 0, .55); padding: 14px; overflow-y: auto;
      }
      .v-overlay.open { display: block; }
      .v-sheet {
        width: min(720px, 100%); margin: 0 auto; background: var(--bg);
        border: 1px solid var(--line); border-radius: 10px; padding: 12px;
      }
      .v-sheet h2 { display: flex; align-items: center; justify-content: space-between; }
      .v-close { border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 6px; padding: 4px 10px; }
      .v-kv { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; font-size: 12px; }
      .v-kv span:nth-child(odd) { color: var(--muted); }
      .v-progress { display: none; margin-bottom: 8px; }
      .v-progress.on { display: block; }
      /* ---- V14.1 移动端 ---- */
      .hm-hero { padding: 16px 2px 14px; border-bottom: 1px solid var(--line); }
      .hm-hero .label { font-size: 12px; color: var(--muted); }
      .hm-hero .big { font-size: 32px; font-weight: 650; letter-spacing: -.5px; margin-top: 2px; transition: color 200ms ease; }
      .hm-hero .sub { font-size: 12px; color: var(--muted); margin-top: 6px; }
      /* 防横向溢出:flex 子项默认 min-width:auto 会被长内容顶宽 → 统一允许收缩 */
      .hm-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 2px; border-bottom: 1px solid var(--line); }
      .hm-row .k { font-size: 13px; color: var(--muted); min-width: 0; }
      .hm-row .v { font-size: 15px; font-weight: 600; min-width: 0; text-align: right; display: flex; align-items: center; justify-content: flex-end; flex-shrink: 0; }
      /* 手机端操作区:2+1 布局(三个大按钮不硬塞一行) */
      .hm-actions { display: flex; flex-wrap: wrap; gap: 10px; padding: 14px 0 4px; }
      .hm-actions button { flex: 1 1 calc(50% - 5px); min-width: 0; min-height: 46px; border-radius: 12px; }
      .sec-title { font-size: 12px; color: var(--muted); margin: 16px 2px 4px; letter-spacing: .3px; }
      .mk-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 2px; border-bottom: 1px solid var(--line); cursor: pointer; }
      .mk-row:active { background: var(--panel-2); }
      .mk-row .sym { font-size: 15px; font-weight: 600; }
      .mk-row .sub { font-size: 11px; color: var(--muted); }
      .pf-pos { padding: 11px 2px; border-bottom: 1px solid var(--line); }
      .pf-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px 10px; font-size: 11px; color: var(--muted); margin-top: 6px; }
      .pf-grid b { display: block; font-size: 13px; color: var(--text); font-weight: 600; }
      .sheet-mask { position: fixed; inset: 0; background: rgba(0, 0, 0, .5); display: none; z-index: 60; }
      .sheet-mask.open { display: block; }
      .sheet {
        position: fixed; left: 0; right: 0; bottom: 0; height: 72%; display: flex; flex-direction: column;
        background: var(--bg); border-top: 1px solid var(--line); border-radius: 14px 14px 0 0;
        transform: translateY(100%); transition: transform 220ms ease; z-index: 61;
      }
      .sheet.open { transform: translateY(0); }
      /* 关闭后立即停止过渡/动画:界面不常驻,收起就不该再消耗渲染 */
      .sheet.closing { transition: none !important; }
      .sheet-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--line); }
      .sheet-body { flex: 1; overflow-y: auto; padding: 10px 14px; -webkit-overflow-scrolling: touch; }
      .sheet-foot { padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); border-top: 1px solid var(--line); display: flex; gap: 8px; }
      .sheet-foot input { flex: 1; min-height: 42px; }
      .msg { margin: 8px 0; font-size: 14px; line-height: 1.55; }
      .msg.me { text-align: right; color: var(--muted); }
      .fab {
        position: fixed; right: 16px; bottom: calc(108px + env(safe-area-inset-bottom)); width: 52px; height: 52px;
        border-radius: 50%; background: var(--panel-2); border: 1px solid var(--line); color: var(--text);
        font-size: 16px; font-weight: 600; z-index: 30; display: none;
        box-shadow: 0 6px 18px rgba(0, 0, 0, .22);
      }
      .fab.show { display: block; }
      /* V16.2:pg-fade 与 pageIn 双重动画已合并为 .page.active 上的单一 160ms 动画
         (旧实现同一元素挂两条动画,后加的会覆盖前者,既浪费一层合成也让入场观感不可控) */
      /* ---- V14.3 专业K线交互 ---- */
      #dtChartCard { height: auto; }
      .chart-info {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        padding: 8px 10px 6px; font-size: 11px; border-bottom: 1px solid var(--line);
        font-variant-numeric: tabular-nums;
      }
      .chart-info .ci-time { color: var(--muted); }
      .chart-info .ci-item { color: var(--text); letter-spacing: .2px; }
      .chart-info .ci-chg.green { color: var(--green); }
      .chart-info .ci-chg.red { color: var(--red); }
      .chart-tools {
        /* 真机修复(V2502A 411 CSS px 宽):原来 nowrap + 7 个子元素 → 文字互相挤压重叠、
          按钮里的中文被折成两行。改成可换行 + 按钮不折行 + 手势提示窄屏隐藏。 */
        display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 8px;
        padding: 6px 10px 8px; border-top: 1px solid var(--line); font-size: 11px;
      }
      .chart-tools .ci-note { color: var(--muted); white-space: nowrap; }
      .chart-tools .chart-vol { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
      .chart-tools .chart-vol .ci-item { color: var(--muted); font-variant-numeric: tabular-nums; }
      .chart-tools .chip { min-height: 30px; padding: 4px 10px; white-space: nowrap; flex: 0 0 auto; }
      #dtChartHint { display: none; }   /* 手势提示在窄屏会挤爆工具行(信息可另在帮助里给) */
      #dtCloseCount { white-space: nowrap; flex: 0 0 auto; }
      #dtCanvas { touch-action: none; }
      /* ---- V17 K线专业化:时间轴 / 交易标记 / 全屏 / 复盘 / 长列表虚拟化 ---- */
      .dt-mark-legend {
        position: absolute; top: 30px; right: 8px; z-index: 3;
        display: flex; flex-direction: column; align-items: flex-end; gap: 2px;
        font-size: 10px; color: var(--muted); pointer-events: none; text-align: right;
      }
      .dt-mark-legend.hidden { display: none; }
      .dt-mark-legend .lg { display: flex; align-items: center; justify-content: flex-end; gap: 5px; }
      .dt-mark-legend .sw { display: inline-block; width: 9px; height: 9px; border-radius: 2px; }
      /* ---- V18 实时推送状态 / 收盘倒计时 / 交易标记筛选与气泡 ---- */
      .dt-live { font-size: 11px; color: var(--muted); padding: 0 2px 8px; }
      .dt-live.ok { color: var(--green); }
      .dt-live.warn { color: var(--red); }
      .chart-tools .dt-cd { color: var(--text); font-variant-numeric: tabular-nums; }
      .dt-mark-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 0 10px 8px; font-size: 11px; }
      .dt-mark-filters.hidden { display: none; }
      .dt-mark-filters .mf { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); }
      .dt-mark-filters .mf .sw { display: inline-block; width: 9px; height: 9px; border-radius: 2px; }
      .dt-mark-pop {
        position: absolute; z-index: 6; min-width: 190px; max-width: 82%;
        background: var(--panel-2); border: 1px solid var(--line); border-radius: 9px;
        padding: 9px 10px; font-size: 11.5px; line-height: 1.5; box-shadow: 0 6px 18px rgba(0, 0, 0, .3);
      }
      .dt-mark-pop.hidden { display: none; }
      .dt-mark-pop .mp-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
      .dt-mark-pop .mp-title { font-weight: 650; color: var(--text); }
      .dt-mark-pop .mp-close { border: 0; background: none; color: var(--muted); font-size: 14px; line-height: 1; padding: 0 2px; }
      .dt-mark-pop .mp-row { display: flex; justify-content: space-between; gap: 10px; }
      .dt-mark-pop .mp-row .k { color: var(--muted); white-space: nowrap; }
      .dt-mark-pop .mp-row .v { text-align: right; word-break: break-all; }
      #dtChartCard.dt-fs {
        position: fixed; inset: 0; z-index: 55; height: auto; margin: 0;
        border: 0; border-radius: 0; background: var(--bg);
        display: flex; flex-direction: column;
      }
      #dtChartCard.dt-fs #dtPeriods { position: static; margin: 0; padding: 6px 10px 2px; flex: 0 0 auto; }
      #dtChartCard.dt-fs #dtOhlcBar { flex: 0 0 auto; }
      #dtChartCard.dt-fs #dtCanvas { flex: 1 1 auto; }
      #dtChartCard.dt-fs .chart-tools { flex: 0 0 auto; }
      body.dt-fs-open { overflow: hidden; }
      .chart-tools .chip.on { border-color: var(--green); color: var(--green); }
      #dtReview .rv-grid { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; font-size: 12px; }
      #dtReview .rv-grid .k { color: var(--muted); white-space: nowrap; }
      .rv-journal { max-height: 220px; overflow-y: auto; border-top: 1px solid var(--line); margin-top: 8px; }
      .v-scroll { overflow-y: auto; -webkit-overflow-scrolling: touch; }
      .v-virtual-spacer { position: relative; width: 100%; }
      .v-virtual-layer { position: absolute; left: 0; right: 0; top: 0; }
      /* ---- V15 移动金融 App 观感(排版/间距/分隔线,不用霓虹与渐变) ---- */
      .app, .page { font-variant-numeric: tabular-nums; }
      .hm-hero .big { font-size: 34px; letter-spacing: -.8px; }
      .coin-name { font-size: 15px; font-weight: 600; letter-spacing: .1px; }
      .coin-sub { font-size: 11.5px; line-height: 1.45; }
      .hm-row { padding: 12px 2px; }
      .sec-title { text-transform: none; font-weight: 600; color: var(--text); opacity: .72; margin-top: 18px; }
      .mk-row, .pf-pos { transition: background 120ms ease; }
      .mk-row:active, .pf-pos:active { background: var(--panel-2); }
      .pill { font-size: 11px; padding: 2px 8px; border-radius: 5px; }
      .primary-btn, .sec { min-height: 42px; border-radius: 9px; font-weight: 600; letter-spacing: .2px; }
      .primary-btn.danger { background: var(--red); border-color: var(--red); color: #fff; }
      .sec.danger { color: var(--red); border-color: var(--red); }
      .sec[disabled], .primary-btn[disabled] { opacity: .5; }
      .sec.busy, .primary-btn.busy { opacity: .6; }
      .offline-bar {
        position: fixed; left: 0; right: 0; top: 0; z-index: 70; padding: 7px 12px;
        background: var(--panel-2); border-bottom: 1px solid var(--line);
        color: var(--red); font-size: 12px; text-align: center;
      }
      .offline-bar.hidden { display: none; }
      .toast-box { position: fixed; left: 0; right: 0; bottom: calc(102px + env(safe-area-inset-bottom)); z-index: 80; display: flex; flex-direction: column; align-items: center; gap: 6px; pointer-events: none; }
      .toast {
        background: var(--panel-2); border: 1px solid var(--line); color: var(--text);
        font-size: 12.5px; padding: 8px 14px; border-radius: 8px; max-width: 86%;
      }
      .toast.error { color: var(--red); border-color: var(--red); }
      .ntf-item { padding: 11px 2px; border-bottom: 1px solid var(--line); }
      .ntf-item.unread .ntf-title { font-weight: 650; }
      .ntf-item .ntf-meta { font-size: 11px; color: var(--muted); display: flex; justify-content: space-between; gap: 8px; }
      .ntf-item .ntf-title { font-size: 13.5px; margin: 3px 0 2px; }
      .ntf-item .ntf-body { font-size: 12px; color: var(--muted); line-height: 1.45; }
      .empty-state { padding: 26px 12px; text-align: center; color: var(--muted); font-size: 12.5px; }
      .empty-state button { margin-top: 10px; }
      .spark { width: 100%; height: 44px; display: block; }
      .close-preview { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; font-size: 12px; }
      .close-preview b { display: block; font-size: 13.5px; }
      .chart-tools .chip.active { border-color: var(--text); color: var(--text); }
      /* ---- V16 UI:量化内核 / 系统诊断(分组卡片 + 每行一个组件 + 右侧状态点) ---- */
      .kd-hide { display: none !important; }
      /* V16.1-RV §37(RD-002 真根因):通用 .hidden 之前【根本没有规则】——
         各组件只写了 .chart-empty.hidden / .offline-bar.hidden 这类复合选择器;
         而 #dtReview("card hidden")、#dtDetails、#dtExternalBody、#dtExitFsBtn 依赖裸 class="hidden" 契约,
         结果:空复盘卡一直显示(图表工具行下的空圆角块)、详情/外部情报块折叠失效、非全屏也显示"退出全屏"。
         这里补上唯一规则;不隐藏任何承担布局职责的元素(#dtReview 由 renderReviewBlock 自行增删 hidden)。 */
      .hidden { display: none !important; }
      .kd-group { margin-bottom: 10px; }
      .kd-grouphead {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        margin: 0 2px 5px; font-size: 12px; font-weight: 600; color: var(--text); opacity: .72;
      }
      .kd-rows { border: 1px solid var(--line); border-radius: 10px; background: var(--panel); padding: 0 10px; }
      .kd-row {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding: 9px 0; border-bottom: 1px solid var(--line); min-height: 42px;
      }
      .kd-row:last-child { border-bottom: none; }
      .kd-k { font-size: 13.5px; }
      .kd-sub { font-size: 11px; color: var(--muted); margin-top: 2px; line-height: 1.4; }
      .kd-v { text-align: right; font-size: 12.5px; white-space: nowrap; }
      .kd-dot {
        display: inline-block; width: 8px; height: 8px; border-radius: 50%;
        margin-right: 6px; vertical-align: middle; background: var(--gray);
      }
      .kd-dot.ok { background: var(--green); }
      .kd-dot.warn { background: #d29a3a; }
      .kd-dot.bad { background: var(--red); }
      .kd-dot.na { background: var(--gray); }
      .kd-actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0 2px; }
      .kd-actions button { flex: 1; min-width: 118px; min-height: 40px; }
      .kd-note { font-size: 11px; color: var(--muted); line-height: 1.5; }
      .kd-facts { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; margin-top: 8px; }
      .kd-fact { border: 1px solid var(--line); border-radius: 8px; padding: 7px 9px; }
      .kd-fact span { display: block; font-size: 11px; color: var(--muted); }
      .kd-fact b { font-size: 14px; font-weight: 650; }
      .kd-err { border-bottom: 1px solid var(--line); padding: 10px 0; }
      .kd-err:last-child { border-bottom: none; }
      .kd-err-top { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
      .kd-err-zh { font-size: 14px; font-weight: 600; }
      .kd-err-count { font-size: 12px; color: var(--muted); white-space: nowrap; }
      .kd-err-id { font-size: 11px; color: var(--muted); margin-top: 3px; font-variant-numeric: tabular-nums; }
      .kd-err-p0 { color: var(--red); font-weight: 700; }
      .kd-tech { margin-top: 6px; }
      .kd-tech > summary { font-size: 11.5px; color: var(--muted); cursor: pointer; }
      .kd-tech code {
        display: block; margin-top: 5px; padding: 7px 8px; border: 1px solid var(--line);
        border-radius: 6px; background: var(--panel-2); color: var(--muted);
        font-size: 10.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-all;
      }
      .kd-crumbs { margin: 0; padding: 0; list-style: none; }
      .kd-crumbs li {
        display: flex; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--line);
        font-size: 11.5px; line-height: 1.45;
      }
      .kd-crumbs li:last-child { border-bottom: none; }
      .kd-crumbs .kd-at { color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
      .kd-crumbs .kd-kind { color: var(--muted); white-space: nowrap; }
      /* ---- 开发用性能浮层(默认不可见,仅 Dev 开启) ---- */
      .dev-ov {
        position: fixed; right: 10px; bottom: calc(96px + env(safe-area-inset-bottom)); z-index: 90;
        width: min(252px, 78vw); border: 1px solid var(--line); border-radius: 10px;
        background: var(--bg);
        box-shadow: 0 6px 18px rgba(0, 0, 0, .16); font-size: 11px; color: var(--text);
      }
      .dev-ov-head {
        display: flex; align-items: center; justify-content: space-between; gap: 6px;
        padding: 6px 8px; border-bottom: 1px solid var(--line);
      }
      .dev-ov.collapsed .dev-ov-body { display: none; }
      .dev-ov.collapsed .dev-ov-head { border-bottom: none; }
      .dev-ov-body { padding: 4px 8px 7px; }
      .dev-ov-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 0; }
      .dev-ov-row .k { color: var(--muted); }
      .dev-ov-row .v { font-variant-numeric: tabular-nums; }
      .dev-ov-btn {
        border: 1px solid var(--line); background: transparent; color: var(--text);
        border-radius: 6px; padding: 2px 7px; font-size: 11px; min-height: 24px;
      }
      /* ---- V19 移动端第二轮:模拟页整页重排 / 我的页六组 / 主题 Bottom Sheet / AI FAB 避让 ---- */
      /* 模拟页:主资产卡(总资产最大 → 今日/累计 → 次级小字分层) */
      .pf-hero { padding: 16px 14px 12px; }
      .pf-hero .big { font-size: 30px; font-weight: 800; letter-spacing: -.6px; margin-top: 3px; }
      .pf-hero-line { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 6px; margin-top: 7px; font-size: 13px; }
      .pf-hero-line b { font-size: 14px; font-weight: 700; }
      .pf-hero .v-note { margin-top: 8px; }
      /* 短线/长线:两个独立小卡(只放可用额度/持仓数/今日盈亏/状态) */
      .pf-pools { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
      .pf-pool { padding: 12px; min-width: 0; }
      .pf-pool-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
      .pf-pool-head .coin-name { font-size: 13.5px; }
      .pf-state { font-size: 11px; font-weight: 600; white-space: nowrap; }
      .pf-pool-row { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; margin-top: 8px; }
      .pf-pool-row .k { font-size: 11px; color: var(--muted); white-space: nowrap; }
      .pf-pool-row b { font-size: 13.5px; font-weight: 650; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pf-pool .v-note { margin-top: 9px; }
      /* 操作区:第一行 暂停/导出,第二行 紧急全平(困难动作独占一行,危险色只描边) */
      .hm-actions .wide { flex: 1 1 100%; }
      /* 持仓卡(精简):币种/方向 + 盈亏 + 保证金/杠杆/持仓时间;点击进详情 */
      .pf-pos { padding: 12px 2px; border-bottom: 1px solid var(--line); }
      .pf-pos-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
      .pf-pos-head .name { font-size: 15px; font-weight: 600; min-width: 0; }
      .pf-pos-head .pnl { font-size: 15px; font-weight: 700; white-space: nowrap; }
      .pf-pos .meta { font-size: 11.5px; color: var(--muted); margin-top: 5px; line-height: 1.5; }
      .pf-empty { padding: 14px 2px; color: var(--muted); font-size: 12.5px; border-bottom: 1px solid var(--line); }
      /* 统计:2 列指标卡(紧凑统一,数值不横向溢出) */
      .pf-metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .pf-metric { border: 1px solid var(--line); border-radius: 10px; background: var(--panel); padding: 9px 11px; min-width: 0; }
      .pf-metric .k { display: block; font-size: 11px; color: var(--muted); }
      .pf-metric b { display: block; font-size: 15px; font-weight: 700; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      /* 底部技术说明:默认折叠,不占首屏 */
      .pf-adv { margin-top: 16px; }
      .pf-adv > summary {
        display: flex; align-items: center; justify-content: space-between; gap: 8px; list-style: none; cursor: pointer;
        padding: 13px 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); color: var(--muted); font-size: 13px;
      }
      .pf-adv > summary::-webkit-details-marker { display: none; }
      .pf-adv > summary::after { content: "\203A"; font-size: 16px; line-height: 1; color: var(--gray); transform: rotate(90deg); transition: transform 160ms ease; }
      .pf-adv[open] > summary::after { transform: rotate(-90deg); }
      .pf-adv[open] > summary { border-bottom-left-radius: 0; border-bottom-right-radius: 0; border-bottom: 0; }
      .pf-adv-body { border: 1px solid var(--line); border-top: 0; border-radius: 0 0 12px 12px; background: var(--panel); padding: 6px 14px 12px; }
      /* 折叠区里的长信息行上下排列:窄屏下不再把左侧标签挤成断续的 CJK 断行 */
      .pf-adv-body .hm-row { display: block; padding: 9px 2px; }
      .pf-adv-body .hm-row .k { display: block; }
      .pf-adv-body .hm-row .v { display: block; margin-top: 3px; text-align: right; justify-content: flex-end; }
      /* 我的页:系统设置分组(一组一个容器 + 行间细线,不再层层套 Card) */
      .sg-rows { border: 1px solid var(--line); border-radius: 12px; background: var(--panel); padding: 0 13px; }
      .sg-rows > * + * { border-top: 1px solid var(--line); }
      .sg-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 13px 0; min-height: 52px; }
      .sg-row .sg-left { min-width: 0; }
      .sg-row .sg-left .coin-name { font-size: 14.5px; }
      .sg-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; min-width: 0; max-width: 58%; }
      .sg-val { font-size: 13px; color: var(--muted); white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      .sg-chev { color: var(--gray); font-size: 17px; display: inline-block; width: 22px; min-width: 22px; height: 22px; line-height: 22px; text-align: center; }
      /* 灰徽标在设置组内退成纯文字,去掉大灰 pill 观感(红/绿等有含义的保留底色) */
      .sg-rows .pill { min-width: 0; }
      .sg-rows .pill.gray { background: transparent; color: var(--muted); padding: 2px 0; }
      .sg-btn { min-height: 38px; padding: 0 14px; white-space: nowrap; flex-shrink: 0; }
      /* 系统状态明细容器为空时不占位(避免设置组里出现空行与错位细线) */
      #sysStatusBox:empty { display: none; }
      /* 主题 Bottom Sheet:选项少,高度自适应 */
      .sheet.sheet-sm { height: auto; max-height: 72%; }
      .theme-opt {
        display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 52px; padding: 0 2px;
        border: 0; border-bottom: 1px solid var(--line); background: transparent; color: var(--text); font-size: 15px;
      }
      .theme-opt:last-child { border-bottom: none; }
      .theme-opt .theme-check { display: none; color: var(--green); font-weight: 800; }
      .theme-opt.active .theme-check { display: inline; }
      /* AI FAB 避让:滚动时淡出藏起(不挡价格),停下恢复;四个主视图滚到底留出 FAB 区域 */
      .fab { transition: opacity 180ms ease, transform 180ms ease; }
      .fab.fab-dim { opacity: 0; transform: translateY(10px); pointer-events: none; }
      #page-home, #page-market, #page-paper, #page-detail { padding-bottom: calc(168px + env(safe-area-inset-bottom)); }
      /* ---- V16.2 课堂式 UI:Design Tokens / Button System / 数字层级 / 间距 ---- */
      /* 唯一设计标尺:新样式只从这里取值,避免"每个模块一种颜色、每个按钮一个高度" */
      :root {
        --surface: var(--panel);
        --surface-secondary: var(--panel-2);
        --text-primary: var(--text);
        --text-secondary: var(--muted);
        --border: var(--line);
        --accent: var(--green);
        --profit: var(--green);
        --loss: var(--red);
        --warning: #d29a3a;
        --danger: var(--red);
        --disabled: var(--gray);
        --btn-h: 46px;
        --btn-h-sm: 36px;
        --btn-radius: 12px;
        --card-radius: 14px;
      }
      /* Button System:同类按钮严格同高/同圆角(手机对齐验收按此判定)
         Primary=强调色实底;Secondary=描边浅底;Danger=只给破坏性操作(紧急全平/重置)描边红;Ghost=文字按钮。
         ★ 真根因修复:.sec 以前【没有任何基础样式】—— 全站次级按钮实际是浏览器 UA 默认按钮
         (2px outset 边框 + 系统灰底 + 1px 内边距),这正是"按钮不统一/像网页后台"的来源。 */
      .sec {
        border: 1px solid var(--border);
        background: var(--surface-secondary);
        color: var(--text-primary);
        padding: 0 14px;
        min-height: var(--btn-h);
        border-radius: var(--btn-radius);
        font-size: 14px;
        font-weight: 600;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
      }
      .sec.danger { color: var(--danger); border-color: var(--danger); background: transparent; }
      .primary-btn {
        height: auto;                     /* 覆盖旧基线里的固定 height:48px,与 .sec 同高 */
        min-height: var(--btn-h);
        border-radius: var(--btn-radius);
        font-size: 14px;
        font-weight: 700;
      }
      /* 位于按钮行里的按钮:不许再带"整宽 + 顶部外距"的默认行为(那是竖向主按钮的形态) */
      .hm-actions .primary-btn, .hm-actions .sec, .kd-actions .sec, .v-actions .sec { width: auto; margin-top: 0; }
      .v-close { min-height: 38px; padding: 0 12px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; }
      .chip { min-height: var(--btn-h-sm); border-radius: 10px; }
      .hm-actions button, .v-actions button, .kd-actions button { min-height: var(--btn-h); }
      /* 数字层级:主数字突出但不厚重;次级数字小一级;技术数字(MB/Tick/版本)只允许出现在 内核/诊断 */
      .hm-hero .big { font-weight: 600; }
      .pf-hero .big { font-weight: 600; }
      .pf-metric b, .pf-pool-row b { font-weight: 600; }
      .value { font-weight: 650; }
      /* 分区留白统一(替代散落魔法数) */
      .sec-title { margin-top: 20px; }
      /* ================= V16.2s:Segmented / 星标 / Accordion / 按压反馈 / 溢出护栏 ================= */
      /* 市场/自选 分段控件:圆角容器 + 轻量滑块(transform 动画,不动布局);全部取 Design Tokens,去掉原生控件观感 */
      .seg { position: relative; display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 6px 0 12px; padding: 4px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; }
      .seg-btn { position: relative; z-index: 2; min-height: 38px; border: 0; background: transparent; color: var(--text-secondary); font-size: 14px; font-weight: 600; border-radius: 9px; }
      .seg-btn.active { color: var(--text-primary); }
      .seg-thumb { position: absolute; z-index: 1; top: 4px; bottom: 4px; left: 4px; width: calc(50% - 7px); background: var(--bg); border: 1px solid var(--border); border-radius: 9px; transition: transform 180ms cubic-bezier(.22, .61, .36, 1); }
      .seg[data-seg="watch"] .seg-thumb { transform: translateX(calc(100% + 6px)); }
      /* 星标(自选):市场列表 / 币种详情 / 搜索结果共用一个组件;未收藏=描边,已收藏=accent 实心;命中区 44px */
      .star { width: 44px; height: 44px; min-width: 44px; display: inline-grid; place-items: center; border: 0; background: transparent; color: var(--text-secondary); font-size: 19px; line-height: 1; border-radius: 10px; }
      .star.on { color: var(--accent); }
      /* 市场行:Symbol | Price(右对齐) | 24h Change(定宽) | Star(定宽)——窄屏互不顶走 */
      .mk-row .mk-main { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex: 1 1 auto; }
      .mk-row .mk-price { margin-left: auto; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; flex: 0 0 auto; }
      .mk-row .mk-chg { width: 76px; min-width: 76px; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .mk-row .star { margin: -8px -2px -8px 0; }
      .mk-empty { padding: 26px 12px; text-align: center; color: var(--text-secondary); font-size: 12.5px; line-height: 1.7; }
      /* Accordion:统一展开/收起(0fr→1fr 高度动画,不写死高度);箭头 160-180ms 旋转 */
      .acc-body { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 180ms ease; }
      .acc-body > .acc-inner { overflow: hidden; min-height: 0; }
      .acc.open > .acc-body { grid-template-rows: 1fr; }
      .acc .sg-chev { transition: transform 170ms ease; }
      .acc.open .sg-chev { transform: rotate(90deg); }
      .acc-head { cursor: pointer; }
      .acc.open > .acc-head { border-bottom: 1px solid var(--border); }
      /* 点击按压反馈:pointerdown 立即生效(不等 click handler 跑完);只用 transform,不触发重排 */
      button, .nav-btn, .sg-row, .mk-row, .chip, .theme-opt { transition: transform 70ms ease-out; }
      .pressed { transform: scale(.98); }
      .nav-btn.pressed { transform: scale(.94); }
      /* 长字段/数值溢出护栏:flex 子项可收缩 + 长串换行,不许撑破 Card */
      .card, .sg-rows, .sg-row, .sg-left, .hm-row, .mk-row, .pf-pos { min-width: 0; }
      .coin-name, .coin-sub, .v-note, .hm-row .k, .hm-row .v, .sym, .value, .sg-val, .pill, .kd-err-zh, .kd-err-count { min-width: 0; overflow-wrap: anywhere; }
      .v-table td { overflow-wrap: anywhere; }
      code, .kd-err-id { overflow-wrap: anywhere; word-break: break-all; }
      .pill { max-width: 100%; }
      /* 系统状态:紧凑状态列表;点某一项展开细节,再点收起 */
      .sys-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 10px; padding: 11px 2px; border-bottom: 1px solid var(--border); min-height: 46px; }
      .sys-row:last-child { border-bottom: none; }
      .sys-row .sys-k { font-size: 13.5px; color: var(--text-primary); min-width: 0; overflow-wrap: anywhere; }
      .sys-row .sys-right { display: flex; align-items: center; gap: 6px; margin-left: auto; max-width: 62%; min-width: 0; }
      .sys-row .sys-v { font-size: 13px; color: var(--text-secondary); text-align: right; overflow-wrap: anywhere; min-width: 0; }
      .sys-row .sys-detail { flex-basis: 100%; display: none; padding: 2px 2px 8px; font-size: 11.5px; color: var(--text-secondary); overflow-wrap: anywhere; }
      .sys-row.open .sys-detail { display: block; }
      .sys-row.open .sg-chev { transform: rotate(90deg); }
      .sys-rows-wrap { border-top: 1px solid var(--border); }
      .suggest-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .suggest-row + .suggest-row { border-top: 1px solid var(--border); }
    </style>
  </head>
  <body>
    <main class="app">
      <section id="page-monitor" class="page">
        <div class="top-row">
          <h1>监控</h1>
          <select id="symbolSelect" class="select-wide"></select>
        </div>
        <div class="search-wrap">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.2-3.2"></path></svg>
          <input id="symbolSearch" type="text" placeholder="搜索币种，如 BTC 或 BTCUSDT" autocomplete="off" enterkeyhint="search">
          <div id="searchSuggest" class="search-suggest"></div>
        </div>
        <div class="periods" id="monitorPeriods"></div>
        <div class="card chart-card">
          <div id="chartLegend" class="chart-legend"></div>
          <canvas id="chart"></canvas>
          <div id="chartEmpty" class="chart-empty">暂无K线数据，点击开始分析重试。</div>
        </div>
        <p id="formingNote" class="small-note"></p>
        <div class="price-card">
          <div class="card price-main">
            <span class="label">当前价格</span>
            <strong id="price" class="price">--</strong>
          </div>
          <div class="card">
            <span class="label">24h涨跌幅</span>
            <strong id="change" class="value">--</strong>
          </div>
          <div class="card">
            <span class="label">24h最高 / 最低</span>
            <strong id="highLow" class="value">--</strong>
          </div>
          <div class="card price-main">
            <span class="label">24h成交额</span>
            <strong id="quoteVol" class="value">--</strong>
          </div>
        </div>
        <div class="card status-card">
          <div class="status-head">
            <span id="regimeLabel" class="regime">AI 市场状态</span>
            <span id="directionPill" class="pill gray">--</span>
          </div>
          <div class="meters">
            <div class="meter"><span class="label">信号强度</span><strong id="strengthVal">--</strong><div class="bar"><span id="strengthBar"></span></div></div>
            <div class="meter conf"><span class="label">置信度</span><strong id="confidenceVal">--</strong><div class="bar"><span id="confidenceBar"></span></div></div>
            <div class="meter risk"><span class="label">风险</span><strong id="riskVal">--</strong><div class="bar"><span id="riskBar"></span></div></div>
          </div>
          <div class="tf-row" id="tfRow"></div>
          <div class="detail-lists">
            <div><span class="label">Why · 判断依据</span><ul id="whyList"></ul></div>
            <div><span class="label">Risks · 风险</span><ul id="riskList"></ul></div>
            <div><span class="label">Invalidation · 失效条件</span><ul id="invList"></ul></div>
          </div>
          <p id="anomalyNote" class="note-line"></p>
          <p id="limitedNote" class="note-line"></p>
        </div>
        <button id="analyzeBtn" class="primary-btn" type="button">开始分析</button>
        <p id="monitorStatus" class="status"></p>
      </section>

      <section id="page-scan" class="page">
        <div class="top-row">
          <h1>扫描</h1>
          <div class="top-row-selects">
            <select id="scanSort" class="select-narrow">
              <option value="strength">按强度</option>
              <option value="confidence">按置信度</option>
              <option value="volume">按24h额</option>
              <option value="volatility">按波动</option>
            </select>
            <select id="scanPeriod" class="select-narrow">
              <option value="15m">15分</option>
              <option value="30m">30分</option>
              <option value="1h" selected>1时</option>
              <option value="4h">4时</option>
              <option value="1d">1天</option>
            </select>
          </div>
        </div>
        <p id="scanStatus" class="status">AI Market Radar：批量分析成交额靠前的交易对。</p>
        <div class="progress"><span id="scanProgress"></span></div>
        <button id="scanBtn" class="primary-btn" type="button">开始扫描</button>
        <div class="scan-toolbar" id="scanFilters"></div>
        <div id="scanList" class="list"></div>
      </section>

      <section id="page-watch" class="page">
        <div class="top-row">
          <h1>自选</h1>
        </div>
        <div class="watch-controls">
          <input id="watchInput" placeholder="输入交易对，如 SOLUSDT">
          <button id="addWatchBtn" class="add-btn" type="button">添加</button>
        </div>
        <div id="watchList" class="list"></div>
      </section>

      <section id="page-settings" class="page">
        <div class="top-row">
          <h1>我的</h1>
        </div>
        <div class="sec-title">账户 · App</div>
        <div class="sg-rows">
          <div class="sg-row">
            <div class="sg-left"><div class="coin-name">模拟账户</div><div class="coin-sub">清空本地 Paper 持仓与成交,恢复 100 USDT(短线 70 / 长线 30);不影响历史样本与模型</div></div>
            <button id="resetPaperBtn" class="sec danger sg-btn" type="button">重置</button>
          </div>
          <div class="sg-row" id="devOverlayRow">
            <div class="sg-left"><div class="coin-name">性能浮层</div><div class="coin-sub">默认关闭 · 仅开发时查看 FPS / 内存 / 定时器 / 实例数</div></div>
            <button id="devOverlayToggle" class="switch" type="button" aria-label="性能浮层开关"></button>
          </div>
        </div>
        <div class="sec-title">外观</div>
        <div class="sg-rows">
          <div class="sg-row" id="openThemeSheet">
            <div class="sg-left"><div class="coin-name">主题模式</div><div class="coin-sub">浅色、深色或跟随系统</div></div>
            <div class="sg-right"><span class="sg-val" id="themeValueLabel">深色</span><span class="sg-chev">›</span></div>
          </div>
        </div>
        <div class="sec-title">市场与自选</div>
        <div class="sg-rows">
          <div class="sg-row setting-row">
            <div>
              <div class="coin-name">默认交易对</div>
              <div class="coin-sub">打开页面后默认分析</div>
            </div>
            <select id="defaultSymbol"></select>
          </div>
          <div class="sg-row setting-row">
            <div>
              <div class="coin-name">扫描数量</div>
              <div class="coin-sub">成交额靠前的交易对</div>
            </div>
            <select id="scanLimit">
              <option value="20">20</option>
              <option value="50" selected>50</option>
              <option value="100">100</option>
            </select>
          </div>
          <div class="sg-row setting-row">
            <div>
              <div class="coin-name">刷新间隔</div>
              <div class="coin-sub">监控页自动刷新</div>
            </div>
            <select id="refreshInterval">
              <option value="15">15秒</option>
              <option value="30" selected>30秒</option>
              <option value="60">60秒</option>
            </select>
          </div>
          <div class="sg-row" id="openMonitorLegacy">
            <div class="sg-left"><div class="coin-name">行情监控(详细分析)</div><div class="coin-sub">单币技术面与多周期分析</div></div>
            <div class="sg-right"><span class="sg-chev">›</span></div>
          </div>
          <div class="sg-row" id="openWatchLegacy">
            <div class="sg-left"><div class="coin-name">自选列表</div><div class="coin-sub">管理关注的币种</div></div>
            <div class="sg-right"><span class="sg-chev">›</span></div>
          </div>
        </div>
        <div class="sec-title">学习与验证</div>
        <div class="sg-rows">
          <div class="acc" id="learningAcc">
            <div class="sg-row acc-head" id="openLearning" role="button" tabindex="0" aria-expanded="false">
              <div class="sg-left"><div class="coin-name">学习状态</div><div class="coin-sub">模型版本与市场规律变化(技术信息)</div></div>
              <div class="sg-right"><span class="pill gray" id="learningBadge">--</span><span class="sg-chev">›</span></div>
            </div>
            <div class="acc-body"><div class="acc-inner"><div class="v-note" id="learningDetail"></div></div></div>
          </div>
          <div class="sg-row" id="openValidation">
            <div class="sg-left"><div class="coin-name">历史验证</div><div class="coin-sub">系统此前的判断到底准不准 · 真实结果统计</div></div>
            <div class="sg-right"><span class="pill gray" id="validationBadge">--</span><span class="sg-chev">›</span></div>
          </div>
          <div class="sg-row" id="openBacktest">
            <div class="sg-left"><div class="coin-name">历史回测</div><div class="coin-sub">用历史K线重放引擎,批量生成样本(单独统计)</div></div>
            <div class="sg-right"><span class="pill gray" id="backtestBadge">--</span><span class="sg-chev">›</span></div>
          </div>
          <div class="sg-row" id="openWalkforward">
            <div class="sg-left"><div class="coin-name">滚动验证</div><div class="coin-sub">Train 窗口 → Test 窗口 向前滚动,只看样本外表现</div></div>
            <div class="sg-right"><span class="pill gray" id="wfBadge">--</span><span class="sg-chev">›</span></div>
          </div>
          <div class="sg-row" id="openMl">
            <div class="sg-left"><div class="coin-name">机器学习验证</div><div class="coin-sub">Rule vs LogReg vs LightGBM vs XGBoost(旁路分析,不改写信号)</div></div>
            <div class="sg-right"><span class="pill gray" id="mlBadge">--</span><span class="sg-chev">›</span></div>
          </div>
          <div class="sg-row" id="openDataset">
            <div class="sg-left"><div class="coin-name">数据导出</div><div class="coin-sub">导出真实历史样本(CSV / JSON),特征取信号当时快照</div></div>
            <div class="sg-right"><span class="pill gray" id="dsBadge">--</span><span class="sg-chev">›</span></div>
          </div>
        </div>
        <div class="sec-title">通知</div>
        <div class="sg-rows">
          <div class="sg-row">
            <div class="sg-left"><div class="coin-name">提醒开关</div><div class="coin-sub">明显看涨/看跌时高亮</div></div>
            <button id="notifySwitch" class="switch on" type="button" aria-label="提醒开关"></button>
          </div>
          <div class="sg-row" id="openNtfSettings">
            <div class="sg-left"><div class="coin-name">通知设置</div><div class="coin-sub">开仓 / 平仓 / 风险 / 系统 / 消息 / 模型</div></div>
            <div class="sg-right"><span class="sg-val" id="ntfSetValue">--</span><span class="sg-chev">›</span></div>
          </div>
          <div class="sg-row" id="openNotifications">
            <div class="sg-left"><div class="coin-name">通知中心</div><div class="coin-sub">查看历史提醒与未读</div></div>
            <div class="sg-right"><span class="pill red" id="ntfBadge">0</span><span class="sg-chev">›</span></div>
          </div>
        </div>
        <div class="sec-title">系统</div>
        <div class="sg-rows">
          <div class="sg-row" id="openKernel">
            <div class="sg-left"><div class="coin-name">量化内核</div><div class="coin-sub">引擎 / 模型 / 数据 / 学习 / 服务 · 每个组件当前是否正常</div></div>
            <div class="sg-right"><span class="pill gray" id="kernelBadge">--</span><span class="sg-chev">›</span></div>
          </div>
          <div class="acc" id="sysAcc">
            <div class="sg-row acc-head" id="openSysStatus" role="button" tabindex="0" aria-expanded="false">
              <div class="sg-left"><div class="coin-name">系统状态</div><div class="coin-sub">行情 / 引擎 / 数据库 / 研究 / 学习 / 后台服务 · 点开逐项可展开</div></div>
              <div class="sg-right"><span class="pill gray" id="sysBadge">--</span><span class="sg-chev">›</span></div>
            </div>
            <div class="acc-body"><div class="acc-inner"><div id="sysStatusBox" class="sys-rows-wrap"></div></div></div>
          </div>
          <div class="sg-row" id="openDiag">
            <div class="sg-left"><div class="coin-name">系统诊断</div><div class="coin-sub">黑匣子 · 出问题时自动留下可导出的诊断记录</div></div>
            <div class="sg-right"><span class="pill gray" id="diagBadge">--</span><span class="sg-chev">›</span></div>
          </div>
          <div class="sg-row" id="openHealth">
            <div class="sg-left"><div class="coin-name">行情健康检查</div><div class="coin-sub">Binance / OKX / Bybit 可用性与最近耗时</div></div>
            <div class="sg-right"><span class="pill gray" id="healthBadge">--</span><span class="sg-chev">›</span></div>
          </div>
        </div>
      </section>

      <section id="page-validation" class="page">
        <div class="top-row">
          <h1 style="display:flex;align-items:center;gap:8px"><button id="vBackBtn" class="v-close" type="button">返回</button>历史验证</h1>
          <div class="top-row-selects">
            <button id="vRefreshBtn" class="v-close" type="button">刷新</button>
          </div>
        </div>
        <div class="card" style="margin-bottom:8px">
          <div class="v-note" id="vStatus">正在读取本地历史数据...</div>
          <div class="v-note" id="vEngine" style="margin-top:4px"></div>
        </div>
        <div class="v-stats">
          <div class="v-stat"><b id="vTotal">--</b><span>总样本</span></div>
          <div class="v-stat"><b id="vResolved">--</b><span>已完成验证</span></div>
          <div class="v-stat"><b id="vPending">--</b><span>等待验证</span></div>
        </div>
        <div class="card" style="margin-bottom:8px">
          <div class="setting-row" style="margin-bottom:6px">
            <div class="coin-name">数据来源</div>
            <div class="v-note">默认只统计实时记录,回测样本单独查看</div>
          </div>
          <div class="scan-toolbar" id="vSources"></div>
        </div>
        <div class="card" style="margin-bottom:8px">
          <div class="setting-row" style="margin-bottom:6px">
            <div class="coin-name">验证周期</div>
            <div class="v-note" id="vHorizonNote"></div>
          </div>
          <div class="scan-toolbar" id="vHorizons"></div>
          <div class="coin-name" style="margin:8px 0 6px">市场环境</div>
          <div class="scan-toolbar" id="vRegimes"></div>
        </div>
        <div class="card" style="margin-bottom:8px">
          <h2 style="margin-bottom:6px">总体表现</h2>
          <div class="v-metrics" id="vOverall"></div>
          <div class="v-note" id="vOverallNote" style="margin-top:6px"></div>
        </div>
        <div class="card" style="margin-bottom:8px">
          <h2 style="margin-bottom:6px">置信度分桶与校准</h2>
          <div id="vConfidence"></div>
          <div class="v-note" style="margin-top:6px">预测置信度 = 该桶置信度均值;实际正确率 = 该桶方向判定的真实胜率。两者差距如实显示,不做任何美化。</div>
        </div>
        <div class="card" style="margin-bottom:8px">
          <h2 style="margin-bottom:6px">数据来源</h2>
          <div id="vSource"></div>
          <div class="v-note" style="margin-top:6px">模拟盘 = 打开 App 实时分析记录;回测 = 历史回测重放(不含 24h 行情与市场广度等实时字段)。</div>
        </div>
        <div class="card">
          <div class="setting-row" style="margin-bottom:6px">
            <div class="coin-name">历史样本</div>
            <div class="v-note" id="vListNote"></div>
          </div>
          <div id="vSamples"></div>
          <button id="vMoreBtn" class="v-close" type="button" style="display:none;width:100%;margin-top:8px">加载更多</button>
        </div>
      </section>

      <section id="page-backtest" class="page">
        <div class="top-row">
          <h1 style="display:flex;align-items:center;gap:8px"><button id="btBackBtn" class="v-close" type="button">返回</button>历史回测</h1>
        </div>
        <div class="card" style="margin-bottom:8px">
          <div class="v-note">用历史K线按时间顺序重放引擎(每个时点只看当时已收盘的数据),批量生成样本。回测样本单独统计,不会混入实时记录。</div>
        </div>
        <div class="card" style="margin-bottom:8px">
          <div class="setting-row" style="margin-bottom:8px">
            <div>
              <div class="coin-name">币种</div>
              <div class="coin-sub">如 BTCUSDT / ETHUSDT / SOLUSDT</div>
            </div>
            <input id="btSymbol" type="text" value="BTCUSDT" style="max-width:150px" />
          </div>
          <div class="setting-row" style="margin-bottom:8px">
            <div class="coin-name">主分析周期</div>
            <select id="btInterval" style="max-width:150px"></select>
          </div>
          <div class="setting-row" style="margin-bottom:8px">
            <div>
              <div class="coin-name">历史数据范围</div>
              <div class="coin-sub" id="btRangeHint">--</div>
            </div>
            <select id="btBars" style="max-width:150px"></select>
          </div>
          <div class="coin-name" style="margin:4px 0 6px">结果验证周期</div>
          <div class="scan-toolbar" id="btHorizons"></div>
          <div class="v-actions" style="margin-top:10px">
            <button id="btRunBtn" class="primary-btn" type="button">开始回测</button>
          </div>
        </div>
        <div class="v-progress" id="btProgressBox">
          <div class="v-note" id="btStage">准备中...</div>
          <div class="v-bar"><i id="btProgressBar" style="width:0%"></i></div>
        </div>
        <div class="card" style="margin-bottom:8px" id="btNoteCard">
          <div class="v-note" id="btNote">尚未运行回测。</div>
        </div>
        <div class="card" style="margin-bottom:8px">
          <h2 style="margin-bottom:6px">回测结果(Signal Evaluation)</h2>
          <div class="v-metrics" id="btSummary"></div>
          <div class="v-note" id="btSummaryNote" style="margin-top:6px"></div>
        </div>
        <div class="card" style="margin-bottom:8px">
          <h2 style="margin-bottom:6px">置信度校准(回测)</h2>
          <div id="btCalib"></div>
        </div>
        <div class="card" style="margin-bottom:8px">
          <h2 style="margin-bottom:6px">市场环境表现(回测)</h2>
          <div id="btRegime"></div>
        </div>
        <div class="card">
          <h2 style="margin-bottom:6px">最近回测记录</h2>
          <div id="btRuns"></div>
        </div>
      </section>

      <section id="page-walkforward" class="page">
        <div class="top-row">
            <h1 style="display:flex;align-items:center;gap:8px"><button id="wfBackBtn" class="v-close" type="button">返回</button>滚动验证</h1>
        </div>
        <div class="card" style="margin-bottom:8px">
          <div class="v-note">时间顺序切分:先用一段历史(Train)选出参数与统计,再在紧随其后的完全未来数据(Test)上评估,然后整体向前滚动。Test 窗口数据不参与 Train 的统计与参数选择,不做随机切分。</div>
        </div>
        <div class="card" style="margin-bottom:8px">
          <div class="setting-row" style="margin-bottom:8px">
            <div><div class="coin-name">币种</div><div class="coin-sub">BTCUSDT / ETHUSDT / SOLUSDT</div></div>
            <input id="wfSymbol" type="text" value="BTCUSDT" style="max-width:150px" />
          </div>
          <div class="setting-row" style="margin-bottom:8px">
            <div class="coin-name">主分析周期</div>
            <select id="wfInterval" style="max-width:150px"></select>
          </div>
          <div class="setting-row" style="margin-bottom:8px">
            <div><div class="coin-name">历史数据范围</div><div class="coin-sub" id="wfRangeHint">--</div></div>
            <select id="wfBars" style="max-width:150px"></select>
          </div>
          <div class="setting-row" style="margin-bottom:8px">
            <div class="coin-name">Train 窗口</div>
            <select id="wfTrain" style="max-width:150px">
              <option value="7">7 天</option>
              <option value="14">14 天</option>
              <option value="30" selected>30 天</option>
              <option value="60">60 天</option>
            </select>
          </div>
          <div class="setting-row" style="margin-bottom:8px">
            <div class="coin-name">Test 窗口</div>
            <select id="wfTest" style="max-width:150px">
              <option value="3">3 天</option>
              <option value="7" selected>7 天</option>
              <option value="14">14 天</option>
            </select>
          </div>
          <div class="coin-name" style="margin:4px 0 6px">评估周期(样本外结果)</div>
          <div class="scan-toolbar" id="wfHorizons"></div>
          <div class="v-actions" style="margin-top:10px">
            <button id="wfRunBtn" class="primary-btn" type="button">开始验证</button>
          </div>
        </div>
        <div class="v-progress" id="wfProgressBox">
          <div class="v-note" id="wfStage">准备中...</div>
          <div class="v-bar"><i id="wfBar" style="width:0%"></i></div>
        </div>
        <div class="card" style="margin-bottom:8px">
          <div class="v-note" id="wfNote">尚未运行滚动验证。</div>
        </div>
        <div class="card" style="margin-bottom:8px">
          <h2 style="margin-bottom:6px">样本外汇总</h2>
          <div class="v-metrics" id="wfSummary"></div>
          <div class="v-note" id="wfSummaryNote" style="margin-top:6px"></div>
        </div>
        <div class="card" style="margin-bottom:8px">
          <h2 style="margin-bottom:6px">各折结果</h2>
          <div id="wfFolds"></div>
        </div>
        <div class="card">
          <h2 style="margin-bottom:6px">最近验证记录</h2>
          <div id="wfRuns"></div>
        </div>
      </section>

      <section id="page-dataset" class="page">
        <div class="top-row">
          <h1 style="display:flex;align-items:center;gap:8px"><button id="dsBackBtn" class="v-close" type="button">返回</button>数据导出</h1>
        </div>
        <div class="card" style="margin-bottom:8px">
          <div class="v-note">一行对应一条真实历史 Signal。特征使用信号生成当时保存的快照(feature snapshot),不会用完整历史重算;未解析的结果导出为空值,不是 0。</div>
        </div>
        <div class="card" style="margin-bottom:8px">
          <div class="setting-row" style="margin-bottom:6px">
            <div class="coin-name">数据来源</div>
            <div class="v-note">与历史验证页保持一致</div>
          </div>
          <div class="scan-toolbar" id="dsSources"></div>
          <div class="setting-row" style="margin:8px 0">
            <div><div class="coin-name">币种</div><div class="coin-sub">留空 = 全部币种</div></div>
            <input id="dsSymbol" type="text" placeholder="全部" style="max-width:150px" />
          </div>
          <div class="setting-row" style="margin-bottom:8px">
            <div class="coin-name">起始时间</div>
            <input id="dsFrom" type="date" style="max-width:170px" />
          </div>
          <div class="setting-row" style="margin-bottom:8px">
            <div class="coin-name">结束时间</div>
            <input id="dsTo" type="date" style="max-width:170px" />
          </div>
          <div class="setting-row" style="margin-bottom:8px">
            <div><div class="coin-name">只保留已解析样本</div><div class="coin-sub">按所选周期过滤(其余周期仍导出,未解析为空值)</div></div>
            <select id="dsResolved" style="max-width:150px">
              <option value="all" selected>不筛选</option>
            </select>
          </div>
        </div>
        <div class="card" style="margin-bottom:8px">
          <div class="v-note" id="dsPreviewNote">尚未生成数据集。</div>
          <div class="v-actions" style="margin-top:8px">
            <button id="dsPreviewBtn" class="sec" type="button">预览</button>
            <button id="dsCsvBtn" class="primary-btn" type="button">导出 CSV</button>
            <button id="dsJsonBtn" class="sec" type="button">导出 JSON</button>
          </div>
        </div>
        <div class="card">
          <h2 style="margin-bottom:6px">预览(前 5 行)</h2>
          <div id="dsTable"></div>
        </div>
      </section>

      <section id="page-ml" class="page">
        <div class="top-row">
          <h1 style="display:flex;align-items:center;gap:8px"><button id="mlBackBtn" class="v-close" type="button">返回</button>机器学习验证</h1>
        </div>
        <div class="card" style="margin-bottom:8px">
          <div class="v-note">ML 为旁路分析:不覆盖规则引擎的 方向 / 强度 / 置信度 / 风险。模型输出为概率(非真实上涨概率),未经概率校准前不要当作胜率。训练在离线工具进行(tools/ml),此处只读取结果报告。</div>
        </div>
        <div class="card" style="margin-bottom:8px">
          <div class="setting-row" style="margin-bottom:8px">
            <div><div class="coin-name">导入训练结果</div><div class="coin-sub">选择 tools/ml 产出的 report.json</div></div>
            <input id="mlFile" type="file" accept=".json,application/json" style="max-width:180px" />
          </div>
          <div class="v-actions">
            <button id="mlClearBtn" class="sec" type="button">清除结果</button>
            <button id="mlReloadBtn" class="sec" type="button">重新渲染</button>
          </div>
        </div>
        <div class="card" id="mlRuntimeCard" style="margin-bottom:8px">
          <h2 style="margin-bottom:6px">运行时推理(正式模型)</h2>
          <div class="v-note" id="mlRuntimeStatus">正在读取本地模型状态...</div>
          <div class="hm-row"><span class="k">当前推理来源</span><span class="v" id="mlRuntimeSource">--</span></div>
          <div class="hm-row"><span class="k">模型版本</span><span class="v" id="mlRuntimeVersion">--</span></div>
          <div class="hm-row"><span class="k">热替换次数</span><span class="v" id="mlRuntimeSwaps">0</span></div>
          <div class="setting-row" style="margin:10px 0 8px">
            <div><div class="coin-name">导入模型工件</div><div class="coin-sub">tools/ml 产出的 artifacts.json(系数直接推理,无需重启)</div></div>
            <input id="mlArtifactFile" type="file" accept=".json,application/json" style="max-width:180px" />
          </div>
          <div class="v-actions">
            <button id="mlArtifactPromote" class="sec" type="button">设为正式模型(原子替换)</button>
            <button id="mlArtifactReload" class="sec" type="button">重新加载正式模型</button>
            <button id="mlArtifactTest" class="sec" type="button">推理自检</button>
          </div>
        </div>
        <div class="card" style="margin-bottom:8px">
          <div class="v-note" id="mlStatus">尚未导入模型结果报告。</div>
          <div class="coin-name" style="margin:8px 0 6px">评估周期</div>
          <div class="scan-toolbar" id="mlHorizons"></div>
          <div class="coin-name" style="margin:8px 0 6px">分组表现模型</div>
          <div class="scan-toolbar" id="mlModels"></div>
        </div>
        <div class="card" style="margin-bottom:8px">
          <h2 style="margin-bottom:6px">样本与门槛</h2>
          <div id="mlSamples"></div>
          <div class="v-note" id="mlSamplesNote" style="margin-top:6px"></div>
        </div>
        <div class="card" style="margin-bottom:8px">
          <h2 style="margin-bottom:6px">模型对比(Rule vs ML)</h2>
          <div id="mlCompare"></div>
          <div class="v-note" style="margin-top:6px">按同一份历史数据、同一时间切分、同一 Test 窗口比较;Accuracy 高不代表更好,需同时看 Balanced Accuracy / Macro F1 / 各方向 Recall 与方向收益。</div>
        </div>
        <div class="card" style="margin-bottom:8px">
          <h2 style="margin-bottom:6px">过拟合检查(Train vs Test)</h2>
          <div id="mlOverfit"></div>
        </div>
        <div class="card" style="margin-bottom:8px">
          <h2 style="margin-bottom:6px">概率校准对比</h2>
          <div id="mlCalib"></div>
          <div class="v-note" style="margin-top:6px">Raw = 原始模型概率;Calibrated = Platt(sigmoid),只在 Train 上拟合。若无改善则不应采用。</div>
        </div>
        <div class="card" style="margin-bottom:8px">
          <h2 style="margin-bottom:6px">各折样本外表现</h2>
          <div id="mlFolds"></div>
        </div>
        <div class="card" style="margin-bottom:8px">
          <h2 style="margin-bottom:6px">特征重要性(模型使用程度,非因果)</h2>
          <div id="mlImportance"></div>
        </div>
        <div class="card">
          <h2 style="margin-bottom:6px">按市场环境(池化样本外)</h2>
          <div id="mlRegime"></div>
        </div>
      </section>

      <section id="page-health" class="page">
        <div class="top-row">
          <h1 style="display:flex;align-items:center;gap:8px"><button id="healthBackBtn" class="v-close" type="button">返回</button>行情健康检查</h1>
          <div class="top-row-selects">
            <button id="healthProbeBtn" class="v-close" type="button">立即探测</button>
          </div>
        </div>
        <div class="card" style="margin-bottom:8px">
          <div class="v-note" id="healthStatus">读取中...</div>
        </div>
        <div class="card" style="margin-bottom:8px">
          <h2 style="margin-bottom:6px">上游状态</h2>
          <div id="healthTable"></div>
          <div class="v-note" style="margin-top:6px">OK = 最近请求正常;Slow = 最近请求偏慢;Unavailable = 连续失败被熔断(约 45 秒后自动重试)。</div>
        </div>
        <div class="card" style="margin-bottom:8px">
          <h2 style="margin-bottom:6px">页面诊断(最近 10 条)</h2>
          <div id="healthDiag"></div>
        </div>
        <div class="card">
          <h2 style="margin-bottom:6px">自检</h2>
          <div class="v-actions">
            <button id="healthSelfTest" class="sec" type="button">测试 K线 / 行情 / 分析</button>
          </div>
          <div class="v-note" id="healthSelfResult" style="margin-top:6px"></div>
        </div>
      </section>

      <section id="page-kernel" class="page">
        <div class="top-row">
          <h1 style="display:flex;align-items:center;gap:8px"><button id="kernelBackBtn" class="v-close" type="button">返回</button>量化内核</h1>
          <div class="top-row-selects">
            <button id="kernelRefreshBtn" class="v-close" type="button">刷新</button>
          </div>
        </div>
        <div class="card" style="margin-bottom:10px">
          <div class="setting-row" style="margin-bottom:2px">
            <div>
              <div class="coin-name">运行状态</div>
              <div class="coin-sub" id="kernelModeNote">Paper 模式(模拟盘)</div>
            </div>
            <span class="pill gray" id="kernelStateBadge">--</span>
          </div>
          <div class="kd-facts">
            <div class="kd-fact"><span>版本号</span><b id="kernelVersion">--</b></div>
            <div class="kd-fact"><span>本机学习状态</span><b id="kernelLearning">--</b></div>
          </div>
          <div class="kd-note" id="kernelTopNote" style="margin-top:8px">--</div>
        </div>
        <div id="kernelList"></div>
        <div class="card" style="margin-top:2px">
          <div class="kd-note">只读页面:这里展示的是各组件当前的运行事实(引擎 / 模型 / 数据 / 学习 / 服务)。未接入的能力如实显示「未接入」,不会假装正常。</div>
        </div>
      </section>

      <section id="page-diag" class="page">
        <div class="top-row">
          <h1 style="display:flex;align-items:center;gap:8px"><button id="diagBackBtn" class="v-close" type="button">返回</button>系统诊断</h1>
          <div class="top-row-selects">
            <button id="diagRefreshBtn" class="v-close" type="button">刷新</button>
          </div>
        </div>
        <div class="card" style="margin-bottom:10px">
          <div class="v-note">平时安静运行,出问题时自动留下完整诊断。</div>
          <div class="kd-note" id="diagSummary" style="margin-top:6px">读取中...</div>
          <div class="kd-actions">
            <button id="diagCopyBtn" class="sec" type="button">复制错误信息</button>
            <button id="diagExportBtn" class="primary-btn" type="button">导出诊断包</button>
          </div>
          <div class="kd-note" id="diagActionNote" style="margin-top:6px">导出内容来自本机黑匣子,内部已脱敏。</div>
        </div>
        <div class="card" id="diagErrorsCard" style="margin-bottom:10px">
          <h2 style="margin-bottom:6px">错误去重列表</h2>
          <div id="diagList"></div>
        </div>
        <div class="card kd-hide" id="diagP0Card" style="margin-bottom:10px">
          <h2 style="margin-bottom:6px">关键错误(资金 / 账本 / 崩溃)</h2>
          <div id="diagP0List"></div>
        </div>
        <div class="card" style="margin-bottom:10px">
          <h2 style="margin-bottom:6px">面包屑时间线</h2>
          <div id="diagCrumbs"></div>
        </div>
        <div class="card">
          <h2 style="margin-bottom:6px">运行环境快照</h2>
          <div id="diagSnapshot"></div>
        </div>
      </section>

      <section id="page-ntfset" class="page">
        <div class="top-row">
          <h1 style="display:flex;align-items:center;gap:8px"><button id="ntfsetBackBtn" class="v-close" type="button">返回</button>通知设置</h1>
        </div>
        <div class="v-note" style="margin:2px 2px 10px">选择哪些提醒会记入通知中心并推送到系统通知;关闭后该类提醒不再打扰。</div>
        <div class="sg-rows" id="ntfSettingsBox">
          <div class="sg-row"><span class="coin-name">开仓提醒</span><span class="switch on" id="ntfSetTrade"></span></div>
          <div class="sg-row"><span class="coin-name">平仓提醒</span><span class="switch on" id="ntfSetClose"></span></div>
          <div class="sg-row"><span class="coin-name">风险提醒</span><span class="switch on" id="ntfSetRisk"></span></div>
          <div class="sg-row"><span class="coin-name">系统提醒</span><span class="switch on" id="ntfSetSystem"></span></div>
          <div class="sg-row"><span class="coin-name">重大消息</span><span class="switch on" id="ntfSetNews"></span></div>
          <div class="sg-row"><span class="coin-name">模型更新</span><span class="switch" id="ntfSetModel"></span></div>
        </div>
        <div class="v-note" style="margin-top:10px">默认只开必要的几类(开/平仓、风险、系统、重大消息),避免打扰。</div>
      </section>
    </main>


      <section id="page-home" class="page active">
        <div class="hm-hero">
          <div class="label">今日模拟盈亏</div>
          <div class="big" id="hmTodayPnl">--</div>
          <div class="sub">总模拟资产 <span id="hmEquity">--</span> · 累计 <span id="hmAllTime">--</span></div>
        </div>
        <div class="hm-row"><span class="k">短线资产 · 主策略</span><span class="v"><span id="hmShortEq">--</span> <span class="muted" id="hmShortToday">--</span></span></div>
        <div class="hm-row"><span class="k">长线资产 · 辅助策略</span><span class="v"><span id="hmLongEq">--</span> <span class="muted" id="hmLongToday">--</span></span></div>
        <div class="hm-row"><span class="k">分配</span><span class="v" id="hmAllocation">--</span></div>
        <div class="hm-row"><span class="k">当前持仓</span><span class="v" id="hmPositions">--</span></div>
        <div class="hm-row"><span class="k">今日操作</span><span class="v" id="hmTrades">--</span></div>
        <div class="hm-row"><span class="k">当前风险</span><span class="v" id="hmRisk">--</span></div>
        <div class="hm-row"><span class="k">自动模拟状态</span><span class="v" id="hmState">--</span></div>
        <div class="hm-actions">
          <button id="hmStartBtn" class="primary-btn" type="button">开始模拟</button>
          <button id="hmPauseBtn" class="sec" type="button">暂停模拟</button>
        </div>
        <div class="v-note" id="hmNote">模拟交易仅用于研究,不涉及真实资金。</div>
        <div class="sec-title">学习状态</div>
        <div class="v-note" id="hmLearning">--</div>
      </section>

      <section id="page-market" class="page">
        <div class="top-row">
          <h1>市场</h1>
          <div class="top-row-selects">
            <button id="mkScanBtn" class="v-close" type="button">扫描市场</button>
          </div>
        </div>
        <div class="search-wrap">
          <input id="mkSearch" type="text" placeholder="搜索币种,如 BTC" autocomplete="off" />
          <div id="mkSuggest" class="suggest"></div>
        </div>
        <div class="seg" id="mkSeg" data-seg="market" role="tablist" aria-label="市场与自选">
          <span class="seg-thumb" aria-hidden="true"></span>
          <button class="seg-btn active" id="mkSegMarket" data-seg="market" role="tab" aria-selected="true" type="button">市场</button>
          <button class="seg-btn" id="mkSegWatch" data-seg="watch" role="tab" aria-selected="false" type="button">自选</button>
        </div>
        <div id="mkList"></div>
        <div id="mkWatchList" class="hidden"></div>
      </section>

      <section id="page-paper" class="page">
        <div class="top-row"><h1>模拟</h1><div class="top-row-selects"><span class="pill gray" id="pfEnv">模拟账户</span></div></div>
        <div class="card pf-hero">
          <div class="label">总模拟资产</div>
          <div class="big" id="pfEquity">--</div>
          <div class="pf-hero-line">
            <span class="muted">今日</span><b id="pfToday">--</b>
            <span class="muted">·</span>
            <span class="muted">累计</span><b id="pfTotal">--</b>
          </div>
          <div class="v-note" id="pfLayers">可交易 -- · 已占用 -- · 保护池 --</div>
        </div>
        <div class="pf-pools">
          <div class="card pf-pool">
            <div class="pf-pool-head"><span class="coin-name">短线池</span><span class="pf-state" id="pfShortState">--</span></div>
            <div class="pf-pool-row"><span class="k">可用额度</span><b id="pfShortAvail">--</b></div>
            <div class="pf-pool-row"><span class="k">持仓数</span><b id="pfShortCount">--</b></div>
            <div class="pf-pool-row"><span class="k">今日盈亏</span><b id="pfShortToday">--</b></div>
            <div class="v-note">主策略 · 1h 短线</div>
          </div>
          <div class="card pf-pool">
            <div class="pf-pool-head"><span class="coin-name">长线池</span><span class="pf-state" id="pfLongState">--</span></div>
            <div class="pf-pool-row"><span class="k">可用额度</span><b id="pfLongAvail">--</b></div>
            <div class="pf-pool-row"><span class="k">持仓数</span><b id="pfLongCount">--</b></div>
            <div class="pf-pool-row"><span class="k">今日盈亏</span><b id="pfLongToday">--</b></div>
            <div class="v-note">辅助策略 · 4h 长线</div>
          </div>
        </div>
        <div class="hm-actions">
          <button id="pfPauseEntriesBtn" class="sec" type="button">暂停新开仓</button>
          <button id="pfExportBtn" class="sec" type="button">导出记录</button>
          <button id="pfEmergencyBtn" class="sec danger wide" type="button">紧急全平</button>
        </div>
        <div class="sec-title">当前持仓</div>
        <div id="pfPositions"></div>
        <div class="sec-title">成交记录(点击任意一笔进入复盘)</div>
        <div id="pfTrades"></div>
        <div class="sec-title">统计</div>
        <div id="pfMetrics" class="pf-metrics"></div>
        <details class="pf-adv">
          <summary>详细统计 · 技术信息</summary>
          <div class="pf-adv-body"><div id="pfStatsBox"></div></div>
        </details>
      </section>

      <section id="page-detail" class="page">
        <div class="top-row">
          <div>
            <h1 id="dtSymbol">--</h1>
            <div class="coin-sub"><span id="dtPrice">--</span> · <span id="dtChange" class="muted">--</span></div>
          </div>
          <div class="top-row-selects">
            <button id="dtStar" class="star" type="button" aria-label="自选" aria-pressed="false">☆</button>
            <button id="dtBackBtn" class="v-close" type="button">返回</button>
          </div>
        </div>
        <div class="chip-row" id="dtPeriods" style="margin-bottom:8px"></div>
        <div class="dt-live" id="dtLiveNote">实时行情:连接中…</div>
        <div class="card chart-card" id="dtChartCard">
          <div class="chart-info" id="dtOhlcBar">
            <span class="ci-time" id="dtOhlcTime">--</span>
            <span class="ci-item" id="dtOhlcO">O --</span>
            <span class="ci-item" id="dtOhlcH">H --</span>
            <span class="ci-item" id="dtOhlcL">L --</span>
            <span class="ci-item" id="dtOhlcC">C --</span>
            <span class="ci-item ci-chg muted" id="dtOhlcChg">--</span>
          </div>
          <canvas id="dtCanvas"></canvas>
          <div id="dtMarkLegend" class="dt-mark-legend hidden"></div>
          <div id="dtMarkFilters" class="dt-mark-filters hidden"></div>
          <div id="dtMarkPop" class="dt-mark-pop hidden"></div>
          <div class="chart-tools">
            <span class="ci-note" id="dtChartHint">拖动平移 · 双指缩放 · 长按十字光标</span>
            <div class="chart-vol">
              <span class="ci-note">成交量</span>
              <span class="ci-item" id="dtVolValue">--</span>
            </div>
            <span class="ci-note dt-cd" id="dtCloseCount">--</span>
            <button id="dtMarkToggle" class="chip on" type="button">交易标记</button>
            <button id="dtLatestBtn" class="chip" type="button">最新</button>
            <button id="dtFullBtn" class="chip" type="button" aria-label="全屏"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5"></path><path d="M20 9V4h-5"></path><path d="M4 15v5h5"></path><path d="M20 15v5h-5"></path></svg> 全屏</button>
            <button id="dtExitFsBtn" class="chip hidden" type="button">退出全屏</button>
          </div>
          <div id="dtChartEmpty" class="chart-empty hidden">暂无K线</div>
        </div>
        <div class="card hidden" id="dtReview" style="margin:10px 0"></div>
        <div class="hm-row"><span class="k">综合状态</span><span class="v" id="dtBias">--</span></div>
        <div class="hm-row"><span class="k">风险</span><span class="v" id="dtRisk">--</span></div>
        <div class="hm-row"><span class="k">策略</span><span class="v" id="dtStrategy">--</span></div>
        <div class="card" id="dtFutureCard" style="margin:10px 0">
          <div class="setting-row" style="margin-bottom:6px">
            <div><div class="coin-name">未来预测</div><div class="coin-sub" id="dtFutureNote">概率分布,不是买卖指令</div></div>
            <div class="chart-vol"><span class="ci-item" id="dtFutureHeadline">--</span></div>
          </div>
          <div class="chart-info" id="dtFutureHorizons" style="border-bottom:none;padding-left:0"></div>
          <div class="v-note" id="dtFutureRange">--</div>
        </div>
        <div class="card" id="dtExternalCard" style="margin:10px 0">
          <div class="setting-row" style="margin-bottom:6px">
            <div><div class="coin-name">外部市场情报</div><div class="coin-sub" id="dtExternalNote">Funding / OI / 情绪 · 仅作上下文</div></div>
            <button id="dtExternalToggle" class="v-close" type="button">展开</button>
          </div>
          <div id="dtExternalBody" class="hidden"></div>
          <div class="v-note" id="dtExternalGate">--</div>
        </div>
        <div class="card" id="dtLockCard" style="margin:10px 0" hidden>
          <div class="coin-name" style="margin-bottom:6px">利润保护</div>
          <div class="hm-row"><span class="k">阶段</span><span class="v" id="dtLockStage">--</span></div>
          <div class="hm-row"><span class="k">最高浮盈</span><span class="v" id="dtLockPeak">--</span></div>
          <div class="hm-row"><span class="k">当前浮盈</span><span class="v" id="dtLockNow">--</span></div>
          <div class="hm-row"><span class="k">已回吐</span><span class="v" id="dtLockGiveback">--</span></div>
          <div class="hm-row"><span class="k">剩余仓位 · Trailing</span><span class="v" id="dtLockRemain">--</span></div>
          <div class="v-note" id="dtLockNext">--</div>
        </div>
        <div class="hm-row"><span class="k">回撤状态</span><span class="v" id="dtDrawdown">--</span></div>
        <div id="dtPositionBox"></div>
        <div class="hm-actions">
          <button id="dtRefreshBtn" class="sec" type="button">刷新行情</button>
          <button id="dtDetailsBtn" class="sec" type="button">查看分析详情</button>
        </div>
        <div id="dtDetails" class="hidden"></div>
      </section>

      <button id="chatFab" class="fab show" type="button" aria-label="AI">AI</button>
      <div id="offlineBar" class="offline-bar hidden">离线:行情不可用,引擎继续管理现有持仓</div>
      <div id="toastBox" class="toast-box"></div>

      <div id="devOverlay" class="dev-ov kd-hide" aria-hidden="true">
        <div class="dev-ov-head">
          <b>性能</b>
          <button id="devOverlayCollapse" class="dev-ov-btn" type="button">收起</button>
        </div>
        <div class="dev-ov-body" id="devOverlayBody"></div>
      </div>

      <div id="closeMask" class="sheet-mask"></div>
      <div id="closeSheet" class="sheet">
        <div class="sheet-head">
          <div><div class="coin-name" id="closeTitle">手动平仓</div><div class="coin-sub" id="closeSub">--</div></div>
          <button id="closeSheetClose" class="v-close" type="button">关闭</button>
        </div>
        <div class="sheet-body" id="closeBody"></div>
        <div class="sheet-foot">
          <div class="chip-row" id="closeFractions"></div>
          <button id="closeConfirmBtn" class="primary-btn danger" type="button">确认平仓</button>
        </div>
      </div>

      <div id="ntfMask" class="sheet-mask"></div>
      <div id="ntfSheet" class="sheet">
        <div class="sheet-head">
          <div><div class="coin-name">通知</div><div class="coin-sub" id="ntfSub">--</div></div>
          <div class="top-row-selects">
            <button id="ntfReadBtn" class="v-close" type="button">全部已读</button>
            <button id="ntfSheetClose" class="v-close" type="button">关闭</button>
          </div>
        </div>
        <div class="sheet-body" id="ntfBody"></div>
      </div>
      <div id="chatMask" class="sheet-mask"></div>
      <div id="chatSheet" class="sheet">
        <div class="sheet-head">
          <div><div class="coin-name" id="chatTitle">AI</div><div class="coin-sub" id="chatContext">--</div></div>
          <button id="chatClose" class="v-close" type="button">关闭</button>
        </div>
        <div class="sheet-body" id="chatBody"></div>
        <div class="sheet-foot">
          <input id="chatInput" type="text" placeholder="问点什么,例如:现在适合买吗?" />
          <button id="chatSend" class="primary-btn" type="button">发送</button>
        </div>
      </div>

      <div id="themeMask" class="sheet-mask"></div>
      <div id="themeSheet" class="sheet sheet-sm">
        <div class="sheet-head">
          <div><div class="coin-name">主题模式</div><div class="coin-sub">浅色、深色或跟随系统</div></div>
          <button id="themeSheetClose" class="v-close" type="button">关闭</button>
        </div>
        <div class="sheet-body" id="themeBody">
          <button class="theme-opt" data-theme="system" type="button"><span>跟随系统</span><span class="theme-check">✓</span></button>
          <button class="theme-opt" data-theme="light" type="button"><span>浅色</span><span class="theme-check">✓</span></button>
          <button class="theme-opt" data-theme="dark" type="button"><span>深色</span><span class="theme-check">✓</span></button>
        </div>
      </div>

    <div class="v-overlay" id="vDetail">
      <div class="v-sheet">
        <h2><span id="vDetailTitle">样本详情</span><button id="vDetailClose" class="v-close" type="button">关闭</button></h2>
        <div id="vDetailBody"></div>
      </div>
    </div>

    <nav class="bottom-nav">
      <button class="nav-btn active" data-page="home" type="button"><span class="nav-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11.2 12 4.5l8 6.7"></path><path d="M6.5 10.8V19h11v-8.2"></path></svg></span><span class="nav-text">首页</span></button>
      <button class="nav-btn" data-page="market" type="button"><span class="nav-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16"></path><path d="M7 19V9"></path><path d="M12 19V5"></path><path d="M17 19v-7"></path></svg></span><span class="nav-text">市场</span></button>
      <button class="nav-btn" data-page="paper" type="button"><span class="nav-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="6" width="17" height="12" rx="2"></rect><path d="M7 12h4"></path><path d="M15 9.5v5"></path></svg></span><span class="nav-text">模拟</span></button>
      <button class="nav-btn" data-page="settings" type="button"><span class="nav-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.4"></circle><path d="M5 19.5c1.3-3.1 3.9-4.7 7-4.7s5.7 1.6 7 4.7"></path></svg></span><span class="nav-text">我的</span></button>
    </nav>

    <!--__QE_BUNDLE__-->
    <script>
      const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT"];
      const periods = [
        ["1m", "1分"],
        ["5m", "5分"],
        ["15m", "15分"],
        ["30m", "30分"],
        ["1h", "1时"],
        ["4h", "4时"],
        ["1d", "1天"]
      ];
      const settings = JSON.parse(localStorage.getItem("quantSettings") || "{}");
      const state = {
        symbol: settings.defaultSymbol || "BTCUSDT",
        interval: settings.interval || "1h",
        scanLimit: settings.scanLimit || "50",
        refreshInterval: settings.refreshInterval || "30",
        themeMode: settings.themeMode || "dark",
        notify: settings.notify !== false,
        watch: JSON.parse(localStorage.getItem("watchSymbols") || '["BTCUSDT","ETHUSDT"]'),
        timer: null,
        analyzing: false,
        scanning: false,
        scanResults: [],
        scanFilter: "all",
        scanSort: "strength",
        lastKlines: null
      };
      const $ = (id) => document.getElementById(id);
      const fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 });

      // ================= V16.2s:统一自选 Store / 点击延迟观测 / 冻结看守 =================
      // 自选单一事实来源:市场列表 / 详情星标 / 搜索结果 / 旧自选页 全部走同一套接口;
      // state.watch 降级为"镜像视图"(由订阅同步),兼容仍在读 state.watch 的旧代码。
      // 注意:此处必须用 window.QEngine 直取 —— 模块级 const QE 在其后声明,
      // 在这里引用会踩 TDZ(导航压力测试专门守这条不变量,本次已实测抓到)。
      const watchStore = window.QEngine.createWatchlistStore({
        storage: (() => { try { return window.localStorage; } catch (error) { return null; } })(),
        now: () => Date.now()
      });
      state.watch = watchStore.list();
      watchStore.subscribe((evt) => {
        state.watch = evt.items.slice();
        try { syncWatchUI(evt); } catch (error) { diagLog("watch-ui", error); }
      });
      // 点击延迟观测(DEV 观察面,无业务副作用):window.__quantPerf 供浏览器/真机脚本读取
      const devPerf = window.QEngine.createDevPerf({});
      window.__quantPerf = devPerf;
      try {
        if (window.PerformanceObserver && Array.isArray(PerformanceObserver.supportedEntryTypes) && PerformanceObserver.supportedEntryTypes.indexOf("longtask") >= 0) {
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) devPerf.longTask(entry.duration, "longtask");
          }).observe({ entryTypes: ["longtask"] });
        }
      } catch (error) { /* 观测能力缺失不影响主流程 */ }
      function perfFreezeSnapshot() {
        try {
          const sheets = ["chatSheet", "closeSheet", "ntfSheet", "themeSheet"].filter((id) => { const el = $(id); return Boolean(el && el.classList.contains("open")); });
          const rt = (() => { try { const s = readRuntimeStatus(); return s ? s.state : null; } catch (error) { return null; } })();
          return {
            page: currentPage,
            active_pages: document.querySelectorAll(".page.active").length,
            overlays: sheets,
            gesture: dtChart && dtChart.gesture ? dtChart.gesture.mode : "idle",
            chart_bars: dtChart && dtChart.klines ? dtChart.klines.length : 0,
            sockets: dtWs && dtWs.live ? dtWs.live.size : 0,
            timers: DEV_OV.timers,
            listeners: DEV_OV.listeners,
            mem_mb: devOvMemory(),
            runtime_state: rt
          };
        } catch (error) { return { page: null, error: String((error && error.message) || error) }; }
      }
      // UI 心跳 + 冻结看守:心跳间隔 > 3s(页面可见)记录 UI_FREEZE(带面包屑与状态快照)
      setInterval(() => {
        try {
          if (document.hidden) return;
          const freeze = devPerf.beat(Date.now(), perfFreezeSnapshot());
          if (freeze) {
            const last = freeze.breadcrumbs.length ? freeze.breadcrumbs[freeze.breadcrumbs.length - 1] : null;
            diagLog("ui-freeze", new Error("UI_FREEZE " + freeze.gapMs + "ms 无心跳 · 最后动作 " + ((last && last.label) || "--")));
          }
        } catch (error) { /* 看守自身不许影响主流程 */ }
      }, 200);
      function afterPaint(fn) {
        requestAnimationFrame(() => { requestAnimationFrame(() => { try { fn(); } catch (error) { diagLog("after-paint", error); } }); });
      }
      function tapHandle(el, label) {
        const h = el && el.__pressHandle;
        if (h) return h;
        const handle = devPerf.begin(label || (el && el.dataset && el.dataset.tap) || (el && el.id) || "tap");
        devPerf.note("tap:" + handle.label);
        return handle;
      }
      function perfMark(handle, phase) { try { if (handle) devPerf.mark(handle, phase); } catch (error) { /* ignore */ } }
      // 按压反馈:pointerdown 立即加 .pressed(不等 click handler),pointerup/cancel 移除。
      // 文档级委托(一个监听),不给每个列表行单独绑事件,不会随页面切换累积。
      let pressedEl = null;
      document.addEventListener("pointerdown", (event) => {
        try {
          const target = event.target;
          const el = target && target.closest ? target.closest(".nav-btn, button, .sg-row, .mk-row, .chip, .theme-opt, .acc-head") : null;
          if (!el) return;
          pressedEl = el;
          el.classList.add("pressed");
          const label = (el.dataset && el.dataset.tap) ? el.dataset.tap
            : el.classList.contains("nav-btn") && el.dataset.page ? "tab:" + el.dataset.page
            : el.id ? ("id:" + el.id) : "btn";
          const handle = devPerf.begin(label);
          el.__pressHandle = handle;
          devPerf.note("tap:" + label);
          requestAnimationFrame(() => perfMark(handle, "feedback"));
        } catch (error) { /* 反馈层失败不影响点击本身 */ }
      }, { passive: true, capture: true });
      const clearPressed = () => {
        try { if (pressedEl) pressedEl.classList.remove("pressed"); } catch (error) { /* ignore */ }
        pressedEl = null;
      };
      document.addEventListener("pointerup", clearPressed, { passive: true, capture: true });
      document.addEventListener("pointercancel", clearPressed, { passive: true, capture: true });

      function saveSettings() {
        localStorage.setItem("quantSettings", JSON.stringify({
          defaultSymbol: state.symbol,
          interval: state.interval,
          scanLimit: state.scanLimit,
          refreshInterval: state.refreshInterval,
          themeMode: state.themeMode,
          notify: state.notify
        }));
      }

      // api():失败时保留 HTTP 状态与上游真实原因(不再统一成"行情读取失败")
      // V14.3:接收并透传 AbortSignal —— 离开页面时真正取消在途网络请求(不只是丢弃响应)
      // V14.5:可选 body → 改走 POST(用于把用户问题/结构化摘要发给服务端,避免超长 URL)
      async function api(path, attempts = 3, timeoutMs = 10000, signal, body) {
        const joiner = path.includes("?") ? "&" : "?";
        let lastError;
        for (let i = 0; i < attempts; i += 1) {
          if (signal && signal.aborted) throw abortError(path);
          const t0 = Date.now();
          try {
            const url = body === undefined ? "/api/" + path + joiner + "_=" + Date.now() : "/api/" + path;
            const res = await fetchWithTimeout(url, timeoutMs, signal, body);
            if (!res.ok) {
              let detail = "";
              try {
                const body = await res.json();
                detail = body && (body.detail || body.error) ? String(body.detail || body.error) : "";
              } catch (error) { /* 非 JSON */ }
              const err = new Error("HTTP " + res.status + (detail ? " · " + detail : ""));
              err.status = res.status;
              err.detail = detail;
              err.path = path;
              err.ms = Date.now() - t0;
              throw err;
            }
            const data = await res.json();
            return data;
          } catch (error) {
            // 主动取消(离开页面/换代):不重试,直接抛出
            if (signal && signal.aborted) throw abortError(path);
            if (error && error.status) {
              lastError = error;
            } else {
              const err = new Error((error && error.name === "AbortError" ? "请求超时" : (error && error.message) || "网络错误") + "(" + (Date.now() - t0) + "ms)");
              err.path = path;
              err.ms = Date.now() - t0;
              lastError = err;
            }
            if (i < attempts - 1) await delay(500, signal);
          }
        }
        throw lastError || new Error("行情读取失败");
      }

      // 取消是"预期结果",不是错误:上层据此静默返回(不打诊断日志、不弹提示)
      function abortError(path) {
        const err = new Error("请求已取消");
        err.aborted = true;
        err.path = path;
        return err;
      }

      function isAborted(error) {
        return Boolean(error && (error.aborted || error.name === "AbortError"));
      }

      // 全局错误捕获(开发诊断:只记录,不打扰用户)
      window.addEventListener("error", (event) => {
        try { diagLog("window", event && event.error ? event.error : new Error(String(event && event.message))); } catch (e) { /* ignore */ }
      });
      window.addEventListener("unhandledrejection", (event) => {
        try { diagLog("promise", event && event.reason ? event.reason : new Error("unhandled rejection")); } catch (e) { /* ignore */ }
      });

      // 面向用户的简短错误文案(不带长日志)
      function shortError(error) {
        if (!error) return "行情暂时不可用";
        if (error.status === 502) {
          if (/timeout|aborted/i.test(error.detail || "")) return "上游超时,请稍后重试";
          return "行情源暂时不可用,请稍后重试";
        }
        if (error.status === 400) return "请求参数有误";
        if (/请求超时/.test(error.message || "")) return "请求超时,请检查网络";
        return "行情读取失败,请稍后重试";
      }

      // 开发诊断(仅记录,不展示长日志)
      // V14.3:主动取消(离开页面/换代)不是故障,不写进诊断日志
      function diagLog(tag, error) {
        if (isAborted(error)) return;
        if (!window.__quantDiag) window.__quantDiag = [];
        window.__quantDiag.push({ tag: tag, at: Date.now(), message: (error && error.message) || String(error), status: error && error.status, path: error && error.path, ms: error && error.ms });
        if (window.__quantDiag.length > 50) window.__quantDiag.shift();
      }

      // V14.3:外部 signal(来自 RequestManager)与超时共用同一个 controller → 取消能真正终止 fetch
      // V14.5:body 存在时使用 POST + JSON(服务端不缓存,且避免把长上下文塞进 URL)
      function fetchWithTimeout(url, ms, externalSignal, body) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ms);
        let onAbort = null;
        if (externalSignal) {
          if (externalSignal.aborted) controller.abort();
          else {
            onAbort = () => controller.abort();
            externalSignal.addEventListener("abort", onAbort, { once: true });
          }
        }
        const options = { signal: controller.signal };
        if (body !== undefined) {
          options.method = "POST";
          options.headers = { "content-type": "application/json" };
          options.body = JSON.stringify(body);
        }
        return fetch(url, options).finally(() => {
          clearTimeout(timer);
          if (externalSignal && onAbort) externalSignal.removeEventListener("abort", onAbort);
        });
      }

      // 可取消等待:离开页面时不必等满 500ms 重试间隔
      function delay(ms, signal) {
        if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
        return new Promise((resolve, reject) => {
          if (signal.aborted) { reject(abortError("delay")); return; }
          const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
          const onAbort = () => { cleanup(); reject(abortError("delay")); };
          function cleanup() {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
          }
          signal.addEventListener("abort", onAbort, { once: true });
        });
      }

      function pctClass(value) {
        return value > 0 ? "green" : value < 0 ? "red" : "gray";
      }

      function applyTheme() {
        const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
        const useDark = state.themeMode === "dark" || (state.themeMode === "system" && prefersDark);
        document.documentElement.classList.toggle("theme-dark", useDark);
        // V16.2:pre-paint 阶段为了防首帧白闪写下的内联底色,到这里交还给 CSS 变量 ——
        // 否则内联深色会一直压住 var(--bg),切浅色时 html/body 仍是深色(浏览器 E2E 实测到的真 bug)。
        try {
          document.documentElement.style.backgroundColor = "";
          if (document.body) document.body.style.backgroundColor = "";
        } catch (error) { /* ignore */ }
        document.querySelector('meta[name="theme-color"]').setAttribute("content", useDark ? "#0e1013" : "#ffffff");
      }

      // V19:主题模式改为"点整行 → Bottom Sheet"(跟随系统 / 浅色 / 深色),不再用原生 select
      function themeLabelOf(mode) {
        return mode === "light" ? "浅色" : mode === "system" ? "跟随系统" : "深色";
      }
      function syncThemeUI() {
        const label = $("themeValueLabel");
        if (label) label.textContent = themeLabelOf(state.themeMode);
        document.querySelectorAll(".theme-opt").forEach((btn) => btn.classList.toggle("active", btn.dataset.theme === state.themeMode));
      }
      function openThemeSheet() {
        syncThemeUI();
        $("themeMask").classList.add("open");
        $("themeSheet").classList.add("open");
        updateBackTrap();
      }
      function closeThemeSheet() {
        $("themeMask").classList.remove("open");
        $("themeSheet").classList.remove("open");
        updateBackTrap();
      }

      const DIR_ZH = { "Strong Bullish": "强看涨", "Bullish": "看涨", "Neutral": "中性", "Bearish": "看跌", "Strong Bearish": "强看跌" };
      const DIR_CLASS = { "Strong Bullish": "green", "Bullish": "green", "Neutral": "gray", "Bearish": "red", "Strong Bearish": "red" };
      const RISK_ZH = { Low: "低", Medium: "中", High: "高", Extreme: "极高" };
      const RISK_CLASS = { Low: "green", Medium: "gray", High: "red", Extreme: "red" };

      function emaSeries(values, n) {
        if (values.length < n) return null;
        const out = new Array(values.length).fill(null);
        let sum = 0;
        for (let i = 0; i < n; i += 1) sum += values[i];
        let prev = sum / n;
        out[n - 1] = prev;
        const k = 2 / (n + 1);
        for (let i = n; i < values.length; i += 1) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
        return out;
      }

      function fmtQuote(v) {
        const n = Number(v || 0);
        if (n >= 1e8) return (n / 1e8).toFixed(2) + "亿";
        if (n >= 1e4) return (n / 1e4).toFixed(1) + "万";
        return fmt.format(n);
      }

      function setMeter(name, value) {
        $(name + "Val").textContent = String(Math.round(value));
        $(name + "Bar").style.width = Math.max(0, Math.min(100, value)) + "%";
      }

      function fillList(id, items) {
        const ul = $(id);
        ul.replaceChildren();
        for (const item of items || []) {
          const li = document.createElement("li");
          li.textContent = item;
          ul.appendChild(li);
        }
        if (!ul.children.length) {
          const li = document.createElement("li");
          li.textContent = "暂无";
          ul.appendChild(li);
        }
      }

      function renderAnalysis(r) {
        $("price").textContent = fmt.format(r.price);
        $("change").textContent = (r.change24h >= 0 ? "+" : "") + Number(r.change24h || 0).toFixed(2) + "%";
        $("change").className = "value " + pctClass(r.change24h);
        $("highLow").textContent = fmt.format(r.high24h) + " / " + fmt.format(r.low24h);
        $("quoteVol").textContent = fmtQuote(r.quote_volume_24h);
        $("regimeLabel").textContent = "AI · " + r.market_regime.label + (r.market_regime.trend_market ? " · 趋势市" : " · 区间市") + (r.market_regime.vol_state === "Compression" ? " · 波动压缩" : r.market_regime.vol_state === "Expansion" ? " · 波动放大" : "");
        $("directionPill").textContent = DIR_ZH[r.direction] || r.direction;
        $("directionPill").className = "pill " + (DIR_CLASS[r.direction] || "gray");
        setMeter("strength", r.signal_strength);
        setMeter("confidence", r.confidence);
        $("riskVal").textContent = (RISK_ZH[r.risk_level] || "--") + " " + r.risk_score;
        $("riskVal").className = RISK_CLASS[r.risk_level] || "gray";
        $("riskBar").style.width = Math.max(0, Math.min(100, r.risk_score)) + "%";
        const row = $("tfRow");
        row.replaceChildren();
        for (const tf of Object.keys(r.timeframes)) {
          const label = r.timeframes[tf];
          const chip = document.createElement("span");
          chip.className = "tf-chip " + (DIR_CLASS[label] || "gray");
          chip.textContent = tf + " " + (DIR_ZH[label] || label);
          row.appendChild(chip);
        }
        fillList("whyList", r.reasons);
        fillList("riskList", r.risks);
        fillList("invList", r.invalidation);
        $("anomalyNote").textContent = r.anomaly && r.anomaly.detected ? "⚠ 异常市场状态：" + r.anomaly.kinds.join("、") + "，已自动降低置信度" : "";
        $("limitedNote").textContent = r.limited_data ? "该币历史K线不足（Limited Historical Data），判断仅供参考" : "";
        $("formingNote").textContent = r.forming_candle && r.forming_candle.note ? r.forming_candle.note : "";
        $("monitorStatus").textContent = "已更新 " + new Date().toLocaleTimeString("zh-CN") + " · " + r.model_version;
      }

      function drawChart(klines, analysis) {
        state.lastKlines = klines && klines.length ? klines : state.lastKlines;
        if (!klines || !klines.length) return;
        const canvas = $("chart");
        $("chartEmpty").classList.toggle("hidden", Boolean(klines && klines.length));
        const rect = canvas.parentElement.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const width = Math.max(320, rect.width);
        const height = Math.max(280, rect.height);
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = width + "px";
        canvas.style.height = height + "px";
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const styles = getComputedStyle(document.documentElement);
        const chartBg = styles.getPropertyValue("--chart-bg").trim() || "#12151a";
        const gridColor = styles.getPropertyValue("--line").trim() || "#262b33";
        const mutedColor = styles.getPropertyValue("--muted").trim() || "#8b919a";
        const green = styles.getPropertyValue("--green").trim() || "#00b374";
        const red = styles.getPropertyValue("--red").trim() || "#f6465d";
        ctx.fillStyle = chartBg;
        ctx.fillRect(0, 0, width, height);
        const data = klines.slice(-70).map((k) => ({
          open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5])
        }));
        if (!data.length) {
          $("chartEmpty").classList.remove("hidden");
          $("chartLegend").textContent = "";
          return;
        }
        const closes = data.map((k) => k.close);
        const ema20 = emaSeries(closes, 20);
        const ema50 = emaSeries(closes, 50);
        const lastClose = closes[closes.length - 1];
        const max = Math.max(...data.map((k) => k.high));
        const min = Math.min(...data.map((k) => k.low));
        const pad = { top: 14, right: 50, bottom: 24, left: 8 };
        const volH = Math.round((height - pad.top - pad.bottom) * 0.16);
        const chartH = height - pad.top - pad.bottom - volH - 4;
        const chartW = width - pad.left - pad.right;
        const range = max - min || 1;
        const y = (price) => pad.top + (max - price) / range * chartH;
        const step = chartW / data.length;
        if (analysis && (analysis.support_zones || analysis.resistance_zones)) {
          const zones = (analysis.support_zones || []).concat(analysis.resistance_zones || []);
          for (const zone of zones) {
            if (zone.hi == null || zone.lo == null) continue;
            const zt = y(Math.min(zone.hi, max));
            const zb = y(Math.max(zone.lo, min));
            ctx.fillStyle = zone.hi < lastClose ? "rgba(0, 192, 118, .08)" : "rgba(246, 70, 93, .08)";
            ctx.fillRect(pad.left, zt, chartW, Math.max(2, zb - zt));
          }
        }
        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
          const yy = pad.top + chartH / 4 * i;
          ctx.beginPath();
          ctx.moveTo(pad.left, yy);
          ctx.lineTo(width - pad.right + 8, yy);
          ctx.stroke();
          ctx.fillStyle = mutedColor;
          ctx.font = "11px sans-serif";
          ctx.fillText(fmt.format(max - range / 4 * i), width - pad.right + 12, yy + 4);
        }
        const maxVol = Math.max(...data.map((k) => k.volume)) || 1;
        const volTop = pad.top + chartH + 4;
        data.forEach((k, i) => {
          const vh = Math.max(1, k.volume / maxVol * volH);
          ctx.fillStyle = k.close >= k.open ? "rgba(0, 192, 118, .35)" : "rgba(246, 70, 93, .35)";
          ctx.fillRect(pad.left + step * i + step * 0.2, volTop + volH - vh, Math.max(2, step * 0.6), vh);
        });
        data.forEach((k, i) => {
          const x = pad.left + step * i + step / 2;
          const up = k.close >= k.open;
          const color = up ? green : red;
          const bodyTop = y(Math.max(k.open, k.close));
          const bodyBottom = y(Math.min(k.open, k.close));
          const bodyW = Math.max(3, Math.min(9, step * .62));
          ctx.strokeStyle = color;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.moveTo(x, y(k.high));
          ctx.lineTo(x, y(k.low));
          ctx.stroke();
          ctx.fillRect(x - bodyW / 2, bodyTop, bodyW, Math.max(2, bodyBottom - bodyTop));
        });
        const drawLine = (series, color) => {
          if (!series) return;
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          let started = false;
          series.forEach((v, i) => {
            if (v == null) return;
            const x = pad.left + step * i + step / 2;
            if (!started) { ctx.moveTo(x, y(v)); started = true; } else ctx.lineTo(x, y(v));
          });
          ctx.stroke();
        };
        drawLine(ema20, "rgba(110, 150, 235, .9)");
        drawLine(ema50, "rgba(226, 178, 88, .9)");
        const lastC = data[data.length - 1];
        $("chartLegend").textContent = "O " + fmt.format(lastC.open) + "  H " + fmt.format(lastC.high) + "  L " + fmt.format(lastC.low) + "  C " + fmt.format(lastC.close);
      }

      const ANALYZE_STEPS = [
        "正在获取真实行情...",
        "正在计算技术特征...",
        "正在分析市场结构与支撑阻力...",
        "正在分析多周期一致性...",
        "正在分析BTC联动与市场广度...",
        "正在评估风险...",
        "正在生成综合判断..."
      ];

      // 分析与图表分离:任一失败不影响另一个
      async function analyzeCurrent() {
        if (state.analyzing) return;
        state.analyzing = true;
        $("analyzeBtn").disabled = true;
        let stepIdx = 0;
        $("monitorStatus").textContent = ANALYZE_STEPS[0];
        const stepTimer = setInterval(() => {
          stepIdx = Math.min(stepIdx + 1, ANALYZE_STEPS.length - 1);
          $("monitorStatus").textContent = ANALYZE_STEPS[stepIdx];
        }, 650);

        // 1) 分析结果(主)与 2) 图表K线(辅)各自独立处理
        const req = RM.begin("monitor");
        const analysisTask = api("analyze?symbol=" + state.symbol + "&interval=" + state.interval, 3, 10000, req.signal)
          .then((v) => ({ ok: true, v }))
          .catch((e) => { diagLog("analyze", e); return { ok: false, error: e, aborted: isAborted(e) }; });
        const chartTask = api("klines?market=futures&symbol=" + state.symbol + "&interval=" + state.interval + "&limit=200", 2, 9000, req.signal)
          .then((v) => ({ ok: true, v }))
          .catch((e) => { diagLog("klines", e); return { ok: false, error: e, aborted: isAborted(e) }; });
        const [analysisRes, chartRes] = await Promise.all([analysisTask, chartTask]);
        if (analysisRes.aborted || chartRes.aborted) {
          clearInterval(stepTimer);
          state.analyzing = false;
          $("analyzeBtn").disabled = false;
          return;
        }

        let statusParts = [];
        try {
          if (analysisRes.ok) {
            renderAnalysis(analysisRes.v);
            void historyOnAnalysis(analysisRes.v);
            const time = new Date().toLocaleTimeString("zh-CN");
            statusParts.push("已更新 " + time + " · " + analysisRes.v.market_regime.label);
            if (analysisRes.v.data_degraded) statusParts.push("部分辅助周期数据缺失(已降级)");
          } else {
            statusParts.push("分析失败:" + shortError(analysisRes.error));
          }
          if (chartRes.ok && chartRes.v && chartRes.v.length) {
            drawChart(chartRes.v, analysisRes.ok ? analysisRes.v : null);
          } else {
            // 图表失败:保留/提示,但不影响上面已渲染的分析结果
            if (!state.lastKlines || !state.lastKlines.length) $("chartEmpty").classList.remove("hidden");
            statusParts.push("图表K线读取失败,可稍后重试");
          }
        } finally {
          $("monitorStatus").textContent = statusParts.join(" · ");
          clearInterval(stepTimer);
          state.analyzing = false;
          $("analyzeBtn").disabled = false;
        }
      }

      // 全市场榜单不可用时的备用币池(保证扫描仍能工作)
      const FALLBACK_UNIVERSE_LIST = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "TRXUSDT"];

      async function scanMarket() {
        if (state.scanning) return;
        state.scanning = true;
        $("scanBtn").disabled = true;
        $("scanStatus").textContent = "正在准备扫描...";
        $("scanProgress").style.width = "0%";
        state.scanResults = [];
        const t0 = Date.now();
        const req = RM.begin("scan");
        try {
          // tickers 失败不影响扫描:退回备用币池
          let candidates = null;
          let universeNote = "";
          try {
            const tickers = await api("tickers?market=futures", 2, 8000, req.signal);
            const list = (tickers || [])
              .filter((t) => t.symbol.endsWith("USDT") && !t.symbol.includes("_") && Number(t.quoteVolume) > 5e6)
              .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
              .slice(0, Number(state.scanLimit))
              .map((t) => t.symbol);
            if (list.length) candidates = list;
          } catch (error) {
            if (isAborted(error)) throw error;
            diagLog("scan-tickers", error);
            universeNote = "全市场榜单暂不可用,当前使用备用币池 · ";
          }
          if (!candidates) {
            candidates = FALLBACK_UNIVERSE_LIST.slice(0, Math.max(10, Number(state.scanLimit)));
            universeNote = universeNote || "当前使用备用币池 · ";
          }
          const total = candidates.length;
          let done = 0;
          let success = 0;
          let failedCount = 0;
          const interval = $("scanPeriod").value;
          const BATCH = 5; // 客户端每批 5 个币(服务端并发 4)
          for (let i = 0; i < candidates.length; i += BATCH) {
            const chunk = candidates.slice(i, i + BATCH);
            $("scanStatus").textContent = universeNote + "正在扫描 " + (done + 1) + "/" + total + "：" + chunk[0].replace("USDT", "/USDT") + " ...";
            let rows = [];
            try {
              const res = await api("screen?interval=" + interval + "&symbols=" + chunk.join(","), 2, 12000, req.signal);
              rows = Array.isArray(res.results) ? res.results : [];
            } catch (error) {
              if (isAborted(error)) throw error;
              diagLog("scan-screen", error);
              rows = [];
            }
            // 只重试失败/缺失的币(成功币不重复请求)
            const retrySymbols = chunk.filter((s) => {
              const row = rows.find((r) => r.symbol === s);
              return !row || row.failed;
            });
            if (retrySymbols.length) {
              await delay(400, req.signal);
              try {
                const res2 = await api("screen?interval=" + interval + "&symbols=" + retrySymbols.join(","), 1, 10000, req.signal);
                const rows2 = Array.isArray(res2.results) ? res2.results : [];
                for (const r of rows2) {
                  const idx = rows.findIndex((x) => x.symbol === r.symbol);
                  if (idx >= 0) rows[idx] = r;
                  else rows.push(r);
                }
              } catch (error) {
                if (isAborted(error)) throw error;
                diagLog("scan-retry", error);
              }
            }
            for (const symbol of chunk) {
              const row = rows.find((r) => r.symbol === symbol) || { symbol, failed: true, error_type: "no_response" };
              if (row.failed) failedCount += 1;
              else success += 1;
              state.scanResults.push(row);
            }
            done += chunk.length;
            $("scanProgress").style.width = Math.round((done / total) * 100) + "%";
            renderScanList();
            if (done < total) await delay(250, req.signal);
          }
          const seconds = ((Date.now() - t0) / 1000).toFixed(1);
          $("scanStatus").textContent = universeNote + "扫描完成:成功 " + success + " 个,失败 " + failedCount + " 个,用时 " + seconds + "s";
        } catch (error) {
          if (isAborted(error)) {
            $("scanStatus").textContent = "扫描已取消";
          } else {
            diagLog("scan", error);
            $("scanStatus").textContent = "扫描失败:" + shortError(error) + "(已完成 " + state.scanResults.length + " 个)";
          }
        } finally {
          state.scanning = false;
          $("scanBtn").disabled = false;
        }
      }

      const SCAN_FILTERS = [["all", "全部"], ["bull", "看涨"], ["bear", "看跌"], ["conf", "高置信"], ["spike", "放量"], ["risk", "高风险"]];

      function initScanToolbar() {
        const box = $("scanFilters");
        box.replaceChildren();
        for (const pair of SCAN_FILTERS) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "chip" + (pair[0] === state.scanFilter ? " active" : "");
          btn.textContent = pair[1];
          btn.addEventListener("click", () => {
            state.scanFilter = pair[0];
            box.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === btn));
            renderScanList();
          });
          box.appendChild(btn);
        }
      }

      function scanRowVisible(row) {
        if (row.failed) return state.scanFilter === "all";
        if (state.scanFilter === "bull") return row.direction === "Bullish" || row.direction === "Strong Bullish";
        if (state.scanFilter === "bear") return row.direction === "Bearish" || row.direction === "Strong Bearish";
        if (state.scanFilter === "conf") return row.confidence >= 60;
        if (state.scanFilter === "spike") return Boolean(row.volume_spike);
        if (state.scanFilter === "risk") return row.risk_level === "High" || row.risk_level === "Extreme";
        return true;
      }

      function volRank(row) {
        return { "Extreme": 4, "High": 3, "Normal": 2, "Low": 1, "Very Low": 0 }[row.volatility] || 0;
      }

      function renderScanList() {
        const rows = state.scanResults.filter(scanRowVisible);
        const sorters = {
          strength: (a, b) => (b.signal_strength || 0) - (a.signal_strength || 0),
          confidence: (a, b) => (b.confidence || 0) - (a.confidence || 0),
          volume: (a, b) => (b.quote_volume || 0) - (a.quote_volume || 0),
          volatility: (a, b) => volRank(b) - volRank(a)
        };
        rows.sort(sorters[state.scanSort] || sorters.strength);
        const list = $("scanList");
        list.replaceChildren();
        for (const row of rows) list.appendChild(buildScanRow(row));
        if (!rows.length) {
          const empty = document.createElement("div");
          empty.className = "card muted";
          empty.textContent = "没有符合条件的结果。";
          list.appendChild(empty);
        }
      }

      function buildScanRow(row) {
        const el = document.createElement("div");
        el.className = "card scan-row";
        if (row.failed) {
          const why = row.error_type === "upstream_timeout" ? "上游超时" : row.error_type === "upstream_error" ? "行情源错误" : row.error_type === "no_response" ? "无响应" : "读取失败";
          el.innerHTML = '<div class="sr-main"><b>' + row.symbol.replace("USDT", "/USDT") + '</b><span class="coin-sub">' + why + '(重试后仍失败)</span></div><span class="pill gray">--</span>';
          return el;
        }
        const dirCls = DIR_CLASS[row.direction] || "gray";
        const riskCls = RISK_CLASS[row.risk_level] || "gray";
        el.innerHTML =
          '<div class="sr-main"><b>' + row.symbol.replace("USDT", "/USDT") + '</b><span class="coin-sub">' + fmt.format(row.price) + ' · 24h ' + (row.change24h >= 0 ? "+" : "") + Number(row.change24h || 0).toFixed(1) + '%</span></div>' +
          '<span class="pill gray regime-pill">' + (row.market_regime || "--") + '</span>' +
          '<span class="pill ' + dirCls + '">' + (DIR_ZH[row.direction] || row.direction || "--") + '</span>' +
          '<div class="sr-metrics"><span>强度 ' + (row.signal_strength != null ? row.signal_strength : "--") + ' · 置信 ' + (row.confidence != null ? row.confidence : "--") + '</span><span class="' + riskCls + '">风险 ' + (RISK_ZH[row.risk_level] || "--") + (row.volume_spike ? ' · 放量' : '') + (row.alignment ? ' · ' + row.alignment : '') + '</span></div>';
        return el;
      }

      async function renderWatch() {
        $("watchList").replaceChildren();
        if (!state.watch.length) {
          const empty = document.createElement("div");
          empty.className = "card muted";
          empty.textContent = "还没有添加自选。";
          $("watchList").appendChild(empty);
          return;
        }
        try {
          const req = RM.begin("watch");
          const res = await api("screen?interval=" + state.interval + "&symbols=" + state.watch.join(","), 3, 10000, req.signal);
          if (!req.isCurrent()) return;
          for (const row of res.results) {
            const el = document.createElement("div");
            el.className = "card watch-row";
            if (row.failed) {
              el.innerHTML = '<div><div class="coin-name">' + row.symbol.replace("USDT", "/USDT") + '</div><div class="coin-sub">读取失败，稍后重试</div></div><span class="pill gray">--</span>';
            } else {
              el.innerHTML = '<div><div class="coin-name">' + row.symbol.replace("USDT", "/USDT") + '</div><div class="coin-sub">' + fmt.format(row.price) + ' · 24h ' + (row.change24h >= 0 ? "+" : "") + Number(row.change24h || 0).toFixed(1) + '%</div></div><div class="right"><span class="pill ' + (DIR_CLASS[row.direction] || "gray") + '">' + (DIR_ZH[row.direction] || row.direction) + '</span><div class="coin-sub">置信 ' + row.confidence + ' · 风险' + (RISK_ZH[row.risk_level] || "--") + '</div></div>';
            }
            $("watchList").appendChild(el);
          }
        } catch (error) {
          if (isAborted(error)) return;
          const el = document.createElement("div");
          el.className = "card muted";
          el.textContent = "自选行情读取失败，请稍后重试。";
          $("watchList").appendChild(el);
        }
      }

      const searchState = { list: null, loading: false };

      function fallbackUniverse() {
        return symbols.map((symbol) => ({ symbol, change: 0 }));
      }

      async function loadSymbolUniverse() {
        if (searchState.list || searchState.loading) return;
        searchState.loading = true;
        let list = null;
        const cached = JSON.parse(localStorage.getItem("symbolUniverse") || "null");
        if (cached && Array.isArray(cached.list) && cached.list.length && Date.now() - Number(cached.at) < 86400000) {
          list = cached.list;
        }
        if (!list) {
          try {
            const tickers = await api("tickers?market=futures", 2, 10000);
            list = tickers
              .filter((t) => t.symbol.endsWith("USDT") && !t.symbol.includes("_"))
              .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
              .map((t) => ({ symbol: t.symbol, change: Number(t.priceChangePercent || 0) }));
            if (list.length) localStorage.setItem("symbolUniverse", JSON.stringify({ at: Date.now(), list }));
          } catch (error) {
            list = null;
          }
        }
        searchState.list = list && list.length ? list : fallbackUniverse();
        searchState.loading = false;
      }

      function filterSymbols(query) {
        const q = query.trim().toUpperCase().replace("/", "");
        if (!q) return [];
        const list = searchState.list || fallbackUniverse();
        const starts = [];
        const contains = [];
        for (const item of list) {
          if (item.symbol.startsWith(q)) starts.push(item);
          else if (item.symbol.includes(q)) contains.push(item);
          if (starts.length >= 8) break;
        }
        return starts.concat(contains).slice(0, 8);
      }

      function ensureOption(select, symbol) {
        if (!Array.from(select.options).some((option) => option.value === symbol)) {
          const option = document.createElement("option");
          option.value = symbol;
          option.textContent = symbol.replace("USDT", "/USDT");
          select.appendChild(option);
        }
      }

      function renderSuggest(items) {
        const box = $("searchSuggest");
        box.replaceChildren();
        if (!items.length) {
          box.classList.remove("open");
          return;
        }
        for (const item of items) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "suggest-item";
          btn.innerHTML = '<span>' + item.symbol.replace("USDT", "/USDT") + '</span><span class="muted ' + pctClass(item.change) + '">' + (item.change >= 0 ? "+" : "") + item.change.toFixed(2) + "%</span>";
          btn.addEventListener("click", () => selectSearchSymbol(item.symbol));
          box.appendChild(btn);
        }
        box.classList.add("open");
      }

      function selectSearchSymbol(symbol) {
        state.symbol = symbol;
        ensureOption($("symbolSelect"), symbol);
        ensureOption($("defaultSymbol"), symbol);
        $("symbolSelect").value = symbol;
        $("defaultSymbol").value = symbol;
        $("symbolSearch").value = "";
        $("searchSuggest").classList.remove("open");
        saveSettings();
        analyzeCurrent();
      }

      function setup() {
        applyTheme();
        if (window.matchMedia) {
          window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
            if (state.themeMode === "system") applyTheme();
          });
        }
        for (const id of ["symbolSelect", "defaultSymbol"]) {
          const select = $(id);
          symbols.forEach((symbol) => {
            const option = document.createElement("option");
            option.value = symbol;
            option.textContent = symbol.replace("USDT", "/USDT");
            select.appendChild(option);
          });
          select.value = state.symbol;
        }
        periods.forEach(([value, label]) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "period-btn" + (value === state.interval ? " active" : "");
          btn.textContent = label;
          btn.addEventListener("click", () => {
            state.interval = value;
            document.querySelectorAll(".period-btn").forEach((item) => item.classList.toggle("active", item === btn));
            saveSettings();
            analyzeCurrent();
          });
          $("monitorPeriods").appendChild(btn);
        });
        $("symbolSelect").addEventListener("change", (event) => {
          state.symbol = event.target.value;
          $("defaultSymbol").value = state.symbol;
          saveSettings();
          analyzeCurrent();
        });
        $("defaultSymbol").addEventListener("change", (event) => {
          state.symbol = event.target.value;
          $("symbolSelect").value = state.symbol;
          saveSettings();
        });
        const searchInput = $("symbolSearch");
        const closeSuggest = () => $("searchSuggest").classList.remove("open");
        searchInput.addEventListener("focus", () => {
          loadSymbolUniverse().then(() => {
            if (document.activeElement === searchInput) renderSuggest(filterSymbols(searchInput.value));
          });
        });
        searchInput.addEventListener("input", () => {
          if (!searchState.list) loadSymbolUniverse();
          renderSuggest(filterSymbols(searchInput.value));
        });
        searchInput.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            const items = filterSymbols(searchInput.value);
            if (items.length) selectSearchSymbol(items[0].symbol);
          } else if (event.key === "Escape") {
            closeSuggest();
            searchInput.blur();
          }
        });
        document.addEventListener("click", (event) => {
          if (event.target instanceof Element && !event.target.closest(".search-wrap")) closeSuggest();
        });
        if (!["20", "50", "100"].includes(state.scanLimit)) state.scanLimit = "50";
        if (!["system", "light", "dark"].includes(state.themeMode)) state.themeMode = "dark";
        $("scanLimit").value = state.scanLimit;
        $("refreshInterval").value = state.refreshInterval;
        $("scanLimit").addEventListener("change", (event) => { state.scanLimit = event.target.value; saveSettings(); });
        $("refreshInterval").addEventListener("change", (event) => { state.refreshInterval = event.target.value; saveSettings(); startTimer(); });
        syncThemeUI();   // V19:主题值只在"我的 > 外观"行与 Bottom Sheet 里同步(不再有原生 select)
        $("notifySwitch").classList.toggle("on", state.notify);
        $("notifySwitch").addEventListener("click", () => { state.notify = !state.notify; $("notifySwitch").classList.toggle("on", state.notify); saveSettings(); });
        $("analyzeBtn").addEventListener("click", analyzeCurrent);
        $("scanBtn").addEventListener("click", scanMarket);
        $("scanSort").addEventListener("change", (event) => {
          state.scanSort = event.target.value;
          renderScanList();
        });
        $("scanPeriod").addEventListener("change", () => {
          if ($("scanList").children.length) scanMarket();
        });
        initScanToolbar();
        $("addWatchBtn").addEventListener("click", () => {
          let symbol = $("watchInput").value.trim().toUpperCase().replace("/", "");
          if (!symbol) return;
          if (!symbol.endsWith("USDT")) symbol += "USDT";
          // V16.2s:统一走 Watchlist Store(去重/持久化/失败提示都在 Store 内闭环)
          const res = watchStore.add(symbol);
          if (res.reason === "invalid_symbol") { toast("该币种不支持自选"); return; }
          if (res.reason === "limit_reached") { toast("自选已达上限(" + watchStore.limit + " 个)"); return; }
          if (res.reason === "persist_failed") { toast("自选保存失败", "error"); return; }
          $("watchInput").value = "";
          renderWatch();
        });
        // V14.3:底部导航只由 initMobileUI 统一绑定(避免同一按钮两套 handler 导致重复切页)
        window.addEventListener("resize", analyzeCurrent);
        analyzeCurrent();
        startTimer();
      }

      function startTimer() {
        if (state.timer) clearInterval(state.timer);
        state.timer = setInterval(analyzeCurrent, Number(state.refreshInterval) * 1000);
      }

      // 注意:setup() 在所有模块级声明(const QE / const RM 等)之后才调用,
      // 否则 analyzeCurrent 里的 RM.begin 会踩 TDZ(导航压力测试专门守这条不变量)

      // ================= V10 历史验证(Signal History + Outcome Tracker + Calibration) =================
      const QE = window.QEngine;
      const HZ_ZH = { "5m": "5分钟", "15m": "15分钟", "1h": "1小时", "4h": "4小时", "24h": "24小时" };
      const OUT_ZH = { Bullish: "上涨", Bearish: "下跌", Neutral: "震荡" };
      const VERDICT_ZH = { correct: "正确", wrong: "错误", neutral: "中性" };
      const OUT_CLASS = { Bullish: "green", Bearish: "red", Neutral: "gray" };
      const RESOLVE_MIN_GAP_MS = 180000;
      const vstate = {
        store: null,
        records: [],
        horizon: "1h",
        regime: "全部",
        source: "live",
        shown: 50,
        dirty: true,
        resolving: false,
        lastResolve: 0,
        chipsReady: false
      };

      function vEl(tag, cls, text) {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = String(text);
        return node;
      }

      function vPct(v, digits) {
        if (v == null || !isFinite(v)) return "--";
        const n = Number(v);
        return (n > 0 ? "+" : "") + n.toFixed(digits == null ? 2 : digits) + "%";
      }

      function vRatio(v) {
        return v == null || !isFinite(v) ? "--" : Number(v).toFixed(1) + "%";
      }

      function vTime(ms) {
        if (!ms) return "--";
        const d = new Date(Number(ms));
        return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      }

      function vTable(headers, rows) {
        const table = vEl("table", "v-table");
        const thead = vEl("thead");
        const headRow = vEl("tr");
        headers.forEach((h, i) => headRow.appendChild(vEl("th", i === 0 ? null : "num", h)));
        thead.appendChild(headRow);
        table.appendChild(thead);
        const tbody = vEl("tbody");
        for (const cells of rows) {
          const tr = vEl("tr");
          cells.forEach((cell, i) => {
            const td = vEl("td", i === 0 ? null : "num");
            if (cell && cell.nodeType === 1) td.appendChild(cell);
            else td.textContent = cell == null ? "--" : String(cell);
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        return table;
      }

      function vMetric(label, value, cls) {
        const box = vEl("div", "v-metric");
        box.appendChild(vEl("span", null, label));
        box.appendChild(vEl("b", cls || null, value));
        return box;
      }

      function vPill(direction) {
        return vEl("span", "pill " + (DIR_CLASS[direction] || "gray"), DIR_ZH[direction] || direction || "--");
      }

      function sampleNote(quality, resolved) {
        if (quality === "insufficient") return "样本不足(" + resolved + " 条已验证),统计结果暂不可参考";
        if (quality === "low") return "样本偏少(" + resolved + " 条已验证),仅供参考";
        if (quality === "medium") return "全部周期统计基于 " + resolved + " 条已验证样本";
        return "全部周期统计基于 " + resolved + " 条已验证样本";
      }

      async function historyStore() {
        if (!vstate.store) {
          if (!QE || !QE.createHistoryStore) throw new Error("QEngine 未加载");
          vstate.store = await QE.createHistoryStore();
        }
        return vstate.store;
      }

      // ---- 1) 真实分析结果落库(带去重) ----
      async function historyOnAnalysis(result) {
        try {
          const store = await historyStore();
          const res = await QE.recordAnalysis(store, result, { source: "live" });
          if (res.recorded) {
            vstate.dirty = true;
            $("monitorStatus").textContent += " · 已记录到历史";
          }
          scheduleResolve(1200);
        } catch (error) {
          // 历史系统异常不影响正常分析与展示
        }
      }

      // ---- 2) 到期结果追踪(节流 + 只处理到期周期) ----
      let resolveTimer = null;
      function scheduleResolve(delayMs) {
        if (resolveTimer) return;
        resolveTimer = setTimeout(() => {
          resolveTimer = null;
          runResolve({ force: false }).catch(() => {});
        }, delayMs == null ? 1500 : delayMs);
      }

      async function fetchKlinesForHistory(symbol, interval, limit) {
        // 历史补齐属于"后台任务":离开相关页面即取消在途取数,避免堆积
        const req = RM.begin("history");
        const raw = await api("klines?market=futures&symbol=" + symbol + "&interval=" + interval + "&limit=" + limit, 1, 6000, req.signal);
        return QE.normalizeKlines(raw, interval);
      }

      async function runResolve(options) {
        const opts = options || {};
        if (vstate.resolving) return null;
        if (!vstate.dirty && !opts.force && Date.now() - vstate.lastResolve < RESOLVE_MIN_GAP_MS) return null;
        vstate.resolving = true;
        vstate.lastResolve = Date.now();
        let report = null;
        try {
          const store = await historyStore();
          report = await QE.resolveDueOutcomes(store, fetchKlinesForHistory, { maxSignals: 40, maxFetches: 8, limit: 1200 });
          if (report && report.resolved) vstate.dirty = true;
        } catch (error) {
          report = null;
        } finally {
          vstate.resolving = false;
        }
        return report;
      }

      // ---- 3) 读取与视图 ----
      async function loadRecords() {
        const store = await historyStore();
        const joined = await store.joined({ limit: 4000 });
        vstate.records = QE.usableRecords(joined);
        vstate.dirty = false;
        return vstate.records;
      }

      function updateBadge() {
        const liveCount = QE.filterBySource(vstate.records, "live").length;
        const btCount = QE.filterBySource(vstate.records, "backtest").length;
        $("validationBadge").textContent = vstate.records.length ? "实时 " + liveCount : "暂无";
        $("backtestBadge").textContent = btCount ? "回测 " + btCount : "暂无";
        $("dsBadge").textContent = vstate.records.length ? vstate.records.length + " 条" : "暂无";
        $("wfBadge").textContent = btCount ? "回测 " + btCount : "暂无";
      }

      function buildChips() {
        if (vstate.chipsReady) return;
        const srcBox = $("vSources");
        for (const item of QE.SOURCE_FILTERS) {
          const btn = vEl("button", "chip" + (item.key === vstate.source ? " active" : ""), item.label);
          btn.type = "button";
          btn.addEventListener("click", () => {
            vstate.source = item.key;
            vstate.shown = 50;
            srcBox.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === btn));
            renderValidation();
            updateBadge();
          });
          srcBox.appendChild(btn);
        }
        const hzBox = $("vHorizons");
        for (const h of QE.HORIZONS) {
          const btn = vEl("button", "chip" + (h === vstate.horizon ? " active" : ""), HZ_ZH[h] || h);
          btn.type = "button";
          btn.addEventListener("click", () => {
            vstate.horizon = h;
            vstate.shown = 50;
            hzBox.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === btn));
            renderValidation();
          });
          hzBox.appendChild(btn);
        }
        const rgBox = $("vRegimes");
        for (const r of QE.REGIME_FILTERS) {
          const btn = vEl("button", "chip" + (r === vstate.regime ? " active" : ""), r);
          btn.type = "button";
          btn.addEventListener("click", () => {
            vstate.regime = r;
            vstate.shown = 50;
            rgBox.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === btn));
            renderValidation();
          });
          rgBox.appendChild(btn);
        }
        vstate.chipsReady = true;
      }

      function renderValidation() {
        const view = QE.buildValidationView(vstate.records, { horizon: vstate.horizon, regime: vstate.regime, source: vstate.source });
        $("vEngine").textContent = "Engine " + (view.engine_version || "未知") + " · 数据来源 " + view.source_label + " · 验证周期 " + (HZ_ZH[view.horizon] || view.horizon) + " · 环境筛选 " + view.regime;
        $("vTotal").textContent = String(view.total);
        $("vResolved").textContent = String(view.resolved);
        $("vPending").textContent = String(view.pending);
        $("vHorizonNote").textContent = (HZ_ZH[view.horizon] || view.horizon) + " 后价格";
        $("vStatus").textContent = view.total
          ? "数据来源:" + view.source_label + " · " + sampleNote(view.quality, view.resolved)
          : "数据来源:" + view.source_label + " · 暂无历史样本。完成真实市场分析后,这里会开始积累验证数据。";

        const ov = view.overall;
        const metrics = $("vOverall");
        metrics.replaceChildren();
        metrics.appendChild(vMetric("方向准确率", vRatio(ov.accuracy), ov.accuracy == null ? null : ov.accuracy >= 50 ? "green" : "red"));
        metrics.appendChild(vMetric("中性比例(噪声区)", vRatio(ov.neutral_rate)));
        metrics.appendChild(vMetric("看涨准确率(" + ov.bull_samples + ")", vRatio(ov.bull_accuracy)));
        metrics.appendChild(vMetric("看跌准确率(" + ov.bear_samples + ")", vRatio(ov.bear_accuracy)));
        metrics.appendChild(vMetric("平均方向收益", vPct(ov.avg_return)));
        metrics.appendChild(vMetric("中位方向收益", vPct(ov.median_return)));
        metrics.appendChild(vMetric("平均 MFE", vPct(ov.avg_mfe)));
        metrics.appendChild(vMetric("平均 MAE", vPct(ov.avg_mae)));
        $("vOverallNote").textContent = "判定 " + ov.correct + " 正确 / " + ov.wrong + " 错误 / " + ov.neutral + " 中性(噪声区内不计入方向准确率)"

        const confBox = $("vConfidence");
        confBox.replaceChildren();
        if (!view.by_confidence.length) {
          confBox.appendChild(vEl("div", "v-note", "暂无样本"));
        } else {
          const gapByKey = new Map(view.calibration.map((c) => [c.bucket, c.gap]));
          const rows = view.by_confidence.map((b) => {
            const gap = gapByKey.get(b.key);
            return [
              b.key + (b.predicted_confidence != null ? " (均值 " + Math.round(b.predicted_confidence) + ")" : ""),
              String(b.samples),
              vRatio(b.accuracy),
              gap == null ? "--" : (gap > 0 ? "+" : "") + gap.toFixed(1),
              vPct(b.avg_return),
              vPct(b.avg_mfe),
              vPct(b.avg_mae)
            ];
          });
          confBox.appendChild(vTable(["置信度桶", "样本", "实际正确率", "准确率-置信度", "平均收益", "平均MFE", "平均MAE"], rows));
        }

        const srcBox = $("vSource");
        srcBox.replaceChildren();
        if (!view.by_source.length) {
          srcBox.appendChild(vEl("div", "v-note", "暂无样本"));
        } else {
          srcBox.appendChild(vTable(["来源", "样本", "已验证", "方向准确率"], view.by_source.map((s) => [
            s.key === "backtest" ? "回测重放" : "实时记录",
            String(s.samples),
            String(s.resolved),
            vRatio(s.accuracy)
          ])));
        }

        renderSampleList(view);
      }

      function renderSampleList(view) {
        const box = $("vSamples");
        box.replaceChildren();
        const rows = view.rows;
        $("vListNote").textContent = rows.length ? "显示 " + Math.min(vstate.shown, rows.length) + "/" + rows.length + " 条" : "";
        if (!rows.length) {
          const empty = vEl("div", "card muted", vstate.records.length ? "当前筛选条件下没有样本。" : "暂无历史样本");
          box.appendChild(empty);
          if (!vstate.records.length) box.appendChild(vEl("div", "v-note", "完成真实市场分析后,这里会开始积累验证数据。"));
          $("vMoreBtn").style.display = "none";
          return;
        }
        for (const row of rows.slice(0, vstate.shown)) {
          const el = vEl("div", "card v-sample");
          const head = vEl("div", "watch-row");
          const left = vEl("div");
          left.appendChild(vEl("div", "coin-name", row.symbol.replace("USDT", "/USDT") + " · " + row.interval));
          left.appendChild(vEl("div", "coin-sub", vTime(row.timestamp) + " · 价格 " + fmt.format(row.price) + " · " + (row.market_regime || "--")));
          head.appendChild(left);
          const right = vEl("div", "right");
          const pills = vEl("div");
          pills.appendChild(vPill(row.direction));
          if (row.outcome == null) {
            pills.appendChild(vEl("span", "pill gray", "等待验证"));
          } else {
            pills.appendChild(vEl("span", "pill " + (OUT_CLASS[row.outcome] || "gray"), OUT_ZH[row.outcome] + " " + (VERDICT_ZH[row.verdict] || "")));
          }
          right.appendChild(pills);
          right.appendChild(vEl("div", "coin-sub", "强度 " + row.signal_strength + " · 置信 " + row.confidence + " · 风险 " + (RISK_ZH[row.risk_level] || "--") + (row.return_pct == null ? "" : " · " + vPct(row.return_pct))));
          head.appendChild(right);
          el.appendChild(head);
          el.addEventListener("click", () => openDetail(row.id));
          box.appendChild(el);
        }
        $("vMoreBtn").style.display = rows.length > vstate.shown ? "block" : "none";
      }

      function vList(id, items, emptyText) {
        const ul = $(id);
        ul.replaceChildren();
        const list = items && items.length ? items : [emptyText];
        for (const item of list) {
          const li = document.createElement("li");
          li.textContent = item;
          ul.appendChild(li);
        }
      }

      function openDetail(signalId) {
        const record = vstate.records.find((r) => r.signal && r.signal.id === signalId);
        const d = QE.detailView(record);
        if (!d) return;
        $("vDetailTitle").textContent = d.symbol.replace("USDT", "/USDT") + " · " + vTime(d.timestamp);
        const body = $("vDetailBody");
        body.replaceChildren();

        const kv = vEl("div", "v-kv");
        const pairs = [
          ["当时价格", fmt.format(d.price)],
          ["信号时间", vTime(d.timestamp)],
          ["数据截止(K线收盘)", vTime(d.data_close_time)],
          ["方向", (DIR_ZH[d.direction] || d.direction) + " · 强度 " + d.signal_strength + " · 置信 " + d.confidence],
          ["风险", (RISK_ZH[d.risk_level] || "--") + " " + d.risk_score],
          ["市场环境", (d.market_regime || "--") + (d.regime_adx != null ? " · ADX " + d.regime_adx : "") + (d.regime_atr_pct != null ? " · ATR " + d.regime_atr_pct + "%" : "")],
          ["结构", (d.structure_label || "--") + (d.last_swing_low ? " · 结构低 " + fmt.format(d.last_swing_low) : "")],
          ["量能/波动", (d.volume_pattern || "--") + (d.volume_ratio20 != null ? " (" + d.volume_ratio20 + "x)" : "") + " · 波动 " + (d.volatility_level || "--")],
          ["BTC 联动", d.btc_state ? d.btc_state + (d.btc_corr != null ? " · 相关性 " + d.btc_corr : "") : "--"],
          ["数据来源", d.source === "backtest" ? "历史回测重放" : "实时记录"],
          ["引擎版本", (d.engine_version || "--") + " / " + (d.feature_version || "--")]
        ];
        for (const [k, v] of pairs) {
          kv.appendChild(vEl("span", null, k));
          kv.appendChild(vEl("span", null, v));
        }
        body.appendChild(kv);

        const tfBox = vEl("div", "scan-toolbar");
        tfBox.style.marginTop = "8px";
        for (const tf of Object.keys(d.timeframes || {})) {
          const label = d.timeframes[tf];
          tfBox.appendChild(vEl("span", "tf-chip " + (DIR_CLASS[label] || "gray"), tf + " " + (DIR_ZH[label] || label)));
        }
        if (tfBox.children.length) {
          body.appendChild(vEl("div", "coin-name", "多周期状态"));
          body.appendChild(tfBox);
        }

        const sup = (d.support_zones || []).map((z) => fmt.format(z.lo) + " - " + fmt.format(z.hi));
        const res = (d.resistance_zones || []).map((z) => fmt.format(z.lo) + " - " + fmt.format(z.hi));
        if (sup.length || res.length) {
          body.appendChild(vEl("div", "coin-name", "支撑 / 阻力"));
          body.appendChild(vEl("div", "v-note", "支撑:" + (sup.join("、") || "无") + "  ·  阻力:" + (res.join("、") || "无")));
        }

        body.appendChild(vEl("div", "coin-name", "判断理由"));
        const ulReason = vEl("ul", "v-note");
        ulReason.style.paddingLeft = "18px";
        for (const item of (d.reasons && d.reasons.length ? d.reasons : ["无"])) ulReason.appendChild(vEl("li", null, item));
        body.appendChild(ulReason);
        body.appendChild(vEl("div", "coin-name", "风险提示"));
        const ulRisk = vEl("ul", "v-note");
        ulRisk.style.paddingLeft = "18px";
        for (const item of (d.risks && d.risks.length ? d.risks : ["无"])) ulRisk.appendChild(vEl("li", null, item));
        body.appendChild(ulRisk);
        body.appendChild(vEl("div", "coin-name", "失效条件"));
        const ulInv = vEl("ul", "v-note");
        ulInv.style.paddingLeft = "18px";
        for (const item of (d.invalidation && d.invalidation.length ? d.invalidation : ["无"])) ulInv.appendChild(vEl("li", null, item));
        body.appendChild(ulInv);

        body.appendChild(vEl("div", "coin-name", "真实后续结果"));
        body.appendChild(vTable(["周期", "未来价格", "收益", "结果", "裁决", "MFE", "MAE"], d.horizons.map((h) => [
          HZ_ZH[h.horizon] || h.horizon,
          h.resolved ? fmt.format(h.price) : "等待验证",
          h.resolved ? vPct(h.ret_pct) : "--",
          h.resolved ? (OUT_ZH[h.outcome] || h.outcome) : "--",
          h.resolved ? (VERDICT_ZH[h.verdict] || "--") : "--",
          h.resolved ? vPct(h.mfe) : "--",
          h.resolved ? vPct(h.mae) : "--"
        ])));
        body.appendChild(vEl("div", "v-note", "结果只使用信号时点之后已收盘的真实K线;涨跌幅小于 ATR 动态噪声阈值时判为中性(震荡),MFE/MAE 以信号方向为准。"));
        $("vDetail").classList.add("open");
      }

      function closeDetail() {
        $("vDetail").classList.remove("open");
      }

      function openValidation() {
        if (!QE) {
          $("vStatus").textContent = "历史验证引擎未加载,请刷新页面重试。";
          return;
        }
        setActivePage("validation");
        buildChips();
        renderValidation();
        void refreshValidation({ force: false });
      }

      function closeValidation() {
        setActivePage("settings");
        closeDetail();
      }

      // ---- 回测页 ----
      const btState = { symbol: "BTCUSDT", interval: "1h", bars: 600, horizon: "1h", running: false, view: null, note: "", failed: false };

      function btRangeText() {
        const ivMs = (QE.INTERVAL_MS && QE.INTERVAL_MS[btState.interval]) || 3600000;
        const days = (btState.bars * ivMs) / 86400000;
        return "约 " + (days >= 1 ? days.toFixed(days >= 10 ? 0 : 1) + " 天" : (btState.bars * ivMs / 3600000).toFixed(0) + " 小时") + "(最多 " + btState.bars + " 根 " + btState.interval + " K线)";
      }

      function btSetProgress(label, done, total) {
        $("btProgressBox").classList.add("on");
        const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
        $("btProgressBar").style.width = pct + "%";
        $("btStage").textContent = label + (total ? " · 已处理 " + done + " / " + total : "") + (total ? "(" + pct + "%)" : "");
      }

      function initBacktestForm() {
        const ivSel = $("btInterval");
        for (const iv of QE.BACKTEST_INTERVALS) {
          const opt = document.createElement("option");
          opt.value = iv;
          opt.textContent = iv;
          if (iv === btState.interval) opt.selected = true;
          ivSel.appendChild(opt);
        }
        const barSel = $("btBars");
        for (const b of QE.BACKTEST_BARS) {
          const opt = document.createElement("option");
          opt.value = String(b);
          opt.textContent = b + " 根";
          if (b === btState.bars) opt.selected = true;
          barSel.appendChild(opt);
        }
        const hzBox = $("btHorizons");
        for (const h of QE.HORIZONS) {
          const btn = vEl("button", "chip" + (h === btState.horizon ? " active" : ""), HZ_ZH[h] || h);
          btn.type = "button";
          btn.addEventListener("click", () => {
            btState.horizon = h;
            hzBox.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === btn));
            if (btState.view) renderBacktestResults(btState.view, btState.note);
          });
          hzBox.appendChild(btn);
        }
        $("btSymbol").addEventListener("change", (event) => {
          let s = String(event.target.value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
          if (s && !s.endsWith("USDT")) s += "USDT";
          btState.symbol = s || "BTCUSDT";
          event.target.value = btState.symbol;
        });
        $("btInterval").addEventListener("change", (event) => {
          btState.interval = event.target.value;
          $("btRangeHint").textContent = btRangeText();
        });
        $("btBars").addEventListener("change", (event) => {
          btState.bars = Number(event.target.value) || 600;
          $("btRangeHint").textContent = btRangeText();
        });
        $("btRunBtn").addEventListener("click", () => {
          if (!btState.running) void runBacktest();
        });
        $("btRangeHint").textContent = btRangeText();
      }

      async function fetchKlinesForBacktest(symbol, interval, limit) {
        const req = RM.begin("backtest");
        const raw = await api("klines?market=futures&symbol=" + symbol + "&interval=" + interval + "&limit=" + limit, 2, 9000, req.signal);
        return QE.normalizeKlines(raw, interval);
      }

      async function runBacktest() {
        if (btState.running) return;
        btState.running = true;
        btState.view = null;
        btState.failed = false;
        $("btRunBtn").disabled = true;
        $("btSummary").replaceChildren();
        $("btCalib").replaceChildren();
        $("btRegime").replaceChildren();
        $("btNote").textContent = "回测进行中...";
        btSetProgress("准备中", 0, 0);
        try {
          const store = await historyStore();
          const result = await QE.runBacktestSession({
            store,
            symbol: btState.symbol,
            interval: btState.interval,
            bars: btState.bars,
            horizon: btState.horizon,
            fetchKlines: fetchKlinesForBacktest,
            onStage: (info) => {
              const labels = { fetch: "获取历史K线", replay: "重放历史时间", signals: "生成 Signals", outcomes: "解析 Outcomes", stats: "计算统计", done: "完成" };
              btSetProgress((labels[info.stage] || info.stage) + (info.detail ? "(" + info.detail + ")" : ""), info.done || 0, info.total || 0);
            },
            onProgress: async (info) => {
              btSetProgress("重放历史时间", info.scanned || 0, info.total || 0);
              vstate.dirty = true;
              await delay(0);
            }
          });
          btState.view = result.ok ? result.view : null;
          btState.note = result.message || result.note || "";
          btState.failed = !result.ok;
          $("btNote").textContent = result.ok
            ? "本次回测完成:重放 " + result.scanned + " 个时点,生成 " + result.signals + " 条信号,其中 " + result.resolved + " 条已解析结果。" + (result.note ? " " + result.note : "") + (result.failures && result.failures.length ? "(部分周期取数失败:" + result.failures.length + " 项)" : "")
            : result.message;
          if (result.ok) renderBacktestResults(result.view, result.note);
          await loadRecords();
          updateBadge();
          await renderRuns();
          btSetProgress(result.ok ? "完成" : "已停止", 1, 1);
        } catch (error) {
          btState.failed = true;
          $("btNote").textContent = "回测失败:" + (error && error.message ? error.message : "未知错误");
          btSetProgress("失败", 0, 0);
        } finally {
          btState.running = false;
          $("btRunBtn").disabled = false;
        }
      }

      function renderBacktestResults(view, note) {
        const ov = view.overall;
        const box = $("btSummary");
        box.replaceChildren();
        box.appendChild(vMetric("总信号", String(view.total)));
        box.appendChild(vMetric("已验证(" + (HZ_ZH[view.horizon] || view.horizon) + ")", String(view.resolved)));
        box.appendChild(vMetric("方向准确率", vRatio(ov.accuracy), ov.accuracy == null ? null : ov.accuracy >= 50 ? "green" : "red"));
        box.appendChild(vMetric("中性比例", vRatio(ov.neutral_rate)));
        box.appendChild(vMetric("看涨准确率(" + ov.bull_samples + ")", vRatio(ov.bull_accuracy)));
        box.appendChild(vMetric("看跌准确率(" + ov.bear_samples + ")", vRatio(ov.bear_accuracy)));
        box.appendChild(vMetric("平均方向收益", vPct(ov.avg_return)));
        box.appendChild(vMetric("中位方向收益", vPct(ov.median_return)));
        box.appendChild(vMetric("平均 MFE", vPct(ov.avg_mfe)));
        box.appendChild(vMetric("平均 MAE", vPct(ov.avg_mae)));
        const noteParts = [
          "判定 " + ov.correct + " 正确 / " + ov.wrong + " 错误 / " + ov.neutral + " 中性(噪声区内不计入方向准确率)",
          sampleNote(view.quality, view.resolved),
          "以上为信号方向评估,不是策略收益,未计入手续费/滑点/资金费率",
          note || ""
        ].filter(Boolean);
        $("btSummaryNote").textContent = noteParts.join(" · ");

        const calib = $("btCalib");
        calib.replaceChildren();
        if (!view.by_confidence.length) {
          calib.appendChild(vEl("div", "v-note", "样本不足,无法生成校准表"));
        } else {
          const gapByKey = new Map(view.calibration.map((c) => [c.bucket, c.gap]));
          calib.appendChild(vTable(["置信度桶", "样本", "实际正确率", "准确率-置信度", "平均收益", "平均MFE", "平均MAE"], view.by_confidence.map((b) => [
            b.key + (b.predicted_confidence != null ? " (均值 " + Math.round(b.predicted_confidence) + ")" : ""),
            String(b.samples),
            vRatio(b.accuracy),
            gapByKey.get(b.key) == null ? "--" : (gapByKey.get(b.key) > 0 ? "+" : "") + gapByKey.get(b.key).toFixed(1),
            vPct(b.avg_return),
            vPct(b.avg_mfe),
            vPct(b.avg_mae)
          ])));
        }

        const reg = $("btRegime");
        reg.replaceChildren();
        if (!view.by_regime.length) {
          reg.appendChild(vEl("div", "v-note", "样本不足"));
        } else {
          reg.appendChild(vTable(["市场环境", "样本", "已验证", "方向准确率", "平均方向收益", "平均MFE", "平均MAE"], view.by_regime.map((r) => [
            r.key,
            String(r.samples),
            String(r.resolved),
            vRatio(r.accuracy),
            vPct(r.avg_return),
            vPct(r.avg_mfe),
            vPct(r.avg_mae)
          ])));
        }
      }

      async function renderRuns() {
        const box = $("btRuns");
        box.replaceChildren();
        let runs = [];
        try {
          const store = await historyStore();
          runs = await QE.recentBacktestRuns(store, 8);
        } catch (error) {
          runs = [];
        }
        if (!runs.length) {
          box.appendChild(vEl("div", "v-note", "暂无回测记录"));
          return;
        }
        const STATUS_ZH = { completed: "已完成", insufficient: "数据不足", running: "运行中", failed: "失败" };
        box.appendChild(vTable(["回测", "时间", "状态", "信号", "已验证"], runs.map((r) => [
          r.name || r.id,
          vTime(r.started_at),
          STATUS_ZH[r.status] || r.status,
          String(r.total_signals == null ? "--" : r.total_signals),
          String(r.resolved_signals == null ? "--" : r.resolved_signals)
        ])));
      }

      function openBacktest() {
        if (!QE) {
          $("btNote").textContent = "回测引擎未加载,请刷新页面重试。";
          return;
        }
        setActivePage("backtest");
        initBacktestForm();
        void renderRuns();
      }

      function closeBacktest() {
        setActivePage("settings");
      }

      // ---- Walk Forward 页 ----
      const wfState = { symbol: "BTCUSDT", interval: "1h", bars: 1000, horizon: "1h", trainDays: 30, testDays: 7, running: false };

      function wfRangeText() {
        const ivMs = (QE.INTERVAL_MS && QE.INTERVAL_MS[wfState.interval]) || 3600000;
        const days = (wfState.bars * ivMs) / 86400000;
        return "约 " + days.toFixed(days >= 10 ? 0 : 1) + " 天(最多 " + wfState.bars + " 根 " + wfState.interval + " K线)";
      }

      function wfSetProgress(label, done, total) {
        $("wfProgressBox").classList.add("on");
        const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
        $("wfBar").style.width = pct + "%";
        $("wfStage").textContent = label + (total ? " · 已处理 " + done + " / " + total + "(" + pct + "%)" : "");
      }

      function initWalkforwardForm() {
        const ivSel = $("wfInterval");
        for (const iv of QE.BACKTEST_INTERVALS) {
          const opt = document.createElement("option");
          opt.value = iv;
          opt.textContent = iv;
          if (iv === wfState.interval) opt.selected = true;
          ivSel.appendChild(opt);
        }
        const barSel = $("wfBars");
        for (const b of QE.BACKTEST_BARS) {
          const opt = document.createElement("option");
          opt.value = String(b);
          opt.textContent = b + " 根";
          if (b === wfState.bars) opt.selected = true;
          barSel.appendChild(opt);
        }
        const hzBox = $("wfHorizons");
        for (const h of QE.HORIZONS) {
          const btn = vEl("button", "chip" + (h === wfState.horizon ? " active" : ""), HZ_ZH[h] || h);
          btn.type = "button";
          btn.addEventListener("click", () => {
            wfState.horizon = h;
            hzBox.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === btn));
          });
          hzBox.appendChild(btn);
        }
        $("wfSymbol").addEventListener("change", (event) => {
          let s = String(event.target.value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
          if (s && !s.endsWith("USDT")) s += "USDT";
          wfState.symbol = s || "BTCUSDT";
          event.target.value = wfState.symbol;
        });
        $("wfInterval").addEventListener("change", (event) => {
          wfState.interval = event.target.value;
          $("wfRangeHint").textContent = wfRangeText();
        });
        $("wfBars").addEventListener("change", (event) => {
          wfState.bars = Number(event.target.value) || 1000;
          $("wfRangeHint").textContent = wfRangeText();
        });
        $("wfTrain").addEventListener("change", (event) => { wfState.trainDays = Number(event.target.value) || 30; });
        $("wfTest").addEventListener("change", (event) => { wfState.testDays = Number(event.target.value) || 7; });
        $("wfRunBtn").addEventListener("click", () => { if (!wfState.running) void runWalkforward(); });
        $("wfRangeHint").textContent = wfRangeText();
      }

      async function runWalkforward() {
        if (wfState.running) return;
        wfState.running = true;
        $("wfRunBtn").disabled = true;
        $("wfSummary").replaceChildren();
        $("wfFolds").replaceChildren();
        $("wfNote").textContent = "滚动验证运行中...";
        wfSetProgress("准备中", 0, 0);
        try {
          const store = await historyStore();
          const result = await QE.runWalkForwardSession({
            store,
            symbol: wfState.symbol,
            interval: wfState.interval,
            bars: wfState.bars,
            horizon: wfState.horizon,
            trainMs: wfState.trainDays * 86400000,
            testMs: wfState.testDays * 86400000,
            fetchKlines: fetchKlinesForBacktest,
            onStage: (info) => {
              const labels = { fetch: "获取历史K线", replay: "重放历史时间", outcomes: "解析 Outcomes", folds: "评估各折(样本外)", done: "完成" };
              wfSetProgress((labels[info.stage] || info.stage) + (info.detail ? "(" + info.detail + ")" : ""), info.done || 0, info.total || 0);
            },
            onProgress: async (info) => {
              wfSetProgress("重放历史时间", info.scanned || 0, info.total || 0);
              await delay(0);
            }
          });
          if (!result.ok) {
            $("wfNote").textContent = result.message || "验证未完成";
            wfSetProgress("已停止", 0, 0);
          } else {
            $("wfNote").textContent = "验证完成:" + result.folds.length + " 折,全区间重放 " + result.signals + " 个时点,样本外共 " + result.summary.pooled_resolved + " 条已解析。"
              + (result.problems.length ? " 窗口校验异常:" + result.problems.join("; ") : " 窗口校验通过(无重叠泄漏)。");
            renderWalkforward(result);
            wfSetProgress("完成", 1, 1);
          }
          await loadRecords();
          updateBadge();
          await renderWfRuns();
        } catch (error) {
          $("wfNote").textContent = "验证失败:" + (error && error.message ? error.message : "未知错误");
          wfSetProgress("失败", 0, 0);
        } finally {
          wfState.running = false;
          $("wfRunBtn").disabled = false;
        }
      }

      function renderWalkforward(result) {
        const s = result.summary;
        const box = $("wfSummary");
        box.replaceChildren();
        box.appendChild(vMetric("Fold 数", String(s.folds)));
        box.appendChild(vMetric("样本外已验证", String(s.pooled_resolved)));
        box.appendChild(vMetric("池化 Accuracy", vRatio(s.pooled_accuracy)));
        box.appendChild(vMetric("各折平均 Accuracy", vRatio(s.avg_accuracy)));
        box.appendChild(vMetric("Train 选参后 Accuracy", vRatio(s.avg_selected_accuracy)));
        box.appendChild(vMetric("平均方向收益", vPct(s.avg_return)));
        box.appendChild(vMetric("平均 MFE", vPct(s.avg_mfe)));
        box.appendChild(vMetric("平均 MAE", vPct(s.avg_mae)));
        const parts = [
          s.insufficient ? "样本不足,结果暂不可参考" : "以上均为样本外(Test 窗口)结果,Train 仅用于选参",
          s.best_regime ? "最好环境:" + s.best_regime.key + "(" + vRatio(s.best_regime.accuracy) + " / " + s.best_regime.resolved + ")" : "最好环境:样本不足",
          s.worst_regime ? "最差环境:" + s.worst_regime.key + "(" + vRatio(s.worst_regime.accuracy) + " / " + s.worst_regime.resolved + ")" : "最差环境:样本不足"
        ];
        $("wfSummaryNote").textContent = parts.join(" · ");

        const box2 = $("wfFolds");
        box2.replaceChildren();
        if (!result.folds.length) {
          box2.appendChild(vEl("div", "v-note", "Fold 数为 0:历史跨度不足以形成至少一个完整 Train+Test 窗口。"));
          return;
        }
        box2.appendChild(vTable(
          ["折", "Test 时间", "Train样本", "Test样本", "已验证", "Accuracy", "Train阈值", "选参后Acc", "平均收益", "MFE", "MAE", "质量"],
          result.folds.map((f) => [
            "#" + f.fold_id,
            vTime(f.test_start) + " → " + vTime(f.test_end),
            String(f.train_sample_count),
            String(f.test_sample_count),
            String(f.test_resolved),
            vRatio(f.directional_accuracy),
            f.selected_min_confidence == null ? "--" : "≥" + f.selected_min_confidence,
            vRatio(f.test_selected_accuracy) + (f.test_selected_samples ? "(" + f.test_selected_samples + ")" : ""),
            vPct(f.avg_return),
            vPct(f.avg_mfe),
            vPct(f.avg_mae),
            f.quality === "insufficient" ? "样本不足" : f.quality === "low" ? "偏少" : "可用"
          ])
        ));
      }

      async function renderWfRuns() {
        const box = $("wfRuns");
        box.replaceChildren();
        let runs = [];
        try {
          const store = await historyStore();
          runs = await store.generic.all("walkforward_runs", 100);
        } catch (error) {
          runs = [];
        }
        runs.sort((a, b) => Number(b.started_at) - Number(a.started_at));
        runs = runs.slice(0, 8);
        if (!runs.length) {
          box.appendChild(vEl("div", "v-note", "暂无验证记录"));
          return;
        }
        const STATUS_ZH = { completed: "已完成", completed_insufficient: "样本不足", insufficient: "数据不足" };
        box.appendChild(vTable(["回测", "时间", "折数", "信号", "状态", "最好/最差环境"], runs.map((r) => [
          r.symbol + " " + r.interval + " x" + r.bars,
          vTime(r.started_at),
          String(r.folds),
          String(r.total_signals == null ? "--" : r.total_signals),
          STATUS_ZH[r.status] || r.status,
          (r.best_regime || "--") + " / " + (r.worst_regime || "--")
        ])));
      }

      function openWalkforward() {
        if (!QE) {
          $("wfNote").textContent = "回测引擎未加载,请刷新页面重试。";
          return;
        }
        setActivePage("walkforward");
        initWalkforwardForm();
        void renderWfRuns();
      }

      function closeWalkforward() {
        setActivePage("settings");
      }

      // ---- 数据导出页 ----
      const dsState = { source: "live", symbol: "", fromMs: null, toMs: null, onlyResolvedFor: "all", dataset: null };

      function initDatasetForm() {
        const srcBox = $("dsSources");
        if (!srcBox.children.length) {
          for (const item of QE.SOURCE_FILTERS) {
            const btn = vEl("button", "chip" + (item.key === dsState.source ? " active" : ""), item.label);
            btn.type = "button";
            btn.addEventListener("click", () => {
              dsState.source = item.key;
              srcBox.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === btn));
              dsState.dataset = null;
              $("dsPreviewNote").textContent = "筛选条件已变化,请重新预览或导出。";
            });
            srcBox.appendChild(btn);
          }
        }
        const sel = $("dsResolved");
        if (sel.children.length <= 1) {
          for (const h of QE.HORIZONS) {
            const opt = document.createElement("option");
            opt.value = h;
            opt.textContent = (HZ_ZH[h] || h) + " 已解析";
            sel.appendChild(opt);
          }
        }
        $("dsSymbol").addEventListener("change", (event) => {
          dsState.symbol = String(event.target.value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
          event.target.value = dsState.symbol;
          dsState.dataset = null;
        });
        $("dsFrom").addEventListener("change", (event) => {
          dsState.fromMs = event.target.value ? Date.parse(event.target.value + "T00:00:00") : null;
          dsState.dataset = null;
        });
        $("dsTo").addEventListener("change", (event) => {
          dsState.toMs = event.target.value ? Date.parse(event.target.value + "T23:59:59") : null;
          dsState.dataset = null;
        });
        $("dsResolved").addEventListener("change", (event) => {
          dsState.onlyResolvedFor = event.target.value;
          dsState.dataset = null;
        });
        $("dsPreviewBtn").addEventListener("click", () => { void previewDataset(); });
        $("dsCsvBtn").addEventListener("click", () => { void exportDataset("csv"); });
        $("dsJsonBtn").addEventListener("click", () => { void exportDataset("json"); });
      }

      // 导出前重新从本地库读取,保证导出内容与库中数据一致
      async function buildCurrentDataset() {
        await loadRecords();
        updateBadge();
        const ds = QE.buildDataset(vstate.records, {
          source: dsState.source,
          symbol: dsState.symbol || null,
          fromMs: dsState.fromMs,
          toMs: dsState.toMs,
          onlyResolvedFor: dsState.onlyResolvedFor
        });
        dsState.dataset = ds;
        return ds;
      }

      async function previewDataset() {
        try {
          renderDatasetPreview(await buildCurrentDataset());
        } catch (error) {
          $("dsPreviewNote").textContent = "读取失败:" + (error && error.message ? error.message : "未知错误");
        }
      }

      async function exportDataset(format) {
        try {
          $("dsPreviewNote").textContent = "正在整理数据集...";
          const ds = await buildCurrentDataset();
          renderDatasetPreview(ds);
          if (!ds.rows.length) return;
          const text = format === "csv" ? QE.datasetToCsv(ds) : QE.datasetToJson(ds);
          downloadText(text, QE.datasetFileName("quant-dataset", format, { source: dsState.source, symbol: dsState.symbol }), format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8");
        } catch (error) {
          $("dsPreviewNote").textContent = "导出失败:" + (error && error.message ? error.message : "未知错误");
        }
      }

      function renderDatasetPreview(ds) {
        $("dsPreviewNote").textContent = "共 " + ds.meta.rows + " 行(其中已解析 " + ds.meta.labeled_rows + " 行,待验证 " + ds.meta.pending_rows + " 行)· " + ds.columns.length + " 列 · 来源 " + ds.meta.source
          + (ds.meta.symbol ? " · 币种 " + ds.meta.symbol : "") + " · 引擎 " + (ds.meta.engine_version || "--") + " / " + (ds.meta.feature_version || "--");
        const box = $("dsTable");
        box.replaceChildren();
        if (!ds.rows.length) {
          box.appendChild(vEl("div", "v-note", "没有符合条件的样本。"));
          return;
        }
        const cols = ["signal_id", "timestamp_iso", "symbol", "source", "direction", "confidence", "h1h_return", "h1h_outcome", "h1h_mfe", "h1h_mae"];
        const present = cols.filter((c) => ds.columns.includes(c));
        box.appendChild(vTable(["字段"].concat(present), [
          ["样本值"]
        ]));
        // 表头 + 前 5 行(转置显示更容易在手机上阅读)
        box.replaceChildren(vTable(
          present.map((c) => c.replace("signal_id", "ID").replace("timestamp_iso", "时间")),
          ds.rows.slice(0, 5).map((row) => present.map((c) => {
            const v = row[c];
            if (v == null) return "(空)";
            if (c.endsWith("_return") || c.endsWith("_mfe") || c.endsWith("_mae")) return vPct(v);
            return String(v);
          }))
        ));
      }

      function downloadText(text, filename, mime) {
        try {
          const blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 5000);
          $("dsPreviewNote").textContent += " · 已导出 " + filename;
        } catch (error) {
          $("dsPreviewNote").textContent = "导出失败:" + (error && error.message ? error.message : "未知错误");
        }
      }

      function openDataset() {
        if (!QE) {
          $("dsPreviewNote").textContent = "导出模块未加载,请刷新页面重试。";
          return;
        }
        setActivePage("dataset");
        initDatasetForm();
        void (async () => {
          try {
            await loadRecords();
            updateBadge();
            const liveCount = QE.filterBySource(vstate.records, "live").length;
            const btCount = QE.filterBySource(vstate.records, "backtest").length;
            $("dsPreviewNote").textContent = "本地已有 " + vstate.records.length + " 条样本(实时 " + liveCount + " / 回测 " + btCount + "),点「预览」或直接导出。";
          } catch (error) {
            $("dsPreviewNote").textContent = "本地数据读取失败:" + (error && error.message ? error.message : "未知错误");
          }
        })();
      }

      function closeDataset() {
        setActivePage("settings");
      }

      // ---- 机器学习验证页(只读训练结果报告,不改写任何 Signal) ----
      const mlState = { report: null, horizon: null, model: "lightgbm", ready: false };
      const ML_MODEL_ZH = { rule: "规则引擎", logreg: "Logistic Regression", lightgbm: "LightGBM", xgboost: "XGBoost" };

      async function loadMlReport() {
        try {
          const store = await historyStore();
          const saved = await store.meta("ml_report");
          if (saved && saved.horizons) {
            mlState.report = saved;
            mlState.horizon = mlState.horizon && saved.horizons[mlState.horizon] ? mlState.horizon : Object.keys(saved.horizons)[0];
          }
        } catch (error) {
          mlState.report = null;
        }
        return mlState.report;
      }

      async function saveMlReport(report) {
        const store = await historyStore();
        await store.meta("ml_report", report);
      }

      function mlPct(v, digits) {
        return v == null || !isFinite(v) ? "--" : (Number(v) * 100).toFixed(digits == null ? 1 : digits) + "%";
      }

      function initMlChips() {
        const hzBox = $("mlHorizons");
        const mBox = $("mlModels");
        if (hzBox.children.length) return;
        const horizons = mlState.report ? Object.keys(mlState.report.horizons) : QE.HORIZONS;
        for (const h of horizons) {
          const btn = vEl("button", "chip" + (h === mlState.horizon ? " active" : ""), HZ_ZH[h] || h);
          btn.type = "button";
          btn.addEventListener("click", () => {
            mlState.horizon = h;
            hzBox.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === btn));
            renderMl();
          });
          hzBox.appendChild(btn);
        }
        for (const m of Object.keys(ML_MODEL_ZH)) {
          const btn = vEl("button", "chip" + (m === mlState.model ? " active" : ""), ML_MODEL_ZH[m]);
          btn.type = "button";
          btn.addEventListener("click", () => {
            mlState.model = m;
            mBox.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === btn));
            renderMl();
          });
          mBox.appendChild(btn);
        }
      }

      function renderMl() {
        const rep = mlState.report;
        if (!rep) {
          $("mlStatus").textContent = "尚未导入模型结果报告。离线训练完成后导入 build/ml/results/report.json。";
          for (const id of ["mlSamples", "mlCompare", "mlOverfit", "mlCalib", "mlFolds", "mlImportance", "mlRegime"]) $(id).replaceChildren();
          $("mlSamplesNote").textContent = "";
          return;
        }
        const horizon = mlState.horizon || Object.keys(rep.horizons)[0];
        const block = rep.horizons[horizon];
        const gate = rep.config && rep.config.min_samples_required;
        $("mlStatus").textContent = "报告时间 " + (rep.generated_at || "--").slice(0, 19).replace("T", " ")
          + " · 数据集 " + (rep.dataset.file || "--") + "( " + rep.dataset.rows + " 行" + (rep.dataset.kind === "synthetic_fixture" ? " · 合成夹具" : " · App 导出") + ")"
          + " · 切分 " + (rep.config.split || "--") + (rep.config.random_split ? " · ⚠随机切分" : " · 无随机切分")
          + (gate ? " · 正式比较门槛 " + gate + " 条" : "");

        const sampleBox = $("mlSamples");
        sampleBox.replaceChildren(vTable(["项目", "值"], [
          ["已标注样本(该周期)", String(block.samples.labeled)],
          ["Pending 已排除", String(block.samples.pending_excluded)],
          ["重复样本已去重", String(block.samples.duplicate_removed)],
          ["标签异常剔除", String(block.samples.invalid_label_rows)],
          ["类别分布", Object.entries(block.samples.class_counts).map(([k, v]) => k + " " + v).join(" / ")],
          ["来源", (block.samples.sources || []).join(", ") || "--"],
          ["币种", (block.samples.symbols || []).join(", ") || "--"],
          ["可用 Fold", String(block.folds.length) + " / " + String(block.folds_planned)],
          ["是否可用于正式比较", block.samples.eligible_for_comparison ? "是" : "否(样本不足)"]
        ]));
        $("mlSamplesNote").textContent = block.samples.sample_note + (block.samples.eligible_for_comparison ? "" : " · 样本不足时结论不可参考");

        const cmp = $("mlCompare");
        cmp.replaceChildren();
        const order = ["rule", ...(rep.config.models || []).filter((m) => m !== "rule")];
        const rows = [];
        for (const m of order) {
          const s = block.summary[m];
          if (!s || s.accuracy == null) continue;
          rows.push([
            ML_MODEL_ZH[m] || m,
            String(s.samples),
            mlPct(s.accuracy),
            mlPct(s.balanced_accuracy),
            s.macro_f1 == null ? "--" : s.macro_f1.toFixed(3),
            s.per_class && s.per_class.bullish ? mlPct(s.per_class.bullish.recall) : "--",
            s.per_class && s.per_class.bearish ? mlPct(s.per_class.bearish.recall) : "--",
            vPct(s.avg_directional_return),
            vPct(s.directional_mfe),
            vPct(s.directional_mae),
            s.avg_confidence == null ? "--" : (s.avg_confidence * 100).toFixed(1) + "%"
          ]);
        }
        cmp.appendChild(vTable(["模型", "样本", "Accuracy", "Balanced Acc", "Macro F1", "看涨 Recall", "看跌 Recall", "方向收益", "方向MFE", "方向MAE", "平均置信"], rows));

        const of = $("mlOverfit");
        of.replaceChildren();
        const ofRows = [];
        for (const [m, o] of Object.entries(block.overfit_check || {})) {
          ofRows.push([ML_MODEL_ZH[m] || m, mlPct(o.avg_train_accuracy), mlPct(o.avg_test_accuracy), (o.gap * 100).toFixed(1) + "%", o.risk ? "存在过拟合风险" : "可接受"]);
        }
        of.appendChild(ofRows.length ? vTable(["模型", "Train", "Test", "差距", "判定"], ofRows) : vEl("div", "v-note", "暂无数据"));

        const cal = $("mlCalib");
        cal.replaceChildren();
        const calRows = [];
        for (const [m, c] of Object.entries(block.calibration_compare || {})) {
          calRows.push([ML_MODEL_ZH[m] || m, c.raw_brier.toFixed(4), c.calibrated_brier.toFixed(4), c.improved ? "校准后更好(可采用)" : "校准未改善(不应采用)"]);
        }
        cal.appendChild(calRows.length ? vTable(["模型", "Raw Brier", "Calibrated Brier", "结论"], calRows) : vEl("div", "v-note", "暂无校准数据"));

        const foldsBox = $("mlFolds");
        foldsBox.replaceChildren();
        if (!block.folds.length) {
          foldsBox.appendChild(vEl("div", "v-note", "没有可用 Fold(样本或时间跨度不足)"));
        } else {
          const models = (rep.config.models || []).filter((m) => m !== "rule");
          const header = ["折", "Test 时间", "Train样本", "Test样本", "Rule Acc"].concat(models.map((m) => ML_MODEL_ZH[m] + " Acc"));
          foldsBox.appendChild(vTable(header, block.folds.map((f) => {
            const base = ["#" + f.fold_id, vTime(f.test_start) + " → " + vTime(f.test_end), String(f.train_samples), String(f.test_samples), mlPct(f.models.rule && f.models.rule.accuracy)];
            return base.concat(models.map((m) => mlPct(f.models[m] && f.models[m].accuracy)));
          })));
        }

        const impBox = $("mlImportance");
        impBox.replaceChildren();
        const imp = (block.feature_importance || {})[mlState.model] || (block.feature_importance || {}).lightgbm || [];
        const perm = (block.permutation_importance || {})[mlState.model] || (block.permutation_importance || {}).lightgbm || [];
        if (!imp.length) {
          impBox.appendChild(vEl("div", "v-note", mlState.model === "rule" || mlState.model === "logreg" ? "该模型暂无重要性数据(树模型才有 Gain 重要性)" : "暂无数据"));
        } else {
          impBox.appendChild(vTable([ML_MODEL_ZH[mlState.model] + " 特征(Gain)", "重要性"], imp.slice(0, 10).map(([k, v]) => [k, Number(v).toFixed(2)])));
        }
        if (perm.length) {
          impBox.appendChild(vEl("div", "v-note", "特征重要性(在 Test 上诊断,不参与训练):" + perm.slice(0, 5).map(([k, v]) => k + " " + Number(v).toFixed(4)).join(" · ")));
        }

        const regBox = $("mlRegime");
        regBox.replaceChildren();
        const byRegime = (block.by_regime || {})[mlState.model];
        if (!byRegime || !byRegime.length) {
          regBox.appendChild(vEl("div", "v-note", "暂无分组数据"));
        } else {
          regBox.appendChild(vTable(["市场环境", "样本", "Accuracy", "Balanced Acc", "Macro F1", "方向收益"], byRegime.map((r) => [
            r.key,
            String(r.samples),
            mlPct(r.accuracy),
            mlPct(r.balanced_accuracy),
            r.macro_f1 == null ? "--" : r.macro_f1.toFixed(3),
            vPct(r.avg_directional_return)
          ])));
        }
        $("mlBadge").textContent = rep.dataset.rows + " 行";
      }

      function openMl() {
        if (!QE) return;
        setActivePage("ml");
        void (async () => {
          await loadMlReport();
          initMlChips();
          renderMl();
        })();
      }

      function closeMl() {
        setActivePage("settings");
      }

      // ---- 行情健康检查页 ----
      const HEALTH_CLASS = { OK: "green", Slow: "gray", Unavailable: "red", Unknown: "gray" };
      const HEALTH_ZH = { OK: "正常", Slow: "偏慢", Unavailable: "熔断/不可用", Unknown: "未知" };
      const NET_MODE_ZH = { direct: "直连", proxy: "代理", broken: "代理不可用(broken)" };
      const PROXY_METHOD_ZH = { "native-env": "Node 原生 env proxy", "undici-proxy-agent": "undici ProxyAgent", "proxy-agent": "内置 CONNECT 隧道兜底", unsupported: "当前 Node 不支持(未安装兜底)", direct: "未配置代理" };

      async function loadHealth(probe) {
        const path = "health" + (probe ? "?probe=1" : "");
        const req = RM.begin("health");
        return api(path, 1, probe ? 12000 : 5000, req.signal);
      }

      function renderHealth(data) {
        const providers = (data && data.providers) || [];
        const mode = (data && data.net_mode) || "direct";
        const method = (data && data.proxy_method) || "direct";
        $("healthStatus").textContent = "更新时间 " + new Date((data && data.generated_at) || Date.now()).toLocaleTimeString("zh-CN")
          + (data && data.probed ? " · 已实际探测" : " · 基于最近请求")
          + " · 网络: " + (NET_MODE_ZH[mode] || mode) + " / " + (PROXY_METHOD_ZH[method] || method)
          + (data && data.node_version ? " · Node " + data.node_version : "")
          + (data && data.proxy_configured ? " · 已配置代理" : " · 未配置代理")
          + (data && data.native_env_proxy_supported === false && data.proxy_configured ? "(原生 env proxy 不支持,已用兜底)" : "");
        const box = $("healthTable");
        box.replaceChildren();
        if (!providers.length) {
          box.appendChild(vEl("div", "v-note", "暂无数据(先做一次分析或点「立即探测」)"));
          $("healthBadge").textContent = "--";
        } else {
          box.appendChild(vTable(["上游", "状态", "最近耗时", "成功/调用", "最近错误"], providers.map((p) => [
            p.provider,
            HEALTH_ZH[p.state] || p.state,
            p.last_ms == null ? "--" : p.last_ms + "ms",
            (p.oks || 0) + "/" + (p.calls || 0),
            p.last_error ? String(p.last_error).slice(0, 40) : "--"
          ])));
          const bad = providers.filter((p) => p.state === "Unavailable").length;
          const ok = providers.filter((p) => p.state === "OK").length;
          $("healthBadge").textContent = bad ? bad + " 个异常" : ok + " 个正常";
        }
        const diag = (window.__quantDiag || []).slice(-10).reverse();
        const dbox = $("healthDiag");
        dbox.replaceChildren();
        if (!diag.length) {
          dbox.appendChild(vEl("div", "v-note", "本次会话暂无失败记录"));
        } else {
          dbox.appendChild(vTable(["时间", "环节", "状态", "原因"], diag.map((d) => [
            new Date(d.at).toLocaleTimeString("zh-CN"),
            d.tag,
            d.status == null ? "--" : String(d.status),
            String(d.message || "").slice(0, 60)
          ])));
        }
      }

      async function selfTestMarket() {
        const out = $("healthSelfResult");
        out.textContent = "测试中...";
        const results = [];
        const t0 = Date.now();
        for (const [label, path, ms] of [["K线(1h)", "klines?market=futures&symbol=" + state.symbol + "&interval=1h&limit=120", 9000], ["全市场行情", "tickers?market=futures", 9000], ["分析", "analyze?symbol=" + state.symbol + "&interval=1h", 15000]]) {
          const t = Date.now();
          try {
            await api(path, 1, ms);
            results.push(label + " 成功 " + (Date.now() - t) + "ms");
          } catch (error) {
            results.push(label + " 失败 " + (Date.now() - t) + "ms(" + shortError(error) + ")");
          }
        }
        out.textContent = results.join(" · ") + " · 合计 " + ((Date.now() - t0) / 1000).toFixed(1) + "s";
      }

      function openHealth() {
        setActivePage("health");
        // V16.2s:健康检查要走多个上游,先切页绘制,再开始探测
        afterPaint(() => {
          void (async () => {
            try {
              renderHealth(await loadHealth(false));
            } catch (error) {
              $("healthStatus").textContent = "健康检查读取失败:" + shortError(error);
            }
          })();
        });
      }

      function closeHealth() {
        setActivePage("settings");
      }

      function bindMlImport() {        $("openMl").addEventListener("click", openMl);
        $("mlBackBtn").addEventListener("click", () => { void goBack(); });
        $("mlReloadBtn").addEventListener("click", () => { void (async () => { await loadMlReport(); initMlChips(); renderMl(); })(); });
        $("mlClearBtn").addEventListener("click", () => {
          void (async () => {
            try {
              const store = await historyStore();
              await store.meta("ml_report", null);
            } catch (error) { /* ignore */ }
            mlState.report = null;
            $("mlHorizons").replaceChildren();
            $("mlModels").replaceChildren();
            $("mlBadge").textContent = "--";
            renderMl();
          })();
        });
        $("mlFile").addEventListener("change", (event) => {
          const file = event.target.files && event.target.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            try {
              const parsed = JSON.parse(String(reader.result));
              if (!parsed.horizons) throw new Error("缺少 horizons 字段");
              mlState.report = parsed;
              mlState.horizon = Object.keys(parsed.horizons)[0];
              void (async () => {
                await saveMlReport(parsed);
                $("mlHorizons").replaceChildren();
                $("mlModels").replaceChildren();
                initMlChips();
                renderMl();
              })();
            } catch (error) {
              $("mlStatus").textContent = "导入失败:" + (error && error.message ? error.message : "JSON 解析错误");
            }
          };
          reader.readAsText(file);
        });
        // ---- V14.3:模型工件导入 + Champion 原子热替换 ----
        const artifactInput = $("mlArtifactFile");
        artifactInput.addEventListener("change", (event) => {
          const file = event.target.files && event.target.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            try {
              const parsed = JSON.parse(String(reader.result));
              // artifacts.json 形如 { "logreg|1h|0": {...工件...} };也接受单个工件对象
              const list = Array.isArray(parsed) ? parsed : parsed.artifacts ? Object.values(parsed.artifacts) : Object.values(parsed);
              const candidates = list.filter((a) => a && typeof a === "object" && a.format);
              const logreg = candidates.filter((a) => a.format === "logreg-json");
              if (!candidates.length) throw new Error("未找到可推理的模型工件(format 字段缺失)");
              if (!logreg.length) throw new Error("未找到 logreg-json 工件(当前运行时只支持 LogisticRegression 系数推理)");
              mlUiState.pending = logreg[logreg.length - 1];
              $("mlRuntimeStatus").textContent = "已选择工件:" + (mlUiState.pending.model_version || "--")
                + " · 特征 " + (mlUiState.pending.encoder && mlUiState.pending.encoder.columns ? mlUiState.pending.encoder.columns.length : 0)
                + " 个 · 点「设为正式模型(原子替换)」启用(旧模型在替换成功前继续工作)";
            } catch (error) {
              $("mlRuntimeStatus").textContent = "工件导入失败:" + (error && error.message ? error.message : "JSON 解析错误");
            }
          };
          reader.readAsText(file);
        });
        $("mlArtifactPromote").addEventListener("click", () => {
          void (async () => {
            const artifact = mlUiState.pending;
            if (!artifact) { $("mlRuntimeStatus").textContent = "请先选择 artifacts.json"; return; }
            const validation = QE.validateArtifact(artifact);
            if (!validation.ok) {
              $("mlRuntimeStatus").textContent = "工件不可推理(" + validation.reason + "),已保留旧模型,未做任何替换";
              return;
            }
            const version = artifact.model_version || "ml-" + Date.now();
            const store = await historyStore();
            const adapter = mlStoreAdapter(store);
            // 1) 先落库工件 2) 注册模型 3) 原子替换运行时
            await QE.saveArtifact(adapter, artifact, { model_type: artifact.model_name || "logreg", version, horizon: artifact.horizon });
            await QE.registerModel(adapter, {
              model_type: artifact.model_name || "logreg", version, status: "CHAMPION",
              feature_version: artifact.encoder ? "snapshot-" + artifact.encoder.columns.length : null,
              engine_version: QE.ENGINE_VERSION, horizons: artifact.horizon ? [artifact.horizon] : [],
              validation_samples: artifact.encoder ? artifact.encoder.fit_rows : 0,
              metrics: { format: artifact.format, features: artifact.encoder ? artifact.encoder.columns.length : 0 },
              note: "前端导入并晋升为正式模型"
            });
            const res = mlRuntime.load({ artifact, version, model_type: artifact.model_name || "logreg", horizon: artifact.horizon });
            mlUiState.lastSwap = res;
            mlUiState.lastReason = res.ok ? "ok" : res.reason;
            mlUiState.version = mlRuntime.currentVersion();
            mlUiState.source = mlRuntime.hasModel() ? "ml:" + mlRuntime.currentVersion() : QE.ML_FALLBACK_SOURCE;
            mlUiState.pending = null;
            renderMlRuntimeStatus();
            $("mlRuntimeStatus").textContent = res.ok
              ? "已原子替换为 " + version + "(推理自检通过,无需重启;原模型 " + (res.from || "无") + " 已下线)"
              : "替换失败(" + res.reason + "),继续使用旧模型 " + (res.kept || "无");
          })();
        });
        $("mlArtifactReload").addEventListener("click", () => {
          void (async () => {
            const res = await refreshChampion(true);
            $("mlRuntimeStatus").textContent = res.ok
              ? "已从本地注册表重新加载正式模型 " + (res.version || res.to || "--")
              : "未加载到可用正式模型(" + res.reason + "),当前使用 " + QE.ML_FALLBACK_SOURCE + " 回退";
          })();
        });
        $("mlArtifactTest").addEventListener("click", () => {
          const st = mlRuntime.status();
          if (!st.loaded) {
            const fb = QE.fallbackPrediction({ rule_score: 0.4, bull_score: 0.6, bear_score: 0.2, risk_score: 30 });
            $("mlRuntimeStatus").textContent = "无正式模型:回退推理自检通过 → " + fb.label + " (p_bull " + fb.bullish.toFixed(3) + " / p_bear " + fb.bearish.toFixed(3) + ")";
            return;
          }
          const probe = mlRuntime.predict(QE.runtimeRowFromAnalysis({ symbol: state.symbol, interval: state.detailInterval, features: { rsi14: 55, atr_pct: 1.2, adx: 22 }, market_regime: { label: "Range", trend_market: false, vol_state: "Normal" } }, {}));
          $("mlRuntimeStatus").textContent = probe.ok
            ? "正式模型推理自检通过:" + probe.label + " · 置信 " + probe.confidence + " · 模型 " + probe.model_version
            : "正式模型推理失败(" + probe.reason + ")→ 决策会自动回退 " + QE.ML_FALLBACK_SOURCE;
        });
      }

      // 刷新:先用本地数据渲染(秒出),再后台补到期结果,完成后自动再渲染一次
      async function refreshValidation(options) {
        const opts = options || {};
        try {
          await loadRecords();
          updateBadge();
          renderValidation();
          if (vstate.records.length) $("vStatus").textContent += "(正在后台更新到期结果...)";
          if (vstate.resolving) return;
          void resolveThenRerender(opts.force !== false);
        } catch (error) {
          $("vStatus").textContent = "历史数据读取失败:" + (error && error.message ? error.message : "未知错误");
        }
      }

      async function resolveThenRerender(force) {
        const report = await runResolve({ force });
        try {
          await loadRecords();
          updateBadge();
          renderValidation();
          if (report && report.errors && report.errors.length && !report.resolved) {
            $("vStatus").textContent += "(到期结果暂未更新:行情读取失败,稍后自动重试)";
          }
        } catch (error) {
          // 后台更新失败不影响已渲染内容
        }
      }

      async function initHistory() {
        $("openValidation").addEventListener("click", openValidation);
        $("openBacktest").addEventListener("click", openBacktest);
        $("openWalkforward").addEventListener("click", openWalkforward);
        $("openDataset").addEventListener("click", openDataset);
        $("vBackBtn").addEventListener("click", () => { void goBack(); });
        $("btBackBtn").addEventListener("click", () => { void goBack(); });
        $("wfBackBtn").addEventListener("click", () => { void goBack(); });
        $("dsBackBtn").addEventListener("click", () => { void goBack(); });
        bindMlImport();
        $("openHealth").addEventListener("click", openHealth);
        $("healthBackBtn").addEventListener("click", () => { void goBack(); });
        $("healthProbeBtn").addEventListener("click", () => {
          void (async () => {
            $("healthStatus").textContent = "正在探测各上游...";
            try {
              renderHealth(await loadHealth(true));
            } catch (error) {
              $("healthStatus").textContent = "探测失败:" + shortError(error);
            }
          })();
        });
        $("healthSelfTest").addEventListener("click", () => { void selfTestMarket(); });
        $("vRefreshBtn").addEventListener("click", () => { void refreshValidation({ force: true }); });
        $("vDetailClose").addEventListener("click", closeDetail);
        $("vDetail").addEventListener("click", (event) => {
          if (event.target === $("vDetail")) closeDetail();
        });
        $("vMoreBtn").addEventListener("click", () => {
          vstate.shown += 50;
          renderValidation();
        });
        try {
          await historyStore();
          $("vStatus").textContent = "正在读取本地历史数据...";
          await loadRecords();
          updateBadge();
          $("vStatus").textContent = vstate.records.length
            ? "已保存 " + vstate.records.length + " 条真实样本"
            : "暂无历史样本。完成真实市场分析后,这里会开始积累验证数据。";
          scheduleResolve(4000);
          setInterval(() => {
            if (!document.hidden) scheduleResolve(1000);
          }, 300000);
          document.addEventListener("visibilitychange", () => {
            if (!document.hidden) scheduleResolve(800);
          });
        } catch (error) {
          $("vStatus").textContent = "本地历史存储不可用:" + (error && error.message ? error.message : "未知错误");
          $("validationBadge").textContent = "不可用";
        }
      }


      // ================= V14.1 移动端接入(复用现有 Paper 后台,不重写业务逻辑) =================
      const RM = QE.createRequestManager();
      const viewState = {
        detailSymbol: state.symbol,
        detailInterval: state.interval,
        marketScroll: 0,
        // V16.2s:市场页分段状态(市场/自选)——进详情再返回仍在原段;两段滚动位置各自保存
        mkSeg: "market",
        mkScroll: { market: 0, watch: 0 },
        // V16.2s:详情K线缓存(缓存命中 → 打开详情先画旧图,再异步取新数据);上限 12 条
        klinesCache: new Map(),
        detailLoadingAt: 0,
        lastTickers: null,
        // V14.4:外部情报 / 预测 / 利润保护 / 回撤 的最近一次快照(供详情页与 AI Chat 复用)
        lastOi: {},
        lastExternal: null,
        lastExternalBySymbol: {},
        lastPrediction: null,
        lastPredictionBySymbol: {},
        lastPositionRaw: null,
        lastDrawdown: null,
        lastNewsItems: null,
        lastNewsReason: null,
        lastResearch: null,
        lastResearchAt: 0,
        lastRegime: null,
        lastAnalysesBySymbol: {},
        resolvedPredictions: 0,
        lastAnalysis: null,
        lastKlines: null,
        lastDetail: null,
        // 开发用性能浮层:最近一次"行情 / 风控 / 策略"tick 时间(默认不显示,零成本)
        devMarketTick: 0,
        devRiskTick: 0,
        devStrategyTick: 0
      };
      const MARKET_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "TRXUSDT"];
      // §5/§6:两种运行模式的主 Decision Candle(V14.5:双姿势各自跑)
      const MODE_INTERVAL = { short: "1h", long: "4h" };
      const BG_DATA_INTERVAL_MS = 120000;   // 外部情报后台刷新节奏(TTL 兜底,避免轰炸上游)
      const RESEARCH_INTERVAL_MS = 600000;  // 研究 Agent 巡检节奏(真正联网只由触发条件决定)
      let paperApi = null;
      let paperLoopTimer = null;
      let homeTimer = null;
      let retentionTimer = null;
      let riskTimer = null;
      let dtPollTimer = null;   // V18:详情页降级轮询(单例;只有推送不可用时才真正发请求)
      let dtSecTimer = null;    // V18:Current Candle 收盘倒计时(每秒)
      let fabIdleTimer = 0;     // V19:AI FAB 避让 —— 滚动时淡出,停下 600ms 恢复
      let taskBag = null;
      let currentPage = "home";

      // ---- 页面 → 请求键:离开页面时真正取消该视图在途请求(Paper 引擎与历史补齐不受影响) ----
      const PAGE_REQUEST_KEYS = {
        home: ["home"],
        market: ["market", "watch"],
        paper: ["paper"],
        detail: ["detail", "chat", "detail-live"],
        monitor: ["monitor"],
        scan: ["scan"],
        watch: ["watch"],
        settings: ["health"],
        ml: ["ml"],
        health: ["health"],
        validation: ["history"],
        backtest: ["backtest"],
        walkforward: ["walkforward"],
        dataset: ["history"]
      };
      // 后台任务的请求键:切页不取消(引擎/回测/外部数据/研究属于系统自己的长期任务 §74)
      const BACKGROUND_KEYS = ["paper", "history", "backtest", "walkforward", "bgdata", "research", "learning", "sync"];

      function cancelPageRequests(pageName) {
        const keys = PAGE_REQUEST_KEYS[pageName] || [];
        for (const key of keys) {
          if (BACKGROUND_KEYS.includes(key)) continue;
          RM.leave(key);
        }
      }

      // ================= V14.3 ML Runtime(真实推理 + Champion 原子热替换) =================
      const mlRuntime = QE.createMlRuntime();
      const mlUiState = { source: QE.ML_FALLBACK_SOURCE, version: null, lastSwap: null, lastReason: "no_champion", inferenceCount: 0, fallbackCount: 0 };

      function mlStoreAdapter(store) {
        return { get: (t, k) => store.generic.get(t, k), all: (t, l) => store.generic.all(t, l), put: (t, r) => store.generic.put(t, r), del: (t, k) => store.generic.del(t, k) };
      }

      // 加载 Champion:注册表 → 工件 → 校验推理可用 → 原子替换;失败保留旧模型(无需重启)
      async function refreshChampion(force) {
        try {
          const store = await historyStore();
          const adapter = mlStoreAdapter(store);
          const champ = await QE.getChampion(adapter);
          if (!champ) {
            mlUiState.source = QE.ML_FALLBACK_SOURCE;
            mlUiState.version = null;
            mlUiState.lastReason = "no_champion";
            renderMlRuntimeStatus();
            return { ok: false, reason: "no_champion", swapped: false };
          }
          if (!force && mlRuntime.hasModel() && mlRuntime.currentVersion() === champ.version) {
            return { ok: true, reason: "already_loaded", swapped: false, version: champ.version };
          }
          const res = await QE.loadChampionIntoRuntime(mlRuntime, adapter, { champion: champ });
          mlUiState.lastSwap = res;
          mlUiState.lastReason = res.reason || (res.ok ? "ok" : "load_failed");
          mlUiState.version = mlRuntime.currentVersion();
          mlUiState.source = mlRuntime.hasModel() ? "ml:" + mlRuntime.currentVersion() : QE.ML_FALLBACK_SOURCE;
          diagLog("ml", new Error("正式模型装载:" + mlUiState.lastReason + " to=" + (res.to || "none")));
          renderMlRuntimeStatus();
          return res;
        } catch (error) {
          mlUiState.source = QE.ML_FALLBACK_SOURCE;
          mlUiState.lastReason = "load_error";
          renderMlRuntimeStatus();
          return { ok: false, reason: "load_error", detail: String(error && error.message).slice(0, 120) };
        }
      }

      // 统一推理出口:能推理就用模型系数,否则回退 Rule+Bull/Bear+Risk —— 永远不是 null
      function inferMl(analysis, risk, evidence) {
        const resolved = QE.resolveMl(mlRuntime, {
          analysis,
          rule_score: QE.ruleScore(analysis),
          evidence,
          risk
        });
        mlUiState.source = resolved.source;
        if (resolved.fallback) mlUiState.fallbackCount += 1;
        else mlUiState.inferenceCount += 1;
        return resolved;
      }

      function resolveDetailMl(analysis, risk, evidence) { return inferMl(analysis, risk, evidence); }
      function paperMl(analysis, risk, evidence) { return inferMl(analysis, risk, evidence); }

      function renderMlRuntimeStatus() {
        const statusEl = $("mlRuntimeStatus");
        if (!statusEl) return;
        const st = mlRuntime.status();
        const hasModel = st.loaded;
        statusEl.textContent = hasModel
          ? "推理可用:直接读取正式模型系数(softmax(X·coef+intercept)),无需重启即可替换。"
          : "当前没有可用正式模型工件 → 决策使用 " + QE.ML_FALLBACK_SOURCE + " 回退(" + (st.last_error ? st.last_error.reason : mlUiState.lastReason) + ")。导入 artifacts.json 后可即时启用。";
        $("mlRuntimeSource").textContent = mlUiState.source;
        $("mlRuntimeVersion").textContent = st.version || "--";
        $("mlRuntimeSwaps").textContent = String(st.swaps) + "(成功 " + mlRuntime.swapLog().filter((s) => s.ok).length + ")";
      }

      // 资金费:从真实 tickers/专用接口喂入;拿不到就标 unavailable(不随机生成)
      function observeFundingFromTickers(eng, tickers) {
        if (!eng || !Array.isArray(tickers)) return 0;
        let observed = 0;
        for (const t of tickers) {
          if (!t || !t.symbol) continue;
          if (t.fundingRate == null && t.lastFundingRate == null) continue;
          if (eng.observeFunding(t.symbol, t, {}).ok) observed += 1;
        }
        return observed;
      }

      // 主动拉取资金费:成功 → 真实费率;失败 → 明确 unavailable
      async function refreshFunding(symbol) {
        const eng = await getPaperEngine();
        const req = RM.begin("paper");
        try {
          const raw = await api("funding?market=futures&symbol=" + symbol, 1, 8000, req.signal);
          const res = eng.observeFunding(symbol, raw, { provider: raw && raw.provider });
          if (!res.ok) eng.markFundingUnavailable(symbol, "invalid_payload");
          return res;
        } catch (error) {
          if (isAborted(error)) return { ok: false, reason: "aborted" };
          eng.markFundingUnavailable(symbol, shortError(error));
          return { ok: false, reason: "unavailable", detail: shortError(error) };
        }
      }

      // ---- Paper Engine:同一页面生命周期只允许一个实例 ----
      // V14.4:回撤控制器与引擎共享时钟,只在这一处创建(单实例不变式)
      const drawdownCtl = QE.createDrawdownController({ now: () => Date.now() });

      function paperStoreAdapter(store) {
        return {
          get: (table, key) => store.generic.get(table, key),
          all: (table) => store.generic.all(table),
          put: (table, row) => store.generic.put(table, row),
          del: (table, key) => store.generic.del(table, key)
        };
      }

      // ---- V15 P0:原生后台运行时活跃时,UI 只是 Viewer/Controller ----
      // 说明:运行时由前台服务承载(见 PaperForegroundService + runtime-host.js)。
      // 此时 UI **绝不创建第二个 Engine**(需求硬性要求),而是:
      //   读 → 从共享的 IndexedDB(同源)读取账户/持仓/成交/通知
      //   写 → 通过命令邮箱(IndexedDB 表 runtime_commands)交给运行时执行
      function nativeRuntimeActive() {
        try {
          const n = window.QuantNative;
          return Boolean(n && typeof n.isRuntimeRunning === "function" && n.isRuntimeRunning());
        } catch (error) { return false; }
      }

      let nativeViewer = null;
      let nativeCache = { account: null, wallets: {}, positions: [], orders: [], trades: [], notifications: [], engine_state: null, loaded_at: 0 };
      let viewerReadSeq = 0;   // V16.1-RV §20:只读缓存也做代数守卫 —— 旧的一次读取晚回来不许覆盖新的
      async function refreshNativeViewerCache() {
        const mySeq = ++viewerReadSeq;
        const store = await historyStore();
        const readAll = async (table) => (store.generic && store.generic.all ? await store.generic.all(table) : []);
        const [accounts, wallets, positions, orders, trades, notifications, states] = await Promise.all([
          readAll("paper_account"), readAll("paper_wallets"), readAll("paper_positions"), readAll("paper_orders"),
          readAll("paper_trades"), readAll("paper_notifications"), readAll("paper_engine_state")
        ]);
        // V19:双池与分层资金必须是真数据 —— 后台运行时模式下也要把持久化的钱包读出来
        const walletMap = {};
        for (const w of wallets || []) if (w && w.mode) walletMap[w.mode] = w;
        if (mySeq !== viewerReadSeq) return nativeCache;   // 已有更新的读取在进行/完成:丢弃本次(禁止旧数据回写)
        nativeCache = {
          account: accounts[0] || null,
          wallets: walletMap,
          positions: positions || [],
          orders: orders || [],
          trades: trades || [],
          notifications: (notifications || []).sort((a, b) => QE.num(b.at, 0) - QE.num(a.at, 0)),
          engine_state: (states || [])[0] || null,
          loaded_at: Date.now()
        };
        return nativeCache;
      }
      async function getNativeViewer() {
        if (!nativeViewer) {
          nativeViewer = {
            __native_viewer: true,   // 明确标记:这不是引擎实例(后台运行时才是)
            // 读:同步读缓存(页面渲染大量使用同步取值);缓存由 8 秒渲染轮次刷新
            getState: () => "RUNNING",
            getAccount: () => nativeCache.account || {},
            getPositions: () => nativeCache.positions,
            getOrders: () => nativeCache.orders,
            getTrades: () => nativeCache.trades,
            getNotifications: (o) => {
              const items = nativeCache.notifications;
              return { items: o && o.unreadOnly ? items.filter((n) => !n.read) : items.slice(0, (o && o.limit) || 50), unread: items.filter((n) => !n.read).length, total: items.length };
            },
            snapshot: () => {
              const open = nativeCache.positions.filter((p) => p.status === "OPEN");
              return {
                state: "RUNNING",
                account: nativeCache.account || {},
                wallets: nativeCache.wallets || {},
                positions: open,
                today: QE.summarizeTrades(nativeCache.trades.filter((t) => QE.dayKeyOf(t.exit_time) === QE.dayKeyOf(Date.now()))),
                all_time: QE.summarizeTrades(nativeCache.trades),
                open_count: open.length,
                drawdown_pct: QE.num(nativeCache.account && nativeCache.account.max_drawdown_pct, 0),
                native_background: true
              };
            },
            // V19:分层资金(可交易 / 已占用 / 保护池)—— 只用持久化账本 + 引擎同款公式计算,不创建第二个引擎
            poolLayers: () => QE.poolLayers({
              equity: QE.num(nativeCache.account && nativeCache.account.total_equity, 0),
              reserved_margin: QE.num(nativeCache.account && nativeCache.account.reserved_balance, 0),
              unrealized_pnl: QE.num(nativeCache.account && nativeCache.account.unrealized_pnl, 0),
              cash_balance: QE.num(nativeCache.account && nativeCache.account.cash_balance, 0),
              pool: { protected_balance: QE.num(nativeCache.engine_state && nativeCache.engine_state.profit_pool && nativeCache.engine_state.profit_pool.protected_balance, 0) }
            }),
            // V16.1-RV §23:高水位只从持久化的风险状态读 —— UI 不自己重算 Peak
            hwm: () => {
              const s = (nativeCache.engine_state && nativeCache.engine_state.hwm) || {};
              const peak = QE.num(s.peak_equity, 0);
              const st = s.state || "NORMAL";
              const eq = QE.num(nativeCache.account && nativeCache.account.total_equity, 0);
              const dd = peak > 0 ? Math.max(0, (peak - eq) / peak * 100) : 0;
              return {
                state: st,
                state_zh: QE.HWM_STATE_ZH[st] || st,
                peak_equity: peak,
                peak_at: QE.num(s.peak_at, 0) || null,
                drawdown_pct: Math.round(dd * 100) / 100
              };
            },
            // V16.1-RV §22:保护池与引擎同口径(金额 + 拆分/已结算计数)
            protectedPool: () => {
              const p = (nativeCache.engine_state && nativeCache.engine_state.profit_pool) || {};
              return {
                protected_balance: QE.num(p.protected_balance, 0),
                tradable_credit_total: QE.num(p.tradable_credit_total, 0),
                protected_total: QE.num(p.protected_total, 0),
                splits: (p.records || []).length,
                settled: (p.settled_ids || []).length
              };
            },
            refresh: refreshNativeViewerCache,
            // 写:全部走命令邮箱,由后台运行时执行(UI 不直接改账本)
            sendCommand: async (type, payload) => {
              const store = await historyStore();
              const record = {
                command_id: "cmd_" + Date.now().toString(36) + "_" + (window.__quantCmdSeq = (window.__quantCmdSeq || 0) + 1),
                type: String(type).toUpperCase(),
                payload: JSON.stringify(payload || {}),
                status: "PENDING",
                created_at: Date.now(),
                source: "ui"
              };
              await store.generic.put("runtime_commands", record);
              return { ok: true, queued: true, command_id: record.command_id, native_background: true };
            },
            manualClose: (input) => nativeViewer.sendCommand("MANUAL_CLOSE", input),
            emergencyCloseAll: () => nativeViewer.sendCommand("EMERGENCY_CLOSE", {}),
            pauseEntries: () => nativeViewer.sendCommand("PAUSE_ENTRIES", {}),
            resumeEntries: () => nativeViewer.sendCommand("RESUME_ENTRIES", {}),
            adjustStop: (input) => nativeViewer.sendCommand("ADJUST_STOP", input),
            adjustTakeProfit: (input) => nativeViewer.sendCommand("ADJUST_TP", input),
            pause: () => nativeViewer.sendCommand("PAUSE", {}),
            resume: () => nativeViewer.sendCommand("RESUME", {}),
            getIntegrity: () => { try { return JSON.parse(window.QuantNative.runtimeStatus() || "{}"); } catch (error) { return {}; } },
            accountIntegrity: () => ({ ok: true, violations: [] }),
            currentRisk: () => ({ risk_level: "后台", allow_new_entry: true, vet_reasons: [], veto_reasons: [] }),
            dataQuality: () => ({ ok: true, recent_issues: [] }),
            dataQualitySummary: () => "由后台运行时监控",
            positionOverview: () => ({ open_count: 0, closed_count: 0, invalid_count: 0, clean: true }),
            journal: () => [],
            journalWhy: () => "决策日志由后台运行时写入",
            notificationDigest: () => ({ total: nativeCache.notifications.length, unread: nativeCache.notifications.filter((n) => !n.read).length, by_kind: {} }),
            getFundingSnapshot: () => ({ status: "unavailable" }),
            reviewStats: () => ({ calls: 0, used: 0, fallbacks: 0 }),
            attributionView: () => QE.attributionView(QE.attributionOf(nativeCache.trades), { limit: 4 }),
            attribution: () => QE.attributionOf(nativeCache.trades),
            async init() { return { created: false, native_viewer: true }; }
          };
        }
        await refreshNativeViewerCache();
        return nativeViewer;
      }

      async function getPaperEngine() {
        // 后台运行时已在跑 → 只读 Viewer + 命令邮箱(不创建引擎,避免第二个实例)
        if (nativeRuntimeActive()) return getNativeViewer();
        if (!paperApi) {
          paperApi = (async () => {
            const store = await historyStore();
            const eng = QE.createPaperEngine({
              store: paperStoreAdapter(store),
              now: () => Date.now(),
              deviceId: "web-" + (localStorage.getItem("deviceId") || (() => { const id = "dev" + Math.random().toString(36).slice(2, 8); localStorage.setItem("deviceId", id); return id; })()),
              riskCheck: (ctx) => QE.evaluateRisk({ ...ctx, now: Date.now(), mode: ctx.mode, todayStart: new Date().toISOString().slice(0, 10) }),
              fetchKlines: async (symbol, interval, limit) => QE.normalizeKlines(await api("klines?market=futures&symbol=" + symbol + "&interval=" + interval + "&limit=" + limit, 1, 8000), interval),
              // V14.4:开启利润保护与回撤控制(未注入时行为与 V14.3 完全一致)
              profitLock: { persistShadow: true },
              drawdown: drawdownCtl,
              // V14.5:DeepSeek 关键点复核(无 Key/失败 → 引擎自动回退本地)+ 低频分配再平衡
              reviewProvider: deepseekReviewProvider,
              // V15:通知统一出口 —— 引擎内的每个重要事件都会经过这里(去重后)推给 UI 与系统通知
              onNotify: (item) => { nativeNotify(item); },
              allocation: true,
              deepseekMinConfidence: 70,
              deepseekMinLeverage: 4,
              deepseekSkipRisk: 70,
              allocationIntervalMs: 6 * 3600000
            });
            await eng.init();
            // 单一实例不变量:整个页面生命周期只创建一个引擎(导航压力测试会校验恒为 1)
            window.__quantEngineInstances = (window.__quantEngineInstances || 0) + 1;
            return eng;
          })();
        }
        return paperApi;
      }

      function engineStateText(s) {
        return QE.homeViewModel({ snapshot: { state: s } }).state_label;
      }

      async function renderHome() {
        const eng = await getPaperEngine();
        const snapshot = eng.snapshot();
        let learning = { note: "系统正在积累数据" };
        try {
          const store = await historyStore();
          const champ = await QE.getChampion(paperStoreAdapter(store));
          const evals = await store.generic.all("model_evaluations", 20);
          learning = QE.learningViewModel({ champion: champ ? champ.version : null, drift: (evals || []).find((e) => e.drift_detected) ? { drift_detected: true } : null });
        } catch (error) { /* 学习信息缺失不影响首页 */ }
        const risk = viewState.lastDetail ? { risk_level: viewState.lastDetail.risk_level_raw, risk_score: viewState.lastDetail.risk_score } : {};
        const vm = QE.homeViewModel({ snapshot, learning, risk, todayTrades: eng.getTrades().filter((t) => QE.dayKeyOf(t.exit_time) === QE.dayKeyOf(Date.now())) });
        // V16.1-RV §19/§21:首页与模拟/内核共用同一资金口径,并登记进一致性对比
        const cap = capitalNow(eng, snapshot);
        recordCapital("home", cap);
        const setText = (id, value, cls) => { const el = $(id); if (!el) return; el.textContent = value; if (cls !== undefined) el.className = cls; };
        setText("hmTodayPnl", vm.today_pnl_text, "big " + (vm.today_pnl > 0 ? "green" : vm.today_pnl < 0 ? "red" : ""));
        setText("hmEquity", cap.has_data ? cap.total_equity.toFixed(2) + " USDT" : vm.total_equity_text);
        setText("hmAllTime", vm.all_time_text);
        setText("hmShortEq", vm.short_equity.toFixed(2), "v");
        setText("hmShortToday", "今日 " + vm.short_today_text, "muted");
        setText("hmLongEq", vm.long_equity.toFixed(2), "v");
        setText("hmLongToday", "今日 " + vm.long_today_text, "muted");
        // §70:分配必须读真实钱包(不写死 HTML)
        setText("hmAllocation", vm.allocation_text, "muted");
        setText("hmPositions", vm.open_positions + " 个");
        setText("hmTrades", vm.today_trades + " 次");
        setText("hmRisk", vm.risk_level + (vm.risk_score == null ? "" : " " + vm.risk_score));
        setText("hmState", vm.state_label);
        setText("hmLearning", vm.learning_status);
        const startBtn = $("hmStartBtn");
        const pauseBtn = $("hmPauseBtn");
        if (startBtn) startBtn.disabled = vm.running || snapshot.state === "STARTING" || snapshot.state === "RECOVERING";
        if (pauseBtn) pauseBtn.disabled = !vm.running;
        if (startBtn) startBtn.textContent = snapshot.state === "PAUSED" ? "继续模拟" : "开始模拟";
        return vm;
      }

      // V19 模拟页统计:上半 = 2 列指标卡(净收益·手续费 / 胜率·Profit Factor / 最大回撤·平均持仓 / 交易次数·Fee Drag),
      // 下半 = "详细统计 · 技术信息"默认折叠(净值窗口 / 清洗口径说明 / 归因 / 原始事件数)。
      // 口径:指标卡 = CLEAN 完整仓位(posStats);最大回撤 = 净值序列(equityStats);Fee Drag = 手续费/毛利润(与 overtrading 一致)。
      async function renderPaperStats(eng) {
        const box = $("pfStatsBox");
        const metricsBox = $("pfMetrics");
        if (!box) return;
        const trades = eng.getTrades();
        const account = eng.getAccount();
        const initial = Number(account.initial_balance || 100);
        const curve = (eng.engine && Array.isArray(eng.engine.equityCurve) && eng.engine.equityCurve.length >= 2)
          ? eng.engine.equityCurve
          : [{ at: Date.now() - 86400000, equity: initial }, { at: Date.now(), equity: Number(account.total_equity || initial) }];
        const stats = QE.equityStats({
          equity_curve: curve,
          trades,
          now: Date.now(),
          equity: Number(account.total_equity || initial),
          initial_equity: initial
        });
        // V15 P0 §13/§14:统计以【完整 Position】为主口径(部分平仓是仓位事件,不是独立母交易)
        const posStats = QE.summarizePositions(trades);
        const head = QE.equityHeadline(stats);
        if (metricsBox) {
          metricsBox.replaceChildren();
          // Fee Drag 与 overtrading / tradeAnalysis 同口径:手续费 ÷ 毛利润(只累计正毛利)
          const grossProfit = (posStats.rows || []).reduce((a, r) => a + (QE.num(r.gross_pnl, 0) > 0 ? QE.num(r.gross_pnl, 0) : 0), 0);
          const feeDrag = grossProfit > 0 ? posStats.fees / grossProfit * 100 : null;
          const money = (v, signed) => { const n = QE.num(v, 0); return (signed && n > 0 ? "+" : "") + n.toFixed(QE.usdtDigits(n)) + " USDT"; };
          const metric = (label, value, cls) => {
            const cell = vEl("div", "pf-metric");
            cell.appendChild(vEl("span", "k", label));
            cell.appendChild(vEl("b", cls || null, value));
            return cell;
          };
          metricsBox.appendChild(metric("净收益", money(posStats.net_pnl, true), QE.pnlClass(posStats.net_pnl)));
          metricsBox.appendChild(metric("手续费", money(posStats.fees, false)));
          metricsBox.appendChild(metric("胜率", posStats.win_rate == null ? "--" : Number(posStats.win_rate).toFixed(0) + "%"));
          // 无完整仓位时 profit_factor==1 是"空集合默认值",不能当成绩展示
          metricsBox.appendChild(metric("Profit Factor", !posStats.positions || posStats.profit_factor == null ? "--" : Number(posStats.profit_factor).toFixed(2)));
          metricsBox.appendChild(metric("最大回撤", Number(stats.max_drawdown_pct || 0).toFixed(2) + "%"));
          metricsBox.appendChild(metric("平均持仓", posStats.avg_holding_ms == null ? "--" : QE.fmtHold(posStats.avg_holding_ms)));
          metricsBox.appendChild(metric("交易次数", String(posStats.positions || 0) + " 次"));
          metricsBox.appendChild(metric("Fee Drag", feeDrag == null ? "--" : Number(feeDrag).toFixed(1) + "%"));
        }
        box.replaceChildren();
        const row = vEl("div", "hm-row");
        row.appendChild(vEl("span", "k", head.headline));
        row.appendChild(vEl("span", "v " + (head.tone === "up" ? "green" : "red"), head.sub));
        box.appendChild(row);
        const grid = vEl("div", "close-preview");
        const cell = (k, v, cls) => { const c = vEl("div"); c.appendChild(vEl("span", "muted", k)); c.appendChild(vEl("b", cls || null, v)); return c; };
        for (const key of ["h24", "d7", "d30"]) {
          const w = stats.windows[key];
          grid.appendChild(cell(w.label + " 净值", (Number(w.net_return_pct) >= 0 ? "+" : "") + Number(w.net_return_pct).toFixed(2) + "%", Number(w.net_return_pct) >= 0 ? "green" : "red"));
        }
        grid.appendChild(cell("强平次数", String(stats.liquidations || 0)));
        grid.appendChild(cell("完整仓位", String(posStats.positions || 0)));
        grid.appendChild(cell("成交事件", String(posStats.events || 0)));
        if (Number(posStats.excluded_events || 0) > 0) grid.appendChild(cell("已排除异常事件", String(posStats.excluded_events)));
        box.appendChild(grid);
        // V15.1 §2/§3/§4:CLEAN 与 RAW 必须说清楚,避免用户以为账户又算错
        box.appendChild(vEl("div", "v-note", "清洗后策略统计:胜率/盈亏比/归因均按【完整仓位】并排除不可学习异常样本(" + Number(posStats.excluded_events || 0) + " 条)。"));
        box.appendChild(vEl("div", "v-note", "账户余额包含历史修复前的 Paper 成交(raw ledger,永不改写);策略统计已排除不可学习异常样本 —— 两者数字不同属正常。"));
        box.appendChild(vEl("div", "v-note", "原始事件 " + Number(posStats.raw_events || 0) + " 条 → 清洗后 " + Number(posStats.events || 0) + " 条 · 完整仓位 " + Number(posStats.positions || 0) + " 个"));
        box.appendChild(vEl("div", "v-note", "回撤修复:" + (stats.recovery_ongoing ? "进行中" : (stats.recovery_ms == null ? "无回撤记录" : "已完成")) + " · 口径来自本地账本(不走联网)"));
        // V15 Performance Attribution:到底是什么在赚钱/亏钱(策略/币种/Regime/杠杆/模型/退出策略)
        const attr = eng.attributionView({ limit: 4 });
        const attrBox = vEl("div", null);
        attrBox.appendChild(vEl("div", "v-note", attr.headline + " · " + attr.sample_text));
        for (const sec of attr.sections) {
          const line = vEl("div", "hm-row");
          line.appendChild(vEl("span", "k", sec.label));
          line.appendChild(vEl("span", "v", sec.rows.map((r) => r.key + " " + r.net_text + "(" + r.trades + "笔/" + r.win_rate_text + ")").join(" · ")));
          attrBox.appendChild(line);
        }
        box.appendChild(attrBox);
      }

      async function renderPaperPage() {
        const eng = await getPaperEngine();
        const snapshot = eng.snapshot();
        const allTrades = eng.getTrades();
        const now = Date.now();
        const vm = QE.paperViewModel({ wallets: snapshot.wallets, account: snapshot.account, positions: snapshot.positions, trades: allTrades, now, limit: Math.max(20, allTrades.length) });
        // V17:成交 → 原始记录映射(复盘按 symbol 定位都要用真实字段,不用视图层近似)
        const tradeById = new Map();
        for (const t of allTrades) if (t && t.trade_id) tradeById.set(t.trade_id, t);
        // ---- 主资产卡:总资产最大 → 今日/累计 → 次级小字(可交易/已占用/保护池;V16.1-RV §19 唯一资金口径) ----
        const cap = capitalNow(eng, snapshot);
        recordCapital("paper", cap);
        $("pfEquity").textContent = cap.has_data ? cap.total_equity.toFixed(2) + " USDT" : vm.total_equity_text;
        $("pfToday").textContent = vm.today_net_text;
        $("pfToday").className = QE.pnlClass(vm.today_net);
        $("pfTotal").textContent = vm.total_net_text;
        $("pfTotal").className = QE.pnlClass(vm.total_net);
        $("pfLayers").textContent = cap.has_data
          ? "可交易 " + cap.tradable_capital.toFixed(2) + " · 已占用 " + cap.reserved_margin.toFixed(2) + " · 保护池 " + cap.protected_profit.toFixed(2) + " (USDT)"
          : "可交易 -- · 已占用 -- · 保护池 --";
        // ---- 短线/长线两张独立子卡:可用额度 / 持仓数 / 今日盈亏 / 状态 ----
        const engineState = String(snapshot.state || "STOPPED");
        const entriesPaused = (() => { try { return Boolean(eng.engine && eng.engine.entriesPaused); } catch (error) { return false; } })();
        const stateText = engineState === "RUNNING" ? (entriesPaused ? "暂缓新开仓" : "自动运行") : QE.stateLabel(engineState);
        const stateCls = engineState === "RUNNING" ? (entriesPaused ? "gray" : "green") : (engineState === "ERROR" ? "red" : "gray");
        const fillPool = (prefix, view) => {
          $(prefix + "State").textContent = stateText;
          $(prefix + "State").className = "pf-state " + stateCls;
          $(prefix + "Avail").textContent = view.available.toFixed(2) + " USDT";
          $(prefix + "Count").textContent = String(view.open_positions);
          $(prefix + "Today").textContent = view.today_net_text;
          $(prefix + "Today").className = QE.pnlClass(view.today_net);
        };
        fillPool("pfShort", vm.short);
        fillPool("pfLong", vm.long);
        // ---- 当前持仓:精简卡片(币种/方向/当前盈亏/保证金/杠杆/持仓时间);点击进 Position Detail 看全部技术字段 ----
        const posBox = $("pfPositions");
        posBox.replaceChildren();
        if (!vm.positions.length) posBox.appendChild(vEl("div", "pf-empty", "当前没有模拟持仓 · Paper 引擎仍在监控机会"));
        for (const p of vm.positions) {
          const el = vEl("div", "pf-pos");
          const head = vEl("div", "pf-pos-head");
          head.appendChild(vEl("div", "name", p.display + " · " + p.side));
          head.appendChild(vEl("div", "pnl " + p.pnl_class, p.pnl_text));
          el.appendChild(head);
          el.appendChild(vEl("div", "meta", p.mode_label + " · " + p.leverage_text + " · 已持有 " + p.holding));
          el.appendChild(vEl("div", "meta", "保证金 " + p.margin_text + " · 盈亏比例 " + p.pnl_pct_text));
          el.addEventListener("click", () => openDetail(p.symbol, p.mode === "long" ? "4h" : "1h"));
          posBox.appendChild(el);
        }
        const trBox = $("pfTrades");
        if (!vm.trades.length) {
          trBox.replaceChildren();
          trBox.appendChild(vEl("div", "v-note", "还没有模拟成交"));
        } else {
          // §65:成交也带完整资金信息(杠杆/保证金/仓位价值/Entry/Exit/净收益)
          // V17:列表可点 → 复盘(定位到该 symbol 的 Entry 前后);条目多时走窗口切片虚拟化
          vVirtualize(trBox, vm.trades, (t) => {
            const el = vEl("div", "mk-row");
            const left = vEl("div");
            left.appendChild(vEl("div", "sym", t.display + " · " + t.mode_label + " · " + t.side + " · " + (t.partial ? "部分 " + t.leverage_text : t.leverage_text)));
            left.appendChild(vEl("div", "sub", "保证金 " + t.margin_text + " · 仓位 " + t.notional_text));
            left.appendChild(vEl("div", "sub", "Entry " + fmt.format(t.entry) + " → Exit " + fmt.format(t.exit) + " · " + t.time + " · " + t.reason + " · " + t.holding));
            el.appendChild(left);
            el.appendChild(vEl("div", "value " + t.net_class, t.net_text + " " + t.pct));
            const raw = tradeById.get(t.id);
            if (raw && raw.symbol) {
              el.style.cursor = "pointer";
              el.addEventListener("click", () => { void openReview(raw.symbol, raw.trade_id); });
            }
            return el;
          }, { threshold: 200, rowHeight: 68, maxHeight: "70vh" });
        }
        await renderPaperStats(eng);
        return vm;
      }

      async function loadTickers(force) {
        if (!force && viewState.lastTickers) return viewState.lastTickers;
        const req = RM.begin("market");
        const tickers = await api("tickers?market=futures", 2, 9000, req.signal);
        if (!req.isCurrent()) return viewState.lastTickers;
        viewState.lastTickers = tickers;
        devTick("market");
        return tickers;
      }

      async function renderMarket(force) {
        const box = $("mkList");
        if (!box.children.length) box.appendChild(vEl("div", "v-note", "正在读取行情..."));
        let tickers = [];
        try {
          tickers = await loadTickers(force);
        } catch (error) {
          if (isAborted(error)) return [];   // 已被新导航取代:静默,不写 UI
          diagLog("market", error);
          // V16.2 §34:错误态给出结构与真实动作(可重试),而不是一行错误文字
          const empty = vEl("div", "empty-state");
          empty.appendChild(vEl("div", null, "行情读取失败:" + shortError(error)));
          const retry = vEl("button", "sec", "重试");
          retry.type = "button";
          retry.addEventListener("click", () => { void renderMarket(true); });
          empty.appendChild(retry);
          box.replaceChildren(empty);
          return;
        }
        const list = Array.isArray(tickers) ? tickers : [];
        const top = list
          .filter((t) => String(t.symbol || "").endsWith("USDT") && !String(t.symbol).includes("_"))
          .sort((a, b) => Number(b.quoteVolume || 0) - Number(a.quoteVolume || 0));
        const wanted = MARKET_SYMBOLS.map((s) => top.find((t) => t.symbol === s)).filter(Boolean);
        const rest = top.filter((t) => !MARKET_SYMBOLS.includes(t.symbol)).slice(0, 20);
        const rows = wanted.concat(rest);
        box.replaceChildren();
        if (!rows.length) box.appendChild(vEl("div", "mk-empty", "暂时读不到行情,稍后再试"));
        for (const t of rows) box.appendChild(marketRowEl(t));
        renderWatchList(list);
        return rows;
      }

      // V16.2s 统一市场行:Symbol | Price(右对齐) | 24h(定宽) | Star(44px 定宽)
      function marketRowEl(t) {
        const symbol = String((t && t.symbol) || "");
        const el = vEl("div", "mk-row");
        el.dataset.tap = "coin:" + symbol;
        const main = vEl("div", "mk-main");
        main.appendChild(vEl("div", "sym", symbol.replace("USDT", "/USDT")));
        el.appendChild(main);
        const price = Number((t && t.lastPrice) || 0);
        el.appendChild(vEl("div", "value mk-price", price > 0 ? fmt.format(price) : "--"));
        const chg = Number((t && t.priceChangePercent) || 0);
        el.appendChild(vEl("div", "mk-chg " + (chg > 0 ? "green" : chg < 0 ? "red" : "muted"), (chg > 0 ? "+" : "") + chg.toFixed(2) + "%"));
        el.appendChild(starButton(symbol));
        el.addEventListener("click", () => { void openDetail(symbol, viewState.detailInterval, el); });
        return el;
      }
      // 收藏按钮统一组件:市场列表 / 搜索结果 / 币种详情 同一套 DOM 与状态源(watchStore)
      function starButton(symbol) {
        const watched = watchStore.has(symbol);
        const btn = vEl("button", "star" + (watched ? " on" : ""), watched ? "★" : "☆");
        btn.type = "button";
        btn.dataset.star = symbol;
        btn.dataset.tap = "star:" + symbol;
        btn.setAttribute("aria-label", (watched ? "取消自选 " : "加入自选 ") + symbol);
        btn.setAttribute("aria-pressed", watched ? "true" : "false");
        btn.addEventListener("click", (event) => {
          event.stopPropagation();   // 星标只管自选,不进详情
          toggleWatchFrom(symbol, btn);
        });
        return btn;
      }
      function toggleWatchFrom(symbol, btn) {
        const h = tapHandle(btn, "star:" + symbol);
        perfMark(h, "nav_requested");
        const res = watchStore.toggle(symbol);
        if (res.reason === "persist_failed") {
          toast("自选保存失败", "error");
          diagLog("watch-persist", new Error(String(res.error || "persist_failed")));
        } else if (res.reason === "limit_reached") {
          toast("自选已达上限(" + watchStore.limit + " 个)");
        } else if (res.reason === "invalid_symbol") {
          toast("该币种不支持自选");
        }
        perfMark(h, "ready");
      }
      // 自选变化 → 全站星标同步 + 自选列表即时重绘(optimistic:先动 UI,失败由 Store 回滚并通知到这里)
      function syncWatchUI(evt) {
        document.querySelectorAll("[data-star]").forEach((btn) => {
          const on = watchStore.has(btn.dataset.star);
          btn.classList.toggle("on", on);
          btn.textContent = on ? "★" : "☆";
          btn.setAttribute("aria-pressed", on ? "true" : "false");
        });
        syncDetailStar();
        renderWatchList(viewState.lastTickers || []);
        if (evt && evt.reason === "rollback") toast("自选保存失败(已回滚)", "error");
      }
      // 市场/自选 分段切换:滑块先动、内容随后;两段各自记忆滚动位置
      function setMarketSeg(seg, options) {
        const opts = options || {};
        const next = seg === "watch" ? "watch" : "market";
        const prev = viewState.mkSeg === "watch" ? "watch" : "market";
        viewState.mkSeg = next;
        const segEl = $("mkSeg");
        if (segEl) segEl.dataset.seg = next;
        const mBtn = $("mkSegMarket");
        const wBtn = $("mkSegWatch");
        if (mBtn) { mBtn.classList.toggle("active", next === "market"); mBtn.setAttribute("aria-selected", next === "market" ? "true" : "false"); }
        if (wBtn) { wBtn.classList.toggle("active", next === "watch"); wBtn.setAttribute("aria-selected", next === "watch" ? "true" : "false"); }
        const listBox = $("mkList");
        const watchBox = $("mkWatchList");
        if (listBox) listBox.classList.toggle("hidden", next !== "market");
        if (watchBox) watchBox.classList.toggle("hidden", next !== "watch");
        if (next === "watch" && !opts.skipRender) renderWatchList(viewState.lastTickers || []);
        if (prev !== next && !opts.skipScroll) {
          viewState.mkScroll[prev] = window.scrollY || 0;
          const target = viewState.mkScroll[next] || 0;
          afterPaint(() => { try { window.scrollTo(0, target); } catch (error) { /* ignore */ } });
        }
      }

      function renderWatchList(tickers) {
        const box = $("mkWatchList");
        if (!box) return;
        box.replaceChildren();
        const watch = watchStore.list();
        if (!watch.length) {
          const empty = vEl("div", "mk-empty");
          empty.appendChild(vEl("div", null, "还没有自选币种"));
          empty.appendChild(vEl("div", null, "可以在市场中点击 ☆ 添加。"));
          box.appendChild(empty);
          return;
        }
        const list = Array.isArray(tickers) ? tickers : [];
        for (const symbol of watch) {
          const t = list.find((x) => x.symbol === symbol) || { symbol: symbol };
          const el = marketRowEl(t);
          if (!(Number(t.lastPrice || 0) > 0)) {
            const priceEl = el.querySelector(".mk-price");
            if (priceEl) priceEl.textContent = "当前不可用";
          }
          box.appendChild(el);
        }
      }

      async function openDetail(symbol, interval, sourceEl) {
        const nextSymbol = symbol || viewState.detailSymbol;
        const nextInterval = interval || viewState.detailInterval;
        // V16.2s 防重复:1.2s 内对"同一币种+周期"的重复点击不重建、不重复发请求(第二次点击不创建第二个页面)
        if (currentPage === "detail" && nextSymbol === viewState.detailSymbol && nextInterval === viewState.detailInterval
          && viewState.detailLoadingAt && Date.now() - viewState.detailLoadingAt < 1200) {
          return viewState.lastDetail;
        }
        const handle = tapHandle(sourceEl, "coin:" + nextSymbol);
        perfMark(handle, "nav_requested");
        viewState.detailLoadingAt = Date.now();
        viewState.detailSymbol = nextSymbol;
        viewState.detailInterval = nextInterval;
        state.symbol = viewState.detailSymbol;
        // 普通进入详情 = 退出复盘(openReview 会在本函数返回后重新写入复盘状态)
        viewState.review = null;
        dtChart.review = null;
        dtChart.marks = [];
        dtChart.marksSymbol = null;
        dtChart.subMs = 0;          // V18:重新进入详情回到标准周期(秒级模式不跨会话保留)
        dtChart.popMark = null;
        const emptyEl = $("dtChartEmpty");
        if (emptyEl) emptyEl.textContent = "暂无K线";
        dtRenderDetailPeriods();
        dtRenderLegend();
        renderReviewBlock();
        // ① 先切页(同步)=> 浏览器下一帧即可绘制既有 DOM,不等任何网络
        setActivePage("detail");
        initDetailPeriods();
        syncDetailStar();
        // ② Shell 先行:缓存价格/涨跌 + 缓存K线旧图(有则立即画)
        paintDetailFromCache();
        requestAnimationFrame(() => perfMark(handle, "transition"));
        afterPaint(() => perfMark(handle, "first_paint"));
        // ③ 重活(分析/K线/情报)全部在页面出现之后异步完成
        await refreshDetail();
        perfMark(handle, "ready");
        return viewState.lastDetail;
      }
      // Shell 先行:用缓存 ticker 与K线缓存先把详情页画上(不空白、不等网络)
      function paintDetailFromCache() {
        try {
          const symbol = viewState.detailSymbol;
          if (!symbol) return;
          $("dtSymbol").textContent = symbol.replace("USDT", "/USDT");
          const t = (viewState.lastTickers || []).find((x) => x.symbol === symbol) || null;
          if (t) {
            const price = Number(t.lastPrice || 0);
            if (price > 0) $("dtPrice").textContent = fmt.format(price);
            const chg = Number(t.priceChangePercent || 0);
            const chgEl = $("dtChange");
            chgEl.textContent = (chg > 0 ? "+" : "") + chg.toFixed(2) + "%";
            chgEl.className = chg > 0 ? "green" : chg < 0 ? "red" : "muted";
          }
          const key = String(symbol) + ":" + String(viewState.detailInterval || "");
          const cached = viewState.klinesCache.get(key);
          if (cached && cached.length) {
            const emptyEl = $("dtChartEmpty");
            if (emptyEl) emptyEl.classList.add("hidden");
            setDetailKlines(cached);   // 先画缓存旧图;真实数据回来后由 setDetailKlines 原地合并
          }
        } catch (error) { diagLog("detail-shell", error); }
      }
      function syncDetailStar() {
        const btn = $("dtStar");
        if (!btn) return;
        btn.dataset.star = viewState.detailSymbol || "";
        const on = watchStore.has(viewState.detailSymbol);
        btn.classList.toggle("on", on);
        btn.textContent = on ? "★" : "☆";
        btn.setAttribute("aria-pressed", on ? "true" : "false");
      }

      function initDetailPeriods() {
        // V18:周期条由 dtRenderDetailPeriods 统一渲染(秒级周期只在真实成交流可用时追加)
        dtRenderDetailPeriods();
      }

      async function refreshDetail() {
        const req = RM.begin("detail");
        const symbol = viewState.detailSymbol;
        const interval = viewState.detailInterval;
        $("dtSymbol").textContent = symbol.replace("USDT", "/USDT");
        const analysisTask = api("analyze?symbol=" + symbol + "&interval=" + interval, 2, 15000, req.signal).then((v) => ({ ok: true, v })).catch((e) => { diagLog("detail-analyze", e); return { ok: false, error: e, aborted: isAborted(e) }; });
        const klineTask = api("klines?market=futures&symbol=" + symbol + "&interval=" + interval + "&limit=200", 2, 9000, req.signal).then((v) => ({ ok: true, v })).catch((e) => { diagLog("detail-klines", e); return { ok: false, error: e, aborted: isAborted(e) }; });
        const [aRes, kRes] = await Promise.all([analysisTask, klineTask]);
        if (!req.isCurrent()) return viewState.lastDetail; // 旧 generation 直接丢弃
        // 请求被取消(离开详情页)→ 不渲染、不动图
        if (aRes.aborted || kRes.aborted) return viewState.lastDetail;
        const eng = await getPaperEngine();
        const snapshot = eng.snapshot();
        const analysis = aRes.ok ? aRes.v : null;
        const ticker = (viewState.lastTickers || []).find((t) => t.symbol === symbol) || {};
        let risk = null;
        if (analysis) {
          risk = QE.evaluateRisk({ account: snapshot.account, wallets: snapshot.wallets, positions: snapshot.positions, trades: eng.getTrades(), quote: { price: analysis.price, received_at: Date.now() }, now: Date.now(), analysis, mode: viewState.detailInterval === "1d" || viewState.detailInterval === "4h" ? "long" : "short", symbol });
        }
        const evidence = analysis ? QE.evidenceBundle(analysis, null) : null;
        const mlResolved = analysis ? resolveDetailMl(analysis, risk, evidence) : null;
        const decision = analysis ? QE.fuse({ analysis, ml: mlResolved ? QE.toFusionMl(mlResolved) : null, risk: risk || {}, evidence }) : null;
        const vm = QE.detailViewModel({
          analysis: analysis || {}, symbol, interval, price: aRes.ok ? analysis.price : Number(ticker.lastPrice || 0),
          change24h: Number(ticker.priceChangePercent || 0), positions: snapshot.positions, mode: viewState.detailInterval === "1h" ? "short" : "long",
          risk: risk ? { ...risk, risk_level_raw: risk.risk_level } : null, decision, ml: mlResolved ? QE.toFusionMl(mlResolved) : null, now: Date.now()
        });
        viewState.lastDetail = { ...vm, risk_score: risk ? risk.risk_score : null, risk_flags: risk ? risk.risk_flags : [] };
        // V14.4:为利润保护/回撤面板准备原始持仓与状态机快照
        viewState.lastPositionRaw = (snapshot.positions || []).find((p) => p.symbol === symbol) || null;
        try {
          const ddRec = eng.getDrawdown ? eng.getDrawdown() : null;
          viewState.lastDrawdown = ddRec ? QE.drawdownView(ddRec) : null;
        } catch (error) { viewState.lastDrawdown = null; }
        viewState.lastAnalysis = analysis;
        // 渲染(仅更新变化字段)
        $("dtPrice").textContent = vm.price ? fmt.format(vm.price) : "--";
        const chg = $("dtChange");
        chg.textContent = vm.change_text;
        chg.className = vm.change24h > 0 ? "green" : vm.change24h < 0 ? "red" : "muted";
        $("dtBias").textContent = vm.bias + " · " + vm.direction_zh + (vm.confidence == null ? "" : "(置信 " + vm.confidence + ")");
        $("dtBias").className = "value " + vm.bias_class;
        $("dtRisk").textContent = vm.risk_level + (vm.risk_score == null ? "" : " " + vm.risk_score);
        $("dtStrategy").textContent = vm.strategy;
        const posBox = $("dtPositionBox");
        posBox.replaceChildren();
        if (vm.position) {
          const pos = vm.position;
          posBox.appendChild(vEl("div", "sec-title", "当前模拟持仓"));
          const head = vEl("div", "hm-row");
          head.appendChild(vEl("span", "k", pos.mode_label + " · " + pos.side + " · " + pos.leverage_text));
          head.appendChild(vEl("span", "v " + pos.pnl_class, pos.pnl_label + " " + pos.pnl_text + " (" + pos.pnl_pct_text + ")"));
          posBox.appendChild(head);
          const grid = vEl("div", "pf-grid");
          const cell = (k, v) => { const c = vEl("div"); c.appendChild(vEl("span", null, k)); c.appendChild(vEl("b", null, v)); return c; };
          grid.appendChild(cell("保证金", pos.margin_text));
          grid.appendChild(cell("仓位价值", pos.notional_text));
          grid.appendChild(cell("爆仓价", pos.liquidation_text));
          grid.appendChild(cell("买入", fmt.format(pos.entry_price)));
          grid.appendChild(cell("当前", fmt.format(pos.current_price)));
          grid.appendChild(cell("持仓", pos.holding));
          grid.appendChild(cell("止损", pos.stop == null ? "--" : fmt.format(pos.stop)));
          grid.appendChild(cell("止盈", pos.take_profit == null ? "--" : fmt.format(pos.take_profit)));
          grid.appendChild(cell("剩余仓位", pos.remaining_pct_text));
          posBox.appendChild(grid);
          if (pos.partial_close_count > 0) {
            posBox.appendChild(vEl("div", "v-note", "已实现 " + pos.realized_text + " · 已平 " + pos.closed_pct_text + " · 剩余仓位价值 " + pos.remaining_notional_text));
          }
          posBox.appendChild(vEl("div", "v-note", "Trailing " + pos.trailing_text + " · 资金费 " + QE.num(pos.funding_simulated, 0).toFixed(4) + " USDT(" + pos.funding_status + ")"));
          const actRow = vEl("div", "hm-actions");
          const closeBtn = vEl("button", "sec danger", "平仓");
          closeBtn.type = "button";
          closeBtn.addEventListener("click", () => { void openCloseSheet(pos.id); });
          const manageBtn = vEl("button", "sec", viewState.lastDrawdown ? "回撤 " + viewState.lastDrawdown.state_label : "风控中");
          manageBtn.type = "button";
          manageBtn.disabled = true;
          actRow.appendChild(closeBtn);
          actRow.appendChild(manageBtn);
          posBox.appendChild(actRow);
          // §68:持仓区简洁显示未来预测(不铺几十个字段)
          const fp = viewState.lastPrediction && viewState.lastPrediction.predictions ? (viewState.lastPrediction.predictions[viewState.detailInterval] || viewState.lastPrediction.predictions["1h"]) : null;
          if (fp) {
            const d = QE.describeProbability(fp);
            posBox.appendChild(vEl("div", "v-note", "未来 " + (fp.horizon || "1h") + ":" + d.text + " · 反转风险 " + d.reversal_risk_pct + "% · 不确定性 " + d.uncertainty_pct + "%"));
          }
        }
        const details = $("dtDetails");
        details.replaceChildren();
        details.appendChild(vEl("div", "v-note", "环境 " + vm.regime + " · 多周期 " + Object.keys(vm.timeframes || {}).map((k) => k + " " + (vm.timeframes[k] || "")).join(" / ")));
        if (vm.risk_flags && vm.risk_flags.length) details.appendChild(vEl("div", "v-note", "风险标记:" + vm.risk_flags.join("、")));
        if (analysis) {
          const why = vEl("ul", "v-note"); why.style.paddingLeft = "18px";
          for (const item of (analysis.reasons || [])) why.appendChild(vEl("li", null, item));
          details.appendChild(vEl("div", "coin-name", "判断理由"));
          details.appendChild(why);
          const risks = vEl("ul", "v-note"); risks.style.paddingLeft = "18px";
          for (const item of (analysis.risks || [])) risks.appendChild(vEl("li", null, item));
          details.appendChild(vEl("div", "coin-name", "风险提示"));
          details.appendChild(risks);
        }
        details.appendChild(vEl("div", "v-note", "决策:" + (decision ? decision.action + "(" + decision.reason + ")" : "数据不足")));
        if (vm.degraded) details.appendChild(vEl("div", "v-note", "部分辅助周期数据缺失,已降级分析"));
        // V14.4:未来预测 / 外部情报 / 利润保护 / 回撤状态
        renderFutureCard(analysis, mlResolved);
        renderExternalCard();
        renderLockCard(vm.position, analysis);
        await refreshExternalIntelligence(symbol);
        // K线:保留旧图,新数据回来后交叉淡入替换
        if (kRes.ok && kRes.v && kRes.v.length) {
          $("dtChartEmpty").classList.add("hidden");
          drawDetailChart(kRes.v);
        } else if (!viewState.lastKlines) {
          $("dtChartEmpty").classList.remove("hidden");
        }
        // V17:本 symbol 的交易标记(按 symbol 缓存,禁止跨 symbol 串用)+ 复盘块
        await dtLoadTradeMarks(eng, symbol);
        if (viewState.review) { dtApplyReviewViewport(); renderReviewBlock(); }
        // V18:对"当前 symbol + 当前周期"建立实时订阅(相同订阅复用,不同则先关旧的)
        dtWsSync(symbol, interval);
        dtUpdateCountdown();
        return vm;
      }

      // V17 详情实时刷新:只取 K 线(轻量),交给 setDetailKlines 做"只更新最后一根"的合并。
      // 用户在看历史(wasLatest=false)时视口不被拽回最新(setDetailKlines 内部保证)。
      async function refreshDetailKlines() {
        if (currentPage !== "detail") return;
        if (dtChart.subMs > 0) return;   // 秒级模式:Binance 没有秒级 REST 周期,不请求
        const symbol = viewState.detailSymbol;
        const interval = viewState.detailInterval;
        if (!symbol) return;
        const req = RM.begin("detail-live");
        try {
          const rows = await api("klines?market=futures&symbol=" + symbol + "&interval=" + interval + "&limit=200", 1, 8000, req.signal);
          if (!req.isCurrent()) return;
          if (symbol !== viewState.detailSymbol || interval !== viewState.detailInterval) return;
          if (Array.isArray(rows) && rows.length) {
            $("dtChartEmpty").classList.add("hidden");
            drawDetailChart(rows);
            await dtLoadTradeMarks(null, symbol);
            if (viewState.review) renderReviewBlock();
          }
        } catch (error) {
          if (!isAborted(error)) diagLog("detail-klines-live", error);
        }
      }

      // ================= V14.4 详情页:未来预测 / 外部情报 / 利润保护(§72-§74) =================
      // 设计原则:普通用户看"一句话 + 百分比 + 波动区间 + 可信度",不铺十几个模型数字(§72)
      const externalHub = QE.createDataHub({ now: () => Date.now() });

      function renderFutureCard(analysis, mlResolved) {
        const card = $("dtFutureCard");
        if (!card) return;
        if (!analysis || !analysis.direction) {
          $("dtFutureHeadline").textContent = "--";
          $("dtFutureHorizons").replaceChildren();
          $("dtFutureRange").textContent = "暂无行情快照,无法给出概率分布";
          return;
        }
        let multi = null;
        try {
          multi = QE.predictMultiHorizon({
            analysis,
            ml: mlResolved ? QE.toFusionMl(mlResolved) : null,
            external: viewState.lastExternal || null,
            now: Date.now()
          });
        } catch (error) {
          diagLog("predict", error);
        }
        viewState.lastPrediction = multi;
        const box = $("dtFutureHorizons");
        box.replaceChildren();
        if (!multi || !multi.ok) {
          $("dtFutureHeadline").textContent = "--";
          $("dtFutureRange").textContent = "预测不可用";
          return;
        }
        const shortFirst = ["15m", "1h", "4h", "1d", "3d"];
        for (const h of shortFirst) {
          const p = multi.predictions[h];
          if (!p) continue;
          const d = QE.describeProbability(p);
          const chip = vEl("span", "chip" + (h === viewState.detailInterval ? " active" : ""), h + " " + d.text);
          box.appendChild(chip);
        }
        const focus = multi.predictions[viewState.detailInterval] || multi.predictions["1h"] || multi.predictions["15m"];
        const fd = QE.describeProbability(focus);
        $("dtFutureHeadline").textContent = "未来 " + (focus.horizon || "1h") + " " + fd.label + " " + Math.max(fd.bullish_pct, fd.neutral_pct, fd.bearish_pct) + "%";
        $("dtFutureRange").textContent = "预计波动 " + fd.expected_range_text + " · 可信度" + fd.confidence_text
          + "(不确定性 " + fd.uncertainty_pct + "%)· 反转风险 " + fd.reversal_risk_pct + "% · 趋势延续 " + fd.persistence_pct + "%";
      }

      function renderExternalCard() {
        const ext = viewState.lastExternal;
        const body = $("dtExternalBody");
        const note = $("dtExternalNote");
        const gate = $("dtExternalGate");
        if (!ext) {
          note.textContent = "外部情报 unavailable(未取到)";
          body.replaceChildren();
          gate.textContent = "缺失时本地引擎照常工作:情报只做上下文,不会放行开仓";
          return;
        }
        const o = ext.overall || {};
        note.textContent = o.status === "full" ? "Funding / OI / 情绪 · 数据齐全" : o.status === "partial" ? "Funding / OI / 情绪 · 部分缺失(" + (o.unavailable || []).map((u) => u.type).join(",") + ")" : "Funding / OI / 情绪 · unavailable";
        const rows = [];
        const f = ext.funding_context || {};
        rows.push(["资金费", f.available ? (f.rate_pct == null ? "--" : f.rate_pct + "%/期") + (f.extreme ? " · 极端(拥挤风险)" : "") : "unavailable"]);
        const oi = ext.oi_context || {};
        rows.push(["持仓量 OI", oi.available ? (oi.oi_change_pct == null ? "--" : oi.oi_change_pct + "%") + " · " + (oi.label || "") : "unavailable"]);
        const pos = ext.positioning_context || {};
        rows.push(["多空比", pos.available ? pos.long_short_ratio + " · " + (pos.sentiment === "crowded_long" ? "多头拥挤" : pos.sentiment === "crowded_short" ? "空头拥挤" : "均衡") : "unavailable"]);
        const taker = ext.taker_context || {};
        rows.push(["主动买卖", taker.available ? (taker.label || "") + "(" + (taker.imbalance == null ? "--" : taker.imbalance) + ")" : "unavailable"]);
        const news = ext.news_context || {};
        rows.push(["消息面", news.available ? (news.sentiment === "bullish" ? "偏多" : news.sentiment === "bearish" ? "偏空" : "中性") + " · 置信 " + news.confidence + (news.conflicted ? " · 来源冲突" : "") : "unavailable"]);
        const stress = ext.market_stress_context || {};
        rows.push(["市场压力", (stress.level || "--") + "(评分 " + (stress.stress_score == null ? "--" : stress.stress_score) + ")"]);
        body.replaceChildren(vTable(["项目", "状态"], rows));
        const g = QE.externalRiskGate({ external: ext });
        gate.textContent = "情报权限:只收紧不放行 · 收紧量 " + g.strictness + (g.reasons.length ? "(" + g.reasons.join("、") + ")" : "");
      }

      function renderLockCard(position, analysis) {
        const card = $("dtLockCard");
        if (!card) return;
        // 回撤状态与是否有持仓无关,先更新(引擎未运行时给出可读说明)
        const dd = viewState.lastDrawdown;
        const ddEl = $("dtDrawdown");
        if (ddEl) ddEl.textContent = dd ? dd.state_label + "(账户 " + dd.account_dd_text + " / 当日 " + dd.daily_dd_text + " / " + dd.pool_text + ")" : "引擎未运行(开始模拟后评估)";
        const open = viewState.lastPositionRaw;
        if (!open || open.status !== "OPEN") { card.hidden = true; return; }
        card.hidden = false;
        const price = QE.num(open.current_price, open.entry_price);
        const gb = QE.givebackOf(open, price, { atr: analysis && analysis.volatility ? QE.num(analysis.volatility.atrPct) / 100 * price : 0 });
        const atrAbs = analysis && analysis.volatility ? QE.num(analysis.volatility.atrPct) / 100 * price : 0;
        const decision = QE.profitLockDecision({
          position: open,
          price,
          atr: atrAbs,
          trend_strength: analysis && analysis.market_regime && analysis.market_regime.trend_market ? 0.65 : 0.4,
          reversal_risk: (viewState.lastPrediction && viewState.lastPrediction.predictions && viewState.lastPrediction.predictions["1h"]) ? QE.num(viewState.lastPrediction.predictions["1h"].reversal_risk) : 0.35,
          prediction_bullish: (viewState.lastPrediction && viewState.lastPrediction.predictions && viewState.lastPrediction.predictions["1h"]) ? QE.num(viewState.lastPrediction.predictions["1h"].bullish_probability) : null,
          volatility_level: analysis && analysis.volatility ? analysis.volatility.level : null
        });
        const view = QE.profitLockView({ stage: decision.stage, giveback: gb, partial_fraction: decision.fraction, trailing_distance: decision.trail ? decision.trail.distance : null });
        $("dtLockStage").textContent = view.stage_label;
        $("dtLockPeak").textContent = view.max_unrealized_text;
        $("dtLockNow").textContent = view.current_text;
        $("dtLockGiveback").textContent = view.giveback_text;
        $("dtLockRemain").textContent = (open.remaining_quantity == null ? "--" : open.remaining_quantity) + " · " + (view.trailing_text === "--" ? "--" : view.trailing_text);
        $("dtLockNext").textContent = "下一步:" + view.next_action + (decision.reasons && decision.reasons.length ? " · " + decision.reasons[decision.reasons.length - 1] : "");
      }

      // 外部情报:详情页刷新时同步一次(实际取数统一走 DataHub,后台定时器也会更新 —— §18 不重复请求)
      async function refreshExternalIntelligence(symbol) {
        try {
          const eng = await getPaperEngine();
          const req = RM.begin("external");
          await refreshExternalForSymbols(eng, [symbol], req.signal);
          if (!RM.isCurrent("external", req.generation)) return;
          renderExternalCard();
        } catch (error) {
          if (!isAborted(error)) diagLog("external", error);
        }
      }

      // ================= V14.3 专业K线:Tap / 长按 / 十字光标 / Drag 平移 / Pinch Zoom / Volume 副图 / 最新 / rAF+DPR =================
      // 分工:几何与手势判定在 QE.chart*(ui/chart.js,纯函数、可单测);这里只做 DOM 事件与绘制
      const dtChart = {
        klines: [],
        vp: null,
        cross: null,        // 十字光标 { index, y }
        range: null,        // 最近一次绘制的价格区间 { top, bottom }
        raf: null,          // 已排队的 rAF 句柄
        rafFallback: null,  // 超时兜底句柄(页面不可见时 rAF 不触发)
        gesture: null,      // { mode: "pan"|"pinch"|"idle", lastX, lastDist, midRatio }
        press: null,        // { x, y, at, timer, index, moved }
        theme: null,
        // V17:全屏 / 交易标记 / 复盘
        fullscreen: false,
        fsPushed: false,    // 是否已 push 一条 history(退出时负责 pop,避免返回键堆积)
        fsHome: null,       // 全屏前 #dtPeriods 的原位 { parent, next }
        marks: [],          // 当前 symbol 的交易标记(按 symbol 各自缓存,禁止跨 symbol 串用)
        marksSymbol: null,
        review: null,       // 复盘:{ pid, entryTime }
        hintHome: null,     // #dtChartHint 原本文案(全屏时追加 symbol)
        // V18:标记气泡 / 该 symbol 的 Decision Journal / 秒级本地聚合周期 / 最近一次实时 tick
        popMark: null,
        journal: [],
        subMs: 0,
        lastTickAt: null
      };
      const DT_CHART_HEIGHT = 268;
      // V17:交易标记形状/颜色/中文图例(开仓按方向着色;加仓/部分/最终/止损/止盈形状不同)
      // V18:细分到 8 类(开仓 / 加仓 / 部分平仓 / 最终平仓 / 止损 / 止盈 / 风险退出 / 手动退出)
      const DT_MARK_ZH = {
        entry_long: "开仓·多(↑)", entry_short: "开仓·空(↓)", add: "加仓(+)",
        partial: "部分平仓(○)", final: "最终平仓(■)", stop: "止损(×)", tp: "止盈(◆)",
        risk: "风险退出(✕✕)", manual: "手动退出(‖)"
      };
      const DT_MARK_COLOR = {
        entry_long: "#00b374", entry_short: "#f6465d", add: "#a06bd6",
        partial: "#d29a3a", final: "#4a90d9", stop: "#f6465d", tp: "#00b374",
        risk: "#f6465d", manual: "#8b919a"
      };
      const DT_MARK_ORDER = ["entry_long", "entry_short", "add", "partial", "final", "stop", "tp", "risk", "manual"];
      const DT_MARKS_KEY = "dtTradeMarks";
      let dtMarkOn = true;
      try { if (localStorage.getItem(DT_MARKS_KEY) === "0") dtMarkOn = false; } catch (error) { dtMarkOn = true; }
      // V18:标记细分开关(总开关 = dtMarkOn;分组开关存 localStorage)
      const DT_MARK_FILTERS_KEY = "dtTradeMarkFilters";
      const DT_MARK_GROUPS = [
        { key: "entry", zh: "开仓", kinds: ["entry_long", "entry_short", "add"], color: "#00b374" },
        { key: "partial", zh: "部分平仓", kinds: ["partial"], color: "#d29a3a" },
        { key: "close", zh: "平仓", kinds: ["final", "manual"], color: "#4a90d9" },
        { key: "stopTp", zh: "止损止盈", kinds: ["stop", "tp", "risk"], color: "#f6465d" }
      ];
      const dtMarkFilters = { entry: true, partial: true, close: true, stopTp: true };
      try {
        const rawFilters = JSON.parse(localStorage.getItem(DT_MARK_FILTERS_KEY) || "null");
        if (rawFilters && typeof rawFilters === "object") {
          for (const g of DT_MARK_GROUPS) if (typeof rawFilters[g.key] === "boolean") dtMarkFilters[g.key] = rawFilters[g.key];
        }
      } catch (error) { /* 隐私模式:保留默认全开 */ }
      // 成交量副图:内部轴键保持稳定(图表库惯例,便于外部工具识别),界面展示用中文
      const VOL_AXIS_KEY = "VOL";
      const VOL_AXIS_ZH = "成交量";

      function dtTheme() {
        const styles = getComputedStyle(document.documentElement);
        return {
          bg: styles.getPropertyValue("--chart-bg").trim() || "#12151a",
          grid: styles.getPropertyValue("--line").trim() || "#262b33",
          muted: styles.getPropertyValue("--muted").trim() || "#8b919a",
          up: styles.getPropertyValue("--green").trim() || "#00b374",
          down: styles.getPropertyValue("--red").trim() || "#f6465d"
        };
      }

      function dtLayoutOf(width) {
        return QE.chartApi.layoutOf(width, DT_CHART_HEIGHT, {});
      }

      // 双缓冲式重绘:一帧只画一次(rAF 合并高频手势事件)
      // 兜底:页面不可见时 rAF 可能长时间不触发 —— 若只依赖 rAF,句柄会永久挂起,
      //       之后即使回到前台也不再重绘(空图)。因此同时挂一个超时兜底,谁先到谁画。
      function scheduleDetailChart() {
        if (dtChart.raf != null || dtChart.rafFallback != null) return;
        let fired = false;
        const run = () => {
          if (fired) return;
          fired = true;
          if (dtChart.raf != null && typeof window.cancelAnimationFrame === "function") {
            try { window.cancelAnimationFrame(dtChart.raf); } catch (error) { /* ignore */ }
          }
          if (dtChart.rafFallback != null) { clearTimeout(dtChart.rafFallback); dtChart.rafFallback = null; }
          dtChart.raf = null;
          paintDetailChart();
        };
        const raf = window.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
        dtChart.raf = raf(run);
        dtChart.rafFallback = setTimeout(run, 200);
      }

      // 新数据到达:保留用户的缩放与位置;原本贴最新则跟随右移
      // 统一用 Binance 原始数组形状 [openTime, o, h, l, c, v] 贯穿渲染,避免上下两层数据结构不一致
      function setDetailKlines(klines) {
        const fetched = (klines || []).filter((k) => Array.isArray(k)
          && Number.isFinite(Number(k[1])) && Number.isFinite(Number(k[2])) && Number.isFinite(Number(k[3]))
          && Number.isFinite(Number(k[4])) && Number(k[4]) > 0 && Number(k[2]) >= Number(k[3]));
        if (!fetched.length) return;
        // V16.2s 真缺陷修复:跨币种/跨周期不得"按时间戳合并" ——
        // 旧实现只比较最后一根时间戳(BTC 1h 与 ETH 1h 的最后一根开盘时间是同一个整点,
        // 不满足"严格大于"→ 走合并分支 → 把新币K线覆盖到旧币历史之上,出现混合K线图)。
        // 现在:数据序列不同(symbol:interval 变了)→ 整段替换并重置视口。
        const seriesKey = String(viewState.detailSymbol || "") + ":" + String(viewState.detailInterval || "");
        const sameSeries = dtChart.seriesKey === seriesKey;
        const cur = sameSeries ? dtChart.klines : [];
        const prevTotal = cur.length;
        const wasLatest = !dtChart.vp || prevTotal === 0 || QE.chartApi.isAtLatest(dtChart.vp, prevTotal);
        const prevStart = dtChart.vp ? dtChart.vp.start : 0;
        const prevCount = dtChart.vp ? dtChart.vp.count : null;
        // V17 实时更新(不造假):
        //   · 最后一根时间戳严格大于当前最后一根 → 才真正 append 新 candle(整段替换)
        //   · 否则只刷新"时间戳重合"的 candle(实盘只变最后一根未收盘的 h/l/c/v),绝不 append、绝不删历史
        //   · 用户正在看历史时视口不因刷新被拽回最新(沿用下面的 wasLatest 分支)
        let rows = fetched;
        if (prevTotal > 0) {
          const lastNew = Number(fetched[fetched.length - 1][0]);
          const lastCur = Number(cur[cur.length - 1][0]);
          if (!(lastNew > lastCur)) {
            const byTime = new Map();
            for (const r of fetched) byTime.set(Number(r[0]), r);
            rows = cur.slice();
            for (let i = 0; i < rows.length; i += 1) {
              const hit = byTime.get(Number(rows[i][0]));
              if (hit) rows[i] = hit;
            }
          }
        }
        dtChart.seriesKey = seriesKey;
        dtChart.klines = rows;
        if (!sameSeries) dtChart.vp = null;   // 新序列:视口回到默认(贴最新)
        if (!dtChart.vp || prevCount == null) dtChart.vp = QE.chartApi.createViewport(rows.length, {});
        else if (wasLatest) dtChart.vp = QE.chartApi.latestViewport({ total: rows.length, start: prevStart, count: prevCount }, rows.length);
        else dtChart.vp = QE.chartApi.clampViewport({ total: rows.length, start: prevStart, count: prevCount }, rows.length);
        if (dtChart.cross && dtChart.cross.index >= rows.length) dtChart.cross = null;
        viewState.lastKlines = klines;
        // V16.2s:缓存最近K线(symbol+interval → rows,上限 12),再次进入同币详情时先画旧图
        try {
          viewState.klinesCache.delete(seriesKey);
          viewState.klinesCache.set(seriesKey, fetched.slice(-260));
          while (viewState.klinesCache.size > 12) {
            const firstKey = viewState.klinesCache.keys().next().value;
            viewState.klinesCache.delete(firstKey);
          }
        } catch (error) { /* 缓存失败不影响绘图 */ }
        scheduleDetailChart();
      }

      function paintDetailChart() {
        const canvas = $("dtCanvas");
        const card = $("dtChartCard");
        if (!canvas || !card) return;
        const width = Math.max(280, card.clientWidth || 340);
        const height = dtChartHeightOf(card);
        // devicePixelRatio:按物理像素分配位图,逻辑坐标绘制 → 手机端不糊
        const dpr = Math.min(3, window.devicePixelRatio || 1);
        const pxW = Math.round(width * dpr);
        const pxH = Math.round(height * dpr);
        if (canvas.width !== pxW || canvas.height !== pxH) {
          canvas.width = pxW;
          canvas.height = pxH;
        }
        canvas.style.width = width + "px";
        canvas.style.height = height + "px";
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        dtChart.theme = dtTheme();
        const theme = dtChart.theme;
        ctx.fillStyle = theme.bg;
        ctx.fillRect(0, 0, width, height);
        const rows = dtChart.klines;
        if (!rows.length) { paintOhlcBar(null, null); return; }
        const vp = dtChart.vp = QE.chartApi.clampViewport(dtChart.vp, rows.length);
        const layout = dtLayoutOf(width);
        const view = QE.chartApi.visibleBars(vp, rows.length);
        const rng = QE.chartApi.priceRangeOf(rows, view.from, view.to, 0.08);
        dtChart.range = { top: rng.top, bottom: rng.bottom };   // 供十字光标换算价格 → y
        // 价格区间无效(数据形状异常等)→ 不画K线,避免画到画布外还显示成"正常"
        if (rng.invalid) {
          ctx.fillStyle = theme.muted;
          ctx.font = "12px system-ui, sans-serif";
          ctx.fillText("K线数据异常,无法绘制", layout.pad.left + 4, layout.chartTop + 18);
          paintOhlcBar(null, null);
          return;
        }
        const step = QE.chartApi.stepOf(layout, vp.count);

        // 价格网格 + 右侧刻度
        ctx.strokeStyle = theme.grid;
        ctx.lineWidth = 1;
        ctx.fillStyle = theme.muted;
        ctx.font = "11px system-ui, sans-serif";
        ctx.textAlign = "left";
        for (let i = 0; i <= 4; i += 1) {
          const price = rng.top - (rng.top - rng.bottom) / 4 * i;
          const y = Math.round(QE.chartApi.yOfPrice(price, layout, rng.top, rng.bottom)) + 0.5;
          ctx.beginPath();
          ctx.moveTo(layout.pad.left, y);
          ctx.lineTo(layout.pad.left + layout.plotW, y);
          ctx.stroke();
          ctx.fillText(fmt.format(price), layout.pad.left + layout.plotW + 6, y + 4);
        }
        // 成交量副图(与主图共用 x 轴)
        let maxVol = 0;
        for (let i = view.from; i < view.to; i += 1) if (Number(rows[i][5]) > maxVol) maxVol = Number(rows[i][5]);
        for (let i = view.from; i < view.to; i += 1) {
          const k = rows[i];
          const x = QE.chartApi.xOfIndex(i, vp, layout);
          const vh = QE.chartApi.volumeBarHeight(Number(k[5]), maxVol, layout.volH);
          ctx.fillStyle = Number(k[4]) >= Number(k[1]) ? "rgba(0, 179, 116, .38)" : "rgba(246, 70, 93, .38)";
          ctx.fillRect(x - Math.max(1, step * 0.3), layout.volBottom - vh, Math.max(1.5, step * 0.6), vh);
        }
        ctx.fillStyle = theme.muted;
        // 副图内部轴键保持稳定(图表库惯例),展示文案本地化为"成交量"
        ctx.fillText(VOL_AXIS_ZH, layout.pad.left + 2, layout.volTop + 9);
        // K线
        const bodyW = Math.max(1.5, Math.min(9, step * 0.62));
        for (let i = view.from; i < view.to; i += 1) {
          const k = rows[i];
          const open = Number(k[1]);
          const high = Number(k[2]);
          const low = Number(k[3]);
          const close = Number(k[4]);
          const x = QE.chartApi.xOfIndex(i, vp, layout);
          const color = close >= open ? theme.up : theme.down;
          ctx.strokeStyle = color;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.moveTo(x, QE.chartApi.yOfPrice(high, layout, rng.top, rng.bottom));
          ctx.lineTo(x, QE.chartApi.yOfPrice(low, layout, rng.top, rng.bottom));
          ctx.stroke();
          const y1 = QE.chartApi.yOfPrice(Math.max(open, close), layout, rng.top, rng.bottom);
          const y2 = QE.chartApi.yOfPrice(Math.min(open, close), layout, rng.top, rng.bottom);
          ctx.fillRect(x - bodyW / 2, y1, bodyW, Math.max(1, y2 - y1));
        }
        // 最新价虚线(只在可见区间内画)
        const lastIndex = rows.length - 1;
        if (lastIndex >= view.from && lastIndex < view.to) {
          const lastPrice = Number(rows[lastIndex][4]);
          const y = QE.chartApi.yOfPrice(lastPrice, layout, rng.top, rng.bottom);
          ctx.save();
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = theme.muted;
          ctx.beginPath();
          ctx.moveTo(layout.pad.left, y);
          ctx.lineTo(layout.pad.left + layout.plotW, y);
          ctx.stroke();
          ctx.restore();
        }
        // x 轴时间标签:画在 pad.bottom 预留的留白里,不会遮挡K线(随拖动/缩放实时重算)
        dtDrawTimeAxis(ctx, rows, view, vp, layout, theme);
        // 交易标记(开仓/加仓/部分平仓/最终平仓/止损/止盈);无对应 candle 的标记直接跳过
        dtDrawTradeMarks(ctx, rows, vp, layout, rng, theme);
        // 十字光标
        const cross = dtChart.cross;
        if (cross && cross.index >= view.from && cross.index < view.to) {
          const x = Math.round(QE.chartApi.xOfIndex(cross.index, vp, layout)) + 0.5;
          const y = Math.max(layout.chartTop, Math.min(layout.chartBottom, Math.round(cross.y))) + 0.5;
          ctx.strokeStyle = theme.muted;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, layout.chartTop);
          ctx.lineTo(x, layout.volBottom);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(layout.pad.left, y);
          ctx.lineTo(layout.pad.left + layout.plotW, y);
          ctx.stroke();
          const price = QE.chartApi.priceAtY(y, layout, rng.top, rng.bottom);
          const label = fmt.format(price);
          ctx.fillStyle = theme.grid;
          const lw = ctx.measureText(label).width + 8;
          ctx.fillRect(layout.pad.left + layout.plotW + 2, y - 8, lw, 16);
          ctx.fillStyle = theme.muted;
          ctx.fillText(label, layout.pad.left + layout.plotW + 6, y + 4);
        }
        const focusIndex = cross && cross.index >= 0 && cross.index < rows.length ? cross.index : lastIndex;
        paintOhlcBar(rows[focusIndex], focusIndex > 0 ? rows[focusIndex - 1] : null);
      }

      // OHLC + 涨跌幅信息条(涨跌幅相对上一根收盘;十字光标移动时实时跟随)
      function paintOhlcBar(candle, prev) {
        const bar = $("dtOhlcBar");
        if (!bar) return;
        if (!candle) {
          for (const id of ["dtOhlcTime", "dtOhlcO", "dtOhlcH", "dtOhlcL", "dtOhlcC", "dtOhlcChg"]) {
            const el = $(id);
            if (el) el.textContent = id === "dtOhlcTime" ? "--" : id === "dtOhlcChg" ? "--" : id.replace("dtOhlc", "") + " --";
          }
          return;
        }
        const ohlc = QE.chartApi.ohlcOf(candle);
        if (!ohlc) return;
        const chg = QE.chartApi.changeOf(candle, prev || null);
        $("dtOhlcTime").textContent = ohlc.time_text;
        $("dtOhlcO").textContent = "O " + fmt.format(ohlc.open);
        $("dtOhlcH").textContent = "H " + fmt.format(ohlc.high);
        $("dtOhlcL").textContent = "L " + fmt.format(ohlc.low);
        $("dtOhlcC").textContent = "C " + fmt.format(ohlc.close);
        const chgEl = $("dtOhlcChg");
        chgEl.textContent = chg.text + (chg.basis === "open" ? "(对开盘)" : "");
        chgEl.className = "ci-item ci-chg " + (chg.pct == null ? "muted" : chg.pct > 0 ? "green" : chg.pct < 0 ? "red" : "muted");
        $("dtVolValue").textContent = fmtQuote(ohlc.volume);
      }

      function drawDetailChart(klines) {
        // V18:秒级本地聚合模式下标尺与数据源都是本机成交,标准周期K线不得覆盖图表
        if (dtChart.subMs > 0) return;
        setDetailKlines(klines);
      }

      // ---- 手势:Tap / 长按 / Drag 平移 / Pinch 缩放 ----
      function dtChartRect() {
        const canvas = $("dtCanvas");
        return canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 };
      }

      function dtEventPoint(event) {
        const rect = dtChartRect();
        const list = event.touches && event.touches.length ? event.touches : null;
        const t = list ? list[0] : event;
        return {
          x: Number(t.clientX || 0) - rect.left,
          y: Number(t.clientY || 0) - rect.top,
          left: rect.left,
          width: rect.width || 1,
          time: event.timeStamp == null ? Date.now() : event.timeStamp
        };
      }

      function dtIndexAt(x) {
        const rows = dtChart.klines;
        if (!rows.length) return null;
        return QE.chartApi.indexAtX(x, dtChart.vp, dtLayoutOf(dtChartRect().width || 340));
      }

      function dtClearCross() {
        dtChart.cross = null;
        scheduleDetailChart();
      }

      function dtSetCross(index, y) {
        if (index == null) { dtClearCross(); return; }
        const rows = dtChart.klines;
        const clamped = Math.max(0, Math.min(rows.length - 1, index));
        const layout = dtLayoutOf(dtChartRect().width || 340);
        const inChart = y == null || QE.chartApi.inChartArea(y, layout);
        // Tap / 长按未指定纵坐标时,横线落在该K线的收盘价上(专业看盘语义,与信息条一致);
        // 跟随手指时用真实手指 y(且必须落在主图区域内)
        let crossY = inChart && y != null ? y : null;
        if (crossY == null) {
          const candle = rows[clamped];
          const close = candle ? Number(candle[4]) : null;
          const range = dtChart.range;
          crossY = close != null && Number.isFinite(close) && range
            ? QE.chartApi.yOfPrice(close, layout, range.top, range.bottom)
            : layout.chartTop + layout.chartH / 2;
        }
        dtChart.cross = { index: clamped, y: crossY };
        scheduleDetailChart();
      }

      function dtStartLongPress(point) {
        const index = dtIndexAt(point.x);
        dtChart.press = { x: point.x, y: point.y, at: point.time || Date.now(), index, moved: 0, fired: false };
        const timer = setTimeout(() => {
          if (!dtChart.press || dtChart.press.fired) return;
          if (QE.chartApi.isLongPress(Date.now() - dtChart.press.at, dtChart.press.moved, {})) {
            dtChart.press.fired = true;
            dtSetCross(dtChart.press.index, dtChart.press.y);
          }
        }, QE.chartApi.CHART_DEFAULTS.longPressMs + 20);
        dtChart.press.timer = timer;
      }

      function dtCancelPress() {
        if (dtChart.press && dtChart.press.timer) clearTimeout(dtChart.press.timer);
        dtChart.press = null;
      }

      // ---- V16.2s 手势状态机:任一时刻只有一个主状态(idle / pan / pinch / scroll) ----
      // 规则:
      //   · 双指 = pinch(阻止页面滚动,preventDefault 只在这里无条件生效);
      //   · 单指先"待判定",位移超过阈值后按主导方向锁定:横向 → pan(平移K线);纵向 → scroll
      //     (图表让位,页面正常滚动,不再吃事件、不再 preventDefault);
      //   · touchcancel / 离开详情页 → 强制回 idle(绝不留卡住的 press 定时器或半途手势)。
      function dtResetGesture() {
        dtCancelPress();
        dtChart.gesture = null;
      }
      function dtOnTouchCancel() {
        dtResetGesture();
        scheduleDetailChart();
      }

      function dtOnTouchStart(event) {
        const touches = event.touches || [];
        if (touches.length >= 2) {
          event.preventDefault();
          dtCancelPress();
          const rect = dtChartRect();
          dtChart.gesture = {
            mode: "pinch",
            lastDist: QE.chartApi.touchDistance(touches[0], touches[1]),
            lastMid: (Number(touches[0].clientX) + Number(touches[1].clientX)) / 2,
            count: dtChart.vp ? dtChart.vp.count : 90
          };
          return;
        }
        if (!dtChart.klines.length) return;
        const point = dtEventPoint(event);
        dtStartLongPress(point);
        dtChart.gesture = { mode: "pan", lastX: point.x, lastY: point.y, moved: 0, decided: false };
      }

      function dtOnTouchMove(event) {
        const touches = event.touches || [];
        const gesture = dtChart.gesture;
        if (!gesture) return;
        const rect = dtChartRect();
        if (gesture.mode === "pinch" && touches.length >= 2) {
          event.preventDefault();                       // 双指期间禁止页面滚动
          const dist = QE.chartApi.touchDistance(touches[0], touches[1]);
          const mid = (Number(touches[0].clientX) + Number(touches[1].clientX)) / 2;
          const factor = QE.chartApi.pinchFactor(gesture.lastDist, dist);
          if (Math.abs(factor - 1) > 0.002) {
            dtHideMarkPop();
            // V16.2s 锚点坐标修复:zoomViewport 的 anchorRatio 定义在"绘图区"(去掉左右内边距)上,
            // 旧实现用整幅画布宽度算比例 → 锚点与命中测试两套坐标,缩放时时间轴漂移(±5 根级别)。
            const layout = dtLayoutOf(rect.width || 340);
            const pad = QE.chartApi.CHART_DEFAULTS.pad;
            const midRatio = QE.chartApi.touchMidX(touches[0], touches[1], rect.left + pad.left, layout.plotW);
            const zoomed = QE.chartApi.zoomViewport(dtChart.vp, factor, midRatio, dtChart.klines.length, {});
            const panBars = QE.chartApi.dragBarsOf(mid - gesture.lastMid, layout, zoomed.count);
            dtChart.vp = QE.chartApi.panViewport(zoomed, panBars, dtChart.klines.length);
          }
          gesture.lastDist = dist;
          gesture.lastMid = mid;
          scheduleDetailChart();
          return;
        }
        if (gesture.mode === "scroll") return;          // 已让给页面滚动:不吃事件、不 preventDefault
        if (gesture.mode === "pan" && touches.length === 1) {
          const point = dtEventPoint(event);
          const dx = point.x - gesture.lastX;
          const dy = point.y - (gesture.lastY == null ? point.y : gesture.lastY);
          // 方向锁定(只判一次):纵向主导 → 放弃图表手势,页面照常滚动
          if (!gesture.decided) {
            if (Math.abs(dx) + Math.abs(dy) > 10) {
              gesture.decided = true;
              if (Math.abs(dy) > Math.abs(dx) * 1.2) {
                dtCancelPress();
                dtChart.gesture = { mode: "scroll", moved: gesture.moved };
                return;
              }
              gesture.horizontal = true;
            }
          }
          if (gesture.decided && gesture.horizontal) event.preventDefault();   // 横向平移:不让页面跟着动
          gesture.lastX = point.x;
          gesture.lastY = point.y;
          gesture.moved += Math.abs(dx);
          if (gesture.moved > QE.chartApi.CHART_DEFAULTS.longPressMovePx) dtHideMarkPop();
          if (dtChart.press) {
            dtChart.press.moved = Math.max(dtChart.press.moved, Math.abs(point.x - dtChart.press.x) + Math.abs(point.y - dtChart.press.y));
            if (!dtChart.press.fired && dtChart.press.moved > QE.chartApi.CHART_DEFAULTS.longPressMovePx) dtCancelPress();
          }
          if (dtChart.cross && dtChart.press && dtChart.press.fired) {
            // 长按已激活:手指继续移动 → 十字光标跟随(专业看盘习惯)
            dtSetCross(dtIndexAt(point.x), point.y);
            return;
          }
          if (!dtChart.press) {
            const layout = dtLayoutOf(rect.width || 340);
            dtChart.vp = QE.chartApi.panViewport(dtChart.vp, QE.chartApi.dragBarsOf(dx, layout, dtChart.vp.count), dtChart.klines.length);
            scheduleDetailChart();
          }
        }
      }

      function dtOnTouchEnd(event) {
        const gesture = dtChart.gesture;
        const press = dtChart.press;
        const remaining = (event.touches || []).length;
        if (remaining > 0) {
          dtCancelPress();
          const pt = dtEventPoint(event);
          dtChart.gesture = { mode: "pan", lastX: pt.x, lastY: pt.y, moved: gesture ? gesture.moved : 0, decided: false };
          return;
        }
        // 轻点 = 命中交易标记时弹气泡;否则显示/隐藏十字光标(长按 = 保留十字光标)
        // (scroll 让位状态不属于点击,不触发十字光标)
        if (gesture && gesture.mode !== "scroll" && press && !press.fired && (gesture.moved || 0) <= QE.chartApi.CHART_DEFAULTS.longPressMovePx) {
          const index = dtIndexAt(press.x);
          if (!dtTryOpenMarkPop(press.x, press.y)) {
            if (dtChart.cross && dtChart.cross.index === index) dtClearCross();
            else dtSetCross(index, null);
          }
        }
        dtCancelPress();
        dtChart.gesture = null;
      }

      function dtOnWheel(event) {
        if (!dtChart.klines.length) return;
        event.preventDefault();
        dtHideMarkPop();
        const rect = dtChartRect();
        // 向上滚 = 放大(与"双指张开=放大"同口径):根数倍数 <1;
        // 锚点比例同样必须用"绘图区"坐标(与命中测试一致),否则滚轮缩放会漂移时间轴
        const layout = dtLayoutOf(rect.width || 340);
        const pad = QE.chartApi.CHART_DEFAULTS.pad;
        const ratio = (Number(event.clientX) - rect.left - pad.left) / Math.max(1, layout.plotW);
        dtChart.vp = QE.chartApi.zoomViewport(dtChart.vp, event.deltaY < 0 ? 1 / 1.15 : 1.15, ratio, dtChart.klines.length, {});
        scheduleDetailChart();
      }

      function dtOnMouseDown(event) {
        if (!dtChart.klines.length) return;
        const point = dtEventPoint(event);
        dtChart.gesture = { mode: "pan", lastX: point.x, moved: 0 };
        // 桌面临时鼠标:按住拖动平移,单击切换十字光标
        dtChart.press = { x: point.x, y: point.y, at: Date.now(), index: dtIndexAt(point.x), moved: 0, fired: false };
      }

      function dtOnMouseMove(event) {
        if (!dtChart.klines.length) return;
        const point = dtEventPoint(event);
        if (dtChart.gesture && dtChart.gesture.mode === "pan" && event.buttons) {
          const delta = point.x - dtChart.gesture.lastX;
          dtChart.gesture.lastX = point.x;
          dtChart.gesture.moved += Math.abs(delta);
          const layout = dtLayoutOf(dtChartRect().width || 340);
          dtChart.vp = QE.chartApi.panViewport(dtChart.vp, QE.chartApi.dragBarsOf(delta, layout, dtChart.vp.count), dtChart.klines.length);
          scheduleDetailChart();
          return;
        }
        if (!event.buttons && dtChart.cross) dtSetCross(dtIndexAt(point.x), point.y);
      }

      function dtOnMouseUp(event) {
        const press = dtChart.press;
        if (press && press.moved <= QE.chartApi.CHART_DEFAULTS.longPressMovePx) {
          const point = dtEventPoint(event);
          const index = dtIndexAt(point.x);
          if (!dtTryOpenMarkPop(point.x, point.y)) {
            if (dtChart.cross && dtChart.cross.index === index) dtClearCross();
            else dtSetCross(index, point.y);
          }
        }
        dtChart.press = null;
        dtChart.gesture = null;
      }

      function dtOnMouseLeave() {
        dtChart.press = null;
        dtChart.gesture = null;
      }

      function bindDetailChart() {
        const canvas = $("dtCanvas");
        if (!canvas) return;
        // 副图轴键(VOL)挂到画布上:外部工具/自动化可据此识别成交量副图,展示文案仍是中文
        canvas.dataset.volAxis = VOL_AXIS_KEY;
        canvas.addEventListener("touchstart", dtOnTouchStart, { passive: false });
        canvas.addEventListener("touchmove", dtOnTouchMove, { passive: false });
        canvas.addEventListener("touchend", dtOnTouchEnd);
        canvas.addEventListener("touchcancel", dtOnTouchCancel);
        canvas.addEventListener("mousedown", dtOnMouseDown);
        canvas.addEventListener("mousemove", dtOnMouseMove);
        canvas.addEventListener("mouseup", dtOnMouseUp);
        canvas.addEventListener("mouseleave", dtOnMouseLeave);
        canvas.addEventListener("wheel", dtOnWheel, { passive: false });
        const latestBtn = $("dtLatestBtn");
        if (latestBtn) {
          latestBtn.addEventListener("click", () => {
            dtChart.vp = QE.chartApi.latestViewport(dtChart.vp, dtChart.klines.length);
            dtChart.cross = null;
            scheduleDetailChart();
          });
        }
        // V17:交易标记开关(默认开,状态存 localStorage)
        const markBtn = $("dtMarkToggle");
        if (markBtn) {
          markBtn.classList.toggle("on", dtMarkOn);
          markBtn.addEventListener("click", () => {
            dtMarkOn = !dtMarkOn;
            markBtn.classList.toggle("on", dtMarkOn);
            try { localStorage.setItem(DT_MARKS_KEY, dtMarkOn ? "1" : "0"); } catch (error) { /* 隐私模式:忽略 */ }
            dtRenderLegend();
            scheduleDetailChart();
          });
        }
        // V17:全屏(横屏)进入/退出
        const fullBtn = $("dtFullBtn");
        if (fullBtn) fullBtn.addEventListener("click", () => { dtEnterFullscreen(); });
        const exitFsBtn = $("dtExitFsBtn");
        if (exitFsBtn) exitFsBtn.addEventListener("click", () => { dtExitFullscreen(false); });
        // 从后台回到前台:若之前 rAF 被挂起(句柄还在),强制重绘一次,避免空图
        document.addEventListener("visibilitychange", () => {
          if (document.hidden) return;
          if (!dtChart.klines.length) return;
          if (dtChart.raf != null || dtChart.rafFallback != null) return;
          scheduleDetailChart();
        });
        window.addEventListener("resize", () => scheduleDetailChart(), { passive: true });
        // 横竖屏切换:全屏布局与画布尺寸都要重算
        window.addEventListener("orientationchange", () => scheduleDetailChart(), { passive: true });
      }

      // ================= V17 专业K线增强:时间轴 / 全屏 / 交易标记 / 复盘 =================
      // 约定:所有标记数据按 symbol 各自缓存(dtChart.marksSymbol),禁止跨 symbol 串用
      function dtChartHeightOf(card) {
        if (!dtChart.fullscreen) return DT_CHART_HEIGHT;
        const vh = Number(window.innerHeight) || 640;
        const h = (id) => { const el = $(id); if (!el) return 0; const v = Number(el.offsetHeight); return isFinite(v) && v > 0 ? v : 0; };
        const barH = h("dtPeriods");
        const infoH = h("dtOhlcBar");
        let toolsH = 0;
        const fullBtn = $("dtFullBtn");
        const tools = fullBtn ? fullBtn.parentNode : null;
        if (tools) { const v = Number(tools.offsetHeight); if (isFinite(v) && v > 0) toolsH = v; }
        return Math.max(200, Math.round(vh - barH - infoH - toolsH));
      }

      // ---- 时间轴刻度:根据可视窗口跨度自适应间隔(分钟级 HH:MM,日级 MM-DD) ----
      const DT_TICK_STEPS = [60000, 300000, 900000, 1800000, 3600000, 7200000, 14400000, 21600000, 43200000, 86400000, 259200000, 604800000, 2592000000];
      function dtTickStep(minMs) {
        for (const s of DT_TICK_STEPS) if (s >= minMs) return s;
        return DT_TICK_STEPS[DT_TICK_STEPS.length - 1];
      }
      function dtTickLabel(t, stepMs) {
        const d = new Date(Number(t));
        const p2 = (n) => (n < 10 ? "0" : "") + n;
        // 日级及以上用 MM-DD;分钟/小时级用 HH:MM(本地时间,可读)
        if (stepMs >= 86400000) return p2(d.getMonth() + 1) + "-" + p2(d.getDate());
        return p2(d.getHours()) + ":" + p2(d.getMinutes());
      }
      function dtDrawTimeAxis(ctx, rows, view, vp, layout, theme) {
        const count = view.to - view.from;
        if (count < 2) return;
        const t0 = Number(rows[view.from][0]);
        const t1 = Number(rows[view.to - 1][0]);
        if (!(t1 > t0)) return;
        const span = t1 - t0;
        const wanted = Math.max(4, Math.min(6, Math.round(layout.plotW / 74)));
        const stepMs = dtTickStep(span / wanted);
        if (!(stepMs > 0)) return;
        ctx.save();
        ctx.font = "10px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.strokeStyle = theme.grid;
        ctx.fillStyle = theme.muted;
        const yTick = layout.volBottom + 4;
        const yText = Math.min(layout.height - 5, layout.volBottom + 16);
        const first = Math.ceil(t0 / stepMs) * stepMs;
        for (let t = first; t <= t1; t += stepMs) {
          const ratio = (t - t0) / span;
          const idx = view.from + ratio * (count - 1);
          const x = Math.round(QE.chartApi.xOfIndex(idx, vp, layout)) + 0.5;
          if (x < layout.pad.left + 10 || x > layout.pad.left + layout.plotW - 10) continue;
          ctx.beginPath();
          ctx.moveTo(x, layout.volBottom);
          ctx.lineTo(x, yTick);
          ctx.stroke();
          ctx.fillText(dtTickLabel(t, stepMs), x, yText);
        }
        ctx.restore();
      }

      // ---- 交易标记:时间 → candle 索引(找不到就跳过,绝不硬画) ----
      function dtCandleIndexAtTime(rows, t) {
        const n = rows ? rows.length : 0;
        if (!n) return null;
        const tt = Number(t);
        if (!isFinite(tt)) return null;
        const first = Number(rows[0][0]);
        const last = Number(rows[n - 1][0]);
        const interval = n > 1 ? (Number(rows[n - 1][0]) - Number(rows[n - 2][0])) : 0;
        if (tt < first) return null;                        // 早于可见窗口:跳过
        if (tt > last) return (interval > 0 && tt <= last + interval) ? n - 1 : null;
        let lo = 0;
        let hi = n - 1;
        let ans = 0;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (Number(rows[mid][0]) <= tt) { ans = mid; lo = mid + 1; } else hi = mid - 1;
        }
        return ans;
      }
      // V18:退出原因 → 细分标记类别(只做映射,不编造:字段缺失就落到默认类别)
      function dtExitKindOf(tr) {
        const reason = String(tr && tr.exit_reason || "").toUpperCase();
        const source = String(tr && tr.action_source || "").toUpperCase();
        if (reason.indexOf("LIQUIDATION") >= 0 || reason.indexOf("EMERGENCY_CLOSE") >= 0 || reason.indexOf("RISK_EXIT") >= 0) return "risk";
        if (reason.indexOf("STOP_LOSS") >= 0 || reason.indexOf("TRAIL_STOP") >= 0) return "stop";
        if (reason.indexOf("TAKE_PROFIT") >= 0 || reason.indexOf("PROFIT_LOCK") >= 0) return "tp";
        if (reason === "MANUAL" || reason.indexOf("MANUAL_") === 0 || Boolean(tr && tr.manual) || source === "MANUAL") return "manual";
        return "final";
      }
      function dtKindLabel(kind) {
        if (kind === "partial") return "部分平仓";
        if (kind === "final") return "最终平仓";
        if (kind === "stop") return "止损";
        if (kind === "tp") return "止盈";
        if (kind === "risk") return "风险退出";
        if (kind === "manual") return "手动退出";
        if (kind === "add") return "加仓";
        return "开仓";
      }
      // 标记可见性:总开关 + 分组开关(localStorage 持久化)
      function dtMarkVisible(m) {
        if (!dtMarkOn || !m) return false;
        const key = dtMarkKeyOf(m);
        for (const g of DT_MARK_GROUPS) {
          if (g.kinds.indexOf(key) >= 0) return dtMarkFilters[g.key] !== false;
        }
        return true;
      }
      // 保证金口径:优先已冻结的 position_margin(部分平仓),其次 initial_margin,最后 remaining_margin
      function dtMarginOf(t) {
        const chain = [t && t.position_margin, t && t.initial_margin, t && t.remaining_margin, t && t.entry_notional];
        for (const v of chain) { const n = QE.num(v, null); if (n != null && n > 0) return n; }
        return null;
      }
      // Decision ID:只能来自 Decision Journal(有则显示,没有就是 null → UI 显示 --,绝不编造)
      function dtDecisionIdOf(index, kind, at) {
        const t = QE.num(at, null);
        if (t == null || !index || !index.length) return null;
        let best = null;
        let bestGap = Infinity;
        for (const e of index) {
          if (!e || e.kind !== kind || !e.id) continue;
          const gap = Math.abs(QE.num(e.at, 0) - t);
          if (gap <= 300000 && gap < bestGap) { bestGap = gap; best = e; }
        }
        return best ? String(best.id) : null;
      }
      function dtThesisZhOf(rec) {
        const th = rec && rec.entry_thesis;
        const txt = th && th.reason_zh;
        return txt == null || txt === "" ? null : String(txt);
      }
      // 由 trades / positions 构造某 symbol 的标记(加仓无独立事件 → 不伪造)
      function dtBuildMarks(trades, positions, symbol, journal) {
        const out = [];
        const index = Array.isArray(journal) ? journal.filter((e) => e && e.kind) : [];
        const list = (trades || []).filter((t) => t && t.symbol === symbol);
        const groups = new Map();
        for (const t of list) {
          const pid = t.position_id || t.parent_position_id || ("@" + Number(t.entry_time));
          if (!groups.has(pid)) {
            groups.set(pid, {
              entry_time: QE.num(t.entry_time, null),
              entry_price: QE.num(t.entry_price, null),
              side: t.side,
              trades: []
            });
          }
          groups.get(pid).trades.push(t);
        }
        for (const [pid, g] of groups) {
          const first = g.trades[0] || {};
          if (g.entry_time != null && g.entry_price != null && g.entry_price > 0) {
            out.push({
              t: g.entry_time, price: g.entry_price, kind: "entry", side: g.side === "SHORT" ? "short" : "long", pid,
              subtype: "开仓", margin: dtMarginOf(first), leverage: QE.num(first.leverage, null),
              qty: QE.num(first.quantity, null), notional: QE.num(first.notional, null),
              pnl: null, fee: null, reasonRaw: null,
              reasonZh: dtThesisZhOf(first) || dtThesisZhOf((positions || []).find((p) => p && p.position_id === pid)),
              decisionId: dtDecisionIdOf(index, "ENTRY", g.entry_time)
            });
          }
          for (const tr of g.trades) {
            const et = QE.num(tr.exit_time, null);
            const ep = QE.num(tr.exit_price, null);
            if (et == null || ep == null || !(ep > 0)) continue;
            // 形状优先级:部分平仓(生命周期事件)优先于原因;最终平仓再按 止损/止盈/风险/手动 细分
            const partial = tr.partial === true || tr.position_event === true;
            const kind = partial ? "partial" : dtExitKindOf(tr);
            const raw = tr.exit_reason == null ? null : String(tr.exit_reason);
            out.push({
              t: et, price: ep, kind, side: tr.side === "SHORT" ? "short" : "long", pid,
              subtype: dtKindLabel(kind), margin: dtMarginOf(tr), leverage: QE.num(tr.leverage, null),
              qty: QE.num(tr.quantity, null), notional: QE.num(tr.notional, null),
              pnl: QE.num(tr.net_pnl, null), fee: QE.num(tr.fees, null),
              reasonRaw: raw,
              reasonZh: raw ? String(QE.exitBucketOf(raw)) : null,
              decisionId: dtDecisionIdOf(index, partial ? "PARTIAL_CLOSE" : "EXIT", et)
            });
          }
        }
        // 当前仍持仓:Entry 只有 positions 里有(成交记录还没生成)
        const traded = new Set(groups.keys());
        for (const p of (positions || [])) {
          if (!p || p.symbol !== symbol || p.status !== "OPEN") continue;
          if (traded.has(p.position_id)) continue;
          const et = QE.num(p.entry_time, null);
          const ep = QE.num(p.entry_price, null);
          if (et == null || ep == null || !(ep > 0)) continue;
          out.push({
            t: et, price: ep, kind: "entry", side: p.side === "SHORT" ? "short" : "long", pid: p.position_id, open: true,
            subtype: "开仓", margin: dtMarginOf(p), leverage: QE.num(p.leverage, null),
            qty: QE.num(p.initial_quantity, QE.num(p.quantity, null)), notional: QE.num(p.notional, null),
            pnl: null, fee: null, reasonRaw: null, reasonZh: dtThesisZhOf(p),
            decisionId: dtDecisionIdOf(index, "ENTRY", et)
          });
        }
        return out;
      }
      async function dtLoadTradeMarks(eng, symbol) {
        const sym = symbol || viewState.detailSymbol;
        if (!sym) return;
        let marks = [];
        let journal = [];
        try {
          const e = eng || await getPaperEngine();
          const trades = typeof e.getTrades === "function" ? (e.getTrades() || []) : [];
          const positions = typeof e.getPositions === "function" ? (e.getPositions() || []) : [];
          // 复盘/标记气泡的"原因"与 Decision ID 一律来自 Decision Journal
          if (typeof e.journal === "function") journal = e.journal({ symbol: sym, limit: 200 }) || [];
          marks = dtBuildMarks(trades, positions, sym, journal);
        } catch (error) {
          marks = [];
          journal = [];
          diagLog("dt-marks", error);
        }
        dtChart.marks = marks;
        dtChart.marksSymbol = sym;
        dtChart.journal = journal;
        dtRenderLegend();
        dtRenderMarkFilters();
        scheduleDetailChart();
      }
      function dtMarkKeyOf(m) {
        return m.kind === "entry" ? ("entry_" + (m.side === "short" ? "short" : "long")) : m.kind;
      }
      function dtRenderLegend() {
        const box = $("dtMarkLegend");
        if (!box) return;
        const marks = dtChart.marksSymbol === viewState.detailSymbol ? (dtChart.marks || []) : [];
        box.replaceChildren();
        if (!dtMarkOn || !marks.length) { box.classList.add("hidden"); return; }
        const keys = [];
        for (const m of marks) { if (!dtMarkVisible(m)) continue; const k = dtMarkKeyOf(m); if (keys.indexOf(k) < 0) keys.push(k); }
        keys.sort((a, b) => DT_MARK_ORDER.indexOf(a) - DT_MARK_ORDER.indexOf(b));
        for (const k of keys) {
          const lg = vEl("div", "lg");
          lg.appendChild(vEl("span", null, DT_MARK_ZH[k] || k));
          const sw = vEl("span", "sw");
          sw.style.background = DT_MARK_COLOR[k] || "var(--muted)";
          lg.appendChild(sw);
          box.appendChild(lg);
        }
        box.classList.remove("hidden");
      }
      // V18:细分开关(开仓 / 部分平仓 / 平仓 / 止损止盈);只在总开关打开时出现
      function dtRenderMarkFilters() {
        const box = $("dtMarkFilters");
        if (!box) return;
        if (!dtMarkOn) { box.classList.add("hidden"); return; }
        if (box.children.length !== DT_MARK_GROUPS.length) {
          box.replaceChildren();
          for (const g of DT_MARK_GROUPS) {
            const item = vEl("span", "mf");
            const sw = vEl("span", "sw");
            sw.style.background = g.color;
            item.appendChild(sw);
            const btn = vEl("button", "chip" + (dtMarkFilters[g.key] !== false ? " on" : ""), g.zh);
            btn.type = "button";
            btn.dataset.mf = g.key;
            btn.addEventListener("click", () => {
              dtMarkFilters[g.key] = dtMarkFilters[g.key] === false;
              btn.classList.toggle("on", dtMarkFilters[g.key] !== false);
              try { localStorage.setItem(DT_MARK_FILTERS_KEY, JSON.stringify(dtMarkFilters)); } catch (error) { /* 隐私模式:忽略 */ }
              dtHideMarkPop();
              dtRenderLegend();
              scheduleDetailChart();
            });
            item.appendChild(btn);
            box.appendChild(item);
          }
        }
        const buttons = box.querySelectorAll("button");
        for (let i = 0; i < buttons.length; i += 1) {
          const btn = buttons[i];
          const key = btn && btn.dataset ? btn.dataset.mf : null;
          if (key && DT_MARK_GROUPS.some((g) => g.key === key)) btn.classList.toggle("on", dtMarkFilters[key] !== false);
        }
        box.classList.remove("hidden");
      }
      function dtDrawMarkShape(ctx, x, y, m, theme, s) {
        ctx.save();
        ctx.lineWidth = 1.5;
        if (m.kind === "entry") {
          const long = m.side !== "short";
          ctx.fillStyle = long ? theme.up : theme.down;
          ctx.beginPath();
          if (long) { ctx.moveTo(x, y - s); ctx.lineTo(x - s, y + s); ctx.lineTo(x + s, y + s); }
          else { ctx.moveTo(x, y + s); ctx.lineTo(x - s, y - s); ctx.lineTo(x + s, y - s); }
          ctx.closePath();
          ctx.fill();
        } else if (m.kind === "add") {
          ctx.strokeStyle = "#a06bd6";
          ctx.beginPath();
          ctx.moveTo(x, y - s); ctx.lineTo(x, y + s);
          ctx.moveTo(x - s, y); ctx.lineTo(x + s, y);
          ctx.stroke();
        } else if (m.kind === "partial") {
          ctx.strokeStyle = "#d29a3a";
          ctx.beginPath();
          ctx.arc(x, y, Math.max(2, s * 0.8), 0, Math.PI * 2);
          ctx.stroke();
        } else if (m.kind === "final") {
          ctx.fillStyle = "#4a90d9";
          ctx.fillRect(x - s * 0.8, y - s * 0.8, s * 1.6, s * 1.6);
        } else if (m.kind === "stop") {
          ctx.strokeStyle = theme.down;
          ctx.beginPath();
          ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s);
          ctx.moveTo(x + s, y - s); ctx.lineTo(x - s, y + s);
          ctx.stroke();
        } else if (m.kind === "tp") {
          ctx.fillStyle = theme.up;
          ctx.beginPath();
          ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y);
          ctx.closePath();
          ctx.fill();
        } else if (m.kind === "risk") {
          // 风险退出(强平/紧急平仓):红十字 + 外圈,与止损区分
          ctx.strokeStyle = theme.down;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x - s * 0.8, y - s * 0.8); ctx.lineTo(x + s * 0.8, y + s * 0.8);
          ctx.moveTo(x + s * 0.8, y - s * 0.8); ctx.lineTo(x - s * 0.8, y + s * 0.8);
          ctx.stroke();
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x, y, s * 1.3, 0, Math.PI * 2);
          ctx.stroke();
        } else if (m.kind === "manual") {
          // 手动退出:双竖线 + 底横线(人为干预)
          ctx.strokeStyle = "#8b919a";
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(x - s * 0.45, y - s); ctx.lineTo(x - s * 0.45, y + s * 0.55);
          ctx.moveTo(x + s * 0.45, y - s); ctx.lineTo(x + s * 0.45, y + s * 0.55);
          ctx.stroke();
          ctx.fillStyle = "#8b919a";
          ctx.fillRect(x - s, y + s * 0.75, s * 2, 1.6);
        }
        ctx.restore();
      }
      function dtDrawTradeMarks(ctx, rows, vp, layout, rng, theme) {
        if (!dtMarkOn) return;
        // 严格按当前 symbol 取标记:跨 symbol 串用是本项目踩过的 P0 坑
        if (dtChart.marksSymbol !== viewState.detailSymbol) return;
        const marks = dtChart.marks;
        if (!marks || !marks.length) return;
        const step = QE.chartApi.stepOf(layout, vp.count);
        const size = Math.max(3, Math.min(7, step * 0.35));
        const xLo = layout.pad.left - 2;
        const xHi = layout.pad.left + layout.plotW + 2;
        const review = dtChart.review;
        for (const m of marks) {
          if (!dtMarkVisible(m)) continue;
          const idx = dtCandleIndexAtTime(rows, m.t);
          if (idx == null) continue;
          const x = QE.chartApi.xOfIndex(idx, vp, layout);
          if (x < xLo || x > xHi) continue;
          const y = QE.chartApi.yOfPrice(m.price, layout, rng.top, rng.bottom);
          if (!(y >= layout.chartTop - 2 && y <= layout.chartBottom + 2)) continue;
          dtDrawMarkShape(ctx, x, y, m, theme, size);
          if (review && m.pid && m.pid === review.pid && (m.kind === "entry" || m.kind === "partial" || m.kind === "final")) {
            ctx.save();
            ctx.strokeStyle = "#d29a3a";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(x, y, 8, 0, Math.PI * 2);
            ctx.stroke();
            ctx.fillStyle = "#d29a3a";
            ctx.font = "9px system-ui, sans-serif";
            ctx.textAlign = "left";
            ctx.fillText(m.kind === "entry" ? "Entry" : m.kind === "partial" ? "减仓" : "平仓", x + 10, y + 3);
            ctx.restore();
          }
        }
      }

      // ================= V18 实时行情(WebSocket)+ 降级轮询 + 标记气泡 + 收盘倒计时 =================
      // 原则(与 V16 §24 一致):
      //   1) 只认交易所时间戳排序;open_time <= 已知最新 的事件 = BACKFILL_DUPLICATE,绝不能覆盖新数据
      //   2) 每个 tick 只改"最后一根",交给已有 rAF 合并刷新(绝不整屏重绘几百根)
      //   3) 连不上就如实降级到 REST 轮询(绝不假装 WS 成功)
      //   4) 离开详情页 / 换 symbol / 换周期 → close() 并置 null(订阅数不能随进入次数增长)
      //   5) 秒级周期只在"真实成交流可用"时出现;拿不到真实成交就不显示(禁止 Fake Candle)
      const DT_WS_PRIMARY = "wss://fstream.binance.com/ws/";        // 合约 K线流(优先)
      const DT_WS_BACKUP = "wss://stream.binance.com:9443/ws/";     // 现货(备用源常量,改 dtWsSource 即切换)
      const DT_WS_TRADE_AGG = "@aggTrade";
      const DT_WS_TRADE_SPOT = "@trade";
      const DT_WS_OPEN_TIMEOUT_MS = 8000;
      const DT_SUB_PERIODS = [["1s", 1000], ["5s", 5000], ["15s", 15000], ["30s", 30000]];
      let dtWsSource = 0;   // 0 = 合约主源,1 = 现货备用源

      const dtWs = {
        kline: null, trade: null,
        klineSym: null, tradeSym: null,
        key: null,                 // symbol + "|" + interval(当前订阅标识)
        state: "OFF",              // OFF | CONNECTING | LIVE | RECONNECTING | DEGRADED
        reason: "",
        known: {},                 // QE.dedupeCandles 维护的 { open_time: candle }(按 symbol+interval+open_time 去重)
        pendingNext: null,
        lastEventClass: null,
        sched: null, retryTimer: null, openTimer: null, retryKey: null, attempt: 0,
        reconnected: false,
        subCapable: false, subProbed: false, subMs: 0, subMap: null, live: new Set()
      };
      window.__quantWsCount = 0;

      function dtWsCount() {
        window.__quantWsCount = dtWs.live.size;
        return window.__quantWsCount;
      }
      function dtWsCtor() {
        try { if (typeof window.WebSocket === "function") return window.WebSocket; } catch (error) { /* ignore */ }
        try { if (typeof WebSocket === "function") return WebSocket; } catch (error) { /* ignore */ }
        return null;
      }
      function dtWsEndpoint() {
        return dtWsSource === 1
          ? { base: DT_WS_BACKUP, trade: DT_WS_TRADE_SPOT, zh: "现货备用源" }
          : { base: DT_WS_PRIMARY, trade: DT_WS_TRADE_AGG, zh: "合约主源" };
      }
      function dtIntervalMsOf(iv) {
        const key = String(iv || "");
        for (const p of DT_SUB_PERIODS) if (p[0] === key) return p[1];
        return QE.num(QE.INTERVAL_MS && QE.INTERVAL_MS[key], 0) || 3600000;
      }
      function dtIsSubInterval(iv) {
        const key = String(iv || "");
        for (const p of DT_SUB_PERIODS) if (p[0] === key) return true;
        return false;
      }
      function dtLiveNote(text, tone) {
        const el = $("dtLiveNote");
        if (!el) return;
        el.textContent = text;
        el.className = "dt-live" + (tone ? " " + tone : "");
      }
      function dtWsRender() {
        const symText = String(viewState.detailSymbol || "").replace("USDT", "/USDT");
        if (dtWs.state === "LIVE") {
          dtLiveNote("实时推送已连接 · " + symText + " " + String(viewState.detailInterval || "") + (dtChart.subMs > 0 ? " · 秒级本地聚合" : ""), "ok");
          return;
        }
        if (dtWs.state === "RECONNECTING") { dtLiveNote("实时推送断开,正在重连(第 " + dtWs.attempt + " 次" + (dtWs.reason ? " · " + dtWs.reason : "") + ")", "warn"); return; }
        if (dtWs.state === "DEGRADED") { dtLiveNote("实时推送不可用,已降级为轮询" + (dtWs.reason ? "(" + dtWs.reason + ")" : ""), "warn"); return; }
        if (dtWs.state === "CONNECTING") { dtLiveNote("实时行情:连接中…", ""); return; }
        dtLiveNote("实时行情:未订阅" + (dtWs.reason ? "(" + dtWs.reason + ")" : ""), "");
      }
      function dtWsDegrade(reason) {
        dtWs.state = "DEGRADED";
        dtWs.reason = String(reason == null ? "" : reason).slice(0, 40);
        dtWs.attempt = 0;
        dtWsRender();
      }
      function dtWsCloseKline() {
        const ws = dtWs.kline;
        dtWs.kline = null;
        dtWs.klineSym = null;
        if (!ws) return;
        // 先摘掉回调再 close:否则 close 会触发 onclose → 误判为断线 → 又去重连
        try { ws.onopen = null; ws.onmessage = null; ws.onclose = null; ws.onerror = null; } catch (error) { /* ignore */ }
        dtWs.live.delete(ws);
        try { if (typeof ws.close === "function") ws.close(); } catch (error) { /* ignore */ }
        dtWsCount();
      }
      function dtWsCloseTrade() {
        const ws = dtWs.trade;
        dtWs.trade = null;
        dtWs.tradeSym = null;
        if (!ws) return;
        try { ws.onopen = null; ws.onmessage = null; ws.onclose = null; ws.onerror = null; } catch (error) { /* ignore */ }
        dtWs.live.delete(ws);
        try { if (typeof ws.close === "function") ws.close(); } catch (error) { /* ignore */ }
        dtWsCount();
      }
      function dtRowOk(row) {
        if (!row || row.length < 6) return false;
        const o = Number(row[1]);
        const h = Number(row[2]);
        const l = Number(row[3]);
        const c = Number(row[4]);
        return [o, h, l, c].every((v) => Number.isFinite(v)) && c > 0 && h >= l;
      }
      function dtWsOnKlineMessage(raw) {
        if (typeof raw !== "string") return;
        let msg = null;
        try { msg = JSON.parse(raw); } catch (error) { return; }
        const k = msg && (msg.k || (msg.data && msg.data.k));
        if (!k) return;
        // 串 symbol / 串周期一律丢弃。字段缺失时不猜:socket 本身已绑定 symbol+interval(URL),
        // 而旧 socket 的 onmessage 在关闭时已被摘除,所以缺字段不会造成跨 symbol 串用。
        const sym = k.s == null ? null : String(k.s).toUpperCase();
        if (sym != null && sym !== String(viewState.detailSymbol || "").toUpperCase()) return;
        const iv = k.i == null ? null : String(k.i);
        if (iv != null && iv !== String(viewState.detailInterval || "")) return;
        const openTime = QE.num(k.t, null);
        if (openTime == null) return;
        const row = [openTime, Number(k.o), Number(k.h), Number(k.l), Number(k.c), Number(k.v)];
        if (!dtRowOk(row)) return;
        dtWsApplyTick(row, Boolean(k.x));
      }
      // 只动最后一根(k.x === false);收盘(k.x === true)原地 finalize,新的一根等交易所真实下一根
      function dtWsApplyTick(row, closed) {
        if (dtChart.subMs > 0) return;   // 秒级模式下标准周期K线不参与绘图(避免两套数据打架)
        const openTime = Number(row[0]);
        const rows = dtChart.klines;
        const lastIndex = rows.length - 1;
        const lastOpen = lastIndex >= 0 ? Number(rows[lastIndex][0]) : null;
        if (closed) dtWs.pendingNext = openTime + dtIntervalMsOf(viewState.detailInterval);
        // 事件分类:时间戳不前进 = backfill/duplicate,不是"新事件"
        const cls = QE.classifyMarketEvent({ source: "ws", type: closed ? "kline_final" : "kline_tick", candle_time: openTime, last_seen_candle_time: lastOpen });
        dtWs.lastEventClass = cls;
        const trigger = QE.shouldTriggerDecision(cls);   // backfill 恒为 false → 永远不许当新事件
        const res = QE.dedupeCandles(dtWs.known || {}, [{ open_time: openTime, symbol: viewState.detailSymbol, interval: viewState.detailInterval, row }], {});
        dtWs.known = res.map;
        const isLast = lastOpen != null && openTime === lastOpen;
        if (isLast) {
          // 只更新最后一根的 high/low/close/volume(原地替换,不 append、不删历史)
          rows[lastIndex] = row;
          dtChart.lastTickAt = Date.now();
          scheduleDetailChart();
          return;
        }
        if (res.added.length && trigger) {
          const prevTotal = rows.length;
          const wasLatest = !dtChart.vp || QE.chartApi.isAtLatest(dtChart.vp, prevTotal);
          const prevStart = dtChart.vp ? dtChart.vp.start : 0;
          const prevCount = dtChart.vp ? dtChart.vp.count : null;
          rows.push(row);
          const total = rows.length;
          if (!dtChart.vp || prevCount == null) dtChart.vp = QE.chartApi.createViewport(total, {});
          else if (wasLatest) dtChart.vp = QE.chartApi.latestViewport({ total, start: prevStart, count: prevCount }, total);
          else dtChart.vp = QE.chartApi.clampViewport({ total, start: prevStart, count: prevCount }, total);
          if (Array.isArray(viewState.lastKlines)) viewState.lastKlines = viewState.lastKlines.concat([row]);
          scheduleDetailChart();
          return;
        }
        // backfill / duplicate:只允许原地补位(绝不 append、绝不触发任何策略)
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (Number(rows[i][0]) === openTime) { rows[i] = row; scheduleDetailChart(); return; }
        }
      }
      function dtWsOnTradeMessage(raw) {
        if (typeof raw !== "string") return;
        let msg = null;
        try { msg = JSON.parse(raw); } catch (error) { return; }
        const d = msg && msg.data ? msg.data : msg;
        if (!d || (d.e !== "aggTrade" && d.e !== "trade")) return;
        if (String(d.s || "").toUpperCase() !== String(viewState.detailSymbol || "").toUpperCase()) return;
        const price = Number(d.p);
        const at = Number(d.T);
        if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(at)) return;
        if (!dtWs.subCapable) { dtWs.subCapable = true; dtRenderDetailPeriods(); }
        const qty = Number(d.q);
        if (dtChart.subMs > 0) dtSubAddTrade(at, price, Number.isFinite(qty) && qty > 0 ? qty : 0);
        dtUpdateCountdown();
      }
      // 秒级聚合:每个 bucket 的 o/h/l/c/v 全部来自真实成交,无合成K线
      function dtSubAddTrade(at, price, qty) {
        const ms = dtChart.subMs;
        if (!(ms > 0)) return;
        const bucket = Math.floor(at / ms) * ms;
        const map = dtWs.subMap || (dtWs.subMap = {});
        let row = map[bucket];
        if (!row) {
          row = [bucket, price, price, price, price, qty];
          map[bucket] = row;
          // 本地聚合内存上限:最多保留 400 个 bucket(超出丢最旧)
          const keys = Object.keys(map).map(Number).sort((a, b) => a - b);
          while (keys.length > 400) delete map[keys.shift()];
        } else {
          if (price > Number(row[2])) row[2] = price;
          if (price < Number(row[3])) row[3] = price;
          row[4] = price;
          row[5] = Number(row[5]) + qty;
        }
        const rows = dtChart.klines;
        const lastIndex = rows.length - 1;
        if (lastIndex >= 0 && Number(rows[lastIndex][0]) === bucket) {
          rows[lastIndex] = row;                       // 当前未收盘 bucket:只改最后一根
        } else if (lastIndex < 0 || bucket > Number(rows[lastIndex][0])) {
          const prevTotal = rows.length;
          const wasLatest = !dtChart.vp || QE.chartApi.isAtLatest(dtChart.vp, prevTotal);
          const prevStart = dtChart.vp ? dtChart.vp.start : 0;
          const prevCount = dtChart.vp ? dtChart.vp.count : null;
          rows.push(row);
          const total = rows.length;
          if (!dtChart.vp || prevCount == null) dtChart.vp = QE.chartApi.createViewport(total, {});
          else if (wasLatest) dtChart.vp = QE.chartApi.latestViewport({ total, start: prevStart, count: prevCount }, total);
          else dtChart.vp = QE.chartApi.clampViewport({ total, start: prevStart, count: prevCount }, total);
          const emptyEl = $("dtChartEmpty");
          if (emptyEl) emptyEl.classList.add("hidden");
        } else {
          for (let i = rows.length - 1; i >= 0; i -= 1) if (Number(rows[i][0]) === bucket) { rows[i] = row; break; }
        }
        dtChart.lastTickAt = Date.now();
        viewState.lastKlines = rows;
        scheduleDetailChart();
      }
      function dtSubReset(ms) {
        dtChart.subMs = ms;
        dtWs.subMs = ms;
        dtWs.subMap = {};
        dtChart.klines = [];
        dtChart.vp = null;
        dtChart.cross = null;
        dtHideMarkPop();
        const emptyEl = $("dtChartEmpty");
        if (emptyEl) {
          emptyEl.textContent = "秒级 K 线由本机实时聚合(数据全部来自真实成交),正在积累…";
          emptyEl.classList.remove("hidden");
        }
        dtRenderDetailPeriods();
        dtUpdateCountdown();
      }
      function dtWsOpenKline(sym) {
        const Ctor = dtWsCtor();
        if (!Ctor) { dtWsDegrade("浏览器不支持 WebSocket"); return; }
        const ep = dtWsEndpoint();
        const url = ep.base + String(sym).toLowerCase() + "@kline_" + String(viewState.detailInterval || "1h");
        let ws = null;
        try { ws = new Ctor(url); } catch (error) { dtWsDegrade(shortError(error)); return; }
        dtWs.kline = ws;
        dtWs.klineSym = sym;
        dtWs.live.add(ws);
        dtWsCount();
        dtWs.state = "CONNECTING";
        dtWs.reason = "";
        dtWsRender();
        dtWs.openTimer = setTimeout(() => { if (dtWs.kline === ws && dtWs.state === "CONNECTING") dtWsHandleDown(ws, "连接超时"); }, DT_WS_OPEN_TIMEOUT_MS);
        ws.onopen = () => {
          if (dtWs.kline !== ws) return;
          if (dtWs.openTimer != null) { clearTimeout(dtWs.openTimer); dtWs.openTimer = null; }
          dtWs.state = "LIVE";
          dtWs.reason = "";
          dtWs.attempt = 0;
          if (dtWs.sched && dtWs.retryKey) { try { QE.reconnectSuccess(dtWs.sched, dtWs.retryKey); } catch (error) { /* ignore */ } }
          dtWsRender();
          // 重连成功后用 REST 补 gap:补回来的历史只当 backfill,绝不触发决策
          if (dtWs.reconnected) { dtWs.reconnected = false; void refreshDetailKlines(); }
          dtWsProbeTrade(sym);
        };
        ws.onmessage = (ev) => { if (dtWs.kline === ws) dtWsOnKlineMessage(ev && ev.data); };
        ws.onerror = () => { /* 具体原因由 onclose 给出 */ };
        ws.onclose = (ev) => { dtWsHandleDown(ws, "关闭码 " + ((ev && ev.code) == null ? "?" : ev.code)); };
      }
      function dtWsOpenTrade(sym) {
        const Ctor = dtWsCtor();
        if (!Ctor) return;
        const ep = dtWsEndpoint();
        const url = ep.base + String(sym).toLowerCase() + ep.trade;
        let ws = null;
        try { ws = new Ctor(url); } catch (error) { return; }
        dtWs.trade = ws;
        dtWs.tradeSym = sym;
        dtWs.live.add(ws);
        dtWsCount();
        ws.onopen = () => { dtWs.subProbed = true; dtWsRender(); };
        ws.onmessage = (ev) => { if (dtWs.trade === ws) dtWsOnTradeMessage(ev && ev.data); };
        ws.onerror = () => { /* onclose 处理 */ };
        ws.onclose = () => {
          if (dtWs.trade !== ws) return;
          dtWs.trade = null;
          dtWs.tradeSym = null;
          dtWs.live.delete(ws);
          dtWsCount();
          if (dtWs.subCapable) { dtWs.subCapable = false; dtRenderDetailPeriods(); }
          // 秒级模式下成交流就是主数据源 → 走同一条断线退避
          if (dtChart.subMs > 0 && currentPage === "detail") dtWsHandleDown(ws, "成交流关闭");
        };
      }
      // 断线统一入口:清掉 socket → 用引擎确定性退避(指数退避 + 抖动 + 风暴守卫)重连
      function dtWsHandleDown(ws, reason) {
        const isKline = dtWs.kline === ws;
        const isTrade = dtWs.trade === ws;
        if (!isKline && !isTrade) return;
        if (dtWs.openTimer != null) { clearTimeout(dtWs.openTimer); dtWs.openTimer = null; }
        if (isKline) { dtWs.kline = null; dtWs.klineSym = null; }
        if (isTrade) { dtWs.trade = null; dtWs.tradeSym = null; }
        try { ws.onopen = null; ws.onmessage = null; ws.onclose = null; ws.onerror = null; } catch (error) { /* ignore */ }
        dtWs.live.delete(ws);
        dtWsCount();
        if (currentPage !== "detail" || !dtWs.key) {
          dtWs.state = dtWs.live.size ? "LIVE" : "OFF";
          dtWsRender();
          return;
        }
        if (dtWs.retryTimer != null) { clearTimeout(dtWs.retryTimer); dtWs.retryTimer = null; }
        dtWs.retryKey = "ws:" + String(viewState.detailSymbol || "") + ":" + String(viewState.detailInterval || "");
        if (!dtWs.sched) dtWs.sched = QE.createReconnectScheduler({ now: () => Date.now() });
        let next = null;
        try { next = QE.reconnectAttempt(dtWs.sched, dtWs.retryKey); } catch (error) { next = null; }
        if (!next || next.allowed !== true) {
          dtWs.reconnected = false;
          dtWsDegrade(reason + " · 重连已停止(" + ((next && next.reason) || "unknown") + ")");
          return;
        }
        dtWs.attempt = QE.num(next.attempt, 1);
        dtWs.reason = reason;
        dtWs.state = "RECONNECTING";
        dtWs.reconnected = true;
        dtWsRender();
        dtWs.retryTimer = setTimeout(() => {
          dtWs.retryTimer = null;
          if (currentPage !== "detail") return;
          dtWsSync(viewState.detailSymbol, viewState.detailInterval);
        }, Math.max(800, QE.num(next.delay_ms, 1500)));
      }
      // 订阅同步:同一 symbol+周期 复用;不同则先关旧的再开新的
      function dtWsSync(symbol, interval) {
        const sym = symbol || viewState.detailSymbol;
        const iv = interval || viewState.detailInterval;
        if (!sym || !iv) return;
        const key = sym + "|" + iv;
        if (dtWs.key === key && dtWs.kline) { dtWsRender(); return; }
        dtWs.key = key;
        if (!dtWsCtor()) { dtWsDegrade("浏览器不支持 WebSocket"); return; }
        if (dtWs.klineSym && dtWs.klineSym !== sym) dtWsCloseKline();
        if (dtWs.tradeSym && dtWs.tradeSym !== sym) { dtWsCloseTrade(); dtWs.subCapable = false; dtWs.subProbed = false; dtRenderDetailPeriods(); }
        if (dtWs.kline && dtWs.klineSym === sym) { dtWs.attempt = 0; dtWs.state = "LIVE"; dtWs.reason = ""; dtWsRender(); return; }
        dtWsOpenKline(sym);
      }
      function dtWsProbeTrade(sym) {
        if (!dtWsCtor()) return;
        if (dtWs.trade && dtWs.tradeSym === sym) return;
        if (dtWs.subProbed && dtWs.tradeSym === sym) return;
        dtWsCloseTrade();
        dtWsOpenTrade(sym);
      }
      function dtWsClose() {
        if (dtWs.retryTimer != null) { clearTimeout(dtWs.retryTimer); dtWs.retryTimer = null; }
        if (dtWs.openTimer != null) { clearTimeout(dtWs.openTimer); dtWs.openTimer = null; }
        dtWsCloseKline();
        dtWsCloseTrade();
        dtWs.key = null;
        dtWs.known = {};
        dtWs.pendingNext = null;
        dtWs.subCapable = false;
        dtWs.subProbed = false;
        dtWs.subMs = 0;
        dtWs.subMap = {};
        dtWs.reconnected = false;
        dtWs.attempt = 0;
        dtChart.subMs = 0;
        dtWs.state = dtWs.live.size ? "LIVE" : "OFF";
        dtWs.reason = "";
        dtWsCount();
        dtWsRender();
        dtRenderDetailPeriods();
      }
      // 推送正常时不打 REST;连不上/秒级模式之外才轮询兜底
      function dtWsPollTick() {
        if (currentPage !== "detail") return;
        if (dtChart.subMs > 0) return;
        if (dtWs.state === "LIVE") return;
        void refreshDetailKlines();
      }
      function dtRenderDetailPeriods() {
        const box = $("dtPeriods");
        if (!box) return;
        const base = [["15m", "15分"], ["1h", "1时"], ["4h", "4时"], ["1d", "1天"]];
        const list = dtWs.subCapable ? base.concat(DT_SUB_PERIODS.map((p) => [p[0], p[0]])) : base;
        const wants = list.map((p) => p[0]).join(",");
        if (box.__periodSet !== wants) {
          box.__periodSet = wants;
          box.replaceChildren();
          for (const item of list) {
            const value = item[0];
            const btn = vEl("button", "period-btn", item[1]);
            btn.type = "button";
            btn.dataset.value = value;
            const sub = dtIsSubInterval(value);
            btn.addEventListener("click", () => {
              if (sub) {
                dtSubReset(dtIntervalMsOf(value));
                scheduleDetailChart();
              } else {
                viewState.detailInterval = value;
                dtChart.subMs = 0;
                const emptyEl = $("dtChartEmpty");
                if (emptyEl) emptyEl.textContent = "暂无K线";
                dtRenderDetailPeriods();
                void refreshDetail();
              }
            });
            box.appendChild(btn);
          }
        }
        const buttons = box.querySelectorAll(".period-btn");
        for (let i = 0; i < buttons.length; i += 1) {
          const btn = buttons[i];
          const value = btn && btn.dataset ? btn.dataset.value : null;
          if (!value) continue;
          const active = dtIsSubInterval(value) ? (dtChart.subMs > 0 && dtChart.subMs === dtIntervalMsOf(value)) : (dtChart.subMs === 0 && value === viewState.detailInterval);
          btn.classList.toggle("active", active);
        }
      }
      // ---- Current Candle 收盘倒计时(全屏内外都显示) ----
      function dtCountdownText() {
        const ms = dtChart.subMs > 0 ? dtChart.subMs : dtIntervalMsOf(viewState.detailInterval);
        if (!(ms > 0)) return "--";
        const now = Date.now();
        let left = ms - (now % ms);
        if (!(left > 0) || left > ms) left = ms;
        const total = Math.ceil(left / 1000);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total - h * 3600) / 60);
        const s = total - h * 3600 - m * 60;
        const p2 = (n) => (n < 10 ? "0" : "") + n;
        return (h > 0 ? p2(h) + ":" + p2(m) + ":" + p2(s) : p2(m) + ":" + p2(s)) + " 后收盘";
      }
      function dtUpdateCountdown() {
        if (currentPage !== "detail") return;
        const el = $("dtCloseCount");
        if (!el) return;
        const text = dtCountdownText();
        if (el.textContent !== text) el.textContent = text;
      }
      // ---- 交易标记气泡:点击标记 → 显示真实字段(缺字段显示 --,绝不编造) ----
      function dtCardRect() {
        const card = $("dtChartCard");
        return card ? card.getBoundingClientRect() : dtChartRect();
      }
      function dtMarkHitAt(px, py) {
        if (!dtMarkOn) return null;
        if (dtChart.marksSymbol !== viewState.detailSymbol) return null;
        const marks = dtChart.marks || [];
        const rows = dtChart.klines;
        if (!marks.length || !rows.length || !dtChart.vp || !dtChart.range) return null;
        const layout = dtLayoutOf(dtChartRect().width || 340);
        const rng = dtChart.range;
        const step = QE.chartApi.stepOf(layout, dtChart.vp.count);
        const tol = Math.max(12, Math.min(7, step * 0.35) + 9);
        let best = null;
        for (const m of marks) {
          if (!dtMarkVisible(m)) continue;
          const idx = dtCandleIndexAtTime(rows, m.t);
          if (idx == null) continue;
          const mx = QE.chartApi.xOfIndex(idx, dtChart.vp, layout);
          const my = QE.chartApi.yOfPrice(m.price, layout, rng.top, rng.bottom);
          const dx = Math.abs(mx - px);
          const dy = Math.abs(my - py);
          if (dx <= tol && dy <= tol) {
            const d = dx + dy * 0.6;
            if (!best || d < best.d) best = { mark: m, x: mx, y: my, d };
          }
        }
        return best;
      }
      function dtMarkRow(box, key, value) {
        const row = vEl("div", "mp-row");
        row.appendChild(vEl("span", "k", key));
        row.appendChild(vEl("span", "v", value == null || value === "" ? "--" : String(value)));
        box.appendChild(row);
      }
      function dtHideMarkPop() {
        if (!dtChart.popMark) return;
        dtChart.popMark = null;
        const box = $("dtMarkPop");
        if (box) box.classList.add("hidden");
        updateBackTrap();
      }
      function dtShowMarkPop(mark, px, py) {
        const box = $("dtMarkPop");
        if (!box || !mark) return;
        box.replaceChildren();
        const head = vEl("div", "mp-head");
        head.appendChild(vEl("div", "mp-title", DT_MARK_ZH[dtMarkKeyOf(mark)] || "交易标记"));
        const close = vEl("button", "mp-close", "×");
        close.type = "button";
        close.addEventListener("click", () => dtHideMarkPop());
        head.appendChild(close);
        box.appendChild(head);
        const isEntry = mark.kind === "entry";
        const dirText = mark.side === "short" ? (isEntry ? "做空(开仓)" : "空头平仓") : (isEntry ? "做多(开仓)" : "多头平仓");
        dtMarkRow(box, "类型", mark.subtype || dtKindLabel(mark.kind));
        dtMarkRow(box, "时间", new Date(QE.num(mark.t, 0)).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }));
        dtMarkRow(box, "价格", mark.price == null ? null : fmt.format(mark.price));
        dtMarkRow(box, "方向", dirText);
        dtMarkRow(box, "保证金", mark.margin == null ? null : fmt.format(mark.margin) + " USDT");
        dtMarkRow(box, "杠杆", mark.leverage == null ? null : mark.leverage + "x");
        dtMarkRow(box, "Position Size", mark.qty == null ? null : (fmt.format(mark.qty) + (mark.notional == null ? "" : " · " + fmt.format(mark.notional) + " USDT")));
        dtMarkRow(box, "PnL", mark.pnl == null ? null : (QE.fmtUsdtExact ? QE.fmtUsdtExact(mark.pnl) : String(mark.pnl)));
        dtMarkRow(box, "Fee", mark.fee == null ? null : (QE.fmtUsdtExact ? QE.fmtUsdtExact(mark.fee) : String(mark.fee)));
        dtMarkRow(box, "原因", mark.reasonZh ? (mark.reasonZh + (mark.reasonRaw ? "(" + mark.reasonRaw + ")" : "")) : null);
        dtMarkRow(box, "Decision ID", mark.decisionId || null);
        box.classList.remove("hidden");
        const cRect = dtChartRect();
        const kRect = dtCardRect();
        const baseX = QE.num(cRect.left, 0) - QE.num(kRect.left, 0) + QE.num(px, 0);
        const baseY = QE.num(cRect.top, 0) - QE.num(kRect.top, 0) + QE.num(py, 0);
        const w = QE.num(box.offsetWidth, 0) || 200;
        const h = QE.num(box.offsetHeight, 0) || 168;
        const cardW = QE.num(kRect.width, 0) || 320;
        const cardH = QE.num(kRect.height, 0) || 268;
        let left = baseX + 12;
        let top = baseY + 12;
        if (left + w > cardW - 4) left = baseX - w - 12;
        if (top + h > cardH - 4) top = cardH - h - 6;
        box.style.left = Math.round(Math.max(4, Math.min(left, Math.max(4, cardW - w - 4)))) + "px";
        box.style.top = Math.round(Math.max(4, Math.min(top, Math.max(4, cardH - h - 4)))) + "px";
        dtChart.popMark = mark;
        updateBackTrap();
      }
      function dtTryOpenMarkPop(px, py) {
        const hit = dtMarkHitAt(px, py);
        if (!hit) { dtHideMarkPop(); return false; }
        dtShowMarkPop(hit.mark, hit.x, hit.y);
        return true;
      }

      // ---- 全屏(横屏):容器撑满视口,布局重排后重绘;不重启引擎、不动周期与缩放 ----
      function dtEnterFullscreen() {
        if (dtChart.fullscreen) return;
        const card = $("dtChartCard");
        if (!card) return;
        dtChart.fullscreen = true;
        const periods = $("dtPeriods");
        dtChart.fsHome = periods ? { parent: periods.parentNode, next: periods.nextSibling } : null;
        card.classList.add("dt-fs");
        if (document.body) document.body.classList.add("dt-fs-open");
        // 周期切换进入全屏顶部(移动同一个节点,保留原有事件绑定)
        if (periods) { if (card.firstChild) card.insertBefore(periods, card.firstChild); else card.appendChild(periods); }
        const exitBtn = $("dtExitFsBtn");
        if (exitBtn) exitBtn.classList.remove("hidden");
        const fullBtn = $("dtFullBtn");
        if (fullBtn) fullBtn.classList.add("hidden");
        // 全屏下 symbol 名称原本在卡片外(会看不见)→ 追加到提示行,退出时还原
        const hint = $("dtChartHint");
        if (hint && dtChart.hintHome == null) dtChart.hintHome = String(hint.textContent || "");
        if (hint) hint.textContent = String(viewState.detailSymbol || "").replace("USDT", "/USDT") + " · " + (dtChart.hintHome || "");
        // 横屏锁定:桌面/不支持/被浏览器拒绝时静默失败,绝不报错
        try {
          if (window.screen && window.screen.orientation && typeof window.screen.orientation.lock === "function") {
            const p = window.screen.orientation.lock("landscape");
            if (p && typeof p.catch === "function") p.catch(() => {});
          }
        } catch (error) { /* ignore */ }
        // V16.2:全屏的返回拦截统一交给导航哨兵(不再自己 push history,避免多套机制互相打架)
        dtChart.fsPushed = false;
        updateBackTrap();
        dtChart.cross = null;
        scheduleDetailChart();
        // 布局稳定后再按真实尺寸重算一次(canvas 高度 = 视口高 - 顶部信息条)
        const raf = window.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
        try { raf(() => scheduleDetailChart()); } catch (error) { /* ignore */ }
      }
      function dtExitFullscreen(fromPop) {
        if (!dtChart.fullscreen) return;
        dtChart.fullscreen = false;
        const card = $("dtChartCard");
        if (card) card.classList.remove("dt-fs");
        if (document.body) document.body.classList.remove("dt-fs-open");
        const periods = $("dtPeriods");
        if (periods) {
          const home = dtChart.fsHome;
          let placed = false;
          if (home && home.parent) { try { home.parent.insertBefore(periods, home.next); placed = true; } catch (error) { placed = false; } }
          if (!placed && card && card.parentNode) { try { card.parentNode.insertBefore(periods, card); } catch (error) { /* ignore */ } }
        }
        const exitBtn = $("dtExitFsBtn");
        if (exitBtn) exitBtn.classList.add("hidden");
        const fullBtn = $("dtFullBtn");
        if (fullBtn) fullBtn.classList.remove("hidden");
        const hint = $("dtChartHint");
        if (hint && dtChart.hintHome != null) hint.textContent = dtChart.hintHome;
        try {
          if (window.screen && window.screen.orientation && typeof window.screen.orientation.unlock === "function") window.screen.orientation.unlock();
        } catch (error) { /* ignore */ }
        // V16.2:统一由导航哨兵维护返回历史(旧实现自己 push/back,与其它状态互相打架)
        dtChart.fsPushed = false;
        updateBackTrap();
        scheduleDetailChart();
      }

      // ---- 复盘:点历史仓位 → K线定位到 Entry 前后,并标出 Entry / 减仓 / 平仓 ----
      function dtApplyReviewViewport() {
        const rv = viewState.review;
        if (!rv || !dtChart.klines.length || rv.entryTime == null) return;
        const idx = dtCandleIndexAtTime(dtChart.klines, rv.entryTime);
        if (idx == null) { dtChart.review = null; return; }
        const total = dtChart.klines.length;
        const count = dtChart.vp ? dtChart.vp.count : QE.chartApi.CHART_DEFAULTS.defaultBars;
        // Entry 前留出约 1/3 屏幕
        const start = Math.max(0, Math.round(idx - count / 3));
        dtChart.vp = QE.chartApi.clampViewport({ total, start, count }, total);
        dtChart.review = { pid: rv.pid, entryTime: rv.entryTime };
        dtChart.cross = null;
        scheduleDetailChart();
      }
      function exitReview() {
        viewState.review = null;
        dtChart.review = null;
        renderReviewBlock();
        scheduleDetailChart();
      }
      async function openReview(symbol, tradeId) {
        try {
          const eng = await getPaperEngine();
          const all = eng.getTrades() || [];
          const anchor = all.find((t) => t && t.trade_id === tradeId) || null;
          if (!anchor) { toast("找不到该笔成交", "error"); return; }
          const sym = anchor.symbol || symbol;
          const pid = anchor.position_id || anchor.parent_position_id || null;
          const group = all.filter((t) => t && t.symbol === sym && (pid ? (t.position_id || t.parent_position_id) === pid : t.trade_id === tradeId));
          const interval = (anchor.mode === "long") ? "4h" : "1h";
          // openDetail 会清空旧复盘状态,所以定位信息在它返回后再写入
          await openDetail(sym, interval);
          viewState.review = {
            symbol: sym,
            pid,
            tradeId,
            entryTime: QE.num(anchor.entry_time, null),
            group: group.slice(),
            journalWhy: (typeof eng.journalWhy === "function" ? String(eng.journalWhy(sym) || "") : ""),
            journal: (typeof eng.journal === "function" ? (eng.journal({ symbol: sym, limit: 200 }) || []) : [])
          };
          dtApplyReviewViewport();
          renderReviewBlock();
        } catch (error) {
          diagLog("review", error);
          toast("复盘打开失败", "error");
        }
      }
      function renderReviewBlock() {
        const box = $("dtReview");
        if (!box) return;
        const rv = viewState.review;
        if (!rv) { box.replaceChildren(); box.classList.add("hidden"); return; }
        box.classList.remove("hidden");
        box.replaceChildren();
        const group = rv.group || [];
        const head = vEl("div", "setting-row");
        const left = vEl("div");
        left.appendChild(vEl("div", "coin-name", "复盘 · " + String(rv.symbol || "").replace("USDT", "/USDT")));
        left.appendChild(vEl("div", "coin-sub", "K线已定位到 Entry 前约 1/3 处 · 标出 Entry / 减仓 / 平仓"));
        head.appendChild(left);
        const exitBtn = vEl("button", "v-close", "退出复盘");
        exitBtn.type = "button";
        exitBtn.addEventListener("click", () => { exitReview(); });
        head.appendChild(exitBtn);
        box.appendChild(head);
        // V18:复盘理由必须可追溯 —— 只允许来自 Decision Journal / 冻结的 entry_thesis.reason_zh / 成交 exit_reason
        // 没有日志就如实写"暂无决策记录",禁止现场编造"可能因为…"
        const NO_JOURNAL = "暂无决策记录";
        const journalRows = (rv.journal || []).filter((e) => e && e.kind);
        const whyOf = (kinds) => {
          const hit = journalRows.filter((e) => kinds.indexOf(e.kind) >= 0 && e.why);
          return hit.length ? String(hit[0].why) : "";
        };
        const exitZhOf = (raw) => (raw ? QE.exitBucketOf(raw) + "(" + raw + ")" : "");
        const uniq = (arr) => arr.filter((v, i) => v && arr.indexOf(v) === i);
        // 为什么开:优先建仓时冻结的论点(entry_thesis.reason_zh),其次 Decision Journal 的 ENTRY
        let whyOpen = "";
        for (const t of group) {
          if (t && t.entry_thesis && t.entry_thesis.reason_zh) { whyOpen = String(t.entry_thesis.reason_zh); break; }
        }
        if (!whyOpen) whyOpen = whyOf(["ENTRY"]);
        if (!whyOpen && journalRows.length && typeof rv.journalWhy === "string") whyOpen = rv.journalWhy;
        // 为什么持有:持仓期间真实发生过的动作(STOP_RAISE / LEVERAGE / RISK)
        const whyHold = uniq([whyOf(["STOP_RAISE", "LEVERAGE", "RISK"])]);
        // 为什么减 / 为什么平:Journal 理由 + 成交记录 exit_reason 中文化(不猜)
        const isPartialTrade = (t) => Boolean(t && (t.partial === true || t.position_event === true));
        const whyCut = uniq([whyOf(["PARTIAL_CLOSE"])].concat(group.filter(isPartialTrade).map((t) => exitZhOf(t && t.exit_reason))));
        const whyExit = uniq([whyOf(["EXIT", "RISK"])].concat(group.filter((t) => !isPartialTrade(t)).map((t) => exitZhOf(t && t.exit_reason))));
        const stages = [];
        for (const t of group) {
          const raw = String(t && t.exit_reason || "");
          if (raw.indexOf("stage") >= 0 || raw.toUpperCase().indexOf("PROFIT_LOCK") >= 0) stages.push(raw);
        }
        for (const e of journalRows) {
          if (e && (e.kind === "PARTIAL_CLOSE" || e.kind === "EXIT") && e.final && e.final.exit_reason && String(e.final.exit_reason).indexOf("stage") >= 0) stages.push(String(e.final.exit_reason));
        }
        const pnl = group.reduce((a, t) => a + QE.num(t && t.net_pnl, 0), 0);
        const fees = group.reduce((a, t) => a + QE.num(t && t.fees, 0), 0);
        let holdMs = null;
        for (const t of group) { const h = QE.num(t && t.holding_ms, null); if (h != null && (holdMs == null || h > holdMs)) holdMs = h; }
        const first = group[0] || {};
        const levSource = first.leverage_source == null ? "--" : String(first.leverage_source);
        const lev = QE.num(first.leverage, null);
        const grid = vEl("div", "rv-grid");
        const row = (k, v) => { grid.appendChild(vEl("span", "k", k)); grid.appendChild(vEl("span", null, v)); };
        row("为什么开", whyOpen || NO_JOURNAL);
        row("为什么持有", whyHold.length ? whyHold.join(" · ") : NO_JOURNAL);
        row("为什么减", whyCut.length ? whyCut.join(" · ") : NO_JOURNAL);
        row("为什么平", whyExit.length ? whyExit.join(" · ") : NO_JOURNAL);
        row("Profit Lock 阶段", stages.length ? stages.join(" · ") : "--");
        row("总 PnL", QE.fmtUsdtExact ? QE.fmtUsdtExact(pnl) : String(pnl));
        row("费用", QE.num(fees, 0).toFixed(4) + " USDT");
        row("持有时间", holdMs == null ? "--" : QE.fmtHold(holdMs));
        row("杠杆来源", levSource + (lev == null ? "" : " · " + lev + "x"));
        box.appendChild(grid);
        if (!group.length) box.appendChild(vEl("div", "v-note", "没有找到该仓位的成交明细(可能已过保留期)。"));
        // 该 symbol 的决策日志(虚拟化,条目多时只渲染视口附近)
        const jlist = (rv.journal || []).slice();
        if (jlist.length) {
          box.appendChild(vEl("div", "coin-name", "决策日志(" + jlist.length + " 条)"));
          const jbox = vEl("div", "rv-journal");
          box.appendChild(jbox);
          vVirtualize(jbox, jlist, (e) => {
            const el = vEl("div", "ntf-item");
            const meta = vEl("div", "ntf-meta");
            meta.appendChild(vEl("span", null, (e.kind || "--") + " · " + new Date(QE.num(e.at, 0)).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })));
            meta.appendChild(vEl("span", null, e.final && e.final.exit_reason ? String(e.final.exit_reason) : ""));
            el.appendChild(meta);
            el.appendChild(vEl("div", "ntf-title", e.why ? String(e.why) : (e.evidence && e.evidence.length ? e.evidence.join(" · ") : "--")));
            return el;
          }, { threshold: 60, rowHeight: 60 });
        }
      }
      // ================= V17 长列表虚拟化(窗口切片) =================
      // 条目少(≤ threshold)时按原样全量渲染(降级);多时只渲染屏幕附近,滚动流畅。
      // 不改排序与数据口径:只按原顺序切片。
      function vVirtualize(root, rows, renderRow, opts) {
        if (!root) return;
        const o = opts || {};
        const threshold = o.threshold == null ? 200 : o.threshold;
        const rowH = o.rowHeight || 64;
        const list = rows || [];
        root.replaceChildren();
        if (list.length <= threshold) {
          for (let i = 0; i < list.length; i += 1) root.appendChild(renderRow(list[i], i));
          root.classList.remove("v-scroll");
          root.style.maxHeight = "";
          root.__vRender = null;
          return;
        }
        if (!root.__vBound) {
          root.__vBound = true;
          root.addEventListener("scroll", () => { if (root.__vRender) root.__vRender(); }, { passive: true });
        }
        root.classList.add("v-scroll");
        root.style.maxHeight = o.maxHeight || "70vh";
        const spacer = vEl("div", "v-virtual-spacer");
        spacer.style.height = (list.length * rowH) + "px";
        const layer = vEl("div", "v-virtual-layer");
        spacer.appendChild(layer);
        root.appendChild(spacer);
        const render = () => {
          const vh = Number(root.clientHeight) || Number(window.innerHeight) || 480;
          const top = Number(root.scrollTop) || 0;
          const overscan = 6;
          const start = Math.max(0, Math.floor(top / rowH) - overscan);
          const end = Math.min(list.length, Math.ceil((top + vh) / rowH) + overscan);
          if (start === render.__start && end === render.__end) return;
          render.__start = start;
          render.__end = end;
          layer.style.transform = "translateY(" + (start * rowH) + "px)";
          layer.replaceChildren();
          for (let i = start; i < end; i += 1) layer.appendChild(renderRow(list[i], i));
        };
        root.__vRender = render;
        render();
      }

      // ---- §40-§47:DeepSeek 关键 Decision Review(结构化摘要 + Schema 校验 + 失败回退本地) ----
      // 只发送摘要(§43),绝不发送K线;Risk 仍是最终权限(§45);无 Key/超时/429/500/非法JSON 一律回退(§46)
      function buildReviewContext(input) {
        const i = input || {};
        const a = i.analysis || {};
        const c = i.candidate || {};
        const pos = i.position || null;
        const pred = i.prediction && i.prediction.predictions ? (i.prediction.predictions[i.horizon || "1h"] || i.prediction.predictions["1h"]) : i.prediction;
        const ext = i.external || viewState.lastExternal || null;
        const dd = viewState.lastDrawdown || null;
        const pl = i.profit_lock || null;
        return {
          decision_type: i.kind || "entry",
          review_reasons: i.reasons || [],
          symbol: i.symbol,
          interval: i.horizon || (i.mode === "long" ? "4h" : "1h"),
          mode: i.mode,
          price: a.price,
          direction: a.direction,
          confidence: a.confidence,
          regime: a.market_regime ? a.market_regime.label : null,
          risk_level: i.risk ? i.risk.risk_level : null,
          risk_score: i.risk ? i.risk.risk_score : null,
          position: pos ? {
            mode: pos.mode,
            side: pos.side,
            entry_price: pos.entry_price,
            current_price: pos.current_price,
            leverage: pos.leverage,
            margin: pos.entry_notional,
            notional: pos.notional,
            liquidation_price: pos.liquidation_price,
            unrealized_pnl: pos.unrealized_pnl,
            realized_pnl: pos.realized_pnl,
            holding_ms: Math.max(0, Date.now() - QE.num(pos.entry_time, Date.now())),
            pnl_pct: QE.num(pos.entry_notional, 0) > 0 ? QE.round(QE.num(pos.unrealized_pnl, 0) / QE.num(pos.entry_notional, 1) * 100, 4) : null
          } : null,
          prediction: pred ? {
            horizon: pred.horizon || i.horizon || "1h",
            bullish_probability: pred.bullish_probability,
            neutral_probability: pred.neutral_probability,
            bearish_probability: pred.bearish_probability,
            expected_move_pct: pred.expected_move_pct,
            expected_range_pct: pred.expected_range_pct,
            reversal_risk: pred.reversal_risk,
            confidence: pred.confidence,
            uncertainty: pred.uncertainty
          } : null,
          profit_lock: pl,
          drawdown: dd ? { state: dd.state, account_pct: QE.num(String(dd.account_dd_text || "0").replace("%", ""), 0), daily_pct: QE.num(String(dd.daily_dd_text || "0").replace("%", ""), 0) } : null,
          external: ext ? {
            funding_rate: ext.funding_context && ext.funding_context.available ? ext.funding_context.rate : null,
            funding_extreme: Boolean(ext.funding_context && ext.funding_context.extreme),
            oi_interpretation: ext.oi_context ? ext.oi_context.interpretation : null,
            long_short_ratio: ext.positioning_context && ext.positioning_context.available ? ext.positioning_context.long_short_ratio : null,
            taker_imbalance: ext.taker_context && ext.taker_context.available ? ext.taker_context.imbalance : null,
            stress_level: ext.market_stress_context ? ext.market_stress_context.level : null,
            news_sentiment: ext.news_context && ext.news_context.available ? ext.news_context.sentiment : null,
            news_conflicted: Boolean(ext.news_context && ext.news_context.conflicted),
            news_summary: ext.news_context && ext.news_context.available && ext.news_context.items && ext.news_context.items[0] ? String(ext.news_context.items[0].title || "").slice(0, 200) : null,
            unavailable: (ext.overall && ext.overall.unavailable ? ext.overall.unavailable : []).map((u) => u.type)
          } : null
        };
      }

      async function deepseekReviewProvider(input) {
        const req = RM.begin("paper");
        const res = await api("ai/review", 1, 14000, req.signal, { context: buildReviewContext(input) });
        if (res && res.ok && res.review) return { ok: true, review: res.review };
        return { ok: false, reason: (res && res.reason) || "no_result" };
      }

      // §50:AI Chat 只返回一个最终回答(远程成功 → 远程;否则 → 本地)
      // V15 Decision Journal:把"为什么开/为什么平/为什么提止损"一并喂给回答链路,
      // 于是"刚才为什么卖 BTC"能直接答出来(远程不可用时本地也能答)。
      async function chatSingleAnswer(question, context) {
        // 注意:本函数不再访问引擎/不读页面状态 —— 上下文由调用方一次性注入,
        // 于是关闭界面就真的"什么都不再发生"(没有后台 token 消耗)。
        const local = QE.answerLocally(question, context);
        try {
          const req = RM.begin("chat");
          const remote = await api("ai/review", 1, 20000, req.signal, { question, context });
          // 关闭界面会抬高 generation / abort → 这里直接返回,不再消费响应
          if (!RM.isCurrent("chat", req.generation)) return { text: local, source: "local", stale: true, aborted: true };
          if (remote && remote.ok && remote.text) return { text: remote.text, source: "deepseek", tokens: remote.tokens || 0 };
          return { text: local, source: "local", reason: (remote && remote.reason) || "fallback" };
        } catch (error) {
          diagLog("chat-ai", error);
          return { text: local, source: "local", reason: isAborted(error) ? "aborted" : "error" };
        }
      }

      // ---- 后台 worker:即使只停在首页/模拟/我的,也必须自己更新(§17/§73/§100) ----
      let bgDataTimer = null;
      let researchTimer = null;

      // V15 Background Task Manager:后台任务统一登记(状态 / 上次运行 / 错误 / 重试 / 退避)
      // 定时器仍留在页面(便于按页面生命周期控制),但"跑什么、跑成没跑成"统一由 taskBag 记账。
      async function runMarketIntelTask() {
        const eng = await getPaperEngine();
        const req = RM.begin("bgdata");
        await refreshExternalForSymbols(eng, candidateSymbols(), req.signal);
        const analyses = {};
        for (const symbol of candidateSymbols().slice(0, 3)) {
          const a = viewState.lastAnalysesBySymbol[symbol];
          if (a) analyses[symbol] = a;
        }
        if (Object.keys(analyses).length) await refreshPredictions(eng, analyses);
        await eng.updateDrawdown({ now: Date.now() });
        const dq = eng.dataQuality();
        if (dq && dq.block_entries) diagLog("data-quality", dq.recent_issues && dq.recent_issues[0]);
      }

      async function runResearchTask() {
        const eng = await getPaperEngine();
        await refreshResearch(eng, {});
      }

      async function runRetentionTask() {
        return runRetention();
      }

      function initTaskBag() {
        if (taskBag) return taskBag;
        taskBag = QE.createTaskManager({ now: () => Date.now(), onEvent: () => {} });
        taskBag.register("paper-loop", { intervalMs: 300000, critical: true, run: () => paperLoopTick() });
        taskBag.register("position-risk", { intervalMs: 20000, critical: true, run: () => refreshPositionRisk() });
        taskBag.register("market-intel", { intervalMs: BG_DATA_INTERVAL_MS, critical: true, run: runMarketIntelTask });
        taskBag.register("research", { intervalMs: RESEARCH_INTERVAL_MS, run: runResearchTask });
        taskBag.register("retention", { intervalMs: 600000, run: runRetentionTask });
        taskBag.register("ui-render", { intervalMs: 8000, run: async () => { await renderHome(); } });
        return taskBag;
      }

      function startBackgroundWorkers() {
        initTaskBag();
        if (bgDataTimer) clearInterval(bgDataTimer);
        bgDataTimer = setInterval(() => {
          void taskBag.runOnce("market-intel");
        }, BG_DATA_INTERVAL_MS);
        if (researchTimer) clearInterval(researchTimer);
        researchTimer = setInterval(() => {
          void taskBag.runOnce("research");
        }, RESEARCH_INTERVAL_MS);
      }

      function backgroundWorkerStats() {
        return {
          bg_data_timer: Boolean(bgDataTimer),
          research_timer: Boolean(researchTimer),
          research: researchAgent.stats(),
          hub: externalHub.stats(),
          resolved_predictions: viewState.resolvedPredictions || 0
        };
      }

      // ================= V15:通知中心 / 手动平仓 / 暂停开仓 / 紧急全平 / 重置 / 导出 =================
      const ntfSettings = (() => {
        try { return JSON.parse(localStorage.getItem("ntfSettings") || "{}"); } catch (error) { return {}; }
      })();
      const NTF_TYPES = [
        { id: "TRADE", label: "开仓提醒", key: "ntfSetTrade" },
        { id: "CLOSE", label: "平仓提醒", key: "ntfSetClose" },
        { id: "RISK", label: "风险提醒", key: "ntfSetRisk" },
        { id: "SYSTEM", label: "系统提醒", key: "ntfSetSystem" },
        { id: "RESEARCH", label: "重大消息", key: "ntfSetNews" },
        { id: "LEARNING", label: "模型更新", key: "ntfSetModel" }
      ];
      function ntfEnabled(kind) {
        const v = ntfSettings[kind];
        if (v === undefined) return kind === "TRADE" || kind === "RISK" || kind === "SYSTEM" || kind === "RESEARCH";
        return v === true;
      }
      function saveNtfSettings() { localStorage.setItem("ntfSettings", JSON.stringify(ntfSettings)); }

      function toast(text, kind) {
        const box = $("toastBox");
        if (!box) return;
        const el = vEl("div", "toast" + (kind === "error" ? " error" : ""), text);
        box.appendChild(el);
        setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 2600);
      }

      // §36:Android 系统通知(通过 MainActivity 注入的 QuantNative 桥);Web 端为 no-op
      function nativeNotify(item) {
        try {
          if (!item) return;
          if (!ntfEnabled(String(item.kind).toUpperCase() === "TRADE" && /平仓|已模拟平仓|强平/.test(String(item.title)) ? "CLOSE" : String(item.kind).toUpperCase())) return;
          if (window.QuantNative && typeof window.QuantNative.notify === "function") {
            window.QuantNative.notify(String(item.kind || "SYSTEM"), String(item.title || ""), String(item.body || ""));
          }
        } catch (error) { /* 通知失败不影响主流程 */ }
      }

      function initNativeBridge() {
        try {
          const native = Boolean(window.QuantNative && window.QuantNative.isNativeShell && window.QuantNative.isNativeShell());
          window.__quantNativeShell = native;
          if (native) {
            // 默认开启"自动启动"(开机恢复服务,不自动交易),用户可在我的页关闭
            const auto = localStorage.getItem("autoStart") !== "false";
            window.QuantNative.setAutoStart(auto);
          }
        } catch (error) { window.__quantNativeShell = false; }
      }

      // §77:按钮反馈(pressed → loading → success/error),禁止"点了像没反应"
      async function withBusy(btn, fn, okText) {
        if (!btn) return fn();
        if (btn.disabled) return null;
        const raw = String(btn.textContent || "");
        btn.disabled = true;
        btn.classList.add("busy");
        btn.textContent = "处理中...";
        try {
          const out = await fn();
          btn.textContent = okText || "完成";
          if (!okText) toast("完成");
          setTimeout(() => { btn.textContent = raw; btn.disabled = false; btn.classList.remove("busy"); }, 900);
          return out;
        } catch (error) {
          btn.textContent = raw;
          btn.disabled = false;
          btn.classList.remove("busy");
          toast((error && error.message) || "操作失败", "error");
          return null;
        }
      }

      async function renderNotifications() {
        const eng = await getPaperEngine();
        const data = eng.getNotifications({ limit: 200 });
        $("ntfBadge").textContent = String(data.unread);
        $("ntfBadge").className = "pill " + (data.unread > 0 ? "red" : "gray");
        $("ntfSub").textContent = data.unread > 0 ? data.unread + " 条未读 · 共 " + data.total + " 条" : "共 " + data.total + " 条";
        const box = $("ntfBody");
        box.replaceChildren();
        if (!data.items.length) {
          const empty = vEl("div", "empty-state", "还没有提醒。开仓、平仓、风险变化时这里会有记录。");
          box.appendChild(empty);
          return data;
        }
        const KIND_ZH = { TRADE: "交易", RISK: "风险", SYSTEM: "系统", MARKET: "行情", LEARNING: "模型", RESEARCH: "消息" };
        // V17:通知列表长(上限 200 条)时虚拟化;条目少时按原样全量渲染
        vVirtualize(box, data.items, (n) => {
          const el = vEl("div", "ntf-item" + (n.read ? "" : " unread"));
          const meta = vEl("div", "ntf-meta");
          meta.appendChild(vEl("span", null, (KIND_ZH[n.kind] || n.kind) + " · " + new Date(n.at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })));
          meta.appendChild(vEl("span", null, n.symbol ? n.symbol.replace("USDT", "/USDT") : ""));
          el.appendChild(meta);
          el.appendChild(vEl("div", "ntf-title", n.title));
          if (n.body) el.appendChild(vEl("div", "ntf-body", n.body));
          return el;
        }, { threshold: 120, rowHeight: 66 });
        return data;
      }

      function openNotifications() {
        $("ntfMask").classList.add("open");
        $("ntfSheet").classList.add("open");
        updateBackTrap();
        void renderNotifications();
      }
      function closeNotifications() {
        $("ntfMask").classList.remove("open");
        $("ntfSheet").classList.remove("open");
        updateBackTrap();
      }

      // V19:通知设置子页(6 类开关从"我的"主页移入子页;主页只留入口 + 已开启数)
      function openNtfSettings() {
        refreshNtfSetValue();
        setActivePage("ntfset");
      }
      function closeNtfSettings() {
        setActivePage("settings");
      }
      function refreshNtfSetValue() {
        const el = $("ntfSetValue");
        if (!el) return;
        const on = NTF_TYPES.filter((x) => ntfEnabled(x.id)).length;
        el.textContent = "已开 " + on + "/" + NTF_TYPES.length;
      }

      // ---- §18-§23:手动平仓(必须走 Paper Position Manager,禁止 UI 直接删持仓) ----
      const closeState = { position_id: null, fraction: 1, custom: null };
      let closeBusy = false;
      let adjustBusy = false;

      // 按 symbol 取最新价:snapshot/平仓都要用"该持仓自己的价格",
      // 传常量会让所有持仓被同一价格刷新(串价 -> 浮盈亏失真)
      function priceOfSymbol(sym) {
        const t = (viewState.lastTickers || []).find((x) => x && x.symbol === sym);
        const v = t ? QE.num(t.lastPrice, null) : null;
        return v == null || !(v > 0) ? null : v;
      }

      async function openCloseSheet(positionId) {
        const eng = await getPaperEngine();
        const pos = eng.getPositions().find((p) => p.position_id === positionId && p.status === "OPEN");
        if (!pos) { toast("该模拟持仓已不存在", "error"); return; }
        const price = priceOfSymbol(pos.symbol) || QE.num(pos.current_price, QE.num(pos.entry_price, null));
        const snap = eng.snapshot((sym) => priceOfSymbol(sym));
        const live = snap.positions.find((p) => p.position_id === positionId) || pos;
        const view = QE.positionView(live, { now: Date.now() });
        closeState.position_id = positionId;
        closeState.fraction = 1;
        closeState.custom = null;
        $("closeTitle").textContent = "平仓 " + view.display;
        $("closeSub").textContent = view.mode_label + " · " + view.side + " · " + view.leverage_text;
        const body = $("closeBody");
        body.replaceChildren();
        const grid = vEl("div", "close-preview");
        const cell = (k, v, cls) => { const c = vEl("div"); c.appendChild(vEl("span", "muted", k)); c.appendChild(vEl("b", cls || null, v)); return c; };
        grid.appendChild(cell("杠杆", view.leverage_text));
        grid.appendChild(cell("保证金", view.margin_text));
        grid.appendChild(cell("仓位价值", view.notional_text));
        grid.appendChild(cell("当前浮盈亏", view.pnl_text + " (" + view.pnl_pct_text + ")", view.pnl_class));
        grid.appendChild(cell("已实现", view.realized_text));
        grid.appendChild(cell("爆仓价", view.liquidation_text));
        grid.appendChild(cell("止损", view.stop == null ? "--" : fmt.format(view.stop)));
        grid.appendChild(cell("止盈", view.take_profit == null ? "--" : fmt.format(view.take_profit)));
        // V15 Manual Control Center:调整模拟止损/止盈 —— 走 PositionManager(方向校验/禁止放宽/留审计)
        const adjBox = vEl("div", "hm-actions");
        const stopInput = document.createElement("input");
        stopInput.type = "number";
        stopInput.placeholder = "止损价";
        stopInput.style.maxWidth = "92px";
        const tpInput = document.createElement("input");
        tpInput.type = "number";
        tpInput.placeholder = "止盈价";
        tpInput.style.maxWidth = "92px";
        const stopBtn = vEl("button", "sec", "调止损");
        stopBtn.type = "button";
        const tpBtn = vEl("button", "sec", "调止盈");
        tpBtn.type = "button";
        const applyAdjust = async (which) => {
          if (adjustBusy) return;
          adjustBusy = true;
          try {
            const eng = await getPaperEngine();
            const raw = which === "stop" ? stopInput.value : tpInput.value;
            const value = QE.num(raw, null);
            if (value == null || !(value > 0)) { toast("请输入有效价格", "error"); return; }
            const res = which === "stop"
              ? await eng.adjustStop({ position_id: positionId, stop_price: value })
              : await eng.adjustTakeProfit({ position_id: positionId, take_profit_price: value });
            if (!res.ok) { toast("调整失败:" + res.reason, "error"); return; }
            toast(which === "stop" ? "止损已调整" : "止盈已调整");
            closeCloseSheet();
            await renderPaperPage();
            await renderNotifications();
          } catch (error) {
            diagLog("adjust-exit", error);
            toast("调整异常", "error");
          } finally {
            adjustBusy = false;
          }
        };
        stopBtn.addEventListener("click", () => { void applyAdjust("stop"); });
        tpBtn.addEventListener("click", () => { void applyAdjust("tp"); });
        adjBox.appendChild(stopInput);
        adjBox.appendChild(stopBtn);
        adjBox.appendChild(tpInput);
        adjBox.appendChild(tpBtn);
        body.appendChild(adjBox);
        body.appendChild(grid);
        body.appendChild(vEl("div", "v-note", "剩余仓位 " + view.remaining_pct_text + " · 可平数量 " + view.remaining_quantity + " · 模拟平仓会按真实手续费与滑点结算"));
        // 比例选择(含自定义)
        const box = $("closeFractions");
        box.replaceChildren();
        const renderFractions = () => {
          box.replaceChildren();
          for (const f of [0.1, 0.25, 0.5, 0.75, 1]) {
            const btn = vEl("button", "chip" + (closeState.fraction === f && closeState.custom == null ? " active" : ""), Math.round(f * 100) + "%");
            btn.type = "button";
            btn.addEventListener("click", () => { closeState.fraction = f; closeState.custom = null; renderFractions(); });
            box.appendChild(btn);
          }
          const input = document.createElement("input");
          input.type = "number";
          input.min = "1";
          input.max = "100";
          input.placeholder = "自定义%";
          input.style.maxWidth = "88px";
          input.value = closeState.custom == null ? "" : String(closeState.custom);
          const applyCustom = (rerender) => {
            const v = Math.max(1, Math.min(100, QE.num(input.value, 0)));
            closeState.custom = v > 0 ? v : null;
            if (closeState.custom != null) closeState.fraction = closeState.custom / 100;
            // 输入过程中只更新按钮文案(重建 DOM 会让输入框失焦),离开输入框后再重建
            if (rerender) renderFractions();
            else $("closeConfirmBtn").textContent = "确认平仓 " + Math.round((closeState.custom == null ? closeState.fraction : closeState.custom / 100) * 100) + "%";
          };
          input.addEventListener("input", () => applyCustom(false));
          input.addEventListener("change", () => applyCustom(true));
          box.appendChild(input);
          $("closeConfirmBtn").textContent = "确认平仓 " + Math.round((closeState.custom == null ? closeState.fraction : closeState.custom / 100) * 100) + "%";
        };
        renderFractions();
        $("closeMask").classList.add("open");
        $("closeSheet").classList.add("open");
        updateBackTrap();
      }

      function closeCloseSheet() {
        $("closeMask").classList.remove("open");
        $("closeSheet").classList.remove("open");
        closeState.position_id = null;
        updateBackTrap();
      }

      async function confirmManualClose() {
        if (closeBusy) return;   // §115:防重复点击
        const id = closeState.position_id;
        if (!id) return;
        // 以输入框当前值为准(手机上"输入后直接点确认"不该按旧比例结算)
        const customInput = document.querySelector("#closeFractions input");
        const typed = customInput && customInput.value !== "" ? Math.max(1, Math.min(100, QE.num(customInput.value, 0))) : null;
        const fraction = typed != null ? typed / 100 : (closeState.custom == null ? closeState.fraction : closeState.custom / 100);
        const full = fraction >= 0.999999;
        // §79:全部平仓需要确认;部分平仓轻量确认
        if (full && !confirm("确认全部平掉该模拟仓位?(仅模拟,不影响真实资金)")) return;
        closeBusy = true;
        const btn = $("closeConfirmBtn");
        btn.disabled = true;
        btn.textContent = "平仓中...";
        try {
          const eng = await getPaperEngine();
          // 用被平这笔持仓自己的 symbol 取价,不用"页面上最后显示的那笔"
          const target = eng.getPositions().find((p) => p.position_id === id);
          const live = target ? priceOfSymbol(target.symbol) : null;
          const prediction = target && viewState.lastPrediction && viewState.lastPrediction.symbol === target.symbol ? viewState.lastPrediction : null;
          const res = await eng.manualClose({ position_id: id, fraction, price: live == null ? undefined : live, prediction });
          if (!res.ok) {
            toast("平仓失败:" + res.reason, "error");
          } else {
            toast("已平 " + Math.round(fraction * 100) + "% · 净" + (QE.num(res.trade && res.trade.net_pnl, 0) >= 0 ? "收益 " : "亏损 ") + QE.num(res.trade && res.trade.net_pnl, 0).toFixed(2) + " USDT");
            closeCloseSheet();
            await renderPaperPage();
            await renderHome();
            await renderNotifications();
          }
        } catch (error) {
          diagLog("manual-close", error);
          toast("平仓异常:" + ((error && error.message) || "未知错误"), "error");
        } finally {
          closeBusy = false;
          btn.disabled = false;
          btn.textContent = "确认平仓";
        }
      }

      // §26:紧急全平(二次确认)
      async function emergencyCloseAll() {
        const eng = await getPaperEngine();
        const open = eng.getPositions().filter((p) => p.status === "OPEN");
        if (!open.length) { toast("当前没有模拟持仓"); return; }
        if (!confirm("紧急全平:将立即以当前模拟价平掉全部 " + open.length + " 个仓位。仅模拟账户,确认继续?")) return;
        if (!confirm("再次确认:此操作不可撤销(不会恢复已实现盈亏)。确定执行?")) return;
        const prices = {};
        for (const t of viewState.lastTickers || []) if (t.symbol) prices[t.symbol] = Number(t.lastPrice);
        const res = await withBusy($("pfEmergencyBtn"), () => eng.emergencyCloseAll({ priceOf: (s) => prices[s] }), "已全平");
        toast("已紧急平仓 " + res.closed + " 个仓位");
        await renderPaperPage();
        await renderHome();
        await renderNotifications();
      }

      // §27:暂停/恢复新开仓
      async function togglePauseEntries() {
        const eng = await getPaperEngine();
        const btn = $("pfPauseEntriesBtn");
        const paused = Boolean(eng.engine.entriesPaused);
        if (!paused) { eng.pauseEntries("用户暂停新开仓"); toast("已暂停新开仓(现有仓位继续管理)"); }
        else { eng.resumeEntries(); toast("已恢复新开仓"); }
        btn.textContent = paused ? "暂停新开仓" : "恢复新开仓";
        btn.className = "sec" + (paused ? "" : " danger");
        void renderNotifications();
      }

      // §80:重置模拟账户(二次确认)
      async function resetPaperAccount() {
        if (!confirm("重置模拟账户?会清空本地 Paper 持仓与成交,恢复 100 USDT(70/30)。")) return;
        if (!confirm("再次确认:重置后无法撤销。历史样本与模型不受影响。确定重置?")) return;
        const eng = await getPaperEngine();
        const res = await withBusy($("resetPaperBtn"), () => eng.resetPaperAccount({ confirm: true }), "已重置");
        if (res && res.ok) {
          toast("模拟账户已重置为 100 USDT(短线 70 / 长线 30)");
          viewState.lastPositionRaw = null;
          await renderHome();
          await renderPaperPage();
          await renderNotifications();
        }
        void res;
      }

      // §81:导出 Paper 记录(CSV / JSON)
      function exportPaperRecords(format) {
        void (async () => {
          try {
            const eng = await getPaperEngine();
            const trades = eng.getTrades();
            const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            if (format === "json") {
              downloadText(JSON.stringify({ account: eng.getAccount(), wallets: eng.snapshot().wallets, positions: eng.getPositions(), trades, notifications: eng.getNotifications({ limit: 100 }).items }, null, 1), "paper-records_" + stamp + ".json", "application/json");
              return;
            }
            // V15 P0 §17:补齐真实 margin / notional / 剩余数量 / 费用分摊 / 杠杆来源 /
            // 仓位事件标记(Partial 是 Position Event)与仓位级收益口径
            const cols = [
              "trade_id", "position_id", "parent_position_id", "position_event", "partial",
              "mode", "symbol", "side", "quantity", "closed_quantity",
              "entry_price", "exit_price", "leverage", "leverage_source",
              "margin", "position_margin", "entry_notional_closed", "notional_value", "notional_closed",
              "remaining_quantity_after", "remaining_margin_after", "remaining_notional_after",
              "entry_fee_allocated", "exit_fee", "fees", "gross_pnl", "net_pnl",
              "return_pct", "return_on_position_pct",
              "mfe", "mae", "holding_ms", "exit_reason", "action_source",
              "invalid_sample", "invalid_for_learning", "repair_reason",
              "entry_time", "exit_time"
            ];
            const valueOf = (t, c) => {
              if (c === "closed_quantity") return t.quantity;
              if (c === "exit_fee") return t.partial ? num2(t.fees) - num2(t.entry_fee_allocated) : t.fees;
              if (c === "margin") return t.position_margin != null ? t.position_margin : t.entry_notional;
              if (c === "notional_value") return t.notional_value != null ? t.notional_value : (t.leverage && t.entry_notional ? round2(num2(t.entry_notional) * num2(t.leverage, 1)) : t.notional_value);
              if (c === "notional_closed") return t.notional_closed != null ? t.notional_closed : (t.exit_price && t.quantity ? round2(num2(t.exit_price) * num2(t.quantity)) : null);
              if (c === "position_event") return t.partial === true ? "true" : "false";
              if (c === "leverage_source") return t.leverage_source || (num2(t.requested_leverage, 0) > 0 ? "AUTO" : "MANUAL");
              const v = t[c];
              return v == null ? "" : v;
            };
            const num2 = (v, fallback) => { const n = Number(v); return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback); };
            const round2 = (v) => Math.round(num2(v) * 1e8) / 1e8;
            const lines = [cols.join(",")];
            for (const t of trades) {
              lines.push(cols.map((c) => {
                const raw = valueOf(t, c);
                const v = raw == null ? "" : String(raw);
                return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
              }).join(","));
            }
            downloadText(lines.join("\n") + "\n", "paper-trades_" + stamp + ".csv", "text/csv;charset=utf-8");
            toast("已导出 " + trades.length + " 笔成交");
          } catch (error) {
            diagLog("export", error);
            toast("导出失败", "error");
          }
        })();
      }

      // §82:系统状态(简洁:正常 / 异常)+ V15 模块状态(数据质量/组合风险/后台任务/自检/通知)
      async function renderSysStatus() {
        const bg = backgroundWorkerStats();
        let mod = {};
        try {
          const eng = await getPaperEngine();
          const risk = eng.currentRisk();
          mod = {
            dq: eng.dataQualitySummary(),
            dqOk: eng.dataQuality().ok,
            risk: risk.risk_level,
            riskOk: risk.allow_new_entry,
            riskFlags: (risk && risk.risk_flags) || [],
            tasks: taskBag ? taskBag.health() : null,
            recovery: eng.recoveryReport() ? eng.recoveryReport().view : null,
            journal: eng.journalSummary(),
            unread: eng.notificationDigest().unread,
            lev: typeof eng.leverageDiagnostics === "function" ? eng.leverageDiagnostics() : null,
            pl: typeof eng.profitLockDiagnostics === "function" ? eng.profitLockDiagnostics() : null,
            mkt: (() => { try { return JSON.parse((window.QuantNative && window.QuantNative.runtimeStatus && window.QuantNative.runtimeStatus()) || "{}"); } catch (error) { return null; } })(),
            rt: (() => { try { const s = JSON.parse((window.QuantNative && window.QuantNative.runtimeStatus && window.QuantNative.runtimeStatus()) || "{}"); return { state: s.state || "RUNNING(后台)", loops: QE.num(s.loops, 0), last_tick_at: s.last_tick_at || null }; } catch (error) { return null; } })()
          };
        } catch (error) { diagLog("sys-status", error); }
        // V16.1-RV §33/§34:后台"存活"不能只看布尔 —— 必须展示实例号 / 心跳 / 分项 tick 延迟
        const rt = readRuntimeStatus();
        const svcAlive = (() => { try { return Boolean(window.QuantNative && window.QuantNative.isRuntimeRunning && window.QuantNative.isRuntimeRunning()); } catch (error) { return false; } })();
        const hbAgeS = rt && rt.heartbeat_age_ms != null ? Math.round(QE.num(rt.heartbeat_age_ms, 0) / 1000) : null;
        const stAgeS = rt && rt.strategy_age_ms != null ? Math.round(QE.num(rt.strategy_age_ms, 0) / 1000) : null;
        const loopAbnormal = Boolean(svcAlive && rt && rt.strategy_stalled && rt.market_state === "HEALTHY");
        // V16.2s:紧凑状态行(项目 | 状态 | 箭头);点任一行展开真实技术细节,再点收起。
        // 每行的值都来自真实运行数据(heartbeat / last tick / provider / error / version),不写死。
        const mktLast = viewState.devMarketTick ? new Date(viewState.devMarketTick).toLocaleTimeString() : null;
        const tickersCount = (viewState.lastTickers || []).length;
        const engStateOf = (() => {
          if (mod.rt && mod.rt.state) return String(mod.rt.state) + " · loop " + QE.num(mod.rt.loops, 0);
          if (viewState.lastDrawdown) return "运行中";
          return "待启动";
        })();
        const rows = [
          ...(rt ? [
            { k: "后台运行时", v: String(rt.state || "--"), ok: true, detail: "实例 " + String(rt.instance_id || "无实例号") + " · 状态版本 v" + QE.num(rt.state_version, 0) + " · 服务" + (svcAlive ? "在跑" : "未探测到") },
            { k: "运行时心跳", v: hbAgeS == null ? "无数据" : (hbAgeS + " 秒前"), ok: !rt.stalled, detail: rt.stalled ? ("已停滞:RUNTIME_STALL ×" + QE.num(rt.stall_events, 0)) : ("最近一次心跳 " + (hbAgeS == null ? "--" : hbAgeS + " 秒前")) },
            { k: "策略循环", v: loopAbnormal ? "异常" : (QE.num(rt.loops, 0) + " 轮"), ok: !loopAbnormal, detail: loopAbnormal ? "后台服务存在,但策略循环超过 " + (stAgeS == null ? "--" : stAgeS + " 秒") + " 未更新" : ("最近 " + (stAgeS == null ? "--" : stAgeS + " 秒前")) },
            { k: "风控循环", v: QE.num(rt.risk_loops, 0) + " 轮", ok: true, detail: rt.risk_age_ms != null ? ("最近 " + Math.round(QE.num(rt.risk_age_ms, 0) / 1000) + " 秒前") : "无数据" },
            { k: "行情健康", v: rt.market_state ? String(rt.market_state) : "本地直连", ok: !rt.market_stale, detail: (rt.market_age_ms != null ? "最近 " + Math.round(QE.num(rt.market_age_ms, 0) / 1000) + " 秒前" : "无数据") + (rt.market_stale ? " · 价格长时间未变化" : "") }
          ] : []),
          { k: "行情数据", v: tickersCount ? "正常" : "异常", ok: tickersCount > 0, detail: "币种 " + tickersCount + " 个" + (mktLast ? " · 最近刷新 " + mktLast : "") },
          { k: "数据质量", v: mod.dq || "待检查", ok: mod.dqOk !== false, detail: mod.dqOk === false ? "数据质量检查未通过(详见系统诊断)" : "引擎数据质量摘要" },
          { k: "Paper 引擎", v: engStateOf, ok: true, detail: "本地模拟引擎(无真实下单) · " + (mod.rt && mod.rt.last_tick_at ? "最近 tick " + new Date(QE.num(mod.rt.last_tick_at, 0)).toLocaleTimeString() : "无 tick 记录") },
          { k: "组合风险", v: mod.risk ? (mod.risk + (mod.riskOk ? "" : " · 已禁新开仓")) : "待评估", ok: mod.riskOk !== false, detail: (mod.riskFlags && mod.riskFlags.length) ? ("风险标记:" + mod.riskFlags.join("、")) : "风险评估来自本地风控引擎" },
          { k: "数据库", v: vstate.store ? "正常" : "内存模式", ok: true, detail: "本地历史库(IndexedDB,不用云端数据库)" },
          { k: "Research", v: bg.research.runs > 0 ? "正常" : "待触发", ok: true, detail: "研究巡检 " + QE.num(bg.research.runs, 0) + " 次" },
          { k: "学习", v: mlRuntime.hasModel() ? "正常" : "回退规则", ok: true, detail: "模型版本 " + String((mlUiState && mlUiState.version) || "无(规则回退)") },
          { k: "后台服务", v: bg.bg_data_timer ? "运行中" : "未启动", ok: Boolean(bg.bg_data_timer), detail: "外部情报后台刷新节奏 " + Math.round(BG_DATA_INTERVAL_MS / 1000) + " 秒" },
          { k: "后台任务", v: mod.tasks ? mod.tasks.label : "未登记", ok: true, detail: mod.tasks ? "任务健康由 TaskManager 统一统计" : "任务管理器未启动" },
          { k: "自动杠杆", v: mod.lev ? ("正式模型 " + QE.num(mod.lev.champion && mod.lev.champion.short, 2) + "x") : "--", ok: true, detail: mod.lev ? ("有效样本 " + mod.lev.records + " · 状态 " + mod.lev.status) : "无数据" },
          { k: "市场 Provider", v: mod.mkt ? (String(mod.mkt.state || "--") + (mod.mkt.provider ? " · " + mod.mkt.provider : "")) : "本地直连", ok: !(mod.mkt && mod.mkt.state && /DOWN|FAIL/.test(String(mod.mkt.state))), detail: (mod.mkt && mod.mkt.error) ? ("错误:" + String(mod.mkt.error)) : "上游状态来自后台运行时" },
          { k: "启动自检", v: mod.recovery ? mod.recovery.label : "未运行", ok: true, detail: "启动恢复阶梯自检(异常时给出恢复步骤)" },
          { k: "决策日志", v: mod.journal ? (mod.journal.total + " 条") : "--", ok: true, detail: "记录每次开/平/拒单的原因" },
          { k: "Profit Lock 监控", v: mod.pl ? (mod.pl.warning ? "TRADE_INTEGRITY_WARNING" : "正常") : "--", ok: !(mod.pl && mod.pl.warning), detail: mod.pl ? ("单仓最多 " + mod.pl.max_partials_per_position + " 次减仓 · 尘埃收尾 " + mod.pl.dust_closes) : "无数据" },
          { k: "学习数据", v: mod.lev ? (mod.lev.valid_positions + " 个有效完整仓位") : "--", ok: true, detail: "无效样本不计入学习与漂移检测" },
          { k: "未读提醒", v: Number(mod.unread || 0) + " 条", ok: true, detail: "在通知中心查看,可一键全部已读" }
        ];
        const bad = rows.filter((r) => r.ok === false).length;
        $("sysBadge").textContent = bad ? "有异常" : "正常";
        $("sysBadge").className = "pill " + (bad ? "red" : "green");
        const box = $("sysStatusBox");
        box.replaceChildren();
        for (const row of rows) box.appendChild(sysRowEl(row));
        box.appendChild(vEl("div", "v-note", "技术细节(上游耗时/熔断/漂移指标)在「开发工具 · 行情健康检查」里。"));
      }

      // 系统状态单行:紧凑显示"项目 | 状态";点整行展开技术细节,再点收起(aria-expanded 同步)
      function sysRowEl(row) {
        const el = vEl("div", "sys-row");
        el.dataset.tap = "sys:" + row.k;
        el.appendChild(vEl("div", "sys-k", row.k));
        const right = vEl("div", "sys-right");
        right.appendChild(vEl("span", "sys-v" + (row.ok === false ? " red" : ""), String(row.v == null ? "--" : row.v)));
        right.appendChild(vEl("span", "sg-chev", "›"));
        el.appendChild(right);
        if (row.detail) el.appendChild(vEl("div", "sys-detail", String(row.detail)));
        el.setAttribute("role", "button");
        el.setAttribute("aria-expanded", "false");
        el.addEventListener("click", () => {
          const open = el.classList.toggle("open");
          el.setAttribute("aria-expanded", open ? "true" : "false");
        });
        return el;
      }

      // ================= V16:量化内核(只读观测页) =================
      // 硬约束:每个引擎访问器都必须容错 —— 引擎未启动、或处于"后台 Viewer"模式(方法不全)时
      // 一律显示「未启动 / 未知」,绝不让一个缺失字段把整页打崩。
      function kdSafe(fn, fallback) {
        if (typeof fn !== "function") return fallback === undefined ? null : fallback;
        try {
          const v = fn();
          return v === undefined || v === null ? (fallback === undefined ? null : fallback) : v;
        } catch (error) {
          return fallback === undefined ? null : fallback;
        }
      }

      // 引擎方法探测:不存在或抛错 → null(页面显示未知);不抛给调用方
      function kdProbe(eng, name) {
        if (!eng || typeof eng[name] !== "function") return null;
        try { return eng[name](); } catch (error) { return null; }
      }

      function kdClock(ms) {
        const n = Number(ms);
        if (!n) return "--";
        try { return new Date(n).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); } catch (error) { return "--"; }
      }

      // ================= V16.1-RV:UI State Store / 运行时镜像 / 资金口径统一(§19-§23/§33/§34) =================
      // Runtime(或其只读 Viewer 镜像)是唯一权威;页面只从统一快照读,不再各页各算法。
      const uiStore = QE.createUiStore({ now: () => Date.now() });
      let uiRenderSeq = 0;                       // 页面侧单调版本:每登记一次新快照 +1
      const lastCapitalByPage = {};              // { page: {…资本数字, state_version, at} }
      let lastParity = { ok: true, checked: 0, at: 0 };
      // §20:运行时状态镜像带版本守卫 —— 旧版本(state_version 更小)一律丢弃,不允许旧快照覆盖新状态
      const runtimeMirror = { version: -1, status: null, rejected: 0 };
      function readRuntimeStatus() {
        try {
          if (!window.QuantNative || typeof window.QuantNative.runtimeStatus !== "function") return runtimeMirror.status;
          const raw = window.QuantNative.runtimeStatus();
          if (!raw) return runtimeMirror.status;
          const parsed = JSON.parse(raw);
          const v = QE.num(parsed.state_version, 0);
          if (v < runtimeMirror.version) { runtimeMirror.rejected += 1; return runtimeMirror.status; }
          runtimeMirror.status = parsed;
          runtimeMirror.version = v;
          return parsed;
        } catch (error) { return runtimeMirror.status; }
      }
      // §19/§21:资金口径唯一入口 —— engine 或 Viewer 的官方 poolLayers() 优先;缺失时用同一公式补算(绝不各页各写一套)
      function capitalNow(eng, snapshot) {
        const account = (snapshot && snapshot.account) || (eng && eng.getAccount ? eng.getAccount() : {}) || {};
        const layers = kdProbe(eng, "poolLayers");
        const pool = kdProbe(eng, "protectedPool");
        const rt = readRuntimeStatus();
        return QE.capitalSnapshot({
          account,
          layers,
          protected_balance: QE.num(pool && pool.protected_balance, 0),
          state_version: QE.num(rt && rt.state_version, 0),
          updated_at: Date.now()
        });
      }
      // §21:每次页面渲染后,把"这一页看到的资金数字"登记到状态桶;同版本出现差异 → ACCOUNT_VIEW_MISMATCH(诊断可见)
      function recordCapital(page, cap) {
        const entry = { ...cap, page, at: Date.now() };
        lastCapitalByPage[page] = entry;
        const sv = (uiRenderSeq += 1);
        uiStore.set("capitalState", { ...cap, page, source_at: entry.at }, { state_version: sv });
        uiStore.set("accountState", { equity: cap.total_equity, page, source_at: entry.at }, { state_version: sv });
        lastParity = accountParityCheck();
        return entry;
      }
      function accountParityCheck() {
        const pages = Object.keys(lastCapitalByPage);
        let checked = 0;
        let mismatch = null;
        for (let i = 0; i < pages.length && !mismatch; i += 1) {
          for (let j = i + 1; j < pages.length && !mismatch; j += 1) {
            const a = lastCapitalByPage[pages[i]];
            const b = lastCapitalByPage[pages[j]];
            // 只有"同一来源版本"的两页渲染才可比较(不同版本=不同时刻,不是不一致)
            if (a.state_version !== b.state_version) continue;
            checked += 1;
            const r = QE.capitalParity(a, b);
            if (!r.ok) mismatch = { pages: [pages[i], pages[j]], fields: r.fields, left: a, right: b };
          }
        }
        // 设备侧:页面渲染值与运行时权威状态(runtimeStatus)直接对账
        const rt = runtimeMirror.status;
        if (!mismatch && rt && rt.equity != null) {
          for (const page of pages) {
            const e = lastCapitalByPage[page];
            if (Math.abs(e.at - QE.num(rt.updated_at, 0)) > 60000) continue;   // 相隔超过 1 分钟的状态不可比
            if (Math.abs(QE.num(e.total_equity, 0) - QE.num(rt.equity, 0)) > QE.CAPITAL_PARITY_TOLERANCE) {
              mismatch = { pages: [page, "runtime"], fields: ["total_equity"], left: e, right: { total_equity: QE.num(rt.equity, 0), state_version: rt.state_version } };
              break;
            }
          }
        }
        if (mismatch) {
          diagLog("ACCOUNT_VIEW_MISMATCH", mismatch);
          uiStore.markStale("capitalState");
          return { ok: false, checked, at: Date.now(), detail: mismatch };
        }
        return { ok: true, checked, at: Date.now() };
      }
      // V16.1-RV §50:通知点击 → 深链到对应页面(交易类→币种详情;系统/风险→诊断;学习→我的;兜底→模拟)
      function applyNotificationRoute() {
        try {
          if (!window.QuantNative || typeof window.QuantNative.pendingNotification !== "function") return null;
          const raw = window.QuantNative.pendingNotification();
          if (!raw) return null;
          const route = QE.notificationRoute(JSON.parse(raw));
          if (route.page === "detail" && route.symbol) { setActivePage("detail"); void openDetail(route.symbol, "1h"); }
          else if (route.page === "diag") { openDiag(); }
          else if (route.page === "settings") { setActivePage("settings"); void renderLearning(); }
          else { setActivePage("paper"); void renderPaperPage(); }
          return route;
        } catch (error) { diagLog("ntf-route", error); return null; }
      }

      function kdRow(label, sub, status, value) {
        const row = vEl("div", "kd-row");
        row.dataset.kdStatus = status || "na";   // 供分组统计(不依赖 DOM 查询)
        const left = vEl("div");
        left.appendChild(vEl("div", "kd-k", label));
        if (sub) left.appendChild(vEl("div", "kd-sub", sub));
        row.appendChild(left);
        const right = vEl("div", "kd-v");
        right.appendChild(vEl("span", "kd-dot " + (status || "na")));
        right.appendChild(vEl("span", null, value == null || value === "" ? "--" : String(value)));
        row.appendChild(right);
        return row;
      }

      function kdGroup(title, summary, rows) {
        const g = vEl("div", "kd-group");
        const head = vEl("div", "kd-grouphead");
        head.appendChild(vEl("span", null, title));
        head.appendChild(vEl("span", "muted", summary || ""));
        g.appendChild(head);
        const box = vEl("div", "kd-rows");
        for (const r of rows) box.appendChild(r);
        g.appendChild(box);
        return g;
      }

      const KERNEL_STATE_ZH = { STOPPED: "未启动", STARTING: "启动中", RUNNING: "运行中", PAUSED: "已暂停", RECOVERING: "恢复中", ERROR: "异常" };
      // 页面 regime 文案 → 调度器 regime 键(用于模型调度器输入)
      const KERNEL_REGIME_MAP = {
        "Strong Uptrend": "TREND_UP", "Weak Uptrend": "TREND_UP", "Bullish Range": "RANGE",
        "Strong Downtrend": "TREND_DOWN", "Weak Downtrend": "TREND_DOWN", "Bearish Range": "RANGE",
        "Range": "RANGE"
      };
      const KERNEL_DOT_ZH = { ok: "正常", warn: "注意", bad: "异常", na: "未接入" };

      async function renderKernel() {
        let eng = null;
        try { eng = await getPaperEngine(); } catch (error) { eng = null; diagLog("kernel-engine", error); }

        // ---- 模型注册表 / 学习数据(失败不影响其它分组) ----
        let champ = null;
        let models = [];
        let driftEval = null;
        let lastEval = null;
        let evalCount = 0;
        let validSampleCount = null;
        try {
          const store = await historyStore();
          const adapter = paperStoreAdapter(store);
          champ = await QE.getChampion(adapter);
          models = (await QE.listModels(adapter)) || [];
          const evals = (await store.generic.all("model_evaluations", 50)) || [];
          evalCount = evals.length;
          driftEval = evals.filter((e) => e && e.drift_detected).sort((a, b) => QE.num(b.at, 0) - QE.num(a.at, 0))[0] || null;
          lastEval = evals[0] || null;
          const samples = (await adapter.all("learning_samples")) || [];
          validSampleCount = samples.filter((s) => s && s.invalid_sample !== true).length;
        } catch (error) { diagLog("kernel-learning", error); }

        // ---- 引擎访问器(逐个容错) ----
        const state = eng ? kdSafe(() => String(eng.getState()), "STOPPED") : "STOPPED";
        const running = state === "RUNNING";
        const positions = kdProbe(eng, "getPositions") || [];
        const openPositions = positions.filter((p) => p && p.status === "OPEN");
        const trades = kdProbe(eng, "getTrades") || [];
        const invalidTrades = trades.filter((t) => t && (t.invalid_sample === true || t.invalid_for_learning === true));
        const risk = kdProbe(eng, "currentRisk") || {};
        const dq = kdProbe(eng, "dataQuality") || {};
        const dqSum = kdProbe(eng, "dataQualitySummary");
        const recovery = kdProbe(eng, "recoveryReport");
        const recView = recovery && recovery.view ? recovery.view : recovery;
        const journal = kdProbe(eng, "journalSummary") || {};
        const attribution = kdProbe(eng, "attribution") || {};
        const lev = kdProbe(eng, "leverageDiagnostics");
        const pl = kdProbe(eng, "profitLockDiagnostics");
        const pfView = kdProbe(eng, "positionOverview") || {};
        const integrity = kdProbe(eng, "getIntegrity") || {};
        const acctIntegrity = kdProbe(eng, "accountIntegrity") || {};
        const ledger = kdProbe(eng, "ledgerExactAudit");
        const ledgerBad = ledger && Array.isArray(ledger.violations) ? ledger.violations.length : null;
        const hwm = kdProbe(eng, "hwm");
        const pool = kdProbe(eng, "protectedPool");
        const layers = kdProbe(eng, "poolLayers");
        // V16.1-RV §19/§21:内核页的资金层级与首页/模拟同口径,并登记进一致性对比(拿不到引擎就不登记,避免假差异)
        if (eng) recordCapital("kernel", capitalNow(eng, null));
        const reserve = kdProbe(eng, "reserveSummary");
        const anomalies = kdProbe(eng, "behaviorAnomalies") || [];
        const qualitySkips = kdProbe(eng, "qualitySkips");
        const lastQuality = kdProbe(eng, "lastQuality");
        const qualityLog = kdProbe(eng, "entryQualityLog") || [];
        const theses = kdProbe(eng, "thesisDecisions") || [];
        const notif = kdProbe(eng, "notificationDigest") || {};
        const review = kdProbe(eng, "reviewStats") || {};
        const fundingSnap = kdProbe(eng, "getFundingSnapshot") || {};
        const diagSum = kdProbe(eng, "diag") || [];
        const bg = backgroundWorkerStats();
        const hub = (() => { try { return externalHub.snapshot() || []; } catch (error) { return []; } })();
        const nativeStat = (() => { try { return JSON.parse((window.QuantNative && window.QuantNative.runtimeStatus && window.QuantNative.runtimeStatus()) || "{}"); } catch (error) { return {}; } })();

        const engineWord = running ? "正常" : (state === "PAUSED" ? "已暂停" : (state === "ERROR" ? "异常" : "未启动"));
        const engineStatus = running ? "ok" : (state === "ERROR" ? "bad" : "warn");

        // ---- 顶部卡片 ----
        const paperOnly = !(QE.REAL_TRADING_ENABLED === true || QE.REAL_FUTURES_ENABLED === true);
        const stateZh = KERNEL_STATE_ZH[state] || "未知";
        $("kernelModeNote").textContent = paperOnly ? "Paper 模式(模拟盘)" : "实盘开关已开启";
        $("kernelStateBadge").textContent = stateZh;
        $("kernelStateBadge").className = "pill " + (state === "RUNNING" ? "green" : (state === "ERROR" ? "red" : "gray"));
        $("kernelVersion").textContent = String(QE.ENGINE_VERSION || "--");
        $("kernelLearning").textContent = champ ? ("已定版 · " + String(champ.version)) : (validSampleCount ? "学习中(未定版)" : "未训练");
        const runtimeZh = nativeStat && nativeStat.state ? ("后台运行时 " + String(nativeStat.state)) : "前台页面承载运行时";
        $("kernelTopNote").textContent = "Schema " + String(QE.SCHEMA_VERSION || "--")
          + " · 持仓 " + openPositions.length + " · 成交 " + trades.length
          + " · 决策日志 " + QE.num(journal.total, 0) + " 条 · " + runtimeZh;

        // ---- 分组 1:核心引擎 ----
        const riskLevel = risk.risk_level || risk.riskLevel || null;
        const riskAllow = risk.allow_new_entry !== false;
        const coreRows = [
          kdRow("交易引擎", "开仓 / 平仓 / 主循环", engineStatus, engineWord),
          kdRow("风险引擎", "组合级风控与 Veto", riskLevel ? (riskAllow ? "ok" : "warn") : "na", riskLevel ? (String(riskLevel) + (riskAllow ? " · 允许新开仓" : " · 已禁新开仓")) : "未评估"),
          kdRow("仓位管理", "生命周期 / 止损止盈 / 跟踪", eng ? "ok" : "na", eng ? ("持仓 " + openPositions.length + " · 已平 " + QE.num(pfView.closed_count, 0)) : "未启动"),
          kdRow("盈利保护", "分段减仓 / 移动止盈 / 回吐监控", pl ? (pl.warning ? "warn" : "ok") : "na", pl ? (pl.warning ? "发现异常(" + String(pl.warning_code || "告警") + ")" : ("单仓最多 " + QE.num(pl.max_partials_per_position, 0) + " 次减仓")) : "未启动"),
          kdRow("亏损管理", "论点失效 / 立即退出 / 止损纪律", theses.length ? "ok" : (eng ? "warn" : "na"), theses.length ? ("已评估 " + theses.length + " 条论点") : (eng ? "暂无待评估论点" : "未启动")),
          kdRow("决策融合", "规则 + 模型 + 证据加权", QE.FUSION_WEIGHTS ? "ok" : "na", QE.FUSION_WEIGHTS ? "已加载" : "未加载"),
          kdRow("未来走势预测", "多周期概率分布", viewState.lastPrediction ? "ok" : (eng ? "warn" : "na"), viewState.lastPrediction ? "已产出" : "待产出")
        ];

        // ---- 分组 2:模型与智能 ----
        const registryCount = QE.FACTOR_REGISTRY && QE.FACTOR_REGISTRY.length ? QE.FACTOR_REGISTRY.length : 0;
        const schedModels = [{ kind: "RULE", available: true, features: ["rsi14", "adx", "atr_pct"] }];
        if (mlRuntime.hasModel()) schedModels.push({ kind: "LOGREG", available: true, features: ["rsi14", "adx", "atr_pct"] });
        const schedule = kdSafe(() => QE.metaSchedule({ regime: KERNEL_REGIME_MAP[String(viewState.lastRegime || "")] || "UNKNOWN", models: schedModels }), null);
        const meta = schedule ? kdSafe(() => QE.metaView(schedule), null) : null;
        const challenger = models.filter((m) => m && (m.status === "CHALLENGER" || m.status === "CANDIDATE")).sort((a, b) => QE.num(b.created_at, 0) - QE.num(a.created_at, 0))[0] || null;
        const shadowActive = Boolean(lev && lev.challenger) || attribution && attribution.shadow_records > 0;
        const modelRows = [
          kdRow("本地因子模型", "因子注册表与有效性排序", registryCount ? (running ? "ok" : "warn") : "na", registryCount ? (registryCount + " 个因子已注册 · " + String(QE.FACTOR_FACTORY_VERSION || "")) : "未加载"),
          kdRow("随机森林", "梯度提升 / 树模型推理", "na", "未接入"),
          kdRow("LightGBM", "梯度提升推理", "na", "未接入"),
          kdRow("Kronos 序列预测", "时序模型(调度表已预留)", "na", "未接入"),
          kdRow("模型调度器", "按行情状态分配模型权重", meta ? "ok" : "na", meta && meta.summary_zh ? meta.summary_zh : (String(QE.META_SCHEDULER_VERSION || "未加载"))),
          kdRow("正式模型", "当前实际参与决策的模型", champ ? "ok" : (eng ? "warn" : "na"), champ ? String(champ.version) : "无(规则回退)"),
          kdRow("候选模型", "待评估、尚未晋升", challenger ? "warn" : "na", challenger ? String(challenger.version) : "无"),
          kdRow("影子实验", "影子评估记录(不影响真实仓位)", shadowActive ? "ok" : "na", shadowActive ? "有影子记录" : "暂无记录"),
          kdRow("规律漂移", "窗口内胜率/分布是否漂移", driftEval ? "warn" : (evalCount ? "ok" : "na"), driftEval ? ("检测到漂移 · " + kdClock(driftEval.at)) : (evalCount ? "未检测到漂移" : "样本不足")),
          kdRow("DeepSeek 智能复核", "关键点二次复核(失败回退本地)", QE.num(review.calls, 0) > 0 ? "ok" : "na", QE.num(review.calls, 0) > 0 ? ("已复核 " + QE.num(review.calls, 0) + " 次 · 回退 " + QE.num(review.fallbacks, 0)) : "未启用(本地回答)")
        ];

        // ---- 分组 3:市场数据 ----
        const hubOf = (type) => hub.filter((x) => x && x.data_type === type)[0] || null;
        const hubRow = (type, label, note) => {
          const e = hubOf(type);
          if (!e) return kdRow(label, note || "尚未取到该数据", "na", "离线");
          if (!e.available) return kdRow(label, "上游不可用" + (e.error ? " · " + String(e.error).slice(0, 32) : ""), "bad", "离线");
          const fresh = Number(e.freshness);
          const ok = !isFinite(fresh) || fresh >= 0.5;
          return kdRow(label, (note ? note + " · " : "") + "来源 " + String(e.provider || e.source || "--") + " · " + Math.round(QE.num(e.age_ms, 0) / 1000) + " 秒前", ok ? "ok" : "warn", ok ? "正常" : "降级");
        };
        const tickers = viewState.lastTickers || [];
        const marketRows = [
          kdRow("行情", "实时价格与 24h 数据", tickers.length ? "ok" : (running ? "warn" : "na"), tickers.length ? (tickers.length + " 个交易对") : "未取到"),
          kdRow("K线", "主周期已收盘K线", viewState.lastKlines && viewState.lastKlines.length ? "ok" : (eng ? "warn" : "na"), viewState.lastKlines && viewState.lastKlines.length ? (viewState.lastKlines.length + " 根") : "未取到"),
          hubRow("funding", "Funding 资金费", (fundingSnap && fundingSnap.status) ? ("引擎口径 " + String(fundingSnap.status)) : null),
          hubRow("open_interest", "Open Interest 持仓量"),
          hubRow("long_short_ratio", "多空比"),
          hubRow("mark_price", "Mark Price 标记价格"),
          kdRow("BTC 市场环境", "大盘 regime / 广度", viewState.lastRegime ? "ok" : (eng ? "warn" : "na"), viewState.lastRegime ? String(viewState.lastRegime) : "未取到"),
          kdRow("Research News", "研究与消息巡检", bg.research && bg.research.runs > 0 ? "ok" : "warn", bg.research && bg.research.runs > 0 ? ("已巡检 " + QE.num(bg.research.runs, 0) + " 次") : "待触发")
        ];

        // ---- 分组 4:学习系统 ----
        const learnRows = [
          kdRow("有效完整仓位", "可供学习统计的干净样本", lev ? "ok" : "na", lev ? (QE.num(lev.valid_positions, 0) + " 个") : "未统计"),
          kdRow("排除异常样本", "串价 / 越界 / 会计不一致已剔除", "ok", invalidTrades.length + " 笔被排除"),
          kdRow("正式模型版本", "当前定版版本号", champ ? "ok" : "warn", champ ? String(champ.version) : "尚未定版"),
          kdRow("候选模型状态", "待评估模型", challenger ? "warn" : "na", challenger ? ("待评估 · " + String(challenger.version)) : "无候选"),
          kdRow("最近学习时间", "最近一次模型评估", lastEval ? "ok" : "na", lastEval ? kdClock(lastEval.at || lastEval.created_at) : "暂无记录"),
          kdRow("最近规律漂移", "市场规律是否变化", driftEval ? "warn" : (evalCount ? "ok" : "na"), driftEval ? ("有漂移 · " + kdClock(driftEval.at)) : (evalCount ? "无漂移" : "样本不足")),
          kdRow("自动杠杆状态", "自动杠杆档位与样本门槛", lev ? "ok" : "na", lev ? ("正式 " + QE.num(lev.champion && lev.champion.short, 2) + "x · " + String(lev.status)) : "未评估")
        ];

        // ---- 分组 4.5:资金与决策内核(V16 访问器) ----
        const lastQView = lastQuality ? kdSafe(() => QE.entryQualityView(lastQuality), null) : null;
        const hwmState = hwm ? String(hwm.state || "") : "";
        const hwmStatus = hwm ? ((hwmState === "HARD_STOP") ? "bad" : ((hwmState === "CAUTION" || hwmState === "DEFENSIVE") ? "warn" : "ok")) : (eng ? "warn" : "na");
        const anomalyFirst = anomalies.length ? (anomalies[0].zh || anomalies[0].detail_zh || anomalies[0].code) : null;
        const v16Rows = [
          kdRow("高水位保护", "账户峰值只增不减 · 回撤分级", hwmStatus, hwm ? (String(hwm.state_zh || hwmState || "--") + " · 回撤 " + QE.num(hwm.drawdown_pct, 0) + "%") : "未初始化"),
          kdRow("利润保护池", "保护池不可用于新开仓 / 加仓", pool ? (QE.num(pool.blocked_attempts, 0) > 0 ? "warn" : "ok") : (eng ? "warn" : "na"), pool ? ("已锁定 " + QE.num(pool.protected_balance, 0) + " USDT · 拆分 " + QE.num(pool.splits, 0) + " 次") : "未初始化"),
          kdRow("资金层级", "可交易 / 已占用 / 已锁定", layers ? "ok" : "na", layers ? ("可交易 " + QE.num(layers.tradable_capital, 0) + " · 占用 " + QE.num(layers.reserved_margin, 0) + " · 保护 " + QE.num(layers.protected_profit, 0)) : "未初始化"),
          kdRow("资金预留", "开仓意图的预留与释放", reserve ? (QE.num(reserve.held, 0) > 0 ? "warn" : "ok") : "na", reserve ? ("持有 " + QE.num(reserve.held, 0) + " · 在途 " + QE.num(reserve.open, 0) + " 笔") : "未初始化"),
          kdRow("开仓质量", "概率分布 / 交易成本 / 净边际", lastQView ? "ok" : (eng ? "warn" : "na"), lastQView ? (String(lastQView.decision_zh || "--") + " · 分数 " + QE.num(lastQView.score, 0)) : "暂无记录"),
          kdRow("开仓质量样本", "被记录 / 被跳过的决策", qualityLog.length ? "ok" : (eng ? "warn" : "na"), qualityLog.length ? (qualityLog.length + " 条记录 · 跳过 " + QE.num(qualitySkips, 0) + " 次") : "暂无记录"),
          kdRow("行为异常", "频率 / 费用 / 持仓时长偏离基线", anomalies.length ? "warn" : "ok", anomalies.length ? (anomalies.length + " 项 · " + String(anomalyFirst || "--")) : "无异常"),
          kdRow("决策账本", "精确对账(最小金额单位)", ledgerBad == null ? "na" : (ledgerBad ? "bad" : "ok"), ledgerBad == null ? "未启动" : (ledgerBad ? (ledgerBad + " 项差异") : "账本一致")),
          kdRow("黑匣子", "错误去重 / 面包屑 / 快照", (diagSum && diagSum.length) ? "warn" : (eng ? "ok" : "na"), diagSum ? (diagSum.length + " 类错误待查") : "记录不可用")
        ];

        // ---- 分组 5:运行服务 ----
        const autoStart = (() => { try { return localStorage.getItem("autoStart") !== "false"; } catch (error) { return true; } })();
        const serviceRows = [
          kdRow("后台运行核心", "常驻运行时(前台服务承载)", nativeStat && nativeStat.state ? "ok" : (running ? "ok" : "warn"), nativeStat && nativeStat.state ? String(nativeStat.state) : (running ? "页面内运行" : "未启动")),
          kdRow("前台服务", "页面可见性", document.hidden ? "warn" : "ok", document.hidden ? "后台" : "前台"),
          kdRow("数据库", "本地历史存储", vstate.store ? "ok" : "warn", vstate.store ? "正常" : "内存模式"),
          kdRow("通知", "未读提醒", QE.num(notif.high_unread, 0) > 0 ? "warn" : "ok", "未读 " + QE.num(notif.unread, 0) + " 条"),
          kdRow("崩溃恢复", "启动自检与修复", recView ? (recView.ok === false ? "bad" : "ok") : "na", recView ? String(recView.label || "已运行") : "未运行"),
          kdRow("开机恢复", "自动启动服务", (autoStart && window.__quantNativeShell) ? "ok" : "na", autoStart ? (window.__quantNativeShell ? "已开启" : "已开启(Web 端无效)") : "已关闭"),
          kdRow("数据质量", "脏价 / 过期 / 缺口哨兵", dq.ok ? "ok" : "warn", dqSum || (dq.ok ? "正常" : "存在异常")),
          kdRow("系统健康", "资金账本与账户不变量", (acctIntegrity.ok !== false && (ledgerBad == null || ledgerBad === 0)) ? "ok" : "bad", (acctIntegrity.ok === false ? "账户不变量异常" : "账户口径一致") + (ledgerBad == null ? "" : " · 账本差异 " + ledgerBad + " 项")),
          kdRow("价格完整性", "串价 / 脏价 / 不可能亏损", (QE.num(integrity.price_symbol_mismatch, 0) + QE.num(integrity.invalid_price, 0) + QE.num(integrity.impossible_pnl, 0)) > 0 ? "warn" : (eng ? "ok" : "na"), "串价 " + QE.num(integrity.price_symbol_mismatch, 0) + " · 脏价 " + QE.num(integrity.invalid_price, 0) + " · 越界 " + QE.num(integrity.impossible_pnl, 0))
        ];

        // ---- 分组 6:外部服务 ----
        const externalRows = [
          kdRow("DeepSeek", "关键点智能复核", QE.num(review.calls, 0) > 0 ? "ok" : "na", QE.num(review.calls, 0) > 0 ? ("已复核 " + QE.num(review.calls, 0) + " 次") : "未启用(本地回答)"),
          kdRow("Market Provider", "行情上游", nativeStat && nativeStat.provider ? "ok" : "na", nativeStat && nativeStat.provider ? String(nativeStat.provider) : "本地直连"),
          kdRow("News Provider", "消息与研究来源", bg.research && bg.research.runs > 0 ? "ok" : "warn", bg.research && bg.research.runs > 0 ? "正常" : "待触发"),
          kdRow("Cloud Training", "云端训练", "na", "关闭"),
          kdRow("Cloud Sync", "云端同步", "na", "关闭")
        ];

        const groups = [
          kdGroup("核心引擎", "交易 / 风险 / 仓位 / 保护", coreRows),
          kdGroup("模型与智能", "模型 / 调度 / 学习信号", modelRows),
          kdGroup("市场数据", "行情与外部数据新鲜度", marketRows),
          kdGroup("学习系统", "样本 / 版本 / 漂移 / 杠杆", learnRows),
          kdGroup("资金与决策内核", "高水位 / 保护池 / 预留 / 账本 / 黑匣子", v16Rows),
          kdGroup("运行服务", "运行时 / 存储 / 通知 / 恢复", serviceRows),
          kdGroup("外部服务", "第三方依赖(未启用不假装正常)", externalRows)
        ];
        const allRows = coreRows.concat(modelRows, marketRows, learnRows, v16Rows, serviceRows, externalRows);
        const badCount = allRows.filter((r) => r.dataset && r.dataset.kdStatus === "bad").length;
        const warnCount = allRows.filter((r) => r.dataset && r.dataset.kdStatus === "warn").length;
        const box = $("kernelList");
        box.replaceChildren();
        for (const g of groups) box.appendChild(g);
        const badge = $("kernelBadge");
        if (badge) {
          badge.textContent = badCount ? (badCount + " 项异常") : (warnCount ? (warnCount + " 项注意") : "正常");
          badge.className = "pill " + (badCount ? "red" : (warnCount ? "gray" : "green"));
        }
      }

      function openKernel() {
        const h = tapHandle($("openKernel"), "open:kernel");
        perfMark(h, "nav_requested");
        setActivePage("kernel");
        requestAnimationFrame(() => perfMark(h, "transition"));
        // V16.2s:先让页面(含上一次的只读观测数据)绘制,再异步重算——不为"最新数字"卡住转场
        afterPaint(() => {
          perfMark(h, "first_paint");
          void renderKernel().catch(() => {}).then(() => perfMark(h, "ready"));
        });
      }

      function closeKernel() {
        setActivePage("settings");
      }

      // ================= V16:系统诊断(黑匣子) =================
      async function collectDiag() {
        let eng = null;
        try { eng = await getPaperEngine(); } catch (error) { eng = null; }
        const engineState = eng ? kdSafe(() => String(eng.getState()), "UNKNOWN") : "UNKNOWN";
        const storeOk = (() => { try { return Boolean(vstate.store); } catch (error) { return false; } })();
        const memUsed = (() => { try { return performance && performance.memory ? performance.memory.usedJSHeapSize : null; } catch (error) { return null; } })();
        const nativeStat = (() => { try { return JSON.parse((window.QuantNative && window.QuantNative.runtimeStatus && window.QuantNative.runtimeStatus()) || "{}"); } catch (error) { return {}; } })();
        const meta = {
          app_version: "quant-ui-v16",
          engine_version: QE.ENGINE_VERSION || null,
          schema_version: QE.SCHEMA_VERSION || null,
          model_version: mlUiState.version || null,
          page: currentPage,
          symbol: state.symbol,
          mode: (QE.REAL_TRADING_ENABLED === true || QE.REAL_FUTURES_ENABLED === true) ? "REAL" : "PAPER",
          engine_state: engineState,
          last_market_tick_at: viewState.devMarketTick || null,
          last_risk_tick_at: viewState.devRiskTick || null,
          last_strategy_tick_at: viewState.devStrategyTick || null,
          last_runtime_tick_at: nativeStat && nativeStat.last_tick_at ? nativeStat.last_tick_at : (viewState.devStrategyTick || null),
          database: storeOk ? "ready" : "memory_only",
          memory_used_mb: memUsed == null ? null : Math.round(Number(memUsed) / 1048576),
          network: (navigator && navigator.onLine === false) ? "offline" : "online",
          viewport: window.innerWidth + "x" + window.innerHeight
        };
        let bundle = null;
        try { bundle = eng && typeof eng.diagExport === "function" ? eng.diagExport(meta) : null; } catch (error) { bundle = null; }
        let list = null;
        try { list = eng && typeof eng.diag === "function" ? eng.diag() : null; } catch (error) { list = null; }
        if (list && !Array.isArray(list)) list = null;
        return { eng, engineState, meta, bundle, list, storeOk, memUsed };
      }

      function kdErrorItem(e) {
        const item = vEl("div", "kd-err");
        const top = vEl("div", "kd-err-top");
        top.appendChild(vEl("div", "kd-err-zh" + (e.p0 ? " kd-err-p0" : ""), (e.p0 ? "关键 · " : "") + String(e.zh || "系统异常")));
        top.appendChild(vEl("div", "kd-err-count", String(e.summary_zh || ("同类错误出现 " + QE.num(e.count, 1) + " 次"))));
        item.appendChild(top);
        item.appendChild(vEl("div", "kd-err-id", "故障编号 " + String(e.id || "--") + " · 首次 " + kdClock(e.first_at) + " · 最近 " + kdClock(e.last_at)));
        const details = document.createElement("details");
        details.className = "kd-tech";
        const summary = document.createElement("summary");
        summary.textContent = "技术详情";
        details.appendChild(summary);
        const code = document.createElement("code");
        code.textContent = String(e.technical || "(无技术详情)").slice(0, 2000);
        details.appendChild(code);
        item.appendChild(details);
        return item;
      }

      async function renderDiag() {
        const d = await collectDiag();
        const bundle = d.bundle;
        const errors = bundle && Array.isArray(bundle.errors) ? bundle.errors.slice() : [];
        const p0 = bundle && Array.isArray(bundle.p0_errors) ? bundle.p0_errors.slice() : [];
        const crumbs = bundle && Array.isArray(bundle.breadcrumbs) ? bundle.breadcrumbs.slice(-100) : [];
        const snapshots = bundle && Array.isArray(bundle.snapshots) ? bundle.snapshots : [];
        const localDiag = Array.isArray(window.__quantDiag) ? window.__quantDiag : [];

        // 错误去重列表:每次点击都重新排序(最近发生的在最上面)
        errors.sort((a, b) => QE.num(b.last_at, 0) - QE.num(a.last_at, 0));
        const listBox = $("diagList");
        listBox.replaceChildren();
        if (errors.length) {
          for (const e of errors) listBox.appendChild(kdErrorItem(e));
        } else if (d.list && d.list.length) {
          // diagExport 不可用但 diag() 可用:退化为去重摘要(仍有故障编号与"同类出现 N 次")
          for (const e of d.list) listBox.appendChild(kdErrorItem(e));
        } else if (localDiag.length) {
          listBox.appendChild(vEl("div", "v-note", "引擎未启动,以下为页面级本地记录(同类只显示一条):"));
          const grouped = new Map();
          for (const item of localDiag) {
            const key = String(item && item.tag || "unknown");
            const rec = grouped.get(key) || { tag: key, count: 0, first_at: item && item.at, last_at: item && item.at, message: item && item.message };
            rec.count += 1;
            rec.last_at = Math.max(QE.num(rec.last_at, 0), QE.num(item && item.at, 0));
            rec.first_at = rec.first_at || (item && item.at);
            grouped.set(key, rec);
          }
          for (const rec of grouped.values()) {
            listBox.appendChild(kdErrorItem({
              id: "--",
              zh: String(rec.message || "页面级异常").slice(0, 60),
              count: rec.count,
              first_at: rec.first_at,
              last_at: rec.last_at,
              technical: String(rec.tag) + " · " + String(rec.message || ""),
              p0: false
            }));
          }
        } else {
          listBox.appendChild(vEl("div", "empty-state", "暂无错误记录。系统正常运行时这里保持安静。"));
        }

        // 关键(P0)错误:单独一张卡,没有就整卡隐藏
        const p0Card = $("diagP0Card");
        const p0Box = $("diagP0List");
        p0Box.replaceChildren();
        if (p0.length) {
          for (const e of p0) p0Box.appendChild(kdErrorItem(e));
          p0Card.classList.remove("kd-hide");
        } else {
          p0Card.classList.add("kd-hide");
        }

        // 面包屑时间线(最早的在上,最近的在下)
        const crumbBox = $("diagCrumbs");
        crumbBox.replaceChildren();
        if (crumbs.length) {
          const ul = vEl("ul", "kd-crumbs");
          for (const c of crumbs) {
            const li = vEl("li");
            li.appendChild(vEl("span", "kd-at", kdClock(c && c.at)));
            li.appendChild(vEl("span", "kd-kind", String((c && c.kind) || "event")));
            let detail = c && c.detail;
            if (detail != null && typeof detail === "object") detail = JSON.stringify(detail);
            li.appendChild(vEl("span", null, detail == null ? "" : String(detail).slice(0, 160)));
            ul.appendChild(li);
          }
          crumbBox.appendChild(ul);
        } else {
          crumbBox.appendChild(vEl("div", "empty-state", "暂无关键事件记录。"));
        }

        // Runtime Snapshot 表
        const meta = d.meta;
        const snapRows = [
          ["应用版本", meta.app_version],
          ["运行时版本", String((navigator && navigator.userAgent) || "webview").slice(0, 42)],
          ["引擎版本", String(meta.engine_version || "--")],
          ["模型版本", meta.model_version || "无(规则回退)"],
          ["Schema 版本", String(meta.schema_version || "--")],
          ["当前页", String(meta.page || "--")],
          ["Symbol", String(meta.symbol || "--")],
          ["模式", meta.mode === "PAPER" ? "模拟盘" : "实盘"],
          ["Paper 引擎状态", KERNEL_STATE_ZH[d.engineState] || String(d.engineState)],
          ["最后行情 tick", kdClock(meta.last_market_tick_at)],
          ["最后风控 tick", kdClock(meta.last_risk_tick_at)],
          ["最后策略 tick", kdClock(meta.last_strategy_tick_at)],
          ["最后运行时 tick", kdClock(meta.last_runtime_tick_at)],
          ["数据库", d.storeOk ? "正常" : "内存模式"],
          ["内存", d.memUsed == null ? "不可用" : (Math.round(Number(d.memUsed) / 1048576) + " MB")],
          ["网络", meta.network === "online" ? "在线" : "离线"]
        ];
        const snapBox = $("diagSnapshot");
        snapBox.replaceChildren(vTable(["项目", "值"], snapRows));
        if (snapshots.length) {
          snapBox.appendChild(vEl("div", "v-note", "最近一次完整快照:" + kdClock(snapshots[snapshots.length - 1].at) + " · 共 " + snapshots.length + " 份"));
        }

        const listedCount = errors.length || (d.list ? d.list.length : 0);
        const badge = $("diagBadge");
        if (badge) {
          badge.textContent = listedCount ? (listedCount + " 类") : (localDiag.length ? (localDiag.length + " 条") : "正常");
          badge.className = "pill " + (listedCount || localDiag.length ? "gray" : "green");
        }
        $("diagSummary").textContent = "错误 " + errors.length + " 类(P0 " + p0.length + ") · 面包屑 " + crumbs.length + " 条 · 快照 " + snapshots.length + " 份"
          + (d.storeOk ? "" : " · 数据库为内存模式")
          + ((bundle && bundle.text) ? "" : " · 引擎未启动,导出内容会以页面记录为准");
      }

      async function diagCopy() {
        const note = $("diagActionNote");
        try {
          const d = await collectDiag();
          const text = d.bundle && d.bundle.text ? String(d.bundle.text) : "";
          if (!text) { note.textContent = "暂无可复制的诊断信息(引擎未启动时只会留下页面级记录)。"; return; }
          let ok = false;
          try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
              await navigator.clipboard.writeText(text);
              ok = true;
            }
          } catch (error) { ok = false; }
          if (!ok) {
            try {
              const ta = document.createElement("textarea");
              ta.value = text;
              ta.setAttribute("readonly", "readonly");
              ta.style.position = "fixed";
              ta.style.top = "-1000px";
              ta.style.opacity = "0";
              document.body.appendChild(ta);
              ta.select();
              ok = document.execCommand("copy");
              document.body.removeChild(ta);
            } catch (error) { ok = false; }
          }
          note.textContent = ok ? ("已复制诊断信息(" + text.length + " 字符),可直接粘贴给开发者。") : "复制失败,请改用「导出诊断包」。";
        } catch (error) {
          note.textContent = "复制失败,请改用「导出诊断包」。";
        }
      }

      async function diagExportFile() {
        const note = $("diagActionNote");
        try {
          const d = await collectDiag();
          const bundle = d.bundle;
          let text = bundle && bundle.text ? String(bundle.text) : "";
          if (!text) {
            // 引擎未启动:退化为页面级记录(仍然是纯文本,可直接发出去)
            const localDiag = Array.isArray(window.__quantDiag) ? window.__quantDiag : [];
            const lines = ["========== 系统诊断报告(页面级) ==========", "生成时间: " + new Date().toISOString(), ""];
            for (const item of localDiag.slice(-100)) {
              lines.push("[" + new Date(QE.num(item && item.at, 0)).toISOString() + "] " + String(item && item.tag) + " · " + String(item && item.message || ""));
            }
            lines.push("========== 报告结束 ==========");
            text = lines.join("\n");
          }
          const now = new Date();
          const stamp = now.getFullYear() + String(now.getMonth() + 1).padStart(2, "0") + String(now.getDate()).padStart(2, "0") + "-" + String(now.getHours()).padStart(2, "0") + String(now.getMinutes()).padStart(2, "0");
          const name = "diag-" + stamp + ".txt";
          const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => { try { URL.revokeObjectURL(url); } catch (error) { /* ignore */ } }, 5000);
          note.textContent = "已导出 " + name + "(" + text.length + " 字符,内容已由引擎脱敏)。";
        } catch (error) {
          note.textContent = "导出失败:" + (error && error.message ? error.message : "未知错误");
        }
      }

      function openDiag() {
        const h = tapHandle($("openDiag"), "open:diag");
        perfMark(h, "nav_requested");
        setActivePage("diag");
        requestAnimationFrame(() => perfMark(h, "transition"));
        afterPaint(() => {
          perfMark(h, "first_paint");
          void renderDiag().catch(() => {}).then(() => perfMark(h, "ready"));
        });
      }

      function closeDiag() {
        setActivePage("settings");
      }

      // ================= 开发用性能浮层(默认不可见) =================
      // 只有 localStorage.quant_dev_overlay === "1" 或 URL 带 ?dev=1 时才显示;
      // 采集逻辑全部 try/catch,关闭时断开 observer 并停止 rAF,不留下常驻开销。
      const DEV_OV = {
        enabled: false, collapsed: false, observer: null, raf: 0,
        frames: 0, fps: 0, lastFpsAt: 0, longTasks: 0, timers: 0, listeners: 0,
        wrappedTimers: false, wrappedListeners: false, memPeakMb: 0, timerIds: new Map()
      };

      function devOvRequested() {
        try {
          if (localStorage.getItem("quant_dev_overlay") === "1") return true;
          return /[?&]dev=1(&|$)/.test(String(window.location.search || ""));
        } catch (error) { return false; }
      }

      function devTick(kind) {
        try {
          const at = Date.now();
          if (kind === "market") viewState.devMarketTick = at;
          else if (kind === "risk") viewState.devRiskTick = at;
          else viewState.devStrategyTick = at;
        } catch (error) { /* 仅开发观测,失败不影响主流程 */ }
      }

      function devOvWrapTimers() {
        if (DEV_OV.wrappedTimers) return;
        DEV_OV.wrappedTimers = true;
        try {
          const rawSetTimeout = window.setTimeout.bind(window);
          const rawSetInterval = window.setInterval.bind(window);
          const rawClearTimeout = window.clearTimeout.bind(window);
          const rawClearInterval = window.clearInterval.bind(window);
          window.setTimeout = function (fn, ms) {
            if (typeof fn !== "function") return rawSetTimeout.apply(null, arguments);
            const extra = Array.prototype.slice.call(arguments, 2);
            let id = null;
            let done = false;
            const finish = function () { if (done) return; done = true; DEV_OV.timers -= 1; if (id != null) DEV_OV.timerIds.delete(id); };
            const wrapped = function () { finish(); return fn.apply(this, arguments); };
            DEV_OV.timers += 1;
            id = rawSetTimeout.apply(null, [wrapped, ms].concat(extra));
            DEV_OV.timerIds.set(id, finish);
            return id;
          };
          window.setInterval = function (fn, ms) {
            if (typeof fn !== "function") return rawSetInterval.apply(null, arguments);
            const extra = Array.prototype.slice.call(arguments, 2);
            const wrapped = function () { return fn.apply(this, arguments); };
            DEV_OV.timers += 1;
            const id = rawSetInterval.apply(null, [wrapped, ms].concat(extra));
            DEV_OV.timerIds.set(id, function () { DEV_OV.timers -= 1; });
            return id;
          };
          window.clearTimeout = function (id) {
            const f = DEV_OV.timerIds.get(id);
            if (f) { try { f(); } catch (error) { /* ignore */ } }
            DEV_OV.timerIds.delete(id);
            return rawClearTimeout(id);
          };
          window.clearInterval = function (id) {
            const f = DEV_OV.timerIds.get(id);
            if (f) { try { f(); } catch (error) { /* ignore */ } }
            DEV_OV.timerIds.delete(id);
            return rawClearInterval(id);
          };
        } catch (error) { /* 计数包装失败:浮层少一个数字,不影响页面 */ }
      }

      function devOvWrapListeners() {
        if (DEV_OV.wrappedListeners) return;
        DEV_OV.wrappedListeners = true;
        try {
          const rawAdd = window.addEventListener.bind(window);
          const rawRemove = window.removeEventListener.bind(window);
          window.addEventListener = function () { DEV_OV.listeners += 1; return rawAdd.apply(null, arguments); };
          window.removeEventListener = function () { DEV_OV.listeners -= 1; if (DEV_OV.listeners < 0) DEV_OV.listeners = 0; return rawRemove.apply(null, arguments); };
        } catch (error) { /* 计数失败不影响功能 */ }
      }

      function devOvCreateLongTaskObserver() {
        if (typeof PerformanceObserver !== "function") return null;
        try {
          const obs = new PerformanceObserver((list) => {
            try { DEV_OV.longTasks += list.getEntries().length; } catch (error) { /* ignore */ }
          });
          obs.observe({ entryTypes: ["longtask"] });
          return obs;
        } catch (error) { return null; }
      }

      function devOvMemory() {
        try {
          if (!performance || !performance.memory) return null;
          return Math.round(Number(performance.memory.usedJSHeapSize) / 1048576);
        } catch (error) { return null; }
      }

      function devOvRows() {
        const mem = devOvMemory();
        if (mem != null && mem > DEV_OV.memPeakMb) DEV_OV.memPeakMb = mem;
        const lastTick = (() => {
          try {
            const s = JSON.parse((window.QuantNative && window.QuantNative.runtimeStatus && window.QuantNative.runtimeStatus()) || "{}");
            return s.last_tick_at || viewState.devStrategyTick || 0;
          } catch (error) { return viewState.devStrategyTick || 0; }
        })();
        return [
          ["FPS", DEV_OV.fps ? String(DEV_OV.fps) : "--"],
          ["Long Task", String(DEV_OV.longTasks) + (DEV_OV.observer ? "" : "(不支持)")],
          ["内存", mem == null ? "不可用" : (mem + " MB · 峰值 " + DEV_OV.memPeakMb + " MB")],
          ["活跃 timer", String(DEV_OV.timers)],
          ["window listener", String(DEV_OV.listeners)],
          ["Chart 实例", String(document.querySelectorAll("canvas").length)],
          ["Paper 引擎", String(window.__quantEngineInstances || 0)],
          ["最后运行时 tick", kdClock(lastTick)]
        ];
      }

      function devOvRender() {
        const body = $("devOverlayBody");
        if (!body) return;
        body.replaceChildren();
        // 状态点在浮层里只是排版占位(灰点),不表达健康度
        for (const pair of devOvRows()) body.appendChild(kdRow(pair[0], null, "na", pair[1]));
      }

      function devOvFrame() {
        if (!DEV_OV.enabled) return;
        DEV_OV.frames += 1;
        const now = Date.now();
        if (!DEV_OV.lastFpsAt) DEV_OV.lastFpsAt = now;
        if (now - DEV_OV.lastFpsAt >= 1000) {
          DEV_OV.fps = Math.round(DEV_OV.frames * 1000 / Math.max(1, now - DEV_OV.lastFpsAt));
          DEV_OV.frames = 0;
          DEV_OV.lastFpsAt = now;
          devOvRender();
        }
        DEV_OV.raf = window.requestAnimationFrame(devOvFrame);
      }

      function devOvSetEnabled(on) {
        DEV_OV.enabled = Boolean(on);
        try { localStorage.setItem("quant_dev_overlay", DEV_OV.enabled ? "1" : "0"); } catch (error) { /* 存储不可用则仅本次生效 */ }
        const sw = $("devOverlayToggle");
        if (sw) sw.classList.toggle("on", DEV_OV.enabled);
        const box = $("devOverlay");
        if (!box) return;
        box.classList.toggle("kd-hide", !DEV_OV.enabled);
        box.setAttribute("aria-hidden", DEV_OV.enabled ? "false" : "true");
        if (DEV_OV.enabled) {
          devOvWrapTimers();
          devOvWrapListeners();
          if (!DEV_OV.observer) DEV_OV.observer = devOvCreateLongTaskObserver();
          DEV_OV.frames = 0;
          DEV_OV.lastFpsAt = 0;
          devOvRender();
          if (!DEV_OV.raf) DEV_OV.raf = window.requestAnimationFrame(devOvFrame);
        } else {
          if (DEV_OV.raf) { try { window.cancelAnimationFrame(DEV_OV.raf); } catch (error) { /* ignore */ } DEV_OV.raf = 0; }
          if (DEV_OV.observer) { try { DEV_OV.observer.disconnect(); } catch (error) { /* ignore */ } DEV_OV.observer = null; }
        }
      }

      function initDevOverlay() {
        try {
          const collapse = $("devOverlayCollapse");
          if (collapse) {
            collapse.addEventListener("click", () => {
              DEV_OV.collapsed = !DEV_OV.collapsed;
              const box = $("devOverlay");
              if (box) box.classList.toggle("collapsed", DEV_OV.collapsed);
              collapse.textContent = DEV_OV.collapsed ? "展开" : "收起";
            });
          }
          const sw = $("devOverlayToggle");
          if (sw) sw.addEventListener("click", () => { devOvSetEnabled(!DEV_OV.enabled); });
          devOvSetEnabled(devOvRequested());
        } catch (error) { /* 浮层初始化失败不影响主流程 */ }
      }

      function initNetworkBar() {
        const sync = () => {
          const offline = navigator && navigator.onLine === false;
          $("offlineBar").classList.toggle("hidden", !offline);
        };
        window.addEventListener("online", sync);
        window.addEventListener("offline", sync);
        sync();
      }

      // ---- AI Chat ----
      // ---- V15 AI Chat:界面不常驻,记录按 symbol 保留,DeepSeek 不常驻 ----
      const chatSessions = QE.createChatSessionStore({ now: () => Date.now() });
      let chatActiveSymbol = null;      // 当前会话对应的 symbol(禁止用 BTC 的上下文答 ETH 的问题)
      let chatLoadingBubble = null;     // 在途回答气泡(关闭时必须移除)
      let chatPushedHistory = false;    // 是否压过 history(用于系统返回手势关闭)
      const chatKeyOf = (symbol) => QE.sessionKeyOf(symbol || "GENERAL");

      function loadChatSessions() {
        try {
          const raw = localStorage.getItem("chatSessions");
          if (raw) chatSessions.loadFrom(JSON.parse(raw));
        } catch (error) { diagLog("chat-load", error); }
      }
      function saveChatSessions() {
        try { localStorage.setItem("chatSessions", JSON.stringify(chatSessions.toJSON())); } catch (error) { /* 存储不可用则仅内存保留 */ }
      }

      // 用会话记录渲染消息(不做任何网络/引擎初始化 —— 重开是"恢复",不是"重建")
      function renderChatMessages(symbol) {
        const body = $("chatBody");
        body.replaceChildren();
        chatLoadingBubble = null;
        for (const m of chatSessions.messages(chatKeyOf(symbol))) chatPush(m.role, m.text);
      }

      function chatPush(role, textContent) {
        const body = $("chatBody");
        const el = vEl("div", "msg" + (role === "me" ? " me" : ""), textContent);
        body.appendChild(el);
        body.scrollTop = body.scrollHeight;
        return el;
      }

      // §50:先放一个 Loading 气泡,最终【只替换成一条】回答(远程成功→远程;失败→本地)
      function chatPushLoading() {
        const body = $("chatBody");
        const el = vEl("div", "msg ai loading", "正在思考...");
        body.appendChild(el);
        body.scrollTop = body.scrollHeight;
        chatLoadingBubble = el;
        return el;
      }

      function openChat() {
        const symbol = viewState.detailSymbol || null;
        const key = chatKeyOf(symbol);
        chatActiveSymbol = symbol;
        const vm = QE.chatViewModel({ detail: viewState.lastDetail || {} });
        $("chatTitle").textContent = "AI 分析";
        // 头部只显示:当前 symbol(+ 有仓位时的一句持仓摘要)。不放"风险 undefined"这类半成品字段。
        const posLine = vm.position_line && !/undefined|null/.test(vm.position_line) ? vm.position_line : "";
        $("chatContext").textContent = (symbol ? String(symbol).replace("USDT", "/USDT") : "账户") + (posLine ? " · " + posLine : "");
        $("chatMask").classList.add("open");
        $("chatSheet").classList.add("open");
        $("chatSheet").classList.remove("closing");
        // 恢复最近会话(不重新初始化整个 Coin Detail)
        const session = chatSessions.get(key);
        if (!session || !chatSessions.messages(key).length) {
          $("chatBody").replaceChildren();   // 空会话:先清空再放问候(避免每次开都叠一层)
          chatPush("ai", "我可以基于本地真实数据回答:方向与置信、风险、是否适合短线或长线、预计持有区间、为什么观望、什么条件会退出。");
          const box = $("chatBody");
          const chips = vEl("div", "chip-row");
          for (const q of vm.suggestions.slice(0, 5)) {
            const btn = vEl("button", "chip", q);
            btn.type = "button";
            btn.addEventListener("click", () => { $("chatInput").value = q; void sendChat(); });
            chips.appendChild(btn);
          }
          box.appendChild(chips);
        } else {
          renderChatMessages(symbol);
        }
        // V16.2:返回拦截统一由导航哨兵处理(Sheet 打开 → 哨兵自动武装)
        updateBackTrap();
      }

      // 关闭 = 真正收起:中断聊天请求 + 移除在途气泡 + 停动画 + 落库记录。
      // Paper Engine / 行情 / 风控 / 持仓管理 / 学习 一律不受影响(它们有自己的任务与键)。
      function closeChat(options) {
        const o = options || {};
        $("chatMask").classList.remove("open");
        $("chatSheet").classList.add("closing");
        $("chatSheet").classList.remove("open");
        chatActiveSymbol = null;
        if (chatLoadingBubble && chatLoadingBubble.parentNode) chatLoadingBubble.parentNode.removeChild(chatLoadingBubble);
        chatLoadingBubble = null;
        // 只中断"用户聊天请求";后台决策复核走 "paper" 键,不受影响
        RM.leave("chat");
        saveChatSessions();
        chatPushedHistory = false;
        updateBackTrap();
      }

      function chatIsOpen() {
        return Boolean($("chatSheet") && $("chatSheet").classList.contains("open"));
      }

      async function sendChat() {
        const input = $("chatInput");
        const question = String(input.value || "").trim();
        if (!question) return;
        // 切币保护:上下文必须与提问的币一致,否则先关闭旧会话(禁止用 BTC 上下文回答 ETH)
        const symbolNow = viewState.detailSymbol || null;
        if (chatIsOpen() && chatActiveSymbol !== symbolNow) {
          closeChat();
          toast("已按当前币种切换会话,请重新提问", "error");
          return;
        }
        input.value = "";
        const key = chatKeyOf(symbolNow);
        chatSessions.append(key, symbolNow, { role: "me", text: question });
        chatPush("me", question);
        const eng = await getPaperEngine();
        const snapshot = eng.snapshot();
        const strategy = (() => {
          const trades = eng.getTrades();
          const sum = (mode) => QE.summarizeTrades(trades.filter((t) => t.mode === mode));
          return { short: sum("short"), long: sum("long") };
        })();
        const context = QE.buildChatContext({
          symbol: viewState.detailSymbol,
          interval: viewState.detailInterval,
          mode: viewState.detailInterval === "4h" || viewState.detailInterval === "1d" ? "long" : "short",
          analysis: viewState.lastAnalysis || {},
          risk: viewState.lastDetail ? { risk_level: viewState.lastDetail.risk_level, risk_score: viewState.lastDetail.risk_score } : {},
          position: viewState.lastDetail ? viewState.lastDetail.position : null,
          decision: viewState.lastDetail ? { action: viewState.lastDetail.strategy, score: null, reason: "" } : null,
          strategyStats: strategy,
          portfolio: snapshot,
          // V14.4:把预测/外部情报/回撤/利润保护一并交给本地问答(§75)
          prediction: viewState.lastPrediction || null,
          external: viewState.lastExternal || null,
          drawdown: viewState.lastDrawdown || null,
          profitLock: (() => {
            const raw = viewState.lastPositionRaw;
            if (!raw || raw.status !== "OPEN") return null;
            const price = QE.num(raw.current_price, raw.entry_price);
            const atrAbs = viewState.lastAnalysis && viewState.lastAnalysis.volatility ? QE.num(viewState.lastAnalysis.volatility.atrPct) / 100 * price : 0;
            const gb = QE.givebackOf(raw, price, { atr: atrAbs });
            const dec = QE.profitLockDecision({
              position: raw, price, atr: atrAbs,
              trend_strength: viewState.lastAnalysis && viewState.lastAnalysis.market_regime && viewState.lastAnalysis.market_regime.trend_market ? 0.65 : 0.4,
              reversal_risk: 0.35
            });
            return QE.profitLockView({ stage: dec.stage, giveback: gb, partial_fraction: dec.fraction, trailing_distance: dec.trail ? dec.trail.distance : null });
          })()
        });
        // §48-§52:把【用户真实问题】+ 出站白名单上下文(含最近摘要与决策日志)交给服务端;最终只显示一个回答
        const journalNotes = eng.journalContextForChat(question, { symbols: candidateSymbols(), defaultSymbol: symbolNow, limit: 4 });
        const outbound = outboundChatContext(buildChatPayload(question, context), symbolNow, journalNotes);
        const loading = chatPushLoading();
        const final = await chatSingleAnswer(question, outbound);
        chatSessions.append(key, symbolNow, { role: "ai", text: final.text, source: final.source });
        saveChatSessions();
        // 界面可能已在生成期间被关闭:此时不再写 DOM(避免"关掉了还继续显示")
        if (!chatIsOpen() || !loading.parentNode) return;
        loading.textContent = final.text;
        if (final.source !== "deepseek" && final.reason && final.reason !== "no_server_key") {
          diagLog("chat-ai-fallback", new Error(String(final.reason)));
        }
        $("chatBody").scrollTop = $("chatBody").scrollHeight;
      }

      // 发给服务端的最小可用上下文(§49:position/leverage/margin/notional/liq/pnl/预测/风险/情报)
      function buildChatPayload(question, context) {
        const raw = viewState.lastPositionRaw;
        const pred = viewState.lastPrediction && viewState.lastPrediction.predictions ? (viewState.lastPrediction.predictions[viewState.detailInterval] || viewState.lastPrediction.predictions["1h"]) : null;
        const ext = viewState.lastExternal;
        return {
          question,
          context: {
            symbol: viewState.detailSymbol,
            interval: viewState.detailInterval,
            mode: (context && context.mode) || "short",
            price: context && context.price,
            direction: context && context.direction,
            confidence: context && context.confidence,
            regime: context && context.regime,
            risk_level: context && context.risk_level,
            risk_score: context && context.risk_score,
            position: raw && raw.status === "OPEN" ? {
              mode: raw.mode,
              side: raw.side,
              entry_price: raw.entry_price,
              current_price: raw.current_price,
              leverage: raw.leverage,
              margin: raw.entry_notional,
              notional: raw.notional,
              liquidation_price: raw.liquidation_price,
              unrealized_pnl: raw.unrealized_pnl,
              realized_pnl: raw.realized_pnl,
              holding_ms: Math.max(0, Date.now() - QE.num(raw.entry_time, Date.now())),
              pnl_pct: QE.num(raw.entry_notional, 0) > 0 ? QE.round(QE.num(raw.unrealized_pnl, 0) / QE.num(raw.entry_notional, 1) * 100, 4) : null
            } : null,
            prediction: pred ? {
              horizon: pred.horizon || viewState.detailInterval,
              bullish_probability: pred.bullish_probability,
              neutral_probability: pred.neutral_probability,
              bearish_probability: pred.bearish_probability,
              expected_move_pct: pred.expected_move_pct,
              expected_range_pct: pred.expected_range_pct,
              reversal_risk: pred.reversal_risk,
              confidence: pred.confidence,
              uncertainty: pred.uncertainty
            } : null,
            profit_lock: context && context.profitLock ? {
              stage: QE.num(context.profitLock.stage, 0),
              max_unrealized_pnl: QE.num(String(context.profitLock.max_unrealized_text || "0").replace(" USDT", ""), 0),
              current_pnl: QE.num(String(context.profitLock.current_text || "0").replace(" USDT", ""), 0),
              giveback_pct: QE.num(String(context.profitLock.giveback_text || "0%").replace(/^.*\(/, "").replace("%)", ""), 0),
              trailing_distance: QE.num(context.profitLock.trailing_text, null)
            } : null,
            drawdown: viewState.lastDrawdown ? { state: viewState.lastDrawdown.state, account_pct: QE.num(String(viewState.lastDrawdown.account_dd_text || "0").replace("%", ""), 0), daily_pct: QE.num(String(viewState.lastDrawdown.daily_dd_text || "0").replace("%", ""), 0) } : null,
            external: ext ? {
              funding_rate: ext.funding_context && ext.funding_context.available ? ext.funding_context.rate : null,
              funding_extreme: Boolean(ext.funding_context && ext.funding_context.extreme),
              oi_interpretation: ext.oi_context ? ext.oi_context.interpretation : null,
              long_short_ratio: ext.positioning_context && ext.positioning_context.available ? ext.positioning_context.long_short_ratio : null,
              taker_imbalance: ext.taker_context && ext.taker_context.available ? ext.taker_context.imbalance : null,
              stress_level: ext.market_stress_context ? ext.market_stress_context.level : null,
              news_sentiment: ext.news_context && ext.news_context.available ? ext.news_context.sentiment : null,
              news_conflicted: Boolean(ext.news_context && ext.news_context.conflicted),
              news_summary: ext.news_context && ext.news_context.available && ext.news_context.items && ext.news_context.items[0] ? String(ext.news_context.items[0].title || "").slice(0, 200) : null,
              unavailable: (ext.overall && ext.overall.unavailable ? ext.overall.unavailable : []).map((u) => u.type)
            } : null,
            strategy: context && context.strategy ? {
              short_net_pnl: QE.num(context.strategy.short && context.strategy.short.net_pnl, null),
              long_net_pnl: QE.num(context.strategy.long && context.strategy.long.net_pnl, null),
              short_trades: QE.num(context.strategy.short && context.strategy.short.trades, null),
              long_trades: QE.num(context.strategy.long && context.strategy.long.trades, null)
            } : null,
            exit_policy: "profit-lock-v14.4"
          }
        };
      }

      // V15:出站上下文整形(白名单 + 最近摘要)。历史消息结构上不可能被发送。
      function outboundChatContext(richContext, symbol, journalNotes) {
        const key = chatKeyOf(symbol);
        const enriched = journalNotes && journalNotes.length ? { ...richContext, journal: journalNotes } : richContext;
        return QE.limitOutboundContext(enriched, { summary: chatSessions.summary(key), conversation_id: key });
      }

      // ---- Paper 自动 Loop(V14.5:Short + Long 双姿势真正自己跑,切页不停) ----
      // §7:两种模式各自 Wallet / Position / Risk / Statistics / Learning / Leverage / Exit Policy
      // §8/§9:Entry 标识一律用【已收盘K线时间】,绝不用 Date.now()
      // §10:防重入(引擎内 loopRunning + 页面 loopRunning 双保险,try/finally 释放)
      let loopRunning = false;
      const BG_KEYS = ["bgdata", "research", "learning", "sync"];

      function intervalMsOf(tf) {
        return QE.INTERVAL_MS && QE.INTERVAL_MS[tf] ? QE.INTERVAL_MS[tf] : 3600000;
      }

      // 候选币池:详情页币 + 自选 + 主流币(去重后限量,避免请求失控)
      function candidateSymbols() {
        return [...new Set([viewState.detailSymbol, ...state.watch, ...MARKET_SYMBOLS.slice(0, 4)])].filter(Boolean).slice(0, 6);
      }

      // 后台外部情报更新:与 UI 解耦(§17/§73),DataHub 统一缓存(§18)
      async function refreshExternalForSymbols(eng, symbols, signal) {
        const updated = [];
        for (const symbol of symbols) {
          try {
            const ext = await loadExternalBundle(symbol, signal);
            if (!ext) continue;
            viewState.lastExternalBySymbol[symbol] = ext;
            viewState.lastExternal = ext;
            if (eng) {
              eng.observeExternalContext(ext);
              const f = ext.funding_context;
              if (f && f.available && f.rate != null) {
                eng.observeFunding(symbol, { symbol, lastFundingRate: f.rate, provider: "binance" }, {});
              }
            }
            updated.push(symbol);
          } catch (error) {
            if (!isAborted(error)) diagLog("bg-external", error);
          }
        }
        return updated;
      }

      // 外部情报打包(经 DataHub:TTL 内不重复请求)
      async function loadExternalBundle(symbol, signal) {
        const grabs = await Promise.all([
          hubGrab(symbol, "funding", "funding?market=futures&symbol=" + symbol, QE.DATA_TTLS.funding, signal),
          hubGrab(symbol, "open_interest", "open_interest?market=futures&symbol=" + symbol + "&period=5m", QE.DATA_TTLS.open_interest, signal),
          hubGrab(symbol, "long_short", "long_short?market=futures&symbol=" + symbol + "&period=5m", QE.DATA_TTLS.long_short_ratio, signal),
          hubGrab(symbol, "taker", "taker?market=futures&symbol=" + symbol + "&period=5m", QE.DATA_TTLS.taker_flow, signal)
        ]);
        const [fundingRaw, oiRaw, ls, taker] = grabs;
        if (!fundingRaw && !oiRaw && !ls && !taker) return null;
        const fundingNorm = fundingRaw && fundingRaw.lastFundingRate != null ? QE.normalizeFunding(fundingRaw, {}) : null;
        const funding = fundingNorm ? { rate: fundingNorm.rate, provider: fundingNorm.provider } : { reason: "funding_unavailable" };
        const oiNorm = oiRaw && oiRaw.open_interest != null ? { ...oiRaw } : oiRaw;
        if (oiNorm && oiNorm.open_interest != null && oiNorm.prev_open_interest == null) {
          const prev = viewState.lastOi[symbol];
          if (prev != null) oiNorm.prev_open_interest = prev;
          viewState.lastOi[symbol] = oiNorm.open_interest;
        }
        return QE.buildExternalContext({
          now: Date.now(),
          funding,
          oi: oiNorm,
          positioning: ls,
          taker,
          news: viewState.lastNewsItems && viewState.lastNewsItems.length ? viewState.lastNewsItems : null,
          news_reason: viewState.lastNewsReason || "no_news_provider"
        });
      }

      async function hubGrab(symbol, dataType, path, ttlMs, signal) {
        const key = { provider: "binance", symbol, data_type: dataType, interval: "5m" };
        const cached = externalHub.get(key);
        if (cached.ok) return cached.value;
        try {
          const raw = await api(path, 1, 8000, signal);
          externalHub.set(key, raw, { ttl: ttlMs, source: "binance-fapi", symbol, data_type: dataType });
          return raw;
        } catch (error) {
          if (!isAborted(error)) diagLog("external-" + dataType, error);
          externalHub.markUnavailable(key, isAborted(error) ? "aborted" : shortError(error), { ttl: 5000, symbol, data_type: dataType });
          return null;
        }
      }

      // ---- §30-§39:Research Agent 接真实来源(OKX 官方公告 + CoinTelegraph RSS) ----
      const researchAgent = QE.createResearchAgent({
        now: () => Date.now(),
        timeoutMs: 9000,
        fetchFn: async () => {
          const out = [];
          const req = RM.begin("research");
          // 官方来源优先(交易所公告)
          try {
            const ann = await api("announcements?limit=10", 1, 9000, req.signal);
            for (const item of (ann && ann.items) || []) {
              const s = QE.scoreHeadline(item);
              out.push({ ...item, ...s, source_id: "okx_official", source_kind: "exchange" });
            }
          } catch (error) {
            if (!isAborted(error)) diagLog("research-announcements", error);
          }
          // 可靠金融媒体
          try {
            const news = await api("news?limit=12", 1, 12000, req.signal);
            for (const item of (news && news.items) || []) {
              const s = QE.scoreHeadline(item);
              out.push({ ...item, ...s, source_id: "cointelegraph", source_kind: "reputable_media" });
            }
          } catch (error) {
            if (!isAborted(error)) diagLog("research-news", error);
          }
          if (!out.length) throw new Error("no_news_provider");
          return out;
        }
      });

      // 触发条件:只在真正需要时联网(§32)
      async function refreshResearch(eng, options) {
        const opts = options || {};
        const snapshot = eng ? eng.snapshot() : null;
        const positions = eng ? eng.getPositions().filter((p) => p.status === "OPEN") : [];
        const detail = viewState.lastAnalysis || {};
        const lastTrigger = viewState.lastResearchAt || 0;
        const trigger = QE.shouldResearch({
          price_change_pct: detail.change24h,
          volatility_ratio: detail.volatility ? detail.volatility.ratio : 1,
          rule_ml_conflict: false,
          opening: positions.length === 0,
          leverage: positions.length ? Math.max(...positions.map((p) => QE.num(p.leverage, 1))) : 1,
          position_at_risk: positions.some((p) => QE.num(p.unrealized_pnl, 0) < 0),
          regime_changed: viewState.lastRegime && detail.market_regime ? viewState.lastRegime !== detail.market_regime.label : false,
          scheduled_due: true,
          ms_since_last_research: Date.now() - lastTrigger
        });
        if (!trigger.research && !opts.force) return { ok: false, reason: "no_trigger", skipped: true };
        viewState.lastResearchAt = Date.now();
        const res = await researchAgent.run({ symbol: viewState.detailSymbol, trigger_ids: trigger.trigger_ids, price_change_pct: detail.change24h, volatility_ratio: detail.volatility ? detail.volatility.ratio : 1, opening: positions.length === 0 });
        const read = researchAgent.read();
        const ctx = QE.researchContext(read, { now: Date.now() });
        viewState.lastResearch = ctx;
        if (ctx.available) {
          viewState.lastNewsItems = (read.results || []).map((x) => ({ title: x.summary, summary: x.summary, published_at: x.published_at, sentiment: x.sentiment, importance: x.importance, confidence: x.confidence, source_quality: x.source_quality, source_kind: x.source_kind }));
          viewState.lastNewsReason = "live";
        } else {
          viewState.lastNewsReason = ctx.reason || "unavailable";
        }
        void snapshot;
        return res;
      }

      // ---- §21-§29:Future Predictor 真正生成 + 存档 + 结算(运行时,不是只在 UI) ----
      async function refreshPredictions(eng, analysisBySymbol) {
        const out = {};
        const now = Date.now();
        for (const [symbol, analysis] of Object.entries(analysisBySymbol || {})) {
          if (!analysis) continue;
          try {
            const multi = QE.predictMultiHorizon({ analysis, external: viewState.lastExternalBySymbol[symbol] || viewState.lastExternal || null, now });
            out[symbol] = multi;
            if (eng) {
              // §21:至少存档 short(1h) 与 long(4h) 两条,供到期结算与校准
              for (const h of ["1h", "4h"]) {
                const p = multi.predictions[h];
                if (p) await eng.savePrediction(p, { symbol, timestamp: now, price: analysis.price });
              }
            }
          } catch (error) {
            diagLog("predict", error);
          }
        }
        viewState.lastPredictionBySymbol = out;
        const focus = out[viewState.detailSymbol];
        if (focus) viewState.lastPrediction = focus;
        return out;
      }

      async function settlePredictions(eng, quotes) {
        try {
          const resolved = await eng.resolveDuePredictions({
            now: Date.now(),
            atrPct: viewState.lastAnalysis && viewState.lastAnalysis.volatility ? QE.num(viewState.lastAnalysis.volatility.atrPct, 1) : 1,
            priceOf: (symbol) => (quotes && quotes[symbol] ? quotes[symbol].price : viewState.lastTickers && viewState.lastTickers.length ? undefined : undefined)
          });
          if (resolved.length) viewState.resolvedPredictions = (viewState.resolvedPredictions || 0) + resolved.length;
          return resolved.length;
        } catch (error) {
          diagLog("predict-resolve", error);
          return 0;
        }
      }

      // ---- §3 行情对象必须带 symbol:统一在这里构建 symbol→quote 映射,全页面只有这一处 ----
      function buildQuotesFromTickers(tickers, source) {
        const quotes = {};
        for (const t of tickers || []) {
          if (!t || !t.symbol) continue;                 // 没有 symbol 的行情一律丢弃,绝不按下标对齐
          const price = Number(t.lastPrice);
          if (!Number.isFinite(price) || price <= 0) continue;
          const high = Number(t.highPrice == null ? t.lastPrice : t.highPrice);
          const low = Number(t.lowPrice == null ? t.lastPrice : t.lowPrice);
          quotes[String(t.symbol)] = {
            symbol: String(t.symbol),
            price,
            high: Number.isFinite(high) && high > 0 ? high : price,
            low: Number.isFinite(low) && low > 0 ? low : price,
            received_at: Date.now(),
            provider: "binance",
            source: source || "last"
          };
        }
        return quotes;
      }

      // ---- §12/§13 价格刷新即评估:只取持仓相关 symbol(单币接口),20 秒一轮把
      // 强平/止损/移动止损/止盈跑掉,不再等下一根 1h K线;拿不到就跳过,绝不猜价。
      async function refreshPositionRisk() {
        const eng = await getPaperEngine();
        const open = eng.getPositions().filter((p) => p.status === "OPEN");
        if (!open.length) return { ok: true, skipped: "no_open_positions" };
        const symbols = [...new Set(open.map((p) => p.symbol))];
        const req = RM.begin("risk");
        const quotes = {};
        for (const sym of symbols) {
          try {
            const res = await api("ticker?market=futures&symbol=" + encodeURIComponent(sym), 1, 6000, req.signal);
            const row = Array.isArray(res) ? res[0] : res;
            if (!row || !row.symbol) continue;
            // §3:返回 symbol 必须等于请求 symbol,否则整条丢弃(宁可不更新,也不串价)
            if (String(row.symbol).toUpperCase() !== String(sym).toUpperCase()) continue;
            const q = buildQuotesFromTickers([row], "mark")[String(row.symbol)];
            if (q) quotes[sym] = q;
          } catch (error) {
            diagLog("position-risk", error);
          }
        }
        if (!Object.keys(quotes).length) return { ok: false, reason: "no_quotes" };
        const res = await eng.riskPass({ quotes, now: Date.now() });
        devTick("risk");
        if (res && ((res.exits && res.exits.length) || (res.skipped && res.skipped.length))) {
          await renderPaperPage();
          await renderHome();
          if (res.exits.length) await renderNotifications();
        }
        return res;
      }

      // ---- §4-§6:每轮顺序 UPDATE MARKET → EXISTING POSITIONS → EXIT FIRST → SHORT → LONG → RISK → DECISION → ORDER ----
      async function paperLoopTick(options) {
        const opts = options || {};
        const eng = await getPaperEngine();
        if (eng.getState() !== "RUNNING") return { ok: false, reason: "engine_not_running" };
        if (loopRunning && !opts.force) return { ok: false, reason: "loop_reentry_blocked" };   // §10
        loopRunning = true;
        devTick("strategy");
        const loopReq = RM.begin("paper");
        const summary = { short_candidates: 0, long_candidates: 0, opened: 0, exits: 0, blocked: [] };
        try {
          // 1) 行情
          const tickers = await api("tickers?market=futures", 1, 9000, loopReq.signal);
          const quotes = buildQuotesFromTickers(tickers);
          observeFundingFromTickers(eng, tickers);
          const symbols = candidateSymbols();
          // 2) 外部情报 + 研究(后台,失败不影响主循环 §20)
          await refreshExternalForSymbols(eng, symbols, loopReq.signal);
          void refreshResearch(eng, {});
          // 3) 预测(每轮刷新,真正进 runtime)
          const analysisBySymbol = {};
          const candles = { short: QE.closedCandleTime(Date.now(), intervalMsOf(MODE_INTERVAL.short)), long: QE.closedCandleTime(Date.now(), intervalMsOf(MODE_INTERVAL.long)) };
          const candidates = [];
          for (const symbol of symbols) {
            if (!quotes[symbol] || !(quotes[symbol].price > 0)) continue;
            // Short:主 Decision Candle = 1h 已收盘;Long:主 Decision Candle = 4h 已收盘
            for (const mode of ["short", "long"]) {
              const tf = MODE_INTERVAL[mode];
              let analysis = null;
              try {
                analysis = await api("analyze?symbol=" + symbol + "&interval=" + tf, 1, 15000, loopReq.signal);
              } catch (error) {
                if (!isAborted(error)) diagLog("loop-analyze-" + mode, error);
                continue;
              }
              if (!analysis) continue;
              analysisBySymbol[symbol] = analysisBySymbol[symbol] || analysis;
              viewState.lastAnalysesBySymbol[symbol] = analysis;
              const risk = QE.evaluateRisk({ account: eng.getAccount(), wallets: eng.snapshot().wallets, positions: eng.getPositions(), trades: eng.getTrades(), quote: quotes[symbol], now: Date.now(), analysis, mode, symbol });
              const evidence = QE.evidenceBundle(analysis, null);
              const fused = QE.fuse({ analysis, ml: QE.toFusionMl(paperMl(analysis, risk, evidence)), risk, evidence });
              eng.engine.lastSignals[symbol] = analysis.direction;
              if (risk.veto) { summary.blocked.push({ symbol, mode, reason: "risk_veto", flags: risk.risk_flags }); continue; }
              if (fused.action !== "open_long" && fused.action !== "open_short") continue;
              // §24/§25:预测参与判定(明显对立 → 引擎侧 predictorGate 会跳过)
              const prediction = viewState.lastPredictionBySymbol[symbol] || null;
              const predictorConflict = prediction && prediction.ok ? QE.predictorGate({ prediction: prediction.predictions[tf] || prediction.predictions["1h"], direction: analysis.direction }) : { allow: true };
              if (!predictorConflict.allow) summary.blocked.push({ symbol, mode, reason: predictorConflict.reason });
              const candidate = {
                mode,
                symbol,
                direction: analysis.direction,
                // §8:严格使用已收盘K线时间作为信号标识(绝不用 Date.now())
                signal_timestamp: candles[mode],
                closed_candle_time: candles[mode],
                strategy_version: (analysis.model_version || "rule-v0.1") + "-" + mode,
                quote: quotes[symbol],
                analysis,
                prediction,
                risk,
                riskPct: 15,
                engine_version: analysis.model_version,
                decision_id: "dec_" + mode + "_" + symbol + "_" + candles[mode],
                evidence_conflict: Boolean(evidence && evidence.conflict),
                rule_ml_conflict: fused.conflict === true,
                notional_pct: 0
              };
              if (mode === "short") summary.short_candidates += 1; else summary.long_candidates += 1;
              candidates.push(candidate);
            }
          }
          if (Object.keys(analysisBySymbol).length) await refreshPredictions(eng, analysisBySymbol);
          // 4) 引擎主循环(退出优先 + 风控 + 新仓)
          const res = await eng.loop({
            quotes,
            candidates,
            atr: viewState.lastAnalysis && viewState.lastAnalysis.volatility ? QE.num(viewState.lastAnalysis.volatility.atrPct, 1.5) / 100 * (viewState.lastAnalysis.price || 100) : 2,
            volatilityLevel: viewState.lastAnalysis && viewState.lastAnalysis.volatility ? viewState.lastAnalysis.volatility.level : null,
            predictions: viewState.lastPredictionBySymbol,
            now: Date.now()
          });
          if (res && res.summary) {
            summary.opened = res.summary.opened.length;
            summary.exits = res.summary.exits.length;
            summary.engine_summary = res.summary;
          }
          await settlePredictions(eng, quotes);
          // 5) 分配再平衡(低频、数据不足不动)
          await eng.maybeRebalanceAllocation({});
          if (summary.opened || summary.exits) await renderHome();
          return { ok: true, summary };
        } catch (error) {
          if (!isAborted(error)) diagLog("paper-loop", error);
          return { ok: false, reason: "error", detail: String(error && error.message).slice(0, 120) };
        } finally {
          loopRunning = false;   // §10:任何异常后锁都会释放
        }
      }

      function startPaperLoop() {
        if (paperLoopTimer) return;
        paperLoopTimer = setInterval(() => { void taskBag.runOnce("paper-loop"); }, 300000);
      }

      // ---- Retention:长期挂机数据不会无限增长 ----
      async function runRetention() {
        try {
          const store = await historyStore();
          const adapter = paperStoreAdapter(store);
          const counts = {
            paper_orders: (await adapter.all("paper_orders")).length,
            paper_equity_snapshots: (await adapter.all("paper_equity_snapshots")).length,
            signals: (await adapter.all("signals")).length,
            paper_trades: (await adapter.all("paper_trades")).length,
            learning_samples: (await adapter.all("learning_samples")).length,
            model_registry: (await adapter.all("model_registry")).length,
            sync_queue_synced: (await adapter.all("sync_queue")).filter((i) => i.sync_status === "SYNCED").length
          };
          const plan = QE.planRetention(counts, { now: Date.now() });
          for (const item of plan.delete_rows) {
            if (["paper_trades", "paper_daily_stats", "learning_samples", "model_registry"].includes(item.table)) continue; // 核心历史永不动
            const rows = await adapter.all(item.table);
            const { drop } = QE.applyRetention(item.table, rows, QE.RETENTION_POLICY, {});
            for (const row of drop) {
              const key = row.id || row.order_id || row.signal_id || row.snapshot_id || row.trade_id || row.item_id;
              if (key) await adapter.del(item.table, key);
            }
          }
          return plan;
        } catch (error) {
          diagLog("retention", error);
          return null;
        }
      }

      // V14.3:切页 = 统一入口 —— 记录来源页 → 取消该页在途请求 → 激活目标页
      // 页面分两层:旧版容器 main.app(monitor/scan/watch/validation/...)与 4 个移动页(在 main 之后)。
      // main.app 带 min-height:100vh,若始终渲染会把移动页整体推到首屏之外(表现为"黑屏")。
      // 因此只让"当前页所在的容器"参与布局:移动页激活时旧版容器收起。
      function syncAppLayer(activeEl) {
        const app = document.querySelector(".app");
        if (!app) return;
        const insideLegacy = Boolean(activeEl && app.contains(activeEl));
        app.style.display = insideLegacy ? "" : "none";
      }

      // ================= V16.2:导航状态与返回栈(课堂式连续性) =================
      // ① 离开任何页面前保存该页视图状态(滚动位置 + 详情页的 symbol/interval 等);
      // ② 进子页记来路、切主 Tab 清轨迹 —— 返回"回到刚才",而不是弹回首页;
      // ③ 滚动恢复走"两帧后"的应用(等布局完成,避免设了又失效);
      // ④ Android/浏览器返回:Sheet → K线全屏 → 标记气泡 → 上一子页 → 才退出(history 哨兵拦截)。
      const nav = QE.createNavState({ now: () => Date.now() });
      let navRestoreHandle = null;
      let backTrapArmed = 0;

      function saveCurrentViewState() {
        try {
          nav.save(currentPage, { scrollY: window.scrollY || 0 });
          if (currentPage === "market") {
            // V16.2s:记住"市场/自选"分段与两段各自的滚动位置(返回时恢复到原段)
            nav.save("market", { seg: viewState.mkSeg === "watch" ? "watch" : "market", segScroll: { market: viewState.mkScroll.market, watch: viewState.mkScroll.watch } });
          }
          if (currentPage === "detail") {
            nav.save("detail", {
              symbol: (($("dtSymbol") || {}).textContent || viewState.detailSymbol || null),
              interval: viewState.detailInterval || "1h",
              markOn: Boolean(dtMarkOn)
            });
          }
        } catch (error) { /* 状态保存失败不影响导航 */ }
      }
      function restoreViewScroll(page) {
        try {
          const st = nav.get(page);
          if (page === "market" && st && (st.seg === "watch" || st.seg === "market")) {
            // V16.2s:先恢复分段(内容即时可见,不重跑渲染),再恢复该段滚动位置
            if (st.seg && st.seg !== viewState.mkSeg) {
              viewState.mkSeg = st.seg;   // 直接置位,避免 setMarketSeg 把"当前滚动"写进旧段
              setMarketSeg(st.seg, { skipScroll: true });
            }
            if (st.segScroll && typeof st.segScroll === "object") {
              viewState.mkScroll.market = QE.num(st.segScroll.market, viewState.mkScroll.market);
              viewState.mkScroll.watch = QE.num(st.segScroll.watch, viewState.mkScroll.watch);
            }
          }
          if (!st || !Number.isFinite(st.scrollY) || st.scrollY <= 0) return;
          if (navRestoreHandle && navRestoreHandle.cancel) navRestoreHandle.cancel();
          navRestoreHandle = QE.restoreScrollAfterReady({
            schedule: (fn) => requestAnimationFrame(fn),
            apply: (v) => { try { window.scrollTo(0, v); } catch (error) { /* ignore */ } },
            value: st.scrollY
          });
        } catch (error) { /* ignore */ }
      }
      function syncNavActive(name) {
        if (!QE.NAV_TABS.includes(name)) return;
        document.querySelectorAll(".nav-btn").forEach((item) => item.classList.toggle("active", item.dataset.page === name));
      }
      function anySheetOpen() {
        return ["chatSheet", "closeSheet", "ntfSheet", "themeSheet"].some((id) => {
          const el = $(id);
          return Boolean(el && el.classList.contains("open"));
        });
      }
      function closeAnySheet() {
        if (typeof chatIsOpen === "function" && chatIsOpen()) { closeChat({ fromPop: true }); return; }
        if ($("closeSheet") && $("closeSheet").classList.contains("open")) { closeCloseSheet(); return; }
        if ($("ntfSheet") && $("ntfSheet").classList.contains("open")) { closeNotifications(); return; }
        if ($("themeSheet") && $("themeSheet").classList.contains("open")) { closeThemeSheet(); return; }
      }
      function shouldTrapBack() {
        return Boolean((dtChart && dtChart.fullscreen) || (dtChart && dtChart.popMark) || anySheetOpen() || QE.isSubPage(currentPage));
      }
      // 哨兵:处于"可拦截状态"时推一条 history,系统返回先命中它 → 我们处理;处理完仍可拦截就再推。
      // 不在可拦截状态时不主动回退历史 —— 让系统按默认行为继续(最终退出 App)。
      function updateBackTrap() {
        try {
          if (shouldTrapBack()) {
            if (!backTrapArmed) { history.pushState({ zqtrap: 1 }, ""); backTrapArmed = 1; }
          } else if (backTrapArmed) {
            backTrapArmed = 0;
          }
        } catch (error) { /* 某些环境禁用 history:退化为无拦截 */ }
      }
      // 统一返回:弹轨迹;栈空时兜底(详情→市场,其它子页→我的)。
      // V16.2s:先切回目标页(缓存 DOM 立即显示+滚动恢复),数据刷新放到首绘之后后台进行 ——
      // 返回不等网络(旧实现 await ensurePage 之后才恢复滚动,返回会"停一下")。
      async function goBack() {
        const h = devPerf.begin("back:" + currentPage);
        devPerf.note("back:" + currentPage);
        const target = nav.pop(currentPage);
        const resolved = (target && target !== currentPage) ? target : (currentPage === "detail" ? "market" : "settings");
        setActivePage(resolved);
        requestAnimationFrame(() => perfMark(h, "transition"));
        afterPaint(() => {
          perfMark(h, "first_paint");
          void ensurePage(resolved).catch(() => {}).then(() => perfMark(h, "ready"));
        });
        return resolved;
      }

      function setActivePage(name) {
        const prev = currentPage;
        if (prev && prev !== name) {
          saveCurrentViewState();                                  // V16.2:离开前保存视图状态(滚动等)
          if (QE.isSubPage(name)) nav.push(prev, name);            // 进子页:记来路
          else nav.reset();                                        // 切主 Tab:清子页轨迹
        }
        if (currentPage && currentPage !== name) cancelPageRequests(currentPage);
        // V18:离开详情页必须关掉实时订阅(进入 100 次也不允许堆出 100 个 socket)
        // V16.2s:同时复位手势状态机(绝不把半途手势/press 定时器带出详情页)
        if (name !== "detail" && currentPage === "detail") { dtWsClose(); dtResetGesture(); }
        // V15 AI Chat 不常驻:离开 Coin Detail 自动收起(不允许悬浮在 Market 上)
        if (name !== "detail" && name !== currentPage && typeof chatIsOpen === "function" && chatIsOpen()) {
          closeChat({ fromNav: true });
        }
        currentPage = name;
        document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
        const el = $("page-" + name);
        if (el) { el.classList.add("active"); } else { $("page-home").classList.add("active"); name = "home"; }
        syncAppLayer(el || $("page-home"));
        syncNavActive(name);                                       // 返回/深链进入主 Tab 时高亮也要正确
        // V15 AI 入口:轻量 FAB,常驻在四个主视图(需要时点开,不用时完全收起)
        $("chatFab").classList.toggle("show", name === "detail" || name === "home" || name === "market" || name === "paper");
        restoreViewScroll(name);                                   // V16.2:两帧后恢复该页滚动位置
        updateBackTrap();                                          // V16.2:返回手势拦截哨兵
        // 不变量:任何时刻恰好一个 .page.active(导航压力测试会校验 100 次切换后仍成立)
        return name;
      }

      function activePages() {
        return [...document.querySelectorAll(".page")].filter((p) => p.classList.contains("active"));
      }

      // 统一 Accordion 行为:开/关走同一条路径(classList.toggle + aria-expanded),杜绝"只能开不能收";
      // 展开时才惰性拉数据(onOpen),再点一次立即收起。
      function toggleAccordion(accEl, headEl, onOpen) {
        const acc = typeof accEl === "string" ? $(accEl) : accEl;
        const head = typeof headEl === "string" ? $(headEl) : headEl;
        if (!acc || !head) return false;
        const open = !acc.classList.contains("open");
        acc.classList.toggle("open", open);
        head.setAttribute("aria-expanded", open ? "true" : "false");
        devPerf.note((open ? "acc-open:" : "acc-close:") + (acc.id || "?"));
        if (open && typeof onOpen === "function") { try { onOpen(); } catch (error) { diagLog("acc-open", error); } }
        return open;
      }
      function bindAccordion(accId, headId, onOpen) {
        const head = $(headId);
        if (!head) return;
        const activate = () => { toggleAccordion($(accId), head, onOpen); };
        head.addEventListener("click", activate);
        head.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); }
        });
      }

      async function initMobileUI() {
        // 导航:切换时取消该视图在途请求(Paper Engine 不受影响)
        // V16.2s:①"先绘制、后重活" —— active 切换后先让浏览器画一帧,再跑该页数据刷新;
        //         ②重复点击当前 Tab = 回到顶部(不再重跑全量渲染、不重复请求);
        //         ③点击埋点(tap→feedback→transition→first_paint→ready)。
        document.querySelectorAll(".nav-btn").forEach((btn) => {
          btn.addEventListener("click", () => {
            const page = btn.dataset.page;
            const h = tapHandle(btn, "tab:" + page);
            perfMark(h, "nav_requested");
            if (page === currentPage) {
              // 重复点击当前 Tab = 回到顶部(不重跑全量渲染);scrollTo 在测试沙箱/旧内核里可能缺失,双保险
              try {
                if (typeof window.scrollTo === "function") window.scrollTo({ top: 0, behavior: "smooth" });
              } catch (error) {
                try { if (typeof window.scrollTo === "function") window.scrollTo(0, 0); } catch (error2) { /* ignore */ }
              }
              perfMark(h, "ready");
              return;
            }
            document.querySelectorAll(".nav-btn").forEach((item) => item.classList.toggle("active", item === btn));
            setActivePage(page);
            RM.leaveAll(["paper"]);
            requestAnimationFrame(() => perfMark(h, "transition"));
            afterPaint(() => {
              perfMark(h, "first_paint");
              void ensurePage(page).catch(() => {}).then(() => perfMark(h, "ready"));
            });
          });
        });
        // V16.2s:市场/自选 分段控件(滑块先动、内容随后;纯状态切换,不等网络)
        $("mkSegMarket").addEventListener("click", () => {
          const h = tapHandle($("mkSegMarket"), "seg:market");
          perfMark(h, "nav_requested");
          setMarketSeg("market");
          perfMark(h, "ready");
        });
        $("mkSegWatch").addEventListener("click", () => {
          const h = tapHandle($("mkSegWatch"), "seg:watch");
          perfMark(h, "nav_requested");
          setMarketSeg("watch");
          perfMark(h, "ready");
        });
        // V16.2:市场滚动位置改由 navState 在"离开页面"时精确采样(setActivePage 内保存),
        // 不再用"边滚边记 + mkList.scrollTop 恢复"的旧写法(恢复写错了元素,滚动的是 window)。
        $("mkScanBtn").addEventListener("click", () => {
          setActivePage("scan");
          $("chatFab").classList.remove("show");
        });
        $("openMonitorLegacy").addEventListener("click", () => {
          setActivePage("monitor");
          $("chatFab").classList.remove("show");
          void analyzeCurrent();
        });
        $("openWatchLegacy").addEventListener("click", () => {
          setActivePage("watch");
          void renderWatch();
        });
        // V16.2s 学习状态:统一 Accordion(开→惰性渲染明细,再点→收起)
        bindAccordion("learningAcc", "openLearning", () => { void renderLearning(); });
        // V19:我的 > 外观(主题 Bottom Sheet)/ 通知(设置子页入口)
        $("openThemeSheet").addEventListener("click", openThemeSheet);
        $("themeSheetClose").addEventListener("click", closeThemeSheet);
        $("themeMask").addEventListener("click", closeThemeSheet);
        document.querySelectorAll(".theme-opt").forEach((btn) => {
          btn.addEventListener("click", () => {
            state.themeMode = btn.dataset.theme;
            saveSettings();
            applyTheme();
            syncThemeUI();
            closeThemeSheet();
            requestAnimationFrame(() => analyzeCurrent());
          });
        });
        $("openNtfSettings").addEventListener("click", openNtfSettings);
        $("ntfsetBackBtn").addEventListener("click", () => { void goBack(); });
        $("hmStartBtn").addEventListener("click", async () => {
          const eng = await getPaperEngine();
          if (eng.getState() === "PAUSED") await eng.resume(); else await eng.start();
          startPaperLoop();
          void paperLoopTick();
          await renderHome();
        });
        $("hmPauseBtn").addEventListener("click", async () => {
          const eng = await getPaperEngine();
          await eng.pause("用户暂停");
          await renderHome();
        });
        $("dtBackBtn").addEventListener("click", () => { void goBack(); });
        $("dtRefreshBtn").addEventListener("click", () => { void refreshDetail(); });
        // V16.2s:星标(详情页)与市场/搜索共用同一 Watchlist Store
        $("dtStar").addEventListener("click", () => { toggleWatchFrom(viewState.detailSymbol, $("dtStar")); });
        $("dtDetailsBtn").addEventListener("click", () => {
          const hidden = $("dtDetails").classList.toggle("hidden");
          $("dtDetailsBtn").setAttribute("aria-expanded", hidden ? "false" : "true");
        });
        $("dtExternalToggle").addEventListener("click", () => {
          const body = $("dtExternalBody");
          const open = body.classList.toggle("hidden");
          $("dtExternalToggle").textContent = open ? "展开" : "收起";
          $("dtExternalToggle").setAttribute("aria-expanded", open ? "false" : "true");
        });
        $("chatFab").addEventListener("click", openChat);
        // V19:AI FAB 避让 —— 滚动时淡出(不压住列表右列价格),停下 600ms 恢复;滚到底另有 FAB 高度预留
        window.addEventListener("scroll", () => {
          const fab = $("chatFab");
          if (!fab || !fab.classList.contains("show")) return;
          fab.classList.add("fab-dim");
          if (fabIdleTimer) clearTimeout(fabIdleTimer);
          fabIdleTimer = setTimeout(() => fab.classList.remove("fab-dim"), 600);
        }, { passive: true });
        $("chatClose").addEventListener("click", () => { closeChat(); });
        $("chatMask").addEventListener("click", () => { closeChat(); });
        $("chatSend").addEventListener("click", () => { void sendChat(); });
        $("chatInput").addEventListener("keydown", (event) => { if (event.key === "Enter") void sendChat(); });
        // 向下拖动关闭(阈值 80px,松手才关,避免误触)
        $("chatSheet").addEventListener("touchstart", (event) => {
          const t = event.touches[0];
          viewState.chatTouchY = t ? t.clientY : 0;
          viewState.chatDragY = 0;
        }, { passive: true });
        $("chatSheet").addEventListener("touchmove", (event) => {
          const t = event.touches[0];
          if (!t || !viewState.chatTouchY) return;
          viewState.chatDragY = t.clientY - viewState.chatTouchY;
          if (viewState.chatDragY > 0) $("chatSheet").style.transform = "translateY(" + viewState.chatDragY + "px)";
        }, { passive: true });
        $("chatSheet").addEventListener("touchend", () => {
          const moved = QE.num(viewState.chatDragY, 0);
          $("chatSheet").style.transform = "";
          if (moved > 80) closeChat();
          viewState.chatDragY = 0;
        });
        // V16.2:系统返回手势 / 返回键 —— Sheet → K线全屏 → 标记气泡 → 上一子页 → 才退出 App
        // (history 哨兵只在"可拦截状态"存在;这一条 popstate 被消费后按优先级处理,处理完仍可拦截则再武装)
        window.addEventListener("popstate", () => {
          backTrapArmed = 0;
          const action = QE.backPriority({
            sheetOpen: anySheetOpen(),
            fullscreen: Boolean(dtChart && dtChart.fullscreen),
            markPop: Boolean(dtChart && dtChart.popMark),
            subpageActive: QE.isSubPage(currentPage)
          });
          if (action === "close_sheet") closeAnySheet();
          else if (action === "exit_fullscreen") dtExitFullscreen(true);
          else if (action === "close_mark") dtHideMarkPop();
          else if (action === "back_subpage") { void goBack(); return; }
          else { return; }   // exit_app:不再武装,按系统默认行为继续回退
          updateBackTrap();
        });
        $("mkSearch").addEventListener("input", () => { void renderMarketSearch(); });
        // V15:手动平仓 Sheet / 通知中心 / 暂停开仓 / 紧急全平 / 重置 / 导出 / 系统状态
        $("closeSheetClose").addEventListener("click", closeCloseSheet);
        $("closeMask").addEventListener("click", closeCloseSheet);
        $("closeConfirmBtn").addEventListener("click", () => { void confirmManualClose(); });
        $("openNotifications").addEventListener("click", openNotifications);
        $("ntfSheetClose").addEventListener("click", closeNotifications);
        $("ntfMask").addEventListener("click", closeNotifications);
        $("ntfReadBtn").addEventListener("click", () => {
          void (async () => {
            const eng = await getPaperEngine();
            eng.markNotificationsRead([]);
            await renderNotifications();
          })();
        });
        $("pfPauseEntriesBtn").addEventListener("click", () => { void togglePauseEntries(); });
        $("pfEmergencyBtn").addEventListener("click", () => { void emergencyCloseAll(); });
        $("pfExportBtn").addEventListener("click", () => exportPaperRecords("csv"));
        $("resetPaperBtn").addEventListener("click", () => { void resetPaperAccount(); });
        // V16.2s 系统状态:统一 Accordion —— 点开(惰性渲染真实数据),再点立即收起(修复"展开后不能收回")
        bindAccordion("sysAcc", "openSysStatus", () => { void renderSysStatus(); });
        // V16:量化内核(只读观测)/ 系统诊断(黑匣子)/ 开发用性能浮层(默认关闭)
        $("openKernel").addEventListener("click", openKernel);
        $("kernelBackBtn").addEventListener("click", () => { void goBack(); });
        $("kernelRefreshBtn").addEventListener("click", () => { void renderKernel(); });
        $("openDiag").addEventListener("click", openDiag);
        $("diagBackBtn").addEventListener("click", () => { void goBack(); });
        $("diagRefreshBtn").addEventListener("click", () => { void renderDiag(); });
        $("diagCopyBtn").addEventListener("click", () => { void diagCopy(); });
        $("diagExportBtn").addEventListener("click", () => { void diagExportFile(); });
        initDevOverlay();
        for (const item of NTF_TYPES) {
          const sw = $(item.key);
          if (!sw) continue;
          const initial = NTF_TYPES.some((x) => x.key === item.key) && ntfEnabled(item.id);
          sw.classList.toggle("on", initial);
          ntfSettings[item.id] = initial;
          sw.addEventListener("click", () => {
            ntfSettings[item.id] = !ntfSettings[item.id];
            sw.classList.toggle("on", ntfSettings[item.id]);
            saveNtfSettings();
            refreshNtfSetValue();
          });
        }
        refreshNtfSetValue();   // V19:主页"通知设置"入口显示已开启数
        // 通知 → 系统通知(Android WebView 走 Capacitor 桥;Web 端为 no-op)
        initNetworkBar();
        initNativeBridge();
        void renderNotifications();
        bindDetailChart();
        // 页面可见性:回到前台时刷新首页(不重启引擎);顺便消费"通知点击深链"
        document.addEventListener("visibilitychange", () => {
          if (document.hidden) { saveCurrentViewState(); return; }
          if ($("page-home").classList.contains("active")) void renderHome();
          applyNotificationRoute();
        });
        await getPaperEngine();
        setActivePage("home");   // 初始就位:移动页激活时收起旧版容器,保证首屏不是空白
        await renderHome();
        await renderMarket(false).catch(() => {});
        applyNotificationRoute();   // V16.1-RV §50:冷启动若是"点通知进来的",按 kind 深链
        if (homeTimer) clearInterval(homeTimer);
        homeTimer = setInterval(() => { if (!$("page-home").classList.contains("active") && !$("page-paper").classList.contains("active")) return; void renderHome(); if ($("page-paper").classList.contains("active")) void renderPaperPage(); }, 8000);
        // §12:持仓风险 20 秒一轮(强平/止损/移动止损不再等 1h 闭合K线;无持仓时零请求)
        if (riskTimer) clearInterval(riskTimer);
        riskTimer = setInterval(() => {
          void taskBag.runOnce("position-risk");
          // V17:详情页停留时低频刷新K线 —— 只更新最后一根未收盘 candle,不追加、不拽视口
          if (currentPage === "detail") void refreshDetailKlines();
        }, 20000);
        if (retentionTimer) clearInterval(retentionTimer);
        retentionTimer = setInterval(() => { void taskBag.runOnce("retention"); }, 600000);
        // V18:实时推送不可用时的降级轮询(5 秒;推送正常时该 tick 不发请求)
        if (dtPollTimer) clearInterval(dtPollTimer);
        dtPollTimer = setInterval(() => { dtWsPollTick(); }, 5000);
        // V18:Current Candle 收盘倒计时(每秒刷新,全屏内外都显示)
        if (dtSecTimer) clearInterval(dtSecTimer);
        dtSecTimer = setInterval(() => { dtUpdateCountdown(); }, 1000);
        void runRetention();
        // V14.5:后台 worker 与 UI 解耦启动(停在任何页面都持续更新外部情报/研究/预测/回撤)
        startBackgroundWorkers();
        // V15:恢复最近聊天记录(界面不常驻,记录按 symbol 保留)
        loadChatSessions();
        // 启动即尝试装载 Champion(有工件就用真实推理,没有就走回退)
        void refreshChampion(false);
        // 只读观测接口:供导航压力测试与真机诊断读取真实运行态(不含任何业务写操作)
        window.__quantUI = {
          state: () => ({
            currentPage,
            activePages: activePages().map((p) => p.id),
            activeNav: [...document.querySelectorAll(".nav-btn")].filter((b) => b.classList.contains("active")).length,
            engineInstances: window.__quantEngineInstances || 0,
            requests: RM.stats(),
            chart: { bars: dtChart.klines.length, start: dtChart.vp ? dtChart.vp.start : null, count: dtChart.vp ? dtChart.vp.count : null, crosshair: dtChart.cross ? dtChart.cross.index : null },
            ml: { source: mlUiState.source, version: mlUiState.version, loaded: mlRuntime.hasModel(), swaps: mlRuntime.swapLog().length, fallback_count: mlUiState.fallbackCount, inference_count: mlUiState.inferenceCount },
            background: backgroundWorkerStats(),
            allocation: { short_pct: null },
            review: null,
            loop_running: loopRunning,
            diag: (window.__quantDiag || []).length,
            // V16.1-RV §19-§21/§33/§34:真机脚本化验收观测面(只读)
            runtime: (() => {
              const rt = readRuntimeStatus();
              return rt ? {
                instance_id: rt.instance_id,
                state_version: rt.state_version,
                state: rt.state,
                loops: rt.loops,
                risk_loops: rt.risk_loops,
                market_fetches: rt.market_fetches,
                heartbeat_age_ms: rt.heartbeat_age_ms,
                strategy_age_ms: rt.strategy_age_ms,
                market_state: rt.market_state,
                stalled: rt.stalled,
                strategy_stalled: rt.strategy_stalled,
                stall_events: rt.stall_events,
                equity: rt.equity,
                mirror_rejected: runtimeMirror.rejected
              } : { mirror_rejected: runtimeMirror.rejected };
            })(),
            capital: lastCapitalByPage,
            parity: lastParity,
            store: uiStore.stats(),
            dev: (() => {
              try {
                return {
                  timers: DEV_OV.timers, listeners: DEV_OV.listeners, longTasks: DEV_OV.longTasks,
                  memMb: devOvMemory(), memPeakMb: DEV_OV.memPeakMb,
                  canvas: document.querySelectorAll("canvas").length,
                  sheets_open: document.querySelectorAll(".sheet.open").length
                };
              } catch (error) { return null; }
            })(),
            // V18:实时行情观测(只读事实:连上/降级/订阅数)
            live: {
              state: dtWs.state,
              reason: dtWs.reason,
              sockets: dtWs.live.size,
              count: window.__quantWsCount || 0,
              key: dtWs.key,
              event_class: dtWs.lastEventClass,
              sub_capable: dtWs.subCapable,
              sub_ms: dtChart.subMs
            }
          }),
          // V14.5:运行时观测接口(供压力测试/真机诊断读取真实运行态)
          loopTick: (options) => paperLoopTick({ force: true, ...(options || {}) }),
          backgroundStats: () => backgroundWorkerStats(),
          researchRead: () => researchAgent.read(),
          hubSnapshot: () => externalHub.snapshot(),
          openPage: (name) => { setActivePage(name); return ensurePage(name); },
          chartState: () => dtChart,
          mlRuntime,
          refreshChampion,
          refreshFunding,
          // V15 P0:资金/仓位完整性观测(只读)—— 自检修复记录、串价计数、账户不变量、持仓价格状态
          integrity: async () => {
            const eng = await getPaperEngine();
            return {
              engine: eng.getIntegrity(),
              account: eng.accountIntegrity(),
              positions: eng.getPositions().filter((p) => p.status === "OPEN").map((p) => ({
                symbol: p.symbol,
                side: p.side,
                entry: p.entry_price,
                current: p.current_price,
                liquidation: p.liquidation_price,
                roe_pct: p.roe_pct,
                mfe: p.mfe,
                mae: p.mae,
                loss_bound: null,
                price_status: p.price_status,
                price_source: p.price_source,
                repair_reason: p.repair_reason || null,
                remaining_quantity: p.remaining_quantity,
                remaining_margin: p.remaining_margin
              })),
              trades: eng.getTrades().filter((t) => t.invalid_sample || t.repair_reason).map((t) => ({ trade_id: t.trade_id, symbol: t.symbol, net_pnl: t.net_pnl, invalid_sample: Boolean(t.invalid_sample), repair_reason: t.repair_reason || null }))
            };
          },
          riskTick: () => refreshPositionRisk(),
          taskHealth: () => (taskBag ? taskBag.health() : null),
          buildQuotesFromTickers,
          priceOfSymbol
        };
        if (paperApi) { /* 引擎实例已就绪 */ }
      }

      async function ensurePage(name) {
        if (name === "home") { await renderHome(); return; }
        if (name === "market") { await renderMarket(false); return; }
        if (name === "paper") { await renderPaperPage(); return; }
        if (name === "detail") { await refreshDetail(); return; }
      }

      async function renderMarketSearch() {
        const q = String($("mkSearch").value || "").trim().toUpperCase().replace("/", "");
        const box = $("mkSuggest");
        box.classList.remove("open");
        if (!q) return;
        const list = viewState.lastTickers || [];
        const hits = list.filter((t) => String(t.symbol || "").startsWith(q)).slice(0, 6);
        if (!hits.length) return;
        box.replaceChildren();
        for (const t of hits) {
          // V16.2s:搜索结果同样使用统一星标组件(与市场/详情同一 Store、同一 DOM)
          const row = vEl("div", "suggest-row");
          const btn = vEl("button", "chip", t.symbol.replace("USDT", "/USDT"));
          btn.type = "button";
          btn.dataset.tap = "coin:" + t.symbol;
          btn.addEventListener("click", (event) => {
            $("mkSearch").value = "";
            box.classList.remove("open");
            void openDetail(t.symbol, viewState.detailInterval, btn);
          });
          row.appendChild(btn);
          row.appendChild(starButton(t.symbol));
          box.appendChild(row);
        }
        box.classList.add("open");
      }

      async function renderLearning() {
        const store = await historyStore();
        const adapter = paperStoreAdapter(store);
        const champ = await QE.getChampion(adapter);
        const models = await QE.listModels(adapter);
        const evals = await store.generic.all("model_evaluations", 50);
        // §17:无效样本(串价/亏损越界/会计不一致)不得进入漂移检测与学习统计
        const validSamples = (await adapter.all("learning_samples")).filter((s) => s && s.invalid_sample !== true);
        const samples = validSamples.slice(-200).map((s) => ({ predicted_class: s.outcome_label, actual_class: s.outcome_label, pnl: s.net_pnl }));
        const drift = samples.length >= 60 ? QE.detectDrift(samples.map((s) => ({ predicted_class: s.pnl != null && s.pnl > 0 ? "win" : "loss", actual_class: s.actual_class })), { windowSize: 100, minSamples: 30, threshold: 0.12 }) : null;
        const vm = QE.learningViewModel({ champion: champ ? champ.version : null, challenger: (models.find((m) => m.status === "CHALLENGER") || {}).version || null, drift });
        const host = $("openLearning");
        host.querySelector(".coin-sub").textContent = vm.status_text;
        $("learningBadge").textContent = champ ? champ.version : "--";
        const detail = $("learningDetail");
        if (detail) {
          detail.textContent = "模型数量 " + models.length + " · 评估记录 " + evals.length + " · 学习样本 " + samples.length + (drift && drift.drift_score != null ? " · 漂移指标 " + drift.drift_score : "") + "(技术信息,日常无需关注)";
          // V16.2s:明细的显隐由 Accordion 统一管理(这里只填真实数据,不再手动摘 .hidden)
        }
      }

      setup();
      void initMobileUI();

      void initHistory();
    </script>
  </body>
</html>`;
