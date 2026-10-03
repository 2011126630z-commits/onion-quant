// worker.js · Cloudflare Worker / Sites 入口
// 说明:QENGINE_SRC / QENGINE_HASH 由 tools/build.mjs 打包时注入
//      (浏览器端引擎+历史逻辑源码,经 /qengine.js 提供给页面,避免内联进 String.raw 页面模板)
import { page } from "./ui/page.js";
import { handleAnalyze, handleScreen, handleAiReview } from "./routes.js";
import { proxyBinance, probeMarketHealth, marketHealthSnapshot, netMode, netInfo, __resetMarketHealthForTest, handleNewsFeed } from "./proxy.js";
import { __resetCachesForTest } from "./engine/marketData.js";
import { computeAnalysis } from "./engine/signal.js";
import { ENGINE_VERSION } from "./engine/constants.js";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      const force = url.searchParams.get("probe") === "1";
      const runtime = (typeof process !== "undefined" && process.versions && process.versions.node) ? "node-local" : "cloudflare-edge";
      const providers = force ? (await probeMarketHealth()).providers : marketHealthSnapshot();
      const info = netInfo();
      return Response.json({
        generated_at: new Date().toISOString(),
        probed: force,
        runtime,
        node_version: info.node_version,
        proxy_configured: info.proxy_configured,
        proxy_source: info.proxy_source,
        native_env_proxy_supported: info.native_env_proxy_supported,
        native_env_proxy_min: info.native_env_proxy_min,
        proxy_method: info.proxy_method,
        net_mode: netMode(),
        providers
      }, { headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } });
    }
    if (url.pathname === "/qengine.js") {
      const hashed = url.searchParams.get("h") === QENGINE_HASH;
      return new Response(QENGINE_SRC, {
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-store",
          "access-control-allow-origin": "*"
        }
      });
    }
    if (url.pathname === "/api/analyze") return handleAnalyze(url);
    if (url.pathname === "/api/screen") return handleScreen(url);
    // V14.5:AI Review 支持 GET(旧契约)与 POST(携带真实问题 + 结构化上下文)
    if (url.pathname === "/api/ai/review") return handleAiReview(url, request);
    // V14.5:真实新闻/公告源(Research Agent 的 Provider;固定端点,不接受任意 URL)
    if (url.pathname === "/api/news" || url.pathname === "/api/announcements") return handleNewsFeed(url);
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

export { computeAnalysis, ENGINE_VERSION, __resetMarketHealthForTest, __resetCachesForTest };
