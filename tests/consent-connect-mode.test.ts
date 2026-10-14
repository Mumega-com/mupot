// tests/consent-connect-mode.test.ts — the consent screen's first question, "How will this app connect?":
// the suggestion (one allowlist in src/mcp/consent-connect-mode.ts) only steers wording and which tab opens first.
// It never pre-checks a radio (explicit consent), and flag off the page carries none of this text.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { handleOAuthAuthorize } from '../src/mcp/oauth-authorize'
import { suggestedConnectMode } from '../src/mcp/consent-connect-mode'
import type { Env } from '../src/types'

const TENANT = 'mumega'
const HUMAN = 'member-human-1'

let h: SqliteD1Harness
beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO org_settings (key, value, updated_at) VALUES ('billing_state', '{"tier":"scale"}', '2026-08-01T00:00:00.000Z');
    INSERT INTO members (id, email, display_name, status, created_at, tenant)
      VALUES ('${HUMAN}', 'human@example.test', 'Human', 'active', '2026-08-01T00:00:00.000Z', '${TENANT}');
  `)
})
afterEach(() => { h.close(); vi.unstubAllGlobals() })

function memoryKv() {
  const store = new Map<string, string>()
  return {
    async get(key: string, type?: string) {
      const v = store.get(key)
      if (v === undefined) return null
      return type === 'json' ? JSON.parse(v) : v
    },
    async put(key: string, value: string) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
  }
}

function stubProvider(clientName: string, redirectUri: string) {
  return {
    parseAuthRequest: vi.fn(async () => ({ clientId: 'client-1', redirectUri, scope: ['mcp:read', 'mcp:write'] })),
    completeAuthorization: vi.fn(async () => ({ redirectTo: 'https://client.example.test/callback?code=xyz' })),
    lookupClient: vi.fn(async () => ({ clientName })),
  }
}

function httpEnv(provider: ReturnType<typeof stubProvider>, flag: string | undefined, attach: string | undefined | null = flag): Env {
  return {
    DB: h.db, TENANT_SLUG: TENANT, BRAND: 'mupot', POT_TIER: 'scale',
    GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'client-secret',
    SESSIONS: memoryKv(), OAUTH_PROVIDER: provider, BUS: { send: async () => {} },
    ...(flag === undefined ? {} : { SEAT_AUTO_ENROLL: flag }),
    ...(attach === undefined || attach === null ? {} : { SEAT_ATTACH: attach }),
  } as unknown as Env
}

async function reachConsent(env: Env): Promise<{ html: string; nonce: string }> {
  const authorizeRes = await handleOAuthAuthorize(new Request(
    'https://pot.test/authorize?client_id=client-1&response_type=code&redirect_uri=https://client.example.test/callback&code_challenge=abc&code_challenge_method=S256',
  ), env)
  const nonce = /mupot_oauth_nonce=([^;]+)/.exec(authorizeRes.headers.get('Set-Cookie') ?? '')![1]
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'gtok' }), { status: 200 })
    if (url.includes('googleapis.com/oauth2/v2/userinfo')) {
      return new Response(JSON.stringify({ id: 'google-sub-1', name: 'Human', email: 'human@example.test', verified_email: true }), { status: 200 })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }))
  const res = await handleOAuthAuthorize(new Request(
    `https://pot.test/oauth/google-callback?code=abc&state=${nonce}`,
    { headers: { Cookie: `mupot_oauth_nonce=${nonce}` } },
  ), env)
  const cookies = res.headers.getSetCookie()
  const consent = /mupot_oauth_consent=([^;]+)/.exec(cookies.find((c) => c.startsWith('mupot_oauth_consent=')) ?? '')![1]
  return { html: await res.text(), nonce: consent }
}


describe('suggestedConnectMode', () => {
  it('multi-thread clients default to many, by name or by redirect host', () => {
    for (const name of ['ChatGPT', 'Claude', 'Cursor', 'Grok', 'OpenAI Codex', 'xAI Grok Bot']) expect(suggestedConnectMode({ clientName: name, redirectUri: 'https://x.test/cb' })).toBe('many')
    for (const uri of ['https://chatgpt.com/connector_platform_oauth_redirect', 'https://claude.ai/api/mcp/auth_callback', 'https://www.cursor.com/x', 'https://grok.com/cb']) {
      expect(suggestedConnectMode({ clientName: 'Anything', redirectUri: uri })).toBe('many')
    }
  })
  it('everything else defaults to one agent; look-alike hosts and junk do not match', () => {
    expect(suggestedConnectMode({ clientName: 'Muse', redirectUri: 'https://muse.example.test/cb' })).toBe('one')
    expect(suggestedConnectMode({ clientName: 'My Bot', redirectUri: 'https://evilchatgpt.com/cb' })).toBe('one')
    expect(suggestedConnectMode({ clientName: 'My Bot', redirectUri: 'https://chatgpt.com.evil.test/cb' })).toBe('one')
    expect(suggestedConnectMode({})).toBe('one')
    expect(suggestedConnectMode({ clientName: 42, redirectUri: 'not a url' })).toBe('one')
  })
})

describe('consent page: How will this app connect?', () => {
  it('a multi-chat app: names both options, suggests Many chats, opens that tab, pre-checks nothing', async () => {
    const { html } = await reachConsent(httpEnv(stubProvider('Cursor', 'https://client.example.test/callback'), '1'))
    expect(html).toContain('How will this app connect?')
    expect(html).toContain('Many chats: each chat picks its agent')
    expect(html).toContain('One agent: this whole app is one agent')
    expect(html).toContain('We suggest <strong>Many chats</strong>')
    expect(html).toContain(`selectTab('p-harness')`)
    expect(html).toContain('data-panel="p-harness" aria-selected="true"')
    expect(html).not.toMatch(/<input[^>]*type="radio"[^>]*checked/)
  })
  it('any other app: suggests One agent and opens the agent tab', async () => {
    const { html } = await reachConsent(httpEnv(stubProvider('Muse', 'https://muse.example.test/callback'), '1'))
    expect(html).toContain('We suggest <strong>One agent</strong>')
    expect(html).not.toContain(`selectTab('p-harness')`)
    expect(html).toContain('data-panel="p-harness" aria-selected="false"')
    expect(html).not.toMatch(/<input[^>]*type="radio"[^>]*checked/)
    expect(html).toContain('value="__harness__"') // the other option is still there to choose
  })
  it('by redirect host alone (a client with an opaque name)', async () => {
    const { html } = await reachConsent(httpEnv(stubProvider('Connector', 'https://chatgpt.com/cb'), '1'))
    expect(html).toContain('We suggest <strong>Many chats</strong>')
  })
  it('SEAT_AUTO_ENROLL on but SEAT_ATTACH off: the page is the PRE-W2 page (old wording, old tab) and lookupClient is never called', async () => {
    const provider = stubProvider('Cursor', 'https://cursor.com/cb')
    const { html } = await reachConsent(httpEnv(provider, '1', null))
    for (const m of ['How will this app connect?', 'Many chats', 'Suggested for this app', 'One agent:', 'We suggest']) expect(html).not.toContain(m)
    expect(html).toContain('Me — auto per workspace (harness)')
    expect(html).toContain('seat_select')
    expect(html).toContain('data-panel="p-harness" aria-selected="true">Me (auto)</button>')
    expect(html).toContain(`selectTab('p-harness')`)
    expect(provider.lookupClient).not.toHaveBeenCalled()
  })
  it('SEAT_ATTACH on: the Many chats panel uses plain words (no seat_select / seat handle jargon)', async () => {
    const { html } = await reachConsent(httpEnv(stubProvider('Cursor', 'https://cursor.com/cb'), '1'))
    const panel = html.slice(html.indexOf('id="p-harness"') + 14, html.indexOf('id="p-existing"')).replace(/<[^>]*>/g, ' ') // visible text only
    expect(panel).toContain('Many chats')
    for (const jargon of ['seat_select', 'seat handle', 'harness', 'worktree']) expect(panel).not.toContain(jargon)
  })
  it('SEAT_ATTACH without SEAT_AUTO_ENROLL (no harness option at all): no new wording', async () => {
    const { html } = await reachConsent(httpEnv(stubProvider('Cursor', 'https://cursor.com/cb'), undefined, '1'))
    for (const m of ['How will this app connect?', 'Many chats']) expect(html).not.toContain(m)
  })
  it('flag off: none of this wording is on the page', async () => {
    const { html } = await reachConsent(httpEnv(stubProvider('Cursor', 'https://cursor.com/cb'), undefined))
    for (const m of ['How will this app connect?', 'Many chats', 'Suggested for this app', 'One agent:']) expect(html).not.toContain(m)
  })
})
