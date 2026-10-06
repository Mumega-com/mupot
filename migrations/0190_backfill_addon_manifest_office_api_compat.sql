-- 0190_backfill_addon_manifest_office_api_compat.sql — move the live
-- mcpwp-office installation identity (and its live binding generations /
-- connector bindings) to the new manifest digest after `addonApiCompatibility`
-- became REQUIRED and digest-bound for external_isolated manifests
-- (mupot#1694, ADDON_API_VERSION decoupling).
--
-- WHY ONLY mcpwp-office: for native_reviewed manifests `addonApiCompatibility`
-- is excluded from manifestSha256, so the five native digests are byte-identical
-- to before and NO native row moves. mcpwp-office is the only external_isolated
-- manifest; its API claim is part of its reviewed identity, so its digest
-- moves: 9ee9eb05c9a5a469e67e88e98aca68b0654448f539dcb3744eb48c090139c84f
-- -> 7d66a75e95732366e71c87f34b5d5586b5bb005ddea6e3369d8725fa09a91ad2. `mupot_compatibility` ('^0.31.0') is NOT changed.
--
-- Same mechanics as 0181: matchesRegisteredIdentity byte-compares the stored
-- manifest_sha256, and addon_binding_generations / addon_connector_bindings
-- each keep their own snapshot of it, so all three are moved together. The
-- heal UPDATEs are keyed to the parent installation AND restricted to
-- addon_key = 'mcpwp-office' — native rows are never touched.
--
-- Idempotent: the installation UPDATE is guarded by addon_key + the exact OLD
-- digest + compat + state <> 'archived' (second run matches zero rows); the heal
-- UPDATEs are exact-pair: a live child row moves OLD -> NEW only when it still
-- holds the exact OLD digest AND its parent installation now holds the exact
-- NEW digest. A parent with any other (unexpected) digest — deliberately left
-- untouched by the installation UPDATE — never has its children rewritten
-- (Athena gate on #1694: the migration's own WHERE is the safety boundary,
-- not the pre-apply probe).
--
-- Triggers: the three identity/revoke-only triggers are dropped for the repair
-- and recreated byte-for-byte (current bodies: identity + generations from
-- 0181, connector bindings from 0184 incl. capability_v2). One transaction
-- under `wrangler d1 migrations apply`, so a failure rolls the DROPs back.
--
-- BEFORE APPLYING run scripts/verify-addon-office-identity-0190.sql (read-only)
-- against live addon_installations: every non-archived mcpwp-office row must
-- show manifest_sha256 = old digest. Zero rows is also fine (no-op).

DROP TRIGGER IF EXISTS addon_installations_identity_is_immutable;
DROP TRIGGER IF EXISTS addon_binding_generations_revoke_only;
DROP TRIGGER IF EXISTS addon_connector_bindings_revoke_only;

UPDATE addon_installations
   SET manifest_sha256 = '7d66a75e95732366e71c87f34b5d5586b5bb005ddea6e3369d8725fa09a91ad2'
 WHERE addon_key = 'mcpwp-office'
   AND manifest_sha256 = '9ee9eb05c9a5a469e67e88e98aca68b0654448f539dcb3744eb48c090139c84f'
   AND mupot_compatibility = '^0.31.0'
   AND state <> 'archived';

UPDATE addon_binding_generations
   SET manifest_sha256 = '7d66a75e95732366e71c87f34b5d5586b5bb005ddea6e3369d8725fa09a91ad2'
 WHERE revoked_at IS NULL
   AND manifest_sha256 = '9ee9eb05c9a5a469e67e88e98aca68b0654448f539dcb3744eb48c090139c84f'
   AND EXISTS (
     SELECT 1
       FROM addon_installations AS installation
      WHERE installation.id = addon_binding_generations.installation_id
        AND installation.tenant = addon_binding_generations.tenant
        AND installation.addon_key = 'mcpwp-office'
        AND installation.state <> 'archived'
        AND installation.manifest_sha256 = '7d66a75e95732366e71c87f34b5d5586b5bb005ddea6e3369d8725fa09a91ad2'
   );

UPDATE addon_connector_bindings
   SET manifest_sha256 = '7d66a75e95732366e71c87f34b5d5586b5bb005ddea6e3369d8725fa09a91ad2'
 WHERE revoked_at IS NULL
   AND manifest_sha256 = '9ee9eb05c9a5a469e67e88e98aca68b0654448f539dcb3744eb48c090139c84f'
   AND EXISTS (
     SELECT 1
       FROM addon_installations AS installation
      WHERE installation.id = addon_connector_bindings.installation_id
        AND installation.tenant = addon_connector_bindings.tenant
        AND installation.addon_key = 'mcpwp-office'
        AND installation.state <> 'archived'
        AND installation.manifest_sha256 = '7d66a75e95732366e71c87f34b5d5586b5bb005ddea6e3369d8725fa09a91ad2'
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
    OR NEW.capability_v2 IS NOT OLD.capability_v2
    OR NEW.connector_id IS NOT OLD.connector_id
    OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256
    OR NEW.configured_by IS NOT OLD.configured_by
    OR NEW.configured_at IS NOT OLD.configured_at
BEGIN
  SELECT RAISE(ABORT, 'addon bindings are append-only except revocation');
END;
