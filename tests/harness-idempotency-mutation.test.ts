import { afterEach, describe, expect, it, vi } from 'vitest'
import { cursorCloudAdapter } from '../src/harness/adapters/cursor'
import { recordCursorCloudWork, reserveCursorCloudWork } from '../src/cursor/dispatch'
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

  it('same key raced concurrently: one reservation row, exactly one replay flag', async () => {
    const { harness, env } = setup()
    const [a, b] = await Promise.all([reserveCursorCloudWork(env, req), reserveCursorCloudWork(env, req)])
    expect(a.reservationId).toBe(b.reservationId)
    expect(count(harness, 'harness_reservations')).toBe(1)
    expect(Number(a.replay) + Number(b.replay)).toBe(1)
    expect(count(harness, 'tasks')).toBe(1) // loser must not leave an orphan task
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
    const row = harness.sqlite.prepare('SELECT state, last_error FROM harness_reservations').get() as { state: string; last_error: string }
    expect(row.state).toBe('failed')
    expect(row.last_error).toMatch(/^launch_unconfirmed:/)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('task binding is written only together with the attached flip (lost lease writes nothing)', async () => {
    const { harness, env } = setup()
    const r = await reserveCursorCloudWork(env, { ...req, idempotencyKey: 'k-lease' })
    const cursor = { agentId: 'bc-9', runId: 'r9', agentUrl: 'https://cursor.com/agents/bc-9' }
    // Never leased: state is 'reserved', so the guard matches nothing and the task body stays untouched.
    expect(await bindVendorExecutionWithTaskBinding(env, r.reservationId, r.task.id, cursor)).toBe(false)
    const body0 = (harness.sqlite.prepare('SELECT body FROM tasks WHERE id = ?').get(r.task.id) as { body: string }).body
    expect(body0).not.toContain('cursor_agent')
    expect(await claimAttachLease(env, r.reservationId)).toBe(true)
    expect(await bindVendorExecutionWithTaskBinding(env, r.reservationId, r.task.id, cursor)).toBe(true)
    const body1 = (harness.sqlite.prepare('SELECT body FROM tasks WHERE id = ?').get(r.task.id) as { body: string }).body
    expect(body1).toContain('cursor_run: r9')
    expect((await getReservation(env, r.reservationId))?.state).toBe('attached')
  })

  it('recordCursorCloudWork wrapper really binds the reservation', async () => {
    const { env } = setup()
    const out = await recordCursorCloudWork(env, {
      name: 'W', repoUrl: req.repoUrl, prompt: 'p', squadId: 'squad-core', agentId: 'agent-builder',
      cursor: { agentId: 'bc-w', runId: 'rw', agentUrl: 'https://cursor.com/agents/bc-w' },
    })
    const res = await getReservation(env, (await env.DB.prepare('SELECT id FROM harness_reservations').first<{ id: string }>())!.id)
    expect(res?.state).toBe('attached')
    expect(res?.vendor_run_id).toBe('rw')
    expect(out.task.id).toBeDefined()
  })
})
