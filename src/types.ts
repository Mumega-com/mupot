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

export type Capability = 'owner' | 'lead' | 'member' | 'observer'

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
  role: 'owner' | 'admin' | 'member' // org-level role
  tenant: string // TENANT_SLUG — every request is scoped to it
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

// ── Component routers register onto the root Hono app under these prefixes ──
export const ROUTES = {
  auth: '/auth',
  org: '/api/org',
  agents: '/api/agents',
  tasks: '/api/tasks',
  bus: '/api/bus',
  dashboard: '/',
} as const
