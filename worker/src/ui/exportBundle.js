// ui/exportBundle.js · V16.2y · 完整系统导出(工单 §16-§24)
// 纯逻辑(不碰 DOM):ZIP 写入(store 模式,零依赖)+ 导出编排(分块让步 + 进度回调)+ 完整性检查 + 脱敏。
// 页面只负责:收集数据 → 调 buildFullExport(带 yieldFn/progress) → 下载 Blob;期间主线程可交互。
export const EXPORT_VERSION = "full-export-v1.0";

// ---------- CRC32(标准多项式) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();
export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const enc = (s) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xFF;   // UTF-8 由上游保证(JSON 序列化后用 TextEncoder)
  return out;
};
function utf8Bytes(str) {
  if (typeof TextEncoder === "function") return new TextEncoder().encode(str);
  return zipEnc(unescape(encodeURIComponent(str)));
}

// ---------- 最小 ZIP(store,无压缩) ----------
export function createZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)) & 0xFFFF;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
  for (const f of files) {
    const nameBytes = utf8Bytes(String(f.name));
    const data = typeof f.data === "string" ? utf8Bytes(f.data) : f.data;
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);            // version needed
    dv.setUint16(6, 0x0800, true);        // UTF-8 flag
    dv.setUint16(8, 0, true);             // store
    dv.setUint16(10, dosTime, true);
    dv.setUint16(12, dosDate, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    chunks.push(local, data);
    central.push({ nameBytes, crc, size: data.length, offset });
    offset += local.length + data.length;
  }
  const centralStart = offset;
  for (const c of central) {
    const rec = new Uint8Array(46 + c.nameBytes.length);
    const dv = new DataView(rec.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0x0800, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, dosTime, true);
    dv.setUint16(14, dosDate, true);
    dv.setUint32(16, c.crc, true);
    dv.setUint32(20, c.size, true);
    dv.setUint32(24, c.size, true);
    dv.setUint16(28, c.nameBytes.length, true);
    dv.setUint32(42, c.offset, true);
    rec.set(c.nameBytes, 46);
    chunks.push(rec);
    offset += rec.length;
  }
  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(8, central.length, true);
  dv.setUint16(10, central.length, true);
  dv.setUint32(12, offset - centralStart, true);
  dv.setUint32(16, centralStart, true);
  chunks.push(eocd);
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// ---------- 完整系统导出 ----------
// sections: [{ name, data(object|string) }] 由调用方(页面)收集;本函数负责:序列化→脱敏→ZIP→manifest 完整性。
// §23:大数组分块序列化 —— 单个 JSON.stringify(几 MB 数组) 在手机上会形成 300-500ms 长任务;
// 这里按 chunk 逐段拼接 JSON 文本并在块间让步,单任务长度恒定在 ~10-20ms 量级。
async function stringifyChunked(value, yieldFn, chunkSize) {
  const chunk = chunkSize || 400;
  if (!Array.isArray(value) || value.length <= 1000) return JSON.stringify(value, null, 1);
  const parts = [];
  for (let i = 0; i < value.length; i += chunk) {
    parts.push(value.slice(i, i + chunk).map((row) => JSON.stringify(row, null, 1)).join(",\n "));
    await yieldFn();
  }
  return "[\n " + parts.join(",\n ") + "\n]";
}

export async function buildFullExport(input) {
  const i = input || {};
  const sections = i.sections || [];
  const redaction = i.redaction || null;          // { value, redacted_count }
  const audit = i.audit || null;                  // buildLossReport 结果
  const versions = i.versions || {};
  const yieldFn = typeof i.yieldFn === "function" ? i.yieldFn : (() => Promise.resolve());
  const progress = typeof i.progress === "function" ? i.progress : (() => {});
  const now = i.now || Date.now();

  // 完整性检查(§21):账户恒等式 + 账本闭合 + 成交 vs 账户
  const checks = [];
  if (audit && audit.reconciliation) {
    for (const c of audit.reconciliation.checks) checks.push({ id: c.id, ok: c.ok, diff: c.diff });
  }
  if (audit && audit.ledger_closure) checks.push({ id: "LEDGER_CLOSURE", ok: audit.ledger_closure.ok, diff: audit.ledger_closure.diff });
  const integrityOk = checks.length > 0 && checks.every((c) => c.ok);
  const integrityDiffs = checks.filter((c) => !c.ok);

  const manifest = {
    export_version: EXPORT_VERSION,
    app_version: versions.app_version || "unknown",
    runtime_version: versions.runtime_version || "unknown",
    schema_version: versions.schema_version || "unknown",
    feature_version: versions.feature_version || "fs-v1",
    model_version: versions.model_version || null,
    exported_at: new Date(now).toISOString(),
    paper_only: true,
    real_trading_enabled: false,
    files: sections.map((s) => s.name),
    record_counts: {},
    account_integrity: integrityOk ? "PASS" : "FAILED",
    integrity_diffs: integrityDiffs,
    learning_integrity: (audit && audit.learning && audit.learning.totals) || null,
    duplicate_count: audit && audit.duplicates ? (audit.duplicates.duplicate_signal_count + audit.duplicates.duplicate_entry_count + audit.duplicates.duplicate_exit_count) : null,
    invalid_learning_count: (audit && audit.learning && audit.learning.totals && audit.learning.totals.invalid_learning_samples) || 0,
    canonical_ml_sample_count: (audit && audit.learning && audit.learning.totals && audit.learning.totals.canonical_ml_sample_count) || 0,
    revision_count: (audit && audit.learning && audit.learning.totals && audit.learning.totals.revision_count) || 0,
    redaction: redaction ? { redacted_fields: redaction.redacted_count, redacted_keys: redaction.redacted_keys || [] } : { redacted_fields: 0, redacted_keys: [] }
  };

  const files = [];
  const total = sections.length + 2;   // sections + manifest + version_manifest
  let step = 0;
  const tick = async (label) => { step += 1; progress(Math.round(step / total * 100), label); await yieldFn(); };

  for (const s of sections) {
    const text = typeof s.data === "string" ? s.data : await stringifyChunked(s.data, yieldFn);
    files.push({ name: s.name, data: text });
    if (s.count != null) manifest.record_counts[s.name] = s.count;
    else if (Array.isArray(s.data)) manifest.record_counts[s.name] = s.data.length;
    await tick(s.name);
  }
  files.push({ name: "manifest.json", data: JSON.stringify(manifest, null, 1) });
  await tick("manifest.json");
  files.push({ name: "version_manifest.json", data: JSON.stringify({ export_version: EXPORT_VERSION, ...versions, exported_at: manifest.exported_at }, null, 1) });
  await tick("version_manifest.json");

  const zip = createZip(files);
  progress(100, "done");
  return { zip, manifest, byte_length: zip.length, files: files.map((f) => f.name) };
}
