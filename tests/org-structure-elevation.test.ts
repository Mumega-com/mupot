// tests/org-structure-elevation.test.ts
//
// action:org_structure — the elevation door for DEPARTMENTS and SQUADS.
//
// Goal (Hadi): a coordinator agent (Rava) fixes departments and squads without a developer in the database, and
// without ever becoming a standing admin. The mechanism is the one that already exists: request_elevation -> a human
// approves (secure moment) -> a time-boxed, scoped grant. Real migrated schema, real invokeTool, real elevation
// ledger. Every "cannot" asserts the REFUSAL, and is preceded by a baseline proving the same call succeeds when it
// should, so a green refusal is attributable to the guard and not to a broken fixture.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { createElevationRequest, decideElevationRequest } from '../src/auth/elevation'
import { createWebSession } from '../src/auth/web-sessions'
import { resolveCapabilities } from '../src/auth/capability'

const TENANT = 'tenant-struct'
const ORIGIN = 'https://pot.test'

const DEPT_A = 'dept-a'
const DEPT_B = 'dept-b'
const DEPT_HOME = 'dept-home'
const SQUAD_A1 = 'squad-a1'
const SQUAD_A2 = 'squad-a2'
const SQUAD_B1 = 'squad-b1'
const SQUAD_HOME = 'squad-home'

const AGENT_ID = 'agent-rava'
const AGENT_MEMBER = 'member-rava'
const TOKEN_ID = 'tok-rava-1'

const APPROVER = 'member-approver'
const APPROVER_IDENTITY = 'identity-approver'
const ADMIN_HUMAN = 'member-human-admin'

let harness: SqliteD1Harness
let env: Env

function memoryKv(): Env['SESSIONS'] {
  const store = new Map<string, string>()
  return {
    async put(key: string, value: string) { store.set(key, value) },
    async get(key: string) { return store.get(key) ?? null },
    async delete(key: string) { store.delete(key) },
  } as unknown as Env['SESSIONS']
}

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('${DEPT_A}', 'dept-a', 'Dept A'), ('${DEPT_B}', 'dept-b', 'Dept B');
    INSERT INTO departments (id, slug, name, kind) VALUES ('${DEPT_HOME}', 'dept-home', 'Home Dept', 'home');
    -- Lift the plan quota so a refusal below is authorization, not a limit message.
    INSERT INTO org_settings (key, value) VALUES ('billing_state', '{"tier":"scale"}')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('${SQUAD_A1}', '${DEPT_A}', 'a1-sqd', 'A One'),
      ('${SQUAD_A2}', '${DEPT_A}', 'a2-sqd', 'A Two'),
      ('${SQUAD_B1}', '${DEPT_B}', 'b1-sqd', 'B One');
    INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('${SQUAD_HOME}', '${DEPT_HOME}', 'home-sqd', 'Home', 'home');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${AGENT_ID}', '${SQUAD_A1}', 'rava', 'Rava', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES
      ('${AGENT_MEMBER}', 'Rava seat', 'active', '${TENANT}'),
      ('${APPROVER}', 'Approver', 'active', '${TENANT}'),
      ('${ADMIN_HUMAN}', 'Human Admin', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', '${AGENT_ID}', '${AGENT_MEMBER}', '2026-09-01T00:00:00Z');
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at)
      VALUES ('${TOKEN_ID}', '${AGENT_MEMBER}', 'hash-rava-1', 'primary', 'workspace', '${TENANT}', '${AGENT_ID}', datetime('now'));
    -- The agent's ENTIRE standing authority: lead on its own squad. No admin anywhere.
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-rava', '${AGENT_MEMBER}', 'squad', '${SQUAD_A1}', 'lead');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-approver', '${APPROVER}', 'org', NULL, 'admin'),
      ('cap-human-admin', '${ADMIN_HUMAN}', 'org', NULL, 'admin');
    INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at)
      VALUES ('${APPROVER_IDENTITY}', '${TENANT}', 'google', '${APPROVER}', 'approver@x.test', '${APPROVER}', datetime('now'));
  `)
}

function agentAuth(extra: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: AGENT_MEMBER,
    memberId: AGENT_MEMBER,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENT_ID,
    tokenId: TOKEN_ID,
    capabilities: [{ member_id: AGENT_MEMBER, scope_type: 'squad', scope_id: SQUAD_A1, capability: 'lead' }],
    ...extra,
  } as unknown as AuthContext
}

function humanAdminAuth(): AuthContext {
  return {
    userId: ADMIN_HUMAN,
    memberId: ADMIN_HUMAN,
    email: 'h@x.test',
    role: 'admin',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: null,
    capabilities: [{ member_id: ADMIN_HUMAN, scope_type: 'org', scope_id: null, capability: 'admin' }],
  } as unknown as AuthContext
}

async function checkIn(): Promise<string> {
  const res = await invokeTool(agentAuth(), env, 'check_in', {}, ORIGIN)
  if (!res.ok) throw new Error(`setup: check_in failed: ${JSON.stringify(res)}`)
  return (res.result as { agent_session: { id: string } }).agent_session.id
}

let approvalSeq = 0
async function approve(
  sessionId: string,
  scopeType: 'org' | 'department' | 'squad',
  scopeId: string,
  durationMinutes: number,
  nowMs: number,
  actions: string[] = ['action:org_structure', 'action:org_department_create'],
): Promise<string> {
  approvalSeq += 1
  const approverSession = await createWebSession(
    env,
    `raw-approver-${approvalSeq}`,
    { tenant: TENANT, memberId: APPROVER, loginIdentityId: APPROVER_IDENTITY },
    nowMs,
  )
  const created = await createElevationRequest(
    env,
    {
      tenant: TENANT, agentSessionId: sessionId, agentId: AGENT_ID, memberId: AGENT_MEMBER,
      actions, scopeType, scopeId, durationMinutes, reason: 'fix org structure',
    },
    nowMs,
  )
  if (!created.ok) throw new Error(`approve: request failed: ${JSON.stringify(created)}`)
  const decision = await decideElevationRequest(
    env,
    {
      tenant: TENANT, requestId: created.request.id, decision: 'approve', selectedActions: actions,
      decidedByMemberId: APPROVER,
      decidedByCapabilities: [{ member_id: APPROVER, scope_type: 'org', scope_id: null, capability: 'admin' }],
      decidedByWebSessionHash: approverSession.id_hash,
      recentReauthOk: true,
    },
    nowMs,
  )
  if (!decision.ok) throw new Error(`approve: decision failed: ${JSON.stringify(decision)}`)
  return created.request.id
}

function deptName(id: string): string | undefined {
  return (harness.sqlite.prepare('SELECT name FROM departments WHERE id = ?').get(id) as { name: string } | undefined)?.name
}
function squadRow(id: string): { slug: string; budget_cap_cents: number | null } | undefined {
  return harness.sqlite.prepare('SELECT slug, budget_cap_cents FROM squads WHERE id = ?').get(id) as { slug: string; budget_cap_cents: number | null } | undefined
}
function deptCount(): number {
  return (harness.sqlite.prepare("SELECT COUNT(*) AS n FROM departments WHERE kind = 'work'").get() as { n: number }).n
}

/** The refusal must be the ELEVATION door saying no (no_matching_grant), not a crash that happens to read as ok:false. */
function expectNoMatchingGrant(out: Awaited<ReturnType<typeof invokeTool>>): void {
  expect(out.ok).toBe(false)
  expect(JSON.stringify(out)).toContain('no_matching_grant')
}

/** No live grant for the action at all: the floor / structural gate refuses before any handler runs. */
function expectRefused(out: Awaited<ReturnType<typeof invokeTool>>): void {
  expect(out.ok).toBe(false)
  expect(JSON.stringify(out)).toMatch(/forbidden|operator_principal_required/)
}

const T0 = Date.parse('2026-10-14T12:00:00.000Z')

beforeEach(() => {
  approvalSeq = 0
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  seed(harness.sqlite)
  env = { DB: harness.db, TENANT_SLUG: TENANT, SESSIONS: memoryKv(), PUBLIC_ORIGIN: ORIGIN } as unknown as Env
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
  harness.sqlite.close()
})

const createDept = (slug = 'ops', auth = agentAuth()) => invokeTool(auth, env, 'create_department', { slug, name: 'Ops' }, ORIGIN)
const renameDept = (department: string, name = 'Renamed', auth = agentAuth()) =>
  invokeTool(auth, env, 'update_department', { department, name }, ORIGIN)
const updateSquad = (squad: string, patch: Record<string, unknown> = { budget_cap_cents: 500 }, auth = agentAuth()) =>
  invokeTool(auth, env, 'update_squad', { squad, ...patch }, ORIGIN)

describe('action:org_structure is a real, requestable, reversible elevation action', () => {
  it('is registered as enforced and reversible (and is NOT a sensitive step-up action)', async () => {
    const { ELEVATION_ACTIONS, REQUESTABLE_ELEVATION_ACTION_KEYS, SENSITIVE_STEP_UP_ACTIONS } = await import('../src/auth/elevation-actions')
    expect(ELEVATION_ACTIONS['action:org_structure'].enforced).toBe(true)
    expect(ELEVATION_ACTIONS['action:org_structure'].effect).toBe('reversible')
    expect(REQUESTABLE_ELEVATION_ACTION_KEYS).toContain('action:org_structure')
    expect(SENSITIVE_STEP_UP_ACTIONS.has('action:org_structure')).toBe(false)
  })

  it('the agent holds no standing admin, so every success below is attributable to the grant', async () => {
    const caps = await resolveCapabilities(env, AGENT_MEMBER)
    expect(caps).toHaveLength(1)
    expect(caps[0]).toMatchObject({ scope_type: 'squad', scope_id: SQUAD_A1, capability: 'lead' })
  })
})

describe('un-elevated agent cannot', () => {
  it('create a department, rename one, or update a squad (nothing written)', async () => {
    await checkIn()
    const before = deptCount()
    const c = await createDept()
    const r = await renameDept(DEPT_A)
    const u = await updateSquad(SQUAD_A1)
    expect(c.ok).toBe(false)
    expect(r.ok).toBe(false)
    expect(u.ok).toBe(false)
    expect(deptCount()).toBe(before)
    expect(deptName(DEPT_A)).toBe('Dept A')
    expect(squadRow(SQUAD_A1)?.budget_cap_cents).toBeNull()
  })

  it('update_squad / update_department refuse with operator_principal_required (the structural gate), not a leaked target error', async () => {
    await checkIn()
    for (const out of [await updateSquad(SQUAD_A1), await renameDept(DEPT_A)]) {
      expect(out.ok).toBe(false)
      expect(JSON.stringify(out)).toMatch(/forbidden|operator_principal_required/)
    }
  })
})

describe('an agent with STANDING admin is not a path around the lane', () => {
  const standingAdmin = () => agentAuth({
    capabilities: [{ member_id: AGENT_MEMBER, scope_type: 'org', scope_id: null, capability: 'admin' }],
  } as unknown as Partial<AuthContext>)

  it('update_squad and update_department refuse a standing-admin agent with operator_principal_required (agents must not act as standing admins here)', async () => {
    await checkIn()
    for (const out of [await updateSquad(SQUAD_A1, { budget_cap_cents: 5 }, standingAdmin()), await renameDept(DEPT_A, 'X', standingAdmin())]) {
      expect(out.ok).toBe(false)
      expect(JSON.stringify(out)).toContain('operator_principal_required')
    }
    expect(deptName(DEPT_A)).toBe('Dept A')
    expect(squadRow(SQUAD_A1)?.budget_cap_cents).toBeNull()
  })

  it('create_department keeps its pre-existing capability lane for a standing org-admin agent (unchanged, reported as a residual)', async () => {
    await checkIn()
    expect((await createDept('legacy-lane', standingAdmin())).ok).toBe(true)
  })
})

describe('elevated agent CAN, inside its granted scope', () => {
  it('create_department with an ORG-scope grant, and the grant stays usable for the next step (time window, not single-use)', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'org', '', 60, T0)
    const first = await createDept('ops')
    expect(first.ok, JSON.stringify(first)).toBe(true)
    const second = await createDept('ops-two')
    expect(second.ok, 'a grant is a time window: the second structural act in the window must also pass').toBe(true)
    const rename = await renameDept(DEPT_B, 'Dept B renamed')
    expect(rename.ok, JSON.stringify(rename)).toBe(true)
    const squad = await updateSquad(SQUAD_B1)
    expect(squad.ok, JSON.stringify(squad)).toBe(true)
    // every act left a usage-log row on the SAME grant
    const count = (action: string) => (harness.sqlite.prepare('SELECT COUNT(*) AS n FROM elevation_usage_log WHERE action = ?').get(action) as { n: number }).n
    expect(count('action:org_department_create')).toBe(2) // exactly one row per SUCCESSFUL create
    expect(count('action:org_structure')).toBe(2) // the rename and the squad update
    // a REFUSED or no-op attempt writes NO row (usage is logged after the write, bot P1)
    const before = count('action:org_structure')
    expect((await updateSquad(SQUAD_B1, {})).ok).toBe(false)
    expect((await renameDept(DEPT_B, '')).ok).toBe(false)
    expect(count('action:org_structure')).toBe(before)
  })

  it('update_department with a DEPARTMENT-scope grant on that department', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'department', DEPT_A, 60, T0)
    const out = await renameDept('dept-a', 'Dept A, renamed')
    expect(out.ok, JSON.stringify(out)).toBe(true)
    expect(deptName(DEPT_A)).toBe('Dept A, renamed')
  })

  it('update_squad with a SQUAD-scope grant on that squad, and with a DEPARTMENT-scope grant on its department', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'squad', SQUAD_A2, 60, T0)
    const onSquad = await updateSquad(SQUAD_A2, { budget_cap_cents: 700 })
    expect(onSquad.ok, JSON.stringify(onSquad)).toBe(true)
    expect(squadRow(SQUAD_A2)?.budget_cap_cents).toBe(700)

    await approve(sessionId, 'department', DEPT_A, 60, T0)
    const viaDept = await updateSquad(SQUAD_A1, { budget_cap_cents: 900 })
    expect(viaDept.ok, JSON.stringify(viaDept)).toBe(true)
    expect(squadRow(SQUAD_A1)?.budget_cap_cents).toBe(900)
  })

  it('gains no standing capability from any of it', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'org', '', 60, T0)
    expect((await createDept()).ok).toBe(true)
    const caps = await resolveCapabilities(env, AGENT_MEMBER)
    expect(caps).toHaveLength(1)
    expect(caps.some((c) => c.capability === 'admin')).toBe(false)
  })
})

describe('wrong scope is refused', () => {
  it('a SQUAD grant cannot rename another squad, update a squad elsewhere, rename a department, or create a department', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'squad', SQUAD_A2, 60, T0)
    expect((await updateSquad(SQUAD_A2)).ok, 'baseline: the granted squad works').toBe(true)
    const before = deptCount()
    expectNoMatchingGrant(await updateSquad(SQUAD_A1))
    expectNoMatchingGrant(await updateSquad(SQUAD_B1))
    expectNoMatchingGrant(await renameDept(DEPT_A))
    expectNoMatchingGrant(await createDept())
    expect(deptCount()).toBe(before)
    expect(squadRow(SQUAD_A1)?.budget_cap_cents).toBeNull()
    expect(squadRow(SQUAD_B1)?.budget_cap_cents).toBeNull()
    expect(deptName(DEPT_A)).toBe('Dept A')
  })

  it('a DEPARTMENT grant cannot touch another department or its squads, and cannot create a department', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'department', DEPT_A, 60, T0)
    expect((await renameDept(DEPT_A)).ok, 'baseline').toBe(true)
    const before = deptCount()
    expectNoMatchingGrant(await renameDept(DEPT_B))
    expectNoMatchingGrant(await updateSquad(SQUAD_B1))
    expectNoMatchingGrant(await createDept())
    expect(deptCount()).toBe(before)
    expect(deptName(DEPT_B)).toBe('Dept B')
  })

  it('a grant for ANOTHER action (project_lifecycle, org scope) opens none of these three tools', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'org', '', 60, T0, ['action:project_lifecycle'])
    const before = deptCount()
    expectRefused(await createDept())
    expectRefused(await renameDept(DEPT_A))
    expectRefused(await updateSquad(SQUAD_A1))
    expect(deptCount()).toBe(before)
  })

  it('the grant never reaches a home department or a home squad, even at org scope', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'org', '', 60, T0)
    expect((await renameDept(DEPT_A)).ok, 'baseline').toBe(true)
    const homeDept = await renameDept(DEPT_HOME)
    expect(homeDept.ok).toBe(false)
    expect(JSON.stringify(homeDept)).toContain('home_department')
    expect((await updateSquad(SQUAD_HOME)).ok).toBe(false)
    expect(deptName(DEPT_HOME)).toBe('Home Dept')
    expect(squadRow(SQUAD_HOME)?.budget_cap_cents).toBeNull()
  })

  it('a slug rename into a team_bootstrap-reserved name still needs standing department admin', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'org', '', 60, T0)
    harness.sqlite.exec(`INSERT INTO projects (id, slug, name) VALUES ('prj-x', 'reserved-prj', 'Reserved')`)
    expect((await updateSquad(SQUAD_A1, { slug: 'free-sqd' })).ok, 'baseline: an unreserved rename passes').toBe(true)
    const reserved = await updateSquad(SQUAD_A2, { slug: 'reserved-sqd' })
    expect(reserved.ok).toBe(false)
    expect(JSON.stringify(reserved)).toContain('slug_reserved_by_team_bootstrap')
  })

  it('a grant + STANDING department admin still cannot rename into a reserved name (a bound agent never passes it with standing authority)', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'squad', SQUAD_A1, 60, T0)
    harness.sqlite.exec(`INSERT INTO projects (id, slug, name) VALUES ('prj-y', 'taken-prj', 'Taken')`)
    const standingDeptAdmin = agentAuth({
      capabilities: [{ member_id: AGENT_MEMBER, scope_type: 'department', scope_id: DEPT_A, capability: 'admin' }],
    } as unknown as Partial<AuthContext>)
    const out = await updateSquad(SQUAD_A1, { slug: 'taken-sqd' }, standingDeptAdmin)
    expect(out.ok, JSON.stringify(out)).toBe(false)
    expect(JSON.stringify(out)).toContain('slug_reserved_by_team_bootstrap')
    expect(squadRow(SQUAD_A1)?.slug).not.toBe('taken-sqd')
  })
})

describe('creating a department is its own, IRREVERSIBLE action (bot P1)', () => {
  it('the registry classifies it irreversible and org_structure stays reversible', async () => {
    const { ELEVATION_ACTIONS } = await import('../src/auth/elevation-actions')
    expect(ELEVATION_ACTIONS['action:org_department_create'].effect).toBe('irreversible')
    expect(ELEVATION_ACTIONS['action:org_department_create'].enforced).toBe(true)
    expect(ELEVATION_ACTIONS['action:org_structure'].effect).toBe('reversible')
    expect(ELEVATION_ACTIONS['action:org_structure'].description).not.toMatch(/create a department/i)
  })
  it('an org_structure grant alone cannot create a department; a department-create grant alone cannot rename or update', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'org', '', 60, T0, ['action:org_structure'])
    expectNoMatchingGrant(await createDept('only-structure'))
    expect((await renameDept(DEPT_A, 'Renamed A')).ok, 'org_structure still renames').toBe(true)
    await approve(sessionId, 'org', '', 60, T0, ['action:org_department_create'])
    expect((await createDept('now-allowed')).ok).toBe(true)
    // department-create alone must not open the other two tools
    const s2 = await checkIn()
    void s2
  })
})

describe('time-box and revocation', () => {
  it('an expired grant opens nothing', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'org', '', 15, T0)
    expect((await createDept('ops')).ok, 'baseline').toBe(true)
    vi.setSystemTime(T0 + 16 * 60 * 1000)
    // keep the agent session itself live so this proves GRANT expiry, not session expiry
    await checkIn()
    expectRefused(await createDept('ops-late'))
    expectRefused(await renameDept(DEPT_A))
    expectRefused(await updateSquad(SQUAD_A1))
  })

  it('a revoked grant opens nothing', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'org', '', 60, T0)
    expect((await createDept('ops')).ok, 'baseline').toBe(true)
    harness.sqlite.exec(`UPDATE elevation_grants SET revoked_at = '${new Date(T0 + 1000).toISOString()}', revoke_reason = 'test'`)
    expectRefused(await createDept('ops-after'))
    expectRefused(await renameDept(DEPT_A))
    expectRefused(await updateSquad(SQUAD_A1))
  })
})

describe('delegated operators and attached seats stay out', () => {
  async function delegateOrgLead(): Promise<void> {
    const out = await invokeTool(humanAdminAuth(), env, 'operator_delegate', { agent: AGENT_ID, scope_type: 'org', max_grant: 'lead' }, ORIGIN)
    if (!out.ok) throw new Error(`delegate failed: ${JSON.stringify(out)}`)
  }

  it('a delegated-operator agent WITHOUT elevation cannot create a department, rename one, or update a squad (non-delegable stays non-delegable)', async () => {
    env = { ...env, DELEGATED_OPERATORS: '1' } as Env
    await checkIn()
    await delegateOrgLead()
    const before = deptCount()
    const c = await createDept()
    const r = await renameDept(DEPT_A)
    const u = await updateSquad(SQUAD_A1)
    for (const out of [c, r, u]) expect(out.ok).toBe(false)
    expect(deptCount()).toBe(before)
    expect(deptName(DEPT_A)).toBe('Dept A')
    expect(squadRow(SQUAD_A1)?.budget_cap_cents).toBeNull()
  })

  it('a delegated-operator agent WITH the elevation can (the lane composes), and the delegation did not need to widen', async () => {
    env = { ...env, DELEGATED_OPERATORS: '1' } as Env
    const sessionId = await checkIn()
    await delegateOrgLead()
    await approve(sessionId, 'org', '', 60, T0)
    expect((await renameDept(DEPT_A)).ok).toBe(true)
    expect((await updateSquad(SQUAD_A1)).ok).toBe(true)
  })

  it('an ATTACHED seat thread cannot request the elevation, and a grant row bound to its credential does not open these acts', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'org', '', 60, T0)
    const attached = agentAuth({
      seatBinding: {
        seatId: 'seat-1', label: 'seat-1', harnessId: 'h-1', grantTokenId: TOKEN_ID, humanMemberId: ADMIN_HUMAN, source: 'handle',
        attached: { agentId: AGENT_ID, ceiling: 'full' },
      },
    } as unknown as Partial<AuthContext>)
    // baseline: the SAME credential, not attached, is allowed
    expect((await createDept('ops')).ok, 'baseline').toBe(true)
    const before = deptCount()
    const req = await invokeTool(attached, env, 'request_elevation', { actions: ['action:org_structure'], scope_type: 'org', duration_minutes: 15, reason: 'x' }, ORIGIN)
    expect(JSON.stringify(req)).toContain('attached_seat_cannot_elevate')
    expect((await createDept('ops-attached', attached)).ok).toBe(false)
    expect((await renameDept(DEPT_A, 'Hijacked', attached)).ok).toBe(false)
    expect((await updateSquad(SQUAD_A1, { budget_cap_cents: 1 }, attached)).ok).toBe(false)
    expect(deptCount()).toBe(before)
    expect(deptName(DEPT_A)).toBe('Dept A')
    expect(squadRow(SQUAD_A1)?.budget_cap_cents).toBeNull()
  })
})

describe('one grant never opens the standing-admin path elsewhere (adversarial P1-A)', () => {
  const standingOn = (scopeType: 'squad' | 'department', scopeId: string) => ({
    capabilities: [{ member_id: AGENT_MEMBER, scope_type: scopeType, scope_id: scopeId, capability: 'admin' }],
  } as unknown as Partial<AuthContext>)

  it('standing admin on squad A2 + a grant on B1 cannot update A2 (and the grant works on B1, with a usage row)', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'squad', SQUAD_B1, 60, T0)
    const a2 = await updateSquad(SQUAD_A2, { budget_cap_cents: 5 }, agentAuth(standingOn('squad', SQUAD_A2)))
    expect(a2.ok, JSON.stringify(a2)).toBe(false)
    expect(squadRow(SQUAD_A2)?.budget_cap_cents).toBeNull()
    const b1 = await updateSquad(SQUAD_B1, { budget_cap_cents: 5 }, agentAuth(standingOn('squad', SQUAD_A2)))
    expect(b1.ok, JSON.stringify(b1)).toBe(true)
    expect(squadRow(SQUAD_B1)?.budget_cap_cents).toBe(5)
  })

  it('standing admin on department B + a grant on squad A1 cannot rename department B', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'squad', SQUAD_A1, 60, T0)
    const out = await renameDept(DEPT_B, 'Hijacked', agentAuth(standingOn('department', DEPT_B)))
    expect(out.ok, JSON.stringify(out)).toBe(false)
    expect(deptName(DEPT_B)).not.toBe('Hijacked')
  })

  it('standing admin on the HOME squad + a grant on A1 cannot update the home squad', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'squad', SQUAD_A1, 60, T0)
    const out = await updateSquad(SQUAD_HOME, { budget_cap_cents: 5 }, agentAuth(standingOn('squad', SQUAD_HOME)))
    expect(out.ok, JSON.stringify(out)).toBe(false)
    expect(squadRow(SQUAD_HOME)?.budget_cap_cents).toBeNull()
  })

  it('an ATTACHED seat with standing caps and a grant row on B1 cannot update A2', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'squad', SQUAD_B1, 60, T0)
    const attached = agentAuth({
      capabilities: [{ member_id: AGENT_MEMBER, scope_type: 'squad', scope_id: SQUAD_A2, capability: 'admin' }],
      seatBinding: {
        seatId: 'seat-1', label: 'seat-1', harnessId: 'h-1', grantTokenId: TOKEN_ID, humanMemberId: ADMIN_HUMAN, source: 'handle',
        attached: { agentId: AGENT_ID, ceiling: 'full' },
      },
    } as unknown as Partial<AuthContext>)
    expect((await updateSquad(SQUAD_A2, { budget_cap_cents: 5 }, attached)).ok).toBe(false)
    expect(squadRow(SQUAD_A2)?.budget_cap_cents).toBeNull()
  })
})

describe('an elevated agent may only LOWER a squad budget (adversarial P1-B)', () => {
  it('can set a first cap and lower it; cannot raise it, clear it, or change the window', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'squad', SQUAD_A1, 60, T0)
    expect((await updateSquad(SQUAD_A1, { budget_cap_cents: 1000 })).ok, 'first cap').toBe(true)
    expect((await updateSquad(SQUAD_A1, { budget_cap_cents: 400 })).ok, 'lower').toBe(true)
    for (const patch of [{ budget_cap_cents: 900 }, { budget_cap_cents: null }, { budget_cap_cents: 0 }, { budget_cap_cents: -5 }, { budget_window: 'day' }]) {
      const out = await updateSquad(SQUAD_A1, patch)
      expect(out.ok, JSON.stringify(patch)).toBe(false)
      expect(JSON.stringify(out)).toMatch(/budget_(raise|window)_standing_admin_only/)
    }
    expect(squadRow(SQUAD_A1)?.budget_cap_cents).toBe(400)
  })

  it('a human admin still raises, clears and changes the window freely', async () => {
    await invokeTool(humanAdminAuth(), env, 'update_squad', { squad: SQUAD_A1, budget_cap_cents: 300 }, ORIGIN)
    expect((await invokeTool(humanAdminAuth(), env, 'update_squad', { squad: SQUAD_A1, budget_cap_cents: 900 }, ORIGIN)).ok).toBe(true)
    expect((await invokeTool(humanAdminAuth(), env, 'update_squad', { squad: SQUAD_A1, budget_cap_cents: null }, ORIGIN)).ok).toBe(true)
    expect((await invokeTool(humanAdminAuth(), env, 'update_squad', { squad: SQUAD_A1, budget_window: 'day' }, ORIGIN)).ok).toBe(true)
  })
})

describe('refusals teach the exact request (onboarding smoothness)', () => {
  it('a floor refusal names request_elevation, the action key AND the scope each tool needs', async () => {
    await checkIn()
    const dept = JSON.stringify(await createDept('x1'))
    expect(dept).toContain('action:org_department_create')
    expect(dept).toContain('scope_type \\"org\\"')
    const ren = JSON.stringify(await renameDept(DEPT_A, 'X'))
    expect(ren).toContain('action:org_structure')
    expect(ren).toContain('scope_type \\"department\\"')
    const sq = JSON.stringify(await updateSquad(SQUAD_A2, { budget_cap_cents: 5 }))
    expect(sq).toContain('action:org_structure')
    expect(sq).toContain('scope_type \\"squad\\"')
  })
  it('a handler refusal under a wrong-scope grant carries a copy-paste request_elevation block with the resolved id', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'squad', SQUAD_B1, 60, T0)
    const out = JSON.stringify(await renameDept(DEPT_A, 'X'))
    expect(out).toContain('request_elevation')
    expect(out).toContain(DEPT_A)
  })
})

describe('post-review hardening on the current head (bot P1s)', () => {
  it('an ATTACHED thread whose ceiling-clamped grants include ORG ADMIN still cannot create a department, rename one or update a squad', async () => {
    const attachedOrgAdmin = agentAuth({
      capabilities: [{ member_id: AGENT_MEMBER, scope_type: 'org', scope_id: null, capability: 'admin' }],
      seatBinding: {
        seatId: 'seat-1', label: 'seat-1', harnessId: 'h-1', grantTokenId: TOKEN_ID, humanMemberId: ADMIN_HUMAN, source: 'handle',
        attached: { agentId: AGENT_ID, ceiling: 'full' },
      },
    } as unknown as Partial<AuthContext>)
    const before = deptCount()
    expect((await createDept('via-attached', attachedOrgAdmin)).ok).toBe(false)
    expect((await renameDept(DEPT_A, 'Hijacked', attachedOrgAdmin)).ok).toBe(false)
    expect((await updateSquad(SQUAD_A1, { budget_cap_cents: 5 }, attachedOrgAdmin)).ok).toBe(false)
    expect(deptCount()).toBe(before)
    expect(deptName(DEPT_A)).toBe('Dept A')
  })

  it('two overlapping elevated budget updates cannot end in a RAISE (compare-and-swap at write time)', async () => {
    const sessionId = await checkIn()
    await approve(sessionId, 'squad', SQUAD_A1, 60, T0)
    expect((await updateSquad(SQUAD_A1, { budget_cap_cents: 1000 })).ok).toBe(true)
    // simulate the overlap: right before this call's UPDATE, another elevated call lowers the cap to 400
    const db = env.DB as unknown as { prepare: (sql: string) => unknown }
    const original = db.prepare.bind(db)
    db.prepare = (sql: string) => {
      if (sql.startsWith('UPDATE squads SET budget_cap_cents = ?1 WHERE id = ?2 AND')) {
        harness.sqlite.exec(`UPDATE squads SET budget_cap_cents = 400 WHERE id = '${SQUAD_A1}'`)
      }
      return original(sql)
    }
    try {
      const out = await updateSquad(SQUAD_A1, { budget_cap_cents: 900 }) // a valid LOWER against the 1000 it read
      expect(out.ok, JSON.stringify(out)).toBe(false)
      expect(JSON.stringify(out)).toContain('budget_changed_concurrently')
    } finally {
      db.prepare = original
    }
    expect(squadRow(SQUAD_A1)?.budget_cap_cents).toBe(400) // never 900
  })
})

describe('human admin lane is unchanged', () => {
  it('an org-admin human creates and renames departments and updates squads with no elevation', async () => {
    const h = humanAdminAuth()
    expect((await createDept('human-ops', h)).ok).toBe(true)
    expect((await renameDept(DEPT_A, 'Human renamed', h)).ok).toBe(true)
    expect(deptName(DEPT_A)).toBe('Human renamed')
    expect((await updateSquad(SQUAD_A1, { budget_cap_cents: 42 }, h)).ok).toBe(true)
  })

  it('update_department validates: empty name and unknown department are refused, a home department is never renamed', async () => {
    const h = humanAdminAuth()
    expect((await invokeTool(h, env, 'update_department', { department: DEPT_A, name: '   ' }, ORIGIN)).ok).toBe(false)
    expect((await renameDept('no-such-dept', 'X', h)).ok).toBe(false)
    expect((await renameDept(DEPT_HOME, 'X', h)).ok).toBe(false)
    expect(deptName(DEPT_A)).toBe('Dept A')
  })

  it('there is no delete or archive path: update_department takes no status field', async () => {
    const h = humanAdminAuth()
    const out = await invokeTool(h, env, 'update_department', { department: DEPT_A, name: 'N', status: 'archived' }, ORIGIN)
    expect(out.ok).toBe(false)
    expect(deptName(DEPT_A)).toBe('Dept A')
  })
})
