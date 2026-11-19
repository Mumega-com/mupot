-- 0273: one additive table. It alters no existing table and is not read by routing, liveness or assignment.
--
-- agent_reported_runtime: what an ATTACHED chat says it is running (harness, machine, model, ...), one row per
-- attachment. It is a self-reported fact, kept apart from `presence` on purpose: presence rows keyed to an agent
-- feed liveness and assignment (an attached chat is not the agent's host), and a caller-typed seat label must
-- never be able to write another agent's runtime. Read only by peers (as a per-attachment, self-reported list, never as live_model) and by the onboarding report_runtime step.
CREATE TABLE IF NOT EXISTS agent_reported_runtime (
  tenant                TEXT NOT NULL,
  agent_id              TEXT NOT NULL,
  attachment_id         TEXT NOT NULL,
  reported_by_member_id TEXT NOT NULL,
  harness               TEXT,
  machine               TEXT,
  model                 TEXT,
  provider              TEXT,
  effort                TEXT,
  first_reported_at     TEXT NOT NULL DEFAULT (datetime('now')),
  reported_at           TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant, agent_id, attachment_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_reported_runtime_agent ON agent_reported_runtime(tenant, agent_id, reported_at DESC);
