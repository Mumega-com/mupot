-- 0188_mcp_event_subscriptions.sql — MCP Events (protocol 2026-07-28) subscriptions + delivery
-- receipts (mupot#1618, PR 2).
--
-- CREATE-only: no existing table is altered, rebuilt, or dropped (D1 runs a migration file as one
-- transaction; FK RESTRICT is never deferred, so a parent-table rebuild is never safe). Numbering:
-- 0186 = open PR #1622, 0187 = open PR #1626, 0188 is reserved for this PR.
--
-- event_subscriptions
--   One row per (principal agent, callback URL, event name, canonical arguments): `id` is derived
--   deterministically from exactly those four inputs in application code, so re-subscribing is an
--   idempotent refresh (INSERT ... ON CONFLICT(id) DO UPDATE) and two concurrent identical
--   subscribes yield ONE row.
--   The `whsec_` signing secret is stored ONLY as an AES-GCM ciphertext (the connector-vault
--   mechanism, src/connectors/crypto.ts) — a hash cannot sign an outgoing webhook. Nothing in
--   this schema holds a plaintext secret. `secret_fingerprint` is the first 8 hex characters of
--   sha256(secret): a non-secret label used to detect a rotation and to scope the callback
--   verification cache. `prev_secret_ciphertext` keeps the previous secret for a bounded rotation
--   window so deliveries can be signed with old AND new (space-separated signatures).
--   `token_id` is the member_tokens row that created/refreshed the subscription: delivery stops
--   when that credential (or the agent, or the member) is no longer live. `consented_by_member_id`
--   is the consenting human of a directory-channel (OAuth consent-bound) session, or NULL: the
--   delivery-time access re-check needs it to re-derive that session's clamped capabilities.
--
-- event_delivery_receipts
--   One row per delivery ATTEMPT outcome. Metadata only: never the request body, never a secret,
--   never response bytes. Append-only (no-UPDATE / no-DELETE triggers, same shape as
--   oauth_consent_receipts, 0091).

CREATE TABLE IF NOT EXISTS event_subscriptions (
  id                     TEXT PRIMARY KEY,
  tenant                 TEXT NOT NULL,
  agent_id               TEXT NOT NULL,
  member_id              TEXT NOT NULL,
  token_id               TEXT NOT NULL,
  consented_by_member_id TEXT,
  event_name             TEXT NOT NULL,
  arguments_json         TEXT NOT NULL DEFAULT '{}',
  callback_url           TEXT NOT NULL,
  secret_ciphertext      TEXT NOT NULL,
  secret_fingerprint     TEXT NOT NULL CHECK (length(secret_fingerprint) = 8),
  prev_secret_ciphertext TEXT,
  prev_secret_expires_at TEXT,
  status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  refresh_before         TEXT NOT NULL,
  verified_at            TEXT,
  created_at             TEXT NOT NULL,
  last_refreshed_at      TEXT NOT NULL,
  revoked_at             TEXT,
  revoke_reason          TEXT
);

CREATE INDEX IF NOT EXISTS idx_event_subscriptions_delivery
  ON event_subscriptions(tenant, agent_id, event_name, status);
CREATE INDEX IF NOT EXISTS idx_event_subscriptions_callback
  ON event_subscriptions(agent_id, callback_url);

CREATE TABLE IF NOT EXISTS event_delivery_receipts (
  id              TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES event_subscriptions(id) ON DELETE RESTRICT,
  event_id        TEXT NOT NULL,
  attempt         INTEGER NOT NULL CHECK (attempt >= 1),
  outcome         TEXT NOT NULL CHECK (outcome IN ('delivered','retry','failed','gone','refused')),
  http_status     INTEGER,
  error_class     TEXT,
  signed_at       TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_delivery_receipts_sub
  ON event_delivery_receipts(subscription_id, created_at);
CREATE INDEX IF NOT EXISTS idx_event_delivery_receipts_event
  ON event_delivery_receipts(subscription_id, event_id);

-- event_delivery_enqueued: one row per (subscription, event) that has had a delivery job enqueued.
-- The INSERT OR IGNORE that writes it is the dedupe: a retry of the whole message.created queue
-- message (e.g. because another consumer leg threw) cannot enqueue a second job for the same
-- (subscription, event). Not append-only (a failed queue send removes its own marker).
CREATE TABLE IF NOT EXISTS event_delivery_enqueued (
  subscription_id TEXT NOT NULL REFERENCES event_subscriptions(id) ON DELETE RESTRICT,
  event_id        TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (subscription_id, event_id)
);

-- event_verification_attempts: one row per callback-verification attempt an agent STARTS (whether
-- it later succeeds or fails). The per-agent rate limit is an atomic INSERT ... SELECT ... WHERE
-- (count in window) < limit against this table.
CREATE TABLE IF NOT EXISTS event_verification_attempts (
  id           TEXT PRIMARY KEY,
  tenant       TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  attempted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_verification_attempts_agent
  ON event_verification_attempts(tenant, agent_id, attempted_at);

CREATE TRIGGER event_delivery_receipts_no_update
BEFORE UPDATE ON event_delivery_receipts
BEGIN
  SELECT RAISE(ABORT, 'event_delivery_receipts is append-only: UPDATE is forbidden');
END;

CREATE TRIGGER event_delivery_receipts_no_delete
BEFORE DELETE ON event_delivery_receipts
BEGIN
  SELECT RAISE(ABORT, 'event_delivery_receipts is append-only: DELETE is forbidden');
END;
