// tools/test-futures-integrity.mjs · V15 P0 HOTFIX 验收:价格路由 / PnL / 强平不变量 /
// 止损与移动止损真实触发 / 部分平仓重算 / 账户对账 / 无效样本过滤 / 脏数据迁移
// 全部为离线纯函数与内存引擎测试,不联网、不接真实资金。
import { createHistoryStore } from "../worker/src/history/store.js";
import {
  PAPER_DEFAULTS, num, round, unrealizedPnl, unrealizedNetPnl, estimatedExitFee,
  openQuantityOf, openMarginOf, lossBoundOf, returnPct, priceMovePct, accountIntegrityCheck, sideOf,
  applyClose
} from "../worker/src/paper/accounting.js";
import {
  liquidationPriceOf, liquidationInvariant, liquidationFillPrice, isLiquidated,
  ratchetStop, updateTrailingStop, applyBreakEven, MAINTENANCE_MARGIN_RATE
} from "../worker/src/paper/futures.js";
import { createDataHub } from "../worker/src/paper/dataHub.js";
import { createPaperEngine } from "../worker/src/paper/engine.js";
import { positionView } from "../worker/src/ui/viewModels.js";

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
  check(name, Math.abs(num(actual) - num(expected)) <= (tol === undefined ? 1e-6 : tol), `got ${actual} want ~${expected}`);
}

function mkAdapter(store) {
  return { get: (t, k) => store.generic.get(t, k), all: (t) => store.generic.all(t), put: (t, r) => store.generic.put(t, r), del: (t, k) => store.generic.del(t, k) };
}

console.log("== 1. PRICE SYMBOL ROUTING / CACHE ISOLATION ==");

async function main() {

  // 1.1 DataHub 缓存键必须含 symbol(禁止只按 data_type/interval 缓存)
  const hub = createDataHub({ now: () => 1700000000000 });
  hub.set({ provider: "binance", symbol: "BTCUSDT", data_type: "price", interval: "1m" }, { price: 84000 });
  hub.set({ provider: "binance", symbol: "BNBUSDT", data_type: "price", interval: "1m" }, { price: 764 });
  const btcCache = hub.get({ provider: "binance", symbol: "BTCUSDT", data_type: "price", interval: "1m" });
  const bnbCache = hub.get({ provider: "binance", symbol: "BNBUSDT", data_type: "price", interval: "1m" });
  const ethCache = hub.get({ provider: "binance", symbol: "ETHUSDT", data_type: "price", interval: "1m" });
  near("CACHE ISOLATION:BTC 只拿到 BTC 的缓存", btcCache.ok && btcCache.value.price, 84000);
  near("CACHE ISOLATION:BNB 只拿到 BNB 的缓存", bnbCache.ok && bnbCache.value.price, 764);
  check("CACHE ISOLATION:未缓存的 ETH 必须是 miss(不允许串到别人)", ethCache.ok === false, JSON.stringify(ethCache).slice(0, 120));

  // 1.2 三个持仓 + 乱序响应:每个持仓只能拿到自己的价格
  const clockRef = { t: 1700000000000 };
  const mkEngine = (adapterStore) => createPaperEngine({
    store: adapterStore,
    now: () => clockRef.t,
    riskCheck: () => ({ veto: false, risk_score: 25 }),
    fetchKlines: async () => []
  });
  const eng = mkEngine(mkAdapter(await createHistoryStore({ memory: true })));
  await eng.init();
  const openAt = (symbol, direction, price, leverage, mode, candleOffset) => eng.openPosition({
    mode,
    symbol,
    direction,
    signal_timestamp: clockRef.t + (candleOffset || 0),
    quote: { price, received_at: clockRef.t },
    analysis: { direction, confidence: 70, volatility: { atrPct: 1 }, market_regime: { label: "Weak Uptrend" } },
    leverage
  });
  const long = await openAt("BTCUSDT", "Bullish", 84000, 2, "long", 0);
  const short = await openAt("BNBUSDT", "Bearish", 764, 2, "short", 0);
  const eth = await openAt("ETHUSDT", "Bullish", 2712, 2, "short", 0);
  check("三个不同 symbol 的持仓都能开出来", long.ok && short.ok && eth.ok, JSON.stringify([long.reason, short.reason, eth.reason]));

  // 故意乱序:BNB 先回、ETH 其次、BTC 最后;且夹一个错串的 symbol
  const quotes = {};
  quotes.BNBUSDT = { symbol: "BNBUSDT", price: 770, received_at: clockRef.t };
  quotes.ETHUSDT = { symbol: "ETHUSDT", price: 2700, received_at: clockRef.t };
  quotes.BTCUSDT = { symbol: "BTCUSDT", price: 83000, received_at: clockRef.t };
  const pass1 = await eng.riskPass({ quotes });
  const byId = (id) => eng.getPositions().find((p) => p.position_id === id);
  const pBtc = byId(long.position.position_id);
  const pBnb = byId(short.position.position_id);
  const pEth = byId(eth.position.position_id);
  near("PRICE ROUTING:BTC 用 BTC 价", pBtc.current_price, 83000);
  near("PRICE ROUTING:BNB 用 BNB 价(不被 ETH/BTC 污染)", pBnb.current_price, 770);
  near("PRICE ROUTING:ETH 用 ETH 价", pEth.current_price, 2700);
  check("PRICE ROUTING:三个持仓现价互不相同(无串价)",
    new Set([pBtc.current_price, pBnb.current_price, pEth.current_price]).size === 3,
    JSON.stringify([pBtc.current_price, pBnb.current_price, pEth.current_price]));
  check("PRICE ROUTING:riskPass 记录 price_source", Boolean(pBtc.price_source) && pBtc.price_status === "OK", JSON.stringify({ s: pBtc.price_source, st: pBtc.price_status }));

  // 1.3 symbol 不匹配 → 拒绝写入 + PRICE_SYMBOL_MISMATCH + 暂停新开仓
  const beforeBtc = pBtc.current_price;
  const mismatch = await eng.riskPass({ quotes: { BTCUSDT: { symbol: "ETHUSDT", price: 9999, received_at: clockRef.t } } });
  near("PRICE ROUTING:symbol 不匹配时拒绝写入(现价保持不变)", byId(long.position.position_id).current_price, beforeBtc);
  check("PRICE ROUTING:记录 PRICE_SYMBOL_MISMATCH", num(mismatch.integrity && mismatch.integrity.price_symbol_mismatch) >= 1, JSON.stringify(mismatch.integrity));
  check("PRICE ROUTING:出现串价即暂停新开仓", eng.getIntegrity().entries_paused === true, JSON.stringify(eng.getIntegrity()));
  const pausedLoop = await eng.loop({ quotes, candidates: [{ symbol: "BTCUSDT", mode: "short", analysis: { direction: "Bullish" }, riskPct: 10 }] });
  check("PRICE ROUTING:暂停后 loop 不再开新仓", num(pausedLoop.summary && pausedLoop.summary.opened && pausedLoop.summary.opened.length) === 0, JSON.stringify(pausedLoop.summary && pausedLoop.summary.skipped));
  eng.clearIntegrityPause();

  // 1.4 非法价格(0 / NaN / 负数)一律不写
  const beforeEth = byId(eth.position.position_id).current_price;
  for (const bad of [0, NaN, -5, null, undefined, "abc"]) {
    await eng.riskPass({ quotes: { ETHUSDT: { symbol: "ETHUSDT", price: bad, received_at: clockRef.t } } });
  }
  near("PRICE ROUTING:0/NaN/负价/非数字都不写进持仓", byId(eth.position.position_id).current_price, beforeEth);
  check("PRICE ROUTING:非法价格被计数", num(eng.getIntegrity().invalid_price) >= 5, String(eng.getIntegrity().invalid_price));

  // 1.5 snapshot 的价格回调也必须过守卫(常量/脏值都不能写)
  eng.snapshot(() => 0);
  eng.snapshot(() => NaN);
  near("snapshot(() => 0) 不写 0 价", byId(eth.position.position_id).current_price, beforeEth);
  const snapEth = eng.snapshot((sym) => (sym === "ETHUSDT" ? 2760 : undefined));
  near("snapshot 按 symbol 取价:ETH 用 2760", snapEth.positions.find((p) => p.symbol === "ETHUSDT").current_price, 2760);
  check("snapshot 不会把 ETH 的价写给 BTC", byId(long.position.position_id).current_price !== 2760, String(byId(long.position.position_id).current_price));

  console.log("== 2. PNL 数学(LONG / SHORT / 部分平仓 / 口径) ==");
  const longPos = { side: "LONG", entry_price: 100, quantity: 0.2, remaining_quantity: 0.2, remaining_margin: 10, entry_notional: 10, fees: 0.008 };
  const shortPos = { ...longPos, side: "SHORT" };
  near("PNL LONG:105 → +1", unrealizedPnl(longPos, 105), 1);
  near("PNL LONG:95 → -1", unrealizedPnl(longPos, 95), -1);
  near("PNL SHORT:95 → +1", unrealizedPnl(shortPos, 95), 1);
  near("PNL SHORT:105 → -1", unrealizedPnl(shortPos, 105), -1);
  near("PNL 方向字段兼容(direction 而非 side)", unrealizedPnl({ ...longPos, side: undefined, direction: "SHORT" }, 95), 1);
  near("PNL ROE:保证金 10、盈利 1 → 10%", returnPct(longPos, 105), 10);
  near("PNL 价格变动口径:100→105 = +5%(不含杠杆)", priceMovePct(longPos, 105), 5);
  const halfPos = { ...longPos, remaining_quantity: 0.1, remaining_margin: 5, entry_notional: 5 };
  near("PARTIAL:剩余一半数量 → 浮盈减半(不再用原始 quantity)", unrealizedPnl(halfPos, 105), 0.5);
  near("PARTIAL:剩余一半保证金 → ROE 不变", returnPct(halfPos, 105), 10);
  near("PARTIAL:剩余数量口径", openQuantityOf(halfPos), 0.1);
  near("PARTIAL:剩余保证金口径", openMarginOf(halfPos), 5);
  near("PNL:预估平仓费按剩余名义", estimatedExitFee(longPos, 100), round(0.2 * 100 * PAPER_DEFAULTS.fee_bps / 10000, 8));
  near("PNL:净额 = 毛额 - 预估平仓费", unrealizedNetPnl(longPos, 105), round(1 - estimatedExitFee(longPos, 105), 8));
  near("LOSS BOUND:逐仓最大亏损 = 保证金 + 入场费 + 平仓费 + 平仓滑点", lossBoundOf(longPos, 100), round(10 + 0.008 + estimatedExitFee(longPos, 100) + 0.2 * 100 * (PAPER_DEFAULTS.slippage_bps + PAPER_DEFAULTS.half_spread_bps) / 10000, 8));
  check("LOSS BOUND:不可能亏损(远超上限)必须被判定越界", num(-22.94) < -(lossBoundOf({ ...longPos, entry_notional: 4.5, remaining_margin: 4.5 }, 764) + 1e-6));
  eq("方向判定:side/direction 都认", [sideOf(longPos), sideOf(shortPos), sideOf({ direction: "SHORT" })], ["LONG", "SHORT", "SHORT"]);

  console.log("== 3. LIQUIDATION(1x~10x / 双方向 / 不变量) ==");
  let liqBad = 0;
  let liqLossBad = 0;
  for (const lev of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const notional = 20;
    const margin = notional / lev;
    const qty = notional / 100;
    for (const side of ["LONG", "SHORT"]) {
      const liq = liquidationPriceOf({ side, entryPrice: 100, leverage: lev, maintenanceRate: MAINTENANCE_MARGIN_RATE });
      const inv = liquidationInvariant({ side, entryPrice: 100, liquidationPrice: liq });
      if (!inv.ok) liqBad += 1;
      if (side === "LONG" && !(liq < 100)) liqBad += 1;
      if (side === "SHORT" && !(liq > 100)) liqBad += 1;
      // 在强平价处结算,亏损必须落在保证金之内(逐仓上限)
      const pos = { side, entry_price: 100, quantity: qty, remaining_quantity: qty, remaining_margin: margin, entry_notional: margin, liquidation_price: liq };
      const loss = Math.abs(unrealizedPnl(pos, liq));
      if (loss > margin + 1e-6) liqLossBad += 1;
      if (!isLiquidated(pos, liq)) liqBad += 1;
    }
  }
  eq("LIQUIDATION:1x~10x 双方向均满足方向不变量", liqBad, 0);
  eq("LIQUIDATION:强平价处亏损不超过保证金(逐仓上限)", liqLossBad, 0);
  check("LIQUIDATION:方向反了必须报 LIQUIDATION_CALC_ERROR",
    liquidationInvariant({ side: "LONG", entryPrice: 100, liquidationPrice: 120 }).reason === "LIQUIDATION_CALC_ERROR" &&
    liquidationInvariant({ side: "SHORT", entryPrice: 100, liquidationPrice: 80 }).reason === "LIQUIDATION_CALC_ERROR");
  near("LIQUIDATION FILL:LONG 跳空到更低,只能按强平价成交", liquidationFillPrice({ side: "LONG", liquidation_price: 50 }, 20), 50);
  near("LIQUIDATION FILL:SHORT 跳空到更高,只能按强平价成交", liquidationFillPrice({ side: "SHORT", liquidation_price: 150 }, 300), 150);

  // 强平结算:脏价也不能穿透保证金
  const st = { account: { account_id: "a", cash_balance: 90, reserved_balance: 10, realized_pnl: 0, fees_paid: 0 }, wallets: { short: { available_balance: 60, reserved_balance: 10, realized_pnl: 0, allocated_balance: 70 } }, config: PAPER_DEFAULTS };
  const liqPos = { position_id: "p1", mode: "short", symbol: "BTCUSDT", side: "LONG", status: "OPEN", entry_price: 100, quantity: 0.2, remaining_quantity: 0.2, remaining_margin: 10, entry_notional: 10, fees: 0.008, liquidation_price: 50, current_price: 100, entry_time: 0, mfe: 0, mae: 0 };
  const liqClose = applyClose(st, liqPos, { now: 1000, reference_price: 5, exit_reason: "LIQUIDATION" });
  const liqLoss = num(liqClose.trade.net_pnl);
  check("LIQUIDATION:按强平价结算,亏损不穿透保证金", liqLoss >= -(lossBoundOf(liqPos) + 1e-6), `net=${liqLoss} bound=${-lossBoundOf(liqPos)}`);
  near("LIQUIDATION:成交价被抬回强平价", liqClose.trade.exit_price, round(50 * (1 - (PAPER_DEFAULTS.half_spread_bps + PAPER_DEFAULTS.slippage_bps) / 10000), 8), 1e-4);

  console.log("== 4. STOP / TRAILING 必须真的触发 ==");
  // 4.1 止损:LONG 价格跌穿 stop → 一个 riskPass 内关闭
  const eng2 = mkEngine(mkAdapter(await createHistoryStore({ memory: true })));
  await eng2.init();
  const s1 = await eng2.openPosition({
    mode: "short", symbol: "BTCUSDT", direction: "Bullish",
    signal_timestamp: clockRef.t, quote: { price: 100, received_at: clockRef.t },
    analysis: { direction: "Bullish", confidence: 70, volatility: { atrPct: 1 }, market_regime: { label: "Weak Uptrend" } },
    leverage: 2
  });
  const sPos = eng2.getPositions().find((p) => p.position_id === s1.position.position_id);
  check("STOP 前置:开仓带 stop_price", num(sPos.stop_price) > 0, String(sPos.stop_price));
  const stopPass = await eng2.riskPass({ quotes: { BTCUSDT: { symbol: "BTCUSDT", price: num(sPos.stop_price) - 1, received_at: clockRef.t } } });
  const sAfter = eng2.getPositions().find((p) => p.position_id === s1.position.position_id);
  check("STOP LONG:跌穿止损 → 一个价格轮次内 CLOSED", sAfter.status === "CLOSED" && stopPass.exits.some((e) => e.reason === "stop_loss"), JSON.stringify({ status: sAfter.status, exits: stopPass.exits }));

  // 4.2 止损:SHORT 价格涨穿 stop
  const eng3 = mkEngine(mkAdapter(await createHistoryStore({ memory: true })));
  await eng3.init();
  const s2 = await eng3.openPosition({
    mode: "short", symbol: "BTCUSDT", direction: "Bearish",
    signal_timestamp: clockRef.t, quote: { price: 100, received_at: clockRef.t },
    analysis: { direction: "Bearish", confidence: 70, volatility: { atrPct: 1 }, market_regime: { label: "Weak Downtrend" } },
    leverage: 2
  });
  const sPos2 = eng3.getPositions().find((p) => p.position_id === s2.position.position_id);
  const stopPass2 = await eng3.riskPass({ quotes: { BTCUSDT: { symbol: "BTCUSDT", price: num(sPos2.stop_price) + 1, received_at: clockRef.t } } });
  const sAfter2 = eng3.getPositions().find((p) => p.position_id === s2.position.position_id);
  check("STOP SHORT:涨穿止损 → CLOSED", sAfter2.status === "CLOSED" && stopPass2.exits.some((e) => e.reason === "stop_loss"), JSON.stringify({ status: sAfter2.status }));

  // 4.3 强平:2x LONG 跌到强平价以下 → 一个 riskPass 内 LIQUIDATION,且亏损 ≤ 保证金
  const eng4 = mkEngine(mkAdapter(await createHistoryStore({ memory: true })));
  await eng4.init();
  const s3 = await eng4.openPosition({
    mode: "short", symbol: "BTCUSDT", direction: "Bullish",
    signal_timestamp: clockRef.t, quote: { price: 100, received_at: clockRef.t },
    analysis: { direction: "Bullish", confidence: 70, volatility: { atrPct: 2 }, market_regime: { label: "Weak Uptrend" } },
    leverage: 5
  });
  const sPos3 = eng4.getPositions().find((p) => p.position_id === s3.position.position_id);
  const liqBound = lossBoundOf(sPos3);
  const liqPass = await eng4.riskPass({ quotes: { BTCUSDT: { symbol: "BTCUSDT", price: num(sPos3.liquidation_price) / 2, received_at: clockRef.t } } });
  const sAfter3 = eng4.getPositions().find((p) => p.position_id === s3.position.position_id);
  const liqTrade = eng4.getTrades().find((t) => t.symbol === "BTCUSDT");
  check("LIQUIDATION 触发:一个价格轮次内强平", sAfter3.status === "CLOSED" && liqPass.exits.some((e) => e.reason === "LIQUIDATION"), JSON.stringify({ status: sAfter3.status, exits: liqPass.exits }));
  check("LIQUIDATION 亏损受保证金约束", num(liqTrade && liqTrade.net_pnl) >= -(liqBound + 1e-6), `net=${liqTrade && liqTrade.net_pnl} bound=${liqBound}`);

  // 4.4 移动止损:有利方向移动后 stop_price 必须被抬高,然后回撤触发
  const trailPos = {
    position_id: "tr", symbol: "BTCUSDT", mode: "short", side: "LONG", direction: "LONG", status: "OPEN",
    entry_price: 100, quantity: 0.1, initial_quantity: 0.1, remaining_quantity: 0.1, entry_notional: 10,
    remaining_margin: 10, initial_margin: 10, leverage: 2, notional: 20, current_price: 100,
    stop_price: 98, initial_stop_price: 98, initial_risk: 2, tp_levels: [], tp_hit_count: 0, fees: 0.008
  };
  const trailed = updateTrailingStop(trailPos, 110, { atr: 2, atrMult: 1.2 });
  const ratcheted = ratchetStop(trailPos, trailed.stop_state.price);
  check("TRAILING:有利移动后候选止损上移", num(trailed.stop_state.price) > num(trailPos.stop_price), JSON.stringify(trailed.stop_state));
  check("TRAILING:候选价真正写回 stop_price(不再只是 UI 文案)", num(ratcheted.stop_price) > num(trailPos.stop_price), `stop=${ratcheted.stop_price}`);
  check("TRAILING:不允许反向放宽止损", num(ratchetStop({ ...trailPos, stop_price: 105 }, 103).stop_price) === 105, String(ratchetStop({ ...trailPos, stop_price: 105 }, 103).stop_price));
  const be = applyBreakEven(trailPos, 103, { atr: 2, triggerR: 1.0, config: PAPER_DEFAULTS });
  check("BREAK-EVEN:达到 1R 后把止损推到覆盖手续费的位置", be.changed && num(be.position.stop_state.price) > 100, JSON.stringify(be.position && be.position.stop_state));

  // 4.5 端到端:trailing 抬高后的止损真的会平仓(清掉 TP 档位,单独验证移动止损链路)
  const eng5 = mkEngine(mkAdapter(await createHistoryStore({ memory: true })));
  await eng5.init();
  const s4 = await eng5.openPosition({
    mode: "short", symbol: "BTCUSDT", direction: "Bullish",
    signal_timestamp: clockRef.t, quote: { price: 100, received_at: clockRef.t },
    analysis: { direction: "Bullish", confidence: 70, volatility: { atrPct: 2 }, market_regime: { label: "Weak Uptrend" } },
    leverage: 2
  });
  const stopBeforeTrail = num(s4.position.stop_price);
  const liveTrail = eng5.getPositions().find((p) => p.position_id === s4.position.position_id);
  liveTrail.tp_levels = [];              // 隔离变量:只留 stop 链路
  liveTrail.take_profit_price = null;
  // 先有利移动到 120(触发移动止损上移),再回撤到抬高的止损之下
  await eng5.riskPass({ quotes: { BTCUSDT: { symbol: "BTCUSDT", price: 120, received_at: clockRef.t } } });
  const raised = eng5.getPositions().find((p) => p.position_id === s4.position.position_id);
  check("TRAILING 端到端:有利移动后 stop_price 被抬高", num(raised.stop_price) > stopBeforeTrail, `${stopBeforeTrail} → ${raised.stop_price}`);
  const trailPass = await eng5.riskPass({ quotes: { BTCUSDT: { symbol: "BTCUSDT", price: num(raised.stop_price) - 0.5, received_at: clockRef.t } } });
  const afterTrail = eng5.getPositions().find((p) => p.position_id === s4.position.position_id);
  check("TRAILING 端到端:回撤到抬高后的止损 → CLOSED(stop_loss)", afterTrail.status === "CLOSED" && trailPass.exits.some((e) => e.reason === "stop_loss"), JSON.stringify({ status: afterTrail.status, stop: raised.stop_price, exits: trailPass.exits }));

  console.log("== 5. PARTIAL CLOSE 之后的重算 ==");
  const eng6Store = await createHistoryStore({ memory: true });
  const eng6 = mkEngine(mkAdapter(eng6Store));
  await eng6.init();
  const s5 = await eng6.openPosition({
    mode: "short", symbol: "BTCUSDT", direction: "Bullish",
    signal_timestamp: clockRef.t, quote: { price: 100, received_at: clockRef.t },
    analysis: { direction: "Bullish", confidence: 70, volatility: { atrPct: 2 }, market_regime: { label: "Weak Uptrend" } },
    leverage: 2
  });
  const beforePartial = eng6.getPositions().find((p) => p.position_id === s5.position.position_id);
  const pRes = await eng6.closePosition(beforePartial, { reference_price: 100, exit_reason: "partial_test", fraction: 0.5 });
  const afterPartial = eng6.getPositions().find((p) => p.position_id === s5.position.position_id);
  near("PARTIAL:剩余数量 = 50%", afterPartial.remaining_quantity, num(beforePartial.remaining_quantity) * 0.5, 1e-9);
  near("PARTIAL:剩余保证金 = 50%", afterPartial.remaining_margin, num(beforePartial.remaining_margin) * 0.5, 1e-8);
  near("PARTIAL:锁定本金(entry_notional)= 50%", afterPartial.entry_notional, num(beforePartial.entry_notional) * 0.5, 1e-8);
  check("PARTIAL:部分平仓也带 action_source/exit_reason", pRes.trade && pRes.trade.action_source === "AUTO" && pRes.trade.exit_reason === "partial_test", JSON.stringify(pRes.trade && { a: pRes.trade.action_source, e: pRes.trade.exit_reason }));
  const halfPnl = unrealizedPnl(afterPartial, 110);
  near("PARTIAL:浮盈按剩余数量重算", halfPnl, round((110 - num(beforePartial.entry_price)) * num(afterPartial.remaining_quantity), 8), 1e-6);
  check("PARTIAL:剩余仓位仍满足账户不变量", eng6.accountIntegrity().ok, JSON.stringify(eng6.accountIntegrity()));
  check("PARTIAL:部分平仓不产生学习样本(只写成交)", eng6.getTrades().some((t) => t.partial === true) && !eng6.getTrades().some((t) => t.partial !== true), JSON.stringify(eng6.getTrades().map((t) => t.partial)));

  console.log("== 6. ACCOUNTING / 账户对账 / 加仓位路径 ==");
  const acct = eng6.getAccount();
  const wallets = eng6.engine.wallets;
  const positionsNow = eng6.getPositions();
  const reservedSum = positionsNow.filter((p) => p.status === "OPEN").reduce((a, p) => a + num(p.entry_notional), 0);
  near("ACCOUNTING:account.reserved 与持仓锁定本金对账一致", num(acct.reserved_balance), round(reservedSum, 8), 1e-8);
  const unrl = positionsNow.filter((p) => p.status === "OPEN").reduce((a, p) => a + num(p.unrealized_pnl), 0);
  near("ACCOUNTING:equity = cash + Σ锁定本金 + Σ浮盈", num(acct.total_equity), round(num(acct.cash_balance) + reservedSum + unrl, 8), 1e-6);
  check("ACCOUNTING:available / reserved 都不为负", num(wallets.short.available_balance) >= 0 && num(wallets.short.reserved_balance) >= 0, JSON.stringify(wallets.short));
  check("ACCOUNTING:accountIntegrity() 通过", eng6.accountIntegrity().ok, JSON.stringify(eng6.accountIntegrity()));
  const badIntegrity = accountIntegrityCheck(
    { cash_balance: -5, reserved_balance: 3, total_equity: -1, unrealized_pnl: NaN },
    { short: { available_balance: -1, reserved_balance: -2, allocated_balance: 0 } },
    [{ status: "OPEN", position_id: "x", entry_notional: 2, remaining_quantity: -1, remaining_margin: -1, unrealized_pnl: -99 }]
  );
  check("ACCOUNTING:不变量检查能抓出负数/NaN/偏离", badIntegrity.ok === false && badIntegrity.violations.length >= 5, JSON.stringify(badIntegrity.violations));
  // §28 加仓位:当前不存在加仓路径 —— 校验同 symbol 第二个仓位仍是独立仓位,且各字段自洽(不做隐式合并)
  const second = await eng6.openPosition({
    mode: "short", symbol: "BTCUSDT", direction: "Bullish",
    signal_timestamp: clockRef.t + 3600000, quote: { price: 100, received_at: clockRef.t },
    analysis: { direction: "Bullish", confidence: 70, volatility: { atrPct: 2 }, market_regime: { label: "Weak Uptrend" } },
    leverage: 2
  });
  const openNow = eng6.getPositions().filter((p) => p.status === "OPEN");
  check("ADD POSITION:无加仓路径(同 symbol 第二笔是独立仓位,不做隐式合并)", openNow.length === 2 && second.ok === true, JSON.stringify(openNow.map((p) => [p.position_id, p.initial_margin, p.notional])));
  check("ADD POSITION:每笔仓位 margin×leverage = notional", openNow.every((p) => Math.abs(num(p.initial_margin) * num(p.leverage) - num(p.notional)) < 1e-4), JSON.stringify(openNow.map((p) => p.notional)));
  check("ADD POSITION:每笔仓位强平价方向正确", openNow.every((p) => liquidationInvariant({ side: p.side, entryPrice: p.entry_price, liquidationPrice: p.liquidation_price }).ok));

  console.log("== 7. LEARNING SAMPLE 有效性 ==");
  // 完整平仓才会产生学习样本(部分平仓只写成交)
  const s6 = await eng6.openPosition({
    mode: "short", symbol: "ETHUSDT", direction: "Bearish",
    signal_timestamp: clockRef.t + 7200000, quote: { price: 2700, received_at: clockRef.t },
    analysis: { direction: "Bearish", confidence: 70, volatility: { atrPct: 2 }, market_regime: { label: "Weak Downtrend" } },
    leverage: 2
  });
  const p6 = eng6.getPositions().find((p) => p.position_id === s6.position.position_id);
  await eng6.closePosition(p6, { reference_price: 2680, exit_reason: "test_full_close", fraction: 1 });
  const samples = await eng6Store.generic.all("learning_samples");
  const anySample = samples[samples.length - 1];
  check("SAMPLE:正常平仓样本 invalid_sample=false", Boolean(anySample) && anySample.invalid_sample === false, JSON.stringify(anySample && { inv: anySample.invalid_sample, reason: anySample.invalid_reason }));
  check("SAMPLE:样本带 exit_reason 与 action_source(可审计)", Boolean(anySample) && anySample.exit_reason === "test_full_close" && anySample.action_source === "AUTO", JSON.stringify(anySample && { e: anySample.exit_reason, a: anySample.action_source }));

  // 完整性强制平仓(串价告警后)必须在样本上留痕,便于消费端过滤
  const s7 = await eng6.openPosition({
    mode: "short", symbol: "BTCUSDT", direction: "Bullish",
    signal_timestamp: clockRef.t + 10800000, quote: { price: 100, received_at: clockRef.t },
    analysis: { direction: "Bullish", confidence: 70, volatility: { atrPct: 2 }, market_regime: { label: "Weak Uptrend" } },
    leverage: 2
  });
  const p7 = eng6.getPositions().find((p) => p.position_id === s7.position.position_id);
  p7.price_status = "INVALID";
  await eng6.raiseIntegrity("price_symbol_mismatch", { test: true });
  await eng6.closePosition(p7, { reference_price: 100, exit_reason: "LIQUIDATION", fraction: 1, integrity_forced: true, repair_reason: "test_forced" });
  const forcedSample = (await eng6Store.generic.all("learning_samples")).find((s) => s.integrity_forced === true);
  check("SAMPLE:强制平仓样本带 integrity_forced + repair_reason", Boolean(forcedSample) && forcedSample.repair_reason === "test_forced", JSON.stringify(forcedSample && { f: forcedSample.integrity_forced, r: forcedSample.repair_reason }));
  check("SAMPLE:price_status=INVALID 的仓平仓后样本判为无效", Boolean(forcedSample) && forcedSample.invalid_sample === true && String(forcedSample.invalid_reason).includes("price_status_invalid"), JSON.stringify(forcedSample && { inv: forcedSample.invalid_sample, r: forcedSample.invalid_reason }));
  check("SAMPLE:所有样本都能被 invalid_sample 明确取值(消费端可过滤)", (await eng6Store.generic.all("learning_samples")).every((s) => s.invalid_sample === true || s.invalid_sample === false));

  console.log("== 8. INTEGRITY MIGRATION(脏数据修复) ==");
  const migStore = await createHistoryStore({ memory: true });
  const migAdapter = mkAdapter(migStore);
  const engA = mkEngine(migAdapter);
  await engA.init();
  // 复刻用户截图里的形态:BNB 做空 entry 764,却被写入了别的 symbol 的价(2712)
  const opened = await engA.openPosition({
    mode: "short", symbol: "BNBUSDT", direction: "Bearish",
    signal_timestamp: clockRef.t, quote: { price: 764, received_at: clockRef.t },
    analysis: { direction: "Bearish", confidence: 70, volatility: { atrPct: 1 }, market_regime: { label: "Weak Downtrend" } },
    leverage: 2
  });
  // 人为写入"用户截图"里的那类脏数据:串价 + 不可能亏损 + 巨大 mfe
  await migAdapter.put("paper_positions", {
    ...opened.position,
    current_price: 2712,
    unrealized_pnl: -22.94,
    mfe: 999,
    mae: 999
  });
  await migAdapter.put("paper_trades", {
    trade_id: "trd_dirty", account_id: "paper-main", mode: "long", symbol: "BNBUSDT", side: "LONG",
    quantity: 0.005, entry_price: 764, exit_price: 100, entry_time: 0, exit_time: 1, gross_pnl: -500,
    fees: 0.01, net_pnl: -22.94, exit_reason: "manual", created_at: 1
  });
  const engB = mkEngine(migAdapter);
  const migInit = await engB.init();
  check("MIGRATION:init 返回修复条目", Array.isArray(migInit.repairs) && migInit.repairs.length >= 2, JSON.stringify(migInit.repairs));
  const repairedPos = engB.getPositions().find((p) => p.symbol === "BNBUSDT");
  const repairedTrade = engB.getTrades().find((t) => t.trade_id === "trd_dirty");
  const posOk = !repairedPos || (repairedPos.status === "CLOSED" ? Boolean(repairedPos.repair_reason) : (num(repairedPos.mfe) === 0 && liquidationInvariant({ side: repairedPos.side, entryPrice: repairedPos.entry_price, liquidationPrice: repairedPos.liquidation_price }).ok));
  check("MIGRATION:脏持仓被修复或按规则平掉(带 repair_reason)", posOk, JSON.stringify(repairedPos && { s: repairedPos.status, mfe: repairedPos.mfe, liq: repairedPos.liquidation_price, r: repairedPos.repair_reason }));
  check("MIGRATION:不可能盈亏的成交被标为无效样本", Boolean(repairedTrade && repairedTrade.invalid_sample === true && repairedTrade.repair_reason), JSON.stringify(repairedTrade && { inv: repairedTrade.invalid_sample, r: repairedTrade.repair_reason }));
  check("MIGRATION:修复后账户不变量通过", engB.accountIntegrity().ok, JSON.stringify(engB.accountIntegrity()));
  const migSamples = await migAdapter.all("learning_samples");
  check("MIGRATION:迁移不产生新的无效样本", (migSamples || []).every((s) => s.invalid_sample !== true), JSON.stringify((migSamples || []).map((s) => s.invalid_sample)));

  console.log("== 9. UI 数据异常状态 ==");
  const badView = positionView({
    position_id: "p", symbol: "BNBUSDT", mode: "long", side: "SHORT", direction: "SHORT", status: "OPEN",
    entry_price: 764, current_price: 764, quantity: 0.005, initial_quantity: 0.005, remaining_quantity: 0.005,
    entry_notional: 4.5, remaining_margin: 4.5, notional: 9, leverage: 2, liquidation_price: 1142.47,
    unrealized_pnl: -22.94, price_status: "INVALID", price_source: "symbol_mismatch", entry_time: 0
  }, { now: 60000 });
  check("UI:行情异常时不显示巨大负数,改为提示重新校验", badView.data_error === true && badView.pnl_text.includes("行情异常"), JSON.stringify({ t: badView.pnl_text, e: badView.data_error }));
  const goodView = positionView({
    position_id: "p2", symbol: "BNBUSDT", mode: "long", side: "SHORT", direction: "SHORT", status: "OPEN",
    entry_price: 764, current_price: 756, quantity: 0.005, initial_quantity: 0.005, remaining_quantity: 0.005,
    entry_notional: 4.5, remaining_margin: 4.5, notional: 9, leverage: 2, liquidation_price: 1142.47,
    unrealized_pnl: 0.04, unrealized_net_pnl: 0.036, price_status: "OK", entry_time: 0
  }, { now: 60000 });
  check("UI:正常行情仍显示完整字段", goodView.pnl_text === "0.0400 USDT" || goodView.pnl_text.includes("0.04"), JSON.stringify(goodView.pnl_text));
  check("UI:ROE 与 价格变动两个口径都有", /%/.test(goodView.roe_text) && /%/.test(goodView.price_move_text), JSON.stringify({ roe: goodView.roe_text, move: goodView.price_move_text }));
  check("UI:净额(含预估平仓费)与费率分开显示", goodView.unrealized_net_text != null && goodView.exit_fee_estimate_text != null, JSON.stringify({ net: goodView.unrealized_net_text, fee: goodView.exit_fee_estimate_text }));
  check("UI:方向标签仍是做空", goodView.side === "做空", goodView.side);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
  console.log("FUTURES INTEGRITY OK");
}

await main();
