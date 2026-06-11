-- 0023_connectors.sql — connector credential vault (issue #116)
--
-- Secure storage for third-party tool credentials (Telegram bot tokens, GHL,
-- Instantly, Apify, McpWP, custom). The raw secret is NEVER stored — only
-- AES-GCM ciphertext (encrypted with a master key from env + per-connector salt).
--
-- Security invariants (enforced at the application layer):
--   1. encrypted_secret is opaque ciphertext — never returned by any list/read query.
--   2. Only resolveConnector() may SELECT encrypted_secret, and only at call-time,
--      to make an outbound tool call. The plaintext is never returned to callers.
--   3. revoked_at IS NOT NULL → the connector is disabled; resolveConnector() returns null.
--   4. Audit events are written by the route layer for every add / rotate / revoke.
--
-- Columns:
--   id               — server-minted UUID
--   tenant           — TENANT_SLUG (every row scoped to the pot that owns it)
--   type             — connector kind: telegram | instantly | ghl | apify | mcpwp | custom
--   label            — human-readable name ("Acme Telegram bot")
--   encrypted_secret — AES-GCM ciphertext. NEVER SELECT outside resolveConnector.
--   meta             — optional JSON blob (e.g. Telegram allowed_chats list)
--   scope_type       — squad | agent | pot  (who this connector is granted to)
--   scope_id         — UUID of the squad/agent; NULL when scope_type = 'pot' (pot-wide)
--   created_by       — member id of the admin who added the connector
--   created_at       — ISO-8601 timestamp
--   revoked_at       — ISO-8601 timestamp; NULL = active; set = revoked (write-only path)
--
-- Index: (tenant, scope_type, scope_id) — the resolveConnector() lookup pattern.

CREATE TABLE IF NOT EXISTS connectors (
  id               TEXT    PRIMARY KEY,
  tenant           TEXT    NOT NULL,
  type             TEXT    NOT NULL,
  label            TEXT    NOT NULL,
  encrypted_secret TEXT    NOT NULL,
  meta             TEXT,
  scope_type       TEXT    NOT NULL DEFAULT 'pot',
  scope_id         TEXT,
  created_by       TEXT    NOT NULL,
  created_at       TEXT    NOT NULL,
  revoked_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_connectors_scope
  ON connectors (tenant, scope_type, scope_id, revoked_at);

-- connector_audit — append-only audit log for add / rotate / revoke.
-- action: add | rotate | revoke
-- actor_id: member id
-- detail: optional JSON context (new type/label on rotate, etc.)

CREATE TABLE IF NOT EXISTS connector_audit (
  id         TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  tenant     TEXT NOT NULL,
  action     TEXT NOT NULL,
  actor_id   TEXT NOT NULL,
  detail     TEXT,
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_connector_audit_connector
  ON connector_audit (connector_id, recorded_at DESC);
