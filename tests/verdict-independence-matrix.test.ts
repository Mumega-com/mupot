// tests/verdict-independence-matrix.test.ts — policy rule 3: nobody gives a verdict on their own task.
//
// WHOLE MATRIX, real SQLite + the full migration chain, entered through invokeTool (task_verdict)
// and, for the write chokepoint, through writeVerdict / buildVerdictStatements directly.
//
// Parties to the task's work (all different identities):
//   A  the current assignee agent        S  an agent that SUBMITTED a result and was then reassigned off
//   R  an agent recorded as RUNNING it   (A is owned by MA, bound to MB, keyed to MK)
//   MR the member whose credential ran it
// A decider conflicts when it IS a party (direct) or ACTS FOR one (affiliated). Anyone else may decide.
//
// The write-time guard lives inside buildVerdictStatements' UPDATE ... WHERE, so a party change between
// a caller's pre-check and the write cannot land a self-verdict; those tests drive that seam without
// the pre-check.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp/index'
import { buildVerdictStatements, persistTaskUpdate, TaskUpdateConflictError, VerdictIndependenceError, VerdictRaceError, writeVerdict } from '../src/tasks/service'
import { evaluateVerdictGates } from '../src/tasks'
import type { AuthContext, CapabilityGrant, Env, Task } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'independence-matrix'
const ORIGIN = 'https://pot.test'
const SQUAD = 'squad-1'
const GATE = 'gate:review'
const TASK = 'task-1'

const FLOOR: CapabilityGrant[] = [{ member_id: 'floor', scope_type: 'squad', scope_id: SQUAD, capability: 'member' }]

const agentAuth = (agentId: string): AuthContext => ({
  userId: `agent:${agentId}`, email: null, role: 'member', tenant: TENANT,
  memberId: 'token-minter', capabilities: FLOOR, boundAgentId: agentId,
} as AuthContext)

const memberAuth = (memberId: string, role: AuthContext['role'] = 'member'): AuthContext => ({
  userId: memberId, email: `${memberId}@test.com`, role, tenant: TENANT,
  memberId, capabilities: FLOOR, boundAgentId: null,
} as AuthContext)

function seedWorld(sqlite: SqliteD1Harness['sqlite'], opts: { gateOwner?: string; humanAssignee?: string } = {}): void {
  const gate = opts.gateOwner ?? GATE
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept-1', 'Dept');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD}', 'dept-1', 'sq1', 'Squad');
  `)
  for (const a of ['A', 'S', 'R', 'G', 'SIB', 'OWNED_BY_H', 'AGENT_INDEP']) {
    sqlite.prepare(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES (?, ?, ?, ?, 'member', 'test', 'active')`)
      .run(a, SQUAD, a.toLowerCase(), a)
  }
  for (const m of ['MA', 'MB', 'MK', 'MR', 'M_INDEP', 'ADMIN', 'ADMIN_OWNS_A', 'OWNER', 'H']) {
    sqlite.prepare(`INSERT INTO members (id, email, display_name, status, tenant) VALUES (?, ?, ?, 'active', ?)`)
      .run(m, `${m}@test.com`, m, TENANT)
  }
  sqlite.prepare(`UPDATE agents SET owner_member_id = 'MA' WHERE id = 'A'`).run()
  sqlite.prepare(`UPDATE agents SET owner_member_id = 'MA' WHERE id = 'SIB'`).run() // sibling: SAME owner as A
  sqlite.prepare(`UPDATE agents SET owner_member_id = 'H' WHERE id = 'OWNED_BY_H'`).run()
  sqlite.prepare(`INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES (?, 'A', 'MB', datetime('now'))`).run(TENANT)
  sqlite.prepare(`INSERT INTO agent_keys (tenant, agent_id, pubkey, member_id, created_at) VALUES (?, 'A', 'pk', 'MK', unixepoch())`).run(TENANT)
  // Everybody who may decide holds the gate lane.
  const holders: Array<['agent' | 'member', string]> = [
    ['agent', 'A'], ['agent', 'S'], ['agent', 'R'], ['agent', 'G'], ['agent', 'SIB'], ['agent', 'OWNED_BY_H'], ['agent', 'AGENT_INDEP'],
    ['member', 'MA'], ['member', 'MB'], ['member', 'MK'], ['member', 'MR'], ['member', 'M_INDEP'], ['member', 'H'],
  ]
  for (const [t, id] of holders) {
    sqlite.prepare(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES (?, ?, ?, ?, 'granter', datetime('now'))`)
      .run(`g-${t}-${id}`, gate, t, id)
  }
  const assigneeAgent = opts.humanAssignee ? null : 'A'
  sqlite.prepare(
    `INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, assignee_agent_id, assignee_member_id, result, created_at, updated_at)
     VALUES (?, ?, 'T', 'b', 'done', 'review', ?, ?, ?, NULL, datetime('now'), datetime('now'))`,
  ).run(TASK, SQUAD, gate, assigneeAgent, opts.humanAssignee ?? null)
  if (!opts.humanAssignee) {
    // S submitted a result, then the task was reassigned to A.
    sqlite.prepare(
      `INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest)
       VALUES ('sub-1', ?, ?, ?, 'S', '/tmp/x', ?, ?)`,
    ).run(TENANT, TASK, SQUAD, 'ab'.repeat(32).replace(/ab/g, '9f'), 'cd'.repeat(32).replace(/cd/g, '1e'))
    // R ran it with MR's credential.
    sqlite.exec('PRAGMA foreign_keys = OFF')
    sqlite.prepare(
      `INSERT INTO task_dispatch_runtime_receipts (id, tenant, dispatch_receipt_id, task_id, agent_id, message_id, member_id, credential_id, stage, attempt,
         runtime_address, runtime_receipt_hash, request_digest, result, reason, audit_entry_id, created_at)
       VALUES ('rr-1', ?, 'dr-1', ?, 'R', 'm', 'MR', 'c', 'runtime_consumed', 1, 'rt', ?, ?, NULL, NULL, 'audit-1', datetime('now'))`,
    ).run(TENANT, TASK, '3a'.repeat(32).replace(/3a/g, '7c'), '5d'.repeat(32).replace(/5d/g, '2b'))
    sqlite.exec('PRAGMA foreign_keys = ON')
  }
}

/** The agent `producer` produced the task's CURRENT result: a ledger row newer than every other, and a result on the row. */
function producedCurrentResult(sqlite: SqliteD1Harness['sqlite'], producer: string, id = `sub-lane-${producer}`): void {
  sqlite.prepare(
    `INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest)
     VALUES (?, ?, ?, ?, ?, '/tmp/lane', ?, ?)`,
  ).run(id, TENANT, TASK, SQUAD, producer, '9f'.repeat(32), '1e'.repeat(32))
  sqlite.prepare(`UPDATE tasks SET result = ? WHERE id = ?`).run(`Artifact: /tmp/lane\nSHA256: ${'9f'.repeat(32)}`, TASK)
}

interface Outcome { ok: boolean; status?: number; error?: string }

async function decide(
  env: Env, auth: AuthContext, extra: Record<string, unknown> = {},
): Promise<Outcome> {
  const res = (await invokeTool(auth, env, 'task_verdict', { task_id: TASK, verdict: 'approved', ...extra }, ORIGIN)) as unknown as Outcome
  return res
}

function verdictRows(sqlite: SqliteD1Harness['sqlite']): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM task_verdicts WHERE task_id = ?`).get(TASK) as { n: number }).n
}
function taskStatus(sqlite: SqliteD1Harness['sqlite']): string {
  return (sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(TASK) as { status: string }).status
}

describe('policy rule 3 — verdict independence, whole matrix through task_verdict', () => {
  let harness: SqliteD1Harness
  let env: Env
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
  })
  afterEach(() => harness.close())

  const REFUSED: Array<[string, () => AuthContext]> = [
    ['the assignee agent (A)', () => agentAuth('A')],
    ['an agent that SUBMITTED a result and was reassigned off (S)', () => agentAuth('S')],
    ['an agent recorded as RUNNING the task (R)', () => agentAuth('R')],
    ['the member who OWNS the assignee agent (MA)', () => memberAuth('MA')],
    ['the member BOUND to the assignee agent (MB)', () => memberAuth('MB')],
    ['the member whose KEY the assignee agent authenticates as (MK)', () => memberAuth('MK')],
    ['the member whose credential RAN the task (MR)', () => memberAuth('MR')],
  ]
  for (const [label, auth] of REFUSED) {
    it(`REFUSES ${label}: 409 self_verdict, no verdict row, task stays in review`, async () => {
      seedWorld(harness.sqlite)
      const res = await decide(env, auth())
      expect(res).toMatchObject({ ok: false, status: 409, error: 'self_verdict' })
      expect(verdictRows(harness.sqlite)).toBe(0)
      expect(taskStatus(harness.sqlite)).toBe('review')
    })
  }

  const ALLOWED: Array<[string, () => AuthContext]> = [
    ['an independent agent holding the gate (G)', () => agentAuth('G')],
    ['an independent member holding the gate (M_INDEP)', () => memberAuth('M_INDEP')],
    // Pinned live behaviour (tests/task-verdict-human-origin.test.ts): two agents that share an owner
    // may review each other's work on their own authority. Changing it is a policy decision, not a
    // side effect of this rule; this test makes any such change loud.
    ['a SIBLING agent that shares the assignee agent\'s owner (SIB), on its own authority', () => agentAuth('SIB')],
  ]
  for (const [label, auth] of ALLOWED) {
    it(`ALLOWS ${label}: verdict lands, task approved`, async () => {
      seedWorld(harness.sqlite)
      const res = await decide(env, auth())
      expect(res.ok, JSON.stringify(res)).toBe(true)
      expect(verdictRows(harness.sqlite)).toBe(1)
      expect(taskStatus(harness.sqlite)).toBe('approved')
    })
  }

  it('an org ADMIN who is merely affiliated (owns A) passes the supervisory path, and the write carries the waiver', async () => {
    seedWorld(harness.sqlite)
    harness.sqlite.prepare(`UPDATE agents SET owner_member_id = 'ADMIN_OWNS_A' WHERE id = 'A'`).run()
    const res = await decide(env, memberAuth('ADMIN_OWNS_A', 'admin'))
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(verdictRows(harness.sqlite)).toBe(1)
  })

  it('an org ADMIN who is a DIRECT party (MR ran it) is refused: admin never waives a direct party', async () => {
    seedWorld(harness.sqlite)
    const res = await decide(env, memberAuth('MR', 'admin'))
    expect(res).toMatchObject({ ok: false, status: 409, error: 'self_verdict' })
    expect(verdictRows(harness.sqlite)).toBe(0)
  })

  it('only the org OWNER with explicit override_self_verdict:true may self-verdict a direct party, audited in the note', async () => {
    seedWorld(harness.sqlite)
    const adminTry = await decide(env, memberAuth('MR', 'admin'), { override_self_verdict: true })
    expect(adminTry).toMatchObject({ ok: false, status: 409, error: 'self_verdict' })
    const ownerNoFlag = await decide(env, memberAuth('MR', 'owner'))
    expect(ownerNoFlag).toMatchObject({ ok: false, status: 409, error: 'self_verdict' })
    const ownerFlag = await decide(env, memberAuth('MR', 'owner'), { override_self_verdict: true })
    expect(ownerFlag.ok, JSON.stringify(ownerFlag)).toBe(true)
    const note = (harness.sqlite.prepare(`SELECT note FROM task_verdicts WHERE task_id = ?`).get(TASK) as { note: string }).note
    expect(note).toContain('self_verdict_override')
  })

  it('an operator who RESET the dispatch lease (reset_terminated records their member id) can still decide; a real runner still cannot', async () => {
    seedWorld(harness.sqlite)
    harness.sqlite.prepare(`INSERT INTO members (id, email, display_name, status, tenant) VALUES ('OPS', 'ops@test.com', 'OPS', 'active', ?)`).run(TENANT)
    harness.sqlite.exec('PRAGMA foreign_keys = OFF')
    harness.sqlite.prepare(
      `INSERT INTO task_dispatch_runtime_receipts (id, tenant, dispatch_receipt_id, task_id, agent_id, message_id, member_id, credential_id, stage, attempt,
         runtime_address, runtime_receipt_hash, request_digest, result, reason, audit_entry_id, created_at)
       VALUES ('rr-reset', ?, 'dr-1', ?, 'A', 'm', 'OPS', 'c', 'reset_terminated', 1, 'operator', ?, ?, NULL, 'operator reset', 'audit-reset', datetime('now'))`,
    ).run(TENANT, TASK, '4e'.repeat(32), '6f'.repeat(32))
    harness.sqlite.exec('PRAGMA foreign_keys = ON')
    const ops = await decide(env, memberAuth('OPS', 'admin'))
    expect(ops.ok, JSON.stringify(ops)).toBe(true)
  })

  it('a non-admin holder who only appears on a reset_terminated receipt is not a runner either', async () => {
    seedWorld(harness.sqlite)
    harness.sqlite.prepare(`INSERT INTO members (id, email, display_name, status, tenant) VALUES ('OPS2', 'o2@test.com', 'OPS2', 'active', ?)`).run(TENANT)
    harness.sqlite.prepare(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('g-ops2', ?, 'member', 'OPS2', 'granter', datetime('now'))`).run(GATE)
    harness.sqlite.exec('PRAGMA foreign_keys = OFF')
    harness.sqlite.prepare(
      `INSERT INTO task_dispatch_runtime_receipts (id, tenant, dispatch_receipt_id, task_id, agent_id, message_id, member_id, credential_id, stage, attempt,
         runtime_address, runtime_receipt_hash, request_digest, result, reason, audit_entry_id, created_at)
       VALUES ('rr-reset2', ?, 'dr-1', ?, 'A', 'm', 'OPS2', 'c', 'reset_terminated', 1, 'operator', ?, ?, NULL, 'operator reset', 'audit-reset2', datetime('now'))`,
    ).run(TENANT, TASK, '4e'.repeat(32), '6f'.repeat(32))
    harness.sqlite.exec('PRAGMA foreign_keys = ON')
    expect((await decide(env, memberAuth('OPS2'))).ok).toBe(true)
    // (the genuine runner MR stays refused: see the REFUSED cases above, same fixture)
  })

  describe('the gate:agent-self-completion lane exempts ONLY the producer of the current result, who is also the current assignee', () => {
    const LANE = 'gate:agent-self-completion'

    it('the current assignee that produced the result closes its own task', async () => {
      seedWorld(harness.sqlite, { gateOwner: LANE })
      producedCurrentResult(harness.sqlite, 'A')
      const res = await decide(env, agentAuth('A'))
      expect(res.ok, JSON.stringify(res)).toBe(true)
      expect(verdictRows(harness.sqlite)).toBe(1)
    })

    it('an org admin who is a direct party (ran it) but is NOT the current assignee is refused self_verdict', async () => {
      seedWorld(harness.sqlite, { gateOwner: LANE })
      const res = await decide(env, memberAuth('MR', 'admin'))
      expect(res).toMatchObject({ ok: false, status: 409, error: 'self_verdict' })
      expect(verdictRows(harness.sqlite)).toBe(0)
      expect(taskStatus(harness.sqlite)).toBe('review')
    })

    it('the pre-check predicate refuses the direct-party admin on the lane and allows the producer-assignee', async () => {
      seedWorld(harness.sqlite, { gateOwner: LANE })
      producedCurrentResult(harness.sqlite, 'A')
      const gateTask = { id: TASK, squad_id: SQUAD, gate_owner: LANE, assignee_agent_id: 'A' }
      expect(await evaluateVerdictGates(env, memberAuth('MR', 'admin'), gateTask, 'approved')).toMatchObject({ allowed: false, code: 'self_verdict' })
      expect((await evaluateVerdictGates(env, agentAuth('A'), gateTask, 'approved')).allowed).toBe(true)
    })

    it('the same admin with the org owner explicit override is allowed', async () => {
      seedWorld(harness.sqlite, { gateOwner: LANE })
      const res = await decide(env, memberAuth('MR', 'owner'), { override_self_verdict: true })
      expect(res.ok, JSON.stringify(res)).toBe(true)
      expect(verdictRows(harness.sqlite)).toBe(1)
    })

    it('a former assignee that submitted a result (S) is refused on the lane too, at the write', async () => {
      seedWorld(harness.sqlite, { gateOwner: LANE })
      const t = harness.sqlite.prepare(`SELECT * FROM tasks WHERE id = ?`).get(TASK) as unknown as Task
      await expect(writeVerdict(env, { task: t, verdict: 'approved', note: null, decidedBy: 'S' }))
        .rejects.toBeInstanceOf(VerdictIndependenceError)
      expect(verdictRows(harness.sqlite)).toBe(0)
    })

    it('reassignment race: pre-check sees the decider as assignee, the task is reassigned before the write; the write refuses', async () => {
      seedWorld(harness.sqlite, { gateOwner: LANE })
      producedCurrentResult(harness.sqlite, 'A')
      const t = harness.sqlite.prepare(`SELECT * FROM tasks WHERE id = ?`).get(TASK) as unknown as Task
      const gate = await evaluateVerdictGates(env, agentAuth('A'), { id: t.id, squad_id: t.squad_id, gate_owner: LANE, assignee_agent_id: t.assignee_agent_id }, 'approved')
      expect(gate.allowed).toBe(true)
      harness.sqlite.prepare(`UPDATE tasks SET assignee_agent_id = 'G' WHERE id = ?`).run(TASK)
      // A is still a party (it was the assignee the stale row says), but no longer the CURRENT assignee.
      harness.sqlite.prepare(
        `INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest)
         VALUES ('sub-a', ?, ?, ?, 'A', '/tmp/z', ?, ?)`,
      ).run(TENANT, TASK, SQUAD, '9f'.repeat(32), '1e'.repeat(32))
      await expect(writeVerdict(env, { task: t, verdict: 'approved', note: null, decidedBy: 'A' }))
        .rejects.toBeInstanceOf(VerdictIndependenceError)
      expect(verdictRows(harness.sqlite)).toBe(0)
      expect(taskStatus(harness.sqlite)).toBe('review')
    })
  })

  describe('review FREEZES the assignee: no caller can appoint itself "the current assignee"', () => {
    const LANE = 'gate:agent-self-completion'
    const assigneeOf = (): string | null =>
      (harness.sqlite.prepare(`SELECT assignee_agent_id AS a FROM tasks WHERE id = ?`).get(TASK) as { a: string | null }).a
    const update = (auth: AuthContext, args: Record<string, unknown>): Promise<Outcome> =>
      invokeTool(auth, env, 'task_update', { task_id: TASK, ...args }, ORIGIN) as unknown as Promise<Outcome>

    for (const who of ['S', 'R', 'G']) {
      it(`${who} cannot self-assign on a review lane task, the assignee is unchanged, and its verdict is then refused`, async () => {
        seedWorld(harness.sqlite, { gateOwner: LANE })
        const res = await update(agentAuth(who), { assignee_agent_id: who })
        expect(res).toMatchObject({ ok: false, status: 409, error: 'assignee_frozen_in_review' })
        expect(assigneeOf()).toBe('A')
        const verdict = await decide(env, agentAuth(who))
        expect(verdict.ok).toBe(false)
        expect(verdictRows(harness.sqlite)).toBe(0)
        expect(taskStatus(harness.sqlite)).toBe('review')
      })
    }

    it('a human owner cannot be installed either, and an org ADMIN is refused too (frozen for everyone)', async () => {
      seedWorld(harness.sqlite, { gateOwner: LANE })
      const live = harness.sqlite.prepare(`SELECT * FROM tasks WHERE id = ?`).get(TASK) as unknown as Task
      await expect(persistTaskUpdate(env, live, { ...live, assignee_agent_id: null, assignee_member_id: 'MR', updated_at: new Date().toISOString() }))
        .rejects.toBeInstanceOf(TaskUpdateConflictError)
      expect(await update(memberAuth('ADMIN', 'admin'), { assignee_agent_id: 'G' })).toMatchObject({ ok: false, error: 'assignee_frozen_in_review' })
      expect(await update(memberAuth('ADMIN', 'admin'), { assignee_agent_id: null })).toMatchObject({ ok: false, error: 'assignee_frozen_in_review' })
      expect(assigneeOf()).toBe('A')
    })

    it('a no-op write of the SAME assignee is not a change', async () => {
      seedWorld(harness.sqlite, { gateOwner: LANE })
      const res = await update(agentAuth('G'), { assignee_agent_id: 'A', priority: 'P2' })
      expect(res.error).not.toBe('assignee_frozen_in_review')
    })

    it('the UPDATE itself refuses: a stale pre-review snapshot cannot slip an assignee change into a row that is now in review', async () => {
      seedWorld(harness.sqlite, { gateOwner: LANE })
      const live = harness.sqlite.prepare(`SELECT * FROM tasks WHERE id = ?`).get(TASK) as unknown as Task
      const stale = { ...live, status: 'in_progress' as const }   // what a racing writer read a moment earlier
      const next = { ...stale, assignee_agent_id: 'G', updated_at: new Date().toISOString() }
      await expect(persistTaskUpdate(env, stale, next)).rejects.toBeInstanceOf(TaskUpdateConflictError)
      expect(assigneeOf()).toBe('A')
    })

    it('the lane name is reserved at task_update, as at task_create', async () => {
      seedWorld(harness.sqlite)
      harness.sqlite.prepare(`INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, assignee_agent_id, created_at, updated_at)
        VALUES ('t-open', ?, 'T', 'b', 'done', 'in_progress', NULL, 'G', datetime('now'), datetime('now'))`).run(SQUAD)
      const res = (await invokeTool(agentAuth('G'), env, 'task_update', { task_id: 't-open', gate_owner: LANE }, ORIGIN)) as unknown as Outcome
      expect(res).toMatchObject({ ok: false, status: 403, error: 'gate_owner_reserved' })
      expect((harness.sqlite.prepare(`SELECT gate_owner AS g FROM tasks WHERE id = 't-open'`).get() as { g: string | null }).g).toBeNull()
    })

    it('the WRITE re-reads the lane: a stale lane snapshot after an owner re-gate is refused (assignee included)', async () => {
      seedWorld(harness.sqlite, { gateOwner: LANE })
      const stale = harness.sqlite.prepare(`SELECT * FROM tasks WHERE id = ?`).get(TASK) as unknown as Task
      harness.sqlite.prepare(`UPDATE tasks SET gate_owner = 'gate:review' WHERE id = ?`).run(TASK)
      await expect(writeVerdict(env, { task: stale, verdict: 'approved', note: null, decidedBy: 'A' })).rejects.toThrow()
      expect(verdictRows(harness.sqlite)).toBe(0)
      expect(taskStatus(harness.sqlite)).toBe('review')
    })

    it('lane authority is re-checked at the write: a former assignee who is NOT a party is refused after a reassignment', async () => {
      seedWorld(harness.sqlite, { gateOwner: LANE })
      harness.sqlite.prepare(`UPDATE tasks SET assignee_agent_id = 'AGENT_INDEP' WHERE id = ?`).run(TASK)
      producedCurrentResult(harness.sqlite, 'AGENT_INDEP')
      const t = harness.sqlite.prepare(`SELECT * FROM tasks WHERE id = ?`).get(TASK) as unknown as Task
      const gate = await evaluateVerdictGates(env, agentAuth('AGENT_INDEP'), { id: t.id, squad_id: t.squad_id, gate_owner: LANE, assignee_agent_id: 'AGENT_INDEP' }, 'approved')
      expect(gate.allowed).toBe(true)
      harness.sqlite.prepare(`UPDATE tasks SET assignee_agent_id = 'A' WHERE id = ?`).run(TASK)   // an admin repair, outside task_update
      await expect(writeVerdict(env, { task: t, verdict: 'approved', note: null, decidedBy: 'AGENT_INDEP' })).rejects.toThrow()
      expect(verdictRows(harness.sqlite)).toBe(0)
      expect(taskStatus(harness.sqlite)).toBe('review')
    })

    it('a non-party org ADMIN still closes a lane task', async () => {
      seedWorld(harness.sqlite, { gateOwner: LANE })
      expect((await decide(env, memberAuth('ADMIN', 'admin'))).ok).toBe(true)
    })

    it('an admin who merely OWNS the assignee (admin_supervisory) closes a lane task', async () => {
      seedWorld(harness.sqlite, { gateOwner: LANE })
      harness.sqlite.prepare(`UPDATE agents SET owner_member_id = 'ADMIN_OWNS_A' WHERE id = 'A'`).run()
      const res = await decide(env, memberAuth('ADMIN_OWNS_A', 'admin'))
      expect(res.ok, JSON.stringify(res)).toBe(true)
    })
  })

  describe('a task owned by a HUMAN (assignee_member_id), no assignee agent', () => {
    it('refuses the human owner H, and an agent acting for H (owner of OWNED_BY_H), allows an unrelated member and agent', async () => {
      for (const [who, auth, ok] of [
        ['H', memberAuth('H'), false],
        ['OWNED_BY_H', agentAuth('OWNED_BY_H'), false],
        ['M_INDEP', memberAuth('M_INDEP'), true],
        ['G', agentAuth('G'), true],
      ] as Array<[string, AuthContext, boolean]>) {
        const h = createSqliteD1()
        applyAllMigrations(h.sqlite)
        const e = { TENANT_SLUG: TENANT, DB: h.db } as unknown as Env
        seedWorld(h.sqlite, { humanAssignee: 'H' })
        const res = await decide(e, auth)
        expect(res.ok, `${who}: ${JSON.stringify(res)}`).toBe(ok)
        if (!ok) expect(res).toMatchObject({ status: 409, error: 'self_verdict' })
        h.close()
      }
    })
  })

  describe('the PRE-CHECK predicate (evaluateVerdictGates) refuses on its own, before any write', () => {
    it('says self_verdict for every party and allows the independent deciders', async () => {
      seedWorld(harness.sqlite)
      const t = harness.sqlite.prepare(`SELECT * FROM tasks WHERE id = ?`).get(TASK) as unknown as Task
      const gateTask = { id: t.id, squad_id: t.squad_id, gate_owner: GATE, assignee_agent_id: t.assignee_agent_id }
      for (const [label, auth] of REFUSED) {
        const r = await evaluateVerdictGates(env, auth(), gateTask, 'approved')
        expect(r, label).toMatchObject({ allowed: false, code: 'self_verdict' })
      }
      for (const [label, auth] of ALLOWED) {
        const r = await evaluateVerdictGates(env, auth(), gateTask, 'approved')
        expect(r.allowed, label).toBe(true)
      }
    })
  })

  describe('the WRITE chokepoint refuses even when the caller skipped its pre-check', () => {
    const task = (): Task => harness.sqlite.prepare(`SELECT * FROM tasks WHERE id = ?`).get(TASK) as unknown as Task

    it('writeVerdict throws VerdictIndependenceError for each party, with no waiver', async () => {
      seedWorld(harness.sqlite)
      for (const decidedBy of ['A', 'S', 'R', 'MA', 'MB', 'MK', 'MR']) {
        await expect(writeVerdict(env, { task: task(), verdict: 'approved', note: null, decidedBy }), decidedBy)
          .rejects.toBeInstanceOf(VerdictIndependenceError)
      }
      expect(verdictRows(harness.sqlite)).toBe(0)
      expect(taskStatus(harness.sqlite)).toBe('review')
    })

    it('writeVerdict lands for an independent decider', async () => {
      seedWorld(harness.sqlite)
      const out = await writeVerdict(env, { task: task(), verdict: 'approved', note: null, decidedBy: 'M_INDEP' })
      expect(out.verdict.decided_by).toBe('M_INDEP')
    })

    it('TOCTOU: an independent decider becomes a party AFTER the gate check; the write refuses it', async () => {
      seedWorld(harness.sqlite)
      const t = task()
      const gate = await evaluateVerdictGates(env, agentAuth('G'), { id: t.id, squad_id: t.squad_id, gate_owner: GATE, assignee_agent_id: t.assignee_agent_id }, 'approved')
      expect(gate.allowed).toBe(true)
      // G now submits a result for the task (a party), between the check and the write.
      harness.sqlite.prepare(
        `INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest)
         VALUES ('sub-2', ?, ?, ?, 'G', '/tmp/y', ?, ?)`,
      ).run(TENANT, TASK, SQUAD, '9f'.repeat(32), '1e'.repeat(32))
      await expect(writeVerdict(env, { task: t, verdict: 'approved', note: null, decidedBy: 'G' })).rejects.toBeInstanceOf(VerdictIndependenceError)
      expect(verdictRows(harness.sqlite)).toBe(0)
    })

    it('waivers are exact: admin_supervisory waives AFFILIATED only; owner_override waives both', async () => {
      seedWorld(harness.sqlite)
      await expect(writeVerdict(env, { task: task(), verdict: 'approved', note: null, decidedBy: 'MR', independenceWaiver: 'admin_supervisory' }))
        .rejects.toBeInstanceOf(VerdictIndependenceError) // MR is direct
      const ok = await writeVerdict(env, { task: task(), verdict: 'approved', note: null, decidedBy: 'MA', independenceWaiver: 'admin_supervisory' })
      expect(ok.verdict.decided_by).toBe('MA') // MA is affiliated only
    })

    it('owner_override lets a direct party through', async () => {
      seedWorld(harness.sqlite)
      const ok = await writeVerdict(env, { task: task(), verdict: 'approved', note: null, decidedBy: 'MR', independenceWaiver: 'owner_override' })
      expect(ok.verdict.decided_by).toBe('MR')
    })

    it('a builder-level batch (the origin/office seam) changes 0 rows for a party and lands nothing', async () => {
      seedWorld(harness.sqlite)
      const { statements } = buildVerdictStatements(env, { task: task(), verdict: 'approved', note: null, decidedBy: 'MB' })
      const results = await env.DB.batch(statements)
      expect(results[0]?.meta?.changes ?? 0).toBe(0)
      expect(verdictRows(harness.sqlite)).toBe(0)
      expect(taskStatus(harness.sqlite)).toBe('review')
    })

    it('the lost-race path still reports a race, not a self-verdict, for an independent decider', async () => {
      seedWorld(harness.sqlite)
      harness.sqlite.prepare(`UPDATE tasks SET status = 'done' WHERE id = ?`).run(TASK)
      await expect(writeVerdict(env, { task: task(), verdict: 'approved', note: null, decidedBy: 'M_INDEP' })).rejects.toBeInstanceOf(VerdictRaceError)
    })
  })
})
