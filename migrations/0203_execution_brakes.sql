-- 0203_execution_brakes.sql — "agents as themselves" step 1: LOOP BRAKES (incident 2026-10-09,
-- mupot#1780: a bulk router_tick assigned 24 tasks, the queued agent.wake messages could not be
-- recalled, and the in-Worker executor re-claimed refused tasks for 89 executions).
--
-- Additive; nothing existing references these tables. APPLY THIS MIGRATION BEFORE the code deploy
-- (the executor claim UPDATE, the consumer and AgentDO read these tables).
--
-- 1. execution_pauses — the kill switch for IN-WORKER autonomous execution (one agent or one squad).
--    ACTIVE while resumed_at IS NULL; the partial unique index makes pause an idempotent
--    INSERT ... ON CONFLICT DO NOTHING. The row is the receipt for pause AND resume; the tools also
--    append an audit row anchored on the transition.
--
-- 2. task_execution_attempts — per-TASK refusal counter (all agents, all dispatches). One atomic
--    INSERT ... ON CONFLICT DO UPDATE ... RETURNING bumps it. Nothing resets it implicitly: a column
--    change (assignee, status) or a re-dispatch must NOT re-arm the brake, because any actor that can
--    write the assignee (an agent, a seat, the executor's own claim, an operator unassign) would
--    otherwise re-arm the loop. Only a HUMAN, in code where the caller is known, resets it
--    (execution_release / a human task_update that assigns).
--
-- 3. execution_holds — the escalation HOLD, per TASK. Once the counter reaches the ceiling a row is
--    stamped and the task is out of executor pickup for EVERY agent until a human releases it
--    (released_at set by execution_release / human reassign). The claim UPDATE (both branches) and the
--    executor's WORKABLE pickup refuse a task with an unreleased hold. One row per task: a re-escalation
--    after release rewrites the row; the history lives in mutation_audit_entries.

CREATE TABLE IF NOT EXISTS execution_pauses (
  id                   TEXT PRIMARY KEY,
  tenant               TEXT NOT NULL,
  scope_type           TEXT NOT NULL CHECK (scope_type IN ('agent', 'squad')),
  scope_id             TEXT NOT NULL CHECK (length(trim(scope_id)) > 0),
  reason               TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2000),
  paused_by_member_id  TEXT NOT NULL CHECK (length(trim(paused_by_member_id)) > 0),
  paused_at            TEXT NOT NULL,
  resumed_at           TEXT,
  resumed_by_member_id TEXT,
  resume_reason        TEXT CHECK (resume_reason IS NULL OR length(trim(resume_reason)) BETWEEN 1 AND 2000),
  CHECK ((resumed_at IS NULL) = (resumed_by_member_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_execution_pauses_active
  ON execution_pauses (scope_type, scope_id)
  WHERE resumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_execution_pauses_scope
  ON execution_pauses (scope_type, scope_id, paused_at);

CREATE TABLE IF NOT EXISTS task_execution_attempts (
  task_id       TEXT PRIMARY KEY,
  refused_count INTEGER NOT NULL DEFAULT 0 CHECK (refused_count >= 0),
  last_agent_id TEXT,
  last_reason   TEXT,
  first_at      TEXT NOT NULL,
  last_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_holds (
  task_id                TEXT PRIMARY KEY,
  escalation_id          TEXT NOT NULL,
  agent_id               TEXT NOT NULL,
  refused_count          INTEGER NOT NULL,
  reason                 TEXT,
  held_at                TEXT NOT NULL,
  released_at            TEXT,
  released_by_member_id  TEXT,
  release_id             TEXT,
  release_reason         TEXT CHECK (release_reason IS NULL OR length(trim(release_reason)) BETWEEN 1 AND 2000),
  CHECK ((released_at IS NULL) = (released_by_member_id IS NULL))
);
