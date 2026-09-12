// tests/elevation-exact-action.test.ts — the exact-action approval contract
// (migrations/0152_elevation_action_bindings.sql, src/auth/exact-action.ts,
// src/auth/protected-action.ts). A host daemon (hostd) calls the new MCP tool
// verify_protected_action to ask "is THIS EXACT knowledge write approved?"
// before performing it — not merely "is action:knowledge_write elevated at
// all", which a live hasElevatedAction grant alone would answer too
// generously (any payload/target under a live grant).
//
// RED/GREEN framing: before this branch, an elevation_grants row for
// action:knowledge_write authorized ANY instance of that action — any
// payload, to any target, at any revision — for the life of the grant. Every
// "deny" assertion below is RED against a hasElevatedAction-only check (a
// live grant alone would return granted:true) and GREEN against this
// branch's exact-action binding check.
//
// Every MCP-tool-facing case goes through invokeTool (the real dispatch
// chokepoint — scripts/check-mcp-tool-seam.mjs enforces this: a test calling
// a ToolSpec's .run() directly bypasses AAGATE/schema validation and proves
// nothing about the path a real caller takes). The human-approval half uses
// decideElevationRequest directly, with a real web session and
// recentReauthOk:true — action:knowledge_write is in SENSITIVE_STEP_UP_ACTIONS,
// matching tests/elevation-squad-lead-e2e.test.ts's own pattern.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { invokeTool } from '../src/mcp'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import {
  decideElevationRequest,
  loadElevationActionBinding,
  revokeElevationGrant,
} from '../src/auth/elevation'
import { createWebSession, revokeWebSession } from '../src/auth/web-sessions'
import { revokeAgentSessionByCredential } from '../src/auth/agent-sessions'
import { canonicalExactActionJson, exactActionHash, validateExactActionInput, type ExactAction } from '../src/auth/exact-action'
import { verifyProtectedAction } from '../src/auth/protected-action'

const TENANT = 'tenant-exact-action'
const ORIGIN = 'https://pot.test'

const DEPT_ID = 'dept-1'
const SQUAD_ID = 'squad-1'
const AGENT_ID = 'agent-a'
const AGENT_MEMBER = 'member-agent-a'
const AGENT_TOKEN_ID = 'tok-agent-a-1'

const APPROVER_MEMBER_ID = 'member-approver'
const APPROVER_IDENTITY_ID = 'identity-approver'

let harness: SqliteD1Harness
let env: Env

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('${DEPT_ID}', 'dept', 'Dept');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', '${DEPT_ID}', 'squad', 'Squad');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES ('${AGENT_ID}', '${SQUAD_ID}', 'agent-a', 'Agent A', 'member', 'test', 'active');

    INSERT INTO members (id, tenant, display_name, status, created_at)
      VALUES ('${AGENT_MEMBER}', '${TENANT}', 'Agent A Member', 'active', datetime('now'));
    INSERT INTO members (id, tenant, email, display_name, status, created_at)
      VALUES ('${APPROVER_MEMBER_ID}', '${TENANT}', 'approver@x.test', 'Approver', 'active', datetime('now'));

    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', '${AGENT_ID}', '${AGENT_MEMBER}', datetime('now'));

    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at)
      VALUES ('${AGENT_TOKEN_ID}', '${AGENT_MEMBER}', 'hash-agent-a-1', 'primary', 'workspace', '${TENANT}', '${AGENT_ID}', datetime('now'));

    -- ORG-scope admin: hasElevatedAction's org-scope branch matches
    -- unconditionally regardless of the scope verify_protected_action
    -- queries with (see protected-action.ts's default-scope doc comment).
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-org-admin', '${APPROVER_MEMBER_ID}', 'org', NULL, 'admin');

    INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at)
      VALUES ('${APPROVER_IDENTITY_ID}', '${TENANT}', 'google', '${APPROVER_MEMBER_ID}', 'approver@x.test', '${APPROVER_MEMBER_ID}', datetime('now'));
  `)
}

function agentAuth(): AuthContext {
  return {
    userId: AGENT_MEMBER,
    memberId: AGENT_MEMBER,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENT_ID,
    tokenId: AGENT_TOKEN_ID,
    capabilities: [],
  } as unknown as AuthContext
}

const ORG_ADMIN_CAPABILITIES: CapabilityGrant[] = [
  { member_id: APPROVER_MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'admin' },
]

async function checkIn(): Promise<string> {
  const res = await invokeTool(agentAuth(), env, 'check_in', {}, ORIGIN)
  if (!res.ok) throw new Error(`setup: check_in failed: ${JSON.stringify(res)}`)
  return (res.result as { agent_session: { id: string } }).agent_session.id
}

interface ExactActionFields {
  target: { system: string; id: string; revision: string }
  expected_revision: string
  payload_hash: string
  destination: string
  operation: string
  expires_at: string
}

function fixtureExactAction(overrides: Partial<ExactActionFields> = {}, nowMs: number): ExactActionFields {
  return {
    target: { system: 'wiki', id: 'page-42', revision: 'rev-7' },
    expected_revision: 'rev-7',
    payload_hash: 'a'.repeat(64),
    destination: 'content/en/notes/page-42.mdx',
    operation: 'upsert',
    expires_at: new Date(nowMs + 10 * 60 * 1000).toISOString(),
    ...overrides,
  }
}

/** The hash a correctly-behaving caller (or this codebase's own
 *  createElevationRequest) computes: principal/tenant are ALWAYS
 *  server-derived, never part of the caller's own exact_action argument. */
async function serverHashFor(fields: ExactActionFields): Promise<string> {
  const action: ExactAction = { principal: AGENT_ID, tenant: TENANT, ...fields }
  return exactActionHash(action)
}

/** Full happy-path setup: check in, request_elevation via invokeTool with an
 *  exact_action, approve it as a human (decideElevationRequest directly, per
 *  the task's prescribed split). Returns everything a test needs to mutate
 *  state afterward. */
async function setupApprovedKnowledgeWrite(
  nowMs: number,
  overrides: Partial<ExactActionFields> = {},
): Promise<{
  sessionId: string
  requestId: string
  grantId: string
  fields: ExactActionFields
  hash: string
  approverSessionHash: string
}> {
  const sessionId = await checkIn()
  const fields = fixtureExactAction(overrides, nowMs)

  const reqRes = await invokeTool(
    agentAuth(),
    env,
    'request_elevation',
    {
      actions: ['action:knowledge_write'],
      scope_type: 'org',
      scope_id: '',
      duration_minutes: 60,
      reason: 'write the approved page',
      exact_action: fields,
    },
    ORIGIN,
  )
  if (!reqRes.ok) throw new Error(`setup: request_elevation failed: ${JSON.stringify(reqRes)}`)
  const requestId = (reqRes.result as { request: { id: string } }).request.id
  expect((reqRes.result as { exact_action_bound: boolean }).exact_action_bound).toBe(true)

  const approverSession = await createWebSession(
    env,
    `raw-approver-${requestId}`,
    { tenant: TENANT, memberId: APPROVER_MEMBER_ID, loginIdentityId: APPROVER_IDENTITY_ID },
    nowMs,
  )
  // The approver's client must echo back the EXACT binding hash it rendered
  // (P0-2 fix) — in a real dashboard flow this comes from the approval
  // panel's own render of the binding; here it's the same server-computed
  // hash createElevationRequest itself would have stored.
  const hash = await serverHashFor(fields)
  const decision = await decideElevationRequest(
    env,
    {
      tenant: TENANT,
      requestId,
      decision: 'approve',
      selectedActions: ['action:knowledge_write'],
      decidedByMemberId: APPROVER_MEMBER_ID,
      decidedByCapabilities: ORG_ADMIN_CAPABILITIES,
      decidedByWebSessionHash: approverSession.id_hash,
      recentReauthOk: true,
      boundActionHash: hash,
    },
    nowMs,
  )
  if (!decision.ok) throw new Error(`setup: decision failed: ${JSON.stringify(decision)}`)
  return {
    sessionId,
    requestId,
    grantId: decision.grants[0].id,
    fields,
    hash,
    approverSessionHash: approverSession.id_hash,
  }
}

async function verify(exactActionHashArg: string, fields: ExactActionFields) {
  return invokeTool(
    agentAuth(),
    env,
    'verify_protected_action',
    {
      exact_action_hash: exactActionHashArg,
      target: fields.target,
      expected_revision: fields.expected_revision,
      payload_hash: fields.payload_hash,
      destination: fields.destination,
      operation: fields.operation,
      expires_at: fields.expires_at,
    },
    ORIGIN,
  )
}

async function usageRowCount(grantId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM elevation_usage_log WHERE elevation_grant_id = ?1`)
    .bind(grantId)
    .first<{ n: number }>()
  return Number(row?.n ?? 0)
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  seed(harness.sqlite)
  env = { DB: harness.db, TENANT_SLUG: TENANT } as unknown as Env
})

afterEach(() => {
  vi.useRealTimers()
  harness.sqlite.close()
})

describe('exact-action approval contract', () => {
  it('happy match: verify_protected_action admits the exact approved action, logs usage exactly once', async () => {
    const t0 = Date.parse('2026-09-12T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(t0)

    const { grantId, fields, hash } = await setupApprovedKnowledgeWrite(t0)
    const res = await verify(hash, fields)
    expect(res.ok, JSON.stringify(res)).toBe(true)
    if (res.ok) {
      const approval = res.result as {
        issuer_member_id: string
        issuer_web_session_live: true
        grant_id: string
        bound_action_hash: string
        expires_at: string
        scope: { type: string; id: string }
      }
      expect(approval.issuer_member_id).toBe(APPROVER_MEMBER_ID)
      expect(approval.issuer_web_session_live).toBe(true)
      expect(approval.grant_id).toBe(grantId)
      expect(approval.bound_action_hash).toBe(hash)
      expect(approval.scope).toEqual({ type: 'org', id: '' })
    }

    expect(await usageRowCount(grantId)).toBe(1)
    const usageRow = await env.DB.prepare(
      `SELECT detail_json FROM elevation_usage_log WHERE elevation_grant_id = ?1`,
    ).bind(grantId).first<{ detail_json: string }>()
    const detail = JSON.parse(usageRow!.detail_json) as { action_hash: string }
    expect(detail.action_hash).toBe(hash)
  })

  it('wrong hash: client-claimed exact_action_hash does not match the server-computed one → deny, no usage row', async () => {
    const t0 = Date.parse('2026-09-12T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(t0)

    const { grantId, fields } = await setupApprovedKnowledgeWrite(t0)
    const wrongHash = 'f'.repeat(64)
    const res = await verify(wrongHash, fields)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('action_hash_mismatch')
    expect(await usageRowCount(grantId)).toBe(0)
  })

  it('never-approved payload: a correct self-computed hash for something nobody approved → deny (no_matching_grant), no usage row', async () => {
    // Post P0-1 matcher fix, hasElevatedAction itself already searches every
    // live candidate grant for one whose OWN binding matches the presented
    // hash (see the "two concurrent live bindings" test below) — so
    // presenting a hash for a payload that was NEVER approved under ANY live
    // grant is refused at that search (no_matching_grant), not at the later
    // redundant per-grant binding re-check (bound_action_mismatch), because
    // no candidate is ever returned to re-check in the first place.
    const t0 = Date.parse('2026-09-12T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(t0)

    const { grantId, fields } = await setupApprovedKnowledgeWrite(t0)
    const otherFields = fixtureExactAction({ payload_hash: 'b'.repeat(64), destination: 'content/en/notes/DIFFERENT.mdx' }, t0)
    const otherHash = await serverHashFor(otherFields)

    const res = await verify(otherHash, otherFields)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('no_matching_grant')
    expect(await usageRowCount(grantId)).toBe(0)
    // Original, actually-approved action is untouched and still verifies.
    const original = await verify(await serverHashFor(fields), fields)
    expect(original.ok).toBe(true)
  })

  it('two concurrent live bindings for the SAME session/action/scope: each verifies only its own payload, cross-presentation denied (P0-1 matcher fix)', async () => {
    // migrations/0153's whole point: a session may hold MULTIPLE live
    // action:knowledge_write grants at once (one per still-live exact
    // action). Before the P0-1 matcher fix, hasElevatedAction picked only
    // the MOST RECENTLY approved live grant for (action, scope) — so
    // approving B (page-B) after A (page-A) is still live would have made A
    // unverifiable (silently shadowed) even though A's own grant was never
    // revoked or expired. check_in reuses the SAME agent_sessions row for
    // this credential across both requests (production's own behavior), so
    // this reproduces the exact shape of the bug report.
    const t0 = Date.parse('2026-09-12T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(t0)

    const a = await setupApprovedKnowledgeWrite(t0, {
      target: { system: 'wiki', id: 'page-A', revision: 'rev-A' },
      expected_revision: 'rev-A',
      payload_hash: 'a'.repeat(64),
      destination: 'content/en/notes/page-A.mdx',
    })
    // Approved AFTER A, while A is still live — the exact "newer binding
    // shadows an older live one" scenario the matcher fix targets.
    const b = await setupApprovedKnowledgeWrite(t0, {
      target: { system: 'wiki', id: 'page-B', revision: 'rev-B' },
      expected_revision: 'rev-B',
      payload_hash: 'b'.repeat(64),
      destination: 'content/en/notes/page-B.mdx',
    })
    expect(a.sessionId).toBe(b.sessionId) // same reused agent session
    expect(a.requestId).not.toBe(b.requestId)
    expect(a.grantId).not.toBe(b.grantId)

    // A, approved FIRST and now the OLDER live grant, must still verify —
    // this is the case the pre-fix "first live scope-matching grant" logic
    // would have silently denied once B existed.
    const resA = await verify(a.hash, a.fields)
    expect(resA.ok, JSON.stringify(resA)).toBe(true)
    if (resA.ok) expect((resA.result as { grant_id: string }).grant_id).toBe(a.grantId)

    // B, the newer grant, verifies independently.
    const resB = await verify(b.hash, b.fields)
    expect(resB.ok, JSON.stringify(resB)).toBe(true)
    if (resB.ok) expect((resB.result as { grant_id: string }).grant_id).toBe(b.grantId)

    // Cross-presentation: claiming A's hash for B's fields (or the reverse)
    // is a hash mismatch, never a success laundered through the other grant.
    const crossAB = await verify(a.hash, b.fields)
    expect(crossAB.ok).toBe(false)
    const crossBA = await verify(b.hash, a.fields)
    expect(crossBA.ok).toBe(false)

    expect(await usageRowCount(a.grantId)).toBe(1)
    expect(await usageRowCount(b.grantId)).toBe(1)
  })

  it('A expired, then B approves and verifies for the SAME session/action/scope tuple (migrations/0153 regression)', async () => {
    // THE P0-1 bug, reproduced directly: migrations/0148's original
    // elevation_grants had a table-level UNIQUE(agent_session_id, action,
    // scope_type, scope_id) with NO revoked_at/expiry qualifier — so once A's
    // row existed for this exact tuple, EXPIRED or not, a second approval for
    // the same tuple threw a raw D1 UNIQUE-constraint error from the grant
    // INSERT, AFTER the status-flip UPDATE had already committed 'approved'
    // with zero grants — unrecoverable. migrations/0153 removes that
    // constraint; this proves the regression is closed end to end.
    const t0 = Date.parse('2026-09-12T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(t0)

    await checkIn()
    // A's own exact-action expires far in the future — only its GRANT (15
    // minutes) expires, isolating which ceiling is under test.
    const aFields = fixtureExactAction({ payload_hash: 'a'.repeat(64), expires_at: new Date(t0 + 24 * 60 * 60 * 1000).toISOString() }, t0)
    const reqA = await invokeTool(
      agentAuth(), env, 'request_elevation',
      { actions: ['action:knowledge_write'], scope_type: 'org', scope_id: '', duration_minutes: 15, reason: 'a', exact_action: aFields },
      ORIGIN,
    )
    if (!reqA.ok) throw new Error(JSON.stringify(reqA))
    const requestIdA = (reqA.result as { request: { id: string } }).request.id
    const hashA = await serverHashFor(aFields)
    const approverSessionA = await createWebSession(env, 'raw-approver-expired-a', { tenant: TENANT, memberId: APPROVER_MEMBER_ID, loginIdentityId: APPROVER_IDENTITY_ID }, t0)
    const decisionA = await decideElevationRequest(
      env,
      {
        tenant: TENANT, requestId: requestIdA, decision: 'approve', selectedActions: ['action:knowledge_write'],
        decidedByMemberId: APPROVER_MEMBER_ID, decidedByCapabilities: ORG_ADMIN_CAPABILITIES,
        decidedByWebSessionHash: approverSessionA.id_hash, recentReauthOk: true, boundActionHash: hashA,
      },
      t0,
    )
    if (!decisionA.ok) throw new Error(JSON.stringify(decisionA))

    // Past A's 15-minute grant — A is now a DEAD row for this tuple, never revoked.
    const t1 = t0 + 16 * 60 * 1000
    vi.setSystemTime(t1)
    expect((await verify(hashA, aFields)).ok).toBe(false) // sanity: A really is dead now

    const bFields = fixtureExactAction({ payload_hash: 'b'.repeat(64) }, t1)
    const reqB = await invokeTool(
      agentAuth(), env, 'request_elevation',
      { actions: ['action:knowledge_write'], scope_type: 'org', scope_id: '', duration_minutes: 60, reason: 'b', exact_action: bFields },
      ORIGIN,
    )
    expect(reqB.ok, JSON.stringify(reqB)).toBe(true)
    const requestIdB = (reqB.result as { request: { id: string } }).request.id
    const hashB = await serverHashFor(bFields)
    const approverSessionB = await createWebSession(env, 'raw-approver-expired-b', { tenant: TENANT, memberId: APPROVER_MEMBER_ID, loginIdentityId: APPROVER_IDENTITY_ID }, t1)
    const decisionB = await decideElevationRequest(
      env,
      {
        tenant: TENANT, requestId: requestIdB, decision: 'approve', selectedActions: ['action:knowledge_write'],
        decidedByMemberId: APPROVER_MEMBER_ID, decidedByCapabilities: ORG_ADMIN_CAPABILITIES,
        decidedByWebSessionHash: approverSessionB.id_hash, recentReauthOk: true, boundActionHash: hashB,
      },
      t1,
    )
    // THE regression assertion: pre-0153 this threw a raw UNIQUE-constraint
    // error and left request B's own row stuck at status='approved' with
    // zero grants (a SEPARATE bug from request A, which was already terminal).
    expect(decisionB.ok, JSON.stringify(decisionB)).toBe(true)

    const resB = await verify(hashB, bFields)
    expect(resB.ok, JSON.stringify(resB)).toBe(true)
  })

  it('A revoked, then B approves and verifies for the SAME session/action/scope tuple', async () => {
    const t0 = Date.parse('2026-09-12T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(t0)

    const a = await setupApprovedKnowledgeWrite(t0, { payload_hash: 'a'.repeat(64) })
    await revokeElevationGrant(env, TENANT, a.grantId, 'test-revoke', t0)
    expect((await verify(a.hash, a.fields)).ok).toBe(false) // sanity: A really is dead now

    const bFields = fixtureExactAction({ payload_hash: 'b'.repeat(64) }, t0)
    const reqB = await invokeTool(
      agentAuth(), env, 'request_elevation',
      { actions: ['action:knowledge_write'], scope_type: 'org', scope_id: '', duration_minutes: 60, reason: 'b', exact_action: bFields },
      ORIGIN,
    )
    expect(reqB.ok, JSON.stringify(reqB)).toBe(true)
    const requestIdB = (reqB.result as { request: { id: string } }).request.id
    const hashB = await serverHashFor(bFields)
    const approverSessionB = await createWebSession(env, 'raw-approver-revoked-b', { tenant: TENANT, memberId: APPROVER_MEMBER_ID, loginIdentityId: APPROVER_IDENTITY_ID }, t0)
    const decisionB = await decideElevationRequest(
      env,
      {
        tenant: TENANT, requestId: requestIdB, decision: 'approve', selectedActions: ['action:knowledge_write'],
        decidedByMemberId: APPROVER_MEMBER_ID, decidedByCapabilities: ORG_ADMIN_CAPABILITIES,
        decidedByWebSessionHash: approverSessionB.id_hash, recentReauthOk: true, boundActionHash: hashB,
      },
      t0,
    )
    expect(decisionB.ok, JSON.stringify(decisionB)).toBe(true)

    const resB = await verify(hashB, bFields)
    expect(resB.ok, JSON.stringify(resB)).toBe(true)
  })

  it('batch atomicity: a hard DB failure on the grant INSERT (FK violation) rolls back the status flip too — status stays pending, re-decidable', async () => {
    const t0 = Date.parse('2026-09-12T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(t0)

    await checkIn()
    const fields = fixtureExactAction({}, t0)
    const reqRes = await invokeTool(
      agentAuth(), env, 'request_elevation',
      { actions: ['action:knowledge_write'], scope_type: 'org', scope_id: '', duration_minutes: 60, reason: 'x', exact_action: fields },
      ORIGIN,
    )
    if (!reqRes.ok) throw new Error(JSON.stringify(reqRes))
    const requestId = (reqRes.result as { request: { id: string } }).request.id
    const hash = await serverHashFor(fields)

    await expect(
      decideElevationRequest(
        env,
        {
          tenant: TENANT, requestId, decision: 'approve', selectedActions: ['action:knowledge_write'],
          decidedByMemberId: APPROVER_MEMBER_ID, decidedByCapabilities: ORG_ADMIN_CAPABILITIES,
          // Bogus — no such row in web_sessions. The grant INSERT's
          // `approved_by_web_session_hash REFERENCES web_sessions(id_hash)`
          // fails with a FOREIGN KEY constraint error, inside the SAME
          // env.DB.batch() transaction as the status flip.
          decidedByWebSessionHash: 'does-not-exist-in-web-sessions',
          recentReauthOk: true, boundActionHash: hash,
        },
        t0,
      ),
    ).rejects.toThrow()

    const row = await env.DB.prepare(`SELECT status FROM elevation_requests WHERE id = ?1`).bind(requestId).first<{ status: string }>()
    expect(row?.status).toBe('pending')

    // Genuinely re-decidable afterward with a REAL approver session — the
    // failed attempt left no partial state behind.
    const approverSession = await createWebSession(env, 'raw-approver-retry', { tenant: TENANT, memberId: APPROVER_MEMBER_ID, loginIdentityId: APPROVER_IDENTITY_ID }, t0)
    const retry = await decideElevationRequest(
      env,
      {
        tenant: TENANT, requestId, decision: 'approve', selectedActions: ['action:knowledge_write'],
        decidedByMemberId: APPROVER_MEMBER_ID, decidedByCapabilities: ORG_ADMIN_CAPABILITIES,
        decidedByWebSessionHash: approverSession.id_hash, recentReauthOk: true, boundActionHash: hash,
      },
      t0,
    )
    expect(retry.ok, JSON.stringify(retry)).toBe(true)
  })

  it('expiry is exclusive: nowMs === binding.expires_at denies, nowMs === expires_at - 1ms admits', async () => {
    const t0 = Date.parse('2026-09-12T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(t0)

    const { fields, hash } = await setupApprovedKnowledgeWrite(t0, {
      expires_at: new Date(t0 + 5 * 60 * 1000).toISOString(),
    })
    const expiresAtMs = Date.parse(fields.expires_at)

    vi.setSystemTime(expiresAtMs - 1)
    const justBefore = await verify(hash, fields)
    expect(justBefore.ok, JSON.stringify(justBefore)).toBe(true)

    vi.setSystemTime(expiresAtMs)
    const atExpiry = await verify(hash, fields)
    expect(atExpiry.ok).toBe(false)
    if (!atExpiry.ok) expect(atExpiry.error).toBe('action_expired')
  })

  it('grant revoked → deny', async () => {
    const t0 = Date.parse('2026-09-12T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(t0)

    const { grantId, fields, hash } = await setupApprovedKnowledgeWrite(t0)
    await revokeElevationGrant(env, TENANT, grantId, 'test-revoke', t0)

    const res = await verify(hash, fields)
    expect(res.ok).toBe(false)
    expect(await usageRowCount(grantId)).toBe(0)
  })

  it('dead agent session (revoked) → deny', async () => {
    const t0 = Date.parse('2026-09-12T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(t0)

    const { grantId, fields, hash } = await setupApprovedKnowledgeWrite(t0)
    await revokeAgentSessionByCredential(env, TENANT, 'workspace_token', AGENT_TOKEN_ID, 'test-revoke', t0)

    const res = await verify(hash, fields)
    expect(res.ok).toBe(false)
    expect(await usageRowCount(grantId)).toBe(0)
  })

  it('approver lost capability → deny', async () => {
    const t0 = Date.parse('2026-09-12T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(t0)

    const { grantId, fields, hash } = await setupApprovedKnowledgeWrite(t0)
    await env.DB.prepare(`DELETE FROM capabilities WHERE member_id = ?1`).bind(APPROVER_MEMBER_ID).run()

    const res = await verify(hash, fields)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('approver_authority_lost')
    expect(await usageRowCount(grantId)).toBe(0)
  })

  it('approver web session revoked → deny', async () => {
    const t0 = Date.parse('2026-09-12T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(t0)

    const { grantId, fields, hash, approverSessionHash } = await setupApprovedKnowledgeWrite(t0)
    await revokeWebSession(env, TENANT, APPROVER_MEMBER_ID, approverSessionHash, 'logout', t0)

    const res = await verify(hash, fields)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('approver_session_ended')
    expect(await usageRowCount(grantId)).toBe(0)
  })

  it('self-issued JSON: a valid-looking hash with NO request/grant at all → deny', async () => {
    const t0 = Date.parse('2026-09-12T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(t0)

    await checkIn() // live session, but never requested or approved anything
    const fields = fixtureExactAction({}, t0)
    const hash = await serverHashFor(fields)

    const res = await verify(hash, fields)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('no_matching_grant')
  })

  it('request_elevation rejects an exact_action carrying extra principal/tenant keys → invalid_args', async () => {
    const t0 = Date.parse('2026-09-12T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(t0)

    await checkIn()
    const fields = fixtureExactAction({}, t0)
    const res = await invokeTool(
      agentAuth(),
      env,
      'request_elevation',
      {
        actions: ['action:knowledge_write'],
        scope_type: 'org',
        scope_id: '',
        duration_minutes: 60,
        reason: 'x',
        exact_action: { ...fields, principal: 'agent-a', tenant: TENANT },
      },
      ORIGIN,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('invalid_args')
  })

  it('reason-only body: request_elevation for action:knowledge_write with no exact_action → 400 invalid_elevation_request', async () => {
    const t0 = Date.parse('2026-09-12T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(t0)

    await checkIn()
    const res = await invokeTool(
      agentAuth(),
      env,
      'request_elevation',
      { actions: ['action:knowledge_write'], scope_type: 'org', scope_id: '', duration_minutes: 60, reason: 'just a reason' },
      ORIGIN,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('invalid_elevation_request')
  })

  it('adversarial gate P2-a: a past-dated exact_action.expires_at is refused at request time (would burn the (request_id, action) slot for nothing)', async () => {
    const t0 = Date.parse('2026-09-12T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(t0)

    await checkIn()
    // Exactly at nowMs — verifyProtectedAction's own expiry check is
    // exclusive (nowMs >= expires_at denies), so this could never be used
    // even the instant it was approved.
    const pastFields = fixtureExactAction({ expires_at: new Date(t0).toISOString() }, t0)
    const res = await invokeTool(
      agentAuth(),
      env,
      'request_elevation',
      {
        actions: ['action:knowledge_write'], scope_type: 'org', scope_id: '', duration_minutes: 60,
        reason: 'x', exact_action: pastFields,
      },
      ORIGIN,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('invalid_elevation_request')

    // Genuinely in the past (not just at the boundary) is refused the same way.
    const wayPastFields = fixtureExactAction({ expires_at: new Date(t0 - 60 * 60 * 1000).toISOString() }, t0)
    const res2 = await invokeTool(
      agentAuth(),
      env,
      'request_elevation',
      {
        actions: ['action:knowledge_write'], scope_type: 'org', scope_id: '', duration_minutes: 60,
        reason: 'x', exact_action: wayPastFields,
      },
      ORIGIN,
    )
    expect(res2.ok).toBe(false)
    if (!res2.ok) expect(res2.error).toBe('invalid_elevation_request')
  })

  it('approver == requester → forbidden, even with a bound exact action already inserted', async () => {
    const t0 = Date.parse('2026-09-12T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(t0)

    const sessionId = await checkIn()
    const fields = fixtureExactAction({}, t0)
    const reqRes = await invokeTool(
      agentAuth(),
      env,
      'request_elevation',
      {
        actions: ['action:knowledge_write'],
        scope_type: 'org',
        scope_id: '',
        duration_minutes: 60,
        reason: 'x',
        exact_action: fields,
      },
      ORIGIN,
    )
    if (!reqRes.ok) throw new Error(JSON.stringify(reqRes))
    const requestId = (reqRes.result as { request: { id: string } }).request.id

    // The binding landed (atomically, in the same batch as the request).
    const binding = await loadElevationActionBinding(env, TENANT, requestId, 'action:knowledge_write')
    expect(binding).not.toBeNull()

    const approverSession = await createWebSession(env, `raw-self-${sessionId}`, { tenant: TENANT, memberId: AGENT_MEMBER, loginIdentityId: APPROVER_IDENTITY_ID }, t0)
    const decision = await decideElevationRequest(
      env,
      {
        tenant: TENANT,
        requestId,
        decision: 'approve',
        selectedActions: ['action:knowledge_write'],
        decidedByMemberId: AGENT_MEMBER, // the REQUESTER's own member id
        decidedByCapabilities: ORG_ADMIN_CAPABILITIES,
        decidedByWebSessionHash: approverSession.id_hash,
        recentReauthOk: true,
      },
      t0,
    )
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.reason).toBe('forbidden')
  })

  it('verifyProtectedAction ignores a spoofed `principal` on its own input object — auth is the ONLY source', async () => {
    // The MCP tool's schema has no `principal` property at all (additionalProperties:false
    // strips it before verifyProtectedAction is ever called through invokeTool), so every
    // OTHER test in this file cannot exercise this function's own guarantee that principal
    // is server-derived — only a DIRECT call to verifyProtectedAction can. Calling the
    // function directly (not a ToolSpec) is not a mcp-tool-seam violation — see that
    // script's own scope (".run()" on an MCP tool object, not a plain exported function).
    const t0 = Date.parse('2026-09-12T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(t0)

    const { fields, hash } = await setupApprovedKnowledgeWrite(t0)
    // A caller reaching this function some way other than the MCP tool (a spoofed/extra
    // `principal` key that TypeScript's VerifyProtectedActionInput does not even declare)
    // must not be able to change which principal the hash is computed against.
    const spoofedInput = {
      exact_action_hash: hash,
      target: fields.target,
      expected_revision: fields.expected_revision,
      payload_hash: fields.payload_hash,
      destination: fields.destination,
      operation: fields.operation,
      expires_at: fields.expires_at,
      principal: 'someone-else', // not a declared field — only reachable via a raw call
    }
    const res = await verifyProtectedAction(env, agentAuth(), spoofedInput as never)
    expect(res.ok, JSON.stringify(res)).toBe(true)
  })

  it('canonical hash vector matches a Python-computed sha256 (json.dumps(obj, sort_keys=True, separators=(",",":"))).hexdigest())', async () => {
    // Computed via:
    //   python3 -c "import json,hashlib; obj={'principal':'agent-a','tenant':'mumega','target':{'system':'wiki','id':'page-42','revision':'rev-7'},'expected_revision':'rev-7','payload_hash':'a'*64,'destination':'content/en/notes/page-42.mdx','operation':'upsert','expires_at':'2026-09-12T00:10:00.000Z'}; c=json.dumps(obj, sort_keys=True, separators=(',',':')); print(c); print(hashlib.sha256(c.encode()).hexdigest())"
    const action: ExactAction = {
      principal: 'agent-a',
      tenant: 'mumega',
      target: { system: 'wiki', id: 'page-42', revision: 'rev-7' },
      expected_revision: 'rev-7',
      payload_hash: 'a'.repeat(64),
      destination: 'content/en/notes/page-42.mdx',
      operation: 'upsert',
      expires_at: '2026-09-12T00:10:00.000Z',
    }
    const hash = await exactActionHash(action)
    expect(hash).toBe('6081e905e513a492ede3da827faf5bd818ae9cc312cd97e9502b9b73bf27ac20')
  })

  // Second, independently-sourced compatibility vector — a hostd-side fixture
  // (schema hostd-exact-action-fixture/v1), loaded as pure DATA (readFileSync
  // + JSON.parse, never executed) and never seeded as a real grant/binding
  // anywhere. This is deliberately IN ADDITION TO the Python-derived vector
  // above, not a replacement — two independently-computed vectors agreeing
  // with this module's own output is stronger evidence than either alone.
  // Its target.revision deliberately contains a space
  // ("2026-09-01 00:00:00"), exercising that ASCII_PRINTABLE_RE (0x20-0x7E)
  // already includes the space character — verified directly below, not
  // assumed from the fixture's own internal consistency.
  it('hostd compatibility vector (tests/fixtures/exact-action-v1.json) matches canonicalExactActionJson + exactActionHash byte-for-byte', async () => {
    const raw = readFileSync(join(__dirname, 'fixtures', 'exact-action-v1.json'), 'utf8')
    const fixture = JSON.parse(raw) as {
      schema: string
      action: ExactAction
      canonical_utf8: string
      sha256: string
    }
    expect(fixture.schema).toBe('hostd-exact-action-fixture/v1')

    // A revision containing a space must validate — this module's
    // ASCII_PRINTABLE_RE (\x20-\x7E) already covers 0x20 (space); this
    // assertion proves that directly rather than trusting the fixture's own
    // claim about it.
    const validated = validateExactActionInput(fixture.action)
    expect(validated.ok, JSON.stringify(validated)).toBe(true)

    expect(canonicalExactActionJson(fixture.action)).toBe(fixture.canonical_utf8)
    expect(await exactActionHash(fixture.action)).toBe(fixture.sha256)
  })

  it('non-ASCII input is rejected at validation', () => {
    const result = validateExactActionInput({
      principal: 'agent-a',
      tenant: 'mumega',
      target: { system: 'wiki', id: 'page-42', revision: 'rev-7' },
      expected_revision: 'rev-7',
      payload_hash: 'a'.repeat(64),
      destination: 'content/en/notes/pagé-42.mdx', // non-ASCII é
      operation: 'upsert',
      expires_at: '2026-09-12T00:10:00.000Z',
    })
    expect(result.ok).toBe(false)
  })

  // ── adversarial gate P1: expires_at skipped the shared ASCII/length gate ──
  //
  // Before the fix, expires_at went straight to Date.parse with no
  // isAsciiPrintable/length check of its own — the ONE field among the nine
  // ASCII-validated ones with that gap. `Date.parse("Jan 1 2099 (café)")`
  // parses successfully in V8 (it treats the parenthesised suffix as
  // ignorable trailing content), so that string passed validation despite
  // containing a non-ASCII 'é' — and JS's non-ASCII-preserving JSON.stringify
  // vs. Python's ensure_ascii-escaping json.dumps would then compute
  // DIFFERENT hashes for the "same" canonical action (see exact-action.ts's
  // module header on the non-ASCII caveat). This table test iterates EVERY
  // ASCII-validated field (not just expires_at, so a regression on any OTHER
  // field is caught the same way) rather than special-casing one.
  const ASCII_VALIDATED_FIELD_PATHS = [
    'principal', 'tenant', 'target.system', 'target.id', 'target.revision',
    'expected_revision', 'destination', 'operation', 'expires_at',
  ] as const

  function baseValidAction(): Record<string, unknown> {
    return {
      principal: 'agent-a',
      tenant: 'mumega',
      target: { system: 'wiki', id: 'page-42', revision: 'rev-7' },
      expected_revision: 'rev-7',
      payload_hash: 'a'.repeat(64),
      destination: 'content/en/notes/page-42.mdx',
      operation: 'upsert',
      expires_at: '2026-09-12T00:10:00.000Z',
    }
  }

  function withField(path: (typeof ASCII_VALIDATED_FIELD_PATHS)[number], value: string): Record<string, unknown> {
    const a = baseValidAction()
    if (path.startsWith('target.')) {
      const key = path.slice('target.'.length)
      a.target = { ...(a.target as Record<string, unknown>), [key]: value }
    } else {
      a[path] = value
    }
    return a
  }

  it('anti-vacuity: the base fixture used by the table tests below actually validates', () => {
    const result = validateExactActionInput(baseValidAction())
    expect(result.ok, JSON.stringify(result)).toBe(true)
  })

  it.each(ASCII_VALIDATED_FIELD_PATHS)('%s rejects a non-ASCII value', (path) => {
    const result = validateExactActionInput(withField(path, 'pagé-42'))
    expect(result.ok, `${path} should have been rejected as non-ASCII`).toBe(false)
  })

  it.each(ASCII_VALIDATED_FIELD_PATHS)('%s rejects a 5000-character value (exceeds the field length bound)', (path) => {
    const result = validateExactActionInput(withField(path, 'a'.repeat(5000)))
    expect(result.ok, `${path} should have been rejected as oversized`).toBe(false)
  })

  it('expires_at: "Jan 1 2099 (café)" is rejected — Date.parse alone would have accepted this', () => {
    const CAFE_DATE = 'Jan 1 2099 (café)'
    // Sanity: prove Date.parse really would let this through un-gated — this
    // is the exact regression the P1 fix exists to close, not a strawman.
    expect(Number.isNaN(Date.parse(CAFE_DATE))).toBe(false)

    const result = validateExactActionInput(withField('expires_at', CAFE_DATE))
    expect(result.ok, JSON.stringify(result)).toBe(false)
  })
})
