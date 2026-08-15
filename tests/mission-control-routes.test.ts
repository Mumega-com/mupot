import { describe, expect, it } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { dashboardApp } from '../src/dashboard/index'
import type { Env, AuthContext } from '../src/types'

describe('Mission Control & Fleet Consolidation (Flight-003B)', () => {
  function makeEnv() {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)

    const sessionStore = new Map<string, string>()

    const env = {
      TENANT_SLUG: 'mumega',
      DB: harness.db,
      FLEET_PANEL_SK: 'test-sk',
      FLEET_CONSUMER_AGENT: 'agent-1',
      SESSIONS: {
        get: async (k: string) => sessionStore.get(k) ?? null,
        put: async (k: string, v: string) => sessionStore.set(k, v),
      },
    } as unknown as Env

    return { harness, env, sessionStore }
  }

  it('GET /fleet redirects with 301 to /radar?tab=fleet', async () => {
    const { harness, env, sessionStore } = makeEnv()
    const memberId = 'member-test'
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant) VALUES ('${memberId}', 'test@example.com', 'Tester', 'active', 'mumega');
      INSERT INTO capabilities (id, member_id, scope_type, capability) VALUES ('cap-1', '${memberId}', 'org', 'owner');
    `)

    sessionStore.set('sess:tok-1', JSON.stringify({
      userId: memberId,
      email: 'test@example.com',
      role: 'owner',
      createdAt: new Date().toISOString(),
    }))

    const req = new Request('http://localhost/fleet', {
      headers: {
        cookie: 'mupot_session=tok-1',
      },
    })
    const res = await dashboardApp.fetch(req, env, {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext)

    expect(res.status).toBe(301)
    expect(res.headers.get('Location')).toBe('/radar?tab=fleet')
  })

  it('GET /motherboard redirects with 301 to /radar?tab=motherboard', async () => {
    const { harness, env, sessionStore } = makeEnv()
    const memberId = 'member-test'
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant) VALUES ('${memberId}', 'test@example.com', 'Tester', 'active', 'mumega');
      INSERT INTO capabilities (id, member_id, scope_type, capability) VALUES ('cap-1', '${memberId}', 'org', 'owner');
    `)

    sessionStore.set('sess:tok-1', JSON.stringify({
      userId: memberId,
      email: 'test@example.com',
      role: 'owner',
      createdAt: new Date().toISOString(),
    }))

    const req = new Request('http://localhost/motherboard', {
      headers: {
        cookie: 'mupot_session=tok-1',
      },
    })
    const res = await dashboardApp.fetch(req, env, {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext)

    expect(res.status).toBe(301)
    expect(res.headers.get('Location')).toBe('/radar?tab=motherboard')
  })

  it('GET /coordination redirects with 301 to /radar?tab=departures', async () => {
    const { harness, env, sessionStore } = makeEnv()
    const memberId = 'member-test'
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant) VALUES ('${memberId}', 'test@example.com', 'Tester', 'active', 'mumega');
      INSERT INTO capabilities (id, member_id, scope_type, capability) VALUES ('cap-1', '${memberId}', 'org', 'owner');
    `)

    sessionStore.set('sess:tok-1', JSON.stringify({
      userId: memberId,
      email: 'test@example.com',
      role: 'owner',
      createdAt: new Date().toISOString(),
    }))

    const req = new Request('http://localhost/coordination', {
      headers: {
        cookie: 'mupot_session=tok-1',
      },
    })
    const res = await dashboardApp.fetch(req, env, {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext)

    expect(res.status).toBe(301)
    expect(res.headers.get('Location')).toBe('/radar?tab=departures')
  })

  it('GET /radar is accessible to regular members (non-admin capability floor)', async () => {
    const { harness, env, sessionStore } = makeEnv()
    const memberId = 'member-regular'
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant) VALUES ('${memberId}', 'regular@example.com', 'Regular Member', 'active', 'mumega');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-reg', '${memberId}', 'squad', 'squad-1', 'member');
    `)

    sessionStore.set('sess:tok-reg', JSON.stringify({
      userId: memberId,
      email: 'regular@example.com',
      role: 'member',
      createdAt: new Date().toISOString(),
    }))

    const req = new Request('http://localhost/radar', {
      headers: {
        cookie: 'mupot_session=tok-reg',
      },
    })
    const res = await dashboardApp.fetch(req, env, {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext)

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('Mission Control')
  })
})
