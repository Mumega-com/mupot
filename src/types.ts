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
  // The tenant slug that owns THIS deployment's Worker-level operator secrets/config (as
  // opposed to any per-tenant vault connector). Set once, in wrangler.toml [vars], to the
  // SAME value as TENANT_SLUG for the pot's own operator deployment (e.g. "mumega") and left
  // unset for any deployment where env-level operator creds must never be read on behalf of
  // a tenant. Absent ⇒ no env-credentials fallback runs anywhere (fail-closed). Currently
  // gates src/addons/marketing/adapters/posthog.ts's env-fallback path (#473 CONCERN-2) —
  // without this, a non-owner tenant with an internal_adapter posthog binding would read the
  // operator's own PostHog project and emit it under its own tenant's observations.
  OWNER_TENANT_SLUG?: string
  BRAND: string
  OAUTH_PROVIDER: 'google' | 'telegram'
  // Immutable git commit for the deployed build, supplied by the release deploy.
  RELEASE_SHA?: string
  // The pot's canonical public origin (e.g. https://agents.digid.ca). When set, the
  // orient brief pins its MCP endpoint to THIS instead of echoing the request Host
  // header (which is client-influenceable and renders into a DIRECTIVE surface). #88.
  PUBLIC_ORIGIN?: string
  // SSO handoff (#262): mumega is the verified-identity issuer; this pot is a relying
  // party that ACCEPTS a signed verified-email claim and mints its OWN session — while
  // keeping its own Google OAuth (additive). We hold ONLY the issuer's Ed25519 PUBLIC
  // key (a var, not a secret — public material). No shared secret = sovereignty.
  MUPOT_HANDOFF_PUBLIC_KEY?: string
  // The login-handoff audience THIS pot accepts. mumega mints the claim with
  // aud = the pot's dashboard_url hostname (#yp-aud-gap), so each pot must verify
  // against its OWN hostname. Unset ⇒ default HANDOFF_AUD ('mupot.mumega.com'),
  // correct only for mumega#0. Every other pot MUST set this to its host.
  MUPOT_HANDOFF_AUD?: string
  // The login-handoff issuer THIS pot trusts. Unset ⇒ default HANDOFF_ISS
  // ('https://mumega.com'). ONLY set this if you also run your own handoff-claim
  // MINTING side (a different issuer) with a matching public key — overriding
  // this without matching the minting side breaks handoff (every claim gets
  // rejected as wrong_iss; fails safe, never permissive).
  MUPOT_HANDOFF_ISS?: string
  // Sidebar "Switch pot →" cross-tenant picker link. Unset ⇒ mumega's own
  // console (byte-identical to pre-#de-mumega-ify behavior). A forked pot
  // MUST set this to its own picker/home, or unset it entirely if it has
  // none — otherwise its users get sent to mumega's site.
  CONSOLE_SWITCH_POT_URL?: string
  // Domain for an agent-authored commit's email local part (baked into the
  // CUSTOMER's git history via github-execute.ts). Unset ⇒ 'agents.mumega.com'.
  AGENT_COMMIT_EMAIL_DOMAIN?: string
  // Reseller-pot owner-walk link host suffix (src/reseller/provision.ts's
  // DEFAULT_POT_HOST_SUFFIX), passed as a planner opt — never read from client
  // request input. Unset ⇒ 'mupot.mumega.com'.
  DEFAULT_POT_HOST_SUFFIX?: string
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
  // One-time self-hosted first-owner ceremony. Enabled only while dashboard OAuth
  // is entirely unconfigured; the D1 singleton claim permanently closes it after use.
  BOOTSTRAP_OWNER_TOKEN?: string
  // Local-only test login. Intended for `wrangler dev` smoke testing with a local D1/KV.
  // Never set this on a deployed pot; when unset, /auth/dev-login is disabled.
  LOCAL_TEST_AUTH?: string
  LOCAL_TEST_AUTH_EMAIL?: string
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
  FLEET_PANEL_SK?: string      // Ed25519 PRIVATE OKP JWK — signs fleet control-requests. `wrangler secret put FLEET_PANEL_SK`. Absent ⇒ /api/fleet/control 503 (fail-closed).
  PROJECT_LINK_SIGNING_KEY?: string // Ed25519 PRIVATE OKP JWK for signed cross-pot receipts; never shared with a peer pot.
  FLEET_CONSUMER_AGENT?: string // the host consumer agent id that reads + executes control-requests (the daemon reads its inbox as this). Absent ⇒ 503.
  // execution meter caps (env override; meter.ts defaults apply when absent)
  EXEC_MAX_DISPATCH_DAY?: string // max execute-mode dispatches per agent per UTC day
  EXEC_MAX_TOKENS_DAY?: string   // max tokens an agent may spend per UTC day
  // GHL act-channel secrets (issue #8) — set via `wrangler secret put`, NEVER in .toml.
  // All optional: absent = not_configured (fails closed, no send path opens).
  // See wrangler.toml for the operator `wrangler secret put` command block.
  GHL_API_KEY?: string           // GoHighLevel location API key (outbound send)
  GHL_LOCATION_ID?: string       // GHL location id (scopes all API calls)
  GHL_WEBHOOK_SECRET?: string    // HMAC-SHA256 secret for inbound webhook verification
  BILLING_PLAN_SECRET?: string   // HMAC-SHA256 secret: central billing source → POST /api/billing/plan (writes plan_tier)
  CC_SPEND_SECRET?: string       // HMAC-SHA256 secret: server transcript rollup → POST /api/economy/cc-spend (writes cc_spend_daily). Fail-closed: absent ⇒ 503.
  // Connector credential vault (issue #116) — AES-GCM-256 master key.
  // Deploy prerequisite: `npx wrangler secret put CONNECTOR_MASTER_KEY`
  // Value: 64-char hex string (32 bytes / 256-bit, e.g. `openssl rand -hex 32`).
  // Fail-closed: if absent, resolveConnector() returns null and addConnector() throws.
  CONNECTOR_MASTER_KEY?: string
  // Inkwell API origin the inkwell-content ACT executor POSTs to (S4 live-wire).
  // Non-secret; set in wrangler.toml [vars]. e.g. https://inkwell-api.mumega.com.
  // Must be https + a public host (executor SSRF-guards it). Absent ⇒ executor 503.
  INKWELL_API_URL?: string
  // Optional service binding to the pot's Inkwell API worker. When the pot and its
  // Inkwell live on the SAME Cloudflare zone, a public-edge fetch to INKWELL_API_URL
  // loops back and times out (CF 522). This binding routes the content-write
  // subrequest internally (worker→worker), bypassing the public edge. Absent ⇒ the
  // executor falls back to a public-edge fetch (cross-zone tenants). Declared in
  // wrangler.toml [[services]]; INKWELL_API_URL still supplies the request path.
  INKWELL_SVC?: Fetcher
  // CRO data source — PostHog connector (CRO epic, slice 2). The first EXTERNAL source on
  // the data fabric. PROJECT_ID + HOST are non-secret (wrangler.toml [vars]); the personal
  // API key is a secret (`wrangler secret put POSTHOG_PERSONAL_API_KEY`). Fail-closed: the
  // PostHog source is `available()` only when KEY + PROJECT_ID are both present.
  POSTHOG_PROJECT_ID?: string // PostHog project id (e.g. "436189"). Non-secret.
  POSTHOG_HOST?: string // PostHog API host. Default https://us.posthog.com. Non-secret; https only.
  POSTHOG_PERSONAL_API_KEY?: string // PostHog personal API key (read-scope). Secret. Absent ⇒ source unavailable.
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
  project_id: string | null
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
  // At-most-once execution ownership. Dispatch receipts are retained after a
  // terminal write for Queue recovery; the lease is cleared on completion.
  execution_receipt_id?: string | null
  execution_claim_expires_at?: number | null
  // #403 gap 2(b): provenance marker. NULL for every locally-created task (the trusted path).
  // Set to the linked pot's slug (project_links.remote_pot) when this row was written by
  // receiveProjectLinkEnvelope (src/addons/project-link/service.ts) — a signal to any reader
  // (agent, dashboard, MCP client) that title/body originated from an external pot and should
  // be treated as untrusted content, not as a trusted local instruction. See migrations/0063.
  source_pot?: string | null
  created_at: string
  updated_at: string
}

// ── Projects (migration 0055) ───────────────────────────────────────────────

export type ProjectStatus = 'planned' | 'active' | 'paused' | 'review' | 'completed' | 'archived'
export type ProjectAccessLevel = 'read' | 'write' | 'admin'

export interface Project {
  id: string
  slug: string
  name: string
  description: string
  goal: string
  status: ProjectStatus
  parent_project_id: string | null
  target_date: string | null
  /** Next ISO-8601 instant at which the lifecycle circuit breaker evaluates (migration 0068). */
  cycle_boundary_at: string | null
  /** Stall detector flag (0/1); raised early into the breaker — detector is slice 4. */
  stalled: number
  /** Per-project idle threshold in days; NULL = tenant default. */
  stall_threshold_days: number | null
  /**
   * Principal that moved the project into completion review (migration 0069).
   * Used for different-principal self-verdict blocking (slice 2).
   */
  completion_proposed_by: string | null
  created_at: string
  updated_at: string
}

export interface ProjectSquadAccess {
  project_id: string
  squad_id: string
  access_level: ProjectAccessLevel
  granted_at: string
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
  tenant: string
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
  | 'flight.landed' // governed flight completed with task, budget, and identity checks
  | 'agent.wake'
  | 'fleet.control.requested' // signed host-control request queued for the fleet daemon
  | 'brain.directive.updated' // owner-pinned directive changed for the brain decision loop
  | 'squad.dispatch'
  | 'org.provisioned' // a department/squad/agent/token was created in-band (payload.kind)
  | 'project.mutated' // project lifecycle or project-to-squad access changed through MCP

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

// ── Model port (substrate-contract.md §kernel ports). Version lives as a module
// constant, NOT a field on the interface, so adapters/mocks stay structural and
// the parent still knows the contract version. Adding optional ModelChatOpts
// fields is additive (no version bump); changing chat()'s shape is a v2 + shim.
export const MODEL_PORT_VERSION = 1 as const

export interface ModelChatOpts {
  model?: string
  maxTokens?: number
  temperature?: number // additive v1-optional
}

export interface ModelPort {
  chat(messages: ModelMessage[], opts?: ModelChatOpts): Promise<string>
}

// ── Brain port (substrate-contract.md §kernel ports). RANK-ONLY: the brain reads
// a context snapshot and returns a RANKING of proposals — it NEVER acts. The
// sealed core applies the ranking through the autonomy + capability + budget
// gates. This is what makes brain-swapping (sovereign C(t) #70, a YC-CEO brain,
// BYO) safe: a swapped brain changes WHAT is proposed, never bypasses a gate.
// Idempotent by contract: a stable BrainContext should yield a stable ranking
// (rank, don't act → same state → same answer → no spam).
export const BRAIN_PORT_VERSION = 1 as const

// JSON-only, capability-free by TYPE. BrainContext is a SANITIZED snapshot — raw
// bus/event payloads, Env handles, bindings, or secrets must never cross the brain
// port. `unknown` would defeat that by convention; BrainJson enforces it at the
// type level (a binding/secret object cannot satisfy this type).
export type BrainJson =
  | string
  | number
  | boolean
  | null
  | readonly BrainJson[]
  | { readonly [k: string]: BrainJson }

export interface BrainContext {
  tenant: string
  goals: ReadonlyArray<{ agentId: string; okr: string; kpiProgress: number }>
  board: ReadonlyArray<{ taskId: string; status: string; agentId: string | null }>
  pulses?: ReadonlyArray<{ kind: string; at: number; payload?: BrainJson }>
  lastHumanDirective?: string | null // position-0 of every decision (bus WAKES, never STEERS)
  budgetRemainingMicroUsd?: number
}

export interface BrainProposal {
  kind: 'spawn_task' | 'wake_agent' | 'noop'
  agentId?: string
  summary: string // human-readable intent (audit trail / Brain page)
  doneWhen?: string // proposed done-condition; core still gates
  priority: number // brain's rank; core may re-clamp
}

export interface BrainDecision {
  ranked: ReadonlyArray<BrainProposal> // ordered best-first; idempotent for a given context
  rationale?: string
}

export interface BrainPort {
  decide(ctx: BrainContext): Promise<BrainDecision>
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
  projects: '/api/projects',
  bus: '/api/bus',
  members: '/api/members',
  mcp: '/mcp',
  im: '/im',
  dashboard: '/',
} as const
