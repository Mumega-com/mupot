/**
 * Slice 3 — per-project Docs view (dashboard), RBAC-filtered.
 *
 * Proves: list/search goes through checkContentTier for the viewer; items above
 * the viewer’s tier are omitted from the payload (not CSS-hidden); owner
 * surfaces expose Chat / Docs / Board; browser smoke source covers the viewer
 * RBAC scenario.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import {
  conceptsWithTiers,
  filterDocsForViewer,
  listVisibleProjectDocs,
  tierContextFromConcepts,
  viewerClaimsForProject,
  writeProjectDoc,
  type ProjectDoc,
} from '../src/projects/docs'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'pot-a'
const PROJECT_ID = 'proj-docs'
const VIEWER_ID = 'viewer-1'
const OTHER_USER = 'other-user'
const ENTITY_SECRET = 'entity-secret'

interface EngramRow {
  id: string
  agent_id: string
  text: string
  concepts: string | null
  created_at: string
}

function makeMemoryEnv(engrams: EngramRow[]): Env {
  return {
    TENANT_SLUG: TENANT,
    AI: {
      async run() {
        return { data: [[0.1, 0.2, 0.3]] }
      },
    },
    VEC: {
      async upsert() {
        return
      },
      async query() {
        return { matches: [] }
      },
    },
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first() {
                if (sql.includes('FROM engrams') && sql.includes('WHERE id = ?') && sql.includes('AND agent_id = ?')) {
                  const id = String(args[0])
                  const scope = String(args[1])
                  return engrams.find((e) => e.id === id && e.agent_id === scope) ?? null
                }
                return null
              },
              async all() {
                if (
                  sql.includes('FROM engrams') &&
                  sql.includes('WHERE agent_id = ?') &&
                  sql.includes('ORDER BY created_at DESC')
                ) {
                  const scope = String(args[0])
                  const limit = Number(args[1])
                  return {
                    results: engrams
                      .filter((e) => e.agent_id === scope)
                      .slice()
                      .reverse()
                      .slice(0, limit)
                      .map((e) => ({
                        id: e.id,
                        text: e.text,
                        concepts: e.concepts,
                        created_at: e.created_at,
                      })),
                  }
                }
                return { results: [] }
              },
              async run() {
                if (sql.includes('INSERT INTO engrams')) {
                  const [id, scope, text, concepts] = args as [string, string, string, string | null]
                  engrams.push({
                    id,
                    agent_id: scope,
                    text,
                    concepts,
                    created_at: `2026-07-23T00:00:${String(engrams.length).padStart(2, '0')}.000Z`,
                  })
                }
                return { meta: { changes: 1 } }
              },
            }
          },
        }
      },
    },
  } as unknown as Env
}

function doc(id: string, text: string, concepts: string[] | null): ProjectDoc {
  return {
    id,
    text,
    concepts,
    created_at: '2026-07-23T00:00:00.000Z',
    scope: `project:${PROJECT_ID}`,
  }
}

describe('docs tier concept encoding', () => {
  it('defaults missing tier tags to public', () => {
    expect(tierContextFromConcepts(null)).toEqual({ tier: 'public' })
    expect(tierContextFromConcepts(['lesson'])).toEqual({ tier: 'public' })
  })

  it('round-trips tier + entity + created_by + permitted_roles', () => {
    const encoded = conceptsWithTiers(['lesson'], {
      tier: 'entity',
      entity_id: 'org-9',
      created_by: 'u-1',
      permitted_roles: ['member', 'admin'],
    })
    expect(tierContextFromConcepts(encoded)).toEqual({
      tier: 'entity',
      entity_id: 'org-9',
      created_by: 'u-1',
      permitted_roles: ['member', 'admin'],
    })
    expect(encoded).toContain('lesson')
  })
})

describe('filterDocsForViewer (server-side omit)', () => {
  function catalog(): ProjectDoc[] {
    return [
      doc('pub', 'PUBLIC_DOC visible to all', conceptsWithTiers(null, { tier: 'public' })),
      doc('proj', 'PROJECT_DOC needs project claim', conceptsWithTiers(null, { tier: 'project' })),
      doc(
        'priv',
        'PRIVATE_DOC creator only',
        conceptsWithTiers(null, { tier: 'private', created_by: OTHER_USER }),
      ),
      doc(
        'ent',
        'ENTITY_DOC needs matching entity',
        conceptsWithTiers(null, { tier: 'entity', entity_id: ENTITY_SECRET }),
      ),
    ]
  }

  it('returns public+project and omits private/entity the viewer lacks claims for', () => {
    const claims = viewerClaimsForProject(
      {
        userId: VIEWER_ID,
        memberId: VIEWER_ID,
        email: null,
        role: 'member',
        tenant: TENANT,
        channel: 'dashboard',
      },
      PROJECT_ID,
      { workspaceAdmin: false, orgRead: false, squadIds: ['squad-a'], departmentIds: [] },
    )
    const visible = filterDocsForViewer(catalog(), claims)
    expect(visible.map((d) => d.text)).toEqual([
      'PUBLIC_DOC visible to all',
      'PROJECT_DOC needs project claim',
    ])
    expect(visible.map((d) => d.text).join('\n')).not.toContain('PRIVATE_DOC')
    expect(visible.map((d) => d.text).join('\n')).not.toContain('ENTITY_DOC')
  })

  it('human and agent with identical claims see the same docs', () => {
    const access = {
      workspaceAdmin: false,
      orgRead: false,
      squadIds: ['squad-a'],
      departmentIds: [] as string[],
    }
    const human = viewerClaimsForProject(
      {
        userId: VIEWER_ID,
        memberId: VIEWER_ID,
        email: null,
        role: 'member',
        tenant: TENANT,
        channel: 'dashboard',
      },
      PROJECT_ID,
      access,
    )
    const agent = viewerClaimsForProject(
      {
        userId: VIEWER_ID,
        memberId: VIEWER_ID,
        email: null,
        role: 'member',
        tenant: TENANT,
        channel: 'workspace',
        boundAgentId: VIEWER_ID,
        capabilities: [],
      },
      PROJECT_ID,
      access,
    )
    expect(filterDocsForViewer(catalog(), human).map((d) => d.id)).toEqual(
      filterDocsForViewer(catalog(), agent).map((d) => d.id),
    )
  })

  it('includes entity docs only when entity_id claim matches', () => {
    const claims = {
      user_id: VIEWER_ID,
      role: 'member',
      project_id: PROJECT_ID,
      entity_id: ENTITY_SECRET,
    }
    const visible = filterDocsForViewer(catalog(), claims)
    expect(visible.map((d) => d.id)).toContain('ent')
    expect(visible.map((d) => d.id)).not.toContain('priv')
  })
})

describe('listVisibleProjectDocs search + RBAC', () => {
  it('searches only within the viewer-visible set', async () => {
    const engrams: EngramRow[] = []
    const env = makeMemoryEnv(engrams)
    await writeProjectDoc(env, PROJECT_ID, 'PUBLIC alpha knowledge', ['alpha'], { tier: 'public' })
    await writeProjectDoc(env, PROJECT_ID, 'PROJECT alpha knowledge', ['alpha'], { tier: 'project' })
    await writeProjectDoc(env, PROJECT_ID, 'PRIVATE alpha secret', ['alpha'], {
      tier: 'private',
      created_by: OTHER_USER,
    })
    await writeProjectDoc(env, PROJECT_ID, 'ENTITY alpha secret', ['alpha'], {
      tier: 'entity',
      entity_id: ENTITY_SECRET,
    })
    await writeProjectDoc(env, PROJECT_ID, 'PUBLIC beta other', ['beta'], { tier: 'public' })

    const claims = {
      user_id: VIEWER_ID,
      role: 'member',
      project_id: PROJECT_ID,
      entity_id: 'entity-allowed',
    }
    const listed = await listVisibleProjectDocs(env, PROJECT_ID, claims, 50, 'alpha')
    const texts = listed.docs.map((d) => d.text)
    expect(texts).toHaveLength(2)
    expect(texts).toContain('PUBLIC alpha knowledge')
    expect(texts).toContain('PROJECT alpha knowledge')
    expect(texts.join('\n')).not.toContain('PRIVATE')
    expect(texts.join('\n')).not.toContain('ENTITY')
    expect(texts.join('\n')).not.toContain('beta')
  })
})

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

const { loadProjectDocsView, projectDocsBody } = await import('../src/dashboard/projects')
const { dashboardApp, dashboardBuiltInGetRoutes } = await import('../src/dashboard')
const { projectsApp } = await import('../src/projects')

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad Alpha');
    INSERT INTO members (id, email, display_name, tenant, status) VALUES
      ('${VIEWER_ID}', 'viewer@example.com', 'Viewer', '${TENANT}', 'active');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-viewer-a', '${VIEWER_ID}', 'squad', 'squad-a', 'member');
    INSERT INTO projects (id, slug, name, description, goal, status) VALUES
      ('${PROJECT_ID}', 'docs-proj', 'Docs Project', 'Knowledge', 'Know', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
      ('${PROJECT_ID}', 'squad-a', 'write');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BRAND: 'Mupot',
    AI: {
      async run() {
        return { data: [[0.1, 0.2, 0.3]] }
      },
    },
    VEC: {
      async upsert() {
        return
      },
      async query() {
        return { matches: [] }
      },
    },
  } as unknown as Env
}

function viewerAuth(): AuthContext {
  return {
    userId: VIEWER_ID,
    memberId: VIEWER_ID,
    email: 'viewer@example.com',
    role: 'member',
    tenant: TENANT,
    channel: 'dashboard',
    capabilities: [
      { member_id: VIEWER_ID, scope_type: 'squad', scope_id: 'squad-a', capability: 'member' },
    ],
  }
}

function as(auth: AuthContext | null): void {
  authState.current = auth
}

describe('dashboard Docs route (3rd owner surface)', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    as(null)
    harness?.close()
    harness = undefined
  })

  it('registers the docs route in the built-in GET table', () => {
    expect(dashboardBuiltInGetRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'GET', path: '/projects/:id/docs' }),
      ]),
    )
  })

  it('renders Chat / Docs / Board owner surfaces on project detail and docs page', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    as(viewerAuth())

    const detail = await dashboardApp.fetch(new Request(`https://pot.test/projects/${PROJECT_ID}`), env)
    const detailHtml = await detail.text()
    expect(detail.status).toBe(200)
    expect(detailHtml).toContain('aria-label="Owner surfaces"')
    expect(detailHtml).toContain(`href="/send?project_id=${PROJECT_ID}"`)
    expect(detailHtml).toContain(`href="/projects/${PROJECT_ID}/docs"`)
    expect(detailHtml).toContain(`href="/projects/${PROJECT_ID}#board"`)

    const docsPage = await dashboardApp.fetch(
      new Request(`https://pot.test/projects/${PROJECT_ID}/docs`),
      env,
    )
    const docsHtml = await docsPage.text()
    expect(docsPage.status).toBe(200)
    expect(docsHtml).toContain('aria-label="Owner surfaces"')
    expect(docsHtml).toContain('aria-current="page">Docs</a>')
    expect(docsHtml).toContain('name="q"')
    expect(docsHtml).toContain('Search docs')
  })

  it('HTML + JSON omit private/entity docs the viewer lacks claims for (not CSS-hidden)', async () => {
    harness = makeHarness()
    const env = envFor(harness)

    await writeProjectDoc(env, PROJECT_ID, 'VISIBLE_PUBLIC_MARKER', null, { tier: 'public' })
    await writeProjectDoc(env, PROJECT_ID, 'VISIBLE_PROJECT_MARKER', null, { tier: 'project' })
    await writeProjectDoc(env, PROJECT_ID, 'HIDDEN_PRIVATE_MARKER', null, {
      tier: 'private',
      created_by: OTHER_USER,
    })
    await writeProjectDoc(env, PROJECT_ID, 'HIDDEN_ENTITY_MARKER', null, {
      tier: 'entity',
      entity_id: ENTITY_SECRET,
    })

    as(viewerAuth())

    const htmlRes = await dashboardApp.fetch(
      new Request(`https://pot.test/projects/${PROJECT_ID}/docs`),
      env,
    )
    const html = await htmlRes.text()
    expect(htmlRes.status).toBe(200)
    expect(html).toContain('VISIBLE_PUBLIC_MARKER')
    expect(html).toContain('VISIBLE_PROJECT_MARKER')
    expect(html).not.toContain('HIDDEN_PRIVATE_MARKER')
    expect(html).not.toContain('HIDDEN_ENTITY_MARKER')

    const apiRes = await projectsApp.fetch(
      new Request(`https://pot.test/${PROJECT_ID}/docs`),
      env,
    )
    const body = (await apiRes.json()) as { docs: Array<{ text: string }> }
    expect(apiRes.status).toBe(200)
    const texts = body.docs.map((d) => d.text)
    expect(texts).toContain('VISIBLE_PUBLIC_MARKER')
    expect(texts).toContain('VISIBLE_PROJECT_MARKER')
    expect(texts).not.toContain('HIDDEN_PRIVATE_MARKER')
    expect(texts).not.toContain('HIDDEN_ENTITY_MARKER')

    const searchRes = await dashboardApp.fetch(
      new Request(`https://pot.test/projects/${PROJECT_ID}/docs?q=VISIBLE_PROJECT`),
      env,
    )
    const searchHtml = await searchRes.text()
    expect(searchHtml).toContain('VISIBLE_PROJECT_MARKER')
    expect(searchHtml).not.toContain('VISIBLE_PUBLIC_MARKER')
    expect(searchHtml).not.toContain('HIDDEN_PRIVATE_MARKER')

    const view = await loadProjectDocsView(env, viewerAuth(), PROJECT_ID, '')
    expect(view).not.toBeNull()
    const renderedHtml = String(await projectDocsBody(view!))
    expect(renderedHtml).toContain('VISIBLE_PUBLIC_MARKER')
    expect(renderedHtml).not.toContain('HIDDEN_PRIVATE_MARKER')
  })
})

describe('local browser smoke covers docs viewer RBAC', () => {
  const browserSmokeSource = readFileSync(
    join(__dirname, '..', 'scripts', 'local-browser-smoke.mjs'),
    'utf8',
  )

  it('visits the project docs route and asserts public+project visible, private/entity omitted', () => {
    expect(browserSmokeSource).toContain('/projects/project-mupot/docs')
    expect(browserSmokeSource).toContain('VISIBLE_PUBLIC_MARKER')
    expect(browserSmokeSource).toContain('VISIBLE_PROJECT_MARKER')
    expect(browserSmokeSource).toContain('HIDDEN_PRIVATE_MARKER')
    expect(browserSmokeSource).toContain('HIDDEN_ENTITY_MARKER')
    expect(browserSmokeSource).toContain('must not include HIDDEN_PRIVATE_MARKER')
  })
})
