-- 0076_provider_cost_receipts.sql — third-party provider cost tracking (issue #MUM-35)
--
-- Audit trail for paid API calls to third-party data providers (DataForSEO, etc.).
-- Records the reported cost and task ID for each call, enabling spend bounds
-- enforcement and cost reconciliation.
--
-- Columns:
--   id               — server-minted UUID
--   tenant           — TENANT_SLUG (tenant isolation)
--   provider         — provider type: dataforseo | ...
--   task_id          — provider-assigned task/request ID (for cost attribution)
--   reported_cost    — cost reported by provider (in provider's units)
--   currency         — cost unit: credits | usd_cents | ...
--   call_timestamp   — ISO-8601 timestamp when API call was made
--   created_at       — ISO-8601 timestamp when receipt was recorded

CREATE TABLE IF NOT EXISTS provider_cost_receipts (
  id             TEXT    PRIMARY KEY,
  tenant         TEXT    NOT NULL,
  provider       TEXT    NOT NULL,
  task_id        TEXT    NOT NULL,
  reported_cost  REAL    NOT NULL,
  currency       TEXT    NOT NULL DEFAULT 'credits',
  call_timestamp TEXT    NOT NULL,
  created_at     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_provider_cost_receipts_tenant_provider
  ON provider_cost_receipts (tenant, provider, call_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_provider_cost_receipts_task
  ON provider_cost_receipts (provider, task_id);
