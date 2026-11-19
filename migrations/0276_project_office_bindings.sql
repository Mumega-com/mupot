-- 0276_project_office_bindings.sql — per-PROJECT office/WordPress destination (B3a).
-- Spec: mupot wiki page `office-per-customer` (project eaf4fb0e-b4f6-4f28-aae6-c06c67ae7afa), §1.1 + §3.
--
-- Until now the office WordPress destination was ONE addon-level binding
-- (addon_connector_bindings, slot wordpress_site), so two customers sharing the pot could
-- publish to each other's site. This table binds the destination per project; the freeze
-- records the project it was minted for.
--
-- ZERO-DOWNTIME / ADDITIVE ONLY: one new table, one nullable column, two backfills.
-- Nothing is dropped or rewritten. Freezes minted before this migration keep
-- project_id = NULL when their task has no project; src/addons/office/service.ts publishes
-- those only if the CURRENT addon-level connector/site_origin still match the freeze row.

CREATE TABLE IF NOT EXISTS project_office_bindings (
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  slot         TEXT NOT NULL CHECK (slot IN ('wordpress_site', 'inkwell_site')),
  connector_id TEXT NOT NULL,
  capability   TEXT NOT NULL CHECK (capability IN ('read', 'write')),
  bound_by     TEXT NOT NULL,
  bound_at     TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at   TEXT,
  PRIMARY KEY (project_id, slot)
);

CREATE INDEX IF NOT EXISTS idx_project_office_bindings_connector
  ON project_office_bindings (connector_id) WHERE revoked_at IS NULL;

ALTER TABLE office_publish_freezes ADD COLUMN project_id TEXT;

-- Backfill: a freeze belongs to the project its task is attributed to.
UPDATE office_publish_freezes
   SET project_id = (SELECT t.project_id FROM tasks t WHERE t.id = office_publish_freezes.task_id)
 WHERE project_id IS NULL;

-- Backfill: carry the single active addon-level wordpress_site binding over to its owning
-- project. "Owning project" = the ONE project that has gate:office tasks. If there is not
-- exactly one active binding and exactly one such project, NOTHING is copied (fail closed:
-- an operator binds explicitly) — guessing here would be the very confused-deputy bug.
INSERT INTO project_office_bindings (project_id, slot, connector_id, capability, bound_by)
SELECT p.project_id, 'wordpress_site', b.connector_id, b.capability_v2, 'migration:0276'
  FROM (SELECT DISTINCT project_id FROM tasks
         WHERE gate_owner = 'gate:office' AND project_id IS NOT NULL) p
  JOIN addon_connector_bindings b
    ON b.slot = 'wordpress_site' AND b.revoked_at IS NULL AND b.connector_id IS NOT NULL
  JOIN addon_installations i
    ON i.id = b.installation_id AND i.tenant = b.tenant
   AND i.addon_key = 'mcpwp-office' AND i.state = 'active'
 WHERE (SELECT COUNT(DISTINCT project_id) FROM tasks
         WHERE gate_owner = 'gate:office' AND project_id IS NOT NULL) = 1
   AND (SELECT COUNT(*) FROM addon_connector_bindings b2
          JOIN addon_installations i2 ON i2.id = b2.installation_id AND i2.tenant = b2.tenant
         WHERE b2.slot = 'wordpress_site' AND b2.revoked_at IS NULL AND b2.connector_id IS NOT NULL
           AND i2.addon_key = 'mcpwp-office' AND i2.state = 'active') = 1;
