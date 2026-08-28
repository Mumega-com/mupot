-- 0137_native_2fa_and_action_approvals.sql — Native In-Pot 2FA & Action Approvals (FLIGHT-004 / mumega-com#725).
--
-- Deliverables:
-- 1. approval_challenges table:
--    Durable store for server-generated, single-use, action-hash-bound 2FA/approval challenges.
--    Binds {challenge_id, tenant, action_type, action_payload_hash, approver_member_id, nonce_hash, expires_at, status}.
--
-- 2. approval_receipts table:
--    Cryptographically verifiable audit receipts for approved high-impact actions.
--    Records {receipt_id, challenge_id, tenant, action_type, action_payload_hash, approved_by_member_id, verification_method, signature, approved_at}.

-- ── 1. Approval Challenges (Native Pot 2FA / Approvals) ──────────────────────

CREATE TABLE IF NOT EXISTS approval_challenges (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_payload_hash TEXT NOT NULL,
  target_id TEXT,
  requester_id TEXT NOT NULL,
  approver_member_id TEXT,
  nonce_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'consumed')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_approval_challenges_tenant_status
  ON approval_challenges(tenant, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_approval_challenges_action_hash
  ON approval_challenges(tenant, action_payload_hash, status);

CREATE INDEX IF NOT EXISTS idx_approval_challenges_nonce
  ON approval_challenges(tenant, nonce_hash);

-- ── 2. Approval Receipts ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS approval_receipts (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  tenant TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_payload_hash TEXT NOT NULL,
  approved_by_member_id TEXT NOT NULL,
  verification_method TEXT NOT NULL, -- e.g. 'ed25519_signature' | 'totp_2fa' | 'direct_operator_nonce' | 'passkey'
  signature TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (challenge_id) REFERENCES approval_challenges(id)
);

CREATE INDEX IF NOT EXISTS idx_approval_receipts_tenant_action
  ON approval_receipts(tenant, action_type, created_at);

CREATE INDEX IF NOT EXISTS idx_approval_receipts_challenge
  ON approval_receipts(tenant, challenge_id);
