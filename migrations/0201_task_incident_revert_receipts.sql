-- 0201_task_incident_revert_receipts.sql — append-only evidence for the audited admin tool
-- `task_incident_revert` (mupot#1780 incident recovery, option C).
--
-- The task state machine (TRANSITIONS, src/tasks/service.ts) has no edge back to 'open', so no
-- supported tool can undo an accidental mass assignment. task_incident_revert is the one audited
-- exception: a per-row compare-and-set that returns a task to open + unassigned. Every revert
-- writes ONE row here holding the FULL pre-revert task row (every column, as JSON) in the same
-- D1 batch as the UPDATE, so nothing the tool overwrote is lost and nothing is invented.
--
-- Append-only: UPDATE and DELETE are refused by trigger, like execution_receipts (0123).
-- No FK to tasks/members on purpose: the evidence must outlive a later task/member rebuild or
-- archive, and a RESTRICT FK would block the members-table rebuilds documented in 0173.
-- NOT applied by this build; a human applies it (migrate first, then deploy the code).

CREATE TABLE task_incident_revert_receipts (
  id                          TEXT PRIMARY KEY,
  tenant                      TEXT NOT NULL CHECK (length(trim(tenant)) > 0),
  incident_ref                TEXT NOT NULL CHECK (length(trim(incident_ref)) BETWEEN 1 AND 500),
  reason                      TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2000),
  task_id                     TEXT NOT NULL,
  actor_member_id             TEXT NOT NULL CHECK (length(trim(actor_member_id)) > 0),
  expected_status             TEXT NOT NULL,
  expected_assignee_agent_id  TEXT,
  expected_updated_at         TEXT NOT NULL,
  pre_row_json                TEXT NOT NULL CHECK (json_valid(pre_row_json)),
  new_updated_at              TEXT NOT NULL,
  created_at                  TEXT NOT NULL
);

CREATE INDEX idx_task_incident_revert_receipts_task
  ON task_incident_revert_receipts(tenant, task_id, created_at);
CREATE INDEX idx_task_incident_revert_receipts_incident
  ON task_incident_revert_receipts(tenant, incident_ref, created_at);

CREATE TRIGGER task_incident_revert_receipts_no_update
BEFORE UPDATE ON task_incident_revert_receipts
BEGIN
  SELECT RAISE(ABORT, 'task incident revert receipts are append-only');
END;

CREATE TRIGGER task_incident_revert_receipts_no_delete
BEFORE DELETE ON task_incident_revert_receipts
BEGIN
  SELECT RAISE(ABORT, 'task incident revert receipts are append-only');
END;
