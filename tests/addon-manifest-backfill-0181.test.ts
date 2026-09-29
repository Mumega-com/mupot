import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'

// Every test in this file builds at least one full migration chain (~180
// files) against real sqlite; under this sandbox's variable I/O and
// concurrent-suite load that reliably exceeds the project's 15s default
// (observed 5s-40s for the identical operation across runs, not a hang).
// Raise the file's timeout rather than each `it` individually.
vi.setConfig({ testTimeout: 60_000 })
import { manifestSha256 } from '../src/addons/contract'
import { getRegisteredAddon } from '../src/addons/registry'
import { matchesRegisteredIdentity, type AddonInstallation } from '../src/addons/service'
import '../src/addons/modules/index'
import '../src/addons/modules/fixture-with-loop'

// 0181_backfill_addon_manifest_v0_30.sql repairs any live addon_installations
// rows left at an OLD manifest identity after the v0.31.0 version bump moved
// MUPOT_PUBLIC_API_VERSION 0.30.0 -> 0.31.0. Five native manifests moved
// ^0.29.0 -> ^0.30.0; mcpwp-office's manifest derives its compat string from
// the live constant directly, so it moved ^0.30.0 -> ^0.31.0 in the same PR.
// See the migration file's header for full context, and
// tests/addon-manifest-backfill-0089.test.ts for the prior (^0.24.0 ->
// ^0.29.0) precedent this mirrors.
//
// This suite proves, against real sqlite (not a mock) and the repo's OWN
// manifestSha256()/matchesRegisteredIdentity() — not reimplementations of
// them — that:
//   1. the migration's hardcoded digest constants are what manifestSha256()
//      actually produces for each addon's OLD and NEW manifest identity;
//   2. the recreated trigger is byte-identical to what sqlite_master itself
//      recorded for it immediately after 0178 — not a hand-typed copy
//      comparison, so a transcription slip cannot pass silently;
//   3. the migration is idempotent;
//   4. its WHERE guard is addon_key AND the exact OLD manifest_sha256 AND
//      the exact OLD mupot_compatibility together — a row whose addon_key
//      and compat match but whose digest is anything else (an unexpected
//      identity) is left untouched and surfaced, never silently blessed;
//   5. it behaves correctly on a populated DB applied inside one
//      BEGIN/COMMIT, matching `wrangler d1 migrations apply` semantics;
//   6. matchesRegisteredIdentity() flips from false to true for every
//      affected installation, including mcpwp-office;
//   7. addon_receipts stay consistent with their installation after the
//      backfill — a receipt insert using the NEW identity succeeds, one
//      using the stale OLD identity is rejected by
//      addon_receipts_snapshot_matches_installation;
//   8. the identity-immutable trigger the migration has to DROP mid-file to
//      perform the repair is restored and still enforcing afterward.

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TARGET_MIGRATION = '0181_backfill_addon_manifest_v0_30.sql'
const MIGRATION_SQL = readFileSync(join(MIGRATIONS_DIR, TARGET_MIGRATION), 'utf8')
const TRIGGER_NAME = 'addon_installations_identity_is_immutable'

interface AddonFixture {
  key: string
  oldCompat: string
  newCompat: string
  oldDigest: string
  newDigest: string
}

// Old/new digest pairs, each independently computed via manifestSha256()
// against this branch's registered manifests (see the migration file header
// for how — a throwaway vitest run, never hand-typed).
const ADDONS: AddonFixture[] = [
  {
    key: 'marketing-cro-monitor',
    oldCompat: '^0.29.0',
    newCompat: '^0.30.0',
    oldDigest: '6834802d7cc92f56c49f29a59432d514ccfd116af06b7dbd36aa66d18ae028ed',
    newDigest: '7c6081a3debd40846c4c724110917c1c2685ebe315f081e9d73b2ad258225c6a',
  },
  {
    key: 'project-link',
    oldCompat: '^0.29.0',
    newCompat: '^0.30.0',
    oldDigest: '41568a456cd69bc49b49ff9d873447ac110f1aa6f92869ea5c164c86b2dcc2b0',
    newDigest: '139f17b91d4ce39b23f510c4006826d3ddfa95e11c13d30ba528bcb36e8dd629',
  },
  {
    key: 'workflow-circuits',
    oldCompat: '^0.29.0',
    newCompat: '^0.30.0',
    oldDigest: '133be3834dbf88f97d8b4c61666482cbd2cfa8f8d3bb52cad965fe0c4fcba5bb',
    newDigest: '3e7e7084eb77f6cc8f27f93d3370294c1ed6d399a674acc1a8d272053f0dd661',
  },
  {
    key: 'fixture-addon',
    oldCompat: '^0.29.0',
    newCompat: '^0.30.0',
    oldDigest: 'aeb4e6b4655b8ba14534cf73149a62a97fb8a9eb15da12e63c765f114eeb759c',
    newDigest: '5dc890ecb8ad0f17ca934f4862d80974af2a8fd1f3f8d89469085d1433376cea',
  },
  {
    key: 'fixture-addon-with-loop',
    oldCompat: '^0.29.0',
    newCompat: '^0.30.0',
    oldDigest: '7bac7713f24b7ca53fc76840c105070ace3caa36f6fa04986be6f001bc919c12',
    newDigest: '747d860766a47f0788eca7e130d72f73e2fcee08e5f4f858199fd766203307d3',
  },
  {
    key: 'mcpwp-office',
    oldCompat: '^0.30.0',
    newCompat: '^0.31.0',
    oldDigest: '5821d637d3c3cadcf2f0ade81d66cabd644d4788c0e6e94fe9e6409f631f3b28',
    newDigest: '9ee9eb05c9a5a469e67e88e98aca68b0654448f539dcb3744eb48c090139c84f',
  },
]

function priorMigrations(upTo?: string): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql') && (upTo ? name <= upTo : name < TARGET_MIGRATION))
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

function buildDbThrough(migrationFile: string) {
  const { sqlite, close } = createSqliteD1()
  for (const file of priorMigrations(migrationFile)) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  return { sqlite, close }
}

function triggerSql(sqlite: { prepare(sql: string): { get(...args: unknown[]): unknown } }, name: string): string {
  const row = sqlite
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`)
    .get(name) as { sql: string } | undefined
  if (!row) throw new Error(`trigger not found: ${name}`)
  return row.sql
}

interface InstallationRow {
  id: string
  tenant: string
  addon_key: string
  mupot_compatibility: string
  manifest_sha256: string
}

function seedRow(row: { id: string; tenant: string; addonKey: string; compat: string; digest: string; isolationClass?: string }) {
  const isolationClass = row.isolationClass ?? 'native_reviewed'
  return `
    INSERT INTO addon_installations (
      id, tenant, addon_key, installed_version, publisher, trust_class,
      manifest_sha256, mupot_compatibility, isolation_class, state, latest_previous_state,
      installed_by, latest_actor_id, latest_receipt_id, installed_at, updated_at
    ) VALUES (
      '${row.id}', '${row.tenant}', '${row.addonKey}', '1.0.0', 'mumega', 'native_reviewed',
      '${row.digest}', '${row.compat}', '${isolationClass}', 'installed', NULL,
      'agent-x', 'agent-x', 'rcpt-${row.id}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    );
    INSERT INTO addon_receipts (
      id, tenant, installation_id, action, previous_state, next_state,
      addon_key, installed_version, publisher, trust_class,
      mupot_compatibility, manifest_sha256, isolation_class, actor_id, outcome,
      side_effect_ids, checks, created_at
    ) VALUES (
      'rcpt-${row.id}', '${row.tenant}', '${row.id}', 'install', NULL, 'installed',
      '${row.addonKey}', '1.0.0', 'mumega', 'native_reviewed',
      '${row.compat}', '${row.digest}', '${isolationClass}', 'agent-x', 'pass',
      '[]', '{}', '2026-01-01T00:00:00Z'
    );`
}

// Prod-shaped fixture, populated across every affected addon plus three
// controls that must NOT change: a wrong addon_key, a row already at the new
// identity, and — the case item (a)'s tightened guard exists for — a row
// whose addon_key + compat match an affected addon but whose digest is
// neither old nor new (an unexpected identity: hand edit, corruption, a
// version this migration doesn't know about).
function buildSeededDb() {
  const { sqlite, close } = buildDbThrough('0180_seat_events_route_precheck.sql')

  const rows = [
    seedRow({ id: 'inst-cro', tenant: 'mumega', addonKey: 'marketing-cro-monitor', compat: ADDONS[0].oldCompat, digest: ADDONS[0].oldDigest }),
    seedRow({ id: 'inst-link', tenant: 'other-tenant', addonKey: 'project-link', compat: ADDONS[1].oldCompat, digest: ADDONS[1].oldDigest }),
    seedRow({ id: 'inst-wfc', tenant: 'mumega', addonKey: 'workflow-circuits', compat: ADDONS[2].oldCompat, digest: ADDONS[2].oldDigest }),
    seedRow({ id: 'inst-fixture', tenant: 'mumega-staging', addonKey: 'fixture-addon', compat: ADDONS[3].oldCompat, digest: ADDONS[3].oldDigest }),
    seedRow({ id: 'inst-fixture-loop', tenant: 'mumega', addonKey: 'fixture-addon-with-loop', compat: ADDONS[4].oldCompat, digest: ADDONS[4].oldDigest }),
    seedRow({ id: 'inst-office', tenant: 'mumega', addonKey: 'mcpwp-office', compat: ADDONS[5].oldCompat, digest: ADDONS[5].oldDigest, isolationClass: 'external_isolated' }),
    // Control: wrong addon_key entirely.
    seedRow({ id: 'inst-wrong-addon', tenant: 'mumega-wrongaddon', addonKey: 'some-unaffected-addon', compat: '^0.24.0', digest: '5'.repeat(64) }),
    // Control: already at the new identity — guard must not clobber it.
    seedRow({ id: 'inst-ahead', tenant: 'mumega-ahead', addonKey: 'project-link', compat: '^0.31.0', digest: '6'.repeat(64) }),
    // Control (item a): addon_key + compat match project-link's OLD compat,
    // but the digest is neither the old nor the new one — an unexpected
    // identity the tightened guard must leave alone and surface, not bless.
    seedRow({ id: 'inst-unexpected-digest', tenant: 'mumega-anomaly', addonKey: 'project-link', compat: ADDONS[1].oldCompat, digest: '7'.repeat(64) }),
  ].join('\n')

  applyInTransaction(sqlite, rows)

  return { sqlite, close }
}

function rows(sqlite: { prepare(sql: string): { all(): unknown[] } }): InstallationRow[] {
  return sqlite
    .prepare('SELECT id, tenant, addon_key, mupot_compatibility, manifest_sha256 FROM addon_installations ORDER BY id')
    .all() as InstallationRow[]
}

function rowById(list: InstallationRow[], id: string): InstallationRow {
  const row = list.find((r) => r.id === id)
  if (!row) throw new Error(`missing row ${id}`)
  return row
}

describe('0181_backfill_addon_manifest_v0_30 — digest constants (load-bearing)', () => {
  it('the migration file\'s hardcoded NEW digests equal manifestSha256() of the registered manifests', async () => {
    for (const { key, newCompat, newDigest } of ADDONS) {
      const entry = getRegisteredAddon(key)
      if (!entry) throw new Error(`expected addon not registered: ${key}`)
      expect(entry.manifest.mupotCompatibility).toBe(newCompat)
      expect(await manifestSha256(entry.manifest)).toBe(newDigest)
      expect(MIGRATION_SQL).toContain(`'${newDigest}'`)
    }
  })

  it('the migration file\'s hardcoded OLD digests equal manifestSha256() of each manifest at its prior compat', async () => {
    for (const { key, oldCompat, oldDigest } of ADDONS) {
      const entry = getRegisteredAddon(key)
      if (!entry) throw new Error(`expected addon not registered: ${key}`)
      // Every field besides mupotCompatibility is unchanged since the prior
      // version — this test would fail loudly the moment that stops being
      // true, same discipline as addon-manifest-backfill-0089's asOfV0290.
      const asOfOld = { ...entry.manifest, mupotCompatibility: oldCompat }
      expect(await manifestSha256(asOfOld)).toBe(oldDigest)
      expect(MIGRATION_SQL).toContain(`'${oldDigest}'`)
    }
  })
})

describe('0181_backfill_addon_manifest_v0_30 — trigger recreated byte-identical to sqlite_master (not a hand copy)', () => {
  it('the trigger body after 0181 is byte-identical to what sqlite_master recorded immediately after 0178', () => {
    // Two full migration-chain builds (one through 0178, one through 0180 +
    // this migration) — reliably slower than the single-build tests above
    // under this suite's concurrent load; the default 15s timeout is too
    // tight even though nothing here is actually stuck.
    const after0178 = buildDbThrough('0178_addon_isolation_class_immutable.sql')
    let expectedSql: string
    try {
      expectedSql = triggerSql(after0178.sqlite, TRIGGER_NAME)
    } finally {
      after0178.close()
    }

    const { sqlite, close } = buildSeededDb()
    try {
      applyInTransaction(sqlite, MIGRATION_SQL)
      const actualSql = triggerSql(sqlite, TRIGGER_NAME)
      expect(actualSql).toBe(expectedSql)
    } finally {
      close()
    }
  })
})

describe('0181_backfill_addon_manifest_v0_30 — idempotence', () => {
  it('applying the migration twice changes nothing the second time', () => {
    const { sqlite, close } = buildSeededDb()
    try {
      applyInTransaction(sqlite, MIGRATION_SQL)
      const afterFirst = rows(sqlite)

      applyInTransaction(sqlite, MIGRATION_SQL)
      const afterSecond = rows(sqlite)

      expect(afterSecond).toEqual(afterFirst)
      for (const { key, newCompat } of ADDONS) {
        const id = { 'marketing-cro-monitor': 'inst-cro', 'project-link': 'inst-link', 'workflow-circuits': 'inst-wfc', 'fixture-addon': 'inst-fixture', 'fixture-addon-with-loop': 'inst-fixture-loop', 'mcpwp-office': 'inst-office' }[key]!
        expect(rowById(afterSecond, id).mupot_compatibility).toBe(newCompat)
      }
    } finally {
      close()
    }
  })
})

describe('0181_backfill_addon_manifest_v0_30 — WHERE guard (populated DB, one BEGIN/COMMIT, D1 semantics)', () => {
  it('touches only rows at exactly the old identity, across any tenant, applied inside one transaction', () => {
    const { sqlite, close } = buildSeededDb()
    try {
      applyInTransaction(sqlite, MIGRATION_SQL)
      const after = rows(sqlite)

      const targets: Record<string, { compat: string; digest: string }> = {
        'inst-cro': { compat: ADDONS[0].newCompat, digest: ADDONS[0].newDigest },
        'inst-link': { compat: ADDONS[1].newCompat, digest: ADDONS[1].newDigest },
        'inst-wfc': { compat: ADDONS[2].newCompat, digest: ADDONS[2].newDigest },
        'inst-fixture': { compat: ADDONS[3].newCompat, digest: ADDONS[3].newDigest },
        'inst-fixture-loop': { compat: ADDONS[4].newCompat, digest: ADDONS[4].newDigest },
        'inst-office': { compat: ADDONS[5].newCompat, digest: ADDONS[5].newDigest },
      }
      for (const [id, expected] of Object.entries(targets)) {
        expect(rowById(after, id).mupot_compatibility).toBe(expected.compat)
        expect(rowById(after, id).manifest_sha256).toBe(expected.digest)
      }

      // wrong addon_key/compat combination: not in any per-addon WHERE clause
      expect(rowById(after, 'inst-wrong-addon').mupot_compatibility).toBe('^0.24.0')
      expect(rowById(after, 'inst-wrong-addon').manifest_sha256).toBe('5'.repeat(64))

      // already at the new identity: guard must not clobber unexpected state
      expect(rowById(after, 'inst-ahead').mupot_compatibility).toBe('^0.31.0')
      expect(rowById(after, 'inst-ahead').manifest_sha256).toBe('6'.repeat(64))

      // item (a): addon_key + compat match, digest does not — left untouched
      // and surfaced (still matchesRegisteredIdentity()=false), never blessed
      expect(rowById(after, 'inst-unexpected-digest').mupot_compatibility).toBe(ADDONS[1].oldCompat)
      expect(rowById(after, 'inst-unexpected-digest').manifest_sha256).toBe('7'.repeat(64))
    } finally {
      close()
    }
  })

  it('a row at a different mupot_compatibility, or a matching-compat-but-wrong-digest row, is untouched even when addon_key matches', () => {
    const { sqlite, close } = buildSeededDb()
    try {
      const beforeAhead = rowById(rows(sqlite), 'inst-ahead')
      const beforeUnexpected = rowById(rows(sqlite), 'inst-unexpected-digest')

      applyInTransaction(sqlite, MIGRATION_SQL)

      expect(rowById(rows(sqlite), 'inst-ahead')).toEqual(beforeAhead)
      expect(rowById(rows(sqlite), 'inst-unexpected-digest')).toEqual(beforeUnexpected)
    } finally {
      close()
    }
  })
})

describe('0181_backfill_addon_manifest_v0_30 — the actual goal: freeze is lifted', () => {
  function installationFor(row: InstallationRow, extra: Partial<AddonInstallation> = {}): AddonInstallation {
    return {
      id: row.id,
      tenant: row.tenant,
      addonKey: row.addon_key,
      installedVersion: '1.0.0',
      publisher: 'mumega',
      trustClass: row.addon_key === 'mcpwp-office' ? 'external_isolated' : 'native_reviewed',
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

  const IDS: Record<string, string> = {
    'marketing-cro-monitor': 'inst-cro',
    'project-link': 'inst-link',
    'workflow-circuits': 'inst-wfc',
    'fixture-addon': 'inst-fixture',
    'fixture-addon-with-loop': 'inst-fixture-loop',
    'mcpwp-office': 'inst-office',
  }

  it('matchesRegisteredIdentity() is false before the migration and true after, for every affected installation including mcpwp-office', () => {
    const { sqlite, close } = buildSeededDb()
    try {
      const entries = new Map(ADDONS.map(({ key }) => [key, getRegisteredAddon(key)]))
      for (const [key, entry] of entries) {
        if (!entry) throw new Error(`expected addon not registered: ${key}`)
      }

      const beforeRows = rows(sqlite)
      for (const [key, id] of Object.entries(IDS)) {
        const row = rowById(beforeRows, id)
        const entry = entries.get(key)
        if (!entry) throw new Error(`no registry entry for ${key}`)
        expect(matchesRegisteredIdentity(installationFor(row), entry)).toBe(false)
      }

      applyInTransaction(sqlite, MIGRATION_SQL)

      const afterRows = rows(sqlite)
      for (const [key, id] of Object.entries(IDS)) {
        const row = rowById(afterRows, id)
        const entry = entries.get(key)
        if (!entry) throw new Error(`no registry entry for ${key}`)
        expect(matchesRegisteredIdentity(installationFor(row), entry)).toBe(true)
      }
    } finally {
      close()
    }
  })
})

describe('0181_backfill_addon_manifest_v0_30 — addon_receipts stay consistent with the repaired installation', () => {
  it('a new receipt using the NEW identity is accepted; one using the stale OLD identity is rejected', () => {
    const { sqlite, close } = buildSeededDb()
    try {
      applyInTransaction(sqlite, MIGRATION_SQL)

      const now = '2026-09-29T00:00:00Z'
      // outcome='fail' (not 'pass') deliberately keeps this isolated to
      // addon_receipts_snapshot_matches_installation: the OTHER identity
      // trigger on this table, addon_transition_receipts_match_installation
      // (0050_addons.sql), only fires WHEN NEW.outcome = 'pass', and it
      // additionally requires the installation's latest_receipt_id/
      // latest_actor_id/state/latest_previous_state to already point at
      // THIS receipt — a real state-machine invariant unrelated to what
      // this migration touches. A real caller (configureAddon() etc.)
      // updates the installation row and inserts its receipt together, in
      // one transaction; a bare INSERT here only needs to prove the
      // SNAPSHOT trigger — manifest identity consistency — survives 0181.
      //
      // New identity: matches the just-repaired installation row — the
      // addon_receipts_snapshot_matches_installation trigger must accept it.
      expect(() =>
        sqlite.exec(`
          INSERT INTO addon_receipts (
            id, tenant, installation_id, action, previous_state, next_state,
            addon_key, installed_version, publisher, trust_class,
            mupot_compatibility, manifest_sha256, isolation_class, actor_id, outcome,
            side_effect_ids, checks, created_at
          ) VALUES (
            'rcpt-post-0181-ok', 'mumega', 'inst-cro', 'configure', 'installed', 'configured',
            'marketing-cro-monitor', '1.0.0', 'mumega', 'native_reviewed',
            '${ADDONS[0].newCompat}', '${ADDONS[0].newDigest}', 'native_reviewed', 'agent-x', 'fail',
            '[]', '{}', '${now}'
          );
        `),
      ).not.toThrow()

      // Stale identity: the OLD compat/digest this migration just moved the
      // installation away from — the trigger must refuse it as a mismatch.
      expect(() =>
        sqlite.exec(`
          INSERT INTO addon_receipts (
            id, tenant, installation_id, action, previous_state, next_state,
            addon_key, installed_version, publisher, trust_class,
            mupot_compatibility, manifest_sha256, isolation_class, actor_id, outcome,
            side_effect_ids, checks, created_at
          ) VALUES (
            'rcpt-post-0181-stale', 'mumega', 'inst-cro', 'configure', 'installed', 'configured',
            'marketing-cro-monitor', '1.0.0', 'mumega', 'native_reviewed',
            '${ADDONS[0].oldCompat}', '${ADDONS[0].oldDigest}', 'native_reviewed', 'agent-x', 'fail',
            '[]', '{}', '${now}'
          );
        `),
      ).toThrow(/addon receipt identity does not match installation/)
    } finally {
      close()
    }
  })
})

describe('0181_backfill_addon_manifest_v0_30 — identity-immutable trigger survives the repair', () => {
  it('a plain UPDATE of manifest_sha256/mupot_compatibility/isolation_class is rejected again after the migration commits', () => {
    const { sqlite, close } = buildSeededDb()
    try {
      applyInTransaction(sqlite, MIGRATION_SQL)

      expect(() =>
        sqlite.exec(`UPDATE addon_installations SET mupot_compatibility = '^99.0.0' WHERE id = 'inst-cro'`),
      ).toThrow(/addon installation identity is immutable/)
      expect(() =>
        sqlite.exec(
          `UPDATE addon_installations SET manifest_sha256 = '${'f'.repeat(64)}' WHERE id = 'inst-link'`,
        ),
      ).toThrow(/addon installation identity is immutable/)
      expect(() =>
        sqlite.exec(`UPDATE addon_installations SET isolation_class = 'native_reviewed' WHERE id = 'inst-office'`),
      ).toThrow(/addon installation identity is immutable/)
    } finally {
      close()
    }
  })
})
