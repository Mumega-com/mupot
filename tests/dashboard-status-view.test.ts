import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const { dashboardApp } = await import('../src/dashboard')
const visibility = await import('../src/tasks/visibility')

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')
const SHA = 'abcdef0123456789abcdef0123456789abcdef01'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
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
      ('hid-p0', 'squad-b', 'SECRET hidden P0', '', 'x', 'open', 'P0', NULL, '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z'),
      ('hid-blk', 'squad-b', 'SECRET hidden blocked', '', 'x', 'blocked', 'P1', 'secret reason', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
    INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status, created_at)
      VALUES ('arch-a', datetime('now'), 'test', 'member-a', 'open', datetime('now'));
  `)
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

  it('renders ranked sections, counts, and the build sha, with no store caching', async () => {
    harness = makeHarness()
    authState.current = member()
    const res = await dashboardApp.fetch(new Request('https://pot.test/status'), envFor(harness))
    const body = await res.text()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect(body).toContain('Fix prod outage')
    expect(body).toContain('Building thing')
    expect(body).toContain('waiting on vendor key')
    expect(body).toContain('Review me')
    expect(body).not.toContain('Low priority open')
    expect(body).not.toContain('Archived P0')
    expect(body.indexOf('Fix prod outage')).toBeLessThan(body.indexOf('Tidy'))
    expect(body).toContain('Build abcdef01')
    expect(body).toContain('href="/status"')
    expect(body).toMatch(/<b>1<\/b> P0/)
  })

  it('goes through the shared visibility chokepoint and never renders rows the viewer cannot see', async () => {
    harness = makeHarness()
    authState.current = member()
    const scopeSpy = vi.spyOn(visibility, 'resolveVisibleTaskScope')
    const clauseSpy = vi.spyOn(visibility, 'visibleTaskClause')
    const res = await dashboardApp.fetch(new Request('https://pot.test/status'), envFor(harness))
    const body = await res.text()
    expect(scopeSpy).toHaveBeenCalled()
    expect(clauseSpy).toHaveBeenCalled()
    expect(body).not.toContain('SECRET')
    expect(body).not.toContain('secret reason')
    expect(body).toMatch(/<b>1<\/b> P0/) // true count excludes the hidden squad's P0 and the archived one
    expect(body).toMatch(/<b>0<\/b> blocked|<b>1<\/b> blocked/)
    expect(body).not.toMatch(/<b>2<\/b> blocked/)
  })

  it('a viewer with no squad grant sees no task rows at all', async () => {
    harness = makeHarness()
    authState.current = { ...member(), capabilities: [] }
    const res = await dashboardApp.fetch(new Request('https://pot.test/status'), envFor(harness))
    const body = await res.text()
    expect(body).not.toContain('Fix prod outage')
    expect(body).not.toContain('SECRET')
  })

  it('escapes task text as data', async () => {
    harness = makeHarness()
    authState.current = member()
    const res = await dashboardApp.fetch(new Request('https://pot.test/status'), envFor(harness))
    const body = await res.text()
    expect(body).not.toContain('<script>alert(1)</script>')
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(body).not.toContain('<b>x</b>')
    expect(body).toContain('&lt;b&gt;x&lt;/b&gt;')
  })

  it('reads tasks in one batched round trip', async () => {
    harness = makeHarness()
    authState.current = member()
    const env = envFor(harness)
    const batchSpy = vi.spyOn(env.DB, 'batch')
    await dashboardApp.fetch(new Request('https://pot.test/status'), env)
    expect(batchSpy).toHaveBeenCalledTimes(1)
  })
})
