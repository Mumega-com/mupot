-- 0250 bounty -> task binding (seed B1, docs: agents/kasra/docs/seed-build-plan-20261022.md).
--
-- A mumega.com bounty claim arrives at /api/events/ingest as `bounty.claimed` and becomes ONE task,
-- tagged tasks.external_source = 'mumega-bounty:<bounty_id>'. Delivery is at-least-once (a lost
-- response is retried), so creation must be create-or-recover: the same binding returns the same
-- task, and a binding that does not match is a conflict, never an adoption of someone else's task.
--
-- ADDITIVE ONLY: one new table, two new indexes. No existing row, column, trigger or index changes.
--
-- WHY THE UNIQUE INDEX IS SCOPED. tasks.external_source is NOT a per-task key for other writers:
-- src/events/ingest.ts stamps every event-ingested task with the constant 'event-ingest:<source>',
-- so duplicate non-null values are normal and a table-wide UNIQUE index would fail to build (and
-- would forbid the second ingested lead). Only the 'mumega-bounty:' namespace is a per-task key, so
-- only it is unique. GLOB (case-sensitive) rather than LIKE so the predicate means exactly the
-- prefix the application writes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_mumega_bounty_source
  ON tasks(external_source)
  WHERE external_source GLOB 'mumega-bounty:*';

-- The binding carries what the task row cannot: which award revision created it and a digest of the
-- exact validated payload, so a replay can be told apart from a conflicting claim. bounty_id is the
-- PRIMARY KEY, so the bounty -> task map is one-to-one in both directions (task_id UNIQUE).
-- claimant_identity_id / claimant_email_sha256 are the opaque mumega.com identity reference and a
-- hash; the raw email never enters this table or the task. They are kept for the member-path result
-- submission (seed B2) and are NOT placed in the task title/body.
CREATE TABLE IF NOT EXISTS bounty_task_bindings (
  bounty_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  award_revision INTEGER NOT NULL CHECK (award_revision >= 0),
  payload_sha256 TEXT NOT NULL,
  issuer_tenant TEXT NOT NULL,
  claimant_identity_id TEXT NOT NULL,
  claimant_email_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
