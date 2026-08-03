-- Restore the OAuth directory channel after a historical production schema
-- rebuild dropped it from member_tokens' CHECK constraint.

-- SQLite validates trigger bodies during table renames. Drop every trigger that
-- targets or references member_tokens, then recreate the same guards below.
DROP TRIGGER IF EXISTS agent_member_bindings_delete_requires_no_tokens;
DROP TRIGGER IF EXISTS member_tokens_agent_binding_insert;
DROP TRIGGER IF EXISTS member_tokens_agent_binding_update;
DROP TRIGGER IF EXISTS agent_connection_receipt_replaces_live_token;

CREATE TABLE member_tokens_directory_new (
  id          TEXT PRIMARY KEY,
  member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL DEFAULT '',
  channel     TEXT NOT NULL DEFAULT 'workspace'
    CHECK (channel IN ('workspace','im','dashboard','directory')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at  TEXT,
  agent_id    TEXT,
  tenant      TEXT
);

INSERT INTO member_tokens_directory_new (
  id, member_id, token_hash, label, channel,
  created_at, revoked_at, agent_id, tenant
)
SELECT
  id, member_id, token_hash, label, channel,
  created_at, revoked_at, agent_id, tenant
FROM member_tokens;

DROP TABLE member_tokens;
ALTER TABLE member_tokens_directory_new RENAME TO member_tokens;

CREATE INDEX idx_member_tokens_member
  ON member_tokens(member_id);
CREATE INDEX idx_member_tokens_hash
  ON member_tokens(token_hash);
CREATE INDEX idx_member_tokens_tenant_hash
  ON member_tokens(tenant, token_hash);
CREATE INDEX idx_member_tokens_tenant_member
  ON member_tokens(tenant, member_id);

CREATE TRIGGER agent_member_bindings_delete_requires_no_tokens
BEFORE DELETE ON agent_member_bindings
WHEN EXISTS (
  SELECT 1
    FROM member_tokens
   WHERE tenant = OLD.tenant
     AND agent_id = OLD.agent_id
)
BEGIN
  SELECT RAISE(ABORT, 'agent_identity_conflict');
END;

CREATE TRIGGER member_tokens_agent_binding_insert
BEFORE INSERT ON member_tokens
WHEN NEW.agent_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1
     FROM agent_member_bindings
    WHERE tenant = NEW.tenant
      AND agent_id = NEW.agent_id
      AND member_id = NEW.member_id
 )
BEGIN
  SELECT RAISE(ABORT, 'agent_identity_conflict');
END;

CREATE TRIGGER member_tokens_agent_binding_update
BEFORE UPDATE OF tenant, agent_id, member_id ON member_tokens
WHEN NEW.agent_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1
     FROM agent_member_bindings
    WHERE tenant = NEW.tenant
      AND agent_id = NEW.agent_id
      AND member_id = NEW.member_id
 )
BEGIN
  SELECT RAISE(ABORT, 'agent_identity_conflict');
END;

CREATE TRIGGER agent_connection_receipt_replaces_live_token
BEFORE INSERT ON agent_connection_receipts
WHEN NEW.credential_action = 'replace'
BEGIN
  UPDATE member_tokens
     SET revoked_at = NEW.credential_issued_at
   WHERE id = (
     SELECT replace_token_id
       FROM agent_connection_requests
      WHERE tenant = NEW.tenant
        AND actor_kind = NEW.actor_kind
        AND actor_id = NEW.actor_id
        AND request_id = NEW.request_id
        AND request_fingerprint = NEW.request_fingerprint
        AND status = 'pending'
      LIMIT 1
   )
     AND tenant = NEW.tenant
     AND member_id = NEW.member_id
     AND agent_id = NEW.agent_id
     AND revoked_at IS NULL;

  SELECT RAISE(ABORT, 'replace_token_not_found')
   WHERE changes() <> 1;
END;
