import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  createDeviceGrant,
  decideDeviceGrant,
  listPendingDeviceGrants,
  pollDeviceGrant,
} from '../src/auth/device-grant'
import { deviceApp } from '../src/auth/device-routes'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
const HUMAN = 'member-human-1'
const AGENT_A = { id: 'agent-a', slug: 'agent-a', name: 'Agent A', squad_id: 'squad-a' }
const AGENT_B = { id: 'agent-b', slug: 'agent-b', name: 'Agent B', squad_id: 'squad-b' }
const MEMBER_AGENT_A = 'member-agent-a'
const MEMBER_AGENT_B = 'member-agent-b'

function memoryKv() {
  const store = new Map<string, string>()
  return {
    async get(key: string, type?: string) {
      const v = store.get(key)
      if (v === undefined) return null
      return type === 'json' ? JSON.parse(v) : v
    },
    async put(key: string, value: string, _opts?: { expirationTtl?: number }) {
      store.set(key, value)
    },
    async delete(key: string) {
      store.delete(key)
    },
  }
}

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO org_settings (key, value, updated_at) VALUES ('billing_state', '{"tier":"scale"}', '2026-08-01T00:00:00.000Z');
    INSERT INTO departments (id, slug, name) VALUES ('dept-eng', 'eng', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-eng', 'squad-a', 'Squad A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-b', 'dept-eng', 'squad-b', 'Squad B');
    INSERT INTO agents (id, squad_id, slug, name, status)
      VALUES ('${AGENT_A.id}', '${AGENT_A.squad_id}', '${AGENT_A.slug}', '${AGENT_A.name}', 'active');
    INSERT INTO agents (id, squad_id, slug, name, status)
      VALUES ('${AGENT_B.id}', '${AGENT_B.squad_id}', '${AGENT_B.slug}', '${AGENT_B.name}', 'active');
    INSERT INTO members (id, email, display_name, status, created_at, tenant)
      VALUES ('${HUMAN}', 'human@example.test', 'Human', 'active', '2026-08-01T00:00:00.000Z', '${TENANT}');
    INSERT INTO members (id, email, display_name, status, created_at, tenant)
      VALUES ('${MEMBER_AGENT_A}', NULL, '${AGENT_A.name}', 'active', '2026-08-01T00:00:00.000Z', '${TENANT}');
    INSERT INTO members (id, email, display_name, status, created_at, tenant)
      VALUES ('${MEMBER_AGENT_B}', NULL, '${AGENT_B.name}', 'active', '2026-08-01T00:00:00.000Z', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', '${AGENT_A.id}', '${MEMBER_AGENT_A}', '2026-08-01T00:00:00.000Z');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', '${AGENT_B.id}', '${MEMBER_AGENT_B}', '2026-08-01T00:00:00.000Z');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-a-home', '${MEMBER_AGENT_A}', 'squad', '${AGENT_A.squad_id}', 'member');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-b-home', '${MEMBER_AGENT_B}', 'squad', '${AGENT_B.squad_id}', 'member');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-human-squad-a', '${HUMAN}', 'squad', '${AGENT_A.squad_id}', 'admin');
  `)
}

function envFor(harness: SqliteD1Harness, kv = memoryKv()): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    SESSIONS: kv,
    BUS: { send: async () => {} },
  } as unknown as Env
}

function adminAuth(): AuthContext {
  return {
    userId: HUMAN,
    email: 'human@example.test',
    role: 'member',
    tenant: TENANT,
    memberId: HUMAN,
    capabilities: [{ member_id: HUMAN, scope_type: 'squad', scope_id: AGENT_A.squad_id, capability: 'admin' }],
  }
}

let harness: SqliteD1Harness

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  seed(harness.sqlite)
})

afterEach(() => {
  harness.close()
})

describe('device grant click-to-approve', () => {
  it('creates a user_code for an active agent and lists it without the raw token', async () => {
    const env = envFor(harness)
    const created = await createDeviceGrant(env, { agent: 'agent-a', origin: 'https://mupot.mumega.com' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.value.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    expect(created.value.verification_uri).toBe('https://mupot.mumega.com/device')
    const listed = await listPendingDeviceGrants(env)
    expect(listed).toHaveLength(1)
    expect(listed[0].raw_token).toBeNull()
    expect(listed[0].user_code).toBe(created.value.user_code)
  })

  it('poll stays pending until Allow; Allow mints; poll returns raw once', async () => {
    const env = envFor(harness)
    const created = await createDeviceGrant(env, { agent: AGENT_A.slug, origin: 'https://pot.test' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const pending = await pollDeviceGrant(env, created.value.device_code)
    expect(pending.status).toBe('authorization_pending')

    const decided = await decideDeviceGrant(env, {
      user_code: created.value.user_code,
      action: 'allow',
      auth: adminAuth(),
    })
    expect(decided).toEqual({ ok: true, status: 'approved' })

    const listed = await listPendingDeviceGrants(env)
    expect(listed.every((g) => g.raw_token === null)).toBe(true)

    const first = await pollDeviceGrant(env, created.value.device_code)
    expect(first.status).toBe('ok')
    expect(first.access_token?.startsWith('mupot_')).toBe(true)
    expect(first.agent_slug).toBe('agent-a')

    const second = await pollDeviceGrant(env, created.value.device_code)
    expect(second.status).toBe('expired_token')
    expect(second.access_token).toBeUndefined()
  })

  it('Deny does not mint; poll is access_denied', async () => {
    const env = envFor(harness)
    const created = await createDeviceGrant(env, { agent: AGENT_A.slug, origin: 'https://pot.test' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const decided = await decideDeviceGrant(env, {
      user_code: created.value.user_code,
      action: 'deny',
      auth: adminAuth(),
    })
    expect(decided).toEqual({ ok: true, status: 'denied' })
    const polled = await pollDeviceGrant(env, created.value.device_code)
    expect(polled.status).toBe('access_denied')
    expect(polled.access_token).toBeUndefined()
  })

  it('member without admin-on-squad cannot Allow another squad agent', async () => {
    const env = envFor(harness)
    const created = await createDeviceGrant(env, { agent: AGENT_B.slug, origin: 'https://pot.test' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const decided = await decideDeviceGrant(env, {
      user_code: created.value.user_code,
      action: 'allow',
      auth: adminAuth(),
    })
    expect(decided).toEqual({ ok: false, error: 'forbidden' })
    const polled = await pollDeviceGrant(env, created.value.device_code)
    expect(polled.status).toBe('authorization_pending')
  })

  it('unknown agent at create fails closed', async () => {
    const env = envFor(harness)
    const created = await createDeviceGrant(env, { agent: 'grokbot-ceo', origin: 'https://pot.test' })
    expect(created).toEqual({ ok: false, error: 'invalid_agent' })
  })

  it('unknown device_code poll does not distinguish missing vs consumed', async () => {
    const env = envFor(harness)
    const missing = await pollDeviceGrant(env, 'NO-SUCH-CODE')
    expect(missing.status).toBe('expired_token')
  })

  it('POST /code returns the codes; GET /device without session redirects to login', async () => {
    const env = envFor(harness)
    const created = await deviceApp.fetch(
      new Request('http://pot.test/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'agent-a' }),
      }),
      env,
    )
    expect(created.status).toBe(200)
    const body = (await created.json()) as { user_code: string; verification_uri: string; device_code: string }
    expect(body.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    expect(body.verification_uri).toBe('http://pot.test/device')
    expect(JSON.stringify(body).includes('mupot_')).toBe(false)

    const page = await deviceApp.fetch(new Request('http://pot.test/'), env)
    expect(page.status).toBe(302)
    expect(page.headers.get('location')).toBe('/auth/login')
  })
})
