// tools/diag-net.mjs · 真实网络链路诊断(curl vs Node fetch vs 代理出口)
// 不打印任何代理凭据(只输出脱敏 host)
import { execSync, spawnSync } from "node:child_process";
import { detectProxy, maskProxy, buildProxyEnv, readWindowsSystemProxy } from "./net-proxy.mjs";
import { classifyNetworkError, describeFetchError } from "../worker/src/proxy.js";

const TARGETS = [
  ["Binance ", "https://fapi.binance.com/fapi/v1/time"],
  ["Binance1", "https://fapi1.binance.com/fapi/v1/time"],
  ["OKX     ", "https://www.okx.com/api/v5/public/time"],
  ["Bybit   ", "https://api.bybit.com/v5/market/time"]
];

console.log("=== 1. 运行环境 ===");
console.log("node " + process.version + " · platform " + process.platform);
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "MARKET_PROXY_URL", "NODE_USE_ENV_PROXY"]) {
  const v = process.env[k];
  console.log(k.padEnd(18) + (v ? maskProxy(v) + " (len " + String(v).length + ")" : "(unset)"));
}

console.log("\n=== 2. Windows 系统代理 / WinHTTP ===");
try {
  const out = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable', { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  console.log("ProxyEnable: " + (/0x1/.test(out) ? "1(启用)" : "0(未启用)"));
} catch (e) { console.log("ProxyEnable: 读取失败"); }
console.log("系统代理(注册表): " + maskProxy(readWindowsSystemProxy()));
try {
  const ac = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v AutoConfigURL', { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const m = ac.match(/AutoConfigURL\s+REG_SZ\s+(.+)/i);
  console.log("自动配置脚本(PAC): " + (m ? maskProxy(m[1]) : "(未设置)"));
} catch (e) { console.log("自动配置脚本(PAC): (未设置)"); }
try {
  const wh = execSync("netsh winhttp show proxy", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const line = wh.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).filter((s) => !/^InternetProxyServer|^WinHTTP/i.test(s));
  console.log("WinHTTP: " + (line.join(" ") || "(未设置)").slice(0, 90));
} catch (e) { console.log("WinHTTP: 读取失败"); }
const detected = detectProxy();
console.log("本项目探测: " + (detected.url ? maskProxy(detected.url) + " (来源 " + detected.source + ")" : "无代理"));

console.log("\n=== 3. curl 访问(系统出口) ===");
for (const [name, url] of TARGETS) {
  const r = spawnSync("curl", ["-s", "-o", "NUL", "-m", "8", "-w", "%{http_code} %{time_total}", url], { encoding: "utf8" });
  const out = (r.stdout || "").trim() || "000 0";
  const [code, time] = out.split(" ");
  console.log(name + " http=" + code + " t=" + time + "s" + (code === "000" ? " (连接失败)" : ""));
}

console.log("\n=== 4. Node fetch(直连,当前进程环境) ===");
for (const [name, url] of TARGETS) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    console.log(name + " OK http=" + res.status + " t=" + (Date.now() - t0) + "ms");
  } catch (error) {
    console.log(name + " FAIL " + classifyNetworkError(error) + " t=" + (Date.now() - t0) + "ms · " + describeFetchError(error));
  }
}

console.log("\n=== 5. Node fetch(经检测到的代理出口) ===");
if (!detected.url) {
  console.log("未检测到代理,跳过");
} else {
  const inline = [
    'import { classifyNetworkError, describeFetchError } from ' + JSON.stringify(new URL("../worker/src/proxy.js", import.meta.url).href) + ";",
    "const targets = " + JSON.stringify(TARGETS) + ";",
    'console.log("child NODE_USE_ENV_PROXY=" + process.env.NODE_USE_ENV_PROXY + " HTTPS_PROXY_set=" + Boolean(process.env.HTTPS_PROXY));',
    "for (const [name, url] of targets) {",
    "  const t0 = Date.now();",
    "  try {",
    "    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });",
    '    console.log(name + " OK http=" + res.status + " t=" + (Date.now() - t0) + "ms");',
    "  } catch (error) {",
    '    console.log(name + " FAIL " + classifyNetworkError(error) + " t=" + (Date.now() - t0) + "ms · " + describeFetchError(error));',
    "  }",
    "}"
  ].join("\n");
  const env = { ...process.env, ...buildProxyEnv(detected.url) };
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", inline], { encoding: "utf8", env, timeout: 60000 });
  console.log((r.stdout || "").trim() || "(无输出)");
  if (r.stderr && r.stderr.trim()) console.log("[stderr] " + r.stderr.trim().split(/\r?\n/).slice(0, 3).join(" | "));
}
