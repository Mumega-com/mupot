-- 0138_governance_consensus_and_ratification.sql — Governance Wiring & Constitutional Protocols (FLIGHT-005 / mumega-com#723).
--
-- Deliverables:
-- 1. governance_proposals table:
--    Durable store for constitutional resolutions and council governance proposals.
--    Tracks {id, tenant, proposal_type, title, description, target_document_path, target_document_hash, proposer_id, status, threshold_council_count, founder_seal_required, created_at, closed_at}.
--
-- 2. governance_votes table:
--    Immutable vote ledger ensuring one vote per council seat per resolution ID (Terminal State Guard).
--    Tracks {id, resolution_id, tenant, voter_id, voter_type, voter_seat, vote, reason, created_at}.
--
-- 3. ratified_amendments table:
--    Ratified constitutional amendments bound by cryptographic SHA-256 hash and council + founder signatures.
--    Tracks {id, resolution_id, tenant, document_path, document_hash, council_signers_json, founder_seal, ratified_at}.

-- ── 1. Governance Proposals ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS governance_proposals (
  id TEXT PRIMARY KEY, -- resolution_id (UUID or slug)
  tenant TEXT NOT NULL,
  proposal_type TEXT NOT NULL, -- e.g. 'constitutional_amendment' | 'policy_change' | 'architectural_decision'
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  target_document_path TEXT,
  target_document_hash TEXT NOT NULL, -- SHA-256 hash of target document
  proposer_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'ratified', 'rejected', 'withdrawn', 'expired')),
  threshold_council_count INTEGER NOT NULL DEFAULT 2,
  founder_seal_required INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_governance_proposals_tenant_status
  ON governance_proposals(tenant, status, created_at);

CREATE INDEX IF NOT EXISTS idx_governance_proposals_hash
  ON governance_proposals(tenant, target_document_hash);

-- ── 2. Governance Votes (Single-Vote Terminal Guard) ──────────────────────────

CREATE TABLE IF NOT EXISTS governance_votes (
  id TEXT PRIMARY KEY,
  resolution_id TEXT NOT NULL,
  tenant TEXT NOT NULL,
  voter_id TEXT NOT NULL, -- agent or member id
  voter_type TEXT NOT NULL CHECK (voter_type IN ('council_agent', 'founder', 'operator')),
  voter_seat TEXT NOT NULL, -- 'river' | 'athena' | 'kasra' | 'loom' | 'kayhermes' | custom
  vote TEXT NOT NULL CHECK (vote IN ('approve', 'reject', 'abstain')),
  reason TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (resolution_id) REFERENCES governance_proposals(id),
  UNIQUE(tenant, resolution_id, voter_id) -- One vote per resolution per voter
);

CREATE INDEX IF NOT EXISTS idx_governance_votes_resolution
  ON governance_votes(tenant, resolution_id);

CREATE INDEX IF NOT EXISTS idx_governance_votes_voter
  ON governance_votes(tenant, voter_id);

-- ── 3. Ratified Amendments ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ratified_amendments (
  id TEXT PRIMARY KEY,
  resolution_id TEXT NOT NULL UNIQUE,
  tenant TEXT NOT NULL,
  document_path TEXT NOT NULL,
  document_hash TEXT NOT NULL,
  council_signers_json TEXT NOT NULL, -- JSON array of council voter IDs
  founder_seal INTEGER NOT NULL DEFAULT 1, -- 1 when founder sealed
  ratified_at TEXT NOT NULL,
  FOREIGN KEY (resolution_id) REFERENCES governance_proposals(id)
);

CREATE INDEX IF NOT EXISTS idx_ratified_amendments_tenant
  ON ratified_amendments(tenant, document_hash);
