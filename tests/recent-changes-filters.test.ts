import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { html } from 'hono/html'
import { changesBody, loadChange, loadRecentChangesPage, makeChangesApp, type RecentChangesPage } from '../src/dashboard/changes'
import { changeCursor, changeFilters, changesLink, changeSourceQuery, SEARCH_MAX_LENGTH } from '../src/dashboard/changes-query'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

let harness: SqliteD1Harness
let env: Env
const AT = '2026-10-21T12:00:00.000Z'
const OLD = '2026-10-09T12:00:00.000Z'
const admin = {
  userId: 'user', email: 'admin@test.example', role: 'owner', tenant: 'local', channel: 'workspace', memberId: 'admin', boundAgentId: null,
  capabilities: [{ member_id: 'admin', scope_type: 'org', scope_id: null, capability: 'admin' }],
} as AuthContext
const plain = { ...admin, memberId: 'plain', role: 'member', capabilities: [] } as AuthContext

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = { DB: harness.db, TENANT_SLUG: 'local', TASK_ARCHIVE_ENABLED: '1' } as Env
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('d', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('s', 'd', 'squad-slug', 'Squad name');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('admin', 'admin@test.example', 'Admin', 'active', 'local'), ('plain', 'plain@test.example', 'Plain', 'active', 'local');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent', 's', 'agent-slug', 'Agent name', 'member', 'test', 'inactive');
    INSERT INTO projects (id, slug, name, status, archived_at) VALUES ('proj-viamar', 'coastal-work', 'Viamar', 'archived', '${OLD}');
    INSERT INTO tasks (id, squad_id, title, status, done_when, gate_owner, updated_at) VALUES ('task', 's', 'Task name', 'approved', 'done', 'gate:outreach', '${AT}');
  `)
})
afterEach(() => harness.close())

function archive(id: string, table = 'projects', target = 'proj-viamar', actor = 'admin', at = OLD, action = 'archive', tenant = 'local') {
  harness.sqlite.prepare(`INSERT INTO archive_receipts
    (id, tenant, entity_table, entity_id, action, reason, actor_member_id, created_at)
    VALUES (?, ?, ?, ?, ?, 'tidy', ?, ?)`).run(id, tenant, table, target, action, actor, at)
}
function verdict(id: string, actor = 'admin', at = AT) {
  harness.sqlite.prepare(`INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at)
    VALUES (?, 'task', 'approved', 'ok', ?, ?)`).run(id, actor, at)
}
function reversal(id: string, actor = 'admin', at = AT) {
  harness.sqlite.prepare(`INSERT INTO verdict_reversals (id, tenant, task_id, squad_id, from_status, prior_verdict, reason, actor_id, created_at)
    VALUES (?, 'local', 'task', 's', 'approved', 'approved', 'undo', ?, ?)`).run(id, actor, at)
}
function audit(id: string, actor = 'admin', at = AT) {
  harness.sqlite.prepare(`INSERT INTO agent_audit (id, agent_id, actor_id, actor_type, action, fields_changed, before_state, after_state, created_at)
    VALUES (?, 'agent', ?, 'user', 'update_agent', '{}', '{}', '{}', ?)`).run(id, actor, at)
}
const ids = (page: RecentChangesPage) => page.changes.map((row) => row.id)
const params = (href: string) => new URL(href, 'http://localhost').searchParams
const page = (query = '', auth = admin) => loadRecentChangesPage(env, auth, new URLSearchParams(query))
const follow = (href: string, auth = admin) => loadRecentChangesPage(env, auth, params(href))

function seedKinds() {
  archive('project')
  archive('task', 'tasks', 'task', 'admin', AT)
  archive('restored', 'squads', 's', 'admin', AT, 'unarchive')
  verdict('verdict')
  reversal('reversal')
  audit('audit')
}

describe('Recent changes filters and search', () => {
  it.each([
    ['archive', ['archive:task', 'archive:project']],
    ['unarchive', ['archive:restored']],
    ['verdict', ['verdict:verdict']],
    ['verdict_reversal', ['info:reversal:reversal']],
    ['agent_change', ['info:agent_audit:audit']],
  ])('filters kind=%s', async (kind, expected) => {
    seedKinds()
    expect(ids(await page(`kind=${kind}`))).toEqual(expected)
  })

  it.each(['projects', 'squads', 'tasks', 'agents', 'members'])('filters archive table=%s', async (table) => {
    for (const t of ['projects', 'squads', 'tasks', 'agents', 'members']) archive(t, t, t)
    expect(ids(await page(`kind=archive&table=${table}`))).toEqual([`archive:${table}`])
  })

  it('excludes verdicts, reversals and agent edits when an archive table is selected', async () => {
    seedKinds()
    expect(ids(await page('table=projects'))).toEqual(['archive:project'])
    for (const kind of ['verdict', 'verdict_reversal', 'agent_change']) {
      expect(ids(await page(`table=projects&kind=${kind}`))).toEqual([])
    }
  })

  it.each(['all', 'anyone'])('preserves literal q=%s across Next and Previous', async (q) => {
    harness.sqlite.prepare('UPDATE projects SET name = ?').run(q)
    for (let i = 0; i < 105; i++) archive(String(i).padStart(3, '0'))
    const first = await page(`q=${q}`)
    expect(params(first.next!).get('q')).toBe(q)
    const second = await follow(first.next!)
    expect(second.start).toBe(50)
    expect(ids(await follow(second.previous!))).toEqual(ids(first))
  })

  it('truncates search on a code-point boundary and preserves its cursor filter key', () => {
    const filters = changeFilters(new URLSearchParams({ q: 'x'.repeat(99) + '😀tail' }))
    expect(filters.q).toBe('x'.repeat(99) + '😀')
    const linked = params(changesLink(filters, { at: AT, id: 'archive:a', position: 50, direction: 'next' }))
    expect(changeCursor(linked, changeFilters(linked))?.position).toBe(50)
  })

  it('rejects cursors with a different filter key or invalid source id', () => {
    const filters = changeFilters()
    const linked = params(changesLink(filters, { at: AT, id: 'archive:a', position: 50, direction: 'next' }))
    expect(changeCursor(linked, filters)).not.toBeNull()
    expect(changeCursor(linked, { ...filters, q: 'different' })).toBeNull()
    const cursor = JSON.parse(linked.get('cursor')!)
    for (const id of ['arbitrary:a', 'archive:', 'info:unknown:a']) {
      linked.set('cursor', JSON.stringify([cursor[0], id, ...cursor.slice(2)]))
      expect(changeCursor(linked, filters)).toBeNull()
    }
  })

  it('limits undoable verdicts to the latest receipt even when all other state matches', async () => {
    verdict('older')
    verdict('z-latest')
    expect(ids(await page('kind=verdict&undoable=1'))).toEqual(['verdict:z-latest'])
  })

  it('does not load a cross-tenant archive for Undo even for an admin', async () => {
    archive('foreign', 'projects', 'proj-viamar', 'admin', OLD, 'archive', 'elsewhere')
    expect(await loadChange(env, admin, 'archive:foreign')).toBeNull()
  })

  it.each(['owner', 'member'])('explains the own-only view for an unelevated %s and hides unavailable filters', async (role) => {
    const result = await page('undoable=1', { ...plain, role } as AuthContext)
    const body = String(await changesBody(result.changes, false, '', Date.now(), result))
    expect(body).toContain('Only your own changes are shown')
    expect(body).toContain('/auth/reauth?return=/elevation')
    expect(body).not.toContain('>Anyone</option>')
    expect(body).not.toContain('name="undoable"')
    expect(body).toContain('Undo requires workspace admin elevation')
    expect(body.match(/>Clear filters<\/a>/g)).toHaveLength(1)
  })

  it('does not claim everyone else is inactive when an admin filters to me', async () => {
    archive('mine')
    const result = await page('actor=me')
    const body = String(await changesBody(result.changes, true, '', Date.now(), result))
    expect(body).not.toContain('Changes by everyone else')
    expect(body).not.toContain('Nobody else has changed')
  })

  it('finds the Viamar archive by display name behind 1,950 newer archives, with its Undo unchanged', async () => {
    archive('old-viamar')
    for (let i = 0; i < 1950; i++) archive(`bulk-${i}`, 'tasks', `bulk-task-${i}`, 'admin', AT)
    expect(ids(await page())).not.toContain('archive:old-viamar')
    const result = await page('q=Viamar')
    expect(ids(result)).toEqual(['archive:old-viamar'])
    expect(result.changes[0].undo.kind).toBe('available')
    expect(String(await changesBody(result.changes, true, '', Date.now(), result))).toContain('name="change" value="archive:old-viamar"')
  })

  it.each(['proj-viamar', 'coastal-work', 'Viamar'])('searches archive target id, slug and name: %s', async (q) => {
    archive('viamar')
    expect(ids(await page(`q=${q}`))).toEqual(['archive:viamar'])
  })

  it.each([
    ['verdict', 'Task name', 'verdict:verdict'], ['verdict_reversal', 'task', 'info:reversal:reversal'],
    ['agent_change', 'agent-slug', 'info:agent_audit:audit'], ['agent_change', 'Agent name', 'info:agent_audit:audit'],
  ])('searches joined names/ids/slugs for %s', async (kind, q, expected) => {
    seedKinds()
    expect(ids(await page(new URLSearchParams({ kind, q }).toString()))).toEqual([expected])
  })

  it.each(['%', '_', '\\'])('treats %s literally in search', async (literal) => {
    harness.sqlite.prepare('UPDATE projects SET name = ? WHERE id = ?').run(`Viamar ${literal} exact`, 'proj-viamar')
    archive('literal')
    archive('ordinary', 'tasks', 'task')
    expect(ids(await page(new URLSearchParams({ q: literal }).toString()))).toEqual(['archive:literal'])
  })

  it('binds quotes and SQL-looking input as search text', async () => {
    archive('viamar')
    expect(ids(await page(new URLSearchParams({ q: "' OR 1=1 --" }).toString()))).toEqual([])
  })

  it('caps q length and ignores invalid query state', async () => {
    const filters = changeFilters(new URLSearchParams({ q: 'x'.repeat(1000), kind: 'delete', table: 'secrets', from: '2026-02-30', to: 'nonsense' }))
    expect(filters.q).toHaveLength(SEARCH_MAX_LENGTH)
    expect(filters).toMatchObject({ kind: 'all', table: 'all', from: '', to: '' })
    await page(new URLSearchParams({ q: 'x'.repeat(1000) }).toString())
  })

  it('includes both endpoints of a date range and excludes other dates for every source', async () => {
    archive('old')
    archive('start', 'tasks', 'task', 'admin', '2026-10-21 00:00:00')
    verdict('end', 'admin', '2026-10-21T23:59:59.999Z')
    reversal('tomorrow', 'admin', '2026-10-22T00:00:00.000Z')
    audit('yesterday', 'admin', '2026-10-20T23:59:59.999Z')
    expect(ids(await page('from=2026-10-21&to=2026-10-21'))).toEqual(['verdict:end', 'archive:start'])
  })

  it('filters actor=me without changing org visibility for anyone', async () => {
    archive('mine')
    archive('other', 'projects', 'proj-viamar', 'plain')
    expect(ids(await page('actor=me'))).toEqual(['archive:mine'])
    expect(ids(await page('actor=anyone'))).toEqual(['archive:other', 'archive:mine'])
  })

  it('never exposes another member’s matching rows to a non-admin, for any source or actor selection', async () => {
    archive('other-project')
    archive('own-project', 'projects', 'proj-viamar', 'plain')
    verdict('other-verdict')
    verdict('own-verdict', 'plain')
    reversal('other-reversal')
    reversal('own-reversal', 'plain')
    audit('other-audit')
    audit('own-audit', 'plain')
    for (const actor of ['me', 'anyone']) {
      expect(ids(await page(`q=Viamar&actor=${actor}`, plain))).toEqual(['archive:own-project'])
      expect(ids(await page(`q=Task&actor=${actor}`, plain))).toEqual(['verdict:own-verdict', 'info:reversal:own-reversal'])
      expect(ids(await page(`q=Agent&actor=${actor}`, plain))).toEqual(['info:agent_audit:own-audit'])
      expect((await page(`q=Viamar&actor=${actor}`, plain)).changes[0].undo.kind).toBe('no_authority')
    }
    // Tenant fences remain in place as well.
    archive('other-tenant', 'projects', 'proj-viamar', 'admin', OLD, 'archive', 'elsewhere')
    expect(ids(await page('q=Viamar'))).not.toContain('archive:other-tenant')
  })

  it('keeps the verdict bound-agent visibility exception while archives still require the member id', async () => {
    verdict('agent-own', 'agent')
    audit('agent-edit', 'agent')
    const bound = { ...plain, boundAgentId: 'agent' }
    expect(ids(await page('q=Task', bound))).toEqual(['verdict:agent-own'])
    expect(ids(await page('q=Agent', bound))).toEqual([])
  })

  it('undoable-only agrees with the existing classifier for ordinary, changed and excluded rows', async () => {
    seedKinds()
    const ordinary = await page()
    expect(ids(await page('undoable=1'))).toEqual(ordinary.changes.filter((r) => r.undo.kind === 'available').map((r) => r.id))
    expect(ids(await page('undoable=1', plain))).toEqual([])
    for (const gate of ['gate:office', 'gate:routines']) {
      harness.sqlite.prepare('UPDATE tasks SET gate_owner = ? WHERE id = ?').run(gate, 'task')
      expect(ids(await page('kind=verdict&undoable=1'))).toEqual([])
    }
    harness.sqlite.exec(`UPDATE tasks SET gate_owner = 'gate:outreach', updated_at = '2099-01-01' WHERE id = 'task';
      UPDATE projects SET archived_at = '2099-01-01' WHERE id = 'proj-viamar';`)
    expect(ids(await page('undoable=1'))).toEqual([])
  })

  it('undoable-only preserves task feature flags, squad state, verdict reversals and proposal exclusions', async () => {
    archive('task-archive', 'tasks', 'task', 'admin', AT)
    archive('squad-archive', 'squads', 's', 'admin', AT)
    harness.sqlite.exec(`
      INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status)
        VALUES ('task', '${AT}', 'tidy', 'admin', 'approved');
      UPDATE squads SET status = 'archived', archived_at = '${AT}' WHERE id = 's';
    `)
    expect(ids(await page('undoable=1'))).toEqual(['archive:task-archive', 'archive:squad-archive'])
    const off = await loadRecentChangesPage({ ...env, TASK_ARCHIVE_ENABLED: '0' }, admin, new URLSearchParams('undoable=1'))
    expect(ids(off)).toEqual(['archive:squad-archive'])
    verdict('archived-task')
    expect(ids(await page('kind=verdict&undoable=1'))).toEqual([])
    harness.sqlite.exec(`DELETE FROM tasks_archive_state WHERE task_id = 'task'`)
    expect(ids(await page('kind=verdict&undoable=1'))).toEqual(['verdict:archived-task'])
    // Seed immutable receipts in their final states rather than editing their history.
    harness.sqlite.exec(`
      INSERT INTO tasks (id, squad_id, title, status, done_when, updated_at) VALUES
        ('proposal-task', 's', 'Proposal', 'approved', 'done', '${AT}'),
        ('reversed-task', 's', 'Reversed', 'approved', 'done', '${AT}');
      INSERT INTO task_verdicts (id, task_id, verdict, decided_by, decided_at, proposal_id, reversed_at) VALUES
        ('proposal-verdict', 'proposal-task', 'approved', 'admin', '${AT}', 'proposal', NULL),
        ('reversed-verdict', 'reversed-task', 'approved', 'admin', '${AT}', NULL, '${AT}');
    `)
    expect(ids(await page('kind=verdict&undoable=1'))).toEqual(['verdict:archived-task'])
    harness.sqlite.exec(`UPDATE tasks SET updated_at = '2099-01-01' WHERE id = 'task'`)
    expect(ids(await page('kind=verdict&undoable=1'))).toEqual([])
  })

  it('undoable-only excludes an older archive after a restore and finds an older eligible row past the page limit', async () => {
    archive('viamar')
    for (let i = 0; i < 120; i++) archive(`new-${i}`, 'agents', 'agent', 'admin', AT)
    expect(ids(await page('undoable=1'))).toEqual(['archive:viamar'])
    archive('restore', 'projects', 'proj-viamar', 'admin', AT, 'unarchive')
    expect(ids(await page('undoable=1'))).toEqual([])
  })
})

describe('merged keyset pages', () => {
  function seedPages() {
    for (let i = 0; i < 36; i++) {
      const id = String(i).padStart(3, '0')
      archive(id, 'tasks', 'task', 'admin', AT)
      verdict(id)
      reversal(id)
      audit(id)
    }
  }

  it('pages tied timestamps and colliding source ids without overlaps or gaps, forward and backward', async () => {
    seedPages()
    const first = await page()
    const second = await follow(first.next!)
    const third = await follow(second.next!)
    expect(first.changes).toHaveLength(50)
    expect(second.changes).toHaveLength(50)
    expect(third.changes).toHaveLength(44)
    expect(third.next).toBeUndefined()
    expect(first.previous).toBeUndefined()
    const all = [...ids(first), ...ids(second), ...ids(third)]
    expect(new Set(all).size).toBe(144)
    expect(all).toEqual([...all].sort().reverse())
    const previous = await follow(third.previous!)
    expect(ids(previous)).toEqual(ids(second))
    expect(previous.start).toBe(50)
    const backToFirst = await follow(previous.previous!)
    expect(ids(backToFirst)).toEqual(ids(first))
    expect(backToFirst.previous).toBeUndefined()
    expect(backToFirst.start).toBe(0)
  })

  it('keeps older-page boundaries stable when a newer receipt is inserted', async () => {
    for (let i = 0; i < 105; i++) archive(String(i).padStart(3, '0'), 'tasks', 'task', 'admin', AT)
    const first = await page()
    archive('newer', 'tasks', 'task', 'admin', '2026-10-27T00:00:00.000Z')
    const second = await follow(first.next!)
    expect(new Set([...ids(first), ...ids(second)]).size).toBe(100)
    expect(ids(second)).not.toContain('archive:newer')
    expect(ids(second)).toEqual(Array.from({ length: 50 }, (_, i) => `archive:${String(54 - i).padStart(3, '0')}`))
  })

  it('preserves every filter in Next/Previous and renders the selected values and range', async () => {
    for (let i = 0; i < 105; i++) {
      const id = `project-${i}`
      harness.sqlite.prepare(`INSERT INTO projects (id, slug, name, status, archived_at) VALUES (?, ?, 'Viamar', 'archived', ?)`).run(id, id, OLD)
      archive(id, 'projects', id)
    }
    const query = 'kind=archive&table=projects&actor=me&q=Viamar&from=2026-10-09&to=2026-10-21&undoable=1'
    const first = await page(query)
    const second = await follow(first.next!)
    for (const href of [first.next!, second.previous!, second.next!]) {
      const actual = params(href)
      for (const [key, value] of new URLSearchParams(query)) expect(actual.get(key)).toBe(value)
    }
    const body = String(await changesBody(second.changes, true, '', Date.now(), second))
    expect(body).toContain('Showing 51–100')
    expect(body).toContain('More changes exist')
    expect(body).toContain('<option value="archive" selected>')
    expect(body.match(/ selected>/g)).toHaveLength(3)
    expect(body).not.toContain('<option value="unarchive" selected>')
    expect(body).toContain('<input type="checkbox" name="undoable" value="1" checked>')
    expect(body).toContain('rel="prev"')
    expect(body).toContain('rel="next"')
    expect(ids(await follow(second.previous!))).toEqual(ids(first))
  })

  it('ignores malformed cursors and cursors from different filters', async () => {
    seedPages()
    const first = await page()
    expect(ids(await page('cursor=broken'))).toEqual(ids(first))
    const changed = params(first.next!)
    changed.set('kind', 'archive')
    expect(ids(await loadRecentChangesPage(env, admin, changed))).toEqual(ids(await page('kind=archive')))
  })

  it('never reuses an admin cursor to reveal other members’ rows to a non-admin', async () => {
    seedPages()
    const first = await page()
    expect(ids(await follow(first.next!, plain))).toEqual([])
  })

  it('uses ordered source indexes without temporary sorting in the default view and cursor ranges', () => {
    const sources = [
      ['archive_receipts', 'r', 'r.created_at', 'r.id', 'archive:', ['r.tenant = ?1'], ['local']],
      ['task_verdicts', 'v', 'v.decided_at', 'v.id', 'verdict:', [], []],
      ['verdict_reversals', 'vr', 'vr.created_at', 'vr.id', 'info:reversal:', ['vr.tenant = ?1'], ['local']],
      ['agent_audit', 'a', 'a.created_at', 'a.id', 'info:agent_audit:', [], []],
    ] as const
    for (const [table, alias, at, id, prefix, visibility, values] of sources) {
      for (const direction of ['next', 'previous', null] as const) {
        const query = changeSourceQuery({
          select: `SELECT ${alias}.* FROM ${table} ${alias}`, visibility: [...visibility], values: [...values],
          filters: changeFilters(), cursor: direction ? { at: AT, id: `${prefix}001`, position: 50, direction } : null,
          prefix, at, id, search: [],
        })
        const details = harness.sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql.replace(/\?\d+/g, '?')}`).all(...query.values).map((r) => String(r.detail)).join('\n')
        expect(details).toContain('_changes')
        expect(details).not.toContain('TEMP B-TREE')
        expect(query.sql).not.toContain('OFFSET')
      }
    }
  })
})

it('GET /changes applies query params, returns no-store, and gives an empty-state next step', async () => {
  archive('viamar')
  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()
  app.use('*', async (c, next) => { c.set('auth', admin); await next() })
  app.route('/', makeChangesApp((_env, _title, body) => html`${body}`))
  const found = await app.request('/changes?q=Viamar&kind=archive', {}, env)
  expect(found.headers.get('cache-control')).toBe('no-store')
  expect(await found.text()).toContain('You archived the project')
  const empty = await app.request('/changes?q=missing', {}, env)
  const text = await empty.text()
  expect(text).toContain('No changes found')
  expect(text).toContain('Clear filters or widen the date range')
  expect(text).not.toContain('You archived the project')
  expect(text).not.toMatch(/<input[^>]*type="checkbox"[^>]*checked/)
  expect(text.match(/ selected>/g)).toHaveLength(3)
})
