// paper/taskManager.js · Background Task Manager(后台任务唯一注册表)
// 目的:Paper Loop / 行情情报 / 研究 / 学习 / 同步 / 保留 / 维护 全部登记在册,
//      每个任务有 状态/上次运行/下次运行/错误/重试次数,避免 Timer 散落全项目。
// 设计:定时器可注入(便于单测不依赖真实时钟);任务异常不抛出到调用方(后台任务不能拖垮主循环)。
import { num, round } from "./accounting.js";

export const TASK_STATES = ["IDLE", "RUNNING", "OK", "ERROR", "STOPPED"];

export function createTaskManager(options) {
  const opts = options || {};
  const now = () => num(opts.now ? opts.now() : Date.now());
  const setTimer = opts.setInterval || ((fn, ms) => setInterval(fn, ms));
  const clearTimer = opts.clearInterval || ((id) => clearInterval(id));
  const onEvent = opts.onEvent || (() => {});
  const tasks = new Map();

  function snapshot(name) {
    const t = tasks.get(name);
    if (!t) return null;
    return {
      name,
      state: t.state,
      interval_ms: t.interval_ms,
      last_run_at: t.last_run_at,
      last_ok_at: t.last_ok_at,
      last_error: t.last_error,
      last_error_at: t.last_error_at,
      duration_ms: t.duration_ms,
      runs: t.runs,
      errors: t.errors,
      retry_count: t.retry_count,
      next_run_at: t.next_run_at,
      enabled: Boolean(t.timer),
      critical: Boolean(t.critical)
    };
  }

  function register(name, spec) {
    const s = spec || {};
    tasks.set(name, {
      name,
      run: s.run,
      interval_ms: Math.max(1000, num(s.intervalMs, 60000)),
      timer: null,
      state: "IDLE",
      last_run_at: null,
      last_ok_at: null,
      last_error: null,
      last_error_at: null,
      duration_ms: null,
      runs: 0,
      errors: 0,
      retry_count: 0,
      next_run_at: null,
      max_retries: num(s.maxRetries, 3),
      critical: Boolean(s.critical)
    });
    return snapshot(name);
  }

  // 执行一次:并发保护 + 计时 + 错误捕获(不抛出)
  async function runOnce(name, runOpts) {
    const t = tasks.get(name);
    if (!t || typeof t.run !== "function") return { ok: false, reason: "task_not_registered" };
    if (t.state === "RUNNING") return { ok: false, reason: "task_still_running", skipped: true };
    if (t.retry_count >= t.max_retries && !(runOpts && runOpts.force)) {
      t.state = "ERROR";
      return { ok: false, reason: "retry_exhausted", retry_count: t.retry_count };
    }
    t.state = "RUNNING";
    const started = now();
    t.last_run_at = started;
    try {
      const value = await t.run();
      t.duration_ms = now() - started;
      t.runs += 1;
      t.last_ok_at = now();
      t.last_error = null;
      t.retry_count = 0;
      t.state = "OK";
      t.next_run_at = now() + t.interval_ms;
      onEvent({ name, ok: true, duration_ms: t.duration_ms });
      return { ok: true, value, duration_ms: t.duration_ms };
    } catch (error) {
      t.duration_ms = now() - started;
      t.errors += 1;
      t.retry_count += 1;
      t.last_error = (error && (error.message || error.reason)) || "unknown_error";
      t.last_error_at = now();
      t.state = "ERROR";
      // 退避:连续失败时把下次运行推后(最多 8 倍间隔)
      const backoff = t.interval_ms * Math.min(8, Math.max(1, t.retry_count));
      t.next_run_at = now() + backoff;
      onEvent({ name, ok: false, error: t.last_error, retry_count: t.retry_count });
      return { ok: false, reason: "task_error", error: t.last_error, retry_count: t.retry_count };
    }
  }

  function start(name) {
    const t = tasks.get(name);
    if (!t) return { ok: false, reason: "task_not_registered" };
    if (t.timer) return { ok: true, already: true };
    t.timer = setTimer(() => { void runOnce(name); }, t.interval_ms);
    // 不覆盖 ERROR 状态:错误必须留在健康摘要里,直到下一次成功运行才清除
    if (t.state !== "ERROR") t.state = "IDLE";
    t.next_run_at = now() + t.interval_ms;
    return { ok: true, interval_ms: t.interval_ms };
  }

  function stop(name) {
    const t = tasks.get(name);
    if (!t || !t.timer) return { ok: false, reason: "task_not_running" };
    clearTimer(t.timer);
    t.timer = null;
    t.state = "STOPPED";
    t.next_run_at = null;
    return { ok: true };
  }

  return {
    register,
    runOnce,
    start,
    stop,
    startAll: () => [...tasks.keys()].map((n) => ({ name: n, ...start(n) })),
    stopAll: () => [...tasks.keys()].map((n) => ({ name: n, ...stop(n) })),
    status: (name) => (name ? snapshot(name) : [...tasks.keys()].map(snapshot)),
    stats: () => {
      const all = [...tasks.values()];
      return {
        total: all.length,
        running: all.filter((t) => t.timer).length,
        errored: all.filter((t) => t.state === "ERROR").length,
        runs: all.reduce((a, t) => a + t.runs, 0),
        errors: all.reduce((a, t) => a + t.errors, 0)
      };
    },
    // UI 用:按"用户看得懂"的方式概括(不暴露日志)
    health: () => {
      const all = [...tasks.values()];
      const bad = all.filter((t) => t.state === "ERROR");
      const criticalBad = bad.filter((t) => t.critical);
      return {
        ok: bad.length === 0,
        critical_ok: criticalBad.length === 0,
        label: criticalBad.length ? "后台任务异常:" + criticalBad.map((t) => t.name).join(",")
          : bad.length ? "部分后台任务重试中:" + bad.map((t) => t.name).join(",")
            : "后台任务正常",
        details: all.map((t) => snapshot(t.name))
      };
    },
    lastDuration: (name) => round(num(tasks.get(name) && tasks.get(name).duration_ms, 0), 1)
  };
}
