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

import type { D1PreparedStatement, D1Result } from '@cloudflare/workers-types'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { invokeTool, mcpApp } from '../src/mcp/index'
import { mintMemberToken } from '../src/members/service'
import { listTaskDispatchReceiptTimeline } from '../src/tasks/runtime-receipts'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'origin-verdict-test'
const ORIGIN = 'https://pot.test'
const SQUAD = 'squad-1'
const GATE = 'gate:outreach'

// mupot#1889: the operator's HUMAN_ORIGIN_ATTESTOR_AGENT_IDS allowlist. seedAgent adds every agent it
// seeds (these fixtures model "the operator allowlisted this harness agent"); the #1889 tests remove
// an agent to model an owned agent whose workspace token must NOT be able to attest. The env reads it
// live through a getter, exactly as the helper reads the real var.
const attestors = new Set<string>()
function makeEnv(harness: SqliteD1Harness): Env {
  return {
    TENANT_SLUG: TENANT,
    DB: harness.db,
    get HUMAN_ORIGIN_ATTESTOR_AGENT_IDS() { return [...attestors].join(',') },
  } as unknown as Env
}

function seedBase(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.prepare(`INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept-1', 'Dept One')`).run()
  sqlite
    .prepare(`INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD}', 'dept-1', 'sq1', 'Squad One')`)
    .run()
}

function seedAgent(sqlite: SqliteD1Harness['sqlite'], id: string, status: 'active' | 'paused' = 'active'): void {
  attestors.add(id)
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
  projectId: string | null = null,
): void {
  sqlite
    .prepare(
      `INSERT INTO tasks (id, squad_id, project_id, title, body, done_when, status, gate_owner, assignee_agent_id, result, created_at, updated_at)
       VALUES (?, ?, ?, 'T', 'body', 'done', 'review', ?, ?, NULL, datetime('now'), datetime('now'))`,
    )
    .run(id, SQUAD, projectId, GATE, assigneeAgentId)
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
    // mint_agent_token issues channel 'workspace' (src/mcp/provision.ts); resolveAuth always sets a
    // channel, so a channel-less fixture modelled a shape production never builds (mupot#1889).
    channel: 'workspace',
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
    human_origin?: { applied: boolean; reason?: string }
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
    // text (round 4 addendum): generic fallback for a call site that does
    // not name a specific task — deliberately vague, so a test asserting
    // task_not_named or a specific task-naming behavior must pass its OWN
    // `text` override naming that exact task, not rely on this default.
    text: 'approve',
    ...overrides,
  }
}

describe('task_verdict human_origin — mupot#1424 harness-attested origin', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    attestors.clear()
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
      human_origin: origin({ text: 'approve task-1' }),
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

    const result = expectApplied(await invokeVerdict(env, auth, { task_id: 'task-2', verdict: 'approved', human_origin: origin({ text: 'approve task-2' }) }))
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

    const result = expectApplied(await invokeVerdict(env, auth, { task_id: 'task-3', verdict: 'approved', human_origin: origin({ text: 'approve task-3' }) }))
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
      human_origin: origin({ text: 'approve task-4', chat_id: '9999999' }), // != user_id
    }))
    expect(result.human_origin).toEqual({ applied: false, reason: 'invalid_origin_shape' })
    expect(result.verdict.decided_by).toBe('agent-shape')
  })

  // ── P3 (kasra-review r4): a MISSING `text` gets its own reason, distinct
  // from the generic shape bucket — an older harness build that has not
  // picked up the round-4 addendum yet is a common, actionable case, not a
  // malformed payload. ─────────────────────────────────────────────────────
  it('text_required — human_origin supplied with no text field at all: falls back to agent auth, distinct from invalid_origin_shape', async () => {
    seedAgent(harness.sqlite, 'agent-no-text')
    seedGateGrant(harness.sqlite, 'agent', 'agent-no-text')
    seedMember(harness.sqlite, 'member-no-text')
    setAgentOwner(harness.sqlite, 'agent-no-text', 'member-no-text')
    seedReviewTask(harness.sqlite, 'task-no-text')
    const auth = harnessAuth('agent-no-text', [{ member_id: 'member-of-harness-token', scope_type: 'squad', scope_id: SQUAD, capability: 'member' } as CapabilityGrant])

    const noTextOrigin = origin()
    delete noTextOrigin.text

    const result = expectApplied(await invokeVerdict(env, auth, {
      task_id: 'task-no-text',
      verdict: 'approved',
      human_origin: noTextOrigin,
    }))
    expect(result.human_origin).toEqual({ applied: false, reason: 'text_required' })
    expect(result.verdict.decided_by).toBe('agent-no-text')
  })

  // ── conjunct: never rebind an already-bound member to a different chat ──
  it('origin_member_mismatch — owner already bound to a DIFFERENT chat_id: falls back to agent auth, no write', async () => {
    seedAgent(harness.sqlite, 'agent-mismatch')
    seedGateGrant(harness.sqlite, 'agent', 'agent-mismatch')
    seedMember(harness.sqlite, 'member-mismatch', { telegramChatId: '1112222' })
    setAgentOwner(harness.sqlite, 'agent-mismatch', 'member-mismatch')
    seedReviewTask(harness.sqlite, 'task-5')
    const auth = harnessAuth('agent-mismatch', [{ member_id: 'member-of-harness-token', scope_type: 'squad', scope_id: SQUAD, capability: 'member' } as CapabilityGrant])

    const result = expectApplied(await invokeVerdict(env, auth, { task_id: 'task-5', verdict: 'approved', human_origin: origin({ text: 'approve task-5' }) }))
    expect(result.human_origin).toEqual({ applied: false, reason: 'origin_member_mismatch' })
    expect(result.verdict.decided_by).toBe('agent-mismatch')

    const member = await env.DB.prepare('SELECT telegram_chat_id FROM members WHERE id = ?')
      .bind('member-mismatch')
      .first<{ telegram_chat_id: string }>()
    expect(member?.telegram_chat_id).toBe('1112222') // unchanged
  })

  // ── conjunct: an origin NEVER binds a channel (credential act) ──────────
  // The owner must already be bound to the origin's chat via /account. An
  // unbound owner + an otherwise valid-looking origin is refused outright:
  // no member row change, no verdict as the member, no bind receipt, no
  // reservation. The agent's own-seat fallback is unchanged.
  async function snapshotUnbound(memberId: string) {
    const member = await env.DB.prepare('SELECT telegram_chat_id, telegram_bound_at FROM members WHERE id = ?')
      .bind(memberId).first<{ telegram_chat_id: string | null; telegram_bound_at: string | null }>()
    const memberVerdicts = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM task_verdicts WHERE decided_by = ? OR decided_via = 'agent_attested_origin'`,
    ).bind(memberId).first<{ n: number }>()
    const bindReceipts = await env.DB.prepare('SELECT COUNT(*) AS n FROM telegram_origin_bind_receipts').first<{ n: number }>()
    const reservations = await env.DB.prepare('SELECT COUNT(*) AS n FROM telegram_webhook_receipts WHERE update_id LIKE ?')
      .bind('origin:%').first<{ n: number }>()
    return { member, memberVerdicts: memberVerdicts?.n, bindReceipts: bindReceipts?.n, reservations: reservations?.n }
  }

  it('origin_chat_not_bound — unbound owner + fully valid-looking origin is REFUSED: no member row change, no member verdict, no bind receipt, no reservation', async () => {
    seedAgent(harness.sqlite, 'agent-nobind')
    seedGateGrant(harness.sqlite, 'agent', 'agent-nobind')
    seedMember(harness.sqlite, 'member-nobind', { telegramChatId: null })
    setAgentOwner(harness.sqlite, 'agent-nobind', 'member-nobind')
    // Fully authorized member otherwise — the ONLY thing missing is the bind.
    seedSquadMemberCapability(harness.sqlite, 'member-nobind')
    seedGateGrant(harness.sqlite, 'member', 'member-nobind')
    seedReviewTask(harness.sqlite, 'task-nobind')
    const before = await snapshotUnbound('member-nobind')
    expect(before.member).toEqual({ telegram_chat_id: null, telegram_bound_at: null })

    const result = expectApplied(await invokeVerdict(env, harnessAuth('agent-nobind'), {
      task_id: 'task-nobind', verdict: 'approved', human_origin: origin({ text: 'approve task-nobind' }),
    }))
    expect(result.human_origin).toEqual({ applied: false, reason: 'origin_chat_not_bound' })
    expect(result.verdict.decided_by).toBe('agent-nobind') // own-seat fallback only, never the member

    const after = await snapshotUnbound('member-nobind')
    expect(after.member).toEqual({ telegram_chat_id: null, telegram_bound_at: null }) // member row unchanged
    expect(after.memberVerdicts).toBe(0) // no verdict as the member
    expect(after.bindReceipts).toBe(0) // no bind receipt
    expect(after.reservations).toBe(0) // the message is not burned either
  })

  it('origin_chat_not_bound — same refusal when the origin chat is bound to a DIFFERENT member (no oracle on who holds a chat)', async () => {
    seedAgent(harness.sqlite, 'agent-taken')
    seedGateGrant(harness.sqlite, 'agent', 'agent-taken')
    seedMember(harness.sqlite, 'member-owner-unbound', { telegramChatId: null })
    seedMember(harness.sqlite, 'member-holds-chat', { telegramChatId: '5551234' }) // same chat_id as origin()
    setAgentOwner(harness.sqlite, 'agent-taken', 'member-owner-unbound')
    seedSquadMemberCapability(harness.sqlite, 'member-owner-unbound')
    seedGateGrant(harness.sqlite, 'member', 'member-owner-unbound')
    seedReviewTask(harness.sqlite, 'task-6')

    const result = expectApplied(await invokeVerdict(env, harnessAuth('agent-taken'), {
      task_id: 'task-6', verdict: 'approved', human_origin: origin({ text: 'approve task-6' }),
    }))
    expect(result.human_origin).toEqual({ applied: false, reason: 'origin_chat_not_bound' })
    expect(result.verdict.decided_by).toBe('agent-taken')

    const after = await snapshotUnbound('member-owner-unbound')
    expect(after.member).toEqual({ telegram_chat_id: null, telegram_bound_at: null })
    expect(after.memberVerdicts).toBe(0)
    expect(after.bindReceipts).toBe(0)
    expect(after.reservations).toBe(0)
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

    const result = expectApplied(await invokeVerdict(env, auth, { task_id: 'task-7', verdict: 'approved', human_origin: origin({ text: 'approve task-7' }) }))
    expect(result.human_origin).toEqual({ applied: false, reason: 'assignee_conflict' })
    expect(result.verdict.decided_by).toBe('agent-conflict-harness')
  })

  // ── positive path: owner already bound to this exact chat via /account ────────────────────
  it('applied:true — owner already bound to this exact chat_id, verdict decided_by the MEMBER, no bind receipt written', async () => {
    seedAgent(harness.sqlite, 'agent-prebound')
    seedMember(harness.sqlite, 'member-prebound', { telegramChatId: '5551234' })
    setAgentOwner(harness.sqlite, 'agent-prebound', 'member-prebound')
    seedSquadMemberCapability(harness.sqlite, 'member-prebound')
    seedGateGrant(harness.sqlite, 'member', 'member-prebound')
    seedReviewTask(harness.sqlite, 'task-9')
    const auth = harnessAuth('agent-prebound')

    const result = expectApplied(await invokeVerdict(env, auth, { task_id: 'task-9', verdict: 'approved', human_origin: origin({ text: 'approve task-9' }) }))
    expect(result.human_origin).toEqual({ applied: true })
    expect(result.verdict.decided_by).toBe('member-prebound')
    expect(result.verdict.decided_via).toBe('agent_attested_origin')
    expect(result.verdict.origin_agent_id).toBe('agent-prebound')

    const member = await env.DB.prepare('SELECT telegram_chat_id FROM members WHERE id = ?')
      .bind('member-prebound').first<{ telegram_chat_id: string | null }>()
    expect(member?.telegram_chat_id).toBe('5551234')
    const bindReceipts = await env.DB.prepare('SELECT COUNT(*) AS n FROM telegram_origin_bind_receipts').first<{ n: number }>()
    expect(bindReceipts?.n).toBe(0)
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
    seedMember(harness.sqlite, 'member-replay', { telegramChatId: '5551234' })
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

    const result = await invokeVerdict(env, auth, { task_id: 'task-10', verdict: 'approved', human_origin: origin({ text: 'approve task-10' }) })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected refusal')
    expect(result.status).toBe(409)
    expect(result.error).toBe('origin_replayed')

    const verdictCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM task_verdicts').first<{ n: number }>()
    expect(verdictCount?.n).toBe(0) // no verdict landed

    const member = await env.DB.prepare('SELECT telegram_chat_id FROM members WHERE id = ?')
      .bind('member-replay')
      .first<{ telegram_chat_id: string | null }>()
    expect(member?.telegram_chat_id).toBe('5551234') // binding untouched
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
      task_id: 'task-11', verdict: 'approved', human_origin: origin({ text: 'approve task-11', chat_id: '5551234', user_id: '5551234', message_id: '1' }),
    }))
    expect(first.human_origin?.applied).toBe(true)
    const second = expectApplied(await invokeVerdict(env, harnessAuth('agent-replay2b'), {
      task_id: 'task-12', verdict: 'approved', human_origin: origin({ text: 'approve task-12', chat_id: '7778888', user_id: '7778888', message_id: '2' }),
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
      task_id: 'task-13', verdict: 'approved', human_origin: origin({ text: 'approve task-13', message_at: elevenMinutesAgo }),
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
      task_id: 'task-14', verdict: 'approved', human_origin: origin({ text: 'approve task-14', message_at: twoMinutesFromNow }),
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
      task_id: 'task-15', verdict: 'approved', human_origin: origin({ text: 'approve task-15', message_at: nineMinutesAgo }),
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
      task_id: 'task-16', verdict: 'approved', human_origin: origin({ text: 'approve task-16', message_id: '9101' }),
    }))
    expect(first.human_origin).toEqual({ applied: true })

    // Same agent, same chat, a genuinely DIFFERENT (fresh, unreplayed) message
    // deciding a DIFFERENT task — the replay reservation does not catch this
    // (different digest), only the rate limit does.
    const second = expectApplied(await invokeVerdict(env, auth, {
      task_id: 'task-17', verdict: 'approved', human_origin: origin({ text: 'approve task-17', message_id: '9102' }),
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
      task_id: 'task-18', verdict: 'approved', human_origin: origin({ text: 'approve task-18', chat_id: '5551234', user_id: '5551234', message_id: '9201' }),
    }))
    expect(first.human_origin?.applied).toBe(true)

    const second = expectApplied(await invokeVerdict(env, harnessAuth('agent-rate-b'), {
      task_id: 'task-19', verdict: 'approved', human_origin: origin({ text: 'approve task-19', chat_id: '7778888', user_id: '7778888', message_id: '9202' }),
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
      task_id: 'task-ratem1', verdict: 'approved', human_origin: origin({ text: 'approve task-ratem1', message_id: '9301' }),
    }))
    expect(first.human_origin?.applied).toBe(true)

    // A DIFFERENT agent, owned by the SAME member — before the P2-5 fix this
    // would have applied (keyed on origin_agent_id), letting one member
    // rotate agents to bypass the rate limit entirely.
    const second = expectApplied(await invokeVerdict(env, harnessAuth('agent-rate-m2'), {
      task_id: 'task-ratem2', verdict: 'approved', human_origin: origin({ text: 'approve task-ratem2', message_id: '9302' }),
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
    const withOrigin = await invokeVerdict(env, auth, { task_id: 'task-self', verdict: 'approved', human_origin: origin({ text: 'approve task-self' }) })
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

    const result = expectApplied(await invokeVerdict(env, auth, { task_id: 'task-conflict-2', verdict: 'approved', human_origin: origin({ text: 'approve task-conflict-2' }) }))
    expect(result.human_origin).toEqual({ applied: false, reason: 'assignee_conflict' })
  })

  // ── mupot#1425 P0-2 (kasra-review K6): an agent owned by a member who
  // holds NO capabilities at all must never mint a binding — the call must
  // refuse overall, and NOTHING must have landed. ─────────────────────────
  it('P0-2: an owner with ZERO capabilities is never authorized — overall 403, binding untouched, zero receipts of any kind', async () => {
    seedAgent(harness.sqlite, 'agent-unauthorized')
    // Deliberately NO gate grant for the agent either — the fallback must
    // ALSO fail, so the overall call result is a clean refusal to assert on.
    seedMember(harness.sqlite, 'member-zero-caps', { telegramChatId: '424242' })
    setAgentOwner(harness.sqlite, 'agent-unauthorized', 'member-zero-caps')
    // Deliberately NO squad capability, NO gate grant for member-zero-caps.
    seedReviewTask(harness.sqlite, 'task-unauth')
    const auth = harnessAuth('agent-unauthorized', [{ member_id: 'member-of-harness-token', scope_type: 'squad', scope_id: SQUAD, capability: 'member' }])
    const attemptedOrigin = origin({ chat_id: '424242', user_id: '424242', text: 'approve task-unauth' })

    const result = await invokeVerdict(env, auth, { task_id: 'task-unauth', verdict: 'approved', human_origin: attemptedOrigin })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected refusal')
    expect(result.status).toBe(403)

    const member = await env.DB.prepare('SELECT telegram_chat_id FROM members WHERE id = ?')
      .bind('member-zero-caps').first<{ telegram_chat_id: string | null }>()
    expect(member?.telegram_chat_id).toBe('424242') // binding untouched

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
    seedMember(harness.sqlite, 'member-victim', { telegramChatId: '909090' })
    setAgentOwner(harness.sqlite, 'agent-owned-second', 'member-victim')
    seedSquadMemberCapability(harness.sqlite, 'member-victim')
    seedGateGrant(harness.sqlite, 'member', 'member-victim')
    seedReviewTask(harness.sqlite, 'task-p14')
    const sharedOrigin = origin({ chat_id: '909090', user_id: '909090', message_id: '4242', text: 'approve task-p14' })

    const first = await invokeVerdict(env, harnessAuth('agent-unowned-first', [{ member_id: 'x', scope_type: 'squad', scope_id: SQUAD, capability: 'member' }]), {
      task_id: 'task-p14', verdict: 'approved', human_origin: sharedOrigin,
    })
    expect(first.ok).toBe(false) // unauthorized fallback also refused — no write of any kind

    const second = expectApplied(await invokeVerdict(env, harnessAuth('agent-owned-second'), {
      task_id: 'task-p14', verdict: 'approved', human_origin: sharedOrigin,
    }))
    expect(second.human_origin).toEqual({ applied: true })
    expect(second.verdict.decided_by).toBe('member-victim')
  })

  // ── mupot#1425 round 2 P0-B (kasra-review K6b): writeVerdict's own
  // project-evidence fence used to fire AFTER the bind had already landed —
  // proven live: 403, task still 'review', zero task_verdicts, but a
  // durable Telegram bind HAD landed. assertVerdictWritable is now called
  // inside dryRunAuthorize, before ANY write. ─────────────────────────────
  it('P0-B: the project-write fence refuses BEFORE any write — telegram_chat_id stays as seeded, zero receipts, zero verdicts', async () => {
    seedAgent(harness.sqlite, 'agent-fence')
    seedGateGrant(harness.sqlite, 'agent', 'agent-fence')
    seedMember(harness.sqlite, 'member-fence', { telegramChatId: '515151' })
    setAgentOwner(harness.sqlite, 'agent-fence', 'member-fence')
    seedSquadMemberCapability(harness.sqlite, 'member-fence')
    seedGateGrant(harness.sqlite, 'member', 'member-fence')
    harness.sqlite.exec(`
      INSERT INTO projects (id, slug, name) VALUES ('proj-fence', 'proj-fence', 'Fenced Project');
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
        VALUES ('proj-fence', '${SQUAD}', 'write');
    `)
    seedReviewTask(harness.sqlite, 'task-fence', null, 'proj-fence')
    // The exact #399 scenario: the squad's write access to the project is
    // revoked AFTER the task was created — squadCanWriteProjectEvidence /
    // assertVerdictWritable exists to fence exactly this.
    harness.sqlite.exec(`DELETE FROM project_squad_access WHERE project_id = 'proj-fence' AND squad_id = '${SQUAD}'`)
    const auth = harnessAuth('agent-fence')

    const result = await invokeVerdict(env, auth, {
      task_id: 'task-fence', verdict: 'approved', human_origin: origin({ text: 'approve task-fence', chat_id: '515151', user_id: '515151' }),
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected refusal')
    expect(result.status).toBe(403)
    expect(result.error).toBe('forbidden')
    expect(result.detail).toEqual({ need: 'project_write' })

    const task = await env.DB.prepare('SELECT status FROM tasks WHERE id = ?').bind('task-fence').first<{ status: string }>()
    expect(task?.status).toBe('review') // nothing decided

    const verdictCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM task_verdicts').first<{ n: number }>()
    expect(verdictCount?.n).toBe(0)

    const member = await env.DB.prepare('SELECT telegram_chat_id FROM members WHERE id = ?')
      .bind('member-fence').first<{ telegram_chat_id: string | null }>()
    expect(member?.telegram_chat_id).toBe('515151') // binding untouched

    const receiptCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM telegram_origin_bind_receipts').first<{ n: number }>()
    expect(receiptCount?.n).toBe(0)

    const reservationCount = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM telegram_webhook_receipts WHERE update_id = ?',
    ).bind('origin:telegram:515151:9001').first<{ n: number }>()
    expect(reservationCount?.n).toBe(0) // "a failure reserves nothing"
  })

  // ── mupot#1425 round 2 P1-C (kasra-review T1): agent ownership was read
  // once in the dry run and never re-asserted at commit — an operator
  // revoking ownership in the instant between still minted a bind and a
  // verdict. Reproduced here by wrapping env.DB.batch to clear
  // owner_member_id the instant before the batch actually runs — the same
  // interleaving the reviewer drove directly against the production
  // statement. ─────────────────────────────────────────────────────────────
  it('P1-C: agent ownership cleared in the instant between the dry run and the commit batch — no verdict as the member', async () => {
    seedAgent(harness.sqlite, 'agent-race-ownership')
    seedGateGrant(harness.sqlite, 'agent', 'agent-race-ownership')
    seedMember(harness.sqlite, 'member-race-ownership', { telegramChatId: '5551234' })
    setAgentOwner(harness.sqlite, 'agent-race-ownership', 'member-race-ownership')
    seedSquadMemberCapability(harness.sqlite, 'member-race-ownership')
    seedGateGrant(harness.sqlite, 'member', 'member-race-ownership')
    seedReviewTask(harness.sqlite, 'task-race-ownership')

    const realBatch = env.DB.batch.bind(env.DB)
    // Wraps the ONE seam commitOriginDecision uses to write anything
    // (env.DB.batch) so the ownership row is cleared in the exact instant
    // between dryRunAuthorize's last read and the batch actually executing —
    // simulating a real concurrent admin revocation, not a contrived
    // internal hook.
    const raceEnv: Env = {
      ...env,
      DB: {
        ...env.DB,
        batch: (statements: D1PreparedStatement[]): Promise<D1Result[]> => {
          harness.sqlite.prepare('UPDATE agents SET owner_member_id = NULL WHERE id = ?').run('agent-race-ownership')
          return realBatch(statements)
        },
      } as unknown as Env['DB'],
    }

    const result = expectApplied(await invokeVerdict(raceEnv, harnessAuth('agent-race-ownership'), {
      task_id: 'task-race-ownership', verdict: 'approved', human_origin: origin({ text: 'approve task-race-ownership' }),
    }))
    expect(result.human_origin).toEqual({ applied: false, reason: 'agent_not_owned' })
    expect(result.verdict.decided_by).toBe('agent-race-ownership') // fell back to the agent

    const member = await env.DB.prepare('SELECT telegram_chat_id FROM members WHERE id = ?')
      .bind('member-race-ownership').first<{ telegram_chat_id: string | null }>()
    expect(member?.telegram_chat_id).toBe('5551234') // binding untouched

    const memberVerdictCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM task_verdicts WHERE decided_by = ? AND decided_via = 'agent_attested_origin'`,
    ).bind('member-race-ownership').first<{ n: number }>()
    expect(memberVerdictCount?.n).toBe(0) // no verdict AS the member
  })

  // ── The owner's chat binding changes in the instant between the dry run and the commit batch.
  // The dry run already refuses an unbound or mismatched owner, so only the verdict write's own
  // SQL guard (`telegram_chat_id = ?`) can refuse here. Same interleaving as P1-C. ─────────────
  for (const [label, rebindTo] of [['unbound', null], ['re-paired to another chat', '7778889']] as const) {
    it(`chat race: owner ${label} between the dry run and the commit batch — no verdict as the member`, async () => {
      const id = rebindTo === null ? 'unbind' : 'rebind'
      seedAgent(harness.sqlite, `agent-race-${id}`)
      seedGateGrant(harness.sqlite, 'agent', `agent-race-${id}`)
      seedMember(harness.sqlite, `member-race-${id}`, { telegramChatId: '5551234' })
      setAgentOwner(harness.sqlite, `agent-race-${id}`, `member-race-${id}`)
      seedSquadMemberCapability(harness.sqlite, `member-race-${id}`)
      seedGateGrant(harness.sqlite, 'member', `member-race-${id}`)
      seedReviewTask(harness.sqlite, `task-race-${id}`)

      const realBatch = env.DB.batch.bind(env.DB)
      const raceEnv: Env = {
        ...env,
        DB: {
          ...env.DB,
          batch: (statements: D1PreparedStatement[]): Promise<D1Result[]> => {
            harness.sqlite.prepare('UPDATE members SET telegram_chat_id = ? WHERE id = ?').run(rebindTo, `member-race-${id}`)
            return realBatch(statements)
          },
        } as unknown as Env['DB'],
      }

      const result = expectApplied(await invokeVerdict(raceEnv, harnessAuth(`agent-race-${id}`), {
        task_id: `task-race-${id}`, verdict: 'approved', human_origin: origin({ text: `approve task-race-${id}` }),
      }))
      expect(result.human_origin).toEqual({
        applied: false,
        reason: rebindTo === null ? 'origin_chat_not_bound' : 'origin_member_mismatch',
      })
      expect(result.verdict.decided_by).toBe(`agent-race-${id}`) // fell back to the agent

      const memberVerdictCount = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM task_verdicts WHERE decided_by = ? AND decided_via = 'agent_attested_origin'`,
      ).bind(`member-race-${id}`).first<{ n: number }>()
      expect(memberVerdictCount?.n).toBe(0) // no verdict AS the member
    })
  }

  // ── full chain: the P0-1 floor+ceiling fix, proven to also close the
  // downstream task_verdict path — an owner_member_id set that was BLOCKED
  // (here: at the org-scope FLOOR, since this actor is squad-admin only)
  // means the field is still NULL, so a subsequent human_origin call from
  // that agent falls back exactly like any other unowned agent. ──────────
  it('full chain: a floor-BLOCKED owner_member_id set means task_verdict human_origin still falls back to agent_not_owned — no verdict as the intended victim, no binding, ever', async () => {
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
    // Squad-admin-only actor: refused at the org-scope FLOOR (Athena, round
    // 2), before the ceiling is even evaluated.
    expect(setOwner.error).toBe('forbidden')
    expect(setOwner.detail).toEqual({ need: 'admin', scope: 'org' })

    const result = expectApplied(await invokeVerdict(env, harnessAuth('agent-chain'), {
      task_id: 'task-chain', verdict: 'approved', human_origin: origin({ text: 'approve task-chain' }),
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
      task_id: 'task-audit-visible', verdict: 'approved', human_origin: origin({ text: 'approve task-audit-visible' }),
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

  // ── mupot#1425 round 3 addendum (Athena's plugin r4 gate): an agent-bound
  // caller that supplies NO human_origin at all (e.g. the harness burned the
  // stamp client-side before relaying, or simply never attached one) used to
  // get a response body indistinguishable from an ordinary, pre-feature
  // agent-seat verdict — human_origin was absent from the body either way,
  // whether omitted outright or refused inside the resolver. Make the
  // outcome always visible for an agent-bound caller. ─────────────────────
  it('addendum: an agent-bound caller supplying NO human_origin at all still sees human_origin: {applied:false, reason:"absent"}', async () => {
    seedAgent(harness.sqlite, 'agent-no-origin')
    seedGateGrant(harness.sqlite, 'agent', 'agent-no-origin')
    seedReviewTask(harness.sqlite, 'task-no-origin')
    const auth = harnessAuth('agent-no-origin')

    const result = expectApplied(await invokeVerdict(env, auth, { task_id: 'task-no-origin', verdict: 'approved' }))
    expect(result.human_origin).toEqual({ applied: false, reason: 'absent' })
    expect(result.verdict.decided_by).toBe('agent-no-origin')
  })

  it('addendum: a NON-agent-bound principal supplying no human_origin sees NO human_origin field at all (unchanged)', async () => {
    seedMember(harness.sqlite, 'member-plain-no-origin')
    seedSquadMemberCapability(harness.sqlite, 'member-plain-no-origin')
    seedGateGrant(harness.sqlite, 'member', 'member-plain-no-origin')
    seedReviewTask(harness.sqlite, 'task-no-origin-2')

    const result = expectApplied(await invokeVerdict(env, nonBoundAuth('member-plain-no-origin'), {
      task_id: 'task-no-origin-2', verdict: 'approved',
    }))
    expect(result.human_origin).toBeUndefined()
    expect(result.verdict.decided_by).toBe('member-plain-no-origin')
  })

  // ── mupot#1425 round 4 (Athena's round-3 gate): "nothing pins the batch-
  // membership change." Athena mutated commitOriginDecision to pull the
  // task_verdicts INSERT out of the atomic env.DB.batch() call into its own
  // separate batch — the fence check untouched — and the full 518-test
  // suite stayed green, because no test asserted the verdict write and the
  // bind UPDATE ever have to share ONE transaction. Structural: capture
  // every statement list passed to env.DB.batch() and assert there is
  // EXACTLY ONE call, and that call's own statement list contains BOTH the
  // verdict INSERT and the bind UPDATE, verdict first. ─────────────────────
  it('round 4: the reservation and the verdict INSERT share ONE env.DB.batch() call, and no statement binds a channel — structural pin (Athena r3)', async () => {
    seedAgent(harness.sqlite, 'agent-batch-pin')
    seedGateGrant(harness.sqlite, 'agent', 'agent-batch-pin')
    seedMember(harness.sqlite, 'member-batch-pin', { telegramChatId: '5551234' })
    setAgentOwner(harness.sqlite, 'agent-batch-pin', 'member-batch-pin')
    seedSquadMemberCapability(harness.sqlite, 'member-batch-pin')
    seedGateGrant(harness.sqlite, 'member', 'member-batch-pin')
    seedReviewTask(harness.sqlite, 'task-batch-pin')

    const realBatch = env.DB.batch.bind(env.DB)
    const batchCalls: D1PreparedStatement[][] = []
    const pinEnv: Env = {
      ...env,
      DB: {
        ...env.DB,
        batch: (statements: D1PreparedStatement[]): Promise<D1Result[]> => {
          batchCalls.push(statements)
          return realBatch(statements)
        },
      } as unknown as Env['DB'],
    }

    const result = expectApplied(await invokeVerdict(pinEnv, harnessAuth('agent-batch-pin'), {
      task_id: 'task-batch-pin', verdict: 'approved', human_origin: origin({ text: 'approve task-batch-pin' }),
    }))
    expect(result.human_origin).toEqual({ applied: true })

    // Exactly ONE env.DB.batch() call for the whole commit — reservation,
    // task-status flip, verdict INSERT, bind UPDATE, and bind-receipt INSERT
    // all share ONE atomic transaction. A mutation pulling the verdict
    // statement into its own SEPARATE batch() call (Athena's b2) changes
    // this shape and must fail HERE, structurally — not merely leave a
    // downstream functional test green.
    expect(batchCalls).toHaveLength(1)
    const sqls = batchCalls[0].map((s) => (s as unknown as { sql: string }).sql)
    const reservationIdx = sqls.findIndex((sql) => sql.includes('INSERT INTO telegram_webhook_receipts'))
    const verdictIdx = sqls.findIndex((sql) => sql.includes('INSERT INTO task_verdicts'))
    expect(reservationIdx).toBeGreaterThanOrEqual(0)
    expect(verdictIdx).toBeGreaterThan(reservationIdx)
    // An origin never binds a channel: no statement in the commit touches
    // members.telegram_chat_id or writes a bind receipt.
    expect(sqls.some((sql) => sql.includes('UPDATE members'))).toBe(false)
    expect(sqls.some((sql) => sql.includes('telegram_origin_bind_receipts'))).toBe(false)
  })

  // ── same Athena ask, behavioral half: force the batch to fail EXACTLY on
  // the verdict statement (a real SQLite error, not a skipped call) and
  // prove the reservation — which shares this same
  // statement array — roll back with it. Real D1 batch semantics: any
  // statement THROW aborts the whole transaction; this proves the
  // production code actually relies on that, rather than merely asserting
  // it in a comment. ─────────────────────────────────────────────────────
  it('round 4: forcing a real SQLite failure on the verdict statement rolls back the reservation together with it', async () => {
    seedAgent(harness.sqlite, 'agent-batch-throw')
    seedGateGrant(harness.sqlite, 'agent', 'agent-batch-throw')
    seedMember(harness.sqlite, 'member-batch-throw', { telegramChatId: '5551234' })
    setAgentOwner(harness.sqlite, 'agent-batch-throw', 'member-batch-throw')
    seedSquadMemberCapability(harness.sqlite, 'member-batch-throw')
    seedGateGrant(harness.sqlite, 'member', 'member-batch-throw')
    seedReviewTask(harness.sqlite, 'task-batch-throw')

    const realBatch = env.DB.batch.bind(env.DB)
    const throwEnv: Env = {
      ...env,
      DB: {
        ...env.DB,
        batch: (statements: D1PreparedStatement[]): Promise<D1Result[]> => {
          const patched = statements.map((s) => {
            const sql = (s as unknown as { sql: string }).sql
            // Swap in a statement referencing a nonexistent table exactly
            // where the verdict INSERT would run — a genuine SQLite error
            // raised inside the SAME transaction the reservation and the
            // bind statements are also part of.
            return sql.includes('INSERT INTO task_verdicts')
              ? (env.DB.prepare('INSERT INTO __no_such_table_xyz__ (x) VALUES (1)') as unknown as D1PreparedStatement)
              : s
          })
          return realBatch(patched)
        },
      } as unknown as Env['DB'],
    }

    // invokeTool's own outer catch converts an unexpected thrown error into
    // a 500 response rather than propagating the rejection — assert THAT
    // shape rather than a raw throw.
    const res = await invokeVerdict(throwEnv, harnessAuth('agent-batch-throw'), {
      task_id: 'task-batch-throw', verdict: 'approved', human_origin: origin({ text: 'approve task-batch-throw' }),
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected refusal')
    expect(res.status).toBe(500)

    const verdictCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM task_verdicts').first<{ n: number }>()
    expect(verdictCount?.n).toBe(0)
    const reservationCount = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM telegram_webhook_receipts WHERE update_id = ?',
    ).bind('origin:telegram:5551234:9001').first<{ n: number }>()
    expect(reservationCount?.n).toBe(0) // rolled back together, not "reserved then abandoned"
    const member = await env.DB.prepare('SELECT telegram_chat_id FROM members WHERE id = ?')
      .bind('member-batch-throw').first<{ telegram_chat_id: string | null }>()
    expect(member?.telegram_chat_id).toBe('5551234') // binding untouched
  })

  // ── mupot#1425 round 4 (kasra-review round-3 BLOCK): the reviewer's exact
  // repro — "the bind must not land when the verdict doesn't." A concurrent
  // verdict flips the task's status in the instant between dryRunAuthorize's
  // last read and this commit batch; under the round-4 anchor design the
  // bind's ONLY guard is EXISTS(task_verdicts WHERE id=<this call's UUID>),
  // so if the verdict statement's own (now-identical) guard set refuses,
  // the bind cannot land either — by construction, not by a second,
  // separately-maintained guard. ─────────────────────────────────────────
  it('round 4 P0-1 exact repro: a concurrent verdict flips task status before the commit batch — no verdict, 409 verdict_race', async () => {
    seedAgent(harness.sqlite, 'agent-p0-1')
    seedGateGrant(harness.sqlite, 'agent', 'agent-p0-1')
    seedMember(harness.sqlite, 'member-p0-1', { telegramChatId: '5551234' })
    setAgentOwner(harness.sqlite, 'agent-p0-1', 'member-p0-1')
    seedSquadMemberCapability(harness.sqlite, 'member-p0-1')
    seedGateGrant(harness.sqlite, 'member', 'member-p0-1')
    seedReviewTask(harness.sqlite, 'task-p0-1')

    const realBatch = env.DB.batch.bind(env.DB)
    const raceEnv: Env = {
      ...env,
      DB: {
        ...env.DB,
        batch: (statements: D1PreparedStatement[]): Promise<D1Result[]> => {
          harness.sqlite.prepare("UPDATE tasks SET status = 'approved' WHERE id = ?").run('task-p0-1')
          return realBatch(statements)
        },
      } as unknown as Env['DB'],
    }

    const res = await invokeVerdict(raceEnv, harnessAuth('agent-p0-1'), {
      task_id: 'task-p0-1', verdict: 'approved', human_origin: origin({ text: 'approve task-p0-1' }),
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected refusal')
    expect(res.status).toBe(409)
    expect(res.error).toBe('verdict_race')

    const verdictCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM task_verdicts').first<{ n: number }>()
    expect(verdictCount?.n).toBe(0) // the loser inserted NOTHING

    const member = await env.DB.prepare('SELECT telegram_chat_id FROM members WHERE id = ?')
      .bind('member-p0-1').first<{ telegram_chat_id: string | null }>()
    expect(member?.telegram_chat_id).toBe('5551234') // binding untouched
  })

  // ── mupot#1425 round 4 addendum (plugin gate P2-1): bind INTENT server-
  // side — the target task id must be NAMED in `text`, or refuse with
  // task_not_named. Three cases: named in full, absent entirely, and naming
  // a DIFFERENT task. ────────────────────────────────────────────────────
  it('addendum: text names the task by an 8+ hex-char prefix of its id — applied', async () => {
    seedAgent(harness.sqlite, 'agent-named-ok')
    seedGateGrant(harness.sqlite, 'agent', 'agent-named-ok')
    seedMember(harness.sqlite, 'member-named-ok', { telegramChatId: '5551234' })
    setAgentOwner(harness.sqlite, 'agent-named-ok', 'member-named-ok')
    seedSquadMemberCapability(harness.sqlite, 'member-named-ok')
    seedGateGrant(harness.sqlite, 'member', 'member-named-ok')
    seedReviewTask(harness.sqlite, 'f9408956-aaaa-bbbb-cccc-000000000001')

    const result = expectApplied(await invokeVerdict(env, harnessAuth('agent-named-ok'), {
      task_id: 'f9408956-aaaa-bbbb-cccc-000000000001',
      verdict: 'approved',
      human_origin: origin({ text: 'approve f9408956' }),
    }))
    expect(result.human_origin?.applied).toBe(true)
    expect(result.verdict.decided_by).toBe('member-named-ok')
  })

  it('addendum: text says only "approve" with no task reference — task_not_named, falls back to agent authority', async () => {
    seedAgent(harness.sqlite, 'agent-named-absent')
    seedGateGrant(harness.sqlite, 'agent', 'agent-named-absent')
    seedMember(harness.sqlite, 'member-named-absent', { telegramChatId: '5559999' })
    setAgentOwner(harness.sqlite, 'agent-named-absent', 'member-named-absent')
    seedSquadMemberCapability(harness.sqlite, 'member-named-absent')
    seedGateGrant(harness.sqlite, 'member', 'member-named-absent')
    seedReviewTask(harness.sqlite, 'ab12cd34-aaaa-bbbb-cccc-000000000002')

    const result = expectApplied(await invokeVerdict(env, harnessAuth('agent-named-absent'), {
      task_id: 'ab12cd34-aaaa-bbbb-cccc-000000000002',
      verdict: 'approved',
      human_origin: origin({ text: 'approve', chat_id: '5559999', user_id: '5559999' }),
    }))
    expect(result.human_origin).toEqual({ applied: false, reason: 'task_not_named' })
    expect(result.verdict.decided_by).toBe('agent-named-absent') // fell back to the agent

    const verdictCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM task_verdicts WHERE decided_via = 'agent_attested_origin'`,
    ).first<{ n: number }>()
    expect(verdictCount?.n).toBe(0) // never landed AS the member
  })

  it('addendum: text names a DIFFERENT task than the one being decided — task_not_named, falls back to agent authority', async () => {
    seedAgent(harness.sqlite, 'agent-named-wrong')
    seedGateGrant(harness.sqlite, 'agent', 'agent-named-wrong')
    seedMember(harness.sqlite, 'member-named-wrong', { telegramChatId: '5558888' })
    setAgentOwner(harness.sqlite, 'agent-named-wrong', 'member-named-wrong')
    seedSquadMemberCapability(harness.sqlite, 'member-named-wrong')
    seedGateGrant(harness.sqlite, 'member', 'member-named-wrong')
    seedReviewTask(harness.sqlite, 'ab12cd34-aaaa-bbbb-cccc-000000000003')

    const result = expectApplied(await invokeVerdict(env, harnessAuth('agent-named-wrong'), {
      task_id: 'ab12cd34-aaaa-bbbb-cccc-000000000003',
      verdict: 'approved',
      human_origin: origin({ text: 'approve f9408956', chat_id: '5558888', user_id: '5558888' }),
    }))
    expect(result.human_origin).toEqual({ applied: false, reason: 'task_not_named' })
    expect(result.verdict.decided_by).toBe('agent-named-wrong')
  })

  // mupot#1602 r1 adversarial gate P3-1: "the Telegram human_origin refusal
  // (origin-verdict.ts dryRunAuthorize) is not referenced by any test... a
  // regression there would approve (though not publish) a gate:office task."
  // gate:office has its own dedicated verdict tool (office.review_approval);
  // dryRunAuthorize refuses it as its OWN, first check, before any origin
  // conjunct — and since the task_verdict tool's non-origin FALLBACK path
  // also routes through writeVerdict (which independently refuses gate:office,
  // NEW-2), this is a hard failure end to end, not merely "human_origin
  // didn't apply, fell back to agent authority" like every other conjunct
  // above.
  it('mupot#1602 r1 P3-1: a gate:office task refuses via the Telegram human_origin path — not merely "not applied", a hard failure end to end', async () => {
    seedAgent(harness.sqlite, 'agent-office-origin')
    harness.sqlite.prepare(
      `INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
       VALUES ('grant-office-agent-origin', 'gate:office', 'agent', 'agent-office-origin', 'test-granter', datetime('now'))`,
    ).run()
    seedMember(harness.sqlite, 'member-office-origin', { telegramChatId: '5559999' })
    // Every OTHER origin conjunct satisfied (owner, chat fence, no conflict of
    // interest, squad membership) so the flow genuinely REACHES dryRunAuthorize's
    // gate:office check rather than being refused earlier for an unrelated
    // reason — otherwise this test would pass whether or not that check exists.
    setAgentOwner(harness.sqlite, 'agent-office-origin', 'member-office-origin')
    seedSquadMemberCapability(harness.sqlite, 'member-office-origin')
    harness.sqlite.prepare(
      `INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
       VALUES ('grant-office-member-origin', 'gate:office', 'member', 'member-office-origin', 'test-granter', datetime('now'))`,
    ).run()
    harness.sqlite.prepare(
      `INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, assignee_agent_id, result, created_at, updated_at)
       VALUES (?, ?, 'Publish: origin test', 'body', 'done', 'review', 'gate:office', NULL, NULL, datetime('now'), datetime('now'))`,
    ).run('office-task-origin-1', SQUAD)

    const res = await invokeVerdict(env, harnessAuth('agent-office-origin'), {
      task_id: 'office-task-origin-1',
      verdict: 'approved',
      human_origin: origin({ text: 'approve office-task-origin-1', chat_id: '5559999', user_id: '5559999' }),
    })

    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected refusal')
    expect(res.error).toBe('dedicated_gate_predicate_required')

    const row = harness.sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get('office-task-origin-1') as { status: string }
    expect(row.status).toBe('review')
    const verdictCount = harness.sqlite.prepare(`SELECT COUNT(*) as n FROM task_verdicts WHERE task_id = ?`).get('office-task-origin-1') as { n: number }
    expect(verdictCount.n).toBe(0)
  })

  // ── mupot#1889: human_origin only from harness runtimes ─────────────────────────────────
  // Fully authorized scenario (owner bound to the exact chat, gate grant, squad cap): on the
  // unguarded code EVERY shape below would land a verdict AS the owner. Only the
  // KayHermes-shaped credential (agent-bound, non-directory, no consent/seat/harness marker,
  // i.e. what mint_agent_token issues) may.
  describe('mupot#1889 — session shapes that must not carry human_origin', () => {
    function seedAuthorizedOwner(agentId: string, memberId: string, taskId: string): void {
      seedAgent(harness.sqlite, agentId)
      seedMember(harness.sqlite, memberId, { telegramChatId: '5551234' })
      setAgentOwner(harness.sqlite, agentId, memberId)
      seedSquadMemberCapability(harness.sqlite, memberId)
      seedGateGrant(harness.sqlite, 'member', memberId)
      seedReviewTask(harness.sqlite, taskId)
    }

    async function expectRefusedClean(auth: AuthContext, taskId: string): Promise<void> {
      const res = await invokeVerdict(env, auth, { task_id: taskId, verdict: 'approved', human_origin: origin({ text: `approve ${taskId}` }) })
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('expected refusal')
      expect(res.status).toBe(400)
      expect(res.error).toBe('human_origin_not_applicable')
      const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM task_verdicts').first<{ n: number }>()
      expect(n?.n).toBe(0)
      const t = harness.sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }
      expect(t.status).toBe('review')
    }

    it('KayHermes-shaped credential (agent-bound workspace token from mint_agent_token) still applies', async () => {
      seedAuthorizedOwner('agent-kh', 'member-kh', 'task-kh')
      const res = expectApplied(await invokeVerdict(env, harnessAuth('agent-kh'), { task_id: 'task-kh', verdict: 'approved', human_origin: origin({ text: 'approve task-kh' }) }))
      expect(res.human_origin).toEqual({ applied: true })
      expect(res.verdict.decided_by).toBe('member-kh')
    })

    it('directory OAuth consent-bound session (built as buildAuthContextFromProps does) is refused', async () => {
      seedAuthorizedOwner('agent-oauth', 'member-oauth', 'task-oauth')
      const auth = {
        ...harnessAuth('agent-oauth', BASELINE_FLOOR_CAP),
        channel: 'directory',
        consentedByMemberId: 'member-oauth',
        latentCapabilities: BASELINE_FLOOR_CAP,
      } as AuthContext
      await expectRefusedClean(auth, 'task-oauth')
    })

    it('seat session (as applySeatHandle builds it) is refused', async () => {
      seedAuthorizedOwner('agent-seat', 'member-seat', 'task-seat')
      const auth = {
        ...harnessAuth('agent-seat', BASELINE_FLOOR_CAP),
        channel: 'directory',
        consentedByMemberId: 'member-seat',
        harnessId: 'h-1',
        seatBinding: { seatId: 's-1', label: 'seat', harnessId: 'h-1', grantTokenId: 'tok-1', humanMemberId: 'member-seat', source: 'handle' },
      } as AuthContext
      await expectRefusedClean(auth, 'task-seat')
    })

    // The allowlist is the real boundary: a workspace token has KayHermes's exact shape for every
    // owned agent (Claude Code, Cursor, Custom GPT Actions), so shape alone proves nothing.
    it('owned agent NOT on the attestor allowlist (plain workspace token) is refused', async () => {
      seedAuthorizedOwner('agent-owned-not-listed', 'member-nl', 'task-nl')
      attestors.delete('agent-owned-not-listed')
      attestors.add('some-other-agent')
      await expectRefusedClean(harnessAuth('agent-owned-not-listed'), 'task-nl')
    })
    it('empty / absent allowlist refuses every human_origin, even for the real harness shape', async () => {
      seedAuthorizedOwner('agent-empty', 'member-empty', 'task-empty')
      attestors.clear()
      await expectRefusedClean(harnessAuth('agent-empty'), 'task-empty')
      await expectRefusedClean(harnessAuth('agent-empty'), 'task-empty') // idempotent: still nothing written
      delete (env as { HUMAN_ORIGIN_ATTESTOR_AGENT_IDS?: string }).HUMAN_ORIGIN_ATTESTOR_AGENT_IDS
    })
    it('allowlist parsing tolerates spaces and an empty entry', async () => {
      seedAuthorizedOwner('agent-ws', 'member-ws', 'task-ws')
      attestors.add('') // joins as ",agent-ws" shape via the getter
      const res = expectApplied(await invokeVerdict(env, harnessAuth('agent-ws'), { task_id: 'task-ws', verdict: 'approved', human_origin: origin({ text: 'approve task-ws' }) }))
      expect(res.human_origin).toEqual({ applied: true })
    })

    // Production-shaped hop: a REAL minted workspace bearer (mintMemberToken, the writer behind
    // mint_agent_token) through the real Authorization -> authenticateMember -> tools/call path.
    async function bearerFor(agentId: string, agentMemberId: string): Promise<string> {
      seedMember(harness.sqlite, agentMemberId)
      seedSquadMemberCapability(harness.sqlite, agentMemberId)
      harness.sqlite
        .prepare(`INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES (?, ?, ?, datetime('now'))`)
        .run(TENANT, agentId, agentMemberId)
      const minted = await mintMemberToken(env, agentMemberId, `tok-${agentId}`, 'workspace', agentId)
      return minted.raw
    }
    async function postVerdict(raw: string, taskId: string): Promise<{ status: number; sc: Record<string, unknown>; text: string }> {
      const res = await mcpApp.fetch(new Request('https://pot.test/', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${raw}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'task_verdict', arguments: { task_id: taskId, verdict: 'approved', human_origin: origin({ text: `approve ${taskId}` }) } } }),
      }), env)
      const text = await res.text()
      const body = JSON.parse(text) as { result?: { structuredContent?: Record<string, unknown> } }
      return { status: res.status, sc: body.result?.structuredContent ?? {}, text }
    }
    it('POST bearer hop: allowlisted agent minted workspace token applies; same shape not on the list is refused', async () => {
      seedAuthorizedOwner('agent-wire-ok', 'member-wire-ok', 'task-wire-ok')
      // second owner has no bound chat (members.telegram_chat_id is UNIQUE); it must be refused before that matters
      seedAgent(harness.sqlite, 'agent-wire-no')
      seedMember(harness.sqlite, 'member-wire-no')
      setAgentOwner(harness.sqlite, 'agent-wire-no', 'member-wire-no')
      seedReviewTask(harness.sqlite, 'task-wire-no')
      attestors.delete('agent-wire-no')
      const okRaw = await bearerFor('agent-wire-ok', 'amem-ok')
      const noRaw = await bearerFor('agent-wire-no', 'amem-no')

      const ok = await postVerdict(okRaw, 'task-wire-ok')
      expect(ok.text).toContain('agent_attested_origin')
      const no = await postVerdict(noRaw, 'task-wire-no')
      expect(no.text).toContain('human_origin_not_applicable')
      const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM task_verdicts WHERE task_id = 'task-wire-no'`).first<{ n: number }>()
      expect(n?.n).toBe(0)
    })

    // Isolated conjuncts: each flips ONE marker on the otherwise-valid workspace shape, so
    // removing that single check from the guard fails exactly one of these.
    it('directory channel alone is refused', async () => {
      seedAuthorizedOwner('agent-d', 'member-d', 'task-d')
      await expectRefusedClean({ ...harnessAuth('agent-d'), channel: 'directory' } as AuthContext, 'task-d')
    })
    it('consentedByMemberId alone is refused', async () => {
      seedAuthorizedOwner('agent-c', 'member-c', 'task-c')
      await expectRefusedClean({ ...harnessAuth('agent-c'), consentedByMemberId: 'member-c' } as AuthContext, 'task-c')
    })
    it('seatBinding alone is refused', async () => {
      seedAuthorizedOwner('agent-s', 'member-s', 'task-s')
      const seatBinding = { seatId: 's', label: 'l', harnessId: 'h', grantTokenId: 't', humanMemberId: 'member-s', source: 'handle' } as const
      await expectRefusedClean({ ...harnessAuth('agent-s'), seatBinding } as AuthContext, 'task-s')
    })
    // invokeTool confines a harness-credential session to HARNESS_SESSION_ALLOWED_TOOLS BEFORE
    // run(), so this shape is refused 403 upstream and the guard's own harnessCredential
    // conjunct is defense in depth (unreachable through the tool path; not mutation-provable).
    it('harnessCredential session is refused (upstream 403) and writes nothing', async () => {
      seedAuthorizedOwner('agent-h', 'member-h', 'task-h')
      const res = await invokeVerdict(env, { ...harnessAuth('agent-h'), harnessCredential: true } as AuthContext, { task_id: 'task-h', verdict: 'approved', human_origin: origin({ text: 'approve task-h' }) })
      expect(res.ok).toBe(false)
      const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM task_verdicts').first<{ n: number }>()
      expect(n?.n).toBe(0)
    })
  })
})
