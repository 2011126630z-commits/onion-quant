// engine/constants.js · 引擎版本与周期常量
// 由 tools/migrate-split.mjs 从 V9 单文件拆分而来;逻辑未改动

const ENGINE_VERSION = "rule-v0.1";
const TF_LIST = ["1m", "5m", "15m", "1h", "4h", "1d"];
const TF_WEIGHTS = { "1m": 0.45, "5m": 0.8, "15m": 1.2, "1h": 1.5, "4h": 1.2, "1d": 1.0 };
const INTERVAL_MS = { "1m": 6e4, "3m": 18e4, "5m": 3e5, "15m": 9e5, "30m": 18e5, "1h": 36e5, "2h": 72e5, "4h": 144e5, "6h": 216e5, "12h": 432e5, "1d": 864e5 };
const DIR_ZH = { "Strong Bullish": "强看涨", "Bullish": "看涨", "Neutral": "中性", "Bearish": "看跌", "Strong Bearish": "强看跌" };

// ---- MarketDataProvider:内存缓存,避免重复下载同一段K线 ----

export { ENGINE_VERSION, TF_LIST, TF_WEIGHTS, INTERVAL_MS, DIR_ZH };
