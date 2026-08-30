-- 0136 — bound the in-flight KV claim-put window and make stale cleanup atomic.

ALTER TABLE agent_token_rotation_handoffs
  ADD COLUMN claim_put_lease_expires_at TEXT;

-- Existing local candidates used claim_expires_at as the only in-flight bound.
-- Preserve that conservative deadline when upgrading an already-staged handoff.
UPDATE agent_token_rotation_handoffs
   SET claim_put_lease_expires_at = claim_expires_at
 WHERE claim_put_lease_expires_at IS NULL;

-- Every new reservation must carry an explicit put lease. The application uses a
-- short lease; this trigger prevents a future writer from silently recreating an
-- unbounded pending/no-claim state.
CREATE TRIGGER agent_token_rotation_handoff_put_lease_required
BEFORE INSERT ON agent_token_rotation_handoffs
WHEN NEW.claim_put_lease_expires_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'replacement_claim_put_lease_required');
END;

-- A pending handoff owns exactly one inactive replacement. Deleting the
-- reservation must delete that token in the same SQLite statement/transaction;
-- otherwise a crash between two application statements would leave a secret
-- hash with no durable recovery record.
CREATE TRIGGER agent_token_rotation_handoff_cleanup_pending_token
AFTER DELETE ON agent_token_rotation_handoffs
WHEN OLD.state = 'pending'
BEGIN
  DELETE FROM member_tokens
   WHERE id = OLD.replacement_token_id
     AND tenant = OLD.tenant
     AND member_id = OLD.member_id
     AND agent_id = OLD.agent_id
     AND revoked_at = OLD.created_at;
  SELECT RAISE(ABORT, 'replacement_pending_token_not_deleted')
   WHERE changes() <> 1;
END;
