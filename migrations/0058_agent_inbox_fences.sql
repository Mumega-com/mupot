-- 0058_agent_inbox_fences.sql - one authoritative inbox transport per welded agent.

CREATE TABLE IF NOT EXISTS agent_inbox_fences (
  tenant TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('bearer_only', 'signed_only')),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  key_fingerprint TEXT CHECK (key_fingerprint IS NULL OR length(key_fingerprint) = 64),
  updated_by_member_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  CHECK (
    (mode = 'signed_only' AND key_fingerprint IS NOT NULL) OR
    (mode = 'bearer_only' AND key_fingerprint IS NULL)
  ),
  PRIMARY KEY (tenant, agent_id),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by_member_id) REFERENCES members(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_agent_inbox_fences_tenant_mode
  ON agent_inbox_fences(tenant, mode);
