-- 0076: task priority and parent-subtask hierarchy
--
-- Gaps found by dogfooding (task afda092e):
-- (1) NO PRIORITY FIELD — backlog that cannot be ordered is a list, not a backlog.
-- (2) NO PARENT/SUBTASK FIELD — cannot express hierarchical breakdown.
--
-- priority: one of P0, P1, P2, P3, null (defaults to null / unranked).
-- parent_task_id: soft reference (no FK) to the parent task in a hierarchy tree,
--   allowing subtasks to be tracked. NULL for top-level tasks. No depth limit;
--   callers validate acyclic constraints at service layer.

ALTER TABLE tasks ADD COLUMN priority TEXT CHECK (priority IN ('P0', 'P1', 'P2', 'P3', NULL));
ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;

-- Index for finding subtasks by parent quickly.
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;

-- Index for finding high-priority tasks (common backlog sort).
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(squad_id, priority) WHERE priority IS NOT NULL;
