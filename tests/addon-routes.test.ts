import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addonsApp } from '../src/addons/routes'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const migrations = [
  '../migrations/0001_init.sql',
  '../migrations/0003_settings.sql',
  '../migrations/0029_department_microkernel.sql',
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

  it('returns the UI catalog joined with this tenant installation state without manifest internals', async () => {
    const ownerEnv = envForRole(harness, 'owner')
    await addonsApp.fetch(request('/fixture-addon/install', 'POST'), ownerEnv)

    const res = await addonsApp.fetch(request('/', 'GET'), ownerEnv)

    expect(res.status).toBe(200)
    const body = await res.json() as {
      addons: Array<Record<string, unknown>>
    }
    expect(body.addons).toEqual([
      expect.objectContaining({
        key: 'fixture-addon',
        name: 'Fixture Addon',
        version: '1.0.0',
        state: 'installed',
      }),
    ])
    expect(body.addons[0]).not.toHaveProperty('manifest')
    expect(body.addons[0]).not.toHaveProperty('manifestSha256')
    expect(body.addons[0]).not.toHaveProperty('connectorRequirements')
    expect(body.addons[0]).not.toHaveProperty('authorityRequests')
    expect(body.addons[0]).not.toHaveProperty('installationId')
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
    await expect(receipts.json()).resolves.toEqual({ receipts: [] })
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

  it('returns only redacted tenant-scoped receipt fields', async () => {
    const ownerEnv = envForRole(harness, 'owner')
    await addonsApp.fetch(request('/fixture-addon/install', 'POST'), ownerEnv)

    const res = await addonsApp.fetch(request('/fixture-addon/receipts', 'GET'), ownerEnv)

    expect(res.status).toBe(200)
    const body = await res.json() as { receipts: Array<Record<string, unknown>> }
    expect(body.receipts).toHaveLength(1)
    expect(body.receipts[0]).toEqual(expect.objectContaining({ action: 'install', addonKey: 'fixture-addon' }))
    expect(body.receipts[0]).not.toHaveProperty('tenant')
    expect(body.receipts[0]).not.toHaveProperty('installationId')
    expect(body.receipts[0]).not.toHaveProperty('manifestSha256')
    expect(body.receipts[0]).not.toHaveProperty('mupotCompatibility')
    expect(body.receipts[0]).not.toHaveProperty('sideEffectIds')
    expect(body.receipts[0]).not.toHaveProperty('checks')
  })
})
