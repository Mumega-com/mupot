-- 0105_runner_receipts.sql — Flight-004 TENTACLES: Seat Fan-Out as First-Class Records
--
-- Records bounded subagent / runner runs spawned by seats (e.g. gate verifiers,
-- secret rotations, inventories, cleanups).
--
-- Each tentacle: runner_id, seat, name, task, status (running/landed/failed),
-- started_at, ended_at, evidence_summary, verdict_line, log_url.

CREATE TABLE IF NOT EXISTS runner_receipts (
  id                TEXT PRIMARY KEY,
  tenant            TEXT NOT NULL,
  seat_agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  squad_id          TEXT REFERENCES squads(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  task              TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('running', 'landed', 'failed')),
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  evidence_summary  TEXT,
  verdict_line      TEXT,
  log_url           TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runner_receipts_seat_created
  ON runner_receipts(tenant, seat_agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_runner_receipts_squad_created
  ON runner_receipts(tenant, squad_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_runner_receipts_status
  ON runner_receipts(tenant, status, created_at DESC);
