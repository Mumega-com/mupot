// tests/task-get-receipt-visibility-1702.test.ts — mupot#1702.
// task_get's receipt timeline is visible to exactly three principals: the assignee, a LIVE holder
// of the task's gate_owner lane (same predicate evaluateVerdictGates uses), and org admins. Other
// squad readers keep #1665's narrowing. REAL migration chain, REAL rows.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import { resolveCapabilities } from '../src/auth/capability'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'mumega'
const ORIGIN = 'https://pot.test'
const HASH = 'a'.repeat(64)
const SQ = 'sq-1'
const TASK = 't-gated'
const GATE = 'gate:athena'
const DIGEST = 'b0'.repeat(32)
const SENSITIVE_VALUES = ['tok-secret', 'm-secret-member', DIGEST]
const SENSITIVE_KEYS = ['credential_id', 'member_id', 'request_digest']

let harness: SqliteD1Harness
let env: Env

function authFor(memberId: string, capabilities: CapabilityGrant[] | undefined, extra: Partial<AuthContext> = {}): AuthContext {
  return { userId: memberId, memberId, email: null, role: 'member', tenant: TENANT, channel: 'workspace', boundAgentId: null, capabilities, ...extra }
}
const real = async (m: string, extra: Partial<AuthContext> = {}): Promise<AuthContext> =>
  authFor(m, await resolveCapabilities(env, m), extra)

type R = { ok: boolean; result: {
  task: { execution_receipt_id: unknown }
  latest_dispatch_receipt: { id: string } | null
  dispatch_timeline: { runtime: Array<Record<string, unknown>>; transport: unknown[] } | null
} }
const get = async (a: AuthContext): Promise<R> =>
  (await invokeTool(a, env, 'task_get', { task_id: TASK }, ORIGIN)) as unknown as R

async function seedMember(id: string): Promise<void> {
  await harness.db.prepare(
    `INSERT INTO members (id, tenant, email, display_name, status, created_at) VALUES (?1, ?2, NULL, ?1, 'active', datetime('now'))`,
  ).bind(id, TENANT).run()
}
async function seedCap(id: string, memberId: string, scope: string, scopeId: string | null, capability: string): Promise<void> {
  await harness.db.prepare(
    `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(id, memberId, scope, scopeId, capability).run()
}
function grant(id: string, type: 'agent' | 'member', principalId: string): void {
  harness.sqlite.exec(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
    VALUES ('${id}', '${GATE}', '${type}', '${principalId}', 'm-granter', '2026-01-01T00:00:00Z')`)
}

beforeAll(async () => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('d-1', 'work', 'Work');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQ}', 'd-1', 'one', 'One');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES
      ('ag-assignee', '${SQ}', 'asg', 'Assignee', 'active'),
      ('ag-gate', '${SQ}', 'gate', 'Gate Agent', 'active'),
      ('ag-peer', '${SQ}', 'peer', 'Peer', 'active');
  `)
  for (const m of ['m-squad', 'm-admin', 'm-gate-human', 'm-granter']) await seedMember(m)
  await seedCap('c1', 'm-squad', 'squad', SQ, 'member')
  await seedCap('c2', 'm-admin', 'org', null, 'admin')
  await seedCap('c3', 'm-gate-human', 'squad', SQ, 'member')
  harness.sqlite.exec(`
    INSERT INTO tasks (id, squad_id, title, status, body, done_when, assignee_agent_id, gate_owner, execution_receipt_id)
      VALUES ('${TASK}', '${SQ}', 'gated', 'review', 'b', 'd', 'ag-assignee', '${GATE}', 'd-1');
    INSERT INTO task_dispatch_receipts (id, tenant, task_id, squad_id, agent_id, actor_kind, actor_id, created_at, claimed_at, consumed_at)
      VALUES ('d-1', '${TENANT}', '${TASK}', '${SQ}', 'ag-assignee', 'member', 'm-granter', '2026-02-01T00:00:00Z', '2026-02-01T00:00:01Z', '2026-02-01T00:00:02Z');
  `)
  harness.sqlite.exec('PRAGMA foreign_keys = OFF')
  harness.sqlite.exec(`
    INSERT INTO task_dispatch_runtime_receipts (id, tenant, dispatch_receipt_id, task_id, agent_id, message_id, member_id, credential_id,
      stage, attempt, runtime_address, runtime_receipt_hash, request_digest, artifact_sha256, result, audit_entry_id, created_at)
    VALUES ('rt-1', '${TENANT}', 'd-1', '${TASK}', 'ag-assignee', 'msg-1', 'm-secret-member', 'tok-secret', 'completed', 1, 'rt',
      '${HASH}', '${DIGEST}', '${HASH}', 'done', 'audit-1', '2026-02-01T00:00:03Z')`)
  harness.sqlite.exec('PRAGMA foreign_keys = ON')
  grant('g-agent', 'agent', 'ag-gate')
  grant('g-human', 'member', 'm-gate-human')
})
afterAll(() => harness.close())

const assignee = (): Promise<AuthContext> => real('m-squad', { boundAgentId: 'ag-assignee' })

describe('task_get receipt visibility (#1702)', () => {
  it('the assignee view is unchanged: execution_receipt_id, latest dispatch, plus the timeline', async () => {
    const r = (await get(await assignee())).result
    expect(r.task.execution_receipt_id).toBe('d-1')
    expect(r.latest_dispatch_receipt).toEqual({ id: 'd-1', status: 'completed', last_error: null })
    expect(r.dispatch_timeline?.runtime).toHaveLength(1)
  })

  it('a live gate-holding AGENT sees the timeline with receipt ids, hash, artifact_sha256', async () => {
    const r = (await get(await real('m-squad', { boundAgentId: 'ag-gate' }))).result
    expect(r.task.execution_receipt_id).toBe('d-1')
    expect(r.latest_dispatch_receipt?.id).toBe('d-1')
    expect(r.dispatch_timeline?.runtime).toEqual([expect.objectContaining({
      id: 'rt-1', dispatch_receipt_id: 'd-1', stage: 'completed', runtime_receipt_hash: HASH, artifact_sha256: HASH,
    })])
  })

  it('a live gate-holding MEMBER sees the timeline too', async () => {
    const r = (await get(await real('m-gate-human'))).result
    expect(r.dispatch_timeline?.runtime).toHaveLength(1)
    expect(r.latest_dispatch_receipt?.id).toBe('d-1')
  })

  it("the gate holder's view excludes credential_id, member_id and request_digest", async () => {
    for (const a of [await real('m-squad', { boundAgentId: 'ag-gate' }), await real('m-admin')]) {
      const r = await get(a)
      const raw = JSON.stringify(r)
      for (const v of SENSITIVE_VALUES) expect(raw).not.toContain(v)
      // keys checked on the receipt entries (the task row legitimately has assignee_member_id)
      const entries = [...(r.result.dispatch_timeline?.runtime ?? []), r.result.latest_dispatch_receipt ?? {}]
      for (const e of entries) for (const k of SENSITIVE_KEYS) expect(Object.keys(e)).not.toContain(k)
    }
  })

  it('an org admin (modern org-scope grant) sees the timeline', async () => {
    expect((await get(await real('m-admin'))).result.dispatch_timeline?.runtime).toHaveLength(1)
  })

  it('a plain squad member, another squad agent, and a non-lane principal see NOTHING', async () => {
    for (const a of [await real('m-squad'), await real('m-squad', { boundAgentId: 'ag-peer' })]) {
      const r = (await get(a)).result
      expect(r.task.execution_receipt_id).toBeNull()
      expect(r.latest_dispatch_receipt).toBeNull()
      expect(r.dispatch_timeline).toBeNull()
      expect(JSON.stringify(r)).not.toContain('rt-1')
    }
  })

  it('a grant for a DIFFERENT gate lane confers nothing on this task', async () => {
    harness.sqlite.exec(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
      VALUES ('g-other', 'gate:other', 'agent', 'ag-peer', 'm-granter', '2026-01-01T00:00:00Z')`)
    expect((await get(await real('m-squad', { boundAgentId: 'ag-peer' }))).result.dispatch_timeline).toBeNull()
  })

  it('a paused gate agent / suspended gate member no longer sees the timeline', async () => {
    harness.sqlite.exec(`UPDATE agents SET status = 'paused' WHERE id = 'ag-gate'`)
    harness.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = 'm-gate-human'`)
    expect((await get(await real('m-squad', { boundAgentId: 'ag-gate' }))).result.dispatch_timeline).toBeNull()
    expect((await get(await real('m-gate-human'))).result.dispatch_timeline).toBeNull()
    harness.sqlite.exec(`UPDATE agents SET status = 'active' WHERE id = 'ag-gate'`)
    harness.sqlite.exec(`UPDATE members SET status = 'active' WHERE id = 'm-gate-human'`)
  })

  it('a REVOKED gate grant stops showing the timeline immediately', async () => {
    harness.sqlite.exec(`DELETE FROM gate_grants WHERE id IN ('g-agent', 'g-human')`)
    expect((await get(await real('m-squad', { boundAgentId: 'ag-gate' }))).result.dispatch_timeline).toBeNull()
    expect((await get(await real('m-gate-human'))).result.dispatch_timeline).toBeNull()
  })

  it('gate:agent-self-completion: a grant is NOT lane authority (assignee/admin only), like the verdict path', async () => {
    harness.sqlite.exec(`UPDATE tasks SET gate_owner = 'gate:agent-self-completion' WHERE id = '${TASK}'`)
    harness.sqlite.exec(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
      VALUES ('g-sc', 'gate:agent-self-completion', 'agent', 'ag-gate', 'm-granter', '2026-01-01T00:00:00Z')`)
    expect((await get(await real('m-squad', { boundAgentId: 'ag-gate' }))).result.dispatch_timeline).toBeNull()
    expect((await get(await real('m-admin'))).result.dispatch_timeline).not.toBeNull()
    harness.sqlite.exec(`UPDATE tasks SET gate_owner = '${GATE}' WHERE id = '${TASK}'`)
  })
})
