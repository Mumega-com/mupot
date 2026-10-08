import { describe, expect, it } from 'vitest'
import type { D1Database } from '@cloudflare/workers-types'
import { invokeTool } from '../src/mcp'
import { D1_IN_LIST_CHUNK_SIZE, D1_MAX_BOUND_PARAMETERS, chunkForD1InList } from '../src/lib/d1-in-list'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { AuthContext, Env } from '../src/types'

// mupot#1676 — D1 refuses a statement with more than 100 bound parameters. The sqlite
// double does not, so task_board passed in tests while production returned internal_error.
// strictD1 refuses what production refuses and records the widest bind it saw.

const TENANT = 'mumega'
const SQUAD_ID = 'squad-chunk'
const AGENT_ID = 'agent-chunk'
const MEMBER_ID = 'member-chunk'
const TASK_COUNT = 250

function strictD1(db: D1Database): { db: D1Database; maxBound: () => number } {
  let widest = 0
  const wrapStatement = (statement: object): object => new Proxy(statement, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (prop !== 'bind' || typeof value !== 'function') return value
      return (...values: unknown[]) => {
        widest = Math.max(widest, values.length)
        if (values.length > D1_MAX_BOUND_PARAMETERS) {
          throw new Error(`D1_ERROR: too many SQL variables (${values.length} > ${D1_MAX_BOUND_PARAMETERS})`)
        }
        return wrapStatement(value.apply(target, values) as object)
      }
    },
  })
  const wrapped = new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (prop !== 'prepare' || typeof value !== 'function') return value
      return (sql: string) => wrapStatement(value.call(target, sql) as object)
    },
  })
  return { db: wrapped, maxBound: () => widest }
}

function taskId(i: number): string {
  return `task-chunk-${String(i).padStart(3, '0')}`
}

function fixture() {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-chunk', 'dept-chunk', 'Chunk');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', 'dept-chunk', 'squad-chunk', 'Chunk');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${AGENT_ID}', '${SQUAD_ID}', 'agent-chunk', 'Chunk Agent', 'active');
  `)
  const insertTask = harness.sqlite.prepare(
    `INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, gate_wake_notice, created_at, updated_at)
     VALUES (?, ?, 'Chunk task', 'body', 'done', 'open', ?, ?, ?, ?)`,
  )
  const insertReceipt = harness.sqlite.prepare(
    `INSERT INTO task_dispatch_receipts (id, tenant, task_id, squad_id, agent_id, actor_kind, actor_id, created_at, attempts)
     VALUES (?, ?, ?, ?, ?, 'member', ?, ?, 1)`,
  )
  for (let i = 0; i < TASK_COUNT; i += 1) {
    // Distinct created_at so the ranked order is deterministic.
    const at = new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString()
    insertTask.run(taskId(i), SQUAD_ID, AGENT_ID, `notice-${i}`, at, at)
    insertReceipt.run(`dispatch-chunk-${i}`, TENANT, taskId(i), SQUAD_ID, AGENT_ID, MEMBER_ID, at)
  }
  const strict = strictD1(harness.db)
  const env = { DB: strict.db, TENANT_SLUG: TENANT } as unknown as Env
  const auth: AuthContext = {
    userId: MEMBER_ID,
    memberId: MEMBER_ID,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENT_ID,
    capabilities: [{ member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' }],
  }
  return { harness, env, auth, maxBound: strict.maxBound }
}

interface BoardTask { id: string; gate_wake_notice?: string | null; dispatch_receipt_id?: string }

function expectFullyEnriched(tasks: BoardTask[]): void {
  for (const task of tasks) {
    const i = Number(task.id.slice('task-chunk-'.length))
    expect(task.gate_wake_notice).toBe(`notice-${i}`)
    expect(task.dispatch_receipt_id).toBe(`dispatch-chunk-${i}`)
  }
}

describe('chunkForD1InList', () => {
  it('splits into chunks of at most the chunk size, preserving order', () => {
    const ids = Array.from({ length: 181 }, (_, i) => i)
    const chunks = chunkForD1InList(ids)
    expect(chunks.map((c) => c.length)).toEqual([D1_IN_LIST_CHUNK_SIZE, D1_IN_LIST_CHUNK_SIZE, 1])
    expect(chunks.flat()).toEqual(ids)
    expect(chunkForD1InList([])).toEqual([])
  })

  it('refuses a chunk size that leaves no room under the D1 ceiling', () => {
    expect(() => chunkForD1InList([1], D1_MAX_BOUND_PARAMETERS)).toThrow(RangeError)
    expect(() => chunkForD1InList([1], 0)).toThrow(RangeError)
  })
})

describe('mupot#1676: task reads stay under the D1 bind ceiling', () => {
  it.each([
    ['task_board default limit', 'task_board', {}, 100],
    ['task_board at its max', 'task_board', { limit: 250 }, 250],
    ['task_board at 101', 'task_board', { limit: 101 }, 101],
    ['task_list at 100', 'task_list', { squad_id: SQUAD_ID, limit: 100 }, 100],
  ] as const)('%s returns every row, fully enriched', async (_label, tool, args, expected) => {
    const { harness, env, auth, maxBound } = fixture()
    const res = await invokeTool(auth, env, tool, { squad_id: SQUAD_ID, ...args }, 'https://pot.example')
    expect(res).toMatchObject({ ok: true })
    const result = (res as { result: { tasks?: BoardTask[]; columns?: { open: BoardTask[] } } }).result
    const tasks = tool === 'task_board' ? result.columns!.open : result.tasks!
    expect(tasks).toHaveLength(expected)
    expectFullyEnriched(tasks)
    expect(maxBound()).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS)
    harness.close()
  })
})
