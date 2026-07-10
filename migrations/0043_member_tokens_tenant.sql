-- 0043_member_tokens_tenant.sql — tenant-bind member API keys.
--
-- member_tokens authenticate the workspace, MCP, OAuth convergence, fleet, and
-- agent inbox doors. Keep tenant on the token row as well as the joined member
-- row so a future shared-D1 fork can index and enforce this boundary directly.
--
-- No tenant slug is hardcoded here. Existing rows inherit the tenant already
-- stamped on their member by 0040-aware write paths or app-level backfills.

ALTER TABLE member_tokens ADD COLUMN tenant TEXT;

UPDATE member_tokens
   SET tenant = (
     SELECT m.tenant
       FROM members m
      WHERE m.id = member_tokens.member_id
   )
 WHERE tenant IS NULL;

CREATE INDEX IF NOT EXISTS idx_member_tokens_tenant_hash
  ON member_tokens(tenant, token_hash);

CREATE INDEX IF NOT EXISTS idx_member_tokens_tenant_member
  ON member_tokens(tenant, member_id);
