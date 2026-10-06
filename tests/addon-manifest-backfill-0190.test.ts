import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { manifestSha256 } from '../src/addons/contract'
import { getRegisteredAddon } from '../src/addons/registry'
import { matchesRegisteredIdentity, type AddonInstallation } from '../src/addons/service'
import '../src/addons/modules/index'
import '../src/addons/modules/fixture-with-loop'
import '../src/addons/project-link/manifest'
import '../src/addons/workflow-circuits/manifest'
import '../src/addons/office/manifest'

// Full migration chains against real sqlite are slow under shared-host load.
vi.setConfig({ testTimeout: 60_000 })

// 0190 moves ONLY the mcpwp-office installation identity (external manifests
// hash addonApiCompatibility; native manifests exclude it). See its header.
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TARGET = '0190_backfill_addon_manifest_office_api_compat.sql'
const MIGRATION_SQL = readFileSync(join(MIGRATIONS_DIR, TARGET), 'utf8')
const VERIFY_SQL = readFileSync(join(__dirname, '..', 'scripts', 'verify-addon-office-identity-0190.sql'), 'utf8')
const OFFICE_OLD = '9ee9eb05c9a5a469e67e88e98aca68b0654448f539dcb3744eb48c090139c84f'
const OFFICE_NEW = '7d66a75e95732366e71c87f34b5d5586b5bb005ddea6e3369d8725fa09a91ad2'
const NATIVE_DIGESTS: Record<string, string> = {
  'fixture-addon': '5dc890ecb8ad0f17ca934f4862d80974af2a8fd1f3f8d89469085d1433376cea',
  'fixture-addon-with-loop': '747d860766a47f0788eca7e130d72f73e2fcee08e5f4f858199fd766203307d3',
  'marketing-cro-monitor': '7c6081a3debd40846c4c724110917c1c2685ebe315f081e9d73b2ad258225c6a',
  'project-link': '139f17b91d4ce39b23f510c4006826d3ddfa95e11c13d30ba528bcb36e8dd629',
  'workflow-circuits': '3e7e7084eb77f6cc8f27f93d3370294c1ed6d399a674acc1a8d272053f0dd661',
}
const TRIGGER_NAMES = [
  'addon_installations_identity_is_immutable',
  'addon_binding_generations_revoke_only',
  'addon_connector_bindings_revoke_only',
] as const

function chain(beforeTarget = true) {
  const harness = createSqliteD1()
  const files = readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql') && (beforeTarget ? n < TARGET : true)).sort()
  for (const f of files) harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
  return harness
}

function applyInTransaction(sqlite: { exec(sql: string): void }, sql: string): void {
  sqlite.exec('BEGIN')
  try { sqlite.exec(sql); sqlite.exec('COMMIT') } catch (e) { sqlite.exec('ROLLBACK'); throw e }
}

function seed(id: string, tenant: string, key: string, compat: string, digest: string, trust: string) {
  return `
    INSERT INTO addon_installations (id, tenant, addon_key, installed_version, publisher, trust_class,
      manifest_sha256, mupot_compatibility, isolation_class, state, latest_previous_state,
      installed_by, latest_actor_id, latest_receipt_id, installed_at, updated_at)
    VALUES ('${id}','${tenant}','${key}','1.0.0','mumega','native_reviewed','${digest}','${compat}','${trust}','installed',NULL,
      'agent-x','agent-x','rcpt-${id}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
    INSERT INTO addon_receipts (id, tenant, installation_id, action, previous_state, next_state, addon_key,
      installed_version, publisher, trust_class, mupot_compatibility, manifest_sha256, isolation_class,
      actor_id, outcome, side_effect_ids, checks, created_at)
    VALUES ('rcpt-${id}','${tenant}','${id}','install',NULL,'installed','${key}','1.0.0','mumega','native_reviewed',
      '${compat}','${digest}','${trust}','agent-x','pass','[]','{}','2026-01-01T00:00:00Z');`
}

function seedGeneration(id: string, inst: string, tenant: string, digest: string) {
  return `
    INSERT INTO addon_binding_generations (id, tenant, installation_id, configuration_sha256, binding_count,
      manifest_sha256, configured_by, configured_at, revoked_at, previous_generation_id,
      expected_installation_state, base_receipt_id)
    VALUES ('${id}','${tenant}','${inst}','${'a'.repeat(64)}',1,'${digest}','agent-x','2026-01-02T00:00:00.000Z',NULL,NULL,'installed','rcpt-${inst}');
    INSERT INTO addon_connector_bindings (id, tenant, installation_id, generation_id, slot, adapter, binding_kind,
      capability, connector_id, manifest_sha256, configured_by, configured_at, revoked_at)
    VALUES ('bind-${id}','${tenant}','${inst}','${id}','slot','internal','internal_adapter','read',NULL,'${digest}','agent-x','2026-01-02T00:00:00.000Z',NULL);`
}

function seededDb() {
  const h = chain()
  applyInTransaction(h.sqlite, [
    seed('inst-office', 'mumega', 'mcpwp-office', '^0.31.0', OFFICE_OLD, 'external_isolated'),
    seed('inst-office-t2', 'tenant-two', 'mcpwp-office', '^0.31.0', OFFICE_OLD, 'external_isolated'),
    // Control: unexpected digest for office — must be left alone.
    seed('inst-office-odd', 'tenant-odd', 'mcpwp-office', '^0.31.0', '7'.repeat(64), 'external_isolated'),
    // Control: archived office row at the old digest — history, untouched.
    seed('inst-office-arch', 'tenant-arch', 'mcpwp-office', '^0.31.0', OFFICE_OLD, 'external_isolated'),
    // Controls: native rows at their current digests.
    seed('inst-link', 'mumega', 'project-link', '^0.30.0', NATIVE_DIGESTS['project-link'], 'native_reviewed'),
    seed('inst-cro', 'mumega', 'marketing-cro-monitor', '^0.30.0', NATIVE_DIGESTS['marketing-cro-monitor'], 'native_reviewed'),
    seedGeneration('gen-office', 'inst-office', 'mumega', OFFICE_OLD),
    // Native control with a PRE-EXISTING split generation: must NOT be healed here.
    seedGeneration('gen-cro-split', 'inst-cro', 'mumega', NATIVE_DIGESTS['marketing-cro-monitor']),
  ].join('\n'))
  // Archive the control row. The lifecycle triggers (rightly) forbid a raw
  // archive without receipts, so lift every addon_installations trigger except
  // the identity one on THIS throwaway database only, then archive it.
  const lifecycle = h.sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='addon_installations' AND name <> 'addon_installations_identity_is_immutable'`)
    .all() as Array<{ name: string }>
  for (const { name } of lifecycle) h.sqlite.exec(`DROP TRIGGER ${name}`)
  h.sqlite.exec(`UPDATE addon_installations SET state='archived', latest_previous_state='installed', archived_at='2026-01-03T00:00:00Z' WHERE id='inst-office-arch'`)
  // Reproduce a PRE-EXISTING split on the native control (prod's real
  // marketing-cro-monitor shape: generation digest != installation digest). The
  // generation insert fence refuses it, and the revoke-only triggers forbid the
  // edit, so lift those two on this throwaway DB; the migration recreates them.
  h.sqlite.exec(`DROP TRIGGER addon_binding_generations_revoke_only; DROP TRIGGER addon_connector_bindings_revoke_only;
    UPDATE addon_binding_generations SET manifest_sha256='${'8'.repeat(64)}' WHERE id='gen-cro-split';
    UPDATE addon_connector_bindings SET manifest_sha256='${'8'.repeat(64)}' WHERE id='bind-gen-cro-split';`)
  return h
}

interface Row { id: string; manifest_sha256: string; mupot_compatibility: string }
function installs(sqlite: { prepare(s: string): { all(): unknown[] } }) {
  return Object.fromEntries((sqlite.prepare('SELECT id, manifest_sha256, mupot_compatibility FROM addon_installations').all() as Row[]).map((r) => [r.id, r]))
}

describe('0190 office identity backfill', () => {
  it('pins digests: office old/new, five natives unchanged', async () => {
    const office = getRegisteredAddon('mcpwp-office')
    if (!office) throw new Error('office not registered')
    expect(office.manifestSha256).toBe(OFFICE_NEW)
    expect(await manifestSha256(office.manifest)).toBe(OFFICE_NEW)
    // Old digest = the same manifest minus the (now digest-bound) field.
    const { addonApiCompatibility: _field, ...historical } = office.manifest
    expect(await manifestSha256(historical)).toBe(OFFICE_OLD)
    expect(MIGRATION_SQL).toContain(`'${OFFICE_NEW}'`)
    expect(MIGRATION_SQL).toContain(`'${OFFICE_OLD}'`)
    for (const [key, digest] of Object.entries(NATIVE_DIGESTS)) {
      expect(getRegisteredAddon(key)?.manifestSha256).toBe(digest)
      expect(MIGRATION_SQL).not.toContain(digest)
    }
  })

  it('moves only live mcpwp-office rows at the exact old identity; natives, archived, unexpected rows untouched; compat unchanged', () => {
    const { sqlite, close } = seededDb()
    try {
      applyInTransaction(sqlite, MIGRATION_SQL)
      const after = installs(sqlite)
      expect(after['inst-office'].manifest_sha256).toBe(OFFICE_NEW)
      expect(after['inst-office-t2'].manifest_sha256).toBe(OFFICE_NEW)
      expect(after['inst-office'].mupot_compatibility).toBe('^0.31.0')
      expect(after['inst-office-odd'].manifest_sha256).toBe('7'.repeat(64))
      expect(after['inst-office-arch'].manifest_sha256).toBe(OFFICE_OLD)
      expect(after['inst-link'].manifest_sha256).toBe(NATIVE_DIGESTS['project-link'])
      expect(after['inst-cro'].manifest_sha256).toBe(NATIVE_DIGESTS['marketing-cro-monitor'])
    } finally { close() }
  })

  it('heals the live office generation and binding, never a native generation', () => {
    const { sqlite, close } = seededDb()
    try {
      applyInTransaction(sqlite, MIGRATION_SQL)
      const gen = (id: string) => (sqlite.prepare('SELECT manifest_sha256 AS d FROM addon_binding_generations WHERE id = ?').get(id) as { d: string }).d
      const bind = (id: string) => (sqlite.prepare('SELECT manifest_sha256 AS d FROM addon_connector_bindings WHERE id = ?').get(id) as { d: string }).d
      expect(gen('gen-office')).toBe(OFFICE_NEW)
      expect(bind('bind-gen-office')).toBe(OFFICE_NEW)
      expect(gen('gen-cro-split')).toBe('8'.repeat(64))
      expect(bind('bind-gen-cro-split')).toBe('8'.repeat(64))
    } finally { close() }
  })

  it('is idempotent (second apply is a no-op)', () => {
    const { sqlite, close } = seededDb()
    try {
      applyInTransaction(sqlite, MIGRATION_SQL)
      const once = JSON.stringify(installs(sqlite))
      applyInTransaction(sqlite, MIGRATION_SQL)
      expect(JSON.stringify(installs(sqlite))).toBe(once)
    } finally { close() }
  })

  it('recreates all three triggers byte-identical to the pre-migration sqlite_master and they still enforce', () => {
    const before = chain()
    const expected = new Map<string, string>()
    const sql = (db: { prepare(s: string): { get(...a: unknown[]): unknown } }, n: string) =>
      (db.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?`).get(n) as { sql: string }).sql
    try { for (const n of TRIGGER_NAMES) expected.set(n, sql(before.sqlite, n)) } finally { before.close() }

    const { sqlite, close } = seededDb()
    try {
      applyInTransaction(sqlite, MIGRATION_SQL)
      for (const n of TRIGGER_NAMES) expect(sql(sqlite, n)).toBe(expected.get(n))
      expect(() => sqlite.exec(`UPDATE addon_installations SET manifest_sha256 = '${'b'.repeat(64)}' WHERE id = 'inst-link'`))
        .toThrow(/immutable/)
      expect(() => sqlite.exec(`UPDATE addon_binding_generations SET manifest_sha256 = '${'b'.repeat(64)}' WHERE id = 'gen-office'`))
        .toThrow(/append-only/)
    } finally { close() }
  })

  it('matchesRegisteredIdentity flips false -> true for the office installation', () => {
    const entry = getRegisteredAddon('mcpwp-office')
    if (!entry) throw new Error('office not registered')
    const { sqlite, close } = seededDb()
    try {
      const toInstall = (r: Row): AddonInstallation => ({
        id: r.id, tenant: 'mumega', addonKey: 'mcpwp-office', installedVersion: '1.0.0', publisher: 'mumega',
        trustClass: 'external_isolated', manifestSha256: r.manifest_sha256, mupotCompatibility: r.mupot_compatibility,
        state: 'installed', latestPreviousState: null, installedBy: 'agent-x', latestActorId: 'agent-x',
        latestReceiptId: 'rcpt-inst-office', installedAt: '2026-01-01T00:00:00Z', configuredAt: null,
        activatedAt: null, disabledAt: null, archivedAt: null, updatedAt: '2026-01-01T00:00:00Z', lastError: null,
      } as AddonInstallation)
      expect(matchesRegisteredIdentity(toInstall(installs(sqlite)['inst-office']), entry)).toBe(false)
      applyInTransaction(sqlite, MIGRATION_SQL)
      expect(matchesRegisteredIdentity(toInstall(installs(sqlite)['inst-office']), entry)).toBe(true)
    } finally { close() }
  })

  it('the read-only verification SQL is read-only and runs against the pre-migration schema', () => {
    expect(VERIFY_SQL.replace(/--.*$/gm, '')).not.toMatch(/\b(UPDATE|INSERT|DELETE|DROP|ALTER|CREATE)\b/i)
    const { sqlite, close } = seededDb()
    try {
      const statements = VERIFY_SQL.replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean)
      expect(statements).toHaveLength(3)
      const first = sqlite.prepare(statements[0]).all() as Array<{ id: string; old_digest_match: number }>
      expect(first.find((r) => r.id === 'inst-office')?.old_digest_match).toBe(1)
      expect(first.find((r) => r.id === 'inst-office-odd')?.old_digest_match).toBe(0)
      expect(sqlite.prepare(statements[1]).all().length).toBe(1)
      expect(sqlite.prepare(statements[2]).all().length).toBe(1)
    } finally { close() }
  })
})
