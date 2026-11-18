-- 0276_attachment_continuity.sql — explicit R1 inbox-continuity epochs.
--
-- Additive only.  NULL on existing messages means the physical/legacy inbox path;
-- no attachment, token, label, admission, or historical handled receipt is rewritten.
-- A scope is an opaque server-owned routing selector, never a bearer credential.
-- The append-only authority decision records an explicit fresh human opt-in;
-- historical WebAuthn/R1 decisions remain default-zero and cannot enroll.

ALTER TABLE agent_seat_authority_decisions ADD COLUMN continuity_approved INTEGER NOT NULL DEFAULT 0
  CHECK (continuity_approved IN (0, 1));

CREATE TABLE IF NOT EXISTS attachment_continuity_scopes (
  id                    TEXT PRIMARY KEY,
  tenant                TEXT NOT NULL,
  admission_id          TEXT NOT NULL REFERENCES agent_seat_admissions(id) ON DELETE RESTRICT,
  agent_id              TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  human_member_id       TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  harness_id            TEXT NOT NULL REFERENCES harnesses(id) ON DELETE RESTRICT,
  source_grant_token_id TEXT NOT NULL REFERENCES member_tokens(id) ON DELETE RESTRICT,
  authority_decision_id TEXT NOT NULL REFERENCES agent_seat_authority_decisions(id) ON DELETE RESTRICT,
  created_at            TEXT NOT NULL,
  revoked_at            TEXT,
  revoked_by_member_id  TEXT REFERENCES members(id) ON DELETE RESTRICT,
  UNIQUE (tenant, admission_id, source_grant_token_id),
  UNIQUE (tenant, authority_decision_id)
);

CREATE INDEX IF NOT EXISTS idx_attachment_continuity_scopes_harness
  ON attachment_continuity_scopes(tenant, harness_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_attachment_continuity_scopes_recipient
  ON attachment_continuity_scopes(tenant, agent_id, revoked_at);

-- Scope identity is an epoch.  Revocation is one-way; REPLACE must not erase a
-- revoked row and recreate it as live.
CREATE TRIGGER IF NOT EXISTS attachment_continuity_scopes_immutable
BEFORE UPDATE ON attachment_continuity_scopes
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id OR NEW.tenant IS NOT OLD.tenant
  OR NEW.admission_id IS NOT OLD.admission_id OR NEW.agent_id IS NOT OLD.agent_id
  OR NEW.human_member_id IS NOT OLD.human_member_id OR NEW.harness_id IS NOT OLD.harness_id
  OR NEW.source_grant_token_id IS NOT OLD.source_grant_token_id OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS NOT OLD.revoked_at OR NEW.revoked_by_member_id IS NOT OLD.revoked_by_member_id))
  OR (OLD.revoked_at IS NULL AND NEW.revoked_at IS NULL AND NEW.revoked_by_member_id IS NOT OLD.revoked_by_member_id)
BEGIN
  SELECT RAISE(ABORT, 'attachment_continuity_scope_immutable');
END;

CREATE TRIGGER IF NOT EXISTS attachment_continuity_scopes_no_delete
BEFORE DELETE ON attachment_continuity_scopes
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'attachment_continuity_scope_immutable');
END;

CREATE TRIGGER IF NOT EXISTS attachment_continuity_scopes_no_replace
BEFORE INSERT ON attachment_continuity_scopes
FOR EACH ROW WHEN EXISTS (
  SELECT 1 FROM attachment_continuity_scopes s
   WHERE s.id = NEW.id
      OR (s.tenant = NEW.tenant AND s.admission_id = NEW.admission_id AND s.source_grant_token_id = NEW.source_grant_token_id)
      OR (s.tenant = NEW.tenant AND s.authority_decision_id = NEW.authority_decision_id)
)
BEGIN
  SELECT RAISE(ABORT, 'attachment_continuity_scope_immutable');
END;

ALTER TABLE agent_messages ADD COLUMN target_continuity_scope_id TEXT REFERENCES attachment_continuity_scopes(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_agent_messages_continuity_scope
  ON agent_messages(tenant, target_continuity_scope_id, to_agent, read_at, seq)
  WHERE target_continuity_scope_id IS NOT NULL;

-- A scoped message carries both its immutable scope id and its reserved logical
-- target.  This prevents an older physical-label reader from receiving it.
CREATE TRIGGER IF NOT EXISTS agent_messages_continuity_target_insert
BEFORE INSERT ON agent_messages
FOR EACH ROW WHEN NEW.target_continuity_scope_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM attachment_continuity_scopes s
     WHERE s.id = NEW.target_continuity_scope_id AND s.tenant = NEW.tenant
       AND s.agent_id = NEW.to_agent AND NEW.target_seat = 'continuity:' || s.id
  )
BEGIN
  SELECT RAISE(ABORT, 'agent_message_continuity_target_invalid');
END;

CREATE TRIGGER IF NOT EXISTS agent_messages_continuity_target_update
BEFORE UPDATE OF target_continuity_scope_id, target_seat, to_agent, tenant ON agent_messages
FOR EACH ROW WHEN NEW.target_continuity_scope_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM attachment_continuity_scopes s
     WHERE s.id = NEW.target_continuity_scope_id AND s.tenant = NEW.tenant
       AND s.agent_id = NEW.to_agent AND NEW.target_seat = 'continuity:' || s.id
  )
BEGIN
  SELECT RAISE(ABORT, 'agent_message_continuity_target_invalid');
END;

CREATE TABLE IF NOT EXISTS agent_continuity_handled (
  scope_id             TEXT NOT NULL REFERENCES attachment_continuity_scopes(id) ON DELETE RESTRICT,
  message_id           TEXT NOT NULL,
  tenant               TEXT NOT NULL,
  handled_at           TEXT NOT NULL,
  source_attachment_id TEXT NOT NULL REFERENCES agent_seat_attachments(id) ON DELETE RESTRICT,
  PRIMARY KEY (scope_id, message_id)
);

CREATE TRIGGER IF NOT EXISTS agent_continuity_handled_scope_message
BEFORE INSERT ON agent_continuity_handled
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
    FROM attachment_continuity_scopes s
    JOIN agent_seat_attachments a ON a.id = NEW.source_attachment_id AND a.tenant = NEW.tenant
    JOIN agent_messages m ON m.id = NEW.message_id AND m.tenant = NEW.tenant
   WHERE s.id = NEW.scope_id AND s.tenant = NEW.tenant
     AND s.agent_id = a.agent_id AND s.human_member_id = a.human_member_id
     AND s.harness_id = a.harness_id AND s.admission_id = a.admission_id
     AND m.target_continuity_scope_id = s.id AND m.to_agent = s.agent_id
)
BEGIN
  SELECT RAISE(ABORT, 'agent_continuity_handled_scope_message_invalid');
END;
