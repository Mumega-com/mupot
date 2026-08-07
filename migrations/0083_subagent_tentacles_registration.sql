-- 0080_subagent_tentacles_registration.sql — register internal subagent tentacles under parent_agent_id = 'river' (GitHub Issue #776).
--
-- Registers River's specialized internal subagent tentacles (river-code, river-copywriter,
-- river-reviewer, river-frc) in D1 table agents with parent_agent_id = 'river'.
--
-- Conditional insertion (WHERE EXISTS (SELECT 1 FROM squads)):
-- Guarantees FK constraint satisfaction when squads exist, while allowing test-suite schema
-- migrations (which build an empty schema baseline) to execute with zero leftover rows.

INSERT INTO agents (
  id,
  squad_id,
  slug,
  name,
  role,
  model,
  status,
  purpose,
  capabilities,
  parent_agent_id
)
SELECT
  'river-code',
  COALESCE((SELECT squad_id FROM agents WHERE id = 'river' OR slug = 'river' LIMIT 1), (SELECT id FROM squads LIMIT 1)),
  'river-code',
  'River Code',
  'member',
  '@cf/meta/llama-3.3',
  'active',
  'Rapid Hono, TypeScript, Vitest code generation',
  '["build","code"]',
  'river'
WHERE EXISTS (SELECT 1 FROM squads)
ON CONFLICT(id) DO UPDATE SET
  parent_agent_id = 'river',
  purpose = excluded.purpose,
  capabilities = excluded.capabilities;

INSERT INTO agents (
  id,
  squad_id,
  slug,
  name,
  role,
  model,
  status,
  purpose,
  capabilities,
  parent_agent_id
)
SELECT
  'river-copywriter',
  COALESCE((SELECT squad_id FROM agents WHERE id = 'river' OR slug = 'river' LIMIT 1), (SELECT id FROM squads LIMIT 1)),
  'river-copywriter',
  'River Copywriter',
  'member',
  '@cf/meta/llama-3.3',
  'active',
  'Per-tenant brand voice fine-tuning and content generation',
  '["content"]',
  'river'
WHERE EXISTS (SELECT 1 FROM squads)
ON CONFLICT(id) DO UPDATE SET
  parent_agent_id = 'river',
  purpose = excluded.purpose,
  capabilities = excluded.capabilities;

INSERT INTO agents (
  id,
  squad_id,
  slug,
  name,
  role,
  model,
  status,
  purpose,
  capabilities,
  parent_agent_id
)
SELECT
  'river-reviewer',
  COALESCE((SELECT squad_id FROM agents WHERE id = 'river' OR slug = 'river' LIMIT 1), (SELECT id FROM squads LIMIT 1)),
  'river-reviewer',
  'River Reviewer',
  'member',
  '@cf/meta/llama-3.3',
  'active',
  'Pre-flight fail-closed diff and error audit',
  '["review"]',
  'river'
WHERE EXISTS (SELECT 1 FROM squads)
ON CONFLICT(id) DO UPDATE SET
  parent_agent_id = 'river',
  purpose = excluded.purpose,
  capabilities = excluded.capabilities;

INSERT INTO agents (
  id,
  squad_id,
  slug,
  name,
  role,
  model,
  status,
  purpose,
  capabilities,
  parent_agent_id
)
SELECT
  'river-frc',
  COALESCE((SELECT squad_id FROM agents WHERE id = 'river' OR slug = 'river' LIMIT 1), (SELECT id FROM squads LIMIT 1)),
  'river-frc',
  'River FRC',
  'member',
  '@cf/meta/llama-3.3',
  'active',
  'Mathematical coherence, FRC physics and memory receipts',
  '["frc","memory"]',
  'river'
WHERE EXISTS (SELECT 1 FROM squads)
ON CONFLICT(id) DO UPDATE SET
  parent_agent_id = 'river',
  purpose = excluded.purpose,
  capabilities = excluded.capabilities;
