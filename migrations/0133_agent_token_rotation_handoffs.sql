-- 0133_agent_token_rotation_handoffs.sql — durable, fail-closed replacement handoff.
--
-- A rotation cannot atomically commit D1 state and either the queue or KV claim.
-- The replacement token therefore lands revoked (inactive), with this durable
-- handoff/outbox record.  Activation is allowed only after the claim is present
-- and the audit handoff has been recorded as sent; the trigger revokes the prior
-- token and activates the replacement in the same SQLite transaction.

CREATE TABLE IF NOT EXISTS agent_token_rotation_handoffs (
  id                    TEXT PRIMARY KEY,
  tenant                TEXT NOT NULL,
  agent_id              TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  member_id             TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  prior_token_id        TEXT NOT NULL REFERENCES member_tokens(id) ON DELETE RESTRICT,
  replacement_token_id  TEXT NOT NULL UNIQUE REFERENCES member_tokens(id) ON DELETE RESTRICT,
  minted_by_member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  claim_id              TEXT NOT NULL UNIQUE,
  claim_fingerprint     TEXT NOT NULL CHECK (length(claim_fingerprint) = 16),
  claim_expires_at      TEXT NOT NULL,
  audit_state           TEXT NOT NULL DEFAULT 'pending' CHECK (audit_state IN ('pending', 'sent')),
  state                 TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'active')),
  created_at            TEXT NOT NULL,
  activated_at          TEXT,
  UNIQUE (tenant, prior_token_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_token_rotation_handoffs_resume
  ON agent_token_rotation_handoffs (tenant, agent_id, member_id, prior_token_id, state);

-- The liveness/race predicate lives in this trigger because an application-side
-- receipt check runs after D1.batch() has committed.  A zero-row prior update
-- must abort this transaction so neither a replacement row nor any dependent
-- state can survive a lost race.
CREATE TRIGGER agent_token_rotation_handoff_activate
BEFORE UPDATE OF state ON agent_token_rotation_handoffs
WHEN OLD.state = 'pending' AND NEW.state = 'active'
BEGIN
  SELECT RAISE(ABORT, 'replacement_audit_not_sent')
   WHERE OLD.audit_state <> 'sent';

  UPDATE member_tokens
     SET revoked_at = NEW.activated_at
   WHERE id = OLD.prior_token_id
     AND member_id = OLD.member_id
     AND agent_id = OLD.agent_id
     AND tenant = OLD.tenant
     AND revoked_at IS NULL
     AND (expires_at IS NULL OR julianday(expires_at) > julianday(NEW.activated_at));

  SELECT RAISE(ABORT, 'replacement_prior_not_live')
   WHERE changes() <> 1;

  UPDATE member_tokens
     SET revoked_at = NULL
   WHERE id = OLD.replacement_token_id
     AND member_id = OLD.member_id
     AND agent_id = OLD.agent_id
     AND tenant = OLD.tenant
     AND revoked_at = OLD.created_at;

  SELECT RAISE(ABORT, 'replacement_not_pending')
   WHERE changes() <> 1;
END;
