// inkwell.ts — S4: the inkwell-content ACT executor adapter.
//
// PURE + FAIL-CLOSED. Given a resolved config { apiUrl, token } and the STORED
// proposal payload, POSTs one content write to the Inkwell API and returns the
// created artifact. No env access, no connector decrypt, no DB — those happen at
// the Worker boundary which resolves the connector credential (Hadi-go) and passes
// the narrow config in. This keeps the kernel pure + unit-testable, and means the
// adapter is inert unless the Worker explicitly supplies a credential.
//
// CRO APPLY-BRIDGE (S5b) ADDITION — fetch-then-merge, never full-replace:
//
// The plain create/seo-meta-fix path above is a full-body REPLACE by design (see the
// PublishBody ⚠ note) — correct for "create new" and for a human-composed meta-fix that
// already has the current body in hand (collectors/seo-meta-fix.ts), wrong for an agent-
// proposed, narrowly-scoped CRO change (a meta_title/description/CTA/link tweak) where
// the caller has NOT read the current article and must never silently clobber it.
//
// fetchInkwellContent + mergeContentUpdate + inkwellContentApplyWrite add a SECOND write
// path: read the current post (GET /api/internal/content/:slug, mumega.com PR — same
// tenant-bound-secret trust model as POST /publish), patch ONLY the targeted field, and
// write the merged whole back. FAIL-CLOSED at every step: a fetch error, a missing
// article (404), or an ambiguous/absent find-target all throw BEFORE any write — there is
// no path from a failed read to a partial/blank write.
//
// inkwellContentDispatch is the new kernel.ts call site: it inspects the stored payload's
// `mode` field and routes to the merge path or the existing full-replace path. This is a
// payload-SHAPE branch (like toPublishBody vs toMetaFixPublishBody), not an action-string
// branch — kernel.ts's domain-agnostic dispatch discipline (see collectors/seo-meta-fix.ts
// "WHY NO KERNEL.TS CHANGE") is preserved; kernel.ts still dispatches purely on
// payload.executor === 'inkwell-content', now calling this one extra layer of indirection.
//
// #370 SLICE A (CMS-adapter port, behavior-identical refactor): the CMS-agnostic parts of
// the merge logic above — the title/description/content branch logic, the fetch-then-merge
// orchestration, and the redirect-refusing fetch wrapper — now live in
// executors/shared/cms-adapter.ts as the CmsAdapter port + cmsContentApplyWrite
// orchestrator. This file is a thin CmsAdapter implementation over that module:
// fetchCurrentAdapter/applyChangeAdapter/writeAdapter below wire fetchInkwellContent /
// mergeContentUpdate / postPublishBody (all still exported below, unchanged, still
// directly tested) into the shared shape. Every export below keeps its exact name,
// signature, and behavior — see PR/gate notes for the parity claim.

import { assertPublicHttpsUrl } from '../../lib/ssrf'
import { classifyChangeType, isKnownChangeType, type CroChangeType } from '../change-types'
import {
  cmsContentApplyWrite,
  cmsFetch,
  mergeByChangeType,
  resolveCmsFetch,
  type CmsAdapter,
  type CmsChangeRequest,
  type ContentMergeDiff,
  type FetchedContent,
} from './shared/cms-adapter'

export type { ContentMergeDiff }

export interface InkwellExecutorConfig {
  /** Inkwell API origin, e.g. https://inkwell-api.mumega.com (https, public host). */
  apiUrl: string
  /** Bearer secret for the internal pot-publish endpoint (per-pot 'inkwell' connector). */
  token: string
  /**
   * Pot tenant slug — sent EXPLICITLY in the body so inkwell-api writes to this
   * pot's draft area (the internal endpoint is tenant-explicit, not host-resolved).
   * The write is always a DRAFT (server-forced), pot-scoped.
   */
  tenantSlug: string
  /**
   * Optional service-binding Fetcher. When the pot's Inkwell lives on the SAME
   * Cloudflare zone, a public-edge fetch loops back and times out (CF 522). A
   * service binding routes the subrequest internally (worker→worker RPC), never
   * touching the public edge. When set, the write goes through this Fetcher; the
   * apiUrl still supplies the request PATH (the bound service ignores the host).
   * Absent → public-edge fetch (cross-zone tenants, tests).
   */
  fetcher?: Fetcher
}

export interface InkwellWriteResult {
  ok: true
  slug: string
  url: string
}

/**
 * Body accepted by Inkwell's POST /api/internal/content/publish.
 *
 * ⚠ `overwrite` IS INERT SERVER-SIDE. The real sink (workers/inkwell-api/src/
 * routes/internal-content.ts → lib/tenant-content.ts putContent()) never reads
 * this field. Every write is an UNCONDITIONAL full replace of (tenant, slug):
 * an unguarded `kv.put(post:slug, markdown)` plus `INSERT OR REPLACE INTO
 * content_index`, regardless of what `overwrite` says or whether it's present at
 * all. There is no partial update and no create-vs-update distinction at the
 * sink. This field exists only so a caller can document intent in the stored
 * payload/request body — it grants ZERO protection. Do not write code, comments,
 * or tests that treat it as a safety/protective mechanism.
 */
interface PublishBody {
  title: string
  content: string
  slug?: string
  author: string
  tags: string[]
  description: string
  status: 'draft' | 'published' | 'archived'
  /** Advisory/inert — see the doc comment on PublishBody above. */
  overwrite: boolean
}

/**
 * Map an opaque stored proposal payload to a publish body. Returns null when the
 * required fields (title + content) are absent — the caller must fail-closed.
 * `status` defaults conservatively to 'draft' (never auto-publish; the sink also
 * force-overrides to 'draft' regardless, see internal-content.ts). `overwrite`
 * defaults to false here only as a payload-shape default — it has no effect on
 * what the sink does (see PublishBody doc above); every write is a full replace
 * either way.
 */
export function toPublishBody(payload: unknown): PublishBody | null {
  if (payload === null || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  const title = typeof p.title === 'string' ? p.title.trim() : ''
  const content = typeof p.content === 'string' ? p.content : ''
  if (!title || !content) return null
  const status = p.status === 'published' || p.status === 'archived' ? p.status : 'draft'
  return {
    title,
    content,
    slug: typeof p.slug === 'string' && p.slug ? p.slug : undefined,
    author: typeof p.author === 'string' && p.author ? p.author : 'mupot',
    tags: Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === 'string') : [],
    description: typeof p.description === 'string' ? p.description : '',
    status,
    overwrite: p.overwrite === true,
  }
}

/**
 * Map an opaque stored proposal payload to a publish body for an UPDATE-EXISTING
 * action (mupot Flight 2 slice 1: seo-meta-fix). Mirrors toPublishBody, but:
 *
 *   - REQUIRES slug. toPublishBody treats slug as optional and auto-derives one
 *     from the title when absent — correct for "create new content", wrong for
 *     "fix this existing item's meta". A meta-fix with no target slug must never
 *     silently fall through to slug-from-title and create a stray duplicate. This
 *     is the ONE real, enforced invariant this function contributes — a required
 *     slug, checked in code, on the request path.
 *   - Sets overwrite=true unconditionally, regardless of what the stored payload
 *     set (or omitted). This is advisory only: the sink (see PublishBody doc
 *     above / internal-content.ts) does not read `overwrite` and performs an
 *     unconditional full replace on EVERY write it accepts, slug-required or
 *     not. Setting it true here just keeps the stored/sent payload's stated
 *     intent consistent with what always actually happens — it does not add any
 *     protection beyond the slug check.
 *
 * Returns null (fail-closed) when toPublishBody itself would (missing/blank
 * title or content) OR when slug is absent — the caller must refuse to write.
 */
export function toMetaFixPublishBody(payload: unknown): PublishBody | null {
  const body = toPublishBody(payload)
  if (!body || !body.slug) return null
  return { ...body, overwrite: true }
}

export class InkwellExecutorError extends Error {
  constructor(public readonly reason: string, message?: string) {
    super(message ?? reason)
    this.name = 'InkwellExecutorError'
  }
}

// SSRF guard. apiUrl is config-sourced (not payload) today, but the executor must not be
// steerable to an internal / loopback / cloud-metadata target by a misconfigured or hostile
// config. The hardened private-host blocker (IPv4-mapped IPv6, ULA, link-local, CGNAT, IPv4
// evasions) now lives in src/lib/ssrf.ts and is shared with the PostHog CRO connector (#219).
// (DNS-rebind — a public name re-resolving to an internal IP at fetch — is out of scope for
// a parse-time check; mitigate with an origin allowlist if apiUrl ever becomes payload-driven.)
function assertSafeInkwellUrl(apiUrl: string): URL {
  try {
    return assertPublicHttpsUrl(apiUrl)
  } catch (e) {
    const code = e instanceof Error ? e.message : 'url_unparseable'
    const detail =
      code === 'url_not_https'
        ? 'apiUrl must be https'
        : code === 'url_private_host'
          ? 'apiUrl host is private/internal'
          : 'apiUrl is not a valid URL'
    throw new InkwellExecutorError('inkwell_bad_apiurl', detail)
  }
}

/**
 * Fetch precedence shared by every function in this file: an explicit fetchImpl
 * (tests) wins; otherwise the service binding (cfg.fetcher) when present (same-zone
 * 522 avoidance); else global fetch. Delegates to the shared resolveCmsFetch — #370
 * Slice A: this precedence chain is CMS-agnostic, hoisted to shared/cms-adapter.ts.
 */
function resolveFetch(cfg: InkwellExecutorConfig, fetchImpl?: typeof fetch): typeof fetch {
  return resolveCmsFetch(cfg.fetcher, fetchImpl)
}

/**
 * Shared low-level request: resolves the safe base URL, attaches the Bearer +
 * User-Agent (Worker→Worker subrequests carry no default UA; the mumega.com zone WAF
 * 403s a UA-less/bot-looking request otherwise — error 1010, same fix the fleet
 * report hook needed), refuses redirects outright, and returns the raw Response for
 * the caller to interpret (a GET treats 404 as a valid "not found" outcome; a POST
 * treats any non-ok as a hard error) — never follows a redirect, never retries.
 *
 * #370 Slice A: the redirect-refusing fetch mechanics (redirect:'manual' +
 * opaqueredirect/3xx refusal) now live in the shared cmsFetch helper
 * (shared/cms-adapter.ts) — this function only supplies the inkwell-specific base
 * URL, auth header, and error reasons/messages.
 */
async function doInkwellFetch(
  cfg: InkwellExecutorConfig,
  doFetch: typeof fetch,
  path: string,
  init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string },
): Promise<Response> {
  const base = assertSafeInkwellUrl(cfg.apiUrl)
  return cmsFetch(
    base.origin,
    doFetch,
    path,
    {
      method: init.method,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        'user-agent': 'mupot-executor/1.0',
        ...init.headers,
      },
      body: init.body,
    },
    {
      unreachable: (detail) => new InkwellExecutorError('inkwell_unreachable', detail),
      redirectBlocked: () =>
        new InkwellExecutorError('inkwell_redirect_blocked', 'refusing to follow a redirect from apiUrl'),
    },
  )
}

/** POST a fully-formed PublishBody and parse the standard { ok, slug, url } response. */
async function postPublishBody(
  cfg: InkwellExecutorConfig,
  body: PublishBody,
  fetchImpl?: typeof fetch,
): Promise<InkwellWriteResult> {
  const doFetch = resolveFetch(cfg, fetchImpl)
  // tenant-explicit, pot-scoped, server-forced-draft internal endpoint.
  const internalBody = { ...body, tenant_slug: cfg.tenantSlug }
  const res = await doInkwellFetch(cfg, doFetch, '/api/internal/content/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(internalBody),
  })
  if (!res.ok) {
    throw new InkwellExecutorError('inkwell_http_error', `status ${res.status}`)
  }
  const json = (await res.json().catch(() => null)) as { ok?: boolean; slug?: string; url?: string } | null
  if (!json || json.ok !== true || !json.slug || !json.url) {
    throw new InkwellExecutorError('inkwell_bad_response', 'response missing ok/slug/url')
  }
  return { ok: true, slug: json.slug, url: json.url }
}

/**
 * Write one content artifact to Inkwell. Throws InkwellExecutorError (fail-closed)
 * on missing config, unmappable payload, or a non-ok response. `fetchImpl` is
 * injectable for tests.
 */
export async function inkwellContentWrite(
  cfg: InkwellExecutorConfig,
  payload: unknown,
  fetchImpl?: typeof fetch,
): Promise<InkwellWriteResult> {
  if (!cfg || !cfg.apiUrl || !cfg.token || !cfg.tenantSlug) {
    throw new InkwellExecutorError('inkwell_not_configured', 'missing apiUrl, token, or tenantSlug')
  }
  const body = toPublishBody(payload)
  if (!body) {
    throw new InkwellExecutorError('invalid_payload', 'stored payload lacks title/content')
  }
  return postPublishBody(cfg, body, fetchImpl)
}

// ── CRO apply-bridge: fetch (GET /api/internal/content/:slug) ────────────────────

/** The current article's editable fields, as read back from Inkwell. */
export interface FetchedInkwellContent {
  title: string
  description: string
  author: string
  tags: string[]
  status: 'draft' | 'published' | 'archived'
  /** Frontmatter-stripped body — the exact shape PublishBody.content expects. */
  content: string
}

/**
 * Read the current content for `slug` under cfg.tenantSlug. FAIL-CLOSED: any config
 * problem, network error, redirect, or malformed response THROWS InkwellExecutorError
 * — this function never returns a partial/blank result to paper over a failure.
 * Returns null ONLY for a genuine 404 (no content stored at this slug for this
 * tenant) — the caller (inkwellContentApplyWrite) treats null as "cannot merge,
 * refuse to write", never as "start from empty".
 */
export async function fetchInkwellContent(
  cfg: InkwellExecutorConfig,
  slug: string,
  fetchImpl?: typeof fetch,
): Promise<FetchedInkwellContent | null> {
  if (!cfg || !cfg.apiUrl || !cfg.token || !cfg.tenantSlug) {
    throw new InkwellExecutorError('inkwell_not_configured', 'missing apiUrl, token, or tenantSlug')
  }
  if (!slug) {
    throw new InkwellExecutorError('invalid_payload', 'fetch requires a non-empty slug')
  }
  const doFetch = resolveFetch(cfg, fetchImpl)
  const path = `/api/internal/content/${encodeURIComponent(slug)}?tenant_slug=${encodeURIComponent(cfg.tenantSlug)}`
  const res = await doInkwellFetch(cfg, doFetch, path, { method: 'GET' })
  if (res.status === 404) return null
  if (!res.ok) {
    throw new InkwellExecutorError('inkwell_fetch_http_error', `status ${res.status}`)
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!json || json.ok !== true || typeof json.content !== 'string') {
    throw new InkwellExecutorError('inkwell_fetch_bad_response', 'fetch response missing ok/content')
  }
  return {
    title: typeof json.title === 'string' ? json.title : '',
    description: typeof json.description === 'string' ? json.description : '',
    author: typeof json.author === 'string' ? json.author : '',
    tags: Array.isArray(json.tags) ? json.tags.filter((t): t is string => typeof t === 'string') : [],
    status: json.status === 'published' || json.status === 'archived' ? json.status : 'draft',
    content: json.content,
  }
}

// ── CRO apply-bridge: merge ────────────────────────────────────────────────────

/** The stored gate-record shape a CRO apply produces (collectors/cro-apply.ts). */
export interface CroApplyMergePayload {
  executor: 'inkwell-content'
  mode: 'cro-apply-merge'
  slug: string
  changeType: CroChangeType
  /** The new value for the targeted field (or the replacement text for a substring change). */
  value: string
  /**
   * REQUIRED for 'cta_text' | 'internal_links' — the exact current substring in the
   * article body to replace. Inkwell's content schema has no separate CTA/internal-
   * links field (see change-types.ts SCHEMA NOTE), so these change-types target a
   * substring within `content` rather than a whole field.
   */
  findText?: string
}

function toCroApplyMergePayload(payload: unknown): CroApplyMergePayload | null {
  if (payload === null || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  if (p.mode !== 'cro-apply-merge') return null
  const slug = typeof p.slug === 'string' ? p.slug.trim() : ''
  if (!slug) return null
  if (!isKnownChangeType(p.changeType)) return null
  const value = typeof p.value === 'string' ? p.value : ''
  if (!value) return null
  const findText = typeof p.findText === 'string' && p.findText ? p.findText : undefined
  return { executor: 'inkwell-content', mode: 'cro-apply-merge', slug, changeType: p.changeType, value, findText }
}

// ContentMergeDiff is now defined in shared/cms-adapter.ts and re-exported above
// (`export type { ContentMergeDiff }`) — #370 Slice A. Same shape, same name, one
// definition instead of a CMS-specific copy.

/**
 * Apply ONE targeted field change from `merge` onto `current`, returning the FULL
 * merged PublishBody (Inkwell's sink has no partial-update surface — see the
 * PublishBody ⚠ note — so every field the sink accepts must be present, sourced from
 * `current` except the one field this change-type touches) plus the diff for the
 * receipt. PURE — no I/O, no throw on the happy path; throws InkwellExecutorError
 * only for an ambiguous/absent cta_text|internal_links replace target (fail-closed:
 * an ambiguous edit target must never silently pick "the first match").
 *
 * #370 Slice A: the branch logic itself (title/description/content merge by
 * changeType, the fail-closed findText handling, the function-replacer fix) now
 * lives in the shared, CMS-agnostic mergeByChangeType (shared/cms-adapter.ts). This
 * function is the inkwell-specific glue: it supplies Inkwell's `base` write-body
 * fields (slug/author/tags/status/overwrite) and InkwellExecutorError as the error
 * constructor, so behavior — including exact .reason strings and messages — is
 * unchanged.
 */
export function mergeContentUpdate(
  current: FetchedInkwellContent,
  merge: CroApplyMergePayload,
): { body: PublishBody; diff: ContentMergeDiff } {
  const author = current.author || 'mupot'
  const base = {
    slug: merge.slug,
    author,
    tags: current.tags,
    status: current.status,
    overwrite: true as const,
  }
  const change: CmsChangeRequest = {
    changeType: merge.changeType,
    value: merge.value,
    findText: merge.findText,
  }
  return mergeByChangeType(base, current, change, (reason, message) => new InkwellExecutorError(reason, message))
}

// ── CRO apply-bridge: the merge write orchestrator ────────────────────────────

export interface InkwellApplyWriteResult extends InkwellWriteResult {
  diff: ContentMergeDiff
}

/**
 * Translate the real fetch result (FetchedInkwellContent, with Inkwell's
 * author/tags fields) into the shared, CMS-agnostic FetchedContent shape. `ref`
 * carries the slug forward — FetchedContent has no author/tags field of its own
 * (those are CMS-specific), so they go in `raw` and applyChangeAdapter unpacks
 * them back out via fetchedContentToInkwell below.
 */
async function fetchCurrentAdapter(
  cfg: InkwellExecutorConfig,
  ref: string,
  fetchImpl?: typeof fetch,
): Promise<FetchedContent | null> {
  const current = await fetchInkwellContent(cfg, ref, fetchImpl)
  if (!current) return null
  return {
    ref,
    title: current.title,
    description: current.description,
    content: current.content,
    status: current.status,
    raw: { author: current.author, tags: current.tags },
  }
}

/** Inverse of fetchCurrentAdapter's `raw` packing — reconstructs a FetchedInkwellContent so applyChangeAdapter can reuse mergeContentUpdate as the single source of merge truth. */
function fetchedContentToInkwell(current: FetchedContent): FetchedInkwellContent {
  const author = typeof current.raw?.author === 'string' ? current.raw.author : ''
  const tags = Array.isArray(current.raw?.tags)
    ? current.raw.tags.filter((t): t is string => typeof t === 'string')
    : []
  const status: FetchedInkwellContent['status'] =
    current.status === 'published' || current.status === 'archived' ? current.status : 'draft'
  return { title: current.title, description: current.description, author, tags, status, content: current.content }
}

/** CmsAdapter.applyChange for Inkwell — thin glue over mergeContentUpdate (kept as the single, directly-tested merge entry point). */
function applyChangeAdapter(
  current: FetchedContent,
  change: CmsChangeRequest,
): { body: PublishBody; diff: ContentMergeDiff } {
  const merge: CroApplyMergePayload = {
    executor: 'inkwell-content',
    mode: 'cro-apply-merge',
    slug: current.ref,
    changeType: change.changeType,
    value: change.value,
    findText: change.findText,
  }
  return mergeContentUpdate(fetchedContentToInkwell(current), merge)
}

/** CmsAdapter.write for Inkwell — the merge write always full-replaces via postPublishBody, same as the create/full-replace path. `ref` is already carried inside `body.slug`. */
async function writeAdapter(
  cfg: InkwellExecutorConfig,
  _ref: string,
  body: PublishBody,
  fetchImpl?: typeof fetch,
): Promise<InkwellWriteResult> {
  return postPublishBody(cfg, body, fetchImpl)
}

/**
 * Builds the InkwellExecutorConfig CmsAdapter, closing over `fetchImpl` (the port's
 * fetchCurrent/write signatures take no fetchImpl param — it's a test-only injection
 * point, so it's captured in the closure per call instead of threaded through the
 * generic port).
 */
function makeInkwellAdapter(
  fetchImpl?: typeof fetch,
): CmsAdapter<InkwellExecutorConfig, PublishBody, InkwellWriteResult> {
  return {
    fetchCurrent: (cfg, ref) => fetchCurrentAdapter(cfg, ref, fetchImpl),
    applyChange: applyChangeAdapter,
    write: (cfg, ref, body) => writeAdapter(cfg, ref, body, fetchImpl),
  }
}

/**
 * The full fetch-then-merge write: read the current article (fail-closed on any
 * fetch problem or a missing article), apply ONLY the targeted field via
 * mergeContentUpdate, and write the merged whole back. Re-validates the change-type
 * allowlist at this SINK layer even though the proposer (collectors/cro-apply.ts)
 * already refused a bad change-type before minting a gate record — "a safety flag
 * the producer sets and the server never re-checks is defensive theater; enforce
 * invariants at the SINK, not just the producer" (the lesson mupot commit 10846b4
 * drew from the adversarial gate on this same content-write surface). This branch
 * should be structurally unreachable (toCroApplyMergePayload already gates on
 * isKnownChangeType), but the re-check costs nothing and closes the class of bug
 * regardless of how the payload got here.
 *
 * #370 Slice A: the fetch→refuse-on-missing→merge→write orchestration itself now
 * lives in the shared cmsContentApplyWrite (shared/cms-adapter.ts); this function
 * does the inkwell-specific config/payload/allowlist validation (unchanged, same
 * order, same reasons/messages) and then dispatches through the shared orchestrator
 * via makeInkwellAdapter — the concrete proof this is a real CmsAdapter, not just a
 * same-shaped duplicate.
 */
export async function inkwellContentApplyWrite(
  cfg: InkwellExecutorConfig,
  payload: unknown,
  fetchImpl?: typeof fetch,
): Promise<InkwellApplyWriteResult> {
  if (!cfg || !cfg.apiUrl || !cfg.token || !cfg.tenantSlug) {
    throw new InkwellExecutorError('inkwell_not_configured', 'missing apiUrl, token, or tenantSlug')
  }
  const merge = toCroApplyMergePayload(payload)
  if (!merge) {
    throw new InkwellExecutorError('invalid_payload', 'stored payload is not a valid cro-apply-merge intent')
  }
  if (classifyChangeType(merge.changeType) === 'refused') {
    throw new InkwellExecutorError(
      'change_type_refused',
      `${merge.changeType} is not an allowlisted CRO change-type`,
    )
  }

  const change: CmsChangeRequest = { changeType: merge.changeType, value: merge.value, findText: merge.findText }
  return cmsContentApplyWrite(makeInkwellAdapter(fetchImpl), cfg, merge.slug, change, (ref) => {
    // Matches the original inline throw exactly — same reason, same message shape
    // (only the source of `ref` differs syntactically: it's `merge.slug` either way).
    return new InkwellExecutorError(
      'merge_source_not_found',
      `fetch-then-merge: no existing content at slug '${ref}' to merge into`,
    )
  })
}

/**
 * kernel.ts's inkwell-content call site. Branches on the stored payload's SHAPE
 * (mode === 'cro-apply-merge'), not on any action string — kernel.ts still dispatches
 * purely on payload.executor === 'inkwell-content' (see file-header note). Every
 * existing caller (content-publish, seo-meta-fix) has no `mode` field and is
 * unaffected — routes to the unchanged full-replace path.
 */
export async function inkwellContentDispatch(
  cfg: InkwellExecutorConfig,
  payload: unknown,
  fetchImpl?: typeof fetch,
): Promise<InkwellWriteResult & { diff?: ContentMergeDiff }> {
  if (payload !== null && typeof payload === 'object' && (payload as Record<string, unknown>).mode === 'cro-apply-merge') {
    return inkwellContentApplyWrite(cfg, payload, fetchImpl)
  }
  return inkwellContentWrite(cfg, payload, fetchImpl)
}
