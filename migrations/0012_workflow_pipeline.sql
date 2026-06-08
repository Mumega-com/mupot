-- mupot — durable task pipeline (Cloudflare Workflows, issue #7).
--
-- Two changes:
--   1. tasks.workflow_instance_id: nullable FK to the CF Workflow instance that
--      wraps this task with durable receipts + waitForEvent gate pause. Null when
--      the task was run via the legacy direct-execute path (the pipeline is opt-in).
--   2. workflow_receipts: append-only audit log written by step.do callbacks
--      inside the pipeline.  The UNIQUE(instance_id, step_name) constraint makes
--      every receipt write idempotent on Workflow replay — a completed step is NOT
--      re-run, so the matching INSERT OR IGNORE is a no-op on the second invocation.
--
-- Design invariants:
--   - D1 remains the authoritative source of task status and verdict. The Workflow
--     wraps durable WAIT + receipts AROUND the existing gate; it never flips status
--     or writes verdicts.  All status transitions stay on the single path:
--     runTaskExecution (execute) + POST /api/tasks/:id/verdict (gate).
--   - workflow_receipts is observability-only: receipt rows tell operators what the
--     pipeline observed, not what happened to the task.

ALTER TABLE tasks ADD COLUMN workflow_instance_id TEXT;

CREATE TABLE IF NOT EXISTS workflow_receipts (
  id           TEXT NOT NULL PRIMARY KEY,             -- crypto.randomUUID()
  instance_id  TEXT NOT NULL,                         -- CF Workflow instance id
  task_id      TEXT NOT NULL,                         -- tasks.id
  step_name    TEXT NOT NULL,                         -- matches the step.do/waitForEvent name
  status       TEXT NOT NULL,                         -- 'ok' | 'waiting' | 'gate-resolved' | 'gate-timeout'
  detail       TEXT,                                  -- JSON-serialisable summary (nullable)
  created_at   TEXT NOT NULL,                         -- ISO-8601

  -- Idempotency: Workflow replay may re-enter a step, but a completed step's
  -- callback is cached and not re-run.  A duplicate receipt is simply dropped.
  UNIQUE (instance_id, step_name)
);

CREATE INDEX IF NOT EXISTS idx_workflow_receipts_task ON workflow_receipts (task_id);
CREATE INDEX IF NOT EXISTS idx_workflow_receipts_instance ON workflow_receipts (instance_id);
