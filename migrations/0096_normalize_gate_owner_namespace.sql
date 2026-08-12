-- 0096_normalize_gate_owner_namespace.sql — repair the two known unverdictable
-- gate_owner rows and backfill the grant that unblocks them (board 247858f1).
--
-- THE DEFECT: callerHoldsGateCapability (src/tasks/index.ts) looks up
-- gate_grants WHERE capability = <gate_owner RAW>. But the grant surface
-- (grant_gate_capability, GATE_CAPABILITY_RE in src/gates/grants.ts) only
-- accepts capabilities of the form 'gate:<owner>'. So a gate_owner that is a
-- bare slug ('athena') or a raw agent id can NEVER match any insertable grant —
-- the task enters 'review' and its verdict is structurally unreachable. Worse,
-- once in 'review' the gate_owner column is LOCKED (gate_owner_locked), so the
-- value cannot be corrected by a live task_update. The row is a zombie.
--
-- THE CODE FIX (this PR) adds write-time validation so no NEW bare-slug
-- gate_owner can be stored (task_create + task_update, REST + MCP). This
-- migration repairs the two rows that already drifted before that guard existed.
--
-- 1) Normalize the two known bad gate_owners to the capability form. Narrow by
--    id AND current value so re-running (idempotent) touches nothing already fixed.
UPDATE tasks
   SET gate_owner = 'gate:athena', updated_at = '2026-08-12T17:30:00.000Z'
 WHERE id = '37ba2508-5c69-4318-8fbf-3d484b4682b4'
   AND gate_owner = 'athena';

UPDATE tasks
   SET gate_owner = 'gate:athena', updated_at = '2026-08-12T17:30:00.000Z'
 WHERE id = 'd8029460-956a-4fc3-86d1-86943ee3a8c0'
   AND gate_owner = 'a9423609-e3bf-4797-8af8-4b9b7aecdf16';

-- 2) The grant itself is NOT seeded here. It already exists as a live recorded
--    fact — Hadi's org-owner principal granted 'gate:athena' -> agent a9423609
--    at 2026-08-12T17:15:30Z (via mupot-admin.token, step B of the 247858f1 fix).
--    Migrations must NOT seed gate_grants: the applyAllMigrations snapshot test
--    (tests/helpers-migrations.test.ts) asserts the finished chain leaves every
--    table with ZERO rows, and grant-suite fixtures depend on an empty
--    gate_grants after migration. Seeding it here breaks both. On any pot other
--    than mumega these two UPDATEs are no-ops (those task ids don't exist), and a
--    fresh pot mints its grants via grant_gate_capability, never a migration.
