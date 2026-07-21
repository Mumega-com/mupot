-- 0067_concierge_starter_unique.sql -- close the concierge dispatch-once-ever TOCTOU
-- (adversarial gate on PR #459, per-project concierge, src/concierge/service.ts).
--
-- P0 (BLOCK) this backs: the pre-fix dedup only checked LIVE task statuses
-- (open/in_progress/review/blocked). Once a dispatched "Starter: <project>" task left
-- that set (approved, rejected, or done) while the project's `goal` text was still set,
-- the concierge re-dispatched a byte-identical starter EVERY 15-min cron tick forever --
-- an unbounded act-loop the design doc explicitly forbids ("rank, never act-loop"). The
-- app-layer fix (src/concierge/service.ts) is dispatch-once-ever: before dispatching, it
-- checks for a prior concierge-originated task for the project in ANY status (the task's
-- body carries the CONCIERGE_STARTER_MARKER sentinel) -- not just the "live" subset.
--
-- P1 this backs: that app-layer check-then-create has no transactional guard on its own --
-- two overlapping cron ticks for the same project could both read "no starter yet" and
-- both create one. This partial UNIQUE index is the real backstop: at most ONE task per
-- project_id may ever carry the concierge-starter marker in its body, enforced by
-- SQLite/D1 itself, not just application logic. A second concurrent INSERT racing the
-- same project fails this constraint instead of landing a duplicate row;
-- src/concierge/service.ts catches that specific violation and treats it as "someone
-- else already dispatched this tick" (reason: 'already_dispatched'), never surfacing as
-- a tick error.
--
-- instr(body, '...') > 0 mirrors the existing precedent for function-expression partial
-- indexes on this table -- see idx_tasks_project_evidence_keyset (migration 0059), which
-- filters on length(trim(result)) > 0.
--
-- The marker string below MUST stay byte-identical to CONCIERGE_STARTER_MARKER in
-- src/concierge/service.ts -- it is not read from that file, it is duplicated here
-- deliberately (migrations are frozen history; the exported constant is the source of
-- truth for new code, this literal is what the constraint enforces at the row it was
-- written against).

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_concierge_starter_once
  ON tasks (project_id)
  WHERE project_id IS NOT NULL AND instr(body, '[concierge-starter]') > 0;
