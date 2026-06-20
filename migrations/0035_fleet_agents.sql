-- 0035_fleet_agents.sql — fleet agent registry (Deliverable 2 panel data layer).
--
-- The panel can't read the host's manifests (they live on the host, in the mumega.com repo). So the
-- host consumer daemon REPORTS its controllable agents + their live status here; the dashboard reads
-- this table to render the roster + start/stop buttons. This is a DISPLAY cache, not authority — the
-- control action is separately owner-gated and signature-verified; a stale/forged status row can only
-- mislead the panel, never authorize a host action.
--
-- Tenant is environment-derived (env.TENANT_SLUG). Only the configured consumer agent may report.

CREATE TABLE IF NOT EXISTS fleet_agents (
  agent_id          TEXT PRIMARY KEY,                       -- manifest id (the controlled agent)
  tenant            TEXT NOT NULL,                          -- = TENANT_SLUG, isolation
  display           TEXT NOT NULL DEFAULT '',
  runtime           TEXT NOT NULL DEFAULT '',               -- codex|claude-code|nous|hermes-cron|systemd-user|tmux|python
  squads            TEXT NOT NULL DEFAULT '[]',             -- JSON string[]
  lifecycle         TEXT NOT NULL DEFAULT '',               -- on_demand|always_on
  provider_contract TEXT,                                   -- the credit source, or NULL
  status            TEXT NOT NULL DEFAULT 'unknown',        -- running|stopped|unknown (last reported)
  reported_by       TEXT NOT NULL DEFAULT '',               -- the agent that reported (the daemon/consumer)
  last_reported_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fleet_agents_tenant ON fleet_agents(tenant, agent_id);
