// mupot#1812 P2-3 - a HARNESS session must not release an execution hold, at ANY of the three doors.
// Defect class: a release policy that refuses only `boundAgentId` treats "the human's grant worn by an
// agent runtime" as the human. applySeatHandle falls back to the plain human session when a seat handle
// is missing/rejected, and an OAuth harness grant carries harnessId with no seat at all. Each door
// (MCP execution_release, MCP task_update reassign, REST PATCH /tasks/:id reassign) is tested with every
// harness shape (harnessId, harnessCredential, seatBinding) and with the plain-human positives that must
// keep working. Real migrated schema, real handlers, real policy.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/auth', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/auth')>()
  return {
    ...orig,
    requireAuth: async (c: { req: { header: (n: string) => string | undefined }; set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('auth', JSON.parse(c.req.header('x-test-auth') ?? '{}'))
      await next()
    },
  }
})

import { invokeTool } from '../src/mcp'
import { tasksApp } from '../src/tasks'
import { canReleaseExecutionHold } from '../src/agents/execution-release-policy'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'mumega'
const T0 = '2026-09-01T00:00:00.000Z'
let h: SqliteD1Harness
let env: Env

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  env = { DB: h.db, TENANT_SLUG: TENANT, BRAND: 'Mupot', BUS: { send: async () => undefined } } as unknown as Env
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'd', 'D');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('sq', 'dept-1', 'sq', 'Sq');
    INSERT INTO agents (id, squad_id, slug, name, status, created_at) VALUES ('ag', 'sq', 'ag', 'Ag', 'active', '${T0}');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('m-admin', 'A', 'active', '${TENANT}'), ('m-owner', 'O', 'active', '${TENANT}');
    INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, created_at, updated_at)
      VALUES ('t1', 'sq', 't', 'b', 'done', 'blocked', NULL, '${T0}', '${T0}');
    INSERT INTO execution_holds (task_id, escalation_id, agent_id, refused_count, reason, held_at)
      VALUES ('t1', 'esc', 'ag', 3, 'x', '${T0}');
    INSERT INTO task_execution_attempts (task_id, refused_count, last_agent_id, first_at, last_at) VALUES ('t1', 3, 'ag', '${T0}', '${T0}');
  `)
})
afterEach(() => h.close())

const sqAdminCaps = [{ member_id: 'm-admin', scope_type: 'squad', scope_id: 'sq', capability: 'admin' }]
const base = (over: Partial<AuthContext>): AuthContext => ({
  userId: 'm-admin', memberId: 'm-admin', email: null, role: 'member', tenant: TENANT, channel: 'workspace',
  boundAgentId: null, capabilities: sqAdminCaps, ...over,
}) as AuthContext

// Every harness shape. The first is the exact incident: a squad-admin's OAuth harness grant, no seat.
const HARNESS_SHAPES: Array<[string, Partial<AuthContext>]> = [
  ['OAuth harness grant, no seat handle (harnessId only)', { harnessId: 'h-1' }],
  ['harness-token session (harnessCredential)', { harnessCredential: true }],
  ['seat session shape (seatBinding)', { seatBinding: { seatId: 's', label: 'l', harnessId: 'h-1', grantTokenId: 'g', humanMemberId: 'm-admin' } }],
  ['rejected seat handle falling back to the human session (harnessId + seatInputs.handleRejected)', {
    harnessId: 'h-1', seatInputs: { handleRejected: true, hints: { openai_session: false, openai_subject: false, codex_thread_id: false } } }],
]
// Plain human principals - all three must still release.
const PLAIN_HUMANS: Array<[string, Partial<AuthContext>]> = [
  ['workspace/operator member token', {}],
  ['member-bound OAuth grant WITHOUT a harness (harnessId null)', { harnessId: null }],
  ['dashboard cookie session (registered web session)', { role: 'owner', memberId: undefined, userId: 'u', capabilities: undefined, webSessionMemberId: 'm-owner' }],
]

const held = () => (h.sqlite.prepare('SELECT released_at FROM execution_holds WHERE task_id = ?').get('t1') as { released_at: string | null }).released_at === null
const counter = () => h.sqlite.prepare('SELECT refused_count FROM task_execution_attempts WHERE task_id = ?').get('t1')
const taskRow = () => h.sqlite.prepare('SELECT assignee_agent_id a FROM tasks WHERE id = ?').get('t1') as { a: string | null }
const mcp = (auth: AuthContext, tool: string, args: Record<string, unknown>) => invokeTool(auth, env, tool, args, 'https://pot.example')
async function patch(a: AuthContext, body: unknown) {
  return tasksApp.fetch(new Request('https://pot.test/t1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-test-auth': JSON.stringify(a), Origin: 'https://pot.test' },
    body: JSON.stringify(body),
  }), env)
}

describe('policy: canReleaseExecutionHold', () => {
  for (const [name, over] of HARNESS_SHAPES) {
    it(`refuses a squad-admin ${name}`, async () => {
      expect(await canReleaseExecutionHold(env, base(over), 'sq')).toBe(false)
    })
  }
  for (const [name, over] of PLAIN_HUMANS) {
    it(`allows ${name}`, async () => {
      expect(await canReleaseExecutionHold(env, base(over), 'sq')).toBe(true)
    })
  }
})

describe('door 1: MCP execution_release', () => {
  for (const [name, over] of HARNESS_SHAPES) {
    it(`refuses ${name}; hold and counter intact`, async () => {
      const out = await mcp(base(over), 'execution_release', { task_id: 't1', reason: 'harness tries' })
      expect(out.ok).toBe(false)
      expect(held()).toBe(true)
      expect(counter()).toEqual({ refused_count: 3 })
    })
  }
  for (const [name, over] of PLAIN_HUMANS.slice(0, 2)) {
    it(`releases for ${name}`, async () => {
      const out = await mcp(base(over), 'execution_release', { task_id: 't1', reason: 'human looked' })
      expect(out).toMatchObject({ ok: true, result: { status: 'released' } })
      expect(held()).toBe(false)
    })
  }
})

describe('door 2: MCP task_update reassign of a held task', () => {
  for (const [name, over] of HARNESS_SHAPES) {
    it(`refuses ${name}: task_held, task unchanged, hold stays`, async () => {
      const out = await mcp(base(over), 'task_update', { task_id: 't1', assignee_agent_id: 'ag' })
      expect(out.ok).toBe(false)
      // a harnessCredential session is refused even earlier by invokeTool's allow-list; either way no release
      expect(['task_held', 'harness_session_seat_required']).toContain((out as { error?: string }).error)
      if (!over.harnessCredential) expect(out).toMatchObject({ error: 'task_held' })
      expect(taskRow().a).toBeNull()
      expect(held()).toBe(true)
    })
  }
  for (const [name, over] of PLAIN_HUMANS.slice(0, 2)) {
    it(`releases for ${name}`, async () => {
      const out = await mcp(base(over), 'task_update', { task_id: 't1', assignee_agent_id: 'ag' })
      expect(out.ok, JSON.stringify(out)).toBe(true)
      expect(held()).toBe(false)
      expect(taskRow().a).toBe('ag')
    })
  }
})

describe('door 3: REST PATCH /tasks/:id reassign of a held task', () => {
  for (const [name, over] of HARNESS_SHAPES) {
    it(`refuses ${name}: 409 task_held, hold stays`, async () => {
      const res = await patch(base(over), { assignee_agent_id: 'ag' })
      expect(res.status, await res.clone().text()).toBe(409)
      expect(await res.json()).toMatchObject({ error: 'task_held' })
      expect(taskRow().a).toBeNull()
      expect(held()).toBe(true)
    })
  }
  for (const [name, over] of PLAIN_HUMANS) {
    it(`releases for ${name}`, async () => {
      const res = await patch(base(over), { assignee_agent_id: 'ag' })
      expect(res.status, await res.clone().text()).toBe(200)
      expect(held()).toBe(false)
      expect(taskRow().a).toBe('ag')
    })
  }
})
