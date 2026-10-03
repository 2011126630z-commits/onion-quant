// tools/check-qengine.mjs · 校验页面 bundle(QEngine)能否解析并暴露必需 API
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync(new URL("../build/qe.js", import.meta.url), "utf8");
console.log("size:", src.length);
try {
  new vm.Script(src, { filename: "qengine.js" });
  console.log("PARSE OK");
} catch (error) {
  console.log("PARSE ERROR:", error.message);
  const lines = String(error.stack || "").split("\n");
  console.log(lines.slice(0, 5).join("\n"));
  process.exit(1);
}
const sandbox = { window: {} };
vm.createContext(sandbox);
try {
  vm.runInContext(src, sandbox);
} catch (error) {
  console.log("RUNTIME ERROR:", String(error.message).slice(0, 200));
  process.exit(1);
}
const Q = sandbox.window.QEngine || {};
const required = ["createRequestManager", "homeViewModel", "paperViewModel", "detailViewModel", "chatViewModel", "marketRow", "learningViewModel", "createPaperEngine", "createHistoryStore", "evaluateRisk", "evidenceBundle", "fuse", "buildChatContext", "answerLocally", "detectDrift", "getChampion", "listModels", "planRetention", "applyRetention", "dayKeyOf", "fmtPct", "summarizeTrades", "normalizeKlines", "RETENTION_POLICY", "MODE_CONFIG"];
const missing = required.filter((k) => typeof Q[k] === "undefined");
console.log("exposed keys:", Object.keys(Q).length);
console.log("missing:", JSON.stringify(missing));
process.exit(missing.length ? 1 : 0);
