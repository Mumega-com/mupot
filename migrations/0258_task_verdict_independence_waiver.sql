-- 0258 a verdict records WHICH independence exemption let its decider through (mom-walk D1, mupot task 7ae27377).
--
-- independence_waiver: NULL for an ordinary independent verdict (and every pre-0258 verdict); otherwise the
-- VerdictIndependenceWaiver the write carried: 'admin_supervisory', 'owner_override', or 'owner_self' (a member who OWNS
-- the assignee agent giving the verdict on its work). Written in the verdict INSERT, atomic with it, so an owner's own-agent
-- approval is auditable apart from an admin's supervisory one. Additive, no backfill, no FK.
--
-- The append-only update trigger is replaced WITHOUT a window where none exists (new name FIRST, old dropped after), pinning
-- the new column on both branches exactly as 0252 did.
--
-- task_review_lenses: the evidence an OWNER's own-agent verdict ('owner_self') requires: two independent passing review
-- lenses on the task's CURRENT submission. Append-only (latest row per reviewer+lens wins, so a later fail withdraws a pass).
-- Each row binds the submission id + result digest + the gate_owner lane it was given for, so replacing the submission or
-- re-gating the task orphans it. Eligibility of the reviewer (lane held, independent, not owner-linked) is judged at decision
-- time inside the verdict UPDATE, never trusted from this row. (A later migration that re-creates it must drop BOTH names.)
CREATE TABLE IF NOT EXISTS task_review_lenses (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  result_digest TEXT NOT NULL,
  gate_owner    TEXT NOT NULL,
  lens          TEXT NOT NULL CHECK (length(trim(lens)) BETWEEN 1 AND 64),
  reviewer_kind TEXT NOT NULL CHECK (reviewer_kind IN ('agent', 'member')),
  reviewer_id   TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('pass', 'fail')),
  note          TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_review_lenses_task_submission ON task_review_lenses(task_id, submission_id);
CREATE TRIGGER IF NOT EXISTS task_review_lenses_no_update BEFORE UPDATE ON task_review_lenses
BEGIN SELECT RAISE(ABORT, 'task_review_lenses are append-only: UPDATE is forbidden'); END;
CREATE TRIGGER IF NOT EXISTS task_review_lenses_no_delete BEFORE DELETE ON task_review_lenses
BEGIN SELECT RAISE(ABORT, 'task_review_lenses are append-only: DELETE is forbidden'); END;

ALTER TABLE task_verdicts ADD COLUMN independence_waiver TEXT CHECK (independence_waiver IS NULL OR independence_waiver IN ('admin_supervisory', 'owner_override', 'owner_self'));

CREATE TRIGGER IF NOT EXISTS task_verdicts_no_update_0258
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
    AND NEW.submission_id IS OLD.submission_id
    AND NEW.result_digest IS OLD.result_digest
    AND NEW.receipt_actor_kind IS OLD.receipt_actor_kind
    AND NEW.independence_waiver IS OLD.independence_waiver
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
    AND NEW.submission_id IS OLD.submission_id
    AND NEW.result_digest IS OLD.result_digest
    AND NEW.receipt_actor_kind IS OLD.receipt_actor_kind
    AND NEW.independence_waiver IS OLD.independence_waiver
  )
)
BEGIN
  SELECT RAISE(ABORT, 'verdicts are append-only: UPDATE is forbidden');
END;

DROP TRIGGER IF EXISTS task_verdicts_no_update_0252;
