// tools/diag-reexec.mjs · 测试 reexecWithProxy 是否把代理环境传给子进程
import { reexecWithProxy, buildProxyEnv, maskProxy } from "./net-proxy.mjs";

const proxy = process.argv[2] || "http://127.0.0.1:17891";
console.log("parent: 准备重启,代理 " + maskProxy(proxy));
console.log("parent env check: " + JSON.stringify(buildProxyEnv(proxy)).slice(0, 160));
const code = await reexecWithProxy(new URL("./diag-envproxy.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), proxy);
console.log("child exit code: " + code);
