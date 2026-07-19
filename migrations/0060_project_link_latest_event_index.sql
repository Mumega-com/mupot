-- Replace the shipped 0059 Project Link keyset expression with the actual latest
-- durable event across creation, success, failure, and revocation.

DROP INDEX IF EXISTS idx_project_links_activity_keyset;

CREATE INDEX IF NOT EXISTS idx_project_links_activity_keyset
  ON project_links (
    tenant,
    local_project_id,
    CAST(ROUND((MAX(
      julianday(created_at),
      julianday(COALESCE(last_success_at, created_at)),
      julianday(COALESCE(last_failure_at, created_at)),
      julianday(COALESCE(revoked_at, created_at))
    ) - 2440587.5) * 86400000) AS INTEGER) DESC,
    id ASC
  );
