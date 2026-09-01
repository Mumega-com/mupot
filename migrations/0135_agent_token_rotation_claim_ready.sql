-- 0135 — audit/activation must wait for a durably recorded claim handoff.

ALTER TABLE agent_token_rotation_handoffs
  ADD COLUMN claim_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (claim_state IN ('pending', 'ready'));

DROP TRIGGER IF EXISTS agent_token_rotation_handoff_activate;
CREATE TRIGGER agent_token_rotation_handoff_activate
BEFORE UPDATE OF state ON agent_token_rotation_handoffs
WHEN OLD.state = 'pending' AND NEW.state = 'active'
BEGIN
  SELECT RAISE(ABORT, 'replacement_claim_not_ready')
   WHERE OLD.claim_state <> 'ready';
  SELECT RAISE(ABORT, 'replacement_audit_not_sent')
   WHERE OLD.audit_state <> 'sent';
  UPDATE member_tokens SET revoked_at = NEW.activated_at
   WHERE id = OLD.prior_token_id AND member_id = OLD.member_id AND agent_id = OLD.agent_id
     AND tenant = OLD.tenant AND revoked_at IS NULL
     AND (expires_at IS NULL OR julianday(expires_at) > julianday(NEW.activated_at));
  SELECT RAISE(ABORT, 'replacement_prior_not_live') WHERE changes() <> 1;
  UPDATE member_tokens SET revoked_at = NULL
   WHERE id = OLD.replacement_token_id AND member_id = OLD.member_id AND agent_id = OLD.agent_id
     AND tenant = OLD.tenant AND revoked_at = OLD.created_at;
  SELECT RAISE(ABORT, 'replacement_not_pending') WHERE changes() <> 1;
END;
