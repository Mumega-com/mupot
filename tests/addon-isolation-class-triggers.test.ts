// tests/addon-isolation-class-triggers.test.ts — mupot#1587 P1-B (round-2 gate on
// #1582): migrations/0178_addon_isolation_class_immutable.sql widens
// addon_installations_identity_is_immutable and addon_receipts_snapshot_matches_
// installation (both from migrations/0050_addons.sql) to ALSO cover isolation_class —
// the real trust-class source of truth since migrations/0175_addon_external_isolated.sql
// (trust_class is legacy/frozen there forever). Before 0178, an UPDATE that flipped
// isolation_class was NOT one of the columns either trigger fired on, so it silently
// succeeded in either direction, and a receipt whose isolation_class disagreed with its
// installation was accepted.
//
// Schema: real D1 (node:sqlite via createSqliteD1) + applyAllMigrations() — the full,
// committed migration chain, including 0178. No hand-rolled DDL.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'tenant-office-triggers'
const SHA = 'b'.repeat(64)

function harnessWithLiveInstallation(isolationClass: 'native_reviewed' | 'external_isolated' = 'native_reviewed'): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec('BEGIN')
  try {
    harness.sqlite.prepare(`
      INSERT INTO addon_installations (
        id, tenant, addon_key, installed_version, publisher, trust_class,
        manifest_sha256, mupot_compatibility, state, latest_previous_state, installed_by,
        latest_actor_id, latest_receipt_id, installed_at, updated_at, isolation_class
      ) VALUES ('inst-trig-1', ?, 'mcpwp-office', '1.0.0', 'mumega', 'native_reviewed',
        ?, '^0.30.0', 'installed', NULL, 'actor-1', 'actor-1', 'recpt-trig-1',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)
    `).run(TENANT, SHA, isolationClass)
    harness.sqlite.prepare(`
      INSERT INTO addon_receipts (
        id, tenant, installation_id, action, previous_state, next_state,
        addon_key, installed_version, publisher, trust_class,
        mupot_compatibility, manifest_sha256, actor_id, outcome,
        side_effect_ids, checks, created_at, isolation_class
      ) VALUES ('recpt-trig-1', ?, 'inst-trig-1', 'install', NULL, 'installed',
        'mcpwp-office', '1.0.0', 'mumega', 'native_reviewed', '^0.30.0', ?,
        'actor-1', 'pass', '[]', '{}', '2026-01-01T00:00:00.000Z', ?)
    `).run(TENANT, SHA, isolationClass)
    harness.sqlite.exec('COMMIT')
  } catch (error) {
    harness.sqlite.exec('ROLLBACK')
    throw error
  }
  return harness
}

describe('addon_installations_identity_is_immutable — isolation_class (mupot#1587 P1-B)', () => {
  it('refuses an UPDATE that flips isolation_class', () => {
    const harness = harnessWithLiveInstallation('external_isolated')

    expect(() => harness.sqlite.prepare(
      `UPDATE addon_installations SET isolation_class = 'native_reviewed' WHERE id = 'inst-trig-1'`,
    ).run()).toThrow(/addon installation identity is immutable/)

    const row = harness.sqlite.prepare(
      `SELECT isolation_class FROM addon_installations WHERE id = 'inst-trig-1'`,
    ).get() as { isolation_class: string }
    expect(row.isolation_class).toBe('external_isolated')
    harness.close()
  })

  it('an UPDATE that touches an unrelated column and leaves isolation_class unchanged still succeeds', () => {
    const harness = harnessWithLiveInstallation('external_isolated')

    expect(() => harness.sqlite.prepare(
      `UPDATE addon_installations SET last_error = 'probe' WHERE id = 'inst-trig-1'`,
    ).run()).not.toThrow()
    harness.close()
  })

  // MUTATION PROOF: the pre-0178 trigger shape (trust_class only) does not fire on an
  // isolation_class-only UPDATE — reproduced here by issuing the update against a
  // schema built WITHOUT 0178 applied (every migration up to but excluding it).
  it('mutation proof: without 0178, the SAME update succeeds (the gap this migration closes)', () => {
    const migrationsDir = join(import.meta.dirname, '..', 'migrations')
    const files = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()
    const targetFile = files.find((file) =>
      readFileSync(join(migrationsDir, file), 'utf8').includes('addon_receipts_snapshot_matches_installation')
      && readFileSync(join(migrationsDir, file), 'utf8').includes('isolation_class'),
    )
    if (!targetFile) throw new Error('no committed migration widens the isolation_class triggers — has 0178 been renamed?')

    const db = new DatabaseSync(':memory:')
    for (const file of files) {
      if (file === targetFile) break
      db.exec(readFileSync(join(migrationsDir, file), 'utf8'))
    }
    db.exec(`
      BEGIN;
      INSERT INTO addon_installations (
        id, tenant, addon_key, installed_version, publisher, trust_class,
        manifest_sha256, mupot_compatibility, state, latest_previous_state, installed_by,
        latest_actor_id, latest_receipt_id, installed_at, updated_at, isolation_class
      ) VALUES ('inst-pre-1', '${TENANT}', 'mcpwp-office', '1.0.0', 'mumega', 'native_reviewed',
        '${SHA}', '^0.30.0', 'installed', NULL, 'actor-1', 'actor-1', 'recpt-pre-1',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'external_isolated');
      INSERT INTO addon_receipts (
        id, tenant, installation_id, action, previous_state, next_state,
        addon_key, installed_version, publisher, trust_class,
        mupot_compatibility, manifest_sha256, actor_id, outcome,
        side_effect_ids, checks, created_at, isolation_class
      ) VALUES ('recpt-pre-1', '${TENANT}', 'inst-pre-1', 'install', NULL, 'installed',
        'mcpwp-office', '1.0.0', 'mumega', 'native_reviewed', '^0.30.0', '${SHA}',
        'actor-1', 'pass', '[]', '{}', '2026-01-01T00:00:00.000Z', 'external_isolated');
      COMMIT;
    `)

    expect(() => db.exec(
      `UPDATE addon_installations SET isolation_class = 'native_reviewed' WHERE id = 'inst-pre-1'`,
    )).not.toThrow()
    const row = db.prepare(
      `SELECT isolation_class FROM addon_installations WHERE id = 'inst-pre-1'`,
    ).get() as { isolation_class: string }
    expect(row.isolation_class).toBe('native_reviewed')
    db.close()
  })
})

describe('addon_receipts_snapshot_matches_installation — isolation_class (mupot#1587 P1-B)', () => {
  it('refuses a receipt whose isolation_class disagrees with its installation', () => {
    const harness = harnessWithLiveInstallation('external_isolated')

    expect(() => harness.sqlite.prepare(`
      INSERT INTO addon_receipts (
        id, tenant, installation_id, action, previous_state, next_state,
        addon_key, installed_version, publisher, trust_class,
        mupot_compatibility, manifest_sha256, actor_id, outcome,
        side_effect_ids, checks, created_at, isolation_class
      ) VALUES ('recpt-mismatch-1', ?, 'inst-trig-1', 'health', NULL, NULL,
        'mcpwp-office', '1.0.0', 'mumega', 'native_reviewed', '^0.30.0', ?,
        'actor-1', 'pass', '[]', '{}', '2026-01-02T00:00:00.000Z', 'native_reviewed')
    `).run(TENANT, SHA)).toThrow(/addon receipt identity does not match installation/)
    harness.close()
  })

  it('accepts a receipt whose isolation_class matches its installation', () => {
    const harness = harnessWithLiveInstallation('external_isolated')

    expect(() => harness.sqlite.prepare(`
      INSERT INTO addon_receipts (
        id, tenant, installation_id, action, previous_state, next_state,
        addon_key, installed_version, publisher, trust_class,
        mupot_compatibility, manifest_sha256, actor_id, outcome,
        side_effect_ids, checks, created_at, isolation_class
      ) VALUES ('recpt-match-1', ?, 'inst-trig-1', 'health', NULL, NULL,
        'mcpwp-office', '1.0.0', 'mumega', 'native_reviewed', '^0.30.0', ?,
        'actor-1', 'pass', '[]', '{}', '2026-01-02T00:00:00.000Z', 'external_isolated')
    `).run(TENANT, SHA)).not.toThrow()
    harness.close()
  })
})

describe('0178 applies inside a single D1-style transaction on a populated database', () => {
  it('applies cleanly with a live installation + receipt already present, DROP+CREATE TRIGGER only (never a table rebuild)', () => {
    const migrationsDir = join(import.meta.dirname, '..', 'migrations')
    const files = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()
    const targetFile = files.find((file) =>
      readFileSync(join(migrationsDir, file), 'utf8').includes('addon_receipts_snapshot_matches_installation')
      && readFileSync(join(migrationsDir, file), 'utf8').includes('isolation_class'),
    )
    if (!targetFile) throw new Error('no committed migration widens the isolation_class triggers — has 0178 been renamed?')

    const db = new DatabaseSync(':memory:')
    for (const file of files) {
      if (file === targetFile) break
      db.exec(readFileSync(join(migrationsDir, file), 'utf8'))
    }
    db.exec(`
      BEGIN;
      INSERT INTO addon_installations (
        id, tenant, addon_key, installed_version, publisher, trust_class,
        manifest_sha256, mupot_compatibility, state, latest_previous_state, installed_by,
        latest_actor_id, latest_receipt_id, installed_at, updated_at, isolation_class
      ) VALUES ('inst-txn-1', '${TENANT}', 'mcpwp-office', '1.0.0', 'mumega', 'native_reviewed',
        '${SHA}', '^0.30.0', 'installed', NULL, 'actor-1', 'actor-1', 'recpt-txn-1',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'external_isolated');
      INSERT INTO addon_receipts (
        id, tenant, installation_id, action, previous_state, next_state,
        addon_key, installed_version, publisher, trust_class,
        mupot_compatibility, manifest_sha256, actor_id, outcome,
        side_effect_ids, checks, created_at, isolation_class
      ) VALUES ('recpt-txn-1', '${TENANT}', 'inst-txn-1', 'install', NULL, 'installed',
        'mcpwp-office', '1.0.0', 'mumega', 'native_reviewed', '^0.30.0', '${SHA}',
        'actor-1', 'pass', '[]', '{}', '2026-01-01T00:00:00.000Z', 'external_isolated');
      COMMIT;
    `)

    const sql = readFileSync(join(migrationsDir, targetFile), 'utf8')
    expect(() => db.exec(`BEGIN;\n${sql}\nCOMMIT;`)).not.toThrow()

    // The trigger is live immediately after — same connection, same transaction chain.
    expect(() => db.exec(
      `UPDATE addon_installations SET isolation_class = 'native_reviewed' WHERE id = 'inst-txn-1'`,
    )).toThrow(/addon installation identity is immutable/)
    db.close()
  })
})
