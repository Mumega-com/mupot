-- Preserve the authenticated connection responsible for append-only runtime work.
-- Nullable: existing host receipts remain valid; no attribution is inferred or backfilled.
ALTER TABLE task_dispatch_runtime_receipts ADD COLUMN seat_id TEXT;
ALTER TABLE task_dispatch_runtime_receipts ADD COLUMN attachment_id TEXT;
ALTER TABLE task_dispatch_runtime_receipts ADD COLUMN consenting_member_id TEXT;

-- Exact-seat runtime custody checks inspect only active attempts for this message.
CREATE INDEX idx_inbox_attempt_runtime_custody
  ON agent_inbox_lease_attempts(tenant, agent_id, target_seat_key, message_id) WHERE state = 'leased';
