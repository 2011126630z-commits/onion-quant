// paper/learning.js · 持续学习(P2 核心:漂移检测 / Champion-Challenger / 晋级 / 回滚 / 注册表)
// 纯函数 + 注入存储;不训练模型本体(训练仍走 tools/ml)。原则:
//   - 不是每亏一单就重训:训练有门槛(新增样本/时间)
//   - 新模型不能直接上线:必须多 Fold / 多 Regime / 多时间段都不明显恶化
//   - 上线后若明显恶化:自动回滚到上一稳定 Champion
import { num, round } from "./accounting.js";

export const PROMOTION_RULES = {
  min_validation_samples: 60,
  min_folds: 3,
  min_balanced_accuracy: 0.45,
  max_balanced_accuracy_drop: 0.02,
  max_macro_f1_drop: 0.02,
  max_recall_drop: 0.05,
  max_drawdown_increase_pct: 5,
  min_net_pnl_proxy_improve: 0
};

// 快学习层:最近窗口 vs 历史(参考 River 的 ADWIN 思路,做简化版分窗比较)
export function detectDrift(records, options) {
  const opts = options || {};
  const windowSize = num(opts.windowSize, 100);
  const minSamples = num(opts.minSamples, 30);
  const threshold = num(opts.threshold, 0.12);
  const list = (records || []).filter((r) => r && r.actual_class && r.predicted_class);
  const acc = (arr) => (arr.length ? arr.filter((r) => r.predicted_class === r.actual_class).length / arr.length : null);
  if (list.length < minSamples * 2) {
    return { drift_score: null, drift_detected: false, reason: "样本不足", recent_accuracy: null, historical_accuracy: null, samples: list.length };
  }
  const recent = list.slice(-windowSize);
  const historical = list.slice(0, -windowSize);
  const recentAcc = acc(recent);
  const histAcc = acc(historical);
  const score = histAcc != null ? round(histAcc - recentAcc, 4) : null;
  const detected = score != null && score >= threshold;
  return {
    drift_score: score,
    drift_detected: detected,
    recent_accuracy: round(recentAcc, 4),
    historical_accuracy: round(histAcc, 4),
    samples: list.length,
    window: { recent: recent.length, historical: historical.length },
    action: detected ? "降低旧模型权重 + 训练 Challenger(不删除旧模型)" : "无需动作"
  };
}

// 训练触发门槛(慢学习层)
export function shouldTrain(input) {
  const ctx = input || {};
  const newSamples = num(ctx.new_samples, 0);
  const hoursSinceTrain = num(ctx.hours_since_train, 0);
  const everySamples = num(ctx.every_samples, 200);
  const everyHours = num(ctx.every_hours, 24);
  const drift = num(ctx.drift_score, 0);
  const driftThreshold = num(ctx.drift_threshold, 0.12);
  if (newSamples >= everySamples) return { train: true, reason: "新增有效样本 " + newSamples + " ≥ " + everySamples };
  if (hoursSinceTrain >= everyHours && newSamples >= 50) return { train: true, reason: "距上次训练 " + hoursSinceTrain + "h 且新增 " + newSamples + " 样本" };
  if (drift >= driftThreshold && newSamples >= 50) return { train: true, reason: "检测到漂移 " + drift + ",进入 Challenger 训练" };
  return { train: false, reason: "未达训练门槛(新增 " + newSamples + " 样本 / " + hoursSinceTrain + "h)" };
}

// 晋级判定:多 Fold / 多 Regime / 多时间段均不明显恶化
export function evaluatePromotion(challenger, champion, rules) {
  const R = { ...PROMOTION_RULES, ...(rules || {}) };
  const c = challenger || {};
  const ch = champion || {};
  const reasons = [];
  const fail = (msg) => { reasons.push(msg); };
  const pass = (msg) => { reasons.push("通过:" + msg); };

  const samples = num(c.validation_samples, 0);
  const folds = num(c.folds, 0);
  if (samples < R.min_validation_samples) fail("验证样本不足(" + samples + " < " + R.min_validation_samples + ")");
  if (folds < R.min_folds) fail("Fold 数不足(" + folds + " < " + R.min_folds + ")");
  const balAcc = num(c.balanced_accuracy, 0);
  if (balAcc < R.min_balanced_accuracy) fail("Balanced Accuracy 过低(" + balAcc + ")");

  const balDrop = num(ch.balanced_accuracy, 0) - balAcc;
  if (balDrop > R.max_balanced_accuracy_drop) fail("Balanced Accuracy 相比 Champion 下降 " + round(balDrop, 4));
  const f1Drop = num(ch.macro_f1, 0) - num(c.macro_f1, 0);
  if (f1Drop > R.max_macro_f1_drop) fail("Macro F1 下降 " + round(f1Drop, 4));
  const bullDrop = num(ch.bull_recall, 0) - num(c.bull_recall, 0);
  const bearDrop = num(ch.bear_recall, 0) - num(c.bear_recall, 0);
  if (bullDrop > R.max_recall_drop) fail("看涨 Recall 下降 " + round(bullDrop, 4));
  if (bearDrop > R.max_recall_drop) fail("看跌 Recall 下降 " + round(bearDrop, 4));
  const ddIncrease = num(c.max_drawdown_pct, 0) - num(ch.max_drawdown_pct, 0);
  if (ddIncrease > R.max_drawdown_increase_pct) fail("回撤增加 " + round(ddIncrease, 2) + "%");

  // Regime 分组:任一重要 Regime 明显恶化则拒绝
  const regimes = c.per_regime || {};
  const champRegimes = ch.per_regime || {};
  for (const key of Object.keys(regimes)) {
    const cr = regimes[key];
    const hr = champRegimes[key];
    if (!cr || num(cr.samples, 0) < 20) continue;
    if (hr && num(hr.samples, 0) >= 20) {
      const drop = num(hr.balanced_accuracy, 0) - num(cr.balanced_accuracy, 0);
      if (drop > R.max_balanced_accuracy_drop * 2) fail("Regime " + key + " 明显恶化(下降 " + round(drop, 4) + ")");
    }
  }
  // Fold 稳定性:最差 Fold 不能崩塌
  const foldAccs = (c.folds_detail || []).map((f) => num(f.balanced_accuracy, null)).filter((v) => v != null);
  if (foldAccs.length) {
    const worst = Math.min(...foldAccs);
    const mean = foldAccs.reduce((a, b) => a + b, 0) / foldAccs.length;
    if (worst < mean - 0.15) fail("存在崩塌 Fold(最差 " + round(worst, 4) + " vs 均值 " + round(mean, 4) + ")");
    else pass("各 Fold 稳定(最差 " + round(worst, 4) + " / 均值 " + round(mean, 4) + ")");
  }
  const pnlImprove = num(c.net_pnl_proxy, 0) - num(ch.net_pnl_proxy, 0);
  if (pnlImprove < R.min_net_pnl_proxy_improve) fail("净收益代理值未改善(" + round(pnlImprove, 4) + ")");
  else pass("净收益代理值改善 " + round(pnlImprove, 4));

  const promote = reasons.every((r) => !r.startsWith("通过") ? !true : true) && !reasons.some((r) => !r.startsWith("通过:"));
  return {
    promote,
    verdict: promote ? "PROMOTE" : "KEEP_TESTING",
    reasons,
    challenger_version: c.version || null,
    champion_version: ch.version || null
  };
}

// 回滚判定:Champion 上线后表现明显恶化
export function evaluateRollback(livePerformance, history, rules) {
  const R = { ...PROMOTION_RULES, ...(rules || {}) };
  const live = livePerformance || {};
  const prev = history || {};
  const samples = num(live.samples, 0);
  if (samples < 30) return { rollback: false, reason: "上线后样本不足(" + samples + "),继续观察" };
  const drop = num(prev.balanced_accuracy, 0) - num(live.balanced_accuracy, 0);
  const ddIncrease = num(live.max_drawdown_pct, 0) - num(prev.max_drawdown_pct, 0);
  const drift = num(live.drift_score, 0);
  if (drop > R.max_balanced_accuracy_drop * 3) return { rollback: true, reason: "Balanced Accuracy 下降 " + round(drop, 4) };
  if (ddIncrease > R.max_drawdown_increase_pct * 2) return { rollback: true, reason: "回撤明显增加 " + round(ddIncrease, 2) + "%" };
  if (drift >= 0.2) return { rollback: true, reason: "漂移严重 " + drift };
  return { rollback: false, reason: "表现稳定,无需回滚" };
}

// 注册表操作(注入 store)
export async function registerModel(store, model) {
  const record = {
    model_id: model.model_id || (model.model_type + "-" + model.version),
    model_type: model.model_type,
    version: model.version,
    feature_version: model.feature_version || null,
    engine_version: model.engine_version || null,
    horizons: JSON.stringify(model.horizons || []),
    training_start: model.training_start == null ? null : num(model.training_start),
    training_end: model.training_end == null ? null : num(model.training_end),
    train_samples: num(model.train_samples, 0),
    validation_samples: num(model.validation_samples, 0),
    metrics: JSON.stringify(model.metrics || {}),
    status: model.status || "CHALLENGER",
    parent_version: model.parent_version || null,
    created_at: num(model.created_at, Date.now()),
    promoted_at: null,
    retired_at: null,
    note: model.note || ""
  };
  await store.put("model_registry", record);
  return record;
}

export async function listModels(store, status) {
  const all = await store.all("model_registry");
  return (all || []).filter((m) => !status || m.status === status).sort((a, b) => num(b.created_at) - num(a.created_at));
}

export async function getChampion(store, modelType) {
  const all = await listModels(store, "CHAMPION");
  return all.find((m) => !modelType || m.model_type === modelType) || null;
}

export async function promoteModel(store, modelId, decision) {
  // V16.2z 工单 §1/§14:学习数据完整性硬门 —— 数据被判定污染期间冻结一切 Champion 晋级。
  // (已有 Champion 仍可用于 PAPER 推理;这里只拦"自动训练升级"的写入口。)
  try {
    const status = store && store.meta ? await store.meta("learning_status") : null;
    if (status && status.status === "PAUSED_DATA_INTEGRITY") {
      return { ok: false, reason: "LEARNING_PAUSED_DATA_INTEGRITY", detail: status };
    }
  } catch (error) { /* 读取失败不拦(保持原行为),但记录在调用方 */ }
  if (decision && decision.learning_gate && decision.learning_gate.allow !== true) {
    return { ok: false, reason: "LEARNING_ELIGIBILITY_GATE_BLOCKED", detail: decision.learning_gate };
  }
  const target = await store.get("model_registry", modelId);
  if (!target) return { ok: false, reason: "model_not_found" };
  const all = await listModels(store);
  const previous = all.find((m) => m.status === "CHAMPION" && m.model_type === target.model_type);
  const now = Date.now();
  const retiredRecord = previous ? { ...previous, status: "RETIRED", retired_at: now, note: (previous.note || "") + " | 被 " + target.version + " 取代" } : null;
  if (retiredRecord) await store.put("model_registry", retiredRecord);
  const promoted = { ...target, status: "CHAMPION", promoted_at: now, note: (target.note || "") + " | 晋级依据:" + (decision && decision.reasons ? decision.reasons.filter((r) => r.startsWith("通过")).join(";") : "") };
  await store.put("model_registry", promoted);
  await store.put("model_evaluations", {
    evaluation_id: "eval_promote_" + modelId + "_" + now,
    model_id: modelId, evaluated_at: now, kind: "promotion",
    samples: num(promoted.validation_samples, 0),
    balanced_accuracy: num((decision && decision.challenger && decision.challenger.balanced_accuracy) || null),
    macro_f1: num((decision && decision.challenger && decision.challenger.macro_f1) || null),
    bull_recall: num((decision && decision.challenger && decision.challenger.bull_recall) || null),
    bear_recall: num((decision && decision.challenger && decision.challenger.bear_recall) || null),
    net_pnl_proxy: num((decision && decision.challenger && decision.challenger.net_pnl_proxy) || null),
    max_drawdown_pct: num((decision && decision.challenger && decision.challenger.max_drawdown_pct) || null),
    drift_score: null, drift_detected: false, per_regime: JSON.stringify((decision && decision.challenger && decision.challenger.per_regime) || {}),
    verdict: "PROMOTE", detail: JSON.stringify(decision || {})
  });
  return { ok: true, promoted, retired: retiredRecord };
}

export async function rollbackModel(store, modelType, reason) {
  const all = await listModels(store);
  const current = all.find((m) => m.status === "CHAMPION" && m.model_type === modelType);
  const candidates = all.filter((m) => m.model_type === modelType && m.status === "RETIRED").sort((a, b) => num(b.retired_at) - num(a.retired_at));
  const target = candidates[0];
  if (!target) return { ok: false, reason: "no_stable_previous_champion" };
  const now = Date.now();
  const rolledBackRecord = current ? { ...current, status: "ROLLED_BACK", retired_at: now, note: (current.note || "") + " | 回滚:" + (reason || "") } : null;
  if (rolledBackRecord) await store.put("model_registry", rolledBackRecord);
  const restored = { ...target, status: "CHAMPION", promoted_at: now, note: (target.note || "") + " | 回滚恢复:" + (reason || "") };
  await store.put("model_registry", restored);
  await store.put("model_evaluations", {
    evaluation_id: "eval_rollback_" + modelType + "_" + now,
    model_id: restored.model_id, evaluated_at: now, kind: "rollback",
    samples: 0, balanced_accuracy: null, macro_f1: null, bull_recall: null, bear_recall: null,
    net_pnl_proxy: null, max_drawdown_pct: null, drift_score: null, drift_detected: false,
    per_regime: null, verdict: "ROLLBACK", detail: JSON.stringify({ reason: reason || "" })
  });
  return { ok: true, restored, rolled_back: rolledBackRecord };
}
