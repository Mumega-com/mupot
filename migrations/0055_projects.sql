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

CREATE TRIGGER validate_tasks_project_id_insert
BEFORE INSERT ON tasks
WHEN NEW.project_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id)
BEGIN
  SELECT RAISE(ABORT, 'unknown project_id');
END;

CREATE TRIGGER validate_tasks_project_id_update
BEFORE UPDATE OF project_id ON tasks
WHEN NEW.project_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id)
BEGIN
  SELECT RAISE(ABORT, 'unknown project_id');
END;

CREATE TRIGGER validate_flights_project_id_insert
BEFORE INSERT ON flights
WHEN NEW.project_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id)
BEGIN
  SELECT RAISE(ABORT, 'unknown project_id');
END;

CREATE TRIGGER validate_flights_project_id_update
BEFORE UPDATE OF project_id ON flights
WHEN NEW.project_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id)
BEGIN
  SELECT RAISE(ABORT, 'unknown project_id');
END;

CREATE INDEX IF NOT EXISTS idx_projects_parent_status
  ON projects(parent_project_id, status);
CREATE INDEX IF NOT EXISTS idx_project_squad_access_squad_project
  ON project_squad_access(squad_id, project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status
  ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_flights_project_status
  ON flights(project_id, status);
