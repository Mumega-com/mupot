// tests/onboarding-door.test.ts — onboarding-door conformance, lane D (mupot task 7e0cb92d,
// mumega-com #1443, design: agents/kasra/docs/design-navigable-onboarding-20261017.md).
//
// Four COLD clients play their first five minutes against the real MCP handler (mcpApp ->
// resolveAuth -> resolveSeatSession -> tool, real sqlite D1 from the full migration chain, the real
// OAuth consent path for the three OAuth clients). Nothing about the door is mocked.
//   1. ChatGPT thread   consent "Me - auto per workspace"; sends params._meta["openai/session"].
//   2. Claude thread    same consent, sends NO x-mupot-seat header and NO _meta (claude.ai sends neither).
//   3. Hermes agent     keyed agent token (workspace channel) for an existing agent with a signing key.
//   4. Unknown harness  consent "No agent" (no harness pointer, unbound directory grant).
// Walk: boot_context -> a refused probe (task_create) -> call doors[0] with its advertised args ->
// boot_context again -> orient -> status. Tenant is POPULATED (an admin member + agent exist), so no
// client is the first member of an empty tenant.
//
// CONTRACT. A dead end is an assertion that fails on current main. Each is `it.fails(...)` (via
// `dead`), so the file is GREEN while the dead end exists; the lane that fixes it flips the flag in
// DEAD below to false and the test becomes a normal one. vitest reports an `it.fails` that starts
// passing as a failure, so a fix cannot land without flipping its flag.
//
// DEAD ENDS (all in src/mcp/index.ts unless noted):
//   seat-loop      boot says seat_select; after seat_select boot says seat_select again, because the handle is
//                  header/_meta only (resolveSeatSession :545-584, autoKeys :580; boot seat_select door + nextStep :6876-6930).
//   orient-refusal orient on an unbound session answers invalid_args "agent required" with no next_step /
//                  who_acts (toolOrient :7056, the 'agent required' fail :7074; design Block 1.5).
//   bootstrap-lie  boot advertises bootstrap_self (available_doors + next_step) to a member of a populated
//                  tenant (buildAvailableDoors :6613, nextStepBase :6916; hasBootstrappedBefore is per-member,
//                  not per-tenant).
//   thread-agent   a thread client creates an `agents` row: ChatGPT on its first request (auto-seat,
//                  applySeatForRequest via resolveSeatSession :545-584), Claude on seat_select. Design: threads-as-seats.
//   no-whoami      boot_context returns no `whoami` block {state, have[], missing[]}; five next-step words
//                  (next_step, onboarding.next_step, available_doors, onboarding_state, identity_status) instead.
//   split-steps    top-level next_step and onboarding.next_step name different actions (ChatGPT seat: orient vs
//                  "call boot_context again passing runtime"; Hermes: orient vs "POST /api/fleet/attach-signed";
//                  buildBootOnboarding :6494-6560).
//   refusal-env    refusal objects seen on the way lack `next_step` and `who_acts` (fail() :832 takes only status/error/detail).
//
// Fixture notes (where this harness differs from prod): requests enter through mcpInternalRequest with a
// context rebuilt by buildAuthContextFromProps from the props the real consent handler passed to
// completeAuthorization, so the OAuthProvider library's token/props encryption and McpOAuthApiHandler are
// skipped. Google and the OAuth provider are stubbed only at the consent edge. The Hermes token and its
// agent_keys row are seeded by SQL, not minted.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { buildAuthContextFromProps, handleOAuthAuthorize } from '../src/mcp/oauth-authorize'
import { hashMemberToken } from '../src/auth/member-bearer'
import { mcpApp } from '../src/mcp/index'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
const HARNESS_CHOICE = '__harness__'
const NOW = '2026-10-18T00:00:00.000Z'

type Kind = 'chatgpt' | 'claude' | 'hermes' | 'unknown'
const dead = (isDead: boolean): typeof it => (isDead ? it.fails : it)
// Flip a flag to false when its lane lands. See the header for what each one means.
const DEAD: Record<string, Record<Kind, boolean>> = {
  seatLoop: { chatgpt: false, claude: true, hermes: false, unknown: false },
  orientRefusal: { chatgpt: false, claude: true, hermes: false, unknown: true },
  bootstrapLie: { chatgpt: false, claude: true, hermes: false, unknown: true },
  threadAgent: { chatgpt: true, claude: true, hermes: false, unknown: false },
  noWhoami: { chatgpt: true, claude: true, hermes: true, unknown: true },
  splitSteps: { chatgpt: true, claude: true, hermes: true, unknown: true },
  refusalEnv: { chatgpt: true, claude: true, hermes: true, unknown: true },
}

function memoryKv() {
  const store = new Map<string, string>()
  return {
    async get(key: string, type?: string) { const v = store.get(key); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v },
    async put(key: string, value: string) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
  }
}

type Json = Record<string, unknown>
interface Reply { refused: boolean; body: Json }
interface Client { kind: Kind; ctx: AuthContext | null; bearer: string | null; meta?: Json }

interface World { h: SqliteD1Harness; env: Env; agents: () => number; refusals: Json[] }

function newWorld(): World {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  // A populated tenant: an org admin and an existing agent, so nobody below is the first member.
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('d0', 'd0', 'd0');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('sq0', 'd0', 'sq0', 'sq0');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('ag-hermes', 'sq0', 'hermes', 'Hermes', 'active');
    INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('mem-admin', 'admin@pot.test', 'Admin', 'active', '${NOW}', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-admin', 'mem-admin', 'org', NULL, 'admin');
  `)
  const env = {
    DB: h.db, TENANT_SLUG: TENANT, BRAND: 'mupot', POT_TIER: 'scale', PUBLIC_ORIGIN: 'https://pot.test',
    GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'secret',
    SESSIONS: memoryKv(), BUS: { send: async () => {} },
    SEAT_AUTO_ENROLL: '1', SEAT_ATTACH: '1',
  } as unknown as Env
  return { h, env, agents: () => Number(h.sqlite.prepare('SELECT COUNT(*) AS n FROM agents').get()!.n), refusals: [] }
}

/** The real consent path: /authorize -> Google callback -> POST /oauth/consent. Returns the props the handler
 *  passed to completeAuthorization (which is what McpOAuthApiHandler hands every later request). */
async function consent(w: World, clientName: string, email: string, choice: string): Promise<Json> {
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

async function oauthClient(w: World, kind: Kind, clientName: string, choice: string, meta?: Json): Promise<Client> {
  const props = await consent(w, clientName, `${kind}@pot.test`, choice)
  // props is the library-stored OAuthMemberProps the consent handler just built; buildAuthContextFromProps is its only reader.
  const ctx = await buildAuthContextFromProps(w.env, props as unknown as Parameters<typeof buildAuthContextFromProps>[1])
  if (!ctx) throw new Error('consent grant did not resolve to an AuthContext')
  return { kind, ctx, bearer: null, meta }
}

async function hermesClient(w: World): Promise<Client> {
  w.h.sqlite.exec(`
    INSERT INTO members (id, display_name, status, created_at, tenant) VALUES ('mem-hermes', 'Hermes', 'active', '${NOW}', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'ag-hermes', 'mem-hermes', '${NOW}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-hermes', 'mem-hermes', 'squad', 'sq0', 'member');
    INSERT INTO agent_keys (tenant, agent_id, pubkey, algo, member_id, created_at) VALUES ('${TENANT}', 'ag-hermes', 'pk-hermes', 'Ed25519', 'mem-hermes', 1);
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, agent_id, created_at, tenant)
      VALUES ('tok-hermes', 'mem-hermes', '${await hashMemberToken('raw-hermes-token')}', 'hermes', 'workspace', 'ag-hermes', '${NOW}', '${TENANT}');
  `)
  return { kind: 'hermes', ctx: null, bearer: 'raw-hermes-token' }
}

/** One tools/call exactly as the client would send it. Only the ChatGPT client sends params._meta; nobody sends x-mupot-seat. */
async function call(w: World, c: Client, name: string, args: Json = {}): Promise<Reply> {
  const params: Json = { name, arguments: args }
  if (c.meta) params._meta = c.meta
  const req = new Request(c.ctx ? 'https://pot.test/mcp' : 'https://pot.test/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(c.bearer ? { authorization: `Bearer ${c.bearer}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }),
  })
  const res = await mcpApp.fetch(c.ctx ? mcpInternalRequest(req, c.ctx) : req, w.env)
  const env = (await res.json()) as { result?: { isError?: boolean; structuredContent?: Json }; error?: { message?: string; data?: unknown } }
  if (env.result?.isError) { w.refusals.push(env.result.structuredContent ?? {}); return { refused: true, body: env.result.structuredContent ?? {} } }
  if (env.error) { const b = { error: env.error.message, detail: env.error.data }; w.refusals.push(b); return { refused: true, body: b } }
  return { refused: res.status >= 400, body: env.result?.structuredContent ?? {} }
}

interface Door { tool: string }
const doorsOf = (b: Json): string[] => ((b.available_doors as Door[] | undefined) ?? []).map((d) => d.tool)
const ARGS: Record<string, Json> = { seat_select: { project: 'conformance' }, bootstrap_self: { agent_name: 'conformance-agent' }, connect: { agent_name: 'hermes' } }
const asObj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})
const stepWords = (b: Json): string[] => [b.next_step, asObj(b.onboarding).next_step].filter((s): s is string => typeof s === 'string')
const hasEnvelope = (r: Json): boolean => {
  const inner = [r, asObj(r.detail), asObj(r.data)]
  return inner.some((o) => typeof o.next_step === 'string') && inner.some((o) => typeof o.who_acts === 'string')
}

interface Trace { boot: Json; adv: string; advReply: Reply; boot2: Json; orient: Reply; status: Reply; agentsBefore: number; agentsAfter: number; refusals: Json[] }

async function walk(w: World, c: Client): Promise<Trace> {
  const agentsBefore = w.agents()
  const boot = (await call(w, c, 'boot_context')).body
  await call(w, c, 'task_create', { squad_id: 'sq0', title: 'first thing a cold client tries', done_when: 'n/a' }) // refusal probe
  const adv = doorsOf(boot)[0] ?? 'none'
  const advReply = await call(w, c, adv, ARGS[adv] ?? {})
  const boot2 = (await call(w, c, 'boot_context')).body
  const orient = await call(w, c, 'orient')
  const status = await call(w, c, 'status')
  return { boot, adv, advReply, boot2, orient, status, agentsBefore, agentsAfter: w.agents(), refusals: w.refusals }
}

afterEach(() => { vi.unstubAllGlobals() })

const CLIENTS: Record<Kind, (w: World) => Promise<Client>> = {
  chatgpt: (w) => oauthClient(w, 'chatgpt', 'ChatGPT', HARNESS_CHOICE, { 'openai/session': 'conv-cold-1' }),
  claude: (w) => oauthClient(w, 'claude', 'Claude', HARNESS_CHOICE),
  hermes: (w) => hermesClient(w),
  unknown: (w) => oauthClient(w, 'unknown', 'Some New Harness', ''),
}

describe.each(Object.keys(CLIENTS) as Kind[])('cold %s client, first five minutes', (kind) => {
  let w: World
  let t: Trace
  beforeAll(async () => {
    w = newWorld()
    t = await walk(w, await CLIENTS[kind](w))
    return () => w.h.close()
  })

  it('fixture sanity: boot answered and the refusal probe really was refused', () => {
    expect(t.boot.onboarding_state).toBeDefined()
    expect(t.refusals.length).toBeGreaterThan(0)
  })

  it('the advertised first door is not refused', () => {
    expect(t.adv).not.toBe('none')
    expect(t.advReply.refused, JSON.stringify(t.advReply.body)).toBe(false)
  })

  // dead end seat-loop: boot says seat_select again after seat_select (handle is header/_meta only)
  dead(DEAD.seatLoop[kind])('after walking its door, boot does not advertise the same state-changing door again', () => {
    const stateful = ['seat_select', 'bootstrap_self'].includes(t.adv)
    expect(stateful && doorsOf(t.boot2)[0] === t.adv).toBe(false)
  })

  // dead end orient-refusal: unbound orient is refused (invalid_args, no envelope)
  dead(DEAD.orientRefusal[kind])('orient is not refused', () => {
    expect(t.orient.refused, JSON.stringify(t.orient.body)).toBe(false)
  })

  it('status agrees with boot_context about who is bound', () => {
    expect(t.status.body.bound_agent_id ?? null).toBe(t.boot2.bound_agent_id ?? null)
  })

  it('orient, when it answers, is about the agent boot says is bound', () => {
    const agent = asObj(asObj(t.orient.body.packet).agent)
    if (!t.orient.refused && t.boot2.bound_agent_id) expect(agent.id).toBe(t.boot2.bound_agent_id)
  })

  // dead end thread-agent: a thread (ChatGPT, Claude) must not mint an agents row
  const thread = kind === 'chatgpt' || kind === 'claude'
  if (thread) {
    dead(DEAD.threadAgent[kind])('a thread client creates no new agents row', () => {
      expect(t.agentsAfter).toBe(t.agentsBefore)
    })
  }

  // dead end refusal-env: every refusal carries next_step and who_acts
  dead(DEAD.refusalEnv[kind])('every refusal seen carries next_step and who_acts', () => {
    const bare = t.refusals.filter((r) => !hasEnvelope(r))
    expect(bare.map((r) => String(r.error))).toEqual([])
  })

  // dead end bootstrap-lie: bootstrap_self advertised to a member of a populated tenant
  dead(DEAD.bootstrapLie[kind])('bootstrap_self is not advertised to a client that is not the first member of an empty tenant', () => {
    expect(doorsOf(t.boot)).not.toContain('bootstrap_self')
    expect(stepWords(t.boot).join(' ')).not.toContain('bootstrap_self')
  })

  // dead end no-whoami: no single whoami block
  dead(DEAD.noWhoami[kind])('boot_context returns one whoami block {state, have, missing}', () => {
    const whoami = asObj(t.boot.whoami)
    expect(typeof whoami.state).toBe('string')
    expect(Array.isArray(whoami.have)).toBe(true)
    expect(Array.isArray(whoami.missing)).toBe(true)
  })

  // dead end split-steps: next_step fields name different actions
  dead(DEAD.splitSteps[kind])('boot has one next step: next_step and onboarding.next_step do not diverge', () => {
    expect(stepWords(t.boot).length).toBeLessThanOrEqual(1)
  })
})
