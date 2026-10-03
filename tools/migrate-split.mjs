// tools/migrate-split.mjs
// 一次性迁移脚本:把 V9 单文件 worker/index.js 拆成模块化源码(纯搬移,不修改逻辑)
// 用法: node tools/migrate-split.mjs
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "worker", "index.js");
const code = fs.readFileSync(SRC, "utf8");

function findOnce(marker) {
  const i = code.indexOf(marker);
  if (i < 0) throw new Error("marker not found: " + marker);
  if (code.indexOf(marker, i + 1) >= 0) throw new Error("marker not unique: " + marker);
  return i;
}
function slice(a, b) {
  return code.slice(a, b).replace(/\s+$/, "") + "\n";
}

// ---- 顶层边界 ----
const iPage = findOnce("const page = String.raw`");
const iUpstreams = findOnce("const upstreams = {");
const iEngineNote = findOnce("const ENGINE_VERSION");
const iEntry = findOnce("export default {");

const pageSrc = code.slice(iPage, iUpstreams).replace(/\s+$/, "") + "\n"; // const page = String.raw`...`;
const proxySrc = slice(iUpstreams, iEngineNote);

// ---- 引擎区分段(用 ASCII 函数名作为边界,避免中文标点风险) ----
const marks = [
  ["const ENGINE_VERSION", "const KL_CACHE = new Map();"],
  ["const KL_CACHE = new Map();", "function delaySrv"],
  ["function delaySrv", "function emaSeriesSrv"],
  ["function emaSeriesSrv", "function findSwings"],
  ["function findSwings", "function marketRegime"],
  ["function marketRegime", "function volumeAnalysis"],
  ["function volumeAnalysis", "function tfEvaluate"],
  ["function tfEvaluate", "function correlationOf"],
  ["function correlationOf", "function breadthFromTickers"],
  ["function breadthFromTickers", "function splitClosed"],
  ["function splitClosed", "function computeAnalysis"],
  ["function computeAnalysis", "async function analyzeSymbol"],
  ["async function analyzeSymbol", "export default {"]
];
const segs = {};
for (const [a, b] of marks) segs[a] = slice(findOnce(a), findOnce(b));

// ---- 输出模块 ----
const out = {};
const banner = (title) => `// ${title}\n// 由 tools/migrate-split.mjs 从 V9 单文件拆分而来;逻辑未改动\n\n`;

out["src/engine/constants.js"] =
  banner("engine/constants.js · 引擎版本与周期常量") +
  segs["const ENGINE_VERSION"] +
  `\nexport { ENGINE_VERSION, TF_LIST, TF_WEIGHTS, INTERVAL_MS, DIR_ZH };\n`;

out["src/engine/marketData.js"] =
  banner("engine/marketData.js · MarketDataProvider(K线/行情缓存取数)") +
  `import { INTERVAL_MS } from "./constants.js";\nimport { proxyBinance } from "../proxy.js";\n\n` +
  segs["const KL_CACHE = new Map();"] +
  `\nexport { KL_CACHE, TICKERS_CACHE, KL_TTL, TICKERS_TTL, cacheGet, cacheSet, engineUrl, getKlines, getTickers };\n`;

out["src/engine/utils.js"] =
  banner("engine/utils.js · 基础数学与格式化") +
  segs["function delaySrv"] +
  `\nexport { delaySrv, stdevSrv, median, pearson, r2, fmtPrice };\n`;

out["src/engine/indicators.js"] =
  banner("engine/indicators.js · IndicatorEngine(EMA/RSI/MACD/BB/ATR/ADX/...)") +
  `import { stdevSrv } from "./utils.js";\n\n` +
  segs["function emaSeriesSrv"] +
  `\nexport { emaSeriesSrv, emaLast, smaLast, rsiLast, macdLast, bbLast, trueRanges, atrLast, adxLast, slopePct, rocLast, hvLast, vwapLast, mfiLast, cciLast, stochRsiLast, obvDir };\n`;

out["src/engine/structure.js"] =
  banner("engine/structure.js · MarketStructureEngine(摆动点/结构/支撑阻力)") +
  segs["function findSwings"] +
  `\nexport { findSwings, structureQuick, analyzeStructure, srZones };\n`;

out["src/engine/regime.js"] =
  banner("engine/regime.js · MarketRegimeEngine(趋势/区间/波动状态)") +
  `import { emaLast, adxLast, slopePct, bbLast, atrLast, trueRanges } from "./indicators.js";\nimport { median, r2 } from "./utils.js";\n\n` +
  segs["function marketRegime"] +
  `\nexport { marketRegime, regimeLite };\n`;

out["src/engine/volume.js"] =
  banner("engine/volume.js · VolumeAnalyzer / VolatilityAnalyzer / 异常检测") +
  `import { smaLast, atrLast, trueRanges, bbLast, hvLast } from "./indicators.js";\nimport { median, r2, stdevSrv } from "./utils.js";\n\n` +
  segs["function volumeAnalysis"] +
  `\nexport { volumeAnalysis, volatilityAnalysis, anomalyDetect };\n`;

out["src/engine/timeframes.js"] =
  banner("engine/timeframes.js · 多周期评估(tfEvaluate)") +
  `import { emaLast, rsiLast, macdLast, rocLast } from "./indicators.js";\nimport { structureQuick } from "./structure.js";\n\n` +
  segs["function tfEvaluate"] +
  `\nexport { tfEvaluate };\n`;

out["src/engine/btc.js"] =
  banner("engine/btc.js · BTCContextAnalyzer(BTC联动/相关性/相对强度)") +
  `import { tfEvaluate } from "./timeframes.js";\nimport { volatilityAnalysis } from "./volume.js";\nimport { splitClosed } from "./candles.js";\nimport { r2, pearson } from "./utils.js";\n\n` +
  segs["function correlationOf"] +
  `\nexport { correlationOf, btcContext };\n`;

out["src/engine/breadth.js"] =
  banner("engine/breadth.js · 市场广度(Market Breadth)") +
  segs["function breadthFromTickers"] +
  `\nexport { breadthFromTickers };\n`;

out["src/engine/candles.js"] =
  banner("engine/candles.js · K线状态保护(只允许已收盘K线进入判断)") +
  `import { INTERVAL_MS } from "./constants.js";\n\n` +
  segs["function splitClosed"] +
  `
// 已收盘K线的最后收盘时间(用于 Outcome 追踪的对齐锚点,防 Look-Ahead)
function lastClosedCloseTime(rows, nowMs) {
  const cut = splitClosed(rows, nowMs).closed;
  return cut.length ? cut[cut.length - 1].closeTime : null;
}

export { splitClosed, lastClosedCloseTime };\n`;

out["src/engine/signal.js"] =
  banner("engine/signal.js · SignalEngine + RiskEngine(computeAnalysis)") +
  `import { ENGINE_VERSION, TF_LIST, TF_WEIGHTS, DIR_ZH } from "./constants.js";\n` +
  `import { r2, fmtPrice, median } from "./utils.js";\n` +
  `import { emaLast, rsiLast, macdLast, vwapLast, mfiLast, cciLast, stochRsiLast, rocLast, obvDir } from "./indicators.js";\n` +
  `import { analyzeStructure, srZones } from "./structure.js";\n` +
  `import { marketRegime } from "./regime.js";\n` +
  `import { volumeAnalysis, volatilityAnalysis, anomalyDetect } from "./volume.js";\n` +
  `import { tfEvaluate } from "./timeframes.js";\n` +
  `import { btcContext } from "./btc.js";\n` +
  `import { breadthFromTickers } from "./breadth.js";\n` +
  `import { splitClosed, lastClosedCloseTime } from "./candles.js";\n\n` +
  segs["function computeAnalysis"] +
  `\nexport { computeAnalysis };\n`;

out["src/proxy.js"] =
  banner("proxy.js · 上游数据代理(币安主源 + OKX/Bybit 回退,固定白名单)") +
  proxySrc +
  `\nexport { upstreams, routes, proxyBinance, proxyOkx, proxyBybit, cleanSymbol, timeoutSignal, cleanInterval, toOkxInstId, toOkxBar, convertOkxTicker, convertOkxCandle, toBybitInterval, convertBybitTicker, convertBybitCandle };\n`;

out["src/routes.js"] =
  banner("routes.js · API 路由(analyze / screen)") +
  `import { getKlines, getTickers } from "./engine/marketData.js";\n` +
  `import { computeAnalysis } from "./engine/signal.js";\n` +
  `import { splitClosed } from "./engine/candles.js";\n` +
  `import { tfEvaluate } from "./engine/timeframes.js";\n` +
  `import { volumeAnalysis, volatilityAnalysis, anomalyDetect } from "./engine/volume.js";\n` +
  `import { regimeLite } from "./engine/regime.js";\n` +
  `import { TF_LIST } from "./engine/constants.js";\n` +
  `import { r2, delaySrv } from "./engine/utils.js";\n` +
  `import { cleanSymbol, cleanInterval } from "./proxy.js";\n\n` +
  segs["async function analyzeSymbol"] +
  `\nexport { analyzeSymbol, handleAnalyze, screenSymbol, handleScreen };\n`;

// 页面模板(V10 会在 page.js 里追加验证页;此处只搬移)
out["src/ui/page.js"] = "// ui/page.js · 单页前端模板(HTML/CSS/JS 内嵌)\n\n" + pageSrc.replace(/^const page = /, "export const page = ");

// worker 入口(手写:保留原有路由行为)
out["src/worker.js"] =
  `// worker.js · Cloudflare Worker / Sites 入口
import { page } from "./ui/page.js";
import { handleAnalyze, handleScreen } from "./routes.js";
import { proxyBinance } from "./proxy.js";
import { computeAnalysis } from "./engine/signal.js";
import { ENGINE_VERSION } from "./engine/constants.js";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/analyze") return handleAnalyze(url);
    if (url.pathname === "/api/screen") return handleScreen(url);
    if (url.pathname.startsWith("/api/")) return proxyBinance(url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(page, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store"
        }
      });
    }
    return new Response("Not found", { status: 404 });
  }
};

export { computeAnalysis, ENGINE_VERSION };
`;

// ---- 写入 ----
let written = 0;
let bytes = 0;
for (const [rel, content] of Object.entries(out)) {
  const full = path.join(ROOT, "worker", rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  written += 1;
  bytes += Buffer.byteLength(content, "utf8");
  console.log(`wrote worker/${rel} (${content.split("\n").length} lines)`);
}

// ---- 覆盖检查:模块导出名是否覆盖原文件全部顶层声明 ----
const origNames = new Set();
for (const m of code.matchAll(/^(?:async )?function ([A-Za-z_$][\w$]*)/gm)) origNames.add(m[1]);
for (const m of code.matchAll(/^const ([A-Za-z_$][\w$]*)/gm)) origNames.add(m[1]);
const bundleNames = new Set();
for (const [rel, content] of Object.entries(out)) {
  for (const m of content.matchAll(/^export \{([^}]*)\};/gm)) {
    for (const n of m[1].split(",")) bundleNames.add(n.trim());
  }
}
const missing = [...origNames].filter((n) => !bundleNames.has(n) && n !== "page");
if (missing.length) {
  console.log("WARN 未出现在导出列表中的顶层名: " + missing.join(", "));
} else {
  console.log("OK 所有顶层声明均已归档到模块导出列表");
}
console.log(`done: ${written} modules, ${bytes} bytes`);
