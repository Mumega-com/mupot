-- 0068_agent_profile.sql — Port 1.3 agent profile (the missing definition).
--
-- Today a mupot agent is a bare row (id, squad, slug, name, role, model, status +
-- work-unit fields) — no purpose, no owner, no placement tree, no lifecycle policy,
-- no identity lineage. That gap directly caused the 2026-07-21 3-hermes sprawl
-- (agent-hermes + kayhermes + hadi-hermes — distinct ROLES, indistinguishable as
-- rows) and a bad dedup (two distinct agents retired as "duplicates"). See
-- docs/architecture/mupot-agent-identity-memory-lifecycle.md §2.2.
--
-- This adds the profile as NULLABLE columns via plain ADD COLUMN — the established
-- pattern in 0009_work_unit.sql. NO table recreate: unlike 0049 (which widened a
-- CHECK constraint and had to rebuild the whole parent table, tripping FK CASCADE),
-- nothing here touches a constraint. SQLite ADD COLUMN with a NULL default is a
-- pure schema op — no data rewrite, no CASCADE surface, every existing row keeps a
-- NULL profile (fully backward compatible; pre-profile agents just read null).
--
-- parent_agent_id is deliberately NOT a formal FK. A self-referencing FK would make
-- `agents` reference itself, and any future table-recreate of agents (cf. 0049)
-- would fire ON DELETE CASCADE/SET NULL against itself under D1's in-transaction FK
-- semantics — the exact class 0049 had to hand-back-up around. It is validated at
-- write time in code (createAgent checks the parent exists) and read as a soft edge.
--
--   purpose          the WHY — one line on what this agent is for
--   owner            member id / human handle responsible for it
--   model_fallback   secondary model when the preferred (model) is unavailable
--   capabilities     JSON array of capability tags, e.g. ["build","review"]
--   skills           JSON array of skill names the agent runs
--   parent_agent_id  runtime parentage (who spawned it) — the placement tree; soft ref
--   qnft_ref         identity lineage pointer (who minted whom) — immutable WHO
--   death_condition  JSON lifecycle policy, e.g.
--                    {"idle_ttl_hours":168,"policy":"no_instance_no_activity"}.
--                    STORED here; enforcement (the sweep) lands in a later leg — a
--                    null policy means "never auto-retire" (today's behavior).

ALTER TABLE agents ADD COLUMN purpose          TEXT;
ALTER TABLE agents ADD COLUMN owner            TEXT;
ALTER TABLE agents ADD COLUMN model_fallback   TEXT;
ALTER TABLE agents ADD COLUMN capabilities     TEXT;
ALTER TABLE agents ADD COLUMN skills           TEXT;
ALTER TABLE agents ADD COLUMN parent_agent_id  TEXT;
ALTER TABLE agents ADD COLUMN qnft_ref         TEXT;
ALTER TABLE agents ADD COLUMN death_condition  TEXT;

-- The placement tree reads children-of-parent; index the soft edge.
CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_agent_id);
