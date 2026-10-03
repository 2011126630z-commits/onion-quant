// tools/device-runtime-verify.mjs · V16.1-RV 真机运行时验收(adb 侧协议)
// 用法:
//   node tools/device-runtime-verify.mjs preflight
//   node tools/device-runtime-verify.mjs testA          # Activity 销毁 → Runtime 存活且 tick 严格增长
//   node tools/device-runtime-verify.mjs lock --seconds 180   # 锁屏档位(2-5m / 15-30m / 1-2h 靠 --seconds)
//   node tools/device-runtime-verify.mjs network        # 断网 → 恢复(降级禁新仓 / 不重复处理)
//   node tools/device-runtime-verify.mjs restart        # 进程重启 → 同一账户恢复、无重复订单
//   node tools/device-runtime-verify.mjs shots          # 系统状态页/RD-002 等真机截图
// 证据:docs/real-device/runtime-verification/runtime-verification-log.txt + rv-state.json + 截图
// 纪律:只在前台是我们 App 时才发 input;检测到用户切到其它 App → 该阶段中止并如实记录。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "docs", "real-device", "runtime-verification");
const LOG_PATH = path.join(OUT_DIR, "runtime-verification-log.txt");
const STATE_PATH = path.join(OUT_DIR, "rv-state.json");
const ADB = path.join(process.env.LOCALAPPDATA || "", "Android", "Sdk", "platform-tools", "adb.exe");
const SERIAL = process.env.ANDROID_SERIAL || "10AG1T2NH8004N9";
const PKG = "com.quantmonitor.paper";

let failed = 0;
let passed = 0;
const results = [];
fs.mkdirSync(OUT_DIR, { recursive: true });
function logLine(line) {
  const stamped = "[" + new Date().toISOString() + "] " + line;
  fs.appendFileSync(LOG_PATH, stamped + "\n", "utf8");
  console.log(stamped);
}
function check(name, ok, detail) {
  if (ok) { passed += 1; logLine("PASS  " + name); }
  else { failed += 1; logLine("FAIL  " + name + (detail ? "  => " + detail : "")); }
  results.push({ name, ok, detail: detail || null });
}
function note(name, value) { logLine("NOTE  " + name + ": " + value); results.push({ name, ok: null, detail: String(value) }); }
export function adb(args, timeoutMs) {
  return execFileSync(ADB, ["-s", SERIAL, ...args], { encoding: "utf8", timeout: timeoutMs || 120000 });
}
function adbTry(args, timeoutMs) {
  try { return adb(args, timeoutMs); } catch (error) { return String((error && error.stdout) || (error && error.message) || ""); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch (error) { return {}; } }
function saveState(patch) {
  const next = { ...loadState(), ...patch, at: Date.now() };
  fs.writeFileSync(STATE_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}
function foregroundIsApp() {
  const out = adbTry(["shell", "dumpsys activity activities | grep topResumedActivity"]);
  return out.includes(PKG);
}
function requireForeground(phase) {
  if (foregroundIsApp()) return true;
  const out = adbTry(["shell", "dumpsys activity activities | grep topResumedActivity"]).trim();
  logLine("STOP  " + phase + ": 前台不是我们的 App,按纪律不发送任何 input。当前: " + out);
  note(phase + "_aborted_foreground", out.slice(0, 160));
  return false;
}
function lastStatus() {
  const out = adbTry(["logcat", "-d", "-s", "PaperRuntime:V"], 30000);
  let status = null;
  for (const line of out.split("\n")) {
    const idx = line.indexOf("status {");
    if (idx >= 0) { try { status = JSON.parse(line.slice(idx + "status ".length)); } catch (error) { /* keep scanning */ } }
  }
  const created = out.split("\n").filter((l) => l.includes("runtime webview created")).length;
  const single = out.split("\n").filter((l) => l.includes("already alive (single instance)")).length;
  const stalls = out.split("\n").filter((l) => l.includes("RUNTIME_STALL")).length;
  const resumed = out.split("\n").filter((l) => l.includes("RUNTIME_RESUMED")).length;
  return { status, created, single, stalls, resumed };
}
async function waitForFreshStatus(secondsMax) {
  const t0 = Date.now();
  let best = null;
  while (Date.now() - t0 < secondsMax * 1000) {
    await sleep(15000);
    const parsed = lastStatus();
    if (parsed.status) {
      const fresh = parsed.status.updated_at && Date.now() - Number(parsed.status.updated_at) < 120000;
      if (fresh) return parsed;
      best = parsed;
    }
  }
  return best;
}
function screencap(name) {
  const remote = "/sdcard/" + name;
  adbTry(["shell", "screencap", "-p", remote], 60000);
  try {
    execFileSync(ADB, ["-s", SERIAL, "pull", remote, path.join(OUT_DIR, name)], { encoding: "utf8", timeout: 60000 });
    logLine("SHOT  " + name);
    return true;
  } catch (error) { logLine("SHOT-FAIL " + name); return false; }
}

const phase = (process.argv[2] || "").toLowerCase();
const args = process.argv.slice(3);
function argOf(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : dflt;
}

// ---------------- preflight ----------------
if (phase === "preflight") {
  logLine("===== V16.1-RV PREFLIGHT =====");
  const devices = adbTry(["devices", "-l"]).trim();
  note("adb_devices", devices.replace(/\n+/g, " | "));
  check("设备在线(device 状态)", devices.includes(SERIAL + "        device") || /device\b/.test(devices.split("\n").find((l) => l.includes(SERIAL)) || ""), devices);
  const model = adbTry(["shell", "getprop", "ro.product.model"]).trim();
  const android = adbTry(["shell", "getprop", "ro.build.version.release"]).trim() + " / API " + adbTry(["shell", "getprop", "ro.build.version.sdk"]).trim();
  const wmSize = adbTry(["shell", "wm", "size"]).trim().replace(/\n/g, " ");
  const wmDensity = adbTry(["shell", "wm", "density"]).trim().replace(/\n/g, " ");
  const navMode = adbTry(["shell", "settings", "get", "secure", "navigation_mode"]).trim();
  note("device_model", model);
  note("android", android);
  note("resolution_density", wmSize + " | " + wmDensity);
  note("navigation_mode", navMode + "(2=手势)");
  const battery = adbTry(["shell", "dumpsys", "battery"]).split("\n").filter((l) => /level|temperature|status/.test(l)).map((l) => l.trim()).join(" | ");
  note("battery", battery);
  const thermal = adbTry(["shell", "dumpsys", "thermalservice"]).split("\n").filter((l) => /Thermal Status|mStatus/.test(l)).slice(0, 3).map((l) => l.trim()).join(" | ") || adbTry(["shell", "cat", "/sys/class/thermal/thermal_zone0/temp"]).trim();
  note("thermal", thermal.slice(0, 200));
  const mem = adbTry(["shell", "dumpsys", "meminfo", PKG]).split("\n").filter((l) => /TOTAL PSS|TOTAL RSS|Java Heap|Native Heap/.test(l)).map((l) => l.trim()).slice(0, 6).join(" | ");
  note("meminfo_app", mem || "(App 未运行)");
  const storage = (adbTry(["shell", "df", "/data"]).split("\n").filter((l) => /\/data|\/|\d+%/.test(l)).slice(-1)[0] || "").trim();
  note("storage_data", storage || "(读取失败)");
  // 安装版本
  const pkgDump = adbTry(["shell", "dumpsys", "package", PKG]);
  const verName = (pkgDump.match(/versionName=([^\s]+)/) || [])[1] || "?";
  const verCode = (pkgDump.match(/versionCode=(\d+)/) || [])[1] || "?";
  note("installed_apk", "versionName=" + verName + " versionCode=" + verCode);
  // OEM 后台限制
  const idleWhite = adbTry(["shell", "dumpsys", "deviceidle", "whitelist"]).split("\n").filter((l) => l.includes(PKG)).join(" | ") || "not-whitelisted";
  note("battery_optimization", idleWhite + "(not-whitelisted ⇒ 系统可在 Doze 冻结网络/定时器,属 OS_RESTRICTED)");
  const bucket = adbTry(["shell", "am", "get-standby-bucket", PKG]).trim();
  note("standby_bucket", bucket + "(10=ACTIVE, 20=WORKING_SET, 30=FREQUENT, 40=RARE, 45=RESTRICTED)");
  const fg = adbTry(["shell", "dumpsys activity activities | grep topResumedActivity"]).trim();
  note("foreground", fg.slice(0, 160));
  const svc = adbTry(["shell", "dumpsys", "activity", "services", PKG]).includes("PaperForegroundService");
  check("前台服务在运行", svc, "dumpsys 未找到 PaperForegroundService");
  const parsed = lastStatus();
  check("运行时在回报状态(logcat PaperRuntime status)", Boolean(parsed.status), "最近无 status 行");
  if (parsed.status) {
    saveState({ baseline: parsed.status });
    note("runtime_status", JSON.stringify(parsed.status));
  }
  const notif = adbTry(["shell", "dumpsys", "notification", "--noredact"]).split("\n").filter((l) => l.includes(PKG) || l.includes("Paper 模拟运行中")).slice(0, 6).map((l) => l.trim()).join(" | ");
  check("前台服务常驻通知存在", /Paper 模拟运行中|paper_running/.test(notif), notif.slice(0, 160));
  logLine("PREFLIGHT done: " + passed + " passed, " + failed + " failed");
}

// ---------------- testA:Activity 销毁 → Runtime 存活 ----------------
if (phase === "testa") {
  logLine("===== V16.1-RV TEST A:Activity 销毁 → Runtime 存活且 tick 严格增长 =====");
  if (!requireForeground("testA")) process.exit(2);
  adbTry(["logcat", "-c"], 30000);
  const before = await waitForFreshStatus(90);
  check("拿到销毁前状态", Boolean(before && before.status), "logcat 无 status");
  saveState({ testA_before: before && before.status });
  adbTry(["shell", "am", "broadcast", "-a", PKG + ".DEBUG_FINISH_ACTIVITY", "-n", PKG + "/.DebugFinishReceiver"]);
  await sleep(4000);
  const resumed = adbTry(["shell", "dumpsys activity activities"]);
  check("Activity 已真正销毁(finishAndRemoveTask)", !new RegExp("ResumedActivity.*" + PKG).test(resumed), resumed.split("\n").filter((l) => l.includes("ResumedActivity")).join(" | ").slice(0, 140));
  await sleep(75000);   // 跨过 ≥3 个 20s 风控轮次
  const after = await waitForFreshStatus(120);
  check("销毁后仍持续收到运行时状态(服务承载)", Boolean(after && after.status), "无新 status");
  const b = before && before.status;
  const a = after && after.status;
  if (b && a) {
    check("instance_id 不变(同一个 Runtime)", a.instance_id === b.instance_id, JSON.stringify({ before: b.instance_id, after: a.instance_id }));
    check("market_fetches 严格增长(> 而不是 >=)", Number(a.market_fetches) > Number(b.market_fetches), JSON.stringify({ before: b.market_fetches, after: a.market_fetches }));
    check("risk_loops 严格增长", Number(a.risk_loops) > Number(b.risk_loops), JSON.stringify({ before: b.risk_loops, after: a.risk_loops }));
    const loopsGrew = Number(a.loops) > Number(b.loops);
    if (loopsGrew) check("strategy loops 严格增长", true, null);
    else note("strategy_loops_growth", "本轮窗口 <5 分钟策略周期,未观察到增长(不算 PASS);before=" + b.loops + " after=" + a.loops);
    check("心跳新鲜(heartbeat_age 秒级)", Number(a.heartbeat_age_ms) < 120000, JSON.stringify({ age_ms: a.heartbeat_age_ms }));
    saveState({ testA_after: a });
  }
  // 重新打开 UI:单实例
  adbTry(["logcat", "-c"], 30000);
  adbTry(["shell", "am", "start", "-n", PKG + "/.MainActivity"]);
  await sleep(20000);
  const uiWindow = lastStatus();
  const a2 = uiWindow.status;
  check("重开 UI 后仍是同一个 Runtime(instance_id 一致)", Boolean(a2) && a2.instance_id === (a && a.instance_id), JSON.stringify({ after: a2 && a2.instance_id }));
  check("重开 UI 未创建第二个运行时(窗口内 0 次 webview created)", uiWindow.created === 0, "created=" + uiWindow.created);
  logLine("TEST A done: " + passed + " passed, " + failed + " failed");
}

// ---------------- lock:锁屏档位 ----------------
if (phase === "lock") {
  const seconds = argOf("--seconds", 180);
  const alreadyLocked = args.includes("--already-locked");   // 熄屏窗口:am start 已把 App 起在后台(屏幕保持熄灭),不要再按电源键
  logLine("===== V16.1-RV LOCK " + seconds + "s" + (alreadyLocked ? "(already-locked)" : "") + " =====");
  if (!requireForeground("lock")) process.exit(2);
  const before = await waitForFreshStatus(90);
  check("拿到锁屏前状态", Boolean(before && before.status), "logcat 无 status");
  const b = before && before.status;
  saveState({ lastLockBefore: b, lockSeconds: seconds });
  if (seconds >= 120) screencap("01-runtime-before-lock.png");
  if (!alreadyLocked) adbTry(["shell", "input", "keyevent", "26"]);   // 熄屏锁屏
  await sleep(seconds * 1000);
  adbTry(["shell", "input", "keyevent", "224"]);  // 唤醒
  await sleep(1500);
  const locked = adbTry(["shell", "dumpsys window | grep mDreamingLockscreen"]).trim();
  note("lock_state_after_wake", locked.slice(0, 120));
  if (/mDreamingLockscreen=true/.test(locked)) adbTry(["shell", "wm", "dismiss-keyguard"]);
  await sleep(2000);
  const after = await waitForFreshStatus(150);
  const a = after && after.status;
  check("锁屏/待机期间窗口结束后仍拿到状态", Boolean(a), "无 status");
  if (b && a) {
    check("instance_id 不变(锁屏没有重启 Runtime)", a.instance_id === b.instance_id, JSON.stringify({ before: b.instance_id, after: a.instance_id }));
    const dRisk = Number(a.risk_loops) - Number(b.risk_loops);
    const dFetch = Number(a.market_fetches) - Number(b.market_fetches);
    const dLoops = Number(a.loops) - Number(b.loops);
    note("tick_delta", JSON.stringify({ seconds, risk: dRisk, market_fetches: dFetch, strategy: dLoops, stall_events_total: a.stall_events }));
    check("锁屏期间 market_fetches 严格增长(真的还在跑)", dFetch > 0, JSON.stringify({ before: b.market_fetches, after: a.market_fetches }));
    check("锁屏期间 risk_loops 严格增长", dRisk > 0, JSON.stringify({ before: b.risk_loops, after: a.risk_loops }));
    if (seconds >= 360) check("锁屏期间 strategy loops 严格增长(跨过 5 分钟周期)", dLoops > 0, JSON.stringify({ before: b.loops, after: a.loops }));
    else note("strategy_loops", "窗口 " + seconds + "s 未跨过策略周期,策略增长按 NOT COMPLETED 处理(不算 PASS)");
    if (Number(a.stall_events) > Number(b.stall_events)) note("RUNTIME_STALL", "系统冻结过运行时(见 logcat RUNTIME_STALL 行);恢复后只跑最新一轮");
    saveState({ lastLockAfter: a });
  }
  screencap("02-runtime-after-lock.png");
  logLine("LOCK(" + seconds + "s) done: " + passed + " passed, " + failed + " failed");
}

// ---------------- network:断网 → 恢复 ----------------
if (phase === "network") {
  const offSeconds = argOf("--off", 80);
  logLine("===== V16.1-RV NETWORK loss/restore =====");
  if (!requireForeground("network")) process.exit(2);
  const before = await waitForFreshStatus(90);
  const b = before && before.status;
  check("拿到断网前状态", Boolean(b), "无 status");
  adbTry(["logcat", "-c"], 30000);
  adbTry(["shell", "cmd", "connectivity", "airplane-mode", "enable"]);
  await sleep(offSeconds * 1000);
  const during = await waitForFreshStatus(120);
  const d = during && during.status;
  check("断网期间仍能拿到运行时状态(循环没死)", Boolean(d), "无 status");
  if (d) {
    note("offline_market_state", JSON.stringify({ state: d.market_state, blocked: d.market_blocked, last_error: d.last_error }));
    check("断网期间行情进入降级/阻断(不是假装 HEALTHY)", ["DEGRADED", "FAILED"].includes(String(d.market_state)), JSON.stringify(d.market_state));
    check("断网期间 instance_id 不变", !b || d.instance_id === b.instance_id);
  }
  screencap("10-network-offline.png");
  adbTry(["shell", "cmd", "connectivity", "airplane-mode", "disable"]);
  await sleep(90000);
  const after = await waitForFreshStatus(150);
  const a = after && after.status;
  check("恢复后拿到状态", Boolean(a), "无 status");
  if (a && b && d) {
    check("网络恢复 → 行情回到 HEALTHY", a.market_state === "HEALTHY", JSON.stringify({ state: a.market_state, err: a.last_error }));
    check("恢复后实例不变(没有重启成第二个 Runtime)", a.instance_id === b.instance_id, JSON.stringify({ before: b.instance_id, after: a.instance_id }));
    check("恢复后行情拉取继续增长", Number(a.market_fetches) > Number(d.market_fetches), JSON.stringify({ offline: d.market_fetches, restored: a.market_fetches }));
    check("恢复窗口无崩溃日志", !/FATAL|AndroidRuntime/.test(adbTry(["logcat", "-d", "-s", "AndroidRuntime:E"])), "见 logcat AndroidRuntime");
    saveState({ lastNetworkAfter: a });
  }
  screencap("11-network-restored.png");
  logLine("NETWORK done: " + passed + " passed, " + failed + " failed");
}

// ---------------- restart:进程重启 → 同一账户 ----------------
if (phase === "restart") {
  logLine("===== V16.1-RV PROCESS RESTART(同一账户恢复) =====");
  const before = await waitForFreshStatus(90);
  const b = before && before.status;
  check("拿到重启前状态", Boolean(b), "无 status");
  adbTry(["shell", "am", "force-stop", PKG]);
  await sleep(2500);
  adbTry(["logcat", "-c"], 30000);
  adbTry(["shell", "am", "start", "-n", PKG + "/.MainActivity"]);
  await sleep(40000);
  const after = await waitForFreshStatus(120);
  const a = after && after.status;
  check("重启后运行时重新起来", Boolean(a), "无 status");
  if (a && b) {
    note("restart_instance", JSON.stringify({ before: b.instance_id, after: a.instance_id }) + "(进程重启 → 新实例号属预期)");
    check("重启后是同一账户(权益一致,不是新的 100U)", Math.abs(Number(a.equity) - Number(b.equity)) < 0.5, JSON.stringify({ before: b.equity, after: a.equity }));
    check("重启后持仓数量一致", Number(a.open_positions) === Number(b.open_positions), JSON.stringify({ before: b.open_positions, after: a.open_positions }));
    check("重启窗口无崩溃", !/FATAL/.test(adbTry(["logcat", "-d", "-s", "AndroidRuntime:E"])), "见 logcat");
    check("重启后心跳恢复(循环真的在跑)", Number(a.heartbeat_age_ms) < 120000, JSON.stringify({ age: a.heartbeat_age_ms }));
    saveState({ lastRestartAfter: a });
  }
  logLine("RESTART done: " + passed + " passed, " + failed + " failed");
}

// ---------------- shots:UI 截图(需要点按;每步后立即截图复核) ----------------
if (phase === "shots") {
  const which = (args[0] || "all").toLowerCase();
  logLine("===== V16.1-RV SHOTS(" + which + ") =====");
  if (!requireForeground("shots")) process.exit(2);
  const tap = (x, y) => { adbTry(["shell", "input", "tap", String(x), String(y)]); };
  const swipe = (x1, y1, x2, y2, ms) => { adbTry(["shell", "input", "swipe", String(x1), String(y1), String(x2), String(y2), String(ms || 300)]); };
  const NAV = { home: [199, 2660], market: [486, 2660], paper: [773, 2660], settings: [1060, 2660] };
  if (which === "rd002-after" || which === "all") {
    // 注意:RD-002 的"真机 before"用旧构建既有截图 docs/real-device/v16-ui/07-btc-detail-before.png
    // (当前包已修复,不能再在新包上伪造 before);这里只拍修复后的真机 after。
    tap(...NAV.market);
    await sleep(2500);
    tap(630, 613);   // 市场第一行(BTC/USDT)
    await sleep(3000);
    swipe(630, 1800, 630, 1000, 400);
    await sleep(600);
    screencap("13-rd002-after.png");
  }
  if (which === "sysstatus" || which === "all") {
    tap(...NAV.settings);
    await sleep(1200);
    for (let i = 0; i < 5; i += 1) { swipe(630, 2300, 630, 600, 300); await sleep(350); }
    await sleep(600);
    screencap("14-runtime-health-prelocate.png");   // 先定位"系统状态"行,再人工确认坐标
  }
  if (which === "kline" || which === "all") {
    tap(...NAV.market);
    await sleep(2000);
    tap(630, 613);
    await sleep(3000);
    screencap("04-kline-portrait.png");
    adbTry(["shell", "settings", "put", "system", "user_rotation", "1"]);
    await sleep(1800);
    screencap("05-kline-landscape.png");
    adbTry(["shell", "settings", "put", "system", "user_rotation", "0"]);
    await sleep(1500);
    swipe(200, 1300, 900, 1300, 500);   // 向右拖 → 历史模式
    await sleep(800);
    screencap("06-kline-history-mode.png");
  }
  logLine("SHOTS(" + which + ") done: " + passed + " passed, " + failed + " failed");
}

if (!["preflight", "testa", "lock", "network", "restart", "shots"].includes(phase)) {
  console.log("usage: node tools/device-runtime-verify.mjs preflight|testA|lock --seconds N|network|restart|shots");
  process.exit(2);
}

fs.writeFileSync(path.join(OUT_DIR, "rv-results-" + (phase || "unknown") + ".json"), JSON.stringify({ phase, at: new Date().toISOString(), passed, failed, results }, null, 2), "utf8");
if (failed) process.exit(1);
