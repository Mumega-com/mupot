// Canonical request path for the routes the OAuth provider owns.
//
// The OAuth provider matches its routes on the RAW URL path; the Hono app behind it
// percent-decodes the path before routing. A request whose raw path is not one the provider
// owns, but whose decoded form is, would therefore be routed by Hono without the provider
// ever seeing it. This module names the provider-owned routes in ONE place (index.ts builds
// the provider config from the same list) and refuses any request whose path only reaches a
// provider-owned route after normalisation. Canonical requests are untouched.
//
// Refusal (400) rather than redirect: no legitimate client sends a non-canonical form of these
// routes, a redirect would have to re-issue a POST body, and a canonicalising rewrite would
// make this guard a second router that has to agree with Hono forever.
//
// Pure module: no Workers runtime imports, so it is unit-testable and importable anywhere.

/** Path prefixes the OAuth provider authenticates (its `apiRoute`). Prefix match, like the provider. */
export const OAUTH_API_ROUTES: readonly string[] = ['/mcp']

/** Paths the provider answers itself, exact match (the discovery prefix also matches its sub-paths). */
const OAUTH_ENDPOINTS: readonly string[] = ['/token', '/register', '/.well-known/oauth-authorization-server']
const OAUTH_RESOURCE_METADATA = '/.well-known/oauth-protected-resource'

/** A path the provider handles itself, judged exactly as the provider judges it (raw, case-sensitive). */
export function providerOwnsPath(pathname: string): boolean {
  if (OAUTH_API_ROUTES.some((route) => pathname.startsWith(route))) return true
  if (OAUTH_ENDPOINTS.includes(pathname)) return true
  return pathname === OAUTH_RESOURCE_METADATA || pathname.startsWith(`${OAUTH_RESOURCE_METADATA}/`)
}

const MAX_DECODE_ROUNDS = 4

/** Decode %XX escapes byte by byte (ASCII only), so one malformed escape elsewhere cannot stop the rest. */
function decodeAsciiEscapes(value: string): string {
  return value.replace(/%([0-9a-f]{2})/gi, (whole, hex: string) => {
    const code = parseInt(hex, 16)
    return code < 0x80 ? String.fromCharCode(code) : whole
  })
}

/** The path as a lenient router could read it: fully decoded, separators folded, dot segments
 *  resolved, params dropped, lower-cased, and with a `/t/<tenant>` address prefix removed. */
export function lenientPath(pathname: string, resolveDots = true): string {
  let current = pathname
  for (let i = 0; i < MAX_DECODE_ROUNDS; i++) {
    const next = decodeAsciiEscapes(current)
    if (next === current) break
    current = next
  }
  const segments: string[] = []
  for (const raw of current.replace(/\\/g, '/').replace(/;[^/]*/g, '').split('/')) {
    if (raw === '' || raw === '.') continue
    if (raw === '..' && resolveDots) segments.pop()
    else segments.push(raw.toLowerCase())
  }
  if (segments[0] === 't' && segments.length > 1) segments.splice(0, 2)
  return `/${segments.join('/')}`
}

/** The path with a leading `/t/<tenant>` address removed, as the entry point strips it before the provider runs. */
function afterTenantAddress(pathname: string): string {
  const m = /^\/t\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?(\/.*)?$/i.exec(pathname)
  if (!m) return pathname
  return m[1] && m[1].length > 0 ? m[1] : '/'
}

/** True when this path would reach a provider-owned route only after normalisation. */
export function isNonCanonicalProviderPath(pathname: string): boolean {
  if (providerOwnsPath(afterTenantAddress(pathname))) return false
  // Three readings, any of which landing on an owned route is enough: dots resolved, dots kept as literal
  // segments (Hono never resolves them), and Hono's own decode (decodeURI) of the address-stripped path.
  return providerOwnsPath(lenientPath(pathname)) || providerOwnsPath(lenientPath(pathname, false)) || providerOwnsPath(honoRoutedPath(pathname))
}

/** The path Hono routes on for the address-stripped request: decodeURI, per-chunk fallback on malformed escapes. */
function honoRoutedPath(pathname: string): string {
  const stripped = afterTenantAddress(pathname)
  try {
    return decodeURI(stripped)
  } catch {
    return stripped.replace(/(?:%[0-9a-f]{2})+/gi, (chunk) => {
      try {
        return decodeURI(chunk)
      } catch {
        return chunk
      }
    })
  }
}

/** 400 for a non-canonical provider path, else null. Call before any routing. */
export function refuseNonCanonicalPath(request: Request): Response | null {
  if (!isNonCanonicalProviderPath(new URL(request.url).pathname)) return null
  return new Response(JSON.stringify({ error: 'non_canonical_path' }), {
    status: 400,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
