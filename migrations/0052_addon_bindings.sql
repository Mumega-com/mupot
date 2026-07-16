CREATE TABLE IF NOT EXISTS addon_connector_bindings (
  id TEXT NOT NULL PRIMARY KEY,
  tenant TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  adapter TEXT NOT NULL,
  binding_kind TEXT NOT NULL CHECK (binding_kind IN ('internal_adapter','vault_connector')),
  capability TEXT NOT NULL CHECK (capability = 'read'),
  connector_id TEXT,
  manifest_sha256 TEXT NOT NULL CHECK (
    length(manifest_sha256) = 64
    AND manifest_sha256 = lower(manifest_sha256)
    AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  configured_by TEXT NOT NULL,
  configured_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (installation_id, tenant)
    REFERENCES addon_installations (id, tenant)
    ON DELETE RESTRICT,
  CHECK (
    (binding_kind = 'internal_adapter' AND connector_id IS NULL)
    OR (binding_kind = 'vault_connector' AND connector_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_addon_live_binding_slot
  ON addon_connector_bindings (tenant, installation_id, slot)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_addon_bindings_installation
  ON addon_connector_bindings (tenant, installation_id, configured_at DESC);

CREATE TRIGGER IF NOT EXISTS addon_connector_bindings_identity_matches_installation
  BEFORE INSERT ON addon_connector_bindings
  WHEN NOT EXISTS (
    SELECT 1
      FROM addon_installations AS installation
     WHERE installation.id = NEW.installation_id
       AND installation.tenant = NEW.tenant
       AND installation.manifest_sha256 = NEW.manifest_sha256
  )
BEGIN
  SELECT RAISE(ABORT, 'addon binding identity does not match installation');
END;

CREATE TRIGGER IF NOT EXISTS addon_connector_bindings_live_insert_requires_live_installation
  BEFORE INSERT ON addon_connector_bindings
  WHEN NEW.revoked_at IS NULL AND EXISTS (
    SELECT 1
      FROM addon_installations AS installation
     WHERE installation.id = NEW.installation_id
       AND installation.tenant = NEW.tenant
       AND installation.state = 'archived'
  )
BEGIN
  SELECT RAISE(ABORT, 'archived addon installations cannot have live bindings');
END;

CREATE TRIGGER IF NOT EXISTS addon_connector_bindings_connector_matches_tenant
  BEFORE INSERT ON addon_connector_bindings
  WHEN NEW.binding_kind = 'vault_connector' AND NOT EXISTS (
    SELECT 1
      FROM connectors AS connector
     WHERE connector.id = NEW.connector_id
       AND connector.tenant = NEW.tenant
  )
BEGIN
  SELECT RAISE(ABORT, 'addon binding connector must belong to the installation tenant');
END;

CREATE TRIGGER IF NOT EXISTS addon_connector_bindings_revoke_only
  BEFORE UPDATE ON addon_connector_bindings
  WHEN OLD.revoked_at IS NOT NULL
    OR NEW.revoked_at IS NULL
    OR length(trim(NEW.revoked_at)) = 0
    OR julianday(NEW.revoked_at) IS NULL
    OR NEW.id IS NOT OLD.id
    OR NEW.tenant IS NOT OLD.tenant
    OR NEW.installation_id IS NOT OLD.installation_id
    OR NEW.slot IS NOT OLD.slot
    OR NEW.adapter IS NOT OLD.adapter
    OR NEW.binding_kind IS NOT OLD.binding_kind
    OR NEW.capability IS NOT OLD.capability
    OR NEW.connector_id IS NOT OLD.connector_id
    OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256
    OR NEW.configured_by IS NOT OLD.configured_by
    OR NEW.configured_at IS NOT OLD.configured_at
BEGIN
  SELECT RAISE(ABORT, 'addon bindings are append-only except revocation');
END;

CREATE TRIGGER IF NOT EXISTS addon_connector_bindings_no_delete
  BEFORE DELETE ON addon_connector_bindings
BEGIN
  SELECT RAISE(ABORT, 'addon bindings are append-only: DELETE is forbidden');
END;

CREATE TRIGGER IF NOT EXISTS addon_installations_archive_requires_revoked_bindings
  BEFORE UPDATE OF state ON addon_installations
  WHEN NEW.state = 'archived' AND OLD.state <> 'archived' AND EXISTS (
    SELECT 1
      FROM addon_connector_bindings AS binding
     WHERE binding.tenant = OLD.tenant
       AND binding.installation_id = OLD.id
       AND binding.revoked_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'live addon bindings must be revoked before archive');
END;
