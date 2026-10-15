// mupot#1928 — path-routed tenants (/t/<slug>): every URL the dashboard emits must stay under the
// prefix. Exercises the real dashboardApp on the real migration chain, then the same choke point
// the Worker entry applies (responsePrefixFor + applyTenantPrefix).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authApp } from '../src/auth'
import { dashboardApp } from '../src/dashboard/index'
import { requiredCanonicalOrigin, canonicalOrigin } from '../src/dashboard/connect'
import { resolveApexPathTenant } from '../src/dispatcher'
import {
  TENANT_GLOBAL_PATHS,
  TENANT_PREFIX_HEADER,
  applyTenantPrefix,
  parseTenantPrefix,
  prefixLocation,
  requestBase,
  responsePrefixFor,
  rewriteHtmlForPrefix,
  stripUntrustedPrefix,
  tenantPath,
  tenantPrefixOf,
} from '../src/platform/tenant-path'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'local'
const PREFIX = '/t/local'

function kv() {
  const store = new Map<string, string>()
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  }
}

describe('parseTenantPrefix / tenantPath (the only accepted shape)', () => {
  it('accepts /t/<slug> and lower-cases it', () => {
    expect(parseTenantPrefix('/t/gaf')).toBe('/t/gaf')
    expect(parseTenantPrefix('/T/GAF')).toBe('/t/gaf')
  })

  it.each([
    '//evil.com', '/t/a/../b', '/t/a?x=1', '/t/a#x', 'https://evil.com', '/t/a%2fb', '/t/a\\b', '/t/-a', '/t/a-',
    '/t/', '/t', '', '/x/t/a', '/t/a/', '/t/a b', '/t/a\r\nSet-Cookie: x=1', null, undefined,
  ])('refuses %j', (v) => {
    expect(parseTenantPrefix(v)).toBeNull()
  })

  it('tenantPath prefixes root-relative paths only', () => {
    expect(tenantPath('/t/gaf', '/account')).toBe('/t/gaf/account')
    expect(tenantPath(null, '/account')).toBe('/account')
    for (const bad of ['//evil.com/x', '/\\evil.com', 'https://evil.com', 'account', '/x\r\ny', '']) {
      expect(() => tenantPath('/t/gaf', bad)).toThrow(TypeError)
    }
  })
})

describe('redirects (Location header)', () => {
  it('re-roots a root-relative Location under the prefix, once', async () => {
    const res = await applyTenantPrefix(new Response(null, { status: 302, headers: { location: '/auth/login' } }), PREFIX)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/t/local/auth/login')
    expect(prefixLocation('/t/local/auth/login', PREFIX)).toBe('/t/local/auth/login')
    expect(prefixLocation('/t/local', PREFIX)).toBe('/t/local')
  })

  it('OPEN-REDIRECT REFUSAL: absolute and protocol-relative Locations are never rewritten into the prefix or accepted as prefix', async () => {
    for (const loc of ['//evil.com/x', 'https://evil.com/x', '/\\evil.com']) {
      expect(prefixLocation(loc, PREFIX)).toBe(loc)
    }
    // a client-sent prefix header can never carry a hostile value into the rewrite
    for (const hostile of ['//evil.com', 'https://evil.com', '/t/a/../../x', '/t/a\\evil']) {
      const req = new Request('https://mupot.mumega.com/account', { headers: { [TENANT_PREFIX_HEADER]: hostile } })
      expect(responsePrefixFor(req, 'mumega')).toBeNull()
    }
  })

  it('a /t/<slug> path beats a client-sent header; a foreign slug is not re-rooted by the apex', () => {
    const forged = { [TENANT_PREFIX_HEADER]: '/t/victim' }
    expect(responsePrefixFor(new Request('https://h.test/t/mumega/x', { headers: forged }), 'mumega')).toBe('/t/mumega')
    expect(responsePrefixFor(new Request('https://h.test/t/other/x', { headers: forged }), 'mumega')).toBeNull()
    expect(responsePrefixFor(new Request('https://h.test/t/other/x'), 'mumega')).toBeNull()
    expect(responsePrefixFor(new Request('https://h.test/x', { headers: forged }), 'mumega')).toBeNull()
    expect(responsePrefixFor(new Request('https://h.test/x', { headers: { [TENANT_PREFIX_HEADER]: '/t/mumega' } }), 'mumega')).toBe('/t/mumega')
  })

  it('the apex stamps the SERVER-resolved prefix on home and dispatched requests, overwriting a client value', () => {
    const forged = { [TENANT_PREFIX_HEADER]: '//evil.com' }
    const home = resolveApexPathTenant(new Request('https://mupot.mumega.com/t/mumega/account', { headers: forged }), 'mumega')
    expect(home?.kind).toBe('home')
    if (home?.kind === 'home') expect(home.request.headers.get(TENANT_PREFIX_HEADER)).toBe('/t/mumega')
    const disp = resolveApexPathTenant(new Request('https://mupot.mumega.com/t/gaf/account', { headers: forged }), 'mumega')
    expect(disp?.kind).toBe('dispatch')
    if (disp?.kind === 'dispatch') {
      expect(disp.request.headers.get(TENANT_PREFIX_HEADER)).toBe('/t/gaf')
      expect(new URL(disp.request.url).pathname).toBe('/account')
    }
  })
})

describe('html rewrite shapes', () => {
  it('rewrites attributes (incl. backslash-escaped markup in JS strings), nav assignments, origin joins, meta refresh', () => {
    const out = rewriteHtmlForPrefix(
      `<html><head><title>x</title></head><body>
<a href="/a">a</a><a href='/b'>b</a><form action="/c" method="post"></form><img src="/d.png">
<a href="//cdn.example/x">cdn</a><a href="https://e.test/x">ext</a><a href="/t/local/already">done</a>
<script>var h='<a href=\\"/js\\">x</a>'; location.href = '/e'; window.location.assign('/f'); location.origin + '/invite/'; fetch('/api/x/' + id); r.open('POST', '/api/y')</script>
<meta http-equiv="refresh" content="0;url=/g"></body></html>`,
      PREFIX,
    )
    for (const want of ['href="/t/local/a"', "href='/t/local/b'", 'action="/t/local/c"', 'src="/t/local/d.png"',
      'href="//cdn.example/x"', 'href="https://e.test/x"', 'href="/t/local/already"', 'href=\\"/t/local/js\\"',
      "location.href = '/t/local/e'", "assign('/t/local/f')", "location.origin + '/t/local/invite/'", 'url=/t/local/g',
      'window.__MUPOT_BASE=P', "fetch('/t/local/api/x/'", "open('POST', '/t/local/api/y'"]) {
      expect(out, want).toContain(want)
    }
    expect(out.indexOf('<script>(function(){var P=')).toBeGreaterThan(out.indexOf('<head>'))
  })

  it('leaves JSON / SSE / non-HTML bodies byte-identical and skips the shim under a page CSP', async () => {
    const json = new Response('{"u":"/x"}', { headers: { 'content-type': 'application/json' } })
    expect(await (await applyTenantPrefix(json, PREFIX)).text()).toBe('{"u":"/x"}')
    const csp = await applyTenantPrefix(
      new Response('<head></head><a href="/x">', { headers: { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'" } }),
      PREFIX,
    )
    const text = await csp.text()
    expect(text).toContain('href="/t/local/x"')
    expect(text).not.toContain('__MUPOT_BASE')
  })

  it('the global-path allowlist is empty by design (reviewed addition only)', () => {
    expect(TENANT_GLOBAL_PATHS).toEqual([])
  })
})

describe('absolute links built outside the response (email / Stripe / OAuth / MCP endpoint)', () => {
  it('PUBLIC_ORIGIN of a path tenant keeps /t/<slug> through canonicalOrigin and requiredCanonicalOrigin', () => {
    const env = { PUBLIC_ORIGIN: 'https://mupot.mumega.com/t/gaf' }
    expect(canonicalOrigin(env, 'https://req.test')).toBe('https://mupot.mumega.com/t/gaf')
    expect(requiredCanonicalOrigin(env)).toEqual({ ok: true, origin: 'https://mupot.mumega.com/t/gaf' })
    expect(canonicalOrigin({ PUBLIC_ORIGIN: 'https://pot.example.com' }, 'x')).toBe('https://pot.example.com')
    // a hostile path in PUBLIC_ORIGIN is dropped, never carried
    expect(canonicalOrigin({ PUBLIC_ORIGIN: 'https://pot.example.com/%2e%2e//evil' }, 'x')).toBe('https://pot.example.com')
  })

  it('requestBase: a path-routed pot uses the pinned public host + prefix, not the internal dispatch host', () => {
    const req = new Request('https://gaf.mupot.mumega.com/auth/login', { headers: { [TENANT_PREFIX_HEADER]: '/t/gaf' } })
    expect(requestBase({ PUBLIC_ORIGIN: 'https://mupot.mumega.com/t/gaf', TENANT_SLUG: 'gaf' }, req)).toBe('https://mupot.mumega.com/t/gaf')
    const plain = new Request('https://pot.example.com/auth/login')
    expect(requestBase({ PUBLIC_ORIGIN: 'https://other.test', TENANT_SLUG: 'gaf' }, plain)).toBe('https://pot.example.com')
  })

  it('home tenant on its /t/<home> alias keeps ROOT urls (OAuth callback stays the registered /auth/callback)', () => {
    const req = new Request('https://mupot.mumega.com/auth/login', { headers: { [TENANT_PREFIX_HEADER]: '/t/mumega' } })
    expect(requestBase({ PUBLIC_ORIGIN: 'https://mupot.mumega.com', TENANT_SLUG: 'mumega' }, req)).toBe('https://mupot.mumega.com')
  })

  it('FORGED HEADER (direct request, no /t/ path): no reader honours a prefix naming another tenant', () => {
    const forged = { [TENANT_PREFIX_HEADER]: '/t/attackerpot' }
    const env = { PUBLIC_ORIGIN: 'https://pot.example.com', TENANT_SLUG: 'victim' }
    const req = new Request('https://pot.example.com/auth/email/start', { method: 'POST', headers: forged })
    expect(tenantPrefixOf(req, 'victim')).toBeNull()
    expect(requestBase(env, req)).toBe('https://pot.example.com')
    expect(responsePrefixFor(req, 'victim')).toBeNull()
    expect(stripUntrustedPrefix(req, 'victim').headers.has(TENANT_PREFIX_HEADER)).toBe(false)
    // the tenant's own slug is the only value honoured
    const own = new Request('https://x.test/', { headers: { [TENANT_PREFIX_HEADER]: '/t/victim' } })
    expect(stripUntrustedPrefix(own, 'victim')).toBe(own)
  })
})

describe('forged prefix header on the real sign-in route (end to end)', () => {
  let harness: SqliteD1Harness
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
  })
  afterEach(() => {
    harness.close()
    vi.restoreAllMocks()
  })

  async function startSignIn(headers: Record<string, string>, publicOrigin: string): Promise<string> {
    const calls: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void calls.push(a.map(String).join(' ')))
    const env = {
      DB: harness.db, TENANT_SLUG: 'victim', BRAND: 'V', PUBLIC_ORIGIN: publicOrigin, SESSIONS: kv(),
      OAUTH_CLIENT_ID: 'id', OAUTH_CLIENT_SECRET: 'sec', EMAIL_LOGIN_ENABLED: 'true', EMAIL_PROVIDER: 'console',
    } as unknown as Env
    const deferred: Promise<unknown>[] = []
    const ctx = { waitUntil: (p: Promise<unknown>) => deferred.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext
    const res = await authApp.fetch(new Request('https://pot.example.com/email/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'https://pot.example.com', ...headers },
      body: JSON.stringify({ email: 'someone@example.com' }),
    }), env, ctx)
    expect(res.status).toBe(200)
    await Promise.all(deferred)
    const sent = calls.find((c) => /Sign in: /.test(c))
    return /Sign in: (\S+)/.exec(sent ?? '')?.[1] ?? ''
  }

  it('a forged /t/attackerpot yields a sign-in link with NO prefix, same as no header', async () => {
    const forged = await startSignIn({ [TENANT_PREFIX_HEADER]: '/t/attackerpot' }, 'https://pot.example.com')
    expect(forged).toMatch(/^https:\/\/pot\.example\.com\/auth\/email\/verify\?/)
    expect(forged).not.toContain('/t/')
  })

  it('the legitimate stamp for this tenant still yields the prefixed link', async () => {
    const ok = await startSignIn({ [TENANT_PREFIX_HEADER]: '/t/victim' }, 'https://mupot.mumega.com/t/victim')
    expect(ok).toMatch(/^https:\/\/mupot\.mumega\.com\/t\/victim\/auth\/email\/verify\?/)
  })
})

describe('rewriter narrowing (P2)', () => {
  it('never stacks a second prefix on any /t/<slug> path', () => {
    expect(prefixLocation('/t/other/x', '/t/local')).toBe('/t/other/x')
    expect(prefixLocation('/t/other', '/t/local')).toBe('/t/other')
    expect(prefixLocation('/t/other?x=1', '/t/local')).toBe('/t/other?x=1')
    expect(prefixLocation('/team/x', '/t/local')).toBe('/t/local/team/x')
  })

  it('leaves pre/code/textarea bodies, JSON scripts and text content alone; meta refresh only in a refresh meta', () => {
    const html = '<!doctype html><html><head><meta name="x" content="a;url=/n"><meta http-equiv="refresh" content="0;url=/g">'
      + '<script type="application/json">{"u":"fetch(\'/j\')","h":" href=\"/j2\""}</script></head><body>'
      + '<header><a href="/h">h</a></header><pre>href="/p" fetch(\'/p2\')</pre><code>action="/c"</code>'
      + '<p>text href="/t1" and url=/t2</p><textarea>href="/ta"</textarea></body></html>'
    const out = rewriteHtmlForPrefix(html, PREFIX)
    for (const keep of ['content="a;url=/n"', `{"u":"fetch('/j')","h":" href=\"/j2\""}`, '<pre>href="/p" fetch(\'/p2\')</pre>',
      '<code>action="/c"</code>', '<p>text href="/t1" and url=/t2</p>', '<textarea>href="/ta"</textarea>']) {
      expect(out, keep).toContain(keep)
    }
    expect(out).toContain('content="0;url=/t/local/g"')
    expect(out).toContain('<header><a href="/t/local/h">')
    // shim lands in <head>, not inside <header>
    expect(out.indexOf('__MUPOT_BASE')).toBeLessThan(out.indexOf('<header>'))
  })

  it('no <head>: the shim is never injected inside <header>', () => {
    const out = rewriteHtmlForPrefix('<html><body><header class="h">x</header></body></html>', PREFIX)
    expect(out.indexOf('__MUPOT_BASE')).toBeLessThan(out.indexOf('<header'))
    expect(out).toContain('<header class="h">x</header>')
  })

  it('a fragment gets no shim', () => {
    const out = rewriteHtmlForPrefix('<div><a href="/x">x</a></div>', PREFIX)
    expect(out).toBe('<div><a href="/t/local/x">x</a></div>')
  })

  it('rewritten responses carry Vary: x-mupot-path-prefix', async () => {
    const html = await applyTenantPrefix(new Response('<html><head></head></html>', { headers: { 'content-type': 'text/html' } }), PREFIX)
    expect(html.headers.get('vary')).toContain(TENANT_PREFIX_HEADER)
    const redir = await applyTenantPrefix(new Response(null, { status: 302, headers: { location: '/x' } }), PREFIX)
    expect(redir.headers.get('vary')).toContain(TENANT_PREFIX_HEADER)
  })
})

// ---- sweep: the real dashboard pages -------------------------------------------------------

const ATTR_ANY = /\s(?:href|src|action|formaction)\s*=\s*\\?["'](\/(?!\/)[^"'\\]*)/gi
const JS_NAV = /(?:fetch\(|EventSource\(|location(?:\.href)?\s*=|location\.(?:assign|replace)\(|location\.origin\s*\+)\s*['"`](\/(?!\/)[^'"`\\]*)/g

function unprefixed(html: string): string[] {
  const bad: string[] = []
  for (const re of [ATTR_ANY, JS_NAV]) {
    for (const m of html.matchAll(re)) {
      const url = m[1]
      if (url === PREFIX || url.startsWith(`${PREFIX}/`) || url.startsWith(`${PREFIX}?`)) continue
      if (TENANT_GLOBAL_PATHS.some((g) => url === g || url.startsWith(`${g}/`))) continue
      bad.push(url)
    }
  }
  return bad
}

const PAGES = [
  '/', '/account', '/agents', '/flights', '/radar', '/addons', '/audit', '/members', '/admin/members', '/admin/keys',
  '/copilot', '/economy', '/deployment', '/send', '/admin/divisions', '/projects', '/work', '/needs-you', '/approvals',
  '/ops', '/verifications', '/admin/im-settings', '/health', '/admin/github',
]

describe('sweep: dashboard pages under a /t/<slug> request emit no unprefixed URL', () => {
  let harness: SqliteD1Harness
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO users (id, email, role) VALUES ('user-seed', 'seed@x.test', 'member');
      INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'delivery', 'Delivery');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'alpha', 'Squad Alpha');
      INSERT INTO projects (id, slug, name, status) VALUES ('project-a', 'proj-a', 'Project A', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-a', 'squad-a', 'write');
      INSERT INTO members (id, email, display_name, status, tenant) VALUES ('member-admin', 'admin@x.test', 'Admin Operator', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-admin-org', 'member-admin', 'org', NULL, 'admin');
    `)
  })
  afterEach(() => harness.close())

  function makeEnv(): Env {
    return { TENANT_SLUG: TENANT, BRAND: 'Test Pot', LOCAL_TEST_AUTH: '1', LOCAL_TEST_AUTH_EMAIL: 'admin@x.test', SESSIONS: kv(), DB: harness.db } as unknown as Env
  }

  it('renders the main pages, re-roots them, and finds zero unprefixed URLs (and the raw output was NOT already clean)', async () => {
    const env = makeEnv()
    const login = await authApp.request('/dev-login', {}, env)
    const cookie = /mupot_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1]
    expect(cookie).toBeTruthy()
    let rendered = 0
    let rawBadTotal = 0
    for (const page of PAGES) {
      const original = new Request(`https://mupot.mumega.com/t/${TENANT}${page === '/' ? '' : page}`)
      const prefix = responsePrefixFor(original, TENANT)
      expect(prefix).toBe(PREFIX)
      const stamped = resolveApexPathTenant(original, TENANT)
      if (stamped?.kind !== 'home') throw new Error('home route expected')
      const inner = new Request(stamped.request, { headers: { ...Object.fromEntries(stamped.request.headers), cookie: `mupot_session=${cookie}` } })
      const raw = await dashboardApp.fetch(inner, env)
      if (raw.status !== 200 || !(raw.headers.get('content-type') ?? '').includes('text/html')) continue
      const rawText = await raw.clone().text()
      rawBadTotal += unprefixed(rawText).length
      const out = await applyTenantPrefix(raw, PREFIX)
      const text = await out.text()
      expect(unprefixed(text), `${page}: unprefixed URLs`).toEqual([])
      expect(text, `${page}: shim`).toContain('window.__MUPOT_BASE')
      rendered++
    }
    expect(rendered).toBeGreaterThanOrEqual(10)
    expect(rawBadTotal).toBeGreaterThan(100) // the rewrite is doing the work, not a vacuous pass
  })

  it('an unauthenticated dashboard request redirects to the PREFIXED login', async () => {
    const env = makeEnv()
    const raw = await dashboardApp.request('/account', {}, env)
    expect(raw.status).toBe(302)
    const out = await applyTenantPrefix(raw, PREFIX)
    expect(out.headers.get('location')).toBe('/t/local/auth/login')
  })
})
