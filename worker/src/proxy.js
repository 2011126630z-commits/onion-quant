// proxy.js · 上游行情代理
// 设计(V13.2 行情链路修复):
//   1) 总预算受控:单次行情请求整体预算 6s,按 Binance 主节点(1.5s)→备用节点(0.7s×3)→OKX(2s)→Bybit(1.8s) 分配,
//      避免串行等待累加超过前端超时
//   2) Provider 熔断:同一上游连续 3 次失败/超时 → 45s 内跳过,不再每个请求重复撞坏节点
//   3) 全源失败短负缓存 3s:批量扫描时不会连环打满上游
//   4) 诊断:每次响应带 x-provider / x-latency-ms;全失败时错误 JSON 附各 provider 真实错误
//   5) 安全:仅允许 http/https 且 host 必须在固定白名单(拒绝 localhost/环回/私有地址与任意外部目标)
import { parseRssItems, normalizeOkxAnnouncements } from "./newsParse.js";

const upstreams = {
  futures: ["https://fapi.binance.com", "https://fapi1.binance.com", "https://fapi2.binance.com", "https://fapi3.binance.com"],
  spot: ["https://api.binance.com", "https://data-api.binance.vision"]
};
const routes = {
  futures: {
    ticker: "/fapi/v1/ticker/24hr",
    klines: "/fapi/v1/klines",
    funding: "/fapi/v1/premiumIndex",
    open_interest: "/futures/data/openInterestHist",
    long_short: "/futures/data/globalLongShortAccountRatio",
    taker: "/futures/data/takerlongshortRatio"
  },
  spot: { ticker: "/api/v3/ticker/24hr", klines: "/api/v3/klines" }
};

// 外部情报类数据(只能用于上下文,见 paper/externalData.js)
const EXTERNAL_DATA_TYPES = ["funding", "open_interest", "long_short", "taker"];

// ---- 上游白名单(字面量;任何新增源必须改这里) ----
const ALLOWED_HOSTS = new Set([
  "fapi.binance.com", "fapi1.binance.com", "fapi2.binance.com", "fapi3.binance.com",
  "api.binance.com", "data-api.binance.vision",
  "www.okx.com", "api.bybit.com",
  // V14.5:真实新闻/公告源(只用于 Research Agent 的上下文,固定路径,不接受任意 URL)
  "cointelegraph.com", "www.cointelegraph.com"
]);

// 新闻/公告的固定端点(不接受用户输入拼接,只按类型选常量)
const NEWS_ENDPOINTS = {
  announcements: "https://www.okx.com/api/v5/support/announcements",
  news: "https://cointelegraph.com/rss"
};

// ---- 预算与熔断参数 ----
const TOTAL_BUDGET_MS = 6000;
const BINANCE_PRIMARY_MS = 1500;
const BINANCE_BACKUP_MS = 700;
const FALLBACK_TRY_MS = 2000;
const BREAKER_FAILS = 3;
const BREAKER_MS = 45000;
const FAIL_CACHE_MS = 3000;
const MIN_REMAIN_MS = 250;
// 健康探测单源预算:冷 TLS 握手经本地代理可能偏慢,给 4s 避免误判为不可用
const PROBE_TIMEOUT_MS = 4000;

// ---- provider 健康状态 ----
const providerHealth = new Map(); // name -> {fails, blockedUntil, lastMs, lastOkAt, lastError, calls, oks}

// ---- 错误分类:展开 fetch failed 的 cause,给出可诊断的错误码 ----
function causeOf(error) {
  const out = [];
  let node = error;
  let depth = 0;
  while (node && depth < 4) {
    if (node.code) out.push(String(node.code));
    if (node.errno) out.push("errno=" + node.errno);
    if (node.message && depth > 0) out.push(String(node.message));
    if (Array.isArray(node.errors)) for (const e of node.errors) if (e && e.code) out.push(String(e.code));
    node = node.cause;
    depth += 1;
  }
  return out;
}

// 从错误文本里提取 HTTP 状态码(纯字符串扫描,不做命令/正则拼接)
function httpCodeFromText(text) {
  const marker = "HTTP";
  let from = 0;
  while (true) {
    const idx = text.indexOf(marker, from);
    if (idx < 0) return null;
    let cursor = idx + marker.length;
    if (text.charAt(cursor) === "_") cursor += 1;
    let digits = "";
    while (digits.length < 3) {
      const ch = text.charAt(cursor);
      if (ch < "0" || ch > "9") break;
      digits += ch;
      cursor += 1;
    }
    if (digits.length === 3) {
      const num = Number(digits);
      if (num >= 100 && num <= 599) return digits;
    }
    from = idx + marker.length;
  }
}

export function classifyNetworkError(error) {
  const text = (String((error && error.message) || "") + " " + causeOf(error).join(" ")).toUpperCase();
  const httpCode = httpCodeFromText(text);
  if (httpCode) return "HTTP_" + httpCode;
  if (/UND_ERR_CONNECT_TIMEOUT/.test(text) || /CONNECT TIMEOUT/.test(text)) return "CONNECT_TIMEOUT";
  if (/ENOTFOUND|EAI_AGAIN|GETADDRINFO/.test(text)) return "DNS_ERROR";
  if (/ECONNRESET/.test(text)) return "ECONNRESET";
  if (/ECONNREFUSED/.test(text)) return "ECONNREFUSED";
  if (/CERT|TLS|SSL|UNABLE_TO_VERIFY/.test(text)) return "TLS_ERROR";
  if (/PROXY/.test(text)) return "PROXY_ERROR";
  if (/ABORT|TIMEOUT/.test(text)) return "CONNECT_TIMEOUT";
  return "NETWORK_ERROR";
}

export function describeFetchError(error) {
  const parts = [];
  if (error && error.name) parts.push(error.name);
  if (error && error.message) parts.push(error.message);
  const extra = causeOf(error);
  if (extra.length) parts.push("[" + extra.join(", ") + "]");
  return parts.join(" ");
}

// 网络出口模式:由本地 dev-server 注入(Cloudflare runtime 下不存在 → direct)
export function netMode() {
  const mode = typeof globalThis !== "undefined" ? globalThis.__MARKET_NET_MODE : null;
  if (mode === "proxy") return "proxy";
  if (mode === "broken") return "broken";
  return "direct";
}

// 本地 Node 注入的网络信息(Node 版本 / 代理方式 / 是否原生支持);Cloudflare 下返回 Edge 默认值
export function netInfo() {
  const injected = (typeof globalThis !== "undefined" && globalThis.__MARKET_NET_INFO) ? globalThis.__MARKET_NET_INFO : null;
  if (injected) return injected;
  const isNode = (typeof process !== "undefined" && process.versions && process.versions.node) ? true : false;
  return {
    node_version: isNode ? "v" + process.versions.node : null,
    proxy_configured: false,
    proxy_source: null,
    native_env_proxy_supported: false,
    native_env_proxy_min: "v24.0.0",
    proxy_method: "direct",
    net_mode: netMode()
  };
}

function healthEntry(name) {
  let h = providerHealth.get(name);
  if (!h) {
    h = { fails: 0, blockedUntil: 0, lastMs: null, lastOkAt: null, lastError: null, lastErrorCode: null, lastStatus: null, calls: 0, oks: 0 };
    providerHealth.set(name, h);
  }
  return h;
}

function noteSuccess(name, ms, status) {
  const h = healthEntry(name);
  h.calls += 1;
  h.oks += 1;
  h.lastMs = ms;
  h.lastStatus = status;
  h.lastOkAt = Date.now();
  h.lastError = null;
  h.lastErrorCode = null;
  h.fails = 0;
  h.blockedUntil = 0;
}

function noteFailure(name, ms, error, status, code) {
  const h = healthEntry(name);
  h.calls += 1;
  h.lastMs = ms;
  h.lastStatus = status == null ? null : status;
  h.lastError = error || "unknown";
  h.lastErrorCode = code || null;
  h.fails += 1;
  if (h.fails >= BREAKER_FAILS && h.blockedUntil < Date.now()) {
    h.blockedUntil = Date.now() + BREAKER_MS;
  }
}

function isBlocked(name) {
  const h = providerHealth.get(name);
  return Boolean(h && h.blockedUntil > Date.now());
}

function providerState(h) {
  if (!h || !h.calls) return "Unknown";
  if (h.blockedUntil > Date.now()) return "Unavailable";
  if (h.lastError) return "Unavailable";
  if (h.lastMs != null && h.lastMs > 2500) return "Slow";
  return "OK";
}

export function marketHealthSnapshot() {
  const out = [];
  for (const [name, h] of providerHealth) {
    out.push({
      provider: name,
      state: providerState(h),
      calls: h.calls,
      oks: h.oks,
      fails: h.fails,
      last_ms: h.lastMs,
      last_status: h.lastStatus,
      last_ok_at: h.lastOkAt,
      last_error: h.lastError,
      last_error_code: h.lastErrorCode,
      blocked_until: h.blockedUntil > Date.now() ? h.blockedUntil : null
    });
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider));
}

// 轻量探测:各 provider 一次 time 请求(独立小预算),用于健康检查页
export async function probeMarketHealth() {
  const probes = [
    { name: "binance:fapi.binance.com", url: "https://fapi.binance.com/fapi/v1/time" },
    { name: "okx", url: "https://www.okx.com/api/v5/public/time" },
    { name: "bybit", url: "https://api.bybit.com/v5/market/time" }
  ];
  await Promise.all(probes.map(async (p) => {
    const t0 = Date.now();
    try {
      const r = await fetchUpstream(p.name, p.url, PROBE_TIMEOUT_MS);
      void r;
    } catch (error) {
      noteFailure(p.name, Date.now() - t0, (error && error.message) || String(error), null, classifyNetworkError(error));
    }
  }));
  return { generated_at: new Date().toISOString(), net_mode: netMode(), providers: marketHealthSnapshot() };
}

// ---- 安全校验:仅 https/http + host 白名单 ----
// 服务端出站校验:仅 http/https,且 host 必须在固定白名单(拒绝 localhost/环回/私有/任意目标)
function assertUpstream(target) {
  const u = new URL(target);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme not allowed: " + u.protocol);
  if (!ALLOWED_HOSTS.has(u.hostname)) throw new Error("host not allowed: " + u.hostname);
}

// 测试用出口:校验逻辑与生产一致
export function __assertUpstreamForTest(target) {
  try {
    assertUpstream(target);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function fetchUpstream(name, target, timeoutMs) {
  assertUpstream(target);
  // 运行时可注入 fetch(本地旧 Node 的代理兜底会注入 __MARKET_FETCH);Cloudflare 下不存在该全局 → 原生 fetch
  const doFetch = (typeof globalThis !== "undefined" && typeof globalThis.__MARKET_FETCH === "function") ? globalThis.__MARKET_FETCH : fetch;
  const t0 = Date.now();
  try {
    const res = await doFetch(target, {
      headers: { "accept": "application/json", "user-agent": "Mozilla/5.0" },
      signal: timeoutSignal(timeoutMs),
      cf: { cacheTtl: 0, cacheEverything: false }
    });
    const ms = Date.now() - t0;
    if (res.ok) {
      const text = await res.text();
      noteSuccess(name, ms, res.status);
      return { ok: true, status: res.status, text, ms };
    }
    const code = "HTTP_" + res.status;
    noteFailure(name, ms, "upstream " + res.status, res.status, code);
    return { ok: false, status: res.status, ms, error: "upstream " + res.status, code };
  } catch (error) {
    const ms = Date.now() - t0;
    const code = classifyNetworkError(error);
    noteFailure(name, ms, describeFetchError(error), null, code);
    return { ok: false, ms, error: describeFetchError(error), code };
  }
}

// ---- 全源失败负缓存(保护批量扫描) ----
const failCache = new Map(); // "market|type" -> at
function failCacheKey(market, type, symbol, interval) {
  return market + "|" + type + "|" + (symbol || "") + "|" + (interval || "");
}

function respond(text, provider, ms) {
  return new Response(text, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "x-provider": provider,
      "x-latency-ms": String(ms)
    }
  });
}

// ---- 主入口:预算内 Binance → OKX → Bybit ----
async function proxyBinance(url) {
  const market = url.searchParams.get("market") === "spot" ? "spot" : "futures";
  const type = url.pathname.endsWith("/klines") ? "klines"
    : url.pathname.endsWith("/tickers") ? "tickers"
      : url.pathname.endsWith("/funding") ? "funding"
        : url.pathname.endsWith("/open_interest") ? "open_interest"
          : url.pathname.endsWith("/long_short") ? "long_short"
            : url.pathname.endsWith("/taker") ? "taker"
              : "ticker";
  const isExternalType = type !== "ticker" && type !== "klines" && type !== "tickers";
  // 这些数据只存在于合约市场:现货请求直接明确拒绝,不伪造数据
  if (isExternalType && market !== "futures") {
    return Response.json({ error: type + " 仅期货市场支持", type }, { status: 400, headers: { "access-control-allow-origin": "*" } });
  }
  const params = new URLSearchParams();
  if (type !== "tickers") params.set("symbol", cleanSymbol(url.searchParams.get("symbol")));
  if (type === "klines") {
    params.set("interval", cleanInterval(url.searchParams.get("interval")));
    // 上限 1500(币安单次上限):回测/历史验证需要更长历史
    params.set("limit", String(Math.min(1500, Math.max(20, Number(url.searchParams.get("limit") || 120)))));
  }
  if (EXTERNAL_DATA_TYPES.includes(type) && type !== "funding") {
    params.set("period", cleanExternalPeriod(url.searchParams.get("period")));
    // OI 需要 2 条才能算变化;其余只要最新一条
    params.set("limit", type === "open_interest" ? "2" : "1");
  }

  const fk = failCacheKey(market, type, params.get("symbol"), params.get("interval"));
  const cached = failCache.get(fk);
  if (cached && Date.now() - cached.at < FAIL_CACHE_MS) {
    return Response.json({ error: "行情源暂时不可用(冷却中)", providers: cached.attempts, budget_ms: TOTAL_BUDGET_MS }, { status: 502, headers: { "access-control-allow-origin": "*" } });
  }

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const attempts = [];
  const remain = () => deadline - Date.now();

  // Binance:主节点给足时间,备用节点快速尝试;熔断中的直接跳过
  const binancePath = routes[market][type === "klines" ? "klines" : type === "funding" ? "funding" : type === "open_interest" ? "open_interest" : type === "long_short" ? "long_short" : type === "taker" ? "taker" : "ticker"];
  const bases = upstreams[market];
  for (let i = 0; i < bases.length; i += 1) {
    const name = "binance:" + new URL(bases[i]).hostname;
    if (isBlocked(name)) {
      attempts.push({ provider: name, skipped: "circuit_breaker" });
      continue;
    }
    if (remain() < MIN_REMAIN_MS) {
      attempts.push({ provider: name, skipped: "budget_exhausted" });
      continue;
    }
    const tryMs = i === 0 ? BINANCE_PRIMARY_MS : BINANCE_BACKUP_MS;
    const target = bases[i] + binancePath + (params.toString() ? "?" + params.toString() : "");
    const r = await fetchUpstream(name, target, Math.min(tryMs, remain()));
    if (r.ok) {
      // 资金费/外部情报类数据必须能解析出有效字段,否则视为该源失败(继续尝试下一源)
      if (isExternalType) {
        let normalized = null;
        try {
          const parsed = JSON.parse(r.text);
          normalized = type === "funding" ? normalizeBinanceFunding(parsed)
            : type === "open_interest" ? normalizeBinanceOpenInterest(parsed)
              : type === "long_short" ? normalizeBinanceLongShort(parsed)
                : normalizeBinanceTaker(parsed);
        } catch (error) { normalized = null; }
        if (!normalized) {
          attempts.push({ provider: name, error: type + " payload invalid", ms: r.ms });
          continue;
        }
        return respond(JSON.stringify(normalized), name, r.ms);
      }
      return respond(r.text, name, r.ms);
    }
    attempts.push({ provider: name, error: r.error, ms: r.ms });
  }

  // OKX 回退
  if (remain() >= MIN_REMAIN_MS) {
    const okxTarget = okxTargetOf(url, type, params);
    if (okxTarget) {
      const r = await fetchUpstream("okx", okxTarget, Math.min(FALLBACK_TRY_MS, remain()));
      if (r.ok) {
        const converted = convertOkxPayload(type, r.text);
        if (converted) return respond(converted, "okx", r.ms);
        attempts.push({ provider: "okx", error: "convert failed" });
      } else {
        attempts.push({ provider: "okx", error: r.error, ms: r.ms });
      }
    }
  } else {
    attempts.push({ provider: "okx", skipped: "budget_exhausted" });
  }

  // Bybit 回退
  if (remain() >= MIN_REMAIN_MS) {
    const bybitTarget = bybitTargetOf(url, type, params);
    if (bybitTarget) {
      const r = await fetchUpstream("bybit", bybitTarget, Math.min(FALLBACK_TRY_MS, remain()));
      if (r.ok) {
        const converted = convertBybitPayload(type, r.text);
        if (converted) return respond(converted, "bybit", r.ms);
        attempts.push({ provider: "bybit", error: "convert failed" });
      } else {
        attempts.push({ provider: "bybit", error: r.error, ms: r.ms });
      }
    }
  } else {
    attempts.push({ provider: "bybit", skipped: "budget_exhausted" });
  }

  failCache.set(fk, { at: Date.now(), attempts });
  if (failCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of failCache) if (now - v.at > FAIL_CACHE_MS * 2) failCache.delete(k);
  }
  return Response.json({
    error: "行情源暂时不可用",
    detail: attempts.filter((a) => a.error).map((a) => a.provider + ": " + a.error).join(" | ") || "全部上游被熔断或预算耗尽",
    providers: attempts,
    budget_ms: TOTAL_BUDGET_MS
  }, { status: 502, headers: { "access-control-allow-origin": "*", "x-providers-failed": "1" } });
}

function okxTargetOf(url, type, params) {
  const symbol = cleanSymbol(url.searchParams.get("symbol"));
  const instId = toOkxInstId(symbol);
  const bar = toOkxBar(cleanInterval(url.searchParams.get("interval")));
  const limit = String(Math.min(300, Math.max(20, Number(url.searchParams.get("limit") || 100))));
  const ccy = symbol.replace("USDT", "");
  const period = cleanExternalPeriod(url.searchParams.get("period"));
  if (type === "ticker") return "https://www.okx.com/api/v5/market/ticker?instId=" + instId;
  if (type === "tickers") return "https://www.okx.com/api/v5/market/tickers?instType=SWAP";
  if (type === "klines") return "https://www.okx.com/api/v5/market/candles?instId=" + instId + "&bar=" + bar + "&limit=" + limit;
  if (type === "funding") return "https://www.okx.com/api/v5/public/funding-rate?instId=" + instId;
  if (type === "open_interest") return "https://www.okx.com/api/v5/public/open-interest?instId=" + instId;
  if (type === "long_short") return "https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=" + ccy + "&period=" + period;
  // OKX 的 taker-volume 只接受 instType=SPOT|CONTRACTS(传 SWAP 会 400)
  if (type === "taker") return "https://www.okx.com/api/v5/rubik/stat/taker-volume?ccy=" + ccy + "&instType=CONTRACTS&period=" + period;
  return null;
}

function convertOkxPayload(type, text, ctx) {
  try {
    const payload = JSON.parse(text);
    if (payload.code !== "0") return null;
    let data = payload.data;
    if (type === "ticker") data = convertOkxTicker(data[0]);
    else if (type === "tickers") data = data.filter((item) => item.instId.endsWith("-USDT-SWAP")).map(convertOkxTicker);
    else if (type === "klines") data = data.map(convertOkxCandle).reverse();
    else if (type === "funding") {
      const item = Array.isArray(data) ? data[0] : data;
      const out = convertOkxFunding(item);
      if (!out) return null;
      data = out;
    } else if (type === "open_interest") {
      const out = convertOkxOpenInterest(Array.isArray(data) ? data[0] : data, ctx);
      if (!out) return null;
      data = out;
    } else if (type === "long_short") {
      const out = convertOkxLongShort(data);
      if (!out) return null;
      data = out;
    } else if (type === "taker") {
      const out = convertOkxTaker(data);
      if (!out) return null;
      data = out;
    }
    return JSON.stringify(data);
  } catch (error) {
    return null;
  }
}

function bybitTargetOf(url, type, params) {
  const symbol = cleanSymbol(url.searchParams.get("symbol"));
  const interval = toBybitInterval(cleanInterval(url.searchParams.get("interval")));
  const limit = String(Math.min(1000, Math.max(20, Number(url.searchParams.get("limit") || 100))));
  const period = toBybitPeriod(cleanExternalPeriod(url.searchParams.get("period")));
  if (type === "ticker") return "https://api.bybit.com/v5/market/tickers?category=linear&symbol=" + symbol;
  if (type === "tickers") return "https://api.bybit.com/v5/market/tickers?category=linear";
  if (type === "klines") return "https://api.bybit.com/v5/market/kline?category=linear&symbol=" + symbol + "&interval=" + interval + "&limit=" + limit;
  // Bybit 的资金费在 tickers 响应里(fundingRate / nextFundingTime)
  if (type === "funding") return "https://api.bybit.com/v5/market/tickers?category=linear&symbol=" + symbol;
  if (type === "open_interest") return "https://api.bybit.com/v5/market/open-interest?category=linear&symbol=" + symbol + "&intervalTime=" + period + "&limit=2";
  if (type === "long_short") return "https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=" + symbol + "&period=" + period + "&limit=1";
  return null;
}

function convertBybitPayload(type, text) {
  try {
    const payload = JSON.parse(text);
    if (payload.retCode !== 0) return null;
    let data = payload.result && payload.result.list ? payload.result.list : [];
    if (type === "ticker") data = convertBybitTicker(data[0]);
    else if (type === "tickers") data = data.filter((item) => String(item.symbol || "").endsWith("USDT")).map(convertBybitTicker);
    else if (type === "klines") data = data.map(convertBybitCandle).reverse();
    else if (type === "funding") {
      const out = convertBybitFunding(data[0]);
      if (!out) return null;
      data = out;
    } else if (type === "open_interest") {
      const out = convertBybitOpenInterest(data);
      if (!out) return null;
      data = out;
    } else if (type === "long_short") {
      const out = convertBybitAccountRatio(data[0]);
      if (!out) return null;
      data = out;
    }
    return JSON.stringify(data);
  } catch (error) {
    return null;
  }
}

// 兼容旧导出(测试/诊断用):thin wrapper
async function proxyOkx(url, type) {
  const params = new URLSearchParams();
  if (type !== "tickers") params.set("symbol", cleanSymbol(url.searchParams.get("symbol")));
  const target = okxTargetOf(url, type, params);
  if (!target) return Response.json({ error: "unsupported type" }, { status: 400 });
  const r = await fetchUpstream("okx", target, FALLBACK_TRY_MS);
  if (!r.ok) return Response.json({ error: r.error || "okx failed" }, { status: 502 });
  const converted = convertOkxPayload(type, r.text);
  return converted ? respond(converted, "okx", r.ms) : Response.json({ error: "okx convert failed" }, { status: 502 });
}

async function proxyBybit(url, type) {
  const params = new URLSearchParams();
  if (type !== "tickers") params.set("symbol", cleanSymbol(url.searchParams.get("symbol")));
  const target = bybitTargetOf(url, type, params);
  if (!target) return Response.json({ error: "unsupported type" }, { status: 400 });
  const r = await fetchUpstream("bybit", target, FALLBACK_TRY_MS);
  if (!r.ok) return Response.json({ error: r.error || "bybit failed" }, { status: 502 });
  const converted = convertBybitPayload(type, r.text);
  return converted ? respond(converted, "bybit", r.ms) : Response.json({ error: "bybit convert failed" }, { status: 502 });
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

// ---- 资金费转换:统一成 { symbol, lastFundingRate, nextFundingTime, markPrice, fundingIntervalHours } ----
// 任何字段缺失/无法解析 → null(调用方记为 unavailable,绝不猜测)
function convertOkxFunding(item) {
  if (!item) return null;
  const rate = Number(item.fundingRate);
  if (!Number.isFinite(rate)) return null;
  const next = Number(item.nextFundingTime);
  const intervalHours = Number(item.fundingTime) && Number(item.nextFundingTime)
    ? Math.abs(Number(item.nextFundingTime) - Number(item.fundingTime)) / 3600000
    : null;
  return {
    symbol: String(item.instId || "").replace("-USDT-SWAP", "USDT"),
    lastFundingRate: String(rate),
    nextFundingTime: Number.isFinite(next) && next > 0 ? next : null,
    markPrice: null,
    fundingIntervalHours: intervalHours && intervalHours > 0 && intervalHours <= 24 ? intervalHours : null,
    provider: "okx"
  };
}

function convertBybitFunding(item) {
  if (!item) return null;
  const rate = Number(item.fundingRate);
  if (!Number.isFinite(rate)) return null;
  const next = Number(item.nextFundingTime);
  const mark = Number(item.markPrice);
  return {
    symbol: String(item.symbol || ""),
    lastFundingRate: String(rate),
    nextFundingTime: Number.isFinite(next) && next > 0 ? next : null,
    markPrice: Number.isFinite(mark) && mark > 0 ? String(mark) : null,
    fundingIntervalHours: null,
    provider: "bybit"
  };
}

// Binance premiumIndex 原始响应:lastFundingRate 与 nextFundingTime 已经是目标字段名
function normalizeBinanceFunding(raw) {
  if (!raw || typeof raw !== "object") return null;
  const rate = Number(raw.lastFundingRate);
  if (!Number.isFinite(rate)) return null;
  return { ...raw, provider: raw.provider || "binance" };
}

// ---- 外部情报类数据转换:统一成 externalData.js 认识的形状 ----
// 任何字段缺失/无法解析 → null(调用方记为 unavailable,绝不猜测)
function cleanExternalPeriod(value) {
  const allowed = ["5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"];
  return allowed.includes(value) ? value : "5m";
}

function normalizeBinanceOpenInterest(raw) {
  const rows = Array.isArray(raw) ? raw : [raw];
  const list = rows.filter((r) => r && Number.isFinite(Number(r.sumOpenInterest)));
  if (!list.length) return null;
  const latest = list[list.length - 1];
  const prev = list.length > 1 ? list[0] : null;
  const value = Number(latest.sumOpenInterest);
  if (!(value > 0)) return null;
  return {
    open_interest: value,
    prev_open_interest: prev ? Number(prev.sumOpenInterest) : null,
    open_interest_value: Number.isFinite(Number(latest.sumOpenInterestValue)) ? Number(latest.sumOpenInterestValue) : null,
    timestamp: Number(latest.timestamp) || null,
    provider: "binance"
  };
}

function normalizeBinanceLongShort(raw) {
  const row = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  if (!row) return null;
  const ratio = Number(row.longShortRatio);
  if (!Number.isFinite(ratio) || !(ratio > 0)) return null;
  return {
    long_short_ratio: ratio,
    long_account_pct: Number.isFinite(Number(row.longAccount)) ? Number(row.longAccount) * 100 : null,
    short_account_pct: Number.isFinite(Number(row.shortAccount)) ? Number(row.shortAccount) * 100 : null,
    timestamp: Number(row.timestamp) || null,
    provider: "binance"
  };
}

function normalizeBinanceTaker(raw) {
  const row = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  if (!row) return null;
  const buy = Number(row.buyVol);
  const sell = Number(row.sellVol);
  if (!Number.isFinite(buy) || !Number.isFinite(sell)) return null;
  return {
    taker_buy_volume: buy,
    taker_sell_volume: sell,
    buy_sell_ratio: Number.isFinite(Number(row.buySellRatio)) ? Number(row.buySellRatio) : null,
    timestamp: Number(row.timestamp) || null,
    provider: "binance"
  };
}

function convertOkxOpenInterest(item, ctx) {
  if (!item) return null;
  const oi = Number(item.oi);
  if (!Number.isFinite(oi)) return null;
  return {
    open_interest: oi,
    prev_open_interest: ctx && Number.isFinite(Number(ctx.prev_oi)) ? Number(ctx.prev_oi) : null,
    open_interest_value: Number.isFinite(Number(item.oiCcy)) ? Number(item.oiCcy) : null,
    timestamp: Number(item.ts) || null,
    provider: "okx"
  };
}

function convertOkxLongShort(data) {
  const row = Array.isArray(data) ? data[0] : null;
  if (!Array.isArray(row) || row.length < 2) return null;
  const ratio = Number(row[1]);
  if (!Number.isFinite(ratio) || !(ratio > 0)) return null;
  return { long_short_ratio: ratio, timestamp: Number(row[0]) || null, provider: "okx" };
}

function convertOkxTaker(data) {
  const row = Array.isArray(data) ? data[0] : null;
  if (!Array.isArray(row) || row.length < 3) return null;
  const sell = Number(row[1]);
  const buy = Number(row[2]);
  if (!Number.isFinite(buy) || !Number.isFinite(sell)) return null;
  return { taker_buy_volume: buy, taker_sell_volume: sell, timestamp: Number(row[0]) || null, provider: "okx" };
}

function convertBybitOpenInterest(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const sorted = list.slice().sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
  const latest = sorted[0];
  const value = Number(latest && latest.openInterest);
  if (!Number.isFinite(value) || !(value > 0)) return null;
  return {
    open_interest: value,
    prev_open_interest: sorted.length > 1 && Number.isFinite(Number(sorted[1].openInterest)) ? Number(sorted[1].openInterest) : null,
    timestamp: Number(latest.timestamp) || null,
    provider: "bybit"
  };
}

function convertBybitAccountRatio(item) {
  if (!item) return null;
  const buy = Number(item.buyRatio);
  const sell = Number(item.sellRatio);
  if (!Number.isFinite(buy) || !Number.isFinite(sell) || buy + sell <= 0) return null;
  return {
    long_short_ratio: buy / sell,
    long_account_pct: buy * 100,
    short_account_pct: sell * 100,
    timestamp: Number(item.timestamp) || null,
    provider: "bybit"
  };
}

function toBybitPeriod(period) {
  return { "5m": "5min", "15m": "15min", "30m": "30min", "1h": "1h", "4h": "4h", "1d": "1d" }[period] || "5min";
}

// 测试辅助:清空健康状态与失败缓存
export function __resetMarketHealthForTest() {
  providerHealth.clear();
  failCache.clear();
}

// ---- V14.5:真实新闻/公告取数(固定端点 + 解析成统一 JSON,失败返回明确错误) ----
// 说明:公告走 OKX 官方(不带 annType 参数才返回有效列表);新闻走 CoinTelegraph RSS。
// 两者都只作 Research 的上下文,绝不影响本地行情引擎的可用性(§20/§96)。
async function handleNewsFeed(url) {
  const kind = url.pathname.endsWith("/announcements") ? "announcements" : "news";
  const limit = Math.min(40, Math.max(1, Number(url.searchParams.get("limit") || 20)));
  const target = NEWS_ENDPOINTS[kind];
  const headers = { "cache-control": "no-store", "access-control-allow-origin": "*" };
  const name = kind === "announcements" ? "okx:announcements" : "cointelegraph:rss";
  const r = await fetchUpstream(name, target, kind === "announcements" ? FALLBACK_TRY_MS : PROBE_TIMEOUT_MS);
  if (!r.ok) {
    return Response.json({ error: kind + " 上游不可用", detail: r.error || ("http " + r.status), items: [], provider: name }, { status: 502, headers });
  }
  let items = [];
  if (kind === "announcements") {
    let payload = null;
    try { payload = JSON.parse(r.text); } catch (error) { payload = null; }
    if (!payload) return Response.json({ error: "announcements 响应非 JSON", items: [], provider: name }, { status: 502, headers });
    items = normalizeOkxAnnouncements(payload, { limit, now: Date.now() });
    if (!items.length) return Response.json({ error: "announcements 无可解析条目", items: [], provider: name }, { status: 502, headers });
  } else {
    items = parseRssItems(r.text, { limit, now: Date.now(), source_id: "cointelegraph", source_kind: "reputable_media" });
    if (!items.length) return Response.json({ error: "news 无可解析条目", items: [], provider: name }, { status: 502, headers });
  }
  return Response.json({ kind, provider: name, count: items.length, items, fetched_at: Date.now() }, { headers });
}

export { upstreams, routes, proxyBinance, proxyOkx, proxyBybit, cleanSymbol, timeoutSignal, cleanInterval, cleanExternalPeriod, toOkxInstId, toOkxBar, convertOkxTicker, convertOkxCandle, convertOkxFunding, convertOkxOpenInterest, convertOkxLongShort, convertOkxTaker, toBybitInterval, toBybitPeriod, convertBybitTicker, convertBybitCandle, convertBybitFunding, convertBybitOpenInterest, convertBybitAccountRatio, normalizeBinanceFunding, normalizeBinanceOpenInterest, normalizeBinanceLongShort, normalizeBinanceTaker, handleNewsFeed, NEWS_ENDPOINTS, marketHealthSnapshot as healthSnapshot, classifyNetworkError as classifyError, describeFetchError as describeError };
