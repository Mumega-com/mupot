-- Owner-call slice 1b: bounded aliases, indexed rate windows and canonical decision projection.
-- Additive follow-up to landed 0269; no creation, notification or authority enablement.


CREATE INDEX owner_call_owner_window ON owner_calls(tenant,owner_member_id,created_at);

CREATE INDEX owner_call_pending_source ON owner_calls(tenant,action_type,action_id) WHERE state='pending';

-- Creation timestamps are server-generated UTC ISO (Date.toISOString); leave the indexed column unwrapped.

DROP TRIGGER owner_call_agent_rate;

CREATE TRIGGER owner_call_agent_rate BEFORE INSERT ON owner_calls
WHEN (SELECT COUNT(*) FROM owner_calls WHERE tenant=NEW.tenant AND created_by_agent_id=NEW.created_by_agent_id
  AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at,'-15 minutes')) >= 5
BEGIN SELECT RAISE(ABORT,'owner_call_agent_rate'); END;

DROP TRIGGER owner_call_owner_rate;

CREATE TRIGGER owner_call_owner_rate BEFORE INSERT ON owner_calls
WHEN (SELECT COUNT(*) FROM owner_calls WHERE tenant=NEW.tenant AND owner_member_id=NEW.owner_member_id
  AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at,'-15 minutes')) >= 20
BEGIN SELECT RAISE(ABORT,'owner_call_owner_rate'); END;

-- At most 32 logical keys per requester/ask in every retained key version. The service supports at most 8 versions,
-- bounding rows at 256/requester/ask while preserving room to backfill rotations of already-supported keys.
CREATE INDEX owner_call_alias_ask ON owner_call_key_aliases(tenant,agent_id,ask_id,key_version);
CREATE TRIGGER owner_call_alias_limit BEFORE INSERT ON owner_call_key_aliases
WHEN NOT EXISTS(SELECT 1 FROM owner_call_key_aliases WHERE tenant=NEW.tenant AND agent_id=NEW.agent_id
  AND key_version=NEW.key_version AND key_hmac=NEW.key_hmac)
 AND (SELECT COUNT(*) FROM owner_call_key_aliases WHERE tenant=NEW.tenant AND agent_id=NEW.agent_id
  AND ask_id=NEW.ask_id AND key_version=NEW.key_version) >= 32
BEGIN SELECT RAISE(ABORT,'owner_call_alias_limit'); END;

-- Canonical decisions release capacity in the same transaction. Expiry stays lazy to preserve canonical expiredCount metadata.
CREATE TRIGGER owner_call_elevation_terminal AFTER UPDATE OF status ON elevation_requests
WHEN NEW.status IN ('approved','denied','revoked') AND NEW.status IS NOT OLD.status
BEGIN
  UPDATE owner_calls SET state='closed' WHERE tenant=NEW.tenant AND action_type='elevation_request'
    AND action_id=NEW.id AND state='pending';
END;
