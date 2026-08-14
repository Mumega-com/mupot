// tests/rank-and-subtask.test.ts — migrations/0079.
//
// FILENAME NOTE: this file is deliberately NOT named after the word it tests.
// scripts/no-secrets.mjs matches an OpenAI-key shape, and the literal "ta" + "sk-"
// followed by 20+ word characters satisfies it — so any tests/task-<long-name> file
// trips the guard on its own path. The fix is the filename. Loosening a secrets
// scanner so a test file can keep a nicer name is trading a real guard for cosmetics.


import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { invokeTool } from '../src/mcp/index'
import { rankTasks, priorityOrderSql } from '../src/tasks/ranking'
import type { AuthContext, CapabilityGrant, Env, Task } from '../src/types'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'mumega'
const ORIGIN = 'https://pot.test'

function applyAllMigrations(sqlite: SqliteD1Harness['sqlite']): void {
  const failures: string[] = []
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    } catch (error) {
      failures.push(`${file}: ${String(error)}`)
    }
  }
  if (failures.length > 0) throw new Error(`migrations did not apply cleanly:\n${failures.join('\n')}`)
}

let harness: SqliteD1Harness
let env: Env

function squad(id: string): void {
  harness.sqlite.exec(
    `INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('${id}-d', '${id}-d', '${id}-d');
     INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('${id}', '${id}-d', '${id}', '${id}');`,
  )
}

function auth(capabilities: CapabilityGrant[] = [{ member_id: 'm1', scope_type: 'org', scope_id: null, capability: 'admin' } as CapabilityGrant]): AuthContext {
  return {
    userId: 'm1', email: 'm1@example.test', role: 'member', tenant: TENANT,
    channel: 'workspace', memberId: 'm1', capabilities, boundAgentId: null,
  } as AuthContext
}

/** Insert directly so created_at is controllable — ordering is what is under test. */
function seedTask(id: string, squadId: string, opts: { priority?: string | null; status?: string; createdAt?: string } = {}): void {
  const priority = opts.priority === undefined || opts.priority === null ? 'NULL' : `'${opts.priority}'`
  harness.sqlite.exec(
    `INSERT INTO tasks (id, squad_id, title, done_when, status, priority, created_at, updated_at)
     VALUES ('${id}', '${squadId}', '${id}', 'checkable', '${opts.status ?? 'open'}', ${priority},
             '${opts.createdAt ?? '2026-01-01T00:00:00Z'}', '${opts.createdAt ?? '2026-01-01T00:00:00Z'}')`,
  )
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = { DB: harness.db, TENANT_SLUG: TENANT, BUS: { send: async () => {} } } as unknown as Env
  squad('sq')
})

afterEach(() => harness.close())

describe('task_create — priority and parent', () => {
  it('stores a priority and leaves it NULL when omitted', async () => {
    const withP = await invokeTool(auth(), env, 'task_create', { squad_id: 'sq', title: 'ranked', done_when: 'check done', priority: 'P0', body: 'P0 outage on production — requires immediate rollback and incident review.' }, ORIGIN)
    const without = await invokeTool(auth(), env, 'task_create', { squad_id: 'sq', title: 'unranked', done_when: 'check done' }, ORIGIN)

    expect((withP as { result?: { task?: Task } }).result?.task?.priority).toBe('P0')
    // Untriaged must stay NULL, not be defaulted. A default priority is a number that looks
    // like a decision and is not.
    expect((without as { result?: { task?: Task } }).result?.task?.priority).toBeNull()
  })

  it('refuses an unrecognised priority instead of coercing it', async () => {
    const out = await invokeTool(auth(), env, 'task_create', { squad_id: 'sq', title: 't', done_when: 'check done', priority: 'P9' }, ORIGIN)
    expect((out as { error?: string }).error).toBe('invalid_priority')
  })

  it('refuses a parent on a DIFFERENT squad — a subtask must not cross an authz boundary', async () => {
    squad('other')
    seedTask('foreign-parent', 'other')

    const out = await invokeTool(auth(), env, 'task_create', { squad_id: 'sq', title: 'child', done_when: 'check done', parent_task_id: 'foreign-parent' }, ORIGIN)

    // Reads are squad-scoped, so a cross-squad parent would return a tree whose branches
    // cross the capability check that gated the read.
    expect((out as { error?: string }).error).toBe('parent_task_cross_squad')
  })

  it('links a subtask to a parent on the same squad', async () => {
    seedTask('parent-1', 'sq')
    const out = await invokeTool(auth(), env, 'task_create', { squad_id: 'sq', title: 'child', done_when: 'check done', parent_task_id: 'parent-1' }, ORIGIN)
    expect((out as { result?: { task?: Task } }).result?.task?.parent_task_id).toBe('parent-1')
  })
})

describe('task_update — re-rank and re-parent', () => {
  it('an explicit null RE-TRIAGES back to untriaged', async () => {
    seedTask('t1', 'sq', { priority: 'P0' })
    const out = await invokeTool(auth(), env, 'task_update', { task_id: 't1', priority: null }, ORIGIN)
    expect((out as { error?: string }).error).toBeUndefined()
    const row = harness.sqlite.prepare(`SELECT priority FROM tasks WHERE id = 't1'`).all()[0] as { priority: string | null }
    // null and absent are DIFFERENT here, and only branching on `=== undefined` keeps them so.
    expect(row.priority).toBeNull()
  })

  it('refuses self-parenting', async () => {
    seedTask('t1', 'sq')
    const out = await invokeTool(auth(), env, 'task_update', { task_id: 't1', parent_task_id: 't1' }, ORIGIN)
    expect((out as { error?: string }).error).toBe('parent_task_self')
  })

  it('refuses an immediate A->B->A cycle', async () => {
    seedTask('a', 'sq')
    seedTask('b', 'sq')
    await invokeTool(auth(), env, 'task_update', { task_id: 'b', parent_task_id: 'a' }, ORIGIN)
    const out = await invokeTool(auth(), env, 'task_update', { task_id: 'a', parent_task_id: 'b' }, ORIGIN)
    expect((out as { error?: string }).error).toBe('parent_task_cycle')
  })

  it('still refuses `approved` — but now SAYS which tool sets it', async () => {
    seedTask('t1', 'sq', { status: 'review' })
    const out = await invokeTool(auth(), env, 'task_update', { task_id: 't1', status: 'approved' }, ORIGIN)

    expect((out as { error?: string }).error).toBe('invalid_status')
    // The refusal is correct — a task must not approve itself. What was missing was the
    // next step: this was read as "tasks are stuck in review" for weeks when the real
    // answer was "use task_verdict". A dead end and a signpost are different products.
    const detail = JSON.stringify((out as { detail?: unknown }).detail ?? {})
    expect(detail).toContain('task_verdict')
  })
})

describe('READS actually project the new columns', () => {
  // Added after a mutation exposed this hole: deleting `priority` from TASK_SELECT_COLUMNS
  // left all 12 tests green, because task_create returns the IN-MEMORY task it just built
  // rather than a re-read. So nothing proved a task READ carried the field — the create
  // assertions were testing my object literal, not the database. Same shape as #684: an
  // assertion anchored to my model of the system instead of the system.
  it('task_list returns priority and parent_task_id', async () => {
    seedTask('parent-1', 'sq', { priority: 'P0' })
    await invokeTool(auth(), env, 'task_update', { task_id: 'parent-1', priority: 'P0' }, ORIGIN)
    seedTask('child-1', 'sq', { priority: 'P2' })
    await invokeTool(auth(), env, 'task_update', { task_id: 'child-1', parent_task_id: 'parent-1' }, ORIGIN)

    const out = await invokeTool(auth(), env, 'task_list', { squad_id: 'sq' }, ORIGIN)
    const tasks = (out as { result?: { tasks?: Task[] } }).result?.tasks ?? []
    const parent = tasks.find((t) => t.id === 'parent-1')
    const child = tasks.find((t) => t.id === 'child-1')

    expect(parent?.priority).toBe('P0')
    expect(child?.parent_task_id).toBe('parent-1')
  })

  it('task_board returns priority', async () => {
    seedTask('b1', 'sq', { priority: 'P1' })
    const out = await invokeTool(auth(), env, 'task_board', { squad_id: 'sq' }, ORIGIN)
    const columns = (out as { result?: { columns?: Record<string, Task[]> } }).result?.columns ?? {}
    expect(columns.open?.find((t) => t.id === 'b1')?.priority).toBe('P1')
  })
})

describe('ranking — priority sits below the status band and above created_at', () => {
  const t = (id: string, status: string, priority: string | null, createdAt: string): Task =>
    ({ id, squad_id: 'sq', status, priority, created_at: createdAt } as unknown as Task)

  it('a P0 filed today outranks an untriaged task filed long ago', async () => {
    const ranked = rankTasks(
      [t('old-untriaged', 'open', null, '2026-01-01T00:00:00Z'), t('new-p0', 'open', 'P0', '2026-08-05T00:00:00Z')],
      new Map(),
    )
    // Without this, a P0 sits behind every unranked task filed earlier — precisely the
    // failure a priority field exists to fix.
    expect(ranked.map((r) => r.id)).toEqual(['new-p0', 'old-untriaged'])
  })

  it('in_progress still beats an open P0 — WIP discipline outranks priority', async () => {
    const ranked = rankTasks(
      [t('open-p0', 'open', 'P0', '2026-01-01T00:00:00Z'), t('wip-p3', 'in_progress', 'P3', '2026-08-05T00:00:00Z')],
      new Map(),
    )
    expect(ranked.map((r) => r.id)).toEqual(['wip-p3', 'open-p0'])
  })

  it('anti-starvation still applies WITHIN a priority', async () => {
    const ranked = rankTasks(
      [t('newer', 'open', 'P1', '2026-08-05T00:00:00Z'), t('older', 'open', 'P1', '2026-01-01T00:00:00Z')],
      new Map(),
    )
    expect(ranked.map((r) => r.id)).toEqual(['older', 'newer'])
  })

  it('THE LIMIT HAZARD: SQL ordering agrees with the in-memory comparator', () => {
    // The SQL ORDER BY decides which rows survive LIMIT. If it disagrees with rankTasks,
    // high-priority rows are dropped BEFORE the ranker ever sees them — and the ranker
    // then returns a perfectly-ordered list of the wrong tasks, which looks correct.
    seedTask('p3', 'sq', { priority: 'P3' })
    seedTask('none', 'sq', { priority: null })
    seedTask('p0', 'sq', { priority: 'P0' })
    seedTask('p1', 'sq', { priority: 'P1' })

    const sqlOrder = (harness.sqlite
      .prepare(`SELECT id FROM tasks ORDER BY ${priorityOrderSql()}, created_at ASC`)
      .all() as { id: string }[]).map((r) => r.id)

    const rows = harness.sqlite.prepare('SELECT id, status, priority, created_at FROM tasks').all() as unknown as Task[]
    const memoryOrder = rankTasks(rows, new Map()).map((r) => r.id)

    expect(sqlOrder).toEqual(['p0', 'p1', 'p3', 'none'])
    expect(memoryOrder).toEqual(sqlOrder)
  })
})
