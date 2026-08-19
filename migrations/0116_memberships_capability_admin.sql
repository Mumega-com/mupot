-- 0116_memberships_capability_admin.sql
--
-- memberships.capability CHECK was ('owner','lead','member','observer').
-- The write path (setAgentSquadAccess) accepts AgentAccessCapability
-- observer|member|lead|admin. Honouring the input (mupot#1161 repair) would
-- fail the CHECK on 'admin'. Widen to the Capability union used everywhere
-- else. Existing rows stay as they are (almost all 'member' from the clamp).
--
-- PRAGMA foreign_keys = off/on below is DECORATIVE ON D1. wrangler d1
-- migrations apply runs this file in one transaction; SQLite ignores
-- PRAGMA foreign_keys inside an open transaction (0049, 0069, 0071, AGENTS.md).
-- Enforcement stays ON. The INSERT therefore FK-checks every copied row
-- against agents and squads. An orphan aborts the migration on production
-- while passing locally, where the PRAGMA actually works.
--
-- Measured mumega 2026-08-18: 46 memberships, 0 orphan_agent, 0 orphan_squad.
-- Digid and Viamar were NOT measured from this seat. Do not depend on that.
-- Copy only rows whose parents exist. Orphans are QUARANTINED, not silently
-- dropped (#1172). Authority rows carrying owner/admin used to vanish during
-- migration with no count, no receipt, no trail — and Digid/Viamar were not
-- measured. The quarantine table preserves them for inspection and audit.
-- New orphans cannot accumulate while CASCADE is enforced (0112).

PRAGMA foreign_keys = off;

-- #1172: quarantine orphan memberships before the rebuild. This is the
-- agent_connection_migration_guard idiom from 0071:47-49 — count and
-- preserve rather than silently drop.
CREATE TABLE IF NOT EXISTS memberships_orphan_quarantine_0116 AS
SELECT m.id, m.agent_id, m.squad_id, m.capability
  FROM memberships m
 WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = m.agent_id)
    OR NOT EXISTS (SELECT 1 FROM squads s WHERE s.id = m.squad_id);

CREATE TABLE memberships_new (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  squad_id    TEXT NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  capability  TEXT NOT NULL DEFAULT 'member'
                CHECK (capability IN ('owner','admin','lead','member','observer')),
  UNIQUE(agent_id, squad_id)
);

INSERT INTO memberships_new (id, agent_id, squad_id, capability)
SELECT m.id, m.agent_id, m.squad_id, m.capability
  FROM memberships m
 WHERE EXISTS (SELECT 1 FROM agents a WHERE a.id = m.agent_id)
   AND EXISTS (SELECT 1 FROM squads s WHERE s.id = m.squad_id);

DROP TABLE memberships;
ALTER TABLE memberships_new RENAME TO memberships;

PRAGMA foreign_keys = on;
