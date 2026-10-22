-- 0252 a verdict is bound to the exact submission it decided, and a chain-scope verdict owes a receipt
-- (seed-build-plan-20261022, B3 + B4).
--
-- submission_id / result_digest: the task_result_submissions row (and its result_digest) the verdict decided, written by the
-- verdict surfaces (writeVerdict, the harness-attested-origin path, the gate:office path) ONLY when that row is the task's
-- CURRENT submission: the latest ledger row, whose result_text equals tasks.result, with no unreversed rejection after it.
-- Otherwise NULL (several writers put a task into review with a new tasks.result and no ledger row). NULL as well on every
-- pre-0252 verdict (additive, no backfill). The binding is re-asserted inside the status UPDATE's WHERE (same batch), so a
-- verdict never lands against a submission it did not see. A verdict bound to submission N does not count as approval for
-- N+1 (verdictForSubmission, src/tasks/verdict-binding.ts). No FK on submission_id: the ledger is append-only receipts.
--
-- receipt_actor_kind ('member' | 'agent'): non-NULL iff the task was in receipt-chain scope when the verdict was written, i.e.
-- a `gate.verdict` execution receipt is OWED. It is the durable pending marker (written in the verdict INSERT, atomic with the
-- verdict) that the reconcile sweep (reconcileGateVerdictReceipts, maintenance cron) reads, and the actor kind it replays with,
-- so a receipt that failed to append is healed byte-identically. NULL = no receipt owed (and every pre-0252 verdict).
ALTER TABLE task_verdicts ADD COLUMN submission_id TEXT;
ALTER TABLE task_verdicts ADD COLUMN result_digest TEXT;
ALTER TABLE task_verdicts ADD COLUMN receipt_actor_kind TEXT CHECK (receipt_actor_kind IS NULL OR receipt_actor_kind IN ('member', 'agent'));

CREATE INDEX IF NOT EXISTS idx_task_verdicts_submission
  ON task_verdicts(task_id, submission_id)
  WHERE submission_id IS NOT NULL;

-- Sweep index: owed receipts, oldest first.
CREATE INDEX IF NOT EXISTS idx_task_verdicts_receipt_owed
  ON task_verdicts(decided_at)
  WHERE receipt_actor_kind IS NOT NULL;

-- Append-only trigger, replaced WITHOUT a window where no update trigger exists: the new one is created under a new name
-- FIRST, and only then is the old one dropped. It pins the new columns on both branches (project hydrate and reversal stamp),
-- exactly as 0247 did for attachment_id / consenting_member_id. (A later migration that re-creates the trigger must drop
-- BOTH names.)
CREATE TRIGGER IF NOT EXISTS task_verdicts_no_update_0252
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
  )
)
BEGIN
  SELECT RAISE(ABORT, 'verdicts are append-only: UPDATE is forbidden');
END;

DROP TRIGGER IF EXISTS task_verdicts_no_update;
