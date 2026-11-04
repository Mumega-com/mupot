// wiki-client.ts — mupot v0.50 goal item 4: "each project has a rendered wiki
// home, using the existing inkwell-api wiki store, readable under mupot's
// permissions."
//
// This is the client for the internal service-to-service wiki surface built in
// mumega.com PR #1278 (workers/inkwell-api/src/routes/internal-wiki.ts):
//   GET /api/internal/wiki/graph?tenant_slug=&project=
//   PUT /api/internal/wiki/topics/:slug
//
// Mirrors src/departments/executors/inkwell.ts's exact trust model + fetch
// precedence (explicit fetchImpl for tests > same-zone service-binding fetcher
// > global fetch; SSRF-guarded apiUrl; redirect-refusing request wrapper) and
// reuses its SHARED plumbing (cmsFetch/resolveCmsFetch from
// executors/shared/cms-adapter.ts) rather than re-implementing it. The Bearer
// token is resolved via THE SAME per-pot 'inkwell' connector the department
// executor already resolves (src/connectors/service.ts resolveConnector) — no
// new secret, no new binding, no new env var. Resolved POT-WIDE explicitly
// (resolveConnector(env, 'pot', 'inkwell') — the same literal-'pot' idiom
// src/dashboard/studio.ts / studio-data-api.ts already use for their own
// pot-wide connectors) rather than passing a project identifier into the
// scope-id argument position, which would only accidentally avoid colliding
// with an agent/squad-scoped connector rather than being explicitly pot-wide.
//
// mupot is the PERMISSION AUTHORITY here; Inkwell stays the STORE. Every
// caller of this module MUST run its own project-read (or project-manage, for
// writes) check BEFORE calling in — this module has no notion of "who is
// asking", only "which project" (see routes/internal-wiki.ts's header comment
// for why the upstream route itself does no keychain check on this path).
//
// PROJECT KEY: every caller passes `projectKey` = the mupot PROJECT'S OWN
// IMMUTABLE id (`project.id`), never `project.slug`. A project's slug is
// mutable (project_update) and reclaimable (a completed/archived project's
// slug can be freed and later re-taken by an unrelated new project via
// team-bootstrap release) — keying Inkwell's `project` field on slug would
// let a renamed project silently lose its wiki, or a brand-new project
// inherit a stranger's wiki content the moment it took a freed slug. `id` has
// neither failure mode. `project.id` is a `crypto.randomUUID()` (see
// src/projects/service.ts createProject), which is always lowercase hex +
// hyphens and therefore already satisfies the slug shape Inkwell requires.
//
// Fail-closed, secret-safe: every unrecoverable failure (missing config,
// network error, malformed body, 5xx, 401/403 auth failure) collapses to ONE
// typed WikiClientError('wiki_unavailable'). A 409 (any conflict code the
// upstream reports — the exact code vocabulary has already been renamed once
// between #1278's rounds, so this client does not hardcode a closed
// allowlist) is a typed WikiConflictError. Any OTHER 4xx (400/404/422/...) is
// a typed WikiRequestError — a well-formed call the upstream rejected as
// invalid, distinct from "the service itself is unreachable/misconfigured".
// The Bearer token and the raw upstream response body are NEVER included in
// a thrown message — only a short, safe reason string (a status number, or
// an `error` code the upstream itself already intends to be a stable,
// public-facing enum value).

import { wikiFetcher } from './wiki-fetcher'
import { assertPublicHttpsUrl } from '../lib/ssrf'
import { resolveConnector } from '../connectors/service'
import { cmsFetch, resolveCmsFetch } from '../departments/executors/shared/cms-adapter'
import type { Env } from '../types'

// Cap and alphabet confirmed against mumega.com PR #1278 round 2 (head
// 81839e85), lib/internal-auth.ts's TENANT_SLUG_RE — the SAME pattern
// routes/internal-wiki.ts reuses for its PROJECT_SLUG_RE. 63 chars, not the
// 80 an earlier reading of TOPIC_SLUG_RE alone suggested; validating to the
// STRICTER of the two upstream caps client-side never produces a false
// rejection the server would have accepted, only extra safety margin.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

export function isWikiSlug(value: string): boolean {
  return typeof value === 'string' && SLUG_RE.test(value)
}

export interface WikiTopic {
  id: string
  tenant_id: string
  project: string
  slug: string
  title: string
  description: string
  topic_type: string
  required_keys: string[]
  tags: string[]
  published: boolean
  created_at: number
  updated_at: number
  /** wiki-documents/v1 only: storage revision (distinct from the legacy `v:` envelope tag). Absent on a legacy server. */
  version?: number
  last_writer?: string
  /** wiki-documents/v1 topic GET only: the full markdown document (null = none). Graph nodes never carry it. */
  body?: string | null
}

export interface WikiEdge {
  from_slug: string
  to_slug: string
  relation_type: string
  weight: number
}

export interface WikiGraph {
  tenant_slug: string
  project: string
  nodes: WikiTopic[]
  edges: WikiEdge[]
}

/** The only contract this client speaks. Anything else is treated as a legacy (metadata-only) server. */
export const WIKI_DOCUMENTS_CONTRACT = 'wiki-documents/v1'

export interface WikiDocumentCapabilities {
  contract: typeof WIKI_DOCUMENTS_CONTRACT
  max_body_bytes: number
  /** Retained revisions can be read back (needed to verify our own write after another writer advanced it). */
  revision_history: boolean
}

/**
 * Strict handshake parse. Upgraded ONLY when the contract string matches exactly AND the server states it
 * stores bodies AND honours conditional writes AND gives a sane byte cap. Everything else (field absent,
 * unknown contract, body:false, conditional_writes:false, junk) is legacy: a partial server is not a server
 * we can send expected_version/body to.
 */
export function parseWikiCapabilities(raw: unknown): WikiDocumentCapabilities | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown> // narrowed from unknown; every field checked below
  if (c.contract !== WIKI_DOCUMENTS_CONTRACT) return null
  if (c.body !== true || c.conditional_writes !== true) return null
  if (typeof c.max_body_bytes !== 'number' || !Number.isSafeInteger(c.max_body_bytes) || c.max_body_bytes < 1) return null
  return { contract: WIKI_DOCUMENTS_CONTRACT, max_body_bytes: c.max_body_bytes, revision_history: c.revision_history === true }
}

export interface WikiTopicUpsertEdgeInput {
  to_slug: string
  relation_type?: string
  weight?: number
}

export interface WikiTopicUpsertInput {
  /** Topic slug — immutable identity within (tenant, project). */
  slug: string
  title: string
  description?: string
  topic_type?: string
  tags?: string[]
  edges?: WikiTopicUpsertEdgeInput[]
  /**
   * wiki-documents/v1 fields. Present ONLY when the handshake proved the server upgraded; absent = the
   * request body is byte-identical to the pre-v1 shape. `expected_version`: 0 = create, N>0 = the storage
   * revision the caller last read. `body`: undefined leaves the stored document alone, '' clears it.
   */
  document?: { expected_version: number; body?: string; writer: string }
}

export interface WikiTopicUpsertResult {
  ok: true
  id: string
  created: boolean
  edges_upserted: number
  /** v1 only: the storage version this write produced. */
  version?: number
  last_writer?: string
}

export interface WikiRevision {
  version: number
  body: string | null
  last_writer: string
}

/** The one error shape every UNRECOVERABLE failure in this module collapses to. */
export class WikiClientError extends Error {
  constructor(public readonly reason: 'wiki_unavailable', message?: string) {
    super(message ?? reason)
    this.name = 'WikiClientError'
  }
}

/**
 * A typed 409 from PUT /topics/:slug — surfaced separately from
 * WikiClientError so a caller (e.g. the "Create/refresh project card" route)
 * can render an actionable message instead of a generic "wiki unavailable"
 * failure. `code` is whatever `error` string the upstream returned —
 * deliberately NOT restricted to a closed allowlist: internal-wiki.ts's own
 * conflict codes have already been renamed once between #1278's rounds
 * (topic_owned_by_other_project / topic_is_keychain_gated /
 * topic_write_conflict, and a successor PR generalises these further), so a
 * client that hardcodes today's exact strings breaks on the next rename. Any
 * 409 IS a conflict regardless of its code; only the code's fallback value
 * ('unknown_conflict', when the body is missing/malformed) is this client's
 * own invention. `existingProject` is populated only when the upstream body
 * carries a string `existing_project` field — a plain project id, never free
 * text, never the raw body.
 */
export class WikiConflictError extends Error {
  constructor(
    public readonly code: string,
    public readonly existingProject?: string,
    /** v1: present only when the server judged the caller allowed to see the page (a STALE expected_version). */
    public readonly currentVersion?: number,
    public readonly lastWriter?: string,
  ) {
    super(code)
    this.name = 'WikiConflictError'
  }
}

/**
 * A non-409 4xx from the upstream route — a well-formed HTTP call the route
 * rejected as invalid (bad project shape, title out of range, too many
 * edges, an edge naming an unpublished/nonexistent target, …). Distinct from
 * WikiClientError('wiki_unavailable'): this is not "the service is broken",
 * it is "this specific call was rejected", which a caller may want to
 * surface differently (e.g. log-and-fail-closed vs. retry). `code` is
 * whatever `error` string the upstream returned, same non-allowlisted
 * discipline as WikiConflictError.
 */
export class WikiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`${status} ${code}`)
    this.name = 'WikiRequestError'
  }
}

interface WikiClientConfig {
  apiUrl: string
  token: string
  tenantSlug: string
  fetcher?: Fetcher
}

/**
 * Resolve the pot-wide 'inkwell' connector — EXPLICITLY pot-wide
 * (resolveConnector(env, 'pot', 'inkwell')), the same literal-'pot' idiom
 * src/dashboard/studio.ts and studio-data-api.ts already use for their own
 * pot-wide connectors (as opposed to src/dashboard/index.ts's dept-executor
 * call, which passes a department key into the scope-id argument position —
 * that only works because a department key happens never to collide with a
 * real agent/squad id, not because it explicitly means "pot-wide"). This
 * client never needs an agent- or squad-scoped override: the wiki surface is
 * pot-level, not per-caller.
 */
async function resolveWikiConfig(env: Env): Promise<WikiClientConfig | null> {
  if (!env.INKWELL_API_URL) return null
  const token = await resolveConnector(env, 'pot', 'inkwell')
  if (!token) return null
  return { apiUrl: env.INKWELL_API_URL, token, tenantSlug: env.TENANT_SLUG, fetcher: wikiFetcher(env) }
}

function safeOrigin(apiUrl: string): string {
  try {
    return assertPublicHttpsUrl(apiUrl).origin
  } catch {
    // Never surface the raw ssrf.ts reason — it can hint at internal
    // topology (e.g. "url_private_host"). Collapse to the one opaque reason.
    throw new WikiClientError('wiki_unavailable')
  }
}

async function wikiRequest(
  cfg: WikiClientConfig,
  path: string,
  init: { method: 'GET' | 'PUT'; body?: string },
  fetchImpl?: typeof fetch,
): Promise<Response> {
  const origin = safeOrigin(cfg.apiUrl)
  const doFetch = resolveCmsFetch(cfg.fetcher, fetchImpl)
  try {
    return await cmsFetch(
      origin,
      doFetch,
      path,
      {
        method: init.method,
        headers: {
          authorization: `Bearer ${cfg.token}`,
          'user-agent': 'mupot-wiki-client/1.0',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
        body: init.body,
      },
      {
        // Same collapse-to-one-reason discipline: cmsFetch's own error
        // factories would otherwise carry a raw exception's message (e.g. a
        // DNS failure string) — swallow it here.
        unreachable: () => new WikiClientError('wiki_unavailable'),
        redirectBlocked: () => new WikiClientError('wiki_unavailable'),
      },
    )
  } catch (e) {
    if (e instanceof WikiClientError) throw e
    throw new WikiClientError('wiki_unavailable')
  }
}

/**
 * Classify a non-ok response into the right typed error and throw it.
 * 401/403/503 (and anything else NOT a well-formed 4xx rejection) collapse to
 * WikiClientError('wiki_unavailable') — an access/availability problem, not a
 * property of this specific call. 409 is ALWAYS WikiConflictError. Every
 * other 4xx is WikiRequestError. This is the ONE place status codes are
 * interpreted, so a future upstream rename only has to be reconciled here if
 * it changes STATUS codes (never for a new `error` string — those pass
 * through as-is).
 */
async function throwForErrorResponse(res: Response): Promise<never> {
  if (res.status === 409) {
    const body = (await res.json().catch(() => null)) as { error?: unknown; existing_project?: unknown } | null
    const code = typeof body?.error === 'string' && body.error ? body.error : 'unknown_conflict'
    const existingProject = typeof body?.existing_project === 'string' ? body.existing_project : undefined
    const raw = body as { current_version?: unknown; last_writer?: unknown } | null
    const currentVersion = typeof raw?.current_version === 'number' && Number.isSafeInteger(raw.current_version) ? raw.current_version : undefined
    // last_writer is free text from the store: bound it before it reaches an agent-facing refusal.
    const lastWriter = typeof raw?.last_writer === 'string' ? raw.last_writer.slice(0, 200) : undefined
    throw new WikiConflictError(code, existingProject, currentVersion, lastWriter)
  }
  if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null
    const code = typeof body?.error === 'string' && body.error ? body.error : 'unknown_request_error'
    throw new WikiRequestError(res.status, code)
  }
  throw new WikiClientError('wiki_unavailable', `status ${res.status}`)
}

/**
 * Read the full node+edge graph for one project. Throws WikiClientError
 * (fail-closed) on missing config or an unreachable/malformed upstream;
 * WikiRequestError on a well-formed-but-rejected call (e.g. an invalid
 * project shape this client's own local validation somehow missed). A
 * project with zero VISIBLE topics returns an EMPTY graph (nodes: [],
 * edges: []) — that is a valid 200 from the upstream route, not an error;
 * callers render the "No wiki pages yet" empty state for it.
 *
 * `projectKey` MUST be the project's `id` (not its `slug` — see file header).
 */
export async function getProjectWikiGraph(
  env: Env,
  projectKey: string,
  fetchImpl?: typeof fetch,
): Promise<WikiGraph> {
  // Inkwell's project param regex is lowercase-only (TENANT_SLUG_RE-shaped) —
  // an uppercase-containing id 400s upstream. Lowercase FIRST, then
  // validate, so a project id that only differs from a valid slug by case
  // is accepted rather than rejected.
  const project = projectKey.toLowerCase()
  if (!isWikiSlug(project)) throw new WikiClientError('wiki_unavailable')
  const cfg = await resolveWikiConfig(env)
  if (!cfg) throw new WikiClientError('wiki_unavailable')

  const qs = new URLSearchParams({ tenant_slug: cfg.tenantSlug, project })
  const res = await wikiRequest(cfg, `/api/internal/wiki/graph?${qs.toString()}`, { method: 'GET' }, fetchImpl)
  if (!res.ok) return throwForErrorResponse(res)

  const json = (await res.json().catch(() => null)) as Partial<WikiGraph> | null
  if (!json || !Array.isArray(json.nodes) || !Array.isArray(json.edges)) {
    throw new WikiClientError('wiki_unavailable')
  }
  return {
    tenant_slug: cfg.tenantSlug,
    project,
    nodes: json.nodes as WikiTopic[],
    edges: json.edges as WikiEdge[],
  }
}

/**
 * The cold-create handshake: GET graph (even for an EMPTY project) and parse its `capabilities`.
 * null = legacy server (field absent, unknown contract, or any required capability missing).
 * Kept separate from getProjectWikiGraph so the graph shape every existing surface renders is unchanged.
 */
export async function getProjectWikiCapabilities(
  env: Env,
  projectKey: string,
  fetchImpl?: typeof fetch,
): Promise<WikiDocumentCapabilities | null> {
  const project = projectKey.toLowerCase()
  if (!isWikiSlug(project)) throw new WikiClientError('wiki_unavailable')
  const cfg = await resolveWikiConfig(env)
  if (!cfg) throw new WikiClientError('wiki_unavailable')
  const qs = new URLSearchParams({ tenant_slug: cfg.tenantSlug, project })
  const res = await wikiRequest(cfg, `/api/internal/wiki/graph?${qs.toString()}`, { method: 'GET' }, fetchImpl)
  if (!res.ok) return throwForErrorResponse(res)
  const json = (await res.json().catch(() => null)) as { nodes?: unknown; edges?: unknown; capabilities?: unknown } | null
  if (!json || !Array.isArray(json.nodes) || !Array.isArray(json.edges)) throw new WikiClientError('wiki_unavailable')
  return parseWikiCapabilities(json.capabilities)
}

/**
 * Upsert one topic (+ optional same-project edges) under a project's wiki.
 * Throws WikiClientError on missing config or an unreachable/malformed
 * upstream; WikiConflictError on ANY 409 (slug owned by another project, a
 * pre-existing keychain-gated topic, a write-conflict race, or any future
 * conflict code — see WikiConflictError's doc comment); WikiRequestError on
 * any other 4xx (title out of range, too many edges, an edge naming an
 * unpublished/nonexistent/cross-project target, …).
 *
 * The body sends ONLY {tenant_slug, project, title, description, topic_type,
 * tags, edges} — NO `published`, `required_keys`, `content_blocks`, or a
 * body-level `slug` field, all of which the real route either ignores or
 * does not accept at all (confirmed against #1278 round 2; the topic slug is
 * the PATH param, never a body field). An earlier revision of this function
 * sent a speculative `published: true` ahead of round 2 landing — removed
 * now that the real schema is confirmed to have no such field at all.
 *
 * `projectKey` MUST be the project's `id` (not its `slug` — see file header).
 */
export async function upsertProjectWikiTopic(
  env: Env,
  projectKey: string,
  topic: WikiTopicUpsertInput,
  fetchImpl?: typeof fetch,
): Promise<WikiTopicUpsertResult> {
  // Same lowercase-first discipline as getProjectWikiGraph — see its comment.
  const project = projectKey.toLowerCase()
  if (!isWikiSlug(project) || !isWikiSlug(topic.slug)) throw new WikiClientError('wiki_unavailable')
  if (typeof topic.title !== 'string' || !topic.title.trim()) throw new WikiClientError('wiki_unavailable')

  const cfg = await resolveWikiConfig(env)
  if (!cfg) throw new WikiClientError('wiki_unavailable')

  const body = {
    tenant_slug: cfg.tenantSlug,
    project,
    title: topic.title,
    description: topic.description ?? '',
    topic_type: topic.topic_type ?? 'general',
    tags: topic.tags ?? [],
    edges: topic.edges ?? [],
    // Spread only for an upgraded server so a legacy request keeps its exact pre-v1 byte shape.
    ...(topic.document
      ? {
          expected_version: topic.document.expected_version,
          writer: topic.document.writer,
          ...(topic.document.body !== undefined ? { body: topic.document.body } : {}),
        }
      : {}),
  }
  const res = await wikiRequest(
    cfg,
    `/api/internal/wiki/topics/${encodeURIComponent(topic.slug)}`,
    { method: 'PUT', body: JSON.stringify(body) },
    fetchImpl,
  )
  if (!res.ok) return throwForErrorResponse(res)

  const json = (await res.json().catch(() => null)) as Partial<WikiTopicUpsertResult> | null
  if (!json || typeof json.id !== 'string' || typeof json.created !== 'boolean') {
    throw new WikiClientError('wiki_unavailable')
  }
  return {
    ok: true,
    id: json.id,
    created: json.created,
    edges_upserted: typeof json.edges_upserted === 'number' ? json.edges_upserted : 0,
    ...(typeof json.version === 'number' && Number.isSafeInteger(json.version) ? { version: json.version } : {}),
    ...(typeof json.last_writer === 'string' ? { last_writer: json.last_writer } : {}),
  }
}

/**
 * Read ONE topic (+ its visible edges) from a project's wiki. Returns null exactly when the upstream
 * answers 404 (absent, wrong project, unpublished or not service-readable all collapse to the same
 * 404 upstream — no oracle). Same error discipline as getProjectWikiGraph. `projectKey` MUST be the
 * project's `id`.
 */
export async function getProjectWikiTopic(
  env: Env,
  projectKey: string,
  slug: string,
  fetchImpl?: typeof fetch,
): Promise<{ topic: WikiTopic; edges: WikiEdge[]; capabilities: WikiDocumentCapabilities | null } | null> {
  const project = projectKey.toLowerCase()
  if (!isWikiSlug(project) || !isWikiSlug(slug)) throw new WikiClientError('wiki_unavailable')
  const cfg = await resolveWikiConfig(env)
  if (!cfg) throw new WikiClientError('wiki_unavailable')

  const qs = new URLSearchParams({ tenant_slug: cfg.tenantSlug, project })
  const res = await wikiRequest(
    cfg,
    `/api/internal/wiki/topics/${encodeURIComponent(slug)}?${qs.toString()}`,
    { method: 'GET' },
    fetchImpl,
  )
  if (res.status === 404) return null
  if (!res.ok) return throwForErrorResponse(res)

  const json = (await res.json().catch(() => null)) as { topic?: unknown; edges?: unknown; capabilities?: unknown } | null
  if (!json || !json.topic || typeof json.topic !== 'object' || !Array.isArray(json.edges)) {
    throw new WikiClientError('wiki_unavailable')
  }
  return { topic: json.topic as WikiTopic, edges: json.edges as WikiEdge[], capabilities: parseWikiCapabilities(json.capabilities) }
}

/**
 * wiki-documents/v1 only: retained revisions of ONE topic strictly after `afterVersion` (first page, <=100).
 * null exactly on 404 (absent/hidden/unsupported route). Used to verify our own write when a readback shows
 * another writer already advanced the page.
 */
export async function getProjectWikiRevisions(
  env: Env,
  projectKey: string,
  slug: string,
  afterVersion: number,
  fetchImpl?: typeof fetch,
): Promise<WikiRevision[] | null> {
  const project = projectKey.toLowerCase()
  if (!isWikiSlug(project) || !isWikiSlug(slug) || !Number.isSafeInteger(afterVersion) || afterVersion < 0) {
    throw new WikiClientError('wiki_unavailable')
  }
  const cfg = await resolveWikiConfig(env)
  if (!cfg) throw new WikiClientError('wiki_unavailable')
  const qs = new URLSearchParams({ tenant_slug: cfg.tenantSlug, project, after_version: String(afterVersion) })
  const res = await wikiRequest(
    cfg,
    `/api/internal/wiki/topics/${encodeURIComponent(slug)}/revisions?${qs.toString()}`,
    { method: 'GET' },
    fetchImpl,
  )
  if (res.status === 404) return null
  if (!res.ok) return throwForErrorResponse(res)
  const json = (await res.json().catch(() => null)) as { revisions?: unknown } | null
  if (!json || !Array.isArray(json.revisions)) throw new WikiClientError('wiki_unavailable')
  const out: WikiRevision[] = []
  for (const r of json.revisions as unknown[]) {
    const rec = r && typeof r === 'object' ? (r as Record<string, unknown>) : null // shape-probed below
    if (!rec || typeof rec.version !== 'number' || !Number.isSafeInteger(rec.version)) continue
    out.push({
      version: rec.version,
      body: typeof rec.body === 'string' ? rec.body : null,
      last_writer: typeof rec.last_writer === 'string' ? rec.last_writer : '',
    })
  }
  return out
}
