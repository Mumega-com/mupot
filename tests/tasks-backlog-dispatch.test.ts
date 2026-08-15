import { describe, expect, it, vi } from 'vitest'
import { tasksApp } from '../src/tasks'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { BusEvent, Env } from '../src/types'

const TENANT = 'tenant-a'
const SQUAD_ID = 'squad-a'
const AGENT_ID = 'agent-a'

function seed(harness: SqliteD1Harness): void {
  const sql = harness.sqlite
  sql.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', 'dept-a', 'squad-a', 'Squad A');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('${AGENT_ID}', '${SQUAD_ID}', 'agent-a', 'Agent A', 'operator', 'test', 'active');
  `)
}

function makeEnv(harness: SqliteD1Harness, events: BusEvent[]): Env {
  return {
    TENANT_SLUG: TENANT,
    BRAND: 'Test',
    DB: harness.db,
    SESSIONS: {
      get: vi.fn(async (key: string) => key === 'sess:owner-session'
        ? JSON.stringify({ userId: 'owner-1', email: 'owner@test.invalid', role: 'owner', createdAt: '2026-07-12T00:00:00.000Z' })
        : null),
      delete: vi.fn(async () => undefined),
    },
    BUS: { send: vi.fn(async (event: BusEvent) => { events.push(event) }) },
  } as unknown as Env
}

function request(path: string, body: Record<string, unknown>): Request {
  return new Request(`https://pot.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Cookie: 'mupot_session=owner-session',
      Origin: 'https://pot.test',
    },
    body: JSON.stringify(body),
  })
}

describe('Flight-006 Slice 1 — backlog creation vs dispatch', () => {
  it('dispatch:false creates an unassigned task and emits NO runtime events (hard-exclusion)', async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seed(harness)
    const events: BusEvent[] = []
    const env = makeEnv(harness, events)

    const res = await tasksApp.fetch(request('/', {
      squad_id: SQUAD_ID,
      title: 'Planning-only backlog task',
      done_when: 'The plan is captured with no execution.',
      body: 'Just capturing work for later triage.',
      priority: 'P2',
      dispatch: false,
    }), env)

    expect(res.status).toBe(201)
    const body = await res.json() as { task: { id: string; assignee_agent_id: string | null; priority: string | null; status: string }, dispatched: boolean }
    expect(body.task.assignee_agent_id).toBeNull()
    expect(body.task.priority).toBe('P2')
    expect(body.task.status).toBe('open')
    expect(body.dispatched).toBe(false)

    // HARD-EXCLUSION: neither task.created nor agent.wake was emitted, so the
    // task.created → dispatchSquad → SquadCoordinatorDO wake-all loop never fires.
    expect(events).toEqual([])
    harness.close()
  })

  it('owner-supplied done_when is stored verbatim', async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seed(harness)
    const events: BusEvent[] = []
    const env = makeEnv(harness, events)

    const res = await tasksApp.fetch(request('/', {
      squad_id: SQUAD_ID,
      title: 'Backlog with explicit done_when',
      done_when: 'The invoice report exists and names follow-ups.',
      dispatch: false,
    }), env)

    expect(res.status).toBe(201)
    const body = await res.json() as { task: { done_when: string } }
    expect(body.task.done_when).toBe('The invoice report exists and names follow-ups.')
    expect(events).toEqual([])
    harness.close()
  })

  it('rejects an invalid priority with 400', async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seed(harness)
    const events: BusEvent[] = []
    const env = makeEnv(harness, events)

    const res = await tasksApp.fetch(request('/', {
      squad_id: SQUAD_ID,
      title: 'Bad priority',
      done_when: 'x',
      priority: 'URGENT!!',
      dispatch: false,
    }), env)

    expect(res.status).toBe(400)
    expect(events).toEqual([])
    harness.close()
  })

  it('dispatch:true with an assignee still emits task.created + agent.wake', async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seed(harness)
    const events: BusEvent[] = []
    const env = makeEnv(harness, events)

    const res = await tasksApp.fetch(request('/', {
      squad_id: SQUAD_ID,
      title: 'Dispatch me',
      done_when: 'The agent does the thing.',
      assignee_agent_id: AGENT_ID,
      dispatch: true,
    }), env)

    expect(res.status).toBe(201)
    const types = events.map((e) => e.type)
    expect(types).toContain('task.created')
    expect(types).toContain('agent.wake')
    harness.close()
  })
})
