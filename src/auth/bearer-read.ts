// bearer-read — the ONE door through which a member bearer may read the cookie-era /api GET routes (#2308).
//
// `requireAuth` used to read only the session cookie, so a bearer that /mcp accepts was refused (or
// redirected) on plain HTTP. This module is the whole decision for that opening, kept in one file so it
// can be audited and tested as a unit:
//
//   1. WHICH requests: GET/HEAD only, and only a path on BEARER_READ_ROUTES (an explicit ALLOWLIST;
//      anything not listed stays cookie-only, including every route added in the future).
//   2. WHO: resolveMemberByToken (the same sha256 + liveness + active-member + seat-floor lookup every
//      other REST bearer door uses), then LIVE capability grants from resolveCapabilities — the same
//      grants MCP's authenticateMember reads. Identity is server-derived; no role, member id or scope is
//      ever taken from the request.
//   3. WHAT CEILING (scope mapping). The credential is mapped, never widened:
//        member API key, channel workspace -> grants as on MCP, channel 'workspace'
//        member API key, channel im         -> grants as on MCP, channel 'im' (MCP behaves identically)
//        member API key, channel dashboard  -> REFUSED (that channel means a human web session elsewhere;
//                                              a bearer must never be able to claim it)
//        channel directory (every OAuth-door seat: unbound = zero capabilities, agent-consented =
//                           clamped-to-human grants, harness credentials) -> REFUSED. MCP applies a
//                           per-session ceiling to these that HTTP has no equivalent for, so they fail closed.
//        OAuth access tokens (carry mcp:read / mcp:write scopes) are not member_tokens rows, so they do not
//                           resolve here at all -> 401. Those scopes cannot be mapped to routes, so refused.
//        observed / held VIP seat agents -> refused (resolveMemberByToken: MCP's observed floor is a tool
//                           allowlist that REST routes are not on).
//        suspended member / revoked / expired token / other tenant -> refused (shared liveness predicate).
//      `role` is always 'member': legacy-role rank is never granted to a token, so requireRole('admin')
//      still refuses a bearer (loops, prospects) and authority comes only from real capability grants.
//        member with ZERO capability grants -> refused (the dashboard's read floor, and below any MCP tool min).
//   4. Any lookup error resolves to "no principal" (fail closed).

import type { AuthContext, ConnectionChannel, Env } from '../types'
import { resolveCapabilities } from './capability'
import { bearerToken, resolveMemberByToken } from './member-bearer'

// A path segment (an id or slug). Deliberately narrow: no '/', no '%', no '.', so an encoded or dotted
// segment can never be widened into a different route by a router that decodes it.
const SEG = '[A-Za-z0-9_:-]{1,200}'
const route = (pattern: string): RegExp => new RegExp(`^${pattern}$`)

/**
 * The routes a member bearer may GET (HEAD). Every entry has a cookie-era handler behind `requireAuth`
 * AND its own capability check; the bearer only supplies the identity, the grants decide.
 *
 * Deliberately NOT here (stay cookie-only; a bearer is answered 401):
 *  - /auth/*                          sessions, reauth, elevation, me (requireAuthMw instances that are not exported requireAuth)
 *  - /api/loops*                      requireRole('admin'); a token never holds legacy-role rank
 *  - /api/auth/sso/config             identity/SSO posture
 *  - /api/studio/database/*           live connector reads (query / tables)
 *  - /api/agent-connections/*         agent-connection issuance flow
 *  - /api/alerts/webhooks             outbound webhook listing
 *  - /api/channels/*                  channel bindings and sync status
 *  - /api/billing/status              returns the Stripe customer id
 *  - /api/members/members*            email + telegram_chat_id of every member (more than the MCP twin shows)
 *  - every non-GET/HEAD method, and everything not named below
 */
export const BEARER_READ_ROUTES: readonly RegExp[] = [
  route('/api/tasks'),
  route('/api/tasks/audit'),
  route(`/api/tasks/${SEG}`),
  route('/api/gates/grants'),
  route('/api/projects'),
  route(`/api/projects/${SEG}`),
  route(`/api/projects/${SEG}/activity`),
  route(`/api/projects/${SEG}/evidence`),
  route(`/api/projects/${SEG}/squads`),
  route('/api/org/departments'),
  route(`/api/org/departments/${SEG}/squads`),
  route(`/api/org/squads/${SEG}/agents`),
  route('/api/org/tree'),
  route(`/api/agents/${SEG}/status`),
  route('/api/kanban/board'),
  route('/api/telemetry/board-latency'),
  route('/api/pots'),
]

export function bearerReadEligible(method: string, path: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false
  return BEARER_READ_ROUTES.some((r) => r.test(path))
}

/** Channels a bearer may carry onto HTTP. Anything else is refused (see the scope mapping above). */
function httpChannel(channel: ConnectionChannel | null | undefined): 'workspace' | 'im' | null {
  return channel === 'workspace' || channel === 'im' ? channel : null
}

/**
 * Resolve the Authorization header to an HTTP principal, or null. Callers must have already checked
 * bearerReadEligible(method, path); this function does not look at the route.
 */
export async function resolveBearerReadAuth(env: Env, authorization: string | undefined): Promise<AuthContext | null> {
  const raw = bearerToken(authorization)
  if (!raw) return null
  try {
    const identity = await resolveMemberByToken(env, raw)
    if (!identity) return null
    const channel = httpChannel(identity.channel)
    if (!channel) return null
    const capabilities = await resolveCapabilities(env, identity.memberId)
    // Zero standing -> no principal. MCP's lowest capability-gated tool needs 'observer' (any grant), and the
    // dashboard's own read floor is "holds at least one capability row"; a bearer with none reads nothing here.
    if (capabilities.length === 0) return null
    return {
      userId: identity.memberId,
      memberId: identity.memberId,
      email: identity.email,
      role: 'member',
      tenant: env.TENANT_SLUG, // environment-derived, never from the request
      channel,
      boundAgentId: identity.boundAgentId,
      tokenId: identity.tokenId,
      capabilities,
    }
  } catch {
    return null
  }
}

/** 401 body for an unauthenticated /api request: names the credentials that route accepts. */
export function unauthenticatedApiBody(method: string, path: string): { error: 'unauthenticated'; accepted: Array<'bearer' | 'cookie'> } {
  return { error: 'unauthenticated', accepted: bearerReadEligible(method, path) ? ['bearer', 'cookie'] : ['cookie'] }
}
