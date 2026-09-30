// Request shaping for the OAuthProvider -> mcpApp internal boundary.
// mcpApp is mounted at /mcp in the public Hono app, but the OAuthProvider calls
// McpOAuthApiHandler directly. Re-root the request before dispatching to mcpApp.

import type { AuthContext } from '../types'
import { AUTH_CONTEXT_HEADER } from './auth-header'
import { NEEDS_YOU_PROFILE_PATH } from './profile-needs-you'

export function mcpInternalRequest(request: Request, auth: AuthContext): Request {
  const url = new URL(request.url)
  // Every /mcp* path re-roots to '/' EXCEPT the one curated profile door, whose sub-path must
  // survive so mcpApp can route it to the read-only profile handler. Exact match only: a
  // prefix/lookalike ('/mcp/profile/needs-you/x') still re-roots to '/', i.e. to the full /mcp.
  url.pathname = url.pathname === NEEDS_YOU_PROFILE_PATH ? '/profile/needs-you' : '/'

  const headers = new Headers(request.headers)
  headers.set(AUTH_CONTEXT_HEADER, JSON.stringify(auth))

  const body = request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    body,
  }
  // Node's Fetch requires this when Vitest forwards a ReadableStream; Workers
  // accepts the field and continues to stream the original request body.
  if (body) init.duplex = 'half'
  return new Request(url.toString(), init)
}
