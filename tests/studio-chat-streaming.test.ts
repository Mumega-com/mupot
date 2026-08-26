// tests/studio-chat-streaming.test.ts — POST /api/studio/chat SSE token stream.
//
// Schema is the committed migration chain (createSqliteD1 + applyAllMigrations).
// HTTP tests go through dashboardApp so session auth and CSRF match production.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env, ModelMessage } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', () => ({
  requireAuth: async (
    c: {
      get: (key: 'auth') => AuthContext | undefined
      set: (key: 'auth', value: AuthContext) => void
      json: (body: unknown, status: 401) => Response
    },
    next: () => Promise<void>,
  ) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
}))

const { dashboardApp } = await import('../src/dashboard')
const {
  copilotSseResponse,
  parseCopilotChatBody,
  tokenizeAssistantText,
  fallbackCopilotReply,
} = await import('../src/dashboard/copilot')

const TENANT = 'pot-studio-chat'

let harness: SqliteD1Harness
let env: Env

function actor(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'operator-1',
    email: 'operator@mumega.com',
    role: 'admin',
    tenant: TENANT,
    ...overrides,
  }
}

function as(auth: AuthContext | null): void {
  authState.current = auth
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = { DB: harness.db, TENANT_SLUG: TENANT, BRAND: 'Mupot' } as Env
  as(actor())
})

afterEach(() => {
  authState.current = null
  harness.close()
})

function chatRequest(body: unknown): Request {
  return new Request('https://pot.test/api/studio/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://pot.test',
    },
    body: JSON.stringify(body),
  })
}

function sseFrames(text: string): Record<string, unknown>[] {
  return text
    .split('\n\n')
    .map((block) => block.replace(/^data:\s*/, '').trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('tokenizeAssistantText', () => {
  it('splits a reply into word tokens for token-by-token rendering', () => {
    expect(tokenizeAssistantText('Hello from Co-Pilot.')).toEqual(['Hello ', 'from ', 'Co-Pilot.'])
  })
})

describe('parseCopilotChatBody', () => {
  it('requires a non-empty message', () => {
    expect(parseCopilotChatBody({ message: '   ' })).toEqual({
      ok: false,
      status: 400,
      error: 'message_required',
    })
  })

  it('accepts history turns', () => {
    const parsed = parseCopilotChatBody({
      message: 'And then?',
      history: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }],
    })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.message).toBe('And then?')
      expect(parsed.value.history).toHaveLength(2)
    }
  })
})

describe('copilotSseResponse', () => {
  it('streams injected model tokens then a done frame', async () => {
    const res = copilotSseResponse(env, { message: 'hello' }, async () => 'Hello from Co-Pilot.')
    expect(res.headers.get('Content-Type')).toBe('text/event-stream')
    const frames = sseFrames(await res.text())
    const tokens = frames.filter((f) => typeof f.token === 'string').map((f) => f.token)
    expect(tokens.join('')).toBe('Hello from Co-Pilot.')
    expect(frames.at(-1)).toEqual({ done: true, source: 'model' })
  })

  it('falls back when the model throws', async () => {
    const res = copilotSseResponse(env, { message: 'Where is Studio?' }, async () => {
      throw new Error('no model')
    })
    const text = await res.text()
    expect(text).toContain('data: {"token":')
    expect(text).toContain(fallbackCopilotReply('Where is Studio?').split(' ')[0])
    expect(text).toContain('"done":true')
    expect(text).toContain('"source":"fallback"')
  })
})

describe('POST /api/studio/chat', () => {
  it('streams SSE tokens from Workers AI when bound', async () => {
    env = {
      ...env,
      AI: {
        run: async () => ({ response: 'Neon token stream works.' }),
      },
    } as Env

    const res = await dashboardApp.fetch(chatRequest({ message: 'Stream please' }), env)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/event-stream')
    const text = await res.text()
    const frames = sseFrames(text)
    expect(frames.some((f) => f.token === 'Neon ' || String(f.token ?? '').includes('Neon'))).toBe(true)
    expect(text).toContain('Neon token stream works.')
    expect(frames.at(-1)).toEqual({ done: true, source: 'model' })
  })

  it('streams a fallback reply when no model is configured', async () => {
    const res = await dashboardApp.fetch(chatRequest({ message: 'What is Studio?' }), env)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('data: {"token":')
    expect(text).toContain('"done":true')
    expect(text).toContain('Co-Pilot')
  })

  it('rejects an empty message', async () => {
    const res = await dashboardApp.fetch(chatRequest({ message: '   ' }), env)
    expect(res.status).toBe(400)
    const payload = (await res.json()) as { error: string }
    expect(payload.error).toBe('message_required')
  })

  it('passes conversation history into the model prompt', async () => {
    const seen: ModelMessage[][] = []
    const res = copilotSseResponse(
      env,
      {
        message: 'Continue',
        history: [{ role: 'user', content: 'Start' }, { role: 'assistant', content: 'Started' }],
      },
      async (messages) => {
        seen.push(messages)
        return 'Continued.'
      },
    )
    await res.text()
    expect(seen).toHaveLength(1)
    expect(seen[0].some((m) => m.role === 'system')).toBe(true)
    expect(seen[0].filter((m) => m.role !== 'system')).toEqual([
      { role: 'user', content: 'Start' },
      { role: 'assistant', content: 'Started' },
      { role: 'user', content: 'Continue' },
    ])
  })
})
