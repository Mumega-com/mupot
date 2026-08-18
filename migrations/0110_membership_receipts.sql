-- 0110_membership_receipts.sql — durable trail for squad_member_add / remove
--
-- memberships has existed since 0001 with no MCP write path. The new tools
-- (mupot#1161) must not make an authority change inferable only from the
-- resulting memberships/capabilities rows. This table is that receipt.
--
-- Deliberately NOT REFERENCES agents/squads ON DELETE CASCADE: deleting an
-- agent or squad already drops memberships via 0001's CASCADE, which is
-- unaudited. Cascading these receipts would erase the trail at the moment it
-- is most needed. Orphan rows are the acceptable price (same choice as
-- agent_audit in 0086).
--
-- Append-only: no UPDATE, no DELETE. Undo is a new row with action='remove'.

CREATE TABLE IF NOT EXISTS membership_receipts (
  seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
  id                  TEXT NOT NULL UNIQUE,
  tenant              TEXT NOT NULL,
  actor_member_id     TEXT NOT NULL,
  actor_bound_agent_id TEXT,
  target_agent_id     TEXT NOT NULL,
  squad_id            TEXT NOT NULL,
  action              TEXT NOT NULL CHECK (action IN ('add', 'remove')),
  capability          TEXT,
  prior_capability    TEXT,
  result              TEXT NOT NULL CHECK (result IN ('created', 'updated', 'unchanged', 'removed')),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_membership_receipts_squad
  ON membership_receipts(tenant, squad_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_membership_receipts_target
  ON membership_receipts(tenant, target_agent_id, seq DESC);

CREATE TRIGGER membership_receipts_no_update
  BEFORE UPDATE ON membership_receipts
BEGIN
  SELECT RAISE(ABORT, 'membership_receipts is append-only');
END;

CREATE TRIGGER membership_receipts_no_delete
  BEFORE DELETE ON membership_receipts
BEGIN
  SELECT RAISE(ABORT, 'membership_receipts is append-only');
END;
