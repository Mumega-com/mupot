-- 0251 wake-on-assign ledger: one row per (task, agent, assignment epoch) that asked for an inbox doorbell.
--
-- Hadi 2026-10-22: mupot assigns work but never wakes the assignee. A plain inbox message DOES wake a seated agent
-- (seatlink, the orca-mupot plugin, the webhook doorbell), so every assignment to an AGENT now enqueues one short
-- doorbell (src/agents/assignment-wake.ts). The assigning request pays ONE conditional INSERT into this table; the
-- send happens off the request path (an `assignment.wake` bus job, with a cron sweep as the backstop).
-- The table is the idempotency key, the burst-cap ledger and the visible record of what happened to each doorbell.
-- The authority stays in the task; this row carries none.
--
--   epoch        the assignment occurrence (the task's updated_at stamp at the assigning write, or a router/concierge
--                stamp). A retry of the SAME assignment replays the same key and does nothing; a reassign A->B->A is a
--                new epoch and rings again.
--   outcome      queued      accepted, waiting for the off-path worker (counts toward the per-agent burst cap)
--                coalesced   held: over the burst cap, or the agent is paused. Delivered later in ONE summary
--                pending     claimed by a worker (claim_token), send in flight; re-claimable once stale
--                sent        delivered (message_seq = the inbox row it rode in; reason 'folded' = it joined the agent's
--                            still-unread doorbell instead of adding another row)
--                summarized  a duplicate of a newer assignment of the same task, folded into that one
--                skipped     not delivered, and will not be (reason: agent gone / inactive / archived / no inbox
--                            reader / task moved on / dispatch letter already sent / self-assignment)
--                failed      the doorbell could not be written (reason). The sweep retries it up to 3 attempts.
--   claim_token  fences every outcome write of a worker: a stale worker cannot overwrite a newer claim.
--   attempts     failed sends + crashed (stale pending) claims; the sweep stops at the ceiling.
--   assigned_by  'member:<id>' | 'agent:<id>' | 'system:<name>' when known; shown in the doorbell.
--
-- Terminal rows (sent / skipped / summarized, and exhausted failed) are pruned after 7 days by the sweep.
-- Additive: a new table and indexes, no existing object changes.
CREATE TABLE IF NOT EXISTS task_assignment_wakes (
  id           TEXT PRIMARY KEY,
  tenant       TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  epoch        TEXT NOT NULL,
  outcome      TEXT NOT NULL DEFAULT 'queued'
               CHECK (outcome IN ('queued', 'coalesced', 'pending', 'sent', 'summarized', 'skipped', 'failed')),
  reason       TEXT,
  message_seq  INTEGER,
  claim_token  TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  assigned_by  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (tenant, task_id, agent_id, epoch)
);
-- the burst-cap window count and the per-agent claim
CREATE INDEX IF NOT EXISTS idx_task_assignment_wakes_agent
  ON task_assignment_wakes(tenant, agent_id, outcome, created_at);
-- the sweep's "which agents have undelivered rows, oldest first" scan (GROUP BY agent_id) and the retention prune
CREATE INDEX IF NOT EXISTS idx_task_assignment_wakes_sweep
  ON task_assignment_wakes(tenant, outcome, agent_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_task_assignment_wakes_task
  ON task_assignment_wakes(tenant, task_id);
