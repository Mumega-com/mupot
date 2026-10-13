-- 0217_agent_operator_delegations.sql — Operators + Admission, wave W0: delegated operators (mupot task 65b11e48,
-- mumega-com#1386). Additive only; nothing reads these tables unless DELEGATED_OPERATORS is on (the HTTP-door fix
-- for #1357 does not depend on them).
--
-- A delegation is a HUMAN's standing permission for ONE agent to organise structure inside ONE scope. It is not a
-- capability grant and it never makes the agent an admin: max_grant is a CHECK-bounded ceiling of 'member' or 'lead'.
-- The authority is re-derived on every request from the delegator's live rank (src/operators/chokepoint.ts), so a
-- delegation whose delegator lost admin is inert even though this row is still live.

CREATE TABLE IF NOT EXISTS agent_operator_delegations (
  id                    TEXT PRIMARY KEY,
  tenant                TEXT NOT NULL,
  agent_id              TEXT NOT NULL,
  delegator_member_id   TEXT NOT NULL,
  scope_type            TEXT NOT NULL CHECK (scope_type IN ('org', 'department', 'squad', 'project')),
  -- NULL for org scope; a non-empty id for the other three. Enforced here, not only in code.
  scope_id              TEXT,
  max_grant             TEXT NOT NULL CHECK (max_grant IN ('member', 'lead')),
  created_by_member_id  TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at            TEXT,
  CHECK ((scope_type = 'org' AND scope_id IS NULL) OR (scope_type <> 'org' AND scope_id IS NOT NULL AND length(trim(scope_id)) > 0)),
  -- The human who creates a delegation is the delegator: nobody delegates on someone else's authority.
  CHECK (created_by_member_id = delegator_member_id)
);

-- At most ONE live row per (agent, scope). Re-delegating after a revoke is a NEW row, so the history is never rewritten.
CREATE UNIQUE INDEX IF NOT EXISTS uq_operator_delegation_live
  ON agent_operator_delegations(tenant, agent_id, scope_type, COALESCE(scope_id, ''))
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_operator_delegation_agent
  ON agent_operator_delegations(tenant, agent_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_operator_delegation_delegator
  ON agent_operator_delegations(tenant, delegator_member_id);

-- A row is immutable except for the one-way NULL -> timestamp revoke. Nothing can un-revoke, widen max_grant, move the
-- scope, or swap the delegator: those are all "revoke and create a new row", which is a human act with its own receipt.
CREATE TRIGGER IF NOT EXISTS agent_operator_delegations_immutable
BEFORE UPDATE ON agent_operator_delegations
WHEN NOT (
  OLD.revoked_at IS NULL
  AND NEW.revoked_at IS NOT NULL
  AND NEW.id = OLD.id AND NEW.tenant = OLD.tenant AND NEW.agent_id = OLD.agent_id
  AND NEW.delegator_member_id = OLD.delegator_member_id
  AND NEW.scope_type = OLD.scope_type AND COALESCE(NEW.scope_id, '') = COALESCE(OLD.scope_id, '')
  AND NEW.max_grant = OLD.max_grant
  AND NEW.created_by_member_id = OLD.created_by_member_id AND NEW.created_at = OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'agent_operator_delegations: only a one-way revoke is allowed');
END;

CREATE TRIGGER IF NOT EXISTS agent_operator_delegations_no_delete
BEFORE DELETE ON agent_operator_delegations
BEGIN
  SELECT RAISE(ABORT, 'agent_operator_delegations: rows are never deleted');
END;

-- Every structural write an agent makes under a delegation leaves one row here BEFORE the write is attempted: "agent X
-- on behalf of member Y, under delegation Z, did act A on target T". An authorization receipt, so an act that then fails
-- downstream still leaves a row, and no applied write can exist without one. No foreign keys, on purpose (same reasoning
-- as agent_audit, #857): the record must outlive the agent, the member and the delegation it names.
CREATE TABLE IF NOT EXISTS operator_delegation_receipts (
  seq                  INTEGER PRIMARY KEY AUTOINCREMENT,
  id                   TEXT NOT NULL UNIQUE,
  tenant               TEXT NOT NULL,
  delegation_id        TEXT NOT NULL,
  agent_id             TEXT NOT NULL,
  delegator_member_id  TEXT NOT NULL,
  action               TEXT NOT NULL,
  surface              TEXT NOT NULL CHECK (surface IN ('mcp', 'http')),
  target_scope_type    TEXT,
  target_scope_id      TEXT,
  detail               TEXT NOT NULL DEFAULT '{}',
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_operator_receipts_delegation ON operator_delegation_receipts(delegation_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_operator_receipts_agent ON operator_delegation_receipts(tenant, agent_id, seq DESC);

CREATE TRIGGER IF NOT EXISTS operator_delegation_receipts_no_update
BEFORE UPDATE ON operator_delegation_receipts
BEGIN
  SELECT RAISE(ABORT, 'operator_delegation_receipts is append-only');
END;

CREATE TRIGGER IF NOT EXISTS operator_delegation_receipts_no_delete
BEFORE DELETE ON operator_delegation_receipts
BEGIN
  SELECT RAISE(ABORT, 'operator_delegation_receipts is append-only');
END;
