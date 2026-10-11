// tests/self-completion-producer-authority.test.ts — policy rule 3 on the gate:agent-self-completion lane.
//
// DEFECT CLASS: an exemption keyed on a mutable column is only as narrow as whoever can write that
// column. The lane exempted the CURRENT ASSIGNEE; the assignee is writable by any squad member+ at
// every status except review, so after a human rejection a peer could reassign the task to itself,
// walk it back to review on the old result, and approve someone else's unchanged work.
//
// The lane now exempts exactly one agent: the one that PRODUCED THE CURRENT RESULT (the submitter of
// the latest task_result_submissions row, written in the same batch as the review landing) while it
// is also the current assignee, both re-read inside the verdict UPDATE's WHERE. Rework out of
// `rejected` clears the rejected result, so re-entering review needs a fresh submission.
//
// Real SQLite + the full migration chain; every probe enters through invokeTool (MCP) and through the
// real REST app, and the producing step is the real runTaskExecution (not a fixture row).

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

import { invokeTool } from '../src/mcp/index'
import { tasksApp, evaluateVerdictGates } from '../src/tasks'
import { runTaskExecution, type ExecuteDeps } from '../src/agents/execute'
import { buildVerdictStatements, syncCiResultToTask, writeVerdict, VerdictRaceError, VerdictIndependenceError } from '../src/tasks/service'
import type { Agent, AuthContext, CapabilityGrant, Env, Task } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'lane-producer'
const ORIGIN = 'https://pot.test'
const SQUAD = 'squad-1'
const LANE = 'gate:agent-self-completion'
const TASK = 'task-1'
const SHA = '46409ea69826a6733ced5dd67fc0a9080601cbaaacd7a02192732356d25c0c88'
const FLOOR: CapabilityGrant[] = [{ member_id: 'floor', scope_type: 'squad', scope_id: SQUAD, capability: 'member' }]

const agentAuth = (agentId: string): AuthContext => ({
  userId: `agent:${agentId}`, email: null, role: 'member', tenant: TENANT,
  memberId: 'token-minter', capabilities: FLOOR, boundAgentId: agentId,
} as AuthContext)
const adminAuth = (): AuthContext => ({
  userId: 'ADMIN', email: 'admin@test.com', role: 'admin', tenant: TENANT,
  memberId: 'ADMIN', capabilities: FLOOR, boundAgentId: null,
} as AuthContext)

const agentRow = (id: string): Agent => ({
  id, squad_id: SQUAD, slug: id.toLowerCase(), name: id, role: 'member', model: 'test', status: 'active', created_at: '2026-01-01T00:00:00.000Z',
})

interface Outcome { ok: boolean; status?: number; error?: string; task?: { status: string; result: string | null; assignee_agent_id: string | null } }

describe('gate:agent-self-completion lane: verdict authority is the PRODUCER of the current result', () => {
  let harness: SqliteD1Harness
  let env: Env
  const sql = () => harness.sqlite

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db, BRAND: 'Mupot', BUS: { send: async () => undefined } } as unknown as Env
    sql().exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept-1', 'Dept');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD}', 'dept-1', 'sq1', 'Squad');
    `)
    for (const a of ['A', 'G']) {
      sql().prepare(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES (?, ?, ?, ?, 'member', 'test', 'active')`).run(a, SQUAD, a.toLowerCase(), a)
    }
    sql().prepare(`INSERT INTO members (id, email, display_name, status, tenant) VALUES ('ADMIN', 'admin@test.com', 'ADMIN', 'active', ?)`).run(TENANT)
    sql().prepare(
      `INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, assignee_agent_id, created_at, updated_at)
       VALUES (?, ?, 'T', 'b', 'reviewer accepts the artifact', 'open', ?, 'A', datetime('now'), datetime('now'))`,
    ).run(TASK, SQUAD, LANE)
  })
  afterEach(() => harness.close())

  // ── helpers ──────────────────────────────────────────────────────────────────
  // The real producing step: execute.ts claims the task, runs the (stub) model, and lands review with the
  // ledger receipt in one batch.
  async function produce(agent: string, label = 'work'): Promise<void> {
    const deps: ExecuteDeps = {
      model: { chat: async () => `${label}\nArtifact: /tmp/${label}.txt\nSHA256: ${SHA}` },
      emit: async () => undefined,
      remember: async () => undefined,
      // Meter seam stubbed: this suite is about verdict authority, not budgets.
      meter: { checkAndReserve: async () => ({ ok: true }), recordTokens: async () => undefined } as unknown as ExecuteDeps['meter'],
    }
    const r = await runTaskExecution(env, agentRow(agent), TASK, deps)
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, task_status: 'review' })
  }
  const verdict = (auth: AuthContext, v: 'approved' | 'rejected' = 'approved', extra: Record<string, unknown> = {}): Promise<Outcome> =>
    invokeTool(auth, env, 'task_verdict', { task_id: TASK, verdict: v, ...extra }, ORIGIN) as unknown as Promise<Outcome>
  const update = (auth: AuthContext, args: Record<string, unknown>): Promise<Outcome> =>
    invokeTool(auth, env, 'task_update', { task_id: TASK, ...args }, ORIGIN) as unknown as Promise<Outcome>
  const row = () => sql().prepare(`SELECT status, result, assignee_agent_id AS assignee, gate_owner FROM tasks WHERE id = ?`).get(TASK) as
    { status: string; result: string | null; assignee: string | null; gate_owner: string | null }
  const verdictRows = () => (sql().prepare(`SELECT COUNT(*) AS n FROM task_verdicts WHERE task_id = ?`).get(TASK) as { n: number }).n
  const submitters = () => (sql().prepare(`SELECT submitted_by_agent_id AS s FROM task_result_submissions WHERE task_id = ? ORDER BY seq`).all(TASK) as Array<{ s: string }>).map((r) => r.s)

  async function rest(auth: AuthContext, method: 'PATCH' | 'POST', path: string, body: unknown): Promise<Response> {
    return tasksApp.fetch(new Request(`https://pot.test/${TASK}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-auth': JSON.stringify(auth), Origin: ORIGIN },
      body: JSON.stringify(body),
    }), env)
  }

  // Producer A lands review; an org admin REJECTS; the task is now `rejected` with A's result still on it.
  async function rejectedAfterProducedByA(): Promise<void> {
    await produce('A')
    const r = await verdict(adminAuth(), 'rejected')
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(row().status).toBe('rejected')
  }

  // ── the producer record ──────────────────────────────────────────────────────
  it('the real execute landing writes the producer receipt in the same batch as review', async () => {
    await produce('A')
    expect(row().status).toBe('review')
    expect(submitters()).toEqual(['A'])
  })

  it('the producer-assignee (A) closes its own lane task', async () => {
    await produce('A')
    const res = await verdict(agentAuth('A'))
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(verdictRows()).toBe(1)
  })

  it('a non-producer peer (G, not the assignee) is refused (lane authority needs the assignee)', async () => {
    await produce('A')
    const res = await verdict(agentAuth('G'))
    expect(res.ok).toBe(false)
    expect(verdictRows()).toBe(0)
  })

  it('NO producer record: the exemption does not apply, the assignee is judged like any party (self_verdict)', async () => {
    sql().prepare(`UPDATE tasks SET status = 'review', result = ? WHERE id = ?`).run(`legacy\nArtifact: /tmp/l\nSHA256: ${SHA}`, TASK)
    expect(submitters()).toEqual([])
    const res = await verdict(agentAuth('A'))
    expect(res).toMatchObject({ ok: false, status: 409, error: 'self_verdict' })
    expect(verdictRows()).toBe(0)
    // an org admin who is not a party still closes it
    expect((await verdict(adminAuth())).ok).toBe(true)
  })

  it('only the LATEST ledger row is the producer: an earlier submitter who is the assignee again is refused', async () => {
    sql().prepare(`UPDATE tasks SET assignee_agent_id = 'G' WHERE id = ?`).run(TASK)
    await produce('G') // G's row is first
    sql().prepare(`UPDATE tasks SET status = 'rejected', assignee_agent_id = 'A', execution_receipt_id = NULL WHERE id = ?`).run(TASK)
    await produce('A')
    expect(submitters()).toEqual(['G', 'A'])
    sql().prepare(`UPDATE tasks SET assignee_agent_id = 'G' WHERE id = ?`).run(TASK) // outside task_update
    const res = await verdict(agentAuth('G'))
    expect(res).toMatchObject({ ok: false, status: 409, error: 'self_verdict' })
    expect(verdictRows()).toBe(0)
  })

  it('a result cleared by rework ends the exemption even for the latest producer (no result, no authority at the write)', async () => {
    await produce('A')
    const t = sql().prepare(`SELECT * FROM tasks WHERE id = ?`).get(TASK) as unknown as Task
    sql().prepare(`UPDATE tasks SET result = NULL WHERE id = ?`).run(TASK)
    // the pre-check snapshot said producer; the write re-reads and refuses
    await expect(writeVerdict(env, { task: t, verdict: 'approved', note: null, decidedBy: 'A' })).rejects.toBeInstanceOf(VerdictIndependenceError)
    expect(verdictRows()).toBe(0)
  })

  it('a MEMBER whose id equals the producer-assignee agent id is not the agent (type is checked at the pre-check)', async () => {
    await produce('A')
    const res = await verdict({
      userId: 'A', email: 'a@test.com', role: 'member', tenant: TENANT, memberId: 'A', capabilities: FLOOR, boundAgentId: null,
    } as AuthContext)
    expect(res).toMatchObject({ ok: false, error: 'self_verdict' })
    expect(verdictRows()).toBe(0)
  })

  // ── the probed bypass: reject -> G reassigns -> in_progress -> review -> verdict ─
  it('MCP: the full probed lap is stopped at -> review (no fresh submission), and nothing G does lands a verdict', async () => {
    await rejectedAfterProducedByA()
    expect((await update(agentAuth('G'), { assignee_agent_id: 'G' })).ok).toBe(true)
    expect(row().assignee).toBe('G')
    const toWork = await update(agentAuth('G'), { status: 'in_progress' })
    expect(toWork.ok, JSON.stringify(toWork)).toBe(true)
    // rework superseded the rejected result
    expect(row().result).toBeNull()
    const toReview = await update(agentAuth('G'), { status: 'review' })
    expect(toReview).toMatchObject({ ok: false, status: 409, error: 'artifact_verification_failed' })
    expect(row().status).toBe('in_progress')
    expect(verdictRows()).toBe(1) // only the admin's rejection
  })

  it('MCP: even if the old result is forced back into review, G is refused AT THE VERDICT (self_verdict, not verdict_race)', async () => {
    await rejectedAfterProducedByA()
    expect((await update(agentAuth('G'), { assignee_agent_id: 'G' })).ok).toBe(true)
    expect((await update(agentAuth('G'), { status: 'in_progress' })).ok).toBe(true)
    // simulate the stale-result gate leak: a result and a review status reach the row some other way
    sql().prepare(`UPDATE tasks SET status = 'review', result = ? WHERE id = ?`).run(`old\nArtifact: /tmp/work.txt\nSHA256: ${SHA}`, TASK)
    const res = await verdict(agentAuth('G'))
    expect(res).toMatchObject({ ok: false, status: 409, error: 'self_verdict' })
    expect(verdictRows()).toBe(1)
    expect(row().status).toBe('review')
  })

  it('REST: the full probed lap is stopped at -> review, and a forced stale review is refused at the verdict (self_verdict)', async () => {
    await rejectedAfterProducedByA()
    expect((await rest(agentAuth('G'), 'PATCH', '', { assignee_agent_id: 'G' })).status).toBe(200)
    const toWork = await rest(agentAuth('G'), 'PATCH', '', { status: 'in_progress' })
    expect(toWork.status, await toWork.clone().text()).toBe(200)
    expect(row().result).toBeNull()
    const toReview = await rest(agentAuth('G'), 'PATCH', '', { status: 'review' })
    expect(toReview.status).toBe(409)
    expect(await toReview.json()).toMatchObject({ error: 'artifact_verification_failed' })
    sql().prepare(`UPDATE tasks SET status = 'review', result = ? WHERE id = ?`).run(`old\nArtifact: /tmp/work.txt\nSHA256: ${SHA}`, TASK)
    const v = await rest(agentAuth('G'), 'POST', '/verdict', { verdict: 'approved' })
    expect(v.status).toBe(409)
    expect(await v.json()).toMatchObject({ error: 'self_verdict' })
    expect(verdictRows()).toBe(1)
  })

  it('the pre-check predicate and the write agree: a non-producer assignee gets self_verdict from both', async () => {
    await produce('A')
    sql().prepare(`UPDATE tasks SET assignee_agent_id = 'G' WHERE id = ?`).run(TASK) // outside task_update (repair/legacy)
    const t = sql().prepare(`SELECT * FROM tasks WHERE id = ?`).get(TASK) as unknown as Task
    expect(await evaluateVerdictGates(env, agentAuth('G'), { id: t.id, squad_id: t.squad_id, gate_owner: LANE, assignee_agent_id: 'G' }, 'approved'))
      .toMatchObject({ allowed: false, code: 'self_verdict' })
    await expect(writeVerdict(env, { task: t, verdict: 'approved', note: null, decidedBy: 'G' })).rejects.toBeInstanceOf(VerdictIndependenceError)
  })

  // ── legitimate rework ────────────────────────────────────────────────────────
  it('the original assignee A resubmits after a rejection and closes its own fresh result', async () => {
    await rejectedAfterProducedByA()
    await produce('A', 'rework')
    expect(submitters()).toEqual(['A', 'A'])
    expect(row().result).toContain('rework')
    const res = await verdict(agentAuth('A'))
    expect(res.ok, JSON.stringify(res)).toBe(true)
  })

  it('G, reassigned after the rejection, does FRESH work: G is then the producer and assignee, so the lane allows G (and no longer A)', async () => {
    await rejectedAfterProducedByA()
    expect((await update(agentAuth('G'), { assignee_agent_id: 'G' })).ok).toBe(true)
    await produce('G', 'fresh')
    expect(submitters()).toEqual(['A', 'G'])
    expect((await verdict(agentAuth('A'))).ok).toBe(false)
    expect(verdictRows()).toBe(1)
    const res = await verdict(agentAuth('G'))
    expect(res.ok, JSON.stringify(res)).toBe(true)
  })

  it('rework clears the rejected result on the generic writers (MCP + REST) and on the execute claim', async () => {
    await rejectedAfterProducedByA()
    expect(row().result).not.toBeNull()
    expect((await update(adminAuth(), { status: 'in_progress' })).ok).toBe(true)
    expect(row().result).toBeNull()

    sql().prepare(`UPDATE tasks SET status = 'rejected', result = 'x' WHERE id = ?`).run(TASK)
    expect((await rest(adminAuth(), 'PATCH', '', { status: 'in_progress' })).status).toBe(200)
    expect(row().result).toBeNull()

    // execute.ts claims straight out of rejected: the stale result is gone before the new attempt runs
    sql().prepare(`UPDATE tasks SET status = 'rejected', result = 'x', execution_receipt_id = NULL WHERE id = ?`).run(TASK)
    const seen: Array<string | null> = []
    const deps: ExecuteDeps = {
      model: { chat: async () => { seen.push(row().result); return `n\nArtifact: /tmp/n.txt\nSHA256: ${SHA}` } },
      emit: async () => undefined,
      remember: async () => undefined,
      meter: { checkAndReserve: async () => ({ ok: true }), recordTokens: async () => undefined } as unknown as ExecuteDeps['meter'],
    }
    await runTaskExecution(env, agentRow('A'), TASK, deps)
    expect(seen).toEqual([null])

    // and out of an UNASSIGNED rejected task (the other claim statement)
    sql().prepare(`UPDATE tasks SET status = 'rejected', result = 'y', execution_receipt_id = NULL, assignee_agent_id = NULL WHERE id = ?`).run(TASK)
    seen.length = 0
    await runTaskExecution(env, agentRow('A'), TASK, deps)
    expect(seen).toEqual([null])
  })

  it('a reversal back to review (no rework) keeps the result and the producer', async () => {
    await produce('A')
    expect((await verdict(adminAuth())).ok).toBe(true)
    const rev = await update(adminAuth(), { status: 'review', reversal_reason: 'second look' })
    expect(rev.ok, JSON.stringify(rev)).toBe(true)
    expect(row().result).not.toBeNull()
    expect((await verdict(agentAuth('A'))).ok).toBe(true)
  })

  // ── the ledger row is bound to the CURRENT result (result_text = tasks.result) ─────────────
  // DEFECT CLASS: authority derived from a record that is not bound to the thing being approved.
  it('CI-sync overwrites the result in review: the producer\'s row no longer matches, A cannot self-close; an admin still can', async () => {
    sql().prepare(`UPDATE tasks SET github_issue_url = 'https://github.com/o/r/pull/77' WHERE id = ?`).run(TASK)
    await produce('A')
    expect((await syncCiResultToTask(env, 77, 'success')).updated).toBe(true)
    expect(row().result).toBe('CI: success')
    const res = await verdict(agentAuth('A'))
    expect(res).toMatchObject({ ok: false, status: 409, error: 'self_verdict' })
    expect(verdictRows()).toBe(0)
    // the write itself (stale pre-check snapshot) refuses too
    const t = sql().prepare(`SELECT * FROM tasks WHERE id = ?`).get(TASK) as unknown as Task
    await expect(writeVerdict(env, { task: t, verdict: 'approved', note: null, decidedBy: 'A' })).rejects.toBeInstanceOf(VerdictIndependenceError)
    expect((await verdict(adminAuth())).ok).toBe(true)
  })

  it('a foreign result is written and the task reassigned to the original producer: A is refused', async () => {
    await rejectedAfterProducedByA()
    // G\'s work reaches the row by a path that appends no submission, then the task goes back to A
    sql().prepare(`UPDATE tasks SET status = 'review', result = ?, assignee_agent_id = 'A' WHERE id = ?`).run(`G's work\nArtifact: /tmp/g.txt\nSHA256: ${SHA}`, TASK)
    expect(submitters()).toEqual(['A'])
    const res = await verdict(agentAuth('A'))
    expect(res).toMatchObject({ ok: false, status: 409, error: 'self_verdict' })
    expect(verdictRows()).toBe(1) // only the admin's rejection
  })

  it('a REJECTED submission is spent: its exact text written back by another path cannot revive it for A', async () => {
    await rejectedAfterProducedByA()
    const rejectedText = (sql().prepare(`SELECT result_text FROM task_result_submissions WHERE task_id = ? ORDER BY seq DESC LIMIT 1`).get(TASK) as { result_text: string }).result_text
    // another path (a failure reason, a foreign runtime) writes A's rejected text back, no new submission
    sql().prepare(`UPDATE tasks SET status = 'review', result = ?, assignee_agent_id = 'A' WHERE id = ?`).run(rejectedText, TASK)
    expect(submitters()).toEqual(['A'])
    const res = await verdict(agentAuth('A'))
    expect(res).toMatchObject({ ok: false, status: 409, error: 'self_verdict' })
    const t = sql().prepare(`SELECT * FROM tasks WHERE id = ?`).get(TASK) as unknown as Task
    await expect(writeVerdict(env, { task: t, verdict: 'approved', note: null, decidedBy: 'A' })).rejects.toBeInstanceOf(VerdictIndependenceError)
    expect(verdictRows()).toBe(1) // only the admin's rejection
    // a reversed rejection does not spend the submission
    sql().prepare(`UPDATE task_verdicts SET reversed_at = ? WHERE task_id = ? AND verdict = 'rejected'`).run(new Date().toISOString(), TASK)
    expect((await verdict(agentAuth('A'))).ok).toBe(true)
  })

  it('a fresh own submission is bound to its result and is allowed; the ledger stores the exact text', async () => {
    await produce('A')
    const ledger = sql().prepare(`SELECT result_text AS t FROM task_result_submissions WHERE task_id = ?`).get(TASK) as { t: string | null }
    expect(ledger.t).toBe(row().result)
    expect(ledger.t).toContain('Artifact: /tmp/work.txt')
    expect((await verdict(agentAuth('A'))).ok).toBe(true)
  })

  it('LEGACY row (result_text NULL): the assignee is refused, an admin still closes', async () => {
    sql().prepare(`UPDATE tasks SET status = 'review', result = ? WHERE id = ?`).run(`legacy\nArtifact: /tmp/l\nSHA256: ${SHA}`, TASK)
    sql().prepare(
      `INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest)
       VALUES ('legacy-1', ?, ?, ?, 'A', '/tmp/l', ?, ?)`,
    ).run(TENANT, TASK, SQUAD, '9f'.repeat(32), '1e'.repeat(32))
    expect((sql().prepare(`SELECT result_text AS t FROM task_result_submissions WHERE id = 'legacy-1'`).get() as { t: string | null }).t).toBeNull()
    expect(await verdict(agentAuth('A'))).toMatchObject({ ok: false, error: 'self_verdict' })
    expect(verdictRows()).toBe(0)
    expect((await verdict(adminAuth())).ok).toBe(true)
  })

  it('a rejection in the SAME millisecond as the submission still spends it (mixed timestamp precision)', async () => {
    const text = `x\nArtifact: /tmp/x\nSHA256: ${SHA}`
    sql().prepare(`UPDATE tasks SET status = 'review', result = ? WHERE id = ?`).run(text, TASK)
    // the ledger default is '...SS.mmmZ'; a verdict's decided_at carries sub-millisecond digits '...SS.mmmNNNNNNZ'
    sql().prepare(
      `INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, result_text, created_at)
       VALUES ('same-ms', ?, ?, ?, 'A', '/tmp/x', ?, ?, ?, '2026-10-11T12:00:00.185Z')`,
    ).run(env.TENANT_SLUG, TASK, SQUAD, '9f'.repeat(32), '1e'.repeat(32), text)
    sql().prepare(
      `INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at) VALUES ('rej-same-ms', ?, 'rejected', NULL, 'mem-admin', '2026-10-11T12:00:00.185000123Z')`,
    ).run(TASK)
    // raw TEXT order would put the rejection first ('0' < 'Z'); at millisecond precision it is a tie, which counts
    expect(await verdict(agentAuth('A'))).toMatchObject({ ok: false, error: 'self_verdict' })
  })

  it('the ledger is tenant-scoped: a matching row under ANOTHER tenant is not the producer record', async () => {
    const text = `x\nArtifact: /tmp/x\nSHA256: ${SHA}`
    sql().prepare(`UPDATE tasks SET status = 'review', result = ? WHERE id = ?`).run(text, TASK)
    sql().prepare(
      `INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, result_text)
       VALUES ('other-tenant', 'someone-else', ?, ?, 'A', '/tmp/x', ?, ?, ?)`,
    ).run(TASK, SQUAD, '9f'.repeat(32), '1e'.repeat(32), text)
    expect(await verdict(agentAuth('A'))).toMatchObject({ ok: false, error: 'self_verdict' })
    expect(verdictRows()).toBe(0)
  })

  it('a LATER row from another tenant does not shadow the real latest row (the MAX is tenant-scoped too)', async () => {
    await produce('A')
    sql().prepare(
      `INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, result_text)
       VALUES ('other-tenant-later', 'someone-else', ?, ?, 'G', '/tmp/x', ?, ?, 'whatever')`,
    ).run(TASK, SQUAD, '9f'.repeat(32), '1e'.repeat(32))
    const res = await verdict(agentAuth('A'))
    expect(res.ok, JSON.stringify(res)).toBe(true)
  })

  it('rework no longer destroys the rejected text: the ledger keeps it append-only after the clear', async () => {
    await rejectedAfterProducedByA()
    const rejectedText = row().result
    expect(rejectedText).toContain('Artifact: /tmp/work.txt')
    expect((await update(adminAuth(), { status: 'in_progress' })).ok).toBe(true)
    expect(row().result).toBeNull()
    const kept = sql().prepare(`SELECT result_text AS t FROM task_result_submissions WHERE task_id = ?`).all(TASK) as Array<{ t: string }>
    expect(kept.map((r) => r.t)).toEqual([rejectedText])
    expect(() => sql().prepare(`UPDATE task_result_submissions SET result_text = 'x'`).run()).toThrow(/append-only/)
  })

  // ── P2s ──────────────────────────────────────────────────────────────────────
  it('a verdict reversal cannot also change the assignee (MCP + REST); nothing is written, the verdict stays unreversed', async () => {
    await produce('A')
    expect((await verdict(adminAuth())).ok).toBe(true)
    const mcp = await update(adminAuth(), { status: 'review', reversal_reason: 'x', assignee_agent_id: 'G' })
    expect(mcp).toMatchObject({ ok: false, status: 409, error: 'assignee_change_with_reversal' })
    const res = await rest(adminAuth(), 'PATCH', '', { status: 'review', reversal_reason: 'x', assignee_agent_id: 'G' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'assignee_change_with_reversal' })
    expect(row()).toMatchObject({ status: 'approved', assignee: 'A' })
    expect((sql().prepare(`SELECT COUNT(*) AS n FROM task_verdicts WHERE task_id = ? AND reversed_at IS NOT NULL`).get(TASK) as { n: number }).n).toBe(0)
    expect((sql().prepare(`SELECT COUNT(*) AS n FROM verdict_reversals WHERE task_id = ?`).get(TASK) as { n: number }).n).toBe(0)
  })

  it('the service-level reversal refuses an assignee change too (no half-committed gate close)', async () => {
    await produce('A')
    expect((await verdict(adminAuth())).ok).toBe(true)
    const existing = sql().prepare(`SELECT * FROM tasks WHERE id = ?`).get(TASK) as unknown as Task
    const { reverseTaskVerdict, TaskUpdateConflictError } = await import('../src/tasks/service')
    await expect(reverseTaskVerdict(env, {
      existing, next: { ...existing, status: 'review', assignee_agent_id: 'G', updated_at: new Date().toISOString() },
      tenant: TENANT, reason: 'x', actorId: 'ADMIN', actorType: 'member',
    })).rejects.toBeInstanceOf(TaskUpdateConflictError)
    expect((sql().prepare(`SELECT COUNT(*) AS n FROM task_verdicts WHERE task_id = ? AND reversed_at IS NOT NULL`).get(TASK) as { n: number }).n).toBe(0)
  })

  it('the owner_override path keeps the lane gate_owner re-read: a stale lane snapshot after an owner re-gate lands nothing', async () => {
    await produce('A')
    const stale = sql().prepare(`SELECT * FROM tasks WHERE id = ?`).get(TASK) as unknown as Task
    sql().prepare(`UPDATE tasks SET gate_owner = 'gate:review' WHERE id = ?`).run(TASK)
    await expect(writeVerdict(env, { task: stale, verdict: 'approved', note: null, decidedBy: 'ADMIN', independenceWaiver: 'owner_override' }))
      .rejects.toBeInstanceOf(VerdictRaceError)
    expect(verdictRows()).toBe(0)
    expect(row().status).toBe('review')
    // and the statement itself carries the lane guard for the override waiver
    expect(buildVerdictStatements(env, { task: stale, verdict: 'approved', note: null, decidedBy: 'ADMIN', independenceWaiver: 'owner_override' }).statements.length).toBe(2)
  })

  // ── REST twins for the earlier rounds' guards ────────────────────────────────
  it('REST PATCH: assignee_frozen_in_review (the assignee is frozen for every caller while in review)', async () => {
    await produce('A')
    const res = await rest(agentAuth('G'), 'PATCH', '', { assignee_agent_id: 'G' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'assignee_frozen_in_review' })
    const admin = await rest(adminAuth(), 'PATCH', '', { assignee_agent_id: null })
    expect(admin.status).toBe(409)
    expect(await admin.json()).toMatchObject({ error: 'assignee_frozen_in_review' })
    expect(row().assignee).toBe('A')
  })

  it('REST PATCH: gate_owner_reserved (the lane name cannot be put on a task by task_update-class writers)', async () => {
    sql().prepare(`INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, assignee_agent_id, created_at, updated_at)
      VALUES ('t-open', ?, 'T', 'b', 'done', 'in_progress', NULL, 'G', datetime('now'), datetime('now'))`).run(SQUAD)
    const res = await tasksApp.fetch(new Request('https://pot.test/t-open', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-auth': JSON.stringify(agentAuth('G')), Origin: ORIGIN },
      body: JSON.stringify({ gate_owner: LANE }),
    }), env)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'gate_owner_reserved' })
    expect((sql().prepare(`SELECT gate_owner AS g FROM tasks WHERE id = 't-open'`).get() as { g: string | null }).g).toBeNull()
  })
})
