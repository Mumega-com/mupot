-- 0178_addon_isolation_class_immutable.sql — mupot#1587 P1-B (round-2 gate on #1582):
-- migrations/0175_addon_external_isolated.sql added `isolation_class` as the REAL
-- source of truth for an installation/receipt's trust class (trust_class is legacy,
-- frozen forever at 'native_reviewed' — see 0175's header), but the two triggers that
-- protect trust_class's identical invariants were never widened to also cover
-- isolation_class:
--
--   - addon_installations_identity_is_immutable (0050:54) only lists trust_class in
--     its BEFORE UPDATE OF column set and its WHEN clause — `UPDATE addon_installations
--     SET isolation_class = ...` was NOT one of the columns the trigger fires on at all,
--     so it silently succeeds in either direction (native_reviewed -> external_isolated
--     or back) on a live installation row.
--   - addon_receipts_snapshot_matches_installation (0050:456) compares seven identity
--     columns between a new receipt and its installation row, but not isolation_class —
--     a receipt whose isolation_class disagrees with its installation is accepted.
--
-- App code (matchesRegisteredIdentity, src/addons/service.ts) already catches a flipped
-- row by comparing it against the registered manifest, so this is not exploitable
-- end-to-end today — but the DB-level guard is what every OTHER identity column
--(addon_key, installed_version, publisher, trust_class, manifest_sha256,
-- mupot_compatibility, installed_by) already gets, and isolation_class is exactly as
-- security-relevant (it is what installAddon persists AS the addon's real trust class
-- now — see 0175's header) as the columns already protected. This migration closes
-- that gap the same way 0050 protects every other identity column: drop each trigger
-- and re-create it, copying each trigger body EXACTLY from 0050 and adding ONLY the
-- isolation_class column/comparison — a trigger drop-and-recreate is a plain DDL statement,
-- not a table rebuild, so none of 0175's "PARENT table with RESTRICT children can't be
-- rebuilt inside D1's one-transaction-per-file semantics" concern applies here at all.
--
-- addon_installations_identity_is_immutable: adds `isolation_class` to both the
-- BEFORE UPDATE OF column list and the WHEN clause's OR chain — every other column,
-- comparison operator (IS NOT, for NULL-safety), and the RAISE(ABORT, ...) message are
-- copied byte-for-byte from 0050.
DROP TRIGGER IF EXISTS addon_installations_identity_is_immutable;

CREATE TRIGGER addon_installations_identity_is_immutable
  BEFORE UPDATE OF id, tenant, addon_key, installed_version, publisher,
    trust_class, manifest_sha256, mupot_compatibility, installed_by, isolation_class
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
    OR NEW.isolation_class IS NOT OLD.isolation_class
BEGIN
  SELECT RAISE(ABORT, 'addon installation identity is immutable');
END;

-- addon_receipts_snapshot_matches_installation: adds ONE more AND'd comparison
-- (installation.isolation_class = NEW.isolation_class) to the EXISTS subquery. Every
-- other comparison and the RAISE(ABORT, ...) message are copied byte-for-byte from 0050.
DROP TRIGGER IF EXISTS addon_receipts_snapshot_matches_installation;

CREATE TRIGGER addon_receipts_snapshot_matches_installation
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
       AND installation.isolation_class = NEW.isolation_class
  )
BEGIN
  SELECT RAISE(ABORT, 'addon receipt identity does not match installation');
END;
