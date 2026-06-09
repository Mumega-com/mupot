-- 0016_presence.sql — pot-native flock presence (Flock #45).
--
-- Agents check IN to the pot itself (inbound) so the Fleet shows a live inventory
-- of who has access + who is currently in — WITHOUT coupling the pot to the SOS
-- bus (no egress, the pot stays sealed). Keyed by the authenticated member, since
-- a flock agent authenticates with its pot member-token (member_tokens).
--
-- Liveness is derived at read time from last_seen_at (reuse dashboard/fleet classify):
-- active ≤10m, idle ≤24h, else dead. Stop checking in → ages to "not there".

CREATE TABLE IF NOT EXISTS presence (
  tenant        TEXT NOT NULL,
  member_id     TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT 'unknown',   -- runtime: claude-code|codex|hermes|openclaw|tmux|cowork|unknown
  label         TEXT NOT NULL DEFAULT '',          -- free-text, e.g. role/note (capped at write)
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant, member_id)
);

CREATE INDEX IF NOT EXISTS idx_presence_tenant_seen ON presence(tenant, last_seen_at DESC);
