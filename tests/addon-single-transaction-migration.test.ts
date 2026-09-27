// tests/addon-single-transaction-migration.test.ts — mupot#1580 adversarial finding
// (P0): the local node:sqlite test harness applies each migration FILE as its own
// `sqlite.exec(fileText)` call, and a bare multi-statement `exec()` with no explicit
// BEGIN/COMMIT runs EACH STATEMENT as its own autocommit transaction under node:sqlite
// — a DEFERRABLE FK still gets checked at the end of that single statement, not
// deferred to some later point. Cloudflare D1 applies an ENTIRE migration FILE inside
// ONE transaction (this is closer to production's real semantics, not further from it).
// Neither harness shape can, by itself, prove a rebuild migration is D1-safe: the local
// harness never seeds a live row before applying a migration (every migration in the
// committed chain is currently row-preserving, per tests/helpers-migrations.test.ts), so
// a DROP TABLE with a populated child table was never exercised at all until this file.
//
// THE DEFECT THIS FILE PINS: migration 0175's first version (see OLD_REBUILD_SHAPE_0175
// below, extracted verbatim from git history — head 890edcd7) rebuilt addon_installations
// + addon_receipts (CREATE ..._new, copy rows, DROP, RENAME) to widen trust_class's CHECK.
// That is unsafe: 7 tables (addon_operations, addon_operation_failures,
// addon_resource_ownership, addon_binding_generations, addon_connector_bindings,
// marketing_monitor_runs, marketing_recommendations) hold a live, non-deferrable
// `ON DELETE RESTRICT` FK to addon_installations, and addon_receipts itself holds one
// back to addon_installations too (also ON DELETE RESTRICT, not deferrable — only
// addon_installations' OWN FK to addon_receipts, via latest_receipt_id, is declared
// DEFERRABLE). DROP TABLE performs an implicit DELETE of every row in the dropped
// table; with even ONE live installation (and its mandatory install receipt — every
// real installation has at least one), that implicit DELETE hits the receipt's
// ordinary RESTRICT FK immediately, transaction or not. Production already has a live,
// active installation (marketing-cro-monitor), so `wrangler d1 migrations apply
// --remote` with the rebuild shape would fail on the very first populated tenant.
//
// THE FIX (current migrations/0175_addon_external_isolated.sql): ADD COLUMN only — no
// DROP, no RENAME, no PRAGMA. A plain `ALTER TABLE ... ADD COLUMN` never touches any
// existing row's identity or any FK-referencing child at all, so this class of failure
// cannot occur regardless of whether the DB is empty or fully populated.
//
// THIS TEST reproduces D1's real single-transaction-per-migration-file semantics
// explicitly (`db.exec('BEGIN;\n' + sql + '\nCOMMIT;')` — one exec() call, matching
// wrangler's own application model) against a database seeded with a live installation
// + its receipt BEFORE the migration under test is applied, and mutation-proves the
// fix: applying the OLD_REBUILD_SHAPE_0175 fixture the same way fails with exactly the
// error reproduced on wrangler local D1 during review; applying the CURRENT, committed
// migration file succeeds.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')
const TARGET_MARKER = 'isolation_class' // unique to the migration under test — see below

interface RawSqlite {
  exec(sql: string): void
  prepare(sql: string): { get(...values: unknown[]): Record<string, unknown> | undefined }
}

function migrationFilesInOrder(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()
}

/** Locate the migration under test by CONTENT, not a hardcoded filename/number — this
 *  file's own migration is free to be renumbered (a real, documented occurrence in this
 *  repo's history — see 0171's header) without silently detaching this regression test
 *  from it. */
function findTargetMigrationFile(): string {
  const files = migrationFilesInOrder()
  const found = files.find((file) => readFileSync(join(MIGRATIONS_DIR, file), 'utf8').includes(TARGET_MARKER))
  if (!found) throw new Error(`no committed migration declares ${TARGET_MARKER} — has it been renamed?`)
  return found
}

function freshDbBeforeTarget(targetFile: string): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const file of migrationFilesInOrder()) {
    if (file === targetFile) break
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  return db
}

/** Seeds exactly what a real installAddon() call produces: one 'installed' row plus
 *  its mandatory 'install' receipt — the minimum live shape every real installation
 *  has, and (per the header above) already enough to trip the old rebuild's DROP TABLE
 *  on addon_receipts' own ordinary RESTRICT FK back to addon_installations. Written as
 *  its own single-transaction exec(), matching D1's real write pattern
 *  (env.DB.batch([...]) — one commit for both statements). */
function seedLiveInstallation(db: RawSqlite): void {
  const sha = 'a'.repeat(64)
  db.exec(`
    BEGIN;
    INSERT INTO addon_installations (
      id, tenant, addon_key, installed_version, publisher, trust_class,
      manifest_sha256, mupot_compatibility, state, latest_previous_state, installed_by,
      latest_actor_id, latest_receipt_id, installed_at, updated_at
    ) VALUES ('inst-live-1', 'tenant-a', 'marketing-cro-monitor', '1.0.0', 'mumega',
      'native_reviewed', '${sha}', '^0.30.0', 'installed', NULL, 'actor-1', 'actor-1',
      'recpt-live-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO addon_receipts (
      id, tenant, installation_id, action, previous_state, next_state,
      addon_key, installed_version, publisher, trust_class,
      mupot_compatibility, manifest_sha256, actor_id, outcome,
      side_effect_ids, checks, created_at
    ) VALUES ('recpt-live-1', 'tenant-a', 'inst-live-1', 'install', NULL, 'installed',
      'marketing-cro-monitor', '1.0.0', 'mumega', 'native_reviewed', '^0.30.0', '${sha}',
      'actor-1', 'pass', '[]', '{}', '2026-01-01T00:00:00.000Z');
    COMMIT;
  `)
}

/** Applies `sql` as D1 applies a migration file: ONE transaction, ONE exec() call. A
 *  bare multi-statement exec() with no explicit BEGIN/COMMIT is NOT equivalent under
 *  node:sqlite — see this file's header — so every apply in this file goes through here. */
function applyAsOneD1Transaction(db: RawSqlite, sql: string): void {
  db.exec(`BEGIN;\n${sql}\nCOMMIT;`)
}

// Extracted VERBATIM from git history (head 890edcd7, the commit this adversarial
// finding was raised against) — the first, rejected version of migration 0175. Kept
// here as a standing regression fixture, not applied to any real database outside this
// test file's own throwaway in-memory instances.
const OLD_REBUILD_SHAPE_0175 = `
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

PRAGMA legacy_alter_table = ON;
ALTER TABLE addon_installations_new RENAME TO addon_installations;
ALTER TABLE addon_receipts_new RENAME TO addon_receipts;
PRAGMA legacy_alter_table = OFF;

PRAGMA foreign_keys = on;
`

describe('addon trust-class migration — D1 single-transaction semantics', () => {
  it('sanity: the full committed migration chain still applies cleanly (uses the sanctioned harness)', () => {
    const harness = createSqliteD1()
    expect(() => applyAllMigrations(harness.sqlite)).not.toThrow()
    harness.close()
  })

  it('the CURRENT migration (ADD COLUMN) applies in one D1-style transaction with a live installation already present', () => {
    const targetFile = findTargetMigrationFile()
    const db = freshDbBeforeTarget(targetFile)
    seedLiveInstallation(db)
    const sql = readFileSync(join(MIGRATIONS_DIR, targetFile), 'utf8')

    expect(() => applyAsOneD1Transaction(db, sql)).not.toThrow()

    const row = db.prepare(
      `SELECT isolation_class FROM addon_installations WHERE id = 'inst-live-1'`,
    ).get() as { isolation_class: string } | undefined
    expect(row?.isolation_class).toBe('native_reviewed')
    db.close()
  })

  // MUTATION PROOF (P0): the exact class of migration this PR replaced, applied the
  // exact same way (single transaction, live installation seeded first), reproduces
  // the failure adversarial review found on wrangler local D1.
  it('the OLD rebuild shape fails with FOREIGN KEY constraint failed under the same conditions', () => {
    const targetFile = findTargetMigrationFile()
    const db = freshDbBeforeTarget(targetFile)
    seedLiveInstallation(db)

    expect(() => applyAsOneD1Transaction(db, OLD_REBUILD_SHAPE_0175)).toThrow(/FOREIGN KEY constraint failed/)
    db.close()
  })

  it('the OLD rebuild shape succeeds on an EMPTY database — the local harness alone cannot distinguish it from the fix', () => {
    // This is the gap the adversarial review named directly: applyAllMigrations() never
    // seeds a row before running a migration, so a rebuild that only fails on populated
    // tables looks identical to a safe one. Documented here, not routed around.
    const targetFile = findTargetMigrationFile()
    const db = freshDbBeforeTarget(targetFile)
    // No seedLiveInstallation() call — empty tables, nothing to RESTRICT against.

    expect(() => applyAsOneD1Transaction(db, OLD_REBUILD_SHAPE_0175)).not.toThrow()
    db.close()
  })
})
