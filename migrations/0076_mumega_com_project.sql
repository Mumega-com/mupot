-- 0076_mumega_com_project.sql — Project bootstrapping for mumega.com + KayHermes binding.
--
-- Creates the durable mumega.com project, establishes squad-core access,
-- and ensures KayHermes is registered as a squad member for project context access.
-- The preferred_agent_id on routines establishes the durable steward binding.

-- Ensure squad-core exists (idempotent: core teams pre-exist, so we reference it).
-- If squad-core does NOT exist yet, create it (rare, but possible in test/manual setups).
INSERT OR IGNORE INTO departments (id, slug, name)
VALUES ('dept-core', 'core', 'Core');

INSERT OR IGNORE INTO squads (id, department_id, slug, name)
VALUES ('squad-core', 'dept-core', 'core', 'Core');

-- Create the mumega.com project (active state, ready for use).
-- Project ID: Use a deterministic fixed UUID for the mumega.com project.
INSERT OR IGNORE INTO projects (id, slug, name, description, goal, status, created_at, updated_at)
VALUES (
  'project-mumega-com',
  'mumega-com',
  'Mumega',
  'The Mumega ecosystem and organism.',
  'Coordinate work across the unified organism and its agents.',
  'active',
  datetime('now'),
  datetime('now')
);

-- Grant squad-core write access to the mumega-com project.
-- This allows squads and agents in squad-core to create, read, and modify project-scoped tasks.
INSERT OR IGNORE INTO project_squad_access (project_id, squad_id, access_level, granted_at)
SELECT p.id, 'squad-core', 'write', datetime('now')
  FROM projects p
 WHERE p.slug = 'mumega-com';

-- Ensure kayhermes agent exists in squad-core (if not already).
-- KayHermes is a durable research/concierge agent that will be bound as the project steward.
INSERT OR IGNORE INTO agents (id, squad_id, slug, name, role, model, status, created_at)
VALUES (
  'agent-kayhermes',
  'squad-core',
  'kayhermes',
  'KayHermes',
  'concierge',
  '@cf/meta/llama-3.3',
  'active',
  datetime('now')
);

-- Set kayhermes capabilities (research tier, from 0070_harness_role_capabilities.sql).
UPDATE agents
   SET capabilities = '["research"]'
 WHERE slug = 'kayhermes' AND squad_id = 'squad-core';

-- Note: The durable project agent binding is established via a routine (0073_project_routines.sql)
-- with preferred_agent_id='agent-kayhermes'. That routine can be created separately via the API
-- or via an orient/pulse ceremony that the project agent (KayHermes) initiates.
-- This migration only establishes the structural prerequisites.
