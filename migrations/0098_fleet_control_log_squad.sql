-- 0098_fleet_control_log_squad.sql — extend the control audit trail to squad-scoped requests.
--
-- A squad-scoped control-request (engine.control_squad, agents/fleet-control/engine.py on the
-- host) has no single agent_id — it fans a verb out to every manifest whose `squads` includes
-- the target squad_id. fleet_control_log.agent_id is NOT NULL (0034); rather than a table
-- recreate (SQLite has no ALTER COLUMN, and a full backup/restore is unwarranted for adding one
-- nullable audit column — see [[feedback_migration_backup_all_reinsert_all_antipattern]]), a
-- squad-targeted row leaves agent_id = '' (same NOT NULL DEFAULT '' backfill shape already used
-- by 0093/0094 for this exact situation) and carries the squad id in this new column instead.
--
-- Exactly one of (agent_id != '', squad_id IS NOT NULL) holds for any row — enforced at the
-- application layer (src/fleet/control.ts's emitControlRequest / emitSquadControlRequest write
-- exactly one), not by a CHECK constraint, to avoid recreating the table for a column this
-- narrowly scoped.

ALTER TABLE fleet_control_log ADD COLUMN squad_id TEXT;

CREATE INDEX IF NOT EXISTS idx_fleet_control_log_squad
  ON fleet_control_log(tenant, squad_id);
