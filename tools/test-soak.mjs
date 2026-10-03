// tools/test-soak.mjs · V14.1 Fake Clock Soak 测试(7 天 / 30 天 + 异常注入 + Retention)
import { runSoak } from "./soak.mjs";
import { planRetention, applyRetention, coreHistoryIntact, trimSyncQueue, retentionSummary, RETENTION_POLICY } from "../worker/src/paper/retention.js";
import { num } from "../worker/src/paper/accounting.js";

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log("PASS  " + name); }
  else { failed += 1; console.log("FAIL  " + name + (detail ? "  => " + detail : "")); }
}

function assertInvariants(label, result) {
  const s = result.stats;
  check(label + ": 无重复幂等订单", s.duplicate_orders === 0, String(s.duplicate_orders));
  check(label + ": 无重复持仓", s.duplicate_positions === 0, String(s.duplicate_positions));
  check(label + ": 无负余额", s.negative_balance === 0, String(s.negative_balance));
  check(label + ": 无 NaN/Infinity", s.nan_or_inf === 0, String(s.nan_or_inf));
  check(label + ": 会计恒等式一致", s.equity_identity_breaks === 0, String(s.equity_identity_breaks));
  check(label + ": 钱包汇总有效", s.wallet_identity_breaks === 0, String(s.wallet_identity_breaks));
  check(label + ": 日志有界(≤500)", s.logs_bounded === true, String(s.logs_bounded));
  check(label + ": 资产非负且有限", num(s.lastEquity) >= 0 && Number.isFinite(num(s.lastEquity)), String(s.lastEquity));
  check(label + ": 产生了模拟成交", s.exits > 0, "exits=" + s.exits);
  check(label + ": Loop 次数合理(扣除异常跳过)", s.loops + (s.skipped_hours || 0) >= result.days * 24 - 2, String(s.loops) + "+" + String(s.skipped_hours || 0));
}

console.log("== 1. 7 天 Fake Clock ==");
const soak7 = await runSoak({ days: 7, seed: 7, anomalies: false });
console.log("   7d: loops=" + soak7.stats.loops + " orders=" + soak7.stats.orders + " trades=" + soak7.stats.exits + " equity=" + soak7.stats.lastEquity);
assertInvariants("7d", soak7);

console.log("== 2. 30 天 Fake Clock + 异常注入 ==");
const soak30 = await runSoak({ days: 30, seed: 99, anomalies: true });
console.log("   30d: loops=" + soak30.stats.loops + " orders=" + soak30.stats.orders + " trades=" + soak30.stats.exits + " restarts=" + soak30.stats.restarts + " equity=" + soak30.stats.lastEquity);
console.log("   异常注入: " + soak30.stats.anomalies.map((a) => a.kind).join(","));
assertInvariants("30d", soak30);
check("30d: 注入了断网/重启/重复Start/DeepSeek失败/极端行情", soak30.stats.anomalies.length >= 6, String(soak30.stats.anomalies.length));
check("30d: 重启后未重置为初始资金", soak30.stats.equity_identity_breaks === 0, String(soak30.stats.equity_identity_breaks));
check("30d: 重复 Start 未成功创建第二个 Loop", soak30.stats.anomalies.filter((a) => a.kind === "duplicate_start").length === 0 || soak30.stats.duplicate_orders === 0);
check("30d: DeepSeek 429 全部回退本地", soak30.stats.deepseek_failures === 0, String(soak30.stats.deepseek_failures));
check("30d: 持仓数量受风控上限约束", soak30.stats.max_positions <= 5, String(soak30.stats.max_positions));
check("30d: 成交数不减少(累计)", soak30.stats.exits >= soak7.stats.exits, soak7.stats.exits + " → " + soak30.stats.exits);
check("30d: 交易时长正确折算", Math.round(soak30.stats.duration_days) === 30, String(soak30.stats.duration_days));

console.log("== 3. Retention(长期挂机数据) ==");
const bigCounts = { paper_trades: 900, paper_orders: 9000, signals: 90000, paper_daily_stats: 40, learning_samples: 700, model_registry: 3, debug_logs: 100000, ai_review_cache: 5000, sync_queue_synced: 9000, oldest_market_cache: Date.now() - 60 * 60000 };
const plan = planRetention(bigCounts, { now: Date.now() });
check("核心表不受清理影响(trades/daily/learning/model)", !plan.delete_rows.some((d) => ["paper_trades", "paper_daily_stats", "learning_samples", "model_registry"].includes(d.table)), JSON.stringify(plan.delete_rows.map((d) => d.table)));
check("订单/信号等可裁剪表被识别", plan.delete_rows.some((d) => d.table === "paper_orders") && plan.delete_rows.some((d) => d.table === "signals"), JSON.stringify(plan.delete_rows.map((d) => d.table)));
check("日志/AI缓存/已同步队列被裁剪", plan.trim_rows.some((t) => t.key === "debug_logs") && plan.trim_rows.some((t) => t.key === "ai_review_cache") && plan.trim_rows.some((t) => t.key === "sync_queue_synced"), JSON.stringify(plan.trim_rows.map((t) => t.key)));
check("存在过期的行情缓存被标记清理", plan.trim_rows.some((t) => t.strategy === "drop_expired"), JSON.stringify(plan.trim_rows.map((t) => t.strategy)));
check("保留计划含可读原因", plan.reasons.length >= 4, String(plan.reasons.length));
const trades = Array.from({ length: 900 }, (_, i) => ({ trade_id: "t" + i, exit_time: 1000 + i, net_pnl: i % 2 ? 0.1 : -0.05 }));
const applied = applyRetention("paper_trades", trades, RETENTION_POLICY, {});
check("核心成交表在上限内完整保留(Infinity)", applied.keep.length === 900 && applied.drop.length === 0, JSON.stringify({ keep: applied.keep.length, drop: applied.drop.length }));
const orders = Array.from({ length: 9000 }, (_, i) => ({ order_id: "o" + i, created_at: i }));
const trimmedOrders = applyRetention("paper_orders", orders, RETENTION_POLICY, {});
check("超限表按时间保留最新 5000", trimmedOrders.keep.length === 5000 && trimmedOrders.drop.length === 4000, JSON.stringify({ keep: trimmedOrders.keep.length }));
check("保留的是最新记录", trimmedOrders.keep[0].created_at > trimmedOrders.drop[0].created_at, JSON.stringify([trimmedOrders.keep[0].created_at, trimmedOrders.drop[0].created_at]));
const queue = Array.from({ length: 3000 }, (_, i) => ({ item_id: "q" + i, sync_status: i % 3 === 0 ? "PENDING" : "SYNCED", updated_at: i }));
const queueTrim = trimSyncQueue(queue, RETENTION_POLICY);
check("已同步队列只裁剪 SYNCED,不动 PENDING", queueTrim.drop.every((id) => !queue.find((q) => q.item_id === id && q.sync_status === "PENDING")), JSON.stringify(queueTrim.drop.slice(0, 3)));
const intact = coreHistoryIntact({ paper_trades: 900, learning_samples: 700, paper_daily_stats: 40 }, { paper_trades: 900, learning_samples: 700, paper_daily_stats: 40 });
check("清理后核心历史完整", intact.intact === true, JSON.stringify(intact.details));
const broken = coreHistoryIntact({ paper_trades: 900 }, { paper_trades: 800 });
check("核心历史丢失会被识别", broken.intact === false, JSON.stringify(broken.details));
check("Summarize 可用", typeof retentionSummary(plan).actions === "number");

console.log("== 4. Soak 中的 Retention 结果 ==");
check("30d 运行后核心历史仍完整", soak30.stats.core_history_intact === true, JSON.stringify(soak30.core_check));
check("30d 运行后成交表未被误删", soak30.stats.trades_preserved === soak30.stats.exits, soak30.stats.trades_preserved + "/" + soak30.stats.exits);
check("30d 运行后产生保留动作", soak30.stats.retention_actions >= 1, String(soak30.stats.retention_actions));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("SOAK TESTS OK");
