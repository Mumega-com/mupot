-- Principal-attributed mutation and observed signed host-control facts.
-- Interactive shell and PTY origins are deliberately outside the proof contract.

CREATE TABLE mutation_audit_entries (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  principal_kind TEXT NOT NULL CHECK (principal_kind IN (
    'member','agent','system','controller','admin','migration','fault_injector'
  )),
  principal_id TEXT NOT NULL CHECK (length(trim(principal_id)) > 0),
  member_id TEXT REFERENCES members(id) ON DELETE RESTRICT,
  agent_id TEXT REFERENCES agents(id) ON DELETE RESTRICT,
  credential_id TEXT,
  runtime_seat_id TEXT REFERENCES runtime_seats(id) ON DELETE RESTRICT,
  runtime_generation INTEGER
    CHECK (runtime_generation IS NULL OR runtime_generation > 0),
  origin TEXT NOT NULL CHECK (origin IN (
    'mcp','rest','worker_callback','scheduled_job','controller','admin_ui','migration'
  )),
  handler TEXT NOT NULL CHECK (length(trim(handler)) BETWEEN 1 AND 255),
  operation TEXT NOT NULL CHECK (length(trim(operation)) BETWEEN 1 AND 255),
  target_kind TEXT NOT NULL CHECK (length(trim(target_kind)) BETWEEN 1 AND 120),
  target_id TEXT NOT NULL CHECK (length(trim(target_id)) > 0),
  before_digest TEXT
    CHECK (
      before_digest IS NULL
      OR (
        length(before_digest) = 64
        AND before_digest = lower(before_digest)
        AND before_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
  after_digest TEXT
    CHECK (
      after_digest IS NULL
      OR (
        length(after_digest) = 64
        AND after_digest = lower(after_digest)
        AND after_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
  objective_id TEXT,
  flight_id TEXT,
  task_id TEXT,
  request_id TEXT NOT NULL CHECK (length(trim(request_id)) > 0),
  idempotency_key TEXT,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  recorded_at TEXT NOT NULL CHECK (length(trim(recorded_at)) > 0),
  UNIQUE (tenant, request_id, handler, operation, target_kind, target_id)
);

CREATE INDEX idx_mutation_audit_flight_cursor
  ON mutation_audit_entries(tenant, flight_id, recorded_at)
  WHERE flight_id IS NOT NULL;
CREATE INDEX idx_mutation_audit_task_cursor
  ON mutation_audit_entries(tenant, task_id, recorded_at)
  WHERE task_id IS NOT NULL;
CREATE INDEX idx_mutation_audit_principal_cursor
  ON mutation_audit_entries(tenant, principal_kind, principal_id, recorded_at);

CREATE TABLE host_control_receipts (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  principal_kind TEXT NOT NULL CHECK (principal_kind IN (
    'agent','system','controller','fault_injector'
  )),
  principal_id TEXT NOT NULL CHECK (length(trim(principal_id)) > 0),
  credential_id TEXT,
  runtime_seat_id TEXT REFERENCES runtime_seats(id) ON DELETE RESTRICT,
  origin TEXT NOT NULL CHECK (origin IN ('signed_wrapper','controller','runner')),
  host_id TEXT NOT NULL CHECK (length(trim(host_id)) > 0),
  unit_name TEXT NOT NULL CHECK (length(trim(unit_name)) > 0),
  process_generation INTEGER NOT NULL CHECK (process_generation > 0),
  action TEXT NOT NULL CHECK (action IN (
    'start','stop','restart','signal','replace','fault_inject'
  )),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2000),
  objective_id TEXT,
  flight_id TEXT,
  task_id TEXT,
  request_id TEXT NOT NULL CHECK (length(trim(request_id)) > 0),
  idempotency_key TEXT,
  request_signature_digest TEXT NOT NULL
    CHECK (
      length(request_signature_digest) = 64
      AND request_signature_digest = lower(request_signature_digest)
      AND request_signature_digest NOT GLOB '*[^0-9a-f]*'
    ),
  observation_signature_digest TEXT NOT NULL
    CHECK (
      length(observation_signature_digest) = 64
      AND observation_signature_digest = lower(observation_signature_digest)
      AND observation_signature_digest NOT GLOB '*[^0-9a-f]*'
    ),
  observed_result TEXT NOT NULL CHECK (observed_result IN ('succeeded','failed')),
  request_receipt_id TEXT REFERENCES execution_receipts(id) ON DELETE RESTRICT,
  observation_receipt_id TEXT REFERENCES execution_receipts(id) ON DELETE RESTRICT,
  observed_at TEXT NOT NULL CHECK (length(trim(observed_at)) > 0),
  UNIQUE (tenant, request_id),
  UNIQUE (tenant, observation_receipt_id)
);

CREATE INDEX idx_host_control_flight_cursor
  ON host_control_receipts(tenant, flight_id, observed_at)
  WHERE flight_id IS NOT NULL;
CREATE INDEX idx_host_control_host_cursor
  ON host_control_receipts(tenant, host_id, observed_at);

CREATE TRIGGER mutation_audit_entries_no_update
BEFORE UPDATE ON mutation_audit_entries
BEGIN
  SELECT RAISE(ABORT, 'mutation audit entries are append-only');
END;

CREATE TRIGGER mutation_audit_entries_no_delete
BEFORE DELETE ON mutation_audit_entries
BEGIN
  SELECT RAISE(ABORT, 'mutation audit entries are append-only');
END;

CREATE TRIGGER host_control_receipts_no_update
BEFORE UPDATE ON host_control_receipts
BEGIN
  SELECT RAISE(ABORT, 'host control receipts are append-only');
END;

CREATE TRIGGER host_control_receipts_no_delete
BEFORE DELETE ON host_control_receipts
BEGIN
  SELECT RAISE(ABORT, 'host control receipts are append-only');
END;
