-- 0243_mcp_negotiation_log.sql -- what protocol version each client requests on /mcp initialize + server/discover (mupot observability).
-- ChatGPT stopped listing mupot as an event source; we never recorded the protocolVersion a client asked for, so "client now asks for a
-- version we do not negotiate to 2026-07-28" was unprovable. BOUNDED: the writer inserts at most one row per (tenant, principal, method,
-- requested version) per minute, per-principal capped, prunes rows older than 7 days, and evicts oldest-first at a per-tenant ceiling.
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
  events_returned   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_negotiation_log_principal
  ON mcp_negotiation_log (tenant, harness_id, member_id, method, requested_version, at);
CREATE INDEX IF NOT EXISTS idx_mcp_negotiation_log_at
  ON mcp_negotiation_log (tenant, at);
