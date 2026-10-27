// src/pages/port.ts — PagesPort: the provider-agnostic seam for agent-written TEXT records
// (Hadi 2026-10-15: "our world is made by text"; text is the store of record, engrams/vectors are
// derived indexes). Follows the Office add-on template: a narrow interface + typed refusals here,
// a default adapter (Inkwell wiki, ./inkwell-adapter.ts), and the MCP tools as thin wrappers
// (src/mcp/pages.ts) over src/pages/service.ts. A future adapter (merged Inkwell store, gbrain,
// mem0, hosted pages) implements PagesPort and changes nothing above it.
//
// v2 adds an OPTIONAL markdown `body` (bounded by MAX_BODY_BYTES; refused over the cap, never truncated)
// and listBacklinks. A body is a capability of the adapter (`supportsBody`): an adapter whose store cannot
// hold one (the Inkwell wiki store until inkwell-api stores bodies) refuses a non-empty body with the typed
// `body_unsupported` failure instead of silently dropping it. mupot keeps ALL access control (project read/
// write, squad-tier visibility, in src/pages/service.ts); an adapter stores and returns text only.

export const PAGE_TIERS = ['project', 'squad'] as const
export type PageTier = (typeof PAGE_TIERS)[number]

/** Provenance the SERVER stamps. Never accepted from a client; an adapter must round-trip it. */
export interface PageEnvelope {
  /** First writer of the page; preserved on every update. */
  owner: string
  /** Latest writer. */
  writer: string
  tier: PageTier
  /** Why this text exists (kebab, 3-32). Required input, validated. */
  purpose: string
  /** Monotonic per-page counter, server-stamped. */
  version: number
  /** ISO-8601, server clock. */
  writtenAt: string
}

export interface PageLink {
  toSlug: string
  relation?: string
}

export interface PageRecord {
  slug: string
  title: string
  summary: string
  /** Markdown body (v2). undefined = the page has none or this adapter cannot store one. */
  body?: string
  /** Caller tags only (envelope stamps are NOT mixed in). */
  tags: string[]
  /** Raw store stamps, including incomplete envelopes, for fail-closed visibility checks. */
  rawTags?: string[]
  links: PageLink[]
  /** null = a page this port did not write (no envelope), e.g. the dashboard card or admin content. */
  envelope: PageEnvelope | null
}

export interface PagePutInput {
  slug: string
  title: string
  summary: string
  /** Markdown body. undefined = leave the stored body unchanged; a string (incl. '') replaces it. */
  body?: string
  tags: string[]
  links: PageLink[]
  envelope: PageEnvelope
}

/** A page that links TO the requested slug. `tier` is null for a page this port did not stamp. */
export interface PageBacklink {
  slug: string
  title: string
  relation?: string
  tier: PageTier | null
}

export interface PagePutResult {
  slug: string
  created: boolean
  linksWritten: number
}

export type PagesFailureKind = 'unavailable' | 'rejected' | 'conflict' | 'unsupported'

/** The one error shape an adapter throws. `code` is a short safe enum, never an upstream body. */
export class PagesPortError extends Error {
  constructor(
    public readonly kind: PagesFailureKind,
    public readonly code: string,
  ) {
    super(`${kind}:${code}`)
    this.name = 'PagesPortError'
  }
}

export interface PagesPort {
  /** Adapter id, e.g. 'inkwell-wiki'. */
  readonly id: string
  /** true when put() can store `body`. false = put() throws PagesPortError('unsupported', 'body_unsupported') for a non-empty body. */
  readonly supportsBody: boolean
  /** null exactly when the page does not exist (or is not visible to the service path). */
  get(projectId: string, slug: string): Promise<PageRecord | null>
  /**
   * Create-or-update by (project, slug). CONTRACT NOTES every adapter inherits:
   *  - LINKS ARE ADDITIVE: put adds the given links and NEVER removes links written earlier; a link is
   *    identified by (from, to, relation), so re-putting the same target with a different relation adds a
   *    second link. There is no removal in v1.
   *  - NO COMPARE-AND-SWAP: two concurrent puts both succeed, last writer wins the text, and their stamped
   *    versions can repeat or land out of order. The version counter only guarantees the NEXT stamp advances.
   *  - Text is normalised by the store (whitespace runs collapse to one space); callers pre-normalise.
   *  - An update must not change publication state, and must not touch a page the caller did not stamp
   *    (the service enforces the latter from the envelope returned by get).
   */
  put(projectId: string, input: PagePutInput): Promise<PagePutResult>
  /**
   * Pages in the project that link to `slug`, any tier. Raw: the adapter does NOT filter by caller (it has no
   * notion of one); the service drops squad-tier sources the caller may not see.
   */
  listBacklinks(projectId: string, slug: string): Promise<PageBacklink[]>
}

// ── validation (pure; the service calls these BEFORE any I/O) ───────────────────────────────────

export const PAGE_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/ // lowercase kebab, 3-63 (the wiki client's own cap)
/** Slugs an agent can never write: the dashboard's deterministic card and mupot/system namespaces. */
export const RESERVED_SLUG_PREFIXES: readonly string[] = ['project-card-', 'mupot-', 'system-']
// <= 32: the store cuts topic_type (where the adapter keeps purpose) at 32 characters.
export const PURPOSE_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/
export const MAX_TITLE = 120
export const MIN_TITLE = 2
export const MAX_SUMMARY = 500
export const MAX_USER_TAGS = 7
export const MAX_TAG_LEN = 40
export const MAX_LINKS = 20
/** Markdown body cap in UTF-8 BYTES. Over the cap is refused, never truncated. */
export const MAX_BODY_BYTES = 64 * 1024
/** Tag prefixes the adapter uses to stamp the envelope; a caller tag with one is refused (forgery). */
export const ENVELOPE_TAG_PREFIXES: readonly string[] = ['owner:', 'tier:', 'v:', 'by:', 'at:']

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUG_PREFIXES.some((prefix) => slug.startsWith(prefix))
}

export function isPageTier(v: unknown): v is PageTier {
  return typeof v === 'string' && (PAGE_TIERS as readonly string[]).includes(v)
}
