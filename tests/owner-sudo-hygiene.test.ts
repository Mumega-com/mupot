// tests/owner-sudo-hygiene.test.ts — W1-2 (council-20261121-authz): the two hygiene acts that refused every agent-bound caller
// even with a standing go (archive_row, project_update add_repo/remove_repo) clear with ONE human-approved tap through owner
// sudo, and nothing else widens. move_agent_squad is deliberately NOT a sudo act (Kasra's gate on #2488).
// Same harness as tests/owner-sudo.test.ts: real migrated schema, the REAL tools through invokeTool, the REAL approval-bot decision path; only the Bot API (global fetch) is stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeTool } from '../src/mcp/index' // first: the mcp/seeds modules form an import cycle that only resolves from mcp/index
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { handleApprovalBotUpdate } from '../src/approval-bot/decide'
import { OWNER_SUDO_ACTIONS } from '../src/auth/elevation-actions'
import { OWNER_SUDO_ACTION_FOR_TOOL } from '../src/auth/owner-sudo'
import { ATTACHED_SUDO_ACTIONS } from '../src/auth/attached-ceiling'
import { classifyAction } from '../src/notify/carry'

const TENANT = 'tenant-a'
const BOT_TOKEN = '987654321:AAEhqMY-approval-bot-test-token-xyz'
const TG_OWNER = 1001
const REPO = 'https://github.com/acme/widgets'

let harness: SqliteD1Harness
let env: Env
const one = <T>(sql: string, ...p: unknown[]): T => harness.sqlite.prepare(sql).get(...p) as T
const count = (t: string, where = '1=1'): number => one<{ n: number }>(`SELECT COUNT(*) AS n FROM "${t}" WHERE ${where}`).n
const run = (sql: string): void => { harness.sqlite.exec(sql) }

let calls: Array<{ url: string; body: Record<string, unknown> }> = []
const agentAuth = (): AuthContext => ({
  userId: 'mem-x', email: 'x@x.test', role: 'member', tenant: TENANT, channel: 'workspace', memberId: 'mem-x', tokenId: 'tok-x',
  capabilities: [{ member_id: 'mem-x', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' } as CapabilityGrant], boundAgentId: 'agent-x',
})
type Out = { ok: boolean; status?: number; error?: string; detail?: unknown; result?: Record<string, unknown> }
const out = async (tool: string, args: Record<string, unknown>): Promise<Out> => (await invokeTool(agentAuth(), env, tool, args, 'https://pot.test')) as Out

let seq = 100
const msg = (text: string) => ({ update_id: ++seq, message: { message_id: 7, from: { id: TG_OWNER }, chat: { id: TG_OWNER, type: 'private' }, text } })

/** File the request through the real tool; returns the tool outcome (no approval). */
async function ask(action: string, scope: { type: 'org' | 'squad'; id?: string }, sudoArgs: Record<string, unknown>): Promise<Out> {
  await out('check_in', {})
  return out('request_elevation', { actions: [action], scope_type: scope.type, ...(scope.id ? { scope_id: scope.id } : {}), duration_minutes: 15, reason: 'hygiene', ...(action.startsWith('action:sudo_') ? { sudo_args: sudoArgs } : {}) })
}
/** Ask, then the owner taps Approve in the approval bot. Returns the request id. */
async function approve(action: string, scope: { type: 'org' | 'squad'; id?: string }, sudoArgs: Record<string, unknown>): Promise<string> {
  const r = await ask(action, scope, sudoArgs)
  if (!r.ok) throw new Error(`request failed ${JSON.stringify(r)}`)
  const id = (r.result as { request: { id: string } }).request.id
  const shortId = one<{ short_id: string }>('SELECT short_id FROM elevation_requests WHERE id = ?', id).short_id
  const res = await handleApprovalBotUpdate(env, msg(`/muapprove ${shortId}`))
  if (res.kind !== 'approved') throw new Error(`approve failed ${JSON.stringify(res)}`)
  return id
}
const usage = (reqId: string): string[] =>
  (harness.sqlite.prepare('SELECT u.status AS status FROM elevation_usage_log u JOIN elevation_grants g ON g.id = u.elevation_grant_id WHERE g.elevation_request_id = ?').all(reqId) as Array<{ status: string }>).map((r) => r.status)
/** The approval card the human saw (the bot message that carries the exact call). */
const cardText = (): string => calls.filter((c) => c.url.includes(BOT_TOKEN)).map((c) => String(c.body.text ?? '')).find((t) => t.includes('EXACT CALL')) ?? ''

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  run(`
    INSERT INTO org_settings (key, value) VALUES ('billing_state', '{"tier":"scale"}');
    INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept', 'a-sqd', 'A'), ('squad-b', 'dept', 'b-sqd', 'B'), ('squad-c', 'dept', 'c-sqd', 'C');
    INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('squad-home', 'dept', 'home-sqd', 'Home', 'home');
    INSERT INTO users (id, email, role) VALUES ('u-owner', 'owner@x.test', 'owner');
    INSERT INTO members (id, email, display_name, status, tenant, telegram_chat_id) VALUES
      ('mem-owner', 'owner@x.test', 'Owner', 'active', '${TENANT}', '${TG_OWNER}'),
      ('mem-x', 'x@x.test', 'Agent X', 'active', '${TENANT}', NULL),
      ('mem-y', 'y@x.test', 'Agent Y', 'active', '${TENANT}', NULL),
      ('mem-human', 'h@x.test', 'A Human', 'active', '${TENANT}', NULL);
    INSERT INTO agents (id, squad_id, slug, name, role, model, status, owner_member_id) VALUES
      ('agent-x', 'squad-a', 'agent-x', 'Agent X', 'r', 'm', 'active', 'mem-owner'),
      ('agent-y', 'squad-a', 'agent-y', 'Agent Y', 'r', 'm', 'active', NULL),
      ('agent-old', 'squad-a', 'agent-old', 'Old Agent', 'r', 'm', 'inactive', NULL);
    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
      ('ms-x', 'agent-x', 'squad-a', 'member'), ('ms-y', 'agent-y', 'squad-a', 'member'), ('ms-yb', 'agent-y', 'squad-b', 'member');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
      ('${TENANT}', 'agent-x', 'mem-x', datetime('now')), ('${TENANT}', 'agent-y', 'mem-y', datetime('now'));
    INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at) VALUES
      ('hli-owner', '${TENANT}', 'email', 'owner@x.test', 'owner@x.test', 'mem-owner', datetime('now'));
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at)
      VALUES ('tok-x', 'mem-x', 'hash-x', 'primary', 'workspace', '${TENANT}', 'agent-x', datetime('now'));
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-o', 'mem-owner', 'org', NULL, 'owner');
    INSERT INTO tasks (id, squad_id, title, status, done_when) VALUES
      ('task-1', 'squad-a', 'stale one', 'open', 'never'), ('task-2', 'squad-a', 'stale two', 'open', 'never');
    INSERT INTO projects (id, slug, name) VALUES ('proj-1', 'p-one', 'Project One');
  `)
  env = {
    DB: harness.db, TENANT_SLUG: TENANT, CONNECTOR_MASTER_KEY: 'a1'.repeat(32), PUBLIC_ORIGIN: 'https://colony.example.test',
    APPROVAL_BOT_TOKEN: BOT_TOKEN, APPROVAL_BOT_WEBHOOK_SECRET: 'approval-webhook-secret-0123456789', APPROVAL_BOT_USERNAME: 'muapprove_test_bot',
    OWNER_SUDO_ENABLED: '1', TASK_ARCHIVE_ENABLED: '1',
  } as unknown as Env
  calls = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
    return new Response(JSON.stringify({ ok: true, result: { message_id: 600 } }), { status: 200 })
  })
})
afterEach(() => { harness.close(); vi.unstubAllGlobals() })

describe('W1-2 registry: exactly two new one-tap acts, tokens and moves stay out', () => {
  it('the owner-sudo map is exactly the six tools, and no credential tool or move_agent_squad is on it', () => {
    expect(Object.keys(OWNER_SUDO_ACTION_FOR_TOOL).sort()).toEqual([
      'archive_row', 'grant_gate_capability', 'project_update', 'seat_event_grant', 'squad_member_add', 'update_squad',
    ])
    expect([...OWNER_SUDO_ACTIONS]).not.toContain('action:sudo_move_agent_squad')
    for (const t of ['mint_agent_token', 'list_agent_tokens', 'revoke_agent_token', 'reveal_credential_claim', 'register_agent_key']) {
      expect(Object.keys(OWNER_SUDO_ACTION_FOR_TOOL)).not.toContain(t)
    }
    expect([...OWNER_SUDO_ACTIONS].filter((a) => /token|credential|key/.test(a))).toEqual([])
  })
  it('both are one-tap reversible on the bot; neither is attached-sudo-able; token and move actions are not', () => {
    for (const a of ['action:sudo_archive_row', 'action:sudo_project_repo']) expect(classifyAction(a)).toBe('reversible')
    expect(ATTACHED_SUDO_ACTIONS).not.toContain('action:sudo_archive_row') // Kasra gate #2488 round 2 (P-OBS); back via #2497
    expect(ATTACHED_SUDO_ACTIONS).not.toContain('action:sudo_project_repo') // add_repo widens GitHub write reach
    expect(ATTACHED_SUDO_ACTIONS).not.toContain('action:sudo_move_agent_squad')
    expect(classifyAction('action:sudo_move_agent_squad')).toBe('high_risk') // unknown to the bot: fails closed
    expect(ATTACHED_SUDO_ACTIONS).not.toContain('action:mint_token')
    expect(classifyAction('action:mint_token')).toBe('high_risk')
  })
})

describe('archive_row: one tap archives one task, work squad or inactive agent', () => {
  const archive = (over: Record<string, unknown> = {}) => out('archive_row', { table: 'tasks', id: 'task-1', reason: 'stale', ...over })
  const archived = (table: string, id: string): number => count('archive_receipts', `entity_table = '${table}' AND entity_id = '${id}' AND action = 'archive' AND actor_member_id = 'mem-owner'`)

  it('refused without an approval: an agent-bound caller is still refused, nothing archived', async () => {
    expect((await archive()).ok).toBe(false)
    expect(archived('tasks', 'task-1')).toBe(0)
  })
  it('after one tap: archives the task AS the owner, exactly once; the card names the exact call', async () => {
    run(`UPDATE tasks SET gate_owner = 'gate:agent-y', assignee_agent_id = 'agent-y' WHERE id = 'task-1'`)
    const reqId = await approve('action:sudo_archive_row', { type: 'squad', id: 'squad-a' }, { table: 'tasks', id: 'task-1' })
    expect(cardText()).toContain('EXACT CALL')
    // the card names the task by title, status, gate owner and assignee, so the human sees WHAT they archive
    expect(cardText()).toContain('archive task task-1 ("stale one"), status open, gate owner gate:agent-y, assignee agent agent-y ("agent-y") (undo with unarchive_row)')
    const r = await archive()
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.result).toMatchObject({ status: 'archived', owner_sudo: { executed_as_authority: 'mem-owner', approval: 'spent' } })
    expect(archived('tasks', 'task-1')).toBe(1)
    expect(usage(reqId)).toEqual(['applied'])
    expect((await archive({ id: 'task-2' })).ok).toBe(false) // spent: a second call loses
    expect(archived('tasks', 'task-2')).toBe(0)
  })
  it('the card says so when a task has no gate owner and no assignee', async () => {
    await approve('action:sudo_archive_row', { type: 'squad', id: 'squad-a' }, { table: 'tasks', id: 'task-2' })
    expect(cardText()).toContain('archive task task-2 ("stale two"), status open, gate owner none, assignee unassigned')
  })
  it('the card names a human assignee', async () => {
    run(`INSERT INTO tasks (id, squad_id, title, status, done_when, assignee_member_id) VALUES ('task-h', 'squad-a', 'human held', 'review', 'never', 'mem-human')`)
    await approve('action:sudo_archive_row', { type: 'squad', id: 'squad-a' }, { table: 'tasks', id: 'task-h' })
    expect(cardText()).toContain('status review, gate owner none, assignee member mem-human ("A Human")')
  })
  it('ARGS: the digest binds the TABLE: an approval for task dup-1 never archives squad dup-1 (same id, same scope)', async () => {
    run(`
      INSERT INTO squads (id, department_id, slug, name) VALUES ('dup-1', 'dept', 'dup-sqd', 'Dup');
      INSERT INTO tasks (id, squad_id, title, status, done_when) VALUES ('dup-1', 'dup-1', 'dup task', 'open', 'never');
    `)
    await approve('action:sudo_archive_row', { type: 'squad', id: 'dup-1' }, { table: 'tasks', id: 'dup-1' })
    expect(await archive({ table: 'squads', id: 'dup-1' })).toMatchObject({ ok: false, error: 'sudo_args_mismatch' })
    expect(archived('squads', 'dup-1')).toBe(0)
    expect(count('elevation_usage_log')).toBe(0)
    const r = await archive({ table: 'tasks', id: 'dup-1' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
  })
  it('ARGS: an approval for task-1 does not archive task-2 and spends nothing', async () => {
    await approve('action:sudo_archive_row', { type: 'squad', id: 'squad-a' }, { table: 'tasks', id: 'task-1' })
    expect(await archive({ id: 'task-2' })).toMatchObject({ ok: false, error: 'sudo_args_mismatch' })
    expect(count('elevation_usage_log')).toBe(0)
  })
  it('an INACTIVE agent can be archived with one tap', async () => {
    await approve('action:sudo_archive_row', { type: 'squad', id: 'squad-a' }, { table: 'agents', id: 'agent-old' })
    const r = await archive({ table: 'agents', id: 'agent-old' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(archived('agents', 'agent-old')).toBe(1)
  })
  it('FENCE: an ACTIVE agent is never covered (deactivate first), nor the requesting agent', async () => {
    expect(JSON.stringify(await ask('action:sudo_archive_row', { type: 'squad', id: 'squad-a' }, { table: 'agents', id: 'agent-y' }))).toContain('sudo_agent_not_inactive')
    expect(JSON.stringify(await ask('action:sudo_archive_row', { type: 'squad', id: 'squad-a' }, { table: 'agents', id: 'agent-x' }))).toContain('cannot_archive_self')
    expect(count('elevation_requests')).toBe(0)
  })
  it('FENCE: members and projects stay operator-only, at request time and at use time', async () => {
    for (const [table, id] of [['members', 'mem-human'], ['projects', 'proj-1']]) {
      expect(JSON.stringify(await ask('action:sudo_archive_row', { type: 'org' }, { table, id }))).toContain('sudo_archive_table_not_covered')
    }
    expect(count('elevation_requests')).toBe(0)
    // holding a live task approval, the agent still cannot archive a member or a project with it
    await approve('action:sudo_archive_row', { type: 'squad', id: 'squad-a' }, { table: 'tasks', id: 'task-1' })
    expect(await archive({ table: 'members', id: 'mem-human' })).toMatchObject({ ok: false, error: 'sudo_archive_table_not_covered' })
    expect(await archive({ table: 'projects', id: 'proj-1' })).toMatchObject({ ok: false, error: 'sudo_archive_table_not_covered' })
    expect(count('archive_receipts')).toBe(0)
    expect(count('elevation_usage_log')).toBe(0)
  })
  it('FENCE: a home squad is never covered; a work squad is, scoped to that squad', async () => {
    expect(JSON.stringify(await ask('action:sudo_archive_row', { type: 'org' }, { table: 'squads', id: 'squad-home' }))).toContain('home_squad_immutable')
    expect(JSON.stringify(await ask('action:sudo_archive_row', { type: 'squad', id: 'squad-a' }, { table: 'squads', id: 'squad-c' }))).toContain('scope_id must be the squad the call touches')
    await approve('action:sudo_archive_row', { type: 'squad', id: 'squad-c' }, { table: 'squads', id: 'squad-c' })
    const r = await archive({ table: 'squads', id: 'squad-c' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(archived('squads', 'squad-c')).toBe(1)
  })
})

describe('project_update add_repo / remove_repo: one tap, one repository edit, nothing else', () => {
  const repos = (): string[] => (harness.sqlite.prepare("SELECT repo_key FROM project_repos WHERE project_id = 'proj-1'").all() as Array<{ repo_key: string }>).map((r) => r.repo_key)
  const add = (over: Record<string, unknown> = {}) => out('project_update', { project_id: 'proj-1', add_repo: REPO, ...over })

  it('refused without an approval, and the refusal teaches the exact sudo call', async () => {
    const r = await add()
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).toContain('action:sudo_project_repo')
    expect(repos()).toEqual([])
  })
  it('after one tap: adds the repo AS the owner, once; then a second tap removes it', async () => {
    const reqId = await approve('action:sudo_project_repo', { type: 'org' }, { project_id: 'proj-1', op: 'add', repo: REPO })
    expect(cardText()).toContain('to the allow-list of project proj-1 ("Project One")')
    const r = await add()
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.result).toMatchObject({ changed: true, owner_sudo: { executed_as_authority: 'mem-owner', approval: 'spent' } })
    expect(repos()).toHaveLength(1)
    expect(usage(reqId)).toEqual(['applied'])
    expect((await out('project_update', { project_id: 'proj-1', remove_repo: REPO })).ok).toBe(false) // the add approval does not remove
    await approve('action:sudo_project_repo', { type: 'org' }, { project_id: 'proj-1', op: 'remove', repo: REPO })
    expect((await out('project_update', { project_id: 'proj-1', remove_repo: REPO })).ok).toBe(true)
    expect(repos()).toEqual([])
  })
  it('FENCE: only the repository edit; a status/name riding along or both edits at once is refused and spends nothing', async () => {
    await approve('action:sudo_project_repo', { type: 'org' }, { project_id: 'proj-1', op: 'add', repo: REPO })
    expect(await add({ status: 'paused' })).toMatchObject({ ok: false, error: 'sudo_covers_exact_call_only' })
    expect(await add({ name: 'Hijacked' })).toMatchObject({ ok: false, error: 'sudo_covers_exact_call_only' })
    expect(await add({ remove_repo: REPO })).toMatchObject({ ok: false, error: 'sudo_covers_exact_call_only' })
    expect(await add({ add_repo: 'https://github.com/acme/other' })).toMatchObject({ ok: false, error: 'sudo_args_mismatch' })
    expect(count('elevation_usage_log')).toBe(0)
    expect(one<{ name: string }>("SELECT name FROM projects WHERE id = 'proj-1'").name).toBe('Project One')
    expect((await add()).ok).toBe(true)
  })
  it('a status-only project_update is not a sudo situation: the repo approval never opens it, and never blocks the status door', async () => {
    await approve('action:sudo_project_repo', { type: 'org' }, { project_id: 'proj-1', op: 'add', repo: REPO })
    const plain = await out('project_update', { project_id: 'proj-1', status: 'paused' })
    expect(plain.ok).toBe(false)
    expect(plain.error).not.toBe('sudo_covers_exact_call_only')
    expect(count('elevation_usage_log')).toBe(0)
    // with its own action:project_status approval, the status change goes through its usual door, the repo approval untouched
    await approve('action:project_status', { type: 'org' }, {})
    const viaStatus = await out('project_update', { project_id: 'proj-1', status: 'paused' })
    expect(viaStatus.ok, JSON.stringify(viaStatus)).toBe(true)
    expect(one<{ status: string }>("SELECT status FROM projects WHERE id = 'proj-1'").status).toBe('paused')
    expect((await add()).ok).toBe(true)
  })
  it('org scope only: a squad-scope request is refused', async () => {
    const r = await ask('action:sudo_project_repo', { type: 'squad', id: 'squad-a' }, { project_id: 'proj-1', op: 'add', repo: REPO })
    expect(JSON.stringify(r)).toContain('action:sudo_project_repo is org scope')
  })
})
