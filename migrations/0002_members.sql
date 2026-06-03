-- mupot members network — humans as first-class nodes.
-- A member is one person; they connect via workspace (MCP), IM (Telegram via
-- Hermes), or the dashboard — all resolving to this member_id + capabilities.
-- Empty by default (substrate): the tenant invites their own people.

CREATE TABLE IF NOT EXISTS members (
  id               TEXT PRIMARY KEY,
  email            TEXT UNIQUE,
  display_name     TEXT NOT NULL,
  telegram_chat_id TEXT UNIQUE,                -- IM-only members reach mupot via Hermes
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Scoped, revocable tokens. Stored HASHED (sha256), never the raw value — same
-- discipline as the SOS bus. One member may hold several (laptop, server, hermes).
CREATE TABLE IF NOT EXISTS member_tokens (
  id          TEXT PRIMARY KEY,
  member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL DEFAULT '',
  channel     TEXT NOT NULL DEFAULT 'workspace' CHECK (channel IN ('workspace','im','dashboard')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at  TEXT
);

-- member × scope → capability. THE real RBAC, enforced on every write path.
-- scope_id is null for org-wide grants; a department id; or a squad id.
CREATE TABLE IF NOT EXISTS capabilities (
  id          TEXT PRIMARY KEY,
  member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  scope_type  TEXT NOT NULL CHECK (scope_type IN ('org','department','squad')),
  scope_id    TEXT,                            -- null when scope_type='org'
  capability  TEXT NOT NULL CHECK (capability IN ('owner','admin','lead','member','observer')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(member_id, scope_type, scope_id)
);

-- pending invites (email → first-connect mints the member + token)
CREATE TABLE IF NOT EXISTS invites (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  department_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
  capability  TEXT NOT NULL DEFAULT 'member' CHECK (capability IN ('owner','admin','lead','member','observer')),
  invited_by  TEXT,
  accepted_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_member_tokens_member ON member_tokens(member_id);
CREATE INDEX IF NOT EXISTS idx_member_tokens_hash   ON member_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_capabilities_member  ON capabilities(member_id);
CREATE INDEX IF NOT EXISTS idx_capabilities_scope   ON capabilities(scope_type, scope_id);
