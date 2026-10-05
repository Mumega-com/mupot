// tests/mcp-task-get.test.ts — task_get (single-row MCP reader) rides the shared
// task-visibility chokepoint (src/tasks/visibility.ts, mupot#1647) and nothing else.
//
// DEFECT CLASS: a new reader that re-derives its own visibility predicate leaks. So the proof
// is AGREEMENT: for every caller in a real-grant matrix and every task row, task_get succeeds
// exactly when task_list (the reference reader) lists that row, and every refusal is
// byte-identical to the answer for an id that does not exist. REAL migration chain, REAL rows,
// STRICT bind-count wrapper (the sqlite double silently drops surplus binds real D1 rejects).

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHomeForMember } from '../src/org/service'
import { invokeTool, TOOLS } from '../src/mcp'
import { resolveCapabilities } from '../src/auth/capability'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'mumega'
const ORIGIN = 'https://pot.test'

function strictBindingEnv(env: Env): { env: Env; violations: string[] } {
  const violations: string[] = []
  const realDb = env.DB
  const check = (sql: string, values: unknown[]): void => {
    const indexes = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]))
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
          if (prop === 'bind') return (...values: unknown[]) => { check(sql, values); return target.bind(...values) }
          const value = Reflect.get(target, prop, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
    batch: (statements: D1PreparedStatement[]) => realDb.batch(statements),
  } as unknown as D1Database
  return { env: { ...env, DB: db } as Env, violations }
}

let harness: SqliteD1Harness
let strict: { env: Env; violations: string[] }

const SQ_A = 'sq-a'
const SQ_B = 'sq-b'
const DEPT_WORK = 'dept-work'
const MISSING = 'no-such-task'

// [task id, squad key, status]; t-a-archived carries a tasks_archive_state row.
const TASKS: Array<[string, string, string]> = [
  ['t-a-open', SQ_A, 'open'],
  ['t-a-review', SQ_A, 'review'],
  ['t-a-archived', SQ_A, 'review'],
  ['t-b-open', SQ_B, 'open'],
  ['t-home-owner', 'HOME_OWNER', 'open'],
  ['t-home-victim', 'HOME_VICTIM', 'review'],
]
const SQUAD_IDS = (): string[] => [SQ_A, SQ_B, homeOwner, homeVictim]
let homeOwner: string
let homeVictim: string

function authFor(memberId: string, capabilities: CapabilityGrant[] | undefined, extra: Partial<AuthContext> = {}): AuthContext {
  return { userId: memberId, memberId, email: null, role: 'member', tenant: TENANT, channel: 'workspace', boundAgentId: null, capabilities, ...extra }
}

interface Caller { name: string; auth: () => Promise<AuthContext>; visible: string[] }

function callers(): Caller[] {
  const real = (m: string, extra: Partial<AuthContext> = {}) => async () => authFor(m, await resolveCapabilities(strict.env, m), extra)
  return [
    { name: 'org member (home squads excluded)', auth: real('m-org-member'), visible: ['t-a-open', 't-a-review', 't-b-open'] },
    { name: 'org admin (home squads excluded)', auth: real('m-org-admin'), visible: ['t-a-open', 't-a-review', 't-b-open'] },
    { name: 'org observer (below member)', auth: real('m-org-observer'), visible: [] },
    { name: 'squad-A member', auth: real('m-squad-a'), visible: ['t-a-open', 't-a-review'] },
    { name: 'squad-B observer', auth: real('m-squad-b-observer'), visible: [] },
    { name: 'department member on the work dept', auth: real('m-dept-work'), visible: ['t-a-open', 't-a-review', 't-b-open'] },
    { name: 'department member on the victim HOME dept (poisoned grant)', auth: real('m-dept-home'), visible: [] },
    { name: 'home owner (exact grant on own home)', auth: real('m-home-owner'), visible: ['t-home-owner'] },
    { name: 'legacy role owner, capabilities unloaded, no member', auth: async () => authFor('legacy', undefined, { role: 'owner', memberId: undefined }), visible: ['t-a-open', 't-a-review', 't-b-open'] },
    { name: 'REST owner session: caps unloaded, memberId set, has a home', auth: async () => authFor('m-home-owner', undefined, { role: 'owner' }), visible: ['t-a-open', 't-a-review', 't-b-open', 't-home-owner'] },
    { name: 'role admin, capabilities LOADED but empty', auth: async () => authFor('m-none', [], { role: 'admin' }), visible: [] },
    { name: 'latentCapabilities only (never ambient)', auth: async () => authFor('m-latent', [], { latentCapabilities: [{ member_id: 'm-latent', scope_type: 'org', scope_id: null, capability: 'admin' }] }), visible: [] },
  ]
}

async function seedMember(id: string): Promise<void> {
  await harness.db.prepare(
    `INSERT INTO members (id, tenant, email, display_name, status, created_at) VALUES (?1, ?2, NULL, ?1, 'active', datetime('now'))`,
  ).bind(id, TENANT).run()
}
async function seedCap(id: string, memberId: string, scope: string, scopeId: string | null, capability: string): Promise<void> {
  await harness.db.prepare(
    `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(id, memberId, scope, scopeId, capability).run()
}

beforeAll(async () => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  const baseEnv = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
  strict = strictBindingEnv(baseEnv)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('${DEPT_WORK}', 'work', 'Work');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQ_A}', '${DEPT_WORK}', 'a', 'A'), ('${SQ_B}', '${DEPT_WORK}', 'b', 'B');
  `)
  for (const m of ['m-org-member', 'm-org-admin', 'm-org-observer', 'm-squad-a', 'm-squad-b-observer', 'm-dept-work', 'm-dept-home', 'm-home-owner', 'm-victim', 'm-none', 'm-latent', 'm-archiver', 'm-gate']) await seedMember(m)
  const oh = await createHomeForMember(baseEnv, 'm-home-owner')
  const vh = await createHomeForMember(baseEnv, 'm-victim')
  if (!oh.ok || !vh.ok) throw new Error('home setup failed')
  homeOwner = oh.squad.id
  homeVictim = vh.squad.id
  await seedCap('c1', 'm-org-member', 'org', null, 'member')
  await seedCap('c2', 'm-org-admin', 'org', null, 'admin')
  await seedCap('c3', 'm-org-observer', 'org', null, 'observer')
  await seedCap('c4', 'm-squad-a', 'squad', SQ_A, 'member')
  await seedCap('c5', 'm-squad-b-observer', 'squad', SQ_B, 'observer')
  await seedCap('c6', 'm-dept-work', 'department', DEPT_WORK, 'member')
  await seedCap('c7', 'm-dept-home', 'department', vh.squad.department_id, 'member')
  const insert = harness.sqlite.prepare('INSERT INTO tasks (id, squad_id, title, status, body, done_when) VALUES (?, ?, ?, ?, ?, ?)')
  for (const [id, squad, status] of TASKS) {
    const squadId = squad === 'HOME_OWNER' ? homeOwner : squad === 'HOME_VICTIM' ? homeVictim : squad
    insert.run(id, squadId, `title ${id}`, status, `body ${id}`, `done ${id}`)
  }
  harness.sqlite.prepare(
    `INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status)
     VALUES ('t-a-archived', datetime('now'), 'fixture', 'm-archiver', 'review')`,
  ).run()
})
afterAll(() => harness.close())

type Outcome = Awaited<ReturnType<typeof invokeTool>>
const get = async (a: AuthContext, taskId: string): Promise<Outcome> => invokeTool(a, strict.env, 'task_get', { task_id: taskId }, ORIGIN)

describe('task_get — registration', () => {
  it('is registered at the member floor with the same scope as task_list', () => {
    const spec = TOOLS.find((t) => t.name === 'task_get')
    const ref = TOOLS.find((t) => t.name === 'task_list')
    expect(spec?.min).toBe('member')
    expect(spec?.scope).toBe(ref?.scope)
  })
  it('rejects a missing task_id with 400 invalid_args', async () => {
    const res = await invokeTool(authFor('m-org-member', await resolveCapabilities(strict.env, 'm-org-member')), strict.env, 'task_get', {}, ORIGIN)
    expect(res.ok).toBe(false)
  })
})

describe('task_get — visibility agrees with the chokepoint-backed reference reader (task_list)', () => {
  for (const c of callers()) {
    it(`${c.name}: reads exactly the visible set; every other id is byte-identical to a missing id`, async () => {
      const a = await c.auth()
      const missing = await get(a, MISSING)
      // the floor itself (invokeTool) may refuse a caller outright; then EVERY id must refuse identically
      for (const [id] of TASKS) {
        const res = await get(a, id)
        if (c.visible.includes(id)) {
          expect(res.ok, `${id} should be readable`).toBe(true)
          expect((res as { result: { task: { id: string } } }).result.task.id).toBe(id)
        } else {
          expect(res, `${id} must be indistinguishable from a nonexistent id`).toEqual(missing)
        }
      }
      expect(missing.ok).toBe(false)
      // agreement with task_list, squad by squad
      const listed: string[] = []
      for (const sq of SQUAD_IDS()) {
        const res = await invokeTool(a, strict.env, 'task_list', { squad_id: sq, limit: 100 }, ORIGIN)
        if (res.ok) listed.push(...(res.result as { tasks: Array<{ id: string }> }).tasks.map((t) => t.id))
      }
      expect(listed.sort()).toEqual([...c.visible].sort())
    })
  }

  it('archived task: refused like task_list (not listed, not_found), even for an org admin', async () => {
    const a = await callers()[1]!.auth()
    const res = await get(a, 't-a-archived')
    expect(res).toEqual(await get(a, MISSING))
    const list = await invokeTool(a, strict.env, 'task_list', { squad_id: SQ_A, limit: 100 }, ORIGIN)
    expect((list.result as { tasks: Array<{ id: string }> }).tasks.map((t) => t.id)).not.toContain('t-a-archived')
  })

  it('victim home task: not readable by org admin, org member, or poisoned home-dept grant', async () => {
    for (const name of ['org admin (home squads excluded)', 'org member (home squads excluded)', 'department member on the victim HOME dept (poisoned grant)']) {
      const a = await callers().find((c) => c.name === name)!.auth()
      expect(await get(a, 't-home-victim')).toEqual(await get(a, MISSING))
    }
  })

  it('no statement in any of the above bound a count that differs from its placeholders', () => {
    expect(strict.violations).toEqual([])
  })
})

describe('task_get — payload', () => {
  const FIELDS = ['id', 'squad_id', 'project_id', 'title', 'body', 'done_when', 'status', 'assignee_agent_id', 'assignee_member_id',
    'gate_owner', 'result', 'execution_receipt_id', 'completed_at', 'created_at', 'updated_at']

  it('returns exactly the documented row fields, null verdict and null receipt when none exist', async () => {
    const a = await callers()[0]!.auth()
    const res = await get(a, 't-a-open')
    expect(res.ok).toBe(true)
    const r = (res as { result: { task: Record<string, unknown>; latest_verdict: unknown; latest_dispatch_receipt: unknown } }).result
    expect(Object.keys(r.task).sort()).toEqual([...FIELDS].sort())
    expect(r.task.title).toBe('title t-a-open')
    expect(r.latest_verdict).toBeNull()
    expect(r.latest_dispatch_receipt).toBeNull()
  })

  const HASH = 'a'.repeat(64)
  const bound = async (): Promise<AuthContext> =>
    authFor('m-squad-a', await resolveCapabilities(strict.env, 'm-squad-a'), { boundAgentId: 'ag-1' })

  function seedRuntimeReceipt(id: string, dispatchId: string, stage: string, createdAt: string): void {
    harness.sqlite.exec('PRAGMA foreign_keys = OFF')
    harness.sqlite.exec(`
      INSERT INTO task_dispatch_runtime_receipts (id, tenant, dispatch_receipt_id, task_id, agent_id, message_id, member_id, credential_id,
        stage, attempt, runtime_address, runtime_receipt_hash, request_digest, result, reason, audit_entry_id, created_at)
      VALUES ('${id}', '${TENANT}', '${dispatchId}', 't-a-review', 'ag-1', 'msg-1', 'm-gate', 'tok-1', '${stage}', 1, 'rt', '${HASH}', '${HASH}',
        ${stage === 'completed' ? "'done'" : 'NULL'}, ${stage === 'failed' ? "'boom'" : 'NULL'}, 'audit-${id}', '${createdAt}')`)
    harness.sqlite.exec('PRAGMA foreign_keys = ON')
  }

  it('returns the LATEST verdict (canonical order, display name) and, for the assignee, the latest dispatch receipt', async () => {
    harness.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('ag-1', '${SQ_A}', 'ag1', 'Agent One', 'inactive')`)
    harness.sqlite.exec(`UPDATE tasks SET assignee_agent_id = 'ag-1' WHERE id = 't-a-review'`)
    harness.sqlite.exec(`
      INSERT INTO task_verdicts (id, task_id, verdict, decided_by, decided_at) VALUES
        ('v-old', 't-a-review', 'rejected', 'm-gate', '2026-01-01T00:00:00Z'),
        ('v-new', 't-a-review', 'approved', 'ag-1', '2026-02-01T00:00:00Z');
    `)
    harness.sqlite.exec(`
      INSERT INTO task_dispatch_receipts (id, tenant, task_id, squad_id, agent_id, actor_kind, actor_id, created_at, claimed_at, consumed_at) VALUES
        ('d-old', '${TENANT}', 't-a-review', '${SQ_A}', 'ag-1', 'member', 'm-gate', '2026-01-01T00:00:00Z', NULL, NULL),
        ('d-new', '${TENANT}', 't-a-review', '${SQ_A}', 'ag-1', 'member', 'm-gate', '2026-02-01T00:00:00Z', '2026-02-01T00:00:01Z', '2026-02-01T00:00:02Z');
    `)
    const res = await get(await bound(), 't-a-review')
    const r = (res as { result: { latest_verdict: unknown; latest_dispatch_receipt: unknown } }).result
    expect(r.latest_verdict).toEqual({ verdict: 'approved', decided_by: 'Agent One', decided_at: '2026-02-01T00:00:00Z', reversed: false, reversed_at: null })
    expect(r.latest_dispatch_receipt).toEqual({ id: 'd-new', status: 'consumed', last_error: null })
    expect(strict.violations).toEqual([])
  })

  it('a human-reversed verdict is reported as reversed, never as a live approval', async () => {
    harness.sqlite.exec(`UPDATE task_verdicts SET reversed_at = '2026-03-01T00:00:00Z' WHERE id = 'v-new'`)
    const res = await get(await bound(), 't-a-review')
    const v = (res as { result: { latest_verdict: { verdict: string; reversed: boolean; reversed_at: string } } }).result.latest_verdict
    expect(v.reversed).toBe(true)
    expect(v.reversed_at).toBe('2026-03-01T00:00:00Z')
  })

  it('a non-assignee squad reader gets latest_dispatch_receipt null (task_list parity)', async () => {
    const a = await callers().find((c) => c.name === 'squad-A member')!.auth() // not agent-bound
    const r = (await get(a, 't-a-review') as { result: { latest_dispatch_receipt: unknown } }).result
    expect(r.latest_dispatch_receipt).toBeNull()
    const otherAgent = authFor('m-squad-a', await resolveCapabilities(strict.env, 'm-squad-a'), { boundAgentId: 'ag-other' })
    expect(((await get(otherAgent, 't-a-review')) as { result: { latest_dispatch_receipt: unknown } }).result.latest_dispatch_receipt).toBeNull()
  })

  it('dispatch status reflects runtime terminal state, and last_error is not hidden when claimed', async () => {
    harness.sqlite.exec(`UPDATE task_dispatch_receipts SET last_error = 'transport hiccup', consumed_at = NULL WHERE id = 'd-new'`)
    let r = (await get(await bound(), 't-a-review') as { result: { latest_dispatch_receipt: unknown } }).result
    expect(r.latest_dispatch_receipt).toEqual({ id: 'd-new', status: 'claimed', last_error: 'transport hiccup' })
    seedRuntimeReceipt('rt-1', 'd-new', 'runtime_consumed', '2026-02-01T00:00:03Z')
    r = (await get(await bound(), 't-a-review') as { result: { latest_dispatch_receipt: unknown } }).result
    expect(r.latest_dispatch_receipt).toEqual({ id: 'd-new', status: 'runtime_consumed', last_error: 'transport hiccup' })
    seedRuntimeReceipt('rt-2', 'd-new', 'failed', '2026-02-01T00:00:04Z')
    r = (await get(await bound(), 't-a-review') as { result: { latest_dispatch_receipt: unknown } }).result
    expect((r.latest_dispatch_receipt as { status: string }).status).toBe('failed')
  })

  it('a task in a squad the caller cannot read never exposes its verdict or receipt', async () => {
    harness.sqlite.exec(`INSERT INTO task_verdicts (id, task_id, verdict, decided_by, decided_at) VALUES ('v-b', 't-b-open', 'approved', 'm-gate', '2026-02-01T00:00:00Z')`)
    const a = await callers().find((c) => c.name === 'squad-A member')!.auth()
    const res = await get(a, 't-b-open')
    expect(res).toEqual(await get(a, MISSING))
    expect(JSON.stringify(res)).not.toContain('v-b')
  })
})
