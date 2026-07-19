-- 0060: project ↔ external board bindings (Linear / GitHub Projects / Notion).
--
-- Mupot projects stay pot-native. External boards attach via this join table only.
-- Providers never own project identity, RBAC, flights, gates, or evidence.

CREATE TABLE IF NOT EXISTS project_provider_bindings (
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL
                CHECK (provider IN ('github_projects', 'linear', 'notion')),
  external_id   TEXT NOT NULL,
  connector_id  TEXT,
  meta_json     TEXT NOT NULL DEFAULT '{}',
  synced_at     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, provider),
  CHECK (length(trim(external_id)) BETWEEN 1 AND 500),
  CHECK (json_valid(meta_json))
);

CREATE INDEX IF NOT EXISTS idx_project_provider_bindings_provider_external
  ON project_provider_bindings(provider, external_id);

CREATE TRIGGER IF NOT EXISTS validate_project_provider_bindings_insert
BEFORE INSERT ON project_provider_bindings
BEGIN
  SELECT RAISE(ABORT, 'project provider binding: project not found')
    WHERE NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id);
  SELECT RAISE(ABORT, 'project provider binding: archived project')
    WHERE EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND status = 'archived');
END;

CREATE TRIGGER IF NOT EXISTS validate_project_provider_bindings_update
BEFORE UPDATE ON project_provider_bindings
BEGIN
  SELECT RAISE(ABORT, 'project provider binding: project not found')
    WHERE NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id);
  SELECT RAISE(ABORT, 'project provider binding: archived project')
    WHERE EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND status = 'archived');
END;
