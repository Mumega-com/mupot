CREATE UNIQUE INDEX IF NOT EXISTS idx_connectors_id_tenant
  ON connectors (id, tenant);

CREATE TABLE IF NOT EXISTS addon_binding_generations (
  id TEXT NOT NULL PRIMARY KEY,
  tenant TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  configuration_sha256 TEXT NOT NULL CHECK (
    length(configuration_sha256) = 64
    AND configuration_sha256 = lower(configuration_sha256)
    AND configuration_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  binding_count INTEGER NOT NULL CHECK (binding_count >= 0),
  manifest_sha256 TEXT NOT NULL CHECK (
    length(manifest_sha256) = 64
    AND manifest_sha256 = lower(manifest_sha256)
    AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  configured_by TEXT NOT NULL,
  configured_at TEXT NOT NULL,
  revoked_at TEXT,
  previous_generation_id TEXT,
  expected_installation_state TEXT NOT NULL CHECK (
    expected_installation_state IN ('installed','configured','disabled')
  ),
  base_receipt_id TEXT NOT NULL,
  UNIQUE (id, installation_id, tenant),
  FOREIGN KEY (installation_id, tenant)
    REFERENCES addon_installations (id, tenant)
    ON DELETE RESTRICT,
  FOREIGN KEY (previous_generation_id, installation_id, tenant)
    REFERENCES addon_binding_generations (id, installation_id, tenant)
    ON DELETE RESTRICT,
  FOREIGN KEY (base_receipt_id, installation_id, tenant)
    REFERENCES addon_receipts (id, installation_id, tenant)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_addon_one_live_binding_generation
  ON addon_binding_generations (tenant, installation_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_addon_binding_generations_installation
  ON addon_binding_generations (tenant, installation_id, configured_at DESC);

CREATE TRIGGER IF NOT EXISTS addon_binding_generations_start_live
  BEFORE INSERT ON addon_binding_generations
  WHEN NEW.revoked_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'addon binding generations must start live');
END;

CREATE TRIGGER IF NOT EXISTS addon_binding_generations_canonical_configured_at
  BEFORE INSERT ON addon_binding_generations
  WHEN length(NEW.configured_at) <> 24
    OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.configured_at) IS NOT NEW.configured_at
BEGIN
  SELECT RAISE(ABORT, 'addon binding generation configured_at must be canonical ISO');
END;

CREATE TRIGGER IF NOT EXISTS addon_binding_generations_fence_installation
  BEFORE INSERT ON addon_binding_generations
  WHEN NOT EXISTS (
    SELECT 1
      FROM addon_installations AS installation
     WHERE installation.id = NEW.installation_id
       AND installation.tenant = NEW.tenant
       AND installation.manifest_sha256 = NEW.manifest_sha256
       AND installation.state = NEW.expected_installation_state
       AND installation.state IN ('installed','configured','disabled')
       AND installation.latest_receipt_id = NEW.base_receipt_id
  )
BEGIN
  SELECT RAISE(ABORT, 'addon binding generation installation fence lost');
END;

CREATE TRIGGER IF NOT EXISTS addon_binding_generations_exact_predecessor
  BEFORE INSERT ON addon_binding_generations
  WHEN (
    NEW.previous_generation_id IS NULL
    AND EXISTS (
      SELECT 1 FROM addon_binding_generations AS generation
       WHERE generation.tenant = NEW.tenant
         AND generation.installation_id = NEW.installation_id
    )
  ) OR (
    NEW.previous_generation_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM addon_binding_generations AS generation
       WHERE generation.id = NEW.previous_generation_id
         AND generation.tenant = NEW.tenant
         AND generation.installation_id = NEW.installation_id
         AND generation.revoked_at = NEW.configured_at
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'addon binding generation predecessor fence lost');
END;

CREATE TRIGGER IF NOT EXISTS addon_binding_generations_revoke_only
  BEFORE UPDATE ON addon_binding_generations
  WHEN OLD.revoked_at IS NOT NULL
    OR NEW.revoked_at IS NULL
    OR length(NEW.revoked_at) <> 24
    OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.revoked_at) IS NOT NEW.revoked_at
    OR NEW.revoked_at < OLD.configured_at
    OR NEW.id IS NOT OLD.id
    OR NEW.tenant IS NOT OLD.tenant
    OR NEW.installation_id IS NOT OLD.installation_id
    OR NEW.configuration_sha256 IS NOT OLD.configuration_sha256
    OR NEW.binding_count IS NOT OLD.binding_count
    OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256
    OR NEW.configured_by IS NOT OLD.configured_by
    OR NEW.configured_at IS NOT OLD.configured_at
    OR NEW.previous_generation_id IS NOT OLD.previous_generation_id
    OR NEW.expected_installation_state IS NOT OLD.expected_installation_state
    OR NEW.base_receipt_id IS NOT OLD.base_receipt_id
BEGIN
  SELECT RAISE(ABORT, 'addon binding generations are append-only except revocation');
END;

CREATE TRIGGER IF NOT EXISTS addon_binding_generations_no_delete
  BEFORE DELETE ON addon_binding_generations
BEGIN
  SELECT RAISE(ABORT, 'addon binding generations are append-only: DELETE is forbidden');
END;

CREATE TABLE IF NOT EXISTS addon_connector_bindings (
  id TEXT NOT NULL PRIMARY KEY,
  tenant TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
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
  FOREIGN KEY (generation_id, installation_id, tenant)
    REFERENCES addon_binding_generations (id, installation_id, tenant)
    ON DELETE RESTRICT,
  FOREIGN KEY (connector_id, tenant)
    REFERENCES connectors (id, tenant)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (
    (binding_kind = 'internal_adapter' AND connector_id IS NULL)
    OR (binding_kind = 'vault_connector' AND connector_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_addon_live_binding_slot
  ON addon_connector_bindings (tenant, installation_id, slot)
  WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_addon_generation_binding_slot
  ON addon_connector_bindings (generation_id, slot);

CREATE INDEX IF NOT EXISTS idx_addon_bindings_installation
  ON addon_connector_bindings (tenant, installation_id, configured_at DESC);

CREATE TRIGGER IF NOT EXISTS addon_connector_bindings_start_live
  BEFORE INSERT ON addon_connector_bindings
  WHEN NEW.revoked_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'addon bindings must start live');
END;

CREATE TRIGGER IF NOT EXISTS addon_connector_bindings_matches_generation
  BEFORE INSERT ON addon_connector_bindings
  WHEN NOT EXISTS (
    SELECT 1
      FROM addon_binding_generations AS generation
     WHERE generation.id = NEW.generation_id
       AND generation.installation_id = NEW.installation_id
       AND generation.tenant = NEW.tenant
       AND generation.manifest_sha256 = NEW.manifest_sha256
       AND generation.configured_by = NEW.configured_by
       AND generation.configured_at = NEW.configured_at
       AND generation.revoked_at IS NULL
       AND (
         SELECT COUNT(*) FROM addon_connector_bindings AS existing
          WHERE existing.generation_id = generation.id
       ) < generation.binding_count
  )
BEGIN
  SELECT RAISE(ABORT, 'addon binding does not match live generation');
END;

CREATE TRIGGER IF NOT EXISTS addon_connector_bindings_connector_is_live_and_type_matched
  BEFORE INSERT ON addon_connector_bindings
  WHEN NEW.binding_kind = 'vault_connector' AND NOT EXISTS (
    SELECT 1
      FROM connectors AS connector
     WHERE connector.id = NEW.connector_id
       AND connector.tenant = NEW.tenant
       AND connector.revoked_at IS NULL
       AND connector.type = NEW.adapter
  )
BEGIN
  SELECT RAISE(ABORT, 'addon binding connector must be tenant-local, live, and type-matched');
END;

CREATE TRIGGER IF NOT EXISTS addon_connector_bindings_revoke_only
  BEFORE UPDATE ON addon_connector_bindings
  WHEN OLD.revoked_at IS NOT NULL
    OR NEW.revoked_at IS NULL
    OR length(NEW.revoked_at) <> 24
    OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.revoked_at) IS NOT NEW.revoked_at
    OR NEW.revoked_at < OLD.configured_at
    OR NEW.id IS NOT OLD.id
    OR NEW.tenant IS NOT OLD.tenant
    OR NEW.installation_id IS NOT OLD.installation_id
    OR NEW.generation_id IS NOT OLD.generation_id
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

CREATE TRIGGER IF NOT EXISTS addon_installations_archive_requires_revoked_generation
  BEFORE UPDATE OF state ON addon_installations
  WHEN NEW.state = 'archived' AND OLD.state <> 'archived' AND EXISTS (
    SELECT 1
      FROM addon_binding_generations AS generation
     WHERE generation.tenant = OLD.tenant
       AND generation.installation_id = OLD.id
       AND generation.revoked_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'live addon binding generation must be revoked before archive');
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
