-- mupot channels — the platform's scoped channel IS the squad. Empty by default
-- (substrate): the tenant binds their own channels. Microkernel: the core reads
-- these tables; each platform adapter is a leaf plugin.

-- channel ↔ squad. Binding a channel to a squad is an admin action.
CREATE TABLE IF NOT EXISTS channel_bindings (
  id                  TEXT PRIMARY KEY,
  platform            TEXT NOT NULL,                 -- 'discord' | 'google-chat' | 'telegram'
  external_channel_id TEXT NOT NULL,
  squad_id            TEXT NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  max_capability      TEXT NOT NULL DEFAULT 'member' -- ceiling for sync grants
    CHECK (max_capability IN ('owner','admin','lead','member','observer')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(platform, external_channel_id)
);

-- platform user ↔ mupot member. One platform identity binds to exactly one member.
CREATE TABLE IF NOT EXISTS member_identities (
  id               TEXT PRIMARY KEY,
  member_id        TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  platform         TEXT NOT NULL,
  external_user_id TEXT NOT NULL,                    -- Google: email; else platform user id
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(platform, external_user_id)
);

-- single-use, short-TTL link codes that bind a platform user to a member
-- (Discord/Telegram; Google auto-binds by email). Never trust a self-claimed id.
CREATE TABLE IF NOT EXISTS channel_link_codes (
  code        TEXT PRIMARY KEY,
  member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  platform    TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_channel_bindings_squad ON channel_bindings(squad_id);
CREATE INDEX IF NOT EXISTS idx_member_identities_member ON member_identities(member_id);
