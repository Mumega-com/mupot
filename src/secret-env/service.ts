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
//   resolveSecretEnvBinding()      — only public resolve path: D1 status=bound, then read env

import type { Env } from '../types'
import { assertBindingName } from './names'
import { getSecretEnvCfConfig, putScriptSecrets } from './cf-secrets'
import { rowsWritten } from '../lib/receipt'
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

// Abuse bounds per requester (hotfix: any verified account used to be able to
// file unlimited pending requests and squat binding names). Enforced ATOMICALLY in
// the guarded INSERT below, not by a read-then-write.
export const MAX_PENDING_REQUESTS_PER_REQUESTER = 5
export const MAX_REQUESTS_PER_REQUESTER_PER_HOUR = 10
/** A pending request older than this is EXPIRED: it no longer holds its binding
 * names, no longer counts toward the cap, and is no longer shown or bindable. */
export const PENDING_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000

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
  /** Connection channel the requester used (server-derived from auth, never args). Shown to the approving admin. */
  requestedChannel?: string | null
}

function parseRequestSchema(schemaJson: string): SecretEnvRequestSchema {
  const parsed = JSON.parse(schemaJson) as { keys?: unknown; adapterHint?: unknown; requestedChannel?: unknown }
  const keys = Array.isArray(parsed.keys)
    ? parsed.keys.filter((entry): entry is SecretEnvKeySpec => (
        typeof entry === 'object' && entry !== null
        && typeof (entry as Record<string, unknown>).name === 'string'
        && typeof (entry as Record<string, unknown>).purpose === 'string'
      ))
    : []
  const adapterHint = typeof parsed.adapterHint === 'string' ? parsed.adapterHint : null
  const requestedChannel = typeof parsed.requestedChannel === 'string' ? parsed.requestedChannel : null
  return { keys, adapterHint, requestedChannel }
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

// D1 surfaces UNIQUE constraint failures as an Error whose message contains
// "UNIQUE constraint failed". Concurrent same-name requests can pass the
// pre-check and still collide on UNIQUE (tenant, binding_name) — map to a stable
// conflict code instead of a 500.
function isSecretEnvBindingUniqueViolation(err: unknown): boolean {
  const messages: string[] = []
  let current: unknown = err
  while (current instanceof Error) {
    messages.push(current.message)
    current = current.cause
  }
  const combined = messages.join(' ')
  if (/UNIQUE constraint failed/i.test(combined)) return true
  return /constraint failed/i.test(combined) && /secret_env_bindings/i.test(combined)
}

// ── requestSecretEnv ─────────────────────────────────────────────────────────

export interface RequestSecretEnvParams {
  keys: SecretEnvKeySpec[]
  reason: string
  adapterHint: string | null
  requestedBy: string
  /** Server-derived connection channel of the caller (recorded for the admin queue). */
  requestedChannel?: string | null
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
  const { keys, reason, adapterHint, requestedBy, requestedChannel = null } = params

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

  // Pre-check existing bindings for every requested name (there is a UNIQUE
  // (tenant, binding_name) constraint on secret_env_bindings, so a blind
  // INSERT would race/collide on retry or on a second agent requesting the
  // same name). bound and LIVE-pending names are a hard conflict; revoked names
  // and EXPIRED pending names are reused in place (UPDATE, not a fresh INSERT)
  // below. This read is advisory (fast error codes) — the authoritative guard is
  // the conditional write in the batch, which re-checks everything atomically.
  const nowMs = Date.now()
  const now = new Date(nowMs).toISOString()
  const expiryCutoff = new Date(nowMs - PENDING_REQUEST_TTL_MS).toISOString()
  const hourCutoff = new Date(nowMs - 60 * 60 * 1000).toISOString()

  const names = keys.map((key) => key.name)
  const namePlaceholders = names.map((_, index) => `?${index + 2}`).join(', ')
  const existingResult = await env.DB.prepare(
    `SELECT id, binding_name, status, created_at FROM secret_env_bindings
      WHERE tenant = ?1 AND binding_name IN (${namePlaceholders})`,
  )
    .bind(env.TENANT_SLUG, ...names)
    .all<{ id: string; binding_name: string; status: SecretEnvBindingStatus; created_at: string }>()

  const existingByName = new Map(
    (existingResult.results ?? []).map((row) => [row.binding_name, row] as const),
  )
  for (const name of names) {
    const existing = existingByName.get(name)
    if (existing && (existing.status === 'bound' || (existing.status === 'pending' && existing.created_at >= expiryCutoff))) {
      return { ok: false, error: 'binding_name_conflict' }
    }
  }

  const id = crypto.randomUUID()
  const schemaJson = JSON.stringify({ keys, adapterHint, requestedChannel } satisfies SecretEnvRequestSchema)

  // The request row is inserted ONLY IF, evaluated inside this one statement:
  //   - the requester has fewer than MAX_PENDING live pending requests,
  //   - the requester has filed fewer than MAX_PER_HOUR requests in the last hour,
  //   - none of the names is bound or live-pending.
  // D1 executes each statement atomically, so N concurrent callers cannot all pass
  // a stale count (a KV/read-compare-put counter would). Every binding statement
  // below is in turn conditional on THIS request row existing, so a refused request
  // leaves no orphan binding rows.
  const nameListPlaceholders = names.map((_, index) => `?${index + 9}`).join(', ')
  const statements = [
    env.DB.prepare(
      `INSERT INTO secret_env_requests (id, tenant, reason, schema_json, status, requested_by, decided_by, created_at, decided_at)
       SELECT ?1, ?2, ?3, ?4, 'pending', ?5, NULL, ?6, NULL
        WHERE (SELECT COUNT(*) FROM secret_env_requests
                WHERE tenant = ?2 AND requested_by = ?5 AND status = 'pending' AND created_at >= ?7) < ${MAX_PENDING_REQUESTS_PER_REQUESTER}
          AND (SELECT COUNT(*) FROM secret_env_requests
                WHERE tenant = ?2 AND requested_by = ?5 AND created_at >= ?8) < ${MAX_REQUESTS_PER_REQUESTER_PER_HOUR}
          AND NOT EXISTS (SELECT 1 FROM secret_env_bindings
                WHERE tenant = ?2 AND binding_name IN (${nameListPlaceholders})
                  AND (status = 'bound' OR (status = 'pending' AND created_at >= ?7)))`,
    ).bind(id, env.TENANT_SLUG, reason, schemaJson, requestedBy, now, expiryCutoff, hourCutoff, ...names),
  ]

  for (const key of keys) {
    // Only 'revoked' / expired-'pending' rows can reach here (live pending/bound refused above).
    const existing = existingByName.get(key.name)
    if (existing) {
      statements.push(
        env.DB.prepare(
          `UPDATE secret_env_bindings
              SET purpose = ?1, adapter_hint = ?2, status = 'pending', requested_by = ?3,
                  bound_by = NULL, request_id = ?4, created_at = ?5, bound_at = NULL, revoked_at = NULL
            WHERE id = ?6 AND tenant = ?7
              AND (status = 'revoked' OR (status = 'pending' AND created_at < ?8))
              AND EXISTS (SELECT 1 FROM secret_env_requests WHERE id = ?4 AND tenant = ?7)`,
        ).bind(key.purpose, adapterHint, requestedBy, id, now, existing.id, env.TENANT_SLUG, expiryCutoff),
      )
    } else {
      statements.push(
        env.DB.prepare(
          `INSERT INTO secret_env_bindings (id, tenant, binding_name, purpose, adapter_hint, status, requested_by, bound_by, request_id, created_at, bound_at, revoked_at)
           SELECT ?1, ?2, ?3, ?4, ?5, 'pending', ?6, NULL, ?7, ?8, NULL, NULL
            WHERE EXISTS (SELECT 1 FROM secret_env_requests WHERE id = ?7 AND tenant = ?2)`,
        ).bind(crypto.randomUUID(), env.TENANT_SLUG, key.name, key.purpose, adapterHint, requestedBy, id, now),
      )
    }
  }

  // Atomic: the request row and every one of its binding rows land together
  // or not at all — no partial request-with-no-bindings state is observable.
  let batchResults: Awaited<ReturnType<typeof env.DB.batch>>
  try {
    batchResults = await env.DB.batch(statements)
  } catch (err) {
    if (isSecretEnvBindingUniqueViolation(err)) {
      return { ok: false, error: 'binding_name_conflict' }
    }
    throw err
  }

  if (rowsWritten(batchResults[0]) !== 1) {
    // The guarded INSERT refused. Diagnose (read-only, advisory) which bound tripped.
    const pendingCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM secret_env_requests
        WHERE tenant = ?1 AND requested_by = ?2 AND status = 'pending' AND created_at >= ?3`,
    ).bind(env.TENANT_SLUG, requestedBy, expiryCutoff).first<{ n: number }>()
    if ((pendingCount?.n ?? 0) >= MAX_PENDING_REQUESTS_PER_REQUESTER) {
      return { ok: false, error: 'too_many_pending_requests' }
    }
    const hourCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM secret_env_requests WHERE tenant = ?1 AND requested_by = ?2 AND created_at >= ?3`,
    ).bind(env.TENANT_SLUG, requestedBy, hourCutoff).first<{ n: number }>()
    if ((hourCount?.n ?? 0) >= MAX_REQUESTS_PER_REQUESTER_PER_HOUR) {
      return { ok: false, error: 'rate_limited' }
    }
    return { ok: false, error: 'binding_name_conflict' }
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
  const expiryCutoff = new Date(Date.now() - PENDING_REQUEST_TTL_MS).toISOString()
  // LEFT JOIN members so the approving admin sees WHO asked (id + email + channel);
  // a request from a principal with no member row still renders, with nulls.
  const rows = await env.DB.prepare(
    `SELECT r.id, r.tenant, r.reason, r.schema_json, r.status, r.requested_by, r.decided_by, r.created_at, r.decided_at,
            m.email AS requester_email
       FROM secret_env_requests r
       LEFT JOIN members m ON m.id = r.requested_by
      WHERE r.tenant = ?1 AND r.status = 'pending' AND r.created_at >= ?2
      ORDER BY r.created_at ASC`,
  )
    .bind(env.TENANT_SLUG, expiryCutoff)
    .all<SecretEnvRequestRow & { requester_email: string | null }>()

  return (rows.results ?? []).map((row) => ({
    ...toPublicRequest(row),
    requester_email: row.requester_email ?? null,
    requester_channel: parseRequestSchema(row.schema_json).requestedChannel ?? null,
  }))
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
  if (request.created_at < new Date(Date.now() - PENDING_REQUEST_TTL_MS).toISOString()) {
    return { ok: false, error: 'request_expired' }
  }

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
  const statements = [
    env.DB.prepare(
      `UPDATE secret_env_requests SET status = 'approved', decided_by = ?1, decided_at = ?2 WHERE id = ?3 AND tenant = ?4 AND status = 'pending'`,
    ).bind(actorId, now, requestId, env.TENANT_SLUG),
  ]
  for (const binding of pendingBindings) {
    statements.push(
      env.DB.prepare(
        `UPDATE secret_env_bindings SET status = 'bound', bound_by = ?1, bound_at = ?2 WHERE id = ?3 AND tenant = ?4`,
      ).bind(actorId, now, binding.id, env.TENANT_SLUG),
    )
    boundNames.push(binding.binding_name)
  }

  const batchResult = await env.DB.batch(statements)
  if (rowsWritten(batchResult[0]) !== 1) {
    return { ok: false, error: 'request_state_changed' }
  }

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

  const statements = [
    env.DB.prepare(
      `UPDATE secret_env_requests SET status = 'rejected', decided_by = ?1, decided_at = ?2 WHERE id = ?3 AND tenant = ?4 AND status = 'pending'`,
    ).bind(actorId, now, requestId, env.TENANT_SLUG),
    env.DB.prepare(
      `UPDATE secret_env_bindings SET status = 'revoked', revoked_at = ?1 WHERE tenant = ?2 AND request_id = ?3 AND status = 'pending'`,
    ).bind(now, env.TENANT_SLUG, requestId),
  ]

  const batchResult = await env.DB.batch(statements)
  if (rowsWritten(batchResult[0]) !== 1) {
    return { ok: false, error: 'request_state_changed' }
  }

  await writeSecretEnvAudit(env, {
    requestId,
    bindingName: null,
    action: 'reject',
    actorId,
    detail: null,
  })

  return { ok: true }
}

// ── resolveSecretEnvBinding (the ONLY public read path) ─────────────────────

/**
 * Raw env-binding read used internally after D1 status is verified. Not exported
 * so callers cannot bypass the bound-status gate.
 */
function readSecretEnvBindingValue(env: Env, bindingName: string): string | null {
  const raw = (env as unknown as Record<string, unknown>)[bindingName]
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

/**
 * Public resolve path: SELECTs the binding's status (no secret column exists —
 * there is nothing to select there) and only reads the env binding when status
 * is `bound`. Fail-closed (null) for pending/revoked/absent.
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
  return readSecretEnvBindingValue(env, bindingName)
}
