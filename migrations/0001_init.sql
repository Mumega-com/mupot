-- mupot org schema. Empty by default (substrate, not business). The tenant seeds
-- departments → squads → agents through the dashboard. Every table carries no
-- Mumega data; this is the pot, not the plant.

CREATE TABLE IF NOT EXISTS departments (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS squads (
  id            TEXT PRIMARY KEY,
  department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  slug          TEXT NOT NULL,
  name          TEXT NOT NULL,
  charter       TEXT,                       -- tenant-authored culture/mandate
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(department_id, slug)
);

CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY,             -- also the AgentDO id name
  squad_id    TEXT NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member',
  model       TEXT NOT NULL DEFAULT '@cf/meta/llama-3.3',
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(squad_id, slug)
);

CREATE TABLE IF NOT EXISTS memberships (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  squad_id    TEXT NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  capability  TEXT NOT NULL DEFAULT 'member' CHECK (capability IN ('owner','lead','member','observer')),
  UNIQUE(agent_id, squad_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id                 TEXT PRIMARY KEY,
  squad_id           TEXT NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  title              TEXT NOT NULL,
  body               TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','blocked','done')),
  assignee_agent_id  TEXT REFERENCES agents(id) ON DELETE SET NULL,
  github_issue_url   TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- engram metadata (vectors live in Vectorize; this is the relational side)
CREATE TABLE IF NOT EXISTS engrams (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  text        TEXT NOT NULL,
  concepts    TEXT,                          -- JSON array
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- org users (login). AuthN delegated to OAuth; this is the authZ side.
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT UNIQUE,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_squads_dept   ON squads(department_id);
CREATE INDEX IF NOT EXISTS idx_agents_squad  ON agents(squad_id);
CREATE INDEX IF NOT EXISTS idx_tasks_squad   ON tasks(squad_id, status);
CREATE INDEX IF NOT EXISTS idx_engrams_agent ON engrams(agent_id);
