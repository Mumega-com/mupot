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
    OPEN_SIGNUP_ENABLED: 'true',
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

describe('a bad first-agent name is refused BEFORE the record is consumed (no write at all)', () => {
  const bootstrap = (nonce: string, name: string) =>
    post({ consent_nonce: nonce, action: 'continue', agent_id: '__bootstrap__', first_agent_name: name }, cookieFor(nonce))
  const BLANK = 'Your agent needs a name, and none was sent. Go back to the previous page and type a name; if that does not work, start the connection again from your app.'
  const LONG = 'That agent name is longer than 128 characters. Go back to the previous page and shorten it; if that does not work, start the connection again from your app.'

  it.each([['blank', '   ', BLANK], ['over 128', 'x'.repeat(129), LONG]])(
    '%s name: 400, record untouched with no delete or put, cookie kept; corrected post on the same nonce+cookie succeeds exactly once; replay refused',
    async (_label, bad, message) => {
      const { nonce } = await reachConsentScreen()
      const agentsBefore = count('agents')
      kv._calls.length = 0

      const refused = await bootstrap(nonce, bad)
      expect(refused.status).toBe(400)
      expect(await refused.text()).toBe(message)
      expect(refused.headers.get('Set-Cookie')).toBeNull()
      expect(kv._calls.filter((c) => c.op !== 'get')).toEqual([]) // not one write or delete
      expect(kv._store.has(pendingKey(nonce))).toBe(true)
      expect(count('agents')).toBe(agentsBefore)
      expect(oauthProvider.completeAuthorization).not.toHaveBeenCalled()

      const ok = await bootstrap(nonce, 'Ada')
      expect(ok.status).toBe(302)
      expect(count('agents')).toBe(agentsBefore + 1)
      expect(oauthProvider.completeAuthorization).toHaveBeenCalledTimes(1)
      const tokens = count('member_tokens')

      for (const cookie of [cookieFor(nonce), null]) {
        const replay = await post({ consent_nonce: nonce, action: 'continue', agent_id: '__bootstrap__', first_agent_name: 'Ada' }, cookie)
        expect(replay.status).toBe(400)
        expect(await replay.text()).toBe(EXPIRED)
      }
      expect(count('agents')).toBe(agentsBefore + 1)
      expect(count('member_tokens')).toBe(tokens)
      expect(oauthProvider.completeAuthorization).toHaveBeenCalledTimes(1)
    },
  )

  it('exactly 128 characters is accepted (boundary)', async () => {
    const { nonce } = await reachConsentScreen()
    expect((await bootstrap(nonce, 'y'.repeat(128))).status).toBe(302)
  })

  it('a decline with a blank first-agent name is still just a decline (consumed, 200)', async () => {
    const { nonce } = await reachConsentScreen()
    const res = await post({ consent_nonce: nonce, action: 'decline', agent_id: '__bootstrap__', first_agent_name: '' }, cookieFor(nonce))
    expect(res.status).toBe(200)
    expect(kv._store.has(pendingKey(nonce))).toBe(false)
  })
})

describe('every bootstrapSelf refusal is final: consumed, cookie cleared, a true next step', () => {
  const bootstrap = (nonce: string, name: string) =>
    post({ consent_nonce: nonce, action: 'continue', agent_id: '__bootstrap__', first_agent_name: name }, cookieFor(nonce))
  const memberIdOf = (email: string) => (harness.sqlite.prepare('SELECT id FROM members WHERE email = ?').get(email) as { id: string }).id

  function expectSpent(res: Response, nonce: string) {
    expect(res.headers.get('Set-Cookie') ?? '').toContain('Max-Age=0')
    expect(kv._store.has(pendingKey(nonce))).toBe(false)
    expect(oauthProvider.completeAuthorization).not.toHaveBeenCalled()
  }

  it('provisioning_failed: 500, may-not-have-completed wording (never "nothing was left behind"), no put of the record', async () => {
    const { nonce } = await reachConsentScreen()
    const agentsBefore = count('agents')
    harness.sqlite.exec(`INSERT INTO departments (id, slug, name, kind) VALUES ('squat', 'dept-home-${memberIdOf(NEWCOMER)}', 'Squat', 'work')`)
    kv._calls.length = 0

    const res = await bootstrap(nonce, 'Ada')
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).toBe('Creating the agent may not have completed. If your app already shows the connection working, there is nothing more to do; otherwise start the connection again from your app.')
    expect(text).not.toContain('left behind')
    expectSpent(res, nonce)
    expect(count('agents')).toBe(agentsBefore)
    expect(kv._calls.filter((c) => c.op === 'put' && c.key === pendingKey(nonce))).toEqual([])

    // Fixing the cause does not reopen the page.
    harness.sqlite.exec(`DELETE FROM departments WHERE id = 'squat'`)
    const retry = await bootstrap(nonce, 'Ada')
    expect(retry.status).toBe(400)
    expect(await retry.text()).toBe(EXPIRED)
    expect(count('agents')).toBe(agentsBefore)
  })

  it('rate_limited: 429, Retry-After from detail.retry_after_seconds (3600), about-an-hour wording, final', async () => {
    const { nonce } = await reachConsentScreen()
    kv._store.set(`bootstrap-self-rl:${memberIdOf(NEWCOMER)}`, '5')
    const res = await bootstrap(nonce, 'Ada')
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('3600')
    expect(await res.text()).toBe('Too many first-agent attempts. Nothing was created. Wait about 1 hour, then start the connection again from your app.')
    expectSpent(res, nonce)
    expect(count('agents')).toBe(0)
  })

  it('already_bootstrapped: 400, hedged wording with the org-admin fallback, final', async () => {
    const first = await reachConsentScreen()
    expect((await bootstrap(first.nonce, 'Ada')).status).toBe(302)
    oauthProvider.completeAuthorization.mockClear()

    const second = await reachConsentScreen()
    const res = await bootstrap(second.nonce, 'Bob')
    expect(res.status).toBe(400)
    expect(await res.text()).toBe('You have already created your first agent. Start the connection again from your app and look for it in the list; if it is not there, ask an org admin to give you access to it.')
    expectSpent(res, second.nonce)
    expect(count('agents')).toBe(1)
  })
})

describe('concurrency: a refusing post can never re-open a nonce a concurrent post already spent', () => {
  it('forced interleaving: refusing post A reads the record, succeeding post B runs to completion, then A finishes; no live record, no third mint', async () => {
    const { nonce } = await reachConsentScreen()
    const memberId = (harness.sqlite.prepare('SELECT id FROM members WHERE email = ?').get(NEWCOMER) as { id: string }).id
    // A will be refused by bootstrapSelf (provisioning_failed), not by the pre-consume name check.
    harness.sqlite.exec(`INSERT INTO departments (id, slug, name, kind) VALUES ('squat', 'dept-home-${memberId}', 'Squat', 'work')`)

    // Hold A at its consume (delete) until B has fully finished.
    let releaseA!: () => void
    const gate = new Promise<void>((r) => { releaseA = r })
    const realDelete = kv.delete.bind(kv)
    let held = false
    kv.delete = async (key: string) => {
      if (key === pendingKey(nonce) && !held) { held = true; await gate }
      return realDelete(key)
    }
    kv._calls.length = 0

    const a = post({ consent_nonce: nonce, action: 'continue', agent_id: '__bootstrap__', first_agent_name: 'Ada' }, cookieFor(nonce))
    // Let A read the record and park on its delete.
    for (let i = 0; i < 50 && !held; i++) await new Promise((r) => setTimeout(r, 5))
    expect(held).toBe(true)
    const b = await post({ consent_nonce: nonce, action: 'continue', agent_id: '' }, cookieFor(nonce))
    expect(b.status).toBe(302)
    releaseA()
    const aRes = await a

    expect(aRes.status).toBe(500) // refused, as before
    expect(kv._store.has(pendingKey(nonce))).toBe(false) // nothing re-opened it
    expect(kv._calls.filter((c) => c.op === 'put' && c.key === pendingKey(nonce))).toEqual([])
    expect(oauthProvider.completeAuthorization).toHaveBeenCalledTimes(1)
    expect(count('member_tokens')).toBe(1)

    // A third post (the PoC's second mint) is refused.
    const c = await post({ consent_nonce: nonce, action: 'continue', agent_id: '' }, cookieFor(nonce))
    expect(c.status).toBe(400)
    expect(oauthProvider.completeAuthorization).toHaveBeenCalledTimes(1)
    expect(count('member_tokens')).toBe(1)
  })

  it('a refusing post after a Decline cannot undo the decline', async () => {
    const { nonce } = await reachConsentScreen()
    expect((await post({ consent_nonce: nonce, action: 'decline' }, cookieFor(nonce))).status).toBe(200)
    const bad = await post({ consent_nonce: nonce, action: 'continue', agent_id: '__bootstrap__', first_agent_name: '' }, cookieFor(nonce))
    expect(bad.status).toBe(400)
    expect(kv._store.has(pendingKey(nonce))).toBe(false)
    expect((await post({ consent_nonce: nonce, action: 'continue', agent_id: '' }, cookieFor(nonce))).status).toBe(400)
    expect(oauthProvider.completeAuthorization).not.toHaveBeenCalled()
  })
})

describe('__mint_new__ refusals stay consumed and give a true next step', () => {
  const SQUAD_ADMIN = 'minter@example.test'
  function seedMinter(existingAgents: number) {
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-m', 'm', 'M');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-m', 'dept-m', 'squad-m', 'Squad M');
      INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('mem-minter', '${SQUAD_ADMIN}', 'Minter', 'active', '2026-08-01T00:00:00.000Z', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-minter', 'mem-minter', 'squad', 'squad-m', 'admin');
    `)
    for (let i = 0; i < existingAgents; i++) {
      harness.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('ag-${i}', 'squad-m', 'taken-slug${i === 0 ? '' : i}', 'Existing ${i}', 'active')`)
    }
  }
  const mint = (nonce: string, fields: Record<string, string>) =>
    post({ consent_nonce: nonce, action: 'continue', agent_id: '__mint_new__', new_agent_squad_id: 'squad-m', ...fields }, cookieFor(nonce))

  function expectSpent(res: Response, nonce: string) {
    expect(res.headers.get('Set-Cookie') ?? '').toContain('Max-Age=0')
    expect(kv._store.has(pendingKey(nonce))).toBe(false)
    expect(oauthProvider.completeAuthorization).not.toHaveBeenCalled()
  }

  it('slug_taken: pinned message, consumed, cookie cleared', async () => {
    seedMinter(1)
    const { nonce } = await reachConsentScreen(SQUAD_ADMIN)
    const res = await mint(nonce, { new_agent_name: 'Other', new_agent_slug: 'taken-slug' })
    expect(res.status).toBe(400)
    expect(await res.text()).toBe('That agent name is already taken. Start the connection again from your app, then pick a different name or choose the existing agent.')
    expectSpent(res, nonce)
  })

  it('agent_limit_reached: names the limit and an org admin, not the name', async () => {
    seedMinter(2) // free tier allows 2 work agents
    const { nonce } = await reachConsentScreen(SQUAD_ADMIN)
    const res = await mint(nonce, { new_agent_name: 'Third', new_agent_slug: 'third' })
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).toBe('This organisation has reached its agent limit, so a new agent cannot be created. Ask an org admin to free a slot or raise the limit, then start the connection again from your app.')
    expect(text).not.toContain('name')
    expectSpent(res, nonce)
  })

  it('invalid_slug: general next step, consumed', async () => {
    seedMinter(0)
    const { nonce } = await reachConsentScreen(SQUAD_ADMIN)
    const res = await mint(nonce, { new_agent_name: 'Fine', new_agent_slug: 'Bad Slug!' })
    expect(res.status).toBe(400)
    expect(await res.text()).toBe('The agent name could not be turned into a valid short name. Start the connection again from your app and use letters and numbers.')
    expectSpent(res, nonce)
  })

  it('no name or squad: consumed, cookie cleared, pinned message', async () => {
    const { nonce } = await reachConsentScreen()
    const res = await post({ consent_nonce: nonce, action: 'continue', agent_id: '__mint_new__' }, cookieFor(nonce))
    expect(res.status).toBe(400)
    expect(await res.text()).toBe('A new agent needs a name and a home squad. Start the connection again from your app and fill in both.')
    expectSpent(res, nonce)
  })
})

describe('other refusals on this handler carry a next step, never "sign in again"', () => {
  it('missing consent_nonce and missing agent_id (page stays usable: nothing consumed)', async () => {
    const noNonce = await post({ action: 'continue', agent_id: '' }, null)
    expect(noNonce.status).toBe(400)
    expect(await noNonce.text()).toBe('This page is missing its session. Start the connection again from your app.')
    const { nonce } = await reachConsentScreen()
    const noChoice = await post({ consent_nonce: nonce, action: 'continue' }, cookieFor(nonce))
    expect(noChoice.status).toBe(400)
    expect(await noChoice.text()).toBe('Missing agent_id: explicit consent choice is required. Choose an option on the page, then continue.')
    expect(kv._store.has(pendingKey(nonce))).toBe(true)
  })

  it('callback reload/Back: refused, no state change, tells the person to start again', async () => {
    const before = [...kv._store.keys()]
    const res = await handleOAuthAuthorize(new Request('https://pot.test/oauth/google-callback?code=abc&state=00000000-0000-4000-8000-000000000000'), env)
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('This sign-in page was already used or came from a different browser. Start the connection again from your app.')
    expect([...kv._store.keys()]).toEqual(before)
    expect(count('members')).toBe(0)
    expect(oauthProvider.completeAuthorization).not.toHaveBeenCalled()
  })
})

describe('the consent page script (pinned as text; no DOM here, so browser behaviour is NOT exercised)', () => {
  it('has the flag guard after the validations, a visible message, a pageshow reset, a timeout reset, and never disables anything', async () => {
    const { html } = await reachConsentScreen()
    const start = html.indexOf("form.addEventListener('submit'")
    const script = html.slice(start, html.indexOf('</script>', start))
    expect(html).toContain('var submitted = false')
    expect(script).toContain('if (submitted) { e.preventDefault(); return }')
    expect(script).toContain('submitted = true')
    expect(script).toContain("window.addEventListener('pageshow', function () { submitted = false })")
    expect(script).toContain("summaryText.textContent = 'Working on it...'")
    expect(script).toContain('setTimeout(function () { submitted = false; updateSummary() }, 10000)')
    // Order: choice check, then first-agent name check, then the guard, then the flag.
    const order = ['Choose an option before continuing.', 'Give your first agent a name before continuing.', 'if (submitted)', 'submitted = true', 'Working on it...']
    const at = order.map((m) => script.indexOf(m))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((x, y) => x - y)).toEqual(at)
    // The name check is skipped for decline and keyed on the first-agent radio's marker attribute
    // (not its value, so a page that does not offer the door never contains the sentinel).
    expect(script).toContain("picked.hasAttribute('data-first-agent')")
    expect(script).not.toContain('__bootstrap__')
    expect(script).not.toMatch(/action === 'decline'\) return/)
    const code = script.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/disabled/)
    expect(html).not.toMatch(/\.disabled\s*=/)
    expect(html).not.toMatch(/setAttribute\(['"]disabled/)
  })
})
