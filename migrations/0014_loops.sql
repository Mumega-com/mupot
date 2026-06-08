-- 0014_loops.sql — the Loop Container's declarative resource (P1, #32).
--
-- A loop is stored as flat identity/lifecycle columns + the validated LoopSpec as
-- JSON (`spec`). Queryable fields (tenant, status, owner) are columns; the rich
-- shape (kpi/sources/channels/gate/budget/cadence/stop) lives in spec JSON and is
-- re-validated on read. Tenant is a column on every row; all reads are tenant-scoped.

CREATE TABLE IF NOT EXISTS loops (
  id         TEXT PRIMARY KEY,
  tenant     TEXT NOT NULL,
  squad_id   TEXT,                       -- exactly one of squad_id / agent_id is set
  agent_id   TEXT,
  status     TEXT NOT NULL DEFAULT 'active',  -- active | paused | done | killed
  spec       TEXT NOT NULL,              -- JSON-serialized LoopSpec
  dry_rounds INTEGER NOT NULL DEFAULT 0, -- consecutive empty ticks (stop.dry_rounds_max)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_loops_tenant_status ON loops (tenant, status);
CREATE INDEX IF NOT EXISTS idx_loops_agent ON loops (agent_id);
CREATE INDEX IF NOT EXISTS idx_loops_squad ON loops (squad_id);
