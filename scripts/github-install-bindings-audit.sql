-- Read-only: list the GitHub App installation bindings held in D1, one row per tenant, with
-- the most recent bind/unbind audit event (if any). Bindings with no audit row predate the
-- audit trail. SELECT only; changes nothing.
SELECT
  g.tenant,
  g.installation_id,
  g.account_login,
  g.installed_at,
  g.updated_at,
  (SELECT a.action || ' by ' || a.actor_id || ' at ' || a.recorded_at
     FROM connector_audit a
    WHERE a.tenant = g.tenant AND a.connector_id = 'github-install:' || g.installation_id
    ORDER BY a.recorded_at DESC LIMIT 1) AS last_audit
FROM github_installations g
ORDER BY g.tenant;
