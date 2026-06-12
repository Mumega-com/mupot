-- mupot — at most ONE active github_app connector per tenant.
--
-- The github-app token-minting path resolves the private key and the
-- { app_id, installation_id } meta from a single row. A second active github_app
-- connector (e.g. a re-install on a new org without revoking the old) would make
-- "the row" ambiguous and could pair the wrong key with the wrong install id.
-- This partial unique index makes that state impossible: a tenant may hold many
-- revoked github_app rows (history) but only one un-revoked at a time.
--
-- Partial index → only rows matching the WHERE are constrained, so it does not
-- touch other connector types and does not conflict with the existing schema.
CREATE UNIQUE INDEX IF NOT EXISTS idx_connectors_one_active_github_app
  ON connectors (tenant)
  WHERE type = 'github_app' AND revoked_at IS NULL;
