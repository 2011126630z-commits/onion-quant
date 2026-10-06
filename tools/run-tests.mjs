// tools/run-tests.mjs · 顺序跑全部测试套件,汇总 PASS/FAIL
// 用法: node tools/run-tests.mjs            (全部)
//       node tools/run-tests.mjs chart ml   (只跑名字含 chart/ml 的套件)
import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SUITES = [
  "test-engine.mjs",
  "tools/test-history.mjs",
  "tools/test-parity.mjs",
  "tools/test-app-integration.mjs",
  "tools/test-backtest-app.mjs",
  "tools/test-walkforward-dataset.mjs",
  "tools/test-market-link.mjs",
  "tools/test-net-proxy.mjs",
  "tools/test-ml-baseline.mjs",
  "tools/test-paper.mjs",
  "tools/test-soak.mjs",
  "tools/test-mobile-ui.mjs",
  "tools/test-paper-futures.mjs",
  "tools/test-chart-interaction.mjs",
  "tools/test-ml-runtime.mjs",
  "tools/test-funding.mjs",
  "tools/test-predictor.mjs",
  "tools/test-external.mjs",
  "tools/test-profit-lock.mjs",
  "tools/test-soak-v144.mjs",
  "tools/test-runtime-v145.mjs",
  "tools/test-soak-v145.mjs",
  "tools/test-v15.mjs",
  "tools/test-futures-integrity.mjs",
  "tools/test-modules-v16.mjs",
  "tools/test-chat-session.mjs",
  "tools/test-attribution.mjs",
  "tools/test-runtime-host.mjs",
  "tools/test-runtime-boot.mjs",
  "tools/test-trade-integrity.mjs",
  "tools/test-clean-analytics.mjs",
  "tools/test-v16-capital.mjs",
  "tools/test-factors-models.mjs",
  "tools/test-universe-diag.mjs",
  "tools/test-v161-shadow.mjs",
  "tools/test-tree-shadow.mjs",
  "tools/test-runtime-verify.mjs",
  "tools/test-nav-state.mjs",
  "tools/test-nav-stress.mjs",
  "tools/test-v162s-ui.mjs",
  "tools/test-p0-runtime-guards.mjs",
  "tools/test-universe-efficiency.mjs",
  "tools/test-device-boot.mjs",
  "tools/test-account-audit.mjs",
  "tools/check-artifacts.mjs",
  "tools/smoke-http.mjs"
];

// 只接受"看起来像套件名"的参数,忽略 shell 重定向等噪声(如 2>&1、>、;)
const rawFilters = process.argv.slice(2);
const filters = rawFilters.filter((a) => /^[a-z0-9-]+$/i.test(a));
if (rawFilters.length !== filters.length) {
  console.log("(忽略非套件名参数: " + rawFilters.filter((a) => !filters.includes(a)).join(" ") + ")");
}
const selected = filters.length ? SUITES.filter((s) => filters.some((f) => s.includes(f))) : SUITES;
if (!selected.length) {
  console.log("没有匹配的套件(可用过滤词如 chart / ml / funding / nav,或不带参数跑全部)");
  process.exit(2);
}

function runOne(rel) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [rel], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => {
      const failed = (out.match(/^FAIL/gm) || []).length;
      const passed = (out.match(/^PASS/gm) || []).length;
      const line = (out.match(/^\d+ passed, \d+ failed$/m) || [])[0] || "";
      resolve({ rel, code, out, failed, passed, line, ms: Date.now() - t0 });
    });
  });
}

console.log("running " + selected.length + " suites...\n");
const results = [];
for (const rel of selected) {
  const r = await runOne(rel);
  results.push(r);
  const ok = r.code === 0 && r.failed === 0;
  console.log((ok ? "OK    " : "FAILED") + "  " + rel.padEnd(38) + r.line.padEnd(22) + (r.ms / 1000).toFixed(1) + "s");
  if (!ok) {
    const failLines = r.out.split("\n").filter((l) => /^FAIL/.test(l)).slice(0, 8);
    for (const l of failLines) console.log("        " + l);
    if (!failLines.length) console.log("        exit=" + r.code + " " + r.out.trim().split("\n").slice(-3).join(" | ").slice(0, 300));
  }
}
const bad = results.filter((r) => r.code !== 0 || r.failed > 0);
console.log("\n" + (results.length - bad.length) + "/" + results.length + " suites OK"
  + " · assertions: " + results.reduce((a, r) => a + r.passed, 0) + " passed, " + results.reduce((a, r) => a + r.failed, 0) + " failed");
if (bad.length) {
  console.log("failed suites: " + bad.map((r) => r.rel).join(", "));
  process.exit(1);
}
console.log("ALL SUITES OK");
