-- 0167_pots_registry_provisioner.sql — records WHO claimed a slug, so a retry
-- can be told apart from a takeover (mupot#1507 round-2 adversarial gate,
-- Athena condition i: "reuse-by-name is allowed ONLY when the caller is the
-- pot's registered provisioner").
--
-- Before this, `provisionSovereignPot` adopted any existing D1/KV/worker
-- whose NAME matched the requested slug, with no check on who created it.
-- Two org-admins (or the same admin retrying, or a hostile one squatting a
-- slug first) racing the same slug meant whoever called second silently
-- inherited whatever the first left behind — including, on a race, a
-- still-in-flight seed. `pots` (migration 0145) already exists as the
-- account-wide slug registry `checkSlugAvailability` reads; this adds the
-- missing half — who is allowed to call `provisionSovereignPot` again for a
-- given slug and have it ADOPT rather than refuse `pot_slug_taken`.
--
-- Additive, nullable, no backfill: existing `pots` rows (only ever written by
-- the 2026-09-04 namespace-audit seed per 0145's own header, and by this
-- PR's own writes going forward) have no provisioner on record, which reads
-- as "nobody currently holds a reuse claim" — the safe default (fail closed
-- toward `pot_slug_taken` for a foreign caller, never open toward adoption).

ALTER TABLE pots ADD COLUMN provisioner_member_id TEXT;
ALTER TABLE pots ADD COLUMN provisioner_tenant TEXT;

CREATE INDEX IF NOT EXISTS idx_pots_provisioner
  ON pots(provisioner_member_id);

-- mupot#1507-v2 P0-C (this migration rewritten in place — still unmerged/
-- branch-only): `checkout.ts`'s self-serve Stripe path never sets
-- `provisioner_member_id` (there is no interactive member at checkout time),
-- so a claim made through it degraded to matching `provisioner_tenant` alone
-- — the SAME value (this deployment's own `TENANT_SLUG`, or NULL when unset)
-- for every self-serve buyer. `null === null && tenant === tenant` then let
-- ANY later self-serve call for the same slug adopt whatever the first one
-- claimed — redeploying over a live customer's pot and handing the caller
-- back the victim's own admin identity references. `checkout_session_id`
-- scopes a self-serve claim to the EXACT Stripe Checkout Session that made
-- it: `provisionSovereignPot`'s registry gate now requires an exact
-- session-id match to adopt a row that carries one, which makes a webhook
-- RETRY of the same session idempotent (same session id => same claim =>
-- adopt) while refusing a genuinely different session on the same slug
-- outright — see `src/pots/service.ts`'s registry-gate ownership check and
-- `checkout.ts`'s `handlePotCreationCompleted`.
ALTER TABLE pots ADD COLUMN checkout_session_id TEXT;
