-- 0180_seat_events_route_precheck.sql — mupot#1594 (gate on #1593 @ f9212ca0, comment
-- 5860990271, P1-A): "anonymous lockout of the seat-events channel via forged-ticket
-- sockets." The Worker route (seat-events-routes.ts, GET /) was refusing an upgrade on
-- SHAPE only (isWellFormedTicket: 43 chars of the right alphabet) — never on whether the
-- ticket was ever actually minted. 200/200 forged tickets reached SeatEventsDO's /connect,
-- each consuming one of the pot's 500 socket slots and one acceptWebSocket call.
--
-- mupot#1595 round-2 adversarial gate (kasra-review) P1: the original shape of this table
-- (hash/expiry only) made the pre-check a REUSABLE existence check, not a single-use one —
-- the route never consumed a real ticket, so one minted ticket opened 80/80 upgrades from
-- 80 distinct IPv6 /64s within its 60s TTL, each spending a pending-socket slot. NOT YET
-- APPLIED IN PROD, so this CREATE can still change shape rather than needing a follow-up
-- ALTER: added `used_at` (the atomic single-use burn, mirroring email_login_attempts'
-- `consumed_at` — src/auth/email-login.ts's `UPDATE ... WHERE consumed_at IS NULL ...
-- RETURNING` pattern) and `host_agent_id` (so the route can hand the DO the ticket's OWN
-- host at /connect time, for a per-host pending-socket cap — see MAX_PENDING_SOCKETS_PER_HOST
-- in src/agents/seat-events.ts).
--
-- Two NEW tables, both additive (no rebuild of any parent table):
--
-- 1. seat_events_tickets — the route-level, pre-DO existence+expiry+single-use check. Minted
--    alongside the DO-storage record (src/agents/seat-events-routes.ts POST /ticket), scoped
--    by tenant (the "audience" check) and expiry. The route does one atomic UPDATE ... SET
--    used_at ... WHERE used_at IS NULL ... RETURNING against THIS table before ever
--    forwarding a WebSocket upgrade to the DO — a forged 43-char string has a 2^-256 chance
--    of matching a real hash, the same unforgeability guarantee a signed token would give,
--    without minting a brand-new HMAC secret that would need a `wrangler secret put` in prod
--    before this could ever take effect (this table needs no such rollout step — see
--    src/agents/seat-events.ts's `consumeTicketPreCheck` docstring for the full reasoning).
--    The DO's OWN single-use burn (`tickets.take()`, over the hello frame) is untouched —
--    this table's `used_at` is a SEPARATE, earlier single-use gate, not a replacement for it.
--
-- 2. seat_events_upgrade_rate_limits — same atomic fixed-window UPSERT…WHERE count<cap shape
--    as 0177's seat_events_ticket_rate_limits, but scoped to the UPGRADE route (GET /), which
--    had no rate limit at all: an attacker holding zero real tickets can still cost one D1
--    SELECT per forged attempt via table 1 above, with no ceiling before this. A SEPARATE
--    table (not a shared one with a new `scope` column) because 0177's table has no scope
--    column and no CHECK to add one to without touching that already-applied table's shape.
--
-- DEPLOY ORDERING (kasra-review round 2, P3): apply 0180 BEFORE deploying this code — the
-- upgrade route's ticket pre-check and the ticket-mint route's pre-check WRITE both
-- hard-depend on `seat_events_tickets` existing. Deploying the code first makes every mint
-- 503 and every upgrade 401/429: the channel goes fully dark (fails closed, but dark) until
-- the migration lands. See the Deploy checklist in docs/fleet/seat-events-channel.md.
--
-- mupot#1595 adversarial round 2 (P2-a): pruneRateLimitTable's DELETE (seat-events.ts) had
-- no covering index on either limiter table — an unindexed scan on every call, including
-- over-limit calls that changed nothing. Both limiters now only prune on the FIRST request
-- of a brand-new window (see underTicketRateLimit/underUpgradeRateLimit), and both tables
-- get a (tenant, window_start) index HERE — 0177's `seat_events_ticket_rate_limits` is
-- already applied in prod, but a NEW index on an existing table is additive (no rebuild), so
-- it can still land in this migration rather than needing its own.

CREATE TABLE IF NOT EXISTS seat_events_tickets (
  tenant         TEXT    NOT NULL,
  hash           TEXT    NOT NULL, -- sha256Hex(ticket), same hash the DO's storage key derives from
  host_agent_id  TEXT    NOT NULL, -- the signed ticket request's host — carried to the DO at /connect
  expires_at     INTEGER NOT NULL, -- unix seconds, mirrors the DO-storage TicketRecord.expires_at
  used_at        TEXT,             -- NULL until the route burns it; single-use, atomic UPDATE...RETURNING
  created_at     TEXT    NOT NULL,
  PRIMARY KEY (tenant, hash)
);

CREATE INDEX IF NOT EXISTS idx_seat_events_tickets_expiry
  ON seat_events_tickets(expires_at);

CREATE TABLE IF NOT EXISTS seat_events_upgrade_rate_limits (
  tenant        TEXT    NOT NULL,
  key           TEXT    NOT NULL, -- cf-connecting-ip, IPv6 bucketed to its /64 (see ipRateLimitKey)
  window_start  TEXT    NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant, key, window_start)
);

-- P2-a: covering index for pruneRateLimitTable's `DELETE ... WHERE tenant = ?1 AND
-- window_start < ?2` on BOTH limiter tables (0177's already-applied ticket-mint table too).
CREATE INDEX IF NOT EXISTS idx_seat_events_ticket_rate_limits_window
  ON seat_events_ticket_rate_limits(tenant, window_start);

CREATE INDEX IF NOT EXISTS idx_seat_events_upgrade_rate_limits_window
  ON seat_events_upgrade_rate_limits(tenant, window_start);
