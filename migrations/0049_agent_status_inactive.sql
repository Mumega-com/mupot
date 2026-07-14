-- 0049_agent_status_inactive.sql — add 'inactive' to the agents.status enum.
--
-- deactivate_agent (src/mcp/provision.ts) needs a SOFT, reversible retirement
-- flag distinct from 'paused'. 'paused' already has an established, different
-- meaning in this codebase — a manual, trivially-reversible toggle exposed via
-- the dashboard (POST /agents/:id/status, src/dashboard/index.ts) and read by
-- the wake path (src/mcp/index.ts, src/im/index.ts, src/channels/index.ts:
-- "agent.status !== 'active' → paused; can't wake it"). Reusing 'paused' for
-- deactivation would let the existing pause/resume toggle silently "reactivate"
-- a deactivated agent without redoing the credential-revocation deactivate_agent
-- performs, and would conflate two different operator intents (temporarily
-- resting vs. retiring a dead/junk identity) under one status value.
--
-- D1 does not allow adding/altering a CHECK constraint via ALTER TABLE; recreate
-- the table with the widened CHECK and copy all live rows, following the
-- established pattern in 0020_oauth_channel.sql (member_tokens.channel) and
-- 0042_task_status_gate_values.sql (tasks.status) — with ONE critical addition.
--
-- agents is a PARENT table: memberships.agent_id references it ON DELETE
-- CASCADE and tasks.assignee_agent_id references it ON DELETE SET NULL.
-- `wrangler d1 migrations apply` runs this entire file inside a single
-- transaction, and SQLite documents `PRAGMA foreign_keys` as a no-op while a
-- transaction is open (enforcement can only change with no pending BEGIN).
-- `PRAGMA defer_foreign_keys = on` does not help either — it only defers
-- *checking*, not the CASCADE/SET NULL actions themselves. So the pragma
-- toggle below is NOT sufficient here (unlike 0020/0042, which recreate
-- tables that are not themselves referenced by any other table's FK): FK
-- enforcement stays ON through `DROP TABLE agents`, and the implicit
-- CASCADE/SET NULL fires for every membership and task-assignment row on
-- every pot, once, at deploy. Verified empirically against real D1
-- (miniflare + node:sqlite both mirror SQLite's C implementation here).
--
-- Fix: back up the referencing rows before the drop and restore them after
-- the rename, instead of relying on the pragma to protect them.
--
-- Plain (non-TEMP) tables: D1's SQL authorizer rejects `CREATE TEMP TABLE`
-- outright (SQLITE_AUTH) both locally and against remote D1 — verified
-- empirically via `wrangler d1 execute --local`. Ordinary tables, dropped at
-- the end of this same migration transaction, are the permitted equivalent.

PRAGMA foreign_keys = off;

-- Snapshot every row that references agents.id — DROP TABLE agents below
-- will CASCADE/SET NULL them regardless of the pragma above.
CREATE TABLE _agents_memberships_backup_0049 AS SELECT * FROM memberships;
CREATE TABLE _agents_tasks_assignee_backup_0049 AS
  SELECT id, assignee_agent_id FROM tasks WHERE assignee_agent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agents_new (
  id                TEXT PRIMARY KEY,
  squad_id          TEXT NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  slug              TEXT NOT NULL,
  name              TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'member',
  model             TEXT NOT NULL DEFAULT '@cf/meta/llama-3.3',
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','inactive')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  okr               TEXT,
  kpi_target        TEXT,
  kpi_progress      REAL    NOT NULL DEFAULT 0,
  effort            TEXT    NOT NULL DEFAULT 'standard',
  autonomy          TEXT    NOT NULL DEFAULT 'draft',
  budget_cap_cents  INTEGER,
  budget_window     TEXT    NOT NULL DEFAULT 'week',
  UNIQUE(squad_id, slug)
);

INSERT INTO agents_new (
  id, squad_id, slug, name, role, model, status, created_at,
  okr, kpi_target, kpi_progress, effort, autonomy, budget_cap_cents, budget_window
)
SELECT
  id, squad_id, slug, name, role, model, status, created_at,
  okr, kpi_target, kpi_progress, effort, autonomy, budget_cap_cents, budget_window
FROM agents;

DROP TABLE agents;
ALTER TABLE agents_new RENAME TO agents;

CREATE INDEX IF NOT EXISTS idx_agents_squad ON agents(squad_id);

-- Restore what the DROP's CASCADE/SET NULL wiped. The agents rows above were
-- copied 1:1 (same ids), so the FKs are satisfied again and these inserts /
-- updates succeed cleanly.
INSERT INTO memberships (id, agent_id, squad_id, capability)
  SELECT id, agent_id, squad_id, capability FROM _agents_memberships_backup_0049;

UPDATE tasks
SET assignee_agent_id = (
  SELECT b.assignee_agent_id FROM _agents_tasks_assignee_backup_0049 b WHERE b.id = tasks.id
)
WHERE assignee_agent_id IS NULL
  AND id IN (SELECT id FROM _agents_tasks_assignee_backup_0049);

DROP TABLE _agents_memberships_backup_0049;
DROP TABLE _agents_tasks_assignee_backup_0049;

PRAGMA foreign_keys = on;
