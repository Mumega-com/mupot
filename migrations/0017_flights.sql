-- 0017_flights.sql — the flight record (Flight #61/#62, the dispatch spine).
--
-- A flight = one bounded run of an (expensive) agent toward a goal. The record's
-- shape follows the proven dispatch spine (CF Workflows instance + Temporal run +
-- the KAIJU pre-run gate), trimmed to what mupot needs and named in plain mupot
-- language so a small model reading it isn't confused. See docs/flight-operations.md.
--
-- Lifecycle (status): preflight → held (NO-GO) | running → waiting (human gate) |
-- sleeping (between flights, wakes at next_run_at) → landed | failed.
-- (terminated/cancelled/continued-as-new are deferred — fold into status later.)

CREATE TABLE IF NOT EXISTS flights (
  id              TEXT PRIMARY KEY,            -- this run's id (UUID)
  tenant          TEXT NOT NULL,
  agent           TEXT NOT NULL,               -- who flies
  goal            TEXT NOT NULL,               -- the objective
  status          TEXT NOT NULL DEFAULT 'preflight'
                  CHECK (status IN ('preflight','held','running','waiting','sleeping','landed','failed')),
  trigger_source  TEXT NOT NULL DEFAULT 'manual'
                  CHECK (trigger_source IN ('manual','schedule','api','event','cron')),
  -- the preflight gate (#60) outcome
  gate_verdict    TEXT,                        -- 'go' | 'no_go' | NULL (pending)
  gate_reason     TEXT NOT NULL DEFAULT '',    -- comma-joined reasons when held
  score           REAL,                        -- coherence score 0..1 (preflight; or evaluator at land)
  -- cost / budget (micro-USD, matches the execution meter)
  budget_micro_usd  INTEGER,                   -- pre-declared budget for the flight
  cost_micro_usd    INTEGER NOT NULL DEFAULT 0,-- actual, updated on land
  -- scheduling
  next_run_at     INTEGER,                     -- if sleeping: wake-at (Unix ms)
  -- timestamps (Unix ms)
  created_at      INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  started_at      INTEGER,                     -- → running
  ended_at        INTEGER,                     -- → landed/failed/held
  meta            TEXT NOT NULL DEFAULT '{}'   -- JSON: chain_id, parent, version, extras (future)
);

CREATE INDEX IF NOT EXISTS idx_flights_tenant_status  ON flights(tenant, status);
CREATE INDEX IF NOT EXISTS idx_flights_tenant_created ON flights(tenant, created_at DESC);
