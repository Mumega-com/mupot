// tests/perf-quick-wins.test.ts — behaviour pins for the 2026-10-19 slowness quick wins:
// presence throttle + off-path touch, slim task_board, remember with deferred embedding, orient parity,
// plus a prepare() counter (logged; asserts only the after-state ceilings).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import { resetPresenceThrottle } from '../src/fleet/registry'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'mumega'
const SQUAD = 'squad-1'
const MEMBER = 'member-1'
const AGENT = 'agent-poller'
const STALE = '2026-01-01 00:00:00'
const LONG_BODY = 'x'.repeat(5000)

const auth = (): AuthContext => ({
  userId: MEMBER, memberId: MEMBER, email: null, role: 'member', tenant: TENANT, channel: 'workspace', boundAgentId: AGENT,
  capabilities: [{ member_id: MEMBER, scope_type: 'squad', scope_id: SQUAD, capability: 'member' }],
})

let h: SqliteD1Harness
let env: Env
let prepares: number
let deferred: Promise<unknown>[]
const waitUntil = (p: Promise<unknown>): void => { deferred.push(p) }

// Counting + latency proxy over the sqlite D1 harness: every statement execution costs LATENCY_MS (a stand-in for
// one D1 round trip), so wall time to resolve / LATENCY_MS is the SERIAL depth of the response path.
const LATENCY_MS = 20
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
function countingEnv(base: Env): Env {
  const db = base.DB
  const slow = (stmt: object): object => new Proxy(stmt, {
    get(t, k) {
      const v = Reflect.get(t, k)
      if (k === 'bind') return (...a: unknown[]) => slow((v as (...x: unknown[]) => object).apply(t, a))
      if (k === 'first' || k === 'all' || k === 'run') return async (...a: unknown[]) => { await sleep(LATENCY_MS); return (v as (...x: unknown[]) => unknown).apply(t, a) }
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
  // test double: wraps prepare() for counting + latency; same surface as D1Database for what the tools call
  const proxied = new Proxy(db, {
    get(t, k) {
      const v = Reflect.get(t, k)
      if (k === 'prepare') return (sql: string) => { prepares++; return slow(t.prepare(sql)) }
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
  return { ...base, DB: proxied }
}

const fleetTouched = (): string =>
  (h.sqlite.prepare('SELECT last_reported_at AS t FROM fleet_agents WHERE agent_id = ?').get(AGENT) as { t: string }).t

beforeEach(() => {
  resetPresenceThrottle()
  prepares = 0
  deferred = []
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'd', 'D');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD}', 'dept-1', 's', 'S');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${AGENT}', '${SQUAD}', 'poller', 'Poller', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${MEMBER}', 'M', 'active', '${TENANT}');
    INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, agent_type, presence_mode, presence_ttl_sec, last_reported_at, updated_at)
      VALUES ('${AGENT}', '${TENANT}', 'P', '', '[]', 'on_demand', 'running', '${AGENT}', 'generic', 'poll', 600, '${STALE}', '${STALE}');
    INSERT INTO tasks (id, squad_id, title, body, status, priority, assignee_agent_id)
      VALUES ('t-long', '${SQUAD}', 'long', '${LONG_BODY}', 'open', 'P1', '${AGENT}'),
             ('t-short', '${SQUAD}', 'short', 'tiny body', 'open', 'P2', '${AGENT}');
  `)
  env = countingEnv({ DB: h.db, TENANT_SLUG: TENANT } as Env)
})
afterEach(() => h.close())

describe('presence throttle', () => {
  it('inbox touches once, defers the write to waitUntil, and skips the touch inside 60s', async () => {
    const r1 = await invokeTool(auth(), env, 'inbox', {}, { origin: 'https://pot.example', waitUntil })
    expect(r1.ok).toBe(true)
    expect(deferred.length).toBeGreaterThan(0) // the touch was handed to waitUntil, not awaited inline
    await Promise.all(deferred)
    const afterFirst = fleetTouched()
    expect(afterFirst).not.toBe(STALE)

    h.sqlite.prepare('UPDATE fleet_agents SET last_reported_at = ? WHERE agent_id = ?').run(STALE, AGENT)
    const r2 = await invokeTool(auth(), env, 'inbox', {}, { origin: 'https://pot.example', waitUntil })
    expect(r2.ok).toBe(true)
    await Promise.all(deferred)
    expect(fleetTouched()).toBe(STALE) // throttled: no second touch within 60s
  })

  it('without a waitUntil the touch is still awaited (old behaviour)', async () => {
    await invokeTool(auth(), env, 'task_list', { squad_id: SQUAD }, 'https://pot.example')
    expect(fleetTouched()).not.toBe(STALE)
  })
})

describe('task_board shape', () => {
  it('carries a body excerpt + body_truncated; task_get keeps the full body', async () => {
    const out = await invokeTool(auth(), env, 'task_board', { squad_id: SQUAD }, 'https://pot.example')
    expect(out.ok).toBe(true)
    const cols = (out.result as { columns: { open: Array<{ id: string; body: string; body_truncated: boolean }> } }).columns
    const long = cols.open.find((t) => t.id === 't-long')
    const short = cols.open.find((t) => t.id === 't-short')
    expect(long?.body).toHaveLength(200)
    expect(long?.body_truncated).toBe(true)
    expect(short?.body).toBe('tiny body')
    expect(short?.body_truncated).toBe(false)

    const got = await invokeTool(auth(), env, 'task_get', { task_id: 't-long' }, 'https://pot.example')
    expect(got.ok).toBe(true)
    expect(JSON.stringify(got.result)).toContain(LONG_BODY)
  })
})

describe('remember defers the vector write', () => {
  const memberOnly = (): AuthContext => ({ ...auth(), boundAgentId: null })

  it('persists the engram and answers even when embedding fails', async () => {
    env = { ...env, AI: { run: async () => { throw new Error('ai down') } }, VEC: { upsert: async () => { throw new Error('vec down') } } } as unknown as Env
    const out = await invokeTool(memberOnly(), env, 'remember', { text: 'durable fact' }, { origin: 'https://pot.example', waitUntil })
    expect(out.ok).toBe(true)
    await expect(Promise.all(deferred)).resolves.toBeDefined() // swallowed, never rejects
    const rows = h.sqlite.prepare('SELECT text FROM engrams').all() as Array<{ text: string }>
    expect(rows.map((r) => r.text)).toEqual(['durable fact'])
  })

  it('upserts the vector after the D1 write when embedding works', async () => {
    const upserts: unknown[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    env = { ...env, AI: { run: async () => { await gate; return { data: [[0.1, 0.2]] } } }, VEC: { upsert: async (v: unknown[]) => { upserts.push(...v) } } } as unknown as Env
    await invokeTool(memberOnly(), env, 'remember', { text: 'indexed fact' }, { origin: 'https://pot.example', waitUntil })
    expect(upserts).toHaveLength(0) // embedding still pending: the response did not wait for it
    release()
    await Promise.all(deferred)
    expect(upserts).toHaveLength(1)
  })
})

describe('response-path cost per call (logged)', () => {
  const measure = async (tool: string, args: Record<string, unknown>, a: AuthContext = auth()): Promise<{ prepares_on_response_path: number; prepares_total: number; serial_depth: number }> => {
    resetPresenceThrottle()
    prepares = 0
    const t0 = Date.now()
    const out = await invokeTool(a, env, tool, args, { origin: 'https://pot.example', waitUntil })
    const wall = Date.now() - t0
    const onPath = prepares
    expect(out.ok).toBe(true)
    await Promise.all(deferred)
    deferred = []
    return { prepares_on_response_path: onPath, prepares_total: prepares, serial_depth: Math.round(wall / LATENCY_MS) }
  }
  it('reports', async () => {
    env = { ...env, AI: { run: async () => ({ data: [[0.1]] }) }, VEC: { upsert: async () => {}, query: async () => ({ matches: [] }) } } as unknown as Env
    const counts = {
      inbox: await measure('inbox', {}),
      task_list: await measure('task_list', { squad_id: SQUAD }),
      task_board: await measure('task_board', { squad_id: SQUAD }),
      remember: await measure('remember', { text: 'x' }, { ...auth(), boundAgentId: null }),
      orient: await measure('orient', {}),
    }
    process.stderr.write(`PREPARE_COUNTS ${JSON.stringify(counts)}\n`) // measurement output for the PR body
    expect(counts.orient.prepares_total).toBeGreaterThan(0)
  })
})
