// tests/onboarding-deadlock-901.test.ts — mupot#901: "first-run onboarding is a
// deadlock — OAuth mints an unbound operator and there is no way to self-serve
// an agent identity."
//
// WHAT THIS PROVES (end-to-end, no pre-existing rows, no operator):
//   1. A GENUINELY FRESH Google account (no members row exists yet anywhere)
//      hits /authorize -> /oauth/google-callback for the first time ever. The
//      consent screen it lands on offers NOTHING but "continue unbound" — this
//      is the literal deadlock #901 was filed from, reproduced against real
//      migrated SQLite, not asserted from reading the code.
//   2. The SAME human, still on that same unbound directory session, calls the
//      bootstrap_self MCP tool (mupot#925/#928) and names an agent. No operator
//      touches D1. No pre-existing row is required.
//   3. The human reconnects (a second, independent /authorize round — exactly
//      what a real OAuth client does when told to "reconnect" or when its
//      stored session is invalidated) and lands on the consent screen AGAIN.
//      This time their own newly-created home agent is offered, because
//      bootstrap_self's founder grant gave them squad:admin on its home squad
//      (P0-3's floor for /oauth/consent eligibility).
//   4. They select it. POST /oauth/consent re-validates and completes. The
//      resulting session is agent-bound and capability-bearing — not empty,
//      not the human's own standing grants, exactly the agent's own grant set.
//
// This is a SEAM test: bootstrap-self.ts and oauth-authorize.ts each have their
// own exhaustive unit suites (tests/bootstrap-self.test.ts,
// tests/agent-bound-oauth-consent.test.ts), but nothing before this file drove
// them TOGETHER — bootstrap-self.ts's own doc comment asserts the human "can
// clear [the consent floor] honestly" afterward; that claim was never actually
// exercised against the real /oauth/consent HTTP handler. See the PR body for
// the before/after run this file was written to produce.

import { describe, it, expect, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  buildAuthContextFromProps,
  handleOAuthAuthorize,
  listConsentableAgents,
} from '../src/mcp/oauth-authorize'
import { bootstrapSelf } from '../src/members/bootstrap-self'
import type { Env } from '../src/types'

const TENANT = 'mumega'
const FRESH_EMAIL = 'brand-new-user@example.test'

function memoryKv() {
  const store = new Map<string, string>()
  return {
    async get(key: string, type?: string) {
      const v = store.get(key)
      if (v === undefined) return null
      return type === 'json' ? JSON.parse(v) : v
    },
    async put(key: string, value: string) {
      store.set(key, value)
    },
    async delete(key: string) {
      store.delete(key)
    },
    _store: store,
  }
}

function stubOAuthProvider() {
  return {
    parseAuthRequest: vi.fn(async () => ({ clientId: 'client-1', scope: ['mcp:read', 'mcp:write'] })),
    completeAuthorization: vi.fn(async () => ({ redirectTo: 'https://client.example.test/callback?code=xyz' })),
  }
}

function stubGoogleFetch(email: string, googleId = 'google-sub-fresh') {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'gtok' }), { status: 200 })
    }
    if (url.includes('googleapis.com/oauth2/v2/userinfo')) {
      return new Response(
        JSON.stringify({ id: googleId, name: 'Brand New User', email, verified_email: true }),
        { status: 200 },
      )
    }
    throw new Error(`unexpected fetch: ${url}`)
  }))
}

function httpEnv(harnessRef: SqliteD1Harness, oauthProvider: ReturnType<typeof stubOAuthProvider>) {
  const kv = memoryKv()
  const env = {
    DB: harnessRef.db,
    TENANT_SLUG: TENANT,
    BRAND: 'mupot',
    GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    SESSIONS: kv,
    OAUTH_PROVIDER: oauthProvider,
    BUS: { send: async () => {} },
  } as unknown as Env
  return { env, kv }
}

/** Drives one full /authorize -> /oauth/google-callback round for `email`,
 *  returns the rendered consent page + the cookie needed to POST /oauth/consent. */
async function reachConsentScreen(
  env: Env,
  email: string,
): Promise<{ res: Response; html: string; consentCookie: string }> {
  const authorizeReq = new Request(
    'https://pot.test/authorize?client_id=client-1&response_type=code&redirect_uri=https://client.example.test/callback&code_challenge=abc&code_challenge_method=S256',
  )
  const authorizeRes = await handleOAuthAuthorize(authorizeReq, env)
  const authSetCookie = authorizeRes.headers.get('Set-Cookie') ?? ''
  const nonceMatch = /mupot_oauth_nonce=([^;]+)/.exec(authSetCookie)
  const nonce = nonceMatch![1]

  stubGoogleFetch(email)
  const callbackReq = new Request(
    `https://pot.test/oauth/google-callback?code=abc&state=${nonce}`,
    { headers: { Cookie: `mupot_oauth_nonce=${nonce}` } },
  )
  const res = await handleOAuthAuthorize(callbackReq, env)
  const html = await res.clone().text()
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('Set-Cookie') ?? '']
  const consentCookieLine = cookies.find((c) => c.startsWith('mupot_oauth_consent=')) ?? ''
  const consentNonceMatch = /mupot_oauth_consent=([^;]+)/.exec(consentCookieLine)
  return { res, html, consentCookie: consentNonceMatch ? consentNonceMatch[1] : '' }
}

let harness: SqliteD1Harness

describe('#901 residual gap — the empty-agent consent screen names the escape hatch', () => {
  it('when zero agents are consentable, the screen tells the caller bootstrap_self exists (not just silent "continue unbound")', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)

    const { html } = await reachConsentScreen(env, FRESH_EMAIL)
    expect(html).toContain('bootstrap_self')

    harness.close()
  })
})

describe('#901 — the first-run deadlock, reproduced and then closed end-to-end', () => {
  it('step 1: a genuinely fresh Google sign-in is offered NOTHING but unbound (no members/agents/squads rows exist before this test runs)', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)

    // Sanity: truly empty pot, no seed of any kind.
    const memberCountBefore = harness.sqlite.prepare('SELECT COUNT(*) AS n FROM members').all()[0].n
    expect(memberCountBefore).toBe(0)

    const { res, html } = await reachConsentScreen(env, FRESH_EMAIL)
    expect(res.status).toBe(200)
    expect(html.toLowerCase()).toContain('unbound')

    // THE DEADLOCK, literally: there is exactly one radio input on this page
    // (the "no agent" default) — no selectable agent was ever offered, and
    // nothing on this screen lets the human create one.
    const radioCount = (html.match(/<input type="radio" name="agent_id"/g) ?? []).length
    expect(radioCount).toBe(1)

    harness.close()
  })

  it('steps 2-4: bootstrap_self + reconnect + consent closes the loop — the resulting session is agent-bound and capability-bearing', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)

    // ── Step 1 (repeated): first contact, unbound, zero agents offered.
    const first = await reachConsentScreen(env, FRESH_EMAIL)
    expect(first.html.toLowerCase()).toContain('unbound')

    const humanRow = harness.sqlite
      .prepare('SELECT id FROM members WHERE email = ?')
      .get(FRESH_EMAIL) as { id: string } | undefined
    expect(humanRow).toBeDefined()
    const humanMemberId = humanRow!.id

    // ── Step 2: the human, still on this exact unbound directory session,
    // calls bootstrap_self and names an agent. No operator. No pre-existing row.
    const bootstrapResult = await bootstrapSelf(
      env,
      { channel: 'directory', boundAgentId: null, memberId: humanMemberId },
      'My First Agent',
    )
    expect(bootstrapResult.ok).toBe(true)
    if (!bootstrapResult.ok) throw new Error('unreachable')
    const newAgentId = bootstrapResult.agent.id

    // The founder grant is what's supposed to let the human clear /oauth/consent's
    // admin floor honestly on a second round — assert it landed before trusting that.
    expect(bootstrapResult.founder_grant.capability).toBe('admin')
    expect(bootstrapResult.founder_grant.member_id).toBe(humanMemberId)

    // listConsentableAgents (the exact function the consent screen renders from)
    // must now include the freshly bootstrapped agent.
    const consentable = await listConsentableAgents(env, humanMemberId)
    expect(consentable.map((a) => a.id)).toContain(newAgentId)

    // ── Step 3: reconnect — a second, independent /authorize round for the
    // SAME human (this is what a real MCP client does on reconnect/re-auth).
    const second = await reachConsentScreen(env, FRESH_EMAIL)
    expect(second.res.status).toBe(200)
    expect(second.html).toContain(bootstrapResult.agent.slug)
    expect(second.html).toContain(bootstrapResult.agent.name)

    // ── Step 4: select the new agent and complete.
    const form = new URLSearchParams({
      consent_nonce: second.consentCookie,
      action: 'continue',
      agent_id: newAgentId,
    })
    const consentReq = new Request('https://pot.test/oauth/consent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `mupot_oauth_consent=${second.consentCookie}`,
      },
      body: form.toString(),
    })
    const consentRes = await handleOAuthAuthorize(consentReq, env)
    expect(consentRes.status).toBe(302)
    expect(oauthProvider.completeAuthorization).toHaveBeenCalledTimes(1)

    const completedProps = oauthProvider.completeAuthorization.mock.calls[0][0].props
    expect(completedProps.boundAgentId).toBe(newAgentId)

    // ── The end state the acceptance criterion actually cares about: a LIVE
    // request against these exact props resolves to a non-empty, agent-owned
    // capability set — an authenticated, capability-bearing session, reached
    // with zero operator intervention and zero pre-existing rows.
    const authContext = await buildAuthContextFromProps(env, completedProps)
    expect(authContext).not.toBeNull()
    expect(authContext!.boundAgentId).toBe(newAgentId)
    expect(authContext!.capabilities.length).toBeGreaterThan(0)
    expect(authContext!.capabilities[0]).toMatchObject({
      scope_type: 'squad',
      scope_id: bootstrapResult.squad.id,
      capability: 'member',
    })

    harness.close()
  })
})
