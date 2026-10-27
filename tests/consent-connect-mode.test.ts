// tests/consent-connect-mode.test.ts — the consent screen's first question, "How will this app connect?":
// the suggestion (one allowlist in src/mcp/consent-connect-mode.ts) only steers wording and which tab opens first.
// Hints and pending requests never preselect a radio.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { handleOAuthAuthorize } from '../src/mcp/oauth-authorize'
import { suggestedConnectMode } from '../src/mcp/consent-connect-mode'
import { upsertHarness } from '../src/members/harness'
import type { Env } from '../src/types'

const TENANT = 'mumega'
const HUMAN = 'member-human-1'

let h: SqliteD1Harness
beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO org_settings (key, value, updated_at) VALUES ('billing_state', '{"tier":"scale"}', '2026-08-01T00:00:00.000Z');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('another-human', 'Another human', 'active', '${TENANT}');
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

async function reachConsent(env: Env, hint = ''): Promise<{ html: string; nonce: string }> {
  const authorizeRes = await handleOAuthAuthorize(new Request(
    'https://pot.test/authorize?client_id=client-1&response_type=code&redirect_uri=https://client.example.test/callback&code_challenge=abc&code_challenge_method=S256' + hint,
  ), env)
  const nonce = /mupot_oauth_nonce_([0-9a-f-]{36})=/.exec(authorizeRes.headers.get('Set-Cookie') ?? '')![1]
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
    { headers: { Cookie: `mupot_oauth_nonce_${nonce}=1` } },
  ), env)
  const cookies = res.headers.getSetCookie()
  const consent = /mupot_oauth_consent_([0-9a-f-]{36})=/.exec(cookies.find((c) => c.startsWith('mupot_oauth_consent_')) ?? '')![1]
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
  it('a multi-chat app: names both options, suggests a chat you drive, opens that tab, pre-checks nothing', async () => {
    const { html } = await reachConsent(httpEnv(stubProvider('Cursor', 'https://client.example.test/callback'), '1'))
    expect(html).toContain('How will this app connect?')
    expect(html).toContain('A chat you drive')
    expect(html).toContain('Background agent')
    expect(html).toContain('We suggest <strong>A chat you drive</strong>')
    expect(html).toContain(`selectTab('p-harness')`)
    expect(html).toContain('data-panel="p-harness" aria-selected="true"')
    expect(html).not.toMatch(/<input[^>]*type="radio"[^>]*checked/)
  })
  it('any other app: suggests Background agent and opens the agent tab', async () => {
    const { html } = await reachConsent(httpEnv(stubProvider('Muse', 'https://muse.example.test/callback'), '1'))
    expect(html).toContain('We suggest <strong>Background agent</strong>')
    expect(html).not.toContain(`selectTab('p-harness')`)
    expect(html).toContain('data-panel="p-harness" aria-selected="false"')
    expect(html).not.toMatch(/<input[^>]*type="radio"[^>]*checked/)
    expect(html).toContain('value="__harness__"') // the other option is still there to choose
  })
  it('by redirect host alone (a client with an opaque name)', async () => {
    const { html } = await reachConsent(httpEnv(stubProvider('Connector', 'https://chatgpt.com/cb'), '1'))
    expect(html).toContain('We suggest <strong>A chat you drive</strong>')
  })
  it('SEAT_AUTO_ENROLL on but SEAT_ATTACH off: keeps the chat default and uses plain wording', async () => {
    const provider = stubProvider('Cursor', 'https://cursor.com/cb')
    const { html } = await reachConsent(httpEnv(provider, '1', null))
    for (const m of ['How will this app connect?', 'Many chats', 'Suggested for this app', 'One agent:', 'We suggest']) expect(html).not.toContain(m)
    expect(html).toContain('A chat you drive')
    expect(html).not.toContain('seat_select')
    expect(html).toContain('data-panel="p-harness" aria-selected="true">A chat you drive</button>')
    expect(html).toContain(`selectTab('p-harness')`)
    expect(provider.lookupClient).not.toHaveBeenCalled()
  })
  it('SEAT_ATTACH on: the chat panel uses plain words (no seat_select / seat handle jargon)', async () => {
    const { html } = await reachConsent(httpEnv(stubProvider('Cursor', 'https://cursor.com/cb'), '1'))
    const panel = html.slice(html.indexOf('id="p-harness"') + 14, html.indexOf('id="p-existing"')).replace(/<[^>]*>/g, ' ') // visible text only
    expect(panel).toContain('A chat you drive')
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

function seedBackgroundAgent(id = 'athena', designated = true) {
  h.sqlite.exec(`
    INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('eng', 'eng', 'Engineering');
    INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('core', 'eng', 'core', 'Core');
    INSERT INTO agents (id, squad_id, slug, name, status, attach_designated_member_id)
      VALUES ('${id}', 'core', '${id}', '${id === 'athena' ? 'Athena' : 'Loom'}', 'active', ${designated ? `'${HUMAN}'` : 'NULL'});
    INSERT INTO members (id, display_name, status, tenant) VALUES ('member-${id}', '${id}', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', '${id}', 'member-${id}', '2026-10-26T00:00:00Z');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-${id}', 'member-${id}', 'squad', 'core', 'member');
    INSERT OR IGNORE INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('human-core', '${HUMAN}', 'squad', 'core', 'admin');
  `)
}
function pendingAgent(agent = 'athena', client = 'client-1', harnessId = 'h1', expired = false, scope = 'seat') {
  h.sqlite.prepare(`INSERT OR IGNORE INTO harnesses (id, tenant, member_id, oauth_client_id, client_name, grant_id)
    VALUES (?, ?, ?, ?, 'Codex', ?)`).run(harnessId, TENANT, HUMAN, client, client.includes('#oauth:') ? client.split('#')[1] : null)
  h.sqlite.prepare(`INSERT INTO agent_seat_admissions
    (id, tenant, agent_id, human_member_id, harness_id, status, requested_via, created_at, expires_at, scope)
    VALUES (?, ?, ?, ?, ?, 'pending', 'tool', '2026-10-26T00:00:00Z', ?, ?)`).run(
    `pending-${agent}-${harnessId}`, TENANT, agent, HUMAN, harnessId,
    expired ? '2000-01-01T00:00:00Z' : '2099-01-01T00:00:00Z', scope)
}
const checkedAgents = (html: string) => [...html.matchAll(/<input[^>]*type="radio"[^>]*checked[^>]*>/g)].map((m) => /value="([^"]*)"/.exec(m[0])?.[1])

describe('background agent consent defaults', () => {
  it.each(['&agent=athena', '&agent_id=athena'])('preserves the authorize hint %s across the Google callback without selecting that agent', async (hint) => {
    seedBackgroundAgent()
    const { html } = await reachConsent(httpEnv(stubProvider('Codex', 'https://client.test/cb'), '1'), hint)
    expect(checkedAgents(html)).toEqual([])
    expect(html).toContain('This connection is Athena (runs in the background)')
    expect(html).toContain('Suggested for this connection')
    expect(html).not.toContain('Selected for this connection')
    expect(html).toContain('id="summary-text">Nothing selected yet.')
    expect(html).toContain('data-panel="p-existing" aria-selected="true"')
    expect(html).toContain('A chat you drive')
    expect(html).toContain('value="__harness__"')
    expect(html).toContain('runs on its own and can be woken')
    expect(html).toContain('Its ranked access is capped at your rights; its own gate grants also apply.')
  })
  it('leaves an eligible hinted agent unselected when the chat feature flags are off', async () => {
    seedBackgroundAgent()
    const { html } = await reachConsent(httpEnv(stubProvider('Codex', 'https://client.test/cb'), undefined), '&agent=athena')
    expect(checkedAgents(html)).toEqual([])
  })
  it('accepts an agent id as well as a slug', async () => {
    seedBackgroundAgent('id-athena')
    h.sqlite.exec("UPDATE agents SET slug = 'athena' WHERE id = 'id-athena'")
    const { html } = await reachConsent(httpEnv(stubProvider('Codex', 'https://client.test/cb'), '1'), '&agent=athena')
    expect(checkedAgents(html)).toEqual([])
  })
  it('highlights without selecting the one designated pending agent for this OAuth client', async () => {
    seedBackgroundAgent()
    pendingAgent()
    const { html } = await reachConsent(httpEnv(stubProvider('Codex', 'https://client.test/cb'), '1'))
    expect(checkedAgents(html)).toEqual([])
  })
  it('matches the stored per-install OAuth client label as well', async () => {
    seedBackgroundAgent()
    pendingAgent('athena', 'client-1#oauth:old-grant')
    const { html } = await reachConsent(httpEnv(stubProvider('Codex', 'https://client.test/cb'), '1'))
    expect(checkedAgents(html)).toEqual([])
  })
  it.each(['seat', 'harness'])('reuses an install with its previous client label and a %s admission', async (scope) => {
    seedBackgroundAgent()
    pendingAgent('athena', 'client-1#oauth:old-grant', 'h1', false, scope)
    h.sqlite.prepare(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant, revoked_at)
      VALUES ('old-grant', ?, 'hash-old', 'oauth:old', 'directory', datetime('now'), ?, datetime('now')),
             ('new-grant', ?, 'hash-new', 'oauth:new', 'directory', datetime('now'), ?, NULL)`)
      .run(HUMAN, TENANT, HUMAN, TENANT)
    const env = { ...httpEnv(stubProvider('Codex', 'https://client.test/cb'), '1'), WORKSPACES: '1' } as Env
    const reused = await upsertHarness(env, HUMAN, 'client-1', 'Codex', 'new-grant')
    expect(reused).toMatchObject({ id: 'h1', oauth_client_id: 'client-1#oauth:old-grant', grant_id: 'oauth:new-grant' })
    const { html } = await reachConsent(env)
    // #2217 revokes the old grant's harness-scoped pending request on adoption.
    expect(checkedAgents(html)).toEqual([])
  })
  it('does not match a different client with the same prefix', async () => {
    seedBackgroundAgent()
    pendingAgent('athena', 'client-10#oauth:old-grant')
    const { html } = await reachConsent(httpEnv(stubProvider('Codex', 'https://client.test/cb'), '1'))
    expect(checkedAgents(html)).toEqual([])
  })
  it.each(['other-client', 'expired', 'not-designated', 'ambiguous'])('does not default from %s pending context', async (kind) => {
    seedBackgroundAgent('athena', kind !== 'not-designated')
    pendingAgent('athena', kind === 'other-client' ? 'client-2' : 'client-1', 'h1', kind === 'expired')
    if (kind === 'ambiguous') { seedBackgroundAgent('loom'); pendingAgent('loom') }
    const { html } = await reachConsent(httpEnv(stubProvider('Codex', 'https://client.test/cb'), '1'))
    expect(checkedAgents(html)).toEqual([])
  })
  it('an explicit hint highlights an agent without choosing it', async () => {
    seedBackgroundAgent(); seedBackgroundAgent('loom'); pendingAgent('loom')
    const { html } = await reachConsent(httpEnv(stubProvider('Codex', 'https://client.test/cb'), '1'), '&agent=athena')
    expect(checkedAgents(html)).toEqual([])
  })
  it('an unavailable hint never silently defaults to a different pending agent', async () => {
    seedBackgroundAgent(); pendingAgent()
    const { html } = await reachConsent(httpEnv(stubProvider('Codex', 'https://client.test/cb'), '1'), '&agent=someone-else')
    expect(checkedAgents(html)).toEqual([])
  })
  it('does not guess across two pending installs of the same OAuth client', async () => {
    seedBackgroundAgent(); seedBackgroundAgent('loom')
    pendingAgent('athena', 'client-1#oauth:first', 'h1')
    pendingAgent('loom', 'client-1#oauth:second', 'h2')
    const { html } = await reachConsent(httpEnv(stubProvider('Codex', 'https://client.test/cb'), '1'))
    expect(checkedAgents(html)).toEqual([])
  })
  it('M9: leaves the same agent unselected across two installs', async () => {
    seedBackgroundAgent()
    pendingAgent('athena', 'client-1#oauth:first', 'h1')
    pendingAgent('athena', 'client-1#oauth:second', 'h2')
    const { html } = await reachConsent(httpEnv(stubProvider('Codex', 'https://client.test/cb'), '1'))
    expect(checkedAgents(html)).toEqual([])
    expect(html).not.toContain('Suggested for this connection')
  })
  it('does not guess when an eligible slug is ambiguous', async () => {
    seedBackgroundAgent(); seedBackgroundAgent('loom')
    h.sqlite.exec(`INSERT INTO squads (id, department_id, slug, name) VALUES ('other', 'eng', 'other', 'Other');
      UPDATE agents SET squad_id = 'other', slug = 'athena' WHERE id = 'loom';
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('human-other', '${HUMAN}', 'squad', 'other', 'admin')`)
    const { html } = await reachConsent(httpEnv(stubProvider('Codex', 'https://client.test/cb'), '1'), '&agent=athena')
    expect(checkedAgents(html)).toEqual([])
  })
  it('rechecks designation at POST after highlighting an agent', async () => {
    seedBackgroundAgent()
    const provider = stubProvider('Codex', 'https://client.test/cb')
    const env = httpEnv(provider, '1')
    const { html, nonce } = await reachConsent(env, '&agent=athena')
    expect(checkedAgents(html)).toEqual([])
    h.sqlite.exec("UPDATE agents SET owner_member_id = 'another-human', attach_designated_member_id = NULL WHERE id = 'athena'")
    const res = await handleOAuthAuthorize(new Request('https://pot.test/oauth/consent', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `mupot_oauth_consent_${nonce}=1` },
      body: new URLSearchParams({ consent_nonce: nonce, action: 'continue', agent_id: 'athena' }),
    }), env)
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('Ask an org admin to set you as owner or designate you')
    expect(provider.completeAuthorization).not.toHaveBeenCalled()
  })
  it("admin rights alone do not offer or bind another human's agent", async () => {
    seedBackgroundAgent('athena', false)
    h.sqlite.exec("UPDATE agents SET owner_member_id = 'another-human' WHERE id = 'athena'")
    const provider = stubProvider('Codex', 'https://client.test/cb')
    const env = httpEnv(provider, '1')
    const { html, nonce } = await reachConsent(env, '&agent=athena')
    expect(checkedAgents(html)).toEqual([])
    expect(html).not.toContain('value="athena"')
    expect(html).toContain('set you as owner or designate you')
    expect(html).not.toContain('bootstrap_self')
    const res = await handleOAuthAuthorize(new Request('https://pot.test/oauth/consent', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `mupot_oauth_consent_${nonce}=1` },
      body: new URLSearchParams({ consent_nonce: nonce, action: 'continue', agent_id: 'athena' }),
    }), env)
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('Ask an org admin to set you as owner or designate you')
    expect(provider.completeAuthorization).not.toHaveBeenCalled()
  })
  it('the human can choose the attached chat instead of the suggested background agent', async () => {
    seedBackgroundAgent()
    const provider = stubProvider('Codex', 'https://client.test/cb')
    const env = httpEnv(provider, '1')
    const { nonce } = await reachConsent(env, '&agent=athena')
    const res = await handleOAuthAuthorize(new Request('https://pot.test/oauth/consent', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `mupot_oauth_consent_${nonce}=1` },
      body: new URLSearchParams({ consent_nonce: nonce, action: 'continue', agent_id: '__harness__' }),
    }), env)
    expect(res.status).toBe(302)
    const completed = (provider.completeAuthorization.mock.calls as unknown as Array<[{ request: Record<string, unknown>; props: { boundAgentId: string | null } }]>)[0][0]
    expect(completed.props.boundAgentId).toBeNull()
    expect(completed.request).not.toHaveProperty('backgroundAgentHint')
    expect(completed.request).toMatchObject({ clientId: 'client-1', scope: ['mcp:read', 'mcp:write'] })
  })
})
