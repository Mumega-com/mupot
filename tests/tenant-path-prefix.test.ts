// mupot#1928 — path-routed tenants (/t/<slug>): every URL the dashboard emits must stay under the
// prefix. Exercises the real dashboardApp on the real migration chain, then the same choke point
// the Worker entry applies (responsePrefixFor + applyTenantPrefix).

import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { billingRoutesApp } from '../src/billing/routes'
import { publicMcpEndpoint } from '../src/routines/dispatch'
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
  credentialBase,
  withTenantPrefix,
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

  it('credentialBase comes ONLY from pinned PUBLIC_ORIGIN: header, path and request host are irrelevant', () => {
    const stamped = new Request('https://gaf.mupot.mumega.com/auth/login', { headers: { [TENANT_PREFIX_HEADER]: '/t/gaf' } })
    expect(credentialBase({ PUBLIC_ORIGIN: 'https://mupot.mumega.com/t/gaf' }, stamped)).toBe('https://mupot.mumega.com/t/gaf')
    // forged header cannot add OR change a prefix
    const forged = new Request('https://pot.example.com/auth/login', { headers: { [TENANT_PREFIX_HEADER]: '/t/attackerpot' } })
    expect(credentialBase({ PUBLIC_ORIGIN: 'https://pot.example.com' }, forged)).toBe('https://pot.example.com')
    expect(credentialBase({ PUBLIC_ORIGIN: 'https://mupot.mumega.com/t/victim' }, forged)).toBe('https://mupot.mumega.com/t/victim')
    // home tenant on its /t/<home> alias keeps ROOT urls (registered OAuth /auth/callback)
    const alias = new Request('https://mupot.mumega.com/auth/login', { headers: { [TENANT_PREFIX_HEADER]: '/t/mumega' } })
    expect(credentialBase({ PUBLIC_ORIGIN: 'https://mupot.mumega.com' }, alias)).toBe('https://mupot.mumega.com')
    // no PUBLIC_ORIGIN: request origin (pre-#1928 behaviour), never a header
    expect(credentialBase({}, forged)).toBe('https://pot.example.com')
  })

  it('FORGED HEADER (direct request, no /t/ path): no reader honours a prefix naming another tenant', () => {
    const forged = { [TENANT_PREFIX_HEADER]: '/t/attackerpot' }
    const req = new Request('https://pot.example.com/auth/email/start', { method: 'POST', headers: forged })
    expect(tenantPrefixOf(req, 'victim')).toBeNull()
    expect(responsePrefixFor(req, 'victim')).toBeNull()
    expect(stripUntrustedPrefix(req, 'victim').headers.has(TENANT_PREFIX_HEADER)).toBe(false)
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

// No regex HTML parsing in tests: locate the injected shim by plain string search.
const SHIM_OPEN = '<script>(function(){var P='
function shimBounds(html: string): { start: number; bodyStart: number; end: number; after: number } | null {
  const start = html.indexOf(SHIM_OPEN)
  if (start < 0) return null
  const end = html.toLowerCase().indexOf('</script', start)
  const close = html.indexOf('>', end)
  if (end < 0 || close < 0) return null
  return { start, bodyStart: start + '<script>'.length, end, after: close + 1 }
}
function firstScriptBody(html: string): string {
  const b = shimBounds(html)
  return b === null ? '' : html.slice(b.bodyStart, b.end)
}
function removeShim(html: string): string {
  const b = shimBounds(html)
  return b === null ? html : html.slice(0, b.start) + html.slice(b.after)
}

// ---- tokenizer: user content must round-trip ------------------------------------------------

describe('user content is never rewritten', () => {
  const PROBE = `url=/docs fetch('/api/x') href='/y' location='/z' action="/w"`
  it('textarea body, text nodes and attribute VALUES containing url-like text stay byte-identical', () => {
    const html = `<!doctype html><html><head></head><body>
<textarea name="goal">${PROBE} <a href="/z">raw</a><script>fetch('/api/x')</script></textarea>
<p>${PROBE}</p>
<input value="${PROBE.replace(/"/g, '&quot;')}">
<input value='x href="/y" src="/z"'>
<div title="a href='/q' b" data-href="/d" data-src="/e"><a href="/real">r</a></div>
<code>${PROBE}</code><pre>${PROBE}</pre>
</body></html>`
    const out = rewriteHtmlForPrefix(html, PREFIX)
    const strip = (x: string) => removeShim(x)
    const expected = html.replace('<a href="/real">', '<a href="/t/local/real">')
    expect(strip(out)).toBe(expected)
  })
})

// ---- the client shim, executed ---------------------------------------------------------------

describe('client shim (executed in a vm)', () => {
  function runShim() {
    const html = rewriteHtmlForPrefix('<html><head></head><body></body></html>', PREFIX)
    const src = firstScriptBody(html)
    const calls: Record<string, unknown[]> = { fetch: [], xhr: [], es: [], beacon: [], open: [] }
    class XHR { open(...a: unknown[]) { calls.xhr.push(a) } }
    class ES { constructor(...a: unknown[]) { calls.es.push(a) } }
    const win: Record<string, unknown> = {
      fetch: (...a: unknown[]) => { calls.fetch.push(a); return Promise.resolve() },
      XMLHttpRequest: XHR,
      EventSource: ES,
      open: (...a: unknown[]) => { calls.open.push(a) },
    }
    const ctx: Record<string, unknown> = { window: win, XMLHttpRequest: XHR, navigator: { sendBeacon: (...a: unknown[]) => { calls.beacon.push(a); return true } } }
    ctx.globalThis = ctx
    vm.runInNewContext(src, ctx)
    return { win, calls, nav: ctx.navigator as { sendBeacon: (u: string, d?: string) => boolean }, XHR }
  }

  it('prefixes root-relative fetch / XHR / EventSource / sendBeacon / window.open and exposes __MUPOT_BASE', async () => {
    const { win, calls, nav, XHR } = runShim()
    expect(win.__MUPOT_BASE).toBe(PREFIX)
    await (win.fetch as (u: unknown) => Promise<void>)('/api/x')
    expect(calls.fetch[0]).toEqual(['/t/local/api/x', undefined])
    new XHR().open('POST', '/api/y')
    expect(calls.xhr[0]).toEqual(['POST', '/t/local/api/y'])
    new (win.EventSource as new (u: string) => unknown)('/api/sse')
    expect(calls.es[0]).toEqual(['/t/local/api/sse', undefined])
    nav.sendBeacon('/api/b', 'd')
    expect(calls.beacon[0]).toEqual(['/t/local/api/b', 'd'])
    ;(win.open as (u: string) => void)('/page')
    expect(calls.open[0]).toEqual(['/t/local/page'])
  })

  it('leaves protocol-relative, absolute, backslash, already-prefixed (ANY /t/<slug>) and non-string values alone', async () => {
    const { win, calls } = runShim()
    const f = win.fetch as (u: unknown) => Promise<void>
    const same = ['//cdn.example/x', 'https://e.test/x', '/\\evil.com', '/t/local/x', '/t/local', '/t/other/x', '/t/other?x=1', 'relative/x']
    for (const u of same) await f(u)
    expect(calls.fetch.map((c) => c[0])).toEqual(same)
    const req = { url: '/x' }
    await f(req)
    expect(calls.fetch[same.length][0]).toBe(req)
    await f('/team/x')
    expect(calls.fetch[same.length + 1][0]).toBe('/t/local/team/x')
  })
})

// ---- wiring: the real entry wrapper + the real routes ------------------------------------------

describe('wiring through withTenantPrefix (the entry wrapper index.ts delegates to)', () => {
  const origin = 'https://mupot.mumega.com'
  const handler = (req: Request) => dashboardApp.fetch(req, wiringEnv())
  function wiringEnv(): Env {
    return { TENANT_SLUG: 'mumega', BRAND: 'Pot', SESSIONS: kv(), DB: wiringDb } as unknown as Env
  }
  let wiringDb: D1Database
  let h: SqliteD1Harness
  beforeEach(() => {
    h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    wiringDb = h.db
  })
  afterEach(() => h.close())

  async function viaApex(path: string): Promise<Response> {
    const original = new Request(`${origin}/t/mumega${path}`)
    const route = resolveApexPathTenant(original, 'mumega')
    if (route?.kind !== 'home') throw new Error('home route expected')
    return withTenantPrefix(original, { TENANT_SLUG: 'mumega' }, () => handler(route.request))
  }

  it('redirect: unauthenticated /t/mumega/account -> Location under the prefix', async () => {
    const res = await viaApex('/account')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/t/mumega/auth/login')
    expect(res.headers.get('vary')).toContain(TENANT_PREFIX_HEADER)
  })

  it('page: a signed-out HTML landing is re-rooted and carries the shim', async () => {
    const res = await viaApex('/')
    if (res.status !== 200) throw new Error(`landing page not rendered: ${res.status}`)
    const text = await res.text()
    expect(text).toContain('window.__MUPOT_BASE=P')
    const hrefs = [...text.matchAll(/\s(?:href|action|src)="(\/(?!\/)[^"]*)"/g)].map((m) => m[1])
    expect(hrefs.length).toBeGreaterThan(0)
    expect(hrefs.filter((u) => !u.startsWith('/t/mumega'))).toEqual([])
  })

  it('a direct request with a forged header is NOT re-rooted and the handler never sees it', async () => {
    let seen: string | null = 'unset'
    const res = await withTenantPrefix(
      new Request(`${origin}/account`, { headers: { [TENANT_PREFIX_HEADER]: '/t/attackerpot' } }),
      { TENANT_SLUG: 'mumega' },
      async (r) => { seen = r.headers.get(TENANT_PREFIX_HEADER); return new Response(null, { status: 302, headers: { location: '/auth/login' } }) },
    )
    expect(seen).toBeNull()
    expect(res.headers.get('location')).toBe('/auth/login')
  })
})

describe('wiring: credential-bearing URLs come from pinned PUBLIC_ORIGIN only', () => {
  let h: SqliteD1Harness
  beforeEach(() => {
    h = createSqliteD1()
    applyAllMigrations(h.sqlite)
  })
  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  const FORGED = { [TENANT_PREFIX_HEADER]: '/t/attackerpot' }

  it('OAuth redirect_uri: path-routed pot gets /t/<slug>/auth/callback; home alias and forged header keep the pinned value', async () => {
    // The request host is the pinned host: a login on any other host is first moved to it (state cookie is host-scoped, #1579).
    const redirectUri = async (publicOrigin: string, headers: Record<string, string>, slug: string): Promise<string> => {
      const env = { DB: h.db, TENANT_SLUG: slug, BRAND: 'B', PUBLIC_ORIGIN: publicOrigin, SESSIONS: kv(), IDP_PROVIDER: 'google', OAUTH_CLIENT_ID: 'id', OAUTH_CLIENT_SECRET: 's' } as unknown as Env
      const res = await authApp.fetch(new Request(`${new URL(publicOrigin).origin}/login`, { headers }), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext)
      expect(res.status).toBe(302)
      return new URL(res.headers.get('location') ?? '').searchParams.get('redirect_uri') ?? ''
    }
    expect(await redirectUri('https://mupot.mumega.com/t/gaf', { [TENANT_PREFIX_HEADER]: '/t/gaf' }, 'gaf')).toBe('https://mupot.mumega.com/t/gaf/auth/callback')
    expect(await redirectUri('https://mupot.mumega.com', { [TENANT_PREFIX_HEADER]: '/t/mumega' }, 'mumega')).toBe('https://mupot.mumega.com/auth/callback')
    expect(await redirectUri('https://pot.example.com', FORGED, 'victim')).toBe('https://pot.example.com/auth/callback')
  })

  it('Stripe checkout success/cancel URLs', async () => {
    const OWNER = 'mupot_session=owner-s'
    const sessions: Record<string, string> = { 'sess:owner-s': JSON.stringify({ userId: 'u', email: 'o@x.test', role: 'owner', createdAt: '2026-09-01T00:00:00.000Z' }) }
    const bodies: string[] = []
    vi.stubGlobal('fetch', async (_u: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''))
      return new Response(JSON.stringify({ id: 'cs_1', url: 'https://stripe.test/c' }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const run = async (publicOrigin: string, headers: Record<string, string>): Promise<string> => {
      bodies.length = 0
      const env = {
        TENANT_SLUG: 'local', DB: h.db, STRIPE_SECRET_KEY: 'sk_test', PUBLIC_ORIGIN: publicOrigin,
        SESSIONS: { get: async (k: string) => sessions[k] ?? null, put: async () => undefined, delete: async () => undefined },
      } as unknown as Env
      const res = await billingRoutesApp.request('/checkout', {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: OWNER, ...headers }, body: JSON.stringify({ tier: 'pro' }),
      }, env)
      expect(res.status).toBe(200)
      return decodeURIComponent(bodies[0] ?? '')
    }
    expect(await run('https://mupot.mumega.com/t/local', { [TENANT_PREFIX_HEADER]: '/t/local' })).toContain('success_url=https://mupot.mumega.com/t/local/billing?')
    const forged = await run('https://pot.example.com', FORGED)
    expect(forged).toContain('success_url=https://pot.example.com/billing?')
    expect(forged).not.toContain('/t/')
  })

  it('routine MCP endpoint', () => {
    expect(publicMcpEndpoint({ PUBLIC_ORIGIN: 'https://mupot.mumega.com/t/gaf' } as unknown as Env)).toBe('https://mupot.mumega.com/t/gaf/mcp')
    expect(publicMcpEndpoint({ PUBLIC_ORIGIN: 'https://pot.example.com' } as unknown as Env)).toBe('https://pot.example.com/mcp')
  })
})

describe('copilot full-page detection under a prefix (executed)', () => {
  it('compares the pathname with the /t/<slug> prefix removed', () => {
    const src = readFileSync(new URL('../src/dashboard/copilot.ts', import.meta.url), 'utf8')
    const snippet = /const __base[\s\S]*?const onFullPage[^\n]*\n/.exec(src)?.[0] ?? ''
    expect(snippet).not.toBe('')
    const run = (pathname: string, base?: string): boolean =>
      vm.runInNewContext(`(function(){${snippet}; return onFullPage })()`, { window: base ? { __MUPOT_BASE: base } : {}, location: { pathname } }) as boolean
    expect(run('/t/local/copilot', '/t/local')).toBe(true)
    expect(run('/t/local/chat', '/t/local')).toBe(true)
    expect(run('/copilot')).toBe(true)
    expect(run('/t/local/agents', '/t/local')).toBe(false)
    expect(run('/t/local/copilot')).toBe(false)
  })
})

describe('source ratchets', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
  it('index.ts routes its default fetch through withTenantPrefix', () => {
    const src = read('../src/index.ts')
    expect(src).toMatch(/fetch:[^\n]*withTenantPrefix\(req, env,/)
  })
  it('credential sites use credentialBase and nothing derives them from a header', () => {
    expect(read('../src/auth/index.ts').match(/credentialBase\(/g)?.length).toBeGreaterThanOrEqual(2)
    expect(read('../src/billing/routes.ts').match(/credentialBase\(/g)?.length).toBe(2)
    expect(read('../src/platform/tenant-path.ts')).not.toMatch(/export function requestBase/)
  })
  it('copilot and nav compare the pathname with the prefix removed', () => {
    expect(read('../src/dashboard/copilot.ts')).toContain('__MUPOT_BASE')
    expect(read('../src/dashboard/index.ts')).toContain('window.__MUPOT_BASE')
  })
})
