import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVerdictGateCache, evaluateVerdictGates } from '../src/tasks'
import { VerdictIndependenceError, writeVerdict } from '../src/tasks/service'
import { invokeTool } from '../src/mcp/index'
import type { AuthContext, CapabilityGrant, Env, Task } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'grant-admin-waiver'
const SQUAD = 'squad-1'
const GATE = 'gate:review'
const TASK = 'task-1'

const caps = (memberId: string, extra: CapabilityGrant[] = []): CapabilityGrant[] => [
  { member_id: memberId, scope_type: 'squad', scope_id: SQUAD, capability: 'member' }, ...extra,
]
const memberAuth = (memberId: string, extra: CapabilityGrant[] = []): AuthContext => ({
  userId: memberId, email: `${memberId}@test.com`, role: 'member', tenant: TENANT,
  memberId, capabilities: caps(memberId, extra), boundAgentId: null,
} as AuthContext)

describe('owner-self takes precedence over supervisory standing', () => {
  let harness: SqliteD1Harness
  let env: Env
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
    const s = harness.sqlite
    s.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept-1', 'Dept');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD}', 'dept-1', 'sq1', 'Squad');
    `)
    s.prepare(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('A', ?, 'a', 'A', 'member', 'test', 'active')`).run(SQUAD)
    for (const m of ['GADMIN', 'SQADMIN']) {
      s.prepare(`INSERT INTO members (id, email, display_name, status, tenant) VALUES (?, ?, ?, 'active', ?)`).run(m, `${m}@test.com`, m, TENANT)
      s.prepare(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES (?, ?, 'member', ?, 'g', datetime('now'))`).run(`g-${m}`, GATE, m)
    }
    s.prepare(
      `INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, assignee_agent_id, created_at, updated_at)
       VALUES (?, ?, 'T', 'b', 'done', 'review', ?, 'A', datetime('now'), datetime('now'))`,
    ).run(TASK, SQUAD, GATE)
  })
  afterEach(() => harness.close())

  const decide = (auth: AuthContext) =>
    invokeTool(auth, env, 'task_verdict', { task_id: TASK, verdict: 'approved' }, 'https://pot.test') as unknown as Promise<{ ok: boolean; error?: string }>

  const adminAuth = (role: 'member' | 'admin' = 'member') => ({
    ...memberAuth('GADMIN', [{ member_id: 'GADMIN', scope_type: 'org', scope_id: null, capability: 'admin' }]), role,
  })
  const seedLenses = () => {
    const s = harness.sqlite
    s.prepare(`INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, result_text)
      VALUES ('current', ?, ?, ?, 'A', '/tmp/x', ?, ?, 'RESULT')`).run(TENANT, TASK, SQUAD, 'ab'.repeat(32), 'cd'.repeat(32))
    s.prepare('UPDATE tasks SET result = ? WHERE id = ?').run('RESULT', TASK)
    for (const [i, name] of ['correctness', 'adversarial'].entries()) {
      const id = `L${i}`
      s.prepare(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES (?, ?, ?, ?, 'member', 'test', 'active')`).run(id, SQUAD, id, id)
      s.prepare(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES (?, ?, 'agent', ?, 'g', datetime('now'))`).run(`g-${id}`, GATE, id)
      s.prepare(`INSERT INTO task_review_lenses (id, task_id, submission_id, result_digest, gate_owner, lens, reviewer_kind, reviewer_id, outcome, created_at)
        VALUES (?, ?, 'current', ?, ?, ?, 'agent', ?, 'pass', datetime('now'))`).run(`l-${id}`, TASK, 'cd'.repeat(32), GATE, name, id)
    }
  }

  for (const role of ['member', 'admin'] as const) {
    for (const party of ['assignee', 'submitter', 'runner']) {
      it(`${role} admin owning a party ${party} needs two lenses and records owner_self`, async () => {
        const s = harness.sqlite
        s.prepare(`UPDATE agents SET owner_member_id = 'GADMIN' WHERE id = 'A'`).run()
        if (party !== 'assignee') {
          s.prepare(`UPDATE tasks SET assignee_agent_id = NULL WHERE id = ?`).run(TASK)
          if (party === 'submitter') {
            s.prepare(`INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest)
              VALUES ('past', ?, ?, ?, 'A', '/tmp/past', ?, ?)`).run(TENANT, TASK, SQUAD, 'ef'.repeat(32), 'ab'.repeat(32))
          } else {
            s.exec('PRAGMA foreign_keys = OFF')
            s.prepare(`INSERT INTO task_dispatch_runtime_receipts (id, tenant, dispatch_receipt_id, task_id, agent_id, message_id, member_id, credential_id, stage, attempt,
              runtime_address, runtime_receipt_hash, request_digest, audit_entry_id, created_at)
              VALUES ('rr', ?, 'dr', ?, 'A', 'm', 'other', 'c', 'runtime_consumed', 1, 'rt', ?, ?, 'audit', datetime('now'))`).run(TENANT, TASK, 'ab'.repeat(32), 'cd'.repeat(32))
            s.exec('PRAGMA foreign_keys = ON')
          }
        }
        expect(await evaluateVerdictGates(env, adminAuth(role), { id: TASK, squad_id: SQUAD, gate_owner: GATE, assignee_agent_id: party === 'assignee' ? 'A' : null }, 'approved')).toMatchObject({ allowed: false, code: 'self_verdict' })
        expect(await decide(adminAuth(role))).toMatchObject({ ok: false, error: 'self_verdict' })
        expect(s.prepare('SELECT * FROM task_verdicts').all()).toHaveLength(0)
        seedLenses()
        expect(await decide(adminAuth(role))).toMatchObject({ ok: true })
        expect(s.prepare('SELECT independence_waiver FROM task_verdicts').get()).toMatchObject({ independence_waiver: 'owner_self' })
      })
    }
  }

  it.each([true, false])('memoises party ownership (%s) across concurrent approve/reject checks within one request', async (owns) => {
    const s = harness.sqlite
    s.prepare(`UPDATE agents SET owner_member_id = ? WHERE id = 'A'`).run(owns ? 'GADMIN' : null)
    s.prepare(`INSERT INTO agent_keys (tenant, agent_id, pubkey, member_id, created_at) VALUES (?, 'A', 'pk-admin', 'GADMIN', unixepoch())`).run(TENANT)
    const reads = vi.spyOn(env.DB, 'prepare') // observe real D1 reads; do not replace the database
    try {
      const cache = createVerdictGateCache()
      const task = { id: TASK, squad_id: SQUAD, gate_owner: GATE, assignee_agent_id: 'A' }
      const results = await Promise.all([
        evaluateVerdictGates(env, adminAuth(), task, 'approved', cache),
        evaluateVerdictGates(env, adminAuth(), task, 'rejected', cache),
      ])
      const expected = owns ? { allowed: false, code: 'self_verdict' } : { allowed: true, independenceWaiver: 'admin_supervisory' }
      for (const result of results) expect(result).toMatchObject(expected)
      const ownershipReads = () => reads.mock.calls.filter(([sql]) => sql.includes('agents po')).length
      expect(ownershipReads()).toBe(1)
      // A new request must re-read ownership, including a previously cached false.
      s.prepare(`UPDATE agents SET owner_member_id = ? WHERE id = 'A'`).run(owns ? null : 'GADMIN')
      expect(await evaluateVerdictGates(env, adminAuth(), task, 'approved', createVerdictGateCache()))
        .toMatchObject(owns ? { allowed: true, independenceWaiver: 'admin_supervisory' } : { allowed: false, code: 'self_verdict' })
      expect(ownershipReads()).toBe(2)
    } finally {
      reads.mockRestore()
    }
  })

  it.each(['member', 'admin'] as const)('an owner also bound to the party agent stays refused with %s role, even with lenses and an override request', async (role) => {
    const s = harness.sqlite
    s.prepare(`UPDATE agents SET owner_member_id = 'GADMIN' WHERE id = 'A'`).run()
    s.prepare(`INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES (?, 'A', 'GADMIN', datetime('now'))`).run(TENANT)
    seedLenses()
    expect(await evaluateVerdictGates(env, adminAuth(role), { id: TASK, squad_id: SQUAD, gate_owner: GATE, assignee_agent_id: 'A' }, 'approved'))
      .toMatchObject({ allowed: false, code: 'self_verdict' })
    expect(await invokeTool(adminAuth(role), env, 'task_verdict', { task_id: TASK, verdict: 'approved', override_self_verdict: true }, 'https://pot.test'))
      .toMatchObject({ ok: false, error: 'self_verdict' })
    expect(s.prepare('SELECT * FROM task_verdicts').all()).toHaveLength(0)
    expect(s.prepare('SELECT status FROM tasks WHERE id = ?').get(TASK)).toMatchObject({ status: 'review' })
  })

  it('an admin affiliated through a key without owning a party retains admin_supervisory', async () => {
    harness.sqlite.prepare(`INSERT INTO agent_keys (tenant, agent_id, pubkey, member_id, created_at) VALUES (?, 'A', 'pk-admin', 'GADMIN', unixepoch())`).run(TENANT)
    expect(await decide(adminAuth())).toMatchObject({ ok: true })
    expect(harness.sqlite.prepare('SELECT independence_waiver FROM task_verdicts').get()).toMatchObject({ independence_waiver: 'admin_supervisory' })
  })

  it('an admin owning one party cannot use supervision for a non-owner affiliation to another', async () => {
    const s = harness.sqlite
    s.prepare(`UPDATE agents SET owner_member_id = 'GADMIN' WHERE id = 'A'`).run()
    s.prepare(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('B', ?, 'b', 'B', 'member', 'test', 'active')`).run(SQUAD)
    s.prepare(`INSERT INTO agent_keys (tenant, agent_id, pubkey, member_id, created_at) VALUES (?, 'B', 'pk-b', 'GADMIN', unixepoch())`).run(TENANT)
    s.prepare(`INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest)
      VALUES ('past-b', ?, ?, ?, 'B', '/tmp/b', ?, ?)`).run(TENANT, TASK, SQUAD, 'ab'.repeat(32), 'cd'.repeat(32))
    seedLenses()
    expect(await evaluateVerdictGates(env, adminAuth(), { id: TASK, squad_id: SQUAD, gate_owner: GATE, assignee_agent_id: 'A' }, 'approved'))
      .toMatchObject({ allowed: false, code: 'self_verdict' })
    expect(await decide(adminAuth())).toMatchObject({ ok: false, error: 'self_verdict' })
    expect(s.prepare('SELECT * FROM task_verdicts').all()).toHaveLength(0)
  })

  it('a supervisory write refuses when its decider owns a party, even with lenses', async () => {
    seedLenses()
    harness.sqlite.prepare(`UPDATE agents SET owner_member_id = 'GADMIN' WHERE id = 'A'`).run()
    const task = harness.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(TASK) as unknown as Task
    await expect(writeVerdict(env, { task, verdict: 'approved', note: null, decidedBy: 'GADMIN', independenceWaiver: 'admin_supervisory' }))
      .rejects.toBeInstanceOf(VerdictIndependenceError)
    expect(harness.sqlite.prepare('SELECT * FROM task_verdicts').all()).toHaveLength(0)
    expect(harness.sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get(TASK)).toMatchObject({ status: 'review' })
  })

  it('a SQUAD-scope admin grant does not make an org admin: still self_verdict', async () => {
    harness.sqlite.prepare(`UPDATE agents SET owner_member_id = 'SQADMIN' WHERE id = 'A'`).run()
    const res = await decide(memberAuth('SQADMIN', [{ member_id: 'SQADMIN', scope_type: 'squad', scope_id: SQUAD, capability: 'admin' }]))
    expect(res).toMatchObject({ ok: false, error: 'self_verdict' })
  })

  it('an AGENT-bound token carrying an admin member envelope never gets the human waiver', async () => {
    // AG is owned by GADMIN; the task is a human task assigned to GADMIN, so AG (acting for its owner) is affiliated.
    const s = harness.sqlite
    s.prepare(`INSERT INTO agents (id, squad_id, slug, name, role, model, status, owner_member_id) VALUES ('AG', ?, 'ag', 'AG', 'member', 'test', 'active', 'GADMIN')`).run(SQUAD)
    s.prepare(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('g-ag', ?, 'agent', 'AG', 'g', datetime('now'))`).run(GATE)
    s.prepare(`UPDATE tasks SET assignee_agent_id = NULL, assignee_member_id = 'GADMIN' WHERE id = ?`).run(TASK)
    const envelope = (role: 'member' | 'admin'): AuthContext => ({
      userId: 'agent:AG', email: null, role, tenant: TENANT, memberId: 'token-minter', boundAgentId: 'AG',
      capabilities: caps('token-minter', [{ member_id: 'token-minter', scope_type: 'org', scope_id: null, capability: 'admin' }]),
    } as AuthContext)
    for (const role of ['member', 'admin'] as const) {
      expect(await decide(envelope(role)), role).toMatchObject({ ok: false, error: 'self_verdict' })
    }
    expect((s.prepare('SELECT COUNT(*) AS n FROM task_verdicts').get() as { n: number }).n).toBe(0)
  })
})
