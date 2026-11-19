-- 0277_project_office_bindings_unique_connector.sql — mupot#2472 (hardening of #2469).
--
-- assertProjectMayUseConnector refuses a connector another project already binds, but that is a
-- read-then-write: two concurrent binds of one connector to two projects could both pass the read.
-- This makes it atomic: at most ONE active (unrevoked) binding per connector. The losing bind surfaces
-- as connector_scope_refused (src/addons/office/project-binding.ts maps the constraint error).
--
-- ADDITIVE ONLY: one unique partial index. Safe on prod (project_office_bindings is empty there); a
-- pre-existing duplicate would fail the migration loudly rather than be silently resolved. The older
-- non-unique idx_project_office_bindings_connector (0276) becomes redundant but is left in place.

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_office_bindings_active_connector
  ON project_office_bindings (connector_id) WHERE revoked_at IS NULL;
