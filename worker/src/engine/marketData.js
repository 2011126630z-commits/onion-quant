// engine/marketData.js · MarketDataProvider(K线/行情缓存取数)
// V13.2:错误信息透传上游真实原因(不再吞掉);记录每段数据实际使用的 provider(诊断用)

import { INTERVAL_MS } from "./constants.js";
import { proxyBinance } from "../proxy.js";

const KL_CACHE = new Map();
const TICKERS_CACHE = new Map();
const KL_TTL = 20000;
const TICKERS_TTL = 15000;
const PROVIDER_INFO = new Map(); // key -> provider(最近一次成功使用的上游)

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

// 从 502 JSON 中提取人类可读的真实原因
async function extractUpstreamDetail(res) {
  try {
    const j = await res.json();
    if (j && j.detail) return j.detail;
    if (j && Array.isArray(j.providers)) {
      const errs = j.providers.filter((p) => p && p.error).map((p) => p.provider + ": " + p.error);
      if (errs.length) return errs.join(" | ");
    }
    if (j && j.error) return j.error;
  } catch (error) { /* 响应不是 JSON */ }
  return "http " + res.status;
}

async function getKlines(market, symbol, interval, limit) {
  const key = market + "|" + symbol + "|" + interval + "|" + limit;
  const hit = cacheGet(KL_CACHE, key, KL_TTL);
  if (hit) return hit;
  const res = await proxyBinance(engineUrl("/api/klines", { market, symbol, interval, limit }));
  if (!res.ok) {
    const detail = await extractUpstreamDetail(res);
    throw new Error("klines " + symbol + " " + interval + " 获取失败: " + detail);
  }
  const provider = res.headers.get("x-provider");
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
  if (provider) PROVIDER_INFO.set(key, provider);
  cacheSet(KL_CACHE, key, rows);
  return rows;
}

async function getTickers(market) {
  const hit = cacheGet(TICKERS_CACHE, market, TICKERS_TTL);
  if (hit) return hit;
  const res = await proxyBinance(engineUrl("/api/tickers", { market }));
  if (!res.ok) {
    const detail = await extractUpstreamDetail(res);
    throw new Error("tickers 获取失败: " + detail);
  }
  const provider = res.headers.get("x-provider");
  const raw = await res.json();
  const data = Array.isArray(raw) ? raw : [];
  if (provider) PROVIDER_INFO.set("tickers|" + market, provider);
  cacheSet(TICKERS_CACHE, market, data);
  return data;
}

// 诊断:最近一次成功使用的上游
function providerOf(kind, market, symbol, interval, limit) {
  const key = kind === "tickers" ? "tickers|" + market : market + "|" + symbol + "|" + interval + "|" + limit;
  return PROVIDER_INFO.get(key) || null;
}

// 测试辅助
function __resetCachesForTest() {
  KL_CACHE.clear();
  TICKERS_CACHE.clear();
  PROVIDER_INFO.clear();
}

export { KL_CACHE, TICKERS_CACHE, KL_TTL, TICKERS_TTL, cacheGet, cacheSet, engineUrl, getKlines, getTickers, providerOf, __resetCachesForTest };
