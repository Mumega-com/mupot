// tests/helpers/door-clients.ts — the cold-client fixtures of the onboarding-door conformance test (lane D), shared so
// tests tracking the same door (whoami, lane A) run against the SAME real handler: mcpApp -> resolveAuth ->
// resolveSeatSession -> tool, real sqlite D1 from the full migration chain, the real OAuth consent path for OAuth clients.
// Env flags are PROD's (SEAT_AUTO_ENROLL=1, REALTIME_SEAT_EVENTS=1; SEAT_ATTACH and SECURE_MOMENTS off).

import { vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './sqlite-d1'
import { applyAllMigrations } from './migrations'
import { buildAuthContextFromProps, handleOAuthAuthorize } from '../../src/mcp/oauth-authorize'
import { hashMemberToken } from '../../src/auth/member-bearer'
import { mcpApp } from '../../src/mcp/index'
import { mcpInternalRequest } from '../../src/mcp/internal-dispatch'
import type { Env } from '../../src/types'

export const TENANT = 'mumega'
export const HARNESS_CHOICE = '__harness__'
export const NOW = '2026-10-18T00:00:00.000Z'
export type Kind = 'chatgpt' | 'claude' | 'hermes' | 'unknown'

export function memoryKv() {
  const store = new Map<string, string>()
  return {
    async get(key: string, type?: string) { const v = store.get(key); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v },
    async put(key: string, value: string) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
  }
}

export type Json = Record<string, unknown>
export interface Reply { refused: boolean; body: Json }
/** props: OAuth grant props (AuthContext rebuilt per call); bearer: workspace token. */
export interface Client { kind: Kind; props: Json | null; bearer: string | null; meta?: Json; seat?: string }
export interface World { h: SqliteD1Harness; env: Env; agents: () => number; refusals: Json[] }

export function newWorld(): World {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  // A populated tenant: an org admin and an existing agent, so nobody below is the first member.
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('d0', 'd0', 'd0');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('sq0', 'd0', 'sq0', 'sq0'), ('sq-other', 'd0', 'sq-other', 'sq-other');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('ag-hermes', 'sq0', 'hermes', 'Hermes', 'active');
    INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('mem-admin', 'admin@pot.test', 'Admin', 'active', '${NOW}', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-admin', 'mem-admin', 'org', NULL, 'admin');
  `)
  const env = {
    DB: h.db, TENANT_SLUG: TENANT, BRAND: 'mupot', POT_TIER: 'scale', PUBLIC_ORIGIN: 'https://pot.test',
    GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'secret',
    SESSIONS: memoryKv(), BUS: { send: async () => {} },
    SEAT_AUTO_ENROLL: '1', REALTIME_SEAT_EVENTS: '1', // prod flags; SEAT_ATTACH and SECURE_MOMENTS are off/unset in prod
  } as unknown as Env
  return { h, env, agents: () => Number(h.sqlite.prepare('SELECT COUNT(*) AS n FROM agents').get()!.n), refusals: [] }
}

/** The real consent path: /authorize -> Google callback -> POST /oauth/consent. Returns the props the handler
 *  passed to completeAuthorization (which is what McpOAuthApiHandler hands every later request). */
export async function consent(w: World, clientName: string, email: string, choice: string): Promise<Json> {
  const completeAuthorization = vi.fn(async () => ({ redirectTo: 'https://client.test/cb?code=x' }))
  const env = { ...w.env, OAUTH_PROVIDER: {
    parseAuthRequest: async () => ({ clientId: `client-${clientName}`, scope: ['mcp:read', 'mcp:write'] }),
    completeAuthorization, lookupClient: async () => ({ clientName }),
  } } as unknown as Env
  const auth = await handleOAuthAuthorize(new Request('https://pot.test/authorize?client_id=c&response_type=code&redirect_uri=https://client.test/cb&code_challenge=abc&code_challenge_method=S256'), env)
  const nonce = /mupot_oauth_nonce_([0-9a-f-]{36})=/.exec(auth.headers.get('Set-Cookie') ?? '')![1]
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'g' }), { status: 200 })
    if (url.includes('userinfo')) return new Response(JSON.stringify({ id: `sub-${email}`, name: 'Human', email, verified_email: true }), { status: 200 })
    throw new Error(`unexpected fetch ${url}`)
  }))
  const cb = await handleOAuthAuthorize(new Request(`https://pot.test/oauth/google-callback?code=abc&state=${nonce}`, { headers: { Cookie: `mupot_oauth_nonce_${nonce}=1` } }), env)
  const cookie = cb.headers.getSetCookie().find((c) => c.startsWith('mupot_oauth_consent_')) ?? ''
  const cn = /mupot_oauth_consent_([0-9a-f-]{36})=/.exec(cookie)![1]
  const res = await handleOAuthAuthorize(new Request('https://pot.test/oauth/consent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `mupot_oauth_consent_${cn}=1` },
    body: new URLSearchParams({ consent_nonce: cn, action: 'continue', agent_id: choice }).toString(),
  }), env)
  if (res.status !== 302) throw new Error(`consent fixture failed: ${res.status}`)
  vi.unstubAllGlobals()
  const call = completeAuthorization.mock.calls[0] as unknown as [{ props: Json }]
  return call[0].props
}

export async function oauthClient(w: World, kind: Kind, clientName: string, choice: string, meta?: Json): Promise<Client> {
  return { kind, props: await consent(w, clientName, `${kind}@pot.test`, choice), bearer: null, meta }
}

export async function hermesClient(w: World): Promise<Client> {
  w.h.sqlite.exec(`
    INSERT INTO members (id, display_name, status, created_at, tenant) VALUES ('mem-hermes', 'Hermes', 'active', '${NOW}', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'ag-hermes', 'mem-hermes', '${NOW}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-hermes', 'mem-hermes', 'squad', 'sq0', 'member');
    INSERT INTO agent_keys (tenant, agent_id, pubkey, algo, member_id, created_at) VALUES ('${TENANT}', 'ag-hermes', 'pk-hermes', 'Ed25519', 'mem-hermes', 1);
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, agent_id, created_at, tenant)
      VALUES ('tok-hermes', 'mem-hermes', '${await hashMemberToken('raw-hermes-token')}', 'hermes', 'workspace', 'ag-hermes', '${NOW}', '${TENANT}');
  `)
  return { kind: 'hermes', props: null, bearer: 'raw-hermes-token' }
}

/** One tools/call exactly as the client would send it. Only the ChatGPT client sends params._meta; nobody sends x-mupot-seat. */
export async function rpc(w: World, c: Client, method: string, params: Json): Promise<Response> {
  if (c.meta) params._meta = c.meta
  // Prod rebuilds the AuthContext from the stored props on every request (McpOAuthApiHandler).
  const ctx = c.props ? await buildAuthContextFromProps(w.env, c.props as unknown as Parameters<typeof buildAuthContextFromProps>[1]) : null // props are the consent handler's own OAuthMemberProps
  if (c.props && !ctx) throw new Error('grant no longer resolves to an AuthContext')
  const req = new Request(ctx ? 'https://pot.test/mcp' : 'https://pot.test/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(c.bearer ? { authorization: `Bearer ${c.bearer}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return mcpApp.fetch(ctx ? mcpInternalRequest(req, ctx) : req, w.env)
}

export async function call(w: World, c: Client, name: string, args: Json = {}): Promise<Reply> {
  // Lane C: a thread with no header and no _meta sends the seat_id seat_select returned as `seat` on every later call.
  const res = await rpc(w, c, 'tools/call', { name, arguments: c.seat && !('seat' in args) ? { ...args, seat: c.seat } : args })
  const env = (await res.json()) as { result?: { isError?: boolean; structuredContent?: Json }; error?: { message?: string; data?: unknown; who_acts?: unknown; next_step?: unknown; next_tool?: unknown; whoami?: unknown } }
  if (env.result?.isError) { w.refusals.push(env.result.structuredContent ?? {}); return { refused: true, body: env.result.structuredContent ?? {} } }
  // Lane B: the refusal envelope rides as SIBLING members of the JSON-RPC error (beside `data`, which keeps its old shape).
  if (env.error) { const b = { error: env.error.message, detail: env.error.data, who_acts: env.error.who_acts, next_step: env.error.next_step, next_tool: env.error.next_tool, whoami: env.error.whoami }; w.refusals.push(b); return { refused: true, body: b } }
  return { refused: res.status >= 400, body: env.result?.structuredContent ?? {} }
}

export async function listTools(w: World, c: Client): Promise<Set<string>> {
  const res = (await (await rpc(w, c, 'tools/list', {})).json()) as { result?: { tools?: Array<{ name?: string }> } }
  return new Set((res.result?.tools ?? []).flatMap((t) => (typeof t.name === 'string' ? [t.name] : [])))
}

