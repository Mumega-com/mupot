-- Flight Spine objectives, composition lanes, assignment epochs, and flight dependencies.
-- Additive only: legacy tasks retain epoch 0 until Flight Spine materialization assigns them.

ALTER TABLE tasks
  ADD COLUMN assignment_epoch INTEGER NOT NULL DEFAULT 0
  CHECK (assignment_epoch >= 0);

CREATE TABLE objectives (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  created_by_principal_kind TEXT NOT NULL
    CHECK (created_by_principal_kind IN ('member','agent')),
  created_by_principal_id TEXT NOT NULL,
  created_by_member_id TEXT NOT NULL,
  squad_id TEXT NOT NULL REFERENCES squads(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  success_contract TEXT NOT NULL CHECK (length(trim(success_contract)) BETWEEN 1 AND 8000),
  authority_envelope TEXT NOT NULL CHECK (json_valid(authority_envelope)),
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  budget_micro_usd INTEGER NOT NULL CHECK (budget_micro_usd >= 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_digest TEXT NOT NULL
    CHECK (
      length(payload_digest) = 64
      AND payload_digest = lower(payload_digest)
      AND payload_digest NOT GLOB '*[^0-9a-f]*'
    ),
  accepted_at TEXT NOT NULL CHECK (length(trim(accepted_at)) > 0),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0)
);

CREATE INDEX idx_objectives_tenant_squad
  ON objectives(tenant, squad_id, accepted_at);
CREATE INDEX idx_objectives_tenant_project
  ON objectives(tenant, project_id, accepted_at)
  WHERE project_id IS NOT NULL;

CREATE TABLE objective_acceptance_keys (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 255),
  objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE RESTRICT,
  payload_digest TEXT NOT NULL
    CHECK (
      length(payload_digest) = 64
      AND payload_digest = lower(payload_digest)
      AND payload_digest NOT GLOB '*[^0-9a-f]*'
    ),
  acceptance_receipt_id TEXT,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  UNIQUE (tenant, idempotency_key)
);

CREATE TABLE flight_objectives (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  flight_id TEXT NOT NULL REFERENCES flights(id) ON DELETE RESTRICT,
  objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE RESTRICT,
  materialization_receipt_id TEXT,
  linked_at TEXT NOT NULL CHECK (length(trim(linked_at)) > 0),
  UNIQUE (tenant, flight_id),
  UNIQUE (tenant, objective_id, flight_id)
);

CREATE TABLE flight_lanes (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  flight_id TEXT NOT NULL REFERENCES flights(id) ON DELETE RESTRICT,
  lane_key TEXT NOT NULL CHECK (length(trim(lane_key)) BETWEEN 1 AND 120),
  role TEXT NOT NULL CHECK (role IN ('coordinator','worker','integrator','gate')),
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  assignment_epoch INTEGER NOT NULL CHECK (assignment_epoch > 0),
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  runtime_seat_id TEXT REFERENCES runtime_seats(id) ON DELETE RESTRICT,
  done_when TEXT NOT NULL CHECK (length(trim(done_when)) BETWEEN 1 AND 8000),
  dependency_lane_keys_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(dependency_lane_keys_json) AND json_type(dependency_lane_keys_json) = 'array'),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  UNIQUE (tenant, flight_id, lane_key),
  UNIQUE (tenant, flight_id, task_id),
  UNIQUE (tenant, task_id, assignment_epoch)
);

CREATE UNIQUE INDEX idx_flight_lanes_one_gate_per_flight
  ON flight_lanes(tenant, flight_id)
  WHERE role = 'gate';
CREATE INDEX idx_flight_lanes_agent_seat
  ON flight_lanes(tenant, agent_id, runtime_seat_id);

CREATE TABLE flight_task_assignments (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  flight_id TEXT NOT NULL REFERENCES flights(id) ON DELETE RESTRICT,
  lane_id TEXT NOT NULL REFERENCES flight_lanes(id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  assignment_epoch INTEGER NOT NULL CHECK (assignment_epoch > 0),
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  runtime_seat_id TEXT REFERENCES runtime_seats(id) ON DELETE RESTRICT,
  assigned_by_principal_kind TEXT NOT NULL
    CHECK (assigned_by_principal_kind IN ('member','agent','system','controller')),
  assigned_by_principal_id TEXT NOT NULL,
  assigned_by_member_id TEXT,
  assignment_receipt_id TEXT,
  assigned_at TEXT NOT NULL CHECK (length(trim(assigned_at)) > 0),
  UNIQUE (tenant, task_id, assignment_epoch),
  UNIQUE (tenant, lane_id, assignment_epoch)
);

CREATE INDEX idx_flight_task_assignments_flight
  ON flight_task_assignments(tenant, flight_id, assigned_at);
CREATE INDEX idx_flight_task_assignments_agent_seat
  ON flight_task_assignments(tenant, agent_id, runtime_seat_id, assignment_epoch);

CREATE TABLE flight_dependencies (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE RESTRICT,
  parent_flight_id TEXT NOT NULL REFERENCES flights(id) ON DELETE RESTRICT,
  child_flight_id TEXT NOT NULL REFERENCES flights(id) ON DELETE RESTRICT,
  created_by_principal_kind TEXT NOT NULL
    CHECK (created_by_principal_kind IN ('member','agent','system','controller')),
  created_by_principal_id TEXT NOT NULL,
  created_by_member_id TEXT,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  CHECK (parent_flight_id <> child_flight_id),
  UNIQUE (tenant, parent_flight_id, child_flight_id)
);

CREATE INDEX idx_flight_dependencies_child
  ON flight_dependencies(tenant, child_flight_id, parent_flight_id);

CREATE TRIGGER objectives_no_update
BEFORE UPDATE ON objectives
BEGIN
  SELECT RAISE(ABORT, 'objectives are immutable');
END;

CREATE TRIGGER objectives_no_delete
BEFORE DELETE ON objectives
BEGIN
  SELECT RAISE(ABORT, 'objectives are immutable');
END;

CREATE TRIGGER objective_acceptance_keys_no_update
BEFORE UPDATE ON objective_acceptance_keys
BEGIN
  SELECT RAISE(ABORT, 'objective acceptance keys are immutable');
END;

CREATE TRIGGER objective_acceptance_keys_no_delete
BEFORE DELETE ON objective_acceptance_keys
BEGIN
  SELECT RAISE(ABORT, 'objective acceptance keys are immutable');
END;

CREATE TRIGGER flight_objectives_no_update
BEFORE UPDATE ON flight_objectives
BEGIN
  SELECT RAISE(ABORT, 'flight objectives are immutable');
END;

CREATE TRIGGER flight_objectives_no_delete
BEFORE DELETE ON flight_objectives
BEGIN
  SELECT RAISE(ABORT, 'flight objectives are immutable');
END;

CREATE TRIGGER flight_lanes_no_update
BEFORE UPDATE ON flight_lanes
BEGIN
  SELECT RAISE(ABORT, 'flight lanes are immutable');
END;

CREATE TRIGGER flight_lanes_no_delete
BEFORE DELETE ON flight_lanes
BEGIN
  SELECT RAISE(ABORT, 'flight lanes are immutable');
END;

CREATE TRIGGER flight_task_assignments_no_update
BEFORE UPDATE ON flight_task_assignments
BEGIN
  SELECT RAISE(ABORT, 'flight task assignments are immutable');
END;

CREATE TRIGGER flight_task_assignments_no_delete
BEFORE DELETE ON flight_task_assignments
BEGIN
  SELECT RAISE(ABORT, 'flight task assignments are immutable');
END;

CREATE TRIGGER flight_dependencies_no_update
BEFORE UPDATE ON flight_dependencies
BEGIN
  SELECT RAISE(ABORT, 'flight dependencies are immutable');
END;

CREATE TRIGGER flight_dependencies_no_delete
BEFORE DELETE ON flight_dependencies
BEGIN
  SELECT RAISE(ABORT, 'flight dependencies are immutable');
END;
