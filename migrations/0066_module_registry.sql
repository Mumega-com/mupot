-- 0066_module_registry.sql — module_registry (mupot Module Kernel, Port 1).
--
-- Design: docs/architecture/mupot-module-kernel.md. mupot Worker + CF primitives are
-- the durable microkernel; every module (agent-system / workflow / surface) registers
-- through this ONE table, heartbeats, and can be deleted at any time without the core
-- losing durability — a dead module just reads 'offline'; the kernel is untouched.
--
-- Port 1 scope: presence. An agent connects, selects the project it is working on,
-- heartbeats, and appears in that project's online roster
-- (GET/MCP presence_list?project_id=<id>).
--
-- DURABILITY (non-negotiable, see design doc "Durability guarantees"):
--   Stale heartbeat -> offline is QUERY-TIME derived, never a cron/sweep. The stored
--   `status` column only carries an EXPLICIT deregister ('offline'); the service layer
--   (src/registry/service.ts#listPresence) additionally treats any row whose
--   last_heartbeat is older than the stale window as effectively offline, with no write
--   required. A dead module simply stops being counted — the kernel never blocks on it.
--
-- UPSERT / uniqueness: one identity has one LIVE registration per (tenant, project).
-- project_id is nullable (no project selected yet); SQLite treats each NULL as DISTINCT
-- in a plain UNIQUE index, which would let a "no project" registration duplicate. The
-- generated `project_key` column normalizes NULL -> '' so the unique index (and the
-- upsert's ON CONFLICT target) treats "no project" as one identity bucket, same as any
-- other project — re-registering the same identity+project always upserts in place,
-- never inserts a duplicate row. See src/registry/service.ts#registerModule.

CREATE TABLE IF NOT EXISTS module_registry (
  id              TEXT NOT NULL PRIMARY KEY,
  tenant          TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('agent_system', 'workflow', 'surface')),
  adapter         TEXT NOT NULL CHECK (length(adapter) BETWEEN 1 AND 64),
  project_id      TEXT REFERENCES projects(id),
  -- Generated (never written directly): NULL project_id normalizes to '' so the
  -- unique index below treats "no project selected" as one consistent identity bucket.
  project_key     TEXT NOT NULL GENERATED ALWAYS AS (COALESCE(project_id, '')) STORED,
  identity        TEXT NOT NULL CHECK (length(identity) BETWEEN 1 AND 200),
  status          TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'offline')),
  capabilities    TEXT NOT NULL DEFAULT '[]' CHECK (
                    json_valid(capabilities) AND json_type(capabilities) = 'array'
                  ),
  last_heartbeat  TEXT NOT NULL,
  registered_at   TEXT NOT NULL
);

-- One live registration per identity per (tenant, project) — the upsert target.
CREATE UNIQUE INDEX IF NOT EXISTS idx_module_registry_identity_live
  ON module_registry (tenant, identity, project_key);

-- The roster read: "who is online, scoped to this project."
CREATE INDEX IF NOT EXISTS idx_module_registry_tenant_project_status
  ON module_registry (tenant, project_id, status);

-- Self-lookup: "what is MY current registration(s)."
CREATE INDEX IF NOT EXISTS idx_module_registry_tenant_identity
  ON module_registry (tenant, identity);
