// ui/devPerf.js · V16.2s · 点击延迟 / 长任务 / 冻结观察(纯逻辑,记录与统计;不碰 DOM)
// 目标:把"点击→反馈→转场→首绘→就绪"变成可量化事实,并对主线程长任务与 UI 冻结留证据。
//   - begin(label) 拿到句柄;mark(handle, phase) 记录各相位时间戳;
//   - 相位名固定:feedback / nav_requested / transition / first_paint / ready;
//   - longTask(duration) 记录 >50ms 的主线程任务(PerformanceObserver 由页面侧注入);
//   - beat(now) 页面每 200ms 心跳;若间隔 > threshold(默认 3000ms)且页面可见 → 判定 UI 冻结,
//     记录冻结事件(时长 + 面包屑 + 状态快照),供真机/浏览器导出;
//   - breadcrumb(label) 记录最近动作序列(冻结时定位"最后一次操作");
//   - summary() 输出每个入口的相位耗时(median/max),report 字段名与验收报告一致。
export const DEV_PERF_VERSION = "dev-perf-v1.0";
export const DEV_PERF_PHASES = ["feedback", "nav_requested", "transition", "first_paint", "ready"];
export const FREEZE_THRESHOLD_MS = 3000;

function dpNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function dpMedian(values) {
  const arr = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : Math.round((arr[mid - 1] + arr[mid]) / 2);
}

export function createDevPerf(options) {
  const o = options || {};
  const limit = Math.max(10, Math.floor(dpNum(o.limit, 80)));
  const breadcrumbLimit = Math.max(10, Math.floor(dpNum(o.breadcrumbLimit, 40)));
  const longTaskLimit = Math.max(10, Math.floor(dpNum(o.longTaskLimit, 40)));
  const freezeThresholdMs = Math.max(500, dpNum(o.freezeThresholdMs, FREEZE_THRESHOLD_MS));
  const clock = typeof o.now === "function" ? o.now : () => Date.now();

  let seq = 0;
  const entries = [];        // { seq, label, at, marks, done }
  const byLabel = {};       // label → entries(环形截断)
  let longTasks = [];       // { at, duration, name }
  let longTaskTotal = 0;
  let longTaskMaxMs = 0;
  let breadcrumbs = [];     // { at, label }
  let freezes = [];         // { at, gapMs, breadcrumbs, snapshot, runtime }
  let lastBeatAt = null;
  let beatCount = 0;
  let openHandles = 0;

  function trimList(list, max) {
    while (list.length > max) list.shift();
    return list;
  }

  function breadcrumb(label) {
    breadcrumbs.push({ at: clock(), label: String(label || "?") });
    trimList(breadcrumbs, breadcrumbLimit);
    return breadcrumbs.length;
  }

  function begin(label) {
    const at = clock();
    const entry = { seq: ++seq, label: String(label || "tap"), at: at, marks: { tap: at }, done: false };
    entries.push(entry);
    trimList(entries, limit);
    const key = entry.label;
    if (!byLabel[key]) byLabel[key] = [];
    byLabel[key].push(entry);
    trimList(byLabel[key], 24);
    openHandles += 1;
    return entry;
  }

  function mark(handle, phase) {
    const entry = handle && typeof handle === "object" ? handle : null;
    if (!entry || !entry.marks) return null;
    const name = String(phase || "");
    if (!DEV_PERF_PHASES.includes(name) && name !== "tap") return null;
    const at = clock();
    if (entry.marks[name] == null) entry.marks[name] = at;
    if (name === "ready") { entry.done = true; if (openHandles > 0) openHandles -= 1; }
    return at;
  }

  function phaseMs(entry, phase) {
    if (!entry || !entry.marks || entry.marks.tap == null) return null;
    const at = entry.marks[phase];
    if (at == null) return null;
    return Math.max(0, Math.round(at - entry.marks.tap));
  }

  function longTask(duration, name) {
    const d = Math.round(dpNum(duration, 0));
    if (d <= 0) return null;
    longTaskTotal += 1;
    if (d > longTaskMaxMs) longTaskMaxMs = d;
    const rec = { at: clock(), duration: d, name: String(name || "longtask") };
    longTasks.push(rec);
    trimList(longTasks, longTaskLimit);
    return rec;
  }

  // 心跳:页面每 200ms 调一次;间隔 > 阈值且页面可见 = 主线程被堵过(冻结)
  function beat(nowArg, snapshot) {
    const now = dpNum(nowArg, clock());
    beatCount += 1;
    let freeze = null;
    if (lastBeatAt != null) {
      const gap = now - lastBeatAt;
      if (gap > freezeThresholdMs) {
        freeze = {
          at: now,
          gapMs: Math.round(gap),
          breadcrumbs: breadcrumbs.slice(-15),
          snapshot: snapshot || null,
          beats_before: beatCount - 1
        };
        freezes.push(freeze);
        trimList(freezes, 12);
      }
    }
    lastBeatAt = now;
    return freeze;
  }

  function note(label) { return breadcrumb(label); }

  function summary() {
    const labels = Object.keys(byLabel);
    const rows = [];
    for (const label of labels) {
      const list = byLabel[label];
      const phases = {};
      for (const phase of DEV_PERF_PHASES) {
        const vals = list.map((e) => phaseMs(e, phase)).filter((v) => v != null);
        if (vals.length) phases[phase] = { median: dpMedian(vals), max: Math.max(...vals), samples: vals.length };
      }
      rows.push({ label: label, count: list.length, phases: phases });
    }
    return {
      version: DEV_PERF_VERSION,
      entries: rows,
      long_tasks: { total: longTaskTotal, max_ms: longTaskMaxMs, recent: longTasks.slice(-10) },
      freezes: freezes.slice(-5),
      breadcrumbs: breadcrumbs.slice(-20),
      open_handles: openHandles
    };
  }

  function view() {
    const s = summary();
    const lines = [];
    for (const row of s.entries) {
      const p = row.phases;
      lines.push(
        row.label + ": " +
        "feedback " + (p.feedback ? p.feedback.median + "ms" : "--") +
        " · transition " + (p.transition ? p.transition.median + "ms" : "--") +
        " · first_paint " + (p.first_paint ? p.first_paint.median + "ms" : "--") +
        " · ready " + (p.ready ? p.ready.median + "ms" : "--")
      );
    }
    return {
      version: DEV_PERF_VERSION,
      headline_zh: "点击 " + entries.length + " 次 · 长任务 " + longTaskTotal + " 个(最大 " + longTaskMaxMs + "ms)· 冻结 " + freezes.length + " 次",
      lines: lines,
      long_tasks: s.long_tasks,
      freezes: s.freezes,
      breadcrumbs: s.breadcrumbs
    };
  }

  function stats() {
    return {
      version: DEV_PERF_VERSION,
      entries: entries.length,
      beats: beatCount,
      long_tasks: longTaskTotal,
      long_task_max_ms: longTaskMaxMs,
      freezes: freezes.length,
      open_handles: openHandles,
      breadcrumbs: breadcrumbs.length
    };
  }

  return {
    version: DEV_PERF_VERSION,
    phases: DEV_PERF_PHASES.slice(),
    freezeThresholdMs: freezeThresholdMs,
    begin: begin,
    mark: mark,
    phaseMs: phaseMs,
    note: note,
    breadcrumb: breadcrumb,
    longTask: longTask,
    beat: beat,
    summary: summary,
    view: view,
    stats: stats,
    exportFreezes: () => freezes.slice()
  };
}
