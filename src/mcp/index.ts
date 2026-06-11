// mupot — MCP seam. The network surface a MEMBER's workspace connects to.
//
// Humans are first-class nodes: a person puts a scoped member token in their
// workspace .mcp.json and acts on the pot over this seam, gated by capability —
// exactly like an agent, never by anything the client says about itself.
//
// Sovereign-core discipline (same as src/auth + src/auth/capability):
//   - AuthN here is a bearer member token. We sha256-HASH it (Web Crypto) and look
//     it up in member_tokens (not revoked). The raw token is never stored, logged,
//     or echoed — only its hash. Identity is ALWAYS derived server-side from the
//     token; we NEVER read an identity field out of the request body.
//   - AuthZ is OURS: every tool is gated by the FROZEN capability API
//     (resolveCapabilities / hasCapability) against the scope the tool targets.
//   - Tenant is environment-derived (env.TENANT_SLUG), never client-supplied.
//
// Wire contract (pragmatic JSON over MCP; full JSON-RPC is optional):
//   GET  /mcp/tools           → list the tool surface (names, scope, min capability)
//   POST /mcp  {tool, args}   → invoke a tool. 200 {ok:true, result} on success;
//                               400 invalid_request / unknown_tool / invalid_args,
//                               401 unauthenticated, 403 forbidden, 404 not_found.
//
// Every mutating tool emits an ATTRIBUTED BusEvent (actor {kind:'member', id})
// via createBus, so downstream consumers know a human caused the effect.

import { Hono } from 'hono'
import type {
  Env,
  AuthContext,
  Member,
  Capability,
  CapabilityGrant,
  BusEvent,
  Agent,
  Squad,
} from '../types'
import { resolveCapabilities, hasCapability } from '../auth/capability'
import { createBus } from '../bus'
import { createMemory } from '../memory'
import { createTask } from '../tasks/service'
import { buildOrient, renderBrief } from '../orient/service'
import { mcpEndpoint, canonicalOrigin } from '../dashboard/connect'
import { resolveAgentRef } from '../org/resolve'
import { PROVISION_TOOLS } from './provision'
// AUTH_CONTEXT_HEADER lives in a separate module (no cloudflare:workers dep) so
// Vitest can import it without the CF runtime. See ./auth-header.ts.
import { AUTH_CONTEXT_HEADER } from './auth-header'

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

// ── auth context resolution — dual-door ──────────────────────────────────────
// C1/C2 convergence: the OAuth API handler pre-resolves the AuthContext (with live
// capability resolution) and attaches it as an internal header before dispatching
// to mcpApp. Direct callers (member API key, test harness) arrive without that
// header and fall through to authenticateMember's sha256 hash lookup.
//
// The internal header key (x-mupot-auth-context) is only set by McpOAuthApiHandler
// (src/mcp/oauth-api-handler.ts) — it never arrives from an external client because:
//   - The OAuthProvider's apiRoute is '/mcp'; it calls the WorkerEntrypoint, which
//     sets the header on a Worker-internal Request before calling mcpApp.fetch.
//   - External clients POST directly to /mcp; the OAuthProvider intercepts and
//     validates the token before dispatching — by the time mcpApp sees the request
//     the Bearer header has been consumed and the internal header is set.
//   - Requests bypassing the OAuthProvider (local tests, /actions/:tool) never carry
//     the internal header; they use authenticateMember.
//
// SECURITY NOTE: this header is purely internal. If an external client somehow
// sets it (which cannot happen through the OAuthProvider wrapper), the value is a
// JSON blob for a memberId that must still pass the live token liveness check inside
// buildAuthContextFromProps — the header alone cannot elevate privileges.

async function resolveAuth(c: {
  req: {
    header: (name: string) => string | undefined
  }
  env: Env
}): Promise<AuthContext | null> {
  const injected = c.req.header(AUTH_CONTEXT_HEADER)
  if (injected) {
    try {
      const auth = JSON.parse(injected) as AuthContext
      // Validate the minimal invariants we require before accepting the injected context.
      if (typeof auth.userId === 'string' && typeof auth.tenant === 'string') {
        return auth
      }
    } catch {
      // Malformed internal header — fall through to authenticateMember.
    }
  }
  return authenticateMember(c)
}

// ── member memory scope ──────────────────────────────────────────────────────
// The MemoryPort is keyed by an opaque id string. A member's OWN memory lives
// under a namespaced key so it never collides with an agent id (which is a bare
// uuid). recall/remember for a member always use this — a member can only touch
// their own scope; there is no cross-member or agent memory access via this seam.
function memberMemoryScope(memberId: string): string {
  return `member:${memberId}`
}

// ── token hashing (Web Crypto, SHA-256 hex) ──────────────────────────────────
// Same discipline as the SOS bus: we store/compare only the hex digest, never
// the raw token. Constant work; no secret ever leaves this function as output.
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(digest)
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

// Extract the raw bearer token from the Authorization header, or null.
function bearerToken(header: string | undefined): string | null {
  if (!header) return null
  const m = header.match(/^Bearer\s+(.+)$/i)
  if (!m) return null
  const tok = m[1].trim()
  return tok.length > 0 ? tok : null
}

// ── authn middleware: bearer member token → Principal AuthContext ─────────────
// Resolves identity server-side from the token only. On any failure we 401 with
// a generic message (never distinguish "no token" from "bad token" to a caller —
// no oracle). The tenant is forced to env.TENANT_SLUG.
async function authenticateMember(c: {
  req: { header: (name: string) => string | undefined }
  env: Env
}): Promise<AuthContext | null> {
  const raw = bearerToken(c.req.header('authorization'))
  if (!raw) return null

  const tokenHash = await sha256Hex(raw)

  // Look up a live (not revoked) token, joined to its member. We re-check the
  // member's status: a suspended member's tokens are inert even if not revoked.
  const row = await c.env.DB.prepare(
    `SELECT m.id            AS member_id,
            m.email         AS email,
            m.display_name  AS display_name,
            m.telegram_chat_id AS telegram_chat_id,
            m.status        AS status,
            m.created_at    AS created_at,
            t.channel       AS channel,
            t.agent_id      AS bound_agent_id
       FROM member_tokens t
       JOIN members m ON m.id = t.member_id
      WHERE t.token_hash = ?1 AND t.revoked_at IS NULL
      LIMIT 1`,
  )
    .bind(tokenHash)
    .first<{
      member_id: string
      email: string | null
      display_name: string
      telegram_chat_id: string | null
      status: Member['status']
      created_at: string
      channel: AuthContext['channel']
      bound_agent_id: string | null
    }>()

  if (!row) return null
  if (row.status !== 'active') return null

  const capabilities = await resolveCapabilities(c.env, row.member_id)

  // role is the coarse org-role field on AuthContext; a member principal is
  // 'member' at the org-role layer. The REAL authorization is `capabilities`.
  const auth: AuthContext = {
    userId: row.member_id,
    email: row.email,
    role: 'member',
    tenant: c.env.TENANT_SLUG, // environment-derived, never from the client
    memberId: row.member_id,
    channel: row.channel ?? 'workspace',
    capabilities,
    boundAgentId: row.bound_agent_id ?? null, // the weld: an agent-scoped token orients ITSELF
  }
  return auth
}

// ── capability checks (use the FROZEN pure API + scope inheritance) ───────────
// For a SQUAD scope, a department-level grant must inherit down — so we resolve
// the squad's department_id from D1 (mirrors capability.ts's middleware) and pass
// it to the pure hasCapability. Fail-closed: an unknown squad → no inheritance.
async function resolveSquadDepartment(env: Env, squadId: string): Promise<string | null> {
  const r = await env.DB.prepare('SELECT department_id FROM squads WHERE id = ?1')
    .bind(squadId)
    .first<{ department_id: string }>()
  return r?.department_id ?? null
}

export async function memberCanOnSquad(
  env: Env,
  grants: CapabilityGrant[],
  squadId: string,
  min: Capability,
): Promise<boolean> {
  const deptId = await resolveSquadDepartment(env, squadId)
  return hasCapability(grants, 'squad', squadId, min, deptId)
}

// ── d1 helpers (read-only lookups; allow-listed table names) ──────────────────
async function loadSquad(env: Env, squadId: string): Promise<Squad | null> {
  const row = await env.DB.prepare(
    `SELECT id, department_id, slug, name, charter, created_at FROM squads WHERE id = ?1 LIMIT 1`,
  )
    .bind(squadId)
    .first<Squad>()
  return row ?? null
}

async function loadAgent(env: Env, agentId: string): Promise<Agent | null> {
  const row = await env.DB.prepare(
    `SELECT id, squad_id, slug, name, role, model, status, created_at FROM agents WHERE id = ?1 LIMIT 1`,
  )
    .bind(agentId)
    .first<Agent>()
  return row ?? null
}

// ── attributed bus emit ───────────────────────────────────────────────────────
// Every member-caused event carries actor {kind:'member', id} so the consumer +
// activity feed attribute the effect to the human, not an anonymous system call.
function memberActor(memberId: string): { kind: 'member'; id: string } {
  return { kind: 'member', id: memberId }
}

// AuthContext.memberId is optionally typed (`string | undefined`) because a
// web-only session may carry no member identity. But a tool ONLY runs after the
// authn middleware below, which exclusively builds a Principal with memberId set.
// So inside any tool, `auth.memberId as string` is sound — documented once here.

// ── tool result shape ─────────────────────────────────────────────────────────
// A tool returns either a value (→ 200 {ok:true, result}) or a typed error with
// an HTTP status (→ that status, {ok:false, error}).
type ToolError = { status: 400 | 403 | 404 | 409; error: string; detail?: unknown }
export type ToolOutcome = { ok: true; result: unknown } | { ok: false } & ToolError

export function fail(status: ToolError['status'], error: string, detail?: unknown): ToolOutcome {
  return { ok: false, status, error, detail }
}
export function done(result: unknown): ToolOutcome {
  return { ok: true, result }
}

// ── arg readers (NEVER trust an identity field from args) ─────────────────────
export function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null
}

// ── the tool surface ──────────────────────────────────────────────────────────
// Each tool: (auth, env, args) → ToolOutcome. The actor is ALWAYS auth.memberId,
// never anything in args. Capability is checked against the tool's target scope.

// Per-call context a tool may need beyond auth/args. `origin` is the public scheme+host
// the caller reached us on (e.g. https://agents.digid.ca) — orient needs it to render the
// pot's own MCP endpoint into the brief. Derived from the request URL at each call site.
export type ToolCtx = { origin: string }

export interface ToolSpec {
  name: string
  // human-facing description of scope + minimum capability for /mcp/tools
  scope: string
  min: Capability | 'authenticated'
  args: string // documented arg shape
  inputSchema: JsonSchema
  // ctx is the 4th param; tools that don't need it simply omit it from their signature
  // (a function of fewer params is assignable here — TS structural typing).
  run: (auth: AuthContext, env: Env, args: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolOutcome>
}

type JsonSchema = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties: boolean
}

const STRING_SCHEMA = { type: 'string' }
const OPTIONAL_STRING_ARRAY_SCHEMA = { type: 'array', items: { type: 'string' } }
const OPTIONAL_NUMBER_SCHEMA = { type: 'number' }

// task_create — create a task on a squad. cap: member+ on the TARGET squad.
const toolTaskCreate: ToolSpec = {
  name: 'task_create',
  scope: 'squad',
  min: 'member',
  args: '{ squad_id: string, title: string, body?: string }',
  inputSchema: {
    type: 'object',
    properties: { squad_id: STRING_SCHEMA, title: STRING_SCHEMA, body: STRING_SCHEMA },
    required: ['squad_id', 'title'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const squadId = str(args.squad_id)
    const title = str(args.title)
    if (!squadId) return fail(400, 'invalid_args', 'squad_id required')
    if (!title) return fail(400, 'invalid_args', 'title required')

    const squad = await loadSquad(env, squadId)
    if (!squad) return fail(404, 'squad_not_found')

    const grants = auth.capabilities ?? []
    if (!(await memberCanOnSquad(env, grants, squad.id, 'member'))) {
      return fail(403, 'forbidden', { need: 'member', scope: 'squad' })
    }

    const body =
      args.body === undefined || args.body === null
        ? ''
        : typeof args.body === 'string'
          ? args.body
          : null
    if (body === null) return fail(400, 'invalid_args', 'body must be a string')

    const task = await createTask(
      env,
      {
        squad_id: squad.id,
        title: title.trim(),
        body,
      },
      { actor: memberActor(auth.memberId as string) },
    )

    return done({ task })
  },
}

// remember — write to the MEMBER's OWN memory scope. cap: authenticated member.
const toolRemember: ToolSpec = {
  name: 'remember',
  scope: 'self',
  min: 'authenticated',
  args: '{ text: string, concepts?: string[] }',
  inputSchema: {
    type: 'object',
    properties: { text: STRING_SCHEMA, concepts: OPTIONAL_STRING_ARRAY_SCHEMA },
    required: ['text'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const text = str(args.text)
    if (!text) return fail(400, 'invalid_args', 'text required')

    let concepts: string[] | undefined
    if (Array.isArray(args.concepts)) {
      concepts = args.concepts.filter((x): x is string => typeof x === 'string')
    } else if (args.concepts !== undefined) {
      return fail(400, 'invalid_args', 'concepts must be a string[]')
    }

    const scope = memberMemoryScope(auth.memberId as string)
    const id = await createMemory(env).remember(scope, text, concepts)
    return done({ engram_id: id })
  },
}

// recall — read from the MEMBER's OWN memory scope only. cap: authenticated.
const toolRecall: ToolSpec = {
  name: 'recall',
  scope: 'self',
  min: 'authenticated',
  args: '{ query: string, limit?: number }',
  inputSchema: {
    type: 'object',
    properties: { query: STRING_SCHEMA, limit: OPTIONAL_NUMBER_SCHEMA },
    required: ['query'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const query = str(args.query)
    if (!query) return fail(400, 'invalid_args', 'query required')

    let limit = 5
    if (typeof args.limit === 'number' && Number.isFinite(args.limit)) {
      limit = Math.min(20, Math.max(1, Math.floor(args.limit)))
    } else if (args.limit !== undefined) {
      return fail(400, 'invalid_args', 'limit must be a number')
    }

    const scope = memberMemoryScope(auth.memberId as string)
    const hits = await createMemory(env).recall(scope, query, limit)
    return done({ hits })
  },
}

// wake_agent — drive one cortex cycle of an agent. cap: lead+ on the AGENT's squad.
const toolWakeAgent: ToolSpec = {
  name: 'wake_agent',
  scope: 'squad (of the agent)',
  min: 'lead',
  args: '{ agent_id: string, reason?: string, context?: string, maxActions?: number }',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: STRING_SCHEMA,
      reason: STRING_SCHEMA,
      context: STRING_SCHEMA,
      maxActions: OPTIONAL_NUMBER_SCHEMA,
    },
    required: ['agent_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const agentId = str(args.agent_id)
    if (!agentId) return fail(400, 'invalid_args', 'agent_id required')

    const agent = await loadAgent(env, agentId)
    if (!agent) return fail(404, 'agent_not_found')

    const grants = auth.capabilities ?? []
    if (!(await memberCanOnSquad(env, grants, agent.squad_id, 'lead'))) {
      return fail(403, 'forbidden', { need: 'lead', scope: 'squad' })
    }

    if (agent.status !== 'active') return fail(409, 'agent_paused')

    const reason = typeof args.reason === 'string' ? args.reason : 'member.wake'
    const context = typeof args.context === 'string' ? args.context : undefined
    const maxActions =
      typeof args.maxActions === 'number' && Number.isFinite(args.maxActions)
        ? Math.max(0, Math.floor(args.maxActions))
        : undefined

    // Announce the (attributed) wake on the bus, then drive the DO directly so the
    // caller gets the cycle result synchronously — same pattern as agentsApp.
    const event: BusEvent<{ by: string; reason: string }> = {
      type: 'agent.wake',
      tenant: env.TENANT_SLUG,
      squad_id: agent.squad_id,
      agent_id: agent.id,
      actor: memberActor(auth.memberId as string),
      payload: { by: auth.memberId as string, reason },
      ts: new Date().toISOString(),
    }
    await createBus(env).emit(event)

    const stub = env.AGENT.get(env.AGENT.idFromName(agent.id))
    const res = await stub.fetch('https://agent/wake', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason, squad_id: agent.squad_id, context, maxActions }),
    })
    const runtime = await res.json<unknown>()
    // Do NOT reflect the raw Durable Object error body (WARN-4) — it may carry internal
    // runtime detail into the caller / ChatGPT connector. Fixed reason on failure.
    if (!res.ok) return fail(409, 'wake_failed')
    return done({ agent_id: agent.id, runtime })
  },
}

// squad_message — message/dispatch a squad. cap: member+ on the squad. The message
// becomes the dispatch context; the consumer routes it to the squad coordinator.
const toolSquadMessage: ToolSpec = {
  name: 'squad_message',
  scope: 'squad',
  min: 'member',
  args: '{ squad_id: string, message: string }',
  inputSchema: {
    type: 'object',
    properties: { squad_id: STRING_SCHEMA, message: STRING_SCHEMA },
    required: ['squad_id', 'message'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const squadId = str(args.squad_id)
    const message = str(args.message)
    if (!squadId) return fail(400, 'invalid_args', 'squad_id required')
    if (!message) return fail(400, 'invalid_args', 'message required')

    const squad = await loadSquad(env, squadId)
    if (!squad) return fail(404, 'squad_not_found')

    const grants = auth.capabilities ?? []
    if (!(await memberCanOnSquad(env, grants, squad.id, 'member'))) {
      return fail(403, 'forbidden', { need: 'member', scope: 'squad' })
    }

    const event: BusEvent<{ message: string; by: string }> = {
      type: 'squad.dispatch',
      tenant: env.TENANT_SLUG,
      squad_id: squad.id,
      actor: memberActor(auth.memberId as string),
      payload: { message, by: auth.memberId as string },
      ts: new Date().toISOString(),
    }
    await createBus(env).emit(event)

    return done({ dispatched: true, squad_id: squad.id })
  },
}

// status — read-only agent runtime telemetry. cap: any authenticated member.
// Read-only and tenant-scoped (the agent row is resolved from this pot's D1).
const toolStatus: ToolSpec = {
  name: 'status',
  scope: 'self/agent (read-only)',
  min: 'authenticated',
  args: '{ agent_id?: string }',
  inputSchema: {
    type: 'object',
    properties: { agent_id: STRING_SCHEMA },
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const agentId = str(args.agent_id)
    if (!agentId) {
      // No agent specified → echo the member's own principal (who am I + caps).
      return done({
        member_id: auth.memberId,
        email: auth.email,
        channel: auth.channel,
        tenant: auth.tenant,
        capabilities: auth.capabilities ?? [],
      })
    }

    const agent = await loadAgent(env, agentId)
    if (!agent) return fail(404, 'agent_not_found')

    const stub = env.AGENT.get(env.AGENT.idFromName(agent.id))
    const res = await stub.fetch('https://agent/status')
    const runtime = await res.json<unknown>()
    return done({
      agent: {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        model: agent.model,
        status: agent.status,
        squad_id: agent.squad_id,
      },
      runtime,
    })
  },
}

// orient — the basin-drop. Any agent on any harness reads "who am I, my squad, my scope,
// my tasks, my tools, my field state" in-band. This is the harness-agnostic onboarding:
// the agent's identity is the token, the packet is grounded in THIS pot's D1 only.
//
// Self-default (the weld): an agent-scoped token (auth.boundAgentId set) orients ITSELF
// with no args. A human/operator token must name `agent` (id or slug). Gate mirrors the
// HTTP route exactly: org-admin OR ≥observer on the target agent's squad.
const toolOrient: ToolSpec = {
  name: 'orient',
  scope: 'self / agent-on-squad (read-only)',
  min: 'authenticated',
  args: '{ agent?: string }  // id or slug; omit to orient your own bound agent',
  inputSchema: {
    type: 'object',
    properties: { agent: STRING_SCHEMA },
    additionalProperties: false,
  },
  async run(auth, env, args, ctx) {
    // ref: explicit arg wins; else the token's bound agent (the weld). No identity from args
    // is ever TRUSTED — `agent` only NAMES a target; the capability check below authorizes it.
    const ref = str(args.agent) ?? auth.boundAgentId ?? null
    if (!ref) return fail(400, 'invalid_args', 'agent required (token is not agent-bound)')

    // Resolve id-first, slug-with-ambiguity-refusal (shared ../org/resolve). A bare slug
    // can match agents in different squads (UNIQUE(squad_id, slug)); refusing an ambiguous
    // slug keeps the capability check below from gating against an arbitrary row.
    const resolved = await resolveAgentRef(env, ref)
    if (!resolved.ok) {
      return resolved.reason === 'ambiguous'
        ? fail(409, 'ambiguous_slug', 'slug matches multiple agents — use the id instead')
        : fail(404, 'agent_not_found')
    }
    const agentRef = resolved.value

    const grants = auth.capabilities ?? []
    const orgAdmin = hasCapability(grants, 'org', null, 'admin')
    const onSquad = await memberCanOnSquad(env, grants, agentRef.squad_id, 'observer')
    if (!orgAdmin && !onSquad) return fail(403, 'forbidden', { need: 'observer', scope: 'squad' })
    const callerCapability = orgAdmin ? 'admin' : 'observer+'

    // viewSensitive (#88): budget + field/trust are visible only to the agent ITSELF
    // (the weld), its squad leads, or admins — never a bare observer viewing a peer.
    // || short-circuits, so the lead query only runs when not already self/admin.
    const isSelf = auth.boundAgentId === agentRef.id
    const viewSensitive =
      orgAdmin || isSelf || (await memberCanOnSquad(env, grants, agentRef.squad_id, 'lead'))

    const { data, notFound } = await buildOrient(
      env,
      agentRef.id,
      callerCapability,
      mcpEndpoint(canonicalOrigin(env, ctx.origin)),
      viewSensitive,
      Date.now(),
    )
    if (notFound || !data) return fail(404, 'agent_not_found')
    return done({ packet: data, brief: renderBrief(data) })
  },
}

const TOOLS: ToolSpec[] = [
  toolTaskCreate,
  toolRemember,
  toolRecall,
  toolWakeAgent,
  toolSquadMessage,
  toolStatus,
  toolOrient,
  ...PROVISION_TOOLS,
]

const TOOL_BY_NAME = new Map<string, ToolSpec>(TOOLS.map((t) => [t.name, t]))

interface JsonRpcRequest {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

function isJsonRpcRequest(body: unknown): body is JsonRpcRequest {
  return typeof body === 'object' && body !== null && 'method' in body
}

function rpcResult(id: unknown, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }), {
    headers: { 'content-type': 'application/json' },
  })
}

function rpcError(id: unknown, code: number, message: string, data?: unknown, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message, data } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function mcpTool(spec: ToolSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: `${spec.scope}; minimum capability: ${spec.min}. Args: ${spec.args}`,
    inputSchema: spec.inputSchema,
  }
}

function mcpCallResult(tool: string, result: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: true, tool, result }) }],
    structuredContent: result,
  }
}

// ── runtime schema enforcement (defense-in-depth at the seam) ─────────────────
// The per-tool inputSchema was previously DECORATIVE — only documentation. Every
// security-relevant field is still hand-validated inside each tool, but a future
// tool author who trusts the schema could leave a hole (kasra-review W1). So we
// enforce the schema's hard contract HERE, before any tool runs: required keys must
// be present, unknown keys are rejected (additionalProperties:false), and each known
// key must match its declared scalar/array type. This is the SUPPORTED subset of JSON
// Schema the tools actually use; it never widens what a tool accepts.
function validateArgs(schema: JsonSchema, args: Record<string, unknown>): string | null {
  for (const req of schema.required ?? []) {
    if (args[req] === undefined || args[req] === null) return `missing required field: ${req}`
  }
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue
    // hasOwnProperty, NOT bracket access: `args.constructor`/`__proto__` would
    // otherwise resolve to an INHERITED Object.prototype member and be treated as a
    // known field, bypassing additionalProperties:false (prototype-key bypass, P2).
    const known = Object.prototype.hasOwnProperty.call(schema.properties, key)
    if (!known) {
      if (schema.additionalProperties === false) return `unknown field: ${key}`
      continue
    }
    const prop = schema.properties[key] as { type?: string; items?: { type?: string } } | undefined
    if (!prop) continue
    if (value === null) continue // optional-null is fine; tools coerce null themselves
    if (prop.type === 'string' && typeof value !== 'string') return `field ${key} must be a string`
    if (prop.type === 'number' && !(typeof value === 'number' && Number.isFinite(value))) {
      return `field ${key} must be a number`
    }
    if (prop.type === 'array') {
      if (!Array.isArray(value)) return `field ${key} must be an array`
      if (prop.items?.type === 'string' && !value.every((v) => typeof v === 'string')) {
        return `field ${key} must be an array of strings`
      }
    }
  }
  return null
}

async function invokeTool(
  auth: AuthContext,
  env: Env,
  toolName: unknown,
  argsValue: unknown,
  origin: string,
): Promise<ToolOutcome & { tool?: string }> {
  if (typeof toolName !== 'string' || toolName.length === 0) {
    return { ...fail(400, 'invalid_request', 'tool required'), tool: undefined }
  }

  const spec = TOOL_BY_NAME.get(toolName)
  if (!spec) return { ...fail(400, 'unknown_tool', toolName), tool: toolName }

  let args: Record<string, unknown>
  if (argsValue === undefined || argsValue === null) {
    args = {}
  } else if (typeof argsValue === 'object' && !Array.isArray(argsValue)) {
    args = argsValue as Record<string, unknown>
  } else {
    return { ...fail(400, 'invalid_args', 'args must be an object'), tool: spec.name }
  }

  const schemaError = validateArgs(spec.inputSchema, args)
  if (schemaError) return { ...fail(400, 'invalid_args', schemaError), tool: spec.name }

  const outcome = await spec.run(auth, env, args, { origin })
  return { ...outcome, tool: spec.name }
}

async function handleJsonRpc(c: import('hono').Context<AppEnv>, body: JsonRpcRequest): Promise<Response> {
  const id = body.id ?? null
  const method = typeof body.method === 'string' ? body.method : ''

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: `mupot-${c.env.TENANT_SLUG}`, version: '0.16.0' },
    })
  }

  if (method === 'notifications/initialized') {
    return new Response(null, { status: 204 })
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS.map(mcpTool) })
  }

  if (method === 'tools/call') {
    const auth = await resolveAuth(c)
    if (!auth || auth.tenant !== c.env.TENANT_SLUG) {
      return rpcError(id, -32001, 'unauthenticated', undefined, 401)
    }

    const params = typeof body.params === 'object' && body.params !== null ? body.params as Record<string, unknown> : {}
    const outcome = await invokeTool(auth, c.env, params.name, params.arguments, new URL(c.req.url).origin)
    if (outcome.ok) return rpcResult(id, mcpCallResult(outcome.tool as string, outcome.result))

    return rpcError(
      id,
      outcome.status === 404 ? -32602 : -32000,
      outcome.error,
      outcome.detail,
      outcome.status,
    )
  }

  return rpcError(id, -32601, 'method_not_found', method)
}

// ── app ───────────────────────────────────────────────────────────────────────
export const mcpApp = new Hono<AppEnv>()
export const mcpActionsApp = new Hono<AppEnv>()

mcpApp.get('/health', (c) => c.json({ ok: true, component: 'mcp', tenant: c.env.TENANT_SLUG }))

// GET /mcp/tools — advertise the tool surface (no auth required to discover the
// shape; auth is required to INVOKE). Lists name, target scope, min capability,
// and arg shape — the contract a member's workspace codes against.
mcpApp.get('/tools', (c) =>
  c.json({
    contract: 'POST /mcp {tool, args} — bearer member token in Authorization header',
    tools: TOOLS.map((t) => ({
      name: t.name,
      scope: t.scope,
      min_capability: t.min,
      args: t.args,
    })),
  }),
)

interface InvokeBody {
  tool?: unknown
  args?: unknown
}

// POST /mcp — either:
//   - JSON-RPC MCP: initialize, tools/list, tools/call
//   - legacy pragmatic JSON: {tool, args}
// The actor is the authenticated member; we NEVER read an identity field from args.
mcpApp.post('/', async (c) => {
  // Pre-auth body-size cap (WARN-1): initialize/tools/list are bearerless, so bound the
  // body BEFORE buffering to deny an unauthenticated memory/CPU-exhaustion POST.
  const len = Number(c.req.header('content-length') ?? '0')
  if (Number.isFinite(len) && len > 64 * 1024) return c.json({ error: 'payload_too_large' }, 413)
  let body: InvokeBody | JsonRpcRequest
  try {
    body = (await c.req.json()) as InvokeBody | JsonRpcRequest
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  if (isJsonRpcRequest(body)) return handleJsonRpc(c, body)

  const auth = await resolveAuth(c)
  if (!auth) return c.json({ error: 'unauthenticated' }, 401)
  if (auth.tenant !== c.env.TENANT_SLUG) {
    return c.json({ error: 'forbidden', reason: 'tenant_scope' }, 403)
  }

  const outcome = await invokeTool(auth, c.env, body.tool, body.args, new URL(c.req.url).origin)

  if (outcome.ok) {
    return c.json({ ok: true, tool: outcome.tool, result: outcome.result })
  }
  return c.json({ ok: false, tool: outcome.tool, error: outcome.error, detail: outcome.detail }, outcome.status)
})

function openApiSpec(origin: string): Record<string, unknown> {
  const paths: Record<string, unknown> = {}
  for (const spec of TOOLS) {
    paths[`/actions/${spec.name}`] = {
      post: {
        operationId: spec.name,
        summary: spec.name,
        description: `${spec.scope}; minimum capability: ${spec.min}.`,
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: spec.inputSchema,
            },
          },
        },
        responses: {
          '200': {
            description: 'Tool result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    tool: { type: 'string' },
                    result: { type: 'object' },
                  },
                  required: ['ok', 'tool', 'result'],
                  additionalProperties: true,
                },
              },
            },
          },
          '400': { description: 'Invalid request' },
          '401': { description: 'Unauthenticated' },
          '403': { description: 'Forbidden' },
          '404': { description: 'Not found' },
          '409': { description: 'Conflict' },
        },
      },
    }
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'Mupot Digid Actions',
      version: '0.16.0',
      description: 'Custom GPT Actions facade for the Digid Mupot tool surface.',
    },
    servers: [{ url: origin }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
        },
      },
    },
    paths,
  }
}

mcpActionsApp.get('/openapi.json', (c) => {
  const url = new URL(c.req.url)
  return c.json(openApiSpec(url.origin))
})

mcpActionsApp.post('/actions/:tool', async (c) => {
  const len = Number(c.req.header('content-length') ?? '0')
  if (Number.isFinite(len) && len > 64 * 1024) return c.json({ error: 'payload_too_large' }, 413)
  const auth = await authenticateMember(c)
  if (!auth) return c.json({ error: 'unauthenticated' }, 401)
  if (auth.tenant !== c.env.TENANT_SLUG) {
    return c.json({ error: 'forbidden', reason: 'tenant_scope' }, 403)
  }

  let args: unknown = {}
  try {
    const raw = await c.req.text()
    args = raw.trim().length > 0 ? JSON.parse(raw) : {}
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  const outcome = await invokeTool(auth, c.env, c.req.param('tool'), args, new URL(c.req.url).origin)
  if (outcome.ok) return c.json({ ok: true, tool: outcome.tool, result: outcome.result })
  return c.json({ ok: false, tool: outcome.tool, error: outcome.error, detail: outcome.detail }, outcome.status)
})
