// tests/verdict-submission-binding.test.ts — seed-build-plan-20261022 B3 + B4 (round 2).
//
// B3: task_verdicts.submission_id / result_digest bind a verdict to the task's CURRENT submission: the latest ledger row whose
//     result_text equals tasks.result with no unreversed rejection after it. Otherwise NULL. The binding is re-asserted inside
//     the status UPDATE's WHERE; a verdict bound to submission N does not count for N+1 (verdictForSubmission).
// B4: a verdict on a task in receipt-chain scope (objective lane, or a bounty_task_bindings row) owes a `gate.verdict`
//     execution receipt; the owed marker (receipt_actor_kind) rides the verdict row; a failed append never blocks the verdict and is
//     healed by reconcileGateVerdictReceipts; a reversal reaches the chain too.
//
// Real SQLite over the full committed migration chain (never a hand-rolled schema).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env, Task } from '../src/types'
import { writeVerdict, reverseTaskVerdict, VerdictRaceError } from '../src/tasks/service'
import {
  currentSubmissionApproved,
  emitGateVerdictReceipt,
  reconcileGateVerdictReceipts,
  verdictForSubmission,
  VerdictSubmissionMismatchError,
  VerdictSubmissionRequiredError,
} from '../src/tasks/verdict-binding'
import { appendExecutionReceipt, verifyExecutionReceipt } from '../src/flight-spine/receipts'
import { invokeTool } from '../src/mcp/index'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'seed-b3'
const D1 = 'a'.repeat(64)
const D2 = 'b'.repeat(64)
const D3 = 'c'.repeat(64)

let harness: SqliteD1Harness
let env: Env

function seedBase(): void {
  const q = harness.sqlite
  q.prepare(`INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept-1', 'Dept One')`).run()
  q.prepare(`INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'squad-1', 'Squad One')`).run()
  q.prepare(`INSERT INTO members (id, email, display_name, status, tenant) VALUES ('member-1', 'm1@test.com', 'M1', 'active', ?)`).run(TENANT)
}

function seedTask(id: string, opts: { externalSource?: string | null; result?: string | null } = {}): void {
  harness.sqlite.prepare(
    `INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, external_source, result, created_at, updated_at)
     VALUES (?, 'squad-1', 'T', 'body', 'done', 'review', 'gate:test', ?, ?, datetime('now'), datetime('now'))`,
  ).run(id, opts.externalSource ?? null, opts.result ?? null)
}

let seqStamp = 0
/** An agent submits: ledger row (result_text = the text) AND tasks.result = the text, like task_submit_result / execute finish. */
function submit(taskId: string, id: string, digest: string, text: string, createdAt?: string): void {
  seqStamp += 1
  const at = createdAt ?? `2026-10-20T00:00:${String(seqStamp).padStart(2, '0')}.000Z` // in the past: before any verdict this test casts
  harness.sqlite.prepare(
    `INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, result_text, created_at)
     VALUES (?, ?, ?, 'squad-1', 'agent-sub', 'a/b.md', ?, ?, ?, ?)`,
  ).run(id, TENANT, taskId, digest, digest, text, at)
  harness.sqlite.prepare('UPDATE tasks SET result = ? WHERE id = ?').run(text, taskId)
}

/** A submission strictly AFTER any verdict already cast (so a prior rejection does not count as "after" it). */
function futureStamp(): string {
  return new Date(Date.now() + 60_000).toISOString()
}

function setTaskState(taskId: string, status: string, result: string | null): void {
  harness.sqlite.prepare('UPDATE tasks SET status = ?, result = ?, updated_at = datetime(\'now\') WHERE id = ?').run(status, result, taskId)
}

function seedObjectiveChain(taskId: string): { objectiveId: string; flightId: string } {
  const q = harness.sqlite
  q.exec('PRAGMA foreign_keys = OFF')
  q.prepare(
    `INSERT INTO objectives (id, tenant, created_by_principal_kind, created_by_principal_id, created_by_member_id, squad_id, title,
       success_contract, authority_envelope, policy_json, budget_micro_usd, payload_json, payload_digest, accepted_at, created_at)
     VALUES ('obj-1', ?, 'member', 'member-1', 'member-1', 'squad-1', 'O', 'ship', '{}', '{}', 0, '{}', ?, '2026-10-22T00:00:00Z', '2026-10-22T00:00:00Z')`,
  ).run(TENANT, D1)
  q.prepare(`INSERT INTO flights (id, tenant, agent, goal) VALUES ('flight-1', ?, 'agent-1', 'g')`).run(TENANT)
  q.prepare(
    `INSERT INTO flight_objectives (id, tenant, flight_id, objective_id, linked_at) VALUES ('fo-1', ?, 'flight-1', 'obj-1', '2026-10-22T00:00:00Z')`,
  ).run(TENANT)
  q.prepare(
    `INSERT INTO flight_lanes (id, tenant, flight_id, lane_key, role, task_id, assignment_epoch, agent_id, done_when, created_at)
     VALUES ('lane-1', ?, 'flight-1', 'k', 'worker', ?, 1, 'agent-1', 'done', '2026-10-22T00:00:00Z')`,
  ).run(TENANT, taskId)
  q.exec('PRAGMA foreign_keys = ON')
  return { objectiveId: 'obj-1', flightId: 'flight-1' }
}

/** The real bounty -> task binding row (migration 0250, seed B1): the trusted signal that puts a bounty task in receipt-chain scope. */
function bindBountyToTask(bountyId: string, taskId: string): void {
  harness.sqlite.prepare(
    `INSERT INTO bounty_task_bindings (bounty_id, task_id, award_revision, payload_sha256, issuer_tenant, claimant_identity_id, created_at)
     VALUES (?, ?, 0, ?, 'mumega', 'ident-1', '2026-10-22T00:00:00.000Z')`,
  ).run(bountyId, taskId, D1)
}

function loadTask(id: string): Task {
  return harness.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as Task
}
function verdictRows(taskId: string): Array<Record<string, unknown>> {
  return harness.sqlite.prepare('SELECT * FROM task_verdicts WHERE task_id = ? ORDER BY decided_at').all(taskId) as Array<Record<string, unknown>>
}
function receiptRows(): Array<Record<string, unknown>> {
  return harness.sqlite.prepare('SELECT * FROM execution_receipts ORDER BY sequence').all() as Array<Record<string, unknown>>
}
async function decide(taskId: string, verdict: 'approved' | 'rejected' = 'approved', extra: Partial<Parameters<typeof writeVerdict>[1]> = {}) {
  return writeVerdict(env, { task: loadTask(taskId), verdict, note: null, decidedBy: 'member-1', ...extra })
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  seedBase()
  seqStamp = 0
  env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
})
afterEach(() => {
  harness.close()
  vi.restoreAllMocks()
})

/** Wrap env.DB so `before` runs once, right before the verdict batch executes (i.e. after writeVerdict has already read). */
function envRacing(before: () => void): Env {
  const racing = Object.create(harness.db) as typeof harness.db
  let fired = false
  racing.batch = (async (statements: Parameters<typeof harness.db.batch>[0]) => {
    if (!fired) { fired = true; before() }
    return harness.db.batch(statements)
  }) as typeof harness.db.batch
  return { ...env, DB: racing } as Env
}

describe('B3: the verdict binds to the CURRENT submission', () => {
  it('binds the latest of several submissions (submission_id + result_digest)', async () => {
    seedTask('t1')
    submit('t1', 'sub-1', D1, 'R1')
    submit('t1', 'sub-2', D2, 'R2')
    const out = await decide('t1')
    expect(out.verdict).toMatchObject({ submission_id: 'sub-2', result_digest: D2 })
    expect(verdictRows('t1')[0]).toMatchObject({ submission_id: 'sub-2', result_digest: D2 })
  })

  it('a task with no submission keeps the current behaviour: nulls, verdict lands', async () => {
    seedTask('t1')
    const out = await decide('t1')
    expect(out.task.status).toBe('approved')
    expect(verdictRows('t1')[0]).toMatchObject({ submission_id: null, result_digest: null })
  })

  it('a legacy submission (result_text NULL) is never "current": NULL binding', async () => {
    seedTask('t1', { result: 'R1' })
    harness.sqlite.prepare(
      `INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest)
       VALUES ('legacy', ?, 't1', 'squad-1', 'agent-sub', 'a/b.md', ?, ?)`,
    ).run(TENANT, D1, D1)
    await decide('t1')
    expect(verdictRows('t1')[0]).toMatchObject({ submission_id: null, result_digest: null })
  })

  it('P0: submit -> reject -> rework into review WITHOUT a submission (new result) -> approve = NULL binding, no false approval of sub-1, receipt does not name sub-1', async () => {
    seedTask('t1')
    seedObjectiveChain('t1')
    submit('t1', 'sub-1', D1, 'R1')
    const rejected = await decide('t1', 'rejected')
    expect(rejected.verdict).toMatchObject({ submission_id: 'sub-1' })
    // Rework: another writer (CI sync / runtime receipt / routine ...) puts the task back in review with a new result and appends no ledger row.
    setTaskState('t1', 'review', 'R2 written by a path that appends no submission')
    const approved = await decide('t1', 'approved')
    expect(approved.verdict).toMatchObject({ submission_id: null, result_digest: null })
    expect(verdictRows('t1')[1]).toMatchObject({ verdict: 'approved', submission_id: null })
    // sub-1 never gets an approval
    const forSub1 = await verdictForSubmission(env, 't1', 'sub-1')
    expect(forSub1?.verdict).toBe('rejected')
    expect(await currentSubmissionApproved(env, 't1')).toBe(false)
    // and the immutable chain does not claim sub-1 for the approval
    const rows = receiptRows()
    const approvalReceipt = rows.find((r) => r.idempotency_key === `verdict:${approved.verdict.id}`)
    expect(approvalReceipt).toBeDefined()
    const claims = JSON.parse(String(approvalReceipt?.claims_json)) as Record<string, unknown>
    expect(claims).toMatchObject({ verdict: 'approved', submission_id: null, result_digest: null })
    expect(String(approvalReceipt?.claims_json)).not.toContain('sub-1')
  })

  it('P0 (equal bytes): the rejected result text written back by another path does not revive the spent submission', async () => {
    seedTask('t1')
    submit('t1', 'sub-1', D1, 'R1')
    await decide('t1', 'rejected')
    setTaskState('t1', 'review', 'R1') // identical text, no new submission
    const approved = await decide('t1', 'approved')
    expect(approved.verdict).toMatchObject({ submission_id: null })
    expect(await currentSubmissionApproved(env, 't1')).toBe(false)
  })

  it('a fresh submission after the rejection IS current again', async () => {
    seedTask('t1')
    submit('t1', 'sub-1', D1, 'R1')
    await decide('t1', 'rejected')
    setTaskState('t1', 'review', null)
    submit('t1', 'sub-2', D2, 'R2', futureStamp())
    const approved = await decide('t1', 'approved')
    expect(approved.verdict).toMatchObject({ submission_id: 'sub-2', result_digest: D2 })
  })

  it('RACE: a newer submission landing between the read and the write refuses the verdict (never binds a stale one)', async () => {
    seedTask('t1')
    submit('t1', 'sub-1', D1, 'R1')
    const racing = envRacing(() => submit('t1', 'sub-2', D2, 'R2'))
    await expect(
      writeVerdict(racing, { task: loadTask('t1'), verdict: 'approved', note: null, decidedBy: 'member-1' }),
    ).rejects.toBeInstanceOf(VerdictRaceError)
    expect(verdictRows('t1')).toHaveLength(0)
    expect(loadTask('t1').status).toBe('review') // nothing half-written
    expect((await decide('t1')).verdict).toMatchObject({ submission_id: 'sub-2' }) // a retry that re-reads binds the new one
  })

  it('RACE: the first-ever submission landing after a "none" read also refuses the verdict', async () => {
    seedTask('t1')
    const racing = envRacing(() => submit('t1', 'sub-1', D1, 'R1'))
    await expect(
      writeVerdict(racing, { task: loadTask('t1'), verdict: 'approved', note: null, decidedBy: 'member-1' }),
    ).rejects.toBeInstanceOf(VerdictRaceError)
    expect(verdictRows('t1')).toHaveLength(0)
  })

  it('RACE: tasks.result changing between the caller\'s read and the write (no new submission) refuses the verdict', async () => {
    seedTask('t1')
    submit('t1', 'sub-1', D1, 'R1')
    const snapshot = loadTask('t1')
    const racing = envRacing(() => harness.sqlite.prepare(`UPDATE tasks SET result = 'CI synced a different result' WHERE id = 't1'`).run())
    await expect(
      writeVerdict(racing, { task: snapshot, verdict: 'approved', note: null, decidedBy: 'member-1' }),
    ).rejects.toBeInstanceOf(VerdictRaceError)
    expect(verdictRows('t1')).toHaveLength(0)
  })

  it('a caller holding a stale task snapshot (result differs from the live row) is refused', async () => {
    seedTask('t1')
    submit('t1', 'sub-1', D1, 'R1')
    const stale = { ...loadTask('t1'), result: 'what the decider saw earlier' }
    await expect(writeVerdict(env, { task: stale, verdict: 'approved', note: null, decidedBy: 'member-1' })).rejects.toBeInstanceOf(VerdictRaceError)
  })
})

describe('B3: a rejected submission stays spent', () => {
  it('RACE: a rejection of the read submission landing before the write, task back in review with the SAME text, refuses the approval', async () => {
    seedTask('t1')
    submit('t1', 'sub-1', D1, 'R1')
    // Between writeVerdict's read (binds sub-1) and its batch: someone rejects sub-1 and the task returns to review with the
    // identical text and no new submission. The tasks.result conjunct cannot see this; only the submission-id conjunct does.
    const racing = envRacing(() => {
      harness.sqlite.prepare(
        `INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at, submission_id, result_digest)
         VALUES ('rej-race', 't1', 'rejected', NULL, 'member-9', ?, 'sub-1', ?)`,
      ).run(new Date().toISOString(), D1)
    })
    await expect(
      writeVerdict(racing, { task: loadTask('t1'), verdict: 'approved', note: null, decidedBy: 'member-1' }),
    ).rejects.toBeInstanceOf(VerdictRaceError)
    expect(verdictRows('t1').map((r) => r.verdict)).toEqual(['rejected']) // only the injected rejection; no approval
    expect(loadTask('t1').status).toBe('review')
  })

  it('CLOCK SKEW: a rejection bound to the submission spends it even when its timestamp precedes the ledger row\'s created_at', async () => {
    seedTask('t1')
    submit('t1', 'sub-1', D1, 'R1', '2099-01-01T00:00:00.000Z') // ledger clock far ahead of the verdict clock
    const rejected = await decide('t1', 'rejected')
    expect(rejected.verdict).toMatchObject({ submission_id: 'sub-1' })
    setTaskState('t1', 'review', 'R1') // same text, no new submission
    const approved = await decide('t1', 'approved')
    expect(approved.verdict).toMatchObject({ submission_id: null })
    expect(await currentSubmissionApproved(env, 't1')).toBe(false)
  })
})

describe('B3: a bound rejection spends only its own submission', () => {
  function insertRejection(id: string, submissionId: string | null, decidedAt: string): void {
    harness.sqlite.prepare(
      `INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at, submission_id) VALUES (?, 't1', 'rejected', NULL, 'member-9', ?, ?)`,
    ).run(id, decidedAt, submissionId)
  }

  it('a rejection of N in the SAME millisecond as N+1\'s ledger row does not spend N+1', async () => {
    seedTask('t1')
    submit('t1', 'sub-1', D1, 'R1', '2026-10-22T05:00:00.000Z')
    submit('t1', 'sub-2', D2, 'R2', '2026-10-22T05:00:00.123Z')
    insertRejection('rej-1', 'sub-1', '2026-10-22T05:00:00.123456Z') // bound to sub-1, same ms as sub-2's created_at
    const out = await decide('t1')
    expect(out.verdict).toMatchObject({ submission_id: 'sub-2', result_digest: D2 })
  })

  it('an UNBOUND (legacy / no-current-submission) rejection at or after the ledger row still spends it by timestamp', async () => {
    seedTask('t1')
    submit('t1', 'sub-1', D1, 'R1', '2026-10-22T05:00:00.123Z')
    insertRejection('rej-legacy', null, '2026-10-22T05:00:00.123456Z')
    expect((await decide('t1')).verdict).toMatchObject({ submission_id: null })
  })

  it('a bound rejection of the OLDER submission, decided after N+1 was written, leaves N+1 current', async () => {
    seedTask('t1')
    submit('t1', 'sub-1', D1, 'R1', '2026-10-22T05:00:00.000Z')
    submit('t1', 'sub-2', D2, 'R2', '2026-10-22T05:00:01.000Z')
    insertRejection('rej-late', 'sub-1', '2026-10-22T05:00:09.000Z')
    expect((await decide('t1')).verdict).toMatchObject({ submission_id: 'sub-2' })
  })
})

describe('B3: a stale verdict does not apply to a newer submission', () => {
  it('verdictForSubmission: the verdict answers submission N, not N+1', async () => {
    seedTask('t1')
    submit('t1', 'sub-1', D1, 'R1')
    await decide('t1')
    expect(await verdictForSubmission(env, 't1', 'sub-1')).toMatchObject({ verdict: 'approved', submission_id: 'sub-1' })
    expect(await currentSubmissionApproved(env, 't1')).toBe(true)
    submit('t1', 'sub-2', D2, 'R2')
    expect(await verdictForSubmission(env, 't1', 'sub-2')).toBeNull()
    expect(await currentSubmissionApproved(env, 't1')).toBe(false)
    expect(await verdictForSubmission(env, 't1', 'sub-1')).not.toBeNull()
  })

  it('a NULL-bound verdict never counts for a later concrete submission', async () => {
    seedTask('t1')
    await decide('t1')
    submit('t1', 'sub-1', D1, 'R1')
    expect(await verdictForSubmission(env, 't1', 'sub-1')).toBeNull()
    expect(await currentSubmissionApproved(env, 't1')).toBe(false)
  })

  it('a reversed verdict no longer answers its submission', async () => {
    seedTask('t1')
    submit('t1', 'sub-1', D1, 'R1')
    await decide('t1')
    harness.sqlite.prepare(`UPDATE task_verdicts SET reversed_at = '2026-10-22T01:00:00Z' WHERE task_id = 't1'`).run()
    expect(await verdictForSubmission(env, 't1', 'sub-1')).toBeNull()
  })

  it('the append-only trigger pins submission_id / result_digest / receipt_actor_kind on BOTH branches', async () => {
    seedTask('t1', { externalSource: null })
    seedObjectiveChain('t1')
    submit('t1', 'sub-1', D1, 'R1')
    await decide('t1')
    const upd = (set: string) => () => harness.sqlite.prepare(`UPDATE task_verdicts SET ${set} WHERE task_id = 't1'`).run()
    // plain branch
    for (const set of [`submission_id = 'x'`, `result_digest = NULL`, `receipt_actor_kind = NULL`]) {
      expect(upd(set), set).toThrow(/append-only/)
    }
    // reversal-stamp branch: stamping reversed_at must not smuggle a changed binding
    for (const set of [`submission_id = 'x'`, `result_digest = 'f'`, `receipt_actor_kind = 'agent'`, `receipt_actor_kind = NULL`]) {
      expect(upd(`reversed_at = '2026-10-22T01:00:00Z', ${set}`), set).toThrow(/append-only/)
    }
    // the plain reversal stamp itself still works
    expect(upd(`reversed_at = '2026-10-22T01:00:00Z'`)).not.toThrow()
  })

  it('there is never a moment without an update trigger: 0258 creates the new trigger, then drops the old (0252\'s)', () => {
    const names = (harness.sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'task_verdicts' AND name LIKE '%no_update%'`).all() as Array<{ name: string }>).map((r) => r.name)
    expect(names).toEqual(['task_verdicts_no_update_0258'])
  })
})

describe('B3: the decider-seen binding (expected_submission_id)', () => {
  it('a matching expected id passes; a different id, null-when-one-exists, and an id-when-none-exists are all refused (nothing written)', async () => {
    seedTask('t1')
    submit('t1', 'sub-1', D1, 'R1')
    await expect(decide('t1', 'approved', { expectedSubmissionId: 'sub-0' })).rejects.toBeInstanceOf(VerdictSubmissionMismatchError)
    await expect(decide('t1', 'approved', { expectedSubmissionId: null })).rejects.toBeInstanceOf(VerdictSubmissionMismatchError)
    expect(verdictRows('t1')).toHaveLength(0)
    expect(loadTask('t1').status).toBe('review')
    expect((await decide('t1', 'approved', { expectedSubmissionId: 'sub-1' })).verdict).toMatchObject({ submission_id: 'sub-1' })

    seedTask('t2')
    await expect(decide('t2', 'approved', { expectedSubmissionId: 'sub-1' })).rejects.toBeInstanceOf(VerdictSubmissionMismatchError)
    expect((await decide('t2', 'approved', { expectedSubmissionId: null })).task.status).toBe('approved')
  })

  it('a mismatch is a VerdictRaceError subclass, so every pre-existing catch still answers 409', async () => {
    seedTask('t1')
    submit('t1', 'sub-1', D1, 'R1')
    await expect(decide('t1', 'approved', { expectedSubmissionId: 'nope' })).rejects.toBeInstanceOf(VerdictRaceError)
  })

  it('an AGENT decider on a chain-scope task MUST name the submission; a human, or an agent on an out-of-scope task, need not', async () => {
    seedTask('chain')
    seedObjectiveChain('chain')
    submit('chain', 'sub-1', D1, 'R1')
    const agent = { kind: 'agent' as const, id: 'agent-gate' }
    await expect(
      writeVerdict(env, { task: loadTask('chain'), verdict: 'approved', note: null, decidedBy: 'agent-gate' }, agent),
    ).rejects.toBeInstanceOf(VerdictSubmissionRequiredError)
    expect(verdictRows('chain')).toHaveLength(0)
    const ok = await writeVerdict(env, { task: loadTask('chain'), verdict: 'approved', note: null, decidedBy: 'agent-gate', expectedSubmissionId: 'sub-1' }, agent)
    expect(ok.verdict).toMatchObject({ submission_id: 'sub-1', receipt_actor_kind: 'agent' })

    seedTask('plain')
    await expect(
      writeVerdict(env, { task: loadTask('plain'), verdict: 'approved', note: null, decidedBy: 'agent-gate' }, agent),
    ).resolves.toBeDefined()
  })

  it('a human decider on a chain-scope task may omit it', async () => {
    seedTask('chain')
    seedObjectiveChain('chain')
    submit('chain', 'sub-1', D1, 'R1')
    expect((await decide('chain')).verdict).toMatchObject({ submission_id: 'sub-1', receipt_actor_kind: 'member' })
  })
})

describe('B4: receipt scope comes from trusted rows', () => {
  it('objective-lane task: one gate.verdict receipt with objective/flight/task, the binding, and the attribution fields', async () => {
    seedTask('t1')
    submit('t1', 'sub-1', D1, 'R1')
    const { objectiveId, flightId } = seedObjectiveChain('t1')
    const out = await decide('t1')
    const rows = receiptRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      type: 'gate.verdict', issuer_kind: 'mupot', actor_kind: 'member', actor_id: 'member-1',
      objective_id: objectiveId, flight_id: flightId, task_id: 't1', idempotency_key: `verdict:${out.verdict.id}`,
    })
    expect(JSON.parse(String(rows[0].claims_json))).toMatchObject({
      verdict_id: out.verdict.id, verdict: 'approved', submission_id: 'sub-1', result_digest: D1,
      attachment_id: null, consenting_member_id: null,
    })
    expect(out.gate_receipt).toMatchObject({ status: 'appended', receipt_id: rows[0].id })
    expect(await verifyExecutionReceipt(env, String(rows[0].id))).toMatchObject({ ok: true })
  })

  it('a task BOUND by a bounty_task_bindings row gets a receipt', async () => {
    seedTask('t1')
    bindBountyToTask('bty-1', 't1')
    const out = await decide('t1')
    expect(receiptRows()).toHaveLength(1)
    expect(receiptRows()[0]).toMatchObject({ type: 'gate.verdict', objective_id: null, task_id: 't1' })
    expect(out.gate_receipt?.status).toBe('appended')
  })

  it('a forged external_source prefix is NOT trusted: no binding row for them, so no receipt and no owed marker', async () => {
    seedTask('forged', { externalSource: 'mumega-bounty:b-42' })
    const before = await decide('forged')
    expect(before.gate_receipt).toBeUndefined()
    expect(verdictRows('forged')[0]).toMatchObject({ receipt_actor_kind: null })

    seedTask('bound-elsewhere', { externalSource: null })
    bindBountyToTask('bty-other', 'bound-elsewhere') // a binding exists, but NOT for the forged task
    seedTask('forged2', { externalSource: 'mumega-bounty:b-43' })
    const after = await decide('forged2')
    expect(after.gate_receipt).toBeUndefined()
    expect(receiptRows()).toHaveLength(0)
  })

  it('no receipt for unrelated tasks', async () => {
    seedTask('plain')
    seedTask('other-src', { externalSource: 'github:issue-9' })
    for (const id of ['plain', 'other-src']) expect((await decide(id)).gate_receipt).toBeUndefined()
    expect(receiptRows()).toHaveLength(0)
  })
})

describe('B4: idempotency, chain, failure, reconcile, reversal', () => {
  async function chainTask(id: string): Promise<void> {
    seedTask(id)
    bindBountyToTask(`bty-${id}`, id)
  }

  it('REPLAY: re-emitting for the same verdict returns the original receipt; exactly one row', async () => {
    await chainTask('t1')
    const out = await decide('t1')
    const again = await emitGateVerdictReceipt(env, out.verdict)
    const third = await emitGateVerdictReceipt(env, out.verdict)
    expect(receiptRows()).toHaveLength(1)
    expect(again).toEqual(third)
    expect(again).toMatchObject({ status: 'appended', receipt_id: receiptRows()[0].id })
  })

  it('successive verdicts extend the SAME hash chain (predecessor linkage, verifiable)', async () => {
    await chainTask('t1')
    seedTask('t2')
    bindBountyToTask('bty-t2', 't2')
    await decide('t1')
    await decide('t2')
    const rows = receiptRows()
    expect(rows[1].predecessor_receipt_id).toBe(rows[0].id)
    expect(rows[1].predecessor_hash).toBe(rows[0].receipt_hash)
    expect(await verifyExecutionReceipt(env, String(rows[1].id))).toMatchObject({ ok: true })
  })

  it('CONCURRENT: racing appends on the tenant head all land (bounded stale_head retry), chain stays linear', async () => {
    const ids = ['c1', 'c2', 'c3', 'c4']
    for (const id of ids) { seedTask(id); bindBountyToTask(`bty-${id}`, id) }
    // Cast the verdicts with the head table out of reach (appends fail, the owed markers stay), then restore it and race all four emits.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    harness.sqlite.exec('ALTER TABLE execution_receipt_heads RENAME TO execution_receipt_heads_broken')
    const outs = []
    for (const id of ids) outs.push(await decide(id))
    harness.sqlite.exec('ALTER TABLE execution_receipt_heads_broken RENAME TO execution_receipt_heads')
    expect(receiptRows()).toHaveLength(0)
    const results = await Promise.all(outs.map((o) => emitGateVerdictReceipt(env, o.verdict)))
    expect(results.every((r) => r?.status === 'appended')).toBe(true)
    const rows = receiptRows()
    expect(rows).toHaveLength(4)
    for (let i = 1; i < rows.length; i++) expect(rows[i].predecessor_receipt_id).toBe(rows[i - 1].id)
  })

  it('receipt failure never blocks the verdict; it is logged and surfaced; the owed marker survives; reconcile heals it with the stored actor kind', async () => {
    await chainTask('t1')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    harness.sqlite.exec('ALTER TABLE execution_receipt_heads RENAME TO execution_receipt_heads_broken')
    const out = await writeVerdict(env, { task: loadTask('t1'), verdict: 'rejected', note: 'no', decidedBy: 'agent-gate', expectedSubmissionId: null }, { kind: 'agent', id: 'agent-gate' })
    expect(out.task.status).toBe('rejected')
    expect(out.gate_receipt).toMatchObject({ status: 'failed' })
    expect(err).toHaveBeenCalledWith(expect.stringContaining('gate.verdict receipt append failed'), expect.stringContaining(out.verdict.id))
    expect(receiptRows()).toHaveLength(0)
    expect(verdictRows('t1')[0]).toMatchObject({ receipt_actor_kind: 'agent' }) // the durable pending marker

    // still broken: reconcile reports the failure and does not throw
    expect(await reconcileGateVerdictReceipts(env, { graceMs: 0 })).toMatchObject({ verdicts_healed: 0, failed: 1 })

    harness.sqlite.exec('ALTER TABLE execution_receipt_heads_broken RENAME TO execution_receipt_heads')
    expect(await reconcileGateVerdictReceipts(env, { graceMs: 0 })).toEqual({ verdicts_healed: 1, reversals_healed: 0, failed: 0 })
    expect(receiptRows()).toHaveLength(1)
    expect(receiptRows()[0]).toMatchObject({ actor_kind: 'agent', actor_id: 'agent-gate', idempotency_key: `verdict:${out.verdict.id}` })
    // nothing left to heal; a second pass is a no-op
    expect(await reconcileGateVerdictReceipts(env, { graceMs: 0 })).toEqual({ verdicts_healed: 0, reversals_healed: 0, failed: 0 })
  })

  it('reconcile leaves a verdict inside the grace window alone and never touches out-of-scope verdicts', async () => {
    await chainTask('t1')
    harness.sqlite.exec('ALTER TABLE execution_receipt_heads RENAME TO execution_receipt_heads_broken')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await decide('t1')
    seedTask('plain')
    await decide('plain')
    harness.sqlite.exec('ALTER TABLE execution_receipt_heads_broken RENAME TO execution_receipt_heads')
    expect(await reconcileGateVerdictReceipts(env)).toEqual({ verdicts_healed: 0, reversals_healed: 0, failed: 0 }) // default 30s grace
    expect(await reconcileGateVerdictReceipts(env, { graceMs: 0 })).toEqual({ verdicts_healed: 1, reversals_healed: 0, failed: 0 })
    expect(receiptRows()).toHaveLength(1) // only the chain-scope task
  })

  async function reverse(taskId: string, who: { id: string; type: 'member' | 'agent' } = { id: 'member-1', type: 'member' }): Promise<Awaited<ReturnType<typeof reverseTaskVerdict>>> {
    const existing = loadTask(taskId)
    const next: Task = { ...existing, status: 'review', updated_at: new Date(Date.now() + 1000).toISOString() }
    return reverseTaskVerdict(env, { existing, next, tenant: TENANT, reason: 'wrong call', actorId: who.id, actorType: who.type })
  }

  it('a REVERSAL reaches the chain: gate.verdict with reversed:true, once, after the verdict receipt', async () => {
    await chainTask('t1')
    submit('t1', 'sub-1', D1, 'R1')
    const out = await decide('t1')
    const res = await reverse('t1')
    expect(res.ok).toBe(true)
    const rows = receiptRows()
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ type: 'gate.verdict', idempotency_key: `verdict-reversed:${out.verdict.id}`, predecessor_receipt_id: rows[0].id })
    expect(JSON.parse(String(rows[1].claims_json))).toMatchObject({ reversed: true, verdict_id: out.verdict.id, reversed_by: 'member-1', submission_id: 'sub-1' })
    // retry-completion of the same reversal is a replay, not a second receipt
    await reverse('t1').catch(() => undefined)
    expect(receiptRows()).toHaveLength(2)
  })

  it('a reversal whose receipt failed is healed by reconcile (verdict receipt first, then the reversal)', async () => {
    await chainTask('t1')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const out = await decide('t1')
    harness.sqlite.exec('ALTER TABLE execution_receipt_heads RENAME TO execution_receipt_heads_broken')
    const res = await reverse('t1')
    expect(res.ok && res.gate_receipt?.status).toBe('failed')
    expect(receiptRows()).toHaveLength(1)
    harness.sqlite.exec('ALTER TABLE execution_receipt_heads_broken RENAME TO execution_receipt_heads')
    expect(await reconcileGateVerdictReceipts(env, { graceMs: 0 })).toEqual({ verdicts_healed: 0, reversals_healed: 1, failed: 0 })
    expect(receiptRows().map((r) => r.idempotency_key)).toEqual([`verdict:${out.verdict.id}`, `verdict-reversed:${out.verdict.id}`])
  })

  it('CHAIN ORDER: a verdict whose receipt failed earlier is appended BEFORE its reversal (verdict -> reversal)', async () => {
    await chainTask('t1')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    harness.sqlite.exec('ALTER TABLE execution_receipt_heads RENAME TO execution_receipt_heads_broken')
    const out = await decide('t1')
    expect(out.gate_receipt?.status).toBe('failed')
    harness.sqlite.exec('ALTER TABLE execution_receipt_heads_broken RENAME TO execution_receipt_heads')
    const res = await reverse('t1')
    expect(res.ok && res.gate_receipt?.status).toBe('appended')
    const rows = receiptRows()
    expect(rows.map((r) => r.idempotency_key)).toEqual([`verdict:${out.verdict.id}`, `verdict-reversed:${out.verdict.id}`])
    expect(rows[1].predecessor_receipt_id).toBe(rows[0].id)
  })

  /** Make the verdict's own receipt UN-appendable (an unrelated receipt already holds its idempotency key) while the chain itself is healthy. */
  async function blockVerdictReceiptKey(verdictId: string): Promise<void> {
    await appendExecutionReceipt(
      env,
      { userId: 'member-1', email: null, role: 'member', tenant: TENANT, memberId: 'member-1', boundAgentId: null },
      { type: 'gate.verdict', idempotencyKey: `verdict:${verdictId}`, taskId: 't1', claims: { squatter: true } },
    )
  }

  it('if the verdict receipt cannot be appended the reversal append is SKIPPED (no reversal before its verdict)', async () => {
    await chainTask('t1')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    harness.sqlite.exec('ALTER TABLE execution_receipt_heads RENAME TO execution_receipt_heads_broken')
    const out = await decide('t1')
    harness.sqlite.exec('ALTER TABLE execution_receipt_heads_broken RENAME TO execution_receipt_heads')
    await blockVerdictReceiptKey(out.verdict.id)
    const res = await reverse('t1')
    expect(res.ok && res.gate_receipt).toMatchObject({ status: 'failed', error: 'idempotency_conflict' })
    expect(receiptRows().map((r) => r.idempotency_key)).toEqual([`verdict:${out.verdict.id}`]) // the squatter only; no reversal receipt
  })

  it('RECONCILE keeps the order too: with the verdict receipt unappendable the sweep does not append the reversal', async () => {
    await chainTask('t1')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    harness.sqlite.exec('ALTER TABLE execution_receipt_heads RENAME TO execution_receipt_heads_broken')
    const out = await decide('t1')
    await reverse('t1')
    harness.sqlite.exec('ALTER TABLE execution_receipt_heads_broken RENAME TO execution_receipt_heads')
    await blockVerdictReceiptKey(out.verdict.id)
    expect(await reconcileGateVerdictReceipts(env, { graceMs: 0 })).toEqual({ verdicts_healed: 0, reversals_healed: 0, failed: 1 })
    expect(receiptRows().map((r) => r.idempotency_key)).toEqual([`verdict:${out.verdict.id}`])
  })

  it('the reversal receipt\'s actor is the one RECORDED on the verdict_reversals row, for a retry by someone else and for the sweep', async () => {
    await chainTask('t1')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const out = await decide('t1')
    harness.sqlite.exec('ALTER TABLE execution_receipt_heads RENAME TO execution_receipt_heads_broken')
    const first = await reverse('t1', { id: 'agent-rev', type: 'agent' }) // the reversal row records agent-rev; its receipt fails
    expect(first.ok && first.gate_receipt?.status).toBe('failed')
    harness.sqlite.exec('ALTER TABLE execution_receipt_heads_broken RENAME TO execution_receipt_heads')
    // A retry-completion by a DIFFERENT principal must not re-attribute the reversal to itself.
    const retry = await reverse('t1', { id: 'member-1', type: 'member' })
    expect(retry.ok && retry.gate_receipt?.status).toBe('appended')
    const rev = receiptRows().find((r) => r.idempotency_key === `verdict-reversed:${out.verdict.id}`)
    expect(rev).toMatchObject({ actor_kind: 'agent', actor_id: 'agent-rev' })
    expect(JSON.parse(String(rev?.claims_json))).toMatchObject({ reversed_by: 'agent-rev', reversed_by_kind: 'agent' })
  })

  it('the sweep replays the reversal with the recorded actor kind (agent stays agent, member stays member)', async () => {
    for (const who of [{ id: 'agent-rev', type: 'agent' as const }, { id: 'member-7', type: 'member' as const }]) {
      harness.sqlite.close()
      harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      seedBase()
      env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
      await chainTask('t1')
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const out = await decide('t1')
      harness.sqlite.exec('ALTER TABLE execution_receipt_heads RENAME TO execution_receipt_heads_broken')
      await reverse('t1', who)
      harness.sqlite.exec('ALTER TABLE execution_receipt_heads_broken RENAME TO execution_receipt_heads')
      expect(await reconcileGateVerdictReceipts(env, { graceMs: 0 })).toMatchObject({ reversals_healed: 1, failed: 0 })
      const rev = receiptRows().find((r) => r.idempotency_key === `verdict-reversed:${out.verdict.id}`)
      expect(rev).toMatchObject({ actor_kind: who.type, actor_id: who.id })
    }
  })

  it('CAUSAL ORDER: verdict1\'s failed receipt is appended BEFORE verdict2\'s (verdict1 -> verdict2), healed by the next emit', async () => {
    await chainTask('t1')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    harness.sqlite.exec('ALTER TABLE execution_receipt_heads RENAME TO execution_receipt_heads_broken')
    const v1 = await decide('t1', 'rejected')
    expect(v1.gate_receipt?.status).toBe('failed')
    harness.sqlite.exec('ALTER TABLE execution_receipt_heads_broken RENAME TO execution_receipt_heads')
    setTaskState('t1', 'review', 'reworked') // rework back into review
    const v2 = await decide('t1', 'approved')
    expect(v2.gate_receipt?.status).toBe('appended')
    expect(receiptRows().map((r) => r.idempotency_key)).toEqual([`verdict:${v1.verdict.id}`, `verdict:${v2.verdict.id}`])
    expect(receiptRows()[1].predecessor_receipt_id).toBe(receiptRows()[0].id)
  })

  it('CAUSAL ORDER: if verdict1\'s receipt still cannot be appended, verdict2\'s is DEFERRED (owed), never appended out of order; the sweep then lands both in order', async () => {
    await chainTask('t1')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // A fault that rejects ONLY the rejected-verdict receipt (verdict1); an approved-verdict receipt would append fine on its own.
    harness.sqlite.exec(`CREATE TRIGGER test_fault_reject_receipt BEFORE INSERT ON execution_receipts
      WHEN json_extract(NEW.claims_json, '$.verdict') = 'rejected' BEGIN SELECT RAISE(ABORT, 'injected receipt fault'); END`)
    const v1 = await decide('t1', 'rejected')
    expect(v1.gate_receipt?.status).toBe('failed')
    setTaskState('t1', 'review', 'reworked')
    const v2 = await decide('t1', 'approved')
    expect(v2.gate_receipt).toMatchObject({ status: 'failed', error: 'older_receipt_owed' })
    expect(receiptRows()).toHaveLength(0) // v2 was NOT appended ahead of v1
    expect(verdictRows('t1')[1]).toMatchObject({ receipt_actor_kind: 'member' }) // still owed
    harness.sqlite.exec('DROP TRIGGER test_fault_reject_receipt')
    expect(await reconcileGateVerdictReceipts(env, { graceMs: 0 })).toEqual({ verdicts_healed: 2, reversals_healed: 0, failed: 0 })
    expect(receiptRows().map((r) => r.idempotency_key)).toEqual([`verdict:${v1.verdict.id}`, `verdict:${v2.verdict.id}`])
  })

  it('CAUSAL ORDER: a reversed older verdict\'s reversal receipt also precedes the newer verdict\'s receipt', async () => {
    await chainTask('t1')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const v1 = await decide('t1', 'approved')
    harness.sqlite.exec('ALTER TABLE execution_receipt_heads RENAME TO execution_receipt_heads_broken')
    await reverse('t1') // verdict1 reversed; the reversal receipt fails
    harness.sqlite.exec('ALTER TABLE execution_receipt_heads_broken RENAME TO execution_receipt_heads')
    const v2 = await decide('t1', 'approved')
    expect(v2.gate_receipt?.status).toBe('appended')
    expect(receiptRows().map((r) => r.idempotency_key)).toEqual([`verdict:${v1.verdict.id}`, `verdict-reversed:${v1.verdict.id}`, `verdict:${v2.verdict.id}`])
  })

  it('CAUSAL ORDER: several older owed receipts land oldest first (v1, v2, then v3)', async () => {
    await chainTask('t1')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    harness.sqlite.exec('ALTER TABLE execution_receipt_heads RENAME TO execution_receipt_heads_broken')
    const v1 = await decide('t1', 'rejected')
    setTaskState('t1', 'review', 'rework 1')
    const v2 = await decide('t1', 'rejected')
    setTaskState('t1', 'review', 'rework 2')
    harness.sqlite.exec('ALTER TABLE execution_receipt_heads_broken RENAME TO execution_receipt_heads')
    const v3 = await decide('t1', 'approved')
    expect(v3.gate_receipt?.status).toBe('appended')
    expect(receiptRows().map((r) => r.idempotency_key)).toEqual([`verdict:${v1.verdict.id}`, `verdict:${v2.verdict.id}`, `verdict:${v3.verdict.id}`])
  })

  it('CAUSAL ORDER: an older verdict whose REVERSAL receipt cannot be appended defers the newer verdict\'s receipt', async () => {
    await chainTask('t1')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const v1 = await decide('t1', 'approved')
    harness.sqlite.exec(`CREATE TRIGGER test_fault_reversal_receipt BEFORE INSERT ON execution_receipts
      WHEN json_extract(NEW.claims_json, '$.reversed') = 1 BEGIN SELECT RAISE(ABORT, 'injected reversal fault'); END`)
    const res = await reverse('t1')
    expect(res.ok && res.gate_receipt?.status).toBe('failed')
    const v2 = await decide('t1', 'approved')
    expect(v2.gate_receipt).toMatchObject({ status: 'failed', error: 'older_receipt_owed' })
    expect(receiptRows().map((r) => r.idempotency_key)).toEqual([`verdict:${v1.verdict.id}`]) // v2 not ahead of v1's reversal
    harness.sqlite.exec('DROP TRIGGER test_fault_reversal_receipt')
    expect(await reconcileGateVerdictReceipts(env, { graceMs: 0 })).toMatchObject({ failed: 0 })
    expect(receiptRows().map((r) => r.idempotency_key)).toEqual([`verdict:${v1.verdict.id}`, `verdict-reversed:${v1.verdict.id}`, `verdict:${v2.verdict.id}`])
  })

  it('MCP task_verdict_reverse records an AGENT-bound token as that agent (id and kind), on the row and the receipt', async () => {
    await chainTask('t1')
    const v1 = await decide('t1')
    const auth = {
      userId: 'member-1', email: null, role: 'owner', tenant: TENANT, memberId: 'member-1', boundAgentId: 'agent-rev',
      capabilities: [{ member_id: 'member-1', scope_type: 'squad', scope_id: 'squad-1', capability: 'member' }],
    } as unknown as Parameters<typeof invokeTool>[0]
    const res = await invokeTool(auth, env, 'task_verdict_reverse', { task_id: 't1', reason: 'approved in error' }, 'https://pot.test')
    if (!res.ok) throw new Error(JSON.stringify(res))
    expect(harness.sqlite.prepare('SELECT actor_id, actor_type FROM verdict_reversals').get()).toEqual({ actor_id: 'agent-rev', actor_type: 'agent' })
    expect(receiptRows().find((r) => r.idempotency_key === `verdict-reversed:${v1.verdict.id}`)).toMatchObject({ actor_kind: 'agent', actor_id: 'agent-rev' })
  })

  it('MCP task_verdict_reverse returns the reversal gate_receipt', async () => {
    await chainTask('t1')
    await decide('t1')
    const auth = {
      userId: 'member-1', email: null, role: 'owner', tenant: TENANT, memberId: 'member-1',
      capabilities: [{ member_id: 'member-1', scope_type: 'squad', scope_id: 'squad-1', capability: 'member' }],
    } as unknown as Parameters<typeof invokeTool>[0]
    const res = await invokeTool(auth, env, 'task_verdict_reverse', { task_id: 't1', reason: 'approved in error' }, 'https://pot.test')
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error(JSON.stringify(res))
    expect((res.result as { gate_receipt?: { status: string } }).gate_receipt?.status).toBe('appended')
    expect(receiptRows().map((r) => String(r.idempotency_key).split(':')[0])).toEqual(['verdict', 'verdict-reversed'])
  })

  /** A verdict row exactly as an ATTACHED-session writeVerdict leaves it: attribution columns set, receipt owed, status approved. */
  function seedAttachedSessionVerdict(taskId: string): string {
    harness.sqlite.prepare(
      `INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at, attachment_id, consenting_member_id, receipt_actor_kind)
       VALUES ('v-att', ?, 'approved', NULL, 'agent-att', '2026-10-22T04:00:00.000Z', 'att-1', 'member-consent', 'agent')`,
    ).run(taskId)
    setTaskState(taskId, 'approved', null)
    return 'v-att'
  }
  const attributionOf = (r: Record<string, unknown> | undefined) => {
    const c = JSON.parse(String(r?.claims_json)) as Record<string, unknown>
    return { attachment_id: c.attachment_id, consenting_member_id: c.consenting_member_id }
  }

  it('ATTACHED SESSION: original receipt append failed -> reversal replays the verdict receipt WITH attachment_id + consenting_member_id from the row', async () => {
    await chainTask('t1')
    const id = seedAttachedSessionVerdict('t1') // its receipt was never appended
    const res = await reverse('t1')
    expect(res.ok && res.gate_receipt?.status).toBe('appended')
    const rows = receiptRows()
    expect(rows.map((r) => r.idempotency_key)).toEqual([`verdict:${id}`, `verdict-reversed:${id}`])
    expect(attributionOf(rows[0])).toEqual({ attachment_id: 'att-1', consenting_member_id: 'member-consent' })
  })

  it('ATTACHED SESSION: when the full-attribution verdict receipt ALREADY exists, the reversal replay matches it (no idempotency conflict) and the reversal receipt is NOT deferred', async () => {
    await chainTask('t1')
    const id = seedAttachedSessionVerdict('t1')
    const row = harness.sqlite.prepare('SELECT * FROM task_verdicts WHERE id = ?').get(id) as unknown as Parameters<typeof emitGateVerdictReceipt>[1]
    expect((await emitGateVerdictReceipt(env, row))?.status).toBe('appended') // the original append, with attribution
    const res = await reverse('t1')
    expect(res.ok && res.gate_receipt?.status).toBe('appended')
    expect(receiptRows().map((r) => r.idempotency_key)).toEqual([`verdict:${id}`, `verdict-reversed:${id}`])
    expect(attributionOf(receiptRows()[0])).toEqual({ attachment_id: 'att-1', consenting_member_id: 'member-consent' })
  })

  it('a reversal of an out-of-scope verdict emits nothing', async () => {
    seedTask('plain')
    await decide('plain')
    await reverse('plain')
    expect(receiptRows()).toHaveLength(0)
  })

  it('an agent decider is recorded as an agent actor', async () => {
    await chainTask('t1')
    const out = await writeVerdict(env, { task: loadTask('t1'), verdict: 'rejected', note: 'no', decidedBy: 'agent-gate', expectedSubmissionId: null }, { kind: 'agent', id: 'agent-gate' })
    expect(out.task.status).toBe('rejected')
    expect(receiptRows()[0]).toMatchObject({ actor_kind: 'agent', actor_id: 'agent-gate' })
  })
})
