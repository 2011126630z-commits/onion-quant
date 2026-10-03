// dev-server.mjs · 本地开发服务器(Node-only)
// V13.4 网络出口:
//   - 代理来源:MARKET_PROXY_URL > HTTPS_PROXY > HTTP_PROXY > ALL_PROXY > Windows 系统代理 > 直连
//   - 实现方式按 Node 能力自动选择:
//       支持 native env proxy(Node ≥ 24)→ NODE_USE_ENV_PROXY=1 注入后"带环境重启"
//       不支持(旧 Node)→ 兜底:undici ProxyAgent(若可用)或内置 CONNECT 隧道 fetch
//   - 代理是否真的可用,以"真实请求 Binance/OKX/Bybit 的结果"判定;全失败则记为 broken,绝不显示代理 OK
//   - NO_PROXY 含 localhost/127.0.0.1,避免把自己送进代理
//   - Cloudflare 部署不经过本文件,worker/src 不含任何 Node-only 代码
const port = Number(process.env.PORT || 8790);
const skipConnectivity = process.env.SKIP_CONNECTIVITY === "1";

if (typeof Deno !== "undefined") {
  const worker = (await import("./worker/index.js")).default;
  Deno.serve({ port }, (request) => worker.fetch(request));
} else {
  const net = await import("./tools/net-proxy.mjs");
  const nodeVersion = process.versions.node;
  const nativeSupported = net.supportsNativeEnvProxy();
  const detected = net.detectProxy();

  const info = {
    node_version: "v" + nodeVersion,
    proxy_configured: Boolean(detected.url),
    proxy_source: detected.source,
    native_env_proxy_supported: nativeSupported,
    native_env_proxy_min: net.NATIVE_ENV_PROXY_MIN_TEXT,
    proxy_method: "direct",
    net_mode: "direct"
  };

  if (!detected.url) {
    info.proxy_method = "direct";
    info.net_mode = "direct";
  } else if (nativeSupported) {
    // 官方 env proxy:必须先于进程启动注入 → 需要时带环境重启一次
    if (net.needsReexec(detected.url)) {
      console.log("检测到本地代理(" + net.maskProxy(detected.url) + ", 来源 " + detected.source + "),Node " + info.node_version + " 支持原生 env proxy,正在重启本地服务器...");
      const entry = decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\//, "");
      const code = await net.reexecWithProxy(entry, detected.url);
      process.exit(code);
    }
    info.proxy_method = "native-env";
    info.net_mode = "proxy";
  } else {
    // 旧 Node:兜底实现,让 global fetch 真正经过代理
    console.log("检测到本地代理(" + net.maskProxy(detected.url) + "),但 Node " + info.node_version + " 不支持原生 env proxy(需 ≥ " + info.native_env_proxy_min + "),尝试内置兜底...");
    try {
      const { tryInstallUndiciProxy, createProxyFetch } = await import("./tools/proxy-fetch.mjs");
      const undici = await tryInstallUndiciProxy(detected.url);
      if (undici) {
        info.proxy_method = undici.method;
        info.net_mode = "proxy";
      } else {
        globalThis.__MARKET_FETCH = createProxyFetch(detected.url, { timeoutMs: 12000 });
        info.proxy_method = "proxy-agent";
        info.net_mode = "proxy";
      }
    } catch (error) {
      info.proxy_method = "unsupported";
      info.net_mode = "broken";
      console.log("兜底代理安装失败:" + (error && error.message ? error.message : String(error)));
    }
  }

  if (info.proxy_method === "unsupported") {
    console.log("Proxy configured but unsupported by current Node version");
    console.log("  Node: " + info.node_version + "  最低要求: " + info.native_env_proxy_min + "(或提供 undici)");
    console.log("  当前状态: " + info.net_mode + "(请求将直连,可能全部失败)");
  }
  globalThis.__MARKET_NET_MODE = info.net_mode === "proxy" ? "proxy" : "direct";
  globalThis.__MARKET_NET_INFO = info;

  const worker = (await import("./worker/index.js")).default;
  const { createServer } = await import("node:http");
  const proxyLabel = net.maskProxy(detected.url || process.env.MARKET_PROXY_URL || process.env.HTTPS_PROXY || "");
  const server = createServer(async (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      try {
        const url = `http://${req.headers.host}${req.url}`;
        const request = new Request(url, {
          method: req.method,
          headers: req.headers,
          body: chunks.length ? Buffer.concat(chunks) : undefined,
        });
        const response = await worker.fetch(request);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body) {
          const buffer = Buffer.from(await response.arrayBuffer());
          res.end(buffer);
        } else {
          res.end();
        }
      } catch (error) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(error instanceof Error ? error.message : "server error");
      }
    });
  });
  server.on("error", (error) => {
    if (error && error.code === "EADDRINUSE") {
      console.log("端口 " + port + " 已被占用:请先关闭已在运行的本地服务器(或换一个 PORT 环境变量)。");
      process.exit(1);
    }
    console.log("本地服务器启动失败:" + (error && error.message ? error.message : String(error)));
    process.exit(1);
  });
  server.listen(port, "0.0.0.0", async () => {
    console.log(`server listening on http://localhost:${port}`);
    console.log("\nNode: " + info.node_version);
    console.log("Proxy configured: " + (info.proxy_configured ? "yes (" + proxyLabel + ", source " + detected.source + ")" : "no"));
    console.log("Native env proxy: " + (nativeSupported ? "supported" : "unsupported (requires >= " + info.native_env_proxy_min + ")"));
    console.log("Proxy method: " + info.proxy_method);
    if (skipConnectivity) return;
    const probe = await net.printMarketConnectivity({ mode: info.net_mode, proxy_method: info.proxy_method, proxyLabel });
    // 以真实探测结果定状态:配置了代理但三源全挂 → broken(不得显示代理可用)
    if (info.proxy_configured && probe.ok_count === 0) {
      info.net_mode = "broken";
      globalThis.__MARKET_NET_MODE = "broken";
    } else if (info.proxy_configured && probe.ok_count > 0) {
      info.net_mode = "proxy";
    }
    console.log("Final net mode: " + info.net_mode);
  });
}
