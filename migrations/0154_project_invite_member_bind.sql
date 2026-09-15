-- 0154_project_invite_member_bind.sql — bind a Telegram identity to an EXISTING
-- member via a project invite, instead of always minting a net-new member.
--
-- Additive, D1-safe: two nullable columns plus an extension of 0152's own
-- joint-null trigger set (dropped and recreated, not a second copy of it) so a
-- member_id invite still requires the full project field group (project_id,
-- squad_id, pairing_hash, pairing_expires_at) — this is a project invite
-- concept, never a legacy email invite. No UNION ALL, no backfill of existing
-- rows (member_id and telegram_bound_at default NULL, matching every existing
-- row unchanged).
--
-- members.telegram_bound_at: stamped ONLY by bindMemberStatement
-- (src/members/project-invites.ts), with the claim's own unique-per-attempt
-- timestamp, when a bind-existing-member invite's Telegram UPDATE actually
-- lands — the bind-landed PROOF gating the capability grant and receipt
-- completion, as opposed to a state test on telegram_chat_id (which a
-- pre-existing, unrelated identity match could satisfy without this claim's
-- own write ever having happened). Left NULL for members minted net-new
-- (their telegram_chat_id is set at INSERT time, a different concept).

ALTER TABLE invites ADD COLUMN member_id TEXT REFERENCES members(id);
ALTER TABLE members ADD COLUMN telegram_bound_at TEXT;

DROP TRIGGER IF EXISTS validate_invites_project_pairing_insert;
DROP TRIGGER IF EXISTS validate_invites_project_pairing_update;

CREATE TRIGGER validate_invites_project_pairing_insert
BEFORE INSERT ON invites
BEGIN
  SELECT RAISE(ABORT, 'project invite fields must be jointly null or nonblank')
  WHERE NOT (
    (
      NEW.project_id IS NULL
      AND NEW.squad_id IS NULL
      AND NEW.pairing_hash IS NULL
      AND NEW.pairing_expires_at IS NULL
    )
    OR
    (
      NEW.project_id IS NOT NULL
      AND NEW.squad_id IS NOT NULL
      AND NEW.pairing_hash IS NOT NULL
      AND NEW.pairing_expires_at IS NOT NULL
      AND length(trim(NEW.project_id)) > 0
      AND length(trim(NEW.squad_id)) > 0
      AND length(trim(NEW.pairing_hash)) > 0
      AND length(trim(NEW.pairing_expires_at)) > 0
    )
  );
  SELECT RAISE(ABORT, 'project invite member bind requires the full project field set')
  WHERE NEW.member_id IS NOT NULL
    AND NOT (
      NEW.project_id IS NOT NULL
      AND NEW.squad_id IS NOT NULL
      AND NEW.pairing_hash IS NOT NULL
      AND NEW.pairing_expires_at IS NOT NULL
      AND length(trim(NEW.project_id)) > 0
      AND length(trim(NEW.squad_id)) > 0
      AND length(trim(NEW.pairing_hash)) > 0
      AND length(trim(NEW.pairing_expires_at)) > 0
    );
  -- mupot#1411 P3 (kasra-review, 2026-09-15): member_id is a bare TEXT column
  -- with no CHECK of its own (unlike pairing_hash's hex-length check below) —
  -- a whitespace-only value would pass every conjunct above (NOT NULL) yet
  -- resolve to no real member anywhere. Refuse it at the trigger, the same
  -- layer that already refuses whitespace-only project fields.
  SELECT RAISE(ABORT, 'project invite member bind requires a non-blank member_id')
  WHERE NEW.member_id IS NOT NULL AND length(trim(NEW.member_id)) = 0;
  SELECT RAISE(ABORT, 'project invite pairing hash must be 64 hex characters')
  WHERE NEW.pairing_hash IS NOT NULL
    AND (
      length(NEW.pairing_hash) <> 64
      OR NEW.pairing_hash GLOB '*[^0-9A-Fa-f]*'
    );
  SELECT RAISE(ABORT, 'project invite project-squad mismatch')
  WHERE NEW.project_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM project_squad_access
      WHERE project_id = NEW.project_id
        AND squad_id = NEW.squad_id
    );
END;

CREATE TRIGGER validate_invites_project_pairing_update
BEFORE UPDATE OF project_id, squad_id, pairing_hash, pairing_expires_at, member_id ON invites
BEGIN
  SELECT RAISE(ABORT, 'project invite fields must be jointly null or nonblank')
  WHERE NOT (
    (
      NEW.project_id IS NULL
      AND NEW.squad_id IS NULL
      AND NEW.pairing_hash IS NULL
      AND NEW.pairing_expires_at IS NULL
    )
    OR
    (
      NEW.project_id IS NOT NULL
      AND NEW.squad_id IS NOT NULL
      AND NEW.pairing_hash IS NOT NULL
      AND NEW.pairing_expires_at IS NOT NULL
      AND length(trim(NEW.project_id)) > 0
      AND length(trim(NEW.squad_id)) > 0
      AND length(trim(NEW.pairing_hash)) > 0
      AND length(trim(NEW.pairing_expires_at)) > 0
    )
  );
  SELECT RAISE(ABORT, 'project invite member bind requires the full project field set')
  WHERE NEW.member_id IS NOT NULL
    AND NOT (
      NEW.project_id IS NOT NULL
      AND NEW.squad_id IS NOT NULL
      AND NEW.pairing_hash IS NOT NULL
      AND NEW.pairing_expires_at IS NOT NULL
      AND length(trim(NEW.project_id)) > 0
      AND length(trim(NEW.squad_id)) > 0
      AND length(trim(NEW.pairing_hash)) > 0
      AND length(trim(NEW.pairing_expires_at)) > 0
    );
  -- mupot#1411 P3 (kasra-review, 2026-09-15): member_id is a bare TEXT column
  -- with no CHECK of its own (unlike pairing_hash's hex-length check below) —
  -- a whitespace-only value would pass every conjunct above (NOT NULL) yet
  -- resolve to no real member anywhere. Refuse it at the trigger, the same
  -- layer that already refuses whitespace-only project fields.
  SELECT RAISE(ABORT, 'project invite member bind requires a non-blank member_id')
  WHERE NEW.member_id IS NOT NULL AND length(trim(NEW.member_id)) = 0;
  SELECT RAISE(ABORT, 'project invite pairing hash must be 64 hex characters')
  WHERE NEW.pairing_hash IS NOT NULL
    AND (
      length(NEW.pairing_hash) <> 64
      OR NEW.pairing_hash GLOB '*[^0-9A-Fa-f]*'
    );
  SELECT RAISE(ABORT, 'project invite project-squad mismatch')
  WHERE NEW.project_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM project_squad_access
      WHERE project_id = NEW.project_id
        AND squad_id = NEW.squad_id
    );
END;

-- mupot#1411 P2-B/C round 4 (kasra-review, 2026-09-15): DELETE
-- /members/:id/telegram had NO audit trail at all -- the only write was the
-- UPDATE clearing telegram_chat_id itself. Once a Telegram bind is a
-- credential mint (same authority as POST /members/:id/tokens, see the
-- route's own comment in src/members/index.ts), clearing it is a credential
-- REVOCATION and deserves the same kind of durable trail this codebase
-- already keeps for other identity-affecting admin actions -- append-only,
-- one small table per action class (oauth_consent_receipts 0091,
-- gate_owner_reassignments 0113, verdict_reversals 0118, this table
-- following the same shape). prior_telegram_chat_id is retained so a later
-- audit can tell WHICH identity was detached, not merely that something was.
CREATE TABLE IF NOT EXISTS telegram_unbind_receipts (
  id                      TEXT PRIMARY KEY,
  tenant                  TEXT NOT NULL,
  member_id               TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  actor_id                TEXT NOT NULL,
  prior_telegram_chat_id  TEXT NOT NULL,
  created_at              TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telegram_unbind_receipts_member
  ON telegram_unbind_receipts(tenant, member_id, created_at DESC);

-- mupot#1411 P1 round 5 (kasra-review adversarial addendum, 2026-09-15): this
-- table's own comment above claimed "append-only" citing 0091's
-- oauth_consent_receipts precedent, but never actually carried 0091's
-- no-update/no-delete trigger pair -- an UPDATE forging actor_id, or an
-- outright DELETE, both silently succeeded. Since this migration has not
-- shipped anywhere yet (still unmerged branch #1411), the pair is added
-- directly here rather than a follow-up migration.
CREATE TRIGGER telegram_unbind_receipts_no_update
BEFORE UPDATE ON telegram_unbind_receipts
BEGIN
  SELECT RAISE(ABORT, 'telegram_unbind_receipts is append-only: UPDATE is forbidden');
END;

CREATE TRIGGER telegram_unbind_receipts_no_delete
BEFORE DELETE ON telegram_unbind_receipts
BEGIN
  SELECT RAISE(ABORT, 'telegram_unbind_receipts is append-only: DELETE is forbidden');
END;
