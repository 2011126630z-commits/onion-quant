// paper/runtime.js · Paper Runtime(与界面完全解耦的策略运行时)
// 目的:让"真正干活的循环"只有一个实现,既能被页面驱动,也能被原生前台服务(无 Activity/UI)驱动。
// 契约(host 注入):
//   fetchTickers()                     → 行情数组(必须逐条带 symbol)
//   analyze({symbol, interval, mode})  → 分析结果(on 失败要抛错或返回 null,不允许编造)
//   external(symbols) / research() / predictions(analyses) → 可选增强(未注入则跳过)
//   notify(kind, title, body, meta)    → 可选(通常复用引擎通知)
//   onStatus(status)                   → 状态回报(原生侧用来更新常驻通知;UI 侧用来重绘)
// 不变式:单实例(同一 runtime_key 只允许一个在跑)、退出优先、收盘K线幂等、永不动真钱。
import { num, numOrNull, round, dayKeyOf, summarizeTrades } from "./accounting.js";
import { closedCandleTime } from "./engine.js";

// 注意:扁平 bundle 要求顶层名唯一 —— 用 RUNTIME_ 前缀避免与 engine/constants 的 INTERVAL_MS 冲突
const RUNTIME_INTERVAL_MS = { "15m": 900000, "1h": 3600000, "4h": 14400000, "1d": 86400000 };

export const RUNTIME_STATES = ["STOPPED", "RUNNING", "PAUSED", "ERROR"];
// V15.1 §20-§23:Provider 状态与 failover。禁止合成数据;真机拿不到行情 → 暂停新 Entry,已有仓位继续 Risk。
// V16.1-RV:新增 STALE —— HTTP 200 但价格长时间完全不变 ⇒ 数据停滞,同样暂停新 Entry(§35)。
export const PROVIDER_STATES = ["HEALTHY", "DEGRADED", "FAILED", "STALE"];
export const MARKET_BLOCKED_CODE = "MARKET_PROVIDER_BLOCKED";
export const MARKET_STALE_CODE = "MARKET_DATA_STALE";
export const RUNTIME_DEFAULTS = {
  tick_interval_ms: 300000,       // 与页面主循环同节奏(5 分钟)
  risk_interval_ms: 20000,        // 价格刷新即评估风险
    stall_warn_ms: 15 * 60000,      // 超过这个时间没有任何循环活动 → 标记 stalled(§34 RUNTIME_STALL)
    market_reuse_ms: 5000,          // 同一 tick 内复用行情,避免重复拉取
    market_stale_fetches: 6,        // V16.1-RV §35:连续 N 次拉取价格指纹完全不变 → STALE(约 2 分钟 @20s)
    key: "paper-runtime"
};

// 全局单例登记表:防止"第二个 Engine 实例"(需求硬性要求)
const REGISTRY = new Map();
// 实例序号:instance_id 只用【时间戳 + 单调序号】,不用随机数(非加密用途也不引入弱随机)
let RUNTIME_INSTANCE_SEQ = 0;

export function runtimeInstanceCount() {
  return REGISTRY.size;
}
export function getRuntime(key) {
  return REGISTRY.get(key || RUNTIME_DEFAULTS.key) || null;
}

// V16.1-RV §8(真机实测缺陷):UI 命令邮箱的 TTL —— 陈旧命令不许"迟到执行"。
// 真机实测:运行时被行情阻断数小时后恢复,积压的 PAUSE 被补执行,把新起的运行时直接停住。
export const COMMAND_TTL_MS = 10 * 60000;
export function expireStaleCommands(rows, nowMs, ttlMs) {
  const ttl = num(ttlMs, COMMAND_TTL_MS);
  const list = Array.isArray(rows) ? rows : [];
  const fresh = [];
  const expired = [];
  for (const r of list) {
    const age = num(nowMs, Date.now()) - num(r && r.created_at, 0);
    if (age > ttl) {
      expired.push({
        ...r,
        status: "FAILED",
        executed_at: num(nowMs, Date.now()),
        result: { ok: false, reason: "expired", note: "命令超过 TTL 未执行,按过期处理(禁止迟到执行)" }
      });
    } else {
      fresh.push(r);
    }
  }
  return { fresh, expired };
}

// 从行情数组构建 symbol → quote(唯一入口;无 symbol 或非法价一律丢弃)
export function buildQuotes(tickers, source) {
  const quotes = {};
  for (const t of tickers || []) {
    if (!t || !t.symbol) continue;
    const price = Number(t.lastPrice != null ? t.lastPrice : t.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const high = Number(t.highPrice != null ? t.highPrice : price);
    const low = Number(t.lowPrice != null ? t.lowPrice : price);
    quotes[String(t.symbol)] = {
      symbol: String(t.symbol),
      price,
      high: Number.isFinite(high) && high > 0 ? high : price,
      low: Number.isFinite(low) && low > 0 ? low : price,
      received_at: Date.now(),
      provider: t.provider || "binance",
      source: source || "last"
    };
  }
  return quotes;
}

// 状态摘要(原生通知/UI 都读这一份;不做第二次计算)
// V16.1-RV §4/§20/§33/§34:额外暴露 实例身份 / 心跳 / state_version / 分项 tick 计数 / 各项延迟。
// 注意:stalled 以【心跳(循环活动)= attempts】为口径,而不是"策略成功" ——
//   行情被 Provider 阻断时循环仍在跑(只是不开新仓),那种情况由 market_state=FAILED/STALE 表达,不能算 RUNTIME_STALL。
export function runtimeStatus(input) {
  const r = input || {};
  const positions = r.positions || [];
  const open = positions.filter((p) => p.status === "OPEN");
  const byMode = { short: 0, long: 0 };
  for (const p of open) if (byMode[p.mode] != null) byMode[p.mode] += 1;
  const account = r.account || {};
  const nowMs = num(r.now, Date.now());
  const stallWarn = num(r.stall_warn_ms, RUNTIME_DEFAULTS.stall_warn_ms);
  const tickMs = num(r.tick_interval_ms, RUNTIME_DEFAULTS.tick_interval_ms);
  const startedAt = r.started_at == null ? null : num(r.started_at);
  const heartbeatAt = r.heartbeat_at == null ? null : num(r.heartbeat_at);
  const lastRiskAt = r.last_risk_at == null ? null : num(r.last_risk_at);
  const lastTickAt = r.last_tick_at == null ? null : num(r.last_tick_at);
  const marketOkAt = r.market && r.market.last_ok_at != null ? num(r.market.last_ok_at) : null;
  const ageOf = (at) => (at == null ? null : Math.max(0, nowMs - at));
  const heartbeatAge = ageOf(heartbeatAt);
  const strategyAge = ageOf(lastTickAt);
  const riskAge = ageOf(lastRiskAt);
  const marketAge = ageOf(marketOkAt);
  const warmEnough = startedAt != null && nowMs - startedAt > stallWarn;   // §34:冷启动宽限,不误报
  return {
    state: r.state || "STOPPED",
    short_positions: byMode.short,
    long_positions: byMode.long,
    open_positions: open.length,
    equity: round(num(account.total_equity, 0), 4),
    realized: round(num(account.realized_pnl, 0), 4),
    today_net: round(num(r.today_net, 0), 4),
    loops: num(r.loops, 0),
    last_tick_at: lastTickAt,
    last_error: r.last_error || null,
    last_closed_candle: r.last_closed_candle == null ? null : num(r.last_closed_candle),
    market: r.market || null,
    market_provider: (r.market && r.market.provider) || null,
    market_state: (r.market && r.market.state) || null,
    market_blocked: Boolean(r.market && r.market.ok === false && r.market.state === "FAILED"),
    market_stale: Boolean(r.market && r.market.state === "STALE"),
    stalled: heartbeatAge != null && heartbeatAge > stallWarn && warmEnough,
    // ---- V16.1-RV 新增:实例身份 / 心跳 / 版本 / 分项计数 / 延迟 ----
    instance_id: r.instance_id || null,
    owner: r.owner || null,
    started_at: startedAt,
    state_version: num(r.state_version, 0),
    updated_at: nowMs,
    risk_loops: num(r.risk_loops, 0),
    market_fetches: num(r.market_fetches, 0),
    last_risk_at: lastRiskAt,
    heartbeat_at: heartbeatAt,
    heartbeat_age_ms: heartbeatAge,
    strategy_age_ms: strategyAge,
    risk_age_ms: riskAge,
    market_age_ms: marketAge,
    strategy_stalled: strategyAge != null && strategyAge > tickMs * 2.5 && startedAt != null && nowMs - startedAt > tickMs * 2.5,
    stall_events: num(r.stall_events, 0),
    last_stall_at: r.last_stall_at == null ? null : num(r.last_stall_at),
    last_stall_ms: r.last_stall_ms == null ? null : num(r.last_stall_ms),
    stall_warn_ms: stallWarn,
    mode_label: "Short " + byMode.short + " / Long " + byMode.long + " · 持仓 " + open.length
  };
}

// 创建运行时。注意:同一个 key 只会存在一个实例 —— 第二个 create 直接返回已有实例。
export function createPaperRuntime(options) {
  const o = options || {};
  const cfg = { ...RUNTIME_DEFAULTS, ...(o.config || {}) };
  const key = o.key || cfg.key;
  const existing = REGISTRY.get(key);
  if (existing) return existing;                      // 单实例:复用,不新建
  const now = () => num(o.now ? o.now() : Date.now());
  const setTimer = o.setInterval || ((fn, ms) => setInterval(fn, ms));
  const clearTimer = o.clearInterval || ((id) => clearInterval(id));

  const rt = {
    key,
    state: "STOPPED",
    loops: 0,
    errors: 0,
    last_tick_at: null,
    last_ok_at: null,
    last_error: null,
    last_summary: null,
    started_at: null,
    timer: null,
    timers: [],
    busy: false,
    started_by: o.started_by || "host",
    // V15.1 §20/§21:Provider 健康与 failover 状态
    market_status: { ok: true, state: "HEALTHY", provider: null, detail: null },
    market_fails: 0,
    market_cache: null,
    market_blocked_notified: false,
    market_stale_notified: false,
    // V16.1-RV §4/§20/§33/§34:实例身份 / 心跳 / 版本 / 分项计数
    instance_id: "rt_" + now().toString(36) + "_" + (RUNTIME_INSTANCE_SEQ += 1),
    risk_loops: 0,
    market_fetches: 0,
    last_risk_at: null,
    last_attempt_at: null,
    version: 0,
    price_fingerprint: null,
    stale_fetches: 0,
    stall_events: 0,
    last_stall_at: null,
    last_stall_ms: null
  };

  function status() {
    const eng = o.engine;
    const positions = eng && eng.getPositions ? eng.getPositions() : [];
    const account = eng && eng.getAccount ? eng.getAccount() : {};
    const today = eng && eng.getTrades ? summarizeTrades(eng.getTrades().filter((t) => dayKeyOf(t.exit_time) === dayKeyOf(now()))) : { net_pnl: 0 };
    return runtimeStatus({
      state: rt.state,
      positions,
      account,
      today_net: today.net_pnl,
      loops: rt.loops,
      last_tick_at: rt.last_tick_at,
      last_error: rt.last_error,
      market: rt.market_status,
      last_closed_candle: eng && eng.engine && eng.engine.state ? eng.engine.state.last_candle_time : null,
      stall_warn_ms: cfg.stall_warn_ms,
      tick_interval_ms: cfg.tick_interval_ms,
      instance_id: rt.instance_id,
      owner: rt.started_by,
      started_at: rt.started_at,
      state_version: rt.version,
      risk_loops: rt.risk_loops,
      market_fetches: rt.market_fetches,
      last_risk_at: rt.last_risk_at,
      heartbeat_at: rt.last_attempt_at,
      stall_events: rt.stall_events,
      last_stall_at: rt.last_stall_at,
      last_stall_ms: rt.last_stall_ms,
      now: now()
    });
  }

  function report() {
    rt.version += 1;                                   // §20:每次状态发出都带一个严格递增的版本
    const s = status();
    if (typeof o.onStatus === "function") {
      try { o.onStatus(s); } catch (error) { /* 状态回报失败不影响运行时 */ }
    }
    return s;
  }

  // ---- 命令执行(UI 只发命令,运行时负责真正执行 —— 避免 UI 再起一个引擎) ----
  // 支持:PAUSE / RESUME / PAUSE_ENTRIES / RESUME_ENTRIES / MANUAL_CLOSE / EMERGENCY_CLOSE /
  //      ADJUST_STOP / ADJUST_TP / TICK(手动催一轮)
  async function executeCommand(cmd) {
    const c = cmd || {};
    const type = String(c.type || c.command || "").toUpperCase();
    const payload = c.payload || c;
    const eng = o.engine;
    try {
      if (type === "PAUSE") { await eng.pause("ui_command"); rt.state = "PAUSED"; report(); return { ok: true, type }; }
      if (type === "RESUME") { await eng.resume(); rt.state = "RUNNING"; report(); return { ok: true, type }; }
      if (type === "PAUSE_ENTRIES") { eng.pauseEntries("ui_command"); return { ok: true, type }; }
      if (type === "RESUME_ENTRIES") { eng.resumeEntries(); return { ok: true, type }; }
      if (type === "MANUAL_CLOSE") {
        const res = await eng.manualClose({ position_id: payload.position_id || payload.positionId, fraction: num(payload.fraction, 1), price: payload.price, action_source: "MANUAL" });
        return { ok: Boolean(res && res.ok), type, net_pnl: res && res.trade ? res.trade.net_pnl : null, reason: res && res.reason };
      }
      if (type === "EMERGENCY_CLOSE") {
        const res = await eng.emergencyCloseAll({ now: now() });
        return { ok: Boolean(res && res.ok), type, closed: res && res.closed };
      }
      if (type === "ADJUST_STOP") return { ok: true, type, result: await eng.adjustStop({ position_id: payload.position_id, stop_price: payload.stop_price }) };
      if (type === "ADJUST_TP") return { ok: true, type, result: await eng.adjustTakeProfit({ position_id: payload.position_id, take_profit_price: payload.take_profit_price }) };
      if (type === "TICK") { const r = await tick("manual_command"); return { ok: Boolean(r && r.ok), type, summary: r && r.summary }; }
      return { ok: false, type, reason: "unknown_command" };
    } catch (error) {
      return { ok: false, type, reason: (error && error.message) || "command_failed" };
    }
  }

  // 一次完整 tick:行情 → 退出优先(风险) → 候选 → 决策 → 下单 → 结算
  async function tick(reason) {
    // V16.1-RV(真机实测缺陷):暂停时仍然要消费命令邮箱 ——
    // 否则 UI 发的 RESUME 永远没有机会被执行(暂停 → 不 tick → 不 poll → 永久 PAUSED 死锁)。
    if (rt.state === "PAUSED") {
      if (o.commands && typeof o.commands.poll === "function") {
        try {
          const cmds = await o.commands.poll();
          for (const c of cmds || []) {
            const res = await executeCommand(c);
            if (typeof o.commands.complete === "function") await o.commands.complete(c, res);
          }
          report();
        } catch (error) { rt.last_error = "paused_command_poll:" + ((error && error.message) || "unknown"); }
      }
      return { ok: false, reason: "paused_commands_only", state: rt.state };
    }
    if (rt.state !== "RUNNING") return { ok: false, reason: "not_running", state: rt.state };
    if (rt.busy) return { ok: false, reason: "tick_reentry_blocked" };
    rt.busy = true;
    const startedAt = now();
    noteHeartbeat();   // §34:心跳 = 任何真实循环活动(不依赖"成功")
    try {
      const eng = o.engine;
      // 0a) Provider 健康检查(§20/§22):全源不可用 → 禁止新 Entry,绝不用合成数据顶替
      const market = await ensureMarket(reason);
      if (!market.ok) {
        rt.market_status = market.status;
        rt.last_error = MARKET_BLOCKED_CODE + (market.detail ? ":" + market.detail : "");
        if (!rt.market_blocked_notified) {
          rt.market_blocked_notified = true;
          if (typeof o.notify === "function") o.notify("SYSTEM", "行情源不可用 · 已暂停新开仓", "Provider 全部失败:不会使用合成数据代替真实行情;已有仓位继续风控管理。", { always: true, severity: "high" });
        }
        // 已有仓位进入 DATA_DEGRADED:没有可靠价格时不做乱模拟
        for (const p of eng.getPositions().filter((x) => x.status === "OPEN")) {
          if (p.price_status !== "INVALID") Object.assign(p, { price_status: "DEGRADED" });
        }
        report();
        return { ok: false, reason: MARKET_BLOCKED_CODE, status: rt.market_status };
      }
      rt.market_blocked_notified = false;
      // 0b) UI 命令邮箱(跨 WebView 的唯一通道:UI 写,运行时执行)
      if (o.commands && typeof o.commands.poll === "function") {
        try {
          const cmds = await o.commands.poll();
          for (const c of cmds || []) {
            const res = await executeCommand(c);
            if (typeof o.commands.complete === "function") await o.commands.complete(c, res);
          }
        } catch (error) {
          rt.last_error = "command_poll:" + ((error && error.message) || "unknown");
        }
      }
      const tickers = market.tickers;
      const quotes = buildQuotes(tickers, o.quote_source || "last");
      if (typeof o.observeTickers === "function") await o.observeTickers(tickers);
      // 1) 退出/风控优先:任何拿到价格的机会都先跑一遍(强平 → 止损 → 移动止损 → 止盈 → Profit Lock)
      const risk = await eng.riskPass({ quotes, now: now() });
      // 1b) §35:数据停滞(拉得到但价格完全不变)时不产生新开仓 —— 风控已跑过,仓位保护优先;
      //     这不是 RUNTIME_STALL(循环还在跑),是市场侧降级,由 market_state=STALE 如实表达。
      if (rt.market_status.state === "STALE") {
        rt.loops += 1;
        rt.last_tick_at = startedAt;
        rt.last_ok_at = now();
        rt.last_error = MARKET_STALE_CODE;
        rt.last_summary = { reason: reason || "interval", duration_ms: now() - startedAt, exits: (risk.exits || []).length, opened: 0, candidates: 0, note: "market_stale_skip_entries" };
        report();
        return { ok: true, skipped: true, reason: MARKET_STALE_CODE, summary: rt.last_summary };
      }
      // 2) 候选与决策
      const symbols = typeof o.candidateSymbols === "function" ? o.candidateSymbols() : Object.keys(quotes).slice(0, 12);
      const candidates = [];
      for (const symbol of symbols) {
        for (const mode of (o.modes || ["short", "long"])) {
          const interval = mode === "long" ? (o.long_interval || "4h") : (o.short_interval || "1h");
          let analysis = null;
          try {
            analysis = await o.analyze({ symbol, interval, mode });
          } catch (error) {
            rt.last_error = "analyze_failed:" + ((error && error.message) || "unknown");
            continue;
          }
          if (!analysis || !analysis.direction) continue;
          // 幂等键必须基于【已收盘K线时间】;宿主没提供就按周期自己算(绝不用 Date.now())
          const candle = typeof o.closedCandleTimeOf === "function"
            ? o.closedCandleTimeOf(interval)
            : closedCandleTime(now(), RUNTIME_INTERVAL_MS[interval] || 3600000);
          candidates.push({
            symbol,
            mode,
            analysis,
            direction: analysis.direction,
            riskPct: num(o.riskPct, 15),
            signal_timestamp: candle,
            closed_candle_time: candle,
            // 引擎 openPosition 需要本 symbol 的报价(必须以 symbol 取,不得共用)
            quote: quotes[symbol] || null,
            prediction: o.predictionsBySymbol ? o.predictionsBySymbol[symbol] || null : null
          });
        }
      }
      const loop = candidates.length
        ? await eng.loop({ quotes, candidates, atr: o.atrOf ? o.atrOf() : 0, now: now(), predictions: o.predictionsBySymbol || null })
        : { ok: true, skipped: true, reason: "no_candidates", summary: { exits: risk.exits || [], opened: [] } };
      rt.loops += 1;
      rt.last_tick_at = startedAt;
      rt.last_ok_at = now();
      rt.last_error = null;
      rt.last_summary = {
        reason: reason || "interval",
        duration_ms: now() - startedAt,
        exits: (risk.exits || []).length + num(loop.summary && loop.summary.exits && loop.summary.exits.length, 0),
        opened: num(loop.summary && loop.summary.opened && loop.summary.opened.length, 0),
        candidates: candidates.length
      };
      if (typeof o.afterTick === "function") {
        try { await o.afterTick({ quotes, risk, loop }); } catch (error) { rt.last_error = "after_tick:" + ((error && error.message) || "unknown"); }
      }
      report();
      return { ok: true, summary: rt.last_summary, status: status() };
    } catch (error) {
      rt.errors += 1;
      rt.last_error = (error && (error.message || error.reason)) || "tick_failed";
      rt.last_tick_at = startedAt;
      report();
      return { ok: false, reason: "tick_error", error: rt.last_error };
    } finally {
      rt.busy = false;
    }
  }

  // §34:心跳记录 —— 任何循环活动都刷新;若距上次活动超过 stall_warn_ms(说明定时器被系统冻结过),
  // 自动记一次 RUNTIME_STALL 证据(恢复后只处理最新状态,setInterval 语义本身不会补跑旧周期)。
  function noteHeartbeat() {
    const gap = rt.last_attempt_at == null ? null : now() - rt.last_attempt_at;
    if (gap != null && gap > num(cfg.stall_warn_ms, RUNTIME_DEFAULTS.stall_warn_ms)) {
      rt.stall_events += 1;
      rt.last_stall_at = now();
      rt.last_stall_ms = gap;
    }
    rt.last_attempt_at = now();
  }

  // Provider 健康检查:failure 计数 → DEGRADED / FAILED;成功即恢复 HEALTHY(§21)
  async function ensureMarket(reason) {
    if (rt.market_cache && now() - num(rt.market_cache.at, 0) < Math.max(1000, cfg.market_reuse_ms || 5000)) {
      return rt.market_cache.result;
    }
    let tickers = null;
    let provider = null;
    let detail = null;
    rt.market_fetches += 1;   // §33:行情尝试计数(成功/失败都算 —— 证明循环在跑)
    try {
      tickers = await o.fetchTickers();
      provider = o.quote_provider || "primary";
    } catch (error) {
      detail = (error && (error.message || error.reason)) || "fetch_failed";
    }
    const ok = Array.isArray(tickers) && tickers.length > 0;
    if (ok) {
      rt.market_fails = 0;
      // §35:HTTP 200 不代表健康 —— 价格指纹(全市场报价和)长时间完全不变 ⇒ STALE,不是 HEALTHY
      const fp = tickers.reduce((a, t) => a + Number((t && (t.lastPrice != null ? t.lastPrice : t.price)) || 0), 0).toFixed(6);
      if (fp === rt.price_fingerprint) rt.stale_fetches += 1;
      else { rt.stale_fetches = 0; rt.price_fingerprint = fp; }
      const stale = num(rt.stale_fetches, 0) >= num(cfg.market_stale_fetches, RUNTIME_DEFAULTS.market_stale_fetches);
      rt.market_status = {
        ok: true,
        state: stale ? "STALE" : "HEALTHY",
        provider,
        last_ok_at: now(),
        detail: null,
        stale_fetches: num(rt.stale_fetches, 0),
        code: stale ? MARKET_STALE_CODE : null
      };
      if (stale && !rt.market_stale_notified) {
        rt.market_stale_notified = true;
        if (typeof o.notify === "function") o.notify("SYSTEM", "行情数据可能停滞 · 已暂停新开仓", "连续 " + rt.stale_fetches + " 次拉取价格完全未变化;已有仓位风控保持运行。", { always: true, severity: "high" });
      }
      if (!stale) rt.market_stale_notified = false;
    } else {
      rt.market_fails = num(rt.market_fails, 0) + 1;
      rt.market_status = {
        ok: false,
        state: rt.market_fails >= 2 ? "FAILED" : "DEGRADED",
        provider,
        consecutive_failures: rt.market_fails,
        detail,
        code: MARKET_BLOCKED_CODE
      };
    }
    rt.market_cache = { at: now(), result: { ok, tickers: tickers || [], status: rt.market_status, reason } };
    return rt.market_cache.result;
  }

  // 只跑风险(价格轮次:强平/止损/移动止损,不产生新开仓)
  async function riskTick() {
    if (rt.state !== "RUNNING") return { ok: false, reason: "not_running" };
    noteHeartbeat();   // §34:风控轮次同样计入心跳
    try {
      // 风险轮次同样需要真实行情;拿不到就跳过(不乱模拟、也不清仓)
      const market = await ensureMarket("risk");
      if (!market.ok) {
        rt.last_error = MARKET_BLOCKED_CODE;
        report();
        return { ok: false, reason: MARKET_BLOCKED_CODE, status: rt.market_status };
      }
      const quotes = buildQuotes(market.tickers, o.quote_source || "last");
      const res = await o.engine.riskPass({ quotes, now: now() });
      rt.risk_loops += 1;
      rt.last_risk_at = now();
      if (typeof o.onRiskTick === "function") o.onRiskTick(res);
      report();
      return { ok: true, exits: (res.exits || []).length };
    } catch (error) {
      rt.last_error = "risk_tick:" + ((error && error.message) || "unknown");
      return { ok: false, reason: rt.last_error };
    }
  }

  async function start(opts) {
    const st = opts || {};
    if (rt.state === "RUNNING") return { ok: true, already: true, status: status() };
    // 恢复账户/持仓/引擎状态(由宿主提供的 engine.init 完成;这里只负责确认)
    if (o.engine && o.engine.init && st.skip_init !== true) {
      const init = await o.engine.init();
      if (init && init.blocked) {
        rt.state = "ERROR";
        rt.last_error = init.reason || "init_blocked";
        report();
        return { ok: false, reason: rt.last_error, init };
      }
    }
    if (o.engine && o.engine.start) {
      const started = await o.engine.start(st.auto_deps || {});
      if (started && started.ok === false && started.reason !== "already_running") {
        rt.state = "ERROR";
        rt.last_error = started.reason || "engine_start_failed";
        report();
        return { ok: false, reason: rt.last_error };
      }
    }
    rt.state = "RUNNING";
    rt.started_at = now();
    rt.started_by = st.started_by || rt.started_by;
    if (rt.timer) clearTimer(rt.timer);
    rt.timer = setTimer(() => { void tick("interval"); }, num(st.tick_interval_ms, cfg.tick_interval_ms));
    rt.timers = [];
    if (num(st.risk_interval_ms, cfg.risk_interval_ms) > 0) {
      rt.timers.push(setTimer(() => { void riskTick(); }, num(st.risk_interval_ms, cfg.risk_interval_ms)));
    }
    report();
    // 启动即跑一轮(不等待第一个间隔)
    if (st.immediate !== false) void tick("startup");
    return { ok: true, status: status() };
  }

  function stop(reason) {
    if (rt.timer) { clearTimer(rt.timer); rt.timer = null; }
    for (const t of rt.timers) clearTimer(t);
    rt.timers = [];
    rt.state = "STOPPED";
    rt.last_error = reason ? String(reason) : rt.last_error;
    report();
    return { ok: true, status: status() };
  }

  function pause(reason) {
    rt.state = "PAUSED";
    rt.last_error = reason ? String(reason) : null;
    report();
    return { ok: true, status: status() };
  }

  function dispose() {
    stop("disposed");
    REGISTRY.delete(key);
  }

  const api = {
    key,
    tick,
    riskTick,
    start,
    stop,
    pause,
    dispose,
    status,
    report,
    executeCommand,
    // §34:运行时卡顿记录(宿主检测到 stalled 时调用一次;只记录证据,不改变业务状态)
    noteStall: (ageMs) => {
      rt.stall_events += 1;
      rt.last_stall_at = now();
      rt.last_stall_ms = num(ageMs, rt.last_attempt_at == null ? null : now() - rt.last_attempt_at);
      report();
      return { ok: true, stall_events: rt.stall_events };
    },
    isRunning: () => rt.state === "RUNNING",
    isAlive: () => rt.state === "RUNNING" || rt.state === "PAUSED",
    startedBy: () => rt.started_by,
    lastSummary: () => rt.last_summary,
    loops: () => rt.loops,
    errors: () => rt.errors,
    runtime: rt
  };
  REGISTRY.set(key, api);
  return api;
}
