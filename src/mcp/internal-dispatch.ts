// Request shaping for the OAuthProvider -> mcpApp internal boundary.
// mcpApp is mounted at /mcp in the public Hono app, but the OAuthProvider calls
// McpOAuthApiHandler directly. Re-root the request before dispatching to mcpApp.

import type { AuthContext } from '../types'
import { AUTH_CONTEXT_HEADER } from './auth-header'
import { inProfileNamespace, NEEDS_YOU_PROFILE_PATH } from './profile-needs-you'

export function mcpInternalRequest(request: Request, auth: AuthContext): Request {
  const url = new URL(request.url)
  // Every /mcp* path re-roots to '/' (the full /mcp) EXCEPT the reserved /mcp/profile
  // namespace: the exact profile path keeps its sub-path so mcpApp routes it to the read-only
  // profile handler, and every OTHER path in the namespace ('/mcp/profile/needs-you/', '/x',
  // '/mcp/profile') is sent to a path mcpApp answers with 404 — never silently to the full
  // /mcp, which would hand a profile-configured connector 146 un-annotated tools.
  if (url.pathname === NEEDS_YOU_PROFILE_PATH) url.pathname = '/profile/needs-you'
  else if (inProfileNamespace(url.pathname)) url.pathname = '/profile/_not_found'
  else url.pathname = '/'

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
