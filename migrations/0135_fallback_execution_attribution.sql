-- 0135_fallback_execution_attribution.sql — Transparent fallback execution attribution (FLIGHT EXEC-02 / #1049).
--
-- Why: In-Worker fallback execution replaces unreachable seats without recording substitute
-- attribution, making it look like the original assignee completed it.
--
-- Adds substitute_executor_id and fallback_reason to tasks and task_dispatch_receipts so fallback
-- execution is transparently attributed on both the task projection and durable dispatch/completion receipts.

ALTER TABLE tasks ADD COLUMN substitute_executor_id TEXT;
ALTER TABLE tasks ADD COLUMN fallback_reason TEXT;

ALTER TABLE task_dispatch_receipts ADD COLUMN substitute_executor_id TEXT;
ALTER TABLE task_dispatch_receipts ADD COLUMN fallback_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_substitute_executor ON tasks(substitute_executor_id);
