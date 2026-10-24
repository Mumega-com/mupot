-- mupot — one tenant per GitHub App installation.
--
-- Defense in depth for the connect flow: an installation id may be bound by at most one tenant.
-- Read-only pre-check (run on the target D1 BEFORE applying; expect zero rows):
--   SELECT installation_id, COUNT(*) AS n, GROUP_CONCAT(tenant) AS tenants
--   FROM github_installations GROUP BY installation_id HAVING n > 1;
-- If it returns rows, this migration FAILS LOUDLY on purpose (UNIQUE violation). Do not dedupe
-- automatically: an operator must decide which binding is legitimate, then delete the other(s).
CREATE UNIQUE INDEX IF NOT EXISTS idx_github_installations_installation_id
  ON github_installations (installation_id);
