-- 0070_instinct_memory.sql — Module Kernel Port 4: instinct-memory (ECC continuous-learning-v2.1).
--
-- Design: docs/architecture/mupot-agent-identity-memory-lifecycle.md §2.5 / §3,
-- docs/architecture/mupot-module-kernel.md build-order item 3.
--
-- Observations: hook-captured session events (tool use, corrections), project-scoped.
-- Instincts: atomic {id, trigger, confidence 0.3–0.9, domain, scope, project_id}.
-- Project-scoped by default; promotion to global is a SEPARATE write after the
-- ≥2-projects / avg-confidence≥0.8 gate (FRC no-silent-promotion).
--
-- TENANT ISOLATION: tenant is the leading column of every index; every query
-- MUST include tenant = env.TENANT_SLUG (never client-supplied).

CREATE TABLE IF NOT EXISTS instinct_observations (
  id            TEXT NOT NULL PRIMARY KEY,
  tenant        TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  agent_id      TEXT,
  session_id    TEXT,
  event         TEXT NOT NULL CHECK (event IN (
                  'tool_start', 'tool_complete', 'user_message', 'correction', 'note'
                )),
  payload_json  TEXT NOT NULL CHECK (
                  json_valid(payload_json) AND json_type(payload_json) = 'object'
                ),
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_instinct_obs_project_recent
  ON instinct_observations (tenant, project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_instinct_obs_undistilled
  ON instinct_observations (tenant, project_id, created_at);

CREATE TABLE IF NOT EXISTS instincts (
  id            TEXT NOT NULL,
  tenant        TEXT NOT NULL,
  agent_id      TEXT,
  project_id    TEXT,
  scope         TEXT NOT NULL CHECK (scope IN ('project', 'global')),
  trigger_text  TEXT NOT NULL CHECK (length(trigger_text) BETWEEN 1 AND 500),
  confidence    REAL NOT NULL CHECK (confidence >= 0.3 AND confidence <= 0.9),
  domain        TEXT NOT NULL DEFAULT '' CHECK (length(domain) <= 64),
  action_text   TEXT NOT NULL CHECK (length(action_text) BETWEEN 1 AND 2000),
  evidence_json TEXT NOT NULL DEFAULT '[]' CHECK (
                  json_valid(evidence_json) AND json_type(evidence_json) = 'array'
                ),
  updated_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  -- Generated (never written directly): NULL project_id / agent_id normalize to ''
  -- so the unique index below treats "no project/agent" as one consistent bucket
  -- (same pattern as module_registry.project_key in 0066).
  project_key   TEXT NOT NULL GENERATED ALWAYS AS (COALESCE(project_id, '')) STORED,
  agent_key     TEXT NOT NULL GENERATED ALWAYS AS (COALESCE(agent_id, '')) STORED
);

-- One instinct row per (tenant, id, scope, project-or-agent bucket) — the upsert target.
CREATE UNIQUE INDEX IF NOT EXISTS idx_instincts_identity_live
  ON instincts (tenant, id, scope, project_key, agent_key);

CREATE INDEX IF NOT EXISTS idx_instincts_tenant_scope
  ON instincts (tenant, scope, confidence DESC);

CREATE INDEX IF NOT EXISTS idx_instincts_tenant_project
  ON instincts (tenant, project_id, confidence DESC);
