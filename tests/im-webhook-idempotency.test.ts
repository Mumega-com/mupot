import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { imApp } from '../src/im'
import { createProjectInvite, redeemTelegramProjectInvite } from '../src/members/project-invites'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const SECRET = 'test-telegram-webhook-secret'
const app = new Hono<{ Bindings: Env }>().route('/im', imApp)
function envelope(text: string, updateId = 10, userId = 123) {
  return { update_id: updateId, message: { chat: { id: userId, type: 'private' }, from: { id: userId }, text } }
}

describe('authenticated Telegram receipts and human controls', () => {
  let harness: SqliteD1Harness
  let env: Env
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: 'telegram-test', IM_WEBHOOK_SECRET: SECRET, DB: harness.db } as Env
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Dept');
      INSERT INTO squads (id, department_id, slug, name) VALUES
        ('squad-1', 'dept', 'core', 'Core'), ('squad-2', 'dept', 'private', 'Private');
      INSERT INTO projects (id, slug, name, status) VALUES
        ('project-1', 'project-1', 'Project One', 'active'),
        ('project-2', 'project-2', 'Private Project', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
        ('project-1', 'squad-1', 'write'), ('project-2', 'squad-2', 'write');
    `)
  })
  afterEach(() => harness.close())

  async function post(body: unknown, secret = SECRET) {
    return app.fetch(new Request('https://pot.test/im/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify(body),
    }), env)
  }
  function member(capability = 'member') {
    harness.sqlite.prepare(`INSERT INTO members (id, email, display_name, telegram_chat_id, status, tenant)
      VALUES ('human-1', 'human@example.com', 'Human', '123', 'active', 'telegram-test')`).run()
    harness.sqlite.prepare(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-human', 'human-1', 'squad', 'squad-1', ?)`).run(capability)
  }
  function receipt() {
    return harness.sqlite.prepare('SELECT * FROM telegram_webhook_receipts ORDER BY update_id').all()
  }
  function businessState() {
    return ['invites', 'members', 'capabilities', 'task_verdicts', 'tasks'].map(table =>
      harness.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all())
  }
  async function invite() {
    const auth: AuthContext = { userId: 'admin', email: 'admin@test.com', role: 'admin', tenant: env.TENANT_SLUG }
    const result = await createProjectInvite(env, auth, {
      email: 'invited@example.com', project_id: 'project-1', squad_id: 'squad-1',
      capability: 'member', expires_in_seconds: 3600,
    })
    if (!result.ok) throw new Error(result.error)
    return result.value.pairing_code
  }

  it.each([
    ['update', { message: envelope('/help').message }],
    ['user', { update_id: 10, message: { chat: { id: 123, type: 'private' }, text: '/help' } }],
    ['chat', { update_id: 10, message: { from: { id: 123 }, text: '/help' } }],
    ['unsafe user', envelope('/help', 10, Number.MAX_SAFE_INTEGER + 1)],
    ['zero user', envelope('/help', 10, 0)],
    ['negative update', envelope('/help', -1)],
    ['null', null],
  ])('rejects missing or invalid %s identity before reserving', async (_label, body) => {
    const response = await post(body)
    expect(response.status).toBe(400)
    expect(receipt()).toEqual([])
  })

  it('requires the actual configured Telegram secret before reserving or acting', async () => {
    member()
    const before = businessState()
    expect((await post(envelope('task: do work'), 'wrong')).status).toBe(401)
    expect(receipt()).toEqual([])
    expect(businessState()).toEqual(before)
  })

  it.each([
    { ...envelope('task: do work').message, chat: { id: 123, type: 'group' } },
    { ...envelope('task: do work').message, from: { id: 456 } },
    { ...envelope('task: do work').message, chat: { id: 123 } },
  ])('refuses non-private or mismatched sender chats', async message => {
    member()
    const before = businessState()
    const response = await post({ update_id: 10, message })
    expect(response.status).toBe(400)
    expect(businessState()).toEqual(before)
    expect(receipt()).toEqual([])
  })

  it('stores the verified user and replays the stored response with exactly one task effect', async () => {
    member()
    const first = await post(envelope('task: do work'))
    const body = await first.json()
    expect(first.status).toBe(200)
    const stored = receipt()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ tenant: 'telegram-test', update_id: '10', telegram_user_id: '123', state: 'completed' })
    expect(stored[0].request_digest).toMatch(/^[a-f0-9]{64}$/)
    expect(await (await post(envelope('task: do work'))).json()).toEqual(body)
    expect(receipt()).toEqual(stored)
    expect(harness.sqlite.prepare('SELECT title FROM tasks').all()).toEqual([{ title: 'do work' }])
  })

  it('allows only one concurrent update to produce the task effect', async () => {
    member()
    // Hold the external Queue acknowledgement after the real task write, so
    // the retry observes an in-flight effect independent of hash timing.
    let release!: () => void
    let reached!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const effectReached = new Promise<void>(resolve => { reached = resolve })
    env = { ...env, BUS: { send: async () => { reached(); await held } } } as unknown as Env
    const first = post(envelope('task: once'))
    await effectReached
    try {
      const conflict = await post(envelope('task: once'))
      expect(conflict.status).toBe(409)
      expect(await conflict.json()).toEqual({ error: 'update_in_progress' })
    } finally { release() }
    expect((await first).status).toBe(200)
    expect(harness.sqlite.prepare('SELECT title FROM tasks').all()).toEqual([{ title: 'once' }])
    expect(receipt()).toHaveLength(1)
    expect(receipt()[0]).toMatchObject({ telegram_user_id: '123', state: 'completed' })
  })

  it('never resolves a member mapping from another tenant', async () => {
    member()
    harness.sqlite.exec("UPDATE members SET tenant = 'another-tenant'")
    const before = businessState()
    const response = await post(envelope('task: forbidden'))
    expect((await response.json() as { reply: string }).reply).toMatch(/not registered/)
    expect(businessState()).toEqual(before)
  })

  it('records one authorized verdict and refuses forwarding, revocation and conflicting or terminal decisions', async () => {
    member()
    harness.sqlite.exec(`
      INSERT INTO tasks (id, squad_id, project_id, title, done_when, status, gate_owner)
      VALUES ('task-verdict', 'squad-1', 'project-1', 'Decision', 'done', 'review', 'gate:human');
      INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
      VALUES ('human-gate', 'gate:human', 'member', 'human-1', 'test', datetime('now'));
    `)
    const before = businessState()
    const forwarded = envelope('/approve task-verdict')
    await post({ ...forwarded, message: { ...forwarded.message, forward_date: 1 } })
    expect(businessState()).toEqual(before)
    const first = await (await post(envelope('/approve task-verdict', 11))).json()
    expect(first).toMatchObject({ reply: 'Approved "Decision".' })
    const decided = businessState()
    expect(await (await post(envelope('/approve task-verdict', 11))).json()).toEqual(first)
    expect((await post(envelope('/reject task-verdict changed', 11))).status).toBe(409)
    await post(envelope('/reject task-verdict changed', 12))
    await post(envelope('/approve task-verdict', 13))
    expect(businessState()).toEqual(decided)
    expect(harness.sqlite.prepare('SELECT decided_by, verdict FROM task_verdicts').all())
      .toEqual([{ decided_by: 'human-1', verdict: 'approved' }])
    harness.sqlite.exec(`DELETE FROM gate_grants;
      INSERT INTO tasks (id, squad_id, title, done_when, status, gate_owner)
      VALUES ('task-revoked', 'squad-1', 'Another decision', 'done', 'review', 'gate:human');`)
    const revoked = businessState()
    const reply = (await (await post(envelope('/approve task-revoked', 14))).json() as { reply: string }).reply
    expect(reply).toMatch(/permission/)
    expect(businessState()).toEqual(revoked)
  })

  it('canonicalizes identity numbers and ignores untrusted extra metadata on retry', async () => {
    member()
    const first = await (await post(envelope('/status'))).json()
    const stored = receipt()
    const retry = { update_id: '10', message: { text: '/status', from: { id: '123', username: 'changed' }, chat: { type: 'private', id: '123' } }, member_id: 'forged' }
    expect(await (await post(retry)).json()).toEqual(first)
    expect(receipt()).toEqual(stored)
  })

  it('conflicting text, principal or forwarding metadata cannot overwrite a receipt or cause effects', async () => {
    member()
    await post(envelope('task: original'))
    const stored = receipt()
    const before = businessState()
    for (const body of [envelope('task: changed'), envelope('task: original', 10, 456),
      { ...envelope('task: original'), message: { ...envelope('task: original').message, forward_origin: { type: 'user' } } }]) {
      const response = await post(body)
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'update_conflict' })
    }
    expect(receipt()).toEqual(stored)
    expect(businessState()).toEqual(before)
  })

  it.each(['processing', 'unknown'])('does not retry effects after interrupted %s reservation', async state => {
    member()
    await post(envelope('task: original'))
    harness.sqlite.prepare('UPDATE telegram_webhook_receipts SET state = ?, response_text = NULL, completed_at = NULL').run(state)
    const stored = receipt()
    const before = businessState()
    const response = await post(envelope('task: original'))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'update_in_progress' })
    expect(businessState()).toEqual(before)
    expect(receipt()).toEqual(stored)
  })

  it('joins before member lookup with tokenless membership and identical replay', async () => {
    const code = await invite()
    const request = envelope(`/start ${code}`)
    const response = await post(request)
    const body = await response.json() as { reply: string }
    expect(body.reply).toMatch(/joined.*project-1/i)
    expect(harness.sqlite.prepare('SELECT telegram_chat_id, status FROM members').all()).toEqual([{ telegram_chat_id: '123', status: 'active' }])
    expect(harness.sqlite.prepare('SELECT scope_type, scope_id, capability FROM capabilities').all()).toEqual([{ scope_type: 'squad', scope_id: 'squad-1', capability: 'member' }])
    expect(harness.sqlite.prepare('SELECT * FROM member_tokens').all()).toEqual([])
    const before = businessState()
    const stored = receipt()
    expect(await (await post(request)).json()).toEqual(body)
    expect(businessState()).toEqual(before)
    expect(receipt()).toEqual(stored)
  })

  it('carries authenticated receipt identity into redemption and refuses another user without any writes', async () => {
    const code = await invite()
    await post(envelope(`/start ${code}`))
    const stored = receipt()
    expect(stored).toHaveLength(1)
    const before = businessState()
    const common = { pairing_code: code, display_name: 'Human', update_id: '10', request_digest: String(stored[0].request_digest) }
    expect(await redeemTelegramProjectInvite(env, { ...common, telegram_user_id: '456' })).toEqual({ ok: false, error: 'update_receipt_invalid' })
    expect(businessState()).toEqual(before)
    expect(receipt()).toEqual(stored)
    expect(await redeemTelegramProjectInvite(env, { ...common, telegram_user_id: '123' })).toMatchObject({ ok: true, value: { project_id: 'project-1' } })
    expect(businessState()).toEqual(before)
    expect(receipt()).toEqual(stored)
  })

  it.each(['forward_origin', 'forward_from', 'forward_from_chat', 'forward_date'])('refuses a forwarded invite marked by %s', async marker => {
    const code = await invite()
    const before = businessState()
    const body = envelope(`/start ${code}`)
    const response = await post({ ...body, message: { ...body.message, [marker]: null } })
    expect((await response.json() as { reply: string }).reply).toMatch(/direct.*forward/i)
    expect(businessState()).toEqual(before)
    expect(receipt()).toHaveLength(1)
  })

  it('renders only accessible Needs You items and server-allowed actions as roles change', async () => {
    member('observer')
    harness.sqlite.exec(`INSERT INTO tasks (id, squad_id, project_id, title, done_when, status, gate_owner)
      VALUES ('task-visible', 'squad-1', 'project-1', 'Public decision', 'done', 'review', 'gate:human'),
             ('task-hidden', 'squad-2', 'project-2', 'Private secret', 'done', 'review', 'gate:human');`)
    const observer = (await (await post(envelope('/needs'))).json() as { reply: string }).reply
    expect(observer).toContain('Public decision')
    expect(observer).not.toContain('Private secret')
    expect(observer).not.toContain('/approve')
    expect(observer).not.toContain('/reject')
    harness.sqlite.exec(`UPDATE capabilities SET capability = 'member';
      INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
      VALUES ('human-gate', 'gate:human', 'member', 'human-1', 'test', datetime('now'));`)
    const decider = (await (await post(envelope('/needs project-1', 11))).json() as { reply: string }).reply
    expect(decider).toContain('/approve task-visible')
    expect(decider).toContain('/reject task-visible')
    const hidden = (await (await post(envelope('/needs project-2', 12))).json() as { reply: string }).reply
    expect(hidden).not.toContain('Private secret')
    harness.sqlite.exec('DELETE FROM capabilities')
    expect((await (await post(envelope('/needs', 13))).json() as { reply: string }).reply).not.toContain('Public decision')
  })

  it('keeps Needs You deliverable as one Telegram message and signals omitted items', async () => {
    member('observer')
    for (let index = 0; index < 10; index++) {
      harness.sqlite.prepare(`INSERT INTO tasks (id, squad_id, project_id, title, done_when, status, gate_owner)
        VALUES (?, 'squad-1', 'project-1', ?, 'done', 'review', 'gate:human')`)
        .run(`long-task-${index}`, `Decision ${index}: ${'detail '.repeat(80)}`)
    }
    const response = await post(envelope('/needs'))
    const reply = (await response.json() as { reply: string }).reply
    expect(reply.length).toBeLessThanOrEqual(4096)
    expect(reply).toMatch(/more.*dashboard/i)
  })

  it.each(['suspended', 'revoked'])('refuses task effects for %s membership', async status => {
    member()
    if (status === 'suspended') harness.sqlite.exec("UPDATE members SET status = 'suspended'")
    else harness.sqlite.exec('DELETE FROM capabilities')
    const before = businessState()
    await post(envelope('task: forbidden @core'))
    expect(businessState()).toEqual(before)
    expect(receipt()[0]).toMatchObject({ state: 'completed' })
  })
})
