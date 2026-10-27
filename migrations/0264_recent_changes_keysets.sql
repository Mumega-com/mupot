-- Ordered source ranges for /changes. Equality prefixes preserve the existing
-- tenant/actor scopes; (timestamp,id) supports both directions without OFFSET.
CREATE INDEX idx_archive_receipts_changes ON archive_receipts(tenant, created_at DESC, id DESC);
CREATE INDEX idx_archive_receipts_actor_changes ON archive_receipts(tenant, actor_member_id, created_at DESC, id DESC);
CREATE INDEX idx_task_verdicts_changes ON task_verdicts(decided_at DESC, id DESC);
CREATE INDEX idx_task_verdicts_actor_changes ON task_verdicts(decided_by, decided_at DESC, id DESC);
CREATE INDEX idx_verdict_reversals_changes ON verdict_reversals(tenant, created_at DESC, id DESC);
CREATE INDEX idx_verdict_reversals_actor_changes ON verdict_reversals(tenant, actor_id, created_at DESC, id DESC);
CREATE INDEX idx_agent_audit_changes ON agent_audit(created_at DESC, id DESC);
CREATE INDEX idx_agent_audit_actor_changes ON agent_audit(actor_id, created_at DESC, id DESC);
