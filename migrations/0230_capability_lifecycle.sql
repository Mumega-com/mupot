-- 0230_capability_lifecycle.sql — a standing capability grant has a lifecycle.
--
-- Controls: ISO 27001 A.5.18 (access rights: provisioning, review, removal),
-- SOC 2 CC6.2 / CC6.3 (grant, modify, remove access; periodic review).
--
-- WHY
--
-- `capabilities` had no expiry, no reason, no granter and no history. Every
-- grant was permanent, and a revoke is a hard DELETE that leaves nothing behind:
-- "who held admin on this squad in September, who gave it to them, and why" was
-- unanswerable. Only elevation_grants (0148) had a lifecycle.
--
-- This migration is the schema half of that. It is ADDITIVE and CHANGES NO
-- EXISTING ROW'S AUTHORITY:
--
--   expires_at   NULL = non-expiring (every legacy grant). The liveness predicate
--                CAPABILITY_LIVE_PREDICATE (src/auth/capability.ts) reads NULL as
--                live; SQL three-valued logic would otherwise drop every NULL row
--                from a comparison and lock the whole pot out at once.
--   reason       free text the granter gave, or NULL.
--   granted_by   member or agent id that made the grant, or NULL (legacy).
--   granted_via  the surface: dashboard | mcp | elevation | delegated_operator |
--                squad_join | invite | bootstrap | migration ... NULL (legacy).
--
-- Nothing is auto-expired and nothing is backfilled.
--
-- grant_events is the append-only history sidecar. The live table keeps its
-- DELETE-on-revoke semantics (every revocation read is unchanged); history lives
-- here, and is written BY TRIGGER in the same transaction as the change:
--
--   AFTER INSERT                       -> 'granted'
--   AFTER UPDATE of capability, expiry,
--     scope or provenance              -> 'granted' (re-grant, upgrade, horizon change)
--   AFTER DELETE                       -> 'revoked' (or 'expired' for the sweeper)
--
-- A trigger cannot be forgotten by a writer, fires for the members ON DELETE
-- CASCADE and for a console DELETE, writes nothing for an INSERT OR IGNORE / ON
-- CONFLICT DO NOTHING that wrote no row, and a no-op re-grant is silent. The
-- 'granted' event takes granted_by / reason from the row itself. A DELETE carries
-- no actor, so a revoke that knows who is revoking sets grant_event_context in
-- the same batch right before the DELETE and clears it right after; a context
-- older than 60 seconds is ignored, so one that outlived its batch cannot
-- mis-attribute a later revoke. `grant_table` also admits 'gate_grants' so the
-- next step needs no change here.
ALTER TABLE capabilities ADD COLUMN expires_at TEXT;
ALTER TABLE capabilities ADD COLUMN reason TEXT;
ALTER TABLE capabilities ADD COLUMN granted_by TEXT;
ALTER TABLE capabilities ADD COLUMN granted_via TEXT;

-- memberships carries the same horizon for the agent grants written through
-- prepareAgentSquadAccess (the memberships row and the capabilities row are two
-- planes written together). Without it a time-boxed elevation leaves a standing
-- membership behind, and project messaging (which reads memberships) outlives the
-- elevation. NULL = non-expiring, exactly as on capabilities.
ALTER TABLE memberships ADD COLUMN expires_at TEXT;

-- door_receipts snapshots the prior grant so a rejected self-grant can restore it. The prior's
-- HORIZON is part of that snapshot: restoring the rank alone would resurrect an expiring grant
-- as permanent.
ALTER TABLE door_receipts ADD COLUMN capability_before_expires_at TEXT;

-- Sweep support: only the expiring subset is ever visited.
CREATE INDEX IF NOT EXISTS idx_capabilities_expiry
    ON capabilities (expires_at)
 WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS grant_events (
  id            TEXT PRIMARY KEY,
  tenant        TEXT NOT NULL DEFAULT '',
  grant_table   TEXT NOT NULL CHECK (grant_table IN ('capabilities', 'gate_grants')),
  grant_id      TEXT NOT NULL,
  event         TEXT NOT NULL CHECK (event IN ('granted', 'revoked', 'expired', 'reviewed')),
  actor         TEXT,
  reason        TEXT,
  at            TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_grant_events_grant ON grant_events (grant_table, grant_id, at);
CREATE INDEX IF NOT EXISTS idx_grant_events_tenant_at ON grant_events (tenant, at);

CREATE TRIGGER IF NOT EXISTS grant_events_no_update
BEFORE UPDATE ON grant_events
BEGIN
  SELECT RAISE(ABORT, 'grant events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS grant_events_no_delete
BEFORE DELETE ON grant_events
BEGIN
  SELECT RAISE(ABORT, 'grant events are append-only');
END;

-- Who is revoking, for the batch that is about to DELETE. One row at most.
CREATE TABLE IF NOT EXISTS grant_event_context (
  id     INTEGER PRIMARY KEY CHECK (id = 1),
  tenant TEXT,
  actor  TEXT,
  reason TEXT,
  event  TEXT NOT NULL CHECK (event IN ('revoked', 'expired')),
  at     TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS capabilities_grant_event_insert
AFTER INSERT ON capabilities
BEGIN
  INSERT INTO grant_events (id, tenant, grant_table, grant_id, event, actor, reason, at, snapshot_json)
  VALUES (
    lower(hex(randomblob(16))),
    COALESCE((SELECT tenant FROM members WHERE id = NEW.member_id), ''),
    'capabilities', COALESCE(NEW.id, 'rowid:' || NEW.rowid), 'granted', NEW.granted_by, NEW.reason,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    json_object(
      'id', COALESCE(NEW.id, 'rowid:' || NEW.rowid), 'member_id', NEW.member_id, 'scope_type', NEW.scope_type, 'scope_id', NEW.scope_id,
      'capability', NEW.capability, 'expires_at', NEW.expires_at, 'reason', NEW.reason,
      'granted_by', NEW.granted_by, 'granted_via', NEW.granted_via, 'created_at', NEW.created_at)
  );
END;

CREATE TRIGGER IF NOT EXISTS capabilities_grant_event_update
AFTER UPDATE ON capabilities
WHEN OLD.capability IS NOT NEW.capability
  OR OLD.expires_at IS NOT NEW.expires_at
  OR OLD.scope_type IS NOT NEW.scope_type
  OR OLD.scope_id IS NOT NEW.scope_id
  OR OLD.member_id IS NOT NEW.member_id
  OR OLD.granted_by IS NOT NEW.granted_by
  OR OLD.granted_via IS NOT NEW.granted_via
  OR OLD.reason IS NOT NEW.reason
BEGIN
  INSERT INTO grant_events (id, tenant, grant_table, grant_id, event, actor, reason, at, snapshot_json)
  VALUES (
    lower(hex(randomblob(16))),
    COALESCE((SELECT tenant FROM members WHERE id = NEW.member_id), ''),
    'capabilities', COALESCE(NEW.id, 'rowid:' || NEW.rowid), 'granted',
    -- a context-bracketed UPDATE (the sweeper) is attributed to the context's actor, fresh
    -- within 60s; an ordinary re-grant to the actor stamped on the row itself.
    COALESCE(
      (SELECT actor FROM grant_event_context
        WHERE id = 1 AND julianday(at) >= julianday('now') - (60.0 / 86400.0)),
      NEW.granted_by),
    COALESCE(
      (SELECT reason FROM grant_event_context
        WHERE id = 1 AND julianday(at) >= julianday('now') - (60.0 / 86400.0)),
      NEW.reason),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    json_object(
      'id', COALESCE(NEW.id, 'rowid:' || NEW.rowid), 'member_id', NEW.member_id, 'scope_type', NEW.scope_type, 'scope_id', NEW.scope_id,
      'capability', NEW.capability, 'expires_at', NEW.expires_at, 'reason', NEW.reason,
      'granted_by', NEW.granted_by, 'granted_via', NEW.granted_via, 'created_at', NEW.created_at,
      'previous_capability', OLD.capability, 'previous_expires_at', OLD.expires_at)
  );
END;

CREATE TRIGGER IF NOT EXISTS capabilities_grant_event_delete
AFTER DELETE ON capabilities
BEGIN
  INSERT INTO grant_events (id, tenant, grant_table, grant_id, event, actor, reason, at, snapshot_json)
  VALUES (
    lower(hex(randomblob(16))),
    COALESCE(
      (SELECT tenant FROM grant_event_context
        WHERE id = 1 AND julianday(at) >= julianday('now') - (60.0 / 86400.0)),
      (SELECT tenant FROM members WHERE id = OLD.member_id),
      -- a members ON DELETE CASCADE has already removed the member row by now: the
      -- grant's own first event remembers the tenant.
      (SELECT tenant FROM grant_events WHERE grant_table = 'capabilities' AND grant_id = COALESCE(OLD.id, 'rowid:' || OLD.rowid)
        ORDER BY at ASC, rowid ASC LIMIT 1),
      ''),
    'capabilities', COALESCE(OLD.id, 'rowid:' || OLD.rowid),
    COALESCE((SELECT event FROM grant_event_context
               WHERE id = 1 AND julianday(at) >= julianday('now') - (60.0 / 86400.0)), 'revoked'),
    (SELECT actor FROM grant_event_context
      WHERE id = 1 AND julianday(at) >= julianday('now') - (60.0 / 86400.0)),
    (SELECT reason FROM grant_event_context
      WHERE id = 1 AND julianday(at) >= julianday('now') - (60.0 / 86400.0)),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    json_object(
      'id', COALESCE(OLD.id, 'rowid:' || OLD.rowid), 'member_id', OLD.member_id, 'scope_type', OLD.scope_type, 'scope_id', OLD.scope_id,
      'capability', OLD.capability, 'expires_at', OLD.expires_at, 'reason', OLD.reason,
      'granted_by', OLD.granted_by, 'granted_via', OLD.granted_via, 'created_at', OLD.created_at)
  );
END;
