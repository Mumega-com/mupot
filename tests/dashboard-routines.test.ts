import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', () => ({
  requireAuth: async (c: {
    get: (key: 'auth') => AuthContext | undefined
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
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'delivery', 'Delivery');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'alpha', 'Alpha');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-a', 'squad-a', 'agent-a', 'Agent A', 'active');
    INSERT INTO projects (id, slug, name, goal, status) VALUES
      ('project-a', 'project-a', 'Project A', 'Deliver safely', 'active'),
      ('project-empty', 'project-empty', 'Empty Project', 'Start safely', 'active'),
      ('project-hidden', 'project-hidden', 'Hidden Project', 'Do not expose', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-a', 'squad-a', 'write'), ('project-empty', 'squad-a', 'write');
    INSERT INTO routines (
      id, tenant, project_id, name, objective, status, trigger_kind, run_once_at, cron_expression, timezone, next_run_at,
      overlap_policy, execution_mode, responsible_squad_id, preferred_agent_id, budget_micro_usd,
      max_attempts, retry_backoff_seconds, revision, enabled_by, enabled_at, created_by, created_at, updated_at
    ) VALUES
      ('routine-draft', 'tenant-a', 'project-a', 'Draft routine', 'Prepare a safe action', 'draft', 'manual', NULL, NULL, 'UTC', NULL,
       'skip', 'propose', 'squad-a', 'agent-a', 100000, 3, 300, 1, NULL, NULL, 'admin-a', '2026-07-19T10:00:00.000Z', '2026-07-19T10:00:00.000Z'),
      ('routine-enabled', 'tenant-a', 'project-a', 'Enabled routine', 'Move accountable work', 'enabled', 'cron', NULL, '* * * * *', 'America/Toronto', '2026-07-20T10:00:00.000Z',
       'queue', 'execute_internal', 'squad-a', 'agent-a', 200000, 4, 600, 2, 'admin-a', '2026-07-19T10:00:00.000Z', 'admin-a', '2026-07-19T10:00:00.000Z', '2026-07-19T10:00:00.000Z'),
      ('routine-paused', 'tenant-a', 'project-a', 'Paused routine', 'Wait safely', 'paused', 'once', '2026-07-22T12:00:00.000Z', NULL, 'UTC', NULL,
       'skip', 'propose', 'squad-a', NULL, 0, 3, 300, 2, 'admin-a', '2026-07-19T10:00:00.000Z', 'admin-a', '2026-07-19T10:00:00.000Z', '2026-07-19T10:00:00.000Z');
    INSERT INTO routine_runs (
      id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key, trigger_kind,
      scheduled_for, status, waiting_reason, attempt, assigned_agent_id, cost_micro_usd, result_summary,
      created_at, updated_at, finished_at
    ) VALUES
      ('run-waiting', 'tenant-a', 'project-a', 'routine-enabled', 2, '{}', 'cron:waiting', 'cron',
       '2026-07-20T10:00:00.000Z', 'waiting', 'review', 1, 'agent-a', 1200, NULL,
       '2026-07-19T11:00:00.000Z', '2026-07-19T11:00:00.000Z', NULL),
      ('run-failed', 'tenant-a', 'project-a', 'routine-enabled', 2, '{}', 'cron:failed', 'cron',
       '2026-07-19T09:00:00.000Z', 'failed', NULL, 3, 'agent-a', 2000, 'execution_failed',
       '2026-07-19T09:00:00.000Z', '2026-07-19T09:10:00.000Z', '2026-07-19T09:10:00.000Z'),
      ('run-terminal', 'tenant-a', 'project-a', 'routine-paused', 2, '{}', 'once:terminal', 'once',
       '2026-07-18T09:00:00.000Z', 'succeeded', NULL, 1, 'agent-a', 100, 'task_created',
       '2026-07-18T09:00:00.000Z', '2026-07-18T09:10:00.000Z', '2026-07-18T09:10:00.000Z');
    INSERT INTO routine_run_events (id, tenant, project_id, run_id, kind, actor_type, actor_id, occurred_at, metadata_json, correlation_id)
      VALUES ('event-a', 'tenant-a', 'project-a', 'run-waiting', 'agent_waiting', 'agent', 'agent-a', '2026-07-19T11:00:00.000Z', '{}', 'run-waiting');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, SESSIONS: sessions(), TENANT_SLUG: 'tenant-a', BRAND: 'Mupot' } as unknown as Env
}

function actor(overrides: Partial<AuthContext> = {}): AuthContext {
  return { userId: 'member-a', memberId: 'member-a', email: null, role: 'member', tenant: 'tenant-a', ...overrides }
}

function member(): AuthContext {
  return actor({ capabilities: [{ member_id: 'member-a', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' }] })
}

function post(path: string, values: Record<string, string>): Request {
  return new Request(`https://pot.test${path}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://pot.test' },
    body: new URLSearchParams(values),
  })
}

function nonce(body: string, routineId: string): string {
  const match = body.match(new RegExp(`action="/projects/project-a/routines/${routineId}/run"[\\s\\S]*?name="nonce" value="([^"]+)"`))
  if (!match) throw new Error(`missing run nonce for ${routineId}`)
  return match[1]
}

describe('Project Routines dashboard', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    authState.current = null
    harness?.close()
    harness = undefined
  })

  it('renders bounded routine, run, and event tables with exact state labels and mobile-safe table regions', async () => {
    harness = makeHarness()
    authState.current = actor({ role: 'owner' })
    const env = envFor(harness)
    const response = await dashboardApp.fetch(new Request('https://pot.test/projects/project-a/routines'), env)
    const body = await response.text()

    expect(response.status).toBe(200)
    for (const text of ['Draft', 'Enabled', 'Paused', 'waiting(review)', 'Failed', 'Succeeded', 'America/Toronto', 'execute internal', 'queue']) {
      expect(body).toContain(text)
    }
    expect(body).toContain('role="region" aria-label="Project routines" tabindex="0"')
    expect(body).toContain('style="max-width:100%;overflow-x:auto;"')
    expect(body).toContain('href="/projects/project-a#activity"')
    expect(body).toContain('href="/projects/project-a#evidence"')
    expect(body).toContain('name="nonce"')
    expect(dashboardBuiltInGetRoutes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/projects/:id/routines' }))

    const bounded = await dashboardApp.fetch(new Request('https://pot.test/projects/project-a/routines?run_limit=1&event_limit=1'), env)
    expect(await bounded.text()).toContain('Showing a bounded page of runs.')
  })

  it('hides an unreadable Project and preserves empty and validation-error states', async () => {
    harness = makeHarness()
    authState.current = member()
    const env = envFor(harness)

    const hidden = await dashboardApp.fetch(new Request('https://pot.test/projects/project-hidden/routines'), env)
    expect(hidden.status).toBe(404)

    const empty = await dashboardApp.fetch(new Request('https://pot.test/projects/project-empty/routines'), env)
    expect(empty.status).toBe(200)
    expect(await empty.text()).toContain('No routine runs are recorded for this Project yet.')

    const invalid = await dashboardApp.fetch(new Request('https://pot.test/projects/project-a/routines?run_limit=101'), env)
    expect(invalid.status).toBe(400)
    expect(await invalid.text()).toContain('Choose a valid routine history page.')
  })

  it('allows a responsible writable-squad member to Run now only with a server-minted nonce and redirects after success', async () => {
    harness = makeHarness()
    authState.current = member()
    const env = envFor(harness)
    const page = await dashboardApp.fetch(new Request('https://pot.test/projects/project-a/routines'), env)
    const body = await page.text()

    const missing = await dashboardApp.fetch(post('/projects/project-a/routines/routine-enabled/run', {}), env)
    expect(missing.status).toBe(400)
    expect(await missing.text()).toContain('invalid_nonce')

    const response = await dashboardApp.fetch(post('/projects/project-a/routines/routine-enabled/run', {
      nonce: nonce(body, 'routine-enabled'),
    }), env)
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toContain('/projects/project-a/routines?status=run_queued')
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS count FROM routine_runs WHERE routine_id = 'routine-enabled'").get())
      .toMatchObject({ count: 3 })
  })

  it('keeps lifecycle controls to workspace admins and preserves stable validation errors on failed writes', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    authState.current = member()
    expect((await dashboardApp.fetch(post('/projects/project-a/routines/run-waiting/cancel', {}), env)).status).toBe(403)
    expect((await dashboardApp.fetch(post('/projects/project-a/routines', {
      name: 'Nope', objective: 'Nope', trigger_kind: 'manual', timezone: 'UTC', overlap_policy: 'skip', execution_mode: 'propose',
      responsible_squad_id: 'squad-a', budget_micro_usd: '0', max_attempts: '3', retry_backoff_seconds: '300',
    }), env)).status).toBe(403)

    authState.current = actor({ role: 'owner' })
    const failed = await dashboardApp.fetch(post('/projects/project-a/routines/routine-draft/enable', {}), env)
    expect(failed.status).toBe(303)
    const validation = await dashboardApp.fetch(post('/projects/project-a/routines', {
      name: '', objective: 'Missing name', trigger_kind: 'manual', timezone: 'UTC', overlap_policy: 'skip', execution_mode: 'propose',
      responsible_squad_id: 'squad-a', budget_micro_usd: '0', max_attempts: '3', retry_backoff_seconds: '300',
    }), env)
    expect(validation.status).toBe(400)
    expect(await validation.text()).toContain('invalid_name')
  })
})
