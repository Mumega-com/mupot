-- 0181_backfill_addon_manifest_v0_31.sql — repair the identity drift the
-- v0.31.0 version bump opens for any live addon_installations rows, AND
-- for their live addon_binding_generations / addon_connector_bindings —
-- round 2 of the kasra-review adversarial gate on mupot#1604 (round 1 was a
-- P0 BLOCK: this file originally moved only the installation).
--
-- Why the installation identity moves at all (see mupot kasra/release-v0.31.0,
-- the v0.31.0 version-bump PR): MUPOT_PUBLIC_API_VERSION moved 0.30.0 ->
-- 0.31.0 and, in the same PR, every NATIVE addon manifest's
-- `mupotCompatibility` moved ^0.29.0 -> ^0.30.0 (marketing-cro-monitor,
-- project-link, workflow-circuits, fixture-addon, fixture-addon-with-loop —
-- src/addons/modules/*, src/addons/*/manifest.ts). assertAddonRuntimeContract
-- (src/addons/registry.ts) only grants a *native* addon a one-minor grace
-- band (supportsAdditiveNativePreviousMinor): a manifest pinned at ^0.29.0
-- satisfies that band against 0.30.0 (one minor ahead) but NOT against
-- 0.31.0 (two minors ahead) — registerAddon() would throw
-- `addon_mupot_incompatible` for every one of these five manifests at
-- Worker boot without the compat bump.
--
-- mcpwp-office's manifest ALSO moves: it was previously derived as
-- `^${MUPOT_PUBLIC_API_VERSION}` (always exactly the running version, so
-- registerAddon() never threw for it), but the same release PR pins it to a
-- literal `^0.31.0` instead (round-1 P2: a derived compat would need this
-- exact backfill on every future bump, patches included, since an
-- external_isolated addon gets no grace band at all — "external addons
-- remain on strict semver compatibility" is deliberate, by design, in
-- assertAddonRuntimeContract). Verified: pinning the literal at the value
-- the constant already evaluated to produces the IDENTICAL manifestSha256
-- (a string is a string regardless of how it was constructed), so
-- mcpwp-office's NEW digest below is unchanged from before the pin — only
-- its OLD (pre-this-PR, derived-under-0.30.0) digest needed backfilling,
-- same as the five native addons.
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
-- ============================================================================
-- ROUND-1 P0: addon_binding_generations and addon_connector_bindings keep
-- their OWN immutable snapshot of manifest_sha256, and moving only the
-- installation breaks every configured/active/disabled addon with no
-- self-service way back.
-- ============================================================================
--
-- src/addons/service.ts's activate EXISTS check (~3357), the marketing live-
-- generation lookup (src/addons/marketing/service.ts ~463,
-- `AND manifest_sha256 = ?3`), the marketing_monitor_runs insert/finalize
-- fences (0053/0064), and bindingSnapshotMatches (src/dashboard/marketing-
-- cro-monitor.ts ~95) all treat `generation.manifest_sha256 =
-- installation.manifest_sha256` as an invariant. After the installation-only
-- backfill, every one of those reads `binding_generation_not_live` or
-- `write_failed`, and reconfiguring cannot fix it: `configureAddonBindings`
-- treats identical bindings as an idempotent no-op (no new generation), so
-- addons with no connector requirements (workflow-circuits, project-link,
-- both fixtures) have no escape short of archive and reinstall.
--
-- PROD, READ LIVE (read-only) before writing this fix:
--   marketing-cro-monitor, active: installation manifest_sha256 =
--     6834802d7cc9... (mupotCompatibility ^0.29.0, matches this migration's
--     OLD marketing digest below), live generation manifest_sha256 =
--     76369cbe970b... — ALREADY a different value from the installation.
--     0089 (^0.24.0 -> ^0.29.0) moved only the installation the same way
--     this file originally did; prod's monitor has most likely been
--     returning binding_generation_not_live since 0089 shipped. This
--     migration's heal logic (below) is keyed to the parent installation's
--     CURRENT digest, not to a hardcoded old value, precisely so this
--     pre-existing split heals too, not only the ^0.29.0 -> ^0.30.0 move.
--   workflow-circuits, active: installation = generation (no split).
--   project-link, installed: no generation (never configured).
--   3 archived rows (fixture-addon, marketing-cro-monitor x2) at ^0.23.0:
--     no live generations — excluded from every UPDATE below by
--     `state <> 'archived'` regardless, and structurally excluded again
--     because addon_installations_archive_requires_revoked_generation
--     (0052) already forces every generation to be revoked before an
--     installation can reach 'archived'.
--   No mcpwp-office installation exists in prod today; handled anyway
--     (backfilled defensively, a no-op if no row ever matches).
--
-- THE FIX: heal every LIVE (revoked_at IS NULL) generation and binding to
-- match its PARENT INSTALLATION's chorus digest — keyed to the
-- installation via a correlated subquery, not to any specific old digest.
-- This one condition (`live row's manifest_sha256 <> its installation's
-- CURRENT manifest_sha256`, evaluated AFTER the installation UPDATEs above
-- have already run) covers both cases the review asked for as one thing:
-- rows this migration just moved, and rows already split before this
-- migration touched them (marketing's real case). `state <> 'archived'` on
-- the correlated installation keeps this from ever touching a discarded
-- history row, belt-and-braces on top of the schema's own guarantee that an
-- archived installation cannot have a live generation at all.
--
-- WHY THIS IS THE ONE SANCTIONED EXCEPTION: addon_binding_generations_revoke_only
-- and addon_connector_bindings_revoke_only (0052_addon_bindings.sql) are
-- BEFORE UPDATE triggers that abort any change to a live row except turning
-- it revoked — by design, so no ordinary code path can rewrite a
-- generation's or binding's snapshotted identity out from under
-- matchesGenerationIdentity-style checks. A backfill migration correcting
-- identity that itself drifted from underneath the row (not a change the
-- row's own history authorized) is the one sanctioned exception — the exact
-- same reasoning 0089 and this file's own installation trigger already
-- apply. We DROP all three CURRENT (post-0178) trigger bodies, perform the
-- identity-repair UPDATEs (installations, then generations, then bindings —
-- in that order, since the heal UPDATEs read the installation's NEW value),
-- then CREATE all three again byte-for-byte so every invariant is back in
-- force for every write after this migration commits. `wrangler d1
-- migrations apply` runs the whole file inside one transaction, so if any
-- statement fails, every DROP rolls back too — no trigger is ever left
-- absent.
--
-- Round-1 P3s also applied: `AND state <> 'archived'` added to the
-- installation UPDATEs (archived history keeps its identity, even though
-- the immutable-trigger drop would otherwise let it move too); this file
-- renamed from `_v0_30` to `_v0_31` (it is the 0.31.0 bump, not 0.30.0's).
--
-- Round-1 P1 (0089 pre-existing split): the read-only SELECT the adversarial
-- review specified is the go/no-go and post-check for the operator running
-- this migration, not something a migration file can assert for itself —
-- see the PR description for the exact query and the recommended deploy
-- order (code first, then `migrations apply --remote` immediately).
--
-- Round-1 P2 (historical monitor runs): marketing/service.ts's read scope
-- filters `run.manifest_sha256 = <current>`, so pre-migration
-- marketing_monitor_runs rows drop out of the latest/history views even
-- after this fix. Not touched here — accepted and documented, per the
-- review's own framing of the choice, not decided by a data migration.
--
-- Digests below are the literal output of this repo's OWN manifestSha256()
-- (src/addons/contract.ts) run over each addon's manifest at both its old
-- and new compat, computed via `npx vitest run` (a throwaway test, not
-- hand-typed) and pinned for machine-checking by
-- tests/addon-manifest-backfill-0181.test.ts, which also proves the three
-- recreated triggers are byte-identical to what sqlite_master itself
-- recorded for them beforehand — not a hand copy.

DROP TRIGGER IF EXISTS addon_installations_identity_is_immutable;
DROP TRIGGER IF EXISTS addon_binding_generations_revoke_only;
DROP TRIGGER IF EXISTS addon_connector_bindings_revoke_only;

UPDATE addon_installations
   SET mupot_compatibility = '^0.30.0',
       manifest_sha256     = '7c6081a3debd40846c4c724110917c1c2685ebe315f081e9d73b2ad258225c6a'
 WHERE addon_key = 'marketing-cro-monitor'
   AND manifest_sha256 = '6834802d7cc92f56c49f29a59432d514ccfd116af06b7dbd36aa66d18ae028ed'
   AND mupot_compatibility = '^0.29.0'
   AND state <> 'archived';

UPDATE addon_installations
   SET mupot_compatibility = '^0.30.0',
       manifest_sha256     = '139f17b91d4ce39b23f510c4006826d3ddfa95e11c13d30ba528bcb36e8dd629'
 WHERE addon_key = 'project-link'
   AND manifest_sha256 = '41568a456cd69bc49b49ff9d873447ac110f1aa6f92869ea5c164c86b2dcc2b0'
   AND mupot_compatibility = '^0.29.0'
   AND state <> 'archived';

UPDATE addon_installations
   SET mupot_compatibility = '^0.30.0',
       manifest_sha256     = '3e7e7084eb77f6cc8f27f93d3370294c1ed6d399a674acc1a8d272053f0dd661'
 WHERE addon_key = 'workflow-circuits'
   AND manifest_sha256 = '133be3834dbf88f97d8b4c61666482cbd2cfa8f8d3bb52cad965fe0c4fcba5bb'
   AND mupot_compatibility = '^0.29.0'
   AND state <> 'archived';

UPDATE addon_installations
   SET mupot_compatibility = '^0.30.0',
       manifest_sha256     = '5dc890ecb8ad0f17ca934f4862d80974af2a8fd1f3f8d89469085d1433376cea'
 WHERE addon_key = 'fixture-addon'
   AND manifest_sha256 = 'aeb4e6b4655b8ba14534cf73149a62a97fb8a9eb15da12e63c765f114eeb759c'
   AND mupot_compatibility = '^0.29.0'
   AND state <> 'archived';

UPDATE addon_installations
   SET mupot_compatibility = '^0.30.0',
       manifest_sha256     = '747d860766a47f0788eca7e130d72f73e2fcee08e5f4f858199fd766203307d3'
 WHERE addon_key = 'fixture-addon-with-loop'
   AND manifest_sha256 = '7bac7713f24b7ca53fc76840c105070ace3caa36f6fa04986be6f001bc919c12'
   AND mupot_compatibility = '^0.29.0'
   AND state <> 'archived';

UPDATE addon_installations
   SET mupot_compatibility = '^0.31.0',
       manifest_sha256     = '9ee9eb05c9a5a469e67e88e98aca68b0654448f539dcb3744eb48c090139c84f'
 WHERE addon_key = 'mcpwp-office'
   AND manifest_sha256 = '5821d637d3c3cadcf2f0ade81d66cabd644d4788c0e6e94fe9e6409f631f3b28'
   AND mupot_compatibility = '^0.30.0'
   AND state <> 'archived';

-- Heal every live binding generation to match its (now-current) parent
-- installation — keyed to the installation, not to any specific old digest,
-- so both a row this migration just moved AND a pre-existing split (prod's
-- real marketing-cro-monitor state) heal the same way.
UPDATE addon_binding_generations
   SET manifest_sha256 = (
     SELECT installation.manifest_sha256
       FROM addon_installations AS installation
      WHERE installation.id = addon_binding_generations.installation_id
        AND installation.tenant = addon_binding_generations.tenant
   )
 WHERE revoked_at IS NULL
   AND EXISTS (
     SELECT 1
       FROM addon_installations AS installation
      WHERE installation.id = addon_binding_generations.installation_id
        AND installation.tenant = addon_binding_generations.tenant
        AND installation.state <> 'archived'
        AND installation.manifest_sha256 <> addon_binding_generations.manifest_sha256
   );

-- Same heal, same reasoning, for live connector bindings.
UPDATE addon_connector_bindings
   SET manifest_sha256 = (
     SELECT installation.manifest_sha256
       FROM addon_installations AS installation
      WHERE installation.id = addon_connector_bindings.installation_id
        AND installation.tenant = addon_connector_bindings.tenant
   )
 WHERE revoked_at IS NULL
   AND EXISTS (
     SELECT 1
       FROM addon_installations AS installation
      WHERE installation.id = addon_connector_bindings.installation_id
        AND installation.tenant = addon_connector_bindings.tenant
        AND installation.state <> 'archived'
        AND installation.manifest_sha256 <> addon_connector_bindings.manifest_sha256
   );

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

CREATE TRIGGER addon_binding_generations_revoke_only
  BEFORE UPDATE ON addon_binding_generations
  WHEN OLD.revoked_at IS NOT NULL
    OR NEW.revoked_at IS NULL
    OR length(NEW.revoked_at) <> 24
    OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.revoked_at) IS NOT NEW.revoked_at
    OR NEW.revoked_at < OLD.configured_at
    OR NEW.id IS NOT OLD.id
    OR NEW.tenant IS NOT OLD.tenant
    OR NEW.installation_id IS NOT OLD.installation_id
    OR NEW.configuration_sha256 IS NOT OLD.configuration_sha256
    OR NEW.binding_count IS NOT OLD.binding_count
    OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256
    OR NEW.configured_by IS NOT OLD.configured_by
    OR NEW.configured_at IS NOT OLD.configured_at
    OR NEW.previous_generation_id IS NOT OLD.previous_generation_id
    OR NEW.expected_installation_state IS NOT OLD.expected_installation_state
    OR NEW.base_receipt_id IS NOT OLD.base_receipt_id
BEGIN
  SELECT RAISE(ABORT, 'addon binding generations are append-only except revocation');
END;

CREATE TRIGGER addon_connector_bindings_revoke_only
  BEFORE UPDATE ON addon_connector_bindings
  WHEN OLD.revoked_at IS NOT NULL
    OR NEW.revoked_at IS NULL
    OR length(NEW.revoked_at) <> 24
    OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.revoked_at) IS NOT NEW.revoked_at
    OR NEW.revoked_at < OLD.configured_at
    OR NEW.id IS NOT OLD.id
    OR NEW.tenant IS NOT OLD.tenant
    OR NEW.installation_id IS NOT OLD.installation_id
    OR NEW.generation_id IS NOT OLD.generation_id
    OR NEW.slot IS NOT OLD.slot
    OR NEW.adapter IS NOT OLD.adapter
    OR NEW.binding_kind IS NOT OLD.binding_kind
    OR NEW.capability IS NOT OLD.capability
    OR NEW.connector_id IS NOT OLD.connector_id
    OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256
    OR NEW.configured_by IS NOT OLD.configured_by
    OR NEW.configured_at IS NOT OLD.configured_at
BEGIN
  SELECT RAISE(ABORT, 'addon bindings are append-only except revocation');
END;
