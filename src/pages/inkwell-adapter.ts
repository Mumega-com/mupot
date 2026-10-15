// src/pages/inkwell-adapter.ts — the DEFAULT PagesPort adapter: the Inkwell internal wiki store,
// reached ONLY through src/projects/wiki-client.ts (same connector, SSRF guard, fail-closed errors).
// No second store: a page is a wiki topic. The envelope rides in the topic's tags (owner:/tier:/v:/by:/at:)
// and `topic_type` carries the purpose, so the stamped provenance survives as parseable text in the
// store of record, not only in mupot's counter table.

import type { Env } from '../types'
import {
  getProjectWikiTopic,
  upsertProjectWikiTopic,
  WikiClientError,
  WikiConflictError,
  WikiRequestError,
  type WikiTopic,
} from '../projects/wiki-client'
import {
  isPageTier,
  PagesPortError,
  type PageEnvelope,
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

const EDGE_REFUSALS = new Set(['edge_target_invalid', 'cross_project_edge_refused', 'edge_target_unpublished'])

function mapError(e: unknown): never {
  if (e instanceof WikiConflictError) throw new PagesPortError('conflict', 'slug_unavailable') // never leak existing_project
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
  return {
    slug: topic.slug,
    title: topic.title,
    summary: topic.description,
    tags: tags.filter((t) => ![...stamped].some((p) => t.startsWith(p))),
    links,
    envelope: decodeEnvelope(tags, topic.topic_type),
  }
}

export function createInkwellPagesPort(env: Env, fetchImpl?: typeof fetch): PagesPort {
  return {
    id: 'inkwell-wiki',
    async get(projectId, slug) {
      try {
        const found = await getProjectWikiTopic(env, projectId, slug, fetchImpl)
        return found ? toRecord(found.topic, found.edges) : null
      } catch (e) {
        return mapError(e)
      }
    },
    async put(projectId, input: PagePutInput): Promise<PagePutResult> {
      try {
        const res = await upsertProjectWikiTopic(
          env,
          projectId,
          {
            slug: input.slug,
            title: input.title,
            description: input.summary,
            topic_type: input.envelope.purpose,
            tags: [...encodeEnvelopeTags(input.envelope), ...input.tags],
            edges: input.links.map((l) => ({ to_slug: l.toSlug, relation_type: l.relation })),
          },
          fetchImpl,
        )
        return { slug: input.slug, created: res.created, linksWritten: res.edges_upserted }
      } catch (e) {
        return mapError(e)
      }
    },
  }
}
