-- Durable CAS ledger for the governed priority engine.
-- Soft TEXT references only: this is a decision/execution receipt log, not a
-- parallel task queue, and it must survive synthetic canary IDs in tests.

CREATE TABLE priority_engine_reservations (
  idempotency_key TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('inflight', 'final')),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0)
);

CREATE TABLE priority_engine_claims (
  task_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0)
);

CREATE TABLE priority_engine_receipts (
  idempotency_key TEXT PRIMARY KEY,
  cas_key TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('proposed', 'dispatched', 'none', 'refused', 'failed')),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0)
);

CREATE INDEX idx_priority_engine_claims_key
  ON priority_engine_claims(idempotency_key);

CREATE TRIGGER priority_engine_receipts_no_update
BEFORE UPDATE ON priority_engine_receipts
BEGIN
  SELECT RAISE(ABORT, 'priority engine receipts are append-only');
END;

CREATE TRIGGER priority_engine_receipts_no_delete
BEFORE DELETE ON priority_engine_receipts
BEGIN
  SELECT RAISE(ABORT, 'priority engine receipts are append-only');
END;
