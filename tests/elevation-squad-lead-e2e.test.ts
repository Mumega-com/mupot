// tests/elevation-squad-lead-e2e.test.ts
//
// THE GOAL, EXECUTED.
//
//   "I don't want cairn to become admin. I want to give cairn access to make
//    their own agents and project, nothing outside of it."   — Hadi
//
// Everything else in this suite tests a mechanism. This file runs the SCENARIO,
// through invokeTool against schema built from the committed migrations, and
// asserts the whole shape of the ask:
//
//   1. the lead holds NO admin anywhere — not org, not department, not squad
//   2. before approval it cannot mint or create a project (the honest baseline)
//   3. a human approves TWO named actions, scoped
//   4. it creates an agent, mints that agent's credential, creates a project
//   5. nothing outside those actions opened up
//   6. it gains NO standing capability from any of it
//   7. when the window lapses, the doors shut again on their own
//
// Steps 2 and 5 are the load-bearing ones. Without 2, every success below could
// be standing authority the fixture handed out. Without 5, "nothing outside of
// it" is an assertion about intent rather than about behaviour.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { createElevationRequest, decideElevationRequest } from '../src/auth/elevation'
import { createWebSession } from '../src/auth/web-sessions'
import { resolveCapabilities } from '../src/auth/capability'

const TENANT = 'tenant-goal'
const ORIGIN = 'https://pot.test'

const DEPT_ID = 'dept-eng'
const LEAD_SQUAD_ID = 'squad-mcpwp'      // the lead's OWN squad
const OTHER_SQUAD_ID = 'squad-core'      // somebody else's squad — must stay shut
const OTHER_DEPT_ID = 'dept-finance'     // somebody else's department — must stay shut

const LEAD_AGENT_ID = 'agent-lead'
const LEAD_MEMBER_ID = 'member-lead'
const LEAD_TOKEN_ID = 'tok-lead-1'

const APPROVER_MEMBER_ID = 'member-approver'
const APPROVER_IDENTITY_ID = 'identity-approver'

let harness: SqliteD1Harness
let env: Env

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES
      ('${DEPT_ID}', 'eng', 'Engineering'),
      ('${OTHER_DEPT_ID}', 'finance', 'Finance');

    -- LIFT THE PLAN QUOTA. On the free tier maxDepartments/maxSquads are 1, so
    -- create_department and create_squad return a 400 quota refusal that reads
    -- EXACTLY like an authorization gate holding. Every "cannot" below has to
    -- fail for the right reason, so the quota is taken out of the picture first.
    INSERT INTO org_settings (key, value) VALUES ('billing_state', '{"tier":"scale"}')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;

    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('${LEAD_SQUAD_ID}', '${DEPT_ID}', 'mcpwp', 'MCPWP'),
      ('${OTHER_SQUAD_ID}', '${DEPT_ID}', 'core', 'Core Platform');

    INSERT INTO agents (id, squad_id, slug, name, status)
    VALUES ('${LEAD_AGENT_ID}', '${LEAD_SQUAD_ID}', 'cairn-like', 'Squad Lead', 'active');

    INSERT INTO members (id, display_name, status, tenant) VALUES
      ('${LEAD_MEMBER_ID}', 'Squad Lead Member', 'active', '${TENANT}'),
      ('${APPROVER_MEMBER_ID}', 'Approver', 'active', '${TENANT}');

    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
    VALUES ('${TENANT}', '${LEAD_AGENT_ID}', '${LEAD_MEMBER_ID}', '2026-09-01T00:00:00Z');

    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at)
    VALUES ('${LEAD_TOKEN_ID}', '${LEAD_MEMBER_ID}', 'hash-lead-1', 'primary', 'workspace', '${TENANT}', '${LEAD_AGENT_ID}', datetime('now'));

    -- THE ENTIRE STANDING AUTHORITY OF THE LEAD: 'lead' on its OWN squad.
    -- No org row. No department row. No admin anywhere. This one row is the
    -- premise of the whole file.
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
    VALUES ('cap-lead-own', '${LEAD_MEMBER_ID}', 'squad', '${LEAD_SQUAD_ID}', 'lead');

    -- The human. ORG-scope admin, which inherits to department and squad.
    --
    -- It has to be org scope, and that is itself a finding worth stating: an
    -- approver may never approve above their OWN authority, so a DEPARTMENT
    -- admin cannot approve the org-scoped action:project_lifecycle that
    -- project_create requires (measured: decideElevationRequest returns
    -- forbidden need:'admin' scope:{type:'org'}). Projects are workspace
    -- objects, so authorizing one is an org-level act no matter who asks.
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
    VALUES ('cap-approver', '${APPROVER_MEMBER_ID}', 'org', NULL, 'admin');

    INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at)
    VALUES ('${APPROVER_IDENTITY_ID}', '${TENANT}', 'google', '${APPROVER_MEMBER_ID}', 'approver@x.test', '${APPROVER_MEMBER_ID}', datetime('now'));
  `)
}

function leadAuth(): AuthContext {
  return {
    userId: LEAD_MEMBER_ID,
    memberId: LEAD_MEMBER_ID,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: LEAD_AGENT_ID,
    tokenId: LEAD_TOKEN_ID,
    capabilities: [
      { member_id: LEAD_MEMBER_ID, scope_type: 'squad', scope_id: LEAD_SQUAD_ID, capability: 'lead' },
    ],
  } as unknown as AuthContext
}

function memoryKv(): Env['SESSIONS'] {
  const store = new Map<string, string>()
  return {
    async put(key: string, value: string) { store.set(key, value) },
    async get(key: string) { return store.get(key) ?? null },
    async delete(key: string) { store.delete(key) },
  } as unknown as Env['SESSIONS']
}

async function checkIn(): Promise<string> {
  const res = await invokeTool(leadAuth(), env, 'check_in', {}, ORIGIN)
  if (!res.ok) throw new Error(`setup: check_in failed: ${JSON.stringify(res)}`)
  return (res.result as { agent_session: { id: string } }).agent_session.id
}

/** The human approval step, at an explicit scope. */
async function approve(
  sessionId: string,
  actions: string[],
  scopeType: 'org' | 'department' | 'squad',
  scopeId: string,
  durationMinutes: number,
  nowMs: number,
): Promise<void> {
  const approverSession = await createWebSession(
    env,
    `raw-approver-${scopeType}-${scopeId}-${nowMs}`,
    { tenant: TENANT, memberId: APPROVER_MEMBER_ID, loginIdentityId: APPROVER_IDENTITY_ID },
    nowMs,
  )
  const created = await createElevationRequest(
    env,
    {
      tenant: TENANT,
      agentSessionId: sessionId,
      agentId: LEAD_AGENT_ID,
      memberId: LEAD_MEMBER_ID,
      actions,
      scopeType,
      scopeId,
      durationMinutes,
      reason: 'standing up my squad',
    },
    nowMs,
  )
  if (!created.ok) throw new Error(`approve: request failed: ${JSON.stringify(created)}`)
  const decision = await decideElevationRequest(
    env,
    {
      tenant: TENANT,
      requestId: created.request.id,
      decision: 'approve',
      selectedActions: actions,
      decidedByMemberId: APPROVER_MEMBER_ID,
      // The approver's real grants: org admin, nothing more.
      decidedByCapabilities: [
        { member_id: APPROVER_MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'admin' },
      ],
      decidedByWebSessionHash: approverSession.id_hash,
      recentReauthOk: true,
    },
    nowMs,
  )
  if (!decision.ok) throw new Error(`approve: decision failed: ${JSON.stringify(decision)}`)
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  seed(harness.sqlite)
  env = {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    SESSIONS: memoryKv(),
    PUBLIC_ORIGIN: ORIGIN,
  } as unknown as Env
})

afterEach(() => {
  vi.useRealTimers()
  harness.sqlite.close()
})

describe('a squad lead stands up its own squad, with no admin anywhere', () => {
  it('holds exactly ONE standing grant: lead on its own squad', async () => {
    const caps = await resolveCapabilities(env, LEAD_MEMBER_ID)
    expect(caps).toHaveLength(1)
    expect(caps[0]).toMatchObject({ scope_type: 'squad', scope_id: LEAD_SQUAD_ID, capability: 'lead' })
    expect(caps.some((c) => c.capability === 'admin')).toBe(false)
    expect(caps.some((c) => c.scope_type === 'org')).toBe(false)
  })

  it('BASELINE — before any approval it can create an agent but NOT mint or make a project', async () => {
    await checkIn()
    // create_agent's floor is 'lead' on the squad, which it already holds. This
    // is the honest boundary: elevation is not what enables this step, and
    // saying so keeps the successes below attributable.
    const created = await invokeTool(
      leadAuth(), env, 'create_agent',
      { squad: LEAD_SQUAD_ID, slug: 'baseline-agent', name: 'Baseline' }, ORIGIN,
    )
    expect(created.ok).toBe(true)

    // These two are the ones that needed a human. They must be shut right now,
    // or every success later in this file proves nothing.
    const mint = await invokeTool(
      leadAuth(), env, 'mint_agent_token',
      { agent: (created.result as { agent: { id: string } }).agent.id }, ORIGIN,
    )
    expect(mint.ok).toBe(false)

    const project = await invokeTool(
      leadAuth(), env, 'project_create', { slug: 'mcpwp-site', name: 'MCPWP Site' }, ORIGIN,
    )
    expect(project.ok).toBe(false)
  })

  it('THE GOAL — approved for exactly two named actions, it makes its own agent, credential, and project', async () => {
    const t0 = Date.parse('2026-09-09T12:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(t0)

    const sessionId = await checkIn()

    // ── the human, twice, deliberately ──────────────────────────────────────
    // mint_token is squad-scoped: the credential belongs to an agent in THIS
    // squad. workspace_project is org-scoped because projects are workspace
    // objects (project_create gates on requireWorkspaceAdmin) — the approver
    // chooses that scope knowingly, and it still lapses on its own clock.
    //
    // It is a SEPARATE action key from action:project_lifecycle (squads) on
    // purpose: an org-scoped grant covers every scope, so one shared key would
    // make "may create its own project" silently mean "may create squads
    // anywhere in the org".
    await approve(sessionId, ['action:mint_token'], 'squad', LEAD_SQUAD_ID, 60, t0)
    await approve(sessionId, ['action:workspace_project'], 'org', '', 60, t0)

    // ── 1. its own agent ────────────────────────────────────────────────────
    const agentRes = await invokeTool(
      leadAuth(), env, 'create_agent',
      { squad: LEAD_SQUAD_ID, slug: 'mcpwp-writer', name: 'MCPWP Writer' }, ORIGIN,
    )
    expect(agentRes.ok, JSON.stringify(agentRes)).toBe(true)
    const newAgentId = (agentRes.result as { agent: { id: string } }).agent.id

    // ── 2. that agent's credential ──────────────────────────────────────────
    const mintRes = await invokeTool(
      leadAuth(), env, 'mint_agent_token', { agent: newAgentId, label: 'mcpwp-writer' }, ORIGIN,
    )
    expect(mintRes.ok, JSON.stringify(mintRes)).toBe(true)
    expect((mintRes.result as { token: { id: string } }).token.id).toBeTruthy()

    // ── 3. its own project ──────────────────────────────────────────────────
    const projectRes = await invokeTool(
      leadAuth(), env, 'project_create', { slug: 'mcpwp-site', name: 'MCPWP Site' }, ORIGIN,
    )
    expect(projectRes.ok, JSON.stringify(projectRes)).toBe(true)

    // ── 4. NOTHING OUTSIDE OF IT ────────────────────────────────────────────
    // Another squad's agent stays out of reach: the mint grant named THIS squad.
    const otherAgent = harness.sqlite.prepare(
      `INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-other', '${OTHER_SQUAD_ID}', 'other', 'Other', 'active')`,
    )
    otherAgent.run()
    const crossSquad = await invokeTool(
      leadAuth(), env, 'mint_agent_token', { agent: 'agent-other' }, ORIGIN,
    )
    expect(crossSquad.ok, 'a squad-scoped grant must not reach another squad').toBe(false)

    // An action nobody approved stays shut, even on its own squad.
    const notApproved = await invokeTool(
      leadAuth(), env, 'grant_agent_capability',
      { agent: newAgentId, squad: LEAD_SQUAD_ID, capability: 'member' }, ORIGIN,
    )
    expect(notApproved.ok, 'action:manage_access was never approved').toBe(false)

    // ── the ORG-SCOPED grant's OWN boundary ─────────────────────────────────
    //
    // This is the half the first version of this test never probed, and an
    // adversarial pass measured the consequence: project_create is
    // workspace-gated, so action:project_lifecycle has to be granted at ORG
    // scope to authorize a project at all — and hasElevatedAction treats an
    // org-scoped grant as covering EVERY scope. The same grant that let the
    // lead make its own project also created departments org-wide and squads
    // inside departments it had nothing to do with. Against "nothing outside of
    // it", org structure is outside of it.
    //
    // create_department no longer has an elevation path at all.
    const deptAttempt = await invokeTool(
      leadAuth(), env, 'create_department', { slug: 'ops', name: 'Ops' }, ORIGIN,
    )
    expect(deptAttempt.ok, 'an org-scoped project grant must not create org structure').toBe(false)
    expect(JSON.stringify(deptAttempt)).not.toContain('limit_reached') // authz, not quota

    // …and squad creation is DEPARTMENT-scoped, so it cannot reach a department
    // the approver never named. (No project_lifecycle grant on dept-finance.)
    const foreignSquad = await invokeTool(
      leadAuth(), env, 'create_squad',
      { department: OTHER_DEPT_ID, slug: 'blackops', name: 'Blackops' }, ORIGIN,
    )
    expect(foreignSquad.ok, 'a department-scoped grant must not reach another department').toBe(false)
    expect(JSON.stringify(foreignSquad)).not.toContain('limit_reached')

    // ── 5. it gained NO standing authority doing any of this ────────────────
    const after = await resolveCapabilities(env, LEAD_MEMBER_ID)
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ scope_id: LEAD_SQUAD_ID, capability: 'lead' })

    // ── 6. and it lapses on its own ─────────────────────────────────────────
    vi.setSystemTime(t0 + 61 * 60 * 1000)
    const mintAfter = await invokeTool(
      leadAuth(), env, 'mint_agent_token', { agent: newAgentId, label: 'too-late' }, ORIGIN,
    )
    expect(mintAfter.ok, 'the grant must lapse without anyone revoking it').toBe(false)
    const projectAfter = await invokeTool(
      leadAuth(), env, 'project_create', { slug: 'too-late', name: 'Too Late' }, ORIGIN,
    )
    expect(projectAfter.ok).toBe(false)

    // Still exactly one standing row, after expiry as before it.
    const final = await resolveCapabilities(env, LEAD_MEMBER_ID)
    expect(final).toHaveLength(1)
  })
})
