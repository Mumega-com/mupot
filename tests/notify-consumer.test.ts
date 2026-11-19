// Consumer-level proof: handleQueue -> notify -> notifyHadi, driven with the exact payload shape src/agents/execute.ts
// executionEvent() emits (title, project_id possibly null). Real migrated D1, fake fetch for Telegram.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BusEvent, Env } from '../src/types'
import { handleQueue } from '../src/bus/consumer'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

let h: SqliteD1Harness
let fetchMock: ReturnType<typeof vi.fn>
const sent = (): string[] => fetchMock.mock.calls.map((c) => String((JSON.parse((c[1] as RequestInit).body as string) as { text: string }).text))

function envOf(tenant = 'mumega'): Env {
  return { DB: h.db, TENANT_SLUG: tenant, TELEGRAM_BOT_TOKEN: 'bot-token-abc', TELEGRAM_CHAT_ID: '1' } as unknown as Env
}
// Exactly execute.ts executionEvent().
function execEvent(type: 'task.review' | 'task.blocked', over: { project_id?: string | null; tenant?: string; task_id?: string } = {}): BusEvent {
  return {
    type,
    tenant: over.tenant ?? 'mumega',
    squad_id: 'squad-1',
    agent_id: 'agent-1',
    actor: { kind: 'agent', id: 'agent-1' },
    payload: { task_id: over.task_id ?? 'task-1', project_id: over.project_id === undefined ? null : over.project_id, agent_id: 'agent-1', status: type === 'task.review' ? 'review' : 'blocked', title: 'Ship the thing' },
    ts: new Date().toISOString(),
  }
}
async function run(env: Env, e: BusEvent): Promise<void> {
  await handleQueue({ messages: [{ id: 'm', attempts: 1, body: e, ack: vi.fn(), retry: vi.fn() }] } as never, env)
}

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }) as unknown as Response)
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})
afterEach(() => { h.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('consumer -> Telegram', () => {
  it('task.review with project_id NULL is delivered, with title, agent and the verdict line', async () => {
    await run(envOf(), execEvent('task.review', { project_id: null }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [text] = sent()
    expect(text).toContain('Ship the thing')
    expect(text).toContain('task-1')
    expect(text).toContain('agent-1')
    expect(text).toContain('Waiting for your verdict')
    expect(text).not.toContain('project:')
  })

  it('task.blocked with a project is delivered and names the project', async () => {
    await run(envOf(), execEvent('task.blocked', { project_id: 'proj-9' }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sent()[0]).toContain('proj-9')
  })

  it('same task blocked then review: both send; the same state twice within 10 min sends once', async () => {
    await run(envOf(), execEvent('task.blocked'))
    await run(envOf(), execEvent('task.review'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await run(envOf(), execEvent('task.review'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rows are written under the event tenant', async () => {
    await run(envOf('mumega'), execEvent('task.review', { tenant: 'other-pot' }))
    const rows = h.sqlite.prepare('SELECT tenant FROM notif_event').all() as Array<{ tenant: string }>
    expect(rows.map((r) => r.tenant)).toEqual(['other-pot'])
  })
})
