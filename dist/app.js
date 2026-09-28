const API = {
  futures: {
    ticker: "https://fapi.binance.com/fapi/v1/ticker/24hr",
    tickerSymbol: (symbol) => `https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symbol}`,
    klines: (symbol, interval) =>
      `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=120`,
  },
  spot: {
    ticker: "https://api.binance.com/api/v3/ticker/24hr",
    tickerSymbol: (symbol) => `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`,
    klines: (symbol, interval) =>
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=120`,
  },
};

const state = {
  coins: [],
  filter: "all",
  focusSymbol: "BTCUSDT",
  focusTimer: null,
  trades: JSON.parse(localStorage.getItem("paperTrades") || "[]"),
};

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 });

function sma(values, length) {
  if (values.length < length) return null;
  return values.slice(-length).reduce((a, b) => a + b, 0) / length;
}

function ema(values, length) {
  if (values.length < length) return null;
  const k = 2 / (length + 1);
  let current = sma(values.slice(0, length), length);
  for (let i = length; i < values.length; i += 1) {
    current = values[i] * k + current * (1 - k);
  }
  return current;
}

function rsi(values, length = 14) {
  if (values.length <= length) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - length; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function stdev(values) {
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function analyze(symbol, ticker, klines) {
  const closes = klines.map((k) => Number(k[4]));
  const volumes = klines.map((k) => Number(k[5]));
  const last = closes.at(-1);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema55 = ema(closes, 55);
  const rsi14 = rsi(closes, 14);
  const macdFast = ema(closes, 12);
  const macdSlow = ema(closes, 26);
  const macd = macdFast && macdSlow ? macdFast - macdSlow : 0;
  const volNow = sma(volumes, 5) || 0;
  const volBase = sma(volumes, 30) || volNow || 1;
  const volBoost = volNow / volBase;
  const recent = closes.slice(-20);
  const volatility = (stdev(recent) / last) * 100;

  let longScore = 50;
  let shortScore = 50;
  const reasons = [];

  if (ema9 > ema21 && ema21 > ema55) {
    longScore += 20;
    shortScore -= 12;
    reasons.push("均线上行排列");
  }
  if (ema9 < ema21 && ema21 < ema55) {
    shortScore += 20;
    longScore -= 12;
    reasons.push("均线下行排列");
  }
  if (macd > 0) longScore += 10;
  if (macd < 0) shortScore += 10;
  if (rsi14 >= 52 && rsi14 <= 68) longScore += 12;
  if (rsi14 <= 48 && rsi14 >= 32) shortScore += 12;
  if (rsi14 > 74) {
    longScore -= 14;
    reasons.push("RSI 偏热，追高风险增加");
  }
  if (rsi14 < 26) {
    shortScore -= 14;
    reasons.push("RSI 偏冷，追空风险增加");
  }
  if (volBoost > 1.25) {
    longScore += 6;
    shortScore += 6;
    reasons.push("成交量放大");
  }
  if (volatility > 4.8) {
    longScore -= 8;
    shortScore -= 8;
    reasons.push("波动较高");
  }

  longScore = Math.max(0, Math.min(100, Math.round(longScore)));
  shortScore = Math.max(0, Math.min(100, Math.round(shortScore)));
  const bias =
    Math.abs(longScore - shortScore) < 8 ? "neutral" : longScore > shortScore ? "long" : "short";
  const risk = volatility > 6 || Math.abs(Number(ticker.priceChangePercent)) > 18 ? "high" : "normal";

  return {
    symbol,
    price: Number(ticker.lastPrice),
    change: Number(ticker.priceChangePercent),
    longScore,
    shortScore,
    rsi: rsi14 || 0,
    volatility,
    bias,
    risk,
    reason: reasons.slice(0, 3).join("、") || "趋势信号不强，适合继续观察",
  };
}

function explainAnalysis(coin) {
  const strongerScore = Math.max(coin.longScore, coin.shortScore);
  const gap = Math.abs(coin.longScore - coin.shortScore);
  const direction = coin.bias === "long" ? "上涨趋势" : coin.bias === "short" ? "下跌趋势" : "震荡观望";
  const confidence = coin.bias === "neutral" ? Math.min(62, strongerScore) : Math.min(96, strongerScore + Math.floor(gap / 3));
  const clearOpportunity = coin.bias !== "neutral" && strongerScore >= 78 && gap >= 16 && coin.volatility <= 6.5;
  const heatWarning = coin.rsi > 74 || coin.rsi < 26 || coin.volatility > 6.5;

  let opportunity = "暂无明显观察机会，等待趋势和量能进一步确认。";
  if (clearOpportunity) {
    opportunity = `${direction}信号较集中：分数差 ${gap}，但仍需设置失效价并控制仓位风险。`;
  } else if (heatWarning) {
    opportunity = "波动或 RSI 过热/过冷，容易出现假突破，适合降低预期。";
  }

  return {
    direction,
    confidence,
    clearOpportunity,
    opportunity,
    narrative: `${coin.reason}。当前上行分 ${coin.longScore}，下行分 ${coin.shortScore}，RSI ${coin.rsi.toFixed(
      1
    )}，近 20 根 K 线波动率 ${coin.volatility.toFixed(2)}%。`,
  };
}

function normalizeKlines(klines) {
  return klines.map((k) => ({
    openTime: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

function drawKlineChart(rawKlines) {
  const canvas = $("klineChart");
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const width = wrap.clientWidth;
  const height = Math.max(280, wrap.clientHeight);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#071114";
  ctx.fillRect(0, 0, width, height);

  const klines = normalizeKlines(rawKlines).slice(-70);
  if (!klines.length) return;

  const pad = { top: 18, right: 54, bottom: 32, left: 10 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;
  const highs = klines.map((k) => k.high);
  const lows = klines.map((k) => k.low);
  const max = Math.max(...highs);
  const min = Math.min(...lows);
  const range = max - min || 1;
  const step = chartW / klines.length;
  const candleW = Math.max(3, Math.min(10, step * 0.62));
  const y = (price) => pad.top + ((max - price) / range) * chartH;

  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const yy = pad.top + (chartH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, yy);
    ctx.lineTo(width - pad.right + 8, yy);
    ctx.stroke();
    const price = max - (range / 4) * i;
    ctx.fillStyle = "rgba(236,244,241,0.58)";
    ctx.font = "11px system-ui";
    ctx.fillText(fmt.format(price), width - pad.right + 12, yy + 4);
  }

  klines.forEach((k, index) => {
    const x = pad.left + step * index + step / 2;
    const up = k.close >= k.open;
    const color = up ? "#35d07f" : "#ff5d69";
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y(k.high));
    ctx.lineTo(x, y(k.low));
    ctx.stroke();
    const bodyTop = y(Math.max(k.open, k.close));
    const bodyBottom = y(Math.min(k.open, k.close));
    ctx.fillRect(x - candleW / 2, bodyTop, candleW, Math.max(2, bodyBottom - bodyTop));
  });

  const closes = klines.map((k) => k.close);
  drawMa(ctx, klines, closes, 9, "#55c7e8", pad, chartW, step, y);
  drawMa(ctx, klines, closes, 21, "#f0ba4f", pad, chartW, step, y);
}

function drawMa(ctx, klines, closes, length, color, pad, chartW, step, y) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  let started = false;
  closes.forEach((_, index) => {
    if (index + 1 < length) return;
    const avg = closes.slice(index + 1 - length, index + 1).reduce((a, b) => a + b, 0) / length;
    const x = pad.left + step * index + step / 2;
    const yy = y(avg);
    if (!started) {
      ctx.moveTo(x, yy);
      started = true;
    } else {
      ctx.lineTo(x, yy);
    }
  });
  ctx.stroke();
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`请求失败 ${res.status}`);
  return res.json();
}

async function scanMarket() {
  const market = $("marketSelect").value;
  const interval = $("intervalSelect").value;
  const limit = Number($("limitSelect").value);
  $("statusBox").textContent = "正在读取 24h 行情并计算指标...";
  $("refreshBtn").disabled = true;

  try {
    const tickers = await fetchJson(API[market].ticker);
    const candidates = tickers
      .filter((t) => t.symbol.endsWith("USDT") && !t.symbol.includes("_"))
      .filter((t) => Number(t.quoteVolume) > 2_000_000)
      .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
      .slice(0, limit);

    const analyzed = await Promise.all(
      candidates.map(async (ticker) => {
        const klines = await fetchJson(API[market].klines(ticker.symbol, interval));
        return analyze(ticker.symbol, ticker, klines);
      })
    );

    state.coins = analyzed.sort(
      (a, b) => Math.max(b.longScore, b.shortScore) - Math.max(a.longScore, a.shortScore)
    );
    render();
    $("statusBox").textContent = `已扫描 ${state.coins.length} 个交易对，数据来自币安公开行情。`;
  } catch (error) {
    $("statusBox").textContent = `扫描失败：${error.message}。如果你所在网络无法访问币安，请换网络或稍后再试。`;
  } finally {
    $("refreshBtn").disabled = false;
  }
}

async function analyzeFocusSymbol() {
  const market = $("marketSelect").value;
  const interval = $("intervalSelect").value;
  const symbol = state.focusSymbol;
  $("focusStatus").textContent = "更新中...";

  try {
    const [ticker, klines] = await Promise.all([
      fetchJson(API[market].tickerSymbol(symbol)),
      fetchJson(API[market].klines(symbol, interval)),
    ]);
    const coin = analyze(symbol, ticker, klines);
    const ai = explainAnalysis(coin);

    drawKlineChart(klines);
    $("focusPrice").textContent = fmt.format(coin.price);
    const change = $("focusChange");
    change.textContent = `${coin.change >= 0 ? "+" : ""}${coin.change.toFixed(2)}%`;
    change.className = `change ${coin.change >= 0 ? "positive" : "negative"}`;
    $("aiTrend").textContent = ai.direction;
    $("aiConfidence").textContent = `${ai.confidence}%`;
    $("aiNarrative").textContent = ai.narrative;
    $("opportunityBox").textContent = ai.opportunity;
    $("opportunityBox").classList.toggle("active", ai.clearOpportunity);
    $("aiCard").classList.toggle("alert", ai.clearOpportunity);
    $("focusRsi").textContent = coin.rsi.toFixed(1);
    $("focusVolatility").textContent = `${coin.volatility.toFixed(2)}%`;
    $("focusLong").textContent = coin.longScore;
    $("focusShort").textContent = coin.shortScore;
    $("focusStatus").textContent = `已更新 ${new Date().toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })}`;
  } catch (error) {
    $("focusStatus").textContent = "更新失败";
    $("aiNarrative").textContent = `无法读取 ${symbol}：${error.message}。请检查交易对名称或网络访问。`;
  }
}

function render() {
  const list = $("coinList");
  const template = $("coinTemplate");
  const filtered = state.coins.filter((coin) => {
    if (state.filter === "all") return true;
    if (state.filter === "risk") return coin.risk === "high";
    return coin.bias === state.filter;
  });

  $("longCount").textContent = state.coins.filter((c) => c.bias === "long").length;
  $("shortCount").textContent = state.coins.filter((c) => c.bias === "short").length;
  const avgChange = state.coins.reduce((sum, c) => sum + c.change, 0) / (state.coins.length || 1);
  $("marketMood").textContent = avgChange > 1 ? "偏强" : avgChange < -1 ? "偏弱" : "震荡";

  list.replaceChildren();
  filtered.forEach((coin) => {
    const node = template.content.cloneNode(true);
    node.querySelector(".symbol").textContent = coin.symbol;
    node.querySelector(".reason").textContent = coin.reason;
    node.querySelector(".price").textContent = fmt.format(coin.price);
    const change = node.querySelector(".change");
    change.textContent = `${coin.change >= 0 ? "+" : ""}${coin.change.toFixed(2)}%`;
    change.classList.add(coin.change >= 0 ? "positive" : "negative");
    const badge = node.querySelector(".badge");
    badge.textContent = coin.bias === "long" ? "上行" : coin.bias === "short" ? "下行" : "观望";
    badge.classList.add(coin.bias);
    node.querySelector(".score-bar span").style.width = `${Math.max(coin.longScore, coin.shortScore)}%`;
    node.querySelector(".long-score").textContent = coin.longScore;
    node.querySelector(".short-score").textContent = coin.shortScore;
    node.querySelector(".rsi").textContent = coin.rsi.toFixed(1);
    node.querySelector(".volatility").textContent = `${coin.volatility.toFixed(2)}%`;
    node.querySelector(".quick-trade").addEventListener("click", () => {
      $("tradeSymbol").value = coin.symbol;
      $("tradeSide").value = coin.bias === "short" ? "short" : "long";
      $("tradeEntry").value = coin.price;
      $("tradeStop").focus();
    });
    list.appendChild(node);
  });

  renderTrades();
}

function renderTrades() {
  const box = $("tradeList");
  box.replaceChildren();
  if (!state.trades.length) {
    box.textContent = "还没有模拟记录。";
    return;
  }
  state.trades.forEach((trade) => {
    const item = document.createElement("div");
    item.className = "trade-item";
    const risk = Math.abs(((trade.entry - trade.stop) / trade.entry) * 100);
    item.innerHTML = `<strong>${trade.symbol} ${trade.side === "long" ? "观察上行" : "观察下行"}</strong><span>区间 ${risk.toFixed(
      2
    )}%</span><small>观察价 ${fmt.format(trade.entry)} / 失效价 ${fmt.format(trade.stop)}</small>`;
    box.appendChild(item);
  });
}

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    button.classList.add("active");
    state.filter = button.dataset.filter;
    render();
  });
});

$("refreshBtn").addEventListener("click", scanMarket);
$("marketSelect").addEventListener("change", () => {
  scanMarket();
  analyzeFocusSymbol();
});
$("intervalSelect").addEventListener("change", () => {
  scanMarket();
  analyzeFocusSymbol();
});
$("limitSelect").addEventListener("change", scanMarket);
$("symbolSelect").addEventListener("change", (event) => {
  state.focusSymbol = event.target.value;
  $("customSymbol").value = "";
  analyzeFocusSymbol();
});
$("customSymbol").addEventListener("change", (event) => {
  const symbol = event.target.value.trim().toUpperCase().replace("/", "");
  if (!symbol) return;
  state.focusSymbol = symbol.endsWith("USDT") ? symbol : `${symbol}USDT`;
  $("symbolSelect").value = "";
  analyzeFocusSymbol();
});
window.addEventListener("resize", () => analyzeFocusSymbol());

$("tradeForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const trade = {
    symbol: $("tradeSymbol").value.trim().toUpperCase(),
    side: $("tradeSide").value,
    entry: Number($("tradeEntry").value),
    stop: Number($("tradeStop").value),
    createdAt: Date.now(),
  };
  if (!trade.symbol || !trade.entry || !trade.stop) return;
  state.trades.unshift(trade);
  localStorage.setItem("paperTrades", JSON.stringify(state.trades));
  event.target.reset();
  renderTrades();
});

$("clearTradesBtn").addEventListener("click", () => {
  state.trades = [];
  localStorage.removeItem("paperTrades");
  renderTrades();
});

scanMarket();
analyzeFocusSymbol();
state.focusTimer = window.setInterval(analyzeFocusSymbol, 30000);
