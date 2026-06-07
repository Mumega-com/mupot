-- K3 fix: gate_grants table.
--
-- Problem: capabilities table CHECK only allows ('owner','admin','lead','member','observer').
-- 'gate:*' strings are un-insertable there, making callerHoldsGateCapability structurally
-- inert — only org owner/admin (legacy bypass) could ever verdict.
--
-- Solution: a separate gate_grants table stores who may hold a given gate capability.
-- principal_type distinguishes member (human) vs agent (autonomous).
-- granted_by + created_at provide a minimal audit trail (grants are not receipts;
-- revoke = hard delete is acceptable since the task_verdicts row IS the audit receipt).
--
-- callerHoldsGateCapability is updated to query gate_grants (with the legacy owner/admin
-- bypass retained for backwards compatibility).
--
-- Admin routes POST + DELETE /api/gates/grants allow owner/admin to manage grants
-- so the capability is administrable, not just schema-defined.

CREATE TABLE IF NOT EXISTS gate_grants (
  id             TEXT NOT NULL PRIMARY KEY,
  capability     TEXT NOT NULL,                           -- e.g. 'gate:outreach'
  principal_type TEXT NOT NULL CHECK (principal_type IN ('member', 'agent')),
  principal_id   TEXT NOT NULL,                           -- member_id or agent_id
  granted_by     TEXT NOT NULL,                           -- member_id of the granter
  created_at     TEXT NOT NULL,                           -- ISO-8601
  UNIQUE (capability, principal_type, principal_id)
);

CREATE INDEX IF NOT EXISTS idx_gate_grants_principal ON gate_grants (principal_type, principal_id);
CREATE INDEX IF NOT EXISTS idx_gate_grants_capability ON gate_grants (capability);

-- K8 fix: append-only triggers on task_verdicts.
-- Verdicts are immutable receipts. Once written they must never be silently altered
-- or deleted. These triggers fire BEFORE UPDATE or DELETE and raise ABORT so the
-- operation is rolled back at the SQLite level — no application-layer guard can be
-- bypassed.

CREATE TRIGGER IF NOT EXISTS task_verdicts_no_update
  BEFORE UPDATE ON task_verdicts
BEGIN
  SELECT RAISE(ABORT, 'verdicts are append-only: UPDATE is forbidden');
END;

CREATE TRIGGER IF NOT EXISTS task_verdicts_no_delete
  BEFORE DELETE ON task_verdicts
BEGIN
  SELECT RAISE(ABORT, 'verdicts are append-only: DELETE is forbidden');
END;
