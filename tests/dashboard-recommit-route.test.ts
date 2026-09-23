// tests/dashboard-recommit-route.test.ts — the dashboard Needs You "Recommit"
// button posts to the EXISTING RBAC-gated POST /projects/:id/recommit route.
// No new write path: this exercises that same route directly through
// projectsApp (same pattern as tests/projects-routes.test.ts), and confirms
// the button writes exactly one recommit receipt and that the item then
// disappears from Needs You — plus the refused (self_recommit) path returns a
// legible error and writes NO receipt.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ROUTES } from '../src/types'
import type { AuthContext, Env } from '../src/types'
import { listNeedsYou } from '../src/attention/service'
import type { RoutinePrincipal } from '../src/routines/access'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', () => ({
  requireAuth: async (c: { get: (key: 'auth') => AuthContext | undefined; set: (key: 'auth', value: AuthContext) => void; json: (body: unknown, status: 401) => Response }, next: () => Promise<void>) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
}))

const { projectsApp } = await import('../src/projects')
const { dashboardApp } = await import('../src/dashboard')

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')
const TENANT = 'pot-a'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-worker', 'squad-a', 'agent-worker', 'Agent Worker', 'active');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: TENANT } as unknown as Env
}

function attentionEnvFor(harness: SqliteD1Harness): Env {
  const rows = new Map<string, string>()
  const sessions = {
    async get<T = string>(key: string, type?: 'text' | 'json'): Promise<T | null> {
      const value = rows.get(key)
      if (value === undefined) return null
      return (type === 'json' ? JSON.parse(value) : value) as T
    },
    async put(key: string, value: string): Promise<void> { rows.set(key, value) },
    async delete(key: string): Promise<void> { rows.delete(key) },
  }
  return { DB: harness.db, SESSIONS: sessions, TENANT_SLUG: TENANT } as unknown as Env
}

function as(auth: AuthContext | null): void {
  authState.current = auth
}

function actor(overrides: Partial<AuthContext> = {}): AuthContext {
  return { userId: 'user-1', email: null, role: 'admin', tenant: TENANT, ...overrides }
}

function request(path: string, method = 'GET', body?: unknown, origin = 'https://pot.test'): Request {
  return new Request(`https://pot.test${path}`, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { Origin: origin }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function post(harness: SqliteD1Harness, path: string, body?: unknown): Promise<Response> {
  return projectsApp.fetch(request(path, 'POST', body ?? {}), envFor(harness))
}

function insertProject(harness: SqliteD1Harness, values: { id: string; cycleBoundaryAt: string }): void {
  harness.sqlite.prepare(
    `INSERT INTO projects (id, slug, name, status, cycle_boundary_at, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`,
  ).run(values.id, values.id, `Project ${values.id}`, values.cycleBoundaryAt)
  harness.sqlite.prepare(
    `INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES (?, 'squad-a', 'write')`,
  ).run(values.id)
}

function receiptCount(harness: SqliteD1Harness, projectId: string): number {
  const row = harness.sqlite.prepare(
    `SELECT COUNT(*) AS n FROM workflow_receipts WHERE instance_id LIKE ?`,
  ).get(`project-cycle:${projectId}:%`) as { n: number }
  return row.n
}

function owner(): RoutinePrincipal {
  return {
    tenant: TENANT, actor_type: 'member', actor_id: 'owner-a', workspace_admin: true,
    grants: [], project_read: { workspaceAdmin: true, orgRead: true, squadIds: [], departmentIds: [] },
    legacy_owner_admin: true,
  }
}

describe('POST /projects/:id/recommit (the dashboard Recommit button target)', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    authState.current = null
    harness?.close()
    harness = undefined
  })

  it('writes exactly one recommit receipt and the item disappears from Needs You', async () => {
    harness = makeHarness()
    const boundary = '2026-09-24T00:00:00.000Z'
    insertProject(harness, { id: 'proj-recommit', cycleBoundaryAt: boundary })
    as(actor({ memberId: 'member:distinct-admin' }))

    const before = await listNeedsYou(attentionEnvFor(harness), owner(), {}, '2026-09-23T12:00:00.000Z')
    expect(before.items.some(i => i.source_id === 'proj-recommit')).toBe(true)

    const response = await post(harness, '/proj-recommit/recommit', { reason: 'dashboard_recommit' })
    expect(response.status).toBe(200)
    const body = await response.json() as { recommit: { decision: string; project_id: string } }
    expect(body.recommit).toMatchObject({ decision: 'recommit', project_id: 'proj-recommit' })
    expect(receiptCount(harness, 'proj-recommit')).toBe(1)

    // Idempotent replay of the SAME principal must not write a second row
    // (UNIQUE(instance_id, step_name) + INSERT OR IGNORE).
    const replay = await post(harness, '/proj-recommit/recommit', { reason: 'dashboard_recommit' })
    expect(replay.status).toBe(200)
    expect(receiptCount(harness, 'proj-recommit')).toBe(1)

    const after = await listNeedsYou(attentionEnvFor(harness), owner(), {}, '2026-09-23T12:00:00.000Z')
    expect(after.items.some(i => i.source_id === 'proj-recommit')).toBe(false)
  })

  it('refuses self-recommit legibly (409 self_recommit) and writes no receipt', async () => {
    harness = makeHarness()
    const boundary = '2026-09-24T00:00:00.000Z'
    insertProject(harness, { id: 'proj-self', cycleBoundaryAt: boundary })
    harness.sqlite.exec(`
      INSERT INTO tasks (
        id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
        github_issue_url, result, completed_at, gate_owner, created_at, updated_at
      ) VALUES (
        't-own', 'squad-a', 'proj-self', 'Work', '', 'done', 'in_progress', 'agent-worker',
        NULL, NULL, NULL, NULL, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'
      );
    `)
    // recommitPrincipalFromAuth resolves memberId first — set it to the
    // task's own assignee_agent_id so this admin IS the project's assignee.
    as(actor({ memberId: 'agent-worker' }))

    const response = await post(harness, '/proj-self/recommit', { reason: 'dashboard_recommit' })
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'self_recommit' })
    expect(receiptCount(harness, 'proj-self')).toBe(0)
  })

  it('refuses a non-admin caller with 403 before proposeProjectRecommit ever runs', async () => {
    harness = makeHarness()
    insertProject(harness, { id: 'proj-member', cycleBoundaryAt: '2026-09-24T00:00:00.000Z' })
    as(actor({ role: 'member', memberId: 'member-a' }))

    const response = await post(harness, '/proj-member/recommit', { reason: 'x' })
    expect(response.status).toBe(403)
    expect(receiptCount(harness, 'proj-member')).toBe(0)
  })
})

// Round 2 adversarial P0-2: recommitScript() previously fetched
// '/projects/' + id + '/recommit', but projectsApp is mounted at
// ROUTES.projects = '/api/projects' (src/types.ts) by src/index.ts's
// `app.route(ROUTES.projects, projectsApp)` — a 404 in production, showing
// the button's own "network error" message. Testing the button's target via
// projectsApp.fetch() directly (as every test above does) CANNOT catch this
// class of bug: projectsApp's own route table has no idea what prefix it is
// mounted under, so `projectsApp.fetch('/x/recommit')` "passes" no matter
// what prefix the rendered script guesses. These two tests instead (a) read
// the ACTUAL rendered script's fetch prefix out of the real /needs-you page
// and (b) dispatch that exact prefix through a root app built with the
// SAME mount call src/index.ts makes (`app.route(ROUTES.projects, projectsApp)`),
// not a guessed path — proving the two agree. (Importing the real src/index.ts
// `app` directly is not possible under vitest — it transitively imports
// `cloudflare:*` Workers runtime built-ins that the Node ESM loader refuses;
// confirmed by attempting it. This is the closest faithful reproduction of
// that one mount line without pulling in the other 60+ subsystems index.ts
// wires up.)
describe('the Recommit button URL, dispatched through the REAL ROUTES.projects mount (round 2 P0-2)', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    authState.current = null
    harness?.close()
    harness = undefined
  })

  it('the rendered script\'s fetch prefix is exactly ROUTES.projects, and that prefix resolves through app.route(ROUTES.projects, projectsApp)', async () => {
    harness = makeHarness()
    insertProject(harness, { id: 'proj-url-check', cycleBoundaryAt: '2026-09-24T00:00:00.000Z' })
    as(actor({ memberId: 'member:distinct-admin' }))

    const page = await dashboardApp.fetch(new Request('https://pot.test/needs-you'), envFor(harness))
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('recommit')

    // Extract the literal string the script concatenates the project id onto.
    const match = /fetch\('([^']*)'\s*\+\s*encodeURIComponent\(projectId\)\s*\+\s*'\/recommit'/.exec(html)
    expect(match, 'expected the rendered script to contain a recommit fetch call').not.toBeNull()
    const fetchPrefix = match![1] // literal string the script concatenates: '${ROUTES.projects}/'
    expect(fetchPrefix).toBe(`${ROUTES.projects}/`)
    expect(fetchPrefix).not.toBe('/projects/') // the round-2 bug — no /api prefix

    // Now prove that EXACT prefix actually dispatches into projectsApp when
    // mounted the way src/index.ts mounts it — not projectsApp.fetch(), a
    // composed root using the real ROUTES.projects constant.
    const rootApp = new Hono<{ Bindings: Env }>()
    rootApp.route(ROUTES.projects, projectsApp)
    const response = await rootApp.fetch(
      request(`${fetchPrefix}proj-url-check/recommit`, 'POST', { reason: 'dashboard_recommit' }),
      envFor(harness),
    )
    expect(response.status).toBe(200)
    expect(receiptCount(harness, 'proj-url-check')).toBe(1)

    // And the OLD buggy guess ('/projects/...', no /api prefix) 404s through
    // that same real mount — this is exactly what shipped to prod in round 1.
    const brokenResponse = await rootApp.fetch(
      request('/projects/proj-url-check/recommit', 'POST', { reason: 'dashboard_recommit' }),
      envFor(harness),
    )
    expect(brokenResponse.status).toBe(404)
  })
})
