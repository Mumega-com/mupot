-- 0073_agent_connection_pending_quota.sql — bound abandoned setup reservations.
--
-- The quota is scoped to the full request actor identity. It is enforced in
-- SQLite so concurrent Workers cannot both pass an application-side count.

CREATE TRIGGER agent_connection_pending_quota_insert
BEFORE INSERT ON agent_connection_requests
WHEN NEW.status = 'pending'
 AND (
   SELECT COUNT(*)
     FROM agent_connection_requests
    WHERE tenant = NEW.tenant
      AND actor_kind = NEW.actor_kind
      AND actor_id = NEW.actor_id
      AND status = 'pending'
 ) >= 3
BEGIN
  SELECT RAISE(ABORT, 'agent_connection_pending_quota');
END;

CREATE TRIGGER agent_connection_pending_quota_update
BEFORE UPDATE OF tenant, actor_kind, actor_id, status ON agent_connection_requests
WHEN NEW.status = 'pending'
 AND OLD.status <> 'pending'
 AND (
   SELECT COUNT(*)
     FROM agent_connection_requests
    WHERE tenant = NEW.tenant
      AND actor_kind = NEW.actor_kind
      AND actor_id = NEW.actor_id
      AND status = 'pending'
 ) >= 3
BEGIN
  SELECT RAISE(ABORT, 'agent_connection_pending_quota');
END;
