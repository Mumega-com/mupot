-- 0056_project_activity_evidence.sql — explicit project context for durable agent messages.
--
-- Existing messages remain valid and unassigned. New attributed messages must
-- reference an active project. Project attribution is immutable because it is
-- part of the sender-scoped request-id idempotency contract.

ALTER TABLE agent_messages ADD COLUMN project_id TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_messages_project_created
  ON agent_messages(tenant, project_id, created_at DESC, seq DESC);

CREATE TRIGGER validate_agent_messages_project_insert
BEFORE INSERT ON agent_messages
WHEN NEW.project_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'message project not found')
    WHERE NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id);
  SELECT RAISE(ABORT, 'message project archived')
    WHERE EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND status = 'archived');
END;

CREATE TRIGGER validate_agent_messages_project_update
BEFORE UPDATE OF project_id ON agent_messages
WHEN OLD.project_id IS NOT NEW.project_id
BEGIN
  SELECT RAISE(ABORT, 'message project immutable');
END;
