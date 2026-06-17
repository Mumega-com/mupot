-- mupot — generic per-pot time-series spine (console-department-microkernel §4).
--
-- `metric_points` is the KERNEL-LEVEL ingest table. Every department module (Growth,
-- Finance, Ops, …) and every connector emits timestamped readings here. The console
-- candlestick + KPI rail read from this table; they have no direct dependency on any
-- specific department's tables. This is what makes the candle metric-selector a
-- function of active departments only (§4.3).
--
-- Design notes:
--   - `occurred_at` carries INTRADAY precision (ISO 8601 with time). This is the
--     invariant that makes OHLC honest: multiple readings per day → real distinct
--     O/H/L/C. A daily scalar (one reading/day) → O==H==L==C → the aggregation layer
--     signals 'bar', not 'candle' (§4.2, seriesShape).
--   - UNIQUE(tenant_id, metric_key, occurred_at, source) gives connector-level
--     idempotent ingest: re-pushing the same (metric, timestamp, source) is a no-op.
--   - `source` names the emitting connector or agent, not the department, so one
--     department can have multiple connector sources with disjoint timestamps.
--   - `tenant_id` is bound in EVERY SELECT — no query hits without it. Row-level
--     tenant isolation is enforced in the application layer (pulse.ts) and verified
--     by tests.

CREATE TABLE IF NOT EXISTS metric_points (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  metric_key  TEXT NOT NULL,         -- 'growth.leads' | 'finance.revenue' | 'ops.throughput' …
  value       REAL NOT NULL,
  occurred_at TEXT NOT NULL,         -- ISO 8601 with time component (intraday precision)
  source      TEXT NOT NULL,         -- connector | brain | manual | <named-connector>
  created_at  TEXT NOT NULL,
  UNIQUE(tenant_id, metric_key, occurred_at, source)
);

CREATE INDEX IF NOT EXISTS idx_metric_points_series
  ON metric_points (tenant_id, metric_key, occurred_at);
