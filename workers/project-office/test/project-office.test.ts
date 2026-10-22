// ProjectOffice (Phase 0 spike, docs/plan-project-back-office-20261022) inside real workerd.
//
// Proves:
//   - the Agents SDK class builds and runs on SQLite, in its own Worker
//   - the public RPC surface is EXACTLY the office's own methods: the SDK's (schedule, setState, sql, ...) is unreachable
//   - an object named for a foreign tenant, an unknown/archived project or a sub-agent serves nothing and
//     creates no tables at all (not even the SDK's)
//   - project -> tenant is re-verified from D1 on every wake (evictDurableObject forces a real one) and after a TTL
//   - no client frames, no sub-agent routing, no sockets
//   - scheduleEvery / schedule alarms fire (runDurableObjectAlarm), are idempotent, and the clock stops when the
//     office becomes unbound
//   - destroy-and-rebuild: wipe an office's storage, rebuild the working set from D1, lose nothing auditable
//
// The vitest config binds DB to a database migrated with the repo's COMMITTED chain, sets PROJECT_OFFICE=1 and
// TENANT_SLUG=pot-a.

import { applyD1Migrations, env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import * as entry from '../src/index'
import { ProjectOffice, VERIFY_TTL_MS } from '../src/project-office'
import { projectOfficeName } from '../../../src/projects/office-core'
import { buildNotice, type NoticeFields } from '../../../src/projects/office-contract'

// The bindings come from vitest.config.ts, not from a wrangler config, so `cloudflare:test`'s env has no
// matching type. Casting through unknown is the accepted route (same as tests/composition/d1-batch-visibility.test.ts).
const bindings = env as unknown as {
  PROJECT_OFFICE_DO: DurableObjectNamespace<ProjectOffice>
  DB: D1Database
  TEST_MIGRATIONS: never
}

const TENANT = 'pot-a'
const LIVE = 'proj-live'
const OTHER = 'proj-other'
const PROBED = 'proj-probed' // RPC probes of missing methods leave unsettled stubs: keep them off any office that is evicted later
const INERT = 'proj-inert' // its own office, so sockets and open responses cannot stall another test's eviction

// Results are compared by value through this loose surface (the stub's own types are precise unions).
interface OfficeRpc {
  notice(n: unknown): Promise<Record<string, unknown>>
  prepare(): Promise<Record<string, unknown>>
  dispatch(): Promise<Record<string, unknown>>
  followUp(): Promise<Record<string, unknown>>
  gate(): Promise<Record<string, unknown>>
  remember(): Promise<Record<string, unknown>>
  report(): Promise<Record<string, unknown>>
  rebuild(): Promise<Record<string, unknown>>
  snapshot(): Promise<Record<string, unknown>>
  armFollowUpClock(s: number): Promise<Record<string, unknown>>
}
type Stub = DurableObjectStub<ProjectOffice>

function stubFor(name: string): Stub {
  return bindings.PROJECT_OFFICE_DO.get(bindings.PROJECT_OFFICE_DO.idFromName(name))
}
function office(tenant: string, project: string): Stub {
  return stubFor(projectOfficeName(tenant, project))
}
// Narrowing the stub to the hand-written surface above.
const rpc = (s: Stub): OfficeRpc => s as unknown as OfficeRpc
/** Call an RPC name that must not exist on the office; resolves with the error text, or 'CALLED' if it ran. */
async function probe(s: Stub, name: string, ...args: unknown[]): Promise<string> {
  try {
    await (s as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name](...args)
    return 'CALLED'
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
const NOT_IMPLEMENTED = /does not implement/

/** Reach the facade and its private SDK half. Test-only. */
interface Inner {
  officeAgent: {
    listSchedules(c?: { type?: string }): Promise<{ callback: string; type: string; id: string }[]>
    followUpTick(): Promise<void>
    cancelClocks(): Promise<number>
  } | null
  verifiedAtMs: number
  env: { DB: D1Database; PROJECT_OFFICE?: string }
}
const inner = (o: ProjectOffice): Inner => o as unknown as Inner // private fields, read by tests only

const tables = (s: Stub): Promise<string[]> =>
  runDurableObjectTables(s)
async function runDurableObjectTables(s: Stub): Promise<string[]> {
  return runInDurableObject(s, (_i: ProjectOffice, state) =>
    state.storage.sql
      .exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .toArray()
      .map((r) => String(r.name)),
  )
}

async function ageVerification(s: Stub): Promise<void> {
  await runInDurableObject(s, (i: ProjectOffice) => {
    inner(i).verifiedAtMs -= VERIFY_TTL_MS + 1 // the runtime clock cannot be advanced; rewind the stamp instead
  })
}

// The runtime clock cannot be advanced and the SDK only runs jobs that are due, so make the armed job due the way
// time would: rewind its due time in the SDK's own job table (agents@0.29.0: cf_agents_jobs; a pin bump may rename it).
async function makeJobsDue(s: Stub): Promise<number> {
  return runInDurableObject(s, (_i: ProjectOffice, state) => {
    state.storage.sql.exec(`UPDATE cf_agents_jobs SET time = 1 WHERE fn = 'followUpTick'`)
    return state.storage.sql.exec(`SELECT id FROM cf_agents_jobs WHERE fn = 'followUpTick' AND time = 1`).toArray().length
  })
}
const clocks = (s: Stub): Promise<number> =>
  runInDurableObject(s, async (i: ProjectOffice) => {
    const a = inner(i).officeAgent
    return a ? (await a.listSchedules({ type: 'interval' })).filter((x) => x.callback === 'followUpTick').length : 0
  })
const ticks = (s: Stub): Promise<unknown[]> =>
  runInDurableObject(s, (_i: ProjectOffice, state) =>
    state.storage.sql.exec(`SELECT value FROM office_meta WHERE key = 'ticks'`).toArray().map((r) => r.value),
  )

async function d1Fingerprint(): Promise<unknown[]> {
  const r = await bindings.DB.prepare(`SELECT id, project_id, status, gate_owner, assignee_member_id, updated_at FROM tasks ORDER BY id`).all()
  return r.results
}

async function addProject(id: string, repoUrl: string | null = null): Promise<void> {
  const url = repoUrl === null ? 'NULL' : `'${repoUrl}'`
  await bindings.DB.exec(`INSERT OR IGNORE INTO projects (id, slug, name, goal, status, repo_url) VALUES ('${id}', '${id}', '${id}', 'x', 'active', ${url})`)
}
const OWNS_OR = 'https://github.com/o/r' // the repository the default test notices are scoped to ('github:o/r')

beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS)
  await bindings.DB.exec(
    [
      `INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A')`,
      `INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A')`,
      `INSERT OR IGNORE INTO members (id, tenant, email, display_name, status) VALUES ('mem-1', '${TENANT}', 'm1@example.test', 'Member One', 'active')`,
      `INSERT OR IGNORE INTO projects (id, slug, name, goal, status) VALUES ('${LIVE}', '${LIVE}', 'Live project', 'Ship it', 'active')`,
      `INSERT OR IGNORE INTO projects (id, slug, name, goal, status) VALUES ('${OTHER}', '${OTHER}', 'Other project', 'x', 'active')`,
      `INSERT OR IGNORE INTO projects (id, slug, name, goal, status) VALUES ('${INERT}', '${INERT}', 'Inert', 'x', 'active')`,
      `INSERT OR IGNORE INTO projects (id, slug, name, goal, status) VALUES ('${PROBED}', '${PROBED}', 'Probed', 'x', 'active')`,
      `INSERT OR IGNORE INTO project_squad_access (project_id, squad_id, access_level) VALUES ('${LIVE}', 'squad-a', 'write')`,
      `INSERT OR IGNORE INTO project_squad_access (project_id, squad_id, access_level) VALUES ('${OTHER}', 'squad-a', 'write')`,
      `INSERT OR IGNORE INTO tasks (id, squad_id, project_id, title, body, status) VALUES ('t-open', 'squad-a', '${LIVE}', 'Open task', 'b', 'open')`,
      `INSERT OR IGNORE INTO tasks (id, squad_id, project_id, title, body, status, gate_owner) VALUES ('t-review', 'squad-a', '${LIVE}', 'Review task', 'b', 'review', 'gate:athena')`,
      `INSERT OR IGNORE INTO tasks (id, squad_id, project_id, title, body, status) VALUES ('t-approved', 'squad-a', '${LIVE}', 'Approved, not yet done', 'b', 'approved')`,
      `INSERT OR IGNORE INTO tasks (id, squad_id, project_id, title, body, status, assignee_member_id) VALUES ('t-human', 'squad-a', '${LIVE}', 'Human owned', 'b', 'in_progress', 'mem-1')`,
      `INSERT OR IGNORE INTO tasks (id, squad_id, project_id, title, body, status) VALUES ('t-done', 'squad-a', '${LIVE}', 'Done task', 'b', 'done')`,
      `INSERT OR IGNORE INTO tasks (id, squad_id, project_id, title, body, status) VALUES ('t-archived', 'squad-a', '${LIVE}', 'Archived task', 'b', 'open')`,
      `INSERT OR IGNORE INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status) VALUES ('t-archived', '2026-10-01T00:00:00Z', 'test', 'mem-1', 'open')`,
      `INSERT OR IGNORE INTO tasks (id, squad_id, project_id, title, body, status) VALUES ('t-elsewhere', 'squad-a', '${OTHER}', 'Other project task', 'b', 'open')`,
    ].join(';\n'),
  )
})

// The office's whole public RPC surface. Anything added here is a decision, anything missing is a regression.
const OFFICE_METHODS = [
  'notice', 'prepare', 'dispatch', 'followUp', 'gate', 'remember', 'report',
  'armFollowUpClock', 'rebuild', 'snapshot',
]
// Platform handlers: invoked by the runtime, not callable as RPC.
const HANDLERS = ['fetch', 'alarm', 'webSocketMessage', 'webSocketClose', 'webSocketError']

describe('Agents SDK in its own Worker', () => {
  it('the Worker entry exports the office class', () => {
    expect(typeof entry.ProjectOffice).toBe('function')
  })

  it('exposes EXACTLY the office’s own methods: no SDK method is on the class', () => {
    const names = new Set<string>()
    for (let p: object | null = ProjectOffice.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      for (const n of Object.getOwnPropertyNames(p)) if (n !== 'constructor') names.add(n)
    }
    const own = Object.getOwnPropertyNames(ProjectOffice.prototype).filter((n) => n !== 'constructor' && !n.startsWith('#'))
    // Public prototype members of the class itself, minus the private helpers (those are TS-private but still on the prototype).
    const privates = ['verify', 'requireBinding', 'agent', 'openAgent', 'stub', 'forwardSocketEvent']
    expect(own.filter((n) => !privates.includes(n)).sort()).toEqual([...OFFICE_METHODS, ...HANDLERS].sort())
    // ... and nothing is inherited beyond the platform's DurableObject base.
    for (const banned of ['schedule', 'scheduleEvery', 'setState', 'sql', 'destroy', 'cancelSchedule', 'getSchedules', 'subAgent']) {
      expect(names.has(banned), banned).toBe(false)
    }
  })

  it('every inherited-looking SDK name is refused over RPC, even on a VALID office', async () => {
    const stub = office(TENANT, PROBED)
    expect((await rpc(stub).prepare()).error).toBe('not_implemented') // valid and verified
    for (const name of [
      'schedule', 'scheduleEvery', 'setState', 'sql', 'destroy', 'cancelSchedule', 'getSchedules', 'listSchedules',
      'onStart', '__unsafe_ensureInitialized', 'setName', 'keepAlive', 'subAgent', '_cf_forwardToFacet', 'queue', 'addMcpServer',
    ]) {
      expect(await probe(stub, name, 'x'), name).toMatch(NOT_IMPLEMENTED)
    }
  })

  it('is hosted on SQLite and starts the SDK only when asked for work', async () => {
    const stub = office(TENANT, LIVE)
    expect((await rpc(stub).prepare()).error).toBe('not_implemented') // a stub: needs no SDK
    expect(await tables(stub)).toEqual([]) // verified, but nothing built yet
    expect((await rpc(stub).snapshot()).tasks).toBeDefined() // work: builds the SDK half
    const t = await tables(stub)
    expect(t.filter((n) => n.startsWith('office_'))).toEqual(['office_cursor', 'office_items', 'office_meta', 'office_project_view', 'office_seen', 'office_tasks'])
    expect(t.some((n) => n.startsWith('cf_agents_'))).toBe(true)
  })
})

describe('binding: project -> tenant re-verified from D1', () => {
  const refusals: [string, string, string][] = [
    ['a foreign tenant', projectOfficeName('pot-b', LIVE), 'tenant_mismatch'],
    ['a project D1 does not know', projectOfficeName(TENANT, 'proj-ghost'), 'project_not_found'],
    ['an SDK sub-agent identity', 'cf-agents:v2:pot-a:proj-live', 'bad_name'],
    ['a name that is not <tenant>:<project>', 'garbage', 'bad_name'],
  ]

  it.each(refusals)('%s: refused on every entry, and NO table of any kind is created', async (_label, name, reason) => {
    const stub = stubFor(name)
    const o = rpc(stub)
    const n = await buildNotice({
      tenant: TENANT, connection: 'c1', scope: 'github:o/r', provider: 'github', item_id: 'i1', event_id: 'e1', version: 'v1',
      kind: 'pr', state: 'open', url: 'https://example.test/1', title: 't', actor: 'a', updated_at: '2026-10-22T00:00:00.000Z',
    })
    const refused = { ok: false, error: 'unbound', reason }
    expect(await o.notice(n)).toEqual(refused)
    for (const fn of ['prepare', 'dispatch', 'followUp', 'gate', 'remember', 'report', 'rebuild', 'snapshot'] as const) {
      expect(await o[fn](), fn).toEqual(refused)
    }
    expect(await o.armFollowUpClock(60)).toEqual(refused)
    expect(await probe(stub, 'schedule', 60, 'followUpTick'), 'schedule').toMatch(NOT_IMPLEMENTED)
    expect(await probe(stub, 'setState', { a: 1 }), 'setState').toMatch(NOT_IMPLEMENTED)
    const res = await stub.fetch('https://office.test/anything')
    expect(res.status).toBe(404)
    await res.text()
    expect(await tables(stub)).toEqual([]) // every table: neither office_* nor the SDK's cf_agents_*
  })

  it('refuses an archived project', async () => {
    const project = 'proj-archived-at-birth'
    await addProject(project)
    await bindings.DB.exec(`UPDATE projects SET status = 'archived' WHERE id = '${project}'`)
    const stub = office(TENANT, project)
    expect(await rpc(stub).report()).toEqual({ ok: false, error: 'unbound', reason: 'project_archived' })
    expect(await tables(stub)).toEqual([])
  })

  it('the other six functions are still empty stubs behind a verified binding', async () => {
    const stub = rpc(office(TENANT, LIVE))
    for (const fn of ['prepare', 'dispatch', 'followUp', 'gate', 'remember', 'report'] as const) {
      expect(await stub[fn](), fn).toEqual({ ok: false, error: 'not_implemented', fn })
    }
  })

  it('a revoked project stops being served on the next wake (real eviction)', async () => {
    const project = 'proj-revoked'
    await addProject(project)
    const stub = office(TENANT, project)
    expect((await rpc(stub).report()).error).toBe('not_implemented')
    await bindings.DB.exec(`UPDATE projects SET status = 'archived' WHERE id = '${project}'`)
    await evictDurableObject(stub)
    expect(await rpc(stub).report()).toEqual({ ok: false, error: 'unbound', reason: 'project_archived' })
  })

  it('a long-lived office re-reads D1 once the verification is older than the TTL', async () => {
    const project = 'proj-ttl'
    await addProject(project)
    const stub = office(TENANT, project)
    expect((await rpc(stub).report()).error).toBe('not_implemented')
    await bindings.DB.exec(`UPDATE projects SET status = 'archived' WHERE id = '${project}'`)
    expect((await rpc(stub).report()).error).toBe('not_implemented') // inside the TTL: the documented bound
    await ageVerification(stub)
    expect(await rpc(stub).report()).toEqual({ ok: false, error: 'unbound', reason: 'project_archived' })
  })

  it('fails closed when D1 cannot be read', async () => {
    const project = 'proj-d1-down'
    await addProject(project)
    const stub = office(TENANT, project)
    expect((await rpc(stub).report()).error).toBe('not_implemented')
    await ageVerification(stub)
    const real = await runInDurableObject(stub, (i: ProjectOffice) => {
      const e = inner(i).env
      const kept = e.DB
      e.DB = { prepare: () => { throw new Error('d1 down') } } as unknown as D1Database // a D1 that throws
      return Promise.resolve(kept)
    })
    try {
      expect(await rpc(stub).report()).toEqual({ ok: false, error: 'unbound', reason: 'verify_unavailable' })
    } finally {
      await runInDurableObject(stub, (i: ProjectOffice) => { inner(i).env.DB = real })
    }
  })

  it('flag off at the object: HTTP 404 and every function refuses once the verification ages out', async () => {
    const stub = office(TENANT, INERT)
    expect((await rpc(stub).prepare()).error).toBe('not_implemented')
    const on = await stub.fetch('https://office.test/anything')
    expect(on.status).toBe(501)
    await on.text()
    await runInDurableObject(stub, (i: ProjectOffice) => { inner(i).env.PROJECT_OFFICE = undefined })
    try {
      await ageVerification(stub)
      const off = await stub.fetch('https://office.test/anything')
      expect(off.status).toBe(404)
      await off.text()
      expect(await rpc(stub).gate()).toEqual({ ok: false, error: 'unbound', reason: 'flag_off' })
    } finally {
      await runInDurableObject(stub, (i: ProjectOffice) => { inner(i).env.PROJECT_OFFICE = '1' })
    }
  })
})

describe('the SDK’s client surface is shut', () => {
  it('sub-agent routing (/sub/...) is refused', async () => {
    const stub = office(TENANT, INERT)
    for (const path of ['/sub/project-office/other', '/sub/project-office/pot-a:proj-other/deeper']) {
      const res = await stub.fetch(`https://office.test${path}`)
      expect(res.status, path).toBe(404)
      await res.text()
    }
  })

  it('the SDK hooks are shut at the source: no sub-agents, no protocol frames, read-only, identity off', async () => {
    const stub = office(TENANT, INERT)
    expect((await rpc(stub).snapshot()).tasks).toBeDefined() // builds the SDK half
    await runInDurableObject(stub, async (i: ProjectOffice) => {
      const a = inner(i).officeAgent as unknown as {
        onBeforeSubAgent(r: Request, c: { className: string; name: string }): Promise<unknown>
        shouldSendProtocolMessages(): boolean
        shouldConnectionBeReadonly(): boolean
        constructor: { options: { sendIdentityOnConnect: boolean } }
      }
      const decision = await a.onBeforeSubAgent(new Request('https://office.test/sub/project-office/x'), { className: 'ProjectOffice', name: 'x' })
      expect(decision).toBeInstanceOf(Response)
      expect((decision as Response).status).toBe(404)
      expect(a.shouldSendProtocolMessages()).toBe(false)
      expect(a.shouldConnectionBeReadonly()).toBe(true)
      expect(a.constructor.options.sendIdentityOnConnect).toBe(false)
    })
  })

  it('a WebSocket client receives NO frame (no identity, state or MCP) and is closed 1008', async () => {
    const stub = office(TENANT, INERT)
    const res = await stub.fetch('https://office.test/ws', { headers: { Upgrade: 'websocket' } })
    expect(res.status).toBe(101)
    const ws = res.webSocket
    expect(ws).toBeTruthy()
    const frames: unknown[] = []
    ws?.addEventListener('message', (e) => frames.push(e.data))
    const closed = new Promise<number>((resolve) => ws?.addEventListener('close', (e) => resolve(e.code)))
    ws?.accept()
    expect(await closed).toBe(1008)
    expect(frames).toEqual([])
    ws?.close(1000, 'done') // complete the handshake, or a later evictDurableObject waits on this socket
  })

  it('a WebSocket to a refused office is not accepted at all', async () => {
    const stub = office('pot-b', LIVE)
    const res = await stub.fetch('https://office.test/ws', { headers: { Upgrade: 'websocket' } })
    expect(res.status).toBe(404)
    await res.text()
    expect(await tables(stub)).toEqual([])
  })
})

describe('alarms and SQLite state', () => {
  it('scheduleEvery arms one idempotent clock; the alarm fires the callback and leaves a durable count', async () => {
    const stub = office(TENANT, LIVE)
    expect(await rpc(stub).armFollowUpClock(60)).toEqual({ ok: true })
    await rpc(stub).armFollowUpClock(60) // idempotent: same callback + interval + payload
    expect(await clocks(stub)).toBe(1)

    // Not yet due: firing the alarm now runs nothing (the interval is honoured, not ignored).
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    expect(await ticks(stub)).toEqual([])

    expect(await makeJobsDue(stub)).toBe(1)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    expect(await ticks(stub)).toEqual(['1'])
    expect(await clocks(stub)).toBe(1) // an interval schedule re-arms itself after firing
  })

  it('a one-shot delayed schedule fires once and is gone', async () => {
    const stub = office(TENANT, LIVE)
    await runInDurableObject(stub, async (i: ProjectOffice) => {
      const a = inner(i).officeAgent as unknown as {
        schedule(s: number, cb: string, p?: undefined, o?: { idempotent: boolean }): Promise<unknown>
        cancelClocks(): Promise<number>
        listSchedules(): Promise<unknown[]>
      }
      await a.cancelClocks() // clear the interval clock armed above so the next alarm is the one-shot
      await a.schedule(30, 'followUpTick', undefined, { idempotent: true })
    })
    expect(await makeJobsDue(stub)).toBe(1)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    const left = await runInDurableObject(stub, (i: ProjectOffice) => inner(i).officeAgent?.listSchedules())
    expect(left).toEqual([])
  })

  it('SQLite state survives eviction', async () => {
    const stub = office(TENANT, LIVE)
    await runInDurableObject(stub, (_i: ProjectOffice, state) => {
      state.storage.sql.exec(`INSERT OR REPLACE INTO office_seen (provider, connection, event_id, seen_at) VALUES ('github', 'c1', 'evt-1', '2026-10-22T00:00:00Z')`)
    })
    await evictDurableObject(stub)
    const seen = await runInDurableObject(stub, (_i: ProjectOffice, state) =>
      state.storage.sql.exec(`SELECT provider, connection, event_id FROM office_seen`).toArray(),
    )
    expect(seen).toEqual([{ provider: 'github', connection: 'c1', event_id: 'evt-1' }])
  })

  it('dedup and cursors are scoped by provider: the same ids from two providers do not collide', async () => {
    const stub = office(TENANT, LIVE)
    await runInDurableObject(stub, (_i: ProjectOffice, state) => {
      const sql = state.storage.sql
      for (const p of ['github', 'linear']) {
        sql.exec(`INSERT INTO office_seen (provider, connection, event_id, seen_at) VALUES (?, 'conn', 'same-id', 'x')`, p)
        sql.exec(`INSERT INTO office_cursor (provider, connection, cursor) VALUES (?, 'conn', ?)`, p, `cursor-${p}`)
      }
      expect(sql.exec(`SELECT count(*) AS n FROM office_seen WHERE event_id = 'same-id'`).one().n).toBe(2)
      expect(sql.exec(`SELECT cursor FROM office_cursor ORDER BY provider`).toArray().map((r) => r.cursor)).toEqual(['cursor-github', 'cursor-linear'])
    })
  })
})

describe('the clock stops when the office becomes unbound', () => {
  it('an archived project’s recurring clock is cancelled on its next alarm, not left to recur against D1', async () => {
    const project = 'proj-clock-stop'
    await addProject(project)
    const stub = office(TENANT, project)
    expect(await rpc(stub).armFollowUpClock(60)).toEqual({ ok: true })
    expect(await clocks(stub)).toBe(1)
    await bindings.DB.exec(`UPDATE projects SET status = 'archived' WHERE id = '${project}'`)
    await ageVerification(stub)
    expect(await makeJobsDue(stub)).toBe(1)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    expect(await clocks(stub)).toBe(0)
    expect(await ticks(stub)).toEqual([])
  })

  it('a D1 outage is transient: the tick does nothing but the clock survives', async () => {
    const project = 'proj-clock-outage'
    await addProject(project)
    const stub = office(TENANT, project)
    expect(await rpc(stub).armFollowUpClock(60)).toEqual({ ok: true })
    await ageVerification(stub)
    expect(await makeJobsDue(stub)).toBe(1)
    const real = await runInDurableObject(stub, (i: ProjectOffice) => {
      const e = inner(i).env
      const kept = e.DB
      e.DB = { prepare: () => { throw new Error('d1 down') } } as unknown as D1Database
      return Promise.resolve(kept)
    })
    try {
      expect(await runDurableObjectAlarm(stub)).toBe(true)
    } finally {
      await runInDurableObject(stub, (i: ProjectOffice) => { inner(i).env.DB = real })
    }
    expect(await clocks(stub)).toBe(1)
    expect(await ticks(stub)).toEqual([])
  })

  it('the tick re-verifies on its own: it does not trust the path that woke it', async () => {
    const project = 'proj-tick-direct'
    await addProject(project)
    const stub = office(TENANT, project)
    expect(await rpc(stub).armFollowUpClock(60)).toEqual({ ok: true })
    await bindings.DB.exec(`UPDATE projects SET status = 'archived' WHERE id = '${project}'`)
    await ageVerification(stub)
    // Call the callback directly, bypassing the facade's alarm(): the tick itself must refuse.
    await runInDurableObject(stub, async (i: ProjectOffice) => { await inner(i).officeAgent?.followUpTick() })
    expect(await ticks(stub)).toEqual([])
  })
})

describe('destroy-and-rebuild', () => {
  it('wipes the office, rebuilds its working set from D1, and loses nothing auditable', async () => {
    const stub = office(TENANT, LIVE)
    // live work: open, review, approved (not terminal), human-owned. Not: done, archived, another project's.
    expect(await rpc(stub).rebuild()).toEqual({ tasks: 4 })
    const before = await rpc(stub).snapshot()
    expect(before.tasks).toEqual([
      { task_id: 't-approved', status: 'approved', assignee_agent_id: null, assignee_member_id: null, gate_owner: null },
      { task_id: 't-human', status: 'in_progress', assignee_agent_id: null, assignee_member_id: 'mem-1', gate_owner: null },
      { task_id: 't-open', status: 'open', assignee_agent_id: null, assignee_member_id: null, gate_owner: null },
      { task_id: 't-review', status: 'review', assignee_agent_id: null, assignee_member_id: null, gate_owner: 'gate:athena' },
    ])
    const d1Before = await d1Fingerprint()

    // DESTROY: every byte the office holds, including the SDK's own tables and its alarm.
    await runInDurableObject(stub, async (_i: ProjectOffice, state) => {
      await state.storage.deleteAll()
      await state.storage.deleteAlarm()
    })
    expect(await tables(stub)).toEqual([])

    // The next wake is a cold start on empty storage.
    await evictDurableObject(stub)
    expect(await rpc(stub).snapshot()).toEqual({ project: [], tasks: [], items: [] })

    // REBUILD from D1 alone.
    expect(await rpc(stub).rebuild()).toEqual({ tasks: 4 })
    expect(await rpc(stub).snapshot()).toEqual(before)

    // Nothing auditable lived in the office: D1 is exactly what it was.
    expect(await d1Fingerprint()).toEqual(d1Before)
  })
})


// ── notice intake (Phase 1, slice 1) ─────────────────────────────────────────────────────────────────

const NOTICE_PROJECT = 'proj-notice'
const T = (sec: number): string => new Date(Date.parse('2026-10-22T08:00:00.000Z') + sec * 1000).toISOString()
const fields = (over: Partial<NoticeFields> = {}): NoticeFields => ({
  tenant: TENANT, connection: 'inst-1', scope: 'github:o/r', provider: 'github', item_id: 'PR_1', event_id: 'd-1', version: 'sha-a',
  kind: 'pr', state: 'open', url: 'https://github.com/o/r/pull/1', title: 'Title', actor: 'octo', updated_at: T(0), ...over,
})
const items = (s: Stub): Promise<Record<string, unknown>[]> =>
  runInDurableObject(s, (_i: ProjectOffice, state) => {
    const t = state.storage.sql.exec(`SELECT name FROM sqlite_master WHERE name = 'office_items'`).toArray()
    if (t.length === 0) return [] // an office that never accepted work has no tables at all
    return state.storage.sql.exec(`SELECT item_id, version, title, conflict_version FROM office_items ORDER BY item_id`).toArray()
  })

describe('notice: validated and recorded at the RPC boundary', () => {
  beforeAll(async () => {
    await addProject(NOTICE_PROJECT, OWNS_OR)
    for (const id of ['proj-notice-2', 'proj-notice-3', 'proj-notice-4']) await addProject(id, OWNS_OR)
  })

  it('records a valid notice, and answers a replay of the same delivery as a duplicate', async () => {
    const stub = office(TENANT, NOTICE_PROJECT)
    const n = await buildNotice(fields())
    expect(await rpc(stub).notice(n)).toEqual({ ok: true, outcome: 'applied' })
    expect(await items(stub)).toEqual([{ item_id: 'PR_1', version: 'sha-a', title: 'Title', conflict_version: null }])
    for (let i = 0; i < 3; i++) expect(await rpc(stub).notice(n)).toEqual({ ok: true, outcome: 'duplicate' })
    expect(await items(stub)).toHaveLength(1)
    expect((await rpc(stub).snapshot()).items).toEqual([
      expect.objectContaining({ provider: 'github', connection: 'inst-1', item_id: 'PR_1', kind: 'pr', state: 'open', version: 'sha-a' }),
    ])
    const meta = await runInDurableObject(stub, (_i: ProjectOffice, st) => st.storage.sql.exec(`SELECT value FROM office_meta WHERE key = 'schema_version'`).toArray())
    expect(meta).toEqual([{ value: '2' }])
  })

  it('an older version never overwrites a newer one, and a replay survives eviction', async () => {
    const stub = office(TENANT, 'proj-notice-2')
    const newer = await buildNotice(fields({ event_id: 'd-new', version: 'sha-new', updated_at: T(120), title: 'Newest' }))
    const older = await buildNotice(fields({ event_id: 'd-old', version: 'sha-old', updated_at: T(10), title: 'Stale' }))
    expect(await rpc(stub).notice(newer)).toEqual({ ok: true, outcome: 'applied' })
    await evictDurableObject(stub)
    expect(await rpc(stub).notice(older)).toEqual({ ok: true, outcome: 'stale' })
    expect(await rpc(stub).notice(newer)).toEqual({ ok: true, outcome: 'duplicate' })
    expect(await items(stub)).toEqual([{ item_id: 'PR_1', version: 'sha-new', title: 'Newest', conflict_version: null }])
  })

  it('a same-instant, different-version notice is a tie: the held row stays and the other version is only noted', async () => {
    const stub = office(TENANT, 'proj-notice-3')
    expect(await rpc(stub).notice(await buildNotice(fields({ event_id: 'd-1', version: 'aaa' })))).toEqual({ ok: true, outcome: 'applied' })
    expect(await rpc(stub).notice(await buildNotice(fields({ event_id: 'd-2', version: 'zzz', title: 'Ground sha wins?' })))).toEqual({ ok: true, outcome: 'tie_kept' })
    expect(await items(stub)).toEqual([{ item_id: 'PR_1', version: 'aaa', title: 'Title', conflict_version: 'zzz' }])
  })

  describe('strict isNotice at the boundary: nothing malformed reaches the working set', () => {
    const cases: [string, (n: Awaited<ReturnType<typeof buildNotice>>) => unknown, string][] = [
      ['an extra key', (n) => ({ ...n, assignee: 'attacker' }), 'keys'],
      ['a missing key', (n) => { const { hash: _h, ...rest } = n; return rest }, 'keys'],
      ['fields edited after hashing', (n) => ({ ...n, title: 'edited' }), 'hash'],
      ['a forged hash', (n) => ({ ...n, hash: 'a'.repeat(64) }), 'hash'],
      ['an unanchored hash', (n) => ({ ...n, hash: `${n.hash}0` }), 'hash'],
      ['a javascript: link', (n) => ({ ...n, url: 'javascript:alert(1)' }), 'url'],
      ['a bidi override in the title', (n) => ({ ...n, title: 'a\u202eb' }), 'title'],
      ['a control character in the actor', (n) => ({ ...n, actor: 'a\u0000b' }), 'actor'],
      ['a future-dated updated_at', (n) => ({ ...n, updated_at: '2999-01-01T00:00:00.000Z' }), 'updated_at_future'],
      ['another tenant', (n) => ({ ...n, tenant: 'pot-b' }), 'hash'],
    ]
    it.each(cases)('refuses %s', async (_label, mutate, problem) => {
      const stub = office(TENANT, 'proj-notice-4')
      const before = await items(stub)
      const bad = mutate(await buildNotice(fields({ event_id: `bad-${_label}` })))
      expect(await rpc(stub).notice(bad)).toEqual({ ok: false, error: 'invalid_notice', problem })
      expect(await items(stub)).toEqual(before)
    })

    it.each([null, undefined, 'x', 7, [], {}])('refuses a non-notice %j', async (v) => {
      expect(await rpc(office(TENANT, 'proj-notice-4')).notice(v)).toMatchObject({ ok: false, error: 'invalid_notice' })
    })

    it('refuses a correctly hashed notice stamped with another pot’s tenant (the office re-checks its own)', async () => {
      const foreign = await buildNotice(fields({ tenant: 'pot-b', event_id: 'foreign' }))
      expect(await rpc(office(TENANT, 'proj-notice-4')).notice(foreign)).toEqual({ ok: false, error: 'invalid_notice', problem: 'tenant' })
    })

    it('a refusal builds nothing: a malformed notice to a fresh office creates no table', async () => {
      const project = 'proj-notice-fresh'
      await addProject(project, OWNS_OR)
      const stub = office(TENANT, project)
      expect((await rpc(stub).notice({ junk: true })).error).toBe('invalid_notice')
      expect(await tables(stub)).toEqual([])
    })
  })

  it('destroy-and-rebuild: notice state is not authority; D1 is untouched and the office refills from the source', async () => {
    const project = 'proj-notice-destroy'
    await addProject(project, OWNS_OR)
    const stub = office(TENANT, project)
    const n = await buildNotice(fields({ event_id: 'd-destroy' }))
    expect(await rpc(stub).notice(n)).toEqual({ ok: true, outcome: 'applied' })
    const d1Before = await d1Fingerprint()
    await runInDurableObject(stub, async (_i: ProjectOffice, state) => {
      await state.storage.deleteAll()
      await state.storage.deleteAlarm()
    })
    await evictDurableObject(stub)
    expect(await rpc(stub).snapshot()).toEqual({ project: [], tasks: [], items: [] })
    expect(await rpc(stub).rebuild()).toEqual({ tasks: 0 })
    expect((await rpc(stub).snapshot()).items).toEqual([]) // the D1-derived rebuild does not invent source items
    expect(await rpc(stub).notice(n)).toEqual({ ok: true, outcome: 'applied' }) // lost dedup costs a harmless re-apply
    expect(await d1Fingerprint()).toEqual(d1Before)
  })
})

// ── repository scope, contract version, schema v2 (#2137 items 2, 6) ────────────────────────────────

const scopeItems = (s: Stub): Promise<Record<string, unknown>[]> =>
  runInDurableObject(s, (_i: ProjectOffice, state) => {
    const t = state.storage.sql.exec(`SELECT name FROM sqlite_master WHERE name = 'office_items'`).toArray()
    if (t.length === 0) return []
    return state.storage.sql.exec(`SELECT item_id, scope FROM office_items ORDER BY item_id`).toArray()
  })
const metaValue = (s: Stub, key: string): Promise<unknown[]> =>
  runInDurableObject(s, (_i: ProjectOffice, state) =>
    state.storage.sql.exec(`SELECT value FROM office_meta WHERE key = ?`, key).toArray().map((r) => r.value),
  )
const setRepo = (project: string, url: string | null): Promise<unknown> =>
  bindings.DB.exec(`UPDATE projects SET repo_url = ${url === null ? 'NULL' : `'${url}'`} WHERE id = '${project}'`)

describe('repository scope: D1 decides what an office keeps and serves', () => {
  it('refuses a notice scoped to a repository D1 does not give this project, and records nothing', async () => {
    const project = 'proj-scope-refuse'
    await addProject(project, 'https://github.com/o/mine')
    const stub = office(TENANT, project)
    const foreign = await buildNotice(fields({ scope: 'github:o/not-mine', event_id: 'f-1' }))
    expect(await rpc(stub).notice(foreign)).toEqual({ ok: false, error: 'invalid_notice', problem: 'scope_not_owned' })
    expect(await scopeItems(stub)).toEqual([])
    const mine = await buildNotice(fields({ scope: 'github:o/mine', event_id: 'f-2' }))
    expect(await rpc(stub).notice(mine)).toEqual({ ok: true, outcome: 'applied' })
    expect(await scopeItems(stub)).toEqual([{ item_id: 'PR_1', scope: 'github:o/mine' }])
  })

  it('relinquish: the next READ serves nothing of a repository D1 moved away, and the rows are gone', async () => {
    const project = 'proj-scope-read'
    await addProject(project, 'https://github.com/o/read')
    const stub = office(TENANT, project)
    for (const [i, item] of ['A', 'B'].entries()) {
      expect(await rpc(stub).notice(await buildNotice(fields({ scope: 'github:o/read', item_id: item, event_id: `r-${i}` })))).toEqual({ ok: true, outcome: 'applied' })
    }
    expect(((await rpc(stub).snapshot()).items as unknown[]).length).toBe(2)
    await setRepo(project, 'https://github.com/o/elsewhere') // inside the verify TTL: the read must still re-ask D1
    expect((await rpc(stub).snapshot()).items).toEqual([])
    expect(await scopeItems(stub)).toEqual([])
    expect(await metaValue(stub, 'scope_purged')).toEqual(['2'])
    // ...and the same repository cannot be re-learned from a late delivery
    expect(await rpc(stub).notice(await buildNotice(fields({ scope: 'github:o/read', item_id: 'C', event_id: 'r-late' })))).toEqual({
      ok: false, error: 'invalid_notice', problem: 'scope_not_owned',
    })
    // giving it back (and a fresh delivery) serves again
    await setRepo(project, 'https://github.com/o/read')
    expect(await rpc(stub).notice(await buildNotice(fields({ scope: 'github:o/read', item_id: 'C', event_id: 'r-back' })))).toEqual({ ok: true, outcome: 'applied' })
  })

  it('relinquish: only the repository given up goes; the other stays', async () => {
    const project = 'proj-scope-two'
    await addProject(project, 'https://github.com/o/keep')
    await bindings.DB.exec(`INSERT OR IGNORE INTO project_repos (project_id, repo_key) VALUES ('${project}', 'github:o/lose')`)
    const stub = office(TENANT, project)
    await rpc(stub).notice(await buildNotice(fields({ scope: 'github:o/keep', item_id: 'K', event_id: 't-1' })))
    await rpc(stub).notice(await buildNotice(fields({ scope: 'github:o/lose', item_id: 'L', event_id: 't-2' })))
    await bindings.DB.exec(`DELETE FROM project_repos WHERE project_id = '${project}'`)
    expect((await rpc(stub).snapshot()).items).toEqual([expect.objectContaining({ item_id: 'K', scope: 'github:o/keep' })])
  })

  it('a WAKE sweeps with no read and no notice: an evicted office that gets any call drops what D1 took away', async () => {
    const project = 'proj-scope-wake'
    await addProject(project, 'https://github.com/o/wake')
    const stub = office(TENANT, project)
    await rpc(stub).notice(await buildNotice(fields({ scope: 'github:o/wake', event_id: 'w-1' })))
    await setRepo(project, null)
    await evictDurableObject(stub)
    expect(await scopeItems(stub)).toHaveLength(1) // eviction alone changes nothing
    expect(await rpc(stub).armFollowUpClock(3600)).toEqual({ ok: true }) // any call into a cold object is a wake
    expect(await scopeItems(stub)).toEqual([])
  })

  it('the alarm tick sweeps too', async () => {
    const project = 'proj-scope-tick'
    await addProject(project, 'https://github.com/o/tick')
    const stub = office(TENANT, project)
    await rpc(stub).notice(await buildNotice(fields({ scope: 'github:o/tick', event_id: 'k-1' })))
    expect(await rpc(stub).armFollowUpClock(3600)).toEqual({ ok: true })
    await setRepo(project, null) // inside the TTL: only the tick itself can notice
    expect(await scopeItems(stub)).toHaveLength(1)
    expect(await makeJobsDue(stub)).toBe(1)
    await runDurableObjectAlarm(stub)
    expect(await scopeItems(stub)).toEqual([])
  })

  it('D1 cannot be asked: the read withholds the repository’s items rather than serving them unverified, and nothing is deleted', async () => {
    const project = 'proj-scope-down'
    await addProject(project, 'https://github.com/o/down')
    const stub = office(TENANT, project)
    await rpc(stub).notice(await buildNotice(fields({ scope: 'github:o/down', event_id: 'd-1' })))
    expect(((await rpc(stub).snapshot()).items as unknown[]).length).toBe(1)
    await bindings.DB.exec('ALTER TABLE project_repos RENAME TO project_repos_offline') // the ownership lookup now throws
    try {
      expect((await rpc(stub).snapshot()).items).toEqual([])
      expect(await scopeItems(stub)).toHaveLength(1) // withheld, not deleted
    } finally {
      await bindings.DB.exec('ALTER TABLE project_repos_offline RENAME TO project_repos')
    }
    expect(((await rpc(stub).snapshot()).items as unknown[]).length).toBe(1) // D1 back: served again
  })

  it('a row with no recorded scope is never served, even if one somehow exists', async () => {
    const project = 'proj-scope-blank'
    await addProject(project, 'https://github.com/o/blank')
    const stub = office(TENANT, project)
    await rpc(stub).notice(await buildNotice(fields({ scope: 'github:o/blank', item_id: 'REAL', event_id: 'b-1' })))
    await runInDurableObject(stub, (_i: ProjectOffice, state) => {
      state.storage.sql.exec(
        `INSERT INTO office_items (provider, connection, scope, item_id, kind, state, version, url, title, actor, updated_at, hash, last_event_id, applied_at)
         VALUES ('github', 'inst-1', '', 'BLANK', 'pr', 'open', 'v', 'https://github.com/o/blank/pull/9', 't', 'a', '2026-10-22T08:00:00.000Z', 'h', 'e', '2026-10-22T08:00:01.000Z')`,
      )
    })
    expect((await rpc(stub).snapshot()).items).toEqual([expect.objectContaining({ item_id: 'REAL' })])
  })

  it('ownership held only as an un-canonicalized repo_url (a pending row) still counts, whatever the spelling', async () => {
    const project = 'proj-scope-pending'
    await addProject(project, 'git@github.com:O/Pending.git')
    const stub = office(TENANT, project)
    expect(await rpc(stub).notice(await buildNotice(fields({ scope: 'github:o/pending', event_id: 'p-1' })))).toEqual({ ok: true, outcome: 'applied' })
  })
})

describe('notice contract version at the RPC boundary', () => {
  const project = 'proj-contract'
  beforeAll(async () => addProject(project, OWNS_OR))

  it('accepts the current version', async () => {
    expect(await rpc(office(TENANT, project)).notice(await buildNotice(fields({ event_id: 'c-ok' })))).toEqual({ ok: true, outcome: 'applied' })
  })

  it('refuses an unknown version and a missing one, each with its own reason', async () => {
    const stub = office(TENANT, project)
    const n = await buildNotice(fields({ event_id: 'c-bad' }))
    expect(await rpc(stub).notice({ ...n, contract: 3 })).toEqual({ ok: false, error: 'invalid_notice', problem: 'contract_unsupported' })
    expect(await rpc(stub).notice({ ...n, contract: 1 })).toEqual({ ok: false, error: 'invalid_notice', problem: 'contract_unsupported' })
    const { contract: _c, scope: _s, ...v1 } = n // what a main Worker from before this change sends
    expect(await rpc(stub).notice(v1)).toEqual({ ok: false, error: 'invalid_notice', problem: 'contract_missing' })
  })
})

describe('the office’s own SQLite migrates from schema v1 inside a real Durable Object', () => {
  it('a v1 office wakes, migrates, and serves only what D1 still vouches for', async () => {
    const project = 'proj-v1'
    await addProject(project, 'https://github.com/o/legacy')
    const stub = office(TENANT, project)
    await runInDurableObject(stub, (_i: ProjectOffice, state) => {
      const x = (q: string, ...b: (string | number)[]) => void state.storage.sql.exec(q, ...b)
      x(`CREATE TABLE office_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
      x(`INSERT INTO office_meta (key, value) VALUES ('schema_version', '1')`)
      x(`CREATE TABLE office_items (
           provider TEXT NOT NULL, connection TEXT NOT NULL, item_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
           version TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, actor TEXT NOT NULL, updated_at TEXT NOT NULL,
           hash TEXT NOT NULL, last_event_id TEXT NOT NULL, conflict_version TEXT, applied_at TEXT NOT NULL,
           PRIMARY KEY (provider, connection, item_id))`)
      for (const [id, url] of [['KEEP', 'https://github.com/O/Legacy/pull/1'], ['OTHER', 'https://github.com/o/other/pull/2'], ['NOLINK', 'https://example.test/x']] as const) {
        x(
          `INSERT INTO office_items (provider, connection, item_id, kind, state, version, url, title, actor, updated_at, hash, last_event_id, applied_at)
           VALUES ('github', 'inst-1', ?, 'pr', 'open', 'v', ?, 't', 'a', '2026-10-22T08:00:00.000Z', 'h', 'e', '2026-10-22T08:00:01.000Z')`,
          id,
          url,
        )
      }
    })
    const snap = await rpc(stub).snapshot()
    expect(snap.items).toEqual([expect.objectContaining({ item_id: 'KEEP', scope: 'github:o/legacy' })]) // OTHER swept (not this project's), NOLINK deleted
    expect(await metaValue(stub, 'schema_version')).toEqual(['2'])
    expect(await scopeItems(stub)).toEqual([{ item_id: 'KEEP', scope: 'github:o/legacy' }])
  })
})

describe('SDK control headers are refused by the facade, with the office’s own 404 (#2130)', () => {
  const ownBody = JSON.stringify({ error: 'not_found' })

  it('x-cf-agents-subagent-url on a WebSocket upgrade: 404, no 101, no stack frame', async () => {
    const stub = office(TENANT, LIVE)
    await rpc(stub).snapshot() // a live, verified office with its SDK half built: the case the vector needs
    const res = await stub.fetch('https://office.test/', {
      headers: { Upgrade: 'websocket', 'x-cf-agents-subagent-url': 'https://office.test/sub/project-office/x' },
    })
    expect(res.status).toBe(404)
    expect(res.webSocket).toBeNull()
    expect(await res.text()).toBe(ownBody)
  })

  it('x-agents-lifecycle-props garbage: 404 with the office’s own body, not a 500 with a stack', async () => {
    const stub = office(TENANT, LIVE)
    await rpc(stub).snapshot()
    const res = await stub.fetch('https://office.test/', { headers: { 'x-agents-lifecycle-props': '%%%not-base64-json%%%' } })
    expect(res.status).toBe(404)
    expect(await res.text()).toBe(ownBody)
  })

  it('the guard is on the prefix, in any case, on any route, and before the binding is read', async () => {
    const foreign = stubFor(projectOfficeName('pot-b', LIVE)) // would also be 404, but the header must short-circuit first
    for (const [h, v] of [['X-CF-Agents-Anything', '1'], ['x-agents-other', '1'], ['X-Agents-Lifecycle-Props', '']] as const) {
      for (const path of ['/', '/agents/project-office/pot-a:proj-live', '/sub/project-office/x']) {
        for (const stub of [office(TENANT, LIVE), foreign]) {
          const res = await stub.fetch(`https://office.test${path}`, { headers: { [h]: v } })
          expect(res.status, `${h} ${path}`).toBe(404)
          expect(await res.text()).toBe(ownBody)
        }
      }
    }
  })

  it('an ordinary request is not caught by it: a verified office still answers its own 501', async () => {
    const stub = office(TENANT, LIVE)
    const res = await stub.fetch('https://office.test/', { headers: { 'x-request-id': 'abc', 'x-agent-hint': 'x' } })
    expect(res.status).not.toBe(404) // not refused by the header guard
    await res.text()
  })
})
