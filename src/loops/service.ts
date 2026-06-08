// mupot — Loop storage service (P1, #32).
//
// Persists/loads the Loop manifest (the declarative resource). The rich shape is
// stored as JSON in `spec`; identity + lifecycle are flat columns. EVERY read is
// tenant-scoped (WHERE tenant = env.TENANT_SLUG) — a loop is never readable across
// tenants. On read we re-validate the stored spec (defensive: stored JSON could be
// stale/corrupt after a schema change) and return null on invalid.
//
// Follows the repo's result convention (org/service.ts): {ok:true,value}|{ok:false,error}.

import type { Env } from '../types'
import {
  validateLoopSpec,
  isLoopStatus,
} from './manifest'
import type { LoopManifest, LoopStatus } from './manifest'

export type LoopResult<T> = { ok: true; value: T } | { ok: false; error: string }

interface LoopRow {
  id: string
  tenant: string
  squad_id: string | null
  agent_id: string | null
  status: string
  spec: string
  dry_rounds: number
  created_at: string
  updated_at: string
}

/** Row → LoopManifest. Re-validates the stored spec; returns null if invalid. */
export function hydrateLoop(row: LoopRow): LoopManifest | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(row.spec)
  } catch {
    return null
  }
  const spec = validateLoopSpec(parsed)
  if (!spec.ok) return null
  if (!isLoopStatus(row.status)) return null
  return {
    ...spec.value,
    id: row.id,
    tenant: row.tenant,
    status: row.status,
    created_at: row.created_at,
  }
}

/**
 * createLoop — validate a spec and persist it as a new active loop under this tenant.
 * id is server-minted; tenant is env-derived (never client-supplied).
 */
export async function createLoop(env: Env, input: unknown): Promise<LoopResult<LoopManifest>> {
  const spec = validateLoopSpec(input)
  if (!spec.ok) return { ok: false, error: spec.error }

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const tenant = env.TENANT_SLUG

  await env.DB.prepare(
    `INSERT INTO loops (id, tenant, squad_id, agent_id, status, spec, dry_rounds, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, 0, ?, ?)`,
  )
    .bind(id, tenant, spec.value.squad_id, spec.value.agent_id, JSON.stringify(spec.value), now, now)
    .run()

  return {
    ok: true,
    value: { ...spec.value, id, tenant, status: 'active', created_at: now },
  }
}

/** getLoop — tenant-scoped fetch by id. null when absent or stored spec is invalid. */
export async function getLoop(env: Env, id: string): Promise<LoopManifest | null> {
  const row = await env.DB.prepare(
    `SELECT id, tenant, squad_id, agent_id, status, spec, dry_rounds, created_at, updated_at
       FROM loops WHERE id = ? AND tenant = ? LIMIT 1`,
  )
    .bind(id, env.TENANT_SLUG)
    .first<LoopRow>()
  return row ? hydrateLoop(row) : null
}

/** listLoops — tenant-scoped, optionally filtered by status. Invalid rows are skipped. */
export async function listLoops(env: Env, opts: { status?: LoopStatus } = {}): Promise<LoopManifest[]> {
  const rows = opts.status
    ? await env.DB.prepare(
        `SELECT id, tenant, squad_id, agent_id, status, spec, dry_rounds, created_at, updated_at
           FROM loops WHERE tenant = ? AND status = ? ORDER BY created_at DESC`,
      )
        .bind(env.TENANT_SLUG, opts.status)
        .all<LoopRow>()
    : await env.DB.prepare(
        `SELECT id, tenant, squad_id, agent_id, status, spec, dry_rounds, created_at, updated_at
           FROM loops WHERE tenant = ? ORDER BY created_at DESC`,
      )
        .bind(env.TENANT_SLUG)
        .all<LoopRow>()

  const out: LoopManifest[] = []
  for (const row of rows.results ?? []) {
    const m = hydrateLoop(row)
    if (m) out.push(m)
  }
  return out
}

/** setLoopStatus — tenant-scoped lifecycle transition. Returns false if no row changed. */
export async function setLoopStatus(env: Env, id: string, status: LoopStatus): Promise<boolean> {
  const now = new Date().toISOString()
  const res = await env.DB.prepare(
    `UPDATE loops SET status = ?, updated_at = ? WHERE id = ? AND tenant = ?`,
  )
    .bind(status, now, id, env.TENANT_SLUG)
    .run()
  return (res.meta?.changes ?? 0) === 1
}
