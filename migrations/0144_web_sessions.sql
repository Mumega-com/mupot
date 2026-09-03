-- 0144_web_sessions.sql — queryable, listable, revocable web-session registry.
--
-- Design: docs/superpowers/specs/2026-09-01-human-approved-session-bound-agent-
-- elevation-design.md, "Human web session". Delivery Sequence step 1
-- (mupot task f5fe1222-981c-4fb8-95c2-1eacd38f3cee, mumega-com#1173).
--
-- Replaces the previously unlistable KV-only session record (src/auth/index.ts
-- mintSession) with a durable D1 row for every session created for a login
-- that resolves to a real members row. This is what makes a session listable,
-- remotely revocable, subject to a real idle/absolute expiry, and able to
-- carry a recent-reauthentication marker — none of which a plain KV TTL blob
-- can express or answer a "list mine" query about.
--
-- id_hash is the SHA-256 hex of the same random opaque value the browser
-- cookie carries (see randomId() in src/auth/index.ts) — the raw value is
-- NEVER stored, matching member_tokens.token_hash's discipline one table over.
-- A row is looked up by hashing the incoming cookie value and matching
-- id_hash; nothing here is guessable or reversible from a leaked row.
--
-- idle_expires_at / absolute_expires_at are two INDEPENDENT ceilings (v1
-- policy: 24h idle, 7d absolute) — a session is live only while `now` is
-- strictly before BOTH. idle_expires_at is bumped forward on use (coalesced to
-- at most once every five minutes — see src/auth/web-sessions.ts);
-- absolute_expires_at is fixed at creation and never bumped, so a session that
-- is used continuously still hard-expires at 7 days.
--
-- recent_reauth_at is set only by a fresh round-trip through the identity
-- provider for THIS session (never by ordinary use) — the primitive the
-- elevation approval flow's step-up gate (Delivery Sequence step 3) reads
-- before admitting a sensitive-action approval.
--
-- revoked_at + revoke_reason: logout, "sign out all devices", and an explicit
-- operator revoke all write here. Revocation is fail-closed everywhere this
-- row is read — a revoked_at IS NOT NULL row is dead regardless of its
-- expiry columns.
CREATE TABLE IF NOT EXISTS web_sessions (
  id_hash             TEXT PRIMARY KEY,
  tenant              TEXT NOT NULL,
  member_id           TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  login_identity_id   TEXT NOT NULL REFERENCES human_login_identities(id) ON DELETE CASCADE,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at        TEXT NOT NULL DEFAULT (datetime('now')),
  idle_expires_at     TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  recent_reauth_at    TEXT,
  revoked_at          TEXT,
  revoke_reason       TEXT
);

CREATE INDEX IF NOT EXISTS idx_web_sessions_member
  ON web_sessions(tenant, member_id);

CREATE INDEX IF NOT EXISTS idx_web_sessions_login_identity
  ON web_sessions(login_identity_id);
