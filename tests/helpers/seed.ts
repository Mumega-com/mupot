// tests/helpers/seed.ts — minimal rows that satisfy the REAL constraints.
//
// Once a test builds its schema from the committed migrations instead of a hand-written
// CREATE TABLE, its fixture rows meet production's constraints for the first time. That
// is the point, and it is not free: converting 13 such tests produced 29 failures, every
// one of them a constraint the hand-written fixture had quietly dropped —
//
//   FOREIGN KEY constraint failed                       (tasks -> squads -> departments)
//   NOT NULL constraint failed: members.display_name
//   blank provenance: external_source/source_pot ...    (migration 0078's trigger)
//
// A fixture that cannot satisfy production's constraints was describing rows production
// would refuse to store. These helpers insert the smallest row each table actually
// accepts, so a test seeds a state that can genuinely exist.
//
// Deliberately NOT a fixture factory with defaults for everything: only the columns the
// schema REQUIRES are set here. Anything a test cares about, the test sets itself — a
// helper that quietly supplies values is how a test stops describing its own scenario.

interface ExecutableSqlite {
  exec(sql: string): void
}

const q = (value: string): string => `'${value.replace(/'/g, "''")}'`

/**
 * departments: slug + name required. NOTE — departments, squads and agents carry NO
 * `tenant` column; only `members` does. Verified against the built chain, because the
 * first version of this file assumed a tenant column on all four and failed on the
 * first run. Read the schema; do not infer it from the neighbouring tables.
 */
export function seedDepartment(sqlite: ExecutableSqlite, id: string): string {
  sqlite.exec(
    `INSERT OR IGNORE INTO departments (id, slug, name) VALUES (${q(id)}, ${q(id)}, ${q(id)})`,
  )
  return id
}

/** squads: department_id (FK), slug, name required. Creates the department if absent. */
export function seedSquad(sqlite: ExecutableSqlite, id: string, departmentId = `${id}-dept`): string {
  seedDepartment(sqlite, departmentId)
  sqlite.exec(
    `INSERT OR IGNORE INTO squads (id, department_id, slug, name)
     VALUES (${q(id)}, ${q(departmentId)}, ${q(id)}, ${q(id)})`,
  )
  return id
}

/** agents: squad_id (FK), slug, name required. Creates the squad chain if absent. */
export function seedAgent(sqlite: ExecutableSqlite, id: string, squadId = `${id}-squad`): string {
  seedSquad(sqlite, squadId)
  sqlite.exec(
    `INSERT OR IGNORE INTO agents (id, squad_id, slug, name)
     VALUES (${q(id)}, ${q(squadId)}, ${q(id)}, ${q(id)})`,
  )
  return id
}

/** members: display_name required; `tenant` exists here and only here. */
export function seedMember(sqlite: ExecutableSqlite, id: string, tenant = 'tenant-a'): string {
  sqlite.exec(
    `INSERT OR IGNORE INTO members (id, tenant, display_name, status)
     VALUES (${q(id)}, ${q(tenant)}, ${q(id)}, 'active')`,
  )
  return id
}
