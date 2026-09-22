// src/pots/service.ts — Cloudflare Workers for Platforms (WFP) Sovereign Pot Provisioner.
//
// mupot#1285: `provisionSovereignPot` used to create a D1 + KV, generate credentials it
// never wrote anywhere, and return `ok:true` — a success-shaped response for a tenant that
// could not be reached, logged into, or queried (no schema). This file is the completion:
// every step below is actually attempted, in order, fail-closed on the first failure, with
// a receipt written for each one (`pot_provision_receipts`, migration 0169) and returned in
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

// Length bounds are 3-32 — DELIBERATELY the same window checkSlugAvailability's own
// (now-removed) format regex used to enforce independently (mupot#1507-v2 P2, "align
// validateSlug and checkSlugAvailability length rules"). The two functions used to
// disagree (this one allowed 2-40, checkSlugAvailability's own regex only 3-32), which
// meant a slug of length 33-40 passed THIS check, reached the registry gate, and only then
// failed checkSlugAvailability's stricter rule — surfacing as `pot_slug_taken` (409, "this
// is already claimed by someone else") when the real problem was `invalid_slug` (400, "this
// was never a legal name to begin with"), a wrong-error-code class of its own.
// checkSlugAvailability now calls THIS function for its format check instead of
// re-implementing the rule a second time — one predicate, one place it can drift.
export function validateSlug(slug: string): { ok: true } | { ok: false; error: string } {
  if (!slug || slug.length < 3) return { ok: false, error: 'Slug must be at least 3 characters.' }
  if (slug.length > 32) return { ok: false, error: 'Slug cannot exceed 32 characters.' }
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
 *  mupot#1516 round-2 P2-2: this doc comment used to claim "this module always sends
 *  exactly one statement per call, so callers read `result[0]`" — true for every call site
 *  EXCEPT `seedPotIdentities`' own atomic seed batch, which sends nine semicolon-joined
 *  statements in ONE call (see that function's doc comment). No current caller reads past
 *  `result[0]` (the seed batch's own caller never inspects `result` at all, only whether the
 *  call threw), so this was a stale, no-longer-accurate claim rather than a bug in behavior
 *  — corrected here so it does not mislead the next caller into assuming single-statement
 *  calls are the only shape this function ever sends. */
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
 * ATOMIC BATCH (mupot#1507 round-2 P0-1, corrected mupot#1507-v2 P0-A). The schema this
 * seed runs against (migration 0071) enforces a real invariant:
 * `member_tokens_agent_binding_insert` aborts ANY `member_tokens` insert carrying a
 * non-null `agent_id` unless a matching row already exists in `agent_member_bindings` — an
 * agent cannot hold a credential without a recorded human-readable identity weld to a
 * member. The seed-seat token insert MUST therefore be preceded by an
 * `agent_member_bindings` insert for that exact (tenant, agent_id, member_id) triple, in
 * the SAME statement sequence — never added around the trigger (a `catch` that swallows
 * the abort and retries some other way would be exactly the kind of workaround this
 * trigger exists to make impossible).
 *
 * All nine writes below (department, squad, admin member, admin capability, admin token,
 * lead-agent member, lead agent, the binding, lead-agent capability, lead-agent token —
 * ten, counting both member rows) are sent as ONE D1 REST `/query` call: a single
 * semicolon-joined script with every value inlined via `escapeSqlLiteral` rather than
 * bound `?N` params (D1 REST's per-statement param binding for a MULTI-statement string in
 * one call is undocumented — would every statement's own `?1, ?2, ...` need to be
 * renumbered globally across the whole script, or does each statement get its own local
 * numbering? Cloudflare does not say — so inlining avoids relying on unverified behavior
 * for the one write path where getting it wrong means a passing statement 3 that actually
 * wrote statement 7's values).
 *
 * NO APP-LEVEL `BEGIN`/`COMMIT` WRAPPER (mupot#1507-v2 P0-A — this is a correction of the
 * ROUND-2 version of this function, which DID wrap the batch in `BEGIN;`/`COMMIT;`). D1's
 * REST `/query` endpoint REJECTS transaction-control statements outright —
 * "cannot start a transaction within a transaction" — because the semicolon-joined
 * statements in ONE `/query` call are ALREADY executed as a single atomic batch by
 * Cloudflare; D1 is not a raw SQLite file this Worker can `BEGIN`/`COMMIT` against over the
 * wire (developers.cloudflare.com/d1/best-practices/import-export-data/,
 * developers.cloudflare.com/d1/worker-api/d1-database/, cloudflare/workers-sdk#2733). This
 * repo's own `scripts/gen-schema-chain.mjs` already refuses to GENERATE a migration file
 * containing transaction-control BEGIN for the identical reason (its own "TRANSACTION-
 * CONTROL BEGIN IS CLASSIFIED AND REFUSED" doc comment) — the round-2 version of this
 * function violated, at runtime, exactly the rule this codebase already enforces at
 * generation time for migrations, and the test suite's own fake Cloudflare backend could
 * not catch it because it answered `success:true` to raw SQL text without ever modeling
 * D1's real refusal (see tests/helpers/d1-rest-double.ts, which now does). Atomicity here
 * comes ENTIRELY from D1 REST's own documented one-call-one-batch semantics, not from
 * anything this function sends.
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
  ].join('\n')

  try {
    await executeD1Query(cf, databaseId, batchSql)
  } catch (error) {
    // No app-level ROLLBACK to issue here (mupot#1507-v2 P0-A) — nothing was BEGUN by this
    // call in the first place. D1 REST's own one-call-one-batch atomicity means a failure
    // anywhere in `batchSql` leaves the whole call unpersisted; there is nothing further
    // for this Worker to undo over the wire.
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
  /** `null` whenever `expectedHealthCommit` has nothing REAL to compare against — either
   *  this deployment's `RELEASE_SHA` is unset entirely, or it is set to something that is
   *  not a genuine 40-hex commit sha (e.g. the `'unknown'` this Worker uploads when it has
   *  none). NEITHER case is a verified match, so neither is ever recorded as `true`
   *  (mupot#1507-v2 P1 pin — a prior version of this function collapsed BOTH into `true`,
   *  which reads as "checked and matched" when nothing was actually checked at all).
   *  `null` is a non-blocking, honest "not verified" — distinct from `false`, a REAL,
   *  asserted mismatch. See `expectedHealthCommit`'s doc comment. */
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
    // `null` (never `true`) whenever there is nothing REAL to compare against — unset
    // RELEASE_SHA and a configured-but-malformed one are both "not verified," not "verified
    // and matched." Only a genuine comparison can produce `true` or `false`. See the field's
    // doc comment on `ReachabilityCheckResult`.
    const releaseShaMatch = expectedCommit === null ? null : parsed !== null && parsed.commit === expectedCommit
    if (parsed === null) {
      return {
        ok: false, status: response.status, tenantMatch: false, releaseShaMatch: false, bodySha256,
        detail: 'response body was not parseable JSON — cannot verify tenant/commit identity',
      }
    }
    // `releaseShaMatch === false` is the only value of the three that BLOCKS — `null`
    // ("nothing to verify") is treated exactly like `true` here, never like a failure.
    if (!tenantMatch || releaseShaMatch === false) {
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

/**
 * The ONE JSON shape every `pot_provision_receipts.detail` value takes, on every step, on
 * both success and failure (mupot#1507-v2 P0-B, Athena's binding addition 1: "the receipt
 * table's CHECK and every writer are ONE review unit"). Before this, only three of six
 * steps' SUCCESS paths wrote JSON; every FAILURE path across all six wrote plain prose
 * instead — which the round-2 version of migration 0169's CHECK (`json_valid(detail)`
 * required for exactly those three steps) then REJECTED outright for the ones it covered,
 * and `writeProvisionReceipt`'s swallowed catch turned that rejection into a step that ran,
 * failed, and left NO receipt at all. Migration 0169 (this branch, rewritten in place) now
 * requires `json_valid(detail)` for EVERY step, and `receiptOk`/`receiptError` are the only
 * two functions that build a `detail` value anywhere in this file — one call site's shape
 * is every call site's shape, by construction, not by convention.
 */
export function receiptOk(fields: Record<string, unknown> = {}): string {
  // mupot#1523 round-2 P1 (item 5): receiptOk/receiptError must be TOTAL — a call site
  // building a receipt has already failed once (or is about to report success); it must
  // never ALSO throw while doing so. redactDeep is defensive on its own (Invalid Date,
  // BigInt, circular references, throwing getters), but this catch is the backstop for
  // whatever that defense missed — an oversized/malformed receipt is still better than an
  // uncaught exception replacing the step's actual outcome.
  try {
    return boundSerializedDetail({ ok: true, ...redactFields(fields) })
  } catch (err) {
    return JSON.stringify({ ok: true, truncated: true, note: `receipt detail construction failed: ${errMsg(err)}` })
  }
}

/** Maximum length of a `receiptError` message AFTER redaction — see `redactAndBound`. */
const RECEIPT_MESSAGE_MAX_LENGTH = 500

/** Maximum length, in characters, of the FULLY SERIALIZED `detail` document — mupot#1520
 *  P2-B. `RECEIPT_MESSAGE_MAX_LENGTH` bounds one string LEAF; it says nothing about how many
 *  leaves a call site passes. The round-2 gate proved the gap concretely: 200 fields at
 *  ~500 chars each (each individually under the per-leaf cap) serialize to a ~101,701-char
 *  document — comfortably over any per-row cap the receipts table or D1 itself enforces.
 *  `boundSerializedDetail` is the backstop that caps the WHOLE document regardless of shape,
 *  so `receiptOk`/`receiptError` remain the only two producers of `detail` and both are safe
 *  by construction, not by a future call site remembering to keep field counts small. */
const MAX_DETAIL_SERIALIZED_LENGTH = 64 * 1024

/** A loose but adequate email-shape matcher for REDACTION purposes only (never used as a
 *  validity check) — this replaces the round-2 DB-level `instr(lower(detail), '@') = 0`
 *  CHECK, which refused ANY '@' character regardless of context. mupot#1507-v2 P0-B found
 *  the exact failure that rule causes: a schema/deploy error can legitimately quote a
 *  Workers AI binding name like `@cf/meta/llama-3.3` — no email in it at all — and the old
 *  CHECK refused that receipt exactly as it would a real email, silently dropping it via
 *  `writeProvisionReceipt`'s swallow. Redacting emails in application code (here) and
 *  leaving the DB CHECK to enforce only `json_valid` (structure, which SQLite can actually
 *  verify) separates "is this shaped right" (the database's job) from "does this contain
 *  PII" (a judgment call belonging in code, where it can be precise about what it matches). */
// mupot#1516 round-2 P2-4: the round-2 version of this regex — `/[^\s@]+@[^\s@]+\.[^\s@]+/g`
// — matched ANY run of non-space-non-'@' characters before an '@', which is exactly wide
// enough to swallow `binding=@cf/meta/llama-3.3` whole: `[^\s@]+` greedily consumes
// `binding=` as a fake "local part", `cf/meta/llama-3` as a fake "domain", and `.3` as a
// fake "TLD" — redacting a Workers AI binding name that contains no email at all, the exact
// false-positive this rule exists to avoid (see the doc comment above). This version
// requires an RFC-ish local-part character class immediately before the '@' — notably NOT
// '=', ':', or '/' — so a prefix like `binding=` or `model:` or a path segment like
// `meta/llama-3` can never join the match. Verified against all three cited examples:
// `binding=@cf/meta/llama-3.3` and `model:@cf/meta/llama-3.3` have no substring matching the
// pattern below (no character run ending in '=', ':', or '/' can ever be the local part, and
// there is only one '@' in either token); `admin@example.com` matches cleanly.
//
// mupot#1520 P1-A: the round-2 version of the local/domain character classes (`\w`) is
// ASCII-only without the `/u` flag — `\w` is exactly `[A-Za-z0-9_]`, so `hédi.sérvat@
// exämple.com` never matched at all and reached the append-only ledger verbatim. `\p{L}`
// (any Unicode letter) and `\p{N}` (any Unicode number) replace the ASCII `\w` here, and the
// `u` flag is required for `\p{...}` classes to be recognized rather than throwing/matching
// literally. The excluded characters ('=', ':', '/', whitespace) are unaffected by this
// change — they are still absent from every character class below.
const EMAIL_RE = /[\p{L}\p{N}_.+-]+@[\p{L}\p{N}_-]+\.[\p{L}\p{N}_.-]+/gu

// mupot#1523 round-2 P1 (item 1): Unicode "format" (Cf) and "control" (Cc) categories cover
// the soft hyphen (U+00AD), zero-width space, zero-width joiner, and bidi control marks — but
// NOT the braille blank (U+2800, category So — a "symbol", not a format character), the
// Hangul filler quartet (U+115F/U+1160/U+3164/U+FFA0 — categories Lo/Lo/Lo/Lo, they are
// LETTERS that happen to render as nothing), or the Khmer inherent-vowel signs (U+17B4/
// U+17B5, category Mn — invisible combining marks). Each renders as blank/invisible but sits
// inside what looks like one continuous run of letters, breaking a greedy letter-run match in
// the middle exactly like the soft hyphen does — proven against the round-1 `/\p{Cf}/gu`-only
// version of this line. Listed explicitly alongside `\p{Cf}`/`\p{Cc}` because none of them
// share a Unicode general category with the others; there is no single category that covers
// "renders as blank" the way there almost is for "is a format character."
const FORMAT_CHAR_RE = /[\p{Cf}\p{Cc}⠀ᅟᅠㅤﾠ឴឵]/gu

/** Redacts anything email-shaped and bounds the length of a string. Applied to EVERY
 *  `receiptError` message AND `errorClass` AND recursively to every string value AND object
 *  key in `receiptOk`'s `fields`/`receiptError`'s `extraFields` (via `redactFields`,
 *  mupot#1516 round-2 P2-3; keys added mupot#1520 P2-B; `errorClass` added mupot#1523 round-2
 *  P1 item 2 — the doc comment on `receiptError` below claimed EVERY string on the detail
 *  went through this path, but `errorClass` was spliced into the JSON raw) — there is no path
 *  to a `pot_provision_receipts` row that skips it, regardless of which parameter a string
 *  arrives through, or whether it arrives as a value or a key.
 *
 *  mupot#1523 round-2 P1 item 1: `message.normalize('NFKC')` runs BEFORE anything else, for
 *  two reasons proven by the round-2 gate. (1) An NFD-decomposed unicode string represents an
 *  accented letter as TWO codepoints — a base letter (category `L`, matches `EMAIL_RE`) plus
 *  a combining mark (category `Mn`, matches NEITHER `\p{L}` nor `\p{N}`) — which breaks the
 *  same greedy letter-run match the soft-hyphen bypass breaks, just via a different Unicode
 *  mechanism; NFKC recomposes the pair back into one precomposed codepoint before matching
 *  ever runs. (2) NFKC also maps compatibility characters to their canonical form, which
 *  folds the FULLWIDTH commercial at sign (U+FF20, `＠`) down to ASCII `@` — closing a
 *  fullwidth-`@` bypass the literal `@` in `EMAIL_RE` cannot see on its own. */
function redactAndBound(message: string): string {
  const redacted = message.normalize('NFKC').replace(FORMAT_CHAR_RE, '').replace(EMAIL_RE, '[redacted-email]')
  return redacted.length > RECEIPT_MESSAGE_MAX_LENGTH
    ? `${redacted.slice(0, RECEIPT_MESSAGE_MAX_LENGTH)}…(truncated)`
    : redacted
}

/** Recursively applies `redactAndBound` to every STRING leaf AND every object KEY reachable
 *  from `value` — through plain objects and arrays — leaving numbers/booleans/null untouched
 *  (they cannot carry an email address or need length-bounding in this schema) and
 *  serializing `Date` instances to their ISO string BEFORE the generic object branch can see
 *  them. mupot#1516 round-2 P2-3: the round-2 version of `receiptOk`/`receiptError`
 *  redacted/bounded ONLY the `message` argument to `receiptError` — `fields`/`extraFields` on
 *  BOTH functions were spread into the JSON verbatim, unredacted and unbounded. Every field
 *  on today's actual call sites happens to be a safe id/count/enum, but the function
 *  signatures place no limit on what a future call site passes there — the redaction
 *  guarantee this schema's own CHECK-constraint history exists to hold must cover the WHOLE
 *  detail value, not just the one argument that happened to be the source of the round-1/
 *  round-2 defects.
 *
 *  mupot#1520 P2-B: two more gaps proven at round-2 on THIS function. (1) Object KEYS were
 *  never redacted — `receiptOk({'victim@real.com': 1})` emitted the real address verbatim as
 *  a JSON key, only the (non-existent) string VALUE would have been touched. Every plain
 *  object branch below now redacts the key the same way it redacts a string value, at every
 *  depth. (2) A `Date` is `typeof 'object'` and `Object.entries(date)` is `[]` (Date has no
 *  OWN enumerable properties — its value lives behind `.getTime()`/`.toISOString()`, not an
 *  enumerable field) — so the pre-1520 generic object branch turned `receiptOk({at: new
 *  Date()})` into `{"at":{}}`, silently discarding the timestamp. Checking `instanceof Date`
 *  first and returning `.toISOString()` preserves it as a proper JSON string instead.
 *
 *  mupot#1523 round-2 P1, items 3 and 5 — four more gaps closed on THIS function:
 *
 *  (3) KEY REDACTION MUST BE INJECTIVE. Two distinct keys can redact to the SAME string
 *  (`'victim1@x.com'` and `'victim2@x.com'` both become `'[redacted-email]'`) — naively
 *  building the result via `Object.fromEntries` would let the second silently overwrite the
 *  first, DROPPING a field with no trace it ever existed. `seenKeys` counts collisions per
 *  object and suffixes every repeat (`'[redacted-email]#2'`, `'#3'`, ...) so every original
 *  field survives under a distinguishable name.
 *
 *  (5) TOTAL, NEVER THROWS — a receipt is built to record what ALREADY went wrong (or that
 *  something succeeded); it must not itself become a NEW, unhandled failure. `ancestors`
 *  tracks the current recursion path (added before descending into an object/array's
 *  children, removed after) so a CIRCULAR reference returns `'[circular]'` instead of
 *  recursing forever — a plain "have I ever seen this object" set would also be wrong here,
 *  since it would misfire on a non-circular DAG (the same object legitimately reachable via
 *  two different fields). Reading a property via `Object.keys` then indexing it can THROW if
 *  the property is a getter that throws — caught per-property and replaced with
 *  `'[unreadable]'` rather than aborting the whole receipt. An `Invalid Date` (`new
 *  Date('bad')`, `isNaN(.getTime())`) serializes as `'invalid-date'` rather than `'Invalid
 *  Date'` leaking through `.toISOString()` (which itself throws on an Invalid Date — the
 *  ORIGINAL reason this needed a separate branch, not just "call toISOString and catch"). A
 *  `bigint` is converted via `.toString()` — `JSON.stringify` throws `TypeError: Do not know
 *  how to serialize a BigInt` on a raw one, which would otherwise take down the entire
 *  receipt over a single numeric field. */
function redactDeep(value: unknown, ancestors: Set<unknown> = new Set()): unknown {
  if (value instanceof Date) return isNaN(value.getTime()) ? 'invalid-date' : value.toISOString()
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return redactAndBound(value)
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return '[circular]'
    ancestors.add(value)
    try {
      return value.map((v) => redactDeep(v, ancestors))
    } finally {
      ancestors.delete(value)
    }
  }
  if (value !== null && typeof value === 'object') {
    if (ancestors.has(value)) return '[circular]'
    ancestors.add(value)
    try {
      const seenKeys = new Map<string, number>()
      const entries: [string, unknown][] = []
      for (const k of Object.keys(value as Record<string, unknown>)) {
        let v: unknown
        try {
          v = (value as Record<string, unknown>)[k]
        } catch {
          v = '[unreadable]' // a getter that throws on access
        }
        let redactedKey = redactAndBound(k)
        const occurrence = (seenKeys.get(redactedKey) ?? 0) + 1
        seenKeys.set(redactedKey, occurrence)
        if (occurrence > 1) redactedKey = `${redactedKey}#${occurrence}` // never silently drop a colliding key
        entries.push([redactedKey, redactDeep(v, ancestors)])
      }
      return Object.fromEntries(entries)
    } finally {
      ancestors.delete(value)
    }
  }
  return value
}

function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  return redactDeep(fields) as Record<string, unknown>
}

/** Serializes `detail` and bounds the RESULT's total length — mupot#1520 P2-B. Per-leaf
 *  redaction (`redactAndBound`, `RECEIPT_MESSAGE_MAX_LENGTH`) bounds one string at a time; it
 *  cannot bound how many leaves a call site passes. Rather than truncate the serialized JSON
 *  STRING directly (slicing a JSON document at an arbitrary byte offset overwhelmingly
 *  produces invalid JSON, which the 0169 CHECK — `json_valid(detail)` — would then reject,
 *  turning an oversized receipt into NO receipt at all, the exact `writeProvisionReceipt`
 *  fail-closed trap `redactAndBound`'s own history exists to avoid), an oversized document is
 *  replaced wholesale with a small, always-valid fallback that still names what happened and
 *  by how much it overflowed.
 *
 *  mupot#1523 round-2 P1 item 4: the round-1 fallback hardcoded `ok: false` — an oversized
 *  `receiptOk` (a SUCCESSFUL step whose fields just happened to be too big) was misreported
 *  as a failure, which is itself false information on an append-only ledger. The fallback now
 *  preserves the caller's actual `ok` value and adds `truncated: true` so a reader can tell
 *  "this step succeeded/failed AND its detail was too big to keep" apart from an ordinary
 *  success/failure — the two facts are independent and neither should erase the other. The
 *  ok:true and ok:false shapes stay distinct (no `error` object when `ok:true`), matching the
 *  "one JSON shape per outcome" contract this file's header comment describes. */
function boundSerializedDetail(detail: Record<string, unknown>): string {
  const json = JSON.stringify(detail)
  if (json.length <= MAX_DETAIL_SERIALIZED_LENGTH) return json
  const ok = detail.ok === true
  const message = `receipt detail exceeded ${MAX_DETAIL_SERIALIZED_LENGTH} chars after redaction ` +
    `(${json.length} chars) and was dropped`
  return ok
    ? JSON.stringify({ ok: true, truncated: true, note: message })
    : JSON.stringify({ ok: false, truncated: true, error: { class: 'detail_too_large', message } })
}

/** Builds a failure `detail` — `{ok:false, error:{class, message}}`. `errorClass` is a
 *  short, stable, machine-groupable string (`'sql_error'`, `'http_error'`,
 *  `'transport_error'`, `'seed_failed'`, `'unreachable'`, `'receipt_write_failed'`, ...) —
 *  never the raw message alone, so a receipt reader can group failures without parsing
 *  prose. `extraFields` carries structured, queryable context (e.g. `apply_schema`'s
 *  `file`/`statement_index`/`kind`) alongside the error, same as `receiptOk`'s fields — and
 *  is redacted the same way. Both `errorClass` and `message` go through `redactAndBound`
 *  (mupot#1523 round-2 P1 item 2 — `errorClass` did not, before this). See `receiptOk` for
 *  why this whole function is wrapped in a `try`/`catch` (item 5: never throw). */
export function receiptError(errorClass: string, message: string, extraFields: Record<string, unknown> = {}): string {
  try {
    return boundSerializedDetail({
      ok: false,
      error: { class: redactAndBound(errorClass), message: redactAndBound(message) },
      ...redactFields(extraFields),
    })
  } catch (err) {
    return JSON.stringify({ ok: false, truncated: true, error: { class: 'detail_construction_failed', message: errMsg(err) } })
  }
}

/** Appends one row to `pot_provision_receipts` (migration 0169) on the ORCHESTRATOR's own
 *  D1 (`env.DB` — the same database that carries `pots`, migration 0145), never the
 *  tenant's new pot D1. Returns whether the write actually landed.
 *
 *  FAIL CLOSED (mupot#1507-v2 P0-B — this REVERSES the round-2 version of this function,
 *  which swallowed every write failure on the theory that "the ledger is a durable audit
 *  trail, not a gate"). That reasoning only holds if the write can actually fail for
 *  reasons unrelated to the DATA being written — round 2's own `detail` values violated
 *  the receipt table's own CHECK constraint on every failure path (see `receiptOk`'s doc
 *  comment), so "the ledger swallows its own write failures" was, in practice, "the ledger
 *  silently has no row for any step that failed" — exactly the class of defect a receipt
 *  ledger exists to prevent. `recordStep` (the caller, below) now treats a failed write as
 *  a FAILED STEP regardless of whether the underlying provisioning operation itself
 *  succeeded. Logged via `console.error` — the one channel available this deep in an
 *  already-fail-closed path, and squarely inside a catch block (not a debugging log). */
export async function writeProvisionReceipt(
  env: Env,
  runId: string,
  slug: string,
  step: ProvisionStep,
  ok: boolean,
  detail: string,
  actorMemberId: string | null,
  actorTenant: string | null,
): Promise<boolean> {
  try {
    await env.DB.prepare(
      'INSERT INTO pot_provision_receipts (id, tenant, slug, run_id, step, ok, detail, actor_member_id, actor_tenant, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)',
    )
      .bind(
        crypto.randomUUID(), env.TENANT_SLUG ?? 'mumega', slug, runId, step, ok ? 1 : 0, detail,
        actorMemberId, actorTenant, new Date().toISOString(),
      )
      .run()
    return true
  } catch (error) {
    console.error(
      `pot_provision_receipts write failed for step=${step} slug=${slug} run_id=${runId}: ${errMsg(error)}`,
    )
    return false
  }
}

export interface SlugCheckResult {
  available: boolean
  slug: string
  reason?: string
}

/** A `pots` row left at `status: 'provisioning'` longer than this is presumed abandoned —
 *  a Stripe checkout the customer never completed, or a run that crashed mid-flight
 *  without a later retry (mupot#1507-v2 P1-A). 30 minutes: generous relative to how long a
 *  real provisioning run or a Stripe Checkout session actually takes (minutes, not tens of
 *  minutes), short enough that a genuinely abandoned slug doesn't sit unusable for days. */
export const STALE_PROVISIONING_MS = 30 * 60 * 1000

/** True when `row` is a `pots` row that has been stuck at `status: 'provisioning'` past
 *  `STALE_PROVISIONING_MS`. An `'active'` row (or a fresh `'provisioning'` one) is never
 *  stale — only a provisioning attempt that has had time to either finish or be retried and
 *  still hasn't reads as abandoned. */
function isStaleProvisioningRow(row: { status: string; created_at: string }, nowMs: number): boolean {
  if (row.status !== 'provisioning') return false
  const createdMs = Date.parse(row.created_at)
  if (!Number.isFinite(createdMs)) return false
  return nowMs - createdMs > STALE_PROVISIONING_MS
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
 * FORMAT CHECK DELEGATES TO `validateSlug` (mupot#1507-v2 P2) — this function used to
 * re-implement its own length/character regex, which had DRIFTED from `validateSlug`'s own
 * rule (2-40 there, 3-32 here) — see `validateSlug`'s doc comment for the wrong-error-code
 * consequence that caused. One predicate, called from both places `provisionSovereignPot`
 * checks it (its own `validateSlug(slug)` call at entry, and this function via the registry
 * gate for a brand-new slug).
 *
 * Two DB sources are consulted because BOTH occupy the same `mupot-pots` dispatch
 * namespace: tenant pots (`pots`, migration 0145) and project sub-workers
 * (`src/platform/dispatcher.ts` dispatches `worker_name || slug` into it). A name taken by
 * either is not available to a new pot.
 *
 * A `pots` row stuck at `status: 'provisioning'` past `STALE_PROVISIONING_MS` reads as
 * AVAILABLE here (mupot#1507-v2 P1-A) — a pre-flight UX signal only, telling a prospective
 * customer "you can try this name," never an authorization decision on its own: the actual
 * claim still runs through `provisionSovereignPot`'s registry gate, which refuses a
 * DIFFERENT provisioner on a stale-but-still-`provisioning` row until an org:admin
 * explicitly frees it via `pot_release` (see that function). An `'active'` row is NEVER
 * reported available regardless of age.
 */
export async function checkSlugAvailability(env: Env, rawSlug: string): Promise<SlugCheckResult> {
  const slug = (rawSlug || '').toLowerCase().trim()

  const format = validateSlug(slug)
  if (!format.ok) {
    return { available: false, slug, reason: format.error }
  }

  try {
    const takenByPot = await env.DB.prepare('SELECT status, created_at FROM pots WHERE slug = ?1 LIMIT 1')
      .bind(slug)
      .first<{ status: string; created_at: string }>()
    if (takenByPot && !isStaleProvisioningRow(takenByPot, Date.now())) {
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

/** Thrown by `provisionSovereignPot` when `validateSlug` refuses the requested slug's
 *  FORMAT (too short/long, illegal characters, reserved word) — distinct from
 *  `PotSlugTakenError`, which means "this name is valid but already claimed by someone
 *  else." Before mupot#1507-v2 P2, a format refusal threw a plain `Error`, which
 *  `src/pots/routes.ts`/`src/mcp/pots.ts` had no specific catch for and fell through to a
 *  generic 500 `provisioning_failed` — the wrong status for "the input was malformed,"
 *  which callers can fix and retry immediately, unlike a genuine server error. */
export class InvalidSlugError extends Error {
  readonly code = 'invalid_slug' as const
  constructor(readonly slug: string, reason: string) {
    super(reason)
    this.name = 'InvalidSlugError'
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
    throw new InvalidSlugError(slug, valid.error)
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
  const actorCheckoutSessionId = input.checkout_session_id ?? null

  const runId = crypto.randomUUID()
  const completed: ProvisionStep[] = []
  const receipts: ProvisionStepReceipt[] = []
  const orphans: OrphanedResources = {
    d1_database_id: null, d1_database_name: null, d1_adopted: false,
    kv_namespace_id: null, kv_namespace_title: null, kv_adopted: false,
  }

  /** Fail-closed (mupot#1507-v2 P0-B): returns whether this step is now considered
   *  successfully completed, which is `ok && the receipt actually landed`. A step whose
   *  underlying operation succeeded but whose receipt could not be WRITTEN is treated as a
   *  FAILED step — see `writeProvisionReceipt`'s doc comment for why swallowing that used
   *  to make failed steps disappear entirely instead of just this one edge. `detail` is
   *  always a `receiptOk`/`receiptError` JSON string — every call site below builds it
   *  through exactly one of those two functions. */
  const recordStep = async (step: ProvisionStep, ok: boolean, detail: string): Promise<boolean> => {
    const written = await writeProvisionReceipt(env, runId, slug, step, ok, detail, actorMemberId, actorTenant)
    const effectiveOk = ok && written
    receipts.push({
      step,
      ok: effectiveOk,
      detail: written
        ? detail
        : receiptError('receipt_write_failed', "this step's receipt could not be written to pot_provision_receipts — treated as a failed step (fail-closed)"),
    })
    if (effectiveOk) completed.push(step)
    return effectiveOk
  }

  // 0. Registry gate — BEFORE any Cloudflare call (mupot#1507 round-2 P0-4, Athena
  // condition i; ownership check corrected mupot#1507-v2 P0-C). `pots` (migration 0145)
  // plus its `provisioner_member_id`/`provisioner_tenant` (migration 0170) and
  // `checkout_session_id` (migration 0170, added mupot#1507-v2) columns is the
  // account-wide ownership record: a slug already claimed by a DIFFERENT owner is refused
  // outright, never silently adopted. A brand-new slug is claimed HERE, before create_d1
  // — the INSERT's own UNIQUE(slug) constraint is the concurrency guard: if two calls race
  // for the same fresh slug, the loser's INSERT throws and it is refused exactly like a
  // pre-existing claim would be, never adopts what the winner is mid-creating.
  const existingPotRow = await env.DB.prepare(
    'SELECT status, provisioner_member_id, provisioner_tenant, checkout_session_id FROM pots WHERE slug = ?1 LIMIT 1',
  )
    .bind(slug)
    .first<{
      status: string
      provisioner_member_id: string | null
      provisioner_tenant: string | null
      checkout_session_id: string | null
    }>()

  if (existingPotRow) {
    if (existingPotRow.status === 'released') {
      // An org:admin explicitly freed this slug via `releaseStalePot` — adoptable by ANY
      // new caller, same as a brand-new slug, except this row is UPDATEd (the
      // UNIQUE(slug) constraint already holds it) rather than INSERTed. The
      // `WHERE status = 'released'` clause is the concurrency guard: if two callers race
      // to claim the same just-released slug, the loser's UPDATE affects zero rows.
      const claim = await env.DB.prepare(
        "UPDATE pots SET status = 'provisioning', source = 'provision', created_at = ?2, " +
          'provisioner_member_id = ?3, provisioner_tenant = ?4, checkout_session_id = ?5 ' +
          "WHERE slug = ?1 AND status = 'released'",
      )
        .bind(slug, new Date().toISOString(), actorMemberId, actorTenant, actorCheckoutSessionId)
        .run()
      if ((claim.meta?.changes ?? 0) === 0) {
        // Lost the race — someone else's claim landed first.
        throw new PotSlugTakenError(slug)
      }
    } else {
      // A checkout-session claim can only be adopted by the EXACT same session (mupot#1507-v2
      // P0-C) — this is what makes a Stripe webhook replay idempotent (same session id =>
      // same claim => adopt) while refusing a genuinely DIFFERENT session on the same slug.
      // A member-claimed row can only be adopted by that exact (member, tenant) pair. A row
      // with NEITHER claim set is unclaimed and is NEVER adoptable by anyone — including
      // another caller who also carries no identity: two `null === null` callers matching
      // each other is exactly how a second self-serve buyer used to redeploy over a live
      // customer's pot when this deployment's own TENANT_SLUG was unset.
      const isOwner = existingPotRow.checkout_session_id !== null
        ? actorCheckoutSessionId !== null && actorCheckoutSessionId === existingPotRow.checkout_session_id
        : existingPotRow.provisioner_member_id !== null
          ? actorMemberId === existingPotRow.provisioner_member_id && actorTenant === existingPotRow.provisioner_tenant
          : false
      if (!isOwner) {
        throw new PotSlugTakenError(slug)
      }
      // Owner retry — falls through to the normal reuse-by-name flow below (create_d1 etc.
      // adopt the existing CF resources by name, exactly as before this gate existed).
    }
  } else {
    const availability = await checkSlugAvailability(env, slug)
    if (!availability.available) {
      throw new PotSlugTakenError(slug, availability.reason)
    }
    try {
      await env.DB.prepare(
        'INSERT INTO pots (id, slug, worker_script, status, source, created_at, provisioner_member_id, provisioner_tenant, checkout_session_id) ' +
          'VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)',
      )
        .bind(
          crypto.randomUUID(), slug, slug, 'provisioning', 'provision', new Date().toISOString(),
          actorMemberId, actorTenant, actorCheckoutSessionId,
        )
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

  // PREFLIGHT: resolve the worker bundle source BEFORE touching any Cloudflare resource
  // (mupot#1516 round-2 ENABLEMENT GATE). Before this, a deployment with neither
  // `POT_WORKER_BUNDLE_BUCKET` configured nor a `workerJsCode` argument would burn a REAL,
  // billable D1 (step 1) and KV namespace (step 2) — and apply the ENTIRE schema chain
  // (step 3) — before discovering at step 4 that there was never anything to deploy. This
  // is the exact orphan class #1285 documents (Psychonom's D1/KV, created and then
  // abandoned when a later step failed) recurring for a class of failure that is knowable
  // BEFORE the first Cloudflare call: whether a bundle source exists at all does not depend
  // on the slug, the D1, or the schema. Resolved ONCE, here, and reused unchanged at the
  // real `deploy_worker` step below (never re-resolved — an R2 GET is not free, and
  // resolving twice could theoretically observe two different answers).
  const preflightBundle = await loadPotWorkerBundle(env, workerJsCode)
  if (!preflightBundle.ok) {
    await recordStep('deploy_worker', false, receiptError('no_bundle_source', preflightBundle.reason))
    return bail(`deploy_worker failed (preflight, before any Cloudflare call): ${preflightBundle.reason}`)
  }
  const bundle = preflightBundle.bundle

  // 1. D1 — reuse-or-create, idempotent on slug.
  const dbName = `mupot-pot-${slug}`
  let d1: { uuid: string; name: string; adopted: boolean }
  try {
    d1 = await getOrCreateD1Database(cf, dbName)
  } catch (error) {
    await recordStep('create_d1', false, receiptError('http_error', errMsg(error)))
    return bail(`create_d1 failed: ${errMsg(error)}`)
  }
  orphans.d1_database_id = d1.uuid
  orphans.d1_database_name = d1.name
  orphans.d1_adopted = d1.adopted
  if (!(await recordStep('create_d1', true, receiptOk({ adopted: d1.adopted, database_id: d1.uuid })))) {
    return bail('create_d1 succeeded but its receipt failed to write — treated as a failed step (fail-closed)')
  }

  // 2. KV — reuse-or-create, idempotent on slug.
  const kvTitle = `mupot-pot-${slug}-kv`
  let kv: { id: string; title: string; adopted: boolean }
  try {
    kv = await getOrCreateKVNamespace(cf, kvTitle)
  } catch (error) {
    await recordStep('create_kv', false, receiptError('http_error', errMsg(error)))
    return bail(`create_kv failed: ${errMsg(error)}`)
  }
  orphans.kv_namespace_id = kv.id
  orphans.kv_namespace_title = kv.title
  orphans.kv_adopted = kv.adopted
  if (!(await recordStep('create_kv', true, receiptOk({ adopted: kv.adopted, namespace_id: kv.id })))) {
    return bail('create_kv succeeded but its receipt failed to write — treated as a failed step (fail-closed)')
  }

  // 3. Apply the schema chain (src/pots/schema-chain.ts) via the D1 REST API.
  let alreadyApplied: Set<string>
  try {
    alreadyApplied = await loadAlreadyAppliedSet(cf, d1.uuid)
  } catch (error) {
    await recordStep('apply_schema', false, receiptError('read_error', `could not read pot_schema_applied: ${errMsg(error)}`))
    return bail(`apply_schema failed reading bookkeeping: ${errMsg(error)}`)
  }
  let schemaResult: ApplySchemaChainResult
  try {
    schemaResult = await applySchemaChain(makeD1Exec(cf, d1.uuid), { alreadyApplied })
  } catch (error) {
    await recordStep('apply_schema', false, receiptError('transport_error', errMsg(error)))
    return bail(`apply_schema threw: ${errMsg(error)}`)
  }
  if (schemaResult.failed) {
    const detail =
      `file=${schemaResult.failed.file} statementIndex=${schemaResult.failed.statementIndex} ` +
      `kind=${schemaResult.failed.kind}: ${schemaResult.failed.error}`
    await recordStep('apply_schema', false, receiptError('sql_error', schemaResult.failed.error, {
      file: schemaResult.failed.file,
      statement_index: schemaResult.failed.statementIndex,
      kind: schemaResult.failed.kind,
    }))
    return bail(`apply_schema failed: ${detail}`)
  }
  if (!(await recordStep(
    'apply_schema',
    true,
    receiptOk({ applied: schemaResult.applied.length, skipped: schemaResult.skipped.length }),
  ))) {
    return bail('apply_schema succeeded but its receipt failed to write — treated as a failed step (fail-closed)')
  }

  // 4. Deploy the tenant worker into the dispatch namespace. Digest-verified (mupot#1507
  // round 2 requirement 4) — see loadPotWorkerBundle's doc comment. `bundle` was already
  // resolved by the PREFLIGHT check above, before create_d1 — not re-resolved here.
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
    await recordStep('deploy_worker', false, receiptError('http_error', errMsg(error)))
    return bail(`deploy_worker failed: ${errMsg(error)}`)
  }
  // The receipt names the EXACT bytes deployed — source, digest, and (for R2) which
  // published object — regardless of which source won, per requirement 4: "the
  // worker_js_code fallback is digest-receipted too".
  if (!(await recordStep(
    'deploy_worker',
    true,
    receiptOk({
      source: bundle.source,
      sha256: bundle.sha256,
      ...(bundle.r2ObjectKey ? { r2_object_key: bundle.r2ObjectKey } : {}),
    }),
  ))) {
    return bail('deploy_worker succeeded but its receipt failed to write — treated as a failed step (fail-closed)')
  }

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
    await recordStep('seed_identities', false, receiptError('transport_error', errMsg(error)))
    return bail(`seed_identities threw: ${errMsg(error)}`)
  }
  if (!seed.ok) {
    const seedFailureDetail = seed.detail ?? 'unknown seed failure'
    await recordStep('seed_identities', false, receiptError('seed_failed', seedFailureDetail))
    return bail(`seed_identities failed: ${seedFailureDetail}`)
  }
  // Structured, not prose — this is what makes the bootstrap QUERYABLE from the parent
  // (mupot#1507 round-2 requirement 1): admin_member_id and both fingerprints, never a
  // raw token or a live claim. json_extract() can pull this back out of the TEXT column
  // like every other JSON-shaped receipt detail in this schema.
  if (!(await recordStep(
    'seed_identities',
    true,
    receiptOk({
      already_seeded: seed.alreadySeeded,
      admin_member_id: seed.adminMemberId,
      admin_token_fingerprint: seed.adminTokenFingerprint,
      lead_agent_id: seed.leadAgentId,
      lead_agent_member_id: seed.leadAgentMemberId || null,
      lead_agent_token_fingerprint: seed.leadAgentTokenFingerprint,
    }),
  ))) {
    return bail('seed_identities succeeded but its receipt failed to write — treated as a failed step (fail-closed)')
  }

  // 6. Verify reachability through the real dispatch path BEFORE claiming success.
  // Structured JSON, never the raw /health body — mupot#1507 round-2 P2. `bodySha256`
  // lets an operator notice "the response changed" without the body itself ever landing
  // in a receipt.
  const reach = await verifyPotReachable(env, slug, rootDomain)
  const reachFields = {
    status: reach.status,
    tenant_match: reach.tenantMatch,
    release_sha_match: reach.releaseShaMatch,
    body_sha256: reach.bodySha256,
  }
  const verifyReceiptWritten = await recordStep(
    'verify_reachable',
    reach.ok,
    reach.ok ? receiptOk(reachFields) : receiptError('unreachable', reach.detail, reachFields),
  )
  if (!reach.ok) {
    return bail(`verify_reachable failed: ${reach.detail}`)
  }
  if (!verifyReceiptWritten) {
    return bail('verify_reachable succeeded but its receipt failed to write — treated as a failed step (fail-closed)')
  }

  // Every step passed. Finalize the registry row (mupot#1507 round-2 P0-2/P0-4) — `ok` /
  // `status: 'provisioned'` requires this write to land too, not just the six steps above.
  // NOTE: this is not itself one of the six named `ProvisionStep`s, so a failure here is
  // the one case where `bail()`'s `not_completed` reads `[]` under `status: 'incomplete'`
  // — `incomplete_reason` is the authoritative signal for this specific edge, not the
  // (otherwise reliable) empty-array-means-provisioned convention. The `pots` row itself
  // is left at whatever status it was already at (normally `'provisioning'`), which is
  // accurate: every step ran, but the registry does not yet agree, so a retry by the SAME
  // provisioner still adopts correctly.
  //
  // GUARDED BY THIS RUN'S OWN CLAIM, NOT JUST THE SLUG (mupot#1516 round-2 P3). The six
  // steps above can take real wall-clock time (up to ~970 sequential D1 REST calls for a
  // fresh schema chain) — long enough for the row this run claimed at the registry gate to
  // have been reassigned since: an org:admin's `pot_release` on a run that looked stale but
  // wasn't, then a DIFFERENT provisioner's claim, racing THIS run's own finish line. An
  // unconditional `WHERE slug = ?1` would mark that OTHER provisioner's now-claimed row
  // `'active'` on THIS run's say-so — a false success for a pot this run no longer owns.
  // The WHERE clause re-asserts the SAME ownership predicate the registry gate itself used
  // (checkout-session match, or member+tenant match); `status IN ('provisioning', 'active')`
  // — not JUST `'provisioning'` — because an idempotent RETRY of an already-provisioned run
  // (e.g. a replayed Stripe webhook for a self-serve checkout) reaches this same UPDATE with
  // the row already `'active'`, and that retry must still report `ok: true`, not a false
  // "lost ownership" refusal for a status transition that has nothing left to do.
  // `meta.changes` is checked the same way `releaseStalePot`'s own guard is, for the same
  // reason — a 0-row UPDATE (ownership mismatch) is never treated as a success; a WHERE
  // match on an already-`'active'` row still counts as 1 change (verified empirically
  // against node:sqlite — `UPDATE ... SET x = x WHERE ...` counts the matched row).
  try {
    const activation = await env.DB.prepare(
      `UPDATE pots SET status = 'active' WHERE slug = ?1 AND status IN ('provisioning', 'active') AND (
         (checkout_session_id IS NOT NULL AND checkout_session_id = ?2)
         OR (checkout_session_id IS NULL AND provisioner_member_id IS ?3 AND provisioner_tenant IS ?4)
       )`,
    )
      .bind(slug, actorCheckoutSessionId, actorMemberId, actorTenant)
      .run()
    if ((activation.meta?.changes ?? 0) === 0) {
      return bail(
        'registry activation refused: this run no longer owns the slug (reclaimed, released, or altered ' +
          'concurrently) — all six steps completed, but the pots row could not be marked active under this ' +
          "run's own claim",
      )
    }
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

export type ReleaseStalePotResult =
  | { ok: true; slug: string; released_from_status: string }
  | {
      ok: false
      slug: string
      error:
        | 'not_found'
        | 'not_stale'
        | 'cannot_release_active_pot'
        /** The row's status changed between this call's own SELECT and its UPDATE (a
         *  provisioner reclaimed it, or a concurrent release already landed) — the
         *  `WHERE status = ?2` guard caught it, `meta.changes === 0`. Never reported as a
         *  success (mupot#1516 round-2 P1-2): a stale read must not be allowed to certify a
         *  write that never happened. */
        | 'release_lost_race'
        /** The state flip landed but its OWN receipt could not be written — reverted rather
         *  than left as an unreceipted status change (mupot#1516 round-2 P1-1: the ledger is
         *  the only durable record of WHO released a slug and WHY; a release with no
         *  receipt is exactly the "ran, changed something, and left no trace" failure mode
         *  `provisionSovereignPot`'s own `recordStep` already treats as fail-closed). */
        | 'receipt_write_failed'
    }

/**
 * Releases a `pots` row stuck at `status: 'provisioning'` past `STALE_PROVISIONING_MS`, so
 * a DIFFERENT provisioner can subsequently claim the slug (mupot#1507-v2 P1-A). The SAME
 * provisioner never needs this — `provisionSovereignPot`'s registry gate already lets an
 * owner retry their own claimed row regardless of age; this exists ONLY for the case where
 * the original provisioner is gone (abandoned checkout, crashed run, no retry coming) and a
 * DIFFERENT caller now wants the name.
 *
 * Deliberately NOT automatic and NOT reachable by the ordinary provisioning path — an
 * org:admin action, explicit and receipted (`pot_provision_receipts`, step `'release'`),
 * because silently reassigning a name out from under a still-possibly-active attempt is
 * exactly the kind of footgun this whole file exists to close (see `#1285`'s own "adoption
 * without ownership" history). Refuses outright, never releases:
 *   - a row that does not exist (`not_found`)
 *   - an `'active'` pot, regardless of age (`cannot_release_active_pot` — a live customer
 *     pot is never a candidate for this, only an abandoned PROVISIONING attempt is)
 *   - a `'provisioning'` row that is not yet stale (`not_stale` — still within the window a
 *     legitimate retry could land in)
 */
export async function releaseStalePot(
  env: Env,
  rawSlug: string,
  actorMemberId: string | null,
  actorTenant: string | null,
): Promise<ReleaseStalePotResult> {
  const slug = (rawSlug || '').toLowerCase().trim()
  const row = await env.DB.prepare('SELECT status, created_at FROM pots WHERE slug = ?1 LIMIT 1')
    .bind(slug)
    .first<{ status: string; created_at: string }>()

  if (!row) {
    return { ok: false, slug, error: 'not_found' }
  }
  if (row.status === 'active') {
    return { ok: false, slug, error: 'cannot_release_active_pot' }
  }
  if (!isStaleProvisioningRow(row, Date.now())) {
    return { ok: false, slug, error: 'not_stale' }
  }

  // The WHERE clause is the concurrency guard — same shape as the registry gate's own
  // released-row reclaim. `meta.changes` MUST be read: a stale `row.status` read earlier in
  // this function (the pot was reclaimed by its provisioner, or released by a concurrent
  // call) means this UPDATE's WHERE clause matches nothing, and an unchecked `.run()` would
  // let this function report `ok:true` for a write that never happened (mupot#1516 round-2
  // P1-2).
  const update = await env.DB.prepare("UPDATE pots SET status = 'released' WHERE slug = ?1 AND status = ?2")
    .bind(slug, row.status)
    .run()
  if ((update.meta?.changes ?? 0) === 0) {
    return { ok: false, slug, error: 'release_lost_race' }
  }

  // FAIL CLOSED (mupot#1516 round-2 P1-1). The round-2 version of this function fired the
  // UPDATE and then called `writeProvisionReceipt` WITHOUT checking its returned boolean —
  // exactly the swallow `recordStep` (provisionSovereignPot's own receipt writer) was fixed
  // to stop doing. A discarded `false` here meant: the state flip lands durably, `ok:true`
  // goes back to the caller, and the append-only ledger carries ZERO rows explaining who
  // released the slug or why. Since there is no atomic multi-statement transaction
  // available here that can conditionally include-or-skip the receipt based on the UPDATE's
  // OWN runtime result (D1's batch API commits every statement in a batch unconditionally;
  // it cannot itself decide not to run statement 2 because statement 1 changed 0 rows), a
  // receipt-write failure AFTER a real state change is handled by explicit compensation:
  // revert the status flip rather than leave an unreceipted mutation on a table other code
  // paths trust as ground truth.
  const receiptWritten = await writeProvisionReceipt(
    env,
    crypto.randomUUID(),
    slug,
    'release',
    true,
    receiptOk({ released_from_status: row.status }),
    actorMemberId,
    actorTenant,
  )
  if (!receiptWritten) {
    try {
      await env.DB.prepare("UPDATE pots SET status = ?2 WHERE slug = ?1 AND status = 'released'")
        .bind(slug, row.status)
        .run()
    } catch (error) {
      console.error(`releaseStalePot: compensating revert failed for slug=${slug}: ${errMsg(error)}`)
    }
    return { ok: false, slug, error: 'receipt_write_failed' }
  }

  return { ok: true, slug, released_from_status: row.status }
}
