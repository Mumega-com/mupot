-- 0242_event_subscribe_refusals.sql -- why an events/subscribe was refused (mupot observability).
-- Before this, a subscribe refused before/at verification (seat handle, unbound session, agent_not_attached, bad callback host, ...)
-- left no D1 row and no log, so "the client never asked" read the same as "refused early".
-- BOUNDED: the writer inserts at most one row per (tenant, principal, reason) per minute, prunes rows older than 7 days, and stops at a
-- per-tenant row ceiling. Stores the callback HOST only: never the URL, the secret, or any token. CREATE only; nothing is rebuilt.

CREATE TABLE IF NOT EXISTS event_subscribe_refusals (
  id         TEXT PRIMARY KEY NOT NULL,
  tenant     TEXT NOT NULL,
  agent_id   TEXT,
  member_id  TEXT,
  harness_id TEXT,
  seat_id    TEXT,
  reason     TEXT NOT NULL,
  host       TEXT,
  at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_subscribe_refusals_principal
  ON event_subscribe_refusals (tenant, agent_id, member_id, reason, at);
CREATE INDEX IF NOT EXISTS idx_event_subscribe_refusals_at
  ON event_subscribe_refusals (tenant, at);
