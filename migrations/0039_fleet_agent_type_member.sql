-- 0039_fleet_agent_type_member.sql — extend fleet_agents with agent_type + member_id.
-- Part of "agent running on mupot" Step 1: unified registry↔identity join.
--
-- agent_type: builder|reviewer|weaver|brain|comms|generic (free text, server-validated).
--   Captures what KIND of agent this is — the identity role, not the execution runtime.
--   Defaults 'generic' so all existing rows are valid immediately on apply.
--
-- member_id: links the runtime row to its mupot identity (members.id). Nullable TEXT —
--   SQLite ALTER does not support ADD COLUMN ... REFERENCES (no hard FK via ALTER);
--   the application layer (registry.ts) validates existence on write. Relation:
--   fleet_agents.member_id → members(id), enforced in reportFleetAgents.
--
-- Single-apply migration — SQLite does not support IF NOT EXISTS on ADD COLUMN.
-- Apply exactly once per DB instance.

ALTER TABLE fleet_agents ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'generic';
ALTER TABLE fleet_agents ADD COLUMN member_id TEXT;
