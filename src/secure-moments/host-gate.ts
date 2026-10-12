// mupot — host gate for secure moments. Runs as the FIRST statement of the Worker's fetch.
//
//   - on the dedicated secure host (SECURE_MOMENTS_HOST) ONLY /m/* is served; every other path is a 404
//     here, before any other handler (tenant routing, hostname dispatch, MCP, preview, dashboard) is reached;
//   - /m/* on any other host is a 404, in every spelling (percent-encoded, trailing dot, case);
//   - flag off, or misconfigured host: /m/* is a 404 on every host and nothing is served on any host.
// The /m app is NEVER mounted in the main app: it is reachable only through this gate, so no other host can
// ever route to it. Contract: docs/architecture/secure-moments.md.
import type { Env } from '../types'
import { secureMomentsStatus } from './config'

const NOT_FOUND = (): Response =>
  new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' } })

export function isMomentPath(pathname: string): boolean {
  return pathname === '/m' || pathname.startsWith('/m/')
}

function safeDecode(fn: (s: string) => string, p: string): string {
  try {
    return fn(p)
  } catch {
    return p
  }
}

/** Every spelling the router could end up matching as /m: raw, decodeURI, decodeURIComponent, decoded twice. */
function looksLikeMoments(pathname: string): boolean {
  const once = safeDecode(decodeURIComponent, pathname)
  const twice = safeDecode(decodeURIComponent, once)
  return [pathname, safeDecode(decodeURI, pathname), once, twice].some(isMomentPath)
}

/** Lower-case host with any trailing root dot removed (`secure.example.` names the same host as `secure.example`). */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.(?=(:\d{1,5})?$)/, '')
}

/**
 * 'moments' = serve the secure-moments app DIRECTLY and nothing else (the caller must not fall through to any
 * other handler). A Response = return it immediately. null = not the secure host and not /m: normal pipeline.
 */
export function secureMomentsHostGate(req: Request, env: Env): Response | 'moments' | null {
  const url = new URL(req.url)
  const status = secureMomentsStatus(env)
  const momentish = looksLikeMoments(url.pathname)
  // Not usable (flag off or misconfigured): /m/* exists nowhere, and nothing is hosted anywhere special.
  if (status.state !== 'on') return momentish ? NOT_FOUND() : null
  if (normalizeHost(url.host) === status.host) {
    // On the secure host only the LITERAL /m/* spelling is served; an encoded spelling is refused outright.
    return isMomentPath(url.pathname) ? 'moments' : NOT_FOUND()
  }
  return momentish ? NOT_FOUND() : null
}
