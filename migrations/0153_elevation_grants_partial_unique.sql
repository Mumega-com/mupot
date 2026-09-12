-- 0153_elevation_grants_partial_unique.sql — rebuild elevation_grants without
-- the table-level UNIQUE(agent_session_id, action, scope_type, scope_id)
-- added by 0148. Adversarial gate finding on the exact-action approval
-- contract (mupot task "knowledge-action-approval"), P0-1 class.
--
-- THE BUG: that UNIQUE has no revoked_at/expiry qualifier, so it counts DEAD
-- rows. check_in reuses the SAME agent_sessions row across a token's whole
-- life (migrations/0147's own design), so once a session has ANY row for a
-- given (agent_session_id, action, scope_type, scope_id) tuple — live,
-- expired, or revoked — a SECOND decideElevationRequest approval for that
-- exact tuple throws a raw D1 "UNIQUE constraint failed" from the grant
-- INSERT in src/auth/elevation.ts. Because the status-flip UPDATE (SET
-- status='approved') is a SEPARATE statement that already committed before
-- that INSERT runs, the request is left stuck at status='approved' with a
-- decider recorded and ZERO grant rows — unrecoverable (decide requires
-- status='pending', so it can never be re-decided) and, since
-- src/auth/index.ts's decide route had no try/catch around this path, the
-- exception surfaced to the human as a bare 500. Net effect: exactly ONE
-- knowledge_write approval per agent session, ever — the second one silently
-- bricks the request that asked for it.
--
-- THE FIX HAS TWO PARTS (this migration is part 1 — see src/auth/elevation.ts
-- for part 2, the atomic flip+insert batch that stops the write path from
-- ever reaching that inconsistent state again even under a genuine DB error):
--
--   1. Drop the broad, liveness-blind UNIQUE entirely.
--   2. Add a NARROWER unique index scoped to what actually must never
--      duplicate: UNIQUE(elevation_request_id, action). NOT partial (not
--      `WHERE revoked_at IS NULL`) and NOT scoped to
--      (agent_session_id, action, scope_type, scope_id) at all.
--
-- WHY THIS NARROWER INVARIANT, NOT A LIVENESS-SCOPED VERSION OF THE OLD ONE:
-- 0148's original intent (design doc "Authorization Semantics") was "at most
-- one LIVE grant per session/action/scope" — reasonable for the ORIGINAL
-- coarse actions (manage_access, deploy, migrate, ...), where a live grant
-- authorizes the action generically and a second live grant for the same
-- tuple would just be redundant. But 0152's exact-action binding contract
-- (migrations/0152_elevation_action_bindings.sql) breaks that assumption on
-- purpose: verifyProtectedAction demands the LIVE grant whose OWN
-- elevation_action_bindings row matches the presented action's hash — which
-- means TWO OR MORE live action:knowledge_write grants for the exact same
-- (agent_session_id, action, scope_type, scope_id) tuple, each tied to a
-- DIFFERENT elevation_request_id and DIFFERENT exact-action binding, must be
-- able to coexist: a human approving "write page A" while "write page B"
-- (approved five minutes earlier, still live) is untouched is exactly the
-- scenario this whole contract exists to support. A liveness-scoped version
-- of the old tuple UNIQUE (`WHERE revoked_at IS NULL` on
-- agent_session_id/action/scope_type/scope_id) would still forbid that.
--
-- (elevation_request_id, action) is therefore the right invariant: it is not
-- a business rule at all, just a data-integrity backstop — a single
-- decideElevationRequest call can only ever produce ONE grant row per
-- selected action (deduplicated via `Array.from(new Set(...))` before the
-- insert, src/auth/elevation.ts), and a request can only be decided ONCE
-- (the flip's `WHERE status = 'pending'` guard), so this pair can never
-- legitimately repeat. It costs nothing and catches a future regression
-- that tries to insert two grants for one request's own action.
--
-- WHY A REAL REBUILD, NOT AN EDIT OF 0148: 0148 may already be applied to a
-- real D1. Editing an already-shipped migration file changes what a
-- database that already ran it has vs. what a fresh database gets, which is
-- exactly the class of bug scripts/check-migration-numbering.mjs and
-- scripts/check-schema-chain-fresh.mjs exist to catch one layer up. SQLite
-- has no `ALTER TABLE ... DROP CONSTRAINT` for an inline UNIQUE (it compiles
-- to an autoindex that cannot be dropped directly), so removing it requires
-- the standard rebuild: create the new table, copy, drop the old, rename.
--
-- DEVIATION (documented, not silent): this rebuild does NOT copy existing
-- rows through — it DROPs both tables and recreates them empty, rather than
-- the backup-copy-restore dance 0069 uses for a table with in-repo data.
-- This is a considered choice, not an oversight:
--
--   1. elevation_grants declares `agent_session_id REFERENCES
--      agent_sessions(id)` and `approved_by_web_session_hash REFERENCES
--      web_sessions(id_hash)`; elevation_usage_log declares the same
--      agent_sessions reference. SQLite must resolve a referenced table's
--      schema to COMPILE any INSERT into a table that declares an FK on
--      it — regardless of how many rows the INSERT would actually write
--      (verified directly against node:sqlite: `INSERT INTO x SELECT *
--      FROM y WHERE 1=0` — a statement guaranteed to insert ZERO rows —
--      still fails with "no such table" if x's declared FK target does
--      not exist). A genuine data-preserving copy through these columns
--      therefore REQUIRES agent_sessions (0147) and web_sessions (0144) to
--      already exist for this migration file to apply AT ALL — a hard
--      dependency 0148 itself never had (a bare `CREATE TABLE` needs no
--      such resolution; only DML against an FK-declaring table does).
--   2. That hard dependency broke two PRE-EXISTING, legitimate resilience
--      tests in this repo — tests/agent-sessions.test.ts's "when migration
--      0147 has not been applied yet" and tests/auth-web-session-
--      integration.test.ts's "0143_/0144_ not applied" scenarios — both of
--      which apply every OTHER migration (this repo's documented pattern:
--      "schema ships on a branch, a human applies it separately," so a
--      later-numbered migration file being present while an earlier one's
--      table is still missing is a real, if unusual, shape). Making this
--      migration's own success depend on those specific tables committed
--      this migration to a stronger assumption than the rest of the
--      codebase makes about deployment order.
--   3. Both tables this migration touches have been independently
--      reconfirmed, repeatedly, across this feature's whole development
--      history, to have NEVER been applied to any real D1 — there is no
--      real row this DROP could destroy today. `PRAGMA foreign_keys = OFF`
--      cannot be used to route around point 1 instead (documented NO-OP
--      mid-migration on D1, mupot#594, see 0069's own comment on this
--      exact trap — D1 runs the whole file in one transaction).
--
-- If either table ever holds real data before this migration is applied,
-- this DROP will discard it — re-derive a backup-copy-restore version of
-- this migration first if that has become true by the time it is applied.

DROP TABLE elevation_usage_log;

CREATE TABLE _elevation_grants_rebuild_0153 (
  id                            TEXT PRIMARY KEY,
  tenant                        TEXT NOT NULL,
  elevation_request_id          TEXT NOT NULL REFERENCES elevation_requests(id) ON DELETE CASCADE,
  agent_session_id              TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  action                        TEXT NOT NULL,   -- 'action:*' — see elevation-actions.ts ELEVATION_ACTIONS
  scope_type                    TEXT NOT NULL CHECK (scope_type IN ('org','department','squad')),
  scope_id                      TEXT NOT NULL DEFAULT '',
  effect                        TEXT NOT NULL CHECK (effect IN ('reversible','irreversible','revocable_if_recorded')),
  approved_by_member_id         TEXT NOT NULL REFERENCES members(id),
  approved_by_web_session_hash  TEXT NOT NULL REFERENCES web_sessions(id_hash),
  created_at                    TEXT NOT NULL,
  expires_at                    TEXT NOT NULL,
  revoked_at                    TEXT,
  revoke_reason                 TEXT
  -- NO table-level UNIQUE here — see header. Replaced by the narrower named
  -- index below, added AFTER the rename (SQLite indexes are named,
  -- independent objects, unlike the inline UNIQUE's autoindex).
);

DROP TABLE elevation_grants;
ALTER TABLE _elevation_grants_rebuild_0153 RENAME TO elevation_grants;

-- THE replacement invariant — see header for why this shape, not a
-- liveness-scoped version of the old broad tuple.
CREATE UNIQUE INDEX IF NOT EXISTS idx_elevation_grants_request_action
  ON elevation_grants(elevation_request_id, action);

CREATE INDEX IF NOT EXISTS idx_elevation_grants_live
  ON elevation_grants(tenant, agent_session_id, revoked_at, expires_at);

CREATE INDEX IF NOT EXISTS idx_elevation_grants_request
  ON elevation_grants(tenant, elevation_request_id);

CREATE INDEX IF NOT EXISTS idx_elevation_grants_approver
  ON elevation_grants(tenant, approved_by_web_session_hash);

-- Recreate elevation_usage_log exactly as 0148 defined it (see header's
-- DEVIATION note — recreated empty, not restored from a backup).
CREATE TABLE elevation_usage_log (
  id                  TEXT PRIMARY KEY,
  tenant              TEXT NOT NULL,
  elevation_grant_id  TEXT NOT NULL REFERENCES elevation_grants(id),
  agent_session_id    TEXT NOT NULL REFERENCES agent_sessions(id),
  action               TEXT NOT NULL,
  tool_name            TEXT,
  detail_json          TEXT,
  occurred_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_elevation_usage_log_grant
  ON elevation_usage_log(tenant, elevation_grant_id, occurred_at);

-- ── part 2 of the atomic-decide fix: a per-attempt correlation nonce ────────
--
-- decideElevationRequest (src/auth/elevation.ts) now issues the status-flip
-- UPDATE and every grant INSERT as ONE env.DB.batch() — required so a hard
-- DB failure on any grant INSERT rolls back the flip too (this is the
-- "batch atomicity" half of the P0-1 fix; a real INSERT failure must leave
-- the request 'pending' and re-decidable, never 'approved' with partial or
-- zero grants).
--
-- Within that one transaction, each grant INSERT must still be able to tell
-- "did MY OWN flip actually win the race" — a concurrent second decision on
-- the SAME request (Security Invariant 6's "double-approve yields one
-- terminal decision") must not insert a second grant set. The naive way to
-- express that guard is `WHERE EXISTS (SELECT 1 FROM elevation_requests
-- WHERE status='approved' AND decided_at=<this call's timestamp> AND
-- decided_by_member_id=<this call's approver>)` — but that is WRONG when two
-- concurrent calls share the exact same nowMs/approver (exactly what
-- tests/elevation.test.ts's "concurrent double-approve" test does, and what
-- a caller might legitimately do if it captured `nowMs` once and reused it):
-- the LOSING call's own guard would then match the WINNING call's
-- already-committed row purely by VALUE COINCIDENCE and insert a duplicate
-- grant set anyway — the exact bug this column exists to rule out.
--
-- decision_attempt_id is a per-call `crypto.randomUUID()` nonce, generated
-- FRESH inside decideElevationRequest on every invocation regardless of the
-- caller's own input. The flip writes it; each grant INSERT's guard checks
-- `decision_attempt_id = <this call's own nonce>`. Two concurrent calls can
-- never coincidentally generate the same nonce, so the guard can only ever
-- match the transaction that ACTUALLY performed the flip that wrote it —
-- content-coincidence is structurally impossible, not just unlikely.
--
-- Never read back or exposed anywhere outside decideElevationRequest's own
-- transaction — not in ElevationRequestRecord, not in any API/dashboard
-- response. Nullable and left as-is after the decision; it is write-once,
-- read-once-in-the-same-transaction plumbing, not application state.
ALTER TABLE elevation_requests ADD COLUMN decision_attempt_id TEXT;
