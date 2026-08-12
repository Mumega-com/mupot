-- 0092_bootstrap_self_audit_once.sql — per-member idempotency guard for
-- bootstrap_self (mupot#925), enforced at the DB layer, not just app-level.
--
-- bootstrap_self (src/members/bootstrap-self.ts) writes exactly one agent_audit
-- row per human member who ever uses it — action='bootstrap_self',
-- actor_type='user', actor_id = the CONSENTING MEMBER's id (the human who named
-- the agent; naming is the witness act, see River's ruling condition 1). A
-- second connection for the SAME human (a re-login, a second harness — a new
-- member_tokens row, same members row) must not mint a second agent: "idempotent
-- once PER MEMBER, not per token."
--
-- An app-level SELECT-then-INSERT check has a race window between two
-- concurrent first-time calls for the same member. This partial UNIQUE index
-- closes it atomically at the database: the SECOND INSERT for the same
-- actor_id with action='bootstrap_self' throws 'UNIQUE constraint failed',
-- which bootstrap_self catches and compensates the (rare, race-only) loser's
-- just-created department/squad/agent/token against, reporting
-- 'already_bootstrapped' instead of leaving a duplicate identity live.
--
-- Partial (WHERE action = 'bootstrap_self') because agent_audit is shared with
-- update_agent's 'update_agent' action rows (migration 0086), which legitimately
-- repeat the same actor_id many times as an admin corrects a profile — a bare
-- UNIQUE(actor_id) would break that path entirely. Only the bootstrap_self
-- action is constrained to one row per actor.

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_audit_bootstrap_self_once
  ON agent_audit(actor_id)
  WHERE action = 'bootstrap_self';
