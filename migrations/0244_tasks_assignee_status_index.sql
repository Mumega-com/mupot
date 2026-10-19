-- perf: orient / task_list / inbox look tasks up by (assignee_agent_id, status). Additive, idempotent.
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_status ON tasks(assignee_agent_id, status);
