-- 0059_project_projection_keysets.sql -- ordered range indexes for complete project history.

ALTER TABLE task_verdicts ADD COLUMN project_id TEXT REFERENCES projects(id);
ALTER TABLE workflow_receipts ADD COLUMN project_id TEXT REFERENCES projects(id);
ALTER TABLE task_dispatch_receipts ADD COLUMN project_id TEXT REFERENCES projects(id);
ALTER TABLE flight_event_outbox ADD COLUMN project_id TEXT REFERENCES projects(id);

DROP TRIGGER IF EXISTS task_verdicts_no_update;

UPDATE task_verdicts
   SET project_id = (SELECT project_id FROM tasks WHERE tasks.id = task_verdicts.task_id);
UPDATE workflow_receipts
   SET project_id = (SELECT project_id FROM tasks WHERE tasks.id = workflow_receipts.task_id);
UPDATE task_dispatch_receipts
   SET project_id = (SELECT project_id FROM tasks WHERE tasks.id = task_dispatch_receipts.task_id);
UPDATE flight_event_outbox
   SET project_id = (SELECT project_id FROM flights WHERE flights.id = flight_event_outbox.flight_id);

CREATE INDEX IF NOT EXISTS idx_tasks_project_activity_keyset
  ON tasks (
    project_id,
    CAST(ROUND((julianday(created_at) - 2440587.5) * 86400000) AS INTEGER) DESC,
    id ASC
  );

CREATE INDEX IF NOT EXISTS idx_tasks_project_evidence_keyset
  ON tasks (
    project_id,
    CAST(ROUND((julianday(COALESCE(completed_at, updated_at)) - 2440587.5) * 86400000) AS INTEGER) DESC,
    id ASC
  ) WHERE result IS NOT NULL AND length(trim(result)) > 0;

CREATE INDEX IF NOT EXISTS idx_agent_messages_project_keyset
  ON agent_messages (
    tenant,
    project_id,
    CAST(ROUND((julianday(created_at) - 2440587.5) * 86400000) AS INTEGER) DESC,
    id ASC
  );

CREATE INDEX IF NOT EXISTS idx_flights_project_keyset
  ON flights (tenant, project_id, created_at DESC, id ASC);

CREATE INDEX IF NOT EXISTS idx_project_links_activity_keyset
  ON project_links (
    tenant,
    local_project_id,
    CAST(ROUND((julianday(COALESCE(last_success_at, last_failure_at, revoked_at, created_at)) - 2440587.5) * 86400000) AS INTEGER) DESC,
    id ASC
  );

CREATE INDEX IF NOT EXISTS idx_task_verdicts_evidence_keyset
  ON task_verdicts (
    project_id,
    CAST(ROUND((julianday(decided_at) - 2440587.5) * 86400000) AS INTEGER) DESC,
    id ASC,
    task_id
  );

CREATE INDEX IF NOT EXISTS idx_workflow_receipts_evidence_keyset
  ON workflow_receipts (
    project_id,
    CAST(ROUND((julianday(created_at) - 2440587.5) * 86400000) AS INTEGER) DESC,
    id ASC,
    task_id
  );

CREATE INDEX IF NOT EXISTS idx_task_dispatch_receipts_evidence_keyset
  ON task_dispatch_receipts (
    tenant,
    project_id,
    CAST(ROUND((julianday(created_at) - 2440587.5) * 86400000) AS INTEGER) DESC,
    id ASC,
    task_id
  );

CREATE INDEX IF NOT EXISTS idx_flight_event_outbox_evidence_keyset
  ON flight_event_outbox (
    tenant,
    project_id,
    CAST(ROUND((julianday(created_at) - 2440587.5) * 86400000) AS INTEGER) DESC,
    id ASC,
    flight_id
  );

CREATE INDEX IF NOT EXISTS idx_project_link_receipts_evidence_keyset
  ON project_link_receipts (
    tenant,
    local_project_id,
    CAST(ROUND((julianday(created_at) - 2440587.5) * 86400000) AS INTEGER) DESC,
    id ASC
  );

CREATE TRIGGER IF NOT EXISTS task_verdicts_project_match_insert
BEFORE INSERT ON task_verdicts
WHEN NEW.project_id IS NOT NULL
 AND NEW.project_id IS NOT (SELECT project_id FROM tasks WHERE id = NEW.task_id)
BEGIN
  SELECT RAISE(ABORT, 'verdict project mismatch');
END;

CREATE TRIGGER IF NOT EXISTS task_verdicts_project_hydrate_insert
AFTER INSERT ON task_verdicts
WHEN NEW.project_id IS NULL
BEGIN
  UPDATE task_verdicts
     SET project_id = (SELECT project_id FROM tasks WHERE id = NEW.task_id)
   WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS task_verdicts_no_update
BEFORE UPDATE ON task_verdicts
WHEN NOT (
  OLD.project_id IS NULL
  AND NEW.project_id IS (SELECT project_id FROM tasks WHERE id = OLD.task_id)
  AND NEW.id IS OLD.id
  AND NEW.task_id IS OLD.task_id
  AND NEW.verdict IS OLD.verdict
  AND NEW.note IS OLD.note
  AND NEW.decided_by IS OLD.decided_by
  AND NEW.decided_at IS OLD.decided_at
)
BEGIN
  SELECT RAISE(ABORT, 'verdicts are append-only: UPDATE is forbidden');
END;

CREATE TRIGGER IF NOT EXISTS workflow_receipts_project_match_insert
BEFORE INSERT ON workflow_receipts
WHEN NEW.project_id IS NOT NULL
 AND NEW.project_id IS NOT (SELECT project_id FROM tasks WHERE id = NEW.task_id)
BEGIN
  SELECT RAISE(ABORT, 'workflow receipt project mismatch');
END;

CREATE TRIGGER IF NOT EXISTS workflow_receipts_project_hydrate_insert
AFTER INSERT ON workflow_receipts
WHEN NEW.project_id IS NULL
BEGIN
  UPDATE workflow_receipts
     SET project_id = (SELECT project_id FROM tasks WHERE id = NEW.task_id)
   WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS workflow_receipts_project_immutable
BEFORE UPDATE OF project_id ON workflow_receipts
WHEN OLD.project_id IS NOT NEW.project_id AND OLD.project_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'workflow receipt project immutable');
END;

CREATE TRIGGER IF NOT EXISTS workflow_receipts_project_match_update
BEFORE UPDATE OF project_id ON workflow_receipts
WHEN NEW.project_id IS NOT (SELECT project_id FROM tasks WHERE id = NEW.task_id)
BEGIN
  SELECT RAISE(ABORT, 'workflow receipt project mismatch');
END;

CREATE TRIGGER IF NOT EXISTS task_dispatch_receipts_project_match_insert
BEFORE INSERT ON task_dispatch_receipts
WHEN NEW.project_id IS NOT NULL
 AND NEW.project_id IS NOT (SELECT project_id FROM tasks WHERE id = NEW.task_id)
BEGIN
  SELECT RAISE(ABORT, 'dispatch receipt project mismatch');
END;

CREATE TRIGGER IF NOT EXISTS task_dispatch_receipts_project_hydrate_insert
AFTER INSERT ON task_dispatch_receipts
WHEN NEW.project_id IS NULL
BEGIN
  UPDATE task_dispatch_receipts
     SET project_id = (SELECT project_id FROM tasks WHERE id = NEW.task_id)
   WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS task_dispatch_receipts_project_immutable
BEFORE UPDATE OF project_id ON task_dispatch_receipts
WHEN OLD.project_id IS NOT NEW.project_id AND OLD.project_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'dispatch receipt project immutable');
END;

CREATE TRIGGER IF NOT EXISTS task_dispatch_receipts_project_match_update
BEFORE UPDATE OF project_id ON task_dispatch_receipts
WHEN NEW.project_id IS NOT (SELECT project_id FROM tasks WHERE id = NEW.task_id)
BEGIN
  SELECT RAISE(ABORT, 'dispatch receipt project mismatch');
END;

CREATE TRIGGER IF NOT EXISTS flight_event_outbox_project_match_insert
BEFORE INSERT ON flight_event_outbox
WHEN NEW.project_id IS NOT NULL
 AND NEW.project_id IS NOT (SELECT project_id FROM flights WHERE id = NEW.flight_id)
BEGIN
  SELECT RAISE(ABORT, 'flight event project mismatch');
END;

CREATE TRIGGER IF NOT EXISTS flight_event_outbox_project_hydrate_insert
AFTER INSERT ON flight_event_outbox
WHEN NEW.project_id IS NULL
BEGIN
  UPDATE flight_event_outbox
     SET project_id = (SELECT project_id FROM flights WHERE id = NEW.flight_id)
   WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS flight_event_outbox_project_immutable
BEFORE UPDATE OF project_id ON flight_event_outbox
WHEN OLD.project_id IS NOT NEW.project_id AND OLD.project_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'flight event project immutable');
END;

CREATE TRIGGER IF NOT EXISTS flight_event_outbox_project_match_update
BEFORE UPDATE OF project_id ON flight_event_outbox
WHEN NEW.project_id IS NOT (SELECT project_id FROM flights WHERE id = NEW.flight_id)
BEGIN
  SELECT RAISE(ABORT, 'flight event project mismatch');
END;

CREATE TRIGGER IF NOT EXISTS tasks_project_locked_by_receipt
BEFORE UPDATE OF project_id ON tasks
WHEN OLD.project_id IS NOT NEW.project_id
 AND (
   EXISTS (SELECT 1 FROM task_verdicts WHERE task_id = OLD.id)
   OR EXISTS (SELECT 1 FROM workflow_receipts WHERE task_id = OLD.id)
   OR EXISTS (SELECT 1 FROM task_dispatch_receipts WHERE task_id = OLD.id)
 )
BEGIN
  SELECT RAISE(ABORT, 'task project locked by flight');
END;

CREATE TRIGGER IF NOT EXISTS flights_project_locked_by_receipt
BEFORE UPDATE OF project_id ON flights
WHEN OLD.project_id IS NOT NEW.project_id
 AND EXISTS (SELECT 1 FROM flight_event_outbox WHERE flight_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'flight project attribution downgrade');
END;
