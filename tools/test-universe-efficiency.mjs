// tools/test-universe-efficiency.mjs · V16.2v 动态币种池 + 资金效率(§18 清单 12 项)
import fs from "node:fs";
import path from "node:path";
import { buildScan, scanMetrics, estimateSpreadBps, estimateDepthUsdt, primaryReasonZh, SCAN_LIMITS } from "../worker/src/paper/universeScan.js";
import { evaluateSymbol, CORE_SYMBOLS, UNIVERSE_GATES } from "../worker/src/paper/symbolUniverse.js";
import { createPaperEngine } from "../worker/src/paper/engine.js";
import { capitalAllocation, CAPITAL_LIMITS } from "../worker/src/paper/capitalAllocator.js";
import { minimumMeaningfulPosition } from "../worker/src/paper/entryQuality.js";
import { capitalEfficiencyOf } from "../worker/src/paper/capitalEfficiency.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const pageSrc = fs.readFileSync(path.join(ROOT, "worker/src/ui/page.js"), "utf8");
const hostSrc = fs.readFileSync(path.join(ROOT, "tools/runtime-host.js"), "utf8");
let failed = 0, passed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log("PASS  " + name); }
  else { failed += 1; console.log("FAIL  " + name + (detail ? "  => " + detail : "")); }
}
function eq(name, a, b) { check(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); }

// —— 合成行情(只为测试提供输入形状,不冒充真实数据) ——
function mkTicker(symbol, qv, chg, price) {
  return { symbol, quoteVolume: qv, priceChangePercent: chg == null ? 1.5 : chg, lastPrice: price == null ? 10 : price };
}
function bigBook() {
  const rows = [];
  const core = [["BTCUSDT", 8e9], ["ETHUSDT", 4e9], ["BNBUSDT", 1.2e9], ["SOLUSDT", 9e8]];
  for (const [s, v] of core) rows.push(mkTicker(s, v, 2));
  const alts = ["XRPUSDT", "DOGEUSDT", "ADAUSDT", "LINKUSDT", "AVAXUSDT", "TRXUSDT", "DOTUSDT", "MATICUSDT", "LTCUSDT", "ATOMUSDT", "NEARUSDT", "APTUSDT", "ARBUSDT", "OPUSDT", "SUIUSDT", "TIAUSDT", "INJUSDT", "SEIUSDT", "WIFUSDT", "PEPEUSDT", "FTMUSDT", "GRTUSDT", "RNDRUSDT", "STXUSDT", "IMXUSDT", "FILUSDT"];
  let v = 6e8;
  for (const s of alts) { rows.push(mkTicker(s, v, 3.5)); v *= 0.82; }
  return rows;
}
const klines200 = () => Array.from({ length: 200 }, (_, i) => [1700000000000 + i * 14400000, 10, 11, 9, 10.5, 1000]);

console.log("== 1/2. 动态 Universe(不是固定 4 币;市场变化能更新) ==");
{
  const tickers = bigBook();
  const klinesBySymbol = {};
  for (const t of tickers) klinesBySymbol[t.symbol] = klines200();
  const s1 = buildScan({ tickers, klinesBySymbol, holding: [], now: 1000 });
  check("UniverseNotFixedFourTest:扫描超过 4 个币(前 40)", s1.counts.scanned > 4 && s1.counts.scanned === Math.min(SCAN_LIMITS.scan_max_symbols, tickers.length), "scanned=" + s1.counts.scanned);
  const nonCore = s1.shortlist.filter((r) => !CORE_SYMBOLS.includes(r.symbol));
  check("UniverseNotFixedFourTest:深度名单含非核心币(山寨进入候选)", nonCore.length >= 3, JSON.stringify(s1.shortlist.map((r) => r.symbol)));
  check("UniverseNotFixedFourTest:核心币仍在名单(基准资产不缺席)", s1.shortlist.some((r) => r.symbol === "BTCUSDT"));
  // 市场变化:新增一个高成交额新币 → 必须动态进来;移除一个 → 动态消失
  const tickers2 = bigBook().filter((t) => t.symbol !== "XRPUSDT").concat([mkTicker("NEWHOTUSDT", 1.5e9, 2)]);
  const s2 = buildScan({ tickers: tickers2, klinesBySymbol: { ...klinesBySymbol, NEWHOTUSDT: klines200() }, holding: [], now: 2000 });
  check("UniverseDynamicUpdateTest:新增高成交额币自动进入扫描", s2.scan.some((m) => m.symbol === "NEWHOTUSDT"));
  check("UniverseDynamicUpdateTest:被移除的币不再出现", !s2.scan.some((m) => m.symbol === "XRPUSDT"));
  const rowHot = s2.universe.all.find((e) => e.symbol === "NEWHOTUSDT");
  check("UniverseDynamicUpdateTest:新高流动性币可进入 ACTIVE(门槛真实通过)", rowHot && rowHot.state === "ACTIVE", JSON.stringify(rowHot && { s: rowHot.state, r: rowHot.reasons_zh }));
}

console.log("== 3/4/5. 过滤门槛(低流动/高价差/历史不足) ==");
{
  const lowLiq = scanMetrics(mkTicker("TINYUSDT", 1e5, 2), { candles_seen: 200 });
  const evLow = evaluateSymbol(lowLiq);
  check("LowLiquidityExcludedTest:成交额 10 万 → OBSERVE_ONLY 不进深度", evLow.state === "OBSERVE_ONLY" && evLow.tier === "WATCH", JSON.stringify(evLow.state));
  const hiSpread = scanMetrics(mkTicker("WIDEUSDT", 6e8, 2), { candles_seen: 200, spread_bps: 25 });
  const evSpread = evaluateSymbol(hiSpread);
  check("HighSpreadExcludedTest:价差 25bps → OBSERVE_ONLY(山寨硬门槛)", evSpread.state === "OBSERVE_ONLY", JSON.stringify(evSpread.reasons_zh));
  const young = scanMetrics(mkTicker("BABYUSDT", 6e8, 2), { candles_seen: 50 });
  const evYoung = evaluateSymbol(young);
  check("ShortHistoryExcludedTest:K线 50 根 → WARMING_UP 不训练不交易", evYoung.state === "WARMING_UP" && evYoung.tier === "WATCH", JSON.stringify(evYoung.state));
  // 整链路:低流动币即使成交额排在前面也必须被拦在 shortlist 外
  const tickers = [mkTicker("TINYUSDT", 9e8, 2), mkTicker("BTCUSDT", 8e9, 2)];
  const scan = buildScan({ tickers, klinesBySymbol: { TINYUSDT: klines200(), BTCUSDT: klines200() }, holding: [], now: 1, opts: { gates: { min_quote_volume_usdt: 5e6 } } });
  // TINYUSDT 成交额高但价差估算...其成交额 9e8 实际会过;改用显式高波动异常币验证短路
  const doge = scanMetrics(mkTicker("JUMPUSDT", 9e8, 40), { candles_seen: 200 });
  const evJump = evaluateSymbol(doge);
  check("AbnormalJumpSuspendedTest:24h 涨 40% → SUSPENDED(疑似插针)", evJump.state === "SUSPENDED", JSON.stringify(evJump.state));
  check("PrimaryReasonZhTest:淘汰原因有可读中文(简洁)", /未通过|暂停|预热/.test(primaryReasonZh(evSpread).state_zh) && primaryReasonZh(evSpread).detail_zh.length > 0, JSON.stringify(primaryReasonZh(evSpread)));
}

console.log("== 6. 漏斗上限(候选再多也不全跑重模型) ==");
{
  const tickers = bigBook();
  const klinesBySymbol = {};
  for (const t of tickers) klinesBySymbol[t.symbol] = klines200();
  const scan = buildScan({ tickers, klinesBySymbol, holding: [], now: 1, opts: { shortlist_n: 10 } });
  check("FunnelCapTest:40 币扫描 → 深度名单 ≤10", scan.shortlist.length <= 10 && scan.shortlist.length >= 5, "shortlist=" + scan.shortlist.length);
  check("FunnelCapTest:扫描上限默认 40(手机性能漏斗 Level1)", SCAN_LIMITS.scan_max_symbols === 40 && scan.counts.scanned <= 40);
}

console.log("== 7/8/9. 仓位质量(蚂蚁仓 / 低净边际 / 高质量上限) ==");
let clock = 1700000000000;
const mem = new Map();
function makeEngine() {
  return createPaperEngine({
    store: {
      get: async (t, k) => mem.get(t + "|" + k) || null,
      all: async (t) => [...mem.entries()].filter(([kk]) => kk.startsWith(t + "|")).map(([, v]) => v),
      put: async (t, r) => { mem.set(t + "|" + (r.id || r.trade_id || r.position_id || r.order_id || Math.random()), r); return r; }
    },
    now: () => clock,
    riskCheck: () => ({ veto: false }),
    fetchKlines: async () => []
  });
}
const A = (conf) => ({ direction: "Bullish", confidence: conf, volatility: { atrPct: 1.2 }, market_regime: { label: "Weak Uptrend" }, structure: { last_swing_low: 90, last_swing_high: 110 }, support_zones: [{ hi: 95 }], resistance_zones: [{ lo: 108 }] });
{
  clock = 1700000000000;
  const eng = makeEngine();
  await eng.init(); await eng.start();
  const open = async (symbol, conf, mode) => {
    clock += 3600000;
    return eng.openPosition({ mode: mode || "short", symbol, direction: "Bullish", signal_timestamp: clock, closed_candle_time: clock, quote: { price: 100, received_at: clock }, analysis: A(conf) });
  };
  const def = await open("BTCUSDT", 70);
  check("NoMassTinyPositionsTest:默认风险预算下 100U 账户开仓 ≥ 15U 保证金(不再 4.5/10.5 蚂蚁仓)", def.ok === true && def.position.initial_margin >= 15, JSON.stringify({ ok: def.ok, m: def.position && def.position.initial_margin }));
  const longDef = await open("ETHUSDT", 70, "long");
  check("NoMassTinyPositionsTest:长线池同样 ≥10U(旧实现 4.5U)", longDef.ok === true && longDef.position.initial_margin >= 10, JSON.stringify({ ok: longDef.ok, m: longDef.position && longDef.position.initial_margin }));
  // 高质量:允许接近上限但绝不越 40%
  const mem2 = new Map();
  const eng2 = createPaperEngine({ store: { get: async (t, k) => mem2.get(t + "|" + k) || null, all: async (t) => [...mem2.entries()].filter(([kk]) => kk.startsWith(t + "|")).map(([, v]) => v), put: async (t, r) => { mem2.set(t + "|" + (r.id || r.trade_id || r.position_id || r.order_id || Math.random()), r); return r; } }, now: () => clock, riskCheck: () => ({ veto: false }), fetchKlines: async () => [] });
  await eng2.init(); await eng2.start();
  clock += 3600000;
  const hi = await eng2.openPosition({ mode: "short", symbol: "BTCUSDT", direction: "Bullish", signal_timestamp: clock, closed_candle_time: clock, quote: { price: 100, received_at: clock }, analysis: A(95) });
  const eq = eng2.getAccount().total_equity;
  check("HighQualityMeaningfulSizeTest:高质量信号拿到有意义资金(≥20% 权益)", hi.ok === true && hi.position.initial_margin / eq >= 0.2, JSON.stringify({ ok: hi.ok, m: hi.position && hi.position.initial_margin, eq: eq }));
  check("FortyPercentHardCapTest:单仓保证金 ≤ eligible 的 40%(硬上限)", hi.ok === true && hi.position.initial_margin / eq <= 0.40 + 1e-6, JSON.stringify({ m: hi.position.initial_margin, eq: eq }));
  // 低质量:必须 SKIP(而不是开蚂蚁仓)
  clock += 3600000;
  const low = await eng2.openPosition({ mode: "short", symbol: "SOLUSDT", direction: "Bullish", signal_timestamp: clock, closed_candle_time: clock, quote: { price: 100, received_at: clock }, analysis: A(22) });
  check("LowQualitySkipTest:低质量信号被 Entry Gate 拒绝(不留交易记录痕迹)", low.ok === false && /entry_quality|below_min|SKIP/.test(String(low.reason)), JSON.stringify(low.reason));
  // 低净边际(费用吃掉):FEE_DRAG 规则生效(此前是死规则)
  const mmp = minimumMeaningfulPosition({ equity: 100, net_expected_edge_pct: 0.05, cost_pct: 0.12, requested_notional: 60 });
  check("FeeDragRuleLiveTest:净边际 0.05% 且成本 0.12%(占比>50%)→ FEE_DRAG_TOO_HIGH 不可行", mmp.feasible === false && mmp.reason === "FEE_DRAG_TOO_HIGH", JSON.stringify(mmp));
  check("FeeDragRuleLiveTest:净边际充足时该规则放行(不误杀)", minimumMeaningfulPosition({ equity: 100, net_expected_edge_pct: 0.30, cost_pct: 0.10, requested_notional: 60 }).feasible === true);
}

console.log("== 10. 相关山寨不能各拿 40% ==");
{
  // §67 更新说明:阵营口径从 80(加权) → 50(【真实保证金】同向上限)。旧口径与"单仓保证金可达 40%"自相矛盾,
  // 且加权组合上限(100)会在 gross≥50 时先绑定,使旧阵营参数永远轮不到生效;新口径=同向真实保证金 ≤50% 权益。
  const pure = capitalAllocation({ equity: 100, requested_pct: 40, quality_score: 90, positions: [
    { symbol: "BTCUSDT", direction: "LONG", status: "OPEN", remaining_margin: 30 },
    { symbol: "SOLUSDT", direction: "LONG", status: "OPEN", remaining_margin: 30 }
  ], available_cash: 1e12, symbol: "DOGEUSDT", direction: "LONG" });
  check("CorrelatedAltsCappedTest:相关度加权后第三枚同向币被拦(不许 40%×3)", pure.allowed === false && ["CLUSTER_CAP", "PORTFOLIO_CAP"].includes(pure.code), JSON.stringify({ a: pure.allowed, c: pure.code, caps: pure.caps_applied }));
  // 中间态:还有部分余量 → 必须"缩仓"而不是"全有/全无"
  const shrink = capitalAllocation({ equity: 100, requested_pct: 40, quality_score: 90, positions: [
    { symbol: "BTCUSDT", direction: "LONG", status: "OPEN", remaining_margin: 25 },
    { symbol: "SOLUSDT", direction: "LONG", status: "OPEN", remaining_margin: 20 }
  ], available_cash: 1e12, symbol: "DOGEUSDT", direction: "LONG" });
  check("CorrelatedAltsCappedTest:余量不足时缩仓到阵营余额(不是一刀切封死)", shrink.allowed === true && shrink.approved_usdt <= 5.01 && (shrink.caps_applied || []).includes("CLUSTER_CAP"), JSON.stringify({ a: shrink.allowed, u: shrink.approved_usdt, caps: shrink.caps_applied }));
  check("CorrelatedAltsCappedTest:上限口径=同向真实保证金 50% / 组合加权 100%", CAPITAL_LIMITS.cluster_same_direction_pct === 50 && CAPITAL_LIMITS.max_portfolio_margin_pct === 100);
}

console.log("== 11/12. Partial 与母仓(效率统计口径) ==");
{
  const position = { position_id: "p1", symbol: "SOLUSDT", mode: "short", initial_margin: 20, entry_time: 1700000000000, funding_simulated: 0.001 };
  const partial = { position_id: "p1", gross_pnl: 0.02, fees: 0.016, net_pnl: 0.004, entry_time: 1700000000000, exit_time: 1700000000000 + 3600000 };
  const final = { position_id: "p1", gross_pnl: 0.36, fees: 0.056, net_pnl: 0.30, entry_time: 1700000000000, exit_time: 1700000000000 + 2 * 3600000 };
  // 11) Partial 只赚 0.004U,但母仓最终 +0.304U → 不能判"交易失败/没意义"
  const effGood = capitalEfficiencyOf(position, [partial, final]);
  check("PartialTinyIsNotMotherFailureTest:0.004U 部分止盈不判定母仓失败(最终 +0.304U)", effGood.closed === true && effGood.net_pnl > 0.3 && effGood.low_capital_efficiency === false, JSON.stringify({ net: effGood.net_pnl, low: effGood.low_capital_efficiency }));
  check("PartialTinyIsNotMotherFailureTest:效率按母仓累计口径(不是单事件)", effGood.events === 2 && Math.abs(effGood.net_pnl - 0.304) < 1e-6, JSON.stringify(effGood.net_pnl));
  // 12) 20U 持仓 2h 只赚 0.005U → 必须明确标 LOW / 尘埃
  const effBad = capitalEfficiencyOf(position, [{ position_id: "p1", gross_pnl: 0.021, fees: 0.016, net_pnl: 0.005, entry_time: 1700000000000, exit_time: 1700000000000 + 2 * 3600000 }]);
  check("MotherEfficiencyFlagTest:20U/2h/+0.005U → LOW_CAPITAL_EFFICIENCY + 尘埃盈利", effBad.low_capital_efficiency === true && effBad.dust_profit === true && effBad.return_on_margin_pct === 0.025, JSON.stringify({ low: effBad.low_capital_efficiency, dust: effBad.dust_profit, r: effBad.return_on_margin_pct }));
  check("MotherEfficiencyFlagTest:fee_drag_ratio 可解释(费用/毛收益)", effBad.fee_drag_ratio != null && effBad.fee_drag_ratio > 0.7, JSON.stringify(effBad.fee_drag_ratio));
  check("MotherEfficiencyFlagTest:返回中文原因", /低资金效率|尘埃级/.test(effBad.note_zh), effBad.note_zh);
}

console.log("== 接线与 UI(源码守约) ==");
check("HostDynamicUniverseTest:后台运行时不再是写死 5 币", !/candidateSymbols: \(\) => \["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"\]/.test(hostSrc) && /refreshUniverse/.test(hostSrc) && /QE\.buildScan/.test(hostSrc));
check("HostUniverseStatusTest:状态上报含 universe(真机可见扫了什么)", /universe: uni/.test(hostSrc) && /shortlist/.test(hostSrc));
check("MarketScanPanelTest:市场页有扫描面板(扫描/候选/深度/机会)", /id="mkScanPanel"/.test(pageSrc) && /mkScanCounts/.test(pageSrc) && /扫描 " \+ \(c\.scanned \|\| 0\)/.test(pageSrc));
check("MarketScanPanelTest:逐币状态与淘汰原因(简洁中文)", /primaryReasonZh/.test(pageSrc) && /block_reasons_zh\[0\]/.test(pageSrc));
check("UniverseHealthDiagTest:诊断页有 Universe Health", /diagUniverseBox/.test(pageSrc) && /Universe Health/.test(pageSrc));
check("PageCandidateFromScanTest:页面候选来自扫描短名单", /if \(scan && Array\.isArray\(scan\.shortlist\)\) for \(const row of scan\.shortlist\)/.test(pageSrc));
check("SizingSeparationTests:引擎已按'风险预算÷(止损×杠杆)'换算保证金", /riskBudget \/ \(stopFrac \* levForCap\)/.test(fs.readFileSync(path.join(ROOT, "worker/src/paper/engine.js"), "utf8")));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("UNIVERSE + EFFICIENCY TESTS OK");
