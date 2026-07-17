-- 0055_projects.sql — durable project context and explicit squad access.
--
-- Existing tasks and flights remain valid without attribution. SQLite cannot
-- safely add a REFERENCES column to an existing table, so project attribution
-- uses nullable TEXT plus validation triggers instead.

CREATE TABLE IF NOT EXISTS projects (
  id                TEXT PRIMARY KEY,
  slug              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  goal              TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('planned','active','paused','completed','archived')),
  parent_project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  target_date       TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (parent_project_id IS NULL OR parent_project_id <> id)
);

CREATE TABLE IF NOT EXISTS project_squad_access (
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  squad_id     TEXT NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  access_level TEXT NOT NULL DEFAULT 'write'
               CHECK (access_level IN ('read','write','admin')),
  granted_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, squad_id)
);

ALTER TABLE tasks ADD COLUMN project_id TEXT;
ALTER TABLE flights ADD COLUMN project_id TEXT;

-- The service returns stable domain errors, but these triggers close the gap
-- between its validation reads and the durable INSERT/UPDATE write.
CREATE TRIGGER validate_projects_parent_insert
BEFORE INSERT ON projects
WHEN NEW.parent_project_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.parent_project_id = NEW.id
    THEN RAISE(ABORT, 'project hierarchy cycle') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.parent_project_id)
    THEN RAISE(ABORT, 'parent project not found') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM projects WHERE id = NEW.parent_project_id AND status = 'archived')
    THEN RAISE(ABORT, 'archived parent project') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM projects WHERE id = NEW.parent_project_id AND parent_project_id IS NOT NULL)
    THEN RAISE(ABORT, 'project hierarchy depth') END;
END;

CREATE TRIGGER validate_projects_parent_update
BEFORE UPDATE OF parent_project_id ON projects
WHEN NEW.parent_project_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.parent_project_id = NEW.id
    THEN RAISE(ABORT, 'project hierarchy cycle') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.parent_project_id)
    THEN RAISE(ABORT, 'parent project not found') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM projects WHERE id = NEW.parent_project_id AND status = 'archived')
    THEN RAISE(ABORT, 'archived parent project') END;
  SELECT CASE WHEN EXISTS (
    WITH RECURSIVE ancestors(id, parent_project_id) AS (
      SELECT id, parent_project_id FROM projects WHERE id = NEW.parent_project_id
      UNION ALL
      SELECT projects.id, projects.parent_project_id
      FROM projects JOIN ancestors ON projects.id = ancestors.parent_project_id
    )
    SELECT 1 FROM ancestors WHERE id = NEW.id
  ) THEN RAISE(ABORT, 'project hierarchy cycle') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM projects WHERE id = NEW.parent_project_id AND parent_project_id IS NOT NULL)
    THEN RAISE(ABORT, 'project hierarchy depth') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM projects WHERE parent_project_id = NEW.id)
    THEN RAISE(ABORT, 'project hierarchy depth') END;
END;

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

CREATE TRIGGER validate_project_squad_access_delete
BEFORE DELETE ON project_squad_access
WHEN EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id AND status = 'archived')
BEGIN
  SELECT RAISE(ABORT, 'archived project squad access');
END;

CREATE TRIGGER validate_tasks_project_id_insert
BEFORE INSERT ON tasks
BEGIN
  SELECT CASE WHEN NEW.project_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id)
    THEN RAISE(ABORT, 'task project not found') END;
  SELECT CASE WHEN NEW.project_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND status = 'archived')
    THEN RAISE(ABORT, 'task project archived') END;
  SELECT CASE WHEN NEW.project_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM project_squad_access
      WHERE project_id = NEW.project_id
        AND squad_id = NEW.squad_id
        AND access_level IN ('write', 'admin')
    ) THEN RAISE(ABORT, 'task project access denied') END;
END;

CREATE TRIGGER validate_tasks_project_id_update
BEFORE UPDATE OF
  squad_id,
  project_id,
  title,
  body,
  done_when,
  status,
  assignee_agent_id,
  result,
  completed_at,
  gate_owner,
  cost_micro_usd,
  workflow_instance_id,
  execution_receipt_id,
  execution_claim_expires_at
ON tasks
BEGIN
  SELECT CASE WHEN OLD.project_id IS NOT NEW.project_id
    AND EXISTS (
      SELECT 1
      FROM flights AS flight,
           json_each(CASE WHEN json_valid(flight.meta) THEN flight.meta ELSE '{}' END, '$.task_ids') AS task_ref
      WHERE flight.project_id IS NOT NULL
        AND json_extract(CASE WHEN json_valid(flight.meta) THEN flight.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
        AND task_ref.value = OLD.id
    ) THEN RAISE(ABORT, 'task project locked by flight') END;
  SELECT CASE WHEN NEW.project_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id)
    THEN RAISE(ABORT, 'task project not found') END;
  SELECT CASE WHEN NEW.project_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND status = 'archived')
    THEN RAISE(ABORT, 'task project archived') END;
  SELECT CASE WHEN NEW.project_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM project_squad_access
      WHERE project_id = NEW.project_id
        AND squad_id = NEW.squad_id
        AND access_level IN ('write', 'admin')
    ) THEN RAISE(ABORT, 'task project access denied') END;
END;

CREATE TRIGGER validate_flights_project_id_insert
BEFORE INSERT ON flights
BEGIN
  SELECT CASE WHEN NEW.project_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id)
    THEN RAISE(ABORT, 'flight project not found') END;
  SELECT CASE WHEN NEW.project_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND status = 'archived')
    THEN RAISE(ABORT, 'flight project archived') END;
  SELECT CASE WHEN NEW.project_id IS NOT NULL
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
    ) THEN RAISE(ABORT, 'flight meta invalid') END;
  SELECT CASE WHEN NEW.project_id IS NOT NULL
    AND json_extract(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
    AND EXISTS (
      SELECT 1
      FROM json_each(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.squad_ids') AS squad_ref
      LEFT JOIN project_squad_access AS access
        ON access.project_id = NEW.project_id
       AND access.squad_id = squad_ref.value
       AND access.access_level IN ('write', 'admin')
      WHERE access.squad_id IS NULL
    ) THEN RAISE(ABORT, 'flight project access denied') END;
  SELECT CASE WHEN NEW.project_id IS NOT NULL
    AND json_valid(NEW.meta)
    AND json_extract(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
    AND EXISTS (
      SELECT 1
      FROM json_each(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.task_ids') AS task_ref
      LEFT JOIN tasks ON tasks.id = task_ref.value
      WHERE tasks.id IS NULL
    ) THEN RAISE(ABORT, 'flight task not found') END;
  SELECT CASE WHEN NEW.project_id IS NOT NULL
    AND json_valid(NEW.meta)
    AND json_extract(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
    AND EXISTS (
      SELECT 1
      FROM json_each(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.task_ids') AS task_ref
      JOIN tasks ON tasks.id = task_ref.value
      WHERE tasks.project_id IS NOT NEW.project_id
    ) THEN RAISE(ABORT, 'flight task project mismatch') END;
END;

CREATE TRIGGER validate_flights_project_id_update
BEFORE UPDATE OF project_id, meta ON flights
BEGIN
  SELECT CASE WHEN OLD.project_id IS NOT NULL
    AND json_extract(CASE WHEN json_valid(OLD.meta) THEN OLD.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
    AND (
      NEW.project_id IS NULL
      OR json_extract(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.schema') IS NOT 'mupot.flight.meta/v1'
    ) THEN RAISE(ABORT, 'flight project attribution downgrade') END;
  SELECT CASE WHEN (
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
    ) THEN RAISE(ABORT, 'flight meta invalid') END;
  SELECT CASE WHEN NEW.project_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id)
    THEN RAISE(ABORT, 'flight project not found') END;
  SELECT CASE WHEN NEW.project_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND status = 'archived')
    THEN RAISE(ABORT, 'flight project archived') END;
  SELECT CASE WHEN NEW.project_id IS NOT NULL
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
    ) THEN RAISE(ABORT, 'flight project access denied') END;
  SELECT CASE WHEN NEW.project_id IS NOT NULL
    AND (
      json_extract(CASE WHEN json_valid(OLD.meta) THEN OLD.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
      OR json_extract(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
    )
    AND EXISTS (
      SELECT 1
      FROM json_each(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.task_ids') AS task_ref
      LEFT JOIN tasks ON tasks.id = task_ref.value
      WHERE tasks.id IS NULL
    ) THEN RAISE(ABORT, 'flight task not found') END;
  SELECT CASE WHEN NEW.project_id IS NOT NULL
    AND (
      json_extract(CASE WHEN json_valid(OLD.meta) THEN OLD.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
      OR json_extract(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
    )
    AND EXISTS (
      SELECT 1
      FROM json_each(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.task_ids') AS task_ref
      JOIN tasks ON tasks.id = task_ref.value
      WHERE tasks.project_id IS NOT NEW.project_id
    ) THEN RAISE(ABORT, 'flight task project mismatch') END;
END;

CREATE INDEX IF NOT EXISTS idx_projects_parent_status
  ON projects(parent_project_id, status);
CREATE INDEX IF NOT EXISTS idx_project_squad_access_squad_project
  ON project_squad_access(squad_id, project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status
  ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_flights_project_status
  ON flights(project_id, status);
