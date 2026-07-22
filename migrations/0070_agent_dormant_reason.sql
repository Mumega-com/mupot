-- 0070_agent_dormant_reason.sql — credit/provider dormancy flag (fleet lifecycle).
--
-- Soft-retire (death_condition idle TTL) already lands on agents.status='inactive'
-- (0049). Credit-out / provider-down need a DIFFERENT, reversible sleep that keeps
-- identity + memory + keys intact and reactivates cleanly — Devin-style
-- sleep/archive/wake, mapped onto the agent(persistent)/instance(ephemeral) split
-- (docs/architecture/mupot-agent-identity-memory-lifecycle.md §2.4 + competitive scan).
--
-- We do NOT widen the status CHECK here (that requires a parent-table recreate and
-- FK CASCADE backup — 0049's cost). Instead:
--   - soft-retire → status='inactive' (existing)
--   - credit/provider sleep → status='paused' + dormant_reason set
--   - manual pause → status='paused' + dormant_reason IS NULL
-- Reactivation clears dormant_reason and restores status='active'.
--
-- dormant_reason values (enforced in code, not CHECK): 'credit_out' | 'provider_down'.

ALTER TABLE agents ADD COLUMN dormant_reason TEXT;
