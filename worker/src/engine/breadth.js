// engine/breadth.js · 市场广度(Market Breadth)
// 由 tools/migrate-split.mjs 从 V9 单文件拆分而来;逻辑未改动

function breadthFromTickers(tickers) {
  const top = (tickers || [])
    .filter((t) => String(t.symbol || "").endsWith("USDT") && !String(t.symbol).includes("_"))
    .sort((a, b) => Number(b.quoteVolume || 0) - Number(a.quoteVolume || 0))
    .slice(0, 100);
  if (!top.length) return null;
  const up = top.filter((t) => Number(t.priceChangePercent || 0) > 0).length;
  return { up_pct: Math.round(up / top.length * 100), sample: top.length };
}

// ---- K线状态保护:只允许已收盘K线进入判断 ----

export { breadthFromTickers };
