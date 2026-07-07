-- 0042_task_status_gate_values.sql — align the tasks table CHECK with the app model.
--
-- The initial tasks table allowed only open/in_progress/blocked/done at the DB
-- layer, but the gate workflow added review/approved/rejected in application code.
-- Fresh local D1 databases therefore could not exercise approvals. Rebuild the
-- table with the full status set while preserving every column added by earlier
-- migrations.

PRAGMA foreign_keys = off;

CREATE TABLE IF NOT EXISTS tasks_new (
  id                 TEXT PRIMARY KEY,
  squad_id           TEXT NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  title              TEXT NOT NULL,
  body               TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','in_progress','blocked','done','review','approved','rejected')),
  assignee_agent_id  TEXT REFERENCES agents(id) ON DELETE SET NULL,
  github_issue_url   TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  result             TEXT,
  completed_at       TEXT,
  gate_owner         TEXT,
  cost_micro_usd     INTEGER NOT NULL DEFAULT 0,
  workflow_instance_id TEXT,
  done_when          TEXT NOT NULL DEFAULT '(backfill required)'
);

INSERT INTO tasks_new (
  id, squad_id, title, body, status, assignee_agent_id, github_issue_url,
  created_at, updated_at, result, completed_at, gate_owner, cost_micro_usd,
  workflow_instance_id, done_when
)
SELECT
  id, squad_id, title, body, status, assignee_agent_id, github_issue_url,
  created_at, updated_at, result, completed_at, gate_owner,
  COALESCE(cost_micro_usd, 0), workflow_instance_id, done_when
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX IF NOT EXISTS idx_tasks_squad ON tasks(squad_id, status);

PRAGMA foreign_keys = on;
