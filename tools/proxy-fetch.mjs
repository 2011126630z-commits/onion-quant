// tools/proxy-fetch.mjs · 本地 Node 的代理兜底实现(Node-only,绝不进 worker/src)
// 用途:旧版 Node 不支持 NODE_USE_ENV_PROXY(或未达最低小版本)时,仍能让行情请求真正走代理。
// 策略:
//   1) 若环境提供 undici → ProxyAgent + setGlobalDispatcher(由 undici 决定其支持的代理协议)
//   2) 否则用 Node 内置实现 CONNECT 隧道:
//        http:// proxy  → net.connect 到代理后发 CONNECT
//        https:// proxy → tls.connect 到代理(与代理之间 TLS),再在隧道内发 CONNECT
// 约束:
//   - 目标仅允许 http/https
//   - 一次性预算:调用方给的 init.signal 优先;内部 timeoutMs 只是兜底上限(不会与之叠加)
//   - abort/超时/错误时立即清定时器并销毁 socket / TLS socket / 请求对象
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

export function parseProxyUrl(proxyUrl) {
  const u = new URL(proxyUrl);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("proxy scheme not allowed: " + u.protocol);
  return {
    protocol: u.protocol,
    host: u.hostname,
    port: Number(u.port || (u.protocol === "https:" ? 443 : 80)),
    auth: u.username ? "Basic " + Buffer.from(decodeURIComponent(u.username) + ":" + decodeURIComponent(u.password || "")).toString("base64") : null
  };
}

function abortError() {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

function targetPortOf(u) {
  return Number(u.port || (u.protocol === "https:" ? 443 : 80));
}

/**
 * 创建经代理的 fetch 实现
 * @param {string} proxyUrl 代理地址(来自 env 或系统代理)
 * @param {{timeoutMs?: number}} options timeoutMs 为兜底上限,调用方 signal 更早则以其为准
 */
export function createProxyFetch(proxyUrl, options) {
  const proxy = parseProxyUrl(proxyUrl);
  const fallbackTimeoutMs = Number((options && options.timeoutMs) || 12000);
  return function proxyFetch(target, init) {
    const opts = init || {};
    const signal = opts.signal || null;
    return new Promise((resolve, reject) => {
      const targetUrl = new URL(String(target));
      if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
        reject(new Error("scheme not allowed: " + targetUrl.protocol));
        return;
      }
      let settled = false;
      let timer = null;
      let proxySocket = null;
      let tlsSocket = null;
      let req = null;
      let onAbort = null;

      const cleanup = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (signal && onAbort) { try { signal.removeEventListener("abort", onAbort); } catch (e) { /* ignore */ } }
        if (req && typeof req.destroy === "function") { try { req.destroy(); } catch (e) { /* ignore */ } }
        if (tlsSocket && !tlsSocket.destroyed) { try { tlsSocket.destroy(); } catch (e) { /* ignore */ } }
        if (proxySocket && !proxySocket.destroyed) { try { proxySocket.destroy(); } catch (e) { /* ignore */ } }
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const succeed = (response) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(response);
      };

      if (signal) {
        onAbort = () => fail(signal.reason instanceof Error ? signal.reason : abortError());
        if (signal.aborted) { fail(abortError()); return; }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      timer = setTimeout(() => fail(new Error("proxy request timeout (" + fallbackTimeoutMs + "ms)")), fallbackTimeoutMs);

      const port = targetPortOf(targetUrl);
      const onProxyConnected = () => {
        const lines = ["CONNECT " + targetUrl.hostname + ":" + port + " HTTP/1.1", "Host: " + targetUrl.hostname + ":" + port];
        if (proxy.auth) lines.push("Proxy-Authorization: " + proxy.auth);
        proxySocket.write(lines.join("\r\n") + "\r\n\r\n");
      };
      let buffer = "";
      const onProxyData = (chunk) => {
        buffer += chunk.toString("latin1");
        const idx = buffer.indexOf("\r\n\r\n");
        if (idx < 0) return;
        proxySocket.removeListener("data", onProxyData);
        const statusLine = buffer.slice(0, buffer.indexOf("\r\n"));
        const code = Number((statusLine.split(" ")[1] || "0"));
        if (code < 200 || code >= 300) {
          fail(new Error("proxy CONNECT failed: " + statusLine.trim()));
          return;
        }
        const rest = buffer.slice(idx + 4);
        const secureTarget = targetUrl.protocol === "https:";
        tlsSocket = secureTarget ? tls.connect({ socket: proxySocket, servername: targetUrl.hostname }) : proxySocket;
        if (rest.length) tlsSocket.unshift(Buffer.from(rest, "latin1"));
        const mod = secureTarget ? https : http;
        // 注意:不要设置 agent:false —— 那会让 Node 忽略 createConnection 而直连目标
        req = mod.request({
          method: opts.method || "GET",
          path: targetUrl.pathname + (targetUrl.search || ""),
          host: targetUrl.hostname,
          port: port,
          headers: { host: targetUrl.host, accept: "application/json", "user-agent": "Mozilla/5.0", connection: "close" },
          createConnection: () => tlsSocket
        }, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            succeed(new Response(Buffer.concat(chunks), {
              status: res.statusCode || 0,
              headers: { "content-type": (res.headers && res.headers["content-type"]) || "application/json" }
            }));
          });
          res.on("error", fail);
        });
        req.on("error", fail);
        req.end();
      };

      // https 代理:先与代理建立 TLS,再在其上发 CONNECT
      proxySocket = proxy.protocol === "https:"
        ? tls.connect({ host: proxy.host, port: proxy.port, servername: proxy.host })
        : net.connect({ host: proxy.host, port: proxy.port });
      proxySocket.on("error", fail);
      proxySocket.on("close", () => { if (!settled) fail(new Error("proxy connection closed before response")); });
      proxySocket.on("data", onProxyData);
      if (proxy.protocol === "https:") proxySocket.on("secureConnect", onProxyConnected);
      else proxySocket.on("connect", onProxyConnected);
    });
  };
}

// 尝试加载 undici(旧 Node 上装了 undici 时优先用它)
export async function tryInstallUndiciProxy(proxyUrl) {
  try {
    const undici = await import("undici");
    if (!undici || typeof undici.ProxyAgent !== "function" || typeof undici.setGlobalDispatcher !== "function") return null;
    const agent = new undici.ProxyAgent(proxyUrl);
    undici.setGlobalDispatcher(agent);
    return { method: "undici-proxy-agent", agent };
  } catch (error) {
    return null;
  }
}
