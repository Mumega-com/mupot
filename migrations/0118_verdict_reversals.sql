-- 0118 — verdict_reversals receipts (mupot#1181; P0 task verdict correction path)
--
-- WHY THIS TABLE EXISTS
--
-- A task with a verdict already recorded (status in ('approved', 'rejected'))
-- previously had NO supported correction path for any principal. If an errant,
-- mistaken, or misclassified verdict was written, no tool could reverse it,
-- rendering every verdict permanent and irreversible by construction.
--
-- RECOVERY PATH DISCIPLINE (mirroring 0113 gate_owner_reassignments):
--   * from_status in ('approved', 'rejected') ONLY
--   * to_status is ALWAYS 'review' (a fresh review/verdict cycle is required;
--     direct approved <-> rejected flipping is forbidden to prevent silent laundering)
--   * org owner / admin ONLY (hasWorkspaceAdmin / owner role)
--   * non-empty reason is MANDATORY
--   * append-only enforced by triggers; ordering by monotonic seq
--
-- Shape follows agent_audit (0086) and gate_owner_reassignments (0113):
--   * seq AUTOINCREMENT monotonic ordering key
--   * NO foreign key to tasks (receipts outlive subject rows)
--   * Triggers forbid UPDATE and DELETE

CREATE TABLE IF NOT EXISTS verdict_reversals (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT, -- monotonic; the ordering key
  id              TEXT NOT NULL UNIQUE,              -- UUID, the external handle
  tenant          TEXT NOT NULL,
  task_id         TEXT NOT NULL,                     -- deliberately NOT a foreign key
  squad_id        TEXT NOT NULL,
  from_status     TEXT NOT NULL,                     -- 'approved' or 'rejected'
  to_status       TEXT NOT NULL DEFAULT 'review',    -- 'review'
  prior_verdict   TEXT,                              -- prior verdict ('approved'|'rejected')
  reason          TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  actor_id        TEXT NOT NULL,
  actor_type      TEXT NOT NULL DEFAULT 'member' CHECK (actor_type IN ('member','agent','system')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_verdict_reversals_task
  ON verdict_reversals(tenant, task_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_verdict_reversals_actor
  ON verdict_reversals(tenant, actor_id, seq DESC);

-- Append-only, enforced.
CREATE TRIGGER verdict_reversals_no_update
BEFORE UPDATE ON verdict_reversals
BEGIN
  SELECT RAISE(ABORT, 'verdict_reversals is append-only: UPDATE is forbidden');
END;

CREATE TRIGGER verdict_reversals_no_delete
BEFORE DELETE ON verdict_reversals
BEGIN
  SELECT RAISE(ABORT, 'verdict_reversals is append-only: DELETE is forbidden');
END;
