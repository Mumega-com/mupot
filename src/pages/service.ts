// src/pages/service.ts — agent page writes over a PagesPort. Pure of auth: the MCP wrapper
// (src/mcp/pages.ts) has already decided WHO may write; this module validates the content, applies
// the update-ownership rules, stamps the server-side envelope (owner/writer/tier/version/writtenAt)
// and calls the port. The D1 `page_versions` row is only the monotonic counter + provenance.

import type { Env } from '../types'
import {
  ENVELOPE_TAG_PREFIXES,
  isPageTier,
  isReservedSlug,
  MAX_LINKS,
  MAX_SUMMARY,
  MAX_TAG_LEN,
  MAX_TITLE,
  MAX_USER_TAGS,
  MIN_TITLE,
  PAGE_SLUG_RE,
  PagesPortError,
  PURPOSE_RE,
  type PageEnvelope,
  type PageLink,
  type PagesPort,
  type PageTier,
} from './port'

export interface PageWriteInput {
  slug: unknown
  title: unknown
  summary: unknown
  purpose: unknown
  tier: unknown
  tags: unknown
  links: unknown
}

export interface ValidPageWrite {
  slug: string
  title: string
  summary: string
  purpose: string
  tier: PageTier
  tags: string[]
  links: PageLink[]
}

export type PageFailure = { ok: false; status: 400 | 403 | 409 | 502 | 503; error: string; detail?: string }

const RELATION_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$|^[a-z0-9]$/

/** Validate-and-normalize. REFUSES (never truncates): a silently clipped summary is silent data loss. */
export function validatePageWrite(input: PageWriteInput): { ok: true; value: ValidPageWrite } | PageFailure {
  const bad = (detail: string): PageFailure => ({ ok: false, status: 400, error: 'invalid_args', detail })
  const { slug, title, summary, purpose, tier, tags, links } = input
  if (typeof slug !== 'string' || !PAGE_SLUG_RE.test(slug)) return bad('slug must be lowercase kebab, 3-63 chars')
  if (isReservedSlug(slug)) return { ok: false, status: 403, error: 'reserved_slug', detail: 'this slug prefix is reserved' }
  // The store collapses whitespace runs to one space and trims; do the same HERE so every length check
  // measures what will actually be stored (a multi-line summary is stored as one line).
  const squash = (v: string): string => v.replace(/\s+/g, ' ').trim()
  if (typeof title !== 'string' || squash(title).length < MIN_TITLE || squash(title).length > MAX_TITLE) {
    return bad(`title must be ${MIN_TITLE}-${MAX_TITLE} chars`)
  }
  if (typeof summary !== 'string' || !squash(summary)) return bad('summary required')
  if (squash(summary).length > MAX_SUMMARY) {
    return bad(`summary is ${squash(summary).length} chars; max ${MAX_SUMMARY}. Put long text in project_remember and link it`)
  }
  if (typeof purpose !== 'string' || !PURPOSE_RE.test(purpose)) return bad('purpose required: kebab, 3-32 chars (e.g. decision, runbook)')
  if (!isPageTier(tier)) return bad("tier required: 'project' or 'squad'")

  const cleanTags: string[] = []
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.length > MAX_USER_TAGS) return bad(`tags: array of at most ${MAX_USER_TAGS}`)
    for (const t of tags) {
      if (typeof t !== 'string' || !t.trim() || t.trim().length > MAX_TAG_LEN) return bad(`each tag must be 1-${MAX_TAG_LEN} chars`)
      const tag = t.trim()
      if (ENVELOPE_TAG_PREFIXES.some((p) => tag.toLowerCase().startsWith(p))) {
        return { ok: false, status: 403, error: 'reserved_tag', detail: 'owner:/tier:/v:/by:/at: are server-stamped' }
      }
      if (!cleanTags.includes(tag)) cleanTags.push(tag)
    }
  }

  const cleanLinks: PageLink[] = []
  if (links !== undefined) {
    if (!Array.isArray(links) || links.length > MAX_LINKS) return bad(`links: array of at most ${MAX_LINKS}`)
    for (const l of links) {
      if (!l || typeof l !== 'object') return bad('each link must be { to_slug, relation? }')
      const rec = l as Record<string, unknown> // narrowed from unknown; every field re-validated below
      if (typeof rec.to_slug !== 'string' || !PAGE_SLUG_RE.test(rec.to_slug)) return bad('link to_slug must be a page slug')
      if (rec.relation !== undefined && (typeof rec.relation !== 'string' || !RELATION_RE.test(rec.relation))) {
        return bad('link relation must be kebab, 1-32 chars')
      }
      if (rec.to_slug === slug) return bad('a page cannot link to itself')
      if (!cleanLinks.some((c) => c.toSlug === rec.to_slug)) {
        cleanLinks.push({ toSlug: rec.to_slug, ...(typeof rec.relation === 'string' ? { relation: rec.relation } : {}) })
      }
    }
  }

  return {
    ok: true,
    value: { slug, title: squash(title), summary: squash(summary), purpose, tier, tags: cleanTags, links: cleanLinks },
  }
}

export type PageWriteOutcome =
  | { ok: true; slug: string; created: boolean; version: number; linksWritten: number; envelope: PageEnvelope }
  | PageFailure

function portFailure(e: PagesPortError): PageFailure {
  if (e.kind === 'conflict') return SLUG_UNAVAILABLE
  if (e.kind === 'rejected') {
    return e.code === 'edge_target_invalid'
      ? { ok: false, status: 400, error: 'edge_target_invalid', detail: 'a link target is not an existing page in this project' }
      : { ok: false, status: 502, error: 'wiki_request_rejected' }
  }
  return { ok: false, status: 503, error: 'wiki_unavailable' }
}

// ONE refusal for every "that slug is not yours to take" case (taken by another project, held by a page this
// tool never wrote, or lost): distinct answers would let a caller probe which slugs exist in projects they
// cannot see (adversarial gate #1974 P2-2). Success vs this refusal still tells a caller a slug is free, which
// is inherent to tenant-wide slug uniqueness in the store.
const SLUG_UNAVAILABLE: PageFailure = { ok: false, status: 409, error: 'slug_unavailable', detail: 'that slug cannot be written by this call' }

export async function writePage(
  env: Env,
  port: PagesPort,
  args: { projectId: string; writer: string; input: ValidPageWrite; now?: () => Date },
): Promise<PageWriteOutcome> {
  const { projectId, writer, input } = args
  const writtenAt = (args.now ?? (() => new Date()))().toISOString()
  try {
    // OWNER / TIER come from the stamped envelope in the TEXT record (the store of record), never from
    // mupot-side state. No topic -> no owner -> this is a create and the writer becomes the owner. A topic
    // that exists but carries no stamp of ours is not ours to touch.
    const existing = await port.get(projectId, input.slug)
    const counter = await env.DB.prepare('SELECT version FROM page_versions WHERE project_id = ?1 AND slug = ?2')
      .bind(projectId, input.slug).first<{ version: number }>()
    if (existing && !existing.envelope) return SLUG_UNAVAILABLE
    // Refuse-only hint: we wrote here before but the store no longer shows the page (unpublished/removed).
    // The store's UPDATE matches unpublished rows and republishes them, so a put here would resurrect it.
    if (!existing && counter) return SLUG_UNAVAILABLE
    if (existing?.envelope && existing.envelope.tier !== input.tier && writer !== existing.envelope.owner) {
      return { ok: false, status: 403, error: 'tier_change_owner_only', detail: 'only the page owner may change its tier' }
    }

    const owner = existing?.envelope?.owner ?? writer
    const version = Math.max(counter?.version ?? 0, existing?.envelope?.version ?? 0) + 1
    const envelope: PageEnvelope = { owner, writer, tier: input.tier, purpose: input.purpose, version, writtenAt }

    // PUT FIRST. A refused or failed put (bad link, outage, conflict) leaves no counter row and no owner
    // claim anywhere (owner exists only in the text record), so a failed write cannot squat a slug. The
    // only cost of a failure is that no version is consumed.
    const res = await port.put(projectId, {
      slug: input.slug, title: input.title, summary: input.summary, tags: input.tags, links: input.links, envelope,
    })

    // Counter only advances. The put has NO compare-and-swap (see PagesPort.put), so two racing writers can
    // stamp the same version; MAX(counter + 1, stamped) still moves the counter past both so the NEXT stamp is
    // distinct. Stamped versions of concurrent writes can therefore repeat or land out of order.
    await env.DB.prepare(
      `INSERT INTO page_versions (project_id, slug, version) VALUES (?1, ?2, ?3)
       ON CONFLICT (project_id, slug) DO UPDATE SET version = MAX(page_versions.version + 1, excluded.version)`,
    ).bind(projectId, input.slug, version).run()
    return { ok: true, slug: res.slug, created: res.created, version, linksWritten: res.linksWritten, envelope }
  } catch (e) {
    if (e instanceof PagesPortError) return portFailure(e)
    throw e
  }
}
