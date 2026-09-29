-- 0183 — task_result_submissions receipts (mupot#1586).
--
-- WHY THIS TABLE EXISTS
--
-- A hand-worked task (assigned to an agent but never claimed via
-- task_dispatch_runtime_receipt's 'runtime_consumed' stage, nor executed by
-- the in-Worker AgentDO cortex cycle — execute.ts's own finishTask writes
-- `result` directly for that path) had NO supported way to report its
-- completion evidence back onto the row at all: task_update refuses an
-- unknown `result` field (#1388's own fix, closing a transient-value gate
-- forgery), and task_dispatch_runtime_receipt only accepts a receipt for a
-- task that was actually dispatched (execution_receipt_id set). The task
-- sat in_progress forever with the evidence stuck in a chat message or a
-- manual note. See src/mcp/index.ts's toolTaskSubmitResult (the new
-- `task_submit_result` tool) for the write path this table is the receipt of.
--
-- Mirrors verdict_reversals (0118) and gate_owner_reassignments (0113):
--   * seq AUTOINCREMENT monotonic ordering key
--   * NO foreign key to tasks (receipts outlive subject rows)
--   * append-only, enforced by triggers
--   * the full result text is NOT duplicated here — it already lives on
--     tasks.result; this row is WHO submitted it and WHEN, plus the exact
--     artifact claim that was shape-checked (verifyTaskArtifactShape —
--     Artifact:/SHA256: present and well-formed; NOT a verified hash match,
--     see that module's own header), for an audit trail independent of
--     whatever later overwrites (or reversal) touches the task row itself.

CREATE TABLE IF NOT EXISTS task_result_submissions (
  seq                    INTEGER PRIMARY KEY AUTOINCREMENT, -- monotonic; the ordering key
  id                     TEXT NOT NULL UNIQUE,              -- UUID, the external handle
  tenant                 TEXT NOT NULL,
  task_id                TEXT NOT NULL,                     -- deliberately NOT a foreign key
  squad_id               TEXT NOT NULL,
  submitted_by_agent_id  TEXT NOT NULL,                     -- the assignee who submitted (== tasks.assignee_agent_id at submit time)
  artifact_path          TEXT NOT NULL CHECK (length(trim(artifact_path)) > 0),
  artifact_sha256        TEXT NOT NULL CHECK (length(artifact_sha256) = 64 AND artifact_sha256 = lower(artifact_sha256)),
  result_digest          TEXT NOT NULL CHECK (length(result_digest) = 64 AND result_digest = lower(result_digest)), -- sha256 of the full submitted result text
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_task_result_submissions_task
  ON task_result_submissions(tenant, task_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_task_result_submissions_agent
  ON task_result_submissions(tenant, submitted_by_agent_id, seq DESC);

-- Append-only, enforced.
CREATE TRIGGER task_result_submissions_no_update
BEFORE UPDATE ON task_result_submissions
BEGIN
  SELECT RAISE(ABORT, 'task_result_submissions is append-only: UPDATE is forbidden');
END;

CREATE TRIGGER task_result_submissions_no_delete
BEFORE DELETE ON task_result_submissions
BEGIN
  SELECT RAISE(ABORT, 'task_result_submissions is append-only: DELETE is forbidden');
END;
