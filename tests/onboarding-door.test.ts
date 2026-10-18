// tests/onboarding-door.test.ts — onboarding-door conformance, lane D (mupot task 7e0cb92d,
// mumega-com #1443, design: agents/kasra/docs/design-navigable-onboarding-20261017.md).
//
// Four COLD clients play their first five minutes against the real MCP handler (mcpApp ->
// resolveAuth -> resolveSeatSession -> tool, real sqlite D1 from the full migration chain, the real
// OAuth consent path for the three OAuth clients). Nothing about the door is mocked.
//   1. ChatGPT thread   consent "Me - auto per workspace"; sends params._meta["openai/session"].
//   2. Claude thread    same consent, NO x-mupot-seat header and NO _meta (claude.ai sends neither).
//   3. Hermes agent     keyed agent token (workspace channel) for an existing agent with a signing key.
//   4. Unknown harness  consent "No agent" (no harness pointer, unbound directory grant).
// Walk: boot_context -> a refused probe (task_create on a squad the client holds nothing on) -> the first
// tool door of boot with its advertised args -> boot_context -> the first tool door of THAT boot (human-step
// doors, tool:null, are recorded as human_step, never called) -> boot_context -> orient -> status ->
// ONE real action each: task_create on the client's OWN squad, and inbox -> finally bootstrap_self, only for a
// client whose boot mentions it as a door or in its prose. The tenant is populated (an admin and an existing
// agent), so no client is the first member of an empty tenant. Env flags are PROD's (wrangler.toml read
// 2026-10-18): SEAT_AUTO_ENROLL=1, REALTIME_SEAT_EVENTS=1, SEAT_ATTACH unset (off).
//
// CONTRACT. A dead end is an assertion that fails on current main. Each is `it.fails(...)` (via `dead`), so
// the file is GREEN while the dead end exists; the lane that fixes it flips the flag in DEAD to false.
// vitest reports an `it.fails` that starts passing as a failure, so a fix cannot land without the flip.
// Every dead test first asserts its precondition (`pre`) so a fixture TypeError cannot satisfy it.
//
// DEAD ENDS (src/mcp/index.ts unless noted; lines on ac23c2e4):
//   seat-loop       Claude: after seat_select boot still reports no bound agent and the shown handle is refused as an
//                   argument (additionalProperties:false), because the handle is header/_meta only (resolveSeatSession :545-584, autoKeys :580; doors :6876-6930).
//   orient-refusal  orient on an unbound session answers invalid_args "agent required", no next_step/who_acts
//                   (toolOrient :7056, fail :7074). Claude, unknown.
//   bootstrap-refused  boot mentions bootstrap_self (door or prose: channel_limits.to_get_write_access) to a client for whom
//                   running it is refused: ChatGPT's bound seat (it is told to bootstrap_self, :6955+). Measured: for a
//                   handle-less Claude and for the unknown client bootstrap_self SUCCEEDS, so no flag there.
//   connect-after-bootstrap  (flag exists, currently false) unknown: after bootstrap_self boot offers connect { agent_name }
//                   (:6637-6638); in this fixture connect answers 200 session_local "hot" with the right slug, so the
//                   dead end shows up one step later, as real-action. Reported 403 directory_channel_zero_capability
//                   (:7243) was NOT reproduced; flip the flag to true if it reappears.
//   human-step-only unknown: after bootstrap the first door is {tool:null} "bind at /oauth/consent": a human step.
//   real-action     task_create on the client's own squad, and inbox, are refused for a thread with no handle
//                   (Claude) and for the unknown client even after bootstrap + connect (zero ambient authority).
//   thread-agent    a thread client creates an `agents` row: ChatGPT's first request (auto-seat), Claude's seat_select.
//   no-whoami       boot returns no `whoami` block {state, have[], missing[]}.
//   split-steps     next_step and onboarding.next_step name different actions (buildBootOnboarding :6494-6560).
//   refusal-env     refusals lack `next_step` and `who_acts` (fail() :832 takes only status, error, detail).
//
// Not fixed in the fixture: the server already accepts arguments._meta["mupot/seat"] (:553-557, stripped :8047)
// but every inputSchema is additionalProperties:false; lane C adds an explicit `seat` argument and edits the
// Claude walk then. Fixture lies vs prod: requests enter through mcpInternalRequest (the OAuthProvider token/props
// layer is skipped; the AuthContext IS rebuilt from the consent props on every call, as prod does); Google and
// the provider are stubbed only at the consent edge; the Hermes token and agent_keys row are seeded by SQL.

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
  seatLoop: { chatgpt: false, claude: false, hermes: false, unknown: false },
  orientRefusal: { chatgpt: false, claude: false, hermes: false, unknown: true },
  bootstrapRefused: { chatgpt: true, claude: false, hermes: false, unknown: false },
  connectAfterBootstrap: { chatgpt: false, claude: false, hermes: false, unknown: false },
  humanStepOnly: { chatgpt: false, claude: false, hermes: false, unknown: true },
  actionTask: { chatgpt: false, claude: false, hermes: false, unknown: true },
  actionInbox: { chatgpt: false, claude: false, hermes: false, unknown: true },
  threadAgent: { chatgpt: true, claude: true, hermes: false, unknown: false },
  noWhoami: { chatgpt: true, claude: true, hermes: true, unknown: true },
  splitSteps: { chatgpt: true, claude: true, hermes: false, unknown: true },
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
/** props: OAuth grant props (AuthContext rebuilt per call); bearer: workspace token. */
interface Client { kind: Kind; props: Json | null; bearer: string | null; meta?: Json; seat?: string }
interface World { h: SqliteD1Harness; env: Env; agents: () => number; refusals: Json[] }

function newWorld(): World {
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
  return { kind, props: await consent(w, clientName, `${kind}@pot.test`, choice), bearer: null, meta }
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
  return { kind: 'hermes', props: null, bearer: 'raw-hermes-token' }
}

/** One tools/call exactly as the client would send it. Only the ChatGPT client sends params._meta; nobody sends x-mupot-seat. */
async function rpc(w: World, c: Client, method: string, params: Json): Promise<Response> {
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

async function call(w: World, c: Client, name: string, args: Json = {}): Promise<Reply> {
  // Lane C: a thread with no header and no _meta sends the seat_id seat_select returned as `seat` on every later call.
  const res = await rpc(w, c, 'tools/call', { name, arguments: c.seat && !('seat' in args) ? { ...args, seat: c.seat } : args })
  const env = (await res.json()) as { result?: { isError?: boolean; structuredContent?: Json }; error?: { message?: string; data?: unknown; who_acts?: unknown; next_step?: unknown; next_tool?: unknown } }
  if (env.result?.isError) { w.refusals.push(env.result.structuredContent ?? {}); return { refused: true, body: env.result.structuredContent ?? {} } }
  // Lane B: the refusal envelope rides as SIBLING members of the JSON-RPC error (beside `data`, which keeps its old shape).
  if (env.error) { const b = { error: env.error.message, detail: env.error.data, who_acts: env.error.who_acts, next_step: env.error.next_step, next_tool: env.error.next_tool }; w.refusals.push(b); return { refused: true, body: b } }
  return { refused: res.status >= 400, body: env.result?.structuredContent ?? {} }
}

async function listTools(w: World, c: Client): Promise<Set<string>> {
  const res = (await (await rpc(w, c, 'tools/list', {})).json()) as { result?: { tools?: Array<{ name?: string }> } }
  return new Set((res.result?.tools ?? []).flatMap((t) => (typeof t.name === 'string' ? [t.name] : [])))
}

interface Door { tool: string | null; does?: string }
const doorList = (b: Json): Door[] => (Array.isArray(b.available_doors) ? (b.available_doors as Door[]) : [])
const toolDoors = (b: Json): string[] => doorList(b).flatMap((d) => (typeof d.tool === 'string' ? [d.tool] : []))
const asObj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})
const strs = (...v: unknown[]): string[] => v.filter((x): x is string => typeof x === 'string')
/** The two next-step fields. */
const stepFields = (b: Json): string[] => strs(b.next_step, asObj(b.onboarding).next_step)
/** Everything a model reads as direction: both next-step fields, the limits note, and every door's prose. */
const stepWords = (b: Json): string[] => [...stepFields(b), ...strs(asObj(b.channel_limits).to_get_write_access), ...doorList(b).flatMap((d) => strs(d.does))]
const hasEnvelope = (r: Json): boolean => {
  const inner = [r, asObj(r.detail), asObj(r.data)]
  return inner.some((o) => typeof o.next_step === 'string') && inner.some((o) => typeof o.who_acts === 'string')
}
/** The tool a piece of direction names: "call <tool>" first, else "<tool> {". Only names in `tools` count. */
const actionIn = (text: string | undefined, tools: Set<string>): string | undefined => {
  if (!text) return undefined
  const named = (re: RegExp): string | undefined => [...text.matchAll(re)].map((m) => m[1]).find((n) => tools.has(n))
  return named(/\b[Cc]all\s+([a-z_]+)/g) ?? named(/\b([a-z_]+)\s*\{/g)
}
const field = (r: Json, k: string): unknown => [r, asObj(r.detail), asObj(r.data)].map((o) => o[k]).find((v) => v !== undefined)
const squadIn = (b: Json): string | null => {
  const ids = [asObj(asObj(b.packet).squad).id, asObj(b.agent).squad_id, asObj(b.squad).id]
  return ids.find((x): x is string => typeof x === 'string') ?? null
}

interface Step { tool: string; reply: Reply }
interface Trace {
  boot: Json; boot2: Json; boot3: Json; steps: Step[]; humanSteps: string[]; orient: Reply; status: Reply
  task: Reply; inbox: Reply; tools: Set<string>; handleReply: Reply | null; w: World; c: Client; bootstrap: Reply | null; agentsBefore: number; agentsAfter: number; refusals: Json[]
}

const SKIP = ['status', 'boot_context']
const STATIC_ARGS: Record<string, Json> = { seat_select: { project: 'conformance' }, bootstrap_self: { agent_name: 'conformance-agent' } }

/** Take the first tool door of `boot`; a tool:null door is recorded as a human step and never called. */
async function takeDoor(w: World, c: Client, boot: Json, prior: Step[], humanSteps: string[]): Promise<void> {
  for (const d of doorList(boot)) if (d.tool === null) humanSteps.push(String(d.does))
  const tool = toolDoors(boot).find((t) => !SKIP.includes(t))
  if (!tool) return
  let args = STATIC_ARGS[tool] ?? {}
  if (tool === 'connect') {
    // slug: the quoted name in boot's own next_step, else the agent the previous door created
    const quoted = /agent_name:\s*"([^"<>]+)"/.exec(stepFields(boot).join(' '))?.[1]
    const made = prior.map((s) => asObj(s.reply.body.agent).slug).find((x): x is string => typeof x === 'string')
    args = { agent_name: quoted ?? made ?? 'unknown-slug' }
  }
  const reply = await call(w, c, tool, args)
  prior.push({ tool, reply })
  if (tool === 'seat_select' && typeof reply.body.seat_id === 'string') c.seat = reply.body.seat_id // do what the instruction says
}

async function walk(w: World, c: Client): Promise<Trace> {
  const agentsBefore = w.agents()
  const tools = await listTools(w, c)
  const boot = (await call(w, c, 'boot_context')).body
  // refusal probe: a VALID write on a squad the client holds nothing on, so the refusal is a capability one
  await call(w, c, 'task_create', { squad_id: 'sq-other', title: 'cold probe', done_when: 'task row exists with this title set' })
  const steps: Step[] = []
  const humanSteps: string[] = []
  await takeDoor(w, c, boot, steps, humanSteps)
  const boot2 = (await call(w, c, 'boot_context')).body
  // After seat_select the handle is shown once; a thread that cannot set headers or _meta can only send it as an argument.
  const handle = steps[0]?.tool === 'seat_select' ? steps[0].reply.body.seat_handle : undefined
  const handleReply = typeof handle === 'string' ? await call(w, c, 'boot_context', { seat: handle }) : null
  await takeDoor(w, c, boot2, steps, humanSteps)
  const boot3 = (await call(w, c, 'boot_context')).body
  const orient = await call(w, c, 'orient')
  const status = await call(w, c, 'status')
  const squad = steps.map((s) => squadIn(s.reply.body)).find((x) => x !== null) ?? 'sq-no-own-squad'
  const task = await call(w, c, 'task_create', { squad_id: squad, title: 'first real action', done_when: 'task row exists with this title set' })
  const inbox = await call(w, c, 'inbox')
  const agentsAfter = w.agents()
  const refusals = [...w.refusals]
  // Last: run bootstrap_self for a client whose boot mentions it as a door or in prose and that did not already walk it.
  const mentioned = toolDoors(boot).includes('bootstrap_self') || stepWords(boot).some((x) => x.includes('bootstrap_self'))
  const bootstrap = mentioned && !steps.some((s) => s.tool === 'bootstrap_self') ? await call(w, { ...c, seat: undefined }, 'bootstrap_self', STATIC_ARGS.bootstrap_self) : null // cold state: no seat carried
  return { w, c, tools, handleReply, boot, boot2, boot3, steps, humanSteps, orient, status, task, inbox, bootstrap, agentsBefore, agentsAfter, refusals }
}

afterEach(() => { vi.unstubAllGlobals() })

const CLIENTS: Record<Kind, (w: World) => Promise<Client>> = {
  chatgpt: (w) => oauthClient(w, 'chatgpt', 'ChatGPT', HARNESS_CHOICE, { 'openai/session': 'conv-cold-1' }),
  claude: (w) => oauthClient(w, 'claude', 'Claude', HARNESS_CHOICE),
  hermes: (w) => hermesClient(w),
  unknown: (w) => oauthClient(w, 'unknown', 'Some New Harness', ''),
}

describe.each(Object.keys(CLIENTS) as Kind[])('cold %s client, first five minutes', (kind) => {
  let t: Trace
  beforeAll(async () => {
    const w = newWorld()
    t = await walk(w, await CLIENTS[kind](w))
    return () => w.h.close()
  })
  /** Precondition for every dead test: the fixture produced a real boot, a walked door and orient/status answers. */
  const pre = (): void => {
    expect(typeof t.boot.onboarding_state).toBe('string')
    expect(doorList(t.boot).length).toBeGreaterThan(0)
    expect(t.steps.length).toBeGreaterThan(0)
    expect(Object.keys(t.status.body).length).toBeGreaterThan(0)
    expect(Object.keys(t.orient.body).length).toBeGreaterThan(0)
    expect(t.refusals.length).toBeGreaterThan(0)
  }

  it('fixture sanity: boot answered, a door was walked, and the capability probe really was refused', () => {
    pre()
    expect(String(t.refusals[0].error)).toMatch(/forbidden|capability/i)
  })

  it('the first advertised tool door is not refused', () => {
    expect(t.steps[0].reply.refused, JSON.stringify(t.steps[0].reply.body)).toBe(false)
  })

  // dead end connect-after-bootstrap: the second door (unknown: connect after bootstrap_self) is refused
  dead(DEAD.connectAfterBootstrap[kind])('the second advertised tool door is not refused', () => {
    pre()
    expect(t.steps.length).toBeGreaterThan(1)
    expect(t.steps[1].reply.refused, JSON.stringify(t.steps[1].reply.body)).toBe(false)
  })

  // dead end seat-loop (seat_select only): the thread is bound afterwards, and the handle it was shown is accepted
  dead(DEAD.seatLoop[kind])('after seat_select the thread is bound and its seat handle is accepted on the next call', async () => {
    pre()
    if (t.steps[0].tool !== 'seat_select') return
    expect(t.boot2.bound_agent_id ?? null).not.toBeNull()
    expect(t.handleReply, 'a handle was shown').not.toBeNull()
    expect(t.handleReply?.refused, JSON.stringify(t.handleReply?.body)).toBe(false)
    expect(t.handleReply?.body.bound_agent_id ?? null).not.toBeNull()
  })

  // dead end human-step-only: boot's first door after the walk is a tool:null human step
  dead(DEAD.humanStepOnly[kind])('boot does not lead with a human step (tool:null door) as the first move', () => {
    pre()
    expect(doorList(t.boot2)[0]?.tool).not.toBeNull()
    expect(t.humanSteps).toEqual([])
  })

  // dead end orient-refusal: bound -> a real packet about the bound agent; unbound -> an envelope naming a callable door
  dead(DEAD.orientRefusal[kind])('orient answers a real packet when bound, or a who_acts + next_step envelope when not', async () => {
    pre()
    const boundId = t.boot3.bound_agent_id ?? null
    if (boundId !== null) {
      expect(t.orient.refused, JSON.stringify(t.orient.body)).toBe(false)
      expect(asObj(asObj(t.orient.body.packet).agent).id).toBe(boundId)
    } else {
      expect(t.orient.refused).toBe(true)
      expect(['self', 'owner', 'admin', 'org_admin']).toContain(field(t.orient.body, 'who_acts'))
      const next = actionIn(String(field(t.orient.body, 'next_step') ?? ''), t.tools)
      expect(toolDoors(t.boot3)).toContain(next)
      // Lane B round 2: a door that boot lists is not enough; the named tool must NOT be refused for this very session
      // ("Call seat_attach", "Call boot_context", "Call connect" would each satisfy the line above and fail here).
      expect(next).toBeDefined()
      const again = await call(t.w, t.c, String(next), STATIC_ARGS[String(next)] ?? {})
      expect(again.refused, `${String(next)}: ${JSON.stringify(again.body)}`).toBe(false)
      if (kind === 'claude') {
        // Pinned per connection kind: a Claude thread (harness, no seat) acts for itself; seat_select first.
        expect(field(t.orient.body, 'who_acts')).toBe('self')
        expect(next).toBe('seat_select')
      }
    }
  })

  it('status agrees with boot_context about who is bound', () => {
    expect(t.status.body.bound_agent_id ?? null).toBe(t.boot3.bound_agent_id ?? null)
  })

  it('orient, when it answers, is about the agent boot says is bound', () => {
    const agent = asObj(asObj(t.orient.body.packet).agent)
    if (!t.orient.refused && t.boot3.bound_agent_id) expect(agent.id).toBe(t.boot3.bound_agent_id)
  })

  // dead end real-action: task_create on the client's own squad, and inbox
  dead(DEAD.actionTask[kind])('task_create on the client\'s own squad is not refused', () => {
    pre()
    expect(t.task.refused, JSON.stringify(t.task.body)).toBe(false)
  })
  dead(DEAD.actionInbox[kind])('inbox is not refused', () => {
    pre()
    expect(t.inbox.refused, JSON.stringify(t.inbox.body)).toBe(false)
  })

  // dead end thread-agent: a thread (ChatGPT, Claude) must not mint an agents row
  if (kind === 'chatgpt' || kind === 'claude') {
    dead(DEAD.threadAgent[kind])('a thread client creates no new agents row', () => {
      pre()
      expect(t.agentsAfter).toBe(t.agentsBefore)
    })
  }

  // dead end refusal-env: every refusal names who acts and a tool THIS client can call, and calling it is not refused with the same code
  dead(DEAD.refusalEnv[kind])('every refusal carries who_acts and a next_step naming a callable tool that does not loop', async () => {
    pre()
    const problems: string[] = []
    for (const r of t.refusals) {
      const next = actionIn(String(field(r, 'next_step') ?? ''), t.tools)
      if (typeof field(r, 'who_acts') !== 'string' || next === undefined) { problems.push(`${String(r.error)}: no who_acts/callable next_step`); continue }
      const again = await call(t.w, t.c, next, STATIC_ARGS[next] ?? {})
      if (again.refused && again.body.error === r.error) problems.push(`${String(r.error)}: next_step ${next} refuses with the same code`)
    }
    expect(problems).toEqual([])
  })

  // dead end bootstrap-refused: bootstrap_self mentioned by boot (door or prose) but refused for this client
  dead(DEAD.bootstrapRefused[kind])('whatever boot says about bootstrap_self, running it is not refused', () => {
    pre()
    const ran = t.bootstrap ?? t.steps.find((s) => s.tool === 'bootstrap_self')?.reply
    if (ran === undefined) {
      expect(stepWords(t.boot).some((x) => x.includes('bootstrap_self')) || toolDoors(t.boot).includes('bootstrap_self')).toBe(false)
    } else expect(ran.refused, JSON.stringify(ran.body)).toBe(false)
  })

  // dead end no-whoami: a whoami block whose state, missing[] and steps match the trace
  dead(DEAD.noWhoami[kind])('boot_context returns a whoami block whose state and missing[] match whether the client is bound', () => {
    pre()
    const whoami = asObj(t.boot3.whoami)
    const bound = (t.boot3.bound_agent_id ?? null) !== null
    const BOUND = ['bound', 'own_seat', 'acting_as_agent', 'host']
    const UNBOUND = ['no_agent', 'own_seat', 'unbound_no_agent', 'unbound_agent_exists', 'unbound_workspace']
    expect(bound ? BOUND : UNBOUND).toContain(whoami.state)
    const missing = Array.isArray(whoami.missing) ? (whoami.missing as Json[]) : []
    expect(Array.isArray(whoami.have)).toBe(true)
    if (bound) expect(missing).toHaveLength(0)
    else expect(missing.length).toBeGreaterThan(0)
    for (const m of missing) {
      expect(String(m.who_acts ?? '')).not.toBe('')
      expect(String(m.next_step ?? '')).not.toBe('')
      expect(typeof m.tool === 'string' ? t.tools.has(m.tool) : typeof m.link === 'string').toBe(true)
    }
  })

  // dead end split-steps: the ACTION (tool) each direction names must be one tool, whatever the field is called
  dead(DEAD.splitSteps[kind])('next_step, onboarding.next_step, doors[0] and the limits note all name the same tool', () => {
    pre()
    const b = t.boot
    const named = [b.next_step, asObj(b.onboarding).next_step, asObj(b.channel_limits).to_get_write_access]
      .map((x) => actionIn(typeof x === 'string' ? x : undefined, t.tools))
    named.push(doorList(b)[0]?.tool ?? undefined)
    expect(new Set(named.filter((x) => x !== undefined)).size).toBeLessThanOrEqual(1)
  })
})
