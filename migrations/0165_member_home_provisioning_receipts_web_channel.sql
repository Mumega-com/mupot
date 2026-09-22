-- 0165_member_home_provisioning_receipts_web_channel.sql — widen
-- member_home_provisioning_receipts.channel to admit 'web' alongside the IM
-- channel (mupot#1504: "Web onboarding door never creates the member's home
-- squad"). NOT applied by this build — branch/schema only, like every
-- migration in this file's own numbering range; a human applies it. THIS
-- MIGRATION touches production data when it runs.
--
-- CORRECTION (2026-09-22, PR #1509 gate round): an earlier version of this
-- file's header claimed "0161 is unapplied everywhere ... no live data to
-- migrate." That was WRONG. 0161_member_home_provisioning_receipts.sql WAS
-- applied to production D1 on 2026-09-21 23:00Z (migrations 0157-0162 all
-- applied together; `wrangler d1 migrations list --remote` returned "No
-- migrations to apply" afterward; recorded on PR #1490). So THIS migration
-- is a REBUILD OF A LIVE TABLE, not a schema-only correction — treat every
-- row currently in member_home_provisioning_receipts as real data that must
-- survive the rebuild byte-for-byte (aside from the deliberate
-- 'telegram'->'im' channel relabel below).
--
-- THE BUG THIS CLOSES
--
-- 0161 shipped member_home_provisioning_receipts with
-- `channel TEXT NOT NULL DEFAULT 'telegram' CHECK (channel IN ('telegram'))`
-- — a column that exists but a CHECK that hard-refuses every value except
-- the one IM caller. #1504's fix makes createHomeForMember's caller-side
-- wrapper (renamed provisionHomeOnFirstContact -> provisionHomeForMember,
-- src/members/service.ts) channel-agnostic and calls it from the web invite-
-- accept path too (src/dashboard/invite.ts) — that INSERT would raise
-- CHECK constraint failed the instant a web accept tried to write 'web'.
--
-- Also RENAMES the IM channel's own literal from 'telegram' to 'im' —
-- provisionHomeForMember's whole point is that the write path no longer
-- knows or cares which specific IM provider redeemed the invite (Telegram
-- today, something else tomorrow); 'im' names the CHANNEL, not the vendor,
-- matching ConnectionChannel's own 'im' literal (src/types.ts) used
-- everywhere else a channel is recorded for a human principal. Every
-- pre-existing row's `channel` value is necessarily 'telegram' (0161's CHECK
-- allowed nothing else), so this relabel is total and lossless — no row's
-- channel becomes ambiguous or unrecognized.
--
-- SQLite has no ALTER COLUMN / ALTER CONSTRAINT, so the fix is the same
-- table-rebuild migrations/0042 (tasks.status) and 0158 (routine_run_actions
-- .kind) already used for exactly this shape of change: rebuild the table
-- with every column, index, and trigger unchanged except the widened CHECK
-- and the new default. No other migration has touched
-- member_home_provisioning_receipts since it was created in 0161 (verified:
-- grep for "ALTER TABLE member_home_provisioning_receipts" or
-- "member_home_provisioning_receipts_new" across migrations/ returns
-- nothing before this file), so the rebuild's column list is a straight
-- copy of 0161's — and the INSERT...SELECT below is ROW-PRESERVING: every
-- column from every existing row is carried into the new table (only
-- `channel` is transformed, and only 'telegram'->'im'; every other value,
-- including NULL squad_id on a 'failed' disposition, passes through
-- unchanged). Applying this to production is expected to be a no-op on row
-- COUNT: `SELECT COUNT(*) FROM member_home_provisioning_receipts` before and
-- after must be equal, and `SELECT COUNT(*) FROM
-- member_home_provisioning_receipts WHERE channel NOT IN ('web','im')` must
-- be 0 after. The human who applies this should capture both counts (before
-- via the live D1, after via the same query post-apply) as the receipt for
-- this rebuild, per Kasra's "no fake green — receipts, not grades" rule.

PRAGMA foreign_keys = off;

CREATE TABLE member_home_provisioning_receipts_new (
  id           TEXT NOT NULL PRIMARY KEY,
  tenant       TEXT NOT NULL,
  member_id    TEXT NOT NULL,
  squad_id     TEXT,                          -- the home squad id; NULL when disposition = 'failed'
  channel      TEXT NOT NULL DEFAULT 'im' CHECK (channel IN ('web', 'im')),
  disposition  TEXT NOT NULL CHECK (disposition IN ('created', 'existing', 'failed')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO member_home_provisioning_receipts_new (
  id, tenant, member_id, squad_id, channel, disposition, created_at
)
SELECT
  id, tenant, member_id, squad_id,
  CASE WHEN channel = 'telegram' THEN 'im' ELSE channel END,
  disposition, created_at
FROM member_home_provisioning_receipts;

DROP TABLE member_home_provisioning_receipts;
ALTER TABLE member_home_provisioning_receipts_new RENAME TO member_home_provisioning_receipts;

-- Index dropped with the table above — recreated verbatim from 0161.
CREATE INDEX IF NOT EXISTS idx_member_home_provisioning_receipts_member
  ON member_home_provisioning_receipts(member_id, created_at DESC);

-- Triggers dropped with the table above — recreated verbatim from 0161.
CREATE TRIGGER IF NOT EXISTS member_home_provisioning_receipts_no_update
  BEFORE UPDATE ON member_home_provisioning_receipts
BEGIN
  SELECT RAISE(ABORT, 'member_home_provisioning_receipts is append-only');
END;

CREATE TRIGGER IF NOT EXISTS member_home_provisioning_receipts_no_delete
  BEFORE DELETE ON member_home_provisioning_receipts
BEGIN
  SELECT RAISE(ABORT, 'member_home_provisioning_receipts is append-only');
END;

PRAGMA foreign_keys = on;
