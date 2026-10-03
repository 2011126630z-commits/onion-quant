// tools/diag-node-proxy.mjs · 探测 Node 版本能力 + 验证代理兜底实现
import { supportsNativeEnvProxy, parseNodeVersion, detectProxy, maskProxy } from "./net-proxy.mjs";
import { createProxyFetch, tryInstallUndiciProxy } from "./proxy-fetch.mjs";

console.log("node " + process.versions.node + " parsed=" + JSON.stringify(parseNodeVersion(process.versions.node)));
console.log("allowedFlag --use-env-proxy: " + process.allowedNodeEnvironmentFlags.has("--use-env-proxy"));
console.log("supportsNativeEnvProxy: " + supportsNativeEnvProxy());
console.log("fake versions: 20.11=" + supportsNativeEnvProxy({ node: "20.11.1" }, { has: () => false }) +
  " 22.16=" + supportsNativeEnvProxy({ node: "22.16.0" }, { has: () => false }) +
  " 23.9=" + supportsNativeEnvProxy({ node: "23.9.0" }, { has: () => false }) +
  " 24.0=" + supportsNativeEnvProxy({ node: "24.0.0" }, { has: () => false }));

const detected = detectProxy();
console.log("detected proxy: " + maskProxy(detected.url) + " (" + detected.source + ")");
if (!detected.url) {
  console.log("no proxy → skip fallback test");
  process.exit(0);
}
const undici = await tryInstallUndiciProxy(detected.url);
console.log("undici available: " + (undici ? undici.method : "no"));

const proxyFetch = createProxyFetch(detected.url, { timeoutMs: 8000 });
const targets = [
  ["Binance", "https://fapi.binance.com/fapi/v1/time"],
  ["OKX", "https://www.okx.com/api/v5/public/time"],
  ["Bybit", "https://api.bybit.com/v5/market/time"]
];
for (const [name, url] of targets) {
  const t0 = Date.now();
  try {
    const res = await proxyFetch(url);
    const body = await res.text();
    console.log(name + " CONNECT隧道 OK http=" + res.status + " t=" + (Date.now() - t0) + "ms body=" + body.slice(0, 40));
  } catch (error) {
    console.log(name + " CONNECT隧道 FAIL t=" + (Date.now() - t0) + "ms " + (error && error.message));
  }
}
