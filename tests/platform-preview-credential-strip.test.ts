// A proxy into less-trusted (agent-deployable) code must never carry the caller's ambient
// credentials. Drives the real Hono route + real dispatcher against a fake namespace that
// captures the forwarded Request.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { createProject } from '../src/projects/service'
import { platformApp } from '../src/platform/routes'
import { handlePlatformDispatch } from '../src/platform/dispatcher'
import { routeApexPathTenant } from '../src/dispatcher'

let harness: SqliteD1Harness | null = null
afterEach(() => { harness?.close(); harness = null })

const SESSION_RECORD = JSON.stringify({
  userId: 'u1', email: 'owner@pot.test', role: 'owner', createdAt: '2026-09-04T00:00:00.000Z',
})

function capture(respond: () => Response = () => new Response('ok')) {
  const seen: Request[] = []
  const worker = { fetch: async (request: Request) => { seen.push(request); return respond() } }
  return { seen, binding: { get: vi.fn(() => worker) } }
}

function envFor(h: SqliteD1Harness, binding: unknown): Env {
  return {
    DB: h.db, TENANT_SLUG: 'mumega', BRAND: 'Mupot', DISPATCHER: binding,
    SESSIONS: { get: vi.fn(async () => SESSION_RECORD) },
  } as unknown as Env
}

async function healthy(h: SqliteD1Harness, env: Env, slug: string): Promise<string> {
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
  `)
  const created = await createProject(env, {
    name: 'P', slug, goal: 'g', squad_id: 'squad-a', worker_name: slug, live_url: 'https://example.test',
  } as never)
  if (!created.ok) throw new Error('fixture')
  h.sqlite.exec(`UPDATE projects SET deploy_status = 'healthy' WHERE id = '${created.value.id}'`)
  return created.value.id
}

function setup() {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  return harness
}

const AMBIENT = {
  cookie: 'mupot_session=live; CF_Authorization=jwt; other=1',
  authorization: 'Bearer colony-token',
  'proxy-authorization': 'Basic abc',
  'cf-access-jwt-assertion': 'jwt',
  'cf-access-client-id': 'id',
  'cf-access-client-secret': 'secret',
  'cf-access-authenticated-user-email': 'a@b.c',
  'x-mupot-seat': 'seat',
  'x-mupot-auth-context': 'ctx',
  'mcp-session-id': 'sid',
}

describe('/preview/* forwards no ambient credentials', () => {
  it('drops every credential header, keeps method, body, and benign headers', async () => {
    const h = setup()
    const cap = capture()
    const env = envFor(h, cap.binding)
    const id = await healthy(h, env, 'strip-target')

    const res = await platformApp.fetch(new Request(`https://mupot.mumega.com/preview/${id}/api/x?q=1`, {
      method: 'POST',
      headers: { ...AMBIENT, 'content-type': 'application/json', accept: 'text/html', 'x-unknown-thing': 'v' },
      body: JSON.stringify({ hello: 'world' }),
    }), env)

    expect(res.status).toBe(200)
    expect(cap.seen).toHaveLength(1)
    const fwd = cap.seen[0]
    for (const name of Object.keys(AMBIENT)) expect(fwd.headers.has(name), name).toBe(false)
    expect(fwd.headers.has('x-unknown-thing')).toBe(false) // allow-list fails closed
    expect(fwd.headers.get('content-type')).toBe('application/json')
    expect(fwd.headers.get('accept')).toBe('text/html')
    expect(fwd.method).toBe('POST')
    expect(new URL(fwd.url).pathname).toBe('/api/x')
    expect(new URL(fwd.url).search).toBe('?q=1')
    expect(await fwd.json()).toEqual({ hello: 'world' })
  })

  it('preserves redirect mode', async () => {
    const h = setup()
    const cap = capture()
    const env = envFor(h, cap.binding)
    const id = await healthy(h, env, 'strip-target')
    await platformApp.fetch(new Request(`https://mupot.mumega.com/preview/${id}/`, {
      headers: { cookie: 'mupot_session=live' }, redirect: 'manual',
    }), env)
    expect(cap.seen[0].redirect).toBe('manual')
  })

  it('strips Set-Cookie from the user Worker response on /preview', async () => {
    const h = setup()
    const cap = capture(() => {
      const r = new Response('body', { status: 201, headers: { 'x-keep': '1' } })
      r.headers.append('set-cookie', 'mupot_session=attacker; Path=/')
      r.headers.append('set-cookie', 'other=1')
      return r
    })
    const env = envFor(h, cap.binding)
    const id = await healthy(h, env, 'strip-target')
    const res = await platformApp.fetch(new Request(`https://mupot.mumega.com/preview/${id}/`, {
      headers: { cookie: 'mupot_session=live' },
    }), env)
    expect(res.status).toBe(201)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('x-keep')).toBe('1')
    expect(await res.text()).toBe('body')
  })
})

describe('project hostname branch (the Worker\'s own origin)', () => {
  it('keeps its own cookie/authorization but drops colony gateway identity, keeps Set-Cookie', async () => {
    const h = setup()
    const cap = capture(() => {
      const r = new Response('ok')
      r.headers.append('set-cookie', 'own=1; Path=/')
      return r
    })
    const env = envFor(h, cap.binding)
    await healthy(h, env, 'hostproj')
    const res = await handlePlatformDispatch(new Request('https://hostproj.mupot.mumega.com/page', {
      headers: AMBIENT,
    }), env)
    expect(res).not.toBeNull()
    const fwd = cap.seen[0]
    expect(fwd.headers.get('cookie')).toContain('other=1')
    expect(fwd.headers.get('authorization')).toBe('Bearer colony-token')
    for (const name of ['proxy-authorization', 'cf-access-jwt-assertion', 'cf-access-client-id',
      'cf-access-client-secret', 'cf-access-authenticated-user-email', 'x-mupot-seat',
      'x-mupot-auth-context', 'mcp-session-id']) {
      expect(fwd.headers.has(name), name).toBe(false)
    }
    expect(res?.headers.get('set-cookie')).toContain('own=1')
  })
})

describe('/t/{tenant} path door (same-origin tenant dispatch)', () => {
  it('drops cf-access-*/x-mupot-* too and strips response Set-Cookie', async () => {
    const cap = capture(() => {
      const r = new Response('ok')
      r.headers.append('set-cookie', 'mupot_session=attacker')
      return r
    })
    const route = await routeApexPathTenant(new Request('https://mupot.mumega.com/t/gaf/mcp', {
      method: 'POST', headers: AMBIENT, body: 'x',
    }), { TENANT_SLUG: 'mumega', DISPATCHER: cap.binding as never })
    expect(route.kind).toBe('respond')
    const fwd = cap.seen[0]
    for (const name of Object.keys(AMBIENT)) expect(fwd.headers.has(name), name).toBe(false)
    if (route.kind === 'respond') expect(route.response.headers.get('set-cookie')).toBeNull()
  })
})
