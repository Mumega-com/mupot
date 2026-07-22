-- 0069_backfill_agent_memberships.sql — backfill the empty memberships table.
--
-- The `memberships` table (agent <-> squad RBAC edge) was EMPTY pot-wide: create_agent
-- historically wrote an `agents` row + a capability grant but never a memberships row
-- (fixed forward in src/org/service.ts to write both atomically). The project-scoped
-- message path (src/agents/messages.ts) gates sender AND recipient on
-- `EXISTS (memberships m JOIN project_squad_access psa ON psa.squad_id=m.squad_id
--          WHERE psa.project_id=? AND m.agent_id=?)`, so with memberships empty every
-- project-scoped `send` returned 403 project_access_denied. See gh #469.
--
-- Backfill: one 'member' row per existing agent on its OWN squad, for every agent that
-- lacks it. Deterministic id ('mem-backfill-'||agent.id) + WHERE NOT EXISTS makes this
-- idempotent and non-conflicting with the two rows already inserted by hand during the
-- AGY onboarding (agy + kasra c855f82c). Plain INSERT..SELECT — no trigger, no CHECK
-- change, D1-remote compatible.

INSERT INTO memberships (id, agent_id, squad_id, capability)
SELECT 'mem-backfill-' || a.id, a.id, a.squad_id, 'member'
  FROM agents a
 WHERE NOT EXISTS (
   SELECT 1 FROM memberships m
    WHERE m.agent_id = a.id AND m.squad_id = a.squad_id
 );
