// paper/factors.js · V16 §9 因子工厂(纯函数,无 I/O)
// 目的:把"因子"从一句口号变成可审计的统计量。任何因子进入权重前,必须先被历史样本回答三件事:
//       有没有预测力(IC)、方向稳不稳(stability)、最近是不是失效了(decay)。
// 原则:失效的因子先衰减权重、进影子观察区,绝不因一次坏数据就被删除(避免"抖动式"增删);
//       样本不足时按比例降权,而不是假装它有和全样本一样可信的结论。
export const FACTOR_FACTORY_VERSION = "factor-factory-v1.0";

// 因子分组:UI 与审计都按组展示,避免"一堆因子糊在一起"看不出逻辑
export const FACTOR_GROUPS = {
  price_trend: "价格趋势",
  volatility: "波动",
  volume_price: "量价",
  derivative: "衍生品",
  market_context: "市场环境",
  cost: "成本",
  position: "持仓",
  data_quality: "数据可靠"
};

// 因子注册表:每项必须说清"为什么这个因子可能有预测力"(why),否则不许进池子
export const FACTOR_REGISTRY = [
  { key: "returns", zh: "区间收益率", group: "price_trend", why: "最直接的动量来源:近期涨跌本身对短期方向有惯性" },
  { key: "momentum", zh: "动量强度", group: "price_trend", why: "用累计收益与波动之比衡量趋势惯性,比裸收益更抗噪" },
  { key: "distance_to_ma", zh: "均线偏离度", group: "price_trend", why: "价格离均线越远,回归压力与趋势确认同时增强" },
  { key: "trend_slope", zh: "趋势斜率", group: "price_trend", why: "对均线做线性拟合取斜率,刻画趋势的方向与陡峭程度" },
  { key: "breakout_strength", zh: "突破强度", group: "price_trend", why: "突破区间高点/低点的幅度,衡量趋势启动的力度" },
  { key: "atr", zh: "真实波幅 ATR", group: "volatility", why: "绝对波动水平决定止损距离与仓位上限" },
  { key: "realized_volatility", zh: "已实现波动率", group: "volatility", why: "滚动收益标准差,判断当前是否处于高波动环境" },
  { key: "volatility_change", zh: "波动率变化", group: "volatility", why: "波动突然放大常先于行情转向" },
  { key: "wick_ratio", zh: "影线比例", group: "volatility", why: "上下影线占比反映多空争夺与假突破" },
  { key: "volume_change", zh: "成交量变化", group: "volume_price", why: "放量才让价格变化有说服力,缩量突破不可信" },
  { key: "volume_trend", zh: "量能趋势", group: "volume_price", why: "持续放量的趋势比单根异常放量更可靠" },
  { key: "volume_breakout", zh: "放量突破", group: "volume_price", why: "突破伴随异常放量时成功率显著更高" },
  { key: "taker_imbalance", zh: "主动买卖失衡", group: "volume_price", why: "主动成交方向体现即时买卖压力" },
  { key: "funding", zh: "资金费率", group: "derivative", why: "费率极端说明多空一侧拥挤,存在反转风险" },
  { key: "funding_change", zh: "资金费率变化", group: "derivative", why: "费率斜率变化比绝对值更早预警情绪转向" },
  { key: "open_interest", zh: "持仓量", group: "derivative", why: "持仓规模反映资金参与度与合约热度" },
  { key: "oi_change", zh: "持仓量变化", group: "derivative", why: "价涨仓增为真趋势,价涨仓减多为逼空" },
  { key: "long_short_ratio", zh: "多空持仓比", group: "derivative", why: "散户多空比极端时往往与后续行情反向" },
  { key: "btc_context", zh: "BTC 大盘环境", group: "market_context", why: "山寨方向高度依赖 BTC 走势,不能孤立看个币" },
  { key: "market_breadth", zh: "市场宽度", group: "market_context", why: "上涨/下跌家数比衡量行情广度,宽度不够难持续" },
  { key: "regime", zh: "市场状态", group: "market_context", why: "趋势/震荡切换决定了策略适配度" },
  { key: "correlation", zh: "与大市相关性", group: "market_context", why: "与大盘相关性高时独立信息量下降,易被同步拖累" },
  { key: "spread", zh: "买卖价差", group: "cost", why: "点差直接构成即时交易成本,吃掉高频边际" },
  { key: "estimated_slippage", zh: "预估滑点", group: "cost", why: "按深度与名义估算的冲击成本,决定可开规模" },
  { key: "fee_drag", zh: "手续费拖累", group: "cost", why: "双边手续费占预期收益比例,占比过高则不值得做" },
  { key: "mfe", zh: "最大有利偏移", group: "position", why: "持仓期间最大浮盈,衡量止盈是否吃满行情" },
  { key: "mae", zh: "最大不利偏移", group: "position", why: "最大浮亏决定是否会被止损扫出" },
  { key: "holding_time", zh: "持仓时长", group: "position", why: "时间维度影响资金效率与资金费累积" },
  { key: "profit_giveback", zh: "利润回吐", group: "position", why: "从浮盈高点回撤的比例,衡量离场纪律" },
  { key: "freshness", zh: "数据新鲜度", group: "data_quality", why: "过期行情不能作为决策依据" },
  { key: "missing_rate", zh: "数据缺失率", group: "data_quality", why: "缺失过高说明特征本身不可信" },
  { key: "provider_conflict", zh: "上游冲突", group: "data_quality", why: "多源不一致时该样本的数据不可靠" }
];

export const FACTOR_MIN_SAMPLES = 30;      // 低于此样本数的因子按比例降权
export const FACTOR_DEDUPE_CORR = 0.95;    // 20 周期动量与 21 周期动量几乎重复,不要都留
export const FACTOR_DECAY_RATIO = 0.5;     // 近段 |IC| 不足全样本一半 → 视为衰减
export const FACTOR_DECAY_STREAK = 3;      // 连续衰减次数阈值
export const FACTOR_DECAY_FACTOR = 0.5;    // 每次触发衰减时权重乘数
const FACTOR_IC_EPS = 1e-9;                // |IC| 低于此视为"无信息",不参与衰减比

// ---- 私有数学工具(本模块自带,不 import 其它模块) ----
// 只认真正的有限数;null / "" / NaN / Infinity 一律 null,避免静默变 0 造成假数据
function factorNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function factorFiniteNum(v) {
  return factorNum(v) != null;
}
function factorMean(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  let s = 0;
  for (const v of arr) {
    if (!Number.isFinite(v)) return null;
    s += v;
  }
  return s / arr.length;
}
// Pearson 相关:样本不足或任一维零方差 → null(无定义,不返回 0 冒充)
function factorPearson(xs, ys) {
  const n = Math.min(Array.isArray(xs) ? xs.length : 0, Array.isArray(ys) ? ys.length : 0);
  if (n < 2) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i += 1) {
    if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) return null;
    sx += xs[i]; sy += ys[i];
  }
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (!(sxx > 0) || !(syy > 0)) return null;
  const r = sxy / Math.sqrt(sxx * syy);
  if (!Number.isFinite(r)) return null;
  return Math.max(-1, Math.min(1, r));
}
// 按时间顺序(样本数组原顺序)等分 3 段;样本太少时后面的段可能为空
function factorSplit3(list) {
  const n = list.length;
  const a = Math.floor(n / 3);
  const b = Math.floor((2 * n) / 3);
  return [list.slice(0, a), list.slice(a, b), list.slice(b, n)];
}
// 样本里实际出现过的因子 key(保持首次出现顺序)
function factorObservedKeys(samples) {
  const seen = [];
  const set = new Set();
  for (const s of (Array.isArray(samples) ? samples : [])) {
    if (!s || typeof s !== "object" || !s.features || typeof s.features !== "object") continue;
    for (const k of Object.keys(s.features)) {
      if (factorNum(s.features[k]) == null) continue;
      if (!set.has(k)) { set.add(k); seen.push(k); }
    }
  }
  return seen;
}
// ranking 项是否"近期衰减":显式 decayed 优先,否则用 decay 与阈值比较
function factorItemDecayed(item, ratio) {
  if (!item || typeof item !== "object") return false;
  if (item.decayed === true) return true;
  const d = factorNum(item.decay);
  return d != null ? d < ratio : false;
}

// 注册表视图:把内部 key 翻成中文,给 UI 直接渲染
export function factorRegistryView(keys) {
  const wanted = Array.isArray(keys) ? new Set(keys) : null;
  const out = [];
  for (const f of FACTOR_REGISTRY) {
    if (wanted && !wanted.has(f.key)) continue;
    out.push({ key: f.key, zh: f.zh, group_zh: FACTOR_GROUPS[f.group] || f.group, why: f.why });
  }
  return out;
}

// 单因子有效性:IC / 命中率 / 分方向收益 / 稳定性 / 衰减
export function efficacyOf(samples, factorKey, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const list = Array.isArray(samples) ? samples : [];
  const pairs = [];
  for (const s of list) {
    if (!s || typeof s !== "object") continue;
    const fv = factorNum(s.features ? s.features[factorKey] : undefined);
    const rv = factorNum(s.forward_return_pct);
    if (fv == null || rv == null) continue;
    const dir = s.direction === "SHORT" ? "SHORT" : (s.direction === "LONG" ? "LONG" : null);
    pairs.push({ f: fv, r: rv, direction: dir });
  }
  const sample_count = pairs.length;
  const fArr = pairs.map((p) => p.f);
  const rArr = pairs.map((p) => p.r);
  const ic = factorPearson(fArr, rArr);

  // 命中率:因子相对均值的方向与收益相对均值的方向是否一致(等价于 IC 的符号一致率)
  const fm = factorMean(fArr);
  const rm = factorMean(rArr);
  let hits = 0, hitBase = 0;
  if (fm != null && rm != null) {
    for (const p of pairs) {
      const fd = Math.sign(p.f - fm);
      const rd = Math.sign(p.r - rm);
      if (fd === 0 || rd === 0) continue;
      hitBase += 1;
      if (fd === rd) hits += 1;
    }
  }
  const hit_rate = hitBase > 0 ? hits / hitBase : null;

  const longArr = pairs.filter((p) => p.direction === "LONG").map((p) => p.r);
  const shortArr = pairs.filter((p) => p.direction === "SHORT").map((p) => p.r);
  const long_perf = longArr.length ? factorMean(longArr) : null;
  const short_perf = shortArr.length ? factorMean(shortArr) : null;

  // 稳定性:切 3 段,各段 IC 同号程度;可计算段数 < 2 时无法判断 → null
  const seg = factorSplit3(pairs);
  const segIc = seg.map((g) => factorPearson(g.map((p) => p.f), g.map((p) => p.r)));
  const validSeg = segIc.filter((v) => v != null);
  const stability = validSeg.length >= 2
    ? Math.abs(validSeg.reduce((a, v) => a + Math.sign(v), 0)) / validSeg.length
    : null;

  // 衰减:最近 1/3 段 |IC| / 全样本 |IC|;全样本近乎无信息时该比值无意义 → null
  const lastIc = segIc[2];
  let decay = null;
  if (lastIc != null && ic != null && Math.abs(ic) > FACTOR_IC_EPS) {
    decay = Math.abs(lastIc) / Math.abs(ic);
  }
  const decayed = decay != null && decay < FACTOR_DECAY_RATIO;
  const active = o.active === false ? false : true;
  const weight = ic != null && stability != null ? Math.abs(ic) * stability : 0;

  return {
    factor: factorKey,
    sample_count,
    ic,
    hit_rate,
    long_perf,
    short_perf,
    stability,
    decay,
    decayed,
    active,
    weight
  };
}

// 因子排名:综合分 = |IC| × 稳定性 × 样本因子(样本越少越打折)
export function rankFactors(samples, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const minSamples = factorFiniteNum(o.minSamples) && Number(o.minSamples) > 0 ? Number(o.minSamples) : FACTOR_MIN_SAMPLES;
  const keys = Array.isArray(o.keys) ? o.keys.slice() : factorObservedKeys(samples);
  const rows = keys.map((k) => {
    const e = efficacyOf(samples, k, o);
    const sample_factor = Math.min(1, e.sample_count / minSamples);
    const score = e.ic != null && e.stability != null
      ? Math.abs(e.ic) * e.stability * sample_factor
      : 0;
    return { factor: k, ic: e.ic, stability: e.stability, sample_count: e.sample_count, sample_factor, score };
  });
  // 同分时按因子名稳定排序,保证结果可复现(不能依赖 sort 的不稳定实现)
  rows.sort((a, b) => (b.score - a.score) || (a.factor < b.factor ? -1 : a.factor > b.factor ? 1 : 0));
  return rows;
}

// 两个因子的相关性;样本不足或零方差 → null
export function factorCorrelation(samples, keyA, keyB) {
  const list = Array.isArray(samples) ? samples : [];
  const xs = [], ys = [];
  for (const s of list) {
    if (!s || typeof s !== "object" || !s.features) continue;
    const a = factorNum(s.features[keyA]);
    const b = factorNum(s.features[keyB]);
    if (a == null || b == null) continue;
    xs.push(a); ys.push(b);
  }
  return factorPearson(xs, ys);
}

// 因子去重:相关性过高的因子只保留一个,避免"同一件事投多票"
export function dedupeFactors(samples, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const thr = factorFiniteNum(o.threshold) && Number(o.threshold) > 0 ? Number(o.threshold) : FACTOR_DEDUPE_CORR;
  const base = Array.isArray(o.keys) ? o.keys.slice() : factorObservedKeys(samples);
  let order = base.slice();
  if (Array.isArray(o.ranking)) {
    // 有排名时优先保留得分高的那个(而不是碰巧先出现的那个)
    const rank = new Map();
    o.ranking.forEach((r, i) => { if (r && r.factor != null) rank.set(r.factor, i); });
    order.sort((a, b) => (rank.has(a) ? rank.get(a) : 1e9) - (rank.has(b) ? rank.get(b) : 1e9));
  }
  const keep = [];
  const dropped = [];
  for (const k of order) {
    let dupOf = null;
    let dupCorr = null;
    for (const kept of keep) {
      const c = factorCorrelation(samples, k, kept);
      if (c != null && Math.abs(c) >= thr) { dupOf = kept; dupCorr = c; break; }
    }
    if (dupOf) dropped.push({ key: k, duplicate_of: dupOf, corr: dupCorr });
    else keep.push(k);
  }
  return { keep, dropped, threshold: thr };
}

// 因子漂移:连续衰减到阈值 → 权重乘性衰减 + 进影子观察(停用但不删除);恢复后可回 active
export function applyFactorDrift(states, ranking, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const streakNeed = factorFiniteNum(o.streak) && Number(o.streak) > 0 ? Number(o.streak) : FACTOR_DECAY_STREAK;
  const shrink = factorFiniteNum(o.factor) ? Number(o.factor) : FACTOR_DECAY_FACTOR;
  const decayRatio = factorFiniteNum(o.decayRatio) ? Number(o.decayRatio) : FACTOR_DECAY_RATIO;
  const now = factorNum(o.now);
  const byKey = new Map();
  for (const r of (Array.isArray(ranking) ? ranking : [])) {
    if (!r || typeof r !== "object") continue;
    const k = typeof r.key === "string" ? r.key : (typeof r.factor === "string" ? r.factor : null);
    if (k) byKey.set(k, r);
  }
  const src = states && typeof states === "object" ? states : {};
  const next = {};
  for (const key of Object.keys(src)) {
    const st = src[key] && typeof src[key] === "object" ? src[key] : {};
    const weight = factorNum(st.weight) != null ? Number(st.weight) : 1;
    const prevStreak = factorNum(st.decay_streak) != null ? Number(st.decay_streak) : 0;
    const item = byKey.get(key);
    const isDecayed = item ? factorItemDecayed(item, decayRatio) : false;

    let streak = isDecayed ? prevStreak + 1 : 0;
    let nextWeight = weight;
    let active = st.active !== false;
    let shadowSince = st.shadow_since == null ? null : st.shadow_since;
    let decayed = st.decayed === true;

    if (isDecayed) {
      // 只在"刚好跨过阈值整数倍"时扣一次权重,避免第 4、5 次连砍导致权重雪崩
      if (streak >= streakNeed && streak % streakNeed === 0) nextWeight = weight * shrink;
      if (streak >= streakNeed) {
        active = false;                 // 进影子观察:停用,但条目仍在 states 里(不删除)
        if (shadowSince == null) shadowSince = now;
        decayed = true;
      } else {
        decayed = false;                // 还没到阈值,只累计计数
      }
    } else if (shadowSince != null) {
      // 恢复:回到 active;权重不自动回补(避免反复抖动导致权重坐过山车)
      active = true;
      shadowSince = null;
      decayed = false;
    } else {
      decayed = false;
    }

    next[key] = Object.assign({}, st, {
      weight: nextWeight,
      active,
      decayed,
      shadow_since: shadowSince,
      decay_streak: streak
    });
  }
  return next;
}

// 初始状态:所有因子等权、active、未衰减
export function createFactorStates(registry) {
  const out = {};
  for (const item of (Array.isArray(registry) ? registry : [])) {
    const key = typeof item === "string" ? item : (item && item.key);
    if (!key) continue;
    out[key] = { weight: 1, active: true, decayed: false, shadow_since: null, decay_streak: 0 };
  }
  return out;
}

// 因子中心中文视图
export function factorCenterView(states, ranking) {
  const reg = new Map(FACTOR_REGISTRY.map((f) => [f.key, f]));
  const stat = new Map();
  for (const r of (Array.isArray(ranking) ? ranking : [])) {
    if (!r || typeof r !== "object") continue;
    const k = r.factor != null ? r.factor : r.key;
    if (k != null) stat.set(k, r);
  }
  const src = states && typeof states === "object" ? states : {};
  const rows = [];
  let active_count = 0;
  let shadow_count = 0;
  for (const key of Object.keys(src)) {
    const st = src[key] && typeof src[key] === "object" ? src[key] : {};
    const e = stat.get(key) || {};
    const active = st.active !== false;
    const decayed = st.decayed === true;
    if (active) active_count += 1; else shadow_count += 1;
    rows.push({
      key,
      zh: reg.has(key) ? reg.get(key).zh : key,
      active,
      weight: factorNum(st.weight) != null ? Number(st.weight) : 0,
      ic: factorNum(e.ic),
      stability: factorNum(e.stability),
      long_perf: factorNum(e.long_perf),
      short_perf: factorNum(e.short_perf),
      decayed,
      decayed_zh: decayed ? "近期衰减" : "表现正常"
    });
  }
  return { active_count, shadow_count, rows };
}
