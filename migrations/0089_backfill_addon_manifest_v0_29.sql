-- 0089_backfill_addon_manifest_v0_29.sql — repair the ^0.24.0 addon identity
-- drift that #806 opened for the two live, non-archived addon_installations
-- rows.
--
-- Numbering deviation: Athena's brief named this migration 0088. That number
-- is taken by 0088_channel_mention_budget_v2.sql (open PR #865, not yet on
-- main at the time this branch was cut). Filed as 0089 instead to avoid a
-- collision; noted here per the brief's instruction to flag the deviation.
--
-- Why this exists (see gh #806, 12ff4b6):
-- MUPOT_PUBLIC_API_VERSION moved to 0.29.0 and, in the same commit, all
-- native addon manifests' `mupotCompatibility` moved ^0.24.0 -> ^0.29.0. Prod
-- addon_installations has exactly two live (non-archived) rows still at
-- ^0.24.0: marketing-cro-monitor (tenant=mumega, state=active) and
-- project-link (tenant=mumega, state=installed). assertAddonRuntimeContract
-- (src/addons/registry.ts) only grants a *native* addon a one-minor grace
-- band; five minors is outside it, so `^0.24.0` cannot simply be left alone.
-- matchesRegisteredIdentity (src/addons/service.ts) byte-compares each live
-- installation's manifest_sha256 AND mupot_compatibility against the
-- currently-registered catalog entry; on deploy both rows drift and every
-- binding preflight / configure / activate / disable call for them starts
-- returning manifest_digest_drift. There is no upgrade/reregister path in
-- the codebase, so both installs freeze unrecoverably unless their stored
-- identity is brought forward to match the v0.29.0 manifests.
--
-- ONE UPDATE PER ADDON, NOT A SINGLE CASE-UPDATE: the two addons' manifests
-- differ (departments, connectorRequirements, loops, consoleSections,
-- approvalPolicies), so their manifestSha256() digests differ too. A single
-- UPDATE with a CASE expression would still work, but a missed/misordered
-- WHEN branch fails silently (defaults to no-op or wrong digest) where a
-- second self-contained UPDATE — full WHERE guard, single digest, no
-- conditional — fails LOUD (wrong-row assertion, digest mismatch) or simply
-- matches zero rows. Each statement is independently auditable against one
-- addon's registered manifest.
--
-- Digests below are the literal output of this repo's OWN manifestSha256()
-- (src/addons/contract.ts) run over MarketingCroMonitorAddon
-- (src/addons/modules/marketing-cro-monitor.ts) and ProjectLinkAddon
-- (src/addons/project-link/manifest.ts) as committed on this branch —
-- computed via `npx vitest run`, not hand-typed. tests/addon-manifest-backfill-0089.test.ts
-- asserts these constants equal a fresh manifestSha256() call over the same
-- manifests, so if either manifest changes later without updating this file
-- (impossible anyway — migrations are immutable history), or if these
-- constants were ever mistyped, that test goes red.
--
-- The WHERE clauses are load-bearing: tenant + addon_key + the OLD
-- mupot_compatibility value together guard idempotence (a second run
-- matches zero rows, since the value is no longer '^0.24.0') and prevent
-- clobbering any row that isn't in exactly the drifted state this migration
-- is meant to repair. Do not widen them.
--
-- THE TRIGGER: addon_installations_identity_is_immutable (0050_addons.sql)
-- is a BEFORE UPDATE trigger that ABORTs any UPDATE touching manifest_sha256
-- or mupot_compatibility when the new value differs from the old one — by
-- design, so no ordinary code path can ever drift an installation's
-- identity out from under matchesRegisteredIdentity(). A backfill migration
-- correcting identity that itself drifted from underneath the row (not a
-- change the row's own history authorized) is the one sanctioned exception.
-- We DROP the trigger, perform the two identity-repair UPDATEs, then CREATE
-- it again verbatim so the invariant is back in force for every write after
-- this migration commits. `wrangler d1 migrations apply` runs an entire
-- migration file inside one transaction (see
-- tests/agent-status-migration.test.ts for the documented precedent in this
-- repo), so if either UPDATE fails for any reason, the DROP itself rolls
-- back too — the trigger is never left absent.

DROP TRIGGER IF EXISTS addon_installations_identity_is_immutable;

UPDATE addon_installations
   SET mupot_compatibility = '^0.29.0',
       manifest_sha256     = '6834802d7cc92f56c49f29a59432d514ccfd116af06b7dbd36aa66d18ae028ed'
 WHERE tenant = 'mumega'
   AND addon_key = 'marketing-cro-monitor'
   AND mupot_compatibility = '^0.24.0';

UPDATE addon_installations
   SET mupot_compatibility = '^0.29.0',
       manifest_sha256     = '41568a456cd69bc49b49ff9d873447ac110f1aa6f92869ea5c164c86b2dcc2b0'
 WHERE tenant = 'mumega'
   AND addon_key = 'project-link'
   AND mupot_compatibility = '^0.24.0';

CREATE TRIGGER IF NOT EXISTS addon_installations_identity_is_immutable
  BEFORE UPDATE OF id, tenant, addon_key, installed_version, publisher,
    trust_class, manifest_sha256, mupot_compatibility, installed_by
  ON addon_installations
  WHEN NEW.id IS NOT OLD.id
    OR NEW.tenant IS NOT OLD.tenant
    OR NEW.addon_key IS NOT OLD.addon_key
    OR NEW.installed_version IS NOT OLD.installed_version
    OR NEW.publisher IS NOT OLD.publisher
    OR NEW.trust_class IS NOT OLD.trust_class
    OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256
    OR NEW.mupot_compatibility IS NOT OLD.mupot_compatibility
    OR NEW.installed_by IS NOT OLD.installed_by
BEGIN
  SELECT RAISE(ABORT, 'addon installation identity is immutable');
END;
