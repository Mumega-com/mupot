-- 0158_routine_run_actions_project_access_kind.sql — widen routine_run_actions.kind
-- to admit 'project_access' (FP-01 Slice 2, mupot#1443, brief §2 Task A).
-- NOT applied by this build — branch/schema only, exactly like 0143/0144/0147/
-- 0148/0157 before it; a human applies it.
--
-- src/routines/types.ts's RoutineActionKind and src/routines/proposal.ts's
-- RoutineProposalAction union both already admit 'project_access' — a Mubot
-- proposal that a member be granted access_level on a project, verdicted
-- exactly like every other propose-mode action kind (src/routines/actions.ts's
-- submitRoutineProposal routes ANY kind through waitForHuman('review') when
-- policy.execution_mode='propose'). The DB-level CHECK constraint on
-- routine_run_actions.kind (migrations/0073) still lists only the original
-- five kinds, so reserveAction's INSERT (src/routines/actions.ts) fails
-- closed with 'receipt_failed' the instant a project_access proposal is
-- submitted — caught by tests/routine-project-access.test.ts before this
-- migration existed.
--
-- SQLite has no ALTER COLUMN / ALTER CONSTRAINT, so the fix is the same
-- table-rebuild migrations/0042 (tasks.status) already used for exactly this
-- shape of change: rebuild the table with every column, index, and trigger
-- unchanged except the widened CHECK. No other migration has touched
-- routine_run_actions since it was created in 0073 (verified: grep for
-- "ALTER TABLE routine_run_actions" across migrations/ returns nothing), so
-- this rebuild's column list is a straight copy of 0073's, and the SELECT
-- below is columns-only (no COALESCE/backfill needed).

PRAGMA foreign_keys = off;

CREATE TABLE routine_run_actions_new (
  id                  TEXT PRIMARY KEY,
  tenant              TEXT NOT NULL,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  run_id              TEXT NOT NULL REFERENCES routine_runs(id) ON DELETE RESTRICT,
  action_key          TEXT NOT NULL CHECK (length(trim(action_key)) BETWEEN 1 AND 200),
  kind                TEXT NOT NULL CHECK (kind IN (
                        'create_task','dispatch_flight','request_review','ask_human',
                        'no_action','project_access'
                      )),
  input_json          TEXT NOT NULL CHECK (json_valid(input_json)),
  validation_status   TEXT NOT NULL DEFAULT 'pending'
                      CHECK (validation_status IN ('pending','accepted','rejected')),
  gate_status         TEXT NOT NULL DEFAULT 'not_required'
                      CHECK (gate_status IN ('not_required','pending','approved','rejected')),
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','waiting','running','succeeded','failed','cancelled')),
  source_type         TEXT,
  source_id           TEXT,
  receipt_id          TEXT,
  result_json         TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (run_id, action_key)
);

INSERT INTO routine_run_actions_new (
  id, tenant, project_id, run_id, action_key, kind, input_json,
  validation_status, gate_status, status, source_type, source_id,
  receipt_id, result_json, created_at, updated_at
)
SELECT
  id, tenant, project_id, run_id, action_key, kind, input_json,
  validation_status, gate_status, status, source_type, source_id,
  receipt_id, result_json, created_at, updated_at
FROM routine_run_actions;

DROP TABLE routine_run_actions;
ALTER TABLE routine_run_actions_new RENAME TO routine_run_actions;

-- Indexes dropped with the table above — recreated verbatim from 0073.
CREATE INDEX IF NOT EXISTS idx_routine_run_actions_run
  ON routine_run_actions (run_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_routine_run_actions_projection_keyset
  ON routine_run_actions (
    tenant, project_id,
    CAST(ROUND((julianday(updated_at) - 2440587.5) * 86400000) AS INTEGER) DESC,
    id
  );

-- Triggers dropped with the table above — recreated verbatim from 0073.
CREATE TRIGGER validate_routine_action_insert
BEFORE INSERT ON routine_run_actions
BEGIN
  SELECT RAISE(ABORT, 'routine action ownership mismatch')
    WHERE NOT EXISTS (
      SELECT 1 FROM routine_runs
       WHERE id = NEW.run_id AND tenant = NEW.tenant AND project_id = NEW.project_id
    );
END;

CREATE TRIGGER routine_action_ownership_immutable
BEFORE UPDATE OF tenant, project_id, run_id, action_key, kind, input_json ON routine_run_actions
WHEN OLD.tenant IS NOT NEW.tenant
  OR OLD.project_id IS NOT NEW.project_id
  OR OLD.run_id IS NOT NEW.run_id
  OR OLD.action_key IS NOT NEW.action_key
  OR OLD.kind IS NOT NEW.kind
  OR OLD.input_json IS NOT NEW.input_json
BEGIN
  SELECT RAISE(ABORT, 'routine action ownership immutable');
END;

PRAGMA foreign_keys = on;
