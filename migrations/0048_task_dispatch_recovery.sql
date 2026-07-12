-- Recover interrupted Queue claims and task executions without duplicating work.
ALTER TABLE task_dispatch_receipts ADD COLUMN claim_expires_at INTEGER;
ALTER TABLE tasks ADD COLUMN execution_receipt_id TEXT;
ALTER TABLE tasks ADD COLUMN execution_claim_expires_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_task_dispatch_receipts_claim
  ON task_dispatch_receipts (tenant, consumed_at, claim_expires_at);
