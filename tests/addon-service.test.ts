import { readFileSync } from 'node:fs'
import type { D1PreparedStatement, D1Result } from '@cloudflare/workers-types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../src/types'
import { getRegisteredAddon } from '../src/addons/registry'
import { deactivate as deactivateDepartment } from '../src/departments/registry'
import {
  activateAddon,
  archiveAddon,
  configureAddon,
  disableAddon,
  getAddonReceipts,
  installAddon,
  listAddonInstallations,
  type AddonLifecycleDeps,
  type AddonMutationResult,
} from '../src/addons/service'
import { createSqliteD1 } from './helpers/sqlite-d1'

const migrations = [
  '../migrations/0001_init.sql',
  '../migrations/0003_settings.sql',
  '../migrations/0029_department_microkernel.sql',
  '../migrations/0050_addons.sql',
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
const owner = { id: 'owner-1', role: 'owner' } as const
const admin = { id: 'admin-1', role: 'admin' } as const
const immutableInstallationUpdates = [
  ['id', 'replacement-installation'],
  ['tenant', 'tenant-b'],
  ['addon_key', 'replacement-addon'],
  ['installed_version', '9.9.9'],
  ['publisher', 'replacement-publisher'],
  ['trust_class', 'external_isolated'],
  ['manifest_sha256', 'b'.repeat(64)],
  ['mupot_compatibility', '^99.0.0'],
  ['installed_by', 'replacement-installer'],
] as const

interface ReceiptRow {
  sequence?: number
  id: string
  tenant: string
  installation_id: string
  action: string
  previous_state: string | null
  next_state: string | null
  addon_key: string
  installed_version: string
  publisher: string
  trust_class: string
  mupot_compatibility: string
  manifest_sha256: string
  actor_id: string
  outcome: string
  side_effect_ids: string
  checks: string
  error_code: string | null
  created_at: string
}

interface InstallationRow {
  id: string
  tenant: string
  addon_key: string
  installed_version: string
  publisher: string
  trust_class: string
  manifest_sha256: string
  mupot_compatibility: string
  state: string
  latest_previous_state: string | null
  installed_by: string
  latest_actor_id: string
  latest_receipt_id: string
  installed_at: string
  updated_at: string
}

function makeDb(tenant = 'tenant-a') {
  const harness = createSqliteD1()
  for (const migration of migrations) harness.sqlite.exec(migration)

  return {
    harness,
    env: { DB: harness.db, TENANT_SLUG: tenant } as Env,
    departments: () => harness.sqlite.prepare('SELECT * FROM departments ORDER BY id').all(),
    squads: () => harness.sqlite.prepare('SELECT * FROM squads ORDER BY id').all(),
    operations: () => harness.sqlite.prepare('SELECT * FROM addon_operations ORDER BY created_at, id').all(),
    resources: () => harness.sqlite.prepare('SELECT * FROM addon_resource_ownership ORDER BY id').all(),
    receipts: () => harness.sqlite.prepare('SELECT * FROM addon_receipts ORDER BY created_at, id').all() as ReceiptRow[],
    installations: () => harness.sqlite.prepare('SELECT * FROM addon_installations ORDER BY installed_at, id').all() as InstallationRow[],
  }
}

type Db = ReturnType<typeof makeDb>

function successfulInstallation(result: AddonMutationResult) {
  if (!result.ok) throw new Error(`expected successful addon mutation, received ${result.reason}`)
  return result.installation
}

async function insertInstallationLifecycle(
  db: Db,
  overrides: Partial<{
    id: string
    receiptId: string
    tenant: string
    addonKey: string
    installedVersion: string
    publisher: string
    trustClass: string
    manifestSha256: string
    mupotCompatibility: string
    state: string
    installedBy: string
    latestActorId: string
    receiptActorId: string
    outcome: 'pass' | 'fail'
    createdAt: string
  }> = {},
) {
  const catalog = getRegisteredAddon('fixture-addon')
  if (!catalog) throw new Error('fixture addon is not registered')

  const id = overrides.id ?? crypto.randomUUID()
  const receiptId = overrides.receiptId ?? crypto.randomUUID()
  const tenant = overrides.tenant ?? db.env.TENANT_SLUG
  const addonKey = overrides.addonKey ?? `fixture-${id}`
  const installedVersion = overrides.installedVersion ?? catalog.manifest.version
  const publisher = overrides.publisher ?? catalog.manifest.publisher
  const trustClass = overrides.trustClass ?? catalog.manifest.trustClass
  const digest = overrides.manifestSha256 ?? catalog.manifestSha256
  const mupotCompatibility = overrides.mupotCompatibility ?? catalog.manifest.mupotCompatibility
  const state = overrides.state ?? 'installed'
  const installedBy = overrides.installedBy ?? owner.id
  const latestActorId = overrides.latestActorId ?? installedBy
  const receiptActorId = overrides.receiptActorId ?? latestActorId
  const outcome = overrides.outcome ?? 'pass'
  const now = overrides.createdAt ?? new Date().toISOString()

  await db.env.DB.batch([
    db.env.DB.prepare(`
      INSERT INTO addon_installations (
        id, tenant, addon_key, installed_version, publisher, trust_class,
        manifest_sha256, mupot_compatibility, state, latest_previous_state, installed_by,
        latest_actor_id, latest_receipt_id, installed_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11, ?12, ?13, ?13)
    `).bind(
      id,
      tenant,
      addonKey,
      installedVersion,
      publisher,
      trustClass,
      digest,
      mupotCompatibility,
      state,
      installedBy,
      latestActorId,
      receiptId,
      now,
    ),
    db.env.DB.prepare(`
      INSERT INTO addon_receipts (
        id, tenant, installation_id, action, previous_state, next_state,
        addon_key, installed_version, publisher, trust_class,
        mupot_compatibility, manifest_sha256, actor_id, outcome,
        side_effect_ids, checks, created_at
      ) VALUES (
        ?1, ?2, ?3, 'install', NULL, 'installed', ?4, ?5, ?6, ?7,
        ?8, ?9, ?10, ?11, '[]', '{}', ?12
      )
    `).bind(
      receiptId,
      tenant,
      id,
      addonKey,
      installedVersion,
      publisher,
      trustClass,
      mupotCompatibility,
      digest,
      receiptActorId,
      outcome,
      now,
    ),
  ])

  return { id, receiptId }
}

async function transitionInstallation(
  db: Db,
  installationId: string,
  action: 'configure' | 'activate' | 'disable' | 'archive',
  previousState: 'installed' | 'configured' | 'active' | 'disabled',
  nextState: 'configured' | 'active' | 'disabled' | 'archived',
  options: {
    whereState?: string
    publisher?: string
    actorId?: string
    receiptActorId?: string
    outcome?: 'pass' | 'fail'
    receiptId?: string
    createdAt?: string
  } = {},
) {
  const installation = db.installations().find((row) => row.id === installationId)
  if (!installation) throw new Error('installation not found')

  const receiptId = options.receiptId ?? crypto.randomUUID()
  const now = options.createdAt ?? new Date().toISOString()
  const actorId = options.actorId ?? owner.id
  const receiptActorId = options.receiptActorId ?? actorId
  const outcome = options.outcome ?? 'pass'

  return db.env.DB.batch([
    db.env.DB.prepare(`
      UPDATE addon_installations
         SET state = ?1, latest_previous_state = ?2,
             latest_actor_id = ?3, latest_receipt_id = ?4, updated_at = ?5
       WHERE id = ?6 AND tenant = ?7 AND state = ?8
    `).bind(
      nextState,
      options.whereState ?? previousState,
      actorId,
      receiptId,
      now,
      installationId,
      db.env.TENANT_SLUG,
      options.whereState ?? previousState,
    ),
    db.env.DB.prepare(`
      INSERT INTO addon_receipts (
        id, tenant, installation_id, action, previous_state, next_state,
        addon_key, installed_version, publisher, trust_class,
        mupot_compatibility, manifest_sha256, actor_id, outcome,
        side_effect_ids, checks, created_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
        ?11, ?12, ?13, ?14, '[]', '{}', ?15
      )
    `).bind(
      receiptId,
      db.env.TENANT_SLUG,
      installationId,
      action,
      previousState,
      nextState,
      installation.addon_key,
      installation.installed_version,
      options.publisher ?? installation.publisher,
      installation.trust_class,
      installation.mupot_compatibility,
      installation.manifest_sha256,
      receiptActorId,
      outcome,
      now,
    ),
  ])
}

function insertOwnership(
  db: Db,
  id: string,
  installationId: string,
  resourceId: string,
  mode: 'exclusive' | 'co_owner',
  active = 1,
) {
  return db.harness.sqlite.prepare(`
    INSERT INTO addon_resource_ownership (
      id, tenant, installation_id, resource_type, resource_id,
      resource_key, ownership_mode, active, created_at
    ) VALUES (?, ?, ?, 'department', ?, 'fixture', ?, ?, ?)
  `).run(id, db.env.TENANT_SLUG, installationId, resourceId, mode, active, new Date().toISOString())
}

function insertNonTransitionReceipt(
  db: Db,
  installation: InstallationRow,
  overrides: Partial<ReceiptRow> = {},
) {
  const row: ReceiptRow = {
    id: crypto.randomUUID(),
    tenant: installation.tenant,
    installation_id: installation.id,
    action: 'health',
    previous_state: installation.state,
    next_state: installation.state,
    addon_key: installation.addon_key,
    installed_version: installation.installed_version,
    publisher: installation.publisher,
    trust_class: installation.trust_class,
    mupot_compatibility: installation.mupot_compatibility,
    manifest_sha256: installation.manifest_sha256,
    actor_id: owner.id,
    outcome: 'pass',
    side_effect_ids: '[]',
    checks: '{}',
    error_code: null,
    created_at: new Date().toISOString(),
    ...overrides,
  }

  return db.harness.sqlite.prepare(`
    INSERT INTO addon_receipts (
      id, tenant, installation_id, action, previous_state, next_state,
      addon_key, installed_version, publisher, trust_class,
      mupot_compatibility, manifest_sha256, actor_id, outcome,
      side_effect_ids, checks, error_code, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.tenant,
    row.installation_id,
    row.action,
    row.previous_state,
    row.next_state,
    row.addon_key,
    row.installed_version,
    row.publisher,
    row.trust_class,
    row.mupot_compatibility,
    row.manifest_sha256,
    row.actor_id,
    row.outcome,
    row.side_effect_ids,
    row.checks,
    row.error_code,
    row.created_at,
  )
}

function withPostBatchRace(
  db: Db,
  matches: (sql: string) => boolean,
  race: () => Promise<void>,
): Env {
  const originalDb = db.env.DB
  let pending = true

  const racingDb = {
    prepare(sql: string) {
      return originalDb.prepare(sql)
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const results = await originalDb.batch<T>(statements)
      if (pending && statements.some((statement) => matches(
        (statement as D1PreparedStatement & { sql: string }).sql,
      ))) {
        pending = false
        await race()
      }
      return results
    },
  } as Env['DB']

  return { ...db.env, DB: racingDb }
}

function withPreBatchRace(
  db: Db,
  matches: (sql: string) => boolean,
  race: () => Promise<void>,
): Env {
  const originalDb = db.env.DB
  let pending = true

  const racingDb = {
    prepare(sql: string) {
      return originalDb.prepare(sql)
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      if (pending && statements.some((statement) => matches(
        (statement as D1PreparedStatement & { sql: string }).sql,
      ))) {
        pending = false
        await race()
      }
      return originalDb.batch<T>(statements)
    },
  } as Env['DB']

  return { ...db.env, DB: racingDb }
}

describe('addon migration constraints', () => {
  let db: Db

  beforeEach(() => {
    db = makeDb()
  })

  afterEach(() => db.harness.close())

  it('enforces installation checks and only one live lifecycle per tenant addon', async () => {
    await expect(insertInstallationLifecycle(db, { trustClass: 'external_isolated' })).rejects.toThrow()
    await expect(insertInstallationLifecycle(db, { manifestSha256: 'short' })).rejects.toThrow()
    await expect(insertInstallationLifecycle(db, { state: 'available' })).rejects.toThrow()

    await insertInstallationLifecycle(db, { addonKey: 'same-addon' })
    await expect(insertInstallationLifecycle(db, { addonKey: 'same-addon' })).rejects.toThrow()
    await expect(insertInstallationLifecycle(db, { tenant: 'tenant-b', addonKey: 'same-addon' })).resolves.toBeDefined()
  })

  it.each(immutableInstallationUpdates)('keeps installation identity column %s immutable', async (column, value) => {
    const installation = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    const before = db.installations()[0]

    expect(() => db.harness.sqlite.prepare(
      `UPDATE addon_installations SET ${column} = ? WHERE id = ?`,
    ).run(value, installation.id)).toThrow('addon installation identity is immutable')

    expect(db.installations()[0]).toEqual(before)
    expect(db.receipts()).toHaveLength(1)
  })

  it('requires the installer to be the initial latest actor', async () => {
    await expect(insertInstallationLifecycle(db, {
      addonKey: 'actor-mismatch-addon',
      installedBy: owner.id,
      latestActorId: admin.id,
      receiptActorId: admin.id,
    })).rejects.toThrow('addon installer must be the initial latest actor')

    expect(db.installations()).toHaveLength(0)
    expect(db.receipts()).toHaveLength(0)
  })

  it('rejects a null installation ID before it can bypass the deferred receipt foreign key', () => {
    const now = new Date().toISOString()

    expect(() => db.harness.sqlite.prepare(`
      INSERT INTO addon_installations (
        id, tenant, addon_key, installed_version, publisher, trust_class,
        manifest_sha256, mupot_compatibility, state, latest_previous_state,
        installed_by, latest_actor_id, latest_receipt_id, installed_at, updated_at
      ) VALUES (
        NULL, ?, 'null-id-addon', '1.0.0', 'Mupot', 'native_reviewed',
        ?, '^0.23.0', 'installed', NULL, ?, ?, 'missing-receipt', ?, ?
      )
    `).run(db.env.TENANT_SLUG, 'a'.repeat(64), owner.id, owner.id, now, now)).toThrow()

    expect(db.installations()).toHaveLength(0)
  })

  it('declares every text identity primary key as not null', () => {
    for (const table of [
      'addon_installations',
      'addon_operations',
      'addon_resource_ownership',
      'addon_receipts',
    ]) {
      const columns = db.harness.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string
        notnull: number
      }>
      const id = columns.find((column) => column.name === 'id')

      expect(id, `${table}.id must exist`).toBeDefined()
      expect(id?.notnull, `${table}.id must be NOT NULL`).toBe(1)
    }
  })

  it('anchors operation, ownership, and receipt tenants to their installation', async () => {
    const installation = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    const now = new Date().toISOString()

    expect(() => db.harness.sqlite.prepare(`
      INSERT INTO addon_operations (
        id, tenant, installation_id, action, target_state, current_step,
        status, actor_id, created_at, updated_at
      ) VALUES (?, 'tenant-b', ?, 'activate', 'active', 'start', 'running', ?, ?, ?)
    `).run('cross-tenant-operation', installation.id, owner.id, now, now)).toThrow()

    expect(() => db.harness.sqlite.prepare(`
      INSERT INTO addon_resource_ownership (
        id, tenant, installation_id, resource_type, resource_id,
        resource_key, ownership_mode, active, created_at
      ) VALUES (?, 'tenant-b', ?, 'department', 'dept-a', 'fixture', 'co_owner', 1, ?)
    `).run('cross-tenant-ownership', installation.id, now)).toThrow()

    const row = db.installations()[0]
    expect(() => insertNonTransitionReceipt(db, row, { tenant: 'tenant-b' })).toThrow()
  })

  it('enforces operation values and one running operation per installation', async () => {
    const installation = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    const now = new Date().toISOString()
    const insert = db.harness.sqlite.prepare(`
      INSERT INTO addon_operations (
        id, tenant, installation_id, action, target_state, current_step,
        status, actor_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', 'start', ?, ?, ?, ?)
    `)

    expect(() => insert.run(
      'bad-action', db.env.TENANT_SLUG, installation.id, 'install', 'running', owner.id, now, now,
    )).toThrow()
    insert.run('op-a', db.env.TENANT_SLUG, installation.id, 'activate', 'running', owner.id, now, now)
    expect(() => insert.run(
      'op-b', db.env.TENANT_SLUG, installation.id, 'disable', 'running', owner.id, now, now,
    )).toThrow()
  })

  it.each([
    ['activate', 'disabled'],
    ['activate', 'archived'],
    ['disable', 'active'],
    ['disable', 'archived'],
    ['archive', 'active'],
    ['archive', 'disabled'],
  ] as const)('rejects contradictory %s operations targeting %s', async (action, targetState) => {
    const installation = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    const now = new Date().toISOString()

    expect(() => db.harness.sqlite.prepare(`
      INSERT INTO addon_operations (
        id, tenant, installation_id, action, target_state, current_step,
        status, actor_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'done', 'completed', ?, ?, ?)
    `).run(
      `contradictory-${action}-${targetState}`,
      db.env.TENANT_SLUG,
      installation.id,
      action,
      targetState,
      owner.id,
      now,
      now,
    )).toThrow()
  })

  it('rejects active exclusive and co-owner claims in both insert and update orders', async () => {
    const first = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    const second = await insertInstallationLifecycle(db, { addonKey: 'fixture-addon-two' })

    insertOwnership(db, 'co-first', first.id, 'dept-co-first', 'co_owner')
    expect(() => insertOwnership(db, 'exclusive-second', second.id, 'dept-co-first', 'exclusive')).toThrow()

    insertOwnership(db, 'exclusive-first', first.id, 'dept-exclusive-first', 'exclusive')
    expect(() => insertOwnership(db, 'co-second', second.id, 'dept-exclusive-first', 'co_owner')).toThrow()

    insertOwnership(db, 'co-active', first.id, 'dept-update-exclusive', 'co_owner')
    insertOwnership(db, 'exclusive-inactive', second.id, 'dept-update-exclusive', 'exclusive', 0)
    expect(() => db.harness.sqlite.prepare(
      'UPDATE addon_resource_ownership SET active = 1 WHERE id = ?',
    ).run('exclusive-inactive')).toThrow()

    insertOwnership(db, 'exclusive-active', first.id, 'dept-update-co', 'exclusive')
    insertOwnership(db, 'co-inactive', second.id, 'dept-update-co', 'co_owner', 0)
    expect(() => db.harness.sqlite.prepare(
      'UPDATE addon_resource_ownership SET active = 1 WHERE id = ?',
    ).run('co-inactive')).toThrow()
  })

  it('keeps ownership identity immutable while allowing release lifecycle updates', async () => {
    const first = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    const second = await insertInstallationLifecycle(db, { addonKey: 'fixture-addon-two' })
    insertOwnership(db, 'claim-a', first.id, 'dept-a', 'co_owner')
    const before = db.resources()[0]

    for (const [column, value] of [
      ['id', 'claim-rewritten'],
      ['tenant', 'tenant-b'],
      ['installation_id', second.id],
      ['resource_type', 'connector'],
      ['resource_id', 'dept-b'],
      ['resource_key', 'replacement-key'],
      ['ownership_mode', 'exclusive'],
      ['created_at', '2099-01-01T00:00:00.000Z'],
    ] as const) {
      expect(() => db.harness.sqlite.prepare(
        `UPDATE addon_resource_ownership SET ${column} = ? WHERE id = 'claim-a'`,
      ).run(value)).toThrow('addon ownership identity is immutable')
      expect(db.resources()[0]).toEqual(before)
    }

    const releasedAt = new Date().toISOString()
    expect(() => db.harness.sqlite.prepare(`
      UPDATE addon_resource_ownership
         SET active = 0, released_at = ?
       WHERE id = 'claim-a'
    `).run(releasedAt)).not.toThrow()
    expect(db.resources()[0]).toMatchObject({ active: 0, released_at: releasedAt })

    expect(() => db.harness.sqlite.prepare(`
      UPDATE addon_resource_ownership
         SET active = 1, released_at = NULL
       WHERE id = 'claim-a'
    `).run()).not.toThrow()
    expect(db.resources()[0]).toMatchObject({ active: 1, released_at: null })
  })

  it('keeps ownership evidence when direct deletion is attempted', async () => {
    const installation = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    insertOwnership(db, 'claim-delete', installation.id, 'dept-delete', 'co_owner')
    const before = db.resources()[0]

    expect(() => db.harness.sqlite.prepare(
      'DELETE FROM addon_resource_ownership WHERE id = ?',
    ).run('claim-delete')).toThrow('addon ownership claims are evidence and cannot be deleted')

    expect(db.resources()[0]).toEqual(before)
  })

  it('rejects ownership ID reuse through INSERT OR REPLACE with recursive triggers off', async () => {
    const first = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    const second = await insertInstallationLifecycle(db, { addonKey: 'fixture-addon-two' })
    insertOwnership(db, 'claim-reuse', first.id, 'dept-original', 'co_owner')
    const before = db.resources()[0]

    expect(db.harness.sqlite.prepare('PRAGMA recursive_triggers').get()).toMatchObject({ recursive_triggers: 0 })
    expect(() => db.harness.sqlite.prepare(`
      INSERT OR REPLACE INTO addon_resource_ownership (
        id, tenant, installation_id, resource_type, resource_id,
        resource_key, ownership_mode, active, created_at
      ) VALUES (?, ?, ?, 'department', 'dept-reparented', 'replacement', 'co_owner', 1, ?)
    `).run('claim-reuse', db.env.TENANT_SLUG, second.id, new Date().toISOString()))
      .toThrow('addon ownership claim identity already exists')

    expect(db.resources()[0]).toEqual(before)
  })

  it('rejects replacing an ownership claim ID through its identity tuple', async () => {
    const installation = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    insertOwnership(db, 'claim-original', installation.id, 'dept-original', 'co_owner')
    const before = db.resources()[0]

    expect(() => db.harness.sqlite.prepare(`
      INSERT OR REPLACE INTO addon_resource_ownership (
        id, tenant, installation_id, resource_type, resource_id,
        resource_key, ownership_mode, active, created_at
      ) VALUES (?, ?, ?, 'department', 'dept-original', 'replacement', 'co_owner', 1, ?)
    `).run('claim-replacement', db.env.TENANT_SLUG, installation.id, new Date().toISOString()))
      .toThrow('addon ownership claim identity already exists')

    expect(db.resources()[0]).toEqual(before)
  })

  it('rejects active ownership inserts for archived installations but retains inactive history', async () => {
    const installation = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    await transitionInstallation(db, installation.id, 'disable', 'installed', 'disabled')
    await transitionInstallation(db, installation.id, 'archive', 'disabled', 'archived')

    expect(() => insertOwnership(
      db, 'active-archived-claim', installation.id, 'dept-active', 'co_owner',
    )).toThrow('archived addon installations cannot have active ownership claims')
    expect(() => insertOwnership(
      db, 'inactive-archived-claim', installation.id, 'dept-inactive', 'co_owner', 0,
    )).not.toThrow()
    expect(db.resources()).toEqual([
      expect.objectContaining({ id: 'inactive-archived-claim', active: 0 }),
    ])
  })

  it('rejects reactivating historical ownership for an archived installation', async () => {
    const installation = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    insertOwnership(db, 'historical-claim', installation.id, 'dept-historical', 'co_owner', 0)
    await transitionInstallation(db, installation.id, 'disable', 'installed', 'disabled')
    await transitionInstallation(db, installation.id, 'archive', 'disabled', 'archived')
    const before = db.resources()[0]

    expect(() => db.harness.sqlite.prepare(`
      UPDATE addon_resource_ownership
         SET active = 1, released_at = NULL
       WHERE id = 'historical-claim'
    `).run()).toThrow('archived addon installations cannot have active ownership claims')

    expect(db.resources()[0]).toEqual(before)
  })

  it('rejects archive while active ownership claims remain', async () => {
    const installation = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    insertOwnership(db, 'active-claim', installation.id, 'dept-a', 'co_owner')
    await transitionInstallation(db, installation.id, 'disable', 'installed', 'disabled')
    const before = db.installations()[0]

    await expect(transitionInstallation(
      db,
      installation.id,
      'archive',
      'disabled',
      'archived',
    )).rejects.toThrow('active addon ownership must be released before archive')

    expect(db.installations()[0]).toEqual(before)
    expect(db.receipts()).toHaveLength(2)

    db.harness.sqlite.prepare(`
      UPDATE addon_resource_ownership
         SET active = 0, released_at = ?
       WHERE id = 'active-claim'
    `).run(new Date().toISOString())
    await expect(transitionInstallation(
      db,
      installation.id,
      'archive',
      'disabled',
      'archived',
    )).resolves.toBeDefined()
  })

  it('rejects state without its receipt and a receipt for a zero-row transition', async () => {
    const installation = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))

    await expect(db.env.DB.batch([
      db.env.DB.prepare(`
        UPDATE addon_installations
           SET state = 'configured', latest_previous_state = 'installed',
               latest_receipt_id = 'missing-receipt'
         WHERE id = ?1 AND tenant = ?2 AND state = 'installed'
      `).bind(installation.id, db.env.TENANT_SLUG),
    ])).rejects.toThrow()
    expect(db.installations()[0].state).toBe('installed')
    expect(db.receipts()).toHaveLength(1)

    await expect(transitionInstallation(
      db,
      installation.id,
      'configure',
      'installed',
      'configured',
      { whereState: 'configured' },
    )).rejects.toThrow()
    expect(db.installations()[0].state).toBe('installed')
    expect(db.receipts()).toHaveLength(1)
  })

  it('rolls back failed install receipts instead of authorizing installed state', async () => {
    await expect(insertInstallationLifecycle(db, {
      addonKey: 'failed-install-addon',
      outcome: 'fail',
    })).rejects.toThrow('failed addon receipt cannot authorize lifecycle state')

    expect(db.installations()).toHaveLength(0)
    expect(db.receipts()).toHaveLength(0)
  })

  it('rolls back failed transition receipts instead of authorizing successful state', async () => {
    const installation = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    const before = db.installations()[0]

    await expect(transitionInstallation(
      db,
      installation.id,
      'configure',
      'installed',
      'configured',
      { outcome: 'fail' },
    )).rejects.toThrow('failed addon receipt cannot authorize lifecycle state')

    expect(db.installations()[0]).toEqual(before)
    expect(db.receipts()).toHaveLength(1)
  })

  it('retains standalone failed activate and preflight receipts without changing state', async () => {
    await installAddon(db.env, owner, 'fixture-addon')
    await configureAddon(db.env, owner, 'fixture-addon')
    const installation = db.installations()[0]

    expect(() => insertNonTransitionReceipt(db, installation, {
      action: 'activate',
      previous_state: 'configured',
      next_state: 'active',
      outcome: 'fail',
      error_code: 'activation_failed',
    })).not.toThrow()
    expect(() => insertNonTransitionReceipt(db, installation, {
      action: 'preflight',
      outcome: 'fail',
      error_code: 'preflight_failed',
    })).not.toThrow()

    expect(db.receipts().filter((receipt) => receipt.outcome === 'fail')).toHaveLength(2)
    expect(db.installations()[0]).toEqual(installation)
  })

  it('rejects latest actor changes without a state transition', async () => {
    const installation = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))

    expect(() => db.harness.sqlite.prepare(`
      UPDATE addon_installations
         SET latest_actor_id = ?
       WHERE id = ? AND tenant = ?
    `).run(admin.id, installation.id, db.env.TENANT_SLUG)).toThrow(
      'addon latest actor requires a state transition',
    )

    expect(db.installations()[0].latest_actor_id).toBe(owner.id)
    expect(db.receipts()).toHaveLength(1)
  })

  it('prevents rewriting the state-changing actor before inserting its fresh receipt', async () => {
    const installation = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    const before = db.installations()[0]
    const receiptId = crypto.randomUUID()
    const now = new Date().toISOString()

    await expect(db.env.DB.batch([
      db.env.DB.prepare(`
        UPDATE addon_installations
           SET state = 'configured', latest_previous_state = 'installed',
               latest_actor_id = ?1, latest_receipt_id = ?2, updated_at = ?3
         WHERE id = ?4 AND tenant = ?5 AND state = 'installed'
      `).bind(admin.id, receiptId, now, installation.id, db.env.TENANT_SLUG),
      db.env.DB.prepare(`
        UPDATE addon_installations
           SET latest_actor_id = ?1
         WHERE id = ?2 AND tenant = ?3 AND state = 'configured'
      `).bind(owner.id, installation.id, db.env.TENANT_SLUG),
      db.env.DB.prepare(`
        INSERT INTO addon_receipts (
          id, tenant, installation_id, action, previous_state, next_state,
          addon_key, installed_version, publisher, trust_class,
          mupot_compatibility, manifest_sha256, actor_id, outcome,
          side_effect_ids, checks, created_at
        ) VALUES (
          ?1, ?2, ?3, 'configure', 'installed', 'configured', ?4, ?5, ?6, ?7,
          ?8, ?9, ?10, 'pass', '[]', '{}', ?11
        )
      `).bind(
        receiptId,
        db.env.TENANT_SLUG,
        installation.id,
        before.addon_key,
        before.installed_version,
        before.publisher,
        before.trust_class,
        before.mupot_compatibility,
        before.manifest_sha256,
        owner.id,
        now,
      ),
    ])).rejects.toThrow('addon latest actor requires a state transition')

    expect(db.installations()[0]).toEqual(before)
    expect(db.receipts()).toHaveLength(1)
  })

  it('rolls back chained state updates when only the final transition receipt is inserted', async () => {
    const installation = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    const configuredReceiptId = crypto.randomUUID()
    const activeReceiptId = crypto.randomUUID()
    const now = new Date().toISOString()

    await expect(db.env.DB.batch([
      db.env.DB.prepare(`
        UPDATE addon_installations
           SET state = 'configured', latest_previous_state = 'installed',
               latest_actor_id = ?1, latest_receipt_id = ?2, updated_at = ?3
         WHERE id = ?4 AND tenant = ?5 AND state = 'installed'
      `).bind(owner.id, configuredReceiptId, now, installation.id, db.env.TENANT_SLUG),
      db.env.DB.prepare(`
        UPDATE addon_installations
           SET state = 'active', latest_previous_state = 'configured',
               latest_actor_id = ?1, latest_receipt_id = ?2, updated_at = ?3
         WHERE id = ?4 AND tenant = ?5 AND state = 'configured'
      `).bind(owner.id, activeReceiptId, now, installation.id, db.env.TENANT_SLUG),
      db.env.DB.prepare(`
        INSERT INTO addon_receipts (
          id, tenant, installation_id, action, previous_state, next_state,
          addon_key, installed_version, publisher, trust_class,
          mupot_compatibility, manifest_sha256, actor_id, outcome,
          side_effect_ids, checks, created_at
        ) VALUES (
          ?1, ?2, ?3, 'activate', 'configured', 'active', ?4, ?5, ?6, ?7,
          ?8, ?9, ?10, 'pass', '[]', '{}', ?11
        )
      `).bind(
        activeReceiptId,
        db.env.TENANT_SLUG,
        installation.id,
        db.installations()[0].addon_key,
        db.installations()[0].installed_version,
        db.installations()[0].publisher,
        db.installations()[0].trust_class,
        db.installations()[0].mupot_compatibility,
        db.installations()[0].manifest_sha256,
        owner.id,
        now,
      ),
    ])).rejects.toThrow()

    expect(db.installations().find((row) => row.id === installation.id)).toMatchObject({
      state: 'installed',
      latest_previous_state: null,
      latest_receipt_id: installation.latestReceiptId,
    })
    expect(db.receipts()).toHaveLength(1)
    expect(db.receipts().some((receipt) => receipt.id === activeReceiptId)).toBe(false)
  })

  it('binds the latest receipt to the same installation and tenant', async () => {
    const installation = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    const foreign = await insertInstallationLifecycle(db, {
      tenant: 'tenant-b',
      addonKey: 'fixture-addon',
    })

    await expect(db.env.DB.batch([
      db.env.DB.prepare(`
        UPDATE addon_installations
           SET state = 'configured', latest_previous_state = 'installed',
               latest_actor_id = ?1, latest_receipt_id = ?2
         WHERE id = ?3 AND tenant = ?4 AND state = 'installed'
      `).bind(owner.id, foreign.receiptId, installation.id, db.env.TENANT_SLUG),
    ])).rejects.toThrow()

    expect(db.installations().find((row) => row.id === installation.id)).toMatchObject({
      state: 'installed',
      latest_receipt_id: installation.latestReceiptId,
    })
  })

  it('rejects a lifecycle transition that reuses its original install receipt', async () => {
    const installation = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    await configureAddon(db.env, owner, 'fixture-addon')
    const installReceipt = db.receipts().find((receipt) => receipt.action === 'install')
    const configured = db.installations().find((row) => row.id === installation.id)
    if (!installReceipt || !configured) throw new Error('expected configured addon lifecycle')

    await expect(db.env.DB.batch([
      db.env.DB.prepare(`
        UPDATE addon_installations
           SET state = 'active', latest_previous_state = 'configured',
               latest_actor_id = ?1, latest_receipt_id = ?2
         WHERE id = ?3 AND tenant = ?4 AND state = 'configured'
      `).bind(owner.id, installReceipt.id, installation.id, db.env.TENANT_SLUG),
    ])).rejects.toThrow()

    expect(db.installations().find((row) => row.id === installation.id)).toMatchObject({
      state: 'configured',
      latest_receipt_id: configured.latest_receipt_id,
    })
    expect(db.receipts()).toHaveLength(2)
  })

  it('rejects a fresh non-lifecycle receipt bound to a lifecycle state transition', async () => {
    const installation = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    const installed = db.installations().find((row) => row.id === installation.id)
    if (!installed) throw new Error('expected installed addon lifecycle')

    expect(() => insertNonTransitionReceipt(db, installed)).not.toThrow()
    const receiptId = crypto.randomUUID()
    const now = new Date().toISOString()

    await expect(db.env.DB.batch([
      db.env.DB.prepare(`
        UPDATE addon_installations
           SET state = 'configured', latest_previous_state = 'installed',
               latest_actor_id = ?1, latest_receipt_id = ?2, updated_at = ?3
         WHERE id = ?4 AND tenant = ?5 AND state = 'installed'
      `).bind(owner.id, receiptId, now, installation.id, db.env.TENANT_SLUG),
      db.env.DB.prepare(`
        INSERT INTO addon_receipts (
          id, tenant, installation_id, action, previous_state, next_state,
          addon_key, installed_version, publisher, trust_class,
          mupot_compatibility, manifest_sha256, actor_id, outcome,
          side_effect_ids, checks, created_at
        ) VALUES (
          ?1, ?2, ?3, 'health', 'installed', 'configured', ?4, ?5, ?6, ?7,
          ?8, ?9, ?10, 'pass', '[]', '{}', ?11
        )
      `).bind(
        receiptId,
        db.env.TENANT_SLUG,
        installation.id,
        installed.addon_key,
        installed.installed_version,
        installed.publisher,
        installed.trust_class,
        installed.mupot_compatibility,
        installed.manifest_sha256,
        owner.id,
        now,
      ),
    ])).rejects.toThrow()

    expect(db.installations().find((row) => row.id === installation.id)).toMatchObject({
      state: 'installed',
      latest_receipt_id: installation.latestReceiptId,
    })
    expect(db.receipts()).toHaveLength(2)
    expect(db.receipts().some((receipt) => receipt.id === receiptId)).toBe(false)
  })

  it('rejects configured to active when the receipt falsely claims disabled', async () => {
    const installation = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    await configureAddon(db.env, owner, 'fixture-addon')
    const before = db.installations().find((row) => row.id === installation.id)
    if (!before) throw new Error('expected configured addon lifecycle')

    await expect(transitionInstallation(
      db,
      installation.id,
      'activate',
      'disabled',
      'active',
      { whereState: 'configured' },
    )).rejects.toThrow()

    expect(db.installations().find((row) => row.id === installation.id)).toMatchObject({
      state: 'configured',
      latest_receipt_id: before.latest_receipt_id,
      latest_previous_state: before.latest_previous_state,
    })
    expect(db.receipts()).toHaveLength(2)
  })

  it('rejects disabled to active when the receipt falsely claims configured', async () => {
    const installation = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    await transitionInstallation(db, installation.id, 'disable', 'installed', 'disabled')
    const before = db.installations().find((row) => row.id === installation.id)
    if (!before) throw new Error('expected disabled addon lifecycle')

    await expect(transitionInstallation(
      db,
      installation.id,
      'activate',
      'configured',
      'active',
      { whereState: 'disabled' },
    )).rejects.toThrow()

    expect(db.installations().find((row) => row.id === installation.id)).toMatchObject({
      state: 'disabled',
      latest_receipt_id: before.latest_receipt_id,
      latest_previous_state: before.latest_previous_state,
    })
    expect(db.receipts()).toHaveLength(2)
  })

  it('rejects active to disabled when the receipt falsely claims configured', async () => {
    const installation = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    await configureAddon(db.env, owner, 'fixture-addon')
    await transitionInstallation(db, installation.id, 'activate', 'configured', 'active')
    const before = db.installations().find((row) => row.id === installation.id)
    if (!before) throw new Error('expected active addon lifecycle')

    await expect(transitionInstallation(
      db,
      installation.id,
      'disable',
      'configured',
      'disabled',
      { whereState: 'active' },
    )).rejects.toThrow()

    expect(db.installations().find((row) => row.id === installation.id)).toMatchObject({
      state: 'active',
      latest_receipt_id: before.latest_receipt_id,
      latest_previous_state: before.latest_previous_state,
    })
    expect(db.receipts()).toHaveLength(3)
  })

  it('keeps receipts append-only and constrains action, states, outcome, digest, and JSON', async () => {
    await installAddon(db.env, owner, 'fixture-addon')
    const installation = db.installations()[0]
    const receipt = db.receipts()[0]

    expect(() => db.harness.sqlite.prepare(
      'UPDATE addon_receipts SET actor_id = ? WHERE id = ?',
    ).run('attacker', receipt.id)).toThrow()
    expect(() => db.harness.sqlite.prepare(
      'DELETE FROM addon_receipts WHERE id = ?',
    ).run(receipt.id)).toThrow()

    expect(() => insertNonTransitionReceipt(db, installation, { action: 'unknown' })).toThrow()
    expect(() => insertNonTransitionReceipt(db, installation, { previous_state: 'available' })).toThrow()
    expect(() => insertNonTransitionReceipt(db, installation, { next_state: 'available' })).toThrow()
    expect(() => insertNonTransitionReceipt(db, installation, { outcome: 'unknown' })).toThrow()
    expect(() => insertNonTransitionReceipt(db, installation, { manifest_sha256: 'a'.repeat(63) })).toThrow()
    expect(() => insertNonTransitionReceipt(db, installation, { side_effect_ids: '{}' })).toThrow()
    expect(() => insertNonTransitionReceipt(db, installation, { side_effect_ids: '[1]' })).toThrow()
    expect(() => insertNonTransitionReceipt(db, installation, { checks: '[]' })).toThrow()
    expect(() => insertNonTransitionReceipt(db, installation, { checks: '{' })).toThrow()
  })

  it('rejects INSERT OR REPLACE for an existing standalone receipt with recursive triggers off', async () => {
    const installation = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    const receiptId = crypto.randomUUID()
    insertNonTransitionReceipt(db, db.installations()[0], { id: receiptId, actor_id: 'standalone-actor' })
    const receipt = db.receipts().find((row) => row.id === receiptId)
    if (!receipt) throw new Error('expected standalone receipt')

    expect(db.harness.sqlite.prepare('PRAGMA recursive_triggers').get()).toMatchObject({ recursive_triggers: 0 })
    expect(() => db.harness.sqlite.prepare(`
      INSERT OR REPLACE INTO addon_receipts (
        id, tenant, installation_id, action, previous_state, next_state,
        addon_key, installed_version, publisher, trust_class,
        mupot_compatibility, manifest_sha256, actor_id, outcome,
        side_effect_ids, checks, error_code, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rewritten-actor', ?, ?, ?, ?, ?)
    `).run(
      receipt.id,
      receipt.tenant,
      receipt.installation_id,
      receipt.action,
      receipt.previous_state,
      receipt.next_state,
      receipt.addon_key,
      receipt.installed_version,
      receipt.publisher,
      receipt.trust_class,
      receipt.mupot_compatibility,
      receipt.manifest_sha256,
      receipt.outcome,
      receipt.side_effect_ids,
      receipt.checks,
      receipt.error_code,
      receipt.created_at,
    )).toThrow()

    expect(db.receipts().find((row) => row.id === receiptId)).toMatchObject({
      actor_id: 'standalone-actor',
    })
  })

  it('rejects INSERT OR REPLACE for an existing receipt sequence with a fresh ID', async () => {
    const installation = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    const receiptId = crypto.randomUUID()
    insertNonTransitionReceipt(db, db.installations()[0], { id: receiptId, actor_id: 'original-actor' })
    const receipt = db.receipts().find((row) => row.id === receiptId)
    if (!receipt?.sequence) throw new Error('expected standalone receipt sequence')

    const replacementId = crypto.randomUUID()
    expect(db.harness.sqlite.prepare('PRAGMA recursive_triggers').get()).toMatchObject({ recursive_triggers: 0 })
    expect(() => db.harness.sqlite.prepare(`
      INSERT OR REPLACE INTO addon_receipts (
        sequence, id, tenant, installation_id, action, previous_state, next_state,
        addon_key, installed_version, publisher, trust_class,
        mupot_compatibility, manifest_sha256, actor_id, outcome,
        side_effect_ids, checks, error_code, created_at
      )
      SELECT ?, ?, tenant, installation_id, action, previous_state, next_state,
             addon_key, installed_version, publisher, trust_class,
             mupot_compatibility, manifest_sha256, 'replacement-actor', outcome,
             side_effect_ids, checks, error_code, created_at
        FROM addon_receipts
       WHERE id = ?
    `).run(receipt.sequence, replacementId, receipt.id))
      .toThrow('addon receipt sequences are immutable')

    expect(db.receipts().find((row) => row.id === receipt.id)).toMatchObject({
      sequence: receipt.sequence,
      actor_id: 'original-actor',
    })
    expect(db.receipts().some((row) => row.id === replacementId)).toBe(false)
    expect(installation.id).toBe(receipt.installation_id)
  })

  it('requires positive receipt sequences while preserving omitted autoincrement inserts', async () => {
    await installAddon(db.env, owner, 'fixture-addon')
    const receipt = db.receipts()[0]
    if (!receipt?.sequence) throw new Error('expected install receipt sequence')

    expect(receipt.sequence).toBeGreaterThan(0)
    expect(() => db.harness.sqlite.prepare(`
      INSERT INTO addon_receipts (
        sequence, id, tenant, installation_id, action, previous_state, next_state,
        addon_key, installed_version, publisher, trust_class,
        mupot_compatibility, manifest_sha256, actor_id, outcome,
        side_effect_ids, checks, error_code, created_at
      )
      SELECT 0, ?, tenant, installation_id, 'health', next_state, next_state,
             addon_key, installed_version, publisher, trust_class,
             mupot_compatibility, manifest_sha256, actor_id, outcome,
             side_effect_ids, checks, error_code, created_at
        FROM addon_receipts
       WHERE id = ?
    `).run(crypto.randomUUID(), receipt.id)).toThrow()
  })

  it('rolls back a transition receipt whose identity snapshot does not match the installation', async () => {
    const installation = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))

    await expect(transitionInstallation(
      db,
      installation.id,
      'configure',
      'installed',
      'configured',
      { publisher: 'forged-publisher' },
    )).rejects.toThrow()
    expect(db.installations()[0].state).toBe('installed')
    expect(db.receipts()).toHaveLength(1)
  })
})

describe('addon install and configure service', () => {
  let db: Db

  beforeEach(() => {
    db = makeDb()
  })

  afterEach(() => db.harness.close())

  it('install is inert, tenant-scoped, actor-attributed, digest-bound, and identity-snapshotted', async () => {
    const result = await installAddon(db.env, owner, 'fixture-addon')
    const catalog = getRegisteredAddon('fixture-addon')

    expect(result).toMatchObject({
      ok: true,
      state: 'installed',
      created: true,
      installation: { latestPreviousState: null },
    })
    expect(db.departments()).toHaveLength(0)
    expect(db.resources()).toHaveLength(0)
    expect(db.installations()[0]).toMatchObject({
      tenant: 'tenant-a',
      addon_key: 'fixture-addon',
      latest_previous_state: null,
      manifest_sha256: catalog?.manifestSha256,
      installed_by: owner.id,
      latest_actor_id: owner.id,
    })
    expect(db.receipts()[0]).toMatchObject({
      tenant: 'tenant-a',
      action: 'install',
      previous_state: null,
      next_state: 'installed',
      addon_key: catalog?.manifest.key,
      installed_version: catalog?.manifest.version,
      publisher: catalog?.manifest.publisher,
      trust_class: catalog?.manifest.trustClass,
      mupot_compatibility: catalog?.manifest.mupotCompatibility,
      manifest_sha256: catalog?.manifestSha256,
      actor_id: owner.id,
      outcome: 'pass',
      side_effect_ids: '[]',
    })
  })

  it('concurrent install creates one live installation and one install receipt', async () => {
    const results = await Promise.all([
      installAddon(db.env, owner, 'fixture-addon'),
      installAddon(db.env, admin, 'fixture-addon'),
    ])

    expect(results.filter((result) => result.ok && result.created === true)).toHaveLength(1)
    expect(results.filter((result) => result.ok && result.idempotent === true)).toHaveLength(1)
    expect(db.installations()).toHaveLength(1)
    expect(db.receipts()).toHaveLength(1)
  })

  it('repeated install returns existing state without duplicate receipts', async () => {
    const first = await installAddon(db.env, owner, 'fixture-addon')
    const second = await installAddon(db.env, admin, 'fixture-addon')

    expect(first).toMatchObject({ ok: true, state: 'installed', created: true })
    expect(second).toMatchObject({ ok: true, state: 'installed', idempotent: true })
    expect(db.installations()).toHaveLength(1)
    expect(db.receipts()).toHaveLength(1)
    expect(db.installations()[0].latest_actor_id).toBe(owner.id)
  })

  it('writes installation and install receipt atomically', async () => {
    db.harness.sqlite.exec(`
      CREATE TRIGGER reject_install_receipt
      BEFORE INSERT ON addon_receipts
      WHEN NEW.action = 'install'
      BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END
    `)

    expect(await installAddon(db.env, owner, 'fixture-addon')).toEqual({ ok: false, reason: 'write_failed' })
    expect(db.installations()).toHaveLength(0)
    expect(db.receipts()).toHaveLength(0)
  })

  it('returns the exact committed install when it is archived and replaced after its batch', async () => {
    let committedId = ''
    let committedReceiptId = ''
    let replacementId = ''
    const racingEnv = withPostBatchRace(
      db,
      (sql) => sql.includes('INSERT INTO addon_installations'),
      async () => {
        const committed = db.installations()[0]
        committedId = committed.id
        committedReceiptId = committed.latest_receipt_id
        await transitionInstallation(db, committed.id, 'disable', 'installed', 'disabled')
        await transitionInstallation(db, committed.id, 'archive', 'disabled', 'archived')
        replacementId = successfulInstallation(await installAddon(db.env, admin, 'fixture-addon')).id
      },
    )

    const result = await installAddon(racingEnv, owner, 'fixture-addon')
    const returned = successfulInstallation(result)

    expect(result).toMatchObject({ ok: true, state: 'installed', created: true })
    expect(returned).toMatchObject({
      id: committedId,
      state: 'installed',
      latestReceiptId: committedReceiptId,
    })
    expect(returned.id).not.toBe(replacementId)
  })

  it('configure CAS advances only an installed matching digest and stays inert', async () => {
    await installAddon(db.env, owner, 'fixture-addon')

    expect(await configureAddon(db.env, admin, 'fixture-addon')).toMatchObject({
      ok: true,
      state: 'configured',
      installation: { latestPreviousState: 'installed' },
    })
    expect(await configureAddon(db.env, owner, 'fixture-addon')).toMatchObject({
      ok: true,
      state: 'configured',
      idempotent: true,
    })
    expect(db.departments()).toHaveLength(0)
    expect(db.resources()).toHaveLength(0)
    expect(db.installations()[0]).toMatchObject({
      state: 'configured',
      latest_previous_state: 'installed',
      latest_actor_id: admin.id,
    })
    expect(db.receipts()).toHaveLength(2)
    expect(db.receipts().find((receipt) => receipt.action === 'configure')).toMatchObject({
      action: 'configure',
      previous_state: 'installed',
      next_state: 'configured',
      addon_key: 'fixture-addon',
      installed_version: '1.0.0',
      publisher: 'mumega',
      trust_class: 'native_reviewed',
      actor_id: admin.id,
      outcome: 'pass',
      side_effect_ids: '[]',
    })
  })

  it.each([
    ['installed version', { installedVersion: '9.9.9' }],
    ['publisher', { publisher: 'forged-publisher' }],
    ['MuPot compatibility', { mupotCompatibility: '^99.0.0' }],
  ] as const)('configure rejects stored %s drift even when the digest matches', async (_field, overrides) => {
    await insertInstallationLifecycle(db, { addonKey: 'fixture-addon', ...overrides })

    expect(await configureAddon(db.env, owner, 'fixture-addon')).toEqual({
      ok: false,
      reason: 'manifest_digest_drift',
    })
    expect(db.installations()[0].state).toBe('installed')
    expect(db.receipts()).toHaveLength(1)
  })

  it('concurrent configure commits one transition receipt and returns one idempotent result', async () => {
    await installAddon(db.env, owner, 'fixture-addon')

    const results = await Promise.all([
      configureAddon(db.env, owner, 'fixture-addon'),
      configureAddon(db.env, admin, 'fixture-addon'),
    ])

    expect(results.every((result) => result.ok && result.state === 'configured')).toBe(true)
    expect(results.filter((result) => result.ok && result.idempotent === true)).toHaveLength(1)
    expect(db.installations()).toHaveLength(1)
    expect(db.receipts().filter((receipt) => receipt.action === 'configure')).toHaveLength(1)
    expect(db.receipts()).toHaveLength(2)
  })

  it('returns the exact configured lifecycle when it is archived and replaced after its batch', async () => {
    const original = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    let configuredReceiptId = ''
    let replacementId = ''
    const racingEnv = withPostBatchRace(
      db,
      (sql) => sql.includes("SET state = 'configured'"),
      async () => {
        configuredReceiptId = db.installations()[0].latest_receipt_id
        await transitionInstallation(db, original.id, 'disable', 'configured', 'disabled')
        await transitionInstallation(db, original.id, 'archive', 'disabled', 'archived')
        replacementId = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon')).id
      },
    )

    const result = await configureAddon(racingEnv, admin, 'fixture-addon')
    const returned = successfulInstallation(result)

    expect(result).toMatchObject({ ok: true, state: 'configured' })
    expect(returned).toMatchObject({
      id: original.id,
      state: 'configured',
      latestPreviousState: 'installed',
      latestReceiptId: configuredReceiptId,
    })
    expect(returned.id).not.toBe(replacementId)
  })

  it('rolls configure state back when its receipt write fails', async () => {
    await installAddon(db.env, owner, 'fixture-addon')
    db.harness.sqlite.exec(`
      CREATE TRIGGER reject_configure_receipt
      BEFORE INSERT ON addon_receipts
      WHEN NEW.action = 'configure'
      BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END
    `)

    expect(await configureAddon(db.env, owner, 'fixture-addon')).toEqual({ ok: false, reason: 'write_failed' })
    expect(db.installations()[0].state).toBe('installed')
    expect(db.receipts()).toHaveLength(1)
  })

  it('reinstalls archived addons with a new ID and no carried ownership', async () => {
    const first = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    insertOwnership(db, 'released-old-claim', first.id, 'dept-old', 'co_owner', 0)

    await transitionInstallation(db, first.id, 'disable', 'installed', 'disabled')
    await transitionInstallation(db, first.id, 'archive', 'disabled', 'archived')

    const secondResult = await installAddon(db.env, admin, 'fixture-addon')
    const second = successfulInstallation(secondResult)

    expect(secondResult).toMatchObject({ ok: true, state: 'installed', created: true })
    expect(second.id).not.toBe(first.id)
    expect(db.installations().map((row) => row.state).sort()).toEqual(['archived', 'installed'])
    expect(db.resources()).toHaveLength(1)
    expect(db.resources()[0]).toMatchObject({ installation_id: first.id, active: 0 })
    expect(db.resources().some((row) => row.installation_id === second.id)).toBe(false)
    expect(db.receipts().filter((receipt) => receipt.installation_id === second.id)).toHaveLength(1)
  })

  it('rejects manifest digest drift without writing another receipt', async () => {
    await insertInstallationLifecycle(db, {
      addonKey: 'fixture-addon',
      manifestSha256: 'b'.repeat(64),
    })

    expect(await installAddon(db.env, owner, 'fixture-addon')).toEqual({
      ok: false,
      reason: 'manifest_digest_drift',
    })
    expect(await configureAddon(db.env, owner, 'fixture-addon')).toEqual({
      ok: false,
      reason: 'manifest_digest_drift',
    })
    expect(db.receipts()).toHaveLength(1)
  })

  it('returns stable failures for unknown addons, unauthorized actors, and invalid states', async () => {
    expect(await installAddon(db.env, owner, 'unknown-addon')).toEqual({
      ok: false,
      reason: 'addon_not_registered',
    })
    expect(await installAddon(db.env, { id: 'member-1', role: 'member' }, 'fixture-addon')).toEqual({
      ok: false,
      reason: 'not_authorized',
    })
    expect(await configureAddon(db.env, owner, 'fixture-addon')).toEqual({ ok: false, reason: 'invalid_state' })

    const installed = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    await transitionInstallation(db, installed.id, 'disable', 'installed', 'disabled')
    expect(await configureAddon(db.env, owner, 'fixture-addon')).toEqual({
      ok: false,
      reason: 'invalid_state',
      state: 'disabled',
    })
  })

  it('lists installations and receipts only for the current tenant', async () => {
    const installed = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))

    expect(await listAddonInstallations(db.env)).toHaveLength(1)
    expect(await getAddonReceipts(db.env, installed.id)).toHaveLength(1)

    const otherEnv = { ...db.env, TENANT_SLUG: 'tenant-b' }
    expect(await listAddonInstallations(otherEnv)).toEqual([])
    expect(await getAddonReceipts(otherEnv, installed.id)).toEqual([])
  })

  it('orders same-millisecond receipts by persisted lifecycle sequence rather than receipt ID', async () => {
    const createdAt = '2026-07-16T00:00:00.000Z'
    const installation = await insertInstallationLifecycle(db, {
      addonKey: 'same-time-addon',
      receiptId: 'z-install-receipt',
      createdAt,
    })
    await transitionInstallation(
      db,
      installation.id,
      'configure',
      'installed',
      'configured',
      { receiptId: 'a-configure-receipt', createdAt },
    )

    const receipts = await getAddonReceipts(db.env, installation.id)

    expect(receipts.map((receipt) => receipt.id)).toEqual([
      'a-configure-receipt',
      'z-install-receipt',
    ])
    expect(receipts.map((receipt) => receipt.sequence)).toEqual([2, 1])
  })

  it('fails closed when stored receipt JSON is malformed', async () => {
    const installed = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    const receipt = db.receipts()[0]

    db.harness.sqlite.exec('DROP TRIGGER IF EXISTS addon_receipts_no_update')
    db.harness.sqlite.exec('PRAGMA ignore_check_constraints = ON')
    db.harness.sqlite.prepare('UPDATE addon_receipts SET side_effect_ids = ? WHERE id = ?')
      .run('{not-json', receipt.id)
    db.harness.sqlite.exec('PRAGMA ignore_check_constraints = OFF')

    await expect(getAddonReceipts(db.env, installed.id)).rejects.toThrow('invalid addon receipt JSON')
  })
})

describe('addon activation, disable, reactivation, and archive service', () => {
  let db: Db

  beforeEach(() => {
    db = makeDb()
  })

  afterEach(() => db.harness.close())

  async function configureFixture(actor = owner) {
    await installAddon(db.env, actor, 'fixture-addon')
    await configureAddon(db.env, actor, 'fixture-addon')
  }

  async function activateFixture(actor = owner, deps?: AddonLifecycleDeps) {
    await configureFixture(actor)
    return activateAddon(db.env, actor, 'fixture-addon', deps)
  }

  it('activates once with one owned department, one seed, one operation, and one exact receipt', async () => {
    await configureFixture()

    const first = await activateAddon(db.env, admin, 'fixture-addon')
    const second = await activateAddon(db.env, owner, 'fixture-addon')

    expect(first).toMatchObject({
      ok: true,
      state: 'active',
      installation: { latestPreviousState: 'configured', latestActorId: admin.id },
    })
    expect(second).toMatchObject({ ok: true, state: 'active', idempotent: true })
    expect(db.departments()).toHaveLength(1)
    expect(db.departments()[0]).toMatchObject({ slug: 'fixture', active: 1 })
    expect(db.squads()).toHaveLength(1)
    expect(db.resources()).toHaveLength(1)
    expect(db.resources()[0]).toMatchObject({
      tenant: db.env.TENANT_SLUG,
      installation_id: successfulInstallation(first).id,
      resource_type: 'department',
      resource_id: db.departments()[0].id,
      resource_key: 'fixture',
      ownership_mode: 'co_owner',
      active: 1,
    })
    expect(db.operations()).toEqual([
      expect.objectContaining({
        tenant: db.env.TENANT_SLUG,
        installation_id: successfulInstallation(first).id,
        action: 'activate',
        target_state: 'active',
        current_step: 'completed',
        status: 'completed',
        actor_id: admin.id,
      }),
    ])

    const activateReceipts = db.receipts().filter((receipt) => receipt.action === 'activate')
    expect(activateReceipts).toHaveLength(1)
    expect(activateReceipts[0]).toMatchObject({
      tenant: db.env.TENANT_SLUG,
      installation_id: successfulInstallation(first).id,
      previous_state: 'configured',
      next_state: 'active',
      actor_id: admin.id,
      outcome: 'pass',
      side_effect_ids: JSON.stringify([db.resources()[0].id]),
    })
    expect(JSON.parse(activateReceipts[0].checks)).toEqual({
      authorityRequests: 'empty',
      connectorRequirements: 'empty',
      departments: [{
        claimId: db.resources()[0].id,
        departmentId: db.departments()[0].id,
        moduleKey: 'fixture',
      }],
      manifestDigest: 'matched',
      operationId: db.operations()[0].id,
    })
  })

  it('resumes interruption after department activation without duplicate seeds, claims, or operations', async () => {
    await configureFixture()
    let interrupted = false
    const deps: AddonLifecycleDeps = {
      afterDepartmentActivated() {
        if (!interrupted) {
          interrupted = true
          throw new Error('interrupt after department activation')
        }
      },
    }

    expect(await activateAddon(db.env, owner, 'fixture-addon', deps)).toEqual({
      ok: false,
      reason: 'write_failed',
    })
    expect(db.installations()[0].state).toBe('configured')
    expect(db.departments()).toHaveLength(1)
    expect(db.squads()).toHaveLength(1)
    expect(db.resources()).toHaveLength(0)
    expect(db.operations()).toEqual([
      expect.objectContaining({ action: 'activate', current_step: 'activate_departments', status: 'running' }),
    ])
    expect(db.receipts().filter((receipt) => receipt.action === 'activate')).toHaveLength(0)

    expect(await activateAddon(db.env, admin, 'fixture-addon', deps)).toMatchObject({
      ok: true,
      state: 'active',
    })
    expect(db.departments()).toHaveLength(1)
    expect(db.squads()).toHaveLength(1)
    expect(db.resources()).toHaveLength(1)
    expect(db.operations()).toEqual([
      expect.objectContaining({ action: 'activate', current_step: 'completed', status: 'completed', actor_id: owner.id }),
    ])
    expect(db.receipts().filter((receipt) => receipt.action === 'activate')).toEqual([
      expect.objectContaining({ actor_id: owner.id, previous_state: 'configured', next_state: 'active' }),
    ])
  })

  it('changes state and writes the exact disable receipt before resumable teardown', async () => {
    const active = successfulInstallation(await activateFixture(admin))
    const claimId = db.resources()[0].id as string
    let interrupted = false
    const deps: AddonLifecycleDeps = {
      afterInstallationDisabled() {
        if (!interrupted) {
          interrupted = true
          throw new Error('interrupt after disabled state')
        }
      },
    }

    expect(await disableAddon(db.env, owner, 'fixture-addon', deps)).toEqual({
      ok: false,
      reason: 'write_failed',
    })
    expect(db.installations()[0]).toMatchObject({
      id: active.id,
      state: 'disabled',
      latest_previous_state: 'active',
      latest_actor_id: owner.id,
    })
    expect(db.departments()[0]).toMatchObject({ active: 1 })
    expect(db.resources()[0]).toMatchObject({ id: claimId, active: 1, released_at: null })
    expect(db.operations().find((operation) => operation.action === 'disable')).toMatchObject({
      current_step: 'disable_teardown',
      status: 'running',
      actor_id: owner.id,
    })
    expect(db.receipts().filter((receipt) => receipt.action === 'disable')).toEqual([
      expect.objectContaining({
        tenant: db.env.TENANT_SLUG,
        installation_id: active.id,
        previous_state: 'active',
        next_state: 'disabled',
        actor_id: owner.id,
        side_effect_ids: JSON.stringify([claimId]),
      }),
    ])

    expect(await disableAddon(db.env, admin, 'fixture-addon', deps)).toMatchObject({
      ok: true,
      state: 'disabled',
    })
    expect(db.departments()[0]).toMatchObject({ active: 0 })
    expect(db.resources()).toEqual([
      expect.objectContaining({ id: claimId, installation_id: active.id, active: 0 }),
    ])
    expect(db.operations().find((operation) => operation.action === 'disable')).toMatchObject({
      current_step: 'completed',
      status: 'completed',
      actor_id: owner.id,
    })
    expect(db.receipts().filter((receipt) => receipt.action === 'disable')).toHaveLength(1)
  })

  it('resumes interruption after deactivation and before claim release', async () => {
    const active = successfulInstallation(await activateFixture())
    const claimId = db.resources()[0].id as string
    let interrupted = false
    const deps: AddonLifecycleDeps = {
      afterDepartmentDeactivated() {
        if (!interrupted) {
          interrupted = true
          throw new Error('interrupt before claim release')
        }
      },
    }

    expect(await disableAddon(db.env, owner, 'fixture-addon', deps)).toEqual({
      ok: false,
      reason: 'write_failed',
    })
    expect(db.installations()[0]).toMatchObject({ id: active.id, state: 'disabled' })
    expect(db.departments()[0]).toMatchObject({ active: 0 })
    expect(db.resources()).toEqual([
      expect.objectContaining({ id: claimId, installation_id: active.id, active: 1 }),
    ])
    expect(db.operations().find((operation) => operation.action === 'disable')).toMatchObject({
      current_step: `disable_claim:${claimId}`,
      status: 'running',
    })

    expect(await disableAddon(db.env, admin, 'fixture-addon', deps)).toMatchObject({
      ok: true,
      state: 'disabled',
    })
    expect(db.resources()).toEqual([
      expect.objectContaining({ id: claimId, installation_id: active.id, active: 0 }),
    ])
    expect(db.operations().find((operation) => operation.action === 'disable')).toMatchObject({
      current_step: 'completed',
      status: 'completed',
      actor_id: owner.id,
    })
    expect(db.receipts().filter((receipt) => receipt.action === 'disable')).toHaveLength(1)
  })

  it('reactivates the released claim in place and never duplicates department seeds', async () => {
    const active = successfulInstallation(await activateFixture())
    const claim = db.resources()[0]
    const department = db.departments()[0]

    expect(await disableAddon(db.env, owner, 'fixture-addon')).toMatchObject({ ok: true, state: 'disabled' })
    expect(await activateAddon(db.env, admin, 'fixture-addon')).toMatchObject({ ok: true, state: 'active' })

    expect(db.departments()).toEqual([expect.objectContaining({ id: department.id, active: 1 })])
    expect(db.squads()).toHaveLength(1)
    expect(db.resources()).toEqual([
      expect.objectContaining({
        id: claim.id,
        installation_id: active.id,
        resource_id: department.id,
        active: 1,
        released_at: null,
      }),
    ])
    expect(db.receipts().filter((receipt) => receipt.action === 'activate')).toEqual([
      expect.objectContaining({ previous_state: 'configured', next_state: 'active', actor_id: owner.id }),
      expect.objectContaining({ previous_state: 'disabled', next_state: 'active', actor_id: admin.id }),
    ])
    expect(new Set(db.receipts().map((receipt) => receipt.id)).size).toBe(db.receipts().length)
  })

  it('releases only this installation claim and keeps a shared department active for its co-owner', async () => {
    const first = successfulInstallation(await activateFixture())
    const departmentId = db.departments()[0].id as string
    const second = await insertInstallationLifecycle(db, { addonKey: 'fixture-addon-co-owner' })
    await transitionInstallation(db, second.id, 'configure', 'installed', 'configured')
    await transitionInstallation(db, second.id, 'activate', 'configured', 'active')
    insertOwnership(db, 'co-owner-claim', second.id, departmentId, 'co_owner')

    expect(await disableAddon(db.env, admin, 'fixture-addon')).toMatchObject({ ok: true, state: 'disabled' })

    expect(db.departments()[0]).toMatchObject({ id: departmentId, active: 1 })
    expect(db.resources().find((claim) => claim.installation_id === first.id)).toMatchObject({ active: 0 })
    expect(db.resources().find((claim) => claim.installation_id === second.id)).toMatchObject({
      id: 'co-owner-claim',
      active: 1,
      released_at: null,
    })
  })

  it('rechecks co-owners when a shared claim appears during disable teardown', async () => {
    const first = successfulInstallation(await activateFixture())
    const departmentId = db.departments()[0].id as string
    const second = await insertInstallationLifecycle(db, { addonKey: 'fixture-addon-racing-co-owner' })
    await transitionInstallation(db, second.id, 'configure', 'installed', 'configured')
    await transitionInstallation(db, second.id, 'activate', 'configured', 'active')
    let injected = false
    const deps: AddonLifecycleDeps = {
      beforeDepartmentDeactivated() {
        if (!injected) {
          injected = true
          insertOwnership(db, 'racing-co-owner-claim', second.id, departmentId, 'co_owner')
        }
      },
    }

    expect(await disableAddon(db.env, admin, 'fixture-addon', deps)).toMatchObject({
      ok: true,
      state: 'disabled',
    })
    expect(injected).toBe(true)
    expect(db.departments()[0]).toMatchObject({ id: departmentId, active: 1 })
    expect(db.resources().find((claim) => claim.installation_id === first.id)).toMatchObject({ active: 0 })
    expect(db.resources().find((claim) => claim.installation_id === second.id)).toMatchObject({
      id: 'racing-co-owner-claim',
      active: 1,
    })
  })

  it('restores a shared department when a co-owner races the deactivation call', async () => {
    const first = successfulInstallation(await activateFixture())
    const departmentId = db.departments()[0].id as string
    const second = await insertInstallationLifecycle(db, { addonKey: 'fixture-addon-late-co-owner' })
    await transitionInstallation(db, second.id, 'configure', 'installed', 'configured')
    await transitionInstallation(db, second.id, 'activate', 'configured', 'active')
    let injected = false
    const deps: AddonLifecycleDeps = {
      async deactivateDepartment(database, moduleKey) {
        if (!injected) {
          injected = true
          insertOwnership(db, 'late-co-owner-claim', second.id, departmentId, 'co_owner')
        }
        return deactivateDepartment(database, moduleKey)
      },
    }

    expect(await disableAddon(db.env, owner, 'fixture-addon', deps)).toMatchObject({
      ok: true,
      state: 'disabled',
    })
    expect(injected).toBe(true)
    expect(db.departments()[0]).toMatchObject({ id: departmentId, active: 1 })
    expect(db.squads()).toHaveLength(1)
    expect(db.resources().find((claim) => claim.installation_id === first.id)).toMatchObject({ active: 0 })
    expect(db.resources().find((claim) => claim.installation_id === second.id)).toMatchObject({
      id: 'late-co-owner-claim',
      active: 1,
    })
  })

  it('resumes teardown when co-owners release together and interruption follows this claim release', async () => {
    const first = successfulInstallation(await activateFixture())
    const firstClaimId = db.resources()[0].id as string
    const departmentId = db.departments()[0].id as string
    const second = await insertInstallationLifecycle(db, { addonKey: 'fixture-addon-releasing-co-owner' })
    await transitionInstallation(db, second.id, 'configure', 'installed', 'configured')
    await transitionInstallation(db, second.id, 'activate', 'configured', 'active')
    insertOwnership(db, 'releasing-co-owner-claim', second.id, departmentId, 'co_owner')
    let coOwnerReleased = false
    let interrupted = false
    const deps: AddonLifecycleDeps = {
      beforeOwnershipReleased() {
        if (!coOwnerReleased) {
          coOwnerReleased = true
          db.harness.sqlite.prepare(`
            UPDATE addon_resource_ownership
               SET active = 0, released_at = ?
             WHERE id = 'releasing-co-owner-claim'
          `).run(new Date().toISOString())
        }
      },
      afterOwnershipReleased() {
        if (!interrupted) {
          interrupted = true
          throw new Error('interrupt after ownership release')
        }
      },
    }

    expect(await disableAddon(db.env, owner, 'fixture-addon', deps)).toEqual({
      ok: false,
      reason: 'write_failed',
    })
    expect(db.installations().find((installation) => installation.id === first.id)).toMatchObject({
      id: first.id,
      state: 'disabled',
    })
    expect(db.departments()[0]).toMatchObject({ id: departmentId, active: 1 })
    expect(db.resources()).toEqual([
      expect.objectContaining({ id: firstClaimId, installation_id: first.id, active: 0 }),
      expect.objectContaining({ id: 'releasing-co-owner-claim', installation_id: second.id, active: 0 }),
    ])
    expect(db.operations().find((operation) => operation.action === 'disable')).toMatchObject({
      current_step: `disable_claim:${firstClaimId}`,
      status: 'running',
    })

    expect(await disableAddon(db.env, admin, 'fixture-addon', deps)).toMatchObject({
      ok: true,
      state: 'disabled',
    })
    expect(db.departments()[0]).toMatchObject({ id: departmentId, active: 0 })
    expect(db.resources()).toHaveLength(2)
    expect(db.resources().every((claim) => claim.active === 0)).toBe(true)
    expect(db.receipts().filter((receipt) => receipt.action === 'disable')).toHaveLength(1)
    expect(db.operations().find((operation) => operation.action === 'disable')).toMatchObject({
      current_step: 'completed',
      status: 'completed',
      actor_id: owner.id,
    })
  })

  it('archives only after disable teardown, deletes nothing, and cannot reactivate the archived lifecycle', async () => {
    const active = successfulInstallation(await activateFixture())
    const deps: AddonLifecycleDeps = {
      afterInstallationDisabled() {
        throw new Error('pause teardown')
      },
    }

    expect(await disableAddon(db.env, owner, 'fixture-addon', deps)).toEqual({
      ok: false,
      reason: 'write_failed',
    })
    expect(await archiveAddon(db.env, admin, 'fixture-addon')).toEqual({
      ok: false,
      reason: 'invalid_state',
      state: 'disabled',
    })
    expect(db.receipts().filter((receipt) => receipt.action === 'archive')).toHaveLength(0)

    deps.afterInstallationDisabled = undefined
    await disableAddon(db.env, admin, 'fixture-addon', deps)
    const receiptCountBeforeArchive = db.receipts().length
    const archived = await archiveAddon(db.env, admin, 'fixture-addon')

    expect(archived).toMatchObject({
      ok: true,
      state: 'archived',
      installation: {
        id: active.id,
        latestPreviousState: 'disabled',
        latestActorId: admin.id,
      },
    })
    expect(db.installations()).toEqual([expect.objectContaining({ id: active.id, state: 'archived' })])
    expect(db.departments()).toEqual([expect.objectContaining({ active: 0 })])
    expect(db.squads()).toHaveLength(1)
    expect(db.resources()).toEqual([
      expect.objectContaining({ installation_id: active.id, active: 0 }),
    ])
    expect(db.receipts()).toHaveLength(receiptCountBeforeArchive + 1)
    expect(db.receipts().filter((receipt) => receipt.action === 'archive')).toEqual([
      expect.objectContaining({
        previous_state: 'disabled',
        next_state: 'archived',
        actor_id: admin.id,
        side_effect_ids: '[]',
      }),
    ])
    expect(await activateAddon(db.env, owner, 'fixture-addon')).toEqual({
      ok: false,
      reason: 'invalid_state',
    })
  })

  it('serializes concurrent activation and disable without duplicate claims or lifecycle receipts', async () => {
    await configureFixture()

    const activations = await Promise.all([
      activateAddon(db.env, owner, 'fixture-addon'),
      activateAddon(db.env, admin, 'fixture-addon'),
    ])

    expect(activations.every((result) => result.ok && result.state === 'active')).toBe(true)
    expect(db.departments()).toHaveLength(1)
    expect(db.squads()).toHaveLength(1)
    expect(db.resources()).toHaveLength(1)
    expect(db.receipts().filter((receipt) => receipt.action === 'activate')).toHaveLength(1)
    expect(db.operations().filter((operation) => operation.action === 'activate')).toHaveLength(1)

    const disables = await Promise.all([
      disableAddon(db.env, owner, 'fixture-addon'),
      disableAddon(db.env, admin, 'fixture-addon'),
    ])

    expect(disables.every((result) => result.ok && result.state === 'disabled')).toBe(true)
    expect(db.resources()).toEqual([expect.objectContaining({ active: 0 })])
    expect(db.receipts().filter((receipt) => receipt.action === 'disable')).toHaveLength(1)
    expect(db.operations().filter((operation) => operation.action === 'disable')).toHaveLength(1)
  })

  it('fails activation closed when its running operation disappears before the transition batch', async () => {
    await configureFixture()
    const priorReceiptId = db.installations()[0].latest_receipt_id
    const racingEnv = withPreBatchRace(
      db,
      (sql) => sql.includes("SET state = 'active'"),
      async () => {
        db.harness.sqlite.prepare(`
          DELETE FROM addon_operations WHERE tenant = ? AND action = 'activate' AND status = 'running'
        `).run(db.env.TENANT_SLUG)
      },
    )

    expect(await activateAddon(racingEnv, owner, 'fixture-addon')).toEqual({
      ok: false,
      reason: 'write_failed',
    })
    expect(db.installations()[0]).toMatchObject({
      state: 'configured',
      latest_receipt_id: priorReceiptId,
    })
    expect(db.receipts().filter((receipt) => receipt.action === 'activate')).toHaveLength(0)
    expect(db.resources()).toHaveLength(1)

    expect(await activateAddon(db.env, admin, 'fixture-addon')).toMatchObject({ ok: true, state: 'active' })
    expect(db.resources()).toHaveLength(1)
    expect(db.receipts().filter((receipt) => receipt.action === 'activate')).toHaveLength(1)
  })

  it('fails disable closed when its running operation disappears before the state-first receipt batch', async () => {
    await activateFixture()
    const before = db.installations()[0]
    const racingEnv = withPreBatchRace(
      db,
      (sql) => sql.includes("SET state = 'disabled'"),
      async () => {
        db.harness.sqlite.prepare(`
          DELETE FROM addon_operations WHERE tenant = ? AND action = 'disable' AND status = 'running'
        `).run(db.env.TENANT_SLUG)
      },
    )

    expect(await disableAddon(racingEnv, owner, 'fixture-addon')).toEqual({
      ok: false,
      reason: 'write_failed',
    })
    expect(db.installations()[0]).toMatchObject({
      state: 'active',
      latest_receipt_id: before.latest_receipt_id,
    })
    expect(db.resources()).toEqual([expect.objectContaining({ active: 1 })])
    expect(db.receipts().filter((receipt) => receipt.action === 'disable')).toHaveLength(0)
  })

  it('fails archive closed when its running operation disappears before the soft-archive batch', async () => {
    await activateFixture()
    await disableAddon(db.env, owner, 'fixture-addon')
    const before = db.installations()[0]
    const racingEnv = withPreBatchRace(
      db,
      (sql) => sql.includes("SET state = 'archived'"),
      async () => {
        db.harness.sqlite.prepare(`
          DELETE FROM addon_operations WHERE tenant = ? AND action = 'archive' AND status = 'running'
        `).run(db.env.TENANT_SLUG)
      },
    )

    expect(await archiveAddon(racingEnv, admin, 'fixture-addon')).toEqual({
      ok: false,
      reason: 'write_failed',
    })
    expect(db.installations()[0]).toMatchObject({
      state: 'disabled',
      latest_receipt_id: before.latest_receipt_id,
    })
    expect(db.receipts().filter((receipt) => receipt.action === 'archive')).toHaveLength(0)
  })

  it('rejects unauthorized, cross-tenant, and digest-drift activation before journal or department writes', async () => {
    await configureFixture()
    const otherTenant = { ...db.env, TENANT_SLUG: 'tenant-b' }

    expect(await activateAddon(
      db.env,
      { id: 'member-1', role: 'member' },
      'fixture-addon',
    )).toEqual({ ok: false, reason: 'not_authorized' })
    expect(await activateAddon(otherTenant, owner, 'fixture-addon')).toEqual({
      ok: false,
      reason: 'invalid_state',
    })
    expect(db.operations()).toHaveLength(0)
    expect(db.departments()).toHaveLength(0)

    db.harness.sqlite.exec('DROP TRIGGER IF EXISTS addon_installations_identity_is_immutable')
    db.harness.sqlite.prepare(`
      UPDATE addon_installations SET manifest_sha256 = ? WHERE tenant = ? AND addon_key = ?
    `).run('b'.repeat(64), db.env.TENANT_SLUG, 'fixture-addon')

    expect(await activateAddon(db.env, owner, 'fixture-addon')).toEqual({
      ok: false,
      reason: 'manifest_digest_drift',
    })
    expect(db.operations()).toHaveLength(0)
    expect(db.departments()).toHaveLength(0)
  })
})
