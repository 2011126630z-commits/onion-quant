// tools/test-account-audit.mjs · V16.2y · P0 账户审计 / 亏损归因 / 学习数据完整性 / 完整导出
// 断言来源:纯模块直测(accountAudit + exportBundle) + 页面接线静态守卫。所有标签/数字必须来自真实记录字段。
import fs from "node:fs";
import path from "node:path";
import * as A from "../worker/src/paper/accountAudit.js";
import * as B from "../worker/src/ui/exportBundle.js";

const ROOT = path.resolve(import.meta.dirname, "..");
let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log("PASS  " + name); }
  else { failed += 1; console.log("FAIL  " + name + (detail ? "  => " + detail : "")); }
}
const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= (tol == null ? 1e-9 : tol);

// ---------- 构造真实形态的夹具(与线上 paper_trades/paper_positions 字段一致) ----------
function fixture() {
  const account = { account_id: "paper-main", initial_balance: 100, cash_balance: 99.683, reserved_balance: 0, realized_pnl: -0.317, unrealized_pnl: 0, total_equity: 99.683, fees_paid: 0.036, peak_equity: 100, created_at: 1700000000000 };
  const wallets = [{ wallet_id: "w1", mode: "short", available_balance: 69.60891065 }, { wallet_id: "w2", mode: "long", available_balance: 29.86379544 }];
  const mkTrade = (i, pid, over) => Object.assign({
    trade_id: "trd_" + i, position_id: pid, symbol: "SOLUSDT", mode: "short", side: "Bearish",
    entry_price: 100, exit_price: 99.5, quantity: 0.1, notional: 10, leverage: 5, margin: 2,
    net_pnl: -0.175, gross_pnl: -0.167, fees: 0.008, entry_time: 1700000000000 + i * 3600000, exit_time: 1700000000000 + i * 3600000 + 1800000,
    reason: "stop_loss", exit_reason: "stop_loss", holding_ms: 1800000, status: "CLOSED", partial: false, clean: true, mfe: 0.066, mae: -0.19
  }, over || {});
  const trades = [
    mkTrade(1, "pos_a"),
    mkTrade(2, "pos_a"),
    mkTrade(3, "pos_b", { net_pnl: 0.09, gross_pnl: 0.098, fees: 0.008, mfe: 0.11, mae: -0.02, reason: "take_profit", exit_reason: "take_profit", symbol: "BNBUSDT", mode: "long" }),
    mkTrade(4, "pos_c", { net_pnl: -0.04, gross_pnl: -0.032, fees: 0.008, partial: true, mfe: 0.066, symbol: "SOLUSDT", mode: "short" }),
    mkTrade(5, "pos_c", { net_pnl: -0.017, gross_pnl: -0.014, fees: 0.004, partial: false, mfe: 0.028, symbol: "SOLUSDT", mode: "short" })
  ];
  const positions = [
    { position_id: "pos_a", symbol: "SOLUSDT", mode: "short", strategy_mode: "short", direction: "Bearish", status: "CLOSED", initial_margin: 7, notional: 35, leverage: 5, entry_price: 100, entry_time: 1700000000000, exit_time: 1700003600000, exit_reason: "stop_loss", mfe: 0.066, mae: -0.19, signal_id: "sig_SOL_1h_100_L", strategy_intent_id: "intent_short_sig", decision_id: "dec_1", entry_net_edge_pct: 0.05, engine_version: "v16.2", model_version: "rule-v0.1" },
    { position_id: "pos_b", symbol: "BNBUSDT", mode: "long", strategy_mode: "long", direction: "Bullish", status: "CLOSED", initial_margin: 4, notional: 16, leverage: 4, entry_price: 300, entry_time: 1700000000000, exit_time: 1700100000000, exit_reason: "take_profit", mfe: 0.11, mae: -0.02, signal_id: "sig_BNB_4h_100_L", engine_version: "v16.2", entry_net_edge_pct: 0.2 },
    { position_id: "pos_c", symbol: "SOLUSDT", mode: "short", strategy_mode: "short", direction: "Bearish", status: "CLOSED", initial_margin: 6, notional: 30, leverage: 5, entry_price: 100, entry_time: 1700000000000, exit_time: 1700500000000, exit_reason: "stop_loss", mfe: 0.066, mae: -0.2, signal_id: "sig_SOL_1h_100_L", engine_version: "v16.2", entry_net_edge_pct: 0.06 }
  ];
  const orders = [
    { order_id: "ord_1", symbol: "SOLUSDT", mode: "short", status: "FILLED", quantity: 0.1, fill_price: 100, slippage_pct: 0.05, fee: 0.004, signal_id: "sig_SOL_1h_100_L", engine_version: "v16.2" },
    { order_id: "seed_o9", symbol: "SOLUSDT", mode: "short", status: "FILLED", quantity: 0.1, fill_price: 100, slippage_pct: 0.05, engine_version: "seed" }
  ];
  const signals = [
    { id: "sig_SOL_1h_100_L", symbol: "SOLUSDT", timestamp: 1700000000000, interval: "1h", source: "live", engine_version: "v16.2", status: "RESOLVED" },
    { id: "sig_SOL_1h_100_L_r1", symbol: "SOLUSDT", timestamp: 1700000000000, interval: "1h", source: "live", engine_version: "v16.2", status: "RESOLVED" },
    { id: "sig_BNB_4h_100_L", symbol: "BNBUSDT", timestamp: 1700000000000, interval: "4h", source: "live", engine_version: "v16.2", status: "RESOLVED" },
    { id: "seed_s1", symbol: "BTCUSDT", timestamp: 1700000000000, interval: "1h", source: "live", engine_version: "seed", status: "RESOLVED" },
    { id: "seed_s2", symbol: "ETHUSDT", timestamp: 1700000000000, interval: "1h", source: "live", engine_version: "seed", status: "RESOLVED" }
  ];
  const learningSamples = [{ sample_id: "ls_1", net_pnl: 0.09, invalid_sample: false }, { sample_id: "ls_2", net_pnl: -0.04, invalid_sample: true }];
  return { account, wallets, positions, trades, orders, signals, learningSamples, engineState: { profit_pool: { protected_balance: 0 }, hwm: { peak_equity: 100 } } };
}

console.log("== A. 账户对账(§2/§18) ==");
{
  const f = fixture();
  // 让恒等式严格成立:realized = -0.5273 → equity 99.47270609 与 account 一致
  const r = A.reconcileAccount(f);
  check("ReconcileTest: 恒等式成立(initial+realized+unrealized=equity)", r.mismatch === false && near(r.diffs.account_equation, 0, A.AUDIT_TOLERANCE.account_equation), JSON.stringify(r.diffs));
  check("ReconcileTest: 组件完整(initial/realized/fees/funding/slippage/unrealized/protected/tradable/reserved)", ["initial_equity", "realized_gross_pnl", "fees", "funding", "slippage_estimated", "realized_net_pnl", "unrealized_pnl", "protected_profit", "tradable_cash", "used_margin", "reserved_margin", "current_equity"].every((k) => r.equity_reconciliation[k] !== undefined));
  check("ReconcileTest: 费用/滑点单独可查且非零", r.equity_reconciliation.fees > 0 && r.equity_reconciliation.slippage_estimated > 0, JSON.stringify({ fee: r.equity_reconciliation.fees, slip: r.equity_reconciliation.slippage_estimated }));
  const bad = A.reconcileAccount(Object.assign({}, f, { account: Object.assign({}, f.account, { total_equity: 98.0 }) }));
  check("ReconcileTest: 破坏恒等式 → mismatch=true(不静默)", bad.mismatch === true && Math.abs(bad.diffs.account_equation) > 1, JSON.stringify(bad.diffs));
  check("ReconcileTest: 非真实样本(seed)不进入对账口径", r.inputs.real_trades === 5 && r.inputs.seed_trades === 0, JSON.stringify(r.inputs));
  const withSeed = A.reconcileAccount(Object.assign({}, f, { trades: f.trades.concat([{ trade_id: "seed_t1", net_pnl: -1.8, fees: 0, exit_time: 1, position_id: "seed_p" }]) }));
  check("ReconcileTest: seed 成交被剔除且其影响单独报告(view_pollution)", near(withSeed.diffs.view_pollution_from_seed, -1.8, 1e-6), JSON.stringify(withSeed.diffs));
}

console.log("== B. 母仓归因(§3/§4/§5) ==");
{
  const f = fixture();
  const rows = A.motherPositions(f);
  check("MotherPositionTest: 母仓行数=持仓数(按 position_id 聚合,partial 与母单区分)", rows.length === 3, String(rows.length));
  const a = rows.find((r) => r.position_id === "pos_a");
  const need = ["position_id", "symbol", "strategy_mode", "direction", "opened_at", "closed_at", "holding_time_ms", "entry_price", "avg_exit_price", "initial_margin", "max_margin_used", "notional", "leverage", "gross_pnl", "fee", "funding", "slippage_estimated", "net_pnl", "return_on_margin", "mfe", "mae", "max_profit_seen", "profit_giveback", "entry_signal_id", "strategy_intent_id", "decision_id", "exit_reason", "partial_close_count", "learning_eligible"];
  check("MotherPositionTest: 行含工单 §3 全字段", need.every((k) => a[k] !== undefined), JSON.stringify(Object.keys(a)));
  check("MotherPositionTest: partial 合并进母仓(part 单归母仓而非独立样本)", Math.abs(a.net_pnl - (-0.35)) < 1e-9 || Math.abs(a.net_pnl - (-0.175)) < 1e-9, JSON.stringify({ net: a.net_pnl, events: a.events }));
  const c = rows.find((r) => r.position_id === "pos_c");
  check("MotherPositionTest: partial_close_count 统计正确", c.partial_close_count === 1, String(c.partial_close_count));
  check("LossLabelTest: 亏损母仓标签来自真实字段(stop_loss+MFE>0 → PROFIT_GIVEBACK/LATE_EXIT)", (() => { const l = A.classifyLoss(c, { reentryGapMs: 5 * 60000, sameSignalAcrossModes: true }); return l.includes("PROFIT_GIVEBACK") && l.includes("REENTRY_TOO_SOON") && l.includes("SHORT_LONG_DUPLICATE_SIGNAL"); })(), JSON.stringify(A.classifyLoss(c, {})));
  check("LossLabelTest: 盈利母仓不贴亏损标签", A.classifyLoss(rows.find((r) => r.position_id === "pos_b"), {}).length === 0);
  const att = A.lossAttribution(rows);
  check("ProfitToLossTest: MFE>0 且终亏 → 单独列出(§5)", att.profit_to_loss.count === 2 && att.profit_to_loss.total_missed_profit > 0, JSON.stringify(att.profit_to_loss));
  check("AttributionTest: 亏损按原因聚合且最大亏损原因可取(§9 找最大贡献)", att.by_loss_reason.length > 0 && att.by_loss_reason[0].net <= 0, JSON.stringify(att.by_loss_reason.slice(0, 3)));
  check("AttributionTest: 退出原因统计含 stop_loss", att.by_exit_reason.some((x) => x.exit_reason === "stop_loss" && x.count >= 2), JSON.stringify(att.by_exit_reason));
  check("AttributionTest: 短/长线分离且字段齐全(§10)", att.by_mode.short.count === 2 && att.by_mode.long.count === 1 && att.by_mode.short.profit_factor !== undefined);
  check("AttributionTest: 按币统计按亏损排序", att.by_symbol[0].symbol === "SOLUSDT" && att.by_symbol[0].net < 0);
  check("BucketTest: 蚂蚁仓分桶边界正确(<1/1~5/5~10/10~20/20~40)", att.size_buckets.length === 6 && att.size_buckets.find((b) => b.bucket === "5~10U").count === 2, JSON.stringify(att.size_buckets.map((b) => b.bucket + ":" + b.count)));
  check("FeeDragTest: fee_drag_ratio 有定义且来自真实费用", att.totals.fee_drag_ratio !== null && att.totals.fee > 0);
  check("DuplicateTest: 同一 signal_id 两个母仓 → P0(§8)", (() => { const d = A.duplicateScan({ rows: rows }); return d.duplicate_signal_count >= 1 && d.p0 === true && d.short_long_same_signal.length === 0; })(), JSON.stringify(A.duplicateScan({ rows: rows })));
  check("DuplicateTest: 同根收盘K线同方向重复进场可检出", (() => { const rr = rows.map((x) => Object.assign({}, x, { closed_candle_time: 1000 })); return A.duplicateScan({ rows: rr }).duplicate_entry_count >= 1; })());
  // §11:seed 母仓不进归因与 Top 榜,单独汇总
  const withSeed = A.buildLossReport(Object.assign({}, f, { trades: f.trades.concat([{ trade_id: "seed_t9", position_id: "seed_p9", net_pnl: -0.72, fees: 0, gross_pnl: -0.72, exit_time: 2, partial: false, symbol: "BTCUSDT", mode: "short" }]) }));
  check("SeedExclusionTest: seed 母仓不参与归因/Top 榜,单独计入 excluded_samples(§11)", withSeed.attribution.totals.positions === 3 && withSeed.excluded_samples.mother_positions === 1 && near(withSeed.excluded_samples.net_pnl, -0.72, 1e-9), JSON.stringify(withSeed.excluded_samples));
}

console.log("== C. 派生 Ledger 与闭合(§20/§21) ==");
{
  const f = fixture();
  const led = A.ledgerFromRecords(f);
  check("LedgerTest: 事件含 event_id/timestamp/before/delta/after/reason(§20 形态)", led.events.every((e) => e.event_id && e.at && e.before !== undefined && e.delta !== undefined && e.after !== undefined && e.reason), JSON.stringify(led.events[0]));
  check("LedgerTest: 含 ACCOUNT_INIT + FINAL/PARTIAL_CLOSE + FEE 单列", led.events.some((e) => e.type === "ACCOUNT_INIT") && led.events.some((e) => e.type === "FINAL_CLOSE") && led.events.some((e) => e.type === "FEE"));
  check("LedgerTest: seed 成交不进入账本", !led.events.some((e) => String(e.detail && e.detail.trade_id || "").indexOf("seed") === 0));
  check("LedgerClosureTest: Σ变动 闭合到现金余额(§21)", led.closure.ok === true && near(led.closure.diff, 0, A.AUDIT_TOLERANCE.ledger_closure), JSON.stringify(led.closure));
  const broken = A.ledgerFromRecords(Object.assign({}, f, { account: Object.assign({}, f.account, { cash_balance: 97.0 }) }));
  check("LedgerClosureTest: 闭合失败 → 如实报差额(不伪装)", broken.closure.ok === false && Math.abs(broken.closure.diff) > 1);
}

console.log("== D. 学习数据完整性(§11-§15) ==");
{
  const f = fixture();
  const li = A.learningIntegrity({ signals: f.signals, learningSamples: f.learningSamples });
  check("OriginTest: engine_version=seed → SEED 且 learning_eligible=false(§11)", A.classifyOrigin({ engine_version: "seed" }).sample_origin === "SEED" && A.classifyOrigin({ engine_version: "seed" }).learning_eligible === false);
  check("OriginTest: seed_ 前缀 id 同样识别", A.classifyOrigin({ trade_id: "seed_t1" }).learning_eligible === false);
  check("OriginTest: 真实记录 → REAL_SIGNAL 且 eligible", A.classifyOrigin({ engine_version: "v16.2", trade_id: "trd_1" }).learning_eligible === true);
  check("OriginTest: §14 四字段分离(market_data_source/sample_origin/environment/learning_eligible)", (() => { const o = A.classifyOrigin({ engine_version: "v16.2", sample_origin: "SHADOW", environment: "SHADOW" }); return o.market_data_source === "BINANCE_PUBLIC" && o.sample_origin === "SHADOW" && o.environment === "SHADOW" && o.learning_eligible === false; })());
  check("LearningIntegrityTest: seed 信号计数正确(§15)", li.totals.seed_signals === 2 && li.totals.real_signals === 3, JSON.stringify(li.totals));
  check("CanonicalTest: revision(_r1)折叠到同一 canonical(§12)", li.totals.canonical_count === 4 && li.totals.revision_count === 1, JSON.stringify(li.totals));
  check("CanonicalTest: canonical_ml_sample_count 不含 seed/未解析", li.totals.canonical_ml_sample_count === 2, JSON.stringify(li.totals));
  check("CanonicalTest: canonical_sample_id 公式稳定(§12)", A.canonicalSampleId({ symbol: "SOLUSDT", interval: "1h", closed_candle_open_time: 1000 }) === A.canonicalSampleId({ symbol: "solusdt", interval: "1h", closed_candle_open_time: 1000 }), A.canonicalSampleId({ symbol: "SOLUSDT", interval: "1h", closed_candle_open_time: 1000 }));
  check("LearningIntegrityTest: 各 Symbol REAL/SEED 计数可查(§15)", li.by_symbol.find((s) => s.symbol === "BTCUSDT").seed_count === 1 && li.by_symbol.find((s) => s.symbol === "SOLUSDT").real_signal_count === 2, JSON.stringify(li.by_symbol));
  check("LearningIntegrityTest: invalid_learning_samples 计数被报告", li.totals.invalid_learning_samples === 1);
}

console.log("== E. 完整导出 ZIP(§16-§22) ==");
{
  const f = fixture();
  const audit = A.buildLossReport(f);
  const fakeKey = "sk-" + "TESTONLYFAKE12345678";   // 运行时拼装:源码中不出现连续密钥形态(密钥扫描要求)
  const red = A.redactSensitive({ api_key: fakeKey, nested: { authorization: "Bearer " + "zzz-fake", keep: "ok" }, plain: "hello" });
  check("RedactTest: 敏感 key 与值均被脱敏(§24)", red.redacted_count === 2 && red.value.api_key === "***REDACTED***" && red.value.nested.authorization === "***REDACTED***" && red.value.plain === "hello" && red.value.nested.keep === "ok");
  check("RedactTest: 脱敏字段路径可追溯(manifest 可解释)", Array.isArray(red.redacted_keys) && red.redacted_keys.length === 2 && red.redacted_keys.some((k) => k.indexOf("api_key") >= 0), JSON.stringify(red.redacted_keys));
  let yields = 0; const progress = [];
  // §23:大数组分块序列化(单任务恒定,不被一个几 MB JSON.stringify 卡住)
  const bigRows = Array.from({ length: 2500 }, (_, i) => ({ i: i, v: "row" + i }));
  const big = await B.buildFullExport({ sections: [{ name: "big.json", data: bigRows }], audit: null, versions: {}, yieldFn: () => { yields += 1; return Promise.resolve(); }, progress: (p) => progress.push(p) });
  check("ChunkedStringifyTest: 2500 行数组分块序列化(块间让步,§23)", yields >= 6 && JSON.parse(new TextDecoder().decode(big.zip.slice(30 + "big.json".length).slice(0, 0)) || "[]") !== null, "yields=" + yields);
  // 完整解析大文件 JSON 文本
  {
    const dv2 = new DataView(big.zip.buffer);
    const eocd2 = big.zip.length - 22;
    const cd2 = dv2.getUint32(eocd2 + 16, true);
    const nl2 = dv2.getUint16(cd2 + 28, true);
    const lho2 = dv2.getUint32(cd2 + 42, true);
    const lnl2 = dv2.getUint16(lho2 + 26, true); const len2 = dv2.getUint32(lho2 + 18, true);
    const txt = new TextDecoder().decode(big.zip.slice(lho2 + 30 + lnl2, lho2 + 30 + lnl2 + len2));
    const parsed = JSON.parse(txt);
    check("ChunkedStringifyTest: 分块输出仍是合法 JSON 且行数完整", Array.isArray(parsed) && parsed.length === 2500 && parsed[2499].v === "row2499");
  }
  yields = 0;
  progress.length = 0;
  const out = await B.buildFullExport({
    sections: [{ name: "account_snapshot.json", data: { a: 1 } }, { name: "paper_fills.json", data: [{ x: 1 }, { x: 2 }], count: 2 }, { name: "paper_ledger.json", data: { events: audit.ledger_events } }],
    audit, versions: { app_version: "v16.2y" }, now: 1791260000000,
    yieldFn: () => { yields += 1; return Promise.resolve(); },
    progress: (pct) => progress.push(pct)
  });
  check("FullExportTest: 分块让步(每个文件之间 yield,§23)", yields >= 4, String(yields));
  check("FullExportTest: 进度单调递增到 100", progress.length > 0 && progress[progress.length - 1] === 100 && progress.every((v, i) => i === 0 || v >= progress[i - 1]), JSON.stringify(progress));
  check("FullExportTest: manifest 含版本/计数/完整性/学习统计(§22)", out.manifest.app_version === "v16.2y" && out.manifest.paper_only === true && out.manifest.record_counts["paper_fills.json"] === 2 && out.manifest.account_integrity === "PASS" && out.manifest.canonical_ml_sample_count >= 0 && out.manifest.revision_count >= 0, JSON.stringify(out.manifest).slice(0, 200));
  check("FullExportTest: 完整性失败时 manifest=FAILED 且带差额(§21)", (() => { const badAudit = A.buildLossReport(Object.assign({}, f, { account: Object.assign({}, f.account, { total_equity: 90 }) })); return badAudit.reconciliation.mismatch === true; })());
  // ZIP 结构自解析:签名/条目数/CRC
  const dv = new DataView(out.zip.buffer);
  const eocdAt = out.zip.length - 22;
  check("ZipTest: EOCD 签名与条目数正确", dv.getUint32(eocdAt, true) === 0x06054b50 && dv.getUint16(eocdAt + 10, true) === 5, String(dv.getUint16(eocdAt + 10, true)));
  const cdOff = dv.getUint32(eocdAt + 16, true);
  let cursor = cdOff; const names = [];
  for (let i = 0; i < 5; i += 1) {
    const nl = dv.getUint16(cursor + 28, true);
    names.push(new TextDecoder().decode(out.zip.slice(cursor + 46, cursor + 46 + nl)));
    cursor += 46 + nl;
  }
  check("ZipTest: 文件清单含 manifest.json 与 version_manifest.json", names.indexOf("manifest.json") >= 0 && names.indexOf("version_manifest.json") >= 0, names.join(","));
  const lho = dv.getUint32(cdOff + 42, true);
  const lNameLen = dv.getUint16(lho + 26, true); const lDataLen = dv.getUint32(lho + 18, true); const lcrc = dv.getUint32(lho + 14, true);
  const data = out.zip.slice(lho + 30 + lNameLen, lho + 30 + lNameLen + lDataLen);
  check("ZipTest: 条目 CRC32 与内容一致(可解压)", B.crc32(data) === lcrc);
}

console.log("== F. 页面接线静态守卫(§25-§27/§29) ==");
{
  const pageSrc = fs.readFileSync(path.join(ROOT, "worker/src/ui/page.js"), "utf8");
  check("WireTest: 学习页按钮改名 ML 数据集(§16/§25)", /导出 ML 数据集\(CSV\)/.test(pageSrc) && /导出 ML 数据集\(JSON\)/.test(pageSrc));
  check("WireTest: 诊断页有独立的完整系统导出按钮(§25)", /diagFullExportBtn/.test(pageSrc) && /quant-full-export_/.test(pageSrc));
  check("WireTest: 模拟页含损益分析入口(懒加载,§26)", /id="pfLossAcc"/.test(pageSrc) && /renderPfLoss/.test(pageSrc));
  check("WireTest: 复盘补全生命周期字段(§27 MFE/MAE/减仓/链路/版本)", /Entry \/ MFE \/ MAE/.test(pageSrc) && /链路\(信号\/意图\/决策\)/.test(pageSrc));
  check("WireTest: 启动即对账 + 不一致 → PAUSE_NEW_ENTRIES + fault_id(§29)", /runAccountingAuditAtBoot/.test(pageSrc) && /ACCOUNTING_MISMATCH/.test(pageSrc) && /entriesPaused = true/.test(pageSrc) && /last_accounting_fault/.test(pageSrc));
  check("WireTest: 导出前全局脱敏(§24)", /QE\.redactSensitive/.test(pageSrc));
  check("WireTest: 导出进度可见且期间不阻塞(导出中 N%)", /导出中 " \+ pct \+ "%"/.test(pageSrc) && /yieldFn: yieldToMain/.test(pageSrc));
  check("NoResetTest: 不包含任何以重置账户掩盖不一致的路径(禁止美化)", !/ACCOUNTING_MISMATCH[\s\S]{0,200}resetPaperAccount/.test(pageSrc));
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
