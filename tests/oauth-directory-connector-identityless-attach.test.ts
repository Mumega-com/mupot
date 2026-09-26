// tests/oauth-directory-connector-identityless-attach.test.ts — mupot#1551
// round 2, P0 regression fix: the MCP directory-OAuth connector's own
// "continue unbound" token (mintDirectoryToken, src/mcp/oauth-authorize.ts,
// channel='directory', agent_id NULL, expires_at NULL) used to be treated as
// a competing controller by decideIdentitylessAttach — so a SECOND connect,
// a case-variant reconnect, or a later ordinary web Google login for the
// SAME human all broke: 500 "Member provisioning failed" (UNIQUE), a
// duplicate member row, or a login that resolved to nothing.
//
// Fix (two parts, both exercised here through the REAL /oauth/google-callback
// + /oauth/consent HTTP flow, same pattern as
// tests/agent-bound-oauth-consent.test.ts):
//   (a) mintDirectoryToken's own consent-completion now ALSO calls
//       linkLoginIdentity (guarded, requireExclusiveControl) for the
//       connecting human's real (provider, subject) — so a row that mints a
//       NEW directory token today is never identity-less again.
//   (b) decideIdentitylessAttach exempts a live unbound channel='directory'
//       token the same way it exempts the admin/dashboard provisioning seed
//       — containment for the population that already held one before (a).
//   (c) findOrCreateHumanMember now receives the tri-state from
//       resolveHumanMemberForAttach and REFUSES (MemberAttachDeniedError,
//       403/409) on denied/ambiguous instead of collapsing to "not found"
//       and inserting a duplicate.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { handleOAuthAuthorize } from '../src/mcp/oauth-authorize'
import { authApp } from '../src/auth'
import type { Env } from '../src/types'

const TENANT = 'mumega'
const ORIGIN = 'https://pot.test'

function memoryKv() {
  const store = new Map<string, string>()
  return {
    store,
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
  }
}

function stubOAuthProvider() {
  return {
    parseAuthRequest: vi.fn(async () => ({ clientId: 'client-1', scope: ['mcp:read', 'mcp:write'] })),
    completeAuthorization: vi.fn(async () => ({ redirectTo: 'https://client.example.test/callback?code=xyz' })),
  }
}

// Two different modules, two different Google userinfo endpoint shapes:
// oauth-authorize.ts (the MCP directory connector) hits
// googleapis.com/oauth2/v2/userinfo with {id, verified_email}; src/auth's own
// ordinary web login hits openidconnect.googleapis.com/v1/userinfo with
// {sub, email_verified}. This suite drives both, so the stub answers both.
function stubGoogleFetch(email: string, googleId: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'gtok' }), { status: 200 })
      }
      if (url.includes('googleapis.com/oauth2/v2/userinfo')) {
        return new Response(
          JSON.stringify({ id: googleId, name: 'Human', email, verified_email: true }),
          { status: 200 },
        )
      }
      if (url.includes('openidconnect.googleapis.com/v1/userinfo')) {
        return new Response(
          JSON.stringify({ sub: googleId, name: 'Human', email, email_verified: true }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

function httpEnv(harnessRef: SqliteD1Harness, oauthProvider: ReturnType<typeof stubOAuthProvider>, kv = memoryKv()) {
  const env = {
    DB: harnessRef.db,
    TENANT_SLUG: TENANT,
    BRAND: 'mupot',
    POT_TIER: 'scale',
    GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    SESSIONS: kv,
    OAUTH_PROVIDER: oauthProvider,
    BUS: { send: async () => {} },
  } as unknown as Env
  return { env, kv }
}

/** Drives GET /authorize -> GET /oauth/google-callback -> POST /oauth/consent
 *  {action:'continue', agent_id:''} (the default "continue unbound" choice),
 *  returning the final response and the props handed to completeAuthorization. */
async function connectUnbound(
  env: Env,
  oauthProvider: ReturnType<typeof stubOAuthProvider>,
  email: string,
  googleId: string,
): Promise<{ res: Response; memberId: string | undefined }> {
  const authorizeReq = new Request(
    `${ORIGIN}/authorize?client_id=client-1&response_type=code&redirect_uri=https://client.example.test/callback&code_challenge=abc&code_challenge_method=S256`,
  )
  const authorizeRes = await handleOAuthAuthorize(authorizeReq, env)
  const setCookie = authorizeRes.headers.get('Set-Cookie') ?? ''
  const nonce = /mupot_oauth_nonce=([^;]+)/.exec(setCookie)![1]

  stubGoogleFetch(email, googleId)
  const callbackReq = new Request(
    `${ORIGIN}/oauth/google-callback?code=abc&state=${nonce}`,
    { headers: { Cookie: `mupot_oauth_nonce=${nonce}` } },
  )
  const callbackRes = await handleOAuthAuthorize(callbackReq, env)
  if (callbackRes.status !== 200) {
    return { res: callbackRes, memberId: undefined }
  }
  const cookies = callbackRes.headers.getSetCookie
    ? callbackRes.headers.getSetCookie()
    : [callbackRes.headers.get('Set-Cookie') ?? '']
  const consentCookieLine = cookies.find((c) => c.startsWith('mupot_oauth_consent=')) ?? ''
  const consentNonce = /mupot_oauth_consent=([^;]+)/.exec(consentCookieLine)?.[1] ?? ''

  const form = new URLSearchParams({ consent_nonce: consentNonce, action: 'continue', agent_id: '' })
  const consentReq = new Request(`${ORIGIN}/oauth/consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `mupot_oauth_consent=${consentNonce}` },
    body: form.toString(),
  })
  const res = await handleOAuthAuthorize(consentReq, env)
  const call = oauthProvider.completeAuthorization.mock.calls.at(-1)?.[0]
  return { res, memberId: call?.props?.memberId }
}

function memberCount(harness: SqliteD1Harness, email: string): number {
  return (
    harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM members WHERE lower(email) = lower(?)`).get(email) as {
      n: number
    }
  ).n
}

function identityCount(harness: SqliteD1Harness, memberId?: string): number {
  if (memberId) {
    return (
      harness.sqlite
        .prepare(`SELECT COUNT(*) AS n FROM human_login_identities WHERE member_id = ?`)
        .get(memberId) as { n: number }
    ).n
  }
  return (harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM human_login_identities`).get() as { n: number }).n
}

function directoryTokenCount(harness: SqliteD1Harness, memberId: string): number {
  return (
    harness.sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM member_tokens WHERE member_id = ? AND channel = 'directory' AND revoked_at IS NULL`,
      )
      .get(memberId) as { n: number }
  ).n
}

describe('directory-OAuth connector — identity-less attach (mupot#1551 round 2 P0)', () => {
  let harness: SqliteD1Harness
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
  })
  afterEach(() => {
    harness.close()
    vi.unstubAllGlobals()
  })

  it('reconnecting unbound TWICE succeeds both times and creates exactly ONE member row', async () => {
    const oauthProvider = stubOAuthProvider()
    const { env, kv } = httpEnv(harness, oauthProvider)

    const first = await connectUnbound(env, oauthProvider, 'connector@example.com', 'google-sub-connector')
    expect(first.res.status).toBe(302)
    expect(first.memberId).toBeTruthy()
    expect(memberCount(harness, 'connector@example.com')).toBe(1)
    // Part (a) of the fix: the first "continue unbound" mint also links the
    // real identity — this member is no longer identity-less afterward.
    expect(identityCount(harness, first.memberId)).toBe(1)

    // Fresh consent round trip — same human, same browser, reconnecting the
    // connector (e.g. a token expired client-side, or a re-auth flow).
    kv.store.clear()
    const second = await connectUnbound(env, oauthProvider, 'connector@example.com', 'google-sub-connector')
    expect(second.res.status).toBe(302)
    expect(second.memberId).toBe(first.memberId)
    expect(memberCount(harness, 'connector@example.com')).toBe(1)
    expect(identityCount(harness, first.memberId)).toBe(1) // idempotent, not a second row
  })

  it('connector-first, then an ordinary web Google login: same member, real identity + web session', async () => {
    const oauthProvider = stubOAuthProvider()
    const { env, kv } = httpEnv(harness, oauthProvider)

    const connected = await connectUnbound(env, oauthProvider, 'bothdoors@example.com', 'google-sub-bothdoors')
    expect(connected.res.status).toBe(302)
    const memberId = connected.memberId!
    expect(directoryTokenCount(harness, memberId)).toBe(1)

    // Now the SAME human does an ordinary web login (src/auth's /login +
    // /callback), same Google subject.
    const webEnv = {
      DB: harness.db,
      TENANT_SLUG: TENANT,
      BRAND: 'mupot',
      PUBLIC_ORIGIN: ORIGIN,
      OAUTH_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
      OAUTH_CLIENT_SECRET: 'test-client-secret',
      SESSIONS: kv,
    } as unknown as Env
    stubGoogleFetch('bothdoors@example.com', 'google-sub-bothdoors')
    const loginRes = await authApp.request(`${ORIGIN}/login`, {}, webEnv)
    const state = new URL(loginRes.headers.get('location') ?? '').searchParams.get('state')!
    const callbackRes = await authApp.fetch(
      new Request(`${ORIGIN}/callback?code=abc&state=${encodeURIComponent(state)}`),
      webEnv,
    )
    expect(callbackRes.status).toBe(302)

    // Exactly one identity (idempotent re-resolve via step 1, not a second
    // row), and the web session actually registered against THAT member.
    expect(identityCount(harness, memberId)).toBe(1)
    const webSession = harness.sqlite
      .prepare(`SELECT member_id FROM web_sessions WHERE tenant = ? AND revoked_at IS NULL`)
      .get(TENANT) as { member_id: string } | undefined
    expect(webSession?.member_id).toBe(memberId)
  })

  it('a case-variant email collision refuses the connector attach — 403/409, no duplicate member row', async () => {
    // Pre-existing ambiguity: two members already share the same normalized
    // email in different case (e.g. a legacy import, or two invites typed
    // differently) — a real, if rare, prod shape this attach must fail
    // closed on rather than silently pick one or insert a third.
    harness.sqlite.exec(`
      INSERT INTO members (id, tenant, email, display_name, status, created_at)
        VALUES ('mem-dup-1', '${TENANT}', 'Dup@Example.com', 'Dup One', 'active', datetime('now'));
      INSERT INTO members (id, tenant, email, display_name, status, created_at)
        VALUES ('mem-dup-2', '${TENANT}', 'dup@example.com', 'Dup Two', 'active', datetime('now'));
    `)
    const before = memberCount(harness, 'dup@example.com')
    expect(before).toBe(2)

    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)

    const authorizeReq = new Request(
      `${ORIGIN}/authorize?client_id=client-1&response_type=code&redirect_uri=https://client.example.test/callback&code_challenge=abc&code_challenge_method=S256`,
    )
    const authorizeRes = await handleOAuthAuthorize(authorizeReq, env)
    const nonce = /mupot_oauth_nonce=([^;]+)/.exec(authorizeRes.headers.get('Set-Cookie') ?? '')![1]
    stubGoogleFetch('dup@example.com', 'google-sub-dup')
    const callbackReq = new Request(
      `${ORIGIN}/oauth/google-callback?code=abc&state=${nonce}`,
      { headers: { Cookie: `mupot_oauth_nonce=${nonce}` } },
    )
    const res = await handleOAuthAuthorize(callbackReq, env)

    // MemberAttachDeniedError('member_attach_ambiguous') -> 409.
    expect(res.status).toBe(409)
    expect(oauthProvider.completeAuthorization).not.toHaveBeenCalled()
    expect(memberCount(harness, 'dup@example.com')).toBe(2) // no duplicate, no third row
  })

  it('the OLD bug, proved on a pre-existing directory-token-no-identity row: reconnect no longer 500s or duplicates', async () => {
    // Simulates a row that already went through the connector BEFORE this
    // fix shipped: a live unbound directory token, but no linked identity
    // (part (a) of the fix never ran for it). Part (b)'s exemption is
    // exactly the containment for this population.
    harness.sqlite.exec(`
      INSERT INTO members (id, tenant, email, display_name, status, created_at)
        VALUES ('mem-legacy-connector', '${TENANT}', 'legacy@example.com', 'Legacy', 'active', datetime('now'));
      INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
        VALUES ('tok-legacy-directory', 'mem-legacy-connector', 'hash-legacy', 'oauth:legacy', 'directory', datetime('now'), NULL, '${TENANT}');
    `)
    expect(identityCount(harness, 'mem-legacy-connector')).toBe(0)

    const oauthProvider = stubOAuthProvider()
    const { env } = httpEnv(harness, oauthProvider)
    const result = await connectUnbound(env, oauthProvider, 'legacy@example.com', 'google-sub-legacy')

    expect(result.res.status).toBe(302)
    expect(result.memberId).toBe('mem-legacy-connector')
    expect(memberCount(harness, 'legacy@example.com')).toBe(1) // no duplicate
    // Reconnecting now ALSO links the real identity going forward.
    expect(identityCount(harness, 'mem-legacy-connector')).toBe(1)
  })

  it('P1-b: a competing bearer inserted BETWEEN google-callback and the consent POST makes the mint-time identity link fail — no identity linked (requireExclusiveControl pin)', async () => {
    const oauthProvider = stubOAuthProvider()
    const { env, kv } = httpEnv(harness, oauthProvider)

    const authorizeReq = new Request(
      `${ORIGIN}/authorize?client_id=client-1&response_type=code&redirect_uri=https://client.example.test/callback&code_challenge=abc&code_challenge_method=S256`,
    )
    const authorizeRes = await handleOAuthAuthorize(authorizeReq, env)
    const nonce = /mupot_oauth_nonce=([^;]+)/.exec(authorizeRes.headers.get('Set-Cookie') ?? '')![1]
    stubGoogleFetch('racewindow@example.com', 'google-sub-racewindow')
    const callbackReq = new Request(
      `${ORIGIN}/oauth/google-callback?code=abc&state=${nonce}`,
      { headers: { Cookie: `mupot_oauth_nonce=${nonce}` } },
    )
    const callbackRes = await handleOAuthAuthorize(callbackReq, env)
    expect(callbackRes.status).toBe(200)
    const cookies = callbackRes.headers.getSetCookie
      ? callbackRes.headers.getSetCookie()
      : [callbackRes.headers.get('Set-Cookie') ?? '']
    const consentCookieLine = cookies.find((c) => c.startsWith('mupot_oauth_consent=')) ?? ''
    const consentNonce = /mupot_oauth_consent=([^;]+)/.exec(consentCookieLine)?.[1] ?? ''

    // Read the freshly-created member id straight out of the pending-consent
    // KV record the callback just wrote — the human is now sitting on the
    // consent screen, memberId already resolved, identity NOT yet linked
    // (that only happens at mint time, on the POST below).
    const pendingRaw = await kv.get(`oauth-consent:${consentNonce}`, 'json')
    const pending = pendingRaw as { memberId: string } | null
    expect(pending?.memberId).toBeTruthy()
    const memberId = pending!.memberId
    expect(identityCount(harness, memberId)).toBe(0)

    // THE RACE: a competing bearer lands on this exact row while the human
    // is looking at the consent screen — e.g. a concurrent public invite
    // accept on the same email, landing between the callback and the
    // consent submission.
    harness.sqlite.exec(`
      INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
        VALUES ('tok-race', '${memberId}', 'hash-race', 'workspace', 'workspace', datetime('now'), NULL, '${TENANT}');
    `)

    const form = new URLSearchParams({ consent_nonce: consentNonce, action: 'continue', agent_id: '' })
    const consentReq = new Request(`${ORIGIN}/oauth/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `mupot_oauth_consent=${consentNonce}` },
      body: form.toString(),
    })
    const consentRes = await handleOAuthAuthorize(consentReq, env)

    // The mint itself is unconditional (mintDirectoryToken doesn't check
    // exclusive control) — the consent flow still completes...
    expect(consentRes.status).toBe(302)
    expect(directoryTokenCount(harness, memberId)).toBe(1)
    // ...but the identity link, guarded by requireExclusiveControl, must
    // fail atomically against the race — never land.
    expect(identityCount(harness, memberId)).toBe(0)
  })
})
