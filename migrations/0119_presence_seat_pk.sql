-- 0119_presence_seat_pk.sql — Support multiple unique seats per member/agent in presence.
--
-- Why: Previously, presence had PRIMARY KEY (tenant, member_id). Multiple seats sharing
-- the same member/agent token (e.g. Grok Bot, Mumega CEO, Cursor tabs) collapsed and
-- overwrote each other on every check-in.
--
-- This migration updates the primary key to (tenant, member_id, label) so distinct seats
-- are persisted independently and coexist in the flock presence table.

CREATE TABLE presence_new (
  tenant        TEXT NOT NULL,
  member_id     TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT 'unknown',
  label         TEXT NOT NULL DEFAULT '',
  agent_id      TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant, member_id, label)
);

INSERT OR IGNORE INTO presence_new (tenant, member_id, display_name, source, label, agent_id, first_seen_at, last_seen_at)
SELECT tenant, member_id, display_name, source, label, agent_id, first_seen_at, last_seen_at FROM presence;

DROP TABLE presence;
ALTER TABLE presence_new RENAME TO presence;

CREATE INDEX IF NOT EXISTS idx_presence_tenant_seen ON presence(tenant, last_seen_at DESC);
