-- 0213_secure_drop.sql - secure drops, wave W2 (docs/architecture/secure-moments.md, "W2: secure drops").
--
-- A host (an agent machine) registers an X25519 PUBLIC key. An agent asks for a credential with credential_request,
-- a human seals the secret IN THE BROWSER to that key (HPKE, RFC 9180) on the secure page, and mupot stores the
-- ciphertext only: this schema has no plaintext column and the server has no decrypt path. The host pulls,
-- opens, writes a 0600 file and acks, which deletes the ciphertext (the CHECKs below make "ciphertext outside the
-- ready state" unrepresentable).

-- One LIVE key per agent (partial UNIQUE); rotation revokes the old row. public_key_b64u is the raw 32-byte key,
-- base64url without padding (43 characters). fingerprint = lowercase hex sha256 of those 32 raw bytes.
CREATE TABLE IF NOT EXISTS host_keys (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  public_key_b64u TEXT NOT NULL CHECK (length(public_key_b64u) = 43 AND public_key_b64u NOT GLOB '*[^A-Za-z0-9_-]*'),
  fingerprint TEXT NOT NULL CHECK (
    length(fingerprint) = 64 AND fingerprint = lower(fingerprint) AND fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_host_keys_live_agent
  ON host_keys(tenant, agent_id)
  WHERE revoked_at IS NULL;

-- A credential request and, once a human has provided it, its sealed ciphertext. id doubles as the moment's
-- subject_id and as the HPKE info/aad drop id. status:
--   requested -> ready (sealed secret stored) | denied | expired
--   ready     -> delivered (host acked: enc/ct deleted) | expired | revoked
--   delivered -> revoked (a revoke instruction the host acked)
CREATE TABLE IF NOT EXISTS secure_drops (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  moment_id TEXT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  host_key_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 63 AND name NOT GLOB '*[^a-z0-9_-]*' AND name NOT GLOB '[_-]*'),
  purpose TEXT NOT NULL CHECK (length(purpose) BETWEEN 1 AND 280),
  scope_hint TEXT CHECK (scope_hint IS NULL OR length(scope_hint) <= 200),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'ready', 'delivered', 'denied', 'expired', 'revoked')),
  enc_b64u TEXT CHECK (enc_b64u IS NULL OR (length(enc_b64u) = 43 AND enc_b64u NOT GLOB '*[^A-Za-z0-9_-]*')),
  ct_b64u TEXT CHECK (ct_b64u IS NULL OR (length(ct_b64u) BETWEEN 23 AND 11000 AND ct_b64u NOT GLOB '*[^A-Za-z0-9_-]*')),
  ct_sha256 TEXT CHECK (ct_sha256 IS NULL OR (
    length(ct_sha256) = 64 AND ct_sha256 = lower(ct_sha256) AND ct_sha256 NOT GLOB '*[^0-9a-f]*'
  )),
  decided_by_member_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  provided_at TEXT,
  retain_until TEXT,
  delivered_at TEXT,
  revoke_requested_at TEXT,
  revoke_requested_by TEXT,
  revoke_acked_at TEXT,
  -- Ciphertext exists exactly while the drop is 'ready': leaving that state without deleting it is a constraint error.
  CHECK ((status = 'ready') = (enc_b64u IS NOT NULL AND ct_b64u IS NOT NULL)),
  CHECK ((enc_b64u IS NULL) = (ct_b64u IS NULL)),
  CHECK (status <> 'ready' OR (ct_sha256 IS NOT NULL AND provided_at IS NOT NULL AND retain_until IS NOT NULL))
);

-- One open request per (agent, name): a second credential_request for a name whose request is still open
-- supersedes the old one in code; two concurrent ones collapse here.
CREATE UNIQUE INDEX IF NOT EXISTS uq_secure_drops_open_name
  ON secure_drops(tenant, agent_id, name)
  WHERE status IN ('requested', 'ready');

CREATE INDEX IF NOT EXISTS idx_secure_drops_agent
  ON secure_drops(tenant, agent_id, status);

-- The secure_moments CHECKs name the kinds and decisions W1 knew. SQLite cannot alter a CHECK, so the table is
-- rebuilt (same columns, same constraints plus 'credential' as a kind and 'provide' as a decision; rows and both
-- indexes preserved). Nothing references secure_moments by foreign key, trigger or view.
CREATE TABLE secure_moments_new (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('seed_attach', 'elevation', 'credential')),
  subject_id TEXT NOT NULL,
  requester_agent_id TEXT,
  decider_member_id TEXT,
  link_token_sha256 TEXT NOT NULL CHECK (
    length(link_token_sha256) = 64 AND link_token_sha256 = lower(link_token_sha256) AND link_token_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'expired', 'denied')),
  step_up_required INTEGER NOT NULL DEFAULT 1 CHECK (step_up_required = 1),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decision TEXT CHECK (decision IS NULL OR decision IN ('approve', 'deny', 'provide')),
  decided_via TEXT CHECK (decided_via IS NULL OR decided_via IN ('webauthn')),
  decided_by_member_id TEXT,
  decided_passkey_id TEXT
);

INSERT INTO secure_moments_new
  (id, tenant, kind, subject_id, requester_agent_id, decider_member_id, link_token_sha256, status, step_up_required,
   created_at, expires_at, decided_at, decision, decided_via, decided_by_member_id, decided_passkey_id)
SELECT id, tenant, kind, subject_id, requester_agent_id, decider_member_id, link_token_sha256, status, step_up_required,
       created_at, expires_at, decided_at, decision, decided_via, decided_by_member_id, decided_passkey_id
  FROM secure_moments;

DROP TABLE secure_moments;

ALTER TABLE secure_moments_new RENAME TO secure_moments;

CREATE UNIQUE INDEX IF NOT EXISTS uq_secure_moments_pending_subject
  ON secure_moments(tenant, kind, subject_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_secure_moments_subject
  ON secure_moments(tenant, kind, subject_id, status);

-- passkey_challenges.decision allows 'approve'/'deny' only; a credential 'provide' challenge is bound to
-- sha256(enc || ciphertext) in payload_sha256. Rebuilt for the same reason.
CREATE TABLE passkey_challenges_new (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('enrol', 'decide')),
  challenge_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(challenge_sha256) = 64 AND challenge_sha256 = lower(challenge_sha256) AND challenge_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  member_id TEXT,
  enrolment_token_id TEXT,
  moment_id TEXT,
  decision TEXT CHECK (decision IS NULL OR decision IN ('approve', 'deny', 'provide')),
  payload_sha256 TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  CHECK (purpose <> 'enrol' OR (member_id IS NOT NULL AND enrolment_token_id IS NOT NULL)),
  CHECK (purpose <> 'decide' OR (moment_id IS NOT NULL AND decision IS NOT NULL AND payload_sha256 IS NOT NULL))
);

INSERT INTO passkey_challenges_new
  (id, tenant, purpose, challenge_sha256, member_id, enrolment_token_id, moment_id, decision, payload_sha256,
   created_at, expires_at, consumed_at)
SELECT id, tenant, purpose, challenge_sha256, member_id, enrolment_token_id, moment_id, decision, payload_sha256,
       created_at, expires_at, consumed_at
  FROM passkey_challenges;

DROP TABLE passkey_challenges;

ALTER TABLE passkey_challenges_new RENAME TO passkey_challenges;
