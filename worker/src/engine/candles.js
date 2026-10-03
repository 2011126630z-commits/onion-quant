// engine/candles.js · K线状态保护(只允许已收盘K线进入判断)
// 由 tools/migrate-split.mjs 从 V9 单文件拆分而来;逻辑未改动

import { INTERVAL_MS } from "./constants.js";

function splitClosed(rows, nowMs) {
  const now = nowMs || Date.now();
  let cut = rows.length;
  while (cut > 0 && rows[cut - 1].closeTime > now - 300) cut -= 1;
  return { closed: rows.slice(0, cut), forming: rows.slice(cut) };
}

// ---- SignalEngine:纯函数,输入全部数据,输出结构化结论 ----

// 已收盘K线的最后收盘时间(用于 Outcome 追踪的对齐锚点,防 Look-Ahead)
function lastClosedCloseTime(rows, nowMs) {
  const cut = splitClosed(rows, nowMs).closed;
  return cut.length ? cut[cut.length - 1].closeTime : null;
}

export { splitClosed, lastClosedCloseTime };
