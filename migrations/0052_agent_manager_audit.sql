-- mupot — append-only receipts for autonomous squad agent management.
--
-- A manager is authorized by BOTH exact/inherited squad membership and the
-- free-text `agents:manage` surface grant. This table records successful lifecycle
-- effects without ever storing raw credentials or token hashes.

CREATE TABLE IF NOT EXISTS agent_manager_audit (
  id          TEXT NOT NULL PRIMARY KEY,
  tenant      TEXT NOT NULL,
  actor_id    TEXT NOT NULL,
  actor_agent_id TEXT NOT NULL,
  channel     TEXT NOT NULL,
  request_id  TEXT NOT NULL,
  squad_id    TEXT NOT NULL,
  agent_id    TEXT,
  token_id    TEXT,
  action      TEXT NOT NULL CHECK (action IN ('create', 'set_status', 'mint_token', 'revoke_token')),
  detail      TEXT CHECK (detail IS NULL OR json_valid(detail)),
  recorded_at TEXT NOT NULL,
  UNIQUE (tenant, actor_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_manager_audit_scope
  ON agent_manager_audit (tenant, squad_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_manager_audit_agent
  ON agent_manager_audit (agent_id, recorded_at DESC);

CREATE TRIGGER IF NOT EXISTS agent_manager_audit_no_update
  BEFORE UPDATE ON agent_manager_audit
BEGIN
  SELECT RAISE(ABORT, 'agent_manager_audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS agent_manager_audit_no_delete
  BEFORE DELETE ON agent_manager_audit
BEGIN
  SELECT RAISE(ABORT, 'agent_manager_audit is append-only');
END;
