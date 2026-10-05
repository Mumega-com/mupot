// tests/task-visibility-seam.test.ts — mupot#1647 / #1645.
//
// The seam test for the shared task-visibility chokepoint (src/tasks/visibility.ts).
// REAL migration chain, REAL rows (work + kind='home' squads, a home squad parked inside a
// WORK department, an archived task, project_squad_access edges, tasks moved between squads and
// projects after creation, real capability rows resolved through resolveCapabilities, a revoked
// grant), and a STRICT bind-count wrapper on every statement (the shared sqlite double silently
// drops surplus binds that real D1 rejects, mupot#1642).
//
// For every caller the canonical visible id set is written out LITERALLY below, and every
// migrated reader (task_list, GET /tasks, project_context, the activity task rows) plus the
// chokepoint's own three faces (scope list, SQL clause, canReadTask) must return exactly it.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHomeForMember } from '../src/org/service'
import { invokeTool } from '../src/mcp'
import { loadProjectDetail } from '../src/dashboard/projects'
import { resolveCapabilities } from '../src/auth/capability'
import { listTasksForAuth, readTaskForAuth } from '../src/tasks'
import { listProjectActivity } from '../src/projects/projections'
import {
  canReadSquadTasks,
  canReadTask,
  resolveVisibleTaskScope,
  visibleTaskClause,
} from '../src/tasks/visibility'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

// REST project routes read the session through requireAuth; inject the matrix caller.
const authState: { current: AuthContext | null } = { current: null }
vi.mock('../src/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/auth')>()),
  requireAuth: async (
    c: { set: (key: 'auth', value: AuthContext) => void; json: (body: unknown, status: 401) => Response },
    next: () => Promise<void>,
  ) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
}))
const { projectsApp } = await import('../src/projects')

const TENANT = 'mumega'
const ORIGIN = 'https://pot.test'

// D1 rejects a bind count that differs from the highest placeholder index; the sqlite double
// drops the surplus silently. Record every violation and assert there are none.
function strictBindingEnv(env: Env): { env: Env; violations: string[] } {
  const violations: string[] = []
  const realDb = env.DB
  const check = (sql: string, values: unknown[]): void => {
    const indexes = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]))
    // Numbered placeholders: highest index. Legacy anonymous `?` readers elsewhere in the
    // codebase: count of bare `?` (D1 accepts those, sequentially).
    const count = indexes.length > 0 ? Math.max(...indexes) : (sql.match(/\?/g) ?? []).length
    if (values.length !== count) {
      violations.push(`bound ${values.length} values, SQL declares ${count}: ${sql.replace(/\s+/g, ' ').slice(0, 90)}`)
    }
  }
  const db = {
    prepare(sql: string) {
      const stmt = realDb.prepare(sql)
      return new Proxy(stmt, {
        get(target, prop) {
          if (prop === 'bind') {
            return (...values: unknown[]) => { check(sql, values); return target.bind(...values) }
          }
          const value = Reflect.get(target, prop, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
    batch: (statements: D1PreparedStatement[]) => realDb.batch(statements),
  } as unknown as D1Database
  return { env: { ...env, DB: db } as Env, violations }
}

// Same DB, but the routine-schema probe answers "tables absent": drives the rolling-deploy
// (routines-not-ready) needs-you branch of loadProjectSituation.
function withoutRoutineTables(env: Env): Env {
  const realDb = env.DB
  const db = {
    prepare(sql: string) {
      if (sql.includes('sqlite_master') && sql.includes('routine_runs')) {
        const stub = { bind: () => stub, all: async () => ({ results: [{ count: 0 }] }) }
        return stub as unknown as D1PreparedStatement
      }
      return realDb.prepare(sql)
    },
    batch: (statements: D1PreparedStatement[]) => realDb.batch(statements),
  } as unknown as D1Database
  return { ...env, DB: db } as Env
}

let harness: SqliteD1Harness
let strict: { env: Env; violations: string[] }
let homeSquadOwner: string
let homeSquadVictim: string
let homeDeptVictim: string

// ── fixture ids ──────────────────────────────────────────────────────────────
const SQ_A = 'sq-a'
const SQ_B = 'sq-b'
const SQ_C = 'sq-c'
const SQ_HOME_IN_WORK = 'sq-home-in-work'
const DEPT_WORK = 'dept-work'
const DEPT_OTHER = 'dept-other'
const P1 = 'proj-1'
const P2 = 'proj-2'

// task id -> [squad, project, status]; t-archived carries a tasks_archive_state row.
const TASKS: Array<[string, string, string, string]> = [
  ['t-a-open', SQ_A, P1, 'open'],
  ['t-a-review', SQ_A, P1, 'review'],
  ['t-a-archived', SQ_A, P1, 'review'], // archived: status unchanged, side-table state
  ['t-b-blocked', SQ_B, P1, 'blocked'],
  ['t-c-open', SQ_C, P2, 'open'],
  ['t-moved', SQ_B, P2, 'in_progress'], // created in sq-a / proj-1, moved to sq-b / proj-2 afterwards
  ['t-a-p2', SQ_A, P2, 'open'], // readable squad, but NO project_squad_access edge sq-a -> proj-2
  ['t-home-owner', 'HOME_OWNER', P1, 'open'],
  ['t-home-victim', 'HOME_VICTIM', P1, 'review'],
  ['t-home-in-work', SQ_HOME_IN_WORK, P1, 'open'],
]

const ORG_WIDE = ['t-a-open', 't-a-review', 't-b-blocked', 't-c-open', 't-moved', 't-a-p2']

function grant(memberId: string, scope_type: 'org' | 'department' | 'squad', scope_id: string | null, capability: CapabilityGrant['capability']): CapabilityGrant {
  return { member_id: memberId, scope_type, scope_id, capability }
}

function authFor(memberId: string, capabilities: CapabilityGrant[] | undefined, extra: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: memberId,
    memberId,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: null,
    capabilities,
    ...extra,
  }
}

interface Caller {
  name: string
  auth: () => Promise<AuthContext>
  /** Canonical visible set across ALL projects (literal). */
  visible: string[]
  /** Canonical visible set within a project, squad by squad (task_list; GET /tasks with an
   *  explicit squad): the project needs a project_squad_access edge to THAT squad unless the
   *  caller is on the org-admin plane (literal). */
  p1: string[]
  p2: string[]
  /** GET /tasks?project_id= WITHOUT a squad: an edge to ANY squad in scope selects the project.
   *  Defaults to p1/p2. Differs from the per-squad answer where a readable squad has no edge:
   *  a pre-existing task_list vs GET /tasks disagreement that discloses no unreadable row
   *  (see docs/architecture/task-visibility.md, finding F2). */
  p1Any?: string[]
  p2Any?: string[]
}

async function seedMember(id: string): Promise<void> {
  await harness.db.prepare(
    `INSERT INTO members (id, tenant, email, display_name, status, created_at)
     VALUES (?1, ?2, NULL, ?1, 'active', datetime('now'))`,
  ).bind(id, TENANT).run()
}

async function seedCap(id: string, memberId: string, scope: string, scopeId: string | null, capability: string): Promise<void> {
  await harness.db.prepare(
    `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(id, memberId, scope, scopeId, capability).run()
}

// The matrix. Every set is literal on purpose: a predicate removed from the chokepoint changes
// one of these and the matching reader goes red.
function callers(): Caller[] {
  const real = (memberId: string) => async () => authFor(memberId, await resolveCapabilities(strict.env, memberId))
  return [
    { name: 'org admin (org-scope admin grant)', auth: real('m-org-admin'), visible: ORG_WIDE,
      p1: ['t-a-open', 't-a-review', 't-b-blocked'], p2: ['t-c-open', 't-moved', 't-a-p2'] },
    { name: 'org member', auth: real('m-org-member'), visible: ORG_WIDE,
      // not an org admin: the project needs an edge (sq-a has none to proj-2)
      p1: ['t-a-open', 't-a-review', 't-b-blocked'], p2: ['t-c-open', 't-moved'],
      p2Any: ['t-c-open', 't-moved', 't-a-p2'] },
    { name: 'org observer (below member)', auth: real('m-org-observer'), visible: [], p1: [], p2: [] },
    { name: 'legacy role admin, capabilities UNLOADED', auth: async () => authFor('legacy-admin', undefined, { role: 'admin', memberId: undefined }),
      visible: ORG_WIDE, p1: ['t-a-open', 't-a-review', 't-b-blocked'], p2: ['t-c-open', 't-moved', 't-a-p2'] },
    { name: 'legacy role owner, capabilities UNLOADED', auth: async () => authFor('legacy-owner', undefined, { role: 'owner', memberId: undefined }),
      visible: ORG_WIDE, p1: ['t-a-open', 't-a-review', 't-b-blocked'], p2: ['t-c-open', 't-moved', 't-a-p2'] },
    { name: 'legacy role admin, capabilities LOADED but empty', auth: async () => authFor('m-none', [], { role: 'admin' }),
      visible: [], p1: [], p2: [] },
    { name: 'legacy role admin, capabilities LOADED with one squad grant', auth: async () => authFor('m-squad-a', await resolveCapabilities(strict.env, 'm-squad-a'), { role: 'admin' }),
      visible: ['t-a-open', 't-a-review', 't-a-p2'], p1: ['t-a-open', 't-a-review'], p2: [] },
    { name: 'squad-A member', auth: real('m-squad-a'), visible: ['t-a-open', 't-a-review', 't-a-p2'], p1: ['t-a-open', 't-a-review'], p2: [] },
    { name: 'squad-B observer', auth: real('m-squad-b-observer'), visible: [], p1: [], p2: [] },
    { name: 'department-scope member on a WORK department that also holds a home squad', auth: real('m-dept-work'),
      visible: ['t-a-open', 't-a-review', 't-b-blocked', 't-moved', 't-a-p2'], p1: ['t-a-open', 't-a-review', 't-b-blocked'], p2: ['t-moved'],
      p2Any: ['t-moved', 't-a-p2'] },
    { name: 'department-scope member on the victim HOME department (poisoned legacy grant)', auth: real('m-dept-home'),
      visible: [], p1: [], p2: [] },
    { name: 'home owner (exact admin grant on own home squad)', auth: async () => authFor('m-home-owner', await resolveCapabilities(strict.env, 'm-home-owner')),
      visible: ['t-home-owner'], p1: ['t-home-owner'], p2: [] },
    { name: 'home owner who is ALSO an org member', auth: real('m-home-owner-org'),
      visible: [...ORG_WIDE, 't-home-owner-org'], p1: ['t-a-open', 't-a-review', 't-b-blocked', 't-home-owner-org'], p2: ['t-c-open', 't-moved'],
      p2Any: ['t-c-open', 't-moved', 't-a-p2'] },
    // The REST owner/admin cookie session: role owner/admin, capabilities NOT loaded (auth/index.ts
    // loads them only for role 'member') but memberId set. The role plane still skips homes; the
    // owner's exact admin grant on their OWN home must still resolve from D1 (old canActOnSquad).
    { name: 'REST owner session: role owner, capabilities unloaded, memberId set, has a home',
      auth: async () => authFor('m-home-owner', undefined, { role: 'owner' }),
      visible: [...ORG_WIDE, 't-home-owner'], p1: ['t-a-open', 't-a-review', 't-b-blocked', 't-home-owner'], p2: ['t-c-open', 't-moved', 't-a-p2'] },
    { name: 'REST admin session: role admin, capabilities unloaded, memberId set, has a home',
      auth: async () => authFor('m-home-owner', undefined, { role: 'admin' }),
      visible: [...ORG_WIDE, 't-home-owner'], p1: ['t-a-open', 't-a-review', 't-b-blocked', 't-home-owner'], p2: ['t-c-open', 't-moved', 't-a-p2'] },
    { name: 'role member, capabilities unloaded, no memberId, latentCapabilities org admin (never ambient)',
      auth: async () => authFor('m-latent', undefined, { memberId: undefined, latentCapabilities: [grant('m-latent', 'org', null, 'admin')] }),
      visible: [], p1: [], p2: [] },
    { name: 'no grants', auth: async () => authFor('m-none', []), visible: [], p1: [], p2: [] },
    { name: 'agent-bound with latentCapabilities only (directory B1 ceiling)',
      auth: async () => authFor('m-latent', [], { boundAgentId: 'agent-latent', latentCapabilities: [grant('m-latent', 'org', null, 'admin')] }),
      visible: [], p1: [], p2: [] },
    { name: 'member whose grant was REVOKED (row deleted)', auth: real('m-revoked'), visible: [], p1: [], p2: [] },
  ]
}

beforeAll(async () => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  const baseEnv = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
  strict = strictBindingEnv(baseEnv)

  const runSql = (sql: string) => harness.sqlite.exec(sql)
  runSql(`
    INSERT INTO departments (id, slug, name) VALUES ('${DEPT_WORK}', 'work', 'Work'), ('${DEPT_OTHER}', 'other', 'Other');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('${SQ_A}', '${DEPT_WORK}', 'a', 'A'), ('${SQ_B}', '${DEPT_WORK}', 'b', 'B'), ('${SQ_C}', '${DEPT_OTHER}', 'c', 'C');
    INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('${SQ_HOME_IN_WORK}', '${DEPT_WORK}', 'home-in-work', 'Home in work', 'home');
  `)
  for (const m of ['m-org-admin', 'm-org-member', 'm-org-observer', 'm-squad-a', 'm-squad-b-observer', 'm-dept-work',
    'm-dept-home', 'm-home-owner', 'm-home-owner-org', 'm-victim', 'm-none', 'm-latent', 'm-revoked', 'm-archiver']) {
    await seedMember(m)
  }
  const ownerHome = await createHomeForMember(baseEnv, 'm-home-owner')
  const ownerOrgHome = await createHomeForMember(baseEnv, 'm-home-owner-org')
  const victimHome = await createHomeForMember(baseEnv, 'm-victim')
  if (!ownerHome.ok || !ownerOrgHome.ok || !victimHome.ok) throw new Error('home setup failed')
  homeSquadOwner = ownerHome.squad.id
  homeSquadVictim = victimHome.squad.id
  homeDeptVictim = victimHome.squad.department_id
  const ownerOrgHomeId = ownerOrgHome.squad.id

  await seedCap('c1', 'm-org-admin', 'org', null, 'admin')
  await seedCap('c2', 'm-org-member', 'org', null, 'member')
  await seedCap('c3', 'm-org-observer', 'org', null, 'observer')
  await seedCap('c4', 'm-squad-a', 'squad', SQ_A, 'member')
  await seedCap('c5', 'm-squad-b-observer', 'squad', SQ_B, 'observer')
  await seedCap('c6', 'm-dept-work', 'department', DEPT_WORK, 'member')
  await seedCap('c7', 'm-dept-home', 'department', homeDeptVictim, 'member')
  await seedCap('c8', 'm-home-owner-org', 'org', null, 'member')
  await seedCap('c9', 'm-revoked', 'org', null, 'admin')
  await harness.db.prepare(`DELETE FROM capabilities WHERE id = 'c9'`).run() // revoked = row gone

  runSql(`
    INSERT INTO projects (id, slug, name, status) VALUES ('${P1}', 'p1', 'P1', 'active'), ('${P2}', 'p2', 'P2', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
      ('${P1}', '${SQ_A}', 'write'), ('${P1}', '${SQ_B}', 'write'), ('${P1}', '${homeSquadOwner}', 'write'),
      ('${P1}', '${homeSquadVictim}', 'write'), ('${P1}', '${SQ_HOME_IN_WORK}', 'write'), ('${P1}', '${ownerOrgHomeId}', 'write'),
      ('${P2}', '${SQ_C}', 'write'), ('${P2}', '${SQ_B}', 'write');
  `)
  // t-a-p2: a task lands in proj-2 while sq-a still has an edge, then the edge is revoked
  // (the insert trigger refuses a task on a project the squad has no edge to).
  runSql(`INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('${P2}', '${SQ_A}', 'write')`)
  const insert = harness.sqlite.prepare('INSERT INTO tasks (id, squad_id, title, status, project_id) VALUES (?, ?, ?, ?, ?)')
  for (const [id, squad, project, status] of TASKS) {
    const squadId = squad === 'HOME_OWNER' ? homeSquadOwner : squad === 'HOME_VICTIM' ? homeSquadVictim : squad
    insert.run(id, squadId, `title ${id}`, status, project)
  }
  insert.run('t-home-owner-org', ownerOrgHomeId, 'title t-home-owner-org', 'open', P1)
  // t-moved: created on sq-a / proj-1, then moved (the squad/project columns are mutable).
  // The insert above already holds its final location; assert the move really is a move.
  runSql(`DELETE FROM project_squad_access WHERE project_id = '${P2}' AND squad_id = '${SQ_A}'`)
  harness.sqlite.prepare("UPDATE tasks SET squad_id = ?, project_id = ? WHERE id = 't-moved'").run(SQ_A, P1)
  harness.sqlite.prepare("UPDATE tasks SET squad_id = ?, project_id = ? WHERE id = 't-moved'").run(SQ_B, P2)
  // every review/blocked task is gated, so the situation's needs-you slice sees it
  harness.sqlite.prepare("UPDATE tasks SET gate_owner = 'gate:seam' WHERE status IN ('review', 'blocked')").run()
  // an archived approved gate:content task with a result: the needs-you "publishable output" slice
  runSql(`INSERT INTO tasks (id, squad_id, title, status, project_id, gate_owner, result)
          VALUES ('t-a-archived-pub', '${SQ_A}', 'title t-a-archived-pub', 'approved', '${P1}', 'gate:content', 'published body')`)
  // ...and an archived gated unassigned blocked task: the "blocked_task" needs-you slice
  runSql(`INSERT INTO tasks (id, squad_id, title, status, project_id, gate_owner)
          VALUES ('t-b-archived-blocked', '${SQ_B}', 'title t-b-archived-blocked', 'blocked', '${P1}', 'gate:seam')`)
  for (const archivedId of ['t-a-archived', 't-a-archived-pub', 't-b-archived-blocked']) {
    harness.sqlite.prepare(
      `INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status)
       VALUES (?, datetime('now'), 'seam fixture', 'm-archiver', 'review')`,
    ).run(archivedId)
  }
})

afterAll(() => harness.close())

function ids(rows: Array<{ id: string }>): string[] {
  return rows.map((r) => r.id).sort()
}

describe('task-visibility seam matrix (every migrated reader == the canonical set)', () => {
  for (const make of callers()) {
    describe(make.name, () => {
      const expected = [...make.visible].sort()

      it('chokepoint scope list -> SQL clause -> canReadTask all agree with the literal set', async () => {
        const auth = await make.auth()
        const scope = await resolveVisibleTaskScope(strict.env, auth)
        expect(Array.isArray(scope.squadIds)).toBe(true)
        const clause = visibleTaskClause(scope, 1)
        const rows = await strict.env.DB.prepare(`SELECT id FROM tasks WHERE ${clause.sql}`).bind(...clause.binds).all<{ id: string }>()
        expect(ids(rows.results ?? [])).toEqual(expected)

        const all = await strict.env.DB.prepare('SELECT id, squad_id FROM tasks').all<{ id: string; squad_id: string }>()
        const readable: string[] = []
        for (const t of all.results ?? []) if (await canReadTask(strict.env, auth, t)) readable.push(t.id)
        expect(readable.sort()).toEqual(expected)
        // single-squad twin agrees with the list for every squad
        const squads = await strict.env.DB.prepare('SELECT id FROM squads').all<{ id: string }>()
        for (const sq of squads.results ?? []) {
          expect(await canReadSquadTasks(strict.env, auth, sq.id)).toBe(scope.squadIds.includes(sq.id))
        }
      })

      it('GET /tasks (listTasksForAuth) returns exactly the set, unfiltered and per project', async () => {
        const auth = await make.auth()
        const get = async (q: { projectId?: string; squadId?: string } = {}) => {
          const res = await listTasksForAuth(strict.env, auth, q)
          if (res.status !== 200) return []
          return ids((await res.json() as { tasks: Array<{ id: string }> }).tasks)
        }
        expect(await get()).toEqual(expected)
        expect(await get({ projectId: P1 })).toEqual([...(make.p1Any ?? make.p1)].sort())
        expect(await get({ projectId: P2 })).toEqual([...(make.p2Any ?? make.p2)].sort())
        // explicit squad: same answer as task_list for that squad, squad by squad
        const squads = await strict.env.DB.prepare('SELECT id FROM squads').all<{ id: string }>()
        const bySquad: Record<string, string[]> = { [P1]: [], [P2]: [] }
        for (const sq of squads.results ?? []) {
          for (const projectId of [P1, P2]) bySquad[projectId]!.push(...(await get({ squadId: sq.id, projectId })))
        }
        expect(bySquad[P1]!.sort()).toEqual([...make.p1].sort())
        expect(bySquad[P2]!.sort()).toEqual([...make.p2].sort())
      })

      it('GET /tasks/:id reads exactly the canonical set, plus the archived task as a history read', async () => {
        const auth = await make.auth()
        const all = await strict.env.DB.prepare('SELECT id FROM tasks').all<{ id: string }>()
        const readable: string[] = []
        for (const t of all.results ?? []) {
          if ((await readTaskForAuth(strict.env, auth, t.id)).status === 200) readable.push(t.id)
        }
        // an explicit id lookup is archived-inclusive: whoever reads the squad reads its archived task
        const history = [
          ...(expected.includes('t-a-open') ? ['t-a-archived', 't-a-archived-pub'] : []),
          ...(expected.includes('t-b-blocked') ? ['t-b-archived-blocked'] : []),
        ]
        expect(readable.sort()).toEqual([...expected, ...history].sort())
      })

      it('task_list over every squad returns exactly the set (and 403s elsewhere)', async () => {
        const auth = await make.auth()
        const squads = await strict.env.DB.prepare('SELECT id FROM squads').all<{ id: string }>()
        const seen: string[] = []
        for (const sq of squads.results ?? []) {
          const res = await invokeTool(auth, strict.env, 'task_list', { squad_id: sq.id, limit: 100 }, ORIGIN)
          if (!res.ok) continue
          seen.push(...ids((res.result as { tasks: Array<{ id: string }> }).tasks))
        }
        expect(seen.sort()).toEqual(expected)
        for (const [projectId, want] of [[P1, make.p1], [P2, make.p2]] as const) {
          const perProject: string[] = []
          for (const sq of squads.results ?? []) {
            const res = await invokeTool(auth, strict.env, 'task_list', { squad_id: sq.id, project_id: projectId, limit: 100 }, ORIGIN)
            if (res.ok) perProject.push(...ids((res.result as { tasks: Array<{ id: string }> }).tasks))
          }
          expect(perProject.sort()).toEqual([...want].sort())
        }
      })

      const wantStatus = (st: string) => {
        const status = new Map(TASKS.map(([id, , , x]) => [id, x] as const))
        status.set('t-home-owner-org', 'open')
        return make.p1Any ?? make.p1.filter((id) => status.get(id) === st).sort()
      }
      type Situation = {
        task_counts: Record<string, number>
        blockers: Array<{ id: string }>
        pending_reviews: Array<{ id: string }>
        needs_you: { count: number }
      }
      const checkSituation = (situation: Situation) => {
        const want = wantStatus
        expect(situation.task_counts.open).toBe(want('open').length)
        expect(situation.task_counts.review).toBe(want('review').length)
        expect(situation.task_counts.blocked).toBe(want('blocked').length)
        expect(situation.task_counts.in_progress).toBe(want('in_progress').length)
        expect(ids(situation.pending_reviews)).toEqual(want('review'))
        expect(ids(situation.blockers)).toEqual(want('blocked'))
        // needs-you rows are task-derived too (gate_owner'd review + unassigned blocked tasks)
        expect(situation.needs_you.count).toBe(want('review').length + want('blocked').length)
      }
      const wantActivity = () => {
        const w = TASKS.filter(([id, , p]) => p === P1 && expected.includes(id)).map(([id]) => id)
        if (expected.includes('t-home-owner-org')) w.push('t-home-owner-org')
        return w.sort()
      }

      for (const tool of ['project_context', 'project_get'] as const) {
        it(`${tool} situation (#1645) shows only canonical tasks: counts + review/blocked ids`, async () => {
          const res = await invokeTool(await make.auth(), strict.env, tool, { project_id: P1 }, ORIGIN)
          if (!res.ok) { expect(make.p1).toEqual([]); return }
          checkSituation((res.result as { situation: Situation }).situation)
        })
      }

      it('project_context on a pot whose routine tables are not yet applied (needs-you not-ready branch)', async () => {
        const res = await invokeTool(await make.auth(), withoutRoutineTables(strict.env), 'project_context', { project_id: P1 }, ORIGIN)
        if (!res.ok) { expect(make.p1).toEqual([]); return }
        checkSituation((res.result as { situation: Situation }).situation)
      })

      it('dashboard loadProjectDetail: situation and activity task rows are canonical', async () => {
        const view = await loadProjectDetail(strict.env, await make.auth(), P1)
        if (!view) { expect(make.p1).toEqual([]); return }
        checkSituation(view.situation)
        expect(view.activity.rows.filter((r) => r.source_type === 'task').map((r) => r.source_id).sort()).toEqual(wantActivity())
      })

      it('REST GET /projects/:id and /projects/:id/activity are canonical', async () => {
        authState.current = await make.auth()
        const rest = (path: string) => projectsApp.fetch(new Request(`https://pot.test${path}`), strict.env)
        const detail = await rest(`/${P1}`)
        if (detail.status !== 200) { expect(make.p1).toEqual([]); return }
        checkSituation(((await detail.json()) as { situation: Situation }).situation)
        const activity = await rest(`/${P1}/activity?limit=100`)
        expect(activity.status).toBe(200)
        const rows = ((await activity.json()) as { rows: Array<{ source_type: string; source_id: string }> }).rows
        expect(rows.filter((r) => r.source_type === 'task').map((r) => r.source_id).sort()).toEqual(wantActivity())
      })

      it('activity task rows carry exactly the canonical project tasks', async () => {
        const auth = await make.auth()
        const scope = await resolveVisibleTaskScope(strict.env, auth)
        const page = await listProjectActivity(strict.env, {
          projectId: P1, readableSquadIds: null, taskSquadIds: scope.squadIds, limit: 100,
        })
        const taskRows = page.rows.filter((r) => r.source_type === 'task').map((r) => r.source_id).sort()
        // tasks of P1 only; the archived task never appears
        const wantP1 = TASKS.filter(([id, , p]) => p === P1 && expected.includes(id)).map(([id]) => id)
        if (expected.includes('t-home-owner-org')) wantP1.push('t-home-owner-org')
        expect(taskRows).toEqual(wantP1.sort())
      })
    })
  }

  it('every statement in the whole matrix bound exactly the parameters it declares', () => {
    expect(strict.violations).toEqual([])
  })

  it('the fixture really contains what the matrix claims (no vacuous green)', async () => {
    const homeKinds = await harness.db.prepare(`SELECT kind, COUNT(*) AS n FROM squads GROUP BY kind`).all<{ kind: string; n: number }>()
    const byKind = Object.fromEntries((homeKinds.results ?? []).map((r) => [r.kind, r.n]))
    expect(byKind.home).toBeGreaterThanOrEqual(4)
    const archived = await harness.db.prepare(`SELECT t.status FROM tasks t JOIN tasks_archive_state a ON a.task_id = t.id`).all<{ status: string }>()
    expect(archived.results?.[0]?.status).toBe('review') // status unchanged by archive
    const poisoned = await harness.db.prepare(`SELECT 1 FROM capabilities WHERE scope_type = 'department' AND scope_id = ?1`).bind(homeDeptVictim).first()
    expect(poisoned).not.toBeNull()
    const revoked = await harness.db.prepare(`SELECT 1 FROM capabilities WHERE member_id = 'm-revoked'`).first()
    expect(revoked).toBeNull()
  })
})
