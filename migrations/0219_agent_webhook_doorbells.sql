-- 0219_agent_webhook_doorbells.sql — per-agent Grok Bot webhook doorbell.
--
-- Chair (Hadi): when agent A `send`s to agent B, if B has a registered doorbell,
-- the pot POSTs B's webhook so B's Grok Bot routine wakes and peeks pot. The
-- inbox row stays the letter / source of truth. The POST is a hint only.
--
-- WHY A NEW TABLE, NOT wake_contract.emit_url
--
-- mint_agent_token's wake_contract.emit_url is INBOUND: POST <origin>/bus/emit
-- with type agent.wake and an operator bearer, to wake AgentDO inside the pot.
-- A Grok Bot doorbell is OUTBOUND: the pot POSTs an external https URL that
-- belongs to the recipient's Bot. Reusing emit_url would point the Bot at the
-- pot and invert the direction.
--
-- WHY NOT the Hermes message.created consumer
--
-- src/bus/hermes-delivery.ts is pot-wide, HMAC-signed, and THROWS on 5xx so
-- the Queue retries / DLQ. A Bot 500 on that path would retry Hermes too.
-- The doorbell fires fail-open from sendAgentMessage after the INSERT, with
-- its own short timeout, and never fails the send.
--
-- SECRET PATTERN (house vault, not D1 plaintext)
--
-- The doorbell bearer is AES-GCM-256 under CONNECTOR_MASTER_KEY (Worker
-- secret), HKDF info `mupot_connector_agent_doorbell_v1`, salt = agent_id, AAD
-- `doorbell:<agent_id>`. Same primitive as connectors (src/connectors/crypto.ts encryptConnectorSecret). D1 stores only
-- ciphertext + last4. Get/list/logs never see the bearer. Fail-closed on set
-- if the master key is missing. This is not a new Worker secret name — one
-- pot-level key, domain-separated info string (VaultDomain 'agent_doorbell').
--
-- Behind the WEBHOOK_DOORBELL flag (default off). The receipts table below holds
-- one row per delivery attempt: status code and a short reason only, never the
-- URL, its query, the bearer or the ciphertext.
--
-- Renumbered from 0147 to 0219 when #1344 was superseded (main was at 0217).

CREATE TABLE IF NOT EXISTS agent_webhook_doorbells (
  tenant                TEXT NOT NULL,
  agent_id              TEXT NOT NULL,
  webhook_url           TEXT NOT NULL,
  auth_ciphertext       TEXT NOT NULL,
  auth_last4            TEXT NOT NULL,
  created_by_member_id  TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (tenant, agent_id),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_webhook_doorbell_receipts (
  id            TEXT PRIMARY KEY,
  tenant        TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  event_type    TEXT NOT NULL CHECK (event_type IN ('mupot.inbox.wake', 'mupot.task.assigned', 'mupot.doorbell.test')),
  ref_id        TEXT NOT NULL,
  -- 'claimed' is the coalescing window row, finalized in place to posted/failed/skipped after the POST
  outcome       TEXT NOT NULL CHECK (outcome IN ('claimed', 'posted', 'failed', 'skipped')),
  http_status   INTEGER,
  reason        TEXT,
  attempted_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_webhook_doorbell_receipts_agent
  ON agent_webhook_doorbell_receipts (tenant, agent_id, attempted_at);
