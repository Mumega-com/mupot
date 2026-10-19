-- 0243_mcp_negotiation_log.sql -- what protocol version each client requests on /mcp initialize + server/discover (mupot observability).
-- ChatGPT stopped listing mupot as an event source; we never recorded the protocolVersion a client asked for, so "client now asks for a
-- version we do not negotiate to 2026-07-28" was unprovable. BOUNDED: ONE row per (tenant, principal, method, requested version), upserted
-- (first_seen / at = last_seen / hit_count), so a client that reconnects every minute never fills its quota and a NEW version always gets a
-- row. Updates write at most once a minute; distinct versions per principal are capped; rows older than 7 days are pruned; the tenant has a ceiling.
-- AUTHENTICATED callers only (anonymous: console line only). Never stores a token, header value, or param other than the bounded version
-- string and a bounded client label. CREATE only; nothing is rebuilt.

CREATE TABLE IF NOT EXISTS mcp_negotiation_log (
  id                TEXT PRIMARY KEY NOT NULL,
  tenant            TEXT NOT NULL,
  at                TEXT NOT NULL,
  method            TEXT NOT NULL,
  harness_id        TEXT,
  member_id         TEXT,
  client_name       TEXT,
  requested_version TEXT NOT NULL,
  negotiated_version TEXT NOT NULL,
  events_returned   INTEGER NOT NULL,
  first_seen        TEXT NOT NULL DEFAULT '',
  hit_count         INTEGER NOT NULL DEFAULT 1
);

-- The upsert key. COALESCE: harness_id / member_id are NULL when absent, and NULLs are distinct in a plain unique index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mcp_negotiation_log_key
  ON mcp_negotiation_log (tenant, COALESCE(harness_id, ''), COALESCE(member_id, ''), method, requested_version);

CREATE INDEX IF NOT EXISTS idx_mcp_negotiation_log_principal
  ON mcp_negotiation_log (tenant, harness_id, member_id, method, requested_version, at);
CREATE INDEX IF NOT EXISTS idx_mcp_negotiation_log_at
  ON mcp_negotiation_log (tenant, at);
