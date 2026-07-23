// mupot — secret-env request / status / bind / reject / resolve service.
//
// Custody discipline (load-bearing, see docs/superpowers/specs/2026-07-23-mupot-secret-env-taker-design.md):
//   - Third-party secret VALUES are NEVER written to D1 SQL binds, audit `detail`,
//     receipts, or logs. Only binding NAMES, purposes, reasons, and actor ids
//     ever touch D1.
//   - Custody of the value itself lives on the tenant's Cloudflare account
//     (Worker secret bindings) via `putScriptSecrets` — this service only
//     forwards the pasted values to that one CF API call and then drops them.
//   - Fail-closed: if `getSecretEnvCfConfig` returns null, bindSecretEnv refuses
//     with `secret_env_ops_unconfigured` — no silent vault fallback.
//   - `bindSecretEnv` is all-or-nothing against D1: unless EVERY pending key for
//     the request is PUT successfully to CF, no binding is marked bound and the
//     request stays `pending` for retry. Already-written CF secrets are
//     idempotent to re-PUT, so a retry with the same values is always safe.
//
// Caller contract:
//   requestSecretEnv()            — agent proposes a schema; no values ever passed here
//   listPendingSecretEnvRequests()— admin queue for /approvals
//   getSecretEnvStatus()          — names -> bound/unbound/pending/revoked/unknown; never values
//   bindSecretEnv()                — admin pastes values; PUT to CF; D1 metadata only
//   rejectSecretEnv()              — admin declines; no CF calls
//   resolveSecretEnv()             — raw env accessor; caller MUST have verified bound status
//   resolveSecretEnvBinding()      — preferred: checks D1 status=bound, then reads env

import type { Env } from '../types'
import { assertBindingName } from './names'
import { getSecretEnvCfConfig, putScriptSecrets } from './cf-secrets'
import type {
  SecretEnvKeySpec,
  PublicSecretEnvRequest,
  SecretEnvRequestStatus,
  SecretEnvBindingStatus,
} from './types'

// ── caps (load-bearing) ──────────────────────────────────────────────────────

const MAX_KEYS_PER_REQUEST = 20
const MAX_PURPOSE_LENGTH = 280
const MAX_REASON_LENGTH = 500
const MAX_ADAPTER_HINT_LENGTH = 64

// ── row shapes (D1) ──────────────────────────────────────────────────────────

interface SecretEnvRequestRow {
  id: string
  tenant: string
  reason: string
  schema_json: string
  status: SecretEnvRequestStatus
  requested_by: string
  decided_by: string | null
  created_at: string
  decided_at: string | null
}

interface SecretEnvBindingRow {
  id: string
  tenant: string
  binding_name: string
  purpose: string
  adapter_hint: string | null
  status: SecretEnvBindingStatus
  requested_by: string
  bound_by: string | null
  request_id: string
  created_at: string
  bound_at: string | null
  revoked_at: string | null
}

/** What is persisted (JSON) inside secret_env_requests.schema_json. Keys +
 * request-level adapter hint only — never values. */
interface SecretEnvRequestSchema {
  keys: SecretEnvKeySpec[]
  adapterHint: string | null
}

function parseRequestSchema(schemaJson: string): SecretEnvRequestSchema {
  const parsed = JSON.parse(schemaJson) as { keys?: unknown; adapterHint?: unknown }
  const keys = Array.isArray(parsed.keys)
    ? parsed.keys.filter((entry): entry is SecretEnvKeySpec => (
        typeof entry === 'object' && entry !== null
        && typeof (entry as Record<string, unknown>).name === 'string'
        && typeof (entry as Record<string, unknown>).purpose === 'string'
      ))
    : []
  const adapterHint = typeof parsed.adapterHint === 'string' ? parsed.adapterHint : null
  return { keys, adapterHint }
}

function toPublicRequest(row: SecretEnvRequestRow): PublicSecretEnvRequest {
  const schema = parseRequestSchema(row.schema_json)
  return {
    id: row.id,
    reason: row.reason,
    keys: schema.keys,
    adapter_hint: schema.adapterHint,
    status: row.status,
    requested_by: row.requested_by,
    created_at: row.created_at,
  }
}

// ── audit helper ─────────────────────────────────────────────────────────────

type SecretEnvAuditAction = 'request' | 'bind' | 'reject' | 'rotate' | 'revoke'

async function writeSecretEnvAudit(
  env: Env,
  params: {
    requestId: string | null
    bindingName: string | null
    action: SecretEnvAuditAction
    actorId: string
    detail?: string | null
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO secret_env_audit (id, tenant, request_id, binding_name, action, actor_id, detail, recorded_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      crypto.randomUUID(),
      env.TENANT_SLUG,
      params.requestId,
      params.bindingName,
      params.action,
      params.actorId,
      params.detail ?? null,
      new Date().toISOString(),
    )
    .run()
}

// ── requestSecretEnv ─────────────────────────────────────────────────────────

export interface RequestSecretEnvParams {
  keys: SecretEnvKeySpec[]
  reason: string
  adapterHint: string | null
  requestedBy: string
}

export type RequestSecretEnvResult =
  | { ok: true; request: PublicSecretEnvRequest }
  | { ok: false; error: string }

/**
 * Agent proposes an env schema (names + purposes) plus a reason. Creates a
 * pending request row and one pending binding row per key. No values are ever
 * accepted by this function — that is the whole point of the gate.
 */
export async function requestSecretEnv(
  env: Env,
  params: RequestSecretEnvParams,
): Promise<RequestSecretEnvResult> {
  const { keys, reason, adapterHint, requestedBy } = params

  if (!requestedBy.trim()) return { ok: false, error: 'requested_by_required' }
  if (!reason.trim()) return { ok: false, error: 'reason_required' }
  if (reason.length > MAX_REASON_LENGTH) return { ok: false, error: 'reason_too_long' }
  if (adapterHint !== null && adapterHint.length > MAX_ADAPTER_HINT_LENGTH) {
    return { ok: false, error: 'adapter_hint_too_long' }
  }
  if (keys.length === 0) return { ok: false, error: 'keys_required' }
  if (keys.length > MAX_KEYS_PER_REQUEST) return { ok: false, error: 'too_many_keys' }

  const seenNames = new Set<string>()
  for (const key of keys) {
    if (!key.purpose.trim()) return { ok: false, error: 'purpose_required' }
    if (key.purpose.length > MAX_PURPOSE_LENGTH) return { ok: false, error: 'purpose_too_long' }
    if (seenNames.has(key.name)) return { ok: false, error: 'duplicate_binding_name' }
    seenNames.add(key.name)
    try {
      assertBindingName(key.name)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'invalid_binding_name' }
    }
  }

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const schemaJson = JSON.stringify({ keys, adapterHint } satisfies SecretEnvRequestSchema)

  await env.DB.prepare(
    `INSERT INTO secret_env_requests (id, tenant, reason, schema_json, status, requested_by, decided_by, created_at, decided_at)
     VALUES (?1, ?2, ?3, ?4, 'pending', ?5, NULL, ?6, NULL)`,
  )
    .bind(id, env.TENANT_SLUG, reason, schemaJson, requestedBy, now)
    .run()

  for (const key of keys) {
    await env.DB.prepare(
      `INSERT INTO secret_env_bindings (id, tenant, binding_name, purpose, adapter_hint, status, requested_by, bound_by, request_id, created_at, bound_at, revoked_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, NULL, ?7, ?8, NULL, NULL)`,
    )
      .bind(crypto.randomUUID(), env.TENANT_SLUG, key.name, key.purpose, adapterHint, requestedBy, id, now)
      .run()
  }

  await writeSecretEnvAudit(env, {
    requestId: id,
    bindingName: null,
    action: 'request',
    actorId: requestedBy,
    detail: JSON.stringify({ names: keys.map((key) => key.name) }),
  })

  return {
    ok: true,
    request: {
      id,
      reason,
      keys,
      adapter_hint: adapterHint,
      status: 'pending',
      requested_by: requestedBy,
      created_at: now,
    },
  }
}

// ── listPendingSecretEnvRequests ─────────────────────────────────────────────

/** Admin queue for /approvals — pending requests for this tenant only. */
export async function listPendingSecretEnvRequests(env: Env): Promise<PublicSecretEnvRequest[]> {
  const rows = await env.DB.prepare(
    `SELECT id, tenant, reason, schema_json, status, requested_by, decided_by, created_at, decided_at
       FROM secret_env_requests
      WHERE tenant = ?1 AND status = 'pending'
      ORDER BY created_at ASC`,
  )
    .bind(env.TENANT_SLUG)
    .all<SecretEnvRequestRow>()

  return (rows.results ?? []).map(toPublicRequest)
}

// ── getSecretEnvStatus ───────────────────────────────────────────────────────

export type SecretEnvStatusValue = 'bound' | 'unbound' | 'pending' | 'revoked' | 'unknown'

/** Names -> status. Never returns values. 'unbound' = no binding row exists
 * at all (never requested); 'unknown' is a defensive fallback for a status
 * value outside the known enum (should be unreachable in practice). */
export async function getSecretEnvStatus(
  env: Env,
  names: readonly string[],
): Promise<Record<string, SecretEnvStatusValue>> {
  const result: Record<string, SecretEnvStatusValue> = {}
  for (const name of names) {
    const row = await env.DB.prepare(
      `SELECT status FROM secret_env_bindings WHERE tenant = ?1 AND binding_name = ?2 LIMIT 1`,
    )
      .bind(env.TENANT_SLUG, name)
      .first<{ status: SecretEnvBindingStatus }>()

    if (!row) {
      result[name] = 'unbound'
      continue
    }
    if (row.status === 'pending' || row.status === 'bound' || row.status === 'revoked') {
      result[name] = row.status
    } else {
      result[name] = 'unknown'
    }
  }
  return result
}

// ── bindSecretEnv ────────────────────────────────────────────────────────────

export interface BindSecretEnvParams {
  requestId: string
  values: Record<string, string>
  actorId: string
  fetchImpl?: typeof fetch
}

export type BindSecretEnvResult =
  | { ok: true; bound: string[] }
  | { ok: false; error: string }

/**
 * Admin pastes values for a pending request. Algorithm (see class doc):
 *   1. Load request by id+tenant; must be pending.
 *   2. getSecretEnvCfConfig or fail-closed with secret_env_ops_unconfigured.
 *   3. Require a non-empty value for every pending binding on the request.
 *   4. putScriptSecrets with all pairs, in one CF round-trip.
 *   5. All-or-nothing: only on FULL CF success do bindings flip to bound and
 *      the request to approved. Any failure leaves everything pending — the
 *      already-written CF secrets are safe to re-PUT on retry.
 *   6. Secret strings are used ONLY to build the putScriptSecrets payload —
 *      they never appear in a `.bind()` call or an audit `detail` string.
 */
export async function bindSecretEnv(
  env: Env,
  params: BindSecretEnvParams,
): Promise<BindSecretEnvResult> {
  const { requestId, values, actorId, fetchImpl } = params

  const request = await env.DB.prepare(
    `SELECT id, tenant, reason, schema_json, status, requested_by, decided_by, created_at, decided_at
       FROM secret_env_requests WHERE id = ?1 AND tenant = ?2 LIMIT 1`,
  )
    .bind(requestId, env.TENANT_SLUG)
    .first<SecretEnvRequestRow>()

  if (!request) return { ok: false, error: 'request_not_found' }
  if (request.status !== 'pending') return { ok: false, error: 'request_not_pending' }

  const cfConfig = getSecretEnvCfConfig(env)
  if (!cfConfig) return { ok: false, error: 'secret_env_ops_unconfigured' }

  const pendingBindingsResult = await env.DB.prepare(
    `SELECT id, tenant, binding_name, purpose, adapter_hint, status, requested_by, bound_by, request_id, created_at, bound_at, revoked_at
       FROM secret_env_bindings WHERE tenant = ?1 AND request_id = ?2 AND status = 'pending'`,
  )
    .bind(env.TENANT_SLUG, requestId)
    .all<SecretEnvBindingRow>()

  const pendingBindings = pendingBindingsResult.results ?? []
  if (pendingBindings.length === 0) return { ok: false, error: 'no_pending_bindings' }

  for (const binding of pendingBindings) {
    const value = values[binding.binding_name]
    if (!value || !value.trim()) return { ok: false, error: `missing_value_for_${binding.binding_name}` }
  }

  const secrets = pendingBindings.map((binding) => ({
    name: binding.binding_name,
    text: values[binding.binding_name]!,
  }))

  const cfResult = await putScriptSecrets(cfConfig, secrets, fetchImpl ?? fetch)
  if (!cfResult.ok) {
    // All-or-nothing on the D1 side: leave every binding + the request pending.
    // Any secrets already PUT to CF are idempotent to re-PUT on the next retry.
    return { ok: false, error: cfResult.error }
  }

  const now = new Date().toISOString()
  const boundNames: string[] = []
  for (const binding of pendingBindings) {
    await env.DB.prepare(
      `UPDATE secret_env_bindings SET status = 'bound', bound_by = ?1, bound_at = ?2 WHERE id = ?3 AND tenant = ?4`,
    )
      .bind(actorId, now, binding.id, env.TENANT_SLUG)
      .run()
    boundNames.push(binding.binding_name)
  }

  await env.DB.prepare(
    `UPDATE secret_env_requests SET status = 'approved', decided_by = ?1, decided_at = ?2 WHERE id = ?3 AND tenant = ?4`,
  )
    .bind(actorId, now, requestId, env.TENANT_SLUG)
    .run()

  await writeSecretEnvAudit(env, {
    requestId,
    bindingName: null,
    action: 'bind',
    actorId,
    detail: JSON.stringify({ names: boundNames }),
  })

  return { ok: true, bound: boundNames }
}

// ── rejectSecretEnv ──────────────────────────────────────────────────────────

export interface RejectSecretEnvParams {
  requestId: string
  actorId: string
}

export type RejectSecretEnvResult = { ok: true } | { ok: false; error: string }

/** Admin declines a pending request. No CF calls. Pending bindings on the
 * request are marked revoked (dead, not retryable); the request is rejected. */
export async function rejectSecretEnv(
  env: Env,
  params: RejectSecretEnvParams,
): Promise<RejectSecretEnvResult> {
  const { requestId, actorId } = params

  const request = await env.DB.prepare(
    `SELECT id, tenant, reason, schema_json, status, requested_by, decided_by, created_at, decided_at
       FROM secret_env_requests WHERE id = ?1 AND tenant = ?2 LIMIT 1`,
  )
    .bind(requestId, env.TENANT_SLUG)
    .first<SecretEnvRequestRow>()

  if (!request) return { ok: false, error: 'request_not_found' }
  if (request.status !== 'pending') return { ok: false, error: 'request_not_pending' }

  const now = new Date().toISOString()

  await env.DB.prepare(
    `UPDATE secret_env_requests SET status = 'rejected', decided_by = ?1, decided_at = ?2 WHERE id = ?3 AND tenant = ?4`,
  )
    .bind(actorId, now, requestId, env.TENANT_SLUG)
    .run()

  await env.DB.prepare(
    `UPDATE secret_env_bindings SET status = 'revoked', revoked_at = ?1 WHERE tenant = ?2 AND request_id = ?3 AND status = 'pending'`,
  )
    .bind(now, env.TENANT_SLUG, requestId)
    .run()

  await writeSecretEnvAudit(env, {
    requestId,
    bindingName: null,
    action: 'reject',
    actorId,
    detail: null,
  })

  return { ok: true }
}

// ── resolveSecretEnv / resolveSecretEnvBinding (the ONLY read paths) ────────

/**
 * Raw env-binding accessor. Reads `(env as Record<string, unknown>)[bindingName]`
 * ONLY — it does NOT check D1 status itself (that would require an async call).
 * The caller MUST have verified the binding is `bound` via D1 first. Prefer
 * `resolveSecretEnvBinding` below, which does that check for you.
 */
export function resolveSecretEnv(env: Env, bindingName: string): string | null {
  const raw = (env as unknown as Record<string, unknown>)[bindingName]
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

/**
 * Preferred resolve path: SELECTs the binding's status (no secret column
 * exists — there is nothing to select there) and only reads the env binding
 * when status is `bound`. Fail-closed (null) for pending/revoked/absent.
 */
export async function resolveSecretEnvBinding(
  env: Env,
  bindingName: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT status FROM secret_env_bindings WHERE tenant = ?1 AND binding_name = ?2 LIMIT 1`,
  )
    .bind(env.TENANT_SLUG, bindingName)
    .first<{ status: SecretEnvBindingStatus }>()

  if (!row || row.status !== 'bound') return null
  return resolveSecretEnv(env, bindingName)
}
