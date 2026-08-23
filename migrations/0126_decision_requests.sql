-- Authority and business decisions only. Operational retry exhaustion is not a decision class.

CREATE TABLE decision_requests (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  decision_class TEXT NOT NULL CHECK (decision_class IN (
    'credential','deployment_or_migration','destructive',
    'spend','cross_tenant','business_choice'
  )),
  dedupe_key TEXT NOT NULL CHECK (length(trim(dedupe_key)) BETWEEN 1 AND 255),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','resolved','expired','cancelled')),
  exact_authority_required TEXT NOT NULL
    CHECK (length(trim(exact_authority_required)) BETWEEN 1 AND 2000),
  question TEXT NOT NULL CHECK (length(trim(question)) BETWEEN 1 AND 4000),
  options_json TEXT NOT NULL
    CHECK (json_valid(options_json) AND json_type(options_json) = 'array'),
  consequences_json TEXT NOT NULL CHECK (json_valid(consequences_json)),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  objective_id TEXT,
  flight_id TEXT,
  task_id TEXT,
  requested_by_principal_kind TEXT NOT NULL CHECK (requested_by_principal_kind IN (
    'member','agent','system','controller'
  )),
  requested_by_principal_id TEXT NOT NULL,
  requested_by_member_id TEXT,
  expires_at TEXT NOT NULL CHECK (length(trim(expires_at)) > 0),
  created_receipt_id TEXT REFERENCES execution_receipts(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  resolved_at TEXT,
  CHECK (
    (status = 'open' AND resolved_at IS NULL)
    OR (status <> 'open')
  )
);

CREATE UNIQUE INDEX idx_decision_requests_one_open_dedupe
  ON decision_requests(tenant, dedupe_key)
  WHERE status = 'open';
CREATE INDEX idx_decision_requests_open_expiry
  ON decision_requests(tenant, status, expires_at);
CREATE INDEX idx_decision_requests_flight
  ON decision_requests(tenant, flight_id, status)
  WHERE flight_id IS NOT NULL;

CREATE TABLE decision_request_resolutions (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  decision_request_id TEXT NOT NULL
    REFERENCES decision_requests(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 255),
  resolved_by_principal_kind TEXT NOT NULL
    CHECK (resolved_by_principal_kind IN ('member','agent')),
  resolved_by_principal_id TEXT NOT NULL,
  resolved_by_member_id TEXT NOT NULL,
  resolution_json TEXT NOT NULL CHECK (json_valid(resolution_json)),
  consequences_accepted_json TEXT NOT NULL CHECK (json_valid(consequences_accepted_json)),
  resolution_receipt_id TEXT NOT NULL UNIQUE
    REFERENCES execution_receipts(id) ON DELETE RESTRICT,
  resolved_at TEXT NOT NULL CHECK (length(trim(resolved_at)) > 0),
  UNIQUE (tenant, decision_request_id),
  UNIQUE (tenant, idempotency_key)
);

CREATE TRIGGER decision_requests_identity_immutable
BEFORE UPDATE OF id, tenant, decision_class, dedupe_key,
  exact_authority_required, question, options_json, consequences_json,
  evidence_json, objective_id, flight_id, task_id,
  requested_by_principal_kind, requested_by_principal_id,
  requested_by_member_id, expires_at, created_receipt_id, created_at
ON decision_requests
BEGIN
  SELECT RAISE(ABORT, 'decision request identity is immutable');
END;

CREATE TRIGGER decision_requests_terminal_transition
BEFORE UPDATE OF status ON decision_requests
WHEN OLD.status <> 'open' OR NEW.status NOT IN ('resolved','expired','cancelled')
BEGIN
  SELECT RAISE(ABORT, 'decision request transition is invalid');
END;

CREATE TRIGGER decision_requests_no_delete
BEFORE DELETE ON decision_requests
BEGIN
  SELECT RAISE(ABORT, 'decision requests cannot be deleted');
END;

CREATE TRIGGER decision_request_resolutions_no_update
BEFORE UPDATE ON decision_request_resolutions
BEGIN
  SELECT RAISE(ABORT, 'decision request resolutions are immutable');
END;

CREATE TRIGGER decision_request_resolutions_no_delete
BEFORE DELETE ON decision_request_resolutions
BEGIN
  SELECT RAISE(ABORT, 'decision request resolutions are immutable');
END;
