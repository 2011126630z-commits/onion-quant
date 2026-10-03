// runtime-host.js · Paper Runtime 的无界面宿主(由原生前台服务的 WebView 加载)
// 关键点:
//   - 不依赖任何 DOM/UI:只加载 qengine.js,创建引擎与运行时后就开始 tick
//   - 与 UI 同源(https://localhost),因此共享同一份 IndexedDB(账户/持仓/引擎状态)
//   - 单实例:createPaperRuntime 内置登记表,重复加载不会产生第二个引擎
//   - 行情/分析都在本地算:tickers/klines 走 QuantRuntime.httpGet(原生侧出网),分析走 QE.computeAnalysis
//   - 状态回报给原生:QuantRuntime.status(json) → 服务更新常驻通知(不刷屏)
// PAPER ONLY:REAL_TRADING_ENABLED = false,本文件不含任何真实下单能力。
(function () {
  const QE = window.QEngine;
  const bridge = window.QuantRuntime || null;
  const RUN_KEY = "paper-runtime";
  const SOURCE = "native-service";

  function log(message) {
    try { if (bridge && bridge.log) bridge.log("[host] " + message); } catch (error) { /* ignore */ }
  }
  function httpJson(path) {
    if (!bridge || !bridge.httpGet) throw new Error("no_native_http");
    const text = bridge.httpGet(String(path));
    if (!text) throw new Error("empty_response");
    const parsed = JSON.parse(text);
    if (parsed && parsed.error) throw new Error("upstream:" + parsed.error);
    return parsed;
  }
  // V15.1 §20/§21:Provider failover(Binance → OKX → Bybit),统一成内部 ticker 形状。
  // 禁止合成数据:全部失败就抛错,由运行时置 MARKET_PROVIDER_BLOCKED 并暂停新开仓。
  const PROVIDERS = ["binance", "okx", "bybit"];
  let currentProvider = null;
  function normalizeTickers(provider, raw) {
    const out = [];
    if (provider === "binance") {
      for (const t of raw || []) {
        if (!t || !t.symbol) continue;
        out.push({ symbol: String(t.symbol), lastPrice: Number(t.lastPrice), highPrice: Number(t.highPrice), lowPrice: Number(t.lowPrice) });
      }
    } else if (provider === "okx") {
      for (const t of (raw && raw.data) || []) {
        if (!t || !t.instId || !String(t.instId).endsWith("-USDT-SWAP")) continue;
        const symbol = String(t.instId).replace("-USDT-SWAP", "") + "USDT";
        out.push({ symbol, lastPrice: Number(t.last), highPrice: Number(t.high24h), lowPrice: Number(t.low24h) });
      }
    } else if (provider === "bybit") {
      for (const t of (raw && raw.result && raw.result.list) || []) {
        if (!t || !t.symbol || !String(t.symbol).endsWith("USDT")) continue;
        out.push({ symbol: String(t.symbol), lastPrice: Number(t.lastPrice), highPrice: Number(t.highPrice24h), lowPrice: Number(t.lowPrice24h) });
      }
    }
    return out.filter((t) => Number.isFinite(t.lastPrice) && t.lastPrice > 0);
  }
  const PROVIDER_URL = {
    binance: "/api/tickers?market=futures",
    okx: "https://www.okx.com/api/v5/market/tickers?instType=SWAP",
    bybit: "https://api.bybit.com/v5/market/tickers?category=linear"
  };
  function fetchTickersWithFailover() {
    const errors = [];
    for (const p of PROVIDERS) {
      try {
        const raw = p === "binance" ? httpJson(PROVIDER_URL[p]) : JSON.parse(bridge.httpGet(PROVIDER_URL[p]));
        const tickers = normalizeTickers(p, raw);
        if (!tickers.length) { errors.push(p + ":empty"); continue; }
        if (currentProvider !== p) log("provider 切换 → " + p + "(" + tickers.length + " 个 symbol)");
        currentProvider = p;
        return { tickers, provider: p, attempts: errors };
      } catch (error) {
        errors.push(p + ":" + (error && error.message));
      }
    }
    const err = new Error("all_providers_failed:" + errors.join("|"));
    err.reason = "market_provider_blocked";
    err.attempts = errors;
    throw err;
  }
  const adapterOf = (store) => ({
    get: (t, k) => store.generic.get(t, k),
    all: (t) => store.generic.all(t),
    put: (t, r) => store.generic.put(t, r),
    del: (t, k) => store.generic.del(t, k)
  });

  async function klines(symbol, interval) {
    // Binance 优先;失败则用 OKX 同周期 K线(统一成 Binance 数组形状:升序 [openTime,o,h,l,c,v])
    const errors = [];
    try {
      const rows = await httpJson("/api/klines?market=futures&symbol=" + encodeURIComponent(symbol) + "&interval=" + encodeURIComponent(interval) + "&limit=200");
      if (Array.isArray(rows) && rows.length) return rows;
      errors.push("binance:empty");
    } catch (error) { errors.push("binance:" + (error && error.message)); }
    try {
      const bar = { "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D" }[interval] || "1H";
      const instId = String(symbol).replace("USDT", "") + "-USDT-SWAP";
      const raw = JSON.parse(bridge.httpGet("https://www.okx.com/api/v5/market/candles?instId=" + instId + "&bar=" + bar + "&limit=200"));
      const data = (raw && raw.data) || [];
      const rows = data.map((c) => [Number(c[0]), Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4]), Number(c[5])]).reverse();
      if (rows.length) { log("klines 回退到 OKX:" + symbol + " " + interval); return rows; }
      errors.push("okx:empty");
    } catch (error) { errors.push("okx:" + (error && error.message)); }
    log("klines 全部失败 " + symbol + " " + interval + " → " + errors.join("|"));
    return [];
  }

  async function boot() {
    if (!QE || typeof QE.createPaperRuntime !== "function") {
      log("bundle 未就绪,等待重试");
      setTimeout(boot, 1500);
      return;
    }
    const existing = typeof QE.getRuntime === "function" ? QE.getRuntime(RUN_KEY) : null;
    if (existing && existing.isAlive()) {   // 单实例:已在跑就不再建第二个引擎
      log("运行时已存在,复用(不重建)");
      existing.report();
      return;
    }
    const store = await QE.createHistoryStore();
    log("存储模式 " + store.mode + (store.degraded ? "(降级:" + store.degraded_reason + ")" : ""));
    const engine = QE.createPaperEngine({
      store: adapterOf(store),
      now: () => Date.now(),
      riskCheck: (input) => QE.evaluateRisk(input),
      fetchKlines: (symbol, interval, limit) => klines(symbol, interval).then((r) => (limit ? r.slice(-limit) : r)).catch(() => []),
      fetchTickers: async () => httpJson("/api/tickers?market=futures"),
      profitLock: true,
      shadowExit: true,
      deviceId: SOURCE,
      onNotify: (item) => {
        // 关键事件转成系统通知(RISK/TRADE),普通事件不打扰
        try {
          if (bridge && bridge.notify && (item.severity === "high" || /平仓|强平|开仓/.test(String(item.title)))) {
            bridge.notify(String(item.kind || "SYSTEM"), String(item.title || ""), String(item.body || ""));
          }
        } catch (error) { /* 通知失败不影响运行时 */ }
      }
    });

    const runtime = QE.createPaperRuntime({
      engine,
      key: RUN_KEY,
      started_by: SOURCE,
      // ⚠️ 关键修复(V16.1-RV):bridge.httpGet 是同步 JNI 调用,fetchTickersWithFailover() 是同步函数
      // (返回对象而不是 Promise)。旧代码写成 `fetchTickersWithFailover().then(...)` →
      // 每一轮 tick 都在这里抛 "fetchTickersWithFailover(...).then is not a function",
      // 后台运行时长期行情阻断(loops=0、consecutive_failures 不断累加)——
      // 这就是"后台看起来在跑、实际从没推进过"的真根因。这里改成 async 包装 + 直接取 .tickers。
      fetchTickers: async () => fetchTickersWithFailover().tickers,
      quote_provider: currentProvider,
      candidateSymbols: () => ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"],
      modes: ["short", "long"],
      short_interval: "1h",
      long_interval: "4h",
      // UI 命令邮箱:UI 只写命令,这里负责真正执行(UI 不直接改账本)
      commands: {
        // V16.1-RV §8:陈旧的 UI 命令不许"迟到执行"(真机实测:积压数小时的 PAUSE 在恢复后被补执行,
        // 直接把运行时停住)。超过 TTL 的 PENDING 一律标记 FAILED(expired),只有新鲜命令进入执行。
        poll: async () => {
          const rows = await store.generic.all("runtime_commands");
          const pending = (rows || []).filter((r) => String(r.status).toUpperCase() === "PENDING");
          const split = QE.expireStaleCommands(pending, Date.now());
          for (const cmd of split.expired) {
            try { await store.generic.put("runtime_commands", cmd); } catch (error) { /* 过期标记失败不阻塞 */ }
          }
          if (split.expired.length) log("过期命令已丢弃 " + split.expired.length + " 条(禁止迟到执行)");
          return split.fresh.sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0)).slice(0, 10);
        },
        complete: async (cmd, result) => {
          try {
            let payload = {};
            try { payload = typeof cmd.payload === "string" ? JSON.parse(cmd.payload || "{}") : (cmd.payload || {}); } catch (error) { payload = {}; }
            await store.generic.put("runtime_commands", {
              ...cmd,
              payload,
              status: result && result.ok === false ? "FAILED" : "DONE",
              executed_at: Date.now(),
              result
            });
          } catch (error) { log("command complete failed " + error.message); }
        }
      },
      analyze: async ({ symbol, interval }) => {
        const tfs = ["15m", "1h", "4h", "1d"];
        const tfRows = {};
        for (const tf of tfs) tfRows[tf] = await klines(symbol, tf);
        const btcRows = {};
        for (const tf of tfs) btcRows[tf] = await klines("BTCUSDT", tf);
        // V16.1-RV:同上 —— fetchTickersWithFailover 是同步函数,不能再接 .then
        const tickers = fetchTickersWithFailover().tickers;
        const ticker = (tickers || []).find((t) => t && t.symbol === symbol) || {};
        return QE.computeAnalysis({ symbol, interval, ticker, tfRows, btcRows, tickers: tickers || [], nowMs: Date.now() });
      },
      config: { tick_interval_ms: 300000, risk_interval_ms: 20000 },
      onStatus: (status) => {
        try { if (bridge && bridge.status) bridge.status(JSON.stringify(status)); } catch (error) { /* ignore */ }
      }
    });

    const started = await runtime.start({ started_by: SOURCE });
    log("runtime start: " + JSON.stringify(started && started.status ? { state: started.status.state, equity: started.status.equity, instance_id: started.status.instance_id } : started));
    // 自我守护:页面(服务)被回收后重建,发现状态不是 RUNNING 就重新拉起
    let lastStallSeenAt = 0;
    setInterval(() => {
      try {
        const rt = QE.getRuntime(RUN_KEY);
        if (!rt) { log("运行时丢失,重建"); void boot(); return; }
        if (!rt.isRunning() && rt.runtime.state !== "PAUSED") { log("运行时异常停止,重启"); void rt.start({ started_by: SOURCE }); }
        // V16.1-RV §34:卡顿 watchdog —— 以"心跳(循环活动)"为准,冷启动宽限已在 status.stalled 内处理
        const st = rt.status();
        if (st.stalled) {
          if (!lastStallSeenAt) {
            try { rt.noteStall(st.heartbeat_age_ms); } catch (error) { /* ignore */ }
            log("RUNTIME_STALL 心跳中断 " + Math.round(Number(st.heartbeat_age_ms || 0) / 1000) + " 秒(可能被系统挂起;恢复后只跑最新状态,不补跑旧周期)");
            if (bridge && bridge.notify) bridge.notify("SYSTEM", "后台运行时可能被系统挂起", "心跳中断超过 " + Math.round(Number(st.stall_warn_ms || 900000) / 60000) + " 分钟;恢复后不会补跑旧周期。", "");
          }
          lastStallSeenAt = Date.now();
        } else if (lastStallSeenAt) {
          log("RUNTIME_RESUMED 心跳恢复(停滞约 " + Math.round((Date.now() - lastStallSeenAt) / 1000) + " 秒)");
          lastStallSeenAt = 0;
        }
        rt.report();
      } catch (error) { log("守护异常 " + error.message); }
    }, 60000);
  }

  window.addEventListener("error", (event) => log("window.error " + (event && event.message)));
  window.addEventListener("unhandledrejection", (event) => log("unhandled " + ((event.reason && event.reason.message) || event.reason)));
  boot();
})();
