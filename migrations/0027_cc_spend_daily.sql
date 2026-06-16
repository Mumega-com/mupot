-- Squad Anthropic spend (issue #179): the REAL Claude Code token spend of the squad,
-- pushed in from the server-side transcript rollup. This is SEPARATE from the
-- internal burn gauge (meter_cost / cost.ts), which estimates the pot's OWN agents.
-- This table is EXTERNAL truth: actual per-turn usage from ~/.claude transcripts,
-- priced at real Anthropic list rates (input/output/cache-write/cache-read).
--
-- One row per (date, agent, model_family). Ingest UPSERTs: the rollup is a FULL
-- recompute (not a delta), so re-pushing a day idempotently replaces its figure.
-- A freshness guard (updated_at monotonic) stops an out-of-order stale push from
-- regressing a day's already-higher total.
CREATE TABLE IF NOT EXISTS cc_spend_daily (
  date               TEXT    NOT NULL,           -- YYYY-MM-DD (UTC)
  agent              TEXT    NOT NULL,           -- squad agent (kasra, codex, …) or 'unknown'
  model_family       TEXT    NOT NULL,           -- opus | sonnet | haiku | other
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  usd_micro          INTEGER NOT NULL DEFAULT 0, -- real Anthropic list-price cost, micro-USD
  turns              INTEGER NOT NULL DEFAULT 0, -- assistant turns priced (provenance)
  updated_at         TEXT    NOT NULL,           -- ISO-8601 generated_at of the winning push
  PRIMARY KEY (date, agent, model_family)
);

CREATE INDEX IF NOT EXISTS idx_cc_spend_date ON cc_spend_daily(date);
