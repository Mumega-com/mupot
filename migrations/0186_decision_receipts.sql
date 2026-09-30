-- 0186_decision_receipts.sql — receipts for the decision-model port (src/decisions).
--
-- WHY: a decision model (TypeSafe Jev today; any small classifier/judge later) may RANK or
-- PROPOSE, never AUTHORIZE. Every call through decide() writes exactly one receipt, success
-- or failure, so the proposal, the exact model version that produced it, and what it was
-- shown (as HASHES only) are auditable. The raw input text is never stored.
--
-- CREATE-only: no existing table is rebuilt (D1 runs a migration file as one transaction and
-- FK RESTRICT is never deferred; nothing here touches an existing table's rows).
--
-- Append-only, same no_update/no_delete trigger pair as oauth_consent_receipts (0091) and
-- agent_audit (0086). A human's later accept/override is a SEPARATE append-only row type
-- (decision_outcomes), never an UPDATE of the receipt. This migration adds no writer for it.

CREATE TABLE IF NOT EXISTS decision_receipts (
  id             TEXT PRIMARY KEY,
  tenant         TEXT,
  use_case       TEXT NOT NULL,
  data_class     TEXT NOT NULL,
  adapter_id     TEXT NOT NULL,
  model          TEXT,
  model_version  TEXT,             -- exact id the provider RETURNED, not an alias
  criteria_hash  TEXT NOT NULL,    -- sha256 hex of canonical {criteriaVersion, questions}
  input_hash     TEXT NOT NULL,    -- sha256 hex of canonical {useCase, dataClass, fenced state}
  answers_json   TEXT CHECK (answers_json IS NULL OR json_valid(answers_json)),
  threshold_json TEXT NOT NULL,
  outcome        TEXT NOT NULL CHECK (outcome IN ('proposed', 'declined_low_confidence', 'failed', 'deferred_to_human')),
  reason         TEXT,
  latency_ms     INTEGER NOT NULL,
  input_tokens   INTEGER,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_decision_receipts_use_case
  ON decision_receipts(use_case, created_at DESC);

CREATE TRIGGER decision_receipts_no_update
BEFORE UPDATE ON decision_receipts
BEGIN
  SELECT RAISE(ABORT, 'decision_receipts is append-only: UPDATE is forbidden');
END;

CREATE TRIGGER decision_receipts_no_delete
BEFORE DELETE ON decision_receipts
BEGIN
  SELECT RAISE(ABORT, 'decision_receipts is append-only: DELETE is forbidden');
END;

CREATE TABLE IF NOT EXISTS decision_outcomes (
  id               TEXT PRIMARY KEY,
  receipt_id       TEXT NOT NULL REFERENCES decision_receipts(id) ON DELETE RESTRICT,
  actor_member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  outcome          TEXT NOT NULL CHECK (outcome IN ('accepted', 'overridden')),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_decision_outcomes_receipt
  ON decision_outcomes(receipt_id, created_at DESC);

-- Only a receipt that actually carried a proposal can be accepted or overridden.
CREATE TRIGGER decision_outcomes_only_proposed
BEFORE INSERT ON decision_outcomes
WHEN COALESCE((SELECT outcome FROM decision_receipts WHERE id = NEW.receipt_id), '') <> 'proposed'
BEGIN
  SELECT RAISE(ABORT, 'decision_outcomes: receipt is not a proposed decision');
END;

CREATE TRIGGER decision_outcomes_no_update
BEFORE UPDATE ON decision_outcomes
BEGIN
  SELECT RAISE(ABORT, 'decision_outcomes is append-only: UPDATE is forbidden');
END;

CREATE TRIGGER decision_outcomes_no_delete
BEFORE DELETE ON decision_outcomes
BEGIN
  SELECT RAISE(ABORT, 'decision_outcomes is append-only: DELETE is forbidden');
END;
