-- Durable attribution for MCP dispatch of an existing assigned task.
CREATE TABLE IF NOT EXISTS task_dispatch_receipts (
  id            TEXT PRIMARY KEY,
  tenant        TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  squad_id      TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('member', 'agent')),
  actor_id      TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  emitted_at    TEXT,
  consumed_at   TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_dispatch_receipts_task
  ON task_dispatch_receipts (tenant, task_id, created_at DESC);
