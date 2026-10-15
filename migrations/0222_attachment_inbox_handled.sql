-- 0222: per-ATTACHMENT "handled" receipts for the agent inbox (mupot#1937).
--
-- An ATTACHED chat (W2, agent_seat_attachments) is peek-only on the agent inbox by design: it can never consume, lease,
-- ack or dead-letter, so a chat tab is never treated as the agent's host. That left an attached-only agent unable to
-- say "I handled this". This table is that statement, and nothing more: one row per (attachment, message) written by
-- the `inbox_mark_handled` tool. It is read ONLY by that attachment's own peek (which hides what it handled).
--
-- It deliberately does NOT touch agent_messages.read_at, lease columns, delivery_attempts, dead letters, the consumer
-- fence, presence or fleet heartbeat: the host's cursor and queue are not this table's business. The attachment FK is
-- RESTRICT like its siblings; message_id has no FK (a purged message must not block, or be blocked by, a receipt).
CREATE TABLE IF NOT EXISTS agent_attachment_handled (
  attachment_id TEXT NOT NULL REFERENCES agent_seat_attachments(id) ON DELETE RESTRICT,
  tenant        TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  handled_at    TEXT NOT NULL,
  PRIMARY KEY (attachment_id, message_id)
);
-- No secondary index: every read is by the PK prefix (attachment_id). Receipts are keyed to the attachment, so they do not
-- survive a thread change (a new attachment starts clean); pruning rows of detached attachments is a follow-up.
