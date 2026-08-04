-- 0078: blank provenance cannot exist.
--
-- WHY THIS IS A DATABASE CONSTRAINT AND NOT ONLY A VALIDATION
--
-- migrations/0077 defined the trust boundary as `external_source IS NULL` versus
-- `IS NOT NULL`. Every runtime check spelled that boundary with JavaScript truthiness
-- instead — `externalSource ? ... : ...`, `task.source_pot || task.external_source`.
-- Those two definitions agree on every value except one: the EMPTY STRING is non-null in
-- SQL and falsy in JavaScript.
--
-- An adversarial gate reproduced the consequence against the real migrations: a task
-- created with `externalSource: ''` stored `external_source=''`, KEPT its
-- `assignee_agent_id`, and executed through to a model turn. SQL considered the row
-- externally sourced; the runtime considered it first-party; the row was governed by
-- whichever layer was asked. That is the same defect this entire audit set has been
-- about — a safety property living in two places that disagree — and the application
-- fix alone leaves it re-openable by the next caller, a direct D1 write, or a restore.
--
-- So the invariant is stated where the trust boundary itself is defined. After this,
-- `IS NOT NULL` and "is a real provenance marker" are the same question, and the JS/SQL
-- split has nowhere left to hide.
--
-- Blank is REJECTED rather than normalized to NULL. Coercing '' to NULL would convert a
-- caller's bug into trusted absence, which is exactly the "absence means permission"
-- pattern being closed; coercing it to a marker would invent provenance nobody supplied.
--
-- SQLite/D1 cannot add a CHECK constraint to an existing table, so this is expressed as
-- triggers on INSERT and UPDATE. They cover every writer, including ones that do not go
-- through createTask.

-- Defensive: an existing row with blank provenance is ambiguous by construction. Treat it
-- as EXTERNAL (fail closed) by giving it an explicit, attributable marker rather than
-- promoting it to trusted-local by nulling it.
UPDATE tasks SET external_source = 'unknown:blank-provenance-0078'
 WHERE external_source IS NOT NULL AND TRIM(external_source) = '';
UPDATE tasks SET source_pot = 'unknown:blank-provenance-0078'
 WHERE source_pot IS NOT NULL AND TRIM(source_pot) = '';

DROP TRIGGER IF EXISTS trg_tasks_provenance_nonblank_insert;
CREATE TRIGGER trg_tasks_provenance_nonblank_insert
BEFORE INSERT ON tasks
FOR EACH ROW
WHEN (NEW.external_source IS NOT NULL AND TRIM(NEW.external_source) = '')
  OR (NEW.source_pot IS NOT NULL AND TRIM(NEW.source_pot) = '')
BEGIN
  SELECT RAISE(ABORT, 'blank provenance: external_source/source_pot must be a non-blank marker or NULL');
END;

DROP TRIGGER IF EXISTS trg_tasks_provenance_nonblank_update;
CREATE TRIGGER trg_tasks_provenance_nonblank_update
BEFORE UPDATE ON tasks
FOR EACH ROW
WHEN (NEW.external_source IS NOT NULL AND TRIM(NEW.external_source) = '')
  OR (NEW.source_pot IS NOT NULL AND TRIM(NEW.source_pot) = '')
BEGIN
  SELECT RAISE(ABORT, 'blank provenance: external_source/source_pot must be a non-blank marker or NULL');
END;
