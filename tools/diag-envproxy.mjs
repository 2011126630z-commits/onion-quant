// tools/diag-envproxy.mjs · 验证 NODE_USE_ENV_PROXY / 环境变量传递
import { spawnSync } from "node:child_process";

const PROXY = process.argv[2] || process.env.MARKET_PROXY_URL || "http://127.0.0.1:17891";
const baseEnv = { ...process.env, NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY, NO_PROXY: "localhost,127.0.0.1" };

console.log("A. spawn -e 子进程能否看到变量:");
const r1 = spawnSync(process.execPath, ["-e", "console.log('flag=' + process.env.NODE_USE_ENV_PROXY + ' https=' + Boolean(process.env.HTTPS_PROXY))"], { env: baseEnv, encoding: "utf8" });
console.log("   " + (r1.stdout || "").trim() + (r1.stderr ? " [stderr] " + r1.stderr.trim().slice(0, 120) : ""));

console.log("B. 子进程内实际 fetch(env proxy 是否生效):");
const code = "const t0=Date.now();try{const r=await fetch('https://fapi.binance.com/fapi/v1/time',{signal:AbortSignal.timeout(8000)});console.log('fetch OK http='+r.status+' t='+(Date.now()-t0)+'ms');}catch(e){console.log('fetch FAIL '+((e.cause&&e.cause.code)||e.message)+' t='+(Date.now()-t0)+'ms');}";
const r2 = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: baseEnv, encoding: "utf8" });
console.log("   " + (r2.stdout || "").trim() + (r2.stderr ? " [stderr] " + r2.stderr.trim().slice(0, 200) : ""));

console.log("C. stdio:inherit 子进程变量:");
const r3 = spawnSync(process.execPath, ["-e", "console.log('viaInherit flag=' + process.env.NODE_USE_ENV_PROXY + ' https=' + Boolean(process.env.HTTPS_PROXY))"], { env: baseEnv, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
console.log("   " + (r3.stdout || "").trim());

console.log("D. 当前进程环境残留:");
console.log("   NODE_USE_ENV_PROXY=" + (process.env.NODE_USE_ENV_PROXY || "(unset)") + " HTTPS_PROXY=" + (process.env.HTTPS_PROXY ? "set" : "(unset)"));
