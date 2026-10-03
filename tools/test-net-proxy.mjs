// tools/test-net-proxy.mjs
// 网络出口与代理支持测试(核心用例全部本地化,不依赖公网;真实公网探测见 tools/diag-net.mjs)
// 覆盖:
//  1 Direct 模式  2 Proxy 模式  3 NO_PROXY localhost  5 fetch failed 展开 cause.code
//  6 Cloudflare runtime 不加载 Node-only 模块  7 Node 本地可加载代理支持
//  8 Node 版本能力表 + 旧 Node 兜底路径
//  9 本地 mock 代理:CONNECT 成功 / 拒绝 / 卡住超时 / AbortSignal 预算 / socket 清理
// 10 统一出口:启动连通性检查、/api/health 探测、真实行情请求共用 getMarketFetch
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { detectProxy, buildProxyEnv, needsReexec, noProxyList, normalizeProxyUrl, maskProxy, readWindowsSystemProxy, supportsNativeEnvProxy, parseNodeVersion, NATIVE_ENV_PROXY_REQUIREMENTS, NATIVE_ENV_PROXY_MIN_TEXT, getMarketFetch, printMarketConnectivity } from "./net-proxy.mjs";
import { createProxyFetch, parseProxyUrl } from "./proxy-fetch.mjs";
import { classifyNetworkError, describeFetchError, __assertUpstreamForTest } from "../worker/src/proxy.js";
import worker from "../worker/index.js";
import { __resetMarketHealthForTest } from "../worker/index.js";

const ROOT = path.resolve(import.meta.dirname, "..");
let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log("PASS  " + name); }
  else { failed += 1; console.log("FAIL  " + name + (detail ? "  => " + detail : "")); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}

console.log("== 1. Direct 模式 ==");
const directEnv = { __QUANT_SKIP_SYSTEM_PROXY: "1" };
eq("无代理时可判定为直连", detectProxy(directEnv).url, null);
eq("直连来源标记", detectProxy(directEnv).source, "none");
eq("无代理时不触发重启", needsReexec(null, directEnv), false);
eq("代理 URL 归一化(http 前缀)", normalizeProxyUrl("127.0.0.1:7890"), "http://127.0.0.1:7890");
eq("非法代理 URL 被拒绝", normalizeProxyUrl("file:///etc/passwd"), null);
eq("空值被拒绝", normalizeProxyUrl(""), null);

console.log("== 2. Proxy 模式 ==");
const testProxy = "http://127.0.0.1:17891";
const envP = buildProxyEnv(testProxy, directEnv);
eq("设置 NODE_USE_ENV_PROXY", envP.NODE_USE_ENV_PROXY, "1");
eq("设置 HTTPS_PROXY", envP.HTTPS_PROXY, testProxy);
eq("设置 HTTP_PROXY", envP.HTTP_PROXY, testProxy);
eq("同时保留 MARKET_PROXY_URL(不被运行时吞掉)", envP.MARKET_PROXY_URL, testProxy);
check("标记为代理模式", envP.__QUANT_NET_MODE === "proxy");
check("防重复重启标记", envP.__QUANT_PROXY_REEXEC === "1");
check("未带代理环境 → 需要重启", needsReexec(testProxy, directEnv) === true);
eq("MARKET_PROXY_URL 优先于系统代理", detectProxy({ MARKET_PROXY_URL: "http://p.example:8080", __QUANT_SKIP_SYSTEM_PROXY: "1" }).source, "MARKET_PROXY_URL");
eq("HTTPS_PROXY 优先级次之", detectProxy({ HTTPS_PROXY: "http://h.example:8080", __QUANT_SKIP_SYSTEM_PROXY: "1" }).source, "HTTPS_PROXY");
check("maskProxy 不泄露凭据", !/secret/.test(maskProxy("http://user:secret@127.0.0.1:8080")) && /127\.0\.0\.1:8080/.test(maskProxy("http://user:secret@127.0.0.1:8080")));
const devSrc = fs.readFileSync(path.join(ROOT, "dev-server.mjs"), "utf8");
check("dev-server 重启时携带代理 URL", /reexecWithProxy\(entry, detected\.url\)/.test(devSrc), "缺少 detected.url");

console.log("== 3. NO_PROXY localhost 生效 ==");
const list = noProxyList(["localhost", "127.0.0.1", "::1"]);
check("包含 localhost / 127.0.0.1 / ::1", list.includes("localhost") && list.includes("127.0.0.1") && list.includes("::1"), JSON.stringify(list));
check("代理环境下 NO_PROXY 已写入", /localhost/.test(envP.NO_PROXY) && /127\.0\.0\.1/.test(envP.NO_PROXY), envP.NO_PROXY);

console.log("== 5. fetch failed 展开 cause.code(构造,不依赖公网) ==");
eq("DNS 分类(ENOTFOUND)", classifyNetworkError({ message: "fetch failed", cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND x" } }), "DNS_ERROR");
eq("嵌套 cause(EAI_AGAIN)", classifyNetworkError({ message: "fetch failed", cause: { code: "ENOTFOUND", cause: { code: "EAI_AGAIN" } } }), "DNS_ERROR");
eq("连接超时", classifyNetworkError({ message: "fetch failed", cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }), "CONNECT_TIMEOUT");
eq("连接被拒", classifyNetworkError({ message: "fetch failed", cause: { code: "ECONNREFUSED" } }), "ECONNREFUSED");
eq("代理错误", classifyNetworkError(new Error("tunnel connection failed: proxy error")), "PROXY_ERROR");
eq("HTTP 403 归因", classifyNetworkError(new Error("upstream HTTP_403")), "HTTP_403");
eq("HTTP 451 归因", classifyNetworkError(new Error("upstream HTTP_451")), "HTTP_451");
check("describeFetchError 含 cause 码", /ENOTFOUND/.test(describeFetchError({ message: "fetch failed", cause: { code: "ENOTFOUND" } })));

console.log("== 6. Cloudflare runtime 不加载 Node-only 模块 ==");
const bundle = fs.readFileSync(path.join(ROOT, "worker", "index.js"), "utf8");
for (const needle of ["node:child_process", "execSync", "spawnSync", "NODE_USE_ENV_PROXY", "installProxyDispatcher", "createRequire"]) {
  check("产物不含 Node-only 代码: " + needle, !bundle.includes(needle));
}
const srcFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".js")) srcFiles.push(full);
  }
})(path.join(ROOT, "worker", "src"));
eq("worker/src 无 node: 内置模块导入", srcFiles.filter((f) => /from\s+["']node:/.test(fs.readFileSync(f, "utf8"))).map((f) => path.basename(f)), []);
check("worker/src 无 require()", srcFiles.every((f) => !/\brequire\(/.test(fs.readFileSync(f, "utf8"))));

console.log("== 7. Node 本地可加载代理支持 ==");
check("net-proxy 可加载", typeof detectProxy({ ...process.env, __QUANT_SKIP_SYSTEM_PROXY: "1" }).source === "string");
const sysProxy = readWindowsSystemProxy();
check("Windows 系统代理读取可用(可能为空)", sysProxy === null || /^https?:\/\//.test(sysProxy), String(sysProxy ? maskProxy(sysProxy) : null));
check("无硬编码代理端口", !/7890|7897|10809/.test(devSrc) && !/7890|7897|10809/.test(fs.readFileSync(path.join(ROOT, "tools", "net-proxy.mjs"), "utf8")));

console.log("== 8. Node 版本能力表 + 兜底 ==");
const nodeVersion = process.versions.node;
const nativeSupported = supportsNativeEnvProxy();
console.log("   当前 Node " + nodeVersion + " · native env proxy " + (nativeSupported ? "supported" : "unsupported") + " · 要求 " + NATIVE_ENV_PROXY_MIN_TEXT);
eq("要求文案为分支说明", NATIVE_ENV_PROXY_REQUIREMENTS.length, 2);
eq("版本解析", parseNodeVersion("v22.21.0"), { major: 22, minor: 21, patch: 0 });
eq("22.16.0 → false", supportsNativeEnvProxy({ node: "22.16.0" }, { has: () => false }), false);
eq("22.20.9 → false", supportsNativeEnvProxy({ node: "22.20.9" }, { has: () => false }), false);
eq("22.21.0 → true", supportsNativeEnvProxy({ node: "22.21.0" }, { has: () => false }), true);
eq("22.23.4 → true", supportsNativeEnvProxy({ node: "22.23.4" }, { has: () => false }), true);
eq("24.0.0 → false", supportsNativeEnvProxy({ node: "24.0.0" }, { has: () => false }), false);
eq("24.4.1 → false", supportsNativeEnvProxy({ node: "24.4.1" }, { has: () => false }), false);
eq("24.5.0 → true", supportsNativeEnvProxy({ node: "24.5.0" }, { has: () => false }), true);
eq("24.20.0 → true", supportsNativeEnvProxy({ node: "24.20.0" }, { has: () => false }), true);
eq("25.0.0 → true", supportsNativeEnvProxy({ node: "25.0.0" }, { has: () => false }), true);
eq("20.11.1 → false", supportsNativeEnvProxy({ node: "20.11.1" }, { has: () => false }), false);
eq("运行时 flag 优先(即便版本表说不支持)", supportsNativeEnvProxy({ node: "22.16.0" }, { has: (f) => f === "--use-env-proxy" }), true);
check("本机判定与运行时 flag 一致", nativeSupported === process.allowedNodeEnvironmentFlags.has("--use-env-proxy"), String(nativeSupported));

console.log("== 9. 本地 mock 代理(CONNECT / 拒绝 / 卡住 / AbortSignal / 清理) ==");
// 目标服务(本地 fixture:仅用于验证隧道机制)
const targetServer = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, path: req.url }));
});
await new Promise((r) => targetServer.listen(0, "127.0.0.1", r));
const targetPort = targetServer.address().port;

function startMockProxy(behavior) {
  const stats = { conns: 0, live: 0, connects: 0 };
  const sockets = new Set();
  const server = net.createServer((socket) => {
    stats.conns += 1;
    stats.live += 1;
    sockets.add(socket);
    let buf = "";
    let handled = false;
    socket.on("close", () => { stats.live -= 1; sockets.delete(socket); });
    socket.on("data", (chunk) => {
      if (handled) return; // CONNECT 只处理一次,后续数据由 pipe 转发
      buf += chunk.toString("latin1");
      if (!buf.includes("\r\n\r\n")) return;
      handled = true;
      const line = buf.split("\r\n")[0];
      const m = /^CONNECT ([^:]+):(\d+)/.exec(line);
      stats.connects += 1;
      if (behavior === "deny") { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
      if (behavior === "stall") return; // 接受连接但不响应
      if (!m) { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
      const upstream = net.connect({ host: m[1], port: Number(m[2]) });
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.pipe(upstream);
      upstream.pipe(socket);
      upstream.on("error", () => socket.destroy());
    });
    socket.on("error", () => { /* 忽略测试中的重置 */ });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, stats, sockets }));
  });
}

// 9.1 HTTP 代理 CONNECT 正常
const good = await startMockProxy("tunnel");
const goodFetch = createProxyFetch("http://127.0.0.1:" + good.port, { timeoutMs: 5000 });
const goodRes = await goodFetch("http://127.0.0.1:" + targetPort + "/probe");
const goodBody = await goodRes.json();
check("HTTP 代理 CONNECT 隧道可用", goodRes.status === 200 && goodBody.ok === true, JSON.stringify(goodBody));
check("mock 代理确实收到 CONNECT", good.stats.connects === 1, String(good.stats.connects));

// 9.2 拒绝 CONNECT
const deny = await startMockProxy("deny");
const denyFetch = createProxyFetch("http://127.0.0.1:" + deny.port, { timeoutMs: 5000 });
const denyMsg = await denyFetch("http://127.0.0.1:" + targetPort + "/x").then(() => "no-error").catch((e) => String(e.message || e));
check("拒绝 CONNECT → 明确错误", /CONNECT failed: .*403/.test(denyMsg), denyMsg.slice(0, 90));

// 9.3 代理卡住 + 外层 AbortSignal 250ms(不得等内部 12s)
const stall = await startMockProxy("stall");
const stallFetch = createProxyFetch("http://127.0.0.1:" + stall.port, { timeoutMs: 12000 });
const t1 = Date.now();
const abortMsg = await stallFetch("http://127.0.0.1:" + targetPort + "/slow", { signal: AbortSignal.timeout(250) }).then(() => "no-error").catch((e) => String(e.message || e));
const abortMs = Date.now() - t1;
check("AbortSignal 250ms 生效(不等内部 12s)", abortMs < 1200, abortMs + "ms · " + abortMsg.slice(0, 60));
check("abort 错误可识别", /abort/i.test(abortMsg), abortMsg.slice(0, 60));
await new Promise((r) => setTimeout(r, 300));
eq("abort 后无残留连接(socket 已销毁)", stall.stats.live, 0, String(stall.stats.live));
eq("abort 后无重连", stall.stats.conns, 1, String(stall.stats.conns));

// 9.4 内部兜底超时(无 signal 时也不无限等待)
const t2 = Date.now();
const timeoutMsg = await createProxyFetch("http://127.0.0.1:" + stall.port, { timeoutMs: 400 })("http://127.0.0.1:" + targetPort + "/x").then(() => "no-error").catch((e) => String(e.message || e));
const timeoutMs = Date.now() - t2;
check("内部兜底超时生效", timeoutMs < 1500 && /timeout/i.test(timeoutMsg), timeoutMs + "ms · " + timeoutMsg.slice(0, 60));

// 9.5 代理不可达
const deadMsg = await createProxyFetch("http://127.0.0.1:1", { timeoutMs: 2000 })("http://127.0.0.1:" + targetPort + "/x").then(() => "no-error").catch((e) => String(e.message || e));
check("代理不可达 → 明确失败(不静默直连)", /ECONNREFUSED|timeout|closed/i.test(deadMsg), deadMsg.slice(0, 80));

// 9.6 https:// 代理:必须真的与代理做 TLS,不得静默当普通 TCP
const tlsProxyFetch = createProxyFetch("https://127.0.0.1:" + good.port, { timeoutMs: 2000 });
const tlsProxyMsg = await tlsProxyFetch("http://127.0.0.1:" + targetPort + "/x").then(() => "no-error").catch((e) => String(e.message || e));
check("https 代理走 TLS 到代理(明文端口会失败而非伪装成功)", tlsProxyMsg !== "no-error" && !/CONNECT failed/.test(tlsProxyMsg), tlsProxyMsg.slice(0, 90));
eq("proxy 协议解析保留 https", parseProxyUrl("https://127.0.0.1:8443").protocol, "https:");
const badScheme = (() => { try { parseProxyUrl("socks5://127.0.0.1:1080"); return "no-throw"; } catch (e) { return "threw"; } })();
eq("非 http(s) 代理协议被拒绝", badScheme, "threw");

good.server.close();
deny.server.close();
stall.server.close();
await new Promise((r) => targetServer.close(r));

console.log("== 10. 统一出口(启动检查 / health 探测 / 行情请求共用) ==");
eq("getMarketFetch 返回可调用出口", typeof getMarketFetch(), "function");
let stubCalls = [];
globalThis.__MARKET_FETCH = async (target) => {
  stubCalls.push(String(target));
  return new Response(JSON.stringify({ serverTime: 1 }), { status: 200, headers: { "content-type": "application/json" } });
};
check("注入后 getMarketFetch 返回注入实现", getMarketFetch() !== fetch);
// 10.1 启动连通性检查走统一出口(必须是 stub,不能打公网)
stubCalls = [];
const probeResult = await printMarketConnectivity({ mode: "proxy", proxyLabel: "stub", timeoutMs: 500 });
check("启动连通性检查使用 __MARKET_FETCH", stubCalls.length === 3, JSON.stringify(stubCalls));
eq("连通性检查统计到 3 个成功", probeResult.ok_count, 3);
// 10.2 /api/health?probe=1 与真实行情请求走同一出口
__resetMarketHealthForTest();
stubCalls = [];
const healthRes = await worker.fetch(new Request("https://app.local/api/health?probe=1"));
const healthBody = await healthRes.json();
check("health 探测使用同一出口", stubCalls.length >= 3 && stubCalls.every((u) => /fapi\.binance\.com|okx|bybit/.test(u)), JSON.stringify(stubCalls.slice(0, 4)));
check("health 返回 node_version / proxy_method 字段", typeof healthBody.node_version !== "undefined" && typeof healthBody.proxy_method === "string", JSON.stringify({ v: healthBody.node_version, m: healthBody.proxy_method }));
// 行情请求:stub 返回 klines 数组
stubCalls = [];
globalThis.__MARKET_FETCH = async (target) => {
  stubCalls.push(String(target));
  const rows = [];
  for (let i = 0; i < 220; i += 1) {
    const t = 1700000000000 + i * 3600000;
    rows.push([t, "100", "101", "99", "100.5", "1000", t + 3599999]);
  }
  return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
};
const kRes = await worker.fetch(new Request("https://app.local/api/klines?market=futures&symbol=BTCUSDT&interval=1h&limit=200"));
const kBody = await kRes.json();
check("行情请求使用同一出口", stubCalls.length >= 1 && kBody.length === 220 && stubCalls[0].includes("symbol=BTCUSDT"), JSON.stringify({ calls: stubCalls.length, bars: Array.isArray(kBody) ? kBody.length : null, url: stubCalls[0] && stubCalls[0].slice(0, 90) }));
check("响应头带 x-provider 诊断", Boolean(kRes.headers.get("x-provider")), String(kRes.headers.get("x-provider")));
delete globalThis.__MARKET_FETCH;
__resetMarketHealthForTest();

console.log("== 附加:出站白名单(SSRF 防护) ==");
for (const [target, label] of [
  ["http://localhost/x", "拒绝 localhost"],
  ["http://127.0.0.1:8793/api/health", "拒绝环回地址"],
  ["http://162.0.0.1/x", "拒绝私有网段"],
  ["file:///C:/Windows/win.ini", "拒绝 file 协议"],
  ["http://evil.example.com/x", "拒绝非白名单域名"]
]) {
  const r = __assertUpstreamForTest(target);
  check(label, r.ok === false && /not allowed|scheme/.test(r.error || ""), JSON.stringify(r));
}
check("白名单内域名放行", __assertUpstreamForTest("https://fapi.binance.com/fapi/v1/time").ok === true);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("NET PROXY TESTS OK");
