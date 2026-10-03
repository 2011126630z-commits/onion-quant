// tools/ml/make_fixture.mjs
// 生成离线训练用的数据集 JSON(供 tools/ml/ml_train.py 使用)
// 两种模式:
//   1) --from-export <file>  读取 App 导出的数据集 JSON(class 字段与页面导出一致)
//   2) 默认:用真实引擎在合成K线上重放,产出与 App 完全同构的数据集(仅用于验证工具链)
// 说明:本工具不写入任何 Signal/Outcome 到 App 存储,只产出文件。
import fs from "node:fs";
import path from "node:path";
import { replaySymbol, attachOutcomes, pickSeriesByHorizon } from "../../worker/src/history/backtest.js";
import { buildDataset, datasetToJson } from "../../worker/src/history/dataset.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const OUT_DIR = path.join(ROOT, "build", "ml");

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// 合成 1h 序列:趋势段 + 震荡段 + 噪声(制造多种市场环境)
function gen1h(n, seed) {
  const rand = lcg(seed);
  const rows = [];
  let price = 100;
  const t0 = 1600000000000;
  for (let i = 0; i < n; i += 1) {
    const phase = Math.floor(i / 240) % 4;
    const drift = phase === 0 ? 0.0022 : phase === 1 ? -0.0018 : phase === 2 ? 0.0004 : -0.0006;
    const osc = Math.sin(i / 11) * 0.35;
    const open = price;
    const close = Math.max(1, price * (1 + drift) + osc + (rand() - 0.5) * 0.9);
    rows.push({
      openTime: t0 + i * 3600000,
      open,
      high: Math.max(open, close) * (1 + rand() * 0.0025),
      low: Math.min(open, close) * (1 - rand() * 0.0025),
      close,
      volume: 1000 * (0.7 + rand() * 0.6),
      closeTime: t0 + (i + 1) * 3600000 - 1
    });
    price = close;
  }
  return rows;
}

// 由 1h 序列聚合出 4h/1d(时间线一致)
function aggregate(hours, factor) {
  const out = [];
  for (let i = 0; i + factor <= hours.length; i += factor) {
    const chunk = hours.slice(i, i + factor);
    out.push({
      openTime: chunk[0].openTime,
      open: chunk[0].open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((a, c) => a + c.volume, 0),
      closeTime: chunk[chunk.length - 1].closeTime
    });
  }
  return out;
}

// 由 1h 线性插值出 15m(仅用于工具链验证;真实场景请使用 App 导出的数据)
function interpolate15m(hours, rand) {
  const out = [];
  for (let i = 0; i < hours.length; i += 1) {
    const cur = hours[i];
    const next = hours[i + 1] || cur;
    for (let k = 0; k < 4; k += 1) {
      const openTime = cur.openTime + k * 900000;
      const open = cur.open + ((cur.close - cur.open) * k) / 4;
      const close = open + ((next.close - cur.close) / 4) * (0.6 + rand() * 0.8);
      out.push({
        openTime,
        open,
        high: Math.max(open, close) * (1 + rand() * 0.0015),
        low: Math.min(open, close) * (1 - rand() * 0.0015),
        close,
        volume: cur.volume / 4,
        closeTime: openTime + 900000 - 1
      });
    }
  }
  return out;
}

async function buildFixture(bars) {
  const rand = lcg(99);
  const h1 = gen1h(bars, 7);
  const h4 = aggregate(h1, 4);
  const d1 = aggregate(h1, 24);
  const m15 = interpolate15m(h1, rand);
  const nowMs = h1[h1.length - 1].closeTime + 1000;

  const replay = await replaySymbol({
    symbol: "BTCUSDT",
    interval: "1h",
    tfRows: { "1h": h1, "4h": h4, "1d": d1 },
    btcRows: {},
    nowMs,
    step: 1,
    minHistory: 60
  });
  const signals = replay.signals;
  const series = pickSeriesByHorizon({ "15m": m15, "1h": h1, "4h": h4 });
  const joined = attachOutcomes(signals, series, nowMs);
  const ds = buildDataset(joined, { source: "backtest" });
  return { replay, ds, nowMs, counts: { signals: signals.length, resolved: ds.meta.labeled_rows, pending: ds.meta.pending_rows } };
}

const args = process.argv.slice(2);
const fromExportIdx = args.indexOf("--from-export");
const barsIdx = args.indexOf("--bars");
const outIdx = args.indexOf("--out");
const bars = barsIdx >= 0 ? Number(args[barsIdx + 1]) : 3200;
const outFile = outIdx >= 0 ? args[outIdx + 1] : path.join(OUT_DIR, "dataset.json");
const outPath = path.isAbsolute(outFile) ? outFile : path.join(ROOT, outFile);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

if (fromExportIdx >= 0) {
  const src = args[fromExportIdx + 1];
  const srcPath = path.isAbsolute(src) ? src : path.join(ROOT, src);
  const parsed = JSON.parse(fs.readFileSync(srcPath, "utf8"));
  if (!parsed.rows || !parsed.columns) throw new Error("导出文件缺少 rows/columns");
  fs.writeFileSync(outPath, JSON.stringify(parsed), "utf8");
  console.log("copied export -> " + outPath + " (" + parsed.rows.length + " rows, " + parsed.columns.length + " cols)");
} else {
  const built = await buildFixture(bars);
  fs.writeFileSync(outPath, datasetToJson(built.ds), "utf8");
  console.log("synthetic fixture -> " + outPath);
  console.log("signals=" + built.counts.signals + " labeled=" + built.counts.resolved + " pending=" + built.counts.pending + " columns=" + built.ds.columns.length);
  const byHorizon = {};
  for (const h of ["15m", "1h", "4h", "24h"]) {
    const key = { "15m": "h15m", "1h": "h1h", "4h": "h4h", "24h": "h24h" }[h];
    byHorizon[h] = built.ds.rows.filter((r) => r[`${key}_resolved`] === 1).length;
  }
  console.log("resolved per horizon: " + JSON.stringify(byHorizon));
}
