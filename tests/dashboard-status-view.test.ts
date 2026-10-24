import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
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

const { dashboardApp } = await import('../src/dashboard')
const visibility = await import('../src/tasks/visibility')
await import('../src/mcp') // load the MCP registry first: flight-spine imports it cyclically
const flightSpine = await import('../src/mcp/flight-spine')

const SHA = 'abcdef0123456789abcdef0123456789abcdef01'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'delivery', 'Delivery'), ('dept-b', 'secret', 'Secret');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'alpha', 'Alpha'), ('squad-b', 'dept-b', 'beta', 'Beta');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('member-a', 'a@example.test', 'Member A', 'active', 'tenant-a');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-a', 'member-a', 'squad', 'squad-a', 'member');
    INSERT INTO tasks (id, squad_id, title, body, done_when, status, priority, result, created_at, updated_at) VALUES
      ('p0-a', 'squad-a', 'Fix prod outage', '', 'Prod green', 'open', 'P0', NULL, '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z'),
      ('p1-a', 'squad-a', 'Tidy <script>alert(1)</script> & co', '', 'Done "quoted" <b>x</b>', 'open', 'P1', NULL, '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z'),
      ('p3-a', 'squad-a', 'Low priority open', '', 'x', 'open', 'P3', NULL, '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z'),
      ('prog-a', 'squad-a', 'Building thing', '', 'Built', 'in_progress', 'P2', NULL, '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z'),
      ('blk-a', 'squad-a', 'Stuck thing', '', 'Unstuck', 'blocked', 'P2', 'waiting on vendor key', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z'),
      ('rev-a', 'squad-a', 'Review me', '', 'Reviewed', 'review', 'P2', NULL, '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z'),
      ('arch-a', 'squad-a', 'Archived P0', '', 'x', 'open', 'P0', NULL, '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z'),
      ('hid-p0', 'squad-b', 'HIDDENROW hidden P0', '', 'x', 'open', 'P0', NULL, '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z'),
      ('hid-blk', 'squad-b', 'HIDDENROW hidden blocked', '', 'x', 'blocked', 'P1', 'secret reason', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('ag-a', 'squad-a', 'ag-a', 'OWNER<i>evil</i>', 'inactive'), ('ag-b', 'squad-b', 'ag-b', 'HIDDENROWAGENT', 'inactive');
    INSERT INTO projects (id, slug, name, status) VALUES ('proj-a', 'proj-a', 'PROJ<u>evil</u>', 'active'), ('proj-b', 'proj-b', 'HIDDENROWPROJ', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('proj-a', 'squad-a', 'write'), ('proj-b', 'squad-b', 'write');
    INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('gg-a', 'gate:content', 'member', 'member-a', 'owner', '2026-07-01T00:00:00.000Z');
    INSERT INTO tasks (id, squad_id, project_id, title, body, done_when, status, priority, gate_owner, assignee_agent_id, result, created_at, updated_at) VALUES
      ('need-a', 'squad-a', 'proj-a', 'NEED<em>mine</em>', '', 'ok', 'review', 'P2', 'gate:content', NULL, NULL, '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z'),
      ('need-b', 'squad-b', 'proj-b', 'HIDDENROW needs-you row', '', 'ok', 'review', 'P2', 'gate:content', NULL, NULL, '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z'),
      ('blk-h', 'squad-a', 'proj-a', 'Hostile blocked', '', 'ok', 'blocked', 'P2', NULL, 'ag-a', 'REASON<s>evil</s>', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('member-z', 'z@example.test', 'Member Z', 'active', 'tenant-a');
    INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('gg-z', 'gate:other', 'member', 'member-z', 'owner', '2026-07-01T00:00:00.000Z');
    INSERT INTO tasks (id, squad_id, project_id, title, body, done_when, status, priority, gate_owner, created_at, updated_at) VALUES
      ('need-z', 'squad-a', 'proj-a', 'OTHERGATE row', '', 'ok', 'review', 'P2', 'gate:other', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
    INSERT INTO tasks (id, squad_id, title, body, done_when, status, priority, created_at, updated_at) VALUES
      ('blk-long', 'squad-a', 'Long blocked', '${'x'.repeat(300)}TAILREASON', 'ok', 'blocked', 'P2', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
    INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status, created_at)
      VALUES ('arch-a', datetime('now'), 'test', 'member-a', 'open', datetime('now'));
  `)
  const fl = (id: string, agent: string, goal: string, squad: string, status: string, at: number) =>
    harness.sqlite.prepare('INSERT INTO flights (id, tenant, agent, goal, status, meta, created_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, 'tenant-a', agent, goal, status, JSON.stringify({
        schema: 'mupot.flight.meta/v1', goal_id: 'g', objective_id: 'o', squad_ids: [squad], task_ids: ['t'], done_when: ['d'],
        artifact_refs: [], receipt_refs: [], confidentiality: 'internal', publication_target: 'none', parent_flight_id: null,
      }), at, at)
  fl('fl-a', 'ag-a', 'GOAL<blink>a</blink>', 'squad-a', 'running', 1000)
  fl('fl-b', 'ag-b', 'HIDDENROW flight goal', 'squad-b', 'running', 2000)
  fl('fl-done', 'ag-a', 'Landed flight', 'squad-a', 'landed', 3000)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: 'tenant-a', BRAND: 'Mupot', RELEASE_SHA: SHA } as unknown as Env
}

function member(): AuthContext {
  return {
    userId: 'member-a', memberId: 'member-a', email: null, role: 'member', tenant: 'tenant-a',
    capabilities: [{ member_id: 'member-a', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' }],
  }
}

describe('GET /status board status page', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    vi.restoreAllMocks()
    authState.current = null
    harness?.close()
    harness = undefined
  })

  it('requires the dashboard session', async () => {
    harness = makeHarness()
    const res = await dashboardApp.fetch(new Request('https://pot.test/status'), envFor(harness))
    expect([302, 401]).toContain(res.status) // unauthenticated: login redirect or 401, never the page
    expect(await res.text()).not.toContain('Fix prod outage')
  })

  const fetchStatus = async (auth: AuthContext) => {
    harness = makeHarness()
    authState.current = auth
    const res = await dashboardApp.fetch(new Request('https://pot.test/status'), envFor(harness))
    return { res, body: await res.text() }
  }
  const chipCount = (body: string, label: string) => body.match(new RegExp(`<b>(\\d+)</b> ${label}`))?.[1]

  it('renders ranked sections, exact counts, and the build sha, with no store caching', async () => {
    const { res, body } = await fetchStatus(member())
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store') // final header, set by the dashboard-wide middleware
    expect(body).toContain('Fix prod outage')
    expect(body).toContain('Building thing')
    expect(body).toContain('waiting on vendor key')
    expect(body).toContain('Review me')
    expect(body).not.toContain('Low priority open')
    expect(body).not.toContain('Archived P0')
    expect(body.indexOf('Fix prod outage')).toBeLessThan(body.indexOf('Tidy'))
    expect(body).toContain('Build abcdef01')
    expect(body).toContain('href="/status"')
    expect(chipCount(body, 'P0')).toBe('1')
    expect(chipCount(body, 'P1')).toBe('1')
    expect(chipCount(body, 'in progress')).toBe('1')
    expect(chipCount(body, 'blocked')).toBe('3')
    expect(chipCount(body, 'in review')).toBe('3')
    expect(chipCount(body, 'flights')).toBe('1')
    expect(chipCount(body, 'need you')).toBe('1')
    expect(body).toContain('Open P0 / P1 <span class="sv-n">2</span>')
    expect(body).toContain('Running flights <span class="sv-n">1</span>')
    expect(body).toContain('GOAL&lt;blink&gt;')
    expect(body).not.toContain('Landed flight')
    expect(body).toContain('TAILREASON')
  })

  it('goes through the shared visibility chokepoints and never renders rows the viewer cannot see', async () => {
    harness = makeHarness()
    authState.current = member()
    const scopeSpy = vi.spyOn(visibility, 'resolveVisibleTaskScope')
    const clauseSpy = vi.spyOn(visibility, 'visibleTaskClause')
    const flightSpy = vi.spyOn(flightSpine, 'visibleFlight')
    const res = await dashboardApp.fetch(new Request('https://pot.test/status'), envFor(harness))
    const body = await res.text()
    expect(scopeSpy).toHaveBeenCalled()
    expect(clauseSpy).toHaveBeenCalled()
    expect(flightSpy).toHaveBeenCalled()
    expect(body).not.toContain('HIDDENROW')
    expect(body).not.toContain('secret reason')
    expect(chipCount(body, 'need you')).toBe('1') // gate:other (held by member-z) is not listed for member-a
    expect(chipCount(body, 'P0')).toBe('1')
    expect(chipCount(body, 'flights')).toBe('1')
  })

  it('a viewer granted only a DIFFERENT squad reaches the loader and sees only that squad', async () => {
    const other: AuthContext = {
      ...member(),
      capabilities: [{ member_id: 'member-a', scope_type: 'squad', scope_id: 'squad-b', capability: 'member' }],
    }
    const { res, body } = await fetchStatus(other)
    expect(res.status).toBe(200)
    expect(body).toContain('HIDDENROW hidden P0')
    expect(body).toContain('HIDDENROW flight goal')
    expect(body).not.toContain('Fix prod outage')
    expect(body).not.toContain('GOAL')
    expect(body).not.toContain('NEED')
    expect(chipCount(body, 'flights')).toBe('1')
  })

  it('escapes task text, reason, owner, project, needs-you title, flight goal and agent as data', async () => {
    const { body } = await fetchStatus(member())
    for (const raw of ['<script>alert(1)</script>', '<b>x</b>', '<s>evil</s>', '<i>evil</i>', '<u>evil</u>', '<em>mine</em>', '<blink>a</blink>']) {
      expect(body).not.toContain(raw)
    }
    for (const esc of ['&lt;script&gt;alert(1)&lt;/script&gt;', '&lt;b&gt;x&lt;/b&gt;', 'REASON&lt;s&gt;', 'OWNER&lt;i&gt;', 'PROJ&lt;u&gt;', 'NEED&lt;em&gt;', 'GOAL&lt;blink&gt;']) {
      expect(body).toContain(esc)
    }
  })

  it('caps each section at 40 rows but keeps true counts', async () => {
    harness = makeHarness()
    for (let i = 0; i < 45; i++) {
      harness.sqlite.prepare(`INSERT INTO tasks (id, squad_id, title, body, done_when, status, priority, created_at, updated_at)
        VALUES (?, 'squad-a', ?, '', 'x', 'in_progress', 'P2', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z')`).run(`bulk-${i}`, `BULK${i}`)
    }
    for (let i = 0; i < 45; i++) {
      harness.sqlite.prepare(`INSERT INTO tasks (id, squad_id, title, body, done_when, status, priority, created_at, updated_at)
        VALUES (?, 'squad-a', ?, '', 'x', 'open', 'P1', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z')`).run(`openp1-${i}`, `OPENP1-${i}`)
    }
    authState.current = member()
    const body = await (await dashboardApp.fetch(new Request('https://pot.test/status'), envFor(harness))).text()
    expect(chipCount(body, 'in progress')).toBe('46')
    expect(body).toContain('Open P0 / P1 <span class="sv-n">47</span>') // true count, not the 40 rows shown
    expect((body.match(/BULK\d+/g) ?? []).length).toBe(40)
  })

  it('degrades one section when a reader throws instead of 500ing the page', async () => {
    harness = makeHarness()
    authState.current = member()
    const env = envFor(harness)
    const realBatch = env.DB.batch.bind(env.DB)
    // fail only the status page's own two-statement task batch
    vi.spyOn(env.DB, 'batch').mockImplementation(async (stmts) => {
      if (stmts.length === 2) throw new Error('boom')
      return realBatch(stmts)
    })
    const res = await dashboardApp.fetch(new Request('https://pot.test/status'), env)
    const body = await res.text()
    expect(res.status).toBe(200)
    expect(body).toContain('Unavailable')
    expect(body).toContain('GOAL&lt;blink&gt;') // flights still render
    expect(body).toContain('NEED&lt;em&gt;') // needs-you still renders
  })

  it('shows "more" instead of "All clear" when needs-you is truncated', async () => {
    harness = makeHarness()
    authState.current = member()
    harness.sqlite.exec("DELETE FROM tasks WHERE gate_owner IS NOT NULL")
    const needs = await import('../src/dashboard/needs-you')
    vi.spyOn(needs, 'loadNeedsYouDashboard').mockResolvedValue({ items: [], nextCursor: 'abc', truncated: true, truncatedSources: ['task'] })
    const body = await (await dashboardApp.fetch(new Request('https://pot.test/status'), envFor(harness))).text()
    expect(body).toContain('More items waiting')
  })

  it('runs the task batch, needs-you and flights concurrently', async () => {
    harness = makeHarness()
    authState.current = member()
    const env = envFor(harness)
    const realBatch = env.DB.batch.bind(env.DB)
    const realPrepare = env.DB.prepare.bind(env.DB)
    let pending = false
    let overlapped = false
    vi.spyOn(env.DB, 'prepare').mockImplementation((q: string) => {
      if (pending && (q.includes('FROM flights') || q.includes('gate_grants'))) overlapped = true // a sibling reader started mid-batch
      return realPrepare(q)
    })
    vi.spyOn(env.DB, 'batch').mockImplementation(async (stmts) => {
      pending = true
      await new Promise((r) => setTimeout(r, 100)) // give concurrent readers a macrotask to start
      pending = false
      return realBatch(stmts)
    })
    await dashboardApp.fetch(new Request('https://pot.test/status'), env)
    expect(overlapped).toBe(true)
  })

  it('reads tasks in one batched round trip', async () => {
    harness = makeHarness()
    authState.current = member()
    const env = envFor(harness)
    const batchSpy = vi.spyOn(env.DB, 'batch')
    await dashboardApp.fetch(new Request('https://pot.test/status'), env)
    expect(batchSpy.mock.calls.filter(([stmts]) => stmts.length === 2)).toHaveLength(1)
  })
})
