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

// ── Cloudflare bindings (must match wrangler.toml) ──
export interface Env {
  DB: D1Database
  VEC: VectorizeIndex
  BUS: Queue<BusEvent>
  SESSIONS: KVNamespace
  BLOBS: R2Bucket
  AI: Ai
  AGENT: DurableObjectNamespace
  SQUAD: DurableObjectNamespace
  // vars
  TENANT_SLUG: string
  BRAND: string
  OAUTH_PROVIDER: 'google' | 'telegram'
  // secrets (present at runtime only)
  OAUTH_CLIENT_ID?: string
  OAUTH_CLIENT_SECRET?: string
  GITHUB_TOKEN?: string
  AI_GATEWAY_TOKEN?: string
  IM_WEBHOOK_SECRET?: string // shared secret for the IM webhook (Telegram secret_token)
}

// ── Org domain (mirrors migrations/0001_init.sql) ──
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
  status: 'open' | 'in_progress' | 'blocked' | 'done'
  assignee_agent_id: string | null
  github_issue_url: string | null // tasks are mirrored to GitHub (source of truth)
  created_at: string
  updated_at: string
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

export type ConnectionChannel = 'workspace' | 'im' | 'dashboard'

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
  | 'agent.wake'
  | 'squad.dispatch'

export interface BusEvent<T = unknown> {
  type: BusEventType
  tenant: string
  squad_id?: string
  agent_id?: string
  actor?: { kind: 'member' | 'agent'; id: string } // attribution — who caused this
  payload: T
  ts: string // ISO; set by the producer
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
