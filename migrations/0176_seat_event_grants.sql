-- 0176_seat_event_grants.sql — explicit authorization for one fleet host to receive body-free
-- inbox hints for one agent over the seat-events channel (src/agents/seat-events.ts).
--
-- host_agent_id is the identity whose Ed25519 key (agent_keys) signs the host's ticket
-- requests. A grant is the ONLY thing that lets that host subscribe to agent_id; a host key
-- alone authorizes nothing, and fleet_agents.host (self-reported) is never consulted.
--
-- One live grant per agent: the partial unique index is the durable half of the
-- one-consumer-per-UUID fence. Moving an agent between hosts (or from Herdr to Orca) is an
-- explicit revoke + grant, recorded with who did it and why.

CREATE TABLE IF NOT EXISTS seat_event_grants (
  id                   TEXT PRIMARY KEY,
  tenant               TEXT NOT NULL,
  host_agent_id        TEXT NOT NULL CHECK (length(trim(host_agent_id)) BETWEEN 1 AND 64),
  agent_id             TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  project_id           TEXT REFERENCES projects(id) ON DELETE CASCADE,
  granted_by_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  reason               TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  created_at           TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  revoked_at           TEXT,
  revoked_by_member_id TEXT REFERENCES members(id) ON DELETE RESTRICT,
  CHECK ((revoked_at IS NULL) = (revoked_by_member_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_seat_event_grants_one_live_host
  ON seat_event_grants(tenant, agent_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_seat_event_grants_host
  ON seat_event_grants(tenant, host_agent_id)
  WHERE revoked_at IS NULL;
