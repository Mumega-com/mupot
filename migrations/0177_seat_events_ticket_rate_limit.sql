-- 0177_seat_events_ticket_rate_limit.sql — mupot#1589 adversarial gate round 1 (kasra-review),
-- P3: "POST /ticket without authentication costs one D1 read and one Ed25519 verify per
-- request, with no rate limit." That route has no bearer, so the only atomic-guard seam it
-- can use is the SAME one 0174 built for email-login (a fixed-window UPSERT counter, never a
-- KV-style read-then-write) — see src/agents/seat-events.ts's `underTicketRateLimit`, keyed on
-- the connecting IP (never the caller-asserted, unverified-at-that-point host_agent_id).
--
-- A dedicated table rather than reusing `email_login_rate_limits`: that table's `scope` column
-- is CHECK-constrained to email-login's own three scopes, and it is a live, already-applied
-- table this branch has no reason to touch. The SEAM being reused is the atomic-UPSERT
-- pattern, not the table.
--
-- Fixed 10-minute buckets, not a sliding window — same accepted simplification as
-- email_login_rate_limits (see that migration's own header): the property being guaranteed is
-- atomicity under concurrency, not exact sliding-window precision.

CREATE TABLE IF NOT EXISTS seat_events_ticket_rate_limits (
  tenant        TEXT    NOT NULL,
  key           TEXT    NOT NULL, -- the resolved cf-connecting-ip value (or 'unknown')
  window_start  TEXT    NOT NULL, -- ISO instant the 10-minute bucket started
  count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant, key, window_start)
);
