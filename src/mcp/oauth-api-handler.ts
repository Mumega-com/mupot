// mupot — OAuth MCP API handler adapter.
//
// The OAuthProvider calls this WorkerEntrypoint after validating an OAuth access
// token (primary door) or after resolveExternalToken validates a member API key
// (secondary door). Both paths converge here with `ctx.props` carrying an
// OAuthMemberProps object.
//
// Adapter responsibility (Q5 answer):
//   1. Read ctx.props (OAuthMemberProps).
//   2. Build a live AuthContext (capabilities re-resolved from D1 every request — C2).
//   3. Dispatch to the existing mcpApp Hono sub-app with the auth context attached
//      as a request header so the Hono middleware can read it.
//
// C2: tenant is hardcoded from env.TENANT_SLUG — never from props.
// C2: capabilities are re-resolved live every call — never frozen into encrypted props.
// C6: an OAuth-minted member has ZERO capability grants by default; this adapter
//     never grants anything — it only reads what's in D1.

import { WorkerEntrypoint } from 'cloudflare:workers'
import type { Env } from '../types'
import { mcpApp } from './index'
import { buildAuthContextFromProps, type OAuthMemberProps } from './oauth-authorize'
import { mcpInternalRequest } from './internal-dispatch'
// AUTH_CONTEXT_HEADER is defined in ./auth-header (no cloudflare:workers import)
// so it can be imported by tests without pulling in the CF runtime.
import { AUTH_CONTEXT_HEADER } from './auth-header'

export { AUTH_CONTEXT_HEADER }

// McpOAuthApiHandler — the WorkerEntrypoint the OAuthProvider calls for
// every request that hits the apiRoute ('/mcp') with a valid token.
// Both doors (OAuth-minted + member API key) arrive here via props.
export class McpOAuthApiHandler extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const props = this.ctx.props as OAuthMemberProps

    // Build AuthContext with live capability resolution (C2).
    const auth = await buildAuthContextFromProps(this.env, props)
    if (!auth) {
      // Token's underlying member_tokens row was revoked since authorization.
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthenticated' } }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      )
    }

    // The OAuthProvider invokes us with the public /mcp pathname, while mcpApp
    // itself is not mounted here and only exposes POST /. Re-root the request and
    // attach the resolved context before the internal dispatch.
    const forwarded = mcpInternalRequest(request, auth)

    return mcpApp.fetch(forwarded, this.env)
  }
}
