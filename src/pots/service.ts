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
  applySchemaChain, recordedKey, escapeSqlLiteral,
  type ApplySchemaChainResult,
} from './schema-chain'
import { sha256Hex } from '../members/service'
import { createCredentialClaim, type CredentialClaimHandle } from '../auth/credential-claim'

export const DISPATCH_NAMESPACE = 'mupot-pots'
export const DEFAULT_ROOT_DOMAIN = 'mupot.mumega.com'

// Slugs that can never name a tenant worker. Mirrored by the apex path router
// (src/dispatcher.ts) so reserved names fail fast instead of dispatching.
// Union of the two independently-maintained reserved-word lists this codebase had
// (this file's own, plus src/pots/checkout.ts's — checkSlugAvailability moved here in
// mupot#1507 round-2, and its list was WIDER: billing/blog/dev/docs/help/mail/root/sos/
// static/support/test/www were refused by the self-serve checkout path but NOT by
// validateSlug/the dispatcher's routing reservation. Merging avoids silently narrowing
// what checkout.ts used to refuse.
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
  'billing',
  'blog',
  'dev',
  'docs',
  'help',
  'mail',
  'root',
  'sos',
  'static',
  'support',
  'test',
  'www',
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
    // NO fallback to worker_js_code on an R2 FAILURE (mupot#1507 round-2 P1-2) — a GET
    // call that THROWS is not the same signal as "nothing published for this RELEASE_SHA
    // yet" (obj === null, no throw, handled further below and still allowed to fall
    // through — CI publishing every release is a follow-up, not built in this PR; treating
    // every not-yet-published release as a hard failure would make the bucket binding
    // unusable before that lands). A transport error, by contrast, means something is
    // WRONG with infrastructure this deployment has declared authoritative by configuring
    // the binding at all — falling back would silently ship whatever `worker_js_code`
    // happens to be supplied instead of surfacing that problem.
    const key = `${env.RELEASE_SHA || 'unknown'}/worker.js`
    let obj: Awaited<ReturnType<R2Bucket['get']>>
    try {
      obj = await env.POT_WORKER_BUNDLE_BUCKET.get(key)
    } catch (error) {
      return {
        ok: false,
        reason: `R2 GET '${key}' failed: ${errMsg(error)} — POT_WORKER_BUNDLE_BUCKET is configured, so this is a hard failure, not a signal to fall back to worker_js_code.`,
      }
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

/** Inline SQL literal — see the atomic-batch doc comment on `seedPotIdentities` for why
 *  this seed step does not use `?N` bound params. */
function lit(value: string | number | null): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number') return String(value)
  return `'${escapeSqlLiteral(value)}'`
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

interface FullSeedIdentityState {
  adminMemberId: string | null
  adminHasOwnerCapability: boolean
  adminTokenHash: string | null
  leadAgentId: string | null
  leadAgentMemberId: string | null
  leadAgentHasBinding: boolean
  leadAgentTokenHash: string | null
}

/** Reads the FULL set of facts a "this pot is already seeded" claim depends on — never
 *  just "does a member with this email exist" (mupot#1507 round-2 P0-2: that check alone
 *  reported `ok:true`/`alreadySeeded` for a pot where the admin member existed but its
 *  org:owner capability, token, or the lead agent's binding did not — a half-seeded pot
 *  that LOOKED fully provisioned to every caller after it). Two round trips (admin side,
 *  lead-agent side); both read-only. */
async function readFullSeedIdentityState(
  cf: CloudflareApiConfig,
  databaseId: string,
  normalizedAdminEmail: string,
  leadAgentSlug: string,
): Promise<FullSeedIdentityState> {
  const adminRows = await executeD1Query(
    cf,
    databaseId,
    `SELECT m.id AS id,
            (SELECT COUNT(*) FROM capabilities
              WHERE member_id = m.id AND scope_type = 'org' AND scope_id IS NULL AND capability = 'owner'
            ) AS owner_count,
            (SELECT token_hash FROM member_tokens
              WHERE member_id = m.id AND label = 'admin' AND revoked_at IS NULL
              ORDER BY created_at DESC LIMIT 1
            ) AS token_hash
       FROM members m
      WHERE lower(m.email) = ?1
      LIMIT 1`,
    [normalizedAdminEmail],
  )
  const admin = adminRows[0]?.results?.[0] as { id?: string; owner_count?: number; token_hash?: string } | undefined

  const agentRows = await executeD1Query(
    cf,
    databaseId,
    `SELECT a.id AS id,
            (SELECT b.member_id FROM agent_member_bindings b WHERE b.agent_id = a.id LIMIT 1) AS member_id,
            (SELECT mt.token_hash FROM member_tokens mt
              JOIN agent_member_bindings b ON b.agent_id = a.id AND b.member_id = mt.member_id
              WHERE mt.agent_id = a.id AND mt.label = 'seed-seat' AND mt.revoked_at IS NULL
              ORDER BY mt.created_at DESC LIMIT 1
            ) AS token_hash
       FROM agents a
      WHERE a.slug = ?1
      LIMIT 1`,
    [leadAgentSlug],
  )
  const agent = agentRows[0]?.results?.[0] as { id?: string; member_id?: string; token_hash?: string } | undefined

  return {
    adminMemberId: admin?.id ?? null,
    adminHasOwnerCapability: Number(admin?.owner_count ?? 0) > 0,
    adminTokenHash: admin?.token_hash ?? null,
    leadAgentId: agent?.id ?? null,
    leadAgentMemberId: agent?.member_id ?? null,
    leadAgentHasBinding: Boolean(agent?.member_id),
    leadAgentTokenHash: agent?.token_hash ?? null,
  }
}

/**
 * Seeds the MINIMAL identities a freshly-schema'd pot needs to be operable (mupot#1285
 * requirement 4): one core department + squad, an org-owner admin member, and the
 * seed-seat lead agent (`<slug>-bot`, the "seed seat + mubot per pot" pattern) with its
 * own home member (member_tokens.member_id is NOT NULL — a token bound to an agent still
 * needs an owning member row; agents.owner_member_id records which one). Tokens are
 * stored HASHED with the exact same `sha256Hex` (src/members/service.ts) the main pot's
 * token verification path uses.
 *
 * ATOMIC BATCH (mupot#1507 round-2 P0-1). The schema this seed runs against (migration
 * 0071) enforces a real invariant: `member_tokens_agent_binding_insert` aborts ANY
 * `member_tokens` insert carrying a non-null `agent_id` unless a matching row already
 * exists in `agent_member_bindings` — an agent cannot hold a credential without a
 * recorded human-readable identity weld to a member. The seed-seat token insert MUST
 * therefore be preceded by an `agent_member_bindings` insert for that exact
 * (tenant, agent_id, member_id) triple, in the SAME statement sequence — never added
 * around the trigger (a `catch` that swallows the abort and retries some other way would
 * be exactly the kind of workaround this trigger exists to make impossible).
 *
 * All nine writes below (department, squad, admin member, admin capability, admin token,
 * lead-agent member, lead agent, the binding, lead-agent capability, lead-agent token —
 * ten, counting both member rows) are sent as ONE D1 REST `/query` call: a single
 * `BEGIN; ...; COMMIT;` script with every value inlined via `escapeSqlLiteral` rather than
 * bound `?N` params. This is deliberate, not a shortcut: D1 REST's per-statement param
 * binding for a MULTI-statement string in one call is undocumented (would every
 * statement's own `?1, ?2, ...` need to be renumbered globally across the whole script, or
 * does each statement get its own local numbering? Cloudflare does not say), so inlining
 * avoids relying on unverified behavior for the one write path where getting it wrong
 * means a passing statement 3 that actually wrote statement 7's values. The `BEGIN`/
 * `COMMIT` wrapper gives real SQLite transaction semantics — D1 is built on SQLite, and a
 * script that errors before reaching `COMMIT` never persists any of it — closing the
 * exact "admin member + org:owner capability + orphan token, no lead agent" partial state
 * requirement 1 names. NOT verified against the LIVE Cloudflare D1 REST API in this
 * session (no live CF calls permitted) — this session's own real-SQLite test harness
 * (tests/pot-provisioner.test.ts) proves the SQL text itself is correct and atomic against
 * a real engine with the real trigger set; Kasra-core should confirm D1 REST honors the
 * same BEGIN/COMMIT semantics live before this ships broadly.
 *
 * A LEAD AGENT'S HOME MEMBER GETS `capability = 'lead'`, matching the agent's OWN `role`
 * column. An earlier draft of this function capped it at `'member'`, reasoning from
 * migration 0071's `agent_member_bindings_home_capability_ceiling` /
 * `agent_home_capability_ceiling_insert` triggers — which DID hard-cap any member holding
 * an agent binding at `observer`/`member` when 0071 landed, but migration 0087
 * (`0087_drop_home_capability_ceiling.sql`) DROPPED all five ceiling triggers on an
 * explicit Hadi directive (2026-08-09), precisely because the ceiling made `routine_create`
 * (which requires admin) impossible for any agent and left the whole authority map
 * single-threaded. Verified empirically against this session's own real-schema test
 * harness: the exact insert sequence an earlier draft assumed would abort (binding, then a
 * `'lead'` capability grant on the bound member) succeeds cleanly on the current chain —
 * `agent_home_capability_ceiling_insert` no longer exists to fire. Capping the seed-seat
 * agent's own home member below its own operational role would have been an unforced,
 * factually-wrong restriction sourced from superseded schema history.
 *
 * Idempotent on `adminEmail` (case-insensitively — `lower()` on both sides of the compare,
 * closing a duplicate-org:owner-capability injection an exact-match compare would have let
 * through via `Admin@x.com` vs `admin@x.com`) — a retried provisioning call checks the FULL
 * identity state first (`readFullSeedIdentityState`) and only returns `alreadySeeded` when
 * EVERY piece already exists; a genuinely partial state (which the atomic batch should make
 * unreachable in the happy case, but a REST-layer atomicity surprise is exactly the kind of
 * thing worth failing loudly on rather than silently trusting) is a hard, named failure —
 * the SAME fail-closed-never-resume precedent `applySchemaChain` already established for
 * partial migration state (src/pots/schema-chain.ts), applied here for the same reason: a
 * repair engine for a state the atomic batch is designed not to produce is untested surface
 * for a rare path, not a safety improvement.
 */
export async function seedPotIdentities(
  cf: CloudflareApiConfig,
  databaseId: string,
  input: SeedIdentitiesInput,
): Promise<SeedIdentitiesResult> {
  const normalizedEmail = input.adminEmail.trim().toLowerCase()
  const leadAgentSlug = `${input.slug}-bot`
  const state = await readFullSeedIdentityState(cf, databaseId, normalizedEmail, leadAgentSlug)

  const nothingSeededYet =
    state.adminMemberId === null &&
    state.leadAgentId === null

  if (!nothingSeededYet) {
    const missing: string[] = []
    if (!state.adminMemberId) missing.push('admin_member')
    if (!state.adminHasOwnerCapability) missing.push('admin_owner_capability')
    if (!state.adminTokenHash) missing.push('admin_token')
    if (!state.leadAgentId) missing.push('lead_agent')
    if (!state.leadAgentHasBinding) missing.push('lead_agent_binding')
    if (!state.leadAgentTokenHash) missing.push('lead_agent_token')

    if (missing.length > 0) {
      return {
        ok: false,
        alreadySeeded: false,
        adminMemberId: state.adminMemberId ?? '',
        adminRawToken: null,
        adminTokenFingerprint: null,
        leadAgentId: state.leadAgentId ?? '',
        leadAgentMemberId: state.leadAgentMemberId ?? '',
        leadAgentRawToken: null,
        leadAgentTokenFingerprint: null,
        detail:
          `partial seed state detected — missing: ${missing.join(', ')}. This module does ` +
          'not repair partial identity state (same fail-closed precedent as ' +
          'applySchemaChain\'s partial-migration handling) — inspect the pot\'s own ' +
          'members/capabilities/agent_member_bindings/member_tokens rows directly.',
      }
    }

    // FULLY seeded — every piece is present. Fingerprints recovered from the stored hash,
    // never a raw value (none exists to recover; sha256Hex is one-way by design).
    return {
      ok: true,
      alreadySeeded: true,
      adminMemberId: state.adminMemberId!,
      adminRawToken: null,
      adminTokenFingerprint: state.adminTokenHash!.slice(0, 16),
      leadAgentId: state.leadAgentId!,
      leadAgentMemberId: state.leadAgentMemberId!,
      leadAgentRawToken: null,
      leadAgentTokenFingerprint: state.leadAgentTokenHash!.slice(0, 16),
      detail: `admin member already exists for this email — seeding skipped, no new tokens minted`,
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
  const adminName = input.adminName || brandName

  const batchSql = [
    'BEGIN;',
    `INSERT INTO departments (id, slug, name, kind, active, created_at) VALUES (${lit(departmentId)}, 'core', ${lit(brandName)}, 'work', 1, ${lit(now)});`,
    `INSERT INTO squads (id, department_id, slug, name, kind, created_at) VALUES (${lit(squadId)}, ${lit(departmentId)}, 'core', 'Core', 'work', ${lit(now)});`,
    `INSERT INTO members (id, email, display_name, status, tenant, created_at) VALUES (${lit(adminMemberId)}, ${lit(normalizedEmail)}, ${lit(adminName)}, 'active', ${lit(input.slug)}, ${lit(now)});`,
    `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability, created_at) VALUES (${lit(crypto.randomUUID())}, ${lit(adminMemberId)}, 'org', NULL, 'owner', ${lit(now)});`,
    `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES (${lit(crypto.randomUUID())}, ${lit(adminMemberId)}, ${lit(adminTokenHash)}, 'admin', 'dashboard', ${lit(now)}, ${lit(input.slug)});`,
    // The seed-seat agent's own "home" identity — see the function doc comment for why an
    // agent still needs a member row to hold a token.
    `INSERT INTO members (id, email, display_name, status, tenant, created_at) VALUES (${lit(leadAgentMemberId)}, NULL, ${lit(leadAgentName)}, 'active', ${lit(input.slug)}, ${lit(now)});`,
    `INSERT INTO agents (id, squad_id, slug, name, role, status, kind, owner_member_id, created_at) VALUES (${lit(leadAgentId)}, ${lit(squadId)}, ${lit(leadAgentSlug)}, ${lit(leadAgentName)}, 'lead', 'active', 'work', ${lit(leadAgentMemberId)}, ${lit(now)});`,
    // MUST precede the seed-seat member_tokens insert below — member_tokens_agent_binding_insert
    // (migration 0071) aborts that insert otherwise. See the function doc comment.
    `INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES (${lit(input.slug)}, ${lit(leadAgentId)}, ${lit(leadAgentMemberId)}, ${lit(now)});`,
    // 'lead', matching the agent's own role — the home-capability ceiling that used to cap
    // this at observer/member was dropped in migration 0087. See the function doc comment.
    `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability, created_at) VALUES (${lit(crypto.randomUUID())}, ${lit(leadAgentMemberId)}, 'squad', ${lit(squadId)}, 'lead', ${lit(now)});`,
    `INSERT INTO member_tokens (id, member_id, agent_id, token_hash, label, channel, created_at, tenant) VALUES (${lit(crypto.randomUUID())}, ${lit(leadAgentMemberId)}, ${lit(leadAgentId)}, ${lit(leadAgentTokenHash)}, 'seed-seat', 'workspace', ${lit(now)}, ${lit(input.slug)});`,
    'COMMIT;',
  ].join('\n')

  try {
    await executeD1Query(cf, databaseId, batchSql)
  } catch (error) {
    // Best-effort rollback in case the REST connection's transaction survives the failed
    // request (documented uncertainty — see the function doc comment). Swallowed: a
    // failure here must not replace the real, load-bearing diagnostic below.
    try {
      await executeD1Query(cf, databaseId, 'ROLLBACK;')
    } catch {
      // Nothing to do — either it wasn't needed or the connection is already gone.
    }
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
      detail: `atomic seed batch failed: ${errMsg(error)}`,
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
  /** null when there was nothing to compare (non-200, unparseable body, or no DISPATCHER). */
  tenantMatch: boolean | null
  /** null ONLY when this deployment has no RELEASE_SHA configured at all (dev/test) — a
   *  trivially-satisfied "nothing to compare" state, not a failure. See
   *  `expectedHealthCommit`'s doc comment. */
  releaseShaMatch: boolean | null
  /** sha256 of the raw response body — NEVER the body itself (mupot#1507 round-2 P2: a
   *  verbatim /health body in a receipt is exactly the kind of incidental data a ledger
   *  should not accumulate; the hash is enough to notice "the response changed" without
   *  storing whatever it happened to contain). */
  bodySha256: string | null
  detail: string
}

/** The child pot's `/health` (src/health.ts `publicHealth`) reports `commit` — parsed from
 *  whatever `RELEASE_SHA` var it was deployed with, stripping a `-dirty` suffix the SAME
 *  way `publicHealth` itself does, WITHOUT publicHealth's fallback to this (the
 *  ORCHESTRATOR's) own `BUILD_INFO.commit` when the input is empty — that fallback exists
 *  for the orchestrator's OWN health endpoint reporting on itself, and reusing it here
 *  would compare the child's real deployed identity against an unrelated value. Returns
 *  `null` when there is genuinely nothing to compare (`RELEASE_SHA` unset/not a real sha
 *  shape, e.g. the `'unknown'` this Worker uploads when it has none) — a deployment with
 *  no configured RELEASE_SHA cannot assert what its children should report, and that is a
 *  distinct, honest state from "asserted and wrong." */
function expectedHealthCommit(releaseSha: string | undefined): string | null {
  if (typeof releaseSha !== 'string' || releaseSha.trim().length === 0) return null
  if (/^[0-9a-f]{40}$/i.test(releaseSha)) return releaseSha.toLowerCase()
  const dirty = releaseSha.match(/^([0-9a-f]{40})-dirty$/i)
  return dirty ? dirty[1].toLowerCase() : null
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
 *
 * IDENTITY CHECK (mupot#1507 round-2 P1-1): HTTP 200 alone used to be enough. It is not —
 * a 200 from the WRONG tenant (a routing bug resolving to some other pot) or a stale
 * `commit` (the dispatch upload silently failed to take effect, and the dispatcher is
 * still serving whatever script previously held that name) both look identical to success
 * at the status-code level. `verifyPotReachable` now also asserts the response body's
 * `tenant` field equals `slug` and its `commit` field equals what THIS call uploaded — a
 * mismatch on either is `ok: false`, never just a warning.
 */
export async function verifyPotReachable(
  env: Env,
  slug: string,
  rootDomain: string,
): Promise<ReachabilityCheckResult> {
  if (!env.DISPATCHER) {
    return {
      ok: false, status: null, tenantMatch: null, releaseShaMatch: null, bodySha256: null,
      detail: 'DISPATCHER binding not configured on this Worker — cannot verify reachability.',
    }
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
    const bodySha256 = await sha256Hex(bodyText)
    if (response.status !== 200) {
      return {
        ok: false, status: response.status, tenantMatch: null, releaseShaMatch: null, bodySha256,
        detail: `non-200 response: HTTP ${response.status}`,
      }
    }
    let parsed: { tenant?: unknown; commit?: unknown } | null = null
    try {
      parsed = JSON.parse(bodyText) as { tenant?: unknown; commit?: unknown }
    } catch {
      parsed = null
    }
    const tenantMatch = parsed !== null && parsed.tenant === slug
    const expectedCommit = expectedHealthCommit(env.RELEASE_SHA)
    const releaseShaMatch = expectedCommit === null ? true : parsed !== null && parsed.commit === expectedCommit
    if (parsed === null) {
      return {
        ok: false, status: response.status, tenantMatch: false, releaseShaMatch: false, bodySha256,
        detail: 'response body was not parseable JSON — cannot verify tenant/commit identity',
      }
    }
    if (!tenantMatch || !releaseShaMatch) {
      return {
        ok: false, status: response.status, tenantMatch, releaseShaMatch, bodySha256,
        detail: `identity mismatch: tenant_match=${tenantMatch} release_sha_match=${releaseShaMatch}`,
      }
    }
    return { ok: true, status: response.status, tenantMatch, releaseShaMatch, bodySha256, detail: 'ok' }
  } catch (error) {
    return {
      ok: false, status: null, tenantMatch: null, releaseShaMatch: null, bodySha256: null,
      detail: `dispatch to '${slug}' threw: ${errMsg(error)}`,
    }
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
  actorMemberId: string | null,
  actorTenant: string | null,
): Promise<void> {
  try {
    await env.DB.prepare(
      'INSERT INTO pot_provision_receipts (id, tenant, slug, run_id, step, ok, detail, actor_member_id, actor_tenant, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)',
    )
      .bind(
        crypto.randomUUID(), env.TENANT_SLUG ?? 'mumega', slug, runId, step, ok ? 1 : 0, detail,
        actorMemberId, actorTenant, new Date().toISOString(),
      )
      .run()
  } catch {
    // Swallowed deliberately — see doc comment above.
  }
}

export interface SlugCheckResult {
  available: boolean
  slug: string
  reason?: string
}

/**
 * Validates whether a requested subdomain slug is available and valid. Moved here from
 * src/pots/checkout.ts (mupot#1507 round-2 P0-4) so `provisionSovereignPot` can call it
 * directly without a circular import (checkout.ts already imports
 * `provisionSovereignPot` FROM this file) — this module is the lower-level "pot mechanics"
 * layer, checkout.ts the higher-level self-serve flow built on it, so owning the
 * availability predicate here is also the more sensible dependency direction.
 *
 * FAIL CLOSED (mupot#1303). An unanswerable check is NOT an available slug — "I could not
 * determine whether this is taken" must never be answered as "this is not taken".
 *
 * Two sources are consulted because BOTH occupy the same `mupot-pots` dispatch namespace:
 * tenant pots (`pots`, migration 0145) and project sub-workers (`src/platform/dispatcher.ts`
 * dispatches `worker_name || slug` into it). A name taken by either is not available to a
 * new pot.
 */
export async function checkSlugAvailability(env: Env, rawSlug: string): Promise<SlugCheckResult> {
  const slug = (rawSlug || '').toLowerCase().trim()

  if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(slug)) {
    return {
      available: false,
      slug,
      reason: 'Slug must be 3-32 lowercase alphanumeric characters and cannot start or end with a hyphen.',
    }
  }

  if (RESERVED_TENANT_SLUGS.has(slug)) {
    return { available: false, slug, reason: 'This pot subdomain is reserved.' }
  }

  try {
    const takenByPot = await env.DB.prepare('SELECT id FROM pots WHERE slug = ?1 LIMIT 1')
      .bind(slug)
      .first<{ id: string }>()
    if (takenByPot) {
      return { available: false, slug, reason: 'This pot subdomain is already taken.' }
    }

    const takenByProject = await env.DB.prepare(
      'SELECT id FROM projects WHERE slug = ?1 OR worker_name = ?1 LIMIT 1',
    )
      .bind(slug)
      .first<{ id: string }>()
    if (takenByProject) {
      return { available: false, slug, reason: 'This pot subdomain is already taken.' }
    }
  } catch {
    // An unanswerable check is NOT an available slug. Refusing a legitimate signup is
    // recoverable by retrying; selling a slug that already has a Worker behind it is not.
    return {
      available: false,
      slug,
      reason: 'Availability could not be verified right now. Please try again.',
    }
  }

  return { available: true, slug }
}

/** Thrown by `provisionSovereignPot` when the requested slug is registered to a DIFFERENT
 *  provisioner (mupot#1507 round-2, Athena condition i: "reuse-by-name is allowed ONLY
 *  when the caller is the pot's registered provisioner"). Callers (src/pots/routes.ts,
 *  src/mcp/pots.ts) catch this specifically to answer 409/`pot_slug_taken` rather than a
 *  generic 500 — this is a NAMED, expected refusal, not an internal error. */
export class PotSlugTakenError extends Error {
  readonly code = 'pot_slug_taken' as const
  constructor(readonly slug: string, reason?: string) {
    super(reason ? `Slug '${slug}' is not available: ${reason}` : `Slug '${slug}' is already provisioned by a different caller.`)
    this.name = 'PotSlugTakenError'
  }
}

/** mupot#1507 round-2 P0-3, Athena condition iii: the provisioner function itself refuses
 *  these fields regardless of surface, structurally and at runtime — defense in depth
 *  against a caller that reaches this function with an object built outside the
 *  `SovereignPotProvisionInput` type (an `as any` cast, a stale internal caller, a future
 *  regression that re-adds a spread). The type no longer even DECLARES these fields (see
 *  `SovereignPotProvisionInput`'s doc comment) — this is the runtime half of that fix,
 *  checking the actual object's own keys rather than trusting the type checker alone. */
const FORBIDDEN_PROVISION_INPUT_KEYS = ['cf_api_token', 'account_id', 'worker_js_code'] as const

function assertNoForbiddenProvisionInputKeys(input: object): void {
  for (const key of FORBIDDEN_PROVISION_INPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      throw new Error(
        `provisionSovereignPot: '${key}' is not an accepted field on the provisioning input — ` +
          'Cloudflare credentials and the worker bundle must never be caller-suppliable ' +
          '(mupot#1507 P0-3). Refusing regardless of caller or call surface.',
      )
    }
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
  assertNoForbiddenProvisionInputKeys(input)

  const slug = sanitizeSlug(input.slug)
  const valid = validateSlug(slug)
  if (!valid.ok) {
    throw new Error(valid.error)
  }

  // Cloudflare credentials come ONLY from env — never the caller (mupot#1507 P0-3; the
  // type no longer even has `account_id`/`cf_api_token` fields, see
  // SovereignPotProvisionInput's doc comment and `assertNoForbiddenProvisionInputKeys` above).
  const accountId = env.SECRET_ENV_CF_ACCOUNT_ID || 'e39eaf94f33092c4efd029d94ae1e9dd'
  const apiToken = env.SECRET_ENV_CF_API_TOKEN
  if (!apiToken) {
    throw new Error('Cloudflare API Token not configured for pot provisioning.')
  }

  const cf: CloudflareApiConfig = { accountId, apiToken }
  const actorMemberId = input.minted_by_member_id ?? null
  const actorTenant = input.caller_tenant ?? env.TENANT_SLUG ?? null

  const runId = crypto.randomUUID()
  const completed: ProvisionStep[] = []
  const receipts: ProvisionStepReceipt[] = []
  const orphans: OrphanedResources = {
    d1_database_id: null, d1_database_name: null, d1_adopted: false,
    kv_namespace_id: null, kv_namespace_title: null, kv_adopted: false,
  }

  const recordStep = async (step: ProvisionStep, ok: boolean, detail: string | null): Promise<void> => {
    receipts.push({ step, ok, detail })
    await writeProvisionReceipt(env, runId, slug, step, ok, detail, actorMemberId, actorTenant)
    if (ok) completed.push(step)
  }

  // 0. Registry gate — BEFORE any Cloudflare call (mupot#1507 round-2 P0-4, Athena
  // condition i). `pots` (migration 0145) plus its round-2 `provisioner_member_id`/
  // `provisioner_tenant` columns (migration 0165) is the account-wide ownership record: a
  // slug already claimed by a DIFFERENT (member, tenant) pair is refused outright, never
  // silently adopted. A brand-new slug is claimed HERE, before create_d1 — the INSERT's
  // own UNIQUE(slug) constraint is the concurrency guard: if two calls race for the same
  // fresh slug, the loser's INSERT throws and it is refused exactly like a pre-existing
  // claim would be, never adopts what the winner is mid-creating.
  //
  // KNOWN, DOCUMENTED GAP: `checkout.ts`'s self-serve path has no interactive member
  // (`actorMemberId` is always null there), so "ownership" for that path degrades to
  // matching on `actorTenant` alone (this deployment's own TENANT_SLUG) — two different
  // anonymous customers racing the EXACT same slug within this narrow window are not
  // distinguished by identity, only by `checkSlugAvailability`'s pre-existing gate at
  // Stripe-session-creation time. Closing that fully needs a per-checkout-session claim
  // token, tracked separately, not built in this round (docs/workflows/tenant-provision.md).
  const existingPotRow = await env.DB.prepare(
    'SELECT provisioner_member_id, provisioner_tenant FROM pots WHERE slug = ?1 LIMIT 1',
  )
    .bind(slug)
    .first<{ provisioner_member_id: string | null; provisioner_tenant: string | null }>()

  if (existingPotRow) {
    const isOwner =
      existingPotRow.provisioner_member_id === actorMemberId &&
      existingPotRow.provisioner_tenant === actorTenant
    if (!isOwner) {
      throw new PotSlugTakenError(slug)
    }
    // Owner retry — falls through to the normal reuse-by-name flow below (create_d1 etc.
    // adopt the existing CF resources by name, exactly as before this gate existed).
  } else {
    const availability = await checkSlugAvailability(env, slug)
    if (!availability.available) {
      throw new PotSlugTakenError(slug, availability.reason)
    }
    try {
      await env.DB.prepare(
        'INSERT INTO pots (id, slug, worker_script, status, source, created_at, provisioner_member_id, provisioner_tenant) ' +
          'VALUES (?1,?2,?3,?4,?5,?6,?7,?8)',
      )
        .bind(crypto.randomUUID(), slug, slug, 'provisioning', 'provision', new Date().toISOString(), actorMemberId, actorTenant)
        .run()
    } catch {
      // Lost a race to a concurrent claim of the same slug — refuse exactly like a
      // pre-existing claim, never proceed to adopt whatever the winner is creating.
      throw new PotSlugTakenError(slug)
    }
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
  const bundleResult = await loadPotWorkerBundle(env, workerJsCode)
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
  // Structured JSON, never the raw /health body — mupot#1507 round-2 P2. `bodySha256`
  // lets an operator notice "the response changed" without the body itself ever landing
  // in a receipt.
  const reach = await verifyPotReachable(env, slug, rootDomain)
  await recordStep(
    'verify_reachable',
    reach.ok,
    JSON.stringify({
      status: reach.status,
      tenant_match: reach.tenantMatch,
      release_sha_match: reach.releaseShaMatch,
      body_sha256: reach.bodySha256,
    }),
  )
  if (!reach.ok) {
    return bail(`verify_reachable failed: ${reach.detail}`)
  }

  // Every step passed. Finalize the registry row (mupot#1507 round-2 P0-2/P0-4) — `ok` /
  // `status: 'provisioned'` requires this write to land too, not just the six steps above.
  // NOTE: this is not itself one of the six named `ProvisionStep`s, so a failure here is
  // the one case where `bail()`'s `not_completed` reads `[]` under `status: 'incomplete'`
  // — `incomplete_reason` is the authoritative signal for this specific edge, not the
  // (otherwise reliable) empty-array-means-provisioned convention. The `pots` row itself
  // is left at `status: 'provisioning'`, which is accurate: every step ran, but the
  // registry does not yet agree, so a retry by the SAME provisioner still adopts correctly.
  try {
    await env.DB.prepare("UPDATE pots SET status = 'active' WHERE slug = ?1").bind(slug).run()
  } catch (error) {
    return bail(`registry activation failed: ${errMsg(error)} — all six steps completed, but the pots registry row could not be marked active`)
  }

  // Mint one-time credential CLAIMS (src/auth/credential-claim.ts, mupot#987) — never the
  // raw token itself in this response. Only possible when the caller told us who will
  // redeem it (`minted_by_member_id`, an interactive org-admin caller) AND a raw token
  // actually exists (nothing to claim on an `alreadySeeded` retry — M8, pinned by test).
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
