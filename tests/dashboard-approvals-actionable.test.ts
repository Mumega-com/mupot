// /approvals default view + badge = items the VIEWER is the gate for (gate_grants,
// never a name match), unarchived. Other gates collapse to one line (?view=other).
// Items untouched for 14d+ collapse into "Older (N)" and KEEP their buttons — age
// never hides or disables anything. Decided items are read-only History.
// Real sqlite + all migrations; the badge JSON runs through the real dashboardApp.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  loadApprovals, loadApprovalsHistory, loadApprovalsSummary, loadAsks,
  APPROVAL_HISTORY_PAGE_SIZE, APPROVAL_LIVE_LIST_CAP, APPROVAL_OLDER_DAYS,
} from '../src/dashboard/approvals'
import { parseFilters, filterOptions, scopeItems, sortApprovals, sortAsks } from '../src/dashboard/approvals-view'
import { approvalsSentBody, approvalsBody, approvalsHistoryBody, approvalsOtherBody, dashboardApp } from '../src/dashboard/index'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'test'
const owner = { userId: 'u', memberId: 'm-op', email: null, role: 'owner', tenant: TENANT, capabilities: [] } as unknown as AuthContext

let h: SqliteD1Harness
let env: Env

function addTask(id: string, opts: { ageDays?: number; status?: string; gate?: string; priority?: string | null; agent?: string; project?: string | null; title?: string } = {}): void {
  const age = `-${String(opts.ageDays ?? 0)} days`
  h.sqlite.prepare(
    `INSERT INTO tasks (id, squad_id, title, status, done_when, gate_owner, assignee_agent_id, priority, project_id, created_at, updated_at)
     VALUES (?, 's1', ?, ?, 'x', ?, ?, ?, ?, datetime('now', ?), datetime('now', ?))`,
  ).run(id, opts.title ?? `Task ${id}`, opts.status ?? 'review', opts.gate ?? 'gate:hadi', opts.agent ?? 'a1', opts.priority ?? null, opts.project ?? null, age, age)
  // The review clock (tasks.review_entered_at, stamped by trigger at INSERT) follows the fixture's age.
  h.sqlite.prepare(`UPDATE tasks SET review_entered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) WHERE id = ?`).run(age, id)
}
const verdict = (taskId: string, ageDays = 0) =>
  h.sqlite.prepare(`INSERT INTO task_verdicts (id, task_id, verdict, decided_by, decided_at) VALUES (?, ?, 'approved', 'm-op', datetime('now', ?))`)
    .run(`v-${taskId}`, taskId, `-${String(ageDays)} days`)
const archive = (id: string) =>
  h.sqlite.exec(`INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status, created_at)
    VALUES ('${id}', datetime('now'), 'test', 'm-op', 'review', datetime('now'))`)

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  env = { TENANT_SLUG: TENANT, DB: h.db } as unknown as Env
  h.sqlite.exec(`
    INSERT INTO members (id, tenant, email, display_name, status) VALUES ('m-op', '${TENANT}', 'op@example.com', 'Op', 'active');
    INSERT INTO departments (id, slug, name) VALUES ('d1', 'dept', 'Dept');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('s1', 'd1', 'sq-one', 'Squad One');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('a1', 's1', 'ag1', 'Agent', 'inactive'),
      ('a2', 's1', 'ag2', 'Evil <b>x</b>', 'inactive');
    INSERT INTO projects (id, slug, name) VALUES ('p1', 'p-one', 'Alpha'), ('p2', 'p-two', 'Beta');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('p1', 's1', 'write'), ('p2', 's1', 'write');
    INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
      VALUES ('gg1', 'gate:hadi', 'member', 'm-op', 'test', datetime('now'));
  `)
})
afterEach(() => h.close())

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort()
const cards = (html: string) => html.match(/class="card approval"/g)?.length ?? 0

describe('approvals: own gate vs other gates', () => {
  it('badge equals the viewer own-gate count; other gates collapse to one line with per-gate counts', async () => {
    for (let i = 0; i < 3; i += 1) addTask(`mine${String(i)}`, { ageDays: 1 })
    for (let i = 0; i < 4; i += 1) addTask(`kc${String(i)}`, { gate: 'gate:kasra-core', ageDays: 1 })
    for (let i = 0; i < 2; i += 1) addTask(`ath${String(i)}`, { gate: 'gate:athena', ageDays: 1 })
    const q = await loadApprovals(env, owner)
    expect(q.ownCount).toBe(3)
    const html = String(approvalsBody(q))
    expect(html).toContain('3 waiting on you')
    expect(cards(html)).toBe(3)
    expect(html).toContain('Other gates: kasra-core 4 · athena 2')
    expect(html).toContain('/approvals?view=other')
    expect(html).not.toContain('Task kc0')
  })

  it('?view=other groups the other gates and owner keeps buttons where authz allows', async () => {
    addTask('mine', { ageDays: 1 })
    addTask('kc0', { gate: 'gate:kasra-core', ageDays: 1 })
    addTask('ath0', { gate: 'gate:athena', ageDays: 1 })
    const q = await loadApprovals(env, owner)
    const html = String(approvalsOtherBody(q))
    expect(html).toContain('gate:kasra-core')
    expect(html).toContain('gate:athena')
    expect(html).not.toContain('Task mine')
    expect(cards(html)).toBe(2)
    expect(html).toContain('appr-approve')
  })

  it('own-gate is resolved through gate_grants, not a name match: no grant => nothing is "mine"', async () => {
    h.sqlite.exec(`DELETE FROM gate_grants`)
    addTask('named-hadi', { ageDays: 1 }) // gate:hadi by NAME, but the viewer holds no grant
    const q = await loadApprovals(env, owner)
    expect(q.ownCount).toBe(0)
    expect(String(approvalsBody(q))).toContain('Other gates: hadi 1')
  })

  it('a grant on a second gate makes it own too', async () => {
    h.sqlite.exec(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('gg2','gate:hadi-codex','member','m-op','t',datetime('now'))`)
    addTask('a', { gate: 'gate:hadi-codex', ageDays: 1 })
    addTask('b', { ageDays: 1 })
    expect((await loadApprovals(env, owner)).ownCount).toBe(2)
  })

  it('older items collapse into Older (N) and KEEP approve/reject buttons', async () => {
    addTask('fresh', { ageDays: 1 })
    // Older (display, 7d) sits BELOW the expiry window (14d): an older ask is still live and actionable.
    addTask('old1', { ageDays: APPROVAL_OLDER_DAYS + 1 })
    addTask('old2', { ageDays: APPROVAL_OLDER_DAYS + 3 })
    addTask('expired', { ageDays: 40 }) // past the expiry window: not listed at all (swept to blocked)
    const q = await loadApprovals(env, owner)
    const html = String(approvalsBody(q))
    expect(html).toContain('3 waiting on you') // age never drops the count; an EXPIRED ask is not waiting
    expect(html).toContain('Older (2)')
    const olderStart = html.indexOf('appr-older')
    const olderPart = html.slice(olderStart).split('<script>')[0]
    expect(olderPart).toContain('Task old1')
    expect(olderPart.match(/appr-approve/g)?.length).toBe(2)
    expect(olderPart.match(/appr-reject/g)?.length).toBe(2)
  })

  it('an archived item is hidden everywhere', async () => {
    addTask('mine', { ageDays: 1 })
    addTask('kc', { gate: 'gate:kasra-core', ageDays: 1 })
    addTask('done', { ageDays: 2, status: 'approved' })
    verdict('done', 1)
    archive('mine'); archive('kc'); archive('done')
    const q = await loadApprovals(env, owner)
    expect(q.items).toEqual([])
    expect((await loadApprovalsHistory(env, owner)).rows).toEqual([])
    expect(await loadApprovalsSummary(env, owner)).toEqual({ decidedThisWeek: 0 })
  })

  it('caps the fresh list at 20 with Show more; ?all shows everything', async () => {
    for (let i = 0; i < 25; i += 1) addTask(`l${String(i).padStart(2, '0')}`, { ageDays: 1 })
    const q = await loadApprovals(env, owner)
    const capped = String(approvalsBody(q))
    expect(cards(capped)).toBe(APPROVAL_LIVE_LIST_CAP)
    expect(capped).toContain('Show 5 more')
    expect(capped).toContain('25 waiting on you')
    const all = String(approvalsBody(q, [], [], undefined, true))
    expect(cards(all)).toBe(25)
  })
})

describe('approvals history (decided, read-only)', () => {
  it('shows decided items, the summary counts them, no age/expired wording', async () => {
    addTask('live', { ageDays: 1 })
    addTask('done', { ageDays: 2, status: 'approved' })
    verdict('done', 2)
    const hist = await loadApprovalsHistory(env, owner)
    expect(ids(hist.rows)).toEqual(['done'])
    const summary = await loadApprovalsSummary(env, owner)
    expect(summary).toEqual({ decidedThisWeek: 1 })
    const page = String(approvalsBody(await loadApprovals(env, owner), [], [], summary))
    expect(page).toContain('1 decided this week')
    expect(page.toLowerCase()).not.toContain('expired')
  })

  it('paginates at 20', async () => {
    for (let i = 0; i < 45; i += 1) { addTask(`d${String(i).padStart(2, '0')}`, { status: 'approved' }); verdict(`d${String(i).padStart(2, '0')}`, i) }
    const [p1, p2, p3] = [await loadApprovalsHistory(env, owner, 1), await loadApprovalsHistory(env, owner, 2), await loadApprovalsHistory(env, owner, 3)]
    expect([p1.rows.length, p2.rows.length, p3.rows.length]).toEqual([APPROVAL_HISTORY_PAGE_SIZE, APPROVAL_HISTORY_PAGE_SIZE, 5])
    expect([p1.hasMore, p2.hasMore, p3.hasMore]).toEqual([true, true, false])
    expect(new Set([...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id)).size).toBe(45)
    expect(String(approvalsHistoryBody(p1))).toContain('view=history&amp;page=2')
  })
})

describe('sidebar badge: GET /approvals with Accept: application/json', () => {
  it('returns {pending: own-gate count} — the same number the page header shows', async () => {
    h.sqlite.exec(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-org', 'm-op', 'org', NULL, 'admin');
    `)
    addTask('mine0', { ageDays: 1 }); addTask('mine1', { ageDays: 10 })
    addTask('kc', { gate: 'gate:kasra-core', ageDays: 1 })
    const routeEnv = {
      DB: h.db, TENANT_SLUG: TENANT, BRAND: 'Test',
      SESSIONS: { get: async (k: string) => (k === 'sess:s1' ? JSON.stringify({ userId: 'u-op', email: 'op@example.com', role: 'admin', createdAt: '2026-01-01T00:00:00Z' }) : null) },
      OAUTH_KV: { get: async () => null, put: async () => undefined },
    } as unknown as Env
    const res = await dashboardApp.fetch(new Request('https://pot.test/approvals', { headers: { Cookie: 'mupot_session=s1', Accept: 'application/json' } }), routeEnv)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ pending: 2 })
    const htmlRes = await dashboardApp.fetch(new Request('https://pot.test/approvals', { headers: { Cookie: 'mupot_session=s1', Accept: 'text/html' } }), routeEnv)
    expect(await htmlRes.text()).toContain('2 waiting on you')
    const junk = await dashboardApp.fetch(new Request("https://pot.test/approvals?p=P9&p=%27%3B&agent=zzz&project=%00&kind=x&gate=y&all=1&view=bogus", { headers: { Cookie: 'mupot_session=s1', Accept: 'text/html' } }), routeEnv)
    expect(junk.status).toBe(200)
  })
})

describe('approvals page for humans: sort, filters, options', () => {
  const page = async (raw: { p?: string[]; agent?: string; project?: string; kind?: string[]; gate?: string } = {}) => {
    const q = await loadApprovals(env, owner)
    const f = parseFilters({ p: raw.p ?? [], kind: raw.kind ?? [], agent: raw.agent, project: raw.project, gate: raw.gate }, q.items)
    return { q, html: String(approvalsBody(q, [], [], undefined, true, f)), f }
  }
  const order = (html: string) => [...html.matchAll(/Task ([\w-]+)/g)].map((m) => m[1])

  it('sorts by priority (P0 first, untriaged last), then oldest review entry first', async () => {
    addTask('none-old', { ageDays: 5 })
    addTask('p2', { ageDays: 1, priority: 'P2' })
    addTask('p0-new', { ageDays: 1, priority: 'P0' })
    addTask('p0-old', { ageDays: 6, priority: 'P0' })
    addTask('none-new', { ageDays: 0 })
    const q = await loadApprovals(env, owner)
    expect(sortApprovals(q.items).map((t) => t.id)).toEqual(['p0-old', 'p0-new', 'p2', 'none-old', 'none-new'])
    const { html } = await page()
    expect(order(html).slice(0, 5)).toEqual(['p0-old', 'p0-new', 'p2', 'none-old', 'none-new'])
    expect(html).toContain('no priority')
    expect(html).toContain('You have 5 decisions waiting')
    expect(html).toContain('2 high priority')
  })

  it('each filter narrows the list; the badge stays the unfiltered own count', async () => {
    addTask('a', { priority: 'P0', agent: 'a1', project: 'p1' })
    addTask('b', { priority: 'P1', agent: 'a2', project: 'p1' })
    addTask('c', { priority: null, agent: 'a2', project: 'p2' })
    const listed = (html: string) => new Set([...html.matchAll(/data-task="(\w+)"/g)].map((m) => m[1]))
    expect(listed((await page({ p: ['P0'] })).html)).toEqual(new Set(['a']))
    expect(listed((await page({ p: ['P0', 'none'] })).html)).toEqual(new Set(['a', 'c']))
    expect(listed((await page({ agent: 'a2' })).html)).toEqual(new Set(['b', 'c']))
    expect(listed((await page({ project: 'p2' })).html)).toEqual(new Set(['c']))
    const both = await page({ agent: 'a2', project: 'p1' })
    expect(listed(both.html)).toEqual(new Set(['b']))
    expect(both.html).toContain('2 filters active')
    expect(both.html).toContain('>clear</a>')
    expect(both.html).toContain('3 waiting on you')
    expect(listed((await page({ kind: ['publish'] })).html)).toEqual(new Set())
    expect(listed((await page({ kind: ['verdict'] })).html)).toEqual(new Set(['a', 'b', 'c']))
  })

  it('gate=all includes other gates inline; mine hides them', async () => {
    addTask('mine')
    addTask('kc', { gate: 'gate:kasra-core' })
    expect((await page()).html).not.toContain('data-task="kc"')
    expect((await page({ gate: 'all' })).html).toContain('data-task="kc"')
  })

  it('unknown or invalid filter values are ignored, never a 500', async () => {
    addTask('a', { priority: 'P0', agent: 'a1', project: 'p1' })
    const r = await page({ p: ['P9', "x'; DROP TABLE tasks;--"], agent: 'nope', project: "' OR 1=1 --", kind: ['bogus'], gate: 'evil' })
    expect(r.f).toEqual({ priority: [], agent: null, project: null, kind: [], gate: 'mine' })
    expect(r.html).toContain('data-task="a"')
    expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 1 })
  })

  it('the sender display name is HTML-escaped', async () => {
    addTask('x', { agent: 'a2' })
    const { html } = await page()
    expect(html).toContain('Evil &lt;b&gt;x&lt;/b&gt;')
    expect(html).not.toContain('<b>x</b>')
  })

  it('filter options contain only agents/projects in the viewer visible set', async () => {
    addTask('mine', { agent: 'a1', project: 'p1' })
    addTask('theirs', { gate: 'gate:kasra-core', agent: 'a2', project: 'p2' })
    const q = await loadApprovals(env, owner)
    const mineOpts = filterOptions(scopeItems(q.items, 'mine'))
    expect(mineOpts.agents.map((a) => a.id)).toEqual(['a1'])
    expect(mineOpts.projects.map((p) => p.id)).toEqual(['p1'])
    expect(parseFilters({ p: [], kind: [], agent: 'a2' }, q.items).agent).toBeNull()
    expect(parseFilters({ p: [], kind: [], agent: 'a2', gate: 'all' }, q.items).agent).toBe('a2')
  })

  it('a non-admin member never gets options (or rows) from gates they do not hold', async () => {
    h.sqlite.exec(`
      INSERT INTO members (id, tenant, email, display_name, status) VALUES ('m-2', '${TENANT}', 'm2@example.com', 'M2', 'active');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-m2', 'm-2', 'squad', 's1', 'member');
      INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('gg-m2', 'gate:hadi', 'member', 'm-2', 't', datetime('now'));
    `)
    addTask('visible', { agent: 'a1', project: 'p1' })
    addTask('hidden', { gate: 'gate:kasra-core', agent: 'a2', project: 'p2' })
    const member = { userId: 'm-2', memberId: 'm-2', email: null, role: 'member', tenant: TENANT,
      capabilities: [{ member_id: 'm-2', scope_type: 'squad', scope_id: 's1', capability: 'member' }] } as unknown as AuthContext
    const q = await loadApprovals(env, member)
    expect(q.items.map((t) => t.id)).toEqual(['visible'])
    for (const gate of ['mine', 'all'] as const) {
      const o = filterOptions(scopeItems(q.items, gate))
      expect(o.agents.map((a) => a.id)).toEqual(['a1'])
      expect(o.projects.map((p) => p.id)).toEqual(['p1'])
    }
  })

  it('review entry = tasks.review_entered_at (a later updated_at touch does not rejuvenate it), the same column the expiry predicate reads', async () => {
    addTask('late', { ageDays: 0 })
    addTask('plain', { ageDays: 3 })
    h.sqlite.exec(`UPDATE tasks SET review_entered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${APPROVAL_OLDER_DAYS + 2} days') WHERE id = 'late'`)
    const items = (await loadApprovals(env, owner)).items
    const late = items.find((t) => t.id === 'late')
    const plain = items.find((t) => t.id === 'plain')
    expect(Date.now() - Date.parse(late?.review_entered_at ?? '')).toBeGreaterThan((APPROVAL_OLDER_DAYS + 1) * 86_400_000)
    expect(Date.parse(plain?.review_entered_at ?? '')).toBeLessThan(Date.now() - 2 * 86_400_000)
    expect(String(approvalsBody({ items, actionableCount: 2, actionableCountIsLowerBound: false, ownCount: 2, ownCountIsLowerBound: false }))).toContain('Older (1)')
  })
})

describe('"You asked" tab (?tab=sent): the viewer own asks, read-only', () => {
  // A squad member of s1: the viewer must hold read standing on the task's squad (canReadSquadTasks fence).
  const as = (memberId: string, squad = 's1') => ({ userId: memberId, memberId, email: null, role: 'member', tenant: TENANT,
    capabilities: [{ member_id: memberId, scope_type: 'squad', scope_id: squad, capability: 'member' }] }) as unknown as AuthContext
  beforeEach(() => {
    h.sqlite.exec(`
      INSERT INTO members (id, tenant, email, display_name, status) VALUES ('m-x', '${TENANT}', 'x@example.com', 'X', 'active');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-op-s1', 'm-op', 'squad', 's1', 'member'), ('cap-x-s1', 'm-x', 'squad', 's1', 'member');
      UPDATE agents SET owner_member_id = 'm-op' WHERE id = 'a1';
      UPDATE agents SET owner_member_id = 'm-x' WHERE id = 'a2';
    `)
  })

  it('lists only the viewer own asks: direct (assignee member) and via an agent they own', async () => {
    addTask('direct', { agent: 'a2' })
    h.sqlite.exec(`UPDATE tasks SET assignee_agent_id = NULL, assignee_member_id = 'm-op' WHERE id = 'direct'`)
    addTask('via-a1', { agent: 'a1', priority: 'P1' })
    addTask('theirs', { agent: 'a2' })
    addTask('not-in-review', { agent: 'a1', status: 'in_progress' })
    const asks = await loadAsks(env, as('m-op'))
    expect(asks.map((a) => a.id).sort()).toEqual(['direct', 'via-a1'])
    expect(asks.find((a) => a.id === 'direct')?.via_agent).toBeNull()
    expect(asks.find((a) => a.id === 'via-a1')?.via_agent).toBe('Agent')
  })

  it("a member's tab never shows another member's asks; via rows only for agents they own", async () => {
    addTask('mine', { agent: 'a1' })
    addTask('xs', { agent: 'a2' })
    expect((await loadAsks(env, as('m-x'))).map((a) => a.id)).toEqual(['xs'])
    expect((await loadAsks(env, as('m-op'))).map((a) => a.id)).toEqual(['mine'])
    expect(await loadAsks(env, { userId: 'u', email: null, role: 'owner', tenant: TENANT, capabilities: [] } as unknown as AuthContext)).toEqual([])
  })

  it('renders waiting first then most recent, with decider, priority, state; NO act buttons; archived hidden', async () => {
    addTask('old-approved', { agent: 'a1', status: 'approved', ageDays: 1 })
    addTask('waiting', { agent: 'a1', status: 'review', ageDays: 5, priority: 'P0' })
    addTask('archived', { agent: 'a1', ageDays: 1 })
    archive('archived')
    const asks = await loadAsks(env, as('m-op'))
    expect(sortAsks(asks).map((a) => a.id)).toEqual(['waiting', 'old-approved'])
    const f = parseFilters({ p: [], kind: [], tab: 'sent', asks }, [])
    const html = String(approvalsSentBody(asks, f))
    expect(html).toContain('Decided by hadi')
    expect(html).toContain('via Agent')
    expect(html).toContain('>P0<')
    expect(html).toContain('>waiting<')
    expect(html).toContain('>approved<')
    expect(html).not.toContain('appr-approve')
    expect(html).not.toContain('appr-reject')
    expect(html).not.toContain('<button class="btn appr')
    expect(html).not.toContain('archived')
  })

  it('priority and sender filters apply on the sent tab', async () => {
    addTask('a', { agent: 'a1', priority: 'P0' })
    addTask('b', { agent: 'a1', priority: 'P2' })
    const asks = await loadAsks(env, as('m-op'))
    const f = parseFilters({ p: ['P0'], kind: [], tab: 'sent', asks }, [])
    const html = String(approvalsSentBody(asks, f))
    expect(html).toContain('data-task="a"')
    expect(html).not.toContain('data-task="b"')
    expect(html).toContain('1 filter active')
  })

  it('route: ?tab=sent renders through the real dashboardApp', async () => {
    h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-org', 'm-op', 'org', NULL, 'admin')`)
    addTask('mine', { agent: 'a1' })
    const routeEnv = {
      DB: h.db, TENANT_SLUG: TENANT, BRAND: 'Test',
      SESSIONS: { get: async (k: string) => (k === 'sess:s1' ? JSON.stringify({ userId: 'u-op', email: 'op@example.com', role: 'admin', createdAt: '2026-01-01T00:00:00Z' }) : null) },
      OAUTH_KV: { get: async () => null, put: async () => undefined },
    } as unknown as Env
    const res = await dashboardApp.fetch(new Request('https://pot.test/approvals?tab=sent&p=P9', { headers: { Cookie: 'mupot_session=s1' } }), routeEnv)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('data-task="mine"')
    expect(body).not.toContain('appr-approve')
  })
})


describe('"You asked": read fence (#1993)', () => {
  const sq = (memberId: string, squad = 's1') => ({ userId: memberId, memberId, email: null, role: 'member', tenant: TENANT,
    capabilities: [{ member_id: memberId, scope_type: 'squad', scope_id: squad, capability: 'member' }] }) as unknown as AuthContext
  beforeEach(() => {
    h.sqlite.exec(`
      INSERT INTO members (id, tenant, email, display_name, status) VALUES ('m-x', '${TENANT}', 'x@example.com', 'X', 'active');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-op-s1', 'm-op', 'squad', 's1', 'member');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('s2', 'd1', 'sq-two', 'Squad Two');
      UPDATE agents SET owner_member_id = 'm-op' WHERE id = 'a1';
    `)
  })

  it('squad fence: an owned-agent ask on a squad the viewer cannot read is NOT listed', async () => {
    addTask('ok', { agent: 'a1' })
    addTask('foreign', { agent: 'a1' })
    h.sqlite.exec(`UPDATE tasks SET squad_id = 's2' WHERE id = 'foreign'`)
    expect((await loadAsks(env, sq('m-op'))).map((a) => a.id)).toEqual(['ok'])
    // Standing on s2 admits it again: the fence is canReadSquadTasks, not a blanket drop.
    h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-op-s2', 'm-op', 'squad', 's2', 'member')`)
    const both = { ...sq('m-op'), capabilities: [...sq('m-op').capabilities, { member_id: 'm-op', scope_type: 'squad', scope_id: 's2', capability: 'member' }] } as unknown as AuthContext
    expect((await loadAsks(env, both)).map((a) => a.id).sort()).toEqual(['foreign', 'ok'])
  })

  it('inclusion is assignee-member or OWNED assignee agent only: bindings, agent_keys, submitters, runners do not include', async () => {
    h.sqlite.exec(`
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'a2', 'm-op', datetime('now'));
      INSERT INTO agent_keys (tenant, agent_id, pubkey, member_id, created_at) VALUES ('${TENANT}', 'a2', 'pk-a2', 'm-op', unixepoch());
    `)
    addTask('bound-only', { agent: 'a2' }) // a2 is bound to / keyed by m-op but owned by nobody
    addTask('submitter', { agent: 'a2' })
    h.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('a3', 's1', 'ag3', 'Third', 'inactive')`)
    addTask('other-assignee', { agent: 'a3' })
    h.sqlite.exec(`
      INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest)
        VALUES ('sub1', '${TENANT}', 'other-assignee', 's1', 'a1', 'p', '${'a'.repeat(64)}', '${'b'.repeat(64)}');
    `)
    addTask('owned', { agent: 'a1' })
    expect((await loadAsks(env, sq('m-op'))).map((a) => a.id)).toEqual(['owned'])
  })

  it('via names the agent that actually matched: the owned assignee, and no via when the viewer is the assignee', async () => {
    addTask('via', { agent: 'a1' })
    addTask('self', { agent: 'a2' })
    h.sqlite.exec(`UPDATE tasks SET assignee_agent_id = NULL, assignee_member_id = 'm-op' WHERE id = 'self'`)
    const asks = await loadAsks(env, sq('m-op'))
    expect(asks.find((a) => a.id === 'via')?.via_agent).toBe('Agent')
    expect(asks.find((a) => a.id === 'self')?.via_agent).toBeNull()
  })
})

describe('non-admin gate_grants fence on history and summary (scopeFor)', () => {
  const member = { userId: 'm-2', memberId: 'm-2', email: null, role: 'member', tenant: TENANT, capabilities: [] } as unknown as AuthContext
  beforeEach(() => {
    h.sqlite.exec(`
      INSERT INTO members (id, tenant, email, display_name, status) VALUES ('m-2', '${TENANT}', 'm2@example.com', 'M2', 'active');
      INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('gg-m2', 'gate:hadi', 'member', 'm-2', 't', datetime('now'));
    `)
    addTask('mine', { status: 'approved', gate: 'gate:hadi' })
    addTask('theirs', { status: 'approved', gate: 'gate:kasra-core' })
    verdict('mine', 1)
    verdict('theirs', 1)
  })

  it('history lists only the gates the member holds; the owner sees both', async () => {
    expect((await loadApprovalsHistory(env, member)).rows.map((r) => r.id)).toEqual(['mine'])
    expect(ids((await loadApprovalsHistory(env, owner)).rows)).toEqual(['mine', 'theirs'])
  })

  it('summary counts only the gates the member holds; the owner counts both', async () => {
    expect((await loadApprovalsSummary(env, member)).decidedThisWeek).toBe(1)
    expect((await loadApprovalsSummary(env, owner)).decidedThisWeek).toBe(2)
  })

  it('a member with no gate_grants sees empty history and zero summary', async () => {
    h.sqlite.exec(`DELETE FROM gate_grants WHERE principal_id = 'm-2'`)
    expect((await loadApprovalsHistory(env, member)).rows).toEqual([])
    expect((await loadApprovalsSummary(env, member)).decidedThisWeek).toBe(0)
  })
})

describe('escaping and visible-set filters (#1993)', () => {
  it('the live row title is HTML-escaped', async () => {
    addTask('x', { title: '<img src=x onerror=alert(1)>' })
    const html = String(approvalsBody(await loadApprovals(env, owner)))
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img src=x')
  })

  it('the "You asked" title is HTML-escaped', () => {
    const ask = { id: 'k', title: '<script>alert(2)</script>', body: '', gate_owner: 'gate:hadi', priority: null, project_id: null, project_name: null,
      assignee_agent_id: null, agent_name: null, review_entered_at: new Date().toISOString(), created_at: '', updated_at: '', state: 'waiting' as const, via_agent: null }
    const html = String(approvalsSentBody([ask], parseFilters({ p: [], kind: [], tab: 'sent', asks: [ask] }, [])))
    expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert(2)')
  })

  it('the rendered filter options come from the visible set: other-gate senders/projects are absent under "mine", present under "all"', async () => {
    addTask('mine', { agent: 'a1', project: 'p1' })
    addTask('theirs', { gate: 'gate:kasra-core', agent: 'a2', project: 'p2' })
    const q = await loadApprovals(env, owner)
    const mineHtml = String(approvalsBody(q, [], [], { decidedThisWeek: 0 }, false, parseFilters({ p: [], kind: [] }, q.items)))
    expect(mineHtml).toContain('value="a1"')
    expect(mineHtml).toContain('value="p1"')
    expect(mineHtml).not.toContain('value="a2"')
    expect(mineHtml).not.toContain('value="p2"')
    const allHtml = String(approvalsBody(q, [], [], { decidedThisWeek: 0 }, false, parseFilters({ p: [], kind: [], gate: 'all' }, q.items)))
    expect(allHtml).toContain('value="a2"')
    expect(allHtml).toContain('value="p2"')
  })
})

describe('badge "+" follows the OWN count; Vary: Accept (#1993)', () => {
  it('own count exact => no "+" even when the all-gate total is a lower bound', () => {
    const html = String(approvalsBody({ items: [], actionableCount: 200, actionableCountIsLowerBound: true, ownCount: 1, ownCountIsLowerBound: false }))
    expect(html).toContain('1 waiting on you')
    expect(html).not.toContain('1+ waiting on you')
  })

  it('own count a lower bound => "+"', () => {
    const html = String(approvalsBody({ items: [], actionableCount: 3, actionableCountIsLowerBound: false, ownCount: 3, ownCountIsLowerBound: true }))
    expect(html).toContain('3+ waiting on you')
  })

  it('badge JSON and page HTML both carry Vary: Accept; JSON pending = own count', async () => {
    h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-org', 'm-op', 'org', NULL, 'admin')`)
    addTask('mine')
    addTask('kc', { gate: 'gate:kasra-core' })
    const routeEnv = {
      DB: h.db, TENANT_SLUG: TENANT, BRAND: 'Test',
      SESSIONS: { get: async (k: string) => (k === 'sess:s1' ? JSON.stringify({ userId: 'u-op', email: 'op@example.com', role: 'admin', createdAt: '2026-01-01T00:00:00Z' }) : null) },
      OAUTH_KV: { get: async () => null, put: async () => undefined },
    } as unknown as Env
    const get = (accept: string) => dashboardApp.fetch(new Request('https://pot.test/approvals', { headers: { Cookie: 'mupot_session=s1', Accept: accept } }), routeEnv)
    const json = await get('application/json')
    expect(json.headers.get('Vary')).toContain('Accept')
    expect(await json.json()).toEqual({ pending: 1 })
    const page = await get('text/html')
    expect(page.headers.get('Vary')).toContain('Accept')
  })
})
