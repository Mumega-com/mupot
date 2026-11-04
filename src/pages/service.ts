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
  /** Store page id from the read (project_wiki_get page_id). Optional. */
  expectedId?: unknown
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
  expectedId?: string
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
  const { slug, title, summary, body, purpose, tier, tags, links } = input
  // null = omitted: an agent echoing `version: null` from a legacy read must not trip a type error.
  const expectedVersion = input.expectedVersion === null ? undefined : input.expectedVersion
  const expectedId = input.expectedId === null ? undefined : input.expectedId
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
  if (expectedId !== undefined && (typeof expectedId !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(expectedId))) {
    return bad('expected_id must be the page_id you last read from project_wiki_get')
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
    value: { slug, title: squash(title), summary: squash(summary), ...(cleanBody !== undefined ? { body: cleanBody } : {}), ...(expectedVersion !== undefined ? { expectedVersion } : {}), ...(expectedId !== undefined ? { expectedId } : {}), purpose, tier, tags: cleanTags, links: cleanLinks },
  }
}

export type PageWriteOutcome =
  | {
      ok: true; slug: string; created: boolean; version: number; linksWritten: number; envelope: PageEnvelope
      /** wiki-documents/v1 storage revision; undefined on a legacy store. Distinct from `version` (the old counter). */
      storageVersion?: number
      storeId?: string
      verification?: 'readback' | 'history' | 'unverified'
      currentStorageVersion?: number
    }
  | PageFailure

function portFailure(e: PagesPortError): PageFailure {
  if (e.kind === 'conflict') return SLUG_UNAVAILABLE
  if (e.kind === 'unsupported') {
    if (e.code === 'conditional_writes_unsupported') return CAS_UNSUPPORTED
    if (e.code === 'body_unsupported_after_write') return BODY_NOT_STORED
    return BODY_UNSUPPORTED
  }
  if (e.kind === 'rejected') {
    if (e.code === 'document_blocks_invalid') {
      return {
        ok: false, status: 409, error: 'document_corrupt',
        detail: 'the stored document on this page is unreadable, so its body cannot be replaced safely; nothing was written. Ask the pot owner to repair the page (project_wiki_get shows body_error)',
      }
    }
    if (e.code === 'expected_id_required') return expectedIdRequired()
    if (e.code === 'invalid_expected_id') return { ok: false, status: 400, error: 'invalid_expected_id', detail: 'expected_id must be the page_id returned by project_wiki_get, unchanged' }
    if (e.code === 'body_too_large') return { ok: false, status: 400, error: 'body_too_large', detail: 'body exceeds the store limit; split it across linked pages (nothing was truncated)' }
    return e.code === 'edge_target_invalid'
      ? { ok: false, status: 400, error: 'edge_target_invalid', detail: 'a link target is not an existing page in this project' }
      : { ok: false, status: 502, error: 'wiki_request_rejected' }
  }
  if (e.code === 'schema_pending') {
    return {
      ok: false, status: 503, error: 'wiki_schema_pending',
      detail: 'the wiki store is mid-upgrade (its migration is not finished), so writes are paused; nothing was written. Retry later; if it persists ask the pot owner to finish the wiki store migration',
    }
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

// The PUT WAS sent and acknowledged, then the readback showed the store had fallen back to legacy: the
// title/summary landed, the body did not. Never say "nothing was created".
const BODY_NOT_STORED: PageFailure = {
  ok: false, status: 501, error: 'body_unsupported',
  detail: 'the wiki store stopped accepting bodies mid-write: the page title/summary WERE written (the page may now exist) but the body was NOT stored. Re-read with project_wiki_get, and retry the body once the store upgrade is back',
  data: { metadata_written: true, body_stored: false },
}

/**
 * A body replace/clear on an existing page must carry the page_id the AGENT read. mupot never substitutes the id
 * of its own fresh read: a page deleted and recreated at the same version would then be overwritten (#1657 ABA).
 * Deliberately shows no current page_id or version: the agent must read the page, not copy it from the refusal.
 */
function expectedIdRequired(): PageFailure {
  return {
    ok: false, status: 400, error: 'expected_id_required',
    detail: 'this page already exists; replacing or clearing its body needs the page_id you read, so a page deleted and recreated since then is never overwritten. Nothing was written',
    data: { next_step: 'read the page with project_wiki_get and pass its page_id as expected_id' },
  }
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
    // The READ path's predicate (any `tier:squad` stamp hides the page), not the first-tier decode.
    if (existing && hiddenSquadPage(existing, args.canSeeSquadPages)) return SLUG_UNAVAILABLE
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
    // The page id travels with the version: delete+recreate restarts at version 1 under a NEW id (ABA). The
    // caller's id wins; otherwise the id of the read we just made. A different id is a stale write.
    if (input.expectedId !== undefined && existing?.storeId !== undefined && input.expectedId !== existing.storeId) {
      return staleFromPage(existing, expectedVersion)
    }
    // Only METADATA-ONLY writes may take the id from our own read (the store keeps the body, nothing is replaced).
    // A body write must bring its own id (checked below): filling it in here would defeat the fence.
    const expectedId = input.expectedId ?? (input.body === undefined ? existing?.storeId : undefined)
    if (expectedVersion === undefined && existing?.storageVersion !== undefined) {
      if (input.body !== undefined) {
        return {
          ok: false, status: 400, error: 'expected_version_required',
          detail: `this page already exists at version ${existing.storageVersion}; to replace or clear its body pass expected_version (read it with project_wiki_get, merge, then retry with expected_version ${existing.storageVersion})`,
          data: { current_version: existing.storageVersion }, // no page_id here: the id must come from the agent's own read
        }
      }
      expectedVersion = existing.storageVersion
    }
    // Body replace/clear on an existing upgraded page (version 0 = a create collision, refused by the store):
    // the caller's own page_id is mandatory.
    if (input.body !== undefined && input.expectedId === undefined && existing?.storageVersion !== undefined && expectedVersion !== 0) {
      return expectedIdRequired()
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
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
        ...(expectedId !== undefined && expectedVersion !== 0 ? { expectedId } : {}),
        ...(existing?.capabilities !== undefined ? { capabilities: existing.capabilities } : {}),
        tags: input.tags, links: input.links, envelope,
      })
    } catch (e) {
      if (e instanceof PagesPortError && e.kind === 'stale' && e.stale) return await staleFailure(port, projectId, input.slug, expectedVersion, args.canSeeSquadPages, e.stale.replaced === true)
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
      ...(res.storeId ? { storeId: res.storeId } : {}),
      ...(res.verification !== undefined ? { verification: res.verification } : {}),
      ...(res.currentStorageVersion !== undefined ? { currentStorageVersion: res.currentStorageVersion } : {}),
    }
  } catch (e) {
    if (e instanceof PagesPortError) return portFailure(e)
    throw e
  }
}

/** The READ path's predicate: ANY `tier:squad` stamp hides the page from a caller without squad access. */
function hiddenSquadPage(page: PageRecord, canSeeSquadPages: boolean): boolean {
  return !canSeeSquadPages && isSquadTierTags(page.rawTags ?? [`tier:${page.envelope?.tier}`])
}

/** The refusal for a write whose version/id no longer matches. Everything shown comes from the RE-READ page. */
function staleFromPage(now: PageRecord, sentVersion: number | undefined, storeSaidReplaced = false): PageFailure {
  if (now.storageVersion === undefined) return SLUG_UNAVAILABLE
  const v = now.storageVersion
  // Same number as the caller sent but still refused: the id changed (deleted and recreated) or a write raced
  // at that exact revision. Pointing at "retry with N" would loop, so say the page was replaced.
  const replaced = storeSaidReplaced || (sentVersion !== undefined && sentVersion === v)
  const next = replaced
    ? 're-read the page in full (project_wiki_get), merge, retry with the version AND page_id it returns'
    : `re-read, merge, retry with expected_version ${v}`
  return {
    ok: false, status: 409, error: 'stale_version',
    detail: replaced
      ? storeSaidReplaced
        ? 'the page was deleted and recreated since you read it; re-read the page in full with project_wiki_get, merge your change, then retry with the version and page_id it returns. Nothing was overwritten'
        : 'the page was replaced or rewritten since you read it (same version number, different page). Nothing was overwritten. Re-read the page in full with project_wiki_get, merge your change, then retry with the version and page_id it returns'
      : `the page changed since you read it (now version ${v}). Nothing was overwritten. Re-read with project_wiki_get, merge your change, then retry with expected_version ${v}`,
    data: {
      current_version: v,
      ...(now.lastWriter ? { last_writer: now.lastWriter } : {}),
      ...(now.storeId ? { page_id: now.storeId } : {}),
      next_step: next,
    },
  }
}

/**
 * A stale write (the page moved past expected_version, or the slug holds a different page). The store's 409
 * body is NOT echoed: we re-read the page and decide visibility with the READ path's predicate, then show
 * only what that re-read says. A page that is not ours, or is squad-tier for a caller without squad access,
 * falls back to the generic refusal so a stale answer never names a hidden page's version or last writer.
 */
async function staleFailure(
  port: PagesPort,
  projectId: string,
  slug: string,
  sentVersion: number | undefined,
  canSeeSquadPages: boolean,
  storeSaidReplaced = false,
): Promise<PageFailure> {
  const now = await port.get(projectId, slug)
  if (!now || !now.envelope) return SLUG_UNAVAILABLE
  if (hiddenSquadPage(now, canSeeSquadPages)) return SLUG_UNAVAILABLE
  return staleFromPage(now, sentVersion, storeSaidReplaced)
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
