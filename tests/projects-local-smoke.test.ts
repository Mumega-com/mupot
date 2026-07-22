import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'

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

const { projectsApp } = await import('../src/projects')
const { invokeTool } = await import('../src/mcp')
const { loadProjectDetail, projectDetailBody } = await import('../src/dashboard/projects')
const { getFleetAgentRuntimeStates } = await import('../src/fleet/registry')

const projectApi = new Hono<{ Bindings: Env }>()
projectApi.route('/api/projects', projectsApp)

const REPO_ROOT = join(__dirname, '..')
const MIGRATIONS_DIR = join(REPO_ROOT, 'migrations')
const SEED_PATH = join(REPO_ROOT, 'scripts', 'local-test-seed.sql')
const BROWSER_SMOKE_PATH = join(REPO_ROOT, 'scripts', 'local-browser-smoke.mjs')
const EVIDENCE_DRIVER_PATH = join(REPO_ROOT, 'scripts', 'ci-local-evidence.sh')
const README_PATH = join(REPO_ROOT, 'README.md')

function createSeededDatabase() {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(readFileSync(SEED_PATH, 'utf8'))
  return harness
}

function owner(): AuthContext {
  return {
    userId: 'usr-local-owner',
    memberId: 'mbr-local-admin',
    email: 'local-owner@mupot.test',
    role: 'owner',
    tenant: 'local',
  }
}

function envFor(harness: ReturnType<typeof createSeededDatabase>): Env {
  return { DB: harness.db, TENANT_SLUG: 'local', BRAND: 'Mupot' } as Env
}

describe('local project workspace showcase', () => {
  afterEach(() => {
    authState.current = null
  })

  it('seeds the signed inbox fence required by runtime conformance after browser evidence', () => {
    const harness = createSeededDatabase()
    try {
      const fence = harness.sqlite.prepare(`
        SELECT mode, generation, key_fingerprint, updated_by_member_id, reason
        FROM agent_inbox_fences
        WHERE tenant = 'local' AND agent_id = 'agent-conformance'
      `).get() as {
        mode: string
        generation: number
        key_fingerprint: string
        updated_by_member_id: string
        reason: string
      } | undefined
      const runtimeKey = harness.sqlite.prepare(`
        SELECT pubkey
        FROM agent_keys
        WHERE tenant = 'local' AND agent_id = 'agent-conformance'
      `).get() as { pubkey: string } | undefined

      if (!fence || !runtimeKey) throw new Error('local runtime conformance fixture is incomplete')

      const fingerprint = createHash('sha256').update(runtimeKey.pubkey).digest('hex')
      expect(fingerprint).toBe('6d4c5cc496a08ce3785f212e13b532c1fc7ee98a905c3d55debb48b1d13f690e')

      expect(fence).toEqual({
        mode: 'signed_only',
        generation: 1,
        key_fingerprint: fingerprint,
        updated_by_member_id: 'mbr-conformance-runtime',
        reason: expect.any(String),
      })
      expect(fence.reason).not.toHaveLength(0)
    } finally {
      harness.close()
    }
  })

  it('seeds the exact Mumega root and child portfolio', () => {
    const harness = createSeededDatabase()
    try {
      const projects = harness.sqlite.prepare(`
        SELECT id, name, parent_project_id
        FROM projects
        ORDER BY id
      `).all()

      expect(projects).toEqual([
        { id: 'project-inkwell', name: 'Inkwell', parent_project_id: 'project-mumega-products' },
        { id: 'project-marketing-infrastructure', name: 'Marketing Infrastructure', parent_project_id: null },
        { id: 'project-mcpwp', name: 'MCPWP', parent_project_id: 'project-marketing-infrastructure' },
        { id: 'project-mirror', name: 'Mirror', parent_project_id: 'project-mumega-products' },
        { id: 'project-mumcp', name: 'MumCP', parent_project_id: 'project-marketing-infrastructure' },
        { id: 'project-mumega-products', name: 'Mumega Products', parent_project_id: null },
        { id: 'project-mupot', name: 'Mupot', parent_project_id: 'project-mumega-products' },
        { id: 'project-sos', name: 'SOS', parent_project_id: 'project-mumega-products' },
      ])
    } finally {
      harness.close()
    }
  })

  it('keeps the canonical receipt fixture stable across two seeds and removes superseded fleet keys', () => {
    const harness = createSeededDatabase()
    try {
      const snapshot = () => ({
        projects: harness.sqlite.prepare('SELECT COUNT(*) AS count FROM projects').get(),
        localTasks: harness.sqlite.prepare("SELECT COUNT(*) AS count FROM tasks WHERE id LIKE 'task-%-local'").get(),
        localFlights: harness.sqlite.prepare("SELECT COUNT(*) AS count FROM flights WHERE id LIKE 'flight-%-local'").get(),
        fleet: harness.sqlite.prepare(`
          SELECT agent_id, runtime, status, reported_by
          FROM fleet_agents
          WHERE tenant = 'local'
          ORDER BY agent_id
        `).all(),
      })
      const firstSeed = snapshot()
      harness.sqlite.exec(`
        INSERT INTO fleet_agents
          (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, last_reported_at, updated_at)
        VALUES
          ('hermes-local', 'local', 'Superseded Hermes', 'hermes-cron', '[]', 'always_on', 'running', 'local-seed', datetime('now'), datetime('now')),
          ('codex-local', 'local', 'Superseded Codex', 'codex', '[]', 'on_demand', 'stopped', 'local-seed', datetime('now'), datetime('now'));
      `)

      expect(() => harness.sqlite.exec(readFileSync(SEED_PATH, 'utf8'))).not.toThrow()
      expect(snapshot()).toEqual(firstSeed)
      expect(firstSeed).toEqual({
        projects: { count: 8 },
        localTasks: { count: 5 },
        localFlights: { count: 3 },
        fleet: [
          { agent_id: 'agent-conformance', runtime: 'systemd-user', status: 'running', reported_by: 'local-seed' },
          { agent_id: 'agent-growth', runtime: 'codex', status: 'stopped', reported_by: 'local-seed' },
          { agent_id: 'agent-hermes', runtime: 'hermes-cron', status: 'running', reported_by: 'local-seed' },
        ],
      })

      expect(harness.sqlite.prepare(`
        SELECT id FROM projects WHERE parent_project_id IS NULL ORDER BY id
      `).all()).toEqual([
        { id: 'project-marketing-infrastructure' },
        { id: 'project-mumega-products' },
      ])
      expect(harness.sqlite.prepare(`
        WITH RECURSIVE project_depth(id, depth) AS (
          SELECT id, 0 FROM projects WHERE parent_project_id IS NULL
          UNION ALL
          SELECT child.id, parent.depth + 1
          FROM projects child
          JOIN project_depth parent ON child.parent_project_id = parent.id
        )
        SELECT COUNT(*) AS count FROM project_depth WHERE depth > 1
      `).get()).toEqual({ count: 0 })
      expect(harness.sqlite.prepare(`
        SELECT project_id, squad_id, access_level
        FROM project_squad_access
        ORDER BY project_id
      `).all()).toEqual([
        { project_id: 'project-inkwell', squad_id: 'sq-growth', access_level: 'write' },
        { project_id: 'project-marketing-infrastructure', squad_id: 'sq-growth', access_level: 'write' },
        { project_id: 'project-mcpwp', squad_id: 'sq-growth', access_level: 'write' },
        { project_id: 'project-mirror', squad_id: 'sq-growth', access_level: 'write' },
        { project_id: 'project-mumcp', squad_id: 'sq-growth', access_level: 'write' },
        { project_id: 'project-mumega-products', squad_id: 'sq-growth', access_level: 'write' },
        { project_id: 'project-mupot', squad_id: 'sq-growth', access_level: 'write' },
        { project_id: 'project-sos', squad_id: 'sq-growth', access_level: 'write' },
      ])
    } finally {
      harness.close()
    }
  })

  it('attributes representative governed work to Mupot and preserves nullable legacy rows', () => {
    const harness = createSeededDatabase()
    try {
      expect(harness.sqlite.prepare(`
        SELECT id, project_id FROM tasks
        WHERE id LIKE 'task-%-local'
        ORDER BY id
      `).all()).toEqual([
        { id: 'task-blocked-local', project_id: 'project-mupot' },
        { id: 'task-done-local', project_id: 'project-mupot' },
        { id: 'task-open-local', project_id: null },
        { id: 'task-progress-local', project_id: 'project-mupot' },
        { id: 'task-review-local', project_id: 'project-mupot' },
      ])
      const flights = harness.sqlite.prepare(`
        SELECT id, project_id, meta FROM flights
        WHERE id LIKE 'flight-%-local'
        ORDER BY id
      `).all() as Array<{ id: string; project_id: string | null; meta: string }>
      expect(flights.map(({ id, project_id }) => ({ id, project_id }))).toEqual([
        { id: 'flight-landed-local', project_id: 'project-mupot' },
        { id: 'flight-running-local', project_id: 'project-mupot' },
        { id: 'flight-sleeping-local', project_id: null },
      ])
      expect(flights.filter((flight) => flight.project_id === 'project-mupot').map((flight) => {
        const meta = JSON.parse(flight.meta) as { schema: string; task_ids: string[] }
        return { id: flight.id, schema: meta.schema, task_ids: meta.task_ids }
      })).toEqual([
        {
          id: 'flight-landed-local',
          schema: 'mupot.flight.meta/v1',
          task_ids: ['task-done-local'],
        },
        {
          id: 'flight-running-local',
          schema: 'mupot.flight.meta/v1',
          task_ids: ['task-progress-local'],
        },
      ])
    } finally {
      harness.close()
    }
  })

  it('seeds full Mupot situation parity across REST, MCP, and the dashboard', async () => {
    const harness = createSeededDatabase()
    try {
      expect(harness.sqlite.prepare(`
        SELECT id, status, project_id
        FROM tasks
        WHERE project_id = 'project-mupot'
        ORDER BY id
      `).all()).toEqual([
        { id: 'task-blocked-local', status: 'blocked', project_id: 'project-mupot' },
        { id: 'task-done-local', status: 'done', project_id: 'project-mupot' },
        { id: 'task-progress-local', status: 'in_progress', project_id: 'project-mupot' },
        { id: 'task-review-local', status: 'review', project_id: 'project-mupot' },
      ])

      const env = envFor(harness)
      const auth = owner()
      authState.current = auth

      const restResponse = await projectApi.fetch(
        new Request('https://pot.test/api/projects/project-mupot'),
        env,
      )
      expect(restResponse.status).toBe(200)
      const rest = await restResponse.json() as { situation: unknown }

      const mcp = await invokeTool(auth, env, 'project_get', { project_id: 'project-mupot' }, 'https://pot.test')
      expect(mcp.ok).toBe(true)
      const mcpSituation = (mcp.result as { situation: unknown }).situation

      const dashboard = await loadProjectDetail(env, auth, 'project-mupot')
      expect(dashboard).not.toBeNull()
      expect(dashboard?.situation).toEqual(rest.situation)
      expect(mcpSituation).toEqual(rest.situation)
      expect(rest.situation).toMatchObject({
        health: 'blocked',
        blockers: [{ id: 'task-blocked-local' }],
        pending_reviews: [{ id: 'task-review-local' }],
        task_counts: { blocked: 1, review: 1, in_progress: 1, open: 0 },
        active_work_count: 3,
        active_flight_count: 1,
        next_action: { type: 'review_task', task: { id: 'task-review-local' } },
      })
      const rendered = String(await projectDetailBody(dashboard!))
      expect(rendered).toContain('blocked')
      expect(rendered).toContain('Review &quot;Review local approval task&quot;')

      const runtimeStates = await getFleetAgentRuntimeStates(env, [
        { agent_id: 'agent-hermes', slug: 'hermes' },
        { agent_id: 'agent-growth', slug: 'growth-lead' },
        { agent_id: 'agent-conformance', slug: 'runtime-conformance' },
      ], Date.now())
      expect([...runtimeStates.entries()]).toEqual(expect.arrayContaining([
        ['agent-hermes', expect.objectContaining({ presence: 'live', status: 'running' })],
        ['agent-growth', expect.objectContaining({ presence: 'offline', status: 'stopped' })],
        ['agent-conformance', expect.objectContaining({ presence: 'stale', status: 'running' })],
      ]))
    } finally {
      harness.close()
    }
  })

  it('gives a no-edge org observer the same complete situation across REST, MCP, and dashboard', async () => {
    const harness = createSeededDatabase()
    try {
      harness.sqlite.exec(`
        INSERT INTO projects (id, slug, name, status)
        VALUES ('project-org-observer', 'project-org-observer', 'Org observer project', 'active');
      `)
      const env = envFor(harness)
      const auth: AuthContext = {
        userId: 'usr-org-observer',
        memberId: 'mbr-org-observer',
        email: 'org-observer@mupot.test',
        role: 'member',
        tenant: 'local',
        capabilities: [{
          member_id: 'mbr-org-observer',
          scope_type: 'org',
          scope_id: null,
          capability: 'observer',
        }],
      }
      authState.current = auth

      const restResponse = await projectApi.fetch(
        new Request('https://pot.test/api/projects/project-org-observer'),
        env,
      )
      expect(restResponse.status).toBe(200)
      const rest = await restResponse.json() as { situation: unknown }

      const mcp = await invokeTool(
        auth,
        env,
        'project_get',
        { project_id: 'project-org-observer' },
        'https://pot.test',
      )
      expect(mcp.ok).toBe(true)
      const mcpSituation = (mcp.result as { situation: unknown }).situation

      const dashboard = await loadProjectDetail(env, auth, 'project-org-observer')
      expect(dashboard).not.toBeNull()
      expect(dashboard?.situation).toEqual(rest.situation)
      expect(mcpSituation).toEqual(rest.situation)
      expect(rest.situation).toMatchObject({
        health: 'ready',
        blockers: [],
        pending_reviews: [],
        active_work_count: 0,
        active_flight_count: 0,
        latest_activity: null,
        next_action: { type: 'create_task' },
      })
    } finally {
      harness.close()
    }
  })

  it('keeps the complete Project Link situation equal across surfaces at the stale boundary', async () => {
    const harness = createSeededDatabase()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-19T10:00:30.001Z'))
    try {
      harness.sqlite.exec(`
        INSERT INTO projects (id, slug, name, status)
        VALUES ('project-link-boundary', 'project-link-boundary', 'Project Link boundary', 'active');
        INSERT INTO project_squad_access (project_id, squad_id, access_level)
        VALUES ('project-link-boundary', 'sq-growth', 'write');
        INSERT INTO project_links (
          id, tenant, local_project_id, local_squad_id, local_agent_id, local_key_id,
          remote_pot, remote_project_id, remote_link_id, remote_agent_id, remote_key_id,
          remote_public_key, remote_base_url, capabilities_json, evidence_origins_json,
          state, stale_after_seconds, last_success_at, created_by, created_at
        ) VALUES (
          'link-boundary', 'local', 'project-link-boundary', 'sq-growth', 'agent-hermes', 'local-key',
          'remote-pot', 'remote-project', 'remote-link', 'remote-agent', 'remote-key',
          'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'https://remote.example/',
          '["project.task.write"]', '[]', 'active', 30, '2026-07-19T10:00:00Z',
          'mbr-local-admin', '2026-07-19T09:00:00Z'
        );
      `)
      const env = envFor(harness)
      const auth = owner()
      authState.current = auth

      const restResponse = await projectApi.fetch(
        new Request('https://pot.test/api/projects/project-link-boundary'),
        env,
      )
      expect(restResponse.status).toBe(200)
      const rest = await restResponse.json() as { situation: unknown }

      const mcp = await invokeTool(
        auth,
        env,
        'project_get',
        { project_id: 'project-link-boundary' },
        'https://pot.test',
      )
      expect(mcp.ok).toBe(true)
      const mcpSituation = (mcp.result as { situation: unknown }).situation

      const dashboard = await loadProjectDetail(env, auth, 'project-link-boundary')
      expect(dashboard).not.toBeNull()
      expect(dashboard?.situation).toEqual(rest.situation)
      expect(mcpSituation).toEqual(rest.situation)
      expect(rest.situation).toMatchObject({
        latest_activity: {
          source_type: 'project_link',
          source_id: 'link-boundary',
          occurred_at: '2026-07-19T10:00:00.000Z',
          status: 'healthy',
        },
        linked_pots: [{
          link_id: 'link-boundary',
          source_pot: 'remote-pot',
          health: 'stale',
          last_synchronized_at: '2026-07-19T10:00:00Z',
          agent_presence: 'unknown',
        }],
      })

      const activityResponse = await projectApi.fetch(
        new Request('https://pot.test/api/projects/project-link-boundary/activity'),
        env,
      )
      expect(activityResponse.status).toBe(200)
      const restActivity = await activityResponse.json() as { rows: unknown[] }
      expect(dashboard?.activity.rows).toEqual(restActivity.rows)
    } finally {
      vi.useRealTimers()
      harness.close()
    }
  })

  it('keeps the browser crawl and adds desktop and mobile project workspace checks', () => {
    const smoke = readFileSync(BROWSER_SMOKE_PATH, 'utf8')
    const evidenceDriver = readFileSync(EVIDENCE_DRIVER_PATH, 'utf8')

    expect(smoke).toContain("'/projects'")
    expect(smoke).toContain("'/projects/project-mupot'")
    expect(smoke).toContain('Mumega Products')
    expect(smoke).toContain('Marketing Infrastructure')
    expect(smoke).toContain('/send?project_id=project-mupot')
    expect(smoke).toContain('/flights?project_id=project-mupot')
    expect(smoke).toContain("['Home', 'Projects', 'Work', 'Approvals']")
    expect(smoke).toContain('width: 390, height: 844')
    expect(smoke).toMatch(/scrollWidth\s*-\s*document\.documentElement\.clientWidth/)
    expect(smoke).toContain('await runProjectWorkspaceWorkflow()')
    expect(smoke).toContain('project-situation-json')
    expect(smoke).toContain("'complete', 'completed'")
    expect(smoke).toContain('observedPersistedStatus')
    expect(smoke).toContain('surfaceParity')
    expect(evidenceDriver).toContain('mktemp -d')
    expect(evidenceDriver.match(/--persist-to/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('documents the pot and bounded project model without coupling Mupot to SOS', () => {
    const readme = readFileSync(README_PATH, 'utf8')

    expect(readme).toContain('## Pots and projects')
    expect(readme).toMatch(/one child level/i)
    expect(readme).toMatch(/provider-neutral/i)
    expect(readme).toMatch(/SOS is not (?:a|an) (?:runtime|architecture|architectural) dependency/i)
    expect(readme).toContain('npm test -- tests/projects-local-smoke.test.ts')
    expect(readme).toContain('npm run seed:local:test')
  })
})
