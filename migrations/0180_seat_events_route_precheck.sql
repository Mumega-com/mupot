-- 0180_seat_events_route_precheck.sql — mupot#1594 (gate on #1593 @ f9212ca0, comment
-- 5860990271, P1-A): "anonymous lockout of the seat-events channel via forged-ticket
-- sockets." The Worker route (seat-events-routes.ts, GET /) was refusing an upgrade on
-- SHAPE only (isWellFormedTicket: 43 chars of the right alphabet) — never on whether the
-- ticket was ever actually minted. 200/200 forged tickets reached SeatEventsDO's /connect,
-- each consuming one of the pot's 500 socket slots and one acceptWebSocket call.
--
-- Two NEW tables, both additive (no rebuild of any parent table):
--
-- 1. seat_events_tickets — the route-level, pre-DO existence+expiry check. Minted alongside
--    the DO-storage record (src/agents/seat-events-routes.ts POST /ticket), scoped by
--    tenant (the "audience" check) and expiry. The route does one indexed SELECT against
--    THIS table before ever forwarding a WebSocket upgrade to the DO — a forged 43-char
--    string has a 2^-256 chance of matching a real hash, the same unforgeability guarantee
--    a signed token would give, without minting a brand-new HMAC secret that would need a
--    `wrangler secret put` in prod before this could ever take effect (this table needs no
--    such rollout step — see src/agents/seat-events.ts's `ticketPreCheck` docstring for the
--    full reasoning). The SINGLE-USE burn stays exactly where it always was — DO storage's
--    `tickets.take()` — untouched by this migration; this table is a stateless "does this
--    look real" gate, never the source of the one-redemption guarantee.
--
-- 2. seat_events_upgrade_rate_limits — same atomic fixed-window UPSERT…WHERE count<cap shape
--    as 0177's seat_events_ticket_rate_limits, but scoped to the UPGRADE route (GET /), which
--    had no rate limit at all: an attacker holding zero real tickets can still cost one D1
--    SELECT per forged attempt via table 1 above, with no ceiling before this. A SEPARATE
--    table (not a shared one with a new `scope` column) because 0177's table has no scope
--    column and no CHECK to add one to without touching that already-applied table's shape.

CREATE TABLE IF NOT EXISTS seat_events_tickets (
  tenant      TEXT    NOT NULL,
  hash        TEXT    NOT NULL, -- sha256Hex(ticket), same hash the DO's storage key derives from
  expires_at  INTEGER NOT NULL, -- unix seconds, mirrors the DO-storage TicketRecord.expires_at
  created_at  TEXT    NOT NULL,
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
