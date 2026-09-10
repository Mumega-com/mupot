-- 0150_task_assignee_member.sql — a task can be owned by a HUMAN, not only an agent.
--
-- squad-core task 676ae5db, P0: "Tasks can only be assigned to AGENTS, not humans
-- — no assignee_member_id (Hadi can't own a task)."
--
-- `tasks.assignee_agent_id REFERENCES agents(id)` is the only ownership column the
-- table has ever had. Every consequence of that is structural, not cosmetic:
--
--   - The operator cannot be given work on the board he is looking at. Anything
--     that genuinely needs a human — a browser click, a credential decision, an
--     approval — has to live in prose inside some agent's task body, where no
--     query can find it and no lane surfaces it.
--   - Agents cannot hand work to each other either: an agent may not change the
--     assignee on its own in_progress task (assignee_cannot_mutate_own_assignment,
--     src/tasks/index.ts) and, on the MCP plane, may not grant capability at all
--     (mupot#1357). Every redistribution therefore terminates at a human — who
--     until now could not be named as the owner of the thing he was redistributing.
--
-- WHY A COLUMN AND NOT AN AGENT ROW FOR THE HUMAN. The cheap fix is to mint Hadi
-- an `agents` row and assign to that. It is the wrong fix. It puts one identity in
-- two homes, which is the disease squad-core task 2c6273a6 ("One home per
-- predicate — collapse the N-homes disease: presence 4, model 3, role 2, roster 2,
-- transport 2") already exists to cure. An agent row also carries a runtime, a
-- seat, a dispatch target and a wake path, none of which mean anything for a
-- person, and dispatch would then try to wake him.
--
-- WHY A TRIGGER AND NOT A TABLE-LEVEL CHECK. SQLite cannot add a table-level CHECK
-- via ALTER TABLE; expressing "exactly one of the two is set" as a constraint would
-- require rebuilding `tasks`. That rebuild is the backup-ALL / reinsert-ALL pattern
-- this repo has been bitten by before, and `tasks` is the hottest table in the pot
-- with fourteen migrations' worth of accumulated columns — a rebuild that forgets
-- one silently drops data. The trigger pair below enforces the same invariant at
-- the same layer (a write cannot get past it) without touching the existing rows.
-- This mirrors the DB-level backstop-trigger approach already used for rank checks.

ALTER TABLE tasks ADD COLUMN assignee_member_id TEXT REFERENCES members(id) ON DELETE SET NULL;

-- The invariant: AT MOST ONE owner. Both NULL is the normal unassigned state and
-- must stay legal — 25 of 40 open tasks were unassigned when this was written, and
-- a migration that made that illegal would fail on the existing table.
-- Both non-null is the state that must never exist: two owners means every reader
-- has to pick one, and different readers will pick differently.

CREATE TRIGGER IF NOT EXISTS trg_tasks_single_assignee_insert
BEFORE INSERT ON tasks
FOR EACH ROW
WHEN NEW.assignee_agent_id IS NOT NULL AND NEW.assignee_member_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'task_single_assignee: assignee_agent_id and assignee_member_id are mutually exclusive');
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_single_assignee_update
BEFORE UPDATE ON tasks
FOR EACH ROW
WHEN NEW.assignee_agent_id IS NOT NULL AND NEW.assignee_member_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'task_single_assignee: assignee_agent_id and assignee_member_id are mutually exclusive');
END;

-- "What is on my plate" is the query this column exists to make answerable, so it
-- gets the same index treatment the agent side has. Partial — the overwhelming
-- majority of rows have no member assignee and should not enter the index.
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_member
  ON tasks(assignee_member_id, status)
  WHERE assignee_member_id IS NOT NULL;
