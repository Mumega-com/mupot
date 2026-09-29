-- 0184_addon_connector_bindings_write_capability.sql — T2b (mupot#1580):
-- addon_connector_bindings.capability is CHECK'd to the single literal 'read'
-- (migrations/0052_addon_bindings.sql) — there is no way, even with raw SQL, to
-- construct a 'write' binding, and src/addons/bindings.ts's preflightAddonBindings
-- independently, unconditionally refuses any manifest that declares a 'write'
-- connectorRequirements entry (capability_mismatch), regardless of the addon's
-- trust posture. mcpwp-office's `wordpress_site` slot is the first (and today
-- only) write-capable connector requirement in this codebase — see mupot#1592/
-- #1602's PR bodies and src/addons/office/service.ts's file header for the full
-- "known, reported gap" this migration closes.
--
-- ============================================================================
-- WHY THE EXISTING `capability` COLUMN/CHECK IS NOT WIDENED, AND
-- addon_connector_bindings IS NOT REBUILT (STOP-and-report discipline, same as
-- 0173's members/tasks sections and 0175's addon_installations/addon_receipts
-- section — read those before touching this file again)
-- ============================================================================
-- SQLite has no ALTER COLUMN / ALTER CONSTRAINT — the only ways to change what
-- values a CHECK'd column accepts are (a) the row-preserving rebuild this repo
-- already uses in several places (0020/0042/0049/0158/0165/0171), or (b) leave
-- the column exactly as-is and ADD A NEW COLUMN with its own CHECK (0173's
-- members/squads shape, 0175's isolation_class shape).
--
-- (a) is available here — UNLIKE 0175's addon_installations/addon_receipts,
-- nothing in this schema holds a live FK to addon_connector_bindings at all
-- (`grep -rn "REFERENCES addon_connector_bindings" migrations/` returns zero
-- matches; addon_connector_bindings is a LEAF table — it only ever points AT
-- addon_installations/addon_binding_generations/connectors, never the reverse),
-- so a DROP TABLE addon_connector_bindings inside this migration's single D1
-- transaction cannot trip anyone else's ON DELETE RESTRICT. A full rebuild would
-- not hit 0175's wall.
--
-- (b) is still the chosen shape, for the SAME reason 0175 chose it even where a
-- rebuild might have been survivable: it is strictly less risky (no DROP/RENAME
-- dance, no re-deriving 6 triggers + 2 indexes from scratch, no
-- `PRAGMA legacy_alter_table` edge case to reason about) and it makes the
-- migration's diff exactly as large as the actual change — one column, one
-- trigger touched to extend its existing immutability list. `capability`
-- becomes LEGACY from this migration forward: every row, old and new, keeps
-- `capability = 'read'` forever (its CHECK is unchanged and still enforces
-- exactly that one value) — never a lie, because it is retired, not
-- repurposed. `capability_v2` is the new, real source of truth for a binding's
-- capability (read | write); src/addons/bindings.ts's bindingFromRow now maps
-- AddonBinding.capability from THIS column, never from the legacy one — the
-- exact mapping 0175 established for AddonInstallation.trustClass <-
-- installation.isolation_class.
--
-- Every INSERT into addon_connector_bindings (src/addons/bindings.ts's
-- configureAddonBindings) keeps writing the literal 'read' into the legacy
-- column unconditionally, and now also binds the manifest-declared capability
-- ('read' or 'write') into capability_v2 — never a caller-supplied value; a
-- connector binding's capability is entirely determined by which slot of the
-- REGISTERED manifest it satisfies (AddonBindingInput has no capability field
-- at all), so there is no input surface for a caller to request a capability
-- the addon's own manifest does not declare for that slot.
--
-- addon_connector_bindings_revoke_only (the append-only-except-revocation
-- trigger — most recently recreated by migrations/0181, after the manifest-
-- identity backfill touched it) is extended to ALSO freeze `capability_v2`,
-- mirroring exactly how 0178 extended addon_installations_identity_is_immutable
-- to cover isolation_class after 0175 added it: every other column, the
-- comparison operator (IS NOT, for NULL-safety), and the RAISE(ABORT, ...)
-- message are copied byte-for-byte from the CURRENT (post-0181) trigger body —
-- confirmed against sqlite_master, not hand-typed from an older file — with one
-- line added. `addon_connector_bindings_start_live`,
-- `addon_connector_bindings_matches_generation`, and
-- `addon_connector_bindings_connector_is_live_and_type_matched` (0052) never
-- reference `capability` at all and need no change.
--
-- src/addons/bindings.ts's preflightAddonBindings gates WHO may ever request a
-- write-capability connector requirement at all: manifest.kind must be
-- 'external_mcp', manifest.trustClass must be 'external_isolated', the LIVE
-- installation's own isolation_class (installation.trustClass) must independently
-- also read 'external_isolated', and externalIsolationViolation(manifest) — the
-- SAME structural invariant check installAddon/configureAddon/activateAddon each
-- re-run on every call (src/addons/service.ts's trustGateViolation, P2 fix from
-- mupot#1580's round-2 gate) — must find zero violations, re-proved at THIS call
-- too, not merely trusted from an earlier gate in the same request. A native
-- addon (kind:'native') can never satisfy this — trustGateViolation itself
-- refuses any native manifest whose trustClass isn't 'native_reviewed', and no
-- native manifest in this repo declares a 'write' connectorRequirements entry in
-- the first place. A 'read' slot never asks for this gate at all: the check only
-- applies when the manifest's OWN declared capability for that slot is 'write'.

ALTER TABLE addon_connector_bindings
  ADD COLUMN capability_v2 TEXT NOT NULL DEFAULT 'read'
    CHECK (capability_v2 IN ('read', 'write'));

DROP TRIGGER IF EXISTS addon_connector_bindings_revoke_only;

CREATE TRIGGER addon_connector_bindings_revoke_only
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
    OR NEW.capability_v2 IS NOT OLD.capability_v2
    OR NEW.connector_id IS NOT OLD.connector_id
    OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256
    OR NEW.configured_by IS NOT OLD.configured_by
    OR NEW.configured_at IS NOT OLD.configured_at
BEGIN
  SELECT RAISE(ABORT, 'addon bindings are append-only except revocation');
END;
