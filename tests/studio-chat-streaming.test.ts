// tests/studio-chat-streaming.test.ts — Always-on Studio Co-Pilot chat.
//
// Schema is the committed migration chain (createSqliteD1 + applyAllMigrations).
// HTTP tests go through studioApp (the production /api/studio mount) with an
// optional injected dashboard session so guest / member / admin share one door.

import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  studioApp,
  studioPageHtml,
  studioChatAuthorityFromAuth,
  buildStudioChatSystemPrompt,
  STUDIO_CHAT_ADMIN_TOOLS,
} from '../src/dashboard/studio'

const TENANT = 'pot-studio'

let harness: SqliteD1Harness
let env: Env
let lastAiCall: { model: string; input: Record<string, unknown> } | null = null
let authState: AuthContext | null = null

function actor(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'operator-1',
    email: 'operator@mumega.com',
    role: 'admin',
    tenant: TENANT,
    ...overrides,
  }
}

function chatApp() {
  const app = new Hono<{ Bindings: Env; Variables: { auth?: AuthContext } }>()
  app.use('*', async (c, next) => {
    if (authState) c.set('auth', authState)
    await next()
  })
  app.route('/api/studio', studioApp)
  return app
}

function seedOrg(): void {
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-studio', 'studio', 'Studio');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-studio', 'dept-studio', 'studio', 'Studio Squad');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
    VALUES ('agent-studio', 'squad-studio', 'studio-pilot', 'Studio Pilot', 'member', 'cursor-cloud', 'active');
  `)
}

function streamTokens(...parts: string[]): ReadableStream<{ response: string }> {
  return new ReadableStream<{ response: string }>({
    start(controller) {
      for (const part of parts) controller.enqueue({ response: part })
      controller.close()
    },
  })
}

async function readSse(res: Response): Promise<{ raw: string; events: Array<Record<string, unknown>> }> {
  const raw = await res.text()
  const events: Array<Record<string, unknown>> = []
  for (const block of raw.split('\n\n')) {
    const line = block.trim()
    if (!line.startsWith('data:')) continue
    events.push(JSON.parse(line.slice(5).trim()) as Record<string, unknown>)
  }
  return { raw, events }
}

function tokenText(events: Array<Record<string, unknown>>): string {
  return events
    .filter((event) => event.type === 'token')
    .map((event) => String(event.text ?? ''))
    .join('')
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  lastAiCall = null
  authState = actor()
  env = {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BRAND: 'Mupot',
    AI: {
      run: async (model: string, input: Record<string, unknown>) => {
        lastAiCall = { model, input }
        return streamTokens('Hello', ' from ', 'Co-Pilot')
      },
    },
  } as unknown as Env
  seedOrg()
})

afterEach(() => {
  authState = null
  harness.close()
})

describe('studio chat authority helpers', () => {
  it('elevates admin/owner sessions to full tool-calling', () => {
    const admin = studioChatAuthorityFromAuth(actor({ role: 'admin' }), TENANT)
    expect(admin.role).toBe('admin')
    expect(admin.tools).toEqual([...STUDIO_CHAT_ADMIN_TOOLS])
    expect(admin.guest).toBe(false)

    const owner = studioChatAuthorityFromAuth(actor({ role: 'owner' }), TENANT)
    expect(owner.role).toBe('admin')
    expect(owner.tools).toContain('squad_create')
    expect(owner.tools).toContain('cursor_dispatch')
    expect(owner.tools).toContain('task_create')
    expect(owner.tools).toContain('loop_control')
  })

  it('keeps member, public, and unauthenticated callers read-only', () => {
    const member = studioChatAuthorityFromAuth(actor({ role: 'member' }), TENANT)
    expect(member.role).toBe('member')
    expect(member.tools).toEqual([])

    const guest = studioChatAuthorityFromAuth(null, TENANT)
    expect(guest.role).toBe('member')
    expect(guest.guest).toBe(true)
    expect(guest.tools).toEqual([])
  })

  it('reflects session authority in the system prompt', () => {
    const adminPrompt = buildStudioChatSystemPrompt(
      studioChatAuthorityFromAuth(actor({ role: 'admin' }), TENANT),
      { squads: ['Studio Squad'] },
    )
    expect(adminPrompt).toContain('role: admin')
    expect(adminPrompt).toContain('squad_create')
    expect(adminPrompt).toContain('cursor_dispatch')
    expect(adminPrompt).toContain(`Tenant: ${TENANT}`)
    expect(adminPrompt).toContain('Studio Squad')

    const memberPrompt = buildStudioChatSystemPrompt(
      studioChatAuthorityFromAuth(null, TENANT),
      { squads: ['Studio Squad'] },
    )
    expect(memberPrompt).toContain('role: member')
    expect(memberPrompt).toContain('read-only')
    expect(memberPrompt).toMatch(/MUST refuse destructive mutations/i)
  })
})

describe('Studio UI — always-on co-pilot', () => {
  it('renders persistent chat, role badge, streaming client, and Launch Cloud Build', async () => {
    const markup = String(
      await studioPageHtml({
        brand: 'Mupot',
        tenant: TENANT,
        operator: 'operator@mumega.com',
        branch: 'main',
        flights: [],
        authorityRole: 'admin',
      }),
    )
    expect(markup).toContain('id="studio-copilot"')
    expect(markup).toContain('data-always-on="true"')
    expect(markup).toContain('[ 🛡️ Admin Authority ]')
    expect(markup).toContain('studio-authority-admin')
    expect(markup).toContain('id="studio-chat-input"')
    expect(markup).toContain('id="studio-launch-cloud-build"')
    expect(markup).toContain('Launch Cloud Build')
    expect(markup).toContain('studio-msg-user')
    expect(markup).toContain('studio-msg-copilot')
    expect(markup).toContain('response.body.getReader')
    expect(markup).toContain('/api/studio/chat')

    const memberMarkup = String(
      await studioPageHtml({
        brand: 'Mupot',
        tenant: TENANT,
        operator: 'guest',
        branch: 'main',
        flights: [],
        authorityRole: 'member',
      }),
    )
    expect(memberMarkup).toContain('[ 👤 Member / Guest ]')
    expect(memberMarkup).toContain('studio-authority-member')
  })
})

describe('POST /api/studio/chat', () => {
  it('streams valid response tokens for an admin session', async () => {
    authState = actor({ role: 'admin' })
    const res = await chatApp().fetch(
      new Request('https://pot.test/api/studio/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'What can you do in this pot?' }),
      }),
      env,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.headers.get('x-studio-chat-role')).toBe('admin')
    expect(res.headers.get('x-studio-chat-authority')).toBe('admin')

    const { raw, events } = await readSse(res)
    expect(events[0]).toMatchObject({ type: 'meta', role: 'admin' })
    expect((events[0] as { tools: string[] }).tools).toEqual([...STUDIO_CHAT_ADMIN_TOOLS])
    expect(tokenText(events)).toBe('Hello from Co-Pilot')
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    expect(raw).toContain('Hello')
    expect(raw).toContain('Co-Pilot')

    expect(lastAiCall).toBeTruthy()
    expect(lastAiCall?.input.stream).toBe(true)
    expect(String(lastAiCall?.model)).toMatch(/@cf\/(meta\/llama-3\.3-70b-instruct|qwen\/qwen2\.5-coder-32b-instruct)/)
    const tools = lastAiCall?.input.tools as Array<{ name: string }>
    expect(tools.map((tool) => tool.name)).toEqual([...STUDIO_CHAT_ADMIN_TOOLS])
    const messages = lastAiCall?.input.messages as Array<{ role: string; content: string }>
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toContain('role: admin')
    expect(messages[0]?.content).toContain('Studio Squad')
  })

  it('enforces member/read-only scope for unauthenticated sessions', async () => {
    authState = null
    const res = await chatApp().fetch(
      new Request('https://pot.test/api/studio/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'Please create a squad and dispatch a flight.' }),
      }),
      env,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('x-studio-chat-role')).toBe('member')
    expect(res.headers.get('x-studio-chat-authority')).toBe('member')

    const { events } = await readSse(res)
    expect(events[0]).toMatchObject({ type: 'meta', role: 'member', guest: true })
    expect((events[0] as { tools: string[] }).tools).toEqual([])

    expect(lastAiCall).toBeTruthy()
    expect(lastAiCall?.input.stream).toBe(true)
    expect(lastAiCall?.input.tools).toBeUndefined()
    const messages = lastAiCall?.input.messages as Array<{ role: string; content: string }>
    expect(messages[0]?.content).toContain('role: member')
    expect(messages[0]?.content).toMatch(/read-only/i)
    expect(messages[0]?.content).not.toContain('You execute with role: admin')
  })

  it('enforces member/read-only scope for member sessions', async () => {
    authState = actor({ role: 'member', userId: 'member-1', email: 'member@mumega.com' })
    const res = await chatApp().fetch(
      new Request('https://pot.test/api/studio/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'Summarize the studio squad.' }),
      }),
      env,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('x-studio-chat-role')).toBe('member')

    const { events } = await readSse(res)
    expect(events[0]).toMatchObject({ type: 'meta', role: 'member', guest: false })
    expect((events[0] as { tools: string[] }).tools).toEqual([])
    expect(tokenText(events)).toBe('Hello from Co-Pilot')

    const messages = lastAiCall?.input.messages as Array<{ role: string; content: string }>
    expect(messages[0]?.content).toContain('role: member')
    expect(messages[0]?.content).toMatch(/MUST refuse destructive mutations/i)
  })

  it('reflects session authority in streamed chat responses', async () => {
    authState = actor({ role: 'owner', email: 'owner@mumega.com' })
    const adminRes = await chatApp().fetch(
      new Request('https://pot.test/api/studio/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Ready to launch a cloud build.' }] }),
      }),
      env,
    )
    const admin = await readSse(adminRes)
    expect(adminRes.headers.get('x-studio-chat-authority')).toBe('admin')
    expect(admin.events[0]).toMatchObject({ type: 'meta', role: 'admin', tenant: TENANT })
    expect((lastAiCall?.input.messages as Array<{ content: string }>)[0].content).toContain('owner@mumega.com')
    expect((lastAiCall?.input.messages as Array<{ content: string }>)[0].content).toContain('loop_control')

    authState = actor({ role: 'member', email: 'viewer@mumega.com' })
    const memberRes = await chatApp().fetch(
      new Request('https://pot.test/api/studio/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'What flights are in this pot?' }),
      }),
      env,
    )
    const member = await readSse(memberRes)
    expect(memberRes.headers.get('x-studio-chat-authority')).toBe('member')
    expect(member.events[0]).toMatchObject({ type: 'meta', role: 'member', tenant: TENANT })
    expect((lastAiCall?.input.messages as Array<{ content: string }>)[0].content).toContain('viewer@mumega.com')
    expect((lastAiCall?.input.messages as Array<{ content: string }>)[0].content).toContain('read-only')
  })

  it('rejects an empty chat body', async () => {
    const res = await chatApp().fetch(
      new Request('https://pot.test/api/studio/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: '   ' }),
      }),
      env,
    )
    expect(res.status).toBe(400)
    const payload = (await res.json()) as { error: string }
    expect(payload.error).toBe('message_required')
  })
})
