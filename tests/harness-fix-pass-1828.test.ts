import { afterEach, describe, expect, it, vi } from 'vitest'
import { cursorCloudAdapter } from '../src/harness/adapters/cursor'
import { grokCliAdapter } from '../src/harness/adapters/grok'
import { claimAttachLease, getReservation } from '../src/harness/reservations'
import { dispatchFlight } from '../src/flight/dispatch'
import { assertExecutionNotPaused, ExecutionPausedError } from '../src/harness/pause'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'

vi.mock('../src/flight/dispatch', async (orig) => {
  const actual = await orig<typeof import('../src/flight/dispatch')>()
  return { ...actual, dispatchFlight: vi.fn(actual.dispatchFlight) }
})
vi.mock('../src/harness/pause', async (orig) => {
  const actual = await orig<typeof import('../src/harness/pause')>()
  return { ...actual, assertExecutionNotPaused: vi.fn(actual.assertExecutionNotPaused) }
})

afterEach(() => {
  vi.mocked(dispatchFlight).mockClear()
  vi.mocked(assertExecutionNotPaused).mockClear()
  vi.unstubAllGlobals()
})

function setup() {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-core', 'dept-core', 'Core');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-core', 'dept-core', 'squad-core', 'Core Squad');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('agent-builder', 'squad-core', 'agent-builder', 'Agent Builder', 'builder', 'test', 'active');
  `)
  const env = { DB: harness.db, TENANT_SLUG: 'mumega', CURSOR_API_TOKEN: 'tok', BUS: { send: async () => {} } } as unknown as Env
  return { harness, env }
}
type H = ReturnType<typeof setup>['harness']

const actor = { kind: 'agent' as const, id: 'agent-builder' }
const cursorReq = (key: string) => ({
  name: 'Fix',
  repoUrl: 'https://github.com/mumega/mupot',
  prompt: 'p',
  squadId: 'squad-core',
  agentId: 'agent-builder',
  actor,
  idempotencyKey: key,
  dryRun: false as const,
})
const grokReq = (key: string) => ({ ...cursorReq(key), name: 'Grok Fix' })

function count(h: H, table: string): number {
  return (h.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
}
function task(h: H) {
  return h.sqlite.prepare('SELECT * FROM tasks').get() as { status: string; assignee_agent_id: string | null; body: string }
}
function res(h: H) {
  return h.sqlite.prepare('SELECT * FROM harness_reservations').get() as { id: string; state: string; last_error: string; task_id: string | null }
}

describe('orphan task compensation (#1828 P2)', () => {
  for (const [name, run] of [
    ['cursor', (env: Env) => cursorCloudAdapter.dispatch(env, cursorReq('k-throw'))],
    ['grok', (env: Env) => grokCliAdapter.dispatch(env, grokReq('k-throw'))],
  ] as const) {
    it(`${name}: dispatchFlight throws -> reservation failed+linked, task blocked and unassigned, 0 flights`, async () => {
      const { harness, env } = setup()
      vi.mocked(dispatchFlight).mockRejectedValueOnce(new Error('boom'))
      const out = await run(env)
      expect(out.accepted).toBe(false)
      expect(count(harness, 'flights')).toBe(0)
      const r = res(harness)
      expect(r.state).toBe('failed')
      expect(r.last_error).toBe('reserve_failed')
      expect(r.task_id).not.toBeNull()
      const t = task(harness)
      expect(t.status).toBe('blocked')
      expect(t.assignee_agent_id).toBeNull()
      expect(t.body).toContain(`reservation ${r.id} failed: reserve_failed`)
    })

    it(`${name}: flight gate held -> task blocked and unassigned, reservation failed flight_gate_held`, async () => {
      const { harness, env } = setup()
      const actual = await vi.importActual<typeof import('../src/flight/dispatch')>('../src/flight/dispatch')
      // Real flight, starved budget -> the real gate holds it.
      vi.mocked(dispatchFlight).mockImplementationOnce((e, i, sig, u, o) =>
        actual.dispatchFlight(e, i, { ...sig, budgetRemainingMicroUsd: 0 }, u, o),
      )
      const out = await run(env)
      expect(out.accepted).toBe(false)
      const r = res(harness)
      expect(r.state).toBe('failed')
      expect(r.last_error).toBe('flight_gate_held')
      expect(r.task_id).not.toBeNull()
      const t = task(harness)
      expect(t.status).toBe('blocked')
      expect(t.assignee_agent_id).toBeNull()
      expect(t.body).toContain(`reservation ${r.id} failed: flight_gate_held`)
    })
  }

  it('compensation never touches a task that already left in_progress', async () => {
    const { harness, env } = setup()
    vi.mocked(dispatchFlight).mockImplementationOnce(async () => {
      harness.sqlite.exec(`UPDATE tasks SET status = 'done'`)
      throw new Error('late')
    })
    await grokCliAdapter.dispatch(env, grokReq('k-done'))
    expect(task(harness).status).toBe('done')
  })
})

describe('grok honesty + pause recheck (#1828 P2)', () => {
  it('records the dispatch as recorded / mupot:reservation, never claims an inbox wake', async () => {
    const { harness, env } = setup()
    const out = await grokCliAdapter.dispatch(env, grokReq('k-rec'))
    expect(out.accepted).toBe(true)
    if (!out.accepted) return
    expect(out.vendorUrl).toBe(`mupot:reservation:${out.reservationId}`)
    const row = await getReservation(env, out.reservationId)
    expect(row?.last_vendor_status).toBe('recorded')
    expect(row?.vendor_url).toBe(`mupot:reservation:${out.reservationId}`)
  })

  it('pause landing after the lease claim releases the lease and leaves the row reserved', async () => {
    const { harness, env } = setup()
    // 1st call = pre-insert fence (passes), 2nd = post-lease re-check (paused).
    vi.mocked(assertExecutionNotPaused)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ExecutionPausedError())
    const out = await grokCliAdapter.dispatch(env, grokReq('k-pause'))
    expect(out.accepted === false && out.error).toBe('execution_paused')
    const r = harness.sqlite.prepare('SELECT * FROM harness_reservations').get() as Record<string, unknown>
    expect(r.state).toBe('reserved')
    expect(r.attach_lease_id).toBeNull()
    expect(r.vendor_run_id).toBeNull()
  })
})

describe('race-loser reply (#1828 P3)', () => {
  async function winnerAttaching(env: Env, h: H, key: string) {
    // Winner reserves (attach deferred via waitUntil, never run), then holds the lease -> 'attaching'.
    const first = await cursorCloudAdapter.dispatch(env, cursorReq(key), { waitUntil: () => {} })
    expect(first.accepted).toBe(true)
    const id = res(h).id
    expect(await claimAttachLease(env, id)).not.toBeNull()
    return id
  }

  it('waitUntil loser: replay true and an attaching row is labelled attaching, not reserved', async () => {
    const { harness, env } = setup()
    const id = await winnerAttaching(env, harness, 'k-race')
    const loser = await cursorCloudAdapter.dispatch(env, cursorReq('k-race'), { waitUntil: () => {} })
    expect(loser.accepted).toBe(true)
    if (!loser.accepted) return
    expect(loser.replay).toBe(true)
    expect(loser.state).toBe('attaching')
    expect(loser.reservationId).toBe(id)
    expect(count(harness, 'tasks')).toBe(1)
  })

  it('sync loser: replay true and the row real state', async () => {
    const { harness, env } = setup()
    const id = await winnerAttaching(env, harness, 'k-race2')
    const loser = await cursorCloudAdapter.dispatch(env, cursorReq('k-race2'))
    expect(loser.accepted).toBe(true)
    if (!loser.accepted) return
    expect(loser.replay).toBe(true)
    expect(loser.state).toBe('attaching')
    expect(loser.reservationId).toBe(id)
  })

  it('grok loser on an attaching row is labelled attaching with replay true', async () => {
    const { harness, env } = setup()
    vi.mocked(assertExecutionNotPaused).mockResolvedValue(undefined)
    const first = await grokCliAdapter.dispatch(env, grokReq('k-g'))
    expect(first.accepted).toBe(true)
    harness.sqlite.exec(`UPDATE harness_reservations SET state = 'attaching', attach_lease_until = '2999-01-01T00:00:00.000Z', attach_lease_id = 'x'`)
    const loser = await grokCliAdapter.dispatch(env, grokReq('k-g'))
    expect(loser.accepted && loser.replay).toBe(true)
    expect(loser.accepted && loser.state).toBe('attaching')
  })
})
