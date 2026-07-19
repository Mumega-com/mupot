-- 0056: scope task project-access validation to attribution changes only (#391).
--
-- 0055's validate_tasks_project_id_update fired on a wide UPDATE OF column list
-- (status, result, completed_at, …). After a squad lost write/admin on a project,
-- in-flight status transitions aborted with "task project access denied" and left
-- tasks stuck. Access must be re-checked only when project_id or squad_id changes.

DROP TRIGGER IF EXISTS validate_tasks_project_id_update;

CREATE TRIGGER validate_tasks_project_id_update
BEFORE UPDATE OF
  squad_id,
  project_id
ON tasks
BEGIN
  SELECT RAISE(ABORT, 'task project locked by flight')
  WHERE OLD.project_id IS NOT NEW.project_id
    AND EXISTS (
      SELECT 1
      FROM flights AS flight,
           json_each(CASE WHEN json_valid(flight.meta) THEN flight.meta ELSE '{}' END, '$.task_ids') AS task_ref
      WHERE flight.project_id IS NOT NULL
        AND json_extract(CASE WHEN json_valid(flight.meta) THEN flight.meta ELSE '{}' END, '$.schema') = 'mupot.flight.meta/v1'
        AND task_ref.value = OLD.id
    );
  SELECT RAISE(ABORT, 'task project not found')
    WHERE NEW.project_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id);
  SELECT RAISE(ABORT, 'task project archived')
    WHERE NEW.project_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND status = 'archived');
  SELECT RAISE(ABORT, 'task project access denied')
  WHERE NEW.project_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM project_squad_access
      WHERE project_id = NEW.project_id
        AND squad_id = NEW.squad_id
        AND access_level IN ('write', 'admin')
    );
END;
