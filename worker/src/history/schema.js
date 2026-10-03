// history/schema.js · V10 历史信号表结构(+ SQLite DDL)
// 单一事实来源:浏览器端(IndexedDB)与 Node/SQLite 端共用同一份表/索引定义
// 表: signals / signal_outcomes / backtest_runs / backtest_results / model_versions / system_settings

export const SCHEMA_VERSION = "v14.0";

// 结果验证周期(信号产生后的检查点)
export const HORIZONS = ["5m", "15m", "1h", "4h", "24h"];
export const HORIZON_MS = {
  "5m": 300000,
  "15m": 900000,
  "1h": 3600000,
  "4h": 14400000,
  "24h": 86400000
};
export const HORIZON_ZH = { "5m": "5分钟", "15m": "15分钟", "1h": "1小时", "4h": "4小时", "24h": "24小时" };

// ---- 表定义(浏览器端按此建 IndexedDB objectStore;Node 端按 SCHEMA_DDL 建 SQLite 表) ----
export const SIGNAL_TABLE = {
  name: "signals",
  key: "id",
  columns: [
    "id", "symbol", "interval", "timestamp", "price", "change24h",
    "market_regime_label", "market_regime_trend_market", "market_regime_vol_state", "market_regime_adx", "market_regime_atr_pct",
    "direction", "signal_strength", "confidence", "risk_score", "risk_level",
    "timeframes", "structure_label", "structure_hh", "structure_hl", "structure_lh", "structure_ll",
    "structure_last_swing_high", "structure_last_swing_low",
    "support_zones", "resistance_zones",
    "volume_ratio20", "volume_spike", "volume_pattern", "volatility_level", "volatility_atr_pct", "volatility_ratio",
    "btc_state", "btc_corr", "btc_rel_strength",
    "breadth_up_pct", "breadth_sample",
    "tf_conflict", "anomaly_detected", "anomaly_kinds",
    "features", "reasons", "risks", "invalidation",
    "engine_version", "feature_version", "data_close_time", "is_candle_closed", "limited_data",
    "forming_candle_count", "source", "backtest_run_id", "created_at"
  ],
  jsonColumns: ["timeframes", "support_zones", "resistance_zones", "features", "reasons", "risks", "invalidation", "anomaly_kinds"],
  indexes: [
    { name: "symbol", key: "symbol" },
    { name: "timestamp", key: "timestamp" },
    { name: "engine_version", key: "engine_version" },
    { name: "market_regime_label", key: "market_regime_label" },
    { name: "confidence", key: "confidence" },
    { name: "direction", key: "direction" },
    { name: "source", key: "source" },
    { name: "backtest_run_id", key: "backtest_run_id" },
    { name: "symbol_timestamp", key: ["symbol", "timestamp"] }
  ]
};

export const SIGNAL_OUTCOME_TABLE = {
  name: "signal_outcomes",
  key: "signal_id",
  columns: [
    "signal_id", "symbol", "direction", "signal_timestamp", "signal_price",
    "horizons_resolved", "resolved_count",
    "price_5m", "return_5m", "outcome_5m", "mfe_5m", "mae_5m", "high_5m", "low_5m", "threshold_5m", "resolved_at_5m",
    "price_15m", "return_15m", "outcome_15m", "mfe_15m", "mae_15m", "high_15m", "low_15m", "threshold_15m", "resolved_at_15m",
    "price_1h", "return_1h", "outcome_1h", "mfe_1h", "mae_1h", "high_1h", "low_1h", "threshold_1h", "resolved_at_1h",
    "price_4h", "return_4h", "outcome_4h", "mfe_4h", "mae_4h", "high_4h", "low_4h", "threshold_4h", "resolved_at_4h",
    "price_24h", "return_24h", "outcome_24h", "mfe_24h", "mae_24h", "high_24h", "low_24h", "threshold_24h", "resolved_at_24h",
    "updated_at"
  ],
  jsonColumns: [],
  indexes: [
    { name: "symbol", key: "symbol" },
    { name: "signal_timestamp", key: "signal_timestamp" },
    { name: "outcome_1h", key: "outcome_1h" },
    { name: "resolved_count", key: "resolved_count" }
  ]
};

export const BACKTEST_RUN_TABLE = {
  name: "backtest_runs",
  key: "id",
  columns: ["id", "name", "symbols", "interval", "timeframes", "started_at", "finished_at", "status", "total_signals", "resolved_signals", "note", "engine_version"],
  jsonColumns: ["symbols", "timeframes"],
  indexes: [
    { name: "started_at", key: "started_at" },
    { name: "status", key: "status" }
  ]
};

export const BACKTEST_RESULT_TABLE = {
  name: "backtest_results",
  key: "id",
  columns: ["id", "run_id", "symbol", "horizon", "samples", "resolved", "accuracy", "bull_accuracy", "bear_accuracy", "neutral_rate", "avg_return", "median_return", "avg_mfe", "avg_mae", "created_at"],
  jsonColumns: [],
  indexes: [
    { name: "run_id", key: "run_id" },
    { name: "symbol", key: "symbol" }
  ]
};

export const MODEL_VERSION_TABLE = {
  name: "model_versions",
  key: "id",
  columns: ["id", "version", "engine_version", "feature_version", "description", "params", "created_at"],
  jsonColumns: ["params"],
  indexes: [{ name: "version", key: "version" }]
};

export const SYSTEM_SETTINGS_TABLE = {
  name: "system_settings",
  key: "key",
  columns: ["key", "value", "updated_at"],
  jsonColumns: ["value"],
  indexes: []
};

// Walk Forward:TRAIN 窗口(过去) → TEST 窗口(完全未来) → 向前滚动
export const WALKFORWARD_RUN_TABLE = {
  name: "walkforward_runs",
  key: "id",
  columns: ["id", "symbol", "interval", "bars", "train_ms", "test_ms", "folds", "started_at", "finished_at", "status", "total_signals", "note", "engine_version", "best_regime", "worst_regime"],
  jsonColumns: [],
  indexes: [
    { name: "symbol", key: "symbol" },
    { name: "started_at", key: "started_at" },
    { name: "status", key: "status" }
  ]
};

export const WALKFORWARD_FOLD_TABLE = {
  name: "walkforward_folds",
  key: "id",
  columns: [
    "id", "run_id", "fold_id", "symbol", "interval", "engine_version",
    "train_start", "train_end", "test_start", "test_end",
    "train_sample_count", "test_sample_count", "test_resolved",
    "directional_accuracy", "neutral_rate", "avg_return", "median_return", "avg_mfe", "avg_mae",
    "train_accuracy", "selected_min_confidence", "test_selected_accuracy", "test_selected_samples",
    "confidence_calibration", "quality", "created_at"
  ],
  jsonColumns: ["confidence_calibration"],
  indexes: [
    { name: "run_id", key: "run_id" },
    { name: "symbol", key: "symbol" },
    { name: "test_start", key: "test_start" }
  ]
};

// ---- V14 Paper Trading / 持续学习 表 ----
export const PAPER_ACCOUNT_TABLE = {
  name: "paper_account", key: "account_id",
  columns: ["account_id", "initial_balance", "cash_balance", "reserved_balance", "realized_pnl", "unrealized_pnl", "total_equity", "fees_paid", "peak_equity", "max_drawdown_pct", "created_at", "updated_at", "schema_version"],
  jsonColumns: [], indexes: [{ name: "updated_at", key: "updated_at" }]
};
export const PAPER_WALLET_TABLE = {
  name: "paper_wallets", key: "wallet_id",
  columns: ["wallet_id", "account_id", "mode", "allocated_balance", "available_balance", "reserved_balance", "realized_pnl", "unrealized_pnl", "updated_at"],
  jsonColumns: [], indexes: [{ name: "mode", key: "mode" }]
};
export const PAPER_ORDER_TABLE = {
  name: "paper_orders", key: "order_id",
  columns: ["order_id", "account_id", "mode", "symbol", "side", "status", "quantity", "reference_price", "fill_price", "slippage_pct", "fee", "notional", "created_at", "filled_at", "reason", "signal_id", "decision_id", "engine_version", "model_version", "idempotency_key", "reject_reason"],
  jsonColumns: [], indexes: [{ name: "idempotency_key", key: "idempotency_key" }, { name: "symbol_time", key: ["symbol", "created_at"] }, { name: "status", key: "status" }]
};
export const PAPER_POSITION_TABLE = {
  name: "paper_positions", key: "position_id",
  columns: ["position_id", "account_id", "mode", "symbol", "side", "status", "quantity", "entry_price", "entry_notional", "current_price", "entry_time", "exit_price", "exit_time", "realized_pnl", "unrealized_pnl", "fees", "net_pnl", "mfe", "mae", "stop_price", "take_profit_price", "max_hold_ms", "invalidation", "exit_reason", "engine_version", "model_version", "decision_id", "signal_id", "recovered_after_offline"],
  jsonColumns: ["invalidation"], indexes: [{ name: "status_mode", key: ["status", "mode"] }, { name: "symbol", key: "symbol" }, { name: "entry_time", key: "entry_time" }]
};
export const PAPER_TRADE_TABLE = {
  name: "paper_trades", key: "trade_id",
  columns: ["trade_id", "account_id", "mode", "symbol", "side", "quantity", "entry_price", "exit_price", "entry_time", "exit_time", "gross_pnl", "fees", "net_pnl", "return_pct", "mfe", "mae", "holding_ms", "exit_reason", "engine_version", "model_version", "decision_id", "learning_sample_id", "created_at"],
  jsonColumns: [], indexes: [{ name: "exit_time", key: "exit_time" }, { name: "mode", key: "mode" }, { name: "symbol", key: "symbol" }]
};
export const PAPER_EQUITY_TABLE = {
  name: "paper_equity_snapshots", key: "snapshot_id",
  columns: ["snapshot_id", "account_id", "at", "total_equity", "cash_balance", "realized_pnl", "unrealized_pnl", "open_positions", "mode_short_equity", "mode_long_equity"],
  jsonColumns: [], indexes: [{ name: "at", key: "at" }]
};
export const PAPER_ENGINE_STATE_TABLE = {
  name: "paper_engine_state", key: "id",
  columns: ["id", "state", "started_at", "paused_at", "last_loop_at", "last_candle_time", "loops", "errors", "last_error", "token_used_today", "token_day", "schema_version", "note"],
  jsonColumns: [], indexes: []
};
export const PAPER_DAILY_STATS_TABLE = {
  name: "paper_daily_stats", key: "day_key",
  columns: ["day_key", "trades", "wins", "losses", "gross_pnl", "fees", "net_pnl", "max_drawdown_pct", "equity_end", "updated_at"],
  jsonColumns: [], indexes: []
};
export const PAPER_STRATEGY_STATS_TABLE = {
  name: "paper_strategy_stats", key: "key",
  columns: ["key", "mode", "symbol", "trades", "wins", "losses", "net_pnl", "gross_pnl", "fees", "avg_net_pnl", "avg_mfe", "avg_mae", "avg_holding_ms", "max_consecutive_losses", "last_result", "updated_at"],
  jsonColumns: [], indexes: [{ name: "mode", key: "mode" }]
};
export const LEARNING_SAMPLE_TABLE = {
  name: "learning_samples", key: "sample_id",
  columns: ["sample_id", "account_id", "mode", "symbol", "interval", "entry_time", "exit_time", "features", "rule_result", "ml_result", "bull_score", "bear_score", "risk_score", "risk_flags", "deepseek_review", "final_decision", "market_regime", "btc_context", "entry_price", "exit_price", "fees", "gross_pnl", "net_pnl", "mfe", "mae", "holding_ms", "outcome_label", "engine_version", "model_version", "created_at"],
  jsonColumns: ["features", "rule_result", "ml_result", "risk_flags", "deepseek_review", "final_decision", "btc_context"],
  indexes: [{ name: "mode", key: "mode" }, { name: "exit_time", key: "exit_time" }, { name: "outcome_label", key: "outcome_label" }]
};
export const MODEL_REGISTRY_TABLE = {
  name: "model_registry", key: "model_id",
  columns: ["model_id", "model_type", "version", "feature_version", "engine_version", "horizons", "training_start", "training_end", "train_samples", "validation_samples", "metrics", "status", "parent_version", "created_at", "promoted_at", "retired_at", "note"],
  jsonColumns: ["horizons", "metrics"], indexes: [{ name: "status", key: "status" }, { name: "type_version", key: ["model_type", "version"] }]
};
export const MODEL_EVALUATION_TABLE = {
  name: "model_evaluations", key: "evaluation_id",
  columns: ["evaluation_id", "model_id", "evaluated_at", "kind", "samples", "balanced_accuracy", "macro_f1", "bull_recall", "bear_recall", "net_pnl_proxy", "max_drawdown_pct", "drift_score", "drift_detected", "per_regime", "verdict", "detail"],
  jsonColumns: ["per_regime", "detail"], indexes: [{ name: "model_id", key: "model_id" }, { name: "evaluated_at", key: "evaluated_at" }]
};
export const SYNC_QUEUE_TABLE = {
  name: "sync_queue", key: "item_id",
  columns: ["item_id", "entity", "entity_id", "payload", "sync_status", "attempts", "last_error", "revision", "device_id", "created_at", "updated_at"],
  jsonColumns: ["payload"], indexes: [{ name: "status", key: "sync_status" }, { name: "entity", key: "entity" }]
};

// ---- V14.4:未来预测 / 退出研究 / 研究想法 / 模型工件 ----
export const PREDICTION_TABLE = {
  name: "predictions", key: "prediction_id",
  columns: ["prediction_id", "timestamp", "prediction_timestamp", "symbol", "horizon", "group", "probabilities", "expected_move_pct", "expected_range_pct",
    "confidence", "uncertainty", "reversal_risk", "trend_persistence", "price_at_prediction", "feature_time", "external_context_snapshot",
    "model_version", "source", "resolved", "resolved_at", "actual_direction", "actual_return_pct", "actual_volatility_pct", "noise_threshold_pct",
    "predicted_class", "correct", "brier_score", "calibration_target", "created_at"],
  jsonColumns: ["probabilities", "external_context_snapshot"],
  indexes: [{ name: "symbol", key: "symbol" }, { name: "horizon", key: "horizon" }, { name: "resolved", key: "resolved" }, { name: "model_version", key: "model_version" }]
};
export const EXIT_SHADOW_TABLE = {
  name: "exit_shadow_samples", key: "sample_id",
  columns: ["sample_id", "symbol", "mode", "regime", "volatility", "leverage", "stage", "max_unrealized_pnl", "realised_pnl", "profit_locked",
    "profit_giveback", "profit_giveback_pct", "partial_close_sequence", "trailing_distance", "exit_policy", "future_prediction_at_exit", "risk_at_exit", "shadow", "created_at"],
  jsonColumns: ["partial_close_sequence", "future_prediction_at_exit"],
  indexes: [{ name: "symbol", key: "symbol" }, { name: "mode", key: "mode" }, { name: "shadow", key: "shadow" }]
};
export const RESEARCH_IDEA_TABLE = {
  name: "research_ideas", key: "idea_id",
  columns: ["idea_id", "source", "source_url", "hypothesis", "required_features", "proposed_rule", "status", "backtest_result", "walkforward_result",
    "paper_shadow_result", "formalized", "gate_reasons", "gate_eligible", "created_at", "updated_at", "note"],
  jsonColumns: ["required_features", "backtest_result", "walkforward_result", "paper_shadow_result", "gate_reasons"],
  indexes: [{ name: "status", key: "status" }, { name: "source", key: "source" }]
};
export const MODEL_ARTIFACT_TABLE = {
  name: "model_artifacts", key: "artifact_id",
  columns: ["artifact_id", "model_type", "version", "horizon", "format", "payload", "created_at"],
  jsonColumns: [], indexes: [{ name: "model_type", key: "model_type" }, { name: "version", key: "version" }]
};
// V14.5:Allocation 调整审计(§71:分配必须真正落账,且可追溯)
export const ALLOCATION_RECORD_TABLE = {
  name: "allocation_records", key: "record_id",
  columns: ["record_id", "type", "at", "moved", "from", "to", "short_pct", "long_pct", "reasons"],
  jsonColumns: ["reasons"], indexes: [{ name: "at", key: "at" }, { name: "type", key: "type" }]
};

// V15:通知历史持久化(刷新/重开 App 不再归零;为 Android SQLite 迁移准备)
export const PAPER_NOTIFICATION_TABLE = {
  name: "paper_notifications", key: "notification_id",
  columns: ["notification_id", "key", "kind", "title", "body", "symbol", "mode", "severity", "at", "read"],
  jsonColumns: [], indexes: [{ name: "at", key: "at" }, { name: "kind", key: "kind" }]
};

// V15 P0:UI → 后台运行时的命令邮箱(跨 WebView 的唯一通道:UI 写,P 运行时执行)
export const RUNTIME_COMMAND_TABLE = {
  name: "runtime_commands", key: "command_id",
  columns: ["command_id", "type", "payload", "status", "created_at", "executed_at", "result", "source"],
  jsonColumns: ["payload", "result"], indexes: [{ name: "status", key: "status" }, { name: "created_at", key: "created_at" }]
};

export const ALL_TABLES = [SIGNAL_TABLE, SIGNAL_OUTCOME_TABLE, BACKTEST_RUN_TABLE, BACKTEST_RESULT_TABLE, MODEL_VERSION_TABLE, SYSTEM_SETTINGS_TABLE, WALKFORWARD_RUN_TABLE, WALKFORWARD_FOLD_TABLE,
  PAPER_ACCOUNT_TABLE, PAPER_WALLET_TABLE, PAPER_ORDER_TABLE, PAPER_POSITION_TABLE, PAPER_TRADE_TABLE, PAPER_EQUITY_TABLE, PAPER_ENGINE_STATE_TABLE, PAPER_DAILY_STATS_TABLE, PAPER_STRATEGY_STATS_TABLE,
  LEARNING_SAMPLE_TABLE, MODEL_REGISTRY_TABLE, MODEL_EVALUATION_TABLE, SYNC_QUEUE_TABLE,
  PREDICTION_TABLE, EXIT_SHADOW_TABLE, RESEARCH_IDEA_TABLE, MODEL_ARTIFACT_TABLE, ALLOCATION_RECORD_TABLE, PAPER_NOTIFICATION_TABLE, RUNTIME_COMMAND_TABLE];

// ---- SQLite DDL(Node 端 tools/db.mjs 使用;浏览器端不使用) ----
export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  interval TEXT,
  timestamp INTEGER NOT NULL,
  price REAL,
  change24h REAL,
  market_regime_label TEXT,
  market_regime_trend_market INTEGER,
  market_regime_vol_state TEXT,
  market_regime_adx REAL,
  market_regime_atr_pct REAL,
  direction TEXT,
  signal_strength INTEGER,
  confidence INTEGER,
  risk_score INTEGER,
  risk_level TEXT,
  timeframes TEXT,
  structure_label TEXT,
  structure_hh INTEGER,
  structure_hl INTEGER,
  structure_lh INTEGER,
  structure_ll INTEGER,
  structure_last_swing_high REAL,
  structure_last_swing_low REAL,
  support_zones TEXT,
  resistance_zones TEXT,
  volume_ratio20 REAL,
  volume_spike INTEGER,
  volume_pattern TEXT,
  volatility_level TEXT,
  volatility_atr_pct REAL,
  volatility_ratio REAL,
  btc_state TEXT,
  btc_corr REAL,
  btc_rel_strength REAL,
  breadth_up_pct REAL,
  breadth_sample INTEGER,
  tf_conflict INTEGER,
  anomaly_detected INTEGER,
  anomaly_kinds TEXT,
  features TEXT,
  reasons TEXT,
  risks TEXT,
  invalidation TEXT,
  engine_version TEXT,
  feature_version TEXT,
  data_close_time INTEGER,
  is_candle_closed INTEGER,
  limited_data INTEGER,
  forming_candle_count INTEGER,
  source TEXT,
  backtest_run_id TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_signals_symbol_time ON signals (symbol, timestamp);
CREATE INDEX IF NOT EXISTS idx_signals_engine ON signals (engine_version);
CREATE INDEX IF NOT EXISTS idx_signals_regime ON signals (market_regime_label);
CREATE INDEX IF NOT EXISTS idx_signals_confidence ON signals (confidence);
CREATE INDEX IF NOT EXISTS idx_signals_direction ON signals (direction);
CREATE INDEX IF NOT EXISTS idx_signals_source ON signals (source, backtest_run_id);

CREATE TABLE IF NOT EXISTS signal_outcomes (
  signal_id TEXT PRIMARY KEY,
  symbol TEXT,
  direction TEXT,
  signal_timestamp INTEGER,
  signal_price REAL,
  horizons_resolved TEXT,
  resolved_count INTEGER,
  price_5m REAL, return_5m REAL, outcome_5m TEXT, mfe_5m REAL, mae_5m REAL, high_5m REAL, low_5m REAL, threshold_5m REAL, resolved_at_5m INTEGER,
  price_15m REAL, return_15m REAL, outcome_15m TEXT, mfe_15m REAL, mae_15m REAL, high_15m REAL, low_15m REAL, threshold_15m REAL, resolved_at_15m INTEGER,
  price_1h REAL, return_1h REAL, outcome_1h TEXT, mfe_1h REAL, mae_1h REAL, high_1h REAL, low_1h REAL, threshold_1h REAL, resolved_at_1h INTEGER,
  price_4h REAL, return_4h REAL, outcome_4h TEXT, mfe_4h REAL, mae_4h REAL, high_4h REAL, low_4h REAL, threshold_4h REAL, resolved_at_4h INTEGER,
  price_24h REAL, return_24h REAL, outcome_24h TEXT, mfe_24h REAL, mae_24h REAL, high_24h REAL, low_24h REAL, threshold_24h REAL, resolved_at_24h INTEGER,
  updated_at INTEGER,
  FOREIGN KEY (signal_id) REFERENCES signals(id)
);
CREATE INDEX IF NOT EXISTS idx_outcomes_symbol ON signal_outcomes (symbol);
CREATE INDEX IF NOT EXISTS idx_outcomes_time ON signal_outcomes (signal_timestamp);
CREATE INDEX IF NOT EXISTS idx_outcomes_result ON signal_outcomes (outcome_1h);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id TEXT PRIMARY KEY,
  name TEXT,
  symbols TEXT,
  interval TEXT,
  timeframes TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  status TEXT,
  total_signals INTEGER,
  resolved_signals INTEGER,
  note TEXT,
  engine_version TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_status ON backtest_runs (status);

CREATE TABLE IF NOT EXISTS backtest_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  symbol TEXT,
  horizon TEXT,
  samples INTEGER,
  resolved INTEGER,
  accuracy REAL,
  bull_accuracy REAL,
  bear_accuracy REAL,
  neutral_rate REAL,
  avg_return REAL,
  median_return REAL,
  avg_mfe REAL,
  avg_mae REAL,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_results_run ON backtest_results (run_id);
CREATE INDEX IF NOT EXISTS idx_results_symbol ON backtest_results (symbol);

CREATE TABLE IF NOT EXISTS model_versions (
  id TEXT PRIMARY KEY,
  version TEXT,
  engine_version TEXT,
  feature_version TEXT,
  description TEXT,
  params TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_model_version ON model_versions (version);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS walkforward_runs (
  id TEXT PRIMARY KEY,
  symbol TEXT,
  interval TEXT,
  bars INTEGER,
  train_ms INTEGER,
  test_ms INTEGER,
  folds INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  status TEXT,
  total_signals INTEGER,
  note TEXT,
  engine_version TEXT,
  best_regime TEXT,
  worst_regime TEXT
);
CREATE INDEX IF NOT EXISTS idx_wf_runs_symbol ON walkforward_runs (symbol, started_at);

CREATE TABLE IF NOT EXISTS walkforward_folds (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  fold_id INTEGER,
  symbol TEXT,
  interval TEXT,
  engine_version TEXT,
  train_start INTEGER,
  train_end INTEGER,
  test_start INTEGER,
  test_end INTEGER,
  train_sample_count INTEGER,
  test_sample_count INTEGER,
  test_resolved INTEGER,
  directional_accuracy REAL,
  neutral_rate REAL,
  avg_return REAL,
  median_return REAL,
  avg_mfe REAL,
  avg_mae REAL,
  train_accuracy REAL,
  selected_min_confidence INTEGER,
  test_selected_accuracy REAL,
  test_selected_samples INTEGER,
  confidence_calibration TEXT,
  quality TEXT,
  created_at INTEGER,
  FOREIGN KEY (run_id) REFERENCES walkforward_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_wf_folds_run ON walkforward_folds (run_id, fold_id);
CREATE INDEX IF NOT EXISTS idx_wf_folds_time ON walkforward_folds (test_start);
`;

export const FEATURE_VERSION = "feat-v0.1";
