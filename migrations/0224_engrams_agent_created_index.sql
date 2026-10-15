-- recall's D1 read-your-writes leg (src/memory/index.ts) and memory_recent order a scope's engrams by
-- created_at DESC. The old idx_engrams_agent (agent_id) forced a sort of the whole scope per query.
CREATE INDEX IF NOT EXISTS idx_engrams_agent_created ON engrams(agent_id, created_at);
