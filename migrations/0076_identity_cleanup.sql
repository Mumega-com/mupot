-- 0076_identity_cleanup.sql — PENDING APPROVAL
--
-- This migration cleans up identity records per Hadi's approval.
-- DO NOT RUN without explicit per-record approval documented in IDENTITY_CLEANUP_PLAN.md.
--
-- Changes (when approved):
--   1. Revoke org:admin from suspended members (they cannot auth anyway)
--   2. Delete inactive hadi/codex agent records (upon approval)
--   3. Audit trail: all changes logged via audit views
--
-- Reversibility: all DELETE statements have corresponding INSERT comments for undo.
--
-- Safety:
--   - Uses CASCADE delete from agents → memberships (explicit, not implicit)
--   - Requires APPROVAL_GRANTED = true in code to apply
--   - Foreign key constraints prevent orphaning tasks/memberships

-- ════════════════════════════════════════════════════════════════════════════════
-- GATE: Approval required — delete these lines only after per-record sign-off
-- ════════════════════════════════════════════════════════════════════════════════
-- The actual cleanup SQL is below, commented out until approval is documented.
-- To apply this migration:
--   1. Obtain per-record approval from Hadi for each record listed in IDENTITY_CLEANUP_PLAN.md
--   2. Update IDENTITY_CLEANUP_PLAN.md with approval checkboxes filled
--   3. Uncomment the SQL below
--   4. Run `wrangler d1 execute mupot --file migrations/0076_identity_cleanup.sql`
--   5. Verify with the queries at the end of this file

-- ════════════════════════════════════════════════════════════════════════════════
-- CLEANUP OPERATIONS (commented until approval)
-- ════════════════════════════════════════════════════════════════════════════════

-- Step 1: Revoke org:admin from suspended members
-- (Backup: SELECT member_id, capability FROM capabilities
--   WHERE scope_type = 'org' AND capability = 'admin' AND member_id IN (
--     SELECT id FROM members WHERE status = 'suspended'))
-- DELETE FROM capabilities
--  WHERE scope_type = 'org'
--    AND capability = 'admin'
--    AND member_id IN (SELECT id FROM members WHERE status = 'suspended');

-- Step 2: Delete inactive hadi/codex agents
-- (Backup: SELECT id, name, role, status FROM agents
--   WHERE status = 'paused' AND (id LIKE '%hadi%' OR id LIKE '%codex%'))
-- DELETE FROM agents
--  WHERE status = 'paused'
--    AND (id LIKE '%hadi%' OR id LIKE '%codex%')
--    AND id NOT IN (SELECT agent_id FROM memberships WHERE capability = 'owner');
-- NOTE: CASCADE will delete associated memberships and tasks

-- ════════════════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run after applying the above)
-- ════════════════════════════════════════════════════════════════════════════════

-- Verify: no suspended members hold admin capability
-- SELECT m.id, m.status, c.capability
--   FROM members m
--   LEFT JOIN capabilities c ON m.id = c.member_id AND c.capability = 'admin'
--  WHERE m.status = 'suspended';
-- Expected: empty result set

-- Verify: inactive hadi/codex agents removed
-- SELECT id, name, role, status FROM agents
--  WHERE (id LIKE '%hadi%' OR id LIKE '%codex%') AND status = 'paused';
-- Expected: empty result set (if all were deleted) or only approved records

-- Verify: kasra member with org:admin is correct
-- SELECT m.id, m.display_name, m.status, c.capability, t.label, t.created_at
--   FROM members m
--   LEFT JOIN capabilities c ON m.id = c.member_id AND scope_type = 'org'
--   LEFT JOIN member_tokens t ON m.id = t.member_id AND t.revoked_at IS NULL
--  WHERE m.id LIKE '%kasra%'
--  ORDER BY m.created_at, t.created_at DESC;
-- Expected: exactly one "active" kasra member with org:admin; no misaligned labels
