// tests/task-verdict-human-origin.test.ts — mupot#1424 slice: task_verdict's
// `human_origin` field, the harness-attested path where a member's own agent
// (KayHermes/Telegram) carries the member's decision.
//
// Real SQLite, the full committed migration chain (applyAllMigrations), and
// the tool invoked via `invokeTool` — the SAME dispatch seam MCP and
// /actions/task_verdict both go through (src/mcp/index.ts's
// mcpActionsApp.post('/actions/:tool') calls the identical ToolSpec.run()),
// same pattern as tests/agent-self-update.test.ts.
//
// Every conjunct in src/im/origin-verdict.ts gets its OWN test that flips
// ONLY that conjunct and asserts: the verdict still lands (under the AGENT's
// own authority, unchanged from omitting human_origin), decided_by is the
// AGENT id, and the response's human_origin.applied is false with the named
// reason. Two conjuncts are HARD failures (the whole call refused, no
// fallback): a non-agent-bound caller supplying human_origin, and a replayed
// origin message.

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp/index'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'origin-verdict-test'
const ORIGIN = 'https://pot.test'
const SQUAD = 'squad-1'
const GATE = 'gate:outreach'

function makeEnv(harness: SqliteD1Harness): Env {
  return { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
}

function seedBase(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.prepare(`INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept-1', 'Dept One')`).run()
  sqlite
    .prepare(`INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD}', 'dept-1', 'sq1', 'Squad One')`)
    .run()
}

function seedAgent(sqlite: SqliteD1Harness['sqlite'], id: string, status: 'active' | 'paused' = 'active'): void {
  sqlite
    .prepare(
      `INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES (?, ?, ?, ?, 'member', 'test', ?)`,
    )
    .run(id, SQUAD, id, id, status)
}

function setAgentOwner(sqlite: SqliteD1Harness['sqlite'], agentId: string, memberId: string | null): void {
  sqlite.prepare(`UPDATE agents SET owner_member_id = ? WHERE id = ?`).run(memberId, agentId)
}

function seedMember(
  sqlite: SqliteD1Harness['sqlite'],
  id: string,
  opts: { status?: 'active' | 'suspended'; telegramChatId?: string | null } = {},
): void {
  sqlite
    .prepare(
      `INSERT INTO members (id, email, display_name, status, tenant, telegram_chat_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, `${id}@test.com`, id, opts.status ?? 'active', TENANT, opts.telegramChatId ?? null)
}

function seedSquadMemberCapability(sqlite: SqliteD1Harness['sqlite'], memberId: string): void {
  sqlite
    .prepare(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?, ?, 'squad', ?, 'member')`,
    )
    .run(`cap-${memberId}`, memberId, SQUAD)
}

function seedGateGrant(sqlite: SqliteD1Harness['sqlite'], principalType: 'member' | 'agent', principalId: string): void {
  sqlite
    .prepare(
      `INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
       VALUES (?, ?, ?, ?, 'test-granter', datetime('now'))`,
    )
    .run(`grant-${principalType}-${principalId}`, GATE, principalType, principalId)
}

function seedReviewTask(
  sqlite: SqliteD1Harness['sqlite'],
  id: string,
  assigneeAgentId: string | null = null,
): void {
  sqlite
    .prepare(
      `INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, assignee_agent_id, result, created_at, updated_at)
       VALUES (?, ?, 'T', 'body', 'done', 'review', ?, ?, NULL, datetime('now'), datetime('now'))`,
    )
    .run(id, SQUAD, GATE, assigneeAgentId)
}

function seedAssigneeConflict(sqlite: SqliteD1Harness['sqlite'], assigneeAgentId: string, memberId: string): void {
  sqlite
    .prepare(
      `INSERT INTO agent_keys (tenant, agent_id, pubkey, member_id, created_at) VALUES (?, ?, 'test-pubkey', ?, unixepoch())`,
    )
    .run(TENANT, assigneeAgentId, memberId)
}

// invokeTool's central AAGATE floor (spec.min = 'member' for task_verdict)
// checks auth.capabilities BEFORE run() is ever entered — scope-agnostic, any
// row at 'member' or above on ANY scope passes. A real agent-bound token
// carries whatever the token's own member envelope resolved to; the
// synthetic AuthContexts below need a baseline grant for the SAME reason, or
// every test would 403 at the floor before this file's own new logic (inside
// run()) is ever reached.
const BASELINE_FLOOR_CAP: CapabilityGrant[] = [
  { member_id: 'floor-only', scope_type: 'squad', scope_id: SQUAD, capability: 'member' },
]

/** An agent-bound caller — the harness's own authority, unchanged if
 *  human_origin never resolves. Carries its OWN capabilities so the fallback
 *  path (origin fails) can still succeed as the agent, proving "runs under
 *  the agent seat only, unchanged from today." */
function harnessAuth(agentId: string, capabilities: CapabilityGrant[] = BASELINE_FLOOR_CAP): AuthContext {
  return {
    userId: `agent:${agentId}`,
    email: null,
    role: 'member',
    tenant: TENANT,
    memberId: 'member-of-harness-token', // the token minter — irrelevant to verdictPrincipal for a bound token
    capabilities,
    boundAgentId: agentId,
  } as AuthContext
}

function nonBoundAuth(memberId: string): AuthContext {
  return {
    userId: memberId,
    email: `${memberId}@test.com`,
    role: 'member',
    tenant: TENANT,
    memberId,
    capabilities: BASELINE_FLOOR_CAP,
    boundAgentId: null,
  } as AuthContext
}

interface VerdictOutcomeOk {
  ok: true
  result: {
    verdict: { id: string; task_id: string; decided_by: string; decided_via?: string | null; origin_agent_id?: string | null }
    human_origin?: { applied: boolean; reason?: string; bound_now?: boolean }
  }
}
interface VerdictOutcomeFail {
  ok: false
  status: number
  error: string
  detail?: unknown
}
type VerdictOutcome = VerdictOutcomeOk | VerdictOutcomeFail

async function invokeVerdict(env: Env, auth: AuthContext, args: Record<string, unknown>): Promise<VerdictOutcome> {
  const outcome = await invokeTool(auth, env, 'task_verdict', args, ORIGIN)
  return outcome as unknown as VerdictOutcome
}

/** Asserts the call succeeded and returns its `result`, so a mistaken
 *  fallback-into-failure fails loudly with the real status/error instead of
 *  a confusing "result is undefined" from indexing a failure shape. */
function expectApplied(res: VerdictOutcome): VerdictOutcomeOk['result'] {
  if (!res.ok) throw new Error(`expected ok:true, got ok:false status=${res.status} error=${res.error}`)
  return res.result
}

function origin(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    channel: 'telegram',
    user_id: '5551234',
    chat_id: '5551234',
    message_id: '9001',
    message_at: new Date().toISOString(), // fresh by default
    ...overrides,
  }
}

describe('task_verdict human_origin — mupot#1424 harness-attested origin', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedBase(harness.sqlite)
    env = makeEnv(harness)
  })
  afterEach(() => harness.close())

  // ── hard failure #1: caller shape ───────────────────────────────────────
  it('a non-agent-bound caller supplying human_origin gets a hard 400, no fallback', async () => {
    seedMember(harness.sqlite, 'member-plain')
    seedReviewTask(harness.sqlite, 'task-1')
    const res = await invokeVerdict(env, nonBoundAuth('member-plain'), {
      task_id: 'task-1',
      verdict: 'approved',
      human_origin: origin(),
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected refusal')
    expect(res.status).toBe(400)
    expect(res.error).toBe('human_origin_not_applicable')

    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM task_verdicts').first<{ n: number }>()
    expect(rows?.n).toBe(0)
  })

  // ── conjunct: agent must be OWNED ────────────────────────────────────────
  it('agent_not_owned — owner_member_id NULL: falls back to agent auth, applied:false', async () => {
    seedAgent(harness.sqlite, 'agent-unowned')
    seedGateGrant(harness.sqlite, 'agent', 'agent-unowned')
    seedReviewTask(harness.sqlite, 'task-2')
    const auth = harnessAuth('agent-unowned', [{ member_id: 'member-of-harness-token', scope_type: 'squad', scope_id: SQUAD, capability: 'member' } as CapabilityGrant])

    const result = expectApplied(await invokeVerdict(env, auth, { task_id: 'task-2', verdict: 'approved', human_origin: origin() }))
    expect(result.human_origin).toEqual({ applied: false, reason: 'agent_not_owned' })
    expect(result.verdict.decided_by).toBe('agent-unowned')
    expect(result.verdict.decided_via ?? null).toBeNull()
  })

  // ── conjunct: owning member must be active ──────────────────────────────
  it('member_inactive — owner is suspended: falls back to agent auth, applied:false', async () => {
    seedAgent(harness.sqlite, 'agent-susp-owner')
    seedGateGrant(harness.sqlite, 'agent', 'agent-susp-owner')
    seedMember(harness.sqlite, 'member-suspended', { status: 'suspended' })
    setAgentOwner(harness.sqlite, 'agent-susp-owner', 'member-suspended')
    seedReviewTask(harness.sqlite, 'task-3')
    const auth = harnessAuth('agent-susp-owner', [{ member_id: 'member-of-harness-token', scope_type: 'squad', scope_id: SQUAD, capability: 'member' } as CapabilityGrant])

    const result = expectApplied(await invokeVerdict(env, auth, { task_id: 'task-3', verdict: 'approved', human_origin: origin() }))
    expect(result.human_origin).toEqual({ applied: false, reason: 'member_inactive' })
    expect(result.verdict.decided_by).toBe('agent-susp-owner')
  })

  // ── conjunct: origin shape / private-chat invariant ─────────────────────
  it('invalid_origin_shape — user_id != chat_id (not a private-chat origin): falls back to agent auth', async () => {
    seedAgent(harness.sqlite, 'agent-shape')
    seedGateGrant(harness.sqlite, 'agent', 'agent-shape')
    seedMember(harness.sqlite, 'member-shape')
    setAgentOwner(harness.sqlite, 'agent-shape', 'member-shape')
    seedReviewTask(harness.sqlite, 'task-4')
    const auth = harnessAuth('agent-shape', [{ member_id: 'member-of-harness-token', scope_type: 'squad', scope_id: SQUAD, capability: 'member' } as CapabilityGrant])

    const result = expectApplied(await invokeVerdict(env, auth, {
      task_id: 'task-4',
      verdict: 'approved',
      human_origin: origin({ chat_id: '9999999' }), // != user_id
    }))
    expect(result.human_origin).toEqual({ applied: false, reason: 'invalid_origin_shape' })
    expect(result.verdict.decided_by).toBe('agent-shape')
  })

  // ── conjunct: never rebind an already-bound member to a different chat ──
  it('origin_member_mismatch — owner already bound to a DIFFERENT chat_id: falls back to agent auth, no write', async () => {
    seedAgent(harness.sqlite, 'agent-mismatch')
    seedGateGrant(harness.sqlite, 'agent', 'agent-mismatch')
    seedMember(harness.sqlite, 'member-mismatch', { telegramChatId: '1112222' })
    setAgentOwner(harness.sqlite, 'agent-mismatch', 'member-mismatch')
    seedReviewTask(harness.sqlite, 'task-5')
    const auth = harnessAuth('agent-mismatch', [{ member_id: 'member-of-harness-token', scope_type: 'squad', scope_id: SQUAD, capability: 'member' } as CapabilityGrant])

    const result = expectApplied(await invokeVerdict(env, auth, { task_id: 'task-5', verdict: 'approved', human_origin: origin() }))
    expect(result.human_origin).toEqual({ applied: false, reason: 'origin_member_mismatch' })
    expect(result.verdict.decided_by).toBe('agent-mismatch')

    const member = await env.DB.prepare('SELECT telegram_chat_id FROM members WHERE id = ?')
      .bind('member-mismatch')
      .first<{ telegram_chat_id: string }>()
    expect(member?.telegram_chat_id).toBe('1112222') // unchanged
  })

  // ── conjunct: never bind over ANOTHER member's chat_id ──────────────────
  it('chat_already_bound — origin.chat_id already belongs to a DIFFERENT member: falls back to agent auth', async () => {
    seedAgent(harness.sqlite, 'agent-taken')
    seedGateGrant(harness.sqlite, 'agent', 'agent-taken')
    seedMember(harness.sqlite, 'member-owner-unbound', { telegramChatId: null })
    seedMember(harness.sqlite, 'member-holds-chat', { telegramChatId: '5551234' }) // same chat_id as origin()
    setAgentOwner(harness.sqlite, 'agent-taken', 'member-owner-unbound')
    seedReviewTask(harness.sqlite, 'task-6')
    const auth = harnessAuth('agent-taken', [{ member_id: 'member-of-harness-token', scope_type: 'squad', scope_id: SQUAD, capability: 'member' } as CapabilityGrant])

    const result = expectApplied(await invokeVerdict(env, auth, { task_id: 'task-6', verdict: 'approved', human_origin: origin() }))
    expect(result.human_origin).toEqual({ applied: false, reason: 'chat_already_bound' })
    expect(result.verdict.decided_by).toBe('agent-taken')

    const owner = await env.DB.prepare('SELECT telegram_chat_id FROM members WHERE id = ?')
      .bind('member-owner-unbound')
      .first<{ telegram_chat_id: string | null }>()
    expect(owner?.telegram_chat_id).toBeNull() // never bound
  })

  // ── conjunct: conflict of interest (agent_keys — deliberately NOT
  // conflated with owner_member_id, per src/im/origin-verdict.ts) ─────────
  it('assignee_conflict — resolved member owns the TASK\'S ASSIGNEE agent (agent_keys): falls back to agent auth', async () => {
    seedAgent(harness.sqlite, 'agent-conflict-harness')
    seedAgent(harness.sqlite, 'agent-conflict-assignee')
    seedGateGrant(harness.sqlite, 'agent', 'agent-conflict-harness')
    seedMember(harness.sqlite, 'member-conflict', { telegramChatId: '5551234' })
    setAgentOwner(harness.sqlite, 'agent-conflict-harness', 'member-conflict')
    seedAssigneeConflict(harness.sqlite, 'agent-conflict-assignee', 'member-conflict')
    seedSquadMemberCapability(harness.sqlite, 'member-conflict')
    seedGateGrant(harness.sqlite, 'member', 'member-conflict')
    seedReviewTask(harness.sqlite, 'task-7', 'agent-conflict-assignee')
    const auth = harnessAuth('agent-conflict-harness', [{ member_id: 'member-of-harness-token', scope_type: 'squad', scope_id: SQUAD, capability: 'member' } as CapabilityGrant])

    const result = expectApplied(await invokeVerdict(env, auth, { task_id: 'task-7', verdict: 'approved', human_origin: origin() }))
    expect(result.human_origin).toEqual({ applied: false, reason: 'assignee_conflict' })
    expect(result.verdict.decided_by).toBe('agent-conflict-harness')
  })

  // ── positive path 1: first-bind-by-origin (no invite, no button) ────────
  it('applied:true, bound_now:true — owner has no telegram_chat_id yet: bound in this request, verdict decided_by the MEMBER', async () => {
    seedAgent(harness.sqlite, 'agent-firstbind')
    seedMember(harness.sqlite, 'member-firstbind', { telegramChatId: null })
    setAgentOwner(harness.sqlite, 'agent-firstbind', 'member-firstbind')
    seedSquadMemberCapability(harness.sqlite, 'member-firstbind')
    seedGateGrant(harness.sqlite, 'member', 'member-firstbind')
    seedReviewTask(harness.sqlite, 'task-8')
    const auth = harnessAuth('agent-firstbind')

    const result = expectApplied(await invokeVerdict(env, auth, { task_id: 'task-8', verdict: 'approved', human_origin: origin() }))
    expect(result.human_origin).toEqual({ applied: true, bound_now: true })
    expect(result.verdict.decided_by).toBe('member-firstbind')
    expect(result.verdict.decided_via).toBe('agent_attested_origin')
    expect(result.verdict.origin_agent_id).toBe('agent-firstbind')

    const member = await env.DB.prepare('SELECT telegram_chat_id, telegram_bound_at FROM members WHERE id = ?')
      .bind('member-firstbind')
      .first<{ telegram_chat_id: string; telegram_bound_at: string | null }>()
    expect(member?.telegram_chat_id).toBe('5551234')
    expect(member?.telegram_bound_at).not.toBeNull()

    const receipt = await env.DB.prepare(
      'SELECT member_id, agent_id, chat_id, message_id FROM telegram_origin_bind_receipts WHERE member_id = ?',
    ).bind('member-firstbind').first<{ member_id: string; agent_id: string; chat_id: string; message_id: string }>()
    expect(receipt).toMatchObject({
      member_id: 'member-firstbind',
      agent_id: 'agent-firstbind',
      chat_id: '5551234',
      message_id: '9001',
    })
  })

  // ── positive path 2: already bound, no rebind needed ────────────────────
  it('applied:true, bound_now:false — owner already bound to this exact chat_id', async () => {
    seedAgent(harness.sqlite, 'agent-prebound')
    seedMember(harness.sqlite, 'member-prebound', { telegramChatId: '5551234' })
    setAgentOwner(harness.sqlite, 'agent-prebound', 'member-prebound')
    seedSquadMemberCapability(harness.sqlite, 'member-prebound')
    seedGateGrant(harness.sqlite, 'member', 'member-prebound')
    seedReviewTask(harness.sqlite, 'task-9')
    const auth = harnessAuth('agent-prebound')

    const result = expectApplied(await invokeVerdict(env, auth, { task_id: 'task-9', verdict: 'approved', human_origin: origin() }))
    expect(result.human_origin).toEqual({ applied: true, bound_now: false })
    expect(result.verdict.decided_by).toBe('member-prebound')
  })

  // ── replay: one decision per origin message ─────────────────────────────
  it('origin_replayed — a SECOND call with the identical origin gets a hard 409, task_verdicts count unchanged', async () => {
    seedAgent(harness.sqlite, 'agent-replay')
    seedMember(harness.sqlite, 'member-replay', { telegramChatId: '5551234' })
    setAgentOwner(harness.sqlite, 'agent-replay', 'member-replay')
    seedSquadMemberCapability(harness.sqlite, 'member-replay')
    seedGateGrant(harness.sqlite, 'member', 'member-replay')
    seedReviewTask(harness.sqlite, 'task-10')
    const auth = harnessAuth('agent-replay')

    const first = expectApplied(await invokeVerdict(env, auth, { task_id: 'task-10', verdict: 'approved', human_origin: origin() }))
    expect(first.human_origin?.applied).toBe(true)

    const countAfterFirst = await env.DB.prepare('SELECT COUNT(*) AS n FROM task_verdicts').first<{ n: number }>()
    expect(countAfterFirst?.n).toBe(1)

    // Second call: same chat_id + message_id, a DIFFERENT task — even so, the
    // origin replay must be refused before any task-state check could matter
    // (the digest binds chat+user+message+task+verdict, and this second call
    // names a different task_id, but the update_id KEY is chat_id+message_id
    // alone, so the second reservation attempt still collides).
    seedReviewTask(harness.sqlite, 'task-10b')
    const second = await invokeVerdict(env, auth, { task_id: 'task-10b', verdict: 'approved', human_origin: origin() })
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('expected refusal')
    expect(second.status).toBe(409)
    expect(second.error).toBe('origin_replayed')

    const countAfterSecond = await env.DB.prepare('SELECT COUNT(*) AS n FROM task_verdicts').first<{ n: number }>()
    expect(countAfterSecond?.n).toBe(1) // no second verdict
  })

  it('a DIFFERENT origin message (different message_id, different chat) is NOT a replay', async () => {
    // Deliberately a DIFFERENT chat (and agent) per call — this test isolates
    // "different message_id is not a replay" from the per-(agent,chat) rate
    // limit below, which would otherwise refuse the second call for an
    // unrelated reason and defeat the point of this test.
    seedAgent(harness.sqlite, 'agent-replay2a')
    seedAgent(harness.sqlite, 'agent-replay2b')
    seedMember(harness.sqlite, 'member-replay2a', { telegramChatId: '5551234' })
    seedMember(harness.sqlite, 'member-replay2b', { telegramChatId: '7778888' })
    setAgentOwner(harness.sqlite, 'agent-replay2a', 'member-replay2a')
    setAgentOwner(harness.sqlite, 'agent-replay2b', 'member-replay2b')
    seedSquadMemberCapability(harness.sqlite, 'member-replay2a')
    seedSquadMemberCapability(harness.sqlite, 'member-replay2b')
    seedGateGrant(harness.sqlite, 'member', 'member-replay2a')
    seedGateGrant(harness.sqlite, 'member', 'member-replay2b')
    seedReviewTask(harness.sqlite, 'task-11')
    seedReviewTask(harness.sqlite, 'task-12')

    const first = expectApplied(await invokeVerdict(env, harnessAuth('agent-replay2a'), {
      task_id: 'task-11', verdict: 'approved', human_origin: origin({ chat_id: '5551234', user_id: '5551234', message_id: '1' }),
    }))
    expect(first.human_origin?.applied).toBe(true)
    const second = expectApplied(await invokeVerdict(env, harnessAuth('agent-replay2b'), {
      task_id: 'task-12', verdict: 'approved', human_origin: origin({ chat_id: '7778888', user_id: '7778888', message_id: '2' }),
    }))
    expect(second.human_origin?.applied).toBe(true)

    const countAfter = await env.DB.prepare('SELECT COUNT(*) AS n FROM task_verdicts').first<{ n: number }>()
    expect(countAfter?.n).toBe(2)
  })

  // ── conjunct: freshness window ───────────────────────────────────────────
  it('origin_stale — message_at more than 10 minutes old: falls back to agent auth', async () => {
    seedAgent(harness.sqlite, 'agent-stale-old')
    seedGateGrant(harness.sqlite, 'agent', 'agent-stale-old')
    seedMember(harness.sqlite, 'member-stale-old')
    setAgentOwner(harness.sqlite, 'agent-stale-old', 'member-stale-old')
    seedReviewTask(harness.sqlite, 'task-13')
    const auth = harnessAuth('agent-stale-old', [{ member_id: 'floor-only', scope_type: 'squad', scope_id: SQUAD, capability: 'member' }])

    const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString()
    const result = expectApplied(await invokeVerdict(env, auth, {
      task_id: 'task-13', verdict: 'approved', human_origin: origin({ message_at: elevenMinutesAgo }),
    }))
    expect(result.human_origin).toEqual({ applied: false, reason: 'origin_stale' })
    expect(result.verdict.decided_by).toBe('agent-stale-old')
  })

  it('origin_stale — message_at more than 60 seconds in the future: falls back to agent auth', async () => {
    seedAgent(harness.sqlite, 'agent-stale-future')
    seedGateGrant(harness.sqlite, 'agent', 'agent-stale-future')
    seedMember(harness.sqlite, 'member-stale-future')
    setAgentOwner(harness.sqlite, 'agent-stale-future', 'member-stale-future')
    seedReviewTask(harness.sqlite, 'task-14')
    const auth = harnessAuth('agent-stale-future', [{ member_id: 'floor-only', scope_type: 'squad', scope_id: SQUAD, capability: 'member' }])

    const twoMinutesFromNow = new Date(Date.now() + 2 * 60 * 1000).toISOString()
    const result = expectApplied(await invokeVerdict(env, auth, {
      task_id: 'task-14', verdict: 'approved', human_origin: origin({ message_at: twoMinutesFromNow }),
    }))
    expect(result.human_origin).toEqual({ applied: false, reason: 'origin_stale' })
    expect(result.verdict.decided_by).toBe('agent-stale-future')
  })

  it('a FRESH message_at just inside the 10-minute window still applies', async () => {
    seedAgent(harness.sqlite, 'agent-fresh-edge')
    seedMember(harness.sqlite, 'member-fresh-edge', { telegramChatId: '5551234' })
    setAgentOwner(harness.sqlite, 'agent-fresh-edge', 'member-fresh-edge')
    seedSquadMemberCapability(harness.sqlite, 'member-fresh-edge')
    seedGateGrant(harness.sqlite, 'member', 'member-fresh-edge')
    seedReviewTask(harness.sqlite, 'task-15')
    const auth = harnessAuth('agent-fresh-edge')

    const nineMinutesAgo = new Date(Date.now() - 9 * 60 * 1000).toISOString()
    const result = expectApplied(await invokeVerdict(env, auth, {
      task_id: 'task-15', verdict: 'approved', human_origin: origin({ message_at: nineMinutesAgo }),
    }))
    expect(result.human_origin?.applied).toBe(true)
  })

  // ── conjunct: per-(agent, chat) rate limit ───────────────────────────────
  it('origin_rate_limited — a SECOND applied decision from the SAME (agent, chat) within 30s is refused, falls back to agent auth', async () => {
    seedAgent(harness.sqlite, 'agent-rate')
    seedGateGrant(harness.sqlite, 'agent', 'agent-rate')
    seedMember(harness.sqlite, 'member-rate', { telegramChatId: '5551234' })
    setAgentOwner(harness.sqlite, 'agent-rate', 'member-rate')
    seedSquadMemberCapability(harness.sqlite, 'member-rate')
    seedGateGrant(harness.sqlite, 'member', 'member-rate')
    seedReviewTask(harness.sqlite, 'task-16')
    seedReviewTask(harness.sqlite, 'task-17')
    const auth = harnessAuth('agent-rate', [{ member_id: 'floor-only', scope_type: 'squad', scope_id: SQUAD, capability: 'member' }])

    const first = expectApplied(await invokeVerdict(env, auth, {
      task_id: 'task-16', verdict: 'approved', human_origin: origin({ message_id: '9101' }),
    }))
    expect(first.human_origin).toEqual({ applied: true, bound_now: false })

    // Same agent, same chat, a genuinely DIFFERENT (fresh, unreplayed) message
    // deciding a DIFFERENT task — the replay reservation does not catch this
    // (different digest), only the rate limit does.
    const second = expectApplied(await invokeVerdict(env, auth, {
      task_id: 'task-17', verdict: 'approved', human_origin: origin({ message_id: '9102' }),
    }))
    expect(second.human_origin).toEqual({ applied: false, reason: 'origin_rate_limited' })
    expect(second.verdict.decided_by).toBe('agent-rate') // fell back to the agent, task-17 still decided

    // Exactly one verdict was decided_by the MEMBER (the first); the second
    // landed under the agent.
    const memberDecided = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM task_verdicts WHERE decided_by = ? AND decided_via = 'agent_attested_origin'`,
    ).bind('member-rate').first<{ n: number }>()
    expect(memberDecided?.n).toBe(1)
  })

  it('a DIFFERENT chat is NOT rate-limited by another chat\'s recent applied decision', async () => {
    seedAgent(harness.sqlite, 'agent-rate-a')
    seedAgent(harness.sqlite, 'agent-rate-b')
    seedMember(harness.sqlite, 'member-rate-a', { telegramChatId: '5551234' })
    seedMember(harness.sqlite, 'member-rate-b', { telegramChatId: '7778888' })
    setAgentOwner(harness.sqlite, 'agent-rate-a', 'member-rate-a')
    setAgentOwner(harness.sqlite, 'agent-rate-b', 'member-rate-b')
    seedSquadMemberCapability(harness.sqlite, 'member-rate-a')
    seedSquadMemberCapability(harness.sqlite, 'member-rate-b')
    seedGateGrant(harness.sqlite, 'member', 'member-rate-a')
    seedGateGrant(harness.sqlite, 'member', 'member-rate-b')
    seedReviewTask(harness.sqlite, 'task-18')
    seedReviewTask(harness.sqlite, 'task-19')

    const first = expectApplied(await invokeVerdict(env, harnessAuth('agent-rate-a'), {
      task_id: 'task-18', verdict: 'approved', human_origin: origin({ chat_id: '5551234', user_id: '5551234', message_id: '9201' }),
    }))
    expect(first.human_origin?.applied).toBe(true)

    const second = expectApplied(await invokeVerdict(env, harnessAuth('agent-rate-b'), {
      task_id: 'task-19', verdict: 'approved', human_origin: origin({ chat_id: '7778888', user_id: '7778888', message_id: '9202' }),
    }))
    expect(second.human_origin?.applied).toBe(true)
  })
})
