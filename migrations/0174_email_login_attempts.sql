-- 0174_email_login_attempts.sql — mupot#1564/#1442 adversarial gate round 1
-- (kasra-review + Athena, 2026-09-26, PR #1574): "a guard implemented as KV
-- read -> compare -> put is not a guard under concurrency." Cloudflare KV has
-- no compare-and-set, ~1 write/s/key, and reads can serve a stale value for
-- up to 60s. Proven live on the pinned tree: 4 concurrent POST
-- /auth/email/start sent 4 emails past a stated ceiling of 3; 2 concurrent
-- GET-link verifies both minted a session; 6 concurrent wrong-code guesses
-- left the 5-guess cap never firing and the correct code still usable.
--
-- Every counter/consume that GATES the email-login door now lives in D1,
-- where the fix is one atomic statement per decision — no read-then-write
-- window for a second caller to land in:
--
--   - single-use token/code consumption: `UPDATE email_login_attempts SET
--     consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`
--     — 0 rows changed = already consumed/expired/unknown, by construction.
--   - the 5-guess code ceiling: `UPDATE email_login_attempts SET
--     code_attempts = code_attempts + 1 WHERE id = ? AND code_attempts < 5
--     AND consumed_at IS NULL AND expires_at > ?` — every concurrent guess
--     (right or wrong) contends for the SAME row's ceiling; only the first 5
--     across ALL concurrent callers combined ever get a slot, regardless of
--     how many requests arrive at once.
--   - the /start and /verify rate limits: `email_login_rate_limits` below,
--     an UPSERT whose `DO UPDATE ... WHERE count < ?` either increments or is
--     a no-op — SQLite's upsert WHERE-clause semantics make "check the
--     ceiling and increment" ONE atomic statement, not two.
--
-- Not applied by this build — branch/schema only, same convention as every
-- migration since 0143 (a human applies it). MIGRATE FIRST, before deploying
-- the code in this PR: the new email-login routes read/write these tables
-- unconditionally once EMAIL_LOGIN_ENABLED='true' is set, and the flag stays
-- off in every existing deployment until an operator opts in — so applying
-- this migration is safe on every pot regardless of whether the flag is ever
-- flipped.

CREATE TABLE email_login_attempts (
  id                  TEXT    NOT NULL PRIMARY KEY, -- the "a=" attempt id (opaque, url-safe)
  tenant              TEXT    NOT NULL,
  email_normalized    TEXT    NOT NULL,
  token_hash          TEXT    NOT NULL, -- sha256(raw link token) — the raw token never persists
  code_hash           TEXT    NOT NULL, -- sha256(raw 6-digit code) — ditto
  pending_invite_id   TEXT,             -- bound at /start time from the mupot_pending_invite
                                         -- cookie, mirroring how /auth/login binds it into
                                         -- OAuth state (src/auth/pending-invite-link.ts)
  code_attempts       INTEGER NOT NULL DEFAULT 0,
  consumed_at         TEXT,             -- single-use marker; NULL = still live
  expires_at          TEXT    NOT NULL,
  created_at          TEXT    NOT NULL
);

-- The "find my current attempt" lookup for the typed-in-code path (POST
-- /auth/email/verify {email, code} carries no attempt id) — read-only, never
-- the decision itself; the decision is always the atomic UPDATE above.
CREATE INDEX idx_email_login_attempts_email_lookup
  ON email_login_attempts (tenant, email_normalized, created_at DESC);

-- Fixed-window counters for both /start (per-email, per-IP) and /verify
-- (per-IP). A row per (tenant, scope, key, window_start); the UPSERT's
-- `DO UPDATE ... WHERE count < ?` is what makes "read the count, compare,
-- increment" atomic — SQLite skips the UPDATE (0 rows changed, no error) when
-- the WHERE is false, so a caller reads authorization from `meta.changes`
-- alone, never from a prior SELECT. Fixed 10-minute buckets, not a sliding
-- window: a caller at a bucket boundary can see up to 2x the stated ceiling
-- across the two adjacent buckets — an accepted, documented simplification
-- (the property this migration exists to guarantee is atomicity under
-- concurrency, not exact sliding-window precision; see
-- docs/operations/email-login.md).
CREATE TABLE email_login_rate_limits (
  tenant        TEXT    NOT NULL,
  scope         TEXT    NOT NULL CHECK (scope IN ('start_email', 'start_ip', 'verify_ip')),
  key           TEXT    NOT NULL, -- normalized email for start_email; the resolved
                                   -- cf-connecting-ip value (or 'unknown') for *_ip
  window_start  TEXT    NOT NULL, -- ISO instant the 10-minute bucket started
  count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant, scope, key, window_start)
);
