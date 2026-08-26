// tests/deep-chat-integration.test.ts — Deep Chat Co-Pilot drawer, page, and SSE.
//
// Schema is the committed migration chain (createSqliteD1 + applyAllMigrations).
// HTTP tests go through dashboardApp so session auth, CSRF, and the capability
// floor are the same ones production uses.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', () => ({
  peekSessionAuth: async () => authState.current,
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
  copilotDrawerHtml,
  copilotPageBody,
  copilotDeepChatMarkup,
  formatDeepChatSseChunk,
  parseStudioChatPayload,
  normalizeCopilotRecipient,
  resolveCopilotAuthority,
  composeCopilotReply,
  DEEP_CHAT_REQUEST,
  DEEP_CHAT_CONNECT,
  DEEP_CHAT_IMAGES,
  DEEP_CHAT_SPEECH,
  DEEP_CHAT_STYLE,
  STUDIO_CHAT_PATH,
} = await import('../src/dashboard/copilot')

const TENANT = 'pot-copilot'

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

async function markupOf(value: unknown): Promise<string> {
  return String(await value)
}

async function readSseText(res: Response): Promise<string> {
  return res.text()
}

describe('Deep Chat markup', () => {
  it('renders the <deep-chat> custom element with vision, voice, and stream props', async () => {
    const markup = await markupOf(copilotDeepChatMarkup())
    expect(markup).toContain('<deep-chat')
    expect(markup).toContain(`connect='${JSON.stringify(DEEP_CHAT_CONNECT)}'`)
    expect(markup).not.toContain('request=')
    expect(markup).not.toContain('stream="true"')
    expect(markup).toContain(`images='${JSON.stringify(DEEP_CHAT_IMAGES)}'`)
    expect(markup).toContain(`speechToText='${JSON.stringify(DEEP_CHAT_SPEECH)}'`)
    expect(markup).toContain(`textToSpeech='${JSON.stringify(DEEP_CHAT_SPEECH)}'`)
    expect(markup).toContain(JSON.stringify(DEEP_CHAT_STYLE))
    expect(markup).toContain('border-radius:12px')
    expect(markup).toContain('width:100%')
    expect(markup).toContain('height:100%')
    expect(DEEP_CHAT_REQUEST.url).toBe(STUDIO_CHAT_PATH)
    expect(DEEP_CHAT_IMAGES.files.maxNumberOfFiles).toBe(3)
    expect(DEEP_CHAT_SPEECH.webSpeech).toBe(true)
  })

  it('renders <deep-chat> inside the 440px drawer with recipient selector and close control', async () => {
    const markup = await markupOf(copilotDrawerHtml())
    expect(markup).toContain('id="mupot-copilot-drawer"')
    expect(markup).toContain('<deep-chat')
    expect(markup).toContain('@copilot')
    expect(markup).toContain('@loom')
    expect(markup).toContain('@kasra')
    expect(markup).toContain('@athena')
    expect(markup).toContain('@cursor-architect')
    expect(markup).toContain('@cursor-builder')
    expect(markup).toContain('@river')
    expect(markup).toContain('✕')
    expect(markup).toContain('mupot-copilot-recipient-select')
    expect(markup).toContain('aria-label="Close Co-Pilot"')
  })

  it('renders <deep-chat> inside the dedicated full-page card', async () => {
    const markup = await markupOf(copilotPageBody())
    expect(markup).toContain('copilot-page-card')
    expect(markup).toContain('<deep-chat')
    expect(markup).toContain('@copilot')
    expect(markup).toContain('id="mupot-copilot-page-recipient"')
  })
})

describe('GET /copilot and GET /chat', () => {
  it('renders Deep Chat on /copilot for an authenticated operator', async () => {
    const res = await dashboardApp.fetch(new Request('https://pot.test/copilot'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('<deep-chat')
    expect(body).toContain('id="mupot-copilot-drawer"')
    expect(body).toContain('copilot-page-card')
    expect(body).toContain('/api/studio/chat')
    expect(body).toContain('maxNumberOfFiles')
    expect(body).toContain('webSpeech')
    expect(body).toContain('@kasra')
    expect(body).toContain('@athena')
    expect(body).toContain('@cursor-architect')
    expect(body).toContain('@cursor-builder')
    expect(body).toContain('@river')
    expect(body).toContain('unpkg.com/deep-chat@2.1.1')
  })

  it('renders the same Deep Chat card on /chat', async () => {
    const res = await dashboardApp.fetch(new Request('https://pot.test/chat'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('<deep-chat')
    expect(body).toContain('copilot-page-card')
    expect(body).toContain('id="mupot-copilot-drawer"')
  })

  it('embeds the Deep Chat drawer on other shell pages', async () => {
    const res = await dashboardApp.fetch(new Request('https://pot.test/flights'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('id="mupot-copilot-drawer"')
    expect(body).toContain('<deep-chat')
    expect(body).toContain('width: 440px')
    expect(body).toContain('href="/copilot"')
  })

  it('redirects unauthenticated browsers to login', async () => {
    as(null)
    const res = await dashboardApp.fetch(new Request('https://pot.test/copilot'), env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/auth/login')
  })
})

describe('studio chat payload parsing', () => {
  it('accepts Deep Chat { messages, recipient } and standard { message, recipient }', () => {
    const deep = parseStudioChatPayload({
      messages: [{ role: 'user', text: 'Land the flight', files: [{ name: 'shot.png' }] }],
      recipient: '@kasra',
    })
    expect(deep.ok).toBe(true)
    if (deep.ok) {
      expect(deep.value.message).toBe('Land the flight')
      expect(deep.value.recipient).toBe('kasra')
      expect(deep.value.fileCount).toBe(1)
    }

    const standard = parseStudioChatPayload({ message: 'Brief Athena', recipient: 'athena' })
    expect(standard.ok).toBe(true)
    if (standard.ok) {
      expect(standard.value.message).toBe('Brief Athena')
      expect(standard.value.recipient).toBe('athena')
    }
  })

  it('normalizes recipient handles and refuses an empty message', () => {
    expect(normalizeCopilotRecipient('@Cursor-Architect')).toBe('cursor-architect')
    expect(normalizeCopilotRecipient('unknown')).toBe('copilot')
    expect(parseStudioChatPayload({ message: '   ' }).ok).toBe(false)
    expect(parseStudioChatPayload({ messages: [{ role: 'user', text: '' }] }).ok).toBe(false)
  })

  it('formats Deep Chat SSE text chunks as data: {"text":"..."}', () => {
    expect(formatDeepChatSseChunk('Hello')).toBe('data: {"text":"Hello"}\n\n')
    const payload = JSON.parse(formatDeepChatSseChunk('chunk').slice('data: '.length).trim()) as { text: string }
    expect(payload).toEqual({ text: 'chunk' })
  })

  it('resolves dynamic RBAC authority from the session role', () => {
    expect(resolveCopilotAuthority(actor({ role: 'admin' }))).toBe('admin')
    expect(resolveCopilotAuthority(actor({ role: 'owner' }))).toBe('admin')
    expect(resolveCopilotAuthority(actor({ role: 'member' }))).toBe('member')
    expect(composeCopilotReply(actor({ role: 'member' }), {
      message: 'hi',
      recipient: 'loom',
      messages: [],
      fileCount: 0,
    })).toContain('role: member')
  })
})

describe('POST /api/studio/chat', () => {
  async function postChat(body: unknown, auth = actor()): Promise<Response> {
    as(auth)
    return dashboardApp.fetch(
      new Request('https://pot.test/api/studio/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://pot.test',
        },
        body: JSON.stringify(body),
      }),
      env,
    )
  }

  it('streams Deep Chat SSE for a Deep Chat messages payload', async () => {
    const res = await postChat({
      messages: [{ role: 'user', text: 'What is the land gate?' }],
      recipient: 'kasra',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const body = await readSseText(res)
    expect(body).toContain('data: {')
    expect(body).toContain('"text"')
    expect(body).toMatch(/data: \{"text":/)
    expect(body).toContain('role: admin')
    expect(body).toContain('@kasra')
    const frames = body
      .split('\n\n')
      .map((frame) => frame.replace(/^data: /, '').trim())
      .filter(Boolean)
      .map((frame) => JSON.parse(frame) as { text: string })
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every((frame) => typeof frame.text === 'string')).toBe(true)
    expect(frames.map((frame) => frame.text).join('')).toContain('What is the land gate?')
  })

  it('streams the same Deep Chat payload for the standard { message, recipient } body', async () => {
    const res = await postChat({ message: 'Review the PR', recipient: 'athena' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const body = await readSseText(res)
    expect(body).toMatch(/data: \{"text":/)
    expect(body).toContain('@athena')
    const joined = body
      .split('\n\n')
      .map((frame) => frame.replace(/^data: /, '').trim())
      .filter(Boolean)
      .map((frame) => (JSON.parse(frame) as { text: string }).text)
      .join('')
    expect(joined).toContain('Review the PR')
    expect(joined).toContain('role: admin')
  })

  it('keeps member-tier authority in the stream when the session is role: member', async () => {
    const res = await postChat({ message: 'Can I mint a token?', recipient: 'copilot' }, actor({ role: 'member' }))
    expect(res.status).toBe(200)
    const body = await readSseText(res)
    expect(body).toContain('role: member')
    expect(body).not.toContain('role: admin')
    expect(res.headers.get('X-Mupot-Copilot-Role')).toBe('member')
  })

  it('rejects an empty message', async () => {
    const res = await postChat({ message: '   ', recipient: 'copilot' })
    expect(res.status).toBe(400)
    const payload = (await res.json()) as { error: string }
    expect(payload.error).toBe('message_required')
  })
})
