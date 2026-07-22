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
-- Discussion posts and lifecycle transitions are append-only receipts — the same
-- primitive shape as task_verdicts (migration 0007). No UPDATE/DELETE path on
-- task_thread_receipts; archive is a status flip on the task row + a receipt.
--
-- Enums enforced in the service layer (D1 TEXT cannot retroactively CHECK on
-- ALTER TABLE ADD COLUMN):
--   thread_status ∈ { open, archived }
--   receipt kind  ∈ { opened, branch_linked, post, archived }

ALTER TABLE tasks ADD COLUMN thread_status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE tasks ADD COLUMN git_branch TEXT;

-- Terminal tasks that already existed before this migration are archived threads:
-- their discussion is closed; only live work keeps an open thread.
UPDATE tasks SET thread_status = 'archived'
 WHERE status IN ('done', 'approved', 'rejected');

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
