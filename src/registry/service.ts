// mupot — module_registry service (Module Kernel, Port 1: presence).
//
// Design: docs/architecture/mupot-module-kernel.md. Every module (agent-system /
// workflow / surface) registers here, heartbeats, and can vanish at any time WITHOUT
// the kernel losing durability — a dead module just reads 'offline'; nothing blocks
// on it. This file owns the ONE durable primitive (`module_registry`, migration 0066)
// and mirrors src/loops/service.ts's shape (result convention, tenant-scoped queries,
// a validated read-model separate from the raw storage row).
//
// DURABILITY (the non-negotiable): stale heartbeat -> offline is QUERY-TIME derived —
// listPresence computes it from `last_heartbeat` vs `now`, never from a cron/sweep.
// `now` is an explicit parameter (mirrors src/fleet/presence.ts#listPresence(env,
// nowMs)) so tests can drive staleness deterministically without waiting real time.
//
// Tenant scope: every write/read is scoped to env.TENANT_SLUG — never client-supplied.
// Identity: callers pass IN a caller-derived identity string; this module never
// resolves auth itself (that's the MCP tool / HTTP route boundary's job — see
// src/mcp/presence.ts and src/registry/presence-routes.ts). This file only enforces
// the DATA invariants (upsert, staleness, tenant scope).

import type { Env } from '../types'

export type ModuleKind = 'agent_system' | 'workflow' | 'surface'
export type ModuleStatus = 'online' | 'offline'

const MODULE_KINDS: readonly ModuleKind[] = ['agent_system', 'workflow', 'surface']

export function isModuleKind(v: unknown): v is ModuleKind {
  return typeof v === 'string' && (MODULE_KINDS as readonly string[]).includes(v)
}

// A module is only counted 'online' if its heartbeat is fresher than this window.
// Named const per the design doc's "make it a named const" requirement — the single
// place that defines what "stale" means for presence. 120s: comfortably wider than a
// typical heartbeat cadence (the design doc's "every N seconds") without letting a
// dead module linger "online" for long.
export const PRESENCE_STALE_SECONDS = 120

export type RegistryResult<T> = { ok: true; value: T } | { ok: false; error: string }

interface ModuleRegistryRow {
  id: string
  tenant: string
  kind: string
  adapter: string
  project_id: string | null
  identity: string
  status: string
  capabilities: string
  last_heartbeat: string
  registered_at: string
}

// The read-model returned to callers. `status` here is the caller-facing EFFECTIVE
// status (post query-time staleness derivation) — see effectiveStatus() below. This is
// deliberately a different shape than ModuleRegistryRow (the raw stored row) so a
// caller can never mistake the derived value for the stored one.
export interface ModulePresence {
  id: string
  kind: ModuleKind
  adapter: string
  project_id: string | null
  identity: string
  status: ModuleStatus
  capabilities: string[]
  last_heartbeat: string
  registered_at: string
}

const SELECT_COLUMNS = `id, tenant, kind, adapter, project_id, identity, status, capabilities, last_heartbeat, registered_at`

function parseCapabilities(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}

/**
 * effectiveStatus — the query-time durability guarantee. A row explicitly deregistered
 * (stored status = 'offline') stays offline. Otherwise a row is online only while its
 * last_heartbeat is within PRESENCE_STALE_SECONDS of `nowMs` — past that window it reads
 * offline WITHOUT any write, cron, or sweep ever running. This is what lets the kernel
 * never hang on a dead module: staleness is a property of a READ, not a background job.
 */
function effectiveStatus(row: Pick<ModuleRegistryRow, 'status' | 'last_heartbeat'>, nowMs: number): ModuleStatus {
  if (row.status === 'offline') return 'offline'
  const heartbeatMs = Date.parse(row.last_heartbeat)
  if (Number.isNaN(heartbeatMs)) return 'offline' // corrupt/unparseable timestamp fails closed
  const ageSeconds = (nowMs - heartbeatMs) / 1000
  return ageSeconds <= PRESENCE_STALE_SECONDS ? 'online' : 'offline'
}

function hydrate(row: ModuleRegistryRow, nowMs: number): ModulePresence | null {
  if (!isModuleKind(row.kind)) return null // defensive: re-validate stored data on read
  return {
    id: row.id,
    kind: row.kind,
    adapter: row.adapter,
    project_id: row.project_id,
    identity: row.identity,
    status: effectiveStatus(row, nowMs),
    capabilities: parseCapabilities(row.capabilities),
    last_heartbeat: row.last_heartbeat,
    registered_at: row.registered_at,
  }
}

export interface RegisterModuleInput {
  identity: string // server-derived by the caller (auth), never attacker-supplied here
  kind: ModuleKind
  adapter: string
  projectId: string | null
  capabilities?: string[]
}

/**
 * registerModule — idempotent upsert. Re-registering the SAME identity under the SAME
 * (tenant, project_id) updates the existing row in place (kind/adapter/capabilities may
 * change; status resets to 'online'; last_heartbeat bumps to now) — it never inserts a
 * duplicate. This targets the migration 0066 unique index on
 * (tenant, identity, project_key) where project_key normalizes NULL project_id to ''.
 * `registered_at` is preserved across re-registration (only set on first insert) —
 * mirrors src/fleet/presence.ts#recordCheckin's first_seen_at convention.
 */
export async function registerModule(
  env: Env,
  input: RegisterModuleInput,
  now: Date = new Date(),
): Promise<RegistryResult<ModulePresence>> {
  const identity = input.identity.trim()
  if (!identity) return { ok: false, error: 'identity_required' }
  if (!isModuleKind(input.kind)) return { ok: false, error: 'invalid_kind' }
  const adapter = input.adapter.trim()
  if (!adapter) return { ok: false, error: 'adapter_required' }

  const tenant = env.TENANT_SLUG
  const id = crypto.randomUUID()
  const nowIso = now.toISOString()
  const capabilitiesJson = JSON.stringify(input.capabilities ?? [])

  await env.DB.prepare(
    `INSERT INTO module_registry
       (id, tenant, kind, adapter, project_id, identity, status, capabilities, last_heartbeat, registered_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'online', ?7, ?8, ?8)
     ON CONFLICT (tenant, identity, project_key) DO UPDATE SET
       kind           = excluded.kind,
       adapter        = excluded.adapter,
       status         = 'online',
       capabilities   = excluded.capabilities,
       last_heartbeat = excluded.last_heartbeat`,
  )
    .bind(id, tenant, input.kind, adapter, input.projectId, identity, capabilitiesJson, nowIso)
    .run()

  const row = await env.DB.prepare(`SELECT ${SELECT_COLUMNS} FROM module_registry WHERE tenant = ?1 AND identity = ?2 AND project_id IS ?3 LIMIT 1`)
    .bind(tenant, identity, input.projectId)
    .first<ModuleRegistryRow>()
  if (!row) return { ok: false, error: 'register_failed' }
  const hydrated = hydrate(row, now.getTime())
  return hydrated ? { ok: true, value: hydrated } : { ok: false, error: 'register_failed' }
}

/**
 * heartbeatModule — bump last_heartbeat (and flip status back to 'online' if the row
 * had been explicitly deregistered — a heartbeat is an implicit re-announce). Scoped to
 * (tenant, identity): a caller can only heartbeat ITS OWN identity (enforced by the
 * caller passing its own auth-derived identity — see src/mcp/presence.ts). Returns false
 * if no matching row exists (the caller must register() first).
 */
export async function heartbeatModule(
  env: Env,
  identity: string,
  projectId: string | null,
  now: Date = new Date(),
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE module_registry
        SET last_heartbeat = ?1, status = 'online'
      WHERE tenant = ?2 AND identity = ?3 AND project_id IS ?4`,
  )
    .bind(now.toISOString(), env.TENANT_SLUG, identity, projectId)
    .run()
  return (res.meta?.changes ?? 0) > 0
}

/**
 * deregisterModule — explicit offline. This is the ONLY writer that ever sets
 * status='offline' directly (staleness is read-derived, never written) — an explicit
 * deregister communicates "I am intentionally leaving," distinct from "I stopped
 * heartbeating and nobody knows why." Scoped to (tenant, identity): self only.
 */
export async function deregisterModule(
  env: Env,
  identity: string,
  projectId: string | null,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE module_registry
        SET status = 'offline'
      WHERE tenant = ?1 AND identity = ?2 AND project_id IS ?3 AND status <> 'offline'`,
  )
    .bind(env.TENANT_SLUG, identity, projectId)
    .run()
  return (res.meta?.changes ?? 0) > 0
}

/**
 * listPresence — the project-scoped roster. Tenant-scoped always; `opts.projectId`
 * further narrows to one project (undefined = every registration this tenant has,
 * across all projects; pass projectId: null explicitly to see only "no project
 * selected" registrations). `now` is an injected clock (default real time) so callers
 * — and tests — can drive staleness derivation deterministically; see
 * effectiveStatus() for why this needs no cron.
 */
export async function listPresence(
  env: Env,
  opts: { projectId?: string | null } = {},
  now: Date = new Date(),
): Promise<ModulePresence[]> {
  const tenant = env.TENANT_SLUG
  const rows =
    opts.projectId === undefined
      ? await env.DB.prepare(`SELECT ${SELECT_COLUMNS} FROM module_registry WHERE tenant = ?1 ORDER BY last_heartbeat DESC`)
          .bind(tenant)
          .all<ModuleRegistryRow>()
      : await env.DB.prepare(
          `SELECT ${SELECT_COLUMNS} FROM module_registry WHERE tenant = ?1 AND project_id IS ?2 ORDER BY last_heartbeat DESC`,
        )
          .bind(tenant, opts.projectId)
          .all<ModuleRegistryRow>()

  const nowMs = now.getTime()
  const out: ModulePresence[] = []
  for (const row of rows.results ?? []) {
    const hydrated = hydrate(row, nowMs)
    if (hydrated) out.push(hydrated)
  }
  return out
}

/** getModule — tenant-scoped fetch of ONE caller's own registration (self-lookup). */
export async function getModule(
  env: Env,
  identity: string,
  projectId: string | null,
  now: Date = new Date(),
): Promise<ModulePresence | null> {
  const row = await env.DB.prepare(
    `SELECT ${SELECT_COLUMNS} FROM module_registry WHERE tenant = ?1 AND identity = ?2 AND project_id IS ?3 LIMIT 1`,
  )
    .bind(env.TENANT_SLUG, identity, projectId)
    .first<ModuleRegistryRow>()
  return row ? hydrate(row, now.getTime()) : null
}
