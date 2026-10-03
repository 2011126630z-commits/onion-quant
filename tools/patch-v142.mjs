// tools/patch-v142.mjs · V14.2:100USDT账户 / Paper Futures(杠杆·保证金·强平·部分平仓) / 收盘K幂等 / 循环防重入
import fs from "node:fs";

function patch(rel, pairs) {
  const file = new URL("../" + rel, import.meta.url);
  let text = fs.readFileSync(file, "utf8");
  let hit = 0;
  for (const [from, to] of pairs) {
    if (!text.includes(from)) { console.log("  MISS: " + String(from).slice(0, 70).replace(/\n/g, "⏎")); continue; }
    text = text.split(from).join(to);
    hit += 1;
  }
  fs.writeFileSync(file, text, "utf8");
  console.log(rel + " → " + hit + "/" + pairs.length);
}

// 1) 账户默认 100 USDT
patch("worker/src/paper/accounting.js", [
  ["  initial_balance: 10,", "  initial_balance: 100,"]
]);

// 2) applyOpen 支持保证金(杠杆):借记 margin 而非 notional
patch("worker/src/paper/accounting.js", [
  [`  const notional = round(price * num(order.quantity), 8);
  const fee = feeOf(notional, cfg);`,
   `  const notional = round(price * num(order.quantity), 8);
  // 杠杆仓位借记保证金;无杠杆时 margin == notional(与 V14 行为一致)
  const debit = order.margin == null ? notional : round(num(order.margin), 8);
  const fee = feeOf(order.fee_base == null ? notional : num(order.fee_base), cfg);`],
  [`  const afford = canAfford(wallet, notional, fee);`, `  const afford = canAfford(wallet, debit, fee);`],
  [`      cash_balance: round(num(state.account.cash_balance) - notional - fee, 8),`,
   `      cash_balance: round(num(state.account.cash_balance) - debit - fee, 8),`],
  [`        available_balance: round(num(wallet.available_balance) - notional - fee, 8),
        reserved_balance: round(num(wallet.reserved_balance) + notional, 8),`,
   `        available_balance: round(num(wallet.available_balance) - debit - fee, 8),
        reserved_balance: round(num(wallet.reserved_balance) + debit, 8),`],
  [`    entry_price: price,
    entry_notional: notional,`, `    entry_price: price,
    entry_notional: debit,`]
]);

// 3) 引擎:引入 futures + 杠杆/保证金/强平/部分平仓 + 收盘K幂等 + 循环防重入
patch("worker/src/paper/engine.js", [
  [`import { PAPER_DEFAULTS, createAccount, portfolio, applyOpen, applyClose, updatePositionPath, evaluateExit, summarizeTrades, positionSize, num, round, isSafeAmount, canAfford, dayKeyOf, fillPrice, feeOf } from "./accounting.js";`,
   `import { PAPER_DEFAULTS, createAccount, portfolio, applyOpen, applyClose, updatePositionPath, evaluateExit, summarizeTrades, positionSize, num, round, isSafeAmount, canAfford, dayKeyOf, fillPrice, feeOf } from "./accounting.js";
import { clampLeverage, openFuturesPosition, closeFuturesPosition, isLiquidated, liquidationPriceOf, buildTakeProfitPlan, updateTrailingStop, applyBreakEven, futuresUnrealized, marginHealth } from "./futures.js";
import { requestLeverage, approveLeverage, shadowEvaluation, LEVERAGE_POLICY } from "./leverageManager.js";`],
  // 幂等键使用收盘K线时间(禁止 Date.now())
  [`export function idempotencyKey(mode, symbol, signalTimestamp, direction) {
  return [mode, symbol, signalTimestamp, direction].join("|");
}`,
   `export function idempotencyKey(mode, symbol, closedCandleTime, direction, strategyVersion) {
  // 严格使用【已收盘K线时间】,禁止用 Date.now() 作为信号标识
  return [mode, symbol, closedCandleTime, direction, strategyVersion || "rule-v0.1"].join("|");
}

// 收盘K线时间(向下取整到周期边界后减 1ms = 上一根K线收盘时刻)
export function closedCandleTime(nowMs, intervalMs) {
  const iv = num(intervalMs, 3600000);
  return Math.floor(num(nowMs, Date.now()) / iv) * iv - 1;
}`]
]);

// 4) 引擎 loop 防重入
patch("worker/src/paper/engine.js", [
  [`  async function loop(input) {
    if (engine.state.state !== "RUNNING") return { ok: false, state: engine.state.state };`,
   `  async function loop(input) {
    if (engine.state.state !== "RUNNING") return { ok: false, state: engine.state.state };
    if (engine.loopRunning) return { ok: false, reason: "loop_reentry_blocked", skipped: true }; // 上一轮未结束 → 跳过
    engine.loopRunning = true;
    try {
      return await loopInner(input);
    } finally {
      engine.loopRunning = false;
    }
  }

  async function loopInner(input) {`],
  [`    engine.state.loops += 1;`, `    engine.state.loops = num(engine.state.loops, 0) + 1;`]
]);
fs.writeFileSync(new URL("../worker/src/paper/engine.js", import.meta.url), fs.readFileSync(new URL("../worker/src/paper/engine.js", import.meta.url), "utf8"), "utf8");
console.log("done");
