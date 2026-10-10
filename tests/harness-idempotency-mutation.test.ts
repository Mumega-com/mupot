import { afterEach, describe, expect, it, vi } from 'vitest'
import { cursorCloudAdapter } from '../src/harness/adapters/cursor'
import { reserveCursorCloudWork } from '../src/cursor/dispatch'
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
