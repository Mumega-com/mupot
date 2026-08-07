-- migration 0082_channel_mention_budget.sql
-- Creates rate wall table for channel mention budgets.
CREATE TABLE IF NOT EXISTS channel_mention_budget (
  tenant      TEXT NOT NULL DEFAULT 'mumega',
  agent_slug  TEXT NOT NULL,
  hour_bucket TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant, agent_slug, hour_bucket)
);
