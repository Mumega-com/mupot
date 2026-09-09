-- 0149_capability_expiry.sql — a standing capability grant may now END on its own.
--
-- WHY
--
-- Until now `capabilities` had no expiry at all: every grant was forever, and
-- the only way to narrow one was for a human to remember to revoke it. That is
-- why "give this agent access to stand up its own squad" kept collapsing into
-- "make it an admin" — there was no shape in the schema for a grant that is
-- both REAL (the agent acts on its own, with no approval per action) and
-- BOUNDED (it stops without anyone doing anything).
--
-- Session-bound elevation (0148) solves a different problem: a human approves
-- each request, and the grant dies with the agent session. That is the right
-- tool for a one-off privileged act. It is the wrong tool for "this agent leads
-- this squad until the end of the quarter", because it puts a human in the loop
-- every single time.
--
-- MECHANISM ONLY. Exactly like 0099 did for member_tokens: add the column,
-- change nothing about existing rows. `expires_at IS NULL` means NON-EXPIRING,
-- which is what every current grant is, so applying this migration expires
-- nothing and alters no behaviour on its own.
--
-- The NULL arm is load-bearing for the same reason it is in
-- src/auth/token-lifecycle.ts: SQL three-valued logic drops NULL rows from any
-- comparison, so a predicate without an explicit `IS NULL` branch would
-- silently stop resolving every grant in the table — an instant, total,
-- self-inflicted authorization outage. See CAPABILITY_LIVE_PREDICATE.
ALTER TABLE capabilities ADD COLUMN expires_at TEXT;

-- Sweep support: find grants past their horizon without scanning the whole
-- table. Partial index on the expiring subset only — the overwhelming majority
-- of rows are non-expiring and never need visiting.
CREATE INDEX IF NOT EXISTS idx_capabilities_expiry
    ON capabilities (expires_at)
 WHERE expires_at IS NOT NULL;
