-- 0247_admission_gate_authority.sql — an ATTACHED agent session may exercise its bound agent's gate capability
-- (task_verdict) when the admission opts in. Hadi (owner, 2026-10-19): reviewing is agent work; human approval is a
-- different thing and stays out of this.
--
-- WHY A NEW COLUMN AND NOT A RELAXED `gates` CHECK. 0220 fixed `gates INTEGER CHECK (gates = 0)`. SQLite cannot alter a
-- CHECK, so relaxing it means DROP TABLE agent_seat_admissions. That table is the PARENT of agent_seat_attachments
-- (admission_id ... ON DELETE RESTRICT) and attachments are no-delete by trigger, so the rebuild would fail on any pot that
-- already holds an attachment (RESTRICT is checked immediately; same trap 0202 documents for harnesses). `gates` therefore
-- stays frozen at 0 forever (legacy, never read as authority) and `gate_authority` is the opt-in:
--   0 = the attached seat holds NO gate authority (every existing row, the DEFAULT)
--   1 = the attached seat may pass the gate check AS ITS BOUND AGENT, only while the attachment, the admission and the
--       agent are live AND the agent itself holds a live gate_grants row for the capability (hasActiveGateGrant), and
--       with every verdict-independence rule intact (src/auth/attached-gate.ts, src/tasks/index.ts).
-- Decided exactly once, at the human's decision (pending -> live) or at insert for a dashboard admission that is born live;
-- never changed afterwards (changing it takes a new admission: revoke + a new tap), like `ceiling`.
-- Additive: no existing row, index or trigger is touched.
ALTER TABLE agent_seat_admissions ADD COLUMN gate_authority INTEGER NOT NULL DEFAULT 0 CHECK (gate_authority IN (0, 1));

CREATE TRIGGER IF NOT EXISTS agent_seat_admissions_gate_authority_immutable
BEFORE UPDATE OF gate_authority ON agent_seat_admissions
FOR EACH ROW
WHEN NEW.gate_authority IS NOT OLD.gate_authority AND OLD.status <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'agent_seat_admission_gate_authority_immutable');
END;

-- AUDIT. A verdict cast through an attached session is decided_by = the bound agent; these record WHICH attachment and WHICH
-- human consented, from the server-resolved auth only (same pattern as 0236 for agent_messages / task_result_submissions).
-- decided_via is NOT used: 0155 pinned it to a single value by CHECK and a rebuild of task_verdicts is not worth the risk.
-- Nullable, additive, no backfill; the append-only trigger is re-created below to pin the new columns as well.
ALTER TABLE task_verdicts ADD COLUMN attachment_id TEXT;
ALTER TABLE task_verdicts ADD COLUMN consenting_member_id TEXT;

DROP TRIGGER IF EXISTS task_verdicts_no_update;

CREATE TRIGGER task_verdicts_no_update
BEFORE UPDATE ON task_verdicts
WHEN NOT (
  (
    OLD.project_id IS NULL
    AND NEW.project_id IS (SELECT project_id FROM tasks WHERE id = OLD.task_id)
    AND NEW.id IS OLD.id
    AND NEW.task_id IS OLD.task_id
    AND NEW.verdict IS OLD.verdict
    AND NEW.note IS OLD.note
    AND NEW.decided_by IS OLD.decided_by
    AND NEW.decided_at IS OLD.decided_at
    AND NEW.decided_via IS OLD.decided_via
    AND NEW.origin_agent_id IS OLD.origin_agent_id
    AND NEW.proposal_id IS OLD.proposal_id
    AND NEW.reversed_at IS OLD.reversed_at
    AND NEW.attachment_id IS OLD.attachment_id
    AND NEW.consenting_member_id IS OLD.consenting_member_id
  )
  OR
  (
    OLD.reversed_at IS NULL
    AND NEW.reversed_at IS NOT NULL
    AND NEW.id IS OLD.id
    AND NEW.task_id IS OLD.task_id
    AND NEW.verdict IS OLD.verdict
    AND NEW.note IS OLD.note
    AND NEW.decided_by IS OLD.decided_by
    AND NEW.decided_at IS OLD.decided_at
    AND NEW.decided_via IS OLD.decided_via
    AND NEW.origin_agent_id IS OLD.origin_agent_id
    AND NEW.proposal_id IS OLD.proposal_id
    AND NEW.project_id IS OLD.project_id
    AND NEW.attachment_id IS OLD.attachment_id
    AND NEW.consenting_member_id IS OLD.consenting_member_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'verdicts are append-only: UPDATE is forbidden');
END;
