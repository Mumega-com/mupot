// mupot — long-lived presence WebSocket subscription auth (mupot#545).
//
// Connect-time authorizePresenceRead is necessary but not sufficient: hibernating
// sockets retain only tags, and a revoked token / deactivated member / lost project
// grant must stop receiving roster frames. Pure tag encode/parse + revalidation
// against the same member_tokens + project-visibility primitives the HTTP edge uses.

import type { AuthContext, CapabilityGrant, Env } from '../types'
import { memberTokenHashIsLive } from '../auth/member-bearer'
import { resolveCapabilities, hasCapability } from '../auth/capability'
import { projectReadAccessFromGrants, projectVisibilityClause } from '../projects/access'

/** Application close code: subscription principal no longer authorized. */
export const PRESENCE_AUTH_REVOKED_CLOSE_CODE = 4001

export type PresenceSocketLease = {
  projectId: string | null
  memberId: string
  tokenHash: string
}

/** WebSocket hibernation tags: [projectKey, memberId, tokenHash]. */
export function encodePresenceSocketTags(lease: PresenceSocketLease): string[] {
  if (!lease.memberId || !lease.tokenHash) {
    throw new Error('presence_socket_lease_incomplete')
  }
  return [lease.projectId ?? '', lease.memberId, lease.tokenHash]
}

export function parsePresenceSocketTags(tags: ReadonlyArray<string>): PresenceSocketLease | null {
  const projectKey = tags[0]
  const memberId = tags[1]
  const tokenHash = tags[2]
  if (typeof memberId !== 'string' || memberId.length === 0) return null
  if (typeof tokenHash !== 'string' || tokenHash.length === 0) return null
  if (typeof projectKey !== 'string') return null
  return {
    projectId: projectKey === '' ? null : projectKey,
    memberId,
    tokenHash,
  }
}

/**
 * Same project-visibility gate as MCP presence_list / HTTP authorizePresenceRead,
 * without importing src/mcp/projects (avoids mcp TOOLS circular init).
 */
async function canReadProject(
  env: Env,
  projectId: string,
  memberId: string,
  grants: CapabilityGrant[],
): Promise<boolean> {
  const pseudoAuth: AuthContext = {
    userId: memberId,
    email: null,
    role: 'member',
    tenant: env.TENANT_SLUG,
    memberId,
    channel: 'workspace',
    capabilities: grants,
    boundAgentId: null,
  }
  const access = projectReadAccessFromGrants(pseudoAuth, grants)
  const visibility = projectVisibilityClause(access)
  const row = await env.DB.prepare(
    `SELECT p.id FROM projects p WHERE p.id = ? AND ${visibility.sql}`,
  )
    .bind(projectId, ...visibility.binds)
    .first<{ id: string }>()
  return row !== null
}

/**
 * subscriptionStillAuthorized — revalidate before each roster disclosure.
 * Fail closed on revoked token, inactive member, or lost project read access.
 */
export async function subscriptionStillAuthorized(
  env: Env,
  lease: PresenceSocketLease,
): Promise<boolean> {
  const live = await memberTokenHashIsLive(env, lease.tokenHash, lease.memberId)
  if (!live) return false

  const grants = await resolveCapabilities(env, lease.memberId)

  if (lease.projectId === null) {
    return hasCapability(grants, 'org', null, 'admin')
  }

  return canReadProject(env, lease.projectId, lease.memberId, grants)
}

type RosterSocket = {
  send: (data: string) => void
  close: (code: number, reason: string) => void
}

/**
 * Fan-out a roster frame only to sockets whose lease still authorizes disclosure.
 * Unauthorized sockets are closed with PRESENCE_AUTH_REVOKED_CLOSE_CODE.
 */
export async function fanOutAuthorizedRoster<T extends RosterSocket>(
  env: Env,
  sockets: ReadonlyArray<T>,
  getTags: (socket: T) => ReadonlyArray<string>,
  message: string,
): Promise<number> {
  let sent = 0
  for (const socket of sockets) {
    const lease = parsePresenceSocketTags(getTags(socket))
    if (!lease) {
      try {
        socket.close(PRESENCE_AUTH_REVOKED_CLOSE_CODE, 'auth_revoked')
      } catch {
        // already closed
      }
      continue
    }
    const ok = await subscriptionStillAuthorized(env, lease)
    if (!ok) {
      try {
        socket.close(PRESENCE_AUTH_REVOKED_CLOSE_CODE, 'auth_revoked')
      } catch {
        // already closed
      }
      continue
    }
    try {
      socket.send(message)
      sent += 1
    } catch {
      // Drop dead sockets; hibernation close handlers clean them up.
    }
  }
  return sent
}
