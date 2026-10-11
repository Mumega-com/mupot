// tests/elevation-decide-mcp.test.ts — elevation_decide (mupot task 31491b14, MCP-first), through the
// REAL seam (invokeTool), real migration chain. Every refusal asserts the WHOLE elevation ledger is
// byte-identical before/after (no grant, no status flip), not just the reason string.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { createWebSession, revokeWebSession } from '../src/auth/web-sessions'
import { createElevationRequest, hasElevatedAction } from '../src/auth/elevation'
import { createHomeForMember } from '../src/org/service'

const TENANT = 'mumega'
const DEPT = 'dept-1'
const SQUAD = 'squad-1'
const AGENT_ID = 'agent-a'
const AGENT_MEMBER = 'member-agent-a'
const ADMIN = 'member-admin'
const SQUAD_ADMIN = 'member-squad-admin'
const TOKEN_ID = 'token-a-1'
const BASE = 'https://pot.example'

describe('elevation_decide — human MCP approval through the shared decision function', () => {
  let harness: SqliteD1Harness
  let env: Env

  async function seedMember(id: string, email: string | null): Promise<void> {
    await env.DB.prepare(`INSERT INTO members (id, tenant, email, display_name, status, created_at) VALUES (?1, ?2, ?3, ?1, 'active', datetime('now'))`)
      .bind(id, TENANT, email).run()
  }

  beforeEach(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
    await env.DB.prepare(`INSERT INTO departments (id, slug, name) VALUES (?1, 'dept', 'Dept')`).bind(DEPT).run()
    await env.DB.prepare(`INSERT INTO squads (id, department_id, slug, name) VALUES (?1, ?2, 'squad', 'Squad One')`).bind(SQUAD, DEPT).run()
    await env.DB.prepare(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES (?1, ?2, 'agent-a', 'Agent A', 'member', 'test', 'active')`).bind(AGENT_ID, SQUAD).run()
    await seedMember(AGENT_MEMBER, null)
    await seedMember(ADMIN, 'admin@x.test')
    await seedMember(SQUAD_ADMIN, 'sq@x.test')
    await env.DB.prepare(`INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES (?1, ?2, ?3, datetime('now'))`).bind(TENANT, AGENT_ID, AGENT_MEMBER).run()
    await env.DB.prepare(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at) VALUES (?1, ?2, 'hash-1', 'primary', 'workspace', ?3, ?4, datetime('now'))`).bind(TOKEN_ID, AGENT_MEMBER, TENANT, AGENT_ID).run()
    // the approver's standing authority must exist in the DB: hasElevatedAction re-derives it on every use
    await env.DB.prepare(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-org', ?1, 'org', NULL, 'admin')`).bind(ADMIN).run()
    for (const m of [ADMIN, SQUAD_ADMIN]) {
      await env.DB.prepare(`INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at) VALUES (?1, ?2, 'google', ?1, ?1, ?3, datetime('now'))`).bind(`id-${m}`, TENANT, m).run()
    }
  })
  afterEach(() => harness.close())

  const agentAuth = (): AuthContext => ({ userId: AGENT_MEMBER, memberId: AGENT_MEMBER, email: null, role: 'member', tenant: TENANT, channel: 'workspace', boundAgentId: AGENT_ID, capabilities: [], tokenId: TOKEN_ID })
  const orgAdminGrant = [{ member_id: ADMIN, scope_type: 'org' as const, scope_id: null, capability: 'admin' as const }]
  const adminAuth = (): AuthContext => ({ userId: ADMIN, memberId: ADMIN, email: 'admin@x.test', role: 'member', tenant: TENANT, channel: 'workspace', boundAgentId: null, tokenId: 'tok-admin', capabilities: orgAdminGrant })
  const squadAdminAuth = (): AuthContext => ({ userId: SQUAD_ADMIN, memberId: SQUAD_ADMIN, email: 'sq@x.test', role: 'member', tenant: TENANT, channel: 'workspace', boundAgentId: null, tokenId: 'tok-sq', capabilities: [{ member_id: SQUAD_ADMIN, scope_type: 'squad', scope_id: SQUAD, capability: 'admin' }] })

  async function adminWebSession(): Promise<string> {
    return (await createWebSession(env, 'raw-admin', { tenant: TENANT, memberId: ADMIN, loginIdentityId: `id-${ADMIN}` })).id_hash
  }

  async function request(actions: string[]): Promise<string> {
    await invokeTool(agentAuth(), env, 'check_in', {}, BASE)
    const res = await invokeTool(agentAuth(), env, 'request_elevation', { actions, scope_type: 'squad', scope_id: SQUAD, duration_minutes: 60, reason: 'ship it' }, BASE)
    expect(res.ok).toBe(true)
    return (res.result as { request: { id: string } }).request.id
  }

  async function ledger(): Promise<string> {
    const out: unknown[] = []
    for (const t of ['elevation_requests', 'elevation_grants', 'elevation_usage_log']) {
      out.push((await env.DB.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()).results)
    }
    return JSON.stringify(out)
  }
  const count = async (sql: string): Promise<number> => (await env.DB.prepare(sql).first<{ n: number }>())?.n ?? -1
  const receipts = async (op?: string): Promise<number> =>
    count(`SELECT COUNT(*) n FROM mutation_audit_entries WHERE handler = 'elevation_decide'${op ? ` AND operation = '${op}'` : ''}`)

  async function refused(auth: AuthContext, args: Record<string, unknown>, status: number, error: string): Promise<void> {
    const before = await ledger()
    const res = await invokeTool(auth, env, 'elevation_decide', args, BASE)
    expect(res.ok).toBe(false)
    if (!res.ok) { expect(res.status).toBe(status); expect(res.error).toBe(error) }
    expect(await ledger()).toBe(before)
  }

  it('an agent-bound token is refused human_accept_required, even carrying an org-admin grant; nothing changes', async () => {
    const id = await request(['action:project_status'])
    await adminWebSession()
    await refused({ ...agentAuth(), capabilities: orgAdminGrant }, { request_id: id, decision: 'approve' }, 403, 'human_accept_required')
  })

  it('an unbound token on an agent\'s own member row is refused human_accept_required', async () => {
    const id = await request(['action:project_status'])
    await refused({ ...adminAuth(), userId: AGENT_MEMBER, memberId: AGENT_MEMBER }, { request_id: id, decision: 'deny' }, 403, 'human_accept_required')
  })

  it('a seat/harness/consented session is refused human_accept_required', async () => {
    const id = await request(['action:project_status'])
    await refused({ ...adminAuth(), consentedByMemberId: ADMIN }, { request_id: id, decision: 'approve' }, 403, 'human_accept_required')
    // a harness-credential session is stopped even earlier, by invokeTool's own harness gate
    const h = await invokeTool({ ...adminAuth(), harnessCredential: true }, env, 'elevation_decide', { request_id: id, decision: 'approve' }, BASE)
    expect(h.ok).toBe(false)
    expect(await count(`SELECT COUNT(*) n FROM elevation_grants`)).toBe(0)
  })

  it('a squad admin (not org admin) is refused forbidden here; the dashboard remains their door', async () => {
    const id = await request(['action:project_status'])
    await refused(squadAdminAuth(), { request_id: id, decision: 'approve' }, 403, 'forbidden')
  })

  it('the requester can never decide its own request: decider member == request.member_id', async () => {
    const id = await request(['action:project_status'])
    await adminWebSession()
    // Re-point the request at the admin member (a non-agent human): only the inner guard can stop it.
    await env.DB.prepare(`UPDATE elevation_requests SET member_id = ?1 WHERE id = ?2`).bind(ADMIN, id).run()
    await refused(adminAuth(), { request_id: id, decision: 'approve' }, 403, 'forbidden')
    expect(await receipts('refused:forbidden')).toBe(1)
  })

  it('approve: grants exactly what was requested, bound to the approver\'s live web session; one success receipt; agent can use it', async () => {
    const id = await request(['action:project_status'])
    const hash = await adminWebSession()
    const res = await invokeTool(adminAuth(), env, 'elevation_decide', { request_id: id, decision: 'approve', note: 'ok' }, BASE)
    expect(res.ok).toBe(true)
    const body = res.result as { grants: Array<{ action: string; scope_id: string; label: string }>; audit_receipt_id: string }
    expect(body.grants).toHaveLength(1)
    expect(body.grants[0]).toMatchObject({ action: 'action:project_status', scope_id: SQUAD })
    const grant = await env.DB.prepare(`SELECT approved_by_member_id m, approved_by_web_session_hash h, expires_at FROM elevation_grants`).first<{ m: string; h: string; expires_at: string }>()
    expect(grant).toMatchObject({ m: ADMIN, h: hash })
    const req = await env.DB.prepare(`SELECT status, decided_by_member_id m, decision_note n FROM elevation_requests WHERE id = ?1`).bind(id).first<{ status: string; m: string; n: string }>()
    expect(req).toMatchObject({ status: 'approved', m: ADMIN, n: '[via mcp] ok' })
    expect(await receipts('approve')).toBe(1)
    // the grant is real: the approver's authority + session liveness are re-derived on use
    const used = await hasElevatedAction(env, agentAuth(), 'action:project_status', 'squad', SQUAD, { recordUsage: false })
    expect(used.granted).toBe(true)
    // ...and ends when the approving dashboard session ends (grant bound to that session)
    await revokeWebSession(env, TENANT, ADMIN, hash, 'logout')
    const after = await hasElevatedAction(env, agentAuth(), 'action:project_status', 'squad', SQUAD, { recordUsage: false })
    expect(after).toEqual({ granted: false, reason: 'approver_session_ended' })
  })

  it('deny: request denied, zero grants, one deny receipt', async () => {
    const id = await request(['action:project_status'])
    await adminWebSession()
    const res = await invokeTool(adminAuth(), env, 'elevation_decide', { request_id: id, decision: 'deny', note: 'no' }, BASE)
    expect(res.ok).toBe(true)
    expect(await count(`SELECT COUNT(*) n FROM elevation_grants`)).toBe(0)
    expect((await env.DB.prepare(`SELECT status FROM elevation_requests WHERE id = ?1`).bind(id).first<{ status: string }>())?.status).toBe('denied')
    expect(await receipts('deny')).toBe(1)
  })

  it('double-decide is idempotent: the second call is already_decided, no second grant set, no second success receipt', async () => {
    const id = await request(['action:project_status'])
    await adminWebSession()
    expect((await invokeTool(adminAuth(), env, 'elevation_decide', { request_id: id, decision: 'approve' }, BASE)).ok).toBe(true)
    await refused(adminAuth(), { request_id: id, decision: 'approve' }, 409, 'already_decided')
    await refused(adminAuth(), { request_id: id, decision: 'deny' }, 409, 'already_decided')
    expect(await count(`SELECT COUNT(*) n FROM elevation_grants`)).toBe(1)
    expect(await receipts('approve')).toBe(1)
    expect(await receipts('refused:already_decided')).toBe(2)
  })

  it('an expired decision window refuses request_expired; nothing granted', async () => {
    const id = await request(['action:project_status'])
    await adminWebSession()
    await env.DB.prepare(`UPDATE elevation_requests SET decision_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1`).bind(id).run()
    const res = await invokeTool(adminAuth(), env, 'elevation_decide', { request_id: id, decision: 'approve' }, BASE)
    expect(res.ok).toBe(false)
    if (!res.ok) { expect(res.status).toBe(409); expect(res.error).toBe('request_expired') }
    expect(await count(`SELECT COUNT(*) n FROM elevation_grants`)).toBe(0)
    expect((await env.DB.prepare(`SELECT status FROM elevation_requests WHERE id = ?1`).bind(id).first<{ status: string }>())?.status).toBe('expired')
  })

  it('a request bound to an ended agent session refuses agent_session_ended and nothing is granted', async () => {
    const id = await request(['action:project_status'])
    await adminWebSession()
    expect((await invokeTool(agentAuth(), env, 'end_agent_session', {}, BASE)).ok).toBe(true)
    const res = await invokeTool(adminAuth(), env, 'elevation_decide', { request_id: id, decision: 'approve' }, BASE)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('agent_session_ended')
    expect(await count(`SELECT COUNT(*) n FROM elevation_grants`)).toBe(0)
    expect(await receipts('refused:agent_session_ended')).toBe(1)
  })

  it('a sensitive action cannot be approved over MCP (no step-up): reauth_required, request stays pending; the safe subset can be approved by narrowing', async () => {
    const id = await request(['action:manage_access', 'action:project_status'])
    await adminWebSession()
    await refused(adminAuth(), { request_id: id, decision: 'approve' }, 403, 'reauth_required')
    expect((await env.DB.prepare(`SELECT status FROM elevation_requests WHERE id = ?1`).bind(id).first<{ status: string }>())?.status).toBe('pending')
    // narrowing to the sensitive action alone is still refused
    await refused(adminAuth(), { request_id: id, decision: 'approve', actions: ['action:manage_access'] }, 403, 'reauth_required')
    const ok = await invokeTool(adminAuth(), env, 'elevation_decide', { request_id: id, decision: 'approve', actions: ['action:project_status'] }, BASE)
    expect(ok.ok).toBe(true)
    expect((await env.DB.prepare(`SELECT action FROM elevation_grants`).all<{ action: string }>()).results.map((r) => r.action)).toEqual(['action:project_status'])
  })

  it('deny of a sensitive request is allowed over MCP (deny never needs step-up, as on the dashboard)', async () => {
    const id = await request(['action:manage_access'])
    await adminWebSession()
    expect((await invokeTool(adminAuth(), env, 'elevation_decide', { request_id: id, decision: 'deny' }, BASE)).ok).toBe(true)
  })

  it('with no live dashboard session the approval is refused web_session_required (no unbound grant)', async () => {
    const id = await request(['action:project_status'])
    await refused(adminAuth(), { request_id: id, decision: 'approve' }, 409, 'web_session_required')
  })

  it('an unknown id reads as not_found and a bad argument shape is a 400', async () => {
    await adminWebSession()
    await refused(adminAuth(), { request_id: 'nope', decision: 'approve' }, 404, 'not_found')
    const res = await invokeTool(adminAuth(), env, 'elevation_decide', { request_id: 'x', decision: 'maybe' }, BASE)
    expect(res.ok).toBe(false)
  })

  it('elevation_status for a human org admin shows exactly what would be granted and who is asking; agents and squad admins keep their old behaviour', async () => {
    const id = await request(['action:manage_access', 'action:project_status'])
    const res = await invokeTool(adminAuth(), env, 'elevation_status', {}, BASE)
    expect(res.ok).toBe(true)
    const view = res.result as { view: string; pending_requests: Array<Record<string, any>> }
    expect(view.view).toBe('human')
    expect(view.pending_requests).toHaveLength(1)
    const r = view.pending_requests[0]
    expect(r).toMatchObject({ id, scope_type: 'squad', scope_id: SQUAD, scope_name: 'Squad One', duration_minutes: 60, reason: 'ship it', approvable_over_mcp: false, approvable_subset_over_mcp: ['action:project_status'] })
    expect(r.requester).toMatchObject({ agent_id: AGENT_ID, agent_slug: 'agent-a', session_live: true })
    expect(r.actions.map((a: { key: string; label: string; needs_dashboard_reauth: boolean }) => [a.key, a.label, a.needs_dashboard_reauth])).toEqual([
      ['action:manage_access', 'Manage access', true],
      ['action:project_status', 'Change project status or restore archived rows', false],
    ])
    const one = await invokeTool(adminAuth(), env, 'elevation_status', { request_id: id }, BASE)
    expect((one.result as { request: { id: string } }).request.id).toBe(id)
    const missing = await invokeTool(adminAuth(), env, 'elevation_status', { request_id: 'nope' }, BASE)
    expect((missing.result as { request: unknown }).request).toBeNull()
    // squad admin: not a human org admin here -> still the old 403
    const sq = await invokeTool(squadAdminAuth(), env, 'elevation_status', {}, BASE)
    expect(sq.ok).toBe(false)
    // the agent still gets its own session view
    const ag = await invokeTool(agentAuth(), env, 'elevation_status', { request_id: id }, BASE)
    expect((ag.result as { session_id: string }).session_id).toBeTruthy()
  })

  it('the human status view is read-only: it does not sweep an expired request (no writes)', async () => {
    const id = await request(['action:project_status'])
    await env.DB.prepare(`UPDATE elevation_requests SET decision_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1`).bind(id).run()
    const before = await ledger()
    const res = await invokeTool(adminAuth(), env, 'elevation_status', {}, BASE)
    expect((res.result as { pending_requests: unknown[] }).pending_requests).toHaveLength(0)
    const one = await invokeTool(adminAuth(), env, 'elevation_status', { request_id: id }, BASE)
    expect((one.result as { request: { status: string } }).request.status).toBe('expired')
    expect(await ledger()).toBe(before)
  })

  it('a bound agent flag on an otherwise-human token is refused on its own (independent of the agent-member check)', async () => {
    const id = await request(['action:project_status'])
    await refused({ ...adminAuth(), boundAgentId: AGENT_ID }, { request_id: id, decision: 'approve' }, 403, 'human_accept_required')
  })

  it('a request on a member\'s HOME squad is invisible and undecidable to an org admin who holds nothing on it (rank ceiling guards the target)', async () => {
    await adminWebSession()
    const checkin = await invokeTool(agentAuth(), env, 'check_in', {}, BASE)
    const sessionId = (checkin.result as { agent_session: { id: string } }).agent_session.id
    const home = await createHomeForMember(env, SQUAD_ADMIN)
    if (!home.ok) throw new Error('home setup failed')
    const created = await createElevationRequest(env, {
      tenant: TENANT, agentSessionId: sessionId, agentId: AGENT_ID, memberId: AGENT_MEMBER,
      actions: ['action:home_access'], scopeType: 'squad', scopeId: home.squad.id, durationMinutes: 60, reason: 'visit',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const list = await invokeTool(adminAuth(), env, 'elevation_status', {}, BASE)
    expect((list.result as { pending_requests: unknown[] }).pending_requests).toHaveLength(0)
    const one = await invokeTool(adminAuth(), env, 'elevation_status', { request_id: created.request.id }, BASE)
    expect((one.result as { request: unknown }).request).toBeNull()
    await refused(adminAuth(), { request_id: created.request.id, decision: 'approve' }, 404, 'not_found')
    await refused(adminAuth(), { request_id: created.request.id, decision: 'deny' }, 404, 'not_found')
  })
})
