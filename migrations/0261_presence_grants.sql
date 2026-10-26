-- 0261_presence_grants.sql — user-verified passkey presence for human decisions that WIDEN authority.
--
-- A presence grant is a single-use, short-lived record that ONE exact decision (kind + subject + a digest of its
-- parameters) was confirmed by the named member with a WebAuthn assertion carrying user verification. It is minted
-- pending when a dashboard route refuses a session-only widening decision, satisfied on the dedicated secure host by
-- a passkey assertion whose challenge is bound to (grant id, parameter digest), and consumed once by the route that
-- performs the decision. The link token is stored only as a sha256. A session, a fresh sign-in or a bearer never
-- produces one. Additive: one new table, no existing row touched.
CREATE TABLE IF NOT EXISTS presence_grants (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  params_sha256 TEXT NOT NULL CHECK (
    length(params_sha256) = 64 AND params_sha256 = lower(params_sha256) AND params_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  summary TEXT NOT NULL,
  action_path TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  encoding TEXT NOT NULL CHECK (encoding IN ('form', 'json')),
  return_path TEXT NOT NULL,
  link_token_sha256 TEXT NOT NULL CHECK (
    length(link_token_sha256) = 64 AND link_token_sha256 = lower(link_token_sha256) AND link_token_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'satisfied', 'consumed', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  satisfied_at TEXT,
  satisfied_passkey_id TEXT,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_presence_grants_member
  ON presence_grants(tenant, member_id, status, expires_at);
