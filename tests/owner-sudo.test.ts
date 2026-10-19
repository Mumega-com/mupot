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

let calls: Array<{ url: string; body: Record<string, unknown> }> = []
function stubBot(): void {
  calls = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> }); return new Response(JSON.stringify({ ok: true, result: { message_id: 600 } }), { status: 200 }) })
}
const agentAuth = (): AuthContext => ({
  userId: 'mem-x', email: 'x@x.test', role: 'member', tenant: TENANT, channel: 'workspace', memberId: 'mem-x', tokenId: 'tok-x',
  capabilities: [{ member_id: 'mem-x', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' } as CapabilityGrant], boundAgentId: 'agent-x',
})
const call = (tool: string, args: Record<string, unknown>, auth: AuthContext = agentAuth()) => invokeTool(auth, env, tool, args, 'https://pot.test')
type Out = { ok: boolean; status?: number; error?: string; detail?: unknown; result?: Record<string, unknown> }
const out = async (tool: string, args: Record<string, unknown>, auth?: AuthContext): Promise<Out> => (await call(tool, args, auth)) as Out

/** The exact call each sudo action is approved for, unless a test says otherwise (these match the default call in each describe). */
const DEFAULT_ARGS: Record<string, Record<string, unknown>> = {
  'action:sudo_squad_member_add': { squad: 'squad-b', agent: 'agent-y', capability: 'member' },
  'action:sudo_squad_dyad_pin': { squad: 'squad-a', agent_a: 'agent-y', agent_b: 'agent-z' },
  'action:sudo_grant_gate_capability': { capability: 'gate:gaf-codex', principal_type: 'member', principal_id: 'mem-target' },
  'action:sudo_seat_event_grant': { host_agent_id: 'host-1', agent_id: 'agent-y' },
}

let seq = 100
const msg = (text: string, from: number) => ({ update_id: ++seq, message: { message_id: 7, from: { id: from }, chat: { id: from, type: 'private' }, text } })

/** The agent files the request through the real tool; the human approves through the real bot path. Returns the request id. */
async function requestAndApprove(action: string, scope: { type: 'org' | 'squad'; id?: string }, opts: { approver?: number; duration?: number; decision?: 'approve' | 'deny'; args?: Record<string, unknown> } = {}): Promise<string> {
  await call('check_in', {})
  const r = await out('request_elevation', { actions: [action], scope_type: scope.type, ...(scope.id ? { scope_id: scope.id } : {}), duration_minutes: opts.duration ?? 15, reason: 'do the one thing', ...(action.startsWith('action:sudo_') ? { sudo_args: opts.args ?? DEFAULT_ARGS[action] } : {}) })
  if (!r.ok) throw new Error(`request failed ${JSON.stringify(r)}`)
  const id = (r.result as { request: { id: string } }).request.id
  const shortId = one<{ short_id: string }>('SELECT short_id FROM elevation_requests WHERE id = ?', id).short_id
  const res = await handleApprovalBotUpdate(env, msg(`/mu${opts.decision === 'deny' ? 'deny' : 'approve'} ${shortId}`, opts.approver ?? TG.owner))
  if (opts.decision !== 'deny' && res.kind !== 'approved') throw new Error(`approve failed ${JSON.stringify(res)}`)
  return id
}
const approvalCalls = (): Array<{ body: Record<string, unknown> }> => calls.filter((c) => c.url.includes(BOT_TOKEN))
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
      ('agent-u', 'squad-a', 'agent-u', 'Agent U (unminted)', 'r', 'm', 'active', NULL),
      ('agent-z', 'squad-a', 'agent-z', 'Agent Z', 'r', 'm', 'active', NULL);
    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('ms-x', 'agent-x', 'squad-a', 'member'), ('ms-y', 'agent-y', 'squad-a', 'member'), ('ms-z', 'agent-z', 'squad-a', 'member');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
      ('${TENANT}', 'agent-x', 'mem-x', datetime('now')), ('${TENANT}', 'agent-y', 'mem-y', datetime('now'));
    INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at) VALUES
      ('hli-owner', '${TENANT}', 'email', 'owner@x.test', 'owner@x.test', 'mem-owner', datetime('now')),
      ('hli-sqadmin', '${TENANT}', 'email', 'sqadmin@x.test', 'sqadmin@x.test', 'mem-sqadmin', datetime('now')),
      ('hli-admin', '${TENANT}', 'email', 'admin@x.test', 'admin@x.test', 'mem-admin', datetime('now'));
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
    APPROVAL_BOT_TOKEN: BOT_TOKEN, APPROVAL_BOT_WEBHOOK_SECRET: 'approval-webhook-secret-0123456789', APPROVAL_BOT_USERNAME: 'muapprove_test_bot', OWNER_SUDO_ENABLED: '1',
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

describe('request time: ONE act, org/squad scope, short, argument-bound', () => {
  const ask = async (args: Record<string, unknown>): Promise<Out> => {
    await call('check_in', {})
    const action = (args.actions as string[])[0]
    return out('request_elevation', { reason: 'r', duration_minutes: 15, scope_type: 'squad', scope_id: 'squad-b', sudo_args: DEFAULT_ARGS[action], ...args })
  }
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
  it('a squad-scope request is for THE squad the call touches (another squad could never be used)', async () => {
    expect((await ask({ actions: ['action:sudo_squad_member_add'], scope_id: 'squad-a' })).ok).toBe(false)
    expect((await ask({ actions: ['action:sudo_squad_dyad_pin'], scope_id: 'squad-b' })).ok).toBe(false)
    expect((await ask({ actions: ['action:sudo_seat_event_grant'], scope_id: 'squad-b' })).ok).toBe(false)
  })
  it('FLAG: with OWNER_SUDO_ENABLED off no sudo action can be requested', async () => {
    env = { ...env, OWNER_SUDO_ENABLED: undefined } as Env
    expect(await ask({ actions: ['action:sudo_squad_member_add'] })).toMatchObject({ ok: false })
    env = { ...env, OWNER_SUDO_ENABLED: 'false' } as Env
    expect((await ask({ actions: ['action:sudo_squad_member_add'] })).ok).toBe(false)
  })
  it('ARGS are mandatory for all four actions, and unknown keys are refused', async () => {
    for (const action of Object.keys(DEFAULT_ARGS)) {
      const scope = action === 'action:sudo_grant_gate_capability' ? { scope_type: 'org', scope_id: undefined } : { scope_id: action === 'action:sudo_squad_member_add' ? 'squad-b' : 'squad-a' }
      const none = await ask({ actions: [action], sudo_args: undefined, ...scope })
      expect(none.ok, `${action} without args`).toBe(false)
      expect(JSON.stringify(none), action).toContain('sudo_args_required')
      expect((await ask({ actions: [action], sudo_args: {}, ...scope })).ok, `${action} empty args`).toBe(false)
      expect((await ask({ actions: [action], sudo_args: { ...DEFAULT_ARGS[action], extra: 1 }, ...scope })).ok, `${action} unknown key`).toBe(false)
      expect((await ask({ actions: [action], ...scope })).ok, `${action} good args`).toBe(true)
    }
  })
  it('the Telegram message shows the exact call resolved to NAMES (not ids), from the stored args', async () => {
    await requestAndApprove('action:sudo_grant_gate_capability', { type: 'org' }, { decision: 'deny' })
    const text = String(approvalCalls()[0].body.text)
    expect(text).toContain('EXACT CALL')
    expect(text).toContain('grant gate:gaf-codex to member Target')
    calls.length = 0
    await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' }, { decision: 'deny' })
    expect(String(approvalCalls()[0].body.text)).toContain('add agent agent-y to squad b-sqd as member')
  })
  it('the stored request carries the canonical digest', async () => {
    const reqId = await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' })
    const r = one<{ sudo_args_json: string; sudo_args_sha256: string }>('SELECT sudo_args_json, sudo_args_sha256 FROM elevation_requests WHERE id = ?', reqId)
    expect(JSON.parse(r.sudo_args_json)).toEqual({ agent_id: 'agent-y', capability: 'member', squad_id: 'squad-b' })
    expect(r.sudo_args_sha256).toMatch(/^[0-9a-f]{64}$/)
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
  it('SCOPE + ARGS: an approval for squad-b / agent-y does not open the same call on squad-a, nor any other agent or capability; an org-scope approval of the same exact call works', async () => {
    await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' })
    for (const over of [{ squad: 'squad-a' }, { agent: 'agent-z' }, { capability: 'observer' }]) {
      const wrong = await add(over)
      expect(wrong.ok).toBe(false)
      expect(JSON.stringify(wrong)).toContain('sudo_args_mismatch')
    }
    expect(count('elevation_usage_log')).toBe(0) // a refusal spends nothing
    expect(memberOf('agent-y', 'squad-b')).toBeUndefined()
    harness.sqlite.exec('DELETE FROM elevation_grants')
    harness.sqlite.exec("UPDATE elevation_requests SET status = 'denied'")
    await requestAndApprove('action:sudo_squad_member_add', { type: 'org' })
    expect((await add()).ok).toBe(true)
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
    const reqId = await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' }, { args: { squad: 'squad-b', agent: 'agent-u', capability: 'member' } })
    const bad = await add({ agent: 'agent-u' })
    expect(bad).toMatchObject({ ok: false, error: 'agent_identity_unminted' })
    expect(usage(reqId)).toEqual([{ status: 'failed' }])
    run("INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-u', 'u@x.test', 'U', 'active', 'tenant-a')")
    run("INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('tenant-a', 'agent-u', 'mem-u', datetime('now'))")
    expect((await add({ agent: 'agent-u' })).ok).toBe(true)
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
    const reqId = await requestAndApprove('action:sudo_grant_gate_capability', { type: 'org' })
    const { hasElevatedAction } = await import('../src/auth/elevation')
    const base = await hasElevatedAction(env, agentAuth(), 'action:sudo_grant_gate_capability', 'org', null, { recordUsage: false })
    expect(base).toMatchObject({ granted: false, reason: 'approver_authority_lost' }) // the default check reads rows only (as for every other action)
    const withPlane = await hasElevatedAction(env, agentAuth(), 'action:sudo_grant_gate_capability', 'org', null, { recordUsage: false, approverRolePlane: true })
    expect(withPlane.granted).toBe(true)
    expect(grantRow(reqId).action).toBe('action:sudo_grant_gate_capability')
    const r = await out('grant_gate_capability', { capability: 'gate:gaf-codex', principal_type: 'member', principal_id: 'mem-target' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
  })
})

describe('update_squad dyad pin as the owner', () => {
  const pin = (over: Record<string, unknown> = {}) => out('update_squad', { squad: 'squad-a', dyad_agent_a: 'agent-y', dyad_agent_b: 'agent-z', ...over })
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
    expect(pinned()).toEqual({ dyad_agent_a: 'agent-y', dyad_agent_b: 'agent-z' })
    expect(usage(reqId)).toEqual([{ status: 'applied' }])
    expect((await pin({ dyad_agent_a: null, dyad_agent_b: null })).ok).toBe(false)
    expect(pinned()).toEqual({ dyad_agent_a: 'agent-y', dyad_agent_b: 'agent-z' })
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
  it('an approval for another squad (scope squad-b) is refused at request time; the pin of squad-a stays untouched', async () => {
    await call('check_in', {})
    expect((await out('request_elevation', { actions: ['action:sudo_squad_dyad_pin'], scope_type: 'squad', scope_id: 'squad-b', duration_minutes: 15, reason: 'r', sudo_args: DEFAULT_ARGS['action:sudo_squad_dyad_pin'] })).ok).toBe(false)
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

describe('more fences and generations', () => {
  it('a HOME squad is never a target (squad_member_add, dyad pin)', async () => {
    run("INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('squad-home', 'dept', 'home-sqd', 'Home', 'home')")
    await call('check_in', {})
    for (const [action, args] of [['action:sudo_squad_member_add', { squad: 'squad-home', agent: 'agent-y', capability: 'member' }], ['action:sudo_squad_dyad_pin', { squad: 'squad-home', agent_a: 'agent-y', agent_b: 'agent-z' }]] as const) {
      const r = await out('request_elevation', { actions: [action], scope_type: 'org', duration_minutes: 15, reason: 'r', sudo_args: args })
      expect(r.ok, action).toBe(false)
    }
  })
  it('a dyad needs two DISTINCT agents', async () => {
    await call('check_in', {})
    const r = await out('request_elevation', { actions: ['action:sudo_squad_dyad_pin'], scope_type: 'squad', scope_id: 'squad-a', duration_minutes: 15, reason: 'r', sudo_args: { squad: 'squad-a', agent_a: 'agent-y', agent_b: 'agent-y' } })
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).toContain('sudo_args_invalid')
  })
  it('CLAIM generation: a pending verdict resolved on an earlier approval cannot claim the RENEWED grant row', async () => {
    const { resolveOwnerSudo, claimOwnerSudo } = await import('../src/auth/owner-sudo')
    const first = await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' })
    const v = await resolveOwnerSudo(env, agentAuth(), 'squad_member_add', { agent: 'agent-y', squad: 'squad-b', capability: 'member' })
    expect(v.kind).toBe('sudo')
    if (v.kind !== 'sudo') return
    harness.sqlite.prepare('UPDATE elevation_grants SET expires_at = ? WHERE elevation_request_id = ?').run(new Date(Date.now() - 1000).toISOString(), first)
    await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' }) // renews the same row: a new generation, live
    expect(await claimOwnerSudo(env, v.pending)).toMatchObject({ ok: false, refusal: { error: 'sudo_grant_ended' } })
  })
  it('SPEND generation: finishing a call of an older approval never revokes the renewed one', async () => {
    const { resolveOwnerSudo, claimOwnerSudo, finishOwnerSudo } = await import('../src/auth/owner-sudo')
    const { loadElevationGrantById } = await import('../src/auth/elevation')
    const first = await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' })
    const v = await resolveOwnerSudo(env, agentAuth(), 'squad_member_add', { agent: 'agent-y', squad: 'squad-b', capability: 'member' })
    if (v.kind !== 'sudo') throw new Error('not sudo')
    const claimed = await claimOwnerSudo(env, v.pending)
    if (!claimed.ok) throw new Error('claim failed')
    harness.sqlite.prepare('UPDATE elevation_grants SET expires_at = ? WHERE elevation_request_id = ?').run(new Date(Date.now() - 1000).toISOString(), first)
    await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' }) // renewed while the first call is still in flight
    await finishOwnerSudo(env, claimed.claim, { ok: true })
    expect((await loadElevationGrantById(env, TENANT, claimed.claim.grant.id))!.revoked_at).toBeNull()
  })
})

describe('flag, role and dyad args', () => {
  it('FLAG: with OWNER_SUDO_ENABLED off at USE time (approval already granted) resolveOwnerSudo is a no-op and the tool refuses as it always did', async () => {
    await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' })
    env = { ...env, OWNER_SUDO_ENABLED: undefined } as Env
    const r = await out('squad_member_add', { agent: 'agent-y', squad: 'squad-b', capability: 'member' })
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toMatch(/sudo_denied|sudo_args_mismatch|owner_sudo/)
    expect(memberOf('agent-y', 'squad-b')).toBeUndefined()
    expect(count('elevation_usage_log')).toBe(0)
  })
  it('VERIFIED role: the approver runs with the role a verified identity proves, never the one members.email matches', async () => {
    // mem-admin holds org ADMIN via a capability row; an unverified users row named after their email says OWNER
    run("INSERT INTO users (id, email, role) VALUES ('u-admin', 'admin@x.test', 'owner')")
    run("UPDATE human_login_identities SET verified_email = NULL WHERE id = 'hli-admin'")
    run("UPDATE agents SET owner_member_id = 'mem-admin' WHERE id = 'agent-x'")
    await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' }, { approver: TG.admin })
    const { resolveOwnerSudo } = await import('../src/auth/owner-sudo')
    const v = await resolveOwnerSudo(env, agentAuth(), 'squad_member_add', { agent: 'agent-y', squad: 'squad-b', capability: 'member' })
    expect(v.kind).toBe('sudo')
    if (v.kind === 'sudo') {
      expect(v.memberAuth.role).toBe('member') // NOT 'owner'
      expect(v.memberAuth.memberId).toBe('mem-admin')
    }
  })
  it('the dyad pin binds both agents and the squad; the pair may not include the requesting agent; both-null clears when that is what was approved', async () => {
    await call('check_in', {})
    for (const pair of [{ agent_a: 'agent-x', agent_b: 'agent-z' }, { agent_a: 'agent-y', agent_b: 'agent-x' }]) {
      const r = await out('request_elevation', { actions: ['action:sudo_squad_dyad_pin'], scope_type: 'squad', scope_id: 'squad-a', duration_minutes: 15, reason: 'r', sudo_args: { squad: 'squad-a', ...pair } })
      expect(r.ok).toBe(false)
      expect(JSON.stringify(r)).toContain('cannot_grant_to_self')
    }
    await requestAndApprove('action:sudo_squad_dyad_pin', { type: 'squad', id: 'squad-a' })
    const pin = (over: Record<string, unknown>) => out('update_squad', { squad: 'squad-a', dyad_agent_a: 'agent-y', dyad_agent_b: 'agent-z', ...over })
    expect(await pin({ dyad_agent_a: 'agent-x' })).toMatchObject({ ok: false, error: 'cannot_grant_to_self' })
    expect(await pin({ dyad_agent_b: 'agent-x' })).toMatchObject({ ok: false, error: 'cannot_grant_to_self' })
    expect(await pin({ dyad_agent_a: 'agent-z', dyad_agent_b: 'agent-y' })).toMatchObject({ ok: false, error: 'sudo_args_mismatch' }) // order is part of the pair
    expect(await pin({ dyad_agent_a: null, dyad_agent_b: null })).toMatchObject({ ok: false, error: 'sudo_args_mismatch' })
    expect(count('elevation_usage_log')).toBe(0)
    expect((await pin({})).ok).toBe(true)
    await requestAndApprove('action:sudo_squad_dyad_pin', { type: 'squad', id: 'squad-a' }, { args: { squad: 'squad-a', agent_a: null, agent_b: null } })
    expect((await pin({ dyad_agent_a: null, dyad_agent_b: null })).ok).toBe(true)
  })
})

describe('grant_gate_capability as the owner', () => {
  const gate = (over: Record<string, unknown> = {}) => out('grant_gate_capability', { capability: 'gate:gaf-codex', principal_type: 'member', principal_id: 'mem-target', ...over })
  it('refused without an approval; after Approve grants once as the owner; org scope; a second call is spent', async () => {
    expect((await gate()).ok).toBe(false)
    expect(count('gate_grants')).toBe(0)
    const reqId = await requestAndApprove('action:sudo_grant_gate_capability', { type: 'org' })
    expect((await gate()).ok).toBe(true)
    expect(one('SELECT capability, principal_type, principal_id, granted_by FROM gate_grants')).toEqual({ capability: 'gate:gaf-codex', principal_type: 'member', principal_id: 'mem-target', granted_by: 'mem-owner' })
    expect(usage(reqId)).toEqual([{ status: 'applied' }])
    expect((await gate({ principal_id: 'mem-y' })).ok).toBe(false)
    expect(count('gate_grants')).toBe(1)
  })
  it('SELF: never to the requesting agent, nor its own member: refused at request time AND for a call whose args name them; refused calls spend nothing', async () => {
    await call('check_in', {})
    for (const principal of [{ principal_type: 'agent', principal_id: 'agent-x' }, { principal_type: 'member', principal_id: 'mem-x' }]) {
      const r = await out('request_elevation', { actions: ['action:sudo_grant_gate_capability'], scope_type: 'org', duration_minutes: 15, reason: 'r', sudo_args: { capability: 'gate:gaf-codex', ...principal } })
      expect(r.ok).toBe(false)
      expect(JSON.stringify(r)).toContain('cannot_grant_to_self')
    }
    await requestAndApprove('action:sudo_grant_gate_capability', { type: 'org' })
    expect(await gate({ principal_type: 'agent', principal_id: 'agent-x' })).toMatchObject({ ok: false, error: 'cannot_grant_to_self' })
    expect(await gate({ principal_type: 'member', principal_id: 'mem-x' })).toMatchObject({ ok: false, error: 'cannot_grant_to_self' })
    expect(count('gate_grants')).toBe(0)
    expect(count('elevation_usage_log')).toBe(0)
  })
  it('NEVER CONFERRED: gate:hadi, any reserved lane, and any gate a human member already holds: refused at request time, and a call naming them is refused whatever was approved', async () => {
    run("INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('gg1', 'gate:human-lane', 'member', 'mem-sqadmin', 'mem-owner', datetime('now'))")
    await call('check_in', {})
    for (const capability of ['gate:hadi', 'gate:HADI', 'gate:athena', 'gate:kasra-core', 'gate:loops', 'gate:agent-self-completion', 'gate:escalation', 'gate:human-lane']) {
      const r = await out('request_elevation', { actions: ['action:sudo_grant_gate_capability'], scope_type: 'org', duration_minutes: 15, reason: 'r', sudo_args: { capability, principal_type: 'member', principal_id: 'mem-target' } })
      expect(r.ok, capability).toBe(false)
      expect(JSON.stringify(r), capability).toContain('sudo_gate_not_conferable')
    }
    await requestAndApprove('action:sudo_grant_gate_capability', { type: 'org' })
    for (const capability of ['gate:hadi', 'gate:athena', 'gate:human-lane']) {
      expect(await gate({ capability })).toMatchObject({ ok: false, error: 'sudo_gate_not_conferable' })
    }
    expect(count('gate_grants', "capability != 'gate:human-lane'")).toBe(0)
    expect(count('elevation_usage_log')).toBe(0)
    expect((await gate()).ok).toBe(true) // the approved, non-reserved lane still works
  })
  it('ARGS: every argument of the approved call is bound: a different capability, principal type or principal id is refused and spends nothing', async () => {
    await requestAndApprove('action:sudo_grant_gate_capability', { type: 'org' })
    for (const over of [{ capability: 'gate:other-lane' }, { principal_id: 'mem-y' }, { principal_type: 'agent', principal_id: 'agent-y' }, { principal_type: 'agent' }]) {
      const r = await gate(over)
      expect(r.ok, JSON.stringify(over)).toBe(false)
    }
    expect(count('gate_grants')).toBe(0)
    expect(count('elevation_usage_log')).toBe(0)
    expect((await gate()).ok).toBe(true)
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
  it('ARGS: every argument is bound (host, agent, project); a squad-b scope for an agent of squad-a is refused at request time', async () => {
    await call('check_in', {})
    expect((await out('request_elevation', { actions: ['action:sudo_seat_event_grant'], scope_type: 'squad', scope_id: 'squad-b', duration_minutes: 15, reason: 'r', sudo_args: DEFAULT_ARGS['action:sudo_seat_event_grant'] })).ok).toBe(false)
    run("INSERT INTO agent_keys (tenant, agent_id, pubkey, algo, member_id, created_at) VALUES ('tenant-a', 'host-2', 'BBBB', 'Ed25519', 'host-m', 1760000000)")
    await requestAndApprove('action:sudo_seat_event_grant', { type: 'squad', id: 'squad-a' })
    for (const over of [{ host_agent_id: 'host-2' }, { agent_id: 'agent-z' }, { project_id: 'p1' }]) {
      expect((await seat(over)).ok, JSON.stringify(over)).toBe(false)
    }
    expect(count('seat_event_grants')).toBe(0)
    expect(count('elevation_usage_log')).toBe(0)
    expect((await seat()).ok).toBe(true)
  })
  it('SELF: the host may not be the requesting agent (request time, and a call naming it)', async () => {
    await call('check_in', {})
    const r = await out('request_elevation', { actions: ['action:sudo_seat_event_grant'], scope_type: 'squad', scope_id: 'squad-a', duration_minutes: 15, reason: 'r', sudo_args: { host_agent_id: 'agent-x', agent_id: 'agent-y' } })
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).toContain('cannot_grant_to_self')
    await requestAndApprove('action:sudo_seat_event_grant', { type: 'squad', id: 'squad-a' })
    expect(await seat({ host_agent_id: 'agent-x' })).toMatchObject({ ok: false, error: 'cannot_grant_to_self' })
    expect(count('seat_event_grants')).toBe(0)
  })
  it('UNIFORM refusals: a missing host key, a host without standing and an already-granted agent all read the same 404 agent_not_visible', async () => {
    run("INSERT INTO agent_keys (tenant, agent_id, pubkey, algo, member_id, created_at) VALUES ('tenant-a', 'host-nostanding', 'CCCC', 'Ed25519', 'mem-target', 1760000000)")
    const seen: string[] = []
    for (const host of ['host-nokey', 'host-nostanding']) {
      await requestAndApprove('action:sudo_seat_event_grant', { type: 'squad', id: 'squad-a' }, { args: { host_agent_id: host, agent_id: 'agent-y' } })
      const r = await seat({ host_agent_id: host })
      seen.push(JSON.stringify([r.ok, r.status, r.error]))
      run("UPDATE elevation_grants SET revoked_at = datetime('now')")
    }
    await requestAndApprove('action:sudo_seat_event_grant', { type: 'squad', id: 'squad-a' })
    expect((await seat()).ok).toBe(true)
    run("UPDATE elevation_grants SET revoked_at = datetime('now')")
    await requestAndApprove('action:sudo_seat_event_grant', { type: 'squad', id: 'squad-a' }) // the agent already holds a live grant now
    const dup = await seat()
    seen.push(JSON.stringify([dup.ok, dup.status, dup.error]))
    expect(new Set(seen).size).toBe(1)
    expect(seen[0]).toBe(JSON.stringify([false, 404, 'agent_not_visible']))
  })
  it('PINNED squad: the write lands only while the agent is still in the squad it was authorised against', async () => {
    const { createSeatEventGrant } = await import('../src/agents/seat-events')
    expect(await createSeatEventGrant(env, { hostAgentId: 'host-1', agentId: 'agent-y', memberId: 'mem-owner', reason: 'r', expectSquadId: 'squad-b' })).toEqual({ ok: false, reason: 'agent_not_found' })
    expect(count('seat_event_grants')).toBe(0)
    expect((await createSeatEventGrant(env, { hostAgentId: 'host-1', agentId: 'agent-y', memberId: 'mem-owner', reason: 'r', expectSquadId: 'squad-a' })).ok).toBe(true)
  })
  it('an approval minted for one squad cannot be used by the tool against another (the pinned squad rides the marker)', async () => {
    await requestAndApprove('action:sudo_seat_event_grant', { type: 'squad', id: 'squad-a' })
    const { resolveOwnerSudo } = await import('../src/auth/owner-sudo')
    const v = await resolveOwnerSudo(env, agentAuth(), 'seat_event_grant', { agent_id: 'agent-y', host_agent_id: 'host-1', reason: 'r' })
    expect(v.kind).toBe('sudo')
    if (v.kind === 'sudo') {
      expect(v.memberAuth.ownerSudo?.squadId).toBe('squad-a')
      expect((await out('seat_event_grant', { agent_id: 'agent-y', host_agent_id: 'host-1', reason: 'r' }, { ...v.memberAuth, ownerSudo: { ...v.memberAuth.ownerSudo!, squadId: 'squad-b' } })).ok).toBe(false)
    }
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
      ['grant_gate_capability', { capability: 'gate:gaf-codex', principal_type: 'member', principal_id: 'mem-target' }],
      ['update_squad', { squad: 'squad-a', dyad_agent_a: 'agent-y', dyad_agent_b: 'agent-z' }],
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
    expect(first.ok).toBe(true)
    expect(await claimOwnerSudo(env, pending)).toMatchObject({ ok: false, refusal: { error: 'sudo_already_used' } }) // pending counts as spent
    if (first.ok) await finishOwnerSudo(env, first.claim, { ok: false, status: 409, error: 'x' }) // the tool refused: freed
    const second = await claimOwnerSudo(env, pending)
    expect(second.ok).toBe(true)
    if (second.ok) await finishOwnerSudo(env, second.claim, { ok: true }) // spent (and revoked)
    expect((await claimOwnerSudo(env, pending)).ok).toBe(false)
    // a fresh approval for the same action in the same session renews the SAME grant row and is usable once more
    const reqId2 = await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' })
    expect(grantRow(reqId2).id).toBe(grant.id)
    const renewed = (await loadElevationGrantById(env, TENANT, grant.id))!
    expect(renewed.revoked_at).toBeNull()
    expect((await claimOwnerSudo(env, { ...pending, grant: renewed })).ok).toBe(true)
  })
  it('ATOMIC with liveness: a /murevoke (or expiry) between resolve and claim refuses the claim and nothing runs', async () => {
    const { resolveOwnerSudo, claimOwnerSudo } = await import('../src/auth/owner-sudo')
    await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' })
    const v = await resolveOwnerSudo(env, agentAuth(), 'squad_member_add', { agent: 'agent-y', squad: 'squad-b', capability: 'member' })
    expect(v.kind).toBe('sudo')
    if (v.kind !== 'sudo') return
    expect((await handleApprovalBotUpdate(env, msg('/murevoke', TG.owner))).kind).toBe('revoked') // between resolve and claim
    expect(await claimOwnerSudo(env, v.pending)).toMatchObject({ ok: false, refusal: { error: 'sudo_grant_ended' } })
    expect(count('elevation_usage_log')).toBe(0)
    // and expiry in that window refuses too
    harness.sqlite.exec('DELETE FROM elevation_grants'); harness.sqlite.exec("UPDATE elevation_requests SET status = 'denied'")
    await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' })
    const v2 = await resolveOwnerSudo(env, agentAuth(), 'squad_member_add', { agent: 'agent-y', squad: 'squad-b', capability: 'member' })
    harness.sqlite.prepare('UPDATE elevation_grants SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString())
    if (v2.kind === 'sudo') expect(await claimOwnerSudo(env, v2.pending)).toMatchObject({ ok: false, refusal: { error: 'sudo_grant_ended' } })
  })
  it('GENERATION: revoking by the generation a caller saw cannot end a LATER approval that renewed the same grant row', async () => {
    const { revokeElevationGrant, loadElevationGrantById } = await import('../src/auth/elevation')
    const reqId = await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' })
    const old = (await loadElevationGrantById(env, TENANT, grantRow(reqId).id))!
    await revokeElevationGrant(env, TENANT, old.id, 'x', Date.now(), old.created_at)
    await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' }) // renews the same row (new generation)
    expect((await revokeElevationGrant(env, TENANT, old.id, 'late', Date.now(), old.created_at)).revoked).toBe(false)
    expect((await loadElevationGrantById(env, TENANT, old.id))!.revoked_at).toBeNull()
    expect((await out('squad_member_add', { agent: 'agent-y', squad: 'squad-b', capability: 'member' })).ok).toBe(true)
  })
  it('FAIL CLOSED: if the audit receipt cannot be written nothing runs and the approval is not spent', async () => {
    const reqId = await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' })
    run("CREATE TRIGGER no_sudo_receipt BEFORE INSERT ON mutation_audit_entries WHEN NEW.handler = 'owner_sudo' BEGIN SELECT RAISE(ABORT, 'audit down'); END")
    const r = await out('squad_member_add', { agent: 'agent-y', squad: 'squad-b', capability: 'member' })
    expect(r).toMatchObject({ ok: false, error: 'sudo_receipt_failed' })
    expect(memberOf('agent-y', 'squad-b')).toBeUndefined()
    expect(usage(reqId)).toEqual([{ status: 'failed' }])
    run('DROP TRIGGER no_sudo_receipt')
    expect((await out('squad_member_add', { agent: 'agent-y', squad: 'squad-b', capability: 'member' })).ok).toBe(true)
  })
  it('a second approval for the same one-call action in one session works end to end (spent grant renews)', async () => {
    await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' })
    expect((await out('squad_member_add', { agent: 'agent-y', squad: 'squad-b', capability: 'member' })).ok).toBe(true)
    await requestAndApprove('action:sudo_squad_member_add', { type: 'squad', id: 'squad-b' })
    expect((await out('squad_member_add', { agent: 'agent-y', squad: 'squad-b', capability: 'member' })).ok).toBe(true)
    expect(count('mutation_audit_entries', "handler = 'owner_sudo' AND operation LIKE 'owner_sudo:%'")).toBe(2) // an 'authorized' receipt per call, written BEFORE it runs
  })
})
