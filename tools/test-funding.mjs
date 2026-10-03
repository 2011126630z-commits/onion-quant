// tools/test-funding.mjs · V14.3 Funding 费率测试
// 核心主张:费率只能来自上游真实响应;取不到一律 unavailable;禁止随机生成
// A 规范化与校验  B 观测簿状态机  C 资金费结算数学  D 引擎集成  E 路由与"无随机"证明
import fs from "node:fs";
import path from "node:path";
import {
  FU_SOURCE, FU_DEFAULT_INTERVAL_HOURS, FU_MAX_AGE_MS, FU_RATE_SANITY, FUNDING_STATUS,
  normalizeFunding, normalizeFundingList, fundingCashflow, createFundingBook, accrueFunding,
  applyFundingToPosition, fundingLabel
} from "../worker/src/paper/funding.js";
import { createPaperEngine } from "../worker/src/paper/engine.js";
import { createHistoryStore } from "../worker/src/history/store.js";
import worker from "../worker/index.js";
import { convertOkxFunding, convertBybitFunding, normalizeBinanceFunding, routes } from "../worker/src/proxy.js";

const ROOT = path.resolve(import.meta.dirname, "..");
let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log("PASS  " + name); }
  else { failed += 1; console.log("FAIL  " + name + (detail ? "  => " + detail : "")); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}
function near(name, actual, expected, tol) {
  check(name, Math.abs(actual - expected) <= (tol == null ? 1e-9 : tol), `got ${actual} want ~${expected}`);
}

const HOUR = 3600000;
const T0 = 1700000000000;

console.log("== A. 规范化与校验(坏数据一律丢弃) ==");
{
  const good = normalizeFunding({ symbol: "BTCUSDT", lastFundingRate: "0.0001", nextFundingTime: T0 + HOUR, markPrice: "42000" });
  check("Binance premiumIndex 响应可规范化", good != null && good.symbol === "BTCUSDT", JSON.stringify(good));
  near("费率保留原值", good.rate, 0.0001, 1e-12);
  near("费率百分比换算", good.rate_pct, 0.01, 1e-9);
  eq("符号大写", normalizeFunding({ symbol: "btcusdt", lastFundingRate: 0 }).symbol, "BTCUSDT");
  eq("缺 symbol 丢弃", normalizeFunding({ lastFundingRate: 0.0001 }), null);
  eq("缺费率丢弃", normalizeFunding({ symbol: "BTCUSDT" }), null);
  eq("费率非数字丢弃", normalizeFunding({ symbol: "BTCUSDT", lastFundingRate: "abc" }), null);
  eq("费率 null 丢弃", normalizeFunding({ symbol: "BTCUSDT", lastFundingRate: null }), null);
  eq("费率 NaN 丢弃", normalizeFunding({ symbol: "BTCUSDT", lastFundingRate: NaN }), null);
  eq("费率 Infinity 丢弃", normalizeFunding({ symbol: "BTCUSDT", lastFundingRate: Infinity }), null);
  eq("超合理上限(3%)丢弃", normalizeFunding({ symbol: "BTCUSDT", lastFundingRate: 0.5 }), null);
  check("恰在上限内接受", normalizeFunding({ symbol: "BTCUSDT", lastFundingRate: FU_RATE_SANITY }) != null);
  const negRate = normalizeFunding({ symbol: "BTCUSDT", lastFundingRate: -0.0003 });
  check("负费率(空头付费)合法", negRate != null && negRate.rate < 0);
  eq("OKX 字段名 fundingRate 兼容", normalizeFunding({ symbol: "ETHUSDT", fundingRate: 0.0002 }).rate, 0.0002);
  eq("默认 8 小时一期", normalizeFunding({ symbol: "BTCUSDT", lastFundingRate: 0 }).interval_hours, FU_DEFAULT_INTERVAL_HOURS);
  eq("异常周期回落到默认值", normalizeFunding({ symbol: "BTCUSDT", lastFundingRate: 0, fundingIntervalHours: 999 }).interval_hours, 8);
  const list = normalizeFundingList([{ symbol: "BTCUSDT", lastFundingRate: 0.0001 }, { symbol: "ETHUSDT", lastFundingRate: "x" }, { lastFundingRate: 0.1 }]);
  eq("批量规范化只保留合法行", Object.keys(list), ["BTCUSDT"]);
}

console.log("== B. 观测簿状态机 ==");
{
  let clock = T0;
  const book = createFundingBook({ now: () => clock });
  eq("尚未观测 → unavailable", book.statusOf("BTCUSDT").status, FUNDING_STATUS.UNAVAILABLE);
  eq("未观测原因可追溯", book.statusOf("BTCUSDT").reason, "never_observed");
  const obs = book.observe("BTCUSDT", { symbol: "BTCUSDT", lastFundingRate: 0.0001, nextFundingTime: T0 + HOUR });
  check("观测成功 → live", obs.ok === true && book.statusOf("BTCUSDT").status === FUNDING_STATUS.LIVE);
  near("live 时返回真实费率", book.statusOf("BTCUSDT").rate, 0.0001, 1e-12);
  clock += FU_MAX_AGE_MS + 1;
  eq("观测过期 → stale(不再冒充实时)", book.statusOf("BTCUSDT").status, FUNDING_STATUS.STALE);
  eq("stale 时费率为 null(不拿旧值当实时)", book.statusOf("BTCUSDT").rate, null);
  clock = T0;
  book.observe("BTCUSDT", { symbol: "BTCUSDT", lastFundingRate: 0.0001 });
  eq("重新观测 → 恢复 live", book.statusOf("BTCUSDT").status, FUNDING_STATUS.LIVE);
  book.markUnavailable("ETHUSDT", "upstream 502");
  const ethStatus = book.statusOf("ETHUSDT");
  check("上游失败 → 明确 unavailable", ethStatus.status === FUNDING_STATUS.UNAVAILABLE && ethStatus.reason === "upstream 502");
  eq("不可用时不暴露费率", ethStatus.rate, null);
  const counters = book.counters();
  check("计数器如实统计", counters.observed >= 2 && counters.unavailable_marked === 1, JSON.stringify(counters));
  check("快照包含全部被观测符号", book.snapshot().length === 2);
  // 损坏负载 → 标记 unavailable 而不是瞎猜
  const badObs = book.observe("SOLUSDT", { symbol: "SOLUSDT", lastFundingRate: "oops" });
  check("损坏负载被拒并标 unavailable", badObs.ok === false && book.statusOf("SOLUSDT").status === FUNDING_STATUS.UNAVAILABLE);
}

console.log("== C. 资金费结算数学 ==");
{
  const book = createFundingBook({ now: () => T0 + 24 * HOUR });
  book.observe("BTCUSDT", { symbol: "BTCUSDT", lastFundingRate: 0.0001 });
  const longPos = { symbol: "BTCUSDT", side: "LONG", notional: 1000, entry_time: T0, last_funding_time: T0, status: "OPEN" };
  const longRes = accrueFunding(longPos, book, { now: T0 + 24 * HOUR, notional: 1000 });
  eq("正费率下多头付费(金额为负)", longRes.amount < 0, true);
  near("跨 3 期 × 1000 名义 × 0.01% = -0.3", longRes.amount, -0.3, 1e-9);
  eq("已计价期数", longRes.intervals_crossed, 3);
  eq("结算状态 live", longRes.status, FUNDING_STATUS.LIVE);
  eq("结算后资金费时钟推进到最后一期", longRes.settled_until, Math.floor(T0 / (8 * HOUR)) * (8 * HOUR) + 8 * HOUR * 3);

  const shortPos = { ...longPos, side: "SHORT" };
  const shortRes = accrueFunding(shortPos, book, { now: T0 + 24 * HOUR, notional: 1000 });
  near("正费率下空头收钱(金额为正)", shortRes.amount, 0.3, 1e-9);
  near("多头 + 空头现金流净额为 0(零和)", longRes.amount + shortRes.amount, 0, 1e-9);

  const negBook = createFundingBook({ now: () => T0 + 24 * HOUR });
  negBook.observe("BTCUSDT", { symbol: "BTCUSDT", lastFundingRate: -0.0002 });
  const negLong = accrueFunding(longPos, negBook, { now: T0 + 24 * HOUR, notional: 1000 });
  check("负费率下多头收钱", negLong.amount > 0, String(negLong.amount));
  near("负费率数额", negLong.amount, 0.6, 1e-9);

  // 取不到费率:金额 0,但期数如实上报
  const emptyBook = createFundingBook({ now: () => T0 + 24 * HOUR });
  const missing = accrueFunding(longPos, emptyBook, { now: T0 + 24 * HOUR, notional: 1000 });
  eq("无费率 → amount 恒为 0", missing.amount, 0);
  eq("无费率 → 状态 unavailable", missing.status, FUNDING_STATUS.UNAVAILABLE);
  eq("无费率 → 无法计价的期数如实上报", missing.missed_intervals, 3);
  eq("无费率 → applicable=false(不假装已计费)", missing.applicable, false);

  const noBook = accrueFunding(longPos, null, { now: T0 + 24 * HOUR, notional: 1000 });
  eq("完全没有观测簿也安全", [noBook.amount, noBook.status], [0, FUNDING_STATUS.UNAVAILABLE]);

  const notCrossed = accrueFunding({ ...longPos, last_funding_time: T0 + 7 * HOUR }, book, { now: T0 + 7 * HOUR + 1000, notional: 1000 });
  eq("未跨过资金费时间点 → 不结算", [notCrossed.applicable, notCrossed.amount, notCrossed.intervals_crossed], [false, 0, 0]);

  // 时钟推进后不重复计费
  const once = accrueFunding(longPos, book, { now: T0 + 24 * HOUR, notional: 1000 });
  const advanced = applyFundingToPosition(longPos, once);
  const twice = accrueFunding(advanced, book, { now: T0 + 24 * HOUR, notional: 1000 });
  eq("同一时间窗重复结算不重复计费", [twice.amount, twice.intervals_crossed], [0, 0]);
  const later = accrueFunding(advanced, book, { now: T0 + 32 * HOUR, notional: 1000 });
  near("时间推进后才计下一期", later.amount, -0.1, 1e-9);

  eq("非法方向不产生现金流", fundingCashflow({ side: "FLAT" }, 0.0001, 1000), 0);
  eq("非法名义不产生现金流", fundingCashflow({ side: "LONG" }, 0.0001, 0), 0);
}

console.log("== D. 仓位字段与文案(不显示假零) ==");
{
  const pos = { symbol: "BTCUSDT", side: "LONG", notional: 1000, funding_status: "unavailable", funding_simulated: 0 };
  const applied = applyFundingToPosition(pos, { applicable: true, amount: -0.3, status: "live", provider: FU_SOURCE, rate: 0.0001, rate_pct: 0.01, intervals_crossed: 3, missed_intervals: 0, settled_until: T0 });
  near("累计资金费写入仓位", applied.funding_simulated, -0.3, 1e-9);
  eq("来源与费率留痕", [applied.funding_source, applied.funding_intervals], [FU_SOURCE, 3]);
  const missedApplied = applyFundingToPosition({ ...pos }, { applicable: false, amount: 0, status: "unavailable", intervals_crossed: 2, missed_intervals: 2 });
  eq("不可用时金额保持 0(不动账本)", missedApplied.funding_simulated, 0);
  eq("不可用但期数如实记录", missedApplied.funding_missed_intervals, 2);
  check("文案说明 unavailable 与缺失期数", fundingLabel(missedApplied).includes("unavailable(缺 2 期费率)"), fundingLabel(missedApplied));
  check("live 文案带金额与期数", fundingLabel(applied).includes("资金费 -0.3000 USDT · 3 期"), fundingLabel(applied));
}

console.log("== E. 引擎集成 ==");
// 注意:短线 maxHold = 6h,推进时间必须留在持有窗口内,否则会先被时间止盈平仓
const HOLD_STEP_MS = 3 * HOUR;
async function makeEngine(clockRef) {
  const store = await createHistoryStore({ memory: true });
  const eng = createPaperEngine({
    store: { get: (t, k) => store.generic.get(t, k), all: (t) => store.generic.all(t), put: (t, r) => store.generic.put(t, r) },
    now: () => clockRef.value,
    riskCheck: () => ({ veto: false }),
    fetchKlines: async () => []
  });
  await eng.init();
  await eng.start();
  const open = await eng.openPosition({ mode: "short", symbol: "BTCUSDT", direction: "Bullish", signal_timestamp: clockRef.value, quote: { price: 100, received_at: clockRef.value }, analysis: { direction: "Bullish", volatility: { atrPct: 1 }, market_regime: { label: "Weak Uptrend" } } });
  return { eng, open };
}

// E-1 取不到费率:跨过资金费时间点也不产生任何盈亏,但如实记录缺失期数
{
  const clockRef = { value: T0 };
  const { eng, open } = await makeEngine(clockRef);
  check("开仓成功", open.ok === true, JSON.stringify(open).slice(0, 100));
  const pos = eng.getPositions().find((p) => p.status === "OPEN");
  eq("新仓资金费状态为 unavailable", pos.funding_status, "unavailable");
  eq("新仓资金费累计为 0", pos.funding_simulated, 0);
  near("新仓资金费时钟 = 建仓时间", pos.last_funding_time, clockRef.value, 1);
  check("引擎暴露观测入口", typeof eng.observeFunding === "function" && typeof eng.markFundingUnavailable === "function");
  const cashBefore = eng.getAccount().cash_balance;
  clockRef.value += HOLD_STEP_MS;
  const loop1 = await eng.loop({ quotes: { BTCUSDT: { price: 100, high: 100, low: 100, received_at: clockRef.value } }, candidates: [] });
  check("Loop 正常", loop1.ok === true, JSON.stringify(loop1.summary));
  const posAfter = eng.getPositions().find((p) => p.symbol === "BTCUSDT");
  eq("持仓仍在(未被时间止盈)", posAfter.status, "OPEN");
  eq("无费率时累计资金费仍为 0", posAfter.funding_simulated, 0);
  eq("无费率时被标记 unavailable", posAfter.funding_status, "unavailable");
  check("无费率时缺失期数被如实记录(≥1)", posAfter.funding_missed_intervals >= 1, String(posAfter.funding_missed_intervals));
  near("无费率时不凭空扣钱", eng.getAccount().cash_balance, cashBefore, 1e-9);
  eq("账户累计资金费为 0", Number(eng.getAccount().funding_paid || 0), 0);
}

// E-2a 费率观测过期(stale):跨过资金费时间点也不许用旧费率计费
{
  const clockRef = { value: T0 };
  const { eng, open } = await makeEngine(clockRef);
  check("开仓成功(stale 场景)", open.ok === true);
  eng.observeFunding("BTCUSDT", { symbol: "BTCUSDT", lastFundingRate: 0.0001, provider: "binance" });
  const cashBefore = eng.getAccount().cash_balance;
  clockRef.value += HOLD_STEP_MS;   // 既跨过资金费时间点,又超出 15 分钟新鲜度窗口
  const staleStatus = eng.fundingBook.statusOf("BTCUSDT");
  eq("超过新鲜度窗口 → stale", staleStatus.status, FUNDING_STATUS.STALE);
  eq("stale 时不暴露费率", staleStatus.rate, null);
  const posStale = eng.getPositions().find((p) => p.symbol === "BTCUSDT");
  const staleAccrual = await eng.settleFunding(posStale);
  eq("stale 时不计费(金额 0)", staleAccrual.amount, 0);
  eq("stale 也被记为不可计价", staleAccrual.status, FUNDING_STATUS.UNAVAILABLE);
  eq("stale 的缺失期数如实记录", staleAccrual.missed_intervals, 1);
  near("stale 时账本不动", eng.getAccount().cash_balance, cashBefore, 1e-9);
  eq("仓位资金费状态回落为 unavailable", posStale.funding_status, "unavailable");
}

// E-2b 有真实费率:按真实节奏(每 10 分钟重新观测)结算,并在账本上留痕
const OBSERVE_STEP_MS = 10 * 60000;
{
  const clockRef = { value: T0 };
  const { eng, open } = await makeEngine(clockRef);
  check("开仓成功(含费率场景)", open.ok === true);
  const first = eng.observeFunding("BTCUSDT", { symbol: "BTCUSDT", lastFundingRate: 0.0001, provider: "binance" });
  check("喂入真实费率成功", first.ok === true);
  const posBefore = eng.getPositions().find((p) => p.status === "OPEN");
  const notional = Number(posBefore.notional);
  const cashBefore = eng.getAccount().cash_balance;

  let looped = 0;
  while (clockRef.value < T0 + HOLD_STEP_MS) {
    clockRef.value += OBSERVE_STEP_MS;
    eng.observeFunding("BTCUSDT", { symbol: "BTCUSDT", lastFundingRate: 0.0001, provider: "binance" });
    await eng.loop({ quotes: { BTCUSDT: { price: 100, high: 100, low: 100, received_at: clockRef.value } }, candidates: [] });
    looped += 1;
  }
  check("按 10 分钟节奏推进了多轮 loop", looped >= 5, String(looped));
  const posLive = eng.getPositions().find((p) => p.symbol === "BTCUSDT");
  eq("有费率后状态转为 live", posLive.funding_status, "live");
  eq("有费率后累计资金费非 0(方向正确)", posLive.funding_simulated !== 0, true);
  eq("持仓仍未被平仓", posLive.status, "OPEN");
  eq("只结算了实际跨过的期数", posLive.funding_intervals, 1);
  near("结算额 = 名义 × 费率 × 跨过期数", posLive.funding_simulated, -(notional * 0.0001) * posLive.funding_intervals, 1e-6);
  check("费率来源留痕", posLive.funding_source === "binance" && Number(posLive.funding_rate) === 0.0001, JSON.stringify({ p: posLive.funding_source, r: posLive.funding_rate }));
  check("账户现金随资金费变动", eng.getAccount().cash_balance !== cashBefore);
  near("funding_paid 与仓位累计互为相反数", Number(eng.getAccount().funding_paid), -posLive.funding_simulated, 1e-6);

  // 平仓前结清
  const closed = await eng.closePosition(posLive, { reference_price: 100, exit_reason: "manual", now: clockRef.value });
  check("平仓成功", closed.ok === true, JSON.stringify(closed).slice(0, 120));
}

// E-3 上游失败:显式标 unavailable,账本不动
{
  const clockRef = { value: T0 };
  const { eng } = await makeEngine(clockRef);
  const cashBefore = eng.getAccount().cash_balance;
  eng.markFundingUnavailable("BTCUSDT", "upstream timeout");
  clockRef.value += HOLD_STEP_MS;
  await eng.loop({ quotes: { BTCUSDT: { price: 100, high: 100, low: 100, received_at: clockRef.value } }, candidates: [] });
  const pos = eng.getPositions().find((p) => p.symbol === "BTCUSDT");
  eq("上游失败 → unavailable", pos.funding_status, "unavailable");
  eq("上游失败 → 金额为 0", pos.funding_simulated, 0);
  near("上游失败 → 账本不动", eng.getAccount().cash_balance, cashBefore, 1e-9);
}

console.log("== F. 上游路由 + 禁止随机 ==");
{
  eq("Binance 资金费路由存在", routes.futures.funding, "/fapi/v1/premiumIndex");
  const bin = normalizeBinanceFunding({ symbol: "BTCUSDT", lastFundingRate: "0.0001", nextFundingTime: T0 });
  check("Binance 响应规范化带 provider", bin && bin.provider === "binance");
  eq("Binance 非法响应返回 null", normalizeBinanceFunding({ symbol: "BTCUSDT" }), null);
  const okx = convertOkxFunding({ instId: "BTC-USDT-SWAP", fundingRate: "0.0001", nextFundingTime: T0 + HOUR, fundingTime: T0 });
  check("OKX 资金费转换", okx && okx.symbol === "BTCUSDT" && okx.provider === "okx", JSON.stringify(okx));
  check("OKX 推导 1 小时周期", okx.fundingIntervalHours === 1, String(okx.fundingIntervalHours));
  eq("OKX 缺费率返回 null", convertOkxFunding({ instId: "BTC-USDT-SWAP" }), null);
  const bybit = convertBybitFunding({ symbol: "BTCUSDT", fundingRate: "0.0002", nextFundingTime: T0 + HOUR, markPrice: "42000" });
  check("Bybit 资金费转换", bybit && bybit.symbol === "BTCUSDT" && bybit.provider === "bybit", JSON.stringify(bybit));
  eq("Bybit 缺费率返回 null", convertBybitFunding({ symbol: "BTCUSDT" }), null);
  check("规范化后的三种上游都能被观测簿接受", [okx, bybit, bin].every((x) => normalizeFunding(x) != null));

  // 路由层:现货请求资金费明确拒绝
  const spotRes = await worker.fetch(new Request("https://app.local/api/funding?market=spot&symbol=BTCUSDT"));
  const spotBody = await spotRes.json();
  check("现货请求资金费返回 400(不伪造)", spotRes.status === 400 && /仅期货/.test(spotBody.error), JSON.stringify(spotBody));

  const src = fs.readFileSync(path.join(ROOT, "worker/src/paper/funding.js"), "utf8");
  check("funding.js 不含任何随机数", !/Math\.random/.test(src));
  check("funding.js 不含硬编码费率常量(除合理上限)", !/rate\s*[:=]\s*0\.0[0-9]+/.test(src));
  const engineSrc = fs.readFileSync(path.join(ROOT, "worker/src/paper/engine.js"), "utf8");
  check("引擎 funding 结算不含随机数", !/Math\.random/.test(engineSrc.split("settleFunding")[1] ? engineSrc.split("settleFunding")[1].slice(0, 2000) : ""));
  const pageSrc = fs.readFileSync(path.join(ROOT, "worker/src/ui/page.js"), "utf8");
  check("页面按真实上游结果喂入费率", /observeFundingFromTickers/.test(pageSrc) && /api\("funding\?market=futures/.test(pageSrc));
  check("取不到时页面显式标 unavailable", /markFundingUnavailable\(symbol\.toUpperCase\(\)|markFundingUnavailable\(symbol/.test(pageSrc));

  // 决定性证明:把观测簿灌 200 次空数据,金额必须恒为 0
  const book = createFundingBook({});
  let allZero = true;
  for (let i = 0; i < 200; i += 1) {
    const r = accrueFunding({ symbol: "BTCUSDT", side: "LONG", notional: 5000, entry_time: T0, last_funding_time: T0 + i * 8 * HOUR, status: "OPEN" }, book, { now: T0 + (i + 1) * 8 * HOUR, notional: 5000 });
    if (r.amount !== 0) allZero = false;
  }
  check("200 次无费率结算:金额恒为 0(不存在随机生成)", allZero === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("FUNDING TESTS OK");
