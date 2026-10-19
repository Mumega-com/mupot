-- 0246 squad dyad_gate: opt-in "dyad" review policy for a squad.
--
-- When dyad_gate = 1 and the squad has EXACTLY two active agents, a task_create
-- with no explicit gate_owner defaults gate_owner to the creator's PEER's gate
-- (gate:<peer.slug>), but only if the peer holds a live gate_grants row for it.
-- The human is not the default code reviewer. Squads have no config JSON, so
-- this is an additive column. Default 0 = every existing squad is unchanged.
ALTER TABLE squads ADD COLUMN dyad_gate INTEGER NOT NULL DEFAULT 0 CHECK (dyad_gate IN (0, 1));
