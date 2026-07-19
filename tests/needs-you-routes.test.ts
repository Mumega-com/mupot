import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', () => ({
  requireAuth: async (c: { set: (key: 'auth', value: AuthContext) => void; json: (body: unknown, status: 401) => Response }, next: () => Promise<void>) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
}))

const { attentionApp } = await import('../src/attention/routes')
const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')

function sessions() {
  const entries = new Map<string, string>()
  return {
    get: async (key: string) => entries.get(key) ?? null,
    put: async (key: string, value: string) => { entries.set(key, value) },
    delete: async (key: string) => { entries.delete(key) },
  }
}

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter(file => file.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-1', 'alpha', 'Alpha'), ('squad-b', 'dept-1', 'beta', 'Beta');
    INSERT INTO projects (id, slug, name, status) VALUES ('project-a', 'project-a', 'Project A', 'active'), ('project-b', 'project-b', 'Project B', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-a', 'squad-a', 'write'), ('project-b', 'squad-b', 'write');
    INSERT INTO tasks (id, squad_id, project_id, title, body, done_when, status, gate_owner, created_at, updated_at)
      VALUES ('visible-task', 'squad-a', 'project-a', 'Visible blocker', '', 'Done', 'blocked', 'role:delivery', '2026-07-19T10:00:00.000Z', '2026-07-19T10:00:00.000Z'),
             ('hidden-task', 'squad-b', 'project-b', 'Hidden blocker', '', 'Done', 'blocked', 'role:delivery', '2026-07-19T10:00:00.000Z', '2026-07-19T10:00:00.000Z');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, SESSIONS: sessions(), TENANT_SLUG: 'tenant-a' } as unknown as Env
}

function member(): AuthContext {
  return {
    userId: 'member-a', memberId: 'member-a', email: null, role: 'member', tenant: 'tenant-a',
    capabilities: [{ member_id: 'member-a', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' }],
  }
}

describe('Needs You REST routes', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    authState.current = null
    harness?.close()
    harness = undefined
  })

  it('is GET-only, project-filtered through the shared projection, and no-store', async () => {
    harness = makeHarness()
    authState.current = member()
    const global = await attentionApp.fetch(new Request('https://pot.test/needs-you'), envFor(harness))
    expect(global.status).toBe(200)
    expect(global.headers.get('cache-control')).toBe('no-store')
    await expect(global.json()).resolves.toMatchObject({ items: [expect.objectContaining({ source_id: 'visible-task', project_id: 'project-a' })] })

    const project = await attentionApp.fetch(new Request('https://pot.test/projects/project-a/needs-you'), envFor(harness))
    expect(project.status).toBe(200)
    await expect(project.json()).resolves.toMatchObject({ items: [expect.objectContaining({ source_id: 'visible-task' })] })
    expect((await attentionApp.fetch(new Request('https://pot.test/projects/project-b/needs-you'), envFor(harness))).status).toBe(404)
    expect((await attentionApp.fetch(new Request('https://pot.test/needs_you_resolve', { method: 'POST' }), envFor(harness))).status).toBe(404)
  })

  it('rejects invalid bounded pagination and unauthenticated reads with stable errors', async () => {
    harness = makeHarness()
    const unauthenticated = await attentionApp.fetch(new Request('https://pot.test/needs-you'), envFor(harness))
    expect(unauthenticated.status).toBe(401)
    expect(unauthenticated.headers.get('cache-control')).toBe('no-store')

    authState.current = member()
    const badLimit = await attentionApp.fetch(new Request('https://pot.test/needs-you?limit=101'), envFor(harness))
    expect(badLimit.status).toBe(400)
    await expect(badLimit.json()).resolves.toEqual({ error: 'invalid_pagination' })
    const badCursor = await attentionApp.fetch(new Request('https://pot.test/needs-you?cursor=%3Cscript%3E'), envFor(harness))
    expect(badCursor.status).toBe(400)
  })
})
