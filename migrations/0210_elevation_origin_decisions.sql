-- 0210_elevation_origin_decisions.sql — S13: a human decides an agent's
-- elevation request WITHOUT the dashboard, through the harness-attested human
-- origin channel (the same channel task_verdict uses since 0155).
--
-- NOT applied by this build. Branch/schema only; a human applies it.
--
-- WHY THE grants TABLE IS REBUILT (read before touching):
--   elevation_grants.approved_by_web_session_hash was NOT NULL + FK to
--   web_sessions: every grant had to bind to a dashboard web session. An origin
--   decision has no web session, and SQLite cannot relax NOT NULL in place. A
--   sentinel/fabricated web_sessions row was rejected (it would make a
--   "logout" fact lie about a decision that never had a session). So the grant
--   binds to ONE OF TWO anchors, enforced by a CHECK:
--     approved_via = 'web_session'            -> web session hash set, no receipt
--     approved_via = 'agent_attested_origin'  -> origin receipt set, no web session
--   hasElevatedAction re-derives the matching anchor at USE time.
--
--   Rebuild shape: elevation_usage_log holds a (NO ACTION) FK to
--   elevation_grants(id). D1 runs a migration in one transaction, so the DROP's
--   implicit DELETE would fail an immediate FK check. `PRAGMA
--   defer_foreign_keys = ON` defers it to COMMIT; the re-INSERT of every row
--   after the DROP resolves each deferred violation before then. tests/elevation-origin-migration.test.ts
--   replays this inside an explicit BEGIN/COMMIT with seeded grant + usage rows
--   and foreign_keys ON (the real-D1 shape). RECOMMENDED before applying to
--   production: rehearse on a wrangler local/staging D1 holding live rows.
--
-- The origin receipt is append-only (triggers below): "receipt intact" at use
-- time is only meaningful if it cannot be edited.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE IF NOT EXISTS elevation_origin_receipts (
  id                    TEXT PRIMARY KEY,
  tenant                TEXT NOT NULL,
  elevation_request_id  TEXT NOT NULL REFERENCES elevation_requests(id),
  member_id             TEXT NOT NULL REFERENCES members(id),   -- the resolved HUMAN
  agent_id              TEXT NOT NULL REFERENCES agents(id),    -- the calling (relaying) agent
  channel               TEXT NOT NULL CHECK (channel = 'telegram'),
  chat_id               TEXT NOT NULL,
  message_id            TEXT NOT NULL,
  message_at            TEXT NOT NULL,
  text_hash             TEXT NOT NULL CHECK (length(text_hash) = 64),
  decision              TEXT NOT NULL CHECK (decision IN ('approve','deny')),
  created_at            TEXT NOT NULL,
  UNIQUE (elevation_request_id),
  UNIQUE (tenant, channel, chat_id, message_id)
);

CREATE TRIGGER IF NOT EXISTS elevation_origin_receipts_no_update
BEFORE UPDATE ON elevation_origin_receipts
BEGIN
  SELECT RAISE(ABORT, 'elevation origin receipts are append-only');
END;

CREATE TRIGGER IF NOT EXISTS elevation_origin_receipts_no_delete
BEFORE DELETE ON elevation_origin_receipts
BEGIN
  SELECT RAISE(ABORT, 'elevation origin receipts are append-only');
END;

ALTER TABLE elevation_requests ADD COLUMN decided_via TEXT
  CHECK (decided_via IS NULL OR decided_via = 'agent_attested_origin');
ALTER TABLE elevation_requests ADD COLUMN decided_origin_receipt_id TEXT;

-- Back the rows up to a FK-free table, DROP the original (child rows in
-- elevation_usage_log become deferred violations), recreate it under its own name,
-- and re-INSERT: each re-inserted parent row resolves its deferred violations before
-- COMMIT. (Copy-into-_new + DROP + RENAME does NOT work here: SQLite counts the
-- violation at DROP and only a parent INSERT after it decrements the counter.)
CREATE TABLE elevation_grants_bak_0210 AS SELECT * FROM elevation_grants;

DROP TABLE elevation_grants;

CREATE TABLE elevation_grants (
  id                            TEXT PRIMARY KEY,
  tenant                        TEXT NOT NULL,
  elevation_request_id          TEXT NOT NULL REFERENCES elevation_requests(id) ON DELETE CASCADE,
  agent_session_id              TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  action                        TEXT NOT NULL,
  scope_type                    TEXT NOT NULL CHECK (scope_type IN ('org','department','squad')),
  scope_id                      TEXT NOT NULL DEFAULT '',
  effect                        TEXT NOT NULL CHECK (effect IN ('reversible','irreversible','revocable_if_recorded')),
  approved_by_member_id         TEXT NOT NULL REFERENCES members(id),
  approved_by_web_session_hash  TEXT REFERENCES web_sessions(id_hash),
  created_at                    TEXT NOT NULL,
  expires_at                    TEXT NOT NULL,
  revoked_at                    TEXT,
  revoke_reason                 TEXT,
  approved_via                  TEXT NOT NULL DEFAULT 'web_session'
                                  CHECK (approved_via IN ('web_session','agent_attested_origin')),
  origin_receipt_id             TEXT REFERENCES elevation_origin_receipts(id),
  UNIQUE(agent_session_id, action, scope_type, scope_id),
  CHECK (
    (approved_via = 'web_session' AND approved_by_web_session_hash IS NOT NULL AND origin_receipt_id IS NULL)
    OR
    (approved_via = 'agent_attested_origin' AND approved_by_web_session_hash IS NULL AND origin_receipt_id IS NOT NULL)
  )
);

INSERT INTO elevation_grants
  (id, tenant, elevation_request_id, agent_session_id, action, scope_type, scope_id, effect,
   approved_by_member_id, approved_by_web_session_hash, created_at, expires_at, revoked_at, revoke_reason,
   approved_via, origin_receipt_id)
SELECT
  id, tenant, elevation_request_id, agent_session_id, action, scope_type, scope_id, effect,
  approved_by_member_id, approved_by_web_session_hash, created_at, expires_at, revoked_at, revoke_reason,
  'web_session', NULL
FROM elevation_grants_bak_0210;

DROP TABLE elevation_grants_bak_0210;

CREATE INDEX IF NOT EXISTS idx_elevation_grants_live
  ON elevation_grants(tenant, agent_session_id, revoked_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_elevation_grants_request
  ON elevation_grants(tenant, elevation_request_id);
CREATE INDEX IF NOT EXISTS idx_elevation_grants_approver
  ON elevation_grants(tenant, approved_by_web_session_hash);
CREATE INDEX IF NOT EXISTS idx_elevation_grants_origin_receipt
  ON elevation_grants(origin_receipt_id);

-- Reserve the stamping-harness token labels. `elevation_decide` trusts a human_origin only
-- from a token whose label is in STAMPING_HARNESS_TOKEN_LABELS (src/auth/elevation-actions.ts),
-- but several mint paths take a caller-chosen label (squad admins, agents holding an
-- action:mint_token grant, enroll, provision). A label proves which credential was used, not
-- that a harness stamped the call, so no path may write one. The origin door therefore stays
-- closed until a server-set harness field replaces the label check. Keep this list in sync
-- with STAMPING_HARNESS_TOKEN_LABELS (pinned by tests/elevation-origin-migration.test.ts).
CREATE TRIGGER IF NOT EXISTS member_tokens_reserved_label_insert
BEFORE INSERT ON member_tokens
WHEN lower(trim(NEW.label)) IN ('hermes-gateway')
BEGIN
  SELECT RAISE(ABORT, 'member_tokens_label_reserved');
END;

CREATE TRIGGER IF NOT EXISTS member_tokens_reserved_label_update
BEFORE UPDATE OF label ON member_tokens
WHEN lower(trim(NEW.label)) IN ('hermes-gateway')
BEGIN
  SELECT RAISE(ABORT, 'member_tokens_label_reserved');
END;
