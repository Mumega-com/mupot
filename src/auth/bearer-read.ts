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
//        member API key, channel dashboard  -> grants as on MCP (the pot's seeded admin key is one), but presented as
//                                              channel 'workspace': a bearer never claims a human web session
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

import type { AuthContext, Capability, ConnectionChannel, Env } from '../types'
import { hasWorkspaceAdmin, holdsCapabilityFloor, resolveCapabilities } from './capability'
import { bearerToken, resolveMemberByToken } from './member-bearer'
import { BoundAgentCheckUnavailableError } from './bound-agent-live'

// A path segment (an id or slug). Deliberately narrow: no '/', no '%', no '.', so an encoded or dotted
// segment can never be widened into a different route by a router that decodes it.
const SEG = '[A-Za-z0-9_:-]{1,200}'

interface BearerRoute {
  re: RegExp
  /** The capability floor of the route's MCP twin (its ToolSpec.min), enforced by the bearer door itself. */
  min: Capability
}
const route = (pattern: string, min: Capability): BearerRoute => ({ re: new RegExp(`^${pattern}$`), min })

/**
 * The routes a member bearer may GET (HEAD), each with the floor of its MCP twin. Only routes whose handler
 * already enforces the same visibility rules as the twin are listed; the floor below is the part the handler
 * does not enforce for a bearer (the dashboard's own floor is only 'observer'). Row visibility inside the
 * handler (squad/project scoping) is shared code with the twin. /api/tasks/:id additionally switches to
 * task_get's exact answer for a bearer (tasks/index.ts, TASK_GET_FIELDS, archived = 404).
 *
 * Deliberately NOT here (stay cookie-only; a bearer is answered 401). Each of these either has no capability
 * gate beyond the tenant, a lower floor than its MCP twin, or exposes more than the twin:
 *  - /auth/*                          sessions, reauth, elevation, me (requireAuthMw instances that are not exported requireAuth)
 *  - /api/loops*                      requireRole('admin'); a token never holds legacy-role rank
 *  - /api/agents/:id/status           tenant check only; MCP fleet_agent_get needs observer on the agent's squad
 *  - /api/org/*                       tenant check only; MCP peers needs squad observer and hides seat agents
 *  - /api/auth/sso/config             identity/SSO posture
 *  - /api/studio/database/*           live connector reads (query / tables)
 *  - /api/agent-connections/*         agent-connection issuance flow
 *  - /api/alerts/webhooks             outbound webhook listing
 *  - /api/channels/*                  channel bindings and sync status
 *  - /api/billing/status              returns the Stripe customer id
 *  - /api/members/members*            email + telegram_chat_id of every member (more than the MCP twin shows)
 *  - /api/projects/:id/evidence       task results, receipt ids and verdict notes; no MCP twin (#2318 round-2 lens)
 *  - every non-GET/HEAD method, and everything not named below
 */
export const BEARER_READ_ROUTES: readonly BearerRoute[] = [
  route('/api/tasks', 'member'), // task_list
  route('/api/tasks/audit', 'member'), // task_intake_audit
  route(`/api/tasks/${SEG}`, 'member'), // task_get
  route('/api/gates/grants', 'admin'), // grant_list_gate_capabilities
  route('/api/projects', 'observer'), // project_list
  route(`/api/projects/${SEG}`, 'observer'), // project_get
  route(`/api/projects/${SEG}/activity`, 'observer'),
  route(`/api/projects/${SEG}/squads`, 'observer'), // project_squad_list
  route('/api/kanban/board', 'member'), // kanban_board
  route('/api/telemetry/board-latency', 'admin'), // handler is org-admin only
  route('/api/pots', 'admin'), // pot_list
]

function matchRoute(method: string, path: string): BearerRoute | null {
  if (method !== 'GET' && method !== 'HEAD') return null
  return BEARER_READ_ROUTES.find((r) => r.re.test(path)) ?? null
}

export function bearerReadEligible(method: string, path: string): boolean {
  return matchRoute(method, path) !== null
}

/** The MCP-twin floor for this route, or null when the route is not bearer-readable. */
export function bearerReadFloor(method: string, path: string): Capability | null {
  return matchRoute(method, path)?.min ?? null
}

/** Same predicate MCP's invokeTool applies for a tool's min: org admin, or any grant at/above the floor. */
export function bearerMeetsFloor(auth: AuthContext, min: Capability): boolean {
  return hasWorkspaceAdmin(auth) || holdsCapabilityFloor(auth, min)
}

/**
 * Channels a bearer may carry onto HTTP. MCP accepts workspace, im AND dashboard member keys with their real
 * grants (the pot's seeded admin key is a dashboard-channel key), so all three are accepted here with the same
 * grants. A dashboard key is presented as 'workspace': 'dashboard' means a human web session to other code
 * (agent-owner.ts, project-invites.ts), and a bearer must never claim it. directory is refused.
 */
function httpChannel(channel: ConnectionChannel | null | undefined): 'workspace' | 'im' | null {
  if (channel === 'im') return 'im'
  return channel === 'workspace' || channel === 'dashboard' ? 'workspace' : null
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
  } catch (err) {
    // mupot#2345: a failed agent liveness read is the retryable 503 (app.onError), not "no principal" (401).
    if (err instanceof BoundAgentCheckUnavailableError) throw err
    return null
  }
}

/** 401 body for an unauthenticated /api request: names the credentials that route accepts. */
export function unauthenticatedApiBody(method: string, path: string): { error: 'unauthenticated'; accepted: Array<'bearer' | 'cookie'> } {
  return { error: 'unauthenticated', accepted: bearerReadEligible(method, path) ? ['bearer', 'cookie'] : ['cookie'] }
}
