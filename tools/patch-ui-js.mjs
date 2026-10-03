// tools/patch-ui-js.mjs · V14.1:页面 JS 接入(引擎单例/渲染/状态保留/在途取消/Chat/Retention)
import fs from "node:fs";
const file = new URL("../worker/src/ui/page.js", import.meta.url);
let text = fs.readFileSync(file, "utf8");
const before = text;

const js = `
      // ================= V14.1 移动端接入(复用现有 Paper 后台,不重写业务逻辑) =================
      const RM = QE.createRequestManager();
      const viewState = {
        detailSymbol: state.symbol,
        detailInterval: state.interval,
        marketScroll: 0,
        lastTickers: null,
        lastAnalysis: null,
        lastKlines: null,
        lastDetail: null
      };
      const MARKET_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "TRXUSDT"];
      let paperApi = null;
      let paperLoopTimer = null;
      let homeTimer = null;
      let retentionTimer = null;

      // ---- Paper Engine:同一页面生命周期只允许一个实例 ----
      function paperStoreAdapter(store) {
        return {
          get: (table, key) => store.generic.get(table, key),
          all: (table) => store.generic.all(table),
          put: (table, row) => store.generic.put(table, row),
          del: (table, key) => store.generic.del(table, key)
        };
      }

      async function getPaperEngine() {
        if (!paperApi) {
          paperApi = (async () => {
            const store = await historyStore();
            const eng = QE.createPaperEngine({
              store: paperStoreAdapter(store),
              now: () => Date.now(),
              deviceId: "web-" + (localStorage.getItem("deviceId") || (() => { const id = "dev" + Math.random().toString(36).slice(2, 8); localStorage.setItem("deviceId", id); return id; })()),
              riskCheck: (ctx) => QE.evaluateRisk({ ...ctx, now: Date.now(), mode: ctx.mode, todayStart: new Date().toISOString().slice(0, 10) }),
              fetchKlines: async (symbol, interval, limit) => QE.normalizeKlines(await api("klines?market=futures&symbol=" + symbol + "&interval=" + interval + "&limit=" + limit, 1, 8000), interval)
            });
            await eng.init();
            return eng;
          })();
        }
        return paperApi;
      }

      function engineStateText(s) {
        return QE.homeViewModel({ snapshot: { state: s } }).state_label;
      }

      async function renderHome() {
        const eng = await getPaperEngine();
        const snapshot = eng.snapshot();
        let learning = { note: "系统正在积累数据" };
        try {
          const store = await historyStore();
          const champ = await QE.getChampion(paperStoreAdapter(store));
          const evals = await store.generic.all("model_evaluations", 20);
          learning = QE.learningViewModel({ champion: champ ? champ.version : null, drift: (evals || []).find((e) => e.drift_detected) ? { drift_detected: true } : null });
        } catch (error) { /* 学习信息缺失不影响首页 */ }
        const risk = viewState.lastDetail ? { risk_level: viewState.lastDetail.risk_level_raw, risk_score: viewState.lastDetail.risk_score } : {};
        const vm = QE.homeViewModel({ snapshot, learning, risk, todayTrades: eng.getTrades().filter((t) => QE.dayKeyOf(t.exit_time) === QE.dayKeyOf(Date.now())) });
        const setText = (id, value, cls) => { const el = $(id); if (!el) return; el.textContent = value; if (cls !== undefined) el.className = cls; };
        setText("hmTodayPnl", vm.today_pnl_text, "big " + (vm.today_pnl > 0 ? "green" : vm.today_pnl < 0 ? "red" : ""));
        setText("hmEquity", vm.total_equity_text);
        setText("hmAllTime", vm.all_time_text);
        setText("hmShortEq", vm.short_equity.toFixed(2), "v");
        setText("hmShortToday", "今日 " + vm.short_today_text, "muted");
        setText("hmLongEq", vm.long_equity.toFixed(2));
        setText("hmLongToday", "今日 " + vm.long_today_text, "muted");
        setText("hmPositions", vm.open_positions + " 个");
        setText("hmTrades", vm.today_trades + " 次");
        setText("hmRisk", vm.risk_level + (vm.risk_score == null ? "" : " " + vm.risk_score));
        setText("hmState", vm.state_label);
        setText("hmLearning", vm.learning_status);
        const startBtn = $("hmStartBtn");
        const pauseBtn = $("hmPauseBtn");
        if (startBtn) startBtn.disabled = vm.running || snapshot.state === "STARTING" || snapshot.state === "RECOVERING";
        if (pauseBtn) pauseBtn.disabled = !vm.running;
        if (startBtn) startBtn.textContent = snapshot.state === "PAUSED" ? "继续模拟" : "开始模拟";
        return vm;
      }

      async function renderPaperPage() {
        const eng = await getPaperEngine();
        const snapshot = eng.snapshot();
        const vm = QE.paperViewModel({ wallets: snapshot.wallets, positions: snapshot.positions, trades: eng.getTrades(), now: Date.now() });
        $("pfShortAlloc").textContent = vm.short.allocated.toFixed(2) + " USDT · 可用 " + vm.short.available.toFixed(2) + " · 已实现 " + vm.short.net_pnl_text;
        $("pfLongAlloc").textContent = vm.long.allocated.toFixed(2) + " USDT · 可用 " + vm.long.available.toFixed(2) + " · 已实现 " + vm.long.net_pnl_text;
        $("pfToday").textContent = vm.today_net_text;
        $("pfTotal").textContent = vm.total_net_text;
        $("pfToday").className = vm.today_net_text.indexOf("-") === 0 ? "red" : "green";
        const posBox = $("pfPositions");
        posBox.replaceChildren();
        if (!vm.positions.length) posBox.appendChild(vEl("div", "v-note", "当前没有模拟持仓"));
        for (const p of vm.positions) {
          const el = vEl("div", "pf-pos");
          const head = vEl("div", "watch-row");
          const left = vEl("div");
          left.appendChild(vEl("div", "coin-name", p.symbol.replace("USDT", "/USDT") + " · " + p.mode_label + " · " + p.side));
          left.appendChild(vEl("div", "coin-sub", "买入 " + fmt.format(p.entry) + " → 现价 " + fmt.format(p.current) + " · 已持有 " + p.holding));
          head.appendChild(left);
          const right = vEl("div", "right");
          right.appendChild(vEl("div", "value " + (p.pnl > 0 ? "green" : p.pnl < 0 ? "red" : "muted"), p.pnl_text + " (" + QE.fmtPct(p.pnl_pct) + ")"));
          head.appendChild(right);
          el.appendChild(head);
          const grid = vEl("div", "pf-grid");
          const cell = (k, v) => { const c = vEl("div"); c.appendChild(vEl("span", null, k)); c.appendChild(vEl("b", null, v)); return c; };
          grid.appendChild(cell("止损", p.stop == null ? "--" : fmt.format(p.stop)));
          grid.appendChild(cell("止盈", p.take_profit == null ? "--" : fmt.format(p.take_profit)));
          grid.appendChild(cell("策略", p.mode_label));
          el.appendChild(grid);
          el.addEventListener("click", () => openDetail(p.symbol, p.mode === "long" ? "4h" : "1h"));
          posBox.appendChild(el);
        }
        const trBox = $("pfTrades");
        trBox.replaceChildren();
        if (!vm.trades.length) trBox.appendChild(vEl("div", "v-note", "还没有模拟成交"));
        for (const t of vm.trades) {
          const el = vEl("div", "mk-row");
          const left = vEl("div");
          left.appendChild(vEl("div", "sym", t.symbol.replace("USDT", "/USDT") + " · " + t.mode_label + " · " + t.side));
          left.appendChild(vEl("div", "sub", t.time + " · " + t.reason + " · " + t.holding));
          el.appendChild(left);
          el.appendChild(vEl("div", "value " + (t.net > 0 ? "green" : t.net < 0 ? "red" : "muted"), t.net_text + " " + t.pct));
          trBox.appendChild(el);
        }
        return vm;
      }

      async function loadTickers(force) {
        if (!force && viewState.lastTickers) return viewState.lastTickers;
        const req = RM.begin("market");
        const tickers = await api("tickers?market=futures", 2, 9000);
        if (!req.isCurrent()) return viewState.lastTickers;
        viewState.lastTickers = tickers;
        return tickers;
      }

      async function renderMarket(force) {
        const box = $("mkList");
        if (!box.children.length) box.appendChild(vEl("div", "v-note", "正在读取行情..."));
        let tickers = [];
        try {
          tickers = await loadTickers(force);
        } catch (error) {
          diagLog("market", error);
          box.replaceChildren(vEl("div", "v-note", "行情读取失败:" + shortError(error)));
          return;
        }
        const list = Array.isArray(tickers) ? tickers : [];
        const watch = new Set(state.watch);
        const top = list
          .filter((t) => String(t.symbol || "").endsWith("USDT") && !String(t.symbol).includes("_"))
          .sort((a, b) => Number(b.quoteVolume || 0) - Number(a.quoteVolume || 0));
        const wanted = MARKET_SYMBOLS.map((s) => top.find((t) => t.symbol === s)).filter(Boolean);
        const rest = top.filter((t) => !MARKET_SYMBOLS.includes(t.symbol)).slice(0, 20);
        const rows = wanted.concat(rest);
        box.replaceChildren();
        for (const t of rows) {
          const row = QE.marketRow(t, watch);
          const el = vEl("div", "mk-row");
          const left = vEl("div");
          left.appendChild(vEl("div", "sym", row.display));
          left.appendChild(vEl("div", "sub", row.watched ? "自选 · 点击查看" : "点击查看"));
          el.appendChild(left);
          const right = vEl("div", "right");
          right.appendChild(vEl("div", "value", fmt.format(row.price)));
          right.appendChild(vEl("div", "coin-sub " + (row.change24h > 0 ? "green" : row.change24h < 0 ? "red" : "muted"), row.change_text));
          el.appendChild(right);
          el.addEventListener("click", () => openDetail(row.symbol, viewState.detailInterval));
          box.appendChild(el);
        }
        renderWatchList(list);
        return rows;
      }

      function renderWatchList(tickers) {
        const box = $("mkWatchList");
        box.replaceChildren();
        if (!state.watch.length) { box.appendChild(vEl("div", "v-note", "还没有添加自选")); return; }
        const list = Array.isArray(tickers) ? tickers : [];
        for (const symbol of state.watch) {
          const t = list.find((x) => x.symbol === symbol) || {};
          const el = vEl("div", "mk-row");
          const left = vEl("div");
          left.appendChild(vEl("div", "sym", symbol.replace("USDT", "/USDT")));
          el.appendChild(left);
          const right = vEl("div", "right");
          right.appendChild(vEl("div", "value", t.lastPrice ? fmt.format(Number(t.lastPrice)) : "--"));
          right.appendChild(vEl("div", "coin-sub " + (Number(t.priceChangePercent || 0) >= 0 ? "green" : "red"), t.priceChangePercent ? QE.fmtPct(t.priceChangePercent) : "--"));
          el.appendChild(right);
          el.addEventListener("click", () => openDetail(symbol, viewState.detailInterval));
          box.appendChild(el);
        }
      }

      async function openDetail(symbol, interval) {
        viewState.detailSymbol = symbol || viewState.detailSymbol;
        viewState.detailInterval = interval || viewState.detailInterval;
        state.symbol = viewState.detailSymbol;
        setActivePage("detail");
        initDetailPeriods();
        await refreshDetail();
      }

      function initDetailPeriods() {
        const box = $("dtPeriods");
        const periods = [["15m", "15分"], ["1h", "1时"], ["4h", "4时"], ["1d", "1天"]];
        if (!box.children.length) {
          for (const [value, label] of periods) {
            const btn = vEl("button", "period-btn" + (value === viewState.detailInterval ? " active" : ""), label);
            btn.type = "button";
            btn.addEventListener("click", () => {
              viewState.detailInterval = value;
              box.querySelectorAll(".period-btn").forEach((b) => b.classList.toggle("active", b === btn));
              void refreshDetail();
            });
            box.appendChild(btn);
          }
        } else {
          box.querySelectorAll(".period-btn").forEach((b) => b.classList.toggle("active", b.textContent === ({ "15m": "15分", "1h": "1时", "4h": "4时", "1d": "1天" }[viewState.detailInterval])));
        }
      }

      async function refreshDetail() {
        const req = RM.begin("detail");
        const symbol = viewState.detailSymbol;
        const interval = viewState.detailInterval;
        $("dtSymbol").textContent = symbol.replace("USDT", "/USDT");
        const analysisTask = api("analyze?symbol=" + symbol + "&interval=" + interval, 2, 15000).then((v) => ({ ok: true, v })).catch((e) => { diagLog("detail-analyze", e); return { ok: false, error: e }; });
        const klineTask = api("klines?market=futures&symbol=" + symbol + "&interval=" + interval + "&limit=200", 2, 9000).then((v) => ({ ok: true, v })).catch((e) => { diagLog("detail-klines", e); return { ok: false, error: e }; });
        const [aRes, kRes] = await Promise.all([analysisTask, klineTask]);
        if (!req.isCurrent()) return viewState.lastDetail; // 旧 generation 直接丢弃
        const eng = await getPaperEngine();
        const snapshot = eng.snapshot();
        const analysis = aRes.ok ? aRes.v : null;
        const ticker = (viewState.lastTickers || []).find((t) => t.symbol === symbol) || {};
        let risk = null;
        if (analysis) {
          risk = QE.evaluateRisk({ account: snapshot.account, wallets: snapshot.wallets, positions: snapshot.positions, trades: eng.getTrades(), quote: { price: analysis.price, received_at: Date.now() }, now: Date.now(), analysis, mode: viewState.detailInterval === "1d" || viewState.detailInterval === "4h" ? "long" : "short", symbol });
        }
        const evidence = analysis ? QE.evidenceBundle(analysis, null) : null;
        const decision = analysis ? QE.fuse({ analysis, ml: null, risk: risk || {}, evidence }) : null;
        const vm = QE.detailViewModel({
          analysis: analysis || {}, symbol, interval, price: aRes.ok ? analysis.price : Number(ticker.lastPrice || 0),
          change24h: Number(ticker.priceChangePercent || 0), positions: snapshot.positions, mode: viewState.detailInterval === "1h" ? "short" : "long",
          risk: risk ? { ...risk, risk_level_raw: risk.risk_level } : null, decision, ml: null, now: Date.now()
        });
        viewState.lastDetail = { ...vm, risk_score: risk ? risk.risk_score : null, risk_flags: risk ? risk.risk_flags : [] };
        viewState.lastAnalysis = analysis;
        // 渲染(仅更新变化字段)
        $("dtPrice").textContent = vm.price ? fmt.format(vm.price) : "--";
        const chg = $("dtChange");
        chg.textContent = vm.change_text;
        chg.className = vm.change24h > 0 ? "green" : vm.change24h < 0 ? "red" : "muted";
        $("dtBias").textContent = vm.bias + " · " + vm.direction_zh + (vm.confidence == null ? "" : "(置信 " + vm.confidence + ")");
        $("dtBias").className = "value " + vm.bias_class;
        $("dtRisk").textContent = vm.risk_level + (vm.risk_score == null ? "" : " " + vm.risk_score);
        $("dtStrategy").textContent = vm.strategy;
        const posBox = $("dtPositionBox");
        posBox.replaceChildren();
        if (vm.position) {
          posBox.appendChild(vEl("div", "sec-title", "当前模拟持仓"));
          const row = vEl("div", "hm-row");
          row.appendChild(vEl("span", "k", vm.position.mode_label + " " + vm.position.side + " · 买入 " + fmt.format(vm.position.entry)));
          row.appendChild(vEl("span", "v " + (vm.position.pnl > 0 ? "green" : vm.position.pnl < 0 ? "red" : ""), vm.position.pnl_text + " " + vm.position.pnl_pct));
          posBox.appendChild(row);
          posBox.appendChild(vEl("div", "v-note", "现价 " + fmt.format(vm.position.current) + " · 已持有 " + vm.position.holding + " · 止损 " + (vm.position.stop == null ? "--" : fmt.format(vm.position.stop)) + " · 止盈 " + (vm.position.take_profit == null ? "--" : fmt.format(vm.position.take_profit))));
        }
        const details = $("dtDetails");
        details.replaceChildren();
        details.appendChild(vEl("div", "v-note", "环境 " + vm.regime + " · 多周期 " + Object.keys(vm.timeframes || {}).map((k) => k + " " + (vm.timeframes[k] || "")).join(" / ")));
        if (vm.risk_flags && vm.risk_flags.length) details.appendChild(vEl("div", "v-note", "风险标记:" + vm.risk_flags.join("、")));
        if (analysis) {
          const why = vEl("ul", "v-note"); why.style.paddingLeft = "18px";
          for (const item of (analysis.reasons || [])) why.appendChild(vEl("li", null, item));
          details.appendChild(vEl("div", "coin-name", "判断理由"));
          details.appendChild(why);
          const risks = vEl("ul", "v-note"); risks.style.paddingLeft = "18px";
          for (const item of (analysis.risks || [])) risks.appendChild(vEl("li", null, item));
          details.appendChild(vEl("div", "coin-name", "风险提示"));
          details.appendChild(risks);
        }
        details.appendChild(vEl("div", "v-note", "决策:" + (decision ? decision.action + "(" + decision.reason + ")" : "数据不足")));
        if (vm.degraded) details.appendChild(vEl("div", "v-note", "部分辅助周期数据缺失,已降级分析"));
        // K线:保留旧图,新数据回来后交叉淡入替换
        if (kRes.ok && kRes.v && kRes.v.length) {
          $("dtChartEmpty").classList.add("hidden");
          drawDetailChart(kRes.v);
        } else if (!viewState.lastKlines) {
          $("dtChartEmpty").classList.remove("hidden");
        }
        return vm;
      }

      function drawDetailChart(klines) {
        viewState.lastKlines = klines;
        const canvas = $("dtCanvas");
        const card = $("dtChartCard");
        if (!canvas || !card) return;
        const width = card.clientWidth || 340;
        const height = 260;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = width + "px";
        canvas.style.height = height + "px";
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const rows = klines.slice(-120);
        const style = getComputedStyle(document.documentElement);
        const up = style.getPropertyValue("--green").trim() || "#00b374";
        const down = style.getPropertyValue("--red").trim() || "#f6465d";
        const line = style.getPropertyValue("--line").trim() || "#262b33";
        const text = style.getPropertyValue("--muted").trim() || "#8b919a";
        const highs = rows.map((r) => Number(r[2]));
        const lows = rows.map((r) => Number(r[3]));
        const max = Math.max(...highs), min = Math.min(...lows);
        const pad = (max - min) * 0.08 || 1;
        const top = max + pad, bottom = min - pad;
        ctx.clearRect(0, 0, width, height);
        ctx.strokeStyle = line;
        ctx.lineWidth = 1;
        for (let i = 0; i <= 3; i += 1) {
          const y = Math.round((height - 22) * i / 3) + 8;
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
        }
        const bw = width / rows.length;
        rows.forEach((r, i) => {
          const o = Number(r[1]), c = Number(r[4]), h = Number(r[2]), l = Number(r[3]);
          const x = i * bw + bw / 2;
          const yOf = (v) => 8 + (height - 30) * (1 - (v - bottom) / (top - bottom));
          ctx.strokeStyle = c >= o ? up : down;
          ctx.fillStyle = c >= o ? up : down;
          ctx.beginPath(); ctx.moveTo(x, yOf(h)); ctx.lineTo(x, yOf(l)); ctx.stroke();
          const y1 = yOf(Math.max(o, c)), y2 = yOf(Math.min(o, c));
          ctx.fillRect(x - Math.max(1, bw * 0.3), y1, Math.max(1.5, bw * 0.6), Math.max(1, y2 - y1));
        });
        const last = rows[rows.length - 1];
        ctx.fillStyle = text;
        ctx.font = "11px system-ui";
        ctx.fillText(fmt.format(Number(last[4])), 4, height - 6);
        canvas.classList.add("pg-fade");
      }

      // ---- AI Chat ----
      function chatPush(role, textContent) {
        const body = $("chatBody");
        const el = vEl("div", "msg" + (role === "me" ? " me" : ""), textContent);
        body.appendChild(el);
        body.scrollTop = body.scrollHeight;
      }

      function openChat() {
        const vm = QE.chatViewModel({ detail: viewState.lastDetail || {} });
        $("chatTitle").textContent = vm.title;
        $("chatContext").textContent = vm.context_line + (vm.position_line ? " · " + vm.position_line : "");
        $("chatMask").classList.add("open");
        $("chatSheet").classList.add("open");
        if (!$("chatBody").children.length) {
          chatPush("ai", "我可以基于本地真实数据回答:方向与置信、风险、是否适合短线或长线、预计持有区间、为什么观望、什么条件会退出。");
          const box = $("chatBody");
          const chips = vEl("div", "chip-row");
          for (const q of vm.suggestions.slice(0, 5)) {
            const btn = vEl("button", "chip", q);
            btn.type = "button";
            btn.addEventListener("click", () => { $("chatInput").value = q; void sendChat(); });
            chips.appendChild(btn);
          }
          box.appendChild(chips);
        }
      }

      function closeChat() {
        $("chatMask").classList.remove("open");
        $("chatSheet").classList.remove("open");
        RM.leave("chat");
      }

      async function sendChat() {
        const input = $("chatInput");
        const question = String(input.value || "").trim();
        if (!question) return;
        input.value = "";
        chatPush("me", question);
        const eng = await getPaperEngine();
        const snapshot = eng.snapshot();
        const strategy = (() => {
          const trades = eng.getTrades();
          const sum = (mode) => QE.summarizeTrades(trades.filter((t) => t.mode === mode));
          return { short: sum("short"), long: sum("long") };
        })();
        const context = QE.buildChatContext({
          symbol: viewState.detailSymbol,
          interval: viewState.detailInterval,
          mode: viewState.detailInterval === "4h" || viewState.detailInterval === "1d" ? "long" : "short",
          analysis: viewState.lastAnalysis || {},
          risk: viewState.lastDetail ? { risk_level: viewState.lastDetail.risk_level, risk_score: viewState.lastDetail.risk_score } : {},
          position: viewState.lastDetail ? viewState.lastDetail.position : null,
          decision: viewState.lastDetail ? { action: viewState.lastDetail.strategy, score: null, reason: "" } : null,
          strategyStats: strategy,
          portfolio: snapshot
        });
        const local = QE.answerLocally(question, context);
        chatPush("ai", local);
        // DeepSeek 可选:经服务端调用(Key 不进入前端);失败/未配置时已用本地回答
        try {
          const req = RM.begin("chat");
          const review = await api("ai/review?symbol=" + encodeURIComponent(viewState.detailSymbol) + "&interval=" + viewState.detailInterval, 1, 20000);
          if (!req.isCurrent()) return;
          if (review && review.ok && review.text) chatPush("ai", review.text);
        } catch (error) {
          diagLog("chat-ai", error);
        }
      }

      // ---- Paper 自动 Loop(与 UI 解耦:切页不停) ----
      async function paperLoopTick() {
        const eng = await getPaperEngine();
        if (eng.getState() !== "RUNNING") return;
        try {
          const tickers = await api("tickers?market=futures", 1, 9000);
          const quotes = {};
          for (const t of tickers || []) {
            if (!t.symbol) continue;
            quotes[t.symbol] = { price: Number(t.lastPrice), high: Number(t.highPrice || t.lastPrice), low: Number(t.lowPrice || t.lastPrice), received_at: Date.now(), provider: "binance" };
          }
          const symbols = [...new Set([viewState.detailSymbol, ...state.watch, ...MARKET_SYMBOLS.slice(0, 5)])].slice(0, 6);
          const snapshot = eng.snapshot(undefined);
          const candidates = [];
          for (const symbol of symbols) {
            if (!quotes[symbol] || !(quotes[symbol].price > 0)) continue;
            const analysis = await api("analyze?symbol=" + symbol + "&interval=1h", 1, 15000);
            const risk = QE.evaluateRisk({ account: snapshot.account, wallets: snapshot.wallets, positions: eng.getPositions(), trades: eng.getTrades(), quote: quotes[symbol], now: Date.now(), analysis, mode: "short", symbol });
            const evidence = QE.evidenceBundle(analysis, null);
            const decision = QE.fuse({ analysis, ml: null, risk, evidence });
            eng.engine.lastSignals[symbol] = analysis.direction;
            if (risk.veto) continue;
            if (decision.action === "open_long" || decision.action === "open_short") {
              candidates.push({ mode: "short", symbol, direction: analysis.direction, signal_timestamp: Date.now(), quote: quotes[symbol], analysis, riskPct: 15, engine_version: analysis.model_version, decision_id: "dec_" + symbol + "_" + Date.now() });
            }
          }
          const res = await eng.loop({ quotes, candidates });
          if (res && res.summary && (res.summary.exits.length || res.summary.opened.length)) await renderHome();
        } catch (error) {
          diagLog("paper-loop", error);
        }
      }

      function startPaperLoop() {
        if (paperLoopTimer) return;
        paperLoopTimer = setInterval(() => { void paperLoopTick(); }, 300000);
      }

      // ---- Retention:长期挂机数据不会无限增长 ----
      async function runRetention() {
        try {
          const store = await historyStore();
          const adapter = paperStoreAdapter(store);
          const counts = {
            paper_orders: (await adapter.all("paper_orders")).length,
            paper_equity_snapshots: (await adapter.all("paper_equity_snapshots")).length,
            signals: (await adapter.all("signals")).length,
            paper_trades: (await adapter.all("paper_trades")).length,
            learning_samples: (await adapter.all("learning_samples")).length,
            model_registry: (await adapter.all("model_registry")).length,
            sync_queue_synced: (await adapter.all("sync_queue")).filter((i) => i.sync_status === "SYNCED").length
          };
          const plan = QE.planRetention(counts, { now: Date.now() });
          for (const item of plan.delete_rows) {
            if (["paper_trades", "paper_daily_stats", "learning_samples", "model_registry"].includes(item.table)) continue; // 核心历史永不动
            const rows = await adapter.all(item.table);
            const { drop } = QE.applyRetention(item.table, rows, QE.RETENTION_POLICY, {});
            for (const row of drop) {
              const key = row.id || row.order_id || row.signal_id || row.snapshot_id || row.trade_id || row.item_id;
              if (key) await adapter.del(item.table, key);
            }
          }
          return plan;
        } catch (error) {
          diagLog("retention", error);
          return null;
        }
      }

      function setActivePage(name) {
        document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
        const el = $("page-" + name);
        if (el) { el.classList.add("active", "pg-fade"); }
        $("chatFab").classList.toggle("show", name === "detail");
        if (name === "market") {
          const list = $("mkList");
          if (list) list.scrollTop = viewState.marketScroll;
        }
      }

      async function initMobileUI() {
        // 导航:切换时取消该视图在途请求(Paper Engine 不受影响)
        document.querySelectorAll(".nav-btn").forEach((btn) => {
          btn.addEventListener("click", () => {
            const page = btn.dataset.page;
            RM.leaveAll(["paper"]);
            void ensurePage(page);
          });
        });
        $("mkList").addEventListener("scroll", () => { viewState.marketScroll = $("mkList").scrollTop; });
        window.addEventListener("scroll", () => { if ($("page-market").classList.contains("active")) viewState.marketScroll = window.scrollY; }, { passive: true });
        $("mkScanBtn").addEventListener("click", () => {
          document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
          $("page-scan").classList.add("active");
          $("chatFab").classList.remove("show");
        });
        $("mkWatchBtn").addEventListener("click", () => {
          document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
          $("page-watch").classList.add("active");
          $("chatFab").classList.remove("show");
          void renderWatch();
        });
        $("openMonitorLegacy").addEventListener("click", () => {
          document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
          $("page-monitor").classList.add("active");
          $("chatFab").classList.remove("show");
          void analyzeCurrent();
        });
        $("openWatchLegacy").addEventListener("click", () => {
          document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
          $("page-watch").classList.add("active");
          void renderWatch();
        });
        $("openLearning").addEventListener("click", () => { void renderLearning(); });
        $("hmStartBtn").addEventListener("click", async () => {
          const eng = await getPaperEngine();
          if (eng.getState() === "PAUSED") await eng.resume(); else await eng.start();
          startPaperLoop();
          void paperLoopTick();
          await renderHome();
        });
        $("hmPauseBtn").addEventListener("click", async () => {
          const eng = await getPaperEngine();
          await eng.pause("用户暂停");
          await renderHome();
        });
        $("dtBackBtn").addEventListener("click", () => { setActivePage("market"); void renderMarket(false); });
        $("dtRefreshBtn").addEventListener("click", () => { void refreshDetail(); });
        $("dtDetailsBtn").addEventListener("click", () => { $("dtDetails").classList.toggle("hidden"); });
        $("chatFab").addEventListener("click", openChat);
        $("chatClose").addEventListener("click", closeChat);
        $("chatMask").addEventListener("click", closeChat);
        $("chatSend").addEventListener("click", () => { void sendChat(); });
        $("chatInput").addEventListener("keydown", (event) => { if (event.key === "Enter") void sendChat(); });
        $("chatSheet").addEventListener("touchmove", (event) => {
          const t = event.touches[0];
          if (t && t.clientY - (viewState.chatTouchY || t.clientY) > 60) closeChat();
          viewState.chatTouchY = t ? t.clientY : 0;
        }, { passive: true });
        $("mkSearch").addEventListener("input", () => { void renderMarketSearch(); });
        // 页面可见性:回到前台时刷新首页(不重启引擎)
        document.addEventListener("visibilitychange", () => {
          if (document.hidden) return;
          if ($("page-home").classList.contains("active")) void renderHome();
        });
        await getPaperEngine();
        await renderHome();
        await renderMarket(false).catch(() => {});
        if (homeTimer) clearInterval(homeTimer);
        homeTimer = setInterval(() => { if (!$("page-home").classList.contains("active") && !$("page-paper").classList.contains("active")) return; void renderHome(); if ($("page-paper").classList.contains("active")) void renderPaperPage(); }, 8000);
        if (retentionTimer) clearInterval(retentionTimer);
        retentionTimer = setInterval(() => { void runRetention(); }, 600000);
        void runRetention();
        if (paperApi) { /* 引擎实例已就绪 */ }
      }

      async function ensurePage(name) {
        if (name === "home") { await renderHome(); return; }
        if (name === "market") { await renderMarket(false); return; }
        if (name === "paper") { await renderPaperPage(); return; }
        if (name === "detail") { await refreshDetail(); return; }
      }

      async function renderMarketSearch() {
        const q = String($("mkSearch").value || "").trim().toUpperCase().replace("/", "");
        const box = $("mkSuggest");
        box.classList.remove("open");
        if (!q) return;
        const list = viewState.lastTickers || [];
        const hits = list.filter((t) => String(t.symbol || "").startsWith(q)).slice(0, 6);
        if (!hits.length) return;
        box.replaceChildren();
        for (const t of hits) {
          const btn = vEl("button", "chip", t.symbol.replace("USDT", "/USDT"));
          btn.type = "button";
          btn.addEventListener("click", () => { $("mkSearch").value = ""; box.classList.remove("open"); void openDetail(t.symbol, viewState.detailInterval); });
          box.appendChild(btn);
        }
        box.classList.add("open");
      }

      async function renderLearning() {
        const store = await historyStore();
        const adapter = paperStoreAdapter(store);
        const champ = await QE.getChampion(adapter);
        const models = await QE.listModels(adapter);
        const evals = await store.generic.all("model_evaluations", 50);
        const drift = QE.detectDrift((await adapter.all("learning_samples")).map((s) => ({ predicted_class: s.outcome_label, actual_class: s.outcome_label })).slice(0, 0));
        const vm = QE.learningViewModel({ champion: champ ? champ.version : null, challenger: (models.find((m) => m.status === "CHALLENGER") || {}).version || null, drift });
        const box = vEl("div", "v-note", vm.status_text + "\n模型数量:" + models.length + " · 评估记录:" + evals.length + "\n(技术信息,日常无需关注)");
        const host = $("openLearning");
        host.querySelector(".coin-sub").textContent = vm.plain ? "学习正常" : "正在训练候选模型";
        $("learningBadge").textContent = champ ? champ.version : "--";
        box.remove();
      }

      void initMobileUI();
`;

text = text.split("      void initHistory();").join(js + "\n      void initHistory();");
fs.writeFileSync(file, text, "utf8");
console.log(before === text ? "NO_CHANGE" : "PATCHED ui js");
console.log("has RM:", text.includes("QE.createRequestManager()"), "| engine single:", text.includes("async function getPaperEngine()"), "| retention:", text.includes("runRetention"), "| chat:", text.includes("sendChat"));
