// tools/smoke-http.mjs · 真实 HTTP 冒烟(dev-server:页面 / qengine / funding 路由 / 健康检查)
import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = process.env.SMOKE_PORT || "8797";
let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log("PASS  " + name); }
  else { failed += 1; console.log("FAIL  " + name + (detail ? "  => " + detail : "")); }
}

const child = spawn(process.execPath, ["dev-server.mjs"], { cwd: ROOT, env: { ...process.env, PORT }, stdio: ["ignore", "pipe", "pipe"] });
let serverOut = "";
child.stdout.on("data", (d) => { serverOut += d; });
child.stderr.on("data", (d) => { serverOut += d; });

async function waitUp(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch("http://127.0.0.1:" + PORT + "/api/health");
      if (res.ok) return true;
    } catch (error) { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

try {
  const up = await waitUp(30000);
  check("dev-server 启动并响应 /api/health", up, serverOut.slice(-300));
  if (up) {
    const page = await fetch("http://127.0.0.1:" + PORT + "/");
    const html = await page.text();
    check("页面返回 200 且是 HTML", page.status === 200 && /text\/html/.test(page.headers.get("content-type") || ""), String(page.status));
    check("页面含 V14.3 K线交互元素", ["dtOhlcBar", "dtOhlcChg", "dtLatestBtn", "dtVolValue"].every((id) => html.includes('id="' + id + '"')));
    check("页面含 ML 运行时卡片", ["mlRuntimeCard", "mlArtifactFile", "mlArtifactPromote"].every((id) => html.includes('id="' + id + '"')));
    const bundleTag = (html.match(/<script src="(\/qengine\.js[^"]*)"/) || [])[1];
    check("页面通过 /qengine.js 加载引擎", Boolean(bundleTag), bundleTag || "未找到 script 标签");
    const qe = await fetch("http://127.0.0.1:" + PORT + (bundleTag || "/qengine.js"));
    const qeSrc = await qe.text();
    check("/qengine.js 返回 JS", qe.status === 200 && /javascript/.test(qe.headers.get("content-type") || ""), String(qe.status));
    check("bundle 暴露 chartApi 与 ML Runtime", qeSrc.includes("chartApi") && qeSrc.includes("createMlRuntime") && qeSrc.includes("createFundingBook"));
    check("bundle 体积合理(> 200KB)", qeSrc.length > 200 * 1024, String(qeSrc.length));
    // 资金费路由:上游不可用时必须是明确的错误 JSON,而不是伪造数据
    const funding = await fetch("http://127.0.0.1:" + PORT + "/api/funding?market=futures&symbol=BTCUSDT");
    const fundingBody = await funding.json().catch(() => null);
    if (funding.status === 200) {
      check("funding 路由返回可解析的快照", Boolean(fundingBody && (fundingBody.lastFundingRate != null || fundingBody.error)), JSON.stringify(fundingBody).slice(0, 160));
    } else {
      check("funding 上游不可用时返回明确错误(不伪造)", funding.status >= 400 && Boolean(fundingBody && fundingBody.error), String(funding.status) + " " + JSON.stringify(fundingBody).slice(0, 160));
    }
    const spot = await fetch("http://127.0.0.1:" + PORT + "/api/funding?market=spot&symbol=BTCUSDT");
    const spotBody = await spot.json().catch(() => null);
    check("现货资金费请求被明确拒绝", spot.status === 400 && Boolean(spotBody && /仅期货/.test(spotBody.error || "")), JSON.stringify(spotBody).slice(0, 120));
    const health = await fetch("http://127.0.0.1:" + PORT + "/api/health");
    const healthBody = await health.json();
    check("健康检查含网络模式信息", health.status === 200 && typeof healthBody.net_mode === "string", JSON.stringify(healthBody).slice(0, 160));
  }
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("HTTP SMOKE OK");
