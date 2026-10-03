// tools/net-proxy.mjs · 本地开发的网络出口支持(Node-only;绝不打进 Cloudflare Worker)
//
// 代理优先级:MARKET_PROXY_URL > HTTPS_PROXY > HTTP_PROXY > ALL_PROXY > Windows 系统代理 > 直连
// 实现方式:Node 官方 env proxy(NODE_USE_ENV_PROXY=1 + HTTP(S)_PROXY);
//          该开关只在进程启动时读取,因此 dev-server 检测到代理时会自动"带代理环境重启"。
// 约束:不硬编码任何代理端口;NO_PROXY 必含 localhost/127.0.0.1(避免环路);无代理时等同于直连。
import { execSync, spawn } from "node:child_process";

const DEFAULT_NO_PROXY = ["localhost", "127.0.0.1", "::1"];

// ---- Node 原生 env proxy 能力探测 ----
// 官方支持分支:Node 22 >= 22.21.0 / Node 24 >= 24.5.0;更高主版本按运行时能力判断
// 第一优先:process.allowedNodeEnvironmentFlags.has("--use-env-proxy")(Node 仅在真实支持时才列出)
const NATIVE_ENV_PROXY_TABLE = [
  { major: 22, minMinor: 21 },
  { major: 24, minMinor: 5 }
];
export const NATIVE_ENV_PROXY_REQUIREMENTS = ["Node 22 requires >= 22.21.0", "Node 24 requires >= 24.5.0"];
export const NATIVE_ENV_PROXY_MIN_TEXT = NATIVE_ENV_PROXY_REQUIREMENTS.join(" · ");

export function parseNodeVersion(version) {
  const m = String(version || "").replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function supportsNativeEnvProxy(versions, flags) {
  const v = versions || (typeof process !== "undefined" && process.versions ? process.versions : {});
  const allowed = flags || (typeof process !== "undefined" && process.allowedNodeEnvironmentFlags ? process.allowedNodeEnvironmentFlags : null);
  if (allowed && typeof allowed.has === "function") {
    try {
      if (allowed.has("--use-env-proxy")) return true;
    } catch (error) { /* 继续走版本表 */ }
  }
  const parsed = parseNodeVersion(v.node);
  if (!parsed) return false;
  const rule = NATIVE_ENV_PROXY_TABLE.find((r) => r.major === parsed.major);
  if (rule) return parsed.minor >= rule.minMinor;
  // 表中没有的分支:高于最高已知主版本按支持处理,低于则不支持
  const highest = NATIVE_ENV_PROXY_TABLE.reduce((a, b) => (b.major > a.major ? b : a), NATIVE_ENV_PROXY_TABLE[0]);
  return parsed.major > highest.major;
}

// 统一行情出口:本地旧 Node 的兜底实现会注入 __MARKET_FETCH;其余情况用原生 fetch
// (启动连通性检查、/api/health 探测、真实行情请求必须共用本函数,禁止两套出口)
export function getMarketFetch() {
  const injected = typeof globalThis !== "undefined" ? globalThis.__MARKET_FETCH : null;
  if (typeof injected === "function") return injected;
  return fetch;
}

export function noProxyList(extra) {
  const raw = process.env.NO_PROXY || process.env.no_proxy || "";
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const list = parts.length ? parts : DEFAULT_NO_PROXY.slice();
  for (const item of extra || []) if (!list.includes(item)) list.push(item);
  return list;
}

export function normalizeProxyUrl(value) {
  if (!value) return null;
  let raw = String(value).trim();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = "http://" + raw;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString().replace(/\/$/, "");
  } catch (error) {
    return null;
  }
}

// 读取 Windows 系统代理(注册表);读不到返回 null
export function readWindowsSystemProxy() {
  if (process.platform !== "win32") return null;
  const regKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  try {
    const en = execSync('reg query "' + regKey + '" /v ProxyEnable', { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000 });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(en)) return null;
    const sv = execSync('reg query "' + regKey + '" /v ProxyServer', { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000 });
    const m = sv.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
    if (!m) return null;
    const parts = m[1].trim().split(";").map((s) => s.trim()).filter(Boolean);
    let candidate = null;
    for (const p of parts) {
      if (/^https=/i.test(p)) candidate = p.replace(/^https=/i, "");
      else if (/^http=/i.test(p) && !candidate) candidate = p.replace(/^http=/i, "");
      else if (!/=/.test(p) && !candidate) candidate = p;
    }
    return normalizeProxyUrl(candidate);
  } catch (error) {
    return null;
  }
}

// 探测可用代理(env 优先;可用 __QUANT_SKIP_SYSTEM_PROXY=1 跳过注册表探测)
export function detectProxy(env) {
  const e = env || process.env;
  const candidates = [
    ["MARKET_PROXY_URL", e.MARKET_PROXY_URL],
    ["HTTPS_PROXY", e.HTTPS_PROXY || e.https_proxy],
    ["HTTP_PROXY", e.HTTP_PROXY || e.http_proxy],
    ["ALL_PROXY", e.ALL_PROXY || e.all_proxy]
  ];
  for (const [source, value] of candidates) {
    const url = normalizeProxyUrl(value);
    if (url) return { url, source };
  }
  if (e.__QUANT_SKIP_SYSTEM_PROXY === "1") return { url: null, source: "none" };
  const sys = readWindowsSystemProxy();
  if (sys) return { url: sys, source: "windows-system-proxy" };
  return { url: null, source: "none" };
}

// 组装代理环境变量(重启时注入子进程)
export function buildProxyEnv(proxyUrl, env) {  const e = env || process.env;
  const list = noProxyList(["localhost", "127.0.0.1", "::1"]);
  const out = {
    NODE_USE_ENV_PROXY: "1",
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    MARKET_PROXY_URL: proxyUrl,
    NO_PROXY: list.join(","),
    no_proxy: list.join(","),
    __QUANT_PROXY_REEXEC: "1",
    __QUANT_PROXY_SOURCE: "env",
    __QUANT_NET_MODE: "proxy",
    __QUANT_SKIP_SYSTEM_PROXY: "1"
  };
  return out;
}

// 是否需要"带代理环境重启"(env proxy 只在进程启动时读取)
export function needsReexec(proxyUrl, env) {
  const e = env || process.env;
  if (!proxyUrl) return false;
  if (e.__QUANT_PROXY_REEXEC === "1") return false;
  const already = e.NODE_USE_ENV_PROXY === "1" && (e.HTTPS_PROXY || e.HTTP_PROXY);
  return !already;
}

// 带代理环境重启入口(stdio 继承)
export function reexecWithProxy(entryFile, proxyUrl, options) {
  const opts = options || {};
  const env = { ...process.env, ...buildProxyEnv(proxyUrl) };
  const child = spawn(process.execPath, [entryFile, ...(opts.args || [])], { env, stdio: "inherit" });
  return new Promise((resolve) => {
    child.on("exit", (code) => resolve(code == null ? 0 : code));
    child.on("error", () => resolve(1));
  });
}

// 启动时连通性检查(终端表格;不打印代理凭据)
export async function printMarketConnectivity(options) {
  const opts = options || {};
  const targets = [
    ["Binance", "https://fapi.binance.com/fapi/v1/time"],
    ["OKX", "https://www.okx.com/api/v5/public/time"],
    ["Bybit", "https://api.bybit.com/v5/market/time"]
  ];
  const { classifyNetworkError, describeFetchError } = await import("../worker/src/proxy.js");
  const doFetch = getMarketFetch();
  const results = [];
  for (const [name, url] of targets) {
    const t0 = Date.now();
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(opts.timeoutMs || 6000) });
      results.push({ name, ok: res.ok, status: res.status, ms: Date.now() - t0, error: null, code: null });
    } catch (error) {
      results.push({ name, ok: false, status: null, ms: Date.now() - t0, error: describeFetchError(error), code: classifyNetworkError(error) });
    }
  }
  console.log("\nMarket Connectivity (本地 Node 出口: " + (opts.proxy_method || "direct") + ")");
  console.log("Proxy     " + (opts.mode === "proxy" ? "enabled (" + (opts.proxyLabel || "configured") + ")" : "disabled (direct)"));
  for (const r of results) {
    const detail = r.ok ? r.status + " " + r.ms + "ms" : r.code + " " + r.ms + "ms" + (r.error ? " · " + String(r.error).slice(0, 80) : "");
    console.log(r.name.padEnd(9) + (r.ok ? "OK   " : "FAIL ") + detail);
  }
  const okCount = results.filter((r) => r.ok).length;
  if (okCount === 0) {
    console.log("\n本地 Node 无法连接任何行情源,请检查代理/VPN 是否对 Node 生效。");
    if (opts.mode !== "proxy") console.log("提示:设置 MARKET_PROXY_URL 或 HTTPS_PROXY 后重启本地服务器。");
  }
  return { mode: opts.mode || "direct", results, ok_count: okCount };
}

// 代理 URL 脱敏(仅用于展示)
export function maskProxy(url) {
  const u = normalizeProxyUrl(url);
  if (!u) return "(none)";
  try {
    const parsed = new URL(u);
    return parsed.protocol + "//" + (parsed.username ? "***@" : "") + parsed.host;
  } catch (error) {
    return "(none)";
  }
}
