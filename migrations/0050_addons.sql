CREATE TABLE IF NOT EXISTS addon_installations (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  addon_key TEXT NOT NULL,
  installed_version TEXT NOT NULL,
  publisher TEXT NOT NULL,
  trust_class TEXT NOT NULL CHECK (trust_class = 'native_reviewed'),
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
  mupot_compatibility TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('installed','configured','active','disabled','archived')),
  installed_by TEXT NOT NULL,
  latest_actor_id TEXT NOT NULL,
  latest_receipt_id TEXT,
  installed_at TEXT NOT NULL,
  configured_at TEXT,
  activated_at TEXT,
  disabled_at TEXT,
  archived_at TEXT,
  updated_at TEXT NOT NULL,
  last_error TEXT,
  UNIQUE (tenant, addon_key)
);

CREATE TABLE IF NOT EXISTS addon_operations (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  installation_id TEXT NOT NULL REFERENCES addon_installations(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('activate','disable','archive')),
  target_state TEXT NOT NULL,
  current_step TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed','compensated')),
  actor_id TEXT NOT NULL,
  lease_expires_at TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_addon_one_running_operation
  ON addon_operations (tenant, installation_id) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS addon_resource_ownership (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  installation_id TEXT NOT NULL REFERENCES addon_installations(id) ON DELETE RESTRICT,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  ownership_mode TEXT NOT NULL CHECK (ownership_mode IN ('exclusive','co_owner')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  released_at TEXT,
  UNIQUE (tenant, installation_id, resource_type, resource_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_addon_exclusive_resource
  ON addon_resource_ownership (tenant, resource_type, resource_id)
  WHERE active = 1 AND ownership_mode = 'exclusive';

CREATE TABLE IF NOT EXISTS addon_receipts (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  installation_id TEXT NOT NULL REFERENCES addon_installations(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  previous_state TEXT,
  next_state TEXT,
  manifest_sha256 TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('pass','fail')),
  side_effect_ids TEXT NOT NULL DEFAULT '[]',
  checks TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_addon_receipts_installation
  ON addon_receipts (tenant, installation_id, created_at DESC);
