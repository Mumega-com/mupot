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
import { resolveCapabilities, hasCapability, holdsCapabilityFloor, canOnSquad, hasSurfaceCap, callerHoldsActionCapability, clampChannelCapabilities } from '../auth/capability'
import { TOKEN_LIVE_PREDICATE, nowSqlUtc, touchTokenLastUsed } from '../auth/token-lifecycle'
import { callerHoldsGateCapability, verdictPrincipal } from '../tasks/index'
import { resolveSoleGateOwnerAgent } from '../gates/grants'
import { isChannel } from '../members/service'
import { resolveConsentedAgentCapabilities } from './oauth-authorize'
import { createBus } from '../bus'
import { createMemory } from '../memory'
import {
  assertCompletableDoneWhen,
  assigneeCannotMutateOwnAssignment,
  assigneeSelfClose,
  checkTransition,
  createTask,
  emitTaskEvent,
  isDoneWhenValid,
  isValidGateOwnerForm,
  mirrorTaskUpdate,
  patchToDoneBypassesGate,
  persistTaskUpdate,
  stampTaskUpdate,
  TaskProjectError,
  TaskUpdateConflictError,
  TaskIntakeContractError,
  assertValidIntakeContract,
  evaluateTaskIntakeContract,
  isTaskStatus,
  ALL_TASK_STATUSES,
  validateTaskProjectAttribution,
  writeVerdict,
  VerdictRaceError,
  TaskEvidenceFenceError,
  TaskSelfGateError,
} from '../tasks/service'
import { loadKanbanData } from '../dashboard/kanban-routes'
import type { TaskStatus } from '../tasks/service'
import { isTaskPriority, TASK_PRIORITIES } from '../types'
import type { TaskPriority } from '../types'
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
  priorityOrderSql,
  TASK_SELECT_COLUMNS,
} from '../tasks/ranking'
import { loadAgentRuntimeStates, type AgentRuntimeState } from '../dashboard/observatory'
import { buildOrient, renderBrief } from '../orient/service'
import { mcpEndpoint, canonicalOrigin, requiredCanonicalOrigin } from '../dashboard/connect'
import { classify, humanAge } from '../dashboard/fleet'
import { resolveAgentRef } from '../org/resolve'
import {
  sendToRef, readAgentInbox, sendAgentMessage,
} from '../agents/messages'
import { routeAgentWake } from '../agents/wake-routing'
import { verifyTaskArtifactShape } from '../tasks/artifact-verification'
import {
  leaseAgentInbox, ackAgentMessages, listDeadLetteredMessages, summarizeDeadLetters,
  MAX_DELIVERY_ATTEMPTS, DEFAULT_LEASE_SECONDS, MAX_LEASE_SECONDS,
} from '../agents/messages'
import {
  recordCheckin,
  touchPresence,
  sqliteUtcToMs,
  normalizeSevenAxis,
  SEVEN_AXIS_HARNESSES,
  SEVEN_AXIS_EFFORTS,
} from '../fleet/presence'
import {
  readFleetAgentRow,
  getFleetAgentLiveness,
  derivePresence,
  presenceTtlSec,
} from '../fleet/registry'
import { agentKeyFingerprint, loadActiveAgentKey } from '../fleet/agent-keys'
import { consumeDeliveryTurnFence } from '../flight-spine/delivery-turn-fencing'
import { PROVISION_TOOLS } from './provision'
import { BOOTSTRAP_TOOLS } from './bootstrap'
import { CREDENTIAL_CLAIM_TOOLS } from './credential-claim'
import { AGENT_CONNECTION_TOOLS } from './agent-connection'
import { PROJECT_TOOLS, readAccess, readableProject } from './projects'
import { hasProjectWriteForSquads, anySquadHasProjectWrite } from '../projects/access'
import { ADDON_TOOLS } from './addons'
import { GATE_GRANT_TOOLS } from './gates'
import { LOOP_TOOLS } from './loops'
import { SECRET_ENV_TOOLS } from './secret-env'
import { PRESENCE_TOOLS } from './presence'
import { WORKFLOW_CIRCUIT_TOOLS } from './workflow-circuits'
import { ROUTINE_TOOLS } from './routines'
import { RUNNER_TOOLS } from './runners'
import { FLIGHT_SPINE_TOOLS } from './flight-spine'
import { CURSOR_TOOLS } from './cursor'
import { ATHENA_TOOLS } from './athena'
import { POT_TOOLS } from './pots'
import {
  toolSupabaseConnect,
  toolSupabaseSchema,
  toolSupabaseQuery,
  toolSupabaseMutate,
} from './supabase-tools'
import { toolMintBody } from './body-mint'
import { dispatchFlight } from '../flight/dispatch'
import {
  deliverFlightLandedEvent,
  failFlight,
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
import { isExternallySourced } from '../tasks/provenance'
import { MUPOT_PUBLIC_API_VERSION } from '../version'
import { MUPOT_MCP_INITIALIZE_INSTRUCTIONS } from './instructions'
// The SAME predicate the meter enforces with. Imported rather than restated —
// these were two copies and they drifted (#1179 gate R6).
import { isEnforceableCap } from '../agents/meter'

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
        //
        // mupot#903b: a directory-channel session CAN legitimately carry non-zero
        // capabilities now — a consent-bound seat (auth.boundAgentId set via the
        // explicit /oauth/consent flow). Before this, EVERY directory-channel request
        // landed in the `else` branch below and got capabilities=[] + boundAgentId=null
        // unconditionally — which would have made the entire consent feature dead on
        // arrival in production: buildAuthContextFromProps computes the correct clamped
        // capabilities upstream in McpOAuthApiHandler, serializes them into THIS header,
        // and this re-derivation step would have erased them again on every single real
        // request before a tool handler ever saw them. (Every unit test in
        // tests/agent-bound-oauth-consent.test.ts calls invokeTool directly with an
        // already-built AuthContext, bypassing this header hop entirely — which is why
        // none of them caught it; tests/mcp-app-oauth-header.test.ts below drives the
        // real McpOAuthApiHandler -> header -> mcpApp path specifically to close that
        // gap.)
        //
        // Same "never trust the blob's capabilities claim, always re-derive server-side"
        // posture as the known-non-directory branch: resolveConsentedAgentCapabilities
        // re-runs the FULL live check (agent status, the CONSENTING human's status and
        // continued eligibility, and the P0-1 clamp to that human's own rank) fresh
        // against D1 every call — it does not trust auth.capabilities, only
        // auth.boundAgentId and auth.consentedByMemberId as identity/routing pointers
        // (the same trust level auth.boundAgentId already carries for a workspace
        // channel in the branch above, which is left untouched here).
        const knownNonDirectory = isChannel(auth.channel)
        if (knownNonDirectory) {
          auth.capabilities = await resolveCapabilities(c.env, auth.userId)
        } else if (auth.channel === 'directory' && auth.boundAgentId) {
          auth.capabilities = await resolveConsentedAgentCapabilities(
            c.env,
            auth.boundAgentId,
            auth.consentedByMemberId ?? null,
          )
          // mupot#903b P1 (adversarial review round 3): mirrors the same null-out
          // in buildAuthContextFromProps (src/mcp/oauth-authorize.ts) — this is the
          // SECOND derivation site (the internal-header re-derivation hop), and
          // both must independently null the weld once capabilities are empty, or
          // inbox/inbox_consumer_status (gate on auth.boundAgentId alone, zero
          // capability check) would keep this session's identity alive after its
          // ambient authority has already died on this same request.
          if (auth.capabilities.length === 0) auth.boundAgentId = null
        } else {
          auth.capabilities = []
          auth.boundAgentId = null
        }

        // The internal blob may name a token, but it cannot establish token
        // identity by assertion. Re-read the exact live, tenant/member-scoped row
        // before exposing tokenId or its agent weld to verification code. Only
        // touches boundAgentId for a knownNonDirectory (workspace/im) channel —
        // the directory-consent weld above is a distinct, already-live-checked
        // concept (resolveConsentedAgentCapabilities) and must not be clobbered
        // by this token-row re-derivation, which existed before #903b's consent
        // flow and never modeled it.
        if (typeof auth.tokenId === 'string' && auth.tokenId.length > 0) {
          const token = await c.env.DB.prepare(
            `SELECT t.id AS token_id, t.agent_id AS bound_agent_id, m.status AS member_status
               FROM member_tokens t
               JOIN members m ON m.id = t.member_id
              WHERE t.id = ?1
                AND t.member_id = ?2
                AND t.tenant = ?3
                AND m.tenant = ?3
                -- 0099: same shared liveness predicate authenticateMember (below) and
                -- src/auth/member-bearer.ts execute. A hand-written revoked_at IS NULL
                -- here would be a THIRD copy missing expiry — see token-lifecycle.ts's
                -- header on why that is a live bypass door, not a stylistic nit.
                AND ${TOKEN_LIVE_PREDICATE('?4')}
              LIMIT 1`,
          ).bind(auth.tokenId, auth.userId, c.env.TENANT_SLUG, nowSqlUtc()).first<{
            token_id: string
            bound_agent_id: string | null
            member_status: Member['status']
          }>()
          if (!token || token.member_status !== 'active') {
            auth.tokenId = null
            if (knownNonDirectory) auth.boundAgentId = null
          } else {
            auth.tokenId = token.token_id
            if (knownNonDirectory) auth.boundAgentId = token.bound_agent_id ?? null
          }
        } else {
          auth.tokenId = null
        }
        return auth
      }
    } catch {
      // Malformed internal header — fall through to authenticateMember.
    }
  }
  return authenticateMember(c)
}

// Continuum identity extraction: extracts the root agent continuum name (e.g. "river" from "hadi-river", "river-cursor", "muvps_river")
export function extractContinuumName(rawSlugOrName: string): string {
  const cleaned = rawSlugOrName.toLowerCase().trim()
  // Match prefix or suffix qualifiers: e.g. "hadi-river" -> "river", "river-cursor" -> "river", "muvps_kasra" -> "kasra"
  const knownContinuums = ['river', 'kasra', 'loom', 'dara', 'athena', 'cairn', 'hermes']
  for (const known of knownContinuums) {
    if (cleaned === known || cleaned.endsWith(`-${known}`) || cleaned.endsWith(`_${known}`) || cleaned.startsWith(`${known}-`) || cleaned.startsWith(`${known}_`)) {
      return known
    }
  }
  return cleaned
}

// ── member & continuum memory scope ──────────────────────────────────────────
// The MemoryPort is keyed by an opaque id string. A member/agent's memory lives
// under a namespaced key so it never collides with other domains.
function memberMemoryScope(principalId: string, continuumName?: string | null): string {
  if (continuumName && continuumName.trim().length > 0) {
    return `continuum:${extractContinuumName(continuumName)}`
  }
  return `member:${principalId}`
}

function squadMemoryScope(squadId: string): string {
  return `squad:${squadId}`
}

// Project-shared memory scope (Port: project memory). Same opaque-key seam as
// member:/squad: — a distinct namespace so a project's shared engrams never collide
// with a member's private, a squad's shared, or a bare-uuid agent scope. This is the
// "everyone aligned by accessing the project" keystone: any agent with read access to
// the project shares one memory. No migration — the engram row stores this string as
// its agent_id, exactly as squad memory already stores `squad:<id>`.
function projectMemoryScope(projectId: string): string {
  return `project:${projectId}`
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
export async function authenticateMember(c: {
  req: { header: (name: string) => string | undefined }
  env: Env
}): Promise<AuthContext | null> {
  const raw = bearerToken(c.req.header('authorization'))
  if (!raw) return null

  const tokenHash = await sha256Hex(raw)

  // Look up a live (not revoked) token, joined to its member. We re-check the
  // member's status: a suspended member's tokens are inert even if not revoked.
  const row = await c.env.DB.prepare(
    `SELECT t.id            AS token_id,
            m.id            AS member_id,
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
        -- 0099: liveness (revoked OR expired) comes from ONE shared predicate that
        -- src/auth/member-bearer.ts also executes. Enforcing expiry in only one of the
        -- two bearer lookups would leave the other as a live bypass door.
        AND ${TOKEN_LIVE_PREDICATE('?3')}
      LIMIT 1`,
  )
    .bind(tokenHash, c.env.TENANT_SLUG, nowSqlUtc())
    .first<{
      member_id: string
      token_id: string
      email: string | null
      display_name: string
      telegram_chat_id: string | null
      status: Member['status']
      created_at: string
      channel: AuthContext['channel']
      bound_agent_id: string | null
    }>()

  if (!row) return null

  // 0099: stamp last_used_at. Best-effort by construction — this is telemetry that
  // makes credential cleanup POSSIBLE (without it nothing separates a live agent's
  // token from an abandoned one, so the safe action is always "leave it" and the set
  // only grows), but it is not an authorization input. A failed write must never fail
  // an authenticated request, hence the swallowed catch and the absence of an await
  // on the caller's critical path being load-bearing.
  void touchTokenLastUsed(c.env, tokenHash)
  if (row.status !== 'active') return null

  let capabilities = await resolveCapabilities(c.env, row.member_id)

  // Channel authority shrink (#799 / FLIGHT-003): non-directory IM tokens cannot carry standing admin/owner
  const channel = row.channel ?? 'workspace'
  if (channel === 'im') {
    capabilities = clampChannelCapabilities(capabilities, 'lead')
  }

  // role is the coarse org-role field on AuthContext; a member principal is
  // 'member' at the org-role layer. The REAL authorization is `capabilities`.
  const auth: AuthContext = {
    userId: row.member_id,
    email: row.email,
    role: 'member',
    tenant: c.env.TENANT_SLUG, // environment-derived, never from the client
    memberId: row.member_id,
    channel,
    capabilities,
    boundAgentId: row.bound_agent_id ?? null, // the weld: an agent-scoped token orients ITSELF
    tokenId: row.token_id,
  }
  return auth
}

// ── capability checks (use the FROZEN pure API + scope inheritance) ───────────
// For a SQUAD scope, a department-level grant must inherit down. Delegates to the
// canonical src/auth/capability.ts#canOnSquad (single implementation — see that file's
// docstring for why it lives there instead of here).
export async function memberCanOnSquad(
  env: Env,
  grants: CapabilityGrant[],
  squadId: string,
  min: Capability,
): Promise<boolean> {
  return canOnSquad(env, grants, squadId, min)
}

export { callerHoldsActionCapability } from '../auth/capability'


// ── d1 helpers (read-only lookups; allow-listed table names) ──────────────────
async function loadSquad(env: Env, squadId: string): Promise<Squad | null> {
  const { resolveSquadEntity } = await import('../lib/entity-resolver')
  const res = await resolveSquadEntity(env, squadId)
  return res.ok ? res.entity : null
}

export async function getSquad(env: Env, squadRef: string): Promise<{ ok: true; squad: Squad } | Extract<ToolOutcome, { ok: false }>> {
  const { resolveSquadEntity } = await import('../lib/entity-resolver')
  const res = await resolveSquadEntity(env, squadRef)
  if (!res.ok) {
    if (res.reason === 'ambiguous') {
      return failOnly(409, 'ambiguous_squad_id', { candidates: res.candidates })
    }
    return failOnly(404, 'squad_not_found')
  }
  return { ok: true, squad: res.entity }
}

async function loadAgent(env: Env, agentId: string): Promise<Agent | null> {
  const { resolveAgentEntity } = await import('../lib/entity-resolver')
  const res = await resolveAgentEntity(env, agentId)
  return res.ok ? res.entity : null
}

export async function getAgent(env: Env, agentRef: string): Promise<{ ok: true; agent: Agent } | Extract<ToolOutcome, { ok: false }>> {
  const { resolveAgentEntity } = await import('../lib/entity-resolver')
  const res = await resolveAgentEntity(env, agentRef)
  if (!res.ok) {
    if (res.reason === 'ambiguous') {
      return failOnly(409, 'ambiguous_agent_id', { candidates: res.candidates })
    }
    return failOnly(404, 'agent_not_found')
  }
  return { ok: true, agent: res.entity }
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
type ToolError = { status: 400 | 403 | 404 | 409 | 410 | 500 | 503; error: string; detail?: unknown }
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
export type ToolCtx = {
  origin: string
  waitUntil?: (promise: Promise<unknown>) => void
  seat?: string
  source?: string
}

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

const PATCH_ALLOWED_STATUSES: ReadonlySet<string> = new Set(['open', 'in_progress', 'blocked', 'done', 'review'])
const BROADCAST_REQUEST_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/

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
  const { resolveTaskEntity } = await import('../lib/entity-resolver')
  const res = await resolveTaskEntity(env, taskId)
  return res.ok ? res.entity : null
}

export async function getTask(env: Env, taskRef: string): Promise<{ ok: true; task: Task } | Extract<ToolOutcome, { ok: false }>> {
  const { resolveTaskEntity } = await import('../lib/entity-resolver')
  const res = await resolveTaskEntity(env, taskRef)
  if (!res.ok) {
    if (res.reason === 'ambiguous') {
      return failOnly(409, 'ambiguous_task_id', { candidates: res.candidates })
    }
    return failOnly(404, 'task_not_found')
  }
  return { ok: true, task: res.entity }
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

// Exported so sibling tool modules (src/mcp/addons.ts, provision.ts) share this ONE
// org-admin check instead of re-deriving it — the MCP-side equivalent of
// src/auth/capability.ts#isOrgAdmin (dashboard route gate), translated from coarse
// session role to the capability-grant system real MCP callers carry.
export function hasWorkspaceAdmin(auth: AuthContext): boolean {
  // Channel authority shrink (#799 / FLIGHT-003): non-directory channels (im, telegram) cannot hold workspace admin
  if (auth.channel === 'im') return false
  if (auth.capabilities === undefined) return auth.role === 'owner' || auth.role === 'admin'
  return hasCapability(auth.capabilities, 'org', null, 'admin')
}

// Org owner/admin by EITHER route. hasWorkspaceAdmin alone is not enough: when
// capabilities are present it ignores auth.role entirely, so a principal whose
// ownership lives in the legacy role column but who holds only squad-scoped
// capabilities is refused. And auth.role alone is not enough either: over MCP it
// is always 'member' (assigned once at signup, no tool changes it), so a genuine
// owner holding org->admin as a GRANT is refused. The two planes disagree — see
// the dashboard/MCP split in mupot#530 — so an authority check that must not
// fail closed on a real owner has to consult both.
export function isOrgOwnerAdmin(auth: AuthContext): boolean {
  // Channel authority shrink (#799 / FLIGHT-003): non-directory channels (im, telegram) cannot hold org owner/admin
  if (auth.channel === 'im') return false
  return hasWorkspaceAdmin(auth) || auth.role === 'owner' || auth.role === 'admin'
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

function taskProjectFailure(error: TaskProjectError): ToolOutcome {
  if (error.code === 'project_not_found') return fail(404, error.code)
  if (error.code === 'project_access_forbidden') {
    return fail(403, 'forbidden', { need: 'project_write' })
  }
  // #400: detaching a receipt-less task that already carries a non-empty
  // result would drop it out of the project evidence board unlocked — same
  // conflict shape as the durable receipt/flight locks, so 409 not 400.
  if (error.code === 'detach_locked_result_present') return fail(409, error.code)
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

  const squadRes = await getSquad(env, squadId)
  if (!squadRes.ok) return squadRes
  const squad = squadRes.squad

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
  args: '{ squad_id: string, project_id?: string|null, title: string, done_when: string, body?: string, assignee_agent_id?: string, priority?: "P0"|"P1"|"P2"|"P3", parent_task_id?: string, external_source?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      squad_id: STRING_SCHEMA,
      project_id: NULLABLE_STRING_SCHEMA,
      title: STRING_SCHEMA,
      done_when: { ...STRING_SCHEMA, description: 'Verifiable success predicate — a checkable condition that proves the task is complete.' },
      body: STRING_SCHEMA,
      assignee_agent_id: STRING_SCHEMA,
      priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'], description: 'Rank. Omit to leave UNTRIAGED — a real state, deliberately sorted last so unranked work has a cost.' },
      parent_task_id: { ...STRING_SCHEMA, description: 'Parent task id, making this a subtask. Must be an existing task in the same squad.' },
      // PR #659 P0 fix (migrations/0077): carries provenance forward when a task with an
      // existing external_source is legitimately re-created (today: scripts/steward-worker.py's
      // auto-reissue of a blocked/orphaned task — the "amplifier" the diverse-model gate
      // flagged, where a re-issued Linear-origin task lost its marker and re-entered the
      // normal event-wake path unmarked). Safe to expose to any member+ caller: the field is
      // MONOTONIC — it only ever ADDS restriction (no auto-pickup, admin-gated reassignment,
      // untrusted-content prompt fence; see canAgentExecuteTask/routeUnassignedWork/
      // buildExecutePrompt), never removes it, so a caller setting it on its own new task
      // cannot escalate privilege. It cannot be used to CLEAR an existing task's marker —
      // task_update has no assignee/provenance-mutation path for it.
      external_source: STRING_SCHEMA,
      // Backlog vs dispatch (Flight-006 Slice 1 parity for the MCP path).
      // dispatch:false = planning-only create — task.created is suppressed so the
      // task.created → dispatchSquad wake loop never fires. dispatch:true (or
      // omitted) keeps the current wake behavior.
      dispatch: { type: 'boolean', description: 'false = backlog-only (no wake); true/omitted = wake the squad' },
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

    // PR #659 P0 fix: bounded, optional provenance carry-forward (see inputSchema comment
    // above). Absent/null/blank -> undefined -> createTask defaults external_source to null,
    // same as every ordinary create call today.
    let externalSource: string | undefined
    if (args.external_source !== undefined && args.external_source !== null) {
      if (typeof args.external_source !== 'string') return fail(400, 'invalid_args', 'external_source must be a string')
      const trimmed = args.external_source.trim()
      if (trimmed.length === 0) return fail(400, 'invalid_args', 'external_source must not be blank')
      if (trimmed.length > 200) return fail(400, 'invalid_args', 'external_source must be at most 200 characters')
      externalSource = trimmed
    }

    const projectId = args.project_id == null ? null : str(args.project_id)
    if (args.project_id != null && !projectId) return fail(400, 'invalid_project_id')

    let priority: TaskPriority | null = null
    if (args.priority != null) {
      if (!isTaskPriority(args.priority)) return fail(400, 'invalid_priority', { accepted: TASK_PRIORITIES })
      priority = args.priority
    }

    // A subtask must live on the SAME squad as its parent. Without this a caller could
    // parent a task onto a squad it cannot see, and every squad-scoped read would then
    // return a tree whose branches cross an authorization boundary — the capability check
    // above is per-squad, so a cross-squad parent silently widens what a reader sees.
    let parentTaskId: string | null = null
    if (args.parent_task_id != null) {
      const ref = str(args.parent_task_id)
      if (!ref) return fail(400, 'invalid_args', 'parent_task_id must be a non-empty string')
      const parent = await loadTask(env, ref)
      if (!parent) return fail(404, 'parent_task_not_found')
      if (parent.squad_id !== squad.id) return fail(400, 'parent_task_cross_squad', 'a subtask must live on the same squad as its parent')
      parentTaskId = parent.id
    }

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
          priority,
          parent_task_id: parentTaskId,
        },
        { actor: memberActor(auth.memberId as string), externalSource, skipEvent: args.dispatch === false },
      )
    } catch (error) {
      if (error instanceof TaskSelfGateError) return fail(409, 'self_gate_conflict', error.message)
      if (error instanceof TaskIntakeContractError) return fail(400, error.code, error.message)
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
        `SELECT ${TASK_SELECT_COLUMNS}
           FROM tasks
          WHERE ${clauses.join(' AND ')}
          ORDER BY ${priorityOrderSql()}, created_at ${isActionable ? 'ASC' : 'DESC'}
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
        `SELECT ${TASK_SELECT_COLUMNS}
           FROM tasks
          WHERE ${[...baseClauses, actionableStatusInSql()].join(' AND ')}
          ORDER BY ${actionableStatusOrderSql()}, ${priorityOrderSql()}, created_at ASC
          LIMIT ${limit}`,
      )
        .bind(...baseBinds)
        .all<Task>()
      taskRows.push(...(actionableRows.results ?? []))

      const remaining = limit - taskRows.length
      if (remaining > 0) {
        const terminalRows = await env.DB.prepare(
          `SELECT ${TASK_SELECT_COLUMNS}
             FROM tasks
            WHERE ${[...baseClauses, terminalStatusInSql()].join(' AND ')}
            ORDER BY ${priorityOrderSql()}, created_at DESC
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
      // Ranked within the LIMIT, not merely recent (#713). task_board is the kanban view;
      // ordering it by created_at means a board capped at `limit` drops the OLDEST rows
      // regardless of priority, so a P0 filed last month can fall out of the board entirely
      // while P3 chatter from today stays. Found by the ORDER-BY parity guard, not by me.
      `SELECT ${TASK_SELECT_COLUMNS}
         FROM tasks
        WHERE squad_id = ?1
        ORDER BY ${priorityOrderSql()}, created_at DESC
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
      ALL_TASK_STATUSES.map((status) => [status, columns[status].length]),
    ) as Record<TaskStatus, number>
    return done({ squad_id: squadRes.squad.id, counts, columns })
  },
}

// kanban_board — multi-perspective Squad & Project Kanban view for agents and tools.
// Supports both squad-centric and project-centric perspectives with RBAC isolation.
const toolKanbanBoard: ToolSpec = {
  name: 'kanban_board',
  scope: 'squad / project',
  min: 'member',
  args: '{ squad_id?: string, squad?: string, project_id?: string, project?: string, view?: "squad"|"project"|"matrix" }',
  inputSchema: {
    type: 'object',
    properties: {
      squad_id: STRING_SCHEMA,
      squad: STRING_SCHEMA,
      project_id: STRING_SCHEMA,
      project: STRING_SCHEMA,
      view: { type: 'string', enum: ['squad', 'project', 'matrix'] },
    },
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const squadParam = str(args.squad_id) || str(args.squad) || undefined
    const projectParam = str(args.project_id) || str(args.project) || undefined
    const viewParam = str(args.view) || undefined

    const data = await loadKanbanData(env, auth, {
      squadIdOrSlug: squadParam,
      projectIdOrSlug: projectParam,
      view: viewParam,
    })

    return done(data)
  },
}

// task_update — mutate a task through the same lifecycle gates as PATCH /api/tasks/:id.
// cap: member+ on the task's squad. approved/rejected still require the verdict
// endpoint; this tool can move work through open/in_progress/blocked/review/done.
const toolTaskUpdate: ToolSpec = {
  name: 'task_update',
  scope: 'squad (of the task)',
  min: 'member',
  args: '{ task_id: string, project_id?: string|null, title?: string, body?: string, done_when?: string, status?: "open"|"in_progress"|"blocked"|"done"|"review", priority?: "P0"|"P1"|"P2"|"P3"|null, parent_task_id?: string|null, assignee_agent_id?: string|null, gate_owner?: string|null, gate_owner_reason?: string, reversal_reason?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: STRING_SCHEMA,
      project_id: NULLABLE_STRING_SCHEMA,
      title: STRING_SCHEMA,
      body: STRING_SCHEMA,
      note: STRING_SCHEMA,
      reason: STRING_SCHEMA,
      reversal_reason: STRING_SCHEMA,
      verdict_reversal_reason: STRING_SCHEMA,
      done_when: STRING_SCHEMA,
      status: STRING_SCHEMA,
      priority: { type: ['string', 'null'], description: 'Rank, or null to return the task to UNTRIAGED.' },
      parent_task_id: { type: ['string', 'null'], description: 'Parent task id, or null to promote this task to top level.' },
      assignee_agent_id: STRING_SCHEMA,
      gate_owner: STRING_SCHEMA,
      gate_owner_reason: STRING_SCHEMA,
      result: { type: ['string', 'null'], description: 'Task execution completion result (must include Artifact: <path> and SHA256: <64-hex> when entering review or completing)' },
    },
    required: ['task_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const taskRef = str(args.task_id)
    if (!taskRef) return fail(400, 'invalid_args', 'task_id required')
    const taskRes = await getTask(env, taskRef)
    if (!taskRes.ok) return taskRes
    const existing = taskRes.task

    const grants = auth.capabilities ?? []
    if (!(await memberCanOnSquad(env, grants, existing.squad_id, 'member'))) {
      return fail(403, 'forbidden', { need: 'member', scope: 'squad' })
    }

    const next: Task = { ...existing }
    let changed = false
    let reversesVerdict = false
    let reversalReason = ''

    if (args.result !== undefined) {
      next.result = args.result === null ? null : str(args.result)
      changed = true
    }
    if (args.title !== undefined) {
      if (!str(args.title)) return fail(400, 'invalid_title')
      next.title = (args.title as string).trim()
      changed = true
    }
    if (args.body !== undefined || args.note !== undefined || args.reason !== undefined) {
      const explicitBody = typeof args.body === 'string' ? args.body : existing.body ?? ''
      const extraContent = [args.note, args.reason]
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .join('\n\n')
      
      const newBody = extraContent
        ? (explicitBody ? `${explicitBody}\n\n${extraContent}` : extraContent)
        : explicitBody

      next.body = newBody
      changed = true
    }
    if (args.done_when !== undefined) {
      if (!isDoneWhenValid(args.done_when)) {
        return fail(400, 'invalid_done_when', 'done_when must be a non-empty verifiable success predicate')
      }
      next.done_when = (args.done_when as string).trim()
      changed = true
    }
    if (args.priority !== undefined) {
      // Explicit null RE-TRIAGES a task back to untriaged. That is a legitimate operation
      // ("I ranked this wrongly"), and it is distinguishable from "field absent" only
      // because we branch on `=== undefined` rather than on truthiness — the same
      // null-vs-absent split that #684-era code kept getting wrong.
      if (args.priority === null) {
        next.priority = null
      } else {
        const candidate: unknown = args.priority
        if (!isTaskPriority(candidate)) return fail(400, 'invalid_priority', { accepted: TASK_PRIORITIES })
        next.priority = candidate
      }
      changed = true
    }
    if (args.parent_task_id !== undefined) {
      if (args.parent_task_id === null) {
        next.parent_task_id = null
      } else {
        const ref = str(args.parent_task_id)
        if (!ref) return fail(400, 'invalid_args', 'parent_task_id must be a non-empty string or null')
        if (ref === existing.id) return fail(400, 'parent_task_self', 'a task cannot be its own parent')
        const parent = await loadTask(env, ref)
        if (!parent) return fail(404, 'parent_task_not_found')
        if (parent.squad_id !== existing.squad_id) {
          return fail(400, 'parent_task_cross_squad', 'a subtask must live on the same squad as its parent')
        }
        // One level of cycle protection beyond the DB trigger: A->B->A. Deeper cycles are
        // still possible and are NOT claimed to be prevented here — stating that rather
        // than implying full acyclicity, because a guard that sounds complete and is not
        // is worse than a named partial one.
        if (parent.parent_task_id === existing.id) {
          return fail(400, 'parent_task_cycle', 'that task is already a child of this one')
        }
        next.parent_task_id = parent.id
      }
      changed = true
    }
    if (args.status !== undefined) {
      if (!isPatchableStatus(args.status)) {
        // approved/rejected are deliberately NOT patchable — a task must not approve
        // itself; that transition belongs to task_verdict, which records who decided.
        // Saying so here turns a dead end into a next step: this was read as "tasks are
        // stuck in review" for weeks when the real answer was "use the other tool".
        return fail(400, 'invalid_status', {
          accepted: [...PATCH_ALLOWED_STATUSES],
          hint: (args.status === 'approved' || args.status === 'rejected')
            ? 'approved/rejected are set by task_verdict, not task_update — a task cannot approve itself'
            : undefined,
        })
      }
      const isVerdictReversal =
        (existing.status === 'approved' || existing.status === 'rejected') &&
        args.status === 'review'

      if (isVerdictReversal) {
        // VERDICT REVERSAL PATH (P0 fix, mupot#1181)
        // Org owner/admin only, mandatory reason, append-only receipt to verdict_reversals table.
        reversalReason =
          typeof args.reversal_reason === 'string'
            ? args.reversal_reason.trim()
            : typeof args.verdict_reversal_reason === 'string'
              ? args.verdict_reversal_reason.trim()
              : typeof args.reason === 'string'
                ? args.reason.trim()
                : ''
        if (!isOrgOwnerAdmin(auth)) {
          return fail(403, 'forbidden', {
            need: 'org_admin',
            detail: 'verdict reversal on an approved/rejected task requires org owner/admin authority',
          })
        }
        if (reversalReason.length === 0) {
          return fail(400, 'verdict_reversal_reason_required', {
            detail: 'reversing a verdict on an approved/rejected task to review requires a non-empty reversal_reason',
          })
        }
        reversesVerdict = true
      } else {
        const transitionErr = checkTransition(existing.status, args.status)
        if (transitionErr) return fail(400, 'invalid_transition', transitionErr)
      }
      // GATE-EXIT GUARD (mirror of PATCH /api/tasks/:id): entering 'review'
      // requires a gate_owner, else the task is a zombie with no legal exit
      // (verdict 409s no_gate; review→open|in_progress is forbidden). Evaluate the
      // EFFECTIVE gate_owner after applying args.gate_owner — pre-review the gate
      // isn't locked, so it may be set in this same call.
      let effectiveGateOwner: string | null = existing.gate_owner
      if (args.status === 'review') {
        effectiveGateOwner =
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
      // NO SELF-CLOSE (fake-green guard, 2026-07-20 re-gate on PR #417): an
      // agent assignee may not mark its OWN in_progress task 'done' — that is
      // grading your own homework. Now calls the SHARED chokepoint
      // (assigneeSelfClose, src/tasks/service.ts) so this path agrees with every
      // other done-write path (execute.ts's finishTask, REST PATCH). approved→done
      // stays allowed: a non-assignee verdict has already passed the gate by then.
      if (assigneeSelfClose(auth.boundAgentId, existing.status, existing.assignee_agent_id, args.status)) {
        return fail(
          409,
          'assignee_cannot_self_close',
          'the assignee cannot mark its own task done; move it to review so a different principal can verify and close',
        )
      }
      if (args.status === 'done') {
        try {
          assertCompletableDoneWhen(next.done_when)
        } catch (err) {
          return fail(409, 'done_when_placeholder', err instanceof Error ? err.message : 'done_when is not completable')
        }
      }
      // PROVENANCE-SAFE ARTIFACT GATE (mupot#76e25fc2, FLIGHT-07B), checked
      // LAST among the transition guards — deliberately: self-close and
      // done_when-placeholder are structural/identity rules that hold
      // regardless of evidence quality, and a caller blocked by one of those
      // should be told THAT, not sent to go improve evidence that would still
      // be refused anyway. Covers the path Door 6 in execute.ts does NOT
      // reach: a DIRECT external caller moving a task into review, or moving
      // an UNGATED task straight to done via this same PATCH —
      // patchToDoneBypassesGate above only fires when a gate_owner is set, so
      // an ungated task's direct PATCH-to-done was the one path with NO
      // verification at all, gate or artifact.
      //
      // SCOPED to existing.assignee_agent_id != null (gate BLOCK finding #4,
      // 2026-08-18): `result` (migrations/0006) is written ONLY by the AgentDO
      // execute-mode cortex cycle — a purely human/operational task never has
      // one and was never meant to. Checking it unconditionally would block
      // every non-agent task from ever reaching review/done. Restricting to
      // agent-assigned tasks targets the actual threat (a5e45082: fabricated
      // agent-produced evidence accepted as real) without touching tasks that
      // were never agent-executed at all.
      //
      // KNOWN OPEN GAP, not fixed here (gate BLOCK finding #2): task_update
      // never sets `result` itself — it only checks whatever is ALREADY on
      // the row, written by execute.ts's finishTask. For an in-Worker AgentDO
      // task that is exactly right (finishTask is the sole writer). For an
      // EXTERNAL/bound-seat runtime there is currently no tool that lets it
      // report a completion result back into `result` at all — meaning this
      // gate's "external seat completes via task_update" path is not yet
      // realizable, only the in-Worker path is. Filing as a separate follow-up
      // (a completion-reporting primitive symmetric to task_dispatch) rather
      // than building it under this PR's time box.
      const entersReview = args.status === 'review'
      const ungatedDirectDone = args.status === 'done' && existing.status !== 'approved' && existing.status !== 'rejected' && !effectiveGateOwner
      if ((entersReview || ungatedDirectDone) && existing.assignee_agent_id) {
        const artifactCheck = verifyTaskArtifactShape(next.result ?? existing.result)
        if (!artifactCheck.verified) {
          return fail(409, 'artifact_verification_failed', {
            reason: artifactCheck.reason,
            ...(artifactCheck.path ? { path: artifactCheck.path } : {}),
            detail: 'an agent-assigned task can only enter review or be marked done directly when its result states both "Artifact: <path>" and "SHA256: <64-hex>"',
          })
        }
      }
      next.status = args.status
      changed = true
    }
    if (args.assignee_agent_id !== undefined) {
      // BLOCK-1 close (fake-green guard, 2026-07-20 re-gate on PR #417): the
      // no-self-close predicate only fires on in_progress→done. An agent could
      // launder around it by first stripping/reassigning itself off the task
      // here (assignee_agent_id:null or someone else) while still in_progress,
      // THEN calling {status:'done'} in a second request — by then the assignee
      // no longer matches and assigneeSelfClose sees no self-match at all.
      // Shared chokepoint (assigneeCannotMutateOwnAssignment, src/tasks/service.ts):
      // an agent bound-token that IS the CURRENT assignee of an in_progress task
      // cannot change assignee_agent_id on that task — self-unassign or reassign
      // to anyone else. Operators and non-assignee agents are unaffected.
      if (assigneeCannotMutateOwnAssignment(auth.boundAgentId, existing.status, existing.assignee_agent_id)) {
        return fail(
          409,
          'assignee_cannot_mutate_own_assignment',
          'the current assignee cannot change the assignee field on its own in_progress task; ask an operator or a different principal',
        )
      }
      // #406 fast-follow (Opus re-gate WARN-1 on #404) — mirrors the same guard
      // in PATCH /api/tasks/:id (src/tasks/index.ts): #404 closed AUTO-pickup of
      // an unassigned source_pot task, but ASSIGNMENT itself only required
      // member+ here, and a runtime-welded agent token carries member on its
      // own squad — so a local agent could self-assign a hostile cross-pot task
      // and then execute it. Require admin+ to change assignee_agent_id on a
      // source_pot task; local (source_pot NULL) task assignment keeps the
      // member+ floor checked at the top of this tool, unaffected.
      // PR #659 P0 fix: external_source (migrations/0077) requires the same admin+ bar as
      // source_pot — same untrusted-writer class (e.g. Linear), same #406 reasoning: a
      // member-tier/runtime-welded agent token must not self-assign untrusted external
      // content and then execute it.
      if (isExternallySourced(existing)) {
        if (!(await memberCanOnSquad(env, grants, existing.squad_id, 'admin'))) {
          return fail(403, 'forbidden', { need: 'admin', scope: 'squad', detail: 'source_pot/external_source task assignment requires admin+' })
        }
      }
      const check = await resolveTaskAssignee(env, args.assignee_agent_id, existing.squad_id)
      if (check.error) return fail(400, check.error)
      next.assignee_agent_id = check.value
      changed = true
    }
    // Hoisted: the receipt write after the update commits needs both, and the
    // gate_owner block below is where they are decided.
    let reassignsGatedReview = false
    let reassignReason = ''
    if (args.gate_owner !== undefined) {
      const lockStatuses: ReadonlySet<TaskStatus> = new Set(['review', 'approved', 'rejected', 'done'])
      const repairsHistoricalUngatedReview =
        existing.status === 'review' &&
        existing.gate_owner === null &&
        typeof args.gate_owner === 'string' &&
        args.gate_owner.trim().length > 0 &&
        hasWorkspaceAdmin(auth)
      // REASSIGNMENT OF AN EXISTING GATE ON A REVIEW TASK.
      //
      // Measured blocker: cb512f05 (FLIGHT-06 L2) sits at status='review' with
      // gate_owner='gate:agent-self-completion' and cannot be re-gated by any
      // supported call — repairsHistoricalUngatedReview above requires
      // gate_owner IS NULL, so a task that already carries a gate is stuck with
      // its original holder forever, including when that holder is retired.
      //
      // The lock this narrows is DELIBERATE — BLOCK-2, proof-of-exploit
      // 2026-08-13: re-gating into a peer's lane let two colluding agents
      // launder a single-gate check, demonstrated live. So every condition here
      // is load-bearing and none may be relaxed without redoing that analysis:
      //   status='review' only — approved/rejected/done stay locked outright, so
      //     this can never rewrite the gate on already-decided work
      //   org owner/admin only — hasWorkspaceAdmin, NOT squad admin or lead
      //   a non-empty reason is mandatory
      //   gate_owner is the only column that moves; no status/result/verdict
      // Written to an append-only receipt below: an owner may reassign a gate,
      // but may not do it invisibly.
      reassignReason =
        typeof args.gate_owner_reason === 'string' ? args.gate_owner_reason.trim() : ''
      const wantsGateReassign =
        existing.status === 'review' &&
        existing.gate_owner !== null &&
        typeof args.gate_owner === 'string' &&
        args.gate_owner.trim().length > 0 &&
        args.gate_owner.trim() !== existing.gate_owner
      // The reason check here is currently REDUNDANT with the explicit 400 below
      // (an admin with no reason is refused there first, and a non-admin fails
      // isOrgOwnerAdmin either way) — mutation-testing confirms removing it
      // changes no reachable behaviour. It stays as defence in depth: if the 400
      // guard is ever moved or narrowed, the mandatory-reason property must not
      // silently disappear with it.
      reassignsGatedReview = wantsGateReassign && isOrgOwnerAdmin(auth) && reassignReason.length > 0
      // A missing reason from an otherwise-authorised owner is its own error.
      // Folding it into gate_owner_locked would tell the caller "the status is
      // wrong" when the status is fine and only the reason is absent.
      if (wantsGateReassign && isOrgOwnerAdmin(auth) && reassignReason.length === 0) {
        return fail(400, 'gate_owner_reason_required', {
          detail: 'reassigning an existing gate_owner on a review task requires a non-empty gate_owner_reason',
        })
      }
      if (lockStatuses.has(existing.status) && !repairsHistoricalUngatedReview && !reassignsGatedReview && !reversesVerdict) {
        return fail(409, 'gate_owner_locked', { status: existing.status })
      }
      // BLOCK-2 fix (kasra-review 2026-08-13, proof-of-exploit): once set,
      // gate_owner is IMMUTABLE via the member API. Re-gating (or un-gating) a
      // task to a peer's lane let two colluding/compromised agents launder any
      // single-gate check (proven live). Only an org owner/admin may change or
      // clear an existing gate_owner.
      if (existing.gate_owner !== null && args.gate_owner !== existing.gate_owner) {
        // Consults BOTH authority planes. The original check read only the
        // coarse legacy `auth.role`, and over MCP that is always 'member'
        // (assigned once at signup, changed by no tool) — so a genuine org owner
        // holding org->admin as a GRANT was refused, and the documented
        // owner/admin escape was unreachable on this path.
        //
        // Swapping it for hasWorkspaceAdmin alone is NOT the fix and was wrong
        // when first tried here: with capabilities present that helper ignores
        // auth.role, which refused a role-based owner that previously passed and
        // broke an existing BLOCK-2 test. Both planes must be consulted, so the
        // change is additive — nobody who passed before is refused now.
        if (!isOrgOwnerAdmin(auth)) {
          return fail(403, 'gate_owner_immutable', {
            detail: 'once set, gate_owner can only be changed or cleared by an org owner/admin',
          })
        }
      }
      if (args.gate_owner === null) {
        next.gate_owner = null
      } else if (typeof args.gate_owner === 'string' && args.gate_owner.trim().length > 0) {
        const trimmed = args.gate_owner.trim()
        // Write-time form guard (247858f1): a bare slug is unverdictable. Reject,
        // never coerce. Legal form: 'gate:<owner>' only.
        if (!isValidGateOwnerForm(trimmed)) {
          return fail(400, 'invalid_gate_owner', "gate_owner must be of the form 'gate:<owner>' — nothing else can match an insertable grant")
        }
        next.gate_owner = trimmed
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

    // #400: close the detach-drops-evidence gap — a detach (project_id ->
    // null) off a task carrying a non-empty result is blocked unless it is
    // already receipt-locked by the separate 0059 mechanism (unaffected here).
    try {
      await validateTaskProjectAttribution(env, next.project_id, existing.squad_id, {
        projectId: existing.project_id,
        result: existing.result,
      })
    } catch (error) {
      if (error instanceof TaskProjectError) return taskProjectFailure(error)
      throw error
    }

    // Point-of-capture severity discipline on mutation (Issue #1040 Phase 2):
    // If priority is explicitly modified to P0/P1, validate intake contract requirements
    if (args.priority !== undefined && (next.priority === 'P0' || next.priority === 'P1')) {
      try {
        assertValidIntakeContract(next, { allowDeferredPredicate: true })
      } catch (error) {
        if (error instanceof TaskIntakeContractError) return fail(400, error.code, error.message)
        throw error
      }
    }

    stampTaskUpdate(next, existing.status, new Date().toISOString())
    try {
      await persistTaskUpdate(env, existing, next)
    } catch (error) {
      if (error instanceof TaskSelfGateError) return fail(409, 'self_gate_conflict', error.message)
      if (error instanceof TaskIntakeContractError) return fail(400, error.code, error.message)
      if (error instanceof TaskUpdateConflictError) return fail(409, error.code)
      throw error
    }
    next.github_issue_url = await mirrorTaskUpdate(env, next, {
      statusChanged: existing.status !== next.status,
    })

    const actor = memberActor(auth.memberId as string)
    await emitTaskEvent(env, 'task.updated', next, actor)

    // Review-wake (S### — wake the gate owner instead of waiting for a hand
    // relay): only on the ENTERING transition (existing status was not already
    // 'review') so an unrelated field edit on an already-review task never
    // re-fires it. gate_required_for_review above already guarantees
    // next.gate_owner is set whenever next.status === 'review'.
    if (existing.status !== 'review' && next.status === 'review' && next.gate_owner) {
      await wakeGateOwnerOnReview(env, next, actor, auth.memberId as string)
    }

    // GATE REASSIGNMENT RECEIPT + WAKE.
    //
    // Ordering is deliberate: the receipt is written BEFORE the wake. A wake is
    // best-effort and may legitimately no-op (no unambiguous holder), but the
    // record of who moved the gate, from where, to where and why must exist
    // regardless. Writing it after a wake that threw would lose the one artifact
    // that makes this path auditable.
    //
    // The receipt failing does NOT roll back the reassignment — the task update
    // has already committed by this point, and pretending otherwise would be a
    // false receipt of a different kind. It throws instead, loudly, so a missing
    // receipt surfaces as an error rather than as silence.
    if (reassignsGatedReview && existing.gate_owner && next.gate_owner) {
      await env.DB.prepare(
        `INSERT INTO gate_owner_reassignments
           (id, tenant, task_id, squad_id, from_gate_owner, to_gate_owner, reason,
            actor_id, actor_type, task_status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'member', ?9)`,
      )
        .bind(
          crypto.randomUUID(),
          env.TENANT_SLUG,
          next.id,
          next.squad_id,
          existing.gate_owner,
          next.gate_owner,
          reassignReason,
          auth.memberId as string,
          existing.status,
        )
        .run()

      // Wake the NEW holder. The entering-review wake above cannot cover this:
      // its guard is `existing.status !== 'review'`, and a reassignment happens
      // on a task that is ALREADY in review — so without this the new gate owner
      // is never told the gate is now theirs, and the task sits exactly as stuck
      // as it was before, just under a different name.
      await wakeGateOwnerOnReview(env, next, actor, auth.memberId as string)
    }

    // VERDICT REVERSAL RECEIPT.
    //
    // An org owner/admin may reverse an approved/rejected verdict back to review,
    // but may never do so invisibly. The receipt is written to an append-only table.
    if (reversesVerdict) {
      await env.DB.prepare(
        `INSERT INTO verdict_reversals
           (id, tenant, task_id, squad_id, from_status, to_status, prior_verdict, reason,
            actor_id, actor_type)
         VALUES (?1, ?2, ?3, ?4, ?5, 'review', ?6, ?7, ?8, 'member')`,
      )
        .bind(
          crypto.randomUUID(),
          env.TENANT_SLUG,
          next.id,
          next.squad_id,
          existing.status,
          existing.status,
          reversalReason,
          auth.memberId as string,
        )
        .run()
    }

    return done({ task: next })
  },
}

// Non-spoofable system-sender literal for a review-wake's durable inbox delegation —
// mirrors DISPATCH_BRIDGE_SENDER's convention (src/bus/fleet-bridge.ts): task_update is
// invoked by a human/agent MEMBER token, not by the gate-owner agent itself, so there is
// no honest agent principal to name as the sender of "you have a review waiting."
const REVIEW_WAKE_SENDER = 'mupot-review-gate'

// sendAgentMessage's request_id must match RID_RE ([A-Za-z0-9_.:-]{1,128}, src/agents/
// messages.ts) — task.id (a uuid) + an ISO timestamp both fit that charset comfortably
// inside the length cap, so no encoding/hashing is needed.
function reviewWakeRequestId(taskId: string, ts: string): string {
  return `review-wake:${taskId}:${ts}`
}

// wakeGateOwnerOnReview — fires when a task ENTERS 'review' with a gate_owner set.
// Two independent, best-effort side channels (neither may ever fail the review
// transition itself, which has already committed by the time this runs):
//
//   1. An `agent.wake` BusEvent, built EXACTLY like toolTaskDispatch's own event
//      (same envelope shape) — this drives the in-Worker AgentDO cortex cycle via
//      src/bus/consumer.ts's 'agent.wake' case. Deliberately NO dispatch_receipt_id
//      in the payload: that field is what taskDispatchIdentity() (consumer.ts) keys
//      on to route into the task_dispatch execute/receipt state machine, which this
//      is not — a review-wake with no dispatch_receipt_id falls through to the
//      plain wakeAgent() path, the same generic "poke this agent's DO" primitive
//      member_wake uses. (AgentDO.wake() will still see payload.task_id and take
//      its EXECUTE MODE branch — but 'review' is in execute.ts's K6 no-op set, so
//      that branch safely no-ops rather than mis-driving execution of a task that
//      is already gated for review.)
//   2. A durable `agent_messages` row (via the SAME sendAgentMessage primitive
//      fleet-bridge.ts uses for task_dispatch's external-runtime delivery), so a
//      non-DO runtime polling GET /api/inbox — the bash wake-hooks — also picks up
//      the review delegation without needing a hand relay.
async function wakeGateOwnerOnReview(
  env: Env,
  task: Task,
  actor: { kind: 'member' | 'agent'; id: string },
  byId: string,
): Promise<void> {
  const gateOwner = task.gate_owner
  if (!gateOwner) return

  let agentId: string | null
  try {
    agentId = await resolveSoleGateOwnerAgent(env, gateOwner)
  } catch {
    return // resolution failure — never break the already-committed review transition
  }
  if (!agentId) return // zero or multiple holders: no unambiguous wake target

  const ts = new Date().toISOString()

  try {
    const event: BusEvent<{ task_id: string; gate_owner: string; by: string }> = {
      type: 'agent.wake',
      tenant: env.TENANT_SLUG,
      squad_id: task.squad_id,
      agent_id: agentId,
      actor,
      payload: { task_id: task.id, gate_owner: gateOwner, by: byId },
      ts,
    }
    await createBus(env).emit(event)
  } catch {
    // best-effort, mirrors toolTaskDispatch's own createBus(env).emit() try/catch
  }

  try {
    await sendAgentMessage(
      env,
      {
        fromAgent: REVIEW_WAKE_SENDER,
        fromMember: byId,
        toAgent: agentId,
        kind: 'request',
        body: JSON.stringify({ type: 'task_review', task_id: task.id, gate_owner: gateOwner, squad_id: task.squad_id }),
        requestId: reviewWakeRequestId(task.id, ts),
      },
      {
        system: true,
        reason: 'target is the sole gate_grants holder resolved server-side, not attacker input',
      },
    )
  } catch {
    // best-effort — durable inbox delivery is additive to the bus wake, never
    // allowed to fail the already-committed review transition.
  }
}

// task_verdict — approve or reject a task in 'review'. The MCP twin of
// POST /api/tasks/:id/verdict, reusing the SAME helpers (callerHoldsGateCapability,
// verdictPrincipal, writeVerdict) so the gate logic never forks. This is the wire
// that lets an operator/gate CLOSE a gated task programmatically over MCP — without
// it a review task can only be verdicted from the browser dashboard. cap: member+
// on the task's squad AND the gate capability named by task.gate_owner.
const toolTaskVerdict: ToolSpec = {
  name: 'task_verdict',
  scope: 'squad (of the task)',
  min: 'member',
  args: '{ task_id: string, verdict: "approved"|"rejected", note?: string, reason?: string, override_self_verdict?: boolean }',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: STRING_SCHEMA,
      verdict: STRING_SCHEMA,
      note: STRING_SCHEMA,
      reason: STRING_SCHEMA,
      override_self_verdict: { type: 'boolean' },
    },
    required: ['task_id', 'verdict'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const taskRef = str(args.task_id)
    if (!taskRef) return fail(400, 'invalid_args', 'task_id required')
    const verdict = args.verdict
    if (verdict !== 'approved' && verdict !== 'rejected') {
      return fail(400, 'invalid_verdict', { accepted: ['approved', 'rejected'] })
    }

    const taskRes = await getTask(env, taskRef)
    if (!taskRes.ok) return taskRes
    const task = taskRes.task

    // Base guard: member+ on the task's squad (same floor as every task mutation).
    const grants = auth.capabilities ?? []
    if (!(await memberCanOnSquad(env, grants, task.squad_id, 'member'))) {
      return fail(403, 'forbidden', { need: 'member', scope: 'squad' })
    }
    if (!task.gate_owner) return fail(409, 'no_gate')
    if (task.status !== 'review') return fail(409, 'not_in_review', { status: task.status })

    // RBAC: caller must hold the gate capability named by task.gate_owner.
    // BLOCK-1 fix (kasra-review 2026-08-13, proof-of-exploit): gate:agent-self-completion
    // is closeable ONLY by the completing agent (the assignee) or an org owner/admin.
    // The grant is NOT authority for this gate — the D2 universal mint grant would
    // let any agent approve any other agent's task (proven live). Every other gate
    // keeps the capability-based check.
    const principal = verdictPrincipal(auth)
    if (task.gate_owner === 'gate:agent-self-completion') {
      const isOwnerAdmin = auth.role === 'owner' || auth.role === 'admin'
      if (principal.id !== task.assignee_agent_id && !isOwnerAdmin) {
        return fail(403, 'forbidden', { need: 'assignee_or_org_admin' })
      }
    } else if (!(await callerHoldsGateCapability(env, auth, task.squad_id, task.gate_owner))) {
      return fail(403, 'forbidden', { need: task.gate_owner })
    }

    // Surface-cap (#106): approving a gate:loops task fires a real send — requires
    // outreach:send-gated. Rejections send nothing and are not surface-gated.
    if (task.gate_owner === 'gate:loops' && verdict === 'approved') {
      if (!(await hasSurfaceCap(env, auth, 'outreach:send-gated'))) {
        return fail(403, 'forbidden', { need: 'outreach:send-gated' })
      }
    }

    // Self-verdict prevention (no grading your own homework). Agent-bound tokens
    // resolve to the bound agent id, so an assignee cannot hide behind its member
    // envelope. Org owner may override with override_self_verdict:true (audited).
    // D1 (2026-08-13): gate:agent-self-completion is the executor's fallback gate
    // for an agent's OWN completion of ungated work (BLOCK-2, PR #417) — the
    // different-principal rule is waived for exactly this capability (the caller
    // still had to pass callerHoldsGateCapability above; every other gate keeps
    // the self_verdict 409). Mirrors the HTTP twin in src/tasks/index.ts.
    let note: string | null = typeof args.note === 'string'
      ? args.note
      : (typeof args.reason === 'string' ? args.reason : null)
    const isSelfCompletionGate = task.gate_owner === 'gate:agent-self-completion'
    if (principal.id === task.assignee_agent_id && !isSelfCompletionGate) {
      const isOrgOwner = auth.role === 'owner'
      const overrideRequested = args.override_self_verdict === true
      if (!isOrgOwner || !overrideRequested) {
        return fail(409, 'self_verdict', {
          reason: 'decider is the task assignee; self-approval is forbidden',
        })
      }
      const overrideNote = `[self_verdict_override by org owner ${principal.id}]`
      note = note ? `${overrideNote} ${note}` : overrideNote
    }

    try {
      const result = await writeVerdict(
        env,
        { task, verdict, note, decidedBy: principal.id },
        principal.actor,
      )
      // Best-effort Workflow resume — D1 is authoritative; a dropped event is fine.
      if (task.workflow_instance_id && env.TASK_WORKFLOW) {
        try {
          const inst = await env.TASK_WORKFLOW.get(task.workflow_instance_id)
          await inst.sendEvent({ type: 'gate-verdict', payload: { verdict } })
        } catch {
          // non-fatal
        }
      }
      return done(result)
    } catch (err) {
      if (err instanceof VerdictRaceError) return fail(409, 'verdict_race')
      if (err instanceof TaskEvidenceFenceError) {
        // #399: owning squad no longer holds write/admin on the task's project.
        return fail(403, 'forbidden', { need: 'project_write' })
      }
      throw err
    }
  },
}

// task_verdict_reverse — reverse an errant verdict on an approved or rejected task
// back to 'review'. Org owner/admin only with mandatory reason. P0 fix, mupot#1181.
const toolTaskVerdictReverse: ToolSpec = {
  name: 'task_verdict_reverse',
  scope: 'squad (of the task)',
  min: 'member',
  args: '{ task_id: string, reason: string, gate_owner?: string|null, gate_owner_reason?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: STRING_SCHEMA,
      reason: STRING_SCHEMA,
      reversal_reason: STRING_SCHEMA,
      gate_owner: STRING_SCHEMA,
      gate_owner_reason: STRING_SCHEMA,
    },
    required: ['task_id'],
    additionalProperties: false,
  },
  async run(auth, env, args, ctx) {
    const taskRef = str(args.task_id)
    if (!taskRef) return fail(400, 'invalid_args', 'task_id required')
    const reason = str(args.reversal_reason) || str(args.reason)
    if (!reason || reason.trim().length === 0) {
      return fail(400, 'verdict_reversal_reason_required', { detail: 'reason is required to reverse a verdict' })
    }
    return toolTaskUpdate.run(auth, env, {
      task_id: taskRef,
      status: 'review',
      reversal_reason: reason.trim(),
      gate_owner: args.gate_owner,
      gate_owner_reason: args.gate_owner_reason,
    }, ctx)
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
  args: '{ task_id: string, target_seat?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: STRING_SCHEMA,
      target_seat: STRING_SCHEMA,
    },
    required: ['task_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const taskId = str(args.task_id)
    if (!taskId) return fail(400, 'invalid_args', 'task_id required')
    const targetSeat = str(args.target_seat) || null
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

    const event: BusEvent<{ task_id: string; by: string; dispatch_receipt_id: string; target_seat?: string }> = {
      type: 'agent.wake',
      tenant: env.TENANT_SLUG,
      squad_id: task.squad_id,
      agent_id: task.assignee_agent_id,
      actor: memberActor(memberId),
      payload: {
        task_id: task.id,
        by: memberId,
        dispatch_receipt_id: receiptId,
        ...(targetSeat ? { target_seat: targetSeat } : {}),
      },
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
      target_seat: targetSeat,
      squad_id: task.squad_id,
      receipt: {
        id: receiptId,
        dispatched_by: memberActor(memberId),
        dispatched_at: dispatchedAt,
      },
    })
  },
}

// task_report_result — report external runtime completion result and artifact claim (Issue #1183).
// Allows external/bound-seat runtimes (Hadi-Grok on Mac, Codex, Cursor Cloud) to report verifiable
// results with Artifact: <path> + SHA256: <64-hex> into tasks.result and transition the task.
const toolTaskReportResult: ToolSpec = {
  name: 'task_report_result',
  scope: 'squad (of the task)',
  min: 'member',
  args: '{ task_id: string, result: string, status?: "in_progress"|"review"|"done", gate_owner?: string|null }',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: STRING_SCHEMA,
      result: STRING_SCHEMA,
      status: { type: 'string', enum: ['in_progress', 'review', 'done'] },
      gate_owner: STRING_SCHEMA,
    },
    required: ['task_id', 'result'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const taskId = str(args.task_id)
    const result = str(args.result)
    if (!taskId || !result) return fail(400, 'invalid_args', 'task_id and result required')

    const statusCandidate = str(args.status)
    const status = (statusCandidate === 'in_progress' || statusCandidate === 'review' || statusCandidate === 'done')
      ? statusCandidate
      : undefined

    const gateOwner = args.gate_owner !== undefined
      ? (args.gate_owner === null ? null : str(args.gate_owner))
      : undefined

    try {
      const { reportTaskResult } = await import('../tasks/report-result')
      const outcome = await reportTaskResult(env, auth, {
        taskId,
        result,
        status,
        gateOwner,
      })
      return done(outcome)
    } catch (err: any) {
      if (err.name === 'TaskReportResultError') {
        return fail(err.status, err.code, err.message)
      }
      return fail(500, 'report_result_failed', err instanceof Error ? err.message : String(err))
    }
  },
}

// task_intake_audit — audit existing tasks for Point-of-Capture intake contract
// compliance (Issue #1040 Phase 3). Scans open/actionable tasks on a squad or across
// the tenant and reports compliance stats, non-compliant tasks, reasons, and suggested remediations.
// Evaluates strictly so placeholder sentinels and unlinked P1 tasks are caught.
const toolTaskIntakeAudit: ToolSpec = {
  name: 'task_intake_audit',
  scope: 'squad / tenant',
  min: 'member',
  args: '{ squad_id?: string, status?: string, priority?: string, non_compliant_only?: boolean, limit?: number }',
  inputSchema: {
    type: 'object',
    properties: {
      squad_id: STRING_SCHEMA,
      status: { type: 'string', enum: [...ALL_TASK_STATUSES] },
      priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
      non_compliant_only: { type: 'boolean' },
      limit: { type: 'number' },
    },
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const squadId = str(args.squad_id)
    const grants = auth.capabilities ?? []

    if (squadId) {
      if (!(await memberCanOnSquad(env, grants, squadId, 'member'))) {
        return fail(404, 'squad_not_found')
      }
    }

    if (args.status !== undefined && !isTaskStatus(args.status)) {
      return fail(400, 'invalid_status', { accepted: ALL_TASK_STATUSES })
    }
    if (args.priority !== undefined && !isTaskPriority(args.priority)) {
      return fail(400, 'invalid_priority', { accepted: TASK_PRIORITIES })
    }

    const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 500)
    const nonCompliantOnly = Boolean(args.non_compliant_only)

    const conditions: string[] = []
    const bindings: unknown[] = []

    if (squadId) {
      conditions.push(`squad_id = ?`)
      bindings.push(squadId)
    }
    if (args.status && typeof args.status === 'string') {
      conditions.push(`status = ?`)
      bindings.push(args.status)
    }
    if (args.priority && typeof args.priority === 'string') {
      conditions.push(`priority = ?`)
      bindings.push(args.priority)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const rows = await env.DB.prepare(
      `SELECT ${TASK_SELECT_COLUMNS}
         FROM tasks ${whereClause}
        ORDER BY ${priorityOrderSql()}, created_at DESC
        LIMIT ?`,
    )
      .bind(...bindings, limit)
      .all<Task>()

    const tasks = rows.results ?? []
    const audited = []
    let compliantCount = 0
    let nonCompliantCount = 0

    for (const task of tasks) {
      // Check squad visibility if querying tenant-wide
      if (!squadId && !(await memberCanOnSquad(env, grants, task.squad_id, 'member'))) {
        continue
      }

      // STRICT evaluation (no deferral): catches sentinel predicates and short predicates as debt
      const audit = evaluateTaskIntakeContract(task, { allowDeferredPredicate: false })
      if (audit.compliant) {
        compliantCount++
        if (!nonCompliantOnly) {
          audited.push({
            id: task.id,
            squad_id: task.squad_id,
            title: task.title,
            priority: task.priority,
            status: task.status,
            project_id: task.project_id,
            compliant: true,
          })
        }
      } else {
        nonCompliantCount++
        audited.push({
          id: task.id,
          squad_id: task.squad_id,
          title: task.title,
          priority: task.priority,
          status: task.status,
          project_id: task.project_id,
          compliant: false,
          violation_code: audit.code,
          reason: audit.reason,
        })
      }
    }

    return done({
      total_scanned: audited.length,
      compliant_count: compliantCount,
      non_compliant_count: nonCompliantCount,
      tasks: audited,
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
  args: '{ squad_id: string, project_id?: string|null, goal: string, meta_json: string, '
    + 'signals_json: string (JSON object — camelCase or snake_case, both accepted; ALL 8 fields '
    + 'required, unknown keys refused: contextComplete/context_complete: boolean, '
    + 'toolsReachable/tools_reachable: boolean, budgetRemainingMicroUsd/budget_remaining_micro_usd: number, '
    + 'budgetEstimateMicroUsd/budget_estimate_micro_usd: number, recentProgress/recent_progress: number 0..1, '
    + 'progressPerStep/progress_per_step: number 0..1, wastePerStep/waste_per_step: number 0..1, '
    + 'stepSeconds/step_seconds: number), budget_micro_usd?: number, '
    + 'executor_agent_id?: string (who FLIES the flight, if not the caller — requires lead on the executor\'s squad) }',
  inputSchema: {
    type: 'object',
    properties: {
      squad_id: STRING_SCHEMA,
      project_id: NULLABLE_STRING_SCHEMA,
      goal: STRING_SCHEMA,
      meta_json: STRING_SCHEMA,
      signals_json: STRING_SCHEMA,
      budget_micro_usd: OPTIONAL_NUMBER_SCHEMA,
      executor_agent_id: STRING_SCHEMA,
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

    // executor delegation (mupot flight_dispatch executor-delegation defect): the
    // caller (auth.boundAgentId) is always the DISPATCHER; the EXECUTOR — who
    // flies the flight, whose seat the work envelope lands on, whose budget the
    // flight spends against execute.ts's meter — defaults to the dispatcher but
    // may be a DIFFERENT agent. Delegating causes work to appear under another
    // agent's identity and consume their budget, so it is gated exactly like
    // wake_agent gates "make another agent act": lead+ on the EXECUTOR's own
    // squad (src/mcp/index.ts's toolWakeAgent) — not merely membership on the
    // flight's squads, and no executor consent is required or sought, matching
    // wake_agent's posture. Omitting executor_agent_id is a no-op: executor ===
    // dispatcher, byte-identical to pre-delegation behaviour.
    const executorAgentId = args.executor_agent_id == null ? boundAgent.id : str(args.executor_agent_id)
    if (!executorAgentId) return fail(400, 'invalid_args', 'executor_agent_id must not be blank')
    const isDelegated = executorAgentId !== boundAgent.id
    const executorAgent = isDelegated ? await loadAgent(env, executorAgentId) : boundAgent
    if (!executorAgent) return fail(404, 'executor_agent_not_found')
    if (executorAgent.status !== 'active') return fail(409, 'executor_agent_inactive')
    if (isDelegated && !workspaceAdmin && !(await memberCanOnSquad(env, grants, executorAgent.squad_id, 'lead'))) {
      return fail(403, 'flight_delegation_forbidden', { need: 'lead', scope: 'squad', squad_id: executorAgent.squad_id })
    }

    const meta = parseFlightMetaV1(parseJsonArg(args.meta_json))
    if (!meta || !meta.squad_ids.includes(squad.id)) return fail(400, 'invalid_flight_meta')
    if (!meta.squad_ids.includes(executorAgent.squad_id)) return fail(400, 'agent_squad_not_in_flight')
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
    // Rows dispatching with NO dollar cap. Reported on the success payload so an
    // uncapped flight is visible rather than silent — "unlimited" must be an
    // observable state, not an absence.
    let budgetUncapped: Array<{ kind: 'agent' | 'squad'; id: string; slug: string }> = []
    if ((requestedBudget as number) > 0) {
      // The EXECUTOR's cap governs, not the dispatcher's: execute.ts's meter
      // (checkAndReserve) enforces agents.budget_cap_cents keyed to the agent
      // whose Durable Object actually runs the cycle — i.e. the executor. When
      // executor === dispatcher (the non-delegated, default case) this is the
      // exact same value as before; behaviour is unchanged for every existing
      // caller.
      // AN UNSET budget_cap_cents MEANS UNLIMITED — the same thing it already
      // means one layer down. meter.ts:151-156 resolves null/<=0 to "no dollar
      // cap"; this gate used to resolve the identical value to "refuse the
      // flight". One predicate, two copies, opposite meanings — and since
      // budget_cap_cents is nullable with no default on both agents and squads
      // (0009_work_unit.sql) and create_agent/create_squad leave it null
      // whenever the caller omits it, the admission layer refused nearly every
      // budgeted flight while the enforcement layer would have allowed it.
      // That, not a missing default, is mupot#1148.
      //
      // Uncapped in DOLLARS is not unbounded: meter.ts still enforces
      // MAX_DISPATCHES_PER_DAY (200) and MAX_TOKENS_PER_DAY (200_000) per agent
      // regardless of any cap here. Those day caps are the ONLY execution-time
      // bound, and they are non-disablable (parseCap).
      //
      // The flight's own requested budget is NOT an execution-time bound, and an
      // earlier version of this comment said it was (caught by Athena's gate on
      // PR #1179, R1). It is checked at flight_land, against SELF-REPORTED cost,
      // after the work is already done. A flight can overspend its requested
      // budget arbitrarily during execution and nothing stops it; landing merely
      // records the overrun. Do not read the requested budget as a ceiling.
      //
      // Note also that a cents cap models MARGINAL per-token spend,
      // which is the wrong shape for agents running on a flat-rate subscription
      // ration (Anthropic/OpenAI/Google plans) — those are capacity-limited, not
      // dollar-limited. Modelling that is tracked separately; do not read this
      // ceiling as the whole cost picture.
      const budgetSources = [
        { kind: 'agent' as const, id: executorAgent.id, slug: executorAgent.slug, cap: executorAgent.budget_cap_cents },
        ...referencedSquads.map((item) => (
          { kind: 'squad' as const, id: item.id, slug: item.slug, cap: item.budget_cap_cents }
        )),
      ]
      // This decides what we REPORT (budget_uncapped); the meter decides what is
      // ENFORCED. When the two disagree, the report lies about the system's own
      // behaviour — so it is now literally the meter's function, not a copy of its
      // condition. See isEnforceableCap in src/agents/meter.ts for why (#1179 R6).
      const isConfigured = isEnforceableCap
      const configured = budgetSources.filter((source) => isConfigured(source.cap))
      budgetUncapped = budgetSources
        .filter((source) => !isConfigured(source.cap))
        .map((source) => ({ kind: source.kind, id: source.id, slug: source.slug }))

      if (configured.length > 0) {
        // An unconfigured row is unlimited, so it can never be the minimum —
        // the binding constraint is the lowest CONFIGURED cap.
        const binding = configured.reduce((lowest, source) => (
          (source.cap as number) < (lowest.cap as number) ? source : lowest
        ))
        budgetCeilingMicroUsd = (binding.cap as number) * 10_000
        if ((requestedBudget as number) > budgetCeilingMicroUsd) {
          return fail(409, 'flight_budget_exceeds_cap', {
            cap_micro_usd: budgetCeilingMicroUsd,
            binding: { kind: binding.kind, id: binding.id, slug: binding.slug },
          })
        }
      } else {
        // No dollar cap anywhere in the set. The request itself is the bound.
        budgetCeilingMicroUsd = requestedBudget as number
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
      agent: executorAgentId,
      // Always recorded, delegated or not (see flights.dispatched_by_agent_id /
      // 0094_flight_dispatched_by.sql): flight.agent stays the EXECUTOR, never
      // silently overwritten to "tidy" the record — both facts must be
      // independently recoverable from the row.
      dispatched_by: auth.boundAgentId,
      goal,
      project_id: projectId,
      trigger_source: 'api',
      budget_micro_usd: requestedBudget,
      meta,
      signals,
    })
    if (!parsed.ok) return fail(400, parsed.error, parsed.detail)
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

    // The tool is called flight_dispatch and it did not dispatch (#860). It created
    // the row, scored it, and returned — no envelope, no agent told anything. A
    // flight would sit in `running` forever while its assigned seat's inbox stayed
    // empty, which is indistinguishable from a stalled flight and is the shape of
    // every phantom on this board.
    //
    // Ordering is deliberate and is the other half of #861: preflight GATES the
    // send. On a no_go nothing is sent, because a gate that runs after the work is
    // handed out is a stamp, not a gate.
    //
    // The envelope is flight.dispatch/v1, NOT routine.run/v1. routine.run/v1 carries
    // run_id, project_id, routine_revision and situation_digest — an API-dispatched
    // flight has none of those, and forging them would make a flight impersonate a
    // routine run that no scheduler owns.
    if (preflight.go) {
      // Omit the endpoint rather than emit a request-derived or "null" origin: a
      // wrong MCP address in a work order sends the agent somewhere real and wrong.
      const flightOrigin = requiredCanonicalOrigin(env)
      const delivery = await sendAgentMessage(
        env,
        {
          fromAgent: 'mupot-flights',
          fromMember: auth.memberId as string,
          toAgent: flight.agent,
          kind: 'request',
          requestId: `flight.${flight.id}`,
          body: JSON.stringify({
            version: 'flight.dispatch/v1',
            flight_id: flight.id,
            goal: flight.goal,
            done_when: meta.done_when,
            task_ids: meta.task_ids,
            squad_ids: meta.squad_ids,
            budget_micro_usd: flight.budget_micro_usd,
            ...(flightOrigin.ok ? { mcp_endpoint: mcpEndpoint(flightOrigin.origin) } : {}),
            land_with: 'flight_land',
          }),
          ...(projectId ? { projectId } : {}),
        },
        {
          system: true,
          reason: 'flight_dispatch delivers to the flight\'s own bound agent, which the caller already had to be',
        },
        {
          // The sender is synthetic ('mupot-flights') and is not a member of any
          // project, so the primitive's sender/recipient membership check would
          // refuse every project-attributed flight. Authorization already happened
          // upstream in this tool and is stricter than what the check would do:
          // hasProjectWriteForSquads() gated the project, and agent_squad_not_in_flight
          // guarantees the recipient's squad is one of the flight's squads. Project
          // existence and archived-status are still enforced inside the primitive.
          systemProjectAttribution: true,
        },
      )

      // A flight nobody was told about must not be left looking live. Failing it
      // here keeps `running` meaning "an agent has this", which is the property the
      // phantom flights lost.
      if (!delivery.ok) {
        await failFlight(env, flight.id, `dispatch_delivery_failed:${delivery.reason}`)
        return fail(503, 'flight_dispatch_delivery_failed', {
          flight_id: flight.id,
          reason: delivery.reason,
        })
      }

      const dispatched = await getFlight(env, preflight.id)
      return done({ flight: flightWithParsedMeta(dispatched ?? flight, meta), preflight, delivered: true, budget_uncapped: budgetUncapped })
    }

    return done({ flight: flightWithParsedMeta(flight, meta), preflight, delivered: false, budget_uncapped: budgetUncapped })
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
  args: '{ flight_id: string, cost_micro_usd: number, score?: number, note?: string, reason?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      flight_id: STRING_SCHEMA,
      cost_micro_usd: OPTIONAL_NUMBER_SCHEMA,
      score: OPTIONAL_NUMBER_SCHEMA,
      note: STRING_SCHEMA,
      reason: STRING_SCHEMA,
    },
    required: ['flight_id', 'cost_micro_usd'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (!auth.boundAgentId) return fail(409, 'agent_binding_required')
    const boundAgent = await loadAgent(env, auth.boundAgentId)
    if (!boundAgent) return fail(409, 'agent_binding_invalid')
    if (boundAgent.status !== 'active') return fail(409, 'agent_binding_inactive')

    const flightRef = str(args.flight_id)
    const costMicroUsd = args.cost_micro_usd
    const score = args.score
    if (!flightRef || !Number.isSafeInteger(costMicroUsd) || (costMicroUsd as number) < 0) {
      return fail(400, 'invalid_args')
    }
    if (score !== undefined && (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1)) {
      return fail(400, 'invalid_flight_score')
    }

    const { resolveFlightEntity } = await import('../lib/entity-resolver')
    const flightRes = await resolveFlightEntity(env, flightRef)
    if (!flightRes.ok) {
      if (flightRes.reason === 'ambiguous') {
        return fail(409, 'ambiguous_flight_id', { candidates: flightRes.candidates })
      }
      return fail(404, 'flight_not_found')
    }
    const flight = flightRes.entity
    if (flight.agent !== auth.boundAgentId) return fail(404, 'flight_not_found')
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

    const landing = await landGovernedFlight(env, flight.id, {
      cost_micro_usd: costMicroUsd as number,
      score: score as number | undefined,
      expected_agent: auth.boundAgentId,
      agent_id: flight.agent,
      meta,
      actor: { kind: 'agent', id: auth.boundAgentId },
    })
    // Only a refused TRANSITION is a failed land (#916). A missing receipt means the
    // flight is already landed; answering 409 there tells the agent to retry something
    // that already succeeded, and the retry then returns flight_not_in_air — which reads
    // as a completely different bug. Report the landing, log the receipt gap.
    if (!landing.transitioned) {
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
    if (!landing.receipt) {
      console.error('flight landed without a receipt', { flight_id: landed.id })
    }
    await deliverFlightLandedEvent(env, landed.id)
    return done({ flight: flightWithParsedMeta(landed, meta), receipt: landing.receipt })
  },
}

const toolFlightReapStalled: ToolSpec = {
  name: 'flight_reap_stalled',
  scope: 'squad:lead / org:admin / flight:agent',
  min: 'member',
  args: '{ flight_id: string, reason: string }',
  inputSchema: {
    type: 'object',
    properties: {
      flight_id: STRING_SCHEMA,
      reason: STRING_SCHEMA,
    },
    required: ['flight_id', 'reason'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const flightRef = str(args.flight_id)
    const reason = str(args.reason)
    if (!flightRef || !reason) return fail(400, 'invalid_args')

    const { resolveFlightEntity } = await import('../lib/entity-resolver')
    const flightRes = await resolveFlightEntity(env, flightRef)
    if (!flightRes.ok) {
      if (flightRes.reason === 'ambiguous') {
        return fail(409, 'ambiguous_flight_id', { candidates: flightRes.candidates })
      }
      return fail(404, 'flight_not_found')
    }
    const flight = flightRes.entity

    const { reapStalledFlight } = await import('../flight/watchdog')
    const grants = auth.capabilities ?? []
    const isOrgAdmin = hasCapability(grants, 'org', null, 'admin')
    const leadSquadIds = grants
      .filter((c) => c.scope_type === 'squad' && (c.capability === 'lead' || c.capability === 'admin') && typeof c.scope_id === 'string')
      .map((c) => c.scope_id as string)

    const actorId = auth.boundAgentId ?? auth.memberId ?? auth.userId ?? 'unknown-actor'
    const actor = auth.boundAgentId
      ? { kind: 'agent' as const, id: actorId }
      : { kind: 'member' as const, id: actorId }

    const result = await reapStalledFlight(
      env,
      flight.id,
      { actor, isOrgAdmin, leadSquadIds },
      reason,
    )

    if (!result.transitioned) {
      if (result.error === 'cannot_reap_waiting_gate_must_escalate') {
        return fail(409, 'cannot_reap_waiting_gate_must_escalate')
      }
      if (result.error === 'flight_not_stalled') {
        return fail(409, 'flight_not_stalled')
      }
      if (result.error === 'flight_already_terminal') {
        return fail(409, 'flight_already_terminal')
      }
      if (result.error === 'forbidden_insufficient_reap_capability') {
        return fail(403, 'forbidden', { need: 'squad:lead or org:admin', scope: 'flight' })
      }
      return fail(409, result.error ?? 'flight_reap_failed')
    }

    return done({
      reaped: true,
      flight_id: result.flight_id,
      previous_status: result.previous_status,
      age_ms: result.age_ms,
      receipt: result.receipt,
    })
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

// remember — write to the MEMBER's OWN or CONTINUUM memory scope. cap: authenticated member.
const toolRemember: ToolSpec = {
  name: 'remember',
  scope: 'self / continuum',
  min: 'authenticated',
  args: '{ text: string, concepts?: string[], continuum?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      text: STRING_SCHEMA,
      concepts: OPTIONAL_STRING_ARRAY_SCHEMA,
      continuum: {
        type: 'string',
        description: 'Optional agent continuum name (e.g. "river", "kasra"). When provided, memory is shared across all concurrent bodies of this continuum.',
      },
    },
    required: ['text'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const text = str(args.text)
    if (!text) return fail(400, 'invalid_args', 'text required')

    const concepts = readConcepts(args.concepts)
    if (concepts && !Array.isArray(concepts)) return concepts

    const continuum = str(args.continuum) || null
    const principalId = auth.memberId || auth.boundAgentId || auth.userId
    if (!principalId) return fail(401, 'unauthenticated', 'no valid member or agent identity')

    const scope = memberMemoryScope(principalId, continuum)
    try {
      const id = await createMemory(env).remember(scope, text, concepts)
      return done({ engram_id: id, scope, continuum: continuum ? extractContinuumName(continuum) : undefined })
    } catch (err: any) {
      if (err?.name === 'MemoryError') {
        return fail(err.status, err.code, err.message)
      }
      return fail(500, 'memory_operation_failed', err instanceof Error ? err.message : String(err))
    }
  },
}

// recall — read from the MEMBER's OWN or CONTINUUM memory scope. cap: authenticated.
const toolRecall: ToolSpec = {
  name: 'recall',
  scope: 'self / continuum',
  min: 'authenticated',
  args: '{ query: string, limit?: number, continuum?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      query: STRING_SCHEMA,
      limit: OPTIONAL_NUMBER_SCHEMA,
      continuum: {
        type: 'string',
        description: 'Optional agent continuum name (e.g. "river", "kasra") to recall shared continuum memory across bodies.',
      },
    },
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

    const continuum = str(args.continuum) || null
    const principalId = auth.memberId || auth.boundAgentId || auth.userId
    if (!principalId) return fail(401, 'unauthenticated', 'no valid member or agent identity')

    const scope = memberMemoryScope(principalId, continuum)
    try {
      const hits = await createMemory(env).recall(scope, query, limit)
      return done({ hits, scope, continuum: continuum ? extractContinuumName(continuum) : undefined })
    } catch (err: any) {
      if (err?.name === 'MemoryError') {
        return fail(err.status, err.code, err.message)
      }
      return fail(500, 'memory_operation_failed', err instanceof Error ? err.message : String(err))
    }
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
      isOrgOwnerAdmin(auth),
    )
    if (!squadRes.ok) return squadRes

    const scope = squadMemoryScope(squadRes.squad.id)
    try {
      const id = await createMemory(env).remember(scope, text, concepts)
      return done({ engram_id: id, squad_id: squadRes.squad.id, scope })
    } catch (err: any) {
      if (err?.name === 'MemoryError') {
        return fail(err.status, err.code, err.message)
      }
      return fail(500, 'memory_operation_failed', err instanceof Error ? err.message : String(err))
    }
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
      isOrgOwnerAdmin(auth),
    )
    if (!squadRes.ok) return squadRes

    const scope = squadMemoryScope(squadRes.squad.id)
    try {
      const hits = await createMemory(env).recall(scope, query, limit)
      return done({ squad_id: squadRes.squad.id, scope, hits })
    } catch (err: any) {
      if (err?.name === 'MemoryError') {
        return fail(err.status, err.code, err.message)
      }
      return fail(500, 'memory_operation_failed', err instanceof Error ? err.message : String(err))
    }
  },
}

// project_remember — write to a PROJECT's shared memory scope. Gate is TWO-tier:
//  1. project READ (readAccess + readableProject) — existence + visibility, failing
//     closed with project_not_found (no wrong-id vs no-access oracle).
//  2. project WRITE (org-admin, or write/admin on the project via one of the caller's
//     squads) — because a project-shared engram STEERS every agent that later recalls
//     it, so contributing to it is a state mutation, NOT a read. Gating write on mere
//     read visibility let a read-linked squad poison the shared cognitive context of
//     higher-privilege participants (adversarial-gate finding, 2026-07-22). This
//     mirrors the write tier every sibling path enforces (squad_remember=member,
//     flight/task project writes=hasProjectWriteForSquads). project_recall stays on READ.
const toolProjectRemember: ToolSpec = {
  name: 'project_remember',
  scope: 'project memory',
  min: 'member',
  args: '{ project_id: string, text: string, concepts?: string[] }',
  inputSchema: {
    type: 'object',
    properties: { project_id: STRING_SCHEMA, text: STRING_SCHEMA, concepts: OPTIONAL_STRING_ARRAY_SCHEMA },
    required: ['project_id', 'text'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const projectId = str(args.project_id)
    if (!projectId) return fail(400, 'invalid_args', 'project_id required')
    const text = str(args.text)
    if (!text) return fail(400, 'invalid_args', 'text required')
    const concepts = readConcepts(args.concepts)
    if (concepts && !Array.isArray(concepts)) return concepts

    const access = readAccess(auth)
    const project = await readableProject(env, projectId, access)
    if (!project) return fail(404, 'project_not_found')
    // Write tier: org-admin bypasses; otherwise the caller needs write/admin on the
    // project via at least one of their squads. Read-only participants can recall but
    // never write — a read-linked squad must not poison what others recall.
    if (!access.workspaceAdmin && !(await anySquadHasProjectWrite(env, projectId, access.squadIds))) {
      return fail(403, 'forbidden', { need: 'project_write', scope: 'project' })
    }

    const scope = projectMemoryScope(projectId)
    try {
      const id = await createMemory(env).remember(scope, text, concepts)
      return done({ engram_id: id, project_id: projectId, scope })
    } catch (err: any) {
      if (err?.name === 'MemoryError') {
        return fail(err.status, err.code, err.message)
      }
      return fail(500, 'memory_operation_failed', err instanceof Error ? err.message : String(err))
    }
  },
}

// project_recall — read a PROJECT's shared memory scope. Same project-read gate as
// project_remember: every project participant recalls the same shared context.
const toolProjectRecall: ToolSpec = {
  name: 'project_recall',
  scope: 'project memory',
  min: 'observer',
  args: '{ project_id: string, query: string, limit?: number }',
  inputSchema: {
    type: 'object',
    properties: { project_id: STRING_SCHEMA, query: STRING_SCHEMA, limit: OPTIONAL_NUMBER_SCHEMA },
    required: ['project_id', 'query'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const projectId = str(args.project_id)
    if (!projectId) return fail(400, 'invalid_args', 'project_id required')
    const query = str(args.query)
    if (!query) return fail(400, 'invalid_args', 'query required')
    const limit = readLimit(args.limit, 5, 20)
    if (typeof limit !== 'number') return limit

    const project = await readableProject(env, projectId, readAccess(auth))
    if (!project) return fail(404, 'project_not_found')

    const scope = projectMemoryScope(projectId)
    try {
      const hits = await createMemory(env).recall(scope, query, limit)
      return done({ project_id: projectId, scope, hits })
    } catch (err: any) {
      if (err?.name === 'MemoryError') {
        return fail(err.status, err.code, err.message)
      }
      return fail(500, 'memory_operation_failed', err instanceof Error ? err.message : String(err))
    }
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

    const agentRes = await getAgent(env, agentId)
    if (!agentRes.ok) return agentRes
    const agent = agentRes.agent

    const grants = auth.capabilities ?? []
    // Workspace admin bypass matches agentsApp: an org owner/admin can wake any
    // agent in the pot without hand-granting lead on every squad first.
    const workspaceAdmin = hasWorkspaceAdmin(auth)
    if (!workspaceAdmin && !(await memberCanOnSquad(env, grants, agent.squad_id, 'lead'))) {
      return fail(403, 'forbidden', { need: 'lead', scope: 'squad' })
    }

    if (agent.status !== 'active') return fail(409, 'agent_paused')

    const reason = typeof args.reason === 'string' ? args.reason : 'member.wake'
    const context = typeof args.context === 'string' ? args.context : undefined
    const maxActions =
      typeof args.maxActions === 'number' && Number.isFinite(args.maxActions)
        ? Math.max(0, Math.floor(args.maxActions))
        : undefined

    const routed = await routeAgentWake(env, {
      agent,
      byMemberId: auth.memberId as string,
      reason,
      context,
      maxActions,
    })
    if (!routed.ok) return fail(409, 'wake_failed')
    if (routed.route === 'agent_do') return done({ agent_id: agent.id, runtime: routed.runtime })
    return done({
      agent_id: agent.id,
      route: routed.route,
      delivered: routed.delivered,
      seq: routed.seq,
      duplicate: routed.duplicate,
    })
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

    const squadRes = await getSquad(env, squadId)
    if (!squadRes.ok) return squadRes
    const squad = squadRes.squad

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
  args: '{ to: string (agent id or unique slug), body: string, kind?: "message"|"request"|"ack", request_id?: string, in_reply_to?: string, project_id?: string, seat?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      to: STRING_SCHEMA,
      body: STRING_SCHEMA,
      kind: STRING_SCHEMA,
      request_id: STRING_SCHEMA,
      in_reply_to: STRING_SCHEMA,
      project_id: STRING_SCHEMA,
      seat: STRING_SCHEMA,
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
    if (args.project_id !== undefined && typeof args.project_id !== 'string')
      return fail(400, 'invalid_args', 'project_id must be a string')
    if (args.seat !== undefined && typeof args.seat !== 'string')
      return fail(400, 'invalid_args', 'seat must be a string')

    // Gate 1 (#392): confine the send target for non-admin welded tokens (see the docstring on
    // sendToRef in src/agents/messages.ts). hasWorkspaceAdmin already handles the legacy-role
    // escape; auth.capabilities is always resolved (never undefined) for a token-authenticated
    // MCP principal, so `?? []` is a defensive fallback only.
    const res = await sendToRef(
      env,
      {
        fromAgent,
        fromMember: auth.memberId as string,
        toRef: to,
        body,
        kind: args.kind as 'message' | 'request' | 'ack' | undefined,
        requestId: typeof args.request_id === 'string' ? args.request_id : undefined,
        inReplyTo: typeof args.in_reply_to === 'string' ? args.in_reply_to : undefined,
        projectId: typeof args.project_id === 'string' ? args.project_id : undefined,
        targetSeat: typeof args.seat === 'string' && args.seat.trim().length > 0 ? args.seat.trim() : undefined,
      },
      { isAdmin: hasWorkspaceAdmin(auth), grants: auth.capabilities ?? [] },
    )
    if (!res.ok) {
      if (res.reason === 'db_error') return fail(500, res.reason) // no raw DB string to caller
      const status =
        res.reason === 'recipient_not_found' ||
        res.reason === 'project_not_found' ||
        res.reason === 'send_target_not_visible'
          ? 404
          : res.reason === 'project_access_denied'
            ? 403
          : res.reason === 'target_agent_inactive' ||
              res.reason === 'recipient_ambiguous' ||
              res.reason === 'request_id_conflict' ||
              res.reason === 'inbox_full' ||
              res.reason === 'project_archived'
            ? 409
            : 400
      return fail(status, res.reason, res.detail)
    }
    return done({
      id: res.id,
      seq: res.seq,
      duplicate: res.duplicate,
      to: res.toAgent,
      project_id: typeof args.project_id === 'string' ? args.project_id : null,
      target_seat: typeof args.seat === 'string' ? args.seat.trim() : null,
      body_length: res.body_length,
      checksum_sha256: res.checksum_sha256,
    })
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
      }, {
        system: true,
        reason: 'target is drawn from resolveScopedSquad(...), an already squad-scoped set (>=member) — never resolveAgentRef on attacker input',
      })
      if (res.ok) {
        deliveries.push({
          to: target.id,
          slug: target.slug,
          id: res.id,
          seq: res.seq,
          duplicate: res.duplicate,
          request_id: recipientRequestId ?? null,
          body_length: res.body_length,
          checksum_sha256: res.checksum_sha256,
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
  args: '{ limit?: number, peek?: boolean, seat?: string }',
  inputSchema: {
    type: 'object',
    properties: { limit: OPTIONAL_NUMBER_SCHEMA, peek: { type: 'boolean' }, seat: STRING_SCHEMA },
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
    if (args.seat !== undefined && typeof args.seat !== 'string')
      return fail(400, 'invalid_args', 'seat must be a string')

    const res = await readAgentInbox(env, {
      agent,
      limit,
      peek: args.peek === true,
      seat: typeof args.seat === 'string' ? args.seat.trim() : undefined,
    })
    if (!res.ok) {
      if (res.reason === 'db_error') return fail(500, res.reason) // no raw DB string to caller
      if (res.reason === 'consumer_fenced') return fail(409, res.reason)
      return fail(400, res.reason, res.detail)
    }
    return done({ messages: res.messages, remaining: res.remaining, consumed: args.peek !== true })
  },
}

// inbox_lease — read the caller's own inbox WITHOUT marking it read (#899).
//
// `inbox` can only say "delivered the whole batch" or "delivered nothing", which is why every
// harness carries a local file spool: the spool, not the pot, is where "fetched but not yet
// handled" lives. That is also where it hides — a responder that retried one oversized
// message five times over ~55 minutes on 2026-08-10 was invisible here, because in the pot
// those rows read simply as "read".
//
// This hands rows out under a visibility lease and leaves read_at alone. The caller acks what
// it handled with inbox_ack; anything it did not ack comes back when the lease expires. After
// MAX_DELIVERY_ATTEMPTS hand-outs a message is dead-lettered — it stops being leased (so the
// queue behind it drains) and shows up in inbox_dead_letters.
//
// Self-scoped and fenced exactly like `inbox`: the agent id is auth.boundAgentId, never an
// argument, and an agent fenced to signed_only refuses the bearer caller.
const toolInboxLease: ToolSpec = {
  name: 'inbox_lease',
  scope: 'self (the caller agent leases from its own inbox)',
  min: 'authenticated',
  args: '{ limit?: number, lease_seconds?: number, seat?: string }',
  inputSchema: {
    type: 'object',
    properties: { limit: OPTIONAL_NUMBER_SCHEMA, lease_seconds: OPTIONAL_NUMBER_SCHEMA, seat: STRING_SCHEMA },
    required: [],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const agent = auth.boundAgentId
    if (!agent) return fail(403, 'not_agent_bound', 'inbox_lease requires an agent-bound token (member_tokens.agent_id)')
    let limit: number | undefined
    if (args.limit !== undefined) {
      if (typeof args.limit !== 'number' || !Number.isFinite(args.limit))
        return fail(400, 'invalid_args', 'limit must be a number')
      limit = args.limit
    }
    let leaseSeconds: number | undefined
    if (args.lease_seconds !== undefined) {
      if (typeof args.lease_seconds !== 'number' || !Number.isFinite(args.lease_seconds))
        return fail(400, 'invalid_args', 'lease_seconds must be a number')
      leaseSeconds = args.lease_seconds
    }
    if (args.seat !== undefined && typeof args.seat !== 'string')
      return fail(400, 'invalid_args', 'seat must be a string')

    const res = await leaseAgentInbox(env, {
      agent,
      limit,
      leaseSeconds,
      seat: typeof args.seat === 'string' ? args.seat.trim() : undefined,
    })
    if (!res.ok) {
      if (res.reason === 'db_error') return fail(500, res.reason) // no raw DB string to caller
      if (res.reason === 'consumer_fenced') return fail(409, res.reason)
      return fail(400, res.reason, res.detail)
    }
    return done({
      messages: res.messages,
      remaining: res.remaining,
      dead_lettered: res.dead_lettered,
      lease_seconds: res.lease_seconds,
      max_lease_seconds: MAX_LEASE_SECONDS,
      default_lease_seconds: DEFAULT_LEASE_SECONDS,
      max_delivery_attempts: MAX_DELIVERY_ATTEMPTS,
      consumed: false,
    })
  },
}

// inbox_ack — mark the messages the caller ACTUALLY handled as read (#899).
//
// Per message, so a poison message at the head of the queue no longer buries everything
// behind it. Idempotent: re-acking an already-read id is success, not an error, because the
// alternative is every caller re-implementing the retry bookkeeping this tool exists to
// remove. Ids that are not this agent's are refused without saying whether they exist.
const toolInboxAck: ToolSpec = {
  name: 'inbox_ack',
  scope: 'self (the caller agent acks messages addressed to itself)',
  min: 'authenticated',
  args: '{ ids: string[] }',
  inputSchema: {
    type: 'object',
    properties: { ids: OPTIONAL_STRING_ARRAY_SCHEMA },
    required: ['ids'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const agent = auth.boundAgentId
    if (!agent) return fail(403, 'not_agent_bound', 'inbox_ack requires an agent-bound token (member_tokens.agent_id)')
    if (!Array.isArray(args.ids) || args.ids.some((id) => typeof id !== 'string'))
      return fail(400, 'invalid_args', 'ids must be an array of strings')

    const res = await ackAgentMessages(env, { agent, ids: args.ids as string[] })
    if (!res.ok) {
      if (res.reason === 'db_error') return fail(500, res.reason)
      if (res.reason === 'consumer_fenced') return fail(409, res.reason)
      return fail(400, res.reason, res.detail)
    }
    return done({ acked: res.acked, already_read: res.already_read, refused: res.refused })
  },
}

// inbox_dead_letters — the stuck-seat fact, in the pot (#899).
//
// Poison-message parking used to happen in a local failed/ directory nobody inspects. Two
// scopes, deliberately:
//   - default, self: the caller's own parked messages, bodies included, fenced like `inbox`.
//   - scope:"pot" (org admin): counts and ages per agent, NO bodies. An operator needs to
//     know WHICH seat is stuck; that question does not require minting a new
//     admin-reads-every-agent's-messages capability, so it does not get one.
const toolInboxDeadLetters: ToolSpec = {
  name: 'inbox_dead_letters',
  scope: 'self by default; scope:"pot" is org-admin metadata across every inbox',
  min: 'authenticated',
  args: '{ limit?: number, scope?: "self"|"pot" }',
  inputSchema: {
    type: 'object',
    properties: { limit: OPTIONAL_NUMBER_SCHEMA, scope: STRING_SCHEMA },
    required: [],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (args.scope !== undefined && args.scope !== 'self' && args.scope !== 'pot')
      return fail(400, 'invalid_args', 'scope must be "self" or "pot"')
    let limit: number | undefined
    if (args.limit !== undefined) {
      if (typeof args.limit !== 'number' || !Number.isFinite(args.limit))
        return fail(400, 'invalid_args', 'limit must be a number')
      limit = args.limit
    }

    if (args.scope === 'pot') {
      if (!hasWorkspaceAdmin(auth)) return fail(403, 'forbidden', { need: 'org:admin' })
      const summary = await summarizeDeadLetters(env, limit ?? 100)
      if (!summary.ok) {
        if (summary.reason === 'db_error') return fail(500, summary.reason)
        return fail(400, summary.reason, summary.detail)
      }
      return done({ scope: 'pot', agents: summary.agents, max_delivery_attempts: MAX_DELIVERY_ATTEMPTS })
    }

    const agent = auth.boundAgentId
    if (!agent) return fail(403, 'not_agent_bound', 'inbox_dead_letters requires an agent-bound token')
    const res = await listDeadLetteredMessages(env, { agent, limit })
    if (!res.ok) {
      if (res.reason === 'db_error') return fail(500, res.reason)
      if (res.reason === 'consumer_fenced') return fail(409, res.reason)
      return fail(400, res.reason, res.detail)
    }
    return done({
      scope: 'self',
      messages: res.messages,
      total: res.total,
      max_delivery_attempts: MAX_DELIVERY_ATTEMPTS,
    })
  },
}

// inbox_fence_status — redacted self-status for cutover evidence. The fence is
// enforced in readAgentInbox, so this tool cannot bypass or consume the inbox.
const toolInboxFenceStatus: ToolSpec = {
  name: 'inbox_consumer_status',
  scope: 'self (the caller agent reads its own consumer-fence mode)',
  min: 'authenticated',
  args: '{}',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  async run(auth, env) {
    const agent = auth.boundAgentId
    if (!agent) return fail(403, 'not_agent_bound', 'inbox_fence_status requires an agent-bound token')
    const row = await env.DB.prepare(
      `SELECT mode, generation, key_fingerprint, updated_at FROM agent_inbox_fences
        WHERE tenant = ?1 AND agent_id = ?2 LIMIT 1`,
    ).bind(env.TENANT_SLUG, agent).first<{
      mode: string; generation: number; key_fingerprint: string | null; updated_at: string
    }>()
    const key = await loadActiveAgentKey(env, agent)
    const activeKeyFingerprint = key ? await agentKeyFingerprint(key.pubkey) : null
    return done({
      agent_id: agent,
      mode: row?.mode === 'signed_only' ? 'signed_only' : 'bearer_only',
      generation: row?.mode === 'signed_only' || row?.mode === 'bearer_only' ? Number(row.generation) : 0,
      key_fingerprint: row?.key_fingerprint ?? null,
      active_key_present: activeKeyFingerprint !== null,
      key_matches: row?.mode !== 'signed_only' || row.key_fingerprint === activeKeyFingerprint,
      updated_at: row?.mode === 'signed_only' || row?.mode === 'bearer_only' ? row.updated_at : null,
    })
  },
}

// inbox_fence_set — workspace-admin cutover control. signed_only blocks every
// bearer/MCP inbox consumer while retaining the registered Ed25519 Host route.
const toolInboxFenceSet: ToolSpec = {
  name: 'set_agent_inbox_consumer',
  scope: 'org (workspace admin selects the authoritative inbox transport for one agent)',
  min: 'admin',
  args: '{ agent: string, mode: "signed_only"|"bearer_only", expected_generation: number, reason: string }',
  inputSchema: {
    type: 'object',
    properties: { agent: STRING_SCHEMA, mode: STRING_SCHEMA, expected_generation: OPTIONAL_NUMBER_SCHEMA, reason: STRING_SCHEMA },
    required: ['agent', 'mode', 'expected_generation', 'reason'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (!hasWorkspaceAdmin(auth)) return fail(403, 'forbidden', { need: 'org:admin' })
    if (typeof args.agent !== 'string' || args.agent.length === 0) return fail(400, 'invalid_args', 'agent required')
    if (args.mode !== 'signed_only' && args.mode !== 'bearer_only') return fail(400, 'invalid_args', 'mode must be signed_only or bearer_only')
    if (typeof args.expected_generation !== 'number' || !Number.isInteger(args.expected_generation) || args.expected_generation < 0) {
      return fail(400, 'invalid_args', 'expected_generation must be a non-negative integer')
    }
    if (typeof args.reason !== 'string' || args.reason.trim().length < 1 || args.reason.length > 500) {
      return fail(400, 'invalid_args', 'reason must be 1-500 characters')
    }
    const resolved = await resolveAgentRef(env, args.agent)
    if (!resolved.ok) return fail(resolved.reason === 'not_found' ? 404 : 409, `agent_${resolved.reason}`)
    if (!auth.memberId) return fail(403, 'forbidden', { need: 'member identity' })
    const current = await env.DB.prepare(
      `SELECT mode, generation, key_fingerprint, updated_at FROM agent_inbox_fences
        WHERE tenant = ?1 AND agent_id = ?2 LIMIT 1`,
    ).bind(env.TENANT_SLUG, resolved.value.id).first<{
      mode: string; generation: number; key_fingerprint: string | null; updated_at: string
    }>()
    const currentGeneration = current ? Number(current.generation) : 0
    if (currentGeneration !== args.expected_generation) return fail(409, 'fence_generation_conflict')
    const key = await loadActiveAgentKey(env, resolved.value.id)
    if (args.mode === 'signed_only' && !key) return fail(409, 'active_agent_key_required')
    const keyFingerprint = args.mode === 'signed_only' && key ? await agentKeyFingerprint(key.pubkey) : null
    const now = new Date().toISOString()
    const written = await env.DB.prepare(
      `INSERT INTO agent_inbox_fences
        (tenant, agent_id, mode, generation, key_fingerprint, updated_by_member_id, updated_at, reason)
       VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7)
       ON CONFLICT(tenant, agent_id) DO UPDATE SET
         mode = excluded.mode, generation = agent_inbox_fences.generation + 1,
         key_fingerprint = excluded.key_fingerprint,
         updated_by_member_id = excluded.updated_by_member_id,
         updated_at = excluded.updated_at,
         reason = excluded.reason
       WHERE agent_inbox_fences.generation = ?8
       RETURNING mode, generation, key_fingerprint, updated_at`,
    ).bind(
      env.TENANT_SLUG, resolved.value.id, args.mode, keyFingerprint,
      auth.memberId, now, args.reason.trim(), args.expected_generation,
    ).all<{
      mode: string; generation: number; key_fingerprint: string | null; updated_at: string
    }>()
    const rows = written.results ?? []
    if (rows.length === 0) return fail(409, 'fence_generation_conflict')
    if (rows.length !== 1) return fail(500, 'fence_write_failed')
    const row = rows[0]
    return done({
      agent_id: resolved.value.id, mode: row.mode,
      generation: Number(row.generation), key_fingerprint: row.key_fingerprint, updated_at: row.updated_at,
    })
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
// is the authenticated member token, source/label/7-axis are descriptive only, and a
// rapid repeat is debounced per (tenant, memberId, seat).
const toolCheckIn: ToolSpec = {
  name: 'check_in',
  scope: 'self (member-token presence)',
  min: 'authenticated',
  args: '{ seat?: string, harness?: "cursor-ide"|"cursor-cloud"|"antigravity-cli"|"claude-code"|"prime"|"hermes"|"grok-cli"|"unknown", machine?: string, model?: string, provider?: string, effort?: "low"|"medium"|"high"|"extended-thinking-64k", flight_id?: string, source?: string, label?: string, name?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      source: STRING_SCHEMA,
      label: STRING_SCHEMA,
      name: STRING_SCHEMA,
      seat: STRING_SCHEMA,
      harness: { type: 'string', enum: [...SEVEN_AXIS_HARNESSES] },
      machine: STRING_SCHEMA,
      model: STRING_SCHEMA,
      provider: STRING_SCHEMA,
      effort: { type: 'string', enum: [...SEVEN_AXIS_EFFORTS] },
      flight_id: STRING_SCHEMA,
    },
    additionalProperties: false,
  },
  async run(auth, env, args) {
    for (const key of ['source', 'label', 'name', 'seat', 'harness', 'machine', 'model', 'provider', 'effort', 'flight_id']) {
      if (args[key] !== undefined && args[key] !== null && typeof args[key] !== 'string') {
        return fail(400, 'invalid_args', `${key} must be a string`)
      }
    }

    const id = await loadMemberIdentity(env, auth)
    if (!id) return fail(403, 'not_member_bound', 'check_in requires a member-token principal')

    const seatLabel = (str(args.seat) || str(args.name) || str(args.label) || '').trim()
    const axis = normalizeSevenAxis({
      seat: seatLabel,
      label: seatLabel || args.label,
      harness: args.harness,
      machine: args.machine,
      model: args.model,
      provider: args.provider,
      effort: args.effort,
      flight_id: args.flight_id,
    })
    const dkey = seatLabel
      ? `checkin:${env.TENANT_SLUG}:${id.memberId}:${seatLabel}`
      : `checkin:${env.TENANT_SLUG}:${id.memberId}`

    const echo = {
      ok: true as const,
      seat: seatLabel || id.displayName,
      agent: id.displayName,
      agent_id: id.boundAgentId,
      harness: axis.harness,
      machine: axis.machine,
      model: axis.model,
      provider: axis.provider,
      effort: axis.effort,
      flight_id: axis.flight_id,
    }

    try {
      if (await env.SESSIONS.get(dkey)) {
        return done({ ...echo, debounced: true })
      }
      await env.SESSIONS.put(dkey, '1', { expirationTtl: 30 })
    } catch {
      // KV unavailable — match /api/fleet/checkin and prefer recording presence.
    }

    await recordCheckin(env, id, {
      source: args.source ?? axis.harness,
      label: seatLabel || args.label,
      seat: seatLabel,
      harness: args.harness,
      machine: args.machine,
      model: args.model,
      provider: args.provider,
      effort: args.effort,
      flight_id: args.flight_id,
    })
    return done({ ...echo, debounced: false })
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
      // No agent specified → echo the member's own principal (who am I + caps + seat).
      let seatName: string | null = null
      let seats: string[] = []
      let activeSeat: Record<string, unknown> | null = null
      let seatRoster: Array<Record<string, unknown>> = []
      try {
        const presenceRows = await env.DB.prepare(
          `SELECT label, source, last_seen_at, harness, machine, model, provider, effort, flight_id
             FROM presence WHERE tenant = ?1 AND member_id = ?2 ORDER BY last_seen_at DESC, rowid DESC LIMIT 10`,
        ).bind(env.TENANT_SLUG, auth.memberId).all<{
          label: string
          source: string
          last_seen_at: string
          harness: string | null
          machine: string | null
          model: string | null
          provider: string | null
          effort: string | null
          flight_id: string | null
        }>()

        const rows = presenceRows.results ?? []
        seats = rows.map((r) => r.label).filter(Boolean)
        seatName = seats[0] ?? null
        seatRoster = rows.map((r) => ({
          seat: r.label || null,
          harness: r.harness || 'unknown',
          machine: r.machine ?? null,
          model: r.model ?? null,
          provider: r.provider ?? null,
          effort: r.effort ?? null,
          flight_id: r.flight_id ?? null,
          source: r.source,
        }))
        activeSeat = seatRoster[0] ?? null
      } catch {
        // Fail-soft: self-echo operates even without DB or in mock capability floor tests
      }

      return done({
        member_id: auth.memberId,
        email: auth.email,
        channel: auth.channel,
        tenant: auth.tenant,
        role: auth.role,
        bound_agent_id: auth.boundAgentId ?? null,
        seat_name: seatName,
        seats,
        active_seat: activeSeat,
        seat_roster: seatRoster,
        capabilities: auth.capabilities ?? [],
      })
    }

    const agent = await loadAgent(env, agentId)
    if (!agent) return fail(404, 'agent_not_found')

    // A cross-agent lookup is NOT a self-op — gate it.
    const grants = auth.capabilities ?? []
    if (!(await memberCanOnSquad(env, grants, agent.squad_id, 'observer'))) {
      return fail(403, 'forbidden', { need: 'observer', scope: 'squad' })
    }

    const presenceRows = await env.DB.prepare(
      `SELECT label, source, last_seen_at, harness, machine, model, provider, effort, flight_id
         FROM presence WHERE tenant = ?1 AND agent_id = ?2 ORDER BY last_seen_at DESC, rowid DESC LIMIT 10`,
    ).bind(env.TENANT_SLUG, agent.id).all<{
      label: string
      source: string
      last_seen_at: string
      harness: string | null
      machine: string | null
      model: string | null
      provider: string | null
      effort: string | null
      flight_id: string | null
    }>()

    const rows = presenceRows.results ?? []
    const seats = rows.map((r) => r.label).filter(Boolean)
    const latestSeat = seats[0] ?? null
    const seatRoster = rows.map((r) => ({
      seat: r.label || null,
      harness: r.harness || 'unknown',
      machine: r.machine ?? null,
      model: r.model ?? null,
      provider: r.provider ?? null,
      effort: r.effort ?? null,
      flight_id: r.flight_id ?? null,
      source: r.source,
    }))

    const stub = env.AGENT.get(env.AGENT.idFromName(agent.id))
    const res = await stub.fetch('https://agent/status')
    const runtime = await res.json<unknown>()
    return done({
      agent: {
        id: agent.id,
        name: agent.name,
        seat_name: latestSeat,
        seats,
        active_seat: seatRoster[0] ?? null,
        seat_roster: seatRoster,
        role: agent.role,
        model: agent.model,
        status: agent.status,
        squad_id: agent.squad_id,
      },
      runtime,
    })
  },
}

// fleet_agent_get — read an agent's fleet runtime and presence status.
// Closes mupot#1184: the routing predicate (fleet_agents.runtime & derived presence)
// previously had no agent-reachable read surface.
const toolFleetAgentGet: ToolSpec = {
  name: 'fleet_agent_get',
  scope: 'agent fleet runtime & presence (read-only)',
  min: 'authenticated',
  args: '{ agent_id?: string }',
  inputSchema: {
    type: 'object',
    properties: { agent_id: STRING_SCHEMA },
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const targetRef = str(args.agent_id) || auth.boundAgentId
    if (!targetRef) return fail(400, 'invalid_args', 'agent_id required when caller is not agent-bound')

    const resolved = await resolveAgentRef(env, targetRef)
    if (!resolved.ok) {
      return resolved.reason === 'ambiguous'
        ? fail(409, 'ambiguous_slug', 'slug matches multiple agents — use the id instead')
        : fail(404, 'agent_not_found')
    }
    const targetAgent = resolved.value

    const grants = auth.capabilities ?? []
    const claimGrants = auth.latentCapabilities ?? grants
    const isSelf = auth.boundAgentId === targetAgent.id
    const orgAdmin = hasCapability(claimGrants, 'org', null, 'admin')
    const onSquad = await memberCanOnSquad(env, claimGrants, targetAgent.squad_id, 'observer')

    if (!isSelf && !orgAdmin && !onSquad) {
      return fail(403, 'forbidden', { need: 'observer', scope: 'squad' })
    }

    const routeInfo = await getFleetAgentLiveness(env, targetAgent.id)
    const row = await readFleetAgentRow(env, targetAgent.id)
    const ttlSec = presenceTtlSec(env)
    const status = String(row?.status ?? 'unknown')
    const lastReportedAt = String(row?.last_reported_at ?? '')
    const derivedPresence = derivePresence(status, lastReportedAt, ttlSec, Date.now())

    return done({
      agent_id: targetAgent.id,
      agent_slug: targetAgent.slug,
      squad_id: targetAgent.squad_id,
      runtime: routeInfo.runtime,
      status: row?.status ?? null,
      last_reported_at: row?.last_reported_at ?? null,
      presence_ttl_sec: ttlSec,
      derived_presence: derivedPresence,
      live: routeInfo.live,
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
  args: '{ source?: string, seat?: string, label?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      source: STRING_SCHEMA,
      seat: STRING_SCHEMA,
      label: STRING_SCHEMA,
    },
    additionalProperties: false,
  },
  async run(auth, env, args, ctx) {
    if (auth.memberId) {
      const seatLabel = (str(args.seat) || str(args.label) || ctx?.seat || '').trim()
      const bootTouch = (async () => {
        const id = await loadMemberIdentity(env, auth)
        if (id) {
          await touchPresence(env, id, { source: args.source ?? ctx?.source, label: seatLabel })
        }
      })().catch(() => {})

      if (ctx?.waitUntil) {
        ctx.waitUntil(bootTouch)
      }
    }

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

    // THE DOOR MUST SAY WHAT IT IS (#712).
    //
    // A directory seat — every agentic harness arrives here: Claude Desktop, claude.ai,
    // Claude Code, Codex, Cursor — carries ZERO ambient authority by design (B1 ceiling).
    // boot_context reported `channel: "directory"` and `capabilities: []` and then advised
    // a next_step as if that were an ordinary session. It is not, and nothing said so.
    //
    // The owner spent SEVEN calls discovering it on 2026-08-05: `status` worked, everything
    // else returned 403, and the connector wrapper replaced mupot's actionable refusal with
    // "may have been blocked by a firewall or security service". mupot said the right thing
    // in a body nobody could see.
    //
    // So say it HERE, in the one response that always succeeds on this channel. A field
    // named `channel` is a fact; a field explaining what that fact COSTS is a map. QA-1
    // ("every refusal/unminted signal must carry the full map out — no dead ends") applied
    // to refusals but never to the successful boot that precedes them.
    const directoryNote =
      auth.channel === 'directory'
        ? {
            ambient_authority: 'none',
            why: [
              'This is the DIRECTORY channel — the public OAuth door used by agentic harnesses',
              '(Claude Desktop, claude.ai, Codex, Cursor). It carries NO standing capabilities by',
              'design: anyone with a verified Google account can reach it, so a member who holds',
              'owner or admin elsewhere does not inherit those here. Your grants still exist; they',
              'are simply not ambient on this door.',
            ].join(' '),
            you_can: [
              'status, boot_context — always',
              'connect { agent_name }, orient { agent } — for agents your member has capability on',
              'remember, recall — your own memory',
            ],
            you_cannot: [
              'create or update tasks, projects, agents, or any other write',
              'anything requiring a standing capability, regardless of what you hold elsewhere',
            ],
            to_get_write_access:
              'ask an org-admin for a WORKSPACE-channel token (mint_agent_token), and connect with that bearer. Requesting a squad grant will NOT help — this door discards grants by construction.',
          }
        : undefined

    return done({
      // principal fields (mirrors the status tool's self-echo, kept stable)
      tenant: auth.tenant,
      member_id: auth.memberId,
      channel: auth.channel,
      role: auth.role,
      capabilities: auth.capabilities ?? [],
      mcp_endpoint: mcpEndpoint(canonicalOrigin(env, ctx.origin)),
      // identity coherence (#126) — NEW field
      identity_status: identityStatus,
      bound_agent_id: auth.boundAgentId ?? null,
      next_step: nextStep,
      // Present ONLY on the directory channel — its absence is itself information.
      ...(directoryNote ? { channel_limits: directoryNote } : {}),
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

    // Same latent-grant authorization as connect (#712): orient is READ-ONLY and its
    // packet is redacted by viewSensitive below, but it required `observer` on the squad —
    // which a directory seat can never hold, because the B1 ceiling zeroes ambient
    // authority. So the operator's only door could not orient either, and "boot" was
    // impossible rather than merely limited. Authorizing a NAMED read against what the
    // member actually holds keeps ambient authority at zero.
    const grants = auth.capabilities ?? []
    const claimGrants = auth.latentCapabilities ?? grants
    const orgAdmin = hasCapability(claimGrants, 'org', null, 'admin')
    const onSquad = await memberCanOnSquad(env, claimGrants, agentRef.squad_id, 'observer')
    if (!orgAdmin && !onSquad) return fail(403, 'forbidden', { need: 'observer', scope: 'squad' })
    const callerCapability = orgAdmin ? 'admin' : 'observer+'

    // viewSensitive (#88): budget + field/trust are visible only to the agent ITSELF
    // (the weld), its squad leads, or admins — never a bare observer viewing a peer.
    // || short-circuits, so the lead query only runs when not already self/admin.
    const isSelf = auth.boundAgentId === agentRef.id
    const viewSensitive =
      orgAdmin || isSelf || (await memberCanOnSquad(env, claimGrants, agentRef.squad_id, 'lead'))

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
    //
    // AUTHORIZED AGAINST LATENT GRANTS (#712). connect is READ-ONLY — it writes nothing,
    // returns an orient packet, and redacts it unless the caller is org-admin, the agent
    // itself, or a squad lead. Gating that read behind AMBIENT capability meant a
    // directory seat could never pass, because the B1 ceiling guarantees ambient = [].
    // The result was a dead-end loop: boot_context told the operator to call connect, and
    // connect refused — on the only door the operator has. Reproduced live on the owner's
    // own claude.ai seat, which could call `status` and nothing else.
    //
    // Authorizing the NAMED claim against what the member truly holds keeps the ceiling's
    // real guarantee intact — zero ambient authority, nothing inherited silently — while
    // making one explicit, auditable, side-effect-free selection act possible. Packet
    // sensitivity is still decided separately by viewSensitive below, so a bare member
    // claiming a PEER gets exactly the redacted packet it got before.
    //
    // On every non-directory channel latentCapabilities === capabilities, so this is a
    // no-op there.
    const grants = auth.capabilities ?? []
    const claimGrants = auth.latentCapabilities ?? grants
    const orgAdmin = hasCapability(claimGrants, 'org', null, 'admin')
    const onSquad = await memberCanOnSquad(env, claimGrants, agentRef.squad_id, 'member')
    if (!orgAdmin && !onSquad) {
      // An UNBOUND directory-channel seat cannot pass this check, by design: B1 in
      // src/mcp/oauth-authorize.ts sets `capabilities = []` for channel='directory'
      // regardless of what the member actually holds, so the public OAuth door does not
      // inherit standing grants. For that seat both branches above are guaranteed false
      // and no squad grant can fix it.
      //
      // NO LONGER TRUE OF EVERY DIRECTORY SEAT (corrected 2026-08-11). mupot#906 added
      // consent-time agent binding, and resolveConsentedAgentCapabilities
      // (oauth-authorize.ts:340, applied in buildAuthContextFromProps at :470) gives a
      // CONSENTED directory session the bound agent's own capabilities, clamped to the
      // consenting human's rank. Such a seat can and does pass this check. The blanket
      // "NEVER / NO GRANT CAN FIX IT" this comment used to assert described the
      // pre-#906 door only.
      //
      // The distinction matters because this comment is load-bearing for the refusal
      // text below: it decides which door a stuck user is pointed at. Getting it wrong
      // is not free — on 2026-08-05 the previous misdirection cost four round-trips and
      // nearly produced a redundant squad grant for a member who already held org:owner
      // (mupot#678). The refusal is still correct for the unbound case, which is the
      // only case that reaches it.
      //
      // Saying "no_squad_access / need: member" here is true but actively misleading: it
      // points the reader at "request squad membership", which is the wrong action. On
      // 2026-08-05 that cost four round-trips and nearly produced a redundant grant for a
      // member who already held org:owner — the grant would have changed nothing, because
      // the directory door discards grants by construction. Name the real cause and the
      // door that works (mupot#678).
      if (auth.channel === 'directory') {
        return fail(403, 'forbidden', {
          reason: 'directory_channel_zero_capability',
          detail: [
            'This session is on the DIRECTORY channel (the public OAuth door used by ChatGPT/Claude connectors),',
            'which carries NO standing capabilities by design — a member who holds admin or owner elsewhere does',
            'not inherit those here. Requesting a squad grant will NOT fix this; the directory door discards',
            `grants by construction. Use a WORKSPACE-channel token instead: ask an admin on agent "${agentRef.slug}"'s`,
            // Render the ID, never the slug. mint_agent_token resolves through the same
            // resolveAgentRef contract as connect, so a DUPLICATED slug would come back
            // `ambiguous_slug` — turning a reference the caller had already resolved
            // unambiguously (they may have passed the id) back into a dead end, which is
            // the exact failure this refusal exists to remove. Not hypothetical: six
            // hadi/codex agent records share slugs today. (codex gate, #681.)
            `squad to run mint_agent_token { agent: "${agentRef.id}" }, then connect with that bearer.`,
          ].join(' '),
          need: 'workspace-channel token',
          scope: 'channel',
        })
      }
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
      orgAdmin || isSelf || (await memberCanOnSquad(env, claimGrants, agentRef.squad_id, 'lead'))

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

    // If the token is unbound (boundAgentId=null) and the caller is authorized on the squad,
    // persist the binding to D1 so that stateless REST clients (e.g. ChatGPT Actions)
    // retain the agent identity on subsequent tool calls.
    let durable = false
    if (auth.tokenId && !auth.boundAgentId) {
      try {
        const updateResult = await env.DB.prepare(
          'UPDATE member_tokens SET agent_id = ?1 WHERE id = ?2 AND agent_id IS NULL',
        )
          .bind(agentRef.id, auth.tokenId)
          .run()

        durable = (updateResult.meta?.changes ?? 0) > 0
      } catch {
        // If trigger prevents D1 update (e.g. agent_identity_conflict when caller is not the agent's dedicated member),
        // retain session-local claim without failing the connection.
        durable = false
      }
    }

    return done({
      connection_status: 'hot',
      claimed_agent: { id: agentRef.id, slug: agentRef.slug, name: agentRef.name },
      binding: durable ? 'durable' : 'session_local',
      next_step: 'You are now hot. Call orient {} (or rely on this packet) for your full basin-drop.',
      packet: data,
      brief: renderBrief(data),
    })
  },
}

// mupot_delivery_consumed_v1 — thread-bound dynamic delivery consumption tool (FLIGHT DELIV-03 / #1031 & #1050).
// Strictly verifies {threadId, turnId, nonce, correlation, generation} against the receiver's active turn fence.
const toolMupotDeliveryConsumedV1: ToolSpec = {
  name: 'mupot_delivery_consumed_v1',
  scope: 'thread-bound delivery turn fence consumption',
  min: 'authenticated',
  args: '{ deliveryId: string, threadId: string, turnId: string, generation: number, correlation: string, nonce: string, summary?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      deliveryId: STRING_SCHEMA,
      threadId: STRING_SCHEMA,
      turnId: STRING_SCHEMA,
      generation: { type: 'number' },
      correlation: STRING_SCHEMA,
      nonce: STRING_SCHEMA,
      summary: NULLABLE_STRING_SCHEMA,
    },
    required: ['deliveryId', 'threadId', 'turnId', 'generation', 'correlation', 'nonce'],
    additionalProperties: false,
  },
  async run(_auth, env, args) {
    const deliveryId = str(args.deliveryId)
    const threadId = str(args.threadId)
    const turnId = str(args.turnId)
    const generation = typeof args.generation === 'number' ? args.generation : Number(args.generation)
    const correlation = str(args.correlation)
    const nonce = str(args.nonce)
    const summary = typeof args.summary === 'string' ? args.summary : undefined

    if (!deliveryId || !threadId || !turnId || !correlation || !nonce || !Number.isInteger(generation)) {
      return fail(400, 'invalid_args', 'deliveryId, threadId, turnId, generation, correlation, and nonce are required')
    }

    const outcome = await consumeDeliveryTurnFence(env, {
      deliveryId,
      threadId,
      turnId,
      generation,
      correlation,
      nonce,
      summary,
    })

    if (!outcome.ok) {
      return fail(outcome.status, outcome.error, outcome.detail)
    }

    return done(outcome)
  },
}

import { createApprovalChallenge, decideApprovalChallenge, consumeApproval } from '../auth/approvals-2fa'
import {
  proposeGovernance,
  voteGovernance,
  ratifyGovernance,
  getGovernanceStatus,
} from '../governance/service'
import { runRouterTick } from '../router/engine'
import { rotateMemberToken, sweepExpiringTokensWarning } from '../auth/token-lifecycle'
import {
  checkAndReserveExecution,
  recordExecutionSpend,
  getAgentSpendStatus,
} from '../metering/service'
import { runGovernedLoopDriverTick } from '../loops/driver'

// loop_driver_tick — autonomous loop driver tick executing active loops under propose-only/founder brakes (FLIGHT-LOOP-UNHOLD)
const toolLoopDriverTick: ToolSpec = {
  name: 'loop_driver_tick',
  scope: 'execute autonomous governed loop cycles with propose-only boundaries',
  min: 'authenticated',
  args: '{ loop_id?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      loop_id: NULLABLE_STRING_SCHEMA,
    },
    additionalProperties: false,
  },
  async run(_auth, env, args) {
    const loopId = typeof args.loop_id === 'string' ? args.loop_id.trim() : undefined
    const result = await runGovernedLoopDriverTick(env, { loopId })
    return done(result)
  },
}

// execution_meter_check — check and reserve execution capacity with pre-flight budget stop (FLIGHT-METER / F8)
const toolExecutionMeterCheck: ToolSpec = {
  name: 'execution_meter_check',
  scope: 'check and reserve model execution capacity against budget limits',
  min: 'authenticated',
  args: '{ agent_id: string, estimate_micro_usd?: number, budget_cap_cents?: number, budget_cap_micro_usd?: number, budget_window?: "day" | "week" }',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: STRING_SCHEMA,
      estimate_micro_usd: { type: 'number' },
      budget_cap_cents: { type: 'number' },
      budget_cap_micro_usd: { type: 'number' },
      budget_window: { type: 'string', enum: ['day', 'week'] },
    },
    required: ['agent_id'],
    additionalProperties: false,
  },
  async run(_auth, env, args) {
    const agentId = str(args.agent_id)
    if (!agentId) return fail(400, 'invalid_args', 'agent_id is required')

    const result = await checkAndReserveExecution(env, agentId, {
      estimateMicroUsd: typeof args.estimate_micro_usd === 'number' ? args.estimate_micro_usd : undefined,
      budgetCapCents: typeof args.budget_cap_cents === 'number' ? args.budget_cap_cents : undefined,
      budgetCapMicroUsd: typeof args.budget_cap_micro_usd === 'number' ? args.budget_cap_micro_usd : undefined,
      budgetWindow: args.budget_window as any,
    })

    if (!result.ok) return fail(429, result.reason, { retryAfterSec: result.retryAfterSec })
    return done(result)
  },
}

// execution_meter_status — query unified execution spend and budget status (FLIGHT-METER / F8)
const toolExecutionMeterStatus: ToolSpec = {
  name: 'execution_meter_status',
  scope: 'inspect real-time spend and budget limits for an agent',
  min: 'authenticated',
  args: '{ agent_id: string, budget_cap_cents?: number, budget_cap_micro_usd?: number, budget_window?: "day" | "week" }',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: STRING_SCHEMA,
      budget_cap_cents: { type: 'number' },
      budget_cap_micro_usd: { type: 'number' },
      budget_window: { type: 'string', enum: ['day', 'week'] },
    },
    required: ['agent_id'],
    additionalProperties: false,
  },
  async run(_auth, env, args) {
    const agentId = str(args.agent_id)
    if (!agentId) return fail(400, 'invalid_args', 'agent_id is required')

    const status = await getAgentSpendStatus(env, agentId, {
      budgetCapCents: typeof args.budget_cap_cents === 'number' ? args.budget_cap_cents : undefined,
      budgetCapMicroUsd: typeof args.budget_cap_micro_usd === 'number' ? args.budget_cap_micro_usd : undefined,
      budgetWindow: args.budget_window as any,
    })

    return done(status)
  },
}

// token_rotate — rotates a member token and mints replacement with same permissions (FLIGHT-002)
const toolTokenRotate: ToolSpec = {
  name: 'token_rotate',
  scope: 'rotate active credential and mint replacement with automated audit',
  min: 'admin',
  args: '{ token_id: string, expiry_days?: number, reason?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      token_id: STRING_SCHEMA,
      expiry_days: { type: 'number' },
      reason: NULLABLE_STRING_SCHEMA,
    },
    required: ['token_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const tokenId = str(args.token_id)
    if (!tokenId) return fail(400, 'invalid_args', 'token_id is required')

    const rotatedBy = auth.memberId ?? auth.userId
    const expiryDays = typeof args.expiry_days === 'number' ? args.expiry_days : undefined
    const reason = typeof args.reason === 'string' ? args.reason : undefined

    const result = await rotateMemberToken(env, tokenId, {
      rotatedBy,
      expiryDays,
      reason,
    })

    if (!result.ok) return fail(400, result.error ?? 'rotation_failed')
    return done(result)
  },
}

// token_sweep_expiring — sweep and notify active credentials expiring within threshold (FLIGHT-002)
const toolTokenSweepExpiring: ToolSpec = {
  name: 'token_sweep_expiring',
  scope: 'sweep and inspect credentials expiring within warning threshold',
  min: 'admin',
  args: '{ warning_days?: number }',
  inputSchema: {
    type: 'object',
    properties: {
      warning_days: { type: 'number' },
    },
    additionalProperties: false,
  },
  async run(_auth, env, args) {
    const warningDays = typeof args.warning_days === 'number' ? args.warning_days : 7
    const result = await sweepExpiringTokensWarning(env, warningDays)
    return done(result)
  },
}

// router_tick — runs the edge-native active router matching unassigned tasks to continuum bodies (FLIGHT-ROUTER / W3)
const toolRouterTick: ToolSpec = {
  name: 'router_tick',
  scope: 'edge-native active router matching unassigned tasks to continuum bodies',
  min: 'authenticated',
  args: '{ dry_run?: boolean, squad_id?: string, limit?: number }',
  inputSchema: {
    type: 'object',
    properties: {
      dry_run: { type: 'boolean' },
      squad_id: NULLABLE_STRING_SCHEMA,
      limit: { type: 'number' },
    },
    additionalProperties: false,
  },
  async run(_auth, env, args) {
    const dryRun = args.dry_run !== false
    const squadId = typeof args.squad_id === 'string' ? args.squad_id.trim() : undefined
    const limit = typeof args.limit === 'number' ? args.limit : undefined

    const result = await runRouterTick(env, {
      dryRun,
      squadId,
      limit,
    })

    return done(result)
  },
}

// governance_propose — create constitutional resolution / governance proposal (FLIGHT-005 / mumega-com#723)
const toolGovernancePropose: ToolSpec = {
  name: 'governance_propose',
  scope: 'propose constitutional resolution or governance amendment',
  min: 'authenticated',
  args: '{ resolution_id?: string, proposal_type?: string, title: string, description: string, target_document_path?: string, target_document_hash?: string, target_document_content?: string, threshold_council_count?: number, founder_seal_required?: boolean }',
  inputSchema: {
    type: 'object',
    properties: {
      resolution_id: NULLABLE_STRING_SCHEMA,
      proposal_type: { type: 'string', enum: ['constitutional_amendment', 'policy_change', 'architectural_decision'] },
      title: STRING_SCHEMA,
      description: STRING_SCHEMA,
      target_document_path: NULLABLE_STRING_SCHEMA,
      target_document_hash: NULLABLE_STRING_SCHEMA,
      target_document_content: NULLABLE_STRING_SCHEMA,
      threshold_council_count: { type: 'number' },
      founder_seal_required: { type: 'boolean' },
    },
    required: ['title', 'description'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const title = str(args.title)
    const description = str(args.description)
    if (!title || !description) return fail(400, 'invalid_args', 'title and description are required')

    const outcome = await proposeGovernance(env, auth, {
      resolutionId: str(args.resolution_id) ?? undefined,
      proposalType: args.proposal_type as any,
      title,
      description,
      targetDocumentPath: str(args.target_document_path),
      targetDocumentHash: str(args.target_document_hash) ?? undefined,
      targetDocumentContent: typeof args.target_document_content === 'string' ? args.target_document_content : undefined,
      thresholdCouncilCount: typeof args.threshold_council_count === 'number' ? args.threshold_council_count : undefined,
      founderSealRequired: typeof args.founder_seal_required === 'boolean' ? args.founder_seal_required : undefined,
    })

    if (!outcome.ok) return fail(outcome.status, outcome.error, outcome.detail)
    return done(outcome.data)
  },
}

// governance_vote — cast one-shot terminal vote on constitutional resolution (FLIGHT-005 / mumega-com#723)
const toolGovernanceVote: ToolSpec = {
  name: 'governance_vote',
  scope: 'one-shot terminal voting on constitutional resolution',
  min: 'authenticated',
  args: '{ resolution_id: string, voter_seat: string, vote: "approve" | "reject" | "abstain", reason?: string, document_content?: string, document_hash?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      resolution_id: STRING_SCHEMA,
      voter_seat: STRING_SCHEMA,
      vote: { type: 'string', enum: ['approve', 'reject', 'abstain'] },
      reason: NULLABLE_STRING_SCHEMA,
      document_content: NULLABLE_STRING_SCHEMA,
      document_hash: NULLABLE_STRING_SCHEMA,
    },
    required: ['resolution_id', 'voter_seat', 'vote'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const resolutionId = str(args.resolution_id)
    const voterSeat = str(args.voter_seat)
    const vote = args.vote === 'approve' || args.vote === 'reject' || args.vote === 'abstain' ? args.vote : null

    if (!resolutionId || !voterSeat || !vote) {
      return fail(400, 'invalid_args', 'resolution_id, voter_seat, and vote (approve|reject|abstain) are required')
    }

    const outcome = await voteGovernance(env, auth, {
      resolutionId,
      voterSeat,
      vote,
      reason: typeof args.reason === 'string' ? args.reason : null,
      documentContentToVerify: typeof args.document_content === 'string' ? args.document_content : undefined,
      documentHashToVerify: typeof args.document_hash === 'string' ? args.document_hash : undefined,
    })

    if (!outcome.ok) return fail(outcome.status, outcome.error, outcome.detail)
    return done(outcome.data)
  },
}

// governance_ratify — ratify proposal when 2-of-4 Council + Founder Seal quorum met (FLIGHT-005 / mumega-com#723)
const toolGovernanceRatify: ToolSpec = {
  name: 'governance_ratify',
  scope: 'ratify constitutional amendment upon 2-of-4 council + founder seal',
  min: 'admin',
  args: '{ resolution_id: string, document_content?: string, document_hash?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      resolution_id: STRING_SCHEMA,
      document_content: NULLABLE_STRING_SCHEMA,
      document_hash: NULLABLE_STRING_SCHEMA,
    },
    required: ['resolution_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const resolutionId = str(args.resolution_id)
    if (!resolutionId) return fail(400, 'invalid_args', 'resolution_id is required')

    const outcome = await ratifyGovernance(env, auth, {
      resolutionId,
      documentContentToVerify: typeof args.document_content === 'string' ? args.document_content : undefined,
      documentHashToVerify: typeof args.document_hash === 'string' ? args.document_hash : undefined,
    })

    if (!outcome.ok) return fail(outcome.status, outcome.error, outcome.detail)
    return done(outcome.data)
  },
}

// governance_status — inspect resolution status, vote tallies, and ratification (FLIGHT-005 / mumega-com#723)
const toolGovernanceStatus: ToolSpec = {
  name: 'governance_status',
  scope: 'view governance resolution status and voting tallies',
  min: 'authenticated',
  args: '{ resolution_id: string }',
  inputSchema: {
    type: 'object',
    properties: {
      resolution_id: STRING_SCHEMA,
    },
    required: ['resolution_id'],
    additionalProperties: false,
  },
  async run(_auth, env, args) {
    const resolutionId = str(args.resolution_id)
    if (!resolutionId) return fail(400, 'invalid_args', 'resolution_id is required')

    const outcome = await getGovernanceStatus(env, resolutionId)
    if (!outcome.ok) return fail(outcome.status, outcome.error, outcome.detail)
    return done(outcome.data)
  },
}

// approval_challenge_create — creates an action-hash-bound 2FA/approval challenge for high-impact actions (FLIGHT-004 / mumega-com#725)
const toolApprovalChallengeCreate: ToolSpec = {
  name: 'approval_challenge_create',
  scope: 'native in-pot 2fa and action-hash approval challenge creation',
  min: 'authenticated',
  args: '{ action_type: string, payload: object | string, target_id?: string, expires_in_sec?: number }',
  inputSchema: {
    type: 'object',
    properties: {
      action_type: STRING_SCHEMA,
      payload: { anyOf: [{ type: 'object' }, { type: 'string' }] },
      target_id: NULLABLE_STRING_SCHEMA,
      expires_in_sec: { type: 'number' },
    },
    required: ['action_type', 'payload'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const actionType = str(args.action_type)
    const payload = args.payload as Record<string, unknown> | string
    const targetId = typeof args.target_id === 'string' ? args.target_id.trim() : null
    const expiresInSec = typeof args.expires_in_sec === 'number' ? args.expires_in_sec : undefined

    if (!actionType || !payload) {
      return fail(400, 'invalid_args', 'action_type and payload are required')
    }

    const requesterId = auth.boundAgentId ?? auth.memberId ?? auth.userId
    if (!requesterId) return fail(401, 'unauthenticated')

    const challenge = await createApprovalChallenge(env, {
      actionType,
      payload,
      targetId,
      requesterId,
      expiresInSec,
    })

    return done(challenge)
  },
}

// approval_verify — operator/admin verdict and signature verification on a pending action challenge (FLIGHT-004 / mumega-com#725)
const toolApprovalVerify: ToolSpec = {
  name: 'approval_verify',
  scope: 'native in-pot 2fa and operator action challenge verdict',
  min: 'admin',
  args: '{ challenge_id: string, nonce: string, verdict: "approved" | "rejected", verification_method?: string, signature?: string, note?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      challenge_id: STRING_SCHEMA,
      nonce: STRING_SCHEMA,
      verdict: { type: 'string', enum: ['approved', 'rejected'] },
      verification_method: NULLABLE_STRING_SCHEMA,
      signature: NULLABLE_STRING_SCHEMA,
      note: NULLABLE_STRING_SCHEMA,
    },
    required: ['challenge_id', 'nonce', 'verdict'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const challengeId = str(args.challenge_id)
    const nonce = str(args.nonce)
    const verdict = args.verdict === 'approved' ? 'approved' : args.verdict === 'rejected' ? 'rejected' : null
    const verificationMethod = typeof args.verification_method === 'string' ? args.verification_method : undefined
    const signature = typeof args.signature === 'string' ? args.signature : undefined
    const note = typeof args.note === 'string' ? args.note : undefined

    if (!challengeId || !nonce || !verdict) {
      return fail(400, 'invalid_args', 'challenge_id, nonce, and verdict (approved|rejected) are required')
    }

    const outcome = await decideApprovalChallenge(env, auth, {
      challengeId,
      nonce,
      verdict,
      verificationMethod,
      signature,
      note,
    })

    if (!outcome.ok) {
      return fail(outcome.status, outcome.error, outcome.detail)
    }

    return done(outcome)
  },
}

// approval_consume — consumes an approved challenge exactly once before executing high-impact action (FLIGHT-004 / mumega-com#725)
const toolApprovalConsume: ToolSpec = {
  name: 'approval_consume',
  scope: 'consume single-use approved challenge token against action hash',
  min: 'authenticated',
  args: '{ challenge_id: string, nonce: string, action_type: string, payload: object | string, target_id?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      challenge_id: STRING_SCHEMA,
      nonce: STRING_SCHEMA,
      action_type: STRING_SCHEMA,
      payload: { anyOf: [{ type: 'object' }, { type: 'string' }] },
      target_id: NULLABLE_STRING_SCHEMA,
    },
    required: ['challenge_id', 'nonce', 'action_type', 'payload'],
    additionalProperties: false,
  },
  async run(_auth, env, args) {
    const challengeId = str(args.challenge_id)
    const nonce = str(args.nonce)
    const actionType = str(args.action_type)
    const payload = args.payload as Record<string, unknown> | string
    const targetId = typeof args.target_id === 'string' ? args.target_id.trim() : null

    if (!challengeId || !nonce || !actionType || !payload) {
      return fail(400, 'invalid_args', 'challenge_id, nonce, action_type, and payload are required')
    }

    const outcome = await consumeApproval(env, {
      challengeId,
      nonce,
      actionType,
      payload,
      targetId,
    })

    if (!outcome.ok) {
      return fail(outcome.status, outcome.error, outcome.detail)
    }

    return done(outcome)
  },
}

// Exported for the capability-floor test (#183) — the registry-completeness
// assertion + the dispatch wiring proof read these directly.
export const TOOLS: ToolSpec[] = [
  toolFlightDispatch,
  toolFlightGet,
  toolFlightList,
  toolFlightLand,
  toolFlightReapStalled,
  toolTaskCreate,
  toolTaskList,
  toolTaskBoard,
  toolKanbanBoard,
  toolTaskUpdate,
  toolTaskVerdict,
  toolTaskVerdictReverse,
  toolTaskDispatch,
  toolTaskReportResult,
  toolTaskIntakeAudit,
  toolRemember,
  toolRecall,
  toolSquadRemember,
  toolSquadRecall,
  toolProjectRemember,
  toolProjectRecall,
  toolWakeAgent,
  toolSquadMessage,
  toolSend,
  toolBroadcast,
  toolInbox,
  toolInboxLease,
  toolInboxAck,
  toolInboxDeadLetters,
  toolInboxFenceStatus,
  toolInboxFenceSet,
  toolPeers,
  toolCheckIn,
  toolStatus,
  toolFleetAgentGet,
  toolBootContext,
  toolOrient,
  toolConnect,
  toolMupotDeliveryConsumedV1,
  toolApprovalChallengeCreate,
  toolApprovalVerify,
  toolApprovalConsume,
  toolGovernancePropose,
  toolGovernanceVote,
  toolGovernanceRatify,
  toolGovernanceStatus,
  toolRouterTick,
  toolTokenRotate,
  toolTokenSweepExpiring,
  toolExecutionMeterCheck,
  toolExecutionMeterStatus,
  toolLoopDriverTick,
  ...AGENT_CONNECTION_TOOLS,
  ...PROJECT_TOOLS,
  ...PROVISION_TOOLS,
  ...BOOTSTRAP_TOOLS,
  ...CREDENTIAL_CLAIM_TOOLS,
  ...ADDON_TOOLS,
  ...GATE_GRANT_TOOLS,
  ...LOOP_TOOLS,
  ...SECRET_ENV_TOOLS,
  ...PRESENCE_TOOLS,
  ...WORKFLOW_CIRCUIT_TOOLS,
  ...ROUTINE_TOOLS,
  ...RUNNER_TOOLS,
  ...FLIGHT_SPINE_TOOLS,
  ...CURSOR_TOOLS,
  ...ATHENA_TOOLS,
  ...POT_TOOLS,
  toolSupabaseConnect,
  toolSupabaseSchema,
  toolSupabaseQuery,
  toolSupabaseMutate,
  toolMintBody,
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
    // A property typed `object` must be a plain object — reject arrays/scalars at the
    // boundary so the schema is actually enforced (value===null already `continue`d
    // above). Without this, `{type:'object'}` params (e.g. create_agent.death_condition)
    // silently accepted strings/arrays and pushed the shape check onto every reader.
    if (prop.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
      return `field ${key} must be an object`
    }
  }
  return null
}

export async function invokeTool(
  auth: AuthContext,
  env: Env,
  toolName: unknown,
  argsValue: unknown,
  originOrCtx: string | Partial<ToolCtx> = '',
): Promise<ToolOutcome & { tool?: string }> {
  const ctx: ToolCtx = typeof originOrCtx === 'string'
    ? { origin: originOrCtx }
    : {
        origin: originOrCtx?.origin ?? '',
        waitUntil: originOrCtx?.waitUntil,
        seat: originOrCtx?.seat,
        source: originOrCtx?.source,
      }

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

  // AAGATE (#183) — deny-by-default capability FLOOR. `spec.min` is enforced HERE,
  // centrally, BEFORE argument validation. A tool that declares a capability minimum
  // can no longer fail-open if its handler omits the inline scope check: a caller
  // holding `min` on NO scope is rejected at the chokepoint. The handler still runs
  // its precise per-scope check (the floor is scope-agnostic — see capability.ts).
  // Check authz FIRST so unauthorized callers get 403 regardless of body validity.
  if (spec.min !== 'authenticated' && !hasWorkspaceAdmin(auth) && !holdsCapabilityFloor(auth, spec.min)) {
    return { ...fail(403, 'forbidden', { need: spec.min }), tool: spec.name }
  }

  const schemaError = validateArgs(spec.inputSchema, args)
  if (schemaError) return { ...fail(400, 'invalid_args', schemaError), tool: spec.name }

  // A handler that THROWS (rather than returning fail()) must not escape as an
  // opaque 500 / unhandled rejection — convert it to a structured outcome so the
  // MCP client always gets a JSON-RPC error. `receipt_failed` (#186 write-receipt
  // guard) is the expected case; surface its code + safe message. For anything else
  // return a generic internal_error — never echo an arbitrary throw (leak guard).
  let outcome: ToolOutcome
  try {
    outcome = await spec.run(auth, env, args, ctx)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (err instanceof TaskSelfGateError) {
      return { ...fail(409, 'self_gate_conflict', err.message), tool: spec.name }
    }
    if (msg.startsWith('receipt_failed')) {
      return { ...fail(500, 'receipt_failed', msg), tool: spec.name }
    }
    console.error('MCP tool execution threw unhandled error:', err)
    return { ...fail(500, 'internal_error'), tool: spec.name }
  }

  if (outcome.ok && auth.memberId && spec.name !== 'check_in' && spec.name !== 'boot_context') {
    // Zero-Touch Living Presence: automatically bump presence for active tool callers.
    const touchPromise = (async () => {
      const id = await loadMemberIdentity(env, auth)
      if (id) {
        let seat = ctx.seat
        if (!seat && auth.tokenId && env.DB) {
          try {
            const tokRow = await env.DB.prepare(
              `SELECT label FROM member_tokens WHERE id = ?1 AND tenant = ?2`,
            ).bind(auth.tokenId, env.TENANT_SLUG).first<{ label: string | null }>()
            if (tokRow?.label) seat = tokRow.label
          } catch {
            // Fail-soft
          }
        }
        await touchPresence(env, id, { source: ctx.source, label: seat })
      }
    })().catch(() => {})

    if (ctx.waitUntil) {
      ctx.waitUntil(touchPromise)
    }
  }

  return { ...outcome, tool: spec.name }
}

function safeWaitUntil(c: import('hono').Context<AppEnv>): ((p: Promise<unknown>) => void) | undefined {
  try {
    const ctx = c.executionCtx
    return ctx ? (p: Promise<unknown>) => ctx.waitUntil(p) : undefined
  } catch {
    return undefined
  }
}

async function handleJsonRpc(c: import('hono').Context<AppEnv>, body: JsonRpcRequest): Promise<Response> {
  const id = body.id ?? null
  const method = typeof body.method === 'string' ? body.method : ''

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: `mupot-${c.env.TENANT_SLUG}`, version: MUPOT_PUBLIC_API_VERSION },
      instructions: MUPOT_MCP_INITIALIZE_INSTRUCTIONS,
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
    const ctx: ToolCtx = {
      origin: new URL(c.req.url).origin,
      waitUntil: safeWaitUntil(c),
      seat: c.req.header('x-mupot-seat'),
      source: c.req.header('x-mupot-source'),
    }
    const outcome = await invokeTool(auth, c.env, params.name, params.arguments, ctx)
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

  const ctx: ToolCtx = {
    origin: new URL(c.req.url).origin,
    waitUntil: safeWaitUntil(c),
    seat: c.req.header('x-mupot-seat'),
    source: c.req.header('x-mupot-source'),
  }
  const outcome = await invokeTool(auth, c.env, body.tool, body.args, ctx)

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

  const ctx: ToolCtx = {
    origin: new URL(c.req.url).origin,
    waitUntil: safeWaitUntil(c),
    seat: c.req.header('x-mupot-seat'),
    source: c.req.header('x-mupot-source'),
  }
  const outcome = await invokeTool(auth, c.env, c.req.param('tool'), args, ctx)
  if (outcome.ok) return c.json({ ok: true, tool: outcome.tool, result: outcome.result })
  return c.json({ ok: false, tool: outcome.tool, error: outcome.error, detail: outcome.detail }, outcome.status)
})
