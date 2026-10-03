// paper/diagnostics.js · V16 §21 系统诊断 / 黑匣子(纯函数,无 I/O)
// 目标:出问题时,用户能"一键导出"一份可复制的诊断报告,而不是让人在手机上看空白页。
// 三条硬约束:
//   1) 同一错误每秒出现一万次,也只能占一条记录(count 累加)—— 否则日志会自己把系统压死;
//   2) 任何导出内容都必须先脱敏 —— api key / token / 私钥绝不能进剪贴板;
//   3) P0(资金 / 账本 / 崩溃)错误天然最容易被淹没,所以它们单独保存且不参与环形淘汰。
// 本模块只维护内存中的诊断缓冲,不做网络与磁盘 I/O;时钟可注入(opts.now)以便测试与回放。
export const DIAG_VERSION = "diagnostics-v1.0";

export const DIAG_LEVELS = { INFO: "INFO", WARN: "WARN", ERROR: "ERROR", FATAL: "FATAL" };

// 命中这些键名一律掩码;键名匹配不区分大小写(见 /i)
export const DIAG_SECRET_PATTERNS = [
  /api[_-]?key/i,
  /authorization/i,
  /secret/i,
  /token/i,
  /password/i,
  /passwd/i,
  /private[_-]?key/i,
  /mnemonic/i,
  /cookie/i
];

export const DIAG_DEFAULT_LIMITS = { errors: 200, breadcrumbs: 100, snapshots: 20 };
export const DIAG_MASK = "***";

const DIAG_REDACT_MAX_DEPTH = 6;

function diagNum(v, fallback) {
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  return fallback === undefined ? 0 : fallback;
}

function diagNowOf(diag) {
  return typeof diag.now === "function" ? diag.now() : Date.now();
}

function diagEnsure(diag) {
  const d = diag && typeof diag === "object" ? diag : createDiagnostics({});
  if (!Array.isArray(d.errors)) d.errors = [];
  if (!Array.isArray(d.p0_errors)) d.p0_errors = [];
  if (!Array.isArray(d.breadcrumbs)) d.breadcrumbs = [];
  if (!Array.isArray(d.snapshots)) d.snapshots = [];
  if (!d.counters || typeof d.counters !== "object") d.counters = {};
  d.limits = { ...DIAG_DEFAULT_LIMITS, ...(d.limits || {}) };
  if (typeof d.now !== "function") d.now = () => Date.now();
  d.seq = diagNum(d.seq, 0);
  return d;
}

// 创建黑匣子。options.now 可注入假时钟(测试必须能确定性复现时间线)
export function createDiagnostics(options) {
  const o = options || {};
  const d = {
    version: DIAG_VERSION,
    errors: [],
    p0_errors: [],
    breadcrumbs: [],
    snapshots: [],
    seq: 0,
    id_day: null,
    id_seq: 0,
    counters: {},
    limits: { ...DIAG_DEFAULT_LIMITS, ...(o.limits || {}) },
    now: typeof o.now === "function" ? o.now : () => Date.now()
  };
  return d;
}

// 错误原文(只在"技术详情"里出现,导出前会被脱敏)
function diagTechnical(error) {
  if (error == null) return "unknown error";
  if (typeof error === "string") return error;
  if (error.stack) return String(error.stack);
  if (error.message) return String(error.message);
  try { return JSON.stringify(error); } catch (_) { return String(error); }
}

function diagMessage(error) {
  if (error == null) return "unknown error";
  if (typeof error === "string") return error;
  return String(error.message || error.name || error);
}

// 中文分类:按"业务语义强弱"排序 —— model/storage/runtime 的词比通用的 fetch 更具体,
// 所以先匹配它们,避免把"模型文件加载失败"误判成"网络失败"。
const DIAG_ERROR_MAP = [
  { kind: "MODEL", zh: "模型加载失败", re: /model|artifact|weights|champion|predictor|onnx|tensorflow|ml[_-]?runtime/i },
  { kind: "STORAGE", zh: "数据库不可用", re: /indexeddb|\bidb\b|storage|quota|sqlite|database|\bdb\b|disk|filesystem|enoent/i },
  { kind: "RUNTIME", zh: "后台运行停止", re: /runtime|service.?worker|worker.*(stop|terminat)|halt|background/i },
  { kind: "NETWORK", zh: "行情服务连接失败", re: /network|fetch|econn|enotfound|etimedout|socket|connection|offline|dns|abort/i }
];

// 常见错误 → 中文解释;technical 只在"技术详情"里展示,普通用户看不到
export function classifyErrorZh(error) {
  const text = diagMessage(error) + " " + (error && error.name ? String(error.name) : "")
    + " " + (error && error.stack ? String(error.stack).split("\n").slice(0, 2).join(" ") : "");
  for (const entry of DIAG_ERROR_MAP) {
    if (entry.re.test(text)) return { kind: entry.kind, zh: entry.zh, technical: error == null ? "" : diagTechnical(error) };
  }
  return { kind: "UNKNOWN", zh: "系统异常", technical: error == null ? "" : diagTechnical(error) };
}

// FNV-1a 32bit:纯 JS 实现,避免引入 crypto(扁平 bundle 里不能依赖 node 内建)
function diagHash(input) {
  const str = String(input);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ("00000000" + (h >>> 0).toString(16)).slice(-8);
}

// 归一化:去掉地址/行号/时间戳/大数字,让"同一错误"在指纹层收敛
function diagNormalizeText(text) {
  return String(text)
    .replace(/0x[0-9a-fA-F]+/g, "0xX")
    .replace(/[A-Za-z]:\\[^\s)]+/g, "PATH")
    .replace(/\/(?:[^\s/]+\/)+[^\s/)]+/g, "PATH")
    .replace(/\b\d{3,}\b/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// 稳定指纹:message + 前 3 行 stack 归一化后 hash
export function diagDedupeKey(error) {
  const msg = diagNormalizeText(diagMessage(error));
  const stack = diagNormalizeText(error && error.stack ? String(error.stack).split("\n").slice(0, 3).join("\n") : "");
  return "E" + diagHash(msg + "|" + stack);
}

// ERR-YYYYMMDD-NNNN(UTC,当日四位序号,超过 9999 回绕)
export function diagErrorId(diag, at) {
  const d = diagEnsure(diag);
  const ts = at == null ? diagNowOf(d) : diagNum(at, diagNowOf(d));
  const day = new Date(ts).toISOString().slice(0, 10).replace(/-/g, "");
  if (d.id_day !== day) {
    d.id_day = day;
    d.id_seq = 0;
  }
  d.id_seq = diagNum(d.id_seq, 0) + 1;
  d.seq = diagNum(d.seq, 0) + 1;
  const n = ((d.id_seq - 1) % 10000) + 1;
  return "ERR-" + day + "-" + String(n).padStart(4, "0");
}

function diagMaskString(value) {
  let out = String(value);
  out = out.replace(/sk-[A-Za-z0-9_\-]{6,}/g, DIAG_MASK);
  out = out.replace(/\b[0-9a-fA-F]{32,}\b/g, DIAG_MASK);
  out = out.replace(/\b[A-Za-z0-9_\-]{48,}\b/g, DIAG_MASK);
  return out;
}

function diagSecretKey(key) {
  const k = String(key);
  return DIAG_SECRET_PATTERNS.some((re) => re.test(k));
}

function diagRedactValue(value, seen, depth) {
  if (value == null) return value;
  const t = typeof value;
  if (t === "string") return diagMaskString(value);
  if (t === "number" || t === "boolean" || t === "bigint") return value;
  if (t === "function") return "[function]";
  if (t === "symbol") return String(value);
  if (t !== "object") return null;
  if (depth > DIAG_REDACT_MAX_DEPTH) return "[depth]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const arr = value.map((v) => diagRedactValue(v, seen, depth + 1));
    seen.delete(value);
    return arr;
  }
  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = diagSecretKey(key) ? DIAG_MASK : diagRedactValue(value[key], seen, depth + 1);
  }
  seen.delete(value);
  return out;
}

// 深拷贝 + 脱敏:命中密钥键名的值掩码;字符串里的 sk-... / 长十六进制串也掩码
export function diagRedact(value) {
  return diagRedactValue(value, new WeakSet(), 0);
}

// 淘汰最旧的"非 P0"记录;P0 永不淘汰
function diagEvict(d) {
  const limit = diagNum(d.limits.errors, DIAG_DEFAULT_LIMITS.errors);
  while (d.errors.length > limit) {
    let victim = -1;
    let oldest = null;
    for (let i = 0; i < d.errors.length; i += 1) {
      const e = d.errors[i];
      if (e.p0 === true) continue;
      const at = diagNum(e.last_at, 0);
      if (oldest == null || at < oldest) { oldest = at; victim = i; }
    }
    if (victim < 0) break; // 剩下的全是 P0:宁可超限也不丢
    d.errors.splice(victim, 1);
  }
}

// 登记错误(去重):同一指纹只占一条,count 累加;ctx.p0 === true 额外进 p0_errors
export function captureError(diag, error, ctx) {
  const d = diagEnsure(diag);
  const context = ctx || {};
  const at = context.at == null ? diagNowOf(d) : diagNum(context.at, diagNowOf(d));
  const key = diagDedupeKey(error);
  const cls = classifyErrorZh(error);
  const isP0 = context.p0 === true;

  let rec = null;
  for (const e of d.errors) {
    if (e.key === key) { rec = e; break; }
  }
  if (rec) {
    rec.count += 1;
    rec.occurrences = rec.count;
    rec.last_at = at;
    if (isP0) rec.p0 = true;
  } else {
    rec = {
      id: diagErrorId(d, at),
      key: key,
      kind: cls.kind,
      zh: cls.zh,
      technical: cls.technical,
      count: 1,
      occurrences: 1,
      first_at: at,
      last_at: at,
      p0: isP0,
      context: diagRedact(context)
    };
    d.errors.push(rec);
  }

  d.counters.errors_total = diagNum(d.counters.errors_total, 0) + 1;
  d.counters.by_kind = d.counters.by_kind || {};
  d.counters.by_kind[cls.kind] = diagNum(d.counters.by_kind[cls.kind], 0) + 1;

  if (isP0) {
    let p0 = null;
    for (const e of d.p0_errors) {
      if (e.key === key) { p0 = e; break; }
    }
    if (!p0) {
      p0 = {
        id: rec.id,
        key: key,
        kind: cls.kind,
        zh: cls.zh,
        technical: cls.technical,
        count: 1,
        first_at: at,
        last_at: at,
        p0: true,
        context: diagRedact(context)
      };
      d.p0_errors.push(p0);
    } else {
      p0.count += 1;
      p0.last_at = at;
    }
  }

  diagEvict(d);
  return {
    id: rec.id,
    kind: rec.kind,
    zh: rec.zh,
    count: rec.count,
    first_at: rec.first_at,
    last_at: rec.last_at,
    occurrences: rec.occurrences,
    p0: rec.p0 === true,
    context: rec.context
  };
}

// 面包屑:环形缓冲,只留最近 N 条关键事件(进入BTC / K线加载 / Provider Timeout / Retry / Runtime Error ...)
export function diagBreadcrumb(diag, event) {
  const d = diagEnsure(diag);
  const e = event || {};
  const at = e.at == null ? diagNowOf(d) : diagNum(e.at, diagNowOf(d));
  const crumb = {
    at: at,
    kind: String(e.kind || "unknown"),
    detail: e.detail == null ? null : diagRedact(e.detail)
  };
  d.breadcrumbs.push(crumb);
  while (d.breadcrumbs.length > diagNum(d.limits.breadcrumbs, DIAG_DEFAULT_LIMITS.breadcrumbs)) {
    d.breadcrumbs.shift();
  }
  d.counters.breadcrumbs_total = diagNum(d.counters.breadcrumbs_total, 0) + 1;
  return crumb;
}

// 快照:app/runtime/model/schema 版本 + 页面/币种/模式 + 各 tick 时间 + 数据库/内存/网络
export function diagSnapshot(diag, values) {
  const d = diagEnsure(diag);
  const v = values && typeof values === "object" ? values : {};
  const snap = { at: v.at == null ? diagNowOf(d) : diagNum(v.at, diagNowOf(d)), ...diagRedact(v) };
  snap.at = v.at == null ? diagNowOf(d) : diagNum(v.at, diagNowOf(d));
  d.snapshots.push(snap);
  while (d.snapshots.length > diagNum(d.limits.snapshots, DIAG_DEFAULT_LIMITS.snapshots)) {
    d.snapshots.shift();
  }
  d.counters.snapshots_total = diagNum(d.counters.snapshots_total, 0) + 1;
  return snap;
}

function diagIso(at) {
  const n = diagNum(at, null);
  if (n == null) return "--";
  try { return new Date(n).toISOString(); } catch (_) { return "--"; }
}

function diagLineOf(error) {
  return "[" + error.id + "] " + error.zh + "(" + error.kind + ") · 同类出现 " + error.count
    + " 次 · 首次 " + diagIso(error.first_at) + " · 最近 " + diagIso(error.last_at);
}

// 人类可读文本:中文标题给用户看,技术详情单独成段给外部工具;全部已脱敏
function diagBuildText(safe) {
  const lines = [];
  lines.push("========== 系统诊断报告 ==========");
  lines.push("生成时间: " + diagIso(safe.generated_at));
  lines.push("");
  lines.push("--- 运行环境 ---");
  const metaKeys = Object.keys(safe.meta || {});
  if (!metaKeys.length) lines.push("(无元信息)");
  for (const k of metaKeys) {
    const v = safe.meta[k];
    lines.push(k + ": " + (v && typeof v === "object" ? JSON.stringify(v) : String(v)));
  }
  lines.push("");
  lines.push("--- 错误汇总(去重后 " + safe.errors.length + " 类) ---");
  if (!safe.errors.length) lines.push("(无错误)");
  for (const e of safe.errors) lines.push(diagLineOf(e));
  lines.push("");
  lines.push("--- P0 关键错误(资金/账本/崩溃,不参与淘汰) ---");
  if (!safe.p0_errors.length) lines.push("(无)");
  for (const e of safe.p0_errors) lines.push(diagLineOf(e));
  lines.push("");
  lines.push("--- 最近关键事件(面包屑) ---");
  if (!safe.breadcrumbs.length) lines.push("(无)");
  for (const c of safe.breadcrumbs) {
    lines.push(diagIso(c.at) + "  " + c.kind + (c.detail == null ? "" : "  " + (typeof c.detail === "object" ? JSON.stringify(c.detail) : String(c.detail))));
  }
  lines.push("");
  lines.push("--- 环境快照(最近 " + safe.snapshots.length + " 条) ---");
  if (!safe.snapshots.length) lines.push("(无)");
  for (const s of safe.snapshots) {
    const parts = Object.keys(s).filter((k) => k !== "at").map((k) => k + "=" + (s[k] && typeof s[k] === "object" ? JSON.stringify(s[k]) : String(s[k])));
    lines.push(diagIso(s.at) + "  " + parts.join(" "));
  }
  lines.push("");
  lines.push("--- 技术详情(仅供外部工具,已脱敏) ---");
  if (!safe.errors.length) lines.push("(无)");
  for (const e of safe.errors) {
    lines.push("[" + e.id + "] " + (e.technical || "").split("\n").slice(0, 4).join(" | "));
  }
  lines.push("========== 报告结束 ==========");
  return lines.join("\n");
}

// 一键导出:error/p0/breadcrumb/snapshot 全部去重 + 排序 + 脱敏;text 可直接复制给外部工具
export function diagExportBundle(diag, meta) {
  const d = diagEnsure(diag);
  const generatedAt = diagNowOf(d);
  const errors = (d.errors || []).slice().sort((a, b) => diagNum(a.first_at, 0) - diagNum(b.first_at, 0)).map((e) => diagRedact(e));
  const p0Errors = (d.p0_errors || []).slice().sort((a, b) => diagNum(a.first_at, 0) - diagNum(b.first_at, 0)).map((e) => diagRedact(e));
  const breadcrumbs = (d.breadcrumbs || []).map((c) => diagRedact(c));
  const snapshots = (d.snapshots || []).map((s) => diagRedact(s));
  const safeMeta = diagRedact(meta && typeof meta === "object" ? meta : {});
  const text = diagBuildText({
    generated_at: generatedAt,
    meta: safeMeta,
    errors: errors,
    p0_errors: p0Errors,
    breadcrumbs: breadcrumbs,
    snapshots: snapshots
  });
  return {
    version: DIAG_VERSION,
    generated_at: generatedAt,
    meta: safeMeta,
    errors: errors,
    p0_errors: p0Errors,
    breadcrumbs: breadcrumbs,
    snapshots: snapshots,
    text: text
  };
}

// 去重汇总:每个指纹一行,"同类错误出现 N 次"
export function diagDedupeSummary(diag) {
  const d = diagEnsure(diag);
  return (d.errors || []).slice()
    .sort((a, b) => diagNum(b.last_at, 0) - diagNum(a.last_at, 0))
    .map((e) => ({
      id: e.id,
      count: e.count,
      zh: e.zh,
      kind: e.kind,
      last_at: e.last_at,
      summary_zh: "同类错误出现 " + e.count + " 次"
    }));
}

// 中文视图:计数 + 最该关注的错误 + 最近面包屑
export function diagnosticsView(diag) {
  const d = diagEnsure(diag);
  const errors = (d.errors || []).slice().sort((a, b) => diagNum(b.count, 0) - diagNum(a.count, 0));
  const crumbs = (d.breadcrumbs || []).slice(-5);
  return {
    version: DIAG_VERSION,
    levels: DIAG_LEVELS,
    counts: {
      errors: (d.errors || []).length,
      p0_errors: (d.p0_errors || []).length,
      breadcrumbs: (d.breadcrumbs || []).length,
      snapshots: (d.snapshots || []).length,
      captured_total: diagNum(d.counters.errors_total, 0)
    },
    top_errors: errors.slice(0, 5).map((e) => ({
      id: e.id,
      zh: e.zh,
      kind: e.kind,
      count: e.count,
      p0: e.p0 === true,
      last_at: e.last_at,
      line_zh: diagLineOf(e)
    })),
    recent_breadcrumbs: crumbs.map((c) => ({ at: c.at, kind: c.kind, detail: c.detail })),
    latest_snapshot: (d.snapshots || []).length ? d.snapshots[d.snapshots.length - 1] : null,
    headline_zh: "错误 " + (d.errors || []).length + " 类(P0 " + (d.p0_errors || []).length
      + ") · 面包屑 " + (d.breadcrumbs || []).length + " 条 · 快照 " + (d.snapshots || []).length + " 份"
  };
}
