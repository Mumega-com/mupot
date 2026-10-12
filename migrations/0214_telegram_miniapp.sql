-- 0214_telegram_miniapp.sql — secure moments, wave W4: the Telegram Mini App adapter
-- (docs/architecture/secure-moments.md, "W4"). Self-contained: it touches only the tables below and rebuilds
-- seed_attach_requests (widening decided_via to telegram_miniapp); 0213 (secure drops) does not touch that table.
--
-- A Telegram "device" is a biometric-unlocked secret the Mini App keeps in Telegram's BiometricManager storage.
-- It is attested only by the Telegram client (weaker than a WebAuthn passkey) and is therefore bound to a member
-- AND a Telegram user id AND a live login identity, stored only as a sha256, and revoked by the same levers as a
-- passkey. It proves a second factor on top of initData; it never grants authority.

-- Single-use, 10-minute link minted from a live dashboard session (same rules as the passkey enrolment link).
-- Opening it inside the Mini App enrols a device for the member it names, and only if the Telegram user that opens
-- it IS that member (through the existing members.telegram_chat_id binding).
CREATE TABLE IF NOT EXISTS tg_miniapp_enrolment_tokens (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  login_identity_id TEXT,
  token_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(token_sha256) = 64 AND token_sha256 = lower(token_sha256) AND token_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tg_miniapp_enrolment_tokens_member
  ON tg_miniapp_enrolment_tokens(tenant, member_id, consumed_at);

-- Pending = confirmed_at IS NULL (issued, not yet proven to round-trip through BiometricManager); active = confirmed
-- and not revoked. At most ONE pending device per enrolment link.
CREATE TABLE IF NOT EXISTS tg_miniapp_devices (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  telegram_user_id TEXT NOT NULL CHECK (telegram_user_id NOT GLOB '*[^0-9]*' AND telegram_user_id GLOB '[1-9]*'),
  login_identity_id TEXT,
  enrolment_token_id TEXT NOT NULL,
  secret_sha256 TEXT NOT NULL CHECK (
    length(secret_sha256) = 64 AND secret_sha256 = lower(secret_sha256) AND secret_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  revoked_reason TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tg_miniapp_devices_pending_token
  ON tg_miniapp_devices(enrolment_token_id)
  WHERE confirmed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tg_miniapp_devices_member
  ON tg_miniapp_devices(tenant, member_id, revoked_at);

-- Which channel decided a moment: secure_moments.decided_via only allows 'webauthn', and that table is not rebuilt
-- here, so a Telegram decision leaves decided_via NULL and lands one row here in the SAME batch as the consume.
CREATE TABLE IF NOT EXISTS tg_miniapp_decisions (
  moment_id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  member_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'deny')),
  decided_at TEXT NOT NULL
);

-- 0212 allowed decided_via IN ('access_passkey', 'webauthn'). SQLite cannot alter a CHECK, so seed_attach_requests
-- is rebuilt once more to also allow 'telegram_miniapp': same columns, constraints, rows and both indexes.
CREATE TABLE seed_attach_requests_new (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  requester_member_id TEXT NOT NULL,
  requester_agent_id TEXT,
  seed_sha256 TEXT NOT NULL CHECK (
    length(seed_sha256) = 64 AND seed_sha256 = lower(seed_sha256) AND seed_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json)),
  requests_json TEXT NOT NULL CHECK (json_valid(requests_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applying', 'applied', 'denied', 'failed', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by_member_id TEXT,
  decided_via TEXT CHECK (decided_via IS NULL OR decided_via IN ('access_passkey', 'webauthn', 'telegram_miniapp')),
  decision_error TEXT
);

INSERT INTO seed_attach_requests_new
  (id, tenant, requester_member_id, requester_agent_id, seed_sha256, canonical_json, requests_json,
   status, created_at, expires_at, decided_at, decided_by_member_id, decided_via, decision_error)
SELECT id, tenant, requester_member_id, requester_agent_id, seed_sha256, canonical_json, requests_json,
       status, created_at, expires_at, decided_at, decided_by_member_id, decided_via, decision_error
  FROM seed_attach_requests;

DROP TABLE seed_attach_requests;

ALTER TABLE seed_attach_requests_new RENAME TO seed_attach_requests;

CREATE INDEX IF NOT EXISTS idx_seed_attach_requests_requester
  ON seed_attach_requests(tenant, requester_member_id, status, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_seed_attach_requests_pending_identity
  ON seed_attach_requests(tenant, requester_member_id, seed_sha256)
  WHERE status = 'pending';
