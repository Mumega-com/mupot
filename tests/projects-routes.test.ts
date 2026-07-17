import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
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

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO departments (id, slug, name) VALUES ('dept-b', 'dept-b', 'Department B');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-b', 'dept-b', 'squad-b', 'Squad B');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: 'pot-a' } as Env
}

function as(auth: AuthContext | null): void {
  authState.current = auth
}

function actor(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'user-1',
    email: null,
    role: 'member',
    tenant: 'pot-a',
    ...overrides,
  }
}

function request(path: string, method = 'GET', body?: unknown): Request {
  return new Request(`https://pot.test${path}`, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { Origin: 'https://pot.test' }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function fetch(harness: SqliteD1Harness, path: string, method = 'GET', body?: unknown): Promise<Response> {
  return projectsApp.fetch(request(path, method, body), envFor(harness))
}

function seedProjects(harness: SqliteD1Harness): void {
  harness.sqlite.exec(`
    INSERT INTO projects (id, slug, name, status) VALUES ('parent', 'parent', 'Parent', 'active');
    INSERT INTO projects (id, slug, name, status, parent_project_id) VALUES ('visible-child', 'visible-child', 'Visible child', 'active', 'parent');
    INSERT INTO projects (id, slug, name, status, parent_project_id) VALUES ('hidden-child', 'hidden-child', 'Hidden child', 'active', 'parent');
    INSERT INTO projects (id, slug, name, status) VALUES ('other-root', 'other-root', 'Other root', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('visible-child', 'squad-a', 'read');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('hidden-child', 'squad-b', 'read');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('other-root', 'squad-b', 'read');
    INSERT INTO tasks (id, squad_id, title, status, project_id) VALUES ('visible-task', 'squad-a', 'Visible work', 'open', 'visible-child');
    INSERT INTO tasks (id, squad_id, title, status, project_id) VALUES ('hidden-task', 'squad-b', 'Hidden work', 'open', 'hidden-child');
    INSERT INTO flights (id, tenant, agent, goal, status, project_id) VALUES ('visible-flight', 'pot-a', 'agent-a', 'Visible flight', 'running', 'visible-child');
    INSERT INTO flights (id, tenant, agent, goal, status, project_id) VALUES ('hidden-flight', 'pot-a', 'agent-b', 'Hidden flight', 'running', 'hidden-child');
  `)
}

describe('projectsApp', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    authState.current = null
    harness?.close()
    harness = undefined
  })

  it('rejects unauthenticated and cross-tenant requests before project access', async () => {
    harness = makeHarness()
    expect((await fetch(harness, '/')).status).toBe(401)

    as(actor({ tenant: 'other-pot', role: 'owner' }))
    const response = await fetch(harness, '/')
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'forbidden', reason: 'tenant_scope' })
  })

  it('lets an owner list, create, update, and administer explicit squad edges', async () => {
    harness = makeHarness()
    as(actor({ role: 'owner' }))

    const created = await fetch(harness, '/', 'POST', { slug: 'launch', name: 'Launch' })
    expect(created.status).toBe(201)
    const project = (await created.json() as { project: { id: string; slug: string } }).project

    expect((await fetch(harness, `/${project.id}/squads/squad-a`, 'PUT', { access_level: 'write' })).status).toBe(200)
    await expect((await fetch(harness, `/${project.id}/squads`)).json()).resolves.toMatchObject({ squads: [{ squad_id: 'squad-a', access_level: 'write' }] })
    expect((await fetch(harness, `/${project.id}`, 'PATCH', { name: 'Launch now' })).status).toBe(200)
    expect((await fetch(harness, `/${project.id}/squads/squad-a`, 'DELETE')).status).toBe(204)
    await expect((await fetch(harness, '/')).json()).resolves.toMatchObject({ projects: [{ id: project.id, slug: 'launch', name: 'Launch now' }] })
  })

  it('only gives a member the explicitly readable project and its needed parent context', async () => {
    harness = makeHarness()
    seedProjects(harness)
    as(actor({
      memberId: 'member-a',
      capabilities: [{ member_id: 'member-a', scope_type: 'department', scope_id: 'dept-a', capability: 'observer' }],
    }))

    const list = await fetch(harness, '/')
    expect(list.status).toBe(200)
    const listed = await list.json() as { projects: Array<{ id: string; parent_context?: boolean }> }
    expect(listed.projects.map((project) => project.id)).toEqual(['parent', 'visible-child'])
    expect(listed.projects.find((project) => project.id === 'parent')).toMatchObject({ parent_context: true })

    const detail = await fetch(harness, '/visible-child')
    expect(detail.status).toBe(200)
    await expect(detail.json()).resolves.toMatchObject({
      project: { id: 'visible-child', parent_project_id: 'parent' },
      aggregates: { direct_tasks: 1, direct_squads: 1, direct_flights: 1 },
      parent: { id: 'parent' },
    })
    expect((await fetch(harness, '/hidden-child')).status).toBe(404)
    expect((await fetch(harness, '/other-root')).status).toBe(404)
    expect((await fetch(harness, '/hidden-child/squads')).status).toBe(404)
  })

  it('resolves a dashboard member from the authenticated email within this tenant', async () => {
    harness = makeHarness()
    seedProjects(harness)
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, tenant) VALUES ('member-a', 'member-a@pot.test', 'Member A', 'pot-a');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('member-a-observer', 'member-a', 'squad', 'squad-a', 'observer');
    `)
    as(actor({ email: 'member-a@pot.test' }))

    const response = await fetch(harness, '/')
    await expect(response.json()).resolves.toMatchObject({
      projects: [{ id: 'parent', parent_context: true }, { id: 'visible-child' }],
    })
  })

  it('honors exact squad edges plus org capability administration without trusting request identity', async () => {
    harness = makeHarness()
    seedProjects(harness)
    as(actor({
      memberId: 'member-admin',
      capabilities: [{ member_id: 'member-admin', scope_type: 'org', scope_id: null, capability: 'admin' }],
    }))

    expect((await fetch(harness, '/visible-child', 'PATCH', { goal: 'Only auth identity', member_id: 'someone-else' })).status).toBe(200)
    expect((await fetch(harness, '/visible-child/squads/squad-b', 'PUT', { access_level: 'admin', member_id: 'someone-else' })).status).toBe(200)
    expect((await fetch(harness, '/hidden-child')).status).toBe(200)
  })

  it('returns stable validation, forbidden, hidden, missing, and conflict responses', async () => {
    harness = makeHarness()
    seedProjects(harness)
    as(actor({ memberId: 'member-a', capabilities: [{ member_id: 'member-a', scope_type: 'squad', scope_id: 'squad-a', capability: 'observer' }] }))
    expect((await fetch(harness, '/', 'POST', { slug: 'nope', name: 'Nope' })).status).toBe(403)
    expect((await fetch(harness, '/?status=not-a-status')).status).toBe(400)
    expect((await fetch(harness, '/?parent_id=')).status).toBe(400)
    expect((await fetch(harness, '/missing')).status).toBe(404)

    as(actor({ role: 'admin' }))
    expect((await fetch(harness, '/', 'POST', { slug: 'Bad Slug', name: 'Invalid' })).status).toBe(400)
    expect((await fetch(harness, '/', 'POST', { slug: 'parent', name: 'Duplicate' })).status).toBe(409)
    expect((await fetch(harness, '/missing', 'PATCH', { name: 'Missing' })).status).toBe(404)
    expect((await fetch(harness, '/visible-child/squads/missing', 'PUT', { access_level: 'write' })).status).toBe(404)
    expect((await fetch(harness, '/visible-child/squads/squad-b', 'DELETE')).status).toBe(404)
  })
})
