// tools/patch-ui-nav.mjs · V14.1:导航改为 4 项(首页/市场/模拟/我的)+ 新增页面骨架
import fs from "node:fs";
const file = new URL("../worker/src/ui/page.js", import.meta.url);
let text = fs.readFileSync(file, "utf8");
const before = text;

// 1) 导航:monitor/scan/watch → home/market/paper(settings 保留)
const navSwap = [
  ['data-page="monitor" type="button"><span class="nav-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 5.5v13"></path><rect x="4.5" y="9" width="5" height="6" rx="1"></rect><path d="M17 3.5v17"></path><rect x="14.5" y="6.5" width="5" height="9" rx="1"></rect></svg></span><span class="nav-text">监控</span>',
   'data-page="home" type="button"><span class="nav-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11.2 12 4.5l8 6.7"></path><path d="M6.5 10.8V19h11v-8.2"></path></svg></span><span class="nav-text">首页</span>'],
  ['data-page="scan" type="button"><span class="nav-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><path d="M20.2 20.2l-3.3-3.3"></path><path d="M7.8 11.4l1.7-2.1 1.5 2.8 1.7-2.3"></path></svg></span><span class="nav-text">扫描</span>',
   'data-page="market" type="button"><span class="nav-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16"></path><path d="M7 19V9"></path><path d="M12 19V5"></path><path d="M17 19v-7"></path></svg></span><span class="nav-text">市场</span>'],
  ['data-page="watch" type="button"><span class="nav-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.6l2.3 4.8 5.1.7-3.7 3.6.9 5.1-4.6-2.5-4.6 2.5.9-5.1-3.7-3.6 5.1-.7z"></path></svg></span><span class="nav-text">自选</span>',
   'data-page="paper" type="button"><span class="nav-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="6" width="17" height="12" rx="2"></rect><path d="M7 12h4"></path><path d="M15 9.5v5"></path></svg></span><span class="nav-text">模拟</span>']
];
let swapped = 0;
for (const [from, to] of navSwap) { if (text.includes(from)) { text = text.split(from).join(to); swapped += 1; } }

// 2) 新增页面骨架(home / market / paper / detail)+ AI Chat 悬浮与 Bottom Sheet
const newPages = `
      <section id="page-home" class="page">
        <div class="hm-hero">
          <div class="label">今日模拟盈亏</div>
          <div class="big" id="hmTodayPnl">--</div>
          <div class="sub">总模拟资产 <span id="hmEquity">--</span> · 累计 <span id="hmAllTime">--</span></div>
        </div>
        <div class="hm-row"><span class="k">短线资产</span><span class="v"><span id="hmShortEq">--</span> <span class="muted" id="hmShortToday">--</span></span></div>
        <div class="hm-row"><span class="k">长线资产</span><span class="v"><span id="hmLongEq">--</span> <span class="muted" id="hmLongToday">--</span></span></div>
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
            <button id="mkWatchBtn" class="v-close" type="button">自选</button>
            <button id="mkScanBtn" class="v-close" type="button">扫描市场</button>
          </div>
        </div>
        <div class="search-wrap">
          <input id="mkSearch" type="text" placeholder="搜索币种,如 BTC" autocomplete="off" />
          <div id="mkSuggest" class="suggest"></div>
        </div>
        <div class="sec-title">主要币种</div>
        <div id="mkList"></div>
        <div class="sec-title">自选</div>
        <div id="mkWatchList"></div>
      </section>

      <section id="page-paper" class="page">
        <div class="top-row"><h1>模拟</h1><div class="top-row-selects"><span class="pill gray" id="pfEnv">模拟账户</span></div></div>
        <div class="hm-row"><span class="k">短线池</span><span class="v" id="pfShortAlloc">--</span></div>
        <div class="hm-row"><span class="k">长线池</span><span class="v" id="pfLongAlloc">--</span></div>
        <div class="hm-row"><span class="k">今日 / 累计盈亏</span><span class="v"><span id="pfToday">--</span> · <span id="pfTotal">--</span></span></div>
        <div class="sec-title">当前持仓</div>
        <div id="pfPositions"></div>
        <div class="sec-title">最近成交</div>
        <div id="pfTrades"></div>
      </section>

      <section id="page-detail" class="page">
        <div class="top-row">
          <div>
            <h1 id="dtSymbol">--</h1>
            <div class="coin-sub"><span id="dtPrice">--</span> · <span id="dtChange" class="muted">--</span></div>
          </div>
          <button id="dtBackBtn" class="v-close" type="button">返回</button>
        </div>
        <div class="chip-row" id="dtPeriods" style="margin-bottom:8px"></div>
        <div class="card chart-card" id="dtChartCard"><canvas id="dtCanvas"></canvas><div id="dtChartEmpty" class="chart-empty hidden">暂无K线</div></div>
        <div class="hm-row"><span class="k">综合状态</span><span class="v" id="dtBias">--</span></div>
        <div class="hm-row"><span class="k">风险</span><span class="v" id="dtRisk">--</span></div>
        <div class="hm-row"><span class="k">策略</span><span class="v" id="dtStrategy">--</span></div>
        <div id="dtPositionBox"></div>
        <div class="hm-actions">
          <button id="dtRefreshBtn" class="sec" type="button">刷新行情</button>
          <button id="dtDetailsBtn" class="sec" type="button">查看分析详情</button>
        </div>
        <div id="dtDetails" class="hidden"></div>
      </section>

      <button id="chatFab" class="fab show" type="button" aria-label="AI">AI</button>
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
`;
text = text.split("    <div class=\"v-overlay\" id=\"vDetail\">").join(newPages + "\n    <div class=\"v-overlay\" id=\"vDetail\">");

// 3) 我的页:补上入口(行情监控/自选/学习状态)
const settingsAnchor = '<div class="card setting-row" id="openValidation">';
const extraEntries = `<div class="card setting-row" id="openMonitorLegacy">
            <div><div class="coin-name">行情监控(详细分析)</div><div class="coin-sub">单币技术面与多周期分析</div></div>
            <span class="pill gray">›</span>
          </div>
          <div class="card setting-row" id="openWatchLegacy">
            <div><div class="coin-name">自选列表</div><div class="coin-sub">管理关注的币种</div></div>
            <span class="pill gray">›</span>
          </div>
          <div class="card setting-row" id="openLearning">
            <div><div class="coin-name">学习状态</div><div class="coin-sub">模型版本与市场规律变化(技术信息)</div></div>
            <span class="pill gray" id="learningBadge">--</span>
          </div>
          `;
text = text.split(settingsAnchor).join(extraEntries + settingsAnchor);

fs.writeFileSync(file, text, "utf8");
console.log(before === text ? "NO_CHANGE" : "PATCHED nav + pages");
console.log("nav swapped:", swapped);
console.log("home page:", text.includes('id="page-home"'), "| market:", text.includes('id="page-market"'), "| paper:", text.includes('id="page-paper"'), "| detail:", text.includes('id="page-detail"'), "| chat:", text.includes('id="chatSheet"'));
