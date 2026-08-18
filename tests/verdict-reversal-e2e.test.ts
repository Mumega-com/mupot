// tests/verdict-reversal-e2e.test.ts — mupot#1181, assigned via mupot task
// 67fcf7dc / dara-assign-kasra-1181-20260818.
//
// WHY THIS TEST DOES NOT MOCK
//
// The done_when for this work is explicit: "A deliberately mis-verdicted
// throwaway task is returned to review and re-verdicted end to end, by a
// principal who is NOT the original decider — demonstrated, not described."
// A JS mock of D1.prepare().bind().run() can be made to say anything; it cannot
// demonstrate that the REAL conditional UPDATE in writeVerdict (status='review'
// guard) and the REAL conditional UPDATE in task_verdict_reversal (status
// matches what was just read) actually interoperate against the production
// schema. Only running both tools against real SQLite, built from the actual
// migrations, proves that.
//
// Precedent: tests/grant-agent-capability-real-schema.test.ts (mupot#685) — same
// shape, same reason (a mocked DB validates assumptions about columns, not the
// schema itself).

import { beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'tenant-test'
const DEPT_ID = 'dept-1'
const SQUAD_ID = 'squad-1'
const URL = 'https://pot.test'

// Original decider — the principal whose verdict gets reversed.
const ORIGINAL_DECIDER_MEMBER = 'member-original-decider'
const ORIGINAL_DECIDER_AGENT = 'agent-original-decider'

// The gate capability the task carries — held by the original decider only.
const GATE_CAPABILITY = 'gate:original-decider'

// The reversing/re-verdicting principal — deliberately a DIFFERENT one, per the
// done_when. Org owner/admin (required for the reversal), and ALSO holds the
// gate capability so the demonstration can complete a real second verdict.
const REVIEWER_MEMBER = 'member-reviewer'
const REVIEWER_AGENT = 'agent-reviewer'

const TASK_ID = 'task-mis-verdicted'

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('${DEPT_ID}', 'test-dept', 'Test Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', '${DEPT_ID}', 'squad-one', 'Squad One');

    INSERT INTO agents (id, squad_id, slug, name, status)
    VALUES
      ('${ORIGINAL_DECIDER_AGENT}', '${SQUAD_ID}', 'original-decider', 'Original Decider', 'active'),
      ('${REVIEWER_AGENT}', '${SQUAD_ID}', 'reviewer', 'Reviewer', 'active');

    INSERT INTO members (id, display_name, status, tenant)
    VALUES
      ('${ORIGINAL_DECIDER_MEMBER}', 'Original Decider', 'active', '${TENANT}'),
      ('${REVIEWER_MEMBER}', 'Reviewer', 'active', '${TENANT}');

    -- Both hold member+ on the squad (base floor for task_verdict / reversal).
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
    VALUES
      ('cap-decider-squad', '${ORIGINAL_DECIDER_MEMBER}', 'squad', '${SQUAD_ID}', 'member'),
      ('cap-reviewer-squad', '${REVIEWER_MEMBER}', 'squad', '${SQUAD_ID}', 'member'),
      -- Reviewer is the org owner/admin who performs the reversal.
      ('cap-reviewer-org-admin', '${REVIEWER_MEMBER}', 'org', NULL, 'admin');

    -- Both hold the named gate capability, so a REAL callerHoldsGateCapability
    -- check passes for the original verdict AND the demonstration re-verdict.
    INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
    VALUES
      ('grant-decider', '${GATE_CAPABILITY}', 'agent', '${ORIGINAL_DECIDER_AGENT}', 'system:test', '2026-08-18T00:00:00Z'),
      ('grant-reviewer', '${GATE_CAPABILITY}', 'agent', '${REVIEWER_AGENT}', 'system:test', '2026-08-18T00:00:00Z');

    -- The task, already in 'review' so the ORIGINAL verdict can be written for real.
    INSERT INTO tasks (id, squad_id, title, body, status, done_when, gate_owner)
    VALUES ('${TASK_ID}', '${SQUAD_ID}', 'Mis-verdicted task', 'body', 'review', 'done_when', '${GATE_CAPABILITY}');
  `)
}

function deciderAuth(): AuthContext {
  return {
    userId: ORIGINAL_DECIDER_MEMBER, memberId: ORIGINAL_DECIDER_MEMBER, email: null,
    role: 'member', tenant: TENANT, channel: 'workspace', boundAgentId: ORIGINAL_DECIDER_AGENT,
    capabilities: [{ member_id: ORIGINAL_DECIDER_MEMBER, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' }],
  }
}

function reviewerAuth(): AuthContext {
  return {
    userId: REVIEWER_MEMBER, memberId: REVIEWER_MEMBER, email: null,
    role: 'member', tenant: TENANT, channel: 'workspace', boundAgentId: REVIEWER_AGENT,
    capabilities: [
      { member_id: REVIEWER_MEMBER, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' },
      { member_id: REVIEWER_MEMBER, scope_type: 'org', scope_id: null, capability: 'admin' },
    ],
  }
}

let harness: SqliteD1Harness
let env: Env

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  seed(harness.sqlite)
  env = { TENANT_SLUG: TENANT, DB: harness.db } as Env
})

describe('verdict reversal — end to end against real schema (mupot#1181)', () => {
  it('THE DEMONSTRATION: mis-verdict, reverse by a DIFFERENT principal, re-verdict for real — both audit rows survive', async () => {
    // 1. The ORIGINAL, wrong verdict. Real task_verdict call, real principal.
    const originalVerdict = await invokeTool(
      deciderAuth(), env, 'task_verdict',
      { task_id: TASK_ID, verdict: 'approved', note: 'looks fine to me (this is the mistake)' },
      URL,
    )
    expect(originalVerdict.ok, JSON.stringify(originalVerdict)).toBe(true)
    expect((originalVerdict as { result: { task: { status: string } } }).result.task.status).toBe('approved')

    // 2. Before reversal: task_verdict itself REFUSES on an approved task — this
    // is the exact gap #1181 exists to close. Confirm it is real, not assumed.
    const reVerdictBlocked = await invokeTool(
      reviewerAuth(), env, 'task_verdict', { task_id: TASK_ID, verdict: 'rejected' }, URL,
    )
    expect(reVerdictBlocked).toMatchObject({ ok: false, status: 409, error: 'not_in_review' })

    // 3. THE REVERSAL — by the REVIEWER, who is NOT the original decider.
    const reversal = await invokeTool(
      reviewerAuth(), env, 'task_verdict_reversal',
      { task_id: TASK_ID, reason: 'evidence supporting this approval was later found contaminated' },
      URL,
    )
    expect(reversal.ok, JSON.stringify(reversal)).toBe(true)
    const reopened = (reversal as { result: { task: { status: string; result: unknown } } }).result.task
    expect(reopened.status).toBe('review')

    // 4. The prior decision is preserved BEFORE the next verdict overwrites the
    // live row — read directly from the real table, not from the tool response.
    const priorReceipt = harness.sqlite
      .prepare('SELECT * FROM verdict_reversals WHERE task_id = ?')
      .get(TASK_ID) as Record<string, unknown>
    expect(priorReceipt).toBeTruthy()
    expect(priorReceipt.from_status).toBe('approved')
    expect(priorReceipt.prior_decided_by).toBe(ORIGINAL_DECIDER_AGENT)
    expect(priorReceipt.prior_note).toBe('looks fine to me (this is the mistake)')
    expect(priorReceipt.reason).toBe('evidence supporting this approval was later found contaminated')
    // verdictPrincipal resolves to the BOUND AGENT when one is present — the
    // same convention task_verdict itself uses for self-verdict prevention.
    expect(priorReceipt.actor_id).toBe(REVIEWER_AGENT)

    // 5. THE RE-VERDICT — real task_verdict, unchanged, run by the reviewer
    // (a DIFFERENT principal from the one whose verdict was reversed).
    const finalVerdict = await invokeTool(
      reviewerAuth(), env, 'task_verdict',
      { task_id: TASK_ID, verdict: 'rejected', note: 'corrected: evidence was contaminated' },
      URL,
    )
    expect(finalVerdict.ok, JSON.stringify(finalVerdict)).toBe(true)
    expect((finalVerdict as { result: { task: { status: string } } }).result.task.status).toBe('rejected')

    // 6. BOTH audit rows survive afterward — the reversal receipt AND the
    // original task_verdicts row are not touched by the new verdict; a THIRD
    // row is appended, not a rewrite of the first.
    const allVerdicts = harness.sqlite
      .prepare('SELECT verdict, decided_by, note FROM task_verdicts WHERE task_id = ? ORDER BY decided_at ASC')
      .all(TASK_ID) as Array<{ verdict: string; decided_by: string; note: string | null }>
    expect(allVerdicts).toHaveLength(2)
    expect(allVerdicts[0]).toMatchObject({ verdict: 'approved', decided_by: ORIGINAL_DECIDER_AGENT })
    expect(allVerdicts[1]).toMatchObject({ verdict: 'rejected', decided_by: REVIEWER_AGENT })

    const reversalCount = harness.sqlite
      .prepare('SELECT COUNT(*) AS n FROM verdict_reversals WHERE task_id = ?')
      .get(TASK_ID) as { n: number }
    expect(reversalCount.n).toBe(1)
  })

  it('the original decider CANNOT reverse their own verdict merely by holding the gate', async () => {
    const approve = await invokeTool(deciderAuth(), env, 'task_verdict', { task_id: TASK_ID, verdict: 'approved' }, URL)
    expect(approve.ok).toBe(true)

    // Decider has NO org-level capability — squad member is not enough.
    const attempt = await invokeTool(
      deciderAuth(), env, 'task_verdict_reversal',
      { task_id: TASK_ID, reason: 'I changed my mind' },
      URL,
    )
    expect(attempt).toMatchObject({ ok: false, status: 403, error: 'forbidden' })

    const stillApproved = harness.sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get(TASK_ID) as { status: string }
    expect(stillApproved.status).toBe('approved')
  })

  it('a plain squad member (not org owner/admin) cannot reverse, even with a reason', async () => {
    const approve = await invokeTool(deciderAuth(), env, 'task_verdict', { task_id: TASK_ID, verdict: 'approved' }, URL)
    expect(approve.ok).toBe(true)

    const plainMember: AuthContext = {
      userId: 'member-bystander', memberId: 'member-bystander', email: null,
      role: 'member', tenant: TENANT, channel: 'workspace', boundAgentId: null,
      capabilities: [{ member_id: 'member-bystander', scope_type: 'squad', scope_id: SQUAD_ID, capability: 'admin' }],
    }
    // Squad admin, deliberately NOT org admin — the reversal must require the
    // wider grant, matching #1180's gate_owner_immutable precedent.
    const attempt = await invokeTool(plainMember, env, 'task_verdict_reversal', { task_id: TASK_ID, reason: 'because' }, URL)
    expect(attempt).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
  })

  it('refuses a missing or blank reason', async () => {
    const approve = await invokeTool(deciderAuth(), env, 'task_verdict', { task_id: TASK_ID, verdict: 'approved' }, URL)
    expect(approve.ok).toBe(true)

    const noReason = await invokeTool(reviewerAuth(), env, 'task_verdict_reversal', { task_id: TASK_ID, reason: '' }, URL)
    expect(noReason).toMatchObject({ ok: false, status: 400, error: 'reason_required' })

    const wsReason = await invokeTool(reviewerAuth(), env, 'task_verdict_reversal', { task_id: TASK_ID, reason: '   ' }, URL)
    expect(wsReason).toMatchObject({ ok: false, status: 400, error: 'reason_required' })

    const still = harness.sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get(TASK_ID) as { status: string }
    expect(still.status).toBe('approved')
  })

  it('refuses a task with no verdict to reverse — review, open, and done are not reversible', async () => {
    for (const status of ['review', 'open', 'done'] as const) {
      harness.sqlite.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, TASK_ID)
      const attempt = await invokeTool(reviewerAuth(), env, 'task_verdict_reversal', { task_id: TASK_ID, reason: 'because' }, URL)
      expect(attempt, `status ${status} must be refused`).toMatchObject({ ok: false, status: 409, error: 'not_reversible' })
    }
  })

  it('THE RACE: a status change between read and write is NOT silently overwritten', async () => {
    // None of the tests above create a genuine read-then-write gap — calling
    // the tool twice is already blocked by the earlier not_reversible check
    // regardless of the UPDATE's WHERE-status guard, so a naive "call it twice"
    // test cannot distinguish "the guard works" from "the guard is gone entirely"
    // (confirmed: mutating away the WHERE status=?3 clause left the other 13
    // tests fully green). This test creates the actual TOCTOU window by
    // intercepting the specific reversal UPDATE and racing a concurrent status
    // change underneath it, mirroring writeVerdict's own K5 conditional-UPDATE
    // pattern that this guard was built to match.
    const approve = await invokeTool(deciderAuth(), env, 'task_verdict', { task_id: TASK_ID, verdict: 'approved' }, URL)
    expect(approve.ok).toBe(true)

    const REVERSAL_UPDATE_MARKER = "UPDATE tasks SET status = 'review'"
    const realPrepare = harness.db.prepare.bind(harness.db)
    const racyDb = {
      ...harness.db,
      prepare(sql: string) {
        const stmt = realPrepare(sql)
        if (!sql.includes(REVERSAL_UPDATE_MARKER)) return stmt
        // Wrap ONLY the reversal's own UPDATE. Immediately before it executes,
        // a concurrent actor moves the task to 'done' — simulating a second
        // writer that won the race between task_verdict_reversal's read and
        // its write.
        return {
          ...stmt,
          bind(...args: unknown[]) {
            const bound = stmt.bind(...args)
            return {
              ...bound,
              async run() {
                harness.sqlite.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(TASK_ID)
                return bound.run()
              },
            }
          },
        }
      },
    }
    const racyEnv = { ...env, DB: racyDb } as unknown as Env

    const raced = await invokeTool(reviewerAuth(), racyEnv, 'task_verdict_reversal', { task_id: TASK_ID, reason: 'racing' }, URL)

    // The guard must catch this: the row moved to 'done' between the read and
    // the write, so the conditional UPDATE (WHERE status = 'approved') matches
    // zero rows and the tool must report the race rather than silently forcing
    // status back to 'review' over top of the concurrent 'done'.
    expect(raced).toMatchObject({ ok: false, status: 409, error: 'verdict_race' })
    const finalStatus = harness.sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get(TASK_ID) as { status: string }
    expect(finalStatus.status, 'the concurrent writer\'s status must survive, not be overwritten').toBe('done')
    // No reversal receipt for a reversal that never actually applied.
    const receiptCount = harness.sqlite.prepare('SELECT COUNT(*) AS n FROM verdict_reversals').get() as { n: number }
    expect(receiptCount.n).toBe(0)
  })

  it('a task with NO prior verdict row reverses cleanly with null prior fields, not a crash', async () => {
    // Edge case: status forced to 'approved' directly (e.g. a legacy row), with
    // no task_verdicts entry at all. The reversal must not assume one exists.
    harness.sqlite.prepare("UPDATE tasks SET status = 'approved' WHERE id = ?").run(TASK_ID)
    const reversal = await invokeTool(reviewerAuth(), env, 'task_verdict_reversal', { task_id: TASK_ID, reason: 'legacy row, no verdict on record' }, URL)
    expect(reversal.ok, JSON.stringify(reversal)).toBe(true)

    const receipt = harness.sqlite.prepare('SELECT prior_decided_by, prior_note FROM verdict_reversals WHERE task_id = ?').get(TASK_ID) as Record<string, unknown>
    expect(receipt.prior_decided_by).toBeNull()
    expect(receipt.prior_note).toBeNull()
  })
})
