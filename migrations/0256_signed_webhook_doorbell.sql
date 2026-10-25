-- 0256_signed_webhook_doorbell.sql — signed, body-free webhook doorbell.
--
-- APPLY THIS BEFORE the Worker that reads delivery_version. The signed flag
-- (WEBHOOK_DOORBELL_SIGNED) ships OFF, so a deploy that has not flipped it keeps
-- today's inline bearer POST. Once the column exists, a missing flag still does
-- not SELECT it on the send path.
--
-- delivery_version
--   'legacy'  existing rows (the DEFAULT) and any registration made while the
--             signed flag is off. Inline Authorization: Bearer POST, unchanged.
--   'signed'  registrations made while WEBHOOK_DOORBELL_SIGNED is on. One queue
--             job on the events-delivery path (mcp.doorbell.delivery). Never both.
--
-- ADD COLUMN ... NOT NULL DEFAULT is the same shape as 0255: every existing row
-- becomes 'legacy' without a table rebuild. The doorbells table is referenced by
-- no child, but a rebuild is unnecessary and the DEFAULT is the dual-run switch.
--
-- Receipts: SQLite cannot widen a CHECK in place. This table has no inbound
-- foreign keys and no triggers, so it is rebuilt forward-only. Legacy outcomes
-- (claimed, posted, failed, skipped) stay valid. Signed attempts add retry and
-- dead_letter, plus attempt / error_class / signed_at. Those new columns are
-- metadata only: still no URL, key, ciphertext, or body. Copied rows get NULL
-- for the new columns.

ALTER TABLE agent_webhook_doorbells ADD COLUMN delivery_version TEXT NOT NULL DEFAULT 'legacy'
  CHECK (delivery_version IN ('legacy', 'signed'));

CREATE TABLE agent_webhook_doorbell_receipts_v2 (
  id            TEXT PRIMARY KEY,
  tenant        TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  event_type    TEXT NOT NULL CHECK (event_type IN ('mupot.inbox.wake', 'mupot.task.assigned', 'mupot.doorbell.test')),
  ref_id        TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('claimed', 'posted', 'failed', 'skipped', 'retry', 'dead_letter')),
  http_status   INTEGER,
  reason        TEXT,
  attempted_at  TEXT NOT NULL,
  -- NULL on rows copied from the legacy table (one updated claim row, no attempt counter).
  attempt       INTEGER,
  error_class   TEXT,
  signed_at     TEXT
);

INSERT INTO agent_webhook_doorbell_receipts_v2 (
  id, tenant, agent_id, event_type, ref_id, outcome, http_status, reason, attempted_at,
  attempt, error_class, signed_at
)
SELECT
  id, tenant, agent_id, event_type, ref_id, outcome, http_status, reason, attempted_at,
  NULL, NULL, NULL
FROM agent_webhook_doorbell_receipts;

DROP TABLE agent_webhook_doorbell_receipts;
ALTER TABLE agent_webhook_doorbell_receipts_v2 RENAME TO agent_webhook_doorbell_receipts;

CREATE INDEX IF NOT EXISTS idx_agent_webhook_doorbell_receipts_agent
  ON agent_webhook_doorbell_receipts (tenant, agent_id, attempted_at);
