-- 0072_runtime_endpoints.sql — leased, exact runtime addresses (#577).
--
-- An agent identity is not a runtime return address: one welded agent can be
-- active in several Codex/Claude/Hermes sessions at once. These tables keep the
-- durable identity and project authority in Mupot while letting a host map one
-- opaque endpoint id to one exact local session.
--
-- The raw harness session/thread id is never stored. The client sends a
-- host-local random handle over the authenticated channel; the service stores
-- only its SHA-256 fingerprint and returns a separate Mupot endpoint id.

CREATE TABLE IF NOT EXISTS runtime_endpoints (
  id                    TEXT NOT NULL PRIMARY KEY,
  tenant                TEXT NOT NULL,
  agent_id              TEXT NOT NULL REFERENCES agents(id),
  member_id             TEXT NOT NULL REFERENCES members(id),
  runtime_kind          TEXT NOT NULL CHECK (
                          runtime_kind IN ('codex', 'claude_code', 'cursor', 'hermes', 'other')
                        ),
  session_fingerprint   TEXT NOT NULL CHECK (
                          length(session_fingerprint) = 64
                          AND session_fingerprint NOT GLOB '*[^a-f0-9]*'
                        ),
  capability_hash       TEXT NOT NULL CHECK (
                          length(capability_hash) = 64
                          AND capability_hash NOT GLOB '*[^a-f0-9]*'
                        ),
  node_id               TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 128),
  local_source_id       TEXT NOT NULL CHECK (length(local_source_id) BETWEEN 1 AND 128),
  project_id            TEXT NOT NULL REFERENCES projects(id),
  purpose               TEXT NOT NULL CHECK (length(purpose) BETWEEN 1 AND 120),
  workspace             TEXT NOT NULL CHECK (length(workspace) BETWEEN 1 AND 240),
  wake_adapter          TEXT NOT NULL CHECK (
                          wake_adapter IN ('codex_cli', 'codex_app_server', 'claude_cli', 'hermes', 'generic')
                        ),
  allowed_senders       TEXT NOT NULL CHECK (
                          json_valid(allowed_senders)
                          AND json_type(allowed_senders) = 'array'
                          AND json_array_length(allowed_senders) BETWEEN 1 AND 64
                        ),
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  lease_expires_at      TEXT NOT NULL,
  last_seen_at          TEXT NOT NULL,
  registered_at         TEXT NOT NULL,
  revoked_at            TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_endpoints_session
  ON runtime_endpoints(tenant, agent_id, session_fingerprint);

CREATE INDEX IF NOT EXISTS idx_runtime_endpoints_project_lease
  ON runtime_endpoints(tenant, project_id, status, lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_runtime_endpoints_agent
  ON runtime_endpoints(tenant, agent_id, status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS runtime_endpoint_messages (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  tenant          TEXT NOT NULL,
  endpoint_id     TEXT NOT NULL REFERENCES runtime_endpoints(id),
  to_agent        TEXT NOT NULL REFERENCES agents(id),
  from_agent      TEXT NOT NULL REFERENCES agents(id),
  from_member     TEXT NOT NULL REFERENCES members(id),
  project_id      TEXT NOT NULL REFERENCES projects(id),
  kind            TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'request')),
  body            TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  request_id      TEXT,
  in_reply_to     TEXT,
  created_at      TEXT NOT NULL,
  accepted_at     TEXT,
  runtime_turn_id TEXT,
  CHECK (
    (accepted_at IS NULL AND runtime_turn_id IS NULL)
    OR (accepted_at IS NOT NULL AND runtime_turn_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_runtime_endpoint_messages_inbox
  ON runtime_endpoint_messages(tenant, endpoint_id, accepted_at, seq);

CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_endpoint_messages_request
  ON runtime_endpoint_messages(tenant, project_id, from_agent, request_id)
  WHERE request_id IS NOT NULL;

CREATE TRIGGER validate_runtime_endpoint_insert
BEFORE INSERT ON runtime_endpoints
BEGIN
  SELECT RAISE(ABORT, 'runtime endpoint member tenant mismatch')
    WHERE NOT EXISTS (
      SELECT 1 FROM members m WHERE m.id = NEW.member_id AND m.tenant = NEW.tenant
    );
END;

CREATE TRIGGER validate_runtime_endpoint_member_update
BEFORE UPDATE OF member_id, tenant ON runtime_endpoints
BEGIN
  SELECT RAISE(ABORT, 'runtime endpoint member tenant mismatch')
    WHERE NOT EXISTS (
      SELECT 1 FROM members m WHERE m.id = NEW.member_id AND m.tenant = NEW.tenant
    );
END;

-- A message may only enter the endpoint's own tenant, agent, and project lane.
CREATE TRIGGER validate_runtime_endpoint_message_insert
BEFORE INSERT ON runtime_endpoint_messages
BEGIN
  SELECT RAISE(ABORT, 'runtime endpoint target mismatch')
    WHERE NOT EXISTS (
      SELECT 1 FROM runtime_endpoints e
       WHERE e.id = NEW.endpoint_id
         AND e.tenant = NEW.tenant
         AND e.agent_id = NEW.to_agent
         AND e.project_id = NEW.project_id
    );
  SELECT RAISE(ABORT, 'runtime endpoint sender tenant mismatch')
    WHERE NOT EXISTS (
      SELECT 1 FROM members m WHERE m.id = NEW.from_member AND m.tenant = NEW.tenant
    );
END;

-- Delivery attribution is immutable. Acceptance may only add its receipt.
CREATE TRIGGER validate_runtime_endpoint_message_immutable
BEFORE UPDATE OF tenant, endpoint_id, to_agent, from_agent, from_member,
                 project_id, kind, body, request_id, in_reply_to, created_at
ON runtime_endpoint_messages
BEGIN
  SELECT RAISE(ABORT, 'runtime endpoint message immutable');
END;

CREATE TRIGGER validate_runtime_endpoint_accept_once
BEFORE UPDATE OF accepted_at, runtime_turn_id ON runtime_endpoint_messages
WHEN OLD.accepted_at IS NOT NULL
  OR NEW.accepted_at IS NULL
  OR NEW.runtime_turn_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'runtime endpoint acceptance immutable');
END;
