-- 0068_project_cycle_boundary.sql — project lifecycle circuit-breaker columns (slice 1).
--
-- Design: docs/superpowers/specs/2026-07-23-project-lifecycle-control-loop-design.md
--
-- At a cycle/phase boundary, unfinished work does not silently continue (Shape Up
-- inversion). These columns schedule the boundary and hold stall detector state
-- (detector itself is slice 4 — columns land here so the breaker can read them
-- without a later schema fork).
--
-- cycle_boundary_at: next ISO-8601 instant at which the breaker evaluates.
-- stalled: 0/1 flag raised by the stall detector (does not auto-kill by itself).
-- stall_threshold_days: per-project idle threshold; NULL = tenant default.

ALTER TABLE projects ADD COLUMN cycle_boundary_at TEXT;
ALTER TABLE projects ADD COLUMN stalled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN stall_threshold_days INTEGER;

CREATE INDEX IF NOT EXISTS idx_projects_cycle_boundary
  ON projects (cycle_boundary_at)
  WHERE cycle_boundary_at IS NOT NULL AND status NOT IN ('completed', 'archived');
