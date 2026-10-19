// tests/owner-sudo.test.ts — "/muapprove = sudo": an agent makes ONE call of ONE owner-only tool, as the approving human, after the
// human taps Approve in Telegram. Real migrated schema + the REAL tools through invokeTool + the REAL approval-bot decision path;
// only the Bot API (global fetch) is stubbed. Every guard in src/auth/owner-sudo.ts has a test that fails without it.
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeTool } from '../src/mcp/index' // first: the mcp/seeds modules form an import cycle that only resolves from mcp/index
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { handleApprovalBotUpdate } from '../src/approval-bot/decide'
import { OWNER_SUDO_ACTIONS } from '../src/auth/elevation-actions'
import { OWNER_SUDO_ACTION_FOR_TOOL } from '../src/auth/owner-sudo'

const TENANT = 'tenant-a'
const BOT_TOKEN = '987654321:AAEhqMY-approval-bot-test-token-xyz'
const TG = { owner: 1001, sqadmin: 1003, admin: 1005 }

let harness: SqliteD1Harness
let env: Env
const one = <T>(sql: string, ...p: unknown[]): T => harness.sqlite.prepare(sql).get(...p) as T
const count = (t: string, where = '1=1'): number => one<{ n: number }>(`SELECT COUNT(*) AS n FROM "${t}" WHERE ${where}`).n
const run = (sql: string): void => { harness.sqlite.exec(sql) }

function stubBot(): void {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: true, result: { message_id: 600 } }), { status: 200 }))
}
const agentAuth = (): AuthContext => ({
  userId: 'mem-x', email: 'x@x.test', role: 'member', tenant: TENANT, channel: 'workspace', memberId: 'mem-x', tokenId: 'tok-x',
  capabilities: [{ member_id: 'mem-x', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' } as CapabilityGrant], boundAgentId: 'agent-x',
})
const call = (tool: string, args: Record<string, unknown>, auth: AuthContext = agentAuth()) => invokeTool(auth, env, tool, args, 'https://pot.test')
type Out = { ok: boolean; status?: number; error?: string; detail?: unknown; result?: Record<string, unknown> }
const out = async (tool: string, args: Record<string, unknown>, auth?: AuthContext): Promise<Out> => (await call(tool, args, auth)) as Out

let seq = 100
const msg = (text: string, from: number) => ({ update_id: ++seq, message: { message_id: 7, from: { id: from }, chat: { id: from, type: 'private' }, text } })

/** The agent files the request through the real tool; the human approves through the real bot path. Returns the request id. */
async function requestAndApprove(action: string, scope: { type: 'org' | 'squad'; id?: string }, opts: { approver?: number; duration?: number; decision?: 'approve' | 'deny' } = {}): Promise<string> {
  await call('check_in', {})
  const r = await out('request_elevation', { actions: [action], scope_type: scope.type, ...(scope.id ? { scope_id: scope.id } : {}), duration_minutes: opts.duration ?? 15, reason: 'do the one thing' })
  if (!r.ok) throw new Error(`request failed ${JSON.stringify(r)}`)
  const id = (r.result as { request: { id: string } }).request.id
  const shortId = one<{ short_id: string }>('SELECT short_id FROM elevation_requests WHERE id = ?', id).short_id
  const res = await handleApprovalBotUpdate(env, msg(`/mu${opts.decision === 'deny' ? 'deny' : 'approve'} ${shortId}`, opts.approver ?? TG.owner))
  if (opts.decision !== 'deny' && res.kind !== 'approved') throw new Error(`approve failed ${JSON.stringify(res)}`)
  return id
}
const grantRow = (reqId: string): { id: string; action: string } => one('SELECT id, action FROM elevation_grants WHERE elevation_request_id = ?', reqId)
const usage = (reqId: string): Array<{ status: string }> => harness.sqlite.prepare('SELECT u.status AS status FROM elevation_usage_log u JOIN elevation_grants g ON g.id = u.elevation_grant_id WHERE g.elevation_request_id = ?').all(reqId) as Array<{ status: string }>
const memberOf = (agent: string, squad: string): { capability: string } | undefined =>
  harness.sqlite.prepare('SELECT capability FROM memberships WHERE agent_id = ? AND squad_id = ?').get(agent, squad) as { capability: string } | undefined

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  run(`
    INSERT INTO org_settings (key, value) VALUES ('billing_state', '{"tier":"scale"}');
    INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept', 'a-sqd', 'A'), ('squad-b', 'dept', 'b-sqd', 'B');
    INSERT INTO users (id, email, role) VALUES ('u-owner', 'owner@x.test', 'owner');
    INSERT INTO members (id, email, display_name, status, tenant, telegram_chat_id) VALUES
      ('mem-owner', 'owner@x.test', 'Owner', 'active', '${TENANT}', '${TG.owner}'),
      ('mem-sqadmin', 'sqadmin@x.test', 'Squad Admin', 'active', '${TENANT}', '${TG.sqadmin}'),
      ('mem-admin', 'admin@x.test', 'Cap Admin', 'active', '${TENANT}', '${TG.admin}'),
      ('mem-x', 'x@x.test', 'Agent X', 'active', '${TENANT}', NULL),
      ('mem-y', 'y@x.test', 'Agent Y', 'active', '${TENANT}', NULL),
      ('mem-target', 'target@x.test', 'Target', 'active', '${TENANT}', NULL),
      ('host-m', 'host@x.test', 'Host', 'active', '${TENANT}', NULL);
    INSERT INTO agents (id, squad_id, slug, name, role, model, status, owner_member_id) VALUES
      ('agent-x', 'squad-a', 'agent-x', 'Agent X', 'r', 'm', 'active', 'mem-owner'),
      ('agent-y', 'squad-a', 'agent-y', 'Agent Y', 'r', 'm', 'active', NULL),
      ('agent-u', 'squad-a', 'agent-u', 'Agent U (unminted)', 'r', 'm', 'active', NULL);
    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('ms-x', 'agent-x', 'squad-a', 'member'), ('ms-y', 'agent-y', 'squad-a', 'member');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
      ('${TENANT}', 'agent-x', 'mem-x', datetime('now')), ('${TENANT}', 'agent-y', 'mem-y', datetime('now'));
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at)
      VALUES ('tok-x', 'mem-x', 'hash-x', 'primary', 'workspace', '${TENANT}', 'agent-x', datetime('now'));
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-o', 'mem-owner', 'org', NULL, 'owner'),
      ('cap-sa', 'mem-sqadmin', 'squad', 'squad-a', 'admin'),
      ('cap-sa-b', 'mem-sqadmin', 'squad', 'squad-b', 'admin'),
      ('cap-adm', 'mem-admin', 'org', NULL, 'admin'),
      ('cap-host', 'host-m', 'squad', 'squad-a', 'member');
    INSERT INTO agent_keys (tenant, agent_id, pubkey, algo, member_id, created_at) VALUES ('${TENANT}', 'host-1', 'AAAA', 'Ed25519', 'host-m', 1760000000);
  `)
  env = {
    DB: harness.db, TENANT_SLUG: TENANT, CONNECTOR_MASTER_KEY: 'a1'.repeat(32), PUBLIC_ORIGIN: 'https://colony.example.test',
    APPROVAL_BOT_TOKEN: BOT_TOKEN, APPROVAL_BOT_WEBHOOK_SECRET: 'approval-webhook-secret-0123456789', APPROVAL_BOT_USERNAME: 'muapprove_test_bot',
  } as unknown as Env
  stubBot()
})
afterEach(() => { harness.close(); vi.unstubAllGlobals() })

describe('the registry pins tool <-> action both ways', () => {
  it('every owner-sudo action opens exactly one tool and every sudo tool maps to a registered action', () => {
    expect([...Object.values(OWNER_SUDO_ACTION_FOR_TOOL)].sort()).toEqual([...OWNER_SUDO_ACTIONS].sort())
    expect(new Set(Object.values(OWNER_SUDO_ACTION_FOR_TOOL)).size).toBe(Object.keys(OWNER_SUDO_ACTION_FOR_TOOL).length)
  })
})

describe('the marker cannot arrive from outside', () => {
  it('resolveAuth drops ownerSudo from the injected header blob next to seatBinding (it is set only by invokeTool, in memory)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'mcp', 'index.ts'), 'utf8')
    expect(src).toMatch(/delete auth\.seatBinding\n[\s\S]{0,400}delete auth\.ownerSudo\n/)
  })
  it('the only writer of ownerSudo in src is owner-sudo.ts', () => {
    const hits = execSync("grep -rln 'ownerSudo = \\|ownerSudo:' src || true", { cwd: join(__dirname, '..') }).toString().split('\n').filter(Boolean).sort()
    expect(hits).toEqual(['src/auth/owner-sudo.ts'])
  })
})

describe('request time: ONE act, org/squad scope, short', () => {
  const ask = async (args: Record<string, unknown>): Promise<Out> => { await call('check_in', {}); return out('request_elevation', { reason: 'r', duration_minutes: 15, scope_type: 'squad', scope_id: 'squad-a', ...args }) }
  it('must be requested alone', async () => {
    expect((await ask({ actions: ['action:sudo_squad_member_add', 'action:project_status'] })).ok).toBe(false)
    expect((await ask({ actions: ['action:sudo_squad_member_add', 'action:sudo_squad_dyad_pin'] })).ok).toBe(false)
  })
  it('not department scope, at most 60 minutes, gate grants org scope only', async () => {
    expect((await ask({ actions: ['action:sudo_squad_member_add'], scope_type: 'department', scope_id: 'dept' })).ok).toBe(false)
    expect((await ask({ actions: ['action:sudo_squad_member_add'], duration_minutes: 240 })).ok).toBe(false)
    expect((await ask({ actions: ['action:sudo_grant_gate_capability'] })).ok).toBe(false)
    expect((await ask({ actions: ['action:sudo_grant_gate_capability'], scope_type: 'org', scope_id: undefined })).ok).toBe(true)
    expect((await ask({ actions: ['action:sudo_squad_member_add'], duration_minutes: 60 })).ok).toBe(true)
  })
})

describe('squad_member_add as the owner', () => {
  const add = (over: Record<string, unknown> = {}) => out('squad_member_add', { agent: 'agent-y', squad: 'squad-b', capability: 'member', ...over })
  it('refused without an approval, and the refusal teaches the one call to make', async () => {
    const r = await add()
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).toContain('action:sudo_squad_member_add')
    expect(memberOf('agent-y', 'squad-b')).toBeUndefined()
  })
  it('after Approve in Telegram: runs as the owner (authority) with the agent recorded as executor, once', async () => {
    const reqId = await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' })
    const presenceBefore = count('presence', "member_id = 'mem-owner'")
    const r = await add()
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.result).toMatchObject({ result: 'created', owner_sudo: { executed_as_authority: 'mem-owner', approval: 'spent' } })
    expect(memberOf('agent-y', 'squad-b')).toEqual({ capability: 'member' })
    expect(one('SELECT actor_member_id, actor_bound_agent_id FROM membership_receipts ORDER BY rowid DESC LIMIT 1')).toEqual({ actor_member_id: 'mem-owner', actor_bound_agent_id: 'agent-x' })
    expect(one('SELECT principal_kind, principal_id, member_id, handler, operation FROM mutation_audit_entries WHERE handler = ?', 'owner_sudo'))
      .toEqual({ principal_kind: 'agent', principal_id: 'agent-x', member_id: 'mem-owner', handler: 'owner_sudo', operation: 'owner_sudo:squad_member_add' })
    expect(usage(reqId)).toEqual([{ status: 'applied' }])
    expect(count('presence', "member_id = 'mem-owner'")).toBe(presenceBefore) // the call never touches presence under the human
    // the SECOND call loses: the approval covered one call
    const again = await add({ capability: 'observer' })
    expect(again.ok).toBe(false) // the spent grant is revoked: the agent is back to its ordinary refusal
    expect(one<{ revoke_reason: string }>('SELECT revoke_reason FROM elevation_grants WHERE elevation_request_id = ?', reqId).revoke_reason).toBe('owner_sudo_spent')
    expect(memberOf('agent-y', 'squad-b')).toEqual({ capability: 'member' })
  })
  it('SCOPE: a grant for squad-b does not cover squad-a; an org grant covers either', async () => {
    await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' })
    const wrong = await add({ squad: 'squad-a', agent: 'agent-u' })
    expect(wrong.ok).toBe(false)
    expect(JSON.stringify(wrong.detail)).toContain('no_matching_grant')
    expect(count('elevation_usage_log')).toBe(0) // a refusal spends nothing
    harness.sqlite.exec('DELETE FROM elevation_grants')
    harness.sqlite.exec("UPDATE elevation_requests SET status = 'denied'")
    await requestAndApprove('action:sudo_squad_member_add', { type: 'org' })
    expect((await add({ squad: 'squad-b' })).ok).toBe(true)
  })
  it('ACTION: a grant for another action (project_status, or another sudo tool) does not open this tool', async () => {
    await requestAndApprove('action:project_status', { type: 'squad', id: 'squad-b' })
    expect((await add()).ok).toBe(false)
    await requestAndApprove('action:sudo_grant_gate_capability', { type: 'org' })
    expect((await add()).ok).toBe(false)
    expect(memberOf('agent-y', 'squad-b')).toBeUndefined()
  })
  it('EXPIRY and /murevoke end it on the very next call', async () => {
    const reqId = await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' })
    harness.sqlite.prepare('UPDATE elevation_grants SET expires_at = ? WHERE elevation_request_id = ?').run(new Date(Date.now() - 1000).toISOString(), reqId)
    expect((await add()).ok).toBe(false)
    harness.sqlite.exec('DELETE FROM elevation_grants'); harness.sqlite.exec("UPDATE elevation_requests SET status = 'denied'")
    await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' })
    expect((await handleApprovalBotUpdate(env, msg('/murevoke', TG.owner))).kind).toBe('revoked')
    expect((await add()).ok).toBe(false)
    expect(memberOf('agent-y', 'squad-b')).toBeUndefined()
  })
  it('the approver losing authority, being suspended, or signing out ends it', async () => {
    const reqId = await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' })
    run("UPDATE users SET role = 'member' WHERE id = 'u-owner'")
    run("UPDATE capabilities SET capability = 'member' WHERE id = 'cap-o'")
    expect((await add()).ok).toBe(false)
    run("UPDATE users SET role = 'owner' WHERE id = 'u-owner'")
    run("UPDATE capabilities SET capability = 'owner' WHERE id = 'cap-o'")
    run("UPDATE members SET status = 'suspended' WHERE id = 'mem-owner'")
    expect((await add()).ok).toBe(false)
    run("UPDATE members SET status = 'active' WHERE id = 'mem-owner'")
    harness.sqlite.prepare("UPDATE web_sessions SET revoked_at = datetime('now') WHERE id_hash = (SELECT approved_by_web_session_hash FROM elevation_grants WHERE elevation_request_id = ?)").run(reqId)
    expect((await add()).ok).toBe(false)
    expect(memberOf('agent-y', 'squad-b')).toBeUndefined()
  })
  it('the agent\'s own session ending ends it', async () => {
    await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' })
    run("UPDATE agent_sessions SET revoked_at = datetime('now')")
    expect((await add()).ok).toBe(false)
  })
  it('FENCES: no lead/admin, not the requesting agent itself; a refused call does not spend the approval', async () => {
    await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' })
    expect(await add({ capability: 'lead' })).toMatchObject({ ok: false, error: 'sudo_capability_ceiling' })
    expect(await add({ capability: 'admin' })).toMatchObject({ ok: false, error: 'sudo_capability_ceiling' })
    expect(await add({ agent: 'agent-x' })).toMatchObject({ ok: false, error: 'cannot_grant_to_self' })
    expect(count('elevation_usage_log')).toBe(0)
    expect((await add()).ok).toBe(true)
  })
  it('ADD, never demote: lowering a standing the target already holds is refused and spends nothing', async () => {
    run("INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('ms-yb', 'agent-y', 'squad-b', 'lead')")
    await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' })
    expect(await add({ capability: 'member' })).toMatchObject({ ok: false, error: 'sudo_cannot_demote' })
    expect(await add({ capability: 'observer' })).toMatchObject({ ok: false, error: 'sudo_cannot_demote' })
    expect(memberOf('agent-y', 'squad-b')).toEqual({ capability: 'lead' })
    expect(count('elevation_usage_log')).toBe(0)
  })
  it('a tool-level refusal (unminted agent) frees the claim so the one call is not lost', async () => {
    const reqId = await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' })
    const bad = await add({ agent: 'agent-u' })
    expect(bad).toMatchObject({ ok: false, error: 'agent_identity_unminted' })
    expect(usage(reqId)).toEqual([{ status: 'failed' }])
    expect((await add()).ok).toBe(true)
    expect(usage(reqId).map((u) => u.status).sort()).toEqual(['applied', 'failed'])
  })
  it('CONCURRENT calls: exactly one runs', async () => {
    await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' })
    const rs = await Promise.all([add(), add(), add(), add()])
    expect(rs.filter((r) => r.ok)).toHaveLength(1)
    expect(rs.filter((r) => !r.ok)).toHaveLength(3)
    expect(count('membership_receipts', "actor_bound_agent_id = 'agent-x'")).toBe(1)
  })
  it('runs AS the approver: a squad admin who approved a squad-b grant is the authority, so the call is exactly what THEY could do', async () => {
    run("UPDATE agents SET owner_member_id = 'mem-sqadmin' WHERE id = 'agent-x'")
    await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' }, { approver: TG.sqadmin })
    const r = await add()
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(one('SELECT actor_member_id FROM membership_receipts ORDER BY rowid DESC LIMIT 1')).toEqual({ actor_member_id: 'mem-sqadmin' })
    // and when that admin loses admin on squad-b, a fresh approval is dead on arrival
    await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' }, { approver: TG.sqadmin }) // a second approval in the SAME session: the spent grant renews
    run("DELETE FROM capabilities WHERE id = 'cap-sa-b'")
    expect((await add({ agent: 'agent-u' })).ok).toBe(false)
  })
  it('an agent with a hand-set ownerSudo marker on a plain member auth gains nothing (the marker is informational, set only by invokeTool)', async () => {
    const forged: AuthContext = { ...agentAuth(), boundAgentId: null, ownerSudo: { executorAgentId: 'agent-x', executorMemberId: 'mem-x', grantId: 'g', elevationRequestId: 'r', action: 'action:sudo_squad_member_add', tool: 'squad_member_add' } }
    expect((await out('squad_member_add', { agent: 'agent-y', squad: 'squad-b', capability: 'member' }, forged)).ok).toBe(false)
    expect(memberOf('agent-y', 'squad-b')).toBeUndefined()
  })
})

describe('the approver\'s authority on the legacy role plane', () => {
  it('an owner with NO capability rows (role plane only) approves and the grant stays live for the agent', async () => {
    run("DELETE FROM capabilities WHERE id = 'cap-o'")
    // the owner's role is proven by a provider-verified login identity (never by members.email): the identity the dashboard sign-in made
    run("INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at) VALUES ('hli-owner', 'tenant-a', 'email', 'owner@x.test', 'owner@x.test', 'mem-owner', datetime('now'))")
    const reqId = await requestAndApprove('action:sudo_grant_gate_capability', { type: 'org' })
    const { hasElevatedAction } = await import('../src/auth/elevation')
    const base = await hasElevatedAction(env, agentAuth(), 'action:sudo_grant_gate_capability', 'org', null, { recordUsage: false })
    expect(base).toMatchObject({ granted: false, reason: 'approver_authority_lost' }) // the default check reads rows only (as for every other action)
    const withPlane = await hasElevatedAction(env, agentAuth(), 'action:sudo_grant_gate_capability', 'org', null, { recordUsage: false, approverRolePlane: true })
    expect(withPlane.granted).toBe(true)
    expect(grantRow(reqId).action).toBe('action:sudo_grant_gate_capability')
    const r = await out('grant_gate_capability', { capability: 'gate:hadi', principal_type: 'member', principal_id: 'mem-target' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
  })
})

describe('update_squad dyad pin as the owner', () => {
  const pin = (over: Record<string, unknown> = {}) => out('update_squad', { squad: 'squad-a', dyad_agent_a: 'agent-x', dyad_agent_b: 'agent-y', ...over })
  const pinned = (): { dyad_agent_a: string | null; dyad_agent_b: string | null } => one('SELECT dyad_agent_a, dyad_agent_b FROM squads WHERE id = ?', 'squad-a')
  it('refused without an approval (an agent never picks its own reviewer) and the refusal teaches the call', async () => {
    const r = await pin()
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).toMatch(/dyad/)
    expect(pinned()).toEqual({ dyad_agent_a: null, dyad_agent_b: null })
  })
  it('after Approve: pins the pair as the owner, once; the same approval cannot clear it', async () => {
    const reqId = await requestAndApprove('action:sudo_squad_dyad_pin', { type: 'squad', id: 'squad-a' })
    const r = await pin()
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(pinned()).toEqual({ dyad_agent_a: 'agent-x', dyad_agent_b: 'agent-y' })
    expect(usage(reqId)).toEqual([{ status: 'applied' }])
    expect((await pin({ dyad_agent_a: null, dyad_agent_b: null })).ok).toBe(false)
    expect(pinned()).toEqual({ dyad_agent_a: 'agent-x', dyad_agent_b: 'agent-y' })
  })
  it('covers a pin and NOTHING else: any other field in the call is refused and spends nothing', async () => {
    await requestAndApprove('action:sudo_squad_dyad_pin', { type: 'squad', id: 'squad-a' })
    for (const extra of [{ slug: 'hijack-sqd' }, { budget_cap_cents: 5 }, { budget_window: 'day' }]) {
      expect(await pin(extra)).toMatchObject({ ok: false, error: 'sudo_covers_dyad_pin_only' })
    }
    expect(await out('update_squad', { squad: 'squad-a', slug: 'hijack-sqd' })).toMatchObject({ ok: false })
    expect(await out('update_squad', { squad: 'squad-a', dyad_agent_a: 'agent-x' })).toMatchObject({ ok: false, error: 'sudo_covers_dyad_pin_only' })
    expect(count('elevation_usage_log')).toBe(0)
    expect(one<{ slug: string }>('SELECT slug FROM squads WHERE id = ?', 'squad-a').slug).toBe('a-sqd')
    expect((await pin()).ok).toBe(true)
  })
  it('a grant for another squad does not pin this one', async () => {
    await requestAndApprove('action:sudo_squad_dyad_pin', { type: 'squad', id: 'squad-b' })
    expect((await pin()).ok).toBe(false)
    expect(pinned()).toEqual({ dyad_agent_a: null, dyad_agent_b: null })
  })
  it('runs AS the approver: an approver who is not an org owner/admin gets the tool\'s own refusal and the claim is freed', async () => {
    // route the request to the squad admin
    run("UPDATE agents SET owner_member_id = 'mem-sqadmin' WHERE id = 'agent-x'")
    const reqId = await requestAndApprove('action:sudo_squad_dyad_pin', { type: 'squad', id: 'squad-a' }, { approver: TG.sqadmin })
    const r = await pin()
    expect(r).toMatchObject({ ok: false, error: 'forbidden' })
    expect(JSON.stringify(r)).toContain('dyad_pair_org_admin_only')
    expect(pinned()).toEqual({ dyad_agent_a: null, dyad_agent_b: null })
    expect(usage(reqId)).toEqual([{ status: 'failed' }])
  })
  it('works for an approver whose org authority is a capability row (no legacy role)', async () => {
    run("UPDATE agents SET owner_member_id = 'mem-admin' WHERE id = 'agent-x'")
    await requestAndApprove('action:sudo_squad_dyad_pin', { type: 'squad', id: 'squad-a' }, { approver: TG.admin })
    expect((await pin()).ok).toBe(true)
  })
})

describe('grant_gate_capability as the owner', () => {
  const gate = (over: Record<string, unknown> = {}) => out('grant_gate_capability', { capability: 'gate:hadi', principal_type: 'member', principal_id: 'mem-target', ...over })
  it('refused without an approval; after Approve grants once as the owner; org scope; a second call is spent', async () => {
    expect((await gate()).ok).toBe(false)
    expect(count('gate_grants')).toBe(0)
    const reqId = await requestAndApprove('action:sudo_grant_gate_capability', { type: 'org' })
    expect((await gate()).ok).toBe(true)
    expect(one('SELECT capability, principal_type, principal_id, granted_by FROM gate_grants')).toEqual({ capability: 'gate:hadi', principal_type: 'member', principal_id: 'mem-target', granted_by: 'mem-owner' })
    expect(usage(reqId)).toEqual([{ status: 'applied' }])
    expect((await gate({ principal_id: 'mem-y' })).ok).toBe(false)
    expect(count('gate_grants')).toBe(1)
  })
  it('SELF: never to the requesting agent, nor its own member; refused calls spend nothing', async () => {
    await requestAndApprove('action:sudo_grant_gate_capability', { type: 'org' })
    expect(await gate({ principal_type: 'agent', principal_id: 'agent-x' })).toMatchObject({ ok: false, error: 'cannot_grant_to_self' })
    expect(await gate({ principal_type: 'member', principal_id: 'mem-x' })).toMatchObject({ ok: false, error: 'cannot_grant_to_self' })
    expect(count('gate_grants')).toBe(0)
    expect(count('elevation_usage_log')).toBe(0)
    expect((await gate({ principal_type: 'agent', principal_id: 'agent-y' })).ok).toBe(true)
  })
  it('malformed gate capability names are refused (no arbitrary strings into gate_grants) and spend nothing', async () => {
    await requestAndApprove('action:sudo_grant_gate_capability', { type: 'org' })
    expect((await gate({ capability: 'admin' })).ok).toBe(false)
    expect(count('gate_grants')).toBe(0)
    expect(count('elevation_usage_log')).toBe(0)
  })
  it('the squad-scoped dyad approval does not open gate grants', async () => {
    await requestAndApprove('action:sudo_squad_dyad_pin', { type: 'squad', id: 'squad-a' })
    expect((await gate()).ok).toBe(false)
    expect(count('gate_grants')).toBe(0)
  })
})

describe('seat_event_grant (MCP twin of POST /api/fleet/events/grants)', () => {
  const seat = (over: Record<string, unknown> = {}) => out('seat_event_grant', { agent_id: 'agent-y', host_agent_id: 'host-1', reason: 'route hints to the fleet host', ...over })
  const human = (): AuthContext => ({ userId: 'u-owner', email: 'owner@x.test', role: 'owner', tenant: TENANT, channel: 'dashboard', memberId: 'mem-owner' })
  it('a human org owner can use the twin directly (same rule as the HTTP route)', async () => {
    expect((await out('seat_event_grant', { agent_id: 'agent-y', host_agent_id: 'host-1', reason: 'r' }, human())).ok).toBe(true)
    expect(count('seat_event_grants')).toBe(1)
  })
  it('an agent is refused without an approval; after Approve it runs as the owner once', async () => {
    expect((await seat()).ok).toBe(false)
    expect(count('seat_event_grants')).toBe(0)
    const reqId = await requestAndApprove('action:sudo_seat_event_grant', { type: 'squad', id: 'squad-a' })
    expect((await seat()).ok).toBe(true)
    expect(one('SELECT agent_id, host_agent_id, granted_by_member_id FROM seat_event_grants')).toEqual({ agent_id: 'agent-y', host_agent_id: 'host-1', granted_by_member_id: 'mem-owner' })
    expect(usage(reqId)).toEqual([{ status: 'applied' }])
    expect((await seat({ agent_id: 'agent-u' })).ok).toBe(false)
  })
  it('an agent that holds STANDING lead on the squad is still refused by the twin without an approval (agent-bound is refused first, as on the HTTP route)', async () => {
    run("INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-x-lead', 'mem-x', 'squad', 'squad-a', 'admin')")
    const lead: AuthContext = { ...agentAuth(), capabilities: [{ member_id: 'mem-x', scope_type: 'squad', scope_id: 'squad-a', capability: 'admin' } as CapabilityGrant] }
    expect(await out('seat_event_grant', { agent_id: 'agent-y', host_agent_id: 'host-1', reason: 'r' }, lead)).toMatchObject({ ok: false, error: 'operator_principal_required' })
    expect(count('seat_event_grants')).toBe(0)
  })
  it('a human without admin or lead on the target\'s squad cannot use the twin (agent_not_visible)', async () => {
    const plain: AuthContext = { userId: 'mem-y', email: null, role: 'member', tenant: TENANT, channel: 'workspace', memberId: 'mem-y', capabilities: [{ member_id: 'mem-y', scope_type: 'squad', scope_id: 'squad-a', capability: 'lead' } as CapabilityGrant] }
    expect((await out('seat_event_grant', { agent_id: 'agent-y', host_agent_id: 'host-1', reason: 'r' }, plain)).ok).toBe(true) // a squad LEAD may (same as the route)
    const observer: AuthContext = { ...plain, capabilities: [{ member_id: 'mem-y', scope_type: 'squad', scope_id: 'squad-b', capability: 'lead' } as CapabilityGrant] }
    harness.sqlite.exec('DELETE FROM seat_event_grants')
    expect(await out('seat_event_grant', { agent_id: 'agent-y', host_agent_id: 'host-1', reason: 'r' }, observer)).toMatchObject({ ok: false })
    expect(count('seat_event_grants')).toBe(0)
  })
  it('a grant for squad-b does not cover an agent of squad-a', async () => {
    await requestAndApprove('action:sudo_seat_event_grant', { type: 'squad', id: 'squad-b' })
    expect((await seat()).ok).toBe(false)
    expect(count('seat_event_grants')).toBe(0)
  })
  it('an unknown target agent reads the same as one the approver cannot act on (no existence oracle) and spends nothing', async () => {
    await requestAndApprove('action:sudo_seat_event_grant', { type: 'org' })
    expect(await seat({ agent_id: 'no-such-agent' })).toMatchObject({ ok: false, error: 'agent_not_visible' })
    expect(count('elevation_usage_log')).toBe(0)
  })
})

describe('the tools without sudo behave as before', () => {
  it('an agent with no live grant at all is refused by every sudo tool exactly as it was', async () => {
    for (const [tool, args] of [
      ['squad_member_add', { agent: 'agent-y', squad: 'squad-b', capability: 'member' }],
      ['grant_gate_capability', { capability: 'gate:hadi', principal_type: 'member', principal_id: 'mem-target' }],
      ['update_squad', { squad: 'squad-a', dyad_agent_a: 'agent-x', dyad_agent_b: 'agent-y' }],
      ['seat_event_grant', { agent_id: 'agent-y', host_agent_id: 'host-1', reason: 'r' }],
    ] as const) {
      const r = await out(tool, args)
      expect(r.ok, tool).toBe(false)
      expect(JSON.stringify(r), tool).not.toContain('sudo_denied') // no live grant for the tool's action: the sudo path is never entered
    }
    expect(count('elevation_usage_log')).toBe(0)
    expect(count('mutation_audit_entries', "handler = 'owner_sudo'")).toBe(0)
  })
  it('a DENIED request grants nothing', async () => {
    await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' }, { decision: 'deny' })
    expect((await out('squad_member_add', { agent: 'agent-y', squad: 'squad-b', capability: 'member' })).ok).toBe(false)
    expect(memberOf('agent-y', 'squad-b')).toBeUndefined()
  })
})

describe('single use is a guarded claim, and a renewed approval is a fresh one', () => {
  it('claimOwnerSudo: the second claim of the same grant loses; a failed (freed) claim can be retaken; a renewed grant ignores the old spend', async () => {
    const { claimOwnerSudo, finishOwnerSudo } = await import('../src/auth/owner-sudo')
    const { loadElevationGrantById } = await import('../src/auth/elevation')
    const reqId = await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' })
    const grant = (await loadElevationGrantById(env, TENANT, grantRow(reqId).id))!
    const pending = { grant, tool: 'squad_member_add' as const, executorAgentId: 'agent-x', tenant: TENANT, detail: {} }
    const first = await claimOwnerSudo(env, pending)
    expect(first).not.toBeNull()
    expect(await claimOwnerSudo(env, pending)).toBeNull() // pending counts as spent
    await finishOwnerSudo(env, first!, { ok: false, status: 409, error: 'x' }) // the tool refused: freed
    const second = await claimOwnerSudo(env, pending)
    expect(second).not.toBeNull()
    await finishOwnerSudo(env, second!, { ok: true }) // spent (and revoked)
    expect(await claimOwnerSudo(env, pending)).toBeNull()
    // a fresh approval for the same action in the same session renews the SAME grant row and is usable once more
    const reqId2 = await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' })
    expect(grantRow(reqId2).id).toBe(grant.id)
    const renewed = (await loadElevationGrantById(env, TENANT, grant.id))!
    expect(renewed.revoked_at).toBeNull()
    expect(await claimOwnerSudo(env, { ...pending, grant: renewed })).not.toBeNull()
  })
  it('a second approval for the same one-call action in one session works end to end (spent grant renews)', async () => {
    await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' })
    expect((await out('squad_member_add', { agent: 'agent-y', squad: 'squad-b', capability: 'member' })).ok).toBe(true)
    await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' })
    expect((await out('squad_member_add', { agent: 'agent-y', squad: 'squad-b', capability: 'member' })).ok).toBe(true)
    expect(count('mutation_audit_entries', "handler = 'owner_sudo'")).toBe(2)
  })
})
