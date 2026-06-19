-- 0032_agent_messages.sql — durable agent↔agent inbox (squad → mupot migration, S3).
--
-- The ONE bus primitive mupot lacked: a per-agent durable message store an agent reads on
-- wake. mupot already covers memory/tasks/presence/identity/wake; this closes the gap so the
-- kasra squad (arms + brain) can coordinate THROUGH the pot instead of the fragile SOS Python
-- bus. Pot-sealed (no egress), tenant-scoped, accountable (sender agent + member recorded).
--
-- Model (matches the SOS bus semantics the wake-wiring depends on):
--   - ORDERED: `seq` is INTEGER PRIMARY KEY AUTOINCREMENT → a strictly-increasing per-pot
--     cursor (never reused), so a reader can page by "since seq" and the bash wake hooks get
--     the XRANGE-cursor behaviour they rely on.
--   - ADDRESSED: to_agent = recipient agent id; from_agent = the sender's welded agent
--     (member_tokens.agent_id); from_member = the authenticated member (the real principal,
--     for accountability — identity is NEVER read from message text).
--   - REQUEST/ACK + REPLAY-ONCE: request_id is the SENDER's idempotency key — uniqueness is
--     scoped (tenant, from_agent, request_id) so two different senders reusing the same rid
--     string never collide (a bare (tenant, request_id) key would let agent X pre-seed an rid
--     and silently swallow agent Y's later send — a cross-agent ACK-poisoning vector). A
--     same-sender rid re-send with identical content is an idempotent no-op; with DIFFERENT
--     content it is rejected (request_id_conflict), never silently dropped. in_reply_to links
--     an ack back to its request.
--   - CONSUME: read_at is the consume marker; inbox() reads unread oldest-first and marks
--     them read atomically (UPDATE…RETURNING), so a message is delivered once.
-- Tenant is environment-derived (env.TENANT_SLUG); a row can never address another pot.

CREATE TABLE IF NOT EXISTS agent_messages (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,   -- monotonic per-pot ordering cursor
  id           TEXT NOT NULL UNIQUE,                -- opaque message id (uuid)
  tenant       TEXT NOT NULL,                       -- = TENANT_SLUG, isolation
  to_agent     TEXT NOT NULL,                       -- recipient agent id (resolved, exists in pot)
  from_agent   TEXT NOT NULL,                       -- sender agent id (the weld)
  from_member  TEXT NOT NULL,                       -- sender member id (the authenticated principal)
  kind         TEXT NOT NULL DEFAULT 'message',     -- message | request | ack
  body         TEXT NOT NULL,                       -- the payload (capped at write)
  request_id   TEXT,                                -- ACK-protocol rid (optional)
  in_reply_to  TEXT,                                -- the request_id this acks (optional)
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  read_at      TEXT                                 -- consume marker (NULL = unread)
);

-- inbox read path: WHERE tenant=? AND to_agent=? AND read_at IS NULL ORDER BY seq ASC.
CREATE INDEX IF NOT EXISTS idx_agent_messages_inbox
  ON agent_messages(tenant, to_agent, read_at, seq);

-- replay-once: a request_id is unique PER SENDER (partial — plain messages with no rid allowed).
-- Scoped by from_agent so one agent's idempotency keys can't collide with another's (anti-poison).
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_rid
  ON agent_messages(tenant, from_agent, request_id) WHERE request_id IS NOT NULL;
