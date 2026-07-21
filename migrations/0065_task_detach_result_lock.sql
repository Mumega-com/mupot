-- 0065_task_detach_result_lock.sql — close the detach-drops-evidence gap (#400).
--
-- validate_tasks_project_id_update (0055, narrowed in 0061) and 0059's
-- tasks_project_locked_by_receipt both gate a project_id UPDATE, but neither
-- blocks a plain detach (project_id -> NULL) off a task that already carries
-- real evidence (a non-empty `result`) when NO formal receipt (verdict /
-- workflow / dispatch) exists yet. Such a task sits in the project's evidence
-- keyset (idx_tasks_project_evidence_keyset, 0059) with no lock at all, so a
-- member of the owning squad can silently pull it off the project's evidence
-- board by detaching it.
--
-- This mirrors 0059's receipt-lock pattern but keys off OLD.result instead of
-- receipt existence, and fires ONLY on an actual detach (NEW.project_id IS
-- NULL, OLD.project_id IS NOT NULL) — a reassignment between two non-null
-- projects is untouched, and detaching an empty-result task stays legal.
--
-- Deliberately excludes any already-receipt-locked row (tasks_verdicts /
-- workflow_receipts / task_dispatch_receipts) so this does not double-fence
-- or shadow 0059's own "task project locked by flight" message for that case
-- — 0059 already owns it. This is also deliberately independent of #402 (an
-- RBAC authz check requiring manage/admin on the OLD project before detach) —
-- that is a separate, deferred decision; this trigger is a pure data-
-- integrity lock keyed on result presence, not on the actor's access level.

CREATE TRIGGER IF NOT EXISTS tasks_project_detach_locked_by_result
BEFORE UPDATE OF project_id ON tasks
WHEN NEW.project_id IS NULL
 AND OLD.project_id IS NOT NULL
 AND OLD.result IS NOT NULL
 AND length(trim(OLD.result)) > 0
 AND NOT EXISTS (SELECT 1 FROM task_verdicts WHERE task_id = OLD.id)
 AND NOT EXISTS (SELECT 1 FROM workflow_receipts WHERE task_id = OLD.id)
 AND NOT EXISTS (SELECT 1 FROM task_dispatch_receipts WHERE task_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'task detach locked by result');
END;
