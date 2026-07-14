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
-- the table with the widened CHECK and copy all live rows, exactly mirroring
-- the established pattern in 0020_oauth_channel.sql (member_tokens.channel) and
-- 0042_task_status_gate_values.sql (tasks.status) — including the foreign_keys
-- pragma toggle from 0042, since agents.id is referenced by memberships.agent_id
-- (ON DELETE CASCADE) and tasks.assignee_agent_id (ON DELETE SET NULL).

PRAGMA foreign_keys = off;

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

PRAGMA foreign_keys = on;
