-- Native exact-runtime receipts for externally bridged task_dispatch work (#1240).
--
-- task_dispatch_receipts.consumed_at remains the Queue transport-side receipt.
-- This append-only table records the later desktop-runtime stages and anchors every
-- row to the exact task, assigned agent, durable inbox message, caller member/token,
-- and atomic mutation audit entry.

CREATE TABLE task_dispatch_runtime_receipts (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  dispatch_receipt_id TEXT NOT NULL
    REFERENCES task_dispatch_receipts(id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  message_id TEXT NOT NULL REFERENCES agent_messages(id) ON DELETE RESTRICT,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  credential_id TEXT NOT NULL REFERENCES member_tokens(id) ON DELETE RESTRICT,
  stage TEXT NOT NULL CHECK (stage IN ('runtime_consumed', 'completed', 'failed')),
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 5),
  runtime_address TEXT NOT NULL CHECK (length(trim(runtime_address)) BETWEEN 1 AND 255),
  runtime_receipt_hash TEXT NOT NULL CHECK (
    length(runtime_receipt_hash) = 64
    AND runtime_receipt_hash = lower(runtime_receipt_hash)
    AND runtime_receipt_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64
    AND request_digest = lower(request_digest)
    AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  artifact_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(artifact_refs_json)
    AND json_type(artifact_refs_json) = 'array'
  ),
  artifact_sha256 TEXT CHECK (
    artifact_sha256 IS NULL
    OR (
      length(artifact_sha256) = 64
      AND artifact_sha256 = lower(artifact_sha256)
      AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  result TEXT CHECK (result IS NULL OR length(result) BETWEEN 1 AND 20000),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 2000),
  audit_entry_id TEXT NOT NULL UNIQUE
    REFERENCES mutation_audit_entries(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  CHECK (stage <> 'completed' OR result IS NOT NULL),
  CHECK (stage <> 'failed' OR reason IS NOT NULL),
  UNIQUE (tenant, dispatch_receipt_id, stage, attempt)
);

CREATE INDEX idx_task_dispatch_runtime_receipts_task
  ON task_dispatch_runtime_receipts(tenant, task_id, created_at, id);

CREATE INDEX idx_task_dispatch_runtime_receipts_message
  ON task_dispatch_runtime_receipts(tenant, message_id, attempt, stage);

CREATE TRIGGER task_dispatch_runtime_receipts_no_update
BEFORE UPDATE ON task_dispatch_runtime_receipts
BEGIN
  SELECT RAISE(ABORT, 'task dispatch runtime receipts are append-only');
END;

CREATE TRIGGER task_dispatch_runtime_receipts_no_delete
BEFORE DELETE ON task_dispatch_runtime_receipts
BEGIN
  SELECT RAISE(ABORT, 'task dispatch runtime receipts are append-only');
END;
