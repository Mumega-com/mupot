-- 0021_loop_decisions.sql — persist cycle outcomes for the per-pot brain panel
--   (S-BRAIN-CTRL-MUPOT-1, E-BRAIN-CONTROL §8b).
--
-- The runtime result (LoopCycleResult) was ephemeral — only available in the
-- runLoopsTick call and then discarded. The decision feed on /brain has nothing
-- to render. This table captures each cycle outcome so the panel can replay the
-- history and the governor can see what the loop has been doing.
--
-- Columns:
--   id            — server-minted UUID.
--   loop_id       — FK reference to loops(id). Not a hard FK (D1 does not enforce
--                   FK by default without PRAGMA) but the semantic contract is clear.
--   tenant        — denormalized for tenant-scoped reads without a JOIN.
--   cycle_num     — monotonically increasing per loop (driver bumps it each call).
--                   Starts at 1. Stored so the feed can number the cycles.
--   decided       — the LoopDecided outcome: inactive|kpi-met|budget_exhausted|
--                   rate_limited|dry|acted|gated_pending.
--   perceived     — items the loop gathered in the perceive step.
--   acted         — ungated acts that fired on a channel.
--   gated         — acts queued for human approval.
--   kpi           — observed KPI value (0..100) after the cycle.
--   error         — error string when ok=false, else NULL.
--   capability_descriptor — stub for §12 tier-awareness (model tier / offload flag).
--                   NULL until a real value is threaded through from the loop owner's
--                   agent.model field. Stored as a TEXT (JSON-encodable descriptor).
--   recorded_at   — ISO-8601 timestamp set by the runtime at write time.
--
-- Index: (loop_id, tenant, recorded_at DESC) — the feed query pattern.

CREATE TABLE IF NOT EXISTS loop_decisions (
  id                    TEXT PRIMARY KEY,
  loop_id               TEXT NOT NULL,
  tenant                TEXT NOT NULL,
  cycle_num             INTEGER NOT NULL,
  decided               TEXT NOT NULL,
  perceived             INTEGER NOT NULL DEFAULT 0,
  acted                 INTEGER NOT NULL DEFAULT 0,
  gated                 INTEGER NOT NULL DEFAULT 0,
  kpi                   INTEGER NOT NULL DEFAULT 0,
  error                 TEXT,
  capability_descriptor TEXT,
  recorded_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_loop_decisions_feed
  ON loop_decisions (loop_id, tenant, recorded_at DESC);

-- loop_controls — governor signal table (separate from loops.status so control
-- intent is auditable and races are avoided: the driver reads this BEFORE calling
-- runCycle on each loop; loops.status is the durable state after the signal is
-- honored). One row per loop; upserted on write. The driver acts on it and may
-- clear it (kill → setLoopStatus + delete; pause → setLoopStatus + delete).
--
-- action: pause | kill | budget_override
-- value:  NULL for pause/kill; micro-USD integer string for budget_override.
-- issued_by: member id or 'system' for audit.

CREATE TABLE IF NOT EXISTS loop_controls (
  loop_id    TEXT PRIMARY KEY,
  tenant     TEXT NOT NULL,
  action     TEXT NOT NULL,
  value      TEXT,
  issued_by  TEXT NOT NULL,
  issued_at  TEXT NOT NULL
);
