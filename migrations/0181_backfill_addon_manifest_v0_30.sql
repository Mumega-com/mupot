-- 0181_backfill_addon_manifest_v0_30.sql — repair the identity drift the
-- v0.31.0 version bump opens for any live addon_installations rows.
--
-- Why this exists (see mupot kasra/release-v0.31.0, the v0.31.0 version-bump
-- PR): MUPOT_PUBLIC_API_VERSION moved 0.30.0 -> 0.31.0 and, in the same PR,
-- every NATIVE addon manifest's `mupotCompatibility` moved ^0.29.0 -> ^0.30.0
-- (marketing-cro-monitor, project-link, workflow-circuits, fixture-addon,
-- fixture-addon-with-loop — src/addons/modules/*, src/addons/*/manifest.ts).
-- assertAddonRuntimeContract (src/addons/registry.ts) only grants a *native*
-- addon a one-minor grace band (supportsAdditiveNativePreviousMinor): a
-- manifest pinned at ^0.29.0 satisfies that band against 0.30.0 (one minor
-- ahead) but NOT against 0.31.0 (two minors ahead) — registerAddon() would
-- throw `addon_mupot_incompatible` for every one of these five manifests at
-- Worker boot without the compat bump.
--
-- mcpwp-office is NOT exempt the way it looks at first: its manifest derives
-- `mupotCompatibility` as `^${MUPOT_PUBLIC_API_VERSION}` (src/addons/office/
-- manifest.ts), so registerAddon() never throws for it (its compat always
-- equals the running version exactly) — but that same derivation means its
-- manifest CONTENT, and therefore its manifestSha256() digest, changes on
-- EVERY version bump, including this one (^0.30.0 -> ^0.31.0). Any tenant
-- that called `installAddon('mcpwp-office')` while the source ran 0.30.0
-- (slice 2's write-binding CHECK gap blocks configure/activate, not install
-- — see docs/releases/v0.31.0-office-plan.md) has a row stored at the OLD
-- ^0.30.0 identity, and drifts the same way the five native addons would
-- have. This migration repairs six addon keys, not five.
--
-- matchesRegisteredIdentity (src/addons/service.ts) byte-compares each live
-- installation's manifest_sha256 AND mupot_compatibility against the
-- currently-registered catalog entry; the moment the bumped manifests
-- deploy, any live installation still stored at an OLD identity drifts and
-- every binding preflight / configure / activate / disable call for it
-- starts returning manifest_digest_drift. There is no upgrade/reregister
-- path in the codebase (same gap 0089 repaired for the prior ^0.24.0 ->
-- ^0.29.0 bump), so any such row freezes unrecoverably unless its stored
-- identity is brought forward to match the new manifests.
--
-- WHERE GUARD (tightened from an earlier draft caught in review): each
-- UPDATE matches on addon_key AND the OLD manifest_sha256 AND the OLD
-- mupot_compatibility together — not compat alone. Compat alone would also
-- match, and silently "bless" forward, a row whose stored digest is neither
-- the expected old value NOR anything this migration recognizes (a hand
-- edit, a different addon version, database corruption) — exactly the kind
-- of drift a backfill migration must surface, not paper over. Guarding on
-- the exact old digest means such a row matches zero rows here and is left
-- exactly as it was: still frozen, still visible to an operator as
-- manifest_digest_drift, which is the correct signal for something a
-- migration cannot safely repair unattended. Unlike 0089 (which named two
-- specific tenant=mumega rows verified live in prod at the time), this
-- migration does not assume which tenants currently hold a live
-- installation of these six addon keys — it repairs any row, in any tenant,
-- still at exactly the known old identity.
--
-- ONE UPDATE PER ADDON, NOT A SINGLE CASE-UPDATE, same reasoning as 0089:
-- the six manifests differ (departments, connectorRequirements, loops,
-- consoleSections, approvalPolicies), so their manifestSha256() digests
-- differ too, and a missed/misordered CASE branch fails silently where a
-- self-contained UPDATE fails loud or matches zero rows.
--
-- Digests below are the literal output of this repo's OWN manifestSha256()
-- (src/addons/contract.ts) run over each addon's manifest at both its old
-- and new compat, computed via `npx vitest run` (a throwaway test, not
-- hand-typed) and pinned for machine-checking by
-- tests/addon-manifest-backfill-0181.test.ts, which also proves the trigger
-- recreated below is byte-identical to sqlite_master's own record of the
-- trigger as it stood immediately after 0178 (not a hand copy comparison).
--
-- THE TRIGGER: addon_installations_identity_is_immutable (0050_addons.sql,
-- widened by 0178_addon_isolation_class_immutable.sql to also cover
-- isolation_class) is a BEFORE UPDATE trigger that ABORTs any UPDATE
-- touching manifest_sha256 or mupot_compatibility when the new value
-- differs from the old one. A backfill migration correcting identity that
-- itself drifted from underneath the row (not a change the row's own
-- history authorized) is the one sanctioned exception — same precedent as
-- 0089. We DROP the CURRENT (post-0178) trigger body, perform the six
-- identity-repair UPDATEs, then CREATE it again byte-for-byte so the
-- invariant is back in force for every write after this migration commits.
-- `wrangler d1 migrations apply` runs the whole file inside one
-- transaction, so if any UPDATE fails, the DROP itself rolls back too — the
-- trigger is never left absent.
--
-- Next migration number is 0182 — reserved for mupot#1592's fix, per
-- coordinator instruction (this file takes 0181).

DROP TRIGGER IF EXISTS addon_installations_identity_is_immutable;

UPDATE addon_installations
   SET mupot_compatibility = '^0.30.0',
       manifest_sha256     = '7c6081a3debd40846c4c724110917c1c2685ebe315f081e9d73b2ad258225c6a'
 WHERE addon_key = 'marketing-cro-monitor'
   AND manifest_sha256 = '6834802d7cc92f56c49f29a59432d514ccfd116af06b7dbd36aa66d18ae028ed'
   AND mupot_compatibility = '^0.29.0';

UPDATE addon_installations
   SET mupot_compatibility = '^0.30.0',
       manifest_sha256     = '139f17b91d4ce39b23f510c4006826d3ddfa95e11c13d30ba528bcb36e8dd629'
 WHERE addon_key = 'project-link'
   AND manifest_sha256 = '41568a456cd69bc49b49ff9d873447ac110f1aa6f92869ea5c164c86b2dcc2b0'
   AND mupot_compatibility = '^0.29.0';

UPDATE addon_installations
   SET mupot_compatibility = '^0.30.0',
       manifest_sha256     = '3e7e7084eb77f6cc8f27f93d3370294c1ed6d399a674acc1a8d272053f0dd661'
 WHERE addon_key = 'workflow-circuits'
   AND manifest_sha256 = '133be3834dbf88f97d8b4c61666482cbd2cfa8f8d3bb52cad965fe0c4fcba5bb'
   AND mupot_compatibility = '^0.29.0';

UPDATE addon_installations
   SET mupot_compatibility = '^0.30.0',
       manifest_sha256     = '5dc890ecb8ad0f17ca934f4862d80974af2a8fd1f3f8d89469085d1433376cea'
 WHERE addon_key = 'fixture-addon'
   AND manifest_sha256 = 'aeb4e6b4655b8ba14534cf73149a62a97fb8a9eb15da12e63c765f114eeb759c'
   AND mupot_compatibility = '^0.29.0';

UPDATE addon_installations
   SET mupot_compatibility = '^0.30.0',
       manifest_sha256     = '747d860766a47f0788eca7e130d72f73e2fcee08e5f4f858199fd766203307d3'
 WHERE addon_key = 'fixture-addon-with-loop'
   AND manifest_sha256 = '7bac7713f24b7ca53fc76840c105070ace3caa36f6fa04986be6f001bc919c12'
   AND mupot_compatibility = '^0.29.0';

UPDATE addon_installations
   SET mupot_compatibility = '^0.31.0',
       manifest_sha256     = '9ee9eb05c9a5a469e67e88e98aca68b0654448f539dcb3744eb48c090139c84f'
 WHERE addon_key = 'mcpwp-office'
   AND manifest_sha256 = '5821d637d3c3cadcf2f0ade81d66cabd644d4788c0e6e94fe9e6409f631f3b28'
   AND mupot_compatibility = '^0.30.0';

CREATE TRIGGER addon_installations_identity_is_immutable
  BEFORE UPDATE OF id, tenant, addon_key, installed_version, publisher,
    trust_class, manifest_sha256, mupot_compatibility, installed_by, isolation_class
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
    OR NEW.isolation_class IS NOT OLD.isolation_class
BEGIN
  SELECT RAISE(ABORT, 'addon installation identity is immutable');
END;
