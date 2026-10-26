-- 0259_email_decision_foundation.sql — email reply approvals, PR1 (foundation only; flag EMAIL_DECISIONS, off).
-- Design: mumega.com agents/kasra/docs/design-email-reply-approvals-20261026.md.
-- Nothing in this PR writes a verdict. Tables are created now so PR2/PR3 do not need a schema change mid-gate.
--
-- task_verdicts is append-only and 0252's trigger pins every column on the update path (but not a new one). An
-- ADD COLUMN decided_channel would therefore be silently MUTABLE on rows with project_id NULL. So the channel
-- lives in a side table with its own no-update / no-delete triggers; task_verdicts is not touched at all.

CREATE TABLE IF NOT EXISTS email_decision_tokens (
  decision_id        TEXT PRIMARY KEY,                 -- random id, also the token's first segment
  tenant             TEXT NOT NULL,
  task_id            TEXT NOT NULL,
  member_id          TEXT NOT NULL,
  email_normalized   TEXT NOT NULL,
  review_entered_at  TEXT NOT NULL,                    -- binds the token to the card's task revision
  expires_at         TEXT NOT NULL,
  state              TEXT NOT NULL DEFAULT 'issued' CHECK (state IN ('issued', 'used', 'revoked')),
  used_at            TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_decision_tokens_task ON email_decision_tokens(task_id, state);
CREATE INDEX IF NOT EXISTS idx_email_decision_tokens_member ON email_decision_tokens(member_id, state);

CREATE TABLE IF NOT EXISTS email_decision_bindings (
  id                 TEXT PRIMARY KEY,
  tenant             TEXT NOT NULL,
  member_id          TEXT NOT NULL,
  email_normalized   TEXT NOT NULL,
  verified_at        TEXT,                             -- NULL = never authorizes a decision
  verified_via       TEXT,
  unbound_at         TEXT,
  created_at         TEXT NOT NULL
);
-- One live binding per mailbox per tenant: two members cannot share an approving address.
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_decision_bindings_live
  ON email_decision_bindings(tenant, email_normalized) WHERE unbound_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_email_decision_bindings_member ON email_decision_bindings(member_id);

-- Spike receipts: envelope + header NAMES + whitelisted header values + size. Never a body.
CREATE TABLE IF NOT EXISTS email_inbound_receipts (
  id                 TEXT PRIMARY KEY,
  received_at        TEXT NOT NULL,
  envelope_from      TEXT NOT NULL,
  envelope_to        TEXT NOT NULL,                    -- as received, +token kept
  header_names       TEXT NOT NULL,                    -- JSON array of header names
  header_values      TEXT NOT NULL,                    -- JSON object, whitelisted headers only
  raw_size           INTEGER NOT NULL,
  outcome            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_inbound_receipts_received ON email_inbound_receipts(received_at);

CREATE TABLE IF NOT EXISTS task_verdict_channels (
  verdict_id         TEXT PRIMARY KEY REFERENCES task_verdicts(id),
  channel            TEXT NOT NULL CHECK (channel IN ('email_reply')),
  created_at         TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS task_verdict_channels_no_update
BEFORE UPDATE ON task_verdict_channels
BEGIN SELECT RAISE(ABORT, 'task_verdict_channels is append-only'); END;
CREATE TRIGGER IF NOT EXISTS task_verdict_channels_no_delete
BEFORE DELETE ON task_verdict_channels
BEGIN SELECT RAISE(ABORT, 'task_verdict_channels is append-only'); END;
