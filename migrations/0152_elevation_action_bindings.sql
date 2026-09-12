-- 0152_elevation_action_bindings.sql — exact-action approval binding on top of
-- the elevation ledger (migrations/0148_elevation_ledger.sql). mupot task:
-- "knowledge-action-approval" (host daemon hostd calling a new MCP tool to
-- ask "is THIS exact knowledge-write approved?" before performing it).
--
-- THE DEFECT CLASS THIS CLOSES: elevation_grants binds a human's approval to
-- an ACTION KEY + SCOPE (e.g. "action:knowledge_write on squad X"), which
-- authorizes ANY INSTANCE of that action for the life of the grant — any
-- payload, to any target, at any revision. A human clicking "approve" today
-- has no way to approve ONE exact write and refuse a different one under the
-- same live grant. This table adds a second, narrower authority: a specific
-- action's IMMUTABLE fields (target, expected revision, payload hash,
-- destination, operation, its own expiry) are bound to the elevation request
-- at approval time, and verifyProtectedAction (src/auth/protected-action.ts)
-- requires an exact match against this row IN ADDITION TO the existing
-- hasElevatedAction scope/action check — a live grant is necessary but not
-- sufficient; the exact action must also have been the one a human saw.
--
-- WHY A SEPARATE TABLE, NOT elevation_requests.reason OR requested_actions_json:
-- both are free-text/JSON blobs a caller could shape however it likes and are
-- never re-validated against anything — using either for authorization would
-- let the ACTION'S OWN CLAIM about itself stand in for evidence a human saw
-- it. A real table with typed, indexed columns and a foreign key into
-- elevation_requests makes the binding a first-class, queryable fact instead
-- of a string a reader has to trust.
--
-- WHY THE HASH IS RECOMPUTED SERVER-SIDE, NEVER TRUSTED FROM THE CLIENT:
-- action_hash is written once, by createElevationRequest, from a
-- SERVER-COMPUTED SHA-256 (src/auth/exact-action.ts exactActionHash) over the
-- exact-action fields with principal/tenant taken from the AUTHENTICATED
-- session, never from request args. At verify time, verifyProtectedAction
-- recomputes the SAME hash from the CALLER'S claimed fields (again with
-- server-derived principal/tenant) and only THEN compares it to this row's
-- action_hash and to the caller-supplied exact_action_hash — a caller can
-- never make the bound row equal to a payload nobody approved by supplying a
-- hash for it, because the row's hash was fixed before the caller ever spoke
-- and nothing here ever recomputes it from client input.
--
-- WHY expires_at HERE IS NOT elevation_grants.expires_at: the GRANT's expiry
-- is "how long this human's authorization to approve actions of this kind
-- lasts" — a policy window. THE ACTION's own expires_at is a property the
-- REQUESTER (hostd) declared about the specific write itself (e.g. "this
-- knowledge write is only valid for the next 10 minutes because the source
-- revision will be stale after that") and is part of what gets hashed and
-- approved. Both must be live for verifyProtectedAction to succeed
-- (VerifiedApproval.expires_at is the MIN of the two) — an action cannot
-- outlive its own declared window even under a grant that has hours left,
-- and a grant expiring early ends every action bound to it regardless of
-- the action's own window.
--
-- NO UPDATE PATH ANYWHERE — immutability is by construction, not by policy:
-- no function in this codebase issues an UPDATE against this table (grep
-- src/ for `UPDATE elevation_action_bindings` to confirm — there is none),
-- so an approved action's fields can never drift after a human saw them.
-- The row is created exactly once, in the SAME env.DB.batch() transaction as
-- the elevation_requests INSERT it belongs to (assertBatchWritten) — a
-- request can never exist "approved-eligible" for action:knowledge_write
-- without its exact-action binding landing atomically alongside it.
--
-- NOT applied by this build — branch/schema only, exactly like every
-- migration in this family (0143 onward): a human applies it separately.

CREATE TABLE IF NOT EXISTS elevation_action_bindings (
  id                    TEXT PRIMARY KEY,
  tenant                TEXT NOT NULL,
  elevation_request_id  TEXT NOT NULL REFERENCES elevation_requests(id) ON DELETE CASCADE,
  action                TEXT NOT NULL,   -- 'action:knowledge_write' (see elevation-actions.ts)
  principal             TEXT NOT NULL,   -- the bound agent id, SERVER-derived from the requesting session — never client-supplied
  target_system         TEXT NOT NULL,
  target_id             TEXT NOT NULL,
  target_revision       TEXT NOT NULL,
  expected_revision     TEXT NOT NULL,
  payload_hash          TEXT NOT NULL,
  destination           TEXT NOT NULL,
  operation             TEXT NOT NULL,
  -- The ACTION's own declared expiry (as the requester/hostd stated it) —
  -- distinct from elevation_grants.expires_at, the GRANT's own expiry. See
  -- header comment above.
  expires_at            TEXT NOT NULL,
  -- Computed SERVER-SIDE at request time (src/auth/exact-action.ts
  -- exactActionHash) — NEVER trusted from the client. See header comment.
  action_hash           TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  UNIQUE(elevation_request_id, action)
);

CREATE INDEX IF NOT EXISTS idx_elevation_action_bindings_request
  ON elevation_action_bindings(tenant, elevation_request_id);
