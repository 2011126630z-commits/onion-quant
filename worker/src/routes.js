// routes.js · API 路由(analyze / screen)
// V13.2 行情链路修复:
//   - analyzeSymbol 允许部分数据降级:主周期必须成功,辅助周期/BTC参照失败仅标记 limited_data
//   - screenSymbol 服务端并发限制(4),失败带 error_type
//   - handleScreen 并发执行 + 每币只重试一次(单币失败不影响整批)

import { getKlines, getTickers } from "./engine/marketData.js";
import { computeAnalysis } from "./engine/signal.js";
import { splitClosed } from "./engine/candles.js";
import { tfEvaluate } from "./engine/timeframes.js";
import { volumeAnalysis, volatilityAnalysis, anomalyDetect } from "./engine/volume.js";
import { regimeLite } from "./engine/regime.js";
import { TF_LIST } from "./engine/constants.js";
import { r2, delaySrv } from "./engine/utils.js";
import { cleanSymbol, cleanInterval } from "./proxy.js";

const ANALYZE_KL_LIMIT = 220;
const SCREEN_CONCURRENCY = 4;

// 服务器侧小并发池
async function mapPool(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = [];
  const laneCount = Math.max(1, Math.min(limit, items.length));
  for (let lane = 0; lane < laneCount; lane += 1) {
    runners.push((async () => {
      while (cursor < items.length) {
        const idx = cursor;
        cursor += 1;
        out[idx] = await worker(items[idx], idx);
      }
    })());
  }
  await Promise.all(runners);
  return out;
}

async function analyzeSymbol(symbol, interval) {
  const isBtc = symbol === "BTCUSDT";
  const tfs = [...new Set([...TF_LIST, interval])];
  const btcTfs = isBtc ? [] : [...new Set(["15m", "1h", "4h", interval])];
  const specs = [];
  for (const tf of tfs) specs.push({ key: "sym", tf });
  for (const tf of btcTfs) specs.push({ key: "btc", tf });

  const [tickersRes, ...datasetRes] = await Promise.all([
    getTickers("futures").then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, error: e && e.message })),
    ...specs.map((s) => getKlines("futures", s.key === "sym" ? symbol : "BTCUSDT", s.tf, ANALYZE_KL_LIMIT)
      .then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, error: e && e.message ? e.message : String(e) })))
  ]);

  const tfRows = {}, btcRows = {};
  const failedTfs = [], failedBtcTfs = [];
  specs.forEach((s, i) => {
    const r = datasetRes[i];
    if (s.key === "sym") {
      if (r.ok && r.v.length) tfRows[s.tf] = r.v;
      else failedTfs.push(s.tf + (r.error ? "(" + r.error + ")" : ""));
    } else {
      if (r.ok && r.v.length) btcRows[s.tf] = r.v;
      else failedBtcTfs.push(s.tf);
    }
  });
  if (isBtc) for (const tf of TF_LIST) btcRows[tf] = tfRows[tf];
  // 主周期必须成功
  if (!tfRows[interval] || !tfRows[interval].length) {
    const reason = failedTfs.find((f) => f.indexOf(interval) === 0) || "全部上游失败";
    throw new Error(symbol + " " + interval + " 主周期K线获取失败: " + reason);
  }
  const tickers = tickersRes.ok ? tickersRes.v : [];
  const result = computeAnalysis({
    symbol, interval,
    ticker: (tickers || []).find((t) => t.symbol === symbol) || {},
    tfRows,
    btcRows,
    tickers: tickers || [],
    data_degraded: failedTfs.filter((f) => f.indexOf(interval) !== 0).length > 0
  });
  if (result) {
    result.data_degraded = failedTfs.filter((f) => f.indexOf(interval) !== 0).length > 0;
    result.degraded_note = result.data_degraded
      ? "部分辅助周期K线读取失败(" + failedTfs.filter((f) => f.indexOf(interval) !== 0).join(", ") + "),已用可用周期完成分析"
      : "";
    if (!tickersRes.ok) {
      result.breadth = null;
      result.degraded_note += (result.degraded_note ? "; " : "") + "全市场行情读取失败,市场广度暂缺";
    }
  }
  return result;
}

async function handleAnalyze(url) {
  const symbol = cleanSymbol(url.searchParams.get("symbol"));
  const interval = cleanInterval(url.searchParams.get("interval"));
  const t0 = Date.now();
  try {
    const result = await analyzeSymbol(symbol, interval);
    return Response.json(result, { headers: { "cache-control": "no-store", "access-control-allow-origin": "*", "x-latency-ms": String(Date.now() - t0) } });
  } catch (error) {
    return Response.json({ error: error && error.message ? error.message : "分析失败" }, { status: 502, headers: { "access-control-allow-origin": "*", "x-latency-ms": String(Date.now() - t0) } });
  }
}

// ---- AI Market Radar 第二/三层:轻量筛选 ----
async function screenSymbol(symbol, interval, tickers) {
  const refTf = interval === "4h" ? "1h" : "4h";
  const [mainRes, refRes] = await Promise.all([
    getKlines("futures", symbol, interval, 220).then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, error: e && e.message })),
    getKlines("futures", symbol, refTf, 220).then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, error: e && e.message }))
  ]);
  const mainAll = mainRes.ok ? mainRes.v : [];
  const refAll = refRes.ok ? refRes.v : [];
  // 主周期失败 → 明确失败(带类型);参考周期失败 → 用主周期单独评估(降级)
  if (!mainAll.length) {
    const err = { symbol, failed: true, error_type: "klines_failed" };
    if (mainRes.error && /timeout|aborted/i.test(mainRes.error)) err.error_type = "upstream_timeout";
    if (mainRes.error && /获取失败|数据为空/.test(mainRes.error)) err.error_type = "upstream_error";
    err.error = mainRes.error || "klines failed";
    return err;
  }
  const main = splitClosed(mainAll).closed;
  const ref = splitClosed(refAll).closed;
  const refOk = ref.length >= 30;
  const t = (tickers || []).find((x) => x.symbol === symbol) || {};
  if (main.length < 60) {
    return { symbol, price: main.length ? main[main.length - 1].close : Number(t.lastPrice || 0), change24h: r2(Number(t.priceChangePercent || 0)), quote_volume: Number(t.quoteVolume || 0), limited: true, direction: "Neutral", signal_strength: 50, confidence: 30, risk_level: "Medium", market_regime: "Limited Data", volume_spike: false, volatility: "Normal", alignment: "数据不足", anomaly: false };
  }
  const v = tfEvaluate(main);
  // 参考周期缺失时以主周期分数近似(降级,不整币失败)
  const wscore = refOk ? (v.score * 1.3 + tfEvaluate(ref).score * 0.7) / 2 : v.score;
  const rv = refOk ? tfEvaluate(ref) : v;
  const vol = volumeAnalysis(main);
  const vola = volatilityAnalysis(main);
  const regime = regimeLite(main);
  const anomaly = anomalyDetect(main, vol);
  const direction = wscore >= 0.85 ? "Strong Bullish" : wscore >= 0.35 ? "Bullish" : wscore <= -0.85 ? "Strong Bearish" : wscore <= -0.35 ? "Bearish" : "Neutral";
  const sameDir = Math.sign(v.score) === Math.sign(rv.score) && v.score !== 0;
  let confidence = 46 + Math.abs(wscore) * 20 + (sameDir ? 6 : 0) - (anomaly.detected ? 10 : 0) - (vola.level === "High" || vola.level === "Extreme" ? 6 : 0) - (vol.pattern === "缩量上涨" || vol.pattern === "缩量下跌" ? 4 : 0);
  if (!refOk) confidence -= 6;
  confidence = Math.round(Math.max(8, Math.min(90, confidence)));
  let riskScore = 26 + Math.min(30, (vola.atrPct || 0) * 2.2) + (anomaly.detected ? 12 : 0) + (vola.level === "High" || vola.level === "Extreme" ? 8 : 0);
  riskScore = Math.round(Math.max(0, Math.min(100, riskScore)));
  const out = {
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
  if (!refOk) out.degraded = true;
  if (!tickers || !tickers.length) out.no_ticker = true;
  return out;
}

async function handleScreen(url) {
  const interval = cleanInterval(url.searchParams.get("interval"));
  const symbols = [...new Set((url.searchParams.get("symbols") || "").split(",").map((s) => cleanSymbol(s)).filter(Boolean))].slice(0, 20);
  if (!symbols.length) return Response.json({ error: "缺少 symbols 参数" }, { status: 400, headers: { "access-control-allow-origin": "*" } });
  const tickersRes = await getTickers("futures").then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, error: e && e.message }));
  const tickers = tickersRes.ok ? tickersRes.v : [];
  const t0 = Date.now();
  // 服务端并发限制 4;单币失败只重试一次(仍失败 → failed 行,不拖垮整批)
  let results = await mapPool(symbols, SCREEN_CONCURRENCY, (symbol) => screenSymbol(symbol, interval, tickers).catch((e) => ({ symbol, failed: true, error_type: "exception", error: e && e.message })));
  const retryIndexes = [];
  results.forEach((r, i) => { if (r && r.failed) retryIndexes.push(i); });
  for (const i of retryIndexes) {
    try {
      await delaySrv(300);
      results[i] = await screenSymbol(symbols[i], interval, tickers);
    } catch (error) {
      results[i] = { symbol: symbols[i], failed: true, error_type: "exception", error: error && error.message };
    }
  }
  const headers = { "cache-control": "no-store", "access-control-allow-origin": "*", "x-latency-ms": String(Date.now() - t0) };
  if (!tickersRes.ok) headers["x-tickers-error"] = "1";
  return Response.json({ interval, tickers_ok: tickersRes.ok, tickers_error: tickersRes.ok ? undefined : tickersRes.error, results }, { headers });
}

export { analyzeSymbol, handleAnalyze, screenSymbol, handleScreen, handleAiReview, slimContext };

// ---- 可选 DeepSeek Reviewer(Key 只从服务端环境变量读取,绝不进入前端) ----
// V14.5 §43/§48/§49:支持 ① 关键 Decision Review(结构化摘要) ② AI Chat(真实用户问题 + 完整上下文)
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";
const AI_REVIEW_TIMEOUT_MS = 15000;
// 只允许结构化摘要,绝不发送几百根K线;上下文过大时直接拒绝(防滥用/防泄漏)
const AI_CONTEXT_MAX_BYTES = 6000;

function assertAiEndpoint(target) {
  const u = new URL(target);
  if (u.protocol !== "https:") throw new Error("ai endpoint scheme not allowed");
  if (u.hostname !== "api.deepseek.com") throw new Error("ai endpoint host not allowed");
}

// 服务端侧结构校验:只接受白名单字段,任何未知字段一律丢弃(防止把内部结构整包发给第三方)
function slimContext(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const pick = (obj, keys) => {
    const out = {};
    for (const k of keys) if (obj && obj[k] != null) out[k] = obj[k];
    return out;
  };
  const context = {
    symbol: c.symbol == null ? null : String(c.symbol).slice(0, 24),
    interval: c.interval == null ? null : String(c.interval).slice(0, 8),
    mode: c.mode == null ? null : String(c.mode).slice(0, 12),
    price: Number.isFinite(Number(c.price)) ? Number(c.price) : null,
    direction: c.direction == null ? null : String(c.direction).slice(0, 24),
    confidence: Number.isFinite(Number(c.confidence)) ? Number(c.confidence) : null,
    regime: c.regime == null ? null : String(c.regime).slice(0, 40),
    risk_level: c.risk_level == null ? null : String(c.risk_level).slice(0, 16),
    risk_score: Number.isFinite(Number(c.risk_score)) ? Number(c.risk_score) : null,
    position: c.position ? pick(c.position, ["mode", "side", "entry_price", "current_price", "leverage", "margin", "notional", "liquidation_price", "unrealized_pnl", "realized_pnl", "holding_ms", "pnl_pct"]) : null,
    prediction: c.prediction ? pick(c.prediction, ["horizon", "bullish_probability", "neutral_probability", "bearish_probability", "expected_move_pct", "expected_range_pct", "reversal_risk", "confidence", "uncertainty"]) : null,
    exit_policy: c.exit_policy == null ? null : String(c.exit_policy).slice(0, 40),
    strategy: c.strategy ? pick(c.strategy, ["short_net_pnl", "long_net_pnl", "short_trades", "long_trades", "short_win_rate", "long_win_rate"]) : null,
    profit_lock: c.profit_lock ? pick(c.profit_lock, ["stage", "max_unrealized_pnl", "current_pnl", "giveback_pct", "trailing_distance"]) : null,
    drawdown: c.drawdown ? pick(c.drawdown, ["state", "account_pct", "daily_pct"]) : null,
    external: c.external ? {
      funding_rate: Number.isFinite(Number(c.external.funding_rate)) ? Number(c.external.funding_rate) : null,
      funding_extreme: c.external.funding_extreme === true,
      oi_interpretation: c.external.oi_interpretation == null ? null : String(c.external.oi_interpretation).slice(0, 40),
      long_short_ratio: Number.isFinite(Number(c.external.long_short_ratio)) ? Number(c.external.long_short_ratio) : null,
      taker_imbalance: Number.isFinite(Number(c.external.taker_imbalance)) ? Number(c.external.taker_imbalance) : null,
      stress_level: c.external.stress_level == null ? null : String(c.external.stress_level).slice(0, 16),
      news_sentiment: c.external.news_sentiment == null ? null : String(c.external.news_sentiment).slice(0, 16),
      news_conflicted: c.external.news_conflicted === true,
      news_summary: c.external.news_summary == null ? null : String(c.external.news_summary).slice(0, 300),
      unavailable: Array.isArray(c.external.unavailable) ? c.external.unavailable.slice(0, 8).map((x) => String(x).slice(0, 24)) : []
    } : null,
    decision_type: c.decision_type == null ? null : String(c.decision_type).slice(0, 24),
    review_reasons: Array.isArray(c.review_reasons) ? c.review_reasons.slice(0, 6).map((x) => String(x).slice(0, 60)) : []
  };
  return context;
}

async function handleAiReview(url, request) {
  const symbol = cleanSymbol(url.searchParams.get("symbol"));
  const interval = cleanInterval(url.searchParams.get("interval"));
  let question = String(url.searchParams.get("question") || "").slice(0, 500);
  let rawContext = url.searchParams.get("context") || "";
  // V14.5:POST body 优先(前端把用户问题与完整上下文一起发来)
  if (request && String(request.method || "GET").toUpperCase() === "POST") {
    try {
      const body = await request.json();
      if (body && typeof body === "object") {
        if (body.question != null) question = String(body.question).slice(0, 500);
        if (body.context != null) rawContext = typeof body.context === "string" ? body.context : JSON.stringify(body.context);
      }
    } catch (error) {
      return Response.json({ ok: false, reason: "bad_request_body" }, { headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } });
    }
  }
  const apiKey = (typeof process !== "undefined" && process.env && process.env.DEEPSEEK_API_KEY) || "";
  const headers = { "cache-control": "no-store", "access-control-allow-origin": "*" };
  if (!apiKey) return Response.json({ ok: false, reason: "no_server_key", note: "未配置 DEEPSEEK_API_KEY,前端使用本地回答" }, { headers });
  let context = {};
  if (rawContext) {
    if (rawContext.length > AI_CONTEXT_MAX_BYTES) {
      return Response.json({ ok: false, reason: "context_too_large", note: "上下文超过上限,已拒绝以避免泄漏" }, { headers });
    }
    try { context = JSON.parse(rawContext); } catch (error) { return Response.json({ ok: false, reason: "bad_context" }, { headers }); }
  }
  try {
    assertAiEndpoint(DEEPSEEK_ENDPOINT);
    // 摘要:Decision Review 用分析摘要;AI Chat 额外带上用户的真实问题(§48)
    const analysis = question ? null : await analyzeSymbol(symbol, interval).catch(() => null);
    const payload = question
      ? { kind: "chat", question, context: slimContext({ ...context, symbol, interval }) }
      : {
        kind: "review",
        decision_type: context.decision_type || "entry",
        review_reasons: context.review_reasons || [],
        market: analysis ? {
          symbol,
          price: analysis.price,
          direction: analysis.direction,
          confidence: analysis.confidence,
          regime: analysis.market_regime ? analysis.market_regime.label : null,
          reasons: (analysis.reasons || []).slice(0, 3),
          risks: (analysis.risks || []).slice(0, 3)
        } : { symbol, note: "分析不可用" },
        context: slimContext({ ...context, symbol, interval })
      };
    const system = question
      ? "你是个人量化交易的本地分析助手。只依据给定 JSON 上下文回答用户的问题,用中文白话,最多 4 句。必须保留概率与不确定性,不要承诺收益,不要给出确定的买卖时机。若上下文缺失某项数据,直接说该项不可用。"
      : "你是量化交易的风险审查员。只输出 JSON:{direction:bullish|neutral|bearish,confidence:0-100,risk:0-100,agree_with_local:boolean,action:open|hold|partial_close|exit|skip,conflict:string,reason:string}";
    const body = {
      model: "deepseek-chat",
      messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(payload) }],
      max_tokens: question ? 400 : 200,
      temperature: 0.2
    };
    if (!question) body.response_format = { type: "json_object" };
    const res = await fetch(DEEPSEEK_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
      body: JSON.stringify(body),
      signal: timeoutSignal(AI_REVIEW_TIMEOUT_MS)
    });
    if (!res.ok) return Response.json({ ok: false, reason: "http_" + res.status }, { headers });
    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message ? String(data.choices[0].message.content || "").trim() : "";
    const tokens = data && data.usage ? Number(data.usage.total_tokens) || 0 : 0;
    if (!text) return Response.json({ ok: false, reason: "empty_response" }, { headers });
    if (question) {
      return Response.json({ ok: true, kind: "chat", text: text.slice(0, 800), question, tokens }, { headers });
    }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (error) { parsed = null; }
    if (!isValidAiReview(parsed)) return Response.json({ ok: false, reason: "invalid_schema", raw: text.slice(0, 200), tokens }, { headers });
    return Response.json({ ok: true, kind: "review", review: parsed, text: parsed.reason || "", tokens }, { headers });
  } catch (error) {
    return Response.json({ ok: false, reason: error && /not allowed/.test(error.message) ? "endpoint_rejected" : "upstream_error" }, { headers });
  }
}

// §44:与服务端同源的 Schema 校验(避免把非法形状透传给前端)
function isValidAiReview(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (!["bullish", "neutral", "bearish"].includes(String(obj.direction || ""))) return false;
  if (!Number.isFinite(Number(obj.confidence)) || Number(obj.confidence) < 0 || Number(obj.confidence) > 100) return false;
  if (!Number.isFinite(Number(obj.risk)) || Number(obj.risk) < 0 || Number(obj.risk) > 100) return false;
  if (!["open", "hold", "partial_close", "exit", "skip"].includes(String(obj.action || ""))) return false;
  return true;
}

export { handleAiReview as handleAiReviewLegacy };
