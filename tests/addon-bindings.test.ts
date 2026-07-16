import { readFileSync } from 'node:fs'
import type { D1PreparedStatement, D1Result } from '@cloudflare/workers-types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  listAddonBindings,
  preflightAddonBindings,
} from '../src/addons/bindings'
import { getRegisteredAddon } from '../src/addons/registry'
import {
  activateAddon,
  archiveAddon,
  configureAddon,
  disableAddon,
  getAddonReceipts,
  installAddon,
  type AddonInstallation,
} from '../src/addons/service'
import { resolveConnectorByIdWithMeta } from '../src/connectors/service'
import type { AddonManifestV1 } from '../src/addons/contract'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const migrations = [
  '../migrations/0001_init.sql',
  '../migrations/0003_settings.sql',
  '../migrations/0023_connectors.sql',
  '../migrations/0029_department_microkernel.sql',
  '../migrations/0050_addons.sql',
  '../migrations/0052_addon_bindings.sql',
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))

const owner = { id: 'owner-1', role: 'owner' } as const
const firstPartyBinding = {
  slot: 'web_analytics',
  adapter: 'first_party',
  bindingKind: 'internal_adapter',
} as const

function insertConnector(
  harness: SqliteD1Harness,
  overrides: Partial<{ id: string; tenant: string; type: string; revokedAt: string | null }> = {},
): string {
  const id = overrides.id ?? crypto.randomUUID()
  harness.sqlite.prepare(`
    INSERT INTO connectors (
      id, tenant, type, label, encrypted_secret, meta, scope_type,
      scope_id, created_by, created_at, revoked_at
    ) VALUES (?, ?, ?, 'Binding fixture', 'opaque-ciphertext', '{"project":"safe"}',
      'pot', NULL, 'owner-1', '2026-07-16T00:00:00.000Z', ?)
  `).run(
    id,
    overrides.tenant ?? 'tenant-a',
    overrides.type ?? 'posthog',
    overrides.revokedAt ?? null,
  )
  return id
}

function withPreBatchHook(
  env: Env,
  matches: (sql: string) => boolean,
  hook: () => Promise<void>,
): Env {
  const originalDb = env.DB
  let pending = true
  return {
    ...env,
    DB: {
      prepare(sql: string) {
        return originalDb.prepare(sql)
      },
      async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
        if (pending && statements.some((statement) => matches(
          (statement as D1PreparedStatement & { sql: string }).sql,
        ))) {
          pending = false
          await hook()
        }
        return originalDb.batch<T>(statements)
      },
    } as Env['DB'],
  }
}

function withConcurrentPreflightBatches(env: Env): Env {
  const originalDb = env.DB
  let arrivals = 0
  let release!: () => void
  const released = new Promise<void>((resolve) => { release = resolve })
  return {
    ...env,
    DB: {
      prepare(sql: string) {
        return originalDb.prepare(sql)
      },
      async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
        if (statements.some((statement) => (
          (statement as D1PreparedStatement & { sql: string }).sql.includes("'preflight'")
        ))) {
          arrivals += 1
          if (arrivals === 2) release()
          await released
        }
        return originalDb.batch<T>(statements)
      },
    } as Env['DB'],
  }
}

async function installMarketing(env: Env): Promise<AddonInstallation> {
  const result = await installAddon(env, owner, 'marketing-cro-monitor')
  if (!result.ok) throw new Error(`install failed: ${result.reason}`)
  return result.installation
}

describe('addon connector bindings', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    for (const migration of migrations) harness.sqlite.exec(migration)
    harness.sqlite.prepare(`
      INSERT INTO org_settings (key, value) VALUES ('billing_state', ?)
    `).run(JSON.stringify({ tier: 'scale', event_id: 'binding-tests', effective_at: '2026-07-16T00:00:00.000Z' }))
    env = { DB: harness.db, TENANT_SLUG: 'tenant-a' } as Env
  })

  afterEach(() => harness.close())

  it('configures the required first-party slot without storing a credential', async () => {
    const installation = await installMarketing(env)

    const result = await configureAddon(env, owner, 'marketing-cro-monitor', {
      bindings: [firstPartyBinding],
    })

    expect(result).toMatchObject({ ok: true, state: 'configured' })
    expect(await listAddonBindings(env, installation.id)).toEqual([
      expect.objectContaining({
        slot: 'web_analytics',
        adapter: 'first_party',
        bindingKind: 'internal_adapter',
        capability: 'read',
        connectorId: null,
        revokedAt: null,
      }),
    ])
    const columns = harness.sqlite.prepare('PRAGMA table_info(addon_connector_bindings)').all()
    expect(columns.map((column) => column.name)).not.toContain('encrypted_secret')
    expect(JSON.stringify(await listAddonBindings(env, installation.id))).not.toContain('opaque-ciphertext')
  })

  it('creates one live generation even for an empty fixture configuration', async () => {
    const installed = await installAddon(env, owner, 'fixture-addon')
    if (!installed.ok) throw new Error(`install failed: ${installed.reason}`)

    await expect(configureAddon(env, owner, 'fixture-addon')).resolves.toMatchObject({
      ok: true,
      state: 'configured',
    })
    expect(harness.sqlite.prepare(`
      SELECT installation_id, revoked_at FROM addon_binding_generations
       WHERE tenant = 'tenant-a' AND installation_id = ?
    `).all(installed.installation.id)).toEqual([
      { installation_id: installed.installation.id, revoked_at: null },
    ])
    expect(await listAddonBindings(env, installed.installation.id)).toEqual([])
  })

  it('resolves safe connector metadata by exact tenant-local ID without selecting a secret', async () => {
    const connectorId = insertConnector(harness)

    await expect(resolveConnectorByIdWithMeta(env, connectorId)).resolves.toEqual({
      id: connectorId,
      type: 'posthog',
      label: 'Binding fixture',
      meta: '{"project":"safe"}',
      scopeType: 'pot',
      scopeId: null,
      createdAt: '2026-07-16T00:00:00.000Z',
    })
    await expect(resolveConnectorByIdWithMeta({ ...env, TENANT_SLUG: 'tenant-b' }, connectorId)).resolves.toBeNull()
  })

  it('rejects cross-tenant, revoked, wrong-type, and write-widened bindings', async () => {
    const installation = await installMarketing(env)
    const entry = getRegisteredAddon('marketing-cro-monitor')
    if (!entry) throw new Error('marketing addon missing')
    const crossTenant = insertConnector(harness, { tenant: 'tenant-b' })
    const revoked = insertConnector(harness, { revokedAt: '2026-07-16T01:00:00.000Z' })
    const wrongType = insertConnector(harness, { type: 'mcpwp' })
    const inputFor = (connectorId: string) => [{
      slot: 'web_analytics',
      adapter: 'posthog',
      bindingKind: 'vault_connector' as const,
      connectorId,
    }]

    await expect(preflightAddonBindings(env, installation, entry.manifest, inputFor(crossTenant))).resolves.toEqual({
      ok: false,
      reason: 'connector_not_available',
    })
    await expect(preflightAddonBindings(env, installation, entry.manifest, inputFor(revoked))).resolves.toEqual({
      ok: false,
      reason: 'connector_not_available',
    })
    await expect(preflightAddonBindings(env, installation, entry.manifest, inputFor(wrongType))).resolves.toEqual({
      ok: false,
      reason: 'adapter_type_mismatch',
    })

    const writeManifest: AddonManifestV1 = structuredClone(entry.manifest)
    writeManifest.connectorRequirements[0].capability = 'write'
    await expect(preflightAddonBindings(env, installation, writeManifest, [firstPartyBinding])).resolves.toEqual({
      ok: false,
      reason: 'capability_mismatch',
    })
  })

  it.each([
    [[], 'missing_required_slot'],
    [[{ ...firstPartyBinding, slot: 'unknown' }], 'unknown_slot'],
    [[
      firstPartyBinding,
      { slot: 'search_performance', adapter: 'google_search_console', bindingKind: 'internal_adapter' },
    ], 'binding_kind_mismatch'],
    [[{ ...firstPartyBinding, adapter: 'unsupported' }], 'adapter_not_allowed'],
  ] as const)('fails preflight for invalid configuration with %s', async (bindings, reason) => {
    const installation = await installMarketing(env)
    const entry = getRegisteredAddon('marketing-cro-monitor')
    if (!entry) throw new Error('marketing addon missing')

    await expect(preflightAddonBindings(env, installation, entry.manifest, [...bindings])).resolves.toEqual({
      ok: false,
      reason,
    })
  })

  it('treats the same normalized configuration as idempotent and records changed generations as preflight', async () => {
    const installation = await installMarketing(env)
    const connectorId = insertConnector(harness)
    const first = await configureAddon(env, owner, 'marketing-cro-monitor', { bindings: [firstPartyBinding] })
    const retry = await configureAddon(env, owner, 'marketing-cro-monitor', { bindings: [firstPartyBinding] })
    const changed = await configureAddon(env, owner, 'marketing-cro-monitor', {
      bindings: [{
        slot: 'web_analytics',
        adapter: 'posthog',
        bindingKind: 'vault_connector',
        connectorId,
      }],
    })

    expect(first).toMatchObject({ ok: true, state: 'configured' })
    expect(retry).toMatchObject({ ok: true, state: 'configured', idempotent: true })
    expect(changed).toMatchObject({ ok: true, state: 'configured' })
    expect(await listAddonBindings(env, installation.id)).toEqual([
      expect.objectContaining({ adapter: 'posthog', connectorId, revokedAt: null }),
    ])
    const receipts = await getAddonReceipts(env, installation.id)
    expect(receipts.map(({ action }) => action)).toEqual(['preflight', 'configure', 'install'])
    expect(receipts[0]).toMatchObject({ previousState: null, nextState: null, actorId: owner.id })
    expect(harness.sqlite.prepare(`
      SELECT adapter, revoked_at FROM addon_connector_bindings
       WHERE installation_id = ? ORDER BY configured_at, id
    `).all(installation.id)).toEqual([
      { adapter: 'first_party', revoked_at: expect.any(String) },
      { adapter: 'posthog', revoked_at: null },
    ])
  })

  it('does not reconfigure when activation commits after configuration reads state', async () => {
    const installation = await installMarketing(env)
    const connectorId = insertConnector(harness)
    await configureAddon(env, owner, 'marketing-cro-monitor', { bindings: [firstPartyBinding] })
    const racingEnv = withPreBatchHook(
      env,
      (sql) => sql.includes("'preflight'"),
      async () => {
        await expect(activateAddon(env, owner, 'marketing-cro-monitor')).resolves.toMatchObject({
          ok: true,
          state: 'active',
        })
      },
    )

    await expect(configureAddon(racingEnv, owner, 'marketing-cro-monitor', {
      bindings: [{
        slot: 'web_analytics', adapter: 'posthog', bindingKind: 'vault_connector', connectorId,
      }],
    })).resolves.toMatchObject({ ok: false, reason: 'invalid_state', state: 'active' })
    expect(await listAddonBindings(env, installation.id)).toEqual([
      expect.objectContaining({ adapter: 'first_party', revokedAt: null }),
    ])
    expect((await getAddonReceipts(env, installation.id)).filter(({ action }) => action === 'preflight')).toEqual([])
  })

  it('makes one concurrent identical reconfiguration generation and receipt authoritative', async () => {
    const installation = await installMarketing(env)
    const connectorId = insertConnector(harness)
    await configureAddon(env, owner, 'marketing-cro-monitor', { bindings: [firstPartyBinding] })
    const racingEnv = withConcurrentPreflightBatches(env)
    const desired = { bindings: [{
      slot: 'web_analytics' as const,
      adapter: 'posthog' as const,
      bindingKind: 'vault_connector' as const,
      connectorId,
    }] }

    const results = await Promise.all([
      configureAddon(racingEnv, owner, 'marketing-cro-monitor', desired),
      configureAddon(racingEnv, owner, 'marketing-cro-monitor', desired),
    ])

    expect(results.filter((result) => result.ok && result.idempotent === true)).toHaveLength(1)
    expect(results.filter((result) => result.ok && result.idempotent !== true)).toHaveLength(1)
    expect((await getAddonReceipts(env, installation.id)).filter(({ action }) => action === 'preflight')).toHaveLength(1)
    expect(harness.sqlite.prepare(`
      SELECT configuration_sha256, revoked_at FROM addon_binding_generations
       WHERE installation_id = ? ORDER BY configured_at, id
    `).all(installation.id)).toEqual([
      { configuration_sha256: expect.any(String), revoked_at: expect.any(String) },
      { configuration_sha256: expect.any(String), revoked_at: null },
    ])
    expect(harness.sqlite.prepare(`
      SELECT adapter, revoked_at FROM addon_connector_bindings
       WHERE installation_id = ? ORDER BY configured_at, id
    `).all(installation.id)).toEqual([
      { adapter: 'first_party', revoked_at: expect.any(String) },
      { adapter: 'posthog', revoked_at: null },
    ])
  })

  it('reconfigures while disabled, preserves bindings on disable, and rejects changes while active', async () => {
    const installation = await installMarketing(env)
    const connectorId = insertConnector(harness)
    await configureAddon(env, owner, 'marketing-cro-monitor', { bindings: [firstPartyBinding] })
    await expect(activateAddon(env, owner, 'marketing-cro-monitor')).resolves.toMatchObject({
      ok: true,
      state: 'active',
    })

    await expect(configureAddon(env, owner, 'marketing-cro-monitor', {
      bindings: [{
        slot: 'web_analytics', adapter: 'posthog', bindingKind: 'vault_connector', connectorId,
      }],
    })).resolves.toEqual(expect.objectContaining({ ok: false, reason: 'invalid_state', state: 'active' }))
    expect(await listAddonBindings(env, installation.id)).toEqual([
      expect.objectContaining({ adapter: 'first_party', revokedAt: null }),
    ])

    await disableAddon(env, owner, 'marketing-cro-monitor')
    expect(await listAddonBindings(env, installation.id)).toHaveLength(1)
    await expect(configureAddon(env, owner, 'marketing-cro-monitor', {
      bindings: [{
        slot: 'web_analytics', adapter: 'posthog', bindingKind: 'vault_connector', connectorId,
      }],
    })).resolves.toMatchObject({ ok: true, state: 'disabled' })
  })

  it('re-runs preflight on activation and revokes all live bindings in the archive batch', async () => {
    const installation = await installMarketing(env)
    const connectorId = insertConnector(harness)
    await configureAddon(env, owner, 'marketing-cro-monitor', {
      bindings: [{
        slot: 'web_analytics', adapter: 'posthog', bindingKind: 'vault_connector', connectorId,
      }],
    })
    harness.sqlite.prepare('UPDATE connectors SET revoked_at = ? WHERE id = ?').run(
      '2026-07-16T01:00:00.000Z', connectorId,
    )

    await expect(activateAddon(env, owner, 'marketing-cro-monitor')).resolves.toEqual({
      ok: false,
      reason: 'connector_not_available',
      state: 'configured',
    })

    harness.sqlite.prepare('UPDATE connectors SET revoked_at = NULL WHERE id = ?').run(connectorId)
    await expect(activateAddon(env, owner, 'marketing-cro-monitor')).resolves.toMatchObject({ ok: true, state: 'active' })
    await expect(disableAddon(env, owner, 'marketing-cro-monitor')).resolves.toMatchObject({ ok: true, state: 'disabled' })
    await expect(archiveAddon(env, owner, 'marketing-cro-monitor')).resolves.toMatchObject({ ok: true, state: 'archived' })
    expect(await listAddonBindings(env, installation.id)).toEqual([])
    expect(harness.sqlite.prepare(`
      SELECT revoked_at FROM addon_connector_bindings WHERE installation_id = ?
    `).get(installation.id)).toEqual({ revoked_at: expect.any(String) })
  })

  it('fences activation when the preflighted connector is revoked before transition', async () => {
    const installation = await installMarketing(env)
    const connectorId = insertConnector(harness)
    await configureAddon(env, owner, 'marketing-cro-monitor', {
      bindings: [{
        slot: 'web_analytics', adapter: 'posthog', bindingKind: 'vault_connector', connectorId,
      }],
    })
    const racingEnv = withPreBatchHook(
      env,
      (sql) => sql.includes("SET state = 'active'"),
      async () => {
        harness.sqlite.prepare('UPDATE connectors SET revoked_at = ? WHERE id = ?').run(
          '2026-07-16T01:00:00.000Z', connectorId,
        )
      },
    )

    await expect(activateAddon(racingEnv, owner, 'marketing-cro-monitor')).resolves.toMatchObject({
      ok: false,
      reason: 'write_failed',
    })
    expect(harness.sqlite.prepare('SELECT state FROM addon_installations WHERE id = ?').get(installation.id)).toEqual({
      state: 'configured',
    })
  })

  it('fences activation when reconfiguration replaces the preflighted generation', async () => {
    const installation = await installMarketing(env)
    const connectorId = insertConnector(harness)
    await configureAddon(env, owner, 'marketing-cro-monitor', {
      bindings: [{
        slot: 'web_analytics', adapter: 'posthog', bindingKind: 'vault_connector', connectorId,
      }],
    })
    const racingEnv = withPreBatchHook(
      env,
      (sql) => sql.includes("SET state = 'active'"),
      async () => {
        await expect(configureAddon(env, owner, 'marketing-cro-monitor', {
          bindings: [firstPartyBinding],
        })).resolves.toMatchObject({ ok: true, state: 'configured' })
      },
    )

    await expect(activateAddon(racingEnv, owner, 'marketing-cro-monitor')).resolves.toMatchObject({
      ok: false,
      reason: 'write_failed',
    })
    expect(harness.sqlite.prepare('SELECT state FROM addon_installations WHERE id = ?').get(installation.id)).toEqual({
      state: 'configured',
    })
    expect(await listAddonBindings(env, installation.id)).toEqual([
      expect.objectContaining({ adapter: 'first_party', revokedAt: null }),
    ])
  })

  it('rolls back bindings when the configure receipt fails and enforces tenant matching in D1', async () => {
    const installation = await installMarketing(env)
    const crossTenantConnector = insertConnector(harness, { tenant: 'tenant-b' })
    const entry = getRegisteredAddon('marketing-cro-monitor')
    if (!entry) throw new Error('marketing addon missing')

    expect(() => harness.sqlite.prepare(`
      INSERT INTO addon_connector_bindings (
        id, tenant, installation_id, slot, adapter, binding_kind, capability,
        connector_id, manifest_sha256, configured_by, configured_at, revoked_at
      ) VALUES (?, 'tenant-a', ?, 'web_analytics', 'posthog', 'vault_connector',
        'read', ?, ?, 'owner-1', '2026-07-16T00:00:00.000Z', NULL)
    `).run(crypto.randomUUID(), installation.id, crossTenantConnector, entry.manifestSha256)).toThrow()

    harness.sqlite.exec(`
      CREATE TRIGGER reject_binding_configure_receipt
      BEFORE INSERT ON addon_receipts
      WHEN NEW.action = 'configure'
      BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END;
    `)
    await expect(configureAddon(env, owner, 'marketing-cro-monitor', {
      bindings: [firstPartyBinding],
    })).resolves.toEqual({ ok: false, reason: 'write_failed' })
    expect(await listAddonBindings(env, installation.id)).toEqual([])
  })

  it('keeps binding evidence append-only except for a single revocation transition', async () => {
    const installation = await installMarketing(env)
    await configureAddon(env, owner, 'marketing-cro-monitor', { bindings: [firstPartyBinding] })
    const binding = (await listAddonBindings(env, installation.id))[0]

    expect(() => harness.sqlite.prepare(`
      UPDATE addon_connector_bindings SET adapter = 'posthog' WHERE id = ?
    `).run(binding.id)).toThrow()
    expect(() => harness.sqlite.prepare(`
      DELETE FROM addon_connector_bindings WHERE id = ?
    `).run(binding.id)).toThrow()
    expect(() => harness.sqlite.prepare(`
      UPDATE addon_connector_bindings SET revoked_at = '' WHERE id = ?
    `).run(binding.id)).toThrow()
    expect(() => harness.sqlite.prepare(`
      UPDATE addon_connector_bindings SET revoked_at = '2026-07-16 01:00:00' WHERE id = ?
    `).run(binding.id)).toThrow()
    expect(() => harness.sqlite.prepare(`
      UPDATE addon_connector_bindings SET revoked_at = '2000-01-01T00:00:00.000Z' WHERE id = ?
    `).run(binding.id)).toThrow()

    expect(harness.sqlite.prepare(`
      UPDATE addon_connector_bindings SET revoked_at = ? WHERE id = ?
    `).run(binding.configuredAt, binding.id).changes).toBe(1)
    expect(() => harness.sqlite.prepare(`
      UPDATE addon_connector_bindings SET revoked_at = ? WHERE id = ?
    `).run(new Date(Date.parse(binding.configuredAt) + 1).toISOString(), binding.id)).toThrow()
  })

  it('requires new generations and bindings to start live with canonical evidence', async () => {
    const installation = await installMarketing(env)
    const entry = getRegisteredAddon('marketing-cro-monitor')
    if (!entry) throw new Error('marketing addon missing')

    expect(() => harness.sqlite.prepare(`
      INSERT INTO addon_binding_generations (
        id, tenant, installation_id, configuration_sha256, manifest_sha256,
        configured_by, configured_at, revoked_at, previous_generation_id,
        expected_installation_state, base_receipt_id
      ) VALUES (?, 'tenant-a', ?, ?, ?, 'owner-1', ?, ?, NULL, 'installed', ?)
    `).run(
      crypto.randomUUID(),
      installation.id,
      'a'.repeat(64),
      entry.manifestSha256,
      '2026-07-16T00:00:00.000Z',
      '2026-07-16T01:00:00.000Z',
      installation.latestReceiptId,
    )).toThrow(/start live/)
  })

  it('uses a composite connector foreign key that blocks tenant changes and deletion', async () => {
    const installation = await installMarketing(env)
    const connectorId = insertConnector(harness)
    await configureAddon(env, owner, 'marketing-cro-monitor', {
      bindings: [{
        slot: 'web_analytics', adapter: 'posthog', bindingKind: 'vault_connector', connectorId,
      }],
    })

    const foreignKeys = harness.sqlite.prepare('PRAGMA foreign_key_list(addon_connector_bindings)').all()
    expect(foreignKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'connectors', from: 'connector_id', to: 'id' }),
      expect.objectContaining({ table: 'connectors', from: 'tenant', to: 'tenant' }),
    ]))
    expect(() => harness.sqlite.prepare('UPDATE connectors SET tenant = ? WHERE id = ?').run(
      'tenant-b', connectorId,
    )).toThrow()
    expect(() => harness.sqlite.prepare('DELETE FROM connectors WHERE id = ?').run(connectorId)).toThrow()
    expect(await listAddonBindings(env, installation.id)).toHaveLength(1)
  })
})
