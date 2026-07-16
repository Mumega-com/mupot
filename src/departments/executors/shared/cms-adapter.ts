// shared/cms-adapter.ts — #370 Slice A: the CMS-agnostic content-write PORT.
//
// PURE REFACTOR, NOT NEW BEHAVIOR. Hoisted verbatim (logic-for-logic) out of
// executors/inkwell.ts's fetch-then-merge CRO apply-bridge (S5b): fetchInkwellContent,
// mergeContentUpdate, inkwellContentApplyWrite, and the redirect-refusing fetch wrapper
// never actually referenced anything inkwell-specific in their CORE logic — they operate
// on a generic {title, description, content, status} shape and a
// changeType/value/findText change request. That's what makes this hoist safe: the shape
// was already CMS-agnostic, only the surrounding types had inkwell's name on them.
//
// This is the shape that proves the microkernel: inkwell today, WP/Strapi/etc tomorrow,
// all interchangeable behind ONE port (CmsAdapter) + ONE orchestrator
// (cmsContentApplyWrite). executors/inkwell.ts is now a thin CmsAdapter implementation
// over this module — see that file's header for the wiring.
//
// SLICE B (pending, NOT this slice, coordinate with codex's addon-framework branch):
// collapsing the inkwell/mcpwp dispatch branches in kernel.ts into a single
// CMS_ADAPTERS registry lookup. mcpwp.ts has no fetch-then-merge path yet — this slice
// does not add one, and does not touch mcpwp.ts or kernel.ts's mcpwp dispatch branch.

import type { CroChangeType } from '../../change-types'

// ── Port surface ─────────────────────────────────────────────────────────────

/** Opaque per-adapter config shape — each adapter defines + validates its own concrete type. */
export type CmsAdapterConfig = Record<string, unknown>

/**
 * The current article's editable fields, as read back from a CMS. `ref` is the
 * adapter-specific identifier used to re-address the same content on write (an Inkwell
 * slug today). `raw` is an escape hatch for fields the shared merge logic below doesn't
 * need but a concrete adapter's write body does (e.g. Inkwell's author/tags) — keeps
 * this type CMS-agnostic without forcing every future adapter's extra fields into it.
 */
export interface FetchedContent {
  ref: string
  /** Adapter-specific content-type discriminator (post/page/...); most adapters can ignore it. */
  kind?: string
  title: string
  description: string
  content: string
  status: string
  raw?: Record<string, unknown>
}

/** A single targeted-field change request (mirrors CroApplyMergePayload's shape, minus the storage envelope). */
export interface CmsChangeRequest {
  changeType: CroChangeType
  /** The new value for the targeted field (or the replacement text for a substring change). */
  value: string
  /** REQUIRED for substring-replace change-types (e.g. cta_text/internal_links) — see mergeByChangeType. */
  findText?: string
}

/** Records the audit-trail diff a CMS write produced — the RECEIPT's payload. */
export interface ContentMergeDiff {
  changeType: CroChangeType
  field: 'title' | 'description' | 'content'
  before: string
  after: string
}

export interface CmsWriteResult {
  ok: true
  url: string
}

/**
 * One CMS integration, implementing fetch/merge/write over its own concrete config +
 * write-body + write-result shapes. `write`'s declared return only needs the port's
 * minimal contract (`ok: true` + `url`) — a concrete adapter MAY return additional
 * fields (Inkwell's `slug`); cmsContentApplyWrite below preserves whatever it returns.
 */
export interface CmsAdapter<
  TConfig = CmsAdapterConfig,
  TBody = unknown,
  TWriteResult extends CmsWriteResult = CmsWriteResult,
> {
  /**
   * FAIL-CLOSED: throws on any config/network/malformed-response problem. Returns
   * null ONLY for a genuine "not found" (e.g. a 404) — never a partial/blank result
   * to paper over a failure. The orchestrator treats null as "cannot merge, refuse
   * to write", never as "start from empty".
   */
  fetchCurrent(cfg: TConfig, ref: string): Promise<FetchedContent | null>
  /** PURE — no I/O. Throws (fail-closed) for an ambiguous/absent findText target. */
  applyChange(current: FetchedContent, change: CmsChangeRequest): { body: TBody; diff: ContentMergeDiff }
  write(cfg: TConfig, ref: string, body: TBody): Promise<TWriteResult>
}

/** Base error class for adapters that don't want their own subclass. Adapters with an existing error class (InkwellExecutorError, WpExecutorError) keep using it directly — this exists for future adapters only. */
export class CmsAdapterError extends Error {
  constructor(
    public readonly reason: string,
    message?: string,
  ) {
    super(message ?? reason)
    this.name = 'CmsAdapterError'
  }
}

// ── Shared orchestrator ───────────────────────────────────────────────────────

/**
 * The full fetch-then-merge write, generic over any CmsAdapter: read the current
 * content (fail-closed on any fetch problem or "not found"), apply ONLY the targeted
 * field via adapter.applyChange, and write the merged whole back. `makeNotFoundError`
 * lets each adapter throw its OWN error class/reason (e.g.
 * InkwellExecutorError('merge_source_not_found', ...)) so existing callers doing
 * `instanceof <AdapterError>` (kernel.ts, tests) keep working unchanged.
 *
 * = today's executors/inkwell.ts inkwellContentApplyWrite, generalized over the adapter.
 */
export async function cmsContentApplyWrite<TConfig, TBody, TWriteResult extends CmsWriteResult>(
  adapter: CmsAdapter<TConfig, TBody, TWriteResult>,
  cfg: TConfig,
  ref: string,
  change: CmsChangeRequest,
  makeNotFoundError: (ref: string) => Error,
): Promise<TWriteResult & { diff: ContentMergeDiff }> {
  // FAIL-CLOSED FETCH-THEN-MERGE: a thrown fetch error propagates as-is; a "not
  // found" (null) refuses explicitly. Neither path reaches the write call below —
  // there is no code path from "could not read current content" to "write anyway".
  const current = await adapter.fetchCurrent(cfg, ref)
  if (!current) {
    throw makeNotFoundError(ref)
  }
  const { body, diff } = adapter.applyChange(current, change)
  const written = await adapter.write(cfg, ref, body)
  return { ...written, diff }
}

// ── Shared pure merge helper ────────────────────────────────────────────────

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let idx = 0
  for (;;) {
    const found = haystack.indexOf(needle, idx)
    if (found === -1) break
    count += 1
    idx = found + needle.length
  }
  return count
}

/**
 * Apply ONE targeted field change onto `current`'s title/description/content, folding
 * the result into `base` (the adapter's other write-body fields, e.g. Inkwell's
 * slug/author/tags/status/overwrite) to produce the full body. PURE — no I/O, no
 * throw on the happy path; throws via `makeError` only for an ambiguous/absent
 * substring-replace target (fail-closed: an ambiguous edit target must never
 * silently pick "the first match").
 *
 * = today's executors/inkwell.ts mergeContentUpdate, generalized: the
 * title/description/content branch logic never referenced anything inkwell-specific,
 * so it hoists verbatim; only the "other fields" (`base`) are now adapter-supplied
 * instead of an inline PublishBody literal.
 */
export function mergeByChangeType<TBase extends Record<string, unknown>>(
  base: TBase,
  current: Pick<FetchedContent, 'title' | 'description' | 'content'>,
  change: CmsChangeRequest,
  makeError: (reason: string, message: string) => Error,
): { body: TBase & { title: string; description: string; content: string }; diff: ContentMergeDiff } {
  // meta_title / headline: both target the CMS's single `title` field — see
  // change-types.ts SCHEMA NOTE for why these two change-types collide on one field.
  // The article body and every other field pass through UNTOUCHED.
  if (change.changeType === 'meta_title' || change.changeType === 'headline') {
    return {
      body: { ...base, title: change.value, content: current.content, description: current.description },
      diff: { changeType: change.changeType, field: 'title', before: current.title, after: change.value },
    }
  }

  if (change.changeType === 'meta_description') {
    return {
      body: { ...base, title: current.title, content: current.content, description: change.value },
      diff: {
        changeType: change.changeType,
        field: 'description',
        before: current.description,
        after: change.value,
      },
    }
  }

  // body_copy: an intentional, full replace of the article body — this IS the whole
  // field the change-type names (title/description/other base fields all pass through
  // from `current`/`base` untouched).
  if (change.changeType === 'body_copy') {
    return {
      body: { ...base, title: current.title, content: change.value, description: current.description },
      diff: { changeType: change.changeType, field: 'content', before: current.content, after: change.value },
    }
  }

  // cta_text / internal_links (and any other change-type): a substring replace
  // WITHIN the body (no separate field exists for either — see change-types.ts
  // SCHEMA NOTE). Fail-closed on an absent or ambiguous target: never guess which
  // occurrence, never no-op silently.
  if (!change.findText) {
    throw makeError(
      'merge_target_missing',
      `${change.changeType} requires findText (the current substring to replace)`,
    )
  }
  const occurrences = countOccurrences(current.content, change.findText)
  if (occurrences === 0) {
    throw makeError('merge_target_not_found', `${change.changeType}: findText not present in the current article body`)
  }
  if (occurrences > 1) {
    throw makeError(
      'merge_target_ambiguous',
      `${change.changeType}: findText matches ${occurrences} locations in the body — refusing an ambiguous replace`,
    )
  }
  // Function replacer (never a string replacer): a string second argument to
  // String.replace interprets $$, $&, $`, $' as special replacement patterns —
  // change.value is caller/agent-composed content, not a regex-replacement template,
  // so a value containing e.g. '$$' or '$`' would silently get pattern-expanded,
  // corrupting the written body AND desyncing the receipt (the receipt records the
  // raw change.value in `diff.after`, but the article would carry the expanded
  // string — an audit-integrity violation, canonical sensitive surface #3: audit
  // chain integrity). A function replacer returns its value verbatim, no pattern
  // interpretation, so what's written always equals what the receipt records.
  const mergedContent = current.content.replace(change.findText, () => change.value)
  return {
    body: { ...base, title: current.title, content: mergedContent, description: current.description },
    diff: { changeType: change.changeType, field: 'content', before: change.findText, after: change.value },
  }
}

// ── Shared redirect-refusing fetch wrapper ──────────────────────────────────

export interface CmsFetchInit {
  method: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
}

/**
 * Fetch precedence shared by every adapter: an explicit fetchImpl (tests) wins;
 * otherwise a same-zone service-binding Fetcher (avoids a public-edge loopback → CF
 * 522) when present; else global fetch.
 */
export function resolveCmsFetch(fetcher: Fetcher | undefined, fetchImpl?: typeof fetch): typeof fetch {
  return fetchImpl ?? (fetcher ? (fetcher.fetch.bind(fetcher) as typeof fetch) : fetch)
}

/**
 * Shared low-level request: performs the fetch with `redirect: 'manual'` and refuses
 * any redirect outright (SSRF defense-in-depth — the caller's own URL validation,
 * e.g. assertPublicHttpsUrl, only validates the origin at PARSE time; without this, a
 * default 'follow' fetch would silently chase a 3xx to an arbitrary Location,
 * including an internal host, and the caller would never see it). Covers both the
 * explicit 3xx-status shape (real Workers runtime) and the browser-style
 * opaqueredirect shape (status 0, type 'opaqueredirect' — what a mocked Response
 * carries under vitest/undici). Never follows a redirect, never retries. Errors are
 * raised via the caller-supplied factories so each adapter keeps its own error
 * class/reason vocabulary (e.g. InkwellExecutorError('inkwell_unreachable', ...)).
 */
export async function cmsFetch(
  origin: string,
  doFetch: typeof fetch,
  path: string,
  init: CmsFetchInit,
  errors: {
    unreachable: (detail: string) => Error
    redirectBlocked: () => Error
  },
): Promise<Response> {
  let res: Response
  try {
    res = await doFetch(`${origin}${path}`, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      redirect: 'manual',
    })
  } catch (e) {
    throw errors.unreachable(String(e))
  }

  // `as string`: @cloudflare/workers-types narrows Response.type to "default"|"error"
  // (Workers' redirect:'manual' never produces an opaque redirect — it returns the
  // real 3xx), but this file also runs under vitest/undici in tests, where a mocked
  // Response can carry 'opaqueredirect'. Widen the comparison rather than the type.
  const resType = res.type as string
  if (resType === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    throw errors.redirectBlocked()
  }
  return res
}
