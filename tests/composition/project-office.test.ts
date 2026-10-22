// ProjectOffice spike (Phase 0, docs/plan-project-back-office-20261022) — inside real workerd.
//
// Proves, with the existing Durable Object classes exported from the same Worker entry:
//   - the Agents SDK class builds, is hosted by the runtime beside AgentDO / SquadCoordinatorDO /
//     SeatEventsDO, and runs on SQLite storage
//   - project → tenant is re-verified from D1 on every wake (evictDurableObject forces a real one)
//   - scheduleEvery / schedule alarms fire (runDurableObjectAlarm) and are idempotent
//   - destroy-and-rebuild: wipe an office's storage, rebuild the working set from D1, lose nothing
//     auditable (D1 is untouched by the wipe)
//
// The office reads `env.DB`; vitest.composition.config.ts binds DB to the same database as MUPOT_DB,
// sets PROJECT_OFFICE=1 and TENANT_SLUG=pot-a for this runtime.

import { applyD1Migrations, env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import * as entry from '../../src/index'
import { projectOfficeName } from '../../src/projects/office-core'
import { VERIFY_TTL_MS, type ProjectOffice } from '../../src/projects/project-office'
import { buildNotice } from '../../src/projects/office-contract'

// `cloudflare:test`'s env is typed from the (absent) project wrangler config; the bindings this file
// uses are injected in vitest.composition.config.ts. Casting through unknown is the accepted route
// (same as d1-batch-visibility.test.ts).
const bindings = env as unknown as {
  PROJECT_OFFICE_DO: DurableObjectNamespace<ProjectOffice>
  DB: D1Database
  MUPOT_DB: D1Database
  TEST_MIGRATIONS: never
}

const TENANT = 'pot-a'
const LIVE = 'proj-live'
const OTHER = 'proj-other'
const INERT = 'proj-inert' // its own office, so sockets and open responses here cannot stall another test's eviction

type Stub = DurableObjectStub<ProjectOffice>
function office(tenant: string, project: string): Stub {
  return bindings.PROJECT_OFFICE_DO.get(bindings.PROJECT_OFFICE_DO.idFromName(projectOfficeName(tenant, project)))
}

// RPC returns are structured-cloned; compare by value through a helper that widens the stub's
// generic RPC types (the SDK's Agent type makes workerd's Rpc.Stub mapping too deep for tsc).
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
  armFollowUpClock(s: number): Promise<void>
}
// Narrowing the stub to a hand-written RPC surface: see OfficeRpc above.
const rpc = (s: Stub): OfficeRpc => s as unknown as OfficeRpc

async function seed(): Promise<void> {
  await applyD1Migrations(bindings.MUPOT_DB, bindings.TEST_MIGRATIONS)
  await bindings.DB.exec(
    [
      `INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A')`,
      `INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A')`,
      `INSERT OR IGNORE INTO projects (id, slug, name, goal, status) VALUES ('${LIVE}', '${LIVE}', 'Live project', 'Ship it', 'active')`,
      `INSERT OR IGNORE INTO projects (id, slug, name, goal, status) VALUES ('${OTHER}', '${OTHER}', 'Other project', 'x', 'active')`,
      `INSERT OR IGNORE INTO projects (id, slug, name, goal, status) VALUES ('${INERT}', '${INERT}', 'Inert', 'x', 'active')`,
      `INSERT OR IGNORE INTO project_squad_access (project_id, squad_id, access_level) VALUES ('${LIVE}', 'squad-a', 'write')`,
      `INSERT OR IGNORE INTO project_squad_access (project_id, squad_id, access_level) VALUES ('${OTHER}', 'squad-a', 'write')`,
      `INSERT OR IGNORE INTO tasks (id, squad_id, project_id, title, body, status, gate_owner) VALUES ('t-open', 'squad-a', '${LIVE}', 'Open task', 'b', 'open', NULL)`,
      `INSERT OR IGNORE INTO tasks (id, squad_id, project_id, title, body, status, gate_owner) VALUES ('t-review', 'squad-a', '${LIVE}', 'Review task', 'b', 'review', 'gate:athena')`,
      `INSERT OR IGNORE INTO tasks (id, squad_id, project_id, title, body, status, gate_owner) VALUES ('t-done', 'squad-a', '${LIVE}', 'Done task', 'b', 'done', NULL)`,
      `INSERT OR IGNORE INTO tasks (id, squad_id, project_id, title, body, status, gate_owner) VALUES ('t-elsewhere', 'squad-a', '${OTHER}', 'Other project task', 'b', 'open', NULL)`,
    ].join(';\n'),
  )
}

// The runtime clock cannot be advanced, and the SDK only runs jobs whose time has come, so make the
// armed job due the way time would: rewind its due time in the SDK's own job table.
// (agents@0.29.0 stores schedules in cf_agents_jobs; a pin bump may rename it, and this helper is where to fix that.)
async function makeJobsDue(stub: Stub): Promise<number> {
  return runInDurableObject(stub, (_i: ProjectOffice, state) => {
    state.storage.sql.exec(`UPDATE cf_agents_jobs SET time = 1 WHERE fn = 'followUpTick'`)
    return state.storage.sql.exec(`SELECT id FROM cf_agents_jobs WHERE fn = 'followUpTick' AND time = 1`).toArray().length
  })
}

async function d1Fingerprint(): Promise<unknown[]> {
  const r = await bindings.DB.prepare(
    `SELECT id, project_id, status, gate_owner, updated_at FROM tasks ORDER BY id`,
  ).all()
  return r.results
}

beforeAll(seed)

describe('Agents SDK class beside the existing Durable Object classes', () => {
  it('the Worker entry exports all four, as real classes', () => {
    for (const name of ['AgentDO', 'SquadCoordinatorDO', 'SeatEventsDO', 'ProjectOffice'] as const) {
      expect(typeof entry[name], name).toBe('function')
    }
  })

  it('is hosted by the runtime on SQLite and answers RPC', async () => {
    const stub = office(TENANT, LIVE)
    // The SDK starts an Agent lazily, on its first call: wake it the way production would.
    expect((await rpc(stub).prepare()).error).toBe('not_implemented')
    const out = await runInDurableObject(stub, async (inst: ProjectOffice, state) => {
      const row = state.storage.sql.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'office_%' ORDER BY name`).toArray()
      return { name: inst.name, tables: row.map((r) => r.name) }
    })
    expect(out.name).toBe(`${TENANT}:${LIVE}`)
    expect(out.tables).toEqual(['office_cursor', 'office_project_view', 'office_seen', 'office_tasks'])
  })
})

describe('binding: project → tenant re-verified from D1', () => {
  it('serves nothing under a foreign tenant name, and creates no tables', async () => {
    const stub = office('pot-b', LIVE)
    expect(await rpc(stub).prepare()).toEqual({ ok: false, error: 'unbound', reason: 'tenant_mismatch' })
    const tables = await runInDurableObject(stub, (_i: ProjectOffice, state) =>
      state.storage.sql.exec(`SELECT name FROM sqlite_master WHERE name LIKE 'office_%'`).toArray(),
    )
    expect(tables).toEqual([])
  })

  it('serves nothing for a project D1 does not know', async () => {
    expect(await rpc(office(TENANT, 'proj-ghost')).dispatch()).toEqual({ ok: false, error: 'unbound', reason: 'project_not_found' })
  })

  it('each of the seven functions is an empty stub behind a verified binding', async () => {
    const stub = rpc(office(TENANT, LIVE))
    const n = await buildNotice({
      tenant: TENANT, connection: 'c1', provider: 'github', item_id: 'i1', event_id: 'e1', version: 'v1',
      kind: 'pr', url: 'https://example.test/1', title: 't', actor: 'a', updated_at: '2026-10-22T00:00:00Z',
    })
    expect(await stub.notice(n)).toEqual({ ok: false, error: 'not_implemented', fn: 'notice' })
    expect(await stub.prepare()).toEqual({ ok: false, error: 'not_implemented', fn: 'prepare' })
    expect(await stub.dispatch()).toEqual({ ok: false, error: 'not_implemented', fn: 'dispatch' })
    expect(await stub.followUp()).toEqual({ ok: false, error: 'not_implemented', fn: 'followUp' })
    expect(await stub.gate()).toEqual({ ok: false, error: 'not_implemented', fn: 'gate' })
    expect(await stub.remember()).toEqual({ ok: false, error: 'not_implemented', fn: 'remember' })
    expect(await stub.report()).toEqual({ ok: false, error: 'not_implemented', fn: 'report' })
  })

  it('a revoked project stops being served on the next wake (real eviction)', async () => {
    const project = 'proj-revoked'
    await bindings.DB.exec(`INSERT OR IGNORE INTO projects (id, slug, name, goal, status) VALUES ('${project}', '${project}', 'Revoked', 'x', 'active')`)
    const stub = office(TENANT, project)
    expect((await rpc(stub).report()).error).toBe('not_implemented') // live: verified
    await bindings.DB.exec(`UPDATE projects SET status = 'archived' WHERE id = '${project}'`)
    await evictDurableObject(stub) // a real wake follows
    expect(await rpc(stub).report()).toEqual({ ok: false, error: 'unbound', reason: 'project_archived' })
  })

  it('a long-lived office re-reads D1 once the verification is older than the TTL', async () => {
    const project = 'proj-ttl'
    await bindings.DB.exec(`INSERT OR IGNORE INTO projects (id, slug, name, goal, status) VALUES ('${project}', '${project}', 'TTL', 'x', 'active')`)
    const stub = office(TENANT, project)
    expect((await rpc(stub).report()).error).toBe('not_implemented')
    await bindings.DB.exec(`UPDATE projects SET status = 'archived' WHERE id = '${project}'`)
    // Within the TTL the cached verification is trusted (the documented bound) ...
    expect((await rpc(stub).report()).error).toBe('not_implemented')
    // ... and once it ages out, the next function re-verifies. Age it by rewinding the stamp:
    // reaching into the instance is the only way to move time on the runtime's frozen clock.
    await runInDurableObject(stub, (inst: ProjectOffice) => {
      (inst as unknown as { verifiedAtMs: number }).verifiedAtMs -= VERIFY_TTL_MS + 1 // test-only reach-in, see comment above
    })
    expect(await rpc(stub).report()).toEqual({ ok: false, error: 'unbound', reason: 'project_archived' })
  })
})

describe('inert surface', () => {
  it('HTTP: 501 with the flag on (nothing implemented), 404 once the flag is off', async () => {
    const stub = office(TENANT, INERT)
    expect((await rpc(stub).prepare()).error).toBe('not_implemented') // wake it
    const on = await stub.fetch('https://office.test/anything')
    expect(on.status).toBe(501)
    await on.text()
    await runInDurableObject(stub, (inst: ProjectOffice) => {
      (inst.env as { PROJECT_OFFICE?: string }).PROJECT_OFFICE = undefined // flag off, as an operator would unset it
    })
    try {
      const off = await stub.fetch('https://office.test/anything')
      expect(off.status).toBe(404)
      await off.text()
      // and the functions refuse once the cached verification ages out
      await runInDurableObject(stub, (inst: ProjectOffice) => {
        (inst as unknown as { verifiedAtMs: number }).verifiedAtMs -= VERIFY_TTL_MS + 1 // test-only reach-in (see the TTL test)
      })
      expect(await rpc(stub).gate()).toEqual({ ok: false, error: 'unbound', reason: 'flag_off' })
    } finally {
      await runInDurableObject(stub, (inst: ProjectOffice) => {
        (inst.env as { PROJECT_OFFICE?: string }).PROJECT_OFFICE = '1'
      })
    }
  })

  it('WebSocket clients are closed on connect: the office serves no sockets', async () => {
    const stub = office(TENANT, INERT)
    expect((await rpc(stub).prepare()).error).toBe('not_implemented')
    const res = await stub.fetch('https://office.test/ws', { headers: { Upgrade: 'websocket' } })
    expect(res.status).toBe(101)
    const ws = res.webSocket
    expect(ws).toBeTruthy()
    ws?.accept()
    const closed = await new Promise<number>((resolve) => ws?.addEventListener('close', (e) => resolve(e.code)))
    expect(closed).toBe(1008)
    ws?.close(1000, 'done') // complete the close handshake, or a later evictDurableObject waits on this socket
  })
})

describe('alarms and SQLite state', () => {
  it('scheduleEvery arms one idempotent clock; the alarm fires the callback and leaves a durable count', async () => {
    const stub = office(TENANT, LIVE)
    await rpc(stub).armFollowUpClock(60)
    await rpc(stub).armFollowUpClock(60) // idempotent: same callback + interval + payload
    const armed = await runInDurableObject(stub, (inst: ProjectOffice) => inst.getSchedules().filter((s) => s.callback === 'followUpTick'))
    expect(armed).toHaveLength(1)
    expect(armed[0].type).toBe('interval')

    // Not yet due: firing the alarm now runs nothing (proves the interval is honoured, not ignored).
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    const early = await runInDurableObject(stub, (_i: ProjectOffice, state) =>
      state.storage.sql.exec(`SELECT cursor FROM office_cursor WHERE connection = '__ticks'`).toArray(),
    )
    expect(early).toEqual([])

    expect(await makeJobsDue(stub)).toBe(1)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    const ticks = await runInDurableObject(stub, (_i: ProjectOffice, state) =>
      state.storage.sql.exec(`SELECT cursor FROM office_cursor WHERE connection = '__ticks'`).toArray(),
    )
    expect(ticks).toEqual([{ cursor: '1' }])
    // An interval schedule re-arms itself after firing.
    const after = await runInDurableObject(stub, (inst: ProjectOffice) => inst.getSchedules().filter((s) => s.callback === 'followUpTick'))
    expect(after).toHaveLength(1)
  })

  it('a one-shot delayed schedule fires once and is gone', async () => {
    const stub = office(TENANT, LIVE)
    await runInDurableObject(stub, async (inst: ProjectOffice) => {
      await inst.schedule(30, 'followUpTick', undefined, { idempotent: true })
    })
    // cancel the interval clock armed above so the next alarm run is the one-shot
    await runInDurableObject(stub, async (inst: ProjectOffice) => {
      for (const s of inst.getSchedules()) if (s.type === 'interval') await inst.cancelSchedule(s.id)
    })
    expect(await makeJobsDue(stub)).toBe(1)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    const left = await runInDurableObject(stub, (inst: ProjectOffice) => inst.getSchedules())
    expect(left).toEqual([])
  })

  it('SQLite state survives eviction', async () => {
    const stub = office(TENANT, LIVE)
    await runInDurableObject(stub, (_i: ProjectOffice, state) => {
      state.storage.sql.exec(`INSERT OR REPLACE INTO office_seen (event_id, seen_at) VALUES ('evt-1', '2026-10-22T00:00:00Z')`)
    })
    await evictDurableObject(stub)
    const seen = await runInDurableObject(stub, (_i: ProjectOffice, state) =>
      state.storage.sql.exec(`SELECT event_id FROM office_seen`).toArray(),
    )
    expect(seen).toEqual([{ event_id: 'evt-1' }])
  })
})

describe('destroy-and-rebuild', () => {
  it('wipes the office, rebuilds its working set from D1, and loses nothing auditable', async () => {
    const stub = office(TENANT, LIVE)
    const built = await rpc(stub).rebuild()
    expect(built).toEqual({ tasks: 2 }) // t-open + t-review; not t-done, not another project's task
    const before = await rpc(stub).snapshot()
    expect(before.tasks).toEqual([
      { task_id: 't-open', status: 'open', assignee_agent_id: null, gate_owner: null },
      { task_id: 't-review', status: 'review', assignee_agent_id: null, gate_owner: 'gate:athena' },
    ])

    const d1Before = await d1Fingerprint()

    // DESTROY: every byte the office holds, including the SDK's own tables and its alarm.
    await runInDurableObject(stub, async (_i: ProjectOffice, state) => {
      await state.storage.deleteAll()
      await state.storage.deleteAlarm()
    })
    const gone = await runInDurableObject(stub, (_i: ProjectOffice, state) =>
      state.storage.sql.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%'`).toArray(),
    )
    expect(gone).toEqual([])

    // The next wake is a cold start on empty storage.
    await evictDurableObject(stub)
    const cold = await rpc(stub).snapshot()
    expect(cold).toEqual({ project: [], tasks: [] })

    // REBUILD from D1 alone.
    expect(await rpc(stub).rebuild()).toEqual({ tasks: 2 })
    const after = await rpc(stub).snapshot()
    expect(after).toEqual(before)

    // Nothing auditable lived in the office: D1 is byte-for-byte what it was.
    expect(await d1Fingerprint()).toEqual(d1Before)
  })
})
