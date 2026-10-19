-- 0247 approval bot ("/muapprove"): a dedicated Telegram bot, owned by the worker, delivers an elevation request to the
-- deciding human's bound private chat and takes the Approve / Deny tap (or /muapprove <id>, /mudeny <id>, /murevoke).
--
-- elevation_requests.short_id    the id the human types or taps. Assigned lazily when a request is offered to the bot,
--                                unique per tenant. It carries NO authority: every decision still needs the bound private
--                                chat of a member who may decide the request.
-- elevation_requests.recommendation  optional one-line recommendation the filing agent supplied (display only, untrusted).
-- elevation_requests.decided_via the channel that carried the decision ('approval_bot'); decision_note carries the same fact
--                                atomically with the decision (via:approval_bot), this column is the queryable copy.
-- approval_bot_deliveries        one row per request: who the bot addressed, in which chat, and the message id. A decision
--                                from the bot is accepted only from the member and chat recorded here (once-only slot).
ALTER TABLE elevation_requests ADD COLUMN short_id TEXT;
ALTER TABLE elevation_requests ADD COLUMN recommendation TEXT;
ALTER TABLE elevation_requests ADD COLUMN decided_via TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_elevation_requests_short_id
  ON elevation_requests(tenant, short_id) WHERE short_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS approval_bot_deliveries (
  id          TEXT PRIMARY KEY,
  tenant      TEXT NOT NULL,
  request_id  TEXT NOT NULL UNIQUE REFERENCES elevation_requests(id) ON DELETE CASCADE,
  member_id   TEXT NOT NULL,
  chat_id     TEXT NOT NULL,
  message_id  TEXT,
  status      TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'sent', 'failed')),
  error       TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approval_bot_deliveries_member ON approval_bot_deliveries(tenant, member_id, created_at);
