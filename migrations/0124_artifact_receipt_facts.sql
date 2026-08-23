-- Content-addressed artifact metadata, independent retrieval evidence, and child consumption.
-- These rows assert facts only; they do not write or claim R2 bytes.

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  flight_id TEXT NOT NULL REFERENCES flights(id) ON DELETE RESTRICT,
  producing_assignment_id TEXT NOT NULL
    REFERENCES flight_task_assignments(id) ON DELETE RESTRICT,
  producing_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  producing_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  producing_runtime_seat_id TEXT NOT NULL REFERENCES runtime_seats(id) ON DELETE RESTRICT,
  assignment_epoch INTEGER NOT NULL CHECK (assignment_epoch > 0),
  object_key TEXT NOT NULL CHECK (length(trim(object_key)) BETWEEN 1 AND 1024),
  digest TEXT NOT NULL
    CHECK (
      length(digest) = 64
      AND digest = lower(digest)
      AND digest NOT GLOB '*[^0-9a-f]*'
    ),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  visibility TEXT NOT NULL CHECK (visibility IN ('tenant','gate','public')),
  retention_until TEXT NOT NULL CHECK (length(trim(retention_until)) > 0),
  repository_url TEXT,
  commit_sha TEXT,
  repository_path TEXT,
  storage_receipt_id TEXT NOT NULL UNIQUE
    REFERENCES execution_receipts(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  UNIQUE (tenant, object_key)
);

CREATE INDEX idx_artifacts_flight_task
  ON artifacts(tenant, flight_id, producing_task_id, assignment_epoch);
CREATE INDEX idx_artifacts_digest
  ON artifacts(tenant, digest);

CREATE TABLE artifact_retrieval_receipts (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  verifier_principal_kind TEXT NOT NULL
    CHECK (verifier_principal_kind IN ('member','agent','system','controller')),
  verifier_principal_id TEXT NOT NULL,
  verifier_agent_id TEXT REFERENCES agents(id) ON DELETE RESTRICT,
  verifier_runtime_seat_id TEXT REFERENCES runtime_seats(id) ON DELETE RESTRICT,
  recomputed_digest TEXT NOT NULL
    CHECK (
      length(recomputed_digest) = 64
      AND recomputed_digest = lower(recomputed_digest)
      AND recomputed_digest NOT GLOB '*[^0-9a-f]*'
    ),
  retrieval_receipt_id TEXT NOT NULL UNIQUE
    REFERENCES execution_receipts(id) ON DELETE RESTRICT,
  retrieved_at TEXT NOT NULL CHECK (length(trim(retrieved_at)) > 0),
  UNIQUE (tenant, artifact_id, verifier_principal_kind, verifier_principal_id)
);

CREATE INDEX idx_artifact_retrievals_artifact
  ON artifact_retrieval_receipts(tenant, artifact_id, retrieved_at);

CREATE TABLE flight_dependency_artifacts (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  flight_dependency_id TEXT NOT NULL
    REFERENCES flight_dependencies(id) ON DELETE RESTRICT,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  consuming_flight_id TEXT NOT NULL REFERENCES flights(id) ON DELETE RESTRICT,
  consuming_task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
  consuming_assignment_id TEXT REFERENCES flight_task_assignments(id) ON DELETE RESTRICT,
  consumption_receipt_id TEXT NOT NULL UNIQUE
    REFERENCES execution_receipts(id) ON DELETE RESTRICT,
  consumed_at TEXT NOT NULL CHECK (length(trim(consumed_at)) > 0),
  UNIQUE (tenant, flight_dependency_id, artifact_id, consuming_flight_id)
);

CREATE INDEX idx_flight_dependency_artifacts_consumer
  ON flight_dependency_artifacts(tenant, consuming_flight_id, consumed_at);

CREATE TRIGGER artifacts_no_update
BEFORE UPDATE ON artifacts
BEGIN
  SELECT RAISE(ABORT, 'artifacts are immutable');
END;

CREATE TRIGGER artifacts_no_delete
BEFORE DELETE ON artifacts
BEGIN
  SELECT RAISE(ABORT, 'artifacts are immutable');
END;

CREATE TRIGGER artifact_retrievals_independent_agent
BEFORE INSERT ON artifact_retrieval_receipts
WHEN NEW.verifier_agent_id IS NOT NULL AND EXISTS (
  SELECT 1
  FROM artifacts
  WHERE id = NEW.artifact_id
    AND tenant = NEW.tenant
    AND producing_agent_id = NEW.verifier_agent_id
)
BEGIN
  SELECT RAISE(ABORT, 'artifact retrieval verifier must be independent');
END;

CREATE TRIGGER artifact_retrieval_receipts_no_update
BEFORE UPDATE ON artifact_retrieval_receipts
BEGIN
  SELECT RAISE(ABORT, 'artifact retrieval receipts are append-only');
END;

CREATE TRIGGER artifact_retrieval_receipts_no_delete
BEFORE DELETE ON artifact_retrieval_receipts
BEGIN
  SELECT RAISE(ABORT, 'artifact retrieval receipts are append-only');
END;

CREATE TRIGGER flight_dependency_artifacts_no_update
BEFORE UPDATE ON flight_dependency_artifacts
BEGIN
  SELECT RAISE(ABORT, 'flight dependency artifacts are immutable');
END;

CREATE TRIGGER flight_dependency_artifacts_no_delete
BEFORE DELETE ON flight_dependency_artifacts
BEGIN
  SELECT RAISE(ABORT, 'flight dependency artifacts are immutable');
END;
