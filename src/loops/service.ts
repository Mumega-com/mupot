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

/**
 * insertLoopIfAbsent — idempotent-by-id loop creation for callers that mint the loop's
 * id THEMSELVES ahead of the write (addon activation's ensureLoopClaim, src/addons/
 * service.ts — see that file's comment for the full ordering rationale). Unlike
 * createLoop (which always starts a loop 'active' — the direct-API dogfood path,
 * src/loops/routes.ts), status is caller-supplied: an addon-declared loop with
 * approvalRequired:true is inserted 'paused' so it EXISTS but never runs until a
 * separate, explicit action promotes it.
 *
 * INSERT OR IGNORE on the primary key: a retry after a crash between "claim reserved"
 * and "loop row written" safely completes the write without erroring or duplicating —
 * the second attempt targets the SAME id and is a no-op if the first attempt's insert
 * already landed.
 */
export async function insertLoopIfAbsent(
  env: Env,
  id: string,
  status: LoopStatus,
  input: unknown,
): Promise<LoopResult<LoopManifest>> {
  const spec = validateLoopSpec(input)
  if (!spec.ok) return { ok: false, error: spec.error }

  const now = new Date().toISOString()
  const tenant = env.TENANT_SLUG

  await env.DB.prepare(
    `INSERT OR IGNORE INTO loops (id, tenant, squad_id, agent_id, status, spec, dry_rounds, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(id, tenant, spec.value.squad_id, spec.value.agent_id, status, JSON.stringify(spec.value), now, now)
    .run()

  const row = await env.DB.prepare(
    `SELECT id, tenant, squad_id, agent_id, status, spec, dry_rounds, created_at, updated_at
       FROM loops WHERE id = ? AND tenant = ? LIMIT 1`,
  )
    .bind(id, tenant)
    .first<LoopRow>()
  const hydrated = row ? hydrateLoop(row) : null
  return hydrated ? { ok: true, value: hydrated } : { ok: false, error: 'loop_insert_failed' }
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

/**
 * listLoops — tenant-scoped, optionally filtered by status. Invalid rows are skipped.
 *
 * `squadIds` (FLIGHT-001 #797): the caller's OWN accessible squad ids
 * (resolveAccessibleSquadIds), for scoping the /brain dashboard's loop feed to
 * a squad-scoped viewer. `undefined` (the default, and every pre-existing
 * caller — loops/driver.ts's engine loop, loops/routes.ts's admin-gated API,
 * mcp/loops.ts) is UNRESTRICTED, so those callers are unaffected; only
 * dashboard/brain.ts passes this explicitly. `null` is also unrestricted (an
 * org-scope grant or legacy owner/admin). `[]` scopes to nothing. A loop is
 * "in scope" when its OWN squad_id is one of the caller's squads, or (for an
 * agent-owned loop, where squad_id is null by the schema's "exactly one of
 * squad_id/agent_id" invariant — see manifest.ts) the owning agent's squad is.
 */
export async function listLoops(
  env: Env,
  opts: { status?: LoopStatus; squadIds?: string[] | null } = {},
): Promise<LoopManifest[]> {
  // Plain `?` placeholders throughout (matches this file's existing style) —
  // the bind array is built in the SAME order the clauses below append `?`,
  // so no numbered-placeholder bookkeeping is needed.
  let scopeClause = ''
  let idsJson: string | null = null
  if (opts.squadIds !== undefined && opts.squadIds !== null) {
    if (opts.squadIds.length === 0) return []
    idsJson = JSON.stringify(opts.squadIds)
    scopeClause = `
      AND (
        squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
        OR (agent_id IS NOT NULL AND agent_id IN (
          SELECT id FROM agents WHERE squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
        ))
      )`
  }
  const statement = env.DB.prepare(
    opts.status
      ? `SELECT id, tenant, squad_id, agent_id, status, spec, dry_rounds, created_at, updated_at
           FROM loops WHERE tenant = ? AND status = ?${scopeClause} ORDER BY created_at DESC`
      : `SELECT id, tenant, squad_id, agent_id, status, spec, dry_rounds, created_at, updated_at
           FROM loops WHERE tenant = ?${scopeClause} ORDER BY created_at DESC`,
  )
  const bind: unknown[] = [env.TENANT_SLUG]
  if (opts.status) bind.push(opts.status)
  // scopeClause references json_each(?) TWICE — bind idsJson twice to match.
  if (idsJson !== null) bind.push(idsJson, idsJson)
  const rows = await statement.bind(...bind).all<LoopRow>()

  const out: LoopManifest[] = []
  for (const row of rows.results ?? []) {
    const m = hydrateLoop(row)
    if (m) out.push(m)
  }
  return out
}

/** bumpDryRounds — increment the consecutive-empty-tick counter; returns the new value. */
export async function bumpDryRounds(env: Env, id: string): Promise<number> {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `UPDATE loops SET dry_rounds = dry_rounds + 1, updated_at = ? WHERE id = ? AND tenant = ?`,
  )
    .bind(now, id, env.TENANT_SLUG)
    .run()
  const row = await env.DB.prepare(`SELECT dry_rounds FROM loops WHERE id = ? AND tenant = ? LIMIT 1`)
    .bind(id, env.TENANT_SLUG)
    .first<{ dry_rounds: number }>()
  return row?.dry_rounds ?? 0
}

/** resetDryRounds — clear the counter after a productive tick (no-op if already 0). */
export async function resetDryRounds(env: Env, id: string): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `UPDATE loops SET dry_rounds = 0, updated_at = ? WHERE id = ? AND tenant = ? AND dry_rounds != 0`,
  )
    .bind(now, id, env.TENANT_SLUG)
    .run()
}

/**
 * setLoopStatus — tenant-scoped lifecycle transition. Returns false if no row changed.
 * 'killed' and 'done' are TERMINAL: a loop in either state is never transitioned out
 * (the WHERE excludes them), so a killed loop cannot be revived.
 */
export async function setLoopStatus(env: Env, id: string, status: LoopStatus): Promise<boolean> {
  const now = new Date().toISOString()
  const res = await env.DB.prepare(
    `UPDATE loops SET status = ?, updated_at = ? WHERE id = ? AND tenant = ? AND status NOT IN ('killed', 'done')`,
  )
    .bind(status, now, id, env.TENANT_SLUG)
    .run()
  return (res.meta?.changes ?? 0) === 1
}
