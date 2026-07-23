-- 0072: member ↔ Hermes-agent binding for BYOA Open WebUI / IM identity.
-- One active Hermes agent per member (fail-closed; replace via rebind).

CREATE TABLE IF NOT EXISTS member_hermes_bindings (
  member_id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_member_hermes_bindings_agent
  ON member_hermes_bindings(agent_id);
