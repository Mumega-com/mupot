// Channel identity resolution — the authorisation seam for every IM platform.
//
// These assert the SIDE EFFECT (no bus publish) rather than the status code, because
// tonight's most expensive defects all reported the right code while doing the wrong
// thing. A status assertion would have passed on every one of them.

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  resolveChannelIdentity, mayDispatch, refusalCode, isChannelPlatform, CHANNEL_PLATFORMS,
} from '../src/channels/identity'
import { telegramIngressApp } from '../src/telegram-bridge/ingress'
import type { Env } from '../src/types'

/** D1 stub. `rows` maps the bound platform_user_id to a row; `boom` forces a failure. */
function db(rows: Record<string, unknown> = {}, boom = false) {
  return {
    prepare: () => ({
      bind: (_t: unknown, _p: unknown, id: unknown) => ({
        first: async () => {
          if (boom) throw new Error('D1_ERROR: no such table')
          return rows[String(id)] ?? null
        },
      }),
    }),
  }
}
const env = (o: Record<string, unknown> = {}) =>
  ({ TENANT_SLUG: 'mumega', DB: db(), ...o }) as unknown as Env

afterEach(() => vi.unstubAllGlobals())

describe('resolveChannelIdentity', () => {
  it('resolves a bound caller to a member', async () => {
    const e = env({ DB: db({ '765204057': { member_id: 'mem-hadi', bound_method: 'admin', revoked_at: null } }) })
    const r = await resolveChannelIdentity(e, 'telegram', 765204057)
    expect(r).toEqual({ kind: 'member', memberId: 'mem-hadi', boundMethod: 'admin' })
    expect(mayDispatch(r)).toBe(true)
  })

  it('an UNBOUND caller does not resolve', async () => {
    const r = await resolveChannelIdentity(env(), 'telegram', 999)
    expect(r.kind).toBe('unbound')
    expect(mayDispatch(r)).toBe(false)
  })

  it('a REVOKED binding does not resolve, and is distinguishable from unbound', async () => {
    const e = env({ DB: db({ '5': { member_id: 'mem-x', bound_method: 'admin', revoked_at: '2026-08-07T00:00:00Z' } }) })
    const r = await resolveChannelIdentity(e, 'telegram', 5)
    expect(r.kind).toBe('revoked')
    expect(mayDispatch(r)).toBe(false)
    expect(refusalCode(r)).toBe('identity_revoked')
  })

  it('a DB FAILURE is unavailable — never unbound, never permitted', async () => {
    // The critical one. If an outage read as "stranger", the outage would look like
    // normal operation and nobody would investigate it.
    const r = await resolveChannelIdentity(env({ DB: db({}, true) }), 'telegram', 765204057)
    expect(r.kind).toBe('unavailable')
    expect(mayDispatch(r)).toBe(false)
  })

  it('a corrupt binding row (no member) is unavailable, not permitted', async () => {
    const e = env({ DB: db({ '7': { member_id: '', bound_method: 'admin', revoked_at: null } }) })
    expect((await resolveChannelIdentity(e, 'telegram', 7)).kind).toBe('unavailable')
  })

  it('an unknown platform is refused, not looked up', async () => {
    const r = await resolveChannelIdentity(env(), 'carrier_pigeon', 1)
    expect(r.kind).toBe('unavailable')
    expect(mayDispatch(r)).toBe(false)
  })

  it('missing / empty / whitespace caller ids never resolve', async () => {
    const e = env({ DB: db({ '': { member_id: 'mem-ghost', bound_method: 'admin', revoked_at: null } }) })
    for (const v of [undefined, null, '', '   ']) {
      expect(mayDispatch(await resolveChannelIdentity(e, 'telegram', v as never))).toBe(false)
    }
  })

  it('is platform-agnostic — the same seam serves every adapter', async () => {
    for (const p of CHANNEL_PLATFORMS) {
      expect(isChannelPlatform(p)).toBe(true)
      const e = env({ DB: db({ 'u1': { member_id: `mem-${p}`, bound_method: 'admin', revoked_at: null } }) })
      const r = await resolveChannelIdentity(e, p, 'u1')
      expect(mayDispatch(r) && r.memberId).toBe(`mem-${p}`)
    }
  })
})

describe('telegram ingress carries CALLER authority', () => {
  const bus = () => { const sent: unknown[] = []; return { sent, BUS: { send: async (e: unknown) => { sent.push(e) } } } }
  const post = (fromId: number, secret = 's') =>
    new Request('http://x/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
      body: JSON.stringify({ update_id: 1, message: { message_id: 1, date: 0, text: 'do a thing',
        from: { id: fromId, is_bot: false, first_name: 'X' }, chat: { id: 1, type: 'private' } } }),
    })

  it('publishes with the MEMBER as actor — not the bot, not a username', async () => {
    const { sent, BUS } = bus()
    const res = await telegramIngressApp.fetch(post(765204057), {
      TENANT_SLUG: 'mumega', TELEGRAM_WEBHOOK_SECRET: 's', BUS,
      DB: db({ '765204057': { member_id: 'mem-hadi', bound_method: 'admin', revoked_at: null } }),
    } as never)
    expect(res.status).toBe(200)
    expect(sent).toHaveLength(1)
    expect((sent[0] as { actor: { id: string } }).actor.id).toBe('mem-hadi')
  })

  it('TWO different callers dispatch as TWO different members — the whole point', async () => {
    const rows = {
      '765204057': { member_id: 'mem-hadi', bound_method: 'admin', revoked_at: null },
      '111222333': { member_id: 'mem-gavin', bound_method: 'verified_login', revoked_at: null },
    }
    const seen: string[] = []
    for (const id of [765204057, 111222333]) {
      const { sent, BUS } = bus()
      await telegramIngressApp.fetch(post(id), {
        TENANT_SLUG: 'mumega', TELEGRAM_WEBHOOK_SECRET: 's', BUS, DB: db(rows),
      } as never)
      seen.push((sent[0] as { actor: { id: string } }).actor.id)
    }
    expect(seen).toEqual(['mem-hadi', 'mem-gavin'])
  })

  it('an UNBOUND caller gets 403 and NO bus publish', async () => {
    const { sent, BUS } = bus()
    const res = await telegramIngressApp.fetch(post(999), {
      TENANT_SLUG: 'mumega', TELEGRAM_WEBHOOK_SECRET: 's', BUS, DB: db(),
    } as never)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'identity_not_bound' })
    expect(sent).toHaveLength(0)
  })

  it('a DB outage gets 503 and NO bus publish — distinct from a stranger', async () => {
    const { sent, BUS } = bus()
    const res = await telegramIngressApp.fetch(post(765204057), {
      TENANT_SLUG: 'mumega', TELEGRAM_WEBHOOK_SECRET: 's', BUS, DB: db({}, true),
    } as never)
    expect(res.status).toBe(503)
    expect(sent).toHaveLength(0)
  })

  it('a stale TELEGRAM_ALLOWED_SENDERS can no longer widen access', async () => {
    // The retired allowlist must be inert. If it still granted, deleting a binding
    // would not actually revoke anyone.
    const { sent, BUS } = bus()
    const res = await telegramIngressApp.fetch(post(999), {
      TENANT_SLUG: 'mumega', TELEGRAM_WEBHOOK_SECRET: 's', BUS, DB: db(),
      TELEGRAM_ALLOWED_SENDERS: '999',
    } as never)
    expect(res.status).toBe(403)
    expect(sent).toHaveLength(0)
  })
})
