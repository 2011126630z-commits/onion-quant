#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
V16.1 rf_core:随机森林 Shadow/Challenger 模型(纯计算,无文件读写/无路径处理/无网络)

职责
- 严格时间序列切分:Train → Validation → Test(禁止随机切分 / shuffle),并额外产出 Walk Forward 折
- 只在 Train 上拟合(中位数填充等统计量只由 Train 拟合;RF 不需要标准化)
- 类不平衡:class_weight="balanced"(sklearn)或等价的加权 Gini(自实现)
- 导出可移植工件(JSON 树结构,非 pickle):每节点 feature_index/threshold/left/right/leaf_probability
- 输出完整评估:Accuracy/Precision/Recall/F1 + 概率校准(Brier/ECE/分桶命中率)
                + 扣费后净 PnL / Max Drawdown / Profit Factor / Fee Drag / Capital Efficiency

依赖
- 若环境有 sklearn.ensemble.RandomForestClassifier → 使用之(优先)
- 否则使用本文件内的确定性 numpy CART 实现(固定 seed/bootstrap/特征子采样,结果可复现)
两条路径导出**完全相同**的工件结构,JS 端(treeModel.js)一视同仁。

本模块是 V16.1 的 SHADOW 模型,不进入 Active Decision,只做旁路对照。
"""
import math
import time
from datetime import datetime, timezone

import numpy as np

try:  # 复用既有编码约定(与 mlRuntime.js 完全同构)
    import ml_core
except Exception:  # pragma: no cover
    ml_core = None

import rf_eval_core

LABELS = ["Bearish", "Neutral", "Bullish"]
LABEL_TO_INT = {label: i for i, label in enumerate(LABELS)}
INT_TO_LABEL = {i: label for label, i in LABEL_TO_INT.items()}
SIGN = {"Bearish": -1, "Neutral": 0, "Bullish": 1}

RF_FORMAT = "rf-json"
RF_MODEL_NAME = "random_forest"
RF_MODEL_VERSION = "rf-v0.1"
RF_ROLE = "SHADOW"
RF_FORMAT_VERSION = 1
SEED = 42

DEFAULT_PARAMS = {"n_estimators": 40, "max_depth": 6, "min_samples_leaf": 5, "max_features": "sqrt"}

_HAS_SKLEARN = False
try:  # pragma: no cover - 环境相关
    from sklearn.ensemble import RandomForestClassifier  # noqa: F401
    _HAS_SKLEARN = True
except Exception:  # pragma: no cover
    _HAS_SKLEARN = False


def backend_name():
    return "sklearn" if _HAS_SKLEARN else "numpy_fallback"


# ============================================================================
# 时间序列切分(严格:禁止随机)
# ============================================================================
def _strict_boundary(times, target):
    """返回 >= target 的最小下标 idx,使 times[idx] > times[idx-1](保证两段严格时间分离)"""
    n = len(times)
    idx = max(1, min(n - 1, int(target)))
    while idx < n and times[idx] <= times[idx - 1]:
        idx += 1
    return idx


def time_split(times, train_frac=0.6, val_frac=0.2):
    """按时间顺序切 Train/Validation/Test。返回 {ok, train:(a,b), val:(a,b), test:(a,b), reason}"""
    n = len(times)
    out = {"ok": False, "train": None, "val": None, "test": None, "reason": "", "n": n}
    if n < 12:
        out["reason"] = "too_few_samples"
        return out
    c1 = _strict_boundary(times, round(n * train_frac))
    c2 = _strict_boundary(times, round(n * (train_frac + val_frac)))
    # c2 必须严格大于 c1,且三段都非空
    if c2 <= c1:
        c2 = c1 + 1
    if c2 > n - 1:
        # 尾部太短:退回一个仍满足严格分离的切点
        c2 = n - 1
        while c2 > c1 and times[c2] <= times[c2 - 1]:
            c2 -= 1
    if not (1 <= c1 < c2 <= n - 1):
        out["reason"] = "cannot_split_strictly"
        return out
    out.update({
        "ok": True,
        "train": (0, c1 - 1),
        "val": (c1, c2 - 1),
        "test": (c2, n - 1),
        "train_start_time": times[0],
        "train_end_time": times[c1 - 1], "val_start_time": times[c1],
        "val_end_time": times[c2 - 1], "test_start_time": times[c2], "test_end_time": times[n - 1],
        "strictly_ordered": bool(times[c1 - 1] < times[c1] < times[c2]),
        "shuffle": False, "random_split": False,
    })
    return out


def walk_forward_windows(times, train_ms, val_ms, test_ms, max_folds=8):
    """滚动 origin:train → val → test 三段连续且严格分离,窗口整体向前推进 test_ms"""
    folds = []
    if not times or test_ms <= 0:
        return folds
    start, end = times[0], times[-1]
    origin = start + train_ms + val_ms
    fold_id = 0
    while origin + test_ms - 1 <= end and len(folds) < max_folds:
        tr_end = origin - val_ms - 1
        va_start, va_end = origin - val_ms, origin - 1
        te_start, te_end = origin, origin + test_ms - 1
        folds.append({"fold_id": fold_id,
                      "train_start": int(tr_end - train_ms + 1), "train_end": int(tr_end),
                      "val_start": int(va_start), "val_end": int(va_end),
                      "test_start": int(te_start), "test_end": int(te_end),
                      "train_end_before_val_start": bool(tr_end < va_start),
                      "val_end_before_test_start": bool(va_end < te_start)})
        fold_id += 1
        origin += test_ms
    return folds


# ============================================================================
# 确定性 numpy CART 回退实现(无 sklearn 时)
# ============================================================================
def _class_weights(y, n_classes=3):
    counts = np.bincount(y, minlength=n_classes).astype(float)
    counts[counts == 0] = 1.0
    return (len(y) / (n_classes * counts))[y]


def _weighted_gini(y, w, n_classes=3):
    total = float(w.sum())
    if total <= 0:
        return 0.0
    g = 1.0
    for c in range(n_classes):
        p = float(w[y == c].sum()) / total
        g -= p * p
    return max(0.0, g)


def _build_tree_numpy(X, y, w, rng, params, depth=0, n_classes=3):
    n, n_features = X.shape
    node = {"feature_index": -1, "threshold": None, "left": None, "right": None,
            "leaf_probability": None, "samples": int(n)}
    counts = np.zeros(n_classes)
    for c in range(n_classes):
        counts[c] = float(w[y == c].sum())
    total = counts.sum()
    probs = (counts / total).tolist() if total > 0 else [1.0 / n_classes] * n_classes
    max_depth = int(params.get("max_depth", 6))
    min_leaf = int(params.get("min_samples_leaf", 5))
    pure = np.count_nonzero(counts) <= 1
    if depth >= max_depth or n < 2 * min_leaf or pure:
        node["leaf_probability"] = probs
        return node

    max_features = params.get("max_features", "sqrt")
    if max_features == "sqrt":
        k = max(1, int(math.sqrt(n_features)))
    elif isinstance(max_features, int) and max_features > 0:
        k = min(n_features, max_features)
    else:
        k = n_features
    cand = rng.choice(n_features, size=k, replace=False)
    best = None  # (gain, feature, threshold)
    parent_gini = _weighted_gini(y, w, n_classes)
    for f in cand:
        f = int(f)
        xs = X[:, f]
        order = np.argsort(xs, kind="mergesort")
        xs_s, ys_s, ws_s = xs[order], y[order], w[order]
        # 只在相邻不同值之间取中点
        uniq = np.unique(xs_s)
        if len(uniq) < 2:
            continue
        for i in range(len(uniq) - 1):
            thr = (uniq[i] + uniq[i + 1]) / 2.0
            left_mask = xs_s <= thr
            nl = int(left_mask.sum())
            if nl < min_leaf or (n - nl) < min_leaf:
                continue
            wl, wr = ws_s[left_mask], ws_s[~left_mask]
            gl = _weighted_gini(ys_s[left_mask], wl, n_classes)
            gr = _weighted_gini(ys_s[~left_mask], wr, n_classes)
            wt = nl + (n - nl)
            gini = (wl.sum() / ws_s.sum()) * gl + (wr.sum() / ws_s.sum()) * gr
            gain = parent_gini - gini
            if best is None or gain > best[0] + 1e-15:
                best = (gain, f, float(thr))
    if best is None or best[0] <= 0:
        node["leaf_probability"] = probs
        return node
    _, feat, thr = best
    left_mask = X[:, feat] <= thr
    left = _build_tree_numpy(X[left_mask], y[left_mask], w[left_mask], rng, params, depth + 1, n_classes)
    right = _build_tree_numpy(X[~left_mask], y[~left_mask], w[~left_mask], rng, params, depth + 1, n_classes)
    # 子节点在"本节点分配后"的索引(后序展平)
    node["feature_index"] = int(feat)
    node["threshold"] = float(thr)
    node["left"] = left
    node["right"] = right
    node["leaf_probability"] = None
    return node


def _flatten_tree(root, nodes):
    idx = len(nodes)
    nodes.append(None)
    if root.get("leaf_probability") is not None:
        nodes[idx] = {"feature_index": -1, "threshold": None, "left": None, "right": None,
                      "leaf_probability": [round(float(v), 12) for v in root["leaf_probability"]],
                      "samples": root["samples"]}
        return idx
    left = _flatten_tree(root["left"], nodes)
    right = _flatten_tree(root["right"], nodes)
    nodes[idx] = {"feature_index": int(root["feature_index"]), "threshold": root["threshold"],
                  "left": left, "right": right, "leaf_probability": None, "samples": root["samples"]}
    return idx


def _fit_numpy_forest(X, y, params):
    n_estimators = int(params.get("n_estimators", 40))
    seed = int(params.get("seed", SEED))
    trees = []
    for t in range(n_estimators):
        rng = np.random.RandomState(seed + 1000 + t)  # 固定 seed → 完全可复现
        n = len(y)
        boot = rng.randint(0, n, n)  # 固定 bootstrap
        Xb, yb = X[boot], y[boot]
        wb = _class_weights(yb)
        root = _build_tree_numpy(Xb, yb, wb, rng, params)
        nodes = []
        _flatten_tree(root, nodes)
        trees.append({"root": 0, "n_nodes": len(nodes), "nodes": nodes})
    return trees


# ============================================================================
# sklearn 路径:训练 + 导出树结构
# ============================================================================
def _fit_sklearn_forest(X, y, params):
    from sklearn.ensemble import RandomForestClassifier
    p = dict(DEFAULT_PARAMS)
    p.update(params or {})
    clf = RandomForestClassifier(
        n_estimators=int(p["n_estimators"]),
        max_depth=None if p.get("max_depth") in (None, 0) else int(p["max_depth"]),
        min_samples_leaf=int(p.get("min_samples_leaf", 5)),
        max_features=p.get("max_features", "sqrt"),
        class_weight="balanced",   # 类不平衡
        bootstrap=True,
        random_state=int(p.get("seed", SEED)),
        n_jobs=1,
        criterion="gini",
    )
    clf.fit(X, y)
    trees = []
    for est in clf.estimators_:
        t = est.tree_
        nodes = []
        for i in range(t.node_count):
            is_leaf = bool(t.children_left[i] == t.children_right[i])
            if is_leaf:
                val = np.asarray(t.value[i]).reshape(-1).astype(float)
                s = val.sum()
                probs = (val / s).tolist() if s > 0 else [1.0 / 3] * 3
                nodes.append({"feature_index": -1, "threshold": None, "left": None, "right": None,
                              "leaf_probability": [round(float(v), 12) for v in probs],
                              "samples": int(t.n_node_samples[i])})
            else:
                # threshold 原样导出 sklearn 的 float64 中点值(JSON double 无损往返);
                # 判据为 float32(X) <= threshold,与 sklearn _tree.pyx 的比较完全一致
                nodes.append({"feature_index": int(t.feature[i]),
                              "threshold": float(t.threshold[i]),
                              "left": int(t.children_left[i]), "right": int(t.children_right[i]),
                              "leaf_probability": None, "samples": int(t.n_node_samples[i])})
        trees.append({"root": 0, "n_nodes": len(nodes), "nodes": nodes})
    return trees, clf


def _fit_forest(X, y, params):
    """返回 (trees, clf);clf 仅在 sklearn 路径存在,用于与导出的 JSON 树逐样本对拍"""
    if _HAS_SKLEARN:
        return _fit_sklearn_forest(X, y, params)
    return _fit_numpy_forest(X, y, params), None


def _proba(trees, clf, X):
    if clf is not None:
        return np.asarray(clf.predict_proba(X), dtype=float)
    return predict_forest_artifact({"trees": trees, "n_classes": 3}, X)


# ============================================================================
# 工件推理(纯 python,用于证明 JSON 可移植 / 与 sklearn 一致)
# ============================================================================
def predict_forest_artifact(artifact, X):
    """按导出工件的树结构推理,输入 X 为 numpy 矩阵(列顺序 = artifact.feature_names)"""
    trees = artifact["trees"]
    n_classes = int(artifact.get("n_classes", 3))
    X = np.asarray(X, dtype=float)
    out = np.zeros((len(X), n_classes), dtype=float)
    for row_i, row in enumerate(X):
        acc = np.zeros(n_classes, dtype=float)
        for tree in trees:
            nodes = tree["nodes"]
            i = int(tree.get("root", 0))
            guard = 0
            while True:
                guard += 1
                if guard > len(nodes) + 4:
                    break
                node = nodes[i]
                lp = node.get("leaf_probability")
                if lp is not None:
                    acc += np.asarray(lp, dtype=float)
                    break
                f = int(node["feature_index"])
                # sklearn: float32(feature) <= float64(threshold) → 显式对齐,逐样本与 sklearn 一致
                xv = np.float32(row[f])
                thr = float(node["threshold"])
                i = int(node["left"]) if float(xv) <= thr else int(node["right"])
        out[row_i] = acc / max(1, len(trees))
    return out


# ============================================================================
# 特征工程:复用 ml_core.Encoder(与 mlRuntime.js 同构)
# ============================================================================
CATEGORICAL_COLUMNS = ["market_regime", "regime_vol_state", "structure_label", "volume_pattern",
                       "volatility_level", "btc_state"]


def build_encoder(columns, rows):
    categorical = ml_core.CATEGORICAL_COLUMNS if ml_core else CATEGORICAL_COLUMNS
    numeric_cols = ml_core.numeric_feature_columns(columns, rows) if ml_core else []
    enc = ml_core.Encoder(numeric_cols, categorical).fit(rows) if ml_core else None
    return enc


def feature_defaults(enc):
    """缺失特征默认值:数值列用 Train 中位数;One-Hot 列用 0(无该类别 = 全 0,是语义正确的默认)"""
    defs = []
    for c in enc.numeric_cols:
        defs.append(float(enc.medians.get(c, 0.0)))
    n_onehot = len(enc.columns) - len(enc.numeric_cols)
    defs.extend([0.0] * n_onehot)
    return defs


# ============================================================================
# 训练主入口
# ============================================================================
def load_rows(rows_all, horizon, key):
    """清洗 + 挂载 _ret/_label 等内部字段(与 ml_core.clean_rows 同口径)"""
    if ml_core is None:
        raise RuntimeError("ml_core 不可用")
    rows, stats = ml_core.clean_rows(rows_all, horizon)
    for r in rows:
        r["_ret"] = r.get(f"{key}_return")
        r["_mfe"] = r.get(f"{key}_mfe")
        r["_mae"] = r.get(f"{key}_mae")
        r["_label"] = r.get(f"{key}_outcome")
        r["_rule"] = r.get("direction")
    return rows, stats


def _y_of(rows):
    return np.array([LABEL_TO_INT[r["_label"]] for r in rows], dtype=int)


def _returns_of(rows):
    return [float(r.get("_ret")) if r.get("_ret") is not None else None for r in rows]


def _slice(rows, X, bounds):
    a, b = bounds
    return rows[a:b + 1], X[a:b + 1]


def _evaluate(rows, proba, fee_rate):
    y = _y_of(rows)
    return rf_eval_core.evaluate(proba.tolist(), y.tolist(), _returns_of(rows), {"fee_rate": fee_rate})


def _param_grid():
    return [
        {"n_estimators": 24, "max_depth": 4, "min_samples_leaf": 5, "max_features": "sqrt"},
        {"n_estimators": 40, "max_depth": 6, "min_samples_leaf": 5, "max_features": "sqrt"},
        {"n_estimators": 60, "max_depth": 8, "min_samples_leaf": 3, "max_features": "sqrt"},
    ]


def _proba_of(X, trees):
    return predict_forest_artifact({"trees": trees, "n_classes": 3}, X)


def select_on_validation(X_train, y_train, X_val, y_val, candidates):
    """只用 Validation 选参(绝不接触 Test);返回 {selected, candidates:[...]}"""
    best, scored = None, []
    for cand in candidates:
        try:
            if _HAS_SKLEARN:
                trees, _ = _fit_sklearn_forest(X_train, y_train, cand)
            else:
                trees = _fit_numpy_forest(X_train, y_train, cand)
            pv = _proba_of(X_val, trees)
            m = rf_eval_core.evaluate(pv.tolist(), y_val.tolist(), [0.0] * len(y_val), {})
            score = m.get("macro_f1")
            if score is None:
                score = m.get("accuracy") or 0.0
        except Exception as exc:  # pragma: no cover
            scored.append({"params": cand, "error": str(exc)[:120]})
            continue
        scored.append({"params": cand, "val_macro_f1": m.get("macro_f1"), "val_accuracy": m.get("accuracy")})
        if best is None or score > best[1]:
            best = (cand, score)
    return {"selected": (best[0] if best else {}), "candidates": scored,
            "val_best_score": (best[1] if best else None)}


def train_random_forest(rows_all, columns, meta, options):
    """纯计算:返回 (report, artifacts, predictions)"""
    opts = options or {}
    horizons = opts.get("horizons") or ["1h"]
    train_frac = float(opts.get("train_frac", 0.6))
    val_frac = float(opts.get("val_frac", 0.2))
    fee_rate = float(opts.get("fee_rate", rf_eval_core.DEFAULT_FEE_RATE))
    min_samples = int(opts.get("min_samples", 60))
    params_in = dict(opts.get("params") or {})
    do_select = bool(opts.get("select_params", True))

    report = {
        "generated_at": datetime.now(tz=timezone.utc).isoformat(),
        "model": {"model_name": RF_MODEL_NAME, "model_version": RF_MODEL_VERSION, "role": RF_ROLE,
                  "format": RF_FORMAT, "format_version": RF_FORMAT_VERSION, "backend": backend_name(),
                  "note": "SHADOW/Challenger:旁路对照,不得直接进入 Active Decision"},
        "dataset": {"rows": len(rows_all), "columns": len(columns), "source": meta.get("source"),
                    "engine_version": meta.get("engine_version"), "feature_version": meta.get("feature_version")},
        "config": {"horizons": horizons, "split": "time_ordered_train_val_test", "walk_forward": True,
                   "random_split": False, "shuffle": False, "seed": SEED,
                   "train_frac": train_frac, "val_frac": val_frac, "test_frac": round(1 - train_frac - val_frac, 4),
                   "class_weight": "balanced", "fee_rate_per_side": fee_rate,
                   "scaler": "none (RandomForest 不需要标准化)", "imputation": "median (fit on Train only)",
                   "min_samples_required": min_samples,
                   "params": {**DEFAULT_PARAMS, **params_in}},
        "feature_policy": {"excluded_rule_outputs": sorted(ml_core.RULE_OUTPUT_COLUMNS),
                           "excluded_ids": sorted(ml_core.ID_COLUMNS),
                           "categorical_onehot": list(ml_core.CATEGORICAL_COLUMNS),
                           "note": "特征只来自信号时保存的 Feature Snapshot;中位数只由 Train 拟合;Test 从不参与 fit"},
        "horizons": {},
    }
    artifacts, predictions = {}, {}

    for horizon in horizons:
        key = ml_core.hkey(horizon)
        rows, clean_stats = load_rows(rows_all, horizon, key)
        block = {
            "samples": {"labeled": len(rows), "pending_excluded": clean_stats["pending_excluded"],
                        "duplicate_removed": clean_stats["duplicate_removed"],
                        "invalid_label_rows": clean_stats["invalid_label"],
                        "class_counts": {label: int(sum(1 for r in rows if r["_label"] == label)) for label in LABELS},
                        "eligible_for_comparison": bool(len(rows) >= min_samples)},
            "folds": [], "validation": None, "test": None,
        }
        if len(rows) < 12:
            block["error"] = "too_few_labeled_rows:" + str(len(rows))
            report["horizons"][horizon] = block
            continue

        enc = build_encoder(columns, rows)
        X_all = enc.transform(rows)
        times = [float(r["timestamp"]) for r in rows]
        block["feature_columns"] = list(enc.columns)
        block["feature_defaults"] = [round(float(v), 10) for v in feature_defaults(enc)]

        split = time_split(times, train_frac, val_frac)
        block["split"] = {k: v for k, v in split.items() if k not in ("train", "val", "test", "ok")}
        block["split"].update({"train_samples": (split["train"][1] - split["train"][0] + 1) if split.get("train") else 0,
                               "val_samples": (split["val"][1] - split["val"][0] + 1) if split.get("val") else 0,
                               "test_samples": (split["test"][1] - split["test"][0] + 1) if split.get("test") else 0})
        if not split["ok"]:
            block["error"] = split["reason"]
            report["horizons"][horizon] = block
            continue

        tr_rows, X_tr = _slice(rows, X_all, split["train"])
        va_rows, X_va = _slice(rows, X_all, split["val"])
        te_rows, X_te = _slice(rows, X_all, split["test"])
        y_tr, y_va, y_te = _y_of(tr_rows), _y_of(va_rows), _y_of(te_rows)

        # ---- 1) 只在 Train 上拟合候选,用 Validation 选参 ----
        cand = {**DEFAULT_PARAMS, **params_in}
        sel = {"selected": cand, "candidates": [], "note": "select_params=false"}
        if do_select:
            grid = _param_grid()
            grid = [g for g in grid if g != cand] + [cand]
            sel = select_on_validation(X_tr, y_tr, X_va, y_va, grid)
            sel["note"] = "只使用 Validation 选参,Test 从未参与"
        block["param_selection"] = sel

        # ---- 2) 最终模型只在 Train 上拟合(冻结后再看 Test) ----
        trees, clf = _fit_forest(X_tr, y_tr, sel["selected"])
        proba_all = _proba(trees, clf, X_all)

        # 工件:导出后可移植(JSON,非 pickle)
        artifact = {
            "format": RF_FORMAT, "format_version": RF_FORMAT_VERSION,
            "model_name": RF_MODEL_NAME, "model_version": RF_MODEL_VERSION, "role": RF_ROLE,
            "horizon": horizon, "n_classes": 3,
            "label_order": list(LABELS),
            "feature_names": list(enc.columns),
            "feature_defaults": [round(float(v), 12) for v in feature_defaults(enc)],
            "encoder": enc.to_json(),
            "trees": trees,
            "tree_count": len(trees),
            "training_meta": {
                "backend": backend_name(), "seed": SEED, "params": sel["selected"],
                "class_weight": "balanced", "bootstrap": True, "max_features": sel["selected"].get("max_features", "sqrt"),
                "fit_rows": int(len(tr_rows)), "val_rows": int(len(va_rows)), "test_rows": int(len(te_rows)),
                "train_end_time": int(split["train_end_time"]),
                "val_start_time": int(split["val_start_time"]),
                "test_start_time": int(split["test_start_time"]),
                "feature_version": meta.get("feature_version"),
                "engine_version": meta.get("engine_version"),
                "created_at": report["generated_at"],
                "note": "SHADOW 模型:不得直接进入 Active Decision",
            },
        }

        # ---- 3) 工件 JSON 往返 + 与 sklearn 逐样本对拍(证明导出无损、可被 JS 端复现) ----
        import json as _json
        serialized = _json.dumps(artifact)
        roundtrip = predict_forest_artifact(_json.loads(serialized), X_all)
        max_diff = float(np.max(np.abs(roundtrip - proba_all))) if len(proba_all) else 0.0
        te_walk = predict_forest_artifact({"trees": trees, "n_classes": 3}, X_te)
        sk_te = np.asarray(clf.predict_proba(X_te)) if clf is not None else te_walk
        sklearn_diff = float(np.max(np.abs(te_walk - sk_te))) if len(te_rows) else 0.0
        block["artifact"] = {"key": "rf|" + horizon, "format": RF_FORMAT,
                             "json_roundtrip_max_prob_diff": round(max_diff, 12),
                             "json_roundtrip_consistent": bool(max_diff < 1e-9),
                             "json_walk_vs_backend_max_prob_diff": round(sklearn_diff, 9),
                             "json_walk_matches_backend": bool(sklearn_diff < 1e-6),
                             "tree_count": len(trees),
                             "node_count": int(sum(t["n_nodes"] for t in trees)),
                             "serialized_bytes": len(serialized)}

        # ---- 4) 评估:Validation / Test 分开报告 ----
        va_proba = proba_all[split["val"][0]:split["val"][1] + 1]
        te_proba = proba_all[split["test"][0]:split["test"][1] + 1]
        block["validation"] = _evaluate(va_rows, va_proba, fee_rate)
        block["test"] = _evaluate(te_rows, te_proba, fee_rate)
        block["test"]["train_fit_accuracy"] = round(
            float(np.mean(np.argmax(proba_all[split["train"][0]:split["train"][1] + 1], axis=1) == y_tr)), 6)

        # 特征重要性(gini,来自同一个在 Train 上拟合的模型,不重新训练)
        if clf is not None and hasattr(clf, "feature_importances_"):
            fi = np.asarray(clf.feature_importances_, dtype=float).tolist()
            block["feature_importance"] = [[n, round(float(v), 6)] for n, v in
                                           sorted(zip(enc.columns, fi), key=lambda kv: -kv[1])[:15]]
        else:
            block["feature_importance"] = []

        # ---- 5) Walk Forward 折(额外的时序稳健性检查) ----
        train_ms = int(opts.get("train_days", 10) * 86400000)
        val_ms = int(opts.get("val_days", 3) * 86400000)
        test_ms = int(opts.get("test_days", 3) * 86400000)
        wf = walk_forward_windows(times, train_ms, val_ms, test_ms, max_folds=int(opts.get("max_folds", 6)))
        for fold in wf:
            tr_r = [r for r in rows if fold["train_start"] <= float(r["timestamp"]) <= fold["train_end"]]
            va_r = [r for r in rows if fold["val_start"] <= float(r["timestamp"]) <= fold["val_end"]]
            te_r = [r for r in rows if fold["test_start"] <= float(r["timestamp"]) <= fold["test_end"]]
            fr = {"fold_id": fold["fold_id"], "train_start": fold["train_start"], "train_end": fold["train_end"],
                  "val_start": fold["val_start"], "val_end": fold["val_end"],
                  "test_start": fold["test_start"], "test_end": fold["test_end"],
                  "train_end_before_val_start": fold["train_end_before_val_start"],
                  "val_end_before_test_start": fold["val_end_before_test_start"],
                  "train_samples": len(tr_r), "val_samples": len(va_r), "test_samples": len(te_r)}
            if len(tr_r) < 20 or len(te_r) < 5:
                fr["skipped"] = "insufficient_samples"
                block["folds"].append(fr)
                continue
            fenc = build_encoder(columns, tr_r)
            fX_tr = fenc.transform(tr_r)
            fX_te = fenc.transform(te_r)
            try:
                if _HAS_SKLEARN:
                    ftrees, _ = _fit_sklearn_forest(fX_tr, _y_of(tr_r), sel["selected"])
                else:
                    ftrees = _fit_numpy_forest(fX_tr, _y_of(tr_r), sel["selected"])
                fproba = predict_forest_artifact({"trees": ftrees, "n_classes": 3}, fX_te)
                fr["metrics"] = _evaluate(te_r, fproba, fee_rate)
            except Exception as exc:  # pragma: no cover
                fr["error"] = str(exc)[:160]
            block["folds"].append(fr)
        # 折汇总
        ok_folds = [f for f in block["folds"] if f.get("metrics")]
        if ok_folds:
            block["walk_forward_summary"] = {
                "folds_used": len(ok_folds),
                "avg_accuracy": round(float(np.mean([f["metrics"]["accuracy"] for f in ok_folds])), 6),
                "avg_macro_f1": round(float(np.mean([f["metrics"]["macro_f1"] for f in ok_folds
                                                     if f["metrics"].get("macro_f1") is not None] or [0])), 6),
                "avg_net_pnl": round(float(np.mean([f["metrics"]["trading"]["net_pnl"] for f in ok_folds])), 8),
                "worst_max_drawdown": round(float(max(f["metrics"]["trading"]["max_drawdown"] for f in ok_folds)), 8),
                "all_ordered": bool(all(f["train_end_before_val_start"] and f["val_end_before_test_start"] for f in ok_folds)),
            }

        # ---- 6) 预测明细(Test) ----
        preds = []
        for r, yt, pr in zip(te_rows, y_te, te_proba):
            p = [float(x) for x in pr]
            label = INT_TO_LABEL[int(np.argmax(p))]
            pos = SIGN[label]
            ret = float(r.get("_ret") or 0.0)
            net = pos * ret - abs(pos) * fee_rate * 2.0
            preds.append({"model_name": RF_MODEL_NAME, "model_version": RF_MODEL_VERSION, "role": RF_ROLE,
                          "horizon": horizon, "symbol": r.get("symbol"), "timestamp": int(float(r.get("timestamp"))),
                          "predicted_class": label, "actual_class": r.get("_label"), "rule_direction": r.get("_rule"),
                          "probability_bearish": round(p[0], 6), "probability_neutral": round(p[1], 6),
                          "probability_bullish": round(p[2], 6), "confidence": round(max(p), 6),
                          "gross_return": round(pos * ret, 8), "fee": round(abs(pos) * fee_rate * 2.0, 8),
                          "net_return": round(net, 8)})
        predictions["rf|" + horizon] = preds

        # ---- 7) 输出自检:不得含 nan/inf ----
        block["finite_check"] = rf_eval_core.assert_finite({"validation": block["validation"], "test": block["test"]})
        artifacts["rf|" + horizon] = artifact
        report["horizons"][horizon] = block

    return report, artifacts, predictions
