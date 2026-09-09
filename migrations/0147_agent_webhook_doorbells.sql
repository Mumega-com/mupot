-- 0147_agent_webhook_doorbells.sql — per-agent Grok Bot webhook doorbell.
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
-- secret), HKDF info `mupot_doorbell_v1`, salt = agent_id. Same primitive as
-- connectors (src/connectors/crypto.ts encryptDomainSecret). D1 stores only
-- ciphertext + last4. Get/list/logs never see the bearer. Fail-closed on set
-- if the master key is missing. This is not a new Worker secret name — one
-- pot-level key, domain-separated info string.
--
-- Production applied head at the time of this file is ≥0146. Do not renumber
-- ≤0079 (mupot#729).

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
