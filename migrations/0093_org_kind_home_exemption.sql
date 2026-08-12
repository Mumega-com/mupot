-- 0093_org_kind_home_exemption.sql — structural home/work distinction for the
-- plan-limit counters (mupot#925, second adversarial pass P0-N1).
--
-- THE DEFECT: createSquad counted pot-wide with no filter
-- (`SELECT COUNT(*) AS n FROM squads`, src/org/service.ts) and createDepartment
-- had NO gate at all. PLAN_LIMITS free = 1 squad / 2 agents
-- (src/billing/plans.ts), and resolveTier fails CLOSED to 'free' for any pot
-- with no billing_state row (src/billing/entitlement.ts) — i.e. every freshly
-- provisioned pot. bootstrap_self (mupot#925) mints a department + squad + agent
-- for EVERY human who names an agent, so on a new free pot the first human
-- succeeds (0+1=1 <= 1) and the SECOND HUMAN gets squad_limit_reached: every new
-- pot admits exactly one human then locks.
--
-- RIVER'S RULING (rul-2026-08-11-bootstrap-self, addendum C) — structural, NOT a
-- tier carve-out: "Home containers are IDENTITY, not work units. Exempt
-- dept:home-<member> / squad:home-<member> / agent:self-<member> from the plan
-- counters STRUCTURALLY (a kind flag, counters count kind='work' only). The plan
-- meters WORK; it never meters how many people can speak in the pot. Colony/work
-- squads + agents count normally; free tier applies honestly the moment real
-- work is attempted."
--
-- DEFAULT 'work' and NOT NULL: every row that existed before this migration IS a
-- work unit (bootstrap_self did not exist before mupot#925, so no home-kind row
-- can predate this column) and must keep counting exactly as it always has.
-- SQLite backfills every existing row to the DEFAULT when a NOT NULL column with
-- a constant default is added via ALTER TABLE ADD COLUMN — verified directly
-- against this exact statement (tests/org-kind-exemption.test.ts: a department,
-- squad, and agent inserted against the pre-migration 0001_init.sql schema, then
-- this migration applied on top, then read back as kind='work').
--
-- The CHECK constraint is safe on ADD COLUMN in SQLite because it references no
-- other column and no subquery (verified against node:sqlite, the same engine
-- tests/helpers/sqlite-d1.ts runs on).
--
-- src/org/service.ts's createDepartment/createSquad/prepareAgentCreate only run
-- the count-and-gate check at all when the row being created is kind='work' —
-- a kind='home' create (bootstrap_self, exclusively) skips the entitlement gate
-- entirely, never touching PLAN_LIMITS. This is why the counting queries below
-- (in the service layer, not this file) filter `WHERE kind = 'work'` rather than
-- counting every row.

ALTER TABLE departments ADD COLUMN kind TEXT NOT NULL DEFAULT 'work' CHECK (kind IN ('work','home'));
ALTER TABLE squads      ADD COLUMN kind TEXT NOT NULL DEFAULT 'work' CHECK (kind IN ('work','home'));
ALTER TABLE agents      ADD COLUMN kind TEXT NOT NULL DEFAULT 'work' CHECK (kind IN ('work','home'));

-- Read-path indexes for the count-and-gate queries (src/org/service.ts) — every
-- create call now runs `SELECT COUNT(*) ... WHERE kind = 'work'` on all three
-- tables; without an index that is a full table scan on every single create.
CREATE INDEX IF NOT EXISTS idx_departments_kind ON departments(kind);
CREATE INDEX IF NOT EXISTS idx_squads_kind      ON squads(kind);
CREATE INDEX IF NOT EXISTS idx_agents_kind      ON agents(kind);
