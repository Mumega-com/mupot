// inkwell.ts — S4: the inkwell-content ACT executor adapter.
//
// PURE + FAIL-CLOSED. Given a resolved config { apiUrl, token } and the STORED
// proposal payload, POSTs one content write to the Inkwell API and returns the
// created artifact. No env access, no connector decrypt, no DB — those happen at
// the Worker boundary which resolves the connector credential (Hadi-go) and passes
// the narrow config in. This keeps the kernel pure + unit-testable, and means the
// adapter is inert unless the Worker explicitly supplies a credential.

import { assertPublicHttpsUrl } from '../../lib/ssrf'

export interface InkwellExecutorConfig {
  /** Inkwell API origin, e.g. https://inkwell-api.mumega.com (https, public host). */
  apiUrl: string
  /** Bearer secret for the internal pot-publish endpoint (per-pot 'inkwell' connector). */
  token: string
  /**
   * Pot tenant slug — sent EXPLICITLY in the body so inkwell-api writes to this
   * pot's draft area (the internal endpoint is tenant-explicit, not host-resolved).
   * The write is always a DRAFT (server-forced), pot-scoped.
   */
  tenantSlug: string
}

export interface InkwellWriteResult {
  ok: true
  slug: string
  url: string
}

/** Body accepted by Inkwell's POST /api/content/publish. */
interface PublishBody {
  title: string
  content: string
  slug?: string
  author: string
  tags: string[]
  description: string
  status: 'draft' | 'published' | 'archived'
  overwrite: boolean
}

/**
 * Map an opaque stored proposal payload to a publish body. Returns null when the
 * required fields (title + content) are absent — the caller must fail-closed.
 * Defaults are conservative: status 'draft' (never auto-publish), overwrite false.
 */
export function toPublishBody(payload: unknown): PublishBody | null {
  if (payload === null || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  const title = typeof p.title === 'string' ? p.title.trim() : ''
  const content = typeof p.content === 'string' ? p.content : ''
  if (!title || !content) return null
  const status = p.status === 'published' || p.status === 'archived' ? p.status : 'draft'
  return {
    title,
    content,
    slug: typeof p.slug === 'string' && p.slug ? p.slug : undefined,
    author: typeof p.author === 'string' && p.author ? p.author : 'mupot',
    tags: Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === 'string') : [],
    description: typeof p.description === 'string' ? p.description : '',
    status,
    overwrite: p.overwrite === true,
  }
}

export class InkwellExecutorError extends Error {
  constructor(public readonly reason: string, message?: string) {
    super(message ?? reason)
    this.name = 'InkwellExecutorError'
  }
}

// SSRF guard. apiUrl is config-sourced (not payload) today, but the executor must not be
// steerable to an internal / loopback / cloud-metadata target by a misconfigured or hostile
// config. The hardened private-host blocker (IPv4-mapped IPv6, ULA, link-local, CGNAT, IPv4
// evasions) now lives in src/lib/ssrf.ts and is shared with the PostHog CRO connector (#219).
// (DNS-rebind — a public name re-resolving to an internal IP at fetch — is out of scope for
// a parse-time check; mitigate with an origin allowlist if apiUrl ever becomes payload-driven.)
function assertSafeInkwellUrl(apiUrl: string): URL {
  try {
    return assertPublicHttpsUrl(apiUrl)
  } catch (e) {
    const code = e instanceof Error ? e.message : 'url_unparseable'
    const detail =
      code === 'url_not_https'
        ? 'apiUrl must be https'
        : code === 'url_private_host'
          ? 'apiUrl host is private/internal'
          : 'apiUrl is not a valid URL'
    throw new InkwellExecutorError('inkwell_bad_apiurl', detail)
  }
}

/**
 * Write one content artifact to Inkwell. Throws InkwellExecutorError (fail-closed)
 * on missing config, unmappable payload, or a non-ok response. `fetchImpl` is
 * injectable for tests.
 */
export async function inkwellContentWrite(
  cfg: InkwellExecutorConfig,
  payload: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<InkwellWriteResult> {
  if (!cfg || !cfg.apiUrl || !cfg.token || !cfg.tenantSlug) {
    throw new InkwellExecutorError('inkwell_not_configured', 'missing apiUrl, token, or tenantSlug')
  }
  const base = assertSafeInkwellUrl(cfg.apiUrl)
  const body = toPublishBody(payload)
  if (!body) {
    throw new InkwellExecutorError('invalid_payload', 'stored payload lacks title/content')
  }
  // tenant-explicit, pot-scoped, server-forced-draft internal endpoint.
  const internalBody = { ...body, tenant_slug: cfg.tenantSlug }

  let res: Response
  try {
    res = await fetchImpl(`${base.origin}/api/internal/content/publish`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.token}`,
        // Worker→Worker subrequests carry no default User-Agent; the mumega.com
        // zone WAF 403s (error 1010) a UA-less/bot-looking request, surfacing as
        // inkwell_http_error even with a valid secret + payload. An explicit UA
        // clears the managed rule (same fix the fleet report hook needed).
        'user-agent': 'mupot-executor/1.0',
      },
      body: JSON.stringify(internalBody),
      // SSRF defense-in-depth (LOW-1, adversarial gate, mupot#370 delta): assertSafeInkwellUrl
      // only validates apiUrl at PARSE time. Without redirect:'manual', a default 'follow'
      // fetch would silently chase a 3xx from cfg.apiUrl to an arbitrary Location — including
      // an internal host — and this function would never see it (it only inspects the FINAL
      // response). redirect:'manual' stops at the first hop so the check below can refuse it.
      redirect: 'manual',
    })
  } catch (e) {
    throw new InkwellExecutorError('inkwell_unreachable', String(e))
  }

  // Refuse any redirect outright — never follow. Covers both the explicit 3xx-status
  // shape (what Cloudflare Workers' fetch actually returns for redirect:'manual') and
  // the browser-style opaqueredirect shape (status 0, type 'opaqueredirect'), so this
  // holds regardless of runtime. No Location is ever read or logged — we don't need
  // it to refuse.
  // `as string`: @cloudflare/workers-types narrows Response.type to "default"|"error"
  // (Workers' redirect:'manual' never produces an opaque redirect — it returns the
  // real 3xx), but this file also runs under vitest/undici in tests, where a mocked
  // Response can carry 'opaqueredirect'. Widen the comparison rather than the type.
  const resType = res.type as string
  if (resType === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    throw new InkwellExecutorError('inkwell_redirect_blocked', 'refusing to follow a redirect from apiUrl')
  }

  if (!res.ok) {
    throw new InkwellExecutorError('inkwell_http_error', `status ${res.status}`)
  }
  const json = (await res.json().catch(() => null)) as { ok?: boolean; slug?: string; url?: string } | null
  if (!json || json.ok !== true || !json.slug || !json.url) {
    throw new InkwellExecutorError('inkwell_bad_response', 'response missing ok/slug/url')
  }
  return { ok: true, slug: json.slug, url: json.url }
}
