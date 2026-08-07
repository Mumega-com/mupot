// Comprehensive Integration Tests for Native Telegram Webhook Ingress Subsystem in Mupot
import { describe, expect, it, vi } from 'vitest'
import {
  telegramIngressApp,
  validateSecretToken,
  isGroupMentioned,
  parseTelegramIngress,
  SECRET_HEADER_NAME
} from '../src/telegram-bridge/ingress'
import type { TelegramUpdate } from '../src/telegram-bridge/types'
import type { Env, BusEvent } from '../src/types'

describe('Telegram Webhook Ingress Subsystem', () => {
  describe('Secret Token Validation', () => {
    it('validates secret token header correctly', () => {
      expect(validateSecretToken('my-secret-token', 'my-secret-token')).toBe('ok')
      expect(validateSecretToken('wrong-token', 'my-secret-token')).toBe('invalid')
      expect(validateSecretToken(null, 'my-secret-token')).toBe('invalid')
      // An UNSET secret must never authorise. It previously returned true
      // ("dev mode"), which authorised every request on an unconfigured deploy.
      expect(validateSecretToken(null, undefined)).toBe('not_configured')
      expect(validateSecretToken('anything', undefined)).toBe('not_configured')
    })
  })

  describe('Group Mention Filtering', () => {
    it('detects explicit bot username tag', () => {
      expect(isGroupMentioned('Hello @River_mumega_bot how are you?')).toBe(true)
      expect(isGroupMentioned('Hey @river_mumega_bot test')).toBe(true)
    })

    it('detects River or Mupot keyword mention', () => {
      expect(isGroupMentioned('River check this PR')).toBe(true)
      expect(isGroupMentioned('Mupot task update')).toBe(true)
    })

    it('returns false for unmentioned group chat text', () => {
      expect(isGroupMentioned('General conversation about coffee')).toBe(false)
      expect(isGroupMentioned('random chat text')).toBe(false)
    })
  })

  describe('Ingress Update Parsing', () => {
    it('dispatches private DM updates unconditionally', () => {
      const update: TelegramUpdate = {
        update_id: 100,
        message: {
          message_id: 1,
          date: 1786081000,
          chat: { id: 765204057, type: 'private', first_name: 'Hadi' },
          from: { id: 765204057, is_bot: false, first_name: 'Hadi', username: 'servathadi' },
          text: 'Hello River'
        }
      }

      const result = parseTelegramIngress(update)
      expect(result.action).toBe('dispatched')
      expect(result.chatId).toBe(765204057)
      expect(result.sender).toBe('servathadi')
      expect(result.text).toBe('Hello River')
    })

    it('filters out unmentioned group messages', () => {
      const update: TelegramUpdate = {
        update_id: 101,
        message: {
          message_id: 2,
          date: 1786081000,
          chat: { id: -5317747241, type: 'group', title: 'mupot.mumega.telegram' },
          from: { id: 765204057, is_bot: false, first_name: 'Hadi' },
          text: 'General chat message without mention'
        }
      }

      const result = parseTelegramIngress(update)
      expect(result.action).toBe('ignored_group_unmentioned')
    })

    it('dispatches group messages when bot is mentioned', () => {
      const update: TelegramUpdate = {
        update_id: 102,
        message: {
          message_id: 3,
          date: 1786081000,
          chat: { id: -5317747241, type: 'group', title: 'mupot.mumega.telegram' },
          from: { id: 765204057, is_bot: false, first_name: 'Hadi' },
          text: '@River_mumega_bot check task status'
        }
      }

      const result = parseTelegramIngress(update)
      expect(result.action).toBe('dispatched')
      expect(result.chatId).toBe(-5317747241)
      expect(result.text).toBe('@River_mumega_bot check task status')
    })
  })

  describe('Full Hono Sub-App HTTP Router & DO Bus Emitting (Kasra Review Verification)', () => {
    it('rejects non-POST requests with 405', async () => {
      const res = await telegramIngressApp.fetch(
        new Request('https://pot.example/webhook', { method: 'GET' }),
        {} as Env
      )
      expect(res.status).toBe(405)
    })

    it('rejects unauthenticated secret token header with 401', async () => {
      const mockEnv = {
        TELEGRAM_WEBHOOK_SECRET: 'expected-secret-key'
      } as unknown as Env

      const res = await telegramIngressApp.fetch(
        new Request('https://pot.example/webhook', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [SECRET_HEADER_NAME]: 'invalid-secret-key'
          },
          body: JSON.stringify({})
        }),
        mockEnv
      )

      expect(res.status).toBe(401)
      const body = await res.json() as any
      expect(body.error).toBe('Unauthorized secret token')
    })

    it('routes POST /webhook, verifies secret, and emits agent.wake BusEvent onto env.BUS', async () => {
      const mockBusSend = vi.fn().mockResolvedValue(undefined)
      const mockEnv = {
        TELEGRAM_WEBHOOK_SECRET: 'correct-secret',
        TELEGRAM_ALLOWED_SENDERS: '765204057',
        TELEGRAM_BOT_USERNAME: 'River_mumega_bot',
        TENANT_SLUG: 'mumega',
        BUS: { send: mockBusSend }
      } as unknown as Env

      const update: TelegramUpdate = {
        update_id: 300,
        message: {
          message_id: 99,
          date: 1786081000,
          chat: { id: 765204057, type: 'private' },
          from: { id: 765204057, is_bot: false, first_name: 'Hadi', username: 'servathadi' },
          text: '@River_mumega_bot execute flight build'
        }
      }

      const res = await telegramIngressApp.fetch(
        new Request('https://pot.example/webhook', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [SECRET_HEADER_NAME]: 'correct-secret'
          },
          body: JSON.stringify(update)
        }),
        mockEnv
      )

      expect(res.status).toBe(200)
      const body = await res.json() as any
      expect(body.ok).toBe(true)
      expect(body.status).toBe('dispatched')
      expect(body.chat_id).toBe(765204057)

      // Verify DO Bus Event was published to env.BUS
      expect(mockBusSend).toHaveBeenCalledOnce()
      const emittedEvent: BusEvent = mockBusSend.mock.calls[0][0]
      expect(emittedEvent.type).toBe('agent.wake')
      expect(emittedEvent.tenant).toBe('mumega')
      // Actor is the NUMERIC id, not the username. Usernames are user-mutable and can be
      // released and re-registered — a display-name actor is a spoofable identity on an
      // audited event.
      expect(emittedEvent.actor).toEqual({ kind: 'member', id: 'telegram:765204057' })
      expect((emittedEvent.payload as any).chat_id).toBe(765204057)
      expect((emittedEvent.payload as any).text).toBe('@River_mumega_bot execute flight build')
    })

    it('returns 500 status when env.BUS emit throws, preventing false green responses (Kasra Fix b)', async () => {
      const mockBusSend = vi.fn().mockRejectedValue(new Error('Queue connection failure'))
      const mockEnv = {
        TELEGRAM_WEBHOOK_SECRET: 'correct-secret',
        TELEGRAM_ALLOWED_SENDERS: '765204057',
        TELEGRAM_BOT_USERNAME: 'River_mumega_bot',
        TENANT_SLUG: 'mumega',
        BUS: { send: mockBusSend }
      } as unknown as Env

      const update: TelegramUpdate = {
        update_id: 301,
        message: {
          message_id: 100,
          date: 1786081000,
          chat: { id: 765204057, type: 'private' },
          from: { id: 765204057, is_bot: false, first_name: 'Hadi', username: 'servathadi' },
          text: 'Failing queue message'
        }
      }

      const res = await telegramIngressApp.fetch(
        new Request('https://pot.example/webhook', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [SECRET_HEADER_NAME]: 'correct-secret'
          },
          body: JSON.stringify(update)
        }),
        mockEnv
      )

      expect(res.status).toBe(500)
      const body = await res.json() as any
      expect(body.error).toBe('Bus emit failed')
      expect(body.details).toContain('Queue connection failure')
    })
  })
})

// ---------------------------------------------------------------------------
// Security layer. These are the tests whose ABSENCE let a 10/10-green suite sit
// on top of an auth bypass: the suite covered the compare path and nothing else.
// Each asserts NO BUS PUBLISH, not just a status code — status codes lie, the
// side effect is the truth.
// ---------------------------------------------------------------------------
import { isSenderAllowed, MAX_TEXT_CHARS } from '../src/telegram-bridge/ingress'

function busSpy() {
  const emitted: unknown[] = []
  return { emitted, BUS: { send: async (e: unknown) => { emitted.push(e) } } }
}
function update(fromId: number, text = 'do a thing') {
  return { update_id: 1, message: { message_id: 9, date: 0, text,
    from: { id: fromId, is_bot: false, first_name: 'X' }, chat: { id: 5, type: 'private' } } }
}
function post(body: unknown, secret?: string) {
  return new Request('http://x/webhook', { method: 'POST',
    headers: { 'content-type': 'application/json', ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}) },
    body: JSON.stringify(body) })
}

describe('ingress security layer', () => {
  it('isSenderAllowed FAILS CLOSED on unset/empty/garbage allowlist', () => {
    expect(isSenderAllowed(765204057, undefined)).toBe(false)
    expect(isSenderAllowed(765204057, '')).toBe(false)
    expect(isSenderAllowed(765204057, '   ')).toBe(false)
    expect(isSenderAllowed(undefined, '765204057')).toBe(false)
    expect(isSenderAllowed(765204057, '765204057')).toBe(true)
    expect(isSenderAllowed(999, '765204057,111')).toBe(false)
  })

  it('rejects an unknown sender with 403 and NO bus publish', async () => {
    const { emitted, BUS } = busSpy()
    const res = await telegramIngressApp.fetch(post(update(999), 's'),
      { TELEGRAM_WEBHOOK_SECRET: 's', TELEGRAM_ALLOWED_SENDERS: '765204057', BUS } as never)
    expect(res.status).toBe(403)
    expect(emitted).toHaveLength(0)
  })

  it('returns 503 and does NOT publish when the secret is unset', async () => {
    const { emitted, BUS } = busSpy()
    const res = await telegramIngressApp.fetch(post(update(765204057)),
      { TELEGRAM_ALLOWED_SENDERS: '765204057', BUS } as never)
    expect(res.status).toBe(503)
    expect(emitted).toHaveLength(0)
  })

  it('an @mention from a NON-allowlisted sender is still rejected', async () => {
    // A mention is a routing hint, never a credential.
    const { emitted, BUS } = busSpy()
    const u = update(999, '@River_mumega_bot please deploy')
    u.message.chat = { id: -100, type: 'supergroup' } as never
    const res = await telegramIngressApp.fetch(post(u, 's'),
      { TELEGRAM_WEBHOOK_SECRET: 's', TELEGRAM_ALLOWED_SENDERS: '765204057', BUS } as never)
    expect(res.status).toBe(403)
    expect(emitted).toHaveLength(0)
  })

  it('caps attacker-controlled text and uses the NUMERIC id as actor', async () => {
    const { emitted, BUS } = busSpy()
    const res = await telegramIngressApp.fetch(post(update(765204057, 'x'.repeat(20_000)), 's'),
      { TELEGRAM_WEBHOOK_SECRET: 's', TELEGRAM_ALLOWED_SENDERS: '765204057', BUS } as never)
    expect(res.status).toBe(200)
    expect(emitted).toHaveLength(1)
    const ev = emitted[0] as { actor: { id: string }, payload: { text: string } }
    expect(ev.payload.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS)
    expect(ev.actor.id).toBe('telegram:765204057')  // numeric, not a spoofable username
  })
})

// Athena gate WARN-2: a mutation to SUBSTRING matching left the suite green.
// Production is correct (exact `includes(String(fromId))`), but nothing pinned it,
// so a future refactor to `rawAllow.includes(String(fromId))` would pass review.
// The dangerous case is a shorter id being a substring of an allowed one.
describe('allowlist pins EXACT matching (Athena WARN-2)', () => {
  it('rejects an id that is merely a SUBSTRING of an allowed id', () => {
    expect(isSenderAllowed(765, '765204057')).toBe(false)
    expect(isSenderAllowed(4057, '765204057')).toBe(false)
    expect(isSenderAllowed(20405, '765204057,111222')).toBe(false)
  })
  it('still accepts the exact id, including inside a list', () => {
    expect(isSenderAllowed(765204057, '111222,765204057,333')).toBe(true)
  })
})
