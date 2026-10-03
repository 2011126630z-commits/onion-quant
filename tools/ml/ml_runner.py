#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
V13 ML Baseline runner:只通过 stdin/stdout 交换 JSON,不做任何文件读写与路径处理
输入(stdin): {"rows":[...], "columns":[...], "meta":{...}, "options":{...}}
输出(stdout): {"report":{...}, "artifacts":{...}, "predictions":{...}}
计算逻辑全部在 ml_core.py
"""
import json
import sys

import ml_core


def run_action(action, rows, columns, meta, options):
    """动作分发(向后兼容:未知/缺省动作 = 原有 V13 baseline 训练,行为不变)"""
    if action == "train_rf":
        # V16.1 追加:Random Forest Shadow/Challenger(纯计算在 rf_core.py)
        import rf_core
        return rf_core.train_random_forest(rows, columns, meta, options)
    return ml_core.run_training(rows, columns, meta, options)


def main():
    payload = json.load(sys.stdin)
    rows = payload.get("rows") or []
    columns = payload.get("columns") or []
    meta = payload.get("meta") or {}
    options = payload.get("options") or {}
    action = payload.get("action") or "train_baseline"
    if not rows or not columns:
        json.dump({"error": "empty dataset"}, sys.stdout)
        return 1
    report, artifacts, predictions = run_action(action, rows, columns, meta, options)
    json.dump({"report": report, "artifacts": artifacts, "predictions": predictions}, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
