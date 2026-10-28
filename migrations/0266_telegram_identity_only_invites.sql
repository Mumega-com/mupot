-- Explicit identity-only pairing: NULL scope is never a grant wildcard.
-- Existing invites retain their grant semantics and original validation.
ALTER TABLE invites ADD COLUMN invite_kind TEXT NOT NULL DEFAULT 'grant'
  CHECK (invite_kind IN ('grant', 'identity_only'));

DROP TRIGGER IF EXISTS validate_invites_project_pairing_insert;
DROP TRIGGER IF EXISTS validate_invites_project_pairing_update;

CREATE TRIGGER validate_invites_project_pairing_insert
BEFORE INSERT ON invites
WHEN NEW.invite_kind IS NOT 'identity_only'
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
WHEN NEW.invite_kind IS NOT 'identity_only'
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

CREATE TRIGGER validate_identity_only_invite_insert
BEFORE INSERT ON invites
WHEN NEW.invite_kind = 'identity_only'
BEGIN
  SELECT RAISE(ABORT, 'invalid identity-only invite')
  WHERE COALESCE((NEW.project_id IS NULL AND NEW.squad_id IS NULL AND NEW.department_id IS NULL
    AND NEW.member_id IS NOT NULL AND length(trim(NEW.member_id)) > 0
    AND NEW.minted_by_member_id = NEW.member_id AND NEW.invited_by = NEW.member_id
    AND NEW.capability = 'observer'
    AND NEW.pairing_hash IS NOT NULL AND length(NEW.pairing_hash) = 64
    AND NEW.pairing_hash NOT GLOB '*[^0-9A-Fa-f]*'
    AND NEW.pairing_expires_at IS NOT NULL AND length(trim(NEW.pairing_expires_at)) > 0), 0) = 0;
END;

CREATE TRIGGER validate_identity_only_invite_update
BEFORE UPDATE ON invites
WHEN NEW.invite_kind = 'identity_only'
BEGIN
  SELECT RAISE(ABORT, 'invalid identity-only invite')
  WHERE COALESCE((NEW.project_id IS NULL AND NEW.squad_id IS NULL AND NEW.department_id IS NULL
    AND NEW.member_id IS NOT NULL AND length(trim(NEW.member_id)) > 0
    AND NEW.minted_by_member_id = NEW.member_id AND NEW.invited_by = NEW.member_id
    AND NEW.capability = 'observer'
    AND NEW.pairing_hash IS NOT NULL AND length(NEW.pairing_hash) = 64
    AND NEW.pairing_hash NOT GLOB '*[^0-9A-Fa-f]*'
    AND NEW.pairing_expires_at IS NOT NULL AND length(trim(NEW.pairing_expires_at)) > 0), 0) = 0;
END;

-- A pairing must never be converted into a grant or retargeted after mint.
CREATE TRIGGER invites_kind_immutable
BEFORE UPDATE OF invite_kind ON invites
WHEN NEW.invite_kind IS NOT OLD.invite_kind
BEGIN
  SELECT RAISE(ABORT, 'invite kind is immutable');
END;
CREATE TRIGGER identity_only_invite_target_immutable
BEFORE UPDATE ON invites
WHEN OLD.invite_kind = 'identity_only' AND (
  NEW.member_id IS NOT OLD.member_id OR NEW.minted_by_member_id IS NOT OLD.minted_by_member_id
  OR NEW.invited_by IS NOT OLD.invited_by OR NEW.email IS NOT OLD.email
  OR NEW.pairing_hash IS NOT OLD.pairing_hash
  -- Revocation may shorten expiry, never extend it or remove it.
  OR NEW.pairing_expires_at IS NULL OR NEW.pairing_expires_at > OLD.pairing_expires_at
)
BEGIN
  SELECT RAISE(ABORT, 'identity-only invite target is immutable');
END;
