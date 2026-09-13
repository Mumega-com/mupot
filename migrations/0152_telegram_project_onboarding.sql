-- 0152_telegram_project_onboarding.sql — durable Telegram project onboarding.
--
-- Project-scoped invites carry only a SHA-256 pairing digest; the raw pairing
-- secret never enters D1. The four project fields form one atomic optional set
-- so legacy email invites remain valid without allowing partial project binds.

ALTER TABLE invites ADD COLUMN project_id TEXT REFERENCES projects(id);
ALTER TABLE invites ADD COLUMN squad_id TEXT REFERENCES squads(id);
ALTER TABLE invites ADD COLUMN pairing_hash TEXT;
ALTER TABLE invites ADD COLUMN pairing_expires_at TEXT;

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
BEFORE UPDATE OF project_id, squad_id, pairing_hash, pairing_expires_at ON invites
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

CREATE TABLE telegram_webhook_receipts (
  tenant         TEXT NOT NULL,
  update_id      TEXT NOT NULL,
  request_digest TEXT NOT NULL
                 CHECK (
                   length(request_digest) = 64
                   AND request_digest NOT GLOB '*[^0-9A-Fa-f]*'
                 ),
  state          TEXT NOT NULL
                 CHECK (state IN ('processing', 'completed', 'unknown')),
  response_text  TEXT,
  created_at     TEXT NOT NULL,
  completed_at   TEXT,
  PRIMARY KEY (tenant, update_id)
);
