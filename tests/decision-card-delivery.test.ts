// Decision-card delivery (member-held review gate -> owner's harness agent), the humane
// activity feed, and the /mu* IM command aliases.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wakeGateOwnerOnReview } from '../src/mcp'
import { readAgentInbox } from '../src/agents/messages'
import { postAgentActivity } from '../src/channels'
import { ADAPTERS } from '../src/channels/registry'
import { handleImMessage, normalizeImCommand } from '../src/im'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { BusEvent, Env, Task } from '../src/types'

const TENANT = 'mumega'
const TASK_ID = 'abcdef12-0000-4000-8000-000000000001'

let harness: SqliteD1Harness
let env: Env
type Db = SqliteD1Harness['sqlite']

function run(sql: string, ...args: unknown[]): void {
  harness.sqlite.prepare(sql).run(...args)
}
function seedAgent(id: string, owner: string | null, status = 'active'): void {
  run(`INSERT INTO agents (id, squad_id, slug, name, status, owner_member_id) VALUES (?, 'squad-1', ?, ?, ?, ?)`, id, `${id}-slug`, id, status, owner)
}
function seedMember(id: string, name: string, chat: string | null = null): void {
  run(`INSERT INTO members (id, email, display_name, telegram_chat_id, status, tenant) VALUES (?, ?, ?, ?, 'active', ?)`, id, `${id}@t.com`, name, chat, TENANT)
}
function seedGrant(cap: string, type: 'agent' | 'member', id: string): void {
  run(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES (?, ?, ?, ?, 't', datetime('now'))`, `g-${cap}-${id}`, cap, type, id)
}
function seedTask(gate: string, status = 'review'): void {
  run(`INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, result, priority) VALUES (?, 'squad-1', 'Decide the thing', 'b', 'd', ?, ?, ?, 'P1')`, TASK_ID, status, gate, 'R'.repeat(900))
}
function task(): Task {
  return harness.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(TASK_ID) as unknown as Task
}
function messageCount(): number {
  return Number((harness.sqlite.prepare('SELECT COUNT(*) AS n FROM agent_messages').get() as { n: number }).n)
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = { DB: harness.db, TENANT_SLUG: TENANT, BUS: { send: async () => {} } } as unknown as Env
  run(`INSERT INTO departments (id, slug, name) VALUES ('d1', 'd1', 'D')`)
  run(`INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'd1', 'squad-1', 'S')`)
  seedMember('mem-hadi', 'Hadi')
})
afterEach(() => { harness.close(); vi.restoreAllMocks() })

describe('wakeGateOwnerOnReview — member-held gate', () => {
  it('delivers ONE decision card to the member-owned active agent, idempotent on re-wake', async () => {
    seedAgent('kay', 'mem-hadi')
    seedAgent('other-owner', null)
    seedAgent('retired', 'mem-hadi', 'inactive')
    seedGrant('gate:hadi', 'member', 'mem-hadi')
    seedTask('gate:hadi')
    const actor = { kind: 'member' as const, id: 'mem-hadi' }

    const out = await wakeGateOwnerOnReview(env, task(), actor, 'mem-hadi')
    expect(out.status).toBe('delivered_to_owner_agent')
    expect(out.notice).toContain('kay')
    expect(messageCount()).toBe(1)

    const again = await wakeGateOwnerOnReview(env, task(), actor, 'mem-hadi')
    expect(again.status).toBe('delivered_to_owner_agent')
    expect(messageCount()).toBe(1)

    const inbox = await readAgentInbox(env, { agent: 'kay', peek: true })
    if (!inbox.ok) throw new Error(inbox.reason)
    expect(inbox.messages).toHaveLength(1)
    const m = inbox.messages[0]
    expect(m.from_agent).toBe('mupot-review-gate')
    expect(m.kind).toBe('request')
    expect(m.expects_reply).toBe(false)
    expect(m.reply_via).toBe('task_verdict')
    expect(m.request_id).toMatch(/^decision-card:abcdef12-0000-4000-8000-000000000001:/)
    const card = JSON.parse(m.body) as Record<string, unknown>
    expect(card).toMatchObject({
      type: 'decision_card', task_id: TASK_ID, short_id: 'abcdef12', title: 'Decide the thing', priority: 'P1',
      approve: '/muapprove abcdef12', reject: '/mureject abcdef12',
    })
    expect((card.result_excerpt as string).length).toBe(400)
  })

  it('two owned agents each get their own card (request_id is per-sender unique)', async () => {
    seedAgent('kay', 'mem-hadi')
    seedAgent('muse', 'mem-hadi')
    seedGrant('gate:hadi', 'member', 'mem-hadi')
    seedTask('gate:hadi')
    const out = await wakeGateOwnerOnReview(env, task(), { kind: 'member', id: 'mem-hadi' }, 'mem-hadi')
    expect(out.status).toBe('delivered_to_owner_agent')
    expect(messageCount()).toBe(2)
  })

  it('prefers the agent holding an attestor token when the allowlist names one', async () => {
    seedAgent('kay', 'mem-hadi')
    seedAgent('coder', 'mem-hadi')
    seedMember('mem-kay', 'Kay')
    run(`INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES (?, 'kay', 'mem-kay', datetime('now'))`, TENANT)
    run(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, agent_id, tenant) VALUES ('tok-kay', 'mem-kay', 'h1', 'l', 'workspace', 'kay', ?)`, TENANT)
    seedGrant('gate:hadi', 'member', 'mem-hadi')
    seedTask('gate:hadi')
    env = { ...env, HUMAN_ORIGIN_ATTESTOR_TOKEN_IDS: 'tok-kay' } as Env
    const out = await wakeGateOwnerOnReview(env, task(), { kind: 'member', id: 'mem-hadi' }, 'mem-hadi')
    expect(out.status).toBe('delivered_to_owner_agent')
    expect(messageCount()).toBe(1)
    const row = harness.sqlite.prepare('SELECT to_agent FROM agent_messages').get() as { to_agent: string }
    expect(row.to_agent).toBe('kay')
  })

  it('no owned active agent -> requires_human unchanged, nothing sent', async () => {
    seedAgent('retired', 'mem-hadi', 'inactive')
    seedGrant('gate:hadi', 'member', 'mem-hadi')
    seedTask('gate:hadi')
    const out = await wakeGateOwnerOnReview(env, task(), { kind: 'member', id: 'mem-hadi' }, 'mem-hadi')
    expect(out.status).toBe('requires_human')
    expect(messageCount()).toBe(0)
  })

  it('agent-held gate is unchanged (task_review wake, not a decision card)', async () => {
    seedAgent('gatekeeper', null)
    seedGrant('gate:x', 'agent', 'gatekeeper')
    seedTask('gate:x')
    const out = await wakeGateOwnerOnReview(env, task(), { kind: 'member', id: 'mem-hadi' }, 'mem-hadi')
    expect(out.status).not.toBe('delivered_to_owner_agent')
    const row = harness.sqlite.prepare('SELECT body FROM agent_messages').get() as { body: string }
    expect(JSON.parse(row.body)).toMatchObject({ type: 'task_review' })
  })
})

describe('postAgentActivity — humane feed', () => {
  function bind(): ReturnType<typeof vi.fn> {
    run(`INSERT INTO channel_bindings (id, platform, external_channel_id, squad_id, max_capability) VALUES ('b1', 'discord', 'chan', 'squad-1', 'member')`)
    const post = vi.fn(async () => {})
    vi.spyOn(ADAPTERS.discord, 'post').mockImplementation(post)
    return post
  }
  function ev(type: BusEvent['type'], status: string): BusEvent {
    return { type, tenant: TENANT, squad_id: 'squad-1', agent_id: 'agent-uuid-1', actor: { kind: 'agent', id: 'agent-uuid-1' },
      payload: { task_id: TASK_ID, status, title: 'Decide the thing' }, ts: new Date().toISOString() } as BusEvent
  }
  beforeEach(() => { seedAgent('agent-uuid-1', null) })

  it('labels with the slug, never the UUID, and skips plain task.updated', async () => {
    const post = bind()
    await postAgentActivity(env, ev('task.updated', 'in_progress'))
    expect(post).not.toHaveBeenCalled()
    await postAgentActivity(env, ev('task.created', 'open'))
    expect(post).toHaveBeenCalledTimes(1)
    const text = post.mock.calls[0][2] as string
    expect(text).toContain('agent-uuid-1-slug')
    expect(text).not.toMatch(/🤖 agent-uuid-1 /)
  })

  it('review entry under a member gate says whose decision and how', async () => {
    seedGrant('gate:hadi', 'member', 'mem-hadi')
    seedTask('gate:hadi')
    const post = bind()
    await postAgentActivity(env, ev('task.updated', 'review'))
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0][2]).toContain("needs Hadi's decision: Decide the thing — /muapprove abcdef12")
  })
})

describe('/mu* IM aliases', () => {
  it('normalises aliases and @botname suffixes, leaves other text alone', () => {
    expect(normalizeImCommand('/muapprove task-1')).toBe('/approve task-1')
    expect(normalizeImCommand('/muapprove@kayhermes_mubot task-1 ok')).toBe('/approve task-1 ok')
    expect(normalizeImCommand('/MUREJECT@Bot t reason')).toBe('/reject t reason')
    expect(normalizeImCommand('/muneeds@b')).toBe('/needs')
    expect(normalizeImCommand('/muanswer r a')).toBe('/answer r a')
    expect(normalizeImCommand('/login@b')).toBe('/login')
    expect(normalizeImCommand('/muapproveX t')).toBe('/muapprovex t')
    expect(normalizeImCommand('task: do @squad')).toBe('task: do @squad')
  })

  it('/muapprove hits the same verdict handler + auth as /approve; /muneeds equals /needs', async () => {
    run(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c1', 'mem-hadi', 'squad', 'squad-1', 'member')`)
    run(`UPDATE members SET telegram_chat_id = 'chat-1' WHERE id = 'mem-hadi'`)
    seedMember('mem-other', 'Other', 'chat-2')
    seedGrant('gate:hadi', 'member', 'mem-hadi')
    seedTask('gate:hadi')
    // Unauthorised member (no gate): both forms refused identically, no verdict written.
    const bare = await handleImMessage(env, 'chat-2', `approve ${TASK_ID}`)
    const alias = await handleImMessage(env, 'chat-2', `/muapprove@kayhermes_mubot ${TASK_ID}`)
    expect(alias).toBe(bare)
    expect(Number((harness.sqlite.prepare('SELECT COUNT(*) AS n FROM task_verdicts').get() as { n: number }).n)).toBe(0)
    // Authorised member: alias approves.
    const ok = await handleImMessage(env, 'chat-1', `/muapprove ${TASK_ID}`)
    expect(ok).toMatch(/Approved/)
    expect(Number((harness.sqlite.prepare('SELECT COUNT(*) AS n FROM task_verdicts').get() as { n: number }).n)).toBe(1)

    expect(await handleImMessage(env, 'chat-1', '/muneeds')).toBe(await handleImMessage(env, 'chat-1', '/needs'))
  })
})
