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

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
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

  it('positive control: org admin (capability-based) STILL overrides gate:agent-self-completion via IM — the legacy escape is preserved', async () => {
    seedMember(harness.sqlite, 'admin-1', 'chat-2')
    seedOrgAdminCapability(harness.sqlite, 'admin-1')
    seedAgent(harness.sqlite, 'agent-other-2')
    seedReviewTask(harness.sqlite, 'task-2', 'gate:agent-self-completion', 'agent-other-2')

    const env = envFor(harness)
    const reply = await handleImMessage(env, 'chat-2', 'approve task-2')

    expect(reply).toMatch(/Approved/)
    expect(taskVerdictCount(harness.sqlite, 'task-2')).toBe(1)
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
})
