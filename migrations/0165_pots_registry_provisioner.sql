-- 0165_pots_registry_provisioner.sql — records WHO claimed a slug, so a retry
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
