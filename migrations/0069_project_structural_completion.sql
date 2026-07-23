-- 0069_project_structural_completion.sql — project lifecycle slice 2.
--
-- Design: docs/superpowers/specs/2026-07-23-project-lifecycle-control-loop-design.md
--
-- Widen projects.status CHECK to include 'review' and add completion_proposed_by
-- for different-principal self-verdict blocking. D1 cannot ALTER CHECK; recreate
-- the table. Triggers on OTHER tables that SELECT FROM projects must be dropped
-- before RENAME (SQLite recompiles them and fails with "no such table: projects")
-- then restored. Pattern mirrors 0049_agent_status_inactive.sql backups.

PRAGMA foreign_keys = off;

DROP TRIGGER IF EXISTS trg_project_link_receipt_authorized;
DROP TRIGGER IF EXISTS validate_agent_messages_project_insert;
DROP TRIGGER IF EXISTS validate_flights_project_id_insert;
DROP TRIGGER IF EXISTS validate_flights_project_id_update;
DROP TRIGGER IF EXISTS validate_project_provider_bindings_insert;
DROP TRIGGER IF EXISTS validate_project_provider_bindings_update;
DROP TRIGGER IF EXISTS validate_project_squad_access_delete;
DROP TRIGGER IF EXISTS validate_project_squad_access_insert;
DROP TRIGGER IF EXISTS validate_project_squad_access_update;
DROP TRIGGER IF EXISTS validate_tasks_project_id_insert;
DROP TRIGGER IF EXISTS validate_tasks_project_id_update;

CREATE TABLE _projects_backup_0069 AS SELECT * FROM projects;
CREATE TABLE _project_squad_access_backup_0069 AS SELECT * FROM project_squad_access;
CREATE TABLE _project_provider_bindings_backup_0069 AS SELECT * FROM project_provider_bindings;
CREATE TABLE _project_links_backup_0069 AS SELECT * FROM project_links;
CREATE TABLE _project_link_receipts_backup_0069 AS SELECT * FROM project_link_receipts;
-- Exclude GENERATED project_key (STORED) — SELECT * would copy it and break restore.
CREATE TABLE _module_registry_backup_0069 AS
  SELECT id, tenant, kind, adapter, project_id, identity, status, capabilities,
         last_heartbeat, registered_at
    FROM module_registry;
CREATE TABLE _task_verdicts_project_backup_0069 AS
  SELECT id, project_id FROM task_verdicts WHERE project_id IS NOT NULL;
CREATE TABLE _workflow_receipts_project_backup_0069 AS
  SELECT id, project_id FROM workflow_receipts WHERE project_id IS NOT NULL;
CREATE TABLE _task_dispatch_receipts_project_backup_0069 AS
  SELECT id, project_id FROM task_dispatch_receipts WHERE project_id IS NOT NULL;
CREATE TABLE _flight_event_outbox_project_backup_0069 AS
  SELECT id, project_id FROM flight_event_outbox WHERE project_id IS NOT NULL;

UPDATE task_verdicts SET project_id = NULL WHERE project_id IS NOT NULL;
UPDATE workflow_receipts SET project_id = NULL WHERE project_id IS NOT NULL;
UPDATE task_dispatch_receipts SET project_id = NULL WHERE project_id IS NOT NULL;
UPDATE flight_event_outbox SET project_id = NULL WHERE project_id IS NOT NULL;
UPDATE module_registry SET project_id = NULL WHERE project_id IS NOT NULL;

DELETE FROM project_link_receipts;
DELETE FROM project_links;
DELETE FROM project_provider_bindings;
DELETE FROM project_squad_access;
DELETE FROM projects;

CREATE TABLE projects_new (
  id                     TEXT PRIMARY KEY,
  slug                   TEXT NOT NULL UNIQUE,
  name                   TEXT NOT NULL,
  description            TEXT NOT NULL DEFAULT '',
  goal                   TEXT NOT NULL DEFAULT '',
  status                 TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('planned','active','paused','review','completed','archived')),
  parent_project_id      TEXT REFERENCES projects_new(id) ON DELETE RESTRICT,
  target_date            TEXT,
  cycle_boundary_at      TEXT,
  stalled                INTEGER NOT NULL DEFAULT 0,
  stall_threshold_days   INTEGER,
  completion_proposed_by TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (parent_project_id IS NULL OR parent_project_id <> id)
);

INSERT INTO projects_new (
  id, slug, name, description, goal, status, parent_project_id, target_date,
  cycle_boundary_at, stalled, stall_threshold_days, completion_proposed_by,
  created_at, updated_at
)
SELECT
  id, slug, name, description, goal, status, NULL, target_date,
  cycle_boundary_at, stalled, stall_threshold_days, NULL,
  created_at, updated_at
FROM _projects_backup_0069;

DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;

UPDATE projects
SET parent_project_id = (
  SELECT b.parent_project_id FROM _projects_backup_0069 b WHERE b.id = projects.id
)
WHERE EXISTS (
  SELECT 1 FROM _projects_backup_0069 b
  WHERE b.id = projects.id AND b.parent_project_id IS NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_parent_status
  ON projects(parent_project_id, status);
CREATE INDEX IF NOT EXISTS idx_projects_cycle_boundary
  ON projects (cycle_boundary_at)
  WHERE cycle_boundary_at IS NOT NULL AND status NOT IN ('completed', 'archived');

CREATE TRIGGER validate_projects_archive_status
BEFORE UPDATE OF status ON projects
WHEN NEW.status = 'archived'
 AND OLD.status <> 'archived'
 AND EXISTS (
   SELECT 1 FROM projects
   WHERE parent_project_id = NEW.id AND status <> 'archived'
 )
BEGIN
  SELECT RAISE(ABORT, 'active child projects');
END;

CREATE TRIGGER validate_projects_parent_insert
BEFORE INSERT ON projects
WHEN NEW.parent_project_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'project hierarchy cycle')
    WHERE NEW.parent_project_id = NEW.id;
  SELECT RAISE(ABORT, 'parent project not found')
    WHERE NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.parent_project_id);
  SELECT RAISE(ABORT, 'archived parent project')
    WHERE EXISTS (SELECT 1 FROM projects WHERE id = NEW.parent_project_id AND status = 'archived');
  SELECT RAISE(ABORT, 'project hierarchy depth')
    WHERE EXISTS (SELECT 1 FROM projects WHERE id = NEW.parent_project_id AND parent_project_id IS NOT NULL);
END;

CREATE TRIGGER validate_projects_parent_update
BEFORE UPDATE OF parent_project_id ON projects
WHEN NEW.parent_project_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'project hierarchy cycle')
    WHERE NEW.parent_project_id = NEW.id;
  SELECT RAISE(ABORT, 'parent project not found')
    WHERE NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.parent_project_id);
  SELECT RAISE(ABORT, 'archived parent project')
    WHERE EXISTS (SELECT 1 FROM projects WHERE id = NEW.parent_project_id AND status = 'archived');
  SELECT RAISE(ABORT, 'project hierarchy cycle')
  WHERE EXISTS (
    WITH RECURSIVE ancestors(id, parent_project_id) AS (
      SELECT id, parent_project_id FROM projects WHERE id = NEW.parent_project_id
      UNION ALL
      SELECT projects.id, projects.parent_project_id
      FROM projects JOIN ancestors ON projects.id = ancestors.parent_project_id
    )
    SELECT 1 FROM ancestors WHERE id = NEW.id
  );
  SELECT RAISE(ABORT, 'project hierarchy depth')
    WHERE EXISTS (SELECT 1 FROM projects WHERE id = NEW.parent_project_id AND parent_project_id IS NOT NULL);
  SELECT RAISE(ABORT, 'project hierarchy depth')
    WHERE EXISTS (SELECT 1 FROM projects WHERE parent_project_id = NEW.id);
END;

CREATE TRIGGER validate_projects_restore_status
BEFORE UPDATE OF status ON projects
WHEN OLD.status = 'archived'
 AND NEW.status <> 'archived'
 AND NEW.parent_project_id IS NOT NULL
 AND EXISTS (
   SELECT 1 FROM projects
   WHERE id = NEW.parent_project_id AND status = 'archived'
 )
BEGIN
  SELECT RAISE(ABORT, 'archived parent project');
END;

INSERT INTO project_squad_access SELECT * FROM _project_squad_access_backup_0069;
INSERT INTO project_provider_bindings SELECT * FROM _project_provider_bindings_backup_0069;
INSERT INTO project_links SELECT * FROM _project_links_backup_0069;
INSERT INTO project_link_receipts SELECT * FROM _project_link_receipts_backup_0069;
INSERT INTO module_registry (
  id, tenant, kind, adapter, project_id, identity, status, capabilities,
  last_heartbeat, registered_at
)
SELECT
  id, tenant, kind, adapter, project_id, identity, status, capabilities,
  last_heartbeat, registered_at
FROM _module_registry_backup_0069;

UPDATE task_verdicts
SET project_id = (
  SELECT b.project_id FROM _task_verdicts_project_backup_0069 b WHERE b.id = task_verdicts.id
)
WHERE EXISTS (SELECT 1 FROM _task_verdicts_project_backup_0069 b WHERE b.id = task_verdicts.id);

UPDATE workflow_receipts
SET project_id = (
  SELECT b.project_id FROM _workflow_receipts_project_backup_0069 b WHERE b.id = workflow_receipts.id
)
WHERE EXISTS (SELECT 1 FROM _workflow_receipts_project_backup_0069 b WHERE b.id = workflow_receipts.id);

UPDATE task_dispatch_receipts
SET project_id = (
  SELECT b.project_id FROM _task_dispatch_receipts_project_backup_0069 b WHERE b.id = task_dispatch_receipts.id
)
WHERE EXISTS (SELECT 1 FROM _task_dispatch_receipts_project_backup_0069 b WHERE b.id = task_dispatch_receipts.id);

UPDATE flight_event_outbox
SET project_id = (
  SELECT b.project_id FROM _flight_event_outbox_project_backup_0069 b WHERE b.id = flight_event_outbox.id
)
WHERE EXISTS (SELECT 1 FROM _flight_event_outbox_project_backup_0069 b WHERE b.id = flight_event_outbox.id);

CREATE TRIGGER trg_project_link_receipt_authorized
BEFORE INSERT ON project_link_receipts
BEGIN
  SELECT RAISE(ABORT, 'project_link_not_authorized') WHERE NOT EXISTS (
    SELECT 1
      FROM project_links l
      JOIN projects p ON p.id = l.local_project_id
      JOIN project_squad_access a
        ON a.project_id = l.local_project_id AND a.squad_id = l.local_squad_id
     WHERE l.tenant = NEW.tenant
       AND l.id = NEW.link_id
       AND l.local_project_id = NEW.local_project_id
       AND l.state = 'active'
       AND p.status <> 'archived'
       AND a.access_level IN ('write', 'admin')
       AND EXISTS (
         SELECT 1 FROM json_each(l.capabilities_json)
          WHERE value = CASE NEW.action_type
            WHEN 'task' THEN 'project.task.write'
            ELSE 'project.evidence.write'
          END
       )
       AND (
         SELECT state FROM addon_installations
          WHERE tenant = NEW.tenant AND addon_key = 'project-link'
          ORDER BY installed_at DESC, id DESC LIMIT 1
       ) = 'active'
       AND (
         NEW.direction <> 'outbound'
         OR EXISTS (
           SELECT 1 FROM project_link_deliveries d
            WHERE d.tenant = NEW.tenant
              AND d.link_id = NEW.link_id
              AND d.direction = 'outbound'
              AND d.idempotency_key = NEW.idempotency_key
              AND d.envelope_sha256 = NEW.envelope_sha256
              AND d.status = 'delivered'
              AND d.claim_token = NEW.delivery_claim_token
         )
       )
  );
END;

CREATE TRIGGER validate_agent_messages_project_insert
BEFORE INSERT ON agent_messages
WHEN NEW.project_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'message project not found')
    WHERE NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id);
  SELECT RAISE(ABORT, 'message project archived')
    WHERE EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND status = 'archived');
END;

CREATE TRIGGER validate_flights_project_id_insert
BEFORE INSERT ON flights
BEGIN
  SELECT RAISE(ABORT, 'flight project not found')
    WHERE NEW.project_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id);
  SELECT RAISE(ABORT, 'flight project archived')
    WHERE NEW.project_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND status = 'archived');
  SELECT RAISE(ABORT, 'flight meta invalid')
  WHERE NEW.project_id IS NOT NULL
    AND json_extract(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
    AND (
      json_type(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.squad_ids') IS NOT 'array'
      OR COALESCE(json_array_length(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.squad_ids'), 0) NOT BETWEEN 1 AND 8
      OR EXISTS (
        SELECT 1
        FROM json_each(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.squad_ids') AS squad_ref
        WHERE squad_ref.type <> 'text'
           OR length(squad_ref.value) NOT BETWEEN 1 AND 200
           OR length(trim(squad_ref.value)) = 0
      )
      OR json_type(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.task_ids') IS NOT 'array'
      OR COALESCE(json_array_length(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.task_ids'), 0) NOT BETWEEN 1 AND 200
      OR EXISTS (
        SELECT 1
        FROM json_each(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.task_ids') AS task_ref
        WHERE task_ref.type <> 'text'
           OR length(task_ref.value) NOT BETWEEN 1 AND 200
           OR length(trim(task_ref.value)) = 0
      )
    );
  SELECT RAISE(ABORT, 'flight project access denied')
  WHERE NEW.project_id IS NOT NULL
    AND json_extract(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
    AND EXISTS (
      SELECT 1
      FROM json_each(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.squad_ids') AS squad_ref
      LEFT JOIN project_squad_access AS access
        ON access.project_id = NEW.project_id
       AND access.squad_id = squad_ref.value
       AND access.access_level IN ('write', 'admin')
      WHERE access.squad_id IS NULL
    );
  SELECT RAISE(ABORT, 'flight task not found')
  WHERE NEW.project_id IS NOT NULL
    AND json_valid(NEW.meta)
    AND json_extract(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
    AND EXISTS (
      SELECT 1
      FROM json_each(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.task_ids') AS task_ref
      LEFT JOIN tasks ON tasks.id = task_ref.value
      WHERE tasks.id IS NULL
    );
  SELECT RAISE(ABORT, 'flight task project mismatch')
  WHERE NEW.project_id IS NOT NULL
    AND json_valid(NEW.meta)
    AND json_extract(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
    AND EXISTS (
      SELECT 1
      FROM json_each(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.task_ids') AS task_ref
      JOIN tasks ON tasks.id = task_ref.value
      WHERE tasks.project_id IS NOT NEW.project_id
    );
END;

CREATE TRIGGER validate_flights_project_id_update
BEFORE UPDATE OF project_id, meta ON flights
BEGIN
  SELECT RAISE(ABORT, 'flight project attribution downgrade')
  WHERE OLD.project_id IS NOT NULL
    AND json_extract(CASE WHEN json_valid(OLD.meta) THEN OLD.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
    AND (
      NEW.project_id IS NULL
      OR json_extract(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.schema') IS NOT 'mupot.flight.meta/v1'
    );
  SELECT RAISE(ABORT, 'flight meta invalid')
  WHERE (
      json_extract(CASE WHEN json_valid(OLD.meta) THEN OLD.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
      OR json_extract(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
    )
    AND (
      NOT json_valid(NEW.meta)
      OR json_type(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.squad_ids') IS NOT 'array'
      OR COALESCE(json_array_length(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.squad_ids'), 0) NOT BETWEEN 1 AND 8
      OR EXISTS (
        SELECT 1
        FROM json_each(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.squad_ids') AS squad_ref
        WHERE squad_ref.type <> 'text'
           OR length(squad_ref.value) NOT BETWEEN 1 AND 200
           OR length(trim(squad_ref.value)) = 0
      )
      OR json_type(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.task_ids') IS NOT 'array'
      OR COALESCE(json_array_length(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.task_ids'), 0) NOT BETWEEN 1 AND 200
      OR EXISTS (
        SELECT 1
        FROM json_each(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.task_ids') AS task_ref
        WHERE task_ref.type <> 'text'
           OR length(task_ref.value) NOT BETWEEN 1 AND 200
           OR length(trim(task_ref.value)) = 0
      )
    );
  SELECT RAISE(ABORT, 'flight project not found')
    WHERE NEW.project_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id);
  SELECT RAISE(ABORT, 'flight project archived')
    WHERE NEW.project_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND status = 'archived');
  SELECT RAISE(ABORT, 'flight project access denied')
  WHERE NEW.project_id IS NOT NULL
    AND (
      json_extract(CASE WHEN json_valid(OLD.meta) THEN OLD.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
      OR json_extract(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
    )
    AND EXISTS (
      SELECT 1
      FROM json_each(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.squad_ids') AS squad_ref
      LEFT JOIN project_squad_access AS access
        ON access.project_id = NEW.project_id
       AND access.squad_id = squad_ref.value
       AND access.access_level IN ('write', 'admin')
      WHERE access.squad_id IS NULL
    );
  SELECT RAISE(ABORT, 'flight task not found')
  WHERE NEW.project_id IS NOT NULL
    AND (
      json_extract(CASE WHEN json_valid(OLD.meta) THEN OLD.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
      OR json_extract(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
    )
    AND EXISTS (
      SELECT 1
      FROM json_each(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.task_ids') AS task_ref
      LEFT JOIN tasks ON tasks.id = task_ref.value
      WHERE tasks.id IS NULL
    );
  SELECT RAISE(ABORT, 'flight task project mismatch')
  WHERE NEW.project_id IS NOT NULL
    AND (
      json_extract(CASE WHEN json_valid(OLD.meta) THEN OLD.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
      OR json_extract(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
    )
    AND EXISTS (
      SELECT 1
      FROM json_each(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.task_ids') AS task_ref
      JOIN tasks ON tasks.id = task_ref.value
      WHERE tasks.project_id IS NOT NEW.project_id
    );
END;

CREATE TRIGGER validate_project_provider_bindings_insert
BEFORE INSERT ON project_provider_bindings
BEGIN
  SELECT RAISE(ABORT, 'project provider binding: project not found')
    WHERE NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id);
  SELECT RAISE(ABORT, 'project provider binding: archived project')
    WHERE EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND status = 'archived');
END;

CREATE TRIGGER validate_project_provider_bindings_update
BEFORE UPDATE ON project_provider_bindings
BEGIN
  SELECT RAISE(ABORT, 'project provider binding: project not found')
    WHERE NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id);
  SELECT RAISE(ABORT, 'project provider binding: archived project')
    WHERE EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND status = 'archived');
END;

CREATE TRIGGER validate_project_squad_access_delete
BEFORE DELETE ON project_squad_access
WHEN EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id AND status = 'archived')
BEGIN
  SELECT RAISE(ABORT, 'archived project squad access');
END;

CREATE TRIGGER validate_project_squad_access_insert
BEFORE INSERT ON project_squad_access
WHEN EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND status = 'archived')
BEGIN
  SELECT RAISE(ABORT, 'archived project squad access');
END;

CREATE TRIGGER validate_project_squad_access_update
BEFORE UPDATE ON project_squad_access
WHEN EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id AND status = 'archived')
  OR EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND status = 'archived')
BEGIN
  SELECT RAISE(ABORT, 'archived project squad access');
END;

CREATE TRIGGER validate_tasks_project_id_insert
BEFORE INSERT ON tasks
BEGIN
  SELECT RAISE(ABORT, 'task project not found')
    WHERE NEW.project_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id);
  SELECT RAISE(ABORT, 'task project archived')
    WHERE NEW.project_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND status = 'archived');
  SELECT RAISE(ABORT, 'task project access denied')
  WHERE NEW.project_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM project_squad_access
      WHERE project_id = NEW.project_id
        AND squad_id = NEW.squad_id
        AND access_level IN ('write', 'admin')
    );
END;

CREATE TRIGGER validate_tasks_project_id_update
BEFORE UPDATE OF
  squad_id,
  project_id
ON tasks
BEGIN
  SELECT RAISE(ABORT, 'task project locked by flight')
  WHERE OLD.project_id IS NOT NEW.project_id
    AND EXISTS (
      SELECT 1
      FROM flights AS flight,
           json_each(CASE WHEN json_valid(flight.meta) THEN flight.meta ELSE '{}' END, '$.task_ids') AS task_ref
      WHERE flight.project_id IS NOT NULL
        AND json_extract(CASE WHEN json_valid(flight.meta) THEN flight.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
        AND task_ref.value = OLD.id
    );
  SELECT RAISE(ABORT, 'task project not found')
    WHERE NEW.project_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id);
  SELECT RAISE(ABORT, 'task project archived')
    WHERE NEW.project_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND status = 'archived');
  SELECT RAISE(ABORT, 'task project access denied')
  WHERE NEW.project_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM project_squad_access
      WHERE project_id = NEW.project_id
        AND squad_id = NEW.squad_id
        AND access_level IN ('write', 'admin')
    );
END;

DROP TABLE _projects_backup_0069;
DROP TABLE _project_squad_access_backup_0069;
DROP TABLE _project_provider_bindings_backup_0069;
DROP TABLE _project_links_backup_0069;
DROP TABLE _project_link_receipts_backup_0069;
DROP TABLE _module_registry_backup_0069;
DROP TABLE _task_verdicts_project_backup_0069;
DROP TABLE _workflow_receipts_project_backup_0069;
DROP TABLE _task_dispatch_receipts_project_backup_0069;
DROP TABLE _flight_event_outbox_project_backup_0069;

PRAGMA foreign_keys = on;
