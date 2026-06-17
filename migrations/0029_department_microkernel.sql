-- mupot — department microkernel lifecycle columns (console-department-microkernel §3.3, §3.4b).
--
-- The existing `departments` table (0001_init.sql) has: id, slug, name, created_at.
-- These four columns extend it for the microkernel lifecycle WITHOUT breaking the
-- existing rows or the existing createDepartment / org service (those paths are
-- tenant-UI paths; the microkernel activate/deactivate path uses separate columns).
--
-- New columns:
--   template_key     — which DepartmentModule is activated (e.g. 'fixture', 'growth').
--                      NULL on rows created by the old createDepartment path (compat).
--   template_version — the module's version string at activation time (§3.4b).
--                      Allows detecting template drift vs activated instance.
--   activated_at     — ISO timestamp of first activation.
--   active           — 1 = visible in nav + metric selector; 0 = dormant (data retained).
--   seed_receipt     — JSON object: { seeded_at, squads: [slug, ...] }.
--                      Idempotency guard: re-activation checks this before seeding squads;
--                      never double-seeds.
--
-- Approach: ALTER TABLE … ADD COLUMN with a DEFAULT so existing rows gain the column
-- without a data migration (D1/SQLite: ADD COLUMN is safe; DROP/RENAME requires a
-- table rebuild which we avoid to keep things compatible with live data).
--
-- Pre-existing rows get:
--   template_key     = NULL (distinguishes UI-created from microkernel-activated rows)
--   template_version = NULL
--   activated_at     = NULL
--   active           = 0   (dormant; they are not microkernel-activated departments)
--   seed_receipt     = NULL

ALTER TABLE departments ADD COLUMN template_key TEXT;
ALTER TABLE departments ADD COLUMN template_version TEXT;
ALTER TABLE departments ADD COLUMN activated_at TEXT;
ALTER TABLE departments ADD COLUMN active INTEGER NOT NULL DEFAULT 0;
ALTER TABLE departments ADD COLUMN seed_receipt TEXT;

-- Index for fast "get active microkernel departments for this tenant" lookups.
-- tenant scoping is via the TENANT_SLUG env var (single-tenant D1); this index
-- covers getActive() → ORDER BY activated_at queries efficiently.
CREATE INDEX IF NOT EXISTS idx_departments_active ON departments(active, template_key);
