// tests/copilot-recipient-routing.test.ts — multi-agent Co-Pilot recipient routing.
//
// Schema is the committed migration chain (createSqliteD1 + applyAllMigrations).
// HTTP tests go through dashboardApp so session auth, CSRF, and the capability
// floor are the same ones production uses.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { html } from 'hono/html'
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
  peekSessionAuth: async () => authState.current,
}))

const { dashboardApp, shell } = await import('../src/dashboard')
const {
  COPILOT_RECIPIENTS,
  COPILOT_RECIPIENT_STORAGE_KEY,
  COPILOT_SCRIPT,
  buildCopilotPersonaPrompt,
  copilotPageBody,
  copilotRecipientBadge,
  copilotSseResponse,
  normalizeCopilotRecipient,
  parseCopilotChatBody,
} = await import('../src/dashboard/copilot')
const { buildStudioChatSystemPrompt, parseStudioChatInput } = await import('../src/dashboard/studio-chat')

const TENANT = 'pot-copilot-routing'

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

const SELECTOR_HANDLES = [
  '@copilot',
  '@loom',
  '@kasra',
  '@athena',
  '@cursor-architect',
  '@cursor-builder',
] as const

const SELECTOR_TITLES = [
  'General Pot Assistant',
  'Sprint Coordinator',
  'Server Builder & Runtime Operator',
  'Gatekeeper & Safety Reviewer',
  'Cloud Lead Architect',
  'Cloud Implementer',
] as const

function expectRecipientSelector(markup: string): void {
  expect(markup).toContain('data-copilot-recipient')
  expect(markup).toContain('class="copilot-recipient"')
  for (const handle of SELECTOR_HANDLES) expect(markup).toContain(handle)
  for (const title of SELECTOR_TITLES) expect(markup).toContain(title)
}

describe('persona prompt builders', () => {
  it('normalizes handles, aliases, and unknown recipients', () => {
    expect(normalizeCopilotRecipient('loom')).toBe('loom')
    expect(normalizeCopilotRecipient('@KASRA')).toBe('kasra')
    expect(normalizeCopilotRecipient('cursor_architect')).toBe('cursor-architect')
    expect(normalizeCopilotRecipient('not-an-agent')).toBe('copilot')
    expect(normalizeCopilotRecipient(undefined)).toBe('copilot')
  })

  it('builds Loom as sprint coordinator with council authority', () => {
    const prompt = buildCopilotPersonaPrompt('loom')
    expect(prompt).toContain('Loom')
    expect(prompt).toContain('Sprint Coordinator')
    expect(prompt).toMatch(/council authority/i)
    expect(prompt).toMatch(/sprint awareness/i)
  })

  it('builds Kasra as system builder and runtime operator', () => {
    const prompt = buildCopilotPersonaPrompt('kasra')
    expect(prompt).toContain('Kasra')
    expect(prompt).toMatch(/system builder/i)
    expect(prompt).toMatch(/runtime operator/i)
  })

  it('builds Athena as adversarial gatekeeper and safety reviewer', () => {
    const prompt = buildCopilotPersonaPrompt('athena')
    expect(prompt).toContain('Athena')
    expect(prompt).toMatch(/adversarial gatekeeper/i)
    expect(prompt).toMatch(/safety reviewer/i)
  })

  it('builds Cursor Architect for architecture and repo planning', () => {
    const prompt = buildCopilotPersonaPrompt('cursor-architect')
    expect(prompt).toMatch(/architecture/i)
    expect(prompt).toMatch(/system design/i)
    expect(prompt).toMatch(/repo planning/i)
  })

  it('builds Cursor Builder for implementation, tests, and PRs', () => {
    const prompt = buildCopilotPersonaPrompt('cursor-builder')
    expect(prompt).toMatch(/code implementation/i)
    expect(prompt).toMatch(/tests/i)
    expect(prompt).toMatch(/PR delivery/i)
  })

  it('keeps the general pot assistant persona for @copilot', () => {
    const prompt = buildCopilotPersonaPrompt('@copilot')
    expect(prompt).toContain('Mupot Co-Pilot')
    expect(prompt).toMatch(/operator assistant/i)
  })

  it('labels chat-turn badges with avatar and title', () => {
    expect(copilotRecipientBadge('loom')).toBe('🧶 Loom')
    expect(copilotRecipientBadge('kasra')).toBe('🔨 Kasra')
    expect(copilotRecipientBadge('athena')).toBe('🛡️ Athena')
    expect(copilotRecipientBadge('cursor-architect')).toBe('☁️ Cursor Architect')
    expect(copilotRecipientBadge('cursor-builder')).toBe('🛠️ Cursor Builder')
    expect(copilotRecipientBadge('copilot')).toBe('✨ Co-Pilot')
  })

  it('threads the recipient persona into the Studio system prompt', () => {
    const prompt = buildStudioChatSystemPrompt(
      {
        role: 'admin',
        tools: ['task_create'],
        operator: 'operator@mumega.com',
        tenant: TENANT,
        guest: false,
        source: 'session',
      },
      { squads: ['squad-core'] },
      'athena',
    )
    expect(prompt).toMatch(/adversarial gatekeeper/i)
    expect(prompt).toContain('🛡️ Athena')
    expect(prompt).toContain('@athena')
  })
})

describe('parseCopilotChatBody recipient', () => {
  it('accepts a recipient and defaults unknown values to copilot', () => {
    const parsed = parseCopilotChatBody({ message: 'Status?', recipient: '@loom', history: [] })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.recipient).toBe('loom')
      expect(parsed.value.message).toBe('Status?')
    }

    const fallback = parseCopilotChatBody({ message: 'Status?', recipient: 'ghost' })
    expect(fallback.ok).toBe(true)
    if (fallback.ok) expect(fallback.value.recipient).toBe('copilot')
  })
})

describe('parseStudioChatInput recipient', () => {
  it('accepts history plus recipient on the Studio chat body', () => {
    const parsed = parseStudioChatInput({
      message: 'Ship it',
      history: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }],
      recipient: 'cursor-builder',
    })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.recipient).toBe('cursor-builder')
      expect(parsed.userText).toBe('Ship it')
      expect(parsed.messages.some((turn) => turn.content === 'Hi')).toBe(true)
    }
  })
})

describe('recipient selector markup', () => {
  it('is present in the global drawer body', async () => {
    const markup = String(await shell(env, 'Overview', html`<p>hi</p>`))
    expectRecipientSelector(markup)
    expect(markup).toContain('id="mupot-copilot-recipient"')
    expect(markup).toContain(COPILOT_RECIPIENT_STORAGE_KEY)
    expect(COPILOT_SCRIPT).toContain('localStorage.setItem')
    expect(COPILOT_SCRIPT).toContain(COPILOT_RECIPIENT_STORAGE_KEY)
  })

  it('is present in the dedicated /copilot page body', async () => {
    const markup = String(await copilotPageBody(actor({ role: 'admin' })))
    expectRecipientSelector(markup)
    expect(markup).toContain('id="mupot-copilot-page-recipient"')
    expect(markup).toContain('id="mupot-copilot-page"')
    expect(COPILOT_RECIPIENTS).toHaveLength(6)
  })
})

describe('POST /api/studio/chat recipient routing', () => {
  it('accepts recipient and tailors the persona response', async () => {
    const res = await dashboardApp.fetch(chatRequest({ message: 'Who are you?', recipient: 'loom' }), env)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/event-stream')
    const text = await res.text()
    const frames = sseFrames(text)
    const meta = frames.find((frame) => frame.type === 'meta')
    expect(meta).toMatchObject({ type: 'meta', agent: 'loom', role: 'admin' })
    expect(text).toContain('"type":"token"')
    expect(text).toContain('"text":')
    expect(text).toMatch(/Loom|Sprint Coordinator/)
  })

  it('streams persona-specific tokens for each routed agent', async () => {
    const cases: Array<{ recipient: string; needle: RegExp }> = [
      { recipient: 'kasra', needle: /Kasra|system builder|Runtime Operator/i },
      { recipient: 'athena', needle: /Athena|Gatekeeper|safety reviewer/i },
      { recipient: 'cursor-architect', needle: /Cursor Architect|architecture|repo planning/i },
      { recipient: 'cursor-builder', needle: /Cursor Builder|Cloud Implementer|implementation/i },
    ]
    for (const row of cases) {
      const res = await dashboardApp.fetch(
        chatRequest({ message: 'Introduce yourself.', recipient: row.recipient }),
        env,
      )
      expect(res.status).toBe(200)
      const text = await res.text()
      const meta = sseFrames(text).find((frame) => frame.type === 'meta')
      expect(meta).toMatchObject({ type: 'meta', agent: row.recipient })
      expect(text).toMatch(row.needle)
    }
  })

  it('puts the recipient persona in the model system prompt', async () => {
    const seen: ModelMessage[][] = []
    const res = copilotSseResponse(
      env,
      { message: 'Plan the repo', recipient: 'cursor-architect' },
      async (messages) => {
        seen.push(messages)
        return 'Architecture first.'
      },
      'admin',
    )
    const frames = sseFrames(await res.text())
    expect(frames[0]).toEqual({ type: 'meta', agent: 'cursor-architect', role: 'admin' })
    expect(seen).toHaveLength(1)
    expect(seen[0][0]?.role).toBe('system')
    expect(seen[0][0]?.content).toMatch(/architecture/i)
    expect(seen[0][0]?.content).toMatch(/repo planning/i)
    const tokens = frames.filter((frame) => frame.type === 'token').map((frame) => frame.text)
    expect(tokens.join('')).toBe('Architecture first.')
  })
})
