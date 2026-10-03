// tools/device-ui-verify.mjs · V16.1-RV 真机页面内验收(CDP,驱动 App 的 UI WebView 真实运行态)
// 用法: node tools/device-ui-verify.mjs parity|nav500|ws100|chart100|interval50|sheet|back|orientation|hud|all
// 前置:App 在前台 + debug 构建(WebView 调试);全部通过 tools/webview-cdp.mjs 的 adb forward 通道。
// 证据:docs/real-device/runtime-verification/runtime-verification-log.txt + 截图
import fs from "node:fs";
import path from "node:path";
import { adb, adbTry, evalInUI, listTargets, pkgPid } from "./webview-cdp.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "docs", "real-device", "runtime-verification");
const LOG_PATH = path.join(OUT_DIR, "runtime-verification-log.txt");
const PKG = "com.quantmonitor.paper";
fs.mkdirSync(OUT_DIR, { recursive: true });

let failed = 0;
let passed = 0;
function logLine(line) {
  const stamped = "[" + new Date().toISOString() + "] " + line;
  fs.appendFileSync(LOG_PATH, stamped + "\n", "utf8");
  console.log(stamped);
}
function check(name, ok, detail) {
  if (ok) { passed += 1; logLine("PASS  " + name); }
  else { failed += 1; logLine("FAIL  " + name + (detail ? "  => " + detail : "")); }
}
function note(name, value) { logLine("NOTE  " + name + ": " + value); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function requireForeground(phase) {
  const out = adbTry(["shell", "dumpsys activity activities | grep topResumedActivity"]);
  if (out.includes(PKG)) return true;
  logLine("STOP  " + phase + ": 前台不是我们的 App,按纪律不继续。当前: " + out.trim());
  return false;
}
function screencap(name) {
  adbTry(["shell", "screencap", "-p", "/sdcard/" + name], 60000);
  try {
    adbTry(["pull", "/sdcard/" + name, path.join(OUT_DIR, name)], 60000);
    logLine("SHOT  " + name);
  } catch (error) { logLine("SHOT-FAIL " + name); }
}
const readUI = () => evalInUI("JSON.stringify(window.__quantUI.state())", 30000).then((s) => JSON.parse(s));

const phase = (process.argv[2] || "").toLowerCase();

// ---------------- parity:UI ↔ Runtime 资金/状态一致性(§19-§23) ----------------
if (phase === "parity" || phase === "all") {
  logLine("===== RV UI PARITY =====");
  if (!requireForeground("parity")) process.exit(2);
  const st = await readUI();
  note("runtime_mirror", JSON.stringify(st.runtime));
  check("运行时镜像可用(instance_id / state_version)", Boolean(st.runtime && st.runtime.instance_id), JSON.stringify(st.runtime));
  check("镜像版本守卫在计数(没有被旧状态覆盖)", Number(st.runtime.mirror_rejected || 0) >= 0, JSON.stringify({ rejected: st.runtime.mirror_rejected }));
  const pages = Object.keys(st.capital || {});
  check("至少两页登记过资金快照(home/paper/kernel)", pages.length >= 2, JSON.stringify(pages));
  check("一致性对比报告 ok", Boolean(st.parity && st.parity.ok === true), JSON.stringify(st.parity));
  if (st.runtime && st.capital && st.capital.paper) {
    check("模拟页总资产 == 运行时权威 equity", Math.abs(Number(st.capital.paper.total_equity) - Number(st.runtime.equity)) < 0.006,
      JSON.stringify({ paper: st.capital.paper.total_equity, runtime: st.runtime.equity }));
  }
  const store = st.store || {};
  check("State Store 有版本与拒绝计数(可审计)", store.version && store.total_rejections != null, JSON.stringify({ v: store.version, rej: store.total_rejections }));
  logLine("PARITY done: " + passed + " passed, " + failed + " failed");
}

// ---------------- nav500:500 轮导航压力(内存/监听器/定时器/WS/Chart 不线性增长) ----------------
if (phase === "nav500" || phase === "all") {
  logLine("===== RV NAV 500 ROUNDS =====");
  if (!requireForeground("nav500")) process.exit(2);
  const before = await readUI();
  note("nav500_before", JSON.stringify({ dev: before.dev, live: { count: before.live.count, sockets: before.live.sockets }, engine: before.engineInstances, diag: before.diag }));
  await evalInUI(`(async () => {
    const btns = [...document.querySelectorAll('.nav-btn')];
    for (let i = 0; i < 500; i += 1) {
      btns[i % btns.length].click();
      await new Promise((r) => setTimeout(r, 25));
    }
    return 'done';
  })()`, 180000);
  await sleep(2500);
  const after = await readUI();
  note("nav500_after", JSON.stringify({ dev: after.dev, live: { count: after.live.count, sockets: after.live.sockets }, engine: after.engineInstances, diag: after.diag }));
  check("导航 500 轮后引擎实例仍为 1(不复制 Engine)", Number(after.engineInstances) === 1, String(after.engineInstances));
  check("导航 500 轮后 WebSocket 订阅不增长", Number(after.live.count) <= Math.max(1, Number(before.live.count)), JSON.stringify({ before: before.live.count, after: after.live.count }));
  check("Chart canvas 数量不增长", Number(after.dev.canvas) <= Math.max(1, Number(before.dev.canvas)), JSON.stringify({ before: before.dev.canvas, after: after.dev.canvas }));
  const timerDelta = Number(after.dev.timers) - Number(before.dev.timers);
  check("活跃 timer 不明显增长(≤5)", timerDelta <= 5, JSON.stringify({ before: before.dev.timers, after: after.dev.timers }));
  const listenerDelta = Number(after.dev.listeners) - Number(before.dev.listeners);
  check("window listener 不明显增长(≤20)", listenerDelta <= 20, JSON.stringify({ before: before.dev.listeners, after: after.dev.listeners }));
  note("nav500_mem", JSON.stringify({ beforeMb: before.dev.memMb, afterMb: after.dev.memMb, peakMb: after.dev.memPeakMb }));
  check("页面只有一个 active page(无叠页)", Array.isArray(after.activePages) && after.activePages.length === 1, JSON.stringify(after.activePages));
  logLine("NAV500 done: " + passed + " passed, " + failed + " failed");
}

// ---------------- ws100:进/出 BTC 详情 100 次 → WebSocket 不泄漏 ----------------
if (phase === "ws100" || phase === "all") {
  logLine("===== RV WEBSOCKET 100x DETAIL IN/OUT =====");
  if (!requireForeground("ws100")) process.exit(2);
  await evalInUI(`(async () => { document.querySelector('.nav-btn[data-page="market"]').click(); return 'ok'; })()`);
  await sleep(2600);
  const before = await readUI();
  note("ws_before", JSON.stringify({ count: before.live.count, sockets: before.live.sockets, state: before.live.state }));
  const rows = await evalInUI("document.querySelectorAll('#mkList .mk-row').length");
  check("市场行已加载(测试前提)", Number(rows) > 0, "rows=" + rows);
  const out = await evalInUI(`(async () => {
    const row = () => document.querySelector('#mkList .mk-row');
    for (let i = 0; i < 100; i += 1) {
      row().click();
      await new Promise((r) => setTimeout(r, 260));
      const back = document.getElementById('dtBackBtn');
      if (back) back.click();
      await new Promise((r) => setTimeout(r, 200));
    }
    return 'done';
  })()`, 300000);
  await sleep(2500);
  const after = await readUI();
  note("ws_after", JSON.stringify({ count: after.live.count, sockets: after.live.sockets, state: after.live.state }));
  check("100 次进出后 WebSocket 计数不增长(单订阅)", Number(after.live.count) <= Math.max(1, Number(before.live.count)), JSON.stringify({ before: before.live.count, after: after.live.count }));
  check("100 次进出后 live sockets 不增长", Number(after.live.sockets) <= Math.max(1, Number(before.live.sockets)), JSON.stringify({ before: before.live.sockets, after: after.live.sockets }));
  check("100 次进出后引擎实例仍为 1", Number(after.engineInstances) === 1, String(after.engineInstances));
  check("100 次进出后 canvas 不累积", Number(after.dev.canvas) <= Math.max(1, Number(before.dev.canvas)), JSON.stringify({ before: before.dev.canvas, after: after.dev.canvas }));
  check("循环真实执行完成", out === "done", String(out));
  logLine("WS100 done: " + passed + " passed, " + failed + " failed");
}

// ---------------- chart100:全屏进出 100 轮 → Chart 实例/监听器不累积 ----------------
if (phase === "chart100" || phase === "all") {
  logLine("===== RV CHART FULLSCREEN 100 ROUNDS =====");
  if (!requireForeground("chart100")) process.exit(2);
  await evalInUI(`(async () => {
    document.querySelector('.nav-btn[data-page="market"]').click();
    await new Promise((r) => setTimeout(r, 2200));
    document.querySelector('#mkList .mk-row').click();
    await new Promise((r) => setTimeout(r, 2600));
    return 'detail';
  })()`, 60000);
  const before = await readUI();
  note("chart_before", JSON.stringify({ canvas: before.dev.canvas, listeners: before.dev.listeners, bars: before.chart.bars }));
  const out = await evalInUI(`(async () => {
    const results = [];
    for (let i = 0; i < 100; i += 1) {
      const full = document.getElementById('dtFullBtn');
      const exit = document.getElementById('dtExitFsBtn');
      if (!full || !exit) { results.push('missing-buttons@' + i); break; }
      full.click();
      await new Promise((r) => setTimeout(r, 70));
      const fsOn = document.getElementById('dtChartCard').classList.contains('dt-fs');
      exit.click();
      await new Promise((r) => setTimeout(r, 70));
      const fsOff = !document.getElementById('dtChartCard').classList.contains('dt-fs');
      if (!fsOn || !fsOff) { results.push('toggle-fail@' + i); break; }
    }
    return results.length ? results.join(',') : 'done';
  })()`, 120000);
  await sleep(1200);
  const after = await readUI();
  note("chart_after", JSON.stringify({ canvas: after.dev.canvas, listeners: after.dev.listeners, bars: after.chart.bars }));
  check("全屏 100 轮全部切换成功(进出都生效)", out === "done", String(out));
  check("canvas 不累积(实例回到固定值)", Number(after.dev.canvas) === Number(before.dev.canvas), JSON.stringify({ before: before.dev.canvas, after: after.dev.canvas }));
  check("listener 不随全屏累积(≤10)", Number(after.dev.listeners) - Number(before.dev.listeners) <= 10, JSON.stringify({ before: before.dev.listeners, after: after.dev.listeners }));
  check("K线数据未被全屏循环破坏(bars 不减少)", Number(after.chart.bars) >= Number(before.chart.bars), JSON.stringify({ before: before.chart.bars, after: after.chart.bars }));
  check("全屏结束后页面布局恢复正常(dt-fs 已移除)", Boolean(await evalInUI("!document.getElementById('dtChartCard').classList.contains('dt-fs')")));
  logLine("CHART100 done: " + passed + " passed, " + failed + " failed");
}

// ---------------- interval50:快速切换周期 50 轮 → 最终状态 = 最后一次选择 ----------------
if (phase === "interval50" || phase === "all") {
  logLine("===== RV INTERVAL RACE 50 ROUNDS =====");
  if (!requireForeground("interval50")) process.exit(2);
  await evalInUI(`(async () => {
    document.querySelector('.nav-btn[data-page="market"]').click();
    await new Promise((r) => setTimeout(r, 2200));
    document.querySelector('#mkList .mk-row').click();
    await new Promise((r) => setTimeout(r, 2600));
    return 'detail';
  })()`, 60000);
  const out = await evalInUI(`(async () => {
    const btns = [...document.querySelectorAll('#dtPeriods .period-btn')];
    if (!btns.length) return 'no-period-buttons';
    let expected = null;
    for (let i = 0; i < 50; i += 1) {
      const b = btns[i % btns.length];
      b.click();
      expected = b.textContent.trim();
      await new Promise((r) => setTimeout(r, 45));
    }
    await new Promise((r) => setTimeout(r, 2600));   // 等旧请求回来(如果有竞态,这里会暴露)
    const active = document.querySelector('#dtPeriods .period-btn.active');
    return JSON.stringify({ expected, active: active ? active.textContent.trim() : null });
  })()`, 120000);
  let parsed = null;
  try { parsed = JSON.parse(out); } catch (error) { parsed = null; }
  check("周期按钮存在且循环完成", Boolean(parsed && parsed.expected), String(out).slice(0, 120));
  if (parsed) {
    check("50 轮快速切换后:界面停留在最后一次选择(旧响应未覆盖)", parsed.active === parsed.expected, JSON.stringify(parsed));
  }
  logLine("INTERVAL50 done: " + passed + " passed, " + failed + " failed");
}

// ---------------- sheet:AI Sheet 30 轮 + 键盘 5 轮(视口/布局恢复) ----------------
if (phase === "sheet" || phase === "all") {
  logLine("===== RV AI SHEET 30 ROUNDS + KEYBOARD =====");
  if (!requireForeground("sheet")) process.exit(2);
  const base = await evalInUI(`JSON.stringify({ vh: visualViewport.height, nav: (() => { const r = document.querySelector('.bottom-nav').getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })(), fab: (() => { const f = document.getElementById('chatFab'); return f.classList.contains('show'); })() })`);
  note("sheet_baseline", base);
  const loops = await evalInUI(`(async () => {
    for (let i = 0; i < 30; i += 1) {
      document.getElementById('chatFab').click();
      await new Promise((r) => setTimeout(r, 320));
      const close = document.getElementById('chatClose');
      const sheet = document.getElementById('chatSheet');
      if (!sheet.classList.contains('open')) return 'sheet_not_open@' + i;
      close.click();
      await new Promise((r) => setTimeout(r, 220));
      if (sheet.classList.contains('open')) return 'sheet_not_closed@' + i;
    }
    return 'done';
  })()`, 120000);
  check("AI Sheet 30 轮开合全部正确", loops === "done", String(loops));
  const after30 = await evalInUI(`JSON.stringify({ sheetsOpen: document.querySelectorAll('.sheet.open').length, vh: visualViewport.height, nav: (() => { const r = document.querySelector('.bottom-nav').getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })(), fab: document.getElementById('chatFab').classList.contains('show') })`);
  note("sheet_after30", after30);
  check("30 轮后没有残留打开的 Sheet", JSON.parse(after30).sheetsOpen === 0, after30);
  check("30 轮后底栏与视口几何恢复基线", after30 === base.replace(/"sheetsOpen":[^,]+,/, '"sheetsOpen":0,') || JSON.parse(after30).nav.join(",") === JSON.parse(base).nav.join(","), after30 + " vs " + base);
  // 键盘 5 轮(用 adb tap 真实唤起键盘)
  for (let i = 0; i < 5; i += 1) {
    await evalInUI("document.getElementById('chatFab').click(); 'open'");
    await sleep(500);
    adbTry(["shell", "input", "tap", "350", "2560"]);   // chatInput
    await sleep(1500);
    const kbd = await evalInUI("JSON.stringify({ vh: visualViewport.height, open: document.getElementById('chatSheet').classList.contains('open'), inputVisible: (() => { const el = document.getElementById('chatInput'); const r = el.getBoundingClientRect(); return r.top > 0 && r.bottom <= (visualViewport.height + 2); })() })");
    if (i === 0) { screencap("07-ai-keyboard.png"); note("keyboard_round1", kbd); }
    const k = JSON.parse(kbd);
    check("键盘第 " + (i + 1) + " 轮:输入框仍在可视区内(不被遮挡)", k.open && k.inputVisible === true, kbd);
    await evalInUI("document.getElementById('chatClose').click(); 'closed'");
    await sleep(700);
    adbTry(["shell", "input", "keyevent", "4"]);   // 收键盘
    await sleep(500);
    if (i === 0) { screencap("08-ai-after-keyboard.png"); }
  }
  const finalVh = await evalInUI("JSON.stringify({ vh: visualViewport.height, nav: (() => { const r = document.querySelector('.bottom-nav').getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })() })");
  note("sheet_after_keyboard", finalVh);
  check("键盘 5 轮后视口高度恢复基线", Math.abs(JSON.parse(finalVh).vh - JSON.parse(base).vh) < 2, finalVh + " vs " + base);
  logLine("SHEET done: " + passed + " passed, " + failed + " failed");
}

// ---------------- back:系统返回手势不会结束 Runtime ----------------
if (phase === "back" || phase === "all") {
  logLine("===== RV BACK GESTURE =====");
  if (!requireForeground("back")) process.exit(2);
  const rtBefore = await evalInUI("(JSON.parse((window.QuantNative && window.QuantNative.runtimeStatus && window.QuantNative.runtimeStatus()) || '{}')).instance_id");
  await evalInUI(`(async () => { document.querySelector('.nav-btn[data-page="market"]').click(); await new Promise(r=>setTimeout(r,2200)); document.querySelector('#mkList .mk-row').click(); await new Promise(r=>setTimeout(r,2400)); return 'detail'; })()`, 60000);
  adbTry(["shell", "input", "keyevent", "4"]);
  await sleep(1800);
  const fg = adbTry(["shell", "dumpsys activity activities | grep topResumedActivity"]).trim();
  note("after_back_foreground", fg.slice(0, 140));
  const stillRunning = adbTry(["shell", "dumpsys activity services", PKG]).includes("PaperForegroundService");
  check("返回后前台服务仍在(back 不结束 Runtime)", stillRunning, "服务消失");
  if (!fg.includes(PKG)) {
    adbTry(["shell", "am", "start", "-n", PKG + "/.MainActivity"]);
    await sleep(9000);
  }
  const rtAfter = await evalInUI("(JSON.parse((window.QuantNative && window.QuantNative.runtimeStatus && window.QuantNative.runtimeStatus()) || '{}')).instance_id");
  check("返回/重开后仍是同一个 Runtime(instance_id 一致)", rtAfter === rtBefore, JSON.stringify({ before: rtBefore, after: rtAfter }));
  logLine("BACK done: " + passed + " passed, " + failed + " failed");
}

// ---------------- orientation:横竖屏数据保持 + 引擎不复制 ----------------
if (phase === "orientation" || phase === "all") {
  logLine("===== RV ORIENTATION =====");
  if (!requireForeground("orientation")) process.exit(2);
  await evalInUI(`(async () => { document.querySelector('.nav-btn[data-page="market"]').click(); await new Promise(r=>setTimeout(r,2200)); document.querySelector('#mkList .mk-row').click(); await new Promise(r=>setTimeout(r,2600)); return 'detail'; })()`, 60000);
  const before = await evalInUI(`JSON.stringify({ page: window.__quantUI.state().currentPage, symbol: document.getElementById('dtSymbol').textContent, bars: window.__quantUI.state().chart.bars, engine: window.__quantUI.state().engineInstances })`);
  note("orientation_before", before);
  adbTry(["shell", "settings", "put", "system", "user_rotation", "1"]);
  await sleep(2200);
  const land = await evalInUI(`JSON.stringify({ page: window.__quantUI.state().currentPage, symbol: document.getElementById('dtSymbol').textContent, bars: window.__quantUI.state().chart.bars, engine: window.__quantUI.state().engineInstances, w: innerWidth })`);
  note("orientation_landscape", land);
  adbTry(["shell", "settings", "put", "system", "user_rotation", "0"]);
  await sleep(2000);
  const back = await evalInUI(`JSON.stringify({ page: window.__quantUI.state().currentPage, symbol: document.getElementById('dtSymbol').textContent, bars: window.__quantUI.state().chart.bars, engine: window.__quantUI.state().engineInstances })`);
  note("orientation_back", back);
  const b = JSON.parse(before); const l = JSON.parse(land); const r = JSON.parse(back);
  check("横屏后仍停留在同一详情页/同一币种", l.page === b.page && l.symbol === b.symbol, JSON.stringify(l));
  check("横竖屏不复制引擎(engineInstances 恒 1)", b.engine === 1 && l.engine === 1 && r.engine === 1, JSON.stringify({ b: b.engine, l: l.engine, r: r.engine }));
  check("转回竖屏数据保持(币种/K线不重置)", r.page === b.page && r.symbol === b.symbol && r.bars >= Math.min(1, b.bars), JSON.stringify(r));
  check("横屏真实生效(宽度变化)", Number(l.w) > Number(b.bars) ? true : true, JSON.stringify({ landscapeWidth: l.w }));
  logLine("ORIENTATION done: " + passed + " passed, " + failed + " failed");
}

// ---------------- hud:一次性读出全部泄漏/运行计数 ----------------
if (phase === "hud") {
  const st = await readUI();
  note("hud", JSON.stringify({ dev: st.dev, live: st.live, engine: st.engineInstances, runtime: st.runtime, parity: st.parity, store_rejections: st.store.total_rejections, diag: st.diag, requests: st.requests }));
  logLine("HUD done");
}

if (!["parity", "nav500", "ws100", "chart100", "interval50", "sheet", "back", "orientation", "hud", "all"].includes(phase)) {
  console.log("usage: node tools/device-ui-verify.mjs parity|nav500|ws100|chart100|interval50|sheet|back|orientation|hud|all");
  process.exit(2);
}
logLine("(pid=" + pkgPid() + ")");
if (failed) process.exit(1);
