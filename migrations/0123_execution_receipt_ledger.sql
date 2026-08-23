-- Tenant-scoped execution receipt hash chains.
-- The head is a mutable projection; receipts and semantic edges are append-only evidence.

CREATE TABLE execution_receipts (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  tenant TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'objective.authorized','objective.accepted','composition.proposed',
    'flight.materialized','task.assigned','message.accepted',
    'seat.leased','host.persisted','effect.intent','runtime.injected',
    'runtime.consumed','provider.observed','provider.reconciled',
    'runtime.ack','source.ack','artifact.stored','artifact.retrieved',
    'result.reported','gate.verdict','task.completed','cost.finalized',
    'recovery.takeover','flight.landed','host_control.requested',
    'host_control.observed','decision.created','decision.resolved'
  )),
  issuer_kind TEXT NOT NULL CHECK (issuer_kind = 'mupot'),
  issuer_id TEXT NOT NULL CHECK (length(trim(issuer_id)) > 0),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('member','agent','system','controller')),
  actor_id TEXT NOT NULL CHECK (length(trim(actor_id)) > 0),
  objective_id TEXT,
  flight_id TEXT,
  task_id TEXT,
  message_id TEXT,
  assignment_epoch INTEGER CHECK (assignment_epoch IS NULL OR assignment_epoch >= 0),
  fencing_epoch INTEGER CHECK (fencing_epoch IS NULL OR fencing_epoch > 0),
  lease_token_hash TEXT
    CHECK (
      lease_token_hash IS NULL
      OR (
        length(lease_token_hash) = 64
        AND lease_token_hash = lower(lease_token_hash)
        AND lease_token_hash NOT GLOB '*[^0-9a-f]*'
      )
    ),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 255),
  claims_json TEXT NOT NULL CHECK (json_valid(claims_json)),
  canonical_payload TEXT NOT NULL CHECK (json_valid(canonical_payload)),
  payload_digest TEXT NOT NULL
    CHECK (
      length(payload_digest) = 64
      AND payload_digest = lower(payload_digest)
      AND payload_digest NOT GLOB '*[^0-9a-f]*'
    ),
  predecessor_receipt_id TEXT REFERENCES execution_receipts(id) ON DELETE RESTRICT,
  predecessor_hash TEXT
    CHECK (
      predecessor_hash IS NULL
      OR (
        length(predecessor_hash) = 64
        AND predecessor_hash = lower(predecessor_hash)
        AND predecessor_hash NOT GLOB '*[^0-9a-f]*'
      )
    ),
  receipt_hash TEXT NOT NULL
    CHECK (
      length(receipt_hash) = 64
      AND receipt_hash = lower(receipt_hash)
      AND receipt_hash NOT GLOB '*[^0-9a-f]*'
    ),
  server_timestamp TEXT NOT NULL CHECK (length(trim(server_timestamp)) > 0),
  CHECK (
    (predecessor_receipt_id IS NULL AND predecessor_hash IS NULL)
    OR (predecessor_receipt_id IS NOT NULL AND predecessor_hash IS NOT NULL)
  ),
  UNIQUE (tenant, issuer_kind, issuer_id, idempotency_key)
);

CREATE INDEX idx_execution_receipts_tenant_sequence
  ON execution_receipts(tenant, sequence);
CREATE INDEX idx_execution_receipts_flight_sequence
  ON execution_receipts(tenant, flight_id, sequence)
  WHERE flight_id IS NOT NULL;
CREATE INDEX idx_execution_receipts_task_sequence
  ON execution_receipts(tenant, task_id, sequence)
  WHERE task_id IS NOT NULL;

CREATE TABLE execution_receipt_heads (
  tenant TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  receipt_id TEXT NOT NULL REFERENCES execution_receipts(id) ON DELETE RESTRICT,
  receipt_hash TEXT NOT NULL
    CHECK (
      length(receipt_hash) = 64
      AND receipt_hash = lower(receipt_hash)
      AND receipt_hash NOT GLOB '*[^0-9a-f]*'
    ),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0)
);

CREATE TABLE execution_receipt_edges (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  from_receipt_id TEXT NOT NULL REFERENCES execution_receipts(id) ON DELETE RESTRICT,
  to_receipt_id TEXT NOT NULL REFERENCES execution_receipts(id) ON DELETE RESTRICT,
  relation TEXT NOT NULL CHECK (relation IN (
    'predecessor','authorizes','correlates','consumes','verifies','resolves'
  )),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  CHECK (from_receipt_id <> to_receipt_id),
  UNIQUE (tenant, from_receipt_id, to_receipt_id, relation)
);

CREATE INDEX idx_execution_receipt_edges_to
  ON execution_receipt_edges(tenant, to_receipt_id, relation);

CREATE TRIGGER execution_receipt_heads_monotonic
BEFORE UPDATE ON execution_receipt_heads
WHEN NEW.sequence <= OLD.sequence
BEGIN
  SELECT RAISE(ABORT, 'execution receipt head sequence must advance');
END;

CREATE TRIGGER execution_receipt_heads_no_delete
BEFORE DELETE ON execution_receipt_heads
BEGIN
  SELECT RAISE(ABORT, 'execution receipt heads cannot be deleted');
END;

CREATE TRIGGER execution_receipts_no_update
BEFORE UPDATE ON execution_receipts
BEGIN
  SELECT RAISE(ABORT, 'execution receipts are append-only');
END;

CREATE TRIGGER execution_receipts_no_delete
BEFORE DELETE ON execution_receipts
BEGIN
  SELECT RAISE(ABORT, 'execution receipts are append-only');
END;

CREATE TRIGGER execution_receipt_edges_no_update
BEFORE UPDATE ON execution_receipt_edges
BEGIN
  SELECT RAISE(ABORT, 'execution receipt edges are append-only');
END;

CREATE TRIGGER execution_receipt_edges_no_delete
BEFORE DELETE ON execution_receipt_edges
BEGIN
  SELECT RAISE(ABORT, 'execution receipt edges are append-only');
END;
