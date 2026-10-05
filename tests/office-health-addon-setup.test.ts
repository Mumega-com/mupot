// mupot#1662 — office.health (read probe) and addon_setup (install -> configure -> activate
// in one call). Real D1 (node:sqlite) + the full migration chain; the only stub is global
// fetch (the WordPress site). Both tools are entered through invokeTool, never run().

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { invokeTool } from '../src/mcp/index'
import { encryptConnectorSecret } from '../src/connectors/crypto'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'tenant-office-setup'
const MASTER_KEY = '44'.repeat(32)
const ORIGIN = 'https://mupot.test'
const SECRET = ['wp', 'key', 'material', '9f8e7d6c5b4a'].join('-')
const KEY = 'mcpwp-office'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  return harness
}

function env(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: TENANT, CONNECTOR_MASTER_KEY: MASTER_KEY } as Env
}

function grant(scope_type: CapabilityGrant['scope_type'], scope_id: string | null, capability: CapabilityGrant['capability']): CapabilityGrant {
  return { member_id: 'n/a', scope_type, scope_id, capability } as CapabilityGrant
}

function auth(memberId: string, capabilities: CapabilityGrant[]): AuthContext {
  return {
    userId: memberId,
    email: `${memberId}@example.test`,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    memberId,
    capabilities,
    boundAgentId: null,
  }
}

const orgOwner = auth('owner-1', [grant('org', null, 'owner')])
const orgAdmin = auth('admin-1', [grant('org', null, 'admin')])
const grantless = auth('nobody', [])

async function seedConnector(harness: SqliteD1Harness, siteUrl: string, id = 'connector-wp'): Promise<string> {
  const encrypted = await encryptConnectorSecret(MASTER_KEY, id, 'mcpwp', SECRET)
  harness.sqlite.prepare(
    `INSERT INTO connectors (id, tenant, type, label, encrypted_secret, meta, scope_type, scope_id, created_by, created_at)
     VALUES (?, ?, 'mcpwp', 'Office WordPress site', ?, ?, 'pot', NULL, 'test-setup', '2026-01-01T00:00:00Z')`,
  ).run(id, TENANT, encrypted, JSON.stringify({ siteUrl, username: 'office-agent' }))
  return id
}

function bindings(connectorId: string) {
  return [{ slot: 'wordpress_site', adapter: 'mcpwp', bindingKind: 'vault_connector', connectorId }]
}

function stubSite(respond: () => Response | Promise<Response>) {
  const spy = vi.fn(async () => respond())
  vi.stubGlobal('fetch', spy as unknown as typeof fetch)
  return spy
}

const ok200 = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', result: {} }), { status: 200, headers: { 'content-type': 'application/json' } })

function receipts(harness: SqliteD1Harness) {
  return harness.sqlite.prepare(
    `SELECT action, previous_state, next_state, actor_id, outcome, checks, isolation_class
       FROM addon_receipts WHERE tenant = ? ORDER BY sequence ASC`,
  ).all(TENANT).map((row) => ({
    ...row,
    // ids minted per run (claim/department/operation uuids) are the only legitimate difference
    checks: String((row as { checks: unknown }).checks).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>'),
  })) as Array<Record<string, unknown>>
}

function installationState(harness: SqliteD1Harness): string | undefined {
  const row = harness.sqlite.prepare(
    `SELECT state FROM addon_installations WHERE tenant = ? AND addon_key = ?`,
  ).get(TENANT, KEY) as { state: string } | undefined
  return row?.state
}

async function activeOffice(site = 'https://wordpress.example.com') {
  const harness = makeHarness()
  const connectorId = await seedConnector(harness, site)
  stubSite(ok200)
  const out = await invokeTool(orgOwner, env(harness), 'addon_setup', { key: KEY, bindings: bindings(connectorId) }, ORIGIN)
  if (!out.ok) throw new Error(`fixture: addon_setup failed ${JSON.stringify(out)}`)
  const deptId = (harness.sqlite.prepare(`SELECT id FROM departments WHERE slug = 'office'`).get() as { id: string }).id
  return { harness, connectorId, deptId }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('office.health', () => {
  it.each([
    [200, { status: 'available' }],
    [401, { status: 'failed', reason: 'key_invalid' }],
    [403, { status: 'failed', reason: 'key_invalid' }],
    [500, { status: 'failed', reason: 'unreachable' }],
    [302, { status: 'failed', reason: 'unreachable' }],
  ])('maps a %s from the site to %j', async (status, expected) => {
    const { harness, deptId } = await activeOffice()
    const spy = stubSite(() => new Response(`secret body ${SECRET}`, { status }))
    const member = auth('member-1', [grant('department', deptId, 'member')])
    const out = await invokeTool(member, env(harness), 'office.health', {}, ORIGIN)
    expect(out).toMatchObject({ ok: true, result: expected })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(out)).not.toContain(SECRET)
    expect(JSON.stringify(out)).not.toContain('secret body')
  })

  it('maps a thrown fetch (network failure) to failed/unreachable', async () => {
    const { harness, deptId } = await activeOffice()
    stubSite(() => { throw new TypeError('network down') })
    const out = await invokeTool(auth('m', [grant('department', deptId, 'member')]), env(harness), 'office.health', {}, ORIGIN)
    expect(out).toMatchObject({ ok: true, result: { status: 'failed', reason: 'unreachable' } })
  })

  it('keeps the SSRF guard: a private-host connector is never fetched', async () => {
    const { harness, deptId } = await activeOffice('https://10.0.0.5')
    const spy = stubSite(ok200)
    const out = await invokeTool(auth('m', [grant('department', deptId, 'member')]), env(harness), 'office.health', {}, ORIGIN)
    expect(out).toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'invalid_site_url' } })
    expect(spy).not.toHaveBeenCalled()
  })

  it('refuses a caller with no office capability and a grantless caller, without probing', async () => {
    const { harness } = await activeOffice()
    const spy = stubSite(ok200)
    const other = auth('m', [grant('department', 'some-other-dept', 'member')])
    const refused = await invokeTool(other, env(harness), 'office.health', {}, ORIGIN)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.status).toBe(403)
    const none = await invokeTool(grantless, env(harness), 'office.health', {}, ORIGIN)
    expect(none.ok).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('returns addon_inactive when mcpwp-office is not active', async () => {
    const harness = makeHarness()
    const spy = stubSite(ok200)
    const out = await invokeTool(orgOwner, env(harness), 'office.health', {}, ORIGIN)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.status).toBe(409)
      expect(out.error).toBe('addon_inactive')
    }
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('addon_setup', () => {
  it('happy path: install -> configure -> activate, with the health probe reported', async () => {
    const harness = makeHarness()
    const connectorId = await seedConnector(harness, 'https://wordpress.example.com')
    stubSite(ok200)
    const out = await invokeTool(orgOwner, env(harness), 'addon_setup', { key: KEY, bindings: bindings(connectorId) }, ORIGIN)
    expect(out).toMatchObject({
      ok: true,
      result: {
        key: KEY,
        state: 'active',
        steps: [
          { step: 'install', outcome: 'created' },
          { step: 'configure', outcome: 'applied' },
          { step: 'activate', outcome: 'applied' },
        ],
        health: { status: 'available' },
      },
    })
    expect(installationState(harness)).toBe('active')
  })

  it('receipts equal the three-call path (same actions, states, actor, checks)', async () => {
    const a = makeHarness()
    const aConn = await seedConnector(a, 'https://wordpress.example.com')
    for (const [tool, args] of [
      ['addon_install', { key: KEY }],
      ['addon_configure', { key: KEY, bindings: bindings(aConn) }],
      ['addon_activate', { key: KEY }],
    ] as const) {
      const r = await invokeTool(orgOwner, env(a), tool, args, ORIGIN)
      expect(r.ok, `${tool} ${JSON.stringify(r)}`).toBe(true)
    }
    const b = makeHarness()
    const bConn = await seedConnector(b, 'https://wordpress.example.com')
    stubSite(ok200)
    const s = await invokeTool(orgOwner, env(b), 'addon_setup', { key: KEY, bindings: bindings(bConn) }, ORIGIN)
    expect(s.ok).toBe(true)
    expect(receipts(b)).toEqual(receipts(a))
    expect(receipts(b).map((r) => r.action)).toEqual(['install', 'configure', 'activate'])
  })

  it('already-installed path: skips nothing it should run, install reported idempotent', async () => {
    const harness = makeHarness()
    const connectorId = await seedConnector(harness, 'https://wordpress.example.com')
    expect((await invokeTool(orgOwner, env(harness), 'addon_install', { key: KEY }, ORIGIN)).ok).toBe(true)
    stubSite(ok200)
    const out = await invokeTool(orgOwner, env(harness), 'addon_setup', { key: KEY, bindings: bindings(connectorId) }, ORIGIN)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect((out.result as { steps: unknown }).steps).toEqual([
        { step: 'install', outcome: 'idempotent' },
        { step: 'configure', outcome: 'applied' },
        { step: 'activate', outcome: 'applied' },
      ])
    }
    expect(receipts(harness).map((r) => r.action)).toEqual(['install', 'configure', 'activate'])
  })

  it('is idempotent when re-run on an active installation (no new receipts, bindings flagged not applied)', async () => {
    const { harness, connectorId } = await activeOffice()
    const before = receipts(harness).length
    stubSite(ok200)
    const out = await invokeTool(orgOwner, env(harness), 'addon_setup', { key: KEY, bindings: bindings(connectorId) }, ORIGIN)
    expect(out.ok).toBe(true)
    if (out.ok) {
      const result = out.result as { state: string; steps: unknown; bindings_applied?: boolean }
      expect(result.state).toBe('active')
      expect(result.steps).toEqual([
        { step: 'install', outcome: 'idempotent' },
        { step: 'configure', outcome: 'skipped' },
        { step: 'activate', outcome: 'idempotent' },
      ])
      expect(result.bindings_applied).toBe(false)
    }
    expect(receipts(harness).length).toBe(before)
  })

  it('a failing configure stops the chain: names the step, never activates', async () => {
    const harness = makeHarness()
    stubSite(ok200)
    const out = await invokeTool(orgOwner, env(harness), 'addon_setup', { key: KEY, bindings: bindings('connector-does-not-exist') }, ORIGIN)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.status).toBe(409)
      expect(out.detail).toMatchObject({
        failed_step: 'configure',
        completed_steps: [{ step: 'install', outcome: 'created' }],
      })
    }
    expect(installationState(harness)).toBe('installed')
    expect(receipts(harness).map((r) => r.action)).toEqual(['install'])
  })

  it('a failing install (unregistered key) reports failed_step install and writes nothing', async () => {
    const harness = makeHarness()
    const out = await invokeTool(orgOwner, env(harness), 'addon_setup', { key: 'no-such-addon' }, ORIGIN)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.status).toBe(404)
    expect(receipts(harness)).toEqual([])
  })

  it('activation does not depend on health: an unreachable site still activates and is reported', async () => {
    const harness = makeHarness()
    const connectorId = await seedConnector(harness, 'https://wordpress.example.com')
    stubSite(() => new Response('nope', { status: 401 }))
    const out = await invokeTool(orgOwner, env(harness), 'addon_setup', { key: KEY, bindings: bindings(connectorId) }, ORIGIN)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect((out.result as { state: string }).state).toBe('active')
      expect((out.result as { health: unknown }).health).toEqual({ status: 'failed', reason: 'key_invalid' })
    }
    expect(installationState(harness)).toBe('active')
  })

  it('authority floor: non-admin and squad-scoped admin are refused and nothing is written', async () => {
    const harness = makeHarness()
    const spy = stubSite(ok200)
    for (const who of [grantless, auth('sq', [grant('squad', 'squad-x', 'admin')]), auth('mem', [grant('org', null, 'member')])]) {
      const out = await invokeTool(who, env(harness), 'addon_setup', { key: KEY }, ORIGIN)
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.status).toBe(403)
    }
    expect(receipts(harness)).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })

  it('an org admin (not owner) may run it, and unknown args are rejected by schema', async () => {
    const harness = makeHarness()
    const connectorId = await seedConnector(harness, 'https://wordpress.example.com')
    stubSite(ok200)
    const bad = await invokeTool(orgAdmin, env(harness), 'addon_setup', { key: KEY, actor: 'x' }, ORIGIN)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.status).toBe(400)
    const good = await invokeTool(orgAdmin, env(harness), 'addon_setup', { key: KEY, bindings: bindings(connectorId) }, ORIGIN)
    expect(good.ok).toBe(true)
  })
})
