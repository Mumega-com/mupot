-- mupot — GHL outbound act queue (issue #8).
--
-- An outbound act is a PENDING customer-side side-effect (send email, add contact,
-- move CRM stage) that may only SEND after a human-approved gate verdict.
--
-- Iron invariants (enforced at the application layer; the schema enforces the shape):
--   1. An act starts 'pending'. It can move to 'sent' ONLY through runApprovedActs(),
--      which re-checks the latest task_verdicts row independently before every send.
--   2. A refused or failed act is terminal at the application layer for that run.
--      Retry = a new act row (or operator re-queue).
--   3. verdict_id is null until the act is actually sent — it records WHICH approved
--      verdict authorized the send, completing the audit chain.

CREATE TABLE IF NOT EXISTS outbound_acts (
  id          TEXT NOT NULL PRIMARY KEY,  -- crypto.randomUUID()
  task_id     TEXT NOT NULL,              -- tasks.id — the work unit this act belongs to
  kind        TEXT NOT NULL CHECK(kind IN ('send_email', 'add_contact', 'move_stage')),
  payload     TEXT NOT NULL,              -- JSON — act-specific params (typed at app layer)
  -- 'sending' is a CLAIM state: an act is moved pending→sending (atomic conditional
  -- UPDATE) BEFORE the external GHL call, so a CF Workflows step retry can never
  -- re-pick an already-sent act and double-send a real customer email (#8 P1 fix).
  -- An act stuck in 'sending' (post-send write crashed) is NEVER auto-resent — it
  -- fails safe to under-send and surfaces for operator inspection.
  status      TEXT NOT NULL DEFAULT 'pending'
                   CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'refused')),
  verdict_id  TEXT,                       -- task_verdicts.id that authorized the send (null until sent)
  detail      TEXT,                       -- short status note / sanitized error (no keys)
  created_at  TEXT NOT NULL,              -- ISO-8601
  sent_at     TEXT                        -- ISO-8601; set when status → 'sent'
);

-- Primary lookup: all pending acts for a task (before sending + COUNT check in pipeline).
CREATE INDEX IF NOT EXISTS idx_outbound_acts_task_status ON outbound_acts (task_id, status);
