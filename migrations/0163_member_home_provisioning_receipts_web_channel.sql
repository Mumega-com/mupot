-- 0163_member_home_provisioning_receipts_web_channel.sql — widen
-- member_home_provisioning_receipts.channel to admit 'web' alongside the IM
-- channel (mupot#1504: "Web onboarding door never creates the member's home
-- squad"). NOT applied by this build — branch/schema only, exactly like
-- 0143/.../0162 before it; a human applies it.
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
-- Since 0161 is unapplied everywhere (branch/schema only, per its own
-- header) there is no live data to migrate; this widens the constraint
-- before anyone ever depends on the narrower one.
--
-- Also RENAMES the IM channel's own literal from 'telegram' to 'im' —
-- provisionHomeForMember's whole point is that the write path no longer
-- knows or cares which specific IM provider redeemed the invite (Telegram
-- today, something else tomorrow); 'im' names the CHANNEL, not the vendor,
-- matching ConnectionChannel's own 'im' literal (src/types.ts) used
-- everywhere else a channel is recorded for a human principal.
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
-- copy of 0161's.

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
