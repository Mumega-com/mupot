-- 0111_memberships_capability_admin.sql
--
-- memberships.capability CHECK was ('owner','lead','member','observer').
-- The write path (setAgentSquadAccess) accepts AgentAccessCapability
-- observer|member|lead|admin. Honouring the input (mupot#1161 repair) would
-- fail the CHECK on 'admin'. Widen to the Capability union used everywhere
-- else. Existing rows stay as they are (almost all 'member' from the clamp).

PRAGMA foreign_keys = off;

CREATE TABLE memberships_new (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  squad_id    TEXT NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  capability  TEXT NOT NULL DEFAULT 'member'
                CHECK (capability IN ('owner','admin','lead','member','observer')),
  UNIQUE(agent_id, squad_id)
);

INSERT INTO memberships_new (id, agent_id, squad_id, capability)
SELECT id, agent_id, squad_id, capability FROM memberships;

DROP TABLE memberships;
ALTER TABLE memberships_new RENAME TO memberships;

PRAGMA foreign_keys = on;
