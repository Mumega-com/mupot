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
      expect(validateSecretToken('my-secret-token', 'my-secret-token')).toBe(true)
      expect(validateSecretToken('wrong-token', 'my-secret-token')).toBe(false)
      expect(validateSecretToken(null, 'my-secret-token')).toBe(false)
      expect(validateSecretToken(null, undefined)).toBe(true) // Dev mode fallback
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
      expect(emittedEvent.actor).toEqual({ kind: 'member', id: 'telegram:servathadi' })
      expect((emittedEvent.payload as any).chat_id).toBe(765204057)
      expect((emittedEvent.payload as any).text).toBe('@River_mumega_bot execute flight build')
    })

    it('returns 500 status when env.BUS emit throws, preventing false green responses (Kasra Fix b)', async () => {
      const mockBusSend = vi.fn().mockRejectedValue(new Error('Queue connection failure'))
      const mockEnv = {
        TELEGRAM_WEBHOOK_SECRET: 'correct-secret',
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
