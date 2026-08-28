-- 0133_engram_status_and_lifecycle.sql — Engram vector status lifecycle (FLIGHT MEM-01 / #1202).
--
-- Adds status, embedding_model, error_code, and updated_at columns to engrams table to support atomic lifecycle:
--   'pending' -> 'ready' | 'failed'
-- Also adds index for status and agent filtering.

ALTER TABLE engrams ADD COLUMN status TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE engrams ADD COLUMN embedding_model TEXT;
ALTER TABLE engrams ADD COLUMN error_code TEXT;
ALTER TABLE engrams ADD COLUMN updated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_engrams_agent_status ON engrams(agent_id, status);
