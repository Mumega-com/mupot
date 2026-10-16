-- 0232_approval_expiry.sql — an unanswered gate ask expires (Hadi, org owner, 2026-10-16:
-- "if one didn't answer to the approval it expires").
--
-- WHY
--
-- A task in `review` with a gate_owner waited FOREVER: the only exit from review was a verdict
-- and nothing swept. This migration is the schema half of the fix (src/gates/approval-expiry.ts
-- is the rule, the shared predicate and the sweep):
--
--   tasks.review_entered_at   when the task ENTERED review. tasks.updated_at cannot answer that:
--                             stall rewakes, notes and gate-wake notices bump it. Stamped BY
--                             TRIGGER on every transition into review (and every INSERT as
--                             review), so no writer can forget it (there are 6+ writers that
--                             set status='review'; hooking some of them is how a derived column
--                             goes stale).
--   tasks.expired_count       how many times this task's ask lapsed WITHOUT a verdict: incremented
--                             by the sweeper (expiry) and by the bounce trigger below (a CI-fail
--                             review -> in_progress). Both count toward the resubmit cap.
--   tasks.review_clock_carry  set when a task leaves review for in_progress without a verdict (a
--                             CI-fail bounce); the next entry into review keeps that ORIGINAL
--                             review_entered_at instead of restarting the 14-day clock, so a bounce
--                             cannot be used to dodge expiry. Cleared on the next entry into review,
--                             or when the task moves to any status other than review/in_progress.
--   approval_expiry_receipts  append-only receipt + audit row per sweeper transition (who, when,
--                             why) and per human cap reset.
--
-- RESUBMIT CAP. After two expiries a third resubmission (in_progress -> review) is refused with
-- `resubmit_cap_needs_human` until a human resets the counter (approval_resubmit_cap_reset MCP
-- tool, org-admin, receipted). The literal 2 below is APPROVAL_EXPIRY.resubmit_cap in
-- src/gates/approval-expiry.ts; tests/approval-expiry.test.ts pins the two together. Only
-- in_progress -> review is a *resubmission*: a verdict reversal (approved|rejected -> review) is
-- already a human act and is not capped.
--
-- NOTHING EXPIRES BY THIS FILE. It adds columns, triggers and a table; the backfill at the
-- bottom only fills review_entered_at.

ALTER TABLE tasks ADD COLUMN review_entered_at TEXT;
ALTER TABLE tasks ADD COLUMN expired_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN review_clock_carry TEXT;

CREATE TRIGGER IF NOT EXISTS tasks_review_entered_stamp_update
AFTER UPDATE OF status ON tasks
WHEN NEW.status = 'review' AND OLD.status <> 'review'
BEGIN
  UPDATE tasks
     SET review_entered_at = COALESCE(review_clock_carry, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
         review_clock_carry = NULL
   WHERE id = NEW.id;
END;

-- A review -> in_progress move is never a verdict (a verdict lands on approved/rejected; the sweeper
-- lands on blocked): it is a bounce (the CI-fail path, syncCiResultToTask). Remember the original
-- clock and count it toward the cap exactly like an expiry.
CREATE TRIGGER IF NOT EXISTS tasks_review_bounce
AFTER UPDATE OF status ON tasks
WHEN OLD.status = 'review' AND NEW.status = 'in_progress'
BEGIN
  UPDATE tasks
     SET review_clock_carry = OLD.review_entered_at,
         expired_count = expired_count + 1
   WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS tasks_review_carry_clear
AFTER UPDATE OF status ON tasks
WHEN NEW.status NOT IN ('review', 'in_progress') AND NEW.review_clock_carry IS NOT NULL
BEGIN
  UPDATE tasks SET review_clock_carry = NULL WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS tasks_review_entered_stamp_insert
AFTER INSERT ON tasks
WHEN NEW.status = 'review'
BEGIN
  UPDATE tasks SET review_entered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS tasks_resubmit_cap
BEFORE UPDATE OF status ON tasks
WHEN NEW.status = 'review' AND OLD.status = 'in_progress' AND OLD.expired_count >= 2
BEGIN
  SELECT RAISE(ABORT, 'resubmit_cap_needs_human');
END;

CREATE TABLE IF NOT EXISTS approval_expiry_receipts (
  seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
  id                  TEXT NOT NULL UNIQUE,
  tenant              TEXT NOT NULL,
  task_id             TEXT NOT NULL,                  -- deliberately NOT a foreign key (receipts outlive rows)
  squad_id            TEXT NOT NULL,
  gate_owner          TEXT NOT NULL,
  from_status         TEXT NOT NULL,
  to_status           TEXT NOT NULL,
  reason              TEXT NOT NULL CHECK (reason IN ('approval_expired', 'gate_owner_dead', 'resubmit_cap_reset')),
  review_entered_at   TEXT,
  expires_at          TEXT,                           -- review_entered_at + the window that applied
  expired_count_after INTEGER NOT NULL,
  actor               TEXT NOT NULL CHECK (length(trim(actor)) > 0), -- 'system:sweeper' or the member id
  via                 TEXT NOT NULL CHECK (via IN ('cron', 'backfill', 'human')),
  notify_target       TEXT,                           -- agent id told "approval expired unanswered", or NULL
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_approval_expiry_receipts_task ON approval_expiry_receipts(tenant, task_id, seq DESC);

CREATE TRIGGER approval_expiry_receipts_no_update
BEFORE UPDATE ON approval_expiry_receipts
BEGIN
  SELECT RAISE(ABORT, 'approval_expiry_receipts is append-only: UPDATE is forbidden');
END;
CREATE TRIGGER approval_expiry_receipts_no_delete
BEFORE DELETE ON approval_expiry_receipts
BEGIN
  SELECT RAISE(ABORT, 'approval_expiry_receipts is append-only: DELETE is forbidden');
END;

-- Index for the sweep scan (review + gate_owner + oldest entry first).
CREATE INDEX IF NOT EXISTS idx_tasks_review_entered ON tasks(review_entered_at) WHERE status = 'review';

-- BACKFILL (documented fallback; nothing else is touched). For each task currently in review,
-- review_entered_at = the LATER of (latest recorded event that puts a task into review: a
-- task_result_submissions receipt = in_progress -> review, a verdict_reversals receipt =
-- approved|rejected -> review) and tasks.updated_at. NEVER earlier than updated_at: several writers
-- (runtime-receipts completed, github-execute, execute.ts finishTask) put a task into review with no
-- receipt at all, so an old submission receipt can predate a later bounce + re-entry, and stamping it
-- would expire a live ask early. updated_at is an UPPER bound on the entry time, so this errs toward
-- expiring LATE, never toward expiring a live ask early.
-- BACKFILL-BEGIN
UPDATE tasks
   SET review_entered_at = CASE
     WHEN (SELECT MAX(ts) FROM (
             SELECT created_at AS ts FROM task_result_submissions WHERE task_id = tasks.id
             UNION ALL
             SELECT created_at AS ts FROM verdict_reversals WHERE task_id = tasks.id)) IS NOT NULL
      AND datetime((SELECT MAX(ts) FROM (
             SELECT created_at AS ts FROM task_result_submissions WHERE task_id = tasks.id
             UNION ALL
             SELECT created_at AS ts FROM verdict_reversals WHERE task_id = tasks.id))) > datetime(updated_at)
     THEN (SELECT MAX(ts) FROM (
             SELECT created_at AS ts FROM task_result_submissions WHERE task_id = tasks.id
             UNION ALL
             SELECT created_at AS ts FROM verdict_reversals WHERE task_id = tasks.id))
     ELSE updated_at END
 WHERE status = 'review' AND review_entered_at IS NULL;
-- BACKFILL-END
