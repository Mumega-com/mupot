// mcpwp.ts — S4/#370: the WordPress ACT executor adapter (2nd pluggable CMS sink).
//
// PURE + FAIL-CLOSED. Given a resolved config { siteUrl, username, appPassword } and
// the STORED proposal payload, POSTs one content write to the WordPress REST API
// (wp-json/wp/v2/posts, application-password Basic auth) and returns the created
// artifact. No env access, no connector decrypt, no DB — those happen at the Worker
// boundary which resolves the connector credential (Hadi-go) and passes the narrow
// config in. Structural twin of executors/inkwell.ts — same purity, same fail-closed
// discipline, same SSRF guard.
//
// FOLLOW-UP (explicitly out of scope, #370): routing this through the mumcp MCP
// server (the MCPWP WordPress plugin's 250+ tool surface) instead of the bare
// WordPress REST API. mumcp is a separate repo and MCP isn't cleanly callable
// mid-request from a Worker today — this adapter targets the universal,
// dependency-free `wp-json/wp/v2/posts` endpoint instead. When an MCP-callable
// path exists, this adapter can be swapped or extended without touching the
// ExecutorPort contract or the kernel dispatch site.

import { assertPublicHttpsUrl } from '../../lib/ssrf'

export interface WpExecutorConfig {
  /** WordPress site origin, e.g. https://example.com (https, public host). */
  siteUrl: string
  /** WordPress application-password username (Basic auth). */
  username: string
  /** WordPress application password (Basic auth secret). Per-pot 'mcpwp' connector. */
  appPassword: string
}

export interface WpWriteResult {
  ok: true
  postId: number
  artifactUrl: string
}

/** Body accepted by WordPress's POST /wp-json/wp/v2/posts. */
interface WpPostBody {
  title: string
  content: string
  status: 'draft'
}

/**
 * Map an opaque stored proposal payload to a WP post body. Returns null when the
 * required fields (title + content) are absent — the caller must fail-closed.
 * status is ALWAYS forced to 'draft' — this adapter never auto-publishes live,
 * matching inkwell's server-forced-draft discipline (toPublishBody in inkwell.ts).
 */
export function toWpPostBody(payload: unknown): WpPostBody | null {
  if (payload === null || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  const title = typeof p.title === 'string' ? p.title.trim() : ''
  const content = typeof p.content === 'string' ? p.content : ''
  if (!title || !content) return null
  return {
    title,
    content,
    // Forced — never take a caller/payload-supplied status. Never auto-publish live.
    status: 'draft',
  }
}

/**
 * Build a WpExecutorConfig from a resolved connector's secret (the WordPress
 * application password — the actual credential) and its non-secret `meta` field
 * (JSON `{ siteUrl, username }`), mirroring the Telegram connector's
 * secret+meta split (src/connectors/service.ts telegramAllowedChats). Pure — no
 * decrypt, no D1, no env. Returns null (fail-closed) when meta is missing,
 * unparsable, or lacks siteUrl/username as strings.
 */
export function parseWpConnectorConfig(secret: string, meta: string | null): WpExecutorConfig | null {
  if (!secret || !meta) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(meta)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const m = parsed as Record<string, unknown>
  if (typeof m.siteUrl !== 'string' || !m.siteUrl || typeof m.username !== 'string' || !m.username) {
    return null
  }
  return { siteUrl: m.siteUrl, username: m.username, appPassword: secret }
}

export class WpExecutorError extends Error {
  constructor(public readonly reason: string, message?: string) {
    super(message ?? reason)
    this.name = 'WpExecutorError'
  }
}

// SSRF guard — same hardened private-host blocker as inkwell.ts / the PostHog CRO
// connector (src/lib/ssrf.ts). siteUrl is config-sourced (not payload) today, but the
// executor must not be steerable to an internal/loopback/cloud-metadata target by a
// misconfigured or hostile connector config.
function assertSafeSiteUrl(siteUrl: string): URL {
  try {
    return assertPublicHttpsUrl(siteUrl)
  } catch (e) {
    const code = e instanceof Error ? e.message : 'url_unparseable'
    const detail =
      code === 'url_not_https'
        ? 'siteUrl must be https'
        : code === 'url_private_host'
          ? 'siteUrl host is private/internal'
          : 'siteUrl is not a valid URL'
    throw new WpExecutorError('mcpwp_bad_siteurl', detail)
  }
}

/**
 * Write one content artifact to WordPress via wp-json/wp/v2/posts. Throws
 * WpExecutorError (fail-closed) on missing config, unmappable payload, or a
 * non-ok response. `fetchImpl` is injectable for tests.
 *
 * Leak-safe: no error path or return value ever includes appPassword. The
 * Authorization header is built once, used once, and never logged.
 */
export async function wpContentWrite(
  cfg: WpExecutorConfig,
  payload: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<WpWriteResult> {
  if (!cfg || !cfg.siteUrl || !cfg.username || !cfg.appPassword) {
    throw new WpExecutorError('mcpwp_not_configured', 'missing siteUrl, username, or appPassword')
  }
  const base = assertSafeSiteUrl(cfg.siteUrl)
  const body = toWpPostBody(payload)
  if (!body) {
    throw new WpExecutorError('invalid_payload', 'stored payload lacks title/content')
  }

  // Basic auth per WordPress application-password scheme. Built once, used once,
  // never returned or logged — a leaked auth header would leak appPassword.
  const authHeader = `Basic ${btoa(`${cfg.username}:${cfg.appPassword}`)}`

  let res: Response
  try {
    res = await fetchImpl(`${base.origin}/wp-json/wp/v2/posts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: authHeader,
      },
      body: JSON.stringify(body),
      // SSRF defense-in-depth (LOW-1, adversarial gate): assertSafeSiteUrl only
      // validates siteUrl at PARSE time. Without redirect:'manual', a default
      // 'follow' fetch would silently chase a 3xx from cfg.siteUrl to an
      // arbitrary Location — including an internal host — and this function would
      // never see it (it only inspects the FINAL response). redirect:'manual'
      // stops at the first hop so the check below can refuse it outright.
      redirect: 'manual',
    })
  } catch {
    // Do not interpolate the raw error — it may echo the request (incl. auth header
    // in some fetch implementations' error strings). Stable, leak-safe reason only.
    throw new WpExecutorError('mcpwp_unreachable', 'fetch to WordPress site failed')
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
    throw new WpExecutorError('mcpwp_redirect_blocked', 'refusing to follow a redirect from siteUrl')
  }

  if (!res.ok) {
    throw new WpExecutorError('mcpwp_http_error', `status ${res.status}`)
  }
  const json = (await res.json().catch(() => null)) as { id?: number; link?: string } | null
  if (!json || typeof json.id !== 'number' || typeof json.link !== 'string' || !json.link) {
    throw new WpExecutorError('mcpwp_bad_response', 'response missing id/link')
  }
  return { ok: true, postId: json.id, artifactUrl: json.link }
}
