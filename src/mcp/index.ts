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
  Task,
} from '../types'
import { resolveCapabilities, hasCapability, holdsCapabilityFloor } from '../auth/capability'
import { isChannel } from '../members/service'
import { createBus } from '../bus'
import { createMemory } from '../memory'
import {
  assertCompletableDoneWhen,
  checkTransition,
  createTask,
  emitTaskEvent,
  isDoneWhenValid,
  mirrorTaskUpdate,
  patchToDoneBypassesGate,
  persistTaskUpdate,
  stampTaskUpdate,
  TaskProjectError,
  TaskUpdateConflictError,
  validateTaskProjectAttribution,
} from '../tasks/service'
import type { TaskStatus } from '../tasks/service'
import { resolveTaskAssignee } from '../tasks/assignee'
// #22 v1 ATC ranking: pure scorer + the radar's existing agent runtime-state
// loader (dashboard/radar.ts already uses this same loader for the fleet
// view — not a new query shape).
import {
  rankTasks,
  excludeFromRanking,
  actionableStatusInSql,
  terminalStatusInSql,
  actionableStatusOrderSql,
} from '../tasks/ranking'
import { loadAgentRuntimeStates, type AgentRuntimeState } from '../dashboard/observatory'
import { buildOrient, renderBrief } from '../orient/service'
import { mcpEndpoint, canonicalOrigin } from '../dashboard/connect'
import { classify, humanAge } from '../dashboard/fleet'
import { resolveAgentRef } from '../org/resolve'
import { sendToRef, readAgentInbox, sendAgentMessage } from '../agents/messages'
import { recordCheckin, sqliteUtcToMs } from '../fleet/presence'
import { PROVISION_TOOLS } from './provision'
import { PROJECT_TOOLS } from './projects'
import { dispatchFlight } from '../flight/dispatch'
import {
  deliverFlightLandedEvent,
  getFlight,
  landGovernedFlight,
  listFlightProjectMismatchTaskIds,
  listFlightsForSquad,
  listIncompleteFlightTaskIds,
  FlightProjectError,
  validateFlightProjectTarget,
  validateFlightTaskProjectConsistency,
  type FlightRow,
} from '../flight/service'
import { parseDispatchBody } from '../flight/routes'
import { loadFlightSquads, parseFlightMetaV1, validateFlightMetaReferences, type FlightMetaV1 } from '../flight/meta'
// AUTH_CONTEXT_HEADER lives in a separate module (no cloudflare:workers dep) so
// Vitest can import it without the CF runtime. See ./auth-header.ts.
import { AUTH_CONTEXT_HEADER } from './auth-header'
import { MUPOT_PUBLIC_API_VERSION } from '../version'

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
        // Boundary re-resolve (post-#266 hardening): the OAuth-convergence fix in
        // buildAuthContextFromProps now lets workspace/im channels carry the
        // member's real standing grants through this header (previously it was
        // ALWAYS []). That raised the blast radius of this internal seam — a
        // header the caller could ever influence (a future direct mcpApp mount,
        // a provider routing edge, a new resolveAuth caller) would go from
        // "carries nothing" to "carries owner-level authorization" verbatim.
        // So we treat the injected blob as an IDENTITY assertion only and always
        // re-derive capabilities server-side, ignoring whatever the blob claims —
        // same ceiling rule as buildAuthContextFromProps itself, applied again here.
        // isChannel (not a raw !== 'directory' check) mirrors buildAuthContextFromProps'
        // own normalization exactly: only a KNOWN non-directory channel (workspace/im/
        // dashboard) earns real caps — missing/garbage channel fails closed to [], same
        // as the producer, so the two ceilings can never diverge on a malformed blob.
        const knownNonDirectory = isChannel(auth.channel)
        auth.capabilities = knownNonDirectory ? await resolveCapabilities(c.env, auth.userId) : []
        if (!knownNonDirectory) auth.boundAgentId = null
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

function squadMemoryScope(squadId: string): string {
  return `squad:${squadId}`
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
      WHERE t.token_hash = ?1
        AND t.tenant = ?2
        AND m.tenant = ?2
        AND t.revoked_at IS NULL
      LIMIT 1`,
  )
    .bind(tokenHash, c.env.TENANT_SLUG)
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
    `SELECT id, department_id, slug, name, charter, budget_cap_cents, budget_window, created_at
       FROM squads WHERE id = ?1 LIMIT 1`,
  )
    .bind(squadId)
    .first<Squad>()
  return row ?? null
}

async function loadAgent(env: Env, agentId: string): Promise<Agent | null> {
  const row = await env.DB.prepare(
    `SELECT id, squad_id, slug, name, role, model, status, budget_cap_cents, budget_window, created_at
       FROM agents WHERE id = ?1 LIMIT 1`,
  )
    .bind(agentId)
    .first<Agent>()
  return row ?? null
}

async function loadMemberIdentity(env: Env, auth: AuthContext): Promise<{
  memberId: string
  displayName: string
  email: string | null
  boundAgentId: string | null
} | null> {
  const memberId = auth.memberId
  if (!memberId) return null
  const row = await env.DB.prepare(
    `SELECT display_name, email FROM members WHERE id = ?1 LIMIT 1`,
  )
    .bind(memberId)
    .first<{ display_name: string; email: string | null }>()
  return {
    memberId,
    displayName: row?.display_name ?? auth.email ?? memberId,
    email: row?.email ?? auth.email ?? null,
    boundAgentId: auth.boundAgentId ?? null,
  }
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
type ToolError = { status: 400 | 403 | 404 | 409 | 500; error: string; detail?: unknown }
export type ToolOutcome = { ok: true; result: unknown } | { ok: false } & ToolError

export function fail(status: ToolError['status'], error: string, detail?: unknown): ToolOutcome {
  return { ok: false, status, error, detail }
}
function failOnly(status: ToolError['status'], error: string, detail?: unknown): Extract<ToolOutcome, { ok: false }> {
  return fail(status, error, detail) as Extract<ToolOutcome, { ok: false }>
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
const NULLABLE_STRING_SCHEMA = { type: ['string', 'null'] }
const OPTIONAL_STRING_ARRAY_SCHEMA = { type: 'array', items: { type: 'string' } }
const OPTIONAL_NUMBER_SCHEMA = { type: 'number' }
const TASK_STATUSES: readonly TaskStatus[] = ['open', 'in_progress', 'blocked', 'done', 'review', 'approved', 'rejected']
const PATCH_ALLOWED_STATUSES: ReadonlySet<string> = new Set(['open', 'in_progress', 'blocked', 'done', 'review'])
const BROADCAST_REQUEST_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/

function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && (TASK_STATUSES as readonly string[]).includes(v)
}

function isPatchableStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && PATCH_ALLOWED_STATUSES.has(v)
}

async function sha256Short(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 64)
}

async function broadcastRecipientRequestId(base: string, toAgent: string): Promise<string> {
  return `bcast:${await sha256Short(`${base}\n${toAgent}`)}`
}

function readLimit(v: unknown, fallback: number, max: number): number | Extract<ToolOutcome, { ok: false }> {
  if (v === undefined || v === null) return fallback
  if (typeof v !== 'number' || !Number.isFinite(v)) return failOnly(400, 'invalid_args', 'limit must be a number')
  return Math.min(max, Math.max(1, Math.floor(v)))
}

function readConcepts(v: unknown): string[] | undefined | Extract<ToolOutcome, { ok: false }> {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) return failOnly(400, 'invalid_args', 'concepts must be a string[]')
  return v.filter((x): x is string => typeof x === 'string')
}

async function loadTask(env: Env, taskId: string): Promise<Task | null> {
  const row = await env.DB.prepare(
    `SELECT id, squad_id, project_id, title, body, done_when, status, assignee_agent_id, github_issue_url, result, completed_at, gate_owner, created_at, updated_at
       FROM tasks WHERE id = ?1 LIMIT 1`,
  )
    .bind(taskId)
    .first<Task>()
  return row ?? null
}

async function resolveTaskSquad(
  env: Env,
  auth: AuthContext,
  args: Record<string, unknown>,
): Promise<{ ok: true; squad: Squad } | Extract<ToolOutcome, { ok: false }>> {
  return resolveScopedSquad(
    env,
    auth,
    args,
    'member',
    'squad_id required unless the token is agent-bound',
    hasWorkspaceAdmin(auth),
  )
}

function hasWorkspaceAdmin(auth: AuthContext): boolean {
  if (auth.capabilities === undefined) return auth.role === 'owner' || auth.role === 'admin'
  return hasCapability(auth.capabilities, 'org', null, 'admin')
}

async function canReadProjectForSquad(
  env: Env,
  auth: AuthContext,
  projectId: string,
  squadId: string,
): Promise<boolean> {
  if (hasWorkspaceAdmin(auth)) {
    return (await env.DB.prepare('SELECT 1 FROM projects WHERE id = ?1')
      .bind(projectId)
      .first()) !== null
  }
  return (await env.DB.prepare(
    `SELECT 1 FROM project_squad_access WHERE project_id = ?1 AND squad_id = ?2`,
  ).bind(projectId, squadId).first()) !== null
}

async function hasProjectWriteForSquads(
  env: Env,
  projectId: string,
  squadIds: string[],
): Promise<boolean> {
  const uniqueSquadIds = [...new Set(squadIds)]
  if (uniqueSquadIds.length === 0) return false
  const placeholders = uniqueSquadIds.map((_, index) => `?${index + 2}`).join(', ')
  const rows = await env.DB.prepare(
    `SELECT squad_id, access_level
       FROM project_squad_access
      WHERE project_id = ?1
        AND squad_id IN (${placeholders})`,
  ).bind(projectId, ...uniqueSquadIds).all<{ squad_id: string; access_level: string }>()
  const writable = new Set(
    (rows.results ?? [])
      .filter((row) => row.access_level === 'write' || row.access_level === 'admin')
      .map((row) => row.squad_id),
  )
  return uniqueSquadIds.every((squadId) => writable.has(squadId))
}

function taskProjectFailure(error: TaskProjectError): ToolOutcome {
  if (error.code === 'project_not_found') return fail(404, error.code)
  if (error.code === 'project_access_forbidden') {
    return fail(403, 'forbidden', { need: 'project_write' })
  }
  return fail(400, error.code)
}

function flightProjectFailure(error: FlightProjectError): ToolOutcome {
  if (error.code === 'project_not_found' || error.code === 'flight_task_not_found') {
    return fail(404, error.code)
  }
  if (error.code === 'project_access_forbidden') {
    return fail(403, 'forbidden', { need: 'project_write' })
  }
  return fail(400, error.code)
}

async function resolveScopedSquad(
  env: Env,
  auth: AuthContext,
  args: Record<string, unknown>,
  min: Capability,
  missingDetail: string,
  workspaceAdminBypass = false,
): Promise<{ ok: true; squad: Squad } | Extract<ToolOutcome, { ok: false }>> {
  let squadId = str(args.squad_id)
  if (!squadId && auth.boundAgentId) {
    const agent = await loadAgent(env, auth.boundAgentId)
    squadId = agent?.squad_id ?? null
  }
  if (!squadId) return failOnly(400, 'invalid_args', missingDetail)

  const squad = await loadSquad(env, squadId)
  if (!squad) return failOnly(404, 'squad_not_found')

  const grants = auth.capabilities ?? []
  if (!workspaceAdminBypass && !(await memberCanOnSquad(env, grants, squad.id, min))) {
    return failOnly(403, 'forbidden', { need: min, scope: 'squad' })
  }
  return { ok: true, squad }
}

// task_create — create a task on a squad. cap: member+ on the TARGET squad.
// #142 capsule keystone: done_when is required — a non-empty verifiable success
// predicate (e.g. "test X passes", "GET /health returns 200").
const toolTaskCreate: ToolSpec = {
  name: 'task_create',
  scope: 'squad',
  min: 'member',
  args: '{ squad_id: string, project_id?: string|null, title: string, done_when: string, body?: string, assignee_agent_id?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      squad_id: STRING_SCHEMA,
      project_id: NULLABLE_STRING_SCHEMA,
      title: STRING_SCHEMA,
      done_when: { ...STRING_SCHEMA, description: 'Verifiable success predicate — a checkable condition that proves the task is complete.' },
      body: STRING_SCHEMA,
      assignee_agent_id: STRING_SCHEMA,
    },
    required: ['squad_id', 'title', 'done_when'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const squadId = str(args.squad_id)
    const title = str(args.title)
    if (!squadId) return fail(400, 'invalid_args', 'squad_id required')
    if (!title) return fail(400, 'invalid_args', 'title required')

    // #142: done_when guard at the MCP boundary (before any DB work).
    const doneWhen = typeof args.done_when === 'string' ? args.done_when.trim() : ''
    if (!doneWhen) return fail(400, 'done_when_required', 'done_when must be a non-empty verifiable success predicate')

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

    const assignee = await resolveTaskAssignee(env, args.assignee_agent_id, squad.id)
    if (assignee.error) return fail(400, assignee.error)

    const projectId = args.project_id == null ? null : str(args.project_id)
    if (args.project_id != null && !projectId) return fail(400, 'invalid_project_id')
    let task
    try {
      task = await createTask(
        env,
        {
          squad_id: squad.id,
          project_id: projectId,
          title: title.trim(),
          done_when: doneWhen,
          body,
          assignee_agent_id: assignee.value,
        },
        { actor: memberActor(auth.memberId as string) },
      )
    } catch (error) {
      if (error instanceof TaskProjectError) return taskProjectFailure(error)
      throw error
    }

    return done({ task })
  },
}

// task_list — list visible squad tasks over the MCP seam. cap: member+ on the
// target squad. Agent-bound tokens may omit squad_id and default to their own
// squad, which matches the runtime cutover path for brain/code agents.
const toolTaskList: ToolSpec = {
  name: 'task_list',
  scope: 'squad',
  min: 'member',
  args: '{ squad_id?: string, project_id?: string|null, status?: "open"|"in_progress"|"blocked"|"done"|"review"|"approved"|"rejected", assignee_agent_id?: string, limit?: number }',
  inputSchema: {
    type: 'object',
    properties: {
      squad_id: STRING_SCHEMA,
      project_id: NULLABLE_STRING_SCHEMA,
      status: STRING_SCHEMA,
      assignee_agent_id: STRING_SCHEMA,
      limit: OPTIONAL_NUMBER_SCHEMA,
    },
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const squadRes = await resolveTaskSquad(env, auth, args)
    if (!squadRes.ok) return squadRes
    const status = args.status
    if (status !== undefined && status !== null && !isTaskStatus(status)) {
      return fail(400, 'invalid_status')
    }
    const assignee = args.assignee_agent_id
    if (assignee !== undefined && assignee !== null && typeof assignee !== 'string') {
      return fail(400, 'invalid_args', 'assignee_agent_id must be a string')
    }
    const limit = readLimit(args.limit, 25, 100)
    if (typeof limit !== 'number') return limit

    const baseClauses = ['squad_id = ?1']
    const baseBinds: unknown[] = [squadRes.squad.id]
    const parsedProjectId = args.project_id == null ? undefined : str(args.project_id)
    if (args.project_id != null && !parsedProjectId) return fail(400, 'invalid_project_id')
    const projectId = parsedProjectId ?? undefined
    if (projectId) {
      if (!(await canReadProjectForSquad(env, auth, projectId, squadRes.squad.id))) {
        return fail(404, 'project_not_found')
      }
      baseClauses.push(`project_id = ?${baseBinds.length + 1}`)
      baseBinds.push(projectId)
    }
    if (typeof assignee === 'string' && assignee.trim()) {
      baseClauses.push(`assignee_agent_id = ?${baseBinds.length + 1}`)
      baseBinds.push(assignee.trim())
    }

    // #22 v1 ATC ranking (src/tasks/ranking.ts). Fetch is SPLIT and BOUNDED
    // at the SQL layer, not just reordered in JS after an unbounded read —
    // see ranking.ts's "SQL fetch-boundary helpers" section for the full P1
    // writeup (2026-07-16 adversarial finding): fetching unbounded rows
    // (there is no real "D1 1000-row cap" backstopping that — a prior draft
    // of this comment falsely claimed there was) ordered by raw recency lets
    // a squad with lots of `done`/gate-pipeline history fill the fetch
    // window entirely with terminal rows, hiding genuinely old, actionable,
    // high-priority work before rankTasks ever runs.
    const taskRows: Task[] = []

    if (status) {
      // Explicit ?status filter: one bounded query for that single status.
      // Actionable statuses fetch oldest-first (anti-starvation matters even
      // within one status); terminal statuses fetch newest-first (a caller
      // filtering to done/review/etc. wants the recent ones).
      const isActionable = !excludeFromRanking(status)
      const clauses = [...baseClauses, `status = ?${baseBinds.length + 1}`]
      const binds = [...baseBinds, status]
      const rows = await env.DB.prepare(
        `SELECT id, squad_id, project_id, title, body, done_when, status, assignee_agent_id, github_issue_url, result, completed_at, gate_owner, created_at, updated_at
           FROM tasks
          WHERE ${clauses.join(' AND ')}
          ORDER BY created_at ${isActionable ? 'ASC' : 'DESC'}
          LIMIT ${limit}`,
      )
        .bind(...binds)
        .all<Task>()
      taskRows.push(...(rows.results ?? []))
    } else {
      // No status filter: actionable rows get first claim on the entire
      // `limit` budget, fetched in the SAME band+age priority order rankTasks
      // uses (so a limit that does bind never crowds out a higher-priority
      // row). Terminal rows only fill whatever's left over — they can never
      // compete with actionable rows for the same slots (the P1 finding's
      // core failure mode).
      const actionableRows = await env.DB.prepare(
        `SELECT id, squad_id, project_id, title, body, done_when, status, assignee_agent_id, github_issue_url, result, completed_at, gate_owner, created_at, updated_at
           FROM tasks
          WHERE ${[...baseClauses, actionableStatusInSql()].join(' AND ')}
          ORDER BY ${actionableStatusOrderSql()}, created_at ASC
          LIMIT ${limit}`,
      )
        .bind(...baseBinds)
        .all<Task>()
      taskRows.push(...(actionableRows.results ?? []))

      const remaining = limit - taskRows.length
      if (remaining > 0) {
        const terminalRows = await env.DB.prepare(
          `SELECT id, squad_id, project_id, title, body, done_when, status, assignee_agent_id, github_issue_url, result, completed_at, gate_owner, created_at, updated_at
             FROM tasks
            WHERE ${[...baseClauses, terminalStatusInSql()].join(' AND ')}
            ORDER BY created_at DESC
            LIMIT ${remaining}`,
        )
          .bind(...baseBinds)
          .all<Task>()
        taskRows.push(...(terminalRows.results ?? []))
      }
    }

    const agentStates: ReadonlyMap<string, AgentRuntimeState> =
      taskRows.length > 0 ? await loadAgentRuntimeStates(env) : new Map()

    return done({ squad_id: squadRes.squad.id, tasks: rankTasks(taskRows, agentStates) })
  },
}

// task_board — compact kanban-style view for brain loops. It is intentionally
// read-only and squad-scoped; it groups the same rows task_list can read.
const toolTaskBoard: ToolSpec = {
  name: 'task_board',
  scope: 'squad',
  min: 'member',
  args: '{ squad_id?: string, limit?: number }',
  inputSchema: {
    type: 'object',
    properties: { squad_id: STRING_SCHEMA, limit: OPTIONAL_NUMBER_SCHEMA },
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const squadRes = await resolveTaskSquad(env, auth, args)
    if (!squadRes.ok) return squadRes
    const limit = readLimit(args.limit, 100, 250)
    if (typeof limit !== 'number') return limit

    const rows = await env.DB.prepare(
      `SELECT id, squad_id, project_id, title, body, done_when, status, assignee_agent_id, github_issue_url, result, completed_at, gate_owner, created_at, updated_at
         FROM tasks
        WHERE squad_id = ?1
        ORDER BY created_at DESC
        LIMIT ?2`,
    )
      .bind(squadRes.squad.id, limit)
      .all<Task>()

    const columns: Record<TaskStatus, Task[]> = {
      open: [],
      in_progress: [],
      blocked: [],
      review: [],
      approved: [],
      rejected: [],
      done: [],
    }
    for (const task of rows.results ?? []) {
      if (columns[task.status]) columns[task.status].push(task)
    }
    const counts = Object.fromEntries(
      TASK_STATUSES.map((status) => [status, columns[status].length]),
    ) as Record<TaskStatus, number>
    return done({ squad_id: squadRes.squad.id, counts, columns })
  },
}

// task_update — mutate a task through the same lifecycle gates as PATCH /api/tasks/:id.
// cap: member+ on the task's squad. approved/rejected still require the verdict
// endpoint; this tool can move work through open/in_progress/blocked/review/done.
const toolTaskUpdate: ToolSpec = {
  name: 'task_update',
  scope: 'squad (of the task)',
  min: 'member',
  args: '{ task_id: string, project_id?: string|null, title?: string, body?: string, done_when?: string, status?: "open"|"in_progress"|"blocked"|"done"|"review", assignee_agent_id?: string|null, gate_owner?: string|null }',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: STRING_SCHEMA,
      project_id: NULLABLE_STRING_SCHEMA,
      title: STRING_SCHEMA,
      body: STRING_SCHEMA,
      done_when: STRING_SCHEMA,
      status: STRING_SCHEMA,
      assignee_agent_id: STRING_SCHEMA,
      gate_owner: STRING_SCHEMA,
    },
    required: ['task_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const taskId = str(args.task_id)
    if (!taskId) return fail(400, 'invalid_args', 'task_id required')
    const existing = await loadTask(env, taskId)
    if (!existing) return fail(404, 'task_not_found')

    const grants = auth.capabilities ?? []
    if (!(await memberCanOnSquad(env, grants, existing.squad_id, 'member'))) {
      return fail(403, 'forbidden', { need: 'member', scope: 'squad' })
    }

    const next: Task = { ...existing }
    let changed = false

    if (args.title !== undefined) {
      if (!str(args.title)) return fail(400, 'invalid_title')
      next.title = (args.title as string).trim()
      changed = true
    }
    if (args.body !== undefined) {
      if (typeof args.body !== 'string') return fail(400, 'invalid_body')
      next.body = args.body
      changed = true
    }
    if (args.done_when !== undefined) {
      if (!isDoneWhenValid(args.done_when)) {
        return fail(400, 'invalid_done_when', 'done_when must be a non-empty verifiable success predicate')
      }
      next.done_when = (args.done_when as string).trim()
      changed = true
    }
    if (args.status !== undefined) {
      if (!isPatchableStatus(args.status)) return fail(400, 'invalid_status')
      const transitionErr = checkTransition(existing.status, args.status)
      if (transitionErr) return fail(400, 'invalid_transition', transitionErr)
      // GATE-EXIT GUARD (mirror of PATCH /api/tasks/:id): entering 'review'
      // requires a gate_owner, else the task is a zombie with no legal exit
      // (verdict 409s no_gate; review→open|in_progress is forbidden). Evaluate the
      // EFFECTIVE gate_owner after applying args.gate_owner — pre-review the gate
      // isn't locked, so it may be set in this same call.
      if (args.status === 'review') {
        const effectiveGateOwner =
          args.gate_owner === undefined
            ? existing.gate_owner
            : typeof args.gate_owner === 'string' && args.gate_owner.trim().length > 0
              ? args.gate_owner.trim()
              : null
        if (!effectiveGateOwner) {
          return fail(409, 'gate_required_for_review', 'a task can only enter review with a gate_owner set')
        }
      }
      if (patchToDoneBypassesGate(existing.status, existing.gate_owner, args.status)) {
        return fail(409, 'gate_open', 'gated task must be approved via verdict before it can be marked done')
      }
      if (args.status === 'done') {
        try {
          assertCompletableDoneWhen(next.done_when)
        } catch (err) {
          return fail(409, 'done_when_placeholder', err instanceof Error ? err.message : 'done_when is not completable')
        }
      }
      next.status = args.status
      changed = true
    }
    if (args.assignee_agent_id !== undefined) {
      const check = await resolveTaskAssignee(env, args.assignee_agent_id, existing.squad_id)
      if (check.error) return fail(400, check.error)
      next.assignee_agent_id = check.value
      changed = true
    }
    if (args.gate_owner !== undefined) {
      const lockStatuses: ReadonlySet<TaskStatus> = new Set(['review', 'approved', 'rejected', 'done'])
      if (lockStatuses.has(existing.status)) return fail(409, 'gate_owner_locked', { status: existing.status })
      if (args.gate_owner === null) {
        next.gate_owner = null
      } else if (typeof args.gate_owner === 'string' && args.gate_owner.trim().length > 0) {
        next.gate_owner = args.gate_owner.trim()
      } else {
        return fail(400, 'invalid_gate_owner')
      }
      changed = true
    }
    if (args.project_id !== undefined) {
      const projectId = args.project_id === null ? null : str(args.project_id)
      if (args.project_id !== null && !projectId) return fail(400, 'invalid_project_id')
      next.project_id = projectId
      changed = true
    }
    if (!changed) return fail(400, 'invalid_args', 'at least one update field is required')

    try {
      await validateTaskProjectAttribution(env, next.project_id, existing.squad_id)
    } catch (error) {
      if (error instanceof TaskProjectError) return taskProjectFailure(error)
      throw error
    }

    stampTaskUpdate(next, existing.status, new Date().toISOString())
    try {
      await persistTaskUpdate(env, existing, next)
    } catch (error) {
      if (error instanceof TaskUpdateConflictError) return fail(409, error.code)
      throw error
    }
    next.github_issue_url = await mirrorTaskUpdate(env, next)

    await emitTaskEvent(env, 'task.updated', next, memberActor(auth.memberId as string))
    return done({ task: next })
  },
}

// task_dispatch — wake the task's persisted assignee in execute mode. The caller
// chooses only the task; the assignee and target squad are data-derived. Assignment
// is revalidated immediately before emit, and runTaskExecution rechecks it again at
// execution time so a queued wake cannot outlive a revoked cross-squad grant.
const toolTaskDispatch: ToolSpec = {
  name: 'task_dispatch',
  scope: 'squad (of the task)',
  min: 'member',
  args: '{ task_id: string }',
  inputSchema: {
    type: 'object',
    properties: { task_id: STRING_SCHEMA },
    required: ['task_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const taskId = str(args.task_id)
    if (!taskId) return fail(400, 'invalid_args', 'task_id required')
    const task = await loadTask(env, taskId)
    if (!task) return fail(404, 'task_not_found')

    const grants = auth.capabilities ?? []
    if (!(await memberCanOnSquad(env, grants, task.squad_id, 'member'))) {
      return fail(404, 'task_not_found')
    }
    if (task.status !== 'open' && task.status !== 'blocked' && task.status !== 'rejected') {
      return fail(409, 'task_not_runnable')
    }
    if (!task.assignee_agent_id) return fail(409, 'task_not_dispatchable')

    const assignee = await resolveTaskAssignee(env, task.assignee_agent_id, task.squad_id)
    if (assignee.error || assignee.value !== task.assignee_agent_id) {
      return fail(409, 'task_not_dispatchable')
    }

    const memberId = auth.memberId as string
    const receiptId = crypto.randomUUID()
    const dispatchedAt = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO task_dispatch_receipts
         (id, tenant, task_id, squad_id, agent_id, actor_kind, actor_id, created_at, attempts)
       VALUES (?, ?, ?, ?, ?, 'member', ?, ?, 1)`,
    ).bind(
      receiptId,
      env.TENANT_SLUG,
      task.id,
      task.squad_id,
      task.assignee_agent_id,
      memberId,
      dispatchedAt,
    ).run()

    const event: BusEvent<{ task_id: string; by: string; dispatch_receipt_id: string }> = {
      type: 'agent.wake',
      tenant: env.TENANT_SLUG,
      squad_id: task.squad_id,
      agent_id: task.assignee_agent_id,
      actor: memberActor(memberId),
      payload: { task_id: task.id, by: memberId, dispatch_receipt_id: receiptId },
      ts: dispatchedAt,
    }
    try {
      await createBus(env).emit(event)
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'dispatch_failed'
      await env.DB.prepare(
        `UPDATE task_dispatch_receipts
            SET last_error = ?
          WHERE tenant = ? AND id = ?`,
      ).bind(message, env.TENANT_SLUG, receiptId).run()
      return fail(500, 'dispatch_failed', { receipt_id: receiptId })
    }

    return done({
      dispatched: true,
      task_id: task.id,
      agent_id: task.assignee_agent_id,
      squad_id: task.squad_id,
      receipt: {
        id: receiptId,
        dispatched_by: memberActor(memberId),
        dispatched_at: dispatchedAt,
      },
    })
  },
}

function parseJsonArg(value: unknown): unknown | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32_768) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

interface FlightCursorEnvelope {
  tenant: string
  member_id: string
  squad_id: string
  project_id: string | null
  created_at: number
  flight_id: string
}

async function resolveFlightCursor(
  env: Env,
  auth: AuthContext,
  squadId: string,
  projectId: string | undefined,
  value: unknown,
): Promise<{ createdAt: number; id: string } | null | undefined> {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) return null
  const digest = await sha256Short(value)
  const cursor = await env.SESSIONS.get<FlightCursorEnvelope>(`flight-list-cursor:${digest}`, 'json')
  const memberId = auth.memberId ?? auth.userId
  if (
    !cursor
    || cursor.tenant !== env.TENANT_SLUG
    || cursor.member_id !== memberId
    || cursor.squad_id !== squadId
    || cursor.project_id !== (projectId ?? null)
  ) {
    return null
  }
  if (!Number.isSafeInteger(cursor.created_at) || cursor.created_at < 0 || !cursor.flight_id) return null
  return { createdAt: cursor.created_at, id: cursor.flight_id }
}

async function issueFlightCursor(
  env: Env,
  auth: AuthContext,
  squadId: string,
  projectId: string | undefined,
  flight: FlightRow,
): Promise<string> {
  const token = crypto.randomUUID()
  const digest = await sha256Short(token)
  const cursor: FlightCursorEnvelope = {
    tenant: env.TENANT_SLUG,
    member_id: auth.memberId ?? auth.userId,
    squad_id: squadId,
    project_id: projectId ?? null,
    created_at: flight.created_at,
    flight_id: flight.id,
  }
  await env.SESSIONS.put(`flight-list-cursor:${digest}`, JSON.stringify(cursor), { expirationTtl: 600 })
  return token
}

function memberCanAccessFlight(
  auth: AuthContext,
  meta: FlightMetaV1,
  squadCache: Map<string, Squad | null>,
  minimum: Capability,
): boolean {
  const grants = auth.capabilities ?? []
  const workspaceAdmin = hasWorkspaceAdmin(auth)
  for (const squadId of meta.squad_ids) {
    const squad = squadCache.get(squadId)
    if (!squad) return false
    if (!workspaceAdmin && !hasCapability(grants, 'squad', squad.id, minimum, squad.department_id)) return false
  }
  return true
}

function flightWithParsedMeta(flight: FlightRow, meta: FlightMetaV1): Omit<FlightRow, 'meta'> & { meta: FlightMetaV1 } {
  return { ...flight, meta }
}

const toolFlightDispatch: ToolSpec = {
  name: 'flight_dispatch',
  scope: 'squad',
  min: 'member',
  args: '{ squad_id: string, project_id?: string|null, goal: string, meta_json: string, signals_json: string, budget_micro_usd?: number }',
  inputSchema: {
    type: 'object',
    properties: {
      squad_id: STRING_SCHEMA,
      project_id: NULLABLE_STRING_SCHEMA,
      goal: STRING_SCHEMA,
      meta_json: STRING_SCHEMA,
      signals_json: STRING_SCHEMA,
      budget_micro_usd: OPTIONAL_NUMBER_SCHEMA,
    },
    required: ['squad_id', 'goal', 'meta_json', 'signals_json'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (!auth.boundAgentId) return fail(409, 'agent_binding_required')
    const boundAgent = await loadAgent(env, auth.boundAgentId)
    if (!boundAgent) return fail(409, 'agent_binding_invalid')
    if (boundAgent.status !== 'active') return fail(409, 'agent_binding_inactive')
    const squadId = str(args.squad_id)
    const goal = str(args.goal)
    if (!squadId || !goal) return fail(400, 'invalid_args')
    const requestedBudget = args.budget_micro_usd == null ? 0 : args.budget_micro_usd
    if (!Number.isSafeInteger(requestedBudget) || (requestedBudget as number) < 0) {
      return fail(400, 'invalid_flight_budget')
    }

    const squad = await loadSquad(env, squadId)
    if (!squad) return fail(403, 'forbidden')
    const grants = auth.capabilities ?? []
    const workspaceAdmin = hasWorkspaceAdmin(auth)

    const meta = parseFlightMetaV1(parseJsonArg(args.meta_json))
    if (!meta || !meta.squad_ids.includes(squad.id)) return fail(400, 'invalid_flight_meta')
    if (!meta.squad_ids.includes(boundAgent.squad_id)) return fail(400, 'agent_squad_not_in_flight')
    const referencedSquads = await loadFlightSquads(env, meta.squad_ids)
    if (referencedSquads.length !== meta.squad_ids.length) return fail(403, 'forbidden')
    const requiredCapability: Capability = (requestedBudget as number) > 0 ? 'lead' : 'member'
    for (const referencedSquad of referencedSquads) {
      if (!workspaceAdmin && !hasCapability(grants, 'squad', referencedSquad.id, requiredCapability, referencedSquad.department_id)) {
        return fail(
          403,
          (requestedBudget as number) > 0 ? 'flight_budget_forbidden' : 'forbidden',
          { need: requiredCapability, scope: 'squad', squad_id: referencedSquad.id },
        )
      }
    }

    const projectId = args.project_id == null ? undefined : str(args.project_id)
    if (args.project_id != null && (!projectId || projectId.length > 200)) {
      return fail(400, 'invalid_project_id')
    }
    try {
      await validateFlightProjectTarget(env, projectId)
    } catch (error) {
      if (error instanceof FlightProjectError) return flightProjectFailure(error)
      throw error
    }
    if (projectId && !workspaceAdmin && !(await hasProjectWriteForSquads(env, projectId, meta.squad_ids))) {
      return fail(403, 'forbidden', { need: 'project_write', scope: 'project squads' })
    }
    try {
      await validateFlightTaskProjectConsistency(env, projectId, meta)
    } catch (error) {
      if (error instanceof FlightProjectError) return flightProjectFailure(error)
      throw error
    }

    let budgetCeilingMicroUsd = 0
    if ((requestedBudget as number) > 0) {
      const caps = [boundAgent.budget_cap_cents, ...referencedSquads.map((item) => item.budget_cap_cents)]
      if (caps.some((cap) => typeof cap !== 'number' || !Number.isSafeInteger(cap) || cap <= 0)) {
        return fail(409, 'flight_budget_policy_missing')
      }
      budgetCeilingMicroUsd = Math.min(...(caps as number[])) * 10_000
      if ((requestedBudget as number) > budgetCeilingMicroUsd) {
        return fail(409, 'flight_budget_exceeds_cap', { cap_micro_usd: budgetCeilingMicroUsd })
      }
    }
    const references = await validateFlightMetaReferences(env, meta, projectId)
    if (!references.ok) {
      const error = references.error === 'flight_task_scope_mismatch'
        ? 'flight_task_not_found'
        : references.error
      return fail(error.endsWith('_not_found') ? 404 : 400, error, references.ref)
    }
    const signals = parseJsonArg(args.signals_json)
    const parsed = parseDispatchBody({
      agent: auth.boundAgentId,
      goal,
      project_id: projectId,
      trigger_source: 'api',
      budget_micro_usd: requestedBudget,
      meta,
      signals,
    })
    if (!parsed.ok) return fail(400, parsed.error)
    parsed.value.signals.budgetEstimateMicroUsd = requestedBudget as number
    parsed.value.signals.budgetRemainingMicroUsd = budgetCeilingMicroUsd

    let preflight
    try {
      preflight = await dispatchFlight(env, parsed.value.flight, parsed.value.signals, parsed.value.opts)
    } catch (error) {
      if (!(error instanceof FlightProjectError)) throw error
      return flightProjectFailure(error)
    }
    const flight = await getFlight(env, preflight.id)
    if (!flight) return fail(500, 'flight_record_missing')
    return done({ flight: flightWithParsedMeta(flight, meta), preflight })
  },
}

const toolFlightGet: ToolSpec = {
  name: 'flight_get',
  scope: 'flight squads',
  min: 'observer',
  args: '{ flight_id: string }',
  inputSchema: {
    type: 'object',
    properties: { flight_id: STRING_SCHEMA },
    required: ['flight_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const flightId = str(args.flight_id)
    if (!flightId) return fail(400, 'invalid_args')
    const flight = await getFlight(env, flightId)
    if (!flight) return fail(404, 'flight_not_found')
    const meta = parseFlightMetaV1(parseJsonArg(flight.meta))
    if (!meta) return fail(404, 'flight_not_found')
    const squads = await loadFlightSquads(env, meta.squad_ids)
    const squadCache = new Map<string, Squad | null>(squads.map((item) => [item.id, item]))
    if (!memberCanAccessFlight(auth, meta, squadCache, 'observer')) return fail(404, 'flight_not_found')
    return done({ flight: flightWithParsedMeta(flight, meta) })
  },
}

const toolFlightLand: ToolSpec = {
  name: 'flight_land',
  scope: 'self (bound agent own flight)',
  min: 'member',
  args: '{ flight_id: string, cost_micro_usd: number, score?: number }',
  inputSchema: {
    type: 'object',
    properties: {
      flight_id: STRING_SCHEMA,
      cost_micro_usd: OPTIONAL_NUMBER_SCHEMA,
      score: OPTIONAL_NUMBER_SCHEMA,
    },
    required: ['flight_id', 'cost_micro_usd'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (!auth.boundAgentId) return fail(409, 'agent_binding_required')
    const boundAgent = await loadAgent(env, auth.boundAgentId)
    if (!boundAgent) return fail(409, 'agent_binding_invalid')
    if (boundAgent.status !== 'active') return fail(409, 'agent_binding_inactive')

    const flightId = str(args.flight_id)
    const costMicroUsd = args.cost_micro_usd
    const score = args.score
    if (!flightId || !Number.isSafeInteger(costMicroUsd) || (costMicroUsd as number) < 0) {
      return fail(400, 'invalid_args')
    }
    if (score !== undefined && (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1)) {
      return fail(400, 'invalid_flight_score')
    }

    const flight = await getFlight(env, flightId)
    if (!flight || flight.agent !== auth.boundAgentId) return fail(404, 'flight_not_found')
    const meta = parseFlightMetaV1(parseJsonArg(flight.meta))
    if (!meta) return fail(404, 'flight_not_found')
    const squads = await loadFlightSquads(env, meta.squad_ids)
    const squadCache = new Map<string, Squad | null>(squads.map((item) => [item.id, item]))
    if (!memberCanAccessFlight(auth, meta, squadCache, 'observer')) return fail(404, 'flight_not_found')
    if (!memberCanAccessFlight(auth, meta, squadCache, 'member')) {
      return fail(403, 'forbidden', { need: 'member', scope: 'flight squads' })
    }
    if (!(['running', 'waiting', 'sleeping'] as const).includes(flight.status as 'running' | 'waiting' | 'sleeping')) {
      return fail(409, 'flight_not_in_air', { status: flight.status })
    }
    if (!Number.isSafeInteger(flight.budget_micro_usd) || (flight.budget_micro_usd as number) < 0) {
      return fail(409, 'flight_budget_policy_missing')
    }
    if ((costMicroUsd as number) > (flight.budget_micro_usd as number)) {
      return fail(409, 'flight_budget_exceeded', { budget_micro_usd: flight.budget_micro_usd })
    }

    const transitioned = await landGovernedFlight(env, flight.id, {
      cost_micro_usd: costMicroUsd as number,
      score: score as number | undefined,
      expected_agent: auth.boundAgentId,
      agent_id: flight.agent,
      meta,
      actor: { kind: 'agent', id: auth.boundAgentId },
    })
    if (!transitioned) {
      const projectMismatchTaskIds = await listFlightProjectMismatchTaskIds(env, flight.project_id, meta.task_ids)
      if (projectMismatchTaskIds.length > 0) {
        return fail(409, 'flight_task_project_conflict', { task_ids: projectMismatchTaskIds })
      }
      const incompleteTaskIds = await listIncompleteFlightTaskIds(env, meta.task_ids)
      if (incompleteTaskIds.length > 0) {
        return fail(409, 'flight_tasks_incomplete', { task_ids: incompleteTaskIds })
      }
      return fail(409, 'flight_transition_conflict')
    }
    const landed = await getFlight(env, flight.id)
    if (!landed || landed.status !== 'landed') return fail(500, 'flight_record_missing')
    await deliverFlightLandedEvent(env, landed.id)
    return done({ flight: flightWithParsedMeta(landed, meta) })
  },
}

const toolFlightList: ToolSpec = {
  name: 'flight_list',
  scope: 'squad',
  min: 'observer',
  args: '{ squad_id: string, project_id?: string|null, limit?: number, cursor?: string }',
  inputSchema: {
    type: 'object',
    properties: { squad_id: STRING_SCHEMA, project_id: NULLABLE_STRING_SCHEMA, limit: OPTIONAL_NUMBER_SCHEMA, cursor: STRING_SCHEMA },
    required: ['squad_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const squadId = str(args.squad_id)
    if (!squadId) return fail(400, 'invalid_args')
    const squad = await loadSquad(env, squadId)
    if (!squad) return fail(403, 'forbidden')
    const grants = auth.capabilities ?? []
    const workspaceAdmin = hasWorkspaceAdmin(auth)
    if (!workspaceAdmin && !(await memberCanOnSquad(env, grants, squad.id, 'observer'))) {
      return fail(403, 'forbidden', { need: 'observer', scope: 'squad' })
    }
    const parsedProjectId = args.project_id == null ? undefined : str(args.project_id)
    if (args.project_id != null && !parsedProjectId) return fail(400, 'invalid_project_id')
    const projectId = parsedProjectId ?? undefined
    if (projectId && !(await canReadProjectForSquad(env, auth, projectId, squad.id))) {
      return fail(404, 'project_not_found')
    }
    const limit = readLimit(args.limit, 100, 500)
    if (typeof limit !== 'number') return limit
    let before = await resolveFlightCursor(env, auth, squad.id, projectId, args.cursor)
    if (before === null) return fail(400, 'invalid_flight_cursor')

    const visible: Array<Omit<FlightRow, 'meta'> & { meta: FlightMetaV1 }> = []
    const squadCache = new Map<string, Squad | null>([[squad.id, squad]])
    const pageSize = 50
    let pages = 0
    let lastScanned: FlightRow | null = null
    let hasMore = false

    scan: while (visible.length < limit && pages < 10) {
      const page = await listFlightsForSquad(env, squad.id, pageSize, before, projectId)
      pages += 1
      if (page.length === 0) break
      const candidates = page.map((flight) => ({ flight, meta: parseFlightMetaV1(parseJsonArg(flight.meta)) }))
      const missingSquadIds = new Set<string>()
      for (const candidate of candidates) {
        for (const candidateSquadId of candidate.meta?.squad_ids ?? []) {
          if (!squadCache.has(candidateSquadId)) missingSquadIds.add(candidateSquadId)
        }
      }
      const loadedSquads = await loadFlightSquads(env, [...missingSquadIds])
      for (const loadedSquad of loadedSquads) squadCache.set(loadedSquad.id, loadedSquad)
      for (const missingSquadId of missingSquadIds) {
        if (!squadCache.has(missingSquadId)) squadCache.set(missingSquadId, null)
      }
      for (let index = 0; index < page.length; index += 1) {
        const flight = page[index]
        lastScanned = flight
        const meta = candidates[index].meta
        if (meta?.squad_ids.includes(squad.id) && memberCanAccessFlight(auth, meta, squadCache, 'observer')) {
          visible.push(flightWithParsedMeta(flight, meta))
        }
        if (visible.length >= limit) {
          hasMore = index < page.length - 1 || page.length === pageSize
          break scan
        }
      }
      if (page.length < pageSize) break
      before = { createdAt: page[page.length - 1].created_at, id: page[page.length - 1].id }
      if (pages === 10) hasMore = true
    }
    return done({
      squad_id: squad.id,
      flights: visible,
      cursor: hasMore && lastScanned ? await issueFlightCursor(env, auth, squad.id, projectId, lastScanned) : null,
      has_more: hasMore,
    })
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

    const concepts = readConcepts(args.concepts)
    if (concepts && !Array.isArray(concepts)) return concepts

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

// squad_remember — write to the squad's shared memory scope. cap: member+ on squad.
// Agent-bound tokens may omit squad_id and default to their own squad.
const toolSquadRemember: ToolSpec = {
  name: 'squad_remember',
  scope: 'squad memory',
  min: 'member',
  args: '{ squad_id?: string, text: string, concepts?: string[] }',
  inputSchema: {
    type: 'object',
    properties: { squad_id: STRING_SCHEMA, text: STRING_SCHEMA, concepts: OPTIONAL_STRING_ARRAY_SCHEMA },
    required: ['text'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const text = str(args.text)
    if (!text) return fail(400, 'invalid_args', 'text required')

    const concepts = readConcepts(args.concepts)
    if (concepts && !Array.isArray(concepts)) return concepts

    const squadRes = await resolveScopedSquad(
      env,
      auth,
      args,
      'member',
      'squad_id required unless the token is agent-bound',
    )
    if (!squadRes.ok) return squadRes

    const scope = squadMemoryScope(squadRes.squad.id)
    const id = await createMemory(env).remember(scope, text, concepts)
    return done({ engram_id: id, squad_id: squadRes.squad.id, scope })
  },
}

// squad_recall — read the squad's shared memory scope. cap: observer+ on squad.
// This is intentionally separate from recall so private per-token memory remains private.
const toolSquadRecall: ToolSpec = {
  name: 'squad_recall',
  scope: 'squad memory',
  min: 'observer',
  args: '{ squad_id?: string, query: string, limit?: number }',
  inputSchema: {
    type: 'object',
    properties: { squad_id: STRING_SCHEMA, query: STRING_SCHEMA, limit: OPTIONAL_NUMBER_SCHEMA },
    required: ['query'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const query = str(args.query)
    if (!query) return fail(400, 'invalid_args', 'query required')
    const limit = readLimit(args.limit, 5, 20)
    if (typeof limit !== 'number') return limit

    const squadRes = await resolveScopedSquad(
      env,
      auth,
      args,
      'observer',
      'squad_id required unless the token is agent-bound',
    )
    if (!squadRes.ok) return squadRes

    const scope = squadMemoryScope(squadRes.squad.id)
    const hits = await createMemory(env).recall(scope, query, limit)
    return done({ squad_id: squadRes.squad.id, scope, hits })
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
      body: JSON.stringify({ agent_id: agent.id, reason, squad_id: agent.squad_id, context, maxActions }),
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

// send — leave a durable message in another agent's inbox (squad → mupot migration, S3).
// The sender MUST be an agent-bound token (auth.boundAgentId = the weld) so every message is
// accountable to a real agent; humans use im/squad_message. Recipient resolved via the canonical
// resolveAgentRef (id-first, slug ambiguity refused). Tenant-scoped: cannot address another pot.
const toolSend: ToolSpec = {
  name: 'send',
  scope: 'agent→agent (this pot); sender must be agent-bound',
  min: 'authenticated',
  args: '{ to: string (agent id or unique slug), body: string, kind?: "message"|"request"|"ack", request_id?: string, in_reply_to?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      to: STRING_SCHEMA,
      body: STRING_SCHEMA,
      kind: STRING_SCHEMA,
      request_id: STRING_SCHEMA,
      in_reply_to: STRING_SCHEMA,
    },
    required: ['to', 'body'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const fromAgent = auth.boundAgentId
    if (!fromAgent) return fail(403, 'not_agent_bound', 'send requires an agent-bound token (member_tokens.agent_id)')
    const to = str(args.to)
    const body = str(args.body)
    if (!to) return fail(400, 'invalid_args', 'to required')
    if (!body) return fail(400, 'invalid_args', 'body required')
    if (args.kind !== undefined && typeof args.kind !== 'string')
      return fail(400, 'invalid_args', 'kind must be a string')
    if (args.request_id !== undefined && typeof args.request_id !== 'string')
      return fail(400, 'invalid_args', 'request_id must be a string')
    if (args.in_reply_to !== undefined && typeof args.in_reply_to !== 'string')
      return fail(400, 'invalid_args', 'in_reply_to must be a string')

    const res = await sendToRef(env, {
      fromAgent,
      fromMember: auth.memberId as string,
      toRef: to,
      body,
      kind: args.kind as 'message' | 'request' | 'ack' | undefined,
      requestId: typeof args.request_id === 'string' ? args.request_id : undefined,
      inReplyTo: typeof args.in_reply_to === 'string' ? args.in_reply_to : undefined,
    })
    if (!res.ok) {
      if (res.reason === 'db_error') return fail(500, res.reason) // no raw DB string to caller
      const status =
        res.reason === 'recipient_not_found'
          ? 404
          : res.reason === 'recipient_ambiguous' ||
              res.reason === 'request_id_conflict' ||
              res.reason === 'inbox_full'
            ? 409
            : 400
      return fail(status, res.reason, res.detail)
    }
    return done({ id: res.id, seq: res.seq, duplicate: res.duplicate, to: res.toAgent })
  },
}

type BroadcastTarget = Pick<Agent, 'id' | 'slug' | 'name'>

// broadcast — fan out a durable message to every active agent in one squad. This
// is still a set of ordinary agent_messages rows, so inbox delivery, unread caps,
// and replay semantics remain identical to direct send.
const toolBroadcast: ToolSpec = {
  name: 'broadcast',
  scope: 'squad fan-out (active agents only); sender must be agent-bound',
  min: 'member',
  args: '{ squad_id?: string, body: string, kind?: "message"|"request", request_id?: string, include_self?: boolean, limit?: number }',
  inputSchema: {
    type: 'object',
    properties: {
      squad_id: STRING_SCHEMA,
      body: STRING_SCHEMA,
      kind: STRING_SCHEMA,
      request_id: STRING_SCHEMA,
      include_self: { type: 'boolean' },
      limit: OPTIONAL_NUMBER_SCHEMA,
    },
    required: ['body'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const fromAgent = auth.boundAgentId
    if (!fromAgent) return fail(403, 'not_agent_bound', 'broadcast requires an agent-bound token (member_tokens.agent_id)')

    const body = str(args.body)
    if (!body) return fail(400, 'invalid_args', 'body required')
    const kind = args.kind ?? 'message'
    if (kind !== 'message' && kind !== 'request') {
      return fail(400, 'invalid_args', 'kind must be "message" or "request"')
    }
    if (args.request_id !== undefined && typeof args.request_id !== 'string') {
      return fail(400, 'invalid_args', 'request_id must be a string')
    }
    const requestId = typeof args.request_id === 'string' ? args.request_id : undefined
    if (requestId !== undefined && !BROADCAST_REQUEST_ID_RE.test(requestId)) {
      return fail(400, 'invalid_request_id', 'request_id must match [A-Za-z0-9_.:-]{1,128}')
    }
    if (args.include_self !== undefined && typeof args.include_self !== 'boolean') {
      return fail(400, 'invalid_args', 'include_self must be a boolean')
    }
    const includeSelf = args.include_self === true
    const limit = readLimit(args.limit, 100, 200)
    if (typeof limit !== 'number') return limit

    const squadRes = await resolveScopedSquad(
      env,
      auth,
      args,
      'member',
      'squad_id required unless the token is agent-bound',
    )
    if (!squadRes.ok) return squadRes

    const rows = await env.DB.prepare(
      `SELECT id, slug, name
         FROM agents
        WHERE squad_id = ?1 AND status = 'active'
        ORDER BY slug ASC
        LIMIT ?2`,
    )
      .bind(squadRes.squad.id, limit)
      .all<BroadcastTarget>()
    const targets = (rows.results ?? []).filter((agent) => includeSelf || agent.id !== fromAgent)

    const deliveries: Array<{ to: string; slug: string; id: string; seq: number; duplicate: boolean; request_id: string | null }> = []
    const failures: Array<{ to: string; slug: string; error: string; detail?: string }> = []
    for (const target of targets) {
      const recipientRequestId = requestId ? await broadcastRecipientRequestId(requestId, target.id) : undefined
      const res = await sendAgentMessage(env, {
        fromAgent,
        fromMember: auth.memberId as string,
        toAgent: target.id,
        body,
        kind,
        requestId: recipientRequestId,
      })
      if (res.ok) {
        deliveries.push({
          to: target.id,
          slug: target.slug,
          id: res.id,
          seq: res.seq,
          duplicate: res.duplicate,
          request_id: recipientRequestId ?? null,
        })
      } else {
        failures.push({ to: target.id, slug: target.slug, error: res.reason, detail: res.detail })
      }
    }

    return done({
      ok: failures.length === 0,
      squad_id: squadRes.squad.id,
      from: fromAgent,
      attempted: targets.length,
      delivered: deliveries.length,
      failed: failures.length,
      deliveries,
      failures,
    })
  },
}

// inbox — read (and by default CONSUME) the CALLER's own inbox. cap: agent-bound member.
// Self-scoped: an agent only ever reads to_agent = its own welded id; it cannot read another
// agent's inbox. peek=true reads without consuming.
const toolInbox: ToolSpec = {
  name: 'inbox',
  scope: 'self (the caller agent reads its own inbox)',
  min: 'authenticated',
  args: '{ limit?: number, peek?: boolean }',
  inputSchema: {
    type: 'object',
    properties: { limit: OPTIONAL_NUMBER_SCHEMA, peek: { type: 'boolean' } },
    required: [],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const agent = auth.boundAgentId
    if (!agent) return fail(403, 'not_agent_bound', 'inbox requires an agent-bound token (member_tokens.agent_id)')
    let limit: number | undefined
    if (args.limit !== undefined) {
      if (typeof args.limit !== 'number' || !Number.isFinite(args.limit))
        return fail(400, 'invalid_args', 'limit must be a number')
      limit = args.limit
    }
    if (args.peek !== undefined && typeof args.peek !== 'boolean')
      return fail(400, 'invalid_args', 'peek must be a boolean')

    const res = await readAgentInbox(env, { agent, limit, peek: args.peek === true })
    if (!res.ok) {
      if (res.reason === 'db_error') return fail(500, res.reason) // no raw DB string to caller
      return fail(400, res.reason, res.detail)
    }
    return done({ messages: res.messages, remaining: res.remaining, consumed: args.peek !== true })
  },
}

type PeerRow = Agent & {
  presence_source: string | null
  presence_label: string | null
  presence_last_seen_at: string | null
}

// peers — read the caller's squad roster for coordination. This is not a global
// directory: agent-bound tokens default to their own squad, and explicit squad
// reads require observer+ on that squad.
const toolPeers: ToolSpec = {
  name: 'peers',
  scope: 'squad roster (read-only)',
  min: 'authenticated',
  args: '{ squad_id?: string, limit?: number }',
  inputSchema: {
    type: 'object',
    properties: { squad_id: STRING_SCHEMA, limit: OPTIONAL_NUMBER_SCHEMA },
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const squadRes = await resolveScopedSquad(
      env,
      auth,
      args,
      'observer',
      'squad_id required unless the token is agent-bound',
    )
    if (!squadRes.ok) return squadRes
    const limit = readLimit(args.limit, 50, 200)
    if (typeof limit !== 'number') return limit

    const rows = await env.DB.prepare(
      `SELECT a.id, a.squad_id, a.slug, a.name, a.role, a.model, a.status, a.created_at,
              (SELECT p.source FROM presence p
                WHERE p.tenant = ?2 AND p.agent_id = a.id
                ORDER BY p.last_seen_at DESC LIMIT 1) AS presence_source,
              (SELECT p.label FROM presence p
                WHERE p.tenant = ?2 AND p.agent_id = a.id
                ORDER BY p.last_seen_at DESC LIMIT 1) AS presence_label,
              (SELECT p.last_seen_at FROM presence p
                WHERE p.tenant = ?2 AND p.agent_id = a.id
                ORDER BY p.last_seen_at DESC LIMIT 1) AS presence_last_seen_at
         FROM agents a
        WHERE a.squad_id = ?1
        ORDER BY a.slug ASC
        LIMIT ?3`,
    )
      .bind(squadRes.squad.id, env.TENANT_SLUG, limit)
      .all<PeerRow>()

    const nowMs = Date.now()
    const peers = (rows.results ?? []).map((row) => {
      const lastSeenMs = sqliteUtcToMs(row.presence_last_seen_at)
      return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        role: row.role,
        model: row.model,
        status: row.status,
        squad_id: row.squad_id,
        is_self: auth.boundAgentId === row.id,
        presence: {
          source: row.presence_source ?? null,
          label: row.presence_label ?? '',
          last_seen_at: row.presence_last_seen_at ?? null,
          liveness: classify(lastSeenMs, nowMs),
          last_seen_human: humanAge(lastSeenMs, nowMs),
        },
      }
    })

    return done({
      squad: {
        id: squadRes.squad.id,
        slug: squadRes.squad.slug,
        name: squadRes.squad.name,
      },
      self_agent_id: auth.boundAgentId ?? null,
      peers,
    })
  },
}

// check_in — pot-native presence heartbeat over MCP. This mirrors
// POST /api/fleet/checkin for runtimes that only have an MCP transport: identity
// is the authenticated member token, source/label are descriptive only, and a
// rapid repeat is debounced with the same tenant+member KV key as the HTTP route.
const toolCheckIn: ToolSpec = {
  name: 'check_in',
  scope: 'self (member-token presence)',
  min: 'authenticated',
  args: '{ source?: "claude-code"|"codex"|"hermes"|"openclaw"|"tmux"|"cowork"|"unknown", label?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      source: STRING_SCHEMA,
      label: STRING_SCHEMA,
    },
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (args.source !== undefined && args.source !== null && typeof args.source !== 'string') {
      return fail(400, 'invalid_args', 'source must be a string')
    }
    if (args.label !== undefined && args.label !== null && typeof args.label !== 'string') {
      return fail(400, 'invalid_args', 'label must be a string')
    }

    const id = await loadMemberIdentity(env, auth)
    if (!id) return fail(403, 'not_member_bound', 'check_in requires a member-token principal')

    const dkey = `checkin:${env.TENANT_SLUG}:${id.memberId}`
    try {
      if (await env.SESSIONS.get(dkey)) {
        return done({ ok: true, agent: id.displayName, agent_id: id.boundAgentId, debounced: true })
      }
      await env.SESSIONS.put(dkey, '1', { expirationTtl: 30 })
    } catch {
      // KV unavailable — match /api/fleet/checkin and prefer recording presence.
    }

    await recordCheckin(env, id, {
      source: args.source,
      label: args.label,
    })
    return done({ ok: true, agent: id.displayName, agent_id: id.boundAgentId, debounced: false })
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

    // A cross-agent lookup is NOT a self-op — gate it. `min: 'authenticated'` keeps
    // the self-echo branch above open, but reading another agent's row + Durable
    // Object runtime requires observer+ on THAT agent's squad (org/dept grants
    // inherit). Without this an authenticated zero-grant member could enumerate and
    // probe every agent's runtime. (Floor exempts 'authenticated' tools, so the
    // gate must live here — #183 adversarial review, P1.)
    const grants = auth.capabilities ?? []
    if (!(await memberCanOnSquad(env, grants, agent.squad_id, 'observer'))) {
      return fail(403, 'forbidden', { need: 'observer', scope: 'squad' })
    }

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

// boot_context — first-call coherence signal for any connecting principal.
//
// Problem (#126): boot_context must tell a first-run agent whether it has a claimed
// identity seat (qNFT / mint_agent_token binding) so onboarding UX is coherent — an
// unminted agent knows it must complete the mint ceremony; a minted agent can proceed.
//
// The signal is derived ENTIRELY from the server-side token record (the weld in
// migration 0019_agent_token_binding.sql). member_tokens.agent_id is:
//   - NULL  → human/operator principal   → identity_status: "unminted"
//   - set   → agent-scoped token (minted) → identity_status: "minted"
//
// boot_context is deliberately LIGHTWEIGHT: it answers "who am I and am I minted?"
// without the deep D1 fan-out of orient. An unminted agent calls boot_context first,
// gets identity_status:"unminted" + next_step, completes mint, then calls orient.
// A minted agent calls boot_context for a fast coherence check, then proceeds with work.
//
// ADDITIVE: all existing fields remain unchanged; identity_status is a NEW field on
// the response. No breaking changes to callers who ignore unknown fields.
const toolBootContext: ToolSpec = {
  name: 'boot_context',
  scope: 'self (read-only — no args required)',
  min: 'authenticated',
  args: '{}  // no args — identity is derived entirely from the bearer token',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async run(auth, env, _args, ctx) {
    // identity_status: derived from whether this token has an agent-identity binding.
    // The weld (migration 0019) sets member_tokens.agent_id when mint_agent_token runs.
    // auth.boundAgentId mirrors that field — it is resolved server-side from the token,
    // never from client input.
    const isMinted = auth.boundAgentId !== null
    const identityStatus: 'minted' | 'unminted' = isMinted ? 'minted' : 'unminted'

    // QA-1: every refusal/unminted signal must carry the full map out — no dead ends.
    // Two paths for an unbound token:
    //   A) Shared apikey + know your name → call connect { agent_name } (session-local, works now).
    //   B) Want a permanent weld → ask an admin to call mint_agent_token, then reconnect.
    const nextStep = isMinted
      ? 'call orient (no args — your token is agent-bound) to receive your full basin-drop packet'
      : 'if you know your agent slug/id: call connect { agent_name: "<slug>" } to claim your identity now (session-local). For a permanent weld: ask an org-admin to call mint_agent_token for your agent, then reconnect with the minted token.'

    return done({
      // principal fields (mirrors the status tool's self-echo, kept stable)
      tenant: auth.tenant,
      member_id: auth.memberId,
      channel: auth.channel,
      capabilities: auth.capabilities ?? [],
      mcp_endpoint: mcpEndpoint(canonicalOrigin(env, ctx.origin)),
      // identity coherence (#126) — NEW field
      identity_status: identityStatus,
      bound_agent_id: auth.boundAgentId ?? null,
      next_step: nextStep,
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
    if (!ref) {
      // QA-1: dead-end refusal must carry the map out. An unbound token that calls orient
      // without naming an agent is stuck — give the two paths that resolve it.
      return fail(400, 'invalid_args', [
        'agent required: your token is not agent-bound.',
        'If you are a named agent connecting with a shared apikey, call connect { agent_name } first to claim your identity.',
        'If you are a human or operator, pass { agent: "<id-or-slug>" } explicitly.',
      ].join(' '))
    }

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

// connect — self-name-to-bind (#128). The cold→hot path for an authorized-but-unbound
// connection (shared apikey, channel=workspace, boundAgentId=null) that knows its own
// agent identity.
//
// Problem: agents boot with a shared apikey. They are AUTHORIZED (member + capabilities
// on their squad) but UNBOUND (member_tokens.agent_id is null — no weld). They cannot
// call orient without naming their agent explicitly, and every act-tool that requires a
// bound-agent context is a dead end. connect bridges this gap: the connection DECLARES
// its agent name → mupot resolves + verifies it → returns the orient packet → HOT.
//
// Security invariants (River's hard-RED respected):
//   - We NEVER fabricate or auto-create an agent identity. The agent must already exist
//     (created by an admin via create_agent or the dashboard).
//   - The caller must have squad-member capability on the named agent's squad. A shared
//     apikey without squad access cannot claim any agent in this pot.
//   - The binding is SESSION-LOCAL: connect does NOT write to member_tokens.agent_id.
//     Permanent binding requires an admin to call mint_agent_token and the agent to
//     reconnect with the minted token. connect is the "work now" path; mint is the
//     "promoted identity" path.
//   - agent_name is a CLAIM, not a privilege: it only NAMES a target; the capability
//     check authorizes it. We never read an identity from args and trust it directly.
//
// QA-3 (security): tool descriptions and args strings must NEVER use real tenant slugs
// as examples. Use fictional slugs only (e.g. "acme", "example-co"). This tool sets the
// pattern: the description and inputSchema use only fictional examples.
const toolConnect: ToolSpec = {
  name: 'connect',
  scope: 'self (session-local agent identity claim — no args beyond agent_name)',
  min: 'authenticated',
  // QA-3 guard: fictional slugs only in the args documentation. Real tenant slugs must
  // never appear here — this string is the public tool description served to connectors.
  args: '{ agent_name: string }  // the agent slug or id you are connecting as (e.g. "growth-lead", "researcher"); must already exist in this pot',
  inputSchema: {
    type: 'object',
    properties: {
      agent_name: {
        type: 'string',
        description: 'The slug or id of the agent you are connecting as. Must already exist in this pot. Examples: "growth-lead", "researcher" (fictional — use your actual agent slug).',
      },
    },
    required: ['agent_name'],
    additionalProperties: false,
  },
  async run(auth, env, args, ctx) {
    const agentName = str(args.agent_name)
    if (!agentName) return fail(400, 'invalid_args', 'agent_name required — provide your agent slug or id')

    // Resolve the named agent. id-first, slug-with-ambiguity-refusal (same as orient).
    // The name is a CLAIM only; the capability check below authorizes it.
    const resolved = await resolveAgentRef(env, agentName)
    if (!resolved.ok) {
      return resolved.reason === 'ambiguous'
        ? fail(409, 'ambiguous_slug', [
            'agent_name matches multiple agents — use the agent id instead of the slug.',
            'Call status {} to see your member_id, then ask an admin for your agent id.',
          ].join(' '))
        : fail(404, 'agent_not_found', [
            `No agent named "${agentName}" exists in this pot.`,
            'Ask an org-admin to call create_agent with your name, or verify the slug/id is correct.',
          ].join(' '))
    }
    const agentRef = resolved.value

    // Authorization: caller must have squad-member capability on this agent's squad.
    // An org-admin also passes (inherits down via memberCanOnSquad). This prevents an
    // authorized-but-unscoped token from claiming an agent on a squad it has no access to.
    const grants = auth.capabilities ?? []
    const orgAdmin = hasCapability(grants, 'org', null, 'admin')
    const onSquad = await memberCanOnSquad(env, grants, agentRef.squad_id, 'member')
    if (!orgAdmin && !onSquad) {
      return fail(403, 'forbidden', {
        reason: 'no_squad_access',
        detail: [
          `Your token does not have member-or-higher capability on the squad for agent "${agentRef.slug}".`,
          'Ask an org-admin to grant you squad membership, or verify you are using the right token.',
        ].join(' '),
        need: 'member',
        scope: 'squad',
      })
    }

    // viewSensitive (#88 parity): same rule as orient — orgAdmin || isSelf || squad-lead.
    // A bare squad-member calling connect on a PEER (not their own agent) must get the
    // redacted packet just as orient would return. isSelf covers the expected hot-path:
    //   - unbound token (boundAgentId=null) claiming its own agent → isSelf=false, BUT
    //     they have 'member' capability on the squad, and an actual self-claim is the whole
    //     point; however that alone does not justify viewSensitive.
    //   - a permanently-welded token reconnecting as itself → isSelf=true → full packet.
    //   - a bare member claiming a PEER (or a different agent on their squad) → isSelf=false
    //     + not lead + not admin → viewSensitive=false → redacted.
    // The self-connect (cold→hot) case for an unbound member ends up viewSensitive=false
    // unless they are also lead/admin. This is the correct least-privilege posture: the
    // member sees a redacted packet until they are formally welded (mint_agent_token),
    // at which point isSelf=true on all subsequent orient/connect calls. (#128)
    const isSelf = auth.boundAgentId === agentRef.id
    const viewSensitive =
      orgAdmin || isSelf || (await memberCanOnSquad(env, grants, agentRef.squad_id, 'lead'))

    // Resolve the full orient packet for the claimed agent (read-only, no D1 write).
    const { data, notFound } = await buildOrient(
      env,
      agentRef.id,
      orgAdmin ? 'admin' : 'observer+',
      mcpEndpoint(canonicalOrigin(env, ctx.origin)),
      viewSensitive,
      Date.now(),
    )
    if (notFound || !data) return fail(404, 'agent_not_found', 'Agent was found but orient data is unavailable.')

    return done({
      connection_status: 'hot',
      claimed_agent: { id: agentRef.id, slug: agentRef.slug, name: agentRef.name },
      // SESSION-LOCAL binding note: this does not write member_tokens.agent_id.
      // To promote to a permanent weld (so reconnects are automatic), ask an admin
      // to call mint_agent_token { agent: "<id>" } and use the issued token going forward.
      binding: 'session_local',
      next_step: 'You are now hot. Call orient {} (or rely on this packet) for your full basin-drop. For a permanent identity weld ask an admin to call mint_agent_token.',
      packet: data,
      brief: renderBrief(data),
    })
  },
}

// Exported for the capability-floor test (#183) — the registry-completeness
// assertion + the dispatch wiring proof read these directly.
export const TOOLS: ToolSpec[] = [
  toolFlightDispatch,
  toolFlightGet,
  toolFlightList,
  toolFlightLand,
  toolTaskCreate,
  toolTaskList,
  toolTaskBoard,
  toolTaskUpdate,
  toolTaskDispatch,
  toolRemember,
  toolRecall,
  toolSquadRemember,
  toolSquadRecall,
  toolWakeAgent,
  toolSquadMessage,
  toolSend,
  toolBroadcast,
  toolInbox,
  toolPeers,
  toolCheckIn,
  toolStatus,
  toolBootContext,
  toolOrient,
  toolConnect,
  ...PROJECT_TOOLS,
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

export async function invokeTool(
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

  // AAGATE (#183) — deny-by-default capability FLOOR. `spec.min` is enforced HERE,
  // centrally, BEFORE the handler runs. A tool that declares a capability minimum
  // can no longer fail-open if its handler omits the inline scope check: a caller
  // holding `min` on NO scope is rejected at the chokepoint. The handler still runs
  // its precise per-scope check (the floor is scope-agnostic — see capability.ts).
  if (spec.min !== 'authenticated' && !hasWorkspaceAdmin(auth) && !holdsCapabilityFloor(auth, spec.min)) {
    return { ...fail(403, 'forbidden', { need: spec.min }), tool: spec.name }
  }

  // A handler that THROWS (rather than returning fail()) must not escape as an
  // opaque 500 / unhandled rejection — convert it to a structured outcome so the
  // MCP client always gets a JSON-RPC error. `receipt_failed` (#186 write-receipt
  // guard) is the expected case; surface its code + safe message. For anything else
  // return a generic internal_error — never echo an arbitrary throw (leak guard).
  let outcome: ToolOutcome
  try {
    outcome = await spec.run(auth, env, args, { origin })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.startsWith('receipt_failed')) {
      return { ...fail(500, 'receipt_failed', msg), tool: spec.name }
    }
    return { ...fail(500, 'internal_error'), tool: spec.name }
  }
  return { ...outcome, tool: spec.name }
}

async function handleJsonRpc(c: import('hono').Context<AppEnv>, body: JsonRpcRequest): Promise<Response> {
  const id = body.id ?? null
  const method = typeof body.method === 'string' ? body.method : ''

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: `mupot-${c.env.TENANT_SLUG}`, version: MUPOT_PUBLIC_API_VERSION },
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
      version: MUPOT_PUBLIC_API_VERSION,
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
