// tests/tasks-verdict-gates.test.ts — mupot#1080 + #1081.
//
// #1080: callerHoldsGateCapability (src/tasks/index.ts) had no liveness check on
// the gate_grants principal — a bare `SELECT 1 FROM gate_grants` existence
// check. Suspending a member or pausing an agent did NOT revoke their
// gate-verdict authority as long as the grant row survived. Fixed via
// hasActiveGateGrant (src/gates/grants.ts), a per-principal-type
// status='active' join. This file proves BOTH directions:
//   1. Sensitivity: an active grant holder verdicts successfully; removing
//      the liveness clause would make a paused/suspended holder pass too
//      (mutation-provable both ways — see the paired active/inactive tests).
//   2. Reachability: the paused-agent FALSE branch is reached through the
//      REAL MCP auth path (authenticateMember, src/mcp/index.ts), not a
//      fabricated AuthContext. No auth path anywhere joins agents.status —
//      MCP's own token lookup only re-checks members.status (confirmed by
//      tests/mcp-token-identity.test.ts) — so a token bound to a PAUSED
//      agent, owned by an ACTIVE member, authenticates exactly like a live
//      one and carries boundAgentId through unfiltered. That is the
//      constructible caller this file uses.
//
// The suspended-MEMBER analogue is deliberately NOT built here as a
// dashboard-cookie-session fixture: mupot#1318 (filed 2026-09-04, this
// flight's own finding) tracks that a suspended member's PRE-EXISTING
// dashboard session survives suspension via a separate mechanism (session/
// member-status decoupling, not this file's gate_grants liveness join) — out
// of scope for #1080. The suspended-member case IS covered here, but through
// the caller that's actually reachable for a member principal: a plain
// gate_grants row check against hasActiveGateGrant directly (the same
// function callerHoldsGateCapability calls for ANY caller, member or agent),
// which is the unit the liveness fix lives in — reachability of the
// AuthContext shape for a member is already proven by
// tests/mcp-token-identity.test.ts's "suspended member authenticates to
// null" (member never even reaches this function with memberId set).
//
// #1081: evaluateVerdictGates (src/tasks/index.ts) is the shared predicate
// both the write route (POST /:id/verdict), its MCP twin (task_verdict), the
// IM twin (verdictReply), and the dashboard's read-side can_verdict all call.
// This file proves each of its FALSE branches is reachable by a constructible
// caller: gate:agent-self-completion (non-assignee, and the org-admin
// override), the gate:loops surface cap, and self-verdict.

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import type { Env, AuthContext } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { hasActiveGateGrant } from '../src/gates/grants'
import { callerHoldsGateCapability, evaluateVerdictGates, verdictPrincipal } from '../src/tasks'
import { authenticateMember } from '../src/mcp'

const TENANT = 'verdict-gates-test'
const RAW_TOKEN = 'paused-agent-live-token'
const TOKEN_HASH = createHash('sha256').update(RAW_TOKEN).digest('hex')

function makeEnv(harness: SqliteD1Harness): Env {
  return { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
}

function requestWith(rawToken: string) {
  return {
    req: {
      header: (name: string) => (name.toLowerCase() === 'authorization' ? `Bearer ${rawToken}` : undefined),
    },
  }
}

function seedBase(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.prepare(`INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept-1', 'Dept One')`).run()
  sqlite
    .prepare(`INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'squad-1', 'Squad One')`)
    .run()
}

function seedAgent(
  sqlite: SqliteD1Harness['sqlite'],
  id: string,
  status: 'active' | 'paused' = 'active',
): void {
  sqlite
    .prepare(
      `INSERT INTO agents (id, squad_id, slug, name, role, model, status)
       VALUES (?, 'squad-1', ?, ?, 'member', 'test', ?)`,
    )
    .run(id, id, id, status)
}

function seedMember(
  sqlite: SqliteD1Harness['sqlite'],
  id: string,
  status: 'active' | 'suspended' = 'active',
): void {
  sqlite
    .prepare(`INSERT INTO members (id, email, display_name, status, tenant) VALUES (?, ?, ?, ?, ?)`)
    .run(id, `${id}@test.com`, id, status, TENANT)
}

function seedGrant(
  sqlite: SqliteD1Harness['sqlite'],
  capability: string,
  principalType: 'member' | 'agent',
  principalId: string,
): void {
  sqlite
    .prepare(
      `INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
       VALUES (?, ?, ?, ?, 'test-granter', datetime('now'))`,
    )
    .run(`grant-${capability}-${principalType}-${principalId}`, capability, principalType, principalId)
}

/** A member-bound token, welded to an agent via the real 0071 trigger's
 *  precondition (agent_member_bindings), exactly as tests/mcp-token-identity.test.ts
 *  does — the SAME fixture shape the real MCP auth path requires to construct
 *  a boundAgentId AuthContext. */
function seedAgentBoundToken(sqlite: SqliteD1Harness['sqlite'], memberId: string, agentId: string): void {
  seedMember(sqlite, memberId, 'active')
  sqlite
    .prepare(
      `INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
       VALUES (?, ?, ?, datetime('now'))`,
    )
    .run(TENANT, agentId, memberId)
  sqlite
    .prepare(
      `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
       VALUES (?, ?, ?, 'test', 'workspace', datetime('now'), ?, ?)`,
    )
    .run(`tok-${agentId}`, memberId, TOKEN_HASH, agentId, TENANT)
}

describe('hasActiveGateGrant — mupot#1080 liveness join', () => {
  let harness: SqliteD1Harness
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedBase(harness.sqlite)
  })
  afterEach(() => harness.close())

  it('active agent holding the grant: granted', async () => {
    seedAgent(harness.sqlite, 'agent-active', 'active')
    seedGrant(harness.sqlite, 'gate:outreach', 'agent', 'agent-active')
    const env = makeEnv(harness)
    await expect(hasActiveGateGrant(env, 'gate:outreach', 'agent', 'agent-active')).resolves.toBe(true)
  })

  it('SENSITIVITY: a PAUSED agent holding the identical grant row: NOT granted', async () => {
    seedAgent(harness.sqlite, 'agent-paused', 'paused')
    seedGrant(harness.sqlite, 'gate:outreach', 'agent', 'agent-paused')
    const env = makeEnv(harness)
    await expect(hasActiveGateGrant(env, 'gate:outreach', 'agent', 'agent-paused')).resolves.toBe(false)
  })

  it('active member holding the grant: granted', async () => {
    seedMember(harness.sqlite, 'member-active', 'active')
    seedGrant(harness.sqlite, 'gate:outreach', 'member', 'member-active')
    const env = makeEnv(harness)
    await expect(hasActiveGateGrant(env, 'gate:outreach', 'member', 'member-active')).resolves.toBe(true)
  })

  it('SENSITIVITY: a SUSPENDED member holding the identical grant row: NOT granted', async () => {
    seedMember(harness.sqlite, 'member-suspended', 'suspended')
    seedGrant(harness.sqlite, 'gate:outreach', 'member', 'member-suspended')
    const env = makeEnv(harness)
    await expect(hasActiveGateGrant(env, 'gate:outreach', 'member', 'member-suspended')).resolves.toBe(false)
  })

  it('no grant row at all: not granted (baseline)', async () => {
    seedAgent(harness.sqlite, 'agent-ungranted', 'active')
    const env = makeEnv(harness)
    await expect(hasActiveGateGrant(env, 'gate:outreach', 'agent', 'agent-ungranted')).resolves.toBe(false)
  })
})

describe('callerHoldsGateCapability — REACHABILITY via the real MCP auth path (mupot#1080)', () => {
  let harness: SqliteD1Harness
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedBase(harness.sqlite)
  })
  afterEach(() => harness.close())

  it('BEFORE the fix this would have passed: a PAUSED agent authenticates via a live token (owning member active) and, pre-#1080, its stale grant still honored — proves the fix by exercising the SAME real auth path', async () => {
    // Construct the caller the ONLY way #1080's brief calls "straightforward":
    // a paused agent with a live bound token. No mock AuthContext — this
    // AuthContext comes from calling the real authenticateMember, exactly as
    // src/mcp/index.ts's task_verdict tool would receive it.
    seedAgent(harness.sqlite, 'agent-paused-2', 'paused')
    seedAgentBoundToken(harness.sqlite, 'member-owner-of-paused', 'agent-paused-2')
    seedGrant(harness.sqlite, 'gate:outreach', 'agent', 'agent-paused-2')

    const env = makeEnv(harness)
    const auth = await authenticateMember({ ...requestWith(RAW_TOKEN), env })

    // Reachability witness: the real auth path DOES produce boundAgentId for
    // a paused agent — nothing upstream filters on agents.status.
    expect(auth).not.toBeNull()
    expect(auth!.boundAgentId).toBe('agent-paused-2')

    // verdictPrincipal (used by both callerHoldsGateCapability and
    // evaluateVerdictGates) resolves this caller's principal to the paused
    // agent, not the owning member — confirming the SAME principal a real
    // verdict write would check.
    expect(verdictPrincipal(auth!)).toMatchObject({ id: 'agent-paused-2', type: 'agent' })

    // THE FIX: callerHoldsGateCapability now refuses this caller.
    await expect(callerHoldsGateCapability(env, auth!, 'squad-1', 'gate:outreach')).resolves.toBe(false)
  })

  it('an ACTIVE agent authenticated the same way IS honored (positive control — the fix is not a blanket refusal)', async () => {
    seedAgent(harness.sqlite, 'agent-active-2', 'active')
    seedAgentBoundToken(harness.sqlite, 'member-owner-of-active', 'agent-active-2')
    seedGrant(harness.sqlite, 'gate:outreach', 'agent', 'agent-active-2')

    const env = makeEnv(harness)
    const auth = await authenticateMember({ ...requestWith(RAW_TOKEN), env })

    expect(auth!.boundAgentId).toBe('agent-active-2')
    await expect(callerHoldsGateCapability(env, auth!, 'squad-1', 'gate:outreach')).resolves.toBe(true)
  })

  it('org owner/admin bypasses regardless of grant liveness (legacy escape unaffected by the fix)', async () => {
    const env = makeEnv(harness)
    const ownerAuth: AuthContext = {
      userId: 'owner-1', email: null, role: 'owner', tenant: TENANT, memberId: 'owner-1',
    }
    await expect(callerHoldsGateCapability(env, ownerAuth, 'squad-1', 'gate:nonexistent')).resolves.toBe(true)
  })
})

describe('evaluateVerdictGates — mupot#1081 predicate parity, FALSE branches proven reachable', () => {
  let harness: SqliteD1Harness
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedBase(harness.sqlite)
  })
  afterEach(() => harness.close())

  function memberAuth(memberId: string, role: AuthContext['role'] = 'member'): AuthContext {
    return { userId: memberId, email: null, role, tenant: TENANT, memberId }
  }

  it('gate:agent-self-completion — the ASSIGNEE agent passes (no grant needed)', async () => {
    seedAgent(harness.sqlite, 'agent-self', 'active')
    seedAgentBoundToken(harness.sqlite, 'member-self', 'agent-self')
    const env = makeEnv(harness)
    const auth = await authenticateMember({ ...requestWith(RAW_TOKEN), env })
    const result = await evaluateVerdictGates(
      env,
      auth!,
      { squad_id: 'squad-1', gate_owner: 'gate:agent-self-completion', assignee_agent_id: 'agent-self' },
      'approved',
    )
    expect(result.allowed).toBe(true)
  })

  it('gate:agent-self-completion — REACHABLE false branch: a MEMBER holding a manually granted gate:agent-self-completion capability is still refused (the grant is NOT authority for this gate, BLOCK-1)', async () => {
    // Reachability: nothing prevents an admin from granting this capability
    // string to a member via POST /api/gates/grants — GATE_CAPABILITY_RE has
    // no exclusion for it (verified against src/gates/grants.ts). Seed
    // exactly that misconfiguration and prove it does NOT confer authority.
    seedMember(harness.sqlite, 'member-with-stray-grant', 'active')
    seedGrant(harness.sqlite, 'gate:agent-self-completion', 'member', 'member-with-stray-grant')
    seedAgent(harness.sqlite, 'agent-other-owner', 'active')
    const env = makeEnv(harness)
    const result = await evaluateVerdictGates(
      env,
      memberAuth('member-with-stray-grant'),
      { squad_id: 'squad-1', gate_owner: 'gate:agent-self-completion', assignee_agent_id: 'agent-other-owner' },
      'approved',
    )
    expect(result).toMatchObject({ allowed: false, code: 'no_gate_capability' })
  })

  it('gate:agent-self-completion — org admin override IS honored (legacy escape, distinct principal)', async () => {
    seedAgent(harness.sqlite, 'agent-someone-elses', 'active')
    const env = makeEnv(harness)
    const result = await evaluateVerdictGates(
      env,
      memberAuth('admin-1', 'admin'),
      { squad_id: 'squad-1', gate_owner: 'gate:agent-self-completion', assignee_agent_id: 'agent-someone-elses' },
      'approved',
    )
    expect(result.allowed).toBe(true)
  })

  it('gate:loops surface cap — REACHABLE false branch: caller holds gate:loops but NOT outreach:send-gated', async () => {
    seedMember(harness.sqlite, 'member-loops-only', 'active')
    seedGrant(harness.sqlite, 'gate:loops', 'member', 'member-loops-only')
    // Deliberately no outreach:send-gated grant.
    const env = makeEnv(harness)
    const result = await evaluateVerdictGates(
      env,
      memberAuth('member-loops-only'),
      { squad_id: 'squad-1', gate_owner: 'gate:loops', assignee_agent_id: null },
      'approved',
    )
    expect(result).toMatchObject({ allowed: false, code: 'missing_surface_cap' })
  })

  it('gate:loops surface cap — REJECT is not gated (positive control: same caller, verdict=rejected, allowed)', async () => {
    seedMember(harness.sqlite, 'member-loops-reject', 'active')
    seedGrant(harness.sqlite, 'gate:loops', 'member', 'member-loops-reject')
    const env = makeEnv(harness)
    const result = await evaluateVerdictGates(
      env,
      memberAuth('member-loops-reject'),
      { squad_id: 'squad-1', gate_owner: 'gate:loops', assignee_agent_id: null },
      'rejected',
    )
    expect(result.allowed).toBe(true)
  })

  it('gate:loops surface cap — holding BOTH grants: approved is honored', async () => {
    seedMember(harness.sqlite, 'member-loops-full', 'active')
    seedGrant(harness.sqlite, 'gate:loops', 'member', 'member-loops-full')
    seedGrant(harness.sqlite, 'outreach:send-gated', 'member', 'member-loops-full')
    const env = makeEnv(harness)
    const result = await evaluateVerdictGates(
      env,
      memberAuth('member-loops-full'),
      { squad_id: 'squad-1', gate_owner: 'gate:loops', assignee_agent_id: null },
      'approved',
    )
    expect(result.allowed).toBe(true)
  })

  it('self-verdict — REACHABLE false branch: an agent-bound caller who IS the assignee, on a non-self-completion gate', async () => {
    seedAgent(harness.sqlite, 'agent-assignee', 'active')
    seedAgentBoundToken(harness.sqlite, 'member-assignee-owner', 'agent-assignee')
    seedGrant(harness.sqlite, 'gate:outreach', 'agent', 'agent-assignee')
    const env = makeEnv(harness)
    const auth = await authenticateMember({ ...requestWith(RAW_TOKEN), env })
    const result = await evaluateVerdictGates(
      env,
      auth!,
      { squad_id: 'squad-1', gate_owner: 'gate:outreach', assignee_agent_id: 'agent-assignee' },
      'approved',
    )
    expect(result).toMatchObject({ allowed: false, code: 'self_verdict' })
  })

  it('self-verdict — positive control: a DIFFERENT agent holding the same grant is not self-verdicting', async () => {
    seedAgent(harness.sqlite, 'agent-decider', 'active')
    seedAgentBoundToken(harness.sqlite, 'member-decider-owner', 'agent-decider')
    seedGrant(harness.sqlite, 'gate:outreach', 'agent', 'agent-decider')
    const env = makeEnv(harness)
    const auth = await authenticateMember({ ...requestWith(RAW_TOKEN), env })
    const result = await evaluateVerdictGates(
      env,
      auth!,
      { squad_id: 'squad-1', gate_owner: 'gate:outreach', assignee_agent_id: 'agent-someone-else' },
      'approved',
    )
    expect(result.allowed).toBe(true)
  })

  it('no_gate_capability — REACHABLE false branch: a plain member with no grant at all', async () => {
    seedMember(harness.sqlite, 'member-no-grant', 'active')
    const env = makeEnv(harness)
    const result = await evaluateVerdictGates(
      env,
      memberAuth('member-no-grant'),
      { squad_id: 'squad-1', gate_owner: 'gate:outreach', assignee_agent_id: null },
      'approved',
    )
    expect(result).toMatchObject({ allowed: false, code: 'no_gate_capability' })
  })
})
