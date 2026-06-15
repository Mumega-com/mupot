// mupot — the shared contract. EVERY component builds against this file.
// Changing a type here is a cross-cutting change: coordinate, don't fork.

import type {
  D1Database,
  VectorizeIndex,
  Queue,
  KVNamespace,
  R2Bucket,
  Ai,
  DurableObjectNamespace,
} from '@cloudflare/workers-types'

// ── Workflow binding type ──────────────────────────────────────────────────────
//
// @cloudflare/workers-types exports `Workflow` as a global abstract class (not
// as a named export from the module), so it cannot be used directly in an
// interface import.  We define a minimal local structural type that matches the
// subset of the Workflow<PARAMS> API this codebase uses.  This avoids importing
// 'cloudflare:workers' (unavailable in Vitest) into types.ts, and keeps the
// binding testable via a plain mock object in tests.
//
// The real binding (Workflow<TaskPipelineParams>) is structurally assignable to
// this interface — TypeScript will verify that in task-workflow.ts where it is
// consumed.
export interface WorkflowBinding<PARAMS = unknown> {
  /**
   * Create a new Workflow instance.  Returns a handle; we only need the id.
   * The full CF type also accepts `id?` and `retention?` in opts — we surface
   * only `params` because that is what the pipeline uses.
   */
  create(opts: { params: PARAMS }): Promise<{ id: string }>
  /**
   * Get a handle to an existing instance by id, for sendEvent on resume.
   */
  get(id: string): Promise<{
    sendEvent(e: { type: string; payload: unknown }): Promise<void>
    status(): Promise<unknown>
  }>
}

// ── Cloudflare bindings (must match wrangler.toml) ──
export interface Env {
  DB: D1Database
  VEC: VectorizeIndex
  BUS: Queue<BusEvent>
  SESSIONS: KVNamespace
  // OAuth 2.1 state (clients, grants, tokens) — separate lifecycle from sessions.
  // The @cloudflare/workers-oauth-provider library reads/writes this KV namespace.
  // Declared in [[kv_namespaces]] binding="OAUTH_KV" in wrangler.toml.
  OAUTH_KV: KVNamespace
  BLOBS: R2Bucket
  AI: Ai
  AGENT: DurableObjectNamespace
  SQUAD: DurableObjectNamespace
  // Durable task pipeline (issue #7, migration 0012).  Optional: only present
  // when the [[workflows]] binding is declared in wrangler.toml.  Code that
  // calls the binding should guard `if (env.TASK_WORKFLOW)` or use the
  // startTaskPipeline helper which handles the absent-binding case gracefully.
  TASK_WORKFLOW?: WorkflowBinding<import('./workflows/pipeline').TaskPipelineParams>
  // vars
  TENANT_SLUG: string
  BRAND: string
  OAUTH_PROVIDER: 'google' | 'telegram'
  // The pot's canonical public origin (e.g. https://agents.digid.ca). When set, the
  // orient brief pins its MCP endpoint to THIS instead of echoing the request Host
  // header (which is client-influenceable and renders into a DIRECTIVE surface). #88.
  PUBLIC_ORIGIN?: string
  // SSO handoff (#262): mumega is the verified-identity issuer; this pot is a relying
  // party that ACCEPTS a signed verified-email claim and mints its OWN session — while
  // keeping its own Google OAuth (additive). We hold ONLY the issuer's Ed25519 PUBLIC
  // key (a var, not a secret — public material). No shared secret = sovereignty.
  MUPOT_HANDOFF_PUBLIC_KEY?: string
  // fleet window: SOS bus bridge REST
  BUS_URL?: string
  // fleet scoping (Flock #43): which bus project this pot's fleet addresses, and
  // which ops agent executes control requests. NO code default — the resolvers
  // fail closed (null → refuse). Each pot sets these explicitly in its wrangler
  // vars (company: sos/kasra; tenant: its own project + operator agent).
  FLEET_PROJECT?: string
  FLEET_OPS_AGENT?: string
  // secrets (present at runtime only)
  OAUTH_CLIENT_ID?: string
  OAUTH_CLIENT_SECRET?: string
  // OAuth 2.1 Google IdP secrets — set via `wrangler secret put`, never in .toml.
  // Deploy prerequisites: npx wrangler secret put GOOGLE_CLIENT_ID
  //                       npx wrangler secret put GOOGLE_CLIENT_SECRET
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  BUS_TOKEN?: string
  GITHUB_TOKEN?: string // outbound: tasks↔issues mirror (fine-grained PAT or App install token)
  GITHUB_REPO?: string // "owner/repo" the pot weaves to (e.g. "Digidinc/Digid")
  GITHUB_WEBHOOK_SECRET?: string // inbound: verifies GitHub webhook (x-hub-signature-256)
  GITHUB_INBOUND_SQUAD_ID?: string // optional: squad that GitHub work-units land on
  AI_GATEWAY_TOKEN?: string
  IM_WEBHOOK_SECRET?: string // shared secret for the IM webhook (Telegram secret_token)
  HERMES_RELAY_SECRET?: string // shared secret for the Hermes → mupot channel relay
  // execution meter caps (env override; meter.ts defaults apply when absent)
  EXEC_MAX_DISPATCH_DAY?: string // max execute-mode dispatches per agent per UTC day
  EXEC_MAX_TOKENS_DAY?: string   // max tokens an agent may spend per UTC day
  // GHL act-channel secrets (issue #8) — set via `wrangler secret put`, NEVER in .toml.
  // All optional: absent = not_configured (fails closed, no send path opens).
  // See wrangler.toml for the operator `wrangler secret put` command block.
  GHL_API_KEY?: string           // GoHighLevel location API key (outbound send)
  GHL_LOCATION_ID?: string       // GHL location id (scopes all API calls)
  GHL_WEBHOOK_SECRET?: string    // HMAC-SHA256 secret for inbound webhook verification
  // Connector credential vault (issue #116) — AES-GCM-256 master key.
  // Deploy prerequisite: `npx wrangler secret put CONNECTOR_MASTER_KEY`
  // Value: 64-char hex string (32 bytes / 256-bit, e.g. `openssl rand -hex 32`).
  // Fail-closed: if absent, resolveConnector() returns null and addConnector() throws.
  CONNECTOR_MASTER_KEY?: string
}

// ── Org domain (mirrors migrations/0001_init.sql + 0009_work_unit.sql) ──

// Work-unit enums — shared by Agent and Squad (fractal: same shape at every level).
// effort: ceiling on spend / tool-calls when the unit is in execute mode.
export type Effort = 'low' | 'standard' | 'high' | 'sprint'
// autonomy: maps to gate level — execute_with_approval auto-sets gate_owner on tasks.
export type Autonomy = 'suggest' | 'draft' | 'execute' | 'execute_with_approval'
// budget_window: rolling window for budget_cap_cents accounting.
export type BudgetWindow = 'day' | 'week'

const EFFORTS: readonly Effort[] = ['low', 'standard', 'high', 'sprint']
const AUTONOMIES: readonly Autonomy[] = ['suggest', 'draft', 'execute', 'execute_with_approval']
const BUDGET_WINDOWS: readonly BudgetWindow[] = ['day', 'week']

export function isEffort(v: unknown): v is Effort {
  return typeof v === 'string' && (EFFORTS as readonly string[]).includes(v)
}

export function isAutonomy(v: unknown): v is Autonomy {
  return typeof v === 'string' && (AUTONOMIES as readonly string[]).includes(v)
}

export function isBudgetWindow(v: unknown): v is BudgetWindow {
  return typeof v === 'string' && (BUDGET_WINDOWS as readonly string[]).includes(v)
}

export interface Department {
  id: string
  slug: string
  name: string
  created_at: string
}

export interface Squad {
  id: string
  department_id: string
  slug: string
  name: string
  charter: string | null // the squad's culture/mandate — tenant-authored
  // work-unit fields (0009_work_unit.sql)
  role: string | null           // accountability line for the squad
  okr: string | null
  kpi_target: string | null
  kpi_progress: number
  effort: Effort
  autonomy: Autonomy
  budget_cap_cents: number | null
  budget_window: BudgetWindow
  created_at: string
}

export interface Agent {
  id: string // also the DurableObject id name
  squad_id: string
  slug: string
  name: string
  role: string // tenant-defined role label
  model: string // e.g. "@cf/meta/llama-3.3" | "gemini-2.5-flash"
  status: 'active' | 'paused'
  // work-unit fields (0009_work_unit.sql)
  okr: string | null
  kpi_target: string | null
  kpi_progress: number
  effort: Effort
  autonomy: Autonomy
  budget_cap_cents: number | null
  budget_window: BudgetWindow
  created_at: string
}

export interface Membership {
  id: string
  agent_id: string
  squad_id: string
  capability: Capability // RBAC: what this agent may do in this squad
}

export type Capability = 'owner' | 'admin' | 'lead' | 'member' | 'observer'

export interface Task {
  id: string
  squad_id: string
  title: string
  body: string
  status: 'open' | 'in_progress' | 'blocked' | 'done' | 'review' | 'approved' | 'rejected'
  assignee_agent_id: string | null
  github_issue_url: string | null // tasks are mirrored to GitHub (source of truth)
  result: string | null // execution output (model answer) or a short failure note
  completed_at: string | null // ISO; set when execution finishes (done OR blocked)
  gate_owner: string | null // capability string gating the review→approved|rejected transition
  // #142 capsule keystone: a checkable success predicate (e.g. "test X passes",
  // "GET /url returns 200", "migration applied"). Required on creation; the DB
  // column carries a sentinel default for rows pre-dating this migration.
  done_when: string
  // Durable pipeline (issue #7): set when this task was started via
  // POST /api/tasks/:id/pipeline.  Null on the legacy direct-execute path.
  // Used by the verdict endpoint to best-effort resume the waiting instance.
  workflow_instance_id?: string | null
  created_at: string
  updated_at: string
}

// Append-only verdict receipt — written by POST /api/tasks/:id/verdict.
// No UPDATE or DELETE path exists (enforced in the route layer).
export interface TaskVerdict {
  id: string
  task_id: string
  verdict: 'approved' | 'rejected'
  note: string | null
  decided_by: string // agent id or member id of the principal
  decided_at: string // ISO-8601
}

// ── Auth (app-layer RBAC; AuthN delegated to the perimeter/OAuth) ──
export interface AuthContext {
  userId: string
  email: string | null
  role: 'owner' | 'admin' | 'member' // org-level role (coarse; capabilities are the fine grain)
  tenant: string // TENANT_SLUG — every request is scoped to it
  memberId?: string // set when the principal is a network member (MCP/IM), not just a web login
  channel?: ConnectionChannel // how this principal connected
  capabilities?: CapabilityGrant[] // fine-grained, per-scope; the real RBAC
  boundAgentId?: string | null // the agent this token is bound to (the weld), or null = pure human/operator
}

// ── Members & capabilities — humans are first-class network nodes ──
// One person = one Member. They may connect via several channels (their own
// workspace over MCP, IM/Telegram via Hermes, or the web dashboard) — all resolve
// to the same member_id + capabilities. "Having effect" = acting through any
// channel, gated by capability.
export interface Member {
  id: string
  email: string | null
  display_name: string
  telegram_chat_id: string | null // IM-only members reach mupot through Hermes
  status: 'active' | 'suspended'
  created_at: string
}

// 'directory' is the OAuth 2.1 door — a seat that connected via the /authorize
// flow (ChatGPT, Claude, directory listings). Kept distinct from 'dashboard' (web
// login) and 'workspace' (API key) so the operator roster and revocation-by-channel
// paths stay legible. Added in migration 0020_oauth_channel.sql.
export type ConnectionChannel = 'workspace' | 'im' | 'dashboard' | 'directory'

// A scoped, revocable token a member puts in their workspace .mcp.json (or that
// Hermes holds to act for IM members). Stored hashed, like the SOS bus model.
export interface MemberToken {
  id: string
  member_id: string
  token_hash: string
  label: string // "laptop", "hermes-gateway", ...
  channel: ConnectionChannel
  created_at: string
  revoked_at: string | null
}

export type CapabilityScopeType = 'org' | 'department' | 'squad'

// member × scope → capability. Enforced on every write path (humans AND agents).
export interface CapabilityGrant {
  member_id: string
  scope_type: CapabilityScopeType
  scope_id: string | null // null for org-wide
  capability: Capability
}

// ── Bus ──
export type BusEventType =
  | 'lead.new'
  | 'task.created'
  | 'task.updated'
  | 'task.completed' // execution succeeded (ungated) — result persisted on the task row
  | 'task.review'   // execution succeeded on a gated task — task now awaits verdict
  | 'task.blocked' // execution failed (model error/timeout) — short note persisted
  | 'task.verdict' // gate decision written — verdict + new task status in payload
  | 'agent.wake'
  | 'squad.dispatch'
  | 'org.provisioned' // a department/squad/agent/token was created in-band (payload.kind)

export interface BusEvent<T = unknown> {
  type: BusEventType
  tenant: string
  squad_id?: string
  agent_id?: string
  actor?: { kind: 'member' | 'agent'; id: string } // attribution — who caused this
  payload: T
  ts: string // ISO; set by the producer
}

// ── Wake Contract ────────────────────────────────────────────────────────────
//
// Returned by mint_agent_token alongside mcp_endpoint. Describes exactly HOW
// to fire an agent.wake event at this agent via the mupot bus HTTP surface —
// the method, URL, required headers, and the body shape to POST.
//
// This is the self-serve equivalent of manual tmux send-keys: any caller that
// holds the operator token + this contract can wake the agent without hand-wiring
// or shell access. The bus consumer already routes agent.wake → AgentDO.wake();
// this type makes the wire format explicit and machine-readable.
//
// Cross-project note (S175): today the /bus/emit endpoint is tenant-scoped —
// only tokens minted inside the same pot can emit. Cross-project wake (e.g.
// kasra@mumega waking agent:dgd.admin) requires S175 multiplex opt-in on the
// SOS bus side; that is a runtime change outside this contract's scope.
export interface WakeContract {
  // POST this URL to fire the wake event.
  emit_url: string
  // Required header: 'Authorization: Bearer <OPERATOR_TOKEN>'
  auth_header: 'Authorization'
  // The body shape to POST (JSON). agent_id and tenant are pre-filled; reason
  // is caller-supplied context (short string, optional but recommended).
  body_shape: {
    type: 'agent.wake'
    agent_id: string
    tenant: string
    squad_id: string
    // context / reason the caller fills in at call time
    payload: { reason: string; context?: string }
  }
  // Human-readable note about the wake mechanism.
  note: string
}

// ── Ports (the swappable seams; CF profile implements these) ──
export interface MemoryPort {
  remember(agentId: string, text: string, concepts?: string[]): Promise<string> // returns engram id
  recall(agentId: string, query: string, limit?: number): Promise<MemoryHit[]>
}

export interface MemoryHit {
  id: string
  text: string
  score: number
}

export interface BusPort {
  emit(event: BusEvent): Promise<void>
}

// ── Model port — connect-your-model (the brain/agents think through this) ──
// CF profile routes through AI Gateway (Anthropic/OpenAI/Google) or Workers AI,
// or a tenant-supplied key. The agent never hardcodes a provider.
export interface ModelMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ModelPort {
  chat(messages: ModelMessage[], opts?: { model?: string; maxTokens?: number }): Promise<string>
}

// key/value org settings (onboarding state, chosen model provider, brand, …).
export interface OrgSetting {
  key: string
  value: string
  updated_at: string
}

// ── Channels (microkernel: a tiny core + swappable platform adapters) ──
// The platform's scoped channel IS the squad. The CORE knows zero platform
// specifics — it only speaks this interface; each platform is a leaf adapter
// registered by key. channel↔squad and platformUser↔member live in D1.
export interface ChannelBinding {
  id: string
  platform: string // 'discord' | 'google-chat' | 'telegram'
  external_channel_id: string
  squad_id: string
  max_capability: Capability // ceiling for membership-sync grants (default 'member')
  created_at: string
}

export interface MemberIdentity {
  id: string
  member_id: string
  platform: string
  external_user_id: string // Google: email; Discord/Telegram: platform user id
}

export interface ChannelCapabilityGrant {
  id: string
  binding_id: string
  member_id: string
  squad_id: string
  capability: Capability
  created_at: string
  updated_at: string
}

// Normalized inbound message — what every adapter's parseInbound returns.
export interface InboundMessage {
  platform: string
  externalChannelId: string
  externalUserId: string
  text: string
}

// The microkernel seam. A platform adapter is a leaf plugin; the core depends
// ONLY on this interface, never on a concrete platform.
export interface ChannelAdapter {
  platform: string
  verify(req: Request, env: Env): Promise<boolean> // webhook authenticity, fail-closed
  parseInbound(req: Request, env: Env): Promise<InboundMessage | null>
  post(env: Env, externalChannelId: string, text: string): Promise<void>
  listChannelMembers(env: Env, externalChannelId: string): Promise<string[]> // external user ids
  roleCapability?(
    env: Env,
    externalChannelId: string,
    externalUserId: string,
  ): Promise<Capability | null> // platform role → capability (optional)
  // optional: own the HTTP response for platforms that reply INLINE (Discord
  // interactions: PING→PONG, slash command → {type:4}). The core passes `run` —
  // the resolve→gate→act pipeline — so the adapter can act and shape the inline
  // reply without importing the core (microkernel intact). Return null to fall
  // through to the out-of-band post() path (Telegram, Google Chat, Hermes relay).
  respond?(
    req: Request,
    env: Env,
    run: (inbound: InboundMessage) => Promise<string>,
  ): Promise<Response | null>
}

// ── Component routers register onto the root Hono app under these prefixes ──
export const ROUTES = {
  auth: '/auth',
  org: '/api/org',
  agents: '/api/agents',
  tasks: '/api/tasks',
  bus: '/api/bus',
  members: '/api/members',
  mcp: '/mcp',
  im: '/im',
  dashboard: '/',
} as const
