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
// new secret, no new binding, no new env var.
//
// mupot is the PERMISSION AUTHORITY here; Inkwell stays the STORE. Every
// caller of this module MUST run its own project-read (or project-manage, for
// writes) check BEFORE calling in — this module has no notion of "who is
// asking", only "which project" (see routes/internal-wiki.ts's header comment
// for why the upstream route itself does no keychain check on this path).
//
// Fail-closed, secret-safe: every failure (missing config, network error,
// non-2xx, malformed body) collapses to ONE typed WikiClientError
// ('wiki_unavailable') — the Bearer token and the raw upstream response body
// are NEVER included in a thrown message, only a short, safe reason string
// (e.g. an HTTP status number).

import { assertPublicHttpsUrl } from '../lib/ssrf'
import { resolveConnector } from '../connectors/service'
import { cmsFetch, resolveCmsFetch } from '../departments/executors/shared/cms-adapter'
import type { Env } from '../types'

// Same alphabet/cap as internal-wiki.ts's TOPIC_SLUG_RE / PROJECT_SLUG_RE —
// validated here too so a malformed slug fails fast, locally, before ever
// reaching the network (and never becomes part of a path-traversal-shaped
// upstream URL).
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/

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
}

export interface WikiTopicUpsertResult {
  ok: true
  id: string
  created: boolean
  edges_upserted: number
}

/** The one error shape every UNRECOVERABLE failure in this module collapses to. */
export class WikiClientError extends Error {
  constructor(public readonly reason: 'wiki_unavailable', message?: string) {
    super(message ?? reason)
    this.name = 'WikiClientError'
  }
}

// Closed allowlist of internal-wiki.ts's own documented 409 conflict codes,
// confirmed against mumega.com PR #1278 round 2 (head 81839e85,
// routes/internal-wiki.ts PUT /topics/:slug):
//   - 'topic_owned_by_other_project' — the slug belongs to a different
//     project in this tenant (wiki_topics.UNIQUE is (tenant_id, slug), not
//     (tenant_id, project, slug)). Carries `existing_project`.
//   - 'topic_is_keychain_gated' — a pre-existing keychain-gated topic
//     refuses to be silently overwritten/de-gated.
//   - 'topic_write_conflict' (round-2 P2-5, NEW) — a TOCTOU race: either the
//     UPDATE's own WHERE (tenant_id, slug, project, required_keys='[]')
//     matched zero rows because a concurrent admin write changed the row
//     between our read-check and this write, OR a concurrent PUT won a
//     UNIQUE-constraint race on create. No `existing_project` — the route
//     does not re-read the row to report one.
// A 409 with any OTHER body shape (unexpected future code) is treated as
// WikiClientError('wiki_unavailable'), never surfaced verbatim — this keeps
// the "never leak the raw upstream body" discipline while still giving the
// caller a typed, actionable conflict for the three documented cases.
const KNOWN_CONFLICT_CODES = ['topic_owned_by_other_project', 'topic_is_keychain_gated', 'topic_write_conflict'] as const
type WikiConflictCode = (typeof KNOWN_CONFLICT_CODES)[number]

function isKnownConflictCode(v: unknown): v is WikiConflictCode {
  return typeof v === 'string' && (KNOWN_CONFLICT_CODES as readonly string[]).includes(v)
}

/**
 * A typed 409 from PUT /topics/:slug — surfaced separately from
 * WikiClientError so a caller (e.g. the "Create/refresh project card" route)
 * can render an actionable message ("this slug belongs to another project",
 * "try again — a concurrent write raced this one") instead of a generic
 * "wiki unavailable" failure. `existingProject` is only ever set for
 * 'topic_owned_by_other_project' and is a plain project slug — not free
 * text, not the raw upstream body.
 */
export class WikiConflictError extends Error {
  constructor(
    public readonly code: WikiConflictCode,
    public readonly existingProject?: string,
  ) {
    super(code)
    this.name = 'WikiConflictError'
  }
}

interface WikiClientConfig {
  apiUrl: string
  token: string
  tenantSlug: string
  fetcher?: Fetcher
}

/**
 * Resolve the SAME per-pot 'inkwell' connector the department executor
 * already resolves (src/dashboard/index.ts POST
 * /admin/departments/:dept/execute/:gateId calls
 * resolveConnector(env, dept, 'inkwell')). A project slug is, like a dept
 * key, neither an agent id nor a squad id, so this call hits the identical
 * pot-wide fallback branch resolveConnector already falls back to for the
 * dept-executor call — no new connector scope, no new secret.
 */
async function resolveWikiConfig(env: Env, projectSlug: string): Promise<WikiClientConfig | null> {
  if (!env.INKWELL_API_URL) return null
  const token = await resolveConnector(env, projectSlug, 'inkwell')
  if (!token) return null
  return { apiUrl: env.INKWELL_API_URL, token, tenantSlug: env.TENANT_SLUG, fetcher: env.INKWELL_SVC }
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
 * Read the full node+edge graph for one project. Throws WikiClientError
 * (fail-closed) on missing config, an unreachable/non-2xx upstream, or a
 * malformed response body. A project with zero topics returns an EMPTY graph
 * (nodes: [], edges: []) — that is a valid 200 from the upstream route, not
 * an error; callers render the "No wiki pages yet" empty state for it.
 */
export async function getProjectWikiGraph(
  env: Env,
  projectSlug: string,
  fetchImpl?: typeof fetch,
): Promise<WikiGraph> {
  if (!isWikiSlug(projectSlug)) throw new WikiClientError('wiki_unavailable')
  const cfg = await resolveWikiConfig(env, projectSlug)
  if (!cfg) throw new WikiClientError('wiki_unavailable')

  const qs = new URLSearchParams({ tenant_slug: cfg.tenantSlug, project: projectSlug })
  const res = await wikiRequest(cfg, `/api/internal/wiki/graph?${qs.toString()}`, { method: 'GET' }, fetchImpl)
  if (!res.ok) throw new WikiClientError('wiki_unavailable', `status ${res.status}`)

  const json = (await res.json().catch(() => null)) as Partial<WikiGraph> | null
  if (!json || !Array.isArray(json.nodes) || !Array.isArray(json.edges)) {
    throw new WikiClientError('wiki_unavailable')
  }
  return {
    tenant_slug: cfg.tenantSlug,
    project: projectSlug,
    nodes: json.nodes as WikiTopic[],
    edges: json.edges as WikiEdge[],
  }
}

/**
 * Upsert one topic (+ optional same-project edges) under a project's wiki.
 * Throws WikiClientError (fail-closed) on missing config, an
 * unreachable/non-2xx (including the upstream's own 409/400 validation
 * refusals — a caller that needs to distinguish those should be a rarer,
 * more specific need than this module's contract) upstream, or a malformed
 * response body. A 409 (slug owned by another project, a pre-existing
 * keychain-gated topic, or a write-conflict race) throws the more specific
 * WikiConflictError instead — see its doc comment — so a caller can render
 * an actionable message rather than a generic failure. An edge naming an
 * unpublished target is refused with a 400 (`edge_target_unpublished`) —
 * collapsed to the generic WikiClientError like every other 400 validation
 * refusal on this route, not given its own type (matches the client's
 * blanket policy of not distinguishing per-field 400s).
 *
 * NO `published` FIELD EXISTS on this route's body (confirmed against
 * mumega.com PR #1278 round 2, head 81839e85,
 * workers/inkwell-api/src/lib/wiki-store.ts's prepareInsertWikiTopic /
 * prepareUpdateWikiTopic): a topic created through this path is always
 * published=1 (hardcoded on INSERT) and UPDATE never touches the column.
 * An earlier revision of this function sent a speculative `published: true`
 * ahead of round 2 landing — removed now that the real schema is confirmed
 * to have no such field.
 */
export async function upsertProjectWikiTopic(
  env: Env,
  projectSlug: string,
  topic: WikiTopicUpsertInput,
  fetchImpl?: typeof fetch,
): Promise<WikiTopicUpsertResult> {
  if (!isWikiSlug(projectSlug) || !isWikiSlug(topic.slug)) throw new WikiClientError('wiki_unavailable')
  if (typeof topic.title !== 'string' || !topic.title.trim()) throw new WikiClientError('wiki_unavailable')

  const cfg = await resolveWikiConfig(env, projectSlug)
  if (!cfg) throw new WikiClientError('wiki_unavailable')

  const body = {
    tenant_slug: cfg.tenantSlug,
    project: projectSlug,
    title: topic.title,
    description: topic.description ?? '',
    topic_type: topic.topic_type ?? 'general',
    tags: topic.tags ?? [],
    edges: topic.edges ?? [],
  }
  const res = await wikiRequest(
    cfg,
    `/api/internal/wiki/topics/${encodeURIComponent(topic.slug)}`,
    { method: 'PUT', body: JSON.stringify(body) },
    fetchImpl,
  )

  if (res.status === 409) {
    const conflictJson = (await res.json().catch(() => null)) as { error?: unknown; existing_project?: unknown } | null
    const code = conflictJson?.error
    if (isKnownConflictCode(code)) {
      throw new WikiConflictError(
        code,
        typeof conflictJson?.existing_project === 'string' ? conflictJson.existing_project : undefined,
      )
    }
    // An unrecognized 409 shape — fail closed to the generic error rather
    // than guessing at a conflict code we don't understand.
    throw new WikiClientError('wiki_unavailable', 'status 409')
  }
  if (!res.ok) throw new WikiClientError('wiki_unavailable', `status ${res.status}`)

  const json = (await res.json().catch(() => null)) as Partial<WikiTopicUpsertResult> | null
  if (!json || typeof json.id !== 'string' || typeof json.created !== 'boolean') {
    throw new WikiClientError('wiki_unavailable')
  }
  return {
    ok: true,
    id: json.id,
    created: json.created,
    edges_upserted: typeof json.edges_upserted === 'number' ? json.edges_upserted : 0,
  }
}
