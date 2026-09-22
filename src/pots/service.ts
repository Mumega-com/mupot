// src/pots/service.ts — Cloudflare Workers for Platforms (WFP) Sovereign Pot Provisioner.
//
// mupot#1285: `provisionSovereignPot` used to create a D1 + KV, generate credentials it
// never wrote anywhere, and return `ok:true` — a success-shaped response for a tenant that
// could not be reached, logged into, or queried (no schema). This file is the completion:
// every step below is actually attempted, in order, fail-closed on the first failure, with
// a receipt written for each one (`pot_provision_receipts`, migration 0164) and returned in
// the response so a caller does not have to query the ledger separately to know what
// happened on THIS call. `ok` is true if and only if every step below ran and the tenant
// answered `/health` through the real dispatch path.

import type { R2Bucket } from '@cloudflare/workers-types'
import type { Env } from '../types'
import type {
  ProvisionStep, ProvisionStepReceipt,
  OrphanedResources, SovereignPotProvisionInput, SovereignPotProvisionResult, SovereignPotSummary } from './types'
import {
  applySchemaChain, recordedKey,
  type ApplySchemaChainResult,
} from './schema-chain'
import { sha256Hex } from '../members/service'
import { createCredentialClaim, type CredentialClaimHandle } from '../auth/credential-claim'

export const DISPATCH_NAMESPACE = 'mupot-pots'
export const DEFAULT_ROOT_DOMAIN = 'mupot.mumega.com'

// Slugs that can never name a tenant worker. Mirrored by the apex path router
// (src/dispatcher.ts) so reserved names fail fast instead of dispatching.
export const RESERVED_TENANT_SLUGS = new Set([
  'mumega',
  'mupot',
  'api',
  'admin',
  'dashboard',
  'auth',
  'oauth',
  'app',
  'studio',
  'copilot',
])

export function sanitizeSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export function validateSlug(slug: string): { ok: true } | { ok: false; error: string } {
  if (!slug || slug.length < 2) return { ok: false, error: 'Slug must be at least 2 characters.' }
  if (slug.length > 40) return { ok: false, error: 'Slug cannot exceed 40 characters.' }
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug)) {
    return { ok: false, error: 'Slug must start and end with alphanumeric characters and contain only letters, numbers, and dashes.' }
  }
  if (RESERVED_TENANT_SLUGS.has(slug)) {
    return { ok: false, error: `Slug '${slug}' is a reserved system domain.` }
  }
  return { ok: true }
}

export interface CloudflareApiConfig {
  accountId: string
  apiToken: string
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function createD1Database(
  cf: CloudflareApiConfig,
  dbName: string,
): Promise<{ uuid: string; name: string }> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/d1/database`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cf.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: dbName }),
  })
  const data = (await res.json()) as { success: boolean; result: { uuid: string; name: string }; errors: Array<{ message: string }> }
  if (!data.success || !data.result) {
    const msg = data.errors?.[0]?.message || `HTTP ${res.status}`
    throw new Error(`Failed to create D1 database '${dbName}': ${msg}`)
  }
  return data.result
}

/** GET the D1 database list filtered by name. Cloudflare's `name` query param is not
 *  documented as an exact-match server-side filter (research 2026-09-04,
 *  docs/d1-rest-and-wfp-provisioning-limits-2026-09-04.md covers `/query`/`/import`, not
 *  this list endpoint specifically) — so this ALSO filters client-side on an exact name
 *  match, which is correct whether or not the server already narrowed the list. Returns
 *  `null` on anything that is not a clean, well-formed match (never throws for "not
 *  found" — only for a genuine transport/parse failure, via the caller's `fetch`). */
export async function findD1DatabaseByName(
  cf: CloudflareApiConfig,
  name: string,
): Promise<{ uuid: string; name: string } | null> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/d1/database?name=${encodeURIComponent(name)}`,
    { method: 'GET', headers: { Authorization: `Bearer ${cf.apiToken}` } },
  )
  const data = (await res.json()) as { success: boolean; result?: unknown }
  if (!data.success || !Array.isArray(data.result)) return null
  const match = (data.result as Array<{ uuid?: string; name?: string }>).find((d) => d.name === name)
  if (!match || !match.uuid || !match.name) return null
  return { uuid: match.uuid, name: match.name }
}

/** Reuse-or-create, idempotent on `dbName` (mupot#1285). A prior provisioning attempt
 *  that created the D1 and then failed a later step left a REAL, billable, still-useful
 *  database behind (e.g. Psychonom's `mupot-pot-psychonom`, `b0568c25-...`, orphaned
 *  2026-09-22) — a retry must adopt it, not create a second one under the same name
 *  (Cloudflare allows duplicate D1 names; nothing else would ever catch that). */
export async function getOrCreateD1Database(
  cf: CloudflareApiConfig,
  dbName: string,
): Promise<{ uuid: string; name: string; adopted: boolean }> {
  const existing = await findD1DatabaseByName(cf, dbName)
  if (existing) return { ...existing, adopted: true }
  const created = await createD1Database(cf, dbName)
  return { ...created, adopted: false }
}

export async function createKVNamespace(
  cf: CloudflareApiConfig,
  title: string,
): Promise<{ id: string; title: string }> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/storage/kv/namespaces`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cf.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title }),
  })
  const data = (await res.json()) as { success: boolean; result: { id: string; title: string }; errors: Array<{ message: string }> }
  if (!data.success || !data.result) {
    const msg = data.errors?.[0]?.message || `HTTP ${res.status}`
    throw new Error(`Failed to create KV namespace '${title}': ${msg}`)
  }
  return data.result
}

/** The KV namespace list endpoint has no documented title filter, so this paginates
 *  (100/page, capped at `maxPages` — 2,000 namespaces is far beyond anything one account
 *  provisions through this path) and matches client-side. Stops at the first short page
 *  (fewer than `perPage` results), the standard "last page" signal for this API shape. */
export async function findKVNamespaceByTitle(
  cf: CloudflareApiConfig,
  title: string,
  maxPages = 20,
): Promise<{ id: string; title: string } | null> {
  const perPage = 100
  for (let page = 1; page <= maxPages; page += 1) {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/storage/kv/namespaces?page=${page}&per_page=${perPage}`,
      { method: 'GET', headers: { Authorization: `Bearer ${cf.apiToken}` } },
    )
    const data = (await res.json()) as { success: boolean; result?: unknown }
    if (!data.success || !Array.isArray(data.result)) return null
    const page_ = data.result as Array<{ id?: string; title?: string }>
    const match = page_.find((ns) => ns.title === title)
    if (match?.id && match.title) return { id: match.id, title: match.title }
    if (page_.length < perPage) return null // last page, no match
  }
  return null
}

/** Reuse-or-create, idempotent on `title` — same reasoning as getOrCreateD1Database. */
export async function getOrCreateKVNamespace(
  cf: CloudflareApiConfig,
  title: string,
): Promise<{ id: string; title: string; adopted: boolean }> {
  const existing = await findKVNamespaceByTitle(cf, title)
  if (existing) return { ...existing, adopted: true }
  const created = await createKVNamespace(cf, title)
  return { ...created, adopted: false }
}

/** D1 REST `/query` result shape: an array, one element per statement in the request body.
 *  This module always sends exactly one statement per call, so callers read `result[0]`. */
type D1QueryStatementResult = { results?: Array<Record<string, unknown>>; success?: boolean }

export async function executeD1Query(
  cf: CloudflareApiConfig,
  databaseId: string,
  sql: string,
  params: unknown[] = [],
): Promise<D1QueryStatementResult[]> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/d1/database/${databaseId}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cf.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  })
  const data = (await res.json()) as { success: boolean; result: D1QueryStatementResult[]; errors: Array<{ message: string }> }
  if (!data.success) {
    const msg = data.errors?.[0]?.message || `HTTP ${res.status}`
    throw new Error(`D1 query failed: ${msg}`)
  }
  return Array.isArray(data.result) ? data.result : []
}

/** Wraps `executeD1Query` as the fetch-free `exec` signature `applySchemaChain`
 *  (src/pots/schema-chain.ts) requires — ONE D1 REST call per chain statement, so a
 *  failure's `statementIndex` is exact with no batching-induced ambiguity. This is a
 *  documented trade-off, not an oversight: the schema chain is currently 152 files /
 *  ~970 statements, i.e. ~970 sequential REST round trips per fresh provision. The
 *  research this slice is built on (docs/d1-rest-and-wfp-provisioning-limits-2026-09-04.md)
 *  recommends the D1 `/import` bulk API for production volume instead — deliberately NOT
 *  used here because `/import` is one atomic whole-file operation with no per-statement
 *  granularity, which would silently give up the exact "which statement failed" receipt
 *  #1285 asks for. See docs/workflows/tenant-provision.md for the full trade-off writeup
 *  and the concrete follow-up (batch happy-path statements, fall back to one-at-a-time
 *  only after a batch fails, to get both speed and precision).
 */
function makeD1Exec(cf: CloudflareApiConfig, databaseId: string): (sql: string) => Promise<void> {
  return async (sql: string) => {
    await executeD1Query(cf, databaseId, sql)
  }
}

/** Reads `pot_schema_applied` (src/pots/schema-chain.ts) from the pot's own D1 and turns it
 *  into the `alreadyApplied` set `applySchemaChain` expects. A FRESH D1 has no such table
 *  yet — that specific "no such table" error is the one case read as "nothing applied yet",
 *  everything else is a genuine failure to read and is NOT silently treated as empty (fail
 *  closed: an unreadable bookkeeping table must not be mistaken for a virgin database, or a
 *  transient read failure could cause the whole chain to be replayed against an
 *  already-partially-applied database). */
async function loadAlreadyAppliedSet(cf: CloudflareApiConfig, databaseId: string): Promise<Set<string>> {
  let rows: Array<Record<string, unknown>> = []
  try {
    const result = await executeD1Query(
      cf,
      databaseId,
      'SELECT file, sha256, splitter_version, status FROM pot_schema_applied',
    )
    rows = result[0]?.results ?? []
  } catch (error) {
    if (/no such table/i.test(errMsg(error))) return new Set()
    throw error
  }
  const set = new Set<string>()
  for (const row of rows) {
    const status = row.status
    if (status !== 'started' && status !== 'applied') continue
    set.add(recordedKey(String(row.file), String(row.sha256), Number(row.splitter_version), status))
  }
  return set
}

/** R2 custom-metadata key the CI publish step (docs/workflows/tenant-provision.md, "CI
 *  publish output contract") must set on every `${RELEASE_SHA}/worker.js` object it
 *  writes — the hex sha256 of the EXACT bytes being uploaded. `loadPotWorkerBundle`
 *  recomputes the digest of what it reads back and refuses to deploy on any mismatch or
 *  absence, rather than trusting an R2 GET that merely succeeded. */
export const POT_WORKER_BUNDLE_SHA256_METADATA_KEY = 'sha256'

export interface PotWorkerBundle {
  code: string
  /** 'r2': fetched from POT_WORKER_BUNDLE_BUCKET keyed by RELEASE_SHA — the production
   *  target (docs/workflows/tenant-provision.md option B), digest-verified against the
   *  CI publish step's own recorded sha256 before use. 'explicit': the caller supplied
   *  `worker_js_code` directly — the interim path that needs no new CF infrastructure
   *  (option C), produced today via `wrangler deploy --dry-run --outdir` (see
   *  scripts/build-pot-worker-bundle.mjs). Nothing published anywhere verifies it — it is
   *  still digest-RECEIPTED (`sha256` below), never silently deployed unaccounted-for
   *  ("an unpinned fallback is an unsigned binary on the control plane"). */
  source: 'r2' | 'explicit'
  /** sha256Hex(code) — recorded on the `deploy_worker` receipt regardless of source, so
   *  exactly which bytes got deployed is always auditable after the fact. For `source:
   *  'r2'` this is, by construction, equal to the object's own recorded digest (the
   *  mismatch case never reaches this type — see `loadPotWorkerBundle`). */
  sha256: string
  /** Only set for `source: 'r2'` — which published object this bundle came from. */
  r2ObjectKey?: string
}

export type LoadPotWorkerBundleResult =
  | { ok: true; bundle: PotWorkerBundle }
  | { ok: false; reason: string }

/**
 * The tenant script body is THIS worker's own built bundle (mupot#1285 requirement 3).
 * Three options were on the table (full trade-off in docs/workflows/tenant-provision.md):
 *
 *   A. The worker fetches its OWN script content back from the CF API
 *      (`.../scripts/{name}/content/v2`) and re-uploads it. REJECTED — prior research
 *      (docs/d1-rest-and-wfp-provisioning-limits-2026-09-04.md point 4) found this
 *      endpoint's multi-module completeness and format entirely undocumented; two
 *      independent unverified gaps compounding is not a foundation for a provisioning
 *      path that is supposed to be MORE honest than what it replaces.
 *   B. CI publishes the built bundle to R2 at deploy time, keyed by RELEASE_SHA; this
 *      function reads it back. This is the PRODUCTION target (recorded on the issue as
 *      the 2026-09-04 S2 design decision) — checked FIRST, below.
 *   C. The caller passes the bundle text directly (`worker_js_code` / the legacy
 *      positional `workerJsCode` argument). Works TODAY with zero new Cloudflare
 *      resources — this session is explicitly barred from creating any — so it is the
 *      one this PR can actually exercise end-to-end. Checked second, as the fallback.
 *
 * Neither source configured is a hard, named failure (`deploy_worker` step fails with a
 * specific reason) — never a silent skip like the pre-#1285 `if (workerJsCode)` branch.
 *
 * DIGEST VERIFICATION (mupot#1507 round-2 requirement 4): an R2 GET that returns 200 only
 * proves the bytes were *readable*, not that they are the bytes CI actually built —
 * silent corruption, a partial multipart write, or a stale/overwritten key would all read
 * back successfully. So a `source: 'r2'` bundle is trusted only when the object carries
 * its own recorded digest (`POT_WORKER_BUNDLE_SHA256_METADATA_KEY` custom metadata,
 * written by the CI publish step) AND that digest matches what this function itself
 * computes from the bytes it just read. A TRANSPORT failure (the GET call throwing) still
 * falls through to the explicit fallback, same as before — but an object that EXISTS and
 * fails its own digest check is a hard, named `deploy_worker` failure, never a silent
 * fallback to a possibly-stale explicit bundle: falling back would mask exactly the
 * tampering/corruption this check exists to catch.
 */
export async function loadPotWorkerBundle(
  env: Env,
  explicitCode?: string,
): Promise<LoadPotWorkerBundleResult> {
  if (env.POT_WORKER_BUNDLE_BUCKET) {
    const key = `${env.RELEASE_SHA || 'unknown'}/worker.js`
    let obj: Awaited<ReturnType<R2Bucket['get']>> = null
    try {
      obj = await env.POT_WORKER_BUNDLE_BUCKET.get(key)
    } catch {
      obj = null // Transport failure — fall through to the explicit path below.
    }
    if (obj) {
      const code = await obj.text()
      const actualSha256 = await sha256Hex(code)
      const expectedSha256 = obj.customMetadata?.[POT_WORKER_BUNDLE_SHA256_METADATA_KEY]
      if (!expectedSha256) {
        return {
          ok: false,
          reason:
            `R2 object '${key}' carries no '${POT_WORKER_BUNDLE_SHA256_METADATA_KEY}' custom ` +
            'metadata — the CI publish step must record the digest it built (see ' +
            'docs/workflows/tenant-provision.md, "CI publish output contract"); an unpinned ' +
            'R2 artifact cannot be trusted, and this is not silently treated as "no bundle" ' +
            'because one clearly exists — falling back to worker_js_code would mask that.',
        }
      }
      if (expectedSha256 !== actualSha256) {
        return {
          ok: false,
          reason:
            `R2 object '${key}' digest mismatch: recorded ${expectedSha256}, computed ` +
            `${actualSha256} from the bytes actually read back — refusing to deploy a ` +
            'bundle that does not match its own published digest.',
        }
      }
      return { ok: true, bundle: { code, source: 'r2', sha256: actualSha256, r2ObjectKey: key } }
    }
  }
  if (explicitCode && explicitCode.trim().length > 0) {
    return { ok: true, bundle: { code: explicitCode, source: 'explicit', sha256: await sha256Hex(explicitCode) } }
  }
  return {
    ok: false,
    reason:
      'no worker bundle available: POT_WORKER_BUNDLE_BUCKET has no object for the current ' +
      'RELEASE_SHA and no worker_js_code was supplied — see docs/workflows/tenant-provision.md',
  }
}

export async function uploadUserWorkerToDispatch(
  cf: CloudflareApiConfig,
  scriptName: string,
  workerJsCode: string,
  bindings: {
    d1DatabaseId: string
    kvNamespaceId: string
    tenantSlug: string
    brandName: string
    publicOrigin: string
    /** Stamped so the tenant's own GET /health can report which build it is running —
     *  mirrors what scripts/deploy.mjs already does for the colony worker
     *  (RELEASE_SHA, mupot#443). Falls back to 'unknown' rather than omitting the
     *  binding, so a tenant Worker's /health never crashes on a missing var. */
    releaseSha?: string
  },
): Promise<{ id: string }> {
  const metadata = {
    main_module: 'worker.js',
    bindings: [
      { type: 'd1', name: 'DB', id: bindings.d1DatabaseId },
      { type: 'kv_namespace', name: 'SESSIONS', namespace_id: bindings.kvNamespaceId },
      { type: 'plain_text', name: 'TENANT_SLUG', text: bindings.tenantSlug },
      { type: 'plain_text', name: 'BRAND', text: bindings.brandName },
      { type: 'plain_text', name: 'PUBLIC_ORIGIN', text: bindings.publicOrigin },
      { type: 'plain_text', name: 'RELEASE_SHA', text: bindings.releaseSha || 'unknown' },
    ],
    compatibility_date: '2026-06-01',
    compatibility_flags: ['nodejs_compat'],
  }

  const formData = new FormData()
  formData.append(
    'metadata',
    new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
    'metadata.json',
  )
  formData.append(
    'worker.js',
    new Blob([workerJsCode], { type: 'application/javascript+module' }),
    'worker.js',
  )

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/workers/dispatch/namespaces/${DISPATCH_NAMESPACE}/scripts/${scriptName}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${cf.apiToken}`,
      },
      body: formData,
    },
  )
  const data = (await res.json()) as { success: boolean; result: { id: string }; errors: Array<{ message: string }> }
  if (!data.success || !data.result) {
    const msg = data.errors?.[0]?.message || `HTTP ${res.status}`
    throw new Error(`Failed to upload User Worker to dispatch namespace: ${msg}`)
  }
  return data.result
}

export interface SeedIdentitiesInput {
  slug: string
  brandName: string
  adminEmail: string
  adminName?: string
}

export interface SeedIdentitiesResult {
  ok: boolean
  /** True when an admin member with this email already existed — this call minted NO new
   *  rows or tokens. A raw token hashed on a prior attempt cannot be recovered (by design:
   *  src/members/service.ts sha256Hex stores only the hash), so a retry against an
   *  already-seeded pot returns no credential at all rather than a second, silently
   *  divergent one — the normal token-mint path (mint_agent_token / the dashboard) is how
   *  an operator gets a fresh credential for an already-seeded pot. */
  alreadySeeded: boolean
  adminMemberId: string
  adminRawToken: string | null
  /** sha256(rawToken).slice(0, 16) — IDENTICAL derivation to
   *  `CredentialClaimHandle.fingerprint` (src/auth/credential-claim.ts), and in fact
   *  always recoverable as `member_tokens.token_hash.slice(0, 16)` since token_hash IS
   *  the full un-truncated sha256Hex(raw). Safe to write into the (parent-owned)
   *  `pot_provision_receipts` ledger — it authenticates nothing, so recording it there
   *  gives the parent a permanently queryable bootstrap record WITHOUT granting the
   *  parent any standing on the child pot's own credential plane (see
   *  docs/workflows/tenant-provision.md, "the provisioner's authority ends at the
   *  handover"). Populated on BOTH a fresh seed and an `alreadySeeded` retry (the retry
   *  path reads the stored `token_hash` back rather than needing the raw value again). */
  adminTokenFingerprint: string | null
  leadAgentId: string
  leadAgentMemberId: string
  leadAgentRawToken: string | null
  leadAgentTokenFingerprint: string | null
  detail?: string
}

/**
 * Seeds the MINIMAL identities a freshly-schema'd pot needs to be operable (mupot#1285
 * requirement 4): one core department + squad, an org-owner admin member, and the
 * seed-seat lead agent (`<slug>-bot`, the "seed seat + mubot per pot" pattern) with its
 * own home member (member_tokens.member_id is NOT NULL — a token bound to an agent still
 * needs an owning member row; agents.owner_member_id records which one). Tokens are
 * stored HASHED with the exact same `sha256Hex` (src/members/service.ts) the main pot's
 * token verification path uses — a pot's dashboard login checks a sha256 hex digest
 * against `member_tokens.token_hash`, so seeding with any other digest would silently
 * mint a credential that could never authenticate.
 *
 * Idempotent on `adminEmail`: a retried provisioning call (the D1 already has a schema
 * and may already be seeded from an earlier attempt) checks for an existing admin member
 * FIRST and returns early rather than inserting a second department/squad/member set.
 */
export async function seedPotIdentities(
  cf: CloudflareApiConfig,
  databaseId: string,
  input: SeedIdentitiesInput,
): Promise<SeedIdentitiesResult> {
  const existing = await executeD1Query(
    cf,
    databaseId,
    'SELECT id FROM members WHERE email = ?1 LIMIT 1',
    [input.adminEmail],
  )
  const existingAdmin = existing[0]?.results?.[0] as { id?: string } | undefined
  if (existingAdmin?.id) {
    const agentRows = await executeD1Query(
      cf,
      databaseId,
      'SELECT id FROM agents WHERE slug = ?1 LIMIT 1',
      [`${input.slug}-bot`],
    )
    const existingAgent = agentRows[0]?.results?.[0] as { id?: string } | undefined

    // Fingerprints are recoverable from the STORED hash — no raw value needed, and none
    // exists to recover (sha256Hex is one-way by design). Missing rows (e.g. a schema
    // that predates the seed-seat token) fingerprint as null rather than throwing.
    const adminTokenRows = await executeD1Query(
      cf,
      databaseId,
      "SELECT token_hash FROM member_tokens WHERE member_id = ?1 AND label = 'admin' ORDER BY created_at DESC LIMIT 1",
      [existingAdmin.id],
    )
    const adminTokenHash = (adminTokenRows[0]?.results?.[0] as { token_hash?: string } | undefined)?.token_hash ?? null

    let leadAgentTokenHash: string | null = null
    if (existingAgent?.id) {
      const leadAgentTokenRows = await executeD1Query(
        cf,
        databaseId,
        "SELECT token_hash FROM member_tokens WHERE agent_id = ?1 AND label = 'seed-seat' ORDER BY created_at DESC LIMIT 1",
        [existingAgent.id],
      )
      leadAgentTokenHash = (leadAgentTokenRows[0]?.results?.[0] as { token_hash?: string } | undefined)?.token_hash ?? null
    }

    return {
      ok: true,
      alreadySeeded: true,
      adminMemberId: existingAdmin.id,
      adminRawToken: null,
      adminTokenFingerprint: adminTokenHash ? adminTokenHash.slice(0, 16) : null,
      leadAgentId: existingAgent?.id ?? '',
      leadAgentMemberId: '',
      leadAgentRawToken: null,
      leadAgentTokenFingerprint: leadAgentTokenHash ? leadAgentTokenHash.slice(0, 16) : null,
      detail: `admin member already exists for ${input.adminEmail} — seeding skipped, no new tokens minted`,
    }
  }

  const now = new Date().toISOString()
  const departmentId = crypto.randomUUID()
  const squadId = crypto.randomUUID()
  const adminMemberId = crypto.randomUUID()
  const leadAgentMemberId = crypto.randomUUID()
  const leadAgentId = crypto.randomUUID()
  const adminRawToken = `pot_adm_${crypto.randomUUID().replace(/-/g, '')}`
  const leadAgentRawToken = `pot_agt_${crypto.randomUUID().replace(/-/g, '')}`
  const adminTokenHash = await sha256Hex(adminRawToken)
  const leadAgentTokenHash = await sha256Hex(leadAgentRawToken)
  const brandName = input.brandName
  const leadAgentName = `${brandName} Lead Agent`

  const steps: Array<{ sql: string; params: unknown[] }> = [
    {
      sql: 'INSERT INTO departments (id, slug, name, kind, active, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
      params: [departmentId, 'core', brandName, 'work', 1, now],
    },
    {
      sql: 'INSERT INTO squads (id, department_id, slug, name, kind, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
      params: [squadId, departmentId, 'core', 'Core', 'work', now],
    },
    {
      sql: 'INSERT INTO members (id, email, display_name, status, tenant, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
      params: [adminMemberId, input.adminEmail, input.adminName || brandName, 'active', input.slug, now],
    },
    {
      sql: 'INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
      params: [crypto.randomUUID(), adminMemberId, 'org', null, 'owner', now],
    },
    {
      sql: 'INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
      params: [crypto.randomUUID(), adminMemberId, adminTokenHash, 'admin', 'dashboard', now, input.slug],
    },
    {
      // The seed-seat agent's own "home" identity — see the function doc comment for why
      // an agent still needs a member row to hold a token.
      sql: 'INSERT INTO members (id, email, display_name, status, tenant, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
      params: [leadAgentMemberId, null, leadAgentName, 'active', input.slug, now],
    },
    {
      sql: 'INSERT INTO agents (id, squad_id, slug, name, role, status, kind, owner_member_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)',
      params: [leadAgentId, squadId, `${input.slug}-bot`, leadAgentName, 'lead', 'active', 'work', leadAgentMemberId, now],
    },
    {
      sql: 'INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
      params: [crypto.randomUUID(), leadAgentMemberId, 'squad', squadId, 'lead', now],
    },
    {
      sql: 'INSERT INTO member_tokens (id, member_id, agent_id, token_hash, label, channel, created_at, tenant) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
      params: [crypto.randomUUID(), leadAgentMemberId, leadAgentId, leadAgentTokenHash, 'seed-seat', 'workspace', now, input.slug],
    },
  ]

  for (let i = 0; i < steps.length; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- later inserts reference earlier rows (FKs)
      await executeD1Query(cf, databaseId, steps[i].sql, steps[i].params)
    } catch (error) {
      return {
        ok: false,
        alreadySeeded: false,
        adminMemberId,
        adminRawToken: null,
        adminTokenFingerprint: null,
        leadAgentId,
        leadAgentMemberId,
        leadAgentRawToken: null,
        leadAgentTokenFingerprint: null,
        detail: `seed statement ${i} (${steps[i].sql.slice(0, 40)}...) failed: ${errMsg(error)}`,
      }
    }
  }

  return {
    ok: true,
    alreadySeeded: false,
    adminMemberId,
    adminRawToken,
    adminTokenFingerprint: adminTokenHash.slice(0, 16),
    leadAgentId,
    leadAgentMemberId,
    leadAgentRawToken,
    leadAgentTokenFingerprint: leadAgentTokenHash.slice(0, 16),
  }
}

export interface ReachabilityCheckResult {
  ok: boolean
  status: number | null
  detail: string
}

/**
 * Verifies `/health` through the SAME internal path production traffic uses —
 * `src/dispatcher.ts`'s default `fetch`, which resolves the tenant from the REQUEST
 * HOSTNAME (`extractTenantSlug`) and calls `env.DISPATCHER.get(slug).fetch(request)`.
 * This is deliberately NOT a real `fetch()` to `https://{slug}.mupot.mumega.com/health` —
 * that address is TLS-dead by construction (Cloudflare Universal SSL covers `mumega.com`
 * and `*.mumega.com`, not the second-level wildcard `*.mupot.mumega.com`; measured
 * 2026-09-03/04, reconfirmed live 2026-09-22: `curl https://gaf.mupot.mumega.com/health`
 * fails the TLS handshake before HTTP begins, HTTP 000). `env.DISPATCHER.get(name).fetch()`
 * never does DNS or TLS at all — it is a Workers-for-Platforms binding call, and the
 * hostname on the synthetic Request below exists ONLY so `extractTenantSlug` can read the
 * slug out of it, exactly like the real `/t/{slug}/...` apex-path route
 * (`resolveApexPathTenant` in src/dispatcher.ts) rewrites a request's hostname before
 * calling the same `dispatcher.fetch`. This is the answer to the open question of why
 * `gaf.mupot.mumega.com` returns HTTP 000 from outside while `/t/gaf/health` answers 200
 * in production: the internal call never leaves the Worker.
 */
export async function verifyPotReachable(
  env: Env,
  slug: string,
  rootDomain: string,
): Promise<ReachabilityCheckResult> {
  if (!env.DISPATCHER) {
    return { ok: false, status: null, detail: 'DISPATCHER binding not configured on this Worker — cannot verify reachability.' }
  }
  const healthUrl = `https://${slug}.${rootDomain}/health`
  const request = new Request(healthUrl, { method: 'GET', headers: { accept: 'application/json' } })
  try {
    // Dynamic import (not a static one) to avoid a load-time circular import: src/dispatcher.ts
    // imports RESERVED_TENANT_SLUGS from THIS file.
    const dispatcherModule = await import('../dispatcher')
    const response = await dispatcherModule.default.fetch(request, {
      DISPATCHER: env.DISPATCHER,
      ROOT_DOMAIN: rootDomain,
    })
    const bodyText = await response.text().catch(() => '')
    if (response.status !== 200) {
      return {
        ok: false,
        status: response.status,
        detail: `GET /t/${slug}/health returned HTTP ${response.status}: ${bodyText.slice(0, 500)}`,
      }
    }
    return { ok: true, status: response.status, detail: bodyText.slice(0, 500) }
  } catch (error) {
    return { ok: false, status: null, detail: `dispatch to '${slug}' threw: ${errMsg(error)}` }
  }
}

/** Best-effort append to `pot_provision_receipts` (migration 0164) on the ORCHESTRATOR's
 *  own D1 (`env.DB` — the same database that carries `pots`, migration 0145), never the
 *  tenant's new pot D1. A write failure here must not itself brick provisioning — the
 *  ledger is a durable AUDIT TRAIL, not a gate — but it never silently disappears from
 *  THIS call's own response either way, since `receipts` in `SovereignPotProvisionResult`
 *  is built from the same in-memory data independent of whether the row landed. */
async function writeProvisionReceipt(
  env: Env,
  runId: string,
  slug: string,
  step: ProvisionStep,
  ok: boolean,
  detail: string | null,
): Promise<void> {
  try {
    await env.DB.prepare(
      'INSERT INTO pot_provision_receipts (id, tenant, slug, run_id, step, ok, detail, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)',
    )
      .bind(crypto.randomUUID(), env.TENANT_SLUG ?? 'mumega', slug, runId, step, ok ? 1 : 0, detail, new Date().toISOString())
      .run()
  } catch {
    // Swallowed deliberately — see doc comment above.
  }
}

export async function listSovereignPots(
  cf: CloudflareApiConfig,
  rootDomain = DEFAULT_ROOT_DOMAIN,
): Promise<SovereignPotSummary[]> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/workers/dispatch/namespaces/${DISPATCH_NAMESPACE}/scripts`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${cf.apiToken}`,
      },
    },
  )
  const data = (await res.json()) as {
    success: boolean
    result: Array<{ id: string; created_on?: string; modified_on?: string }>
  }
  if (!data.success || !data.result) return []

  return data.result.map((item) => ({
    slug: item.id,
    script_name: item.id,
    created_on: item.created_on,
    modified_on: item.modified_on,
    public_url: `https://${item.id}.${rootDomain}`,
    status: 'active',
  }))
}

const ALL_PROVISION_STEPS: ProvisionStep[] =
  ['create_d1', 'create_kv', 'apply_schema', 'deploy_worker', 'seed_identities', 'verify_reachable']

export async function provisionSovereignPot(
  env: Env,
  input: SovereignPotProvisionInput,
  workerJsCode?: string,
): Promise<SovereignPotProvisionResult> {
  const slug = sanitizeSlug(input.slug)
  const valid = validateSlug(slug)
  if (!valid.ok) {
    throw new Error(valid.error)
  }

  const accountId = input.account_id || env.SECRET_ENV_CF_ACCOUNT_ID || 'e39eaf94f33092c4efd029d94ae1e9dd'
  const apiToken = input.cf_api_token || env.SECRET_ENV_CF_API_TOKEN
  if (!apiToken) {
    throw new Error('Cloudflare API Token not configured for pot provisioning.')
  }

  const cf: CloudflareApiConfig = { accountId, apiToken }

  const runId = crypto.randomUUID()
  const completed: ProvisionStep[] = []
  const receipts: ProvisionStepReceipt[] = []
  const orphans: OrphanedResources = {
    d1_database_id: null, d1_database_name: null, d1_adopted: false,
    kv_namespace_id: null, kv_namespace_title: null, kv_adopted: false,
  }

  const recordStep = async (step: ProvisionStep, ok: boolean, detail: string | null): Promise<void> => {
    receipts.push({ step, ok, detail })
    await writeProvisionReceipt(env, runId, slug, step, ok, detail)
    if (ok) completed.push(step)
  }

  // PATH, NOT SUBDOMAIN — see verifyPotReachable's doc comment for the full TLS story.
  // Cloudflare Universal SSL covers `mumega.com` and `*.mumega.com`, but NOT a
  // second-level wildcard like `*.mupot.mumega.com` without Advanced Certificate
  // Manager. `/t/{slug}/...` is served today (src/index.ts calls routeApexPathTenant on
  // every request; src/dispatcher.ts's resolveApexPathTenant/dispatcher.fetch do the
  // actual dispatch) — the subdomain form is kept nowhere in this file's OUTPUT, only as
  // the internal Request hostname verifyPotReachable uses to select a tenant via the
  // DISPATCHER binding, which never touches real DNS/TLS.
  const rootDomain = env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN).hostname : DEFAULT_ROOT_DOMAIN
  const publicOrigin = `https://${rootDomain}/t/${slug}`
  const tier = input.plan_tier || 'enterprise'
  const leadAgentName = `${input.brand_name} Lead Agent`

  const bail = (reason: string): SovereignPotProvisionResult => {
    const notCompleted = ALL_PROVISION_STEPS.filter((step) => !completed.includes(step))
    return {
      ok: false,
      status: 'incomplete',
      completed,
      not_completed: notCompleted,
      orphaned_resources: orphans,
      incomplete_reason: reason,
      run_id: runId,
      receipts,
      slug,
      brand_name: input.brand_name,
      plan_tier: tier,
      d1_database_id: orphans.d1_database_id ?? '',
      d1_database_name: orphans.d1_database_name ?? '',
      kv_namespace_id: orphans.kv_namespace_id ?? '',
      kv_namespace_title: orphans.kv_namespace_title ?? '',
      dispatch_namespace: DISPATCH_NAMESPACE,
      worker_script_name: slug,
      public_origin: publicOrigin,
      admin_email: input.admin_email,
      admin_member_id: '',
      admin_token: null,
      admin_login_url: null,
      admin_credential_claim: null,
      lead_agent_id: '',
      lead_agent_name: leadAgentName,
      lead_agent_token: null,
      lead_agent_credential_claim: null,
      provisioned_at: new Date().toISOString(),
    }
  }

  // 1. D1 — reuse-or-create, idempotent on slug.
  const dbName = `mupot-pot-${slug}`
  let d1: { uuid: string; name: string; adopted: boolean }
  try {
    d1 = await getOrCreateD1Database(cf, dbName)
  } catch (error) {
    await recordStep('create_d1', false, errMsg(error))
    return bail(`create_d1 failed: ${errMsg(error)}`)
  }
  orphans.d1_database_id = d1.uuid
  orphans.d1_database_name = d1.name
  orphans.d1_adopted = d1.adopted
  await recordStep('create_d1', true, d1.adopted ? `adopted existing database ${d1.uuid}` : `created ${d1.uuid}`)

  // 2. KV — reuse-or-create, idempotent on slug.
  const kvTitle = `mupot-pot-${slug}-kv`
  let kv: { id: string; title: string; adopted: boolean }
  try {
    kv = await getOrCreateKVNamespace(cf, kvTitle)
  } catch (error) {
    await recordStep('create_kv', false, errMsg(error))
    return bail(`create_kv failed: ${errMsg(error)}`)
  }
  orphans.kv_namespace_id = kv.id
  orphans.kv_namespace_title = kv.title
  orphans.kv_adopted = kv.adopted
  await recordStep('create_kv', true, kv.adopted ? `adopted existing namespace ${kv.id}` : `created ${kv.id}`)

  // 3. Apply the schema chain (src/pots/schema-chain.ts) via the D1 REST API.
  let alreadyApplied: Set<string>
  try {
    alreadyApplied = await loadAlreadyAppliedSet(cf, d1.uuid)
  } catch (error) {
    await recordStep('apply_schema', false, `could not read pot_schema_applied: ${errMsg(error)}`)
    return bail(`apply_schema failed reading bookkeeping: ${errMsg(error)}`)
  }
  let schemaResult: ApplySchemaChainResult
  try {
    schemaResult = await applySchemaChain(makeD1Exec(cf, d1.uuid), { alreadyApplied })
  } catch (error) {
    await recordStep('apply_schema', false, errMsg(error))
    return bail(`apply_schema threw: ${errMsg(error)}`)
  }
  if (schemaResult.failed) {
    const detail =
      `file=${schemaResult.failed.file} statementIndex=${schemaResult.failed.statementIndex} ` +
      `kind=${schemaResult.failed.kind}: ${schemaResult.failed.error}`
    await recordStep('apply_schema', false, detail)
    return bail(`apply_schema failed: ${detail}`)
  }
  await recordStep(
    'apply_schema',
    true,
    `applied ${schemaResult.applied.length} file(s), skipped ${schemaResult.skipped.length} already-applied`,
  )

  // 4. Deploy the tenant worker into the dispatch namespace. Digest-verified (mupot#1507
  // round 2 requirement 4) — see loadPotWorkerBundle's doc comment.
  const bundleResult = await loadPotWorkerBundle(env, workerJsCode ?? input.worker_js_code)
  if (!bundleResult.ok) {
    await recordStep('deploy_worker', false, bundleResult.reason)
    return bail(`deploy_worker failed: ${bundleResult.reason}`)
  }
  const bundle = bundleResult.bundle
  try {
    await uploadUserWorkerToDispatch(cf, slug, bundle.code, {
      d1DatabaseId: d1.uuid,
      kvNamespaceId: kv.id,
      tenantSlug: slug,
      brandName: input.brand_name,
      publicOrigin,
      releaseSha: env.RELEASE_SHA,
    })
  } catch (error) {
    await recordStep('deploy_worker', false, errMsg(error))
    return bail(`deploy_worker failed: ${errMsg(error)}`)
  }
  // The receipt names the EXACT bytes deployed — source, digest, and (for R2) which
  // published object — regardless of which source won, per requirement 4: "the
  // worker_js_code fallback is digest-receipted too".
  await recordStep(
    'deploy_worker',
    true,
    JSON.stringify({
      source: bundle.source,
      sha256: bundle.sha256,
      ...(bundle.r2ObjectKey ? { r2_object_key: bundle.r2ObjectKey } : {}),
    }),
  )

  // 5. Seed department/squad/admin member/lead agent, tokens hashed and persisted.
  let seed: SeedIdentitiesResult
  try {
    seed = await seedPotIdentities(cf, d1.uuid, {
      slug,
      brandName: input.brand_name,
      adminEmail: input.admin_email,
      adminName: input.admin_name,
    })
  } catch (error) {
    await recordStep('seed_identities', false, errMsg(error))
    return bail(`seed_identities threw: ${errMsg(error)}`)
  }
  if (!seed.ok) {
    await recordStep('seed_identities', false, seed.detail ?? 'unknown seed failure')
    return bail(`seed_identities failed: ${seed.detail ?? 'unknown seed failure'}`)
  }
  // Structured, not prose — this is what makes the bootstrap QUERYABLE from the parent
  // (mupot#1507 round-2 requirement 1): admin_member_id and both fingerprints, never a
  // raw token or a live claim. json_extract() can pull this back out of the TEXT column
  // like every other JSON-shaped receipt detail in this schema.
  await recordStep(
    'seed_identities',
    true,
    JSON.stringify({
      already_seeded: seed.alreadySeeded,
      admin_member_id: seed.adminMemberId,
      admin_token_fingerprint: seed.adminTokenFingerprint,
      lead_agent_id: seed.leadAgentId,
      lead_agent_member_id: seed.leadAgentMemberId || null,
      lead_agent_token_fingerprint: seed.leadAgentTokenFingerprint,
    }),
  )

  // 6. Verify reachability through the real dispatch path BEFORE claiming success.
  const reach = await verifyPotReachable(env, slug, rootDomain)
  await recordStep('verify_reachable', reach.ok, reach.detail)
  if (!reach.ok) {
    return bail(`verify_reachable failed: ${reach.detail}`)
  }

  // Every step passed. Mint one-time credential CLAIMS (src/auth/credential-claim.ts,
  // mupot#987) — never the raw token itself in this response. Only possible when the
  // caller told us who will redeem it (`minted_by_member_id`, an interactive org-admin
  // caller) AND a raw token actually exists (nothing to claim on an `alreadySeeded` retry).
  let adminClaim: CredentialClaimHandle | null = null
  let leadAgentClaim: CredentialClaimHandle | null = null
  if (input.minted_by_member_id) {
    if (seed.adminRawToken) {
      adminClaim = await createCredentialClaim(env, seed.adminRawToken, input.minted_by_member_id)
    }
    if (seed.leadAgentRawToken) {
      leadAgentClaim = await createCredentialClaim(env, seed.leadAgentRawToken, input.minted_by_member_id)
    }
  }

  return {
    ok: true,
    status: 'provisioned',
    completed,
    not_completed: [],
    orphaned_resources: null,
    incomplete_reason: null,
    run_id: runId,
    receipts,
    slug,
    brand_name: input.brand_name,
    plan_tier: tier,
    d1_database_id: d1.uuid,
    d1_database_name: d1.name,
    kv_namespace_id: kv.id,
    kv_namespace_title: kv.title,
    dispatch_namespace: DISPATCH_NAMESPACE,
    worker_script_name: slug,
    public_origin: publicOrigin,
    admin_email: input.admin_email,
    admin_member_id: seed.adminMemberId,
    admin_token: null,
    admin_login_url: publicOrigin,
    admin_credential_claim: adminClaim,
    lead_agent_id: seed.leadAgentId,
    lead_agent_name: leadAgentName,
    lead_agent_token: null,
    lead_agent_credential_claim: leadAgentClaim,
    provisioned_at: new Date().toISOString(),
  }
}
