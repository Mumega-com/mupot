-- 0165_member_home_provisioning_receipts_web_channel.sql — widen
-- member_home_provisioning_receipts.channel to admit 'web' alongside the IM
-- channel (mupot#1504: "Web onboarding door never creates the member's home
-- squad"). NOT applied by this build — branch/schema only, like every
-- migration in this file's own numbering range; a human applies it. THIS
-- MIGRATION touches production data when it runs.
--
-- CORRECTION (2026-09-22, PR #1509 gate round 1): an earlier version of this
-- file's header claimed "0161 is unapplied everywhere ... no live data to
-- migrate." That was WRONG. 0161_member_home_provisioning_receipts.sql WAS
-- applied to production D1 on 2026-09-21 23:00Z (migrations 0157-0162 all
-- applied together; `wrangler d1 migrations list --remote` returned "No
-- migrations to apply" afterward; recorded on PR #1490). So THIS migration
-- is a REBUILD OF A LIVE TABLE — treat every row currently in
-- member_home_provisioning_receipts as real data that must survive the
-- rebuild byte-for-byte, including its `channel` value (see round 2 below —
-- no relabel).
--
-- CORRECTION (2026-09-22, PR #1509 gate round 2): round 1's fix RELABELED
-- every pre-existing 'telegram' row to 'im' in the same migration. Adversarial
-- round 1 caught the real defect that relabel created: migration and code
-- deploy are two SEPARATE, non-atomic operations on this repo's own
-- deploy discipline (this file's own "a human applies it" convention) —
-- - MIGRATION FIRST: the CHECK narrows to ('web','im') before the currently
--   deployed src/im/index.ts (merge-base, pre-#1504) ships — that code still
--   writes the literal 'telegram' on every IM join. Every such INSERT now
--   fails the CHECK constraint, and (pre-round-2) that failure landed in a
--   bare `catch {}` in service.ts — SILENTLY. Every IM-join home-provisioning
--   receipt is lost, invisibly, for the whole window between migration apply
--   and code deploy.
-- - CODE FIRST: the new provisionHomeForMember code (writing 'im') ships
--   before this migration applies — the OLD CHECK (channel IN ('telegram'))
--   refuses every 'im'/'web' insert just as silently, for the whole window
--   between code deploy and migration apply.
-- Relabeling existing rows does not fix either window — it only changes
-- which literal is momentarily rejected. The actual fix is WIDEN, DON'T
-- RELABEL: keep 'telegram' as a legal value (so already-deployed code keeps
-- working right up until it is replaced) and ADD 'web'/'im' alongside it,
-- so the CHECK constraint is a strict superset of both the old and new
-- code's possible writes regardless of which side of the deploy boundary
-- runs first. Existing 'telegram' rows are NOT touched by this migration —
-- no CASE/relabel in the INSERT...SELECT below. A LATER migration may retire
-- 'telegram' once `grep -rn "'telegram'" src/im/index.ts` (or the deployed
-- build) confirms no code path can still emit it.
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
-- The IM channel's own literal in the APPLICATION CODE is renamed from
-- 'telegram' to 'im' (provisionHomeForMember's whole point is that the write
-- path no longer knows or cares which specific IM provider redeemed the
-- invite — Telegram today, something else tomorrow; 'im' names the CHANNEL,
-- not the vendor, matching ConnectionChannel's own 'im' literal, src/types.ts)
-- — but that is a CODE change (src/im/index.ts), not a DATA migration. This
-- migration only widens what the CHECK constraint accepts; it does not
-- touch what any existing row's `channel` column contains.
--
-- SQLite has no ALTER COLUMN / ALTER CONSTRAINT, so the fix is the same
-- table-rebuild migrations/0042 (tasks.status) and 0158 (routine_run_actions
-- .kind) already used for exactly this shape of change: rebuild the table
-- with every column, index, and trigger unchanged except the widened CHECK.
-- No other migration has touched member_home_provisioning_receipts since it
-- was created in 0161 (verified: grep for "ALTER TABLE
-- member_home_provisioning_receipts" or "member_home_provisioning_receipts_new"
-- across migrations/ returns nothing before this file), so the rebuild's
-- column list is a straight copy of 0161's — and the INSERT...SELECT below is
-- fully ROW- AND VALUE-PRESERVING: every column of every existing row,
-- `channel` included, is carried into the new table completely unchanged.
-- Applying this to production is expected to be a no-op on both row COUNT
-- and every row's CONTENT: `SELECT COUNT(*) FROM
-- member_home_provisioning_receipts` before and after must be equal, and
-- `SELECT COUNT(*) FROM member_home_provisioning_receipts WHERE channel NOT
-- IN ('web','im','telegram')` must be 0 both before and after (before,
-- because 0161's own narrower CHECK already guaranteed it; after, because
-- this rebuild adds no new rows and transforms no existing ones). The human
-- who applies this should capture both counts (before via the live D1,
-- after via the same query post-apply) as the receipt for this rebuild, per
-- Kasra's "no fake green — receipts, not grades" rule.
--
-- PRAGMA foreign_keys IS DECORATIVE ON D1 (adversarial round 1, P3; same
-- precedent as migrations/0049, 0069, 0116): Cloudflare D1 does not honor
-- SQLite's per-connection `PRAGMA foreign_keys` toggle the way a local
-- sqlite3/node:sqlite connection does — the ON/OFF bracketing below is kept
-- for parity with 0042/0158's own convention and for correctness under this
-- repo's own local-migration test harness (tests/helpers/migrations.ts runs
-- these files against a real node:sqlite connection, where the pragma DOES
-- take effect), but it is not load-bearing for the production D1 apply.
-- member_home_provisioning_receipts carries no FK to begin with (deliberate,
-- matching 0086/0115/0157 — a member/squad retirement must never
-- cascade-erase this audit row), so this note is informational only; no
-- behavior here actually depends on the pragma taking effect in prod.

PRAGMA foreign_keys = off;

CREATE TABLE member_home_provisioning_receipts_new (
  id           TEXT NOT NULL PRIMARY KEY,
  tenant       TEXT NOT NULL,
  member_id    TEXT NOT NULL,
  squad_id     TEXT,                          -- the home squad id; NULL when disposition = 'failed'
  channel      TEXT NOT NULL DEFAULT 'im' CHECK (channel IN ('web', 'im', 'telegram')),
  disposition  TEXT NOT NULL CHECK (disposition IN ('created', 'existing', 'failed')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Row- AND value-preserving: every column, `channel` included, copied as-is.
-- No CASE/relabel — see "CORRECTION (round 2)" above for why a relabel here
-- would silently drop receipts across the migration/deploy ordering window.
INSERT INTO member_home_provisioning_receipts_new (
  id, tenant, member_id, squad_id, channel, disposition, created_at
)
SELECT
  id, tenant, member_id, squad_id, channel, disposition, created_at
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
