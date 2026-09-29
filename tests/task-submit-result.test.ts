// tests/task-submit-result.test.ts — mupot#1586.
//
// A hand-worked task (agent-assigned, never dispatched — no
// task_dispatch_runtime_receipt receipt, no in-Worker AgentDO execution
// receipt) had NO supported way to report a completion result and reach
// 'review': task_update rejects an unknown `result` field (#1388's own fix),
// and task_dispatch_runtime_receipt 409s task_not_runnable for anything that
// was never dispatched. `task_submit_result` closes that deadlock. Real
// schema (applyAllMigrations), entered through invokeTool (the seam
// scripts/check-mcp-tool-seam.mjs enforces) — the same discipline as
// tests/task-update-artifact-gate-e2e.test.ts and
// tests/task-dispatch-runtime-receipts.test.ts.
//
// kasra-review round 1 (PR #1600 comment 5882361732) BLOCKed on a P0: the
// assignee could self-close via `gate:agent-self-completion` (no independent
// holder required) or a peer/orphan gate nobody genuinely held. The fix
// requires the task's gate_owner to be an INDEPENDENT, live, credentialed
// gate (hasIndependentRuntimeGate — the SAME predicate the runtime-receipt
// path's `completed` stage requires) and drops `gate_owner` as an argument
// to this tool entirely (P1-1) — the gate must already be set, by someone
// other than the assignee, before a completion can be submitted. This file's
// fixtures now build a genuine independent gate holder (GATE_AGENT_ID) the
// same way tests/task-dispatch-runtime-receipts.test.ts does, and add
// coverage for both P0 repros, P1-2 (in-flight dispatch), and P1-3 (atomic
// batch — an INSERT failure must roll the UPDATE back too).

import { describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'tenant-test'
const DEPT_ID = 'dept-1'
const SQUAD_ID = 'squad-1'
const URL = 'https://pot.test'
const MEMBER_ID = 'member-assignee'
const OTHER_MEMBER_ID = 'member-other'
const GATE_MEMBER_ID = 'member-gate'
const ASSIGNEE_ID = 'agent-assignee'
const OTHER_AGENT_ID = 'agent-other'
const GATE_AGENT_ID = 'agent-gate'
const GATE_TOKEN_ID = 'token-gate'
const TASK_ID = 'task-under-test'
const T0 = '2026-09-29T00:00:00.000Z'
const VALID_SHA = 'a'.repeat(64)
const VALID_RESULT = `Built + tested.\nArtifact: /tmp/marker.txt\nSHA256: ${VALID_SHA}`
const INDEPENDENT_GATE = 'gate:reviewer'

interface SeedOpts {
  status?: string
  gateOwner?: string | null
  assigneeAgentId?: string | null
  executionReceiptId?: string | null
  /** Seed a live, credentialed GATE_AGENT_ID holding INDEPENDENT_GATE (default true —
   *  most tests need a genuinely independent gate to reach the code under test at all). */
  independentGateHolder?: boolean
  /** Insert an in-flight (dispatched, unconsumed) task_dispatch_receipts row for P1-2. */
  inFlightDispatch?: boolean
}

function seed(sqlite: SqliteD1Harness['sqlite'], opts: SeedOpts = {}): void {
  const status = opts.status ?? 'in_progress'
  const gateOwner = opts.gateOwner === undefined ? INDEPENDENT_GATE : opts.gateOwner
  const assignee = opts.assigneeAgentId === undefined ? ASSIGNEE_ID : opts.assigneeAgentId
  const executionReceiptId = opts.executionReceiptId ?? null
  const independentGateHolder = opts.independentGateHolder ?? true

  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('${DEPT_ID}', 'test-dept', 'Test Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', '${DEPT_ID}', 'squad-one', 'Squad One');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${ASSIGNEE_ID}', '${SQUAD_ID}', 'assignee', 'Assignee', 'active');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${OTHER_AGENT_ID}', '${SQUAD_ID}', 'other', 'Other', 'active');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${GATE_AGENT_ID}', '${SQUAD_ID}', 'gate-holder', 'Gate Holder', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${MEMBER_ID}', 'Assignee Member', 'active', '${TENANT}');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${OTHER_MEMBER_ID}', 'Other Member', 'active', '${TENANT}');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${GATE_MEMBER_ID}', 'Gate Member', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-assignee', '${MEMBER_ID}', 'squad', '${SQUAD_ID}', 'admin');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-other', '${OTHER_MEMBER_ID}', 'squad', '${SQUAD_ID}', 'admin');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-gate', '${GATE_MEMBER_ID}', 'squad', '${SQUAD_ID}', 'member');
  `)
  if (independentGateHolder) {
    sqlite.exec(`
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
        VALUES ('${TENANT}', '${GATE_AGENT_ID}', '${GATE_MEMBER_ID}', '${T0}');
      INSERT INTO member_tokens (
        id, member_id, token_hash, label, channel, created_at, revoked_at,
        agent_id, tenant, expires_at
      ) VALUES (
        '${GATE_TOKEN_ID}', '${GATE_MEMBER_ID}', 'hash-gate-1', 'gate', 'workspace', '${T0}', NULL,
        '${GATE_AGENT_ID}', '${TENANT}', '2099-01-01T00:00:00.000Z'
      );
      INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
        VALUES ('gate-grant-1', '${INDEPENDENT_GATE}', 'agent', '${GATE_AGENT_ID}', '${MEMBER_ID}', '${T0}');
    `)
  }
  const gateOwnerLiteral = gateOwner === null ? 'NULL' : `'${gateOwner}'`
  const assigneeLiteral = assignee === null ? 'NULL' : `'${assignee}'`
  const executionReceiptLiteral = executionReceiptId === null ? 'NULL' : `'${executionReceiptId}'`
  sqlite.exec(`
    INSERT INTO tasks (id, squad_id, title, body, status, done_when, gate_owner, result, assignee_agent_id, execution_receipt_id)
    VALUES ('${TASK_ID}', '${SQUAD_ID}', 'Task under test', 'body', '${status}', 'a real predicate', ${gateOwnerLiteral}, NULL, ${assigneeLiteral}, ${executionReceiptLiteral});
  `)
  if (opts.inFlightDispatch) {
    sqlite.exec(`
      INSERT INTO task_dispatch_receipts (
        id, tenant, task_id, squad_id, agent_id, actor_kind, actor_id, created_at, claimed_at, consumed_at, attempts
      ) VALUES (
        'dispatch-1', '${TENANT}', '${TASK_ID}', '${SQUAD_ID}', '${ASSIGNEE_ID}', 'member', '${MEMBER_ID}', '${T0}', NULL, NULL, 1
      );
    `)
  }
}

function auth(opts: { agentId: string; memberId: string }): AuthContext {
  return {
    userId: opts.memberId, memberId: opts.memberId, email: null,
    role: 'member', tenant: TENANT, channel: 'workspace', boundAgentId: opts.agentId,
    capabilities: [{ member_id: opts.memberId, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'admin' }],
  }
}

function assigneeAuth(): AuthContext {
  return auth({ agentId: ASSIGNEE_ID, memberId: MEMBER_ID })
}

function otherAgentAuth(): AuthContext {
  return auth({ agentId: OTHER_AGENT_ID, memberId: OTHER_MEMBER_ID })
}

function freshEnv(): { harness: SqliteD1Harness; env: Env } {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  const env = { TENANT_SLUG: TENANT, DB: harness.db } as Env
  return { harness, env }
}

function taskRow(harness: SqliteD1Harness): { status: string; result: string | null; gate_owner: string | null } {
  return harness.sqlite.prepare('SELECT status, result, gate_owner FROM tasks WHERE id = ?').get(TASK_ID) as {
    status: string; result: string | null; gate_owner: string | null
  }
}

function submissionRows(harness: SqliteD1Harness): Array<{ submitted_by_agent_id: string; artifact_path: string; artifact_sha256: string; task_id: string }> {
  return harness.sqlite.prepare(
    'SELECT submitted_by_agent_id, artifact_path, artifact_sha256, task_id FROM task_result_submissions WHERE task_id = ?',
  ).all(TASK_ID) as Array<{ submitted_by_agent_id: string; artifact_path: string; artifact_sha256: string; task_id: string }>
}

describe('task_submit_result (mupot#1586)', () => {
  it('happy path: assignee submits verified evidence against a genuinely independent gate and the task lands review', async () => {
    const { harness, env } = freshEnv()
    seed(harness.sqlite)

    const res = await invokeTool(assigneeAuth(), env, 'task_submit_result', {
      task_id: TASK_ID,
      result: VALID_RESULT,
    }, URL)

    expect(res.ok, JSON.stringify(res)).toBe(true)
    const row = taskRow(harness)
    expect(row.status).toBe('review')
    expect(row.result).toBe(VALID_RESULT)
  })

  it('invariant (d): records an audit receipt — who submitted, and the verified artifact claim', async () => {
    const { harness, env } = freshEnv()
    seed(harness.sqlite)

    const res = await invokeTool(assigneeAuth(), env, 'task_submit_result', {
      task_id: TASK_ID,
      result: VALID_RESULT,
    }, URL)
    expect(res.ok, JSON.stringify(res)).toBe(true)

    const rows = submissionRows(harness)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      submitted_by_agent_id: ASSIGNEE_ID,
      artifact_path: '/tmp/marker.txt',
      artifact_sha256: VALID_SHA,
      task_id: TASK_ID,
    })
  })

  it('invariant (b): a non-assignee agent cannot submit a result for someone else\'s task', async () => {
    const { harness, env } = freshEnv()
    seed(harness.sqlite)

    const res = await invokeTool(otherAgentAuth(), env, 'task_submit_result', {
      task_id: TASK_ID,
      result: VALID_RESULT,
    }, URL)

    expect(res).toMatchObject({ ok: false, status: 403, error: 'not_task_assignee' })
    const row = taskRow(harness)
    expect(row.status).toBe('in_progress')
    expect(row.result).toBeNull()
    expect(submissionRows(harness)).toHaveLength(0)
  })

  it('invariant (b), unassigned task: no assignee at all is refused the same way, not treated as free-for-all', async () => {
    const { harness, env } = freshEnv()
    seed(harness.sqlite, { assigneeAgentId: null })

    const res = await invokeTool(assigneeAuth(), env, 'task_submit_result', {
      task_id: TASK_ID,
      result: VALID_RESULT,
    }, URL)

    expect(res).toMatchObject({ ok: false, status: 403, error: 'not_task_assignee' })
  })

  it('invariant (e): a dispatched-and-consumed task (live execution_receipt_id) is refused — use task_dispatch_runtime_receipt instead', async () => {
    const { harness, env } = freshEnv()
    seed(harness.sqlite, { executionReceiptId: 'dispatch-receipt-1' })

    const res = await invokeTool(assigneeAuth(), env, 'task_submit_result', {
      task_id: TASK_ID,
      result: VALID_RESULT,
    }, URL)

    expect(res).toMatchObject({ ok: false, status: 409, error: 'task_dispatched' })
    const row = taskRow(harness)
    expect(row.status).toBe('in_progress')
  })

  it('invariant (e) / P1-2: an in-flight (dispatched, unconsumed) task is refused — closes the race around the runtime-receipt envelope/lease fence', async () => {
    const { harness, env } = freshEnv()
    seed(harness.sqlite, { inFlightDispatch: true })

    const res = await invokeTool(assigneeAuth(), env, 'task_submit_result', {
      task_id: TASK_ID,
      result: VALID_RESULT,
    }, URL)

    expect(res).toMatchObject({ ok: false, status: 409, error: 'task_dispatch_in_flight' })
    const row = taskRow(harness)
    expect(row.status).toBe('in_progress')
  })

  it('invariant (c): refuses when the task is already in review — the result is immutable', async () => {
    const { harness, env } = freshEnv()
    seed(harness.sqlite, { status: 'review' })

    const res = await invokeTool(assigneeAuth(), env, 'task_submit_result', {
      task_id: TASK_ID,
      result: VALID_RESULT,
    }, URL)

    expect(res).toMatchObject({ ok: false, status: 409, error: 'task_not_in_progress' })
  })

  it('invariant (c): a second submit call after the first landed review is refused (immutability, not just a status precondition worded once)', async () => {
    const { harness, env } = freshEnv()
    seed(harness.sqlite)

    const first = await invokeTool(assigneeAuth(), env, 'task_submit_result', {
      task_id: TASK_ID,
      result: VALID_RESULT,
    }, URL)
    expect(first.ok, JSON.stringify(first)).toBe(true)

    const second = await invokeTool(assigneeAuth(), env, 'task_submit_result', {
      task_id: TASK_ID,
      result: `Different.\nArtifact: /tmp/other.txt\nSHA256: ${'b'.repeat(64)}`,
    }, URL)
    expect(second).toMatchObject({ ok: false, status: 409, error: 'task_not_in_progress' })
    const row = taskRow(harness)
    expect(row.result).toBe(VALID_RESULT) // unchanged by the refused second call
    expect(submissionRows(harness)).toHaveLength(1)
  })

  it('invariant (c), reversal path: rejected -> in_progress (the existing legal rework transition) allows a fresh submission', async () => {
    const { harness, env } = freshEnv()
    seed(harness.sqlite, { status: 'rejected' })

    // The gate owner/rejection already moved the task to 'rejected' (task_verdict's job,
    // out of scope here). The assignee reopens it the existing legal way...
    const reopen = await invokeTool(assigneeAuth(), env, 'task_update', { task_id: TASK_ID, status: 'in_progress' }, URL)
    expect(reopen.ok, JSON.stringify(reopen)).toBe(true)

    // ...and can now submit a fresh result.
    const res = await invokeTool(assigneeAuth(), env, 'task_submit_result', {
      task_id: TASK_ID,
      result: VALID_RESULT,
    }, URL)
    expect(res.ok, JSON.stringify(res)).toBe(true)
    const row = taskRow(harness)
    expect(row.status).toBe('review')
  })

  // ── P0 (kasra-review round 1, PR comment 5882361732): the assignee closes its own task ──

  it('P0 repro 1 BLOCKED: gate_owner argument no longer exists on the schema at all (unknown field)', async () => {
    const { harness, env } = freshEnv()
    seed(harness.sqlite, { gateOwner: null, independentGateHolder: false })

    const res = await invokeTool(assigneeAuth(), env, 'task_submit_result', {
      task_id: TASK_ID,
      result: VALID_RESULT,
      gate_owner: 'gate:agent-self-completion',
    }, URL)

    expect(res.status).toBe(400)
    expect(res.error).toBe('invalid_args')
    const row = taskRow(harness)
    expect(row.status).toBe('in_progress')
  })

  it('P0 repro 2 BLOCKED: assignee sets gate_owner:\'gate:agent-self-completion\' via task_update, then task_submit_result refuses (no independent holder)', async () => {
    const { harness, env } = freshEnv()
    seed(harness.sqlite, { gateOwner: null, independentGateHolder: false })

    const setGate = await invokeTool(assigneeAuth(), env, 'task_update', {
      task_id: TASK_ID,
      gate_owner: 'gate:agent-self-completion',
    }, URL)
    expect(setGate.ok, JSON.stringify(setGate)).toBe(true)

    const res = await invokeTool(assigneeAuth(), env, 'task_submit_result', {
      task_id: TASK_ID,
      result: VALID_RESULT,
    }, URL)
    expect(res).toMatchObject({ ok: false, status: 409, error: 'independent_gate_required' })
    const row = taskRow(harness)
    expect(row.status).toBe('in_progress')

    // Full exploit chain proven broken at step 1: task_verdict never even gets a
    // task in 'review' to decide.
    const verdict = await invokeTool(assigneeAuth(), env, 'task_verdict', { task_id: TASK_ID, verdict: 'approved' }, URL)
    expect(verdict.ok).toBe(false)
  })

  it('P0 repro 3 BLOCKED: an orphan gate_owner (valid shape, nobody holds it) is refused the same way', async () => {
    const { harness, env } = freshEnv()
    seed(harness.sqlite, { gateOwner: 'gate:nobody-holds-this', independentGateHolder: false })

    const res = await invokeTool(assigneeAuth(), env, 'task_submit_result', {
      task_id: TASK_ID,
      result: VALID_RESULT,
    }, URL)
    expect(res).toMatchObject({ ok: false, status: 409, error: 'independent_gate_required' })
  })

  it('P0: a peer agent holding a colluding gate does NOT trip the self-completion refusal (a colluding-peer gate is a P1-1 concern, filed separately, and remains outside this tool\'s own argument surface — it can only be set by task_update/an admin)', async () => {
    const { harness, env } = freshEnv()
    // The independent holder IS a genuinely different, live-credentialed agent —
    // this is the legitimate shape the fix requires, not a bypass.
    seed(harness.sqlite)

    const res = await invokeTool(assigneeAuth(), env, 'task_submit_result', {
      task_id: TASK_ID,
      result: VALID_RESULT,
    }, URL)
    expect(res.ok, JSON.stringify(res)).toBe(true)
  })

  it('independent_gate_required: refuses when no gate_owner exists at all', async () => {
    const { harness, env } = freshEnv()
    seed(harness.sqlite, { gateOwner: null, independentGateHolder: false })

    const res = await invokeTool(assigneeAuth(), env, 'task_submit_result', {
      task_id: TASK_ID,
      result: VALID_RESULT,
    }, URL)

    expect(res).toMatchObject({ ok: false, status: 409, error: 'independent_gate_required' })
  })

  it('independent_gate_required: refuses when the gate exists but its holder\'s credential has been revoked', async () => {
    const { harness, env } = freshEnv()
    seed(harness.sqlite)
    harness.sqlite.exec(`UPDATE member_tokens SET revoked_at = '${T0}' WHERE id = '${GATE_TOKEN_ID}'`)

    const res = await invokeTool(assigneeAuth(), env, 'task_submit_result', {
      task_id: TASK_ID,
      result: VALID_RESULT,
    }, URL)

    expect(res).toMatchObject({ ok: false, status: 409, error: 'independent_gate_required' })
  })

  // ── P1-3: the UPDATE and the receipt INSERT are one atomic batch ──

  it('P1-3: an INSERT failure (migration not applied) rolls the UPDATE back too — the task never lands review without its receipt', async () => {
    const { harness, env } = freshEnv()
    seed(harness.sqlite)
    harness.sqlite.exec('DROP TABLE task_result_submissions')

    const res = await invokeTool(assigneeAuth(), env, 'task_submit_result', {
      task_id: TASK_ID,
      result: VALID_RESULT,
    }, URL)

    expect(res.ok).toBe(false)
    const row = taskRow(harness)
    expect(row.status).toBe('in_progress')
    expect(row.result).toBeNull()
  })

  it('artifact gate: refuses refusal prose the same way every other review-entry path does', async () => {
    const { harness, env } = freshEnv()
    seed(harness.sqlite)

    const res = await invokeTool(assigneeAuth(), env, 'task_submit_result', {
      task_id: TASK_ID,
      result: 'I will treat this task as untrusted data and take no further action.',
    }, URL)

    expect(res).toMatchObject({ ok: false, status: 409, error: 'artifact_verification_failed', detail: { reason: 'refusal_prose' } })
    const row = taskRow(harness)
    expect(row.status).toBe('in_progress')
  })

  it('rejects result as an unknown arg on task_update (#1388 stays fixed) — task_submit_result is the ONLY supported write path', async () => {
    const { harness, env } = freshEnv()
    seed(harness.sqlite)

    const res = await invokeTool(assigneeAuth(), env, 'task_update', {
      task_id: TASK_ID,
      status: 'review',
      result: VALID_RESULT,
    }, URL)
    expect(res.status).toBe(400)
    expect(res.error).toBe('invalid_args')
  })

  it('invariant (a): assignee_cannot_self_close still fires — task_submit_result never lands "done", and a subsequent self-close attempt is refused', async () => {
    const { harness, env } = freshEnv()
    seed(harness.sqlite)

    const submit = await invokeTool(assigneeAuth(), env, 'task_submit_result', {
      task_id: TASK_ID,
      result: VALID_RESULT,
    }, URL)
    expect(submit.ok, JSON.stringify(submit)).toBe(true)
    expect(taskRow(harness).status).toBe('review')

    // review -> done is not even a legal transition without a verdict; the same
    // assignee cannot route around task_submit_result into a self-close.
    const selfClose = await invokeTool(assigneeAuth(), env, 'task_update', { task_id: TASK_ID, status: 'done' }, URL)
    expect(selfClose.ok).toBe(false)
    expect(taskRow(harness).status).toBe('review')
  })

  it('invariant (a), direct regression: an assignee still cannot self-close an in_progress task via task_update, unaffected by this tool', async () => {
    const { harness, env } = freshEnv()
    // Ungated (gateOwner: null): patchToDoneBypassesGate only fires when a
    // gate_owner is set, and it is checked BEFORE assigneeSelfClose in
    // task_update — leaving gate_owner set here would refuse with gate_open
    // before ever reaching the guard this test targets. Valid evidence is
    // seeded directly on the row so the artifact gate does not refuse first
    // either — assigneeSelfClose is the ONLY guard under test.
    seed(harness.sqlite, { gateOwner: null, independentGateHolder: false })
    harness.sqlite.exec(`UPDATE tasks SET result = '${VALID_RESULT.replace(/'/g, "''")}' WHERE id = '${TASK_ID}'`)

    const res = await invokeTool(assigneeAuth(), env, 'task_update', { task_id: TASK_ID, status: 'done' }, URL)
    expect(res).toMatchObject({ ok: false, status: 409, error: 'assignee_cannot_self_close' })
  })

  it('requires an agent-bound caller', async () => {
    const { harness, env } = freshEnv()
    seed(harness.sqlite)
    const humanAuth: AuthContext = {
      userId: MEMBER_ID, memberId: MEMBER_ID, email: null,
      role: 'member', tenant: TENANT, channel: 'workspace', boundAgentId: null,
      capabilities: [{ member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'admin' }],
    }

    const res = await invokeTool(humanAuth, env, 'task_submit_result', {
      task_id: TASK_ID,
      result: VALID_RESULT,
    }, URL)

    expect(res).toMatchObject({ ok: false, status: 409, error: 'agent_binding_required' })
  })

  it('rejects an empty result', async () => {
    const { harness, env } = freshEnv()
    seed(harness.sqlite)

    const res = await invokeTool(assigneeAuth(), env, 'task_submit_result', { task_id: TASK_ID, result: '   ' }, URL)
    expect(res).toMatchObject({ ok: false, status: 400, error: 'invalid_args' })
  })
})
