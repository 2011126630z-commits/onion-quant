// history/dataset.js · STEP 11 Dataset Export
// 一行 = 一条真实历史 Signal;特征一律取"信号当时保存的 Feature Snapshot"
// 数据泄漏保护:本模块不导入引擎、不重新计算任何特征(禁止用完整历史回算过去特征)
// Pending 结果一律 null,绝不写成 0
import { HORIZONS } from "./schema.js";

const HKEY = { "5m": "h5m", "15m": "h15m", "1h": "h1h", "4h": "h4h", "24h": "h24h" };
export const HORIZON_KEYS = HKEY;

// 基础列(顺序固定,CSV 表头与 JSON 列清单共用同一来源)
export const BASE_COLUMNS = [
  "signal_id", "timestamp", "timestamp_iso", "symbol", "interval", "source", "backtest_run_id",
  "engine_version", "feature_version", "limited_data", "change24h",
  "market_regime", "regime_trend", "regime_vol_state", "regime_adx", "regime_atr_pct",
  "direction", "signal_strength", "confidence", "risk_score", "risk_level",
  "structure_label", "structure_hh", "structure_hl", "structure_lh", "structure_ll",
  "tf_conflict", "anomaly_detected", "forming_candle_count",
  "volume_pattern", "volume_ratio20", "volatility_level",
  "btc_state", "btc_corr", "breadth_up_pct"
];

// ML 训练禁止作为输入的列(规则引擎自身的判断结果,避免 ML 只是复读规则)
export const ML_EXCLUDED_COLUMNS = [
  "direction", "signal_strength", "confidence", "risk_score", "risk_level", "signal_id", "timestamp_iso", "backtest_run_id", "source"
];

// 结果标签列(按周期展开)
export function labelColumns(horizons) {
  const out = [];
  for (const h of horizons) {
    const k = HKEY[h];
    out.push(`${k}_resolved`, `${k}_price`, `${k}_return`, `${k}_outcome`, `${k}_verdict`, `${k}_mfe`, `${k}_mae`, `${k}_threshold`, `${k}_high_pct`, `${k}_low_pct`);
  }
  return out;
}

function parseJson(v, fallback) {
  if (v == null || v === "") return fallback;
  try {
    const out = JSON.parse(v);
    return out == null ? fallback : out;
  } catch (error) {
    return fallback;
  }
}

// 收集所有出现过的特征名(取并集并排序),保证不同批次导出的列一致
export function collectFeatureColumns(records) {
  const names = new Set();
  for (const rec of records || []) {
    const f = parseJson(rec.signal && rec.signal.features, null);
    if (!f) continue;
    for (const k of Object.keys(f)) names.add(k);
  }
  return [...names].sort();
}

export function featureColumnsFor(records) {
  return collectFeatureColumns(records).map((n) => "f_" + n);
}

// 一行 = 一条 Signal
export function datasetRow(record, options) {
  const opts = options || {};
  const horizons = opts.horizons || HORIZONS;
  const s = record.signal || {};
  const o = record.outcome || null;
  const features = parseJson(s.features, {}) || {};
  const row = {
    signal_id: s.id,
    timestamp: Number(s.timestamp),
    timestamp_iso: s.timestamp ? new Date(Number(s.timestamp)).toISOString() : null,
    symbol: s.symbol,
    interval: s.interval,
    source: s.source || "live",
    backtest_run_id: s.backtest_run_id || null,
    engine_version: s.engine_version || null,
    feature_version: s.feature_version || null,
    limited_data: s.limited_data ? 1 : 0,
    change24h: s.change24h == null ? null : Number(s.change24h),
    market_regime: s.market_regime_label || null,
    regime_trend: s.market_regime_trend_market ? 1 : 0,
    regime_vol_state: s.market_regime_vol_state || null,
    regime_adx: s.market_regime_adx == null ? null : Number(s.market_regime_adx),
    regime_atr_pct: s.market_regime_atr_pct == null ? null : Number(s.market_regime_atr_pct),
    direction: s.direction || null,
    signal_strength: s.signal_strength == null ? null : Number(s.signal_strength),
    confidence: s.confidence == null ? null : Number(s.confidence),
    risk_score: s.risk_score == null ? null : Number(s.risk_score),
    risk_level: s.risk_level || null,
    structure_label: s.structure_label || null,
    structure_hh: s.structure_hh == null ? null : Number(s.structure_hh),
    structure_hl: s.structure_hl == null ? null : Number(s.structure_hl),
    structure_lh: s.structure_lh == null ? null : Number(s.structure_lh),
    structure_ll: s.structure_ll == null ? null : Number(s.structure_ll),
    tf_conflict: s.tf_conflict ? 1 : 0,
    anomaly_detected: s.anomaly_detected ? 1 : 0,
    forming_candle_count: s.forming_candle_count == null ? null : Number(s.forming_candle_count),
    volume_pattern: s.volume_pattern || null,
    volume_ratio20: s.volume_ratio20 == null ? null : Number(s.volume_ratio20),
    volatility_level: s.volatility_level || null,
    btc_state: s.btc_state || null,
    btc_corr: s.btc_corr == null ? null : Number(s.btc_corr),
    breadth_up_pct: s.breadth_up_pct == null ? null : Number(s.breadth_up_pct)
  };
  // 特征:只取当时保存的快照
  for (const [k, v] of Object.entries(features)) {
    row["f_" + k] = v == null ? null : v;
  }
  // 结果:未解析 → null(不写 0)
  for (const h of horizons) {
    const key = HKEY[h];
    const resolved = Boolean(o && o[`outcome_${h}`] != null);
    row[`${key}_resolved`] = resolved ? 1 : 0;
    row[`${key}_price`] = resolved ? Number(o[`price_${h}`]) : null;
    row[`${key}_return`] = resolved ? Number(o[`return_${h}`]) : null;
    row[`${key}_outcome`] = resolved ? o[`outcome_${h}`] : null;
    row[`${key}_verdict`] = resolved ? (o[`verdict_${h}`] || null) : null;
    row[`${key}_mfe`] = resolved ? Number(o[`mfe_${h}`]) : null;
    row[`${key}_mae`] = resolved ? Number(o[`mae_${h}`]) : null;
    row[`${key}_threshold`] = resolved ? Number(o[`threshold_${h}`]) : null;
    row[`${key}_high_pct`] = resolved ? Number(o[`high_${h}`]) : null;
    row[`${key}_low_pct`] = resolved ? Number(o[`low_${h}`]) : null;
  }
  return row;
}

// 记录筛选:来源 / 币种 / 时间范围 / 必须已解析的周期
export function filterRecords(records, options) {
  const opts = options || {};
  const source = opts.source || "live";
  const symbol = opts.symbol ? String(opts.symbol).toUpperCase() : null;
  const from = opts.fromMs == null ? null : Number(opts.fromMs);
  const to = opts.toMs == null ? null : Number(opts.toMs);
  const onlyResolvedFor = opts.onlyResolvedFor && opts.onlyResolvedFor !== "all" ? opts.onlyResolvedFor : null;
  return (records || []).filter((r) => {
    const s = r && r.signal;
    if (!s) return false;
    if (source !== "all" && (s.source || "live") !== source) return false;
    if (symbol && s.symbol !== symbol) return false;
    const t = Number(s.timestamp);
    if (from != null && isFinite(from) && t < from) return false;
    if (to != null && isFinite(to) && t > to) return false;
    if (onlyResolvedFor && !(r.outcome && r.outcome[`outcome_${onlyResolvedFor}`] != null)) return false;
    return true;
  });
}

// 构建数据集
export function buildDataset(records, options) {
  const opts = options || {};
  const horizons = opts.horizons && opts.horizons.length ? opts.horizons.filter((h) => HORIZONS.includes(h)) : HORIZONS;
  const filtered = filterRecords(records, { ...opts, horizons });
  const featureCols = featureColumnsFor(filtered);
  const columns = [...BASE_COLUMNS, ...featureCols, ...labelColumns(horizons)];
  const rows = filtered
    .slice()
    .sort((a, b) => Number(a.signal.timestamp) - Number(b.signal.timestamp))
    .map((r) => datasetRow(r, { horizons }));
  // 补齐列(不同记录特征键可能不同)
  for (const row of rows) {
    for (const c of columns) if (!(c in row)) row[c] = null;
  }
  const labeled = rows.filter((row) => horizons.some((h) => row[`${HKEY[h]}_resolved`] === 1)).length;
  return {
    meta: {
      exported_at: new Date().toISOString(),
      source: opts.source || "live",
      symbol: opts.symbol || null,
      from_ms: opts.fromMs == null ? null : Number(opts.fromMs),
      to_ms: opts.toMs == null ? null : Number(opts.toMs),
      horizons,
      feature_version: rows.length ? rows[0].feature_version : null,
      engine_version: rows.length ? rows[0].engine_version : null,
      rows: rows.length,
      labeled_rows: labeled,
      pending_rows: rows.length - labeled,
      excluded_for_ml: ML_EXCLUDED_COLUMNS,
      note: "特征为信号生成当时保存的快照(feature snapshot);未解析结果一律为空值(null),不是 0"
    },
    columns,
    rows
  };
}

function csvCell(value) {
  if (value == null) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function datasetToCsv(dataset) {
  const lines = [dataset.columns.join(",")];
  for (const row of dataset.rows) {
    lines.push(dataset.columns.map((c) => csvCell(row[c])).join(","));
  }
  return lines.join("\n") + "\n";
}

export function datasetToJson(dataset) {
  return JSON.stringify({ meta: dataset.meta, columns: dataset.columns, rows: dataset.rows });
}

export function datasetFileName(prefix, ext, options) {
  const opts = options || {};
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const parts = [prefix || "quant-dataset", opts.source || "live"];
  if (opts.symbol) parts.push(String(opts.symbol).toUpperCase());
  parts.push(stamp);
  return parts.join("_") + "." + ext;
}
