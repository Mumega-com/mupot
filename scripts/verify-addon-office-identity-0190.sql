-- READ-ONLY pre-apply verification for migrations/0190 (mupot#1694).
-- Run against live D1, e.g.:
--   npx wrangler d1 execute <db> --remote --file scripts/verify-addon-office-identity-0190.sql
-- Expect: every non-archived mcpwp-office row has old_digest_match = 1 and
-- compat_is_031 = 1; the generation/binding queries show their stored digest
-- equal to either the old digest (will be moved) or the installation's digest.
-- Any row with old_digest_match = 0 is an UNEXPECTED identity: the migration
-- will leave it untouched — stop and investigate. Zero rows = migration no-op.
-- OLD = 9ee9eb05c9a5a469e67e88e98aca68b0654448f539dcb3744eb48c090139c84f
-- NEW = 7d66a75e95732366e71c87f34b5d5586b5bb005ddea6e3369d8725fa09a91ad2

SELECT id, tenant, state, mupot_compatibility, manifest_sha256,
       (manifest_sha256 = '9ee9eb05c9a5a469e67e88e98aca68b0654448f539dcb3744eb48c090139c84f') AS old_digest_match,
       (manifest_sha256 = '7d66a75e95732366e71c87f34b5d5586b5bb005ddea6e3369d8725fa09a91ad2') AS already_new,
       (mupot_compatibility = '^0.31.0') AS compat_is_031
  FROM addon_installations
 WHERE addon_key = 'mcpwp-office' AND state <> 'archived';

SELECT generation.id, generation.installation_id, generation.manifest_sha256,
       (generation.manifest_sha256 = installation.manifest_sha256) AS matches_installation,
       (generation.manifest_sha256 = '9ee9eb05c9a5a469e67e88e98aca68b0654448f539dcb3744eb48c090139c84f') AS is_old_digest
  FROM addon_binding_generations AS generation
  JOIN addon_installations AS installation
    ON installation.id = generation.installation_id AND installation.tenant = generation.tenant
 WHERE installation.addon_key = 'mcpwp-office' AND installation.state <> 'archived'
   AND generation.revoked_at IS NULL;

SELECT binding.id, binding.installation_id, binding.slot, binding.manifest_sha256,
       (binding.manifest_sha256 = installation.manifest_sha256) AS matches_installation
  FROM addon_connector_bindings AS binding
  JOIN addon_installations AS installation
    ON installation.id = binding.installation_id AND installation.tenant = binding.tenant
 WHERE installation.addon_key = 'mcpwp-office' AND installation.state <> 'archived'
   AND binding.revoked_at IS NULL;
