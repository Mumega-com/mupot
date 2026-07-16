CREATE TABLE IF NOT EXISTS addon_installations (
  id TEXT NOT NULL PRIMARY KEY,
  tenant TEXT NOT NULL,
  addon_key TEXT NOT NULL,
  installed_version TEXT NOT NULL,
  publisher TEXT NOT NULL,
  trust_class TEXT NOT NULL CHECK (trust_class = 'native_reviewed'),
  manifest_sha256 TEXT NOT NULL CHECK (
    length(manifest_sha256) = 64
    AND manifest_sha256 = lower(manifest_sha256)
    AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  mupot_compatibility TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('installed','configured','active','disabled','archived')),
  latest_previous_state TEXT CHECK (
    latest_previous_state IS NULL
    OR latest_previous_state IN ('installed','configured','active','disabled','archived')
  ),
  installed_by TEXT NOT NULL,
  latest_actor_id TEXT NOT NULL,
  latest_receipt_id TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  configured_at TEXT,
  activated_at TEXT,
  disabled_at TEXT,
  archived_at TEXT,
  updated_at TEXT NOT NULL,
  last_error TEXT,
  UNIQUE (id, tenant),
  FOREIGN KEY (latest_receipt_id, id, tenant)
    REFERENCES addon_receipts (id, installation_id, tenant)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_addon_one_live_installation
  ON addon_installations (tenant, addon_key)
  WHERE state <> 'archived';

CREATE TRIGGER IF NOT EXISTS addon_installations_start_installed
  BEFORE INSERT ON addon_installations
  WHEN NEW.state <> 'installed' OR NEW.latest_previous_state IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'addon installation must start installed with no previous state');
END;

CREATE TRIGGER IF NOT EXISTS addon_installations_installer_is_initial_actor
  BEFORE INSERT ON addon_installations
  WHEN NEW.installed_by IS NOT NEW.latest_actor_id
BEGIN
  SELECT RAISE(ABORT, 'addon installer must be the initial latest actor');
END;

CREATE TRIGGER IF NOT EXISTS addon_installations_identity_is_immutable
  BEFORE UPDATE OF id, tenant, addon_key, installed_version, publisher,
    trust_class, manifest_sha256, mupot_compatibility, installed_by
  ON addon_installations
  WHEN NEW.id IS NOT OLD.id
    OR NEW.tenant IS NOT OLD.tenant
    OR NEW.addon_key IS NOT OLD.addon_key
    OR NEW.installed_version IS NOT OLD.installed_version
    OR NEW.publisher IS NOT OLD.publisher
    OR NEW.trust_class IS NOT OLD.trust_class
    OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256
    OR NEW.mupot_compatibility IS NOT OLD.mupot_compatibility
    OR NEW.installed_by IS NOT OLD.installed_by
BEGIN
  SELECT RAISE(ABORT, 'addon installation identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS addon_installations_state_snapshots_previous
  BEFORE UPDATE OF state ON addon_installations
  WHEN NEW.state <> OLD.state AND NEW.latest_previous_state IS NOT OLD.state
BEGIN
  SELECT RAISE(ABORT, 'addon state transition must snapshot its previous state');
END;

CREATE TRIGGER IF NOT EXISTS addon_installations_previous_state_requires_transition
  BEFORE UPDATE OF latest_previous_state ON addon_installations
  WHEN NEW.latest_previous_state IS NOT OLD.latest_previous_state AND NEW.state = OLD.state
BEGIN
  SELECT RAISE(ABORT, 'addon previous state snapshot requires a state transition');
END;

CREATE TRIGGER IF NOT EXISTS addon_installations_state_requires_new_receipt
  BEFORE UPDATE OF state ON addon_installations
  WHEN NEW.state <> OLD.state AND NEW.latest_receipt_id = OLD.latest_receipt_id
BEGIN
  SELECT RAISE(ABORT, 'addon state transition requires a new receipt');
END;

CREATE TRIGGER IF NOT EXISTS addon_installations_state_requires_stored_latest_receipt
  BEFORE UPDATE OF state ON addon_installations
  WHEN NEW.state <> OLD.state AND NOT EXISTS (
    SELECT 1
      FROM addon_receipts AS receipt
     WHERE receipt.id = OLD.latest_receipt_id
       AND receipt.installation_id = OLD.id
       AND receipt.tenant = OLD.tenant
       AND receipt.actor_id = OLD.latest_actor_id
       AND receipt.previous_state IS OLD.latest_previous_state
       AND receipt.next_state = OLD.state
  )
BEGIN
  SELECT RAISE(ABORT, 'addon state transition requires its prior receipt');
END;

CREATE TRIGGER IF NOT EXISTS addon_installations_state_requires_fresh_receipt
  BEFORE UPDATE OF state ON addon_installations
  WHEN NEW.state <> OLD.state AND EXISTS (
    SELECT 1 FROM addon_receipts WHERE id = NEW.latest_receipt_id
  )
BEGIN
  SELECT RAISE(ABORT, 'addon state transition requires a fresh receipt');
END;

CREATE TRIGGER IF NOT EXISTS addon_installations_latest_receipt_requires_state
  BEFORE UPDATE OF latest_receipt_id ON addon_installations
  WHEN NEW.latest_receipt_id <> OLD.latest_receipt_id AND NEW.state = OLD.state
BEGIN
  SELECT RAISE(ABORT, 'addon latest receipt requires a state transition');
END;

CREATE TRIGGER IF NOT EXISTS addon_installations_latest_actor_requires_state
  BEFORE UPDATE OF latest_actor_id ON addon_installations
  WHEN NEW.latest_actor_id IS NOT OLD.latest_actor_id AND NEW.state = OLD.state
BEGIN
  SELECT RAISE(ABORT, 'addon latest actor requires a state transition');
END;

CREATE TRIGGER IF NOT EXISTS addon_installations_valid_state_transition
  BEFORE UPDATE OF state ON addon_installations
  WHEN NEW.state <> OLD.state AND NOT (
    (OLD.state = 'installed' AND NEW.state IN ('configured','disabled'))
    OR (OLD.state = 'configured' AND NEW.state IN ('active','disabled'))
    OR (OLD.state = 'active' AND NEW.state = 'disabled')
    OR (OLD.state = 'disabled' AND NEW.state IN ('active','archived'))
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid addon state transition');
END;

CREATE TABLE IF NOT EXISTS addon_operations (
  id TEXT NOT NULL PRIMARY KEY,
  tenant TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('activate','disable','archive')),
  target_state TEXT NOT NULL CHECK (target_state IN ('active','disabled','archived')),
  current_step TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed','compensated')),
  actor_id TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (action = 'activate' AND target_state = 'active')
    OR (action = 'disable' AND target_state = 'disabled')
    OR (action = 'archive' AND target_state = 'archived')
  ),
  FOREIGN KEY (installation_id, tenant)
    REFERENCES addon_installations (id, tenant)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_addon_one_running_operation
  ON addon_operations (tenant, installation_id) WHERE status = 'running';

CREATE UNIQUE INDEX IF NOT EXISTS idx_addon_operation_lease_token
  ON addon_operations (lease_token);

CREATE TABLE IF NOT EXISTS addon_resource_ownership (
  id TEXT NOT NULL PRIMARY KEY,
  tenant TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  ownership_mode TEXT NOT NULL CHECK (ownership_mode IN ('exclusive','co_owner')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  released_at TEXT,
  UNIQUE (tenant, installation_id, resource_type, resource_id),
  FOREIGN KEY (installation_id, tenant)
    REFERENCES addon_installations (id, tenant)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_addon_exclusive_resource
  ON addon_resource_ownership (tenant, resource_type, resource_id)
  WHERE active = 1 AND ownership_mode = 'exclusive';

CREATE INDEX IF NOT EXISTS idx_addon_active_resource_claims
  ON addon_resource_ownership (tenant, resource_type, resource_id, installation_id)
  WHERE active = 1;

CREATE TRIGGER IF NOT EXISTS addon_resource_ownership_no_duplicate_identity
  BEFORE INSERT ON addon_resource_ownership
  WHEN EXISTS (
    SELECT 1
      FROM addon_resource_ownership AS claim
     WHERE claim.id = NEW.id
        OR (
          claim.tenant = NEW.tenant
          AND claim.installation_id = NEW.installation_id
          AND claim.resource_type = NEW.resource_type
          AND claim.resource_id = NEW.resource_id
        )
  )
BEGIN
  SELECT RAISE(ABORT, 'addon ownership claim identity already exists');
END;

CREATE TRIGGER IF NOT EXISTS addon_resource_ownership_no_mixed_insert
  BEFORE INSERT ON addon_resource_ownership
  WHEN NEW.active = 1 AND EXISTS (
    SELECT 1
      FROM addon_resource_ownership AS claim
     WHERE claim.tenant = NEW.tenant
       AND claim.resource_type = NEW.resource_type
       AND claim.resource_id = NEW.resource_id
       AND claim.active = 1
       AND (NEW.ownership_mode = 'exclusive' OR claim.ownership_mode = 'exclusive')
  )
BEGIN
  SELECT RAISE(ABORT, 'active exclusive and co-owner claims cannot coexist');
END;

CREATE TRIGGER IF NOT EXISTS addon_resource_ownership_no_mixed_update
  BEFORE UPDATE OF tenant, resource_type, resource_id, ownership_mode, active
  ON addon_resource_ownership
  WHEN NEW.active = 1 AND EXISTS (
    SELECT 1
      FROM addon_resource_ownership AS claim
     WHERE claim.id <> OLD.id
       AND claim.tenant = NEW.tenant
       AND claim.resource_type = NEW.resource_type
       AND claim.resource_id = NEW.resource_id
       AND claim.active = 1
       AND (NEW.ownership_mode = 'exclusive' OR claim.ownership_mode = 'exclusive')
  )
BEGIN
  SELECT RAISE(ABORT, 'active exclusive and co-owner claims cannot coexist');
END;

CREATE TRIGGER IF NOT EXISTS addon_resource_ownership_identity_is_immutable
  BEFORE UPDATE OF id, tenant, installation_id, resource_type, resource_id,
    resource_key, ownership_mode, created_at
  ON addon_resource_ownership
  WHEN NEW.id IS NOT OLD.id
    OR NEW.tenant IS NOT OLD.tenant
    OR NEW.installation_id IS NOT OLD.installation_id
    OR NEW.resource_type IS NOT OLD.resource_type
    OR NEW.resource_id IS NOT OLD.resource_id
    OR NEW.resource_key IS NOT OLD.resource_key
    OR NEW.ownership_mode IS NOT OLD.ownership_mode
    OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'addon ownership identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS addon_resource_ownership_no_delete
  BEFORE DELETE ON addon_resource_ownership
BEGIN
  SELECT RAISE(ABORT, 'addon ownership claims are evidence and cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS addon_resource_ownership_active_insert_requires_live_installation
  BEFORE INSERT ON addon_resource_ownership
  WHEN NEW.active = 1 AND EXISTS (
    SELECT 1
      FROM addon_installations AS installation
     WHERE installation.id = NEW.installation_id
       AND installation.tenant = NEW.tenant
       AND installation.state = 'archived'
  )
BEGIN
  SELECT RAISE(ABORT, 'archived addon installations cannot have active ownership claims');
END;

CREATE TRIGGER IF NOT EXISTS addon_resource_ownership_reactivation_requires_live_installation
  BEFORE UPDATE OF active ON addon_resource_ownership
  WHEN OLD.active = 0 AND NEW.active = 1 AND EXISTS (
    SELECT 1
      FROM addon_installations AS installation
     WHERE installation.id = OLD.installation_id
       AND installation.tenant = OLD.tenant
       AND installation.state = 'archived'
  )
BEGIN
  SELECT RAISE(ABORT, 'archived addon installations cannot have active ownership claims');
END;

CREATE TRIGGER IF NOT EXISTS addon_installations_archive_requires_released_ownership
  BEFORE UPDATE OF state ON addon_installations
  WHEN NEW.state = 'archived' AND OLD.state <> 'archived' AND EXISTS (
    SELECT 1
      FROM addon_resource_ownership AS claim
     WHERE claim.tenant = OLD.tenant
       AND claim.installation_id = OLD.id
       AND claim.active = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'active addon ownership must be released before archive');
END;

CREATE TABLE IF NOT EXISTS addon_receipts (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK (sequence > 0),
  id TEXT NOT NULL UNIQUE,
  tenant TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (
    action IN ('install','configure','activate','disable','archive','upgrade','health','preflight')
  ),
  previous_state TEXT CHECK (
    previous_state IS NULL
    OR previous_state IN ('installed','configured','active','disabled','archived')
  ),
  next_state TEXT CHECK (
    next_state IS NULL
    OR next_state IN ('installed','configured','active','disabled','archived')
  ),
  addon_key TEXT NOT NULL,
  installed_version TEXT NOT NULL,
  publisher TEXT NOT NULL,
  trust_class TEXT NOT NULL CHECK (trust_class = 'native_reviewed'),
  mupot_compatibility TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK (
    length(manifest_sha256) = 64
    AND manifest_sha256 = lower(manifest_sha256)
    AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  actor_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('pass','fail')),
  side_effect_ids TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(side_effect_ids) AND json_type(side_effect_ids) = 'array'
  ),
  checks TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(checks) AND json_type(checks) = 'object'
  ),
  error_code TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (id, installation_id, tenant),
  FOREIGN KEY (installation_id, tenant)
    REFERENCES addon_installations (id, tenant)
    ON DELETE RESTRICT,
  CHECK (
    (action = 'install' AND previous_state IS NULL AND next_state = 'installed')
    OR (action = 'configure' AND previous_state = 'installed' AND next_state = 'configured')
    OR (action = 'activate' AND previous_state IN ('configured','disabled') AND next_state = 'active')
    OR (action = 'disable' AND previous_state IN ('installed','configured','active') AND next_state = 'disabled')
    OR (action = 'archive' AND previous_state = 'disabled' AND next_state = 'archived')
    OR action IN ('upgrade','health','preflight')
  )
);

CREATE INDEX IF NOT EXISTS idx_addon_receipts_installation
  ON addon_receipts (tenant, installation_id, sequence DESC);

CREATE TRIGGER IF NOT EXISTS addon_receipts_no_duplicate_sequence
  BEFORE INSERT ON addon_receipts
  WHEN NEW.sequence > 0 AND EXISTS (
    SELECT 1 FROM addon_receipts WHERE sequence = NEW.sequence
  )
BEGIN
  SELECT RAISE(ABORT, 'addon receipt sequences are immutable');
END;

CREATE TRIGGER IF NOT EXISTS addon_receipts_no_duplicate_id
  BEFORE INSERT ON addon_receipts
  WHEN EXISTS (SELECT 1 FROM addon_receipts WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'addon receipt IDs are immutable');
END;

CREATE TRIGGER IF NOT EXISTS addon_receipts_side_effect_ids_are_strings
  BEFORE INSERT ON addon_receipts
  WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.side_effect_ids) WHERE type <> 'text'
  )
BEGIN
  SELECT RAISE(ABORT, 'addon receipt side-effect IDs must be strings');
END;

CREATE TRIGGER IF NOT EXISTS addon_receipts_snapshot_matches_installation
  BEFORE INSERT ON addon_receipts
  WHEN NOT EXISTS (
    SELECT 1
      FROM addon_installations AS installation
     WHERE installation.id = NEW.installation_id
       AND installation.tenant = NEW.tenant
       AND installation.addon_key = NEW.addon_key
       AND installation.installed_version = NEW.installed_version
       AND installation.publisher = NEW.publisher
       AND installation.trust_class = NEW.trust_class
       AND installation.mupot_compatibility = NEW.mupot_compatibility
       AND installation.manifest_sha256 = NEW.manifest_sha256
  )
BEGIN
  SELECT RAISE(ABORT, 'addon receipt identity does not match installation');
END;

CREATE TRIGGER IF NOT EXISTS addon_transition_receipts_require_pass
  BEFORE INSERT ON addon_receipts
  WHEN NEW.outcome <> 'pass' AND EXISTS (
    SELECT 1
      FROM addon_installations AS installation
     WHERE installation.id = NEW.installation_id
       AND installation.tenant = NEW.tenant
       AND installation.latest_receipt_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'failed addon receipt cannot authorize lifecycle state');
END;

CREATE TRIGGER IF NOT EXISTS addon_transition_receipts_match_installation
  BEFORE INSERT ON addon_receipts
  WHEN NEW.outcome = 'pass' AND (
    NEW.action IN ('install','configure','activate','disable','archive')
    OR EXISTS (
      SELECT 1
        FROM addon_installations AS installation
       WHERE installation.id = NEW.installation_id
         AND installation.tenant = NEW.tenant
         AND installation.latest_receipt_id = NEW.id
    )
  ) AND NOT EXISTS (
    SELECT 1
      FROM addon_installations AS installation
     WHERE installation.id = NEW.installation_id
       AND installation.tenant = NEW.tenant
       AND installation.latest_receipt_id = NEW.id
       AND installation.latest_actor_id = NEW.actor_id
       AND installation.state = NEW.next_state
       AND installation.latest_previous_state IS NEW.previous_state
       AND (
         (NEW.action = 'install' AND NEW.previous_state IS NULL AND NEW.next_state = 'installed')
         OR (NEW.action = 'configure' AND NEW.previous_state = 'installed' AND NEW.next_state = 'configured')
         OR (NEW.action = 'activate' AND NEW.previous_state IN ('configured','disabled') AND NEW.next_state = 'active')
         OR (NEW.action = 'disable' AND NEW.previous_state IN ('installed','configured','active') AND NEW.next_state = 'disabled')
         OR (NEW.action = 'archive' AND NEW.previous_state = 'disabled' AND NEW.next_state = 'archived')
       )
  )
BEGIN
  SELECT RAISE(ABORT, 'addon transition receipt does not match installation state');
END;

CREATE TRIGGER IF NOT EXISTS addon_receipts_no_update
  BEFORE UPDATE ON addon_receipts
BEGIN
  SELECT RAISE(ABORT, 'addon receipts are append-only: UPDATE is forbidden');
END;

CREATE TRIGGER IF NOT EXISTS addon_receipts_no_delete
  BEFORE DELETE ON addon_receipts
BEGIN
  SELECT RAISE(ABORT, 'addon receipts are append-only: DELETE is forbidden');
END;
