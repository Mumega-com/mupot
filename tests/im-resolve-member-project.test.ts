// tests/im-resolve-member-project.test.ts — mupot-plugin PR #19 v2 contract
// (FP-01 Slice 2 v2, successor to PR #1488's adversarial P1-7 + Athena's
// design ruling "resolve-project fence = ENVELOPE IDENTITY, not a token"):
// POST /im/resolve-project turns a member's own free-text project reference
// into a real project id, using the BOUND MEMBER's own readable-project
// standing (never Mubot's). Identity comes from the SAME authenticated
// Telegram envelope /webhook verifies — message.from.id / message.chat.id,
// private chat, from.id === chat.id — never a bare `chat_id` (or
// `member_id`) body field, which PR #1488 shipped and the adversarial gate
// proved was not a fence at all: any secret holder could pick ANY member's
// identity by varying that field.
//
// Real SQLite D1 (createSqliteD1 + applyAllMigrations), the actual imApp
// route (not resolveMemberProjects called directly), same harness shape as
// tests/im-webhook-idempotency.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { imApp } from '../src/im'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const SECRET = 'test-telegram-webhook-secret'
const app = new Hono<{ Bindings: Env }>().route('/im', imApp)

describe('POST /im/resolve-project', () => {
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
        ('project-1', 'psychonom', 'Psychonom', 'active'),
        ('project-2', 'private-project', 'Private Project', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
        ('project-1', 'squad-1', 'write'), ('project-2', 'squad-2', 'write');
      INSERT INTO members (id, email, display_name, telegram_chat_id, status, tenant)
        VALUES ('human-1', 'human@example.com', 'Shadi', '123', 'active', 'telegram-test');
      INSERT INTO members (id, email, display_name, telegram_chat_id, status, tenant)
        VALUES ('human-2', 'human2@example.com', 'Bardia', '999', 'active', 'telegram-test');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-human-1', 'human-1', 'squad', 'squad-1', 'member');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-human-2', 'human-2', 'squad', 'squad-2', 'member');
    `)
  })

  afterEach(() => harness.close())

  // envelope() mirrors /webhook's own TelegramUpdate shape — the plugin v2
  // contract (mupot-plugin PR #19) sends this SAME shape to /resolve-project.
  // update_id auto-increments per call (P1-b, FP-01 Slice 2 v2 round 2):
  // update_id is now RESERVED (telegram_webhook_receipts, namespaced
  // 'resolve-project:<id>') exactly like /webhook's own update_id — reusing
  // a fixed literal across every call in a multi-call test would make every
  // call AFTER the first a replay of the FIRST, silently returning its
  // cached response instead of exercising a fresh request. Tests that need
  // a SPECIFIC repeated update_id (the replay tests themselves) pass one
  // explicitly via `overrides`.
  let nextUpdateId = 1
  function envelope(userId: number, chatId: number, query: string, overrides: Record<string, unknown> = {}) {
    return {
      update_id: nextUpdateId++,
      message: { from: { id: userId }, chat: { id: chatId, type: 'private' }, text: '' },
      query,
      ...overrides,
    }
  }

  function post(body: unknown, secret = SECRET) {
    return app.fetch(new Request('https://pot.test/im/resolve-project', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify(body),
    }), env)
  }

  it('resolves the member\'s OWN readable project by name, bounded to <=5 candidates', async () => {
    const res = await post(envelope(123, 123, 'Psychonom'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      bound: true, member_id: 'human-1',
      projects: [{ id: 'project-1', slug: 'psychonom', name: 'Psychonom' }],
    })
  })

  it('resolves by exact slug too', async () => {
    const res = await post(envelope(123, 123, 'psychonom'))
    const body = await res.json() as { projects: unknown[] }
    expect(body.projects).toHaveLength(1)
  })

  it('a real but non-readable project name returns EMPTY, identical to a name that does not exist at all (no-oracle)', async () => {
    const nonReadable = await (await post(envelope(123, 123, 'Private Project'))).json()
    const nonExistent = await (await post(envelope(123, 123, 'Totally Made Up Project Name'))).json()
    expect(nonReadable).toEqual({ bound: true, member_id: 'human-1', projects: [] })
    expect(nonExistent).toEqual({ bound: true, member_id: 'human-1', projects: [] })
  })

  it('an unbound chat gets bound:false and an empty result, never a member/project oracle', async () => {
    const res = await post(envelope(999999999, 999999999, 'Psychonom'))
    expect(await res.json()).toEqual({ bound: false, member_id: null, projects: [] })
  })

  it('Mubot\'s floor allows calling this route: only the shared webhook secret gates it, no MCP capability floor', async () => {
    // A caller shaped like Mubot's own low-privilege agent seat has NO MCP
    // capability at all in this request — the route accepts the shared
    // secret alone (same auth as /webhook) and answers using the BOUND
    // MEMBER's standing, not any capability the caller itself would need.
    const res = await post(envelope(123, 123, 'Psychonom'))
    expect(res.status).toBe(200)
    const body = await res.json() as { projects: unknown[] }
    expect(body.projects).toHaveLength(1)
  })

  it('refuses the wrong secret and requires a query', async () => {
    expect((await post(envelope(123, 123, 'Psychonom'), 'wrong')).status).toBe(401)
    expect((await post(envelope(123, 123, ''))).status).toBe(400)
    expect((await post({ update_id: 1, message: { from: { id: 123 }, chat: { id: 123, type: 'private' }, text: '' } })).status).toBe(400)
  })

  // ── Athena's design ruling: envelope identity, not a token ────────────────
  it('P1-7 CLOSED: a bare top-level chat_id in the body is NEVER consulted and cannot select a different member', async () => {
    // The exact PoE the adversarial gate ran against PR #1488: one secret,
    // two body "identities". A body-level `chat_id` field alongside a real
    // envelope for a DIFFERENT member must have NO effect — the member is
    // derived exclusively from message.from.id / message.chat.id.
    const res = await post({
      ...envelope(123, 123, 'Private Project'),
      chat_id: 999, // human-2's chat id — must be ignored entirely
    })
    const body = await res.json() as { bound: boolean; member_id: string | null; projects: unknown[] }
    // Still resolved as human-1 (from the envelope), and human-1 cannot read
    // project-2 — never human-2's identity or their private project.
    expect(body).toEqual({ bound: true, member_id: 'human-1', projects: [] })
  })

  it('P1-7 CLOSED: a bare top-level member_id in the body is NEVER consulted', async () => {
    const res = await post({
      ...envelope(123, 123, 'Psychonom'),
      member_id: 'human-2',
    })
    const body = await res.json() as { member_id: string | null }
    expect(body.member_id).toBe('human-1')
  })

  it('refuses a non-private chat, matching /webhook\'s own fence', async () => {
    const res = await post(envelope(123, 123, 'Psychonom', { message: { from: { id: 123 }, chat: { id: 123, type: 'group' }, text: '' } }))
    expect(res.status).toBe(400)
  })

  it('refuses userId !== chatId, matching /webhook\'s own fence', async () => {
    // from.id (123, a real bound member) differs from chat.id (999) — this
    // must refuse, never silently pick either id as "the" identity.
    const res = await post(envelope(123, 999, 'Psychonom'))
    expect(res.status).toBe(400)
  })

  // ── P1-b (FP-01 Slice 2 v2 round 2): update_id is REQUIRED and RESERVED ──
  it('P1-b: missing update_id refuses with 400', async () => {
    const body = envelope(123, 123, 'Psychonom') as Record<string, unknown>
    delete body.update_id
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'no_update_id' })
  })

  it('P1-b: replaying the IDENTICAL request (same update_id, same everything) returns the SAME stored response, never a second execution', async () => {
    const request = envelope(123, 123, 'Psychonom')
    const first = await (await post(request)).json()
    const second = await (await post(request)).json()
    expect(second).toEqual(first)
    // Exactly one reservation row for this update_id — a replay never mints a second.
    expect(harness.sqlite.prepare(
      "SELECT COUNT(*) AS n FROM telegram_webhook_receipts WHERE update_id = ?",
    ).get(`resolve-project:${request.update_id}`)).toEqual({ n: 1 })
  })

  it('P1-b: reusing the SAME update_id with a DIFFERENT query is REFUSED (409 update_conflict), never silently re-processed', async () => {
    const updateId = nextUpdateId++
    const first = await (await post(envelope(123, 123, 'Psychonom', { update_id: updateId }))).json() as { projects: unknown[] }
    expect(first.projects).toHaveLength(1)
    // Same update_id, a DIFFERENT query — the digest no longer matches the
    // reserved receipt's own digest, so reserveTelegramUpdate refuses this
    // as 'update_conflict' rather than either replaying the first result OR
    // actually running the second query — the exact unbounded-oracle class
    // this fix closes: a caller cannot mint one update_id and vary the
    // query underneath it to probe multiple things "for free".
    const secondRes = await post(envelope(123, 123, 'zzz-nonexistent-query', { update_id: updateId }))
    expect(secondRes.status).toBe(409)
    expect(await secondRes.json()).toEqual({ error: 'update_conflict' })
  })

  it('P1-b: a DIFFERENT update_id for the SAME query is a genuinely fresh request, not a replay', async () => {
    const a = await (await post(envelope(123, 123, 'Psychonom'))).json()
    const b = await (await post(envelope(123, 123, 'Psychonom'))).json()
    expect(a).toEqual(b) // same content, but...
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM telegram_webhook_receipts').get())
      .toEqual({ n: 2 }) // ...two independent reservations, not one replayed.
  })

  it('P1-b: /resolve-project\'s reservation is namespaced separately from /webhook\'s own update_id space', async () => {
    // The plugin may legitimately reuse the SAME Telegram update_id for both
    // a /webhook call and a /resolve-project call over the same inbound
    // update — they must not collide.
    const shared = nextUpdateId++
    const webhookRes = await app.fetch(new Request('https://pot.test/im/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET },
      body: JSON.stringify({ update_id: shared, message: { chat: { id: 123, type: 'private' }, from: { id: 123 }, text: '/help' } }),
    }), env)
    expect(webhookRes.status).toBe(200)
    const resolveRes = await post(envelope(123, 123, 'Psychonom', { update_id: shared }))
    expect(resolveRes.status).toBe(200)
    const body = await resolveRes.json() as { projects: unknown[] }
    expect(body.projects).toHaveLength(1)
  })
})
