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
const { isAttachedSudoAction } = await import('../src/auth/attached-ceiling')
const { SENSITIVE_STEP_UP_ACTIONS } = await import('../src/auth/elevation-actions')

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
    decidedByWebSessionHash: web.id_hash, recentReauthOk: true,
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
  env = { DB: harness.db, TENANT_SLUG: TENANT, SESSIONS: memoryKv(), PUBLIC_ORIGIN: ORIGIN, INSTALLER_WINDOW: '1' } as unknown as Env // fixture env
  authState.current = null
  sessionByToken.clear()
})
afterEach(() => {
  authState.current = null
  vi.useRealTimers()
  harness.sqlite.close()
})

describe('flag OFF: byte-identical behaviour', () => {
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

  it('flag off: whoami/status carries no installer_window, and no synthesized row is ever built', async () => {
    await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    env = { ...env, INSTALLER_WINDOW: undefined } as Env
    expect((await installerDelegationsFor(env, op(), 'squad_member_add')).rows).toEqual([])
    const st = await call(op(), 'status', {})
    expect(st.ok && (st.result as { whoami?: Record<string, unknown> }).whoami).toBeTruthy()
    expect((st as { result: { whoami: Record<string, unknown> } }).result.whoami).not.toHaveProperty('installer_window')
  })
})

describe('standard window: every act allowed in-window, receipted, usage-logged', () => {
  it('squad_member_add / move_agent_squad / squad_member_remove / project_squad_set+remove / create_agent / create_squad / HTTP twin', async () => {
    // squad acts are covered by a department window; project edge acts only by an ORG (or project) window, by design
    const w = await openWindow(op(), INSTALL_STANDARD_ACTION, 'department', 'D1')
    const wOrg = await openWindow(op(), INSTALL_STANDARD_ACTION, 'org', '')

    expect((await call(op(), 'squad_member_add', { agent: 'agent-b', squad: 'S1', capability: 'member' })).ok).toBe(true)
    expect(membership('agent-b', 'S1')).toBe('member')
    const mv = await call(op(), 'move_agent_squad', { agent: 'agent-d', to_squad: 'S2', capability: 'member' })
    expect(mv.ok, JSON.stringify(mv)).toBe(true)
    expect((await call(op(), 'squad_member_remove', { agent: 'agent-b', squad: 'S1' })).ok).toBe(true)
    expect(membership('agent-b', 'S1')).toBeNull()
    expect((await call(op(), 'project_squad_set', { project_id: 'P1', squad_id: 'S2', access_level: 'write' })).ok).toBe(true)
    expect((await call(op(), 'project_squad_remove', { project_id: 'P1', squad_id: 'S2' })).ok).toBe(true)
    expect((await call(op(), 'create_agent', { squad: 'S1', slug: 'made-agent', name: 'Made' })).ok).toBe(true)
    const cs = await call(op(), 'create_squad', { department: 'D1', slug: 'made-sqd', name: 'Made' })
    expect(cs.ok, JSON.stringify(cs)).toBe(true)

    authState.current = op()
    const res = await orgApp.request(
      new Request('https://pot.test/agents/agent-b/memberships', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ squad_id: 'S2', capability: 'member' }) }),
      undefined, env,
    )
    expect(res.status, await res.clone().text()).toBeLessThan(300)
    expect(membership('agent-b', 'S2')).toBe('member')

    // one receipt per act, all closed, all under the synthesized id; one usage row per act, all applied
    const receipts = rows<{ delegation_id: string; outcome: string; action: string }>('SELECT delegation_id, outcome, action FROM operator_delegation_receipts')
    expect(receipts.length).toBe(8)
    for (const r of receipts) {
      expect([`elev:${w.grantId}`, `elev:${wOrg.grantId}`]).toContain(r.delegation_id)
      expect(r.outcome).toBe('applied')
    }
    const u = [...usage(w.grantId), ...usage(wOrg.grantId)]
    expect(u.map((x) => x.tool_name).sort()).toEqual([
      'create_agent', 'create_squad', 'grant_agent_membership', 'move_agent_squad', 'project_squad_remove', 'project_squad_set', 'squad_member_add', 'squad_member_remove',
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

  it('high may confer lead but never admin', async () => {
    await openWindow(op(), INSTALL_HIGH_ACTION, 'department', 'D1')
    const ok = await call(op(), 'grant_agent_capability', { agent: 'agent-b', squad: 'S1', capability: 'lead' })
    expect(ok.ok, JSON.stringify(ok)).toBe(true)
    expect(membership('agent-b', 'S1')).toBe('lead')
    const adm = refusal(await call(op(), 'grant_agent_capability', { agent: 'agent-c', squad: 'S1', capability: 'admin' }))
    expect(adm.error).toBe('requires_human_approval')
    expect(membership('agent-c', 'S1')).toBeNull()
  })

  it('project access admin is above both tiers', async () => {
    await openWindow(op(), INSTALL_HIGH_ACTION, 'org', '')
    expect(refusal(await call(op(), 'project_squad_set', { project_id: 'P1', squad_id: 'S2', access_level: 'admin' })).error).toBe('requires_human_approval')
    expect((await call(op(), 'project_squad_set', { project_id: 'P1', squad_id: 'S2', access_level: 'write' })).ok).toBe(true)
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
    const std = ['create_agent', 'create_squad', 'grant_agent_membership', 'move_agent_squad', 'project_squad_remove', 'project_squad_set', 'squad_member_add', 'squad_member_remove']
    expect([...INSTALLER_TIERS.standard.acts].sort()).toEqual(std)
    expect([...INSTALLER_TIERS.high.acts].sort()).toEqual([...std, 'grant_agent_capability'].sort())
    expect(INSTALLER_TIERS.standard.maxGrant).toBe('member')
    expect(INSTALLER_TIERS.high.maxGrant).toBe('lead')
    expect(INSTALLER_TIERS.standard.durationsMinutes).toEqual([15, 60, 240])
    expect(INSTALLER_TIERS.high.durationsMinutes).toEqual([15, 60, 240, 480])
    for (const t of [INSTALLER_TIERS.standard, INSTALLER_TIERS.high]) {
      for (const bad of ['mint_agent_token', 'mint_member_token', 'register_agent_key', 'grant_gate_capability', 'member_capability_grant', 'manage_delegations', 'suspend_member', 'create_invite']) {
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

  it('install_high needs a recent passkey step-up at decision time; standard does not', async () => {
    const sessionId = await checkIn(op())
    for (const [action, needsStepUp] of [[INSTALL_HIGH_ACTION, true], [INSTALL_STANDARD_ACTION, false]] as const) {
      const created = await createElevationRequest(env, {
        tenant: TENANT, agentSessionId: sessionId, agentId: 'agent-op', memberId: 'seat-agent-op',
        actions: [action], scopeType: 'org', scopeId: '', durationMinutes: 60, reason: 'x',
      })
      if (!created.ok) throw new Error('request refused')
      const req = (await loadElevationRequestById(env, TENANT, created.request.id))!
      const refusalNow = await findElevationDecisionRefusal(env, {
        tenant: TENANT, requestId: req.id, decision: 'approve', selectedActions: [action], decidedByMemberId: APPROVER,
        decidedByCapabilities: [{ member_id: APPROVER, scope_type: 'org', scope_id: null, capability: 'admin' }],
        decidedByWebSessionHash: 'h', recentReauthOk: false,
      }, req)
      expect(refusalNow?.reason ?? null, action).toBe(needsStepUp ? 'reauth_required' : null)
    }
    expect(SENSITIVE_STEP_UP_ACTIONS.has(INSTALL_HIGH_ACTION)).toBe(true)
    expect(SENSITIVE_STEP_UP_ACTIONS.has(INSTALL_STANDARD_ACTION)).toBe(false)
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
    expect(iw).toMatchObject({ tier: 'high', scope_type: 'department', scope_id: 'D1', used: 1 })
    expect(iw.acts).toEqual([...INSTALLER_TIERS.high.acts].sort())
    expect(typeof iw.expires_at).toBe('string')
    expect(w.grantId).toBeTruthy()
  })
})
