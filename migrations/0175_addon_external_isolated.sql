-- 0175_addon_external_isolated.sql — widen addon_installations/addon_receipts'
-- trust_class CHECK to admit 'external_isolated' (mupot#1580 slice 1 follow-up,
-- coordinator decision: "close the gap in this PR — slice 1's purpose is prove
-- the addon door").
--
-- src/addons/contract.ts's AddonManifestV1 has modeled trustClass:
-- 'native_reviewed' | 'external_isolated' since it was written (and the pairing
-- kind==='native' <=> trustClass==='native_reviewed' is enforced by
-- validateAddonManifest's trust_kind_mismatch check) — but the addon lifecycle
-- persistence layer never followed: both addon_installations.trust_class and
-- addon_receipts.trust_class carried CHECK (trust_class = 'native_reviewed'),
-- a single-value CHECK rather than an IN-list, so no external_mcp addon could
-- ever be installed. src/addons/service.ts's installAddon separately refused
-- any non-native manifest in code (see the accompanying commit for that fix);
-- this migration is the schema half.
--
-- SQLite has no ALTER COLUMN / ALTER CONSTRAINT, so this is the same
-- recreate-table rebuild migrations/0042 (tasks.status), 0158
-- (routine_run_actions.kind), 0165 (member_home_provisioning_receipts.channel),
-- and 0171 (task_dispatch_runtime_receipts.stage) already use for exactly this
-- shape of change: rebuild with every column, FK, index, and trigger unchanged
-- except the widened CHECK. WIDEN, DON'T RELABEL — no existing row's
-- trust_class value is touched (every row today is 'native_reviewed'), only
-- the set of values a FUTURE row may carry is expanded.
--
-- addon_installations and addon_receipts reference EACH OTHER (installations
-- carries a DEFERRABLE FK to its own latest receipt; receipts carries a plain
-- FK back to its installation, plus a family of BEFORE INSERT/UPDATE triggers
-- that cross-check the two tables against each other). Both are rebuilt in the
-- same PRAGMA foreign_keys=off block so neither rebuild's FK clause needs the
-- other table to exist yet, mirroring the existing precedent's use of that
-- pragma for the exact same reason (0171's rebuilt table is also referenced
-- from elsewhere, and referencING tables are similarly exempt from validation
-- while the pragma is off).
--
-- PRAGMA foreign_keys is decorative on D1 (same precedent as 0049/0069/0116/
-- 0165/0171) but real under this repo's own local node:sqlite migration test
-- harness — kept for both.
--
-- addon_receipts.sequence is AUTOINCREMENT: rows are copied WITH their
-- original sequence numbers (not renumbered), and SQLite's ALTER TABLE ...
-- RENAME TO updates the matching sqlite_sequence row to the new name, so the
-- autoincrement counter for future inserts is preserved exactly.

PRAGMA foreign_keys = off;

CREATE TABLE addon_installations_new (
  id TEXT NOT NULL PRIMARY KEY,
  tenant TEXT NOT NULL,
  addon_key TEXT NOT NULL,
  installed_version TEXT NOT NULL,
  publisher TEXT NOT NULL,
  trust_class TEXT NOT NULL CHECK (trust_class IN ('native_reviewed', 'external_isolated')),
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

CREATE TABLE addon_receipts_new (
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
  trust_class TEXT NOT NULL CHECK (trust_class IN ('native_reviewed', 'external_isolated')),
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

-- Row- AND value-preserving: every column copied as-is, no CASE/relabel.
INSERT INTO addon_installations_new (
  id, tenant, addon_key, installed_version, publisher, trust_class,
  manifest_sha256, mupot_compatibility, state, latest_previous_state,
  installed_by, latest_actor_id, latest_receipt_id, installed_at,
  configured_at, activated_at, disabled_at, archived_at, updated_at, last_error
)
SELECT
  id, tenant, addon_key, installed_version, publisher, trust_class,
  manifest_sha256, mupot_compatibility, state, latest_previous_state,
  installed_by, latest_actor_id, latest_receipt_id, installed_at,
  configured_at, activated_at, disabled_at, archived_at, updated_at, last_error
FROM addon_installations;

-- Copied WITH original sequence numbers (not renumbered) so the AUTOINCREMENT
-- counter carries forward correctly once the table is renamed back.
INSERT INTO addon_receipts_new (
  sequence, id, tenant, installation_id, action, previous_state, next_state,
  addon_key, installed_version, publisher, trust_class, mupot_compatibility,
  manifest_sha256, actor_id, outcome, side_effect_ids, checks, error_code, created_at
)
SELECT
  sequence, id, tenant, installation_id, action, previous_state, next_state,
  addon_key, installed_version, publisher, trust_class, mupot_compatibility,
  manifest_sha256, actor_id, outcome, side_effect_ids, checks, error_code, created_at
FROM addon_receipts
ORDER BY sequence;

DROP TABLE addon_receipts;
DROP TABLE addon_installations;

-- SQLite's default ALTER TABLE RENAME (3.25+) walks every OTHER trigger/view/index in
-- the schema to rewrite any reference to the renamed table's OLD name — and, as a side
-- effect of that walk, revalidates unrelated trigger bodies against the schema AS IT
-- EXISTS mid-statement. addon_resource_ownership's own triggers (0050_addons.sql)
-- reference addon_installations in a subquery; at the instant this RENAME runs,
-- addon_installations has just been DROPped and not yet recreated, so that revalidation
-- spuriously fails with "no such table: main.addon_installations" even though neither
-- rename actually needs any reference rewritten (every FK/trigger in THIS migration was
-- already hand-written against the final names, never the temporary _new ones — see the
-- header comment). PRAGMA legacy_alter_table=ON restores pre-3.25 RENAME behavior (name
-- change only, no schema-wide reference walk), which is exactly correct here and avoids
-- the false positive. Reset to OFF immediately after so it does not leak into any later
-- migration or statement on this connection.
PRAGMA legacy_alter_table = ON;
ALTER TABLE addon_installations_new RENAME TO addon_installations;
ALTER TABLE addon_receipts_new RENAME TO addon_receipts;
PRAGMA legacy_alter_table = OFF;

-- Indexes dropped with the tables above — recreated verbatim from 0050_addons.sql.
CREATE UNIQUE INDEX IF NOT EXISTS idx_addon_one_live_installation
  ON addon_installations (tenant, addon_key)
  WHERE state <> 'archived';

CREATE INDEX IF NOT EXISTS idx_addon_receipts_installation
  ON addon_receipts (tenant, installation_id, sequence DESC);

-- Triggers dropped with the tables above — recreated verbatim from
-- 0050_addons.sql and 0052_addon_bindings.sql (the two later-added
-- archive-requires-revoked-* triggers on addon_installations).

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

PRAGMA foreign_keys = on;
