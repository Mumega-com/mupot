-- Gate primitive: gate_owner on tasks + append-only verdict receipts.
--
-- gate_owner is a capability string (e.g. 'gate:outreach'). When set, the
-- task's review→approved|rejected transition is gated: the caller must hold
-- this capability (checked in task_verdicts). Verdicts are append-only receipts;
-- there is no UPDATE or DELETE path on task_verdicts (enforced at the service
-- layer and documented here).
--
-- Status column gains three values via constraint removal + re-add (SQLite does
-- not support ALTER COLUMN, so we document the wider check here):
--   open → in_progress → review → approved|rejected
--   approved → done
--   rejected → in_progress (rework) or → done (abandon)
--   blocked remains a valid status for execution failures (unchanged)
--
-- The status CHECK constraint on the existing tasks table must be widened.
-- SQLite does not support ALTER CONSTRAINT; we drop and recreate it via a
-- table-rebuild. To keep the migration simple and non-destructive we instead
-- enforce the wider set purely in the service/route layer (the DB-level CHECK
-- was not present in the original migration anyway — see 0001_init.sql which
-- stores status as plain TEXT with no CHECK).

ALTER TABLE tasks ADD COLUMN gate_owner TEXT;

CREATE TABLE task_verdicts (
  id          TEXT NOT NULL PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  verdict     TEXT NOT NULL CHECK(verdict IN ('approved', 'rejected')),
  note        TEXT,
  decided_by  TEXT NOT NULL,   -- agent id or member id of the decision-maker
  decided_at  TEXT NOT NULL    -- ISO-8601 timestamp
);

CREATE INDEX task_verdicts_task_id ON task_verdicts(task_id);
