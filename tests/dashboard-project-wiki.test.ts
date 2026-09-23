// tests/dashboard-project-wiki.test.ts — src/dashboard/project-wiki.ts +
// its two routes wired in src/dashboard/index.ts (GET /projects/:id/wiki,
// POST /projects/:id/wiki/card), mupot v0.50 goal item 4.
//
// Real D1 (sqlite-d1 harness, full migration chain) + a FAKE Inkwell wiki
// double (tests/helpers/fake-internal-wiki.ts) wired via env.INKWELL_SVC —
// same wiring the dept-executor connector resolution uses in production.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { encryptConnectorSecret } from '../src/connectors/crypto'
import { FakeInternalWiki } from './helpers/fake-internal-wiki'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', () => ({
  requireAuth: async (
    c: {
      get: (key: 'auth') => AuthContext | undefined
      set: (key: 'auth', value: AuthContext) => void
      json: (body: unknown, status: 401) => Response
    },
    next: () => Promise<void>,
  ) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
}))

const { dashboardApp } = await import('../src/dashboard')

const MASTER_KEY = '33'.repeat(32)
const TENANT = 'pot-a'
const CONNECTOR_ID = 'connector-inkwell-wiki'
const SECRET = 'wiki-pot-secret-xyz'
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A'), ('dept-b', 'dept-b', 'Department B');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('squad-a', 'dept-a', 'squad-a', 'Squad Alpha'),
      ('squad-b', 'dept-b', 'squad-b', 'Squad Beta');
    INSERT INTO projects (id, slug, name, description, goal, status, live_url, repo_url) VALUES
      ('visible-child', 'wikitest', 'Wiki Test Project', 'A project for wiki tests', 'Ship the wiki home',
       'active', 'https://wikitest.example.com', 'https://github.com/example/wikitest');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
      ('visible-child', 'squad-a', 'write');
  `)
  return harness
}

async function envFor(harness: SqliteD1Harness, fake: FakeInternalWiki): Promise<Env> {
  const encrypted = await encryptConnectorSecret(MASTER_KEY, CONNECTOR_ID, 'inkwell', SECRET)
  harness.sqlite.exec(
    `INSERT INTO connectors (id, tenant, type, label, encrypted_secret, meta, scope_type, scope_id, created_by, created_at)
     VALUES ('${CONNECTOR_ID}', '${TENANT}', 'inkwell', 'Inkwell wiki', '${encrypted}', NULL, 'pot', NULL, 'test-setup', '2026-01-01T00:00:00Z')`,
  )
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BRAND: 'Mupot',
    CONNECTOR_MASTER_KEY: MASTER_KEY,
    INKWELL_API_URL: 'https://inkwell-api.test',
    INKWELL_SVC: fake.asFetcher(),
  } as Env
}

function actor(overrides: Partial<AuthContext> = {}): AuthContext {
  return { userId: 'user-1', email: null, role: 'member', tenant: TENANT, ...overrides }
}

function as(auth: AuthContext | null): void {
  authState.current = auth
}

/** Member of squad-a, which holds `write` on visible-child -> canManageProject passes. */
function writerMember(): AuthContext {
  return actor({
    memberId: 'member-writer',
    capabilities: [{ member_id: 'member-writer', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' }],
  })
}

/**
 * A member who clears the dashboard's baseline "belongs in this pot at all"
 * capability floor (a real grant on squad-b) but has NO grant of any kind on
 * squad-a / visible-child — the project-specific read predicate must deny
 * them even though the coarser pot-wide floor already passed.
 */
function outsiderMember(): AuthContext {
  return actor({
    memberId: 'member-outsider',
    capabilities: [{ member_id: 'member-outsider', scope_type: 'squad', scope_id: 'squad-b', capability: 'observer' }],
  })
}

function postCardRequest(projectId: string, origin: string | null = 'https://pot.test'): Request {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
  if (origin) headers.origin = origin
  return new Request(`https://pot.test/projects/${projectId}/wiki/card`, { method: 'POST', headers })
}

afterEach(() => {
  as(null)
})

describe('GET /projects/:id/wiki — read gate', () => {
  it('an outsider (no project read) is denied with 404 and the upstream wiki service is NEVER called', async () => {
    const harness = makeHarness()
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    fake.seed({ tenantSlug: TENANT, project: 'wikitest', slug: 'overview', title: 'Overview' })
    const env = await envFor(harness, fake)
    as(outsiderMember())

    const res = await dashboardApp.fetch(new Request('https://pot.test/projects/visible-child/wiki'), env)
    expect(res.status).toBe(404)
    expect(fake.requests).toEqual([]) // the deny-without-upstream-call invariant
  })

  it('an unauthenticated caller is redirected to login before any project lookup', async () => {
    const harness = makeHarness()
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    const env = await envFor(harness, fake)
    as(null)

    const res = await dashboardApp.fetch(new Request('https://pot.test/projects/visible-child/wiki'), env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/auth/login')
    expect(fake.requests).toEqual([])
  })

  it('a member with manage access sees topics and the empty state otherwise', async () => {
    const harness = makeHarness()
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    const env = await envFor(harness, fake)
    as(writerMember())

    const empty = await dashboardApp.fetch(new Request('https://pot.test/projects/visible-child/wiki'), env)
    expect(empty.status).toBe(200)
    const emptyBody = await empty.text()
    expect(emptyBody).toContain('No wiki pages yet')
    expect(emptyBody).toContain('Create project card')

    fake.seed({ tenantSlug: TENANT, project: 'wikitest', slug: 'overview', title: 'Overview Topic' })
    const filled = await dashboardApp.fetch(new Request('https://pot.test/projects/visible-child/wiki'), env)
    expect(filled.status).toBe(200)
    const filledBody = await filled.text()
    expect(filledBody).toContain('Overview Topic')
  })

  it('XSS: a topic title/description containing <script> renders escaped, never executable', async () => {
    const harness = makeHarness()
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    fake.seed({
      tenantSlug: TENANT,
      project: 'wikitest',
      slug: 'unsafe-topic',
      title: '<script>alert(1)</script>',
      description: 'desc <img src=x onerror=alert(2)>',
    })
    const env = await envFor(harness, fake)
    as(writerMember())

    const res = await dashboardApp.fetch(new Request('https://pot.test/projects/visible-child/wiki'), env)
    const body = await res.text()
    expect(body).not.toContain('<script>alert(1)</script>')
    expect(body).toContain('&lt;script&gt;')
    expect(body).not.toContain('<img src=x onerror=alert(2)>')
    expect(body).toContain('&lt;img')
  })

  it('an unreachable wiki service renders an honest 503, not a 500 crash', async () => {
    const harness = makeHarness()
    const env = await envFor(harness, new FakeInternalWiki({ [TENANT]: 'wrong-secret-in-store' }))
    as(writerMember())

    const res = await dashboardApp.fetch(new Request('https://pot.test/projects/visible-child/wiki'), env)
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('Wiki unavailable')
  })
})

describe('POST /projects/:id/wiki/card — write gate + CSRF', () => {
  it('requires manage (write) access — an outsider gets 403 and nothing is written', async () => {
    const harness = makeHarness()
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    const env = await envFor(harness, fake)
    as(outsiderMember())

    const res = await dashboardApp.fetch(postCardRequest('visible-child'), env)
    expect(res.status).toBe(403)
    expect(fake.requests.filter((r) => r.method === 'PUT')).toEqual([])
  })

  it('CSRF: a mismatched Origin is refused (403) before the route body ever runs', async () => {
    const harness = makeHarness()
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    const env = await envFor(harness, fake)
    as(writerMember())

    const res = await dashboardApp.fetch(postCardRequest('visible-child', 'https://evil.example'), env)
    expect(res.status).toBe(403)
    expect(fake.requests).toEqual([])
  })

  it('CSRF: no Origin header at all is refused (403) the same way', async () => {
    const harness = makeHarness()
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    const env = await envFor(harness, fake)
    as(writerMember())

    const res = await dashboardApp.fetch(postCardRequest('visible-child', null), env)
    expect(res.status).toBe(403)
    expect(fake.requests).toEqual([])
  })

  it('a manager creates the project card from the project\'s OWN fields, idempotently', async () => {
    const harness = makeHarness()
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    const env = await envFor(harness, fake)
    as(writerMember())

    const first = await dashboardApp.fetch(postCardRequest('visible-child'), env)
    expect(first.status).toBe(303)
    expect(first.headers.get('location')).toContain('status=card_saved')

    const view = await dashboardApp.fetch(new Request('https://pot.test/projects/visible-child/wiki'), env)
    const body = await view.text()
    expect(body).toContain('Wiki Test Project')
    expect(body).toContain('Ship the wiki home') // goal, folded into description
    expect(body).toContain('https://wikitest.example.com') // live_url

    // Second POST refreshes the SAME topic (idempotent upsert) rather than duplicating it.
    const second = await dashboardApp.fetch(postCardRequest('visible-child'), env)
    expect(second.status).toBe(303)
    const graphAfter = await fake.fetch(
      new Request('https://inkwell-api.test/api/internal/wiki/graph?tenant_slug=pot-a&project=wikitest', {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    )
    const graphJson = (await graphAfter.json()) as { nodes: { slug: string }[] }
    expect(graphJson.nodes.filter((n) => n.slug === 'project-card')).toHaveLength(1)
  })

  it('a slug conflict (owned by another project) surfaces as a typed message, not a 500', async () => {
    const harness = makeHarness()
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    fake.seed({ tenantSlug: TENANT, project: 'some-other-project', slug: 'project-card', title: 'Someone Else' })
    const env = await envFor(harness, fake)
    as(writerMember())

    const res = await dashboardApp.fetch(postCardRequest('visible-child'), env)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toContain('wiki_conflict_topic_owned_by_other_project')

    const location = res.headers.get('location')!
    const absolute = location.startsWith('http') ? location : `https://pot.test${location}`
    const view = await dashboardApp.fetch(new Request(absolute), env)
    expect(await view.text()).toContain('already owned by a different project')
  })
})
