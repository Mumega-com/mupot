-- 0231_archive_proposals.sql: agents PROPOSE archiving a task; a human org admin decides at /board/cleanup.
--
-- WHY. archive_row on tasks accepts only an operator principal (a human, never an agent-bound caller) and the
-- dashboard had no archive control, so agents could list obsolete tasks but nobody could approve them in one place.
-- This table is the whole store: a proposal writes nothing to the task. Archiving still runs through archiveRow
-- (src/hygiene/archive.ts), the one chokepoint, from the human page only.
--
-- task_status_at_proposal is the status the proposer saw; the page passes it as archiveRow's expectedStatus so a task
-- that moved since is refused per row (status_drift) instead of archived on stale evidence.
-- task_updated_at_proposal is tasks.updated_at when proposed; a task touched since is refused at decision (refused_task_changed).
-- Proposals expire after 14 days (enforced in the readers and the decision).
-- decision: NULL = pending. 'archived' | 'already_archived' | 'refused_status_drift' | 'refused_not_found' | 'refused_task_changed' are terminal.
-- A transient refusal (live execution claim, in-air flight, in-flight dispatch) leaves the row pending.
CREATE TABLE IF NOT EXISTS archive_proposals (
  id                      TEXT PRIMARY KEY,
  tenant                  TEXT NOT NULL,
  task_id                 TEXT NOT NULL,
  proposed_by_agent_id    TEXT NOT NULL,
  reason                  TEXT NOT NULL,
  evidence                TEXT NOT NULL DEFAULT '',
  task_status_at_proposal TEXT NOT NULL,
  task_updated_at_proposal TEXT,
  created_at              TEXT NOT NULL,
  decided_at              TEXT,
  decision                TEXT,
  decided_by_member_id    TEXT
);
-- One pending proposal per task: a re-proposal while one is pending is a no-op, not a second row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_proposals_pending_task
  ON archive_proposals(tenant, task_id) WHERE decision IS NULL;
CREATE INDEX IF NOT EXISTS idx_archive_proposals_pending
  ON archive_proposals(tenant, created_at) WHERE decision IS NULL;
