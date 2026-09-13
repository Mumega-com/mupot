-- 0153_inbox_lease_attempt_reconciliation.sql — server-authoritative recovery
-- for ambiguous inbox_lease transport outcomes.

-- This stores the server-derived scope-bound stamp, not the raw client attempt id.
ALTER TABLE agent_messages ADD COLUMN lease_attempt_id TEXT;

CREATE TABLE agent_inbox_lease_attempts (
  tenant TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  target_seat_key TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  request_digest TEXT NOT NULL
                 CHECK (length(request_digest) = 64
                        AND request_digest NOT GLOB '*[^0-9A-Fa-f]*'),
  state TEXT NOT NULL
        CHECK (state IN ('opening','leased','empty','cancelled','expired','acked')),
  message_id TEXT REFERENCES agent_messages(id) ON DELETE RESTRICT,
  message_seq INTEGER,
  delivery_attempt INTEGER,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY (tenant, agent_id, target_seat_key, attempt_id),
  CHECK (
    (state = 'leased'
      AND message_id IS NOT NULL
      AND message_seq IS NOT NULL
      AND delivery_attempt IS NOT NULL
      AND lease_expires_at IS NOT NULL)
    OR
    (state <> 'leased'
      AND message_id IS NULL
      AND message_seq IS NULL
      AND delivery_attempt IS NULL
      AND lease_expires_at IS NULL)
  )
);

CREATE INDEX idx_agent_inbox_lease_attempts_lookup
  ON agent_inbox_lease_attempts(tenant, agent_id, target_seat_key, attempt_id);

CREATE INDEX idx_agent_messages_lease_attempt
  ON agent_messages(tenant, to_agent, lease_attempt_id);
