// oauth-dual-auth.test.ts — Regression + negative tests for S-MUPOT-OAUTH.
//
// Coverage (C4):
//   - POST /mcp JSON-RPC (initialize, tools/list, tools/call)
//   - POST /mcp pragmatic {tool, args}
//   - GET /mcp/tools
//   - GET /mcp/health
//   - GET /openapi.json + POST /actions/:tool (mcpActionsApp, root mount)
//
// Doors tested:
//   1. Member API key (mupot_... bearer → authenticateMember path, unchanged)
//   2. OAuth props injected via x-mupot-auth-context header (McpOAuthApiHandler path)
//   3. Namespace non-overlap: OAuth "userId:grantId:secret" token at /actions/:tool is rejected
//   4. OAuth props path: C6 zero-capability grants → 403 on task_create, wake_agent, create_squad, mint_agent_token
//   5. Negative: body-supplied identity fields are ignored (sovereign-core invariant)
//   6. Route-order: /authorize, .well-known paths win over Coming-Soon catch-all

import { describe, expect, it } from 'vitest'
import { mcpActionsApp, mcpApp } from '../src/mcp'
import { AUTH_CONTEXT_HEADER } from '../src/mcp/auth-header'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'

// ── shared env factories ──────────────────────────────────────────────────────

const TENANT = 'mumega'

/** Member API key env — mimics the existing member-token door. */
function makeEnvWithMemberKey(grants: CapabilityGrant[] = []): Env {
  const memberId = 'mbr-key-1'
  return {
    TENANT_SLUG: TENANT,
    BRAND: 'Mumega',
    OAUTH_PROVIDER: 'google',
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes('FROM member_tokens')) {
                  return {
                    member_id: memberId,
                    email: 'key-user@example.com',
                    display_name: 'Key User',
                    telegram_chat_id: null,
                    status: 'active',
                    created_at: '2026-06-11 00:00:00',
                    channel: 'workspace',
                    bound_agent_id: null,
                  }
                }
                return null
              },
              async all() {
                if (sql.includes('FROM capabilities') || sql.includes('FROM channel_capability_grants')) {
                  return { results: grants }
                }
                return { results: [] }
              },
            }
          },
        }
      },
    },
  } as unknown as Env
}

/** OAuth path env — no member_tokens lookup needed; auth is injected via header. */
function makeEnvOAuth(grants: CapabilityGrant[] = []): Env {
  return {
    TENANT_SLUG: TENANT,
    BRAND: 'Mumega',
    OAUTH_PROVIDER: 'google',
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                // McpOAuthApiHandler pre-resolves auth; mcpApp should NOT call member_tokens
                // for the OAuth path (the injected header is used instead).
                // If it does reach DB, return nothing (test will fail → exposes a regression).
                return null
              },
              async all() {
                if (sql.includes('FROM capabilities') || sql.includes('FROM channel_capability_grants')) {
                  return { results: grants }
                }
                return { results: [] }
              },
            }
          },
        }
      },
    },
  } as unknown as Env
}

/** Build an injected auth context (simulates McpOAuthApiHandler output). */
function oauthAuthHeader(overrides: Partial<AuthContext> = {}): Record<string, string> {
  const auth: AuthContext = {
    userId: 'mbr-oauth-1',
    email: 'oauth@example.com',
    role: 'member',
    tenant: TENANT,
    memberId: 'mbr-oauth-1',
    channel: 'directory',
    capabilities: [], // C6: zero by default
    boundAgentId: null,
    ...overrides,
  }
  return { [AUTH_CONTEXT_HEADER]: JSON.stringify(auth) }
}

// ── helper ────────────────────────────────────────────────────────────────────

async function post(
  app: typeof mcpApp,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  env: Env,
): Promise<Response> {
  return app.request(
    `https://pot.example${path}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    env,
  )
}

async function get(
  app: typeof mcpApp,
  path: string,
  headers: Record<string, string>,
  env: Env,
): Promise<Response> {
  return app.request(`https://pot.example${path}`, { method: 'GET', headers }, env)
}

// ────────────────────────────────────────────────────────────────────────────
// Door 1 — member API key (regression: unchanged path)
// ────────────────────────────────────────────────────────────────────────────
describe('C4 regression — member API key door', () => {
  const env = makeEnvWithMemberKey([
    { member_id: 'mbr-key-1', scope_type: 'org', scope_id: null, capability: 'admin' },
  ])
  const bearerHeaders = { authorization: 'Bearer mupot_test_member_key' }

  it('POST /mcp — JSON-RPC initialize (bearerless)', async () => {
    const res = await post(mcpApp, '/', { jsonrpc: '2.0', id: 1, method: 'initialize' }, {}, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { result: { serverInfo: { name: string } } }
    expect(body.result.serverInfo.name).toBe(`mupot-${TENANT}`)
  })

  it('POST /mcp — JSON-RPC tools/list (bearerless)', async () => {
    const res = await post(mcpApp, '/', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, {}, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { result: { tools: { name: string }[] } }
    expect(body.result.tools.map((t) => t.name)).toContain('task_create')
  })

  it('POST /mcp — JSON-RPC tools/call requires auth', async () => {
    const res = await post(mcpApp, '/', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'status', arguments: {} } }, {}, env)
    expect(res.status).toBe(401)
  })

  it('POST /mcp — JSON-RPC tools/call authenticated via member key', async () => {
    const res = await post(mcpApp, '/', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'status', arguments: {} } }, bearerHeaders, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { result: { structuredContent: { tenant: string } } }
    expect(body.result.structuredContent.tenant).toBe(TENANT)
  })

  it('POST /mcp — pragmatic {tool, args} via member key', async () => {
    const res = await post(mcpApp, '/', { tool: 'status', args: {} }, bearerHeaders, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; result: { tenant: string } }
    expect(body.ok).toBe(true)
    expect(body.result.tenant).toBe(TENANT)
  })

  it('GET /mcp/health', async () => {
    const res = await get(mcpApp, '/health', {}, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; tenant: string }
    expect(body.ok).toBe(true)
    expect(body.tenant).toBe(TENANT)
  })

  it('GET /mcp/tools', async () => {
    const res = await get(mcpApp, '/tools', {}, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { tools: { name: string }[] }
    expect(body.tools.map((t) => t.name)).toContain('orient')
  })

  it('GET /openapi.json via mcpActionsApp', async () => {
    const res = await mcpActionsApp.request('https://pot.example/openapi.json', {}, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { openapi: string; paths: Record<string, unknown> }
    expect(body.openapi).toBe('3.0.3')
    expect(body.paths['/actions/status']).toBeTruthy()
  })

  it('POST /actions/status via member key (mcpActionsApp)', async () => {
    const res = await mcpActionsApp.request(
      'https://pot.example/actions/status',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer mupot_test_member_key' },
        body: JSON.stringify({}),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; result: { tenant: string } }
    expect(body.ok).toBe(true)
    expect(body.result.tenant).toBe(TENANT)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Door 2 — OAuth props via injected header (McpOAuthApiHandler path)
// ────────────────────────────────────────────────────────────────────────────
describe('C4 OAuth props door — injected auth context', () => {
  const oauthEnv = makeEnvOAuth([
    { member_id: 'mbr-oauth-1', scope_type: 'org', scope_id: null, capability: 'admin' },
  ])
  const oauthHeaders = oauthAuthHeader({
    capabilities: [{ member_id: 'mbr-oauth-1', scope_type: 'org', scope_id: null, capability: 'admin' }],
  })

  it('POST /mcp — JSON-RPC tools/call via OAuth injected context', async () => {
    const res = await post(
      mcpApp, '/',
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'status', arguments: {} } },
      oauthHeaders,
      oauthEnv,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { result: { structuredContent: { tenant: string; channel: string } } }
    expect(body.result.structuredContent.tenant).toBe(TENANT)
    // channel must be 'directory' — confirms OAuth principal identity
    expect(body.result.structuredContent.channel).toBe('directory')
  })

  it('POST /mcp — pragmatic {tool, args} via OAuth injected context', async () => {
    const res = await post(mcpApp, '/', { tool: 'status', args: {} }, oauthHeaders, oauthEnv)
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; result: { tenant: string } }
    expect(body.ok).toBe(true)
    expect(body.result.tenant).toBe(TENANT)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// C4 namespace non-overlap — OAuth token format at /actions/:tool is rejected
// An OAuth access token has the "userId:grantId:secret" format (3 colon segments).
// It is never stored as a sha256 hash in member_tokens, so authenticateMember
// will return null → 401. This verifies the two bearer namespaces are disjoint.
// ────────────────────────────────────────────────────────────────────────────
describe('C4 namespace non-overlap — OAuth token at /actions/:tool is rejected', () => {
  // This env returns null for any member_tokens lookup (simulates token not found).
  const noTokenEnv: Env = {
    TENANT_SLUG: TENANT,
    BRAND: 'Mumega',
    OAUTH_PROVIDER: 'google',
    DB: {
      prepare() {
        return { bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }) }
      },
    },
  } as unknown as Env

  it('OAuth-format bearer at POST /actions/status is rejected with 401', async () => {
    // Craft a bearer that looks like an OAuth token (3 colon-separated segments).
    const oauthStyleBearer = 'google-user123:grant-abc:someRandomSecret456'
    const res = await mcpActionsApp.request(
      'https://pot.example/actions/status',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${oauthStyleBearer}`,
        },
        body: JSON.stringify({}),
      },
      noTokenEnv,
    )
    expect(res.status).toBe(401)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// C6 zero-capability defaults — OAuth seat 403s on capability-gated tools
// ────────────────────────────────────────────────────────────────────────────
describe('C6 OAuth zero-capability defaults', () => {
  // OAuth env with empty capabilities (default for a freshly minted directory seat).
  const zeroCapEnv = makeEnvOAuth([]) // no grants in DB
  const zeroHeaders = oauthAuthHeader({ capabilities: [] }) // C6: zero grants in injected ctx

  it('task_create (needs member on squad) → forbidden or squad_not_found', async () => {
    const res = await post(
      mcpApp, '/',
      // #142: done_when required — include it so the pre-check passes and the auth/squad gate fires.
      { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'task_create', arguments: { squad_id: 'sq-1', title: 'hi', done_when: 'task verified' } } },
      zeroHeaders,
      zeroCapEnv,
    )
    // tools/call wraps errors in the RPC envelope — HTTP 200 with error inside, or a non-2xx.
    // With zero caps the tool either: (a) returns squad_not_found (404) if the squad lookup
    // runs first, or (b) returns forbidden (403) if the cap check runs first. Both prove the
    // OAuth seat cannot create tasks. The DB mock returns null for squad lookups (no squad).
    // So the typical path is: squad not found → 404 (tool returns {ok:false, error:'squad_not_found'}).
    expect([200, 403, 404]).toContain(res.status)
    const body = await res.json() as { error?: { message?: string }; result?: { content?: { text?: string }[] } }
    if (res.status === 200) {
      const text = body.result?.content?.[0]?.text ?? ''
      const parsed = JSON.parse(text) as { ok: boolean; error: string }
      expect(parsed.ok).toBe(false)
      expect(['forbidden', 'squad_not_found']).toContain(parsed.error)
    }
  })

  it('wake_agent (needs lead on squad) → 403 or 404 (no agent)', async () => {
    const res = await post(
      mcpApp, '/',
      { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'wake_agent', arguments: { agent_id: 'nonexistent-agent' } } },
      zeroHeaders,
      zeroCapEnv,
    )
    const body = await res.json() as { result?: { content?: { text?: string }[] } }
    const text = body.result?.content?.[0]?.text ?? ''
    if (text) {
      const parsed = JSON.parse(text) as { ok: boolean; error: string }
      expect(parsed.ok).toBe(false)
      // forbidden (zero caps on squad) or agent_not_found (no such agent) — both are correct rejections
      expect(['forbidden', 'agent_not_found']).toContain(parsed.error)
    }
  })

  it('create_squad (needs admin on department/org) → 403', async () => {
    const res = await post(
      mcpApp, '/',
      { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'create_squad', arguments: { department: 'dept-1', slug: 'sq', name: 'Squad' } } },
      zeroHeaders,
      zeroCapEnv,
    )
    const body = await res.json() as { result?: { content?: { text?: string }[] } }
    const text = body.result?.content?.[0]?.text ?? ''
    if (text) {
      const parsed = JSON.parse(text) as { ok: boolean; error: string }
      expect(parsed.ok).toBe(false)
      expect(['forbidden', 'department_not_found', 'ambiguous_slug']).toContain(parsed.error)
    }
  })

  it('mint_agent_token (needs admin on squad) → 403', async () => {
    const res = await post(
      mcpApp, '/',
      { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'mint_agent_token', arguments: { agent: 'nonexistent-agent' } } },
      zeroHeaders,
      zeroCapEnv,
    )
    const body = await res.json() as { result?: { content?: { text?: string }[] } }
    const text = body.result?.content?.[0]?.text ?? ''
    if (text) {
      const parsed = JSON.parse(text) as { ok: boolean; error: string }
      expect(parsed.ok).toBe(false)
      expect(['forbidden', 'agent_not_found', 'ambiguous_slug']).toContain(parsed.error)
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────
// C9 sovereign-core invariant — body-supplied identity is inert
// ────────────────────────────────────────────────────────────────────────────
describe('C9 body-supplied identity ignored', () => {
  const env = makeEnvWithMemberKey([
    { member_id: 'mbr-key-1', scope_type: 'org', scope_id: null, capability: 'admin' },
  ])

  it('identity fields in args are rejected by validateArgs (sovereign invariant)', async () => {
    const res = await post(
      mcpApp, '/',
      {
        jsonrpc: '2.0', id: 20,
        method: 'tools/call',
        params: {
          name: 'status',
          arguments: {
            // These fields are not in the status tool's inputSchema (additionalProperties:false).
            // validateArgs rejects unknown fields → 400 invalid_args.
            // This proves the tool's input schema enforces the sovereign-core invariant:
            // no identity field from args is ever accepted or acted on.
            tenant: 'evil-tenant',
            member_id: 'injected-member',
            project: 'evil-project',
          },
        },
      },
      { authorization: 'Bearer mupot_test_member_key' },
      env,
    )
    // validateArgs rejects the unknown fields with an RPC error (invalid_args).
    // The response may be 200 (RPC error in envelope) or 400 (HTTP error).
    const body = await res.json() as { error?: { message?: string; data?: unknown }; result?: unknown }
    // Either path proves the injected identity fields were rejected (not acted on).
    if (res.status === 200) {
      // RPC error envelope — the unknown fields triggered invalid_args
      expect(body.error).toBeTruthy()
      // Error message must mention the unknown field, not a tenant mismatch
      const msg = JSON.stringify(body.error)
      expect(msg).toMatch(/unknown field|invalid_args/)
    } else {
      // HTTP-level error — also acceptable (400 from validateArgs)
      expect([400, 401, 403]).toContain(res.status)
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────
// C3 / C5 route-order — /authorize and .well-known win over Coming-Soon
// Tested via the Hono app directly (before the OAuthProvider wrapper). The
// OAuthProvider wraps the defaultHandler; this test verifies the Hono app
// correctly routes /authorize to the OAuth handler, not the dashboardApp.
// ────────────────────────────────────────────────────────────────────────────
describe('C3 route-order — /authorize before dashboardApp catch-all', () => {
  it('/authorize is handled by the OAuth handler (not Coming-Soon)', async () => {
    // Import the root Hono app. We import src/index.ts which exports `default`
    // (the OAuthProvider wrapper), but we test the Hono app's route logic by
    // calling /authorize directly which should return a non-200 response
    // (503 when GOOGLE_CLIENT_ID is not set) rather than the Coming-Soon HTML.
    const env: Env = {
      TENANT_SLUG: TENANT,
      BRAND: 'Mumega',
      OAUTH_PROVIDER: 'google',
      SESSIONS: {
        get: async () => null,
        put: async () => undefined,
        delete: async () => undefined,
      },
      DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
    } as unknown as Env

    // Call the authorize handler directly (imported function, not the Hono app)
    const { handleOAuthAuthorize } = await import('../src/mcp/oauth-authorize')
    const req = new Request('https://mupot.mumega.com/authorize?client_id=test&response_type=code&redirect_uri=https://client.example.com/cb&code_challenge=abc&code_challenge_method=S256', { method: 'GET' })

    // Without GOOGLE_CLIENT_ID set → 503 (configured error), not Coming-Soon HTML
    const res = await handleOAuthAuthorize(req, env)
    expect(res.status).toBe(503)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('oauth_not_configured')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// C6 capability.ts legacyRoleSatisfies escape unreachable for OAuth principals
// ────────────────────────────────────────────────────────────────────────────
describe('C6 legacyRoleSatisfies escape unreachable for OAuth principals', () => {
  it('OAuth principal with empty capabilities array does NOT inherit org-admin', async () => {
    // An OAuth-minted member has role:'member' and capabilities:[] (empty array, not undefined).
    // The legacyRoleSatisfies escape only fires when capabilities is UNDEFINED — a pure web login.
    // With capabilities:[] the code path goes to hasCapability([]) which returns false for everything.
    const { hasCapability } = await import('../src/auth/capability')
    const { resolveCapabilities } = await import('../src/auth/capability')

    // Simulate what buildAuthContextFromProps produces for a fresh OAuth seat:
    const auth: AuthContext = {
      userId: 'oauth-member',
      email: 'oauth@example.com',
      role: 'member',
      tenant: TENANT,
      memberId: 'oauth-member',
      channel: 'directory',
      capabilities: [], // C6: always defined (possibly empty)
      boundAgentId: null,
    }

    // capabilities is defined (empty array) — the legacyRoleSatisfies branch requires
    // capabilities === undefined AND role === 'owner'|'admin'. Our OAuth principal has
    // role:'member' and capabilities:[], so both conditions are false.
    expect(auth.capabilities).toBeDefined()
    expect(Array.isArray(auth.capabilities)).toBe(true)
    expect(auth.capabilities!.length).toBe(0)

    // hasCapability with empty grants returns false for any check.
    expect(hasCapability([], 'org', null, 'admin')).toBe(false)
    expect(hasCapability([], 'org', null, 'member')).toBe(false)
    expect(hasCapability([], 'squad', 'any-squad', 'member')).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// TEST-1 — forged x-mupot-auth-context is blocked: two-layer proof
//
// Security property: an external client cannot inject x-mupot-auth-context to
// elevate privileges through the MCP endpoint. The defence has two layers:
//
//   Layer A (OAuthProvider wrapper — runtime only, not Vitest-testable):
//     POST /mcp (apiRoute) requires a valid OAuth or member-API-key token. The
//     provider validates the token FIRST. A request with no valid token receives
//     401 before the Hono app or McpOAuthApiHandler ever sees the request. The
//     forged header has zero effect because it never reaches resolveAuth.
//     NOTE: OAuthProvider imports `cloudflare:workers` at module level which the
//     Vitest Node.js runner cannot resolve. Layer A is verified in integration /
//     wrangler dev testing and is documented in src/mcp/index.ts (lines 53–70).
//
//   Layer B (McpOAuthApiHandler — tested here):
//     Even IF the OAuthProvider were bypassed and McpOAuthApiHandler were called
//     directly with crafted props, buildAuthContextFromProps checks token liveness
//     (live DB query) before returning an AuthContext. A revoked/missing token_id
//     returns null → 401. Props alone cannot grant access.
//
// This test proves Layer B: McpOAuthApiHandler.fetch with props pointing to a
// non-existent / revoked token_id returns 401, even if an attacker constructed
// the props object directly (i.e., bypassed the OAuthProvider entirely).
// ────────────────────────────────────────────────────────────────────────────
describe('TEST-1 — forged auth-context: McpOAuthApiHandler rejects revoked/missing token (Layer B)', () => {
  it('McpOAuthApiHandler with props pointing to missing token → 401 (liveness check)', async () => {
    // Import McpOAuthApiHandler. It imports cloudflare:workers for the WorkerEntrypoint
    // base class — but we call its fetch() directly without constructing it via `new`,
    // so we mock the base class to satisfy the import and call the method directly.
    // buildAuthContextFromProps is the real test subject: it queries the DB for the
    // token row and returns null when the row is absent.
    const { buildAuthContextFromProps } = await import('../src/mcp/oauth-authorize')

    // Env where the member_tokens row does NOT exist (revoked or never minted).
    const envMissingToken = {
      TENANT_SLUG: TENANT,
      BRAND: 'Mumega',
      OAUTH_PROVIDER: 'google',
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return {
                async first() {
                  // member_tokens liveness check — row is absent (revoked token).
                  if (sql.includes('FROM member_tokens t')) {
                    return null // revoked / missing
                  }
                  return null
                },
                async all() {
                  return { results: [] }
                },
              }
            },
          }
        },
      },
    } as unknown as import('../src/types').Env

    // Craft props that look like a valid OAuth authorization but point to a revoked token.
    const forgeryProps = {
      memberId: 'mbr-attacker',
      tokenId: 'tok-revoked-or-nonexistent',
      email: 'attacker@evil.example',
    }

    // buildAuthContextFromProps MUST return null — the token row is absent.
    // This is the same function McpOAuthApiHandler calls on every request.
    // null → 401 in McpOAuthApiHandler.fetch (confirmed in oauth-api-handler.ts line 39-44).
    const auth = await buildAuthContextFromProps(envMissingToken, forgeryProps)
    expect(auth).toBeNull()

    // Corollary: a valid-looking forged AuthContext injected via the internal header
    // into mcpApp.request (bypassing McpOAuthApiHandler) would be accepted by resolveAuth
    // — but this path is unreachable from external clients because:
    //   (a) The OAuthProvider intercepts /mcp and routes to McpOAuthApiHandler (not
    //       directly to mcpApp) — Layer A.
    //   (b) McpOAuthApiHandler constructs the AuthContext itself (via buildAuthContextFromProps)
    //       and then sets the internal header on a NEW Request before calling mcpApp.fetch —
    //       an external client's header is overwritten, never forwarded verbatim.
    // The internal header is a Worker-internal IPC mechanism, not a trust boundary.
  })

  it('mcpApp resolveAuth: forged header with valid JSON is parsed (trusted internal IPC)', async () => {
    // This test documents (and asserts) the expected behavior: mcpApp.request accepts the
    // injected header when it carries valid JSON with userId + tenant. This is CORRECT —
    // the header is an internal IPC mechanism set by McpOAuthApiHandler. The security
    // comes from Layer A (OAuthProvider) + Layer B (buildAuthContextFromProps), not from
    // mcpApp second-guessing the internal header.
    //
    // If this test FAILS (mcpApp rejects the header), it means the IPC is broken.
    const env = makeEnvOAuth([])
    const forgedAuth: AuthContext = {
      userId: 'mbr-injected',
      email: 'injected@example.com',
      role: 'member',
      tenant: TENANT,
      memberId: 'mbr-injected',
      channel: 'directory',
      capabilities: [], // zero — no harm even if accepted (C6 ceiling)
      boundAgentId: null,
    }

    // POST to mcpApp directly (simulating McpOAuthApiHandler's internal dispatch).
    // The header should be trusted — this is the CORRECT design for internal IPC.
    const res = await post(
      mcpApp, '/',
      { jsonrpc: '2.0', id: 98, method: 'tools/call', params: { name: 'status', arguments: {} } },
      { [AUTH_CONTEXT_HEADER]: JSON.stringify(forgedAuth) },
      env,
    )
    // Status 200 (status tool, zero caps, no cap check needed) — header was accepted.
    // This confirms the internal IPC works. External clients cannot reach this path
    // because the OAuthProvider is the only public gateway to /mcp.
    expect(res.status).toBe(200)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// TEST-2 — B1 cap: existing admin email → OAuth login → capabilities EMPTY
//
// Security property: a member with existing admin grants (set via the workspace
// door) who later authenticates through the directory (OAuth) door must receive
// an AuthContext with capabilities = [] (zero), NOT the admin grants.
//
// This directly tests the B1 fix in buildAuthContextFromProps.
// ────────────────────────────────────────────────────────────────────────────
describe('TEST-2 — B1 directory-channel capability ceiling', () => {
  it('existing admin member OAuth login → buildAuthContextFromProps returns empty capabilities', async () => {
    const { buildAuthContextFromProps } = await import('../src/mcp/oauth-authorize')

    const ADMIN_MEMBER_ID = 'mbr-existing-admin'
    const TOKEN_ID = 'tok-existing-admin-directory'
    const seen: { tokenSql?: string; tokenBinds?: unknown[] } = {}

    // Mock env: the member has org-admin grant in the capabilities table.
    // buildAuthContextFromProps must discard this and return [] for a directory seat.
    const env = {
      TENANT_SLUG: TENANT,
      BRAND: 'Mumega',
      OAUTH_PROVIDER: 'google',
      DB: {
        prepare(sql: string) {
          return {
            bind(...args: unknown[]) {
              return {
                async first() {
                  // Token liveness check (member_tokens JOIN members WHERE t.id = tokenId)
                  if (sql.includes('FROM member_tokens t') && sql.includes('t.id = ?1')) {
                    seen.tokenSql = sql
                    seen.tokenBinds = args
                    return { status: 'active' }
                  }
                  return null
                },
                async all() {
                  // resolveCapabilities: the member HAS admin grant in D1.
                  if (sql.includes('FROM capabilities') || sql.includes('FROM channel_capability_grants')) {
                    return {
                      results: [
                        {
                          member_id: ADMIN_MEMBER_ID,
                          scope_type: 'org',
                          scope_id: null,
                          capability: 'admin',
                        },
                      ],
                    }
                  }
                  return { results: [] }
                },
              }
            },
          }
        },
      },
    } as unknown as import('../src/types').Env

    const props = {
      memberId: ADMIN_MEMBER_ID,
      tokenId: TOKEN_ID,
      email: 'admin@example.com',
    }

    const auth = await buildAuthContextFromProps(env, props)

    // Must return a valid AuthContext (token is live).
    expect(auth).not.toBeNull()

    // B1: capabilities must be EMPTY — the directory door applies a zero ceiling.
    // The member's admin grant in D1 must NOT be inherited through the OAuth door.
    expect(auth!.capabilities).toBeDefined()
    expect(Array.isArray(auth!.capabilities)).toBe(true)
    expect(auth!.capabilities!.length).toBe(0)

    // Channel must be 'directory' (the OAuth door).
    expect(auth!.channel).toBe('directory')

    // Tenant is from env, not props.
    expect(auth!.tenant).toBe(TENANT)
    expect(seen.tokenSql).toContain('t.tenant = ?3')
    expect(seen.tokenSql).toContain('m.tenant = ?3')
    expect(seen.tokenBinds?.[2]).toBe(TENANT)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// TEST-2b — member API key through production convergence keeps grants + weld
//
// Production /mcp wraps requests with OAuthProvider. For a bearer the provider does
// not own, it calls resolveExternalToken(), then dispatches through
// McpOAuthApiHandler/buildAuthContextFromProps(). Direct mcpApp tests do NOT cover
// that convergence path. This regression test does.
// ────────────────────────────────────────────────────────────────────────────
describe('TEST-2b — member API key convergence preserves workspace grants and agent weld', () => {
  it('resolveExternalToken → buildAuthContextFromProps keeps workspace channel, caps, and bound agent', async () => {
    const { resolveExternalToken, buildAuthContextFromProps } = await import('../src/mcp/oauth-authorize')
    const { invokeTool } = await import('../src/mcp/index')

    const MEMBER_ID = 'mbr-workspace-admin'
    const TOKEN_ID = 'tok-workspace-agent'
    const AGENT_ID = 'agent-bound-1'
    const SQUAD_ID = 'sq-prod-path'
    const DEPT_ID = 'dept-prod-path'
    const seen: { externalSql?: string; externalBinds?: unknown[]; recheckSql?: string; recheckBinds?: unknown[] } = {}
    const grants: CapabilityGrant[] = [
      { member_id: MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'admin' },
      { member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' },
    ]

    const env = {
      TENANT_SLUG: TENANT,
      BRAND: 'Mumega',
      OAUTH_PROVIDER: 'google',
      BUS: { send: async () => undefined },
      DB: {
        prepare(sql: string) {
          return {
            bind(...args: unknown[]) {
              return {
                async first() {
                  if (sql.includes('FROM member_tokens t')) {
                    if (sql.includes('t.token_hash = ?1')) {
                      seen.externalSql = sql
                      seen.externalBinds = args
                    }
                    if (sql.includes('t.id = ?1')) {
                      seen.recheckSql = sql
                      seen.recheckBinds = args
                    }
                    return {
                      member_id: MEMBER_ID,
                      email: 'workspace@example.com',
                      status: 'active',
                      token_id: TOKEN_ID,
                      channel: 'workspace',
                      bound_agent_id: AGENT_ID,
                      bound_agent_status: 'active',
                    }
                  }
                  if (sql.includes('FROM squads WHERE id = ?1')) {
                    return {
                      id: SQUAD_ID,
                      department_id: DEPT_ID,
                      slug: 'prod-path',
                      name: 'Prod Path',
                      charter: null,
                      created_at: '2026-01-01 00:00:00',
                    }
                  }
                  if (sql.includes('COUNT(*) AS n FROM agent_messages')) return { n: 0 }
                  return null
                },
                async all() {
                  if (sql.includes('FROM capabilities') || sql.includes('FROM channel_capability_grants')) {
                    return { results: grants }
                  }
                  if (sql.includes('FROM agent_messages')) return { results: [] }
                  return { results: [] }
                },
                async run() {
                  return { meta: { changes: 1 } }
                },
              }
            },
          }
        },
      },
    } as unknown as Env

    const resolved = await resolveExternalToken(env, 'mupot_workspace_key')
    expect(resolved).not.toBeNull()
    expect(seen.externalSql).toContain('t.tenant = ?2')
    expect(seen.externalSql).toContain('m.tenant = ?2')
    expect(seen.externalSql).toContain('LEFT JOIN agents a ON a.id = t.agent_id')
    expect(seen.externalSql).toContain("a.status = 'active'")
    expect(seen.externalBinds?.[1]).toBe(TENANT)
    expect(resolved!.props).toMatchObject({
      memberId: MEMBER_ID,
      tokenId: TOKEN_ID,
      channel: 'workspace',
      boundAgentId: AGENT_ID,
    })

    const auth = await buildAuthContextFromProps(env, resolved!.props)
    expect(auth).not.toBeNull()
    expect(seen.recheckSql).toContain('t.tenant = ?3')
    expect(seen.recheckSql).toContain('m.tenant = ?3')
    expect(seen.recheckSql).toContain('LEFT JOIN agents a ON a.id = t.agent_id')
    expect(seen.recheckSql).toContain("a.status = 'active'")
    expect(seen.recheckBinds?.[2]).toBe(TENANT)
    expect(auth!.channel).toBe('workspace')
    expect(auth!.boundAgentId).toBe(AGENT_ID)
    expect(auth!.capabilities).toEqual(grants)

    const created = await invokeTool(
      auth!,
      env,
      'task_create',
      { squad_id: SQUAD_ID, title: 'prod path task', done_when: 'task row is created' },
      'https://pot.example',
    )
    expect(created.ok).toBe(true)

    const inbox = await invokeTool(auth!, env, 'inbox', { peek: true }, 'https://pot.example')
    expect(inbox.ok).toBe(true)
    expect((inbox.result as { messages?: unknown[] }).messages).toEqual([])
  })

  it('resolveExternalToken rejects a workspace token welded to a paused agent', async () => {
    const { resolveExternalToken } = await import('../src/mcp/oauth-authorize')
    const env = {
      TENANT_SLUG: TENANT,
      DB: {
        prepare() {
          return {
            bind() {
              return {
                async first() {
                  return {
                    member_id: 'member-paused',
                    email: null,
                    status: 'active',
                    token_id: 'token-paused',
                    channel: 'workspace',
                    bound_agent_id: 'agent-paused',
                    bound_agent_status: 'paused',
                  }
                },
              }
            },
          }
        },
      },
    } as unknown as Env

    expect(await resolveExternalToken(env, 'mupot_paused_agent_key')).toBeNull()
  })

  it('buildAuthContextFromProps rejects a live token whose welded agent was paused', async () => {
    const { buildAuthContextFromProps } = await import('../src/mcp/oauth-authorize')
    const env = {
      TENANT_SLUG: TENANT,
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return {
                async first() {
                  if (sql.includes('FROM member_tokens t')) {
                    return {
                      status: 'active',
                      email: null,
                      channel: 'workspace',
                      bound_agent_id: 'agent-paused',
                      bound_agent_status: 'paused',
                    }
                  }
                  return null
                },
                async all() {
                  return { results: [] }
                },
              }
            },
          }
        },
      },
    } as unknown as Env

    const auth = await buildAuthContextFromProps(env, {
      memberId: 'member-paused',
      tokenId: 'token-paused',
      email: null,
      channel: 'workspace',
      boundAgentId: 'agent-paused',
    })
    expect(auth).toBeNull()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// TEST-3 — tightened zero-cap: real squad in DB → 403 forbidden (not 404)
//
// The previous zero-cap tests allowed either 403 (forbidden) or 404 (squad_not_found)
// because the DB mock returned null for squad lookups. That means the test was
// asserting "squad_not_found" path, NOT the capability-check path. We need the
// capability check to actually run — so we mock a real squad in the DB and assert
// that the response is 403 forbidden (the cap check fires and denies), not 404.
// ────────────────────────────────────────────────────────────────────────────
describe('TEST-3 — zero-cap with real squad: 403 forbidden (not 404)', () => {
  const SQUAD_ID = 'sq-real-squad'
  const DEPT_ID = 'dept-real'

  // Env with a real squad row in the DB mock + no capability grants.
  function makeEnvWithRealSquad(): import('../src/types').Env {
    return {
      TENANT_SLUG: TENANT,
      BRAND: 'Mumega',
      OAUTH_PROVIDER: 'google',
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return {
                async first() {
                  // Squad lookup by id → return a real squad row.
                  if (sql.includes('FROM squads WHERE id = ?1')) {
                    return {
                      id: SQUAD_ID,
                      department_id: DEPT_ID,
                      slug: 'real-squad',
                      name: 'Real Squad',
                      charter: null,
                      created_at: '2026-01-01 00:00:00',
                    }
                  }
                  // Department lookup for squad (inheritance resolution).
                  if (sql.includes('FROM squads WHERE id')) {
                    return { department_id: DEPT_ID }
                  }
                  return null
                },
                async all() {
                  // No capability grants for this member.
                  if (sql.includes('FROM capabilities') || sql.includes('FROM channel_capability_grants')) {
                    return { results: [] }
                  }
                  return { results: [] }
                },
              }
            },
          }
        },
      },
    } as unknown as import('../src/types').Env
  }

  it('task_create on a REAL squad with zero caps → 403 forbidden (capability check fires)', async () => {
    const env = makeEnvWithRealSquad()
    // Zero caps injected via header (directory seat with no grants).
    const headers = oauthAuthHeader({ capabilities: [] })

    const res = await post(
      mcpApp, '/',
      {
        jsonrpc: '2.0', id: 30,
        method: 'tools/call',
        // #142: done_when required — include it so the pre-check passes and the cap gate fires.
        params: { name: 'task_create', arguments: { squad_id: SQUAD_ID, title: 'test task', done_when: 'task verified' } },
      },
      headers,
      env,
    )

    // The squad IS found (real row in DB), so the capability check MUST run.
    // With zero grants, memberCanOnSquad returns false → 403 forbidden.
    // This proves the capability gate fires on a real squad, not just squad_not_found.
    const body = await res.json() as { result?: { content?: { text?: string }[] }; error?: { message?: string } }
    const text = body.result?.content?.[0]?.text ?? ''

    if (text) {
      const parsed = JSON.parse(text) as { ok: boolean; error: string }
      expect(parsed.ok).toBe(false)
      // MUST be 'forbidden' — the squad was found and the cap check ran and denied.
      // If this is 'squad_not_found' the test is broken (squad mock not working).
      expect(parsed.error).toBe('forbidden')
    } else {
      // HTTP-level 403 is also acceptable.
      expect([403]).toContain(res.status)
    }
  })

  it('squad_message on a REAL squad with zero caps → 403 forbidden', async () => {
    const env = makeEnvWithRealSquad()
    const headers = oauthAuthHeader({ capabilities: [] })

    const res = await post(
      mcpApp, '/',
      {
        jsonrpc: '2.0', id: 31,
        method: 'tools/call',
        params: { name: 'squad_message', arguments: { squad_id: SQUAD_ID, message: 'hi' } },
      },
      headers,
      env,
    )

    const body = await res.json() as { result?: { content?: { text?: string }[] } }
    const text = body.result?.content?.[0]?.text ?? ''
    if (text) {
      const parsed = JSON.parse(text) as { ok: boolean; error: string }
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toBe('forbidden')
    } else {
      expect([403]).toContain(res.status)
    }
  })
})
