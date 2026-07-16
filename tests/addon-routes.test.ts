import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addonsApp } from '../src/addons/routes'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const migrations = [
  '../migrations/0001_init.sql',
  '../migrations/0002_members.sql',
  '../migrations/0003_settings.sql',
  '../migrations/0004_channels.sql',
  '../migrations/0005_channel_capability_grants.sql',
  '../migrations/0016_presence.sql',
  '../migrations/0019_agent_token_binding.sql',
  '../migrations/0029_department_microkernel.sql',
  '../migrations/0040_members_tenant.sql',
  '../migrations/0043_member_tokens_tenant.sql',
  '../migrations/0050_addons.sql',
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))

function envForRole(harness: SqliteD1Harness, role: 'owner' | 'admin' | 'member', tenant = 'tenant-a'): Env {
  return {
    TENANT_SLUG: tenant,
    BRAND: 'Test',
    DB: harness.db,
    SESSIONS: {
      get: async () => JSON.stringify({ userId: `${role}-1`, email: `${role}@example.test`, role, createdAt: '2026-01-01T00:00:00Z' }),
      put: async () => undefined,
      delete: async () => undefined,
    },
    OAUTH_KV: { get: async () => null, put: async () => undefined },
  } as unknown as Env
}

function request(
  path: string,
  method: 'GET' | 'POST',
  options: { body?: string; contentLength?: string } = {},
): Request {
  const headers = new Headers({
    Cookie: 'mupot_session=session-1',
    Origin: 'https://pot.test',
  })
  if (method === 'POST') headers.set('Content-Type', 'application/json')
  if (options.contentLength !== undefined) headers.set('content-length', options.contentLength)
  return new Request(`https://pot.test${path}`, { method, headers, body: options.body })
}

describe('addon lifecycle routes', () => {
  let harness: SqliteD1Harness

  beforeEach(() => {
    harness = createSqliteD1()
    for (const migration of migrations) harness.sqlite.exec(migration)
  })

  afterEach(() => harness.close())

  it.each([undefined, 'https://sibling.pot.test'])(
    'rejects cookie-authenticated lifecycle mutations with origin %s',
    async (origin) => {
      const headers = new Headers({
        Cookie: 'mupot_session=session-1',
        'Content-Type': 'application/json',
      })
      if (origin) headers.set('Origin', origin)

      const res = await addonsApp.fetch(new Request('https://pot.test/fixture-addon/install', {
        method: 'POST',
        headers,
      }), envForRole(harness, 'owner'))

      expect(res.status).toBe(403)
      expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM addon_installations').get()).toEqual({ count: 0 })
    },
  )

  it('accepts an org-admin member bearer without a session cookie', async () => {
    const rawToken = 'machine-token'
    const tokenHash = Array.from(new Uint8Array(await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(rawToken),
    )), (byte) => byte.toString(16).padStart(2, '0')).join('')
    harness.sqlite.prepare(`
      INSERT INTO members (id, email, display_name, status, tenant)
      VALUES (?, ?, ?, 'active', ?)
    `).run('machine-member', 'machine@example.test', 'Machine Operator', 'tenant-a')
    harness.sqlite.prepare(`
      INSERT INTO member_tokens (
        id, member_id, token_hash, label, channel, created_at, revoked_at, agent_id, tenant
      ) VALUES (?, ?, ?, ?, 'workspace', ?, NULL, NULL, ?)
    `).run('machine-token-id', 'machine-member', tokenHash, 'addon receipt', '2026-01-01T00:00:00Z', 'tenant-a')
    harness.sqlite.prepare(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES (?, ?, 'org', NULL, 'admin')
    `).run('machine-admin-capability', 'machine-member')

    const res = await addonsApp.fetch(new Request('https://pot.test/fixture-addon/install', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${rawToken}`,
      },
    }), envForRole(harness, 'owner'))

    expect(res.status).toBe(201)
    await expect(res.json()).resolves.toEqual(expect.objectContaining({
      ok: true,
      key: 'fixture-addon',
      state: 'installed',
    }))
    expect(harness.sqlite.prepare(`
      SELECT installed_by, latest_actor_id FROM addon_installations
    `).get()).toEqual({ installed_by: 'machine-member', latest_actor_id: 'machine-member' })
  })

  it.each(['install', 'configure', 'activate', 'disable', 'archive'] as const)(
    'rejects member %s commands with the owner/admin envelope',
    async (action) => {
      const res = await addonsApp.fetch(
        request(`/fixture-addon/${action}`, 'POST'),
        envForRole(harness, 'member'),
      )

      expect(res.status).toBe(403)
      await expect(res.json()).resolves.toEqual({ error: 'forbidden', detail: 'owner/admin only' })
    },
  )

  it('rejects a member catalog read with the owner/admin envelope', async () => {
    const res = await addonsApp.fetch(request('/', 'GET'), envForRole(harness, 'member'))

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({ error: 'forbidden', detail: 'owner/admin only' })
  })

  it('rejects a member receipt read before resolving the addon or reading receipts', async () => {
    const res = await addonsApp.fetch(request('/missing-addon/receipts', 'GET'), envForRole(harness, 'member'))

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({ error: 'forbidden', detail: 'owner/admin only' })
  })

  it('rejects a member business-state evidence read before resolving the addon', async () => {
    const res = await addonsApp.fetch(request('/missing-addon/evidence', 'GET'), envForRole(harness, 'member'))

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({ error: 'forbidden', detail: 'owner/admin only' })
  })

  it('returns on-demand type-preserving business evidence without rows or addon state', async () => {
    const ownerEnv = envForRole(harness, 'owner')
    harness.sqlite.exec(`
      CREATE TABLE evidence_business_values (id TEXT PRIMARY KEY, value);
      INSERT INTO evidence_business_values (id, value) VALUES ('sensitive-business-row', 1);
      CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO d1_migrations (id, name) VALUES (1, 'initial-migration');
      CREATE TABLE _cf_internal_state (id INTEGER PRIMARY KEY, value TEXT);
      INSERT INTO _cf_internal_state (id, value) VALUES (1, 'provider-state');
    `)

    const before = await addonsApp.fetch(request('/fixture-addon/evidence', 'GET'), ownerEnv)
    expect(before.status).toBe(200)
    const beforeBody = await before.json() as Record<string, unknown>
    expect(Object.keys(beforeBody).sort()).toEqual([
      'businessStateSha256',
      'installedVersion',
      'manifestSha256',
      'mupotCompatibility',
      'publisher',
      'trustClass',
    ])
    expect(beforeBody.businessStateSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(beforeBody.manifestSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(beforeBody).toMatchObject({
      installedVersion: '1.0.0',
      mupotCompatibility: '^0.23.0',
      publisher: 'mumega',
      trustClass: 'native_reviewed',
    })
    expect(JSON.stringify(beforeBody)).not.toContain('sensitive-business-row')
    expect(JSON.stringify(beforeBody)).not.toContain('evidence_business_values')

    expect((await addonsApp.fetch(request('/fixture-addon/install', 'POST'), ownerEnv)).status).toBe(201)
    harness.sqlite.prepare(`
      UPDATE d1_migrations SET name = 'ignored-migration-change' WHERE id = 1
    `).run()
    harness.sqlite.prepare(`
      UPDATE _cf_internal_state SET value = 'ignored-provider-change' WHERE id = 1
    `).run()
    const afterInstall = await addonsApp.fetch(request('/fixture-addon/evidence', 'GET'), ownerEnv)
    const afterInstallBody = await afterInstall.json() as Record<string, unknown>
    expect(afterInstallBody.businessStateSha256).toBe(beforeBody.businessStateSha256)

    harness.sqlite.prepare(`
      UPDATE evidence_business_values SET value = CAST(value AS TEXT) WHERE id = 'sensitive-business-row'
    `).run()
    const afterTypeChange = await addonsApp.fetch(request('/fixture-addon/evidence', 'GET'), ownerEnv)
    const afterTypeChangeBody = await afterTypeChange.json() as Record<string, unknown>
    expect(afterTypeChangeBody.businessStateSha256).not.toBe(beforeBody.businessStateSha256)
    expect(JSON.stringify(afterTypeChangeBody)).not.toContain('sensitive-business-row')
    expect(afterTypeChangeBody).not.toHaveProperty('tables')
    expect(afterTypeChangeBody).not.toHaveProperty('rows')
    expect(afterTypeChangeBody).not.toHaveProperty('rowCount')
  })

  it('reads large business tables in bounded pages', async () => {
    harness.sqlite.exec(`
      CREATE TABLE evidence_many_rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      WITH RECURSIVE sequence(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1 FROM sequence WHERE value < 300
      )
      INSERT INTO evidence_many_rows (id, value)
      SELECT value, printf('row-%04d', value) FROM sequence;
    `)
    const observed: string[] = []
    const trackedDb = new Proxy(harness.db, {
      get(target, property, receiver) {
        if (property !== 'prepare') return Reflect.get(target, property, receiver)
        return (sql: string) => {
          if (sql.includes('FROM "evidence_many_rows"')) observed.push(sql)
          return target.prepare(sql)
        }
      },
    })
    const env = { ...envForRole(harness, 'owner'), DB: trackedDb }

    const res = await addonsApp.fetch(request('/fixture-addon/evidence', 'GET'), env)

    expect(res.status).toBe(200)
    expect(observed.length).toBeGreaterThanOrEqual(3)
    expect(observed.every((sql) => /\bLIMIT\s+\?/i.test(sql))).toBe(true)
  })

  it('maps unknown addon business-state evidence to not found', async () => {
    const res = await addonsApp.fetch(request('/missing-addon/evidence', 'GET'), envForRole(harness, 'owner'))

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: 'addon_not_registered' })
  })

  it('returns only a digest of complete department state and changes it on a hidden-column mutation', async () => {
    const ownerEnv = envForRole(harness, 'owner')
    harness.sqlite.prepare(`
      INSERT INTO departments (
        id, slug, name, created_at, template_key, template_version,
        activated_at, active, seed_receipt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'hidden-department-id',
      'hidden-department-slug',
      'Hidden Department Name',
      '2026-01-01T00:00:00.000Z',
      'hidden-template-key',
      '1.0.0',
      null,
      0,
      null,
    )

    const before = await addonsApp.fetch(request('/fixture-addon/receipts', 'GET'), ownerEnv)
    expect(before.status).toBe(200)
    const beforeBody = await before.json() as Record<string, unknown>
    expect(Object.keys(beforeBody).sort()).toEqual([
      'departmentStateSha256',
      'ownershipClaimCount',
      'receipts',
    ])
    expect(beforeBody.departmentStateSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(beforeBody)).not.toContain('hidden-department-id')
    expect(JSON.stringify(beforeBody)).not.toContain('hidden-template-key')

    harness.sqlite.prepare(`
      UPDATE departments SET active = 1 WHERE id = 'hidden-department-id'
    `).run()

    const after = await addonsApp.fetch(request('/fixture-addon/receipts', 'GET'), ownerEnv)
    expect(after.status).toBe(200)
    const afterBody = await after.json() as Record<string, unknown>
    expect(afterBody.departmentStateSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(afterBody.departmentStateSha256).not.toBe(beforeBody.departmentStateSha256)
    expect(JSON.stringify(afterBody)).not.toContain('Hidden Department Name')
    expect(afterBody).not.toHaveProperty('departments')
    expect(afterBody).not.toHaveProperty('active')
    expect(afterBody).not.toHaveProperty('template_key')
  })

  it('fails closed when persisted department state has an invalid row shape', async () => {
    const ownerEnv = envForRole(harness, 'owner')
    harness.sqlite.prepare(`
      INSERT INTO departments (id, slug, name, created_at, active)
      VALUES ('invalid-department', 'invalid-department', 'Invalid Department', '2026-01-01T00:00:00.000Z', 2)
    `).run()

    const res = await addonsApp.fetch(request('/fixture-addon/receipts', 'GET'), ownerEnv)

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: 'receipt_unavailable' })
  })

  it('returns the UI catalog joined with this tenant installation state without manifest internals', async () => {
    const ownerEnv = envForRole(harness, 'owner')
    await addonsApp.fetch(request('/fixture-addon/install', 'POST'), ownerEnv)

    const res = await addonsApp.fetch(request('/', 'GET'), ownerEnv)

    expect(res.status).toBe(200)
    const body = await res.json() as {
      addons: Array<Record<string, unknown>>
    }
    expect(body.addons).toEqual([
      {
        key: 'fixture-addon',
        name: 'Fixture Addon',
        version: '1.0.0',
        publisher: 'mumega',
        trustClass: 'native_reviewed',
        kind: 'native',
        description: 'Lifecycle fixture with no authority.',
        state: 'installed',
      },
      {
        key: 'marketing-cro-monitor',
        name: 'Marketing & CRO Monitor',
        version: '1.0.0',
        publisher: 'mumega',
        trustClass: 'native_reviewed',
        kind: 'native',
        description: 'Read-only marketing and conversion monitoring.',
        state: null,
      },
    ])
    for (const addon of body.addons) {
      expect(Object.keys(addon).sort()).toEqual([
        'description',
        'key',
        'kind',
        'name',
        'publisher',
        'state',
        'trustClass',
        'version',
      ])
      expect(addon).not.toHaveProperty('manifest')
      expect(addon).not.toHaveProperty('manifestSha256')
      expect(addon).not.toHaveProperty('connectorRequirements')
      expect(addon).not.toHaveProperty('authorityRequests')
      expect(addon).not.toHaveProperty('installationId')
    }
  })

  it.each(['{}', '{"unexpected":true}'])('rejects non-empty lifecycle body %j', async (body) => {
    const res = await addonsApp.fetch(
      request('/fixture-addon/install', 'POST', { body }),
      envForRole(harness, 'owner'),
    )

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'invalid_body' })
  })

  it('rejects lifecycle payloads over 8 KiB by declared and actual UTF-8 length', async () => {
    const ownerEnv = envForRole(harness, 'owner')
    const oversized = '\u00e9'.repeat(4097)

    const declared = await addonsApp.fetch(
      request('/fixture-addon/install', 'POST', { contentLength: '8193' }),
      ownerEnv,
    )
    expect(declared.status).toBe(413)
    await expect(declared.json()).resolves.toEqual({ error: 'payload_too_large' })

    const actual = await addonsApp.fetch(
      request('/fixture-addon/install', 'POST', { body: oversized }),
      ownerEnv,
    )
    expect(actual.status).toBe(413)
    await expect(actual.json()).resolves.toEqual({ error: 'payload_too_large' })
  })

  it('maps an invalid transition to the current state', async () => {
    const res = await addonsApp.fetch(
      request('/fixture-addon/configure', 'POST'),
      envForRole(harness, 'owner'),
    )

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ error: 'invalid_state', state: null })
  })

  it('maps a live lifecycle lease to operation_busy with the current state', async () => {
    const ownerEnv = envForRole(harness, 'owner')
    await addonsApp.fetch(request('/fixture-addon/install', 'POST'), ownerEnv)
    await addonsApp.fetch(request('/fixture-addon/configure', 'POST'), ownerEnv)
    const installation = harness.sqlite.prepare(
      "SELECT id FROM addon_installations WHERE tenant = 'tenant-a' AND addon_key = 'fixture-addon'",
    ).get() as { id: string }
    const now = new Date().toISOString()
    harness.sqlite.prepare(`
      INSERT INTO addon_operations (
        id, tenant, installation_id, action, target_state, current_step, status,
        actor_id, lease_token, lease_expires_at, created_at, updated_at
      ) VALUES (?, 'tenant-a', ?, 'activate', 'active', 'activate_departments', 'running', ?, ?, ?, ?, ?)
    `).run('live-operation', installation.id, 'admin-1', 'lease-live', '2999-01-01T00:00:00.000Z', now, now)

    const res = await addonsApp.fetch(request('/fixture-addon/activate', 'POST'), ownerEnv)

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ error: 'operation_busy', state: 'configured' })
  })

  it('maps missing disabled-operation evidence to fence_lost', async () => {
    const ownerEnv = envForRole(harness, 'owner')
    await addonsApp.fetch(request('/fixture-addon/install', 'POST'), ownerEnv)
    await addonsApp.fetch(request('/fixture-addon/configure', 'POST'), ownerEnv)
    await addonsApp.fetch(request('/fixture-addon/activate', 'POST'), ownerEnv)
    await addonsApp.fetch(request('/fixture-addon/disable', 'POST'), ownerEnv)
    harness.sqlite.prepare("DELETE FROM addon_operations WHERE tenant = 'tenant-a' AND action = 'disable'").run()

    const res = await addonsApp.fetch(request('/fixture-addon/archive', 'POST'), ownerEnv)

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ error: 'fence_lost', state: null })
  })

  it('maps an unknown addon key to not found', async () => {
    const res = await addonsApp.fetch(
      request('/missing-addon/install', 'POST'),
      envForRole(harness, 'owner'),
    )

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: 'addon_not_registered' })
  })

  it('returns an idempotency marker for the same lifecycle command retry', async () => {
    const ownerEnv = envForRole(harness, 'owner')
    const first = await addonsApp.fetch(request('/fixture-addon/install', 'POST'), ownerEnv)
    expect(first.status).toBe(201)

    const retry = await addonsApp.fetch(request('/fixture-addon/install', 'POST'), ownerEnv)

    expect(retry.status).toBe(200)
    await expect(retry.json()).resolves.toEqual(expect.objectContaining({
      ok: true,
      key: 'fixture-addon',
      state: 'installed',
      idempotent: true,
    }))
  })

  it('does not expose another tenant installation state or receipts', async () => {
    await addonsApp.fetch(request('/fixture-addon/install', 'POST'), envForRole(harness, 'owner', 'tenant-b'))
    const ownerEnv = envForRole(harness, 'owner', 'tenant-a')

    const catalog = await addonsApp.fetch(request('/', 'GET'), ownerEnv)
    const catalogBody = await catalog.json() as { addons: Array<{ key: string; state: string | null }> }
    expect(catalogBody.addons.find((addon) => addon.key === 'fixture-addon')?.state).toBeNull()

    const receipts = await addonsApp.fetch(request('/fixture-addon/receipts', 'GET'), ownerEnv)
    const receiptsBody = await receipts.json() as Record<string, unknown>
    expect(receiptsBody).toEqual(expect.objectContaining({ receipts: [], ownershipClaimCount: 0 }))
    expect(receiptsBody.departmentStateSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('prefers a live reinstall over archived history in the catalog state', async () => {
    const ownerEnv = envForRole(harness, 'owner')
    for (const action of ['install', 'configure', 'activate', 'disable', 'archive', 'install'] as const) {
      await addonsApp.fetch(request(`/fixture-addon/${action}`, 'POST'), ownerEnv)
    }
    harness.sqlite.prepare(`
      UPDATE addon_installations
         SET installed_at = '2999-01-01T00:00:00.000Z'
       WHERE tenant = 'tenant-a' AND addon_key = 'fixture-addon' AND state = 'archived'
    `).run()

    const res = await addonsApp.fetch(request('/', 'GET'), ownerEnv)
    const body = await res.json() as { addons: Array<{ key: string; state: string | null }> }

    expect(body.addons.find((addon) => addon.key === 'fixture-addon')?.state).toBe('installed')
  })

  it('uses the most recently archived lifecycle for receipts when no live installation exists', async () => {
    const ownerEnv = envForRole(harness, 'owner')
    for (const action of ['install', 'configure', 'activate', 'disable', 'archive', 'install', 'configure', 'activate', 'disable', 'archive'] as const) {
      await addonsApp.fetch(request(`/fixture-addon/${action}`, 'POST'), ownerEnv)
    }

    const archivedInstallations = harness.sqlite.prepare(`
      SELECT id FROM addon_installations
       WHERE tenant = 'tenant-a' AND addon_key = 'fixture-addon' AND state = 'archived'
       ORDER BY installed_at ASC
    `).all() as Array<{ id: string }>
    expect(archivedInstallations).toHaveLength(2)

    const [older, newer] = archivedInstallations
    harness.sqlite.prepare(`
      UPDATE addon_installations
         SET archived_at = CASE id
           WHEN ? THEN '2026-01-01T00:00:00.000Z'
           WHEN ? THEN '2026-01-02T00:00:00.000Z'
         END,
             updated_at = CASE id
           WHEN ? THEN '2026-01-01T00:00:00.000Z'
           WHEN ? THEN '2026-01-02T00:00:00.000Z'
         END
       WHERE id IN (?, ?)
    `).run(older.id, newer.id, older.id, newer.id, older.id, newer.id)
    const newestArchiveReceipt = harness.sqlite.prepare(`
      SELECT sequence FROM addon_receipts
       WHERE installation_id = ? AND action = 'archive'
    `).get(newer.id) as { sequence: number }

    const res = await addonsApp.fetch(request('/fixture-addon/receipts', 'GET'), ownerEnv)

    expect(res.status).toBe(200)
    const body = await res.json() as { receipts: Array<{ action: string; sequence: number }> }
    expect(body.receipts.find((receipt) => receipt.action === 'archive')?.sequence).toBe(newestArchiveReceipt.sequence)
  })

  it('returns only redacted tenant-scoped receipt fields and an aggregate ownership count', async () => {
    const ownerEnv = envForRole(harness, 'owner')
    await addonsApp.fetch(request('/fixture-addon/install', 'POST'), ownerEnv)
    const installation = harness.sqlite.prepare(`
      SELECT id FROM addon_installations
       WHERE tenant = 'tenant-a' AND addon_key = 'fixture-addon'
    `).get() as { id: string }
    const now = new Date().toISOString()
    harness.sqlite.prepare(`
      INSERT INTO addon_resource_ownership (
        id, tenant, installation_id, resource_type, resource_id,
        resource_key, ownership_mode, active, created_at, released_at
      ) VALUES
        ('active-claim', 'tenant-a', ?, 'department', 'department-active', 'active-module', 'co_owner', 1, ?, NULL),
        ('inactive-claim', 'tenant-a', ?, 'department', 'department-inactive', 'inactive-module', 'co_owner', 0, ?, ?)
    `).run(installation.id, now, installation.id, now, now)

    const res = await addonsApp.fetch(request('/fixture-addon/receipts', 'GET'), ownerEnv)

    expect(res.status).toBe(200)
    const body = await res.json() as {
      receipts: Array<Record<string, unknown>>
      ownershipClaimCount: unknown
      departmentStateSha256: unknown
    }
    expect(body.receipts).toHaveLength(1)
    expect(body.ownershipClaimCount).toBe(2)
    expect(body.departmentStateSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(body).not.toHaveProperty('claimIds')
    expect(body).not.toHaveProperty('sideEffectIds')
    expect(body).not.toHaveProperty('checks')
    expect(body).not.toHaveProperty('tenant')
    expect(body).not.toHaveProperty('installationId')
    expect(body.receipts[0]).toEqual(expect.objectContaining({
      action: 'install',
      addonKey: 'fixture-addon',
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      mupotCompatibility: '^0.23.0',
    }))
    expect(body.receipts[0]).not.toHaveProperty('tenant')
    expect(body.receipts[0]).not.toHaveProperty('installationId')
    expect(body.receipts[0]).not.toHaveProperty('sideEffectIds')
    expect(body.receipts[0]).not.toHaveProperty('checks')
  })
})
