// tools/diag-proxy.mjs · 诊断系统代理读取与代理连通性
import { execSync } from "node:child_process";
import { detectProxy, readWindowsSystemProxy, installProxyDispatcher } from "./net-proxy.mjs";

const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
for (const v of ["ProxyEnable", "ProxyServer", "AutoConfigURL"]) {
  try {
    const out = execSync('reg query "' + key + '" /v ' + v, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000 });
    console.log(v + ": " + JSON.stringify(out.trim()));
  } catch (error) {
    console.log(v + ": (读取失败) " + String(error.message).slice(0, 80));
  }
}
console.log("readWindowsSystemProxy:", JSON.stringify(readWindowsSystemProxy()));
console.log("detectProxy:", JSON.stringify(detectProxy()));

const info = await installProxyDispatcher();
console.log("install:", JSON.stringify({ installed: info.installed, mode: info.mode, source: info.source, proxy: info.proxy, reason: info.reason }));

if (info.installed) {
  const t0 = Date.now();
  try {
    const res = await fetch("https://fapi.binance.com/fapi/v1/time", { signal: AbortSignal.timeout(8000) });
    const body = await res.text();
    console.log("binance via proxy:", res.status, Date.now() - t0 + "ms", body.slice(0, 80));
  } catch (error) {
    console.log("binance via proxy FAILED:", Date.now() - t0 + "ms", error.message, error.cause ? "[cause " + error.cause.code + "]" : "");
  }
  try {
    const res = await fetch("https://www.okx.com/api/v5/public/time", { signal: AbortSignal.timeout(8000) });
    console.log("okx via proxy:", res.status, (await res.text()).slice(0, 60));
  } catch (error) {
    console.log("okx via proxy FAILED:", error.message, error.cause ? "[cause " + error.cause.code + "]" : "");
  }
  try {
    const res = await fetch("https://api.bybit.com/v5/market/time", { signal: AbortSignal.timeout(8000) });
    console.log("bybit via proxy:", res.status, (await res.text()).slice(0, 60));
  } catch (error) {
    console.log("bybit via proxy FAILED:", error.message, error.cause ? "[cause " + error.cause.code + "]" : "");
  }
  // NO_PROXY 生效验证:本地地址应直连(不走代理)
  const t1 = Date.now();
  try {
    const res = await fetch("http://127.0.0.1:8793/api/health", { signal: AbortSignal.timeout(4000) });
    console.log("localhost via NO_PROXY:", res.status, Date.now() - t1 + "ms");
  } catch (error) {
    console.log("localhost via NO_PROXY FAILED:", error.message);
  }
}
