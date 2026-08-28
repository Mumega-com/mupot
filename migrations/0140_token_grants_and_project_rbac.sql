-- 0140_token_grants_and_project_rbac.sql — Token-Scoped Grants & Project Scope RBAC (FLIGHT IDENTITY-UNIFIED / #584).
--
-- Deliverables:
-- 1. token_grants table:
--    Durable store for per-token capability ceilings.
--    Effective authority is intersect(principal_capabilities, token_grants).
--    Tracks {token_id, tenant, scope_type, scope_id, capability, resource, created_at}.
--
-- 2. principals compatibility view:
--    Unifies members (human) and agents (agent) into a single identity concept.

-- ── 1. Token Grants (Per-Key Capability Ceilings) ─────────────────────────────

CREATE TABLE IF NOT EXISTS token_grants (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,
  tenant TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('org', 'department', 'squad', 'project')),
  scope_id TEXT, -- null for org
  capability TEXT NOT NULL CHECK (capability IN ('owner', 'admin', 'lead', 'member', 'observer')),
  resource TEXT, -- optional fine-grain filter: e.g. project_id, 'cro:*', 'tools:read'
  created_at TEXT NOT NULL,
  FOREIGN KEY (token_id) REFERENCES member_tokens(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_token_grants_lookup
  ON token_grants(tenant, token_id, scope_type);

-- ── 2. Principals Unified View ────────────────────────────────────────────────

CREATE VIEW IF NOT EXISTS principals AS
  SELECT id, 'human' AS kind, email AS handle, display_name, status, created_at
    FROM members
  UNION ALL
  SELECT id, 'agent' AS kind, slug AS handle, name AS display_name, status, created_at
    FROM agents;
