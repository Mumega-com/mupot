-- 0062: add durable cancellation receipt kinds to routine_run_events (#397 Task 9).
--
-- 0061 shipped without cancellation_requested / _confirmed / _unconfirmed.
-- Do not edit applied 0061 — rebuild the events table forward-only while
-- preserving rows, append-only triggers, indexes, and FK behavior.

PRAGMA foreign_keys = off;

DROP TRIGGER IF EXISTS validate_routine_event_insert;
DROP TRIGGER IF EXISTS routine_events_no_update;
DROP TRIGGER IF EXISTS routine_events_no_delete;

CREATE TABLE IF NOT EXISTS routine_run_events_new (
  id              TEXT PRIMARY KEY,
  tenant          TEXT NOT NULL,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  run_id          TEXT NOT NULL REFERENCES routine_runs(id) ON DELETE RESTRICT,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'created','leased','observed','dispatched','agent_waiting',
                    'proposal_received','approval_requested','action_started',
                    'action_completed','retry_scheduled','budget_blocked','skipped',
                    'cancelled','cancellation_requested','cancellation_confirmed',
                    'cancellation_unconfirmed','failed','succeeded'
                  )),
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('system','member','agent')),
  actor_id        TEXT NOT NULL CHECK (length(trim(actor_id)) BETWEEN 1 AND 200),
  occurred_at     TEXT NOT NULL DEFAULT (datetime('now')),
  metadata_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  correlation_id  TEXT NOT NULL CHECK (length(trim(correlation_id)) BETWEEN 1 AND 200)
);

INSERT INTO routine_run_events_new (
  id, tenant, project_id, run_id, kind, actor_type, actor_id,
  occurred_at, metadata_json, correlation_id
)
SELECT
  id, tenant, project_id, run_id, kind, actor_type, actor_id,
  occurred_at, metadata_json, correlation_id
FROM routine_run_events;

DROP TABLE routine_run_events;
ALTER TABLE routine_run_events_new RENAME TO routine_run_events;

CREATE INDEX IF NOT EXISTS idx_routine_run_events_history
  ON routine_run_events (tenant, project_id, occurred_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_routine_run_events_projection_keyset
  ON routine_run_events (
    tenant, project_id,
    CAST(ROUND((julianday(occurred_at) - 2440587.5) * 86400000) AS INTEGER) DESC,
    id
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_routine_run_events_one_cancellation_request
  ON routine_run_events (tenant, run_id)
  WHERE kind = 'cancellation_requested';

CREATE UNIQUE INDEX IF NOT EXISTS idx_routine_run_events_one_cancellation_outcome
  ON routine_run_events (tenant, run_id)
  WHERE kind IN ('cancellation_confirmed', 'cancellation_unconfirmed');

CREATE TRIGGER validate_routine_event_insert
BEFORE INSERT ON routine_run_events
BEGIN
  SELECT RAISE(ABORT, 'routine event ownership mismatch')
    WHERE NOT EXISTS (
      SELECT 1 FROM routine_runs
       WHERE id = NEW.run_id AND tenant = NEW.tenant AND project_id = NEW.project_id
    );
END;

CREATE TRIGGER routine_events_no_update
BEFORE UPDATE ON routine_run_events
BEGIN
  SELECT RAISE(ABORT, 'routine events are append-only');
END;

CREATE TRIGGER routine_events_no_delete
BEFORE DELETE ON routine_run_events
BEGIN
  SELECT RAISE(ABORT, 'routine events are append-only');
END;

PRAGMA foreign_keys = on;
