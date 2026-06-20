-- 0034_fleet_control_log.sql — audit trail for fleet control-requests (Deliverable 2).
--
-- Every panel/agent request to start|stop|status|restart a HOST process is recorded here BEFORE
-- it leaves the pot: who asked (the authenticated member — the real principal, never read from
-- body), which agent + verb, the single-use nonce, and the agent_messages seq the signed
-- control-request landed at. This is the accountability record for a high-stakes action (remote
-- host control). The control-request itself rides the agent inbox (0032); this is the ledger.
--
-- Tenant is environment-derived (env.TENANT_SLUG); a row can never reference another pot.

CREATE TABLE IF NOT EXISTS fleet_control_log (
  id                  TEXT PRIMARY KEY,                       -- uuid
  tenant              TEXT NOT NULL,                          -- = TENANT_SLUG, isolation
  agent_id            TEXT NOT NULL,                          -- the controlled agent (manifest id)
  verb                TEXT NOT NULL,                          -- start | stop | status | restart
  nonce               TEXT NOT NULL,                          -- the control-request's single-use nonce
  requested_by_member TEXT NOT NULL,                          -- the authenticated principal (accountability)
  requested_by_agent  TEXT,                                   -- the bound agent, if the token was agent-welded (else NULL = operator)
  message_seq         INTEGER,                                -- agent_messages.seq the request landed at (NULL = send refused)
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fleet_control_log_recent
  ON fleet_control_log(tenant, created_at DESC);
