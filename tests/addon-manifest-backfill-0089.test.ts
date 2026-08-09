import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { manifestSha256 } from '../src/addons/contract'
import { getRegisteredAddon } from '../src/addons/registry'
import { matchesRegisteredIdentity, type AddonInstallation } from '../src/addons/service'

// 0089_backfill_addon_manifest_v0_29.sql repairs the two live addon_installations
// rows (marketing-cro-monitor, project-link) left at mupotCompatibility ^0.24.0
// after #806 bumped MUPOT_PUBLIC_API_VERSION and every native manifest's
// mupotCompatibility to ^0.29.0. See the migration file's header for full context.
//
// This suite proves, against real sqlite (not a mock) and the repo's OWN
// manifestSha256()/matchesRegisteredIdentity() — not reimplementations of
// them — that:
//   1. the migration's hardcoded digest constants are what manifestSha256()
//      actually produces for the registered v0.29.0 manifests (load-bearing:
//      a hand-typed or stale digest must fail this test);
//   2. the migration is idempotent;
//   3. its WHERE guard touches only the intended rows;
//   4. matchesRegisteredIdentity() — the exact function that gates binding
//      preflight/configure/activate/disable — flips from false to true for
//      both installations, i.e. the freeze is actually lifted, not just that
//      a string changed;
//   5. the identity-immutable trigger the migration has to DROP mid-file to
//      perform the repair is restored and still enforcing afterward.

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TARGET_MIGRATION = '0089_backfill_addon_manifest_v0_29.sql'
const MIGRATION_SQL = readFileSync(join(MIGRATIONS_DIR, TARGET_MIGRATION), 'utf8')

const CRO_DIGEST = '6834802d7cc92f56c49f29a59432d514ccfd116af06b7dbd36aa66d18ae028ed'
const LINK_DIGEST = '41568a456cd69bc49b49ff9d873447ac110f1aa6f92869ea5c164c86b2dcc2b0'
const OLD_COMPAT = '^0.24.0'
const NEW_COMPAT = '^0.29.0'

function priorMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql') && name < TARGET_MIGRATION)
    .sort()
}

function applyInTransaction(sqlite: { exec(sql: string): void }, sql: string): void {
  // Mirrors `wrangler d1 migrations apply`: the whole file runs as one
  // transaction (see tests/agent-status-migration.test.ts for precedent).
  sqlite.exec('BEGIN')
  try {
    sqlite.exec(sql)
    sqlite.exec('COMMIT')
  } catch (error) {
    sqlite.exec('ROLLBACK')
    throw error
  }
}

interface InstallationRow {
  id: string
  tenant: string
  addon_key: string
  mupot_compatibility: string
  manifest_sha256: string
}

function seedRow(row: {
  id: string
  tenant: string
  addonKey: string
  compat: string
  digest: string
}) {
  // addon_installations.latest_receipt_id is a deferred FK into addon_receipts,
  // and addon_receipts has its own BEFORE INSERT triggers requiring the
  // installation snapshot to already match — so every seeded installation
  // needs its matching 'install' receipt inserted right after it (state
  // fixed at 'installed'/NULL-previous, the only state INSERT allows here;
  // this migration doesn't touch state so it's irrelevant to what's tested).
  return `
    INSERT INTO addon_installations (
      id, tenant, addon_key, installed_version, publisher, trust_class,
      manifest_sha256, mupot_compatibility, state, latest_previous_state,
      installed_by, latest_actor_id, latest_receipt_id, installed_at, updated_at
    ) VALUES (
      '${row.id}', '${row.tenant}', '${row.addonKey}', '1.0.0', 'mumega', 'native_reviewed',
      '${row.digest}', '${row.compat}', 'installed', NULL,
      'agent-x', 'agent-x', 'rcpt-${row.id}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    );
    INSERT INTO addon_receipts (
      id, tenant, installation_id, action, previous_state, next_state,
      addon_key, installed_version, publisher, trust_class,
      mupot_compatibility, manifest_sha256, actor_id, outcome,
      side_effect_ids, checks, created_at
    ) VALUES (
      'rcpt-${row.id}', '${row.tenant}', '${row.id}', 'install', NULL, 'installed',
      '${row.addonKey}', '1.0.0', 'mumega', 'native_reviewed',
      '${row.compat}', '${row.digest}', 'agent-x', 'pass',
      '[]', '{}', '2026-01-01T00:00:00Z'
    );`
}

// Prod-shaped fixture: the two drifted rows this migration must fix, plus
// three control rows that must NOT be touched — wrong addon_key, wrong
// tenant, and an addon already past ^0.24.0 (proves the guard doesn't
// clobber unexpected state, per the brief's explicit warning).
function buildSeededDb() {
  const { sqlite, close } = createSqliteD1()
  for (const file of priorMigrations()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }

  // addon_installations.latest_receipt_id -> addon_receipts is a DEFERRABLE
  // INITIALLY DEFERRED FK. node:sqlite's exec() autocommits each statement
  // that isn't inside an explicit BEGIN/COMMIT, so without wrapping this in
  // one transaction the deferred check fires (and fails) right after the
  // installation row is inserted, before its receipt row exists.
  applyInTransaction(sqlite, [
    seedRow({ id: 'inst-cro', tenant: 'mumega', addonKey: 'marketing-cro-monitor', compat: OLD_COMPAT, digest: '0'.repeat(64) }),
    seedRow({ id: 'inst-link', tenant: 'mumega', addonKey: 'project-link', compat: OLD_COMPAT, digest: '1'.repeat(64) }),
    seedRow({ id: 'inst-wrong-addon', tenant: 'mumega', addonKey: 'workflow-circuits', compat: OLD_COMPAT, digest: '2'.repeat(64) }),
    seedRow({ id: 'inst-wrong-tenant', tenant: 'other-tenant', addonKey: 'marketing-cro-monitor', compat: OLD_COMPAT, digest: '3'.repeat(64) }),
    seedRow({ id: 'inst-ahead-compat', tenant: 'mumega-staging', addonKey: 'project-link', compat: '^0.30.0', digest: '4'.repeat(64) }),
  ].join('\n'))

  return { sqlite, close }
}

function rows(sqlite: { prepare(sql: string): { all(): unknown[] } }): InstallationRow[] {
  return sqlite.prepare('SELECT id, tenant, addon_key, mupot_compatibility, manifest_sha256 FROM addon_installations ORDER BY id').all() as InstallationRow[]
}

function rowById(list: InstallationRow[], id: string): InstallationRow {
  const row = list.find((r) => r.id === id)
  if (!row) throw new Error(`missing row ${id}`)
  return row
}

describe('0089_backfill_addon_manifest_v0_29 — digest constants (load-bearing)', () => {
  it('the migration file\'s hardcoded digests equal manifestSha256() of the registered v0.29.0 manifests', async () => {
    const cro = getRegisteredAddon('marketing-cro-monitor')
    const link = getRegisteredAddon('project-link')
    if (!cro || !link) throw new Error('expected addons are not registered')

    expect(cro.manifest.mupotCompatibility).toBe(NEW_COMPAT)
    expect(link.manifest.mupotCompatibility).toBe(NEW_COMPAT)

    expect(await manifestSha256(cro.manifest)).toBe(CRO_DIGEST)
    expect(await manifestSha256(link.manifest)).toBe(LINK_DIGEST)

    // Machine-check the constants actually embedded in the migration file
    // text, not just the copies duplicated into this test — catches a typo
    // introduced in one place and not the other.
    expect(MIGRATION_SQL).toContain(`'${CRO_DIGEST}'`)
    expect(MIGRATION_SQL).toContain(`'${LINK_DIGEST}'`)
  })
})

describe('0089_backfill_addon_manifest_v0_29 — idempotence', () => {
  it('applying the migration twice changes nothing the second time', () => {
    const { sqlite, close } = buildSeededDb()
    try {
      applyInTransaction(sqlite, MIGRATION_SQL)
      const afterFirst = rows(sqlite)

      applyInTransaction(sqlite, MIGRATION_SQL)
      const afterSecond = rows(sqlite)

      expect(afterSecond).toEqual(afterFirst)
      expect(rowById(afterSecond, 'inst-cro').mupot_compatibility).toBe(NEW_COMPAT)
      expect(rowById(afterSecond, 'inst-link').mupot_compatibility).toBe(NEW_COMPAT)
    } finally {
      close()
    }
  })
})

describe('0089_backfill_addon_manifest_v0_29 — WHERE guard', () => {
  it('touches only the two intended (tenant, addon_key, ^0.24.0) rows', () => {
    const { sqlite, close } = buildSeededDb()
    try {
      applyInTransaction(sqlite, MIGRATION_SQL)
      const after = rows(sqlite)

      expect(rowById(after, 'inst-cro').mupot_compatibility).toBe(NEW_COMPAT)
      expect(rowById(after, 'inst-cro').manifest_sha256).toBe(CRO_DIGEST)
      expect(rowById(after, 'inst-link').mupot_compatibility).toBe(NEW_COMPAT)
      expect(rowById(after, 'inst-link').manifest_sha256).toBe(LINK_DIGEST)

      // wrong addon_key: not in the migration's IN-list equivalent (two
      // separate WHERE addon_key = ... clauses)
      expect(rowById(after, 'inst-wrong-addon').mupot_compatibility).toBe(OLD_COMPAT)
      expect(rowById(after, 'inst-wrong-addon').manifest_sha256).toBe('2'.repeat(64))

      // wrong tenant: same addon_key as inst-cro, different tenant
      expect(rowById(after, 'inst-wrong-tenant').mupot_compatibility).toBe(OLD_COMPAT)
      expect(rowById(after, 'inst-wrong-tenant').manifest_sha256).toBe('3'.repeat(64))

      // already past ^0.24.0: guard must not clobber unexpected state
      expect(rowById(after, 'inst-ahead-compat').mupot_compatibility).toBe('^0.30.0')
      expect(rowById(after, 'inst-ahead-compat').manifest_sha256).toBe('4'.repeat(64))
    } finally {
      close()
    }
  })

  it('a row at a different mupot_compatibility is untouched even when tenant + addon_key match', () => {
    const { sqlite, close } = buildSeededDb()
    try {
      // Sanity precondition: inst-ahead-compat exists and starts at ^0.30.0.
      const before = rowById(rows(sqlite), 'inst-ahead-compat')
      expect(before.mupot_compatibility).toBe('^0.30.0')

      applyInTransaction(sqlite, MIGRATION_SQL)

      const after = rowById(rows(sqlite), 'inst-ahead-compat')
      expect(after).toEqual(before)
    } finally {
      close()
    }
  })
})

describe('0089_backfill_addon_manifest_v0_29 — the actual goal: freeze is lifted', () => {
  function installationFor(row: InstallationRow, extra: Partial<AddonInstallation> = {}): AddonInstallation {
    return {
      id: row.id,
      tenant: row.tenant,
      addonKey: row.addon_key,
      installedVersion: '1.0.0',
      publisher: 'mumega',
      trustClass: 'native_reviewed',
      manifestSha256: row.manifest_sha256,
      mupotCompatibility: row.mupot_compatibility,
      state: 'installed',
      latestPreviousState: null,
      installedBy: 'agent-x',
      latestActorId: 'agent-x',
      latestReceiptId: `rcpt-${row.id}`,
      installedAt: '2026-01-01T00:00:00Z',
      configuredAt: null,
      activatedAt: null,
      disabledAt: null,
      archivedAt: null,
      updatedAt: '2026-01-01T00:00:00Z',
      lastError: null,
      ...extra,
    }
  }

  it('matchesRegisteredIdentity() is false before the migration (the drift is real) and true after (the freeze is lifted)', () => {
    const { sqlite, close } = buildSeededDb()
    try {
      const croEntry = getRegisteredAddon('marketing-cro-monitor')
      const linkEntry = getRegisteredAddon('project-link')
      if (!croEntry || !linkEntry) throw new Error('expected addons are not registered')

      const beforeRows = rows(sqlite)
      expect(matchesRegisteredIdentity(installationFor(rowById(beforeRows, 'inst-cro')), croEntry)).toBe(false)
      expect(matchesRegisteredIdentity(installationFor(rowById(beforeRows, 'inst-link')), linkEntry)).toBe(false)

      applyInTransaction(sqlite, MIGRATION_SQL)

      const afterRows = rows(sqlite)
      expect(matchesRegisteredIdentity(installationFor(rowById(afterRows, 'inst-cro')), croEntry)).toBe(true)
      expect(matchesRegisteredIdentity(installationFor(rowById(afterRows, 'inst-link')), linkEntry)).toBe(true)
    } finally {
      close()
    }
  })
})

describe('0089_backfill_addon_manifest_v0_29 — identity-immutable trigger survives the repair', () => {
  it('a plain UPDATE of manifest_sha256/mupot_compatibility is rejected again after the migration commits', () => {
    const { sqlite, close } = buildSeededDb()
    try {
      applyInTransaction(sqlite, MIGRATION_SQL)

      expect(() => sqlite.exec(
        `UPDATE addon_installations SET mupot_compatibility = '^99.0.0' WHERE id = 'inst-cro'`,
      )).toThrow(/addon installation identity is immutable/)
      expect(() => sqlite.exec(
        `UPDATE addon_installations SET manifest_sha256 = '${'f'.repeat(64)}' WHERE id = 'inst-link'`,
      )).toThrow(/addon installation identity is immutable/)
    } finally {
      close()
    }
  })
})
