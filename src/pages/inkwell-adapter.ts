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
  type WikiTopic,
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
  if (canSeeSquadPages || !Array.isArray(graph.nodes)) return graph
  const hidden = new Set<string>()
  const nodes = graph.nodes.filter((n: unknown) => {
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
const EDGE_REFUSALS = new Set(['edge_target_invalid', 'cross_project_edge_refused', 'edge_target_unpublished'])

function mapError(e: unknown): never {
  if (e instanceof PagesPortError) throw e
  if (e instanceof WikiConflictError) {
    // wiki-documents/v1: the store only attaches current_version once it has re-checked that THIS caller may
    // see the page, so a version here is a STALE write, not a slug probe. Without it: the generic refusal.
    if (e.currentVersion !== undefined) throw new PagesPortError('stale', 'stale_version', { currentVersion: e.currentVersion, ...(e.lastWriter ? { lastWriter: e.lastWriter } : {}) })
    if (e.code === 'invalid_content_blocks') throw new PagesPortError('rejected', 'document_blocks_invalid')
    throw new PagesPortError('conflict', 'slug_unavailable') // never leak existing_project
  }
  if (e instanceof WikiRequestError) {
    // Every edge-target refusal collapses to ONE code (the real route already does; older/other upstream
    // vocabularies distinguish missing vs cross-project vs unpublished, which is an existence oracle).
    throw new PagesPortError('rejected', EDGE_REFUSALS.has(e.code) ? 'edge_target_invalid' : 'request_rejected')
  }
  if (e instanceof WikiClientError) throw new PagesPortError('unavailable', e.reason)
  throw e
}

function toRecord(topic: WikiTopic, edges: { to_slug: string; relation_type: string; from_slug: string }[]): PageRecord {
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
    ...(typeof topic.last_writer === 'string' && topic.last_writer ? { lastWriter: topic.last_writer } : {}),
    tags: tags.filter((t) => ![...stamped].some((p) => t.startsWith(p))),
    rawTags: tags,
    links,
    envelope: decodeEnvelope(tags, topic.topic_type),
  }
}

const PERSISTENCE_MISMATCH = (): PagesPortError => new PagesPortError('unavailable', 'persistence_mismatch')

/**
 * Read the page back after an acknowledged write (`echoed` = the PUT response carried version === expected+1;
 * when false nothing about the ack is trusted and every "could not check" outcome is a failure). Outcomes:
 *  - our version + our body            -> 'readback'
 *  - a HIGHER version (another writer) -> our own retained revision (after_version = ours - 1) decides:
 *      matches -> 'history'; absent/different -> persistence_mismatch; history unreadable -> 'unverified'
 *  - lower version, or our version with a different body -> persistence_mismatch (a real inconsistency)
 *  - the readback itself cannot be done -> 'unverified' (the store acked: this is NOT a failure and must not
 *    be blind-retried; a blind retry would double-apply or hit our own stale version).
 */
async function verifyPersisted(
  env: Env,
  projectId: string,
  input: PagePutInput,
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
    back = await getProjectWikiTopic(env, projectId, input.slug, fetchImpl)
  } catch (e) {
    if (e instanceof WikiClientError || e instanceof WikiRequestError) return cannotCheck()
    throw e
  }
  if (!back) return cannotCheck()
  const current = back.topic.version
  if (typeof current !== 'number' || !Number.isSafeInteger(current)) {
    // The handshake said v1 but the readback has no storage version: the server fell back to legacy between
    // calls (rollback) and silently ignored expected_version/body. A body was NOT stored; say so.
    if (input.body !== undefined && input.body !== '') throw new PagesPortError('unsupported', 'body_unsupported')
    throw PERSISTENCE_MISMATCH()
  }
  const wantBody = input.body !== undefined ? input.body : undefined
  if (current === putVersion) {
    if (wantBody !== undefined && (back.topic.body ?? '') !== wantBody) throw PERSISTENCE_MISMATCH()
    return { verification: 'readback' }
  }
  if (current < putVersion) throw PERSISTENCE_MISMATCH()
  // Another authorized writer advanced the page after ours. Our write is proven by its retained revision.
  if (!historyAvailable) return cannotCheck(current)
  let revisions: Awaited<ReturnType<typeof getProjectWikiRevisions>>
  try {
    revisions = await getProjectWikiRevisions(env, projectId, input.slug, putVersion - 1, fetchImpl)
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
        return found ? toRecord(found.topic, found.edges) : null
      } catch (e) {
        return mapError(e)
      }
    },
    async put(projectId, input: PagePutInput): Promise<PagePutResult> {
      const hasBody = input.body !== undefined && input.body !== ''
      try {
        // Cold-create handshake: ask the store what it is BEFORE deciding what to send, even for an empty project.
        const caps = await getProjectWikiCapabilities(env, projectId, fetchImpl)
        const base = {
          slug: input.slug,
          title: input.title,
          description: input.summary,
          topic_type: input.envelope.purpose,
          tags: [...encodeEnvelopeTags(input.envelope), ...input.tags],
          edges: input.links.map((l) => ({ to_slug: l.toSlug, relation_type: l.relation })),
        }
        if (!caps) {
          // LEGACY: metadata-only, request byte-identical to before. A body or a CAS request cannot be honoured,
          // so it is refused explicitly (never silently dropped) before anything is created.
          if (hasBody) throw new PagesPortError('unsupported', 'body_unsupported')
          if (input.expectedVersion !== undefined) throw new PagesPortError('unsupported', 'conditional_writes_unsupported')
          const res = await upsertProjectWikiTopic(env, projectId, base, fetchImpl)
          return { slug: input.slug, created: res.created, linksWritten: res.edges_upserted }
        }

        // UPGRADED (wiki-documents/v1).
        const cap = Math.min(caps.max_body_bytes, MAX_BODY_BYTES)
        if (input.body !== undefined) {
          const bytes = bodyBytes(input.body)
          if (bytes > cap) throw new PagesPortError('rejected', 'body_too_large') // refuse, never truncate
        }
        const expected = input.expectedVersion ?? 0
        const res = await upsertProjectWikiTopic(
          env,
          projectId,
          { ...base, document: { expected_version: expected, writer: input.envelope.writer, ...(input.body !== undefined ? { body: input.body } : {}) } },
          fetchImpl,
        )
        // The echo must be EXACTLY expected+1. Anything else (missing, other number) means the ack cannot be
        // trusted (an old/rolled-back server may ignore expected_version and body): we still check what we
        // expect to have written (expected+1) by readback/history, and an uncheckable write is NOT success.
        const putVersion = expected + 1
        const echoed = res.version === putVersion
        const verified = await verifyPersisted(env, projectId, input, putVersion, caps.revision_history, echoed, fetchImpl)
        return {
          slug: input.slug,
          created: res.created,
          linksWritten: res.edges_upserted,
          storageVersion: putVersion,
          verification: verified.verification,
          ...(verified.currentVersion !== undefined ? { currentStorageVersion: verified.currentVersion } : {}),
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
