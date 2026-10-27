// tests/im-verdict-gates.test.ts — mupot#1080/#1081.
//
// verdictReply (src/im/index.ts) was the THIRD write path onto writeVerdict —
// HTTP POST /:id/verdict and MCP task_verdict both already routed through the
// shared evaluateVerdictGates; IM hand-rolled its own gate-ownership +
// surface-cap logic instead, with NO special case for
// gate:agent-self-completion (BLOCK-1: closeable only by the completing
// agent or org owner/admin — the grant is NOT authority for this gate).
//
// THE EXPLOIT this closes: gate:agent-self-completion is never auto-granted
// (src/members/service.ts:502, deliberate), but nothing on the grant
// management route (POST /api/gates/grants) excludes it — GATE_CAPABILITY_RE
// (src/gates/grants.ts) matches it like any other gate:* string. Before this
// fix, a member holding a (mis-)granted gate:agent-self-completion capability
// could approve/reject ANY such task via Telegram, including one assigned to
// an agent they do not own — the BLOCK-1 exploit shape, reproduced through a
// member-type grant instead of the original agent-type one. This file proves
// the exploit is closed by routing verdictReply through evaluateVerdictGates.
//
// Real SQLite via applyAllMigrations — no hand-rolled prepare().

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { handleImMessage } from '../src/im'

const TENANT = 'im-verdict-gates-test'

function envFor(harness: SqliteD1Harness): Env {
  return {
    TENANT_SLUG: TENANT,
    DB: harness.db,
    BUS: { send: async () => {} },
  } as unknown as Env
}

function seedBase(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.prepare(`INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept-1', 'Dept One')`).run()
  sqlite
    .prepare(`INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'squad-1', 'Squad One')`)
    .run()
}

function seedMember(sqlite: SqliteD1Harness['sqlite'], id: string, chatId: string): void {
  sqlite
    .prepare(`INSERT INTO members (id, email, display_name, telegram_chat_id, status, tenant) VALUES (?, ?, ?, ?, 'active', ?)`)
    .run(id, `${id}@test.com`, id, chatId, TENANT)
}

function seedSquadMemberCapability(sqlite: SqliteD1Harness['sqlite'], memberId: string): void {
  sqlite
    .prepare(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?, ?, 'squad', 'squad-1', 'member')`)
    .run(`cap-${memberId}`, memberId)
}

function seedOrgAdminCapability(sqlite: SqliteD1Harness['sqlite'], memberId: string): void {
  sqlite
    .prepare(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?, ?, 'org', NULL, 'admin')`)
    .run(`cap-org-admin-${memberId}`, memberId)
}

function seedAgent(sqlite: SqliteD1Harness['sqlite'], id: string): void {
  sqlite
    .prepare(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES (?, 'squad-1', ?, ?, 'member', 'test', 'active')`)
    .run(id, id, id)
}

function seedReviewTask(sqlite: SqliteD1Harness['sqlite'], id: string, gateOwner: string, assigneeAgentId: string | null): void {
  sqlite
    .prepare(
      `INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, assignee_agent_id, result, created_at, updated_at)
       VALUES (?, 'squad-1', 'T', 'body', 'done', 'review', ?, ?, NULL, datetime('now'), datetime('now'))`,
    )
    .run(id, gateOwner, assigneeAgentId)
}

function seedGrant(sqlite: SqliteD1Harness['sqlite'], capability: string, principalType: 'member' | 'agent', principalId: string): void {
  sqlite
    .prepare(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES (?, ?, ?, ?, 'test', datetime('now'))`)
    .run(`grant-${capability}-${principalId}`, capability, principalType, principalId)
}

function taskVerdictCount(sqlite: SqliteD1Harness['sqlite'], taskId: string): number {
  const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM task_verdicts WHERE task_id = ?`).get(taskId) as { n: number } | undefined
  return Number(row?.n ?? 0)
}

describe('IM verdictReply — gate:agent-self-completion closed on the third write path (mupot#1080/#1081)', () => {
  let harness: SqliteD1Harness
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedBase(harness.sqlite)
  })
  afterEach(() => harness.close())

  it('REACHABLE exploit, now closed: a member holding a manually-granted gate:agent-self-completion capability cannot approve someone else\'s agent\'s self-completion task', async () => {
    seedMember(harness.sqlite, 'member-1', 'chat-1')
    seedSquadMemberCapability(harness.sqlite, 'member-1')
    // The misconfiguration: an admin granted this capability to a MEMBER —
    // nothing structurally prevents it (GATE_CAPABILITY_RE has no exclusion).
    seedGrant(harness.sqlite, 'gate:agent-self-completion', 'member', 'member-1')
    seedAgent(harness.sqlite, 'agent-other')
    seedReviewTask(harness.sqlite, 'task-1', 'gate:agent-self-completion', 'agent-other')

    const env = envFor(harness)
    const reply = await handleImMessage(env, 'chat-1', 'approve task-1')

    expect(reply).toMatch(/permission/i)
    expect(taskVerdictCount(harness.sqlite, 'task-1')).toBe(0)
  })

  it('matches HTTP/MCP: an org admin capability does not turn a human member into a legacy admin', async () => {
    seedMember(harness.sqlite, 'admin-1', 'chat-2')
    seedOrgAdminCapability(harness.sqlite, 'admin-1')
    seedAgent(harness.sqlite, 'agent-other-2')
    seedReviewTask(harness.sqlite, 'task-2', 'gate:agent-self-completion', 'agent-other-2')

    const env = envFor(harness)
    const reply = await handleImMessage(env, 'chat-2', 'approve task-2')

    expect(reply).toMatch(/permission/)
    expect(taskVerdictCount(harness.sqlite, 'task-2')).toBe(0)
  })

  it('the completing agent\'s OWN member (memberOwnsAssigneeAgent) is still refused — IM-specific rule preserved alongside the shared predicate', async () => {
    seedMember(harness.sqlite, 'member-3', 'chat-3')
    seedSquadMemberCapability(harness.sqlite, 'member-3')
    seedOrgAdminCapability(harness.sqlite, 'member-3')
    seedAgent(harness.sqlite, 'agent-owned-3')
    harness.sqlite
      .prepare(`INSERT INTO agent_keys (tenant, agent_id, pubkey, member_id, created_at) VALUES (?, ?, 'pk', ?, unixepoch())`)
      .run(TENANT, 'agent-owned-3', 'member-3')
    seedReviewTask(harness.sqlite, 'task-3', 'gate:agent-self-completion', 'agent-owned-3')

    const env = envFor(harness)
    const reply = await handleImMessage(env, 'chat-3', 'approve task-3')

    expect(reply).toMatch(/assignee/i)
    expect(taskVerdictCount(harness.sqlite, 'task-3')).toBe(0)
  })
})

describe('IM verdictReply — gate:loops surface cap now enforced (mupot#1081)', () => {
  let harness: SqliteD1Harness
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedBase(harness.sqlite)
  })
  afterEach(() => harness.close())

  it('REACHABLE false branch: member holds gate:loops but not outreach:send-gated — approve refused', async () => {
    seedMember(harness.sqlite, 'member-4', 'chat-4')
    seedSquadMemberCapability(harness.sqlite, 'member-4')
    seedGrant(harness.sqlite, 'gate:loops', 'member', 'member-4')
    seedReviewTask(harness.sqlite, 'task-4', 'gate:loops', null)

    const env = envFor(harness)
    const reply = await handleImMessage(env, 'chat-4', 'approve task-4')

    expect(reply).toMatch(/outreach:send-gated/)
    expect(taskVerdictCount(harness.sqlite, 'task-4')).toBe(0)
  })

  it('positive control: reject is not surface-gated — same caller can reject', async () => {
    seedMember(harness.sqlite, 'member-5', 'chat-5')
    seedSquadMemberCapability(harness.sqlite, 'member-5')
    seedGrant(harness.sqlite, 'gate:loops', 'member', 'member-5')
    seedReviewTask(harness.sqlite, 'task-5', 'gate:loops', null)

    const env = envFor(harness)
    const reply = await handleImMessage(env, 'chat-5', 'reject task-5 not today')

    expect(reply).toMatch(/Rejected/)
    expect(taskVerdictCount(harness.sqlite, 'task-5')).toBe(1)
  })

  // mupot#1602 r1 adversarial gate P3-1: "IM verdictReply [is] not referenced by
  // any test." writeVerdict refuses ANY gate:office task unconditionally
  // (src/tasks/service.ts) — verdictReply must surface that as a clear reply,
  // never an unhandled throw, and must never write a verdict.
  it('mupot#1602 r1 P3-1: refuses a gate:office task via plain Telegram approve — office.review_approval owns this decision', async () => {
    seedMember(harness.sqlite, 'member-office', 'chat-office')
    seedSquadMemberCapability(harness.sqlite, 'member-office')
    seedGrant(harness.sqlite, 'gate:office', 'member', 'member-office')
    seedReviewTask(harness.sqlite, 'task-office', 'gate:office', null)

    const env = envFor(harness)
    const reply = await handleImMessage(env, 'chat-office', 'approve task-office')

    expect(reply).toMatch(/office\.review_approval/)
    expect(taskVerdictCount(harness.sqlite, 'task-office')).toBe(0)
    const row = harness.sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get('task-office') as { status: string }
    expect(row.status).toBe('review')
  })
})

// seed B4 (round 2): IM /approve is a human surface; it must not discard a failed gate.verdict receipt append.
describe('IM verdictReply — gate.verdict receipt outcome is surfaced (seed B4)', () => {
  let harness: SqliteD1Harness
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedBase(harness.sqlite)
    seedMember(harness.sqlite, 'member-1', 'chat-1')
    seedSquadMemberCapability(harness.sqlite, 'member-1')
    seedGrant(harness.sqlite, 'gate:review', 'member', 'member-1')
    seedReviewTask(harness.sqlite, 'task-b4', 'gate:review', null)
    harness.sqlite.exec('PRAGMA foreign_keys = OFF')
    harness.sqlite.prepare(
      `INSERT INTO objectives (id, tenant, created_by_principal_kind, created_by_principal_id, created_by_member_id, squad_id, title,
         success_contract, authority_envelope, policy_json, budget_micro_usd, payload_json, payload_digest, accepted_at, created_at)
       VALUES ('obj-im', ?, 'member', 'member-1', 'member-1', 'squad-1', 'O', 'ship', '{}', '{}', 0, '{}', ?, '2026-10-22T00:00:00Z', '2026-10-22T00:00:00Z')`,
    ).run(TENANT, 'a'.repeat(64))
    harness.sqlite.prepare(`INSERT INTO flights (id, tenant, agent, goal) VALUES ('flight-im', ?, 'agent-x', 'g')`).run(TENANT)
    harness.sqlite.prepare(`INSERT INTO flight_objectives (id, tenant, flight_id, objective_id, linked_at) VALUES ('fo-im', ?, 'flight-im', 'obj-im', '2026-10-22T00:00:00Z')`).run(TENANT)
    harness.sqlite.prepare(
      `INSERT INTO flight_lanes (id, tenant, flight_id, lane_key, role, task_id, assignment_epoch, agent_id, done_when, created_at)
       VALUES ('lane-im', ?, 'flight-im', 'k', 'worker', 'task-b4', 1, 'agent-x', 'done', '2026-10-22T00:00:00Z')`,
    ).run(TENANT)
    harness.sqlite.exec('PRAGMA foreign_keys = ON')
  })
  afterEach(() => harness.close())

  it('a chain-scope approval via IM appends the receipt and replies normally', async () => {
    const reply = await handleImMessage(envFor(harness), 'chat-1', 'approve task-b4')
    expect(reply).toMatch(/^Approved/)
    expect(reply).not.toMatch(/audit receipt/i)
    expect(harness.sqlite.prepare('SELECT type, actor_kind FROM execution_receipts').all()).toEqual([{ type: 'gate.verdict', actor_kind: 'member' }])
  })

  it('a failed append never blocks the verdict, and the reply says the receipt will be retried', async () => {
    harness.sqlite.exec('ALTER TABLE execution_receipt_heads RENAME TO execution_receipt_heads_broken')
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reply = await handleImMessage(envFor(harness), 'chat-1', 'approve task-b4')
    quiet.mockRestore()
    expect(reply).toMatch(/^Approved/)
    expect(reply).toMatch(/audit receipt could not be appended yet/i)
    expect(taskVerdictCount(harness.sqlite, 'task-b4')).toBe(1)
  })
})

describe('IM owner-self selection for grant admins', () => {
  let harness: SqliteD1Harness
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedBase(harness.sqlite)
  })
  afterEach(() => harness.close())

  it.each([false, true])('a non-owner key minter remains refused on the review lane (org admin: %s)', async (admin) => {
    const s = harness.sqlite
    seedMember(s, 'minter', 'chat-minter')
    seedSquadMemberCapability(s, 'minter')
    if (admin) seedOrgAdminCapability(s, 'minter')
    seedAgent(s, 'keyed-agent')
    seedGrant(s, 'gate:review', 'member', 'minter')
    s.prepare(`INSERT INTO agent_keys (tenant, agent_id, pubkey, member_id, created_at) VALUES (?, 'keyed-agent', 'pk-minter', 'minter', unixepoch())`).run(TENANT)
    seedReviewTask(s, 'task-keyed', 'gate:review', 'keyed-agent')
    await handleImMessage(envFor(harness), 'chat-minter', 'approve task-keyed')
    expect(taskVerdictCount(s, 'task-keyed')).toBe(0)
    expect(s.prepare(`SELECT status FROM tasks WHERE id = 'task-keyed'`).get()).toMatchObject({ status: 'review' })
  })

  it.each(['approve', 'reject'])('owner who also minted the key needs lenses for %s and records owner_self', async (verb) => {
    const s = harness.sqlite
    seedMember(s, 'admin-own', 'chat-own')
    seedOrgAdminCapability(s, 'admin-own')
    seedAgent(s, 'owned-agent')
    s.prepare(`UPDATE agents SET owner_member_id = 'admin-own' WHERE id = 'owned-agent'`).run()
    s.prepare(`INSERT INTO agent_keys (tenant, agent_id, pubkey, member_id, created_at) VALUES (?, 'owned-agent', 'pk-owner', 'admin-own', unixepoch())`).run(TENANT)
    seedGrant(s, 'gate:review', 'member', 'admin-own')
    seedReviewTask(s, 'task-own', 'gate:review', 'owned-agent')
    const env = envFor(harness)
    await handleImMessage(env, 'chat-own', `${verb} task-own reviewed`)
    expect(taskVerdictCount(s, 'task-own')).toBe(0)
    expect(s.prepare(`SELECT status FROM tasks WHERE id = 'task-own'`).get()).toMatchObject({ status: 'review' })
    s.prepare(`INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, result_text)
      VALUES ('sub-own', ?, 'task-own', 'squad-1', 'owned-agent', '/tmp/x', ?, ?, 'RESULT')`).run(TENANT, 'ab'.repeat(32), 'cd'.repeat(32))
    s.prepare(`UPDATE tasks SET result = 'RESULT' WHERE id = 'task-own'`).run()
    for (const [i, lens] of ['correctness', 'adversarial'].entries()) {
      const reviewer = `reviewer-${i}`
      seedAgent(s, reviewer)
      seedGrant(s, 'gate:review', 'agent', reviewer)
      s.prepare(`INSERT INTO task_review_lenses (id, task_id, submission_id, result_digest, gate_owner, lens, reviewer_kind, reviewer_id, outcome, created_at)
        VALUES (?, 'task-own', 'sub-own', ?, 'gate:review', ?, 'agent', ?, 'pass', datetime('now'))`).run(`lens-${i}`, 'cd'.repeat(32), lens, reviewer)
    }
    await handleImMessage(env, 'chat-own', `${verb} task-own reviewed`)
    expect(taskVerdictCount(s, 'task-own')).toBe(1)
    expect(s.prepare(`SELECT status FROM tasks WHERE id = 'task-own'`).get()).toMatchObject({ status: verb === 'approve' ? 'approved' : 'rejected' })
    expect(s.prepare(`SELECT independence_waiver FROM task_verdicts WHERE task_id = 'task-own'`).get()).toMatchObject({ independence_waiver: 'owner_self' })
  })
})
