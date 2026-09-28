const page = String.raw`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="theme-color" content="#000000">
    <title>量化监控</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #000;
        --panel: #101010;
        --panel-2: #181818;
        --line: #262626;
        --text: #f4f4f4;
        --muted: #8b8b8b;
        --green: #00c076;
        --red: #f6465d;
        --gray: #9ca3af;
      }
      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: 15px;
      }
      button, select, input { font: inherit; }
      button { cursor: pointer; }
      .app {
        width: min(760px, 100%);
        min-height: 100vh;
        margin: 0 auto;
        padding: 12px 12px calc(84px + env(safe-area-inset-bottom));
      }
      .page { display: none; }
      .page.active { display: block; }
      .top-row, .controls-row, .market-row, .watch-row, .setting-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .top-row { margin-bottom: 12px; }
      h1, h2, p { margin: 0; }
      h1 { font-size: 22px; font-weight: 800; }
      h2 { font-size: 16px; font-weight: 800; }
      .muted { color: var(--muted); }
      .card {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
        padding: 12px;
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
      .periods {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 8px;
        margin: 12px 0;
      }
      .period-btn, .primary-btn, .icon-btn, .add-btn {
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--panel-2);
        color: var(--text);
        min-height: 40px;
      }
      .period-btn.active { border-color: var(--text); background: #242424; }
      .chart-card {
        height: 330px;
        padding: 0;
        overflow: hidden;
      }
      canvas { display: block; width: 100%; height: 100%; }
      .price-card {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
        margin-top: 12px;
      }
      .price-main { grid-column: 1 / -1; }
      .label { display: block; color: var(--muted); font-size: 12px; margin-bottom: 5px; }
      .price { font-size: 30px; font-weight: 850; letter-spacing: 0; }
      .value { font-size: 18px; font-weight: 750; }
      .green { color: var(--green); }
      .red { color: var(--red); }
      .gray { color: var(--gray); }
      .analysis-card { margin-top: 12px; }
      .signal {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 8px;
      }
      .signal strong { font-size: 34px; }
      .signal span { color: var(--muted); font-size: 13px; }
      .analysis-text { color: #cfcfcf; line-height: 1.55; }
      .primary-btn {
        width: 100%;
        margin-top: 12px;
        height: 48px;
        background: #f4f4f4;
        color: #000;
        font-weight: 800;
      }
      .section-title { margin: 2px 0 12px; }
      .list {
        display: grid;
        gap: 8px;
      }
      .market-row, .watch-row, .setting-row {
        min-height: 62px;
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
        background: #222;
      }
      .pill.green { background: rgba(0, 192, 118, .12); }
      .pill.red { background: rgba(246, 70, 93, .12); }
      .pill.gray { background: rgba(156, 163, 175, .12); }
      .scan-controls, .watch-controls {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
        margin-bottom: 12px;
      }
      .setting-list {
        display: grid;
        gap: 8px;
      }
      .setting-row select, .setting-row input { width: 150px; }
      .switch {
        position: relative;
        width: 50px;
        height: 28px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: #222;
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
        margin: 10px 0;
        min-height: 18px;
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
        background: #050505;
        padding: 7px 8px calc(7px + env(safe-area-inset-bottom));
      }
      .nav-btn {
        display: grid;
        gap: 3px;
        place-items: center;
        min-height: 48px;
        border: 0;
        background: transparent;
        color: var(--muted);
      }
      .nav-btn.active { color: var(--text); }
      .nav-icon { font-size: 18px; line-height: 1; }
      .nav-text { font-size: 12px; }
      @media (max-width: 430px) {
        .app { padding-left: 10px; padding-right: 10px; }
        .chart-card { height: 300px; }
        .price { font-size: 28px; }
        .signal strong { font-size: 31px; }
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
        <div class="periods" id="monitorPeriods"></div>
        <div class="card chart-card"><canvas id="chart"></canvas></div>
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
        </div>
        <div class="card analysis-card">
          <div class="signal">
            <strong id="signal">--</strong>
            <span id="confidence">--</span>
          </div>
          <p id="reason" class="analysis-text">点击开始分析，系统会读取最新K线并给出趋势判断。</p>
        </div>
        <button id="analyzeBtn" class="primary-btn" type="button">开始分析</button>
        <p id="monitorStatus" class="status"></p>
      </section>

      <section id="page-scan" class="page">
        <div class="top-row">
          <h1>扫描</h1>
          <select id="scanPeriod" class="select-wide">
            <option value="15m">15分钟</option>
            <option value="30m">30分钟</option>
            <option value="1h" selected>1小时</option>
            <option value="4h">4小时</option>
          </select>
        </div>
        <p id="scanStatus" class="status">点击扫描，批量分析成交额靠前的交易对。</p>
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
              <option value="10">10</option>
              <option value="20" selected>20</option>
              <option value="30">30</option>
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
              <div class="coin-name">提醒开关</div>
              <div class="coin-sub">明显看涨/看跌时高亮</div>
            </div>
            <button id="notifySwitch" class="switch on" type="button" aria-label="提醒开关"></button>
          </div>
        </div>
      </section>
    </main>

    <nav class="bottom-nav">
      <button class="nav-btn active" data-page="monitor" type="button"><span class="nav-icon">⌁</span><span class="nav-text">监控</span></button>
      <button class="nav-btn" data-page="scan" type="button"><span class="nav-icon">≋</span><span class="nav-text">扫描</span></button>
      <button class="nav-btn" data-page="watch" type="button"><span class="nav-icon">☆</span><span class="nav-text">自选</span></button>
      <button class="nav-btn" data-page="settings" type="button"><span class="nav-icon">⚙</span><span class="nav-text">我的</span></button>
    </nav>

    <script>
      const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT"];
      const periods = [
        ["15m", "15分钟"],
        ["30m", "30分钟"],
        ["1h", "1小时"],
        ["4h", "4小时"]
      ];
      const settings = JSON.parse(localStorage.getItem("quantSettings") || "{}");
      const state = {
        symbol: settings.defaultSymbol || "BTCUSDT",
        interval: settings.interval || "1h",
        scanLimit: settings.scanLimit || "20",
        refreshInterval: settings.refreshInterval || "30",
        notify: settings.notify !== false,
        watch: JSON.parse(localStorage.getItem("watchSymbols") || '["BTCUSDT","ETHUSDT"]'),
        timer: null
      };
      const $ = (id) => document.getElementById(id);
      const fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 });

      function saveSettings() {
        localStorage.setItem("quantSettings", JSON.stringify({
          defaultSymbol: state.symbol,
          interval: state.interval,
          scanLimit: state.scanLimit,
          refreshInterval: state.refreshInterval,
          notify: state.notify
        }));
      }

      function api(path) {
        const joiner = path.includes("?") ? "&" : "?";
        return fetch("/api/" + path + joiner + "_=" + Date.now()).then((res) => {
          if (!res.ok) throw new Error("行情读取失败");
          return res.json();
        });
      }

      function pctClass(value) {
        return value > 0 ? "green" : value < 0 ? "red" : "gray";
      }

      function signalClass(signal) {
        if (signal === "看涨") return "green";
        if (signal === "看跌") return "red";
        return "gray";
      }

      function sma(values, length) {
        if (values.length < length) return null;
        return values.slice(-length).reduce((a, b) => a + b, 0) / length;
      }

      function ema(values, length) {
        if (values.length < length) return null;
        const k = 2 / (length + 1);
        let current = sma(values.slice(0, length), length);
        for (let i = length; i < values.length; i += 1) current = values[i] * k + current * (1 - k);
        return current;
      }

      function rsi(values, length) {
        if (values.length <= length) return 50;
        let gains = 0, losses = 0;
        for (let i = values.length - length; i < values.length; i += 1) {
          const diff = values[i] - values[i - 1];
          if (diff >= 0) gains += diff; else losses -= diff;
        }
        if (losses === 0) return 100;
        return 100 - 100 / (1 + gains / losses);
      }

      function stdev(values) {
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        return Math.sqrt(values.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / values.length);
      }

      function analyzeKlines(symbol, ticker, klines) {
        const closes = klines.map((k) => Number(k[4]));
        const volumes = klines.map((k) => Number(k[5]));
        const last = closes[closes.length - 1];
        const ema9 = ema(closes, 9);
        const ema21 = ema(closes, 21);
        const ema55 = ema(closes, 55);
        const rsi14 = rsi(closes, 14);
        const macdFast = ema(closes, 12);
        const macdSlow = ema(closes, 26);
        const macd = macdFast && macdSlow ? macdFast - macdSlow : 0;
        const volNow = sma(volumes, 5) || 0;
        const volBase = sma(volumes, 30) || volNow || 1;
        const volatility = stdev(closes.slice(-20)) / last * 100;
        let up = 50, down = 50;
        if (ema9 > ema21 && ema21 > ema55) up += 24;
        if (ema9 < ema21 && ema21 < ema55) down += 24;
        if (macd > 0) up += 10; else down += 10;
        if (rsi14 >= 52 && rsi14 <= 68) up += 10;
        if (rsi14 <= 48 && rsi14 >= 32) down += 10;
        if (volNow / volBase > 1.25) { up += 5; down += 5; }
        if (volatility > 6) { up -= 8; down -= 8; }
        up = Math.max(0, Math.min(100, Math.round(up)));
        down = Math.max(0, Math.min(100, Math.round(down)));
        const gap = Math.abs(up - down);
        let signal = "震荡";
        if (gap >= 8) signal = up > down ? "看涨" : "看跌";
        const confidence = signal === "震荡" ? Math.max(45, 100 - gap * 2) : Math.min(96, Math.max(up, down));
        const reason = buildReason(signal, ema9, ema21, ema55, rsi14, volatility, volNow / volBase);
        return {
          symbol,
          price: Number(ticker.lastPrice || last),
          change: Number(ticker.priceChangePercent || 0),
          high: Number(ticker.highPrice || Math.max(...closes)),
          low: Number(ticker.lowPrice || Math.min(...closes)),
          signal,
          confidence,
          reason
        };
      }

      function buildReason(signal, ema9, ema21, ema55, rsi14, volatility, volumeRate) {
        if (signal === "看涨") {
          return "短期均线强于中长期均线，动能偏强。若成交量继续放大，趋势延续概率更高。";
        }
        if (signal === "看跌") {
          return "短期均线弱于中长期均线，动能偏弱。若反弹无量，仍偏向下行。";
        }
        if (rsi14 > 72 || rsi14 < 28 || volatility > 6) {
          return "当前波动较大或RSI处在极端区域，容易出现假突破，先观察更稳。";
        }
        if (volumeRate < 0.85) return "量能不足，价格方向不够明确，暂时以震荡看待。";
        return "多空分数接近，趋势没有明显优势，等待价格突破关键区间。";
      }

      function drawChart(klines) {
        const canvas = $("chart");
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
        ctx.fillStyle = "#101010";
        ctx.fillRect(0, 0, width, height);
        const data = klines.slice(-70).map((k) => ({
          open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4])
        }));
        const max = Math.max(...data.map((k) => k.high));
        const min = Math.min(...data.map((k) => k.low));
        const pad = { top: 14, right: 50, bottom: 24, left: 8 };
        const chartW = width - pad.left - pad.right;
        const chartH = height - pad.top - pad.bottom;
        const range = max - min || 1;
        const y = (price) => pad.top + (max - price) / range * chartH;
        const step = chartW / data.length;
        ctx.strokeStyle = "#252525";
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
          const yy = pad.top + chartH / 4 * i;
          ctx.beginPath();
          ctx.moveTo(pad.left, yy);
          ctx.lineTo(width - pad.right + 8, yy);
          ctx.stroke();
          ctx.fillStyle = "#8b8b8b";
          ctx.font = "11px sans-serif";
          ctx.fillText(fmt.format(max - range / 4 * i), width - pad.right + 12, yy + 4);
        }
        data.forEach((k, i) => {
          const x = pad.left + step * i + step / 2;
          const up = k.close >= k.open;
          const color = up ? "#00c076" : "#f6465d";
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
      }

      async function analyzeCurrent() {
        $("monitorStatus").textContent = "正在读取行情...";
        try {
          const [ticker, klines] = await Promise.all([
            api("ticker?market=futures&symbol=" + state.symbol),
            api("klines?market=futures&symbol=" + state.symbol + "&interval=" + state.interval + "&limit=120")
          ]);
          const result = analyzeKlines(state.symbol, ticker, klines);
          drawChart(klines);
          $("price").textContent = fmt.format(result.price);
          $("change").textContent = (result.change >= 0 ? "+" : "") + result.change.toFixed(2) + "%";
          $("change").className = "value " + pctClass(result.change);
          $("highLow").textContent = fmt.format(result.high) + " / " + fmt.format(result.low);
          $("signal").textContent = result.signal;
          $("signal").className = signalClass(result.signal);
          $("confidence").textContent = "置信度 " + result.confidence + "%";
          $("reason").textContent = result.reason;
          $("monitorStatus").textContent = "已更新 " + new Date().toLocaleTimeString("zh-CN");
        } catch (error) {
          $("monitorStatus").textContent = "行情读取失败，稍后再试。";
        }
      }

      async function scanMarket() {
        $("scanStatus").textContent = "正在扫描...";
        $("scanList").replaceChildren();
        try {
          const tickers = await api("tickers?market=futures");
          const candidates = tickers
            .filter((t) => t.symbol.endsWith("USDT") && !t.symbol.includes("_"))
            .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
            .slice(0, Number(state.scanLimit));
          const rows = await Promise.all(candidates.map(async (ticker) => {
            const klines = await api("klines?market=futures&symbol=" + ticker.symbol + "&interval=" + $("scanPeriod").value + "&limit=120");
            return analyzeKlines(ticker.symbol, ticker, klines);
          }));
          rows.forEach(addScanRow);
          $("scanStatus").textContent = "已扫描 " + rows.length + " 个交易对";
        } catch (error) {
          $("scanStatus").textContent = "扫描失败，稍后再试。";
        }
      }

      function addScanRow(item) {
        const row = document.createElement("div");
        row.className = "card market-row";
        row.innerHTML = '<div><div class="coin-name">' + item.symbol.replace("USDT", "/USDT") + '</div><div class="coin-sub">' + fmt.format(item.price) + '</div></div><div class="right"><div class="' + pctClass(item.change) + '">' + (item.change >= 0 ? "+" : "") + item.change.toFixed(2) + '%</div><span class="pill ' + signalClass(item.signal) + '">' + item.signal + '</span></div>';
        $("scanList").appendChild(row);
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
        for (const symbol of state.watch) {
          const row = document.createElement("div");
          row.className = "card watch-row";
          row.innerHTML = '<div><div class="coin-name">' + symbol.replace("USDT", "/USDT") + '</div><div class="coin-sub">读取中</div></div><span class="pill gray">--</span>';
          $("watchList").appendChild(row);
          try {
            const [ticker, klines] = await Promise.all([
              api("ticker?market=futures&symbol=" + symbol),
              api("klines?market=futures&symbol=" + symbol + "&interval=" + state.interval + "&limit=120")
            ]);
            const result = analyzeKlines(symbol, ticker, klines);
            row.innerHTML = '<div><div class="coin-name">' + symbol.replace("USDT", "/USDT") + '</div><div class="coin-sub">' + fmt.format(result.price) + '</div></div><span class="pill ' + signalClass(result.signal) + '">' + result.signal + '</span>';
          } catch (error) {
            row.querySelector(".coin-sub").textContent = "读取失败";
          }
        }
      }

      function setup() {
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
        $("scanLimit").value = state.scanLimit;
        $("refreshInterval").value = state.refreshInterval;
        $("scanLimit").addEventListener("change", (event) => { state.scanLimit = event.target.value; saveSettings(); });
        $("refreshInterval").addEventListener("change", (event) => { state.refreshInterval = event.target.value; saveSettings(); startTimer(); });
        $("notifySwitch").classList.toggle("on", state.notify);
        $("notifySwitch").addEventListener("click", () => { state.notify = !state.notify; $("notifySwitch").classList.toggle("on", state.notify); saveSettings(); });
        $("analyzeBtn").addEventListener("click", analyzeCurrent);
        $("scanPeriod").addEventListener("change", scanMarket);
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
            document.querySelectorAll(".nav-btn").forEach((item) => item.classList.remove("active"));
            document.querySelectorAll(".page").forEach((item) => item.classList.remove("active"));
            btn.classList.add("active");
            $("page-" + btn.dataset.page).classList.add("active");
            if (btn.dataset.page === "scan" && !$("scanList").children.length) scanMarket();
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

function cleanInterval(value) {
  return ["15m", "30m", "1h", "4h"].includes(value) ? value : "1h";
}

function toOkxInstId(symbol) {
  return symbol.replace("USDT", "-USDT-SWAP");
}

function toOkxBar(interval) {
  return { "15m": "15m", "30m": "30m", "1h": "1H", "4h": "4H" }[interval] || "1H";
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
  return { "15m": "15", "30m": "30", "1h": "60", "4h": "240" }[interval] || "60";
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

export default {
  async fetch(request) {
    const url = new URL(request.url);
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
