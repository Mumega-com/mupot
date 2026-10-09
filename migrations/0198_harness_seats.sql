-- 0198_harness_seats.sql — mupot#1794 W1: harnesses + agent seats (zero-touch seat onboarding).
--
-- MODEL (three layers): the LOGIN is a human member; a HARNESS is one OAuth client install
-- (Cursor, ChatGPT, Claude, Grok ...) that human consented through; an AGENT SEAT is one
-- thread / worktree / bot inside that harness, resolved to ONE agent by a server-normalised
-- workspace key. Names and folders are LABELS, never authority: authority is always the human
-- member's live grants, clamped (see src/members/seat-select.ts).
--
-- Behind SEAT_AUTO_ENROLL (unset in prod). This migration is additive: with the flag off no
-- row is ever written to either table and no existing code path reads them.
--
-- harnesses: one row per (tenant, member, oauth_client_id). client_name / kind are display
-- labels taken from the OAuth client registration; they are updated on every re-consent and
-- are NEVER consulted for an authorization decision.
CREATE TABLE IF NOT EXISTS harnesses (
  id              TEXT PRIMARY KEY,
  tenant          TEXT NOT NULL,
  member_id       TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  oauth_client_id TEXT NOT NULL CHECK (length(oauth_client_id) BETWEEN 1 AND 512),
  client_name     TEXT NOT NULL DEFAULT '' CHECK (length(client_name) <= 120),   -- label only
  kind            TEXT NOT NULL DEFAULT 'unknown' CHECK (length(kind) BETWEEN 1 AND 32),  -- label only
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant, member_id, oauth_client_id)
);

CREATE INDEX IF NOT EXISTS idx_harnesses_member ON harnesses (tenant, member_id);

-- agent_seats: (tenant, member, harness, key_hash) -> exactly one agent.
--   key_hash       sha256 of the canonical v1 key string (member id + harness id + normalised
--                  project/squad/folder/thread). Only the hash is stored: a full filesystem
--                  path is never persisted. label_basename is the last folder segment (or the
--                  project) for human-readable display.
--   agent_id       UNIQUE: one agent can back at most one seat, so a seat row can never be
--                  re-pointed at somebody else's agent. RESTRICT: an agent with a seat cannot
--                  be hard-deleted out from under it (agent_member_bindings already RESTRICTs).
--   max_live       the per-member cap IN FORCE when the row was issued; the cap trigger below
--                  reads it, so the cap is enforced INSIDE the same D1 batch/transaction that
--                  creates the agent, and a refused seat rolls the WHOLE batch back (a
--                  zero-row "capped INSERT ... SELECT" would instead commit the agent, member,
--                  binding and token and leave them orphaned; D1 batches roll back on ERROR
--                  only, never on a zero-row write).
--   retired_at     set once; a retired seat's key is never resurrected.
CREATE TABLE IF NOT EXISTS agent_seats (
  id             TEXT PRIMARY KEY,
  tenant         TEXT NOT NULL,
  member_id      TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  harness_id     TEXT NOT NULL REFERENCES harnesses(id) ON DELETE RESTRICT,
  key_hash       TEXT NOT NULL CHECK (length(key_hash) = 64),
  agent_id       TEXT NOT NULL UNIQUE REFERENCES agents(id) ON DELETE RESTRICT,
  label_basename TEXT NOT NULL DEFAULT '' CHECK (length(label_basename) <= 64),
  max_live       INTEGER NOT NULL CHECK (max_live BETWEEN 1 AND 256),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  retired_at     TEXT,
  UNIQUE (tenant, member_id, harness_id, key_hash)
);

CREATE INDEX IF NOT EXISTS idx_agent_seats_member_live ON agent_seats (tenant, member_id, retired_at);

-- Per-member cap, atomic with the insert. Counts LIVE seats for the same (tenant, member): a seat
-- is live while retired_at IS NULL AND its agent is still status='active'. Counting the agent's
-- status matters because nothing writes retired_at yet: a deactivated seat agent must stop holding
-- a cap slot, or the cap becomes a permanent lockout. Raises -> the entire seat_select batch (agent, member, binding, capability,
-- token, audit, seat) rolls back: zero orphans.
CREATE TRIGGER IF NOT EXISTS agent_seats_cap_insert
BEFORE INSERT ON agent_seats
FOR EACH ROW
WHEN NEW.retired_at IS NULL
 AND (SELECT COUNT(*) FROM agent_seats s
       JOIN agents a ON a.id = s.agent_id
       WHERE s.tenant = NEW.tenant AND s.member_id = NEW.member_id
         AND s.retired_at IS NULL AND a.status = 'active') >= NEW.max_live
BEGIN
  SELECT RAISE(ABORT, 'seat_cap_exceeded');
END;

-- A seat is an identity record: only retired_at may ever change, and only NULL -> value once.
CREATE TRIGGER IF NOT EXISTS agent_seats_immutable
BEFORE UPDATE ON agent_seats
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id
  OR NEW.tenant IS NOT OLD.tenant
  OR NEW.member_id IS NOT OLD.member_id
  OR NEW.harness_id IS NOT OLD.harness_id
  OR NEW.key_hash IS NOT OLD.key_hash
  OR NEW.agent_id IS NOT OLD.agent_id
  OR NEW.label_basename IS NOT OLD.label_basename
  OR NEW.max_live IS NOT OLD.max_live
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS NOT OLD.retired_at)
BEGIN
  SELECT RAISE(ABORT, 'agent_seat_immutable');
END;

CREATE TRIGGER IF NOT EXISTS agent_seats_no_delete
BEFORE DELETE ON agent_seats
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'agent_seat_immutable');
END;
