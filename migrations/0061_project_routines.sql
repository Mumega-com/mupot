-- 0061_project_routines.sql -- Project-owned routine policies and durable occurrences.
--
-- Agent runtimes remain external executors. These tables store only the control-plane
-- policy, correlation, governance, evidence references, and terminal result.

CREATE TABLE IF NOT EXISTS routines (
  id                      TEXT PRIMARY KEY,
  tenant                  TEXT NOT NULL,
  project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  name                    TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  objective               TEXT NOT NULL CHECK (length(trim(objective)) BETWEEN 1 AND 4000),
  status                  TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','enabled','paused','archived')),
  trigger_kind            TEXT NOT NULL
                          CHECK (trigger_kind IN ('manual','once','cron')),
  run_once_at             TEXT,
  cron_expression         TEXT,
  timezone                TEXT NOT NULL DEFAULT 'UTC'
                          CHECK (length(trim(timezone)) BETWEEN 1 AND 100),
  next_run_at             TEXT,
  overlap_policy          TEXT NOT NULL DEFAULT 'skip'
                          CHECK (overlap_policy IN ('skip','queue')),
  execution_mode          TEXT NOT NULL DEFAULT 'propose'
                          CHECK (execution_mode IN ('propose','execute_internal')),
  responsible_squad_id    TEXT NOT NULL REFERENCES squads(id) ON DELETE RESTRICT,
  preferred_agent_id      TEXT REFERENCES agents(id) ON DELETE SET NULL,
  budget_micro_usd        INTEGER NOT NULL DEFAULT 0 CHECK (budget_micro_usd >= 0),
  max_attempts            INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 5),
  retry_backoff_seconds   INTEGER NOT NULL DEFAULT 300
                          CHECK (retry_backoff_seconds BETWEEN 30 AND 86400),
  max_occurrences         INTEGER CHECK (max_occurrences IS NULL OR max_occurrences > 0),
  stop_at                 TEXT,
  revision                INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  enabled_by              TEXT,
  enabled_at              TEXT,
  created_by              TEXT NOT NULL CHECK (length(trim(created_by)) BETWEEN 1 AND 200),
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (trigger_kind = 'manual' AND run_once_at IS NULL AND cron_expression IS NULL)
    OR (trigger_kind = 'once' AND run_once_at IS NOT NULL AND cron_expression IS NULL)
    OR (trigger_kind = 'cron' AND run_once_at IS NULL AND cron_expression IS NOT NULL)
  ),
  CHECK (
    (status = 'enabled' AND enabled_by IS NOT NULL AND enabled_at IS NOT NULL)
    OR status <> 'enabled'
  )
);

CREATE TABLE IF NOT EXISTS routine_runs (
  id                    TEXT PRIMARY KEY,
  tenant                TEXT NOT NULL,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  routine_id            TEXT NOT NULL REFERENCES routines(id) ON DELETE RESTRICT,
  routine_revision      INTEGER NOT NULL CHECK (routine_revision > 0),
  policy_json           TEXT NOT NULL CHECK (json_valid(policy_json)),
  occurrence_key        TEXT NOT NULL CHECK (length(occurrence_key) BETWEEN 1 AND 300),
  trigger_kind          TEXT NOT NULL CHECK (trigger_kind IN ('manual','once','cron')),
  scheduled_for         TEXT,
  status                TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN (
                          'queued','leased','observing','waiting','running',
                          'succeeded','failed','skipped','cancelled'
                        )),
  waiting_reason        TEXT CHECK (waiting_reason IN ('agent','approval','answer','review','budget')),
  lease_owner           TEXT,
  lease_expires_at      TEXT,
  attempt               INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  retry_at              TEXT,
  assigned_agent_id     TEXT,
  task_id               TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
  flight_id             TEXT REFERENCES flights(id) ON DELETE RESTRICT,
  situation_digest      TEXT CHECK (situation_digest IS NULL OR length(situation_digest) = 64),
  proposal_json         TEXT CHECK (proposal_json IS NULL OR json_valid(proposal_json)),
  result_summary        TEXT CHECK (result_summary IS NULL OR length(result_summary) <= 4000),
  cost_micro_usd        INTEGER NOT NULL DEFAULT 0 CHECK (cost_micro_usd >= 0),
  started_at            TEXT,
  finished_at           TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant, routine_id, occurrence_key),
  CHECK (
    (status = 'waiting' AND waiting_reason IS NOT NULL)
    OR (status <> 'waiting' AND waiting_reason IS NULL)
  ),
  CHECK (
    (status = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status <> 'leased'
  )
);

CREATE TABLE IF NOT EXISTS routine_run_events (
  id              TEXT PRIMARY KEY,
  tenant          TEXT NOT NULL,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  run_id          TEXT NOT NULL REFERENCES routine_runs(id) ON DELETE RESTRICT,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'created','leased','observed','dispatched','agent_waiting',
                    'proposal_received','approval_requested','action_started',
                    'action_completed','retry_scheduled','budget_blocked','skipped',
                    'cancelled','failed','succeeded'
                  )),
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('system','member','agent')),
  actor_id        TEXT NOT NULL CHECK (length(trim(actor_id)) BETWEEN 1 AND 200),
  occurred_at     TEXT NOT NULL DEFAULT (datetime('now')),
  metadata_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  correlation_id  TEXT NOT NULL CHECK (length(trim(correlation_id)) BETWEEN 1 AND 200)
);

CREATE TABLE IF NOT EXISTS routine_run_actions (
  id                  TEXT PRIMARY KEY,
  tenant              TEXT NOT NULL,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  run_id              TEXT NOT NULL REFERENCES routine_runs(id) ON DELETE RESTRICT,
  action_key          TEXT NOT NULL CHECK (length(trim(action_key)) BETWEEN 1 AND 200),
  kind                TEXT NOT NULL CHECK (kind IN (
                        'create_task','dispatch_flight','request_review','ask_human','no_action'
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

CREATE TABLE IF NOT EXISTS routine_run_refs (
  id          TEXT PRIMARY KEY,
  tenant      TEXT NOT NULL,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  run_id      TEXT NOT NULL REFERENCES routine_runs(id) ON DELETE RESTRICT,
  ref_type    TEXT NOT NULL CHECK (ref_type IN (
                'task','flight','approval','receipt','message','output','evidence'
              )),
  ref_id      TEXT NOT NULL CHECK (length(trim(ref_id)) BETWEEN 1 AND 512),
  relation    TEXT NOT NULL CHECK (length(trim(relation)) BETWEEN 1 AND 100),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (run_id, ref_type, ref_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_routines_due
  ON routines (status, next_run_at, id)
  WHERE status = 'enabled' AND next_run_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_routines_project_status
  ON routines (tenant, project_id, status, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_routine_runs_lease_recovery
  ON routine_runs (status, lease_expires_at, id)
  WHERE status IN ('leased','observing');

CREATE INDEX IF NOT EXISTS idx_routine_runs_project_history
  ON routine_runs (tenant, project_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_routine_runs_needs_you
  ON routine_runs (tenant, waiting_reason, updated_at, id)
  WHERE status = 'waiting';

CREATE INDEX IF NOT EXISTS idx_routine_runs_retry
  ON routine_runs (status, retry_at, created_at, id)
  WHERE status = 'queued' AND retry_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_routine_runs_routine_active
  ON routine_runs (tenant, routine_id, status, created_at, id);

CREATE INDEX IF NOT EXISTS idx_routine_run_events_history
  ON routine_run_events (tenant, project_id, occurred_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_routine_run_actions_run
  ON routine_run_actions (run_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_routine_run_refs_project
  ON routine_run_refs (tenant, project_id, created_at DESC, id);

CREATE TRIGGER validate_routine_owner_insert
BEFORE INSERT ON routines
BEGIN
  SELECT RAISE(ABORT, 'routine project archived')
    WHERE EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND status = 'archived');
  SELECT RAISE(ABORT, 'routine squad project access denied')
    WHERE NOT EXISTS (
      SELECT 1 FROM project_squad_access
       WHERE project_id = NEW.project_id
         AND squad_id = NEW.responsible_squad_id
         AND access_level IN ('write','admin')
    );
  SELECT RAISE(ABORT, 'routine preferred agent outside squad')
    WHERE NEW.preferred_agent_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM agents
         WHERE id = NEW.preferred_agent_id AND squad_id = NEW.responsible_squad_id
      );
END;

CREATE TRIGGER validate_routine_owner_update
BEFORE UPDATE OF project_id, responsible_squad_id, preferred_agent_id ON routines
BEGIN
  SELECT RAISE(ABORT, 'routine project archived')
    WHERE EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND status = 'archived');
  SELECT RAISE(ABORT, 'routine squad project access denied')
    WHERE NOT EXISTS (
      SELECT 1 FROM project_squad_access
       WHERE project_id = NEW.project_id
         AND squad_id = NEW.responsible_squad_id
         AND access_level IN ('write','admin')
    );
  SELECT RAISE(ABORT, 'routine preferred agent outside squad')
    WHERE NEW.preferred_agent_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM agents
         WHERE id = NEW.preferred_agent_id AND squad_id = NEW.responsible_squad_id
      );
END;

CREATE TRIGGER routine_ownership_immutable
BEFORE UPDATE OF tenant, project_id ON routines
WHEN OLD.tenant IS NOT NEW.tenant OR OLD.project_id IS NOT NEW.project_id
BEGIN
  SELECT RAISE(ABORT, 'routine ownership immutable');
END;

CREATE TRIGGER validate_routine_run_insert
BEFORE INSERT ON routine_runs
BEGIN
  SELECT RAISE(ABORT, 'routine run project mismatch')
    WHERE NOT EXISTS (
      SELECT 1 FROM routines
       WHERE id = NEW.routine_id
         AND tenant = NEW.tenant
         AND project_id = NEW.project_id
         AND revision = NEW.routine_revision
    );
END;

CREATE TRIGGER routine_run_ownership_immutable
BEFORE UPDATE OF tenant, project_id, routine_id, routine_revision, policy_json,
                 occurrence_key, trigger_kind, scheduled_for ON routine_runs
WHEN OLD.tenant IS NOT NEW.tenant
  OR OLD.project_id IS NOT NEW.project_id
  OR OLD.routine_id IS NOT NEW.routine_id
  OR OLD.routine_revision IS NOT NEW.routine_revision
  OR OLD.policy_json IS NOT NEW.policy_json
  OR OLD.occurrence_key IS NOT NEW.occurrence_key
  OR OLD.trigger_kind IS NOT NEW.trigger_kind
  OR OLD.scheduled_for IS NOT NEW.scheduled_for
BEGIN
  SELECT RAISE(ABORT, 'routine run ownership immutable');
END;

CREATE TRIGGER validate_routine_event_insert
BEFORE INSERT ON routine_run_events
BEGIN
  SELECT RAISE(ABORT, 'routine event ownership mismatch')
    WHERE NOT EXISTS (
      SELECT 1 FROM routine_runs
       WHERE id = NEW.run_id AND tenant = NEW.tenant AND project_id = NEW.project_id
    );
END;

CREATE TRIGGER routine_events_no_update
BEFORE UPDATE ON routine_run_events
BEGIN
  SELECT RAISE(ABORT, 'routine events are append-only');
END;

CREATE TRIGGER routine_events_no_delete
BEFORE DELETE ON routine_run_events
BEGIN
  SELECT RAISE(ABORT, 'routine events are append-only');
END;

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

CREATE TRIGGER validate_routine_ref_insert
BEFORE INSERT ON routine_run_refs
BEGIN
  SELECT RAISE(ABORT, 'routine reference ownership mismatch')
    WHERE NOT EXISTS (
      SELECT 1 FROM routine_runs
       WHERE id = NEW.run_id AND tenant = NEW.tenant AND project_id = NEW.project_id
    );
END;

CREATE TRIGGER routine_ref_ownership_immutable
BEFORE UPDATE ON routine_run_refs
BEGIN
  SELECT RAISE(ABORT, 'routine references are immutable');
END;

CREATE TRIGGER routine_refs_no_delete
BEFORE DELETE ON routine_run_refs
BEGIN
  SELECT RAISE(ABORT, 'routine references are immutable');
END;
