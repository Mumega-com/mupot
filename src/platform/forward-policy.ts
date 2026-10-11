// src/platform/forward-policy.ts — the ONE chokepoint for requests handed to a less-trusted
// Worker (a project / tenant user Worker in the dispatch namespace).
//
// Class: a proxy into less-trusted code must never carry the caller's ambient credentials.
// Cookies, Authorization and gateway identity headers belong to the colony origin; code that
// an agent can deploy must not receive them just because the browser attached them to a
// same-origin request.
//
// Two policies, chosen by who owns the origin the browser is talking to:
//
//   'colony-origin'  The request arrived on the colony's own origin (e.g. `/preview/:id/*`).
//                    Everything the browser attached is the COLONY's. ALLOW-LIST: only
//                    content-negotiation / caching / body-description headers pass.
//                    Allow-list (not deny-list) because an unknown future header, or a
//                    credential under a name nobody thought of, must fail closed.
//
//   'own-origin'     The request arrived on the user Worker's OWN hostname
//                    (`<project>.<root>`). Cookies/Authorization there were scoped by the
//                    browser to that hostname and are the Worker's own users' business, so
//                    they pass. DENY-LIST: colony/gateway identity headers
//                    (`cf-access-*`, `x-mupot-*`, `proxy-authorization`)
//                    are still dropped.
//
// Method, body (streamed, not buffered) and redirect mode are preserved by both.

export type ForwardPolicy = 'colony-origin' | 'own-origin'

const COLONY_ORIGIN_ALLOWED_HEADERS: ReadonlySet<string> = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'content-length',
  'content-type',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-unmodified-since',
  'origin',
  'pragma',
  'range',
  'referer',
  'user-agent',
  'x-requested-with',
])

// mcp-session-id is NOT denied here: on a project's own hostname only that project could
// have issued it. It stays out of the colony-origin allow-list (the colony uses it as a
// seat hint).
const OWN_ORIGIN_DENIED_HEADERS: ReadonlySet<string> = new Set(['proxy-authorization'])
const OWN_ORIGIN_DENIED_PREFIXES: readonly string[] = ['cf-access-', 'x-mupot-']

export function filterForwardHeaders(source: Headers, policy: ForwardPolicy): Headers {
  const out = new Headers()
  source.forEach((value, rawName) => {
    const name = rawName.toLowerCase()
    if (policy === 'colony-origin') {
      if (COLONY_ORIGIN_ALLOWED_HEADERS.has(name)) out.set(name, value)
      return
    }
    if (OWN_ORIGIN_DENIED_HEADERS.has(name)) return
    if (OWN_ORIGIN_DENIED_PREFIXES.some((prefix) => name.startsWith(prefix))) return
    out.set(name, value)
  })
  return out
}

/**
 * Build the Request handed to a user Worker: new URL, filtered headers, same method,
 * same (streamed) body, same redirect mode.
 */
export function buildForwardRequest(request: Request, url: URL, policy: ForwardPolicy): Request {
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD' && request.body !== null
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers: filterForwardHeaders(request.headers, policy),
    redirect: request.redirect,
    // Client disconnect must propagate to the user Worker.
    signal: request.signal,
    // Edge metadata (geo, bot score, colo) is not a credential; keep it under both policies.
    cf: request.cf,
  }
  if (hasBody) {
    init.body = request.body
    init.duplex = 'half' // streaming request bodies require half duplex
  }
  return new Request(url.toString(), init)
}

// ---- RESPONSE side ---------------------------------------------------------------------
//
// Content served by a user Worker on the colony origin runs with the colony's authority
// unless it is contained. Containment is two layers:
//
//  1. CSP `sandbox` WITHOUT allow-same-origin: the document gets an opaque origin, so its
//     fetch/XHR calls carry no colony cookies and document.cookie / storage / service
//     workers are unavailable to it. allow-same-origin must never be added here.
//  2. A response-header ALLOW-LIST: nothing outside the list below survives, so
//     set-cookie, service-worker-allowed, clear-site-data, refresh, link, access-control-*,
//     permissions-policy and any other header cannot act on the colony origin.

export const SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-popups'

const COLONY_ORIGIN_RESPONSE_HEADERS: readonly string[] = [
  'content-type',
  'content-length',
  'content-encoding',
  'content-language',
  'content-disposition',
  'content-range',
  'accept-ranges',
  'cache-control',
  'etag',
  'last-modified',
  'expires',
  'vary',
  'x-content-type-options',
]

export interface ColonyResponseContext {
  /** The ORIGINAL (colony-side) request URL, used to resolve a relative Location. */
  requestUrl: string
  /** Path prefix this proxy owns on the colony, e.g. `/preview/<id>/` or `/t/<slug>/`. */
  pathPrefix: string
}

/** A Location is kept when it is external (http/https, other origin) or inside the prefix. */
function safeLocation(value: string, ctx: ColonyResponseContext): string | null {
  let base: URL
  let target: URL
  try {
    base = new URL(ctx.requestUrl)
    target = new URL(value, base)
  } catch {
    return null
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return null
  if (target.origin !== base.origin) return value
  const prefix = ctx.pathPrefix.endsWith('/') ? ctx.pathPrefix : `${ctx.pathPrefix}/`
  const bare = prefix.slice(0, -1)
  return target.pathname === bare || target.pathname.startsWith(prefix) ? value : null
}

/**
 * Request-side guard: a request that is fetching a service-worker script through the
 * colony origin is refused outright (chosen over only relying on header removal so that
 * no script is ever served in a form a browser could register).
 */
export function refuseServiceWorkerScript(request: Request): Response | null {
  if (request.headers.get('service-worker') === null) return null
  return new Response(JSON.stringify({ error: 'service_worker_script_refused' }), {
    status: 403,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/** Rebuild a colony-origin response from the allow-list and add the sandbox CSP. */
export function sanitizeColonyOriginResponse(response: Response, ctx: ColonyResponseContext): Response {
  if (response.status === 101) {
    // A Response cannot be rebuilt around a WebSocket, and an upgraded socket would also
    // bypass the header policy. Not supported on the colony origin.
    return new Response(JSON.stringify({ error: 'upgrade_not_supported' }), {
      status: 501,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  }
  const headers = new Headers()
  for (const name of COLONY_ORIGIN_RESPONSE_HEADERS) {
    const value = response.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  const location = response.headers.get('location')
  if (location !== null) {
    const kept = safeLocation(location, ctx)
    if (kept !== null) headers.set('location', kept)
  }
  const ownCsp = response.headers.get('content-security-policy')
  headers.set('content-security-policy', ownCsp ? `${ownCsp}, ${SANDBOX_CSP}` : SANDBOX_CSP)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/**
 * Own-origin responses keep their cookies (they are the Worker's own), except any
 * Set-Cookie carrying a `Domain=` attribute: that could plant a cookie on the parent
 * (colony) domain. Those are dropped; host-only cookies pass. A 101 upgrade is returned
 * untouched (a WebSocket response cannot be rebuilt).
 */
export function sanitizeOwnOriginResponse(response: Response): Response {
  if (response.status === 101) return response
  // getSetCookie exists in workerd and Node 20+ but not in the pinned lib typings.
  const cookies = (response.headers as Headers & { getSetCookie(): string[] }).getSetCookie()
  if (cookies.length === 0) return response
  const kept = cookies.filter((cookie) => !/;\s*domain\s*=/i.test(cookie))
  if (kept.length === cookies.length) return response
  const headers = new Headers(response.headers)
  headers.delete('set-cookie')
  for (const cookie of kept) headers.append('set-cookie', cookie)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
