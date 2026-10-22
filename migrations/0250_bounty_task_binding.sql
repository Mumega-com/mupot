-- 0250 bounty -> task binding (seed B1, docs: agents/kasra/docs/seed-build-plan-20261022.md).
--
-- A mumega.com bounty claim arrives at /api/events/ingest as `bounty.claimed` and becomes ONE task,
-- tagged tasks.external_source = 'mumega-bounty:<bounty_id>'. Delivery is at-least-once (a lost
-- response is retried), so creation must be create-or-recover: the same binding returns the same
-- task, and a binding that does not match is a conflict, never an adoption of someone else's task.
--
-- ADDITIVE ONLY: one new table, one new unique index, two new triggers. No existing row, column,
-- trigger or index changes.
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

-- THE NAMESPACE IS RESERVED IN THE DATABASE TOO. The partial index above only sees the exact-case
-- prefix, so a case variant ('Mumega-Bounty:x') would sit outside the unique key while still reading
-- as the bounty channel's marker. These triggers close that for every writer, including ones that
-- bypass createTask (the application guard in tasks/provenance.ts + prepareGuardedTaskInsert is the
-- first line; this is the one that cannot be skipped):
--   - INSERT: a case-insensitive match that is not the exact-case prefix is refused.
--   - UPDATE OF external_source: nothing may be CHANGED INTO the namespace in any case (the ingest
--     only ever inserts; a later rewrite of a task's provenance into a bounty key is squatting).
DROP TRIGGER IF EXISTS trg_tasks_bounty_prefix_exact_insert;
CREATE TRIGGER trg_tasks_bounty_prefix_exact_insert
BEFORE INSERT ON tasks
FOR EACH ROW
WHEN NEW.external_source LIKE 'mumega-bounty:%' AND NEW.external_source NOT GLOB 'mumega-bounty:*'
BEGIN
  SELECT RAISE(ABORT, 'tasks.external_source: the mumega-bounty: prefix is reserved and case-sensitive');
END;

DROP TRIGGER IF EXISTS trg_tasks_bounty_prefix_reserved_update;
CREATE TRIGGER trg_tasks_bounty_prefix_reserved_update
BEFORE UPDATE OF external_source ON tasks
FOR EACH ROW
WHEN NEW.external_source LIKE 'mumega-bounty:%' AND NEW.external_source IS NOT OLD.external_source
BEGIN
  SELECT RAISE(ABORT, 'tasks.external_source: the mumega-bounty: prefix is reserved to the bounty ingest');
END;

-- The binding carries what the task row cannot: which award revision created it and a digest of the
-- exact validated payload, so a replay can be told apart from a conflicting claim. bounty_id is the
-- PRIMARY KEY, so the bounty -> task map is one-to-one in both directions (task_id UNIQUE).
-- claimant_identity_id is the opaque mumega.com identity reference (no email, no email hash: an
-- unkeyed hash of a low-entropy value is a reversible identifier and nothing in B1 consumes one).
-- It is NOT placed in the task title/body; it is kept for the member-path result submission (B2).
-- created_event_emitted_at is NULL until task.created has been emitted for this binding; a delivery
-- that finds it NULL re-emits and marks it, so a failed emit is repaired rather than lost.
CREATE TABLE IF NOT EXISTS bounty_task_bindings (
  bounty_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  award_revision INTEGER NOT NULL CHECK (award_revision >= 0),
  payload_sha256 TEXT NOT NULL,
  issuer_tenant TEXT NOT NULL,
  claimant_identity_id TEXT NOT NULL,
  created_event_emitted_at TEXT,
  created_at TEXT NOT NULL
);
