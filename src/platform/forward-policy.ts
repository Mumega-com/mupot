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
//                    (`cf-access-*`, `x-mupot-*`, `proxy-authorization`, `mcp-session-id`)
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

const OWN_ORIGIN_DENIED_HEADERS: ReadonlySet<string> = new Set([
  'proxy-authorization',
  'mcp-session-id',
])
const OWN_ORIGIN_DENIED_PREFIXES: readonly string[] = ['cf-access-', 'x-mupot-']

/** Colony identity/credential headers: everything own-origin denies, plus cookie + authorization. */
export function isColonyCredentialHeader(rawName: string): boolean {
  const name = rawName.toLowerCase()
  return (
    name === 'cookie' ||
    name === 'authorization' ||
    OWN_ORIGIN_DENIED_HEADERS.has(name) ||
    OWN_ORIGIN_DENIED_PREFIXES.some((prefix) => name.startsWith(prefix))
  )
}

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
  }
  if (hasBody) {
    init.body = request.body
    init.duplex = 'half' // streaming request bodies require half duplex
  }
  return new Request(url.toString(), init)
}

/**
 * A user Worker answering on the colony's origin must not be able to set cookies there:
 * a `Set-Cookie` could shadow or fixate the colony's host-only `mupot_session`.
 * Returns the response unchanged when it carries none.
 */
export function stripResponseCookies(response: Response): Response {
  if (!response.headers.has('set-cookie')) return response
  const headers = new Headers(response.headers)
  headers.delete('set-cookie')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
