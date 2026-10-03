// tools/test-market-link.mjs
// 行情链路测试(mock 上游 fetch,走完整真实代码路径 proxy → marketData → routes)
// 覆盖:
//   1 Binance 主源成功  2 主源超时→fallback 成功  3 多节点异常不会无限串行等待
//   4 ticker 失败但主K线成功 → analyze 仍可返回  5 非主周期失败 → data_degraded 不整页失败
//   6 主周期失败 → 正确报错(真实原因)  7/8 前端结构(见 test-market-ui.mjs)
//   9 scan 部分失败其余成功  10 scan 只重试失败币  11 circuit breaker 生效  12 总请求时间有界
import workerBundle, { __resetMarketHealthForTest as resetHealth, __resetCachesForTest as resetCaches } from "../worker/index.js";

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log("PASS  " + name); }
  else { failed += 1; console.log("FAIL  " + name + (detail ? "  => " + detail : "")); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}

// 重置必须作用于 worker bundle 内部的模块实例(而非 src 副本)
const worker = workerBundle;
function freshWorker() {
  resetHealth();
  resetCaches();
  calls = [];
}

// ---- mock 上游 ----
const IV_MS = { "1h": 3600000, "15m": 900000, "4h": 14400000, "1d": 86400000 };
function klineArray(symbol, interval, limit, seed) {
  let s = seed >>> 0;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const iv = IV_MS[interval] || 3600000;
  const end = 1700000000000 + 1000 * 3600000;
  const rows = [];
  let price = 100;
  for (let i = 0; i < limit; i += 1) {
    const openTime = end - (limit - i) * iv;
    const open = price;
    const close = price * (1 + (rand() - 0.48) * 0.01);
    rows.push([openTime, String(open), String(Math.max(open, close) * 1.002), String(Math.min(open, close) * 0.998), String(close), String(1000 + rand() * 500), openTime + iv - 1]);
    price = close;
  }
  return rows;
}
function okxKlines(arr) {
  return { code: "0", data: arr.map((k) => [String(k[0]), k[1], k[2], k[3], k[4], k[5], String(k[6])]).reverse() };
}
function bybitKlines(arr) {
  return { retCode: 0, result: { list: arr.map((k) => [String(k[0]), k[1], k[2], k[3], k[4], k[5], String(k[6])]).reverse() } };
}
function tickerArray() {
  const out = [];
  for (let i = 0; i < 60; i += 1) {
    out.push({ symbol: "COIN" + i + "USDT", lastPrice: "1", priceChangePercent: String(i % 7 - 3), highPrice: "1.1", lowPrice: "0.9", quoteVolume: String(1e9 - i * 1e6) });
  }
  out.push({ symbol: "BTCUSDT", lastPrice: "110", priceChangePercent: "2.5", highPrice: "112", lowPrice: "95", quoteVolume: "5e9" });
  out.push({ symbol: "ETHUSDT", lastPrice: "55", priceChangePercent: "-1.2", highPrice: "57", lowPrice: "54", quoteVolume: "3e9" });
  out.push({ symbol: "SOLUSDT", lastPrice: "21", priceChangePercent: "4.1", highPrice: "22", lowPrice: "20", quoteVolume: "2e9" });
  return out;
}

// 场景控制:scheme -> behavior("ok" | "timeout" | "500" | "reset")
let behavior = {
  "fapi.binance.com": "ok",
  "fapi1.binance.com": "ok",
  "fapi2.binance.com": "ok",
  "fapi3.binance.com": "ok",
  "www.okx.com": "ok",
  "api.bybit.com": "ok"
};
// 精确拦截规则(按 URL path 与参数,跨 provider 一致)
const isKlinesUrl = (u) => u.includes("/fapi/v1/klines") || u.includes("/api/v3/klines") || u.includes("/market/candles") || u.includes("/market/kline");
const isTickersUrl = (u) => u.includes("ticker/24hr") || u.includes("/market/tickers");
// 各 provider 的周期参数写法不同(Binance interval=15m / OKX bar=15m / Bybit interval=15)
const IV_ALIASES = { "1m": ["1m", "1"], "5m": ["5m", "5"], "15m": ["15m", "15"], "1h": ["1h", "1H", "60"], "4h": ["4h", "4H", "240"], "1d": ["1d", "1D", "D"] };
const hasInterval = (u, iv) => {
  const aliases = IV_ALIASES[iv] || [iv];
  return aliases.some((a) => u.includes("interval=" + a) || u.includes("bar=" + a));
};
let intercept = null; // (url) => Response | null
let calls = [];
const realFetch = globalThis.fetch;
function installFetch() {
  globalThis.fetch = async (target, init) => {
    const url = String(target);
    calls.push(url);
    if (intercept) {
      const r = intercept(url);
      if (r) return r;
    }
    const host = new URL(url).hostname;
    const b = behavior[host] || "ok";
    if (b === "timeout") {
      // 模拟真实超时:监听 abort 信号,被 abort 时 reject
      return new Promise((resolve, reject) => {
        const signal = init && init.signal;
        let timer = null;
        let settled = false;
        const finish = (fn, arg) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); fn(arg); };
        const onAbort = () => finish(reject, new Error("The operation was aborted due to timeout"));
        if (signal) {
          if (signal.aborted) { onAbort(); return; }
          signal.addEventListener("abort", onAbort);
        }
        timer = setTimeout(() => finish(resolve, new Response("{}", { status: 200 })), 30000);
      });
    }
    if (b === "500") return new Response("server error", { status: 500 });
    if (b === "reset") throw new Error("fetch failed");
    if (url.includes("/fapi/v1/ticker/24hr") || url.includes("/api/v3/ticker/24hr")) {
      return new Response(JSON.stringify(tickerArray()), { status: 200 });
    }
    if (url.includes("/fapi/v1/klines") || url.includes("/api/v3/klines")) {
      const u = new URL(url);
      return new Response(JSON.stringify(klineArray(u.searchParams.get("symbol"), u.searchParams.get("interval"), Number(u.searchParams.get("limit")) || 120, 7)), { status: 200 });
    }
    if (url.includes("/api/v5/market/tickers")) return new Response(JSON.stringify({ code: "0", data: tickerArray().map((t) => ({ instId: t.symbol.replace("USDT", "-USDT-SWAP"), last: t.lastPrice, open24h: String(Number(t.lastPrice) / (1 + Number(t.priceChangePercent) / 100)), high24h: t.highPrice, low24h: t.lowPrice, volCcy24h: t.quoteVolume })) }), { status: 200 });
    if (url.includes("/api/v5/market/candles")) {
      const u = new URL(url);
      const ivMap = { "1H": "1h", "4H": "4h", "15m": "15m" };
      const iv = ivMap[u.searchParams.get("bar")] || "1h";
      return new Response(JSON.stringify(okxKlines(klineArray(u.searchParams.get("instId").replace("-USDT-SWAP", "USDT"), iv, Number(u.searchParams.get("limit")) || 100, 9))), { status: 200 });
    }
    if (url.includes("/v5/market/tickers")) return new Response(JSON.stringify({ retCode: 0, result: { list: tickerArray().map((t) => ({ symbol: t.symbol, lastPrice: t.lastPrice, price24hPcnt: String(Number(t.priceChangePercent) / 100), highPrice24h: t.highPrice, lowPrice24h: t.lowPrice, turnover24h: t.quoteVolume })) } }), { status: 200 });
    if (url.includes("/v5/market/kline")) {
      const u = new URL(url);
      const ivMap = { "60": "1h", "240": "4h", "15": "15m" };
      const iv = ivMap[u.searchParams.get("interval")] || "1h";
      return new Response(JSON.stringify(bybitKlines(klineArray(u.searchParams.get("symbol"), iv, Number(u.searchParams.get("limit")) || 100, 11))), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };
}
function uninstallFetch() {
  globalThis.fetch = realFetch;
}


// ============================================================
console.log("== 1. Binance 主源成功 ==");
installFetch();
freshWorker();
const t0 = Date.now();
const res1 = await worker.fetch(new Request("https://app.local/api/klines?market=futures&symbol=BTCUSDT&interval=1h&limit=200"));
const body1 = await res1.json();
eq("状态 200", res1.status, 200);
eq("provider = binance 主源", res1.headers.get("x-provider"), "binance:fapi.binance.com");
eq("K线条数", body1.length, 200);
check("耗时 < 1.5s", Date.now() - t0 < 1500, String(Date.now() - t0) + "ms");

console.log("== 2. 主源超时 → 备用 Binance fallback 成功 ==");
freshWorker();
behavior["fapi.binance.com"] = "timeout";
const res2 = await worker.fetch(new Request("https://app.local/api/klines?market=futures&symbol=ETHUSDT&interval=1h&limit=120"));
eq("fallback 状态 200", res2.status, 200);
eq("provider = 备用节点", res2.headers.get("x-provider"), "binance:fapi1.binance.com");
check("只调用了主源+备用1(不再串行试完全部)", calls.filter((c) => c.includes("fapi")).length === 2, String(calls.filter((c) => c.includes("fapi")).length));
behavior["fapi.binance.com"] = "ok";

console.log("== 3. 多节点异常不会无限串行等待(总预算受控) ==");
freshWorker();
for (const h of ["fapi.binance.com", "fapi1.binance.com", "fapi2.binance.com", "fapi3.binance.com", "www.okx.com", "api.bybit.com"]) behavior[h] = "timeout";
const t3 = Date.now();
const res3 = await worker.fetch(new Request("https://app.local/api/klines?market=futures&symbol=BTCUSDT&interval=1h&limit=120"));
const body3 = await res3.json();
const elapsed3 = Date.now() - t3;
eq("全部超时 → 502", res3.status, 502);
check("总耗时 < 7s(预算受控,不无限串行)", elapsed3 < 7000, elapsed3 + "ms");
check("错误含真实原因(timeout)", /timeout/i.test(body3.detail || ""), body3.detail);
check("错误含各 provider 尝试记录", Array.isArray(body3.providers) && body3.providers.length >= 6, JSON.stringify(body3.providers).slice(0, 200));
for (const h of Object.keys(behavior)) behavior[h] = "ok";

console.log("== 4. ticker 失败但主K线成功 → analyze 仍可返回 ==");
freshWorker();
// tickers 全部上游失败,K线正常 → analyze 仍必须返回(tickers 降级)
intercept = (url) => (isTickersUrl(url) ? new Response("{}", { status: 500 }) : null);
const res4 = await worker.fetch(new Request("https://app.local/api/analyze?symbol=BTCUSDT&interval=1h"));
const body4 = await res4.json();
eq("analyze 状态 200(不因 tickers 失败而失败)", res4.status, 200, JSON.stringify(body4).slice(0, 200));
eq("方向字段存在", typeof body4.direction, "string");
check("市场广度降级为 null", body4.breadth === null, JSON.stringify(body4.breadth));
check("降级说明包含全市场行情失败", /全市场行情/.test(body4.degraded_note || ""), body4.degraded_note);
intercept = null;

console.log("== 5. 非主周期失败 → data_degraded,但分析成功 ==");
freshWorker();
// 15m 在所有上游都失败(辅助周期),其他周期成功
intercept = (url) => (isKlinesUrl(url) && hasInterval(url, "15m") ? new Response("{}", { status: 500 }) : null);
const res5 = await worker.fetch(new Request("https://app.local/api/analyze?symbol=BTCUSDT&interval=1h"));
const body5 = await res5.json();
eq("analyze 状态 200", res5.status, 200);
eq("data_degraded 标记", body5.data_degraded, true);
check("降级说明提到 15m", /15m/.test(body5.degraded_note || ""), body5.degraded_note);
check("主周期分析完整(含 timeframes)", Boolean(body5.timeframes && body5.timeframes["1h"]), JSON.stringify(Object.keys(body5.timeframes || {})));
check("limited_data 为 false(主周期数据充足)", body5.limited_data === false, JSON.stringify(body5.limited_data));
intercept = null;

console.log("== 6. 主周期失败 → 正确报错(真实原因) ==");
freshWorker();
behavior["www.okx.com"] = "timeout";
behavior["api.bybit.com"] = "timeout";
behavior["fapi.binance.com"] = "timeout";
behavior["fapi1.binance.com"] = "timeout";
behavior["fapi2.binance.com"] = "timeout";
behavior["fapi3.binance.com"] = "timeout";
const t6 = Date.now();
const res6 = await worker.fetch(new Request("https://app.local/api/analyze?symbol=BTCUSDT&interval=1h"));
const body6 = await res6.json();
eq("analyze 状态 502", res6.status, 502);
check("错误含主周期失败与真实原因", /主周期K线获取失败/.test(body6.error || "") && /timeout/i.test(body6.error || ""), body6.error);
check("报错耗时 < 7s", Date.now() - t6 < 7000, String(Date.now() - t6) + "ms");
for (const h of Object.keys(behavior)) behavior[h] = "ok";

console.log("== 9. scan 部分币失败,其他币仍成功 ==");
freshWorker();
const realFetchScan = globalThis.fetch;
// DOGEUSDT 的K线在所有上游都失败(candles/kline 是 OKX/Bybit 路径)
intercept = (url) => (isKlinesUrl(url) && url.includes("DOGE") ? new Response("{}", { status: 500 }) : null);
const res9 = await worker.fetch(new Request("https://app.local/api/screen?interval=1h&symbols=BTCUSDT,ETHUSDT,DOGEUSDT,SOLUSDT"));
const body9 = await res9.json();
eq("screen 状态 200", res9.status, 200);
const failed9 = body9.results.filter((r) => r.failed);
const ok9 = body9.results.filter((r) => !r.failed);
eq("成功 3 个", ok9.length, 3, JSON.stringify(body9.results.map((r) => r.symbol + (r.failed ? ":fail" : ":ok"))));
eq("失败 1 个", failed9.length, 1);
eq("失败币种为 DOGEUSDT", failed9[0] && failed9[0].symbol, "DOGEUSDT");
check("失败带 error_type", Boolean(failed9[0].error_type), JSON.stringify(failed9[0]));
check("成功行含方向与置信", ok9.every((r) => r.direction && typeof r.confidence === "number"));
intercept = null;

console.log("== 10. scan 只重试失败币(成功币不重复请求) ==");
freshWorker();
let dogeCalls = 0;
let btcCalls = 0;
intercept = (url) => {
  if (isKlinesUrl(url) && url.includes("DOGE")) { dogeCalls += 1; return new Response("{}", { status: 500 }); }
  return null;
};
const realFetchCount = globalThis.fetch;
globalThis.fetch = async (target, init) => {
  const url = String(target);
  if (isKlinesUrl(url) && url.includes("BTCUSDT")) btcCalls += 1;
  return realFetchCount(target, init);
};
const res10 = await worker.fetch(new Request("https://app.local/api/screen?interval=1h&symbols=BTCUSDT,DOGEUSDT"));
await res10.json();
globalThis.fetch = realFetchCount;
intercept = null;
eq("BTC 主K线只请求一次(不重试成功币)", btcCalls, 2, String(btcCalls));
check("DOGE K线重试过(首次+重试)", dogeCalls >= 2, String(dogeCalls));

console.log("== 11. circuit breaker 生效 ==");
freshWorker();
behavior["fapi.binance.com"] = "timeout";
// 连续 3 次失败 → 第 4 次请求应直接跳过主源(不产生对该 host 的 fetch)
for (let i = 0; i < 3; i += 1) {
  behavior["fapi1.binance.com"] = "ok";
  await worker.fetch(new Request("https://app.local/api/klines?market=futures&symbol=COIN" + i + "USDT&interval=1h&limit=60"));
}
const callsBefore = calls.length;
behavior["fapi1.binance.com"] = "ok";
const res11 = await worker.fetch(new Request("https://app.local/api/klines?market=futures&symbol=FINALUSDT&interval=1h&limit=60"));
eq("熔断后仍能从备用节点成功", res11.status, 200);
const fapiCallsAfter = calls.slice(callsBefore).filter((c) => c.includes("fapi.binance.com")).length;
eq("主源被熔断跳过(零调用)", fapiCallsAfter, 0, String(fapiCallsAfter));
behavior["fapi.binance.com"] = "ok";

console.log("== 12. 全源失败短负缓存(批量保护) ==");
freshWorker();
for (const h of Object.keys(behavior)) behavior[h] = "timeout";
const tA = Date.now();
await worker.fetch(new Request("https://app.local/api/klines?market=futures&symbol=NEGUSDT&interval=1h&limit=60"));
const firstMs = Date.now() - tA;
const tB = Date.now();
const resB = await worker.fetch(new Request("https://app.local/api/klines?market=futures&symbol=NEGUSDT&interval=1h&limit=60"));
const secondMs = Date.now() - tB;
eq("第二次立即返回 502(负缓存)", resB.status, 502);
check("第二次耗时远小于第一次(<200ms)", secondMs < 200 && firstMs > 500, `first=${firstMs}ms second=${secondMs}ms`);
for (const h of Object.keys(behavior)) behavior[h] = "ok";

console.log("== 附加:健康检查端点 ==");
freshWorker();
const resH = await worker.fetch(new Request("https://app.local/api/health"));
const bodyH = await resH.json();
eq("health 状态 200", resH.status, 200);
check("health 返回 providers 数组", Array.isArray(bodyH.providers), JSON.stringify(bodyH).slice(0, 200));

uninstallFetch();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("MARKET LINK TESTS OK");
