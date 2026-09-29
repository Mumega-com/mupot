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
import {
  activateAddon,
  configureAddon,
  disableAddon,
  installAddon,
  matchesRegisteredIdentity,
  type AddonInstallation,
} from '../src/addons/service'
import { runMarketingMonitor } from '../src/addons/marketing/service'
import { createMarketingMonitorFixtureSource } from './fixtures/marketing-monitor'
import type { Env } from '../src/types'
import '../src/addons/modules/index'
import '../src/addons/modules/fixture-with-loop'

// 0181_backfill_addon_manifest_v0_31.sql repairs any live addon_installations
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
//   2. all three recreated triggers are byte-identical to what
//      sqlite_master itself recorded for them beforehand — not a
//      hand-typed copy comparison, so a transcription slip cannot pass
//      silently;
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
//   8. all three triggers the migration has to DROP mid-file to perform the
//      repair are restored and still enforcing afterward;
//   9. (round-1 P0) a live addon_binding_generations/addon_connector_bindings
//      row heals to match its parent installation, INCLUDING a pre-existing
//      split where the generation was already at neither the old nor the
//      new digest (prod's real marketing-cro-monitor state) — built through
//      the REAL installAddon/configureAddon/activateAddon/disableAddon/
//      runMarketingMonitor lifecycle, not hand-written INSERTs, so every
//      trigger-enforced invariant on those tables is satisfied the same way
//      production satisfies it. After migrating, the real
//      runMarketingMonitor and activateAddon calls succeed with the CURRENT
//      code — assertions on migration output alone are not enough.

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TARGET_MIGRATION = '0181_backfill_addon_manifest_v0_31.sql'
const MIGRATION_SQL = readFileSync(join(MIGRATIONS_DIR, TARGET_MIGRATION), 'utf8')
const TRIGGER_NAMES = [
  'addon_installations_identity_is_immutable',
  'addon_binding_generations_revoke_only',
  'addon_connector_bindings_revoke_only',
] as const

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

// r2 P3-3 (kasra-review adversarial gate on #1614): the FIRST version of the
// four real-lifecycle tests below built through 0184 (so their OWN setup
// configureAddon/activateAddon calls — which need addon_connector_bindings.
// capability_v2 to exist — would work) and THEN re-applied 0181's raw SQL a
// second time as the "real" migration event under test. 0181's own SQL
// unconditionally does `DROP TRIGGER IF EXISTS addon_connector_bindings_
// revoke_only; CREATE TRIGGER ... (its OWN, pre-0184 body)` — reapplying it
// AFTER 0184 had already widened that trigger silently REVERTED the widening,
// leaving a schema no real deploy ever produces (capability_v2 column present,
// but NOT protected by the live trigger) for the remainder of each test.
//
// Fix: split 0184 into its two independent statements — the ADD COLUMN (which
// must exist BEFORE setup runs, and is never touched again) and the trigger
// DROP+CREATE (which must run AFTER 0181's own re-application, to end at the
// REAL final shape: 0181 then 0184, in that order, exactly like a real
// deploy). Applying the ALTER once, then 0181, then the trigger recreation, is
// row/statement-for-statement identical to running the real chain
// (...0181, 0184) against a database that already had capability_v2 forced in
// early purely so setup can use it — the ALTER itself is a complete no-op the
// second the column already exists, so it is never reapplied.
const MIGRATION_0184_FULL_SQL = readFileSync(
  join(MIGRATIONS_DIR, '0184_addon_connector_bindings_write_capability.sql'), 'utf8',
)
const MIGRATION_0184_TRIGGER_BOUNDARY = 'DROP TRIGGER IF EXISTS addon_connector_bindings_revoke_only;'
const MIGRATION_0184_TRIGGER_BOUNDARY_INDEX = MIGRATION_0184_FULL_SQL.indexOf(MIGRATION_0184_TRIGGER_BOUNDARY)
if (MIGRATION_0184_TRIGGER_BOUNDARY_INDEX === -1) {
  throw new Error('0184 migration no longer contains the expected trigger boundary — update this split')
}
const MIGRATION_0184_ALTER_SQL = MIGRATION_0184_FULL_SQL.slice(0, MIGRATION_0184_TRIGGER_BOUNDARY_INDEX)
const MIGRATION_0184_TRIGGER_SQL = MIGRATION_0184_FULL_SQL.slice(MIGRATION_0184_TRIGGER_BOUNDARY_INDEX)

function buildDbThrough(migrationFile: string) {
  const harness = createSqliteD1()
  for (const file of priorMigrations(migrationFile)) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  return harness
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

describe('0181_backfill_addon_manifest_v0_31 — digest constants (load-bearing)', () => {
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

describe('0181_backfill_addon_manifest_v0_31 — all three recreated triggers are byte-identical to sqlite_master (not a hand copy)', () => {
  it('every trigger body after 0181 is byte-identical to what sqlite_master recorded for it beforehand', () => {
    // Two full migration-chain builds (one through 0180, the baseline every
    // one of these three triggers already has by then — the installation
    // trigger as 0178 left it, the two binding/generation triggers exactly
    // as 0052 defined them, untouched by anything in between — and one
    // through 0180 + this migration) — reliably slower than the
    // single-build tests above under this suite's concurrent load; the
    // default 15s timeout is too tight even though nothing here is stuck.
    const before = buildDbThrough('0180_seat_events_route_precheck.sql')
    const expectedSql = new Map<string, string>()
    try {
      for (const name of TRIGGER_NAMES) expectedSql.set(name, triggerSql(before.sqlite, name))
    } finally {
      before.close()
    }

    const { sqlite, close } = buildSeededDb()
    try {
      applyInTransaction(sqlite, MIGRATION_SQL)
      for (const name of TRIGGER_NAMES) {
        expect(triggerSql(sqlite, name)).toBe(expectedSql.get(name))
      }
    } finally {
      close()
    }
  })
})

describe('0181_backfill_addon_manifest_v0_31 — idempotence', () => {
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

describe('0181_backfill_addon_manifest_v0_31 — WHERE guard (populated DB, one BEGIN/COMMIT, D1 semantics)', () => {
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

describe('0181_backfill_addon_manifest_v0_31 — the actual goal: freeze is lifted', () => {
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

describe('0181_backfill_addon_manifest_v0_31 — addon_receipts stay consistent with the repaired installation', () => {
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

describe('0181_backfill_addon_manifest_v0_31 — identity-immutable trigger survives the repair', () => {
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

// ============================================================================
// Round-1 P0: live addon_binding_generations / addon_connector_bindings
// heal too, proven through the REAL lifecycle (not hand-written INSERTs).
// ============================================================================
//
// Every row below is written by the actual installAddon/configureAddon/
// activateAddon/disableAddon/runMarketingMonitor functions against a real,
// fully-migrated sqlite D1, so every trigger-enforced invariant on
// addon_installations, addon_binding_generations, addon_connector_bindings,
// addon_receipts and marketing_monitor_runs is satisfied exactly the way
// production satisfies it — the class of risk a hand-rolled INSERT cannot
// rule out for itself. `downgradeIdentity` then time-travels ONLY the
// identity columns (manifest_sha256, mupot_compatibility) backward, inside
// a DROP/mutate/CREATE-trigger transaction identical in shape to what 0181
// itself does, to represent "as this looked immediately before the version
// bump" — production's actual before/after is a code deploy, never a SQL
// statement; this is test scaffolding to reach that state, not a claim that
// downgrading identity is itself a supported operation.

const lifecycleOwner = { id: 'owner-1', role: 'owner' as const }

function envForLifecycle(harness: { db: unknown }, tenant = 'mumega'): Env {
  return { DB: harness.db, TENANT_SLUG: tenant } as Env
}

function expectOk<T extends { ok: boolean }>(result: T, label: string): T {
  if (!result.ok) throw new Error(`${label} failed: ${JSON.stringify(result)}`)
  return result
}

// Byte-identical to what 0052_addon_bindings.sql defines and what the
// "all three recreated triggers" test above independently proves 0181
// restores — reused here only to let this scaffolding put the DB back into
// an enforcing state after a deliberate downgrade, not asserted on directly.
const RESTORE_BINDING_TRIGGERS_SQL = `
CREATE TRIGGER addon_binding_generations_revoke_only
  BEFORE UPDATE ON addon_binding_generations
  WHEN OLD.revoked_at IS NOT NULL
    OR NEW.revoked_at IS NULL
    OR length(NEW.revoked_at) <> 24
    OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.revoked_at) IS NOT NEW.revoked_at
    OR NEW.revoked_at < OLD.configured_at
    OR NEW.id IS NOT OLD.id
    OR NEW.tenant IS NOT OLD.tenant
    OR NEW.installation_id IS NOT OLD.installation_id
    OR NEW.configuration_sha256 IS NOT OLD.configuration_sha256
    OR NEW.binding_count IS NOT OLD.binding_count
    OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256
    OR NEW.configured_by IS NOT OLD.configured_by
    OR NEW.configured_at IS NOT OLD.configured_at
    OR NEW.previous_generation_id IS NOT OLD.previous_generation_id
    OR NEW.expected_installation_state IS NOT OLD.expected_installation_state
    OR NEW.base_receipt_id IS NOT OLD.base_receipt_id
BEGIN
  SELECT RAISE(ABORT, 'addon binding generations are append-only except revocation');
END;

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
    OR NEW.connector_id IS NOT OLD.connector_id
    OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256
    OR NEW.configured_by IS NOT OLD.configured_by
    OR NEW.configured_at IS NOT OLD.configured_at
BEGIN
  SELECT RAISE(ABORT, 'addon bindings are append-only except revocation');
END;
`

const RESTORE_INSTALLATION_TRIGGER_SQL = `
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
`

function downgradeIdentity(sqlite: { exec(sql: string): void }, mutate: () => void): void {
  sqlite.exec('BEGIN')
  try {
    sqlite.exec('DROP TRIGGER addon_installations_identity_is_immutable')
    sqlite.exec('DROP TRIGGER addon_binding_generations_revoke_only')
    sqlite.exec('DROP TRIGGER addon_connector_bindings_revoke_only')
    mutate()
    sqlite.exec(RESTORE_INSTALLATION_TRIGGER_SQL)
    sqlite.exec(RESTORE_BINDING_TRIGGERS_SQL)
    sqlite.exec('COMMIT')
  } catch (error) {
    sqlite.exec('ROLLBACK')
    throw error
  }
}

// A digest that is neither any addon's OLD nor NEW identity — stands in for
// prod's real, already-drifted marketing-cro-monitor generation
// (76369cbe970b…, per the adversarial review's live read), whose exact
// manifest content this repo has no way to reconstruct. The heal logic
// keys off "does this live row match its installation", not off any
// specific stale value, so an arbitrary-but-fixed placeholder proves the
// same thing prod's real value would.
const PRE_EXISTING_SPLIT_DIGEST = '76369cbe' + '0'.repeat(56)

interface LifecycleRow {
  id: string
  manifest_sha256: string
  mupot_compatibility?: string
}

function queryOne(
  sqlite: { prepare(sql: string): { get(...args: unknown[]): unknown } },
  sql: string,
  ...args: unknown[]
): LifecycleRow {
  const row = sqlite.prepare(sql).get(...args) as LifecycleRow | undefined
  if (!row) throw new Error(`query returned no row: ${sql}`)
  return row
}

describe('0181_backfill_addon_manifest_v0_31 — P0 fix: live generations and bindings heal through the real lifecycle', () => {
  // T2b (mupot#1580, migrations/0184), r2 P3-3 (kasra-review adversarial gate
  // on #1614): the FOUR tests below drive the REAL installAddon/configureAddon/
  // activateAddon lifecycle (this branch's CURRENT src/addons code — see this
  // file's own header, point 9: "the real ... lifecycle ... succeed with the
  // CURRENT code"), both to build their "before" fixture state and to prove the
  // "after" state works. src/addons/bindings.ts's listAddonBindings
  // unconditionally selects addon_connector_bindings.capability_v2 (added by
  // 0184) for EVERY addon's configure/activate call, not just write-capable
  // ones, so a DB frozen at 0180/0181 needs that column before ANY setup call
  // can run, regardless of which addon is being configured.
  //
  // Each test therefore: builds through 0180 (unchanged from every other test
  // in this file), applies ONLY 0184's ADD COLUMN statement (MIGRATION_0184_
  // ALTER_SQL, see that constant's own doc comment for why the trigger half is
  // deliberately NOT applied here), runs its setup + downgrade, re-applies
  // 0181 in full (MIGRATION_SQL — this is the migration actually under test),
  // and THEN applies 0184's trigger DROP+CREATE (MIGRATION_0184_TRIGGER_SQL) —
  // ending at the exact same final schema a real deploy reaches (0181, then
  // 0184, in that order), never at the earlier BLOCKED-and-BLOCKing state
  // (capability_v2 present but unprotected by the live trigger) re-running
  // 0181 alone after 0184 would silently produce. The digest/trigger-byte-
  // identity assertions earlier in this file (which DO care about the exact
  // pre/post-0181 boundary, before 0184 exists at all) are untouched by any of
  // this and still build through 0180 with no 0184 SQL applied at all.
  it('marketing-cro-monitor (active, live generation + binding + a completed run, PRE-EXISTING split) heals and runMarketingMonitor succeeds post-migration', async () => {
    const harness = buildDbThrough('0180_seat_events_route_precheck.sql')
    applyInTransaction(harness.sqlite, MIGRATION_0184_ALTER_SQL)
    const { sqlite, close } = harness
    try {
      const env = envForLifecycle(harness)
      const window = { start: '2026-07-01T00:00:00.000Z', end: '2026-07-01T23:59:59.999Z' }

      // marketing-cro-monitor's departments (agency/growth/web-ops) are
      // pro/scale-gated (src/departments/modules/agency.ts) — a brand-new
      // fixture DB fails closed to the 'free' tier (src/billing/entitlement.ts),
      // which cannot activate them at all. Unrelated to this migration; just
      // the entitlement this addon's own departments require to run.
      sqlite.exec(`INSERT INTO org_settings (key, value) VALUES ('billing_state', '{"tier":"scale"}')`)

      // Build through the REAL lifecycle, at whatever identity is currently
      // registered on this branch (the NEW, post-bump manifests).
      expectOk(await installAddon(env, lifecycleOwner, 'marketing-cro-monitor'), 'install marketing')
      expectOk(
        await configureAddon(env, lifecycleOwner, 'marketing-cro-monitor', {
          bindings: [{ slot: 'web_analytics', adapter: 'first_party', bindingKind: 'internal_adapter' }],
        }),
        'configure marketing',
      )
      expectOk(await activateAddon(env, lifecycleOwner, 'marketing-cro-monitor'), 'activate marketing')
      const firstRun = await runMarketingMonitor(env, lifecycleOwner, { window }, {
        sourceFactory: ({ runId, window: requestedWindow }) => [createMarketingMonitorFixtureSource({
          runId,
          observedAt: '2026-07-01T12:00:00.000Z',
          window: requestedWindow,
        })],
      })
      expectOk(firstRun, 'first (pre-migration) marketing monitor run')

      const installation = queryOne(
        sqlite,
        `SELECT id, manifest_sha256 FROM addon_installations WHERE tenant = 'mumega' AND addon_key = 'marketing-cro-monitor'`,
      )
      const generation = queryOne(
        sqlite,
        `SELECT id, manifest_sha256 FROM addon_binding_generations WHERE tenant = 'mumega' AND installation_id = ? AND revoked_at IS NULL`,
        installation.id,
      )
      const binding = queryOne(
        sqlite,
        `SELECT id, manifest_sha256 FROM addon_connector_bindings WHERE tenant = 'mumega' AND installation_id = ? AND revoked_at IS NULL`,
        installation.id,
      )

      // Time-travel: installation to the OLD (^0.29.0) identity, but
      // generation + binding + the completed run to a THIRD, already-split
      // digest — prod's actual state (0089 moved the installation in
      // August and never touched the generation).
      downgradeIdentity(sqlite, () => {
        sqlite.exec(
          `UPDATE addon_installations SET manifest_sha256 = '${ADDONS[0].oldDigest}', mupot_compatibility = '${ADDONS[0].oldCompat}' WHERE id = '${installation.id}'`,
        )
        sqlite.exec(
          `UPDATE addon_binding_generations SET manifest_sha256 = '${PRE_EXISTING_SPLIT_DIGEST}' WHERE id = '${generation.id}'`,
        )
        sqlite.exec(
          `UPDATE addon_connector_bindings SET manifest_sha256 = '${PRE_EXISTING_SPLIT_DIGEST}' WHERE id = '${binding.id}'`,
        )
        // marketing_monitor_runs is separately guarded by its own
        // immutability trigger ("marketing monitor runs are immutable
        // except guarded finalization") — not dropped here, so the
        // pre-migration run keeps whatever digest real-lifecycle code wrote
        // it with. 0181 does not touch this table (round-1 P2, accepted:
        // pre-migration runs drop out of manifest_sha256-filtered views;
        // not this migration's job to fix), so this test does not assert
        // on it either way.
      })

      // Sanity precondition: the split is real before migrating.
      expect(
        queryOne(sqlite, `SELECT id, manifest_sha256 FROM addon_installations WHERE id = ?`, installation.id)
          .manifest_sha256,
      ).toBe(ADDONS[0].oldDigest)
      expect(
        queryOne(sqlite, `SELECT id, manifest_sha256 FROM addon_binding_generations WHERE id = ?`, generation.id)
          .manifest_sha256,
      ).toBe(PRE_EXISTING_SPLIT_DIGEST)

      applyInTransaction(sqlite, MIGRATION_SQL)
      applyInTransaction(sqlite, MIGRATION_0184_TRIGGER_SQL)

      // Healed: installation at the NEW digest, generation and binding
      // brought forward to match it (not to the installation's old value —
      // proving the heal is keyed to the parent installation's CURRENT
      // state, exactly as the review required).
      expect(
        queryOne(sqlite, `SELECT id, manifest_sha256 FROM addon_installations WHERE id = ?`, installation.id)
          .manifest_sha256,
      ).toBe(ADDONS[0].newDigest)
      expect(
        queryOne(sqlite, `SELECT id, manifest_sha256 FROM addon_binding_generations WHERE id = ?`, generation.id)
          .manifest_sha256,
      ).toBe(ADDONS[0].newDigest)
      expect(
        queryOne(sqlite, `SELECT id, manifest_sha256 FROM addon_connector_bindings WHERE id = ?`, binding.id)
          .manifest_sha256,
      ).toBe(ADDONS[0].newDigest)

      // The pre-migration run still exists, untouched by 0181 (P2,
      // accepted: it drops out of manifest_sha256-filtered views; not this
      // migration's job to fix).
      expect(
        sqlite.prepare(`SELECT COUNT(*) AS n FROM marketing_monitor_runs WHERE installation_id = ?`).get(installation.id),
      ).toEqual({ n: 1 })

      // The actual goal, with the CURRENT (new) code: a fresh monitor run
      // succeeds. Before the P0 fix this returned binding_generation_not_live.
      const secondRun = await runMarketingMonitor(env, lifecycleOwner, {
        window: { start: '2026-07-02T00:00:00.000Z', end: '2026-07-02T23:59:59.999Z' },
      }, {
        sourceFactory: ({ runId, window: requestedWindow }) => [createMarketingMonitorFixtureSource({
          runId,
          observedAt: '2026-07-02T12:00:00.000Z',
          window: requestedWindow,
        })],
      })
      expectOk(secondRun, 'second (post-migration) marketing monitor run')
    } finally {
      close()
    }
  })

  it('a disabled addon with a live (uniform, no-split) old-identity generation activates successfully post-migration', async () => {
    const harness = buildDbThrough('0180_seat_events_route_precheck.sql')
    applyInTransaction(harness.sqlite, MIGRATION_0184_ALTER_SQL)
    const { sqlite, close } = harness
    try {
      const env = envForLifecycle(harness)

      expectOk(await installAddon(env, lifecycleOwner, 'fixture-addon'), 'install fixture-addon')
      expectOk(await configureAddon(env, lifecycleOwner, 'fixture-addon', {}), 'configure fixture-addon')
      expectOk(await activateAddon(env, lifecycleOwner, 'fixture-addon'), 'activate fixture-addon')
      expectOk(await disableAddon(env, lifecycleOwner, 'fixture-addon'), 'disable fixture-addon')

      const installation = queryOne(
        sqlite,
        `SELECT id, manifest_sha256 FROM addon_installations WHERE tenant = 'mumega' AND addon_key = 'fixture-addon'`,
      )
      const generation = queryOne(
        sqlite,
        `SELECT id, manifest_sha256 FROM addon_binding_generations WHERE tenant = 'mumega' AND installation_id = ? AND revoked_at IS NULL`,
        installation.id,
      )

      // Uniform downgrade — installation and its generation both to the
      // SAME old digest, no split (matches prod's workflow-circuits shape:
      // "installation = generation").
      downgradeIdentity(sqlite, () => {
        sqlite.exec(
          `UPDATE addon_installations SET manifest_sha256 = '${ADDONS[3].oldDigest}', mupot_compatibility = '${ADDONS[3].oldCompat}' WHERE id = '${installation.id}'`,
        )
        sqlite.exec(
          `UPDATE addon_binding_generations SET manifest_sha256 = '${ADDONS[3].oldDigest}' WHERE id = '${generation.id}'`,
        )
      })

      applyInTransaction(sqlite, MIGRATION_SQL)
      applyInTransaction(sqlite, MIGRATION_0184_TRIGGER_SQL)

      expect(
        queryOne(sqlite, `SELECT id, manifest_sha256 FROM addon_binding_generations WHERE id = ?`, generation.id)
          .manifest_sha256,
      ).toBe(ADDONS[3].newDigest)

      // Before the P0 fix this returned write_failed with no self-service
      // way back (reconfiguring an addon with no connector requirements is
      // an idempotent no-op that never mints a new generation).
      expectOk(await activateAddon(env, lifecycleOwner, 'fixture-addon'), 'reactivate fixture-addon post-migration')
    } finally {
      close()
    }
  })

  it('a configured (not yet active) addon reconfigures and activates successfully post-migration', async () => {
    const harness = buildDbThrough('0180_seat_events_route_precheck.sql')
    applyInTransaction(harness.sqlite, MIGRATION_0184_ALTER_SQL)
    const { sqlite, close } = harness
    try {
      const env = envForLifecycle(harness)

      expectOk(await installAddon(env, lifecycleOwner, 'fixture-addon-with-loop'), 'install fixture-addon-with-loop')
      expectOk(await configureAddon(env, lifecycleOwner, 'fixture-addon-with-loop', {}), 'configure fixture-addon-with-loop')

      const installation = queryOne(
        sqlite,
        `SELECT id, manifest_sha256 FROM addon_installations WHERE tenant = 'mumega' AND addon_key = 'fixture-addon-with-loop'`,
      )
      const generation = queryOne(
        sqlite,
        `SELECT id, manifest_sha256 FROM addon_binding_generations WHERE tenant = 'mumega' AND installation_id = ? AND revoked_at IS NULL`,
        installation.id,
      )

      downgradeIdentity(sqlite, () => {
        sqlite.exec(
          `UPDATE addon_installations SET manifest_sha256 = '${ADDONS[4].oldDigest}', mupot_compatibility = '${ADDONS[4].oldCompat}' WHERE id = '${installation.id}'`,
        )
        sqlite.exec(
          `UPDATE addon_binding_generations SET manifest_sha256 = '${ADDONS[4].oldDigest}' WHERE id = '${generation.id}'`,
        )
      })

      applyInTransaction(sqlite, MIGRATION_SQL)
      applyInTransaction(sqlite, MIGRATION_0184_TRIGGER_SQL)

      expectOk(
        await configureAddon(env, lifecycleOwner, 'fixture-addon-with-loop', {}),
        'idempotent reconfigure post-migration',
      )
      expectOk(await activateAddon(env, lifecycleOwner, 'fixture-addon-with-loop'), 'activate post-migration')
    } finally {
      close()
    }
  })

  it('workflow-circuits (active, uniform old-identity generation, no connector bindings) heals with no split', async () => {
    const harness = buildDbThrough('0180_seat_events_route_precheck.sql')
    applyInTransaction(harness.sqlite, MIGRATION_0184_ALTER_SQL)
    const { sqlite, close } = harness
    try {
      const env = envForLifecycle(harness)

      expectOk(await installAddon(env, lifecycleOwner, 'workflow-circuits'), 'install workflow-circuits')
      expectOk(await configureAddon(env, lifecycleOwner, 'workflow-circuits', {}), 'configure workflow-circuits')
      expectOk(await activateAddon(env, lifecycleOwner, 'workflow-circuits'), 'activate workflow-circuits')

      const installation = queryOne(
        sqlite,
        `SELECT id, manifest_sha256 FROM addon_installations WHERE tenant = 'mumega' AND addon_key = 'workflow-circuits'`,
      )
      const generation = queryOne(
        sqlite,
        `SELECT id, manifest_sha256 FROM addon_binding_generations WHERE tenant = 'mumega' AND installation_id = ? AND revoked_at IS NULL`,
        installation.id,
      )

      downgradeIdentity(sqlite, () => {
        sqlite.exec(
          `UPDATE addon_installations SET manifest_sha256 = '${ADDONS[2].oldDigest}', mupot_compatibility = '${ADDONS[2].oldCompat}' WHERE id = '${installation.id}'`,
        )
        sqlite.exec(
          `UPDATE addon_binding_generations SET manifest_sha256 = '${ADDONS[2].oldDigest}' WHERE id = '${generation.id}'`,
        )
      })

      applyInTransaction(sqlite, MIGRATION_SQL)
      applyInTransaction(sqlite, MIGRATION_0184_TRIGGER_SQL)

      expect(
        queryOne(sqlite, `SELECT id, manifest_sha256 FROM addon_installations WHERE id = ?`, installation.id)
          .manifest_sha256,
      ).toBe(ADDONS[2].newDigest)
      expect(
        queryOne(sqlite, `SELECT id, manifest_sha256 FROM addon_binding_generations WHERE id = ?`, generation.id)
          .manifest_sha256,
      ).toBe(ADDONS[2].newDigest)
      expectOk(await disableAddon(env, lifecycleOwner, 'workflow-circuits'), 'disable workflow-circuits post-migration (proves it is live, not frozen)')
    } finally {
      close()
    }
  })

  it('installed-only addons (project-link, mcpwp-office: no generation) are untouched by the generation/binding heal and still flip to the new identity', async () => {
    const harness = buildDbThrough('0180_seat_events_route_precheck.sql')
    const { sqlite, close } = harness
    try {
      const env = envForLifecycle(harness)

      expectOk(await installAddon(env, lifecycleOwner, 'project-link'), 'install project-link')
      expectOk(await installAddon(env, lifecycleOwner, 'mcpwp-office'), 'install mcpwp-office')

      const link = queryOne(
        sqlite,
        `SELECT id, manifest_sha256 FROM addon_installations WHERE tenant = 'mumega' AND addon_key = 'project-link'`,
      )
      const office = queryOne(
        sqlite,
        `SELECT id, manifest_sha256 FROM addon_installations WHERE tenant = 'mumega' AND addon_key = 'mcpwp-office'`,
      )
      expect(
        sqlite.prepare(`SELECT COUNT(*) AS n FROM addon_binding_generations WHERE installation_id IN (?, ?)`).get(link.id, office.id),
      ).toEqual({ n: 0 })

      downgradeIdentity(sqlite, () => {
        sqlite.exec(
          `UPDATE addon_installations SET manifest_sha256 = '${ADDONS[1].oldDigest}', mupot_compatibility = '${ADDONS[1].oldCompat}' WHERE id = '${link.id}'`,
        )
        sqlite.exec(
          `UPDATE addon_installations SET manifest_sha256 = '${ADDONS[5].oldDigest}', mupot_compatibility = '${ADDONS[5].oldCompat}' WHERE id = '${office.id}'`,
        )
      })

      applyInTransaction(sqlite, MIGRATION_SQL)

      expect(
        queryOne(sqlite, `SELECT id, manifest_sha256 FROM addon_installations WHERE id = ?`, link.id).manifest_sha256,
      ).toBe(ADDONS[1].newDigest)
      expect(
        queryOne(sqlite, `SELECT id, manifest_sha256 FROM addon_installations WHERE id = ?`, office.id).manifest_sha256,
      ).toBe(ADDONS[5].newDigest)
    } finally {
      close()
    }
  })
})
