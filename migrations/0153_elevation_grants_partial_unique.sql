-- 0153 — data-preserving removal of the coarse session/action/scope UNIQUE.
-- Multiple independently approved exact actions may coexist for one session.
-- UNIQUE(elevation_request_id, action) still prevents duplicate grants per request.
--
-- Wrangler's D1 migration path executes the file as one FK-enforced transaction.
-- The separate fresh-pot schema applier executes statements individually and
-- marks partial application as failed, not resumable. Copy-before-drop ordering
-- keeps all records recoverable in original/rebuild/backup tables at every such
-- boundary; it does not promise in-place runtime availability after interruption.
-- Never route a populated upgrade through that fresh-pot bootstrap path.
-- Do not disable
-- foreign_keys or discard history. The audit child is copied to a temporary
-- schema object without FKs before dropping/rebuilding its parent. Both grants
-- and audit rows are restored with all original fields and IDs. A failed copy,
-- constraint, index or later statement rolls the entire migration back.
--
-- Apply the ordered migration chain, including 0143/0144/0147 prerequisites.
-- A deliberately partial-schema runtime test must model the pre-feature chain,
-- not run later dependent migrations while skipping their parents.
-- No assumptions about an empty production database are permitted here.

CREATE TABLE _elevation_usage_backup_0153 AS
SELECT id, tenant, elevation_grant_id, agent_session_id, action, tool_name, detail_json, occurred_at FROM elevation_usage_log;
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

INSERT INTO _elevation_grants_rebuild_0153 (id, tenant, elevation_request_id, agent_session_id, action, scope_type, scope_id, effect,
  approved_by_member_id, approved_by_web_session_hash, created_at, expires_at, revoked_at, revoke_reason)
SELECT id, tenant, elevation_request_id, agent_session_id, action, scope_type, scope_id, effect,
  approved_by_member_id, approved_by_web_session_hash, created_at, expires_at, revoked_at, revoke_reason FROM elevation_grants;

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

-- Restore the audit table with its original constraints and every retained record.
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

INSERT INTO elevation_usage_log (id, tenant, elevation_grant_id, agent_session_id, action, tool_name, detail_json, occurred_at)
SELECT id, tenant, elevation_grant_id, agent_session_id, action, tool_name, detail_json, occurred_at FROM _elevation_usage_backup_0153;
DROP TABLE _elevation_usage_backup_0153;

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
