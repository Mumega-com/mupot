-- 0044 — one-time self-hosted owner bootstrap claim.
--
-- A new pot can mint its initial owner with a high-entropy Worker secret while
-- dashboard OAuth is intentionally unconfigured. The singleton row is claimed in
-- the same D1 batch as the owner user row, so concurrent bootstrap requests cannot
-- create multiple first owners.

CREATE TABLE IF NOT EXISTS owner_bootstrap_claim (
  singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
