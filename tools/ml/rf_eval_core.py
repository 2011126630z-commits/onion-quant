#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
V16.1 rf_eval_core:树模型 / 任意三分类模型的统一评估核心(纯计算)
- 无文件读写、无路径处理、无网络、无全局状态
- 输入:预测概率 + 真实标签 + 每样本收益 + 费率
- 输出:分类指标 / 概率校准(分桶实测命中率 vs 预测概率 + Brier/ECE/MCE)
        / 扣费后净 PnL / Max Drawdown / Profit Factor / Fee Drag / Capital Efficiency

设计约定(与 ml_core.py 完全一致):
  LABELS = ["Bearish", "Neutral", "Bullish"] → 0/1/2
  收益方向: Bullish=+1, Bearish=-1, Neutral=0(空仓)
  收益单位: 与输入的 returns 一致(数据集里的 h*h_return 为百分数,故 PnL 指标同为百分数单位);
            本模块不做单位换算,只保证同单位下的方向与费用扣减正确

本模块可被 rf_core.py(训练)与其它评估脚本复用;不依赖 sklearn。
"""
import math

LABELS = ["Bearish", "Neutral", "Bullish"]
LABEL_TO_INT = {label: i for i, label in enumerate(LABELS)}
SIGN = {"Bearish": -1, "Neutral": 0, "Bullish": 1}

# 默认单边费率(小数)。往返一次按 2 倍计(开仓 + 平仓)
DEFAULT_FEE_RATE = 0.0005
DEFAULT_CALIBRATION_BINS = 10


def _finite(v):
    """把非有限值(inf/-inf/nan)统一成 None,保证输出可安全 JSON 往返"""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def _round(v, digits):
    f = _finite(v)
    return None if f is None else round(f, digits)


def _argmax(row):
    best, best_v = 0, None
    for i, v in enumerate(row):
        fv = _finite(v)
        if fv is None:
            continue
        if best_v is None or fv > best_v:
            best, best_v = i, fv
    return best


def _normalize_proba(row, n_classes=3):
    """归一化一行概率;非法/缺失时回退到均匀分布(明确、可复现,不静默变 0)"""
    vals = []
    for i in range(n_classes):
        v = _finite(row[i]) if row is not None and i < len(row) else None
        vals.append(v if v is not None and v >= 0 else 0.0)
    total = sum(vals)
    if total <= 0:
        return [1.0 / n_classes] * n_classes
    return [v / total for v in vals]


# ----------------------------------------------------------------------------
# 分类指标
# ----------------------------------------------------------------------------
def classification_metrics(y_true, y_pred):
    n = len(y_true)
    out = {"samples": int(n)}
    if n == 0:
        out.update({"accuracy": None, "balanced_accuracy": None, "macro_precision": None,
                    "macro_recall": None, "macro_f1": None, "per_class": {}, "confusion_matrix": []})
        return out
    cm = [[0] * 3 for _ in range(3)]
    for t, p in zip(y_true, y_pred):
        if 0 <= int(t) < 3 and 0 <= int(p) < 3:
            cm[int(t)][int(p)] += 1
    out["confusion_matrix"] = cm
    correct = sum(cm[i][i] for i in range(3))
    out["accuracy"] = _round(correct / n, 6)

    per_class, precisions, recalls, f1s = {}, [], [], []
    for idx, label in enumerate(LABELS):
        tp = cm[idx][idx]
        fn = sum(cm[idx]) - tp
        fp = sum(cm[r][idx] for r in range(3)) - tp
        support = sum(cm[idx])
        precision = tp / (tp + fp) if (tp + fp) > 0 else None
        recall = tp / (tp + fn) if (tp + fn) > 0 else None
        f1 = (2 * precision * recall / (precision + recall)) if (precision is not None and recall is not None and (precision + recall) > 0) else (
            0.0 if (precision is not None and recall is not None) else None)
        per_class[label.lower()] = {
            "precision": _round(precision, 6), "recall": _round(recall, 6),
            "f1": _round(f1, 6), "support": int(support), "predicted": int(sum(cm[r][idx] for r in range(3)))
        }
        if precision is not None:
            precisions.append(precision)
        if recall is not None:
            recalls.append(recall)
        if f1 is not None:
            f1s.append(f1)
    out["per_class"] = per_class
    out["macro_precision"] = _round(sum(precisions) / len(precisions), 6) if precisions else None
    out["macro_recall"] = _round(sum(recalls) / len(recalls), 6) if recalls else None
    out["macro_f1"] = _round(sum(f1s) / len(f1s), 6) if f1s else None
    out["balanced_accuracy"] = out["macro_recall"]
    return out


# ----------------------------------------------------------------------------
# 概率校准:分桶实测命中率 vs 预测概率 + Brier / ECE / MCE
# ----------------------------------------------------------------------------
def _brier(probs, y_true, n_classes=3):
    if not probs:
        return None
    total = 0.0
    for p, t in zip(probs, y_true):
        for c in range(n_classes):
            target = 1.0 if int(t) == c else 0.0
            total += (p[c] - target) ** 2
    return total / len(probs)


def _per_class_brier(probs, y_true, n_classes=3):
    out = {}
    for c, label in enumerate(LABELS):
        if not probs:
            out[label.lower()] = None
            continue
        s = 0.0
        for p, t in zip(probs, y_true):
            target = 1.0 if int(t) == c else 0.0
            s += (p[c] - target) ** 2
        out[label.lower()] = _round(s / len(probs), 6)
    return out


def calibration_metrics(probs, y_true, bins=None):
    """置信度分桶:每桶 [平均预测概率, 实测命中率, 样本数] + 每类预测概率 vs 实际频率"""
    n_bins = int(bins or DEFAULT_CALIBRATION_BINS)
    n = len(probs)
    out = {"bins": n_bins, "brier": None, "per_class_brier": {}, "ece": None, "mce": None,
           "reliability": [], "per_class_reliability": {}, "avg_confidence": None}
    if n == 0:
        return out
    confs = [max(p) for p in probs]
    correct = [1.0 if _argmax(p) == int(t) else 0.0 for p, t in zip(probs, y_true)]
    out["brier"] = _round(_brier(probs, y_true), 6)
    out["per_class_brier"] = _per_class_brier(probs, y_true)
    out["avg_confidence"] = _round(sum(confs) / n, 6)

    # 置信度分桶(下界含,上界不含;最后一桶含 1.0)
    edges = [i / n_bins for i in range(n_bins + 1)]
    buckets = [[] for _ in range(n_bins)]
    for c, ok in zip(confs, correct):
        idx = min(int(c * n_bins), n_bins - 1)
        if c >= 1.0:
            idx = n_bins - 1
        buckets[idx].append((c, ok))
    ece, mce = 0.0, 0.0
    rel = []
    for i, b in enumerate(buckets):
        if not b:
            continue
        avg_pred = sum(x[0] for x in b) / len(b)
        observed = sum(x[1] for x in b) / len(b)
        gap = abs(avg_pred - observed)
        weight = len(b) / n
        ece += weight * gap
        mce = max(mce, gap)
        rel.append({"bin_index": i, "bin_low": _round(edges[i], 6), "bin_high": _round(edges[i + 1], 6),
                    "samples": len(b), "avg_predicted_probability": _round(avg_pred, 6),
                    "observed_hit_rate": _round(observed, 6), "gap": _round(gap, 6)})
    out["reliability"] = rel
    out["ece"] = _round(ece, 6)
    out["mce"] = _round(mce, 6)

    # 每类:预测概率分桶 vs 该类实际出现频率(one-vs-rest 可靠性)
    per_class = {}
    for c, label in enumerate(LABELS):
        cbuckets = [[] for _ in range(5)]
        for p, t in zip(probs, y_true):
            pc = p[c]
            idx = min(int(pc * 5), 4)
            if pc >= 1.0:
                idx = 4
            cbuckets[idx].append((pc, 1.0 if int(t) == c else 0.0))
        rows = []
        for i, b in enumerate(cbuckets):
            if not b:
                continue
            rows.append({"bin_index": i, "samples": len(b),
                         "avg_predicted_probability": _round(sum(x[0] for x in b) / len(b), 6),
                         "observed_frequency": _round(sum(x[1] for x in b) / len(b), 6)})
        per_class[label.lower()] = rows
    out["per_class_reliability"] = per_class
    return out


# ----------------------------------------------------------------------------
# 交易指标:扣费后净 PnL / Max Drawdown / Profit Factor / Fee Drag / Capital Efficiency
# ----------------------------------------------------------------------------
def trading_metrics(y_pred, returns, fee_rate=None):
    """按模型预测方向做多/做空/空仓,计往返手续费,输出净收益指标。
    returns 与 y_pred 一一对应,单位小数。position ∈ {+1,0,-1}。"""
    fee = DEFAULT_FEE_RATE if fee_rate is None else float(fee_rate)
    n = len(y_pred)
    out = {"fee_rate_per_side": _round(fee, 8), "fee_model": "round_trip_2x_side",
           "return_unit": "same_as_input_returns",
           "trades": 0, "exposure": 0.0, "gross_pnl": None, "total_fees": None, "net_pnl": None,
           "gross_profit": None, "gross_loss": None, "profit_factor": None, "fee_drag": None,
           "max_drawdown": None, "capital_efficiency": None, "win_rate": None,
           "avg_net_pnl_per_trade": None, "avg_net_pnl_per_exposure": None,
           "net_pnl_pct_of_exposure": None, "equity_curve_points": 0}
    if n == 0:
        return out
    gross_list, fee_list, net_list, pos_list = [], [], [], []
    for p, r in zip(y_pred, returns):
        label = LABELS[int(p)] if 0 <= int(p) < 3 else "Neutral"
        pos = SIGN.get(label, 0)
        ret = _finite(r)
        if ret is None:
            ret = 0.0
        g = pos * ret
        f = abs(pos) * fee * 2.0
        gross_list.append(g)
        fee_list.append(f)
        net_list.append(g - f)
        pos_list.append(abs(pos))

    gross_pnl = sum(gross_list)
    total_fees = sum(fee_list)
    net_pnl = sum(net_list)
    gross_profit = sum(v for v in net_list if v > 0)
    gross_loss = sum(v for v in net_list if v < 0)  # 负数
    exposure = sum(pos_list)
    trades = int(sum(1 for x in pos_list if x > 0))
    wins = 0
    for p, nv in zip(y_pred, net_list):
        label = LABELS[int(p)] if 0 <= int(p) < 3 else "Neutral"
        if SIGN.get(label, 0) != 0 and nv > 0:
            wins += 1
    closed = trades
    equity, peak, max_dd = 0.0, 0.0, 0.0
    for v in net_list:
        equity += v
        peak = max(peak, equity)
        max_dd = max(max_dd, peak - equity)

    out.update({
        "trades": trades,
        "exposure": _round(exposure, 6),
        "gross_pnl": _round(gross_pnl, 8),
        "total_fees": _round(total_fees, 8),
        "net_pnl": _round(net_pnl, 8),
        "gross_profit": _round(gross_profit, 8),
        "gross_loss": _round(gross_loss, 8),
        "profit_factor": _round(gross_profit / abs(gross_loss), 6) if gross_loss < 0 else None,
        "fee_drag": _round(total_fees / abs(gross_pnl), 6) if abs(gross_pnl) > 1e-12 else None,
        "max_drawdown": _round(max_dd, 8),
        "capital_efficiency": _round(net_pnl / exposure, 8) if exposure > 0 else None,
        "win_rate": _round(wins / closed, 6) if closed > 0 else None,
        "avg_net_pnl_per_trade": _round(net_pnl / closed, 8) if closed > 0 else None,
        "avg_net_pnl_per_exposure": _round(net_pnl / exposure, 8) if exposure > 0 else None,
        "net_pnl_pct_of_exposure": _round(100.0 * net_pnl / exposure, 6) if exposure > 0 else None,
        "equity_curve_points": int(n)
    })
    return out


# ----------------------------------------------------------------------------
# 统一入口
# ----------------------------------------------------------------------------
def evaluate(probabilities, y_true, returns, options=None):
    """输入预测概率 + 真实标签 + 收益 + 费率,输出完整评估指标。
    probabilities: [[p_bear, p_neu, p_bull], ...](未归一化会被归一化)
    y_true: [0|1|2, ...]   returns: [小数收益, ...]
    options: {fee_rate, bins, label_order}"""
    opts = options or {}
    n = len(y_true)
    probs = [_normalize_proba(p) for p in (probabilities or [])]
    if len(probs) != n:
        probs = probs[:n] + [[1 / 3, 1 / 3, 1 / 3] for _ in range(max(0, n - len(probs)))]
    y_pred = [_argmax(p) for p in probs]
    rets = list(returns or [])
    if len(rets) != n:
        rets = rets[:n] + [None] * max(0, n - len(rets))

    result = {"samples": int(n), "label_order": list(opts.get("label_order") or LABELS)}
    result.update(classification_metrics(y_true, y_pred))
    result["calibration"] = calibration_metrics(probs, y_true, opts.get("bins"))
    result["trading"] = trading_metrics(y_pred, rets, opts.get("fee_rate"))
    result["prob_sum_max_dev"] = _round(
        max((abs(sum(p) - 1.0) for p in probs), default=0.0), 8) if probs else None
    result["predicted_distribution"] = {LABELS[c].lower(): int(sum(1 for x in y_pred if x == c)) for c in range(3)}
    return result


def assert_finite(metrics):
    """自检:递归确认输出中不含 nan/inf(供训练与测试复用)"""
    bad = []

    def walk(node, path):
        if isinstance(node, dict):
            for k, v in node.items():
                walk(v, path + "." + str(k))
        elif isinstance(node, (list, tuple)):
            for i, v in enumerate(node):
                walk(v, path + "[" + str(i) + "]")
        elif isinstance(node, float):
            if math.isnan(node) or math.isinf(node):
                bad.append(path)

    walk(metrics, "")
    return bad
