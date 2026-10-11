-- 0211_seed_attach_requests.sql — pending, single-use, expiring request to apply a mupot.seed/v1,
-- created by an agent (MCP seed_attach_request) and decided ONLY by a human on the Access-protected
-- approve page (docs/architecture/access-approve-page.md). Additive.
--
-- Stores the CANONICAL seed form + its digest + the keyed request list (what the human is shown), never
-- the raw source. Approval re-validates canonical_json and refuses unless the digest and every request
-- key still match, then applies through the existing applySeed. The request is consumed by ONE guarded
-- UPDATE ... WHERE status = 'pending' AND expires_at > now (replay and cross-tab safe).
-- status: pending -> applying -> applied | failed ; pending -> denied ; pending -> expired (written lazily
-- when the same requester files the same seed again; a pending row past expiry is never claimable either way).
-- At most ONE pending row per (tenant, requester, seed digest): a partial UNIQUE index, so two concurrent
-- filings of the same seed collapse to one request instead of racing past a read-then-insert check.
CREATE TABLE IF NOT EXISTS seed_attach_requests (
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
  decided_via TEXT CHECK (decided_via IS NULL OR decided_via IN ('access_passkey')),
  decision_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_seed_attach_requests_requester
  ON seed_attach_requests(tenant, requester_member_id, status, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_seed_attach_requests_pending_identity
  ON seed_attach_requests(tenant, requester_member_id, seed_sha256)
  WHERE status = 'pending';
