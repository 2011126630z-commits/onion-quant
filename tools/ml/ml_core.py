#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
V13 ML Baseline 核心计算(纯函数式:无文件读写、无路径处理、无网络)
- Walk Forward 切分 / 清洗去重 / Encoder(Scaler 与 One-Hot 只拟合 Train)
- Logistic Regression / LightGBM / XGBoost 三分类 + Rule Engine 基准
- 指标 / 校准(只在 Train 拟合) / 特征重要性 / 过拟合检查
- 模型以数据格式表达(不用 pickle),由 -core 之外的 CLI 负责落盘
"""
import base64
import json
import math
import sys
import time
from datetime import datetime, timezone

import numpy as np

LABELS = ["Bearish", "Neutral", "Bullish"]
LABEL_TO_INT = {label: i for i, label in enumerate(LABELS)}
INT_TO_LABEL = {i: label for label, i in LABEL_TO_INT.items()}
SIGN = {"Bullish": 1, "Bearish": -1, "Neutral": 0}

ALLOWED_MODELS = ["logreg", "lightgbm", "xgboost"]
ALLOWED_HORIZONS = ["5m", "15m", "1h", "4h", "24h"]
MODEL_VERSIONS = {"logreg": "logreg-v0.1", "lightgbm": "lightgbm-v0.1", "xgboost": "xgboost-v0.1", "rule": "rule-v0.1"}
RULE_OUTPUT_COLUMNS = {"direction", "signal_strength", "confidence", "risk_score", "risk_level"}
ID_COLUMNS = {"signal_id", "timestamp_iso", "backtest_run_id", "source"}
CATEGORICAL_COLUMNS = ["market_regime", "regime_vol_state", "structure_label", "volume_pattern", "volatility_level", "btc_state"]


def hkey(horizon):
    return {"5m": "h5m", "15m": "h15m", "1h": "h1h", "4h": "h4h", "24h": "h24h"}[horizon]


def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def clean_rows(rows, horizon):
    """Pending 不进训练集 + 去重 + 标签异常剔除"""
    key = hkey(horizon)
    stats = {"input": len(rows), "pending_excluded": 0, "no_label": 0, "duplicate_removed": 0, "invalid_label": 0}
    seen, out = set(), []
    for r in rows:
        if r.get(f"{key}_resolved") != 1:
            stats["pending_excluded"] += 1
            continue
        label = r.get(f"{key}_outcome")
        if label not in LABEL_TO_INT:
            stats["no_label"] += 1
            continue
        bad = False
        for f in ("return", "mfe", "mae"):
            v = r.get(f"{key}_{f}")
            if v is None or not is_num(v) or math.isnan(v) or math.isinf(v):
                bad = True
                break
        if bad:
            stats["invalid_label"] += 1
            continue
        dedupe = (r.get("symbol"), r.get("timestamp"), r.get("engine_version"), r.get("feature_version"))
        if dedupe in seen:
            stats["duplicate_removed"] += 1
            continue
        seen.add(dedupe)
        out.append(r)
    stats["kept"] = len(out)
    out.sort(key=lambda r: float(r.get("timestamp") or 0))
    return out, stats


def make_folds(start_ms, end_ms, train_ms, test_ms):
    folds = []
    if end_ms <= start_ms:
        return folds
    fold_id, test_start = 0, start_ms + train_ms
    while test_start + test_ms - 1 <= end_ms:
        folds.append({"fold_id": fold_id, "train_start": test_start - train_ms, "train_end": test_start - 1,
                      "test_start": test_start, "test_end": test_start + test_ms - 1})
        fold_id += 1
        test_start += test_ms
    return folds


def numeric_feature_columns(columns, rows):
    cols = []
    for c in columns:
        if c in RULE_OUTPUT_COLUMNS or c in ID_COLUMNS or c in CATEGORICAL_COLUMNS:
            continue
        if c.startswith("h") and any(c.startswith(f"h{h}_") for h in ALLOWED_HORIZONS):
            continue
        if any(is_num(r.get(c)) for r in rows[:200]):
            cols.append(c)
    return cols


class Encoder:
    """One-Hot + 中位数填充:全部统计量只由 Train 拟合"""

    def __init__(self, numeric_cols, categorical_cols):
        self.numeric_cols = list(numeric_cols)
        self.categorical_cols = list(categorical_cols)
        self.levels, self.medians, self.columns, self.fit_rows = {}, {}, [], 0

    def fit(self, rows):
        self.fit_rows = len(rows)
        for col in self.categorical_cols:
            self.levels[col] = sorted({str(r.get(col)) for r in rows if r.get(col) is not None})
        for col in self.numeric_cols:
            vals = [float(r[col]) for r in rows if is_num(r.get(col))]
            self.medians[col] = float(np.median(vals)) if vals else 0.0
        self.columns = self.numeric_cols + [f"{c}={v}" for c in self.categorical_cols for v in self.levels[c]]
        return self

    def transform(self, rows):
        X = np.zeros((len(rows), len(self.columns)), dtype=float)
        for i, r in enumerate(rows):
            j = 0
            for col in self.numeric_cols:
                v = r.get(col)
                X[i, j] = float(v) if is_num(v) else self.medians[col]
                j += 1
            for col in self.categorical_cols:
                sv = str(r.get(col))
                for lvl in self.levels[col]:
                    X[i, j] = 1.0 if sv == lvl else 0.0
                    j += 1
        return X

    def to_json(self):
        return {"fit_rows": self.fit_rows, "categorical_levels": self.levels, "numeric_medians": self.medians,
                "numeric_cols": self.numeric_cols, "categorical_cols": self.categorical_cols, "columns": self.columns}

    @staticmethod
    def from_json(obj):
        enc = Encoder(obj["numeric_cols"], obj["categorical_cols"])
        enc.levels = obj["categorical_levels"]
        enc.medians = obj["numeric_medians"]
        enc.columns = obj["columns"]
        enc.fit_rows = obj.get("fit_rows", 0)
        return enc


def _softmax(z):
    z = z - np.max(z, axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


class ReloadedModel:
    """从数据格式重建的预测器(predict / predict_proba),不涉及 pickle"""

    def __init__(self, payload):
        self.name = payload["model_name"]
        self.format = payload["format"]
        self.encoder = Encoder.from_json(payload["encoder"])
        self.classes_ = np.array(payload.get("classes", [0, 1, 2]))
        if self.format == "logreg-json":
            self.coef_ = np.array(payload["coef"])
            self.intercept_ = np.array(payload["intercept"])
            self.mean_ = np.array(payload["scaler_mean"])
            self.scale_ = np.array(payload["scaler_scale"])
        elif self.format == "lightgbm-text":
            import lightgbm as lgb
            self.booster = lgb.Booster(model_str=payload["model_text"])
        elif self.format == "xgboost-json-b64":
            import xgboost as xgb
            self.booster = xgb.Booster()
            self.booster.load_model(bytearray(base64.b64decode(payload["model_b64"])))
        else:
            raise ValueError("unknown format " + self.format)

    def predict_proba(self, X):
        X = np.asarray(X, dtype=float)
        if self.format == "logreg-json":
            return _softmax(((X - self.mean_) / self.scale_) @ self.coef_.T + self.intercept_)
        if self.format == "lightgbm-text":
            return np.asarray(self.booster.predict(X)).reshape(len(X), -1)
        import xgboost as xgb
        return self.booster.predict(xgb.DMatrix(X))

    def predict(self, X):
        return self.classes_[np.argmax(self.predict_proba(X), axis=1)]


def artifact_payload(name, horizon, model, encoder, selected_params):
    payload = {"model_name": name, "model_version": MODEL_VERSIONS[name], "horizon": horizon,
               "selected_params": selected_params or {}, "encoder": encoder.to_json(),
               "created_at": datetime.now(tz=timezone.utc).isoformat(), "format": ""}
    if name == "logreg":
        inner, scaler = model.named_steps["clf"], model.named_steps["scaler"]
        payload.update({"format": "logreg-json", "coef": inner.coef_.tolist(), "intercept": inner.intercept_.tolist(),
                        "classes": [int(c) for c in inner.classes_], "scaler_mean": scaler.mean_.tolist(),
                        "scaler_scale": scaler.scale_.tolist()})
    elif name == "lightgbm":
        payload.update({"format": "lightgbm-text", "model_text": model.booster_.model_to_string(),
                        "classes": [int(c) for c in model.classes_]})
    elif name == "xgboost":
        raw = model.get_booster().save_raw("json")
        payload.update({"format": "xgboost-json-b64", "model_b64": base64.b64encode(bytes(raw)).decode("ascii"),
                        "classes": [int(c) for c in model.classes_]})
    else:
        raise ValueError("unknown model " + name)
    return payload


def confusion(y_true, y_pred):
    m = np.zeros((3, 3), dtype=int)
    for t, p in zip(y_true, y_pred):
        m[int(t), int(p)] += 1
    return m


def sign_of(int_label):
    return SIGN.get(INT_TO_LABEL[int(int_label)], 0)


def metric_block(rows, y_true, y_pred, probs=None):
    y_true, y_pred = np.asarray(y_true), np.asarray(y_pred)
    n = len(y_true)
    out = {"samples": int(n)}
    if n == 0:
        return out
    cm = confusion(y_true, y_pred)
    recalls, precisions, f1s, per_class = [], [], [], {}
    for idx, label in enumerate(LABELS):
        tp = cm[idx, idx]
        fn = cm[idx, :].sum() - tp
        fp = cm[:, idx].sum() - tp
        rec = float(tp / (tp + fn)) if (tp + fn) > 0 else None
        prec = float(tp / (tp + fp)) if (tp + fp) > 0 else None
        f1 = float(2 * prec * rec / (prec + rec)) if (prec and rec) else (0.0 if (prec is not None and rec is not None) else None)
        per_class[label.lower()] = {"precision": prec, "recall": rec, "support": int(cm[idx, :].sum())}
        if rec is not None:
            recalls.append(rec)
        if prec is not None:
            precisions.append(prec)
        if f1 is not None:
            f1s.append(f1)
    out.update({"accuracy": float((y_true == y_pred).mean()),
                "balanced_accuracy": float(np.mean(recalls)) if recalls else None,
                "macro_precision": float(np.mean(precisions)) if precisions else None,
                "macro_recall": float(np.mean(recalls)) if recalls else None,
                "macro_f1": float(np.mean(f1s)) if f1s else None,
                "confusion_matrix": cm.tolist(), "per_class": per_class})
    returns, dir_returns, mfes, maes = [], [], [], []
    dir_mfes, dir_maes = [], []
    for r, p in zip(rows, y_pred):
        label = INT_TO_LABEL[int(p)]
        sign, ret = SIGN.get(label, 0), r.get("_ret")
        if ret is not None:
            returns.append(ret)
            dir_returns.append(sign * ret)
        if r.get("_mfe") is not None:
            mfes.append(r["_mfe"])
        if r.get("_mae") is not None:
            maes.append(r["_mae"])
        # 按"模型预测方向"计算的 MFE/MAE(用真实未来高低点)
        hi, lo = r.get("_high_pct"), r.get("_low_pct")
        if hi is not None and lo is not None and label in ("Bullish", "Bearish"):
            if label == "Bullish":
                dir_mfes.append(hi)
                dir_maes.append(-lo)
            else:
                dir_mfes.append(-lo)
                dir_maes.append(hi)
    out.update({"avg_return": float(np.mean(returns)) if returns else None,
                "avg_directional_return": float(np.mean(dir_returns)) if dir_returns else None,
                "median_directional_return": float(np.median(dir_returns)) if dir_returns else None,
                "avg_mfe": float(np.mean(mfes)) if mfes else None,
                "avg_mae": float(np.mean(maes)) if maes else None,
                "directional_mfe": float(np.mean(dir_mfes)) if dir_mfes else None,
                "directional_mae": float(np.mean(dir_maes)) if dir_maes else None,
                "directional_samples": int(len(dir_mfes))})
    if probs is not None and len(probs):
        p = np.asarray(probs)
        maxp = np.max(p, axis=1)
        out["prob_sum_max_dev"] = float(np.max(np.abs(p.sum(axis=1) - 1.0)))
        out["avg_confidence"] = float(maxp.mean())
        conf_stats = {}
        for label, thr in [(">=0.5", 0.5), (">=0.6", 0.6), (">=0.7", 0.7), (">=0.8", 0.8)]:
            idx = np.where(maxp >= thr)[0]
            if len(idx) == 0:
                continue
            sub_ret = [sign_of(y_pred[i]) * rows[i]["_ret"] for i in idx if rows[i].get("_ret") is not None]
            conf_stats[label] = {"samples": int(len(idx)), "accuracy": float((y_true[idx] == y_pred[idx]).mean()),
                                 "avg_directional_return": float(np.mean(sub_ret)) if sub_ret else None}
        out["by_confidence"] = conf_stats
    return out


def brier(y_true, probs):
    p = np.asarray(probs)
    onehot = np.zeros_like(p)
    onehot[np.arange(len(y_true)), np.asarray(y_true)] = 1.0
    return float(((p - onehot) ** 2).sum(axis=1).mean())


def build_model(name, params=None):
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler
    if name == "logreg":
        return Pipeline([("scaler", StandardScaler()),
                         ("clf", LogisticRegression(max_iter=2000, C=1.0, class_weight="balanced", random_state=42))])
    if name == "lightgbm":
        from lightgbm import LGBMClassifier
        p = {"n_estimators": 120, "num_leaves": 15, "learning_rate": 0.05, "min_child_samples": 30,
             "subsample": 0.9, "subsample_freq": 1, "colsample_bytree": 0.9, "reg_lambda": 1.0,
             "class_weight": "balanced", "random_state": 42, "verbose": -1}
        p.update(params or {})
        return LGBMClassifier(**p)
    if name == "xgboost":
        from xgboost import XGBClassifier
        p = {"n_estimators": 120, "max_depth": 4, "learning_rate": 0.05, "min_child_weight": 5,
             "subsample": 0.9, "colsample_bytree": 0.9, "reg_lambda": 1.0, "random_state": 42,
             "tree_method": "hist", "verbosity": 0, "objective": "multi:softprob"}
        p.update(params or {})
        return XGBClassifier(**p)
    raise ValueError("unknown model " + name)


def param_grid(name):
    if name == "lightgbm":
        return [{"num_leaves": 7, "n_estimators": 60}, {"num_leaves": 15, "n_estimators": 120}, {"num_leaves": 31, "n_estimators": 200}]
    if name == "xgboost":
        return [{"max_depth": 3, "n_estimators": 60}, {"max_depth": 4, "n_estimators": 120}, {"max_depth": 6, "n_estimators": 200}]
    return [{}]


def select_params(name, X_train, y_train, inner_ratio=0.2):
    """只在 Train 末尾一段做内部验证选参"""
    n = len(y_train)
    cut = int(n * (1 - inner_ratio))
    result = {"selected": {}, "inner_val_rows": 0, "inner_val_accuracy": None, "candidates": []}
    if cut < 20 or n - cut < 10:
        return result
    from sklearn.metrics import accuracy_score
    Xa, ya, Xb, yb = X_train[:cut], y_train[:cut], X_train[cut:], y_train[cut:]
    best = None
    for cand in param_grid(name):
        try:
            m = build_model(name, cand)
            m.fit(Xa, ya)
            acc = float(accuracy_score(yb, m.predict(Xb)))
        except Exception:
            continue
        result["candidates"].append({"params": cand, "inner_accuracy": acc})
        if best is None or acc > best[1]:
            best = (cand, acc)
    if best is not None:
        result["selected"] = best[0]
        result["inner_val_accuracy"] = best[1]
        result["inner_val_rows"] = int(len(yb))
    return result


def feature_importance(model, names, top=15):
    try:
        inner = model.named_steps["clf"] if hasattr(model, "named_steps") else model
        if hasattr(inner, "booster_"):
            try:
                gain = np.asarray(inner.booster_.feature_importance(importance_type="gain"), dtype=float)
            except Exception:
                gain = np.asarray(inner.booster_.feature_importance(), dtype=float)
        elif hasattr(inner, "feature_importances_"):
            gain = np.asarray(inner.feature_importances_, dtype=float)
        elif hasattr(inner, "coef_"):
            gain = np.abs(np.asarray(inner.coef_)).mean(axis=0)
        else:
            return []
        return [[n, round(float(g), 4)] for n, g in sorted(zip(names, gain.tolist()), key=lambda x: -x[1])[:top]]
    except Exception:
        return []


def permutation_importance_top(model, X, y, names, seed=42, top=10):
    if len(y) < 30:
        return []
    try:
        from sklearn.inspection import permutation_importance
        r = permutation_importance(model, X, y, n_repeats=5, random_state=seed, scoring="accuracy")
        return [[n, round(float(v), 5)] for n, v in sorted(zip(names, r.importances_mean.tolist()), key=lambda x: -x[1])[:top]]
    except Exception:
        return []


def run_training(rows_all, columns, meta, options):
    """纯计算:返回 report / artifacts / predictions 三个可序列化对象"""
    horizons = options["horizons"]
    models = options["models"]
    args = options
    train_ms = int(args["train_days"] * 86400000)
    test_ms = int(args["test_days"] * 86400000)
    artifacts, predictions = {}, {}
    report = {
        "generated_at": datetime.now(tz=timezone.utc).isoformat(),
        "dataset": {"rows": len(rows_all), "columns": len(columns), "source": meta.get("source"),
                    "engine_version": meta.get("engine_version"), "feature_version": meta.get("feature_version"),
                    "kind": "synthetic_fixture" if args.get("synthetic") else "app_export"},
        "config": {"horizons": horizons, "models": models, "train_days": args["train_days"], "test_days": args["test_days"],
                   "split": "walk_forward_time_ordered", "random_split": False, "shuffle": False, "seed": 42,
                   "min_samples_required": args.get("min_samples", 100)},
        "feature_policy": {"excluded_rule_outputs": sorted(RULE_OUTPUT_COLUMNS), "excluded_ids": sorted(ID_COLUMNS),
                           "categorical_onehot": CATEGORICAL_COLUMNS,
                           "note": "特征只来自信号时保存的 Feature Snapshot;Scaler/One-Hot/缺失填充/校准/选参只在 Train 拟合"},
        "model_versions": [],
        "horizons": {},
    }

    for horizon in horizons:
        key = hkey(horizon)
        rows, clean_stats = clean_rows(rows_all, horizon)
        for r in rows:
            r["_ret"] = r.get(f"{key}_return")
            r["_mfe"] = r.get(f"{key}_mfe")
            r["_mae"] = r.get(f"{key}_mae")
            r["_high_pct"] = r.get(f"{key}_high_pct")
            r["_low_pct"] = r.get(f"{key}_low_pct")
            r["_label"] = r.get(f"{key}_outcome")
            r["_rule"] = r.get("direction")
        times = [float(r["timestamp"]) for r in rows]
        samples = {"total_rows": len(rows_all), "labeled": len(rows),
                   "pending_excluded": clean_stats["pending_excluded"], "duplicate_removed": clean_stats["duplicate_removed"],
                   "invalid_label_rows": clean_stats["invalid_label"],
                   "class_counts": {label: int(sum(1 for r in rows if r["_label"] == label)) for label in LABELS},
                   "symbols": sorted({r.get("symbol") for r in rows}), "sources": sorted({str(r.get("source")) for r in rows}),
                   "min_samples_required": args.get("min_samples", 100),
                   "eligible_for_comparison": bool(len(rows) >= args.get("min_samples", 100)),
                   "sample_note": "样本充足(>300)" if len(rows) > 300 else ("样本较少(100-300)" if len(rows) >= 100 else "样本不足(<100)")}
        block = {"samples": samples, "folds": [], "summary": {}, "feature_importance": {}, "permutation_importance": {},
                 "by_regime": {}, "by_symbol": {}, "overfit_check": {}, "calibration_compare": {}}
        numeric_cols = numeric_feature_columns(columns, rows)
        block["feature_columns"] = numeric_cols + [f"{c}=*" for c in CATEGORICAL_COLUMNS]
        folds = make_folds(min(times), max(times), train_ms, test_ms) if rows else []
        block["folds_planned"] = len(folds)

        pooled = {m: {"y": [], "p": [], "probs": [], "rows": []} for m in models}
        pooled_rule = {"y": [], "p": [], "rows": []}
        cal = {m: {"raw": [], "cal": []} for m in models}
        overfit = {m: {"train": [], "test": []} for m in models}
        imp_gain = {m: [] for m in models if m in ("lightgbm", "xgboost")}
        imp_perm = {m: [] for m in models if m in ("lightgbm", "xgboost")}

        for fold in folds:
            train_rows = [r for r in rows if fold["train_start"] <= float(r["timestamp"]) <= fold["train_end"]]
            test_rows = [r for r in rows if fold["test_start"] <= float(r["timestamp"]) <= fold["test_end"]]
            if len(train_rows) < 40 or len(test_rows) < 10:
                continue
            enc = Encoder(numeric_cols, CATEGORICAL_COLUMNS).fit(train_rows)
            X_train, X_test = enc.transform(train_rows), enc.transform(test_rows)
            y_train = np.array([LABEL_TO_INT[r["_label"]] for r in train_rows])
            y_test = np.array([LABEL_TO_INT[r["_label"]] for r in test_rows])
            fold_block = {"fold_id": fold["fold_id"], "train_start": int(fold["train_start"]), "train_end": int(fold["train_end"]),
                          "test_start": int(fold["test_start"]), "test_end": int(fold["test_end"]),
                          "train_samples": len(train_rows), "test_samples": len(test_rows),
                          "train_end_before_test_start": bool(fold["train_end"] < fold["test_start"]),
                          "encoder_fit_rows": enc.fit_rows,
                          "scaler_leak_check": {"train_numeric_medians": {k: round(v, 6) for k, v in list(enc.medians.items())[:40]},
                                                "note": "中位数/StandardScaler 只由 Train 拟合"},
                          "models": {}}
            rule_pred = np.array([LABEL_TO_INT.get(r["_rule"], 1) for r in test_rows])
            fold_block["models"]["rule"] = metric_block(test_rows, y_test, rule_pred)
            pooled_rule["y"].extend(y_test.tolist())
            pooled_rule["p"].extend(rule_pred.tolist())
            pooled_rule["rows"].extend(test_rows)

            for name in models:
                try:
                    sel = select_params(name, X_train, y_train)
                    model = build_model(name, sel.get("selected") or None)
                    # 类别不平衡:XGBoost 用 Train 类别频率计算样本权重(只用 Train,不复制样本)
                    fit_kwargs = {}
                    if name == "xgboost":
                        counts = np.bincount(y_train, minlength=3).astype(float)
                        counts[counts == 0] = 1.0
                        fit_kwargs["sample_weight"] = (len(y_train) / (3.0 * counts))[y_train]
                    t0 = time.time()
                    model.fit(X_train, y_train, **fit_kwargs)
                    fit_seconds = time.time() - t0
                    proba = np.asarray(model.predict_proba(X_test))
                    pred = np.asarray(model.predict(X_test))
                    metrics = metric_block(test_rows, y_test, pred, proba)
                    metrics["train_accuracy"] = float((np.asarray(model.predict(X_train)) == y_train).mean())
                    metrics["select_params"] = sel
                    metrics["brier"] = brier(y_test, proba)
                    metrics["fit_seconds"] = round(fit_seconds, 3)
                    try:
                        from sklearn.calibration import CalibratedClassifierCV
                        cal_model = CalibratedClassifierCV(build_model(name, sel.get("selected") or None), method="sigmoid", cv=3)
                        cal_model.fit(X_train, y_train)
                        cproba = np.asarray(cal_model.predict_proba(X_test))
                        cal_metrics = metric_block(test_rows, y_test, np.asarray(cal_model.predict(X_test)), cproba)
                        cal_metrics["brier"] = brier(y_test, cproba)
                        metrics["calibrated"] = cal_metrics
                        cal[name]["raw"].append(brier(y_test, proba))
                        cal[name]["cal"].append(brier(y_test, cproba))
                    except Exception as exc:
                        metrics["calibrated"] = {"error": str(exc)}
                    key_art = f"{name}|{horizon}|{fold['fold_id']}"
                    payload = artifact_payload(name, horizon, model, enc, sel.get("selected") or {})
                    roundtrip = ReloadedModel(json.loads(json.dumps(payload)))
                    reload_diff = float(np.max(np.abs(roundtrip.predict_proba(X_test) - proba)))
                    artifacts[key_art] = payload
                    metrics["artifact_key"] = key_art
                    metrics["artifact_format"] = payload["format"]
                    metrics["reload_max_prob_diff"] = reload_diff
                    metrics["reload_consistent"] = bool(reload_diff < 1e-6)
                    fold_block["models"][name] = metrics
                    pooled[name]["y"].extend(y_test.tolist())
                    pooled[name]["p"].extend(pred.tolist())
                    pooled[name]["probs"].extend(proba.tolist())
                    pooled[name]["rows"].extend(test_rows)
                    overfit[name]["train"].append(metrics["train_accuracy"])
                    overfit[name]["test"].append(metrics["accuracy"])
                    if name in imp_gain:
                        imp = feature_importance(model, enc.columns)
                        if imp:
                            imp_gain[name].append(imp)
                        pi = permutation_importance_top(model, X_test, y_test, enc.columns)
                        if pi:
                            imp_perm[name].append(pi)
                except Exception as exc:
                    fold_block["models"][name] = {"error": str(exc)}
            block["folds"].append(fold_block)

        block["summary"]["rule"] = metric_block(pooled_rule["rows"], pooled_rule["y"], pooled_rule["p"])
        for name in models:
            if pooled[name]["rows"]:
                block["summary"][name] = metric_block(pooled[name]["rows"], pooled[name]["y"], pooled[name]["p"], pooled[name]["probs"])
        for name in models:
            tr, te = overfit[name]["train"], overfit[name]["test"]
            if not tr:
                continue
            gap = float(np.mean(tr) - np.mean(te))
            block["overfit_check"][name] = {"avg_train_accuracy": float(np.mean(tr)), "avg_test_accuracy": float(np.mean(te)),
                                            "gap": gap, "risk": bool(gap > args.get("overfit_gap", 0.15)),
                                            "per_fold": [{"fold_id": i, "train": tr[i], "test": te[i]} for i in range(len(tr))]}
            raw, c = cal[name]["raw"], cal[name]["cal"]
            if raw:
                block["calibration_compare"][name] = {"raw_brier": float(np.mean(raw)), "calibrated_brier": float(np.mean(c)),
                                                      "improved": bool(np.mean(c) < np.mean(raw)),
                                                      "note": "Platt(sigmoid),只在 Train 上拟合;若不改善则不应采用"}
        for name in list(imp_gain):
            if imp_gain[name]:
                agg = {}
                for fold_imp in imp_gain[name]:
                    for feat, val in fold_imp:
                        agg[feat] = agg.get(feat, 0.0) + float(val) / len(imp_gain[name])
                block["feature_importance"][name] = sorted(agg.items(), key=lambda kv: -kv[1])[:args.get("top_features", 15)]
            if imp_perm[name]:
                agg = {}
                for fold_imp in imp_perm[name]:
                    for feat, val in fold_imp:
                        agg[feat] = agg.get(feat, 0.0) + float(val) / len(imp_perm[name])
                block["permutation_importance"][name] = sorted([[k, round(v, 5)] for k, v in agg.items()], key=lambda kv: -kv[1])[:args.get("top_features", 15)]
        for name in models:
            if not pooled[name]["rows"]:
                continue
            for group_key, target in (("market_regime", "by_regime"), ("symbol", "by_symbol")):
                groups = {}
                for r, yt, yp in zip(pooled[name]["rows"], pooled[name]["y"], pooled[name]["p"]):
                    groups.setdefault(str(r.get(group_key) or "未知"), []).append((r, yt, yp))
                block[target][name] = [{"key": k, **metric_block([x[0] for x in v], [x[1] for x in v], [x[2] for x in v])}
                                       for k, v in sorted(groups.items())]
        for name in models:
            rows_out = []
            for r, yt, yp, pr in zip(pooled[name]["rows"], pooled[name]["y"], pooled[name]["p"], pooled[name]["probs"]):
                rows_out.append({"model_name": name, "model_version": MODEL_VERSIONS[name], "horizon": horizon,
                                 "symbol": r.get("symbol"), "timestamp": int(float(r.get("timestamp"))),
                                 "predicted_class": INT_TO_LABEL[int(yp)], "rule_direction": r.get("_rule"),
                                 "probability_bearish": round(float(pr[0]), 6), "probability_neutral": round(float(pr[1]), 6),
                                 "probability_bullish": round(float(pr[2]), 6), "confidence": round(float(max(pr)), 6),
                                 "actual_class": INT_TO_LABEL[int(yt)]})
            predictions[f"{name}|{horizon}"] = rows_out
        block["predictions_count"] = {m: len(predictions.get(f"{m}|{horizon}", [])) for m in models}
        report["horizons"][horizon] = block
        print(f"[{horizon}] labeled={len(rows)} folds={len(block['folds'])} models={','.join(models)}", file=sys.stderr, flush=True)

    for name in ["rule"] + models:
        report["model_versions"].append({"model_name": name, "model_version": MODEL_VERSIONS.get(name, name + "-v0.1"),
                                         "feature_version": meta.get("feature_version"), "engine_version": meta.get("engine_version"),
                                         "horizons": horizons, "created_at": report["generated_at"],
                                         "note": "Rule Engine 为基准;ML 为独立旁路结果层,不覆盖原 Signal"})
    return report, artifacts, predictions
