import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', () => ({
  requireAuth: async (c: {
    set: (key: 'auth', value: AuthContext) => void
    json: (body: unknown, status: 401) => Response
  }, next: () => Promise<void>) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
}))

const { dashboardApp, dashboardBuiltInGetRoutes } = await import('../src/dashboard')

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')

function sessions() {
  const values = new Map<string, string>()
  return {
    async get<T = string>(key: string, type?: 'text' | 'json'): Promise<T | null> {
      const value = values.get(key)
      if (value === undefined) return null
      return (type === 'json' ? JSON.parse(value) : value) as T
    },
    async put(key: string, value: string): Promise<void> { values.set(key, value) },
    async delete(key: string): Promise<void> { values.delete(key) },
  }
}

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'delivery', 'Delivery'), ('dept-b', 'secret', 'Secret');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'alpha', 'Alpha'), ('squad-b', 'dept-b', 'beta', 'Beta');
    INSERT INTO projects (id, slug, name, status) VALUES ('project-a', 'project-a', 'Project A', 'active'), ('project-b', 'project-b', 'Hidden Project', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-a', 'squad-a', 'write'), ('project-b', 'squad-b', 'write');
    INSERT INTO tasks (id, squad_id, project_id, title, body, done_when, status, gate_owner, result, created_at, updated_at) VALUES
      ('approval-a', 'squad-a', 'project-a', 'Approve release', '', 'Approved', 'review', 'gate:content', NULL, '2026-07-19T11:00:00.000Z', '2026-07-19T11:00:00.000Z'),
      ('blocked-a', 'squad-a', 'project-a', 'Unblock launch', '', 'Unblocked', 'blocked', 'role:delivery', NULL, '2026-07-19T10:00:00.000Z', '2026-07-19T10:00:00.000Z'),
      ('publish-a', 'squad-a', 'project-a', 'Publish release', '', 'Published', 'approved', 'gate:content', 'ready', '2026-07-19T09:00:00.000Z', '2026-07-19T09:00:00.000Z'),
      ('hidden-a', 'squad-b', 'project-b', 'Hidden approval', '', 'Approved', 'review', 'gate:content', NULL, '2026-07-19T11:00:00.000Z', '2026-07-19T11:00:00.000Z');
    INSERT INTO routines (id, tenant, project_id, name, objective, status, trigger_kind, timezone, overlap_policy, execution_mode, responsible_squad_id, budget_micro_usd, max_attempts, retry_backoff_seconds, revision, enabled_by, enabled_at, created_by, created_at, updated_at)
      VALUES ('routine-a', 'tenant-a', 'project-a', 'Routine wait', 'Wait for review', 'enabled', 'manual', 'UTC', 'skip', 'propose', 'squad-a', 0, 3, 300, 1, 'member-a', '2026-07-19T08:00:00.000Z', 'member-a', '2026-07-19T08:00:00.000Z', '2026-07-19T08:00:00.000Z');
    INSERT INTO routine_runs (id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key, trigger_kind, status, waiting_reason, created_at, updated_at)
      VALUES ('routine-wait', 'tenant-a', 'project-a', 'routine-a', 1, '{}', 'manual:wait', 'manual', 'waiting', 'review', '2026-07-19T12:00:00.000Z', '2026-07-19T12:00:00.000Z');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, SESSIONS: sessions(), TENANT_SLUG: 'tenant-a', BRAND: 'Mupot' } as unknown as Env
}

function member(): AuthContext {
  return {
    userId: 'member-a', memberId: 'member-a', email: null, role: 'member', tenant: 'tenant-a',
    capabilities: [{ member_id: 'member-a', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' }],
  }
}

describe('Needs You dashboard', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    authState.current = null
    harness?.close()
    harness = undefined
  })

  it('renders source-specific safe action links, exact urgency labels, continuation, and no generic resolution mutation', async () => {
    harness = makeHarness()
    authState.current = member()
    const response = await dashboardApp.fetch(new Request('https://pot.test/needs-you?limit=1'), envFor(harness))
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain('Needs You')
    expect(body).toContain('Urgent')
    expect(body).toContain('href="/api/routine-runs/routine-wait"')
    expect(body).toContain('>view<')
    expect(body).toContain('Continue queue')
    expect(body).not.toContain('needs_you_resolve')
    expect(body).not.toContain('Resolve')
    expect(body).not.toContain('<form')
    expect(body).toContain('role="region" aria-label="Needs You queue" tabindex="0"')
    expect(body).toContain('style="max-width:100%;overflow-x:auto;"')
    expect(dashboardBuiltInGetRoutes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/needs-you' }))
  })

  it('keeps unauthorized Projects absent and reports validation errors without fabricating queue items', async () => {
    harness = makeHarness()
    authState.current = member()
    const env = envFor(harness)
    const response = await dashboardApp.fetch(new Request('https://pot.test/needs-you'), env)
    const body = await response.text()
    expect(body).toContain('Approve release')
    expect(body).not.toContain('Hidden approval')

    const invalid = await dashboardApp.fetch(new Request('https://pot.test/needs-you?limit=101'), env)
    expect(invalid.status).toBe(400)
    expect(await invalid.text()).toContain('Choose a valid Needs You page.')
  })

  it('adds Needs You directly after Work and before Approvals in the global navigation', async () => {
    const source = readFileSync(new URL('../src/dashboard/index.ts', import.meta.url), 'utf8')
    const work = source.indexOf('<span class="nav-label">Work</span>')
    const needsYou = source.indexOf('<span class="nav-label">Needs You</span>')
    const approvals = source.indexOf('<span class="nav-label">Approvals</span>')
    expect(needsYou).toBeGreaterThan(work)
    expect(approvals).toBeGreaterThan(needsYou)
  })
})
