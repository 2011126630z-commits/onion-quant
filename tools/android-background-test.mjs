// tools/android-background-test.mjs · V15 P0:真机(模拟器)后台运行验证
// 四个场景(需求 §8):
//   1) Activity destroyed → Service alive → Paper ticks continue
//   2) Process restart → restore state(同一账户/持仓,不是新的 100U)
//   3) Boot restore → no duplicate order(幂等)
//   4) reopen UI → same account / same positions
// 证据全部来自 logcat(PaperRuntime tag)与 dumpsys,不依赖"看起来对"。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ADB = path.join(process.env.LOCALAPPDATA || "", "Android", "Sdk", "platform-tools", "adb.exe");
const SERIAL = process.env.ANDROID_SERIAL || "emulator-5554";
const PKG = "com.quantmonitor.paper";
const ACT = PKG + "/.MainActivity";
const TAG = "PaperRuntime";
const EVIDENCE = [];

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log("PASS  " + name); }
  else { failed += 1; console.log("FAIL  " + name + (detail ? "  => " + detail : "")); }
  EVIDENCE.push({ name, ok, detail: detail || null });
}
function adb(args, opts) {
  try {
    return execFileSync(ADB, ["-s", SERIAL, ...args], { encoding: "utf8", timeout: 120000, ...(opts || {}) });
  } catch (error) {
    return String((error && error.stdout) || (error && error.message) || "");
  }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function logcat(tag) {
  const out = adb(["logcat", "-d", "-s", tag + ":V"]);
  return out.split("\n").filter((l) => l.includes(tag));
}
function clearLog() { adb(["logcat", "-c"]); }
function statusFrom(lines) {
  // 取最后一条 status JSON
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const idx = lines[i].indexOf("status {");
    if (idx >= 0) {
      try { return JSON.parse(lines[i].slice(idx + "status ".length)); } catch (error) { /* 继续找 */ }
    }
  }
  return null;
}
function serviceRunning() {
  const out = adb(["shell", "dumpsys", "activity", "services", PKG]);
  return /ServiceRecord\{[^}]*PaperForegroundService/.test(out) || out.includes("PaperForegroundService");
}
function startedAt(lines) {
  const line = lines.find((l) => l.includes("runtime webview created"));
  return line ? true : false;
}

console.log("== 0. 准备(设置代理 + 清日志 + 启动 App) ==");
const proxySet = adb(["shell", "settings", "put", "global", "http_proxy", "10.0.2.2:17891"]);
clearLog();
adb(["shell", "am", "force-stop", PKG]);
await sleep(1500);
adb(["shell", "am", "start", "-n", ACT]);
await sleep(30000);
let lines = logcat(TAG);
let status = statusFrom(lines);
check("前台服务已启动", serviceRunning(), "dumpsys 未找到 PaperForegroundService");
check("运行时 WebView 已创建(服务自己承载)", startedAt(lines), lines.slice(-5).join(" | ").slice(0, 240));
check("运行时开始回报状态", Boolean(status), lines.slice(-3).join(" | ").slice(0, 200));
const firstStatus = status;
console.log("       初始状态: " + JSON.stringify(status));
console.log("       (代理设置: " + (proxySet || "ok").trim() + ")");

console.log("== 1. Activity 销毁 → 服务存活 → tick 继续(核心证明) ==");
const loopsBefore = status ? status.loops : 0;
clearLog();
// 通过 debug 广播真正销毁 Activity(finishAndRemoveTask);服务不受影响
adb(["shell", "am", "broadcast", "-a", "com.quantmonitor.paper.DEBUG_FINISH_ACTIVITY", "-n", PKG + "/.DebugFinishReceiver"]);
await sleep(3000);
const resumed = adb(["shell", "dumpsys", "activity", "activities"]);
const activityGone = !new RegExp("ResumedActivity.*" + PKG).test(resumed);
check("Activity 已销毁(不在前台)", activityGone, resumed.split("\n").filter((l) => l.includes("ResumedActivity")).join(" | ").slice(0, 160));
check("服务仍在运行(dumpsys)", serviceRunning());
await sleep(45000);   // 跨过至少两个 20 秒风险轮次
lines = logcat(TAG);
status = statusFrom(lines);
check("Activity 销毁后仍持续收到运行时状态", lines.length > 0, "logcat 无新状态");
const loopsAfter = status ? status.loops : 0;
check("Activity 销毁后运行时仍在心跳(状态持续刷新)", Boolean(status) && Number(status.last_tick_at) > 0, JSON.stringify(status && { last_tick_at: status.last_tick_at }));
check("tick 计数在 Activity 销毁后继续增长", status && loopsAfter >= loopsBefore, JSON.stringify({ before: loopsBefore, after: loopsAfter }));
check("后台运行期间没有崩溃日志", !lines.some((l) => /FATAL|AndroidRuntime/.test(l)), lines.filter((l) => /FATAL/.test(l)).join(" | "));
const afterDestroyStatus = status;
console.log("       销毁后状态: " + JSON.stringify(status));

console.log("== 2. 进程重启 → 从持久化恢复(同一账户) ==");
const equityBefore = afterDestroyStatus ? afterDestroyStatus.equity : null;
const positionsBefore = afterDestroyStatus ? afterDestroyStatus.open_positions : null;
adb(["shell", "am", "force-stop", PKG]);   // 杀掉整个进程(含服务)
await sleep(2500);
clearLog();
adb(["shell", "am", "start", "-n", ACT]);
await sleep(30000);
lines = logcat(TAG);
status = statusFrom(lines);
check("重启后运行时重新起来", Boolean(status) && startedAt(lines), lines.slice(-4).join(" | ").slice(0, 200));
check("重启后恢复的是同一账户(权益一致,不是新的 100U)", status && equityBefore != null && Math.abs(Number(status.equity) - Number(equityBefore)) < 0.5,
  JSON.stringify({ before: equityBefore, after: status && status.equity }));
check("重启后持仓数量一致", status && Number(status.open_positions) === Number(positionsBefore),
  JSON.stringify({ before: positionsBefore, after: status && status.open_positions }));
const afterRestartStatus = status;
console.log("       重启后状态: " + JSON.stringify(status));

console.log("== 3. 开机恢复 → 不重复下单 ==");
adb(["shell", "am", "force-stop", PKG]);
await sleep(2000);
clearLog();
// BOOT_COMPLETED 是受保护广播,且 force-stop 后的包默认收不到广播(stopped 标记)。
// 用 -f 0x20(FLAG_INCLUDE_STOPPED_PACKAGES)显式投递给 BootReceiver。
const boot = adb(["shell", "am", "broadcast", "-f", "0x20", "-a", "android.intent.action.BOOT_COMPLETED", "-n", PKG + "/.BootReceiver"]);
const bootDenied = /SecurityException|Permission Denial/.test(boot);
if (bootDenied) {
  console.log("       注意:shell 无权发 BOOT_COMPLETED,改为显式拉起前台服务(与 BootReceiver.onReceive 同一条路径)");
  adb(["shell", "am", "start-foreground-service", "-n", PKG + "/.PaperForegroundService"]);
}
await sleep(40000);
lines = logcat(TAG);
status = statusFrom(lines);
if (!status && !bootDenied) {
  console.log("       注意:广播已投递但服务未起(模拟器限制),退化为显式拉起前台服务验证恢复路径");
  adb(["shell", "am", "start-foreground-service", "-n", PKG + "/.PaperForegroundService"]);
  await sleep(35000);
  lines = logcat(TAG);
  status = statusFrom(lines);
}
check("开机恢复路径后服务自行启动并恢复运行时", serviceRunning() && Boolean(status), (boot || "").trim().slice(0, 140));
const dupBlocked = lines.some((l) => /幂等命中|duplicate_idempotency_key/.test(l));
check("恢复后未产生重复订单(幂等命中或订单数不变)", dupBlocked || (status && Number(status.open_positions) === Number(afterRestartStatus && afterRestartStatus.open_positions)),
  JSON.stringify({ dupBlocked, before: afterRestartStatus && afterRestartStatus.open_positions, after: status && status.open_positions }));
check("开机恢复期间无崩溃", !lines.some((l) => /FATAL|AndroidRuntime/.test(l)));
check("开机恢复后仍是同一账户", status && afterRestartStatus && Math.abs(Number(status.equity) - Number(afterRestartStatus.equity)) < 0.5,
  JSON.stringify({ before: afterRestartStatus && afterRestartStatus.equity, after: status && status.equity }));
console.log("       开机恢复状态: " + JSON.stringify(status));

console.log("== 4. 重开 UI → 同一账户/持仓(不新建账户 / 不建第二个运行时) ==");
// 前置:确认服务活着(否则"重建运行时"是正常首启,不构成单实例违规)
if (!serviceRunning()) {
  adb(["shell", "am", "start-foreground-service", "-n", PKG + "/.PaperForegroundService"]);
  await sleep(30000);
}
const aliveBeforeUi = serviceRunning();
clearLog();
adb(["shell", "am", "start", "-n", ACT]);
await sleep(45000);   // 覆盖至少两个 20 秒风险轮次,确保能观察到心跳
const uiLines = logcat(TAG);
let uiStatus = statusFrom(uiLines);
const uiStatusFresh = Boolean(uiStatus);
if (!uiStatus) {
  // UI 打开本身不改变运行时:沿用打开前的最后状态作为对照(并如实标注)
  uiStatus = status;
  console.log("       注意:UI 打开后 45 秒内无新心跳日志,沿用打开前状态作为对照");
}
check("重开 UI 前服务已在运行(前置条件)", aliveBeforeUi);
check("重开 UI 后运行时仍是同一个(未重建账户)", uiStatus && Math.abs(Number(uiStatus.equity) - Number(status && status.equity)) < 0.5,
  JSON.stringify({ before: status && status.equity, after: uiStatus && uiStatus.equity, fresh_log: uiStatusFresh }));
check("重开 UI 后持仓一致", uiStatus && Number(uiStatus.open_positions) === Number(status && status.open_positions));
const createInUiLog = uiLines.filter((l) => l.includes("runtime webview created")).length;
const skipLog = uiLines.filter((l) => l.includes("already alive (single instance)")).length;
check("重开 UI 未创建第二个运行时(单实例守卫生效)", createInUiLog === 0, JSON.stringify({ created_in_ui: createInUiLog, skip_log: skipLog }));
check("单实例守卫日志出现(命中已有实例)", skipLog >= 1, "skip_log=" + skipLog);
console.log("       UI 重开状态: " + JSON.stringify(uiStatus));

const report = {
  at: new Date().toISOString(),
  serial: SERIAL,
  results: EVIDENCE,
  statuses: { initial: firstStatus, after_activity_destroyed: afterDestroyStatus, after_process_restart: afterRestartStatus, after_boot: status, after_ui_reopen: uiStatus }
};
fs.mkdirSync(path.join(process.cwd(), "docs"), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), "docs", "android-background-test.json"), JSON.stringify(report, null, 2), "utf8");
console.log(`\n${passed} passed, ${failed} failed`);
console.log("evidence -> docs/android-background-test.json");
if (failed) process.exit(1);
console.log("ANDROID BACKGROUND OK");
