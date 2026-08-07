-- 0083_channel_mention_budget.sql
-- mumega-com#722: Rate wall table for per-agent hourly mention dispatch budget (10/hr default).

CREATE TABLE IF NOT EXISTS channel_mention_budget (
  tenant        TEXT NOT NULL,
  agent_slug    TEXT NOT NULL,
  hour_bucket   TEXT NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant, agent_slug, hour_bucket)
);
