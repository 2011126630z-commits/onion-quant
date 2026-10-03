// tools/diag-runtimeproxy.mjs · 运行时设置 env proxy 是否生效
process.env.NODE_USE_ENV_PROXY = "1";
process.env.HTTPS_PROXY = process.env.TEST_PROXY || "";
process.env.HTTP_PROXY = process.env.TEST_PROXY || "";
process.env.NO_PROXY = "localhost,127.0.0.1,::1";
const t0 = Date.now();
try {
  const res = await fetch("https://fapi.binance.com/fapi/v1/time", { signal: AbortSignal.timeout(8000) });
  console.log("runtime-env-proxy: OK", res.status, Date.now() - t0 + "ms", (await res.text()).slice(0, 60));
} catch (error) {
  console.log("runtime-env-proxy: FAIL", Date.now() - t0 + "ms", error.message, error.cause ? "[" + error.cause.code + "]" : "");
}
