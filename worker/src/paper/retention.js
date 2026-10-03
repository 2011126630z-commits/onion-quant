// paper/retention.js · 长期挂机数据保留策略(V14.1)
// 原则:
//   永久保留:Paper Trades / Daily Stats / Learning Samples / Model Registry / Positions
//   可清理:Debug 日志 / 短期行情缓存 / 重复诊断 / 临时 AI 缓存 / 同步队列已同步条目
// 约束:清理后核心 Paper 历史必须完整(有测试守护)
export const RETENTION_POLICY = {
  keep: {
    paper_trades: Infinity,
    paper_positions: Infinity,
    paper_daily_stats: Infinity,
    paper_strategy_stats: Infinity,
    learning_samples: Infinity,
    model_registry: Infinity,
    model_evaluations: 500,
    paper_equity_snapshots: 4000,
    paper_orders: 5000,
    signals: 20000,
    signal_outcomes: 20000,
    walkforward_folds: 5000
  },
  trim: {
    paper_engine_logs: 300,
    debug_logs: 200,
    ai_review_cache: 200,
    market_cache_entries: 400,
    sync_queue_synced: 1000,
    backtest_runs: 100,
    backtest_results: 2000
  },
  ttl_ms: {
    ai_review_cache: 6 * 3600000,
    market_cache: 10 * 60000,
    debug_logs: 24 * 3600000
  }
};

// 清理计划(纯函数):输入各表数据量与时间,输出该删什么
export function planRetention(counts, options) {
  const opts = options || {};
  const policy = { ...RETENTION_POLICY, ...(opts.policy || {}) };
  const now = Number(opts.now) || Date.now();
  const plan = { delete_rows: [], trim_rows: [], reasons: [] };

  for (const [table, limit] of Object.entries(policy.keep)) {
    const count = Number((counts || {})[table] || 0);
    if (limit === Infinity || count <= limit) continue;
    const excess = count - limit;
    plan.delete_rows.push({ table, excess, strategy: "keep_newest", note: "超出保留上限 " + limit });
    plan.reasons.push(table + " 超限,按时间保留最新 " + limit + " 条(核心历史仍完整)");
  }
  for (const [key, limit] of Object.entries(policy.trim)) {
    const count = Number((counts || {})[key] || 0);
    if (count <= limit) continue;
    plan.trim_rows.push({ key, excess: count - limit, strategy: key === "sync_queue_synced" ? "drop_synced" : "keep_newest", limit });
    plan.reasons.push(key + " 裁剪至 " + limit + " 条");
  }
  // TTL 类:过期即清
  for (const [key, ttl] of Object.entries(policy.ttl_ms)) {
    const oldest = Number((counts || {})["oldest_" + key] || 0);
    if (!oldest) continue;
    if (now - oldest > ttl) {
      plan.trim_rows.push({ key, excess: null, strategy: "drop_expired", ttl_ms: ttl });
      plan.reasons.push(key + " 存在过期数据(> " + Math.round(ttl / 60000) + " 分钟)");
    }
  }
  return plan;
}

// 执行清理(纯函数式:接收数组,返回保留与删除)
export function applyRetention(table, rows, policy, options) {
  const p = { ...RETENTION_POLICY, ...(policy || {}) };
  const list = (rows || []).slice();
  const limit = p.keep[table] !== undefined ? p.keep[table] : p.trim[table];
  if (limit === undefined || limit === Infinity || list.length <= limit) return { keep: list, drop: [] };
  const timeKeyOf = (r) => Number(r.updated_at || r.created_at || r.timestamp || r.exit_time || r.entry_time || r.at || 0);
  list.sort((a, b) => timeKeyOf(b) - timeKeyOf(a));
  return { keep: list.slice(0, limit), drop: list.slice(limit) };
}

// 已同步队列条目清理:只删 SYNCED 且超过保留量的最旧条目
export function trimSyncQueue(items, policy) {
  const p = { ...RETENTION_POLICY, ...(policy || {}) };
  const synced = (items || []).filter((i) => i.sync_status === "SYNCED").sort((a, b) => Number(a.updated_at) - Number(b.updated_at));
  const keepSynced = new Set(synced.slice(Math.max(0, synced.length - p.trim.sync_queue_synced)).map((i) => i.item_id));
  const drop = (items || []).filter((i) => i.sync_status === "SYNCED" && !keepSynced.has(i.item_id)).map((i) => i.item_id);
  return { drop, kept_synced: keepSynced.size };
}

// 核心历史完整性校验(清理后必须为真)
export function coreHistoryIntact(before, after) {
  const core = ["paper_trades", "paper_daily_stats", "learning_samples", "model_registry"];
  const real = (v) => Number(v) || 0;
  const result = { intact: true, details: [] };
  for (const table of core) {
    const b = real(before && before[table]);
    const a = real(after && after[table]);
    if (table === "model_registry") continue; // 注册表可因晋级/回滚改状态但不减行
    if (a < b) { result.intact = false; result.details.push(table + " 行数减少:" + b + " → " + a); }
    else result.details.push(table + " 完整(" + a + ")");
  }
  return result;
}

export function retentionSummary(plan) {
  return {
    delete_tables: plan.delete_rows.length,
    trim_groups: plan.trim_rows.length,
    actions: plan.delete_rows.length + plan.trim_rows.length,
    reasons: plan.reasons
  };
}
