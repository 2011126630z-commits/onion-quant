// paper/drawdown.js · Drawdown Controller(V14.4)
// §48-§58, §83, §84:回撤控制升级 —— 不是一个 boolean,而是状态机 + 渐进恢复。
//
// 关键点:
//   - Peak Equity 来自真实账户(portfolio 维护),当前回撤 = (peak - equity)/peak,不拿初始资金硬算(§49)
//   - 状态:NORMAL → CAUTION → DEFENSIVE → HARD_STOP,恢复走 RECOVERY(逐级)(§50-§55)
//   - 升级要快(风险优先),降级要慢(需要冷却 + 新样本 + 风险恢复)(§55)
//   - 账户做大后反而降低激进度,保护已积累净值(§56/§57/§58)
//   - 全部为纯函数/可注入时钟,同一输入同一输出(可测试)
import { num, round, summarizeTrades, dayKeyOf } from "./accounting.js";

export const DRAWDOWN_VERSION = "drawdown-v14.4";
export const DRAWDOWN_STATES = ["NORMAL", "CAUTION", "DEFENSIVE", "HARD_STOP", "RECOVERY"];

// 严重度排序:刻意与 DRAWDOWN_STATES 的数组顺序解耦
// (RECOVERY 是"受限但非危机"状态:比 DEFENSIVE 更严,但轻于 HARD_STOP,
//  否则会出现"恢复期恶化时无法升级"的死角)
export const DRAWDOWN_RANK = { NORMAL: 0, CAUTION: 1, DEFENSIVE: 2, RECOVERY: 3, HARD_STOP: 4 };

// §48:多维度回撤阈值(百分比)
export const DRAWDOWN_THRESHOLDS = {
  caution: 3,
  defensive: 7,
  hard_stop: 12,
  daily_caution: 2,
  daily_defensive: 4,
  daily_hard_stop: 6,
  pool_caution: 5,
  pool_defensive: 10,
  pool_hard_stop: 15
};

// 各状态的动作参数(§52/§53/§54)
export const DRAWDOWN_ACTIONS = {
  NORMAL: { risk_scale: 1, leverage_cap: 10, min_confidence: 0, allow_new_positions: true, profit_lock_bias: 0, note: "策略按正常 Risk Budget 运行" },
  CAUTION: { risk_scale: 0.7, leverage_cap: 5, min_confidence: 55, allow_new_positions: true, profit_lock_bias: 0.15, note: "回撤开始扩大:降仓位/降杠杆上限/提高锁定" },
  DEFENSIVE: { risk_scale: 0.4, leverage_cap: 3, min_confidence: 68, allow_new_positions: true, profit_lock_bias: 0.3, note: "回撤继续恶化:进一步降杠杆与仓位,禁止激进加仓" },
  HARD_STOP: { risk_scale: 0, leverage_cap: 1, min_confidence: 101, allow_new_positions: false, profit_lock_bias: 0.5, note: "达到硬阈值:停止所有新开仓,只允许持仓管理与退出" },
  RECOVERY: { risk_scale: 0.2, leverage_cap: 1, min_confidence: 75, allow_new_positions: true, profit_lock_bias: 0.4, note: "恢复期:仅允许 1x 小仓位,逐步恢复权限" }
};

// §55:从 HARD_STOP 恢复的条件(缺一不可)
export const RECOVERY_REQUIREMENTS = {
  cooldown_ms: 12 * 3600000,
  min_new_trades: 3,
  max_dd_to_enter_recovery: 6,      // 回撤收窄到 6% 以内才允许进入恢复期
  min_dd_improvement_pct: 3        // 且相比硬止损时改善至少 3 个百分点
};

// §57:净值里程碑(达到后重新评估 Risk Budget)
export const EQUITY_MILESTONES = [100, 125, 150, 200, 300, 500];
// §56/§58:账户越大越保守(risk_per_trade 上限随规模下降)
export const RISK_BUDGET_BY_MILESTONE = [
  { milestone: 100, risk_per_trade_pct: 20, max_leverage_tendency: 5, drawdown_tolerance_pct: 12 },
  { milestone: 125, risk_per_trade_pct: 16, max_leverage_tendency: 4, drawdown_tolerance_pct: 10 },
  { milestone: 150, risk_per_trade_pct: 13, max_leverage_tendency: 3, drawdown_tolerance_pct: 9 },
  { milestone: 200, risk_per_trade_pct: 10, max_leverage_tendency: 3, drawdown_tolerance_pct: 8 },
  { milestone: 300, risk_per_trade_pct: 8, max_leverage_tendency: 2, drawdown_tolerance_pct: 7 },
  { milestone: 500, risk_per_trade_pct: 6, max_leverage_tendency: 2, drawdown_tolerance_pct: 6 }
];

export function equityMilestoneOf(equity, milestones) {
  const list = (milestones || EQUITY_MILESTONES).slice().sort((a, b) => a - b);
  let hit = null;
  for (const m of list) if (num(equity, 0) >= m) hit = m;
  return hit;
}

export function riskBudgetFor(equity, options) {
  const opts = options || {};
  const table = opts.table || RISK_BUDGET_BY_MILESTONE;
  const e = num(equity, 100);
  let row = table[0];
  for (const r of table) if (e >= r.milestone) row = r;
  return {
    equity: round(e, 4),
    milestone: row.milestone,
    risk_per_trade_pct: row.risk_per_trade_pct,
    max_leverage_tendency: row.max_leverage_tendency,
    drawdown_tolerance_pct: row.drawdown_tolerance_pct,
    note: "账户越大越保守:保护已积累净值(§56/§58)"
  };
}

// 单维度回撤计算(峰值 + 当前值)
export function drawdownOf(peak, current) {
  const p = num(peak, 0);
  const c = num(current, 0);
  if (!(p > 0)) return { pct: 0, abs: 0, peak: p, current: c };
  const abs = Math.max(0, p - c);
  return { pct: round(abs / p * 100, 4), abs: round(abs, 8), peak: round(p, 8), current: round(c, 8) };
}

// §49:账户级 + 日级 + 分池级 + 模型/杠杆策略级 全套回撤
export function drawdownMetrics(input) {
  const i = input || {};
  const account = i.account || {};
  const wallets = i.wallets || {};
  const trades = i.trades || [];
  const now = num(i.now, Date.now());
  const equity = num(account.total_equity, num(account.initial_balance, 0));
  const peak = Math.max(num(account.peak_equity, equity), equity);
  const accountDd = drawdownOf(peak, equity);

  // 日级:当天开始时的净值(注入或按当日已实现盈亏回推)
  const todayKey = dayKeyOf(now);
  const todayTrades = trades.filter((t) => dayKeyOf(t.exit_time) === todayKey);
  const todayNet = summarizeTrades(todayTrades).net_pnl;
  const dayStartEquity = num(i.day_start_equity, equity - todayNet);
  const dailyDd = drawdownOf(Math.max(dayStartEquity, equity), equity);

  const poolDd = {};
  for (const mode of ["short", "long"]) {
    const w = wallets[mode] || {};
    const wEquity = num(w.allocated_balance, 0);
    const wPeak = Math.max(num(w.peak_allocated, num(i.pool_peaks && i.pool_peaks[mode], wEquity)), wEquity);
    poolDd[mode] = drawdownOf(wPeak, wEquity);
  }
  // 模型/杠杆策略回撤:用真实样本(杠杆记录)算,没有样本时明确 null
  const records = i.leverage_records || [];
  const modelDd = records.length >= 10
    ? (() => {
      let peakPnl = 0;
      let cum = 0;
      let worst = 0;
      for (const r of records) {
        cum += num(r.net_pnl, 0);
        peakPnl = Math.max(peakPnl, cum);
        worst = Math.max(worst, peakPnl - cum);
      }
      return { pct: peakPnl > 0 ? round(worst / Math.max(peakPnl, 1e-9) * 100, 4) : 0, abs: round(worst, 8), samples: records.length };
    })()
    : { pct: null, abs: null, samples: records.length };

  return {
    at: now,
    equity: round(equity, 8),
    peak_equity: round(peak, 8),
    account: accountDd,
    daily: dailyDd,
    short: poolDd.short,
    long: poolDd.long,
    model: modelDd,
    leverage_policy: modelDd,
    today_net_pnl: round(todayNet, 8),
    worst_pool_pct: Math.max(poolDd.short.pct, poolDd.long.pct)
  };
}

// 单次状态判定(无滞回);滞回由 controller 负责
export function classifyDrawdown(metrics, thresholds) {
  const T = { ...DRAWDOWN_THRESHOLDS, ...(thresholds || {}) };
  const m = metrics || {};
  const acct = num(m.account && m.account.pct, 0);
  const daily = num(m.daily && m.daily.pct, 0);
  const pool = num(m.worst_pool_pct, 0);
  const hits = [];
  let state = "NORMAL";
  const escalate = (s, why) => {
    const order = DRAWDOWN_STATES.indexOf(s);
    if (order > DRAWDOWN_STATES.indexOf(state)) state = s;
    hits.push(why);
  };
  if (acct >= T.caution) escalate("CAUTION", "账户回撤 " + round(acct, 2) + "% ≥ " + T.caution + "%");
  if (acct >= T.defensive) escalate("DEFENSIVE", "账户回撤 " + round(acct, 2) + "% ≥ " + T.defensive + "%");
  if (acct >= T.hard_stop) escalate("HARD_STOP", "账户回撤 " + round(acct, 2) + "% ≥ " + T.hard_stop + "%");
  if (daily >= T.daily_caution) escalate("CAUTION", "当日回撤 " + round(daily, 2) + "%");
  if (daily >= T.daily_defensive) escalate("DEFENSIVE", "当日回撤 " + round(daily, 2) + "%");
  if (daily >= T.daily_hard_stop) escalate("HARD_STOP", "当日回撤 " + round(daily, 2) + "% ≥ " + T.daily_hard_stop + "%");
  if (pool >= T.pool_caution) escalate("CAUTION", "单池回撤 " + round(pool, 2) + "%");
  if (pool >= T.pool_defensive) escalate("DEFENSIVE", "单池回撤 " + round(pool, 2) + "%");
  if (pool >= T.pool_hard_stop) escalate("HARD_STOP", "单池回撤 " + round(pool, 2) + "%");
  return { state, reasons: hits, metrics: { account_pct: acct, daily_pct: daily, pool_pct: pool } };
}

// §50-§55:带滞回的状态机
export function createDrawdownController(options) {
  const opts = {
    thresholds: DRAWDOWN_THRESHOLDS,
    requirements: RECOVERY_REQUIREMENTS,
    milestones: EQUITY_MILESTONES,
    ...(options || {})
  };
  const clock = () => num(opts.now ? opts.now() : Date.now());
  const history = [];
  let state = "NORMAL";
  let hardStopAt = null;
  let hardStopDd = null;
  let recoverySamples = 0;
  let lastMilestone = null;

  function evaluate(input) {
    const i = input || {};
    const now = num(i.now, clock());
    const metrics = drawdownMetrics({ ...i, now });
    const classified = classifyDrawdown(metrics, opts.thresholds);
    const wanted = classified.state;
    const reasons = classified.reasons.slice();
    let changed = false;

    // 升级:立即生效(风险优先)。用严重度 rank 而不是数组下标 ——
    // 否则 RECOVERY(数组里排在最后)会让"恢复期再次恶化"永远无法升级
    const rankOf = (s) => num(DRAWDOWN_RANK[s], 0);
    if (wanted !== "RECOVERY" && rankOf(wanted) > rankOf(state)) {
      state = wanted;
      changed = true;
      if (state === "HARD_STOP") {
        hardStopAt = now;
        hardStopDd = metrics.account.pct;
        recoverySamples = 0;
      }
      reasons.push("状态升级 → " + state);
    } else if (state === "HARD_STOP" && wanted === "HARD_STOP") {
      hardStopDd = Math.min(num(hardStopDd, metrics.account.pct), metrics.account.pct);
    } else if (state === "HARD_STOP" || state === "RECOVERY") {
      // 降级/恢复:冷却 + 新样本 + 回撤收窄 + 改善幅度(§55)
      const R = opts.requirements;
      const elapsed = now - num(hardStopAt, now);
      const newTrades = num(i.new_trades_since_hard_stop, 0);
      const improved = num(hardStopDd, metrics.account.pct) - metrics.account.pct;
      const conditions = {
        cooldown_ok: elapsed >= num(R.cooldown_ms),
        samples_ok: newTrades >= num(R.min_new_trades),
        dd_narrowed: metrics.account.pct <= num(R.max_dd_to_enter_recovery),
        improvement_ok: improved >= num(R.min_dd_improvement_pct)
      };
      const ready = Object.values(conditions).every(Boolean);
      recoverySamples = newTrades;
      if (state === "HARD_STOP") {
        if (ready) { state = "RECOVERY"; changed = true; reasons.push("满足恢复条件,进入 RECOVERY(逐级恢复)"); }
        else reasons.push("HARD_STOP 保持:恢复条件未满足(" + Object.entries(conditions).filter(([, v]) => !v).map(([k]) => k).join(", ") + ")");
      } else {
        // RECOVERY → 按风险恢复程度逐级回到上一档,不允许直接跳到 NORMAL
        if (Object.values(conditions).every(Boolean) && metrics.account.pct < num(opts.thresholds.caution)) {
          state = "NORMAL";
          changed = true;
          reasons.push("风险恢复:退出 RECOVERY");
        } else if (wanted === "NORMAL" && metrics.account.pct < num(opts.thresholds.caution)) {
          reasons.push("RECOVERY 保持:等待更多稳定样本");
        } else if (rankOf(wanted) > rankOf("RECOVERY")) {
          state = wanted;
          changed = true;
          reasons.push("恢复期再次恶化 → " + state);
        } else {
          reasons.push("RECOVERY 保持:小仓位运行");
        }
      }
    } else if (rankOf(wanted) < rankOf(state)) {
      // 非硬止损路径的降级:需要回撤收窄到下一档阈值以下(简单滞回)
      const nextLower = state === "DEFENSIVE" ? "CAUTION" : "NORMAL";
      const limit = nextLower === "NORMAL" ? num(opts.thresholds.caution) : num(opts.thresholds.defensive);
      if (metrics.account.pct < limit) {
        state = nextLower;
        changed = true;
        reasons.push("回撤收窄 → " + state);
      } else {
        reasons.push("保持 " + state + "(未低于降级阈值 " + limit + "%)");
      }
    }

    const actions = { ...(DRAWDOWN_ACTIONS[state] || DRAWDOWN_ACTIONS.NORMAL) };
    // §56/§57:账户规模决定 Risk Budget,规模越大越保守
    const budget = riskBudgetFor(metrics.equity, { table: opts.riskBudgetTable });
    const milestone = equityMilestoneOf(metrics.equity, opts.milestones);
    const milestoneChanged = milestone != null && lastMilestone != null && milestone > lastMilestone;
    if (milestone != null) lastMilestone = milestone;
    // 实际允许的单笔风险 = 状态缩放 × 里程碑预算(HARD_STOP 的 risk_scale=0 → 归零)
    actions.max_risk_per_trade_pct = round(num(actions.risk_scale, 1) * budget.risk_per_trade_pct, 4);
    actions.leverage_cap = Math.min(num(actions.leverage_cap, 10), budget.max_leverage_tendency + (state === "NORMAL" ? 5 : state === "CAUTION" ? 1 : 0));
    actions.tolerance_pct = budget.drawdown_tolerance_pct;

    const record = {
      at: now,
      state,
      changed,
      previous_state: changed ? null : state,
      metrics,
      actions,
      budget,
      milestone,
      milestone_changed: milestoneChanged,
      reasons,
      recovery_conditions: state === "HARD_STOP" || state === "RECOVERY" ? {
        cooldown_ms: num(opts.requirements.cooldown_ms),
        elapsed_ms: now - num(hardStopAt, now),
        new_trades: num(i.new_trades_since_hard_stop, 0),
        dd_now: metrics.account.pct,
        dd_at_hard_stop: hardStopDd
      } : null
    };
    history.push({ at: now, state, account_dd: metrics.account.pct });
    if (history.length > 500) history.shift();
    return record;
  }

  return {
    evaluate,
    state: () => state,
    history: () => history.slice(),
    hardStopAt: () => hardStopAt,
    // 仅测试/人工复位用:把状态机放回 NORMAL
    reset: (reason) => { const prev = state; state = "NORMAL"; hardStopAt = null; hardStopDd = null; return { from: prev, reason: reason || "manual_reset" }; }
  };
}

// §84:恢复期的风险阶梯(1x 小仓 → 逐步恢复)
export function recoveryLadder(state, options) {
  const opts = { ...{ steps: [1, 2, 3, 5] }, ...(options || {}) };
  if (state === "HARD_STOP") return { allowed: false, leverage: 0, note: "硬止损:禁止新开仓" };
  if (state !== "RECOVERY") {
    const a = DRAWDOWN_ACTIONS[state] || DRAWDOWN_ACTIONS.NORMAL;
    return { allowed: a.allow_new_positions, leverage: a.leverage_cap, note: a.note };
  }
  const samples = num(options && options.stable_samples, 0);
  const idx = Math.min(opts.steps.length - 1, Math.floor(samples / 5));
  return {
    allowed: true,
    leverage: opts.steps[idx],
    step_index: idx,
    note: "恢复期第 " + (idx + 1) + " 档:杠杆 " + opts.steps[idx] + "x(样本 " + samples + ")"
  };
}

// UI 文案
export function drawdownView(record) {
  const r = record || {};
  const m = r.metrics || {};
  const a = r.actions || {};
  const zh = { NORMAL: "正常", CAUTION: "注意", DEFENSIVE: "防守", HARD_STOP: "硬止损", RECOVERY: "恢复中" };
  return {
    state: r.state || "NORMAL",
    state_label: zh[r.state] || r.state || "正常",
    account_dd_text: round(num(m.account && m.account.pct, 0), 2).toFixed(2) + "%",
    daily_dd_text: round(num(m.daily && m.daily.pct, 0), 2).toFixed(2) + "%",
    pool_text: "短 " + round(num(m.short && m.short.pct, 0), 2).toFixed(2) + "% / 长 " + round(num(m.long && m.long.pct, 0), 2).toFixed(2) + "%",
    peak_equity_text: round(num(m.peak_equity, 0), 2).toFixed(2) + " USDT",
    allow_new_positions: a.allow_new_positions !== false,
    note: a.note || "",
    reasons: r.reasons || []
  };
}
