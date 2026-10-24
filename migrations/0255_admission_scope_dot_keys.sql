-- 0255_admission_scope_dot_keys.sql — schema only: an admission scope, a table of dot keys, and a nullable link from an
-- attachment to the key it presented. NO reader or writer in the application uses any of this yet; every existing row
-- keeps today's behaviour (scope 'seat', no key). Additive: nothing is dropped, renamed or backfilled.
--
--   agent_seat_admissions.scope   'seat'    the admission is tied to the one thread that asked (every existing row, the DEFAULT)
--                                 'harness' the admission covers the (agent, human, harness) triple
--   agent_dot_keys                one row per issued key; only a hash of the key is stored (never the key); revoke is a timestamp
--   agent_seat_attachments.dot_key_id  the key an attachment was made with (NULL = none, the legacy path)
--
-- WHY A COLUMN WITH A CHECK AND NO REBUILD. SQLite cannot alter a CHECK in place, and agent_seat_admissions is the PARENT
-- of agent_seat_attachments (admission_id ... ON DELETE RESTRICT) whose rows are no-delete by trigger, so a table rebuild
-- fails on any pot that already holds an attachment (same trap 0247 documents). ADD COLUMN ... NOT NULL DEFAULT 'seat'
-- CHECK (...) is allowed and gives every existing row 'seat'.
--
-- DEPLOY ORDER. Safe to apply before or after the Worker: nothing reads these columns.

ALTER TABLE agent_seat_admissions ADD COLUMN scope TEXT NOT NULL DEFAULT 'seat' CHECK (scope IN ('seat', 'harness'));

-- Shape CHECKs cannot be added to an existing table later without a rebuild, so they are written now (same hash shape as
-- 0220 secure_moments.link_token_sha256: 64 lowercase hex chars; typeof() refuses a BLOB or a number of the right length).
CREATE TABLE IF NOT EXISTS agent_dot_keys (
  id            TEXT PRIMARY KEY,
  tenant        TEXT NOT NULL,
  admission_id  TEXT NOT NULL REFERENCES agent_seat_admissions(id) ON DELETE RESTRICT,
  key_hash      TEXT NOT NULL CHECK (
    typeof(key_hash) = 'text' AND length(key_hash) = 64 AND key_hash = lower(key_hash) AND key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  subject_hash  TEXT CHECK (
    subject_hash IS NULL OR (typeof(subject_hash) = 'text' AND length(subject_hash) = 64 AND subject_hash = lower(subject_hash) AND subject_hash NOT GLOB '*[^0-9a-f]*')
  ),
  created_at    TEXT NOT NULL CHECK (
    typeof(created_at) = 'text' AND length(created_at) >= 20 AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'
  ),
  revoked_at    TEXT CHECK (
    revoked_at IS NULL OR (typeof(revoked_at) = 'text' AND length(revoked_at) >= 20 AND revoked_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_dot_keys_key_hash ON agent_dot_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_agent_dot_keys_admission ON agent_dot_keys(admission_id);

-- A key row keeps its identity; revoking is the only change and it is one-way. History is never deleted.
CREATE TRIGGER IF NOT EXISTS agent_dot_keys_immutable
BEFORE UPDATE ON agent_dot_keys
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id OR NEW.tenant IS NOT OLD.tenant OR NEW.admission_id IS NOT OLD.admission_id
  OR NEW.key_hash IS NOT OLD.key_hash OR NEW.subject_hash IS NOT OLD.subject_hash
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
BEGIN
  SELECT RAISE(ABORT, 'agent_dot_key_immutable');
END;

CREATE TRIGGER IF NOT EXISTS agent_dot_keys_no_delete
BEFORE DELETE ON agent_dot_keys
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'agent_dot_key_immutable');
END;

-- INSERT OR REPLACE / REPLACE INTO deletes the conflicting row WITHOUT firing the no-delete trigger (recursive_triggers is off),
-- which would silently un-revoke a key. BEFORE INSERT fires ahead of conflict resolution, so a colliding id or key_hash is refused.
-- The key must also belong to an admission of the same tenant that can still be used (pending or live).
CREATE TRIGGER IF NOT EXISTS agent_dot_keys_no_replace
BEFORE INSERT ON agent_dot_keys
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM agent_dot_keys k WHERE k.id = NEW.id OR k.key_hash = NEW.key_hash)
BEGIN
  SELECT RAISE(ABORT, 'agent_dot_key_immutable');
END;

CREATE TRIGGER IF NOT EXISTS agent_dot_keys_admission_binding
BEFORE INSERT ON agent_dot_keys
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM agent_seat_admissions a
   WHERE a.id = NEW.admission_id AND a.tenant = NEW.tenant AND a.status IN ('pending', 'live')
)
BEGIN
  SELECT RAISE(ABORT, 'agent_dot_key_admission_invalid');
END;

-- Same hole on the parent: REPLACE on an admission id would delete it without the no-delete trigger firing.
CREATE TRIGGER IF NOT EXISTS agent_seat_admissions_no_replace
BEFORE INSERT ON agent_seat_admissions
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM agent_seat_admissions a WHERE a.id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'agent_seat_admission_immutable');
END;

-- Revoking an admission revokes its keys in the same statement (the keys' own one-way revoke rule still applies).
CREATE TRIGGER IF NOT EXISTS agent_seat_admissions_revoke_dot_keys
AFTER UPDATE OF status ON agent_seat_admissions
FOR EACH ROW
WHEN NEW.status = 'revoked' AND OLD.status <> 'revoked'
BEGIN
  UPDATE agent_dot_keys
     SET revoked_at = CASE WHEN length(NEW.revoked_at) >= 20 THEN NEW.revoked_at ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END
   WHERE admission_id = NEW.id AND revoked_at IS NULL;
END;

ALTER TABLE agent_seat_attachments ADD COLUMN dot_key_id TEXT REFERENCES agent_dot_keys(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_agent_seat_attachments_dot_key ON agent_seat_attachments(dot_key_id) WHERE dot_key_id IS NOT NULL;

-- An attachment may name a key only if that key belongs to the attachment's own admission and tenant and is not revoked.
-- Detach semantics are unchanged: these fire on INSERT and when dot_key_id is written, never on a plain detach.
CREATE TRIGGER IF NOT EXISTS agent_seat_attachments_dot_key_binding_insert
BEFORE INSERT ON agent_seat_attachments
FOR EACH ROW
WHEN NEW.dot_key_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM agent_dot_keys k
   WHERE k.id = NEW.dot_key_id AND k.admission_id = NEW.admission_id AND k.tenant = NEW.tenant AND k.revoked_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'agent_seat_attachment_dot_key_invalid');
END;

CREATE TRIGGER IF NOT EXISTS agent_seat_attachments_dot_key_binding_update
BEFORE UPDATE OF dot_key_id ON agent_seat_attachments
FOR EACH ROW
WHEN NEW.dot_key_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM agent_dot_keys k
   WHERE k.id = NEW.dot_key_id AND k.admission_id = NEW.admission_id AND k.tenant = NEW.tenant AND k.revoked_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'agent_seat_attachment_dot_key_invalid');
END;

-- Rebuild the two update guards from 0220 (identical to the originals) with the new column added, so scope and dot_key_id
-- cannot be changed after the row is written.
DROP TRIGGER IF EXISTS agent_seat_admissions_immutable;

CREATE TRIGGER agent_seat_admissions_immutable
BEFORE UPDATE ON agent_seat_admissions
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id OR NEW.tenant IS NOT OLD.tenant OR NEW.agent_id IS NOT OLD.agent_id
  OR NEW.human_member_id IS NOT OLD.human_member_id OR NEW.harness_id IS NOT OLD.harness_id
  OR NEW.created_at IS NOT OLD.created_at OR NEW.requested_via IS NOT OLD.requested_via
  OR NEW.gates IS NOT OLD.gates
  OR NEW.scope IS NOT OLD.scope
  OR (NEW.ceiling IS NOT OLD.ceiling AND OLD.status <> 'pending') -- the human picks it at the decision (pending -> live) and never after
  OR OLD.status IN ('denied', 'revoked', 'expired')
  OR (OLD.status = 'live' AND NEW.status NOT IN ('live', 'revoked'))
BEGIN
  SELECT RAISE(ABORT, 'agent_seat_admission_immutable');
END;

DROP TRIGGER IF EXISTS agent_seat_attachments_immutable;

CREATE TRIGGER agent_seat_attachments_immutable
BEFORE UPDATE ON agent_seat_attachments
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id OR NEW.tenant IS NOT OLD.tenant OR NEW.seat_id IS NOT OLD.seat_id
  OR NEW.human_member_id IS NOT OLD.human_member_id OR NEW.harness_id IS NOT OLD.harness_id
  OR NEW.agent_id IS NOT OLD.agent_id OR NEW.admission_id IS NOT OLD.admission_id
  OR NEW.seat_token_id IS NOT OLD.seat_token_id OR NEW.created_at IS NOT OLD.created_at
  OR NEW.dot_key_id IS NOT OLD.dot_key_id
  OR (OLD.detached_at IS NOT NULL AND (NEW.detached_at IS NOT OLD.detached_at OR NEW.detach_reason IS NOT OLD.detach_reason
                                      OR NEW.detached_by_member_id IS NOT OLD.detached_by_member_id))
BEGIN
  SELECT RAISE(ABORT, 'agent_seat_attachment_immutable');
END;
