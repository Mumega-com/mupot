CREATE TABLE IF NOT EXISTS marketing_recommendations (
  id TEXT NOT NULL PRIMARY KEY,
  tenant TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  binding_generation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  program_version TEXT NOT NULL CHECK (program_version = 'marketing-cro-monitor-v1'),
  kind TEXT NOT NULL CHECK (kind IN (
    'conversion_review',
    'revenue_review',
    'lead_generation_review',
    'organic_traffic_review',
    'ai_visibility_review'
  )),
  target TEXT NOT NULL CHECK (length(target) BETWEEN 1 AND 500),
  problem TEXT NOT NULL CHECK (length(problem) BETWEEN 1 AND 2000),
  hypothesis TEXT NOT NULL CHECK (length(hypothesis) BETWEEN 1 AND 2000),
  primary_kpi TEXT NOT NULL CHECK (primary_kpi IN (
    'visibility','qualifiedTraffic','leads','conversion','revenue'
  )),
  kpi_baseline_json TEXT NOT NULL CHECK (
    json_valid(kpi_baseline_json)
    AND json_type(kpi_baseline_json) = 'object'
    AND json_extract(kpi_baseline_json, '$.status') IN ('available','unavailable')
  ),
  limiting_evidence_json TEXT NOT NULL CHECK (
    json_valid(limiting_evidence_json)
    AND json_type(limiting_evidence_json) = 'array'
  ),
  evidence_digest TEXT NOT NULL CHECK (
    length(evidence_digest) = 64
    AND evidence_digest = lower(evidence_digest)
    AND evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  dedup_key TEXT NOT NULL CHECK (
    length(dedup_key) = 64
    AND dedup_key = lower(dedup_key)
    AND dedup_key NOT GLOB '*[^0-9a-f]*'
  ),
  squad_id TEXT NOT NULL,
  task_id TEXT,
  flight_id TEXT,
  approval_required INTEGER NOT NULL CHECK (approval_required = 1),
  approval_action TEXT NOT NULL CHECK (approval_action = 'promote_recommendation'),
  required_capability TEXT NOT NULL CHECK (required_capability = 'owner'),
  self_approval INTEGER NOT NULL CHECK (self_approval = 0),
  terminal_action TEXT NOT NULL CHECK (terminal_action = 'recommendation_ready'),
  receipt_digest TEXT,
  status TEXT NOT NULL CHECK (status IN ('preparing','ready')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  prepared_at TEXT,
  UNIQUE (tenant, dedup_key),
  UNIQUE (task_id),
  UNIQUE (flight_id),
  FOREIGN KEY (installation_id, tenant)
    REFERENCES addon_installations (id, tenant)
    ON DELETE RESTRICT,
  FOREIGN KEY (run_id, tenant, installation_id, binding_generation_id)
    REFERENCES marketing_monitor_runs (id, tenant, installation_id, binding_generation_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (squad_id) REFERENCES squads (id) ON DELETE RESTRICT,
  FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE RESTRICT,
  FOREIGN KEY (flight_id) REFERENCES flights (id) ON DELETE RESTRICT,
  CHECK (
    (status = 'preparing' AND task_id IS NULL AND flight_id IS NULL
      AND receipt_digest IS NULL AND prepared_at IS NULL)
    OR
    (status = 'ready' AND task_id IS NOT NULL AND flight_id IS NOT NULL
      AND length(receipt_digest) = 64
      AND receipt_digest = lower(receipt_digest)
      AND receipt_digest NOT GLOB '*[^0-9a-f]*'
      AND prepared_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_marketing_recommendations_latest
  ON marketing_recommendations (tenant, installation_id, prepared_at DESC, id DESC)
  WHERE status = 'ready';

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketing_recommendation_task_dedup
  ON tasks (json_extract(body, '$.recommendation.dedupKey'))
  WHERE json_valid(body)
    AND json_extract(body, '$.schema') = 'mupot.marketing-recommendation/v1';

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketing_recommendation_flight_dedup
  ON flights (tenant, json_extract(meta, '$.goal_id'))
  WHERE agent = 'addon:marketing-cro-monitor'
    AND json_valid(meta)
    AND json_extract(meta, '$.schema') = 'mupot.flight.meta/v1';

CREATE TRIGGER IF NOT EXISTS marketing_recommendations_insert_fence
  BEFORE INSERT ON marketing_recommendations
  WHEN NEW.status <> 'preparing'
    OR length(NEW.created_at) <> 24
    OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at) IS NOT NEW.created_at
    OR NOT EXISTS (
      SELECT 1
        FROM addon_installations AS installation
        JOIN marketing_monitor_runs AS run
          ON run.id = NEW.run_id
         AND run.tenant = installation.tenant
         AND run.installation_id = installation.id
         AND run.binding_generation_id = NEW.binding_generation_id
         AND run.program_version = NEW.program_version
         AND run.status = 'completed'
         AND run.evidence_digest = NEW.evidence_digest
       WHERE installation.id = NEW.installation_id
         AND installation.tenant = NEW.tenant
         AND installation.addon_key = 'marketing-cro-monitor'
         AND installation.state = 'active'
         AND NOT EXISTS (
           SELECT 1
             FROM marketing_monitor_runs AS newer
            WHERE newer.tenant = run.tenant
              AND newer.installation_id = run.installation_id
              AND newer.program_version = run.program_version
              AND newer.status = 'completed'
              AND (newer.completed_at > run.completed_at
                OR (newer.completed_at = run.completed_at AND newer.id > run.id))
         )
    )
    OR NOT EXISTS (
      SELECT 1
        FROM addon_resource_ownership AS claim
        JOIN departments AS department
          ON department.id = claim.resource_id
         AND department.template_key = claim.resource_key
         AND department.active = 1
        JOIN squads AS squad
          ON squad.department_id = department.id
         AND squad.id = NEW.squad_id
       WHERE claim.tenant = NEW.tenant
         AND claim.installation_id = NEW.installation_id
         AND claim.resource_type = 'department'
         AND claim.resource_key = 'web-ops'
         AND claim.active = 1
    )
BEGIN
  SELECT RAISE(ABORT, 'marketing recommendation insert fence lost');
END;

CREATE TRIGGER IF NOT EXISTS marketing_recommendations_finalize_fence
  BEFORE UPDATE OF status ON marketing_recommendations
  WHEN NEW.status <> 'ready'
    OR OLD.status <> 'preparing'
    OR length(NEW.prepared_at) <> 24
    OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.prepared_at) IS NOT NEW.prepared_at
    OR NEW.prepared_at < OLD.created_at
    OR NOT EXISTS (
      SELECT 1 FROM addon_installations AS installation
       WHERE installation.id = OLD.installation_id
         AND installation.tenant = OLD.tenant
         AND installation.addon_key = 'marketing-cro-monitor'
         AND installation.state = 'active'
    )
    OR NOT EXISTS (
      SELECT 1
        FROM tasks AS task
        JOIN marketing_monitor_runs AS run
          ON run.id = OLD.run_id
         AND run.tenant = OLD.tenant
         AND run.installation_id = OLD.installation_id
         AND run.binding_generation_id = OLD.binding_generation_id
       WHERE task.id = NEW.task_id
         AND task.squad_id = OLD.squad_id
         AND task.title = 'Review CRO recommendation: ' || OLD.primary_kpi
         AND task.body = json_object(
           'schema', 'mupot.marketing-recommendation/v1',
           'recommendation', json_object('id', OLD.id, 'dedupKey', OLD.dedup_key),
           'target', OLD.target,
           'problem', OLD.problem,
           'hypothesis', OLD.hypothesis,
           'primaryKpi', OLD.primary_kpi,
           'kpiBaseline', json(OLD.kpi_baseline_json),
           'limitingEvidence', json(OLD.limiting_evidence_json),
           'evidence', json_object(
             'programVersion', OLD.program_version,
             'window', json_object('start', run.window_start, 'end', run.window_end),
             'digest', OLD.evidence_digest
           ),
           'approval', json_object(
             'required', json('true'),
             'action', 'promote_recommendation',
             'requiredCapability', 'owner',
             'selfApproval', json('false')
           )
         )
         AND task.done_when = 'An owner approves or rejects the recommendation; no external change is executed'
         AND task.gate_owner = 'gate:addons:marketing-cro-monitor:promote_recommendation'
    )
    OR NOT EXISTS (
      SELECT 1 FROM flights AS flight
       WHERE flight.id = NEW.flight_id
         AND flight.tenant = OLD.tenant
         AND flight.agent = 'addon:marketing-cro-monitor'
         AND flight.goal = 'Prepare ' || OLD.kind || ' for owner review'
         AND json_valid(flight.meta)
         AND json_type(flight.meta) = 'object'
         AND json_extract(flight.meta, '$.schema') = 'mupot.flight.meta/v1'
         AND json_extract(flight.meta, '$.goal_id') = 'marketing-recommendation:' || OLD.id
         AND json_extract(flight.meta, '$.objective_id') = OLD.kind
         AND json_extract(flight.meta, '$.confidentiality') = 'internal'
         AND json_extract(flight.meta, '$.publication_target') = 'none'
         AND json_type(flight.meta, '$.parent_flight_id') = 'null'
         AND json_type(flight.meta, '$.squad_ids') = 'array'
         AND json_type(flight.meta, '$.task_ids') = 'array'
         AND json_type(flight.meta, '$.done_when') = 'array'
         AND json_type(flight.meta, '$.artifact_refs') = 'array'
         AND json_type(flight.meta, '$.receipt_refs') = 'array'
         AND (SELECT count(*) FROM json_each(flight.meta)) = 11
         AND (SELECT count(DISTINCT field.key) FROM json_each(flight.meta) AS field) = 11
         AND NOT EXISTS (
           SELECT 1 FROM json_each(flight.meta) AS field
            WHERE field.key NOT IN (
              'schema', 'goal_id', 'objective_id', 'squad_ids', 'task_ids',
              'done_when', 'artifact_refs', 'receipt_refs', 'confidentiality',
              'publication_target', 'parent_flight_id'
            )
         )
         AND (SELECT count(*) FROM json_each(flight.meta, '$.squad_ids')) = 1
         AND EXISTS (
           SELECT 1 FROM json_each(flight.meta, '$.squad_ids') AS squad_ref
            WHERE squad_ref.value = OLD.squad_id
         )
         AND (SELECT count(*) FROM json_each(flight.meta, '$.task_ids')) = 1
         AND EXISTS (
           SELECT 1 FROM json_each(flight.meta, '$.task_ids') AS task_ref
            WHERE task_ref.value = NEW.task_id
         )
         AND (SELECT count(*) FROM json_each(flight.meta, '$.done_when')) = 1
         AND EXISTS (
           SELECT 1 FROM json_each(flight.meta, '$.done_when') AS done_when
            WHERE done_when.value = 'An owner approves or rejects the recommendation; no external change is executed'
         )
         AND (SELECT count(*) FROM json_each(flight.meta, '$.artifact_refs')) = 1
         AND EXISTS (
           SELECT 1 FROM json_each(flight.meta, '$.artifact_refs') AS artifact_ref
            WHERE artifact_ref.value = 'marketing-recommendation:' || OLD.id
         )
         AND (SELECT count(*) FROM json_each(flight.meta, '$.receipt_refs')) = 1
         AND EXISTS (
           SELECT 1 FROM json_each(flight.meta, '$.receipt_refs') AS receipt_ref
            WHERE receipt_ref.value = 'marketing-monitor-evidence:' || OLD.evidence_digest
         )
    )
BEGIN
  SELECT RAISE(ABORT, 'marketing recommendation finalization fence lost');
END;

CREATE TRIGGER IF NOT EXISTS marketing_recommendations_update_guard
  BEFORE UPDATE ON marketing_recommendations
  WHEN NOT (
    OLD.status = 'preparing'
    AND NEW.status = 'ready'
    AND NEW.id IS OLD.id
    AND NEW.tenant IS OLD.tenant
    AND NEW.installation_id IS OLD.installation_id
    AND NEW.binding_generation_id IS OLD.binding_generation_id
    AND NEW.run_id IS OLD.run_id
    AND NEW.program_version IS OLD.program_version
    AND NEW.kind IS OLD.kind
    AND NEW.target IS OLD.target
    AND NEW.problem IS OLD.problem
    AND NEW.hypothesis IS OLD.hypothesis
    AND NEW.primary_kpi IS OLD.primary_kpi
    AND NEW.kpi_baseline_json IS OLD.kpi_baseline_json
    AND NEW.limiting_evidence_json IS OLD.limiting_evidence_json
    AND NEW.evidence_digest IS OLD.evidence_digest
    AND NEW.dedup_key IS OLD.dedup_key
    AND NEW.squad_id IS OLD.squad_id
    AND NEW.approval_required IS OLD.approval_required
    AND NEW.approval_action IS OLD.approval_action
    AND NEW.required_capability IS OLD.required_capability
    AND NEW.self_approval IS OLD.self_approval
    AND NEW.terminal_action IS OLD.terminal_action
    AND NEW.created_by IS OLD.created_by
    AND NEW.created_at IS OLD.created_at
    AND OLD.task_id IS NULL AND NEW.task_id IS NOT NULL
    AND OLD.flight_id IS NULL AND NEW.flight_id IS NOT NULL
    AND OLD.receipt_digest IS NULL AND NEW.receipt_digest IS NOT NULL
    AND OLD.prepared_at IS NULL AND NEW.prepared_at IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'marketing recommendations are immutable after guarded finalization');
END;

CREATE TRIGGER IF NOT EXISTS marketing_recommendations_no_delete
  BEFORE DELETE ON marketing_recommendations
BEGIN
  SELECT RAISE(ABORT, 'marketing recommendations are evidence and cannot be deleted');
END;
