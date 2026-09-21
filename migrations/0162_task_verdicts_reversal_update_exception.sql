-- 0162_task_verdicts_reversal_update_exception.sql — widen task_verdicts'
-- append-only UPDATE trigger to admit the ONE new exception
-- markVerdictReversed needs (FP-01 Slice 2 v2, successor to PR #1488, P0-2
-- reversal semantics). NOT applied by this build — branch/schema only,
-- exactly like 0143/.../0161 before it; a human applies it.
--
-- THE BUG THIS CLOSES
--
-- task_verdicts_no_update (migrations/0069_project_structural_completion.sql)
-- allows exactly ONE exception: a one-time project_id backfill migration
-- write, gated on `OLD.project_id IS NULL` — true only for the specific
-- pre-migration rows 0069 itself repaired. For every row created since
-- (project_id already backfilled, non-NULL), that allow-condition is
-- unconditionally false, so the trigger's `NOT (...)` is true and ANY
-- UPDATE — including src/tasks/service.ts's NEW markVerdictReversed, which
-- sets ONLY reversed_at from NULL to a timestamp — raises ABORT. Proven
-- live: task_verdict_reverse's own MCP tool call fails with a bare
-- internal_error (the underlying SQLite constraint violation is caught and
-- generalized by the MCP error-leak guard, src/mcp/index.ts) the moment it
-- tries to mark a reversed verdict.
--
-- FIX
--
-- Replace the trigger with one that admits TWO allow-shapes:
--   1. The 0069 historical one-time backfill (`OLD.project_id IS NULL`,
--      NEW.project_id changing) — kept verbatim; it is inert on any row
--      that already has a non-NULL project_id (i.e. every row created after
--      0069 ran), so keeping it costs nothing and preserves 0069's own
--      documented intent for anyone re-reading its history.
--   2. The reversal exception: `OLD.reversed_at IS NULL AND NEW.reversed_at
--      IS NOT NULL`, with EVERY OTHER COLUMN — including the columns 0155
--      added (decided_via, origin_agent_id) and 0159 added (proposal_id) —
--      required to stay byte-identical. A verdict can be reversed exactly
--      once (reversed_at moves NULL -> a value and never again — a SECOND
--      UPDATE attempt has `OLD.reversed_at IS NOT NULL`, so it fails BOTH
--      allow-shapes and is correctly refused).

DROP TRIGGER IF EXISTS task_verdicts_no_update;

CREATE TRIGGER task_verdicts_no_update
BEFORE UPDATE ON task_verdicts
WHEN NOT (
  -- Shape 1: 0069's historical one-time project_id backfill (inert on
  -- every row created after that migration ran; kept verbatim).
  (
    OLD.project_id IS NULL
    AND NEW.project_id IS (SELECT project_id FROM tasks WHERE id = OLD.task_id)
    AND NEW.id IS OLD.id
    AND NEW.task_id IS OLD.task_id
    AND NEW.verdict IS OLD.verdict
    AND NEW.note IS OLD.note
    AND NEW.decided_by IS OLD.decided_by
    AND NEW.decided_at IS OLD.decided_at
  )
  OR
  -- Shape 2: markVerdictReversed's ONE-TIME reversed_at stamp.
  (
    OLD.reversed_at IS NULL
    AND NEW.reversed_at IS NOT NULL
    AND NEW.id IS OLD.id
    AND NEW.task_id IS OLD.task_id
    AND NEW.verdict IS OLD.verdict
    AND NEW.note IS OLD.note
    AND NEW.decided_by IS OLD.decided_by
    AND NEW.decided_at IS OLD.decided_at
    AND NEW.decided_via IS OLD.decided_via
    AND NEW.origin_agent_id IS OLD.origin_agent_id
    AND NEW.proposal_id IS OLD.proposal_id
    AND NEW.project_id IS OLD.project_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'verdicts are append-only: UPDATE is forbidden');
END;
