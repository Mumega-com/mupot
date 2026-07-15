import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../src/types'
import { getRegisteredAddon } from '../src/addons/registry'
import {
  configureAddon,
  getAddonReceipts,
  installAddon,
  listAddonInstallations,
} from '../src/addons/service'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

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
  manifest_sha256: string
  state: string
  installed_by: string
  latest_actor_id: string
  latest_receipt_id: string | null
}

function makeDb(tenant = 'tenant-a') {
  const harness = createSqliteD1()
  harness.sqlite.exec('CREATE TABLE departments (id TEXT PRIMARY KEY)')
  harness.sqlite.exec(migration)

  return {
    harness,
    env: { DB: harness.db, TENANT_SLUG: tenant } as Env,
    departments: () => harness.sqlite.prepare('SELECT * FROM departments').all(),
    resources: () => harness.sqlite.prepare('SELECT * FROM addon_resource_ownership').all(),
    receipts: () => harness.sqlite.prepare('SELECT * FROM addon_receipts ORDER BY created_at, id').all() as ReceiptRow[],
    installations: () => harness.sqlite.prepare('SELECT * FROM addon_installations ORDER BY installed_at, id').all() as InstallationRow[],
  }
}

describe('addon migration constraints', () => {
  let harness: SqliteD1Harness

  beforeEach(() => {
    harness = createSqliteD1()
    harness.sqlite.exec(migration)
  })

  afterEach(() => harness.close())

  it('enforces installation trust, digest, state, and tenant-key uniqueness', () => {
    const insert = harness.sqlite.prepare(`
      INSERT INTO addon_installations (
        id, tenant, addon_key, installed_version, publisher, trust_class,
        manifest_sha256, mupot_compatibility, state, installed_by,
        latest_actor_id, installed_at, updated_at
      ) VALUES (?, ?, ?, '1.0.0', 'mumega', ?, ?, '^0.23.0', ?, 'owner-1', 'owner-1', ?, ?)
    `)
    const now = new Date().toISOString()
    const digest = 'a'.repeat(64)

    expect(() => insert.run('bad-trust', 'tenant-a', 'fixture-addon', 'external_isolated', digest, 'installed', now, now)).toThrow()
    expect(() => insert.run('bad-digest', 'tenant-a', 'fixture-addon', 'native_reviewed', 'short', 'installed', now, now)).toThrow()
    expect(() => insert.run('bad-state', 'tenant-a', 'fixture-addon', 'native_reviewed', digest, 'available', now, now)).toThrow()

    insert.run('install-a', 'tenant-a', 'fixture-addon', 'native_reviewed', digest, 'installed', now, now)
    expect(() => insert.run('install-b', 'tenant-a', 'fixture-addon', 'native_reviewed', digest, 'installed', now, now)).toThrow()
    expect(() => insert.run('install-c', 'tenant-b', 'fixture-addon', 'native_reviewed', digest, 'installed', now, now)).not.toThrow()
  })

  it('enforces operation, ownership, receipt, and one-running-operation constraints', () => {
    const now = new Date().toISOString()
    const digest = 'a'.repeat(64)
    harness.sqlite.exec(`
      INSERT INTO addon_installations (
        id, tenant, addon_key, installed_version, publisher, trust_class,
        manifest_sha256, mupot_compatibility, state, installed_by,
        latest_actor_id, installed_at, updated_at
      ) VALUES (
        'install-a', 'tenant-a', 'fixture-addon', '1.0.0', 'mumega',
        'native_reviewed', '${digest}', '^0.23.0', 'installed', 'owner-1',
        'owner-1', '${now}', '${now}'
      )
    `)

    expect(() => harness.sqlite.exec(`
      INSERT INTO addon_operations
        (id, tenant, installation_id, action, target_state, current_step, status, actor_id, created_at, updated_at)
      VALUES ('bad-action', 'tenant-a', 'install-a', 'install', 'active', 'start', 'running', 'owner-1', '${now}', '${now}')
    `)).toThrow()
    harness.sqlite.exec(`
      INSERT INTO addon_operations
        (id, tenant, installation_id, action, target_state, current_step, status, actor_id, created_at, updated_at)
      VALUES ('op-a', 'tenant-a', 'install-a', 'activate', 'active', 'start', 'running', 'owner-1', '${now}', '${now}')
    `)
    expect(() => harness.sqlite.exec(`
      INSERT INTO addon_operations
        (id, tenant, installation_id, action, target_state, current_step, status, actor_id, created_at, updated_at)
      VALUES ('op-b', 'tenant-a', 'install-a', 'disable', 'disabled', 'start', 'running', 'owner-1', '${now}', '${now}')
    `)).toThrow()
    expect(() => harness.sqlite.exec(`
      INSERT INTO addon_resource_ownership
        (id, tenant, installation_id, resource_type, resource_id, resource_key, ownership_mode, active, created_at)
      VALUES ('resource-a', 'tenant-a', 'install-a', 'department', 'dept-a', 'fixture', 'shared', 1, '${now}')
    `)).toThrow()
    expect(() => harness.sqlite.exec(`
      INSERT INTO addon_receipts
        (id, tenant, installation_id, action, manifest_sha256, actor_id, outcome, created_at)
      VALUES ('receipt-a', 'tenant-a', 'install-a', 'install', '${digest}', 'owner-1', 'unknown', '${now}')
    `)).toThrow()
  })
})

describe('addon install and configure service', () => {
  let db: ReturnType<typeof makeDb>

  beforeEach(() => {
    db = makeDb()
  })

  afterEach(() => db.harness.close())

  it('install is inert, tenant-scoped, actor-attributed, and digest-bound', async () => {
    const result = await installAddon(db.env, owner, 'fixture-addon')
    const catalog = getRegisteredAddon('fixture-addon')

    expect(result).toMatchObject({ ok: true, state: 'installed', created: true })
    expect(db.departments()).toHaveLength(0)
    expect(db.resources()).toHaveLength(0)
    expect(db.installations()[0]).toMatchObject({
      tenant: 'tenant-a',
      addon_key: 'fixture-addon',
      manifest_sha256: catalog?.manifestSha256,
      installed_by: 'owner-1',
      latest_actor_id: 'owner-1',
    })
    expect(db.receipts()[0]).toMatchObject({
      tenant: 'tenant-a',
      action: 'install',
      previous_state: null,
      next_state: 'installed',
      manifest_sha256: catalog?.manifestSha256,
      actor_id: 'owner-1',
      outcome: 'pass',
      side_effect_ids: '[]',
    })
  })

  it('repeated install returns existing state without duplicate receipts', async () => {
    const first = await installAddon(db.env, owner, 'fixture-addon')
    const second = await installAddon(db.env, admin, 'fixture-addon')

    expect(first).toMatchObject({ ok: true, state: 'installed', created: true })
    expect(second).toMatchObject({ ok: true, state: 'installed', idempotent: true })
    expect(db.installations()).toHaveLength(1)
    expect(db.receipts()).toHaveLength(1)
    expect(db.installations()[0].latest_actor_id).toBe('owner-1')
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
    expect(await configureAddon(db.env, owner, 'fixture-addon')).toMatchObject({ ok: true, state: 'configured', idempotent: true })
    expect(db.departments()).toHaveLength(0)
    expect(db.resources()).toHaveLength(0)
    expect(db.installations()[0]).toMatchObject({ state: 'configured', latest_actor_id: 'admin-1' })
    expect(db.receipts()).toHaveLength(2)
    expect(db.receipts().find((receipt) => receipt.action === 'configure')).toMatchObject({
      action: 'configure',
      previous_state: 'installed',
      next_state: 'configured',
      actor_id: 'admin-1',
      outcome: 'pass',
      side_effect_ids: '[]',
    })
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

  it('rejects manifest digest drift without writing another receipt', async () => {
    await installAddon(db.env, owner, 'fixture-addon')
    db.harness.sqlite.prepare('UPDATE addon_installations SET manifest_sha256 = ? WHERE tenant = ? AND addon_key = ?')
      .run('b'.repeat(64), 'tenant-a', 'fixture-addon')

    expect(await installAddon(db.env, owner, 'fixture-addon')).toEqual({ ok: false, reason: 'manifest_digest_drift' })
    expect(await configureAddon(db.env, owner, 'fixture-addon')).toEqual({ ok: false, reason: 'manifest_digest_drift' })
    expect(db.receipts()).toHaveLength(1)
  })

  it('returns stable failures for unknown addons, unauthorized actors, and invalid states', async () => {
    expect(await installAddon(db.env, owner, 'unknown-addon')).toEqual({ ok: false, reason: 'addon_not_registered' })
    expect(await installAddon(db.env, { id: 'member-1', role: 'member' }, 'fixture-addon')).toEqual({ ok: false, reason: 'not_authorized' })
    expect(await configureAddon(db.env, owner, 'fixture-addon')).toEqual({ ok: false, reason: 'invalid_state' })

    await installAddon(db.env, owner, 'fixture-addon')
    db.harness.sqlite.prepare("UPDATE addon_installations SET state = 'active' WHERE tenant = ? AND addon_key = ?")
      .run('tenant-a', 'fixture-addon')
    expect(await configureAddon(db.env, owner, 'fixture-addon')).toEqual({ ok: false, reason: 'invalid_state', state: 'active' })
  })

  it('lists installations and receipts only for the current tenant', async () => {
    const installed = await installAddon(db.env, owner, 'fixture-addon')
    expect(installed.ok).toBe(true)
    if (!installed.ok) throw new Error('expected fixture installation')

    expect(await listAddonInstallations(db.env)).toHaveLength(1)
    expect(await getAddonReceipts(db.env, installed.installation.id)).toHaveLength(1)

    const otherEnv = { ...db.env, TENANT_SLUG: 'tenant-b' }
    expect(await listAddonInstallations(otherEnv)).toEqual([])
    expect(await getAddonReceipts(otherEnv, installed.installation.id)).toEqual([])
  })
})
