-- 0139_seat_agent_bindings.sql — one token, many agent identities (one per seat).
--
-- A member token welds to a single agent via member_tokens.agent_id. That weld is the
-- default identity, not a ceiling: one human runs several harnesses (Cursor IDE, Cursor
-- Cloud, a CLI) on the same token, and each seat must be able to claim a different
-- agent. This table is the per-seat override. Lookups are keyed by (tenant, token, seat)
-- and MUST also match member_id so a binding authorized by one principal is never
-- usable by another.
--
-- No foreign keys: PRAGMA foreign_keys = off is a silent no-op inside D1's per-file
-- transaction, so declared FKs stay enforced and can abort the migration.

CREATE TABLE IF NOT EXISTS seat_agent_bindings (
  tenant       TEXT NOT NULL,
  token_id     TEXT NOT NULL,
  seat         TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  member_id    TEXT NOT NULL,
  bound_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant, token_id, seat)
);

CREATE INDEX IF NOT EXISTS idx_seat_agent_bindings_agent
  ON seat_agent_bindings (tenant, agent_id);
