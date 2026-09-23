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
import { projectCardTopicSlug } from '../src/dashboard/project-wiki'

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
// The card slug is keyed on project.id (P1-1) — 'visible-child' is used as
// BOTH the project's id and, in most fixtures, as a stand-in slug value, so
// every test below computes the expected topic slug from this constant
// rather than hardcoding 'project-card'.
const PROJECT_ID = 'visible-child'

/**
 * Squad fixture (P2-A / round-1 M2+M3 pin): the WRITER holds a real
 * capability grant on BOTH squad-a (work) and squad-home-writer (home) —
 * so squad-home-writer passes the read-access filter and ONLY the
 * kind='home' filter excludes it (pins M2: dropping the home filter alone
 * must leak it). squad-c (work) has a project_squad_access row but the
 * writer holds NO grant on it at all — so ONLY the read-access filter
 * excludes it (pins M3: an unfiltered query would leak it). An org admin
 * viewer, being unrestricted, sees squad-a AND squad-c (still never the
 * home squad) — proving the live squad list genuinely depends on the
 * CURRENT VIEWER, not a value baked into the stored card.
 */
function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A'), ('dept-b', 'dept-b', 'Department B');
    INSERT INTO squads (id, department_id, slug, name, kind) VALUES
      ('squad-a', 'dept-a', 'squad-a', 'Squad Alpha', 'work'),
      ('squad-b', 'dept-b', 'squad-b', 'Squad Beta', 'work'),
      ('squad-c', 'dept-b', 'squad-c', 'Squad Charlie', 'work'),
      ('squad-home-writer', 'dept-a', 'squad-home-writer', 'Writer Home', 'home');
    INSERT INTO projects (id, slug, name, description, goal, status, live_url, repo_url) VALUES
      ('${PROJECT_ID}', 'wikitest', 'Wiki Test Project', 'A project for wiki tests', 'Ship the wiki home',
       'active', 'https://wikitest.example.com', 'https://github.com/example/wikitest');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
      ('${PROJECT_ID}', 'squad-a', 'write'),
      ('${PROJECT_ID}', 'squad-c', 'write'),
      ('${PROJECT_ID}', 'squad-home-writer', 'write');
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

/** Member of squad-a AND squad-home-writer (see fixture doc comment above). */
function writerMember(): AuthContext {
  return actor({
    memberId: 'member-writer',
    capabilities: [
      { member_id: 'member-writer', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' },
      { member_id: 'member-writer', scope_type: 'squad', scope_id: 'squad-home-writer', capability: 'member' },
    ],
  })
}

/** Org-scope admin — unrestricted project read, so sees EVERY work squad on the project (still never a home squad). */
function adminViewer(): AuthContext {
  return actor({
    memberId: 'member-admin',
    capabilities: [{ member_id: 'member-admin', scope_type: 'org', scope_id: null, capability: 'admin' }],
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

async function fetchGraph(fake: FakeInternalWiki, project: string): Promise<{ nodes: { slug: string; description: string; tags: string[] }[] }> {
  const res = await fake.fetch(
    new Request(`https://inkwell-api.test/api/internal/wiki/graph?tenant_slug=${TENANT}&project=${project}`, {
      headers: { authorization: `Bearer ${SECRET}` },
    }),
  )
  return res.json()
}

/** A fetcher that mimics a well-formed-but-rejected 4xx from the real route (P2-B). */
function rejectingFetcher(status: number, code: string): Fetcher {
  // `as unknown as Fetcher`: the test double implements only `fetch`, the one
  // member wiki-client.ts calls — same shape FakeInternalWiki.asFetcher() uses.
  return { fetch: async () => Response.json({ error: code, detail: 'UPSTREAM-BODY-SENTINEL' }, { status }) } as unknown as Fetcher
}

afterEach(() => {
  as(null)
})

describe('GET /projects/:id/wiki — read gate', () => {
  it('an outsider (no project read) is denied with 404 and the upstream wiki service is NEVER called', async () => {
    const harness = makeHarness()
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    fake.seed({ tenantSlug: TENANT, project: PROJECT_ID, slug: 'overview', title: 'Overview' })
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

    fake.seed({ tenantSlug: TENANT, project: PROJECT_ID, slug: 'overview', title: 'Overview Topic' })
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
      project: PROJECT_ID,
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

  it('attribute injection: a topic SLUG containing a quote cannot break out of the id="..." attribute', async () => {
    // Upstream-sourced data this module does not re-validate against
    // Inkwell's own slug shape before rendering (see escapeAttr's doc
    // comment) — modeled here via a raw fetcher returning a crafted graph
    // response directly, bypassing wiki-client's/the fake's own slug
    // validation entirely, to test the RENDERER's escaping in isolation.
    const harness = makeHarness()
    const maliciousFetcher = {
      fetch: async () =>
        Response.json({
          tenant_slug: TENANT,
          project: PROJECT_ID,
          nodes: [
            {
              id: 'x',
              tenant_id: TENANT,
              project: PROJECT_ID,
              slug: 'safe" onmouseover="alert(1)',
              title: 'Node',
              description: '',
              topic_type: 'general',
              required_keys: [],
              tags: [],
              published: true,
              created_at: 0,
              updated_at: 0,
            },
          ],
          edges: [],
        }),
    }
    const env = { ...(await envFor(harness, new FakeInternalWiki({ [TENANT]: SECRET }))), INKWELL_SVC: maliciousFetcher } as Env
    as(writerMember())

    const res = await dashboardApp.fetch(new Request('https://pot.test/projects/visible-child/wiki'), env)
    const body = await res.text()
    expect(body).not.toContain('onmouseover="alert(1)"') // the attribute must never actually break out
    expect(body).toContain('&quot;')
  })

  it('an unreachable wiki service renders an honest 503, not a 500 crash', async () => {
    const harness = makeHarness()
    const env = await envFor(harness, new FakeInternalWiki({ [TENANT]: 'wrong-secret-in-store' }))
    as(writerMember())

    const res = await dashboardApp.fetch(new Request('https://pot.test/projects/visible-child/wiki'), env)
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('Wiki unavailable')
  })

  it.each([
    [404, 'not_found'],
    [400, 'invalid_project'],
  ])('P2-B: a well-formed-but-rejected upstream read (JSON %i) renders an honest 502, not a 500 crash', async (status, code) => {
    const harness = makeHarness()
    const env = { ...(await envFor(harness, new FakeInternalWiki({ [TENANT]: SECRET }))), INKWELL_SVC: rejectingFetcher(status, code) } as Env
    as(writerMember())

    const res = await dashboardApp.fetch(new Request('https://pot.test/projects/visible-child/wiki'), env)
    expect(res.status).toBe(502)
    const body = await res.text()
    expect(body).toContain('Wiki request rejected')
    expect(body).not.toContain('UPSTREAM-BODY-SENTINEL')
    expect(body).not.toContain(code)
  })

  it('P2-A: an org admin and a plain squad member viewing the SAME card see DIFFERENT live squad lists', async () => {
    const harness = makeHarness()
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    const env = await envFor(harness, fake)
    as(writerMember())
    const created = await dashboardApp.fetch(postCardRequest('visible-child'), env)
    expect(created.status).toBe(303)

    as(writerMember())
    const writerView = await dashboardApp.fetch(new Request('https://pot.test/projects/visible-child/wiki'), env)
    const writerBody = await writerView.text()
    expect(writerBody).toContain('Squad Alpha') // read-access grant -> visible
    expect(writerBody).not.toContain('Writer Home') // M2 pin: home squad excluded even though writer has a grant on it
    expect(writerBody).not.toContain('Squad Charlie') // M3 pin: no grant on squad-c -> excluded

    as(adminViewer())
    const adminView = await dashboardApp.fetch(new Request('https://pot.test/projects/visible-child/wiki'), env)
    const adminBody = await adminView.text()
    expect(adminBody).toContain('Squad Alpha')
    expect(adminBody).toContain('Squad Charlie') // unrestricted -> sees the squad the writer could not
    expect(adminBody).not.toContain('Writer Home') // still never a home squad, regardless of viewer

    // The two viewers of the exact same stored card saw different squad lists.
    expect(writerBody).not.toEqual(adminBody)
  })

  it('P2-A: the STORED topic body never contains any squad name at all', async () => {
    const harness = makeHarness()
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    const env = await envFor(harness, fake)
    as(writerMember())
    const created = await dashboardApp.fetch(postCardRequest('visible-child'), env)
    expect(created.status).toBe(303)

    const graphJson = await fetchGraph(fake, PROJECT_ID)
    const card = graphJson.nodes.find((n) => n.slug === projectCardTopicSlug(PROJECT_ID))
    expect(card).toBeDefined()
    expect(card!.description).not.toContain('Squad')
    expect(card!.description).not.toContain('Alpha')
    expect(card!.description).not.toContain('Charlie')
    expect(card!.tags.join(',')).not.toContain('Squad')
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

  it("a manager creates the project card from the project's OWN fields, idempotently", async () => {
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
    expect(body).toContain('Ship the wiki home') // goal, folded into the single-line description
    expect(body).toContain('https://wikitest.example.com') // live_url

    // Second POST refreshes the SAME topic (idempotent upsert) rather than duplicating it.
    const second = await dashboardApp.fetch(postCardRequest('visible-child'), env)
    expect(second.status).toBe(303)
    const graphJson = await fetchGraph(fake, PROJECT_ID)
    const expectedSlug = projectCardTopicSlug(PROJECT_ID)
    expect(graphJson.nodes.filter((n) => n.slug === expectedSlug)).toHaveLength(1)
  })

  it('a slug conflict (owned by another project) surfaces as a typed message, not a 500', async () => {
    const harness = makeHarness()
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    fake.seed({
      tenantSlug: TENANT,
      project: 'some-other-project-id',
      slug: projectCardTopicSlug(PROJECT_ID),
      title: 'Someone Else',
    })
    const env = await envFor(harness, fake)
    as(writerMember())

    const res = await dashboardApp.fetch(postCardRequest('visible-child'), env)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toContain('wiki_conflict_topic_owned_by_other_project')

    const location = res.headers.get('location')!
    const absolute = location.startsWith('http') ? location : `https://pot.test${location}`
    const view = await dashboardApp.fetch(new Request(absolute), env)
    expect(await view.text()).toContain('conflicted')
  })

  it.each([
    [404, 'not_found'],
    [400, 'title too short'],
  ])('P2-B: a well-formed-but-rejected upstream write (JSON %i) redirects with a typed status, not a 500', async (status, code) => {
    const harness = makeHarness()
    const env = { ...(await envFor(harness, new FakeInternalWiki({ [TENANT]: SECRET }))), INKWELL_SVC: rejectingFetcher(status, code) } as Env
    as(writerMember())

    const res = await dashboardApp.fetch(postCardRequest('visible-child'), env)
    expect(res.status).toBe(303)
    const location = res.headers.get('location')!
    expect(location).toBe('/projects/visible-child/wiki?status=wiki_request_rejected')

    const absolute = location.startsWith('http') ? location : `https://pot.test${location}`
    const view = await dashboardApp.fetch(new Request(absolute), env)
    const body = await view.text()
    expect(body).toContain('rejected this request')
    expect(body).not.toContain('UPSTREAM-BODY-SENTINEL')
    expect(body).not.toContain(code)
  })

  it('contract: an uppercase-containing project id is lowercased in the card slug AND the Inkwell `project` param', async () => {
    const harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO projects (id, slug, name, status) VALUES ('Upper-Child', 'upperchild', 'Upper Project', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('Upper-Child', 'squad-a', 'write');
    `)
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    const env = await envFor(harness, fake)
    as(writerMember())

    expect(projectCardTopicSlug('Upper-Child')).toBe('project-card-upper-child')
    const res = await dashboardApp.fetch(postCardRequest('Upper-Child'), env)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toContain('status=card_saved')

    const put = fake.requests.find((r) => r.method === 'PUT')
    expect(put).toBeDefined()
    expect(put!.path).toBe('/api/internal/wiki/topics/project-card-upper-child')
    const graph = await fetchGraph(fake, 'upper-child')
    expect(graph.nodes.map((n) => n.slug)).toEqual(['project-card-upper-child'])
  })

  it('P1-1: two DIFFERENT projects in the same tenant each get their OWN card, no slug collision', async () => {
    const harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO projects (id, slug, name, description, goal, status) VALUES
        ('other-child', 'other-project', 'Other Project', 'Another project', 'Ship it', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
        ('other-child', 'squad-a', 'write');
    `)
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    const env = await envFor(harness, fake)
    as(writerMember())

    const firstCard = await dashboardApp.fetch(postCardRequest(PROJECT_ID), env)
    expect(firstCard.status).toBe(303)
    expect(firstCard.headers.get('location')).toContain('status=card_saved')

    const secondCard = await dashboardApp.fetch(postCardRequest('other-child'), env)
    expect(secondCard.status).toBe(303)
    expect(secondCard.headers.get('location')).toContain('status=card_saved') // NOT a conflict

    const graphA = await fetchGraph(fake, PROJECT_ID)
    const graphB = await fetchGraph(fake, 'other-child')
    expect(graphA.nodes.map((n) => n.slug)).toEqual([projectCardTopicSlug(PROJECT_ID)])
    expect(graphB.nodes.map((n) => n.slug)).toEqual([projectCardTopicSlug('other-child')])
    expect(projectCardTopicSlug(PROJECT_ID)).not.toBe(projectCardTopicSlug('other-child'))
  })

  it('P1-1: the card slug for a real (UUID-shaped) project id stays comfortably under the 63-char cap', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000'
    const slug = projectCardTopicSlug(uuid)
    expect(slug.length).toBeLessThanOrEqual(63)
    expect(slug).toBe(`project-card-${uuid}`)
  })
})

describe('P1-3: the wiki is keyed on project.id, not the mutable slug', () => {
  it("renaming a project's slug does not orphan its wiki; a new project taking the freed slug starts empty", async () => {
    const harness = makeHarness()
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    const env = await envFor(harness, fake)
    as(writerMember())

    const created = await dashboardApp.fetch(postCardRequest('visible-child'), env)
    expect(created.status).toBe(303)

    // Rename the project's slug — the URL param is still `id` (unaffected by
    // this test), but the value SENT TO INKWELL must have been project.id
    // all along, so this rename changes nothing about wiki resolution.
    harness.sqlite.exec(`UPDATE projects SET slug = 'renamed-slug' WHERE id = '${PROJECT_ID}'`)

    const afterRename = await dashboardApp.fetch(new Request('https://pot.test/projects/visible-child/wiki'), env)
    expect(afterRename.status).toBe(200)
    expect(await afterRename.text()).toContain('Wiki Test Project')

    // A brand-new, unrelated project takes the NOW-FREED slug 'wikitest'.
    // If the wiki were ever keyed on slug, this project would inherit
    // visible-child's card — it must instead start with an empty wiki.
    harness.sqlite.exec(`
      INSERT INTO projects (id, slug, name, description, goal, status) VALUES
        ('new-project-same-old-slug', 'wikitest', 'New Project', 'Reused the freed slug', 'Start fresh', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
        ('new-project-same-old-slug', 'squad-a', 'write');
    `)
    const newProjectWiki = await dashboardApp.fetch(
      new Request('https://pot.test/projects/new-project-same-old-slug/wiki'),
      env,
    )
    expect(newProjectWiki.status).toBe(200)
    const newBody = await newProjectWiki.text()
    expect(newBody).toContain('No wiki pages yet')
    expect(newBody).not.toContain('Wiki Test Project')
  })
})
