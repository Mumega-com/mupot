-- 0033_journeys.sql — the Control Tower: a cross-project agent coordination board.
--
-- The directive (Hadi, 2026-06-19): a departures board — which agent flies to which PROJECT,
-- when, and what status — so the colony can SEE who is working on what, across projects, in time.
--
-- A `journey` is DISTINCT from `flights` (0017 — the brain's money-gated coherence dispatch).
-- A journey is LIGHT and AGENT-SELF-REGISTERED: any agent-bound token can board one (same auth
-- floor as check-in), no budget, no coherence score, no org-admin. The board renders it like an
-- airport departures board. The "project" is the DESTINATION (mupot / mumega / viamar / digid …)
-- — the cross-project dimension the per-pot flight/observatory/fleet views don't carry.
--
-- Lifecycle (status): boarding → departed → arrived ; delayed / cancelled are exceptions.
-- Identity (agent) is welded from the caller's token, NEVER read from the request body.

CREATE TABLE IF NOT EXISTS journeys (
  id           TEXT PRIMARY KEY,            -- journey id (UUID)
  tenant       TEXT NOT NULL,               -- = TENANT_SLUG, isolation
  agent        TEXT NOT NULL,               -- who flies (the welded agent)
  project      TEXT NOT NULL,               -- destination: which project the flight serves
  goal         TEXT NOT NULL DEFAULT '',    -- what the flight is doing (free text, capped)
  status       TEXT NOT NULL DEFAULT 'boarding'
               CHECK (status IN ('boarding','departed','arrived','delayed','cancelled')),
  gate         TEXT NOT NULL DEFAULT '',    -- track/gate ref: a PR url, task id, board ref
  departed_at  INTEGER,                     -- → departed (Unix ms)
  eta          INTEGER,                     -- estimated arrival (Unix ms)
  arrived_at   INTEGER,                     -- → arrived (Unix ms)
  created_at   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_journeys_tenant_status  ON journeys(tenant, status);
CREATE INDEX IF NOT EXISTS idx_journeys_tenant_created ON journeys(tenant, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_journeys_tenant_agent   ON journeys(tenant, agent);
