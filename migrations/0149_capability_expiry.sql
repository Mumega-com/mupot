-- 0149_capability_expiry.sql — a standing capability grant may now END on its own.
--
-- WHY
--
-- Until now `capabilities` had no expiry. Every grant was permanent, and the
-- only way to narrow one was for a human to remember to revoke it. That single
-- fact is why "let this agent stand up its own squad" kept collapsing into
-- "make it an admin": there was no shape in the schema for a grant that is both
-- REAL (the agent acts alone, no approval per action) and BOUNDED (it stops
-- without anyone doing anything).
--
-- It is also why operator_principal_required pushes people toward browser
-- sessions (mupot#1360): with no way to hand an agent bounded authority, the
-- only available authority is unbounded and belongs to a human.
--
-- MECHANISM ONLY. Exactly as 0099 was for member_tokens: add the column, change
-- nothing about existing rows. Every current grant is NULL, which the predicate
-- reads as non-expiring, so applying this expires nothing and alters no
-- behaviour by itself.
--
-- The NULL arm is load-bearing for the same reason it is in
-- src/auth/token-lifecycle.ts: SQL three-valued logic drops NULL rows from any
-- comparison, so a predicate without an explicit `IS NULL` branch would stop
-- resolving EVERY grant in the table at once — a total, instant, self-inflicted
-- authorization outage. See CAPABILITY_LIVE_PREDICATE.
ALTER TABLE capabilities ADD COLUMN expires_at TEXT;

-- Sweep support: find grants past their horizon without scanning the table.
-- Partial index on the expiring subset only — the overwhelming majority of rows
-- are non-expiring and never need visiting.
CREATE INDEX IF NOT EXISTS idx_capabilities_expiry
    ON capabilities (expires_at)
 WHERE expires_at IS NOT NULL;
