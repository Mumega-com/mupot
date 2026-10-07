-- 0196_harness_capacity_snapshots.sql — mupot#1765 (epic #1590): read-only harness capacity.
--
-- ONE latest row per (tenant, harness, host_key, reporter_agent_id), upserted by the
-- harness_capacity_report MCP tool. COUNTS ONLY: no terminal text, titles, paths or branch
-- names ever land here. Distinct from runner_receipts (0105), which is per-run history.
-- A snapshot older than the freshness window is UNKNOWN load, never zero (enforced at read).

CREATE TABLE IF NOT EXISTS harness_capacity_snapshots (
  id                       TEXT PRIMARY KEY,
  tenant                   TEXT NOT NULL,
  harness                  TEXT NOT NULL CHECK (harness IN ('orca', 'herdr')),
  host_key                 TEXT NOT NULL CHECK (length(host_key) BETWEEN 1 AND 48),
  reporter_agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  observed_at              INTEGER NOT NULL CHECK (observed_at >= 0),
  received_at              INTEGER NOT NULL CHECK (received_at >= 0),
  live_terminals           INTEGER NOT NULL CHECK (live_terminals >= 0),
  agent_sessions           INTEGER NOT NULL CHECK (agent_sessions >= 0),
  busy_recent              INTEGER NOT NULL CHECK (busy_recent >= 0),
  orphaned_terminals       INTEGER NOT NULL CHECK (orphaned_terminals >= 0),
  workers_active           INTEGER NOT NULL CHECK (workers_active >= 0),
  workers_release_unknown  INTEGER NOT NULL CHECK (workers_release_unknown >= 0),
  worktrees_with_live      INTEGER NOT NULL CHECK (worktrees_with_live >= 0),
  max_agents               INTEGER CHECK (max_agents IS NULL OR max_agents >= 0),
  summary_json             TEXT NOT NULL DEFAULT '{}' CHECK (length(summary_json) <= 4096)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_harness_capacity_latest
  ON harness_capacity_snapshots(tenant, harness, host_key, reporter_agent_id);

CREATE INDEX IF NOT EXISTS idx_harness_capacity_received
  ON harness_capacity_snapshots(tenant, received_at DESC);
