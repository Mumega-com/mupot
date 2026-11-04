// src/pages/service.ts — agent page writes over a PagesPort. Pure of auth: the MCP wrapper
// (src/mcp/pages.ts) has already decided WHO may write; this module validates the content, applies
// the update-ownership rules, stamps the server-side envelope (owner/writer/tier/version/writtenAt)
// and calls the port. The D1 `page_versions` row is only the monotonic counter + provenance.
// Squad-tier visibility (readPage / readBacklinks / writePage's canSeeSquadPages) is enforced HERE, in mupot;
// an adapter stores and returns text and never decides who may see it.

import type { Env } from '../types'
import { isSquadTierTags } from './inkwell-adapter'
import {
  bodyBytes,
  ENVELOPE_TAG_PREFIXES,
  isPageTier,
  isReservedSlug,
  MAX_BODY_BYTES,
  MAX_LINKS,
  MAX_SUMMARY,
  MAX_TAG_LEN,
  MAX_TITLE,
  MAX_USER_TAGS,
  MIN_TITLE,
  normalizeBody,
  PAGE_SLUG_RE,
  PagesPortError,
  PURPOSE_RE,
  type PageBacklink,
  type PageEnvelope,
  type PageLink,
  type PageRecord,
  type PagesPort,
  type PageTier,
} from './port'

export interface PageWriteInput {
  slug: unknown
  title: unknown
  summary: unknown
  body?: unknown
  /** Storage revision the caller last read (0 = create). Optional; see writePage for when it is required. */
  expectedVersion?: unknown
  purpose: unknown
  tier: unknown
  tags: unknown
  links: unknown
}

export interface ValidPageWrite {
  slug: string
  title: string
  summary: string
  /** undefined = leave the stored body unchanged; '' clears it. */
  body?: string
  /** Validated non-negative safe integer, or undefined. */
  expectedVersion?: number
  purpose: string
  tier: PageTier
  tags: string[]
  links: PageLink[]
}

export type PageFailure = {
  ok: false
  status: 400 | 403 | 404 | 409 | 501 | 502 | 503
  error: string
  detail?: string
  /** Structured, safe extras for the caller (e.g. stale_version: current_version, last_writer, next_step). */
  data?: Record<string, unknown>
}

const RELATION_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$|^[a-z0-9]$/

/** Validate-and-normalize. REFUSES (never truncates): a silently clipped summary is silent data loss. */
export function validatePageWrite(input: PageWriteInput): { ok: true; value: ValidPageWrite } | PageFailure {
  const bad = (detail: string): PageFailure => ({ ok: false, status: 400, error: 'invalid_args', detail })
  const { slug, title, summary, body, expectedVersion, purpose, tier, tags, links } = input
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
  let cleanBody: string | undefined
  if (body !== undefined) {
    if (typeof body !== 'string') return bad('body must be a markdown string')
    // eslint-disable-next-line no-control-regex -- NUL / C0 controls (except \t \n \r) have no place in markdown text
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(body)) return bad('body contains control characters')
    // The cap is measured on what will be stored: after CRLF/CR -> LF normalisation, in UTF-8 bytes.
    cleanBody = normalizeBody(body)
    const bytes = bodyBytes(cleanBody)
    if (bytes > MAX_BODY_BYTES) return bad(`body is ${bytes} bytes; max ${MAX_BODY_BYTES}. Split it across linked pages (nothing was truncated)`)
  }
  if (expectedVersion !== undefined && (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0)) {
    return bad('expected_version must be a non-negative integer: the page version you last read (0 to create)')
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
    value: { slug, title: squash(title), summary: squash(summary), ...(cleanBody !== undefined ? { body: cleanBody } : {}), ...(expectedVersion !== undefined ? { expectedVersion } : {}), purpose, tier, tags: cleanTags, links: cleanLinks },
  }
}

export type PageWriteOutcome =
  | {
      ok: true; slug: string; created: boolean; version: number; linksWritten: number; envelope: PageEnvelope
      /** wiki-documents/v1 storage revision; undefined on a legacy store. Distinct from `version` (the old counter). */
      storageVersion?: number
      verification?: 'readback' | 'history' | 'unverified'
      currentStorageVersion?: number
    }
  | PageFailure

function portFailure(e: PagesPortError): PageFailure {
  if (e.kind === 'conflict') return SLUG_UNAVAILABLE
  if (e.kind === 'unsupported') return e.code === 'conditional_writes_unsupported' ? CAS_UNSUPPORTED : BODY_UNSUPPORTED
  if (e.kind === 'rejected') {
    if (e.code === 'body_too_large') return { ok: false, status: 400, error: 'body_too_large', detail: 'body exceeds the store limit; split it across linked pages (nothing was truncated)' }
    return e.code === 'edge_target_invalid'
      ? { ok: false, status: 400, error: 'edge_target_invalid', detail: 'a link target is not an existing page in this project' }
      : { ok: false, status: 502, error: 'wiki_request_rejected' }
  }
  if (e.code === 'persistence_mismatch') {
    return {
      ok: false, status: 502, error: 'wiki_persistence_mismatch',
      detail: 'the store acknowledged the write but the page read back differently; do NOT blindly retry: re-read with project_wiki_get and compare before writing again',
    }
  }
  return { ok: false, status: 503, error: 'wiki_unavailable' }
}

// Typed, non-silent: this adapter's store has no home for a body. 501 (not 409): nothing about the caller's
// request state is in conflict, the server lacks the capability; retrying later (after the store ships bodies)
// is the correct recovery, and a 409 would suggest the caller can fix it by changing the call.
const BODY_UNSUPPORTED: PageFailure = {
  ok: false, status: 501, error: 'body_unsupported',
  detail: 'this wiki store cannot hold a page body yet; send title/summary only, or keep long text in project_remember and link it',
}

const CAS_UNSUPPORTED: PageFailure = {
  ok: false, status: 501, error: 'conditional_writes_unsupported',
  detail: 'this wiki store cannot check expected_version yet; omit it (the write would be unconditional) or wait for the store upgrade',
}

// ONE refusal for every "that slug is not yours to take" case (taken by another project, held by a page this
// tool never wrote, or lost): distinct answers would let a caller probe which slugs exist in projects they
// cannot see (adversarial gate #1974 P2-2). Success vs this refusal still tells a caller a slug is free, which
// is inherent to tenant-wide slug uniqueness in the store.
const SLUG_UNAVAILABLE: PageFailure = { ok: false, status: 409, error: 'slug_unavailable', detail: 'that slug cannot be written by this call' }

export async function writePage(
  env: Env,
  port: PagesPort,
  args: {
    projectId: string
    writer: string
    input: ValidPageWrite
    /** Caller holds squad access to the project (callerHasSquadAccessToProject). Required: no default, fail closed. */
    canSeeSquadPages: boolean
    now?: () => Date
  },
): Promise<PageWriteOutcome> {
  const { projectId, writer, input } = args
  const writtenAt = (args.now ?? (() => new Date()))().toISOString()
  // Refuse a body the adapter cannot store BEFORE any I/O (the adapter's own put refuses too, defence in depth).
  if (input.body !== undefined && input.body !== '' && !port.supportsBody) return BODY_UNSUPPORTED
  if (input.tier === 'squad' && !args.canSeeSquadPages) {
    return { ok: false, status: 403, error: 'squad_access_required', detail: 'squad-tier pages need membership of a squad with access to this project' }
  }
  try {
    // OWNER / TIER come from the stamped envelope in the TEXT record (the store of record), never from
    // mupot-side state. No topic -> no owner -> this is a create and the writer becomes the owner. A topic
    // that exists but carries no stamp of ours is not ours to touch.
    const existing = await port.get(projectId, input.slug)
    const counter = await env.DB.prepare('SELECT version FROM page_versions WHERE project_id = ?1 AND slug = ?2')
      .bind(projectId, input.slug).first<{ version: number }>()
    if (existing && !existing.envelope) return SLUG_UNAVAILABLE
    // A squad page the caller cannot see is indistinguishable from a slug that is not theirs to take.
    if (existing?.envelope?.tier === 'squad' && !args.canSeeSquadPages) return SLUG_UNAVAILABLE
    // Refuse-only hint: we wrote here before but the store no longer shows the page (unpublished/removed).
    // The store's UPDATE matches unpublished rows and republishes them, so a put here would resurrect it.
    if (!existing && counter) return SLUG_UNAVAILABLE
    if (existing?.envelope && existing.envelope.tier !== input.tier && writer !== existing.envelope.owner) {
      return { ok: false, status: 403, error: 'tier_change_owner_only', detail: 'only the page owner may change its tier' }
    }

    // Storage-version expectation. NEVER the envelope `v:` counter and NEVER silently refreshed after a stale 409.
    //  - caller gave one: use it verbatim.
    //  - none, the page exists on an upgraded store, and the call carries a body: refuse. Replacing (or clearing)
    //    a document without naming the revision you read is a blind overwrite.
    //  - none, metadata-only: the store keeps the body, so condition on the revision we just read (still CAS
    //    against a write that lands between our read and our put).
    //  - none and no page (or a legacy store): leave undefined; the adapter sends 0 (create) / nothing.
    let expectedVersion = input.expectedVersion
    if (expectedVersion === undefined && existing?.storageVersion !== undefined) {
      if (input.body !== undefined) {
        return {
          ok: false, status: 400, error: 'expected_version_required',
          detail: `this page already exists at version ${existing.storageVersion}; to replace or clear its body pass expected_version (read it with project_wiki_get, merge, then retry with expected_version ${existing.storageVersion})`,
          data: { current_version: existing.storageVersion },
        }
      }
      expectedVersion = existing.storageVersion
    }

    const owner = existing?.envelope?.owner ?? writer
    const version = Math.max(counter?.version ?? 0, existing?.envelope?.version ?? 0) + 1
    const envelope: PageEnvelope = { owner, writer, tier: input.tier, purpose: input.purpose, version, writtenAt }

    // PUT FIRST. A refused or failed put (bad link, outage, conflict) leaves no counter row and no owner
    // claim anywhere (owner exists only in the text record), so a failed write cannot squat a slug. The
    // only cost of a failure is that no version is consumed.
    let res: Awaited<ReturnType<PagesPort['put']>>
    try {
      res = await port.put(projectId, {
        slug: input.slug, title: input.title, summary: input.summary, ...(input.body !== undefined ? { body: input.body } : {}),
        ...(expectedVersion !== undefined ? { expectedVersion } : {}), tags: input.tags, links: input.links, envelope,
      })
    } catch (e) {
      if (e instanceof PagesPortError && e.kind === 'stale' && e.stale) return await staleFailure(port, projectId, input.slug, e.stale, args.canSeeSquadPages)
      throw e
    }

    // Counter only advances. The put has NO compare-and-swap (see PagesPort.put), so two racing writers can
    // stamp the same version; MAX(counter + 1, stamped) still moves the counter past both so the NEXT stamp is
    // distinct. Stamped versions of concurrent writes can therefore repeat or land out of order.
    await env.DB.prepare(
      `INSERT INTO page_versions (project_id, slug, version) VALUES (?1, ?2, ?3)
       ON CONFLICT (project_id, slug) DO UPDATE SET version = MAX(page_versions.version + 1, excluded.version)`,
    ).bind(projectId, input.slug, version).run()
    return {
      ok: true, slug: res.slug, created: res.created, version, linksWritten: res.linksWritten, envelope,
      ...(res.storageVersion !== undefined ? { storageVersion: res.storageVersion } : {}),
      ...(res.verification !== undefined ? { verification: res.verification } : {}),
      ...(res.currentStorageVersion !== undefined ? { currentStorageVersion: res.currentStorageVersion } : {}),
    }
  } catch (e) {
    if (e instanceof PagesPortError) return portFailure(e)
    throw e
  }
}

/**
 * A stale write (the page moved past expected_version). The store only reveals where the page is after ITS
 * visibility check, but a squad-tier page is mupot's call: re-read once and fall back to the generic refusal
 * when the page is not ours, or is squad-tier and this caller may not see it, so a stale answer never names a
 * hidden squad page's version or last writer.
 */
async function staleFailure(
  port: PagesPort,
  projectId: string,
  slug: string,
  stale: { currentVersion: number; lastWriter?: string },
  canSeeSquadPages: boolean,
): Promise<PageFailure> {
  const now = await port.get(projectId, slug)
  if (!now || !now.envelope) return SLUG_UNAVAILABLE
  if (now.envelope.tier === 'squad' && !canSeeSquadPages) return SLUG_UNAVAILABLE
  const who = stale.lastWriter ? `, last written by ${stale.lastWriter}` : ''
  return {
    ok: false, status: 409, error: 'stale_version',
    detail: `the page changed since you read it (now version ${stale.currentVersion}${who}). Nothing was overwritten. Re-read with project_wiki_get, merge your change, then retry with expected_version ${stale.currentVersion}`,
    data: { current_version: stale.currentVersion, ...(stale.lastWriter ? { last_writer: stale.lastWriter } : {}), next_step: `re-read, merge, retry with expected_version ${stale.currentVersion}` },
  }
}

// ── reads: squad-tier visibility enforced HERE, before anything reaches the MCP/dashboard layer ───────────────
// A page's tier lives in its stamped envelope (the text record is the store of record), so the service must
// ask the adapter for the page to learn the tier; the check then runs on the result and a hidden page is
// returned as null (identical to absent: no existence oracle). Raw adapter output never reaches a caller.

export const MAX_LINK_TIER_PROBES = 40

/** The page as this caller may see it, or null (absent OR a squad page they cannot see). */
export async function readPage(port: PagesPort, args: { projectId: string; slug: string; canSeeSquadPages: boolean }): Promise<PageRecord | null> {
  const page = await port.get(args.projectId, args.slug)
  if (!page) return null
  if (args.canSeeSquadPages) return page
  if (isSquadTierTags(page.rawTags ?? [`tier:${page.envelope?.tier}`])) return null
  // A visible page may link to a squad page; naming its slug would leak its existence. Probe each target's tier
  // (bounded; past the bound the extra links are dropped, fail closed).
  const probe = page.links.slice(0, MAX_LINK_TIER_PROBES)
  const targets = await Promise.all(probe.map((l) => port.get(args.projectId, l.toSlug)))
  const links = probe.filter((_, i) => !isSquadTierTags(targets[i]?.rawTags ?? [`tier:${targets[i]?.envelope?.tier}`]))
  return { ...page, links }
}

/** Backlinks the caller may see; null when the target page itself is not visible to them. */
export async function readBacklinks(port: PagesPort, args: { projectId: string; slug: string; canSeeSquadPages: boolean }): Promise<PageBacklink[] | null> {
  // The target is checked first: whether a hidden squad page has inbound links is itself a leak.
  const target = await port.get(args.projectId, args.slug)
  if (!target) return null
  if (!args.canSeeSquadPages && isSquadTierTags(target.rawTags ?? [`tier:${target.envelope?.tier}`])) return null
  return filterBacklinks(await port.listBacklinks(args.projectId, args.slug), args.canSeeSquadPages)
}

/** Drop squad-tier sources for a caller without squad access. */
export function filterBacklinks(all: PageBacklink[], canSeeSquadPages: boolean): PageBacklink[] {
  return canSeeSquadPages ? all : all.filter((b) => b.tier !== 'squad')
}
