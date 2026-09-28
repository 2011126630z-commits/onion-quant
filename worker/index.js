const page = String.raw`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="theme-color" content="#000000">
    <title>量化监控</title>
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
        --chart-bg: #12151a;
        --button-text: #ffffff;
      }
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        min-height: 100%;
        background: var(--bg);
        color: var(--text);
        transition: background-color 500ms ease, color 500ms ease;
      }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: 15px;
      }
      body, .app, .card, .bottom-nav, select, input, button, .period-btn, .primary-btn, .add-btn, .switch {
        transition:
          background-color 500ms ease,
          border-color 500ms ease,
          color 500ms ease,
          box-shadow 500ms ease,
          transform 360ms cubic-bezier(.2, 1.35, .3, 1);
      }
      button, select, input { font: inherit; }
      button { cursor: pointer; }
      .app {
        width: min(760px, 100%);
        min-height: 100vh;
        margin: 0 auto;
        padding: 10px 10px calc(66px + env(safe-area-inset-bottom));
      }
      .page {
        display: none;
        opacity: 0;
        transform: translateY(8px);
      }
      .page.active {
        display: block;
        animation: pageIn 300ms ease both;
      }
      @keyframes pageIn {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .top-row, .controls-row, .market-row, .watch-row, .setting-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .top-row { margin-bottom: 9px; flex-wrap: wrap; }
      .top-row-selects { display: flex; gap: 6px; }
      h1, h2, p { margin: 0; }
      h1 { font-size: 22px; font-weight: 800; }
      h2 { font-size: 16px; font-weight: 800; }
      .muted { color: var(--muted); }
      .card {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
        padding: 10px;
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
      .switch {
        position: relative;
        width: 50px;
        height: 28px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: var(--panel-2);
      }
      .switch.on { background: rgba(0, 192, 118, .35); }
      .switch::after {
        content: "";
        position: absolute;
        top: 3px;
        left: 3px;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: #fff;
      }
      .switch.on::after { left: 25px; }
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
      .bottom-nav {
        position: fixed;
        left: 50%;
        bottom: 0;
        z-index: 10;
        width: min(760px, 100%);
        transform: translateX(-50%);
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        border-top: 1px solid var(--line);
        background: var(--nav-bg);
        backdrop-filter: blur(18px);
        padding: 4px 8px calc(4px + env(safe-area-inset-bottom));
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
        gap: 2px;
        place-items: center;
        min-height: 38px;
        border: 0;
        background: transparent;
        color: var(--gray);
        transition: color 200ms ease;
      }
      .nav-btn.active { color: var(--green); }
      .nav-icon {
        display: block;
        line-height: 1;
        transition: transform 200ms ease;
      }
      .nav-icon svg { display: block; }
      .nav-btn.active .nav-icon { transform: translateY(1.5px); }
      .nav-text { font-size: 10px; font-weight: 400; letter-spacing: .2px; }
      @media (max-width: 430px) {
        .app { padding-left: 10px; padding-right: 10px; }
        .chart-card { height: 300px; }
        .price { font-size: 28px; }
        .scan-row { grid-template-columns: 1fr auto auto; }
        .scan-row .regime-pill { display: none; }
      }
    </style>
  </head>
  <body>
    <main class="app">
      <section id="page-monitor" class="page active">
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
        <div class="setting-list">
          <div class="card setting-row">
            <div>
              <div class="coin-name">默认交易对</div>
              <div class="coin-sub">打开页面后默认分析</div>
            </div>
            <select id="defaultSymbol"></select>
          </div>
          <div class="card setting-row">
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
          <div class="card setting-row">
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
          <div class="card setting-row">
            <div>
              <div class="coin-name">主题模式</div>
              <div class="coin-sub">浅色、深色或跟随系统</div>
            </div>
            <select id="themeMode">
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </div>
          <div class="card setting-row">
            <div>
              <div class="coin-name">提醒开关</div>
              <div class="coin-sub">明显看涨/看跌时高亮</div>
            </div>
            <button id="notifySwitch" class="switch on" type="button" aria-label="提醒开关"></button>
          </div>
        </div>
      </section>
    </main>

    <nav class="bottom-nav">
      <button class="nav-btn active" data-page="monitor" type="button"><span class="nav-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 5.5v13"></path><rect x="4.5" y="9" width="5" height="6" rx="1"></rect><path d="M17 3.5v17"></path><rect x="14.5" y="6.5" width="5" height="9" rx="1"></rect></svg></span><span class="nav-text">监控</span></button>
      <button class="nav-btn" data-page="scan" type="button"><span class="nav-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><path d="M20.2 20.2l-3.3-3.3"></path><path d="M7.8 11.4l1.7-2.1 1.5 2.8 1.7-2.3"></path></svg></span><span class="nav-text">扫描</span></button>
      <button class="nav-btn" data-page="watch" type="button"><span class="nav-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.6l2.3 4.8 5.1.7-3.7 3.6.9 5.1-4.6-2.5-4.6 2.5.9-5.1-3.7-3.6 5.1-.7z"></path></svg></span><span class="nav-text">自选</span></button>
      <button class="nav-btn" data-page="settings" type="button"><span class="nav-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.4"></circle><path d="M5 19.5c1.3-3.1 3.9-4.7 7-4.7s5.7 1.6 7 4.7"></path></svg></span><span class="nav-text">我的</span></button>
    </nav>

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
        scanSort: "strength"
      };
      const $ = (id) => document.getElementById(id);
      const fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 });

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

      async function api(path, attempts = 3) {
        const joiner = path.includes("?") ? "&" : "?";
        let lastError;
        for (let i = 0; i < attempts; i += 1) {
          try {
            const res = await fetchWithTimeout("/api/" + path + joiner + "_=" + Date.now(), 10000);
            if (!res.ok) throw new Error("行情读取失败");
            return res.json();
          } catch (error) {
            lastError = error;
            if (i < attempts - 1) await delay(650);
          }
        }
        throw lastError || new Error("行情读取失败");
      }

      function fetchWithTimeout(url, ms) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ms);
        return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
      }

      function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }

      function pctClass(value) {
        return value > 0 ? "green" : value < 0 ? "red" : "gray";
      }

      function applyTheme() {
        const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
        const useDark = state.themeMode === "dark" || (state.themeMode === "system" && prefersDark);
        document.documentElement.classList.toggle("theme-dark", useDark);
        document.querySelector('meta[name="theme-color"]').setAttribute("content", useDark ? "#121212" : "#ffffff");
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
        try {
          const [result, klines] = await Promise.all([
            api("analyze?symbol=" + state.symbol + "&interval=" + state.interval),
            api("klines?market=futures&symbol=" + state.symbol + "&interval=" + state.interval + "&limit=200")
          ]);
          renderAnalysis(result);
          drawChart(klines, result);
          $("monitorStatus").textContent = "已更新 " + new Date().toLocaleTimeString("zh-CN") + " · " + result.market_regime.label;
        } catch (error) {
          $("chartEmpty").classList.remove("hidden");
          $("monitorStatus").textContent = "行情暂时读取失败，已自动重试。请稍后再点开始分析。";
        } finally {
          clearInterval(stepTimer);
          state.analyzing = false;
          $("analyzeBtn").disabled = false;
        }
      }

      async function scanMarket() {
        if (state.scanning) return;
        state.scanning = true;
        $("scanBtn").disabled = true;
        $("scanStatus").textContent = "正在准备扫描...";
        $("scanProgress").style.width = "0%";
        state.scanResults = [];
        try {
          const tickers = await api("tickers?market=futures");
          const candidates = tickers
            .filter((t) => t.symbol.endsWith("USDT") && !t.symbol.includes("_") && Number(t.quoteVolume) > 5e6)
            .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
            .slice(0, Number(state.scanLimit));
          const total = candidates.length;
          let done = 0;
          let success = 0;
          const interval = $("scanPeriod").value;
          for (let i = 0; i < candidates.length; i += 10) {
            const chunk = candidates.slice(i, i + 10).map((t) => t.symbol);
            $("scanStatus").textContent = "正在扫描 " + (done + 1) + "/" + total + "：" + chunk[0].replace("USDT", "/USDT") + " ...";
            let rows = null;
            try {
              const res = await api("screen?interval=" + interval + "&symbols=" + chunk.join(","));
              rows = res.results;
            } catch (error) {
              rows = null;
            }
            if (!rows) {
              try {
                const res = await api("screen?interval=" + interval + "&symbols=" + chunk.join(","));
                rows = res.results;
              } catch (error) {
                rows = chunk.map((s) => ({ symbol: s, failed: true }));
              }
            }
            for (const row of rows) {
              if (!row.failed) success += 1;
              state.scanResults.push(row);
            }
            done += chunk.length;
            $("scanProgress").style.width = Math.round((done / total) * 100) + "%";
            renderScanList();
            if (done < total) await delay(400);
          }
          $("scanStatus").textContent = "扫描完成，成功 " + success + " 个，失败 " + (total - success) + " 个";
        } catch (error) {
          $("scanStatus").textContent = "扫描暂时失败，网络不稳定，请稍后重试。";
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
          el.innerHTML = '<div class="sr-main"><b>' + row.symbol.replace("USDT", "/USDT") + '</b><span class="coin-sub">重试后仍读取失败</span></div><span class="pill gray">--</span>';
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
          const res = await api("screen?interval=" + state.interval + "&symbols=" + state.watch.join(","));
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
            const tickers = await api("tickers?market=futures", 2);
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
        $("scanLimit").value = state.scanLimit;
        $("refreshInterval").value = state.refreshInterval;
        $("themeMode").value = state.themeMode;
        $("scanLimit").addEventListener("change", (event) => { state.scanLimit = event.target.value; saveSettings(); });
        $("refreshInterval").addEventListener("change", (event) => { state.refreshInterval = event.target.value; saveSettings(); startTimer(); });
        $("themeMode").addEventListener("change", (event) => {
          state.themeMode = event.target.value;
          saveSettings();
          applyTheme();
          requestAnimationFrame(() => analyzeCurrent());
        });
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
          if (!state.watch.includes(symbol)) state.watch.push(symbol);
          localStorage.setItem("watchSymbols", JSON.stringify(state.watch));
          $("watchInput").value = "";
          renderWatch();
        });
        document.querySelectorAll(".nav-btn").forEach((btn) => {
          btn.addEventListener("click", () => {
            if (btn.classList.contains("active")) return;
            document.querySelectorAll(".nav-btn").forEach((item) => item.classList.remove("active"));
            document.querySelectorAll(".page").forEach((item) => item.classList.remove("active"));
            btn.classList.add("active");
            $("page-" + btn.dataset.page).classList.add("active");
            if (btn.dataset.page === "scan" && !$("scanList").children.length) {
              $("scanStatus").textContent = "AI Market Radar：点击开始扫描，批量分析成交额靠前的交易对。";
            }
            if (btn.dataset.page === "watch") renderWatch();
          });
        });
        window.addEventListener("resize", analyzeCurrent);
        analyzeCurrent();
        startTimer();
      }

      function startTimer() {
        if (state.timer) clearInterval(state.timer);
        state.timer = setInterval(analyzeCurrent, Number(state.refreshInterval) * 1000);
      }

      setup();
    </script>
  </body>
</html>`;

const upstreams = {
  futures: ["https://fapi.binance.com", "https://fapi1.binance.com", "https://fapi2.binance.com", "https://fapi3.binance.com"],
  spot: ["https://api.binance.com", "https://data-api.binance.vision"]
};

const routes = {
  futures: {
    ticker: "/fapi/v1/ticker/24hr",
    klines: "/fapi/v1/klines"
  },
  spot: {
    ticker: "/api/v3/ticker/24hr",
    klines: "/api/v3/klines"
  }
};

async function proxyBinance(url) {
  const market = url.searchParams.get("market") === "spot" ? "spot" : "futures";
  const type = url.pathname.endsWith("/klines") ? "klines" : url.pathname.endsWith("/tickers") ? "tickers" : "ticker";
  const params = new URLSearchParams();
  if (type !== "tickers") {
    params.set("symbol", cleanSymbol(url.searchParams.get("symbol")));
  }
  if (type === "klines") {
    params.set("interval", cleanInterval(url.searchParams.get("interval")));
    params.set("limit", String(Math.min(200, Math.max(20, Number(url.searchParams.get("limit") || 120)))));
  }

  const path = routes[market][type === "klines" ? "klines" : "ticker"];
  let lastError = null;
  for (const base of upstreams[market]) {
    try {
      const target = base + path + (params.toString() ? "?" + params.toString() : "");
      const res = await fetch(target, {
        headers: { "accept": "application/json", "user-agent": "Mozilla/5.0" },
        signal: timeoutSignal(1800),
        cf: { cacheTtl: type === "klines" ? 8 : 3, cacheEverything: false }
      });
      if (res.ok) {
        return new Response(await res.text(), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "access-control-allow-origin": "*"
          }
        });
      }
      lastError = new Error("upstream " + res.status);
    } catch (error) {
      lastError = error;
    }
  }
  return proxyOkx(url, type, lastError);
}

async function proxyOkx(url, type, lastError) {
  const symbol = cleanSymbol(url.searchParams.get("symbol"));
  const instId = toOkxInstId(symbol);
  const bar = toOkxBar(cleanInterval(url.searchParams.get("interval")));
  const limit = String(Math.min(100, Math.max(20, Number(url.searchParams.get("limit") || 100))));
  const targets = [];
  if (type === "ticker") targets.push("https://www.okx.com/api/v5/market/ticker?instId=" + instId);
  if (type === "tickers") targets.push("https://www.okx.com/api/v5/market/tickers?instType=SWAP");
  if (type === "klines") targets.push("https://www.okx.com/api/v5/market/candles?instId=" + instId + "&bar=" + bar + "&limit=" + limit);

  for (const target of targets) {
    try {
      const res = await fetch(target, {
        headers: { "accept": "application/json", "user-agent": "Mozilla/5.0" },
        signal: timeoutSignal(1800),
        cf: { cacheTtl: type === "klines" ? 8 : 3, cacheEverything: false }
      });
      if (!res.ok) continue;
      const payload = await res.json();
      if (payload.code !== "0") continue;
      let data = payload.data;
      if (type === "ticker") data = convertOkxTicker(data[0]);
      if (type === "tickers") data = data.filter((item) => item.instId.endsWith("-USDT-SWAP")).map(convertOkxTicker);
      if (type === "klines") data = data.map(convertOkxCandle).reverse();
      return Response.json(data, {
        headers: {
          "cache-control": "no-store",
          "access-control-allow-origin": "*"
        }
      });
    } catch (error) {
      lastError = error;
    }
  }
  return proxyBybit(url, type, lastError);
}

async function proxyBybit(url, type, lastError) {
  const symbol = cleanSymbol(url.searchParams.get("symbol"));
  const interval = toBybitInterval(cleanInterval(url.searchParams.get("interval")));
  const limit = String(Math.min(100, Math.max(20, Number(url.searchParams.get("limit") || 100))));
  const targets = [];
  if (type === "ticker") targets.push("https://api.bybit.com/v5/market/tickers?category=linear&symbol=" + symbol);
  if (type === "tickers") targets.push("https://api.bybit.com/v5/market/tickers?category=linear");
  if (type === "klines") targets.push("https://api.bybit.com/v5/market/kline?category=linear&symbol=" + symbol + "&interval=" + interval + "&limit=" + limit);

  for (const target of targets) {
    try {
      const res = await fetch(target, {
        headers: { "accept": "application/json", "user-agent": "Mozilla/5.0" },
        signal: timeoutSignal(1800),
        cf: { cacheTtl: type === "klines" ? 8 : 3, cacheEverything: false }
      });
      if (!res.ok) {
        lastError = new Error("bybit " + res.status);
        continue;
      }
      const payload = await res.json();
      if (payload.retCode !== 0) {
        lastError = new Error(payload.retMsg || "bybit failed");
        continue;
      }
      let data = payload.result.list || [];
      if (type === "ticker") data = convertBybitTicker(data[0]);
      if (type === "tickers") data = data.filter((item) => String(item.symbol || "").endsWith("USDT")).map(convertBybitTicker);
      if (type === "klines") data = data.map(convertBybitCandle).reverse();
      return Response.json(data, {
        headers: {
          "cache-control": "no-store",
          "access-control-allow-origin": "*"
        }
      });
    } catch (error) {
      lastError = error;
    }
  }
  return Response.json({ error: lastError ? lastError.message : "proxy failed" }, { status: 502 });
}

function cleanSymbol(value) {
  const symbol = String(value || "BTCUSDT").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return symbol.endsWith("USDT") ? symbol : symbol + "USDT";
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function cleanInterval(value) {
  return ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"].includes(value) ? value : "1h";
}

function toOkxInstId(symbol) {
  return symbol.replace("USDT", "-USDT-SWAP");
}

function toOkxBar(interval) {
  return { "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1H", "2h": "2H", "4h": "4H", "6h": "6H", "12h": "12H", "1d": "1D" }[interval] || "1H";
}

function convertOkxTicker(item) {
  const last = Number(item.last || 0);
  const open = Number(item.open24h || last || 1);
  const change = open ? ((last - open) / open) * 100 : 0;
  return {
    symbol: String(item.instId || "").replace("-USDT-SWAP", "USDT"),
    lastPrice: String(item.last || "0"),
    priceChangePercent: String(change),
    highPrice: String(item.high24h || item.last || "0"),
    lowPrice: String(item.low24h || item.last || "0"),
    quoteVolume: String(item.volCcy24h || item.vol24h || "0")
  };
}

function convertOkxCandle(item) {
  return [
    Number(item[0]),
    String(item[1]),
    String(item[2]),
    String(item[3]),
    String(item[4]),
    String(item[5] || "0")
  ];
}

function toBybitInterval(interval) {
  return { "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "2h": "120", "4h": "240", "6h": "360", "12h": "720", "1d": "D" }[interval] || "60";
}

function convertBybitTicker(item) {
  const change = Number(item.price24hPcnt || 0) * 100;
  return {
    symbol: String(item.symbol || ""),
    lastPrice: String(item.lastPrice || "0"),
    priceChangePercent: String(change),
    highPrice: String(item.highPrice24h || item.lastPrice || "0"),
    lowPrice: String(item.lowPrice24h || item.lastPrice || "0"),
    quoteVolume: String(item.turnover24h || item.volume24h || "0")
  };
}

function convertBybitCandle(item) {
  return [
    Number(item[0]),
    String(item[1]),
    String(item[2]),
    String(item[3]),
    String(item[4]),
    String(item[5] || "0")
  ];
}

// ===================== Quant Engine v0.1(纯规则、只用真实数据、不调用LLM) =====================
// 分层模块:MarketDataProvider(缓存取数) / IndicatorEngine / MarketStructureEngine /
// MarketRegimeEngine / VolumeAnalyzer / VolatilityAnalyzer / BTCContextAnalyzer /
// SignalEngine + RiskEngine(computeAnalysis / decide)。
// 全部判断只使用已收盘K线(避免 Look-Ahead Bias);纯函数可离线注入测试。
const ENGINE_VERSION = "rule-v0.1";
const TF_LIST = ["1m", "5m", "15m", "1h", "4h", "1d"];
const TF_WEIGHTS = { "1m": 0.45, "5m": 0.8, "15m": 1.2, "1h": 1.5, "4h": 1.2, "1d": 1.0 };
const INTERVAL_MS = { "1m": 6e4, "3m": 18e4, "5m": 3e5, "15m": 9e5, "30m": 18e5, "1h": 36e5, "2h": 72e5, "4h": 144e5, "6h": 216e5, "12h": 432e5, "1d": 864e5 };
const DIR_ZH = { "Strong Bullish": "强看涨", "Bullish": "看涨", "Neutral": "中性", "Bearish": "看跌", "Strong Bearish": "强看跌" };

// ---- MarketDataProvider:内存缓存,避免重复下载同一段K线 ----
const KL_CACHE = new Map();
const TICKERS_CACHE = new Map();
const KL_TTL = 20000;
const TICKERS_TTL = 15000;

function cacheGet(cache, key, ttl) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  return null;
}

function cacheSet(cache, key, data) {
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 600) {
    const now = Date.now();
    for (const [k, v] of cache) if (now - v.at > 120000) cache.delete(k);
  }
}

// engine.local 只是参数载体:proxyBinance 只按 searchParams 组装固定上游白名单 host,绝不会请求该地址
function engineUrl(path, params) {
  const url = new URL("https://engine.local" + path);
  for (const key of Object.keys(params)) url.searchParams.set(key, String(params[key]));
  return url;
}

async function getKlines(market, symbol, interval, limit) {
  const key = market + "|" + symbol + "|" + interval + "|" + limit;
  const hit = cacheGet(KL_CACHE, key, KL_TTL);
  if (hit) return hit;
  const res = await proxyBinance(engineUrl("/api/klines", { market, symbol, interval, limit }));
  if (!res.ok) throw new Error("klines " + symbol + " " + interval + " 获取失败");
  const raw = await res.json();
  if (!Array.isArray(raw) || !raw.length) throw new Error("klines " + symbol + " " + interval + " 数据为空");
  const rows = raw.map((k) => ({
    openTime: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: k.length > 6 && Number(k[6]) > 0 ? Number(k[6]) : Number(k[0]) + (INTERVAL_MS[interval] || 36e5) - 1
  })).filter((r) => r.close > 0 && r.high >= r.low && r.low > 0);
  cacheSet(KL_CACHE, key, rows);
  return rows;
}

async function getTickers(market) {
  const hit = cacheGet(TICKERS_CACHE, market, TICKERS_TTL);
  if (hit) return hit;
  const res = await proxyBinance(engineUrl("/api/tickers", { market }));
  if (!res.ok) throw new Error("tickers 获取失败");
  const raw = await res.json();
  const data = Array.isArray(raw) ? raw : [];
  cacheSet(TICKERS_CACHE, market, data);
  return data;
}

// ---- 基础数学 ----
function delaySrv(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function stdevSrv(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / (values.length - 1));
}
function median(values) {
  if (!values.length) return 0;
  const arr = [...values].sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}
function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 10) return null;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i += 1) { ma += a[a.length - n + i]; mb += b[b.length - n + i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i += 1) {
    const xa = a[a.length - n + i] - ma, xb = b[b.length - n + i] - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  return da && db ? num / Math.sqrt(da * db) : null;
}
function r2(v) {
  return v == null || !isFinite(v) ? null : Math.round(v * 100) / 100;
}
function fmtPrice(v) {
  if (v == null || !isFinite(v)) return "--";
  if (v >= 1000) return v.toFixed(0);
  if (v >= 1) return v.toFixed(2);
  return v.toPrecision(4);
}

// ---- IndicatorEngine ----
function emaSeriesSrv(values, n) {
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
function emaLast(values, n) {
  const series = emaSeriesSrv(values, n);
  return series ? series[series.length - 1] : null;
}
function smaLast(values, n) {
  if (values.length < n) return null;
  let sum = 0;
  for (let i = values.length - n; i < values.length; i += 1) sum += values[i];
  return sum / n;
}
function rsiLast(values, n) {
  if (values.length <= n) return 50;
  let gain = 0, loss = 0;
  for (let i = values.length - n; i < values.length; i += 1) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}
function macdLast(closes) {
  const fast = emaSeriesSrv(closes, 12);
  const slow = emaSeriesSrv(closes, 26);
  if (!fast || !slow) return null;
  const line = [];
  for (let i = 0; i < closes.length; i += 1) if (fast[i] != null && slow[i] != null) line.push(fast[i] - slow[i]);
  if (!line.length) return null;
  const sig = emaSeriesSrv(line, 9);
  const macd = line[line.length - 1];
  const signal = sig ? sig[sig.length - 1] : macd;
  return { macd, signal, hist: macd - signal };
}
function bbLast(closes, n, k) {
  const mid = smaLast(closes, n || 20);
  if (mid == null) return null;
  const win = closes.slice(-(n || 20));
  const sd = stdevSrv(win);
  const kk = k || 2;
  return { mid, upper: mid + kk * sd, lower: mid - kk * sd, widthPct: mid ? 2 * kk * sd / mid * 100 : 0 };
}
function trueRanges(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (i === 0) { out.push(rows[i].high - rows[i].low); continue; }
    const pc = rows[i - 1].close;
    out.push(Math.max(rows[i].high - rows[i].low, Math.abs(rows[i].high - pc), Math.abs(rows[i].low - pc)));
  }
  return out;
}
function atrLast(rows, n) {
  const tr = trueRanges(rows);
  if (tr.length < (n || 14) + 1) return tr.length ? Math.max(...tr) : null;
  let atr = 0;
  for (let i = 1; i <= (n || 14); i += 1) atr += tr[i];
  atr /= (n || 14);
  for (let i = (n || 14) + 1; i < tr.length; i += 1) atr = (atr * ((n || 14) - 1) + tr[i]) / (n || 14);
  return atr;
}
function adxLast(rows, n) {
  const N = n || 14;
  if (rows.length < N * 2 + 2) return null;
  const trs = trueRanges(rows);
  let trS = 0, pS = 0, mS = 0, pdi = 0, mdi = 0;
  for (let i = 1; i <= N; i += 1) {
    const up = rows[i].high - rows[i - 1].high;
    const dn = rows[i - 1].low - rows[i].low;
    pS += up > dn && up > 0 ? up : 0;
    mS += dn > up && dn > 0 ? dn : 0;
    trS += trs[i];
  }
  const dxs = [];
  for (let i = N + 1; i < rows.length; i += 1) {
    const up = rows[i].high - rows[i - 1].high;
    const dn = rows[i - 1].low - rows[i].low;
    pS = pS - pS / N + (up > dn && up > 0 ? up : 0);
    mS = mS - mS / N + (dn > up && dn > 0 ? dn : 0);
    trS = trS - trS / N + trs[i];
    pdi = trS ? pS / trS * 100 : 0;
    mdi = trS ? mS / trS * 100 : 0;
    dxs.push(pdi + mdi ? Math.abs(pdi - mdi) / (pdi + mdi) * 100 : 0);
  }
  if (!dxs.length) return null;
  const seed = Math.min(N, dxs.length);
  let adx = dxs.slice(0, seed).reduce((a, b) => a + b, 0) / seed;
  for (let i = seed; i < dxs.length; i += 1) adx = (adx * (N - 1) + dxs[i]) / N;
  return { adx, pdi, mdi };
}
function slopePct(closes, n) {
  if (closes.length < n) return 0;
  const ys = closes.slice(-n);
  const mean = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (i - (n - 1) / 2) * (ys[i] - mean);
    den += Math.pow(i - (n - 1) / 2, 2);
  }
  const slope = den ? num / den : 0;
  return mean ? slope / mean * 100 : 0;
}
function rocLast(values, n) {
  if (values.length <= n) return 0;
  const prev = values[values.length - 1 - n];
  return prev ? (values[values.length - 1] / prev - 1) * 100 : 0;
}
function hvLast(closes, n) {
  if (closes.length <= n) return null;
  const rets = [];
  for (let i = closes.length - n; i < closes.length; i += 1) rets.push(closes[i] / closes[i - 1] - 1);
  return stdevSrv(rets) * 100;
}
function vwapLast(rows, n) {
  const win = rows.slice(-(n || 50));
  let pv = 0, v = 0;
  for (const r of win) {
    const tp = (r.high + r.low + r.close) / 3;
    pv += tp * r.volume;
    v += r.volume;
  }
  return v ? pv / v : null;
}
function mfiLast(rows, n) {
  const N = n || 14;
  if (rows.length < N + 1) return null;
  let pos = 0, neg = 0;
  for (let i = rows.length - N; i < rows.length; i += 1) {
    const tp = (rows[i].high + rows[i].low + rows[i].close) / 3;
    const pp = (rows[i - 1].high + rows[i - 1].low + rows[i - 1].close) / 3;
    const flow = tp * rows[i].volume;
    if (tp > pp) pos += flow; else if (tp < pp) neg += flow;
  }
  if (neg === 0) return 100;
  return 100 - 100 / (1 + pos / neg);
}
function cciLast(rows, n) {
  const N = n || 20;
  if (rows.length < N) return null;
  const tps = rows.slice(-N).map((r) => (r.high + r.low + r.close) / 3);
  const mean = tps.reduce((a, b) => a + b, 0) / N;
  const md = tps.reduce((a, b) => a + Math.abs(b - mean), 0) / N;
  return md ? (tps[tps.length - 1] - mean) / (0.015 * md) : 0;
}
function stochRsiLast(closes) {
  const n = 14;
  if (closes.length < n * 2 + 2) return null;
  const rsis = [];
  for (let i = closes.length - 2 * n; i < closes.length; i += 1) rsis.push(rsiLast(closes.slice(0, i + 1), n));
  const win = rsis.slice(-n);
  const min = Math.min(...win), max = Math.max(...win);
  return max === min ? 50 : (win[win.length - 1] - min) / (max - min) * 100;
}
function obvDir(rows) {
  if (rows.length < 12) return 0;
  let obv = 0;
  const series = [];
  for (let i = 1; i < rows.length; i += 1) {
    obv += rows[i].close > rows[i - 1].close ? rows[i].volume : rows[i].close < rows[i - 1].close ? -rows[i].volume : 0;
    series.push(obv);
  }
  const recent = series.slice(-5);
  const older = series.slice(-12, -5);
  const ra = recent.reduce((a, b) => a + b, 0) / recent.length;
  const ro = older.length ? older.reduce((a, b) => a + b, 0) / older.length : ra;
  return ra > ro * 1.02 ? 1 : ra < ro * 0.98 ? -1 : 0;
}

// ---- MarketStructureEngine ----
function findSwings(rows, left, right) {
  const L = left || 2, R = right || 2;
  const out = [];
  for (let i = L; i < rows.length - R; i += 1) {
    let isHigh = true, isLow = true;
    for (let j = i - L; j <= i + R; j += 1) {
      if (j === i) continue;
      if (rows[j].high >= rows[i].high) isHigh = false;
      if (rows[j].low <= rows[i].low) isLow = false;
    }
    if (isHigh) out.push({ type: "high", idx: i, price: rows[i].high });
    else if (isLow) out.push({ type: "low", idx: i, price: rows[i].low });
  }
  return out;
}
function structureQuick(rows) {
  const recent = rows.slice(-80);
  const sw = findSwings(recent, 2, 2);
  const highs = sw.filter((s) => s.type === "high").slice(-3);
  const lows = sw.filter((s) => s.type === "low").slice(-3);
  let dir = 0;
  if (highs.length >= 2 && lows.length >= 2) {
    const price = recent[recent.length - 1].close;
    const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
    const hl = lows[lows.length - 1].price > lows[lows.length - 2].price;
    const mag = ((highs[highs.length - 1].price - highs[highs.length - 2].price) + (lows[lows.length - 1].price - lows[lows.length - 2].price)) / price * 100;
    if (hh && hl) dir = Math.min(1, Math.max(0, mag / 2));
    else if (!hh && !hl) dir = Math.max(-1, Math.min(0, mag / 2));
  }
  return { dir, lastHigh: highs.length ? highs[highs.length - 1].price : null, lastLow: lows.length ? lows[lows.length - 1].price : null };
}
function analyzeStructure(rows) {
  if (rows.length < 40) return { label: "数据不足", hh: 0, hl: 0, lh: 0, ll: 0, lastHigh: null, lastLow: null, brokeHigh: false, brokeLow: false };
  const sw = findSwings(rows, 2, 2);
  const highs = sw.filter((s) => s.type === "high").slice(-4);
  const lows = sw.filter((s) => s.type === "low").slice(-4);
  const sig = 0.003; // 摆动幅度小于0.3%的抬升/降低视为噪声,不计入结构
  let hh = 0, lh = 0, hl = 0, ll = 0;
  for (let i = 1; i < highs.length; i += 1) {
    if (highs[i].price > highs[i - 1].price * (1 + sig)) hh += 1;
    else if (highs[i].price < highs[i - 1].price * (1 - sig)) lh += 1;
  }
  for (let i = 1; i < lows.length; i += 1) {
    if (lows[i].price > lows[i - 1].price * (1 + sig)) hl += 1;
    else if (lows[i].price < lows[i - 1].price * (1 - sig)) ll += 1;
  }
  const price = rows[rows.length - 1].close;
  const lastHigh = highs.length ? highs[highs.length - 1] : null;
  const lastLow = lows.length ? lows[lows.length - 1] : null;
  let label = "震荡";
  if (hh > lh && hl > ll && hh + hl >= 2) label = "上涨结构";
  else if (lh > hh && ll > hl && lh + ll >= 2) label = "下降结构";
  return { label, hh, hl, lh, ll, lastHigh, lastLow, brokeHigh: Boolean(lastHigh && price > lastHigh.price), brokeLow: Boolean(lastLow && price < lastLow.price) };
}
function srZones(rows, price) {
  if (rows.length < 40 || !price) return { supports: [], resistances: [] };
  const sw = findSwings(rows, 2, 2);
  const pts = sw.map((s) => s.price).sort((a, b) => a - b);
  const clusters = [];
  for (const p of pts) {
    const c = clusters[clusters.length - 1];
    if (c && Math.abs(p - c.mean) / c.mean < 0.007) {
      c.vals.push(p);
      c.mean = c.vals.reduce((a, b) => a + b, 0) / c.vals.length;
    } else clusters.push({ vals: [p], mean: p });
  }
  const zones = [];
  for (const c of clusters) {
    if (c.vals.length < 2 && Math.abs(c.mean / price - 1) >= 0.025) continue;
    const pad = c.mean * 0.0015;
    const lo = Math.min(...c.vals) - pad, hi = Math.max(...c.vals) + pad;
    let touches = 0, inside = false;
    for (const r of rows) {
      const inZone = r.low <= hi && r.high >= lo;
      if (inZone && !inside) touches += 1;
      inside = inZone;
    }
    if (touches + c.vals.length < 2) continue;
    zones.push({ lo, hi, mean: c.mean, touches: touches + c.vals.length, distPct: (c.mean - price) / price * 100 });
  }
  const supports = zones.filter((z) => z.mean < price).sort((a, b) => b.mean - a.mean).slice(0, 2);
  const resistances = zones.filter((z) => z.mean >= price).sort((a, b) => a.mean - b.mean).slice(0, 2);
  return { supports, resistances };
}

// ---- MarketRegimeEngine ----
function marketRegime(rows, structure) {
  if (rows.length < 40) return { label: "Range", trendMarket: false, volState: "Normal", adx: null, atrPct: null, bbWidthPct: null, slope10: null };
  const closes = rows.map((r) => r.close);
  const price = closes[closes.length - 1];
  const e20 = emaLast(closes, 20), e50 = emaLast(closes, 50), e200 = emaLast(closes, 200);
  const ax = adxLast(rows, 14);
  const slope = slopePct(closes, 10);
  const bb = bbLast(closes, 20, 2);
  const atr = atrLast(rows, 14);
  const atrPct = atr && price ? atr / price * 100 : 0;
  const trs = trueRanges(rows).slice(-100);
  const medTr = median(trs) || atr || 1;
  const volRatio = atr / medTr;
  let bias = 0;
  if (e20 != null && e50 != null) bias += e20 > e50 ? 1 : -1;
  if (e50 != null && e200 != null) bias += e50 > e200 ? 1 : -1;
  bias += structure.label === "上涨结构" ? 1 : structure.label === "下降结构" ? -1 : 0;
  if (Math.abs(slope) > 0.4) bias += slope > 0 ? 1 : -1;
  const adx = ax ? ax.adx : null;
  let label = "Range";
  if (adx != null && adx >= 25 && bias >= 3) label = "Strong Uptrend";
  else if (adx != null && adx >= 18 && bias >= 2) label = "Weak Uptrend";
  else if (adx != null && adx >= 25 && bias <= -3) label = "Strong Downtrend";
  else if (adx != null && adx >= 18 && bias <= -2) label = "Weak Downtrend";
  else if (bias >= 1) label = "Bullish Range";
  else if (bias <= -1) label = "Bearish Range";
  const volState = volRatio >= 1.5 ? "Expansion" : volRatio <= 0.72 ? "Compression" : "Normal";
  return { label, trendMarket: adx != null && adx >= 18, volState, adx: ax ? Math.round(adx * 10) / 10 : null, atrPct: r2(atrPct), bbWidthPct: bb ? r2(bb.widthPct) : null, slope10: r2(slope) };
}
function regimeLite(rows) {
  if (rows.length < 40) return { label: "Range" };
  const closes = rows.map((r) => r.close);
  const e20 = emaLast(closes, 20), e50 = emaLast(closes, 50);
  const ax = adxLast(rows, 14);
  const slope = slopePct(closes, 10);
  let bias = 0;
  if (e20 != null && e50 != null) bias += e20 > e50 ? 1 : -1;
  if (Math.abs(slope) > 0.4) bias += slope > 0 ? 1 : -1;
  const adx = ax ? ax.adx : null;
  let label = "Range";
  if (adx != null && adx >= 25 && bias >= 2) label = "Strong Uptrend";
  else if (adx != null && adx >= 18 && bias >= 1) label = "Weak Uptrend";
  else if (adx != null && adx >= 25 && bias <= -2) label = "Strong Downtrend";
  else if (adx != null && adx >= 18 && bias <= -1) label = "Weak Downtrend";
  else if (bias >= 1) label = "Bullish Range";
  else if (bias <= -1) label = "Bearish Range";
  return { label };
}

// ---- VolumeAnalyzer / VolatilityAnalyzer / 异常检测 ----
function volumeAnalysis(rows) {
  const n = rows.length;
  if (n < 25) return { ratio20: null, ratio50: null, spike: false, pattern: "量能数据不足", divergence: false, volExpand: false };
  const vols = rows.map((r) => r.volume);
  const vNow = vols[n - 1] || 0;
  const avg20 = smaLast(vols, 20);
  const avg50 = smaLast(vols, 50);
  const ratio20 = avg20 ? vNow / avg20 : 1;
  const ratio50 = avg50 ? vNow / avg50 : 1;
  const spike = ratio20 >= 2.5;
  const priceChg10 = n > 11 ? (rows[n - 1].close / rows[n - 11].close - 1) * 100 : 0;
  const recentAvg = smaLast(vols.slice(0, n - 3), 20);
  const volExpand = recentAvg ? vNow / recentAvg > 1.3 : false;
  let pattern = "量能平稳";
  if (priceChg10 > 0.25) pattern = volExpand ? "放量上涨" : "缩量上涨";
  else if (priceChg10 < -0.25) pattern = volExpand ? "放量下跌" : "缩量下跌";
  let divergence = false;
  if (n > 25) {
    const hi20 = Math.max(...rows.slice(-20, -1).map((r) => r.high));
    if (rows[n - 1].high >= hi20 && avg20 && vNow < avg20 * 0.85) divergence = true;
  }
  return { ratio20: r2(ratio20), ratio50: r2(ratio50), spike, pattern, divergence, volExpand };
}
function volatilityAnalysis(rows) {
  if (rows.length < 30) return { level: "Normal", atrPct: null, ratio: null, bbWidthPct: null, hvPct: null };
  const closes = rows.map((r) => r.close);
  const atr = atrLast(rows, 14);
  const price = closes[closes.length - 1];
  const atrPct = atr && price ? atr / price * 100 : 0;
  const trs = trueRanges(rows).slice(-100);
  const base = rows.slice(rows.length - trs.length);
  const pct = trs.map((v, i) => base[i].close ? v / base[i].close * 100 : 0);
  const medPct = median(pct) || atrPct || 1;
  const ratio = medPct ? atrPct / medPct : 1;
  const bb = bbLast(closes, 20, 2);
  const hv = hvLast(closes, 20);
  const level = ratio >= 2 ? "Extreme" : ratio >= 1.4 ? "High" : ratio <= 0.6 ? "Very Low" : ratio <= 0.85 ? "Low" : "Normal";
  return { level, atrPct: r2(atrPct), ratio: r2(ratio), bbWidthPct: bb ? r2(bb.widthPct) : null, hvPct: r2(hv) };
}
function anomalyDetect(rows, vol) {
  const kinds = [];
  if (vol.ratio20 != null && vol.ratio20 >= 3) kinds.push("异常放量");
  const closes = rows.map((r) => r.close);
  if (closes.length >= 15) {
    const rets = [];
    for (let i = closes.length - 30 > 1 ? closes.length - 30 : 1; i < closes.length; i += 1) rets.push(closes[i] / closes[i - 1] - 1);
    if (rets.length >= 10) {
      const sd = stdevSrv(rets) || 1e-9;
      const last = rets[rets.length - 1];
      if (Math.abs(last) > Math.max(3.5 * sd, 0.02)) kinds.push(last > 0 ? "瞬间跳涨" : "瞬间跳跌");
    }
  }
  if (vol.ratio != null && vol.ratio >= 1.9) kinds.push("波动率骤升");
  return { detected: kinds.length > 0, kinds };
}

// ---- 多周期评估(Timeframe Analyst) ----
// 幅度校准:指标贡献随分离幅度饱和(tanh),避免噪声级分离拿到趋势级权重
function tfEvaluate(rows) {
  if (rows.length < 30) return { score: 0, label: "Neutral", enough: false };
  const closes = rows.map((r) => r.close);
  const price = closes[closes.length - 1];
  const e9 = emaLast(closes, 9), e21 = emaLast(closes, 21), e55 = emaLast(closes, 55);
  const rsi = rsiLast(closes, 14);
  const macd = macdLast(closes);
  const roc = rocLast(closes, 9);
  const st = structureQuick(rows);
  let score = 0;
  if (e9 != null && e21 != null && e21 !== 0 && e9 !== e21) {
    score += 0.7 * Math.tanh(((e9 - e21) / e21 * 100) / 0.3);
  }
  if (e21 != null && e55 != null && e55 !== 0 && e21 !== e55) {
    score += 0.5 * Math.tanh(((e21 - e55) / e55 * 100) / 0.6);
  }
  if (macd && price) {
    score += 0.4 * Math.tanh((macd.hist / price * 100) / 0.08);
  }
  score += 0.25 * Math.max(-1, Math.min(1, (rsi - 50) / 10));
  score += 0.15 * Math.tanh(roc / 0.5);
  score += st.dir * 0.5;
  score = Math.max(-2, Math.min(2, score));
  const label = score >= 1.1 ? "Strong Bullish" : score >= 0.35 ? "Bullish" : score <= -1.1 ? "Strong Bearish" : score <= -0.35 ? "Bearish" : "Neutral";
  return { score: Math.round(score * 100) / 100, label, enough: true };
}

// ---- BTCContextAnalyzer ----
function correlationOf(aCloses, bCloses) {
  const ra = [], rb = [];
  const n = Math.min(aCloses.length, bCloses.length, 101);
  if (n < 31) return null;
  for (let i = aCloses.length - n + 1; i < aCloses.length; i += 1) ra.push(aCloses[i] / aCloses[i - 1] - 1);
  for (let i = bCloses.length - n + 1; i < bCloses.length; i += 1) rb.push(bCloses[i] / bCloses[i - 1] - 1);
  return r2(pearson(ra, rb));
}
function btcContext(symbol, isBtc, interval, btcRowsByTf, symCloses, tickers, now) {
  if (isBtc) return { state: "BTC Self", corr: null, relStrength: null, btc1hLabel: null, btc4hLabel: null };
  const cut = (rows) => splitClosed(rows || [], now).closed;
  const btc1h = tfEvaluate(cut(btcRowsByTf["1h"]));
  const btc4h = tfEvaluate(cut(btcRowsByTf["4h"]));
  const btc15 = tfEvaluate(cut(btcRowsByTf["15m"]));
  const avgScore = ((btc15.enough ? btc15.score : 0) + (btc1h.enough ? btc1h.score : 0) * 1.5 + (btc4h.enough ? btc4h.score : 0) * 1.5) / 4;
  const btcMain = cut(btcRowsByTf[interval]);
  let state = "BTC Stable";
  if (btcMain.length > 10) {
    const drop = btcMain[btcMain.length - 1].close / btcMain[btcMain.length - 4].close - 1;
    if (drop < -0.015) state = "BTC Rapid Selloff";
  }
  if (state === "BTC Stable" && avgScore >= 0.8) state = "BTC Strong";
  else if (state === "BTC Stable" && avgScore <= -0.8) state = "BTC Weak";
  const btcVol = volatilityAnalysis(btcMain.length >= 30 ? btcMain : cut(btcRowsByTf["1h"]));
  if (state === "BTC Stable" && btcVol.ratio != null && btcVol.ratio >= 1.8) state = "BTC High Volatility";
  const symT = (tickers || []).find((t) => t.symbol === symbol);
  const btcT = (tickers || []).find((t) => t.symbol === "BTCUSDT");
  const relStrength = symT && btcT ? r2(Number(symT.priceChangePercent || 0) - Number(btcT.priceChangePercent || 0)) : null;
  const corr = symCloses.length >= 31 && btcMain.length >= 31 ? correlationOf(symCloses, btcMain.map((r) => r.close)) : null;
  return { state, corr, relStrength, btc1hLabel: btc1h.enough ? btc1h.label : null, btc4hLabel: btc4h.enough ? btc4h.label : null };
}

// ---- 市场广度 ----
function breadthFromTickers(tickers) {
  const top = (tickers || [])
    .filter((t) => String(t.symbol || "").endsWith("USDT") && !String(t.symbol).includes("_"))
    .sort((a, b) => Number(b.quoteVolume || 0) - Number(a.quoteVolume || 0))
    .slice(0, 100);
  if (!top.length) return null;
  const up = top.filter((t) => Number(t.priceChangePercent || 0) > 0).length;
  return { up_pct: Math.round(up / top.length * 100), sample: top.length };
}

// ---- K线状态保护:只允许已收盘K线进入判断 ----
function splitClosed(rows, nowMs) {
  const now = nowMs || Date.now();
  let cut = rows.length;
  while (cut > 0 && rows[cut - 1].closeTime > now - 300) cut -= 1;
  return { closed: rows.slice(0, cut), forming: rows.slice(cut) };
}

// ---- SignalEngine:纯函数,输入全部数据,输出结构化结论 ----
function computeAnalysis(input) {
  const now = input.nowMs || Date.now();
  const symbol = input.symbol;
  const interval = input.interval;
  const ticker = input.ticker || {};
  const isBtc = symbol === "BTCUSDT";
  const scoringTfs = [...new Set([...TF_LIST, interval])];
  const weightOf = (tf) => (TF_WEIGHTS[tf] || 1.1) * (tf === interval ? 1.25 : 1);

  const tfResults = {};
  for (const tf of scoringTfs) {
    tfResults[tf] = tfEvaluate(splitClosed(input.tfRows[tf] || [], now).closed);
  }

  const main = splitClosed(input.tfRows[interval] || [], now);
  const rows = main.closed;
  const limitedData = rows.length < 60;
  const lastClose = rows.length ? rows[rows.length - 1].close : 0;
  const price = ticker.lastPrice != null && Number(ticker.lastPrice) > 0 ? Number(ticker.lastPrice) : lastClose;
  const change24h = Number(ticker.priceChangePercent || 0);
  const high24h = Number(ticker.highPrice || 0);
  const low24h = Number(ticker.lowPrice || 0);
  const quoteVolume24h = Number(ticker.quoteVolume || 0);

  const structure = analyzeStructure(rows);
  const zones = srZones(rows, price);
  const vol = volumeAnalysis(rows);
  const vola = volatilityAnalysis(rows);
  const anomaly = anomalyDetect(rows, vol);
  const regime = marketRegime(rows, structure);
  const symCloses = rows.map((r) => r.close);
  const btc = btcContext(symbol, isBtc, interval, input.btcRows || {}, symCloses, input.tickers || [], now);
  const breadth = breadthFromTickers(input.tickers);

  // 方向聚合:加权多周期得分,不做简单投票
  let num = 0, den = 0, agreeUp = 0, agreeDown = 0, counted = 0;
  for (const tf of scoringTfs) {
    const v = tfResults[tf];
    if (!v.enough) continue;
    const w = weightOf(tf);
    num += v.score * w;
    den += w;
    counted += 1;
    if (v.score >= 0.35) agreeUp += 1;
    if (v.score <= -0.35) agreeDown += 1;
  }
  const wscore = den ? num / den : 0;
  const conflict = agreeUp >= 2 && agreeDown >= 2;
  let direction = "Neutral";
  if (!limitedData) {
    if (wscore >= 0.85) direction = "Strong Bullish";
    else if (wscore >= 0.35) direction = "Bullish";
    else if (wscore <= -0.85) direction = "Strong Bearish";
    else if (wscore <= -0.35) direction = "Bearish";
  }
  const bullish = direction === "Bullish" || direction === "Strong Bullish";
  const bearish = direction === "Bearish" || direction === "Strong Bearish";
  let signalStrength = Math.round(50 + wscore * 28);
  signalStrength = Math.max(0, Math.min(100, signalStrength));

  const nearestRes = zones.resistances.length ? zones.resistances[0] : null;
  const nearSup = zones.supports.length ? zones.supports[0] : null;
  const atrPct = vola.atrPct || 0;
  const volumeConfirms = (bullish && (vol.pattern === "放量上涨" || vol.spike)) || (bearish && (vol.pattern === "放量下跌" || vol.spike));

  // Confidence 与 Signal Strength 分开:置信度衡量"这个判断有多可靠"
  let confidence = 48 + Math.abs(wscore) * 22;
  if (counted >= 5 && (agreeUp + agreeDown) / counted >= 0.8) confidence += 6;
  if (conflict) confidence -= 14;
  if (anomaly.detected) confidence -= 12;
  if (vola.level === "High") confidence -= 5;
  if (vola.level === "Extreme") confidence -= 10;
  if (vola.level === "Very Low") confidence -= 4;
  if ((bullish || bearish) && !volumeConfirms) confidence -= 8;
  if (bullish && regime.label.indexOf("Uptrend") >= 0) confidence += 5;
  if (bearish && regime.label.indexOf("Downtrend") >= 0) confidence += 5;
  if (bullish && nearestRes && Math.abs(nearestRes.distPct) < atrPct) confidence -= 7;
  if (bearish && nearSup && Math.abs(nearSup.distPct) < atrPct) confidence -= 7;
  if (btc.state === "BTC Rapid Selloff" && bullish) confidence -= 10;
  if (btc.state === "BTC High Volatility") confidence -= 5;
  if (limitedData) confidence = Math.min(confidence, 40);
  confidence = Math.round(Math.max(5, Math.min(92, confidence)));

  // RiskEngine
  let riskScore = 26 + Math.min(30, atrPct * 2.2);
  if (vola.ratio >= 1.4) riskScore += 6;
  if (vola.ratio >= 2) riskScore += 6;
  if (anomaly.detected) riskScore += 12;
  if (conflict) riskScore += 8;
  if (btc.state === "BTC Rapid Selloff") riskScore += 10;
  if (btc.state === "BTC High Volatility") riskScore += 6;
  if (limitedData) riskScore += 10;
  riskScore = Math.round(Math.max(0, Math.min(100, riskScore)));
  const riskLevel = riskScore < 30 ? "Low" : riskScore < 55 ? "Medium" : riskScore < 75 ? "High" : "Extreme";

  // Explainability: Why / Risks / Invalidation
  const reasons = [];
  const risks = [];
  const invalidation = [];
  if (limitedData) {
    reasons.push("该交易对历史K线不足(Limited Historical Data),仅给出低置信度参考");
  } else {
    const swNote = structure.hh + structure.hl > 0
      ? "(高点抬升" + structure.hh + "次、低点抬升" + structure.hl + "次)"
      : structure.lh + structure.ll > 0 ? "(高点降低" + structure.lh + "次、低点降低" + structure.ll + "次)" : "";
    reasons.push(interval + "周期市场结构:" + structure.label + swNote);
    if (regime.adx != null) {
      reasons.push(regime.trendMarket
        ? "ADX " + regime.adx + "," + (regime.label.indexOf("Up") >= 0 ? "上升趋势" : "下降趋势") + "环境(" + regime.volState + ")"
        : "ADX " + regime.adx + ",趋势强度不足,当前按区间环境处理");
    }
    if (vol.ratio20 != null && vol.ratio20 >= 1.5) reasons.push("成交量是20周期均量的 " + vol.ratio20 + " 倍," + vol.pattern);
    else reasons.push("量能" + (vol.pattern === "量能平稳" ? "平稳,方向未见有效放大配合" : vol.pattern));
    if (!isBtc && btc.btc1hLabel) reasons.push("BTC 1h " + DIR_ZH[btc.btc1hLabel] + "、4h " + DIR_ZH[btc.btc4hLabel] + (btc.corr != null ? ",与BTC相关性 " + btc.corr : ""));
    if (breadth && (breadth.up_pct >= 65 || breadth.up_pct <= 35)) reasons.push("市场广度:成交额前 " + breadth.sample + " 币种中 " + breadth.up_pct + "% 24h上涨");
    if (bullish && nearSup) reasons.push("价格下方有支撑区域 " + fmtPrice(nearSup.lo) + " - " + fmtPrice(nearSup.hi) + "(触及 " + nearSup.touches + " 次)");
    if (bearish && nearestRes) reasons.push("价格上方有阻力区域 " + fmtPrice(nearestRes.lo) + " - " + fmtPrice(nearestRes.hi) + "(触及 " + nearestRes.touches + " 次)");
  }
  if (conflict) risks.push("多周期方向存在冲突,趋势可信度下降");
  for (const kind of anomaly.kinds) risks.push("检测到" + kind + ",极端行情容易被误判为趋势");
  if (bullish && nearestRes && Math.abs(nearestRes.distPct) < atrPct) risks.push("价格贴近上方阻力区域 " + fmtPrice(nearestRes.lo) + " - " + fmtPrice(nearestRes.hi) + ",突破需要量能确认");
  if (bearish && nearSup && Math.abs(nearSup.distPct) < atrPct) risks.push("价格贴近下方支撑区域 " + fmtPrice(nearSup.lo) + " - " + fmtPrice(nearSup.hi) + ",跌破可能引发加速");
  if (btc.state === "BTC Rapid Selloff") risks.push("BTC正在快速下跌,山寨币联动风险升高");
  else if (btc.state === "BTC High Volatility") risks.push("BTC波动率升高,存在联动回调风险");
  if (vola.level === "Very Low") risks.push("波动率压缩,容易出现假突破");
  if ((bullish || bearish) && !volumeConfirms) risks.push("量能未确认方向,不宜追单");
  if (structure.lastLow && (bullish || direction === "Neutral")) invalidation.push("跌破最近结构低点 " + fmtPrice(structure.lastLow.price));
  if (structure.lastHigh && (bearish || direction === "Neutral")) invalidation.push("升破最近结构高点 " + fmtPrice(structure.lastHigh.price));
  if (regime.trendMarket) invalidation.push("ADX回落到20以下且EMA20/50重新纠缠,趋势环境失效");
  if (volumeConfirms) invalidation.push("成交量持续萎缩至20周期均量的0.7倍以下");

  const timeframes = {};
  for (const tf of scoringTfs) timeframes[tf] = tfResults[tf].label;

  // 供后续ML/历史验证使用的特征快照(不进UI)
  const e20 = emaLast(symCloses, 20);
  const features = {
    rsi14: Math.round(rsiLast(symCloses, 14)),
    macd_hist: r2(macdLast(symCloses) ? macdLast(symCloses).hist : null),
    adx: regime.adx,
    atr_pct: vola.atrPct,
    ema20_dist_pct: e20 && price ? r2((price - e20) / e20 * 100) : null,
    ema_slope10: regime.slope10,
    vwap_dist_pct: (() => { const vw = vwapLast(rows, 50); return vw && price ? r2((price - vw) / vw * 100) : null; })(),
    bb_width_pct: vola.bbWidthPct,
    obv_dir: obvDir(rows),
    mfi14: (() => { const v = mfiLast(rows, 14); return v == null ? null : Math.round(v); })(),
    cci20: r2(cciLast(rows, 20)),
    stoch_rsi: (() => { const v = stochRsiLast(symCloses); return v == null ? null : Math.round(v); })(),
    roc9: r2(rocLast(symCloses, 9)),
    hv20: vola.hvPct,
    volume_ratio20: vol.ratio20
  };

  return {
    symbol,
    interval,
    model_version: ENGINE_VERSION,
    generated_at: new Date(now).toISOString(),
    data_source: "binance-futures",
    price,
    change24h: r2(change24h),
    high24h,
    low24h,
    quote_volume_24h: quoteVolume24h,
    market_regime: { label: regime.label, trend_market: regime.trendMarket, vol_state: regime.volState, adx: regime.adx, atr_pct: regime.atrPct, bb_width_pct: regime.bbWidthPct },
    direction,
    signal_strength: signalStrength,
    confidence,
    risk_score: riskScore,
    risk_level: riskLevel,
    timeframes,
    tf_conflict: conflict,
    structure: { label: structure.label, hh: structure.hh, hl: structure.hl, lh: structure.lh, ll: structure.ll, last_swing_high: structure.lastHigh ? r2(structure.lastHigh.price) : null, last_swing_low: structure.lastLow ? r2(structure.lastLow.price) : null },
    support_zones: zones.supports.map((z) => ({ lo: r2(z.lo), hi: r2(z.hi), touches: z.touches })),
    resistance_zones: zones.resistances.map((z) => ({ lo: r2(z.lo), hi: r2(z.hi), touches: z.touches })),
    volume: vol,
    volatility: vola,
    anomaly,
    btc_context: { state: btc.state, corr: btc.corr, rel_strength: btc.relStrength },
    breadth,
    features,
    reasons: reasons.slice(0, 5),
    risks: risks.slice(0, 4),
    invalidation: invalidation.slice(0, 3),
    limited_data: limitedData,
    forming_candle: { count: main.forming.length, note: main.forming.length ? "当前K线尚未收盘,未参与本次判断" : "" }
  };
}

// ---- 编排:取数 + 分析(服务端全部计算,手机端只做展示) ----
async function analyzeSymbol(symbol, interval) {
  const isBtc = symbol === "BTCUSDT";
  const tfs = [...new Set([...TF_LIST, interval])];
  const btcTfs = isBtc ? [] : [...new Set(["15m", "1h", "4h", interval])];
  const specs = [];
  for (const tf of tfs) specs.push({ key: "sym", tf });
  for (const tf of btcTfs) specs.push({ key: "btc", tf });
  const [tickers, ...datasets] = await Promise.all([
    getTickers("futures").catch(() => []),
    ...specs.map((s) => getKlines("futures", s.key === "sym" ? symbol : "BTCUSDT", s.tf, 220).catch(() => []))
  ]);
  const tfRows = {}, btcRows = {};
  specs.forEach((s, i) => {
    if (s.key === "sym") tfRows[s.tf] = datasets[i];
    else btcRows[s.tf] = datasets[i];
  });
  if (isBtc) for (const tf of TF_LIST) btcRows[tf] = tfRows[tf];
  if (!tfRows[interval] || !tfRows[interval].length) throw new Error(symbol + " " + interval + " 行情数据不足");
  const ticker = (tickers || []).find((t) => t.symbol === symbol);
  return computeAnalysis({ symbol, interval, ticker: ticker || {}, tfRows, btcRows, tickers: tickers || [] });
}

async function handleAnalyze(url) {
  const symbol = cleanSymbol(url.searchParams.get("symbol"));
  const interval = cleanInterval(url.searchParams.get("interval"));
  try {
    const result = await analyzeSymbol(symbol, interval);
    return Response.json(result, { headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } });
  } catch (error) {
    return Response.json({ error: error && error.message ? error.message : "分析失败" }, { status: 502 });
  }
}

// ---- AI Market Radar 第二/三层:轻量筛选(单请求最多20个,客户端分批) ----
async function screenSymbol(symbol, interval, tickers) {
  const refTf = interval === "4h" ? "1h" : "4h";
  const [mainAll, refAll] = await Promise.all([
    getKlines("futures", symbol, interval, 220),
    getKlines("futures", symbol, refTf, 220)
  ]);
  const main = splitClosed(mainAll).closed;
  const ref = splitClosed(refAll).closed;
  const t = (tickers || []).find((x) => x.symbol === symbol) || {};
  if (main.length < 60) {
    return { symbol, price: main.length ? main[main.length - 1].close : Number(t.lastPrice || 0), change24h: r2(Number(t.priceChangePercent || 0)), quote_volume: Number(t.quoteVolume || 0), limited: true, direction: "Neutral", signal_strength: 50, confidence: 30, risk_level: "Medium", market_regime: "Limited Data", volume_spike: false, volatility: "Normal", alignment: "数据不足", anomaly: false };
  }
  const v = tfEvaluate(main);
  const rv = tfEvaluate(ref);
  const vol = volumeAnalysis(main);
  const vola = volatilityAnalysis(main);
  const regime = regimeLite(main);
  const anomaly = anomalyDetect(main, vol);
  const wscore = (v.score * 1.3 + rv.score * 0.7) / 2;
  const direction = wscore >= 0.85 ? "Strong Bullish" : wscore >= 0.35 ? "Bullish" : wscore <= -0.85 ? "Strong Bearish" : wscore <= -0.35 ? "Bearish" : "Neutral";
  const sameDir = Math.sign(v.score) === Math.sign(rv.score) && v.score !== 0;
  let confidence = 46 + Math.abs(wscore) * 20 + (sameDir ? 6 : 0) - (anomaly.detected ? 10 : 0) - (vola.level === "High" || vola.level === "Extreme" ? 6 : 0) - (vol.pattern === "缩量上涨" || vol.pattern === "缩量下跌" ? 4 : 0);
  confidence = Math.round(Math.max(8, Math.min(90, confidence)));
  let riskScore = 26 + Math.min(30, (vola.atrPct || 0) * 2.2) + (anomaly.detected ? 12 : 0) + (vola.level === "High" || vola.level === "Extreme" ? 8 : 0);
  riskScore = Math.round(Math.max(0, Math.min(100, riskScore)));
  return {
    symbol,
    price: main[main.length - 1].close,
    change24h: r2(Number(t.priceChangePercent || 0)),
    quote_volume: Number(t.quoteVolume || 0),
    market_regime: regime.label,
    direction,
    signal_strength: Math.max(0, Math.min(100, Math.round(50 + wscore * 28))),
    confidence,
    risk_score: riskScore,
    risk_level: riskScore < 30 ? "Low" : riskScore < 55 ? "Medium" : riskScore < 75 ? "High" : "Extreme",
    volume_spike: vol.spike,
    volatility: vola.level,
    alignment: sameDir ? "同向" : "分化",
    anomaly: anomaly.detected
  };
}

async function handleScreen(url) {
  const interval = cleanInterval(url.searchParams.get("interval"));
  const symbols = [...new Set((url.searchParams.get("symbols") || "").split(",").map((s) => cleanSymbol(s)).filter(Boolean))].slice(0, 20);
  if (!symbols.length) return Response.json({ error: "缺少 symbols 参数" }, { status: 400 });
  const tickers = await getTickers("futures").catch(() => []);
  let results = await Promise.all(symbols.map((symbol) => screenSymbol(symbol, interval, tickers).catch(() => null)));
  for (let i = 0; i < results.length; i += 1) {
    if (!results[i]) {
      try {
        await delaySrv(350);
        results[i] = await screenSymbol(symbols[i], interval, tickers);
      } catch (error) {
        results[i] = null;
      }
    }
  }
  results = results.map((r, i) => r || { symbol: symbols[i], failed: true });
  return Response.json({ interval, results }, { headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/analyze") return handleAnalyze(url);
    if (url.pathname === "/api/screen") return handleScreen(url);
    if (url.pathname.startsWith("/api/")) return proxyBinance(url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(page, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store"
        }
      });
    }
    return new Response("Not found", { status: 404 });
  }
};

export { computeAnalysis, ENGINE_VERSION };
