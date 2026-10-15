-- 0223_squad_join_requests.sql — an agent ASKS to join a squad; a human admin of THAT squad taps once (passkey).
--
-- WHY. A human wants an agent in a squad, but there was no door between them: the agent could only say "an admin on
-- that squad can add me by agent id". squad_member_add needs an admin's own session and the agent cannot see other
-- squads, let alone ask. This table is the ask. It stands for one pending request; the decision runs on a secure
-- moment (kind 'squad_join', passkey-class proof, src/secure-moments/routes.ts) and, on approve, performs the SAME
-- write squad_member_add performs (addSquadMember: memberships + capability row + membership_receipts), never above
-- member and never a gate capability.
--
-- squad_id is NULL when the ref the agent typed did not resolve at request time: the request row, the link and the
-- tool reply are deliberately identical either way (no existence oracle for squads the caller cannot see). The human's
-- approval page shows what the ref really resolved to; an unresolved request can only be denied.
-- squad_key is the dedupe key: the resolved squad id, else 'ref:' || lower(ref). One pending request per (agent, key).
-- Identity columns never change; a closed request never reopens. status moves pending -> approving (the approver CLAIMS the row
-- with one guarded UPDATE before any grant) -> approved|failed; or pending -> denied|expired|superseded.
CREATE TABLE IF NOT EXISTS squad_join_requests (
  id                    TEXT PRIMARY KEY,
  tenant                TEXT NOT NULL,
  agent_id              TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  squad_ref             TEXT NOT NULL CHECK (length(squad_ref) BETWEEN 1 AND 128),
  squad_id              TEXT,
  squad_key             TEXT NOT NULL,
  capability            TEXT NOT NULL CHECK (capability IN ('member', 'observer')),
  reason                TEXT CHECK (reason IS NULL OR length(reason) <= 500),
  requested_via         TEXT NOT NULL CHECK (requested_via IN ('agent', 'attached_chat')),
  status                TEXT NOT NULL CHECK (status IN ('pending', 'approving', 'approved', 'denied', 'expired', 'superseded', 'failed')),
  created_at            TEXT NOT NULL,
  expires_at            TEXT NOT NULL,
  decided_at            TEXT,
  decided_by_member_id  TEXT,
  decided_via           TEXT CHECK (decided_via IS NULL OR decided_via IN ('webauthn')),
  result                TEXT CHECK (result IS NULL OR result IN ('created', 'updated', 'unchanged')),
  decision_error        TEXT
);

-- One pending request per (agent, squad): a repeat ask reuses it (or supersedes it when what was asked changed).
CREATE UNIQUE INDEX IF NOT EXISTS uq_squad_join_requests_pending
  ON squad_join_requests(tenant, agent_id, squad_key)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_squad_join_requests_agent
  ON squad_join_requests(tenant, agent_id, status);

CREATE TRIGGER IF NOT EXISTS squad_join_requests_immutable
BEFORE UPDATE ON squad_join_requests
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id OR NEW.tenant IS NOT OLD.tenant OR NEW.agent_id IS NOT OLD.agent_id
  OR NEW.squad_ref IS NOT OLD.squad_ref OR NEW.squad_id IS NOT OLD.squad_id OR NEW.squad_key IS NOT OLD.squad_key
  OR NEW.capability IS NOT OLD.capability OR NEW.reason IS NOT OLD.reason OR NEW.requested_via IS NOT OLD.requested_via
  OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
  OR OLD.status NOT IN ('pending', 'approving')
  OR (OLD.status = 'approving' AND NEW.status NOT IN ('approving', 'approved', 'failed'))
BEGIN
  SELECT RAISE(ABORT, 'squad_join_request_immutable');
END;

CREATE TRIGGER IF NOT EXISTS squad_join_requests_no_delete
BEFORE DELETE ON squad_join_requests
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'squad_join_request_immutable');
END;

-- Per-agent request flood cap: one counter row per (agent, hour bucket), bumped by an atomic guarded UPSERT.
CREATE TABLE IF NOT EXISTS squad_join_rate_limits (
  tenant    TEXT NOT NULL,
  agent_id  TEXT NOT NULL,
  bucket    TEXT NOT NULL,
  count     INTEGER NOT NULL,
  PRIMARY KEY (tenant, agent_id, bucket)
);

-- secure_moments gains kind 'squad_join'. SQLite cannot alter a CHECK, so the table is rebuilt exactly as 0220 did
-- (same columns/constraints, one more kind; rows and both indexes preserved). Nothing references secure_moments by
-- foreign key, trigger or view.
CREATE TABLE secure_moments_new (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('seed_attach', 'elevation', 'credential', 'seat_admit', 'squad_join')),
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
