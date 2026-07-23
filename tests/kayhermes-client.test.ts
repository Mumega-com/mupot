import { describe, it, expect } from 'vitest'
import {
  assertChatInput,
  assertSessionId,
  extractChatReply,
  kayhermesConfigured,
  listSessions,
  normalizeMessagesPayload,
  normalizeSession,
  normalizeSessionsPayload,
  probeHealth,
  resolveKayhermesConfig,
  KayhermesClientError,
} from '../src/kayhermes/client'
import type { Env } from '../src/types'

describe('kayhermesConfigured / resolveKayhermesConfig', () => {
  it('reports unconfigured when url or key missing', () => {
    expect(kayhermesConfigured({} as Env)).toBe(false)
    expect(kayhermesConfigured({ KAYHERMES_API_URL: 'https://x.example' } as Env)).toBe(false)
    expect(kayhermesConfigured({ KAYHERMES_API_KEY: 'k' } as Env)).toBe(false)
  })

  it('rejects private/loopback URL (Workers cannot reach VPS localhost)', () => {
    expect(() =>
      resolveKayhermesConfig({
        KAYHERMES_API_URL: 'http://127.0.0.1:8642',
        KAYHERMES_API_KEY: 'secret',
      } as Env),
    ).toThrow(KayhermesClientError)
    try {
      resolveKayhermesConfig({
        KAYHERMES_API_URL: 'https://127.0.0.1:8642',
        KAYHERMES_API_KEY: 'secret',
      } as Env)
      expect.unreachable('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(KayhermesClientError)
      expect((e as KayhermesClientError).code).toBe('url_private_host')
    }
  })

  it('accepts public https origin', () => {
    const cfg = resolveKayhermesConfig({
      KAYHERMES_API_URL: 'https://kayhermes-api.example.com/',
      KAYHERMES_API_KEY: 'secret',
    } as Env)
    expect(cfg.baseUrl).toBe('https://kayhermes-api.example.com')
    expect(cfg.apiKey).toBe('secret')
    expect(cfg.sessionKey).toBeNull()
  })
})

describe('session/message normalizers', () => {
  it('normalizes sessions from {sessions:[...]}', () => {
    const sessions = normalizeSessionsPayload({
      sessions: [
        { id: 'abc', title: 'hi', source: 'telegram', message_count: 3 },
        { id: '<bad>', title: 'x' },
      ],
    })
    expect(sessions).toEqual([
      {
        id: 'abc',
        title: 'hi',
        source: 'telegram',
        updated_at: null,
        message_count: 3,
      },
    ])
  })

  it('normalizeSession rejects missing id', () => {
    expect(normalizeSession({ title: 'nope' })).toBeNull()
  })

  it('normalizes multimodal message content arrays', () => {
    const messages = normalizeMessagesPayload({
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'part1' }, { type: 'text', text: 'part2' }],
        },
      ],
    })
    expect(messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'part1\npart2' },
    ])
  })

  it('extractChatReply reads common shapes', () => {
    expect(extractChatReply({ reply: 'a' })).toBe('a')
    expect(extractChatReply({ message: { content: 'b' } })).toBe('b')
    expect(
      extractChatReply({
        choices: [{ message: { content: 'c' } }],
      }),
    ).toBe('c')
  })
})

describe('input guards', () => {
  it('assertSessionId allowlists', () => {
    expect(assertSessionId('sess_1')).toBe('sess_1')
    expect(() => assertSessionId('../etc')).toThrow(KayhermesClientError)
  })

  it('assertChatInput bounds', () => {
    expect(assertChatInput(' hi ')).toBe('hi')
    expect(() => assertChatInput('   ')).toThrow(KayhermesClientError)
    expect(() => assertChatInput('x'.repeat(8001))).toThrow(KayhermesClientError)
  })
})

describe('upstream redirect SSRF guard', () => {
  const cfg = {
    baseUrl: 'https://kayhermes-api.example.com',
    apiKey: 'secret',
    sessionKey: null as string | null,
  }

  it('passes redirect:manual and refuses 302 Location chase', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return new Response(null, {
        status: 302,
        headers: { Location: 'http://169.254.169.254/' },
      })
    }) as typeof fetch
    try {
      await expect(listSessions(cfg, { limit: 10, offset: 0 })).rejects.toMatchObject({
        code: 'redirect_blocked',
      })
      expect(calls).toHaveLength(1)
      expect(calls[0].init).toMatchObject({ redirect: 'manual' })
    } finally {
      globalThis.fetch = prev
    }
  })

  it('refuses opaqueredirect responses', async () => {
    const prev = globalThis.fetch
    globalThis.fetch = (async () => {
      const res = {
        ok: false,
        status: 0,
        type: 'opaqueredirect',
        headers: new Headers(),
        text: async () => '',
      }
      return res as unknown as Response
    }) as typeof fetch
    try {
      await expect(probeHealth(cfg)).rejects.toMatchObject({ code: 'redirect_blocked' })
    } finally {
      globalThis.fetch = prev
    }
  })
})
