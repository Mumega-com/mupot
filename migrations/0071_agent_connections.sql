-- 0071_agent_connections.sql — canonical agent identity and connection receipts.
--
-- This migration establishes the durable identity weld used by every agent
-- credential path. It fails closed when historical welded tokens are ambiguous
-- or tenantless, then backfills exactly one canonical member per agent.

CREATE TABLE agent_member_bindings (
  tenant     TEXT NOT NULL,
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant, agent_id),
  UNIQUE (tenant, member_id)
);

-- D1 migrations are transactional. Inserting zero into this constrained table
-- aborts the migration before any ambiguous identity can be backfilled.
CREATE TABLE agent_connection_migration_guard (
  ok INTEGER NOT NULL CHECK (ok = 1)
);

INSERT INTO agent_connection_migration_guard (ok)
SELECT 0
  FROM member_tokens
 WHERE agent_id IS NOT NULL
   AND tenant IS NULL
 LIMIT 1;

INSERT INTO agent_connection_migration_guard (ok)
SELECT 0
  FROM member_tokens
 WHERE agent_id IS NOT NULL
 GROUP BY tenant, agent_id
HAVING COUNT(DISTINCT member_id) > 1
 LIMIT 1;

DROP TABLE agent_connection_migration_guard;

INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
SELECT tenant, agent_id, MIN(member_id), MIN(created_at)
  FROM member_tokens
 WHERE agent_id IS NOT NULL
 GROUP BY tenant, agent_id;

CREATE TRIGGER agent_member_bindings_no_update
BEFORE UPDATE ON agent_member_bindings
BEGIN
  SELECT RAISE(ABORT, 'agent_identity_conflict');
END;

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

CREATE TABLE agent_connection_requests (
  tenant              TEXT NOT NULL,
  actor_kind          TEXT NOT NULL CHECK (actor_kind IN ('user','member')),
  actor_id            TEXT NOT NULL,
  request_id          TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  target_key          TEXT NOT NULL,
  agent_mode          TEXT NOT NULL CHECK (agent_mode IN ('new','existing')),
  credential_action   TEXT NOT NULL CHECK (
    credential_action IN ('issue_if_missing','add','replace')
  ),
  replace_token_id    TEXT,
  status              TEXT NOT NULL CHECK (
    status IN (
      'pending','credential_issued','client_connected',
      'messaging_verified','failed','expired'
    )
  ),
  agent_id            TEXT,
  member_id           TEXT,
  token_id            TEXT,
  receipt_id          TEXT,
  error_code          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  finalized_at        TEXT,
  expires_at          TEXT NOT NULL,
  PRIMARY KEY (tenant, actor_kind, actor_id, request_id),
  UNIQUE (receipt_id),
  CHECK (
    length(request_fingerprint) = 64
    AND request_fingerprint = lower(request_fingerprint)
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    (credential_action = 'replace' AND replace_token_id IS NOT NULL)
    OR (credential_action <> 'replace' AND replace_token_id IS NULL)
  )
);

CREATE UNIQUE INDEX idx_agent_connection_one_pending_target
  ON agent_connection_requests (tenant, target_key)
  WHERE status = 'pending';

CREATE TABLE agent_connection_receipts (
  id                          TEXT PRIMARY KEY,
  tenant                      TEXT NOT NULL,
  actor_kind                  TEXT NOT NULL CHECK (actor_kind IN ('user','member')),
  actor_id                    TEXT NOT NULL,
  request_id                  TEXT NOT NULL,
  request_fingerprint         TEXT NOT NULL,
  agent_id                    TEXT NOT NULL,
  agent_slug                  TEXT NOT NULL,
  agent_status_at_issue       TEXT NOT NULL,
  member_id                   TEXT NOT NULL,
  token_id                    TEXT NOT NULL,
  agent_disposition           TEXT NOT NULL CHECK (
    agent_disposition IN ('created','reused')
  ),
  credential_action           TEXT NOT NULL CHECK (
    credential_action IN ('issue_if_missing','add','replace')
  ),
  home_squad_id               TEXT NOT NULL,
  home_capability             TEXT NOT NULL CHECK (
    home_capability IN ('member','observer')
  ),
  additional_access_json      TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(additional_access_json)
    AND json_type(additional_access_json) = 'array'
  ),
  token_label                 TEXT NOT NULL,
  endpoint                    TEXT NOT NULL,
  transport                   TEXT NOT NULL CHECK (transport = 'streamable_http'),
  verification_status         TEXT NOT NULL CHECK (
    verification_status IN ('pending','pass','fail','expired')
  ),
  verification_challenge_hash TEXT,
  verification_expires_at     TEXT,
  client_connected_at         TEXT,
  verification_message_id     TEXT,
  verification_request_id     TEXT,
  messaging_verified_at       TEXT,
  verification_error_code     TEXT,
  checks_json                 TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(checks_json)
    AND json_type(checks_json) = 'object'
  ),
  credential_issued_at        TEXT NOT NULL,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL
);

-- A receipt can be inserted only while the exact actor-scoped reservation is
-- still pending. Because this is a BEFORE trigger, a stale provisioning batch
-- aborts inside SQLite and rolls back every earlier statement in that batch.
CREATE TRIGGER agent_connection_receipt_requires_pending_request
BEFORE INSERT ON agent_connection_receipts
WHEN NOT EXISTS (
  SELECT 1
    FROM agent_connection_requests
   WHERE tenant = NEW.tenant
     AND actor_kind = NEW.actor_kind
     AND actor_id = NEW.actor_id
     AND request_id = NEW.request_id
     AND request_fingerprint = NEW.request_fingerprint
     AND status = 'pending'
)
BEGIN
  SELECT RAISE(ABORT, 'agent_connection_request_not_pending');
END;

-- Issuance facts are an immutable snapshot. Only verification evidence and
-- updated_at may evolve after insert.
CREATE TRIGGER agent_connection_receipts_immutable_snapshot
BEFORE UPDATE ON agent_connection_receipts
WHEN NEW.id IS NOT OLD.id
  OR NEW.tenant IS NOT OLD.tenant
  OR NEW.actor_kind IS NOT OLD.actor_kind
  OR NEW.actor_id IS NOT OLD.actor_id
  OR NEW.request_id IS NOT OLD.request_id
  OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
  OR NEW.agent_id IS NOT OLD.agent_id
  OR NEW.agent_slug IS NOT OLD.agent_slug
  OR NEW.agent_status_at_issue IS NOT OLD.agent_status_at_issue
  OR NEW.member_id IS NOT OLD.member_id
  OR NEW.token_id IS NOT OLD.token_id
  OR NEW.agent_disposition IS NOT OLD.agent_disposition
  OR NEW.credential_action IS NOT OLD.credential_action
  OR NEW.home_squad_id IS NOT OLD.home_squad_id
  OR NEW.home_capability IS NOT OLD.home_capability
  OR NEW.additional_access_json IS NOT OLD.additional_access_json
  OR NEW.token_label IS NOT OLD.token_label
  OR NEW.endpoint IS NOT OLD.endpoint
  OR NEW.transport IS NOT OLD.transport
  OR NEW.credential_issued_at IS NOT OLD.credential_issued_at
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'agent_connection_receipt_immutable');
END;
