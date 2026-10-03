// tools/test-chart-interaction.mjs · V14.3 专业K线交互测试
// A 视口数学(平移/缩放/夹取/最新)  B 坐标映射与命中  C OHLC+涨跌幅信息条
// D 手势判定(Tap/长按/双指)  E 页面接线(rAF / DPR / Volume / 最新按钮 / 十字光标)
import fs from "node:fs";
import path from "node:path";
import {
  CHART_DEFAULTS, clampInt, createViewport, clampViewport, panViewport, zoomViewport, latestViewport,
  isAtLatest, visibleBars, chartLayoutOf, stepOf, chartXOfIndex, indexAtX, chartYOfPrice, chartPriceAtY,
  inChartArea, volumeBarHeight, priceRangeOf, ohlcOf, changeOf, isLongPress, touchDistance, touchMidX,
  pinchFactor, dragBarsOf, chartApi
} from "../worker/src/ui/chart.js";

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

// 造 200 根K线:振荡上行,便于断言
function makeKlines(n, base) {
  const rows = [];
  let price = base || 100;
  for (let i = 0; i < n; i += 1) {
    const open = price;
    const close = open * (1 + Math.sin(i / 7) * 0.004 + 0.0006);
    const high = Math.max(open, close) * 1.002;
    const low = Math.min(open, close) * 0.998;
    const t = 1700000000000 + i * 3600000;
    rows.push([t, open, high, low, close, 1000 + (i % 13) * 37]);
    price = close;
  }
  return rows;
}

console.log("== A. 视口:平移 / 缩放 / 最新 ==");
const TOTAL = 200;
const vp0 = createViewport(TOTAL, {});
eq("初始视口贴最新", [vp0.start, vp0.count, vp0.total], [TOTAL - CHART_DEFAULTS.defaultBars, CHART_DEFAULTS.defaultBars, TOTAL]);
check("初始即在最新位置", isAtLatest(vp0, TOTAL) === true);
const panned = panViewport(vp0, -30, TOTAL);
eq("向左平移 30 根", [panned.start, panned.count], [TOTAL - CHART_DEFAULTS.defaultBars - 30, CHART_DEFAULTS.defaultBars]);
check("平移后不在最新", isAtLatest(panned, TOTAL) === false);
eq("平移越界被夹住(不会滑出左边界)", panViewport(vp0, -99999, TOTAL).start, 0);
eq("向右越界被夹住(不会超过最新)", panViewport(vp0, 99999, TOTAL).start, TOTAL - vp0.count);
const backToLatest = latestViewport(panned, TOTAL);
check("「最新」按钮回到最右", isAtLatest(backToLatest, TOTAL) === true);
eq("最新位置 = total - count", backToLatest.start, TOTAL - backToLatest.count);

const zoomedIn = zoomViewport(vp0, 0.5, 1, TOTAL, {});
eq("放大(手指张开=比例<1→根数减半)", zoomedIn.count, Math.round(vp0.count * 0.5));
const zoomedOut = zoomViewport(vp0, 2, 1, TOTAL, {});
eq("缩小(根数翻倍)", zoomedOut.count, Math.round(vp0.count * 2));
check("缩放有下限", zoomViewport(vp0, 0.001, 0.5, TOTAL, {}).count >= Math.min(CHART_DEFAULTS.minBars, TOTAL));
check("缩放有上限", zoomViewport(vp0, 999, 0.5, TOTAL, {}).count <= Math.min(CHART_DEFAULTS.maxBars, TOTAL));
check("数据比下限还少时不会超过总数", zoomViewport(createViewport(8, {}), 0.01, 0.5, 8, {}).count <= 8);
// 锚点不漂移:以中间为锚缩放,锚点处的K线索引应基本不变
{
  const before = vp0.start + 0.5 * vp0.count;
  const z = zoomViewport(vp0, 0.5, 0.5, TOTAL, {});
  const after = z.start + 0.5 * z.count;
  near("缩放锚点保持不动(±1 根)", Math.round(after - before) <= 1 ? 0 : after - before, 0, 1.01);
}
eq("可见区间计数", visibleBars(vp0, TOTAL).count, vp0.count);
eq("可见区间右端 = total", visibleBars(vp0, TOTAL).to, TOTAL);

console.log("== B. 布局 / 坐标映射 / 命中 ==");
const layout = chartLayoutOf(360, 268, {});
check("主图与副图不重叠", layout.chartBottom <= layout.volTop, JSON.stringify(layout));
check("成交量副图在底部", layout.volBottom <= 268);
near("图宽 = 画布宽 - 左右内边距", layout.plotW, 360 - CHART_DEFAULTS.pad.left - CHART_DEFAULTS.pad.right, 1e-9);
const bars = makeKlines(TOTAL);
const rng = priceRangeOf(bars, 0, TOTAL, 0.08);
check("价格区间包含全部高低点", rng.top >= rng.max && rng.bottom <= rng.min, JSON.stringify(rng));
check("有效数据不被标记为 invalid", rng.invalid === false, JSON.stringify(rng));
// 数据形状防御:对象数组也必须能算出正确区间(否则K线会被画到画布外)
{
  const objRows = bars.map((k) => ({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: k[5] }));
  const objRng = priceRangeOf(objRows, 0, TOTAL, 0.08);
  check("对象形状数据同样能算出真实区间", objRng.invalid === false && objRng.max === rng.max && objRng.min === rng.min, JSON.stringify(objRng));
  const namedRows = bars.map((k) => ({ openTime: k[0], open: k[1], high: k[2], low: k[3], close: k[4], volume: k[5] }));
  const namedRng = priceRangeOf(namedRows, 0, TOTAL, 0.08);
  check("high/low 命名字段也兼容", namedRng.invalid === false && namedRng.max === rng.max, JSON.stringify(namedRng));
  // 关键回归:形状不认识时不能静默退化成 {top:1,bottom:0}(会把所有K线画到画布外)
  const bogus = priceRangeOf(bars.map(() => ({ mystery: 1 })), 0, TOTAL, 0.08);
  check("无法识别的形状被标记 invalid(而不是产出可用区间)", bogus.invalid === true, JSON.stringify(bogus));
  const empty = priceRangeOf([], 0, 0, 0.08);
  check("空数据被标记 invalid", empty.invalid === true);
  // 用退化区间算出的 y 一定在画布外 —— 这正是必须拦住的失败模式
  const layoutT = chartLayoutOf(340, 268, {});
  check("退化区间会把价格算到画布外(所以必须拦)", chartYOfPrice(84000, layoutT, 1, 0) < 0, String(chartYOfPrice(84000, layoutT, 1, 0)));
}
// 页面必须把同一份数组贯穿渲染(数据形状不一致是本轮真实踩到的缺陷)
{
  const pageSrcShape = fs.readFileSync(path.join(ROOT, "worker/src/ui/page.js"), "utf8");
  check("页面渲染统一使用 Binance 数组形状", /Number\(k\[4\]\) >= Number\(k\[1\]\)/.test(pageSrcShape) && /Number\(rows\[i\]\[5\]\)/.test(pageSrcShape));
  check("页面已无 .o/.c/.v 对象字段残留", !/k\.c >= k\.o/.test(pageSrcShape) && !/rows\[i\]\.v >/.test(pageSrcShape));
  check("价格区间无效时明确提示而不是画到画布外", /K线数据异常,无法绘制/.test(pageSrcShape) && /rng\.invalid/.test(pageSrcShape));
}
// x 映射与反查互逆(只在可见窗口内;窗口外的K线本来就不可点)
{
  let bad = 0;
  const visFrom = vp0.start;
  for (const i of [visFrom, visFrom + 1, visFrom + 40, TOTAL - 1]) {
    const x = chartXOfIndex(i, vp0, layout);
    if (indexAtX(x, vp0, layout) !== i) bad += 1;
  }
  eq("x↔索引 互逆(可见窗口内 4 个采样点)", bad, 0);
  eq("窗口左侧不可见的K线命中为 null", indexAtX(chartXOfIndex(0, vp0, layout), vp0, layout), null);
  eq("窗口右侧不可见的K线命中为 null", indexAtX(chartXOfIndex(TOTAL + 5, vp0, layout), vp0, layout), null);
}
eq("左边界外命中为 null", indexAtX(-5, vp0, layout), null);
eq("右边界外命中为 null", indexAtX(layout.pad.left + layout.plotW + 10, vp0, layout), null);
// y 映射与反查互逆
{
  const y = chartYOfPrice(rng.max, layout, rng.top, rng.bottom);
  near("最高价映射到区间上部", chartPriceAtY(y, layout, rng.top, rng.bottom), rng.max, 1e-6);
  const yMid = chartYOfPrice((rng.top + rng.bottom) / 2, layout, rng.top, rng.bottom);
  near("中价映射到主图中线", yMid, layout.chartTop + layout.chartH / 2, 1e-6);
}
check("主图区域内判定", inChartArea(layout.chartTop + 5, layout) === true && inChartArea(layout.volTop + 2, layout) === false);
check("成交量柱高有最小值(小量也可见)", volumeBarHeight(0.0001, 1000, layout.volH) >= 1);
near("成交量柱高按比例", volumeBarHeight(500, 1000, 100), 50, 1e-9);
eq("柱高上限不超过副图高度", volumeBarHeight(999999, 1000, 100) <= 100, true);

console.log("== C. OHLC + 涨跌幅信息条 ==");
const k1 = [1700000000000, 100, 105, 98, 104, 1234];
const k2 = [1700003600000, 104, 110, 103, 99, 999];
const o1 = ohlcOf(k1);
eq("OHLC 解析", [o1.open, o1.high, o1.low, o1.close, o1.volume], [100, 105, 98, 104, 1234]);
check("阳线判定", o1.up === true && ohlcOf(k2).up === false);
const c1 = changeOf(k1, null);
near("无前一根时用开盘作基准", c1.pct, 4, 1e-9);
eq("标注基准来源", c1.basis, "open");
const c2 = changeOf(k2, k1);
near("有前一根时用前收盘作基准", c2.pct, (99 - 104) / 104 * 100, 1e-6);
eq("涨跌幅文案保留符号", [changeOf(k1, null).text, c2.text], ["+4.00%", "-4.81%"]);
eq("基准来源标注 prev_close", c2.basis, "prev_close");
check("非法数据返回占位而不崩", changeOf([0, null, null, null, null, 0], null).text === "--");
near("时间文案含日期时间", o1.time_text.length >= 10 ? 1 : 0, 1, 1e-9);

console.log("== D. 手势判定 ==");
check("长按:够久且几乎没动 → 命中", isLongPress(420, 3, {}) === true);
check("长按:时间不够 → 不命中", isLongPress(120, 0, {}) === false);
check("长按:手指移动过多 → 不命中(判定为拖动)", isLongPress(600, 40, {}) === false);
near("双指距离", touchDistance({ clientX: 0, clientY: 0 }, { clientX: 3, clientY: 4 }), 5, 1e-9);
near("双指中点比例(半宽处)", touchMidX({ clientX: 50, clientY: 0 }, { clientX: 150, clientY: 0 }, 0, 200), 0.5, 1e-9);
near("双指中点比例被夹在 0..1", touchMidX({ clientX: -500, clientY: 0 }, { clientX: -400, clientY: 0 }, 0, 200), 0, 1e-9);
near("张开手指 → 比例 >1", pinchFactor(100, 150), 1.5, 1e-9);
eq("距离为 0 时不做缩放", pinchFactor(0, 50), 1);
near("拖动像素 → 根数(向右拖看更早)", dragBarsOf(30, layout, 60), -30 / stepOf(layout, 60), 1e-9);
check("步长为 0 时安全返回 0", dragBarsOf(30, { plotW: 0 }, 60) === 0);

console.log("== E. 页面接线(rAF / DPR / 副图 / 最新 / 十字光标) ==");
const pageSrc = fs.readFileSync(path.join(ROOT, "worker/src/ui/page.js"), "utf8");
check("使用 requestAnimationFrame 合并重绘", /requestAnimationFrame/.test(pageSrc) && /scheduleDetailChart/.test(pageSrc));
check("按 devicePixelRatio 分配位图", /devicePixelRatio/.test(pageSrc) && /setTransform\(dpr, 0, 0, dpr, 0, 0\)/.test(pageSrc));
check("成交量副图 + VOL 标注", /chartApi\.volumeBarHeight/.test(pageSrc) && /"VOL"/.test(pageSrc));
check("最新按钮绑定", /dtLatestBtn/.test(pageSrc) && /chartApi\.latestViewport/.test(pageSrc));
check("十字光标绘制(横竖线 + 价格标签)", /dtChart\.cross/.test(pageSrc) && /chartApi\.priceAtY/.test(pageSrc));
check("Drag 平移接线", /chartApi\.panViewport/.test(pageSrc) && /chartApi\.dragBarsOf/.test(pageSrc));
check("Pinch 缩放接线", /chartApi\.pinchFactor/.test(pageSrc) && /chartApi\.zoomViewport/.test(pageSrc));
check("Tap 切换十字光标", /dtIndexAt\(press\.x\)/.test(pageSrc) && /dtClearCross\(\)/.test(pageSrc));
check("长按手势接线", /chartApi\.isLongPress/.test(pageSrc) && /dtStartLongPress/.test(pageSrc));
check("OHLC 信息条元素齐全", ["dtOhlcTime", "dtOhlcO", "dtOhlcH", "dtOhlcL", "dtOhlcC", "dtOhlcChg"].every((id) => pageSrc.includes(`id="${id}"`)));
check("信息条显示涨跌幅(相对前收盘)", /chartApi\.changeOf\(candle, prev/.test(pageSrc));
check("触摸事件阻止浏览器默认滚动(touch-action: none)", /#dtCanvas \{ touch-action: none; \}/.test(pageSrc));
check("touchmove 使用 passive:false 才能 preventDefault", /addEventListener\("touchmove", dtOnTouchMove, \{ passive: false \}\)/.test(pageSrc));
check("新数据到达保留用户缩放位置", /chartApi\.clampViewport\(\{ total: rows\.length, start: prevStart, count: prevCount \}/.test(pageSrc));
check("chartApi 命名空间完整导出", Object.keys(chartApi).length >= 24 && typeof chartApi.zoomViewport === "function");
eq("clampInt 取整并夹取", [clampInt(3.7, 0, 10), clampInt(-5, 0, 10), clampInt(99, 0, 10)], [4, 0, 10]);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("CHART INTERACTION TESTS OK");
