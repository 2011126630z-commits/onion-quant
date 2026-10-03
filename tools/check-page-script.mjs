// tools/check-page-script.mjs · 校验页面内联 <script> 的语法(模板字符串内的 JS 无法被 node --check 发现)
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const page = fs.readFileSync(path.join(ROOT, "worker/src/ui/page.js"), "utf8");
const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
console.log("inline scripts:", scripts.length);
let bad = 0;
scripts.forEach((src, i) => {
  try {
    new vm.Script(src, { filename: "page-inline-" + i + ".js" });
    console.log("script#" + i + " PARSE OK (" + src.split("\n").length + " lines)");
  } catch (error) {
    bad += 1;
    console.log("script#" + i + " PARSE ERROR: " + error.message);
    const m = /page-inline-\d+\.js:(\d+)/.exec(String(error.stack || ""));
    if (m) {
      const line = Number(m[1]);
      const lines = src.split("\n");
      console.log("  → 行 " + line + ": " + String(lines[line - 1] || "").slice(0, 140));
      console.log("  → 上一行: " + String(lines[line - 2] || "").slice(0, 140));
    }
  }
});
process.exit(bad ? 1 : 0);
