-- 0070_harness_role_capabilities.sql — effort→idle router capability tags.
--
-- Sets agents.capabilities (JSON array, migration 0068) for the known harness
-- slugs the effort router (src/tasks/effort-route.ts HARNESS_CAPABILITIES) owns.
-- Known-harness caps are also authoritative in code (presence cannot grant agy
-- build/review). This backfill makes the agent profile match that contract so
-- resolve_agent / admin views show the same tags.
--
-- Ladder contract (kasra GREEN + amendments 2026-07-22):
--   kasra     = build + research + review
--   cursor    = build
--   codex     = review
--   agy       = research ONLY (never build/review)
--   kayhermes = research

UPDATE agents SET capabilities = '["build","research","review"]' WHERE slug = 'kasra';
UPDATE agents SET capabilities = '["build"]' WHERE slug = 'cursor';
UPDATE agents SET capabilities = '["review"]' WHERE slug = 'codex';
UPDATE agents SET capabilities = '["research"]' WHERE slug = 'agy';
UPDATE agents SET capabilities = '["research"]' WHERE slug = 'kayhermes';
