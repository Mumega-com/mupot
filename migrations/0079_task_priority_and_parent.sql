-- 0079_task_priority_and_parent.sql — make tasks rankable and nestable.
--
-- WHY
--
-- The pot could not answer "what is next". Tasks had no priority, so ranking was encoded
-- into TITLES ("[P0] ...") — unsortable, unfilterable, and invisible to any view. And with
-- no parent link, a task with five sub-steps had to become five sibling tasks with the
-- relationship living in prose. Both gaps were found by dogfooding: the operator went to
-- GitHub Projects for ranking because mupot could not do it.
--
-- ADD COLUMN, NOT A TABLE REBUILD — deliberate.
--
-- Migration 0069 rebuilt `projects` to add a self-referential parent and hit D1's silent
-- trap: `PRAGMA foreign_keys = off` is a NO-OP inside D1's per-file transaction, so the
-- declared FK stayed enforced and aborted the migration mid-flight (v0.25 activation
-- partially applied, fixed by PR #594). SQLite permits ALTER TABLE ADD COLUMN with a
-- REFERENCES clause precisely when the default is NULL, which is the case here — so this
-- adds two columns with no rebuild, no temp table, and no rename. Nothing to half-apply.

-- Rank. NULL means UNTRIAGED, and that is a real state we want to keep visible: filling
-- every row with a default priority produces a number that looks like a decision and is
-- not. Sorting is lexical, which is why the values are P0..P3 rather than 0..3 — 'P0' < 'P1'
-- orders correctly as TEXT, and the label is the same one humans already use on the board.
ALTER TABLE tasks ADD COLUMN priority TEXT
  CHECK (priority IS NULL OR priority IN ('P0', 'P1', 'P2', 'P3'));

-- Parent link for subtasks. ON DELETE SET NULL, not CASCADE: deleting a parent must not
-- silently destroy the children's records — the same lesson as #705, where an agent row
-- turned out to own engrams and a "cleanup" delete would have destroyed memory. Orphaned
-- children surface as top-level tasks, which is recoverable; vanished children are not.
--
-- The self-parent CHECK cannot be added by ALTER TABLE ADD COLUMN (SQLite evaluates a
-- column CHECK against the added column only, and `parent_task_id <> id` references
-- another column), so the invariant is enforced by triggers below — the same shape used
-- for projects.parent_project_id in 0055.
ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;

-- A task may not be its own parent. Enforced at the write boundary rather than trusted:
-- an invariant asserted at read time and unenforced at write time is what produced the
-- duplicate-slug problem (#702) — writes succeed, reads fail later, far from the cause.
CREATE TRIGGER IF NOT EXISTS validate_tasks_parent_insert
BEFORE INSERT ON tasks
WHEN NEW.parent_task_id IS NOT NULL AND NEW.parent_task_id = NEW.id
BEGIN
  SELECT RAISE(ABORT, 'task cannot be its own parent');
END;

CREATE TRIGGER IF NOT EXISTS validate_tasks_parent_update
BEFORE UPDATE OF parent_task_id ON tasks
WHEN NEW.parent_task_id IS NOT NULL AND NEW.parent_task_id = NEW.id
BEGIN
  SELECT RAISE(ABORT, 'task cannot be its own parent');
END;

-- Ranked board reads: "the P0s on this squad's board, newest first". Priority leads the
-- index because that is the leading filter in every ranked view.
CREATE INDEX IF NOT EXISTS idx_tasks_priority_status
  ON tasks (priority, status, squad_id);

-- Subtask lookup: "the children of this task".
CREATE INDEX IF NOT EXISTS idx_tasks_parent
  ON tasks (parent_task_id) WHERE parent_task_id IS NOT NULL;
