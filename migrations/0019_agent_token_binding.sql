-- 0019_agent_token_binding.sql — weld the member plane to the agent plane.
--
-- Until now members (token principals) and agents (org/work units) were two
-- disconnected identity systems: a token resolved to a MEMBER, never to an AGENT,
-- so orient/presence/attribution had to guess "which agent is this" by name-matching.
--
-- The weld: a member-token may be BOUND to an agent. null agent_id = a human/operator
-- principal (unchanged); a set agent_id = an agent-scoped token whose holder IS that
-- agent. Then the agent's identity is implicit when it calls — orient defaults to it,
-- presence records it, actions attribute to it. Capability is unchanged (still
-- token→member→capabilities); agent_id is the IDENTITY binding only.
--
-- D1 ALTER cannot add a FK constraint; agent_id references agents(id) by convention.

ALTER TABLE member_tokens ADD COLUMN agent_id TEXT;   -- bound agent (agents.id), or NULL = principal

-- Presence records the bound agent when the checking-in token is agent-scoped, so the
-- Fleet shows the real agent instead of matching presence rows to agents by name.
ALTER TABLE presence ADD COLUMN agent_id TEXT;        -- bound agent (agents.id), or NULL
