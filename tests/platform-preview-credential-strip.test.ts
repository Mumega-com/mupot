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
import { projectLivePreviewSplitHtml } from '../src/platform/routes'
import {
  SANDBOX_CSP,
  sanitizeColonyOriginResponse,
  sanitizeOwnOriginResponse,
} from '../src/platform/forward-policy'

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

  it('rebuilds the response from a header allow-list and adds the sandbox CSP', async () => {
    const h = setup()
    const cap = capture(() => {
      const r = new Response('body', { status: 201, headers: {
        'content-type': 'text/html', etag: '"v1"', 'x-keep-not': '1',
        'service-worker-allowed': '/', 'clear-site-data': '"cookies"', refresh: '0;url=/',
        link: '</x>; rel=preload', 'access-control-allow-origin': '*',
        'permissions-policy': 'camera=()', 'content-security-policy-report-only': 'default-src *',
      } })
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
    for (const name of ['set-cookie', 'service-worker-allowed', 'clear-site-data', 'refresh', 'link',
      'access-control-allow-origin', 'permissions-policy', 'x-keep-not', 'content-security-policy-report-only']) {
      expect(res.headers.has(name), name).toBe(false)
    }
    expect(res.headers.get('etag')).toBe('"v1"')
    expect(res.headers.get('content-type')).toBe('text/html')
    expect(res.headers.get('content-security-policy')).toBe(SANDBOX_CSP)
    expect(SANDBOX_CSP).not.toContain('allow-same-origin')
    expect(await res.text()).toBe('body')
  })

  it('keeps the Worker\'s own CSP AND adds the sandbox', async () => {
    const h = setup()
    const cap = capture(() => new Response('x', { headers: { 'content-security-policy': "default-src 'self'" } }))
    const env = envFor(h, cap.binding)
    const id = await healthy(h, env, 'strip-target')
    const res = await platformApp.fetch(new Request(`https://mupot.mumega.com/preview/${id}/`, { headers: { cookie: 'mupot_session=live' } }), env)
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain('sandbox allow-scripts')
    expect(csp).not.toContain('allow-same-origin')
  })

  it('drops a Location that leaves the preview prefix, keeps in-prefix and external', async () => {
    const h = setup()
    let loc = '/login'
    const cap = capture(() => new Response(null, { status: 302, headers: { location: loc } }))
    const env = envFor(h, cap.binding)
    const id = await healthy(h, env, 'strip-target')
    const get = async (l: string) => {
      loc = l
      const res = await platformApp.fetch(new Request(`https://mupot.mumega.com/preview/${id}/a/b`, { redirect: 'manual', headers: { cookie: 'mupot_session=live' } }), env)
      return res.headers.get('location')
    }
    expect(await get('/login')).toBeNull()
    expect(await get('/dashboard/projects')).toBeNull()
    expect(await get(`/preview/${id}/next`)).toBe(`/preview/${id}/next`)
    expect(await get('sibling')).toBe('sibling')
    expect(await get('https://example.org/x')).toBe('https://example.org/x')
    expect(await get('javascript:alert(1)')).toBeNull()
  })

  it('refuses a service-worker script fetch without consulting the namespace', async () => {
    const h = setup()
    const cap = capture()
    const env = envFor(h, cap.binding)
    const id = await healthy(h, env, 'strip-target')
    const res = await platformApp.fetch(new Request(`https://mupot.mumega.com/preview/${id}/sw.js`, {
      headers: { 'service-worker': 'script', cookie: 'mupot_session=live' },
    }), env)
    expect(res.status).toBe(403)
    expect(cap.seen).toHaveLength(0)
  })

  it('propagates client disconnect to the user Worker', async () => {
    const h = setup()
    const cap = capture()
    const env = envFor(h, cap.binding)
    const id = await healthy(h, env, 'strip-target')
    const ac = new AbortController()
    await platformApp.fetch(new Request(`https://mupot.mumega.com/preview/${id}/`, { signal: ac.signal, headers: { cookie: 'mupot_session=live' } }), env)
    expect(cap.seen[0].signal.aborted).toBe(false)
    ac.abort()
    expect(cap.seen[0].signal.aborted).toBe(true)
  })

  it('a 101 upgrade is never rewrapped into a crash on either policy', () => {
    const headers = new Headers()
    headers.append('set-cookie', 'planted=1; Domain=example.test')
    const upgrade = { status: 101, headers, body: null } as unknown as Response
    expect(sanitizeOwnOriginResponse(upgrade)).toBe(upgrade)
    const colony = sanitizeColonyOriginResponse(upgrade, { requestUrl: 'https://x.test/preview/i/', pathPrefix: '/preview/i/' })
    expect(colony.status).toBe(501)
  })

  it('the embedding iframe does not grant allow-same-origin', () => {
    const out = String(projectLivePreviewSplitHtml({ project: {
      id: 'p1', name: 'P', slug: 'p', repo_url: null, live_url: null, worker_name: 'p', deploy_status: 'healthy',
    } } as never))
    const m = out.match(/sandbox="([^"]*)"/)
    expect(m?.[1]).toContain('allow-scripts')
    expect(m?.[1]).not.toContain('allow-same-origin')
  })
})

describe('project hostname branch (the Worker\'s own origin)', () => {
  it('keeps its own cookie/authorization but drops colony gateway identity, keeps Set-Cookie', async () => {
    const h = setup()
    const cap = capture(() => {
      const r = new Response('ok')
      r.headers.append('set-cookie', 'own=1; Path=/')
      r.headers.append('set-cookie', 'planted=1; Domain=mupot.mumega.com; Path=/')
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
      'x-mupot-auth-context']) {
      expect(fwd.headers.has(name), name).toBe(false)
    }
    expect(fwd.headers.get('mcp-session-id')).toBe('sid') // the project's own session id
    const setCookies = (res?.headers as Headers & { getSetCookie(): string[] }).getSetCookie()
    expect(setCookies).toEqual(["own=1; Path=/"])
  })
})

describe('/t/{tenant} path door (same-origin tenant dispatch)', () => {
  function registerPot(h: SqliteD1Harness, slug: string, status = 'active', script = slug) {
    h.sqlite.exec(`INSERT INTO pots (id, slug, worker_script, status) VALUES ('pot-${slug}', '${slug}', '${script}', '${status}')`)
  }

  it('uses the colony-origin allow-list and contains the response', async () => {
    const h = setup()
    registerPot(h, 'gaf')
    const cap = capture(() => {
      const r = new Response('ok', { headers: { 'mcp-session-id': 'x', 'x-other': '1' } })
      r.headers.append('set-cookie', 'mupot_session=attacker')
      return r
    })
    const route = await routeApexPathTenant(new Request('https://mupot.mumega.com/t/gaf/mcp', {
      method: 'POST', headers: { ...AMBIENT, 'x-unknown': '1', accept: 'application/json' }, body: 'x',
    }), { TENANT_SLUG: 'mumega', DISPATCHER: cap.binding as never, DB: h.db })
    expect(route.kind).toBe('respond')
    const fwd = cap.seen[0]
    for (const name of [...Object.keys(AMBIENT), 'x-unknown']) expect(fwd.headers.has(name), name).toBe(false)
    expect(fwd.headers.get('accept')).toBe('application/json')
    if (route.kind !== 'respond') return
    for (const name of ['set-cookie', 'x-other', 'mcp-session-id']) expect(route.response.headers.has(name), name).toBe(false)
    expect(route.response.headers.get('content-security-policy')).toBe(SANDBOX_CSP)
  })

  it('refuses (404) a project Worker name and never consults the namespace', async () => {
    const h = setup()
    const cap = capture()
    const env = envFor(h, cap.binding)
    await healthy(h, env, 'agent-project')
    const route = await routeApexPathTenant(new Request('https://mupot.mumega.com/t/agent-project/'), {
      TENANT_SLUG: 'mumega', DISPATCHER: cap.binding as never, DB: h.db,
    })
    expect(route.kind).toBe('respond')
    if (route.kind === 'respond') expect(route.response.status).toBe(404)
    expect(cap.binding.get).not.toHaveBeenCalled()
  })

  it.each([
    ['provisioning', 'gaf'],
    ['released', 'gaf'],
    ['active', 'other-script'],
  ])('refuses a registered pot with status %s / script %s mismatch', async (status, script) => {
    const h = setup()
    registerPot(h, 'gaf', status, script)
    const cap = capture()
    const route = await routeApexPathTenant(new Request('https://mupot.mumega.com/t/gaf/'), {
      TENANT_SLUG: 'mumega', DISPATCHER: cap.binding as never, DB: h.db,
    })
    if (route.kind === 'respond') expect(route.response.status).toBe(404)
    expect(cap.binding.get).not.toHaveBeenCalled()
  })

  it('fails closed with no registry binding', async () => {
    const cap = capture()
    const route = await routeApexPathTenant(new Request('https://mupot.mumega.com/t/gaf/'), {
      TENANT_SLUG: 'mumega', DISPATCHER: cap.binding as never,
    })
    if (route.kind === 'respond') expect(route.response.status).toBe(404)
    expect(cap.binding.get).not.toHaveBeenCalled()
  })

  it('refuses a service-worker script fetch', async () => {
    const h = setup()
    registerPot(h, 'gaf')
    const cap = capture()
    const route = await routeApexPathTenant(new Request('https://mupot.mumega.com/t/gaf/sw.js', {
      headers: { 'service-worker': 'script' },
    }), { TENANT_SLUG: 'mumega', DISPATCHER: cap.binding as never, DB: h.db })
    if (route.kind === 'respond') expect(route.response.status).toBe(403)
    expect(cap.seen).toHaveLength(0)
  })
})
