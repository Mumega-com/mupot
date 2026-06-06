-- Channel-derived squad capabilities. These are separate from manual
-- capabilities so membership sync can revoke only the grants owned by the
-- channel binding it reconciles.

CREATE TABLE IF NOT EXISTS channel_capability_grants (
  id          TEXT PRIMARY KEY,
  binding_id  TEXT NOT NULL REFERENCES channel_bindings(id) ON DELETE CASCADE,
  member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  squad_id    TEXT NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  capability  TEXT NOT NULL CHECK (capability IN ('owner','admin','lead','member','observer')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(binding_id, member_id, squad_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_capability_grants_member
  ON channel_capability_grants(member_id);
CREATE INDEX IF NOT EXISTS idx_channel_capability_grants_binding
  ON channel_capability_grants(binding_id, squad_id);
