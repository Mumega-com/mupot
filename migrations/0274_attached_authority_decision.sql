-- 0274: per-attachment Helper/Full authority decision + absolute expiry (mupot#980005ac stage 1).
-- ADDITIVE ONLY: no DROP, no rebuild of agent_seat_admissions / attachments. Safe to apply before deploy.
--
-- authority_level: the confirming human's deliberate choice at Connect time.
--   'helper' = today's attached ceiling (read/draft within existing visibility). Default for every
--             legacy live row and every new decision that does not explicitly pick Full.
--   'full'   = recorded and expiry-bound in stage 1, but MUST NOT widen any capability beyond
--             helper (see src/auth/attached-ceiling.ts). The action table that widens Full lands
--             in a separately gated PR.
-- authority_expires_at: absolute UTC. NULL means "no authority expiry" — ONLY for rows that
--   already existed before this migration (grandfather: keep working exactly as today, treated
--   as Helper). Every NEW decision writes a non-NULL absolute expiry (default 7 days, never longer).
--
-- agent_seat_authority_decisions: append-only provenance ledger. A later Connect that replaces
--   an admission is a NEW row; never reinterpret an old Helper row as Full.

ALTER TABLE agent_seat_admissions ADD COLUMN authority_level TEXT NOT NULL DEFAULT 'helper'
  CHECK (authority_level IN ('helper', 'full'));

ALTER TABLE agent_seat_admissions ADD COLUMN authority_expires_at TEXT;

-- After the admission is live, the human's Helper/Full choice and its absolute expiry never change
-- in place. Changing them requires revoke + a new decision (a new admission row).
CREATE TRIGGER IF NOT EXISTS agent_seat_admissions_authority_immutable
BEFORE UPDATE OF authority_level, authority_expires_at ON agent_seat_admissions
FOR EACH ROW
WHEN (NEW.authority_level IS NOT OLD.authority_level OR
      (NEW.authority_expires_at IS NOT OLD.authority_expires_at
       AND (NEW.authority_expires_at IS NOT NULL OR OLD.authority_expires_at IS NOT NULL)))
  AND OLD.status <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'agent_seat_admission_authority_immutable');
END;

CREATE TABLE IF NOT EXISTS agent_seat_authority_decisions (
  id                      TEXT PRIMARY KEY,
  tenant                  TEXT NOT NULL,
  admission_id            TEXT NOT NULL REFERENCES agent_seat_admissions(id) ON DELETE RESTRICT,
  attachment_id           TEXT,
  seat_id                 TEXT,
  agent_id                TEXT NOT NULL,
  harness_id              TEXT NOT NULL,
  -- Display / audit only. Never an authority input. project_id is NULL until a verified project
  -- binding exists on the admission; machine_key records the harness/seat identity the human saw.
  project_id              TEXT,
  machine_key             TEXT,
  decided_by_member_id    TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  authority_level         TEXT NOT NULL CHECK (authority_level IN ('helper', 'full')),
  authority_expires_at    TEXT NOT NULL,
  decided_at              TEXT NOT NULL,
  decided_via             TEXT NOT NULL CHECK (decided_via IN ('webauthn', 'dashboard')),
  replaces_decision_id    TEXT REFERENCES agent_seat_authority_decisions(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_agent_seat_authority_decisions_admission
  ON agent_seat_authority_decisions(tenant, admission_id, decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_seat_authority_decisions_member
  ON agent_seat_authority_decisions(tenant, decided_by_member_id, decided_at DESC);

CREATE TRIGGER IF NOT EXISTS agent_seat_authority_decisions_no_update
BEFORE UPDATE ON agent_seat_authority_decisions
BEGIN
  SELECT RAISE(ABORT, 'agent_seat_authority_decisions is append-only: UPDATE is forbidden');
END;

CREATE TRIGGER IF NOT EXISTS agent_seat_authority_decisions_no_delete
BEFORE DELETE ON agent_seat_authority_decisions
BEGIN
  SELECT RAISE(ABORT, 'agent_seat_authority_decisions is append-only: DELETE is forbidden');
END;
