-- 0020_oauth_channel.sql — add 'directory' to the member_tokens channel enum.
--
-- OAuth 2.1 seats connect via the /authorize flow; they are not workspace (API key)
-- nor im (Hermes/Telegram) nor dashboard (web login) — they arrive through the
-- public directory OAuth door. A dedicated enum value makes the origin legible
-- in the operator roster and preserves revocation-by-channel semantics.
--
-- D1 does not allow adding a CHECK constraint via ALTER TABLE; recreate the
-- table with the updated CHECK and copy all live rows.
--
-- Note: D1 DOES support ALTER TABLE ADD COLUMN, but does NOT allow altering
-- constraints. The approach is: create new table, copy, drop old, rename.

-- Step 1: Create the new member_tokens table with updated CHECK
CREATE TABLE IF NOT EXISTS member_tokens_new (
  id          TEXT PRIMARY KEY,
  member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL DEFAULT '',
  channel     TEXT NOT NULL DEFAULT 'workspace' CHECK (channel IN ('workspace','im','dashboard','directory')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at  TEXT,
  agent_id    TEXT   -- bound agent (agents.id), or NULL (from 0019)
);

-- Step 2: Copy all rows
INSERT INTO member_tokens_new SELECT id, member_id, token_hash, label, channel, created_at, revoked_at, agent_id FROM member_tokens;

-- Step 3: Drop old table and rename
DROP TABLE member_tokens;
ALTER TABLE member_tokens_new RENAME TO member_tokens;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_member_tokens_member ON member_tokens(member_id);
CREATE INDEX IF NOT EXISTS idx_member_tokens_hash   ON member_tokens(token_hash);
