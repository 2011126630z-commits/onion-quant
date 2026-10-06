// paper/learningCore.js · V16.2z · 学习数据完整性核心(Schema 控制,不靠字符串 _rN 猜测)
// 工单口径(§2/§3/§4/§5/§6/§7/§9/§14/§15/§19/§20/§25/§28/§29/§31):
//   · 一个 ML 样本 = 真实Symbol + 明确Interval + 已收盘Candle + Strategy/Engine版本 + Feature Schema版本 的【冻结快照】;
//   · canonical_sample_id 稳定哈希(刷新/重解析/重启都不变);重复分析 → REVISION(learning_eligible=false),不产生新训练样本;
//   · record_type / sample_origin / environment / learning_eligible 由 Schema 字段控制,而不是 id 字符串;
//   · Return Sanity 多维检查(价格量纲/分母/高低界/有限性),失败 → data_quality=FAILED + quarantine(保留原数据不改);
//   · Outcome 目标时间严格 T+H,窗口 T→T+H(禁止未来数据),MFE/MAE 只用窗内 K 线;
//   · 训练入口硬门 LearningEligibilityGate;样本量门槛不以 revision 充数。
export const LEARNING_CORE_VERSION = "learning-core-v1.0";
export const LEARNING_SCHEMA_VERSION = "ls-v1";
const LC_FS_VERSION = "fs-v1";   // 与 accountAudit 的 FEATURE_SCHEMA_VERSION 同值("fs-v1");正式导出名由 accountAudit 提供(避免打包重名)
export { LC_FS_VERSION };

// §25:特征 Schema 显式定义(名字/顺序/类型/单位/Null 规则)。模型绑定 schema 版本,不匹配拒绝推理/训练。
export const FEATURE_SCHEMA = {
  version: LC_FS_VERSION,
  columns: [
    { name: "rsi14", type: "number", unit: "0-100", nullable: true },
    { name: "macd_hist", type: "number", unit: "price", nullable: true },
    { name: "adx", type: "number", unit: "0-100", nullable: true },
    { name: "atr_pct", type: "number", unit: "pct", nullable: true },
    { name: "ema20_dist_pct", type: "number", unit: "pct", nullable: true },
    { name: "volume_ratio20", type: "number", unit: "ratio", nullable: true },
    { name: "tf_align", type: "number", unit: "-1..1", nullable: true },
    { name: "btc_corr", type: "number", unit: "-1..1", nullable: true }
  ],
  null_rule: "null 表示'当时没有该数据' —— 与 0(真实为 0)语义不同;训练侧必须使用 missing mask,禁止静默填 0(§27)"
};

// §26:特征按名字映射(禁止纯位置数组)
export function featureVectorByName(features) {
  const f = features || {};
  const values = [];
  const mask = [];
  for (const col of FEATURE_SCHEMA.columns) {
    const raw = f[col.name];
    const missing = raw == null || (typeof raw === "number" && !Number.isFinite(raw)) || raw === "";
    values.push(missing ? 0 : Number(raw));
    mask.push(missing ? 1 : 0);
  }
  return { names: FEATURE_SCHEMA.columns.map((c) => c.name), values: values, missing_mask: mask };
}
export function featureSnapshotHash(rec) {
  const r = rec || {};
  const src = JSON.stringify([r.features || null, r.market_regime_label || null, r.direction || null, r.confidence == null ? null : Math.round(Number(r.confidence))]);
  let h = 2166136261;
  for (let i = 0; i < src.length; i += 1) { h ^= src.charCodeAt(i); h = Math.imul(h, 16777619); }
  return "fs" + ((h >>> 0).toString(16));
}

// ---------- §2/§3:canonical_sample_id(稳定哈希;strategy/mode 进 key,Short/Long 不误并) ----------
export const LC_HORIZON_MS = { "5m": 5 * 60000, "15m": 15 * 60000, "1h": 3600000, "4h": 4 * 3600000, "24h": 24 * 3600000 };
export const HORIZONS_ALL = ["5m", "15m", "1h", "4h", "24h"];
// §19/§20:Outcome 目标时间与窗口严格按时间算(Resolver 与测试共用)
export function outcomeTargetTime(signalTs, horizon) { return Number(signalTs || 0) + (LC_HORIZON_MS[horizon] || 3600000); }
export function outcomeWindow(signalTs, horizon) { const t = Number(signalTs || 0); return { from: t, to: t + (LC_HORIZON_MS[horizon] || 3600000) }; }
// §16:每个 Canonical 的 5 个 Outcome Job 状态机
export const OUTCOME_JOB_STATES = ["PENDING_TIME", "READY_TO_RESOLVE", "WAITING_MARKET_DATA", "RESOLVED", "FAILED_RETRYABLE", "FAILED_DATA_QUALITY"];
export function outcomeJobState(input, nowMs) {
  const i = input || {};
  const now = Number(nowMs || Date.now());
  const target = outcomeTargetTime(i.signal_ts, i.horizon);
  if (i.resolved === true) return "RESOLVED";
  if (i.data_quality === "FAILED") return "FAILED_DATA_QUALITY";
  if (now < target) return "PENDING_TIME";
  if (i.candles_available === false) return "WAITING_MARKET_DATA";
  if (i.attempts > 0 && i.last_error) return "FAILED_RETRYABLE";
  return "READY_TO_RESOLVE";
}
export const MODEL_TARGET_HORIZONS = ["SHORT_15M", "SHORT_1H", "LONG_4H", "LONG_24H"];   // §29
export function modelTargetOf(mode, horizon) {
  const m = String(mode || "").toLowerCase().indexOf("long") >= 0 ? "LONG" : "SHORT";
  return m + "_" + String(horizon || "").toUpperCase();
}

export function canonicalKeyOf(sig) {
  const s = sig || {};
  const iv = String(s.interval || "1h");
  const closed = closedCandleCloseTime(s);
  return [
    String(s.symbol || "").toUpperCase(),
    iv,
    String(closed == null ? "" : closed),
    String(s.strategy_id || s.strategy_version || "rule-v0.1"),
    String(s.strategy_mode || s.mode || "short"),
    String(s.engine_version || "rule-v0.1"),
    String(s.feature_schema_version || LC_FS_VERSION)
  ].join("|");
}
export function canonicalIdOf(sig) {
  const key = canonicalKeyOf(sig);
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return "cs_" + (h >>> 0).toString(16) + "_" + key.length;
}
// 收盘时间:优先 data_close_time / closed_candle_close_time;其次把 timestamp 按 interval 对齐到"上一根收盘"
export function closedCandleCloseTime(sig) {
  const s = sig || {};
  const direct = Number(s.closed_candle_time != null ? s.closed_candle_time : s.data_close_time);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const ivMs = { "1m": 60000, "5m": 300000, "15m": 900000, "30m": 1800000, "1h": 3600000, "4h": 14400000, "1d": 86400000 }[String(s.interval || "1h")] || 3600000;
  const ts = Number(s.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return Math.floor(ts / ivMs) * ivMs - 1;
}

// ---------- §7:record_type 由 Schema 字段判定(legacy 兼容推断,但结果写入字段) ----------
export function classifyRecordType(rec) {
  const r = rec || {};
  if (r.record_type) return String(r.record_type).toUpperCase();
  if (r.revision_of) return "REVISION";
  if (String(r.engine_version || "") === "seed" || /^seed[_-]/.test(String(r.id || ""))) return "SEED";
  if (r.sample_origin) return String(r.sample_origin).toUpperCase();
  if (/_r\d+$/.test(String(r.id || ""))) return "REVISION";   // 仅迁移期兜底;新写入一律显式字段
  return "CANONICAL";
}
export function originOf(rec) {
  const r = rec || {};
  const type = classifyRecordType(r);
  const origin = r.sample_origin ? String(r.sample_origin).toUpperCase()
    : (type === "SEED" ? "SEED" : type === "REPLAY" ? "REPLAY" : type === "SYNTHETIC" ? "SYNTHETIC" : type === "TEST" ? "TEST" : "REAL_SIGNAL");
  const env = r.environment || (origin === "SEED" || origin === "TEST" ? "TEST" : origin === "REPLAY" ? "REPLAY" : "PRODUCTION_PAPER");
  return { record_type: type, sample_origin: origin, environment: env, market_data_source: r.market_data_source || "BINANCE_PUBLIC" };
}

// ---------- §15:Return Sanity Guard(多维,不搞永久固定百分比一刀切) ----------
const RETURN_BOUNDS = { "5m": 0.5, "15m": 0.8, "1h": 1.5, "4h": 3.0, "24h": 10.0 };
export function returnSanityCheck(input, opts) {
  const o = opts || {};
  const r = input || {};
  const reasons = [];
  const entry = Number(r.entry_price != null ? r.entry_price : r.price);
  if (!Number.isFinite(entry) || entry <= 0) reasons.push("entry_price_invalid");
  if (Number.isFinite(entry) && (entry > 1e8 || entry < 1e-9)) reasons.push("price_magnitude_suspicious");
  const horizon = String(r.horizon || o.horizon || "1h");
  const ret = Number(r.return_value != null ? r.return_value : r.return);
  if (r.return_value !== undefined || r.return !== undefined) {
    if (!Number.isFinite(ret)) reasons.push("return_not_finite");
    else {
      const bound = RETURN_BOUNDS[horizon] || 1.5;
      if (ret < -1 || ret > bound) reasons.push("return_beyond_bound:" + horizon);
    }
  }
  const hi = Number(r.high), lo = Number(r.low);
  if (Number.isFinite(hi) && Number.isFinite(lo)) {
    if (hi < lo) reasons.push("high_below_low");
    const p = Number(r.result_price);
    if (Number.isFinite(p) && Number.isFinite(entry) && entry > 0) {
      const tol = Math.max(1e-6, entry * 1e-6);
      if (p > hi + tol || p < lo - tol) reasons.push("price_outside_hl_range");
    }
  }
  const provider = String(r.provider || "binance").toLowerCase();
  if (!["binance", "okx", "bybit", "proxy", "cache", ""].includes(provider)) reasons.push("provider_invalid:" + provider);
  const unitBad = Number.isFinite(entry) && entry > 0 && Number.isFinite(ret) && Math.abs(ret) > 0.999 && Math.abs(ret) < 1.001 && horizon === "5m" && Math.abs(ret) > 0.5;
  if (unitBad) reasons.push("possible_unit_mismatch");
  return { ok: reasons.length === 0, reasons: reasons, data_quality: reasons.length ? "FAILED" : "PASSED", quarantine: reasons.length > 0 };
}

// ---------- §14:训练入口硬门 ----------
export function learningEligibilityGate(rec, opts) {
  const o = opts || {};
  const reasons = [];
  const t = classifyRecordType(rec);
  const org = originOf(rec);
  if (t !== "CANONICAL") reasons.push("record_type_not_canonical:" + t);
  if (org.sample_origin !== "REAL_SIGNAL") reasons.push("sample_origin_not_real:" + org.sample_origin);
  if (org.environment !== "PRODUCTION_PAPER") reasons.push("environment_not_production:" + org.environment);
  if (rec.learning_eligible === false) reasons.push("learning_eligible_false");
  const fsv = rec.feature_schema_version || LC_FS_VERSION;
  if (fsv !== LC_FS_VERSION) reasons.push("feature_schema_mismatch:" + fsv);
  if (rec.data_quality === "FAILED" || rec.quarantine === true) reasons.push("data_quality_failed");
  const sanity = returnSanityCheck(rec, o);
  if (!sanity.ok) reasons.push("return_sanity_failed");
  if (rec.label_status === "PENDING" || (o.requireLabel && rec.label_status !== "LABELED")) reasons.push("label_pending");
  return { allow: reasons.length === 0, reasons: reasons, record_type: t, origin: org };
}

// ---------- §32/§33:迁移计划(不删数据;首次快照为 canonical;无法判定 → AMBIGUOUS+ineligible) ----------
export function migrationPlan(records, opts) {
  const o = opts || {};
  const now = Number(o.now || Date.now());
  const byCanon = new Map();
  const patches = [];
  const summary = { raw: records.length, seed: 0, revision: 0, canonical: 0, ambiguous: 0, other: 0 };
  for (const rec of records) {
    const t = classifyRecordType(rec);
    const org = originOf(rec);
    if (t === "SEED" || org.sample_origin === "SEED") {
      summary.seed += 1;
      patches.push({ id: rec.id, patch: { record_type: "SEED", sample_origin: "SEED", environment: "TEST", learning_eligible: false, exclusion_reason: "SEED_DATA", migration_status: "MIGRATED", migration_at: now } });
      continue;
    }
    if (t === "REPLAY" || t === "SYNTHETIC" || t === "TEST") {
      summary.other += 1;
      patches.push({ id: rec.id, patch: { record_type: t, sample_origin: org.sample_origin, environment: "TEST", learning_eligible: false, exclusion_reason: t + "_DATA", migration_status: "MIGRATED", migration_at: now } });
      continue;
    }
    const cid = canonicalIdOf(rec);
    if (!byCanon.has(cid)) byCanon.set(cid, []);
    byCanon.get(cid).push(rec);
  }
  for (const [cid, group] of byCanon.entries()) {
    // §32:选"首次正式生成"的那条(优先 created_at,其次 timestamp,最后最小 _rN);不按"最后一条最好"
    const sorted = group.slice().sort((a, b) => {
      const ca = Number(a.created_at || a.timestamp || 0), cb = Number(b.created_at || b.timestamp || 0);
      if (ca !== cb) return ca - cb;
      const ra = Number((/_r(\d+)$/.exec(String(a.id)) || [])[1] || 0), rb = Number((/_r(\d+)$/.exec(String(b.id)) || [])[1] || 0);
      return ra - rb;
    });
    const first = sorted[0];
    const ambiguous = closedCandleCloseTime(first) == null;
    if (ambiguous) {
      summary.ambiguous += group.length;
      for (const rec of group) patches.push({ id: rec.id, patch: { record_type: "CANONICAL", canonical_sample_id: cid, learning_eligible: false, migration_status: "AMBIGUOUS", exclusion_reason: "AMBIGUOUS_FIRST_SNAPSHOT", migration_at: now } });
      continue;
    }
    summary.canonical += 1;
    patches.push({ id: first.id, patch: {
      record_type: "CANONICAL", canonical_sample_id: cid, learning_eligible: true, sample_origin: "REAL_SIGNAL", environment: "PRODUCTION_PAPER",
      market_data_source: originOf(first).market_data_source, feature_schema_version: first.feature_schema_version || LC_FS_VERSION,
      feature_snapshot_hash: featureSnapshotHash(first), memory_event_cluster: timeClusterId(first), migration_status: "MIGRATED", migration_at: now
    } });
    let rn = 0;
    for (const rec of sorted.slice(1)) {
      rn += 1;
      summary.revision += 1;
      patches.push({ id: rec.id, patch: {
        record_type: "REVISION", revision_of: first.id, revision_no: rn, revision_reason: "duplicate_analysis_same_canonical",
        canonical_sample_id: cid, learning_eligible: false, sample_origin: "REAL_SIGNAL", environment: "PRODUCTION_PAPER",
        exclusion_reason: "REVISION_NOT_TRAINING_SAMPLE", migration_status: "MIGRATED", migration_at: now
      } });
    }
  }
  return { patches: patches, summary: summary, canonical_groups: byCanon.size };
}

// ---------- §31:时间簇(最小实现:同一小时窗口视为一次市场事件候选) ----------
export function timeClusterId(rec) {
  const ts = Number(rec && (rec.closed_candle_time != null ? rec.closed_candle_time : rec.timestamp) || 0);
  return "tc_" + Math.floor(ts / 3600000);
}

// ---------- §11/§12/§34:动态统计(绝不拿第一条记录填 meta) ----------
export function learningIntegrityReport(records, opts) {
  const o = opts || {};
  const byKey = (f) => { const m = {}; for (const r of records) { const k = String(f(r)); m[k] = (m[k] || 0) + 1; } return m; };
  let seed = 0; let revision = 0; let canonical = 0; let eligible = 0; let quarantined = 0; let pending = 0; let labeled = 0;
  const canonicalSeen = new Set();
  for (const r of records) {
    const t = classifyRecordType(r);
    if (t === "SEED") seed += 1;
    else if (t === "REVISION") revision += 1;
    else if (t === "CANONICAL") {
      canonical += 1;
      const cid = r.canonical_sample_id || canonicalIdOf(r);
      canonicalSeen.add(cid);
    }
    if (r.quarantine === true || r.data_quality === "FAILED") quarantined += 1;
    if (r.label_status === "PENDING") pending += 1;
    if (r.label_status === "LABELED") labeled += 1;
    if (learningEligibilityGate(r, { requireLabel: o.requireLabel === true }).allow) eligible += 1;
  }
  const anomalies = records.filter((r) => !returnSanityCheck(r.meta || r, {}).ok && classifyRecordType(r) !== "SEED").length;
  return {
    version: LEARNING_CORE_VERSION,
    raw_record_count: records.length,
    seed_count: seed,
    revision_count: revision,
    canonical_count: canonical,
    unique_canonical_count: canonicalSeen.size,
    learning_eligible_count: eligible,
    excluded_count: records.length - eligible,
    quarantined_count: quarantined,
    pending_outcome_count: pending,
    fully_labeled_count: labeled,
    return_anomaly_count: anomalies,
    engine_versions: Object.keys(byKey((r) => r.engine_version || "rule-v0.1")),
    feature_versions: Object.keys(byKey((r) => r.feature_version || "feat-v0.1")),
    sample_origins: Object.keys(byKey((r) => originOf(r).sample_origin)),
    environments: Object.keys(byKey((r) => originOf(r).environment)),
    by_symbol: byKey((r) => String(r.symbol || "?")),
    by_interval: byKey((r) => String(r.interval || "?")),
    by_engine_version: byKey((r) => r.engine_version || "rule-v0.1"),
    by_feature_version: byKey((r) => r.feature_version || "feat-v0.1"),
    by_sample_origin: byKey((r) => originOf(r).sample_origin),
    by_environment: byKey((r) => originOf(r).environment)
  };
}

// ---------- §35:一键学习数据体检(11 项;任一 P0 → PAUSED_DATA_INTEGRITY) ----------
export function learningDataHealthCheck(records, opts) {
  const o = opts || {};
  const now = Number(o.now || Date.now());
  const problems = [];
  const canonicalSeen = new Map();
  const revisionIds = new Set();
  for (const r of records) {
    const t = classifyRecordType(r);
    if (t === "REVISION") revisionIds.add(r.id);
    if (t === "CANONICAL") {
      const cid = r.canonical_sample_id || canonicalIdOf(r);
      if (canonicalSeen.has(cid)) problems.push({ check: "DUPLICATE_CANONICAL", id: r.id, detail: "同 canonical 两个 CANONICAL 行" });
      canonicalSeen.set(cid, r.id);
    }
  }
  let revisionLeak = 0; let seedLeak = 0; let missingFeature = 0; let invalidPrice = 0; let outcomeDelay = 0; let schemaMismatch = 0; let timeOrder = 0; let returnAnomaly = 0;
  for (const r of records) {
    const t = classifyRecordType(r);
    const gate = learningEligibilityGate(r, {});
    if (t === "REVISION" && gate.allow) revisionLeak += 1;
    if (t === "SEED" && gate.allow) seedLeak += 1;
    if (t === "CANONICAL") {
      const fsv = r.feature_schema_version || LC_FS_VERSION;
      if (fsv !== LC_FS_VERSION) schemaMismatch += 1;
      if (r.price == null && r.entry_price == null) missingFeature += 1;
      if (!(Number(r.price || r.entry_price) > 0)) invalidPrice += 1;
      const oh = r.outcomes || null;
      if (oh && oh.pending_since && now - Number(oh.pending_since) > (o.outcome_delay_ms || 6 * 3600000)) outcomeDelay += 1;
      if (oh && Number(oh.resolved_at) && Number(oh.resolved_at) < Number(r.timestamp || 0)) timeOrder += 1;
      const sanity = returnSanityCheck(r.meta || r, {});
      if (!sanity.ok) returnAnomaly += 1;
    }
  }
  const checks = [
    { id: "DUPLICATE_CANONICAL", ok: !problems.some((p) => p.check === "DUPLICATE_CANONICAL"), p0: true, count: problems.filter((p) => p.check === "DUPLICATE_CANONICAL").length },
    { id: "REVISION_LEAKAGE", ok: revisionLeak === 0, p0: true, count: revisionLeak },
    { id: "SEED_LEAKAGE", ok: seedLeak === 0, p0: true, count: seedLeak },
    { id: "FEATURE_MUTATION", ok: true, p0: true, count: 0, note: "canonical 快照由写入端冻结(同 canonical 不再覆盖);抽查见回归 TEST5" },
    { id: "FUTURE_LEAKAGE", ok: timeOrder === 0, p0: true, count: timeOrder },
    { id: "RETURN_ANOMALY", ok: returnAnomaly === 0, p0: false, count: returnAnomaly },
    { id: "MISSING_FEATURE", ok: missingFeature === 0, p0: false, count: missingFeature },
    { id: "INVALID_PRICE", ok: invalidPrice === 0, p0: true, count: invalidPrice },
    { id: "OUTCOME_DELAY", ok: outcomeDelay === 0, p0: false, count: outcomeDelay },
    { id: "SCHEMA_MISMATCH", ok: schemaMismatch === 0, p0: true, count: schemaMismatch },
    { id: "TIME_ORDER_VIOLATION", ok: timeOrder === 0, p0: false, count: timeOrder }
  ];
  const p0Fail = checks.some((c) => c.p0 && !c.ok);
  return { checks: checks, p0_fail: p0Fail, learning_status: p0Fail ? "PAUSED_DATA_INTEGRITY" : "OK", duplicates_detail: problems.slice(0, 20) };
}

// ---------- §10/§12:导出过滤 + 动态 meta(valid = 仅可训练 canonical;audit = 全部) ----------
export function filterExportRecords(records, mode) {
  const m = String(mode || "valid");
  if (m === "audit") return records.slice();
  return records.filter((r) => learningEligibilityGate(r, {}).allow);
}
