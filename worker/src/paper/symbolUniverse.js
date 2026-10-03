// paper/symbolUniverse.js · V16 §15 动态币种池(纯函数,无 I/O)
// 为什么要"动态"而不是写死几十个币:
//   1) 山寨币流动性天天变,写死的池子会把已经"没有深度/价差巨大"的币继续当成可交易标的;
//   2) 新上币(K线还没预热够)最容易被"指标好看"骗进模型,必须单独一个 WARMING_UP 状态挡在门外;
//   3) 但——持仓币永远不能被"优化掉":一旦某个币已经开仓,把它踢出池子就等于无人看管仓位。
// 分层原则:先轻量扫 20~50 个(只算流动性与基础门槛),再筛 5~10 个跑完整模型(见 selectActiveSymbols)。
// 本模块只做"分类与打分",不下单、不读网络、不写存储。
export const UNIVERSE_VERSION = "symbol-universe-v1.0";

// 币种池分层:CORE(核心) / CANDIDATE(候选) / WATCH(观察)
export const UNIVERSE_TIERS = ["CORE", "CANDIDATE", "WATCH"];
export const UNIVERSE_TIER_ZH = {
  CORE: "核心",
  CANDIDATE: "候选",
  WATCH: "观察"
};

// 币种状态:ACTIVE(可交易) / OBSERVE_ONLY(只看不做) / WARMING_UP(预热中) / SUSPENDED(暂停)
export const SYMBOL_STATES = ["ACTIVE", "OBSERVE_ONLY", "WARMING_UP", "SUSPENDED"];
export const SYMBOL_STATE_ZH = {
  ACTIVE: "可交易",
  OBSERVE_ONLY: "仅观察(硬门槛未过)",
  WARMING_UP: "预热中(新币,K线不足)",
  SUSPENDED: "暂停(数据异常)"
};

// 硬门槛:山寨币必须比核心币更严格;任一流动性门槛不过 → OBSERVE_ONLY
export const UNIVERSE_GATES = {
  min_quote_volume_usdt: 5000000, // 24h 成交额 < 500 万 USDT → 进出困难
  max_spread_bps: 8,              // 价差 > 8bps → 手续费之外还要吃价差
  min_depth_usdt: 100000,         // 盘口深度 < 10 万 USDT → 滑点不可控
  max_abnormal_jump_pct: 15,      // 24h 涨跌幅 > ±15% → 疑似插针/币价错乱
  min_candles_warmup: 200,        // 预热 K 线根数:太少时指标全是噪声
  min_listing_age_days: 30,       // 上市 < 30 天 → 历史样本不可信
  min_price_usdt: 0.0000001       // 价格下限(1e-7),过滤归零/脏数据
};

// 核心币:即使某些流动性指标略差,也永远是 CORE(它们是"始终在池子里"的基准资产)
export const CORE_SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"];

const UNIVERSE_EPS = 1e-12;

function universeNum(v, fallback) {
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  return fallback === undefined ? 0 : fallback;
}

function universeClamp(v, lo, hi) {
  const n = universeNum(v, lo);
  return Math.min(hi, Math.max(lo, n));
}

function universeUpper(v) {
  return String(v == null ? "" : v).toUpperCase();
}

function universeRound(v, digits) {
  const d = digits == null ? 4 : digits;
  const p = Math.pow(10, d);
  return Math.round(universeNum(v) * p) / p;
}

function universeFmtNum(v) {
  return String(universeRound(v, 4));
}

// 大额 USDT 用 M/B 缩写,避免 UI 出现一长串数字
function universeFmtUsdt(v) {
  const n = universeNum(v);
  if (Math.abs(n) >= 1e9) return universeRound(n / 1e9, 2) + "B";
  if (Math.abs(n) >= 1e6) return universeRound(n / 1e6, 2) + "M";
  if (Math.abs(n) >= 1e3) return universeRound(n / 1e3, 2) + "K";
  return String(universeRound(n, 2));
}

function universeGate(key, pass, valueZh, needZh) {
  const ok = pass === true;
  return { key: key, pass: ok, zh: (ok ? "通过 · " : "未过 · ") + valueZh + "(" + needZh + ")" };
}

// 综合分 0~100:流动性(成交额)、价差、深度、波动适中性四个维度加权。
// 注意:这是"跑完整模型值不值得"的排序依据,不是收益预测;核心币不因低分被降级。
export function universeScore(metrics) {
  const m = metrics || {};
  const quoteVolume = universeNum(m.quote_volume_usdt);
  const spreadBps = universeNum(m.spread_bps);
  const depthUsdt = universeNum(m.depth_usdt);
  const changePct = Math.abs(universeNum(m.change_pct_24h));

  // 成交额(对数):10 万 → 0,10 亿 → 1
  const volumeScore = universeClamp((Math.log10(Math.max(quoteVolume, 1)) - 5) / 4, 0, 1);
  // 价差:0bps → 1,16bps → 0;缺数据给 0.5(不奖不罚,而不是当 0 价差)
  const spreadScore = m.spread_bps == null ? 0.5 : universeClamp(1 - spreadBps / 16, 0, 1);
  // 深度(对数):1 万 → 0,1000 万 → 1
  const depthScore = universeClamp((Math.log10(Math.max(depthUsdt, 1)) - 4) / 3, 0, 1);
  // 波动适中:约 5% 最优 —— 太小说明没有行情,太大说明风险高
  const volaScore = changePct <= 5
    ? universeClamp(changePct / 5, 0, 1)
    : universeClamp(1 - (changePct - 5) / 25, 0, 1);

  const raw = 0.35 * volumeScore + 0.25 * spreadScore + 0.25 * depthScore + 0.15 * volaScore;
  return Math.round(universeClamp(raw, 0, 1) * 100);
}

// 单币评估:返回 tier / state / score / 逐条门槛 / 中文原因(全部可解释)
export function evaluateSymbol(metrics, opts) {
  const m = metrics || {};
  const o = opts || {};
  const cfg = { ...UNIVERSE_GATES, ...(o.gates || {}) };
  const coreList = (o.core_symbols || CORE_SYMBOLS).map(universeUpper);
  const symbol = universeUpper(m.symbol);
  const isCore = coreList.includes(symbol);
  const held = o.held === true;

  const quoteVolume = universeNum(m.quote_volume_usdt);
  const spreadBps = universeNum(m.spread_bps);
  const depthUsdt = universeNum(m.depth_usdt);
  const changePct = universeNum(m.change_pct_24h);
  const candlesSeen = universeNum(m.candles_seen);
  const listingAge = m.listing_age_days == null ? null : universeNum(m.listing_age_days);
  const price = m.price == null ? null : universeNum(m.price);
  const conflict = m.provider_conflict === true;

  const gates = [
    universeGate("min_quote_volume_usdt",
      quoteVolume >= cfg.min_quote_volume_usdt,
      "24h 成交额 " + universeFmtUsdt(quoteVolume) + " USDT",
      "要求 ≥ " + universeFmtUsdt(cfg.min_quote_volume_usdt) + " USDT"),
    universeGate("max_spread_bps",
      spreadBps <= cfg.max_spread_bps,
      "盘口价差 " + universeFmtNum(spreadBps) + " bps",
      "要求 ≤ " + cfg.max_spread_bps + " bps"),
    universeGate("min_depth_usdt",
      depthUsdt >= cfg.min_depth_usdt,
      "盘口深度 " + universeFmtUsdt(depthUsdt) + " USDT",
      "要求 ≥ " + universeFmtUsdt(cfg.min_depth_usdt) + " USDT"),
    // 上市天数/价格"未知"时不据此否决(不拿缺失数据当坏数据),只在已知且越界时拦
    universeGate("min_listing_age_days",
      listingAge == null ? true : listingAge >= cfg.min_listing_age_days,
      listingAge == null ? "上市天数未知(不据此否决)" : "已上市 " + universeFmtNum(listingAge) + " 天",
      "要求 ≥ " + cfg.min_listing_age_days + " 天"),
    universeGate("min_price_usdt",
      price == null ? true : price >= cfg.min_price_usdt,
      price == null ? "价格未知(不据此否决)" : "价格 " + price + " USDT",
      "要求 ≥ " + cfg.min_price_usdt + " USDT"),
    universeGate("min_candles_warmup",
      candlesSeen >= cfg.min_candles_warmup,
      "已见 K 线 " + candlesSeen + " 根",
      "预热需 ≥ " + cfg.min_candles_warmup + " 根"),
    universeGate("max_abnormal_jump_pct",
      Math.abs(changePct) <= cfg.max_abnormal_jump_pct,
      "24h 涨跌幅 " + universeFmtNum(changePct) + "%",
      "异常阈值 ±" + cfg.max_abnormal_jump_pct + "%")
  ];

  // 门槛分两类:
  //   流动性/质量类(成交额、价差、深度、价格)→ 不过 = OBSERVE_ONLY
  //   时间类(K线预热根数、上市天数)→ 不过 = WARMING_UP(都是"新币"的同一种病)
  const WARMUP_GATE_KEYS = ["min_candles_warmup", "min_listing_age_days"];
  const liquidityFail = gates.filter((g) => WARMUP_GATE_KEYS.indexOf(g.key) < 0 && !g.pass);
  const warmupFail = gates.filter((g) => WARMUP_GATE_KEYS.indexOf(g.key) >= 0 && !g.pass);
  const reasons = [];

  let state;
  if (conflict) {
    state = "SUSPENDED";
    reasons.push("多源行情冲突(provider_conflict):数据不可信,暂停该币种");
  } else if (Math.abs(changePct) > cfg.max_abnormal_jump_pct) {
    state = "SUSPENDED";
    reasons.push("24h 涨跌幅 " + universeFmtNum(changePct) + "% 超过 ±" + cfg.max_abnormal_jump_pct + "%,疑似插针/币价错乱");
  } else if (liquidityFail.length && !isCore) {
    // 山寨币必须更严格:任一流动性硬门槛不过 → 只看不做
    state = "OBSERVE_ONLY";
    for (const g of liquidityFail) reasons.push("山寨币硬门槛未过:" + g.zh);
  } else if (warmupFail.length) {
    // 新币不准马上开仓:预热期 / 上市初期指标几乎没有统计意义
    state = "WARMING_UP";
    for (const g of warmupFail) reasons.push("预热中:" + g.zh);
    reasons.push("已见 " + candlesSeen + "/" + cfg.min_candles_warmup + " 根 K 线,新币不准马上开仓");
  } else {
    state = "ACTIVE";
    reasons.push("全部门槛通过,可进入完整模型评估");
  }

  if (isCore) {
    reasons.unshift("核心币:始终保留在池内(流动性硬门槛豁免,数据类问题不豁免)");
    for (const g of liquidityFail) reasons.push("核心币流动性提示(不降级):" + g.zh);
  }
  if (held) reasons.push("持仓中:不会被踢出池子");

  // tier 表达"是否值得占用完整模型算力";state 表达"现在能不能交易"
  let tier;
  if (isCore) tier = "CORE";
  else if (state === "ACTIVE") tier = "CANDIDATE";
  else tier = "WATCH";

  return {
    symbol: symbol,
    tier: tier,
    state: state,
    score: universeScore(m),
    gates: gates,
    reasons_zh: reasons,
    held: held,
    is_core: isCore
  };
}

// 预热进度:新币"看得见但还不能开仓"的可视化
export function warmingUpStatus(symbol, candlesSeen, opts) {
  const o = opts || {};
  const cfg = { ...UNIVERSE_GATES, ...(o.gates || {}) };
  const seen = Math.max(0, Math.floor(universeNum(candlesSeen)));
  const need = Math.max(1, Math.floor(universeNum(cfg.min_candles_warmup)));
  const ready = seen >= need;
  return {
    symbol: universeUpper(symbol),
    state: ready ? "ACTIVE" : "WARMING_UP",
    seen: seen,
    need: need,
    progress_pct: Math.min(100, Math.round(seen / need * 100)),
    ready: ready,
    zh: ready ? ("预热完成(已见 " + seen + " 根)") : ("预热中 " + seen + "/" + need + " 根")
  };
}

// tickers 允许是数组,也允许是 { SYMBOL: metrics } 字典
function universeTickerList(tickers) {
  if (Array.isArray(tickers)) return tickers;
  if (tickers && typeof tickers === "object") {
    return Object.keys(tickers).map((key) => {
      const v = tickers[key];
      if (v && typeof v === "object") {
        const row = { ...v };
        if (!row.symbol) row.symbol = key;
        return row;
      }
      return { symbol: key };
    });
  }
  return [];
}

// 组装币种池:按 tier 与 state 双重分组;持仓币永不缺席
export function buildUniverse(input) {
  const src = input || {};
  const o = src.opts || {};
  const coreList = (o.core_symbols || CORE_SYMBOLS).map(universeUpper);
  const heldList = (src.holding || []).map(universeUpper).filter(Boolean);
  const heldSet = new Set(heldList);

  const entries = [];
  const seen = new Set();
  for (const t of universeTickerList(src.tickers)) {
    const m = t || {};
    const symbol = universeUpper(m.symbol);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    const held = heldSet.has(symbol);
    const ev = evaluateSymbol(m, { ...o, held: held });
    // 持仓币:不允许被降到 WATCH —— 至少要留在候选层被持续跟踪
    if (held && ev.tier !== "CORE" && ev.tier !== "CANDIDATE") {
      ev.tier = "CANDIDATE";
      ev.reasons_zh.push("持仓中:不允许被踢出池子,至少保留在候选层");
    }
    if (held) ev.held = true;
    entries.push(ev);
  }

  // 持仓但本轮拿不到行情的币:补占位(不伪造流动性数字,只声明"持仓+无数据")
  for (const symbol of heldList) {
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    entries.push({
      symbol: symbol,
      tier: "CANDIDATE",
      state: "OBSERVE_ONLY",
      score: 0,
      gates: [],
      reasons_zh: ["持仓中,但本轮没有该币行情数据:占位跟踪,不据此产生交易决策"],
      held: true,
      is_core: coreList.includes(symbol),
      metrics_missing: true
    });
  }

  const core = [];
  const candidate = [];
  const watch = [];
  const warmingUp = [];
  const observeOnly = [];
  const suspended = [];
  for (const e of entries) {
    if (e.tier === "CORE") core.push(e);
    else if (e.tier === "CANDIDATE") candidate.push(e);
    else watch.push(e);
    if (e.state === "WARMING_UP") warmingUp.push(e);
    else if (e.state === "OBSERVE_ONLY") observeOnly.push(e);
    else if (e.state === "SUSPENDED") suspended.push(e);
  }

  return {
    core: core,
    candidate: candidate,
    watch: watch,
    warming_up: warmingUp,
    observe_only: observeOnly,
    suspended: suspended,
    all: entries,
    active_count: entries.filter((e) => e.state === "ACTIVE").length
  };
}

// 从池子里挑出"值得跑完整模型"的 n 个:CORE 优先,其次按 score 降序。
// WARMING_UP / SUSPENDED / OBSERVE_ONLY 一律不入选 —— 状态不是排序问题,是资格问题。
export function selectActiveSymbols(universe, n) {
  const u = universe || {};
  const limit = n == null ? 10 : Math.max(0, Math.floor(universeNum(n)));
  const pool = (Array.isArray(u.all) ? u.all : []).filter((e) => e.state === "ACTIVE");
  const sorted = pool.slice().sort((a, b) => {
    const aCore = a.tier === "CORE" ? 1 : 0;
    const bCore = b.tier === "CORE" ? 1 : 0;
    if (aCore !== bCore) return bCore - aCore;
    if (b.score !== a.score) return b.score - a.score;
    return a.symbol < b.symbol ? -1 : (a.symbol > b.symbol ? 1 : 0);
  });
  return sorted.slice(0, limit);
}

// 中文视图:给 UI 直接渲染(标题 + 分层清单 + 计数)
export function universeView(universe) {
  const u = universe || {};
  const label = (e) => e.symbol + " · " + (UNIVERSE_TIER_ZH[e.tier] || e.tier)
    + " · " + (SYMBOL_STATE_ZH[e.state] || e.state) + " · 分 " + e.score;
  const core = (u.core || []).map(label);
  const candidate = (u.candidate || []).map(label);
  const watch = (u.watch || []).map(label);
  const warming = (u.warming_up || []).map(label);
  const observe = (u.observe_only || []).map(label);
  const suspended = (u.suspended || []).map(label);
  return {
    version: UNIVERSE_VERSION,
    counts: {
      core: (u.core || []).length,
      candidate: (u.candidate || []).length,
      watch: (u.watch || []).length,
      warming_up: (u.warming_up || []).length,
      observe_only: (u.observe_only || []).length,
      suspended: (u.suspended || []).length,
      active: universeNum(u.active_count),
      total: (u.all || []).length
    },
    core_zh: core,
    candidate_zh: candidate,
    watch_zh: watch,
    warming_up_zh: warming,
    observe_only_zh: observe,
    suspended_zh: suspended,
    headline_zh: "可交易 " + universeNum(u.active_count) + " 个 · 预热 "
      + (u.warming_up || []).length + " 个 · 仅观察 " + (u.observe_only || []).length
      + " 个 · 暂停 " + (u.suspended || []).length + " 个"
  };
}
