-- mupot — durable department proposals (S4 #318, durability slice).
--
-- The microkernel's gate.propose() stored the proposal CONTENT in a closure-private
-- in-memory Map (_pendingStore). That is lost across requests / Worker isolates — so
-- the real flow (propose in one request → human approves → execute in a LATER request,
-- likely a different isolate) would find no record and fail not_approved.
--
-- This table makes the proposal content DURABLE. gate.propose() write-throughs a row
-- here (in addition to the in-memory fast-path); executor.execute() falls back to it
-- on a map miss. The APPROVAL gate is unchanged — it is still a real task_verdicts row
-- (the BLOCK-1 structural close); this table holds only the content + the
-- tenant/department BINDING that execute() re-checks (cross-tenant/dept reject).
--
-- Append-style: one row per gateId. INSERT OR REPLACE keyed on gate_id is idempotent
-- (a re-propose with the same id overwrites its own content; gate ids are uuid-unique
-- in practice). No secrets are stored here — payload is the proposal's content only.

CREATE TABLE IF NOT EXISTS department_proposals (
  gate_id        TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  department_key TEXT NOT NULL,
  action         TEXT NOT NULL,
  payload_json   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Scope lookups / future cleanup by tenant+department.
CREATE INDEX IF NOT EXISTS idx_department_proposals_scope
  ON department_proposals (tenant_id, department_key);
