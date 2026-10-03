// tools/ml/train.mjs
// V13 ML Baseline 命令行驱动(Node 负责文件读写,Python 只做纯计算,经 stdin/stdout 交换 JSON)
// 用法:
//   node tools/ml/train.mjs [--dataset build/ml/dataset.json] [--out build/ml/results]
//                           [--horizons 15m,1h,4h] [--models logreg,lightgbm,xgboost]
//                           [--train-days 30] [--test-days 7] [--min-samples 100]
// 产出:report.json / artifacts.json / predictions.json(模型为数据格式,不使用 pickle)
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const RUNNER = path.join(ROOT, "tools", "ml", "ml_runner.py");

function parseArgs(argv) {
  const out = { dataset: "build/ml/dataset.json", out: "build/ml/results", horizons: "15m,1h,4h", models: "logreg,lightgbm,xgboost", "train-days": "30", "test-days": "7", "min-samples": "100", "overfit-gap": "0.15", "top-features": "15" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}

// 限制输出路径在项目内(防越界)
function safeUnderRoot(relative) {
  const abs = path.resolve(ROOT, relative);
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (abs !== ROOT && !abs.startsWith(rootWithSep)) throw new Error("路径越界: " + abs);
  return abs;
}

export function runPython(payload, options) {
  const opts = options || {};
  return new Promise((resolve, reject) => {
    const child = spawn(opts.python || "python", [RUNNER], { cwd: ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error("python runner failed (exit " + code + "): " + stderr.slice(-800)));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error("无法解析 python 输出: " + error.message + " | " + stdout.slice(0, 300)));
      }
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

export function summarizeReport(report) {
  const lines = [];
  for (const [horizon, block] of Object.entries(report.horizons || {})) {
    lines.push(`\n=== ${horizon} (labeled ${block.samples.labeled}, folds ${block.folds.length}, pending_excluded ${block.samples.pending_excluded}) ===`);
    lines.push(["model", "samples", "acc", "bal_acc", "macroF1", "bullRec", "bearRec", "dirRet", "dirMFE", "dirMAE"].join("\t"));
    for (const [model, s] of Object.entries(block.summary || {})) {
      if (!s || s.accuracy == null) continue;
      const f = (v, d = 3) => (v == null ? "--" : Number(v).toFixed(d));
      lines.push([model, s.samples, f(s.accuracy * 100, 1) + "%", f(s.balanced_accuracy * 100, 1) + "%", f(s.macro_f1, 3),
        f(s.per_class?.bullish?.recall, 3), f(s.per_class?.bearish?.recall, 3),
        f(s.avg_directional_return, 2), f(s.directional_mfe, 2), f(s.directional_mae, 2)].join("\t"));
    }
    for (const [model, o] of Object.entries(block.overfit_check || {})) {
      if (o.risk) lines.push(`  [overfit risk] ${model}: train ${(o.avg_train_accuracy * 100).toFixed(1)}% vs test ${(o.avg_test_accuracy * 100).toFixed(1)}% (gap ${(o.gap * 100).toFixed(1)}%)`);
    }
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const datasetPath = safeUnderRoot(args.dataset);
  const outDir = safeUnderRoot(args.out);
  if (!fs.existsSync(datasetPath)) {
    console.error("数据集不存在: " + datasetPath + " (先运行 node tools/ml/make_fixture.mjs 或放入 App 导出文件)");
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
  const payload = {
    rows: data.rows || [],
    columns: data.columns || [],
    meta: data.meta || {},
    options: {
      horizons: String(args.horizons).split(",").map((s) => s.trim()).filter(Boolean),
      models: String(args.models).split(",").map((s) => s.trim()).filter(Boolean),
      train_days: Number(args["train-days"]) || 30,
      test_days: Number(args["test-days"]) || 7,
      min_samples: Number(args["min-samples"]) || 100,
      overfit_gap: Number(args["overfit-gap"]) || 0.15,
      top_features: Number(args["top-features"]) || 15,
      synthetic: args.synthetic === "true"
    }
  };
  const t0 = Date.now();
  const result = await runPython(payload, { python: args.python });
  if (result.error) {
    console.error("训练失败: " + result.error);
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(result.report, null, 1), "utf8");
  fs.writeFileSync(path.join(outDir, "artifacts.json"), JSON.stringify(result.artifacts), "utf8");
  fs.writeFileSync(path.join(outDir, "predictions.json"), JSON.stringify(result.predictions), "utf8");
  console.log("dataset: " + path.relative(ROOT, datasetPath) + " (" + payload.rows.length + " rows)");
  console.log(summarizeReport(result.report));
  console.log(`\nartifacts: ${Object.keys(result.artifacts).length} | predictions: ${Object.values(result.predictions).reduce((a, b) => a + b.length, 0)} | ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("report -> " + path.relative(ROOT, path.join(outDir, "report.json")));
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("train.mjs")) {
  await main();
}
