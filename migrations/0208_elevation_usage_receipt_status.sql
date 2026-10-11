-- S14 (PR #1831 review F2): elevation_usage_log becomes a durable two-phase
-- receipt. A row is INSERTed 'pending' BEFORE an elevated mutation, then flipped
-- to 'applied' (in the same D1 batch as the mutation where the write path is a
-- prepared statement) or 'failed' with an error code. Rows that exist already
-- were written after the effect committed, so they are 'applied'. A row still
-- 'pending' after 10 minutes is reported by elevation_status as stuck_receipts.
ALTER TABLE elevation_usage_log ADD COLUMN status TEXT NOT NULL DEFAULT 'applied'
  CHECK (status IN ('pending', 'applied', 'failed'));
ALTER TABLE elevation_usage_log ADD COLUMN error_code TEXT;
ALTER TABLE elevation_usage_log ADD COLUMN resolved_at TEXT;

CREATE INDEX IF NOT EXISTS idx_elevation_usage_log_pending
  ON elevation_usage_log(tenant, status, occurred_at);
