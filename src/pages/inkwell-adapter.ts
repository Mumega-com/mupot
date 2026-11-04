// src/pages/inkwell-adapter.ts — the DEFAULT PagesPort adapter: the Inkwell internal wiki store,
// reached ONLY through src/projects/wiki-client.ts (same connector, SSRF guard, fail-closed errors).
// No second store: a page is a wiki topic. The envelope rides in the topic's tags (owner:/tier:/v:/by:/at:)
// and `topic_type` carries the purpose, so the stamped provenance survives as parseable text in the
// store of record, not only in mupot's counter table.

import type { Env } from '../types'
import {
  getProjectWikiCapabilities,
  getProjectWikiGraph,
  getProjectWikiRevisions,
  getProjectWikiTopic,
  upsertProjectWikiTopic,
  WikiClientError,
  WikiConflictError,
  WikiRequestError,
  WikiSchemaPendingError,
  boundedWriter,
  type WikiDocumentCapabilities,
  type WikiTopic,
  type WikiTopicUpsertInput,
} from '../projects/wiki-client'
import {
  bodyBytes,
  isPageTier,
  MAX_BODY_BYTES,
  PagesPortError,
  type PageEnvelope,
  type PageBacklink,
  type PageLink,
  type PagePutInput,
  type PagePutResult,
  type PageRecord,
  type PagesPort,
  type StoreCapabilities,
} from './port'

export function encodeEnvelopeTags(e: PageEnvelope): string[] {
  const tags = [`owner:${e.owner}`, `tier:${e.tier}`, `v:${e.version}`, `by:${e.writer}`, `at:${e.writtenAt}`]
  // The upstream silently slices a tag at 48 chars, which would corrupt a stamp. Refuse instead.
  if (tags.some((t) => t.length > 48)) throw new PagesPortError('rejected', 'envelope_too_long')
  return tags
}

/** null unless EVERY stamp is present and well-formed — a half-stamped topic is not one of ours. */
export function decodeEnvelope(tags: string[], purpose: string): PageEnvelope | null {
  const find = (prefix: string): string | undefined => tags.find((t) => t.startsWith(prefix))?.slice(prefix.length)
  const owner = find('owner:')
  const tier = find('tier:')
  const v = find('v:')
  const writer = find('by:')
  const at = find('at:')
  const version = v !== undefined && /^\d+$/.test(v) ? Number(v) : NaN
  if (!owner || !writer || !at || !isPageTier(tier) || !Number.isSafeInteger(version) || version < 1) return null
  return { owner, writer, tier, purpose, version, writtenAt: at }
}

const MAX_BACKLINKS = 100

/** Fail-closed squad check on the raw stamp: a half-stamped topic still carrying `tier:squad` counts as squad. */
export function isSquadTierTags(tags: unknown): boolean {
  return Array.isArray(tags) && tags.includes('tier:squad')
}

/**
 * Drop squad-tier topics (and every edge touching one) from an Inkwell wiki graph for a caller without squad
 * access to the project. Used by EVERY surface that renders the raw graph (project_wiki, the dashboard wiki
 * tab, task_brief), so a squad page cannot leak through the graph. Shape-tolerant: anything it cannot read as
 * a squad node is left alone (a foreign page is project-visible), but a squad stamp always wins.
 */
export function filterWikiGraphForCaller<G extends { nodes: unknown; edges: unknown }>(graph: G, canSeeSquadPages: boolean): G {
  const rawNodes: unknown = graph.nodes
  if (!Array.isArray(rawNodes)) return graph
  // Page identity (id) and storage version never leave through a graph read: the page_id is the expected_id fence
  // and must come from the agent's own project_wiki_get, not from a listing (#2323).
  const stripped = { ...graph, nodes: rawNodes.map(stripNodeIdentity) }
  if (canSeeSquadPages) return stripped
  const hidden = new Set<string>()
  const nodes = stripped.nodes.filter((n: unknown) => {
    const rec = typeof n === 'object' && n !== null ? (n as { slug?: unknown; tags?: unknown }) : null // shape-probed below
    if (rec && isSquadTierTags(rec.tags)) {
      if (typeof rec.slug === 'string') hidden.add(rec.slug)
      return false
    }
    return true
  })
  const edges = Array.isArray(graph.edges)
    ? graph.edges.filter((e: unknown) => {
        const rec = typeof e === 'object' && e !== null ? (e as { from_slug?: unknown; to_slug?: unknown }) : null // shape-probed below
        return !(rec && ((typeof rec.from_slug === 'string' && hidden.has(rec.from_slug)) || (typeof rec.to_slug === 'string' && hidden.has(rec.to_slug))))
      })
    : graph.edges
  return { ...graph, nodes, edges }
}
function stripNodeIdentity(n: unknown): unknown {
  if (typeof n !== 'object' || n === null) return n
  const { id: _id, version: _version, ...rest } = n as Record<string, unknown> // shape-probed: only these two keys are dropped
  return rest
}
const EDGE_REFUSALS = new Set(['edge_target_invalid', 'cross_project_edge_refused', 'edge_target_unpublished'])

function mapError(e: unknown): never {
  if (e instanceof PagesPortError) throw e
  if (e instanceof WikiSchemaPendingError) throw new PagesPortError('unavailable', 'schema_pending')
  if (e instanceof WikiConflictError) {
    // wiki-documents/v1: the store only attaches current_version once it has re-checked that THIS caller may
    // see the page, so a version here is a STALE write, not a slug probe. Without it: the generic refusal.
    if (e.currentVersion !== undefined) throw new PagesPortError('stale', 'stale_version', { currentVersion: e.currentVersion, ...(e.lastWriter ? { lastWriter: e.lastWriter } : {}), ...(e.pageReplaced ? { replaced: true } : {}) })
    if (e.code === 'invalid_content_blocks') throw new PagesPortError('rejected', 'document_blocks_invalid')
    throw new PagesPortError('conflict', 'slug_unavailable') // never leak existing_project
  }
  if (e instanceof WikiRequestError) {
    // 914bf4fe: the store itself now demands the page id on a body edit. A typed refusal, never a 502.
    if (e.status === 400 && e.code === 'expected_id_required') throw new PagesPortError('rejected', 'expected_id_required')
    if (e.status === 400 && e.code === 'invalid_expected_id') throw new PagesPortError('rejected', 'invalid_expected_id')
    // Every edge-target refusal collapses to ONE code (the real route already does; older/other upstream
    // vocabularies distinguish missing vs cross-project vs unpublished, which is an existence oracle).
    throw new PagesPortError('rejected', EDGE_REFUSALS.has(e.code) ? 'edge_target_invalid' : 'request_rejected')
  }
  if (e instanceof WikiClientError) throw new PagesPortError('unavailable', e.reason)
  throw e
}

function toStoreCaps(c: WikiDocumentCapabilities | null): StoreCapabilities {
  return c ? { maxBodyBytes: c.max_body_bytes, revisionHistory: c.revision_history } : null
}

function toRecord(
  topic: WikiTopic,
  edges: { to_slug: string; relation_type: string; from_slug: string }[],
  capabilities: WikiDocumentCapabilities | null,
): PageRecord {
  const tags = Array.isArray(topic.tags) ? topic.tags.filter((t): t is string => typeof t === 'string') : []
  const stamped = new Set(['owner:', 'tier:', 'v:', 'by:', 'at:'])
  const links: PageLink[] = edges
    .filter((edge) => edge.from_slug === topic.slug)
    .map((edge) => ({ toSlug: edge.to_slug, relation: edge.relation_type }))
  const hasStorageVersion = typeof topic.version === 'number' && Number.isSafeInteger(topic.version)
  return {
    slug: topic.slug,
    title: topic.title,
    summary: topic.description,
    ...(typeof topic.body === 'string' && topic.body !== '' ? { body: topic.body } : {}),
    ...(hasStorageVersion ? { storageVersion: topic.version } : {}),
    ...(typeof topic.last_writer === 'string' && boundedWriter(topic.last_writer) ? { lastWriter: boundedWriter(topic.last_writer) } : {}),
    ...(hasStorageVersion && typeof topic.id === 'string' && topic.id ? { storeId: topic.id } : {}),
    ...(typeof topic.body_error === 'string' && topic.body_error ? { bodyError: boundedWriter(topic.body_error) } : {}),
    capabilities: toStoreCaps(capabilities),
    tags: tags.filter((t) => ![...stamped].some((p) => t.startsWith(p))),
    rawTags: tags,
    links,
    envelope: decodeEnvelope(tags, topic.topic_type),
  }
}

const PERSISTENCE_MISMATCH = (): PagesPortError => new PagesPortError('unavailable', 'persistence_mismatch')

/** Same normalisation the store applies to title/description, so the metadata readback compares like with like. */
function cleanText(value: string, max: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max)
}

export interface CapabilityAwareWrite {
  base: WikiTopicUpsertInput
  /** undefined = leave the stored body alone; '' clears it. */
  body?: string
  expectedVersion?: number
  expectedId?: string
  writer: string
  /** From the read that preceded this write (same request). undefined = probe (cold create). */
  capabilities?: StoreCapabilities
}

export interface CapabilityAwareResult {
  id: string
  created: boolean
  edgesUpserted: number
  storageVersion?: number
  verification?: 'readback' | 'history' | 'unverified'
  currentStorageVersion?: number
}

/**
 * The ONE capability-aware writer, shared by PagesPort.put and the dashboard project-card write. Throws raw
 * wiki-client errors and PagesPortError (callers map them). Capabilities come from the read the caller
 * already made in this request, or from one handshake GET when there was none (cold create); they are never
 * kept across requests.
 */
export async function upsertWithCapabilities(
  env: Env,
  projectId: string,
  w: CapabilityAwareWrite,
  fetchImpl?: typeof fetch,
): Promise<CapabilityAwareResult> {
  const hasBody = w.body !== undefined && w.body !== ''
  const caps: StoreCapabilities =
    w.capabilities !== undefined ? w.capabilities : toStoreCaps(await getProjectWikiCapabilities(env, projectId, fetchImpl))
  if (!caps) {
    // LEGACY: metadata-only, request byte-identical to before. A body or a CAS request cannot be honoured, so
    // it is refused explicitly (never silently dropped) before anything is created.
    if (hasBody) throw new PagesPortError('unsupported', 'body_unsupported')
    if (w.expectedVersion !== undefined) throw new PagesPortError('unsupported', 'conditional_writes_unsupported')
    const res = await upsertProjectWikiTopic(env, projectId, w.base, fetchImpl)
    return { id: res.id, created: res.created, edgesUpserted: res.edges_upserted }
  }

  // UPGRADED (wiki-documents/v1).
  const cap = Math.min(caps.maxBodyBytes, MAX_BODY_BYTES)
  if (w.body !== undefined && bodyBytes(w.body) > cap) throw new PagesPortError('rejected', 'body_too_large') // refuse, never truncate
  const expected = w.expectedVersion ?? 0
  const res = await upsertProjectWikiTopic(
    env,
    projectId,
    {
      ...w.base,
      document: {
        expected_version: expected,
        ...(w.expectedId !== undefined && expected > 0 ? { expected_id: w.expectedId } : {}),
        writer: w.writer,
        ...(w.body !== undefined ? { body: w.body } : {}),
      },
    },
    fetchImpl,
  )
  // The echo must be EXACTLY expected+1. Anything else (missing, other number) means the ack cannot be
  // trusted (an old/rolled-back server may ignore expected_version and body): we still check what we expect to
  // have written (expected+1) by readback/history, and an uncheckable write is NOT success.
  const putVersion = expected + 1
  const echoed = res.version === putVersion
  const verified = await verifyPersisted(
    env, projectId,
    { slug: w.base.slug, title: w.base.title, description: w.base.description ?? '', ...(w.body !== undefined ? { body: w.body } : {}) },
    putVersion, caps.revisionHistory, echoed, fetchImpl,
  )
  return {
    id: res.id,
    created: res.created,
    edgesUpserted: res.edges_upserted,
    storageVersion: putVersion,
    verification: verified.verification,
    ...(verified.currentVersion !== undefined ? { currentStorageVersion: verified.currentVersion } : {}),
  }
}

/**
 * Read the page back after an acknowledged write (`echoed` = the PUT response carried version === expected+1;
 * when false nothing about the ack is trusted and every "could not check" outcome is a failure). Outcomes:
 *  - our version + our body/title/description -> 'readback'
 *  - a HIGHER version (another writer)        -> our own retained revision (after_version = ours - 1) decides:
 *      matches -> 'history'; absent/different -> persistence_mismatch; history unreadable -> 'unverified'
 *  - lower version, or our version with different content -> persistence_mismatch (a real inconsistency)
 *  - readback has no storage version (the store fell back to legacy after the ack): the PUT was sent, so the
 *    title/summary WERE written but a body was NOT stored -> body_unsupported_after_write (never "nothing created")
 *  - the readback itself cannot be done -> 'unverified' (the store acked: NOT a failure, do not blind-retry)
 */
async function verifyPersisted(
  env: Env,
  projectId: string,
  sent: { slug: string; title: string; description: string; body?: string },
  putVersion: number,
  historyAvailable: boolean,
  echoed: boolean,
  fetchImpl?: typeof fetch,
): Promise<{ verification: 'readback' | 'history' | 'unverified'; currentVersion?: number }> {
  // Could not complete the check: tolerated only when the ack itself was a clean echo.
  const cannotCheck = (currentVersion?: number): { verification: 'unverified'; currentVersion?: number } => {
    if (!echoed) throw PERSISTENCE_MISMATCH()
    return { verification: 'unverified', ...(currentVersion !== undefined ? { currentVersion } : {}) }
  }
  let back: Awaited<ReturnType<typeof getProjectWikiTopic>>
  try {
    back = await getProjectWikiTopic(env, projectId, sent.slug, fetchImpl)
  } catch (e) {
    if (e instanceof WikiClientError || e instanceof WikiRequestError) return cannotCheck()
    throw e
  }
  if (!back) return cannotCheck()
  const current = back.topic.version
  if (typeof current !== 'number' || !Number.isSafeInteger(current)) {
    // The handshake said v1 but the readback has no storage version: the server fell back to legacy between
    // calls (rollback) and ignored expected_version/body. The metadata landed; a body did not.
    if (sent.body !== undefined && sent.body !== '') throw new PagesPortError('unsupported', 'body_unsupported_after_write')
    throw PERSISTENCE_MISMATCH()
  }
  const wantBody = sent.body
  if (current === putVersion) {
    if (wantBody !== undefined && (back.topic.body ?? '') !== wantBody) throw PERSISTENCE_MISMATCH()
    if (cleanText(back.topic.title, 120) !== cleanText(sent.title, 120) || cleanText(back.topic.description ?? '', 500) !== cleanText(sent.description, 500)) {
      throw PERSISTENCE_MISMATCH()
    }
    return { verification: 'readback' }
  }
  if (current < putVersion) throw PERSISTENCE_MISMATCH()
  // Another authorized writer advanced the page after ours. Our write is proven by its retained revision.
  if (!historyAvailable) return cannotCheck(current)
  let revisions: Awaited<ReturnType<typeof getProjectWikiRevisions>>
  try {
    revisions = await getProjectWikiRevisions(env, projectId, sent.slug, putVersion - 1, fetchImpl)
  } catch (e) {
    if (e instanceof WikiClientError || e instanceof WikiRequestError) return cannotCheck(current)
    throw e
  }
  if (!revisions) return cannotCheck(current)
  const mine = revisions.find((r) => r.version === putVersion)
  if (!mine) throw PERSISTENCE_MISMATCH()
  if (wantBody !== undefined && (mine.body ?? '') !== wantBody) throw PERSISTENCE_MISMATCH()
  return { verification: 'history', currentVersion: current }
}

export function createInkwellPagesPort(env: Env, fetchImpl?: typeof fetch): PagesPort {
  return {
    id: 'inkwell-wiki',
    // Capability-aware: whether THIS store holds bodies is decided per put() from the store's own handshake
    // (graph `capabilities`, wiki-documents/v1). A legacy store -> put() refuses a body (body_unsupported)
    // BEFORE any create; an upgraded one stores body + storage-version CAS.
    supportsBody: true,
    async get(projectId, slug) {
      try {
        const found = await getProjectWikiTopic(env, projectId, slug, fetchImpl)
        return found ? toRecord(found.topic, found.edges, found.capabilities) : null
      } catch (e) {
        return mapError(e)
      }
    },
    async put(projectId, input: PagePutInput): Promise<PagePutResult> {
      try {
        const res = await upsertWithCapabilities(
          env,
          projectId,
          {
            base: {
              slug: input.slug,
              title: input.title,
              description: input.summary,
              topic_type: input.envelope.purpose,
              tags: [...encodeEnvelopeTags(input.envelope), ...input.tags],
              edges: input.links.map((l) => ({ to_slug: l.toSlug, relation_type: l.relation })),
            },
            ...(input.body !== undefined ? { body: input.body } : {}),
            ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
            ...(input.expectedId !== undefined ? { expectedId: input.expectedId } : {}),
            writer: input.envelope.writer,
            ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
          },
          fetchImpl,
        )
        return {
          slug: input.slug,
          created: res.created,
          linksWritten: res.edgesUpserted,
          ...(res.storageVersion !== undefined ? { storageVersion: res.storageVersion } : {}),
          ...(res.id ? { storeId: res.id } : {}),
          ...(res.verification ? { verification: res.verification } : {}),
          ...(res.currentStorageVersion !== undefined ? { currentStorageVersion: res.currentStorageVersion } : {}),
        }
      } catch (e) {
        return mapError(e)
      }
    },
    async listBacklinks(projectId, slug): Promise<PageBacklink[]> {
      try {
        const graph = await getProjectWikiGraph(env, projectId, fetchImpl)
        const nodes = new Map(graph.nodes.filter((n) => n.published !== false).map((n) => [n.slug, n]))
        const out: PageBacklink[] = []
        for (const edge of graph.edges) {
          if (edge.to_slug !== slug || edge.from_slug === slug) continue
          const from = nodes.get(edge.from_slug)
          if (!from) continue
          const tags = Array.isArray(from.tags) ? from.tags.filter((t): t is string => typeof t === 'string') : []
          out.push({
            slug: from.slug,
            title: from.title,
            ...(edge.relation_type ? { relation: edge.relation_type } : {}),
            tier: isSquadTierTags(tags) ? 'squad' : (decodeEnvelope(tags, from.topic_type)?.tier ?? null),
          })
        }
        return out.sort((a, b) => a.slug.localeCompare(b.slug)).slice(0, MAX_BACKLINKS)
      } catch (e) {
        return mapError(e)
      }
    },
  }
}
