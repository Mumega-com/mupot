-- 0087_drop_home_capability_ceiling.sql
-- Hadi directive 2026-08-09: remove the home_capability_ceiling rule.
--
-- The ceiling (added in 0071) forbids granting lead/admin to a bound agent in
-- its OWN home squad/org/department scope. Net effect: no bound agent can ever
-- hold admin, routine_create (which requires admin) is impossible for any
-- agent, schedule-route flights cannot dispatch, and the authority map is
-- permanently single-threaded (admin token exists but is unbound).
--
-- This migration drops the five triggers that enforce the ceiling. The
-- application-layer checks are removed in the same change
-- (src/members/agent-access.ts, src/members/service.ts).
--
-- The triggers below are the ONLY enforcement; dropping them is the removal.

DROP TRIGGER IF EXISTS agent_member_bindings_home_capability_ceiling;
DROP TRIGGER IF EXISTS agent_home_capability_ceiling_insert;
DROP TRIGGER IF EXISTS agent_home_capability_ceiling_update;
DROP TRIGGER IF EXISTS agents_home_capability_ceiling_update;
DROP TRIGGER IF EXISTS squads_home_capability_ceiling_update;
