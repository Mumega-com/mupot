-- 0251 wake-on-assign ledger: one row per (task, agent, assignment epoch) that asked for an inbox doorbell.
--
-- Hadi 2026-10-22: mupot assigns work but never wakes the assignee. A plain inbox message DOES wake a seated agent
-- (seatlink, the orca-mupot plugin, the webhook doorbell), so every assignment to an AGENT now enqueues one short
-- doorbell message (src/agents/assignment-wake.ts). This table is the idempotency key, the throttle ledger and the
-- visible record of what happened to each doorbell. The authority stays in the task; this row carries none.
--
--   epoch        the assignment occurrence (the task's updated_at stamp at the assigning write, or a router/concierge
--                stamp). A retry of the SAME assignment replays the same key and sends nothing; a reassign A->B->A is a
--                new epoch and rings again.
--   outcome      pending     claimed, send in flight (re-claimable once stale: a crash between claim and send)
--                sent        the doorbell message was written to the agent's inbox (message_seq)
--                coalesced   over the per-agent burst cap: held for ONE summary message ("you have K new assignments")
--                summarized  announced by that summary (summary_request_id)
--                skipped     agent paused / inactive / archived, or the task is gone (reason)
--                failed      the doorbell could not be written (reason). The assignment itself is untouched.
--   Only sent / coalesced / summarized are terminal; a replay re-evaluates pending(stale) / skipped / failed.
--
-- Additive: a new table and indexes, no existing object changes.
CREATE TABLE IF NOT EXISTS task_assignment_wakes (
  id                  TEXT PRIMARY KEY,
  tenant              TEXT NOT NULL,
  task_id             TEXT NOT NULL,
  agent_id            TEXT NOT NULL,
  epoch               TEXT NOT NULL,
  outcome             TEXT NOT NULL DEFAULT 'pending'
                      CHECK (outcome IN ('pending', 'sent', 'coalesced', 'summarized', 'skipped', 'failed')),
  reason              TEXT,
  message_seq         INTEGER,
  summary_request_id  TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (tenant, task_id, agent_id, epoch)
);
CREATE INDEX IF NOT EXISTS idx_task_assignment_wakes_agent
  ON task_assignment_wakes(tenant, agent_id, outcome, created_at);
CREATE INDEX IF NOT EXISTS idx_task_assignment_wakes_task
  ON task_assignment_wakes(tenant, task_id);
