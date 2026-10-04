// ui/chart.js · K线图控制器(V14.3)
// 纯计算:视口(平移/缩放)、坐标映射、命中测试、信息条文案。
// 不触碰 DOM —— 页面只负责把这里算出来的坐标画出来,便于 Node 直测与将来搬到 Flutter。
// 坐标约定:x 轴为"第几根K线",y 轴为价格;布局把画布切成 主图 / 副图(成交量) / 右侧价格轴。
import { num, round } from "../paper/accounting.js";

export const CHART_DEFAULTS = {
  minBars: 20,
  maxBars: 400,
  defaultBars: 90,
  longPressMs: 380,
  longPressMovePx: 10,
  minZoom: 0.5,
  maxZoom: 8,
  pad: { top: 14, right: 56, bottom: 22, left: 6 },
  volRatio: 0.18
};

function clampNum(value, lo, hi) {
  const v = num(value, lo);
  return v < lo ? lo : v > hi ? hi : v;
}

export function clampInt(value, lo, hi) {
  return Math.round(clampNum(value, lo, hi));
}

// ---- 视口:可见区间 [start, start+count) ----
export function createViewport(total, options) {
  const opts = { ...CHART_DEFAULTS, ...(options || {}) };
  const n = Math.max(0, Math.round(num(total, 0)));
  const count = Math.max(1, Math.min(n || 1, Math.round(num(opts.defaultBars, 90))));
  return { total: n, start: Math.max(0, n - count), count };
}

export function clampViewport(vp, total) {
  const n = Math.max(0, Math.round(num(total, vp && vp.total)));
  const maxCount = Math.max(1, Math.min(CHART_DEFAULTS.maxBars, Math.max(1, n)));
  const count = clampInt(vp && vp.count, Math.min(CHART_DEFAULTS.minBars, maxCount), maxCount);
  const maxStart = Math.max(0, n - count);
  return { total: n, start: clampInt(vp && vp.start, 0, maxStart), count };
}

// 平移:deltaBars > 0 向未来(右)看。夹在数据边界内,不会滑出屏幕外。
export function panViewport(vp, deltaBars, total) {
  const base = clampViewport(vp, total);
  return clampViewport({ ...base, start: base.start + Math.round(num(deltaBars, 0)) }, total);
}

// 缩放:anchorRatio 为手指/光标在可视宽度上的比例(0=最左,1=最右),该位置的K线缩放前后保持不动。
export function zoomViewport(vp, factor, anchorRatio, total, options) {
  const opts = { ...CHART_DEFAULTS, ...(options || {}) };
  const base = clampViewport(vp, total);
  if (base.total <= 1) return base;
  const ratio = clampNum(anchorRatio, 0, 1);
  const anchor = base.start + ratio * base.count;
  const n = base.total;
  const minCount = Math.max(1, Math.min(num(opts.minBars, 20), n));
  const maxCount = Math.max(minCount, Math.min(num(opts.maxBars, 400), n));
  const count = clampInt(base.count * num(factor, 1), minCount, maxCount);
  const start = Math.round(anchor - ratio * count);
  return clampViewport({ total: n, start, count }, n);
}

// 最新:跳到最右端(实时行情)
export function latestViewport(vp, total) {
  const base = clampViewport(vp, total);
  return clampViewport({ ...base, start: base.total - base.count }, base.total);
}

export function isAtLatest(vp, total) {
  const base = clampViewport(vp, total);
  return base.start >= base.total - base.count;
}

export function visibleBars(vp, total) {
  const base = clampViewport(vp, total);
  const from = Math.max(0, base.start);
  const to = Math.min(base.total, base.start + base.count);
  return { from, to, count: Math.max(0, to - from) };
}

// ---- 布局:主图 / 成交量副图 分栏 ----
export function chartLayoutOf(width, height, options) {
  const opts = { ...CHART_DEFAULTS, ...(options || {}) };
  const w = Math.max(120, num(width, 320));
  const h = Math.max(120, num(height, 240));
  const pad = opts.pad;
  const plotW = Math.max(40, w - pad.left - pad.right);
  const plotH = Math.max(40, h - pad.top - pad.bottom);
  const volH = Math.round(plotH * clampNum(opts.volRatio, 0.08, 0.4));
  const gap = 4;
  const chartH = Math.max(20, plotH - volH - gap);
  return {
    width: w, height: h, pad, plotW, plotH, gap,
    chartH, volH,
    chartTop: pad.top,
    chartBottom: pad.top + chartH,
    volTop: pad.top + chartH + gap,
    volBottom: pad.top + chartH + gap + volH
  };
}

export function stepOf(layout, count) {
  const n = Math.max(1, Math.round(num(count, 1)));
  return layout.plotW / n;
}

export function chartXOfIndex(index, vp, layout) {
  const base = clampViewport(vp, vp && vp.total);
  const step = stepOf(layout, base.count);
  return layout.pad.left + (num(index, 0) - base.start + 0.5) * step;
}

export function indexAtX(x, vp, layout) {
  const total = num(vp && vp.total, 0);
  if (total <= 0) return null;
  const base = clampViewport(vp, total);
  const step = stepOf(layout, base.count);
  const rel = num(x, 0) - layout.pad.left;
  if (rel < 0 || rel > layout.plotW) return null;
  const idx = base.start + Math.floor(rel / step);
  if (idx < 0 || idx >= total) return null;
  return idx;
}

// 价格 → y / y → 价格(主图)
export function chartYOfPrice(price, layout, top, bottom) {
  const range = num(top, 0) - num(bottom, 0) || 1;
  return layout.chartTop + (num(top, 0) - num(price, 0)) / range * layout.chartH;
}

export function chartPriceAtY(y, layout, top, bottom) {
  const range = num(top, 0) - num(bottom, 0) || 1;
  const rel = (num(y, 0) - layout.chartTop) / Math.max(1, layout.chartH);
  return num(top, 0) - rel * range;
}

export function inChartArea(y, layout) {
  return num(y, 0) >= layout.chartTop && num(y, 0) <= layout.chartBottom;
}

// 成交量副图柱高(最小 1px,保证小量也能看见;上限不越过副图高度)
export function volumeBarHeight(volume, maxVolume, volH) {
  const max = num(maxVolume, 0);
  const h = num(volH, 0);
  if (!(max > 0) || !(h > 0)) return 1;
  return Math.max(1, Math.min(h, num(volume, 0) / max * h));
}

// 读一根K线的高/低:同时兼容 Binance 原始数组形状 [t,o,h,l,c,v] 与对象形状 {high,low}
function highOf(candle) {
  if (Array.isArray(candle)) return Number(candle[2]);
  return Number(candle && (candle.high != null ? candle.high : candle.h));
}

function lowOf(candle) {
  if (Array.isArray(candle)) return Number(candle[3]);
  return Number(candle && (candle.low != null ? candle.low : candle.l));
}

// 可见区间价格范围(含 8% 留白,防止贴边)
export function priceRangeOf(candles, from, to, padRatio) {
  const rows = (candles || []).slice(Math.max(0, from), Math.max(0, to));
  if (!rows.length) return { top: 1, bottom: 0, max: 1, min: 0, range: 1, invalid: true };
  let max = -Infinity;
  let min = Infinity;
  for (const k of rows) {
    const h = highOf(k);
    const l = lowOf(k);
    if (Number.isFinite(h) && h > max) max = h;
    if (Number.isFinite(l) && l < min) min = l;
  }
  // 一根有效K线都没有 → 明确退化并标记 invalid,调用方据此跳过绘制(不要把K线画到画布外)
  if (!Number.isFinite(max) || !Number.isFinite(min) || max <= 0) {
    return { top: 1, bottom: 0, max: 1, min: 0, range: 1, invalid: true };
  }
  if (max === min) { max += Math.abs(max) * 0.001 || 0.5; min -= Math.abs(min) * 0.001 || 0.5; }
  const pad = (max - min) * clampNum(padRatio == null ? 0.08 : padRatio, 0, 0.5);
  const top = max + pad;
  const bottom = Math.max(0, min - pad);
  return { top, bottom, max, min, range: top - bottom || 1, invalid: false };
}

// ---- 信息条:OHLC + 涨跌幅(相对上一根收盘,真实涨跌幅) ----
export function ohlcOf(candle) {
  if (!candle) return null;
  const open = num(candle[1], NaN);
  const high = num(candle[2], NaN);
  const low = num(candle[3], NaN);
  const close = num(candle[4], NaN);
  if (![open, high, low, close].every((v) => Number.isFinite(v))) return null;
  const openTime = num(candle[0], null);
  return {
    open_time: openTime,
    open, high, low, close,
    volume: num(candle[5], 0),
    up: close >= open,
    time_text: openTime == null ? "--" : new Date(openTime).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
  };
}

// 涨跌幅:有上一根收盘 → 收盘对收盘;否则退回 收-开(并标注 basis)
// pct 保留精度供逻辑使用,text 才做两位小数展示
export function changeOf(candle, prevCandle) {
  const cur = ohlcOf(candle);
  if (!cur) return { text: "--", pct: null, basis: "none", up: null };
  const prev = ohlcOf(prevCandle);
  const base = prev && prev.close > 0 ? prev.close : cur.open;
  const basis = prev && prev.close > 0 ? "prev_close" : "open";
  if (!(base > 0)) return { text: "--", pct: null, basis: "none", up: null };
  const raw = (cur.close - base) / base * 100;
  const pct = round(raw, 6);
  return { text: (raw > 0 ? "+" : "") + raw.toFixed(2) + "%", pct, basis, up: pct >= 0 };
}

// 长按判定(十字光标):按住够久且手指基本没动
export function isLongPress(durationMs, movedPx, options) {
  const opts = { ...CHART_DEFAULTS, ...(options || {}) };
  return num(durationMs, 0) >= num(opts.longPressMs, 380) && num(movedPx, 0) <= num(opts.longPressMovePx, 10);
}

// 双指手势:距离 → 缩放比例,中点 → 缩放锚点
export function touchDistance(a, b) {
  if (!a || !b) return 0;
  const dx = num(a.clientX, num(a.x, 0)) - num(b.clientX, num(b.x, 0));
  const dy = num(a.clientY, num(a.y, 0)) - num(b.clientY, num(b.y, 0));
  return Math.sqrt(dx * dx + dy * dy);
}

export function touchMidX(a, b, rectLeft, rectWidth) {
  if (!a || !b) return 0.5;
  const mid = (num(a.clientX, num(a.x, 0)) + num(b.clientX, num(b.x, 0))) / 2;
  const left = num(rectLeft, 0);
  const w = num(rectWidth, 0);
  if (!(w > 0)) return 0.5;
  return clampNum((mid - left) / w, 0, 1);
}

// 双指距离变化 → 视口缩放系数,语义与 zoomViewport 一致:返回的是"可见K线根数倍数"。
//   - 手指张开(next > prev) = 用户想放大 = 根数变少 → 返回 < 1;
//   - 手指捏合(next < prev) = 用户想缩小 = 根数变多 → 返回 > 1。
// 历史缺陷:本函数曾返回 next/prev(张开>1),而页面把返回值直接喂给 zoomViewport 的
// "根数倍数"(count *= factor),组合后方向正好相反 —— 单元测试分别断言两半都过,
// 组合却没有测试。现在的组合由 test-chart-interaction.mjs 的 F 节直接锁死。
export function pinchFactor(prevDistance, nextDistance) {
  const p = num(prevDistance, 0);
  const n = num(nextDistance, 0);
  if (!(p > 0) || !(n > 0)) return 1;
  return clampNum(p / n, 0.2, 5);
}

// 像素位移 → 平移多少根K线(拖动时手指往右挪 = 看更早的数据)
export function dragBarsOf(deltaPx, layout, count) {
  const step = stepOf(layout, count);
  if (!(step > 0)) return 0;
  return -num(deltaPx, 0) / step;
}

// 浏览器侧统一出口:收敛成一个命名空间,避免与页面脚本/其它模块在扁平 bundle 作用域里重名
export const chartApi = {
  CHART_DEFAULTS,
  clampInt,
  createViewport,
  clampViewport,
  panViewport,
  zoomViewport,
  latestViewport,
  isAtLatest,
  visibleBars,
  layoutOf: chartLayoutOf,
  stepOf,
  xOfIndex: chartXOfIndex,
  indexAtX,
  yOfPrice: chartYOfPrice,
  priceAtY: chartPriceAtY,
  inChartArea,
  volumeBarHeight,
  priceRangeOf,
  ohlcOf,
  changeOf,
  isLongPress,
  touchDistance,
  touchMidX,
  pinchFactor,
  dragBarsOf
};
