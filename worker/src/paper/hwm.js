// paper/hwm.js · V16 §8 · High-Water Mark 资金保护(纯函数,无 I/O)
// 不是和"最初的 100U"比,而是和历史总资金最高净值比:100 → 180 → 300 → 400(Peak=400),
// 400 → 320 就是 20% 回撤 —— 即使仍远高于初始资金,也必须当成重大风险事件。
// 硬性:
//   - 20% 是账户级最高保护线(HARD_STOP)
//   - 20% 不允许被单个坏报价误触发(需要数据可靠 + 账本健康 + 净值快照有效 + 连续确认)
//   - 确认后的 20% 回撤不允许因为"模型说会涨回来"继续新增风险
//   - 重启 / 升级 / 数据库迁移都不能重置 Peak(mergeHwm 只取更大值)
export const HWM_VERSION = "hwm-v1.0";
export const HWM_STATES = ["NORMAL", "CAUTION", "DEFENSIVE", "HARD_STOP", "RECOVERY"];
export const HWM_THRESHOLDS = {
  caution_pct: 5,     // 提醒
  defensive_pct: 10,  // 降低仓位 / 杠杆
  reduce_pct: 15,     // 明显减少新 Entry
  hard_stop_pct: 20   // 账户级最高保护线
};
export const HWM_CONFIRMATION = {
  required_samples: 3,       // 需要连续几轮确认
  window_ms: 15 * 60000,     // 确认窗口
  max_price_age_ms: 120000   // 净值快照最大允许陈旧时间
};
export const HWM_SCALES = { NORMAL: 1, CAUTION: 0.85, DEFENSIVE: 0.6, HARD_STOP: 0, RECOVERY: 0.3 };

export const HWM_STATE_ZH = {
  NORMAL: "正常", CAUTION: "注意", DEFENSIVE: "防守", HARD_STOP: "最高保护(停止新开仓)", RECOVERY: "恢复观察"
};

export const HWM_ACTIONS = {
  NORMAL: ["allow_new_entry"],
  CAUTION: ["allow_new_entry", "warn_user"],
  DEFENSIVE: ["allow_new_entry_scaled", "reduce_leverage", "warn_user"],
  HARD_STOP: ["block_new_entry", "block_add_position", "block_leverage_upgrade", "pause_model_promotion", "start_diagnostics", "manage_existing_positions"],
  RECOVERY: ["allow_new_entry_scaled", "require_verified_recovery", "manage_existing_positions"]
};

function hwmFnum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}
function hwmRound6(v) { return Math.round(hwmFnum(v) * 1e6) / 1e6; }

export function createHwmState(equity, at) {
  const e = Math.max(0, hwmFnum(equity, 0));
  return {
    version: HWM_VERSION,
    peak_equity: e,
    peak_at: hwmFnum(at, 0),
    equity: e,
    drawdown_pct: 0,
    state: "NORMAL",
    breach_samples: [],
    updated_at: hwmFnum(at, 0),
    hard_stop_at: null,
    hard_stop_equity: null,
    recovered_at: null,
    escalations: 0
  };
}

// Peak 合并:只取更大值 —— 重启 / 升级 / 迁移都不可能把水位改低
export function mergeHwm(previous, incoming) {
  const a = previous || {};
  const b = incoming || {};
  const peak = Math.max(hwmFnum(a.peak_equity, 0), hwmFnum(b.peak_equity, 0), hwmFnum(b.equity, 0));
  return {
    ...createHwmState(peak, hwmFnum(b.at, hwmFnum(a.updated_at, 0))),
    ...a,
    peak_equity: peak,
    peak_at: hwmFnum(a.peak_equity, 0) >= hwmFnum(b.peak_equity, 0) ? hwmFnum(a.peak_at, 0) : hwmFnum(b.at, 0),
    hard_stop_at: a.hard_stop_at != null ? a.hard_stop_at : (b.hard_stop_at != null ? b.hard_stop_at : null),
    hard_stop_equity: a.hard_stop_equity != null ? a.hard_stop_equity : (b.hard_stop_equity != null ? b.hard_stop_equity : null)
  };
}

export function drawdownFromPeak(peak, equity) {
  const p = hwmFnum(peak, 0);
  const e = hwmFnum(equity, 0);
  if (p <= 0) return 0;
  return hwmRound6(Math.max(0, (p - e) / p * 100));
}

export function classifyHwm(drawdownPct) {
  const d = hwmFnum(drawdownPct, 0);
  if (d >= HWM_THRESHOLDS.hard_stop_pct) return "HARD_STOP";
  if (d >= HWM_THRESHOLDS.defensive_pct) return "DEFENSIVE";
  if (d >= HWM_THRESHOLDS.caution_pct) return "CAUTION";
  return "NORMAL";
}

// 连续缩放:5% → 0.85,10% → 0.6,15% → 0.35,20% → 0(只是把"降低仓位/杠杆"做成分档而不是开关)
export function scaleForDrawdown(drawdownPct) {
  const d = Math.max(0, hwmFnum(drawdownPct, 0));
  if (d >= HWM_THRESHOLDS.hard_stop_pct) return 0;
  if (d >= HWM_THRESHOLDS.reduce_pct) return 0.35;
  if (d >= HWM_THRESHOLDS.defensive_pct) return 0.6;
  if (d >= HWM_THRESHOLDS.caution_pct) return 0.85;
  return 1;
}

// 数据可靠门(§8:20% 不许被单个坏报价误触发)
export function evidenceReliable(evidence) {
  const e = evidence || {};
  const reasons = [];
  if (e.price_data_reliable === false) reasons.push("行情数据不可靠");
  if (e.accounting_healthy === false) reasons.push("账本不自洽");
  if (e.equity_snapshot_valid === false) reasons.push("净值快照无效");
  if (e.provider_conflict === true) reasons.push("多源行情冲突");
  const age = hwmFnum(e.snapshot_age_ms, 0);
  if (age > HWM_CONFIRMATION.max_price_age_ms) reasons.push("净值快照过于陈旧");
  return { reliable: reasons.length === 0, reasons: reasons };
}

// 主更新:返回新状态 + 本轮动作。HARD_STOP 必须先通过"可靠 + 连续确认"才生效
export function updateHwm(state, input) {
  const o = input || {};
  const prev = state || createHwmState(o.equity, o.at);
  const at = hwmFnum(o.at, 0);
  const equity = Math.max(0, hwmFnum(o.equity, prev.equity));
  const peak = Math.max(hwmFnum(prev.peak_equity, 0), equity);
  const drawdown = drawdownFromPeak(peak, equity);
  const ev = evidenceReliable(o.evidence);
  const raw = classifyHwm(drawdown);
  const next = { ...prev, equity: equity, peak_equity: peak, peak_at: peak > hwmFnum(prev.peak_equity, 0) ? at : hwmFnum(prev.peak_at, 0), drawdown_pct: drawdown, updated_at: at };
  const scaleNow = (st) => (st === "RECOVERY" ? hwmFnum(HWM_SCALES.RECOVERY, 0.3) : scaleForDrawdown(drawdown));
  if (peak > hwmFnum(prev.peak_equity, 0)) next.peak_at = at;

  // 未达 20% → 直接按分级落状态;同时清空过期的待确认样本
  if (raw !== "HARD_STOP") {
    next.breach_samples = [];
    const target = prev.state === "RECOVERY" && drawdown < HWM_THRESHOLDS.caution_pct ? "NORMAL" : raw;
    if (prev.state === "HARD_STOP") {
      // 已经硬停了:不允许自动回到普通状态,必须走显式恢复流程
      next.state = "HARD_STOP";
    } else {
      next.state = target;
    }
    return {
      state: next,
      changed: next.state !== prev.state,
      drawdown_pct: drawdown,
      peak_equity: peak,
      reliable: ev.reliable,
      actions: HWM_ACTIONS[next.state] || [],
      scale: scaleNow(next.state),
      reason_zh: HWM_STATE_ZH[next.state]
    };
  }

  // 达到 20%:必须可靠 + 窗口内连续确认
  if (!ev.reliable) {
    next.state = prev.state === "HARD_STOP" ? "HARD_STOP" : "DEFENSIVE";
    next.breach_samples = prev.breach_samples || [];
    return {
      state: next,
      changed: next.state !== prev.state,
      drawdown_pct: drawdown,
      peak_equity: peak,
      reliable: false,
      actions: HWM_ACTIONS[next.state] || [],
      scale: scaleNow(next.state),
      reason_zh: "疑似 20% 回撤但证据不可靠,暂不升级:" + ev.reasons.join("、")
    };
  }
  const samples = (prev.breach_samples || []).filter((s) => at - hwmFnum(s.at, 0) <= HWM_CONFIRMATION.window_ms);
  samples.push({ at: at, equity: equity, drawdown_pct: drawdown });
  next.breach_samples = samples;
  if (samples.length >= HWM_CONFIRMATION.required_samples || prev.state === "HARD_STOP") {
    next.state = "HARD_STOP";
    next.hard_stop_at = prev.hard_stop_at == null ? at : prev.hard_stop_at;
    next.hard_stop_equity = prev.hard_stop_equity == null ? equity : prev.hard_stop_equity;
    next.escalations = hwmFnum(prev.escalations, 0) + (prev.state === "HARD_STOP" ? 0 : 1);
    return {
      state: next,
      changed: next.state !== prev.state,
      drawdown_pct: drawdown,
      peak_equity: peak,
      reliable: true,
      actions: HWM_ACTIONS.HARD_STOP,
      scale: 0,
      confirmed: true,
      reason_zh: "确认账户级回撤 " + drawdown + "%,触发最高保护:禁止新开仓 / 加仓 / 杠杆升档"
    };
  }
  next.state = "DEFENSIVE";
  return {
    state: next,
    changed: next.state !== prev.state,
    drawdown_pct: drawdown,
    peak_equity: peak,
    reliable: true,
    actions: HWM_ACTIONS.DEFENSIVE,
    scale: hwmFnum(HWM_SCALES.DEFENSIVE, 0.6),
    confirmed: false,
    waiting: HWM_CONFIRMATION.required_samples - samples.length,
    reason_zh: "回撤 " + drawdown + "%,等待连续确认(" + samples.length + "/" + HWM_CONFIRMATION.required_samples + ")"
  };
}

// HARD STOP 后的动作闸门:新开仓 / 加仓 / 杠杆升档 / 模型 Promote 全部禁止
export function hardStopGate(state) {
  const s = state || {};
  const hard = s.state === "HARD_STOP";
  return {
    hard_stop: hard,
    block_new_entry: hard,
    block_add_position: hard,
    block_leverage_upgrade: hard,
    block_model_promotion: hard,
    allow_position_management: true, // 已有仓位的 Risk / Stop / Reduce / Exit 永远允许
    start_diagnostics: hard,
    reason_zh: hard ? "账户级最高保护生效中" : "正常"
  };
}

export const HWM_RECOVERY_REQUIREMENTS = {
  data_ok: "行情数据正常",
  reconcile_ok: "账户对账一致",
  runtime_ok: "运行时正常",
  risk_ok: "风控正常",
  explicit: "显式确认恢复"
};

export function recoveryChecklist(checks) {
  const c = checks || {};
  const missing = Object.keys(HWM_RECOVERY_REQUIREMENTS).filter((k) => !c[k]);
  return { ok: missing.length === 0, missing: missing, missing_zh: missing.map((k) => HWM_RECOVERY_REQUIREMENTS[k]) };
}

// 恢复:必须显式通过全部检查,且从 RECOVERY 开始(不允许一步回到 NORMAL)
export function recoverFromHardStop(state, checks, at) {
  const prev = state || {};
  const chk = recoveryChecklist(checks);
  if (prev.state !== "HARD_STOP") return { ok: false, reason: "not_in_hard_stop", state: prev };
  if (!chk.ok) return { ok: false, reason: "requirements_not_met", missing: chk.missing, missing_zh: chk.missing_zh, state: prev };
  const next = {
    ...prev,
    state: "RECOVERY",
    recovered_at: hwmFnum(at, 0),
    breach_samples: []
  };
  return { ok: true, state: next, reason: "recovery_started", reason_zh: "已进入恢复观察期(仓位按 30% 上限)" };
}

// 水位持久化记录:迁移 / 升级后必须能原样恢复
export function hwmRecord(state) {
  const s = state || {};
  return {
    version: HWM_VERSION,
    peak_equity: hwmFnum(s.peak_equity, 0),
    peak_at: hwmFnum(s.peak_at, 0),
    state: s.state || "NORMAL",
    drawdown_pct: hwmFnum(s.drawdown_pct, 0),
    hard_stop_at: s.hard_stop_at == null ? null : hwmFnum(s.hard_stop_at),
    hard_stop_equity: s.hard_stop_equity == null ? null : hwmFnum(s.hard_stop_equity),
    recovered_at: s.recovered_at == null ? null : hwmFnum(s.recovered_at)
  };
}

export function hwmView(state) {
  const s = state || createHwmState(0, 0);
  return {
    peak: s.peak_equity,
    equity: s.equity,
    drawdown_pct: Math.round(hwmFnum(s.drawdown_pct) * 100) / 100,
    state: s.state,
    state_zh: HWM_STATE_ZH[s.state] || s.state,
    hard_stop: s.state === "HARD_STOP"
  };
}
