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

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

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
            t.channel       AS channel
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

async function memberCanOnSquad(
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
type ToolOutcome = { ok: true; result: unknown } | { ok: false } & ToolError

function fail(status: ToolError['status'], error: string, detail?: unknown): ToolOutcome {
  return { ok: false, status, error, detail }
}
function done(result: unknown): ToolOutcome {
  return { ok: true, result }
}

// ── arg readers (NEVER trust an identity field from args) ─────────────────────
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null
}

// ── the tool surface ──────────────────────────────────────────────────────────
// Each tool: (auth, env, args) → ToolOutcome. The actor is ALWAYS auth.memberId,
// never anything in args. Capability is checked against the tool's target scope.

interface ToolSpec {
  name: string
  // human-facing description of scope + minimum capability for /mcp/tools
  scope: string
  min: Capability | 'authenticated'
  args: string // documented arg shape
  run: (auth: AuthContext, env: Env, args: Record<string, unknown>) => Promise<ToolOutcome>
}

// task_create — create a task on a squad. cap: member+ on the TARGET squad.
const toolTaskCreate: ToolSpec = {
  name: 'task_create',
  scope: 'squad',
  min: 'member',
  args: '{ squad_id: string, title: string, body?: string }',
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
    if (!res.ok) return fail(409, 'wake_failed', runtime)
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

const TOOLS: ToolSpec[] = [
  toolTaskCreate,
  toolRemember,
  toolRecall,
  toolWakeAgent,
  toolSquadMessage,
  toolStatus,
]

const TOOL_BY_NAME = new Map<string, ToolSpec>(TOOLS.map((t) => [t.name, t]))

// ── app ───────────────────────────────────────────────────────────────────────
export const mcpApp = new Hono<AppEnv>()

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

// Authenticate every invocation path. Identity is derived from the bearer token
// ONLY; we set the resolved Principal on c so tools read it (never the body).
mcpApp.use('/', async (c, next) => {
  const auth = await authenticateMember(c)
  if (!auth) return c.json({ error: 'unauthenticated' }, 401)
  // Hard tenant guard: a token is minted per-pot; the resolved tenant is forced
  // to env.TENANT_SLUG above, so this is belt-and-suspenders against drift.
  if (auth.tenant !== c.env.TENANT_SLUG) {
    return c.json({ error: 'forbidden', reason: 'tenant_scope' }, 403)
  }
  c.set('auth', auth)
  await next()
})

interface InvokeBody {
  tool?: unknown
  args?: unknown
}

// POST /mcp — invoke a tool. Body: {tool, args}. The actor is the authenticated
// member; we NEVER read an identity field from args.
mcpApp.post('/', async (c) => {
  let body: InvokeBody
  try {
    body = (await c.req.json()) as InvokeBody
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  const toolName = typeof body.tool === 'string' ? body.tool : null
  if (!toolName) return c.json({ error: 'invalid_request', detail: 'tool required' }, 400)

  const spec = TOOL_BY_NAME.get(toolName)
  if (!spec) {
    return c.json({ error: 'unknown_tool', tool: toolName }, 400)
  }

  // args must be an object (or omitted → {}). Never an array/scalar.
  let args: Record<string, unknown>
  if (body.args === undefined || body.args === null) {
    args = {}
  } else if (typeof body.args === 'object' && !Array.isArray(body.args)) {
    args = body.args as Record<string, unknown>
  } else {
    return c.json({ error: 'invalid_args', detail: 'args must be an object' }, 400)
  }

  const auth = c.get('auth')
  const outcome = await spec.run(auth, c.env, args)

  if (outcome.ok) {
    return c.json({ ok: true, tool: spec.name, result: outcome.result })
  }
  return c.json({ ok: false, tool: spec.name, error: outcome.error, detail: outcome.detail }, outcome.status)
})
