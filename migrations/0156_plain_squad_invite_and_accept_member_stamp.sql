-- 0156_plain_squad_invite_and_accept_member_stamp.sql — mupot#1436 A2+A3
--
-- Two additive relaxations of 0154's invite trigger pair:
--
-- 1. PLAIN SQUAD WEB INVITES (A3). 0152/0154 required project_id, squad_id,
--    pairing_hash, and pairing_expires_at to be jointly null or jointly set.
--    That made every squad-bearing invite a Telegram/project invite. A3 adds
--    a third legal shape: squad_id set, project_id/pairing_hash/
--    pairing_expires_at NULL. pairing_hash or pairing_expires_at still marks
--    the Telegram door (accept stays 409).
--
-- 2. ACCEPT-TIME MEMBER STAMP (A2). 0154 refused member_id on any row that
--    was not a full project/pairing invite, so a legacy (or plain-squad)
--    accept could not record which member it minted. A2's callback treats
--    D1 as the authority and must read that member id from the invite row,
--    never from the KV pointer. INSERT of a member_id still requires the
--    full Telegram/project field set (bind-invite mint unchanged). UPDATE
--    may stamp member_id when pairing_hash and pairing_expires_at stay NULL.
--
-- Existing rows are unchanged. Triggers are dropped and recreated (same
-- pattern as 0154). No UNION ALL, no backfill.

DROP TRIGGER IF EXISTS validate_invites_project_pairing_insert;
DROP TRIGGER IF EXISTS validate_invites_project_pairing_update;

CREATE TRIGGER validate_invites_project_pairing_insert
BEFORE INSERT ON invites
BEGIN
  SELECT RAISE(ABORT, 'project invite fields must be jointly null, plain-squad, or full project/pairing')
  WHERE NOT (
    (
      NEW.project_id IS NULL
      AND NEW.squad_id IS NULL
      AND NEW.pairing_hash IS NULL
      AND NEW.pairing_expires_at IS NULL
    )
    OR
    (
      NEW.project_id IS NULL
      AND NEW.squad_id IS NOT NULL
      AND NEW.pairing_hash IS NULL
      AND NEW.pairing_expires_at IS NULL
      AND length(trim(NEW.squad_id)) > 0
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
  SELECT RAISE(ABORT, 'project invite fields must be jointly null, plain-squad, or full project/pairing')
  WHERE NOT (
    (
      NEW.project_id IS NULL
      AND NEW.squad_id IS NULL
      AND NEW.pairing_hash IS NULL
      AND NEW.pairing_expires_at IS NULL
    )
    OR
    (
      NEW.project_id IS NULL
      AND NEW.squad_id IS NOT NULL
      AND NEW.pairing_hash IS NULL
      AND NEW.pairing_expires_at IS NULL
      AND length(trim(NEW.squad_id)) > 0
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
  -- INSERT-time bind invites still require the full project field set.
  -- Accept-time stamp (A2): member_id may land on a legacy or plain-squad
  -- row whose pairing columns stay NULL. Stamping member_id while any
  -- pairing column is set is refused even on an otherwise-legal Telegram
  -- row (P1-B) — bind invites write member_id on INSERT, not UPDATE.
  SELECT RAISE(ABORT, 'project invite member bind requires the full project field set')
  WHERE NEW.member_id IS NOT NULL
    AND (NEW.pairing_hash IS NOT NULL OR NEW.pairing_expires_at IS NOT NULL)
    AND (OLD.member_id IS NULL OR OLD.member_id <> NEW.member_id);
  -- member_id is write-once. Rollback may NULL it; a different member
  -- must not overwrite a stamp that already landed.
  SELECT RAISE(ABORT, 'invite member_id is write-once')
  WHERE OLD.member_id IS NOT NULL
    AND NEW.member_id IS NOT NULL
    AND OLD.member_id <> NEW.member_id;
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
