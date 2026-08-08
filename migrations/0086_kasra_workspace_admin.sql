-- 0086_kasra_workspace_admin.sql — grant kasra org-scope admin capability
--
-- Purpose: Enable kasra to mint workspace routines and call grant_gate_capability,
-- which both require workspace admin (org-scope admin capability).
--
-- Background: kasra currently has squad-scope admin (from squad-seed). This migration
-- adds org-scope admin capability, allowing kasra to authenticate with a workspace
-- admin token for mupot routine_create calls.
--
-- Safety:
--   - Idempotent: uses INSERT OR IGNORE so re-running is safe
--   - Does not affect existing squad-scope grant
--   - Only grants capability, does not mint tokens (tokens minted on demand via dashboard/MCP)

-- Ensure kasra exists as a member (from squad-seed or earlier)
-- Then grant org-scope admin capability
INSERT OR IGNORE INTO capabilities (
  id,
  member_id,
  scope_type,
  scope_id,
  capability,
  created_at
)
SELECT
  lower(hex(randomblob(16))),  -- Generate a unique capability ID
  m.id,
  'org',
  NULL,
  'admin',
  datetime('now')
FROM members m
WHERE m.email = 'kasra@agents.mumega.com'
  AND m.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM capabilities c
    WHERE c.member_id = m.id
      AND c.scope_type = 'org'
      AND c.capability = 'admin'
  );

-- Verify: kasra should now have org-scope admin
-- SELECT m.id, m.display_name, m.email, c.scope_type, c.capability
--   FROM members m
--   LEFT JOIN capabilities c ON m.id = c.member_id
--  WHERE m.email = 'kasra@agents.mumega.com';
-- Expected: at least one row with scope_type='org' and capability='admin'
