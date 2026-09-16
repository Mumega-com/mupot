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
import { listTaskDispatchReceiptTimeline } from '../src/tasks/runtime-receipts'
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
  it('chat_already_bound — origin.chat_id already belongs to a DIFFERENT member: falls back to agent auth (mupot#1425: only reachable once the dry-run gate ALSO passes for the candidate member)', async () => {
    seedAgent(harness.sqlite, 'agent-taken')
    seedGateGrant(harness.sqlite, 'agent', 'agent-taken')
    seedMember(harness.sqlite, 'member-owner-unbound', { telegramChatId: null })
    seedMember(harness.sqlite, 'member-holds-chat', { telegramChatId: '5551234' }) // same chat_id as origin()
    setAgentOwner(harness.sqlite, 'agent-taken', 'member-owner-unbound')
    // mupot#1425 P0-2 fix: the dry-run authorization (squad membership +
    // evaluateVerdictGates) now runs BEFORE any bind is even attempted, so
    // the candidate member needs real standing to ever REACH the bind step.
    seedSquadMemberCapability(harness.sqlite, 'member-owner-unbound')
    seedGateGrant(harness.sqlite, 'member', 'member-owner-unbound')
    seedReviewTask(harness.sqlite, 'task-6')
    const auth = harnessAuth('agent-taken', [{ member_id: 'member-of-harness-token', scope_type: 'squad', scope_id: SQUAD, capability: 'member' } as CapabilityGrant])

    const result = expectApplied(await invokeVerdict(env, auth, { task_id: 'task-6', verdict: 'approved', human_origin: origin() }))
    expect(result.human_origin).toEqual({ applied: false, reason: 'chat_already_bound' })
    expect(result.verdict.decided_by).toBe('agent-taken')

    const owner = await env.DB.prepare('SELECT telegram_chat_id FROM members WHERE id = ?')
      .bind('member-owner-unbound')
      .first<{ telegram_chat_id: string | null }>()
    expect(owner?.telegram_chat_id).toBeNull() // never bound

    // mupot#1425 P0-2: the UNIQUE-constraint throw aborts the WHOLE D1
    // batch, so the reservation itself was never committed either —
    // "a failure reserves nothing."
    const reservation = await env.DB.prepare(
      `SELECT 1 FROM telegram_webhook_receipts WHERE update_id = ?`,
    ).bind('origin:telegram:5551234:9001').first()
    expect(reservation).toBeNull()
  })

  it('P2-6 closed as a side effect of P0-2: an UNAUTHORIZED candidate can no longer probe chat_already_bound vs. a real first-bind (the oracle never fires before the dry-run gate)', async () => {
    seedAgent(harness.sqlite, 'agent-oracle')
    seedGateGrant(harness.sqlite, 'agent', 'agent-oracle')
    seedMember(harness.sqlite, 'member-oracle-owner', { telegramChatId: null })
    seedMember(harness.sqlite, 'member-holds-chat-2', { telegramChatId: '5551234' })
    setAgentOwner(harness.sqlite, 'agent-oracle', 'member-oracle-owner')
    // Deliberately NO squad capability / gate grant for member-oracle-owner —
    // this candidate is UNAUTHORIZED for the task below.
    seedReviewTask(harness.sqlite, 'task-6b')
    const auth = harnessAuth('agent-oracle', [{ member_id: 'member-of-harness-token', scope_type: 'squad', scope_id: SQUAD, capability: 'member' } as CapabilityGrant])

    const result = expectApplied(await invokeVerdict(env, auth, { task_id: 'task-6b', verdict: 'approved', human_origin: origin() }))
    // Refused at the dry-run gate, NOT with chat_already_bound — an
    // unauthorized caller learns nothing about whether the target chat_id
    // is already bound to someone else.
    expect(result.human_origin).toEqual({ applied: false, reason: 'origin_not_gate_authorized' })
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
  // mupot#1425 fix round: replay protection now lives entirely INSIDE the
  // commit phase (commitOriginDecision's atomic reservation INSERT), reached
  // only after a passing dry run — including the per-member rate limit. A
  // literal SECOND sequential API call with the same origin is therefore no
  // longer the right way to exercise the reservation-collision code path:
  // deciding the SAME task twice hits `not_in_review` first (the task
  // already left 'review'), and deciding a DIFFERENT task within the rate
  // window hits `origin_rate_limited` first — both are correct, intentional
  // early refusals, not the reservation mechanism itself. The reservation
  // collision is a genuine CONCURRENT-attempt defense (two racing callers
  // both passing their own dry run before either commits); we exercise it
  // directly and deterministically by pre-seeding the exact receipt row a
  // colliding concurrent attempt would have already committed, rather than
  // relying on real scheduling nondeterminism.
  it('origin_replayed — a pre-existing reservation at the same (chat, message) key refuses the WHOLE call with a hard 409, no verdict, no bind', async () => {
    seedAgent(harness.sqlite, 'agent-replay')
    seedMember(harness.sqlite, 'member-replay', { telegramChatId: null })
    setAgentOwner(harness.sqlite, 'agent-replay', 'member-replay')
    seedSquadMemberCapability(harness.sqlite, 'member-replay')
    seedGateGrant(harness.sqlite, 'member', 'member-replay')
    seedReviewTask(harness.sqlite, 'task-10')
    const auth = harnessAuth('agent-replay')

    // Simulate a reservation already committed for this exact (chat_id,
    // message_id) key — e.g. a genuinely concurrent racer that won, or a
    // stale retry of an already-decided message. This call's own dry run
    // WOULD pass (member is authorized) — the refusal must come from the
    // reservation collision itself, not from any of the earlier conjuncts.
    harness.sqlite
      .prepare(
        `INSERT INTO telegram_webhook_receipts (tenant, update_id, telegram_user_id, request_digest, state, created_at)
         VALUES (?, ?, ?, ?, 'processing', ?)`,
      )
      .run(TENANT, 'origin:telegram:5551234:9001', '5551234', 'a'.repeat(64), new Date().toISOString())

    const result = await invokeVerdict(env, auth, { task_id: 'task-10', verdict: 'approved', human_origin: origin() })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected refusal')
    expect(result.status).toBe(409)
    expect(result.error).toBe('origin_replayed')

    const verdictCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM task_verdicts').first<{ n: number }>()
    expect(verdictCount?.n).toBe(0) // no verdict landed

    const member = await env.DB.prepare('SELECT telegram_chat_id FROM members WHERE id = ?')
      .bind('member-replay')
      .first<{ telegram_chat_id: string | null }>()
    expect(member?.telegram_chat_id).toBeNull() // no bind landed either — "a failure reserves nothing"
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

  it('mupot#1425 P2-5: rate limit is keyed on the resolved MEMBER, not the calling agent — a SECOND agent owned by the SAME member is also rate-limited', async () => {
    seedAgent(harness.sqlite, 'agent-rate-m1')
    seedAgent(harness.sqlite, 'agent-rate-m2')
    // agent-rate-m2 needs its OWN gate grant too — once rate-limited, the
    // call falls back to the agent's own authority, and that fallback must
    // itself succeed (as the agent) for the response body to be inspectable.
    seedGateGrant(harness.sqlite, 'agent', 'agent-rate-m2')
    seedMember(harness.sqlite, 'member-rate-shared', { telegramChatId: '5551234' })
    setAgentOwner(harness.sqlite, 'agent-rate-m1', 'member-rate-shared')
    setAgentOwner(harness.sqlite, 'agent-rate-m2', 'member-rate-shared')
    seedSquadMemberCapability(harness.sqlite, 'member-rate-shared')
    seedGateGrant(harness.sqlite, 'member', 'member-rate-shared')
    seedReviewTask(harness.sqlite, 'task-ratem1')
    seedReviewTask(harness.sqlite, 'task-ratem2')

    const first = expectApplied(await invokeVerdict(env, harnessAuth('agent-rate-m1'), {
      task_id: 'task-ratem1', verdict: 'approved', human_origin: origin({ message_id: '9301' }),
    }))
    expect(first.human_origin?.applied).toBe(true)

    // A DIFFERENT agent, owned by the SAME member — before the P2-5 fix this
    // would have applied (keyed on origin_agent_id), letting one member
    // rotate agents to bypass the rate limit entirely.
    const second = expectApplied(await invokeVerdict(env, harnessAuth('agent-rate-m2'), {
      task_id: 'task-ratem2', verdict: 'approved', human_origin: origin({ message_id: '9302' }),
    }))
    expect(second.human_origin).toEqual({ applied: false, reason: 'origin_rate_limited' })
  })

  // ── mupot#1425 P0-3 (kasra-review): the self-verdict gate is structurally
  // unreachable for a resolved MEMBER principal (principal.id is a member
  // id, task.assignee_agent_id is an agent id — they can never be equal).
  // The load-bearing substitute must independently produce the SAME 409
  // self_verdict a plain (non-origin) call already gets. ──────────────────
  it('P0-3: same agent, same task — WITH and WITHOUT human_origin both refuse 409 self_verdict (agent cannot carry its own approval)', async () => {
    seedAgent(harness.sqlite, 'agent-self-verdict')
    seedGateGrant(harness.sqlite, 'agent', 'agent-self-verdict')
    seedMember(harness.sqlite, 'member-self-owner', { telegramChatId: '5551234' })
    setAgentOwner(harness.sqlite, 'agent-self-verdict', 'member-self-owner')
    seedSquadMemberCapability(harness.sqlite, 'member-self-owner')
    seedGateGrant(harness.sqlite, 'member', 'member-self-owner')
    seedReviewTask(harness.sqlite, 'task-self', 'agent-self-verdict') // assignee IS the calling agent
    const auth = harnessAuth('agent-self-verdict', [{ member_id: 'member-of-harness-token', scope_type: 'squad', scope_id: SQUAD, capability: 'member' }])

    const plain = await invokeVerdict(env, auth, { task_id: 'task-self', verdict: 'approved' })
    expect(plain.ok).toBe(false)
    if (plain.ok) throw new Error('expected refusal')
    expect(plain.status).toBe(409)
    expect(plain.error).toBe('self_verdict')

    // Task is still 'review' (the refusal above never wrote anything) — the
    // SAME origin message can now be tried against the same task.
    const withOrigin = await invokeVerdict(env, auth, { task_id: 'task-self', verdict: 'approved', human_origin: origin() })
    expect(withOrigin.ok).toBe(false)
    if (withOrigin.ok) throw new Error('expected refusal')
    expect(withOrigin.status).toBe(409)
    expect(withOrigin.error).toBe('self_verdict')
  })

  it('assignee_conflict via agents.owner_member_id — the resolved member owns the ASSIGNEE agent (a DIFFERENT agent than the caller), with agent_keys left completely EMPTY (the prod-real case)', async () => {
    seedAgent(harness.sqlite, 'agent-conflict-harness-2')
    seedAgent(harness.sqlite, 'agent-conflict-assignee-2')
    seedGateGrant(harness.sqlite, 'agent', 'agent-conflict-harness-2')
    seedMember(harness.sqlite, 'member-conflict-2', { telegramChatId: '5551234' })
    setAgentOwner(harness.sqlite, 'agent-conflict-harness-2', 'member-conflict-2')
    setAgentOwner(harness.sqlite, 'agent-conflict-assignee-2', 'member-conflict-2') // SAME member owns BOTH — no agent_keys row anywhere
    seedSquadMemberCapability(harness.sqlite, 'member-conflict-2')
    seedGateGrant(harness.sqlite, 'member', 'member-conflict-2')
    seedReviewTask(harness.sqlite, 'task-conflict-2', 'agent-conflict-assignee-2')
    const auth = harnessAuth('agent-conflict-harness-2', [{ member_id: 'member-of-harness-token', scope_type: 'squad', scope_id: SQUAD, capability: 'member' }])

    const result = expectApplied(await invokeVerdict(env, auth, { task_id: 'task-conflict-2', verdict: 'approved', human_origin: origin() }))
    expect(result.human_origin).toEqual({ applied: false, reason: 'assignee_conflict' })
  })

  // ── mupot#1425 P0-2 (kasra-review K6): an agent owned by a member who
  // holds NO capabilities at all must never mint a binding — the call must
  // refuse overall, and NOTHING must have landed. ─────────────────────────
  it('P0-2: an owner with ZERO capabilities never gets bound — overall 403, telegram_chat_id stays NULL, zero receipts of any kind', async () => {
    seedAgent(harness.sqlite, 'agent-unauthorized')
    // Deliberately NO gate grant for the agent either — the fallback must
    // ALSO fail, so the overall call result is a clean refusal to assert on.
    seedMember(harness.sqlite, 'member-zero-caps', { telegramChatId: null })
    setAgentOwner(harness.sqlite, 'agent-unauthorized', 'member-zero-caps')
    // Deliberately NO squad capability, NO gate grant for member-zero-caps.
    seedReviewTask(harness.sqlite, 'task-unauth')
    const auth = harnessAuth('agent-unauthorized', [{ member_id: 'member-of-harness-token', scope_type: 'squad', scope_id: SQUAD, capability: 'member' }])
    const attemptedOrigin = origin({ chat_id: '424242', user_id: '424242' })

    const result = await invokeVerdict(env, auth, { task_id: 'task-unauth', verdict: 'approved', human_origin: attemptedOrigin })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected refusal')
    expect(result.status).toBe(403)

    const member = await env.DB.prepare('SELECT telegram_chat_id FROM members WHERE id = ?')
      .bind('member-zero-caps').first<{ telegram_chat_id: string | null }>()
    expect(member?.telegram_chat_id).toBeNull()

    const receiptCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM telegram_origin_bind_receipts').first<{ n: number }>()
    expect(receiptCount?.n).toBe(0)

    const reservationCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM telegram_webhook_receipts WHERE update_id = ?`,
    ).bind('origin:telegram:424242:9001').first<{ n: number }>()
    expect(reservationCount?.n).toBe(0) // "a failure reserves nothing"
  })

  // ── mupot#1425 P1-4 (kasra-review): the replay slot must not be
  // reachable by an UNAUTHORIZED caller — proven by showing an unowned
  // agent's attempt does NOT burn the (chat, message) slot for a later,
  // legitimately-owned-and-authorized agent using the exact same origin. ──
  it('P1-4: an UNOWNED agent cannot burn a (chat, message) slot — a later OWNED+authorized agent using the SAME origin still succeeds', async () => {
    seedAgent(harness.sqlite, 'agent-unowned-first')
    seedAgent(harness.sqlite, 'agent-owned-second')
    // Deliberately NO gate grant for agent-unowned-first — its fallback also
    // fails, so the task stays in 'review' for the second attempt.
    seedMember(harness.sqlite, 'member-victim', { telegramChatId: null })
    setAgentOwner(harness.sqlite, 'agent-owned-second', 'member-victim')
    seedSquadMemberCapability(harness.sqlite, 'member-victim')
    seedGateGrant(harness.sqlite, 'member', 'member-victim')
    seedReviewTask(harness.sqlite, 'task-p14')
    const sharedOrigin = origin({ chat_id: '909090', user_id: '909090', message_id: '4242' })

    const first = await invokeVerdict(env, harnessAuth('agent-unowned-first', [{ member_id: 'x', scope_type: 'squad', scope_id: SQUAD, capability: 'member' }]), {
      task_id: 'task-p14', verdict: 'approved', human_origin: sharedOrigin,
    })
    expect(first.ok).toBe(false) // unauthorized fallback also refused — no write of any kind

    const second = expectApplied(await invokeVerdict(env, harnessAuth('agent-owned-second'), {
      task_id: 'task-p14', verdict: 'approved', human_origin: sharedOrigin,
    }))
    expect(second.human_origin).toEqual({ applied: true, bound_now: true })
    expect(second.verdict.decided_by).toBe('member-victim')
  })

  // ── full chain: the P0-1 ceiling fix, proven to also close the
  // downstream task_verdict path — an owner_member_id set that the ceiling
  // BLOCKED means the field is still NULL, so a subsequent human_origin
  // call from that agent falls back exactly like any other unowned agent. ─
  it('full chain: a ceiling-BLOCKED owner_member_id set means task_verdict human_origin still falls back to agent_not_owned — no verdict as the intended victim, no binding, ever', async () => {
    seedAgent(harness.sqlite, 'agent-chain')
    seedGateGrant(harness.sqlite, 'agent', 'agent-chain')
    seedMember(harness.sqlite, 'member-org-owner-chain', { telegramChatId: null })
    harness.sqlite.prepare(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-chain-owner', 'member-org-owner-chain', 'org', NULL, 'owner')`,
    ).run()
    seedReviewTask(harness.sqlite, 'task-chain')

    const squadAdminAuth: AuthContext = {
      userId: 'squad-admin-chain', email: 'sa@test.com', role: 'member', tenant: TENANT,
      memberId: 'member-squad-admin-chain',
      capabilities: [{ member_id: 'member-squad-admin-chain', scope_type: 'squad', scope_id: SQUAD, capability: 'admin' }],
      boundAgentId: null,
    } as AuthContext

    const setOwner = await invokeTool(squadAdminAuth, env, 'update_agent', { agent: 'agent-chain', owner_member_id: 'member-org-owner-chain' }, ORIGIN)
    expect(setOwner.ok).toBe(false)
    if (setOwner.ok) throw new Error('expected refusal')
    expect(setOwner.status).toBe(403)
    expect(setOwner.error).toBe('target_rank_exceeds_ceiling')

    const result = expectApplied(await invokeVerdict(env, harnessAuth('agent-chain'), {
      task_id: 'task-chain', verdict: 'approved', human_origin: origin(),
    }))
    expect(result.human_origin).toEqual({ applied: false, reason: 'agent_not_owned' })
    expect(result.verdict.decided_by).toBe('agent-chain') // fell back to the agent, never the intended victim

    const owner = await env.DB.prepare('SELECT telegram_chat_id FROM members WHERE id = ?')
      .bind('member-org-owner-chain').first<{ telegram_chat_id: string | null }>()
    expect(owner?.telegram_chat_id).toBeNull()
  })

  // ── mupot#1425 P2-7 (kasra-review): decided_via/origin_agent_id had no
  // reader anywhere — "preserved for inspection with no inspector". This
  // proves the task-detail timeline (GET /api/tasks/:id, via
  // listTaskDispatchReceiptTimeline) now surfaces both. ───────────────────
  it('P2-7: the task-detail receipt timeline surfaces decided_via and the origin agent for a harness-attested verdict', async () => {
    seedAgent(harness.sqlite, 'agent-audit-visible')
    seedMember(harness.sqlite, 'member-audit-visible', { telegramChatId: '5551234' })
    setAgentOwner(harness.sqlite, 'agent-audit-visible', 'member-audit-visible')
    seedSquadMemberCapability(harness.sqlite, 'member-audit-visible')
    seedGateGrant(harness.sqlite, 'member', 'member-audit-visible')
    seedReviewTask(harness.sqlite, 'task-audit-visible')

    const result = expectApplied(await invokeVerdict(env, harnessAuth('agent-audit-visible'), {
      task_id: 'task-audit-visible', verdict: 'approved', human_origin: origin(),
    }))
    expect(result.human_origin?.applied).toBe(true)

    const timeline = await listTaskDispatchReceiptTimeline(env, 'task-audit-visible')
    expect(timeline.gate).toHaveLength(1)
    expect(timeline.gate[0]).toMatchObject({
      verdict: 'approved',
      decided_by_display: 'member-audit-visible', // the MEMBER, not the agent
      decided_via: 'agent_attested_origin',
      origin_agent_display: 'agent-audit-visible', // which agent's harness vouched
    })
  })
})
