CREATE TABLE IF NOT EXISTS marketing_monitor_runs (
  id TEXT NOT NULL PRIMARY KEY,
  tenant TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  binding_generation_id TEXT NOT NULL,
  addon_key TEXT NOT NULL CHECK (addon_key = 'marketing-cro-monitor'),
  installed_version TEXT NOT NULL,
  publisher TEXT NOT NULL,
  trust_class TEXT NOT NULL CHECK (trust_class = 'native_reviewed'),
  mupot_compatibility TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK (
    length(manifest_sha256) = 64
    AND manifest_sha256 = lower(manifest_sha256)
    AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  program_version TEXT NOT NULL CHECK (program_version = 'marketing-cro-monitor-v1'),
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('building','completed')),
  source_count INTEGER NOT NULL CHECK (source_count BETWEEN 0 AND 16),
  observation_count INTEGER NOT NULL CHECK (observation_count BETWEEN 0 AND 200),
  raw_observation_count INTEGER NOT NULL CHECK (
    raw_observation_count >= observation_count
    AND raw_observation_count <= 4294967295
  ),
  outcomes_json TEXT,
  evidence_digest TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (id, tenant, installation_id, binding_generation_id),
  UNIQUE (tenant, installation_id, program_version, window_start, window_end),
  FOREIGN KEY (installation_id, tenant)
    REFERENCES addon_installations (id, tenant)
    ON DELETE RESTRICT,
  FOREIGN KEY (binding_generation_id, installation_id, tenant)
    REFERENCES addon_binding_generations (id, installation_id, tenant)
    ON DELETE RESTRICT,
  CHECK (
    (status = 'building' AND outcomes_json IS NULL AND evidence_digest IS NULL AND completed_at IS NULL)
    OR (
      status = 'completed'
      AND json_valid(outcomes_json)
      AND json_type(outcomes_json) = 'object'
      AND length(evidence_digest) = 64
      AND evidence_digest = lower(evidence_digest)
      AND evidence_digest NOT GLOB '*[^0-9a-f]*'
      AND completed_at IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_marketing_monitor_runs_latest
  ON marketing_monitor_runs (tenant, completed_at DESC, id DESC)
  WHERE status = 'completed';

CREATE TABLE IF NOT EXISTS marketing_monitor_sources (
  run_id TEXT NOT NULL,
  tenant TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  binding_generation_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 15),
  source_key TEXT NOT NULL CHECK (
    length(source_key) BETWEEN 1 AND 64
    AND source_key NOT GLOB '*[^a-z0-9_-]*'
    AND source_key GLOB '[a-z0-9]*'
  ),
  source_slot TEXT NOT NULL CHECK (
    length(source_slot) BETWEEN 1 AND 64
    AND source_slot NOT GLOB '*[^a-z0-9_-]*'
    AND source_slot GLOB '[a-z0-9]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('available','unavailable','failed')),
  reason TEXT,
  observation_count INTEGER NOT NULL CHECK (observation_count BETWEEN 0 AND 100),
  PRIMARY KEY (run_id, source_key),
  UNIQUE (run_id, position),
  UNIQUE (run_id, source_key, source_slot),
  FOREIGN KEY (run_id, tenant, installation_id, binding_generation_id)
    REFERENCES marketing_monitor_runs (id, tenant, installation_id, binding_generation_id)
    ON DELETE RESTRICT,
  CHECK (
    (status = 'available' AND reason IS NULL)
    OR (status IN ('unavailable','failed') AND reason IN (
      'adapter_type_mismatch',
      'authoritative_source_missing',
      'binding_adapter_not_supported',
      'binding_not_configured',
      'connector_not_available',
      'connector_not_configured',
      'connector_revoked',
      'duplicate_observation_id',
      'duplicate_source_identity',
      'invalid_binding_configuration',
      'invalid_observation',
      'invalid_source_configuration',
      'invalid_source_snapshot',
      'metric_authority_not_allowed',
      'observation_authority_mismatch',
      'observation_unit_mismatch',
      'run_id_mismatch',
      'run_observation_limit_exceeded',
      'source_observation_limit_exceeded',
      'source_read_failed',
      'source_unavailable',
      'window_mismatch'
    ))
  )
);

CREATE TABLE IF NOT EXISTS marketing_monitor_observations (
  run_id TEXT NOT NULL,
  tenant TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  binding_generation_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 199),
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 256),
  source_key TEXT NOT NULL,
  source_slot TEXT NOT NULL,
  metric_key TEXT NOT NULL CHECK (metric_key IN (
    'seo.ai_citations',
    'seo.organic_sessions',
    'growth.leads',
    'growth.replies',
    'seo.conversion_rate',
    'finance.revenue'
  )),
  value REAL NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('count','ratio','usd')),
  authority TEXT NOT NULL CHECK (authority IN (
    'first-party','posthog','gsc','ghl','crm','mcpwp','inkwell','ai_visibility'
  )),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, position),
  FOREIGN KEY (run_id, tenant, installation_id, binding_generation_id)
    REFERENCES marketing_monitor_runs (id, tenant, installation_id, binding_generation_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (run_id, source_key, source_slot)
    REFERENCES marketing_monitor_sources (run_id, source_key, source_slot)
    ON DELETE RESTRICT,
  CHECK (
    (metric_key IN ('seo.ai_citations','seo.organic_sessions','growth.leads','growth.replies') AND unit = 'count')
    OR (metric_key = 'seo.conversion_rate' AND unit = 'ratio')
    OR (metric_key = 'finance.revenue' AND unit = 'usd')
  ),
  CHECK (
    (metric_key = 'seo.ai_citations' AND authority IN ('first-party','ai_visibility'))
    OR (metric_key IN ('seo.organic_sessions','seo.conversion_rate') AND authority IN ('first-party','posthog'))
    OR (metric_key IN ('growth.leads','growth.replies') AND authority IN ('first-party','ghl','crm'))
    OR (metric_key = 'finance.revenue' AND authority IN ('ghl','crm'))
  )
);

CREATE TRIGGER IF NOT EXISTS marketing_monitor_runs_insert_fence
  BEFORE INSERT ON marketing_monitor_runs
  WHEN NEW.status <> 'building'
    OR length(NEW.window_start) <> 24
    OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.window_start) IS NOT NEW.window_start
    OR length(NEW.window_end) <> 24
    OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.window_end) IS NOT NEW.window_end
    OR NEW.window_start > NEW.window_end
    OR length(NEW.created_at) <> 24
    OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at) IS NOT NEW.created_at
    OR NOT EXISTS (
      SELECT 1
        FROM addon_installations AS installation
        JOIN addon_binding_generations AS generation
          ON generation.installation_id = installation.id
         AND generation.tenant = installation.tenant
         AND generation.id = NEW.binding_generation_id
         AND generation.revoked_at IS NULL
         AND generation.manifest_sha256 = installation.manifest_sha256
       WHERE installation.id = NEW.installation_id
         AND installation.tenant = NEW.tenant
         AND installation.state = 'active'
         AND installation.addon_key = NEW.addon_key
         AND installation.installed_version = NEW.installed_version
         AND installation.publisher = NEW.publisher
         AND installation.trust_class = NEW.trust_class
         AND installation.mupot_compatibility = NEW.mupot_compatibility
         AND installation.manifest_sha256 = NEW.manifest_sha256
         AND generation.binding_count = (
           SELECT COUNT(*)
             FROM addon_connector_bindings AS binding
            WHERE binding.generation_id = generation.id
              AND binding.installation_id = generation.installation_id
              AND binding.tenant = generation.tenant
              AND binding.revoked_at IS NULL
         )
    )
BEGIN
  SELECT RAISE(ABORT, 'marketing monitor run insert fence lost');
END;

CREATE TRIGGER IF NOT EXISTS marketing_monitor_sources_insert_fence
  BEFORE INSERT ON marketing_monitor_sources
  WHEN NOT EXISTS (
    SELECT 1 FROM marketing_monitor_runs AS run
     WHERE run.id = NEW.run_id
       AND run.tenant = NEW.tenant
       AND run.installation_id = NEW.installation_id
       AND run.binding_generation_id = NEW.binding_generation_id
       AND run.status = 'building'
  )
BEGIN
  SELECT RAISE(ABORT, 'marketing monitor source parent fence lost');
END;

CREATE TRIGGER IF NOT EXISTS marketing_monitor_observations_insert_fence
  BEFORE INSERT ON marketing_monitor_observations
  WHEN length(NEW.observed_at) <> 24
    OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.observed_at) IS NOT NEW.observed_at
    OR NOT EXISTS (
      SELECT 1
        FROM marketing_monitor_runs AS run
        JOIN marketing_monitor_sources AS source
          ON source.run_id = run.id
         AND source.tenant = run.tenant
         AND source.installation_id = run.installation_id
         AND source.binding_generation_id = run.binding_generation_id
         AND source.source_key = NEW.source_key
         AND source.source_slot = NEW.source_slot
         AND source.status = 'available'
       WHERE run.id = NEW.run_id
         AND run.tenant = NEW.tenant
         AND run.installation_id = NEW.installation_id
         AND run.binding_generation_id = NEW.binding_generation_id
         AND run.status = 'building'
         AND NEW.observed_at BETWEEN run.window_start AND run.window_end
    )
BEGIN
  SELECT RAISE(ABORT, 'marketing monitor observation fence lost');
END;

CREATE TRIGGER IF NOT EXISTS marketing_monitor_runs_finalize_only
  BEFORE UPDATE ON marketing_monitor_runs
  WHEN OLD.status <> 'building'
    OR NEW.status <> 'completed'
    OR NEW.id IS NOT OLD.id
    OR NEW.tenant IS NOT OLD.tenant
    OR NEW.installation_id IS NOT OLD.installation_id
    OR NEW.binding_generation_id IS NOT OLD.binding_generation_id
    OR NEW.addon_key IS NOT OLD.addon_key
    OR NEW.installed_version IS NOT OLD.installed_version
    OR NEW.publisher IS NOT OLD.publisher
    OR NEW.trust_class IS NOT OLD.trust_class
    OR NEW.mupot_compatibility IS NOT OLD.mupot_compatibility
    OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256
    OR NEW.program_version IS NOT OLD.program_version
    OR NEW.window_start IS NOT OLD.window_start
    OR NEW.window_end IS NOT OLD.window_end
    OR NEW.source_count IS NOT OLD.source_count
    OR NEW.observation_count IS NOT OLD.observation_count
    OR NEW.raw_observation_count IS NOT OLD.raw_observation_count
    OR NEW.created_at IS NOT OLD.created_at
    OR length(NEW.completed_at) <> 24
    OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.completed_at) IS NOT NEW.completed_at
    OR NEW.completed_at < OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'marketing monitor runs are immutable except guarded finalization');
END;

CREATE TRIGGER IF NOT EXISTS marketing_monitor_runs_finalize_fence
  BEFORE UPDATE OF status ON marketing_monitor_runs
  WHEN NEW.status = 'completed' AND (
    NOT EXISTS (
      SELECT 1
        FROM addon_installations AS installation
        JOIN addon_binding_generations AS generation
          ON generation.installation_id = installation.id
         AND generation.tenant = installation.tenant
         AND generation.id = OLD.binding_generation_id
         AND generation.revoked_at IS NULL
         AND generation.manifest_sha256 = installation.manifest_sha256
       WHERE installation.id = OLD.installation_id
         AND installation.tenant = OLD.tenant
         AND installation.state = 'active'
         AND installation.addon_key = OLD.addon_key
         AND installation.installed_version = OLD.installed_version
         AND installation.publisher = OLD.publisher
         AND installation.trust_class = OLD.trust_class
         AND installation.mupot_compatibility = OLD.mupot_compatibility
         AND installation.manifest_sha256 = OLD.manifest_sha256
         AND generation.binding_count = (
           SELECT COUNT(*) FROM addon_connector_bindings AS binding
            WHERE binding.generation_id = generation.id
              AND binding.installation_id = generation.installation_id
              AND binding.tenant = generation.tenant
              AND binding.revoked_at IS NULL
         )
    )
    OR OLD.source_count <> (SELECT COUNT(*) FROM marketing_monitor_sources WHERE run_id = OLD.id)
    OR OLD.observation_count <> (SELECT COUNT(*) FROM marketing_monitor_observations WHERE run_id = OLD.id)
    OR OLD.observation_count <> COALESCE((
      SELECT SUM(observation_count) FROM marketing_monitor_sources WHERE run_id = OLD.id
    ), 0)
    OR EXISTS (
      SELECT 1
        FROM marketing_monitor_sources AS source
       WHERE source.run_id = OLD.id
         AND source.observation_count <> (
           SELECT COUNT(*) FROM marketing_monitor_observations AS observation
            WHERE observation.run_id = source.run_id
              AND observation.source_key = source.source_key
              AND observation.source_slot = source.source_slot
         )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'marketing monitor run finalization fence lost');
END;

CREATE TRIGGER IF NOT EXISTS marketing_monitor_runs_no_delete
  BEFORE DELETE ON marketing_monitor_runs
BEGIN
  SELECT RAISE(ABORT, 'marketing monitor runs are append-only: DELETE is forbidden');
END;

CREATE TRIGGER IF NOT EXISTS marketing_monitor_sources_no_update
  BEFORE UPDATE ON marketing_monitor_sources
BEGIN
  SELECT RAISE(ABORT, 'marketing monitor sources are append-only: UPDATE is forbidden');
END;

CREATE TRIGGER IF NOT EXISTS marketing_monitor_sources_no_delete
  BEFORE DELETE ON marketing_monitor_sources
BEGIN
  SELECT RAISE(ABORT, 'marketing monitor sources are append-only: DELETE is forbidden');
END;

CREATE TRIGGER IF NOT EXISTS marketing_monitor_observations_no_update
  BEFORE UPDATE ON marketing_monitor_observations
BEGIN
  SELECT RAISE(ABORT, 'marketing monitor observations are append-only: UPDATE is forbidden');
END;

CREATE TRIGGER IF NOT EXISTS marketing_monitor_observations_no_delete
  BEFORE DELETE ON marketing_monitor_observations
BEGIN
  SELECT RAISE(ABORT, 'marketing monitor observations are append-only: DELETE is forbidden');
END;
