import { afterEach, describe, expect, it, vi } from 'vitest'
import { cursorCloudAdapter } from '../src/harness/adapters/cursor'
import { reserveCursorCloudWork } from '../src/cursor/dispatch'
import { bindVendorExecutionWithTaskBinding, claimAttachLease, getReservation } from '../src/harness/reservations'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'
import type { Env } from '../src/types'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
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

const req = {
  name: 'Idem',
  repoUrl: 'https://github.com/mumega/mupot',
  prompt: 'p',
  squadId: 'squad-core',
  agentId: 'agent-builder',
  actor: { kind: 'agent' as const, id: 'agent-builder' },
  idempotencyKey: 'same-key',
}

function count(h: ReturnType<typeof setup>['harness'], table: string): number {
  const row = h.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }
  return row.n
}

describe('idempotency key guard (mutation-proven)', () => {
  it('same key twice sequentially: one reservation row, one vendor call', async () => {
    const { harness, env } = setup()
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        agent: { id: 'bc-1', name: 'a', status: 'ACTIVE', url: 'https://cursor.com/agents/bc-1', createdAt: 'x', updatedAt: 'x', latestRunId: 'r1', repos: [] },
        run: { id: 'r1', agentId: 'bc-1', status: 'CREATING', createdAt: 'x', updatedAt: 'x' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const a = await cursorCloudAdapter.dispatch(env, req)
    const b = await cursorCloudAdapter.dispatch(env, req)
    expect(a.accepted && b.accepted).toBe(true)
    expect(count(harness, 'harness_reservations')).toBe(1)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(count(harness, 'tasks')).toBe(1)
  })

  it('forced interleave: both callers pass the lookup together -> 1 reservation, 1 task, 1 flight, 1 vendor call', async () => {
    // The sqlite harness serializes calls, so a plain Promise.all never interleaves. Barrier the idempotency LOOKUP
    // (any SELECT on harness_reservations by idempotency_key): the first caller to reach it waits for the second
    // (or 25ms), so with a lookup-then-insert ordering BOTH would pass the lookup before either inserted.
    const { harness, env } = setup()
    let arrived = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const barrier = async () => {
      arrived += 1
      if (arrived >= 2) release()
      await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, 25))])
    }
    const realDb = env.DB
    const lookup = /FROM harness_reservations[^]*idempotency_key = \?/
    const racing = new Proxy(realDb, {
      get(target, key) {
        if (key === 'prepare') {
          return (sql: string) => {
            const stmt = target.prepare(sql)
            if (!lookup.test(sql)) return stmt
            return new Proxy(stmt, {
              get(st, k) {
                if (k === 'bind') {
                  return (...values: unknown[]) => {
                    const bound = st.bind(...values)
                    return new Proxy(bound, {
                      get(b, kk) {
                        if (kk === 'first') return async (...a: unknown[]) => { await barrier(); return (b.first as (...x: unknown[]) => Promise<unknown>)(...a) }
                        const v = Reflect.get(b, kk)
                        return typeof v === 'function' ? v.bind(b) : v
                      },
                    })
                  }
                }
                const v = Reflect.get(st, k)
                return typeof v === 'function' ? v.bind(st) : v
              },
            })
          }
        }
        const v = Reflect.get(target, key)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    const racingEnv = { ...env, DB: racing } as unknown as Env
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        agent: { id: 'bc-r', name: 'a', status: 'ACTIVE', url: 'https://cursor.com/agents/bc-r', createdAt: 'x', updatedAt: 'x', latestRunId: 'rr', repos: [] },
        run: { id: 'rr', agentId: 'bc-r', status: 'CREATING', createdAt: 'x', updatedAt: 'x' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const [a, b] = await Promise.all([
      cursorCloudAdapter.dispatch(racingEnv, { ...req, idempotencyKey: 'k-race' }),
      cursorCloudAdapter.dispatch(racingEnv, { ...req, idempotencyKey: 'k-race' }),
    ])
    expect(a.accepted && b.accepted).toBe(true)
    expect(count(harness, 'harness_reservations')).toBe(1)
    expect(count(harness, 'tasks')).toBe(1)
    expect(count(harness, 'flights')).toBe(1)
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})

describe('attach semantics after rebase onto tri-state launch', () => {
  it('a 5xx on create is launch_unconfirmed and the key is never re-launched', async () => {
    const { harness, env } = setup()
    const fetchMock = vi.fn(async () => new Response('boom', { status: 502 }))
    vi.stubGlobal('fetch', fetchMock)
    const first = await cursorCloudAdapter.dispatch(env, { ...req, idempotencyKey: 'k-5xx' })
    const again = await cursorCloudAdapter.dispatch(env, { ...req, idempotencyKey: 'k-5xx' })
    expect(first.accepted).toBe(false)
    expect(again.accepted).toBe(false)
    // replay of a failed row reports the row's real reason, never a fabricated flight_gate_held
    expect(again.accepted === false && again.error).toBe('launch_unconfirmed')
    const row = harness.sqlite.prepare('SELECT state, last_error FROM harness_reservations').get() as { state: string; last_error: string }
    expect(row.state).toBe('failed')
    expect(row.last_error).toMatch(/^launch_unconfirmed:/)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('task binding is written only together with the attached flip (lost lease writes nothing)', async () => {
    const { harness, env } = setup()
    const r = await reserveCursorCloudWork(env, { ...req, idempotencyKey: 'k-lease' })
    const cursor = { agentId: 'bc-9', runId: 'r9', agentUrl: 'https://cursor.com/agents/bc-9' }
    const taskId = r.task!.id
    // Never leased: state is 'reserved', so the guard matches nothing and the task body stays untouched.
    expect(await bindVendorExecutionWithTaskBinding(env, r.reservationId, 'no-lease', taskId, cursor)).toBe(false)
    const body0 = (harness.sqlite.prepare('SELECT body FROM tasks WHERE id = ?').get(taskId) as { body: string }).body
    expect(body0).not.toContain('cursor_agent')
    const leaseId = await claimAttachLease(env, r.reservationId)
    expect(leaseId).toBeTruthy()
    expect(await bindVendorExecutionWithTaskBinding(env, r.reservationId, leaseId!, taskId, cursor)).toBe(true)
    const body1 = (harness.sqlite.prepare('SELECT body FROM tasks WHERE id = ?').get(taskId) as { body: string }).body
    expect(body1).toContain('cursor_run: r9')
    expect((await getReservation(env, r.reservationId))?.state).toBe('attached')
  })
})
