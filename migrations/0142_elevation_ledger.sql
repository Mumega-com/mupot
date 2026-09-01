-- 0142_elevation_ledger.sql — the elevation ledger: request, grant, and usage
-- log tables for Delivery Sequence step 3 (session-bound agent elevation).
--
-- Design: docs/superpowers/specs/2026-09-01-human-approved-session-bound-agent-
-- elevation-design.md, "Elevation Data Model". mupot task f5fe1222, GitHub
-- mumega-com#1173. NOT applied by this build — branch/schema only, exactly
-- like migrations 0139-0141 before it; a human applies it separately.
--
-- DEVIATION FROM THE DESIGN DOC'S SCHEMA (recorded here, not silently):
--   1. grant_type is DROPPED. The design's agent_session_grants table allowed
--      a 'rank' grant up to 'admin'. The step-3 task brief is an explicit,
--      narrower hard constraint: "GRANT OVER NAMED ACTIONS, NEVER OVER THE
--      WORD `admin`" — admin bundles project lifecycle, identity mint, key
--      registration, capability granting, and budget into one undecomposed
--      word. Every grant in THIS table is an 'action:*' key. A future rank-
--      grant preset (design's "Admin session — advanced owner-only preset")
--      is out of scope for this step and would need its own explicit review.
--   2. scope_type is {org, department, squad} — the design doc's schema also
--      listed 'project', but src/types.ts's real, live CapabilityScopeType
--      (the ONE standing-authority scope enum this codebase actually has,
--      see src/auth/capability.ts) is {org, department, squad}. Elevation
--      grants CLAMP to the approving human's standing scope authority (see
--      src/auth/elevation.ts), so inventing a fourth scope type here would
--      let an elevation name a scope standing authority itself cannot
--      express — a strictly WIDER surface than the human's own capability
--      grid. Kept in lockstep with the real enum instead.
--   3. effect is ADDED (not in the design doc). Step-3 constraint 4 requires
--      "CLASSIFY EVERY ACTION BY WHETHER ITS EFFECT SURVIVES EXPIRY" and
--      that the classification be visible IN THE DATA MODEL, not just in
--      code — so an approval surface can render it before the click. The
--      canonical action→effect map lives in src/auth/elevation-actions.ts;
--      this column is a frozen COPY taken at grant time (the approver saw
--      exactly this classification when they clicked), never a live join
--      against a table that could change the classification retroactively
--      under an already-granted elevation.
--   4. elevation_usage_log is ADDED (not in the design doc). Step-3
--      constraint 7 requires an itemised, queryable-after-expiry record of
--      what was actually done under a grant. ON DELETE CASCADE is
--      deliberately NOT used from elevation_grants — see that table's
--      comment; the log must outlive nothing.
--
-- Every clock read in src/auth/elevation.ts is an explicit injectable
-- parameter (never Date.now() read internally by a loader) — the same house
-- rule migrations 0140/0141's modules follow, and the one a controlled-clock
-- adversarial expiry test depends on.

CREATE TABLE IF NOT EXISTS elevation_requests (
  id                          TEXT PRIMARY KEY,
  tenant                      TEXT NOT NULL,
  agent_session_id            TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  agent_id                    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  member_id                   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  requested_actions_json      TEXT NOT NULL,   -- JSON array of 'action:*' keys (see elevation-actions.ts)
  requested_scope_type        TEXT NOT NULL CHECK (requested_scope_type IN ('org','department','squad')),
  requested_scope_id          TEXT NOT NULL DEFAULT '',
  -- Kept in lockstep with ELEVATION_DURATION_PRESETS_MINUTES
  -- (src/auth/elevation-actions.ts) — 1446 is Hadi's own explicit duration
  -- (verbatim "time limited 1446", mupot task f5fe1222), added before this
  -- migration was ever applied anywhere, so the CHECK is edited in place
  -- rather than via a follow-up ALTER-TABLE migration.
  requested_duration_minutes  INTEGER NOT NULL CHECK (requested_duration_minutes IN (15, 60, 240, 480, 1440, 1446)),
  reason                      TEXT NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending','approved','denied','expired','revoked')),
  created_at                  TEXT NOT NULL,
  decision_expires_at         TEXT NOT NULL,   -- the REQUEST itself lapses (v1: 10 minutes)
  decided_at                  TEXT,
  decided_by_member_id        TEXT REFERENCES members(id),
  decided_by_web_session_hash TEXT REFERENCES web_sessions(id_hash),
  decision_note                TEXT
);

CREATE INDEX IF NOT EXISTS idx_elevation_requests_pending
  ON elevation_requests(tenant, status, created_at);

CREATE INDEX IF NOT EXISTS idx_elevation_requests_session
  ON elevation_requests(tenant, agent_session_id);

-- The live grant. Bound to ONE EXACT agent_sessions.id (Security Invariant 2
-- of the design: "sibling tokens, OAuth sessions, seats, and agents inherit
-- nothing"). Deliberately NOT ON DELETE CASCADE from agent_sessions in a way
-- that would let a grant survive its session going away silently — the
-- FOREIGN KEY itself still cascades (a deleted session cannot leave an
-- orphaned live grant), but the ordinary lifecycle path is REVOCATION
-- (revoked_at), never a DELETE; nothing in this codebase deletes
-- agent_sessions rows today (see migration 0141's comment: retire, never
-- delete). expires_at is fixed at grant time and NEVER extended by anything
-- that touches agent_sessions (no idle ceiling here) — see the constraint-2
-- adversarial test in tests/elevation.test.ts.
CREATE TABLE IF NOT EXISTS elevation_grants (
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
  revoke_reason                 TEXT,
  UNIQUE(agent_session_id, action, scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_elevation_grants_live
  ON elevation_grants(tenant, agent_session_id, revoked_at, expires_at);

CREATE INDEX IF NOT EXISTS idx_elevation_grants_request
  ON elevation_grants(tenant, elevation_request_id);

CREATE INDEX IF NOT EXISTS idx_elevation_grants_approver
  ON elevation_grants(tenant, approved_by_web_session_hash);

-- Itemised usage: one row per action actually taken under a grant. Queryable
-- after the grant expires or is revoked — an elevation that leaves no trace
-- of what it was used for is unauditable exactly when it matters (constraint
-- 7). No ON DELETE CASCADE from elevation_grants: the log must be able to
-- outlive the grant row conceptually (nothing deletes elevation_grants today
-- either, but this makes the intent explicit rather than accidental).
CREATE TABLE IF NOT EXISTS elevation_usage_log (
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
