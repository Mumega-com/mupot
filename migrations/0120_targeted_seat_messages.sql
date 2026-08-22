-- 0120_targeted_seat_messages.sql — Targeted seat mailboxes for agent_messages.
--
-- Why: Previously, agent_messages addressed only to_agent (the family). When multiple
-- concurrent seats share the same family token (e.g. Mumega Ceo desktop vs Cursor Cloud seats),
-- calling inbox() or inbox_lease() without a target seat would drain or head-of-line block
-- messages intended for a specific runtime session.
--
-- This migration adds a nullable target_seat column to agent_messages and an index supporting
-- efficient partition querying per (tenant, to_agent, target_seat, read_at).

ALTER TABLE agent_messages ADD COLUMN target_seat TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_messages_target_seat
  ON agent_messages(tenant, to_agent, target_seat, read_at, seq);
