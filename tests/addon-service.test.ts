import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../src/types'
import { getRegisteredAddon } from '../src/addons/registry'
import {
  configureAddon,
  getAddonReceipts,
  installAddon,
  listAddonInstallations,
  type AddonMutationResult,
} from '../src/addons/service'
import { createSqliteD1 } from './helpers/sqlite-d1'

const migration = readFileSync(new URL('../migrations/0050_addons.sql', import.meta.url), 'utf8')
const owner = { id: 'owner-1', role: 'owner' } as const
const admin = { id: 'admin-1', role: 'admin' } as const

interface ReceiptRow {
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
  installed_by: string
  latest_actor_id: string
  latest_receipt_id: string
  installed_at: string
  updated_at: string
}

function makeDb(tenant = 'tenant-a') {
  const harness = createSqliteD1()
  harness.sqlite.exec('CREATE TABLE departments (id TEXT PRIMARY KEY)')
  harness.sqlite.exec(migration)

  return {
    harness,
    env: { DB: harness.db, TENANT_SLUG: tenant } as Env,
    departments: () => harness.sqlite.prepare('SELECT * FROM departments').all(),
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
    trustClass: string
    manifestSha256: string
    state: string
  }> = {},
) {
  const catalog = getRegisteredAddon('fixture-addon')
  if (!catalog) throw new Error('fixture addon is not registered')

  const id = overrides.id ?? crypto.randomUUID()
  const receiptId = overrides.receiptId ?? crypto.randomUUID()
  const tenant = overrides.tenant ?? db.env.TENANT_SLUG
  const addonKey = overrides.addonKey ?? `fixture-${id}`
  const trustClass = overrides.trustClass ?? catalog.manifest.trustClass
  const digest = overrides.manifestSha256 ?? catalog.manifestSha256
  const state = overrides.state ?? 'installed'
  const now = new Date().toISOString()

  await db.env.DB.batch([
    db.env.DB.prepare(`
      INSERT INTO addon_installations (
        id, tenant, addon_key, installed_version, publisher, trust_class,
        manifest_sha256, mupot_compatibility, state, installed_by,
        latest_actor_id, latest_receipt_id, installed_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11, ?12, ?12)
    `).bind(
      id,
      tenant,
      addonKey,
      catalog.manifest.version,
      catalog.manifest.publisher,
      trustClass,
      digest,
      catalog.manifest.mupotCompatibility,
      state,
      owner.id,
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
        ?8, ?9, ?10, 'pass', '[]', '{}', ?11
      )
    `).bind(
      receiptId,
      tenant,
      id,
      addonKey,
      catalog.manifest.version,
      catalog.manifest.publisher,
      trustClass,
      catalog.manifest.mupotCompatibility,
      digest,
      owner.id,
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
  } = {},
) {
  const installation = db.installations().find((row) => row.id === installationId)
  if (!installation) throw new Error('installation not found')

  const receiptId = crypto.randomUUID()
  const now = new Date().toISOString()
  const actorId = options.actorId ?? owner.id

  return db.env.DB.batch([
    db.env.DB.prepare(`
      UPDATE addon_installations
         SET state = ?1, latest_actor_id = ?2, latest_receipt_id = ?3, updated_at = ?4
       WHERE id = ?5 AND tenant = ?6 AND state = ?7
    `).bind(
      nextState,
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
        ?11, ?12, ?13, 'pass', '[]', '{}', ?14
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
      actorId,
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

  it('rejects state without its receipt and a receipt for a zero-row transition', async () => {
    const installation = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))

    await expect(db.env.DB.batch([
      db.env.DB.prepare(`
        UPDATE addon_installations
           SET state = 'configured', latest_receipt_id = 'missing-receipt'
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

  it('binds the latest receipt to the same installation and tenant', async () => {
    const installation = successfulInstallation(await installAddon(db.env, owner, 'fixture-addon'))
    const foreign = await insertInstallationLifecycle(db, {
      tenant: 'tenant-b',
      addonKey: 'fixture-addon',
    })

    await expect(db.env.DB.batch([
      db.env.DB.prepare(`
        UPDATE addon_installations
           SET state = 'configured', latest_actor_id = ?1, latest_receipt_id = ?2
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
           SET state = 'active', latest_actor_id = ?1, latest_receipt_id = ?2
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
           SET state = 'configured', latest_actor_id = ?1, latest_receipt_id = ?2, updated_at = ?3
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

    expect(result).toMatchObject({ ok: true, state: 'installed', created: true })
    expect(db.departments()).toHaveLength(0)
    expect(db.resources()).toHaveLength(0)
    expect(db.installations()[0]).toMatchObject({
      tenant: 'tenant-a',
      addon_key: 'fixture-addon',
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

  it('configure CAS advances only an installed matching digest and stays inert', async () => {
    await installAddon(db.env, owner, 'fixture-addon')

    expect(await configureAddon(db.env, admin, 'fixture-addon')).toMatchObject({ ok: true, state: 'configured' })
    expect(await configureAddon(db.env, owner, 'fixture-addon')).toMatchObject({
      ok: true,
      state: 'configured',
      idempotent: true,
    })
    expect(db.departments()).toHaveLength(0)
    expect(db.resources()).toHaveLength(0)
    expect(db.installations()[0]).toMatchObject({ state: 'configured', latest_actor_id: admin.id })
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
    await installAddon(db.env, owner, 'fixture-addon')
    db.harness.sqlite.prepare('UPDATE addon_installations SET manifest_sha256 = ? WHERE tenant = ? AND addon_key = ?')
      .run('b'.repeat(64), 'tenant-a', 'fixture-addon')

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
