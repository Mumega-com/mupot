-- 0220_agent_seat_admissions.sql — mupot W2 (harness seats -> existing named agents), behind SEAT_ATTACH (default off).
--
-- WHY. An OAuth harness grant (ChatGPT, claude.ai, Grok, Cursor) is ONE consent, but a human runs many threads through
-- it and wants some of them to act AS an agent that already exists (Rava, hadi-admin ...), not as a throwaway
-- per-thread seat agent. Binding the whole grant to one agent collapses every chat into that agent; this table pair
-- lets a THREAD (an agent_seats row, auto or select) attach to an existing agent instead.
--
-- agent_seat_admissions: the human's explicit, per (agent, human, harness) permission. Admission happens once; later
--   threads of the same human on the same harness attach immediately. 'pending' is created by the MCP seat_attach tool
--   and decided by the human on a secure moment (kind 'seat_admit', passkey) or on the dashboard Connections page;
--   'live' is the only state that authorises anything. Revoke is a timestamp (append-only history, no delete).
--   `gates` is fixed at 0: an attached seat never inherits the agent's gate authority (design 4.3, "gate authority off
--   by default"); the column exists so a later, separately reviewed wave can widen it without a migration.
-- agent_seat_attachments: one thread (seat) acting as one admitted agent. At most ONE live attachment per seat. It
--   carries its own server-held directory token for the agent's welded member (raw secret discarded, like seat
--   tokens), so agent sessions / revocation sweeps see a normal credential per thread. A live attachment PINS its seat:
--   the auto-pool reclaim never picks it as a victim (src/members/seat-select.ts prepareAutoSeatReclaim).
CREATE TABLE IF NOT EXISTS agent_seat_admissions (
  id                    TEXT PRIMARY KEY,
  tenant                TEXT NOT NULL,
  agent_id              TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  human_member_id       TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  harness_id            TEXT NOT NULL REFERENCES harnesses(id) ON DELETE RESTRICT,
  status                TEXT NOT NULL CHECK (status IN ('pending', 'live', 'denied', 'revoked', 'expired')),
  gates                 INTEGER NOT NULL DEFAULT 0 CHECK (gates = 0),
  -- The CEILING the human chose at the passkey tap (or in a fresh dashboard session): the most a thread attached
  -- through this admission may hold on any scope the AGENT holds. member (default) | lead | full (the agent's own
  -- standing). It is always also capped by the human's own live standing, and gates are never included at any ceiling.
  -- Immutable: changing it takes a new admission (revoke + a new tap).
  ceiling               TEXT NOT NULL DEFAULT 'member' CHECK (ceiling IN ('member', 'lead', 'full')),
  requested_via         TEXT NOT NULL CHECK (requested_via IN ('tool', 'dashboard')),
  requested_seat_id     TEXT,
  created_at            TEXT NOT NULL,
  expires_at            TEXT,
  decided_at            TEXT,
  decided_by_member_id  TEXT,
  decided_via           TEXT CHECK (decided_via IS NULL OR decided_via IN ('webauthn', 'dashboard')),
  revoked_at            TEXT,
  revoked_by_member_id  TEXT
);

-- Idempotent: a retry or a concurrent second request for the same (agent, human, harness) lands on the same live row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_seat_admissions_open
  ON agent_seat_admissions(tenant, agent_id, human_member_id, harness_id)
  WHERE status IN ('pending', 'live');
CREATE INDEX IF NOT EXISTS idx_agent_seat_admissions_human
  ON agent_seat_admissions(tenant, human_member_id, status);

-- Identity columns never change; a closed admission never reopens; only pending/live may change state.
CREATE TRIGGER IF NOT EXISTS agent_seat_admissions_immutable
BEFORE UPDATE ON agent_seat_admissions
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id OR NEW.tenant IS NOT OLD.tenant OR NEW.agent_id IS NOT OLD.agent_id
  OR NEW.human_member_id IS NOT OLD.human_member_id OR NEW.harness_id IS NOT OLD.harness_id
  OR NEW.created_at IS NOT OLD.created_at OR NEW.requested_via IS NOT OLD.requested_via
  OR NEW.gates IS NOT OLD.gates
  OR (NEW.ceiling IS NOT OLD.ceiling AND OLD.status <> 'pending') -- the human picks it at the decision (pending -> live) and never after
  OR OLD.status IN ('denied', 'revoked', 'expired')
  OR (OLD.status = 'live' AND NEW.status NOT IN ('live', 'revoked'))
BEGIN
  SELECT RAISE(ABORT, 'agent_seat_admission_immutable');
END;

CREATE TRIGGER IF NOT EXISTS agent_seat_admissions_no_delete
BEFORE DELETE ON agent_seat_admissions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'agent_seat_admission_immutable');
END;

CREATE TABLE IF NOT EXISTS agent_seat_attachments (
  id                    TEXT PRIMARY KEY,
  tenant                TEXT NOT NULL,
  seat_id               TEXT NOT NULL REFERENCES agent_seats(id) ON DELETE RESTRICT,
  human_member_id       TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  harness_id            TEXT NOT NULL REFERENCES harnesses(id) ON DELETE RESTRICT,
  agent_id              TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  admission_id          TEXT NOT NULL REFERENCES agent_seat_admissions(id) ON DELETE RESTRICT,
  -- The server-held directory token of THIS attachment (the agent's welded member). Plain TEXT, no FK: the token row
  -- is inserted in the same batch, conditioned on this row existing. Raw secret discarded at creation.
  seat_token_id         TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  last_used_at          TEXT,
  detached_at           TEXT,
  detached_by_member_id TEXT,
  detach_reason         TEXT CHECK (detach_reason IS NULL OR detach_reason IN ('human', 'admission_revoked', 'moved', 'idle_expired'))
);

-- One live attachment per seat (a thread acts as exactly one agent at a time).
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_seat_attachments_live_seat
  ON agent_seat_attachments(tenant, seat_id)
  WHERE detached_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_agent_seat_attachments_admission
  ON agent_seat_attachments(admission_id, detached_at);
CREATE INDEX IF NOT EXISTS idx_agent_seat_attachments_human
  ON agent_seat_attachments(tenant, human_member_id, detached_at);

CREATE TRIGGER IF NOT EXISTS agent_seat_attachments_immutable
BEFORE UPDATE ON agent_seat_attachments
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id OR NEW.tenant IS NOT OLD.tenant OR NEW.seat_id IS NOT OLD.seat_id
  OR NEW.human_member_id IS NOT OLD.human_member_id OR NEW.harness_id IS NOT OLD.harness_id
  OR NEW.agent_id IS NOT OLD.agent_id OR NEW.admission_id IS NOT OLD.admission_id
  OR NEW.seat_token_id IS NOT OLD.seat_token_id OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.detached_at IS NOT NULL AND (NEW.detached_at IS NOT OLD.detached_at OR NEW.detach_reason IS NOT OLD.detach_reason
                                      OR NEW.detached_by_member_id IS NOT OLD.detached_by_member_id))
BEGIN
  SELECT RAISE(ABORT, 'agent_seat_attachment_immutable');
END;

CREATE TRIGGER IF NOT EXISTS agent_seat_attachments_no_delete
BEFORE DELETE ON agent_seat_attachments
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'agent_seat_attachment_immutable');
END;

-- Detaching ends the thread's credential: the attachment's server-held token is revoked in the same statement.
CREATE TRIGGER IF NOT EXISTS agent_seat_attachments_revoke_token
AFTER UPDATE OF detached_at ON agent_seat_attachments
FOR EACH ROW
WHEN OLD.detached_at IS NULL AND NEW.detached_at IS NOT NULL
BEGIN
  UPDATE member_tokens SET revoked_at = NEW.detached_at WHERE id = NEW.seat_token_id AND revoked_at IS NULL;
END;

-- Revoking an admission detaches every live attachment derived from it, atomically with the revoke (the per-request
-- resolver also requires a LIVE admission, so this is the tidy-up, not the guard).
CREATE TRIGGER IF NOT EXISTS agent_seat_admissions_revoke_attachments
AFTER UPDATE OF status ON agent_seat_admissions
FOR EACH ROW
WHEN OLD.status = 'live' AND NEW.status = 'revoked'
BEGIN
  UPDATE agent_seat_attachments
     SET detached_at = COALESCE(NEW.revoked_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
         detach_reason = 'admission_revoked',
         detached_by_member_id = NEW.revoked_by_member_id
   WHERE admission_id = NEW.id AND detached_at IS NULL;
END;

-- A human's own name for a thread (label only: it never selects or authorises anything). agent_seats is immutable, so the
-- label lives here.
CREATE TABLE IF NOT EXISTS agent_seat_thread_labels (
  tenant          TEXT NOT NULL,
  seat_id         TEXT NOT NULL REFERENCES agent_seats(id) ON DELETE RESTRICT,
  human_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  label           TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (tenant, seat_id)
);

-- secure_moments gains kind 'seat_admit' (the human's passkey tap that admits a thread to an agent). SQLite cannot
-- alter a CHECK, so the table is rebuilt exactly as 0213 did (same columns/constraints, one more kind; rows and both
-- indexes preserved). Nothing references secure_moments by foreign key, trigger or view.
CREATE TABLE secure_moments_new (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('seed_attach', 'elevation', 'credential', 'seat_admit')),
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
