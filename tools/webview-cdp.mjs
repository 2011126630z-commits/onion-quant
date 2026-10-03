// tools/webview-cdp.mjs · 真机 WebView 自动化通道(adb forward + Chrome DevTools Protocol)
// 用途:读取/驱动 App 页面与服务里的 Runtime 页面(真机脚本化验收:泄漏计数、状态一致性、压力循环)。
// 前置:debug 构建(WebView 调试开关只在 debug 构建开启,release 不生效);无需第三方依赖(Node ≥22 自带 WebSocket/fetch)。
import { execFileSync } from "node:child_process";
import path from "node:path";

const ADB = path.join(process.env.LOCALAPPDATA || "", "Android", "Sdk", "platform-tools", "adb.exe");
const SERIAL = process.env.ANDROID_SERIAL || "10AG1T2NH8004N9";
const PKG = "com.quantmonitor.paper";
const PORT = Number(process.env.CDP_PORT || 9223);

export function adb(args, timeoutMs) {
  return execFileSync(ADB, ["-s", SERIAL, ...args], { encoding: "utf8", timeout: timeoutMs || 120000 });
}
export function adbTry(args, timeoutMs) {
  try { return adb(args, timeoutMs); } catch (error) { return String((error && error.stdout) || (error && error.message) || ""); }
}
export function pkgPid() {
  return String(adbTry(["shell", "pidof", PKG])).trim().split(/\s+/)[0] || "";
}
// 从设备 /proc/net/unix 里发现真实的 devtools socket 名(不同进程/多 WebView 时 pid 会变,不能靠猜)
export function devtoolsSocket() {
  const out = adbTry(["shell", "cat /proc/net/unix | grep -i devtools"]);
  const m = out.match(/@(webview_devtools_remote_\d+)/);
  if (!m) throw new Error("no_webview_devtools_socket(app_not_running_or_debug_disabled)");
  return m[1];
}
export function ensureForward() {
  const sock = devtoolsSocket();
  adbTry(["forward", "--remove", "tcp:" + PORT]);
  const fwd = adbTry(["forward", "tcp:" + PORT, "localabstract:" + sock], 30000);
  if (/error|cannot/i.test(fwd) && !/not found/.test(fwd)) throw new Error("forward_failed:" + fwd.trim());
  return sock;
}
export async function listTargets() {
  const sock = ensureForward();
  const res = await fetch("http://127.0.0.1:" + PORT + "/json", { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error("devtools_http_" + res.status + "(socket=" + sock + ")");
  return await res.json();
}
function wsEval(wsUrl, expression, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    const timer = setTimeout(() => { try { ws.close(); } catch (error) { /* */ } reject(new Error("cdp_timeout")); }, timeoutMs || 30000);
    ws.onopen = () => ws.send(JSON.stringify({
      id, method: "Runtime.evaluate",
      params: { expression, returnByValue: true, awaitPromise: true }
    }));
    ws.onerror = () => { clearTimeout(timer); reject(new Error("cdp_ws_error")); };
    ws.onmessage = (event) => {
      let msg = null;
      try { msg = JSON.parse(event.data); } catch (error) { return; }
      if (!msg || msg.id !== id) return;
      clearTimeout(timer);
      try { ws.close(); } catch (error) { /* */ }
      if (msg.error) { reject(new Error("cdp_error:" + JSON.stringify(msg.error))); return; }
      const r = msg.result || {};
      if (r.exceptionDetails) { reject(new Error("page_exception:" + JSON.stringify(r.exceptionDetails).slice(0, 300))); return; }
      resolve(r.result ? r.result.value : null);
    };
  });
}
export async function evalInUI(expression, timeoutMs) {
  const targets = await listTargets();
  const target = targets.find((t) => !String(t.url || "").includes("runtime.html"));
  if (!target) throw new Error("ui_target_not_found; targets=" + targets.map((t) => t.url).join(" , "));
  return await wsEval(target.webSocketDebuggerUrl, expression, timeoutMs);
}
export async function evalInRuntime(expression, timeoutMs) {
  const targets = await listTargets();
  const target = targets.find((t) => String(t.url || "").includes("runtime.html"));
  if (!target) throw new Error("runtime_target_not_found; targets=" + targets.map((t) => t.url).join(" , "));
  return await wsEval(target.webSocketDebuggerUrl, expression, timeoutMs);
}

const isMain = process.argv[1] && /webview-cdp\.mjs$/.test(process.argv[1]);
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "list") {
    const targets = await listTargets();
    console.log(JSON.stringify(targets.map((t) => ({ id: t.id, title: t.title, url: t.url })), null, 2));
  } else if (cmd === "eval-ui") {
    console.log(JSON.stringify(await evalInUI(rest.join(" "), Number(process.env.CDP_TIMEOUT || 30000)), null, 2));
  } else if (cmd === "eval-rt") {
    console.log(JSON.stringify(await evalInRuntime(rest.join(" "), Number(process.env.CDP_TIMEOUT || 30000)), null, 2));
  } else {
    console.log("usage: node tools/webview-cdp.mjs list | eval-ui <expr> | eval-rt <expr>");
    process.exit(2);
  }
}
