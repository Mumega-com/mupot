-- 0142_onboarding_squad_packs.sql — Multimodal Business Onboarding & Starter Squad Packs (Journey 3 / Linear-Style).
--
-- Deliverables:
-- 1. workspace_onboarding_records table:
--    Records customer workspace setup, selected starter pack, and completed onboarding milestones.
--    Tracks {tenant, company_name, business_type, starter_pack, model_preference, completed_at, created_at}.
--
-- 2. agent_workspaces table:
--    Tracks external git repo-sensing agent workspaces and their target paths.
--    Tracks {id, tenant, agent_id, repo_url, target_folder, harness, machine, onboarded_at}.

-- ── 1. Workspace Onboarding Records ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workspace_onboarding_records (
  tenant TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  business_type TEXT NOT NULL, -- 'engineering' | 'growth_agency' | 'operations' | 'ecommerce' | 'custom'
  starter_pack TEXT NOT NULL,  -- 'engineering_sprint' | 'content_studio' | 'business_ops' | 'custom'
  model_preference TEXT NOT NULL DEFAULT 'claude-3-7-sonnet',
  first_task_id TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL
);

-- ── 2. External Agent Workspaces (Repo-Sensing) ───────────────────────────────

CREATE TABLE IF NOT EXISTS agent_workspaces (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  target_folder TEXT NOT NULL DEFAULT 'agents',
  harness TEXT NOT NULL DEFAULT 'cursor-cloud',
  machine TEXT NOT NULL,
  onboarded_at TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE INDEX IF NOT EXISTS idx_agent_workspaces_tenant_repo
  ON agent_workspaces(tenant, repo_url);
