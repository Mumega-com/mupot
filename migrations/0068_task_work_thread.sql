-- 0068_task_work_thread.sql — work-item = thread (Buzz pattern, borrowed).
--
-- A mupot task carries its own scoped discussion/thread. The task IS the work
-- item; the thread is a facet of that same object (not a separate Buzz/Nostr
-- channel stack). Lifecycle:
--   create task  → thread opens  (thread_status='open' + opened receipt)
--   branch/PR    → channel binds (git_branch + branch_linked receipt; PR url
--                  reuses tasks.github_issue_url)
--   merge        → thread archives (thread_status='archived' + archived receipt)
--
-- INTENT: thread_status and task.status are allowed to diverge. Merge freezes
-- the discussion even when the task is still status=review awaiting a gate
-- verdict (Kasra-core gates before merge; the task is not self-closed). See
-- docs/architecture/work-item-thread.md.
--
-- Discussion posts and lifecycle transitions are append-only receipts — the same
-- primitive shape as task_verdicts (migration 0007). No UPDATE/DELETE path on
-- task_thread_receipts; archive is a status flip on the task row + a receipt.
--
-- Enums enforced in the service layer (D1 TEXT cannot retroactively CHECK on
-- ALTER TABLE ADD COLUMN):
--   thread_status ∈ { open, archived }
--   receipt kind  ∈ { opened, branch_linked, post, archived }
--
-- Full tasks.status enum (migration 0042): open | in_progress | blocked | review
--   | approved | rejected | done. There is NO cancelled (or other) status.
-- Keep THREAD_ARCHIVE_BACKFILL_STATUSES in src/tasks/thread.ts in lockstep with
-- the WHERE list below.

ALTER TABLE tasks ADD COLUMN thread_status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE tasks ADD COLUMN git_branch TEXT;

-- Gate-outcome / terminal rows that already existed before this migration get
-- archived threads (discussion closed). Live + in-gate rows keep open threads:
--   open, in_progress, blocked, review  → thread stays open
--   approved, rejected, done            → thread archived (full terminal set;
--                                         no cancelled in the enum)
UPDATE tasks SET thread_status = 'archived'
 WHERE status IN ('approved', 'rejected', 'done');

CREATE TABLE IF NOT EXISTS task_thread_receipts (
  id          TEXT NOT NULL PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  kind        TEXT NOT NULL CHECK (kind IN ('opened', 'branch_linked', 'post', 'archived')),
  body        TEXT NOT NULL DEFAULT '',
  actor_id    TEXT NOT NULL,
  ref         TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_thread_receipts_task
  ON task_thread_receipts (task_id, created_at);
