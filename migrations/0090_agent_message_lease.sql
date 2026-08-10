-- 0090_agent_message_lease.sql — lease / ack / dead-letter for agent_messages.
--
-- Numbering: 0089_backfill_addon_manifest_v0_29.sql is the head of origin/main and the
-- highest number present on ANY origin ref at the time this branch was cut (checked with
-- `git ls-tree` over every refs/remotes/origin/*). 0090 is the first free slot ABOVE that
-- head, which is what scripts/check-migration-numbering.mjs requires — a free slot BELOW
-- the head never runs (#729).
--
-- Why this exists
-- ---------------
-- `agent_messages` has exactly one delivery marker: read_at. The `inbox` tool's default
-- consume sets it for the WHOLE returned batch in one UPDATE…RETURNING, so a harness that
-- reads 6 messages and then dies on message #1 has already told the pot all 6 were
-- delivered. There is no per-message acknowledgement and therefore no way for the pot to
-- know a message was fetched but never handled.
--
-- Observed 2026-08-10: a responder timed out on one oversized message five times over ~55
-- minutes, retrying it forever, head-of-line blocking a queue of six. In the pot those rows
-- read simply as "read". The stuck state existed only in a local spool directory on one VPS,
-- and the poison message was parked in a local failed/ folder nobody inspects.
--
-- mupot already runs a dead-letter queue for its own events (wrangler.toml,
-- [[queues.consumers]] mupot-events -> dead_letter_queue = "mupot-events-dlq"). Agent
-- inboxes had no equivalent. These four columns are that equivalent, in the pot:
--
--   delivery_attempts  how many times the row has been HANDED OUT by inbox_lease. Purely
--                      additive: the existing `inbox` consume never touches it, so a row
--                      consumed the old way stays at 0 and nothing about that path changes.
--   lease_expires_at   ISO-8601 UTC. While in the future the row is invisible to the next
--                      lease. When it passes, the row becomes leasable again — that is the
--                      crash-recovery property a local spool was standing in for.
--   dead_lettered_at   set once delivery_attempts reaches MAX_DELIVERY_ATTEMPTS; the row
--                      stops being leased so the queue behind it drains (head-of-line
--                      unblock) and the stuck message becomes a QUERYABLE FACT.
--   dead_letter_reason human-readable cause, e.g. 'max_delivery_attempts_exceeded:5'.
--
-- D1 runs ONE TRANSACTION PER FILE, so all four ALTERs plus the index either all land or
-- none do. Additive columns only — agent_messages is NOT rewritten (a rewrite would drop
-- the 0069 project triggers and the 0032 partial unique index on request_id).
--
-- NOT NULL DEFAULT 0 on delivery_attempts is legal for ADD COLUMN precisely because the
-- default is non-null; every pre-existing row reads 0, which is the truth (nothing has ever
-- been leased). The other three are nullable: NULL is the meaningful "never leased" /
-- "not dead" state, and a sentinel string would have to be excluded from every predicate.

ALTER TABLE agent_messages ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_messages ADD COLUMN lease_expires_at TEXT;
ALTER TABLE agent_messages ADD COLUMN dead_lettered_at TEXT;
ALTER TABLE agent_messages ADD COLUMN dead_letter_reason TEXT;

-- The lease read path is
--   WHERE tenant=? AND to_agent=? AND read_at IS NULL AND dead_lettered_at IS NULL
--     AND (lease_expires_at IS NULL OR lease_expires_at <= now) ORDER BY seq ASC
-- The existing idx_agent_messages_inbox(tenant, to_agent, read_at, seq) already covers the
-- first three terms; this one carries the two lease terms as well so the dead-letter listing
-- and the leasable scan do not degrade to a table scan on a busy inbox.
CREATE INDEX IF NOT EXISTS idx_agent_messages_lease
  ON agent_messages(tenant, to_agent, read_at, dead_lettered_at, lease_expires_at, seq);
