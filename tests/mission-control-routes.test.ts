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

  it('GET /tentacles redirects with 301 to /radar?tab=tentacles', async () => {
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

    const req = new Request('http://localhost/tentacles', {
      headers: {
        cookie: 'mupot_session=tok-1',
      },
    })
    const res = await dashboardApp.fetch(req, env, {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext)

    expect(res.status).toBe(301)
    expect(res.headers.get('Location')).toBe('/radar?tab=tentacles')
  })

  it('GET /radar?tab=tentacles renders Tentacles fan-out panel with runners', async () => {
    const { harness, env, sessionStore } = makeEnv()
    const memberId = 'member-test'
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept-1', 'Department 1');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'squad-1', 'Squad 1');
      INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-1', 'squad-1', 'agent-1', 'Agent 1', 'operator', 'test', 'active');
      INSERT INTO members (id, email, display_name, status, tenant) VALUES ('${memberId}', 'test@example.com', 'Tester', 'active', 'mumega');
      INSERT INTO capabilities (id, member_id, scope_type, capability) VALUES ('cap-1', '${memberId}', 'org', 'owner');
      INSERT INTO runner_receipts (id, tenant, seat_agent_id, squad_id, name, task, status, started_at, created_at, updated_at) VALUES
        ('run-101', 'mumega', 'agent-1', 'squad-1', 'gate-verifier-x', 'verify gate slice 1', 'landed', 1000, 1000, 1000);
    `)

    sessionStore.set('sess:tok-1', JSON.stringify({
      userId: memberId,
      email: 'test@example.com',
      role: 'owner',
      createdAt: new Date().toISOString(),
    }))

    const req = new Request('http://localhost/radar?tab=tentacles', {
      headers: {
        cookie: 'mupot_session=tok-1',
      },
    })
    const res = await dashboardApp.fetch(req, env, {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext)

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('Colony Fan-Out (Tentacles)')
    expect(text).toContain('gate-verifier-x')
  })

  it('GET /radar is accessible to squad-capable regular members (200, non-admin capability floor)', async () => {
    const { harness, env, sessionStore } = makeEnv()
    const memberId = 'member-regular'
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept-1', 'Department 1');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'squad-1', 'Squad 1');
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

  it('GET /radar returns 403 for zero-capability members (fail-closed authz floor)', async () => {
    const { harness, env, sessionStore } = makeEnv()
    const memberId = 'member-zero'
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant) VALUES ('${memberId}', 'zero@example.com', 'Zero Member', 'active', 'mumega');
    `)

    sessionStore.set('sess:tok-zero', JSON.stringify({
      userId: memberId,
      email: 'zero@example.com',
      role: 'member',
      createdAt: new Date().toISOString(),
    }))

    const req = new Request('http://localhost/radar', {
      headers: {
        cookie: 'mupot_session=tok-zero',
      },
    })
    const res = await dashboardApp.fetch(req, env, {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext)

    expect(res.status).toBe(403)
  })
})
