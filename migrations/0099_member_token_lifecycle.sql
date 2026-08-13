-- 0099 — member_tokens lifecycle: expires_at + last_used_at
--
-- WHY (measured, 2026-08-13): the mumega pot held 53 LIVE bearer tokens across only
-- 19 distinct identities; 51 of the 83 ever minted were created in the preceding two
-- weeks. Three dormant tenant pots held 7 more, some two months old, one issued to an
-- external human operator. Every one of them was revoked by hand, because nothing in
-- this schema can retire a credential on its own.
--
-- Two absences caused that, and they compound:
--
--   no expires_at    — a token is immortal by construction. Rotation mints a NEW
--                      credential and leaves the old one live; the `-rotated-` tokens
--                      sit beside the tokens they replaced, both valid.
--   no last_used_at  — nothing distinguishes a live agent's credential from an
--                      abandoned one. So the safe action is always "leave it", and the
--                      set only grows. Cleanup was not neglected, it was IMPOSSIBLE.
--
-- This was already decided. docs/architecture/identity-and-access-redesign.md D2 —
-- "expires_at is MANDATORY at mint, not optional" — merged to main as #416 on
-- 2026-07-20. Twenty-four days before this migration. It never reached the schema, and
-- 51 more immortal tokens were minted in the gap. The decision landing in a doc did not
-- make it true of the system; only the artifact that governs runtime does that.
--
-- SEMANTICS
--   expires_at NULL      = non-expiring. After this migration that is an explicit,
--                          owner-gated exception (D2), never the default at mint.
--   expires_at in past   = authenticates to nothing. Enforced in the SAME predicate as
--                          revoked_at, in BOTH token-lookup copies (mcp/index.ts
--                          authenticateMember and auth/member-bearer.ts
--                          resolveMemberByToken). Enforcing in only one would leave the
--                          other as a live bypass door — those two copies are known
--                          duplicates (see member-bearer.ts header, #41).
--   last_used_at         = written on successful authentication. Best-effort and
--                          non-blocking: a failed write must never fail a request.
--
-- BACKFILL — DEFERRED, DELIBERATELY (Hadi, 2026-08-13).
-- An earlier draft of this migration stamped a 90-day horizon on every existing live
-- token in the same statement. Hadi chose to defer it: add the columns, let
-- `last_used_at` start recording, and pick the horizon from MEASURED usage instead of
-- from a number someone guessed.
--
-- That is the better call, and it is the whole reason `last_used_at` exists. Right now
-- nothing distinguishes a live agent's credential from an abandoned one, so any horizon
-- chosen today would be applied blind to 53 tokens — and the ones that break would be
-- discovered by an agent failing mid-work, not by us. After a couple of weeks of usage
-- data, the same decision is evidence-based: the untouched tokens are the ones to expire
-- first, and the actively-used ones can be rotated deliberately rather than killed.
--
-- So this migration is mechanism only. Its effect on the existing 53 tokens is ZERO:
-- expires_at stays NULL, which the auth predicate reads as non-expiring, so nothing that
-- works today stops working. What changes is that from now on every authenticated request
-- records when a credential was last used.
--
-- THE FOLLOW-UP IS THE POINT, and it is not optional — a mechanism with no policy behind
-- it is how #416 became 24 days of nothing. Tracked as the next step in this lane:
--   1. let last_used_at accumulate (~2 weeks)
--   2. choose a horizon from the data, backfill in a separate migration
--   3. make expires_at MANDATORY at mint (redesign D2), non-expiring an owner-gated exception
--   4. TTL/inactivity sweep cron — alert-only for one full cycle before it ever revokes
--
-- D1/SQLite note for whoever writes step 2: ALTER TABLE ADD COLUMN cannot take a
-- non-constant DEFAULT, so a horizon has to be applied by an UPDATE, and that UPDATE must
-- be guarded on `expires_at IS NULL` so re-running it can never extend an expiry that has
-- already been set.

ALTER TABLE member_tokens ADD COLUMN expires_at TEXT;
ALTER TABLE member_tokens ADD COLUMN last_used_at TEXT;

-- Sweep support: the inactivity/TTL cron scans for tokens past their horizon. Partial
-- index on the live set only — the revoked rows are the majority over time and never
-- need scanning.
CREATE INDEX IF NOT EXISTS idx_member_tokens_expiry_sweep
    ON member_tokens (expires_at)
 WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_member_tokens_last_used
    ON member_tokens (last_used_at)
 WHERE revoked_at IS NULL;
