// engine/utils.js · 基础数学与格式化
// 由 tools/migrate-split.mjs 从 V9 单文件拆分而来;逻辑未改动

function delaySrv(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function stdevSrv(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / (values.length - 1));
}
function median(values) {
  if (!values.length) return 0;
  const arr = [...values].sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}
function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 10) return null;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i += 1) { ma += a[a.length - n + i]; mb += b[b.length - n + i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i += 1) {
    const xa = a[a.length - n + i] - ma, xb = b[b.length - n + i] - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  return da && db ? num / Math.sqrt(da * db) : null;
}
function r2(v) {
  return v == null || !isFinite(v) ? null : Math.round(v * 100) / 100;
}
function fmtPrice(v) {
  if (v == null || !isFinite(v)) return "--";
  if (v >= 1000) return v.toFixed(0);
  if (v >= 1) return v.toFixed(2);
  return v.toPrecision(4);
}

// ---- IndicatorEngine ----

export { delaySrv, stdevSrv, median, pearson, r2, fmtPrice };
