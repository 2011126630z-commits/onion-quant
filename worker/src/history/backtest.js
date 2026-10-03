// history/backtest.js · 历史回测(在历史K线上重放引擎,严格防 Look-Ahead Bias)
// 关键约束:
//   1) 在时点 t 生成信号时,只喂入 closeTime <= t 的K线(与实盘 splitClosed 完全一致)
//   2) 结果解析只使用 t 之后【已收盘】的K线(见 history/outcome.js)
//   3) 不注入 24h ticker / 市场广度等"当下才有"的实时字段,避免回测偷看未来
import { computeAnalysis } from "../engine/signal.js";
import { signalRecordFromAnalysis, backtestSignalId } from "./record.js";
import { resolveSignalOutcomes } from "./outcome.js";

// 二分:取 closeTime <= limit 的前缀(模拟当时可见的数据)
export function sliceUpTo(rows, closeTimeLimit) {
  if (!rows || !rows.length) return [];
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].closeTime <= closeTimeLimit) lo = mid + 1;
    else hi = mid;
  }
  return rows.slice(0, lo);
}

// 回测计划:决定要取哪些周期、多少根K线
export function makeBacktestPlan(input) {
  const interval = input.interval || "1h";
  const bars = Number(input.bars) || 1000;
  const intervals = { "1m": 60000, "5m": 300000, "15m": 900000, "30m": 1800000, "1h": 3600000, "4h": 14400000, "1d": 86400000 };
  const ivMs = intervals[interval] || 3600000;
  return {
    interval,
    bars,
    spanMs: bars * ivMs,
    timeframes: ["1h", "4h", "1d"],
    need: [
      { key: "sym", tf: interval, limit: bars },
      { key: "sym", tf: "4h", limit: Math.min(1500, Math.ceil((bars * ivMs) / 14400000) + 60) },
      { key: "sym", tf: "1d", limit: Math.min(1000, Math.ceil((bars * ivMs) / 86400000) + 30) },
      { key: "btc", tf: interval, limit: bars },
      { key: "btc", tf: "4h", limit: Math.min(1500, Math.ceil((bars * ivMs) / 14400000) + 60) },
      { key: "btc", tf: "1d", limit: Math.min(1000, Math.ceil((bars * ivMs) / 86400000) + 30) }
    ]
  };
}

// 单币回测:重放引擎生成历史信号(异步:每 25 根K线让出事件循环,移动端不卡界面)
export async function replaySymbol(input) {
  const symbol = input.symbol;
  const interval = input.interval || "1h";
  const tfRows = input.tfRows || {};
  const btcRows = input.btcRows || {};
  const step = Math.max(1, Number(input.step) || 1);
  const minHistory = Number(input.minHistory) || 60;
  const maxSignals = Number(input.maxSignals) || 4000;
  const nowMs = Number(input.nowMs) || Date.now();
  const onProgress = input.onProgress;

  const mainRows = tfRows[interval] || [];
  const signals = [];
  let scanned = 0;
  let skipped = 0;

  for (let i = 0; i < mainRows.length; i += step) {
    const anchor = mainRows[i];
    if (!anchor || !isFinite(anchor.closeTime)) continue;
    if (anchor.closeTime > nowMs - 300) continue; // 只看已收盘K线
    const tfSlice = {};
    let enough = true;
    for (const tf of Object.keys(tfRows)) {
      const sliced = sliceUpTo(tfRows[tf], anchor.closeTime);
      if (tf === interval && sliced.length < minHistory) { enough = false; break; }
      if (sliced.length) tfSlice[tf] = sliced;
    }
    if (!enough) { skipped += 1; continue; }

    const btcSlice = {};
    for (const tf of Object.keys(btcRows)) {
      const sliced = sliceUpTo(btcRows[tf], anchor.closeTime);
      if (sliced.length) btcSlice[tf] = sliced;
    }

    scanned += 1;
    let analysis = null;
    try {
      analysis = computeAnalysis({
        symbol,
        interval,
        ticker: {},              // 回测不注入实时 ticker(避免使用当时不可得的数据)
        tfRows: tfSlice,
        btcRows: btcSlice,
        tickers: [],             // 同上:不使用市场广度等当下数据
        nowMs: anchor.closeTime + 300
      });
    } catch (error) {
      skipped += 1;
      continue;
    }

    const rec = signalRecordFromAnalysis(analysis, {
      source: "backtest",
      timestampMs: anchor.closeTime,
      id: backtestSignalId(symbol, interval, anchor.closeTime)
    });
    signals.push(rec);
    if (onProgress && scanned % 25 === 0) await onProgress({ scanned, total: Math.ceil(mainRows.length / step), signals: signals.length });
    if (signals.length >= maxSignals) break;
  }

  if (onProgress) await onProgress({ scanned, total: Math.ceil(mainRows.length / step), signals: signals.length, done: true });
  return { signals, scanned, skipped };
}

// 为一批信号附加结果(seriesByHorizon: 每个验证周期使用的最细可用K线)
export function attachOutcomes(signals, seriesByHorizon, nowMs, k) {
  const out = [];
  for (const signal of signals) {
    const outcome = resolveSignalOutcomes({ signal, seriesByHorizon, nowMs, k });
    out.push({ signal, outcome: outcome.resolved_count ? outcome : null });
  }
  return out;
}

// 由多周期K线构建每个 horizon 的解析序列
// klines: { "1m": rows, "15m": rows, "1h": rows, "4h": rows } —— 只取存在的
export function pickSeriesByHorizon(klines) {
  const pick = (names) => {
    for (const n of names) if (klines[n] && klines[n].length) return klines[n];
    return null;
  };
  return {
    "5m": pick(["1m", "5m", "15m"]),
    "15m": pick(["1m", "5m", "15m"]),
    "1h": pick(["1h", "15m", "5m"]),
    "4h": pick(["1h", "4h"]),
    "24h": pick(["1h", "4h"])
  };
}
