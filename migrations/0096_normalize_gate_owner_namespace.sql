-- 0096_normalize_gate_owner_namespace.sql — repair EVERY unverdictable gate_owner
-- row on the mumega pot and align them to the one legal form (board 247858f1).
--
-- THE DEFECT: callerHoldsGateCapability (src/tasks/index.ts) looks up
-- gate_grants WHERE capability = <gate_owner RAW>, but only 'gate:<owner>' is
-- insertable/matchable (GATE_CAPABILITY_RE, src/gates/grants.ts). Any gate_owner
-- that is a bare slug ('athena'), a raw agent id, or a legacy cap-without-prefix
-- ('kasra-core') can never match a grant — the task enters 'review' with a
-- structurally unreachable verdict, and gate_owner is then LOCKED. A live D1 read
-- (2026-08-12) found 19 such rows across 8 distinct owners — NOT the 2 the first
-- draft of this migration assumed. Fixing 2 of 19 IS the drift this board item
-- exists to end, so this migration normalizes ALL of them.
--
-- GRANT-FIRST DISCIPLINE: every target 'gate:<owner>' below has a live grant
-- minted BEFORE this flip (never the reverse — a flip ahead of its grant swaps
-- one unverdictable string for another). Verified in gate_grants at authoring:
--   gate:athena     -> agent a9423609                         (2026-08-12T17:15:30Z)
--   gate:river      -> agent f23a6c2c                         (2026-08-12T17:50Z)
--   gate:kasra      -> agent c855f82c                         (2026-08-12T17:54:15Z)
--   gate:kasra-core -> agent c855f82c + a9423609 + member 14136dec (17:54:15Z)
--   gate:hadi       -> member <hadi>                          (minted separately before apply)
-- The grants themselves are NOT seeded here: migrations must leave gate_grants
-- with ZERO rows (helpers-migrations.test.ts) and grants are minted via
-- grant_gate_capability, never a migration.
--
-- Every UPDATE is guarded by id AND current value, so it is idempotent (a second
-- run matches nothing) and cannot touch a row that already holds a different
-- value. On any pot but mumega these ids don't exist -> all no-ops.

-- ── gate:athena (4) ─────────────────────────────────────────────────────────
UPDATE tasks SET gate_owner='gate:athena', updated_at='2026-08-12T18:00:00.000Z' WHERE id='d8029460-956a-4fc3-86d1-86943ee3a8c0' AND gate_owner='a9423609-e3bf-4797-8af8-4b9b7aecdf16';
UPDATE tasks SET gate_owner='gate:athena', updated_at='2026-08-12T18:00:00.000Z' WHERE id='37ba2508-5c69-4318-8fbf-3d484b4682b4' AND gate_owner='athena';
UPDATE tasks SET gate_owner='gate:athena', updated_at='2026-08-12T18:00:00.000Z' WHERE id='731d1634-69ab-45a2-80da-9554b3dae0c8' AND gate_owner='athena';
UPDATE tasks SET gate_owner='gate:athena', updated_at='2026-08-12T18:00:00.000Z' WHERE id='e8995ecd-73d7-4c3a-80ae-38f74f6cceb9' AND gate_owner='athena';

-- ── gate:river (3) ──────────────────────────────────────────────────────────
UPDATE tasks SET gate_owner='gate:river', updated_at='2026-08-12T18:00:00.000Z' WHERE id='4797f276-8108-4148-9014-4ecaab297a9d' AND gate_owner='f23a6c2c-7377-492f-8d69-96c3946a7148';
UPDATE tasks SET gate_owner='gate:river', updated_at='2026-08-12T18:00:00.000Z' WHERE id='fec03147-b934-4dee-aebc-374fec89af23' AND gate_owner='f23a6c2c-7377-492f-8d69-96c3946a7148';
UPDATE tasks SET gate_owner='gate:river', updated_at='2026-08-12T18:00:00.000Z' WHERE id='406e2b3c-77f0-404f-b781-deadf2565e19' AND gate_owner='river';

-- ── gate:kasra-core (7) ─────────────────────────────────────────────────────
UPDATE tasks SET gate_owner='gate:kasra-core', updated_at='2026-08-12T18:00:00.000Z' WHERE id='2b6fe9ef-24ff-499a-84d4-156341297e74' AND gate_owner='kasra-core';
UPDATE tasks SET gate_owner='gate:kasra-core', updated_at='2026-08-12T18:00:00.000Z' WHERE id='711800aa-f105-4075-a976-d35bd4e5c993' AND gate_owner='kasra-core';
UPDATE tasks SET gate_owner='gate:kasra-core', updated_at='2026-08-12T18:00:00.000Z' WHERE id='8c07815e-3f46-4475-8a26-b05cb0cbaa2a' AND gate_owner='kasra-core';
UPDATE tasks SET gate_owner='gate:kasra-core', updated_at='2026-08-12T18:00:00.000Z' WHERE id='965a7b00-9152-4e56-90e4-b7e4e5fcf51d' AND gate_owner='kasra-core';
UPDATE tasks SET gate_owner='gate:kasra-core', updated_at='2026-08-12T18:00:00.000Z' WHERE id='dbe11550-1f43-483c-8dc2-47fd4b5a4be8' AND gate_owner='kasra-core';
UPDATE tasks SET gate_owner='gate:kasra-core', updated_at='2026-08-12T18:00:00.000Z' WHERE id='ebeb4efb-f570-4776-89b4-6a75c5010ee0' AND gate_owner='kasra-core';
UPDATE tasks SET gate_owner='gate:kasra-core', updated_at='2026-08-12T18:00:00.000Z' WHERE id='f5fc04d7-741e-4ddb-bfbc-bc034c47cec4' AND gate_owner='kasra-core';

-- ── gate:kasra (2) — 'kasra' and the malformed 'agent:kasra' ────────────────
UPDATE tasks SET gate_owner='gate:kasra', updated_at='2026-08-12T18:00:00.000Z' WHERE id='5fb1c5f9-0baa-46ff-a93a-3e8ed6961c46' AND gate_owner='kasra';
UPDATE tasks SET gate_owner='gate:kasra', updated_at='2026-08-12T18:00:00.000Z' WHERE id='a20102b1-8535-4acf-b536-4bbeed40771d' AND gate_owner='agent:kasra';

-- ── gate:hadi (3) — requires gate:hadi -> member <hadi> minted before apply ──
UPDATE tasks SET gate_owner='gate:hadi', updated_at='2026-08-12T18:00:00.000Z' WHERE id='0e1634d6-977d-43ff-a4bc-4eaf48ae9d12' AND gate_owner='hadi';
UPDATE tasks SET gate_owner='gate:hadi', updated_at='2026-08-12T18:00:00.000Z' WHERE id='8ffe0eb4-21b7-4861-be9f-4276517d2461' AND gate_owner='hadi';
UPDATE tasks SET gate_owner='gate:hadi', updated_at='2026-08-12T18:00:00.000Z' WHERE id='c90c241d-2996-41bf-834e-d41433715a93' AND gate_owner='hadi';
