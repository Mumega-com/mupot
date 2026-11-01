// tests/oauth-consent-refusals.test.ts — the /oauth/consent refusals a person actually hits.
//
// A person connecting an agent got the bare text "CSRF check failed: consent nonce mismatch" and was
// stuck. The request must still be refused in every case below (no mint, no state change); what
// changed is what the person is told, and that a recoverable first-agent mistake no longer burns the
// page. Values and transitions are pinned: statuses, exact messages, KV record presence, row counts.
//
// Script behaviour (the one-submit guard) can only be pinned as TEXT of the rendered page: there is
// no DOM in this suite, so those assertions prove the guard is present and never uses `disabled`,
// not that a browser runs it.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { handleOAuthAuthorize } from '../src/mcp/oauth-authorize'
import type { Env } from '../src/types'

const TENANT = 'mumega'
const NEWCOMER = 'refusals-newcomer@example.test'
const EXPIRED = 'This page has expired or was already used. If your app already shows the connection working, there is nothing more to do; otherwise start the connection again from your app.'
const NO_COOKIE = 'Your browser did not send the sign-in cookie for this page. Start the connection again from your app, using your normal browser.'
const MALFORMED = 'This page is not valid. Start the connection again from your app.'

interface KvCall { op: 'get' | 'put' | 'delete'; key: string; options?: Record<string, unknown> }

function spyKv() {
  const store = new Map<string, string>()
  const calls: KvCall[] = []
  return {
    async get(key: string, type?: string) {
      calls.push({ op: 'get', key })
      const v = store.get(key)
      if (v === undefined) return null
      return type === 'json' ? JSON.parse(v) : v
    },
    async put(key: string, value: string, options?: Record<string, unknown>) {
      calls.push({ op: 'put', key, options })
      store.set(key, value)
    },
    async delete(key: string) {
      calls.push({ op: 'delete', key })
      store.delete(key)
    },
    _store: store,
    _calls: calls,
  }
}

function stubOAuthProvider() {
  return {
    parseAuthRequest: vi.fn(async () => ({ clientId: 'client-1', scope: ['mcp:read', 'mcp:write'] })),
    completeAuthorization: vi.fn(async () => ({ redirectTo: 'https://client.example.test/callback?code=xyz' })),
  }
}

function stubGoogleFetch(email: string) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'gtok' }), { status: 200 })
    }
    if (url.includes('googleapis.com/oauth2/v2/userinfo')) {
      return new Response(JSON.stringify({ id: 'google-sub-refusals', name: 'Person', email, verified_email: true }), { status: 200 })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }))
}

let harness: SqliteD1Harness
let oauthProvider: ReturnType<typeof stubOAuthProvider>
let kv: ReturnType<typeof spyKv>
let env: Env

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  oauthProvider = stubOAuthProvider()
  kv = spyKv()
  env = {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BRAND: 'mupot',
    GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    SESSIONS: kv,
    OAUTH_PROVIDER: oauthProvider,
    BUS: { send: async () => {} },
  } as unknown as Env
})

afterEach(() => {
  harness.close()
  vi.unstubAllGlobals()
})

async function reachConsentScreen(email = NEWCOMER): Promise<{ html: string; nonce: string }> {
  const authorizeRes = await handleOAuthAuthorize(new Request(
    'https://pot.test/authorize?client_id=client-1&response_type=code&redirect_uri=https://client.example.test/callback&code_challenge=abc&code_challenge_method=S256',
  ), env)
  const state = /mupot_oauth_nonce_([0-9a-f-]{36})=/.exec(authorizeRes.headers.get('Set-Cookie') ?? '')![1]
  stubGoogleFetch(email)
  const res = await handleOAuthAuthorize(new Request(
    `https://pot.test/oauth/google-callback?code=abc&state=${state}`,
    { headers: { Cookie: `mupot_oauth_nonce_${state}=1` } },
  ), env)
  const html = await res.text()
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('Set-Cookie') ?? '']
  const line = cookies.find((c) => c.startsWith('mupot_oauth_consent_')) ?? ''
  return { html, nonce: /mupot_oauth_consent_([0-9a-f-]{36})=/.exec(line)![1] }
}

function post(fields: Record<string, string>, cookie: string | null): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (cookie !== null) headers.Cookie = cookie
  return handleOAuthAuthorize(new Request('https://pot.test/oauth/consent', {
    method: 'POST', headers, body: new URLSearchParams(fields).toString(),
  }), env)
}

const cookieFor = (nonce: string) => `mupot_oauth_consent_${nonce}=1`
const pendingKey = (nonce: string) => `oauth-consent:${nonce}`
const count = (table: string) => (harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
const gets = (nonce: string) => kv._calls.filter((c) => c.op === 'get' && c.key === pendingKey(nonce)).length

describe('the missing-cookie refusal tells the person what happened, and still refuses', () => {
  it('second POST after success: refused with the used/expired message, no second token row, no second completeAuthorization', async () => {
    const { nonce } = await reachConsentScreen()
    const first = await post({ consent_nonce: nonce, action: 'continue', agent_id: '' }, cookieFor(nonce))
    expect(first.status).toBe(302)
    expect(oauthProvider.completeAuthorization).toHaveBeenCalledTimes(1)
    const tokens = count('member_tokens')
    expect(tokens).toBe(1)

    // The browser has applied the success response's cookie clear: no cookie on the second post.
    const noCookie = await post({ consent_nonce: nonce, action: 'continue', agent_id: '' }, null)
    expect(noCookie.status).toBe(400)
    expect(await noCookie.text()).toBe(EXPIRED)
    // A double-click races the clear: the second post still carries the cookie.
    const withCookie = await post({ consent_nonce: nonce, action: 'continue', agent_id: '' }, cookieFor(nonce))
    expect(withCookie.status).toBe(400)
    expect(await withCookie.text()).toBe(EXPIRED)

    expect(oauthProvider.completeAuthorization).toHaveBeenCalledTimes(1)
    expect(count('member_tokens')).toBe(tokens)
  })

  it('cookie missing + live pending record: 403 with the cookie message, record NOT consumed, nothing minted', async () => {
    const { nonce } = await reachConsentScreen()
    expect(kv._store.has(pendingKey(nonce))).toBe(true)
    const tokens = count('member_tokens')

    const res = await post({ consent_nonce: nonce, action: 'continue', agent_id: '' }, null)
    expect(res.status).toBe(403)
    expect(await res.text()).toBe(NO_COOKIE)
    // A forged cross-site post carrying the nonce must not be able to burn the victim's session.
    expect(kv._store.has(pendingKey(nonce))).toBe(true)
    expect(kv._calls.some((c) => c.op === 'delete' && c.key === pendingKey(nonce))).toBe(false)
    expect(oauthProvider.completeAuthorization).not.toHaveBeenCalled()
    expect(count('member_tokens')).toBe(tokens)

    // The page the person still has open keeps working once the cookie is there.
    const ok = await post({ consent_nonce: nonce, action: 'continue', agent_id: '' }, cookieFor(nonce))
    expect(ok.status).toBe(302)
  })

  it('expired pending record (cookie still present): 400 with the used/expired next step', async () => {
    const { nonce } = await reachConsentScreen()
    kv._store.delete(pendingKey(nonce)) // KV TTL elapsed
    const res = await post({ consent_nonce: nonce, action: 'continue', agent_id: '' }, cookieFor(nonce))
    expect(res.status).toBe(400)
    expect(await res.text()).toBe(EXPIRED)
    expect(oauthProvider.completeAuthorization).not.toHaveBeenCalled()
    expect(count('member_tokens')).toBe(0)
  })

  it('expired pending record and cookie gone (page open past 10 minutes): same 400', async () => {
    const { nonce } = await reachConsentScreen()
    kv._store.delete(pendingKey(nonce))
    const res = await post({ consent_nonce: nonce, action: 'continue', agent_id: '' }, null)
    expect(res.status).toBe(400)
    expect(await res.text()).toBe(EXPIRED)
  })

  it('malformed nonce: refused with no KV read at all', async () => {
    await reachConsentScreen()
    kv._calls.length = 0
    for (const bad of ['not-a-uuid', '../../etc', 'A'.repeat(36), '00000000-0000-0000-0000-00000000000g']) {
      const res = await post({ consent_nonce: bad, action: 'continue', agent_id: '' }, `mupot_oauth_consent_${bad}=1`)
      expect(res.status).toBe(403)
      expect(await res.text()).toBe(MALFORMED)
    }
    expect(kv._calls).toEqual([])
    expect(oauthProvider.completeAuthorization).not.toHaveBeenCalled()
  })

  it('cookie from a different nonce: refused, and neither record is consumed', async () => {
    const a = await reachConsentScreen()
    const b = await reachConsentScreen()
    expect(a.nonce).not.toBe(b.nonce)
    const res = await post({ consent_nonce: a.nonce, action: 'continue', agent_id: '' }, cookieFor(b.nonce))
    expect(res.status).toBe(403)
    expect(await res.text()).toBe(NO_COOKIE)
    expect(kv._store.has(pendingKey(a.nonce))).toBe(true)
    expect(kv._store.has(pendingKey(b.nonce))).toBe(true)
    expect(oauthProvider.completeAuthorization).not.toHaveBeenCalled()
    expect(count('member_tokens')).toBe(0)
  })

  it('a refused decline path also never needs the record: decline without the cookie is refused, nothing consumed', async () => {
    const { nonce } = await reachConsentScreen()
    const res = await post({ consent_nonce: nonce, action: 'decline' }, null)
    expect(res.status).toBe(403)
    expect(kv._store.has(pendingKey(nonce))).toBe(true)
  })
})

describe('a first-agent mistake that created nothing leaves the page usable, for the rest of its original life', () => {
  const bootstrap = (nonce: string, name: string) =>
    post({ consent_nonce: nonce, action: 'continue', agent_id: '__bootstrap__', first_agent_name: name }, cookieFor(nonce))

  it('blank name: refused, nothing created, cookie kept; corrected retry on the same nonce+cookie succeeds exactly once; a replay is refused', async () => {
    const { nonce } = await reachConsentScreen()
    const agentsBefore = count('agents')

    const refused = await bootstrap(nonce, '   ')
    expect(refused.status).toBe(400)
    expect(await refused.text()).toBe('Your agent needs a name. Nothing was created. Type a name and continue.')
    expect(refused.headers.get('Set-Cookie') ?? '').not.toContain('Max-Age=0')
    expect(count('agents')).toBe(agentsBefore)
    expect(oauthProvider.completeAuthorization).not.toHaveBeenCalled()
    // The record is back.
    expect(kv._store.has(pendingKey(nonce))).toBe(true)

    const ok = await bootstrap(nonce, 'Ada')
    expect(ok.status).toBe(302)
    expect(count('agents')).toBe(agentsBefore + 1)
    expect(oauthProvider.completeAuthorization).toHaveBeenCalledTimes(1)
    const tokens = count('member_tokens')

    // Replay of the successful post (with and without cookie): refused, nothing runs again.
    for (const cookie of [cookieFor(nonce), null]) {
      const replay = await post({ consent_nonce: nonce, action: 'continue', agent_id: '__bootstrap__', first_agent_name: 'Ada' }, cookie)
      expect(replay.status).toBe(400)
      expect(await replay.text()).toBe(EXPIRED)
    }
    expect(count('agents')).toBe(agentsBefore + 1)
    expect(count('member_tokens')).toBe(tokens)
    expect(oauthProvider.completeAuthorization).toHaveBeenCalledTimes(1)
  })

  it('the restored record keeps its ORIGINAL expiry: same absolute expiration, never a fresh 10 minutes', async () => {
    const { nonce } = await reachConsentScreen()
    const original = JSON.parse(kv._store.get(pendingKey(nonce))!) as { expiresAt: number }
    const firstPut = kv._calls.find((c) => c.op === 'put' && c.key === pendingKey(nonce))!
    expect(firstPut.options).toEqual({ expirationTtl: 600 })

    // Three minutes later the person submits a blank name.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date((original.expiresAt - 420) * 1000))
      await bootstrap(nonce, '')
    } finally {
      vi.useRealTimers()
    }
    const restore = kv._calls.filter((c) => c.op === 'put' && c.key === pendingKey(nonce)).at(-1)!
    expect(restore.options).toEqual({ expiration: original.expiresAt })
    expect((JSON.parse(kv._store.get(pendingKey(nonce))!) as { expiresAt: number }).expiresAt).toBe(original.expiresAt)
  })

  it('under 60s of life left (KV minimum): not restored, and the person is told to start again instead of retrying', async () => {
    const { nonce } = await reachConsentScreen()
    const original = JSON.parse(kv._store.get(pendingKey(nonce))!) as { expiresAt: number }
    vi.useFakeTimers({ toFake: ['Date'] })
    let res: Response
    try {
      vi.setSystemTime(new Date((original.expiresAt - 30) * 1000))
      res = await bootstrap(nonce, '')
    } finally {
      vi.useRealTimers()
    }
    expect(res.status).toBe(400)
    expect(await res.text()).toBe('Your agent needs a name. Nothing was created. This page can no longer be used, so start the connection again from your app.')
    expect(kv._store.has(pendingKey(nonce))).toBe(false)
  })

  it('a record written before expiresAt existed is never restored (fail closed)', async () => {
    const { nonce } = await reachConsentScreen()
    const legacy = JSON.parse(kv._store.get(pendingKey(nonce))!) as Record<string, unknown>
    delete legacy.expiresAt
    kv._store.set(pendingKey(nonce), JSON.stringify(legacy))
    const res = await bootstrap(nonce, '')
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('This page can no longer be used')
    expect(kv._store.has(pendingKey(nonce))).toBe(false)
  })

  it('already_bootstrapped is final: record stays consumed, cookie cleared, message says what to do', async () => {
    const first = await reachConsentScreen()
    expect((await bootstrap(first.nonce, 'Ada')).status).toBe(302)

    const second = await reachConsentScreen()
    const res = await bootstrap(second.nonce, 'Bob')
    expect(res.status).toBe(400)
    expect(await res.text()).toBe('You have already created your first agent. Start the connection again from your app and choose it from the list.')
    expect(kv._store.has(pendingKey(second.nonce))).toBe(false)
    expect(res.headers.get('Set-Cookie') ?? '').toContain('Max-Age=0')
    expect(count('agents')).toBe(1)
  })

  it('provisioning_failed is recoverable: nothing created, record restored, then the same page succeeds', async () => {
    const { nonce } = await reachConsentScreen()
    const agentsBefore = count('agents')
    // Make provisioning fail without creating anything: a work-kind department squatting the home slug.
    const memberId = (harness.sqlite.prepare('SELECT id FROM members WHERE email = ?').get(NEWCOMER) as { id: string }).id
    harness.sqlite.exec(`INSERT INTO departments (id, slug, name, kind) VALUES ('squat', 'dept-home-${memberId}', 'Squat', 'work')`)

    const res = await bootstrap(nonce, 'Ada')
    expect(res.status).toBe(500)
    expect(await res.text()).toBe('Creating the agent did not complete, and nothing was left behind. Continue again to retry.')
    expect(count('agents')).toBe(agentsBefore)
    expect(kv._store.has(pendingKey(nonce))).toBe(true)
    expect(oauthProvider.completeAuthorization).not.toHaveBeenCalled()

    // Clear the squatter: the same page now succeeds.
    harness.sqlite.exec(`DELETE FROM departments WHERE id = 'squat'`)
    expect((await bootstrap(nonce, 'Ada')).status).toBe(302)
    expect(count('agents')).toBe(agentsBefore + 1)
  })
})

describe('other refusals on this handler carry a next step, never "sign in again"', () => {
  it('__mint_new__ with no name or squad', async () => {
    const { nonce } = await reachConsentScreen()
    const res = await post({ consent_nonce: nonce, action: 'continue', agent_id: '__mint_new__' }, cookieFor(nonce))
    expect(res.status).toBe(400)
    expect(await res.text()).toBe('A new agent needs a name and a home squad. Start the connection again from your app and fill in both.')
  })

  it('missing consent_nonce and missing agent_id', async () => {
    const noNonce = await post({ action: 'continue', agent_id: '' }, null)
    expect(noNonce.status).toBe(400)
    expect(await noNonce.text()).toBe('This page is missing its session. Start the connection again from your app.')
    const { nonce } = await reachConsentScreen()
    const noChoice = await post({ consent_nonce: nonce, action: 'continue' }, cookieFor(nonce))
    expect(noChoice.status).toBe(400)
    expect(await noChoice.text()).toBe('Missing agent_id: explicit consent choice is required. Choose an option on the page, then continue.')
    expect(kv._store.has(pendingKey(nonce))).toBe(true)
  })
})

describe('the one-submit guard in the rendered page (pinned as text; no DOM here)', () => {
  it('has the flag guard after the choice validation, resets on pageshow, and never disables anything', async () => {
    const { html } = await reachConsentScreen()
    const script = html.slice(html.indexOf('form.addEventListener(\'submit\''), html.indexOf('</script>', html.indexOf('form.addEventListener(\'submit\'')))
    expect(html).toContain('var submitted = false')
    expect(script).toContain('if (submitted) { e.preventDefault(); return }')
    expect(script).toContain('submitted = true')
    expect(script).toContain("window.addEventListener('pageshow', function () { submitted = false })")
    // Order: choice validation first, so an unselected Continue does not lock the page.
    expect(script.indexOf('Choose an option before continuing.')).toBeLessThan(script.indexOf('if (submitted)'))
    expect(script.indexOf('if (submitted)')).toBeLessThan(script.indexOf('submitted = true'))
    // Decline is covered: the decline early-return no longer skips the guard.
    expect(script).not.toMatch(/action === 'decline'\) return/)
    // Never disable the buttons or the submitter (a disabled submitter drops name=action).
    const code = script.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/disabled/)
    expect(html).not.toMatch(/\.disabled\s*=/)
    expect(html).not.toMatch(/setAttribute\(['"]disabled/)
  })
})
