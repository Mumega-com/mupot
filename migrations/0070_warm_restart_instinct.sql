-- 0070_warm_restart_instinct.sql — Module Kernel Port 4: warm-restart + instinct memory.
--
-- Design: docs/architecture/mupot-agent-identity-memory-lifecycle.md §2.5 / §3,
-- docs/architecture/mupot-module-kernel.md build-order item 3. Ported from ECC
-- continuous-learning-v2 (instincts) + memory-persistence hooks (session handoff).
--
-- session_handoffs: rich Stop / PreCompact summaries keyed by (tenant, agent).
-- SessionStart re-injects the matching handoff behind a stale-replay guard so
-- post-compaction resume stays warm without re-executing stale ARGUMENTS.
--
-- instincts: confidence-scored atomic behaviors (trigger + action + evidence).
-- Project-scoped by default; promotion to global is a SEPARATE write after the
-- ≥2-projects / avg-confidence≥0.8 gate (no silent promotion).
--
-- TENANT ISOLATION: tenant is the leading column of every index; every query
-- MUST include tenant = env.TENANT_SLUG (never client-supplied).

CREATE TABLE IF NOT EXISTS session_handoffs (
  id            TEXT NOT NULL PRIMARY KEY,
  tenant        TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  project_id    TEXT,
  worktree      TEXT,
  branch        TEXT,
  reason        TEXT NOT NULL CHECK (reason IN ('stop', 'pre_compact', 'session_end')),
  body          TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 100000),
  saved_at      TEXT NOT NULL
);

-- Newest handoff for an agent (SessionStart lookup).
CREATE INDEX IF NOT EXISTS idx_session_handoffs_agent_recent
  ON session_handoffs (tenant, agent_id, saved_at DESC);

-- Worktree / project match helpers.
CREATE INDEX IF NOT EXISTS idx_session_handoffs_agent_worktree
  ON session_handoffs (tenant, agent_id, worktree);

CREATE INDEX IF NOT EXISTS idx_session_handoffs_agent_project
  ON session_handoffs (tenant, agent_id, project_id);

CREATE TABLE IF NOT EXISTS instincts (
  id            TEXT NOT NULL,
  tenant        TEXT NOT NULL,
  agent_id      TEXT,
  project_id    TEXT,
  scope         TEXT NOT NULL CHECK (scope IN ('project', 'global', 'agent')),
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
-- Generated columns cannot be part of a PRIMARY KEY in SQLite; UNIQUE INDEX is the
-- module_registry precedent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_instincts_identity_live
  ON instincts (tenant, id, scope, project_key, agent_key);

CREATE INDEX IF NOT EXISTS idx_instincts_tenant_scope
  ON instincts (tenant, scope, confidence DESC);

CREATE INDEX IF NOT EXISTS idx_instincts_tenant_project
  ON instincts (tenant, project_id, confidence DESC);

CREATE INDEX IF NOT EXISTS idx_instincts_tenant_agent
  ON instincts (tenant, agent_id, confidence DESC);
