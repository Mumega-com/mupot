-- 0129_project_worker_platform.sql — dynamic project worker + client deploy engine.
--
-- Each project can bind a GitHub repo, a Cloudflare worker name, a live URL,
-- an assigned squad, and a deploy status. Immutable project_deployments rows
-- are the build receipts (commit SHA, deployment id, URL, timestamp, status).
--
-- Schema only. Default client projects (Viamar, DME) are provisioned by
-- src/projects/client-bootstrap.ts — a migration INSERT would survive the
-- chain and break the applyAllMigrations DDL cache (helpers-migrations.test.ts).

ALTER TABLE projects ADD COLUMN repo_url TEXT;
ALTER TABLE projects ADD COLUMN worker_name TEXT;
ALTER TABLE projects ADD COLUMN live_url TEXT;
ALTER TABLE projects ADD COLUMN assigned_squad_id TEXT REFERENCES squads(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN deploy_status TEXT NOT NULL DEFAULT 'idle'
  CHECK (deploy_status IN ('idle', 'queued', 'deploying', 'healthy', 'failed'));

CREATE TABLE IF NOT EXISTS project_deployments (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  commit_sha     TEXT,
  deployment_id  TEXT NOT NULL,
  url            TEXT,
  status         TEXT NOT NULL
                 CHECK (status IN ('queued', 'deploying', 'healthy', 'failed')),
  dispatched_by  TEXT,
  flight_id      TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_project_deployments_project_created
  ON project_deployments(project_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_projects_assigned_squad
  ON projects(assigned_squad_id)
  WHERE assigned_squad_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_projects_deploy_status
  ON projects(deploy_status);

-- Receipts are append-only. The service never UPDATEs or DELETEs; these
-- triggers close the gap if a raw SQL path tries.
CREATE TRIGGER project_deployments_immutable_update
BEFORE UPDATE ON project_deployments
BEGIN
  SELECT RAISE(ABORT, 'project_deployments immutable');
END;

CREATE TRIGGER project_deployments_immutable_delete
BEFORE DELETE ON project_deployments
BEGIN
  SELECT RAISE(ABORT, 'project_deployments immutable');
END;
