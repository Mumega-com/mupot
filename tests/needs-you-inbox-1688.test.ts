// mupot#1688 — Needs You is an INBOX: only what the viewer can act on, human gates only,
// live work only, honest urgency, stale items grouped. Real migration chain throughout.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import {
  listNeedsYou, NEEDS_YOU_AGE_BUMP_DAYS, NEEDS_YOU_STALE_DAYS, type NeedsYouPage,
} from '../src/attention/service'
import { routinePrincipal } from '../src/routines/access'
import { loadNeedsYouDashboard } from '../src/dashboard/needs-you'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')
const SRC_DIR = join(import.meta.dirname, '..', 'src')
const NOW = '2026-10-06T12:00:00.000Z'

function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * 86_400_000).toISOString()
}

function sessions() {
  const rows = new Map<string, string>()
  return {
    async get<T = string>(key: string, type?: 'text' | 'json'): Promise<T | null> {
      const value = rows.get(key)
      if (value === undefined) return null
      return (type === 'json' ? JSON.parse(value) : value) as T
    },
    async put(key: string, value: string): Promise<void> { rows.set(key, value) },
    async delete(key: string): Promise<void> { rows.delete(key) },
  }
}

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery'), ('dept-2', 'secret', 'Secret');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('squad-a', 'dept-1', 'alpha', 'Alpha'),
      ('squad-c', 'dept-2', 'charlie', 'Charlie');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('viewer', 'viewer@example.test', 'Viewer', 'active', 'tenant-a'),
      ('holder', 'holder@example.test', 'Other human holder', 'active', 'tenant-a'),
      ('owner-admin', 'owner@example.test', 'Owner', 'active', 'tenant-a');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-viewer', 'viewer', 'squad', 'squad-a', 'member'),
      ('cap-holder', 'holder', 'org', NULL, 'member');
    INSERT INTO agents (id, squad_id, slug, name, status, owner_member_id) VALUES
      ('agent-plain', 'squad-a', 'agent-plain', 'Plain agent', 'active', 'holder'),
      ('agent-viewers', 'squad-a', 'agent-viewers', 'Viewer-owned agent', 'active', 'viewer');
    INSERT INTO projects (id, slug, name, status) VALUES
      ('project-live', 'project-live', 'Live', 'active'),
      ('project-arch', 'project-arch', 'Archived pilot', 'active'),
      ('project-shared', 'project-shared', 'Shared with a squad the viewer cannot read', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
      ('project-live', 'squad-a', 'write'),
      ('project-arch', 'squad-a', 'write'),
      ('project-shared', 'squad-a', 'read'),
      ('project-shared', 'squad-c', 'write');
    -- Lane holders. gate:content is human-held (viewer AND holder); gate:kasra-core is held
    -- only by an agent; gate:agent-self-completion has no human lane by design.
    INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES
      ('g-viewer', 'gate:content', 'member', 'viewer', 'owner-admin', '2026-07-01T00:00:00.000Z'),
      ('g-holder', 'gate:content', 'member', 'holder', 'owner-admin', '2026-07-01T00:00:00.000Z'),
      ('g-agent', 'gate:kasra-core', 'agent', 'agent-plain', 'owner-admin', '2026-07-01T00:00:00.000Z');
  `)
  return harness
}

function insertTask(harness: SqliteD1Harness, v: {
  id: string; squad?: string; project?: string; status?: string; gate?: string | null
  assignee?: string | null; priority?: string | null; createdAt?: string
}) {
  const created = v.createdAt ?? daysAgo(0.1)
  harness.sqlite.prepare(
    `INSERT INTO tasks (id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
       gate_owner, priority, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', 'Done', ?, ?, ?, ?, ?, ?)`,
  ).run(v.id, v.squad ?? 'squad-a', v.project ?? 'project-live', v.id, v.status ?? 'review',
    v.assignee ?? 'agent-plain', v.gate === undefined ? 'gate:content' : v.gate, v.priority ?? null, created, created)
}

function archiveProject(harness: SqliteD1Harness) {
  harness.sqlite.exec("UPDATE projects SET status = 'archived' WHERE id = 'project-arch'")
}

const viewerGrants: CapabilityGrant[] = [
  { member_id: 'viewer', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' },
]

function viewerAuth(): AuthContext {
  return {
    userId: 'viewer', memberId: 'viewer', email: null, role: 'member', tenant: 'tenant-a',
    channel: 'workspace', boundAgentId: null, capabilities: viewerGrants,
  }
}

function ownerAuth(): AuthContext {
  return { userId: 'owner-admin', memberId: 'owner-admin', email: null, role: 'owner', tenant: 'tenant-a', channel: 'workspace', boundAgentId: null }
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, SESSIONS: sessions(), TENANT_SLUG: 'tenant-a' } as unknown as Env
}

async function inbox(harness: SqliteD1Harness, auth: AuthContext, options: Parameters<typeof listNeedsYou>[2] = {}): Promise<NeedsYouPage> {
  return listNeedsYou(envFor(harness), routinePrincipal(auth), { ...options, auth }, NOW)
}

describe('Needs You inbox (#1688)', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => { vi.useRealTimers(); harness?.close(); harness = undefined })

  it('gives a mixed-bag member exactly the items they can act on', async () => {
    harness = makeHarness()
    // 1 actionable human gate (P1 -> high)
    insertTask(harness, { id: 'act-human', priority: 'P1' })
    // 2 agent-gate waits (no independent human holder) — leave the owner inbox
    insertTask(harness, { id: 'agent-gate', gate: 'gate:kasra-core' })
    insertTask(harness, { id: 'agent-selfcomp', gate: 'gate:agent-self-completion' })
    // 3 archived project / archived task
    insertTask(harness, { id: 'arch-project', project: 'project-arch' })
    archiveProject(harness) // a project cannot take new access edges/tasks once archived, so archive last
    insertTask(harness, { id: 'arch-task' })
    harness.sqlite.exec(`INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status)
      VALUES ('arch-task', '2026-10-01T00:00:00.000Z', 'cleanup', 'owner-admin', 'review')`)
    // 4 affiliated owner: the viewer owns the assignee agent, holds the grant -> refused at write, so not offered
    insertTask(harness, { id: 'affiliated', assignee: 'agent-viewers' })
    // 5 invisible squad: project is visible through squad-a's edge, the task's squad is not readable
    insertTask(harness, { id: 'invisible-squad', squad: 'squad-c', project: 'project-shared' })
    // 6 old item (older than the stale window)
    insertTask(harness, { id: 'old-human', createdAt: daysAgo(40) })
    // not the viewer's gate at all
    insertTask(harness, { id: 'no-grant-lane', gate: 'gate:outreach' })

    const page = await inbox(harness, viewerAuth())
    expect(page.items.map(item => item.source_id)).toEqual(['act-human', 'old-human'])
    expect(page.items[0]).toMatchObject({ urgency: 'high', stale: false, allowed_actions: ['view', 'approve', 'reject'] })
    expect(page.items[1]).toMatchObject({ stale: true, allowed_actions: ['view', 'approve', 'reject'] })
  })

  it('shows agent-gate waits only in the admin stuck view', async () => {
    harness = makeHarness()
    insertTask(harness, { id: 'act-human' })
    insertTask(harness, { id: 'agent-gate', gate: 'gate:kasra-core' })
    insertTask(harness, { id: 'agent-selfcomp', gate: 'gate:agent-self-completion' })
    insertTask(harness, { id: 'arch-agent-gate', gate: 'gate:kasra-core', project: 'project-arch' })
    archiveProject(harness)

    const stuck = await inbox(harness, ownerAuth(), { view: 'stuck' })
    expect(stuck.items.map(item => item.source_id).sort()).toEqual(['agent-gate', 'agent-selfcomp'])
    // a non-admin never gets the stuck list
    expect((await inbox(harness, viewerAuth(), { view: 'stuck' })).items).toEqual([])
    // and the owner's default inbox does not mix them in
    const ownerInbox = await inbox(harness, ownerAuth())
    expect(ownerInbox.items.map(item => item.source_id)).toEqual(['act-human'])
  })

  it('derives urgency from priority + age + due, and groups stale items last', async () => {
    harness = makeHarness()
    const [soon, week] = NEEDS_YOU_AGE_BUMP_DAYS
    insertTask(harness, { id: 'p0', priority: 'P0' })
    insertTask(harness, { id: 'p1', priority: 'P1' })
    insertTask(harness, { id: 'plain' })
    insertTask(harness, { id: 'p3', priority: 'P3' })
    insertTask(harness, { id: 'plain-aged', createdAt: daysAgo(soon + 0.5) })
    insertTask(harness, { id: 'p3-week', priority: 'P3', createdAt: daysAgo(week + 0.5) })
    insertTask(harness, { id: 'plain-week', createdAt: daysAgo(week + 0.5) })
    insertTask(harness, { id: 'p0-stale', priority: 'P0', createdAt: daysAgo(NEEDS_YOU_STALE_DAYS + 1) })
    insertTask(harness, { id: 'plain-stale', createdAt: daysAgo(NEEDS_YOU_STALE_DAYS + 1) })

    const page = await inbox(harness, ownerAuth())
    const byId = new Map(page.items.map(item => [item.source_id, item]))
    const shape = (id: string) => ({ urgency: byId.get(id)?.urgency, stale: byId.get(id)?.stale })
    expect(shape('p0')).toEqual({ urgency: 'urgent', stale: false })
    expect(shape('p1')).toEqual({ urgency: 'high', stale: false })
    expect(shape('plain')).toEqual({ urgency: 'normal', stale: false })
    expect(shape('p3')).toEqual({ urgency: 'low', stale: false })
    expect(shape('plain-aged')).toEqual({ urgency: 'high', stale: false })
    expect(shape('p3-week')).toEqual({ urgency: 'high', stale: false })
    expect(shape('plain-week')).toEqual({ urgency: 'urgent', stale: false })
    // stale: the age bump no longer applies; priority alone; always after the live items
    expect(shape('p0-stale')).toEqual({ urgency: 'urgent', stale: true })
    expect(shape('plain-stale')).toEqual({ urgency: 'normal', stale: true })
    const order = page.items.map(item => item.source_id)
    const firstStale = page.items.findIndex(item => item.stale)
    expect(page.items.slice(0, firstStale).every(item => !item.stale)).toBe(true)
    expect(page.items.slice(firstStale).every(item => item.stale)).toBe(true)
    expect(order.slice(-2).sort()).toEqual(['p0-stale', 'plain-stale'])
  })

  it('a due project date within the window bumps urgency one level', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`UPDATE projects SET target_date = '${daysAgo(-1)}' WHERE id = 'project-live'`)
    insertTask(harness, { id: 'due-soon' })
    const page = await inbox(harness, ownerAuth())
    expect(page.items.find(item => item.source_id === 'due-soon')?.urgency).toBe('high')
  })

  it('never lists a task whose squad the viewer cannot read, even when they hold a verb on it', async () => {
    harness = makeHarness()
    // A workspace admin (org admin grant) may 'publish' an approved output, but a task in someone's
    // HOME squad is private: the task-visibility chokepoint (canReadSquadTasks) keeps it out.
    harness.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('squad-home', 'dept-1', 'home-viewer', 'Home', 'home');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-live', 'squad-home', 'write');
    `)
    harness.sqlite.prepare(
      `INSERT INTO tasks (id, squad_id, project_id, title, body, done_when, status, gate_owner, result, created_at, updated_at)
       VALUES ('home-publishable', 'squad-home', 'project-live', 'Home output', '', 'Done', 'approved', 'gate:content', 'ready', ?, ?)`,
    ).run(daysAgo(0.1), daysAgo(0.1))
    insertTask(harness, { id: 'shared-publishable', status: 'approved' })
    harness.sqlite.exec("UPDATE tasks SET result = 'ready' WHERE id = 'shared-publishable'")
    const admin: AuthContext = {
      userId: 'holder', memberId: 'holder', email: null, role: 'member', tenant: 'tenant-a', channel: 'workspace',
      boundAgentId: null,
      capabilities: [{ member_id: 'holder', scope_type: 'org', scope_id: null, capability: 'admin' }],
    }
    const page = await inbox(harness, admin)
    expect(page.items.map(item => item.source_id)).toEqual(['shared-publishable'])
  })

  // P1 (gate on #1696): the viewer filter runs after a capped SQL fetch — rows the viewer
  // cannot act on must never hide the ones they can.
  function seedNoise(h: SqliteD1Harness, count: number) {
    // 'holder' owns the assignee agent (affiliated, so not an independent holder): use a third human.
    h.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant) VALUES ('holder-x', 'hx@example.test', 'Lane X holder', 'active', 'tenant-a');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-holder-x', 'holder-x', 'org', NULL, 'member');
      INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('g-lane-x', 'gate:lane-x', 'member', 'holder-x', 'owner-admin', '2026-07-01T00:00:00.000Z')`)
    for (let index = 0; index < count; index++) {
      insertTask(h, { id: `noise-${String(index).padStart(4, '0')}`, gate: 'gate:lane-x', priority: 'P0' })
    }
  }

  it('101 non-actionable P0 approvals do not hide the one the viewer can act on', async () => {
    harness = makeHarness()
    seedNoise(harness, 101)
    insertTask(harness, { id: 'the-real-one', priority: 'P3' })
    const page = await inbox(harness, viewerAuth())
    expect(page.items.map(item => item.source_id)).toEqual(['the-real-one'])
    expect(page.truncated).toBe(false)
  })

  it('past the scan bound the actionable item is reachable via the cursor, never silently lost', async () => {
    harness = makeHarness()
    seedNoise(harness, 520)
    insertTask(harness, { id: 'the-real-one', priority: 'P3' })
    const env = envFor(harness)
    const auth = viewerAuth()
    const first = await listNeedsYou(env, routinePrincipal(auth), { auth }, NOW)
    expect(first.items).toEqual([])
    expect(first.next_cursor).toEqual(expect.any(String))
    expect(first.truncated).toBe(true)
    const second = await listNeedsYou(env, routinePrincipal(auth), { auth, after: first.next_cursor as string }, NOW)
    expect(second.items.map(item => item.source_id)).toEqual(['the-real-one'])
    expect(second.next_cursor).toBeNull()
  })

  it('stuck view is information only: a role-member org admin sees agent-gate rows, a plain member none', async () => {
    harness = makeHarness()
    insertTask(harness, { id: 'agent-gate', gate: 'gate:kasra-core' })
    insertTask(harness, { id: 'agent-selfcomp', gate: 'gate:agent-self-completion' })
    insertTask(harness, { id: 'act-human' })
    const orgAdmin: AuthContext = {
      userId: 'holder', memberId: 'holder', email: null, role: 'member', tenant: 'tenant-a', channel: 'workspace',
      boundAgentId: null,
      capabilities: [{ member_id: 'holder', scope_type: 'org', scope_id: null, capability: 'admin' }],
    }
    const stuck = await inbox(harness, orgAdmin, { view: 'stuck' })
    expect(stuck.items.map(item => item.source_id).sort()).toEqual(['agent-gate', 'agent-selfcomp'])
    expect(stuck.items.every(item => item.allowed_actions.length === 1 && item.allowed_actions[0] === 'view')).toBe(true)
    expect((await inbox(harness, viewerAuth(), { view: 'stuck' })).items).toEqual([])
  })

  it('a lane nobody holds (decided by org owner role, e.g. gate:routines) stays in the owner inbox, not the viewer\'s', async () => {
    harness = makeHarness()
    insertTask(harness, { id: 'ownerless-lane', gate: 'gate:routines' })
    expect((await inbox(harness, ownerAuth())).items.map(item => item.source_id)).toEqual(['ownerless-lane'])
    expect((await inbox(harness, ownerAuth(), { view: 'stuck' })).items).toEqual([])
    expect((await inbox(harness, viewerAuth())).items).toEqual([])
  })

  it('MCP, REST, dashboard and Telegram all read through the one listNeedsYou', async () => {
    for (const file of ['mcp/routines.ts', 'attention/routes.ts', 'dashboard/needs-you.ts', 'im/index.ts']) {
      const source = readFileSync(join(SRC_DIR, file), 'utf8')
      expect(source, file).toMatch(/import \{[^}]*\blistNeedsYou\b[^}]*\} from '(\.\.|\.)\/(attention\/)?service'/)
      expect(source, file).toContain('listNeedsYou(')
    }
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(NOW))
    harness = makeHarness()
    insertTask(harness, { id: 'act-human', priority: 'P1' })
    insertTask(harness, { id: 'agent-gate', gate: 'gate:kasra-core' })
    const env = envFor(harness)
    const auth = viewerAuth()
    const dashboard = await loadNeedsYouDashboard(env, auth)
    const direct = await listNeedsYou(env, routinePrincipal(auth), { auth })
    expect(dashboard.items.map(item => item.source_id)).toEqual(direct.items.map(item => item.source_id))
    expect(dashboard.items.map(item => item.source_id)).toEqual(['act-human'])
  })
})
