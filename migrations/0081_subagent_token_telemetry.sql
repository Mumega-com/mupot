-- 0081_subagent_token_telemetry.sql — Create subagent_token_usage table for subagent token & task telemetry.

CREATE TABLE subagent_token_usage (
  id TEXT PRIMARY KEY,
  subagent_id TEXT NOT NULL,
  parent_agent_id TEXT NOT NULL,
  model_substrate TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  task_id TEXT,
  timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subagent_token_usage_subagent ON subagent_token_usage(subagent_id);
CREATE INDEX IF NOT EXISTS idx_subagent_token_usage_parent ON subagent_token_usage(parent_agent_id);
CREATE INDEX IF NOT EXISTS idx_subagent_token_usage_task ON subagent_token_usage(task_id);
