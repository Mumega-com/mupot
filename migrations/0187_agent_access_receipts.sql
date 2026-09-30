-- 0187_agent_access_receipts.sql -- audit trail for the dashboard "Access" panel
-- (POST /agents/:id/access): which human changed which agent's access level on
-- which squad, from what, to what, and why.
--
-- WHY A RECEIPT TABLE: an agent's squad access is two rows (memberships +
-- capabilities) written through setAgentSquadAccess / removeAgentSquadAccess in
-- src/members/agent-access.ts. Neither records WHO asked or from WHAT prior level.
-- The panel writes one receipt row in the SAME D1 batch as those two rows, and the
-- receipt INSERT carries the authority guard, so a receipt exists if and only if
-- the access rows changed (D1 rolls a batch back on a thrown error only, so the
-- guard turns "not authorized / stale" into a NOT NULL violation on id).
--
-- CREATE-only on purpose: D1 runs one migration file as one transaction and a
-- foreign key with ON DELETE RESTRICT is never deferred, so no parent table is
-- touched here.
--
-- Append-only, in the style of oauth_consent_receipts (0091) and agent_audit (0086):
-- no UPDATE and no DELETE, ever.

CREATE TABLE IF NOT EXISTS agent_access_receipts (
  id                TEXT PRIMARY KEY NOT NULL,
  actor_member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,  -- the HUMAN who acted
  agent_id          TEXT NOT NULL REFERENCES agents(id)  ON DELETE RESTRICT,
  squad_id          TEXT NOT NULL REFERENCES squads(id)  ON DELETE RESTRICT,
  prior_capability  TEXT CHECK (prior_capability IN ('observer','member','lead','admin')),  -- the capabilities row before, NULL = none
  prior_membership  TEXT CHECK (prior_membership IN ('observer','member','lead','admin')),  -- the memberships row before, NULL = none
  new_capability    TEXT CHECK (new_capability   IN ('observer','member','lead','admin')),
  action            TEXT NOT NULL CHECK (action IN ('enroll','change','revoke')),
  reason            TEXT CHECK (reason IS NULL OR length(reason) <= 500),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- The action label must agree with the capability columns. The two tables can differ
  -- (or hold only one row), so a receipt records BOTH priors: a change to either row is
  -- never hidden behind the other. A 'change' must move at least one row to the new level.
  CHECK (
    (action = 'enroll' AND prior_capability IS NULL AND prior_membership IS NULL
        AND new_capability IS NOT NULL)
    OR (action = 'change' AND (prior_capability IS NOT NULL OR prior_membership IS NOT NULL)
        AND new_capability IS NOT NULL
        AND (prior_capability IS NOT new_capability OR prior_membership IS NOT new_capability))
    OR (action = 'revoke' AND (prior_capability IS NOT NULL OR prior_membership IS NOT NULL)
        AND new_capability IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_agent_access_receipts_agent
  ON agent_access_receipts(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_access_receipts_squad
  ON agent_access_receipts(squad_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_access_receipts_actor
  ON agent_access_receipts(actor_member_id, created_at DESC);

CREATE TRIGGER agent_access_receipts_no_update
BEFORE UPDATE ON agent_access_receipts
BEGIN
  SELECT RAISE(ABORT, 'agent_access_receipts is append-only: UPDATE is forbidden');
END;

CREATE TRIGGER agent_access_receipts_no_delete
BEFORE DELETE ON agent_access_receipts
BEGIN
  SELECT RAISE(ABORT, 'agent_access_receipts is append-only: DELETE is forbidden');
END;
