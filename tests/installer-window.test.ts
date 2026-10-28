// tests/installer-window.test.ts — installer window core (design S1, PR-C). Flag INSTALLER_WINDOW, default OFF.
//
// Real migrated schema, real MCP dispatch (invokeTool), real HTTP router (orgApp), real elevation request/decide. The window is
// authorised by a LIVE elevation grant a human approved; the chokepoint judges every act through evaluateDelegated. Every
// refusal is asserted by CODE. Each guard has a mutation recorded in the PR body (which test goes red).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))
vi.mock('../src/auth', () => ({
  requireAuth: async (
    c: { set: (key: 'auth', value: AuthContext) => void; json: (body: unknown, status: 401) => Response },
    next: () => Promise<void>,
  ) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
}))

const { invokeTool } = await import('../src/mcp')
const { orgApp } = await import('../src/org')
const { authorizeStructuralWrite, settleOpenDelegatedReceipts, finishDelegatedReceipt } = await import('../src/operators/chokepoint')
const { createElevationRequest, decideElevationRequest, findElevationDecisionRefusal, revokeElevationGrant, loadElevationRequestById } = await import('../src/auth/elevation')
const { createWebSession, revokeWebSession } = await import('../src/auth/web-sessions')
const { telegramPolicyRefusal, PASSKEY_REQUIRED_MESSAGE } = await import('../src/secure-moments/telegram-miniapp')
const { INSTALLER_TIERS, INSTALL_HIGH_ACTION, INSTALL_STANDARD_ACTION } = await import('../src/operators/installer-tiers')
const { installerDelegationsFor, liveInstallerWindows } = await import('../src/operators/installer-window')
const { decideElevation } = await import('../src/access/decision-core')
const { refusalGuidance } = await import('../src/mcp/refusal-next-step')
const { isAttachedSudoAction } = await import('../src/auth/attached-ceiling')
const { SENSITIVE_STEP_UP_ACTIONS, ELEVATION_ACTIONS } = await import('../src/auth/elevation-actions')
const { tgDecisionIsRoutine } = await import('../src/secure-moments/telegram-miniapp')
const { reserveInstallerWrite } = await import('../src/operators/installer-window')

const TENANT = 'tenant-iw'
const ORIGIN = 'https://pot.test'
const APPROVER = 'mem-approver'
const APPROVER_IDENTITY = 'ident-approver'

let harness: SqliteD1Harness
let env: Env

function sql(q: string, ...p: unknown[]): void {
  harness.sqlite.prepare(q).run(...p)
}
function rows<T = Record<string, unknown>>(q: string, ...p: unknown[]): T[] {
  return harness.sqlite.prepare(q).all(...p) as T[]
}

function seedAgent(agent: string, squad: string, tokenId: string): void {
  sql("INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES (?, ?, ?, ?, 'member', 'test', 'active')", agent, squad, agent, agent)
  sql("INSERT INTO members (id, display_name, status, tenant) VALUES (?, ?, 'active', ?)", `seat-${agent}`, agent, TENANT)
  sql('INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES (?, ?, ?, ?)', TENANT, agent, `seat-${agent}`, '2026-10-01T00:00:00.000Z')
  sql(
    "INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at) VALUES (?, ?, ?, 'primary', 'workspace', ?, ?, datetime('now'))",
    tokenId, `seat-${agent}`, `hash-${tokenId}`, TENANT, agent,
  )
}
function addCap(member: string, cap: string, scopeType: string, scopeId: string | null): void {
  sql('INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?, ?, ?, ?, ?)', crypto.randomUUID(), member, scopeType, scopeId, cap)
}

function seed(): void {
  sql("INSERT INTO org_settings (key, value) VALUES ('billing_state', '{\"tier\":\"scale\",\"event_id\":\"e\",\"effective_at\":1}')")
  sql("INSERT INTO departments (id, slug, name) VALUES ('D1','d1','Dept One'), ('D2','d2','Dept Two')")
  sql("INSERT INTO departments (id, slug, name, kind) VALUES ('DH','dh','Home Dept','home')")
  sql("INSERT INTO squads (id, department_id, slug, name) VALUES ('S1','D1','s1-sqd','Squad One'), ('S2','D1','s2-sqd','Squad Two'), ('S3','D2','s3-sqd','Squad Three')")
  sql("INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('SH','DH','home-sqd','Home','home')")
  sql("INSERT INTO projects (id, slug, name) VALUES ('P1','p1','Project One')")
  sql("INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('P1','S1','write')")
  sql("INSERT INTO members (id, display_name, status, tenant, email) VALUES (?, 'Approver', 'active', ?, 'approver@example.test')", APPROVER, TENANT)
  sql("INSERT INTO members (id, display_name, status, tenant, email) VALUES ('mem-human', 'Human', 'active', ?, 'human@example.test')", TENANT)
  addCap(APPROVER, 'admin', 'org', null)
  sql(
    "INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at) VALUES (?, ?, 'google', ?, 'approver@example.test', ?, datetime('now'))",
    APPROVER_IDENTITY, TENANT, APPROVER, APPROVER,
  )
  // the installing agent: lead on S1 and S2 (its own live rank), nothing on S3. NO admin anywhere.
  seedAgent('agent-op', 'S1', 'tok-op')
  addCap('seat-agent-op', 'lead', 'squad', 'S1')
  addCap('seat-agent-op', 'lead', 'squad', 'S2')
  // targets
  seedAgent('agent-b', 'S3', 'tok-b')
  seedAgent('agent-c', 'S3', 'tok-c')
  seedAgent('agent-d', 'S1', 'tok-d')
  sql("INSERT INTO squads (id, department_id, slug, name) VALUES ('S4','D1','s4-sqd','Squad Four')")
  seedAgent('agent-admin-target', 'S3', 'tok-at')
  sql("INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('m-at', 'agent-admin-target', 'S3', 'admin')")
  seedAgent('agent-e', 'S3', 'tok-e') // an agent with NO standing capability at all (floor tests)
  seedAgent('agent-lead-target', 'S3', 'tok-lt')
  sql("INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('m-lt', 'agent-lead-target', 'S3', 'lead')")
  // a second installing agent (session isolation)
  seedAgent('agent-op2', 'S1', 'tok-op2')
  addCap('seat-agent-op2', 'lead', 'squad', 'S1')
}

function agentAuth(agent: string, tokenId: string, squads: string[] = ['S1', 'S2']): AuthContext {
  return {
    userId: `seat-${agent}`, memberId: `seat-${agent}`, email: null, role: 'member', tenant: TENANT, channel: 'workspace',
    boundAgentId: agent, tokenId,
    capabilities: squads.map((s) => ({ member_id: `seat-${agent}`, scope_type: 'squad', scope_id: s, capability: 'lead' })),
  } as unknown as AuthContext // test fixture: the fields invokeTool reads for a bound-agent bearer
}
const op = (): AuthContext => agentAuth('agent-op', 'tok-op')

function memoryKv(): Env['SESSIONS'] {
  const store = new Map<string, string>()
  return {
    async put(k: string, v: string) { store.set(k, v) },
    async get(k: string) { return store.get(k) ?? null },
    async delete(k: string) { store.delete(k) },
  } as unknown as Env['SESSIONS'] // minimal KV double
}

const sessionByToken = new Map<string, string>()
async function checkIn(auth: AuthContext): Promise<string> {
  // one live session per credential per test: a second check_in rotates the session and would orphan an earlier grant
  const known = sessionByToken.get(`${harness.sqlite.constructor.name}:${String(auth.tokenId)}`)
  if (known) return known
  const res = await invokeTool(auth, env, 'check_in', {}, ORIGIN)
  if (!res.ok) throw new Error(`check_in failed: ${JSON.stringify(res)}`)
  const id = (res.result as { agent_session: { id: string } }).agent_session.id
  sessionByToken.set(`${harness.sqlite.constructor.name}:${String(auth.tokenId)}`, id)
  return id
}

let webSeq = 0
/** Human approval of an installer window, via the real request + decide. Returns the grant id. */
async function openWindow(
  auth: AuthContext,
  action: string,
  scopeType: 'org' | 'department' | 'squad',
  scopeId: string,
  minutes = 60,
  agentId = 'agent-op',
): Promise<{ grantId: string; sessionId: string; webHash: string }> {
  const sessionId = await checkIn(auth)
  const now = Date.now()
  const web = await createWebSession(env, `raw-approver-${++webSeq}`, { tenant: TENANT, memberId: APPROVER, loginIdentityId: APPROVER_IDENTITY }, now)
  const created = await createElevationRequest(env, {
    tenant: TENANT, agentSessionId: sessionId, agentId, memberId: `seat-${agentId}`, actions: [action],
    scopeType, scopeId, durationMinutes: minutes, reason: 'stand up the squads',
  }, now)
  if (!created.ok) throw new Error(`request refused: ${JSON.stringify(created)}`)
  const d = await decideElevationRequest(env, {
    tenant: TENANT, requestId: created.request.id, decision: 'approve', selectedActions: [action],
    decidedByMemberId: APPROVER,
    decidedByCapabilities: [{ member_id: APPROVER, scope_type: 'org', scope_id: null, capability: 'admin' }],
    decidedByWebSessionHash: web.id_hash, recentReauthOk: true, decidedViaPasskey: action === INSTALL_HIGH_ACTION,
  }, now)
  if (!d.ok) throw new Error(`decision refused: ${JSON.stringify(d)}`)
  return { grantId: d.grants[0].id, sessionId, webHash: web.id_hash }
}

function refusal(out: Awaited<ReturnType<typeof invokeTool>>): { status: number; error: string; detail: Record<string, unknown> } {
  if (out.ok) throw new Error('expected a refusal, call succeeded')
  return { status: out.status, error: out.error, detail: (out.detail ?? {}) as Record<string, unknown> }
}
async function call(auth: AuthContext, tool: string, args: Record<string, unknown>) {
  return invokeTool(auth, env, tool, args, ORIGIN)
}
function membership(agent: string, squad: string): string | null {
  return rows<{ capability: string }>('SELECT capability FROM memberships WHERE agent_id = ? AND squad_id = ?', agent, squad)[0]?.capability ?? null
}
function usage(grantId: string) {
  return rows<{ tool_name: string; status: string; error_code: string | null; detail_json: string }>(
    'SELECT tool_name, status, error_code, detail_json FROM elevation_usage_log WHERE elevation_grant_id = ? ORDER BY occurred_at, rowid', grantId,
  )
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  seed()
  env = { DB: harness.db, TENANT_SLUG: TENANT, SESSIONS: memoryKv(), PUBLIC_ORIGIN: ORIGIN, INSTALLER_WINDOW: '1', ACCESS_REQUIRED_AMR: 'hwk' } as unknown as Env // fixture env
  authState.current = null
  sessionByToken.clear()
})
afterEach(() => {
  authState.current = null
  vi.useRealTimers()
  harness.sqlite.close()
})

describe('flag OFF: authority and refusals byte-identical (the request_elevation schema enum still lists the two keys; they are refused at runtime)', () => {
  it('a live install grant does nothing with the flag off; the refusal is the pre-PR-C refusal and nothing is written', async () => {
    const w = await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    env = { ...env, INSTALLER_WINDOW: undefined } as Env
    const args = { agent: 'agent-b', squad: 'S1', capability: 'member' }
    const withGrant = refusal(await call(op(), 'squad_member_add', args))
    // the same call from an agent that never had a window
    const baselineAuth = agentAuth('agent-op2', 'tok-op2')
    await checkIn(baselineAuth)
    const baseline = refusal(await call(baselineAuth, 'squad_member_add', args))
    expect(withGrant).toEqual(baseline)
    expect(withGrant.error).toBe('operator_principal_required')
    expect(withGrant.detail).not.toHaveProperty('next_step')
    expect(membership('agent-b', 'S1')).toBeNull()
    expect(rows('SELECT 1 FROM operator_delegation_receipts')).toHaveLength(0)
    expect(usage(w.grantId)).toHaveLength(0)
  })

  it('request_elevation for an install action is refused on a flag-off pot', async () => {
    env = { ...env, INSTALLER_WINDOW: undefined } as Env
    const sessionId = await checkIn(op())
    const r = await createElevationRequest(env, {
      tenant: TENANT, agentSessionId: sessionId, agentId: 'agent-op', memberId: 'seat-agent-op',
      actions: [INSTALL_STANDARD_ACTION], scopeType: 'org', scopeId: '', durationMinutes: 60, reason: 'x',
    })
    expect(r.ok).toBe(false)
  })

  it('flag off: status/whoami carries no installer_window, and no synthesized row is ever built', async () => {
    await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    env = { ...env, INSTALLER_WINDOW: undefined } as Env
    expect((await installerDelegationsFor(env, op(), 'squad_member_add')).rows).toEqual([])
    const st = await call(op(), 'status', {})
    expect(st.ok && (st.result as { whoami?: Record<string, unknown> }).whoami).toBeTruthy()
    expect((st as { result: { whoami: Record<string, unknown> } }).result.whoami).not.toHaveProperty('installer_window')
  })
})

describe('standard window: every act allowed in-window, receipted, usage-logged', () => {
  it('squad_member_add / move_agent_squad / squad_member_remove / create_agent / create_squad / HTTP twin', async () => {
    const w = await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')

    expect((await call(op(), 'squad_member_add', { agent: 'agent-b', squad: 'S1', capability: 'member' })).ok).toBe(true)
    expect(membership('agent-b', 'S1')).toBe('member')
    const mv = await call(op(), 'move_agent_squad', { agent: 'agent-d', to_squad: 'S2', capability: 'member' })
    expect(mv.ok, JSON.stringify(mv)).toBe(true)
    expect((await call(op(), 'squad_member_remove', { agent: 'agent-b', squad: 'S1' })).ok).toBe(true)
    expect(membership('agent-b', 'S1')).toBeNull()
    expect((await call(op(), 'create_agent', { squad: 'S1', slug: 'made-agent', name: 'Made' })).ok).toBe(true)
    const cs = await call(op(), 'create_squad', { department: 'D1', slug: 'made-sqd', name: 'Made' })
    expect(cs.ok, JSON.stringify(cs)).toBe(true)
    // P2(d): the squad a window creates is stamped with the grant that authorised it
    expect(rows<{ v: string }>("SELECT created_via_elevation_grant AS v FROM squads WHERE slug = 'made-sqd'")[0].v).toBe(w.grantId)

    authState.current = op()
    const res = await orgApp.request(
      new Request('https://pot.test/agents/agent-b/memberships', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ squad_id: 'S2', capability: 'member' }) }),
      undefined, env,
    )
    expect(res.status, await res.clone().text()).toBeLessThan(300)
    expect(membership('agent-b', 'S2')).toBe('member')

    // one receipt per act, all closed, all under the synthesized id; one usage row per act, all applied
    const receipts = rows<{ delegation_id: string; outcome: string; action: string }>('SELECT delegation_id, outcome, action FROM operator_delegation_receipts')
    expect(receipts.length).toBe(6)
    for (const r of receipts) {
      expect(r.delegation_id).toBe(`elev:${w.grantId}`)
      expect(r.outcome).toBe('applied')
    }
    const u = usage(w.grantId)
    expect(u.map((x) => x.tool_name).sort()).toEqual([
      'create_agent', 'create_squad', 'grant_agent_membership', 'move_agent_squad', 'squad_member_add', 'squad_member_remove',
    ])
    expect(new Set(u.map((x) => x.status))).toEqual(new Set(['applied']))
  })
})

describe('window ends: expiry, revoke, approver demotion, approver session, agent session', () => {
  const act = (): Promise<Awaited<ReturnType<typeof call>>> => call(op(), 'squad_member_add', { agent: 'agent-b', squad: 'S1', capability: 'member' })

  it('allowed while live (anti-vacuity for the refusals below)', async () => {
    await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    expect((await act()).ok).toBe(true)
  })

  it('expired: installer_window_expired, nothing written, whoami drops the window', async () => {
    const w = await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    sql("UPDATE elevation_grants SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", w.grantId)
    const r = refusal(await act())
    expect(r.error).toBe('installer_window_expired')
    expect(r.detail.next_tool).toBe('request_elevation')
    expect(r.detail.who_acts).toBe('owner')
    expect(membership('agent-b', 'S1')).toBeNull()
  })

  it('revoked mid-window: next call refused, window gone from status', async () => {
    const w = await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    expect((await act()).ok).toBe(true)
    const before = (await call(op(), 'status', {})) as { result: { whoami: { installer_window?: { tier: string } } } }
    expect(before.result.whoami.installer_window?.tier).toBe('standard')
    await revokeElevationGrant(env, TENANT, w.grantId, 'test')
    expect(refusal(await call(op(), 'squad_member_remove', { agent: 'agent-b', squad: 'S1' })).error).toBe('installer_window_expired')
    expect(membership('agent-b', 'S1')).toBe('member')
    const after = (await call(op(), 'status', {})) as { result: { whoami: Record<string, unknown> } }
    expect(after.result.whoami).not.toHaveProperty('installer_window')
  })

  it('approver demoted (loses admin): the window is inert without any revoke', async () => {
    await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    sql('DELETE FROM capabilities WHERE member_id = ?', APPROVER)
    expect(refusal(await act()).error).toBe('operator_principal_required')
    expect(membership('agent-b', 'S1')).toBeNull()
  })

  it('approving web session ended: inert', async () => {
    const w = await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    await revokeWebSession(env, TENANT, APPROVER, w.webHash, 'logout')
    expect(refusal(await act()).error).toBe('operator_principal_required')
  })

  it('agent session revoked: inert', async () => {
    const w = await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    sql("UPDATE agent_sessions SET revoked_at = datetime('now') WHERE id = ?", w.sessionId)
    expect(refusal(await act()).error).not.toBe('')
    expect(membership('agent-b', 'S1')).toBeNull()
  })

  it('another agent session cannot use this window', async () => {
    await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    const other = agentAuth('agent-op2', 'tok-op2')
    await checkIn(other)
    const r = refusal(await call(other, 'squad_member_add', { agent: 'agent-b', squad: 'S1', capability: 'member' }))
    expect(r.error).toBe('operator_principal_required')
    expect((await liveInstallerWindows(env, other)).length).toBe(0)
  })
})

describe('ceilings and tier membership', () => {
  it('standard cannot confer lead (above_max_grant), refused with the high-window next step', async () => {
    await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    const r = refusal(await call(op(), 'squad_member_add', { agent: 'agent-b', squad: 'S1', capability: 'lead' }))
    expect(r.error).toBe('requires_human_approval')
    expect(r.detail.next_step).toMatch(/install_high/)
    expect(membership('agent-b', 'S1')).toBeNull()
  })

  it('standard has no grant_agent_capability at all: pointed at the high window', async () => {
    await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    const r = refusal(await call(op(), 'grant_agent_capability', { agent: 'agent-b', squad: 'S1', capability: 'member' }))
    expect(r.error).toBe('requires_human_approval')
    expect(r.detail.reason).toBe('act_needs_high_window')
    expect(membership('agent-b', 'S1')).toBeNull()
  })

  it('high may TOUCH a lead-standing target but standing grants it makes are capped at member (never lead, never admin)', async () => {
    await openWindow(op(), INSTALL_HIGH_ACTION, 'department', 'D1')
    // a lead-standing target is above the standard ceiling but inside high's
    const ok = await call(op(), 'grant_agent_capability', { agent: 'agent-lead-target', squad: 'S1', capability: 'member' })
    expect(ok.ok, JSON.stringify(ok)).toBe(true)
    expect(membership('agent-lead-target', 'S1')).toBe('member')
    for (const cap of ['lead', 'admin']) {
      const r = refusal(await call(op(), 'grant_agent_capability', { agent: 'agent-b', squad: 'S1', capability: cap }))
      expect(r.error, cap).toBe('requires_human_approval')
      expect(membership('agent-b', 'S1'), cap).toBeNull()
    }
    expect(refusal(await call(op(), 'grant_agent_capability', { agent: 'agent-b', squad: 'S1', capability: 'lead' })).detail.reason).toBe('installer_standing_grant_cap_member')
  })

  it('a target above the ceiling is not the window\'s to touch (target standing is global)', async () => {
    await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    const r = refusal(await call(op(), 'squad_member_add', { agent: 'agent-lead-target', squad: 'S1', capability: 'member' }))
    expect(r.error).toBe('requires_human_approval')
    expect(r.detail.reason).toBe('target_outranks_delegation')
  })

  it('standard create_squad is not opened by an ORG-scope window (org-scope squad creation is high-tier): no row, the pre-PR lane decides', async () => {
    await openWindow(op(), INSTALL_STANDARD_ACTION, 'org', '')
    expect((await installerDelegationsFor(env, op(), 'create_squad')).rows).toEqual([])
    expect((await installerDelegationsFor(env, op(), 'squad_member_add')).rows).toHaveLength(1)
    expect(refusal(await call(op(), 'create_squad', { department: 'D1', slug: 'org-made', name: 'x' })).error).toBe('forbidden')
    expect(rows("SELECT 1 FROM squads WHERE slug = 'org-made'")).toHaveLength(0)
  })

  it('tier tables pinned OUTSIDE the registry, both directions', () => {
    const std = ['create_agent', 'create_squad', 'grant_agent_membership', 'move_agent_squad', 'squad_member_add', 'squad_member_remove']
    expect([...INSTALLER_TIERS.standard.acts].sort()).toEqual(std)
    expect([...INSTALLER_TIERS.high.acts].sort()).toEqual([...std, 'grant_agent_capability'].sort())
    expect(INSTALLER_TIERS.standard.maxGrant).toBe('member')
    expect(INSTALLER_TIERS.high.maxGrant).toBe('lead')
    expect(INSTALLER_TIERS.standard.durationsMinutes).toEqual([15, 60, 240])
    expect(INSTALLER_TIERS.high.durationsMinutes).toEqual([15, 60, 240, 480])
    for (const t of [INSTALLER_TIERS.standard, INSTALLER_TIERS.high]) {
      for (const bad of ['mint_agent_token', 'mint_member_token', 'register_agent_key', 'grant_gate_capability', 'member_capability_grant', 'manage_delegations', 'suspend_member', 'create_invite', 'project_squad_set', 'project_squad_remove']) {
        expect((t.acts as ReadonlySet<string>).has(bad), bad).toBe(false)
      }
    }
  })
})

describe('credentials stay OUT of both tiers', () => {
  it.each([[INSTALL_STANDARD_ACTION], [INSTALL_HIGH_ACTION]])('mint_agent_token under %s is refused and mints nothing', async (action) => {
    await openWindow(op(), action, 'org', '')
    const r = refusal(await call(op(), 'mint_agent_token', { agent: 'agent-b' }))
    expect(r.error).toBe('not_in_installer_window')
    expect(r.detail.next_step).toMatch(/action:mint_token/)
    expect(rows("SELECT 1 FROM member_tokens WHERE member_id = 'seat-agent-b' AND label <> 'primary'")).toHaveLength(0)
    for (const credAct of ['mint_member_token', 'register_agent_key'] as const) {
      const v = await authorizeStructuralWrite(env, op(), credAct, {})
      expect(v.kind, credAct).toBe('refused')
      expect((v as { error: string }).error, credAct).toBe('not_in_installer_window')
    }
  })
})

describe('fences inherited from the chokepoint', () => {
  it('home squad as target or source, self, humans, and out-of-scope squads', async () => {
    await openWindow(op(), INSTALL_HIGH_ACTION, 'department', 'D1')
    expect(refusal(await call(op(), 'squad_member_add', { agent: 'agent-b', squad: 'SH', capability: 'member' })).error).toBe('home_scope_not_grantable')
    expect(refusal(await call(op(), 'squad_member_add', { agent: 'agent-op', squad: 'S1', capability: 'member' })).error).toBe('cannot_act_on_self')
    // a human (not an agent seat) can never be the target
    const human = await authorizeStructuralWrite(env, op(), 'squad_member_add', { squadId: 'S1', memberId: 'mem-human', capability: 'member' })
    expect((human as { error?: string }).error).toBe('human_target_forbidden')
    const delegator = await authorizeStructuralWrite(env, op(), 'squad_member_add', { squadId: 'S1', memberId: APPROVER, capability: 'member' })
    expect((delegator as { error?: string }).error).toBe('human_target_forbidden')
    // S3 is in D2: outside a D1 window
    expect(refusal(await call(op(), 'squad_member_add', { agent: 'agent-b', squad: 'S3', capability: 'member' })).error).toBe('outside_delegation_scope')
    expect(membership('agent-b', 'S3')).toBe(null)
  })
})

describe('approval policy: standard via Telegram biometric, high passkey-only, never plain text', () => {
  it('telegramPolicyRefusal: install_high refused, install_standard accepted', () => {
    const base = { decision: 'approve' as const, duration: 60 }
    expect(telegramPolicyRefusal('elevation', { ...base, actions: [INSTALL_HIGH_ACTION] } as never)).toBe(PASSKEY_REQUIRED_MESSAGE)
    expect(telegramPolicyRefusal('elevation', { ...base, actions: [INSTALL_STANDARD_ACTION] } as never)).toBeNull()
  })

  it('decision-time proof: both tiers need a step-up; install_high needs a PASSKEY-class proof, a fresh reauth is not enough', async () => {
    const sessionId = await checkIn(op())
    const decide = async (action: string, over: { recentReauthOk: boolean; decidedViaPasskey?: boolean }) => {
      const created = await createElevationRequest(env, {
        tenant: TENANT, agentSessionId: sessionId, agentId: 'agent-op', memberId: 'seat-agent-op',
        actions: [action], scopeType: 'org', scopeId: '', durationMinutes: 60, reason: 'x',
      })
      if (!created.ok) throw new Error('request refused')
      const req = (await loadElevationRequestById(env, TENANT, created.request.id))!
      const r = await findElevationDecisionRefusal(env, {
        tenant: TENANT, requestId: req.id, decision: 'approve', selectedActions: [action], decidedByMemberId: APPROVER,
        decidedByCapabilities: [{ member_id: APPROVER, scope_type: 'org', scope_id: null, capability: 'admin' }],
        decidedByWebSessionHash: 'h', ...over,
      }, req)
      // a fresh request per call (one pending per action/scope is fine: each decide is read-only here)
      return r ? (r.reason === 'invalid_elevation_request' ? `${r.reason}` : r.reason) : null
    }
    // standard: no step-up = refused (a plain live dashboard session is not enough); step-up = ok
    expect(await decide(INSTALL_STANDARD_ACTION, { recentReauthOk: false })).toBe('reauth_required')
    expect(await decide(INSTALL_STANDARD_ACTION, { recentReauthOk: true })).toBeNull()
    // high: reauth alone (dashboard / access /approve with recentReauthOk) is refused; only a passkey-class proof passes
    expect(await decide(INSTALL_HIGH_ACTION, { recentReauthOk: false })).toBe('reauth_required')
    expect(await decide(INSTALL_HIGH_ACTION, { recentReauthOk: true })).toBe('invalid_elevation_request')
    expect(await decide(INSTALL_HIGH_ACTION, { recentReauthOk: true, decidedViaPasskey: false })).toBe('invalid_elevation_request')
    expect(await decide(INSTALL_HIGH_ACTION, { recentReauthOk: true, decidedViaPasskey: true })).toBeNull()
    expect(SENSITIVE_STEP_UP_ACTIONS.has(INSTALL_HIGH_ACTION)).toBe(true)
    expect(SENSITIVE_STEP_UP_ACTIONS.has(INSTALL_STANDARD_ACTION)).toBe(false)
  })

  it('install_high via the ACCESS path is refused unless ACCESS_REQUIRED_AMR names only passkey-class methods (passkey-only cannot degrade to any fresh Access login); standard is unaffected', async () => {
    const sessionId = await checkIn(op())
    const refusalFor = async (action: string, e: Env) => {
      const created = await createElevationRequest(env, {
        tenant: TENANT, agentSessionId: sessionId, agentId: 'agent-op', memberId: 'seat-agent-op',
        actions: [action], scopeType: 'org', scopeId: '', durationMinutes: 60, reason: 'x',
      })
      if (!created.ok) throw new Error('request refused')
      const req = (await loadElevationRequestById(env, TENANT, created.request.id))!
      return findElevationDecisionRefusal(e, {
        tenant: TENANT, requestId: req.id, decision: 'approve', selectedActions: [action], decidedByMemberId: APPROVER,
        decidedByCapabilities: [{ member_id: APPROVER, scope_type: 'org', scope_id: null, capability: 'admin' }],
        decidedByWebSessionHash: 'h', recentReauthOk: true, decidedViaPasskey: true, decidedViaAccess: true,
      }, req)
    }
    for (const amr of [undefined, '', ' , ', 'pwd', 'hwk,pwd', 'mfa', 'otp']) {
      const r = await refusalFor(INSTALL_HIGH_ACTION, { ...env, ACCESS_REQUIRED_AMR: amr } as Env)
      expect(r?.reason, `amr=${String(amr)}`).toBe('invalid_elevation_request')
    }
    expect(await refusalFor(INSTALL_HIGH_ACTION, { ...env, ACCESS_REQUIRED_AMR: 'hwk' } as Env)).toBeNull()
    expect(await refusalFor(INSTALL_HIGH_ACTION, { ...env, ACCESS_REQUIRED_AMR: 'HWK, swk,webauthn' } as Env)).toBeNull()
    expect(await refusalFor(INSTALL_STANDARD_ACTION, { ...env, ACCESS_REQUIRED_AMR: undefined } as Env)).toBeNull()
  })

  it('flag off at DECISION time: a pending install request cannot be approved (either tier)', async () => {
    const sessionId = await checkIn(op())
    const created = await createElevationRequest(env, {
      tenant: TENANT, agentSessionId: sessionId, agentId: 'agent-op', memberId: 'seat-agent-op',
      actions: [INSTALL_STANDARD_ACTION], scopeType: 'org', scopeId: '', durationMinutes: 60, reason: 'x',
    })
    if (!created.ok) throw new Error('request refused')
    env = { ...env, INSTALLER_WINDOW: undefined } as Env
    const d = await decideElevationRequest(env, {
      tenant: TENANT, requestId: created.request.id, decision: 'approve', selectedActions: [INSTALL_STANDARD_ACTION], decidedByMemberId: APPROVER,
      decidedByCapabilities: [{ member_id: APPROVER, scope_type: 'org', scope_id: null, capability: 'admin' }],
      decidedByWebSessionHash: 'h', recentReauthOk: true, decidedViaPasskey: true,
    })
    expect(d.ok).toBe(false)
    expect(rows('SELECT 1 FROM elevation_grants')).toHaveLength(0)
  })

  it('an attached chat can never use or request an install window', () => {
    expect(isAttachedSudoAction(INSTALL_STANDARD_ACTION)).toBe(false)
    expect(isAttachedSudoAction(INSTALL_HIGH_ACTION)).toBe(false)
  })
})

describe('request-time shape', () => {
  async function req(actions: string[], minutes: number) {
    const sessionId = await checkIn(op())
    return createElevationRequest(env, { tenant: TENANT, agentSessionId: sessionId, agentId: 'agent-op', memberId: 'seat-agent-op', actions, scopeType: 'org', scopeId: '', durationMinutes: minutes, reason: 'x' })
  }
  it('standard allows 15/60/240 only; high allows 480', async () => {
    expect((await req([INSTALL_STANDARD_ACTION], 480)).ok).toBe(false)
    expect((await req([INSTALL_STANDARD_ACTION], 1440)).ok).toBe(false)
    expect((await req([INSTALL_STANDARD_ACTION], 240)).ok).toBe(true)
    expect((await req([INSTALL_HIGH_ACTION], 480)).ok).toBe(true)
    expect((await req([INSTALL_HIGH_ACTION], 1440)).ok).toBe(false)
  })
  it('an install request is made alone: no mixing tiers or other actions (mint included)', async () => {
    expect((await req([INSTALL_STANDARD_ACTION, 'action:mint_token'], 60)).ok).toBe(false)
    expect((await req([INSTALL_STANDARD_ACTION, INSTALL_HIGH_ACTION], 60)).ok).toBe(false)
    expect((await req([INSTALL_STANDARD_ACTION, 'action:manage_access'], 60)).ok).toBe(false)
  })
})

describe('synthesizer: rows only from live grants, only for a tier act', () => {
  it('no grant gives no row; a live grant gives exactly the listed acts', async () => {
    await checkIn(op())
    expect((await installerDelegationsFor(env, op(), 'squad_member_add')).rows).toEqual([])
    const w = await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    const std = await installerDelegationsFor(env, op(), 'squad_member_add')
    expect(std.rows).toHaveLength(1)
    expect(std.rows[0]).toMatchObject({ id: `elev:${w.grantId}`, agent_id: 'agent-op', delegator_member_id: APPROVER, scope_type: 'department', scope_id: 'D1', max_grant: 'member', revoked_at: null })
    expect((await installerDelegationsFor(env, op(), 'grant_agent_capability')).rows).toEqual([])
    expect((await installerDelegationsFor(env, op(), 'mint_agent_token')).rows).toEqual([])
    expect((await installerDelegationsFor(env, op(), 'create_department')).rows).toEqual([])
  })

  it('org-scope window yields scope_id null; a non-agent caller gets nothing', async () => {
    await openWindow(op(), INSTALL_HIGH_ACTION, 'org', '')
    const r = await installerDelegationsFor(env, op(), 'squad_member_add')
    expect(r.rows[0]).toMatchObject({ scope_type: 'org', scope_id: null, max_grant: 'lead' })
    const human = { ...op(), boundAgentId: null } as AuthContext // test fixture: same credential, no agent binding
    expect((await installerDelegationsFor(env, human, 'squad_member_add')).rows).toEqual([])
  })
})

describe('usage log', () => {
  it('a refused act under a live window writes a failed usage row; an applied act writes an applied one; the backstop closes a stuck row', async () => {
    const w = await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    expect((await call(op(), 'squad_member_add', { agent: 'agent-b', squad: 'S1', capability: 'member' })).ok).toBe(true)
    expect(refusal(await call(op(), 'squad_member_add', { agent: 'agent-c', squad: 'S1', capability: 'lead' })).error).toBe('requires_human_approval')
    const u = usage(w.grantId)
    expect(u).toHaveLength(2)
    expect(u[0]).toMatchObject({ tool_name: 'squad_member_add', status: 'applied' })
    expect(u[1]).toMatchObject({ tool_name: 'squad_member_add', status: 'failed', error_code: 'requires_human_approval' })
    expect(JSON.parse(u[0].detail_json)).toMatchObject({ act: 'squad_member_add', tier: 'standard', target_squad_id: 'S1' })

    // an authorised act whose site returns 4xx without closing: the dispatcher backstop flips the usage row too
    const a = op()
    const v = await authorizeStructuralWrite(env, a, 'squad_member_add', { agentId: 'agent-c', squadId: 'S1', capability: 'member' })
    expect(v.kind).toBe('delegated')
    expect(usage(w.grantId).at(-1)?.status).toBe('pending')
    await settleOpenDelegatedReceipts(env, a, 409)
    expect(usage(w.grantId).at(-1)).toMatchObject({ status: 'failed', error_code: 'refused_after_authorization' })
  })

  it('finishDelegatedReceipt itself closes the usage row (applied / failed), without the dispatcher backstop', async () => {
    const w = await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    const a = op()
    const v1 = await authorizeStructuralWrite(env, a, 'squad_member_add', { agentId: 'agent-b', squadId: 'S1', capability: 'member' })
    const v2 = await authorizeStructuralWrite(env, a, 'squad_member_add', { agentId: 'agent-c', squadId: 'S1', capability: 'member' })
    expect(usage(w.grantId).map((x) => x.status)).toEqual(['pending', 'pending'])
    await finishDelegatedReceipt(env, v1, true)
    await finishDelegatedReceipt(env, v2, false)
    expect(usage(w.grantId)).toMatchObject([{ status: 'applied' }, { status: 'failed', error_code: 'not_applied' }])
  })

  it('no window and no usage: a refusal with no window logs nothing and teaches the ask', async () => {
    await checkIn(op())
    const r = refusal(await call(op(), 'squad_member_add', { agent: 'agent-b', squad: 'S1', capability: 'member' }))
    expect(r.error).toBe('operator_principal_required')
    expect(r.detail).toMatchObject({ who_acts: 'owner', next_tool: 'request_elevation', needs: 'human_approval' })
    expect(String(r.detail.next_step)).toMatch(/install_standard/)
    expect(rows('SELECT 1 FROM elevation_usage_log')).toHaveLength(0)
  })
})

describe('whoami', () => {
  it('shows tier, scope, expires_at, acts and used count to the elevated agent while live', async () => {
    const w = await openWindow(op(), INSTALL_HIGH_ACTION, 'department', 'D1')
    expect((await call(op(), 'squad_member_add', { agent: 'agent-b', squad: 'S1', capability: 'member' })).ok).toBe(true)
    const st = (await call(op(), 'status', {})) as { result: { whoami: { installer_window: Record<string, unknown> } } }
    const iw = st.result.whoami.installer_window
    expect(iw).toMatchObject({ tier: 'high', scope_type: 'department', scope_id: 'D1', used: 1, write_cap: 200, standing_grant_cap: 'member' })
    expect(iw.acts).toEqual([...INSTALLER_TIERS.high.acts].sort())
    expect(typeof iw.expires_at).toBe('string')
    expect(w.grantId).toBeTruthy()
  })
})

describe('SCOPE CUT: project edges never ride a window (P0 class, round 2 regression)', () => {
  // A seat's REAL authority is auth.capabilities from resolveSeatCapabilities: it copies the human's squad/department grants.
  // Here the seat-derived context carries a squad grant (S4) that the agent's own DB rows do not show.
  const seatDerived = (): AuthContext => ({
    ...agentAuth('agent-op', 'tok-op'),
    capabilities: [
      { member_id: 'seat-agent-op', scope_type: 'squad', scope_id: 'S1', capability: 'lead' },
      { member_id: 'seat-agent-op', scope_type: 'squad', scope_id: 'S4', capability: 'member' },
      { member_id: 'seat-agent-op', scope_type: 'department', scope_id: 'D1', capability: 'member' },
    ],
  } as AuthContext) // fixture: seat-derived capabilities (the human's grants copied, capped at member)

  it.each([[INSTALL_STANDARD_ACTION], [INSTALL_HIGH_ACTION]])('%s (org window): project_squad_set and project_squad_remove are refused not_in_installer_window for every squad, own or not', async (action) => {
    const w = await openWindow(seatDerived(), action, 'org', '')
    for (const sq of ['S1', 'S2', 'S3', 'S4']) {
      const set = refusal(await call(seatDerived(), 'project_squad_set', { project_id: 'P1', squad_id: sq, access_level: 'write' }))
      expect(set.error, `set ${sq}`).toBe('not_in_installer_window')
      expect(set.detail.next_step).toMatch(/human makes this edge directly/)
      const rem = refusal(await call(seatDerived(), 'project_squad_remove', { project_id: 'P1', squad_id: sq }))
      expect(rem.error, `remove ${sq}`).toBe('not_in_installer_window')
    }
    expect(rows("SELECT squad_id FROM project_squad_access WHERE project_id = 'P1'")).toEqual([{ squad_id: 'S1' }])
    expect(rows('SELECT 1 FROM operator_delegation_receipts')).toHaveLength(0)
    expect(w.grantId).toBeTruthy()
  })

  it('with NO window the pre-PR lane is untouched (the refusal is the window-specific one only while a window is live)', async () => {
    await checkIn(op())
    const r = await call(op(), 'project_squad_set', { project_id: 'P1', squad_id: 'S2', access_level: 'read' })
    expect(r.ok || (!r.ok && r.error !== 'not_in_installer_window')).toBe(true)
  })

  it('ALLOWED, bounded by the caller\'s own rank and the member cap, and never widening the caller: adds/moves/creates inside its own squad', async () => {
    await openWindow(op(), INSTALL_STANDARD_ACTION, 'org', '')
    const before = rows('SELECT * FROM capabilities WHERE member_id = ?', 'seat-agent-op').length
    expect((await call(op(), 'squad_member_add', { agent: 'agent-b', squad: 'S1', capability: 'member' })).ok).toBe(true)
    expect((await call(op(), 'move_agent_squad', { agent: 'agent-d', to_squad: 'S2', capability: 'member' })).ok).toBe(true)
    expect((await call(op(), 'create_agent', { squad: 'S1', slug: 'own-squad-agent', name: 'x' })).ok).toBe(true)
    // none of it touched the caller's own standing
    expect(rows('SELECT * FROM capabilities WHERE member_id = ?', 'seat-agent-op')).toHaveLength(before)
    // and the caller can never be the target (self fence)
    expect(refusal(await call(op(), 'squad_member_add', { agent: 'agent-op', squad: 'S2', capability: 'member' })).error).toBe('cannot_act_on_self')
  })
})

describe('a window cannot destroy authority above its ceiling (agent targets)', () => {
  it('removing or downgrading an admin-standing AGENT is refused under a member window (target standing)', async () => {
    await openWindow(op(), INSTALL_STANDARD_ACTION, 'org', '')
    expect(refusal(await call(op(), 'squad_member_remove', { agent: 'agent-admin-target', squad: 'S3' })).error).toBe('requires_human_approval')
    expect(refusal(await call(op(), 'squad_member_add', { agent: 'agent-admin-target', squad: 'S3', capability: 'observer' })).error).toBe('requires_human_approval')
    expect(membership('agent-admin-target', 'S3')).toBe('admin')
  })
})

describe('per-window caps', () => {
  function fakeUsage(grantId: string, sessionId: string, n: number, status: string): void {
    for (let i = 0; i < n; i++) {
      sql(
        "INSERT INTO elevation_usage_log (id, tenant, elevation_grant_id, agent_session_id, action, tool_name, detail_json, occurred_at, status) VALUES (?, ?, ?, ?, ?, 'x', NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)",
        crypto.randomUUID(), TENANT, grantId, sessionId, INSTALL_STANDARD_ACTION, status,
      )
    }
  }
  it('standard: write 51 is refused, write 50 is not; refused attempts do not consume the cap', async () => {
    const w = await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    fakeUsage(w.grantId, w.sessionId, 40, 'failed') // refused rows never count toward the write cap
    fakeUsage(w.grantId, w.sessionId, 49, 'applied')
    expect((await call(op(), 'squad_member_add', { agent: 'agent-b', squad: 'S1', capability: 'member' })).ok).toBe(true) // the 50th
    const r = refusal(await call(op(), 'squad_member_remove', { agent: 'agent-b', squad: 'S1' })) // the 51st
    expect(r.error).toBe('installer_window_cap_reached')
    expect(membership('agent-b', 'S1')).toBe('member')
  })
  it('high cap is 200', async () => {
    const w = await openWindow(op(), INSTALL_HIGH_ACTION, 'department', 'D1')
    fakeUsage(w.grantId, w.sessionId, 199, 'applied')
    expect((await call(op(), 'squad_member_add', { agent: 'agent-b', squad: 'S1', capability: 'member' })).ok).toBe(true)
    expect(refusal(await call(op(), 'squad_member_remove', { agent: 'agent-b', squad: 'S1' })).error).toBe('installer_window_cap_reached')
  })
  it('the refused-usage log is capped: the refusal is still returned, no more failed rows are written past 100', async () => {
    const w = await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    fakeUsage(w.grantId, w.sessionId, 100, 'failed')
    const r = refusal(await call(op(), 'squad_member_add', { agent: 'agent-c', squad: 'S1', capability: 'lead' }))
    expect(r.error).toBe('requires_human_approval')
    expect(usage(w.grantId).filter((x) => x.status === 'failed')).toHaveLength(100)
  })
})

describe('floor and approver liveness', () => {
  const eAuth = (): AuthContext => ({ ...agentAuth('agent-e', 'tok-e', []), capabilities: [] } as AuthContext) // test fixture: bound agent with zero standing
  const BYPASS = ['create_squad', 'create_agent', 'squad_member_add', 'squad_member_remove', 'grant_agent_capability', 'move_agent_squad', 'project_squad_set', 'project_squad_remove']

  it.each(BYPASS)('%s: an agent with no standing and NO window is refused at the floor', async (tool) => {
    await checkIn(eAuth())
    const r = refusal(await call(eAuth(), tool, {}))
    expect(r.error).toBe('forbidden')
    expect(r.detail.need).toBeTruthy()
  })

  it.each(BYPASS)('%s: with a live window the same agent passes the floor (and fails args validation, not the floor)', async (tool) => {
    await openWindow(eAuth(), INSTALL_HIGH_ACTION, 'org', '', 60, 'agent-e')
    const r = refusal(await call(eAuth(), tool, {}))
    expect(r.error).toBe('invalid_args')
  })

  // create_squad / grant_agent_capability are ALSO in the pre-existing elevation floor bypass (any live grant reaches their handler), unchanged here
  it.each(BYPASS.filter((t) => t !== 'create_squad' && t !== 'grant_agent_capability'))('%s: with the flag OFF a live window does not open the floor', async (tool) => {
    await openWindow(eAuth(), INSTALL_HIGH_ACTION, 'org', '', 60, 'agent-e')
    env = { ...env, INSTALLER_WINDOW: undefined } as Env
    expect(refusal(await call(eAuth(), tool, {})).error).toBe('forbidden')
  })

  it('the approving member being SUSPENDED kills the window without a revoke', async () => {
    await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    sql("UPDATE members SET status = 'suspended' WHERE id = ?", APPROVER)
    expect(refusal(await call(op(), 'squad_member_add', { agent: 'agent-b', squad: 'S1', capability: 'member' })).error).toMatch(/^(delegator_authority_lost|operator_principal_required)$/)
    expect(membership('agent-b', 'S1')).toBeNull()
  })
})

describe('shared decision core carries the passkey-class bit; envelope marker', () => {
  async function viaChannel(via: 'webauthn' | 'access_passkey' | 'telegram_miniapp', action: string) {
    const evidence: Record<string, string> = {}
    if (via === 'telegram_miniapp') {
      // Match the real Mini App proof: a bound private chat, confirmed device and live login identity.
      const telegramUserId = '1001'
      const deviceId = crypto.randomUUID()
      sql('UPDATE members SET telegram_chat_id = ? WHERE id = ?', telegramUserId, APPROVER)
      sql(`INSERT INTO tg_miniapp_devices
        (id, tenant, member_id, telegram_user_id, login_identity_id, enrolment_token_id, secret_sha256, created_at, confirmed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      deviceId, TENANT, APPROVER, telegramUserId, APPROVER_IDENTITY, crypto.randomUUID(), 'a'.repeat(64))
      evidence.tg_device_id = deviceId
      evidence.telegram_user_id = telegramUserId
    }
    const sessionId = await checkIn(op())
    const created = await createElevationRequest(env, {
      tenant: TENANT, agentSessionId: sessionId, agentId: 'agent-op', memberId: 'seat-agent-op',
      actions: [action], scopeType: 'org', scopeId: '', durationMinutes: 60, reason: 'x',
    })
    if (!created.ok) throw new Error('request refused')
    const approver = { userId: APPROVER, email: null, role: 'member', tenant: TENANT, channel: 'workspace', memberId: APPROVER, boundAgentId: null,
      capabilities: [{ member_id: APPROVER, scope_type: 'org', scope_id: null, capability: 'admin' }] } as unknown as AuthContext // fixture human
    const out = await decideElevation(env, {
      id: created.request.id, decision: 'approve', selectedActions: [action], durationMinutes: 60, auth: approver,
      proof: { memberId: APPROVER, via, evidence },
      mintSession: async () => {
        const web = await createWebSession(env, `raw-core-${++webSeq}`, { tenant: TENANT, memberId: APPROVER, loginIdentityId: APPROVER_IDENTITY }, Date.now())
        return { auth: approver, webSessionHash: web.id_hash }
      },
    })
    return { out, grants: rows('SELECT 1 FROM elevation_grants WHERE action = ?', action).length }
  }
  it('install_high: webauthn and access_passkey approve; the Telegram Mini App cannot', async () => {
    const miniapp = await viaChannel('telegram_miniapp', INSTALL_HIGH_ACTION)
    expect(miniapp.grants).toBe(0)
    expect(miniapp.out).toMatchObject({
      status: 409,
      message: 'The decision was not recorded: invalid_elevation_request (action:install_high is approved with a passkey; open the approval link in your browser).',
    })
    expect((await viaChannel('webauthn', INSTALL_HIGH_ACTION)).grants).toBe(1)
  })
  it('install_standard: the Telegram Mini App path approves it', async () => {
    expect((await viaChannel('telegram_miniapp', INSTALL_STANDARD_ACTION)).grants).toBe(1)
  })
  it('the who_acts preference applies only to installer refusals (needs: human_approval marker), not to any other detail', () => {
    const plain = refusalGuidance('operator_principal_required', 403, { next_step: 'x', who_acts: 'self' })
    expect(plain.who_acts).toBe('admin')
    const installer = refusalGuidance('operator_principal_required', 403, { next_step: 'x', who_acts: 'owner', needs: 'human_approval' })
    expect(installer.who_acts).toBe('owner')
  })
})

describe('SCOPE CUT: seat sessions cannot hold or use an installer window (Q2a regression)', () => {
  // The seat's agent member holds DB lead on S1; its human holds nothing there. A second agent is added into S1 under the window.
  const seatAuth = (): AuthContext => ({
    ...agentAuth('agent-op', 'tok-op'),
    seatBinding: { seatId: 'seat-1', label: 'l', harnessId: 'h', grantTokenId: 'g', humanMemberId: 'mem-human', source: 'handle' },
  } as unknown as AuthContext) // fixture: a non-attached seat session

  it.each([[INSTALL_STANDARD_ACTION], [INSTALL_HIGH_ACTION]])('%s: a window in the DB is unusable from a seat session: refused, no membership row, no receipt', async (action) => {
    await openWindow(op(), action, 'department', 'D1') // granted to the same agent session, as the bound agent
    expect(await liveInstallerWindows(env, seatAuth())).toEqual([])
    expect((await installerDelegationsFor(env, seatAuth(), 'squad_member_add')).rows).toEqual([])
    const r = refusal(await call(seatAuth(), 'squad_member_add', { agent: 'agent-b', squad: 'S1', capability: 'member' }))
    expect(r.status).toBe(403)
    expect(membership('agent-b', 'S1')).toBeNull()
    expect(rows('SELECT 1 FROM operator_delegation_receipts')).toHaveLength(0)
    // the same call from the bound agent still works (anti-vacuity)
    expect((await call(op(), 'squad_member_add', { agent: 'agent-b', squad: 'S1', capability: 'member' })).ok).toBe(true)
  })

  it('request_elevation for an install action from a seat session is refused with the bound-agent next step', async () => {
    await checkIn(op())
    for (const action of [INSTALL_STANDARD_ACTION, INSTALL_HIGH_ACTION]) {
      const r = refusal(await call(seatAuth(), 'request_elevation', { actions: [action], scope_type: 'org', duration_minutes: 15, reason: 'x' }))
      expect(r.error).toBe('installer_window_needs_bound_agent')
      expect(String(r.detail.next_step)).toMatch(/bound agent/)
    }
    expect(rows('SELECT 1 FROM elevation_requests')).toHaveLength(0)
  })
})

describe('bot review round (codex): fixes', () => {
  const stdRows = (grantId: string) => usage(grantId)

  it('P1 renew: after a window ends, a fresh approval for the same tier/scope on the same session renews it in place (same grant id, cap reset)', async () => {
    const w1 = await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    expect((await call(op(), 'squad_member_add', { agent: 'agent-b', squad: 'S1', capability: 'member' })).ok).toBe(true)
    sql("UPDATE elevation_grants SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", w1.grantId)
    expect(refusal(await call(op(), 'squad_member_remove', { agent: 'agent-b', squad: 'S1' })).error).toBe('installer_window_expired')
    await new Promise((r) => setTimeout(r, 5))
    const w2 = await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    expect(w2.grantId).toBe(w1.grantId)
    expect(rows('SELECT 1 FROM elevation_grants')).toHaveLength(1)
    expect((await call(op(), 'squad_member_remove', { agent: 'agent-b', squad: 'S1' })).ok).toBe(true)
    const st = (await call(op(), 'status', {})) as { result: { whoami: { installer_window: { used: number } } } }
    expect(st.result.whoami.installer_window.used).toBe(1) // only the usage since the renewal counts toward the cap
  })

  it('P1 renew: a revoked window renews too', async () => {
    const w1 = await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    await revokeElevationGrant(env, TENANT, w1.grantId, 'test')
    const w2 = await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    expect(w2.grantId).toBe(w1.grantId)
    expect((await call(op(), 'squad_member_add', { agent: 'agent-b', squad: 'S1', capability: 'member' })).ok).toBe(true)
  })

  it('P1 role plane: an approver who is owner on the LEGACY role plane (no capability rows) yields a usable window', async () => {
    sql('DELETE FROM capabilities WHERE member_id = ?', APPROVER)
    sql("INSERT INTO users (id, email, role) VALUES ('u-appr', 'approver@example.test', 'owner')")
    const sessionId = await checkIn(op())
    const now = Date.now()
    const web = await createWebSession(env, 'raw-role-plane', { tenant: TENANT, memberId: APPROVER, loginIdentityId: APPROVER_IDENTITY }, now)
    const created = await createElevationRequest(env, { tenant: TENANT, agentSessionId: sessionId, agentId: 'agent-op', memberId: 'seat-agent-op', actions: [INSTALL_STANDARD_ACTION], scopeType: 'department', scopeId: 'D1', durationMinutes: 60, reason: 'x' }, now)
    if (!created.ok) throw new Error('request refused')
    const d = await decideElevationRequest(env, {
      tenant: TENANT, requestId: created.request.id, decision: 'approve', selectedActions: [INSTALL_STANDARD_ACTION], decidedByMemberId: APPROVER,
      decidedByCapabilities: [], decidedByIsOrgAdmin: true, decidedByWebSessionHash: web.id_hash, recentReauthOk: true,
    }, now)
    expect(d.ok, JSON.stringify(d)).toBe(true)
    expect((await liveInstallerWindows(env, op())).length).toBe(1)
    expect((await call(op(), 'squad_member_add', { agent: 'agent-b', squad: 'S1', capability: 'member' })).ok).toBe(true)
  })

  it('P1 role plane: a members.email that merely MATCHES an owner (no verified identity) does not keep a window alive', async () => {
    const w = await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    sql('DELETE FROM capabilities WHERE member_id = ?', APPROVER)
    sql("UPDATE human_login_identities SET verified_email = 'someone-else@example.test' WHERE member_id = ?", APPROVER)
    sql("INSERT INTO users (id, email, role) VALUES ('u-appr', 'approver@example.test', 'owner')")
    expect((await liveInstallerWindows(env, op())).length).toBe(0)
    expect(w.grantId).toBeTruthy()
  })

  it('P1 access/AMR: a verified WebAuthn assertion approves install_high with ACCESS_REQUIRED_AMR unset; the Access path with a non-passkey AMR does not', async () => {
    const sessionId = await checkIn(op())
    const via = async (v: 'webauthn' | 'access_passkey', e: Env) => {
      const created = await createElevationRequest(env, { tenant: TENANT, agentSessionId: sessionId, agentId: 'agent-op', memberId: 'seat-agent-op', actions: [INSTALL_HIGH_ACTION], scopeType: 'org', scopeId: '', durationMinutes: 15, reason: 'x' })
      if (!created.ok) throw new Error('request refused')
      const approver = { userId: APPROVER, email: null, role: 'member', tenant: TENANT, channel: 'workspace', memberId: APPROVER, boundAgentId: null,
        capabilities: [{ member_id: APPROVER, scope_type: 'org', scope_id: null, capability: 'admin' }] } as unknown as AuthContext // fixture human
      await decideElevation(e, { id: created.request.id, decision: 'approve', selectedActions: [INSTALL_HIGH_ACTION], durationMinutes: 15, auth: approver,
        proof: { memberId: APPROVER, via: v, evidence: {} },
        mintSession: async () => ({ auth: approver, webSessionHash: (await createWebSession(env, `raw-amr-${++webSeq}`, { tenant: TENANT, memberId: APPROVER, loginIdentityId: APPROVER_IDENTITY }, Date.now())).id_hash }) })
      const n = rows('SELECT 1 FROM elevation_grants WHERE action = ?', INSTALL_HIGH_ACTION).length
      sql('DELETE FROM elevation_grants'); sql('DELETE FROM elevation_requests')
      return n
    }
    expect(await via('access_passkey', { ...env, ACCESS_REQUIRED_AMR: 'otp' } as Env)).toBe(0)
    expect(await via('access_passkey', { ...env, ACCESS_REQUIRED_AMR: undefined } as Env)).toBe(0)
    expect(await via('webauthn', { ...env, ACCESS_REQUIRED_AMR: undefined } as Env)).toBe(1)
    expect(await via('access_passkey', { ...env, ACCESS_REQUIRED_AMR: 'hwk' } as Env)).toBe(1)
  })

  it('P1 fresh proof: the Telegram trust token never carries an installer approval (routine only for deny / non-installer elevation)', () => {
    const p = (decision: 'approve' | 'deny', actions: string[]) => ({ decision, actions, duration: 60 }) as never
    expect(tgDecisionIsRoutine('elevation', p('approve', ['action:routine_policy']))).toBe(true)
    expect(tgDecisionIsRoutine('elevation', p('approve', [INSTALL_STANDARD_ACTION]))).toBe(false)
    expect(tgDecisionIsRoutine('elevation', p('approve', [INSTALL_HIGH_ACTION]))).toBe(false)
    expect(tgDecisionIsRoutine('elevation', p('deny', [INSTALL_HIGH_ACTION]))).toBe(true)
    expect(tgDecisionIsRoutine('seed_attach', p('approve', []))).toBe(false)
  })

  it('P2 attribution: a refusal is charged to the window the engine evaluated, not the widest', async () => {
    const std = await openWindow(op(), INSTALL_STANDARD_ACTION, 'org', '')
    const high = await openWindow(op(), INSTALL_HIGH_ACTION, 'department', 'D2')
    const r = refusal(await call(op(), 'squad_member_add', { agent: 'agent-b', squad: 'S1', capability: 'lead' }))
    expect(r.error).toBe('requires_human_approval')
    expect(stdRows(std.grantId).filter((x) => x.status === 'failed')).toHaveLength(1)
    expect(stdRows(high.grantId)).toHaveLength(0)
    expect(r.detail.installer_window).toBe('standard')
  })

  it('P2 out-of-tier attempts are logged: credential mint and a high-only act under a standard window', async () => {
    const w = await openWindow(op(), INSTALL_STANDARD_ACTION, 'org', '')
    expect(refusal(await call(op(), 'mint_agent_token', { agent: 'agent-b' })).error).toBe('not_in_installer_window')
    expect(refusal(await call(op(), 'grant_agent_capability', { agent: 'agent-b', squad: 'S1', capability: 'member' })).error).toBe('requires_human_approval')
    expect(stdRows(w.grantId).map((x) => x.error_code)).toEqual(['not_in_installer_window', 'act_needs_high_window'])
  })

  it('P2 boot_context carries installer_window while live', async () => {
    await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    const b = (await call(op(), 'boot_context', {})) as { ok: boolean; result?: { whoami?: { installer_window?: { tier: string } } } }
    expect(b.ok).toBe(true)
    expect(b.result?.whoami?.installer_window?.tier).toBe('standard')
  })

  it('P2 atomic reservation: the last slot goes to exactly one of two reservations', async () => {
    const w = await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    for (let i = 0; i < 49; i++) sql("INSERT INTO elevation_usage_log (id, tenant, elevation_grant_id, agent_session_id, action, tool_name, detail_json, occurred_at, status) VALUES (?, ?, ?, ?, ?, 'x', NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'applied')", crypto.randomUUID(), TENANT, w.grantId, w.sessionId, INSTALL_STANDARD_ACTION)
    const [live] = await liveInstallerWindows(env, op())
    const got = await Promise.all([reserveInstallerWrite(env, TENANT, live, 'a', {}), reserveInstallerWrite(env, TENANT, live, 'b', {})])
    expect(got.filter((x) => x !== null)).toHaveLength(1)
    expect(usage(w.grantId).filter((x) => x.status !== 'failed')).toHaveLength(50)
  })

  it('P2 pending reservations count as used (whoami matches enforcement)', async () => {
    await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    const v = await authorizeStructuralWrite(env, op(), 'squad_member_add', { agentId: 'agent-b', squadId: 'S1', capability: 'member' })
    expect(v.kind).toBe('delegated') // pending, never finished
    const st = (await call(op(), 'status', {})) as { result: { whoami: { installer_window: { used: number } } } }
    expect(st.result.whoami.installer_window.used).toBe(1)
  })

  it('P2 cap fallback: a capped high window does not mask a standard window that still has capacity', async () => {
    const high = await openWindow(op(), INSTALL_HIGH_ACTION, 'org', '')
    const std = await openWindow(op(), INSTALL_STANDARD_ACTION, 'org', '')
    for (let i = 0; i < 200; i++) sql("INSERT INTO elevation_usage_log (id, tenant, elevation_grant_id, agent_session_id, action, tool_name, detail_json, occurred_at, status) VALUES (?, ?, ?, ?, ?, 'x', NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'applied')", crypto.randomUUID(), TENANT, high.grantId, high.sessionId, INSTALL_HIGH_ACTION)
    expect((await call(op(), 'squad_member_add', { agent: 'agent-b', squad: 'S1', capability: 'member' })).ok).toBe(true)
    expect(usage(std.grantId).map((x) => x.status)).toEqual(['applied'])
  })

  it('P2 cap: when EVERY covering window is capped the refusal says so', async () => {
    const w = await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    for (let i = 0; i < 50; i++) sql("INSERT INTO elevation_usage_log (id, tenant, elevation_grant_id, agent_session_id, action, tool_name, detail_json, occurred_at, status) VALUES (?, ?, ?, ?, ?, 'x', NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'applied')", crypto.randomUUID(), TENANT, w.grantId, w.sessionId, INSTALL_STANDARD_ACTION)
    expect(refusal(await call(op(), 'squad_member_add', { agent: 'agent-b', squad: 'S1', capability: 'member' })).error).toBe('installer_window_cap_reached')
    expect(membership('agent-b', 'S1')).toBeNull()
  })

  it('P2 home container: an installer request scoped to a home squad or department is refused', async () => {
    const sessionId = await checkIn(op())
    for (const [t, id] of [['squad', 'SH'], ['department', 'DH']] as const) {
      const r = await createElevationRequest(env, { tenant: TENANT, agentSessionId: sessionId, agentId: 'agent-op', memberId: 'seat-agent-op', actions: [INSTALL_STANDARD_ACTION], scopeType: t, scopeId: id, durationMinutes: 15, reason: 'x' })
      expect(r.ok, t).toBe(false)
    }
  })

  it('P2 HTTP create-squad twin stamps created_via_elevation_grant', async () => {
    const w = await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    authState.current = op()
    const res = await orgApp.request(new Request('https://pot.test/departments/D1/squads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'http-made', name: 'Http Made' }) }), undefined, env)
    expect(res.status, await res.clone().text()).toBe(201)
    expect(rows<{ v: string }>("SELECT created_via_elevation_grant AS v FROM squads WHERE slug = 'http-made'")[0].v).toBe(w.grantId)
  })

  it('P2 approval text no longer promises project access', () => {
    for (const k of [INSTALL_STANDARD_ACTION, INSTALL_HIGH_ACTION]) {
      const d = ELEVATION_ACTIONS[k]
      expect(`${d.label} ${d.description} ${d.effectNote}`.toLowerCase()).not.toMatch(/organi[sz]e[^.]*project|access edge|attach a project/)
    }
  })
})
