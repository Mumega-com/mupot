-- Owner-call slice 1: projection only. No authority, route, dispatcher or enablement.
-- 0268 is reserved by route-latency PR #2272. Preserve owner assignment ABA history.
ALTER TABLE agents ADD COLUMN owner_call_owner_revision INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER owner_call_owner_revision
AFTER UPDATE OF owner_member_id ON agents
WHEN NEW.owner_member_id IS NOT OLD.owner_member_id
BEGIN
  UPDATE agents SET owner_call_owner_revision = OLD.owner_call_owner_revision + 1 WHERE id = NEW.id;
END;

CREATE TABLE owner_calls (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  owner_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  owner_revision INTEGER NOT NULL,
  created_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  source_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('access','reauth')),
  action_type TEXT NOT NULL,
  action_id TEXT NOT NULL,
  action_version TEXT NOT NULL CHECK (length(action_version) = 64),
  reason_code TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','closed')),
  -- Slice 1 has no writer of priority=1. Reserved human headroom cannot be selected by a tool caller.
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority IN (0,1)),
  canonical_delivery_id TEXT REFERENCES approval_bot_deliveries(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  CHECK (kind <> 'access' OR (action_type = 'elevation_request' AND canonical_delivery_id IS NOT NULL))
);
CREATE UNIQUE INDEX owner_call_active_action ON owner_calls(tenant,owner_member_id,action_type,action_id,action_version)
  WHERE state = 'pending';
CREATE INDEX owner_call_owner_queue ON owner_calls(tenant,owner_member_id,state,priority,created_at);
CREATE INDEX owner_call_agent_window ON owner_calls(tenant,created_by_agent_id,created_at);
-- Separate WHEN triggers use the remote-D1-compatible RAISE form (SELECT CASE ... RAISE is rejected remotely).
CREATE TRIGGER owner_call_agent_rate BEFORE INSERT ON owner_calls
WHEN (SELECT COUNT(*) FROM owner_calls WHERE tenant=NEW.tenant AND created_by_agent_id=NEW.created_by_agent_id
  AND julianday(created_at)>julianday(NEW.created_at)-15.0/1440) >= 5
BEGIN SELECT RAISE(ABORT,'owner_call_agent_rate'); END;
CREATE TRIGGER owner_call_owner_rate BEFORE INSERT ON owner_calls
WHEN (SELECT COUNT(*) FROM owner_calls WHERE tenant=NEW.tenant AND owner_member_id=NEW.owner_member_id
  AND julianday(created_at)>julianday(NEW.created_at)-15.0/1440) >= 20
BEGIN SELECT RAISE(ABORT,'owner_call_owner_rate'); END;
CREATE TRIGGER owner_call_owner_pending BEFORE INSERT ON owner_calls
WHEN NEW.priority=0 AND (SELECT COUNT(*) FROM owner_calls WHERE tenant=NEW.tenant AND owner_member_id=NEW.owner_member_id
  AND state='pending' AND priority=0) >= 40
BEGIN SELECT RAISE(ABORT,'owner_call_owner_pending'); END;
CREATE TRIGGER owner_call_owner_total BEFORE INSERT ON owner_calls
WHEN (SELECT COUNT(*) FROM owner_calls WHERE tenant=NEW.tenant AND owner_member_id=NEW.owner_member_id
  AND state='pending') >= 50
BEGIN SELECT RAISE(ABORT,'owner_call_owner_total'); END;
CREATE TRIGGER owner_calls_immutable BEFORE UPDATE ON owner_calls
WHEN NEW.id IS NOT OLD.id OR NEW.tenant IS NOT OLD.tenant OR NEW.owner_member_id IS NOT OLD.owner_member_id
 OR NEW.owner_revision IS NOT OLD.owner_revision OR NEW.created_by_agent_id IS NOT OLD.created_by_agent_id OR NEW.source_agent_id IS NOT OLD.source_agent_id
 OR NEW.kind IS NOT OLD.kind OR NEW.action_type IS NOT OLD.action_type OR NEW.action_id IS NOT OLD.action_id
 OR NEW.action_version IS NOT OLD.action_version OR NEW.reason_code IS NOT OLD.reason_code
 OR NEW.priority IS NOT OLD.priority OR NEW.canonical_delivery_id IS NOT OLD.canonical_delivery_id OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.state='closed' AND NEW.state<>'closed')
BEGIN SELECT RAISE(ABORT,'owner_call_immutable'); END;
CREATE TRIGGER owner_calls_no_delete BEFORE DELETE ON owner_calls BEGIN SELECT RAISE(ABORT,'owner_call_history_retained'); END;

CREATE TABLE owner_call_requesters (
  tenant TEXT NOT NULL,
  ask_id TEXT NOT NULL REFERENCES owner_calls(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  owner_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(tenant,ask_id,agent_id)
);
CREATE INDEX owner_call_requester_agent ON owner_call_requesters(tenant,agent_id,ask_id);
CREATE TRIGGER owner_call_requester_limit BEFORE INSERT ON owner_call_requesters
WHEN NOT EXISTS (SELECT 1 FROM owner_call_requesters WHERE tenant=NEW.tenant AND ask_id=NEW.ask_id AND agent_id=NEW.agent_id)
 AND (SELECT state FROM owner_calls WHERE id=NEW.ask_id AND tenant=NEW.tenant)='pending'
 AND (SELECT COUNT(*) FROM owner_call_requesters r JOIN owner_calls c ON c.id=r.ask_id AND c.tenant=r.tenant
      WHERE r.tenant=NEW.tenant AND r.agent_id=NEW.agent_id AND c.state='pending') >= 10
BEGIN SELECT RAISE(ABORT,'owner_call_agent_pending'); END;
CREATE TRIGGER owner_call_requesters_no_update BEFORE UPDATE ON owner_call_requesters BEGIN SELECT RAISE(ABORT,'owner_call_requester_immutable'); END;
CREATE TRIGGER owner_call_requesters_no_delete BEFORE DELETE ON owner_call_requesters BEGIN SELECT RAISE(ABORT,'owner_call_requester_immutable'); END;

CREATE TABLE owner_call_key_aliases (
  tenant TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  key_version TEXT NOT NULL,
  key_hmac TEXT NOT NULL CHECK(length(key_hmac)=64),
  payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64),
  ask_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(tenant,agent_id,key_version,key_hmac),
  FOREIGN KEY(tenant,ask_id,agent_id) REFERENCES owner_call_requesters(tenant,ask_id,agent_id) ON DELETE RESTRICT
);
-- An upsert of the SAME alias is harmless; a concurrent different payload aborts the entire batch, including its ask.
CREATE TRIGGER owner_call_alias_conflict BEFORE UPDATE ON owner_call_key_aliases
WHEN NEW.payload_digest IS NOT OLD.payload_digest OR NEW.ask_id IS NOT OLD.ask_id OR NEW.tenant IS NOT OLD.tenant
 OR NEW.agent_id IS NOT OLD.agent_id OR NEW.key_version IS NOT OLD.key_version OR NEW.key_hmac IS NOT OLD.key_hmac
 OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'ask_key_conflict'); END;
CREATE TRIGGER owner_call_alias_no_delete BEFORE DELETE ON owner_call_key_aliases BEGIN SELECT RAISE(ABORT,'owner_call_history_retained'); END;

-- Generic intent for a future registered reauth adapter. No consumer exists in slice 1; access never enters this table.
CREATE TABLE owner_call_outbox (
  ask_id TEXT PRIMARY KEY REFERENCES owner_calls(id) ON DELETE RESTRICT,
  tenant TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'inert' CHECK(state='inert'),
  created_at TEXT NOT NULL
);
CREATE TRIGGER owner_call_outbox_kind BEFORE INSERT ON owner_call_outbox
WHEN NOT EXISTS(SELECT 1 FROM owner_calls WHERE id=NEW.ask_id AND tenant=NEW.tenant AND kind='reauth')
BEGIN SELECT RAISE(ABORT,'owner_call_outbox_kind'); END;

-- Retry history outlives key rotation. Operators must retain every key version; a version cannot silently change material.
-- key_check is HMAC of a fixed domain string, never the key or an ask key.
CREATE TABLE owner_call_hmac_versions (
  tenant TEXT NOT NULL,
  key_version TEXT NOT NULL,
  key_check TEXT NOT NULL CHECK(length(key_check)=64),
  PRIMARY KEY(tenant,key_version)
);
CREATE TRIGGER owner_call_hmac_version_immutable BEFORE UPDATE ON owner_call_hmac_versions
WHEN NEW.tenant IS NOT OLD.tenant OR NEW.key_version IS NOT OLD.key_version OR NEW.key_check IS NOT OLD.key_check
BEGIN SELECT RAISE(ABORT,'owner_call_key_history'); END;
CREATE TRIGGER owner_call_hmac_version_no_delete BEFORE DELETE ON owner_call_hmac_versions BEGIN SELECT RAISE(ABORT,'owner_call_key_history'); END;

-- Transaction-local authorization fence. Insert and delete share one D1 batch, so no row survives a committed call.
-- Keeps the deep canonical admission predicates out of quota/uniqueness trigger expressions (D1 expression-depth limit).
CREATE TABLE owner_call_commit_guards (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL
);

-- Canonical source ownership controls the projection. Closing it retains every requester/key association.
CREATE TRIGGER owner_call_source_owner_changed AFTER UPDATE OF owner_member_id ON agents
WHEN NEW.owner_member_id IS NOT OLD.owner_member_id
BEGIN
  UPDATE owner_calls SET state='closed' WHERE source_agent_id=NEW.id AND state='pending';
END;
