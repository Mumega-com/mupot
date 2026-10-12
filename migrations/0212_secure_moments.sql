-- 0212_secure_moments.sql — secure moments, wave W1 (docs/architecture/secure-moments.md). Additive except
-- the seed_attach_requests rebuild below.
--
-- A secure moment is a single-use, expiring request for a HUMAN decision, delivered as a one-time link and
-- decided on a dedicated host with a WebAuthn passkey assertion. The link token is stored only as a sha256.
-- A passkey proves WHO decided; it never grants WHAT: the decider's authority is re-checked at decision time.

-- At most ONE pending moment per (tenant, kind, subject): a partial UNIQUE index, so two concurrent
-- filings of the same request collapse to one moment instead of racing past a read-then-insert check.
-- status: pending -> consumed (approved) | denied ; pending -> expired (written lazily; a pending row past
-- expiry is never decidable either way). decider_member_id NULL = any member whose authority passes the
-- decision-time check; non-NULL = only that member's passkey is accepted.
CREATE TABLE IF NOT EXISTS secure_moments (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('seed_attach', 'elevation')),
  subject_id TEXT NOT NULL,
  requester_agent_id TEXT,
  decider_member_id TEXT,
  link_token_sha256 TEXT NOT NULL CHECK (
    length(link_token_sha256) = 64 AND link_token_sha256 = lower(link_token_sha256) AND link_token_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'expired', 'denied')),
  -- W1: a fresh user-verified passkey assertion is ALWAYS required. The column is the hook a later migration
  -- would relax; the CHECK keeps any writer from storing a moment that skips the step-up today.
  step_up_required INTEGER NOT NULL DEFAULT 1 CHECK (step_up_required = 1),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decision TEXT CHECK (decision IS NULL OR decision IN ('approve', 'deny')),
  decided_via TEXT CHECK (decided_via IS NULL OR decided_via IN ('webauthn')),
  decided_by_member_id TEXT,
  decided_passkey_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_secure_moments_pending_subject
  ON secure_moments(tenant, kind, subject_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_secure_moments_subject
  ON secure_moments(tenant, kind, subject_id, status);

-- A member's registered passkeys. public_key is the SPKI DER (base64url) of an ES256 (cose_alg -7) key.
-- credential_id is unique per tenant. sign_count only moves forward (a non-zero regression is a clone).
-- login_identity_id: the live login identity of the dashboard session that enrolled this passkey; an
-- elevation grant decided with this passkey binds to a session minted against it (revoked identity => no grant).
CREATE TABLE IF NOT EXISTS member_passkeys (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  login_identity_id TEXT REFERENCES human_login_identities(id) ON DELETE SET NULL,
  credential_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  cose_alg INTEGER NOT NULL DEFAULT -7 CHECK (cose_alg = -7),
  sign_count INTEGER NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  transports TEXT,
  aaguid TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  UNIQUE (tenant, credential_id)
);

CREATE INDEX IF NOT EXISTS idx_member_passkeys_member
  ON member_passkeys(tenant, member_id, revoked_at);

-- Single-use enrolment link, bound to the member whose dashboard session minted it. 10 minutes. sha256 only.
CREATE TABLE IF NOT EXISTS passkey_enrolment_tokens (
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

CREATE INDEX IF NOT EXISTS idx_passkey_enrolment_tokens_member
  ON passkey_enrolment_tokens(tenant, member_id, consumed_at);

-- WebAuthn challenges: single-use, short-lived (the code mints 5 minutes), bound to a purpose.
--   enrol  -> bound to the member and the enrolment token;
--   decide -> bound to the moment id, the decision, and a digest of the decision parameters (the exact
--             grant the human saw), so a challenge minted for one decision can never carry another.
-- Only the sha256 of the challenge is stored.
CREATE TABLE IF NOT EXISTS passkey_challenges (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('enrol', 'decide')),
  challenge_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(challenge_sha256) = 64 AND challenge_sha256 = lower(challenge_sha256) AND challenge_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  member_id TEXT,
  enrolment_token_id TEXT,
  moment_id TEXT,
  decision TEXT CHECK (decision IS NULL OR decision IN ('approve', 'deny')),
  payload_sha256 TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  CHECK (purpose <> 'enrol' OR (member_id IS NOT NULL AND enrolment_token_id IS NOT NULL)),
  CHECK (purpose <> 'decide' OR (moment_id IS NOT NULL AND decision IS NOT NULL AND payload_sha256 IS NOT NULL))
);

-- 0211 allowed decided_via = 'access_passkey' only. SQLite cannot alter a CHECK, so seed_attach_requests is
-- rebuilt to also allow 'webauthn': same columns, same constraints, rows and both indexes preserved.
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
  decided_via TEXT CHECK (decided_via IS NULL OR decided_via IN ('access_passkey', 'webauthn')),
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
